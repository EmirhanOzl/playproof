import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { UsageError } from "./target.ts";

// playproof.config.json: the game's defaults and named scenarios, so agents and CI do not repeat long step lists.
//
// {
//   "target": "http://localhost:5173",
//   "device": "Pixel 8",
//   "ready": "window.game?.loaded",
//   "scenarios": {
//     "jump": { "do": "tap @Play; wait 300ms; key Space", "duration": "700ms", "zoom": "auto" }
//   },
//   "check": { "monkey": { "steps": 200 }, "devices": true }
// }

export const CONFIG_FILE = "playproof.config.json";

export interface Scenario {
  do?: string;
  script?: string;
  duration?: string;
  fps?: number;
  zoom?: string;
  device?: string;
}

export interface CheckConfig {
  monkey?: false | { steps?: number; seed?: number };
  devices?: boolean | { devices?: string[] };
  perf?: false | { duration?: string; cpu?: number };
}

export interface Config {
  path: string;
  dir: string;
  target?: string;
  device?: string;
  area?: string;
  ready?: string;
  waitFor?: string;
  settle?: string;
  timeout?: string;
  seed?: number | "off";
  baselines: string;
  scenarios: Record<string, Scenario>;
  check: CheckConfig;
}

const TOP_KEYS = ["$schema", "target", "device", "area", "ready", "waitFor", "settle", "timeout", "seed", "baselines", "scenarios", "check"];
const SCENARIO_KEYS = ["do", "script", "duration", "fps", "zoom", "device"];

// Explicit path, else playproof.config.json in the current directory or the nearest parent (stopping at a git root).
export function loadConfig(explicit: string | undefined): Config | null {
  const path = explicit ? resolve(explicit) : findConfig(process.cwd());
  if (!path) return null;
  if (!existsSync(path)) throw new UsageError(`Config file not found: ${path}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new UsageError(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validate(raw, path);
}

function findConfig(start: string): string | null {
  for (let dir = start; ; dir = dirname(dir)) {
    const candidate = join(dir, CONFIG_FILE);
    if (existsSync(candidate)) return candidate;
    if (existsSync(join(dir, ".git")) || dirname(dir) === dir) return null;
  }
}

function validate(raw: unknown, path: string): Config {
  const fail = (why: string): never => {
    throw new UsageError(`${path}: ${why}`);
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("expected a JSON object");
  const data = raw as Record<string, unknown>;
  for (const key of Object.keys(data)) if (!TOP_KEYS.includes(key)) fail(`unknown key "${key}" (allowed: ${TOP_KEYS.slice(1).join(", ")})`);
  const text = (key: string, value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "string") fail(`"${key}" must be a string`);
    return value as string;
  };
  const dir = dirname(path);

  const scenarios: Record<string, Scenario> = {};
  if (data.scenarios !== undefined) {
    if (!data.scenarios || typeof data.scenarios !== "object" || Array.isArray(data.scenarios)) fail('"scenarios" must be an object of name → scenario');
    for (const [name, value] of Object.entries(data.scenarios as Record<string, unknown>)) {
      if (!/^[\w.-]+$/.test(name)) fail(`scenario name "${name}" may only use letters, digits, ".", "_" and "-"`);
      if (!value || typeof value !== "object" || Array.isArray(value)) fail(`scenario "${name}" must be an object`);
      const s = value as Record<string, unknown>;
      for (const key of Object.keys(s)) if (!SCENARIO_KEYS.includes(key)) fail(`scenario "${name}": unknown key "${key}" (allowed: ${SCENARIO_KEYS.join(", ")})`);
      if (s.fps !== undefined && (typeof s.fps !== "number" || s.fps <= 0)) fail(`scenario "${name}": "fps" must be a positive number`);
      scenarios[name] = {
        do: text(`scenarios.${name}.do`, s.do),
        script: s.script === undefined ? undefined : resolve(dir, text(`scenarios.${name}.script`, s.script)!),
        duration: text(`scenarios.${name}.duration`, s.duration),
        fps: s.fps as number | undefined,
        zoom: text(`scenarios.${name}.zoom`, s.zoom),
        device: text(`scenarios.${name}.device`, s.device),
      };
    }
  }

  const check = (data.check ?? {}) as CheckConfig;
  if (typeof check !== "object" || Array.isArray(check)) fail('"check" must be an object');
  if (data.seed !== undefined && data.seed !== "off" && !Number.isInteger(data.seed)) fail('"seed" must be a whole number or "off"');

  // A target that is not a URL is a path relative to the config file.
  const target = text("target", data.target);
  return {
    path,
    dir,
    target: target && !/^https?:\/\//i.test(target) ? resolve(dir, target) : target,
    device: text("device", data.device),
    area: text("area", data.area),
    ready: text("ready", data.ready),
    waitFor: text("waitFor", data.waitFor),
    settle: text("settle", data.settle),
    timeout: text("timeout", data.timeout),
    seed: data.seed as number | "off" | undefined,
    baselines: resolve(dir, text("baselines", data.baselines) ?? "playproof-baselines"),
    scenarios,
    check,
  };
}

export function scenarioOf(config: Config | null, name: string): Scenario {
  const scenario = config?.scenarios[name];
  if (!scenario) {
    const known = Object.keys(config?.scenarios ?? {});
    throw new UsageError(
      config
        ? `No scenario "${name}" in ${config.path}${known.length ? ` (known: ${known.join(", ")})` : ""}`
        : `--scenario needs a ${CONFIG_FILE} with a "scenarios" section`,
    );
  }
  return scenario;
}
