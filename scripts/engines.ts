// Determinism across real engines: films each one twice and compares the runs frame by frame.
// Needs network access (engines come from CDNs, Godot and Unity builds from their public demos), so it is not
// part of npm test. Run: npm run test:engines
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const engines: { name: string; target: string; args: string[] }[] = [
  { name: "Phaser 3", target: "test/engines/phaser.html", args: ["--ready", "window.phaserReady"] },
  { name: "three.js", target: "test/engines/three.html", args: ["--ready", "window.threeReady"] },
  { name: "PixiJS 8", target: "test/engines/pixi.html", args: ["--ready", "window.pixiReady"] },
  { name: "Godot 4 (web export)", target: "https://lab.godotengine.org/godot-dotnet-web/", args: ["--settle", "3s", "--timeout", "120s"] },
  { name: "Unity (WebGL)", target: "https://greggman.github.io/better-unity-webgl-template/", args: ["--settle", "4s", "--timeout", "120s"] },
];

const scratch = mkdtempSync(join(tmpdir(), "playproof-engines-"));
let failures = 0;
for (const engine of engines) {
  const first = join(scratch, `${engine.name}-1`.replace(/\W+/g, "-"));
  const started = Date.now();
  const run = (extra: string[], out: string) =>
    spawnSync(process.execPath, ["src/cli.ts", "frames", engine.target, "--duration", "1s", ...engine.args, ...extra, "--out", out], {
      encoding: "utf8",
    });
  const a = run([], first);
  const b = run(["--compare", first], `${first}-again`);
  const seconds = ((Date.now() - started) / 2000).toFixed(1);
  const verdict = /identical to the earlier run/.test(b.stdout)
    ? "identical"
    : a.status === 2 || b.status === 2
      ? `could not run: ${(a.stderr || b.stderr).split("\n")[0]}`
      : `DIFFERENT: ${b.stdout.split("\n").find((line) => line.includes("compare:"))?.trim() ?? "no comparison"}`;
  if (verdict !== "identical") failures++;
  console.log(`${engine.name.padEnd(22)} ${verdict}  (${seconds} s per run)`);
}
rmSync(scratch, { recursive: true, force: true });
process.exitCode = failures ? 1 : 0;
