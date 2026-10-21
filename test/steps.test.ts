import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSteps, parseTime } from "../src/steps.ts";
import { UsageError } from "../src/target.ts";

test("parses a one-line script", () => {
  const steps = parseSteps("tap 50%,80%; wait 300ms; key Space; drag 10%,50% 90%,50% 0.4s; shot after jump; film 1s 30");
  assert.deepEqual(
    steps.map((s) => s.kind),
    ["tap", "wait", "key", "drag", "shot", "film"],
  );
  assert.deepEqual(steps[0], { kind: "tap", at: { x: 50, y: 80, xPercent: true, yPercent: true }, source: "tap 50%,80%" });
  assert.equal(steps[1]!.kind === "wait" && steps[1]!.ms, 300);
  assert.equal(steps[2]!.kind === "key" && steps[2]!.key, " ");
  assert.equal(steps[3]!.kind === "drag" && steps[3]!.ms, 400);
  assert.equal(steps[4]!.kind === "shot" && steps[4]!.label, "after jump");
  assert.deepEqual(steps[5]!.kind === "film" && [steps[5]!.ms, steps[5]!.fps], [1000, 30]);
});

test("pixel points, labels and defaults", () => {
  const [tap, labelled, key, drag] = parseSteps("tap 120,300\ntap @Play\nkey left\ndrag 0,0 10,10");
  assert.deepEqual(tap!.kind === "tap" && tap!.at, { x: 120, y: 300, xPercent: false, yPercent: false });
  assert.equal(labelled!.kind === "tap" && labelled!.at.label, "Play");
  assert.equal(key!.kind === "key" && key!.key, "ArrowLeft");
  assert.equal(key!.kind === "key" && key!.ms, 50);
  assert.equal(drag!.kind === "drag" && drag!.ms, 300);
});

test("comments, blank lines and semicolons inside code", () => {
  const steps = parseSteps("# set up\n\nclick #start\njs (() => { a(); b(); })()\nuntil window.game.state === 'won' 2s");
  assert.equal(steps.length, 3);
  assert.equal(steps[0]!.kind === "click" && steps[0]!.selector, "#start");
  assert.equal(steps[1]!.kind === "js" && steps[1]!.expression, "(() => { a(); b(); })()");
  assert.deepEqual(steps[2]!.kind === "until" && [steps[2]!.expression, steps[2]!.ms], ["window.game.state === 'won'", 2000]);
});

test("until without a time waits 5 s", () => {
  const [until] = parseSteps("until window.done");
  assert.deepEqual(until!.kind === "until" && [until!.expression, until!.ms], ["window.done", 5000]);
});

test("bad steps explain themselves", () => {
  assert.throws(() => parseSteps("tap 50%"), (e: unknown) => e instanceof UsageError && /not a point/.test(e.message));
  assert.throws(() => parseSteps("hop 1,2"), (e: unknown) => e instanceof UsageError && /unknown step "hop"/.test(e.message));
  assert.throws(() => parseSteps("wait soon"), (e: unknown) => e instanceof UsageError && /not a time/.test(e.message));
});

test("times", () => {
  assert.equal(parseTime("250"), 250);
  assert.equal(parseTime("250ms"), 250);
  assert.equal(parseTime("1.5s"), 1500);
});
