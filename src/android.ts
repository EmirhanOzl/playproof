import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { findArea, readState, readTargets, setHidden, type Driver, type HookTarget, type Rect } from "./driver.ts";
import { installProbe } from "./inject/probe.ts";
import { UsageError } from "./target.ts";

const run = promisify(execFile);

// Chrome on the phone exposes every open tab over DevTools. playproof opens its own tab, talks only to that tab by
// id, and closes it at the end; it never lists, reads or touches the user's other tabs.

export interface AndroidPhone {
  serial: string;
  model: string;
  android: string;
  chrome: string;
}

export interface AndroidTab {
  phone: AndroidPhone;
  driver: CdpDriver;
  close(): Promise<void>;
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

// url: the page to open. servedPort / localhost ports are reversed so the phone reaches this machine over USB.
export async function openAndroidTab(url: string, wantedSerial: string | null, settleMs: number, timeoutMs: number): Promise<AndroidTab> {
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
  const serial = wantedSerial ?? ready[0]!;
  if (!ready.includes(serial)) throw new UsageError(`Device ${serial} is not connected (connected: ${ready.join(", ")}).`);

  const cleanup: (() => Promise<unknown>)[] = [];
  const undo = async (): Promise<void> => {
    for (const step of cleanup.splice(0).reverse()) await step().catch(() => {});
  };
  // Ctrl+C must still close our tab and remove the port forwards on the phone.
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
    const target = new URL(url);
    if (["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) {
      const port = target.port || (target.protocol === "https:" ? "443" : "80");
      await adb(serial, "reverse", `tcp:${port}`, `tcp:${port}`);
      cleanup.push(() => adb(serial, "reverse", "--remove", `tcp:${port}`));
    }
    await ensureChromeDebuggable(serial);
    const local = await freePort();
    await adb(serial, "forward", `tcp:${local}`, "localabstract:chrome_devtools_remote");
    cleanup.push(() => adb(serial, "forward", "--remove", `tcp:${local}`));
    const devtools = `http://127.0.0.1:${local}`;

    const version = (await fetchJson(`${devtools}/json/version`).catch(() => {
      throw new UsageError("Chrome on the phone did not answer. Keep the screen on and unlocked, and retry.");
    })) as { Browser?: string };
    const [model, android] = await Promise.all([
      adb(serial, "shell", "getprop", "ro.product.model"),
      adb(serial, "shell", "getprop", "ro.build.version.release"),
    ]);

    // Android Chrome refuses /json/new; the browser-level DevTools socket can still open (and close) a tab.
    const browser = await CdpConnection.connect(`ws://127.0.0.1:${local}/devtools/browser`);
    cleanup.push(async () => browser.close());
    const { targetId } = (await browser.send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
    cleanup.push(() => browser.send("Target.closeTarget", { targetId }));
    const cdp = await CdpConnection.connect(`ws://127.0.0.1:${local}/devtools/page/${targetId}`);
    cleanup.push(async () => cdp.close());
    // A background tab draws no frames and cannot be screenshotted.
    await browser.send("Target.activateTarget", { targetId });

    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${installProbe.toString()})();` });
    const loaded = cdp.waitFor("Page.loadEventFired", timeoutMs);
    await cdp.send("Page.navigate", { url });
    await loaded;
    await new Promise((done) => setTimeout(done, settleMs));

    const phone: AndroidPhone = { serial, model, android, chrome: version.Browser ?? "Chrome" };
    return { phone, driver: new CdpDriver(cdp), close: undo };
  } catch (error) {
    await undo();
    throw error;
  }
}

// Chrome only opens its DevTools socket while it is in the foreground. If the socket is missing, bring Chrome to
// the front (it shows whatever tab was last open; nothing is read from it) and wait for the socket.
async function ensureChromeDebuggable(serial: string): Promise<void> {
  const hasSocket = async () => /@chrome_devtools_remote\b/.test(await adb(serial, "shell", "cat", "/proc/net/unix"));
  if (await hasSocket()) return;
  await adb(serial, "shell", "am", "start", "-n", "com.android.chrome/com.google.android.apps.chrome.Main").catch(() => "");
  for (let i = 0; i < 20; i++) {
    await new Promise((done) => setTimeout(done, 500));
    if (await hasSocket()) return;
  }
  throw new UsageError(
    "Chrome on the phone does not accept DevTools connections. Make sure Chrome is installed, the screen is on and unlocked, and USB debugging is allowed.",
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
      socket.addEventListener("open", () => done(new CdpConnection(socket)), { once: true });
      socket.addEventListener("error", () => fail(new Error(`Could not connect to ${url}`)), { once: true });
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

  waitFor(method: string, timeoutMs: number): Promise<unknown> {
    return new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`Timed out waiting for ${method}`)), timeoutMs);
      const list = this.listeners.get(method) ?? [];
      list.push((params) => {
        clearTimeout(timer);
        done(params);
      });
      this.listeners.set(method, list);
    });
  }

  close(): void {
    this.socket.close();
  }
}

export class CdpDriver implements Driver {
  readonly frameMs = 1000 / 60;
  readonly virtual = false;
  private readonly cdp: CdpConnection;
  private touchId = 0;

  constructor(cdp: CdpConnection) {
    this.cdp = cdp;
  }

  async advance(ms: number): Promise<void> {
    await new Promise((done) => setTimeout(done, ms));
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
    return this.call(findArea, null);
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

  async key(): Promise<void> {
    throw new UsageError("Key steps are not supported with --android; use tap, drag, press and wait.");
  }

  async typeText(): Promise<void> {
    throw new UsageError("type is not supported with --android.");
  }

  async click(): Promise<void> {
    throw new UsageError("click <selector> is not supported with --android; tap a point instead.");
  }

  async screenshot(clip: Rect | null): Promise<Buffer> {
    const result = (await this.cdp.send("Page.captureScreenshot", {
      format: "png",
      ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
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
