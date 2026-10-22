import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { describeDevice, resolveDevice } from "../devices.ts";
import { RunDir, type Finding, type Report, type ReportImage } from "../report.ts";
import { loadSteps, parseTime } from "../steps.ts";
import { UsageError } from "../target.ts";
import { captureCommand } from "./capture.ts";
import { parseZoom, type CommonOptions } from "./common.ts";
import { devicesCommand } from "./devices.ts";
import { monkeyCommand } from "./monkey.ts";
import { perfCommand } from "./perf.ts";

export interface CheckOptions extends CommonOptions {
  config: Config;
  // Accept the current motion as the new baseline instead of comparing with the old one.
  update: boolean;
  only: string[] | null;
}

const KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " ", "Enter", "w", "a", "s", "d", "z", "x"];

// Everything a game should pass before a change ships: every scenario filmed and compared with its baseline (a
// snapshot test for motion), then random play and the device matrix. Baselines are kept per platform, because
// fonts and anti-aliasing differ between operating systems.
export async function checkCommand(options: CheckOptions): Promise<Report & { run: RunDir }> {
  const { config } = options;
  const run = RunDir.create("check", options.out);
  // --only takes scenario names and the parts "monkey", "devices" and "perf".
  const parts = ["monkey", "devices", "perf"];
  const wanted = (name: string): boolean => !options.only || options.only.includes(name);
  const names = Object.keys(config.scenarios).filter(wanted);
  if (options.only) {
    const unknown = options.only.filter((name) => !config.scenarios[name] && !parts.includes(name));
    if (unknown.length) throw new UsageError(`Unknown scenario${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")} (known: ${[...Object.keys(config.scenarios), ...parts].join(", ")})`);
  }
  const platformBaselines = join(config.baselines, process.platform);
  const images: ReportImage[] = [];
  const findings: Finding[] = [];
  const log: string[] = [];
  const scenarioData: Record<string, unknown>[] = [];
  let target = options.target;

  for (const name of names) {
    const scenario = config.scenarios[name]!;
    const baseline = join(platformBaselines, name);
    const hasBaseline = existsSync(join(baseline, "tiles"));
    const sub = await captureCommand("frames", {
      ...options,
      device: scenario.device ? resolveDevice(scenario.device) : options.device,
      out: join(run.dir, "scenarios", name),
      steps: loadSteps(scenario.do, scenario.script),
      filmMs: scenario.duration ? parseTime(scenario.duration) : 1000,
      filmFps: scenario.fps,
      maxTiles: 24,
      boxes: true,
      fullView: false,
      realtime: false,
      saveFrames: false,
      compare: hasBaseline && !options.update ? baseline : undefined,
      zoom: scenario.zoom ? parseZoom(scenario.zoom) : undefined,
    });
    const { run: subRun, ...subReport } = sub;
    subRun.finish(subReport);
    target = sub.target;
    findings.push(...sub.findings.filter((f) => f.severity !== "info" || !f.title.startsWith("compare:")).map((f) => ({ ...f, title: `[${name}] ${f.title}` })));

    const film = (sub.data.films as { compare?: { differing: number; compared: number } }[])[0];
    let status: string;
    if (options.update || !hasBaseline) {
      rmSync(baseline, { recursive: true, force: true });
      cpSync(join(subRun.dir, "tiles"), join(baseline, "tiles"), { recursive: true });
      cpSync(join(subRun.dir, "report.json"), join(baseline, "report.json"));
      status = hasBaseline ? "baseline updated" : "new baseline written";
      findings.push({ severity: "info", title: `[${name}] ${status}: ${baseline}` });
    } else if (film?.compare && film.compare.differing > 0) {
      status = `${film.compare.differing} of ${film.compare.compared} frames changed`;
      findings.push({
        severity: "error",
        title: `[${name}] motion changed from the baseline: ${status}. Look at compare.png; if the change is intended, accept it with playproof check --update${options.only ? ` --only ${name}` : ""}.`,
      });
    } else {
      status = "identical to the baseline";
    }
    log.push(`${name}: ${status}`);
    const picture = sub.images.find((image) => image.path.endsWith("compare.png")) ?? sub.images.find((image) => image.path.endsWith("frames.png"));
    if (picture) images.push({ label: `${name}: ${status}`, path: picture.path });
    scenarioData.push({ name, status, baseline, ...film });
  }

  const part = async (label: string, produce: () => Promise<Report & { run: RunDir }>): Promise<void> => {
    const sub = await produce();
    const { run: subRun, ...subReport } = sub;
    subRun.finish(subReport);
    target = sub.target;
    findings.push(...sub.findings.map((f) => ({ ...f, title: `[${label}] ${f.title}` })));
    images.push(...sub.images.map((image) => ({ ...image, label: `${label}: ${image.label}` })));
    const counts = ["error", "warning"].map((s) => sub.findings.filter((f) => f.severity === s).length);
    log.push(`${label}: ${counts[0]} errors, ${counts[1]} warnings`);
  };

  const { monkey, devices, perf } = config.check;
  if (monkey !== false && wanted("monkey")) {
    await part("monkey", () =>
      monkeyCommand({
        ...options,
        out: join(run.dir, "monkey"),
        steps: monkey?.steps ?? 200,
        seed: monkey?.seed ?? options.seed,
        keys: KEYS,
        background: true,
        realtime: false,
        keepGoing: false,
      }),
    );
  }
  if (devices !== false && wanted("devices")) {
    await part("devices", () =>
      devicesCommand({
        ...options,
        out: join(run.dir, "devices"),
        devices: typeof devices === "object" && devices.devices ? devices.devices : [],
        steps: [],
      }),
    );
  }
  if (perf && wanted("perf")) {
    await part("perf", () =>
      perfCommand({
        ...options,
        out: join(run.dir, "perf"),
        durationMs: perf.duration ? parseTime(perf.duration) : 5000,
        cpu: perf.cpu ?? 4,
        steps: [],
        monkey: true,
        android: null,
      }),
    );
  }
  if (!names.length && monkey === false && devices === false && !perf) {
    throw new UsageError(`Nothing to check: ${config.path} has no scenarios, and monkey and devices are turned off.`);
  }

  return {
    command: "check",
    target,
    device: describeDevice(options.device),
    images,
    findings,
    log,
    data: { config: config.path, baselines: platformBaselines, scenarios: scenarioData, updated: options.update },
    run,
  };
}
