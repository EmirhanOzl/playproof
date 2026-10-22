// Sets the version everywhere it is written down: node scripts/set-version.ts 0.2.0
// Then commit, tag v<version> and push the tag; the Release workflow publishes.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error("usage: node scripts/set-version.ts <major.minor.patch>");
  process.exit(2);
}
if (!readFileSync("CHANGELOG.md", "utf8").split(/\r?\n/).includes(`## ${version}`)) {
  console.error(`CHANGELOG.md has no "## ${version}" section; write it first (it becomes the release notes).`);
  process.exit(2);
}

execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["version", version, "--no-git-tag-version", "--allow-same-version"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

const manifests = [".claude-plugin/plugin.json", ".codex-plugin/plugin.json", ".cursor-plugin/plugin.json", "gemini-extension.json", "plugin.json"];
for (const file of [...manifests, ".claude-plugin/marketplace.json", "server.json"]) {
  const data = JSON.parse(readFileSync(file, "utf8")) as {
    version?: string;
    plugins?: { version?: string }[];
    packages?: { version?: string }[];
  };
  if (data.version !== undefined) data.version = version;
  for (const plugin of data.plugins ?? []) if (plugin.version !== undefined) plugin.version = version;
  for (const pkg of data.packages ?? []) if (pkg.version !== undefined) pkg.version = version;
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`${file} → ${version}`);
}
