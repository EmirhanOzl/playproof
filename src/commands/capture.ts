import { describeDevice } from "../devices.ts";
import { issueFindings, RunDir, type Finding, type Report, type ReportImage } from "../report.ts";
import { runSteps, type StoryItem } from "../runner.ts";
import { openSession } from "../session.ts";
import { Compositor } from "../sheet.ts";
import type { Step } from "../steps.ts";
import {
  buildCompareSheet,
  buildFilmSheet,
  buildOnion,
  buildStoryboard,
  formatTime,
  imageList,
  motionToFindings,
  sessionOptions,
  tileName,
  zoomFilm,
  type CommonOptions,
  type Zoom,
} from "./common.ts";

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
  // Folder of an earlier frames run to compare the first film with.
  compare?: string;
  zoom?: Zoom;
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
      detailedFilms: Boolean(options.zoom),
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

    for (const [n, captured] of films.entries()) {
      const label = films.length === 1 ? "film" : `film ${n + 1}`;
      let film = captured;
      let zoomRegion: { x: number; y: number; width: number; height: number } | null = null;
      if (options.zoom) {
        const zoomed = await zoomFilm(compositor, captured, options.zoom);
        if (zoomed) {
          film = zoomed.film;
          const r = zoomed.region;
          zoomRegion = r;
          const pct = (v: number) => Math.round(v * 100);
          film = { ...film, label: `${film.label}, zoomed to ${pct(r.x)},${pct(r.y)},${pct(r.width)},${pct(r.height)}% of the game area` };
        } else {
          film = { ...captured, label: `${captured.label} (no zoom: the motion fills most of the game area)` };
        }
      }
      const sheet = await buildFilmSheet(compositor, film, {
        maxTiles: options.maxTiles,
        boxes: options.boxes,
        frameMs: session.driver.frameMs,
        device: options.device,
        title: `${command === "frames" ? "frames" : label}  ·  ${film.label}`,
        enlarged: film !== captured,
      });
      const name = films.length === 1 ? "frames.png" : `film-${n + 1}.png`;
      imageList(images, run, name, `${label}: contact sheet, ${sheet.tiles.length} of ${film.frames.length} frames`, sheet.png);
      const onion = await buildOnion(compositor, film, session.driver.frameMs, `onion skin  ·  ${film.label}`);
      imageList(images, run, name.replace(".png", "-onion.png").replace("frames-onion", "onion"), `${label}: onion skin, the whole motion in one picture`, onion);
      findings.push(...motionToFindings(sheet.findings, label));
      if (n === 0) for (const index of sheet.tiles) run.write(tileName(index), film.frames[index]!.image);
      if (n === 0 && options.compare) {
        const compared = await buildCompareSheet(compositor, film, options.compare, sheet.diffs, {
          frameMs: session.driver.frameMs,
          device: options.device,
        });
        imageList(images, run, "compare.png", "this run against the earlier one, frame by frame", compared.png);
        findings.push(compared.finding);
      }
      filmData.push({
        label,
        step: film.step + 1,
        frames: film.frames.length,
        tiles: sheet.tiles.map((i) => i + 1),
        zoom: zoomRegion,
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
      log: result.log,
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
