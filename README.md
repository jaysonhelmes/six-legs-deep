# Six Legs Deep

An incremental browser game about an ant colony. You see the colony from two sides at once: **Above**, a hex map of
the surface where foragers walk scent trails to food, and **Below**, a cut-away of the nest where diggers carve
galleries, granaries and nurseries out of the soil. You start with one queen and a crumb of food. You grow through
nuptial flights, supercolonies and speciation, and the end goal is twenty quadrillion ants.

The game is plain JavaScript (ES modules) with no dependencies and no build step. Saves stay in your browser's
`localStorage`.

## Requirements

- **Node.js 22 or newer**. You only need it for the local server, the tests and the tools; the game itself runs
  entirely in the browser.
- **A recent browser**: Chrome, Edge, Firefox or Safari, with ES modules and canvas support.

## Running the game

```sh
npm run serve
```

Then open **http://localhost:8080**. To use another port, run `npm run serve -- --port 9000` or set `PORT=9000`.

Open the game through the server. Opening `index.html` straight from disk (`file://`) does not work, because browsers
block ES modules there.

Useful while developing:

- `http://localhost:8080/?reveal=all` shows every panel and feature right away, without waiting for it to unlock.
- `window.sld` in the browser console gives `{ game, ui, uistate, renderers, tabLock }`. Use it to read state. To
  change state, go through `sld.game.actions.do(type, args)`, as the UI does. A fresh colony from the console:
  `sld.game.newGame(Date.now()); sld.game.save(Date.now())`, then reload.
- **Settings → Export / Import** copies a save between browsers. `npm run smoke -- --export save.txt` writes a
  40-minute save you can import to jump straight to mid-game. `npm run saves` writes four saves to `test-saves/`
  (mid-game, ready to fly, ready to merge into a Supercolony, ready to speciate); open one, copy its text, and paste it
  into Settings → Import.

## Tests and tools

| Command | What it does |
|---|---|
| `npm test` | Every unit and integration test (`node --test`). Run one area with `node --test "tests/<prefix>.*.test.js"`; the prefixes are `core`, `colony`, `nest`, `surface`, `war`, `research`, `world`, `meta`, `render`, `ui` and `integration`. Set `FUZZ=full` for the 1,000,000-tick fuzz run. |
| `npm run sim` | Headless pacing bot. It plays the real game and prints a milestone table checked against the design's time targets. Common runs: `npm run sim -- --until flight`, and `npm run sim -- --hours 12 --dt 1 --until supercolony`. Add `--strict` to exit non-zero when a check fails, or `--json` for machine-readable output. |
| `npm run smoke` | Headless 40-minute play-through, like a player. Fails on any exception, console error, invalid state value or stalled growth. Options: `--minutes`, `--seed`, `--quiet`, `--export <file>`. |
| `npm run saves` | Plays the pacing bot and writes test saves at four key points to `test-saves/` (about 7 minutes). Options: `--seed`, `--out`. |
| `npm run check:imports` | Static import-graph check from `src/main.js`: every imported file and name exists. |
| `node tools/meta-model.mjs` | Analytic model of the prestige layers and the time to the 2e16 ending. |

## How to play

1. **Click the glowing crumb** next to the entrance to bring in food. The queen lays eggs from food, and the first
   worker hatches after about 15 seconds.
2. **Assign jobs** in the Colony tab. Foragers gather food. Diggers dig the nest and produce soil. Later you also get
   nurses, scouts, herders and others.
3. **When the nest is full**, open the Build tab and place a **Gallery** in the Below view. Diggers carve it out.
   Granaries store food, and Nurseries raise brood faster. Click a chamber to inspect it and grow it a level.
4. **Drag a trail** on the Above map from the entrance to a food source, such as a seed patch. Foragers spread across
   your trails, and longer or richer trails pay more.
5. **Scouts reveal the map.** Revealed hexes give insight, which you spend in the **Research** tab.
6. The **bottleneck badge** at the top names what is holding the colony back, and the ribbon next to it shows the next
   unlock. Later you meet rivals, seasons and raids, and eventually you can take a **Nuptial Flight**: a prestige reset
   that earns alates.

The game keeps running while the tab is hidden and catches up when you come back, even if the hidden tab was closed or
reloaded in the meantime. When you reload, it credits the time you were away, which is shown on the welcome-back screen.

**One tab at a time.** If you open the game in a second tab or window, the newest one takes over with the latest save.
The older tab pauses behind a "Game open in another tab" screen and stops saving; its **Play here** button reloads it
and takes the game back.

## Controls

| Input | Above (map) | Below (nest) |
|---|---|---|
| Click | Hand-forage a source, select a trail, hex, rival or event object | Select or inspect a chamber, help dig, groom brood, scrape mold |
| Drag | From an entrance to a source: draw a trail (onto a rival nest: send a war party). From empty ground: pan | From an open cell across soil: dig a tunnel. Elsewhere: scroll, and pan when zoomed in |
| Wheel | Zoom | Scroll (`Shift` + wheel pans) |
| `Ctrl` + wheel, pinch | Zoom | Zoom |
| `+` / `−` | Zoom | Zoom (also the − / + buttons at the top right of the nest view) |
| `0` / `Home`, crown button | | Frame the queen (also the "Queen ↓" chip when she is off screen) |
| Arrow keys, `PgUp` / `PgDn` | Pan | Scroll and pan |
| Right-click or long-press | Context actions (cancels an active tool instead) | Context actions (cancels an active tool instead) |

View keys act on the canvas you clicked last. Anywhere: `1`–`9` open tabs, `Space` hand-forages the selected source,
`M` / `R` Mark or Rally the selected trail, `B` toggles the Backfill tool (nest view focused), `V` cycles the view (Above, Below, Stacked, Side by side; also the switcher under the map), and `Esc` cancels a
tool, clears the selection, then closes the panel drawer or lowers the panel sheet. **Settings → Keyboard and view
controls** lists the same keys in the game.

Red **warning chips** next to the bottleneck badge show active threats such as mold, floods or a footstep. Click one to
bring the spot into view.

## Folder map

```
index.html            DOM skeleton (ids are the contract with src/main.js)
styles/               base.css (layout, breakpoints, theme) and panels.css (panels, HUD, modals, toasts)
src/main.js           browser boot: storage, the one-tab lock, load or new game, UI, renderers, the frame loop, autosave
src/core/             state schema, fixed-step loop, commands, save/load, offline catch-up, RNG, hex maths
src/data/             every balance number and table (change numbers here, nowhere else)
src/systems/          game rules: population, jobs, nest digging, surface and trails, war, research, prestige, events
src/render/           canvas renderers for Above and Below, sprites, overlays, ceremonies, input
src/ui/               HUD and warning chips, panels (src/ui/panels/), tooltips, toasts, modals, welcome card, onboarding
tests/                node --test suites, named <prefix>.<topic>.test.js
tools/                serve.mjs, simulate.mjs (pacing bot), smoke.mjs, check-imports.mjs, meta-model.mjs
docs/DESIGN.md        the game design: rules, numbers, pacing targets (the rules and numbers win)
docs/ARCHITECTURE.md  the code contract: files and owners (§2), state (§4), interfaces (§8), commands (§9),
                      events (§10), unlocks (§11), rendering (§13), UI (§14), tests (§15), clarifications (§18)
```

Start with `docs/ARCHITECTURE.md` §1–§2 for the ground rules and the file layout. `docs/DESIGN.md` explains why each
number is what it is.
