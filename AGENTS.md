# AGENTS.md

Installing playproof rather than working on it? Follow the [Install](README.md#install) section of the README: pick the commands for the agent you are running in. For an agent without plugins or skills, `npx skills add EmirhanOzl/playproof` installs the skill, and `npx playproof <command>` needs no install at all.

Working on playproof itself:

- `npm run check` must pass (type check, unit tests, end-to-end tests against `examples/` and `test/fixtures/`). The end-to-end tests need a browser: `node src/cli.ts install-browser`.
- `src/inject/` runs inside the game page and is serialised by Playwright: no references outside the function body.
- `skills/playproof/SKILL.md` is what other agents read. Update it whenever a command, flag or output changes.
- If an image changes, regenerate the README images with `npm run docs:images` and look at them.
- New findings must be worth a look every time they fire; add a planted case to `examples/buggy` or `test/fixtures` and keep `examples/jumper` clean.
