#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { captureCommand } from "./commands/capture.ts";
import { checkCommand } from "./commands/check.ts";
import { CONFIG_FILE, loadConfig, scenarioOf, type Scenario } from "./config.ts";
import { parseZoom, type CommonOptions } from "./commands/common.ts";
import { devicesCommand } from "./commands/devices.ts";
import { monkeyCommand } from "./commands/monkey.ts";
import { perfCommand } from "./commands/perf.ts";
import { skillCommand } from "./commands/skill.ts";
import { runMcpServer } from "./mcp.ts";
import { DESKTOP, resolveDevice } from "./devices.ts";
import type { Report } from "./report.ts";
import type { RunDir } from "./report.ts";
import { loadSteps, parseTime, STEP_HELP } from "./steps.ts";
import { UsageError } from "./target.ts";

const HELP = `playproof: eyes and hands for browser games

Usage: playproof <command> <target> [options]
  <target> is a URL (http://localhost:5173), a folder (./dist) or an HTML file (./game.html).
  It can be left out when ${CONFIG_FILE} sets "target".

Commands
  frames <target>    Film the game frame by frame on a virtual clock and lay the frames out as a contact sheet,
                     with motion analysis (sudden jumps, one-frame flicker, stalls).
  play <target>      Run a script of taps, drags, keys and waits; get a storyboard of shots and films.
  monkey <target>    Random play that hunts for crashes, hangs and soft-locks; repeatable by seed.
  check [target]     Film every scenario in ${CONFIG_FILE} and compare it with its baseline (a snapshot
                     test for motion), then run monkey and devices. --update accepts the current motion.
  devices <target>   Load the game on phones, a tablet and a desktop; screenshot each and check the layout
                     (blurry canvas, stretching, overflow, scrolling, touch-action, clipped text).
  perf <target>      Measure real frame pacing (fps, p95/p99, dropped frames, long tasks), locally or on a
                     USB-connected Android phone with --android.
  skill install      Install the agent skill for Claude Code, Codex, Cursor, Gemini CLI and OpenCode.
  mcp                Run as an MCP server over stdio (for Claude Desktop and other MCP clients); tools
                     return the images directly.
  install-browser    Download the Chromium build this version of playproof is tested with
                     (optional: an installed Chrome or Edge is used when it is missing).

Common options
  --scenario <name>    Use a scenario from ${CONFIG_FILE} (its steps, duration, zoom, device)
  --config <path>      Config file (default: ${CONFIG_FILE} here or in a parent folder)
  --device <name>      Playwright device name ("iPhone 15", "Pixel 8"), "desktop", or 390x844@3 [mobile]
                       (default: desktop 1280x720)
  --area <selector>    Element that is the game area (default: the largest visible canvas)
  --wait-for <sel>     Wait for this element to be visible before starting
  --ready <js>         Wait until this expression is truthy (e.g. "window.game?.loaded")
  --settle <time>      Extra wait after loading (default 500ms)
  --timeout <time>     Load timeout (default 30s)
  --seed <n|off>       Seed for Math.random so runs repeat (default 1)
  --out <dir>          Where to write images and report.json (default .playproof/<time>-<command>)
  --json               Print report.json instead of the text summary
  --browser <name>     chromium | chrome | msedge | path to a Chromium-based browser
  --headed             Show the browser window
  --port <n>           Port for the built-in static server (folder/file targets)

frames
  --do <steps>         Steps to run before filming (e.g. "tap 50%,80%" to trigger a jump)
  --script <file>      Steps from a file
  --duration <time>    How long to film (default 1s)
  --fps <n>            Tiles per second on the sheet (default: chosen to fit --max-tiles)
  --max-tiles <n>      Upper bound on tiles when --fps is not given (default 24)
  --full               Film the whole viewport instead of the game area
  --no-boxes           Do not outline what changed between tiles
  --save-frames        Also write every frame as a PNG
  --animate            Also write the film as an animated PNG at real speed (for people and pull requests)
  --compare <dir>      Compare with an earlier frames run (its output folder), frame by frame
  --zoom <auto|x,y,w,h> Crop to what moves (auto) or to a region in percent of the game area,
                       captured at full device resolution

play
  --do <steps> | --script <file>   The script (see Steps below)
  --realtime           Run in real time instead of on the virtual clock
  --full               Screenshot the whole viewport instead of the game area

monkey
  --steps <n>          Number of random actions (default 300)
  --keys <list|none>   Keys to press, comma separated (default: arrows, Space, Enter, w,a,s,d, z,x)
  --no-background      Never send the tab to the background
  --keep-going         Continue after the first uncaught error
  --realtime           Real time instead of the virtual clock (slower, not repeatable)

devices
  --devices <list>     Comma-separated device names (default: 9 phones, tablet and desktop)
  --do <steps>         Steps to run on every device before the screenshot (e.g. open a menu)

perf
  --duration <time>    How long to measure (default 10s)
  --cpu <n>            Slow the CPU n times to approximate a phone (default 4; 1 = off)
  --do <steps>         Play this script while measuring
  --monkey             Tap randomly while measuring
  --android            Measure in Chrome on a USB-connected Android phone instead
  --serial <id>        Which phone, when several are connected (see adb devices)

check
  --update             Accept the current motion as the new baselines
  --only <names>       Only these scenarios and/or parts (monkey, devices, perf), comma separated

skill
  playproof skill install [--project] [--agent claude|agents|all]
  playproof skill print | path

${STEP_HELP}

Exit code: 0 = no errors found, 1 = errors found, 2 = playproof itself could not run.`;

const OPTIONS = {
  device: { type: "string" },
  area: { type: "string" },
  "wait-for": { type: "string" },
  ready: { type: "string" },
  settle: { type: "string" },
  timeout: { type: "string" },
  seed: { type: "string" },
  out: { type: "string" },
  json: { type: "boolean" },
  browser: { type: "string" },
  headed: { type: "boolean" },
  port: { type: "string" },
  do: { type: "string" },
  script: { type: "string" },
  duration: { type: "string" },
  fps: { type: "string" },
  "max-tiles": { type: "string" },
  full: { type: "boolean" },
  boxes: { type: "boolean", default: true },
  "save-frames": { type: "boolean" },
  realtime: { type: "boolean" },
  steps: { type: "string" },
  keys: { type: "string" },
  background: { type: "boolean", default: true },
  "keep-going": { type: "boolean" },
  devices: { type: "string" },
  compare: { type: "string" },
  scenario: { type: "string" },
  animate: { type: "boolean" },
  config: { type: "string" },
  update: { type: "boolean" },
  only: { type: "string" },
  zoom: { type: "string" },
  cpu: { type: "string" },
  monkey: { type: "boolean" },
  android: { type: "boolean" },
  serial: { type: "string" },
  project: { type: "boolean" },
  agent: { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} satisfies ParseArgsConfig["options"];

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "install-browser") {
    // Playwright's own installer, from the playwright-core version playproof depends on, so the revisions match.
    // Its flags (--with-deps, --force) pass straight through.
    const installer = join(dirname(createRequire(import.meta.url).resolve("playwright-core/package.json")), "cli.js");
    return spawnSync(process.execPath, [installer, "install", "chromium", ...argv.slice(1)], { stdio: "inherit" }).status ?? 2;
  }
  const { values: v, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, allowNegative: true, strict: true });

  if (v.version) {
    console.log(version());
    return 0;
  }
  const [command, ...rest] = positionals;
  if (v.help || !command) {
    console.log(HELP);
    return command || v.help ? 0 : 2;
  }

  if (command === "mcp") {
    await runMcpServer(version());
    return 0;
  }
  if (command === "skill") {
    console.log(skillCommand(rest, { project: Boolean(v.project), agent: v.agent }));
    return 0;
  }
  if (!["frames", "play", "monkey", "devices", "perf", "check"].includes(command)) {
    throw new UsageError(`Unknown command "${command}". Run playproof --help.`);
  }
  // Precedence: command line, then the scenario, then the config file, then built-in defaults.
  const config = loadConfig(v.config);
  const scenario: Scenario = v.scenario ? scenarioOf(config, v.scenario) : {};
  const target = rest[0] ?? config?.target;
  if (!target) {
    throw new UsageError(`Missing <target>. Example: playproof ${command} http://localhost:5173 (or set "target" in ${CONFIG_FILE})`);
  }
  if (rest.length > 1) throw new UsageError(`Unexpected argument "${rest[1]}". Quote step lists: --do "tap 50%,50%; wait 1s"`);
  const deviceName = v.device ?? scenario.device ?? config?.device;
  const seed = v.seed ?? (config?.seed === undefined ? undefined : String(config.seed));
  const settle = v.settle ?? config?.settle;
  const timeout = v.timeout ?? config?.timeout;

  const common: CommonOptions = {
    target,
    device: deviceName ? resolveDevice(deviceName) : DESKTOP,
    area: v.area ?? config?.area,
    waitFor: v["wait-for"] ?? config?.waitFor,
    ready: v.ready ?? config?.ready,
    settleMs: settle ? parseTime(settle) : 500,
    timeoutMs: timeout ? parseTime(timeout) : 30000,
    browser: v.browser,
    headed: Boolean(v.headed),
    out: v.out,
    json: Boolean(v.json),
    seed: seed === "off" ? null : seed ? integer(seed, "--seed") : 1,
    port: v.port ? integer(v.port, "--port") : undefined,
    fps: 60,
  };
  const steps = () => (v.do || v.script ? loadSteps(v.do, v.script) : loadSteps(scenario.do, scenario.script));
  const zoom = v.zoom ?? scenario.zoom;
  const duration = v.duration ?? scenario.duration;

  let result: Report & { run: RunDir };
  switch (command) {
    case "frames":
      result = await captureCommand("frames", {
        ...common,
        steps: steps(),
        filmMs: duration ? parseTime(duration) : 1000,
        filmFps: v.fps ? positive(v.fps, "--fps") : scenario.fps,
        maxTiles: v["max-tiles"] ? integer(v["max-tiles"], "--max-tiles") : 24,
        boxes: v.boxes !== false,
        fullView: Boolean(v.full),
        realtime: false,
        saveFrames: Boolean(v["save-frames"]),
        compare: v.compare,
        zoom: zoom ? parseZoom(zoom) : undefined,
        animate: Boolean(v.animate),
      });
      break;
    case "play": {
      const list = steps();
      if (!list.length) throw new UsageError('play needs steps: --do "tap 50%,80%; wait 500ms; shot" or --script file.txt');
      result = await captureCommand("play", {
        ...common,
        steps: list,
        maxTiles: 24,
        boxes: true,
        fullView: Boolean(v.full),
        realtime: Boolean(v.realtime),
        saveFrames: false,
        zoom: zoom ? parseZoom(zoom) : undefined,
        animate: Boolean(v.animate),
      });
      break;
    }
    case "check":
      if (!config) throw new UsageError(`check needs a ${CONFIG_FILE} with scenarios (see playproof --help).`);
      result = await checkCommand({
        ...common,
        config,
        update: Boolean(v.update),
        only: v.only ? v.only.split(",").map((name) => name.trim()).filter(Boolean) : null,
      });
      break;
    case "monkey":
      result = await monkeyCommand({
        ...common,
        steps: v.steps ? integer(v.steps, "--steps") : 300,
        keys: (v.keys ?? DEFAULT_KEYS) === "none" ? [] : (v.keys ?? DEFAULT_KEYS).split(",").map((key) => key.trim()).filter(Boolean).map(keyName),
        background: v.background !== false,
        realtime: Boolean(v.realtime),
        keepGoing: Boolean(v["keep-going"]),
      });
      break;
    case "devices":
      result = await devicesCommand({
        ...common,
        devices: v.devices ? v.devices.split(",").map((name) => name.trim()).filter(Boolean) : [],
        steps: steps(),
      });
      break;
    default:
      result = await perfCommand({
        ...common,
        durationMs: duration ? parseTime(duration) : 10000,
        cpu: v.cpu ? positive(v.cpu, "--cpu") : v.android ? 1 : 4,
        steps: steps(),
        monkey: Boolean(v.monkey),
        android: v.android ? (v.serial ?? true) : null,
      });
  }

  const { run, ...report } = result;
  const { text, exitCode } = run.finish(report);
  console.log(common.json ? JSON.stringify({ ...report, dir: run.dir }, null, 2) : text);
  return exitCode;
}

const DEFAULT_KEYS = "ArrowLeft,ArrowRight,ArrowUp,ArrowDown,Space,Enter,w,a,s,d,z,x";

function keyName(key: string): string {
  return key.toLowerCase() === "space" ? " " : key;
}

function integer(text: string, name: string): number {
  const value = Number(text);
  if (!Number.isInteger(value) || value < 0) throw new UsageError(`${name} must be a whole number, got "${text}"`);
  return value;
}

function positive(text: string, name: string): number {
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) throw new UsageError(`${name} must be a positive number, got "${text}"`);
  return value;
}

function version(): string {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  return (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof UsageError || String((error as { code?: unknown })?.code ?? "").startsWith("ERR_PARSE_ARGS")) {
      console.error(`playproof: ${(error as Error).message}`);
    } else {
      console.error(`playproof failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    }
    process.exitCode = 2;
  },
);
