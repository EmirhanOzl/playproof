import { launchBrowser } from "../browser.ts";
import { DEFAULT_MATRIX, describeDevice, resolveDevice, type Device } from "../devices.ts";
import { issueFindings, RunDir, type Finding, type Report, type ReportImage } from "../report.ts";
import { runSteps } from "../runner.ts";
import { openSession } from "../session.ts";
import { Compositor, type Tile } from "../sheet.ts";
import type { Step } from "../steps.ts";
import { openTarget } from "../target.ts";
import { imageList, sessionOptions, type CommonOptions } from "./common.ts";

export interface DevicesOptions extends CommonOptions {
  devices: string[];
  steps: Step[];
}

export interface LayoutCheck {
  // Stable id, used to merge the same problem across devices.
  code: string;
  severity: "error" | "warning" | "info";
  // Device-independent description with the fix.
  title: string;
  // Device-specific numbers.
  detail: string;
}

// Loads the game on a matrix of phones, a tablet and a desktop; screenshots each and checks for the layout bugs
// that only show up on real screen sizes.
export async function devicesCommand(options: DevicesOptions): Promise<Report & { run: RunDir }> {
  const run = RunDir.create("devices", options.out);
  const devices: Device[] = (options.devices.length ? options.devices : DEFAULT_MATRIX).map(resolveDevice);
  const target = await openTarget(options.target, options.port);
  const browser = await launchBrowser(options.browser, options.headed);
  let compositor: Compositor | null = null;
  try {
    const results: { device: Device; image: Buffer | null; checks: LayoutCheck[]; issues: Finding[] }[] = [];
    // A few devices at a time: fast, without starving each page of CPU (slow pages would look broken).
    const queue = [...devices];
    const worker = async (): Promise<void> => {
      for (let device = queue.shift(); device; device = queue.shift()) results.push(await checkDevice(device));
    };
    const checkDevice = async (device: Device) => {
      try {
        const session = await openSession(sessionOptions({ ...options, device }, { clock: options.steps.length > 0 }), {
          browser,
          target,
        });
        try {
          if (options.steps.length) {
            const result = await runSteps(session.driver, options.steps, { fullView: true });
            if (result.failure) {
              session.issues.push({
                kind: "pageerror",
                message: `Step ${result.failure.step + 1} failed (${result.failure.source}): ${result.failure.message}`,
                during: "setup steps",
              });
            }
          }
          const checks = await session.page.evaluate(layoutChecks, { touch: device.touch, mobile: device.mobile });
          const image = await session.driver.screenshot(null);
          return { device, image, checks, issues: issueFindings(session.issues) };
        } finally {
          await session.close();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message.split("\n")[0]! : String(error);
        return {
          device,
          image: null,
          checks: [{ code: "load", severity: "error" as const, title: "The game did not load.", detail: message }],
          issues: [],
        };
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    results.sort((a, b) => devices.indexOf(a.device) - devices.indexOf(b.device));

    const findings = groupFindings(results);

    compositor = await Compositor.open(browser);
    const placeholder = await blankImage(compositor);
    const tiles: Tile[] = results.map((result) => {
      const problems = [...result.checks, ...result.issues];
      const errors = problems.filter((p) => p.severity === "error").length;
      const warnings = problems.filter((p) => p.severity === "warning").length;
      return {
        image: result.image ?? placeholder,
        caption: `${result.device.name} · ${result.device.width}×${result.device.height} @${result.device.scale}x`,
        note: errors || warnings ? [errors && `${errors} error${errors > 1 ? "s" : ""}`, warnings && `${warnings} warning${warnings > 1 ? "s" : ""}`].filter(Boolean).join(", ") : undefined,
        accent: errors ? "red" : warnings ? "amber" : null,
      };
    });
    const png = await compositor.sheet({
      title: `devices  ·  ${results.length} screens`,
      subtitle: "Each screen is the visible browser viewport at that device's size, pixel ratio and touch input.",
      tiles,
      tileHeight: 340,
      maxWidth: 1800,
      notes: findings
        .filter((f) => f.severity !== "info")
        .slice(0, 10)
        .map((f) => ({ text: f.title, tone: f.severity === "error" ? "red" : "amber" })),
    });
    const images: ReportImage[] = [];
    imageList(images, run, "devices.png", "every device side by side", png);
    results.forEach((result, i) => {
      if (result.image) run.write(`device-${String(i + 1).padStart(2, "0")}-${slug(result.device.name)}.png`, result.image);
    });

    return {
      command: "devices",
      target: target.url,
      device: `${results.length} devices`,
      images,
      findings,
      data: {
        devices: results.map((r) => ({ device: describeDevice(r.device), checks: r.checks, issues: r.issues.map((i) => i.title) })),
      },
      run,
    };
  } finally {
    await compositor?.close();
    await browser.close().catch(() => {});
    await target.close();
  }
}

// The same problem on several devices becomes one finding that names the devices, instead of one line per device.
function groupFindings(results: { device: Device; checks: LayoutCheck[]; issues: Finding[] }[]): Finding[] {
  const order = ["error", "warning", "info"] as const;
  const groups = new Map<string, { severity: Finding["severity"]; title: string; lines: { device: string; detail: string }[] }>();
  const add = (key: string, severity: Finding["severity"], title: string, device: string, detail: string): void => {
    const group = groups.get(key) ?? { severity, title, lines: [] };
    if (order.indexOf(severity) < order.indexOf(group.severity)) group.severity = severity;
    group.lines.push({ device, detail });
    groups.set(key, group);
  };
  for (const result of results) {
    for (const check of result.checks) add(`check:${check.code}`, check.severity, check.title, result.device.name, check.detail);
    for (const issue of result.issues) add(`issue:${issue.title}`, issue.severity, issue.title, result.device.name, "");
  }
  return [...groups.values()].map((group) => {
    const devices = group.lines.map((line) => line.device);
    const others = results.map((r) => r.device.name).filter((name) => !devices.includes(name));
    const where =
      devices.length === results.length
        ? `all ${results.length} devices`
        : devices.length > 3 && others.length < devices.length
          ? `all except ${others.join(", ")}`
          : devices.join(", ");
    const details = group.lines.filter((line) => line.detail);
    const same = details.length > 0 && details.every((line) => line.detail === details[0]!.detail);
    const shown = same ? [details[0]!.detail] : details.slice(0, 4).map((line) => `${line.device}: ${line.detail}`);
    if (!same && details.length > shown.length) shown.push(`… and ${details.length - shown.length} more (see report.json)`);
    return { severity: group.severity, title: `[${where}] ${group.title}`, detail: shown.length ? shown.join("\n") : undefined };
  });
}

async function blankImage(compositor: Compositor): Promise<Buffer> {
  return compositor.sheet({ title: "not loaded", subtitle: "", tiles: [], tileHeight: 10, maxWidth: 560, notes: [] });
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// Runs in the page. Thresholds are deliberately conservative: each finding should be worth a look.
export function layoutChecks(context: { touch: boolean; mobile: boolean }): LayoutCheck[] {
  const out: LayoutCheck[] = [];
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const dpr = window.devicePixelRatio || 1;
  const visible = (el: Element): boolean => {
    const style = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0 && r.width > 0 && r.height > 0;
  };
  const size = (w: number, h: number): string => `${Math.round(w)}×${Math.round(h)}`;

  if (context.mobile && !document.querySelector('meta[name="viewport"]')) {
    out.push({
      code: "viewport-meta",
      severity: "warning",
      title:
        'No <meta name="viewport">: phones lay the page out 980 px wide and zoom out, so everything looks tiny. Add <meta name="viewport" content="width=device-width, initial-scale=1">.',
      detail: "",
    });
  }

  const canvases = Array.from(document.querySelectorAll("canvas")).filter(visible);
  let main: HTMLCanvasElement | null = null;
  let mainArea = 0;
  for (const canvas of canvases) {
    const r = canvas.getBoundingClientRect();
    if (r.width * r.height > mainArea) {
      main = canvas;
      mainArea = r.width * r.height;
    }
  }
  if (main) {
    const r = main.getBoundingClientRect();
    const name = main.id ? `canvas#${main.id}` : "canvas";
    if (main.width / (r.width * dpr) < 0.75 && mainArea > vw * vh * 0.1) {
      out.push({
        code: "blurry-canvas",
        severity: "warning",
        title:
          "The game canvas looks blurry: it has fewer pixels than the screen shows. Size the backing store by devicePixelRatio (canvas.width = clientWidth * devicePixelRatio) or raise the engine's resolution.",
        detail: `${name} draws ${size(main.width, main.height)}, shown at ${size(r.width, r.height)} CSS px on a ${dpr}x screen (${size(r.width * dpr, r.height * dpr)} device px)`,
      });
    }
    const shownAspect = r.width / r.height;
    const drawnAspect = main.width / main.height;
    if (Number.isFinite(shownAspect) && Number.isFinite(drawnAspect) && Math.abs(shownAspect / drawnAspect - 1) > 0.03) {
      out.push({
        code: "stretched-canvas",
        severity: "warning",
        title:
          "The game canvas is stretched: it is shown at a different aspect ratio than it is drawn, so circles become ovals and touch positions drift. Keep the CSS size proportional to canvas.width/height, or letterbox.",
        detail: `${name} drawn ${size(main.width, main.height)} (${drawnAspect.toFixed(2)}), shown ${size(r.width, r.height)} (${shownAspect.toFixed(2)})`,
      });
    }
    const outside = Math.max(0, -r.left) + Math.max(0, r.right - vw) + Math.max(0, -r.top) + Math.max(0, r.bottom - vh);
    if (outside > Math.min(vw, vh) * 0.02) {
      out.push({
        code: "canvas-cut-off",
        severity: "warning",
        title: "The game canvas is partly off screen.",
        detail: `${name} spans ${Math.round(r.left)},${Math.round(r.top)} → ${Math.round(r.right)},${Math.round(r.bottom)} in a ${size(vw, vh)} viewport`,
      });
    }
    const used =
      Math.max(0, Math.min(vw, r.right) - Math.max(0, r.left)) * Math.max(0, Math.min(vh, r.bottom) - Math.max(0, r.top));
    if (context.mobile && used < vw * vh * 0.4) {
      out.push({
        code: "small-game",
        severity: "info",
        title: "The game uses less than 40% of the screen.",
        detail: `${Math.round((used / (vw * vh)) * 100)}% (${size(r.width, r.height)} in ${size(vw, vh)})`,
      });
    }
    if (context.touch) {
      const action = getComputedStyle(main).touchAction;
      if (!/none|pinch-zoom|manipulation/.test(action) && !/none/.test(getComputedStyle(document.body).touchAction)) {
        out.push({
          code: "touch-action",
          severity: "warning",
          title:
            "The game canvas lets the browser handle touch gestures: swipes can scroll the page, and pull-to-refresh or double-tap zoom can fire mid-game. Add touch-action: none to the canvas.",
          detail: `touch-action: ${action}`,
        });
      }
    }
  }

  const root = document.scrollingElement ?? document.documentElement;
  if (root.scrollWidth > vw + 1) {
    out.push({
      code: "scrolls-sideways",
      severity: "warning",
      title: "The page scrolls sideways.",
      detail: `content is ${root.scrollWidth} px wide in a ${vw} px viewport`,
    });
  }
  if (main && root.scrollHeight > vh + 1 && getComputedStyle(document.body).overflow !== "hidden") {
    out.push({
      code: "scrolls-vertically",
      severity: context.mobile ? "warning" : "info",
      title:
        "The page scrolls vertically. In a game this usually means stray margins (body has 8 px by default) or an oversized element, and on phones drags may scroll the page.",
      detail: `${root.scrollHeight} px of content in ${vh} px`,
    });
  }

  const clippedText: string[] = [];
  const offscreenText: string[] = [];
  for (const el of Array.from(document.querySelectorAll("body *"))) {
    if (clippedText.length + offscreenText.length >= 6) break;
    if (!(el instanceof HTMLElement) || el instanceof HTMLCanvasElement || !visible(el)) continue;
    const text = Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent ?? "")
      .join("")
      .trim();
    if (!text) continue;
    const style = getComputedStyle(el);
    const hides = /hidden|clip|auto|scroll/.test(style.overflowX + style.overflowY) || style.textOverflow === "ellipsis";
    if (hides && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 2)) {
      clippedText.push(`"${text.slice(0, 40)}" needs ${size(el.scrollWidth, el.scrollHeight)}, has ${size(el.clientWidth, el.clientHeight)}`);
    }
    const r = el.getBoundingClientRect();
    if (r.right > vw + 1 || r.left < -1) offscreenText.push(`"${text.slice(0, 40)}" spans x ${Math.round(r.left)}–${Math.round(r.right)} of ${vw}`);
  }
  if (clippedText.length) out.push({ code: "text-clipped", severity: "warning", title: "Text is cut off.", detail: clippedText.join("; ") });
  if (offscreenText.length) {
    out.push({ code: "text-offscreen", severity: "warning", title: "Text runs off the screen.", detail: offscreenText.join("; ") });
  }

  if (context.touch) {
    const small: string[] = [];
    const selector = 'button, a[href], [role="button"], input[type="button"], input[type="submit"], [onclick]';
    for (const el of Array.from(document.querySelectorAll(selector))) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 44 || r.height < 44) {
        const label = (el.textContent ?? "").trim().slice(0, 24) || el.getAttribute("aria-label") || el.tagName.toLowerCase();
        small.push(`"${label}" ${size(r.width, r.height)}`);
      }
    }
    if (small.length) {
      out.push({
        code: "small-touch-targets",
        severity: "info",
        title: "Some touch targets are smaller than 44×44 px, which is hard to hit with a thumb.",
        detail: `${small.slice(0, 5).join(", ")}${small.length > 5 ? `, … (${small.length} total)` : ""}`,
      });
    }
  }
  return out;
}
