---
name: playproof
description: See and playtest browser games (HTML5 canvas, WebGL, Phaser, PixiJS, three.js, other web engines, DOM games). Use after changing a web game's animation, input, layout or performance, before saying it works; when asked to check game feel, juice, motion, a jump/attack/transition, or "does it look right"; when hunting crashes, freezes or soft-locks; when checking phone screens (blurry canvas, stretching, scrolling, touch gestures); or when measuring fps and stutter, including on a real Android phone.
---

# playproof: eyes and hands for browser games

A single screenshot catches one random instant. Animation bugs, janky motion, dead input, crashes after a hundred taps and broken phone layouts are invisible to it. `playproof` runs the game on a **virtual clock** (time only moves when told to, so every run is identical), drives real input, and returns **images made to be read**: contact sheets of frames, onion skins, before/after comparisons, storyboards, device grids and frame-time charts, plus a short text summary.

Run it with `npx playproof <command> <target>`. `<target>` is a URL (the dev server, e.g. `http://localhost:5173`), a folder (`./dist`) or an HTML file (`./index.html`). Folders and files are served automatically.

**Always open the images it prints.** The text summary lists findings; the images show what actually happened. Do not claim a visual change works until you have looked at the sheet.

## Pick the command

| You want to know | Run |
|---|---|
| Does this animation/transition look right? | `frames <target> --do "<steps that trigger it>" --duration 1s` |
| What exactly did my change do to it? | the same `frames` command again with `--compare <folder of the earlier run>` |
| Small character, need to see squash/stretch? | add `--zoom auto` (crops to where the motion is, at full device resolution) |
| Does this flow work (menu → play → win/lose)? | `play <target> --do "shot; tap @Play; wait 1s; shot; ..."` |
| Does it crash, hang or soft-lock under random input? | `monkey <target> --steps 300` |
| Does it look right on phones, tablets, desktop? | `devices <target>` |
| Does it run smoothly? | `perf <target> --duration 10s` (add `--android` for a USB phone) |

Add `--device "iPhone 15"` (or `"Pixel 8"`, `desktop`, `390x844@3 mobile`) when the game is meant for phones. Default is a 1280×720 desktop.

If the project has no `playproof.config.json` and you will test more than once, run `npx playproof init` (it guesses the target; check it). If it has one, read it first: it sets the target and device, and its `scenarios` name the moments worth filming. `--scenario <name>` replaces the steps, duration and zoom; the target can be left out. When you film the same steps more than twice, add them as a scenario. `playproof check` films every scenario against its committed baseline and runs monkey and devices: run it before finishing, and when it reports changed motion, look at `compare.png`; accept intended changes with `check --update` (tell the user, since it rewrites the baselines).

## Steps (`--do`)

Separate with `;`. Coordinates are inside the game area (the largest canvas): `50%,80%` or pixels `120,300`.

```
wait 500ms          tap 50%,80%         tap @Play             press 50%,50% 800ms
drag 10%,50% 90%,50% 300ms              key Space [200ms]     type hello
click #start-button  shot after-jump    film 1s [30]          until window.game.over 10s
js window.game.score
```

`@Play` taps a target the game exposes (see hook below). `until` advances time until a JavaScript expression is true; use it instead of guessing waits. `js` evaluates an expression; its result is printed in the summary (`log` lines), so you can read game state without opening files.

## Reading the output

- **frames.png**: tiles in time order, captioned `#frame  time`. A dashed magenta box marks what changed since the previous tile. Under the tiles, one bar per frame shows how much of the screen changed (square-root scale). Red tiles/bars are flagged:
  - *sudden jump*: one frame changes far more than its neighbours. A teleport, missing tween, or state switch without transition (fine if it is a deliberate cut).
  - *one-frame flicker*: a frame unlike both neighbours, which match each other. Wrong draw order, a cleared canvas, a sprite drawn before its position is set (fine if it is a deliberate flash).
  - *hold*: the screen is completely still between moving parts. An intended pause, or a stall?
  - *nothing changed*: the game ignored the steps, is paused, or animates outside requestAnimationFrame/timers.
- **onion.png**: the whole motion in one picture: up to ten moments ghosted over the still background, oldest faintest. The gaps between ghosts are the easing: wide = fast, tight = slow. Best view for arcs, anticipation and overshoot.
- **compare.png** (`--compare`): each sampled frame of the earlier run (top) above the same frame now (bottom), with what differs outlined, and the earlier run's motion as a line over this run's bars. Runs are deterministic, so "identical" really means your change did not affect this motion.
- **storyboard.png** (play): every `shot`, plus keyframes from each `film`, in order.
- **monkey.png**: checkpoints along the random run. Red = first uncaught error, amber = stuck. Every error comes with a `Reproduce:` command. Rerun it after the fix: same seed, same actions, same game time.
- **devices.png**: each device at its real viewport. Findings are merged across devices (`[all 9 devices] ...`).
- **perf.png**: frame time per frame against the frame budget line. Local runs slow the CPU 4× and have no GPU, so treat them as relative; `--android` measures a real phone.
- `report.json` holds everything (per-frame motion values, step log, stats). The exit code is 1 when errors were found.

## Judge motion, not just correctness

When reviewing a sheet, check the things players feel (details: [references/game-feel.md](references/game-feel.md)):

1. **Response**: the first visible reaction to input lands within 1–2 frames (≤ 50 ms). Look at the tiles right after the tap.
2. **Anticipation and follow-through**: a jump crouches before take-off and squashes on landing; things overshoot and settle instead of stopping dead.
3. **Easing**: bar heights should ramp up and down; a flat block of equal bars that starts and stops abruptly is linear, robotic motion.
4. **Continuity**: no sudden jumps or flicker unless intended.
5. **Readability**: the important thing is the thing that moves; the dashed boxes should sit where the player is looking.

## Typical loop

1. Before changing anything, film the current behaviour: `npx playproof frames http://localhost:5173 --device "Pixel 8" --do "tap @Play; wait 300ms; tap 50%,60%" --duration 800ms --out .playproof/before`
2. Change the code.
3. Film again with the same steps and `--compare .playproof/before`. Open `frames.png`, `onion.png` and `compare.png`; check the result against the intent.
4. Before finishing a feature: `monkey` for crashes, `devices` if layout or input changed, `perf` if rendering got heavier.

## Making a game easier to test (optional)

A game can expose a small hook. Everything is optional:

```js
window.playproof = {
  ready: () => assetsLoaded,               // boolean, function or promise: when to start
  state: () => ({ screen, level, score }), // JSON; logged, and used to detect soft-locks
  targets: () => [{ x, y, width, height, label: "Play" }], // CSS px; enables "tap @Play", aims the monkey
  area: () => ({ x, y, width, height }),   // the game world inside a letterboxed canvas
};
```

Without it, use `--ready "<js expression>"` or `--wait-for <selector>` for loading, and percentages for taps.

## Notes

- The virtual clock covers `requestAnimationFrame`, timers, `performance.now`, `Date`, CSS animations and transitions; `Math.random` is seeded (`--seed`, `--seed off`). Network requests, WebAssembly compilation, decoding and IndexedDB complete before the game sees more time pass, so loading is repeatable too. Audio, video and the inside of Web Workers keep real time.
- Big engines (Unity, Godot) need a few seconds to start: use `--settle 3s` or more. Settle counts from the start of the game's render loop.
- `--realtime` (play, monkey) skips the virtual clock when you need real timing.
- Output goes to `.playproof/<time>-<command>/` (add `.playproof/` to `.gitignore`), or `--out <dir>`.
- No browser? playproof falls back to an installed Chrome or Edge; `npx playproof install-browser` downloads its own Chromium.
- In apps without a shell, the same commands are available as MCP tools (`npx playproof mcp`), which return the images directly.
