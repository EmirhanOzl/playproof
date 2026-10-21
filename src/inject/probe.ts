// Runs inside the page before any game script. Self-contained for the same reason as clock.ts.
// Collects uncaught errors (needed when driving a phone over raw CDP, where Playwright's page events do not exist),
// counts render-loop activity, and records real frame intervals and long tasks for `perf`.

export interface ProbeApi {
  errors: { message: string; at: number }[];
  rafCalls: number;
  startFrames(): void;
  stopFrames(): { intervals: number[]; longTasks: { start: number; duration: number }[]; durationMs: number };
  heapMB(): number | null;
}

export function installProbe(): void {
  const w = window as unknown as Record<string, unknown> & Window;
  if (w.__playproofProbe) return;
  const realRaf = window.requestAnimationFrame.bind(window);
  const realNow = performance.now.bind(performance);

  const api: ProbeApi = {
    errors: [],
    rafCalls: 0,
    startFrames,
    stopFrames,
    heapMB: () => {
      const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      return memory ? Math.round((memory.usedJSHeapSize / 1048576) * 10) / 10 : null;
    },
  };

  const record = (message: string): void => {
    if (api.errors.length < 200) api.errors.push({ message: message.slice(0, 2000), at: Math.round(realNow()) });
  };
  window.addEventListener("error", (event) => {
    const error = event.error as Error | undefined;
    record(error?.stack ?? `${event.message} (${event.filename}:${event.lineno})`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason as Error | undefined;
    record(`Unhandled rejection: ${reason?.stack ?? String(reason)}`);
  });

  const gameRaf = window.requestAnimationFrame;
  window.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    api.rafCalls++;
    return gameRaf.call(window, callback);
  };

  let recording = false;
  let intervals: number[] = [];
  let last = 0;
  let startedAt = 0;
  let longTasks: { start: number; duration: number }[] = [];
  let observer: PerformanceObserver | null = null;
  const tick = (time: number): void => {
    if (!recording) return;
    if (last) intervals.push(time - last);
    last = time;
    realRaf(tick);
  };
  function startFrames(): void {
    intervals = [];
    longTasks = [];
    last = 0;
    startedAt = realNow();
    recording = true;
    realRaf(tick);
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.startTime >= startedAt) longTasks.push({ start: entry.startTime - startedAt, duration: entry.duration });
        }
      });
      observer.observe({ type: "longtask", buffered: true });
    } catch {
      observer = null;
    }
  }
  function stopFrames() {
    recording = false;
    observer?.disconnect();
    return { intervals, longTasks, durationMs: realNow() - startedAt };
  }

  Object.defineProperty(w, "__playproofProbe", { value: api, enumerable: false });
}
