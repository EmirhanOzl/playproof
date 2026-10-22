import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE } from "../config.ts";

// Dev servers and their default ports, for projects whose game runs through a bundler.
const SERVERS: { dependency: string; url: string }[] = [
  { dependency: "vite", url: "http://localhost:5173" },
  { dependency: "next", url: "http://localhost:3000" },
  { dependency: "parcel", url: "http://localhost:1234" },
  { dependency: "webpack-dev-server", url: "http://localhost:8080" },
  { dependency: "@angular/cli", url: "http://localhost:4200" },
];

export interface InitResult {
  path: string;
  target: string;
  reason: string;
  written: boolean;
}

// Guesses the target: a plain HTML game in this folder, a dev server from package.json, or a build folder.
export function guessTarget(dir: string): { target: string; reason: string } {
  if (existsSync(join(dir, "index.html")) && !existsSync(join(dir, "package.json"))) {
    return { target: ".", reason: "index.html in this folder" };
  }
  let dependencies: Record<string, string> = {};
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, Record<string, string>>;
    dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {
    dependencies = {};
  }
  for (const server of SERVERS) {
    if (dependencies[server.dependency]) return { target: server.url, reason: `${server.dependency} dev server (start it before running playproof)` };
  }
  for (const folder of ["dist", "build", "public", "www", "docs"]) {
    if (existsSync(join(dir, folder, "index.html"))) return { target: `./${folder}`, reason: `${folder}/index.html` };
  }
  if (existsSync(join(dir, "index.html"))) return { target: ".", reason: "index.html in this folder" };
  return { target: "http://localhost:5173", reason: "nothing found; edit target to your game's URL, folder or HTML file" };
}

export function initCommand(dir: string, target: string | undefined, force: boolean): InitResult {
  const path = join(dir, CONFIG_FILE);
  const guess = target ? { target, reason: "given on the command line" } : guessTarget(dir);
  if (existsSync(path) && !force) return { path, target: guess.target, reason: guess.reason, written: false };
  const config = {
    $schema: "https://unpkg.com/playproof/schema/config.schema.json",
    target: guess.target,
    device: "desktop",
    scenarios: {
      start: { duration: "1s" },
    },
    check: { monkey: { steps: 200 }, devices: true },
  };
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return { path, target: guess.target, reason: guess.reason, written: true };
}

export function initMessage(result: InitResult): string {
  if (!result.written) return `${result.path} already exists; nothing changed (use --force to replace it).`;
  return [
    `Wrote ${result.path}`,
    `  target: ${result.target}  (${result.reason})`,
    `  device: desktop  (use "Pixel 8" or "iPhone 15" for a phone game)`,
    "",
    "Next:",
    "  npx playproof frames --scenario start     film the first second after loading",
    "  npx playproof check                       baseline, crash hunt and phone layouts in one go",
    "  npx playproof skill install --project     teach your coding agent to use playproof",
    "",
    'Add a scenario for each moment that matters, e.g. "jump": { "do": "tap @Play; key Space", "duration": "700ms" }.',
  ].join("\n");
}
