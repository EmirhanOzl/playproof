import assert from "node:assert/strict";
import { test } from "node:test";
import { computeStats, perfFindings } from "../src/commands/perf.ts";
import { findMotionIssues } from "../src/motion.ts";

const FRAME = 1000 / 60;

function motion(diffs: number[], skips?: number[]) {
  return { diffs, skips: skips ?? diffs.map(() => -1), boxes: diffs.map(() => null) };
}

test("smooth motion has no findings", () => {
  assert.deepEqual(findMotionIssues(motion(Array(30).fill(0.4)), FRAME), []);
});

test("nothing moving is reported once", () => {
  const findings = findMotionIssues(motion(Array(30).fill(0)), FRAME);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.kind, "still");
});

test("an isolated spike is a sudden jump", () => {
  const diffs = Array(30).fill(0.3);
  diffs[12] = 4;
  const findings = findMotionIssues(motion(diffs), FRAME);
  assert.deepEqual(
    findings.map((f) => [f.kind, f.frame]),
    [["pop", 12]],
  );
  assert.match(findings[0]!.message, /frame 13 \(217 ms\)/);
});

test("a frame unlike both matching neighbours is flicker, not a jump", () => {
  const diffs = Array(30).fill(0.3);
  diffs[10] = 20;
  diffs[11] = 20;
  const skips = diffs.map(() => 0.6);
  skips[10] = 0.3;
  const findings = findMotionIssues(motion(diffs, skips), FRAME);
  assert.deepEqual(
    findings.map((f) => [f.kind, f.frame]),
    [["flicker", 10]],
  );
});

test("a still stretch between moving parts is a hold", () => {
  const diffs = [...Array(10).fill(0.5), ...Array(20).fill(0), ...Array(10).fill(0.5)];
  const findings = findMotionIssues(motion(diffs), FRAME);
  assert.deepEqual(
    findings.map((f) => [f.kind, f.frame, f.endFrame]),
    [["hold", 10, 29]],
  );
});

test("perf stats find the refresh rate and dropped frames", () => {
  const intervals = [...Array(90).fill(16.7), ...Array(10).fill(50)];
  const stats = computeStats({ intervals, longTasks: [{ start: 100, duration: 180 }], durationMs: 2000 });
  assert.equal(stats.refreshHz, 60);
  assert.equal(stats.frames, 100);
  assert.equal(stats.slowFrames, 10);
  // 10 frames of 50 ms each hide 2 frames: 20 of 120 expected frames dropped.
  assert.equal(stats.droppedPercent, 16.7);
  assert.equal(stats.worstLongTaskMs, 180);

  const local = perfFindings(stats, 10, 12, true);
  assert.equal(local.find((f) => /dropped/.test(f.title))!.severity, "warning");
  const phone = perfFindings(stats, 10, 12, false);
  assert.equal(phone.find((f) => /dropped/.test(f.title))!.severity, "error");
  assert.ok(phone.some((f) => /long main-thread task/.test(f.title)));
});

test("a game that never makes vsync is still judged against 60 Hz", () => {
  const intervals = Array.from({ length: 60 }, (_, i) => (i % 2 ? 33.3 : 50));
  const stats = computeStats({ intervals, longTasks: [], durationMs: 2500 });
  assert.equal(stats.refreshHz, 60);
  assert.ok(stats.droppedPercent > 50);
});

test("120 Hz screens are judged against an 8.3 ms budget", () => {
  const stats = computeStats({ intervals: Array(200).fill(8.33), longTasks: [], durationMs: 1666 });
  assert.equal(stats.refreshHz, 120);
  assert.equal(stats.droppedPercent, 0);
});
