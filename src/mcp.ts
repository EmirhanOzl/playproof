import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { captureCommand } from "./commands/capture.ts";
import { parseZoom, type CommonOptions } from "./commands/common.ts";
import { devicesCommand } from "./commands/devices.ts";
import { monkeyCommand } from "./commands/monkey.ts";
import { perfCommand } from "./commands/perf.ts";
import { DESKTOP, resolveDevice } from "./devices.ts";
import type { Report, RunDir } from "./report.ts";
import { parseSteps, parseTime, STEP_HELP } from "./steps.ts";

// A Model Context Protocol server over stdio (newline-delimited JSON-RPC), for agents and apps that call tools
// instead of running shell commands. Tool results carry the images themselves, so the model sees the contact sheet
// directly. Hand-written to keep playproof at a single dependency; the stdio transport is small and stable.

const SUPPORTED = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

interface Request {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

const common = {
  target: { type: "string", description: "URL (e.g. http://localhost:5173), folder (./dist) or HTML file of the game" },
  device: { type: "string", description: 'Device to emulate: "iPhone 15", "Pixel 8", "desktop" (default) or "390x844@3 mobile"' },
  ready: { type: "string", description: "JavaScript expression that is true once the game has loaded" },
  waitFor: { type: "string", description: "CSS selector to wait for before starting" },
  area: { type: "string", description: "CSS selector of the game area (default: the largest canvas)" },
} as const;

const steps = { type: "string", description: `Steps separated by ";". ${STEP_HELP.replace(/\s+/g, " ")}` } as const;

const TOOLS = [
  {
    name: "frames",
    title: "Film an animation frame by frame",
    description:
      "Runs the game on a virtual clock, optionally performs steps to trigger something, then films it frame by frame. Returns a contact sheet (tiles with frame number and time, dashed boxes around what moved, a bar per frame of how much changed) and an onion-skin image (the whole motion ghosted into one picture), plus flagged sudden jumps, one-frame flicker and stalls. Runs are deterministic: pass compare = the folder of an earlier run to see exactly what a code change did.",
    inputSchema: {
      type: "object",
      properties: {
        ...common,
        steps,
        duration: { type: "string", description: "How long to film, e.g. 800ms or 1.5s (default 1s)" },
        fps: { type: "number", description: "Tiles per second on the sheet (default: fit about 24 tiles)" },
        compare: { type: "string", description: "Output folder of an earlier frames run to compare with" },
        zoom: { type: "string", description: 'Crop to what moves ("auto") or to x,y,w,h in percent of the game area' },
      },
      required: ["target"],
    },
  },
  {
    name: "play",
    title: "Play a scripted sequence",
    description:
      'Plays a script of taps, drags, keys and waits on the virtual clock and returns a storyboard of every "shot" and "film" step. Use "until <js> <time>" to wait for game states instead of guessing.',
    inputSchema: {
      type: "object",
      properties: { ...common, steps: { ...steps, description: `Required. ${steps.description}` } },
      required: ["target", "steps"],
    },
  },
  {
    name: "monkey",
    title: "Hunt for crashes with random play",
    description:
      "Random taps, drags, keys and backgrounding, repeatable by seed. Reports uncaught errors, failed requests, hangs, soft-locks and a render loop that stops, each with a command that reproduces it.",
    inputSchema: {
      type: "object",
      properties: {
        ...common,
        actions: { type: "number", description: "Number of random actions (default 300)" },
        seed: { type: "number", description: "Random seed (default 1); the same seed replays the same actions" },
      },
      required: ["target"],
    },
  },
  {
    name: "devices",
    title: "Check phones, tablet and desktop",
    description:
      "Loads the game on nine screens and returns them side by side, with layout findings: blurry or stretched canvas, canvas cut off, page scrolling, missing viewport meta, missing touch-action, clipped text, small touch targets.",
    inputSchema: {
      type: "object",
      properties: {
        ...common,
        devices: { type: "array", items: { type: "string" }, description: "Device names (default: a matrix of nine)" },
        steps: { ...steps, description: `Run on every device before the screenshot. ${steps.description}` },
      },
      required: ["target"],
    },
  },
  {
    name: "perf",
    title: "Measure frame pacing",
    description:
      "Measures real frame times (fps, p95/p99, dropped frames at the display's refresh rate, long tasks, heap growth) while the game idles, runs steps, or takes random taps. Locally the CPU is slowed 4x; android = true measures Chrome on a USB-connected Android phone.",
    inputSchema: {
      type: "object",
      properties: {
        ...common,
        duration: { type: "string", description: "How long to measure (default 10s)" },
        steps,
        monkey: { type: "boolean", description: "Tap randomly while measuring" },
        cpu: { type: "number", description: "CPU slowdown factor for local runs (default 4, 1 = off)" },
        android: { type: "boolean", description: "Measure on a USB-connected Android phone" },
      },
      required: ["target"],
    },
  },
];

const INSTRUCTIONS =
  "playproof lets you see and playtest browser games. After changing a web game's animation, input, layout or performance, run the matching tool and look at the returned images before saying it works: frames for motion, play for flows, monkey for crashes, devices for phone layouts, perf for smoothness. Runs are deterministic, so compare a frames run before and after a change.";

export async function runMcpServer(version: string): Promise<void> {
  // stdout belongs to the protocol; anything else printed there would corrupt it.
  console.log = (...args: unknown[]) => console.error(...args);
  const write = (message: unknown): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();

  for await (const line of lines) {
    if (!line.trim()) continue;
    let request: Request;
    try {
      request = JSON.parse(line) as Request;
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    const task = handle(request, version).then(
      (result) => {
        if (request.id !== undefined && result !== undefined) write({ jsonrpc: "2.0", id: request.id, result });
      },
      (error: unknown) => {
        if (request.id === undefined) return;
        const known = error instanceof RpcError;
        write({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: known ? error.code : -32603, message: error instanceof Error ? error.message : String(error) },
        });
      },
    );
    pending.add(task);
    void task.finally(() => pending.delete(task));
  }
  await Promise.all(pending);
}

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

async function handle(request: Request, version: string): Promise<unknown> {
  switch (request.method) {
    case "initialize": {
      const asked = String(request.params?.protocolVersion ?? "");
      return {
        protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "playproof", title: "playproof", version },
        instructions: INSTRUCTIONS,
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: TOOLS.map((tool) => ({
          ...tool,
          annotations: { title: tool.title, readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        })),
      };
    case "tools/call":
      return callTool(String(request.params?.name ?? ""), (request.params?.arguments ?? {}) as Record<string, unknown>);
    default:
      if (request.method.startsWith("notifications/")) return undefined;
      throw new RpcError(-32601, `Method not found: ${request.method}`);
  }
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (!TOOLS.some((tool) => tool.name === name)) throw new RpcError(-32602, `Unknown tool: ${name}`);
  try {
    const result = await runTool(name, args);
    const { run, ...report } = result;
    const { text } = run.finish(report);
    const content: unknown[] = [{ type: "text", text }];
    for (const image of report.images) {
      content.push({ type: "image", data: readFileSync(image.path).toString("base64"), mimeType: "image/png" });
    }
    return { content, isError: false };
  } catch (error) {
    // Tool failures are results, not protocol errors, so the model can read them and adjust.
    return { content: [{ type: "text", text: `playproof ${name} failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

function runTool(name: string, args: Record<string, unknown>): Promise<Report & { run: RunDir }> {
  const text = (key: string): string | undefined => (typeof args[key] === "string" && args[key] ? (args[key] as string) : undefined);
  const target = text("target");
  if (!target) throw new Error('"target" is required');
  const base: CommonOptions = {
    target,
    device: text("device") ? resolveDevice(text("device")!) : DESKTOP,
    area: text("area"),
    waitFor: text("waitFor"),
    ready: text("ready"),
    settleMs: 500,
    timeoutMs: 30000,
    headed: false,
    json: false,
    seed: typeof args.seed === "number" ? args.seed : 1,
    fps: 60,
  };
  const stepList = parseSteps(text("steps") ?? "");
  switch (name) {
    case "frames":
      return captureCommand("frames", {
        ...base,
        steps: stepList,
        filmMs: text("duration") ? parseTime(text("duration")!) : 1000,
        filmFps: typeof args.fps === "number" ? args.fps : undefined,
        maxTiles: 24,
        boxes: true,
        fullView: false,
        realtime: false,
        saveFrames: false,
        compare: text("compare"),
        zoom: text("zoom") ? parseZoom(text("zoom")!) : undefined,
      });
    case "play":
      if (!stepList.length) throw new Error('"steps" is required for play');
      return captureCommand("play", { ...base, steps: stepList, maxTiles: 24, boxes: true, fullView: false, realtime: false, saveFrames: false });
    case "monkey":
      return monkeyCommand({
        ...base,
        steps: typeof args.actions === "number" ? args.actions : 300,
        keys: ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " ", "Enter", "w", "a", "s", "d", "z", "x"],
        background: true,
        realtime: false,
        keepGoing: false,
      });
    case "devices":
      return devicesCommand({
        ...base,
        devices: Array.isArray(args.devices) ? args.devices.map(String) : [],
        steps: stepList,
      });
    default:
      return perfCommand({
        ...base,
        durationMs: text("duration") ? parseTime(text("duration")!) : 10000,
        cpu: typeof args.cpu === "number" ? args.cpu : args.android ? 1 : 4,
        steps: stepList,
        monkey: Boolean(args.monkey),
        android: args.android ? true : null,
      });
  }
}
