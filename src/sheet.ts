import type { Browser, BrowserContext, Page } from "playwright-core";

// All image work (decoding, diffing, layout, PNG encoding) happens in a blank Chromium page, so playproof needs no
// native image libraries.

export interface Tile {
  image: Buffer;
  caption: string;
  // Second caption line, e.g. a finding; drawn in the accent colour.
  note?: string;
  // Region that changed since the previous tile, normalised 0..1.
  box?: NormRect | null;
  accent?: "red" | "amber" | "green" | null;
}

export interface NormRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Graph {
  title: string;
  values: number[];
  // Indices drawn in red (problems) and indices marked with a tick (frames shown as tiles).
  highlight: number[];
  ticks: number[];
  // Horizontal guide lines with labels, in value units.
  guides?: { value: number; label: string }[];
  // "sqrt" keeps small values visible next to a few huge ones (motion); "linear" for frame times.
  scale?: "linear" | "sqrt";
}

export interface SheetSpec {
  title: string;
  subtitle: string;
  tiles: Tile[];
  tileHeight: number;
  maxWidth: number;
  graph?: Graph;
  notes: { text: string; tone: "red" | "amber" | "green" | "plain" }[];
}

export interface MotionData {
  // Mean absolute luminance change (0..255) from the previous frame; diffs[0] compares with the baseline frame.
  diffs: number[];
  // Change between the frames on either side (i-1 → i+1); small while diffs[i] is large means flicker.
  skips: number[];
  boxes: (NormRect | null)[];
}

export class Compositor {
  private readonly context: BrowserContext;
  private readonly page: Page;

  private constructor(context: BrowserContext, page: Page) {
    this.context = context;
    this.page = page;
  }

  static async open(browser: Browser): Promise<Compositor> {
    const context = await browser.newContext({ viewport: { width: 400, height: 300 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.setContent("<!doctype html><html><body></body></html>");
    return new Compositor(context, page);
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => {});
  }

  // frames[0] is the baseline (state before the capture); results have frames.length - 1 entries.
  async motion(frames: Buffer[]): Promise<MotionData> {
    return this.page.evaluate(analyseMotion, frames.map(toDataUrl));
  }

  async sheet(spec: SheetSpec): Promise<Buffer> {
    const payload = {
      ...spec,
      tiles: spec.tiles.map((tile) => ({ ...tile, image: toDataUrl(tile.image) })),
    };
    const dataUrl = await this.page.evaluate(renderSheet, payload);
    return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  }
}

function toDataUrl(image: Buffer): string {
  return `data:image/png;base64,${image.toString("base64")}`;
}

// ---- page functions (self-contained) ------------------------------------------------------------------------------

async function analyseMotion(sources: string[]): Promise<MotionData> {
  const SAMPLE_WIDTH = 192;
  const CHANGE_THRESHOLD = 10;
  const images = await Promise.all(
    sources.map(
      (src) =>
        new Promise<HTMLImageElement>((done, fail) => {
          const img = new Image();
          img.onload = () => done(img);
          img.onerror = () => fail(new Error("frame decode failed"));
          img.src = src;
        }),
    ),
  );
  const first = images[0]!;
  const width = Math.min(SAMPLE_WIDTH, first.naturalWidth);
  const height = Math.max(1, Math.round((width * first.naturalHeight) / first.naturalWidth));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const luma = images.map((img) => {
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    const data = ctx.getImageData(0, 0, width, height).data;
    const out = new Float32Array(width * height);
    for (let i = 0; i < out.length; i++) out[i] = 0.299 * data[i * 4]! + 0.587 * data[i * 4 + 1]! + 0.114 * data[i * 4 + 2]!;
    return out;
  });
  const mean = (a: Float32Array, b: Float32Array): number => {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
    return sum / a.length;
  };
  const diffs: number[] = [];
  const skips: number[] = [];
  const boxes: (NormRect | null)[] = [];
  for (let f = 1; f < luma.length; f++) {
    const a = luma[f - 1]!;
    const b = luma[f]!;
    diffs.push(Math.round(mean(a, b) * 1000) / 1000);
    skips.push(f + 1 < luma.length ? Math.round(mean(a, luma[f + 1]!) * 1000) / 1000 : -1);
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (Math.abs(a[y * width + x]! - b[y * width + x]!) > CHANGE_THRESHOLD) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    boxes.push(
      maxX < 0 ? null : { x: minX / width, y: minY / height, width: (maxX - minX + 1) / width, height: (maxY - minY + 1) / height },
    );
  }
  return { diffs, skips, boxes };
}

async function renderSheet(spec: Omit<SheetSpec, "tiles"> & { tiles: (Omit<Tile, "image"> & { image: string })[] }): Promise<string> {
  const BG = "#101418";
  const PANEL = "#1a2027";
  const TEXT = "#e8edf2";
  const MUTED = "#93a1ae";
  const TONES: Record<string, string> = { red: "#ff5d5d", amber: "#ffb84d", green: "#5fd38d", plain: TEXT };
  const PAD = 16;
  const GAP = 10;
  const CAPTION = 34;
  const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

  const images = await Promise.all(
    spec.tiles.map(
      (tile) =>
        new Promise<HTMLImageElement>((done, fail) => {
          const img = new Image();
          img.onload = () => done(img);
          img.onerror = () => fail(new Error("tile decode failed"));
          img.src = tile.image;
        }),
    ),
  );

  // Flow layout: every tile has the same height, rows wrap at maxWidth.
  const tileHeight = spec.tileHeight;
  const sizes = images.map((img) => ({
    w: Math.max(40, Math.round((img.naturalWidth / Math.max(1, img.naturalHeight)) * tileHeight)),
    h: tileHeight,
  }));
  const innerMax = spec.maxWidth - PAD * 2;
  const rows: number[][] = [];
  let row: number[] = [];
  let rowWidth = 0;
  sizes.forEach((size, i) => {
    const add = (row.length ? GAP : 0) + size.w;
    if (row.length && rowWidth + add > innerMax) {
      rows.push(row);
      row = [];
      rowWidth = 0;
    }
    rowWidth += (row.length ? GAP : 0) + size.w;
    row.push(i);
  });
  if (row.length) rows.push(row);
  const rowWidths = rows.map((r) => r.reduce((sum, i) => sum + sizes[i]!.w, 0) + GAP * (r.length - 1));
  const contentWidth = Math.max(560, ...rowWidths);
  const width = Math.min(spec.maxWidth, contentWidth + PAD * 2);

  const measure = document.createElement("canvas").getContext("2d")!;
  const wrap = (text: string, font: string, max: number): string[] => {
    measure.font = font;
    const lines: string[] = [];
    for (const paragraph of text.split("\n")) {
      let line = "";
      for (const word of paragraph.split(" ")) {
        const next = line ? `${line} ${word}` : word;
        if (measure.measureText(next).width > max && line) {
          lines.push(line);
          line = word;
        } else {
          line = next;
        }
      }
      lines.push(line);
    }
    return lines;
  };

  const titleFont = `600 20px ${FONT}`;
  const subFont = `13px ${FONT}`;
  const capFont = `12px ${FONT}`;
  const noteFont = `13px ${FONT}`;
  const subtitleLines = wrap(spec.subtitle, subFont, width - PAD * 2);
  const headerHeight = PAD + 24 + subtitleLines.length * 18 + 8;
  const gridHeight = rows.length * (tileHeight + CAPTION) + Math.max(0, rows.length - 1) * GAP;
  const GRAPH_HEIGHT = spec.graph ? 120 : 0;
  const noteLines = spec.notes.flatMap((note) => wrap(note.text, noteFont, width - PAD * 2 - 14).map((text, i) => ({ text, tone: note.tone, first: i === 0 })));
  const notesHeight = noteLines.length ? 12 + noteLines.length * 19 : 0;
  const height = headerHeight + gridHeight + (spec.graph ? GAP + GRAPH_HEIGHT : 0) + notesHeight + PAD;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = "alphabetic";

  ctx.fillStyle = TEXT;
  ctx.font = titleFont;
  ctx.fillText(spec.title, PAD, PAD + 18);
  ctx.fillStyle = MUTED;
  ctx.font = subFont;
  subtitleLines.forEach((line, i) => ctx.fillText(line, PAD, PAD + 24 + 14 + i * 18));

  let y = headerHeight;
  rows.forEach((r, rowIndex) => {
    let x = PAD;
    for (const i of r) {
      const tile = spec.tiles[i]!;
      const size = sizes[i]!;
      ctx.fillStyle = PANEL;
      ctx.fillRect(x - 1, y - 1, size.w + 2, size.h + CAPTION + 2);
      ctx.drawImage(images[i]!, x, y, size.w, size.h);
      if (tile.box) {
        ctx.strokeStyle = "rgba(255, 64, 200, 0.9)";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(x + tile.box.x * size.w, y + tile.box.y * size.h, tile.box.width * size.w, tile.box.height * size.h);
        ctx.setLineDash([]);
      }
      if (tile.accent) {
        ctx.strokeStyle = TONES[tile.accent]!;
        ctx.lineWidth = 3;
        ctx.strokeRect(x - 1.5, y - 1.5, size.w + 3, size.h + 3);
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y + size.h, size.w, CAPTION);
      ctx.clip();
      ctx.font = capFont;
      ctx.fillStyle = TEXT;
      ctx.fillText(tile.caption, x + 4, y + size.h + 14);
      if (tile.note) {
        ctx.fillStyle = TONES[tile.accent ?? "amber"]!;
        ctx.fillText(tile.note, x + 4, y + size.h + 29);
      }
      ctx.restore();
      x += size.w + GAP;
    }
    y += tileHeight + CAPTION + (rowIndex < rows.length - 1 ? GAP : 0);
  });

  if (spec.graph) {
    const g = spec.graph;
    y += GAP;
    const gx = PAD;
    const gw = width - PAD * 2;
    const gh = GRAPH_HEIGHT;
    ctx.fillStyle = PANEL;
    ctx.fillRect(gx, y, gw, gh);
    ctx.fillStyle = MUTED;
    ctx.font = capFont;
    ctx.fillText(g.title, gx + 6, y + 14);
    const top = y + 22;
    const plotH = gh - 30;
    const guideMax = Math.max(0, ...(g.guides ?? []).map((guide) => guide.value));
    const curve = g.scale === "sqrt" ? Math.sqrt : (v: number) => v;
    const max = curve(Math.max(1e-6, ...g.values, guideMax * 1.15));
    const n = Math.max(1, g.values.length);
    const barW = gw / n;
    const highlight = new Set(g.highlight);
    g.values.forEach((value, i) => {
      const h = (curve(Math.max(0, value)) / max) * plotH;
      ctx.fillStyle = highlight.has(i) ? TONES.red! : "#4aa3df";
      ctx.fillRect(gx + i * barW + (barW > 3 ? 0.5 : 0), top + plotH - h, Math.max(1, barW - (barW > 3 ? 1 : 0)), h);
    });
    ctx.fillStyle = "rgba(232, 237, 242, 0.55)";
    for (const i of g.ticks) ctx.fillRect(gx + (i + 0.5) * barW - 0.5, top + plotH + 2, 1, 5);
    for (const guide of g.guides ?? []) {
      const gy = top + plotH - (curve(guide.value) / max) * plotH;
      ctx.strokeStyle = "rgba(255, 184, 77, 0.7)";
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(gx, gy);
      ctx.lineTo(gx + gw, gy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = TONES.amber!;
      ctx.fillText(guide.label, gx + gw - ctx.measureText(guide.label).width - 8, gy - 3);
    }
    y += gh;
  }

  if (noteLines.length) {
    y += 12;
    ctx.font = noteFont;
    for (const line of noteLines) {
      if (line.first) {
        ctx.fillStyle = TONES[line.tone]!;
        ctx.fillRect(PAD, y + 5, 6, 6);
      }
      ctx.fillStyle = line.tone === "plain" ? TEXT : TONES[line.tone]!;
      ctx.fillText(line.text, PAD + 14, y + 13);
      y += 19;
    }
  }
  return canvas.toDataURL("image/png");
}
