// Runs inside the page before any game script (page.addInitScript). It must stay self-contained: Playwright
// serialises the function source, so it cannot reference anything outside its own body.
//
// Time is frozen from the first moment. Nothing time-based moves unless advance() is called, which runs timers and
// animation frames in exact virtual-time order. Loading still works because playproof advances frames while it
// waits for the page (see session.ts). Starting from a frozen, fixed time is what makes runs repeatable.

export interface ClockOptions {
  fps: number;
  seed: number | null;
}

export interface ClockApi {
  frameMs: number;
  now(): number;
  // frames=false models a backgrounded tab: timers still fire but no frames are drawn, so the first frame after
  // it sees the whole gap, as on a real phone.
  advance(ms: number, frames?: boolean): number;
  // Asynchronous work in flight that finishes in real time (WebAssembly compilation, audio and image decoding).
  // playproof waits for it before letting more virtual time pass.
  pending(): number;
  // Stop waiting for the work in flight now (it may never finish, e.g. a blocked database open).
  abandonPending(): void;
  // True if the page posted messages, used storage or workers since the last call: tasks may be queued that
  // should run before the next frame.
  takeActivity(): boolean;
  // Virtual time of the first frame of the game's render loop (three frames in a row with callbacks), or null.
  loopStartedAt(): number | null;
  stats(): { frames: number; rafRequests: number; timers: number };
}

export function installClock(options: ClockOptions): void {
  const w = window as unknown as Record<string, unknown> & Window;
  if (w.__playproofClock) return;

  const frameMs = 1000 / options.fps;
  const RealDate = Date;
  // Real browsers report a small positive time at first script run; 0 would trip `if (!lastTime)` style code.
  let now = 100;
  const epochOffset = RealDate.now() - now;
  let nextFrameAt = now + frameMs;
  let framesRun = 0;
  let rafRequests = 0;

  // An exception inside one callback must not stop the others, and it must still surface as an uncaught page
  // error, exactly as it would without the clock.
  const rethrow = (error: unknown): void => {
    queueMicrotask(() => {
      throw error;
    });
  };

  // --- requestAnimationFrame -------------------------------------------------------------------------------------
  let frameCallbacks = new Map<number, FrameRequestCallback>();
  let rafId = 0;
  window.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    rafRequests++;
    const id = ++rafId;
    frameCallbacks.set(id, callback);
    return id;
  };
  window.cancelAnimationFrame = (id: number): void => {
    frameCallbacks.delete(id);
  };
  let loopStartedAt: number | null = null;
  let busyFrames = 0;
  const runFrame = (): void => {
    framesRun++;
    if (loopStartedAt === null) {
      busyFrames = frameCallbacks.size > 0 ? busyFrames + 1 : 0;
      if (busyFrames === 3) loopStartedAt = now - 2 * frameMs;
    }
    const batch = frameCallbacks;
    frameCallbacks = new Map();
    for (const callback of batch.values()) {
      try {
        callback(now);
      } catch (error) {
        rethrow(error);
      }
    }
  };

  // --- timers ----------------------------------------------------------------------------------------------------
  interface Timer {
    id: number;
    at: number;
    callback: (...args: unknown[]) => void;
    args: unknown[];
    interval: number | null;
  }
  const timers = new Map<number, Timer>();
  let timerId = 0;
  const toCallback = (handler: TimerHandler): ((...args: unknown[]) => void) =>
    typeof handler === "function"
      ? (handler as (...args: unknown[]) => void)
      : // String handlers are legal (and still used by old code); evaluate them in global scope like the browser.
        () => {
          (0, eval)(String(handler));
        };
  const earliest = (): Timer | null => {
    let best: Timer | null = null;
    for (const timer of timers.values()) {
      if (!best || timer.at < best.at || (timer.at === best.at && timer.id < best.id)) best = timer;
    }
    return best;
  };
  const addTimer = (handler: TimerHandler, delay: unknown, args: unknown[], repeat: boolean): number => {
    const ms = Math.max(0, Number(delay) || 0);
    const id = ++timerId;
    // Browsers clamp nested/interval timers to >= 4 ms; >= 1 ms here keeps a zero-delay interval from spinning.
    timers.set(id, { id, at: now + ms, callback: toCallback(handler), args, interval: repeat ? Math.max(1, ms) : null });
    return id;
  };
  const clearTimer = (id?: number): void => {
    if (id !== undefined) timers.delete(id);
  };
  w.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) =>
    addTimer(handler, delay, args, false)) as typeof setTimeout;
  w.setInterval = ((handler: TimerHandler, delay?: number, ...args: unknown[]) =>
    addTimer(handler, delay, args, true)) as typeof setInterval;
  w.clearTimeout = clearTimer as typeof clearTimeout;
  w.clearInterval = clearTimer as typeof clearInterval;

  // --- asynchronous work that takes real time ------------------------------------------------------------------
  // An engine that compiles its WebAssembly for 300 ms would otherwise see a different amount of virtual time pass
  // on a fast and a slow machine, and start its scene at a different moment. Counting this work lets playproof
  // hold the clock until it is done, as it does for network requests.
  let pendingWork = 0;
  let abandoned = 0;
  let activity = 0;
  let activitySeen = 0;
  const track = <T>(promise: T): T => {
    if (!promise || typeof (promise as { then?: unknown }).then !== "function") return promise;
    activity++;
    pendingWork++;
    let settled = false;
    const done = (): void => {
      if (!settled) {
        settled = true;
        pendingWork--;
      }
    };
    (promise as unknown as Promise<unknown>).then(done, done);
    return promise;
  };
  const wrap = (owner: object | undefined, name: string): void => {
    const target = owner as Record<string, unknown> | undefined;
    const original = target?.[name];
    if (typeof original !== "function") return;
    target![name] = function (this: unknown, ...args: unknown[]) {
      return track((original as (...a: unknown[]) => unknown).apply(this, args));
    };
  };
  const wasm = (globalThis as { WebAssembly?: object }).WebAssembly;
  for (const name of ["compile", "compileStreaming", "instantiate", "instantiateStreaming"]) wrap(wasm, name);
  wrap(window, "createImageBitmap");
  wrap(globalThis.HTMLImageElement?.prototype, "decode");
  wrap(globalThis.BaseAudioContext?.prototype, "decodeAudioData");
  // IndexedDB answers through events, not promises (engines cache their data there while loading).
  const trackEvents = (target: EventTarget, endings: string[]): void => {
    activity++;
    pendingWork++;
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      pendingWork--;
      for (const name of endings) target.removeEventListener(name, done);
    };
    for (const name of endings) target.addEventListener(name, done);
  };
  const wrapRequest = (owner: object | undefined, names: string[], endings: string[]): void => {
    const target = owner as Record<string, unknown> | undefined;
    for (const name of names) {
      const original = target?.[name];
      if (typeof original !== "function") continue;
      target![name] = function (this: unknown, ...args: unknown[]) {
        const result = (original as (...a: unknown[]) => unknown).apply(this, args);
        if (result instanceof EventTarget) trackEvents(result, endings);
        return result;
      };
    }
  };
  // Messages to the page itself, to ports and to workers come back as tasks in real time.
  for (const owner of [window, globalThis.MessagePort?.prototype, globalThis.Worker?.prototype]) {
    const target = owner as unknown as Record<string, unknown> | undefined;
    const original = target?.postMessage;
    if (typeof original !== "function") continue;
    target!.postMessage = function (this: unknown, ...args: unknown[]) {
      activity++;
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
  }
  if (globalThis.IDBFactory) {
    wrapRequest(IDBFactory.prototype, ["open", "deleteDatabase"], ["success", "error", "blocked"]);
    wrapRequest(IDBDatabase.prototype, ["transaction"], ["complete", "error", "abort"]);
    const requests = ["get", "getAll", "getAllKeys", "getKey", "count", "put", "add", "delete", "clear"];
    wrapRequest(IDBObjectStore.prototype, requests, ["success", "error"]);
    wrapRequest(IDBIndex.prototype, requests, ["success", "error"]);
  }

  // --- performance.now / Date -----------------------------------------------------------------------------------
  performance.now = () => now;
  const epochNow = (): number => Math.floor(epochOffset + now);
  const VirtualDate = function (this: unknown, ...args: unknown[]) {
    if (!new.target) return new RealDate(epochNow()).toString();
    return args.length === 0 ? new RealDate(epochNow()) : new (RealDate as unknown as new (...a: unknown[]) => Date)(...args);
  } as unknown as DateConstructor;
  Object.defineProperties(VirtualDate, {
    prototype: { value: RealDate.prototype },
    now: { value: epochNow },
    parse: { value: RealDate.parse },
    UTC: { value: RealDate.UTC },
  });
  w.Date = VirtualDate;

  // --- Math.random -----------------------------------------------------------------------------------------------
  if (options.seed !== null) {
    // mulberry32: small, fast, good enough for particles and shuffles, and identical on every run.
    let state = options.seed >>> 0 || 1;
    Math.random = () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // --- Web Animations (CSS animations, transitions, element.animate) -----------------------------------------------
  // playproof sets the document timeline's playback rate to 0 over CDP, so these only move when stepped here.
  let animationsAt = now;
  const stepAnimations = (): void => {
    const ms = now - animationsAt;
    animationsAt = now;
    if (ms <= 0) return;
    for (const animation of document.getAnimations()) {
      if (animation.playState !== "running") continue;
      animation.currentTime = Number(animation.currentTime ?? 0) + ms * animation.playbackRate;
    }
  };

  // --- control API -----------------------------------------------------------------------------------------------
  const api: ClockApi = {
    frameMs,
    now: () => now,
    advance(ms: number, frames = true) {
      const end = now + Math.max(0, ms);
      if (!frames) nextFrameAt = Infinity;
      for (let guard = 0; guard < 1_000_000; guard++) {
        const timer = earliest();
        const timerAt = timer ? timer.at : Infinity;
        if (Math.min(timerAt, nextFrameAt) > end + 1e-6) break;
        if (timer && timerAt <= nextFrameAt) {
          now = Math.max(now, timerAt);
          if (timer.interval === null) timers.delete(timer.id);
          else timer.at += timer.interval;
          try {
            timer.callback(...timer.args);
          } catch (error) {
            rethrow(error);
          }
        } else {
          now = nextFrameAt;
          nextFrameAt += frameMs;
          stepAnimations();
          runFrame();
        }
      }
      now = end;
      if (!frames) {
        nextFrameAt = now + frameMs;
        stepAnimations();
      }
      return now;
    },
    pending: () => Math.max(0, pendingWork - abandoned),
    abandonPending: () => {
      abandoned = pendingWork;
    },
    takeActivity: () => {
      const busy = activity !== activitySeen;
      activitySeen = activity;
      return busy;
    },
    loopStartedAt: () => loopStartedAt,
    stats: () => ({ frames: framesRun, rafRequests, timers: timers.size }),
  };
  Object.defineProperty(w, "__playproofClock", { value: api, enumerable: false });
}
