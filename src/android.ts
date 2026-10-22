import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Browser } from "playwright-core";
import { launchBrowser } from "./browser.ts";
import { findArea, readState, readTargets, setHidden, type Driver, type HookTarget, type Rect } from "./driver.ts";
import { installClock } from "./inject/clock.ts";
import { installProbe } from "./inject/probe.ts";
import { prepareGame, type GameSession, type Issue, type IssueKind, type SessionOptions } from "./session.ts";
import { openTarget, UsageError, type Target } from "./target.ts";

const run = promisify(execFile);

// Two ways onto a phone:
// - Chrome: playproof opens its own tab, talks only to that tab by id, and closes it at the end. Chrome exposes every
//   open tab over DevTools; playproof never lists, reads or touches the others.
// - An app's WebView (Capacitor, Cordova, Ionic, any hybrid app with WebView debugging on): playproof attaches to the
//   app's own page, reloads it with the virtual clock, and reloads it again without the clock when it is done.

export interface AndroidTarget {
  serial: string | null;
  // Package name of a WebView app, e.g. com.example.game. null = a tab in Chrome.
  app: string | null;
}

function adbPath(): string {
  if (process.env.ADB) return process.env.ADB;
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (sdk) {
    const candidate = join(sdk, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
    if (existsSync(candidate)) return candidate;
  }
  return "adb";
}

async function adb(serial: string | null, ...args: string[]): Promise<string> {
  const full = serial ? ["-s", serial, ...args] : args;
  try {
    const { stdout } = await run(adbPath(), full, { timeout: 20000, windowsHide: true });
    return stdout.trim();
  } catch (error) {
    const text = String((error as { stderr?: string }).stderr || (error as Error).message);
    if (/ENOENT/.test(text)) throw new UsageError("adb not found. Install Android platform-tools or set ADB=/path/to/adb.");
    throw new Error(`adb ${full.join(" ")}: ${text.trim().split("\n")[0]}`);
  }
}

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function pickDevice(wanted: string | null): Promise<string> {
  const listed = (await adb(null, "devices"))
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2);
  const ready = listed.filter((parts) => parts[1] === "device").map((parts) => parts[0]!);
  if (!ready.length) {
    const states = listed.map((parts) => `${parts[0]} (${parts[1]})`).join(", ");
    throw new UsageError(
      states
        ? `No usable Android device: ${states}. Unlock the phone and accept the USB debugging prompt.`
        : "No Android device connected. Connect a phone with USB debugging enabled.",
    );
  }
  const serial = wanted ?? ready[0]!;
  if (!ready.includes(serial)) throw new UsageError(`Device ${serial} is not connected (connected: ${ready.join(", ")}).`);
  return serial;
}

async function unixSockets(serial: string): Promise<string> {
  return adb(serial, "shell", "cat", "/proc/net/unix");
}

// Chrome only opens its DevTools socket while it is in the foreground. If the socket is missing, bring Chrome to
// the front (it shows whatever tab was last open; nothing is read from it) and wait for the socket.
async function chromeSocket(serial: string): Promise<string> {
  const has = async () => /@chrome_devtools_remote\b/.test(await unixSockets(serial));
  if (!(await has())) {
    await adb(serial, "shell", "am", "start", "-n", "com.android.chrome/com.google.android.apps.chrome.Main").catch(() => "");
    let found = false;
    for (let i = 0; i < 20 && !found; i++) {
      await sleep(500);
      found = await has();
    }
    if (!found) {
      throw new UsageError(
        "Chrome on the phone does not accept DevTools connections. Make sure Chrome is installed, the screen is on and unlocked, and USB debugging is allowed.",
      );
    }
  }
  return "chrome_devtools_remote";
}

// A WebView app exposes webview_devtools_remote_<pid> when WebView debugging is on (debug builds of Capacitor and
// Cordova apps have it). Starts the app if it is not running.
async function appSocket(serial: string, app: string): Promise<string> {
  let pid = (await adb(serial, "shell", "pidof", app).catch(() => "")).split(/\s+/)[0] ?? "";
  if (!pid) {
    await adb(serial, "shell", "monkey", "-p", app, "-c", "android.intent.category.LAUNCHER", "1").catch(() => "");
    for (let i = 0; i < 30 && !pid; i++) {
      await sleep(500);
      pid = (await adb(serial, "shell", "pidof", app).catch(() => "")).split(/\s+/)[0] ?? "";
    }
    if (!pid) throw new UsageError(`Could not start ${app} on the phone. Is it installed? (adb shell pm list packages | grep ${app})`);
  }
  for (let i = 0; i < 30; i++) {
    if (new RegExp(`@webview_devtools_remote_${pid}\\b`).test(await unixSockets(serial))) return `webview_devtools_remote_${pid}`;
    await sleep(500);
  }
  throw new UsageError(
    `${app} is running but its WebView is not debuggable. Debug builds of Capacitor and Cordova apps are; for other builds enable WebView.setWebContentsDebuggingEnabled(true) (Capacitor: "webContentsDebuggingEnabled": true in capacitor.config).`,
  );
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, { done: (value: unknown) => void; fail: (error: Error) => void }>();
  private readonly listeners = new Map<string, ((params: unknown) => void)[]>();
  private readonly socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        params?: unknown;
        result?: unknown;
        error?: { message: string };
      };
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) entry?.fail(new Error(message.error.message));
        else entry?.done(message.result);
      } else if (message.method) {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
      }
    });
    socket.addEventListener("close", () => {
      for (const entry of this.pending.values()) entry.fail(new Error("DevTools connection closed"));
      this.pending.clear();
    });
  }

  static connect(url: string): Promise<CdpConnection> {
    return new Promise((done, fail) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => fail(new Error(`Timed out connecting to ${url}`)), 15000);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          done(new CdpConnection(socket));
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          fail(new Error(`Could not connect to ${url}`));
        },
        { once: true },
      );
    });
  }

  // Every call has a deadline: a phone that locks or a tab that stalls must end the run, not hang it.
  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((done, fail) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        fail(new Error(`${method} got no answer from the phone in ${timeoutMs / 1000} s (screen locked?)`));
      }, timeoutMs);
      this.pending.set(id, {
        done: (value) => {
          clearTimeout(timer);
          done(value);
        },
        fail: (error) => {
          clearTimeout(timer);
          fail(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, listener: (params: never) => void): void {
    const list = this.listeners.get(method) ?? [];
    list.push(listener as (params: unknown) => void);
    this.listeners.set(method, list);
  }

  waitFor(method: string, timeoutMs: number): Promise<unknown> {
    return new Promise((done, fail) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        fail(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      this.on(method, (params) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        done(params);
      });
    });
  }

  close(): void {
    this.socket.close();
  }
}

// Requests in flight on the phone, from the DevTools Network domain (the desktop session uses Playwright's events).
class CdpNetwork {
  private readonly inflight = new Set<string>();
  private readonly ignored = new Set<string>();
  private lastActivity = 0;

  constructor(cdp: CdpConnection) {
    cdp.on("Network.requestWillBeSent", (p: { requestId: string }) => {
      this.inflight.add(p.requestId);
      this.lastActivity = Date.now();
    });
    const done = (p: { requestId: string }): void => {
      this.inflight.delete(p.requestId);
      this.lastActivity = Date.now();
    };
    cdp.on("Network.loadingFinished", done);
    cdp.on("Network.loadingFailed", done);
  }

  busy(): boolean {
    return this.pending() > 0 || Date.now() - this.lastActivity < 20;
  }

  pending(): number {
    let count = 0;
    for (const id of this.inflight) if (!this.ignored.has(id)) count++;
    return count;
  }

  async idle(capMs = 10000): Promise<void> {
    const until = Date.now() + capMs;
    while (this.pending() > 0 && Date.now() < until) await sleep(5);
    if (this.pending() > 0) for (const id of this.inflight) this.ignored.add(id);
    const quietFor = Date.now() - this.lastActivity;
    if (quietFor < 20) await sleep(20 - quietFor);
  }
}

const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  " ": { code: "Space", keyCode: 32, text: " " },
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Escape: { code: "Escape", keyCode: 27 },
  Tab: { code: "Tab", keyCode: 9 },
  Backspace: { code: "Backspace", keyCode: 8 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
};

export class CdpDriver implements Driver {
  readonly frameMs: number;
  readonly virtual: boolean;
  private readonly cdp: CdpConnection;
  private readonly network: CdpNetwork;
  private readonly areaSelector: string | null;
  private touchId = 0;
  private scale = 1;

  constructor(cdp: CdpConnection, network: CdpNetwork, options: { fps: number; virtual: boolean; area: string | null }) {
    this.cdp = cdp;
    this.network = network;
    this.frameMs = 1000 / options.fps;
    this.virtual = options.virtual;
    this.areaSelector = options.area;
  }

  async init(): Promise<void> {
    this.scale = Number(await this.evaluate("window.devicePixelRatio")) || 1;
  }

  async advance(ms: number, frames = true): Promise<void> {
    if (ms <= 0) return;
    if (!this.virtual) {
      await sleep(ms);
      return;
    }
    // Same contract as the desktop driver: frame-sized steps, waiting out requests and other real-time work.
    for (let left = ms; left > 1e-6; left -= this.frameMs) {
      const step = Math.min(left, this.frameMs);
      let pending = Number(
        await this.evaluate(
          `(async () => { const c = window.__playproofClock; c.advance(${step}, ${frames}); if (c.takeActivity()) await new Promise((d) => requestIdleCallback(d, { timeout: 50 })); return c.pending(); })()`,
        ),
      );
      if (this.network.busy()) await this.network.idle();
      for (const until = Date.now() + 5000; pending > 0; ) {
        if (Date.now() > until) {
          await this.evaluate("window.__playproofClock.abandonPending()");
          break;
        }
        await sleep(5);
        pending = Number(await this.evaluate("window.__playproofClock.pending()"));
      }
    }
  }

  async evaluate(expression: string): Promise<unknown> {
    const result = (await this.cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })) as { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string } };
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "evaluation failed");
    }
    return result.result?.value;
  }

  private call<T>(fn: (...args: never[]) => T, ...args: unknown[]): Promise<T> {
    return this.evaluate(`(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(",")})`) as Promise<T>;
  }

  area(): Promise<Rect> {
    return this.call(findArea, this.areaSelector);
  }

  viewport(): Promise<{ width: number; height: number }> {
    return this.evaluate("({ width: innerWidth, height: innerHeight })") as Promise<{ width: number; height: number }>;
  }

  async pointer(type: "down" | "move" | "up", x: number, y: number): Promise<void> {
    if (type === "down") this.touchId++;
    await this.cdp.send("Input.dispatchTouchEvent", {
      type: type === "down" ? "touchStart" : type === "move" ? "touchMove" : "touchEnd",
      touchPoints: type === "up" ? [] : [{ x, y, id: this.touchId }],
    });
  }

  async key(type: "down" | "up", key: string): Promise<void> {
    const known = KEYS[key];
    const printable = !known && key.length === 1;
    const code = known?.code ?? (printable && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key);
    const keyCode = known?.keyCode ?? (printable ? key.toUpperCase().charCodeAt(0) : 0);
    const text = known?.text ?? (printable ? key : undefined);
    await this.cdp.send("Input.dispatchKeyEvent", {
      type: type === "down" ? (text ? "keyDown" : "rawKeyDown") : "keyUp",
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      ...(type === "down" && text ? { text, unmodifiedText: text } : {}),
    });
  }

  async typeText(text: string): Promise<void> {
    await this.cdp.send("Input.insertText", { text });
  }

  async click(selector: string): Promise<void> {
    const box = (await this.evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
    )) as { x: number; y: number } | null;
    if (!box) throw new Error(`no element matches ${selector}`);
    await this.pointer("down", box.x, box.y);
    await this.pointer("up", box.x, box.y);
  }

  async screenshot(clip: Rect | null, detailed = false): Promise<Buffer> {
    const area = clip && clip.width >= 1 && clip.height >= 1 ? clip : { x: 0, y: 0, ...(await this.viewport()) };
    // Clip is in CSS pixels; the phone renders at devicePixelRatio, so scale down for CSS-sized images.
    const result = (await this.cdp.send("Page.captureScreenshot", {
      format: "png",
      clip: { ...area, scale: detailed ? 1 : 1 / this.scale },
      captureBeyondViewport: false,
    })) as { data: string };
    return Buffer.from(result.data, "base64");
  }

  targets(): Promise<HookTarget[]> {
    return this.call(readTargets);
  }

  state(): Promise<unknown> {
    return this.call(readState);
  }

  async setVisibility(hidden: boolean): Promise<void> {
    await this.call(setHidden, hidden);
  }
}

// Opens the game on a USB-connected phone and returns a session the commands can use like a desktop one.
export async function openAndroidSession(options: SessionOptions, android: AndroidTarget): Promise<GameSession> {
  const serial = await pickDevice(android.serial);
  const cleanup: (() => Promise<unknown>)[] = [];
  const undo = async (): Promise<void> => {
    for (const step of cleanup.splice(0).reverse()) await step().catch(() => {});
  };
  // Ctrl+C must still restore the app, close our tab and remove the port forwards on the phone.
  const onSignal = (): void => {
    void undo().finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  cleanup.push(async () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  });

  try {
    let target: Target | null = null;
    let url: string | null = null;
    if (options.target) {
      target = await openTarget(options.target, options.port);
      const opened = target;
      cleanup.push(() => opened.close());
      url = target.url;
      const parsed = new URL(url);
      if (["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) {
        const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
        await adb(serial, "reverse", `tcp:${port}`, `tcp:${port}`);
        cleanup.push(() => adb(serial, "reverse", "--remove", `tcp:${port}`));
      }
    } else if (!android.app) {
      throw new UsageError("Give a target to open in Chrome on the phone, or --app <package> to test a WebView app.");
    }

    const socket = android.app ? await appSocket(serial, android.app) : await chromeSocket(serial);
    const local = await freePort();
    await adb(serial, "forward", `tcp:${local}`, `localabstract:${socket}`);
    cleanup.push(() => adb(serial, "forward", "--remove", `tcp:${local}`));
    const version = (await fetchJson(`http://127.0.0.1:${local}/json/version`).catch(() => {
      throw new UsageError("The phone did not answer over DevTools. Keep the screen on and unlocked, and retry.");
    })) as { Browser?: string };

    let pageSocket: string;
    if (android.app) {
      // The app's own socket only lists the app's pages.
      const pages = (await fetchJson(`http://127.0.0.1:${local}/json/list`)) as { type: string; url: string; webSocketDebuggerUrl?: string }[];
      const page = pages.find((p) => p.type === "page" && p.webSocketDebuggerUrl && p.url !== "about:blank") ?? pages.find((p) => p.type === "page");
      if (!page?.webSocketDebuggerUrl) throw new UsageError(`${android.app} has no WebView page open yet. Open the screen with the game and retry.`);
      pageSocket = page.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, `ws://127.0.0.1:${local}`);
    } else {
      // Android Chrome refuses /json/new; the browser-level DevTools socket can still open (and close) a tab.
      const browser = await CdpConnection.connect(`ws://127.0.0.1:${local}/devtools/browser`);
      cleanup.push(async () => browser.close());
      const { targetId } = (await browser.send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
      cleanup.push(() => browser.send("Target.closeTarget", { targetId }));
      // A background tab draws no frames and cannot be screenshotted.
      await browser.send("Target.activateTarget", { targetId });
      pageSocket = `ws://127.0.0.1:${local}/devtools/page/${targetId}`;
    }

    const cdp = await CdpConnection.connect(pageSocket);
    cleanup.push(async () => cdp.close());
    const network = new CdpNetwork(cdp);
    const issues: Issue[] = [];
    const session = { during: "loading" };
    const add = (kind: IssueKind, message: string): void => {
      if (issues.length < 500) issues.push({ kind, message: message.slice(0, 4000), during: session.during });
    };
    const urls = new Map<string, string>();
    cdp.on("Network.requestWillBeSent", (p: { requestId: string; request: { url: string; method: string } }) =>
      urls.set(p.requestId, `${p.request.method} ${p.request.url}`),
    );
    cdp.on("Runtime.exceptionThrown", (p: { exceptionDetails: { text: string; exception?: { description?: string } } }) =>
      add("pageerror", p.exceptionDetails.exception?.description ?? p.exceptionDetails.text),
    );
    cdp.on("Runtime.consoleAPICalled", (p: { type: string; args: { value?: unknown; description?: string }[] }) => {
      if (p.type === "error") add("console", p.args.map((a) => a.description ?? String(a.value)).join(" "));
    });
    cdp.on("Network.loadingFailed", (p: { requestId: string; errorText: string; canceled?: boolean }) => {
      if (!p.canceled && !/ERR_ABORTED/.test(p.errorText)) add("request", `${urls.get(p.requestId) ?? "request"} → ${p.errorText}`);
    });
    cdp.on("Network.responseReceived", (p: { requestId: string; response: { status: number; url: string } }) => {
      if (p.response.status < 400 || /\/favicon\.ico$/.test(new URL(p.response.url).pathname)) return;
      add("request", `${urls.get(p.requestId) ?? p.response.url} → HTTP ${p.response.status}`);
    });
    cdp.on("Inspector.targetCrashed", () => add("crash", "The page crashed (renderer process died, often out of memory)."));

    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("Inspector.enable").catch(() => {});
    const scripts: string[] = [];
    const inject = async (source: string): Promise<void> => {
      const { identifier } = (await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source })) as { identifier: string };
      scripts.push(identifier);
    };
    await inject(`(${installProbe.toString()})();`);
    if (options.clock) {
      await inject(`(${installClock.toString()})(${JSON.stringify({ fps: options.fps, seed: options.seed })});`);
      await cdp.send("Animation.enable");
      await cdp.send("Animation.setPlaybackRate", { playbackRate: 0 });
    }
    if (android.app) {
      // Give the app back exactly as it was: no injected scripts, normal animation speed, a fresh load.
      cleanup.push(async () => {
        for (const identifier of scripts) await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier }).catch(() => {});
        await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 }).catch(() => {});
        await cdp.send("Page.reload", {}).catch(() => {});
      });
    }

    const loaded = cdp.waitFor("Page.loadEventFired", options.timeoutMs);
    if (url) await cdp.send("Page.navigate", { url });
    else await cdp.send("Page.reload", {});
    await loaded;
    if (!url) url = String((await cdp.send("Runtime.evaluate", { expression: "location.href", returnByValue: true }) as { result: { value: string } }).result.value);

    const driver = new CdpDriver(cdp, network, { fps: options.fps, virtual: options.clock, area: options.area ?? null });
    await driver.init();
    await prepareGame(driver, network, options);
    session.during = "idle";

    const [model, release, view] = await Promise.all([
      adb(serial, "shell", "getprop", "ro.product.model"),
      adb(serial, "shell", "getprop", "ro.build.version.release"),
      driver.evaluate("({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })") as Promise<{ w: number; h: number; dpr: number }>,
    ]);
    const engine = (version.Browser ?? "Chrome").replace("/", " ");
    const where = android.app ? `app ${android.app}` : "Chrome";
    // Sheets and reports are drawn locally.
    const sheets: Browser = await launchBrowser(options.browser, false);
    cleanup.push(() => sheets.close());

    const result: GameSession = {
      url,
      deviceLabel: `${model} (Android ${release}, ${engine}, ${where}) ${view.w}×${view.h} @${Math.round(view.dpr * 100) / 100}x`,
      browser: sheets,
      driver,
      issues,
      get during() {
        return session.during;
      },
      set during(value: string) {
        session.during = value;
      },
      close: undo,
    };
    return result;
  } catch (error) {
    await undo();
    throw error;
  }
}
