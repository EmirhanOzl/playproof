import type { Driver, Rect } from "./driver.ts";
import type { Point, Step } from "./steps.ts";

export interface Frame {
  image: Buffer;
  // Game time in ms since the script started.
  time: number;
}

export type StoryItem =
  | { kind: "shot"; label: string; image: Buffer; time: number; step: number }
  | { kind: "film"; label: string; baseline: Buffer; frames: Frame[]; fps: number | null; step: number; area: Rect };

export interface RunResult {
  items: StoryItem[];
  log: string[];
  elapsedMs: number;
  failure: { step: number; source: string; message: string } | null;
}

export interface RunOptions {
  // Screenshot the game area (default) or the whole viewport.
  fullView: boolean;
  // Capture films in device pixels, so they can be cropped and enlarged (--zoom).
  detailedFilms?: boolean;
  onStep?: (index: number, step: Step) => void;
}

const TAP_HOLD_MS = 50;

export async function runSteps(driver: Driver, steps: Step[], options: RunOptions): Promise<RunResult> {
  const items: StoryItem[] = [];
  const log: string[] = [];
  let elapsed = 0;
  const pass = async (ms: number, frames = true): Promise<void> => {
    await driver.advance(ms, frames);
    elapsed += ms;
  };
  const clip = async (): Promise<Rect | null> => (options.fullView ? null : driver.area());

  for (let index = 0; index < steps.length; index++) {
    const step = steps[index]!;
    options.onStep?.(index, step);
    try {
      switch (step.kind) {
        case "wait":
          await pass(step.ms);
          break;
        case "tap": {
          const [x, y] = await resolvePoint(driver, step.at);
          await driver.pointer("down", x, y);
          await pass(TAP_HOLD_MS);
          await driver.pointer("up", x, y);
          await pass(driver.frameMs);
          break;
        }
        case "press": {
          const [x, y] = await resolvePoint(driver, step.at);
          await driver.pointer("down", x, y);
          await pass(step.ms);
          await driver.pointer("up", x, y);
          await pass(driver.frameMs);
          break;
        }
        case "drag": {
          const [x1, y1] = await resolvePoint(driver, step.from);
          const [x2, y2] = await resolvePoint(driver, step.to);
          const moves = Math.max(2, Math.round(step.ms / driver.frameMs));
          await driver.pointer("down", x1, y1);
          await pass(driver.frameMs);
          for (let m = 1; m <= moves; m++) {
            const k = m / moves;
            await driver.pointer("move", x1 + (x2 - x1) * k, y1 + (y2 - y1) * k);
            await pass(step.ms / moves);
          }
          await driver.pointer("up", x2, y2);
          await pass(driver.frameMs);
          break;
        }
        case "key":
          await driver.key("down", step.key);
          await pass(step.ms);
          await driver.key("up", step.key);
          await pass(driver.frameMs);
          break;
        case "type":
          await driver.typeText(step.text);
          await pass(driver.frameMs);
          break;
        case "click":
          await driver.click(step.selector);
          await pass(driver.frameMs);
          break;
        case "shot":
          items.push({
            kind: "shot",
            label: step.label || `step ${index + 1}`,
            image: await driver.screenshot(await clip()),
            time: elapsed,
            step: index,
          });
          break;
        case "film": {
          const area = (await clip()) ?? { x: 0, y: 0, ...(await driver.viewport()) };
          const detailed = Boolean(options.detailedFilms);
          const baseline = await driver.screenshot(area, detailed);
          const frames: Frame[] = [];
          const count = Math.max(1, Math.round(step.ms / driver.frameMs));
          for (let f = 0; f < count; f++) {
            await pass(driver.frameMs);
            frames.push({ image: await driver.screenshot(area, detailed), time: elapsed });
          }
          items.push({ kind: "film", label: step.source, baseline, frames, fps: step.fps, step: index, area });
          break;
        }
        case "until": {
          let waited = 0;
          const poll = driver.virtual ? driver.frameMs : 50;
          for (;;) {
            if (await driver.evaluate(step.expression)) break;
            if (waited >= step.ms) throw new Error(`still false after ${Math.round(step.ms)} ms: ${step.expression}`);
            await pass(poll);
            waited += poll;
          }
          log.push(`step ${index + 1} (${step.source}): true after ${Math.round(waited)} ms`);
          break;
        }
        case "expect": {
          // Show what the parts of the expression were, so a failed assertion says why.
          const value = await driver.evaluate(step.expression);
          if (!value) {
            const comparison = /^(.+?)\s*(===|!==|==|!=|>=|<=|>|<)\s*(.+)$/.exec(step.expression);
            const left = comparison ? await driver.evaluate(comparison[1]!).catch(() => undefined) : undefined;
            const why = comparison && left !== undefined ? ` (${comparison[1]!.trim()} is ${JSON.stringify(left)})` : "";
            throw new Error(`expected ${step.expression}${why}`);
          }
          log.push(`step ${index + 1} (${step.source}): ok`);
          break;
        }
        case "background":
          await driver.setVisibility(true);
          await pass(step.ms, false);
          await driver.setVisibility(false);
          await pass(driver.frameMs);
          break;
        case "js": {
          const value = await driver.evaluate(step.expression);
          log.push(`step ${index + 1} (${step.source}) → ${JSON.stringify(value)?.slice(0, 2000)}`);
          break;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message.split("\n")[0]! : String(error);
      return { items, log, elapsedMs: elapsed, failure: { step: index, source: step.source, message } };
    }
  }
  return { items, log, elapsedMs: elapsed, failure: null };
}

export async function resolvePoint(driver: Driver, point: Point): Promise<[number, number]> {
  if (point.label !== undefined) {
    const targets = await driver.targets();
    const wanted = point.label.toLowerCase();
    const target =
      targets.find((t) => t.label.toLowerCase() === wanted) ?? targets.find((t) => t.label.toLowerCase().includes(wanted));
    if (!target) {
      const known = targets.map((t) => t.label).filter(Boolean);
      throw new Error(
        known.length
          ? `no target labelled "${point.label}" (known: ${known.slice(0, 20).join(", ")})`
          : `no target labelled "${point.label}": the game does not expose window.playproof.targets()`,
      );
    }
    return [target.x + target.width / 2, target.y + target.height / 2];
  }
  const area = await driver.area();
  const x = area.x + (point.xPercent ? (point.x / 100) * area.width : point.x);
  const y = area.y + (point.yPercent ? (point.y / 100) * area.height : point.y);
  return [x, y];
}
