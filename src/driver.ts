import type { CDPSession, Page } from "playwright-core";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Optional hook a game can expose: window.playproof = { ready, state(), targets(), area() }.
export interface HookTarget extends Rect {
  label: string;
}

// Everything the step runner, `monkey` and `perf` need from a page. Implemented over Playwright for desktop runs and
// over raw CDP for a real Android phone (android.ts).
export interface Driver {
  readonly frameMs: number;
  // True when the page runs on playproof's virtual clock (see inject/clock.ts).
  readonly virtual: boolean;
  // Lets `ms` of game time pass: instantly and exactly on the virtual clock, by real waiting otherwise.
  // frames=false: no frames are drawn meanwhile (a backgrounded tab).
  advance(ms: number, frames?: boolean): Promise<void>;
  area(): Promise<Rect>;
  viewport(): Promise<{ width: number; height: number }>;
  pointer(type: "down" | "move" | "up", x: number, y: number): Promise<void>;
  key(type: "down" | "up", key: string): Promise<void>;
  typeText(text: string): Promise<void>;
  click(selector: string): Promise<void>;
  evaluate(expression: string): Promise<unknown>;
  // detailed: device pixels instead of CSS pixels (sharper crops when zooming in).
  screenshot(clip: Rect | null, detailed?: boolean): Promise<Buffer>;
  targets(): Promise<HookTarget[]>;
  state(): Promise<unknown>;
  setVisibility(hidden: boolean): Promise<void>;
}

// Runs in the page: the game area is the --area element, else the largest visible canvas, else the viewport.
export function findArea(selector: string | null): Rect {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clip = (r: DOMRect): Rect => {
    const x = Math.max(0, r.left);
    const y = Math.max(0, r.top);
    return { x, y, width: Math.max(0, Math.min(vw, r.right) - x), height: Math.max(0, Math.min(vh, r.bottom) - y) };
  };
  if (selector) {
    const element = document.querySelector(selector);
    if (element) return clip(element.getBoundingClientRect());
  }
  // Games that letterbox a fixed-size world inside a full-screen canvas can say where the world is.
  const hook = (window as unknown as { playproof?: { area?: () => Rect } }).playproof;
  if (typeof hook?.area === "function") {
    const r = hook.area();
    if (r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0) {
      return clip(new DOMRect(r.x, r.y, r.width, r.height));
    }
  }
  let best: Rect | null = null;
  for (const canvas of Array.from(document.querySelectorAll("canvas"))) {
    const style = getComputedStyle(canvas);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
    const r = clip(canvas.getBoundingClientRect());
    if (!best || r.width * r.height > best.width * best.height) best = r;
  }
  if (best && best.width * best.height >= vw * vh * 0.1) return best;
  return { x: 0, y: 0, width: vw, height: vh };
}

// Runs in the page.
export function readTargets(): HookTarget[] {
  const hook = (window as unknown as { playproof?: { targets?: () => unknown } }).playproof;
  const list = typeof hook?.targets === "function" ? hook.targets() : [];
  if (!Array.isArray(list)) return [];
  return list
    .filter((t) => t && typeof t === "object" && ["x", "y", "width", "height"].every((k) => Number.isFinite(t[k])))
    .map((t) => ({ x: t.x, y: t.y, width: t.width, height: t.height, label: String(t.label ?? "") }));
}

// Runs in the page.
export function readState(): unknown {
  const hook = (window as unknown as { playproof?: { state?: () => unknown } }).playproof;
  try {
    return typeof hook?.state === "function" ? JSON.parse(JSON.stringify(hook.state() ?? null)) : undefined;
  } catch (error) {
    return { error: `state() failed: ${String(error)}` };
  }
}

// Runs in the page.
export function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "visibilityState", { value: hidden ? "hidden" : "visible", configurable: true });
  Object.defineProperty(document, "hidden", { value: hidden, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event(hidden ? "blur" : "focus"));
}

export class PlaywrightDriver implements Driver {
  readonly frameMs: number;
  readonly virtual: boolean;
  private touchId = 0;
  private readonly page: Page;
  private readonly cdp: CDPSession;
  private readonly touch: boolean;
  private readonly areaSelector: string | null;
  private readonly network: { busy(): boolean; idle(): Promise<void> } | null;

  constructor(
    page: Page,
    cdp: CDPSession,
    options: {
      touch: boolean;
      fps: number;
      area: string | null;
      clock: boolean;
      network?: { busy(): boolean; idle(): Promise<void> };
    },
  ) {
    this.page = page;
    this.cdp = cdp;
    this.touch = options.touch;
    this.frameMs = 1000 / options.fps;
    this.areaSelector = options.area;
    this.virtual = options.clock;
    this.network = options.network ?? null;
  }

  async advance(ms: number, frames = true): Promise<void> {
    if (ms <= 0) return;
    if (this.virtual) {
      // Frame-sized steps, so a request (or WebAssembly compile, or decode) the game starts mid-wait is finished
      // before the game sees more time pass.
      for (let left = ms; left > 1e-6; left -= this.frameMs) {
        let pending = await this.page.evaluate(async ([time, draw]) => {
          const clock = (
            window as unknown as {
              __playproofClock: { advance(ms: number, frames: boolean): number; pending(): number; takeActivity(): boolean };
            }
          ).__playproofClock;
          clock.advance(time, draw);
          // If the page posted messages or used storage or workers, let the tasks that queued run before the next
          // frame, so their order against virtual time does not depend on machine speed. requestIdleCallback is left
          // real; most games never get here, so they pay nothing for it.
          if (clock.takeActivity()) await new Promise((done) => requestIdleCallback(done, { timeout: 50 }));
          return clock.pending();
        }, [Math.min(left, this.frameMs), frames] as const);
        if (this.network?.busy()) await this.network.idle();
        // Work that never finishes (a blocked database open, a stuck decode) must not stall every frame.
        for (const until = Date.now() + 5000; pending > 0; ) {
          if (Date.now() > until) {
            await this.page.evaluate(() =>
              (window as unknown as { __playproofClock: { abandonPending(): void } }).__playproofClock.abandonPending(),
            );
            break;
          }
          await new Promise((done) => setTimeout(done, 5));
          pending = await this.page.evaluate(() =>
            (window as unknown as { __playproofClock: { pending(): number } }).__playproofClock.pending(),
          );
        }
      }
    } else {
      await this.page.waitForTimeout(ms);
    }
  }

  area(): Promise<Rect> {
    return this.page.evaluate(findArea, this.areaSelector);
  }

  async viewport(): Promise<{ width: number; height: number }> {
    return this.page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  }

  async pointer(type: "down" | "move" | "up", x: number, y: number): Promise<void> {
    if (this.touch) {
      // Real touch events (and the pointer/mouse events Chrome derives from them), like a finger on a phone.
      if (type === "down") this.touchId++;
      await this.cdp.send("Input.dispatchTouchEvent", {
        type: type === "down" ? "touchStart" : type === "move" ? "touchMove" : "touchEnd",
        touchPoints: type === "up" ? [] : [{ x, y, id: this.touchId, radiusX: 4, radiusY: 4, force: 1 }],
      });
      return;
    }
    await this.page.mouse.move(x, y);
    if (type === "down") await this.page.mouse.down();
    if (type === "up") await this.page.mouse.up();
  }

  async key(type: "down" | "up", key: string): Promise<void> {
    if (type === "down") await this.page.keyboard.down(key);
    else await this.page.keyboard.up(key);
  }

  async typeText(text: string): Promise<void> {
    await this.page.keyboard.type(text);
  }

  async click(selector: string): Promise<void> {
    // No actionability waits: with the clock frozen, a waiting click could never see an animation finish.
    await this.page.locator(selector).first().click({ force: true, timeout: 5000 });
  }

  evaluate(expression: string): Promise<unknown> {
    return this.page.evaluate((code) => {
      // Indirect eval: global scope, and the expression may be "await"-free code or a promise.
      return Promise.resolve((0, eval)(code)).then((value) => {
        try {
          return JSON.parse(JSON.stringify(value ?? null));
        } catch {
          return String(value);
        }
      });
    }, expression);
  }

  screenshot(clip: Rect | null, detailed = false): Promise<Buffer> {
    const usable = clip && clip.width >= 1 && clip.height >= 1 ? clip : undefined;
    return this.page.screenshot({
      clip: usable,
      scale: detailed ? "device" : "css",
      animations: "allow",
      caret: "hide",
      timeout: 15000,
    });
  }

  targets(): Promise<HookTarget[]> {
    return this.page.evaluate(readTargets);
  }

  state(): Promise<unknown> {
    return this.page.evaluate(readState);
  }

  async setVisibility(hidden: boolean): Promise<void> {
    await this.page.evaluate(setHidden, hidden);
  }
}
