# Contributing

Thanks for helping. Bug reports with a small page that reproduces the problem are the most useful thing you can send.

## Setup

```sh
npm install
node src/cli.ts install-browser
npm run check
```

`npm run check` runs the type checker and all tests. The end-to-end tests drive a real Chromium against `examples/` and `test/fixtures/`, and take about a minute.

## Layout

- `src/inject/`: scripts that run inside the page (the virtual clock and the error/frame probe). They are serialised by Playwright, so they must not reference anything outside their own function body.
- `src/commands/`: one file per command.
- `src/sheet.ts`: every image is drawn in a blank Chromium page; there are no native image dependencies, please keep it that way.
- `skills/playproof/`: the Agent Skill. If you change a command's behaviour or output, update `SKILL.md` too; agents rely on it.

## Adding a check

New findings should be worth a look every time they fire. Prefer missing an edge case to crying wolf: an agent that learns a check is noisy will ignore all of them. Add a planted case to `examples/buggy` or `test/fixtures` and a test that expects it, and make sure `examples/jumper` stays clean.

## Style

TypeScript, run directly by Node (type stripping), so only erasable syntax: no enums, namespaces or parameter properties. Match the surrounding code; comments explain why, not what.

## Releasing

1. Add a `## <version>` section to `CHANGELOG.md` (it becomes the release notes).
2. `node scripts/set-version.ts <version>` updates `package.json` and every plugin manifest.
3. Commit, then `git tag v<version> && git push origin v<version>`.

The Release workflow tests the tag, publishes to npm through trusted publishing (no tokens; npm adds provenance), creates the GitHub release and moves the `v0` tag that the GitHub Action is used by.
