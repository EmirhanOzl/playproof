# Changelog

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
