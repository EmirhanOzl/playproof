import { chromium, type Browser, type LaunchOptions } from "playwright-core";
import { UsageError } from "./target.ts";

const ARGS = [
  // Games often wait for audio or a user gesture; neither should block an automated run.
  "--autoplay-policy=no-user-gesture-required",
  "--mute-audio",
  // Background throttling would distort timers and frame pacing when the window is not focused (headed runs).
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
];

// Tries Playwright's own Chromium first, then an installed Chrome or Edge, so most people need no download.
// `choice` may be "chromium", "chrome", "msedge" or a path to a Chromium-based executable.
export async function launchBrowser(choice: string | undefined, headed: boolean): Promise<Browser> {
  const base: LaunchOptions = { headless: !headed, args: ARGS };
  const attempts: { label: string; options: LaunchOptions }[] = [];
  if (!choice || choice === "chromium") attempts.push({ label: "Playwright Chromium", options: base });
  if (!choice || choice === "chrome") attempts.push({ label: "Google Chrome", options: { ...base, channel: "chrome" } });
  if (!choice || choice === "msedge") attempts.push({ label: "Microsoft Edge", options: { ...base, channel: "msedge" } });
  if (choice && !["chromium", "chrome", "msedge"].includes(choice)) {
    attempts.push({ label: choice, options: { ...base, executablePath: choice } });
  }

  const failures: string[] = [];
  for (const attempt of attempts) {
    try {
      return await chromium.launch(attempt.options);
    } catch (error) {
      failures.push(`${attempt.label}: ${String(error instanceof Error ? error.message : error).split("\n")[0]}`);
    }
  }
  throw new UsageError(
    [
      "No usable Chromium-based browser found.",
      ...failures.map((line) => `  ${line}`),
      "Install one with:  npx playproof install-browser",
      "or point playproof at a browser with --browser <path>.",
    ].join("\n"),
  );
}
