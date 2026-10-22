import type { Driver } from "../driver.ts";
import { issueFindings, RunDir, type Finding, type Report, type ReportImage } from "../report.ts";
import { runSteps } from "../runner.ts";
import { openGameSession, type GameSession } from "../session.ts";
import { Compositor } from "../sheet.ts";
import type { Step } from "../steps.ts";
import { formatTime, imageList, sessionOptions, type CommonOptions } from "./common.ts";
import { mulberry32 } from "./monkey.ts";

export interface PerfOptions extends CommonOptions {
  durationMs: number;
  cpu: number;
  steps: Step[];
  monkey: boolean;
}

interface FrameData {
  intervals: number[];
  longTasks: { start: number; duration: number }[];
  durationMs: number;
}

export interface PerfStats {
  frames: number;
  fps: number;
  refreshHz: number;
  budgetMs: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  slowFrames: number;
  droppedPercent: number;
  longTasks: number;
  longTaskMs: number;
  worstLongTaskMs: number;
}

// Real-time frame pacing while the game runs (optionally while a script or random input plays it), in a local
// browser or on a USB-connected phone (in Chrome or inside an app's WebView).
export async function perfCommand(options: PerfOptions): Promise<Report & { run: RunDir }> {
  const run = RunDir.create("perf", options.out);
  const onPhone = Boolean(options.android);
  const session = await openGameSession(sessionOptions(options, { clock: false, cpuThrottle: onPhone ? undefined : options.cpu }), options.android);
  let compositor: Compositor | null = null;
  try {
    const { data, heapStart, heapEnd, image } = await measure(session.driver, options, session);
    compositor = await Compositor.open(session.browser);
    const where = onPhone
      ? "real phone"
      : options.cpu > 1
        ? `CPU slowed ${options.cpu}× (a rough stand-in for a mid-range phone), headless software rendering`
        : "full desktop CPU, headless software rendering";
    return await finishReport(run, compositor, options, data, {
      target: session.url,
      device: session.deviceLabel,
      where,
      heapStart,
      heapEnd,
      image,
      extra: issueFindings(session.issues),
      caveat: onPhone
        ? null
        : "Local numbers are a proxy: JavaScript cost is real, but headless Chromium renders without a GPU, so canvas/WebGL-heavy games look slower than on hardware. Use --headed for GPU rendering, or --android for a real phone.",
    });
  } finally {
    await compositor?.close();
    await session.close();
  }
}

async function measure(driver: Driver, options: PerfOptions, session: GameSession | null) {
  const probe = "window.__playproofProbe";
  const heapStart = (await driver.evaluate(`${probe}.heapMB()`)) as number | null;
  await driver.evaluate(`${probe}.startFrames()`);
  const started = Date.now();
  if (options.steps.length) {
    if (session) session.during = "perf script";
    const result = await runSteps(driver, options.steps, { fullView: true });
    if (result.failure) throw new Error(`Step ${result.failure.step + 1} failed (${result.failure.source}): ${result.failure.message}`);
  }
  const random = mulberry32(options.seed ?? 1);
  // Read once: every call into the page costs main-thread time that would be charged to the game.
  const area = options.monkey ? await driver.area() : null;
  while (Date.now() - started < options.durationMs) {
    if (area) {
      if (session) session.during = "perf random input";
      const x = area.x + area.width * (0.05 + 0.9 * random());
      const y = area.y + area.height * (0.05 + 0.9 * random());
      await driver.pointer("down", x, y);
      await driver.advance(40);
      await driver.pointer("up", x, y);
      await driver.advance(120 + random() * 300);
    } else {
      await driver.advance(Math.min(250, options.durationMs - (Date.now() - started)));
    }
  }
  const data = (await driver.evaluate(`${probe}.stopFrames()`)) as FrameData;
  const heapEnd = (await driver.evaluate(`${probe}.heapMB()`)) as number | null;
  const errors = ((await driver.evaluate(`${probe}.errors.map((e) => e.message)`)) as string[]) ?? [];
  const image = await driver.screenshot(null);
  return { data, heapStart, heapEnd, image, errors };
}

export function computeStats(data: FrameData): PerfStats {
  const sorted = [...data.intervals].sort((a, b) => a - b);
  const q = (p: number): number => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! : 0);
  const median = q(0.5);
  // The display's refresh rate decides the frame budget. Frame intervals land on whole multiples of the display
  // period (a 60 Hz screen gives 16.7, 33.3, 50 ms), so take the lowest common rate that explains nearly all of
  // them. Rates below 60 Hz are not considered: a game stuck at 30 fps is a dropped-frame problem, not a 30 Hz screen.
  const fits = (hz: number): boolean => {
    const period = 1000 / hz;
    const onBeat = data.intervals.filter((ms) => {
      const beats = ms / period;
      return Math.round(beats) >= 1 && Math.abs(beats - Math.round(beats)) < 0.2;
    }).length;
    return onBeat >= data.intervals.length * 0.9;
  };
  const refreshHz = [60, 90, 120, 144].find(fits) ?? 60;
  const budgetMs = 1000 / refreshHz;
  const dropped = data.intervals.reduce((sum, ms) => sum + Math.max(0, Math.round(ms / budgetMs) - 1), 0);
  const expected = data.intervals.length + dropped;
  const round = (n: number): number => Math.round(n * 10) / 10;
  return {
    frames: data.intervals.length,
    fps: round(data.intervals.length / Math.max(0.001, data.durationMs / 1000)),
    refreshHz,
    budgetMs: round(budgetMs),
    p50: round(median),
    p95: round(q(0.95)),
    p99: round(q(0.99)),
    max: round(sorted[sorted.length - 1] ?? 0),
    slowFrames: data.intervals.filter((ms) => ms > budgetMs * 1.5).length,
    droppedPercent: round(expected ? (dropped / expected) * 100 : 0),
    longTasks: data.longTasks.length,
    longTaskMs: Math.round(data.longTasks.reduce((sum, t) => sum + t.duration, 0)),
    worstLongTaskMs: Math.round(Math.max(0, ...data.longTasks.map((t) => t.duration))),
  };
}

// local: numbers come from emulation (slowed CPU, no GPU), so they can warn but never fail a run on their own.
export function perfFindings(stats: PerfStats, heapStart: number | null, heapEnd: number | null, local: boolean): Finding[] {
  const findings: Finding[] = [];
  if (stats.frames < 10) {
    findings.push({ severity: "error", title: `Only ${stats.frames} frames were drawn: the page is blocked or not rendering.` });
    return findings;
  }
  if (stats.droppedPercent >= 5) {
    findings.push({
      severity: stats.droppedPercent >= 15 && !local ? "error" : "warning",
      title: `${stats.droppedPercent}% of frames were dropped at ${stats.refreshHz} Hz (p95 ${stats.p95} ms, p99 ${stats.p99} ms against a ${stats.budgetMs} ms budget). Motion will stutter.`,
    });
  } else if (stats.p99 > stats.budgetMs * 2.5) {
    findings.push({
      severity: "warning",
      title: `Occasional hitches: p99 frame ${stats.p99} ms, worst ${stats.max} ms (budget ${stats.budgetMs} ms). Usually garbage collection, a big allocation, or work done in a single frame (level load, texture upload).`,
    });
  }
  if (stats.worstLongTaskMs >= 100) {
    findings.push({
      severity: "warning",
      title: `${stats.longTasks} long main-thread task${stats.longTasks === 1 ? "" : "s"} (worst ${stats.worstLongTaskMs} ms, ${stats.longTaskMs} ms total). Input feels unresponsive while they run.`,
    });
  }
  if (heapStart !== null && heapEnd !== null && heapEnd - heapStart > 20) {
    findings.push({
      severity: "info",
      title: `JS heap grew from ${heapStart} MB to ${heapEnd} MB during the run. Fine during loading; in steady play it can mean a leak (objects kept per frame or per level).`,
    });
  }
  if (!findings.length) {
    findings.push({
      severity: "info",
      title: `Smooth: ${stats.fps} fps at ${stats.refreshHz} Hz, p95 ${stats.p95} ms, ${stats.droppedPercent}% dropped.`,
    });
  }
  return findings;
}

async function finishReport(
  run: RunDir,
  compositor: Compositor,
  options: PerfOptions,
  data: FrameData,
  context: {
    target: string;
    device: string;
    where: string;
    heapStart: number | null;
    heapEnd: number | null;
    image: Buffer;
    extra: Finding[];
    caveat: string | null;
  },
): Promise<Report & { run: RunDir }> {
  const stats = computeStats(data);
  const findings = [...context.extra, ...perfFindings(stats, context.heapStart, context.heapEnd, !options.android)];
  const slow = data.intervals.map((ms, i) => (ms > stats.budgetMs * 1.5 ? i : -1)).filter((i) => i >= 0);
  const activity = [options.steps.length ? "running the script" : "", options.monkey ? "random taps" : ""].filter(Boolean).join(" + ") || "idle (no input)";
  const png = await compositor.sheet({
    title: `perf  ·  ${stats.fps} fps  ·  p95 ${stats.p95} ms  ·  ${stats.droppedPercent}% dropped`,
    subtitle: `${context.device}  ·  ${context.where}  ·  ${formatTime(data.durationMs)} ${activity}`,
    tiles: [{ image: context.image, caption: "end of the run" }],
    tileHeight: 260,
    maxWidth: 1400,
    graph: {
      title: `Frame time per frame in ms (red = over 1.5× the ${stats.budgetMs} ms budget at ${stats.refreshHz} Hz)`,
      values: data.intervals,
      highlight: slow,
      ticks: [],
      guides: [
        { value: stats.budgetMs, label: `${stats.budgetMs} ms (${stats.refreshHz} fps)` },
        { value: stats.budgetMs * 2, label: `${Math.round(stats.budgetMs * 2 * 10) / 10} ms` },
      ],
    },
    notes: [
      ...findings.map((f) => ({ text: f.title, tone: f.severity === "error" ? ("red" as const) : f.severity === "warning" ? ("amber" as const) : ("plain" as const) })),
      ...(context.caveat ? [{ text: context.caveat, tone: "plain" as const }] : []),
    ],
  });
  const images: ReportImage[] = [];
  imageList(images, run, "perf.png", "frame-time chart", png);
  return {
    command: "perf",
    target: context.target,
    device: context.device,
    images,
    findings,
    data: { ...stats, heapStartMB: context.heapStart, heapEndMB: context.heapEnd, durationMs: Math.round(data.durationMs), activity, environment: context.where, frameTimes: data.intervals.map((ms) => Math.round(ms * 10) / 10) },
    run,
  };
}
