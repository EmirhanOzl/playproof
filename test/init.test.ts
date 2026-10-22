import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { guessTarget, initCommand } from "../src/commands/init.ts";

const root = mkdtempSync(join(tmpdir(), "playproof-init-"));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const project = (files: Record<string, string>): string => {
  const dir = join(root, String(++n));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
};

test("a plain HTML game is served from its folder", () => {
  assert.equal(guessTarget(project({ "index.html": "<canvas>" })).target, ".");
});

test("a Vite project points at the dev server", () => {
  const dir = project({ "package.json": JSON.stringify({ devDependencies: { vite: "^7" } }), "index.html": "" });
  assert.equal(guessTarget(dir).target, "http://localhost:5173");
});

test("a build folder is used when there is no dev server", () => {
  const dir = project({ "package.json": JSON.stringify({ dependencies: { phaser: "^3" } }), "dist/index.html": "" });
  assert.equal(guessTarget(dir).target, "./dist");
});

test("init writes a config once and never overwrites it without --force", () => {
  const dir = project({ "index.html": "" });
  assert.equal(initCommand(dir, undefined, false).written, true);
  writeFileSync(join(dir, "playproof.config.json"), '{"target":"mine"}');
  assert.equal(initCommand(dir, undefined, false).written, false);
  assert.equal(readFileSync(join(dir, "playproof.config.json"), "utf8"), '{"target":"mine"}');
  assert.equal(initCommand(dir, "http://localhost:9000", true).written, true);
  assert.match(readFileSync(join(dir, "playproof.config.json"), "utf8"), /localhost:9000/);
});
