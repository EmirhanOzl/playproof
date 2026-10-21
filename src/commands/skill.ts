import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { UsageError } from "../target.ts";

// Where agents look for skills. ".agents/skills" is shared by Codex, Cursor, Gemini CLI, OpenCode and GitHub
// Copilot; Claude Code reads ".claude/skills".
const LOCATIONS = {
  claude: ".claude/skills",
  agents: ".agents/skills",
} as const;

export function skillSource(): string {
  // dist/commands/skill.js and src/commands/skill.ts both sit two levels below the package root.
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const source = join(root, "skills", "playproof");
  if (!existsSync(join(source, "SKILL.md"))) throw new Error(`Bundled skill not found at ${source}`);
  return source;
}

export function installSkill(options: { project: boolean; agent: "claude" | "agents" | "all" }): string[] {
  const base = options.project ? process.cwd() : homedir();
  const kinds = options.agent === "all" ? (["claude", "agents"] as const) : ([options.agent] as const);
  const source = skillSource();
  const written: string[] = [];
  for (const kind of kinds) {
    const destination = join(base, LOCATIONS[kind], "playproof");
    rmSync(destination, { recursive: true, force: true });
    cpSync(source, destination, { recursive: true });
    written.push(destination);
  }
  return written;
}

export function skillCommand(args: string[], flags: { project: boolean; agent?: string }): string {
  const sub = args[0] ?? "install";
  if (sub === "print") return readFileSync(join(skillSource(), "SKILL.md"), "utf8");
  if (sub === "path") return skillSource();
  if (sub !== "install") throw new UsageError(`Unknown skill command "${sub}". Use: playproof skill install | print | path`);
  const agent = flags.agent ?? "all";
  if (agent !== "claude" && agent !== "agents" && agent !== "all") {
    throw new UsageError('--agent must be "claude", "agents" (Codex, Cursor, Gemini CLI, OpenCode, Copilot) or "all"');
  }
  const written = installSkill({ project: flags.project, agent });
  return [
    `Installed the playproof skill ${flags.project ? "for this project" : "for your user"}:`,
    ...written.map((path) => `  ${path}`),
    "",
    "Restart your agent (or start a new session) so it picks the skill up.",
  ].join("\n");
}
