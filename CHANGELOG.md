# Changelog

## 0.4.0

- Real phones: `frames`, `play`, `monkey` and `perf` run on a USB-connected Android phone, in Chrome (`--android`) or inside an app's WebView (`--app <package>`: Capacitor, Cordova, Ionic), with the virtual clock. The app is reloaded back to normal afterwards.
- `monkey` saves the run as `repro.steps`, a script that `play --script` replays exactly, and maps the distinct screens it reached (`screens.png`). With the game's targets it explores: untried buttons on each screen first.
- New steps: `expect <js>` (a test assertion that reports the value it saw) and `background <time>`.

## 0.3.2

- Listed in the official MCP Registry as `io.github.EmirhanOzl/playproof`; releases publish there automatically.

## 0.3.1

- Faster runs: the wait for queued browser tasks between frames only happens when the game posted messages or used storage or workers since the last frame. 0.3.0 waited on every frame, which made long monkey runs several times slower.
- GitHub Action: uses the runner's preinstalled Chrome instead of installing Chromium's system packages, which took minutes on the new Ubuntu runners.

## 0.3.0

- Determinism for big engines: virtual time also waits for WebAssembly compilation, image and audio decoding and IndexedDB, lets queued browser tasks run between frames, and counts the settle time from the start of the game's render loop. Unity WebGL and Godot 4 web builds now give identical frames run after run, like Phaser, PixiJS and three.js (`npm run test:engines`).
- `playproof init`: writes a `playproof.config.json` for the project, finding the dev server (Vite, Next, Parcel, webpack, Angular), a build folder or a plain HTML game.
- Tested on Linux, macOS and Windows in CI.

## 0.2.0

- `playproof.config.json`: the game's target and defaults, and named scenarios (`--scenario jump`), with a JSON Schema for editor autocompletion.
- `playproof check`: films every scenario and compares it with its baseline (a snapshot test for motion), then runs monkey and devices; `--update` accepts changes, `--only` picks scenarios or parts. Baselines are kept per operating system.
- GitHub Action (`uses: EmirhanOzl/playproof@v0`): runs any command in CI, writes the summary to the job page and uploads the images.
- `--animate` (frames, play): the film as an animated PNG at real speed, for people and pull requests.
- MCP: `check` tool, and `scenario` on every tool; the target can come from the config.
- `--compare` reuses the earlier run's zoom region, so zoomed runs compare frame for frame.

## 0.1.0

First release.

- `frames`: frame-exact contact sheets on a virtual clock, with motion analysis (sudden jumps, one-frame flicker, holds, nothing moving), an onion skin of the whole motion, `--compare` against an earlier run, and `--zoom auto` to crop to where the motion is at full device resolution.
- `play`: scripted taps, drags, keys, waits and `until` conditions, with a storyboard; `js` results are printed in the summary.
- `monkey`: seeded random play that finds uncaught errors, failed requests, hangs, soft-locks and stopped render loops, with a reproduce command for each.
- `devices`: nine screens side by side, with checks for blurry or stretched canvases, overflow, scrolling, viewport meta, touch-action, clipped text and small touch targets.
- `perf`: frame pacing, dropped frames, long tasks and heap growth, locally or in Chrome on a USB-connected Android phone.
- `mcp`: an MCP server over stdio whose tools return the images directly.
- Agent Skill and plugins for Claude Code, Codex, Gemini CLI and Cursor; `npx skills add` for other agents.
- Optional `window.playproof` hook: `ready`, `state`, `targets`, `area`.
