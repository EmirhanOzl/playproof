import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Driver, HookTarget, Rect } from "../driver.ts";
import { issueFindings, RunDir, type Finding, type Report, type ReportImage } from "../report.ts";
import { openGameSession } from "../session.ts";
import { Compositor, type Tile } from "../sheet.ts";
import { runSteps } from "../runner.ts";
import { parseSteps } from "../steps.ts";
import { formatTime, imageList, sessionOptions, type CommonOptions } from "./common.ts";

export interface MonkeyOptions extends CommonOptions {
  steps: number;
  keys: string[];
  background: boolean;
  realtime: boolean;
  keepGoing: boolean;
  // How long one action may take before the page counts as hung (default 15 s).
  hangMs?: number;
}

interface Action {
  index: number;
  // Steps in the script language, e.g. "tap 120,300; wait 150ms".
  script: string;
  text: string;
}

const STUCK_ACTIONS = 40;
const CHECKPOINTS = 12;

// Random play that hunts for crashes, hangs and soft-locks. With the virtual clock (default) a run is repeatable:
// the same --seed and target replay the same actions at the same game times.
export async function monkeyCommand(options: MonkeyOptions): Promise<Report & { run: RunDir }> {
  const run = RunDir.create("monkey", options.out);
  const seed = options.seed ?? 1;
  const random = mulberry32(seed);
  const session = await openGameSession(sessionOptions(options, { clock: !options.realtime }), options.android);
  const { driver } = session;
  let compositor: Compositor | null = null;
  const log: string[] = [];
  const findings: Finding[] = [];
  const checkpoints: Tile[] = [];
  const script: string[] = [];
  // Distinct screens reached, by perceptual hash; each keeps its first sighting and the buttons tried on it.
  const screens: { hash: string; image: Buffer; action: number; time: number; tried: Set<string> }[] = [];
  let current = -1;
  let failureShot: Buffer | null = null;
  let stoppedAt: number | null = null;

  try {
    let lastSignature = "";
    let sameSince = 0;
    let stuckReported = false;
    let lastRaf = await rafCount(driver);
    let rafQuietSince = 0;
    let rafReported = false;
    let gameTime = 0;
    const checkpointEvery = Math.max(1, Math.floor(options.steps / CHECKPOINTS));

    compositor = await Compositor.open(session.browser);
    const sheetMaker = compositor;
    const look = async (index: number, time: number): Promise<void> => {
      const image = await driver.screenshot(await driver.area());
      const hash = await sheetMaker.screenHash(image);
      const near = screens.findIndex((s) => hamming(s.hash, hash) <= 10);
      if (near >= 0) current = near;
      else {
        screens.push({ hash, image, action: index, time, tried: new Set() });
        current = screens.length - 1;
      }
    };
    await look(0, 0);

    for (let index = 0; index < options.steps; index++) {
      const area = await driver.area();
      const targets = await driver.targets().catch(() => [] as HookTarget[]);
      const action = pickAction(index, random, area, targets, options, screens[current]?.tried ?? new Set());
      session.during = `action ${index + 1}: ${action.text}`;
      log.push(`${String(index + 1).padStart(4)}  ${formatTime(gameTime).padStart(9)}  ${action.text}`);
      const errorsBefore = session.issues.filter((i) => i.kind === "pageerror" || i.kind === "crash").length;

      const hangMs = options.hangMs ?? 15000;
      script.push(`# action ${index + 1}`, ...action.script.split("; "));
      const outcome = await withTimeout(
        runSteps(driver, parseSteps(action.script), { fullView: false }).then((result) => result.elapsedMs),
        hangMs,
      );
      if (outcome === "timeout") {
        findings.push({
          severity: "error",
          title: `The page stopped responding during action ${index + 1} (${action.text}): no reply for ${hangMs / 1000} s. Likely an infinite loop or a blocking busy-wait.`,
          detail: `Reproduce: ${repro(options, seed, index + 1)}`,
        });
        stoppedAt = index;
        break;
      }
      gameTime += outcome;
      await look(index + 1, gameTime);

      const newErrors = session.issues.filter((i) => i.kind === "pageerror" || i.kind === "crash").length > errorsBefore;
      if (newErrors && failureShot === null) {
        failureShot = await driver.screenshot(null).catch(() => null);
        if (!options.keepGoing) {
          stoppedAt = index;
          break;
        }
      }

      // Soft-lock: input keeps arriving but nothing on screen (or in the game's own state) changes.
      const signature = await screenSignature(driver, area);
      if (signature !== lastSignature) {
        lastSignature = signature;
        sameSince = index;
        stuckReported = false;
      } else if (!stuckReported && index - sameSince >= STUCK_ACTIONS) {
        stuckReported = true;
        findings.push({
          severity: "warning",
          title: `Nothing changed on screen for ${STUCK_ACTIONS} actions (${sameSince + 2}–${index + 1}) although input kept coming. Possible soft-lock, or a screen that ignores the kinds of input the monkey sends.`,
          detail: `Reproduce: ${repro(options, seed, index + 1)}`,
        });
        checkpoints.push({ image: await driver.screenshot(area), caption: `stuck at action ${index + 1}`, accent: "amber" });
      }

      // Render loop died: the game used to request frames and stopped.
      const raf = await rafCount(driver);
      if (raf > lastRaf) {
        lastRaf = raf;
        rafQuietSince = gameTime;
        rafReported = false;
      } else if (lastRaf > 30 && !rafReported && gameTime - rafQuietSince > 3000) {
        rafReported = true;
        findings.push({
          severity: "warning",
          title: `The game stopped requesting animation frames around action ${index + 1} and has not drawn for ${formatTime(gameTime - rafQuietSince)}. Fine for a static menu; a bug if gameplay should be running.`,
          detail: `Reproduce: ${repro(options, seed, index + 1)}`,
        });
      }

      if (index % checkpointEvery === checkpointEvery - 1 && checkpoints.length < CHECKPOINTS + 2) {
        checkpoints.push({ image: await driver.screenshot(area), caption: `action ${index + 1}  ·  ${formatTime(gameTime)}` });
      }
    }

    const issues = issueFindings(session.issues);
    if (issues.some((f) => f.severity === "error")) {
      const first = session.issues.find((i) => i.kind === "pageerror" || i.kind === "crash");
      const index = first ? Number(/^action (\d+)/.exec(first.during)?.[1] ?? 0) : 0;
      const at = issues.findIndex((f) => /^(Uncaught error|Page crash)/.test(f.title));
      if (index > 0 && at >= 0) {
        issues[at] = { ...issues[at]!, detail: `${issues[at]!.detail ?? ""}\nReproduce: ${repro(options, seed, index)}` };
      }
    }
    findings.unshift(...issues);

    const images: ReportImage[] = [];
    if (failureShot) checkpoints.push({ image: failureShot, caption: `first error, action ${(stoppedAt ?? 0) + 1}`, accent: "red" });
    if (checkpoints.length) {
      const total = stoppedAt === null ? options.steps : stoppedAt + 1;
      const png = await compositor.sheet({
        title: `monkey  ·  ${total} actions  ·  seed ${seed}`,
        subtitle: `${session.deviceLabel}  ·  ${options.realtime ? "real time" : "virtual clock"}  ·  ${formatTime(gameTime)} of game time  ·  checkpoints along the run`,
        tiles: checkpoints,
        tileHeight: 220,
        maxWidth: 1600,
        notes: findings
          .filter((f) => f.severity !== "info")
          .slice(0, 6)
          .map((f) => ({ text: f.title, tone: f.severity === "error" ? "red" : "amber" })),
      });
      imageList(images, run, "monkey.png", "checkpoints along the run (red = first error, amber = stuck)", png);
    }
    if (screens.length) {
      const png = await compositor.sheet({
        title: `screens reached  ·  ${screens.length} distinct`,
        subtitle: "Each screen the random player reached, the first time it got there. What is missing here was never reached.",
        tiles: screens.slice(0, 40).map((s, i) => ({
          image: s.image,
          caption: `#${i + 1}  action ${s.action}  ·  ${formatTime(s.time)}`,
        })),
        tileHeight: 200,
        maxWidth: 1600,
        notes: screens.length > 40 ? [{ text: `${screens.length - 40} more screens not shown.`, tone: "plain" }] : [],
      });
      imageList(images, run, "screens.png", `the ${screens.length} distinct screens the random player reached`, png);
      findings.push({ severity: "info", title: `Reached ${screens.length} distinct screen${screens.length === 1 ? "" : "s"} (see screens.png).` });
    }
    run.write("actions.txt", `${log.join("\n")}\n`);
    const scriptPath = run.write(
      "repro.steps",
      [
        "# Replays this monkey run action by action. Delete actions to narrow a bug down; keep the same device and seed:",
        `# ${replay(options, seed, run.dir)}`,
        ...script,
        "",
      ].join("\n"),
    );
    for (const finding of findings) {
      if (finding.detail?.includes("Reproduce:")) finding.detail += `\nAs a script: ${replay(options, seed, run.dir)}  (${scriptPath})`;
    }

    return {
      command: "monkey",
      target: session.url,
      device: session.deviceLabel,
      images,
      findings,
      data: {
        seed,
        actions: log.length,
        stoppedAt: stoppedAt === null ? null : stoppedAt + 1,
        gameTimeMs: Math.round(gameTime),
        clock: options.realtime ? "real" : "virtual",
        actionLog: `${run.dir}/actions.txt`,
        reproduce: repro(options, seed, log.length),
        screens: screens.map((s) => ({ action: s.action, timeMs: Math.round(s.time) })),
      },
      run,
    };
  } finally {
    await compositor?.close();
    await session.close();
  }
}

// Every random action is written in the step language and run by the same engine as play, so the actions that
// led to a bug can be saved as a script that replays them exactly (repro.steps).
function pickAction(
  index: number,
  random: () => number,
  area: Rect,
  targets: HookTarget[],
  options: MonkeyOptions,
  tried: Set<string>,
): Action {
  // Points are relative to the game area, as in scripts.
  const point = (): string =>
    `${Math.round(area.width * (0.03 + 0.94 * random()))},${Math.round(area.height * (0.03 + 0.94 * random()))}`;
  const pause = (): number => Math.round(40 + random() * 260);
  const action = (script: string, label?: string): Action => ({ index, script, text: label ? `${label}: ${script}` : script });
  const r = random();

  if (targets.length && r < 0.4) {
    // Explore: buttons not yet tried on this screen first, so the run goes deeper instead of repeating itself.
    const fresh = targets.filter((t) => !tried.has(t.label));
    const pool = fresh.length && random() < 0.75 ? fresh : targets;
    const target = pool[Math.floor(random() * pool.length)]!;
    tried.add(target.label);
    const x = Math.round(target.x - area.x + target.width * (0.2 + 0.6 * random()));
    const y = Math.round(target.y - area.y + target.height * (0.2 + 0.6 * random()));
    return action(`tap ${x},${y}; wait ${pause()}ms`, `@${target.label || "target"}`);
  }
  const roll = targets.length ? (r - 0.4) / 0.6 : r;
  if (options.keys.length && roll < 0.14) {
    const key = options.keys[Math.floor(random() * options.keys.length)]!;
    return action(`key ${key === " " ? "Space" : key} ${Math.round(30 + random() * 400)}ms; wait ${pause()}ms`);
  }
  if (roll < 0.24) return action(`drag ${point()} ${point()} ${Math.round(80 + random() * 400)}ms; wait ${pause()}ms`);
  if (roll < 0.3) return action(`press ${point()} ${Math.round(350 + random() * 700)}ms; wait ${pause()}ms`);
  if (roll < 0.36) {
    const at = point();
    return action(`tap ${at}; tap ${at}; tap ${at}; wait ${pause()}ms`, "rapid triple tap");
  }
  if (options.background && roll < 0.38) return action(`background ${Math.round(1000 + random() * 7000)}ms; wait 300ms`);
  return action(`tap ${point()}; wait ${pause()}ms`);
}

async function screenSignature(driver: Driver, area: Rect): Promise<string> {
  const [image, state] = await Promise.all([driver.screenshot(area), driver.state().catch(() => undefined)]);
  return createHash("sha1")
    .update(image)
    .update(state === undefined ? "" : JSON.stringify(state))
    .digest("hex");
}

async function rafCount(driver: Driver): Promise<number> {
  const value = await driver
    .evaluate(
      "(window.__playproofClock ? window.__playproofClock.stats().rafRequests : (window.__playproofProbe ? window.__playproofProbe.rafCalls : 0))",
    )
    .catch(() => 0);
  return Number(value) || 0;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((done) => {
    timer = setTimeout(() => done("timeout"), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function repro(options: MonkeyOptions, seed: number, steps: number): string {
  const parts = ["playproof monkey", JSON.stringify(options.target), `--seed ${seed}`, `--steps ${steps}`];
  if (options.device.name !== "Desktop") parts.push(`--device ${JSON.stringify(options.device.name)}`);
  if (options.realtime) parts.push("--realtime");
  return parts.join(" ");
}

function replay(options: MonkeyOptions, seed: number, dir: string): string {
  const parts = ["playproof play", JSON.stringify(options.target), "--script", JSON.stringify(join(dir, "repro.steps")), `--seed ${seed}`];
  if (options.device.name !== "Desktop") parts.push(`--device ${JSON.stringify(options.device.name)}`);
  if (options.realtime) parts.push("--realtime");
  return parts.join(" ");
}

function hamming(a: string, b: string): number {
  let distance = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) distance++;
  return distance;
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
