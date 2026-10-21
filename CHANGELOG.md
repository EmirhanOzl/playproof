# Changelog

## 0.1.0

First release.

- `frames`: frame-exact contact sheets on a virtual clock, with motion analysis (sudden jumps, one-frame flicker, holds, nothing moving).
- `play`: scripted taps, drags, keys, waits and `until` conditions, with a storyboard.
- `monkey`: seeded random play that finds uncaught errors, failed requests, hangs, soft-locks and stopped render loops, with a reproduce command for each.
- `devices`: nine screens side by side, with checks for blurry or stretched canvases, overflow, scrolling, viewport meta, touch-action, clipped text and small touch targets.
- `perf`: frame pacing, dropped frames, long tasks and heap growth, locally or on a USB-connected Android phone.
- Agent Skill for Claude Code, Codex, Cursor, Gemini CLI and OpenCode (`playproof skill install`), and a Claude Code plugin.
- Optional `window.playproof` hook: `ready`, `state`, `targets`, `area`.
