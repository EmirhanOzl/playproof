import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Issue } from "./session.ts";

export type Severity = "error" | "warning" | "info";

export interface Finding {
  severity: Severity;
  title: string;
  detail?: string;
}

export interface ReportImage {
  label: string;
  path: string;
}

export interface Report {
  command: string;
  target: string;
  device: string;
  images: ReportImage[];
  findings: Finding[];
  // Results of js and until steps, shown in the summary.
  log?: string[];
  // Command-specific numbers (frame times, step log, ...), kept for --json and report.json.
  data: Record<string, unknown>;
}

export class RunDir {
  readonly dir: string;

  private constructor(dir: string) {
    this.dir = dir;
  }

  // Default: .playproof/<timestamp>-<command> in the current directory.
  static create(command: string, out: string | undefined): RunDir {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const dir = resolve(out ?? join(".playproof", `${stamp}-${command}`));
    mkdirSync(dir, { recursive: true });
    // Keeps runs out of git without touching the project's own .gitignore.
    const ignore = join(out === undefined ? resolve(".playproof") : dir, ".gitignore");
    if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
    return new RunDir(dir);
  }

  write(name: string, data: Buffer | string): string {
    const path = join(this.dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
    return path;
  }

  finish(report: Report): { text: string; exitCode: number } {
    const order: Severity[] = ["error", "warning", "info"];
    const findings = [...report.findings].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
    const full = { ...report, findings, dir: this.dir };
    this.write("report.json", JSON.stringify(full, null, 2));

    const count = (s: Severity) => findings.filter((f) => f.severity === s).length;
    const names: Record<Severity, [string, string]> = { error: ["error", "errors"], warning: ["warning", "warnings"], info: ["note", "notes"] };
    const counts = order.map((s) => `${count(s)} ${names[s][count(s) === 1 ? 0 : 1]}`).join(", ");
    const show = (path: string) => {
      const rel = relative(process.cwd(), path);
      return rel && !rel.startsWith("..") ? rel : path;
    };
    const lines = [
      `playproof ${report.command}: ${counts}`,
      `target  ${report.target}`,
      `device  ${report.device}`,
      ...report.images.map((image) => `image   ${show(image.path)}  (${image.label})`),
      `report  ${show(join(this.dir, "report.json"))}`,
      ...(report.log ?? []).map((line) => `log     ${line}`),
    ];
    if (findings.length) lines.push("");
    for (const finding of findings) {
      lines.push(`${(finding.severity === "info" ? "NOTE" : finding.severity.toUpperCase()).padEnd(7)} ${finding.title}`);
      if (finding.detail) lines.push(...finding.detail.split("\n").map((line) => `        ${line}`));
    }
    const text = lines.join("\n");
    this.write("summary.txt", `${text}\n`);
    return { text, exitCode: count("error") > 0 ? 1 : 0 };
  }
}

// Groups repeated page errors so one bug thrown every frame does not bury everything else.
export function issueFindings(issues: Issue[]): Finding[] {
  const groups = new Map<string, { issue: Issue; count: number }>();
  for (const issue of issues) {
    const key = `${issue.kind}|${issue.message.split("\n")[0]}`;
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { issue, count: 1 });
  }
  const label: Record<Issue["kind"], string> = {
    pageerror: "Uncaught error",
    console: "console.error",
    request: "Failed request",
    crash: "Page crash",
  };
  return [...groups.values()].map(({ issue, count }) => {
    const [first, ...stack] = issue.message.split("\n");
    return {
      severity: issue.kind === "console" ? ("warning" as const) : ("error" as const),
      title: `${label[issue.kind]}${count > 1 ? ` (×${count})` : ""}: ${first}`,
      detail: [`during: ${issue.during}`, ...stack.slice(0, 6).map((line) => line.trim())].join("\n"),
    };
  });
}
