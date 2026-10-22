// End-to-end: real Chromium, real pages. Needs a browser (node src/cli.ts install-browser, or Chrome/Edge).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { captureCommand } from "../src/commands/capture.ts";
import type { CommonOptions } from "../src/commands/common.ts";
import { devicesCommand } from "../src/commands/devices.ts";
import { monkeyCommand } from "../src/commands/monkey.ts";
import { perfCommand } from "../src/commands/perf.ts";
import { DESKTOP, resolveDevice } from "../src/devices.ts";
import { parseSteps } from "../src/steps.ts";

const scratch = mkdtempSync(join(tmpdir(), "playproof-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let runs = 0;

function common(target: string, extra: Partial<CommonOptions> = {}): CommonOptions {
  return {
    target,
    device: DESKTOP,
    settleMs: 300,
    timeoutMs: 20000,
    headed: false,
    out: join(scratch, `run-${++runs}`),
    json: false,
    seed: 1,
    fps: 60,
    ...extra,
  };
}

const capture = (target: string, steps: string, extra: Partial<Parameters<typeof captureCommand>[1]> = {}) =>
  captureCommand("frames", {
    ...common(target),
    steps: parseSteps(steps),
    filmMs: 1000,
    maxTiles: 24,
    boxes: true,
    fullView: false,
    realtime: false,
    saveFrames: false,
    ...extra,
  });

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

test("frames are identical from run to run", async () => {
  const a = await capture("examples/jumper", "tap @Play; wait 300ms; key Space");
  const b = await capture("examples/jumper", "tap @Play; wait 300ms; key Space");
  assert.equal(sha(a.images[0]!.path), sha(b.images[0]!.path));
  assert.deepEqual(a.findings, []);
});

test("frames catches a teleport and a one-frame flicker", async () => {
  const report = await capture("examples/buggy", "", { device: resolveDevice("Pixel 8"), filmMs: 2000 });
  const titles = report.findings.map((f) => f.title);
  assert.ok(titles.some((t) => /Sudden jump/.test(t)), titles.join("\n"));
  assert.ok(titles.some((t) => /One-frame flicker/.test(t)), titles.join("\n"));
  assert.ok(titles.some((t) => /missing\.png → HTTP 404/.test(t)), titles.join("\n"));
});

test("CSS animations and timers follow the virtual clock exactly", async () => {
  const report = await captureCommand("play", {
    ...common("test/fixtures/css-and-timers.html"),
    steps: parseSteps("js positions(); wait 250ms; js positions()"),
    maxTiles: 24,
    boxes: true,
    fullView: true,
    realtime: false,
    saveFrames: false,
  });
  const log = report.data.log as string[];
  const [before, afterWait] = log.map((line) => JSON.parse(line.slice(line.indexOf("→") + 1)) as { box: number; dot: number });
  // 300 px/s CSS animation and 6 px per 50 ms interval tick.
  assert.equal(Math.round(((afterWait!.box - before!.box + 300) % 300) * 100) / 100, 75);
  assert.equal(afterWait!.dot - before!.dot, 30);
});

test("network loads look instant to the game, so loading is repeatable", async () => {
  const run = () =>
    captureCommand("play", {
      ...common("test/fixtures/loader.html"),
      steps: parseSteps("js window.loadedAt; js window.level.name"),
      maxTiles: 24,
      boxes: true,
      fullView: true,
      realtime: false,
      saveFrames: false,
    });
  const a = await run();
  const b = await run();
  assert.deepEqual(a.data.log, b.data.log);
  assert.match((a.data.log as string[])[1]!, /"first"/);
});

test("play reaches game over with until, and draws a storyboard", async () => {
  const report = await captureCommand("play", {
    ...common("examples/jumper", { device: resolveDevice("Pixel 8") }),
    steps: parseSteps("shot title; tap @Play; until window.playproof.state().screen === 'over' 20s; shot over"),
    maxTiles: 24,
    boxes: true,
    fullView: false,
    realtime: false,
    saveFrames: false,
  });
  assert.deepEqual(report.findings, []);
  assert.ok(report.images.some((image) => image.path.endsWith("storyboard.png")));
});

test("a failing step is reported with where it stopped", async () => {
  const report = await captureCommand("play", {
    ...common("examples/jumper"),
    steps: parseSteps("tap @Nowhere"),
    maxTiles: 24,
    boxes: true,
    fullView: false,
    realtime: false,
    saveFrames: false,
  });
  assert.match(report.findings[0]!.title, /Step 1 failed \(tap @Nowhere\): no target labelled "Nowhere" \(known: Play\)/);
});

test("monkey finds the crash and the same seed reproduces it", async () => {
  const options = {
    ...common("examples/buggy", { device: resolveDevice("Pixel 8") }),
    steps: 200,
    keys: [],
    background: true,
    realtime: false,
    keepGoing: false,
  };
  const first = await monkeyCommand(options);
  const crash = first.findings.find((f) => /TypeError/.test(f.title));
  assert.ok(crash, first.findings.map((f) => f.title).join("\n"));
  const at = first.data.stoppedAt as number;
  assert.match(crash.detail ?? "", new RegExp(`--steps ${at}\\b`));

  const replay = await monkeyCommand({ ...options, steps: at, out: join(scratch, `run-${++runs}`) });
  assert.equal(replay.data.stoppedAt, at);
});

test("monkey reports a hang instead of hanging", async () => {
  const report = await monkeyCommand({
    ...common("test/fixtures/hang.html"),
    steps: 100,
    keys: [],
    background: false,
    realtime: false,
    keepGoing: false,
    hangMs: 3000,
  });
  assert.ok(report.findings.some((f) => /stopped responding/.test(f.title)), report.findings.map((f) => f.title).join("\n"));
});

test("devices flags the planted layout bugs and stays quiet on a clean game", async () => {
  const devices = ["iPhone 15", "Pixel 8", "Desktop"];
  const buggy = await devicesCommand({ ...common("examples/buggy"), devices, steps: [] });
  const titles = buggy.findings.map((f) => f.title).join("\n");
  for (const pattern of [/meta name="viewport"/, /blurry/, /stretched/, /touch-action: none/, /scrolls vertically/]) {
    assert.match(titles, pattern);
  }
  const clean = await devicesCommand({ ...common("examples/jumper"), devices, steps: [] });
  assert.deepEqual(
    clean.findings.filter((f) => f.severity !== "info"),
    [],
  );
});

test("perf sees a game that blows its frame budget", async () => {
  const report = await perfCommand({
    ...common("test/fixtures/heavy.html"),
    durationMs: 2000,
    cpu: 1,
    steps: [],
    monkey: false,
    android: null,
  });
  assert.ok((report.data.droppedPercent as number) > 30, String(report.data.droppedPercent));
  // Local measurements can warn but never fail a run.
  assert.ok(report.findings.every((f) => f.severity !== "error"));
});

test("the CLI prints a summary and exits 1 when it finds errors", () => {
  const result = spawnSync(
    process.execPath,
    ["src/cli.ts", "frames", "examples/buggy", "--duration", "200ms", "--out", join(scratch, "cli")],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /^playproof frames: 1 error/);
  assert.match(result.stdout, /image {3}.*frames\.png/);

  const usage = spawnSync(process.execPath, ["src/cli.ts", "frames"], { encoding: "utf8" });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /Missing <target>/);
});

test("frames writes an onion skin, and --compare tells identical runs from changed ones", async () => {
  const first = await capture("examples/jumper", "tap @Play; wait 300ms; key Space");
  assert.ok(first.images.some((image) => image.path.endsWith("onion.png")));
  const previous = first.run.dir;

  const same = await capture("examples/jumper", "tap @Play; wait 300ms; key Space", { compare: previous });
  assert.match(same.findings.find((f) => f.title.startsWith("compare:"))!.title, /identical/);

  const changed = await capture("examples/jumper", "tap @Play; wait 300ms", { compare: previous });
  assert.match(changed.findings.find((f) => f.title.startsWith("compare:"))!.title, /differ from the earlier run/);
});

test("the MCP server lists tools and returns images", async () => {
  const { spawn } = await import("node:child_process");
  const server = spawn(process.execPath, ["src/cli.ts", "mcp"], { stdio: ["pipe", "pipe", "inherit"] });
  const replies = new Map<number, Record<string, unknown>>();
  let buffer = "";
  server.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const message = JSON.parse(buffer.slice(0, at)) as { id: number };
      buffer = buffer.slice(at + 1);
      replies.set(message.id, message);
    }
  });
  const call = async (id: number, method: string, params: Record<string, unknown> = {}) => {
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    for (let waited = 0; !replies.has(id); waited += 50) {
      if (waited > 120000) throw new Error(`no reply to ${method}`);
      await new Promise((done) => setTimeout(done, 50));
    }
    return replies.get(id)!.result as Record<string, unknown>;
  };
  try {
    const init = await call(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    assert.equal(init.protocolVersion, "2025-06-18");
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const list = await call(2, "tools/list");
    assert.deepEqual(
      (list.tools as { name: string }[]).map((t) => t.name),
      ["frames", "play", "monkey", "devices", "perf"],
    );
    const result = await call(3, "tools/call", {
      name: "frames",
      arguments: { target: "examples/jumper", duration: "200ms", steps: "tap @Play" },
    });
    const content = result.content as { type: string; text?: string; mimeType?: string }[];
    assert.equal(result.isError, false);
    assert.match(content[0]!.text!, /^playproof frames:/);
    assert.equal(content.filter((c) => c.type === "image" && c.mimeType === "image/png").length, 2);
  } finally {
    server.kill();
    rmSync(".playproof", { recursive: true, force: true });
  }
});

test("--zoom auto crops to where the motion is", async () => {
  const report = await capture("examples/jumper", "tap @Play; wait 300ms; key Space; js window.playproof.state().screen", {
    device: resolveDevice("Pixel 8"),
    filmMs: 500,
    zoom: "auto",
  });
  assert.match((report.log ?? []).join("\n"), /"playing"/);
  const zoom = (report.data.films as { zoom: { width: number; height: number } | null }[])[0]!.zoom;
  assert.ok(zoom && zoom.width < 0.5 && zoom.height < 0.5, JSON.stringify(zoom));
});
