// Regenerates the README images with playproof itself: npm run docs:images
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = "docs/images";
const scratch = mkdtempSync(join(tmpdir(), "playproof-docs-"));
mkdirSync(out, { recursive: true });

// A snappier version of the example jump (stronger take-off, heavier gravity), to show --compare.
const snappy = join(scratch, "jumper-snappy");
mkdirSync(snappy);
const source = readFileSync("examples/jumper/index.html", "utf8");
const changed = source.replace("hero.vy = -620", "hero.vy = -760").replace("hero.vy += 1700 * dt", "hero.vy += 2600 * dt");
if (changed === source) throw new Error("examples/jumper changed; update the snappy-jump edit in scripts/docs-images.ts");
writeFileSync(join(snappy, "index.html"), changed);

const jump = ["--device", "Pixel 8", "--do", "tap @Play; wait 400ms; key Space", "--duration", "700ms", "--max-tiles", "14"];
const runs: { id: string; args: string[]; images: Record<string, string> }[] = [
  { id: "jump", args: ["frames", "examples/jumper", ...jump], images: { "frames.png": "frames-jump.png", "onion.png": "onion-jump.png" } },
  {
    id: "snappy",
    args: ["frames", snappy, ...jump, "--compare", join(scratch, "jump")],
    images: { "compare.png": "compare-jump.png", "onion.png": "onion-snappy.png" },
  },
  {
    id: "bugs",
    args: ["frames", "examples/buggy", "--device", "Pixel 8", "--duration", "1.2s", "--max-tiles", "16"],
    images: { "frames.png": "frames-bugs.png" },
  },
  {
    id: "story",
    args: [
      "play",
      "examples/jumper",
      "--device",
      "Pixel 8",
      "--do",
      "shot title; tap @Play; wait 400ms; key Space; film 600ms; until window.playproof.state().screen === 'over' 20s; shot game over; tap @Retry; wait 300ms; shot retry",
    ],
    images: { "storyboard.png": "storyboard.png" },
  },
  {
    id: "devices",
    args: ["devices", "examples/buggy", "--devices", "iPhone SE (3rd gen),Galaxy S24,Pixel 8,iPhone 15 landscape,iPad Mini,Desktop"],
    images: { "devices.png": "devices.png" },
  },
  { id: "monkey", args: ["monkey", "examples/buggy", "--device", "Pixel 8", "--steps", "200"], images: { "monkey.png": "monkey.png" } },
  { id: "perf", args: ["perf", "test/fixtures/heavy.html", "--duration", "3s", "--cpu", "1"], images: { "perf.png": "perf.png" } },
];

for (const run of runs) {
  const dir = join(scratch, run.id);
  const result = spawnSync(process.execPath, ["src/cli.ts", ...run.args, "--out", dir], { encoding: "utf8" });
  if (result.status === 2) throw new Error(`${run.id}: ${result.stderr}`);
  for (const [image, name] of Object.entries(run.images)) {
    copyFileSync(join(dir, image), join(out, name));
    console.log(`${out}/${name}`);
  }
}
rmSync(scratch, { recursive: true, force: true });
