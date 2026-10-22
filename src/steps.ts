import { readFileSync } from "node:fs";
import { UsageError } from "./target.ts";

// A tiny step language that agents can write on one line:
//   "tap 50%,80%; wait 300; key Space; drag 10%,50% 90%,50% 400ms; shot after-jump; film 1s"
// Coordinates are relative to the game area (the largest canvas unless --area is given): "50%,80%" or pixels
// "120,300". "@Play" taps the centre of the target labelled "Play" from window.playproof.targets().

export interface Point {
  x: number;
  y: number;
  xPercent: boolean;
  yPercent: boolean;
  label?: string;
}

export type Step =
  | { kind: "wait"; ms: number; source: string }
  | { kind: "tap"; at: Point; source: string }
  | { kind: "press"; at: Point; ms: number; source: string }
  | { kind: "drag"; from: Point; to: Point; ms: number; source: string }
  | { kind: "key"; key: string; ms: number; source: string }
  | { kind: "type"; text: string; source: string }
  | { kind: "click"; selector: string; source: string }
  | { kind: "shot"; label: string; source: string }
  | { kind: "film"; ms: number; fps: number | null; source: string }
  | { kind: "until"; expression: string; ms: number; source: string }
  | { kind: "expect"; expression: string; source: string }
  | { kind: "background"; ms: number; source: string }
  | { kind: "js"; expression: string; source: string };

export const STEP_HELP = `Steps (separate with ";" or new lines, "#" starts a comment line):
  wait <time>                 let time pass (virtual time: instant and exact)
  tap <x,y>|@label            tap/click inside the game area ("50%,80%" or pixels "120,300")
  press <x,y> <time>          long press
  drag <x,y> <x,y> [time]     swipe/drag (default 300ms)
  key <Key> [time]            press a key, e.g. Space, ArrowLeft, a, Enter (held 50ms by default)
  type <text>                 type text
  click <css selector>        click a DOM element (menus, HTML buttons)
  shot [label]                take a screenshot for the storyboard
  film <time> [fps]           capture frames while time passes
  until <js expression> [time] advance time until the expression is truthy (default timeout 5s)
  expect <js expression>      fail the run here unless the expression is truthy (a test assertion)
  background <time>           send the game to the background for this long (no frames), then bring it back
  js <js expression>          evaluate JavaScript in the page and log the result
Times: 500, 500ms, 1.5s.`;

export function loadSteps(inline: string | undefined, file: string | undefined): Step[] {
  const parts: string[] = [];
  if (file) parts.push(readFileSync(file, "utf8"));
  if (inline) parts.push(inline);
  return parseSteps(parts.join("\n"));
}

export function parseSteps(text: string): Step[] {
  const steps: Step[] = [];
  for (const raw of text.split(/\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    for (const piece of splitTopLevel(line)) {
      const source = piece.trim();
      if (source) steps.push(parseStep(source));
    }
  }
  return steps;
}

// ";" separates steps, except inside quotes or brackets (so "js a(); b()" needs quotes or a file).
function splitTopLevel(line: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if ("([{".includes(ch)) {
      depth++;
    } else if (")]}".includes(ch)) {
      depth = Math.max(0, depth - 1);
    } else if (ch === ";" && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

function parseStep(source: string): Step {
  const match = /^(\S+)\s*(.*)$/.exec(source)!;
  const command = match[1]!.toLowerCase();
  const rest = match[2]!.trim();
  const args = rest ? rest.split(/\s+/) : [];
  const fail = (why: string): never => {
    throw new UsageError(`Bad step "${source}": ${why}\n\n${STEP_HELP}`);
  };

  switch (command) {
    case "wait":
      if (args.length !== 1) fail("expected one time, e.g. wait 500ms");
      return { kind: "wait", ms: parseTime(args[0]!, fail), source };
    case "tap":
      if (args.length !== 1) fail("expected one point, e.g. tap 50%,80% or tap @Play");
      return { kind: "tap", at: parsePoint(args[0]!, fail), source };
    case "press":
      if (args.length !== 2) fail("expected a point and a time, e.g. press 50%,50% 800ms");
      return { kind: "press", at: parsePoint(args[0]!, fail), ms: parseTime(args[1]!, fail), source };
    case "drag":
    case "swipe":
      if (args.length < 2 || args.length > 3) fail("expected two points and an optional time");
      return {
        kind: "drag",
        from: parsePoint(args[0]!, fail),
        to: parsePoint(args[1]!, fail),
        ms: args[2] ? parseTime(args[2], fail) : 300,
        source,
      };
    case "key":
      if (args.length < 1 || args.length > 2) fail("expected a key and an optional hold time");
      return { kind: "key", key: normaliseKey(args[0]!), ms: args[1] ? parseTime(args[1], fail) : 50, source };
    case "type":
      if (!rest) fail("expected text");
      return { kind: "type", text: unquote(rest), source };
    case "click":
      if (!rest) fail("expected a CSS selector");
      return { kind: "click", selector: unquote(rest), source };
    case "shot":
      return { kind: "shot", label: unquote(rest), source };
    case "film":
      if (args.length < 1 || args.length > 2) fail("expected a time and optional fps, e.g. film 1s 30");
      return {
        kind: "film",
        ms: parseTime(args[0]!, fail),
        fps: args[1] ? positive(Number(args[1]), "fps", fail) : null,
        source,
      };
    case "until": {
      if (!rest) fail("expected a JavaScript expression");
      const last = args[args.length - 1]!;
      const hasTime = args.length > 1 && /^\d+(\.\d+)?(ms|s)?$/.test(last);
      return {
        kind: "until",
        expression: unquote(hasTime ? rest.slice(0, rest.lastIndexOf(last)).trim() : rest),
        ms: hasTime ? parseTime(last, fail) : 5000,
        source,
      };
    }
    case "expect":
      if (!rest) fail("expected a JavaScript expression, e.g. expect window.game.score > 0");
      return { kind: "expect", expression: unquote(rest), source };
    case "background":
      if (args.length !== 1) fail("expected one time, e.g. background 5s");
      return { kind: "background", ms: parseTime(args[0]!, fail), source };
    case "js":
      if (!rest) fail("expected a JavaScript expression");
      return { kind: "js", expression: unquote(rest), source };
    default:
      return fail(`unknown step "${command}"`);
  }
}

export function parseTime(text: string, fail: (why: string) => never = defaultFail): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s)?$/i.exec(text.trim());
  if (!match) return fail(`"${text}" is not a time (use 500, 500ms or 1.5s)`);
  const value = Number(match[1]);
  return match[2]?.toLowerCase() === "s" ? value * 1000 : value;
}

function parsePoint(text: string, fail: (why: string) => never): Point {
  if (text.startsWith("@")) {
    if (text.length < 2) fail("expected a label after @");
    return { x: 0, y: 0, xPercent: false, yPercent: false, label: text.slice(1) };
  }
  const match = /^(-?\d+(?:\.\d+)?)(%?),(-?\d+(?:\.\d+)?)(%?)$/.exec(text);
  if (!match) return fail(`"${text}" is not a point (use 50%,80% or 120,300)`);
  return { x: Number(match[1]), xPercent: match[2] === "%", y: Number(match[3]), yPercent: match[4] === "%" };
}

const KEY_ALIASES: Record<string, string> = {
  space: " ",
  spacebar: " ",
  enter: "Enter",
  return: "Enter",
  esc: "Escape",
  escape: "Escape",
  left: "ArrowLeft",
  right: "ArrowRight",
  up: "ArrowUp",
  down: "ArrowDown",
  tab: "Tab",
  shift: "Shift",
  ctrl: "Control",
  control: "Control",
  alt: "Alt",
  backspace: "Backspace",
};

export function normaliseKey(key: string): string {
  return KEY_ALIASES[key.toLowerCase()] ?? key;
}

function unquote(text: string): string {
  const t = text.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) return t.slice(1, -1);
  return t;
}

function positive(value: number, name: string, fail: (why: string) => never): number {
  if (!Number.isFinite(value) || value <= 0) fail(`${name} must be a positive number`);
  return value;
}

function defaultFail(why: string): never {
  throw new UsageError(why);
}
