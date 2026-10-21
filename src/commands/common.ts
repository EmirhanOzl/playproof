import { describeDevice, type Device } from "../devices.ts";
import { findMotionIssues, type MotionFinding } from "../motion.ts";
import type { Finding, ReportImage, RunDir } from "../report.ts";
import type { StoryItem } from "../runner.ts";
import type { SessionOptions } from "../session.ts";
import type { Compositor, NormRect, Tile } from "../sheet.ts";

export interface CommonOptions {
  target: string;
  device: Device;
  area?: string;
  waitFor?: string;
  ready?: string;
  settleMs: number;
  timeoutMs: number;
  browser?: string;
  headed: boolean;
  out?: string;
  json: boolean;
  seed: number | null;
  port?: number;
  fps: number;
}

export function sessionOptions(common: CommonOptions, extra: Partial<SessionOptions> = {}): SessionOptions {
  return {
    target: common.target,
    device: common.device,
    browser: common.browser,
    headed: common.headed,
    clock: true,
    fps: common.fps,
    seed: common.seed,
    waitFor: common.waitFor,
    ready: common.ready,
    settleMs: common.settleMs,
    timeoutMs: common.timeoutMs,
    area: common.area,
    port: common.port,
    ...extra,
  };
}

export interface FilmSheetOptions {
  maxTiles: number;
  boxes: boolean;
  frameMs: number;
  device: Device;
  title: string;
}

export interface FilmSheetResult {
  png: Buffer;
  findings: MotionFinding[];
  tiles: number[];
  diffs: number[];
}

// One film → one contact sheet: sampled tiles with frame number and time, a dashed box around what changed since
// the previous tile, and a bar per frame showing how much of the screen changed.
export async function buildFilmSheet(
  compositor: Compositor,
  film: Extract<StoryItem, { kind: "film" }>,
  options: FilmSheetOptions,
): Promise<FilmSheetResult> {
  const { frames } = film;
  const motion = await compositor.motion([film.baseline, ...frames.map((frame) => frame.image)]);
  const findings = findMotionIssues(motion, options.frameMs);

  const stride = film.fps
    ? Math.max(1, Math.round(1000 / film.fps / options.frameMs))
    : Math.max(1, Math.ceil(frames.length / options.maxTiles));
  const picked = new Set<number>();
  for (let i = stride - 1; i < frames.length; i += stride) picked.add(i);
  picked.add(frames.length - 1);
  // Frames with a finding are always shown, so the note in the summary points at something visible.
  for (const finding of findings) if (finding.kind === "pop" || finding.kind === "flicker") picked.add(finding.frame);
  const tiles = [...picked].sort((a, b) => a - b);

  const flagged = new Map<number, MotionFinding>();
  for (const finding of findings) if (finding.kind === "pop" || finding.kind === "flicker") flagged.set(finding.frame, finding);
  const start = frames[0]!.time - options.frameMs;
  const sheetTiles: Tile[] = tiles.map((index, n) => {
    const previous = n === 0 ? -1 : tiles[n - 1]!;
    const finding = flagged.get(index);
    return {
      image: frames[index]!.image,
      caption: `#${index + 1}  ${Math.round(frames[index]!.time - start)} ms`,
      note: finding ? (finding.kind === "pop" ? "sudden jump" : "one-frame flicker") : undefined,
      accent: finding ? "red" : null,
      box: options.boxes ? unionBoxes(motion.boxes.slice(previous + 1, index + 1)) : null,
    };
  });

  const aspect = film.area.height / Math.max(1, film.area.width);
  const tileHeight = Math.min(film.area.height, aspect > 1.2 ? 300 : aspect > 0.8 ? 230 : 180);
  const durationMs = Math.round(frames.length * options.frameMs);
  const png = await compositor.sheet({
    title: options.title,
    subtitle: [
      describeDevice(options.device),
      `${frames.length} frames over ${durationMs} ms (virtual clock, ${Math.round(1000 / options.frameMs)} fps)`,
      stride > 1 ? `showing every ${ordinal(stride)} frame` : "showing every frame",
      options.boxes ? "dashed box = what changed since the previous tile" : "",
    ]
      .filter(Boolean)
      .join("  ·  "),
    tiles: sheetTiles,
    tileHeight,
    maxWidth: 1600,
    graph: {
      title: "Screen change per frame (one bar per frame, square-root scale; ticks mark the tiles above; red = flagged)",
      scale: "sqrt",
      values: motion.diffs,
      highlight: [...flagged.keys()],
      ticks: tiles,
    },
    notes: findings.slice(0, 8).map((f) => ({ text: f.message, tone: f.severity === "warning" ? "amber" : "plain" })),
  });
  return { png, findings, tiles, diffs: motion.diffs };
}

function unionBoxes(boxes: (NormRect | null)[]): NormRect | null {
  let result: NormRect | null = null;
  for (const box of boxes) {
    if (!box) continue;
    if (!result) {
      result = { ...box };
      continue;
    }
    const x = Math.min(result.x, box.x);
    const y = Math.min(result.y, box.y);
    result = {
      x,
      y,
      width: Math.max(result.x + result.width, box.x + box.width) - x,
      height: Math.max(result.y + result.height, box.y + box.height) - y,
    };
  }
  return result;
}

function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}

export function motionToFindings(findings: MotionFinding[], filmLabel: string): Finding[] {
  return findings.map((f) => ({ severity: f.severity, title: `${filmLabel}: ${f.message}` }));
}

// Storyboard: shots in order, with a few keyframes from each film, so one image tells the whole script.
export async function buildStoryboard(
  compositor: Compositor,
  items: StoryItem[],
  title: string,
  subtitle: string,
  notes: { text: string; tone: "red" | "amber" | "green" | "plain" }[],
): Promise<Buffer | null> {
  const tiles: Tile[] = [];
  let filmNumber = 0;
  for (const item of items) {
    if (item.kind === "shot") {
      tiles.push({ image: item.image, caption: `${item.label}  ·  ${formatTime(item.time)}` });
    } else {
      filmNumber++;
      const count = Math.min(4, item.frames.length);
      for (let k = 0; k < count; k++) {
        const index = Math.round(((k + 1) * item.frames.length) / count) - 1;
        const frame = item.frames[index]!;
        tiles.push({ image: frame.image, caption: `film ${filmNumber}  ·  ${formatTime(frame.time)}`, accent: null });
      }
    }
  }
  if (!tiles.length) return null;
  return compositor.sheet({ title, subtitle, tiles, tileHeight: 260, maxWidth: 1600, notes });
}

export function formatTime(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

export function imageList(images: ReportImage[], run: RunDir, name: string, label: string, png: Buffer): void {
  images.push({ label, path: run.write(name, png) });
}
