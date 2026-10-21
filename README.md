# playproof

**Eyes and hands for browser games.** playproof lets coding agents (and you) see a web game move frame by frame, play it with scripted input, hunt for crashes, check it on phone screens and measure its frame pacing. Everything comes back as images made to be read, plus a short text summary.

```sh
npx playproof frames http://localhost:5173 --device "Pixel 8" --do "tap @Play; wait 400ms; key Space" --duration 700ms
```

![A contact sheet of a jump: 14 tiles over 700 ms, dashed boxes around what moved, and a bar per frame showing how much of the screen changed](docs/images/frames-jump.png)

Tested with Canvas 2D, WebGL, Phaser, PixiJS and three.js. Anything else that runs in Chromium should work the same way, including Godot and Unity web exports and plain DOM games.

## Why

An agent can write a canvas game in minutes, but it can't watch it. A screenshot catches one random instant, so the things that make a game feel broken stay invisible: a jump without anticipation, a sprite that teleports, a one-frame flicker, a button that does nothing, a crash after a hundred taps, a canvas that is blurry on every phone.

playproof runs the game on a **virtual clock**. Time only moves when playproof moves it, one exact frame at a time, so it can film any moment and every run gives the same pixels. Then it lays the frames out where a model (or a person) can actually look at them, and points at what looks wrong.

## Commands

### `frames`: watch an animation

Films the game on the virtual clock and builds a contact sheet. A dashed box shows what changed since the previous tile, and the bar chart shows how much of the screen changed in every frame. playproof flags **sudden jumps** (teleports, missing tweens), **one-frame flicker** (draw-order bugs, half-updated state), **holds** (stalls) and **nothing moving at all**.

```sh
npx playproof frames ./dist --device "Pixel 8" --duration 1.2s
```

![Contact sheet of a buggy game: two white flicker frames and a teleporting ball are outlined in red and explained under the chart](docs/images/frames-bugs.png)

### `play`: run a script, get a storyboard

```sh
npx playproof play http://localhost:5173 --device "Pixel 8" \
  --do "shot title; tap @Play; wait 400ms; key Space; film 600ms; until window.playproof.state().screen === 'over' 20s; shot game over; tap @Retry; shot retry"
```

![Storyboard: title screen, four frames of a jump, the game over screen, and the retry](docs/images/storyboard.png)

### `monkey`: random play that hunts for crashes

Taps, drags, long presses, rapid triple taps, keys, and sending the tab to the background, all at random but **repeatable by seed**. It reports uncaught errors, failed requests, hangs (infinite loops), soft-locks (input keeps coming, nothing changes) and a render loop that stops. Every error comes with a command that reproduces it exactly.

```sh
npx playproof monkey ./dist --device "Pixel 8" --steps 300
```

```
ERROR   Uncaught error: TypeError: Cannot read properties of undefined (reading 'activate')
        during: action 13: tap 699,820, wait 119ms
        at HTMLCanvasElement.<anonymous> (http://127.0.0.1:52009/:51:40)
        Reproduce: playproof monkey "./dist" --seed 1 --steps 13 --device "Pixel 8"
```

### `devices`: phones, tablet and desktop side by side

Loads the game on nine screens (small and tall phones, a landscape phone, a tablet, a desktop) and checks for the layout bugs that only show up there: **blurry canvas** (no devicePixelRatio scaling), **stretched canvas**, canvas cut off, page scrolling, missing viewport meta, missing `touch-action: none`, clipped text and tiny touch targets. The same problem on several devices is reported once.

```sh
npx playproof devices http://localhost:5173
```

![Six devices side by side; the stretched ball on landscape and desktop is obvious, and findings are listed underneath](docs/images/devices.png)

### `perf`: frame pacing

Measures real frame times while the game idles, runs a script (`--do`) or takes random taps (`--monkey`): fps, p95/p99, dropped frames against the display's refresh rate, long main-thread tasks and heap growth. Locally the CPU is slowed 4× to approximate a mid-range phone. With `--android` it measures **Chrome on a USB-connected Android phone** instead.

```sh
npx playproof perf ./dist --duration 10s --monkey
npx playproof perf http://localhost:5173 --android   # localhost is forwarded to the phone over USB
```

![Frame-time chart with most bars over the 16.7 ms budget line, marked red](docs/images/perf.png)

On a phone, playproof opens its own tab, talks only to that tab, and closes it afterwards. It never lists or reads your other tabs.

## Use it from your coding agent

playproof ships an [Agent Skill](skills/playproof/SKILL.md) that teaches the agent when to use each command, how to read the images, and what good game feel looks like on a contact sheet.

```sh
npx playproof skill install            # ~/.claude/skills and ~/.agents/skills
npx playproof skill install --project  # this repository only
```

`~/.claude/skills` is read by Claude Code. `~/.agents/skills` is read by Codex, Cursor, Gemini CLI, OpenCode and GitHub Copilot.

In Claude Code you can also install it as a plugin:

```
/plugin marketplace add EmirhanOzl/playproof
/plugin install playproof@playproof
```

After that, asking the agent to "make the jump feel better" or "check this on phones" ends with it opening a contact sheet instead of guessing.

## Steps

Used by `--do` and `--script <file>` (one step per line there). Separate steps with `;`. Points are relative to the game area (the largest canvas, or `--area <selector>`).

| Step | Meaning |
|---|---|
| `wait 500ms` | let time pass (instant and exact on the virtual clock) |
| `tap 50%,80%` / `tap 120,300` / `tap @Play` | tap or click; `@label` uses targets the game exposes |
| `press 50%,50% 800ms` | long press |
| `drag 10%,50% 90%,50% 300ms` | swipe |
| `key Space [200ms]` | press a key (held 50 ms by default) |
| `type hello` | type text |
| `click #start` | click a DOM element |
| `shot [label]` | screenshot for the storyboard |
| `film 1s [30]` | capture frames while time passes |
| `until <js> [5s]` | advance time until the expression is true |
| `js <js>` | evaluate and log a value |

Times: `500`, `500ms`, `1.5s`.

## Optional: a hook in your game

None of this is required, but four small functions make tests sharper:

```js
window.playproof = {
  ready: () => assetsLoaded,               // boolean, function or promise: when to start
  state: () => ({ screen, level, score }), // logged; used to tell a soft-lock from a busy screen
  targets: () => [{ x, y, width, height, label: "Play" }], // CSS px; enables "tap @Play" and aims the monkey at buttons
  area: () => ({ x, y, width, height }),   // the game world inside a letterboxed canvas; crops every capture
};
```

Without it, use `--ready "<js expression>"` or `--wait-for <selector>` to wait for loading, and percentages for taps. [examples/jumper](examples/jumper/index.html) shows the hook in a complete game.

## How it works

- **Virtual clock.** Before any game script runs, playproof replaces `requestAnimationFrame`, `setTimeout`/`setInterval`, `performance.now` and `Date`, and stops the CSS animation timeline. Time starts frozen. Advancing it runs timers and frames in exact order at 60 fps, which is why `wait 2s` takes milliseconds and why two runs produce identical frames.
- **Repeatable loading.** While the page loads, playproof advances frames itself. Whenever the game has network requests in flight, virtual time waits for them, so to the game the network looks instant and a slow connection gives the same frames as a fast one.
- **Seeded randomness.** `Math.random` is seeded (`--seed`, or `--seed off`).
- **Real input.** Touch devices get real touch events (with the pointer and mouse events Chrome derives from them); others get mouse events. Key presses are held for a few frames so games that poll input see them.
- **Images, not logs.** Contact sheets, storyboards and charts are drawn in a blank Chromium page, so playproof has a single dependency (`playwright-core`) and no native image libraries.

## Output

Each run writes to `.playproof/<time>-<command>/` (or `--out <dir>`): the images, `report.json` with all the numbers (per-frame motion, step log, frame times) and `summary.txt`. Add `.playproof/` to your `.gitignore`. `--json` prints the report instead of the summary.

Exit codes: `0` nothing serious found, `1` errors found (crashes, failed requests, failed steps), `2` playproof itself could not run. That makes `monkey` and `devices` usable as CI checks.

## Requirements

- Node.js 22.18 or newer.
- A Chromium-based browser. playproof uses your installed Chrome or Edge if it has nothing else; `npx playproof install-browser` downloads the exact Chromium build it is tested with. Choose one with `--browser chromium|chrome|msedge|<path>`.
- For `perf --android`: `adb` (Android platform-tools) and a phone with USB debugging enabled.

## Limitations

- Audio, video, Web Workers and WebAssembly threads keep real time; a game whose simulation runs in a worker will not be frame-exact.
- Local `perf` numbers come from emulation without a GPU: good for comparing before and after a change, not for promising a frame rate. Use `--headed` for GPU rendering or `--android` for the real thing.
- Motion findings are heuristics. A sudden jump may be an intended cut and a one-frame flash may be a deliberate hit flash, which is why they are worded as things to look at.
- Chromium only, for now.

## Development

```sh
npm install
node src/cli.ts install-browser   # once
npm run check                     # type check + unit and end-to-end tests
npm run docs:images               # regenerate the README images with playproof itself
```

The two example games are also the test targets: [examples/jumper](examples/jumper/index.html) is a small, clean game; [examples/buggy](examples/buggy/index.html) has eight planted bugs that the tests expect playproof to catch.

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
