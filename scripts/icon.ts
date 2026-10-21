// Draws the plugin icon (.claude-plugin/icon.png): a tiny contact sheet of a ball's jump. npm run docs:icon
import { writeFileSync } from "node:fs";
import { launchBrowser } from "../src/browser.ts";

const SIZE = 1024;
const browser = await launchBrowser(undefined, false);
const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
const dataUrl = await page.evaluate((size) => {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const s = size / 512;
  ctx.scale(s, s);
  const round = (x: number, y: number, w: number, h: number, r: number) => {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  };
  round(0, 0, 512, 512, 112);
  ctx.fillStyle = "#101418";
  ctx.fill();

  // Four film frames, 2×2, each showing the ball a bit further along its arc.
  const tiles = [
    { x: 56, y: 56, t: 0 },
    { x: 266, y: 56, t: 1 },
    { x: 56, y: 266, t: 2 },
    { x: 266, y: 266, t: 3 },
  ];
  const sky = ctx.createLinearGradient(0, 0, 0, 190);
  sky.addColorStop(0, "#2d5b8a");
  sky.addColorStop(1, "#f2a96b");
  for (const tile of tiles) {
    ctx.save();
    ctx.translate(tile.x, tile.y);
    round(0, 0, 190, 190, 22);
    ctx.clip();
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, 190, 190);
    ctx.fillStyle = "#58472f";
    ctx.fillRect(0, 150, 190, 40);
    ctx.fillStyle = "#7bbf5a";
    ctx.fillRect(0, 150, 190, 8);
    const k = tile.t / 3;
    const bx = 40 + k * 110;
    const height = Math.sin(k * Math.PI) * 78;
    const squash = tile.t === 0 || tile.t === 3 ? 0.28 : -0.18;
    const rx = 26 * (1 + squash * 0.6);
    const ry = 26 * (1 - squash * 0.5);
    ctx.fillStyle = "#45d39b";
    ctx.beginPath();
    ctx.ellipse(bx, 150 - height - ry, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    for (const ex of [-8, 10]) {
      ctx.beginPath();
      ctx.ellipse(bx + ex, 150 - height - ry * 1.2, 6, 8, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "#1b2838";
    for (const ex of [-8, 10]) {
      ctx.beginPath();
      ctx.arc(bx + ex + 3, 150 - height - ry * 1.15, 3.4, 0, Math.PI * 2);
      ctx.fill();
    }
    if (tile.t === 1) {
      ctx.strokeStyle = "#ff40c8";
      ctx.lineWidth = 5;
      ctx.setLineDash([12, 8]);
      ctx.strokeRect(bx - 40, 150 - height - ry * 2 - 14, 80, ry * 2 + 28);
    }
    ctx.restore();
  }
  return canvas.toDataURL("image/png");
}, SIZE);
writeFileSync(".claude-plugin/icon.png", Buffer.from(dataUrl.split(",")[1]!, "base64"));
await browser.close();
console.log(".claude-plugin/icon.png");
