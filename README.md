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
| `npm run check:imports` | Static import-graph check from `src/boot.js` (which loads `src/main.js`): every imported file and name exists. |
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

View keys act on the canvas you clicked last. Anywhere: `1`–`9` open tabs, `H` or `?` opens the in-game Manual (also the book icon by the tabs), `Space` hand-forages the selected source,
`M` / `R` Mark or Rally the selected trail; with a chamber selected `L` levels the cheapest of its type, `Shift+L` levels the selected one and `R` relocates it (`G` picks the growth side of older chambers that have no reserved space); `Q` over a chamber picks its type to place another (`Q` again puts the tool away); while placing, `F` or right-click picks the corner the new chamber starts in; `B` toggles the Backfill tool (nest view focused), `V` cycles the view (Above, Below, Stacked, Side by side; also the switcher under the map, whose ⇄ button swaps which side the map and nest sit on), and `Esc` cancels a
tool, clears the selection, then closes the panel drawer or lowers the panel sheet. **Settings → Keyboard and view
controls** lists the same keys in the game.

Red **warning chips** next to the bottleneck badge show active threats such as mold, floods or a footstep. Click one to
bring the spot into view.

## Patch notes

The game shows its version (for example **v0.9.0**) in Settings → Save and at the foot of the resource rail on wide screens; clicking it opens the in-game patch notes. After an update, returning players see a small "Updated to v0.9.0 — see what's new" pill (brand-new players do not). The last version a player has seen is kept in the browser (`localStorage` key `sld.lastSeenVersion`), not in the save.

**Every update must add a patch-notes entry.** Add one object at the **top** of `CHANGELOG` in `src/data/changelog.js` and bump its `version` (`MAJOR.MINOR.PATCH`: a minor bump per feature or feedback pass, a patch bump for small fixes). `CURRENT_VERSION` follows the first entry automatically, which is what makes the update pill appear for returning players.

```js
{ version: '0.10.0', date: '2026-10-05', title: 'Short title',
  sections: [{ heading: 'Nest', notes: ['What changed, in words a player understands.'] }] }   // or notes: [...]
```

Write for players: no clarification numbers (C123), file names or developer terms. Versions must be strictly descending and dates must not increase down the list; `tests/ui.patchNotes.test.js` checks both, plus the wording rules.

### Releasing and auto-update

GitHub Pages caches every file for 10 minutes (Netlify revalidates every request), and the game is over a hundred
separately cached ES modules, so right after a deploy a browser could load a mix of old and new files. The game guards
against that itself:

- **The version source of truth is the changelog.** There is no separate version file to keep in sync. `index.html`
  loads `src/boot.js`, which fetches `src/data/changelog.js` with `cache: 'no-store'` (the live version: the first
  `version: '…'` after `export const CHANGELOG`) and compares it with `CURRENT_VERSION` of the cached copy.
- **On a mismatch** it shows an "Updating to vX…" screen, re-downloads every game file with `cache: 'reload'`
  (`index.html`, its stylesheets and the whole import graph, walked at runtime from the module scripts) and reloads.
  At most one forced update per version per browser session (`sessionStorage` key `sld.updateAttempt`); if the
  versions still differ after that, the game starts anyway and logs a console warning. If `main.js` fails to load at
  all (a broken mixed set), one refresh per session is tried before the error screen. Saves are never touched.
- **While playing** the live version is checked every 10 minutes and when the tab becomes visible; a newer one shows an
  "Update available" pill that saves, refreshes and reloads.
- Offline, `file://`, or a check slower than 3 s: the game just starts.

So a release is still just: add the changelog entry (which bumps the version), merge, deploy. Keep the
`version: '…'` field literal in the newest entry (`tests/ui.updater.test.js` asserts the parsed text equals
`CURRENT_VERSION`). Any new module must be reachable through literal relative `import`/`export … from`/`import('…')`
paths (as `npm run check:imports` already requires), or the refresh will not re-download it.

Testing locally: `http://localhost:8080/?forceUpdateCheck=0.99.0` pretends v0.99.0 is live (honoured only on
localhost / 127.x / *.localhost): you see one update and reload, then a console warning and normal play; in the
console `sld.checkForUpdate()` shows the "Update available" pill. Run `sessionStorage.clear()` to try again.

## Folder map

```
index.html            DOM skeleton (ids are the contract with src/main.js); loads src/boot.js
styles/               base.css (layout, breakpoints, theme) and panels.css (panels, HUD, modals, toasts)
src/boot.js           entry: the pre-boot version check (src/ui/updater.js), then a dynamic import of src/main.js
src/main.js           browser boot: storage, the one-tab lock, load or new game, UI, renderers, the frame loop, autosave
src/core/             state schema, fixed-step loop, commands, save/load, offline catch-up, RNG, hex maths
src/data/             every balance number and table (change numbers here, nowhere else), and changelog.js (patch notes)
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
