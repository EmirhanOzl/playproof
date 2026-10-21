// Regenerates the README images with playproof itself: npm run docs:images
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = "docs/images";
const scratch = mkdtempSync(join(tmpdir(), "playproof-docs-"));
mkdirSync(out, { recursive: true });

const shots: { name: string; image: string; args: string[] }[] = [
  {
    name: "frames-jump.png",
    image: "frames.png",
    args: ["frames", "examples/jumper", "--device", "Pixel 8", "--do", "tap @Play; wait 400ms; key Space", "--duration", "700ms", "--max-tiles", "14"],
  },
  {
    name: "frames-bugs.png",
    image: "frames.png",
    args: ["frames", "examples/buggy", "--device", "Pixel 8", "--duration", "1.2s", "--max-tiles", "16"],
  },
  {
    name: "storyboard.png",
    image: "storyboard.png",
    args: [
      "play",
      "examples/jumper",
      "--device",
      "Pixel 8",
      "--do",
      "shot title; tap @Play; wait 400ms; key Space; film 600ms; until window.playproof.state().screen === 'over' 20s; shot game over; tap @Retry; wait 300ms; shot retry",
    ],
  },
  {
    name: "devices.png",
    image: "devices.png",
    args: ["devices", "examples/buggy", "--devices", "iPhone SE (3rd gen),Galaxy S24,Pixel 8,iPhone 15 landscape,iPad Mini,Desktop"],
  },
  { name: "monkey.png", image: "monkey.png", args: ["monkey", "examples/buggy", "--device", "Pixel 8", "--steps", "200"] },
  { name: "perf.png", image: "perf.png", args: ["perf", "test/fixtures/heavy.html", "--duration", "3s", "--cpu", "1"] },
];

for (const shot of shots) {
  const dir = join(scratch, shot.name);
  const result = spawnSync(process.execPath, ["src/cli.ts", ...shot.args, "--out", dir], { encoding: "utf8" });
  if (result.status === 2) throw new Error(`${shot.name}: ${result.stderr}`);
  copyFileSync(join(dir, shot.image), join(out, shot.name));
  console.log(`${out}/${shot.name}`);
}
rmSync(scratch, { recursive: true, force: true });
