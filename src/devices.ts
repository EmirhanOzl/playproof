import { devices as registry } from "playwright-core";
import { UsageError } from "./target.ts";

export interface Device {
  name: string;
  width: number;
  height: number;
  scale: number;
  mobile: boolean;
  touch: boolean;
  userAgent?: string;
}

export const DESKTOP: Device = { name: "Desktop", width: 1280, height: 720, scale: 1, mobile: false, touch: false };

// The default `devices` matrix: narrow, short and tiny phones, big phones, a landscape phone, a tablet and a desktop.
// Sizes are the visible browser viewport (Playwright's device registry), which is what a web game actually gets.
export const DEFAULT_MATRIX = [
  "iPhone SE",
  "iPhone SE (3rd gen)",
  "Galaxy S24",
  "iPhone 15",
  "Pixel 8",
  "iPhone 16 Pro Max",
  "iPhone 15 landscape",
  "iPad Mini",
  "Desktop",
];

// Accepts a registry name ("iPhone 15", case-insensitive), "desktop", or WIDTHxHEIGHT[@SCALE] with an optional
// "mobile" suffix ("390x844@3 mobile").
export function resolveDevice(spec: string): Device {
  const text = spec.trim();
  if (/^desktop$/i.test(text)) return DESKTOP;
  const custom = /^(\d+)x(\d+)(?:@([\d.]+))?(\s+mobile)?$/i.exec(text);
  if (custom) {
    const mobile = Boolean(custom[4]);
    return {
      name: text,
      width: Number(custom[1]),
      height: Number(custom[2]),
      scale: custom[3] ? Number(custom[3]) : 1,
      mobile,
      touch: mobile,
    };
  }
  const key = Object.keys(registry).find((name) => name.toLowerCase() === text.toLowerCase());
  if (!key) {
    const close = Object.keys(registry)
      .filter((name) => name.toLowerCase().includes(text.toLowerCase().split(" ")[0] ?? ""))
      .slice(0, 6);
    throw new UsageError(
      `Unknown device "${spec}". Use a Playwright device name${close.length ? ` (e.g. ${close.join(", ")})` : ""}, "desktop", or WIDTHxHEIGHT[@SCALE].`,
    );
  }
  const d = registry[key]!;
  return {
    name: key,
    width: d.viewport.width,
    height: d.viewport.height,
    scale: d.deviceScaleFactor,
    mobile: d.isMobile,
    touch: d.hasTouch,
    userAgent: d.userAgent,
  };
}

export function describeDevice(device: Device): string {
  return `${device.name} ${device.width}×${device.height} @${device.scale}x${device.touch ? " touch" : ""}`;
}
