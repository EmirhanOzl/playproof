import { createHash } from "node:crypto";
import type { Driver, HookTarget, Rect } from "../driver.ts";
import { issueFindings, RunDir, type Finding, type Report, type ReportImage } from "../report.ts";
import { openGameSession } from "../session.ts";
import { Compositor, type Tile } from "../sheet.ts";
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
  text: string;
  run(driver: Driver): Promise<number>;
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

    for (let index = 0; index < options.steps; index++) {
      const area = await driver.area();
      const targets = await driver.targets().catch(() => [] as HookTarget[]);
      const action = pickAction(index, random, area, targets, options);
      session.during = `action ${index + 1}: ${action.text}`;
      log.push(`${String(index + 1).padStart(4)}  ${formatTime(gameTime).padStart(9)}  ${action.text}`);
      const errorsBefore = session.issues.filter((i) => i.kind === "pageerror" || i.kind === "crash").length;

      const hangMs = options.hangMs ?? 15000;
      const outcome = await withTimeout(action.run(driver), hangMs);
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

    compositor = await Compositor.open(session.browser);
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
    run.write("actions.txt", `${log.join("\n")}\n`);

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
      },
      run,
    };
  } finally {
    await compositor?.close();
    await session.close();
  }
}

function pickAction(
  index: number,
  random: () => number,
  area: Rect,
  targets: HookTarget[],
  options: MonkeyOptions,
): Action {
  const point = (): [number, number] => [
    Math.round(area.x + area.width * (0.03 + 0.94 * random())),
    Math.round(area.y + area.height * (0.03 + 0.94 * random())),
  ];
  const pause = (): number => Math.round(40 + random() * 260);
  const r = random();
  const base = { index };

  if (targets.length && r < 0.4) {
    const target = targets[Math.floor(random() * targets.length)]!;
    const x = Math.round(target.x + target.width * (0.2 + 0.6 * random()));
    const y = Math.round(target.y + target.height * (0.2 + 0.6 * random()));
    const wait = pause();
    return { ...base, text: `tap @${target.label || "target"} (${x},${y}), wait ${wait}ms`, run: (d) => tap(d, x, y, wait) };
  }
  const roll = targets.length ? (r - 0.4) / 0.6 : r;
  if (options.keys.length && roll < 0.14) {
    const key = options.keys[Math.floor(random() * options.keys.length)]!;
    const hold = Math.round(30 + random() * 400);
    const wait = pause();
    return {
      ...base,
      text: `key ${key === " " ? "Space" : key} for ${hold}ms, wait ${wait}ms`,
      run: async (d) => {
        await d.key("down", key);
        await d.advance(hold);
        await d.key("up", key);
        await d.advance(wait);
        return hold + wait;
      },
    };
  }
  if (roll < 0.24) {
    const [x1, y1] = point();
    const [x2, y2] = point();
    const ms = Math.round(80 + random() * 400);
    const wait = pause();
    return {
      ...base,
      text: `drag ${x1},${y1} → ${x2},${y2} in ${ms}ms, wait ${wait}ms`,
      run: async (d) => {
        const moves = Math.max(2, Math.round(ms / d.frameMs));
        await d.pointer("down", x1, y1);
        for (let m = 1; m <= moves; m++) {
          await d.advance(ms / moves);
          await d.pointer("move", x1 + ((x2 - x1) * m) / moves, y1 + ((y2 - y1) * m) / moves);
        }
        await d.pointer("up", x2, y2);
        await d.advance(wait);
        return ms + wait;
      },
    };
  }
  if (roll < 0.3) {
    const [x, y] = point();
    const hold = Math.round(350 + random() * 700);
    const wait = pause();
    return {
      ...base,
      text: `long press ${x},${y} for ${hold}ms, wait ${wait}ms`,
      run: async (d) => {
        await d.pointer("down", x, y);
        await d.advance(hold);
        await d.pointer("up", x, y);
        await d.advance(wait);
        return hold + wait;
      },
    };
  }
  if (roll < 0.36) {
    const [x, y] = point();
    const wait = pause();
    return {
      ...base,
      text: `rapid triple tap ${x},${y}, wait ${wait}ms`,
      run: async (d) => {
        for (let k = 0; k < 3; k++) {
          await d.pointer("down", x, y);
          await d.advance(d.frameMs);
          await d.pointer("up", x, y);
          await d.advance(d.frameMs);
        }
        await d.advance(wait);
        return wait + 6 * d.frameMs;
      },
    };
  }
  if (options.background && roll < 0.38) {
    const away = Math.round(1000 + random() * 7000);
    return {
      ...base,
      text: `send to background for ${away}ms, then return`,
      run: async (d) => {
        await d.setVisibility(true);
        await d.advance(away, false);
        await d.setVisibility(false);
        await d.advance(300);
        return away + 300;
      },
    };
  }
  const [x, y] = point();
  const wait = pause();
  return { ...base, text: `tap ${x},${y}, wait ${wait}ms`, run: (d) => tap(d, x, y, wait) };
}

async function tap(driver: Driver, x: number, y: number, wait: number): Promise<number> {
  await driver.pointer("down", x, y);
  await driver.advance(50);
  await driver.pointer("up", x, y);
  await driver.advance(wait);
  return 50 + wait;
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
