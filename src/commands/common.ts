import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describeDevice, type Device } from "../devices.ts";
import { findMotionIssues, type MotionFinding } from "../motion.ts";
import type { Finding, ReportImage, RunDir } from "../report.ts";
import type { StoryItem } from "../runner.ts";
import type { SessionOptions } from "../session.ts";
import type { Compositor, NormRect, Tile } from "../sheet.ts";
import { UsageError } from "../target.ts";

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
  // Frames were captured in device pixels and cropped (--zoom): show them larger.
  enlarged?: boolean;
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
  const preferred = aspect > 1.2 ? (options.enlarged ? 380 : 300) : aspect > 0.8 ? (options.enlarged ? 300 : 230) : options.enlarged ? 240 : 180;
  const tileHeight = options.enlarged ? preferred : Math.min(film.area.height, preferred);
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

type Film = Extract<StoryItem, { kind: "film" }>;

// Up to ten frames spread over the film, first and last included, ghosted into one picture.
export async function buildOnion(compositor: Compositor, film: Film, frameMs: number, title: string): Promise<Buffer> {
  const count = Math.min(10, film.frames.length);
  const picked = [...new Set(Array.from({ length: count }, (_, k) => Math.round((k * (film.frames.length - 1)) / Math.max(1, count - 1))))];
  const start = film.frames[0]!.time - frameMs;
  const first = picked[0]!;
  const last = picked[picked.length - 1]!;
  return compositor.onion({
    title,
    subtitle: `${picked.length} ghosts from frame #${first + 1} (${Math.round(film.frames[first]!.time - start)} ms) to #${last + 1} (${Math.round(film.frames[last]!.time - start)} ms), evenly spaced in time`,
    frames: picked.map((i) => film.frames[i]!.image),
    maxSize: 900,
  });
}

// Every run keeps its sampled frames in tiles/, so a later run can be compared with it frame for frame.
export function tileName(index: number): string {
  return `tiles/frame-${String(index + 1).padStart(4, "0")}.png`;
}

export interface CompareResult {
  png: Buffer;
  finding: Finding;
  differing: number[];
  compared: number;
}

// Runs are deterministic, so the same steps on the same code give the same pixels: every difference between two
// runs comes from the change in between.
export async function buildCompareSheet(
  compositor: Compositor,
  film: Film,
  previousDir: string,
  diffs: number[],
  options: { frameMs: number; device: Device },
): Promise<CompareResult> {
  const tilesDir = join(previousDir, "tiles");
  if (!existsSync(tilesDir)) {
    throw new UsageError(`--compare needs the folder of an earlier frames run (with a tiles/ folder inside): ${previousDir}`);
  }
  const previous = new Map<number, Buffer>();
  for (const name of readdirSync(tilesDir)) {
    const match = /^frame-(\d+)\.png$/.exec(name);
    if (match) previous.set(Number(match[1]) - 1, readFileSync(join(tilesDir, name)));
  }
  const shared = [...previous.keys()].filter((i) => i < film.frames.length).sort((a, b) => a - b);
  if (!shared.length) throw new UsageError(`No frames in ${tilesDir} overlap this run (it has ${film.frames.length} frames).`);
  const count = Math.min(12, shared.length);
  const picked = [...new Set(Array.from({ length: count }, (_, k) => shared[Math.round((k * (shared.length - 1)) / Math.max(1, count - 1))]!))];

  const start = film.frames[0]!.time - options.frameMs;
  const tiles: Tile[] = [];
  const differing: number[] = [];
  let largest = { index: -1, difference: 0 };
  for (const index of picked) {
    const pair = await compositor.pair(previous.get(index)!, film.frames[index]!.image);
    const changed = pair.difference > 0.05;
    if (changed) differing.push(index);
    if (pair.difference > largest.difference) largest = { index, difference: pair.difference };
    tiles.push({
      image: pair.image,
      caption: `#${index + 1}  ${Math.round(film.frames[index]!.time - start)} ms`,
      note: changed ? `changed (Δ ${pair.difference.toFixed(2)})` : "same",
      accent: changed ? "amber" : null,
    });
  }

  let previousDiffs: number[] | undefined;
  try {
    const report = JSON.parse(readFileSync(join(previousDir, "report.json"), "utf8")) as {
      data?: { films?: { screenChangePerFrame?: number[] }[] };
    };
    previousDiffs = report.data?.films?.[0]?.screenChangePerFrame;
  } catch {
    previousDiffs = undefined;
  }

  const summary = differing.length
    ? `${differing.length} of ${picked.length} compared frames differ from the earlier run; the biggest change is at frame #${largest.index + 1}.`
    : `All ${picked.length} compared frames are identical to the earlier run.`;
  const aspect = film.area.height / Math.max(1, film.area.width);
  const png = await compositor.sheet({
    title: "compare  ·  earlier run (top) vs this run (bottom)",
    subtitle: `${describeDevice(options.device)}  ·  ${previousDir}  ·  dashed box = where the two differ`,
    tiles,
    tileHeight: Math.min(film.area.height * 2, aspect > 1.2 ? 520 : aspect > 0.8 ? 400 : 320),
    maxWidth: 1600,
    graph: {
      title: "Screen change per frame: bars = this run, line = earlier run (square-root scale)",
      values: diffs,
      highlight: [],
      ticks: picked,
      scale: "sqrt",
      overlay: previousDiffs,
    },
    notes: [{ text: summary, tone: differing.length ? "amber" : "green" }],
  });
  return { png, finding: { severity: "info", title: `compare: ${summary}` }, differing, compared: picked.length };
}

export type Zoom = "auto" | NormRect;

// "auto" or "x,y,w,h" in percent of the game area.
export function parseZoom(text: string): Zoom {
  if (text === "auto") return "auto";
  const parts = text.split(",").map((p) => Number(p.replace("%", "")));
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p) || p < 0 || p > 100) || parts[2]! <= 0 || parts[3]! <= 0) {
    throw new UsageError(`--zoom must be "auto" or x,y,width,height in percent of the game area (e.g. 10,40,40,40), got "${text}"`);
  }
  const [x, y, width, height] = parts.map((p) => p / 100) as [number, number, number, number];
  return { x, y, width: Math.min(width, 1 - x), height: Math.min(height, 1 - y) };
}

// Crops a film to the zoom region. "auto" takes everything that moved during the film, with a margin, so a small
// character in a big scene fills the tiles. Returns null when zooming would not help (motion covers most of it).
export async function zoomFilm(compositor: Compositor, film: Film, zoom: Zoom): Promise<{ film: Film; region: NormRect } | null> {
  let region: NormRect;
  if (zoom === "auto") {
    const motion = await compositor.motion([film.baseline, ...film.frames.map((f) => f.image)]);
    // The densest cells holding two thirds of all change: a character beats a background that scrolls everywhere.
    const total = motion.heat.reduce((sum, v) => sum + v, 0);
    if (total <= 0) return null;
    const cells = motion.heat.map((value, index) => ({ value, index })).sort((p, q) => q.value - p.value);
    let mass = 0;
    let minX = 1;
    let minY = 1;
    let maxX = 0;
    let maxY = 0;
    for (const cell of cells) {
      if (mass >= total * 0.66) break;
      mass += cell.value;
      const cx = cell.index % motion.heatColumns;
      const cy = Math.floor(cell.index / motion.heatColumns);
      minX = Math.min(minX, cx / motion.heatColumns);
      minY = Math.min(minY, cy / motion.heatRows);
      maxX = Math.max(maxX, (cx + 1) / motion.heatColumns);
      maxY = Math.max(maxY, (cy + 1) / motion.heatRows);
    }
    const union: NormRect = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    if (union.width * union.height > 0.6) return null;
    // A margin of a third of the moving area on each side, and never thinner than a fifth of the game area.
    const width = Math.max(0.2, union.width * 1.66);
    const height = Math.max(0.2, union.height * 1.66);
    const cx = union.x + union.width / 2;
    const cy = union.y + union.height / 2;
    region = {
      x: Math.min(Math.max(0, cx - width / 2), Math.max(0, 1 - width)),
      y: Math.min(Math.max(0, cy - height / 2), Math.max(0, 1 - height)),
      width: Math.min(1, width),
      height: Math.min(1, height),
    };
  } else {
    region = zoom;
  }
  const images = await compositor.crop([film.baseline, ...film.frames.map((f) => f.image)], region, 280);
  const [baseline, ...frames] = images;
  return {
    region,
    film: {
      ...film,
      baseline: baseline!,
      frames: film.frames.map((frame, i) => ({ ...frame, image: frames[i]! })),
      area: { x: 0, y: 0, width: film.area.width * region.width, height: film.area.height * region.height },
    },
  };
}
