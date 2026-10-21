import { describeDevice } from "../devices.ts";
import { issueFindings, RunDir, type Finding, type Report, type ReportImage } from "../report.ts";
import { runSteps, type StoryItem } from "../runner.ts";
import { openSession } from "../session.ts";
import { Compositor } from "../sheet.ts";
import type { Step } from "../steps.ts";
import { buildFilmSheet, buildStoryboard, formatTime, imageList, motionToFindings, sessionOptions, type CommonOptions } from "./common.ts";

export interface CaptureOptions extends CommonOptions {
  steps: Step[];
  // frames: a film of this length is appended to the steps.
  filmMs?: number;
  filmFps?: number;
  maxTiles: number;
  boxes: boolean;
  fullView: boolean;
  realtime: boolean;
  saveFrames: boolean;
}

// `frames` and `play` share this: run the steps, then render films as contact sheets and everything as a storyboard.
export async function captureCommand(command: "frames" | "play", options: CaptureOptions): Promise<Report & { run: RunDir }> {
  const run = RunDir.create(command, options.out);
  const steps: Step[] = [...options.steps];
  if (options.filmMs !== undefined) {
    steps.push({
      kind: "film",
      ms: options.filmMs,
      fps: options.filmFps ?? null,
      source: `film ${formatTime(options.filmMs)}`,
    });
  }

  const session = await openSession(sessionOptions(options, { clock: !options.realtime }));
  let compositor: Compositor | null = null;
  try {
    const result = await runSteps(session.driver, steps, {
      fullView: options.fullView,
      onStep: (index, step) => {
        session.during = `step ${index + 1}: ${step.source}`;
      },
    });
    session.during = "after the last step";

    compositor = await Compositor.open(session.browser);
    const images: ReportImage[] = [];
    const findings: Finding[] = [];
    const films = result.items.filter((item): item is Extract<StoryItem, { kind: "film" }> => item.kind === "film");
    const filmData: Record<string, unknown>[] = [];

    for (const [n, film] of films.entries()) {
      const label = films.length === 1 ? "film" : `film ${n + 1}`;
      const sheet = await buildFilmSheet(compositor, film, {
        maxTiles: options.maxTiles,
        boxes: options.boxes,
        frameMs: session.driver.frameMs,
        device: options.device,
        title: `${command === "frames" ? "frames" : label}  ·  ${film.label}`,
      });
      const name = films.length === 1 ? "frames.png" : `film-${n + 1}.png`;
      imageList(images, run, name, `${label}: contact sheet, ${sheet.tiles.length} of ${film.frames.length} frames`, sheet.png);
      findings.push(...motionToFindings(sheet.findings, label));
      filmData.push({
        label,
        step: film.step + 1,
        frames: film.frames.length,
        tiles: sheet.tiles.map((i) => i + 1),
        screenChangePerFrame: sheet.diffs,
      });
      if (options.saveFrames) {
        film.frames.forEach((frame, i) => run.write(`${name.replace(".png", "")}-${String(i + 1).padStart(4, "0")}.png`, frame.image));
      }
    }

    if (result.failure) {
      findings.push({
        severity: "error",
        title: `Step ${result.failure.step + 1} failed (${result.failure.source}): ${result.failure.message}`,
      });
    }
    findings.push(...issueFindings(session.issues));

    const shots = result.items.filter((item) => item.kind === "shot");
    if (command === "play" || shots.length) {
      // A failed script still gets a picture of where it stopped.
      const items = [...result.items];
      if (result.failure) {
        items.push({
          kind: "shot",
          label: `stopped at step ${result.failure.step + 1}`,
          image: await session.driver.screenshot(options.fullView ? null : await session.driver.area()),
          time: result.elapsedMs,
          step: result.failure.step,
        });
      }
      const storyboard = await buildStoryboard(
        compositor,
        items,
        `${command}  ·  ${steps.length} steps`,
        `${describeDevice(options.device)}  ·  ${options.realtime ? "real time" : "virtual clock"}  ·  ${formatTime(result.elapsedMs)} of game time`,
        findings
          .filter((f) => f.severity !== "info")
          .slice(0, 6)
          .map((f) => ({ text: f.title, tone: f.severity === "error" ? "red" : "amber" })),
      );
      if (storyboard) imageList(images, run, "storyboard.png", "storyboard: every shot plus keyframes from each film", storyboard);
    }

    const report: Report = {
      command,
      target: session.url,
      device: describeDevice(options.device),
      images,
      findings,
      data: {
        steps: steps.map((step) => step.source),
        elapsedMs: Math.round(result.elapsedMs),
        log: result.log,
        films: filmData,
        clock: options.realtime ? "real" : "virtual",
      },
    };
    return { ...report, run };
  } finally {
    await compositor?.close();
    await session.close();
  }
}
