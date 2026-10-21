import type { MotionData } from "./sheet.ts";

export interface MotionFinding {
  kind: "still" | "pop" | "flicker" | "hold";
  severity: "warning" | "info";
  // Frame indices into MotionData (frame i = the i-th captured frame after the baseline).
  frame: number;
  endFrame?: number;
  message: string;
}

const STILL = 0.02;

// Heuristics, not verdicts: a pop may be an intended cut and a one-frame flash may be a deliberate hit flash. They are
// worded as things to look at, with the frame numbers that point at the right tiles.
export function findMotionIssues(data: MotionData, frameMs: number): MotionFinding[] {
  const { diffs, skips } = data;
  const findings: MotionFinding[] = [];
  const at = (frame: number): string => `${Math.round((frame + 1) * frameMs)} ms`;
  if (!diffs.length) return findings;

  const moving = diffs.filter((d) => d > STILL);
  if (!moving.length) {
    findings.push({
      kind: "still",
      severity: "warning",
      frame: 0,
      endFrame: diffs.length - 1,
      message:
        "Nothing on screen changed during the capture. The game may be waiting for input, paused, finished loading later than expected, or animating outside requestAnimationFrame/timers (e.g. a Web Worker or video).",
    });
    return findings;
  }
  const sorted = [...moving].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;

  for (let i = 0; i < diffs.length; i++) {
    const d = diffs[i]!;
    const before = i > 0 ? diffs[i - 1]! : 0;
    const after = i + 1 < diffs.length ? diffs[i + 1]! : 0;
    if (d >= Math.max(8 * median, 1.5) && before < d / 4 && after < d / 4) {
      findings.push({
        kind: "pop",
        severity: "warning",
        frame: i,
        message: `Sudden jump at frame ${i + 1} (${at(i)}): the screen changes ${ratio(d, median)}× more than in a typical frame, with calm frames on both sides. Check for a teleport, a missing tween, or a state switch without transition (fine if it is an intended cut).`,
      });
    }
    const skip = skips[i] ?? -1;
    if (skip >= 0 && d > 1 && after > 1 && skip < 0.25 * Math.min(d, after)) {
      findings.push({
        kind: "flicker",
        severity: "warning",
        frame: i,
        message: `One-frame flicker at frame ${i + 1} (${at(i)}): it differs from both neighbours, which match each other. Check for a stray frame (wrong layer order, a sprite drawn before its position is set, a cleared canvas). Ignore if it is a deliberate flash.`,
      });
    }
  }

  // Stretches with no change between moving stretches: often intended (anticipation, a pause), sometimes a stall.
  const minRun = Math.max(6, Math.round(250 / frameMs));
  let runStart = -1;
  for (let i = 0; i <= diffs.length; i++) {
    const still = i < diffs.length && diffs[i]! <= STILL;
    if (still && runStart < 0) runStart = i;
    if (!still && runStart >= 0) {
      const length = i - runStart;
      if (length >= minRun && runStart > 0 && i < diffs.length) {
        findings.push({
          kind: "hold",
          severity: "info",
          frame: runStart,
          endFrame: i - 1,
          message: `The screen holds completely still for ${Math.round(length * frameMs)} ms (frames ${runStart + 1}–${i}) between moving parts. Intended pause, or a stall?`,
        });
      }
      runStart = -1;
    }
  }
  return findings;
}

function ratio(value: number, median: number): string {
  const r = value / median;
  return r >= 10 ? String(Math.round(r)) : r.toFixed(1);
}
