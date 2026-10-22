import type { Browser, BrowserContext, Page, Request } from "playwright-core";
import { launchBrowser } from "./browser.ts";
import type { AndroidTarget } from "./android.ts";
import { describeDevice, type Device } from "./devices.ts";
import { PlaywrightDriver, type Driver } from "./driver.ts";
import { installClock } from "./inject/clock.ts";
import { installProbe } from "./inject/probe.ts";
import { openTarget, UsageError, type Target } from "./target.ts";

export interface SessionOptions {
  target: string;
  device: Device;
  browser?: string;
  headed?: boolean;
  // Install the virtual clock (needed for frame-exact capture and fast deterministic input).
  clock: boolean;
  fps: number;
  seed: number | null;
  waitFor?: string;
  ready?: string;
  settleMs: number;
  timeoutMs: number;
  area?: string;
  port?: number;
  cpuThrottle?: number;
}

export type IssueKind = "pageerror" | "console" | "request" | "crash";

export interface Issue {
  kind: IssueKind;
  message: string;
  // What the run was doing when the issue appeared, e.g. "step 4: tap 50%,80%".
  during: string;
}

// What the commands need, wherever the game runs: a local browser or a phone (android.ts).
export interface GameSession {
  url: string;
  // How the device is described in sheets and reports.
  deviceLabel: string;
  // The local browser that draws sheets and charts.
  browser: Browser;
  driver: Driver;
  issues: Issue[];
  // Set by commands so issues are attributed to the action that caused them.
  during: string;
  close(): Promise<void>;
}

export interface Session extends GameSession {
  device: Device;
  context: BrowserContext;
  page: Page;
  driver: PlaywrightDriver;
}

// A phone session when options.android is set, else a local browser.
export async function openGameSession(options: SessionOptions, android: AndroidTarget | null | undefined): Promise<GameSession> {
  if (!android) return openSession(options);
  const { openAndroidSession } = await import("./android.ts");
  return openAndroidSession(options, android);
}

// On the virtual clock the network should look instant to the game: whenever requests are in flight, virtual time
// waits for them, so a slow and a fast connection produce the same frames.
export class NetworkTracker {
  private readonly inflight = new Set<Request>();
  private readonly ignored = new Set<Request>();
  private lastActivity = 0;

  constructor(page: Page) {
    page.on("request", (request) => {
      this.inflight.add(request);
      this.lastActivity = Date.now();
    });
    const done = (request: Request): void => {
      this.inflight.delete(request);
      this.lastActivity = Date.now();
    };
    page.on("requestfinished", done);
    page.on("requestfailed", done);
  }

  busy(): boolean {
    return this.pending() > 0 || Date.now() - this.lastActivity < SETTLE_MS;
  }

  pending(): number {
    let count = 0;
    for (const request of this.inflight) if (!this.ignored.has(request)) count++;
    return count;
  }

  // Waits for in-flight requests (and a moment for decode callbacks). Requests still open after `capMs`, such as
  // long polling, are ignored from then on so they cannot stall every frame.
  async idle(capMs = 10000): Promise<void> {
    const until = Date.now() + capMs;
    while (this.pending() > 0 && Date.now() < until) await sleep(5);
    if (this.pending() > 0) for (const request of this.inflight) this.ignored.add(request);
    const quietFor = Date.now() - this.lastActivity;
    if (quietFor < SETTLE_MS) await sleep(SETTLE_MS - quietFor);
  }
}

const SETTLE_MS = 20;

export async function openSession(options: SessionOptions, shared?: { browser: Browser; target: Target }): Promise<Session> {
  const target = shared?.target ?? (await openTarget(options.target, options.port));
  let browser: Browser | null = shared?.browser ?? null;
  try {
    browser ??= await launchBrowser(options.browser, Boolean(options.headed));
    const context = await browser.newContext({
      viewport: { width: options.device.width, height: options.device.height },
      deviceScaleFactor: options.device.scale,
      isMobile: options.device.mobile,
      hasTouch: options.device.touch,
      userAgent: options.device.userAgent,
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(options.timeoutMs);
    await page.addInitScript(installProbe);
    const cdp = await context.newCDPSession(page);
    const network = new NetworkTracker(page);
    if (options.clock) {
      await page.addInitScript(installClock, { fps: options.fps, seed: options.seed });
      // CSS animations and transitions run on the document timeline, which JavaScript cannot freeze; stopping it
      // here lets the clock move them frame by frame.
      await cdp.send("Animation.enable");
      await cdp.send("Animation.setPlaybackRate", { playbackRate: 0 });
    }
    if (options.cpuThrottle && options.cpuThrottle > 1) {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: options.cpuThrottle });
    }
    const driver = new PlaywrightDriver(page, cdp, {
      touch: options.device.touch,
      fps: options.fps,
      area: options.area ?? null,
      clock: options.clock,
      network,
    });

    const session: Session = {
      url: target.url,
      deviceLabel: describeDevice(options.device),
      device: options.device,
      browser,
      context,
      page,
      driver,
      issues: [],
      during: "loading",
      close: async () => {
        await context.close().catch(() => {});
        if (!shared) {
          await browser?.close().catch(() => {});
          await target.close();
        }
      },
    };
    watch(session);
    await load(session, options, network);
    return session;
  } catch (error) {
    if (!shared) {
      await browser?.close().catch(() => {});
      await target.close();
    }
    throw error;
  }
}

function watch(session: Session): void {
  const add = (kind: IssueKind, message: string): void => {
    if (session.issues.length < 500) session.issues.push({ kind, message: message.slice(0, 4000), during: session.during });
  };
  session.page.on("pageerror", (error) => add("pageerror", error.stack || error.message));
  session.page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    // Failed resource loads are reported once, with their URL, by the response/requestfailed handlers below.
    if (/^Failed to load resource/i.test(text)) return;
    const where = message.location();
    add("console", where.url ? `${text}  (${where.url}:${where.lineNumber + 1})` : text);
  });
  session.page.on("requestfailed", (request) => {
    const reason = request.failure()?.errorText ?? "failed";
    // Aborts are normal (navigations, cancelled media loads).
    if (/ERR_ABORTED/.test(reason)) return;
    add("request", `${request.method()} ${request.url()} → ${reason}`);
  });
  session.page.on("response", (response) => {
    if (response.status() < 400) return;
    // Browsers ask for /favicon.ico on their own; a missing one says nothing about the game.
    if (new URL(response.url()).pathname === "/favicon.ico") return;
    add("request", `${response.request().method()} ${response.url()} → HTTP ${response.status()}`);
  });
  session.page.on("crash", () => add("crash", "The page crashed (renderer process died, often out of memory)."));
}

// Runs in the page. Reads a readiness value without awaiting it: awaiting a promise that needs frames would stall,
// because frames only run when playproof advances the clock.
export function readinessCheck(expression: string | null): boolean {
  const store = window as unknown as { __playproofReady?: Map<string, "pending" | "done"> };
  const key = expression ?? "hook";
  let value: unknown;
  if (expression === null) {
    const hook = (window as unknown as { playproof?: { ready?: unknown } }).playproof;
    if (!hook || !("ready" in hook)) return true;
    value = typeof hook.ready === "function" ? (hook.ready as () => unknown)() : hook.ready;
  } else {
    value = (0, eval)(expression);
  }
  if (value && typeof (value as Promise<unknown>).then === "function") {
    store.__playproofReady ??= new Map();
    if (!store.__playproofReady.has(key)) {
      store.__playproofReady.set(key, "pending");
      (value as Promise<unknown>).then(
        (resolved) => store.__playproofReady!.set(key, resolved === false ? "pending" : "done"),
        () => {},
      );
    }
    return store.__playproofReady.get(key) === "done";
  }
  return Boolean(value);
}

async function load(session: Session, options: SessionOptions, network: NetworkTracker): Promise<void> {
  await session.page.goto(session.url, { waitUntil: "load", timeout: options.timeoutMs });
  await prepareGame(session.driver, network, options);
  session.during = "idle";
}

// What loading needs from wherever the game runs (a local browser or a phone).
export interface LoadNetwork {
  idle(): Promise<void>;
  pending(): number;
}

// After the page's load event: wait until the game is ready, then let it settle. Shared by desktop and phone
// sessions, so it only talks to the game through the driver.
export async function prepareGame(
  driver: Driver,
  network: LoadNetwork,
  options: Pick<SessionOptions, "waitFor" | "ready" | "timeoutMs" | "settleMs">,
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  const describe = (): string =>
    [
      options.waitFor && `--wait-for ${options.waitFor}`,
      options.ready && `--ready ${options.ready}`,
      !options.waitFor && !options.ready && "window.playproof.ready",
    ]
      .filter(Boolean)
      .join(", ");
  const visible = (selector: string): string =>
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden"; })()`;
  const isReady = async (): Promise<boolean> => {
    if (options.waitFor && !(await driver.evaluate(visible(options.waitFor)).catch(() => false))) return false;
    return Boolean(await driver.evaluate(`(${readinessCheck.toString()})(${JSON.stringify(options.ready ?? null)})`));
  };
  const notReady = (): never => {
    throw new UsageError(`The game was not ready after ${options.timeoutMs} ms (waiting for ${describe()}).`);
  };

  if (!driver.virtual) {
    while (!(await isReady())) {
      if (Date.now() > deadline) notReady();
      await sleep(50);
    }
    for (const until = Date.now() + 5000; network.pending() > 0 && Date.now() < until; ) await sleep(50);
    if (options.settleMs > 0) await sleep(options.settleMs);
    return;
  }

  // Virtual clock: run frames while loading, waiting out the network after each one, until the page is ready and
  // has made no requests for a few consecutive frames. A page with nothing left to load becomes ready after exactly
  // the same number of frames every time.
  let quietFrames = 0;
  for (;;) {
    await network.idle();
    quietFrames = network.pending() === 0 ? quietFrames + 1 : 0;
    if (quietFrames >= 3 && (await isReady())) break;
    if (Date.now() > deadline) notReady();
    await driver.advance(driver.frameMs);
  }
  // Settle counts from the start of the game's render loop once there is one: engines measure their own time from
  // there, so how long loading took (which can vary with workers and storage) does not shift the scene. The loop
  // may start during the settle time itself, so the end is recomputed every frame.
  const clockState = async () =>
    (await driver.evaluate(
      "(() => { const c = window.__playproofClock; return { now: c.now(), loopStart: c.loopStartedAt() }; })()",
    )) as { now: number; loopStart: number | null };
  const begin = (await clockState()).now;
  for (let guard = 0; guard < 100000; guard++) {
    const { now, loopStart } = await clockState();
    const end = (loopStart ?? begin) + options.settleMs;
    if (now >= end - 1e-6) break;
    await driver.advance(Math.min(driver.frameMs, end - now));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}
