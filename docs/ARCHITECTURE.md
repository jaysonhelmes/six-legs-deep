# SIX LEGS DEEP: Architecture and Implementation Contract

**Version 1.4** (polish and bug-hunt rounds: §18 C66–C90, §2 file map synced with the tree, §13 nest framing, zoom and locate API, §14 welcome card, warning chips, tab behaviour and the one-tab lock. v1.3, browser integration: §18 C63–C65, reveal queue order, Royal Chamber growth room, toast timing. v1.2, integration: §10 payload renames, §18 C48–C62 and the §18.1 register of accepted readings. v1.1 was reconciled with the post-balance-pass `DESIGN.md`: every number below matches DESIGN's current values; see §18 C31–C47 for the readings added in the reconciliation). Companion to `docs/DESIGN.md` (the game rules). This document is the **code contract** for the parallel build: about 8 programmers each own a disjoint set of files (work packages WP1–WP9, §16), and an integrator wires them together (§17). Every package must be writable **without seeing any other package's code**, so every shared shape, function signature, command, event and derived field is pinned here.

**Precedence.**
- Game rules and numbers: `DESIGN.md` wins. Code structure, file names, data shapes and interfaces: this document wins.
- Where `DESIGN.md` is ambiguous across package boundaries, this document pins a reading. All such decisions are listed in §18 ("Design clarifications"). If you find a new ambiguity, implement the most literal reading of DESIGN, add a `// ARCH-Q:` comment, and report it to the integrator (resolved readings are re-tagged `// ARCH-R:` and registered in §18.1).
- This document **supersedes** `DESIGN.md` §27.1 (file layout), the "typed array / `Map`" data shapes of §27.2 (the state is plain JSON, §4), and the file name `tools/pacing-bot.mjs` in §16 and §28 (it is `tools/simulate.mjs` here).

**Section map.** §1 ground rules · §2 files and owners · §3 dependency rules · §4 state schema · §5 derived cache · §6 data modules · §7 core runtime (loop, step, commands, save, offline) · §8 system interfaces · §9 command catalogue · §10 event catalogue · §11 unlock keys · §12 effect cross-reference (who implements which bonus) · §13 rendering · §14 UI · §15 testing and tools · §16 work packages · §17 integration · §18 design clarifications.

---

## 1. Ground rules (apply to every file)

1. **Language.** Plain JavaScript (ES2022) ES modules. No dependencies, no build step, no TypeScript, no bundler. Every import uses a **relative path with the `.js` extension** (`import { sc } from '../core/math.js';`). Node ≥ 22 for tests and tools (verified on Node 24).
2. **Layers.** `src/data` (constant tables) ← `src/core` (runtime spine and shared helpers) ← `src/systems` (game rules) ← `src/render` and `src/ui` (presentation). Imports may only point "left" in that chain, with the exceptions in §3.
3. **No ambient effects in `data`, `core` or `systems`.** Forbidden there: `window`, `document`, `localStorage`, `requestAnimationFrame`, `setTimeout`, `setInterval`, `Date.now()`, `performance.now()`, `Math.random()`. Wall-clock time is passed into `core/game.js` as a parameter, and storage is injected. All randomness goes through `core/rng.js`. `console.error` is allowed only in `core/guard.js`, `core/save.js` and `core/bus.js` (caught handler exceptions, §7.6).
4. **State is one plain JSON object** (§4). No class instances, no `Map`/`Set`, no typed arrays, no `undefined` values (use `null`), no `Infinity` or `NaN` (use the sentinel `-1` where the schema says so). `JSON.parse(JSON.stringify(s))` must deep-equal `s`.
5. **Derived data is separate** (§5). Caches, typed arrays, aggregates and per-tick rates live in the derived object `d`, which is never saved and can always be rebuilt from `s`.
6. **Who may mutate `s`.** Only code running inside `step()` (system `tick` functions and command `apply` handlers), plus `core/game.js` for wall-clock fields and whole-state replacement (load, import, reset). Render and UI code **never** writes `s`; it calls `game.actions.*` (§7.5). Query functions (§8) are pure: they never mutate `s` and write `d` only where documented.
7. **Write ownership.** Every state field lists its writer package in §4. A package writes a field it does not own **only through the helper named in §4** (for example resources through `core/wallet.js`, adult counts through `population.addAdults` and `population.killAdults`).
8. **Ids** are the DESIGN `snake_case` ids, verbatim. Display names live in the data tables (`name` fields) and in `src/ui/text.js`.
9. **Numbers** are JS doubles. Every rate, cap and cost goes through the helpers in `core/math.js` (`sc`, `scChain`, `clampNum`, `geoCost`). Every cost whose value is above `COST_MAX` (1e280) is reported as `null` (the UI shows **MAX**). Every stored number stays within `[0, 1e295]` (resources and counters) or within its documented range.
10. **Units.** Simulation time is seconds (`dt`, `run.time`, timers). Wall-clock milliseconds appear only in `meta.createdAt`, `meta.lastSeen` and `meta.savedAt`.
11. **Determinism.** The same seed plus the same command stream (commands keyed by tick index) must produce a deep-equal state. Iterate arrays, or the exported `*_ORDER` arrays of data tables, for every gameplay decision.
12. **Numbers live in data.** Every tunable number from DESIGN lives in `src/data/*.js` (§6). Logic modules import them; they never hardcode a balance number. Allowed literals in logic: 0, 1, array indices, and unit conversions (60, 1000).
13. **Style.** 2-space indent, semicolons, single quotes, `camelCase` functions and fields, `UPPER_SNAKE` exported constants. Each module starts with a 1–3 line header comment naming its responsibility and owner package. JSDoc on every export, using the typedefs in `src/core/types.js`.

---

## 2. Files, responsibilities and owners

`WPn` = work package (§16). `INT` = integrator. A file has exactly one owner. Nobody else edits it until integration (§17).

```
/                                   project root (served as the web root by tools/serve.mjs)
├─ index.html                       WP9  DOM skeleton; <script type="module" src="src/main.js">
├─ package.json                     WP1  {"type":"module"}, scripts only, zero dependencies (§15.1)
├─ README.md                        INT  how to run, test, simulate; folder map
├─ styles/
│  ├─ base.css                      WP9  design tokens (colours, type), page grid, breakpoints, canvas slots
│  └─ panels.css                    WP9  rail, HUD, tabs, panels, tooltips, toasts, cards, modals
├─ docs/  DESIGN.md, ARCHITECTURE.md
├─ src/
│  ├─ main.js                       WP9  browser boot: storage, game, renderers, UI, rAF loop, visibility, autosave
│  ├─ core/                         WP1 owns every file in core/
│  │  ├─ types.js                   JSDoc @typedefs only (State, Derived, Command, GameEvent, Cost, Effect, Target …); no runtime code
│  │  ├─ state.js                   SCHEMA_VERSION, createState(), createRun/createCycle/createEra(), defaultNestCells(), adultsTotal(), broodTotal(), consumeClick()
│  │  ├─ derived.js                 createDerived(): the derived skeleton with neutral defaults (§5)
│  │  ├─ step.js                    step(): fixed system order (§7.2)
│  │  ├─ game.js                    createGame(): owns s/d, command queue, fixed-step accumulator, catch-up, save/load/import/export, bus publishing
│  │  ├─ commands.js                command registry: merges every system's `handlers`; core handlers (setSetting, uiFlag, equipCosmetic)
│  │  ├─ actions.js                 createActions(game): UI-facing action functions (validate + enqueue)
│  │  ├─ bus.js                     createBus(): on/off/emit, wildcard
│  │  ├─ rng.js                     mulberry32 on a holder object; rand/int/pick/chance/weighted/fork
│  │  ├─ math.js                    sc, scChain, clampNum, geoCost, costOrNull, lvl, safeDiv, sumGeo, lerp
│  │  ├─ hex.js                     axial hex geometry: spiral index, neighbours, distance, rings, pixel conversion, generic A*
│  │  ├─ wallet.js                  canAfford, spend, grant, incomeSeconds, missing, timeToAfford, scaleCost
│  │  ├─ effects.js                 timed/persistent modifiers: addEffect, removeEffect, tickEffects, effectMult, effectAdd, hasEffect
│  │  ├─ guard.js                   NaN/Infinity guard and clamp pass
│  │  ├─ save.js                    encode/decode state, export string (SLD1), FNV-1a, base64 (UTF-8), RLE, storage wrapper
│  │  ├─ migrations.js              MIGRATIONS table, migrate(), fillDefaults()
│  │  ├─ offline.js                 offlineCapEff(), simulateOffline() chunked schedule, diapause banking, Saved Finds banking
│  │  └─ tablock.js                 createTabLock(): single-writer tab lock (newest tab owns the save; §7.16, C80)
│  ├─ data/                         constant tables, keyed by DESIGN ids (§6)
│  │  ├─ balance.js                 WP1  tick, clamps, softcaps, grid/hex geometry, offline, save, loop constants
│  │  ├─ castes.js                  WP2  castes: egg multipliers, extra costs, upkeep, combat stats, brood factors
│  │  ├─ jobs.js                    WP2  jobs, loose foraging, automation thresholds
│  │  ├─ economy.js                 WP2  egg cost, lay, brood, upkeep, hungry, nutrition, pheromone, caps, clicks, spoilage
│  │  ├─ adaptations.js             WP2  the 10 Adaptations
│  │  ├─ strata.js                  WP3  layers, microclimate, dig constants, nest geometry constants
│  │  ├─ chambers.js                WP3  the 16 chambers and adjacency rules
│  │  ├─ soilFeatures.js            WP3  roots, stones, caches, water pockets
│  │  ├─ surface.js                 WP4  map, terrain, scouting, trails, slots, abilities, territory, mound
│  │  ├─ sources.js                 WP4  every source type
│  │  ├─ rivals.js                  WP5  rival ladder, elder tiers, bosses, rival traits, spawn rules
│  │  ├─ combat.js                  WP5  battle model, war actions, tactical actions, raid rules, rewards
│  │  ├─ research.js                WP5  research branches, nodes, refinements, innate thresholds
│  │  ├─ seasons.js                 WP6  year, season modifiers, frost line
│  │  ├─ events.js                  WP6  random events, scheduler rules, golden bonuses, Saved Finds
│  │  ├─ achievements.js            WP6  81 achievements
│  │  ├─ fieldGuide.js              WP6  field guide entries with 40–60 word notes
│  │  ├─ unlocks.js                 WP6  reveal / unlock schedule (§11)
│  │  ├─ prestige.js                WP7  flight / supercolony / speciation formulas, hardships, landing sites, boons, edicts
│  │  ├─ bloodline.js               WP7  Bloodline traits
│  │  ├─ federation.js              WP7  Federation nodes
│  │  └─ genome.js                  WP7  Genome nodes, species, signature genes
│  ├─ systems/                      pure game rules (§8)
│  │  ├─ stats.js                   WP2  multiplier stacks (§12 of DESIGN), caps, lay rate, egg cost, dig W, click value, upkeep → d.stats
│  │  ├─ economy.js                 WP2  ledger → resources, softcaps, efficiency, caps, overflow, upkeep, Hungry, nutrition, fungus, pheromone, spoilage, f_run
│  │  ├─ population.js              WP2  laying, caste choice, cohorts, development, hatching, frost freeze/death, alate rearing, golden ants
│  │  ├─ jobs.js                    WP2  job pools, manual moves, age polyethism, response thresholds, consistency
│  │  ├─ adaptations.js             WP2  Adaptation costs and purchase
│  │  ├─ bottleneck.js              WP2  binding-constraint badge
│  │  ├─ nest.js                    WP3  nest derive (geometry caches, chamber effects), dig tick, nest commands, nest queries
│  │  ├─ nestgeom.js                WP3  footprints, layers, cell work, BFS, A*, adjacency, path distances
│  │  ├─ nestgen.js                 WP3  per-run nest generation (strata features)
│  │  ├─ mapgen.js                  WP4  per-run surface generation (terrain, sources, rival spawn specs, root columns)
│  │  ├─ surface.js                 WP4  surface derive (territory, slots), scouting, sources lifecycle, claims, mound, entrances
│  │  ├─ trails.js                  WP4  trail routing, strength, yields, worker allocation, pheromone abilities
│  │  ├─ combat.js                  WP5  unit stats, Army Power, stepped battles, closed-form previews
│  │  ├─ rivals.js                  WP5  rival lifecycle, war parties, raid/assault/hunt/bribe/tournament, bosses, conquest
│  │  ├─ raids.js                   WP5  rival raids on the player across both views
│  │  ├─ research.js                WP5  research purchase, prerequisites, refinements, innate grant
│  │  ├─ seasons.js                 WP6  season clock, season modifiers, frost depth → d.season
│  │  ├─ events.js                  WP6  event scheduler, pity rules, event cards, event processes and objects
│  │  ├─ golden.js                  WP6  Golden Beetle, Golden Pupa, Saved Finds gifts
│  │  ├─ achievements.js            WP6  achievement checks and progress, Next Goals
│  │  ├─ fieldguide.js              WP6  field guide unlock checks and insight payouts
│  │  ├─ unlocks.js                 WP6  unlock evaluation, reveal queue, next-unlock ribbon
│  │  ├─ prestige.js                WP7  d.meta (prestige multipliers, colony scale, projections), flight/supercolony/speciation flows, startRun
│  │  ├─ traits.js                  WP7  Bloodline / Federation / Genome purchases and costs
│  │  ├─ hardships.js               WP7  hardship start, tier detection, rewards bookkeeping
│  │  └─ automation.js              WP7  autobuyers, auto-flight, auto-supercolony, auto-rear, diapause spending
│  ├─ render/                       WP8 owns every file in render/
│  │  ├─ canvas.js                  layer creation, DPR (cap 2), ResizeObserver, offscreen helpers
│  │  ├─ geom.js                    pure geometry: cell↔pixel, hex↔pixel with camera, polyline distance, Catmull-Rom (unit-tested)
│  │  ├─ palette.js                 colours per season/stratum/terrain, colour-blind-safe patterns
│  │  ├─ atlas.js                   procedural sprite atlas (ants by caste × 8 rotations, brood, items, icons)
│  │  ├─ sprites.js                 typed-array sprite pools, largest-remainder allocation, per-frame update
│  │  ├─ camera.js                  surface pan/zoom (0.6–1.6) and default framing; nest fitted cell size, player zoom, scroll,
│  │  │                             horizontal pan past the width, default framing on the Royal Chamber (§13.5)
│  │  ├─ particles.js               rain, snow, leaves, soil pellets, chitin glints (≤ 300)
│  │  ├─ nestArt.js                 Below art helpers (pure painters): organic chamber outlines, wavy strata boundary, short
│  │  │                             chamber names, chamber contents (brood heaps, seed piles, fungus, repletes, alates, midden), mold
│  │  ├─ nestRenderer.js            Below canvas: strata cache, cells, chambers, brood, queen, dig face, frost line, ghosts,
│  │  │                             labels, camera buttons and queen chip, locate glide and ping
│  │  ├─ surfaceRenderer.js         Above canvas: terrain cache, fog, territory, trails, sources, rivals, parties, objects
│  │  ├─ overlays.js                climate, raid_reach, haul, adjacency, territory, trail_strength, danger, richness
│  │  ├─ battle.js                  battle bubbles (≤ 40 sprites per side)
│  │  ├─ ceremony.js                flight / supercolony / speciation ceremonies, welcome-back time-lapse
│  │  ├─ seam.js                    shaft connector between views; entrance despawn/respawn hand-off
│  │  ├─ minimap.js                 drawMiniMap() for landing-site previews and the nest minimap strip
│  │  ├─ nestInput.js               pointer/keyboard on the Below canvas → actions / uistate / bridge
│  │  └─ surfaceInput.js            pointer/keyboard on the Above canvas → actions / uistate / bridge
│  └─ ui/                           WP9 owns every file in ui/
│     ├─ app.js                     mountUI(): layout, breakpoints, tabs, 4 Hz refresh, bus subscriptions, keyboard, bridge (incl. locate)
│     ├─ uistate.js                 shared non-persisted UI store (tool, selection, hover, overlays, view)
│     ├─ dom.js                     h() element helper, text-node diffing, event delegation
│     ├─ reveal.js                  reveal-on-unlock helper (isShown, ALWAYS_KEYS, ?reveal=all switch) and safe readers (num, arr, obj)
│     ├─ format.js                  every number/time formatter (§14.3)
│     ├─ text.js                    labels, reason messages, event/toast copy, tooltip copy (≤ 12 words)
│     ├─ rules.js                   read-only rule explanations: Old Ridge immunity, Front window, satellite hexes (C81)
│     ├─ intro.js                   0:00 welcome card in the panel column and the medium/narrow coach line (§14.6)
│     ├─ hud.js                     resource rail, bottleneck badge, warning chips, season dial, next-unlock ribbon, flow strip, colony scale
│     ├─ tooltips.js                hover tooltips (DOM + canvas targets), "sc" badge details
│     ├─ toasts.js                  rate-limited toasts (≤ 2 per 10 s)
│     ├─ modals.js                  modal host (prestige confirms, hard reset, import, landing chooser)
│     ├─ eventCard.js               non-modal event card with timer and default choice
│     ├─ welcome.js                 welcome-back modal (stat lines, time-lapse trigger)
│     ├─ onboarding.js              one-glow-at-a-time, ghost-ant demo trigger, advisor pulse
│     └─ panels/
│        ├─ common.js               shared panel parts: action helper (dispatch + reject feedback), sub-tab strips, sliders, lists
│        ├─ colony.js  build.js  map.js  research.js  prestige.js
│        └─ achievements.js  guide.js  stats.js  settings.js
├─ tests/                           node --test; file prefix = owner (§15.2)
│  ├─ helpers.js                    WP1  newState(), stepFor(), fakeEnv(), makeDerived(), snapshot(), fake storage, fuzz/contract tables
│  ├─ fixtures/                     WP1  save_v1.txt (migration), mid_capbound.txt (12 h cap-bound, C70), late_21h.txt (21 h bot, C85/C87)
│  ├─ core.*.test.js                                  WP1  commands effects game guard hex math offline rng runtime save state step tablock wallet
│  ├─ integration.*.test.js                           WP1  contract deathPolicy derivePass determinism firstWorker fuzz offline offlineHarm
│  │                                                       offlineMid offlinePerf save saveSize
│  ├─ colony.*.test.js                                WP2  adaptations bottleneck data economy founding handlers income jobs laying population stats
│  ├─ nest.*.test.js                                  WP3  caches cross data derive dig gen geom handlers place royalroom
│  ├─ surface.*.test.js                               WP4  data handlers mapgen scouting sources territory trails
│  ├─ war.*.test.js, research.*.test.js               WP5  war: combat fallen fallenRaids fuzz mobilize raids rivals; research: tree
│  ├─ world.*.test.js                                 WP6  achievements eventfixes events fieldguide golden nextUnlock revealQueue seasons unlocks
│  ├─ meta.*.test.js                                  WP7  automation contractive derive flight formulas layers prestigeFixes simulate traits
│  ├─ render.*.test.js                                WP8  art camera geom renderers sprites
│  └─ ui.*.test.js                                    WP9  clarity dom format hud metaFixes qaFixes text toasts uistate
└─ tools/
   ├─ serve.mjs                     WP1  zero-dependency static server, port 8080 (§15.1)
   ├─ simulate.mjs                  WP7  headless pacing bot; time-to-milestone report (§15.4)
   ├─ meta-model.mjs                WP7  analytic prestige meta-model (prestige_contractive, Twenty Quadrillion)
   ├─ smoke.mjs                     INT  headless 40-minute play smoke test (§15.1)
   ├─ check-imports.mjs             INT  static import-graph check from src/main.js (§15.1)
   └─ make-saves.mjs                INT  test-save generator: bot saves at 4 key points → test-saves/ (npm run saves)
```

---

## 3. Dependency rules

```
 data/*  ─────────────►  core/*  ─────────────►  systems/*  ─────────────►  render/*, ui/*
 (no imports except       (imports data, core)    (imports data, core,        (import data, core/{hex,math,
  other data files)                                listed system exports)       format-free helpers}, systems'
                                                                                QUERY exports; never handlers)
                core/step.js, core/commands.js import systems/*  (the spine)
                core/game.js imports core/step.js, core/commands.js, systems/prestige.js#startRun/newGame
                main.js imports core/game.js, render/*, ui/*
```
- A system module may import another system module **only** for the exports this document lists as cross-callable (marked **[x]** in §8). Never import a system's `tick`, `derive` or `handlers` from another system.
- Systems must never import `core/step.js`, `core/commands.js`, `core/game.js` or `core/actions.js` (they form the spine and would create cycles).
- Render and UI may call system **query** functions (marked **[q]** in §8). They must never call `tick`, `derive`, handlers, or any **[x]** mutator.
- Render and UI may import these pure core helpers: all of `core/hex.js` and `core/math.js`; from `core/state.js` only `adultsTotal`, `broodTotal`, `popN`, `clickAvailable`; from `core/wallet.js` only `canAfford`, `missing`, `incomeSeconds`, `timeToAfford`; from `core/effects.js` only `effectMult`, `effectAdd`, `hasEffect`, `effectsFor`. Nothing else from `core/` except the `game` object API (§7.1) and `core/bus.js` subscriptions.
- `core/offline.js` reads data tables from WP3/WP5/WP7 data files (allowed: data is the bottom layer) and calls `step` and `seasons.skipTime` (it is part of the spine).

---

## 4. Game state schema (`s`)

`core/state.js#createState({ seed = 1 } = {})` returns **exactly** this shape with these defaults. The state is split by **reset scope**, so every prestige reset is a subtree replacement:

| Subtree | Reset by | Created by |
|---|---|---|
| `s.meta` | never | `createState` only |
| `s.era` | Speciation | `createEra()` |
| `s.cycle` | Supercolony (and Speciation) | `createCycle()` |
| `s.run` | Nuptial Flight (and every higher reset) | `createRun(seed)` |

`createRun(seed)` returns a **minimal playable skeleton**: the default nest grid (main shaft + Royal Chamber), an all-grass surface of radius 16 with rings 0–2 revealed, the `crumb_scatter` source at hex 3 and one forager trail to it. Unit tests use this skeleton directly. Real games replace the map, nest features and rivals through `prestige.startRun()` (§8.6), which calls `mapgen`, `nestgen` and `rivals.spawnInitial`.

Comment legend: `// type — writer`. "via X" means other packages may write only through helper X.

```js
{
  v: 1,                        // number — SCHEMA_VERSION; WP1
  rng: 1,                      // uint32 mulberry32 state; createState sets (seed >>> 0) || 1 — any, via core/rng.js

  meta: {                      // ===== never reset =====
    createdAt: 0, lastSeen: 0, savedAt: 0,   // wall-clock ms — WP1 game.js
    tick: 0,                   // int, ticks simulated all-time — WP1 step.js
    simTime: 0,                // seconds simulated all-time — WP1 step.js
    settings: {                // WP1 (core handler setSetting)
      notation: 'suffix',      // 'suffix' | 'scientific' | 'engineering'
      autosaveSec: 15,         // 15 | 30 | 60 | 0 (0 = off; still saves on hide and before prestige)
      reducedMotion: false,
      sound: false,
      harshNature: false,      // DESIGN §3 death policy option
      retreatAt: 0.6,          // battle auto-retreat when losses ≥ this fraction
      colonyName: '', queenName: '',
      showScaleLabel: true,    // "1 ● = K ants" labels
    },
    pending: null,             // PendingChoice | null — WP7 (flight landing chooser; step pauses the run while set)
    season: { t: 0, year: 0, lengthSec: 360, extraSpring: 0 },
                               // t = seconds into the current year; extraSpring = bonus spring seconds left (boon_long_spring) — WP6
                               // optional start: Chronobiology starting season applied at each run start (C84)
                               // (WP7 writes only via seasons.setSeason / seasons.addExtraSpring)
    seen: {},                  // unlockKey -> true: UI reveal already shown (persists across runs) — WP6
    reveal: { queue: [], lastAt: -1e9 },     // queued reveal keys (strings); simTime of the last reveal — WP6
    achievements: {},          // achId -> simTime earned — WP6
    fieldGuide: {},            // fgId -> simTime unlocked — WP6
    genes: 0, genesLife: 0,    // genes_life — WP7
    genome: {},                // genomeId -> level — WP7
    speciesUnlocked: { garden_ant: true },   // WP7
    signatureGenes: {},        // sig_* -> true — WP7
    diapause: { bank: 0, active: false },    // bank seconds — WP1 offline.js adds, WP1 game.js drains while active; WP7 automation toggles `active`
    savedFinds: 0,             // banked Saved Finds (max 3) — WP1 offline.js adds; WP6 golden.js consumes
    strata: [],                // StrataRecord[], newest last, max 12 — WP7
    cosmetics: { owned: {}, equipped: {} },  // owned: id -> true (WP6 grants); equipped: slot -> id (WP1 core handler equipCosmetic)
    automation: {              // WP7 (handler setAutomation) except jobPresets (WP2)
      autobuy: { on: false, adaptations: true, chambers: true, mound: true, priority: ['adaptations', 'chambers', 'mound'] },
                               // priority = order tried each 1 Hz autobuy pass (DESIGN §14.5 "priority sliders"; the UI reorders it)
      autoFlight: { on: false, mode: 'peak', alates: 0, minutes: 30 },   // mode 'peak' | 'alates' | 'minutes'
      autoSuper: { on: false, mode: 'kinship', kinship: 0, hours: 6 },  // mode 'kinship' | 'hours'
      autoGuard: false,        // early_warning auto-guard (read by WP5 raids)
      autoRear: false,         // auto-rear alates (read by WP2 population)
      jobPresets: [],          // [{ name, targets: {job: frac} }] max 3 (hive_mind) — WP2
      keep: { jobTargets: null, casteTargets: null },
                               // last targets the player set (copies of run.colony.jobTargets / casteTargets), written by the WP2
                               // handlers setJobTargets / setCasteTargets; WP7 startRun copies them into the new run when
                               // automaton_instincts / automated_brood are owned (C39) — WP2
    },
    counters: {                // lifetime, monotonic
      runs: 0, flights: 0, supercolonies: 0, speciations: 0, alatesLife: 0, kinshipEver: 0,   // WP7
      clicks: 0, queenClicks: 0,                                   // WP1 consumeClick (clicks), WP2 (queenClicks)
      cellsDug: 0, caches: 0, amber: 0, relocations: 0,            // WP3
      battlesWon: 0, conquests: 0, tournamentsWon: 0,              // WP5
      beetles: 0, moldScraped: 0, ladybugs: 0, rainstorms: 0, moleTunnels: 0, events: 0,   // WP6
    },
    stats: {                   // lifetime records (Stats tab)
      foodEver: 0,             // WP2 economy + core/wallet.js grant
      deepestRow: 0,           // WP3
      longestTrail: 0,         // WP4 (hexes)
      largestBattle: 0,        // WP5 (units engaged, both sides)
      fastestFlightSec: 0,     // WP7 (0 = none yet)
      firstFlightAt: 0, firstSuperAt: 0, firstSpecAt: 0,   // simTime; 0 = never — WP7
      nanGuards: 0,            // WP1 guard
    },
    onboarding: { done: {} },  // hintKey -> true — WP1 core handler uiFlag (dispatched by WP9)
    flags: { clockSkew: false, endingSeen: false },       // WP1 (clockSkew), WP7 (endingSeen)
  },

  era: {                       // ===== reset at Speciation =====
    species: 'garden_ant',     // WP7
    kinship: 0,                // unspent — WP7
    kinshipLife: 0,            // DESIGN kinship_life == kinship_era — WP7
    federation: {},            // fedId -> level — WP7
    heirlooms: [],             // ≤ 3 trait ids kept through Supercolonies — WP7
    innate: {},                // researchId -> true — WP7
    researchRuns: {},          // researchId -> number of runs it was owned at Flight — WP7
    hardshipBest: {},          // hardshipId -> best tier this era (carried at 50 % across Supercolonies) — WP7
    blueprints: [],            // Blueprint[] (1 slot; 5 with blueprint_memory) — WP3
    activeBlueprint: -1,       // index into blueprints or -1 — WP3
    startedAt: 0,              // simTime — WP7
  },

  cycle: {                     // ===== reset at Supercolony =====
    alates: 0,                 // unspent — WP7
    alatesCycle: 0,            // DESIGN alates_cycle — WP7
    traits: {},                // traitId -> level — WP7
    hardshipTier: {},          // hardshipId -> best tier this cycle — WP7
    edict: null,               // edict id chosen at the merge that began this cycle — WP7
    daughters: [],             // [{ seed, alates }] newest last, max 8 — WP7
    startedAt: 0,              // simTime — WP7
  },

  run: {                       // ===== reset at Nuptial Flight =====
    index: 0,                  // lifetime run number (0 = first run) — WP7
    seed: 1, mapSeed: 1,       // uint32 — WP7
    time: 0,                   // seconds since run start — WP1 step.js
    hardship: null,            // hardship id | null — WP7
    landingTags: [],           // site_* ids — WP7
    boon: null,                // boon_* id | null — WP7
    res: { food: 5, soil: 0, insight: 0, pheromone: 0, chitin: 0, honeydew: 0, leaves: 0, fungus: 0 },
                               // WP2 economy tick; anyone via core/wallet.js (spend / grant);
                               // exception: WP7 startRun adds Founding Stores food/soil DIRECTLY (may exceed the cap, DESIGN §13.7; not counted in fRun)
    fRun: 0,                   // DESIGN f_run — WP2 economy; anyone via wallet.grant (food)
    tPeak: 0,                  // peak owned hexes this run — WP4

    colony: {
      adults: { minor: 0, soldier: 0, supermajor: 0, replete: 0 },   // doubles — WP2; others via population.addAdults / killAdults
      alatesReared: 0,         // reared alates waiting in cells — WP2
      brood: [],               // Cohort[] — WP2; others via population.killBrood / stealBrood
      layAcc: 1,               // fractional eggs due; starts at 1 so the first egg is laid at 0:00 (DESIGN §5.3) — WP2
      eggs: { minor: 0, soldier: 0, supermajor: 0, replete: 0, alate: 0 },   // laid this run, by caste — WP2
      naniticsLeft: 5,         // half-price eggs left (WP7 sets 25 at run start with nanitic_vigor) — WP2
      rearRequested: 0,        // alate eggs requested via rearAlate, not yet laid — WP2
      casteTargets: { soldier: 0, supermajor: 0, replete: 0 },       // fractions, sum ≤ 0.9 — WP2
      eggReserve: 0,           // fraction of food cap, 0..0.9 — WP2
      fungalBrood: false,      // WP2
      hungry: false,           // WP2
      phi: 0,                  // nutrition ratio φ from last tick — WP2
      golden: 0,               // golden workers alive (golden_brood) — WP2
      jobs: { forager: 0, digger: 0, nurse: 0, scout: 0, herder: 0, leafcutter: 0, gardener: 0 },
                               // doubles; idle = adults.minor − Σjobs − militia — WP2; others reduce minors only via population.killAdults
      jobTargets: { forager: 0.6, digger: 0.2, nurse: 0.1, scout: 0.1, herder: 0, leafcutter: 0, gardener: 0 },  // WP2
      autoJobs: false,         // age_polyethism ratio mode on — WP2
      thresholdJobs: false,    // response_thresholds mode on — WP2
      militia: 0,              // minors committed to a fight or tournament (not working) — WP5
    },

    nest: {
      rev: 1,                  // ++ on ANY change of cells/chambers/shafts (derive caches key on it) — WP3
      cells: [/* 3200 */],     // CELL codes (§6.1), index = y * 40 + x — WP3 (initial grid from core/state.js defaultNestCells())
      chambers: [ /* Chamber, uid 1 = Royal Chamber: */
        { uid: 1, type: 'royal_chamber', k: 0, x: 18, y: 20, w: 4, h: 2, level: 1, target: 1, status: 'active', blueprint: false, bornAt: 0 } ],
      nextUid: 2,              // WP3 (uids shared by chambers and dig jobs)
      queue: [],               // DigJob[] — WP3
      features: { caches: [], water: [], roots: [] },   // CacheFeature[], WaterPocket[], RootLine[] — WP3
      backfill: [],            // [{ i: cellIdx, t: secondsLeft }] — WP3
      shafts: [ { kind: 'main', col: 20, open: true, ref: -1 } ],   // kind 'main' | 'nuptial' | 'satellite'; ref = satellite index or -1 — WP3
      maint: 0,                // cumulative maintenance work (stat) — WP3
      deepestRow: 21,          // WP3
    },

    surface: {
      rev: 1,                  // ++ on terrain / revealed / claimed / conquered / entrances / trail paths / rival land change — WP4
                               // (WP5 bumps only via surface.conquerHexes, surface.grantHex, surface.touch)
      radius: 8,               // current map radius — WP4
      terrain: [/* 817 */],    // terrain codes (§6.4), index = hex spiral index (§7.10) — WP4
      revealed: [/* 817 */],   // 0 | 1 — WP4
      claimed: [/* 817 */],    // 0 | 1 — WP4 (WP5 via surface.grantHex for won tournaments)
      conquered: [/* 817 */],  // 0 | 1 — WP4 (WP5 via surface.conquerHexes)
      flagged: [],             // hex indices flagged for scouting — WP4
      scout: { target: -1, prog: 0 },   // current frontier target and accumulated scout-seconds — WP4
      sources: [ /* Source; skeleton: */
        { uid: 1, type: 'crumb_scatter', hex: 3, stock: -1, max: -1, level: 1, herdT: 0, age: 0, ttl: -1, cd: 0, data: {} } ],
                               // WP4; WP5 writes `cd` (raid/hunt cooldown) and sets stock 0 on a finished hunt; WP6 via surface.spawnSource
      trails: [ /* Trail; skeleton: */
        { uid: 2, origin: 0, src: 1, path: [0, 3], len: 1, job: 'forager', workers: 0, escorts: 0, S: 0, born: 0, reroutes: [] } ],
                               // WP4; WP5 via trails.hitTrail (escorts are set by the WP4 assignEscorts handler)
      nextUid: 3,              // WP4 (uids shared by sources and trails)
      claims: 0,               // number of hexes ever claimed this run (claim cost exponent) — WP4
      channel: null,           // { hex, paid, cost } | null — WP4
      mound: 0,                // mound level — WP4
      entrances: [ { kind: 'main', hex: 0, col: 20, ref: -1 } ],
                               // kind 'main' | 'nuptial' | 'satellite' | 'outpost'; ref = rival uid for outposts, satellite index, or -1 — WP4
      spawn: { insect: 180, prey: 360, boonPrey: 0 },   // seconds to next random spawn; boonPrey = boon_rich_prey timer — WP4
      cd: { mark: 0, rally: 0, frenzy: 0 },             // ability cooldowns (s) — WP4
    },

    rivals: { list: [], nextUid: 1, respawn: [], topTier: 0 },
                               // Rival[]; respawn: [{ in: seconds, tier }]; topTier = highest tier conquered this run — WP5
    war: { parties: [], battles: [], raids: [], triage: [], nextUid: 1 },
                               // Party[], Battle[], Raid[], [{ t, soldier, supermajor }] field-triage returns — WP5

    events: {
      nextIn: 480,             // seconds to the next event roll (first run: the scripted fruit fires at run.time 480) — WP6
      recent: [],              // polarities of the last 3 events: 'pos' | 'neg' | 'mix' — WP6
      lastNegAt: -1e9,         // run.time of the last negative event — WP6
      card: null,              // EventCard | null — WP6
      active: [],              // ActiveEvent[] — WP6
      objects: [],             // EventObject[] — WP6
      scripted: false,         // first-run scripted fruit already fired — WP6
      seedMastYear: -1,        // year of the last seed mast — WP6
      nextUid: 1,
    },
    golden: { beetleIn: 0, beetle: null, pupa: null, lastPupaAt: -1e9, gifts: [] },
                               // beetle {hex, t} | null; pupa {chamber: uid, t} | null; gifts [{ hex }] — WP6
                               // (beetles appear only while unlock 'golden_beetle' is set, i.e. from run 1 at 5:00)
    effects: [],               // Effect[] — anyone via core/effects.js
    research: {},              // researchId -> 1 — WP5 (research.grantInnate is called by WP7 at run start)
    refinements: {},           // branchId -> level — WP5
    adaptations: {},           // adaptationId -> level — WP2
    unlocked: {},              // unlockKey -> true (gameplay availability, §11) — WP6
    bottleneck: { id: null, since: 0, capT: 0 },   // id = bn_* | 'raid' | 'frost' | 'hungry' | null; capT = seconds food ≥ 99 % cap — WP2
    prestige: { peakRate: 0, peakAt: 0 },          // alates/min peak tracking — WP7
    clicks: { sec: -1, n: 0 }, // click-cap bucket: integer run second and clicks counted in it — WP1 consumeClick
    stats: {                   // per-run counters
      eggs: 0, hatched: 0, soldiersRaised: 0, maxAdults: 0, foodWasted: 0, hungryEver: false, winterHungry: false,  // WP2
      cellsDug: 0, chambersDone: 0, relocations: 0,                  // WP3
      sourcesDepleted: 0,                                            // WP4
      battles: 0, battlesWon: 0, conquests: 0, kills: 0, raidsIncoming: 0,   // WP5 (raidsIncoming ++ on every raidWarning)
      eventsSeen: 0,                                                 // WP6
    },
  },
}
```

### 4.1 Sub-shapes

```js
/** Cohort (brood) */             { c: 'minor', n: 3, p: 0.0, t: 0 }
// c: 'minor'|'soldier'|'supermajor'|'replete'|'alate'; n: count (double ≥ 0); p: progress 0..1; t: integer run second laid.
// Cohorts with the same c and t merge.

/** Chamber */
{ uid, type, k, x, y, w, h, level, target, status, blueprint, bornAt }
// type: chamber id; k: instance index (0-based order of placement among live chambers of that type; recomputed on demolish);
// x,y,w,h: current footprint rect in cells; level: effective level (0 while first being dug);
// target: level being dug toward (target > level while 'growing'); status: 'digging'|'active'|'growing'|'relocating';
// blueprint: placed from a blueprint (−50 % placement food, faster cells); bornAt: run.time placed.

/** DigJob */
{ uid, kind, chamber, cells, cur, prog, paidFood, blueprint }
// kind: 'tunnel'|'chamber'|'grow'|'shaft'|'relocate'; chamber: chamber uid or 0;
// cells: cell indices in dig order (each adjacent to an open cell or to an earlier cell of the list);
// cur: index of the next undug cell; prog: work already spent on cells[cur]; paidFood: food refunded on cancel.

/** CacheFeature */ { i: cellIdx, kind: 'seed_cache'|'beetle_husk'|'fossil'|'amber_bead', found: false, hinted: false }
// hinted: forced visible as a hint (ev_mole_tunnel) regardless of distance; d.nest.hints = unfound caches that are hinted or within the hint radius
/** WaterPocket */  { x, y, w, h, revealed: false }
/** RootLine */     { col, y0, y1 }          // vertical root at column col from row y0 (= 1) down to row y1 (6..25)

/** Source */
{ uid, type, hex, stock, max, level, herdT, age, ttl, cd, data }
// stock/max: -1 = infinite; level: aphid colony level 1..3 (1 otherwise); herdT: seconds herded ≥ 50 % toward the next level;
// age: seconds since spawn; ttl: seconds until despawn or -1; cd: raid/hunt cooldown (s); data: type-specific, {} by default.

/** Trail */
{ uid, origin, src, path, len, job, workers, escorts, S, born, reroutes }
// origin: hex of an entrance/outpost/satellite or (trunk_trails) any hex of another trail; src: source uid;
// path: hex indices origin..source hex; len: DESIGN d (sum of move costs of path hexes after the first, ×0.9 with double_bridge);
// job: 'forager'|'herder'|'leafcutter'|'lycaenid' (lycaenid trails carry no workers; they pay only while escorts ≥ 5, §8.3);
// workers: explicitly assigned workers; escorts: soldiers assigned;
// S: trail strength; born: run.time; reroutes: run.time stamps of the last 20 reroutes (ach_overthinker).

/** Rival */
{ uid, type, tier, hex, radius, base, n, atk, hp, traits, alive, sighted, raidIn, truce, bribeCd, tourCd, creepIn, group, fallenAt, extra, lost, stolen }
// type: rival id or boss id; base: base soldiers; n: current soldiers (double); atk/hp: per-unit stats;
// traits: trait ids; sighted: nest hex revealed; raidIn: seconds to next raid roll; truce/bribeCd/tourCd: seconds;
// creepIn: fire-ant creep timer (s); group: 0, or the shared id of the 3 great_rival nests; fallenAt: run.time conquered or -1;
// extra: hexes gained by border_creep; lost: hexes lost to tournaments; stolen: pupae stolen by slave-makers (returned ×3 on conquest).
// Rival land = disc(hex, radius) ∪ extra − lost.

/** Party (war party on the march) */
{ uid, kind, target, soldier, supermajor, path, pos, state }
// kind: 'raid'|'assault'|'hunt'|'termite'|'guard'|'reinforce'; target: { type: 'rival'|'source'|'raid'|'battle', uid };
// path: hex indices from the origin entrance; pos: float index along path; state: 'out'|'fighting'|'home'.

/** Battle */
{ uid, kind, hex, below, party, raid, you, foe, start, f, homeMult, acc, t, rally, retreatAt, reward, tag, odds }
// kind: 'raid'|'assault'|'hunt'|'termite'|'trail'|'border'|'gate'|'army'|'escalate'; hex: surface hex (−1 if none);
// below: true for the gate fight (drawn in the Below shaft); party/raid: uids or 0;
// you: { militia, soldier, supermajor } current counts; foe: { n, atk, hp } current;
// start: { you, foe } total units at start; f: { you, foe } fortunes; homeMult: effective home bonus on the defender;
// acc: 4 Hz accumulator; t: seconds elapsed; rally: alarm-rally seconds left; retreatAt: loss fraction;
// reward: RewardSpec | null (§8.4); tag: originator key (e.g. 'ev_army_ant_column');
// odds: closed-form win chance (combat.preview) computed BEFORE fortunes are rolled (ach_david_and_goliath).
// Optional extra fields (C73, §18.1): mob: { n, forager } — the Mobilize draft (militia drafted, of which from foragers), returned by
// combat.releaseMobilized when the 20 s window or the battle ends; rival, esc, lost (WP5 readings).

/** Raid (incoming rival raid) */
{ uid, rival, target, raiders, warn, phase, guard }
// target: { type: 'trail', uid } | { type: 'nest' }; raiders: soldiers; warn: seconds of warning left;
// phase: 'warning'|'trail'|'border'|'gate'|'done'; guard: garrison dispatched.

/** Effect (core/effects.js) */
{ id, stat, mult, add, scope, t }
// id: unique source key (e.g. 'ev_queens_vigor', 'rally:12', 'mold:7'); stat: StatKey (§7.7);
// mult: multiplier (default 1); add: additive amount (default 0); scope: null | string | number;
// t: seconds remaining, or -1 = until removed.

/** EventCard */    { uid, id, t, choices, data }    // t: seconds left to choose; choices: e.g. ['adopt', 'devour']
/** ActiveEvent */  { uid, id, t, data }              // an event process still running (cordyceps spread, phengaris …)
/** EventObject */  { uid, kind, hex, cell, t, data } // clickable/visible object; kinds in §8.5; hex or cell = -1 when unused

/** PendingChoice (flight landing) */
{ kind: 'landing', options: [ { seed, tags: ['site_…'] } ×3 ], boons: ['boon_…' ×3], chooseSeason: false, alates: 0, hardship: null, carryAdults: 0 }
// hardship: hardship id carried into the next run when the flight was started by startHardship, else null
// carryAdults: adults kept by brood_bank (set by the flight, consumed by chooseLanding → startRun; flights and hardship starts only)

/** StrataRecord */ { kind: 'run'|'cycle'|'era', cells: 'bits-string', at: simTime }   // packed open-cell silhouette (C85)
/** Blueprint */    { name, chambers: [ { type, x, y, w, h, level } ], tunnels: [cellIdx] }
```

### 4.2 Default nest grid and skeleton surface
`core/state.js#defaultNestCells()` returns a 3,200-element array, all `CELL.SOIL` (0), except: column 20, rows 0–19 = `CELL.TUNNEL` (main shaft); rows 20–21, columns 18–21 = `CELL.CHAMBER` (Royal Chamber). The skeleton surface has `terrain` = 817 × `0` (grass), `revealed[i] = 1` for `i < 19` (rings 0–2), `claimed` and `conquered` all 0.

### 4.3 Shared state helpers (`core/state.js`, WP1)
```js
export const SCHEMA_VERSION = 1;
export function createState({ seed = 1 } = {}) → State
export function createRun(seed) → State['run']      // the skeleton above
export function createCycle() → State['cycle']
export function createEra() → State['era']
export function defaultNestCells() → number[]
export function adultsTotal(s) → number   // minor + soldier + supermajor + replete (excludes alates). DESIGN "adults".
export function broodTotal(s) → number    // Σ cohort n
export function popN(s) → number          // DESIGN N for egg cost: adultsTotal + alatesReared + broodTotal
export function clickAvailable(s) → boolean // pure: true if fewer than 15 clicks are counted in floor(run.time) (for validate())
export function consumeClick(s) → boolean // 15/s cap: returns false if 15 clicks are already counted in floor(run.time);
                                          // otherwise counts it (run.clicks, meta.counters.clicks) and returns true (for apply())
```

---

## 5. Derived cache (`d`)

`d` holds everything recomputable: aggregates, multipliers, rates, geometry caches (typed arrays allowed here). It is created by `core/derived.js#createDerived()` with the **neutral defaults shown below**, so any package can unit-test its system by hand-filling the upstream subtrees it reads. `d` persists across ticks (systems may rely on last tick's values, e.g. `d.rates.food.gross` for "seconds of income"), except `d.ledger`, which `step()` resets every tick. After load/import/reset, `game.js` calls `createDerived()` again and runs one zero-dt derive pass.

Each subtree has **one writer**:

| Subtree | Writer | Written in |
|---|---|---|
| `d.ledger` | WP4 (trails, surface), WP2 (economy passives) | `trails.tick`, `economy.tick` |
| `d.season` | WP6 | `seasons.tick` |
| `d.meta` | WP7 | `prestige.derive` |
| `d.nest` | WP3 | `nest.derive`, `nest.tick` (digFace, queueInfo) |
| `d.surface` | WP4 | `surface.derive`, `trails.tick` (`d.surface.trails`) |
| `d.stats` | WP2 | `stats.recompute` |
| `d.rates` | WP2 | `economy.tick` |
| `d.combat` | WP5 | `rivals.tick` |
| `d.progress` | WP6 | `unlocks.tick`, `achievements.tick` |
| `d.offlineLog` | WP1 creates/clears; WP3 appends | `offline.js`, `nest.tick` |

```js
createDerived() → {
  ledger: { food: {}, honeydew: {}, leaves: {}, chitin: {}, insight: {}, fungus: {} },
      // per-tick RATE contributions (units per second, before softcap and before offline efficiency), keyed by label.
      // Labels: food.trails, food.loose, honeydew.trails, honeydew.flower, honeydew.lycaenid, chitin.trails, leaves.trails (WP4);
      //         insight.library, honeydew.pens, fungus.gardens (WP2). One-shot amounts never go in the ledger (use wallet.grant).

  season: {                                   // WP6
    id: 'spring', index: 0, year: 0, tIn: 0, toNext: 360, len: 360,
    mild: false,                              // the current winter is the mild year-0 winter
    frostRow: 0,                              // current frost depth f (0 outside winter). A chamber is EXPOSED when more than half of its cells have y < frostRow
    frostMax: 0,                              // F_max of this winter after thermoregulation and mound reductions (min 4)
    snapRow: 0,                               // while ev_frost_snap is active: rows y < snapRow freeze brood (no ×0.5 effect penalty)
    forecast: { next: 'summer', inSec: 360, weather: null },   // weather: event id due within 60 s (seasonal_clock/weather_sense) or null
    mods: { forage: 1, lay: 1.25, broodTime: 0.8, dig: 1, insight: 1, foodCap: 1, rivalAggro: 1.25, rivalDormant: false, flightW: 1, puddlesBlock: true },
                                              // mods.forage is the BASE season factor; in winter it is 0.3 (0.6 mild) BEFORE the R reduction (WP2 applies R)
                                              // for dt > 0, mods describe the clock interval the step covered (time-weighted across a season boundary;
                                              // booleans follow the season that covered most of it); id/srcId/frost/forecast describe the clock after the step (C50)
    srcId: 'spring',                          // key for SOURCES[type].season lookups (trail yields, prey rewards): = id, except 'neutral'
                                              // (every source factor 1) during the autumn of edict_of_long_summer, whose mods.foodCap is also 1 (C38)
  },

  meta: {                                     // WP7 (composition pinned in §8.6)
    colonyScale: 1, lineage: 1, K: 0, G: 0, achCount: 0, achMult: 1, census: 0,
    prestige: { food: 1, dig: 1, insight: 1, honeydew: 1, leaves: 1, fungus: 1, chitin: 1, lay: 1, ap: 1, alates: 1 },
    hardship: { eternal_winter: 0, claustral_founding: 0, pacifist: 0, barren_ground: 0, shallow_soil: 0, monomorphic: 0 },
                                              // effective reward tiers (may be fractional: 50 % carry)
    species: 'garden_ant', sp: { /* copy of SPECIES[species].mods, §6.7 */ },
    edict: null,                              // active edict id or null
    proj: { alates: 0, perMin: 0, kinship: 0, genes: 0,
            fly:    { ok: false, royal5: false, prep: false, chamber: false, fRun: false },
            superc: { ok: false, budding: false, alates: false, oldRidge: false },
            spec:   { ok: false, megacolony: false, front: false, kinship: false } },
  },

  nest: {                                     // WP3
    rev: 0,                                   // s.run.nest.rev at the last geometry rebuild
    chamberAt: new Int16Array(3200).fill(-1), // chamber ARRAY INDEX (into s.run.nest.chambers) per footprint cell, −1 none
    open: new Uint8Array(3200),               // 1 = open cell (TUNNEL, or CHAMBER cell already dug)
    dist: new Int16Array(3200).fill(-1),      // BFS path cells over open cells from the main shaft top (x 20, y 0); −1 unreachable
    entDist: new Int16Array(3200).fill(-1),   // BFS path cells from the nearest OPEN shaft top (any entrance); −1 unreachable
    chambers: [],                             // parallel to s.run.nest.chambers:
        // { uid, layer, exposed, snap, eff, minEntPath, inReach, adj: [uid], hygiene, cellsDug, cellsTotal }
        // eff = location multiplier: ventilation × frost (0.5 if exposed, not frost-immune) × aquifer 1.2 × mold/flood/rain effects × hygiene 0.8
    agg: {
      housingBase: 10,                        // 10 (Royal) + Σ gallery_housing(L) × loam 1.1 × eff
      broodGroups: [ { kind: 'royal', uid: 1, cap: 3, factor: 1, exposed: false, snap: false, inReach: false } ],
          // kind 'royal' | 'nursery' | 'hib'. cap = RAW slots (WP2 multiplies by colonyScale).
          // factor = (1 + adjacency + microclimate) × eff for nurseries; 1 for royal and hib. Royal and hib are never exposed.
      berthsBase: 0, repleteBerthsBase: 0,    // 8 × Σ barracks L × eff ; 5 × Σ repletion L × eff
      alateCells: 0,                          // 10 + 5 × (nuptial L − 1), max 25 (50 royal_court); 0 without an active Nuptial Chamber
      granaryCap: 0,                          // Σ 300 × 1.65^(L−1) × layer modifier × eff × (1.1 ach_seed_bank). Royal 150 NOT included
      clayFoodShare: 0,                       // share of total storage (150 + granaryCap) in clay granaries (0 with ventilation_shafts)
      reachStorageShare: 0,                   // share of total storage in granaries with any cell within 15 path cells of an entrance
      nearestGranaryUid: 0,                   // granary closest (entDist) to an entrance; theft fallback
      haulH: 0.83,                            // DESIGN h for trails starting at main or nuptial entrances
      libraryInsight: 0,                      // Σ 0.05 × L × (1.25 gravel or deeper) × (1.10 royal-adjacent) × eff
      middenL: 0,                             // Σ midden L × eff
      barracksL: 0, barracksNear: false,      // Σ barracks L × eff; any barracks within 12 path cells of an entrance
      rootPenL: 0, rootPenCount: 0,           // Σ pen L × eff; number of active pens
      gardenL: 0, gardenerSlots: 0, leafCap: 0, fungusCap: 0, fungusMod: 1,
          // gardenL = Σ garden L; gardenerSlots = RAW 5 × gardenL (WP2 multiplies by colonyScale → d.stats.gardenerSlots);
          // caps 500× / 1000× (not scaled); fungusMod = slot-weighted (clay 1.5 × well-adjacent 1.3 × eff)
      hibCap: 0, hibL: 0,                     // raw shelter capacity Σ 10 × L × eff; Σ hibernaculum L
      chimneyL: 0, gateL: 0, deepVaultL: 0,
      royal: [1],                             // levels of ACTIVE Royal Chambers (each adds its own lay term)
      royalL: 1,                              // level of the original Royal Chamber (uid 1)
      nuptial: { active: false, level: 0, shaftOpen: false },
      wells: 0, chambersActive: 1,
      adjGranaryRepletion: false, adjNurseryRoyal: false,
    },
    digFace: -1,                              // cell index currently being dug, −1 none
    queueInfo: [],                            // [{ uid, work, eta }] remaining work and ETA (s) per queued job
    hints: [],                                // cache cell indices currently visible as hints
  },

  surface: {                                  // WP4
    rev: 0,
    owned: new Uint8Array(817),               // 0 none, 1 auto, 2 claimed, 3 conquered, 4 trunk
    ownedCount: 0,
    border: new Uint8Array(817),              // 1 = owned hex adjacent to rival land
    rival: new Int16Array(817),               // rival uid owning the hex, 0 none
    passable: new Uint8Array(817).fill(1),    // 1 = passable now (stone, spring puddles, molehills block)
    slots: 3, slotsUsed: 1,
    dNav: 3, slope: 0.35,
    trails: [],                               // parallel to s.run.surface.trails:
        // { uid, dEff, rich, eff, cEff, nEff, workers, sat, res, out, res2, out2, escorted, safe }
        // workers = effective workers (explicit + auto-fill); sat = workers / cEff; out/out2 = per-second output of the
        // primary/secondary resource after ALL multipliers, before offline efficiency; safe = entirely inside owned land
    loose: 0,                                 // foragers loose-foraging (no forager trail exists)
    frontier: [],                             // unrevealed hexes adjacent to revealed ones, within radius
    scoutRate: 0,                             // scout-seconds per second (before efficiency)
    claimCost: 10,
    bestSource: 0,                            // source uid with the best untrailed marginal yield (diegetic hint), 0 none
  },

  stats: {                                    // WP2 (formulas pinned in §8.1)
    colonyScale: 1,
    housing: 10, broodSlots: 3, berths: 0, repleteBerths: 0, alateCells: 0, gardenerSlots: 0,   // gardenerSlots = agg.gardenerSlots × colonyScale
    foodCap: 150, honeydewCap: 65, leafCap: 0, fungusCap: 0, pheromoneCap: 50,
    layRate: 0.25,                            // λ eggs/s incl. colonyScale (0 while hungry)
    eggCost: { minor: 10, soldier: 50, supermajor: 500, replete: 200, alate: 200 },          // food
    eggExtra: { minor: {}, soldier: { chitin: 1 }, supermajor: { chitin: 25, fungus: 5 }, replete: { honeydew: 10 }, alate: { honeydew: 5 } },
    mbt: 0.8,                                 // DESIGN M_bt without the caste factor
    nurseTerm: 1.33,                          // 1 + min(4, (nurses + 1) / broodSlots)
    digW: 0,                                  // dig work/s after softcap, before offline efficiency
    soilMult: 1,                              // soil per unit of work (ach_gravel_pit 1.05)
    clickValue: 1,                            // food per hand-forage click
    workerMult: 1,                            // nanitic_vigor × golden ants × sig_social_stomach (forage, dig, herd, leafcut)
    forage: { aAdd: 1, mRun: 1, mTime: 1, mPrestige: 1, total: 1 },   // total = aAdd × mRun × mTime × mPrestige × workerMult
    seasonForage: 1,                          // season_forage incl. R (1 outside winter)
    honeydew: 1, leaves: 1, fungus: 1, chitin: 1,                      // channel totals
    insight: { library: 1, scouting: 1, oneShot: 1 },
    upkeep: 0,                                // food/s before offline efficiency
    phiCoef: 0.5, nutrition: 1,
    atk: 1, hp: 1, ap: 1,                     // player soldier/supermajor ATK & HP multipliers; AP multiplier
    pheromoneRegen: 0.5,
    scMult: { food: 1, dig: 1 },              // thermal_ceiling multipliers on the FIRST softcap threshold
  },

  rates: {                                    // WP2 economy (gross = after softcap, at efficiency 1; net = actual change/s incl. efficiency and sinks;
                                              //   ledger resources also carry avg, the 60 s moving average of gross, C76)
    food:      { raw: 0, gross: 0, net: 0, upkeep: 0, clicks: 0, sc: false, src: {} },
    soil:      { raw: 0, gross: 0, net: 0, sc: false, src: {} },
    insight:   { raw: 0, gross: 0, net: 0, sc: false, src: {} },
    pheromone: { raw: 0, gross: 0, net: 0, sc: false, src: {} },
    chitin:    { raw: 0, gross: 0, net: 0, sc: false, src: {} },
    honeydew:  { raw: 0, gross: 0, net: 0, sc: false, src: {} },
    leaves:    { raw: 0, gross: 0, net: 0, sc: false, src: {} },
    fungus:    { raw: 0, gross: 0, net: 0, sc: false, src: {} },
  },

  combat: {                                   // WP5
    garrison: { soldier: 0, supermajor: 0 },  // not escorting, not in a party, not fighting
    garrisonAP: 0, homeMult: 1,               // homeMult = (1 + 0.05 × mound) × (1.1 if barracksNear)
    escortAP: {},                             // trailUid -> AP
    rivalAP: {},                              // rivalUid -> current AP incl. event effects
    danger: [],                               // hex indices for the danger overlay
  },

  progress: { nextUnlock: null, goals: [], _timers: {} },
      // WP6: nextUnlock { key, label, frac, eta } | null (eta −1 = a pending player-driven step, C86; not rebuilt on offline steps, C87) ; goals [{ id, cur, target }] (≤ 3);
      //      _timers: achievement duration timers { achId: seconds } (not saved; restart after reload)

  offlineLog: null,                           // { cells: [], chambers: [] } during offline sims — WP1 creates, WP3 appends
}
```

---

## 6. Data modules (`src/data/*.js`)

Rules for every data file:
- Export `Object.freeze`d plain objects. Tables are keyed by DESIGN id and every entry repeats its `id`.
- Export a `*_ORDER` array for every table (display and iteration order).
- Every entry has `name` (display) where it is player-visible. Effect numbers live in an `fx` object; **consumers read `fx` and never hardcode the number**. The `fx` key names below are part of the contract.
- A "Cost" is `{ food?, soil?, insight?, pheromone?, chitin?, honeydew?, leaves?, fungus?, alates?, kinship?, genes? }`.
- A growth cost is `{ base: Cost, growth: number }` → `cost(L) = base × growth^L` per resource (L = levels owned).

### 6.1 `data/balance.js` (WP1)
```js
export const TICK = 0.1;                 // s (10 Hz)
export const COMBAT_STEP = 0.25;         // s (4 Hz)
export const CLAMP_MAX = 1e295;
export const COST_MAX = 1e280;
export const CLICK_CAP = 15;             // clicks per second
export const FOOD_OVERFLOW = 2;          // one-shot food may reach 2 × cap
export const GRID = { cols: 40, rows: 80, cellPx: 12, visibleRows: 45, mainCol: 20, shaftRows: 20,
                      royal: { x: 18, y: 20, w: 4, h: 2 } };
// cellPx is the reference cell size (the camera's fallback before it has a viewport); visibleRows is no longer read:
// the nest camera fits the canvas width instead (§13.5).
export const CELL = { SOIL: 0, TUNNEL: 1, CHAMBER: 2, STONE: 3, WATER: 4 };
export const HEX = { maxRadius: 16, count: 817, px: 26 };
export const SOFTCAPS = {                // [threshold, power] applied in sequence
  food: [[1e24, 0.5], [1e60, 0.25]], dig: [[1e20, 0.5], [1e50, 0.25]], insight: [[1e12, 0.5]],
  honeydew: [[1e16, 0.5]], fungus: [[1e16, 0.5]], chitin: [[1e16, 0.5]], ap: [[1e24, 0.5]],
  alates: [[3e4, 0.5]], kinship: [[1e5, 0.5]], genes: [[1e4, 0.5]] };   // alates 3e4 is load-bearing (DESIGN §12.10, §16)
export const OFFLINE = { onlineGapSec: 60, hiddenFullSec: 14400, baseCapSec: 14400, baseEff: 0.5,
  earlyStep: 10, earlyWindow: 600, lateStep: 60, maxSteps: 1500,
  bankRate: 0.10, bankMaxSec: 28800, findEverySec: 7200, findMax: 3 };
export const DIAPAUSE = { speed: 2, speedMastery: 3 };
export const SAVE = { key: 'sld_save', backups: ['sld_save_bak_0', 'sld_save_bak_1', 'sld_save_bak_2'],
  backupEverySec: 300, prefix: 'SLD1:', targetBytes: 61440 };
export const LOOP = { maxTicksPerFrame: 600, welcomeMinSec: 300 };
export const GUARD = { fullEveryTicks: 100 };
export const FRAME = { maxTicks: 60, budgetMs: 8 };      // main.js frame budget for game.advance (C79)
export const TABS = { genKey: 'sld_save_gen', lockKey: 'sld_tab_lock', msgKey: 'sld_tab_msg', channel: 'sld_tabs',
  beatMs: 5000, staleMs: 90000, handoverMs: 400, settleMs: 150, pollMs: 15 };   // save generation and tab lock (§7.16, C80)
```

### 6.2 Colony data (WP2)
**`data/castes.js`**
```js
export const CASTE_ORDER = ['minor', 'soldier', 'supermajor', 'replete', 'alate'];
export const CASTES = {
  queen:      { id: 'queen', name: 'Queen', upkeep: 0 },
  minor:      { id: 'minor', name: 'Minor worker', eggMult: 1, extra: {}, upkeep: 0.05, atk: 0.5, hp: 4, broodFactor: 1, house: 'housing', size: 1, unlock: null },
  soldier:    { id: 'soldier', name: 'Soldier', eggMult: 5, extra: { chitin: { base: 1, perOwned: 0.02 } }, upkeep: 0.25, atk: 4, hp: 20, broodFactor: 1.7, house: 'berths', size: 3, unlock: 'caste_soldier' },
  supermajor: { id: 'supermajor', name: 'Supermajor', eggMult: 50, extra: { chitin: 25, fungus: 5 }, upkeep: 1.0, atk: 30, hp: 250, broodFactor: 3.75, house: 'berths', size: 10, unlock: 'caste_supermajor' },
  replete:    { id: 'replete', name: 'Replete', eggMult: 20, extra: { honeydew: 10 }, upkeep: 0.02, broodFactor: 2.5, house: 'repleteBerths', size: 1, unlock: 'caste_replete',
                fx: { capBonus: 0.02, winterCover: 0.05, winterCoverMax: 0.5 } },
  alate:      { id: 'alate', name: 'Alate', eggMult: 20, extra: { honeydew: { base: 5, growth: 1.15 } }, upkeep: 0.5, broodFactor: 5, house: 'alateCells', size: 1, unlock: 'alate_rearing' },
};
// extra value forms: number (flat) | { base, perOwned } = base + perOwned × adults of that caste | { base, growth } = base × growth^(eggs of that caste laid this run)
```
**`data/jobs.js`**
```js
export const JOB_ORDER = ['forager', 'digger', 'nurse', 'scout', 'herder', 'leafcutter', 'gardener'];
export const JOBS = {
  forager:    { id: 'forager', name: 'Forager', unlock: null },
  digger:     { id: 'digger', name: 'Digger', unlock: 'job_digger', fx: { exp: 0.85 } },
  nurse:      { id: 'nurse', name: 'Nurse', unlock: 'panel_colony', fx: { maxPerSlot: 4 } },
  scout:      { id: 'scout', name: 'Scout', unlock: 'job_scout', fx: { warnSec: 3 } },   // scouting speed lives in data/surface.js SCOUT (force = scouts^0.6)
  herder:     { id: 'herder', name: 'Herder', unlock: 'job_herder', fx: { capPerLevel: 8 } },
  leafcutter: { id: 'leafcutter', name: 'Leafcutter', unlock: 'job_leafcutter' },
  gardener:   { id: 'gardener', name: 'Gardener', unlock: 'job_gardener', fx: { leavesIn: 0.3, fungusOut: 0.1 } },
};
export const LOOSE_FORAGE = 0.1;                       // food/s per forager with no forager trail at all
export const THRESHOLDS = { digQueueSec: 60, rebalanceSec: 5 };  // response_thresholds triggers; auto-assign cadence
```
**`data/economy.js`**
```js
export const EGG = { base: 10, k: 0.02, exp: 1.5, nanitics: 5, naniticsVigor: 25, naniticMult: 0.5 };
export const LAY = { base: 0.2, perRF: 0.05, perRC: 1.15 };
export const BROOD = { baseSec: 25, royalSlots: 3, maxNursePerSlot: 4, stages: [0.25, 0.75], frostDeathPerSec: 0.005,
                       fungalCostPerEgg: 0.5, groomPct: 0.01 };
export const UPKEEP = { survivorAch: 0.95 };          // per-caste upkeep lives in castes.js; winter reductions in research/chamber fx
export const HUNGRY = { outputMult: 0.75, endFrac: 0.05, harshDeathPerSec: 0.005 };
export const NUTRITION = { perAdult: 0.005, coef: 0.5 };   // symbiosis/species override via fx
export const PHEROMONE = { regenBase: 0.5, regenPerSqrtAdult: 0.05, capBase: 50, capPerMound: 5 };
export const CAPS = { royalFood: 150, autumn: 1.25, hoarder: 1.1, repleteAdj: 1.25, honeydewBase: 50, honeydewFrac: 0.1 };
export const CLICK = { fromLevel: 10, pBase: 0.01, pPer: 0.001, pMax: 0.05, clickstorm: 2 };
export const SPOILAGE = { clayPerMin: 0.005 };
export const BOTTLENECK = { capFrac: 0.99, capSec: 5 };
export const INCOME_AVG = { sec: 60 };                // time constant of d.rates[res].avg, the "seconds of income" base (C76)
```
**`data/adaptations.js`** — `ADAPTATION_ORDER` and:
```js
quick_dispatch:     { id, name: 'Quick Dispatch',     cost: { base: { food: 15 }, growth: 1.7 },  unlock: 'adapt_basic',         fx: { click: 1 } },
strong_mandibles:   { id, name: 'Strong Mandibles',   cost: { base: { food: 25 }, growth: 1.9 },  unlock: 'adapt_basic',         fx: { forageAdd: 0.10 } },
royal_feeding:      { id, name: 'Royal Feeding',      cost: { base: { food: 40 }, growth: 1.75 }, unlock: 'adapt_basic',         fx: { lay: 0.05 } },
digging_claws:      { id, name: 'Digging Claws',      cost: { base: { food: 30 }, growth: 1.8 },  unlock: 'adapt_digging_claws', fx: { digAdd: 0.25 } },
potent_trails:      { id, name: 'Potent Trails',      cost: { base: { food: 200 }, growth: 3.5 }, unlock: 'adapt_potent_trails', fx: { forage: 1.12 } },
serrated_mandibles: { id, name: 'Serrated Mandibles', cost: { base: { food: 100, chitin: 5 }, growth: 2.0 }, unlock: 'adapt_military', fx: { atk: 1.10 } },
thick_cuticle:      { id, name: 'Thick Cuticle',      cost: { base: { food: 100, chitin: 5 }, growth: 2.0 }, unlock: 'adapt_military', fx: { hp: 1.10 } },
sweet_tooth:        { id, name: 'Sweet Tooth',        cost: { base: { food: 500, honeydew: 10 }, growth: 1.9 }, unlock: 'adapt_honeydew', fx: { honeydew: 1.15 } },
queens_feast:       { id, name: "Queen's Feast",      cost: { base: { honeydew: 50 }, growth: 3.0 }, unlock: 'adapt_honeydew', fx: { lay: 1.25 } },
long_legs:          { id, name: 'Long Legs',          cost: { base: { food: 1000 }, growth: 3.0 }, unlock: 'adapt_long_legs', fx: { dNav: 0.25 } },
// plus ADAPT = { monomorphicCap: 10 }
```

### 6.3 Nest data (WP3)
**`data/strata.js`**
```js
export const LAYER_ORDER = ['topsoil', 'loam', 'clay', 'gravel', 'bedrock', 'aquifer'];
export const LAYERS = {
  topsoil: { id: 'topsoil', y0: 0,  y1: 9,  work: 4,   req: null },
  loam:    { id: 'loam',    y0: 10, y1: 23, work: 6,   req: null },
  clay:    { id: 'clay',    y0: 24, y1: 39, work: 10,  req: null, workMasonry: 7.2 },
  gravel:  { id: 'gravel',  y0: 40, y1: 57, work: 16,  req: null },
  bedrock: { id: 'bedrock', y0: 58, y1: 73, work: 40,  req: { research: 'acid_excavation' } },
  aquifer: { id: 'aquifer', y0: 74, y1: 79, work: 120, req: { federation: 'aquifer_access' } },
};
export const MICRO = {   // microclimate additive brood-speed terms and multipliers, by layer and season
  topsoil: { nursery: { spring: 0.15, summer: -0.15 } },   // summer −0.15 skipped with thermoregulation / thermal_brood_shuttling / site_sunny_slope;
                                                           // site_sunny_slope also applies the +0.15 in autumn
  gravel:  { nursery: { winter: 0.10 } },
  clay:    { garden: 1.5, granarySpoil: true },
};
export const DIG = { chamberCellMult: 1.5, queueBase: 5, helpFlat: 5, helpFracW: 0.03, backfillSec: 10,
  relocateWorkFrac: 0.5, demolishRefund: 0.5, cancelRefund: 1.0, floodRows: [0, 5],
  richLoamMult: 0.8, shallowSoilRow: 23, shallowSoilRewardPerTier: 0.05, blueprintCellDiv: 3, blueprintPlaceMult: 0.5,
  goingUnderTunnelMult: 0.95 };
export const GEOM = { adjPathMax: 4, hygienePath: 6, barracksPath: 12, raidReach: 15, haulDiv: 24, satelliteHaul: 0.5,
  hintRadius: 4, footprintMaxL: 8, nuptialEntranceStep: 8 };
```
**`data/chambers.js`** — `CHAMBER_ORDER` and `CHAMBERS[id]`:
```js
{ id: 'gallery', name: 'Gallery', unlock: 'chamber_gallery',
  maxInst: 4, instBonus: [ { research: 'gallery_arches', add: 2 } ],    // royal: [{trait:'polygyny',add:1},{federation:'queens_council',add:2}]; water_well: maxInst 'perPocket'
  w0: 3, h0: 2, grows: true,
  rowMin: 1, rowMax: 79, rule: null,      // rule: null | 'touchRoot' | 'touchRow0' | 'shaftTop' (gate: touches a shaft, rows 0–6) | 'touchWater' | 'nuptialShaft'
  place: { food: 40 },                    // L0→L1 food (+ extras, e.g. hibernaculum { food: 8000, honeydew: 150 }, gate { food: 2000, chitin: 20 })
  placeGrowth: 2.5,                       // × growth^k; royal extras: { base: { food: 1e5 }, growth: 10 }
  f0: 10, s0: 24, g: 1.30,                // level-up L→L+1: food f0×g^L×2^k, soil s0×g^L×2^k
  levelExtra: null,                       // gate: { chitin: 5 } (× g^L)
  maxL: 0, maxLBonus: null,               // 0 = no cap; nuptial: maxL 4, maxLBonus { trait: 'royal_court', maxL: 9 }
  frostImmune: false,                     // royal_chamber, gate, thermal_chimney: true
  fx: { housing: 10, highL: 30, loam: 1.1 } }
// Global chamber constants:
export const CHAMBER_RULES = { instancePlaceGrowth: 2.5, instanceLevelGrowth: 2, frostMult: 0.5, aquiferMult: 1.2 };
```
`fx` keys per chamber (contract; consumers in parentheses):

| Chamber | `fx` |
|---|---|
| `royal_chamber` | `{ lay: 1.15, housing: 10, storage: 150, slots: 3, flightLevel: 5 }` (WP2, WP3, WP7) |
| `gallery` | `{ housing: 10, highL: 30, loam: 1.1 }` (WP3) |
| `nursery` | `{ slots: 3, royalAdj: 0.15 }` (WP3) |
| `granary` | `{ cap: 300, capGrowth: 1.65, layer: { clay: 1.25, gravel: 1.5, bedrock: 1.75, aquifer: 1.75 }, claySpoil: 0.005 }` (WP3, WP2) |
| `scent_library` | `{ insight: 0.05, deep: 1.25, royalAdj: 1.10 }` (WP3); level growth `g` 2.00 |
| `midden` | `{ disease: 0.10, diseaseMax: 0.8, output: 0.02, outputMax: 0.2, hygiene: 0.8 }` (WP3, WP2, WP6) |
| `barracks` | `{ berths: 8, atk: 0.05, atkMax: 0.5, homeAP: 1.10 }` (WP3, WP2, WP5) |
| `root_aphid_pen` | `{ honeydew: 0.05, herders: 1.10, winter: 0.5 }` (WP2) |
| `fungus_garden` | `{ gardeners: 5, leafCap: 500, fungusCap: 1000, clay: 1.5, wellAdj: 1.30 }` (WP3; WP2 multiplies gardener slots by `colonyScale`) |
| `repletion_hall` | `{ berths: 5 }` (WP3) |
| `hibernaculum` | `{ shelter: 10, upkeep: 0.10, upkeepMax: 0.5 }` (WP3, WP2) |
| `thermal_chimney` | `{ winterForage: 0.10, max: 0.6 }` (WP2) |
| `gate` | `{ hp: 0.25, theft: 0.10, theftFloor: 0.02 }` (WP5) |
| `water_well` | `{ gardenAdj: 1.30 }` (WP3, WP6 drought immunity) |
| `nuptial_chamber` | `{ cellsBase: 10, cellsPer: 5, cellsMax: 25, cellsMaxCourt: 50 }` (WP3) |
| `deep_vault` | `{ offlineSec: 3600, alates: 0.05 }` (WP1, WP7) |

Also `ADJACENCY` (ids `adj_nursery_royal`, `adj_library_royal`, `adj_granary_repletion`, `adj_garden_well`, `hyg_midden`, `prox_barracks_entrance`) as `{ id, a, b, path, text }` for the overlay and tooltips (numbers come from the chamber `fx`).

**`data/soilFeatures.js`**
```js
export const ROOTS  = { min: 6, max: 10, yMin: 6, yMax: 25 };
export const STONES = { min: 4, max: 8, size: 3, yMin: 8, yMax: 55 };
export const CACHES = { min: 8, max: 12, yMin: 5, yMax: 60,
  kinds: { seed_cache: { weight: 4, res: 'food', sec: 90, min: 50 }, beetle_husk: { weight: 3, res: 'chitin', sec: 60, min: 25 },
           fossil: { weight: 3, res: 'insight', sec: 60, min: 50 } },
  amber: { count: 1, layer: 'bedrock' } };
export const WATER  = { min: 2, max: 3, sizeMin: 2, sizeMax: 3, yMin: 40, yMax: 70 };
export const SITE_MODS = { site_stony_ground: { stones: 2, caches: 2 }, site_wet_hollow: { waterAdd: 2 } };
```

### 6.4 Surface data (WP4)
**`data/surface.js`**
```js
export const MAP = { radiusBase: 8, zoomMin: 0.6, zoomMax: 1.6, revealStart: 2 };    // sun_compass/regional radii in research/federation fx
export const TERRAIN_ORDER = ['grass', 'sand', 'leaf_litter', 'garden_path', 'tree_root', 'stone', 'puddle', 'log'];
export const TERRAIN = {   // code = index in TERRAIN_ORDER (stored in s.run.surface.terrain)
  grass: { id: 'grass', code: 0, share: 0.58, move: 1 },  sand: { code: 1, share: 0.08, move: 1.25 },
  leaf_litter: { code: 2, share: 0.12, move: 1.5 },        garden_path: { code: 3, share: 0.04, move: 0.5 },
  tree_root: { code: 4, share: 0.04, move: 1 },            stone: { code: 5, share: 0.06, move: null },        // null = impassable
  puddle: { code: 6, share: 0.06, move: 1, springMove: null }, log: { code: 7, share: 0.005, move: 1, fx: { preyRadius: 2, prey: 2 } } };
export const SCOUT = { base: 10, exp: 1.2, insightPerRing: 0.75, forceExp: 0.6, flagPriority: 3 };
// hex cost = base × ring^exp scout-seconds; insight per revealed hex = insightPerRing × ring × stats.insight.scouting;
// scout force = jobs.scout^forceExp × multipliers (§8.3)
export const TRAIL = { slope: 0.35, dNavBase: 3, sEqK: 15, tHalf: 45, sMax: 100, raidS: 30, cEffDiv: 100, cEffExp: 0.8,
  rivalHexPenalty: 0.05, escortPer: 10, widthMin: 1, widthMax: 6, overthinker: { n: 20, sec: 60 } };
export const SLOTS = { base: 3, moundLevels: [3, 6, 9], outpost: 1, satellite: 1 };
export const ABILITIES = {
  mark:         { id: 'mark', cost: { pheromone: 5 }, cd: 3, add: 25, unlock: 'ability_mark' },
  rally:        { id: 'rally', cost: { pheromone: 20 }, cd: 120, mult: 2, sec: 30, unlock: 'ability_rally' },
  frenzy:       { id: 'frenzy', cost: { pheromone: 60 }, cd: 120, mult: 2, sec: 20, unlock: 'ability_frenzy' },
  mass_recruit: { id: 'mass_recruit', cost: { pheromone: 20 }, frac: 0.5, unlock: 'ability_mark' } };
export const TERRITORY = { claimBase: 10, claimGrowth: 1.06, autoBase: 1, autoPerMound: 5, yieldPerHex: 0.005, yieldMax: 1,
  ownedSource: 1.25, creepSec: 180, landGrabAch: 0.9 };
// auto-claim radius = autoBase + floor(mound / autoPerMound) around EVERY entrance kind (main, nuptial, outpost, satellite; DESIGN §8.6)
export const MOUND = { base: 300, growth: 1.9, freeMax: 5, homeAP: 0.05, winterForage: 0.03, winterMax: 0.3,
  frostPerLevels: 3, frostMax: 6, shieldLevel: 5, unlockSoil: 300 };
```
**`data/sources.js`** — `SOURCE_ORDER` and `SOURCES[id]`:
```js
{ id: 'seed_patch', name: 'Seed patch', job: 'forager',
  y: { food: 0.5 },                         // per-worker yields; secondary resources allowed: flower { food: 0.55, honeydew: 0.005 }, dead_insect { food: 0.6, chitin: 0.01 }
  cap: 15,                                  // capacity c (aphid_colony: 8 per level → capPerLevel: 8)
  stock: { base: 300, sec: 300, regrow: 0.01, dynamic: true },
        // null = infinite. max = max(base, sec × d.rates.food.gross), sized when the source first becomes visible (C34);
        // dynamic: true (seed_patch only) → max is re-evaluated EVERY tick and stock is clamped to it (DESIGN §8.4);
        // regrow = fraction of max per s
  spawn: { mode: 'fixed', count: 3, rMin: 2, rMax: 5, terrain: null },
        // mode 'fixed' (mapgen) | 'random' ({ every: s, max, rMin, rMax, ttl }) | 'event' | 'research' (lycaenid) | 'conquest' (harvester_stash)
  season: { spring: 1, summer: 1, autumn: 2, winter: 1 },   // season_src
  hunt: null,                               // prey: { apPerRing: 50, foodSec: 60, chitinPerRing: 15, chitinMult: 1 } (cricket ×2, beetle ×4);
                                            //   AP / chitin use r = the source hex's RING; the reward is × season[d.season.srcId] (prey autumn 1.5)
  fx: {} }
// lycaenid_caterpillar: { job: 'lycaenid', y: { honeydew: 0.3 }, perRing: true, minEscorts: 5, cap: 0, stock: null,
//   spawn: { mode: 'research', research: 'lycaenid_clients', countMin: 1, countMax: 2, rMin: 3, rMax: 6 } }
//   → pays 0.3 × ring honeydew/s × d.stats.honeydew while its trail has ≥ 5 escorts (DESIGN §8.4, C35)
```
Every source in DESIGN §8.4 is an entry: `crumb_scatter`, `seed_patch`, `flower_patch`, `dead_insect`, `leaf_plant`, `aphid_colony`, `prey_caterpillar`, `prey_cricket`, `prey_beetle`, `fallen_fruit`, `picnic_spill`, `termite_mound`, `lycaenid_caterpillar`, `harvester_stash`, plus **`termite_swarm`** (§18 C7: `y: { food: 5, chitin: 0.05 }`, cap 30, `ttl` 45, `mode: 'event'`) and **`gift`** is NOT a source (it is a golden object).

### 6.5 War data (WP5)
**`data/rivals.js`**
```js
export const RIVAL_ORDER = ['black_garden_ants', 'pavement_ants', 'red_wood_ants', 'carpenter_ants', 'fire_ants', 'slave_makers'];
export const RIVALS = { black_garden_ants: { id, name: 'Black Garden Ants', sci: 'Lasius niger', tier: 1, soldiers: 15, atk: 3, hp: 15, radius: 2, raidMin: 8, traits: [] }, /* … per DESIGN §9.2 */ };
export const ELDER = { fromTier: 7, apBase: 15000, apGrowth: 4, atkBase: 12, hpBase: 60, statGrowth: 1.2, radius: 3, raidMin: 6, traitsMin: 1, traitsMax: 2 };
export const GROWTH = { perMin: 0.01, perMinSummer: 0.03, maxMult: 3 };
export const TRAITS = { swarm: { apMult: 1.2 }, acid_volley: { yourAP: 0.9 }, home_fortress: { home: 1.5 }, venom: { yourHP: 0.8 },
  border_creep: {}, brood_raiders: { partyFrac: 0.4, returnMult: 3 } };
export const BOSSES = {   // AP formulas (DESIGN §9.3): Old Ridge apBase × (1 + m)^apExp; Front apBase × apGrowth^s (TOTAL, split over 3 nests);
                          // army column apBase × (1 + m)^apExp. m = meta.counters.supercolonies, s = meta.counters.speciations.
  old_ridge_supercolony: { apBase: 1e6, apExp: 1.5, atk: 12, hp: 60, radius: 3, immuneUntilOwned: 25, raidMin: 6, alatesCycle: 2500 },
  great_rival:           { apBase: 1e8, apGrowth: 10, atk: 4, hp: 20, radius: 3, nests: 3, windowSec: 600, raidMin: 3 },   // radius per nest (DESIGN §8.6)
  army_ant_column:       { apBase: 43000, apExp: 1.5, atk: 6, hp: 30, crossSec: 90, lootFoodSec: 1800, lootChitinSec: 600, lootChitinMin: 2000 } };
export const SPAWN = { tier1Ring: [4, 5], tier2Ring: [6, 7], maxByRadius: { 8: 2, 12: 3, 16: 4 }, respawnSec: [600, 1200], outerBand: 2 };
export const FALLEN_RIVALS = { keep: 24 };   // compact records of conquered non-boss rivals kept (oldest dropped first, C77)
```
**`data/combat.js`**
```js
export const BATTLE = { dmgCoef: 0.2, step: 0.25, fortune: [0.9, 1.1], previewGrid: 64, corpseSec: 5, marchSecPerHex: 2 };
export const ACTIONS = { raid: { engage: 0.4, home: 1 }, assault: { engage: 1, home: 1.25 }, termite: { ap: 28300, cdSec: 300 },
  bribe: { apMult: 2, truceSec: 300, cdSec: 600 },
  tournament: { sec: 20, cdSec: 180, win: 1.5, size: { minor: 1, soldier: 3, supermajor: 10 }, rivalPer: 3, tierStep: 0.2, escalateEngage: 0.25, flipLoss: 0.02 } };
export const REWARDS = { raidFoodSec: 30, raidFoodMinPerTier: 50, chitinPerKillTier: 0.5, conquestInsightPerTier: 25, conquestFoodSec: 120, capturedPerTier2: 5 };
export const TACTICAL = { alarm_rally: { cost: { pheromone: 25 }, cd: 30, atk: 1.3, sec: 8 }, mobilize: { cost: { pheromone: 40 }, frac: 0.25, sec: 20 }, retreat: { loss: 0.3 } };
export const RAIDS = { minAdults: 50, minRunSec: 900, partyFrac: 0.3, warnBase: 15, warnPerScout: 3, warnMax: 60, nestRoll: 0.25, nestTierMin: 4,
  trailRadius: 2, borderMult: 2, trailIncomeSec: 30, trailS: 30, trailKillMult: 2, theft: 0.10, theftFallback: 0.03, broodKill: 0.20,
  seasonFactor: { spring: 1.25, summer: 1.5, autumn: 1, winter: 0 }, pacifistAggro: 0.08 };
```
**`data/research.js`**
```js
export const BRANCH_ORDER = ['foraging', 'excavation', 'brood', 'husbandry', 'warfare', 'communication'];
export const BRANCHES = { foraging: { id, name: 'Foraging', main: 'forage' }, excavation: { main: 'dig' }, brood: { main: 'lay' },
  husbandry: { main: 'honeydew+fungus' }, warfare: { main: 'ap' }, communication: { main: 'insight' } };
export const RESEARCH_ORDER = [/* all 57 ids, branch by branch, in DESIGN order */];
export const RESEARCH = { trail_memory: { id, name: 'Trail Memory', branch: 'foraging', tier: 0, cost: 10, prereq: [], fx: { forage: 1.25, slots: 1 } }, /* every other node of DESIGN §11.1–§11.6 in this shape: cost and prereq copied verbatim (e.g. polymorphism cost 300), fx per the table below */ };
export const REFINEMENT = { base: 10000, growth: 2.5, mult: 1.10 };
export const INNATE = { runs: 3, runsAncestral: 2 };
```
`tier` = row in the Research grid (0-based, by cost order within the branch). Research `fx` keys (contract):

| Node | `fx` | Node | `fx` |
|---|---|---|---|
| `trail_memory` | `forage 1.25, slots 1` | `brood_care` | `broodTime 0.75` |
| `scent_marking` | `{}` | `age_polyethism` | `{}` |
| `tandem_running` | `dNav 1` | `royal_pheromones` | `lay 1.5` |
| `recruitment_pheromones` | `forage 1.75` | `trophic_eggs` | `eggCost 0.7` |
| `double_bridge` | `dMult 0.9, rise 2` | `thermal_brood_shuttling` | `{}` |
| `persistent_trails` | `tHalf 90, sMax 150` | `nuptial_preparation` | `{}` |
| `sun_compass` | `radius 12, slots 2` | `response_thresholds` | `{}` |
| `mass_recruitment` | `dNav 2, rallySec 60, slots 2` | `living_larders` | `{}` |
| `frenzy_signal` | `{}` | `spermathecal_reserve` | `lay 2` |
| `trunk_trails` | `minLen 5, mult 1.5` | `supermajors` | `{}` |
| `odometer_navigation` | `dNav 3, slope 0.5` | `aphid_husbandry` | `{}` |
| `coordinated_digging` | `dig 1.5` | `leafcutting` | `{}` |
| `load_chains` | `tunnel 0.5, queue 2` | `aphid_shepherding` | `herderCap 2` |
| `clay_masonry` | `clayWork 7.2` | `fungiculture` | `{}` |
| `mound_building` | `{}` | `lycaenid_clients` | `{}` |
| `drainage` | `drought 0.5` | `sugar_economy` | `honeydew 2` |
| `ventilation_shafts` | `chamber 1.10` | `weeder_ants` | `blight 0.25, fungus 1.5` |
| `thermoregulation` | `frost 5` | `fungal_symbiosis` | `phiCoef 1.0` |
| `gallery_arches` | `galleries 2, housing 1.25` | `polymorphism` | `{}` |
| `acid_excavation` | `dig 2, stone 3` | `formic_acid` | `atk 1.3` |
| `compact_galleries` | `housing 2` | `ritual_tournaments` | `{}` |
| `antennation` | `scout 2, insightHex 1.5` | `phalanx` | `escortAP 1.5, retreatLoss 0.1` |
| `chemical_lexicon` | `library 1.5` | `field_triage` | `frac 0.3, sec 60, nurses 5` |
| `pheromone_glands` | `cap 50, regen 1.5` | `propaganda_pheromones` | `enemyAP 0.9, convert 0.05` |
| `early_warning` | `warnSec 30` | `siege_tactics` | `home 0.5` |
| `seasonal_clock` | `winterR 0.2` | `war_chemistry` | `ap 2` |
| `overwintering` | `winterUpkeep 0.8` | `collective_memory` | `insight 2, offlineSec 7200` |
| `weather_sense` | `warnSec 30` | `diapause_logic` | `offlineEff 0.25, winterUpkeep 0.75` |
| `hive_mind` | `insight 1.5` | | |

### 6.6 World data (WP6)
**`data/seasons.js`**
```js
export const SEASON_ORDER = ['spring', 'summer', 'autumn', 'winter'];
export const LONG_SUMMER_ORDER = ['spring', 'summer', 'summer', 'autumn'];        // edict_of_long_summer
export const YEAR = { lengthSec: 360, chronoMin: 180, chronoMax: 720, forecastSec: 60 };
export const SEASON_MODS = {
  spring: { forage: 1.0, lay: 1.25, broodTime: 0.8, dig: 1, insight: 1, foodCap: 1, rivalAggro: 1.25, rivalDormant: false, flightW: 1, puddlesBlock: true },
  summer: { forage: 1.3, lay: 1, broodTime: 1, dig: 1, insight: 1, foodCap: 1, rivalAggro: 1.5, rivalDormant: false, flightW: 1.25, puddlesBlock: false },
  autumn: { forage: 1.1, lay: 1, broodTime: 1, dig: 1, insight: 1, foodCap: 1.25, rivalAggro: 1, rivalDormant: false, flightW: 1, puddlesBlock: false },
  winter: { forage: 0.3, forageMild: 0.6, lay: 0.75, broodTime: 1.5, dig: 1.3, insight: 1.5, foodCap: 1, rivalAggro: 0, rivalDormant: true, flightW: 1, puddlesBlock: false } };
export const FROST = { maxRow: 18, maxRowMild: 10, minRow: 4, descendSec: 90, retreatSec: 60, snapRows: 4, snapSec: 120 };
```
**`data/events.js`**
```js
export const EVENT_RULES = { meanSec: 240, firstRunQuietSec: 360, scriptedFruitAt: 480, firstPositive: 3, maxNegIn3: 1, negGapSec: 60, cardSec: 30, weatherWarnSec: 30 };
export const EVENT_ORDER = [/* the 28 ev_* ids of DESIGN §18.2 */];
export const EVENTS = { ev_wandering_queen: { id, name: 'Wandering Queen', polarity: 'choice',   // 'pos' | 'neg' | 'mix' | 'choice'
    seasons: null, weight: 10, seasonWeight: null, minRunSec: 0, minAdults: 200, cond: null,     // cond: named predicate implemented in events.js
    weather: false, choices: [ { id: 'adopt' }, { id: 'devour', def: true } ],
    num: { layMult: 2, sec: 600, parasiteChance: 0.2, parasiteMult: 0.5, parasiteSec: 300, devourSec: 120, devourMin: 100 } }, /* the other 27 events of DESIGN §18.2 in this shape, every number of their row in `num` */ };
// For pity counting, 'choice' events count as 'mix'; 'mix' never counts as negative.
// Soldier remedies (C36): ev_ladybug_raid, ev_antlion_pit and ev_horned_lizard also open a card. Their choices are
//   ladybug ['send', 'wait'*] (num.soldiers 5, num.apPerRing 50), antlion ['send', 'wait'*] (num.soldiers 3),
//   lizard ['reroute'*, 'mob', 'ignore'] (num.apPerRing 200). 'send'/'mob' are validated against the garrison and resolve at once with no losses.
export const GOLDEN = { beetleMin: 300, beetleMax: 600, life: 13, lifeAch: 20, lifePicnicAch: 5,
  rolls: [ { id: 'windfall', w: 45, foodSec: 600 }, { id: 'frenzy', w: 25, mult: 5, sec: 60 }, { id: 'lay_burst', w: 15, mult: 3, sec: 30 },
           { id: 'discovery', w: 15, insightSec: 60, insightFlat: 20 } ],
  pupaChance: 0.002, pupaGapSec: 180, pupaLife: 15 };
export const SAVED_FINDS = { pool: ['ev_fallen_fruit', 'ev_pheromone_bloom', 'ev_queens_vigor', 'ev_lost_scout_returns', 'golden_beetle'] };
export const EVENT_GAP = { firstRunMaxSec: 150 };   // run 1: the next event is due at most 150 s after the previous one (C75)
```
**`data/achievements.js`** — `ACH_ORDER` and `ACHIEVEMENTS[id] = { id, name, cat, desc, secret: false, target: number|null, reward: Reward|null, cosmetic: string|null }`. `cat` ∈ `population, food, excavation, chambers, surface, combat, seasons, prestige, secret, guide`. `target` is the number used for the Next Goals progress bar. `Reward` is display data `{ text }`; the bonus itself is implemented by the consumer listed in §12.5.

**`data/fieldGuide.js`** — `FG_ORDER`, `FIELD_GUIDE[id] = { id, title, cat, trigger, note }` (`note`: 40–60 words written in-house, no quotations), and `FG_REWARD = { sec: 30, min: 10 }`. All **40** entries of DESIGN §20 (including `fg_amber`, unlocked by collecting the amber bead).

**`data/unlocks.js`** — `UNLOCKS: UnlockDef[]` (§11).

### 6.7 Meta data (WP7)
**`data/prestige.js`**
```js
export const FLIGHT = { fRunMin: 1.4e8, base: 10, div: 1e8, exp: 0.5, tPeakDiv: 400, rearedPer: 0.02, rearedMax: 25, rearedMaxCourt: 50,
  royalLevel: 5, tabFRun: 2e7, peakGlow: 0.97, ceremonySprites: 120 };   // fRunMin = the Flight gate (1.4e8 → 11 alates); div = the formula anchor (1e8 → 10)
export const LINEAGE = { per: 0.05, knee: 100, high: 6 };   // Λ = a ≤ knee ? 1 + per × a : high × √(a / knee)  (continuous at a = 100: 6)
export const SUPER = { alatesMin: 5000, mult: 2, div: 1000, exp: 0.35, teaserAlates: 1000 };
export const SPEC = { kinshipMin: 1000, mult: 1, div: 50, exp: 1, teaserKinship: 20 };   // genes = floor(SC(kinship_era / 50)): the gate 1,000 → 20
export const PASSIVE = { kFood: 1.25, kOther: 0.5, kAlates: 0.25, kScale: 0.2, gFood: 1.5, gOther: 0.25, gAP: 1 };
export const ACH_BONUS = { per: 1.01, perFossil: 1.02 };
export const HARDSHIP = { unlockAlates: 150, goalBase: 1e9, goalGrowth: 100, tiers: 5, carry: 0.5 };   // goal(t) = 1e9 × 100^(t−1)
export const HARDSHIPS = { eternal_winter: { id, name, fx: { winterR: 0.10 } }, claustral_founding: { fx: { lay: 1.3 } },
  pacifist: { fx: { aggro: 0.08, tourney: 0.05 } }, barren_ground: { fx: { yield: 0.5, slope: 0.05 } },
  shallow_soil: { fx: { maxRow: 23, work: 0.05 } }, monomorphic: { fx: { adaptCap: 10, worker: 1.3 } } };
export const SITES = { site_rich_loam: { fx: { work: 0.8 } }, site_seed_meadow: { fx: { seedAdd: 2, autumnSeed: 2.5 } },
  site_aphid_dense: { fx: { aphidAdd: 2 } }, site_hostile_neighbours: { fx: { tiers: [2, 3], conquest: 1.5 } },
  site_stony_ground: { fx: {} }, site_garden_path: { fx: { paths: 2 } }, site_wet_hollow: { fx: { puddles: 2, fungus: 1.2 } },
  site_sunny_slope: { fx: {} } };
export const BOONS = { boon_next_to_aphids: { fx: { ring: 2 } }, boon_rich_prey: { fx: { every: 120, until: 600, ring: 2 } },
  boon_peaceful_start: { fx: { sec: 1200 } }, boon_royal_vigor: { fx: { lay: 2, sec: 600 } }, boon_scouts_lead: { fx: { reveal: 3 } },
  boon_old_trails: { fx: { trails: 2 } }, boon_chitin_hoard: { fx: { chitin: 50 } }, boon_blueprint_rush: { fx: { mult: 2, sec: 600 } },
  boon_long_spring: { fx: { sec: 180 } }, boon_insight_cache: { fx: { insight: 100 } } };
export const EDICTS = { edict_of_plenty: { fx: { forage: 2, ap: 0.75 } }, edict_of_war: { fx: { ap: 2, conquest: 1.5, forage: 0.9 } },
  edict_of_depth: { fx: { dig: 3, chamberCost: 0.5 } }, edict_of_long_summer: { fx: {} } };
export const LANDING = { options: 3, tagsMin: 1, tagsMax: 2, boons: 3 };
export const RESET = { broodBankFrac: 0.1, broodBankMax: 1000, strataMax: 12, daughtersMax: 8, censusPerSatellite: 0.25, endingCensus: 2e16 };
export const FOUNDING_STORES = [ null, { food: 500, soil: 100 }, { food: 5000, soil: 1000 }, { food: 50000, soil: 10000 } ];
```
**`data/bloodline.js`** — `TRAIT_ORDER`, `TRAITS[id] = { id, name, cost: { base, growth }, max, fx }` (`cost(L) = base × growth^L` alates). `fx`:
`founding_stores {}` (uses FOUNDING_STORES) · `nanitic_vigor { eggs: 25, workers: 50, mult: 3 }` · `remembered_paths { trails: 2, strength: 0.5 }` · `ancestral_blueprint { cellDiv: 3, placeMult: 0.5 }` · `automaton_instincts { queue: 2 }` · `hardy_workers { mult: 1.4 }` · `deep_diggers { mult: 1.4 }` · `keen_antennae { reveal: 4, scout: 2 }` · `fertile_queen { mult: 1.25 }` · `ancestral_memory { runs: 2 }` · `long_memory { capSec: 7200, eff: 0.10 }` · `warrior_lineage { mult: 1.25 }` · `royal_court { cells: 50, maxL: 9, reared: 50 }` · `seasonal_wisdom { winterR: 0.25 }` · `swarm_instinct { mult: 1.5 }` · `sweet_inheritance { mult: 2, aphidLevel: 2, ring: 2 }` · `wide_wings { mult: 1.15 }` · `vast_galleries { mult: 1.2 }` · `brood_bank {}` · `polygyny { royal: 1 }` · `budding {}`.

**`data/federation.js`** — `FED_ORDER`, `FEDERATION[id] = { id, name, cost: { base, growth } | { list: [2,3,5,8,13,21,34] }, max, fx }`. `fx`:
`automated_brood {}` · `blueprint_memory { slots: 5, cellDiv: 5 }` · `autobuyers {}` · `auto_flight {}` · `aquifer_access {}` · `heirloom_bloodline { keep: 3 }` · `satellite_nest { foodDig: 0.25, slots: 1, radius: 1, census: 0.25, minDist: 3, colGap: 4 }` · `regional_expansion { radius: 16, rivals: 4 }` · `megacolony_galleries { mult: 2 }` · `highway_network { dNav: 5 }` · `diapause_mastery { capSec: 86400, eff: 1, speed: 3 }` · `queens_council { royal: 2 }` · `megacolony {}`.

**`data/genome.js`** — `GENOME_ORDER`, `GENOME[id] = { id, name, cost: { base, growth }, max, fx }` (max `0` = uncapped). `fx`:
`genetic_memory {}` · `haplodiploid_fecundity { mult: 2 }` · `eusocial_leap {}` · `metapleural_glands {}` · `venom_gland { atk: 2 }` · `species_leafcutter/honeypot/fire_ant { species: '<id>' }` · `dreaming_hive { capSec: 172800, eff: 1 }` · `golden_brood { chance: 0.01, mult: 10 }` · `ancient_instinct { mult: 10 }` · `deep_time_automation {}` · `thermal_ceiling { mult: 1e6 }` · `chronobiology {}` · `fossil_record {}` · `colossal_nests { mult: 10 }` · `unicolonial_sprawl { mult: 2 }` · `biomes {}` (STRETCH).
`SPECIES_ORDER` and `SPECIES[id] = { id, name, sci, gene: 'species_…' | null, sig: 'sig_…', mods }`. `mods` keys (all optional; neutral when absent):

| Key | Meaning | Consumer |
|---|---|---|
| `foodSource` (0.5) | Food yields of food sources × | WP4 trails |
| `leafPlant` (2) | Leaf plant yields × | WP4 trails |
| `phiCoef` (2) | Nutrition coefficient | WP2 stats |
| `eggFungusFrac` (0.25) | Share of egg food cost paid in fungus once `fungiculture` | WP2 population |
| `gardenRowMin` (10) | Fungus Garden row rule | WP3 |
| `innate` (['living_larders']) | Research granted every run | WP5 research.grantInnate |
| `repleteCost` (0.25), `repleteCap` (5) | Replete egg cost ×; replete food-cap bonus × | WP2 |
| `winterForageHalf` (true) | Winter forage penalty halved (R term 0.5) | WP2 stats |
| `foodCap` (0.5) | Base food cap × | WP2 stats |
| `royalStart` (2) | Royal Chambers at run start | WP7 startRun → WP3 |
| `soldierAtk` (1.5) | Soldier ATK × | WP2 stats |
| `rafts` (true) | Rainstorm → +25 % forage for 60 s, no flood | WP6 events |
| `raidMult` (2) | Rival raid frequency × | WP5 raids |

`SIGNATURES = { sig_generalist: { fx: { all: 1.1 } }, sig_fungal_farmers: { fx: { fungus: 2 } }, sig_social_stomach: { fx: { per: 5, pct: 0.01, max: 0.5 } }, sig_polygyne: { fx: { lay: 1.5 } } }`.

---

## 7. Core runtime (WP1)

### 7.1 The game object and the loop (`core/game.js`)
```js
export function createGame({ nowMs, storage = null, stepFn = step } = {}) → Game
// Game = {
//   s, d,                         current state and derived cache (replaced wholesale on load/import/reset)
//   bus,                          core/bus.js instance; step events are published here
//   actions,                      core/actions.js createActions(game)
//   queue: [],                    pending Command[]; drained into the next tick
//   acc: 0,                       fixed-step accumulator (s)
//   storageOk: true,              false after any storage failure (UI shows "Saving unavailable: use Export")
//   saveGen: 0,                   save generation this game loaded or last wrote (TABS.genKey; C80)
//   stale: false,                 true once another game wrote a newer save; save() then refuses (C80)
//   hooks: { beforePrestige: null },   main.js sets () => game.save(Date.now())
//   newGame(nowMs, seed?) → void
//   loadOrNew(nowMs) → { loaded, error, welcome, restoredFrom? }   welcome: OfflineSummary | null; restoredFrom: backup key used
//   advance(realDtSec, nowMs, { maxTicks?, budgetMs?, clock? }?) → void   per-frame entry point (budget: C79)
//   catchUp(gapSec, nowMs, { hidden, hiddenSec? }) → OfflineSummary  long gaps (hidden tab, sleep, load)
//   dispatch(cmd) → { ok, reason }                       same as actions.do
//   tickOnce(dt = TICK, opts = {}) → GameEvent[]         one step with all queued commands (tools/tests)
//   runFor(seconds, { dt = TICK, onTick = null } = {}) → void
//   save(nowMs, { hidden = false }?) → { ok, error }      error 'stale': another game wrote a newer save (C80)
//   exportString(nowMs) → string
//   importString(str, nowMs) → { ok, error }
//   hardReset(nowMs) → void
// }
```
**`newGame(nowMs, seed)`**: `s = createState({ seed: seed ?? (nowMs >>> 0) })`, set `createdAt/lastSeen`, `d = createDerived()`, `prestige.newGame(s, d)` (generates the first map and nest), one zero-dt derive pass (`stepFn(s, d, 0, [], {})`), publish `{type:'reset'}`.

**`advance(realDt, nowMs)`** (called every animation frame by `main.js`):
```
if (!(realDt >= 0)) realDt = 0                         // NaN or a backward clock gives no time
s.meta.lastSeen = nowMs
if (realDt >= OFFLINE.onlineGapSec) {                  // ≥ 60 s since the last frame (hidden tab, sleep)
  const sum = catchUp(realDt, nowMs, { hidden: true })
  if (realDt >= LOOP.welcomeMinSec) bus.emit('welcome', { type: 'welcome', summary: sum })
  return
}
acc += realDt
n = min(floor(acc / TICK + 1e-9), LOOP.maxTicksPerFrame)
econScale = (s.meta.diapause.active && s.meta.diapause.bank > 0) ? (fed diapause_mastery ? 3 : 2) : 1
for (i = 0; i < n; i++) tickOnce(TICK, { econScale })
acc -= n * TICK; if (acc > TICK) acc = TICK            // never bank more than one tick
if (econScale > 1) { bank -= n * TICK * (econScale - 1); if (bank <= 0) { bank = 0; active = false } }   // game.js may write meta.diapause here
```
With a frame budget (`main.js` passes `{ maxTicks: FRAME.maxTicks, budgetMs: FRAME.budgetMs, clock }`, C79) the tick loop also stops at `maxTicks` or when `clock()` has advanced `budgetMs` (always after at least one due tick) and the rest stays in `acc` as a backlog for the next frames (no one-tick clamp); `lastSeen = nowMs − backlog`, and when `realDt + backlog ≥ onlineGapSec` the sum goes to `catchUp` as one hidden gap. Without a budget nothing changes.
**`tickOnce(dt, opts)`**: `cmds = queue.splice(0)`; `events = stepFn(s, d, dt, cmds, { offline: false, eff: 1, econScale: opts.econScale ?? 1 })`; publish each event on the bus (`bus.emit(e.type, e)`); return events. Commands are therefore applied at the **start of the next tick** (latency ≤ 100 ms). Determinism tests record `(tickIndex, cmd)` pairs.

**`catchUp(gap, nowMs, { hidden })`**:
```
full    = hidden ? min(gap, OFFLINE.hiddenFullSec) : 0        // hidden-tab time at 100 % efficiency, up to 4 h
rest    = gap − full
{ capSec, eff } = offlineCapEff(s, d)
offSec  = min(rest, capSec);  beyond = rest − offSec
summary = simulateOffline(s, d, full, { eff: 1 }) merged with simulateOffline(s, d, offSec, { eff })
seasons.skipTime(s, beyond)                                    // the real-time season clock still advances
bankBeyondCap(s, beyond); bankSavedFinds(s, gap)
d = createDerived(); stepFn(s, d, 0, [], {})                   // rebuild caches
publish only these event types from the offline run: achievement, unlock, fieldGuide, chamberActivated, researchBought
publish { type: 'offlineDone', summary }
```
**`loadOrNew(nowMs)`**: read `SAVE.key` through `save.storageWrap(storage)`; if absent → `newGame`. If present → `fromExportString`; on failure try `SAVE.backups` in order; if all fail → `newGame` and return `{ loaded: false, error }` (the corrupt string is kept under `sld_save_corrupt` for the user). Then `gap = (nowMs − s.meta.lastSeen) / 1000`; `s.meta.flags.clockSkew = gap < 0` (set or cleared on every load, C78); if `gap < 0` → `gap = 0`; if `gap < 60` → run it as online ticks; else `welcome = catchUp(gap, nowMs, { hidden: false, hiddenSec })` with `hiddenSec = clamp(savedAt − lastSeen, 0, gap)`, the hidden-tab part of the gap (C78) (welcome is returned only if `gap ≥ LOOP.welcomeMinSec`). The save generation `TABS.genKey` is read into `game.saveGen` before the save is read (C80).

**`save(nowMs, { hidden = false })`**: if the stored `TABS.genKey` is ahead of `game.saveGen` (or `game.stale`), write nothing, set `stale`, publish `{type:'saveStale'}` once and return `{ ok: false, error: 'stale' }` (C80). `s.meta.savedAt = nowMs`; `s.meta.lastSeen = nowMs − backlog`, or with `hidden: true` (the simulation is paused) `min(lastSeen, nowMs)` (C78); write `toExportString(s, nowMs)` to `SAVE.key`, then `TABS.genKey` = generation + 1; every `SAVE.backupEverySec` of wall time also rotate `bak_1→bak_2`, `bak_0→bak_1`, current → `bak_0`. Any storage exception sets `storageOk = false`, publishes `{type:'storageError'}`, returns `{ ok: false }`.

**`importString(str, nowMs)`**: `fromExportString`; on success replace `s`, rebuild `d`, set `s.meta.lastSeen = nowMs` (**no offline credit on import**), clear the queue and accumulator, publish `{type:'imported'}`. On failure the current state is untouched.

**`hardReset(nowMs)`**: remove `SAVE.key` and backups, `newGame(nowMs)`. (The UI requires typing `abandon` first.)

### 7.2 The step function (`core/step.js`)
```js
export function step(s, d, dt, commands = [], opts = {}) → GameEvent[]
// opts: { offline = false, eff = 1, econScale = 1 }. dt may be 0 (derive-only pass); every system must accept dt = 0.
```
Fixed order (the integrator may reorder only by changing this document):
```js
const env = makeEnv(dt, opts);           // §7.3
resetLedger(d);                          // d.ledger.* = {}
for (const cmd of commands) applyCommand(s, d, cmd, env);   // core/commands.js
if (s.meta.pending) {                    // landing chooser open: the run is frozen
  seasons.tick(s, d, dt, env);           // the real-time clock keeps running
  s.meta.tick++; s.meta.simTime += dt;   // run.time does NOT advance
  return env.events;
}
tickEffects(s, dt, env);                 // core/effects.js
seasons.tick(s, d, dt, env);             // WP6 → d.season
prestige.derive(s, d);                   // WP7 → d.meta
nest.derive(s, d);                       // WP3 → d.nest   (geometry rebuilt only when s.run.nest.rev changed)
surface.derive(s, d);                    // WP4 → d.surface (territory rebuilt only when s.run.surface.rev changed)
stats.recompute(s, d, env);              // WP2 → d.stats
trails.tick(s, d, dt, env);              // WP4 strength, allocation, yields → d.surface.trails, d.ledger
surface.tick(s, d, dt, env);             // WP4 scouting, sources, claim channel, radius, tPeak
nest.tick(s, d, dt, env);                // WP3 dig queue, backfill, caches, activation, entrances
economy.tick(s, d, dt, env);             // WP2 ledger → resources, upkeep, caps, Hungry, f_run
population.tick(s, d, dt, env);          // WP2 laying, development, hatching, frost, then nutrition (larvae eat first)
jobs.tick(s, d, dt, env);                // WP2 automation and consistency
rivals.tick(s, d, dt, env);              // WP5 rivals, parties, battles (4 Hz), conquest → d.combat
raids.tick(s, d, dt, env);               // WP5
events.tick(s, d, dt, env);              // WP6
golden.tick(s, d, dt, env);              // WP6
hardships.tick(s, d, dt, env);           // WP7
automation.tick(s, d, dt, env);          // WP7
prestige.tick(s, d, dt, env);            // WP7 projections, peak, ending
bottleneck.tick(s, d, dt, env);          // WP2
unlocks.tick(s, d, dt, env);             // WP6
fieldguide.tick(s, d, dt, env);          // WP6
achievements.tick(s, d, dt, env);        // WP6
s.meta.tick++; s.meta.simTime += dt; s.run.time += dt;
guardTick(s, env);                       // core/guard.js
return env.events;
```
Systems later in the order may **scan `env.events`** for this tick's events (achievements, field guide and golden pupae use this). A system that needs to react to something an *earlier-ordered* system does must use a listed **[x]** call instead (for example `nest.tick` calls `surface.addEntrance` when a shaft opens).

### 7.3 The tick environment
```js
env = {
  dt,                         // real-time seconds this tick (seasons, timers, events, raids, battles)
  econDt: dt * econScale,     // economy, laying, brood development and digging integrate over econDt (Diapause speed-up)
  offline: false,             // true inside simulateOffline: DESIGN §21.4 freezes apply
  eff: 1,                     // offline efficiency: multiplies every production rate AND upkeep (economy, dig, scouting)
  events: [],                 // GameEvent[] collected this tick
  emit(type, payload = {}) { this.events.push({ type, ...payload }); },
}
```
**Who applies `eff`:** `economy.tick` (all ledger rates, passives, pheromone regen, upkeep), `nest.tick` (dig work), `surface.tick` (scouting speed, claim channel). `trails.tick` writes raw rates and never applies `eff`. Laying, brood development, seasons and the dig queue run in (econ) real time.

### 7.4 Commands and handlers (`core/commands.js`)
A command is a plain object `{ type: string, ...args }` (catalogue in §9). Every system module that owns commands exports:
```js
export const handlers = {
  placeChamber: {
    validate(s, d, cmd) { return null; },  // pure; returns null (ok) or a ReasonCode string. Called by actions (sync) AND before apply.
    apply(s, d, cmd, env) { /* mutate */ }, // called only after validate returned null; may emit events
  },
};
```
```js
// core/commands.js
export const HANDLER_MODULES = [economy, population, jobs, adaptations, nest, surface, trails, rivals, raids, research,
                                seasons, events, golden, prestige, traits, hardships, automation];
export const CORE_HANDLERS = { setSetting, uiFlag, equipCosmetic };
export function buildRegistry(modules = HANDLER_MODULES) → Record<string, Handler>   // throws Error on a duplicate type
export function validateCommand(s, d, cmd, reg = REGISTRY) → ReasonCode | null        // 'unknown' when no handler; 'paused' (below)
export function applyCommand(s, d, cmd, env, reg = REGISTRY) → boolean
    // validate → apply; on failure env.emit('commandRejected', { cmd, reason })
export const PAUSE_OK = new Set(['chooseLanding', 'setSetting', 'uiFlag', 'equipCosmetic', 'buyTrait', 'buyFederation',
                                 'buyGenome', 'setAutomation', 'setHeirlooms']);   // only these validate while s.meta.pending
```
**ReasonCode** strings: `unknown`, `paused`, `locked`, `cantAfford`, `invalid`, `max`, `noSlot`, `blocked`, `cooldown`, `busy`, `hardship`, `notFound`, `queueFull`, `clickCap`, `requirements`. A handler may append a machine detail after a colon (`blocked:stone`, `invalid:row`, `noSlot:trail`). `ui/text.js` maps codes (and known details) to player text.

### 7.5 Actions (`core/actions.js`)
```js
export function createActions(game) → Actions
// Actions.do(type, args = {}) → { ok: boolean, reason: ReasonCode | null }
//   cmd = { type, ...args }; reason = validateCommand(game.s, game.d, cmd); if (reason) return { ok: false, reason };
//   if (PRESTIGE_TYPES.has(type)) game.hooks.beforePrestige?.();   // save before every prestige (DESIGN §22)
//   game.queue.push(cmd); return { ok: true, reason: null };
// For every registered type, Actions[type] = (args) => Actions.do(type, args)   e.g. actions.placeChamber({ chamber: 'gallery', x: 5, y: 3 })
export const PRESTIGE_TYPES = new Set(['fly', 'startHardship', 'supercolony', 'speciate']);
```
UI and render code mutate the game **only** through `game.actions`. The tools (`simulate.mjs`) use the same API.

### 7.6 Event bus (`core/bus.js`)
```js
export function createBus() → { on(type, fn) → off, off(type, fn), emit(type, payload), clear() }
// type '*' receives every event as fn(payload). Handlers run synchronously; exceptions are caught and console.error'd.
```
Besides step events (§10), `game.js` publishes: `saved {ok}`, `storageError {error}`, `saveStale {stored, mine}` (C80), `reset`, `imported`, `welcome {summary}`, `offlineDone {summary}`.

### 7.7 Effects (`core/effects.js`) and stat keys
```js
export function addEffect(s, eff) → void
    // eff = { id, stat, mult = 1, add = 0, scope = null, t }  (t seconds, or -1 = until removed)
    // same id already present → replaced; the new t is max(old.t, new.t) unless eff.reset === true (then new t)
export function removeEffect(s, id) → boolean
export function removeEffectsWhere(s, pred) → number
export function tickEffects(s, dt, env) → void      // t > 0: t −= dt; t ≤ 0 → removed, env.emit('effectEnded', { id, stat })
export function effectMult(s, stat, scope = null) → number   // Π mult over effects with e.stat === stat && e.scope === scope (strict)
export function effectAdd(s, stat, scope = null) → number    // Σ add, same matching
export function hasEffect(s, id) → boolean
export function effectsFor(s, stat) → Effect[]               // any scope
```
A global query (`scope = null`) does **not** include scoped effects; callers query each scope they need.

| `stat` | `scope` | Meaning | Read by | Written by |
|---|---|---|---|---|
| `forage` | null | × forage (DESIGN M_time) | WP2 stats | WP4 frenzy; WP6 golden frenzy (5), pupa frenzy (5), fire-ant rafts (1.25), cordyceps quarantine (0.8) |
| `forage_trail` | trail uid | × that trail (Rally) | WP4 trails | WP4 rally |
| `forage_add` | null | + forage A_add | WP2 stats | WP6 myrmecophile (+0.15) |
| `forage_unescorted` | null | × trails lacking full escort | WP4 trails | WP6 phorid flies (0.9) |
| `surface_work` | null | × forage, honeydew and leaves (0 = sealed/evacuated) | WP2 stats | WP6 rainstorm seal, army-ant evacuate |
| `source_type` | source type id | × yield of that source type | WP4 trails | WP6 seed mast (3), drought (flower 0.3, leaf_plant 0.5) |
| `source` | source uid | × yield of that source | WP4 trails | WP6 ladybug raid (0.5) |
| `honeydew` | null | × honeydew channel | WP2 stats | WP6 golden aphid (7), drought (1.5), phengaris cuckoo (0.9) |
| `lay` | null | × lay rate | WP2 stats | WP6 queen's vigor, wandering queen, golden lay burst; WP7 boon_royal_vigor |
| `brood_time` | null | × brood time | WP2 stats | WP6 brood mites (1.5) |
| `insight` | null | × insight (library and scouting) | WP2 stats | WP6 pheromone bloom (2) |
| `atk_player` | null | × player ATK | WP5 combat | WP6 phorid flies (0.5) |
| `ap_rival` | null or rival uid | × rival AP | WP5 combat | WP6 rival mating flight (0.7, null), rival queen dies (0.5, uid) |
| `chamber` | chamber uid | × chamber effect | WP3 nest.derive | WP6 mold spots (0.5 each, t = −1) |
| `chamber_layer` | layer id | × chambers in that layer | WP3 nest.derive | WP6 rainstorm keep-foraging (topsoil 0.5), flood (topsoil 0) |
| `frost_snap` | null | add = rows frozen | WP6 seasons | WP6 events |
| `flight_w` | null | mult = weather W override (W = max(season W, mult)) | WP7 prestige | WP6 flight day (1.5) |
| `no_raids` | null | presence blocks rival raids | WP5 raids | WP7 boon_peaceful_start (t 1200) |

### 7.8 Wallet (`core/wallet.js`)
```js
// Resource keys: run resources (food, soil, insight, pheromone, chitin, honeydew, leaves, fungus) → s.run.res;
// alates → s.cycle.alates; kinship → s.era.kinship; genes → s.meta.genes.
export function canAfford(s, cost) → boolean          // null cost → false
export function missing(s, cost) → Cost               // per-resource deficit ({} when affordable)
export function spend(s, cost) → boolean              // all-or-nothing
export function refund(s, d, cost, frac = 1) → void   // adds frac × cost (food may not exceed the cap; capped resources clamp)
export function grant(s, d, res, amount, { overflow = false, countFRun = true } = {}) → number
    // one-shot reward. food: added up to d.stats.foodCap (FOOD_OVERFLOW × cap if overflow); the excess goes to run.stats.foodWasted;
    //   when countFRun, the FULL amount is added to run.fRun and meta.stats.foodEver.
    // honeydew/leaves/fungus/pheromone clamp at their d.stats caps; others clamp at CLAMP_MAX. Returns the amount actually added.
export function incomeSeconds(d, res, sec, min = 0) → number   // max(min, sec × d.rates[res].avg), gross when no avg (C76)
export function timeToAfford(s, d, cost) → number             // seconds at current net rates; 0 if affordable; -1 if never
export function scaleCost(cost, k) → Cost
```

### 7.9 RNG (`core/rng.js`)
All functions take a **holder** object with a uint32 `rng` field; the state object `s` is the main holder. Child generators use `makeHolder(seed)`.
```js
export function nextU32(h) {                     // mulberry32, exact
  let t = (h.rng = (h.rng + 0x6D2B79F5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}
export function rand(h) → [0, 1)                 // nextU32(h) / 4294967296
export function randInt(h, lo, hi) → integer in [lo, hi]
export function randRange(h, lo, hi) → float in [lo, hi)
export function chance(h, p) → boolean
export function pick(h, arr) → element
export function weighted(h, entries) → entry     // entries have numeric `w`
export function shuffle(h, arr) → arr            // in place, Fisher–Yates
export function expSample(h, mean) → seconds     // −mean × ln(1 − rand)
export function makeHolder(seed) → { rng: (seed >>> 0) || 1 }
export function deriveSeed(h) → uint32           // child seeds (map, nest, landing options)
```
- `mapgen` uses `makeHolder(mapSeed)`; `nestgen` uses `makeHolder((seed ^ 0x9E3779B9) >>> 0)`.
- Previews (battle preview, landing previews, trail previews) **never** use `s` as a holder.
- Render and UI may use `Math.random()` for cosmetic jitter only.

### 7.10 Hex geometry (`core/hex.js`)
Axial `(q, r)`, pointy-top, max radius 16 (817 hexes). Hexes are addressed by a **spiral index**:
```
index 0 = (0, 0)
for k = 1..16:
  (q, r) = (−k, k)                       // k × DIRS[4]
  for side = 0..5: for step = 0..k−1: emit (q, r); (q, r) += DIRS[side]
DIRS = [[1,0], [1,−1], [0,−1], [−1,0], [−1,1], [0,1]]
```
Ring k occupies indices `[1 + 3k(k−1), 3k(k+1)]`, so `hexesInRadius(R)` is exactly `[0, 1 + 3R(R+1))` (217 / 469 / 817 for R = 8 / 12 / 16). Ring 1 is `1:(−1,1) 2:(0,1) 3:(1,0) 4:(1,−1) 5:(0,−1) 6:(−1,0)`; hex 3 is due east of the entrance.
```js
export const DIRS, HEX_COUNT = 817;
export function countInRadius(R) → 1 + 3R(R+1)
export function hexIndex(q, r) → index | −1      // −1 outside radius 16
export function hexQR(i) → [q, r]
export function ringOf(i) → number
export function neighbors(i) → number[]          // precomputed table; only indices inside radius 16
export function hexDist(a, b) → number
export function hexToPixel(i, size) → [x, y]     // x = size·√3·(q + r/2), y = size·1.5·r; origin at hex 0
export function pixelToHex(x, y, size) → index | −1   // cube rounding
export function hexesInRadius(R) → number[]
export function hexPath(from, to, costFn, maxCost = Infinity) → { path, cost } | null
    // A*; costFn(i) = cost of ENTERING hex i, or null if impassable; heuristic hexDist × min step cost; ties broken by lower index
export function lineHexes(a, b) → number[]
export function colForHex(i) → number            // nest column for root lines: clamp(round(20 + 6 × (q + r/2)), 1, 38)
```

### 7.11 Math helpers (`core/math.js`)
```js
export function sc(x, s, p) → x <= s ? x : s * (x / s) ** p
export function scChain(x, chain, sMult = 1) → { value, capped }   // chain [[s,p],…] in sequence; sMult multiplies the FIRST threshold only
export function clampNum(x, lo = 0, hi = CLAMP_MAX) → number       // NaN → lo
export function geoCost(base, growth, L) → Cost | null              // base × growth^L per component; null if any component > COST_MAX
export function costOrNull(cost) → Cost | null
export function lvl(map, id) → map[id] || 0
export function safeDiv(a, b, fallback = 0) → number
export function sumGeo(baseCost, growth, fromL, n) → Cost | null    // total of n consecutive levels (bulk buy)
export function lerp(a, b, t), approxEq(a, b, rel = 1e-9)
```

### 7.12 Guard (`core/guard.js`)
```js
export function guardTick(s, env) → void
    // Every tick, HOT paths: run.res.*, run.fRun, run.colony.adults.*, cycle.alates, cycle.alatesCycle, era.kinship, era.kinshipLife, meta.genes, meta.genesLife.
    //   Non-finite → revert to the last good value (shadow copy kept in a WeakMap keyed by s) or 0; clamp to [0, CLAMP_MAX];
    //   meta.stats.nanGuards++, env.emit('nanGuard', { path }), console.error once per path per session.
    // Every GUARD.fullEveryTicks ticks: walk the whole state; any non-finite number → 0 (same reporting).
export function guardAll(s) → number            // full walk; used after load/import; returns fixes
```

### 7.13 Save codec (`core/save.js`)
```js
export const RLE_PATHS = ['run.nest.cells', 'run.surface.terrain', 'run.surface.revealed', 'run.surface.claimed', 'run.surface.conquered'];
export function rleEncode(arr) → string          // "rle:" + runs joined by ","; run = "v*n" (or "v" when n = 1). [0,0,0,1] → "rle:0*3,1"
export function rleDecode(str) → number[]
export function encodeState(s) → object          // deep copy with RLE_PATHS packed
export function decodeState(obj) → State
export function fnv1a(str) → string              // FNV-1a 32-bit over the UTF-8 bytes; 8 lowercase hex chars
export function utf8ToBase64(str) → string       // own implementation via TextEncoder; no btoa/Buffer
export function base64ToUtf8(b64) → string
export function toExportString(s, nowMs) → string
    // json = JSON.stringify({ v: s.v, savedAt: nowMs, state: encodeState(s) }); return SAVE.prefix + utf8ToBase64(json) + ':' + fnv1a(json)
export function fromExportString(str) → { ok: true, state, savedAt } | { ok: false, error }
    // prefix check → split on the LAST ':' → base64 → checksum → JSON.parse → v ≤ SCHEMA_VERSION → migrate → decodeState → fillDefaults → guardAll
    // error codes: 'badPrefix' | 'badBase64' | 'badChecksum' | 'badJson' | 'tooNew' | 'migrationFailed' | 'invalidState'
export function storageWrap(storage) → { get(key) → string|null, set(key, val) → boolean, remove(key) → boolean }   // every call in try/catch
```
The local save and the export string are the **same format** (one codec). `StrataRecord.cells` are stored already packed (`"bits:"`, C85).

### 7.14 Migrations (`core/migrations.js`)
```js
export const MIGRATIONS = {};                    // MIGRATIONS[v] = (payload) => payload of version v + 1
export function migrate(payload) → payload       // while (payload.v < SCHEMA_VERSION) { payload = MIGRATIONS[payload.v](payload); payload.v++; }
export function fillDefaults(state, defaults = createState()) → state
    // recursively copies keys missing from `state` (plain objects only; arrays and leaves are never merged)
```
Any shape change after v1 ships means: bump `SCHEMA_VERSION`, add `MIGRATIONS[v]`, add `tests/fixtures/save_v<v>.txt` and a test.

### 7.15 Offline progress (`core/offline.js`)
```js
export function offlineCapEff(s, d) → { capSec, eff }
    // capSec = OFFLINE.baseCapSec + RESEARCH.collective_memory.fx.offlineSec·[owned] + TRAITS.long_memory.fx.capSec·L + CHAMBERS.deep_vault.fx.offlineSec·d.nest.agg.deepVaultL
    // eff    = min(1, OFFLINE.baseEff + TRAITS.long_memory.fx.eff·L + RESEARCH.diapause_logic.fx.offlineEff·[owned])
    // federation diapause_mastery → capSec = max(capSec, 86400), eff = 1; genome dreaming_hive → capSec = max(capSec, 172800), eff = 1
export function offlineSchedule(seconds) → number[]
    // 10 s steps for the first 600 s, then 60 s steps; if more than 1,500 steps, multiply every step by count/1500;
    // the last step is trimmed so the sum equals `seconds` exactly. 24 h → 1,490 steps.
export function simulateOffline(s, d, seconds, { eff, stepFn = step } = {}) → OfflineSummary
    // d.offlineLog = { cells: [], chambers: [] }; snapshot counters; for each size: stepFn(s, d, size, [], { offline: true, eff });
    // summary from counter differences; d.offlineLog = null after copying it into the summary.
export function bankBeyondCap(s, beyondSec) → number   // diapause.bank += min(beyond × 0.10, bankMax − bank)
export function bankSavedFinds(s, gapSec) → number     // savedFinds = min(3, savedFinds + floor(gap / 7200))
// OfflineSummary = { seconds, eff, foodGained, foodWasted, hatched, cellsDug, chambersDone, seasons, sourcesDepleted,
//                    savedFinds, diapause, cells: [cellIdx…], chambers: [uid…] }
```
**Contract for every system under `env.offline = true`** (DESIGN §21.4): no events, beetles, pupae, raids, battles, hunts, rival growth, creep, spoilage, frost deaths, Hungry penalties, auto-flight; trail strength sits at equilibrium; finite sources deplete and their workers re-allocate. Every system must handle `dt` up to ~60 s in **O(1) work per call** (never loop in 0.1 s sub-steps): population lays a whole batch at once, nest digs as many cells as the work allows, economy integrates once. **Torpor floor:** no code path may reduce adults while offline.

---

### 7.16 Tab lock (`core/tablock.js`)
```js
export function createTabLock({ id, storage, channel, listenStorage, now, setTimer, clearTimer, onYield }) → TabLock
// every browser API is injected (§1 rule 3): channel = BroadcastChannel(TABS.channel) or null; listenStorage(fn(key, newValue))
// subscribes to window 'storage' events and returns an unsubscribe; onYield({ flush, by }) → save generation written or null
// TabLock = { id, enabled, owner, acquire() → Promise<{ waited, released }>, check() → boolean, release(), destroy() }
```
The newest tab owns the game (C80). `acquire()` (once, at boot) writes `TABS.lockKey = { id, at, beat, deadline }` and posts a claim; when the entry it replaced shows another live owner (heartbeat younger than `TABS.staleMs`) it waits up to `handoverMs + settleMs` for a `released` answer and for the generation that answer names to be visible, then resolves. An owner that sees a newer claim (message, the entry's `storage` event, or `check()`) calls `onYield({ flush })` once, where `flush` is true only before the claimer's `deadline`, answers `released`, and stops its heartbeat. `check()` re-reads the entry: false when this tab no longer owns the game (stepping aside if a newer entry is found), and it re-writes a lost entry. `release()` (pagehide) removes the entry if it is this tab's. Without readable storage the lock is disabled and always owner. `main.js` (§14.7) runs and saves the game only while `owner`. A tab that pauses for another one also sets `game.stale`, so no direct `game.save` (Settings "Save now", the import autosave, the console) can write before the new owner's first save and turn the new owner stale (final QA).

## 8. System module interfaces

Generic shape of a system module (all optional):
```js
export function derive(s, d) {}              // recompute this module's d subtree; idempotent; cheap every tick (gate heavy work on rev counters)
export function tick(s, d, dt, env) {}       // advance simulation by dt
export const handlers = { /* §7.4 */ };      // player commands owned by this module
```
Markers: **[q]** = pure query, callable by any package including render/UI. **[x]** = cross-callable mutator, callable only by the systems named. Signatures below are exact; argument objects use the listed property names.

### 8.1 WP2 Colony economy

#### `systems/stats.js`
```js
export function recompute(s, d, env) → void                // fills d.stats (§5) every tick
export function eggCost(s, d, caste) → Cost                // [q] next egg of that caste: { food, …extras }
export function winterR(s, d) → number                     // [q] combined relative reduction R of the winter forage penalty
```
Pinned formulas (L = level, `[x]` = 1 if owned else 0, `lv(id)` = research/adaptation/trait/federation/genome level from state):
- `colonyScale = d.meta.colonyScale`.
- `housing = d.nest.agg.housingBase × 1.25^[gallery_arches] × 2^[compact_galleries] × colonyScale`.
- `broodSlots = Σ d.nest.agg.broodGroups[].cap × colonyScale` (group caps are never halved by frost; frost works through freezing).
- `berths = berthsBase × colonyScale`, `repleteBerths = repleteBerthsBase × colonyScale`, `alateCells = agg.alateCells` (not scaled), `gardenerSlots = agg.gardenerSlots × colonyScale` (DESIGN §5.6, §6.2).
- `foodCap = (150 + agg.granaryCap) × (1 + 0.02 × repletes × (agg.adjGranaryRepletion ? 1.25 : 1) × (sp.repleteCap ?? 1)) × d.season.mods.foodCap × (ach_hoarder ? 1.1 : 1) × (sp.foodCap ?? 1)`.
- `honeydewCap = 50 + 0.1 × foodCap`; `leafCap = agg.leafCap`; `fungusCap = agg.fungusCap`; `pheromoneCap = 50 + 50·[pheromone_glands] + 5 × mound`.
- `hungry = s.run.colony.hungry ? 0.75 : 1` (applies to forage, dig, honeydew, leaves, fungus, chitin and insight).
- `layRate = hungry-state ? 0 : Σ_{lv ∈ agg.royal} (0.2 + 0.05·RF) × 1.15^(lv − 1) × M_lay × colonyScale`, where RF = `royal_feeding` level (0 under `claustral_founding`) and `M_lay = 1.5^[royal_pheromones] × 2^[spermathecal_reserve] × 1.25^queens_feast × d.meta.prestige.lay × d.season.mods.lay × effectMult('lay') × 1.1^brood_refinement × 1.02^(ach_thousand_strong + ach_ten_thousand + ach_myriad) × 1.05^[ach_royal_ascent]`.
- `eggCost[c].food = 10 × (1 + 0.02 × popN)^1.5 × 0.7^[trophic_eggs] × CASTES[c].eggMult × (minor && naniticsLeft > 0 ? 0.5 : 1) × (replete ? sp.repleteCost ?? 1 : 1)`; extras per `CASTES[c].extra`.
- `mbt = 0.75^[brood_care] × d.season.mods.broodTime × (fungalBrood && fungus > 0 ? 0.75 : 1) × effectMult('brood_time')`; `nurseTerm = 1 + min(4, (jobs.nurse + 1) / broodSlots)`.
- `workerMult = nanitic × golden × social` with `nanitic = [nanitic_vigor] ? (m + 2·min(50, m)) / max(1, m) : 1` (m = minors), `golden = 1 + 9 × colony.golden / max(1, m)`, `social = [sig_social_stomach] ? 1 + min(0.5, 0.01 × floor(repletes / 5)) : 1`.
- `middenOut = min(0.2, 0.02 × agg.middenL)`; `satellites` = number of `entrances` with kind `satellite`.
- **Forage:** `aAdd = 1 + 0.10·strong_mandibles + min(1, 0.005 × d.surface.ownedCount) + middenOut + 0.25 × satellites + effectAdd('forage_add')`; `mRun = 1.25^[trail_memory] × 1.75^[recruitment_pheromones] × 1.12^potent_trails × nutrition × 1.1^foraging_refinement × edict (plenty 2, war 0.9)`; `mTime = seasonForage × effectMult('forage') × effectMult('surface_work') × hungry`; `mPrestige = d.meta.prestige.food`; `total = aAdd × mRun × mTime × mPrestige × workerMult`. (`trunk_trails` ×1.5 is per trail, applied by WP4.)
- `seasonForage = winter ? 1 − (1 − d.season.mods.forage) × (1 − R) : d.season.mods.forage`; `R = 1 − Π(1 − rᵢ)` over: chimney `min(0.6, 0.1 × agg.chimneyL)`, mound `min(0.3, 0.03 × mound)`, `seasonal_clock` 0.2, `seasonal_wisdom` 0.25, `eternal_winter` reward `0.1 × tier`, honeypot `winterForageHalf` 0.5.
- **Dig:** `digW = scChain(jobs.digger^0.85 × aDig × mRunDig × mTimeDig × d.meta.prestige.dig × workerMult, SOFTCAPS.dig, scMult.dig).value`, with `aDig = 1 + 0.25·digging_claws + middenOut + 0.25 × satellites`, `mRunDig = 1.5^[coordinated_digging] × 2^[acid_excavation] × 1.1^excavation_refinement × nutrition × (edict_of_depth 3) × (ach_bedrock_bound 1.05)`, `mTimeDig = d.season.mods.dig × hungry`. `soilMult = ach_gravel_pit ? 1.05 : 1`.
- **Honeydew** channel `= 1.1^agg.rootPenCount × 2^[sugar_economy] × 1.15^sweet_tooth × 1.1^husbandry_refinement × nutrition × d.meta.prestige.honeydew × effectMult('honeydew') × effectMult('surface_work') × hungry × workerMult × (ach_shepherd 1.1)`.
- **Leaves** `= nutrition × d.meta.prestige.leaves × effectMult('surface_work') × hungry × workerMult`. **Fungus** `= 1.5^[weeder_ants] × 1.1^husbandry_refinement × (ach_into_the_clay 1.1) × (site_wet_hollow 1.2) × d.meta.prestige.fungus × hungry`. **Chitin** `= d.meta.prestige.chitin × hungry`.
- **Insight:** `common = 2^[collective_memory] × 1.5^[hive_mind] × 1.1^communication_refinement × d.season.mods.insight × effectMult('insight') × d.meta.prestige.insight × (ach_the_large_blue 1.05) × (ach_sociobiologist 1.25) × hungry`; `library = common × 1.5^[chemical_lexicon]` (ventilation is already inside nest `eff`; do not re-apply); `scouting = common × 1.5^[antennation]`; `oneShot = d.meta.prestige.insight`.
- **Upkeep** `= Σ CASTES[c].upkeep × adults[c] + 0.5 × alatesReared`; in winter `× 0.8^[overwintering] × 0.75^[diapause_logic] × (1 − min(0.5, 0.1 × agg.hibL)) × (ach_survivor 0.95)`, then minus repletes' cover `min(0.05 × repletes, 0.5 × upkeep)`. Never multiplied by production multipliers.
- `phiCoef = sp.phiCoef ?? ([fungal_symbiosis] ? 1.0 : 0.5)`; `nutrition = [fungiculture] ? 1 + phiCoef × colony.phi : 1`.
- **Combat:** `atk = 1.1^serrated_mandibles × 1.3^[formic_acid] × (1 + min(0.5, 0.05 × agg.barracksL)) × 1.25^warrior_lineage × 2^[venom_gland]`; `hp = 1.1^thick_cuticle × 1.25^warrior_lineage × (ach_total_war 1.1)`; `ap = 2^[war_chemistry] × 1.1^warfare_refinement × edict (war 2, plenty 0.75) × d.meta.prestige.ap × (ach_square_law 1.05)`.
- `pheromoneRegen = (0.5 + 0.05 × √adultsTotal) × 1.5^[pheromone_glands]`.
- `clickValue = (1 + quick_dispatch) × (ach_clickstorm ? 2 : 1) + p × d.rates.food.gross`, `p = L < 10 ? 0 : min(0.05, 0.01 + 0.001 × (L − 10))`.
- `scMult.food = scMult.dig = 1e6^thermal_ceiling`.

#### `systems/economy.js`
```js
export function tick(s, d, dt, env) → void
export const handlers = { clickForage }
export function winterProjection(s, d) → { stored, netPerSec, spoilPerMin, winterSec }   // [q] Winter Stores gauge
```
Tick, in order:
1. Passives into the ledger: `insight.library = agg.libraryInsight × stats.insight.library`; `honeydew.pens = 0.05 × agg.rootPenL × (winter ? 0.5 : 1)` (raw, per DESIGN §12.7).
2. Fungus gardens: `active = min(jobs.gardener, stats.gardenerSlots)`; leaf demand `0.3 × active`; `ratio = min(1, (leaves + leafInflowThisTick) / (demand × econDt))`; `fungus.gardens = active × 0.1 × ratio × agg.fungusMod × stats.fungus`; leaves consumed `demand × ratio × econDt × eff`.
3. For each resource: `raw = Σ ledger[res]`; `gross = scChain(raw, SOFTCAPS[res], scMult).value` (food, insight, honeydew, fungus, chitin; leaves unsoftcapped); per-source shares scaled pro rata into `d.rates[res].src`; emit `softcapHit {stat}` the first time a stat caps (per run).
4. **Food:** `delta = gross × eff × econDt`. If `food < cap`: `food = min(cap, food + delta)` (excess → `foodWasted`); if `food ≥ cap` (incl. overflow above cap): production adds nothing (all of `delta` → `foodWasted`). `fRun += delta` and `meta.stats.foodEver += delta` **regardless of the cap**. Then `food −= stats.upkeep × eff × econDt`, floor 0.
5. Spoilage (online only): `food −= food × agg.clayFoodShare × 0.005 / 60 × dt`.
6. Other resources: `+= gross × eff × econDt`, clamped to caps. **Soil** `+= stats.digW × stats.soilMult × eff × econDt` (1 soil per 1 work, always, even when the queue is empty).
7. Pheromone (only once `scent_marking` is owned): `+= stats.pheromoneRegen × eff × econDt`, clamp to cap.
8. (Nutrition is **not** drawn here. "Larvae eat first" (DESIGN §6.4): it is drawn at the end of `population.tick`, after laying has paid every fungus egg cost.)
9. Hungry (online only): enter when `food ≤ 0 && net < 0`; leave when `food > 0.05 × foodCap`; emit `hungryStart` / `hungryEnd`. Offline: `hungry = false`. With `settings.harshNature` and Hungry (online), `population.killAdults` 0.5 %/s of adults (cause `'starvation'`).
10. Fill `d.rates`. `food.clicks` = click food per second averaged over the last 5 s. `d.rates[res].avg` (ledger resources) = the exponential moving average of `gross` with time constant `INCOME_AVG.sec` (exact for any step length; a fresh derived cache starts it at the current gross), which `wallet.incomeSeconds` reads (C76).
11. Per-step transient `env.foodSpill`: the part of this step's wasted food produced while food sat **at** the cap, which `population.tick` may spend on eggs before the store (C70).

`clickForage {src}`: valid if the source exists, is not `prey_*`, `termite_mound` or `lycaenid_caterpillar` (`'invalid'`), its hex is revealed, the run is not `claustral_founding` (`'hardship'`), and `clickAvailable(s)`; apply `consumeClick(s)`, `wallet.grant(s, d, 'food', stats.clickValue)`, emit `clicked {src, amount}`.

#### `systems/population.js`
```js
export function tick(s, d, dt, env) → void
export const handlers = { setCasteTargets, setEggReserve, setFungalBrood, rearAlate, groomBrood, clickQueen, retireAdults }
export function addAdults(s, d, caste, n, { capped = false } = {}) → number   // [x] WP5, WP6, WP7. Minors join `forager` (manual mode) or follow targets (auto). capped: clamp to free housing/berths.
export function killAdults(s, d, caste, n, cause, { job = null } = {}) → number // [x] WP2, WP4, WP5, WP6. Minors leave `job` first, then idle, then all jobs proportionally (via jobs.releaseMinors). Callers never call it offline (torpor floor). Emits nothing itself (no env); callers emit adultsDied {caste, n, cause}.
export function killBrood(s, frac, cause) → number                             // [x] WP5, WP6. Removes frac of every cohort; returns the count. Callers emit broodDied {n, cause}.
export function stealBrood(s, frac) → number                                   // [x] WP5 (slave-makers). Like killBrood; returns the count (cause 'stolen').
export function broodAllocation(s, d) → { groups: [{ uid, kind, brood, frozen }], frozenShare, frostShare, bSpeed, reachShare }   // [q]
export function broodSummary(s, d) → { egg, larva, pupa, frozen, total, byCaste }   // [q]
```
Pinned rules:
- **Allocation.** Group caps = `broodGroups[].cap × colonyScale`. Without `thermal_brood_shuttling`, brood B is spread proportionally to cap. With it, groups fill in order: not exposed/snap (by `factor`, descending), then exposed. `frozenRaw` = brood in exposed or snap nurseries; free hibernaculum capacity shelters it first: `frozen = max(0, frozenRaw − hibFree)`. `frozenShare = frozen / B`; `frostShare` = the part frozen by winter exposure (not snap). `bSpeed = Σ (unfrozen brood_g × factor_g) / B` (slot-weighted average of factors when B = 0). `reachShare` = share of brood in groups with `inReach`.
- **Development.** `T(c) = 25 × stats.mbt × CASTES[c].broodFactor / stats.nurseTerm / bSpeed`; each cohort `p += econDt / T × (1 − frozenShare)`. At `p ≥ 1`: hatch (minor/soldier/supermajor/replete via `addAdults`; alates → `alatesReared`). With `golden_brood`, 1 % of hatched minors are added to `colony.golden`. Emit `hatched {caste, n}`.
- **Frost deaths** (online, winter, not mild, year ≥ 1): `killBrood(frostShare × 0.005 × dt, 'frost')`. Snap freezes never kill.
- **Laying.** Skip while hungry or `layRate = 0`. `layAcc += layRate × econDt`; `due = floor(layAcc)`. Per batch choose the caste: (1) alate if `rearRequested > 0` or `meta.automation.autoRear`, and `alatesReared + alate brood < alateCells`; (2) otherwise the caste-slider caste with the largest deficit `target × eggsTotal − eggs[c]`, if its berth is free (`soldier + supermajor + their brood < berths`; repletes `< repleteBerths`), its extras are affordable and storage can ever pay its food (a caste whose one egg costs more than `foodCap × (1 − eggReserve)` and more than this step's spendable food is skipped like a full berth, falling through to the next caste by deficit; the same applies to a requested alate, C71); (3) otherwise minor. `n = min(due, broodSlots − B, housing − minors − B, floor((food − eggReserve × foodCap + env.foodSpill) / eggFood))` (≥ 0), computed at the current egg cost; the at-cap spill `env.foodSpill` is spent first and taken back out of `run.stats.foodWasted` (C70). Spend via `wallet.spend` (food, extras; Fungal Brood 0.5 × broodFactor fungus per egg, auto-off when short; species `eggFungusFrac` once `fungiculture`). Merge into the cohort `{c, t: floor(run.time)}`. `layAcc −= n`; if blocked, clamp `layAcc ≤ max(1, layRate)`. Nanitic half price applies to the first `naniticsLeft` minors. Emit `eggLaid {caste, n}`; update `eggs`, `run.stats.eggs`, `soldiersRaised`.
- **Nutrition** (last step of the tick, only once `fungiculture` is owned): demand `0.005 × adultsTotal × econDt`; supplied `min(fungus, demand)` from the fungus left **after** laying; `fungus −= supplied`; `colony.phi = supplied / demand` (0 when demand is 0). Read by `stats.recompute` on the next tick.
- `retireAdults {caste, n}` (DESIGN §6.1 "Retire to workers"): caste `'soldier'` or `'supermajor'`; `n ≤` that caste in the garrison (`d.combat.garrison[caste]`, i.e. not escorting, in a party or fighting) and `n ≤ housing − minors − broodTotal` (`'noSlot:housing'`); moves `n` adults of that caste to minors (they join `forager` in manual mode, or follow targets); no refund; emits `adultsRetired {caste, n}`. Escort counts on trails are re-clamped by WP4 allocation next tick.
- `groomBrood {chamber}`: needs a click (`consumeClick`; `'hardship'` under `claustral_founding`); every cohort `p += 0.01 × (that nursery's cap / total cap)`. `clickQueen {}`: click + `meta.counters.queenClicks++`. `rearAlate {n}`: needs unlock `alate_rearing` and an active Nuptial Chamber; `rearRequested += n`. `setCasteTargets {soldier, supermajor, replete}`: each caste unlocked, sum ≤ 0.9; `pacifist` forbids soldier/supermajor > 0 and `monomorphic` forbids all (`'hardship'`); also copies the targets into `meta.automation.keep.casteTargets`. `setEggReserve {frac}`: 0..0.9. `setFungalBrood {on}`: needs `fungiculture`.

#### `systems/jobs.js`
```js
export function tick(s, d, dt, env) → void
export const handlers = { shiftJob, setJobs, setJobTargets, setAutoJobs, setThresholdJobs, saveJobPreset, applyJobPreset }
export function idleMinors(s) → number                         // [q] adults.minor − Σ jobs − militia
export function jobCap(s, d, job) → number                     // [q] gardener: d.stats.gardenerSlots; herder: Σ herder-trail caps; others Infinity (locked job: 0)
export function releaseMinors(s, n, job = null) → void         // [x] population.killAdults only: keep Σ jobs + militia ≤ minors
```
- Manual mode: new minors join `forager`. `shiftJob {from, to, n}` (`'idle'` allowed as from/to). `setJobs {jobs}` sets absolute counts (validated ≤ available and ≤ caps). `setJobTargets {targets}` also copies the targets into `meta.automation.keep.jobTargets`.
- Auto mode (`autoJobs`; innate with `automaton_instincts` or `automated_brood`): every `THRESHOLDS.rebalanceSec`, set jobs = targets × available minors, respecting caps and locked jobs. `thresholdJobs` (`response_thresholds`): shift targets toward the current bottleneck (nurses up on `bn_brood_slots`, diggers up when the dig queue holds more than 60 s of work, herders up when honeydew is short for a pending purchase). Only `colony.jobs` and `colony.jobTargets` are written.
- Consistency each tick: if `Σ jobs + militia > minors`, scale jobs down proportionally.

#### `systems/adaptations.js`
```js
export const handlers = { buyAdaptation }                      // { id, n = 1 }
export function cost(s, id, n = 1) → Cost | null               // [q] null = MAX, or capped (monomorphic L10)
export function isAvailable(s, id) → boolean                   // [q] unlock key set and not hardship-blocked (claustral_founding blocks royal_feeding)
export function autobuyStep(s, d, env) → boolean               // [x] WP7 automation: buy the cheapest affordable available level
```
Emits `adaptationBought {id, level}`.

#### `systems/bottleneck.js`
```js
export function tick(s, d, dt, env) → void
```
Writes `run.bottleneck` with priority (C72): `'raid'` (a raid in warning) > `'frost'` (brood frozen, online) > `'hungry'` > `bn_housing` > `bn_brood_slots` > `bn_food_cap` (food ≥ 99 % of cap for > 5 s, tracked in `capT`) > `bn_lay_rate` (food, slot and housing all free but `layAcc < 1`) > `bn_food` (food < egg cost). `since` = run.time when the id last changed. Emits `bottleneckChanged {id}`.

### 8.2 WP3 Nest

#### `systems/nestgeom.js` (pure helpers; render and the bot may call them)
```js
export function idx(x, y) → number             // y * 40 + x
export function xy(i) → [x, y]
export function inBounds(x, y) → boolean
export function layerOf(y) → layerId
export function footprint(type, level) → { w, h }            // grows: w = w0 + min(L,8) − 1, h = h0 + floor((min(L,8) − 1)/3); else w0 × h0
export function rectCells(x, y, w, h) → number[]
export function cellWork(s, i, kind) → number                // [q] layer work (clay 7.2 with clay_masonry; topsoil/loam ×0.8 with site_rich_loam;
                                                              //     ×(1 − 0.05 × shallow_soil reward tier); stone ×3 with acid) ×
                                                              //     (kind 'chamber'|'grow'|'relocate' ×1.5 | 'tunnel' ×0.5 with load_chains, ×0.95 with ach_going_under)
                                                              //     ÷3 (ancestral_blueprint) or ÷5 (blueprint_memory) for blueprint jobs, ×0.5 while boon_blueprint_rush
export function isDiggable(s, i) → boolean                   // [q] SOIL, or STONE with acid_excavation; layer requirement met; shallow_soil hardship: y ≤ 23
export function bfs(open, starts) → Int16Array               // path distances over open cells (4-neighbour)
export function routeTo(s, d, targets, { from = null } = {}) → { cells, work } | null   // [q] A* from any open cell to a cell 4-adjacent to any target; weight = cellWork('tunnel'); stone/water impassable
export function adjacent(s, d, a, b) → boolean               // [q] footprints touch, or a path of ≤ 4 open cells joins them
export function exposedTo(ch, row) → boolean                 // more than half of the chamber's cells have y < row
```

#### `systems/nestgen.js`
```js
export function generateNest(seed, { tags = [], rootCols = [], royalCount = 1 } = {}) → State['run']['nest']
```
Default grid (§4.2) plus: stones (3×3, rows 8–55; ×2 with `site_stony_ground`) as `CELL.STONE`; caches (rows 5–60; ×2 stony; exactly one `amber_bead` in bedrock); water pockets (2–3, +2 with `site_wet_hollow`, rows 40–70) as `CELL.WATER`; root lines at `rootCols` (each `y0 = 1`, `y1 = randInt(6, 25)`; random columns are added until there are at least 6). Features never overlap the shaft, the Royal Chamber or each other. `royalCount = 2` (fire ants) pre-digs a second Royal Chamber (row ≥ 20) linked by tunnel.

#### `systems/nest.js`
```js
export function derive(s, d) → void
export function tick(s, d, dt, env) → void
export const handlers = { placeChamber, levelChamber, relocateChamber, demolishChamber, digTunnel, digTo, backfill,
                          reorderQueue, cancelJob, helpDig, saveBlueprint, loadBlueprint, deleteBlueprint }
export function validatePlacement(s, d, type, x, y, { route = null, relocateUid = 0 } = {}) → PlacementResult   // [q]
    // PlacementResult = { ok, tint: 'green'|'amber'|'red', reason: ReasonCode|null, route: number[]|null, work, eta, cost,
    //                     mods: [{ key: 'layer'|'adjacency'|'hygiene'|'frostExposed'|'floodZone'|'raidReach'|'haul'|'royalRoom', value }] }
export function placementCost(s, type) → Cost | null         // [q]
export function levelInfo(s, d, uid) → { cost, grows, dirs: { left, right, up, down }, work, blocked, max }   // [q]
export function findPlacement(s, d, type) → { x, y } | null  // [q] advisor/bot: best valid spot (adjacency first; granaries/nurseries deep from minute 15;
//   keeps one free L8 growth envelope per existing chamber and prefers spots with room to grow to L8, C60; never boxes
//   the Royal Chamber in below the Flight level unless nothing else fits, C64)
export function blocksRoyalGrowth(s, rect, relUid = 0) → boolean  // [q] the footprint takes the Royal Chamber's last room to reach FLIGHT.royalLevel (C64)
export function chamberAtCell(s, d, i) → Chamber | null      // [q]
export function cellInfo(s, d, i) → { layer, code, work, cache, water, root }   // [q]
export function queueShaft(s, d, col, kind, ref) → number    // [x] WP7: 'shaft' job from row 0 down to the first open cell; returns job uid
export function applyBlueprint(s, d) → number                // [x] WP7 at run start: queue the active blueprint (jobs bypass the queue limit)
export function autoLevelStep(s, d, env) → boolean           // [x] WP7 autobuyer: level the cheapest affordable chamber (auto direction)
export function moleTunnel(s, d, env) → { cells: number[], hint: number }   // [x] WP6 ev_mole_tunnel: picks a diagonal run of 6–12 SOIL or
                                                              //     TUNNEL cells (never chamber, stone or water; rows 1–60) using the main RNG
                                                              //     (s as holder), sets them to TUNNEL, rev++, emits cellDug per cell, and sets
                                                              //     hinted = true on the nearest unfound cache (hint = its cell index or −1). Free (no work, no soil).
```
Pinned rules:
- **Derive.** If `s.run.nest.rev !== d.nest.rev`: rebuild `chamberAt`, `open`, `dist` (BFS from `(20, 0)`), `entDist` (BFS from every open shaft top), per-chamber layer (majority of cells, ties deeper), adjacency lists, `minEntPath`, `inReach` (any cell with `entDist ≤ 15`, granaries and nurseries), hygiene (midden within 6 path cells of a nursery or fungus garden), haul `h = Σ(cap_i × dist_i) / Σ cap_i / 24` over the Royal Chamber (150) and granaries (path = min `dist` over the node's cells). Every tick: exposure (`exposedTo(ch, d.season.frostRow)` unless frost-immune), snap (`exposedTo(ch, d.season.snapRow)`), `eff`, and every `agg` field (§5).
- `eff = (ventilation_shafts ? 1.10 : 1) × (exposed && !frostImmune ? 0.5 : 1) × (layer aquifer ? 1.2 : 1) × effectMult('chamber', uid) × effectMult('chamber_layer', layer) × (hygiene ? 0.8 : 1)`. Chambers that are `'digging'` or `'relocating'` contribute nothing; `'growing'` chambers contribute at their current `level`.
- **Placement** (`placeChamber {chamber, x, y, route?, shaftCol?}`): footprint cells must be SOIL/TUNNEL (STONE only with acid), not WATER, not in another chamber; row rule and `rule` satisfied (`shallow_soil` forbids y > 23); connected directly (a footprint cell 4-adjacent to an open cell) or via the auto-route (prepended tunnel cells); instance limit; queue length < `5 + 2·[load_chains] + 2·[automaton_instincts]` (`'queueFull'`); cost via `wallet.spend` (edict_of_depth ×0.5; blueprint ×0.5). Cells are queued in BFS order from the open cells. The chamber activates (status `'active'`, `level = target`) when its last cell is dug: emit `chamberActivated {uid, type, level}`.
- **Nuptial Chamber**: placement also queues a `'shaft'` job from the chamber's top row up to row 0 at `shaftCol` (default: the nearest column at distance ≥ 3 from every existing shaft), never through the main shaft. When it reaches row 0: push `shafts {kind: 'nuptial', col, open: true}`, call `surface.addEntrance(s, d, 'nuptial', surface.nuptialHex(s, d, col), col, -1)`, emit `entranceOpened {kind, col}`. `agg.nuptial.active` = chamber active **and** shaft open.
- **Level up** (`levelChamber {uid, dir}`): cost `f0 × g^L × 2^k` food + `s0 × g^L × 2^k` soil (+ extras; ×0.5 with edict_of_depth). If the type grows and L < 8: new rect per `dir` (`'left'|'right'` widens, `'up'|'down'` heightens; whichever dimension grows this level); growth cells must be valid, else `'blocked'`; queue a `'grow'` job; `status 'growing'`, `target = L + 1`; the level applies when dug. Otherwise `level++` at once. Emit `chamberLeveled {uid, level}`.
- **Dig tick**: `work = d.stats.digW × env.eff × env.econDt`; loop while work > 0 and the queue is non-empty: spend work on `cells[cur]`; when a cell completes set it to `TUNNEL` or `CHAMBER`, `rev++`, collect a cache there (`wallet.grant(res, incomeSeconds(d, res, sec, min))`; amber → `golden.spawnBeetle(s, d)`, `meta.counters.amber++`), reveal hints and water pockets within Chebyshev 4 (5 with `ach_treasure_hunter`), update `deepestRow`, counters, `run.stats.cellsDug`; emit `cellDug {i}` online, or append to `d.offlineLog.cells` offline. Leftover work → `maint`. Set `d.nest.digFace` and `queueInfo`.
- `helpDig {}`: click (refused with `'hardship'` under `claustral_founding`, C32); adds `5 + 0.03 × digW` work to the first job and the same amount of soil (`wallet.grant` soil).
- `digTunnel {cells}`: a contiguous path starting next to an open cell. `digTo {cell}`: `routeTo` to that cell (cache hints). `backfill {cells}`: tunnel cells only; refused (`'blocked'`) if it would disconnect any chamber from every entrance; cells become SOIL after 10 s.
- `relocateChamber {uid, x, y, route?}`: new footprint valid; job work = 50 % of the new footprint's cell work (×0.75 with `ach_architect`); status `'relocating'` (inactive) until dug; old cells → TUNNEL; level kept; `meta.counters.relocations++`. `demolishChamber {uid}`: refund 50 % of that instance's placement food; cells → TUNNEL; never the Royal Chamber (uid 1) or the last Royal Chamber. `cancelJob {uid}`: refund `paidFood` 100 %; dug cells stay dug. `reorderQueue {uid, to}`.
- Blueprints: `saveBlueprint {slot, name}` stores current chambers and tunnel cells into `era.blueprints[slot]` (slots: 1, or 5 with `blueprint_memory`; requires `ancestral_blueprint`). `loadBlueprint {slot}` sets `activeBlueprint`.

### 8.3 WP4 Surface

#### `systems/mapgen.js`
```js
export function generateMap(seed, { tags = [], boon = null, traits = {}, species = 'garden_ant' } = {}) → MapGenResult
// MapGenResult = { terrain: number[817], sources: Source[] (uids 1..n), nextUid, rivalSpecs: [{ type, tier, hex }],
//                  rootCols: number[], revealRings: number }
```
Generates all 817 hexes at once (value noise → TERRAIN shares; 1–2 garden-path strips, ×2 with `site_garden_path`; tree-root clusters; puddles ×2 with `site_wet_hollow`; 0–1 log). Rings 0–1 forced passable; every source reachable from hex 0 (carve grass if needed). Fixed sources per `SOURCES.spawn` (+2 seed patches `site_seed_meadow`, +2 aphid colonies `site_aphid_dense`, an aphid colony at ring 2 for `boon_next_to_aphids`, a level-2 aphid colony at ring 2 for `sweet_inheritance`). `crumb_scatter` on a passable ring-1 hex. Sources beyond the current radius are generated with `data.dormant = true`. Rival specs: tier 1 at ring 4–5, tier 2 at ring 6–7 (tiers 2 and 3 with `site_hostile_neighbours`), at most `SPAWN.maxByRadius[8]`. `rootCols` = `colForHex` of every flower patch, leaf plant and aphid colony within ring 3. `revealRings` = 4 (`keen_antennae`), 3 (`boon_scouts_lead`), else 2.

#### `systems/surface.js`
```js
export function derive(s, d) → void
export function tick(s, d, dt, env) → void
export const handlers = { claimHex, cancelChannel, flagHex, buyMound, moveAphids }
export function isPassable(s, d, hex) → boolean               // [q]
export function moveCost(s, d, hex) → number | null           // [q]
export function claimCost(s) → Cost                           // [q] { pheromone: 10 × 1.06^claims × (ach_land_grab 0.9) }
export function canClaim(s, d, hex) → ReasonCode | null       // [q]
export function moundCost(s) → Cost | null                    // [q]
export function sourceAt(s, hex) → Source | null              // [q]
export function nuptialHex(s, d, col) → hex                   // [q] DESIGN §7.11: west if col < 20 else east, distance 1 + floor(|col − 20| / 8), nearest passable
export function spawnSource(s, d, type, hex = -1, opts = {}) → number   // [x] WP5, WP6. Returns the new uid. hex −1 → pick a passable hex in
                                                              //     ring [opts.rMin ?? spawn.rMin, opts.rMax ?? spawn.rMax] (opts.terrain filter allowed) with s as RNG holder;
                                                              //     opts.ttl / opts.data override the defaults; finite stock sized per C34; emits sourceSpawned
export function removeSource(s, d, uid, reason) → void        // [x] WP5, WP6. Deletes trails to it; emits sourceRemoved {uid, reason}
export function revealHexes(s, d, hexes, { insight = true } = {}) → number   // [x] WP6 (lost scout), WP7 (boons)
export function conquerHexes(s, d, hexes) → void              // [x] WP5 conquest: conquered[h] = 1, rev++
export function grantHex(s, d, hex) → void                    // [x] WP5 won tournament: claimed[hex] = 1 (does not raise `claims`), rev++
export function touch(s) → void                               // [x] WP5: rev++ whenever rival land changes (spawn, respawn, boss, creep, regrow, death)
export function addEntrance(s, d, kind, hex, col, ref) → void // [x] WP3 (nuptial), WP5 (outpost), WP7 (satellite)
export function autoMoundStep(s, d, env) → boolean            // [x] WP7 autobuyer
```
- **Derive** (territory rebuilt when `s.run.surface.rev` or the mound level changed; WP5 bumps `rev` through `touch` / `conquerHexes` / `grantHex` whenever rival land changes): rival land = for each alive rival, the disc of `radius` around its hex ∪ `rival.extra`, minus `rival.lost` (WP5 exports `rivals.rivalLand`); owned = auto (radius `1 + floor(mound / 5)` around **every** entrance: main, nuptial, outposts and satellites) ∪ claimed ∪ conquered ∪ trunk (hexes of trails with ≥ 5 hexes when `trunk_trails`), excluding rival land; `border`; `passable` (stone never; puddles in spring; molehill objects); `slots = 3 + research slots + mound milestones (3, 6, 9) + outposts + satellites`; `dNav = 3 + tandem 1 + mass 2 + odometer 3 + 0.25 × long_legs + highway 5`; `slope = 0.35 (0.5 odometer) + 0.05 × barren_ground reward tier`; `frontier`; `claimCost`; `bestSource`.
- **Scouting**: `rate = jobs.scout^0.6 × 2^[antennation] × 2^[keen_antennae] × (ach_cartographer 1.5) × eff` scout-seconds per second (the **whole force**, diminishing; DESIGN §8.3). Target choice: the frontier hex with the lowest `ring / (flagged ? 3 : 1)`, ties by lowest index (a flagged hex therefore jumps ahead of hexes up to 3× closer). Cost `10 × ring^1.2`. On reveal: `revealed = 1`, `rev++`, insight `wallet.grant(insight, 0.5 × ring × stats.insight.scouting)`, emit `hexRevealed {hex}`.
- **Sources**: age; `ttl` expiry (dead insect 6 min, prey 5 min); finite stock sizing per C34; `seed_patch` (`stock.dynamic`) re-evaluates `max = max(300, 300 × d.rates.food.gross)` every tick and clamps `stock ≤ max`; seed regrowth 1 %/s of max; fallen fruit rots at −1 %/s after 4 min; aphid level +1 per 6 min while ≥ 50 % herded (max 3); random spawns (dead insect every 3 min, max 2; prey every 6 min; `boon_rich_prey` dead insect at ring 2 every 2 min for the first 10 min); `lycaenid_caterpillar` 1–2 once `lycaenid_clients` is owned; depleted finite sources → `removeSource` and `run.stats.sourcesDepleted++`. Dormant sources wake when the radius covers them.
- **Radius** = 8, 12 with `sun_compass`, 16 with `regional_expansion`; on growth `rev++` and emit `radiusChanged {radius}`.
- **Claims**: `claimHex {hex}` (needs `hex_claim`; revealed, adjacent to owned land, not rival land): pay if affordable, otherwise start a channel (`channel = {hex, paid: 0, cost}`; each tick move all available pheromone into it; when paid → claim). `cancelChannel` refunds `paid`. `flagHex {hex, on}` (needs `antennation`). `buyMound {}` (needs unlock `mound`; levels ≥ 6 need `mound_building`; soil cost `300 × 1.9^(L−1)`), emits `moundLeveled {level}`. `moveAphids {src, hex}` (`aphid_shepherding`; target an owned flower/leaf hex).
- `tPeak = max(tPeak, d.surface.ownedCount)`; `meta.stats.longestTrail` updated.

#### `systems/trails.js`
```js
export function tick(s, d, dt, env) → void
export const handlers = { drawTrail, rerouteTrail, deleteTrail, assignWorkers, assignEscorts, mark, rally, frenzy, massRecruit }
export function previewTrail(s, d, origin, target, waypoints = []) → { ok, reason, path, len, dEff, perWorker, cap, cEff }   // [q]
export function trailYield(s, d, trail, n) → { out, out2, nEff, cEff, eff, rich, dEff }   // [q] the pure yield formula below
export function bestTargets(s, d, job = 'forager') → [{ src, hex, score }]   // [q] bot/advisor
export function trailOrigins(s, d) → number[]                  // [q] entrance/outpost/satellite hexes (+ trail hexes with trunk_trails)
export function hitTrail(s, d, uid, { workersLost = 0, sLoss = 0, escortsLost = 0 } = {}) → void   // [x] WP5 raids: kills workers via population.killAdults(…, { job: trail.job }), lowers S, reduces trail.escorts (the soldiers themselves are removed by combat)
export function cutTrailsAt(s, d, hexes) → number              // [x] WP6 footstep: delete trails crossing those hexes
export function resetStrength(s, d) → void                     // [x] WP6 rainstorm (skipped by the caller with weather_sense)
export function autoDraw(s, d, count, strengthFrac) → number   // [x] WP7 run start: trails to the best revealed sources at S = frac × S_max
export function createTrail(s, d, originHex, srcUid, { S = 0 } = {}) → number   // [x] WP7 startRun (the crumb trail) and autoDraw: routes with
                                                              //     hexPath over s.run.surface.terrain directly (TERRAIN.move; stone impassable; puddles
                                                              //     impassable in spring per seasons.seasonAt(s.meta, s.meta.season.t, { longSummer:
                                                              //     s.cycle.edict === 'edict_of_long_summer', eternalWinter: s.run.hardship === 'eternal_winter' })), so it is valid
                                                              //     before the next surface.derive; takes a slot, uid from surface.nextUid; returns the uid (0 if no route/slot)
```
Pinned yield formula (DESIGN §8.5, §12.1):
```
rich    = 1 + d.surface.slope × (len − 1)
h       = origin is main/nuptial entrance (or a trunk fork of one) ? d.nest.agg.haulH : 0.5
dEff    = len + h
eff     = 1 / (1 + (dEff − 1) / d.surface.dNav)
cap     = SOURCES[type].cap (aphid_colony: 8 × level)
cEff    = cap × max(1, adultsTotal / 100)^0.8 × (job 'herder' && aphid_shepherding ? 2 : 1)
nEff    = n ≤ cEff ? n : cEff × (1 + ln(n / cEff))
escorted= escorts ≥ ceil(n / 10)       (true when n = 0)
terr    = (d.surface.owned[src.hex] ? 1.25 : 1) × (escorted ? 1 : max(0, 1 − 0.05 × rivalHexesOnPath))
season  = d.season.srcId === 'neutral' ? 1 : SOURCES[type].season[d.season.srcId]   (seed_patch autumn 2.5 with site_seed_meadow)
srcMult = effectMult('source_type', type) × effectMult('source', uid) × (barren_ground hardship run ? 0.5 : 1)
          × (food-yielding forager source ? sp.foodSource ?? 1 : 1) × (leaf_plant ? sp.leafPlant ?? 1 : 1)
          × (picnic_spill && !escorted ? 0.7 : 1)
trunk   = trunk_trails && path.length ≥ 5 ? 1.5 : 1
extra   = effectMult('forage_trail', uid) × (escorted ? 1 : effectMult('forage_unescorted'))
base    = rich × nEff × eff × (1 + S/100) × terr × season × srcMult × trunk × extra
out     = Y[primary] × base × channel(primary);  out2 = Y[secondary] × base × channel(secondary)
channel: food → d.stats.forage.total; honeydew → d.stats.honeydew; leaves → d.stats.leaves; chitin → d.stats.chitin
primary: forager → food; herder → honeydew; leafcutter → leaves
lycaenid: out = escorts ≥ 5 ? 0.3 × ring(src.hex) × d.stats.honeydew : 0 → ledger honeydew.lycaenid (no workers, no rich/eff/S terms)
```
- **Allocation** per job pool (`forager`, `herder`, `leafcutter`; `lycaenid` trails take escorts only and never workers): clamp escorts first (Σ `escorts` ≤ soldiers not in parties or battles; proportional scale-down); clamp explicit `workers` so Σ ≤ `jobs[job]` (proportional scale-down); auto-fill the rest greedily by marginal output in ≤ 50 chunks, unsaturated trails (n < cEff) first. Herders never exceed `8 × level` (×2 with `aphid_shepherding`) per aphid colony. If no forager trail exists, all foragers are `loose`: `ledger.food.loose = loose × LOOSE_FORAGE × stats.forage.total`.
- **Strength**: `S_eq = 100 × n / (n + 15 × len)`; online `S += (S_eq − S) × ln2 / tHalf × dt` (tHalf 45, 90 with `persistent_trails`; rising ×2 with `double_bridge`, ×1.1 with `ach_double_bridge`); `S ≤ S_max` (100, 150 persistent, +5 `ach_highway`). Offline: `S = min(S_eq, S_max)`. `boon_old_trails` is applied at run start by WP7 via `autoDraw`.
- **Output**: `ledger.food.trails += out` etc.; finite stocks drop by the food-equivalent output × `dt × eff` (ledger rates are pre-efficiency, so multiply here); when a stock reaches 0, `surface.removeSource`.
- `drawTrail {origin, target, waypoints?}`: origin in `trailOrigins`; target hex holds a source revealed and active; a free slot (`'noSlot:trail'`); route via `core/hex.hexPath` with `surface.moveCost` (and `double_bridge` ×0.9 on len). `job` from the source (`SOURCES.job`). `rerouteTrail {uid, waypoints}` is free; push `reroutes`. `deleteTrail {uid}`. `assignWorkers {uid, n}` (explicit count). `assignEscorts {uid, n}` (≤ garrison soldiers + current escorts).
- Abilities via `wallet.spend` and `s.run.surface.cd`: `mark {uid}` S += 25 (cap S_max); `rally {uid}` effect `{id: 'rally:'+uid, stat: 'forage_trail', scope: uid, mult: 2, t: 30 (60 mass_recruitment)}`; `frenzy {}` effect `{id: 'frenzy', stat: 'forage', mult: 2, t: 20}`; `massRecruit {src}` (only while a termite swarm or picnic source exists and a trail to it exists): moves 50 % of (idle minors + loose foragers) into explicit workers on that trail. `hive_mind`: when pheromone is at cap, auto-Mark the trail with the lowest S/S_max (respecting the cooldown). Emit `abilityUsed {id, uid}`.

### 8.4 WP5 War and research

#### `systems/combat.js`
```js
export function unitStats(s, d, caste, ctx = {}) → { atk, hp }   // [q] base × d.stats.atk/hp × (soldier: sp.soldierAtk ?? 1) × effectMult('atk_player')
                                                                  //     × (ctx.rally ? 1.3 : 1); hp × (ctx.venom ? 0.8 : 1) × (ctx.gate ? 1 + 0.25 × gateL × (ach_phragmosis 1.05) : 1)
export function armyAP(s, d, army, ctx = {}) → number            // [q] army { militia, soldier, supermajor }:
                                                                  //     scChain(Σ n × √(atk × hp), SOFTCAPS.ap) × d.stats.ap × (ctx.homeMult ?? 1) × (ctx.apMult ?? 1)
export function rivalAP(s, d, rival, ctx = {}) → number          // [q] n × √(atk × hp) × effectMult('ap_rival') × effectMult('ap_rival', uid) × swarm × (ctx.defending ? home : 1)
export function preview(s, d, you, foe, opts = {}) → { win, lossesLo, lossesHi, survivors, loot }   // [q] closed form (DESIGN §9.5), 64×64 fortune grid; never touches s.rng
export function startBattle(s, d, spec, env) → number            // [x] WP5 internal + rivals.startEventBattle. Rolls fortunes from s.rng; emits battleStart
export function stepBattles(s, d, dt, env) → void                // called by rivals.tick: 4 Hz accumulator; end → battleEnd
export function grantReward(s, d, reward, env) → void            // [x] RewardSpec → wallet grants / addAdults
// BattleSpec  = { kind, hex, below = false, you: { militia, soldier, supermajor }, foe: { n, atk, hp }, homeMult = 1, party = 0, raid = 0, reward = null, tag = '' }
// RewardSpec  = { foodSec?, foodMin?, food?, chitin?, chitinSec?, chitinMin?, insight?, minors? }
```
Stepped simulation per DESIGN §9.5: every 0.25 s each side deals `Σ n × ATK × 0.2 × 0.25` (counts at step start), applied to the enemy groups in order militia → soldiers → supermajors; fractional counts. Units in a battle are **committed** (excluded from `d.combat.garrison`); colony totals change only at battle end (`population.killAdults` for losses, cause `'battle'`). Auto-retreat when your losses ≥ `retreatAt` (costs 30 % of survivors, 10 % with `phalanx`); AI never retreats. `field_triage`: 30 % of fallen soldiers/supermajors return after 60 s if ≥ 5 nurses (queued in `war.triage`). `battleEnd {uid, kind, tag, win, lost: {soldier, supermajor, militia}, kills, odds, start: {you, foe}}` (`start` = total units per side at battle start; used for `ach_square_law`, `ach_flawless`, `ach_david_and_goliath`); counters, `meta.stats.largestBattle`, `run.stats`.

#### `systems/rivals.js`
```js
export function tick(s, d, dt, env) → void
export const handlers = { launchParty, recallParty, reinforce, battleAction, bribe, tournament, tournamentChoice }
export function spawnInitial(s, d, specs) → void                 // [x] WP7 startRun
export function createRival(s, spec) → Rival                     // [x] spec { type, tier, hex }
export function rivalLand(s, rival) → number[]                   // [q] WP4 surface.derive
export function previewAction(s, d, kind, targetUid, army) → Preview   // [q] kind 'raid'|'assault'|'hunt'|'termite'|'tournament'
// army = { soldier, supermajor, minor? } (minor only for tournaments)
// Preview = { ok, reason: ReasonCode|null, win: 0..1, youAP, foeAP, lossesLo, lossesHi, survivors: { soldier, supermajor },
//             loot: { food, chitin, insight, minors }, marchSec, raise: [ { key: 'soldiers'|'supermajors'|'research'|'rally'|'mating_flight', text } ] }
// raise = the "what would raise it" hints (DESIGN §25.6 rule 8); tournament previews fill win from the display ratio.
export function garrison(s, d) → { soldier, supermajor }         // [q]
export function startEventBattle(s, d, spec, env) → number       // [x] WP6 army ant column (spec as BattleSpec)
```
- **Tick**: rival growth `n += base × (summer 0.03 : 0.01) / 60 × dt`, ≤ 3 × base, never in winter or offline; fire-ant creep every 180 s (not winter/offline) adds an unowned adjacent hex to `extra` and calls `surface.touch(s)`; respawn queue (10–20 min after a conquest, outermost band, tier = `topTier + 1`, ladder then elder tiers); extra rivals when the radius grows (up to `SPAWN.maxByRadius`); every rival spawn, death or land change calls `surface.touch(s)`; bosses (each **at most once per run**, spawned at run start if the condition already holds, otherwise the first tick it holds; never respawned in the same run once conquered): Old Ridge (`budding` and `alatesCycle ≥ 2500`) at the outer ring with total AP `1e6 × (1 + m)^1.5`, assault-immune until `d.surface.ownedCount ≥ 25`; the Argentine Front (3 nests sharing `group`, each with ⅓ of `1e8 × 10^s`) once `megacolony` is owned (m = `meta.counters.supercolonies`, s = `meta.counters.speciations`; soldier counts per C28); `sighted = revealed[hex]` (emit `rivalSighted {uid, type}` once); parties march 1 hex / 2 s along `hexPath`; `combat.stepBattles`; conquest; great-rival 10-minute window (fallen nests regrow otherwise); triage returns; truce/cooldown timers (paused offline); fill `d.combat`; last, conquered non-boss rivals are compacted to minimal records, at most `FALLEN_RIVALS.keep` kept (C77).
- `launchParty {kind, target, soldier, supermajor}` (needs unlock `panel_war`; `pacifist` forbids; units ≤ garrison). On arrival: raid (40 % of defenders, no home bonus), assault (100 %, home ×1.25 or ×1.5 carpenter, supermajor share and `siege_tactics` reduce the bonus per DESIGN §9.4, `acid_volley` ×0.9 unless `formic_acid`, `propaganda_pheromones` enemy ×0.9), hunt (prey AP 50·r / 200·r / 800·r with r = the prey hex's ring; reward `foodSec 60` of food + `15 × r × chitinMult` chitin, both × `SOURCES[type].season[d.season.srcId]` (1 when `'neutral'`); the prey source is removed), termite (AP 28,300; `source.cd = 300`). Before a battle starts, `odds` = `combat.preview(...).win` is stored on it.
- **Conquest**: `surface.conquerHexes(rivalLand)`, `surface.addEntrance('outpost', hex, -1, uid)`, `surface.spawnSource('harvester_stash', <a conquered hex>)`, rewards (insight `25 × tier × oneShot`, food `120 s × √tier`, chitin `0.5 × tier × kills`, captured `5 × tier²` minors via `addAdults(capped)`, ×1.5 with `site_hostile_neighbours` or `edict_of_war`; slave-makers also return `3 × stolen`), `topTier`, counters, emit `conquest {uid, type, tier}`.
- `battleAction {battle, action}`: `'alarm_rally'` (25 pheromone, ×0.8 with `ach_flawless`; 30 s cd; +30 % ATK for 8 s), `'mobilize'` (40 pheromone; border/nest fights only; 25 % of idle + 25 % of forager minors join as militia for 20 s via `colony.militia`; the draft is recorded in `b.mob` and the surviving foragers return to foraging when the window or the battle ends, `combat.releaseMobilized`, C73), `'retreat'`. `reinforce {battle, soldier, supermajor}`. `bribe {rival}` (2 × rival AP honeydew; truce 300 s; cd 600 s). `tournament {rival, hex, minor, soldier, supermajor}` and `tournamentChoice {uid, choice}` (STRETCH; DESIGN §9.7; a won hex → `surface.grantHex(s, d, hex)` and pushed to `rival.lost`).

#### `systems/raids.js`
```js
export function tick(s, d, dt, env) → void
export const handlers = { dispatchGuard }                        // { raid }
```
DESIGN §9.10, pinned: eligibility (rival sighted or `run.time ≥ 900`; adults ≥ 50; not winter; online; no truce; no `no_raids` effect). Each eligible rival's `raidIn` counts down; at 0 roll the next as `expSample(raidMin × 60 / seasonFactor / aggression / (sp.raidMult ?? 1))`, aggression = `1 − 0.08 × pacifist reward tier`. A raid takes `30 %` (40 % slave-makers) of `rival.n` (removed from the rival; survivors return). Target: nest if tier ≥ 4, slave-makers, or a 25 % roll; else the trail with the most workers passing within 2 hexes of its land, excluding trails that lie entirely inside owned land (`d.surface.trails[].safe`, DESIGN §8.6) (×2 chance weight for trails through border hexes); else the nest. Warning `min(60, 15 + 3 × scouts) + 30·[early_warning]` s → `run.stats.raidsIncoming++`, emit `raidWarning {uid, rival, target, warn}`. Auto-guard (`meta.automation.autoGuard` and `early_warning`) dispatches the garrison. Trail fight: escorts (×1.5 AP with `phalanx`) + dispatched garrison (instant if `agg.barracksNear`, else 2 s/hex); loss or no defence → `trails.hitTrail` (`min(n, 2 × raiders)` foragers, S −30) and lose 30 s of that trail's income (`wallet.spend` capped at stored food). Nest: border fight on hex 0 (garrison, `homeMult`) → gate fight (`below: true`; remaining garrison + mobilized militia; gate HP bonus) → theft `food × max(0.02, 0.10 × agg.reachStorageShare (or 0.03 if 0) × (1 − 0.1 × gateL))` and `killBrood(0.2 × reachShare)` (slave-makers: `stealBrood`, added to `rival.stolen`). Emit `raidResult {uid, win, foodLost, broodLost, workersLost}`.

#### `systems/research.js`
```js
export const handlers = { buyResearch, buyRefinement }           // { id } / { branch }
export function isAvailable(s, id) → boolean                     // [q] prerequisites owned and not owned
export function isOwned(s, id) → boolean                         // [q]
export function cost(s, id) → Cost                               // [q] { insight }
export function refinementCost(s, branch) → Cost | null          // [q] 10,000 × 2.5^L; null until the branch is complete
export function branchComplete(s, branch) → boolean              // [q]
export function grantInnate(s) → number                          // [x] WP7 startRun: run.research[id] = 1 for era.innate ids and species `innate`
```
Emits `researchBought {id}` / `refinementBought {branch, level}`.

### 8.5 WP6 World

#### `systems/seasons.js`
```js
export function tick(s, d, dt, env) → void      // advances meta.season.t by dt; fills d.season; emits seasonChanged {id, year}, winterSoon (60 s before winter)
export function skipTime(s, sec) → void         // [x] core/offline.js: advance the clock only (year wraps)
export function setSeason(s, id) → void         // [x] WP7 landing (seasonal_wisdom): jump t to the start of that season in the current year
export function addExtraSpring(s, sec) → void   // [x] WP7 startRun (boon_long_spring): meta.season.extraSpring += sec
export function seasonAt(meta, t, { longSummer = false, eternalWinter = false } = {}) → { id, index, tIn }   // [q] pure; uses meta.season.lengthSec
export const handlers = { setChronobiology }    // { lengthSec, start } — needs genome chronobiology; 180..720; start is stored as
                                                //   meta.season.start and applied by startRun at the next run start, never to the running clock (C84)
```
Order `SEASON_ORDER` (or `LONG_SUMMER_ORDER` under `edict_of_long_summer`); each season `lengthSec` long; while `extraSpring > 0` and it is spring, `t` does not advance (`extraSpring −= dt`); `eternal_winter` hardship runs → always winter and never mild. `mild = year === 0 && !eternal_winter`. `d.season.srcId = id`, except during the autumn of `edict_of_long_summer` ("autumn bonuses off"): `srcId = 'neutral'` and `mods.foodCap = 1`. Frost: elapsed winter time e → `frostRow = e < 90 ? F × e/90 : (len − e < 60 ? F × (len − e)/60 : F)`, `F = max(4, (mild ? 10 : 18) − 5·[thermoregulation] − min(6, floor(mound / 3)))`; `snapRow = effectAdd('frost_snap')`. `forecast.weather` = the `id` of the first `s.run.events.active` entry whose `data.forecast` is true (events.js creates such an entry 30 s before a weather event when `weather_sense` is owned; the forecast strip is shown only with `seasonal_clock`).

#### `systems/events.js`
```js
export function tick(s, d, dt, env) → void
export const handlers = { eventChoice, clickEventObject, scrapeMold, bailFlood, cleanBlight }
export function forceEvent(s, d, id, env) → boolean   // [x] tests and golden.js (Saved Finds); not the pacing bot
export function eligible(s, d, id) → boolean          // [q]
```
- **Scheduler** (online only; `nextIn` does not count down offline): first run (`run.index === 0`): no roll before run.time 360; the scripted `ev_fallen_fruit` fires at run.time 480 (sets `scripted`; this is what sets unlock `events`). Then `nextIn = expSample(240)`, capped at `EVENT_GAP.firstRunMaxSec` (150 s) in run 1 (C75). At the start of each online tick, mold spots whose chamber was demolished are removed and spots on a relocated chamber move with it (C74). Pity: the first 3 events of the game are `'pos'` (`meta.counters.events < 3`); ≤ 1 `'neg'` in any 3 consecutive (`recent`); no `'neg'` during a raid warning or within 60 s of `lastNegAt`. Weighted pick among eligible events (season filter, `minRunSec`, `minAdults`, `cond`). Disease events: weight × (1 − `agg` midden reduction `min(0.8, 0.1 × middenL)`), never with `metapleural_glands`; `ev_fungal_blight` × 0.25 with `weeder_ants`. Weather events (`ev_rainstorm`, `ev_drought`) with `weather_sense` get a 30 s warning (an active entry with `data.forecast`).
- **Cards**: choice events open `card` (30 s); timeout → the `def` choice. **Objects** (`objects[].kind`): `fruit`, `ladybug`, `footstep`, `molehill`, `antlion`, `lizard`, `termite_swarm`, `golden_aphid`, `rival_alate`, `mold`, `army_column`, `phengaris`, `myrmecophile`, `wandering_queen`.
- Effects of each event per DESIGN §18.2, implemented with `core/effects.js` and these cross-calls: `surface.spawnSource` (fruit, picnic, termite swarm), `surface.revealHexes` (lost scout), `trails.cutTrailsAt` (footstep), `trails.resetStrength` (rain, unless `weather_sense`), `population.killAdults` / `killBrood` (cordyceps, antlion, lizard, myrmecophile, phengaris), `rivals.startEventBattle` (army ants, AP `43,000 × (1 + m)^1.5`), `nest.moleTunnel` (mole tunnel), `combat.armyAP` (threshold checks: ladybug, lizard, antlion), `wallet.grant` / `incomeSeconds`. **Soldier remedies** (C36): the ladybug, antlion and horned-lizard events open a card; `eventChoice 'send'` (ladybug: ≥ 5 garrison soldiers, or the escort AP on that aphid colony's trail ≥ 50 × ring; antlion: ≥ 3 garrison soldiers) or `'mob'` (lizard: garrison `combat.armyAP` ≥ 200 × ring) is validated against `d.combat.garrison` (`'requirements'` otherwise) and ends the threat at once with no losses (the lizard also grants 60 s of food). Ladybugs can still be clicked away (10 clicks) as the alternative. `drainage`: no flood and drought penalties halved; a Water Well grants drought immunity; fire-ant `rafts`: rain → `forage ×1.25` 60 s, no flood.
- `scrapeMold {uid}` (click), `bailFlood {}` (click: flood effect t −5 s), `cleanBlight {}` (click; 20 clicks within 15 s clears it), `clickEventObject {uid}` (click; ladybug, footstep, rival alate, golden aphid). Counters (`moldScraped`, `ladybugs`, `rainstorms`, `moleTunnels`, `events`), `run.stats.eventsSeen`. Emit `eventSpawned {uid, id}`, `eventResolved {uid, id, choice}`.

#### `systems/golden.js`
```js
export function tick(s, d, dt, env) → void
export const handlers = { clickBeetle, clickPupa, openGift }   // {} / { choice: 'frenzy'|'windfall' } / { index }
export function spawnBeetle(s, d, hex = -1) → void              // [x] WP3 amber bead
```
Beetles only online and while unlock `golden_beetle`: `beetleIn` counts down (U(300, 600) after each); random revealed passable hex; lifetime 13 s (20 `ach_beetle_collector`, +5 `ach_picnic_crasher`). Roll per `GOLDEN.rolls`: windfall `wallet.grant(food, incomeSeconds(food, 600), {overflow: true})`, frenzy effect `forage ×5` 60 s, lay burst `lay ×3` 30 s, discovery insight `60 s + 20 × oneShot`. Pupae: scan `env.events` for `eggLaid` (online), `GOLDEN.pupaChance` (0.2 %) per egg, ≤ 1 per 180 s, in a random nursery; 15 s; `clickPupa` choice frenzy or windfall. Gifts: when `meta.savedFinds > 0` and online, convert each into `golden.gifts` on random revealed hexes; `openGift` → `events.forceEvent` from `SAVED_FINDS.pool` (or `spawnBeetle`). Emits `beetleSpawned`, `beetleClaimed {roll}`, `pupaSpawned`, `giftOpened`. All three handlers are clicks (`consumeClick`) and are refused with `'hardship'` under `claustral_founding` (C32).

#### `systems/achievements.js`, `systems/fieldguide.js`
```js
// achievements.js
export function tick(s, d, dt, env) → void      // checks once per sim second + immediately on relevant env.events; grant: meta.achievements[id] = simTime,
                                                // cosmetics owned, emit achievement {id}
export function progress(s, d, id) → { cur, target } | null   // [q]
export function nextGoals(s, d, n = 3) → [{ id, cur, target }] // [q] also written to d.progress.goals
// fieldguide.js
export function tick(s, d, dt, env) → void      // triggers from state + env.events; unlock: meta.fieldGuide[id] = simTime,
                                                // wallet.grant(insight, max(10, incomeSeconds(insight, 30))), emit fieldGuide {id}
```
Duration conditions (hoarder 10 min at cap, highway 5 min at S_max, mutualist 5 min) use timers in `d.progress._timers` (not saved; restart after reload). Conditions read state, counters and this tick's events only.

#### `systems/unlocks.js`
```js
export function tick(s, d, dt, env) → void      // evaluate UNLOCKS (every tick is fine); set run.unlocked[key]; reveal queue; d.progress.nextUnlock
export function evalCond(s, d, cond) → boolean  // [q] §11
export function isUnlocked(s, key) → boolean    // [q] !!s.run.unlocked[key]
export function isRevealed(s, key) → boolean    // [q] UI: unlocked && (meta.seen[key] || def.queued === false)
export function onRunStart(s, d) → void         // [x] WP7: set run.unlocked[key] for every persist:true key already in meta.seen
```
When a condition first holds: `run.unlocked[key] = true` immediately (gameplay is never delayed); if `queued`, insert the key into `meta.reveal.queue` in schedule (UNLOCKS) order (C63); pop one key when `simTime − meta.reveal.lastAt ≥ 30`, set `meta.seen[key]`, `lastAt`, emit `unlock {key}`. Non-queued keys (purchase-triggered) are marked seen and emitted at once and also set `lastAt`.

### 8.6 WP7 Meta

#### `systems/prestige.js`
```js
export function derive(s, d) → void              // d.meta
export function tick(s, d, dt, env) → void       // projections, alates/min peak, requirement flags, ending
export const handlers = { fly, chooseLanding, supercolony, speciate, setHeirlooms, placeSatellite }
export function newGame(s, d) → void             // [x] core/game.js: startRun for the very first run (seed = deriveSeed(s))
export function startRun(s, d, { seed, tags = [], boon = null, hardship = null, startSeason = null, carryAdults = 0, env = null }) → void   // [x] WP7 internal
//   emits runStarted only when opts.env is given (newGame passes none: core/game.js publishes 'reset'); resets the run-scoped d subtrees (C53)
export function doFlight(s, d, env, { hardship = null } = {}) → number   // [x] WP7 internal (fly handler, hardships.startHardship, automation auto-flight):
                                                                          //     the fly flow below; returns alates awarded
export function doSupercolony(s, d, env, { edict }) → number            // [x] WP7 internal (supercolony handler, automation auto-supercolony)
export function projectAlates(s, d) → number     // [q]
export function projectKinship(s, d) → number    // [q]
export function projectGenes(s, d) → number      // [q]
export function landingPreview(seed, tags) → MapGenResult   // [q] pure (mini-maps)
```
**`d.meta` composition (pinned).** `sigAll = (sig_generalist ? 1.1 : 1) × (ach_wilsons_pride ? 1.03 : 1)`; `ach = achMult = 1.01^achCount` (1.02 with `fossil_record`); `K = era.kinshipLife`, `G = meta.genesLife`; `Λ = a ≤ 100 ? 1 + 0.05a : 6 × √(a/100)` with `a = cycle.alatesCycle` (DESIGN §13.3; Λ(30) 2.5, Λ(100) 6, Λ(1,000) 18.97, Λ(1e5) 189.7); `mono = 1.3^tier(monomorphic)`.
- `food = Λ × 1.4^hardy_workers × (1+K)^1.25 × (1+G)^1.5 × ach × mono × sigAll`
- `dig = 1.4^deep_diggers × (1+K)^0.5 × (1+G)^0.25 × ach × mono × sigAll`
- `insight = 1.5^swarm_instinct × 10^ancient_instinct × (1+K)^0.5 × (1+G)^0.25 × ach × sigAll` (= DESIGN M_insight)
- `honeydew = 1.4^hardy_workers × 2^[sweet_inheritance] × (1+K)^0.5 × (1+G)^0.25 × ach × mono × sigAll`
- `leaves = 1.4^hardy_workers × (1+K)^0.5 × (1+G)^0.25 × ach × mono × sigAll`
- `fungus = (1+K)^0.5 × (1+G)^0.25 × ach × sigAll × (sig_fungal_farmers 2)`; `chitin = (1+K)^0.5 × (1+G)^0.25 × ach × sigAll`
- `lay = Λ^0.25 × 1.25^fertile_queen × 2^haplodiploid_fecundity × 1.3^tier(claustral_founding) × (sig_polygyne 1.5)`; `ap = 1 + G`
- `alates = (1+K)^0.25 × 1.15^wide_wings × (ach_swift_swarm 1.1) × (ach_gentle_giants 1.05) × (ach_flying_ant_day 1.05)`
- `colonyScale = 1.2^vast_galleries × (1+K)^0.2 × 2^megacolony_galleries × 10^colossal_nests × 2^unicolonial_sprawl`
- `census = adultsTotal × (1 + 0.25 × satellites)`; `hardship[id] = hardships.effectiveTier(s, id)`; `sp = SPECIES[era.species].mods`; `edict = cycle.edict`.
- **Projections**: `alates = floor(scChain(10 × √(fRun/1e8) × (1 + tPeak/400) × (1 + 0.02 × min(reared, 25|50)) × W × prestige.alates × (1 + 0.05 × deepVaultL), SOFTCAPS.alates))` (softcap 3e4, p 0.5), `reared = colony.alatesReared`, W = max(season flightW, effect `flight_w`); `fly` requirements: `agg.royalL ≥ 5`, `nuptial_preparation`, `agg.nuptial.active`, `fRun ≥ 1e8`. `kinship = floor(sc(2 × (alatesCycle/1000)^0.35))` with requirements `budding`, `alatesCycle ≥ 5000`, Old Ridge conquered this run. `genes = floor(sc(3 × √(kinshipLife/100)))` with `megacolony`, all 3 Front nests conquered this run, `kinshipLife ≥ 200`. `perMin = alates / (run.time / 60)`; `run.prestige.peakRate/peakAt` track the peak (glow when below 97 %).

**Flows.**
- `fly {}` (`requirements` unless `proj.fly.ok`): award alates (`cycle.alates`, `cycle.alatesCycle`, `meta.counters.alatesLife`, `flights`); **run-end bookkeeping** (shared by `fly`, `startHardship`, `supercolony` and `speciate`, always done before any subtree is reset): for every id in `run.research` not innate, `era.researchRuns[id]++`, innate at ≥ 3 (2 with `ancestral_memory`); strata record (`kind 'run'`); daughter colony; flight stats; brood bank count `min(1000, 0.1 × adults)` if `brood_bank`; build `meta.pending = { kind: 'landing', options: 3 × { seed: deriveSeed(s), tags: 1–2 random SITES }, boons: 3 random BOONS, chooseSeason: seasonal_wisdom, alates, hardship: <id from startHardship> | null }`; `s.run = createRun(0)` (frozen while pending); emit `flightComplete {alates}`.
- `chooseLanding {index, boon, season?}` → `startRun(...)` with the chosen seed/tags/boon (+ hardship stored in pending), `setSeason` if allowed, `meta.pending = null`.
- `startRun`: `s.run = createRun(seed)`; `mapgen.generateMap` → terrain/sources/nextUid, reveal rings; `surface.trails = []` then the starting crumb trail via `trails.createTrail(s, d, 0, <crumb uid>)` (it occupies 1 of the 3 base slots, DESIGN §8.5); `nestgen.generateNest` (rootCols, tags, `sp.royalStart`); `rivals.spawnInitial`; `research.grantInnate`; `unlocks.onRunStart`; Founding Stores written directly into `run.res.food` / `run.res.soil` (may exceed the cap; not added to `fRun`); carried adults (`population.addAdults`); `naniticsLeft = 25` with `nanitic_vigor`; with `automaton_instincts` or `automated_brood`, copy `meta.automation.keep.jobTargets` (if set) into `run.colony.jobTargets` and set `autoJobs`/`thresholdJobs`; with `automated_brood`, copy `keep.casteTargets` into `run.colony.casteTargets` (C39); boons (chitin `50 × (1+K)^0.5`, insight `100 × oneShot`, royal vigor effect, peaceful-start `no_raids` effect, long spring `seasons.addExtraSpring(s, 180)`, old trails / remembered paths via `trails.autoDraw`); `nest.applyBlueprint`; `meta.counters.runs++`, `run.index`; emit `runStarted {index}`.
- `supercolony {edict}` (`requirements`): run-end bookkeeping (above); kinship award (`era.kinship`, `kinshipLife`, `counters.kinshipEver`, `supercolonies`); signature gene for the current species (first time); `s.cycle = createCycle()` keeping heirloom traits at their levels; `cycle.edict = edict`; strata `'cycle'`; `startRun` with a fresh seed, no boon; emit `supercolonyComplete {kinship}`.
- `speciate {species}` (`requirements`, species unlocked): run-end bookkeeping (above); genes award; `s.era = createEra()` with `species`, carrying `innate`/`researchRuns` if `genetic_memory`; `eusocial_leap` → `federation.automated_brood/blueprint_memory/autobuyers = 1`; `s.cycle = createCycle()`; strata `'era'`; `startRun`; emit `speciationComplete {genes}`.
- `setHeirlooms {ids}` (≤ 3 owned trait ids; needs `heirloom_bloodline`). `placeSatellite {hex, col}` (federation `satellite_nest` level > current satellites; owned hex ≥ 3 from other entrances; column ≥ 4 from other shafts): `surface.addEntrance('satellite', hex, col, index)` (functional at once) and `nest.queueShaft(col, 'satellite', index)` (the shaft is dug visibly).
- **Ending**: when `census ≥ 2e16` the first time, emit `ending` and set `meta.flags.endingSeen` after the UI acknowledges (via `uiFlag`).

#### `systems/traits.js`, `systems/hardships.js`, `systems/automation.js`
```js
// traits.js
export const handlers = { buyTrait, buyFederation, buyGenome }   // { id }
export function traitCost(s, id) → Cost | null     // [q] { alates: base × growth^L }, null at max
export function fedCost(s, id) → Cost | null       // [q] { kinship }
export function genomeCost(s, id) → Cost | null    // [q] { genes }; species_* also sets meta.speciesUnlocked
// hardships.js
export function tick(s, d, dt, env) → void         // if run.hardship: tier t reached when fRun ≥ 1e9 × 100^(t−1) (1e9, 1e11, 1e13, 1e15, 1e17) → cycle.hardshipTier, era.hardshipBest; emit hardshipTier {id, tier}
export const handlers = { startHardship }          // { id } — needs unlock tab_hardships AND the flight requirements; behaves like fly with pending.hardship = id
                                                   // (the fly flow is exported inside WP7 as prestige.doFlight(s, d, env, { hardship }) — package-internal)
export function goal(t) → number                   // [q]
export function effectiveTier(s, id) → number      // [q] max(cycle.hardshipTier[id] || 0, 0.5 × (era.hardshipBest[id] || 0))
// automation.js
export function tick(s, d, dt, env) → void         // 1 Hz: autobuyers in autobuy.priority order, one purchase per pass (adaptations.autobuyStep, nest.autoLevelStep, surface.autoMoundStep) when federation autobuyers
                                                   // (adaptations also with automaton_instincts); auto-flight (federation auto_flight; online, or on the first online
                                                   // tick after return) → prestige.doFlight + chooseLanding(option 0, first boon); auto-supercolony
                                                   // (deep_time_automation) → prestige.doSupercolony with the cycle's current edict
export const handlers = { setAutomation, spendDiapause }   // { patch } deep-merged into meta.automation / { on }
```
Constraints of an active hardship run, enforced by the consumer: `claustral_founding` → WP2 (no `clickForage`, `groomBrood`, no `royal_feeding`), WP3 (no `helpDig`), WP6 (no `clickBeetle`, `clickPupa`, `openGift`, rival-alate / golden-aphid `clickEventObject`; C32), `pacifist` → WP2 caste targets, WP5 parties; `barren_ground` → WP4 yields; `shallow_soil` → WP3 rows; `monomorphic` → WP2 castes and adaptation cap; `eternal_winter` → WP6 seasons.

---

## 9. Command catalogue

Every command is `{ type, ...args }`. "Click" = the handler calls `consumeClick(s)` and is refused with `clickCap` beyond 15/s. UI code calls `game.actions.<type>(args)`.

| type | args | Owner (module) | Notes |
|---|---|---|---|
| `setSetting` | `{ key, value }` | WP1 commands.js | keys of `meta.settings` only; values validated per key |
| `uiFlag` | `{ key, value }` | WP1 commands.js | writes `meta.onboarding.done[key]`; key `'ending'` sets `meta.flags.endingSeen` |
| `equipCosmetic` | `{ slot, id }` | WP1 commands.js | id must be in `meta.cosmetics.owned` (or null) |
| `clickForage` | `{ src }` | WP2 economy | click; hand-forage a source |
| `setCasteTargets` | `{ soldier, supermajor, replete }` | WP2 population | fractions, sum ≤ 0.9 |
| `setEggReserve` | `{ frac }` | WP2 population | 0..0.9 |
| `setFungalBrood` | `{ on }` | WP2 population | needs `fungiculture` |
| `rearAlate` | `{ n }` | WP2 population | needs `alate_rearing` + active Nuptial Chamber |
| `groomBrood` | `{ chamber }` | WP2 population | click; a nursery uid |
| `clickQueen` | `{}` | WP2 population | click |
| `retireAdults` | `{ caste, n }` | WP2 population | `'soldier'` or `'supermajor'` from the garrison → minors (needs free housing) |
| `shiftJob` | `{ from, to, n }` | WP2 jobs | job ids or `'idle'` |
| `setJobs` | `{ jobs }` | WP2 jobs | absolute counts |
| `setJobTargets` | `{ targets }` | WP2 jobs | needs `job_presets` |
| `setAutoJobs` / `setThresholdJobs` | `{ on }` | WP2 jobs | needs `age_polyethism` / `response_thresholds` (or innate) |
| `saveJobPreset` / `applyJobPreset` | `{ slot, name? }` | WP2 jobs | needs `hive_mind` |
| `buyAdaptation` | `{ id, n = 1 }` | WP2 adaptations | |
| `placeChamber` | `{ chamber, x, y, route?, shaftCol? }` | WP3 nest | `shaftCol` for `nuptial_chamber` |
| `levelChamber` | `{ uid, dir? }` | WP3 nest | dir `'left'`, `'right'`, `'up'`, `'down'` |
| `relocateChamber` | `{ uid, x, y, route? }` | WP3 nest | |
| `demolishChamber` | `{ uid }` | WP3 nest | |
| `digTunnel` | `{ cells }` | WP3 nest | contiguous path |
| `digTo` | `{ cell }` | WP3 nest | auto-route (cache hints) |
| `backfill` | `{ cells }` | WP3 nest | |
| `reorderQueue` | `{ uid, to }` | WP3 nest | |
| `cancelJob` | `{ uid }` | WP3 nest | |
| `helpDig` | `{}` | WP3 nest | click |
| `saveBlueprint` / `loadBlueprint` / `deleteBlueprint` | `{ slot, name? }` | WP3 nest | needs `ancestral_blueprint` |
| `claimHex` / `cancelChannel` | `{ hex }` / `{}` | WP4 surface | |
| `flagHex` | `{ hex, on }` | WP4 surface | needs `antennation` |
| `buyMound` | `{}` | WP4 surface | |
| `moveAphids` | `{ src, hex }` | WP4 surface | needs `aphid_shepherding` |
| `drawTrail` | `{ origin, target, waypoints? }` | WP4 trails | |
| `rerouteTrail` | `{ uid, waypoints }` | WP4 trails | free |
| `deleteTrail` | `{ uid }` | WP4 trails | |
| `assignWorkers` | `{ uid, n }` | WP4 trails | explicit worker count |
| `assignEscorts` | `{ uid, n }` | WP4 trails | soldiers from the garrison |
| `mark` / `rally` | `{ uid }` | WP4 trails | |
| `frenzy` | `{}` | WP4 trails | |
| `massRecruit` | `{ src }` | WP4 trails | |
| `launchParty` | `{ kind, target, soldier, supermajor }` | WP5 rivals | kind `'raid'`, `'assault'`, `'hunt'`, `'termite'` |
| `recallParty` | `{ uid }` | WP5 rivals | |
| `reinforce` | `{ battle, soldier, supermajor }` | WP5 rivals | |
| `battleAction` | `{ battle, action }` | WP5 rivals | `'alarm_rally'`, `'mobilize'`, `'retreat'` |
| `bribe` | `{ rival }` | WP5 rivals | |
| `tournament` / `tournamentChoice` | `{ rival, hex, minor, soldier, supermajor }` / `{ uid, choice }` | WP5 rivals | STRETCH |
| `dispatchGuard` | `{ raid }` | WP5 raids | |
| `buyResearch` / `buyRefinement` | `{ id }` / `{ branch }` | WP5 research | |
| `setChronobiology` | `{ lengthSec, start }` | WP6 seasons | |
| `eventChoice` | `{ uid, choice }` | WP6 events | |
| `clickEventObject` | `{ uid }` | WP6 events | click |
| `scrapeMold` | `{ uid }` | WP6 events | click |
| `bailFlood` / `cleanBlight` | `{}` | WP6 events | click |
| `clickBeetle` | `{}` | WP6 golden | click |
| `clickPupa` | `{ choice }` | WP6 golden | click; `'frenzy'` or `'windfall'` |
| `openGift` | `{ index }` | WP6 golden | click |
| `fly` | `{}` | WP7 prestige | prestige (save first) |
| `chooseLanding` | `{ index, boon, season? }` | WP7 prestige | allowed while paused |
| `supercolony` | `{ edict }` | WP7 prestige | prestige |
| `speciate` | `{ species }` | WP7 prestige | prestige |
| `setHeirlooms` | `{ ids }` | WP7 prestige | |
| `placeSatellite` | `{ hex, col }` | WP7 prestige | |
| `buyTrait` / `buyFederation` / `buyGenome` | `{ id }` | WP7 traits | |
| `startHardship` | `{ id }` | WP7 hardships | prestige |
| `setAutomation` | `{ patch }` | WP7 automation | |
| `spendDiapause` | `{ on }` | WP7 automation | STRETCH |

---

## 10. Event catalogue (`env.emit` → `bus`)

Payloads are flat on the event object (`{ type, ...payload }`). UI text for each type lives in `ui/text.js`. **Consumers** are informative; anyone may subscribe. A payload key may never be named `type` (`env.emit` re-asserts the event type), so the sub-type of a chamber, source or rival travels as `chamberType` / `sourceType` / `rivalType` (renamed at integration; v1.0 had `type`).

| type | payload | Emitter | Typical consumers |
|---|---|---|---|
| `commandRejected` | `cmd, reason` | WP1 | UI (shake button, reason toast) |
| `nanGuard` | `path` | WP1 | UI (dev console) |
| `effectEnded` | `id, stat` | WP1 | UI |
| `clicked` | `src, amount` | WP2 | render (+food float), WP6 achievements |
| `eggLaid` | `caste, n` | WP2 | render (queen pulse), WP6 golden |
| `hatched` | `caste, n` | WP2 | render, WP6 |
| `adultsDied` | `caste, n, cause` | WP2 | UI, WP6 |
| `adultsRetired` | `caste, n` | WP2 | UI |
| `broodDied` | `n, cause` | WP2 | UI, WP6 |
| `hungryStart` / `hungryEnd` | — | WP2 | render (vignette), UI |
| `softcapHit` | `stat` | WP2 | UI, WP6 (`ach_diminishing_returns`) |
| `bottleneckChanged` | `id` | WP2 | UI |
| `adaptationBought` | `id, level` | WP2 | UI, WP6 |
| `cellDug` | `i` | WP3 | render (redraw cell, pellets) |
| `chamberActivated` | `uid, chamberType, level` | WP3 | render (glow), UI, WP6 |
| `chamberLeveled` | `uid, level` | WP3 | render, UI |
| `cacheFound` | `i, kind, res, amount` | WP3 | render, UI, WP6 |
| `entranceOpened` | `kind, col` | WP3 | render (seam), UI |
| `hexRevealed` | `hex` | WP4 | render (fog), WP6 field guide |
| `sourceSpawned` / `sourceRemoved` | `uid, sourceType` / `uid, reason` | WP4 | render, UI |
| `trailCreated` / `trailDeleted` | `uid` | WP4 | render, WP6 |
| `trailRerouted` | `uid, from, to` (path lengths) | WP4 | WP6 (`ach_double_bridge`) |
| `abilityUsed` | `id, uid` | WP4 | render, UI |
| `claimDone` | `hex` | WP4 | render |
| `moundLeveled` | `level` | WP4 | render, UI |
| `radiusChanged` | `radius` | WP4 | render (camera bounds) |
| `rivalSighted` | `uid, rivalType` | WP5 | UI, WP6 field guide |
| `battleStart` | `uid, kind, hex, below` | WP5 | render (bubble), UI, WP6 |
| `battleEnd` | `uid, kind, tag, win, lost, kills, odds, start` | WP5 | render, UI, WP6 |
| `conquest` | `uid, rivalType, tier` | WP5 | render (ripple), UI, WP6 |
| `raidWarning` | `uid, rival, target, warn` | WP5 | render (arrow, red shaft), UI |
| `raidResult` | `uid, win, foodLost, broodLost, workersLost` | WP5 | render, UI, WP6 |
| `tournamentStart` / `tournamentEnd` | `uid, rival, hex` / `uid, rival, hex, result, ratio` | WP5 | UI, WP6 (STRETCH) |
| `researchBought` / `refinementBought` | `id` / `branch, level` | WP5 | UI, WP6 |
| `seasonChanged` | `id, year` | WP6 | render (palette), UI |
| `winterSoon` | — | WP6 | UI |
| `eventSpawned` / `eventResolved` | `uid, id` / `uid, id, choice` | WP6 | render, UI (event card) |
| `beetleSpawned` / `beetleClaimed` | — / `roll` | WP6 | render, UI |
| `pupaSpawned` / `giftOpened` | — / `id` | WP6 | render, UI |
| `unlock` | `key` | WP6 | UI (reveal animation, chime) |
| `achievement` | `id` | WP6 | UI (toast) |
| `fieldGuide` | `id` | WP6 | UI (toast) |
| `flightComplete` | `alates` | WP7 | render (ceremony), UI (landing chooser) |
| `runStarted` | `index` | WP7 | render (reset caches), UI |
| `supercolonyComplete` / `speciationComplete` | `kinship` / `genes` | WP7 | render (ceremony), UI |
| `hardshipTier` | `id, tier` | WP7 | UI |
| `ending` | — | WP7 | UI (ending sequence) |

Emitters may add payload fields beyond this table (consumers ignore unknown keys): `battleEnd` also carries `hex, below, party, raid, rival, esc, survivors, foeLeft, retreat`; `raidResult` carries `target, rival`; `beetleSpawned` carries `hex`; `eventResolved.choice` may also be an outcome (`harvested`, `lost`, `butterfly`, `clicked`, `expired`, `stomped`, `scattered`, `rerouted`, `failed`, `cleaned`, `ended`, `averted`). Events raised where no `env` is at hand are emitted on the next tick of the owning system (WP4 queues them in `d.surface._pending`; WP6 emits `beetleSpawned` on the tick that first sees a fresh beetle).

---

## 11. Unlock keys and conditions

`data/unlocks.js` exports `UNLOCKS: UnlockDef[]`:
```js
{ key: 'chamber_granary', label: 'Granary', cond: { any: [ { path: 'run.fRun', gte: 120 }, { custom: 'foodCapReached' } ] }, persist: true, queued: true }
// persist: once seen (meta.seen) the key is granted at the start of every later run (unlocks.onRunStart)
// queued:  the UI reveal goes through the 30 s reveal queue; false = immediate (purchase-triggered reveals)
```
**Condition language** (`unlocks.evalCond`):
`{ adults: n }` (adultsTotal ≥ n) · `{ research: id }` · `{ trait: id }` · `{ fed: id }` · `{ genome: id }` · `{ flag: key }` (another unlock key) · `{ path: 'run.fRun', gte: n }` (state path) · `{ dpath: 'stats.foodCap', gte: n }` (derived path) · `{ counter: 'flights', gte: n }` (meta.counters) · `{ runTime: sec, firstRun: true }` · `{ custom: name }` (predicate in `unlocks.js`: `housingFull`, `foodCapReached`, `crumbSaturated`, `firstHexRevealed`, `eggsBlockPurchase`, `firstChitin`, `firstDigger`, `rivalRevealed`, `rivalEligible`, `firstRaidWarning` (`run.stats.raidsIncoming ≥ 1`), `autumnYear0`, `firstWinter`, `prestigeTab`, `flightReady`, `waterRevealed`, `secondTrailOrClaim`) · `{ all: [...] }` · `{ any: [...] }`.

Keys (the contract; `P` = persist, `Q` = queued):

| key | condition | P | Q | Gates |
|---|---|---|---|---|
| `panel_colony` | first worker hatched (`run.stats.hatched ≥ 1`) | y | y | Colony tab, nurse job |
| `adapt_basic` | flag `panel_colony` | y | n | quick_dispatch, strong_mandibles, royal_feeding |
| `job_digger` | adults ≥ 3 | y | y | digger job, Soil on the rail |
| `adapt_digging_claws` | custom `firstDigger` | y | n | digging_claws |
| `panel_build` | custom `housingFull` | y | y | Build tab, full Below view, bottleneck badge |
| `chamber_gallery` | flag `panel_build` | y | n | Gallery |
| `chamber_granary` | `run.fRun ≥ 120` or custom `foodCapReached` | y | y | Granary |
| `chamber_nursery` | adults ≥ 8 (not "brood slots full": the 3 starting slots fill at ~0:08, DESIGN §23) | y | y | Nursery |
| `job_scout` | adults ≥ 12 | y | y | scout job, fog shimmer |
| `trail_slots` | custom `crumbSaturated` | y | y | trail-slot indicator, trail drawing demo |
| `panel_research` | custom `firstHexRevealed` | y | y | Research tab, Insight on the rail |
| `royal_levelup` | adults ≥ 20 | y | y | Royal Chamber level-ups |
| `egg_reserve` | custom `eggsBlockPurchase` and flag `panel_build` (C63) | y | y | egg reserve slider |
| `chamber_scent_library` | adults ≥ 30 | y | y | Scent Library |
| `panel_achievements` | 3 achievements earned | y | y | Achievements tab, Next Goals |
| `adapt_potent_trails` | adults ≥ 40 | y | y | potent_trails |
| `golden_beetle` | `{ runTime: 300, firstRun: true }` | y | y | Golden Beetles |
| `res_chitin` | custom `firstChitin` | y | y | Chitin on the rail |
| `chamber_midden` | adults ≥ 120 | y | y | Midden |
| `season_dial` | `{ runTime: 330, firstRun: true }` | y | y | season dial |
| `res_pheromone` | research `scent_marking` | n | n | Pheromone meter |
| `ability_mark` | research `scent_marking` | n | n | Mark, Mass Recruit |
| `hex_claim` | research `scent_marking` | n | n | hex claiming |
| `mound` | `run.res.soil ≥ 300` | y | y | Mound |
| `events` | `run.events.scripted` true, or `run.index ≥ 1` | y | y | random events |
| `panel_war` | research `polymorphism` | n | n | War panel, Barracks, caste slider, soldiers |
| `caste_soldier` / `chamber_barracks` / `adapt_military` | research `polymorphism` | n | n | |
| `panel_rivals` | custom `rivalRevealed` | y | y | rival panel, territory borders |
| `job_presets` | research `age_polyethism` (or innate automation) | n | n | job ratio presets |
| `job_herder` / `res_honeydew` / `chamber_root_aphid_pen` / `adapt_honeydew` | research `aphid_husbandry` | n | n | |
| `climate_overlay` | custom `autumnYear0` | y | y | Climate overlay, Winter Stores gauge |
| `panel_prestige` | custom `prestigeTab` (`fRun ≥ FLIGHT.tabFRun` = 2e7 or research `nuptial_preparation` owned, DESIGN §13.1) | y | y | Prestige tab |
| `ability_rally` | research `recruitment_pheromones` | n | n | Rally |
| `raid_warnings` | custom `rivalEligible` | y | y | raid UI |
| `frost_line` | custom `firstWinter` | y | y | frost line drawing |
| `chamber_gate` | custom `firstRaidWarning` or `{ runTime: 1500 }` (DESIGN §7.6: first raid warning, or 25:00) | y | y | Gate |
| `job_leafcutter` | research `leafcutting` | n | n | leafcutter job |
| `chamber_hibernaculum` | research `overwintering` | n | n | |
| `chamber_nuptial_chamber` / `alate_rearing` | research `nuptial_preparation` | n | n | |
| `fungus_widget` / `chamber_fungus_garden` / `job_gardener` / `res_fungus` | research `fungiculture` | n | n | |
| `chamber_thermal_chimney` | research `ventilation_shafts` | n | n | |
| `chamber_repletion_hall` / `caste_replete` | research `living_larders` (or species innate) | n | n | |
| `chamber_deep_vault` | research `acid_excavation` | n | n | |
| `chamber_water_well` | custom `waterRevealed` | n | y | |
| `caste_supermajor` | research `supermajors` | n | n | |
| `adapt_long_legs` | research `tandem_running` | n | n | |
| `ability_frenzy` | research `frenzy_signal` | n | n | |
| `panel_map` | custom `secondTrailOrClaim` and flag `trail_slots` (C63) | y | y | Map tab |
| `flight_button` | custom `flightReady` | n | y | Flight button active |
| `tab_bloodline` | counter `flights` ≥ 1 | y | y | Bloodline sub-tab |
| `tab_hardships` | `meta.counters.alatesLife ≥ 150` | y | y | Hardships |
| `tab_federation_teaser` | `meta.counters.alatesLife ≥ 1000` | y | y | greyed Federation tab |
| `tab_federation` / `tab_edicts` | counter `supercolonies` ≥ 1 | y | y | Federation, Edicts |
| `tab_genome_teaser` | `era.kinshipLife ≥ 20` (or speciations ≥ 1) | y | y | greyed Genome/Species |
| `tab_genome` | counter `speciations` ≥ 1 | y | y | Genome, Species |
| `tab_guide`, `tab_stats`, `tab_settings` | always | y | n | |

Bosses are spawned by WP5 from their own conditions (§8.4); they need no unlock keys.

---

## 12. Effect cross-reference (who implements which bonus)

Every bonus in DESIGN has exactly one implementing package. Numbers come from the `fx` fields (§6). "stats" = WP2 `stats.recompute`, "meta" = WP7 `prestige.derive`.

### 12.1 Research
| Consumer | Nodes |
|---|---|
| WP2 stats | `trail_memory` (forage), `recruitment_pheromones`, `coordinated_digging`, `acid_excavation` (dig ×2), `gallery_arches` (housing), `compact_galleries`, `brood_care`, `royal_pheromones`, `trophic_eggs`, `spermathecal_reserve`, `sugar_economy`, `weeder_ants` (fungus), `fungal_symbiosis`, `fungiculture` (nutrition), `formic_acid` (ATK), `war_chemistry`, `chemical_lexicon`, `pheromone_glands`, `seasonal_clock` (R), `overwintering` (winter upkeep), `collective_memory` (insight), `diapause_logic` (winter upkeep), `hive_mind` (insight), `antennation` (insight per hex), all refinements |
| WP2 population / jobs | `thermal_brood_shuttling` (allocation), `age_polyethism`, `response_thresholds` |
| WP3 nest | `load_chains`, `clay_masonry`, `ventilation_shafts` (chamber ×1.10, no clay spoilage), `thermoregulation` (no summer overheat), `gallery_arches` (+2 instances), `acid_excavation` (bedrock, stones) |
| WP4 surface / trails | `trail_memory`, `sun_compass`, `mass_recruitment` (slots, D_nav, rally 60 s), `tandem_running`, `double_bridge`, `persistent_trails`, `frenzy_signal`, `trunk_trails`, `odometer_navigation`, `mound_building`, `antennation` (scout speed, flagging), `aphid_shepherding`, `lycaenid_clients`, `weather_sense` (rain keeps strength), `hive_mind` (auto-Mark), `scent_marking` (abilities, claims) |
| WP5 war | `ritual_tournaments`, `phalanx`, `field_triage`, `propaganda_pheromones`, `siege_tactics`, `formic_acid` (cancels acid_volley), `early_warning` |
| WP6 world | `thermoregulation` (frost −5), `drainage`, `weeder_ants` (blight), `seasonal_clock` (forecast), `weather_sense` (warnings), `thermal_brood_shuttling` (frost snap immunity) |
| WP1 offline | `collective_memory` (+2 h), `diapause_logic` (+25 %) |
| WP6 unlocks | every node that unlocks a key (§11) |

### 12.2 Bloodline traits
| Consumer | Traits |
|---|---|
| WP7 meta / startRun | `hardy_workers`, `deep_diggers`, `fertile_queen`, `swarm_instinct`, `sweet_inheritance` (×2), `wide_wings`, `vast_galleries`, `founding_stores`, `remembered_paths`, `brood_bank`, `nanitic_vigor` (25 nanitics), `ancestral_memory`, `seasonal_wisdom` (start season), `budding` (supercolony requirement) |
| WP2 | `nanitic_vigor` (×3 workers), `warrior_lineage`, `seasonal_wisdom` (R), `automaton_instincts` (auto jobs) |
| WP3 | `ancestral_blueprint`, `automaton_instincts` (queue +2), `royal_court` (cells, nuptial max L), `polygyny` (Royal instances) |
| WP4 | `keen_antennae` (reveal via mapgen, scouts ×2), `sweet_inheritance` (aphid at ring 2) |
| WP5 | `budding` (Old Ridge spawn) |
| WP7 automation | `automaton_instincts` (Adaptation autobuyer) |
| WP1 offline | `long_memory` |
| WP8 render | `budding` (daughter-colony trails, cosmetic) |

### 12.3 Federation and Genome
| Consumer | Nodes |
|---|---|
| WP7 meta / flows | `megacolony_galleries`, `colossal_nests`, `unicolonial_sprawl`, `haplodiploid_fecundity`, `ancient_instinct`, `fossil_record`, `heirloom_bloodline`, `satellite_nest` (placement, census), `auto_flight`, `autobuyers`, `deep_time_automation`, `genetic_memory`, `eusocial_leap`, `species_*`, `megacolony` (speciation requirement) |
| WP2 | `automated_brood` (auto jobs + caste presets), `satellite_nest` (+25 % food/dig A_add), `venom_gland`, `thermal_ceiling`, `golden_brood` |
| WP3 | `blueprint_memory`, `aquifer_access`, `queens_council` |
| WP4 | `regional_expansion` (radius), `highway_network` (D_nav), `satellite_nest` (slots, origins, auto-claim) |
| WP5 | `regional_expansion` (max rivals), `highway_network` (shared garrison), `megacolony` (Argentine Front) |
| WP6 | `metapleural_glands`, `chronobiology` |
| WP1 | `diapause_mastery`, `dreaming_hive` |

### 12.4 Hardships, species, edicts, boons, landing tags
| Item | Consumer |
|---|---|
| Hardship rewards: `eternal_winter` (R), `claustral_founding` (lay, via meta), `monomorphic` (worker ×1.3, via meta) | WP2 / WP7 |
| Hardship rewards: `pacifist` (aggression, tournament threshold) | WP5 |
| Hardship rewards: `barren_ground` (slope) | WP4 |
| Hardship rewards: `shallow_soil` (layer work) | WP3 |
| Species mods | per the `mods` table in §6.7 |
| `edict_of_plenty`, `edict_of_war` (forage, AP) | WP2 stats; `edict_of_war` conquest ×1.5 → WP5 |
| `edict_of_depth` (dig ×3 → WP2; chamber costs ×0.5 → WP3) | WP2, WP3 |
| `edict_of_long_summer` | WP6 seasons |
| Boons `next_to_aphids`, `scouts_lead` | WP4 mapgen |
| Boon `rich_prey` | WP4 surface |
| Boons `peaceful_start`, `royal_vigor`, `chitin_hoard`, `insight_cache`, `old_trails`, `long_spring` | WP7 startRun (effects / grants / autoDraw / extraSpring) |
| Boon `blueprint_rush` | WP3 cellWork |
| Tags `rich_loam`, `stony_ground`, `wet_hollow` (water), `sunny_slope` | WP3 |
| Tags `seed_meadow`, `aphid_dense`, `hostile_neighbours` (tiers), `garden_path`, `wet_hollow` (puddles) | WP4 |
| Tags `hostile_neighbours` (conquest ×1.5) | WP5 |
| Tag `wet_hollow` (fungus +20 %) | WP2 |
| Tag `garden_path` (more footsteps: weight × 2) | WP6 |

### 12.5 Achievement extra rewards
| Consumer | Achievements |
|---|---|
| WP7 meta | the global ×1.01 per achievement; `ach_wilsons_pride` (+3 %); `ach_swift_swarm`, `ach_gentle_giants`, `ach_flying_ant_day` (alates) |
| WP2 stats | `ach_clickstorm`, `ach_hoarder`, `ach_survivor`, `ach_into_the_clay`, `ach_gravel_pit`, `ach_bedrock_bound`, `ach_royal_ascent`, `ach_thousand_strong`, `ach_ten_thousand`, `ach_myriad`, `ach_shepherd`, `ach_square_law`, `ach_total_war`, `ach_the_large_blue`, `ach_sociobiologist` |
| WP3 | `ach_going_under` (tunnel work), `ach_treasure_hunter` (hint radius), `ach_seed_bank` (granary ×1.1), `ach_architect` (relocation) |
| WP4 | `ach_double_bridge` (rise), `ach_highway` (S_max), `ach_cartographer` (scouts), `ach_land_grab` (claim cost) |
| WP5 | `ach_flawless` (alarm rally cost), `ach_ritualist` (threshold), `ach_phragmosis` (gate) |
| WP6 | `ach_clean_house` (mold chance), `ach_beetle_collector`, `ach_picnic_crasher` (beetle lifetime) |
| WP6 cosmetics | every `cosmetic` field is granted into `meta.cosmetics.owned` by `achievements.js` |

---

## 13. Rendering (WP8)

### 13.1 Principles
- Renderers **read** `game.s`, `game.d` and `ui/uistate.js`; they never write `s`. Player intent goes through `game.actions`, UI-only intent (selection, hover, tool, panel) through `uistate.setUI` and the **bridge** (§14.2).
- Everything is drawn procedurally on 2D canvases. No image files. A sprite atlas is pre-rendered at startup (`render/atlas.js`).
- `main.js` owns the single `requestAnimationFrame` loop and calls `renderer.render(frameDt)` after `game.advance`. Simulation is 10 Hz; sprites animate at frame rate on their own, so no state interpolation is needed. Renderers clamp `frameDt` to ≤ 0.1 s (the first frame after a hidden period carries the whole gap).
- On `runStarted`, `supercolonyComplete`, `speciationComplete`, `reset` and `imported`, renderers drop every cache and sprite pool and rebuild from the new state.

### 13.2 Canvas layers (`render/canvas.js`)
```js
export function createLayer(canvas, { maxDpr = 2, onResize = null } = {}) → Layer
// Layer = { canvas, ctx, cssW, cssH, dpr, resize(), destroy() }
// dpr = min(devicePixelRatio, maxDpr); canvas.width = round(cssW × dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0).
// A ResizeObserver on canvas.parentElement calls resize() → invalidates caches → onResize(layer). All drawing uses CSS pixels.
// A hidden canvas (display: none on medium/narrow layouts, measured 0 × 0) keeps its last size until it is shown again.
export function createOffscreen(w, h) → { canvas, ctx }   // document.createElement('canvas'); OffscreenCanvas optional
```

### 13.3 Public renderer API
```js
// render/nestRenderer.js
export function createNestRenderer(canvas, { game, ui, bus, strip = null }) → {   // strip: the #nest-strip canvas (drawn via minimap.drawNestStrip)
  render(frameDt),                     // no-op while hidden or document.hidden
  pick(cssX, cssY) → Target | null,
  cellAt(cssX, cssY) → { x, y, i } | null,
  setVisible(on), setInset(on),        // inset = first-load 30 % mode (queen and first egg)
  scrollToRow(row),                    // row at the top, instantly
  centerOnCell(i) → boolean,           // locate: glide (≈0.45 s; a jump with reduced motion) so cell i is centred, zooming
                                       //   in only while cells are under 13 px; false for an invalid index
  ping(i) → boolean,                   // locate: expanding highlight rings on cell i for 1.5 s (a steady fading ring with
                                       //   reduced motion); during a centerOnCell glide it starts when the glide arrives
  destroy() }
// render/surfaceRenderer.js
export function createSurfaceRenderer(canvas, { game, ui, bus }) → {
  render(frameDt), pick(cssX, cssY) → Target | null, hexAt(cssX, cssY) → number,   // −1 outside
  hexToScreen(hex) → { x, y }, centerOn(hex),
  ping(hex) → boolean,                 // locate: the same 1.5 s highlight rings on a hex; false outside the map
  setVisible(on), destroy() }
// WP8-internal extensions on the returned objects (used by the input controllers, ceremonies and render tests; the UI uses
//   only the API above, plus nest.getView() as a fallback in locate): nest — game, input, scrollBy(dy), panBy(dx, dy),
//   zoomAt(f, x, y), frameHome(), controlAt(x, y), pressControl('in' | 'out' | 'home' | 'queen'), getView(), ghostAt(cell, tool),
//   ceremonyView(row); surface — game, input, panBy, zoomAt, getCamera(), satelliteAt(hex) → reason | null (F15),
//   trailScreenPolyline(uid), entranceAt(hex).
// Locate recipe (UI warning chips, toast "Show" buttons): switch the view in, then nest.centerOnCell(i) + nest.ping(i),
// or surface.centerOn(hex) + surface.ping(hex). scrollToRow, centerOnCell and centerOn are deliberate camera moves:
// later layout changes keep them, and a resize within 1.5 s re-applies scrollToRow / centerOnCell at the real size
// (the view is usually switched in a frame after the call). Player scroll / pan / zoom cancels a glide.
// Camera ownership: until the player moves a camera, every layout change re-applies the default framing (Below: the
// Royal Chamber, camera.frame; Above: the nest centred with rings 0–3 at a comfortable zoom — filling the width on a
// phone canvas, ≥ 42 % of the width up to zoom 1.35 on wide ones, zoom 1 otherwise). runStarted, supercolonyComplete,
// speciationComplete, reset and imported re-apply it whatever the player did. A ceremony that moves the Below view
// (speciation: the Strata band; time-lapse: the first dug cell) glides back to the default framing when it ends,
// unless the player moved the camera during it (F20).
// render/nestInput.js / render/surfaceInput.js
export function attachNestInput(canvas, renderer, { game, ui, bridge }) → detach
export function attachSurfaceInput(canvas, renderer, { game, ui, bridge }) → detach
// render/seam.js — shaft connector strip + sprite hand-off between views
export function createSeam(canvas, { game }) → { render(frameDt), toSurface(n, carry), toNest(n, carry), destroy() }
// render/minimap.js
export function drawMiniMap(canvas, terrain, sources, radius) → void   // landing previews (WP9 calls with prestige.landingPreview output)
export function drawNestStrip(canvas, s, viewRow0, viewRows) → void    // nest minimap strip
// render/ceremony.js
export function playCeremony(kind, { nest, surface, summary }) → Promise<void>   // 'flight' | 'supercolony' | 'speciation' | 'timelapse' | 'ending'
//   nest/surface are the renderers (WP9 passes those handed over by ui.attachRenderers); a canvas is accepted as a fallback
//   (each renderer registers itself under its canvas via ceremony.registerRenderer)
// render/geom.js (pure, unit-tested)
export function cellToPx(i, view) → { x, y }; pxToCell(x, y, view) → i | −1
export function hexToPx(hex, cam) → { x, y }; pxToHex(x, y, cam) → hex | −1    // uses core/hex.js with camera { x, y, zoom }
export function distToPolyline(px, py, pts) → number; catmullRom(pts, t) → { x, y }
```
**Target** (returned by `pick`, consumed by the bridge and tooltips):
```js
{ view: 'nest' | 'surface', kind, id?, i?, hex? }
// nest kinds:    'cell' (i), 'chamber' (id = uid), 'digFace' (i), 'queen' (id = royal uid), 'nursery' (id), 'pupa', 'mold' (id = object uid), 'flood', 'cacheHint' (i), 'shaft' (i)
// surface kinds: 'hex' (hex), 'source' (id), 'trail' (id), 'rival' (id), 'party' (id), 'beetle', 'eventObject' (id), 'gift' (id = index), 'entrance' (hex)
```

### 13.4 Sampled sprite simulation (`render/sprites.js`)
- **Budgets:** Below 160, Above 260, battle bubbles 40 per side, flight ceremony 120. **Hard cap 600** in total.
- **Allocation** (largest-remainder method), recomputed every 0.5 s from real counts:
  - Below: diggers (at `d.nest.digFace`, carrying pellets up the shaft), nurses (in nurseries), haulers (shaft ↔ storage nodes, ∝ foragers), tenders (gardens/pens ∝ gardeners + herders), soldiers (barracks), idle (galleries). Queens are drawn separately (not in the budget).
  - Above: per trail by effective workers (min 2 per active trail), ≥ 3 scouts at the frontier, escorts on their trails, garrison near the entrance, loose foragers around hex 0.
  - Each view shows **"1 ● = K ants"** with `K = ceil(N_view / budget)` (when `settings.showScaleLabel`).
- **Pools:** preallocated typed arrays sized to the budget (`x, y, t, speed, type, state, carry, path`); no per-frame allocation, no collision.
- **Movement:** Below follows BFS distance fields (`d.nest.dist` toward the entrance; per-target fields cached by `(d.nest.rev, targetUid)`; ≤ 3,200 cells, < 1 ms). Above follows Catmull-Rom splines through the hex centres of `trail.path`, out and back.
- **Seam:** a sprite reaching the shaft top despawns and `seam.toSurface()` spawns one at the entrance hex in the same frame (and vice versa), so the stream is continuous.
- **Carried colours:** seed beige, honeydew amber, leaf green, chitin black, pupa white. Golden ants drawn gold.

### 13.5 What each view draws (DESIGN §7.13, §8, §25.5)
- **Nest (Below)**, back to front: strata cache (offscreen, one cell per grid cell at a resolution bucket for the current zoom: smooth depth gradient, wavy strata boundaries, pebbles, roots, stones, water pockets, Strata fossils from `meta.strata`; open cells drawn as rounded passages, each chamber as one organic cavity with a doorway per touching passage, `render/nestArt.js`; only changed cells are redrawn on `cellDug` / rev, and the whole cache is rebuilt once a zoom settles, ~220 ms) → decorative soil margins either side of the grid (continuing the strata, lightly dimmed) → discoloured cache hints → chamber contents clipped to the cavity (granary seed piles ∝ fill; clay mould flecks while spoiling; ≤ 30 brood sprites per nursery by stage, frozen tint; queen pulse on `eggLaid`, size by Royal level; fungus domes ∝ stock, grey under blight; amber repletes ∝ cap bonus; winged alates in the Nuptial Chamber; darkened overloaded midden) → frost line (crisp blue-white edge at `d.season.frostRow`) → flood water → sprites (the queen on top of her attendants) → mold spots (blotch, steady ring ≥ 8 px, a ping every 2.5 s unless reduced motion) → labels (level badge or dig-progress ring, short names where they fit, full name and level on hover/selection; badges hide under 8 px cells) → placement ghost (the cavity shape it will become; green/amber/red from `nest.validatePlacement`, memoised by `(type, x, y, d.nest.rev)`; red reason text; raid-reach zone) and dashed tunnel previews → dig-queue progress → overlays → Hungry vignette, red shaft flash during raid warnings, raiders in the shaft during gate fights → locate pings → camera buttons (−, +, crown; top-right) and a "Queen ↓" chip while the Royal Chamber is out of view.
- **Nest framing and zoom** (`render/camera.js` `createNestCamera`): the zoom-1 cell size fills the canvas width with the 40 columns, capped at 24 px and so that at least 16 rows stay visible (`min(w / 40, 24, h / 16)`); a canvas wider than that shows the margins. The **default framing** (`camera.frame`) shows the sky (2 rows) down to the deepest chamber with cells between `FRAME_CELL` = 13 px and the width fit (a narrow canvas zooms past its width fit up to 13 px, centred on the shaft, so chambers stay tappable), and always keeps the Royal Chamber fully in view; the first-load inset centres the queen. When it applies: §13.3 "Camera ownership". Player zoom multiplies the zoom-1 cell from "the whole column fits the height" (cells ≥ 4 px) up to ~40 px (at least 2× the fit); once the grid is wider than the canvas the view also pans sideways. Controls: §13.7. The minimap strip shows the whole column.
- **Surface (Above)**: terrain cache (rebuilt on `s.run.surface.rev` or season change; seasonal palette) → territory tint and rival land (patterned, colour-blind safe) → fog (unrevealed dark, frontier shimmer) → trails (width `1 + log10(workers)` clamped 1–6 px, opacity `S / S_max`) → sources (icons + stock ring) → mound (rises with level), rival nests, party markers, red dashed raid arrows with countdown → event objects, Golden Beetle, gift boxes, daughter colonies at the map edge (`cycle.daughters`; faint trails with `budding`) → sprites → battle bubbles → weather particles → overlays → tool previews (satellite tint, §13.7) → locate pings. Default framing per §13.3 (the nest centred with rings 0–3 at a comfortable zoom); pan by dragging empty ground or the arrow keys; zoom 0.6–1.6 by wheel, pinch or `+` / `−`.
- **Particles** (`render/particles.js`): rain, snow, falling leaves, soil pellets landing on the mound, chitin glints; ≤ 300; reduced with `settings.reducedMotion`.
- **Battle bubbles** (`render/battle.js`): two clusters of ≤ 40 sprites per side, ∝ surviving counts; lunges; corpses 5 s then glints carried home. Conquest ripple; rival trails fade over 10 s.
- **Ceremonies**: flight (zoom out, ≤ 120 alates spiral out of the nuptial entrance, counter ticks), supercolony (trails link daughter colonies, camera pulls back), speciation (amber block in the Strata band), welcome-back time-lapse (5 s replay of `summary.cells` / `summary.chambers`), ending.

### 13.6 Hit-testing priority
- Surface: beetle > gift > event object > party marker > rival nest > source > trail (distance to the polyline ≤ 6 CSS px) > hex.
- Nest: pupa > mold > flood water > queen > dig face > chamber (footprint) > cache hint > cell.
- Nest, ahead of that list: the camera buttons and the "Queen ↓" chip (`controlAt`). A press on them only moves the camera and never reaches `pick`, the bridge or `game.actions`.

### 13.7 Input mapping (`nestInput.js`, `surfaceInput.js`)
Behaviour depends on `uistate.tool` (§14.4):
- **Nest, no tool:** click chamber → `bridge.select(target)`; click a nursery → select + `groomBrood`; queen → `clickQueen` + select; dig face → `helpDig`; pupa → `bridge.openChooser('pupa')`; mold → `scrapeMold`; flood → `bailFlood`; cache hint → `digTo`; drag from an open cell across soil → tunnel preview (`nestgeom.routeTo`), release → `digTunnel`.
- **Nest tools:** `placeChamber` (ghost follows the cursor; click → `placeChamber`; `Esc` or right-click cancels), `relocate`, `backfill` (drag-select), `levelDir` (click an edge to choose the growth direction).
- **Surface, no tool:** click a source other than prey, the termite mound or a Lycaenid caterpillar → `clickForage` + select; drag from a trail origin → `trails.previewTrail` ghost, release on a source → `drawTrail`; click trail/hex/party → select; click a rival nest, prey or termite mound → select + `bridge.openTab('map', 'war')` (the war panel focused on that target, live odds from `rivals.previewAction`); **drag from an entrance onto a rival nest, prey or termite mound** → `bridge.openChooser('war', { kind, target })` (party sliders + odds; its Launch button calls `launchParty`), so attacks start on the map; beetle → `clickBeetle`; event object → `clickEventObject`; gift → `openGift`.
- **Nest selection:** clicking a chamber also calls `bridge.openTab('build', 'inspect')` (level up with direction, relocate, demolish, modifiers).
- **Surface tools:** `claim` → `claimHex`; `flag` → `flagHex`; `reroute` (drag waypoints) → `rerouteTrail`; `placeSatellite` → `bridge.openChooser('satelliteColumn', { hex })` for a valid hex, else `bridge.reject(reason)` with the tool kept (F15: while the tool is active the Above view tints hexes that pass the hex-level `placeSatellite` rules — free Satellite Nest level, owned, passable, ≥ `fx.minDist` from every entrance, and some column ≥ `fx.colGap` from every shaft whose shaft keeps the Royal Chamber's room — green and greys out the rest; the hovered hex is labelled with its reason and a canvas hint says what the tool needs; reasons are the validator's codes `max`, `locked`, `blocked:unowned`, `blocked:terrain`, `blocked:entrance`, `blocked:shaft`, `blocked:royalRoom`); `moveAphids` → `moveAphids`; `tournament` → `tournament`.
- **Camera controls** (never dispatch actions; any of them hands camera ownership to the player, §13.3):
  - Nest: wheel scrolls; `Ctrl`/`⌘` + wheel or trackpad pinch zooms at the cursor; `Shift` + wheel or a sideways swipe pans; any drag that is not a tunnel (from an open cell, no tool) or a backfill selection scrolls and, once zoomed past the width, pans; two-finger touch pinches and pans. With the canvas focused: `↑`/`↓`/`PgUp`/`PgDn` scroll, `←`/`→` pan, `+`/`=` and `−`/`_` zoom, `0`/`Home` re-frame the queen. On-canvas buttons − / + zoom around the centre (×1.35) and the crown (or the "Queen ↓" chip) re-frames the queen and returns ownership to the default framing.
  - Surface: drag empty ground pans; wheel and pinch zoom at the cursor; with the canvas focused, arrows pan and `+`/`−` zoom (×1.15).
- Hover → `bridge.hover(target, clientX, clientY)` (tooltips; adjacency link lines for chambers). Right-click or long-press → `bridge.contextMenu(target, x, y)`.
- Every action result `{ ok: false, reason }` → `bridge.reject(reason, x, y)` (small shake + reason text).

### 13.8 Performance and lifecycle
Render ≤ 6 ms per frame for both canvases; ≤ 600 `drawImage` calls; no `shadowBlur`; DPR capped at 2; soil and terrain cached offscreen with dirty-cell redraws. A hidden view (`setVisible(false)` on medium/narrow layouts) skips drawing entirely; `document.hidden` stops the loop (main.js).

---

## 14. UI (WP9)

### 14.1 DOM skeleton (`index.html`, ids are the contract with `main.js`)
```html
<div id="app">
  <aside id="rail"></aside>                                   <!-- resource rail (top bar on medium/narrow) -->
  <main id="stage">
    <header id="hud-top"></header>                            <!-- season dial, bottleneck badge, next-unlock ribbon, colony scale -->
    <section id="view-above"><canvas id="canvas-above"></canvas></section>
    <div id="flow-strip"><canvas id="canvas-seam"></canvas></div>
    <section id="view-below"><canvas id="canvas-below"></canvas><canvas id="nest-strip"></canvas></section>
    <nav id="overlay-bar"></nav>
    <nav id="view-tabs"></nav>                                <!-- Above / Below / Split on medium and narrow -->
  </main>
  <aside id="panels"><nav id="tabs"></nav><div id="panel-body"></div></aside>
  <div id="event-card"></div><div id="toasts"></div><div id="tooltip"></div><div id="modal-root"></div>
</div>
<script type="module" src="src/main.js"></script>
```

### 14.2 App shell (`ui/app.js`) and the bridge
```js
export function mountUI(root, game) → {
  canvases: { above, below, seam, nestStrip },
  bridge,                       // passed to render/*Input.js
  frame(nowMs),                 // called every animation frame; refreshes HUD and the visible panel at 4 Hz (changed text nodes only)
  showWelcome(summary), destroy() }
// bridge = { hover(target | null, clientX, clientY), select(target | null), openTab(tabId, sub = null),
//            openChooser(kind, data), contextMenu(target, x, y), reject(reason, x, y, type?), toast(text, kind = 'info'), locate(loc) }
// reject's optional type (the refused command) selects command-specific copy (text.js REASON_BY_COMMAND); without it the UI
//   infers it from the active tool, else the hovered view (nest → digTo, surface → drawTrail). locate(loc) (WP9 extension) uses
//   nest.centerOnCell(cell) / nest.ping(cell) / surface.ping(hex) when the renderer has them, else nest.scrollToRow / surface.centerOn.
// openChooser kinds (WP9 implements all; WP8 calls them): 'pupa' {} → actions.clickPupa({ choice });
//   'satelliteColumn' { hex } → actions.placeSatellite({ hex, col }) (a hex that fails the hex part of the rule is refused with its reason
//   before the column picker opens, and the placeSatellite tool stays armed; C81); 'war' { kind, target } → actions.launchParty({ kind, target, soldier, supermajor }).
// contextMenu items per Target kind: chamber (level, relocate, demolish), trail (Mark, Rally, delete, reroute), rival (Raid, Assault, Bribe, Tournament),
//   source (hand-forage, draw trail), hex (claim, flag, place satellite), party (recall, reinforce). Each item dispatches the matching action or sets the tool.
```
- **Breakpoints** (DESIGN §25.1): `wide-tall` (≥ 1280 × ≥ 820: rail 220 px, Above ~55 % over Below ~45 %, panels 380 px), `wide-short` (side by side), `medium` (768–1279: one canvas area with Above / Below / Split tabs, drawer panels that dock beside the canvas while open (C81), top bar), `narrow` (< 768: single canvas, 16 px gutters, bottom-sheet panels peek/half/full, horizontally scrolling resource bar inside itself). `#app[data-layout]` is set by `app.js`; CSS does the rest. First load: Above fills, Below is a 30 % inset until unlock `panel_build` (`nestRenderer.setInset`).
- **Subscriptions:** `achievement`, `fieldGuide`, `unlock` → toasts and reveal animation (a newly revealed panel tab never steals the open tab: it slides in with a "new" dot; it is opened only while the welcome card holds the panel column, §14.6); `eventSpawned` → event card, and for a negative event a high-priority toast with a **Show** button that calls `locate` for its warning chip; `flightComplete` → ceremony then landing chooser (`meta.pending`); `raidWarning` → badge + toast; `welcome` → welcome modal; `offlineDone` → welcome modal (≥ `LOOP.welcomeMinSec`) or the catch-up toast (C65); `storageError` → persistent banner "Saving unavailable: use Export"; `imported` → `game.save` at once (exports carry `savedAt` 0, so Settings would say "Not saved yet" and a reload could bring the old colony back); `commandRejected` → reason toast (rate-limited); `ending` → ending modal. `saveStale` and the tab lock are handled by `main.js` (§14.7).
- **Keyboard:** `1–9` tabs, `Space` hand-forage the selected source, `M` Mark / `R` Rally the selected trail, `Esc` closes in order: context menu → modal → Settings confirm → tool → selection → the medium drawer / the narrow sheet (lowered to peek); `Tab` switch view (medium/narrow). Canvas camera keys and gestures: §13.7. Settings lists every key and gesture in "Keyboard and view controls" (`panels/settings.js` `SHORTCUTS`).
- **locate(loc)** (`loc` = `{ view: 'nest', cell?, row?, chamber? }` or `{ view: 'surface', hex }`, from `hud.activeThreats`): lowers the narrow sheet, switches the medium/narrow view in, centres and pings the spot (§13.3 locate recipe) and selects the chamber or hex so its outline shows. The medium drawer stays open (it docks beside the canvas, C81).

### 14.3 Number formatting (`ui/format.js`, DESIGN §26)
```js
export function setNotation(mode)                 // 'suffix' | 'scientific' | 'engineering' (from settings)
export function fmt(x, { kind = 'res' } = {}) → string   // kind 'count' (integers < 1000), 'res' (one decimal < 100, integer < 1000), then 3 sig. digits + K M B T Qa Qi Sx Sp Oc No Dc up to 1e36, then scientific
export function fmtRate(x) → string               // '0.53/s', '4.20K/s'; negative with a leading '−' (caller adds the red class)
export function fmtMult(x) → string               // '×1.25', '×4.20M'
export function fmtPct(frac, { signed = true } = {}) → string   // '+15%', '+2.5%'
export function fmtTime(sec) → string             // '45s', '4m 05s', '1h 23m', '2d 4h'
export function fmtCost(cost, s) → [{ res, text, ok }]          // null cost → [{ text: 'MAX', ok: false }]
export const MAX_LABEL = 'MAX';
// Never prints NaN or Infinity: prints '—' and console.error once.
```

### 14.4 Shared UI store (`ui/uistate.js`, non-persisted)
```js
export function getUI() → UIState
export function setUI(patch) → void               // shallow merge, notifies listeners
export function onUI(fn) → unsubscribe
// UIState = {
//   tool: null | { kind: 'placeChamber', chamber } | { kind: 'relocate', uid } | { kind: 'backfill' } | { kind: 'levelDir', uid }
//              | { kind: 'claim' } | { kind: 'flag' } | { kind: 'reroute', uid } | { kind: 'placeSatellite' }
//              | { kind: 'moveAphids', src } | { kind: 'tournament', rival },
//   selection: Target | null, hover: Target | null,
//   overlays: { climate, raid_reach, haul, adjacency, territory, trail_strength, danger, richness },   // booleans
//   layout: 'wide-tall' | 'wide-short' | 'medium' | 'narrow', view: 'split' | 'above' | 'below',
//   tab: 'colony', subTab: null, ghostDemo: null | { kind: 'trail' | 'chamber', from, to }, glow: null | string }
// tab ids: 'colony' | 'build' | 'map' | 'research' | 'prestige' | 'achievements' | 'guide' | 'stats' | 'settings'.
// subTab ids: build 'inspect'; map 'war'; prestige 'flight' | 'bloodline' | 'hardships' | 'supercolony' | 'federation' | 'edicts' |
//   'speciation' | 'genome' | 'species'; null elsewhere.
```
WP8 writes `selection` (via bridge), `hover`, `tool` completion (`tool = null` after a successful place). WP9 writes everything else.

### 14.5 Panels (`ui/panels/*.js`)
Each module exports `createPanel(root, { game, ui, bridge }) → { update(s, d), destroy() }`. Contents and the queries they use:

| Panel | Reveal key | Contents | Queries |
|---|---|---|---|
| Colony | `panel_colony` | brood pipeline (egg/larva/pupa, lay rate, egg reserve slider), caste slider, "Retire to workers" (soldiers/supermajors, shown with `panel_war`), job chips with +/− and presets, Adaptations, alate rearing | `population.broodSummary`, `jobs.idleMinors`, `jobs.jobCap`, `adaptations.cost/isAvailable`, `stats.eggCost` |
| Build | `panel_build` | chamber list (locked greyed with condition), dig-queue chips (reorder/cancel, work, ETA), Mound, inspect panel of the selected chamber (level up with direction, relocate, demolish, modifiers), blueprints | `nest.placementCost`, `nest.levelInfo`, `d.nest.queueInfo`, `surface.moundCost` |
| Map | `panel_map` | trails list (workers, strength, yield, escorts, Mark/Rally), selected source/hex info, claim cost, rivals list + war panel (Raid/Assault/Tournament/Bribe with live odds "Victory 92 % · expected losses …", "what would raise it"; Old Ridge immunity "N/25 hexes" and the Front's "nest i/3" window, C81), hunts, raids (Dispatch garrison only for trail raids in warning or trail phase; nest raids state the garrison that defends), satellite rule with the count of qualifying hexes (C81) | `trails.previewTrail/trailYield`, `surface.claimCost/canClaim`, `rivals.previewAction`, `rivals.garrison` |
| Research | `panel_research` | tier grid by branch (columns = branches), locked nodes greyed with prerequisites, Innate helix badge, refinements | `research.isAvailable/cost/refinementCost` |
| Prestige | `panel_prestige` | sub-tabs Flight (checklist, projection, alates/min meter with peak glow) · Bloodline (with the Adaptation autobuyer switch for Automaton Instincts owners, C88) · Hardships · Supercolony · Federation · Edicts · Speciation · Genome (STRETCH nodes not listed) · Species (each by its key) | `d.meta.proj`, `prestige.project*`, `traits.*Cost`, `hardships.goal` |
| Achievements | `panel_achievements` | list by category, Next Goals (3 bars), secret placeholders | `achievements.progress/nextGoals` |
| Field Guide | `tab_guide` | entries by category with the 40–60 word notes | data only |
| Stats | `tab_stats` | run and lifetime statistics, per-layer timings | state only |
| Settings | `tab_settings` | notation, autosave interval, reduced motion, sound, harsh nature, retreat slider, colony/queen names, cosmetics, Save now, keyboard and view controls reference, export (copy + `.txt` download on click), import (paste → confirm modal), hard reset (type `abandon`), Photo Mode (STRETCH, cut-list #5; owned by WP9 `settings.js`: hides the UI, composes `#canvas-above` and/or `#canvas-below` plus a stat card on an offscreen canvas, `toDataURL('image/png')`, download on click) | `game.exportString`, `game.importString`, `game.hardReset` |

**Reveal-on-unlock:** every element declares its unlock key; it is shown when `unlocks.isRevealed(s, key)` (`ui/reveal.js` `isShown`; `?reveal=all` shows everything). The first reveal slides in with a soft chime (when `sound`) and its first item glows once.

**Tab row (polish round):** the five gameplay tabs are compact text tabs with an accent underline; Field Guide, Stats and Settings are icon buttons at the end of the row. Each tab's tooltip names its number key. A revealed gameplay tab the player has never opened carries a "new" dot; opened tabs are remembered per browser (`localStorage` key `sld.ui.visitedTabs`, a UI convenience outside the save, every access in try/catch), so a tab revealed during a catch-up or before a reload keeps its dot. Existing saves and imports count as already seen; a hard reset makes every tab new again. While the medium drawer or the narrow sheet is closed, the Panels button (narrow: the sheet handle) carries the "new" cue instead.

**Purchase states:** affordable → green buy button; not yet affordable → quiet button that stays clickable (so the reason popup shows) with the missing cost in red; MAX → gold outline and a gold "MAX".

**Refusal copy (C81):** every `code:detail` reason a validator returns has its own text (`text.js` `REASON_DETAILS`; a test scans `src/systems` and `core/commands.js` for new codes); bare codes whose meaning depends on the command use `REASON_BY_COMMAND`; the last fallback is "Something is in the way." The Build inspect panel explains `'blocked:royalRoom'` and withheld growth directions (`levelInfo.royalRoom`, C66).

### 14.6 HUD, tooltips, toasts, cards, modals
- **Rail:** only revealed resources: value, rate/s (red when negative), cap bar if capped, "sc" badge when `d.rates[res].sc` (tooltip raw → effective). Colony Scale once > 1.
- **HUD top:** bottleneck badge (`run.bottleneck`, "Bottleneck: Housing · eggs blocked 34 s"), season dial with forecast (`seasonal_clock`), next-unlock ribbon (`d.progress.nextUnlock` through `hud.ribbonInfo`; when nothing timed is within 120 s it names the next step and its condition, e.g. "Next: Research · reveal your first hex", C86). **Flow strip:** food/s arriving, ants out, active raids/campaigns. Narrow layout: the top bar shows only the logo mark, season and bottleneck share a row (no "Bottleneck:" prefix), and the ribbon hides while the panel sheet is raised.
- **Warning chips** (`hud.activeThreats(s)`, pure): red chips beside the bottleneck badge for every active harmful effect, most severe first — the Argentine Front window ("Front 1/3 down", counting down to the regrowth, C81), mold (spot count), blight, flood, rain, drought, phorid flies, quarantine, mites, ladybugs, antlion, lizard, footstep, army ants, frost snap and a few others. Each shows the time left and a live tooltip; a click calls `bridge.locate` on the spot, and repeated clicks step through all spots.
- **Tooltips** (`ui/tooltips.js`): ≤ 12 words of copy (`ui/text.js`) plus numbers on hover; canvas targets via `bridge.hover`. They appear after 350 ms, hide on click and are not re-shown by clicking (keyboard focus still shows them); tooltips that only repeated the row's own text were removed.
- **Welcome card** (`ui/intro.js`, DESIGN §25.6): until the first gameplay panel reveals, the panel column shows a small card (title, one line of story, "Click the glowing crumb to gather food." with an arrow toward the map) instead of an always-on tab; after `CRUMB_CLICKS` = 3 clicks it shows a "First worker" progress bar with a countdown (`firstHatchEta`). Nothing on it pulses, so the crumb stays the only glow. Medium and narrow layouts, whose panels start closed, show the same line as a coach over the Above view until the third click. The Field Guide, Stats and Settings still open on request; the Colony panel replaces the card when it reveals.
- **Toasts** (`ui/toasts.js`): bottom-left, ≤ 2 per 10 s; overflow queued, low-priority dropped.
- **Event card** (`ui/eventCard.js`): non-modal, top-centre, 30 s timer bar, default choice marked `*` → `actions.eventChoice`.
- **Modals** (`ui/modals.js`) only for irreversible actions: prestige confirmations, landing chooser (mini-maps via `render/minimap.drawMiniMap` + `prestige.landingPreview`, boon picks, season pick, and a Bloodline shop `modals.landingShop` for the alates just earned, C88), hard reset, import, ending.
- **Toasts for negative events** carry a **Show** button (locate) and stay 8 s; the rail shows "Year Y · run N · landing" while the landing chooser is open (C88).
- **Settings:** "Save now" (the status reads "Saved just now." for 5 s after a save), and a "Keyboard and view controls" reference (`SHORTCUTS`). The Build panel has a one-line nest-view tip (zoom, crown button).
- **Welcome back** (`ui/welcome.js`): stat lines from `OfflineSummary` (food gained, "N food lost to full granaries", ants hatched, cells dug, chambers completed, seasons passed, sources depleted, Saved Finds) and a "Watch time-lapse" button (`playCeremony('timelapse')`).
- **Onboarding** (`ui/onboarding.js`, DESIGN §25.6): one glow at a time (`uistate.glow`), ghost-ant demo after 8 s of hesitation (`uistate.ghostDemo`, drawn by WP8), advisor pulse in the first hour (nothing useful affordable within 120 s → pulse the limiting chamber/resource, via `wallet.timeToAfford`). Completed hints are persisted with `actions.uiFlag`.

### 14.7 Boot (`src/main.js`)
```js
const storage = (() => { try { return window.localStorage; } catch { return null; } })();
const game = createGame({ nowMs: Date.now(), storage });
const { welcome } = game.loadOrNew(Date.now());
game.hooks.beforePrestige = () => game.save(Date.now());
const ui = mountUI(document.getElementById('app'), game);
const nest = createNestRenderer(ui.canvases.below, { game, ui: uistate, bus: game.bus, strip: ui.canvases.nestStrip });
const surface = createSurfaceRenderer(ui.canvases.above, { game, ui: uistate, bus: game.bus });
attachNestInput(ui.canvases.below, nest, { game, ui: uistate, bridge: ui.bridge });
attachSurfaceInput(ui.canvases.above, surface, { game, ui: uistate, bridge: ui.bridge });
const seam = createSeam(ui.canvases.seam, { game });
if (welcome) ui.showWelcome(welcome);
let last = performance.now();
function frame(now) { if (!document.hidden) { game.advance((now - last) / 1000, Date.now()); nest.render((now - last) / 1000);
  surface.render((now - last) / 1000); seam.render((now - last) / 1000); ui.frame(now); } last = now; requestAnimationFrame(frame); }
requestAnimationFrame(frame);
document.addEventListener('visibilitychange', () => { if (document.hidden) game.save(Date.now()); });
// autosave every meta.settings.autosaveSec (setInterval re-armed on settings change); save on 'pagehide'
```
The gap after a hidden period arrives as one large `realDt`, which `game.advance` routes to `catchUp` (§7.1).

As built (accepted at integration): the five render modules are loaded with dynamic `import()`, each in its own `try/catch`, and handed to the shell with `ui.attachRenderers({ nest, surface, seam })`, so a broken render module leaves a blank canvas instead of stopping the game; `last` only advances while the page is visible (same intent as above); `?reveal=all` reveals every panel (debug); `window.sld` exposes the game (and `tabLock`) for the console. Runtime fixes (C78–C80): boot first awaits `tabLock.acquire()` and boots only if it still owns the game (else it shows the overlay); every save goes through one `persist()` that requires `!paused && tabLock.check()` and passes `{ hidden: document.hidden || no frame for over 1 s }`; the frame loop calls `game.advance(dt, Date.now(), { maxTicks: FRAME.maxTicks, budgetMs: FRAME.budgetMs, clock: performance.now })`; a shown-again or resumed tab re-checks the lock; `pagehide` saves then `tabLock.release()`; `pageshow` with `persisted` reloads. When another tab takes over (or `saveStale` fires) the tab stops its loop and autosave, sets `#app.inert` and shows a full-page "Game open in another tab" overlay whose click reloads the page.

---

## 15. Testing and tools

### 15.1 `package.json` and `tools/serve.mjs` (WP1)
```json
{ "name": "six-legs-deep", "private": true, "type": "module",
  "scripts": { "test": "node --test \"tests/**/*.test.js\"", "serve": "node tools/serve.mjs", "sim": "node tools/simulate.mjs",
               "smoke": "node tools/smoke.mjs", "check:imports": "node tools/check-imports.mjs" } }
```
Integration tools: `tools/smoke.mjs` (headless 40-minute play through `game.actions` with no DOM: no exceptions, no NaN, a dt = 0 derive pass changes no simulation state, export → import round trip, a 1 h catch-up, growth checks; exit 1 on failure; `--export <file>` writes the end-of-play save string, which Settings → Import loads in the browser) and `tools/check-imports.mjs` (walks `src/main.js`'s static and dynamic import graph without executing it: every file exists, every named import and every `ns.member` is exported).
(`node --test` with no arguments also discovers `tests/**/*.test.js`. Passing a bare directory does **not** work on Node 24.)

`tools/serve.mjs`: `node:http` + `node:fs` + `node:path` only; serves the project root; port from `--port` or `PORT`, default **8080**; `/` → `index.html`; MIME map (`.html text/html`, `.js`/`.mjs text/javascript`, `.css text/css`, `.json application/json`, `.svg image/svg+xml`, `.png image/png`, `.txt text/plain`, `.ico image/x-icon`; all text types `; charset=utf-8`); `Cache-Control: no-store`; rejects paths that resolve outside the root (403); 404 otherwise; prints `Six Legs Deep → http://localhost:8080`.

### 15.2 Test conventions
- `node:test` + `node:assert/strict`. One `tests/<prefix>.<topic>.test.js` file per topic; prefixes per §2.
- Unit tests import the module under test directly, build state with `createState()` (the skeleton world, §4) and hand-fill the upstream `d` subtrees they need (`createDerived()` gives neutral defaults). No DOM, no network, no real timers. Render tests run the real renderers and input controllers headless on a fake 2D context injected through `render/canvas.js` `setCanvasFactory` (`render.renderers`, `render.camera`) besides the pure helpers (`render.geom`, `render.sprites`, `render.art`: geometry, sprite pools, cameras, chamber outlines); UI tests cover the pure modules (`ui/format.js`, `ui/text.js`, `ui/rules.js`, `hud`/`intro` helpers) and mount the whole shell on a minimal in-file fake DOM (`ui.dom`). Core runtime tests inject fake storage, clocks and channels (`core.runtime`, `core.tablock`).
- `tests/helpers.js` (WP1): `newState(seed = 1)`, `makeDerived(overrides)`, `fakeEnv({ offline, eff, econScale, dt })`, `stepFor(s, d, seconds, { dt = 0.1, commands = {} })` (commands keyed by tick index; uses the real `step`), `snapshot(s)` (JSON deep copy), `makeFakeStorage(initial, failOn)`, `findBadValues(state)`, `quietWorld(s)` (C56), `livePopulation(s)`, and the contract/fuzz tables (`DOC_UNLOCK_KEYS`, `DOC_IDS`, `COMMAND_ARGS`, `randomCommand`, `allUnlockKeys`, `LIVE_IDS`).

### 15.3 Required tests (DESIGN §28.1 mapped to owners)
| # | Invariant | Owner |
|---|---|---|
| 1 | Cost curves strictly increasing; > 1e280 → `null` (MAX) | WP1 (`geoCost`), WP2 (adaptations), WP3 (chambers), WP7 (traits) |
| 2 | `sc()` continuous and monotonic at thresholds | WP1 |
| 3 | `E(N)` matches the DESIGN §5.2 table (`E(200) = 111.8`) | WP2 |
| 4 | New game hatches the first worker within 15–30 s with zero input | WP2 (unit, skeleton + hand-filled d), WP1 (integration, full step) |
| 5 | Prestige thresholds (`f_run` 1e8 → 10 alates, the formula anchor; 5,000 → 3 kinship; 1,000 → 20 genes, the Speciation gate) and the worked examples ±1 | WP7 |
| 6 | Lanchester: stepped vs closed form within 5 % (homogeneous) / 10 % (mixed); preview deterministic, `s.rng` untouched | WP5 |
| 7 | Offline vs online within 2 % (1 h, events off, eff 1) | WP1 integration |
| 8 | Save round-trip deep-equal; each migration has a fixture; corrupted checksum rejected; RLE round-trip | WP1 |
| 9 | Fuzz: random ticks + commands from extreme states → no NaN/Infinity, nothing > 1e295 (1e5 iterations by default, 1e6 with `FUZZ=full`) | WP1 integration |
| 10 | Hex distance, spiral index, A* costs (WP1/WP4); nest BFS/A* fixtures (WP3) | WP1, WP3, WP4 |
| 11 | Trail yield matches DESIGN §8.5 worked example (5.48 food/s); saturation continuous at `c` | WP4 |
| 12 | Determinism: same seed + command stream → deep-equal state | WP1 integration |
| 13 | `prestige_contractive` (local exponent < 1 at 3 sample points per layer) | WP7 (meta-model) |
| 14 | Reveal queue: no two queued reveals within 30 s | WP6 |
| 15 | Death policy: no adult/brood deaths offline; no starvation deaths with `harsh_nature` off | WP1 integration, WP2 unit |
| 16 | Every handler: validate rejects bad input with the documented code; apply mutates only owned fields | each package |
| 17 | Contract test: every export named in §7–§8 exists with the right arity; registry has no duplicate types; data integrity (every `*_ORDER` matches its table; every `unlock` key referenced in data exists in `UNLOCKS`; research prerequisites exist; ids unique per namespace) | WP1 (`tests/integration.contract.test.js`) |

### 15.4 Headless pacing bot (`tools/simulate.mjs`, WP7)
```
node tools/simulate.mjs [--hours 2] [--seed 1] [--dt 0.1] [--until flight|supercolony|speciation] [--strict] [--json] [--quiet]
```
- Uses `createGame({ nowMs: 0, storage: null })`, `game.newGame(0, seed)`, `game.actions` and system **[q]** queries only (exactly like a player), and acts only on **revealed** features (`unlocks.isRevealed`; e.g. no research before `panel_research` is revealed). `game.runFor` in steps of `--dt` (0.1 default; 1.0 allowed for multi-hour runs).
- **Bot policy** (DESIGN §28.2, which reproduces the Balance Verification bot): clicks the crumb 4/s for the first 10 min of run 1 and the first 3 min of later runs, then 1/s (respecting the cap); buys greedily by value per second of income (research cheapest-first, rushing `nuptial_preparation` and its prerequisites once `fRun ≥ FLIGHT.tabFRun` (2e7)); keeps housing/slots/storage ahead using `nest.findPlacement` + `placeChamber` and `levelChamber`; assigns jobs by a fixed ratio table, shifting diggers toward the binding resource (then auto jobs when unlocked); retires soldiers (`retireAdults`) when berths are full and supermajors are unlocked; draws trails with `trails.bestTargets`; claims hexes when pheromone allows; raids/assaults rivals when `rivals.previewAction` gives `youAP ≥ 1.35 × foeAP`; default event choices; rears alates when possible; flies at the alates/min peak **only once** the projection is ≥ 50 % of `alatesCycle` and the run is ≥ 8 min old; picks landing option 0 and the first boon; trait priority list; merges as soon as the Old Ridge has fallen and projected kinship ≥ 30 % of `kinshipLife`.
- **Output:** a milestone table (time, value) for: first worker, first Gallery placed/built, Granary, Nursery, first insight, first research, Scent Library, 100/500/1,000 adults, `f_run` 2e7 (Prestige tab) / 1.4e8 (Flight gate), Royal L5, `nuptial_preparation`, first conquest, Flight available, alates projected at 90 min, first Flight, first Supercolony, first Speciation; plus the largest gap between unlocks in the first 30 min and the longest no-purchase window in run 1.
- `--strict` exits with code 1 if any DESIGN §28.2 check fails (bot-time windows): first worker 15–30 s; no gap > 3 min between unlocks, reveals or event cards in the first 30 min; no window > 10 min without a purchase or unlock in run 1; first conquest 12–35 min; Flight available 38–60 min; ≥ 25 alates projected at 90 min; first Supercolony 4.5–10 h; first Speciation 24–80 h (when simulated); every boss beaten inside its layer window (when simulated). The meta-model checks (`prestige_contractive`, census 2e16 within 6–10 weeks) run in `tools/meta-model.mjs` and its test. `--json` prints the report as JSON.

### 15.5 Meta-model (`tools/meta-model.mjs`, WP7)
Analytic layer model (per DESIGN §16 and §24.3): exports `layerGain(layer, input)` functions built from the **same data tables** and formulas as `prestige.js` (import them; do not copy numbers), a `prestigeContractive()` check (double each layer's input at 3 points, assert gain ratio < 2) and a `twentyQuadrillionWeeks()` estimate checked against `ENDING_WEEKS` (6–10 weeks, DESIGN §15.7). The colony_scale bought in the Federation and Genome (`shopScale`) feeds `f_run`, and layers 2 and 3 spend their input currency on those shops, so the stability check sees the census engine (C89). CLI prints both. `tests/meta.contractive.test.js` imports it.

---

## 16. Work packages

All packages start at the same time from this document. Each package: owns exactly the files listed (§2), codes against the interfaces here, ships unit tests for its own modules, and leaves `// ARCH-Q:` comments for anything this document did not settle. **No package edits another package's file.** If a package needs a helper that another package owns and it is not in this document, it implements a private local helper instead.

### WP1 — Core runtime, state and data contract
- **Files:** `src/core/*` (all 18), `src/data/balance.js`, `package.json`, `tools/serve.mjs`, `tests/helpers.js`, `tests/fixtures/*`, `tests/core.*.test.js`, `tests/integration.*.test.js`.
- **Builds:** state schema and factories exactly per §4 (including the skeleton world), derived skeleton per §5, `step()` order per §7.2, game loop/catch-up/save/load/import/export per §7.1, command registry + actions + bus, effects, wallet, rng, math, hex, guard, save codec, migrations, offline. Core command handlers `setSetting`, `uiFlag`, `equipCosmetic`.
- **Depends on:** only the system exports named in §7.2, §7.4 and §7.15 (imported by name; integration resolves them).
- **Acceptance:** all `core.*` tests pass standalone (rng golden values for seed 1; hex spiral fixtures incl. ring 1 order and counts 217/469/817; `sc` continuity; `geoCost` MAX; wallet grant overflow and f_run; effects matching and expiry; save round-trip + checksum rejection + RLE; `offlineSchedule(86400)` has ≤ 1,500 steps summing to 86,400; `game.advance` with an injected fake `stepFn` runs the right tick counts, drains the queue on the first tick, routes ≥ 60 s gaps to `catchUp`; registry duplicate detection). `createState()` passes `JSON.parse(JSON.stringify(s))` deep-equality. Integration tests (#4, #7, #9, #12, #15, #17) are written now and must pass after integration. `tools/serve.mjs` serves `index.html` and `.js` with the correct MIME type.

### WP2 — Colony economy
- **Files:** `src/systems/{stats,economy,population,jobs,adaptations,bottleneck}.js`, `src/data/{castes,jobs,economy,adaptations}.js`, `tests/colony.*.test.js`.
- **Builds:** §8.1 in full: multiplier stacks, caps, lay rate, egg cost, brood cohorts and allocation, frost freezing/deaths, Hungry, upkeep, nutrition, fungus, pheromone, softcaps, clicks, jobs and automation, Adaptations, bottleneck badge.
- **Depends on:** WP1 core (state, wallet, effects, math, rng); `d.season`, `d.meta`, `d.nest.agg`, `d.surface.ownedCount`, `d.ledger` contents (§5); `s.run.surface.entrances/mound` (read).
- **Acceptance:** E(N) table; first worker hatches at 15–30 s from `createState()` with a neutral `d` (spring season mods, royal brood group cap 3) and no input; laying respects slots/housing/reserve/berths; egg reserve; nanitics; caste choice by largest deficit; hungry enter/exit; upkeep winter reductions; overflow rule (food above cap gains nothing from production, f_run still counts); softcap pro-rata; territory bonus `min(1, 0.005 × ownedCount)`; gardener slots scale with `colonyScale`; "larvae eat first" (with fungus for exactly one supermajor egg and a large Nutrition demand, the egg is laid and φ uses only the remainder); `retireAdults` respects garrison and housing; handler validation codes; offline `dt = 60` produces no deaths and lays in one batch.

### WP3 — Underground nest
- **Files:** `src/systems/{nest,nestgeom,nestgen}.js`, `src/data/{strata,chambers,soilFeatures}.js`, `tests/nest.*.test.js`.
- **Builds:** §8.2 in full: derive (geometry caches gated on `rev`, exposure, `eff`, all `agg` fields), dig queue and work, placement validation with ghost tints/mods/auto-route, enlarge with direction, relocate, demolish, tunnels, backfill, caches/hints/water, nuptial and satellite shafts, blueprints, generation, the `moleTunnel` cross-call.
- **Depends on:** WP1 core; `d.season.frostRow/snapRow/id`; `d.stats.digW`; `d.rates` (cache rewards via `wallet.incomeSeconds`); `surface.addEntrance`, `surface.nuptialHex` (WP4); `golden.spawnBeetle` (WP6); `effects` stats `chamber`, `chamber_layer`.
- **Acceptance:** footprint growth matches DESIGN (3×2 Gallery → 10×4 at L8); cell work per layer incl. modifiers; haul example (`h = 0.83` at start; 0.49 with a capacity-330 granary at path 8); frost exposure by majority rule; adjacency (touching or ≤ 4 open cells); raid reach 15; BFS/A* fixtures; a placed Gallery activates exactly when its last cell is dug; queue limit; blocked level-up reported; backfill disconnection refused; generation deterministic per seed and never overlapping.

### WP4 — Surface map, trails and territory
- **Files:** `src/systems/{mapgen,surface,trails}.js`, `src/data/{surface,sources}.js`, `tests/surface.*.test.js`.
- **Builds:** §8.3 in full: map generation, fog/scouting, sources lifecycle and spawning, territory/claims/channels/borders, mound, entrances, trail routing/strength/allocation/yield, pheromone abilities.
- **Depends on:** WP1 core (hex, effects, wallet); `d.stats.forage/honeydew/leaves/chitin/insight`, `d.nest.agg.haulH`, `d.season`, `d.combat.garrison`; `rivals.rivalLand` (WP5); `population.killAdults` (WP2).
- **Acceptance:** worked example 10 foragers, seed patch d = 3, h = 0.5 → 5.48 food/s before multipliers; scout force `scouts^0.6` and 0.5 × ring insight per hex; seed-patch max follows current gross food/s every tick; lycaenid pays only with ≥ 5 escorts; saturation continuous at c; `r(d) × eff(d)` table of DESIGN §8.5 reproduced for D_nav 3 and 9; strength approaches `S_eq` with the right half-life; claim cost sequence (10 → 18 → 57 → 184 → 1,059); scouting cost table (10, 37, 69, 121, 197); mapgen deterministic, all sources reachable, shares within ±3 %; slot accounting; offline equilibrium strength.

### WP5 — Rivals, combat, raids and research
- **Files:** `src/systems/{combat,rivals,raids,research}.js`, `src/data/{rivals,combat,research}.js`, `tests/war.*.test.js`, `tests/research.*.test.js`.
- **Builds:** §8.4 in full: AP, stepped battles + closed-form previews, war parties, raid/assault/hunt/termite/bribe/tournament, conquest and outposts, rival growth/creep/respawn, bosses (Old Ridge, Argentine Front, army-ant battle support), two-view raids on the player, research purchase/refinements/innate grant.
- **Depends on:** WP1 core; `d.stats.atk/hp/ap`, `d.nest.agg.gateL/barracksNear/reachStorageShare`, `d.surface.ownedCount`; `population.killAdults/addAdults/killBrood/stealBrood` (WP2); `surface.conquerHexes/grantHex/touch/addEntrance/spawnSource` and `trails.hitTrail` (WP4); `d.surface.trails[].safe`.
- **Acceptance:** DESIGN §9.5 worked example (17 soldiers vs Black Garden Ants assault → s ≈ 0.56, 9–10 survive; raid s ≈ 0.96); stepped vs closed form within 5 % / 10 %; preview leaves `s.rng` unchanged; rival ladder base AP values; elder AP formula; raid eligibility and warning duration; raids never target a `safe` trail; boss AP (Old Ridge `1e6 × (1+m)^1.5`: 1e6 at m = 0, ≈ 9.62e7 at m = 20; Front `1e8 × 10^s`; army column `43,000 × (1+m)^1.5`); theft formula with the 2 % floor; research prerequisites and refinement cost; no raids/battles offline.

### WP6 — Seasons, events, achievements, field guide and unlocks
- **Files:** `src/systems/{seasons,events,golden,achievements,fieldguide,unlocks}.js`, `src/data/{seasons,events,achievements,fieldGuide,unlocks}.js`, `tests/world.*.test.js`.
- **Builds:** §8.5 in full: season clock and frost line, all 28 events with pity rules and cards, Golden Beetle/Pupa, Saved Finds gifts, 81 achievements with progress, 40 field-guide entries (notes written in-house), the unlock/reveal system and next-unlock ribbon.
- **Depends on:** WP1 core; the [x] calls listed in §8.5 into WP2, WP3 (`nest.moleTunnel`), WP4, WP5; `combat.armyAP`; all state/derived fields (read).
- **Acceptance:** first winter starts at 18:00; year-0 winter mild (frost to row 10, no deaths); frost descends over 90 s and retreats over 60 s; long-summer order; no events in the first 6:00 of the first run and the scripted fruit at 8:00; first 3 events positive; ≤ 1 negative in any 3; no events offline; card default on timeout; reveal spacing ≥ 30 s; every achievement and field-guide id from DESIGN present with a check; `nextGoals` returns the 3 closest.

### WP7 — Prestige layers, meta-progression and pacing tools
- **Files:** `src/systems/{prestige,traits,hardships,automation}.js`, `src/data/{prestige,bloodline,federation,genome}.js`, `tools/simulate.mjs`, `tools/meta-model.mjs`, `tests/meta.*.test.js`.
- **Builds:** §8.6 in full: `d.meta`, projections and requirements, Flight/landing/boons, Supercolony/edicts/heirlooms, Speciation/species, Bloodline/Federation/Genome purchases, hardships, automation (autobuyers, auto-flight, auto-supercolony, diapause toggle), satellites, strata records, ending; `startRun`/`newGame`; the pacing bot and meta-model.
- **Depends on:** WP1 core; `mapgen.generateMap`, `trails.autoDraw/createTrail`, `surface.addEntrance/autoMoundStep` (WP4); `nestgen.generateNest`, `nest.applyBlueprint/queueShaft/autoLevelStep` (WP3); `rivals.spawnInitial` (WP5); `research.grantInnate` (WP5); `unlocks.onRunStart`, `seasons.setSeason/addExtraSpring` (WP6); `population.addAdults`, `adaptations.autobuyStep` (WP2).
- **Acceptance:** alates table of DESIGN §13.2 (10 / 24 / 40 / 48 / 770 / 28,795 ±1; the last row is just under the 3e4 softcap), Lineage table (§13.3: 2.5 / 6 / 18.97 / 189.7), hardship goals (1e9 … 1e17), kinship table (§14.2), genes table (§15.2), passives tables (§14.3, §15.3); flight resets exactly the `run` subtree and keeps the rest; supercolony keeps heirlooms; speciation honours `genetic_memory`/`eusocial_leap`; innate after 3 runs (2 with `ancestral_memory`); trait costs and caps; `prestige_contractive` passes; `simulate.mjs` runs headless after integration and prints the report.

### WP8 — Rendering and canvas input
- **Files:** `src/render/*` (all 17), `tests/render.*.test.js`.
- **Builds:** §13 in full: both renderers, sprites, atlas, particles, overlays, battle bubbles, ceremonies, seam, minimaps, input controllers, hit-testing, DPR/resize/visibility handling.
- **Depends on:** WP1 (`core/hex.js`, game API, bus), state/derived read-only fields (§4, §5), [q] queries (`nest.validatePlacement`, `nestgeom.*`, `trails.previewTrail`), `ui/uistate.js` API and the bridge (§14.2, §14.4).
- **Acceptance:** `render.geom` tests (cell/hex ↔ pixel round-trips at zoom 0.6/1/1.6, polyline distance, Catmull-Rom endpoints); with a hand-built `createState()` game both views render without exceptions in a browser; ≤ 600 sprites; picking returns the documented Target kinds; resizing and DPR changes keep picking accurate; no writes to `s` (code review: only `game.actions`, `setUI`, bridge).

### WP9 — UI shell, panels and boot
- **Files:** `index.html`, `styles/{base,panels}.css`, `src/main.js`, `src/ui/*` (all files incl. `panels/`), `tests/ui.*.test.js`.
- **Builds:** §14 in full: layout and breakpoints, rail/HUD/flow strip, tabs and panels, reveal-on-unlock, tooltips, toasts, event card, modals (prestige, landing chooser, reset, import, ending), welcome back, onboarding, settings with export/import/reset, keyboard shortcuts, boot and autosave.
- **Depends on:** WP1 game API/actions/bus; all [q] queries (§8); state/derived fields; `render/*` public API (§13.3) and `render/minimap.drawMiniMap`, `render/ceremony.playCeremony`.
- **Acceptance:** `ui.format` tests (every row of DESIGN §26 incl. `1.23K`, `45.6M`, `1.00Dc`, `1.23e45`, `−3.2/s`, `×1.25`, `+2.5%`, `4m 05s`, MAX, `—` for NaN); panels hidden until their keys reveal; toasts rate limit; the page works at 375 px width with no horizontal page scroll; export → import round-trip through the Settings UI; hard reset requires typing `abandon`.

---

## 17. Integration step (INT)

1. **Collect and audit.** Gather all packages. Verify file ownership: no file outside a package's list, no file edited by two packages. List every `// ARCH-Q:` comment and resolve each one (update this document if the contract changes).
2. **Unit tests per package.** `node --test "tests/<prefix>.*.test.js"` for each prefix. Fix failures inside the owning files.
3. **Contract test.** `node --test tests/integration.contract.test.js`: every documented export exists, the registry builds with no duplicate command types, data integrity holds. Fix mismatched names/arity at the provider (the contract wins).
4. **Full suite.** `npm test` (all unit + integration tests: first worker 15–30 s through the real `step`, determinism, offline vs online ≤ 2 %, fuzz, save round-trip after 10 simulated minutes, death policy), then once with `FUZZ=full` (1e6 fuzz ticks, C46). Then `npm run smoke` (headless 40-minute play, §15.1) and `npm run check:imports` (static import graph from `src/main.js`).
5. **Pacing.** `node tools/simulate.mjs --until flight --strict`, then `--hours 12 --dt 1 --until supercolony`. Tune **only `src/data/*.js`** numbers (DESIGN §28.3 levers) until §15.4 checks pass; record changed numbers back into DESIGN.md (DESIGN rule: code and document never diverge).
6. **Browser smoke test.** `npm run serve` → `http://localhost:8080`. Checklist: crumb click gives food; first nanitic at ~0:15; digger and Soil appear; Gallery ghost tints and digs; Below expands at the first housing cap; trail drag works; research opens; hidden-tab return shows catch-up; reload resumes with offline progress (hidden time included, C78); a second tab takes the game over and the first shows "Game open in another tab" (C80); export/import round-trip; layouts at 1440×900, 1280×720, 1024×768, 375×812; no console errors over a 10-minute session.
7. **Finish.** Write `README.md` (requirements: Node ≥ 22 and a modern browser; `npm run serve`, `npm test`, `npm run sim`; folder map pointing to this document).

---

## 18. Design clarifications (pinned readings of DESIGN.md)

| # | Topic | Decision |
|---|---|---|
| C1 | `f_run` and the food cap | `f_run` counts all gross food produced (after softcap, before upkeep), even while storage is full. Wasted production is tracked separately (`foodWasted`) for the welcome-back nudge. |
| C2 | Seasonal leaves/honeydew | Applied once, through the per-source `season` table (`leaf_plant`, `aphid_colony`, `flower_patch`). There is no extra global leaves/honeydew season multiplier. Root Aphid Pens use `fx.winter` 0.5. |
| C3 | "Winter penalties −X % relative" (`seasonal_clock`, `seasonal_wisdom`, `eternal_winter`) | Implemented only as R terms of the winter forage penalty (DESIGN §12.1). |
| C4 | Brood speed and frost | `B_speed` is brood-weighted over the actual allocation (slot-weighted when there is no brood). Nursery slot capacity is never halved by frost; frost works by freezing brood. |
| C5 | Hungry "all output ×0.75" | Applies to forage, dig, honeydew, leaves, fungus, chitin and insight. |
| C6 | Starting a Hardship | A variant of the Flight: Flight requirements apply, alates are awarded, and the next run carries the constraint. |
| C7 | `ev_termite_swarm` | Spawns a temporary `termite_swarm` source (5 food + 0.05 chitin per worker, cap 30, 45 s), which Mass Recruit can target. |
| C8 | Satellites | Functional (entrance, trail origin, slot, auto-claim) as soon as placed; the satellite shaft is dug afterwards as a queued job. |
| C9 | Event pity | `'choice'` and `'mix'` events never count as negative. |
| C10 | Command latency | Commands apply at the start of the next 10 Hz tick (≤ 100 ms), for determinism. |
| C11 | Import | No offline credit for the time since the imported save was made. |
| C12 | Season clock offline | Advances by the full real gap, including time beyond the offline cap. |
| C13 | Nuptial-entrance trails | Use the main nest haul `h`; satellite and outpost trails use 0.5. |
| C14 | Secondary yields (flower honeydew, insect chitin) | Use the same trail base × location as the primary yield, with their own channel multiplier. |
| C15 | Root Aphid Pen passive | Added raw (DESIGN §12.7 lists it outside the multiplier product). |
| C16 | Click cap | 15 clicks per integer second of `run.time`; every click type shares the cap. |
| C17 | Raiders | Taken from the rival's soldiers at raid start; survivors return. |
| C18 | Blocked laying | While laying is blocked, `layAcc` is clamped to `max(1, λ)` (no egg burst after a long block). |
| C19 | Fungal Brood when fungus runs out | The toggle switches itself off (and emits nothing special). |
| C20 | Groom Brood | Each click adds 1 % progress to every cohort, scaled by that nursery's share of total brood capacity. |
| C21 | Tournament win | The hex becomes `claimed` and is added to `rival.lost`. |
| C22 | Species `foodCap` | Multiplies the whole food cap. |
| C23 | "Adults" | `minor + soldier + supermajor + replete`. Egg-cost `N` also counts reared alates and brood. |
| C24 | Housing constraint | Laying needs `minors + brood < housing` (DESIGN §5.1); soldiers and supermajors use berths, repletes replete berths. |
| C25 | Persistent soft unlocks | Tutorial-threshold unlocks (§11, `persist`) are granted from the start of every later run once seen; research-gated keys follow research. |
| C26 | Golden pupa | Rolled by `golden.js` from `eggLaid` events; not a brood cohort. |
| C27 | Old Ridge / Front gating | Spawned by WP5 from trait/federation conditions directly; no unlock key. |
| C28 | Boss stats | Boss soldier count = AP ÷ √(ATK × HP) using the `BOSSES` atk/hp values. |
| C29 | Rival land changes | Fire-ant creep and tournaments edit `rival.extra` / `rival.lost`; rival land = disc ∪ extra − lost. |
| C30 | Ventilation and libraries | The ×1.10 is applied once, inside the chamber `eff` (DESIGN lists it both as a chamber effect and in insight M_run). |
| C31 | Prestige tab reveal | `fRun ≥ 1e7` **or** `nuptial_preparation` owned, whichever comes first (DESIGN §13.1 now says "researched"; "visible" was ambiguous because locked research nodes are always shown greyed). |
| C32 | `claustral_founding` "no clicking" | Refused with `'hardship'`: every click that yields resources, work or progress (`clickForage`, `helpDig`, `groomBrood`, `clickBeetle`, `clickPupa`, `openGift`, `clickEventObject` on rival alates or the golden aphid). Still allowed: counterplay clicks against negative events (`scrapeMold`, `bailFlood`, `cleanBlight`, ladybug and footstep objects) and `clickQueen`. Each owner checks `s.run.hardship` in `validate`. |
| C33 | `ach_seed_bank` "a gravel Granary 100 % full" | Food is one pooled store, so the condition is `food ≥ foodCap` while at least one active Granary is in the gravel layer. |
| C34 | Finite stock sizing ("at discovery") | `max = max(base, sec × d.rates.food.gross)` is computed when the source first becomes visible: at spawn if its hex is already revealed, otherwise on the tick its hex is revealed (until then `data.unsized = true`, `stock = max = 0`, and it cannot be targeted). `seed_patch` (`stock.dynamic`) instead re-evaluates `max` every tick (DESIGN §8.4). |
| C35 | Lycaenid caterpillar | `r` in "0.3·r honeydew/s" is the source hex's ring (as for prey and the termite mound). It is milked by a trail with `job 'lycaenid'` (uses a slot, carries no workers) that pays `0.3 × ring × d.stats.honeydew` while it has ≥ 5 escorts. |
| C36 | "Send soldiers" remedies | `ev_ladybug_raid`, `ev_antlion_pit` and `ev_horned_lizard` show a card; `eventChoice 'send'` / `'mob'` checks the garrison (`d.combat.garrison`, `combat.armyAP`) and resolves instantly with no losses. Timeout applies the default (`'wait'` / `'reroute'`). |
| C37 | Retire to workers (DESIGN §6.1, added after the balance pass) | `retireAdults {caste, n}` turns garrison soldiers or supermajors into minors, limited by free housing; no refund. It frees berths for supermajors. |
| C38 | `edict_of_long_summer` "autumn bonuses off" | During that autumn: food cap ×1 (not 1.25) and every source season factor is 1 (no seed ×2, no prey ×1.5): `d.season.srcId = 'neutral'`. |
| C39 | `automated_brood` "caste presets" | The caste-slider targets and job targets the player last set carry into every new run (`meta.automation.keep`); `automaton_instincts` carries the job targets only. |
| C40 | Army Ant Column AP and loot | AP `43,000 × (1 + m)^1.5` (DESIGN §9.3 and §18.2, changed from `× 10^m`, which passes 1e300 after ~290 merges and outgrows every polynomial player curve). Loot on a win: 1,800 s of food + `max(2,000, 600 s)` chitin (§18.2 wording; §9.3 now matches). |
| C41 | Auto-claimed territory | Radius `1 + floor(mound / 5)` around every entrance kind, outposts and satellites included (DESIGN §8.6 is the general rule; §8.8's "radius 1" is the value below Mound L5). |
| C42 | Boss spawning | Each boss spawns at most once per run (at run start if its condition already holds); a conquered boss does not return that run. Front nests that regrow after the 10-minute window are the same rivals restored, not a new spawn. |
| C43 | Founding Stores | Written directly into `run.res` at run start, so food may exceed the cap until spent (production adds nothing while above it). Not counted in `fRun`. |
| C44 | Innate research run counts | Incremented at every run end: Flight, Hardship start, Supercolony and Speciation (before the reset; Speciation keeps them only with `genetic_memory`). |
| C45 | Prey rewards by season | Hunt rewards are × the prey's `season` factor (autumn 1.5, DESIGN §17.2), with `srcId` (C38). |
| C46 | Fuzz size | DESIGN §28.1 #9's 1e6 ticks run with `FUZZ=full` (CI and integration step 4); the default `npm test` uses 1e5 for speed. |
| C47 | Rival territory radius | The per-rival `radius` of the DESIGN §9.2 table (`RIVALS[id].radius`, elder 3); bosses 3, including each Argentine Front nest. DESIGN §8.6's old `1 + ceil(tier/2)` formula is withdrawn. |
| C48 | Event payload sub-types (integration) | `chamberActivated.chamberType`, `sourceSpawned.sourceType`, `rivalSighted.rivalType`, `conquest.rivalType`. A payload key named `type` is overwritten by `env.emit` (v1.0 of §10 had `type`). |
| C49 | Extra events and payload keys | §10 lists `trailRerouted`, `tournamentStart` / `tournamentEnd` and the extra payload keys emitters add; consumers ignore unknown keys. Events raised without an `env` are emitted on the owner's next tick (at most one tick late). |
| C50 | Season mods within a step | For `dt > 0`, `d.season.mods` describe the clock interval the step covered (time-weighted across a boundary; booleans follow the season that covered most of the step); `id`, `srcId`, frost and forecast describe the clock after the step. The clock snaps onto a boundary within 1e-7 s, so `seasonAt` and the offline season count `year × 4 + floor(t / len)` agree. (This is what makes the offline-vs-online invariant hold when a horizon ends on a boundary.) |
| C51 | Derive passes | A `dt = 0` step (newGame, load, import, catch-up rebuild, all on a fresh `d`) changes no simulation state: nothing is laid, developed, killed, produced or spent; Hungry does not toggle; the dynamic seed-patch max is not re-evaluated (the fresh `d` has no food rate yet). Only unlock/reveal bookkeeping whose conditions already hold, and the scout target, may advance. The 0:00 egg is laid on the first real tick. `tools/smoke.mjs` asserts this every simulated minute. |
| C52 | Food integration and brood | `economy.tick` integrates food exactly over each step (the "fill to cap, then subtract the step's upkeep" order left food 30 below the cap after every 60 s offline step). The frost penalty on development is applied once (frozen brood contributes 0 to `bSpeed`; no extra `(1 − frozenShare)` factor). A cohort laid in the current integer second develops for half the step. A lay batch may split into at most one sub-batch per caste. |
| C53 | Run start | `startRun(s, d, { …, env })` emits `runStarted` only when `env` is given (`newGame` passes none; core/game.js publishes `reset`) and resets the run-scoped `d` subtrees (`ledger`, `nest`, `surface`, `stats`, `rates`, `combat`, `progress`) to `createDerived()` defaults, keeping `season`, `meta` and `offlineLog`; otherwise a new run's `rev = 1` can match the cached rev and geometry never rebuilds. |
| C54 | Brood bank | `PendingChoice.carryAdults` (§4.1) carries the brood_bank adults from the flight to `chooseLanding`; they return as minors. Flights and Hardship starts only. |
| C55 | Bosses fallen | A boss counts as beaten when its rival has `fallenAt ≥ 0` and `alive === false` (conquered rivals stay in the list; non-boss ones as compact records, C77). Argentine Front nests are pending until all 3 fall within the window (the window pauses offline); a regrown nest is the same rival with `alive = true`. Bosses get an equivalent elder tier for rewards and the nest-raid rule, never grow, never change `topTier` and queue no respawn. |
| C56 | `no_raids` effect | Peaceful Start (and the test helper `quietWorld`) add an effect whose id **and** stat are `no_raids`; WP5 honours either. |
| C57 | Unlock reveals | Flag children (`adapt_basic`, `chamber_gallery`) unlock with their parent but reveal only after it. Always-on tabs do not set `reveal.lastAt`. Keys already in `meta.seen` are granted without a second reveal. Condition extension `{ achievements: n }` (`panel_achievements`). `eggsBlockPurchase` = an unlocked food purchase costs more than stored food but less than stored food plus the egg food of the last ~30 s. The next-unlock ribbon's `{ adults: n }` ETA uses rate 0 (the HUD then shows a percentage) while housing blocks laying or the colony is Hungry. Non-queued reveals also set `lastAt` (DESIGN §28.1 #14: no two reveals within 30 s). |
| C58 | Onboarding glow keys | Shared WP8/WP9 vocabulary for `ui.glow`: `tab:<tabId>`, `job:<jobId>`, `build:<chamber>`, `adapt:<id>`, `research:<id>`, `res:<res>`, `badge`, `canvas:crumb`, `canvas:bestSource`, `canvas:royal`, `canvas:digFace`. The chamber ghost demo is `{ kind: 'chamber', from: <chamber type>, to: <cell> }`. |
| C59 | Pacing bot reveals | `tools/simulate.mjs` acts only on revealed keys (§15.4). Acting on gameplay availability let it buy research at 0:00 (the field guide pays 20 insight at start) and reshuffle the reveal queue. |
| C60 | Placement advisor growth room (integration) | `nest.findPlacement` (onboarding glow, bot, smoke player) avoids the first free L8 growth envelope of each existing chamber (the Royal Chamber's centred one first; Royal L5 is a Flight requirement) and prefers spots whose own L8 envelope fits. Both are soft penalties below the adjacency bonus. Before integration it packed chambers so tightly that Gallery and Royal level-ups were blocked in every direction (the smoke player's colony stalled at 362 adults with 4 boxed-in Galleries; with the fix it reached about 1,000 at 40 min at integration). Current figure after the later balance passes and bug-hunt fixes: `npm run smoke` (seed 1, 40 min) ends at about 740 adults, 5.4e7 `f_run` and 13 chambers (721 adults after the polish round); the smoke check itself requires only > 50 adults, `f_run` growing every 10 minutes and the core chambers completed. |
| C61 | Golden Beetle in later runs (integration) | When `golden_beetle` is already granted at 0:00 (run index ≥ 1, C25), the first beetle is armed with a normal `U(beetleMin, beetleMax)` draw instead of spawning at 0:00. Run 1 keeps the immediate beetle at the 5:00 unlock. |
| C62 | Schema defaults from data (integration) | `core/state.js` reads the schema defaults that are balance numbers from their data tables (`MAP.radiusBase`, `MAP.revealStart`, `EGG.nanitics`, the dead-insect and prey spawn intervals, `EVENT_RULES.scriptedFruitAt`, `YEAR.lengthSec`); their values are unchanged. |
| C63 | Reveal queue order (browser integration) | `meta.reveal.queue` is kept in schedule (UNLOCKS) order: a key that unlocks while a backlog waits is inserted before later-scheduled keys, so core reveals (Scouts, trail slots, Research) are no longer stuck behind minor ones (Egg reserve, Achievements, Mound) that happened to unlock first. The 30 s spacing is unchanged. `egg_reserve` also needs `panel_build` unlocked (DESIGN §23 places it at ~2–4 min; it was revealing at ~0:45 and pushing Diggers back), and `panel_map` needs `trail_slots` unlocked (a trail dragged before the tutorial reached trails was taking the 0:15 slot from the Colony panel). Fresh-save reveal times: Colony 0:15, Diggers 0:45, Build 1:15, Granary 1:45, Nursery 2:15, Egg reserve 2:45. |
| C64 | Royal Chamber growth room (browser integration) | `nest.blocksRoyalGrowth(s, rect, relUid?)` ([q], extra export): true when every footprint of the Royal Chamber at `FLIGHT.royalLevel` that contains the current Royal Chamber and is free of other chambers would overlap `rect`. `validatePlacement` then adds the ghost modifier `{ key: 'royalRoom', value: true }` (amber tint, label "Boxes in the Royal Chamber (Flight needs L5)"); placement stays legal. `findPlacement` ranks such spots below every other spot (+3 × its BIG penalty), and `levelChamber` without `dir` picks the first valid direction that does not box the Royal Chamber in. Reason: the Nursery and Scent Library adjacency bonuses invite players (and the smoke player) to box the queen in at L4, and Royal L5 is a Flight requirement. The room test and the growth rule were tightened by C66. |
| C65 | Toasts and catch-up feedback (browser integration) | A toast's display time starts at the first `frame()` after it is shown, so toasts pushed from inside `game.advance` (for example after a hidden-tab catch-up) no longer expire on the next frame. Toast priority `'top'` shows at once even when the 2-per-10 s window is full (it still counts against it); only the catch-up summary uses it ("Caught up 1m 30s while you were away: +2.9K food."). The Build panel shows "No diggers: this work will not progress" with an Assign diggers button while the dig queue has work and the dig rate is 0. While a placement or relocation tool is active, the cell hover tooltip is suppressed so it does not hide the ghost's label. |
| C66 | Royal Chamber room: no permanent Flight softlock (gameplay fixes) | **Room.** The Royal Chamber's room is the set of `FLIGHT.royalLevel` (L5) footprints it can still grow into: each contains its current rectangle, is reachable by the remaining growth steps (left/up offsets are subset sums of the per-level width/height growth), meets its row rule (row ≥ 20, so it never grows up) and Shallow Soil, and holds no **permanent** obstacle: another chamber, water, an undiggable cell (stone without `acid_excavation`, a locked layer), a shaft cell or the column of a queued shaft. Queued dig cells and pending backfill do not count (they clear). C64 counted footprints starting on row 19 (above the row rule) as free, so a chamber right under the queen, the most common box-in, was never flagged. **Rule:** while the Royal Chamber is below L5 and still has room, nothing may take the last of it without the player being told, and nothing that is not a deliberate placement may take it at all. (1) Placement and relocation stay legal with the amber `royalRoom` ghost warning (DESIGN §7.4); this now also covers extra Royal Chambers, a Nuptial Chamber's exit-shaft column, and relocating the Royal Chamber itself to a spot with no room. Relocation (level kept) undoes a box-in; no demolition is needed. (2) **Growth** of another chamber that would overlap every free L5 footprint is refused: such directions are withheld from `levelInfo.dirs`; `levelChamber` with such a `dir`, or with no `dir` when only such directions are valid, is refused with **`'blocked:royalRoom'`** (UI text: `REASON_DETAILS['blocked:royalRoom']`, shown by the Build inspect panel, C81) (a plain physical block still says `'blocked'`). `levelInfo` gains `royalRoom: true` when a direction was withheld for this reason (with `blocked`, it is the only reason; the UI can say "Would wall in the Royal Chamber: level it to L5 first, or relocate this chamber"). The block is temporary: it lifts once the Royal Chamber reaches L5. (3) The Royal Chamber's **own** growth stays inside a footprint it can still complete (`'blocked:royalRoom'` otherwise); with no `dir` it takes such a direction. (4) The Nuptial exit shaft's default column prefers one that keeps the room; `placeSatellite` refuses a column whose shaft would take it (`'blocked:royalRoom'`, new export `nest.shaftBoxesRoyal(s, d, col)`); `applyBlueprint` skips a chamber that would take it. (5) Once the room is gone (a warned placement), the guard switches off, so it never freezes other chambers. (6) Nest generation keeps boulders and water pockets out of the Royal Chamber's L5 growth zone (columns 14–25, rows 20–22): before, about 1 run in 1,100 (1 in 240 on Stony Ground) started walled in by boulders, which needed the 10,000-insight `acid_excavation`. `blocksRoyalGrowth(s, rect, relUid?, { d?, cells? })` keeps its meaning with the stricter room test. |
| C67 | Shallow Soil and the Nuptial Chamber (gameplay fix) | `shallow_soil` forbids digging below row 23, and the Nuptial Chamber needed row ≥ 24, so a Shallow Soil run could never fly (and a Hardship run ends only with a Flight). In a `shallow_soil` run the Nuptial Chamber's row minimum becomes `23 − h + 1`, where `h` is the height of its largest footprint (its max level, capped at L8): row 20, or 19 with `royal_court`. Its exit shaft and everything else are unchanged. Other deep-only chambers (Fungus Garden, Hibernaculum, Deep Vault) stay unavailable in that run; none is a requirement. |
| C68 | Event harm frozen offline (gameplay fix; DESIGN §3, §18.1, §21.4) | Event processes, objects and cards already waited offline (`events.tick` returns early), but their **effects** kept working: a mold spot halved its chamber for the whole absence (permanent effect), and timed debuffs (sealed entrance, flood, drought, phorid flies, brood mites, parasite queen …) applied and ran down offline. Now `core/step.js` lifts every **harmful event effect** for each offline step (`events.suspendOffline` before `tickEffects`, `events.resumeOffline` after the systems, before the guard): offline they neither apply nor count down, and they are back unchanged on return (mold spots still need scraping and resume spreading). Harmful = an effect created by events.js (ids `ev_…`, `mold:…`) whose multiplier is below 1 (or addend below 0), or above 1 (or addend above 0) on `ap_rival`, `brood_time` and `frost_snap`, where more is worse (`events.isHarmfulEffect`). Helpful event effects keep running offline as before. The derived cache of an offline step therefore shows the unpenalised values; catch-up rebuilds it afterwards. |
| C69 | Founding reserve (gameplay fix) | A queen with no adult and no brood left lays one minor egg from her own reserves when the stored food cannot pay for it (it costs whatever food there is; an egg reserve that only holds affordable food back still blocks, as the player chose it), and a colony with no adults is never Hungry (no upkeep to starve on; Hungry used to set the lay rate to 0 until food came in, which needs a worker). Before, a colony that lost every ant with an empty larder could not recover in a Claustral Founding run, where clicking for food is refused, and that run can end only with a Flight. The rule never triggers while any adult or brood exists (a surviving soldier can be retired to a worker, C37). |
| C70 | Laying at the food cap (gameplay fix F23; DESIGN §3, §5.1, §21.3) | Eggs due in a step may be paid with the food produced **at** the cap during that step. `economy.tick` reports it as `env.foodSpill` (the part of the step's wasted production made while food sat at the cap, not above it; the C52 integration already computes it) and `population.tick` spends it **before** the store, taking what it uses back out of `run.stats.foodWasted`. Before, each step could lay at most `floor((food − reserve) / egg cost)` eggs from the end-of-step store, so a 60 s offline step laid as much as one 0.1 s tick: with a cap holding one or two eggs, offline catch-up laid 60–80 % fewer eggs than online (and online itself was limited to `10 × floor(cap / egg)` eggs/s by the tick length). Now laying matches the continuous-time rule of §5.1 (an egg bought at the cap is refilled at once by production) for any step length, and the store stays full while production pays for the eggs, so purchases are not starved by laying. `env.foodSpill` is a per-step transient (`makeEnv` does not set it; absent = 0). Tested on a cap-bound mid-game fixture (`tests/integration.offlineMid.test.js`). |
| C71 | A slider caste that storage can never pay for (gameplay fix F9/F22; DESIGN §5.1, §5.5) | A caste whose ONE egg costs more food than laying can ever spend — more than `foodCap × (1 − eggReserve)` and more than is spendable this step (store above the reserve + C70 spill) — is skipped like a caste with a full berth: the caste choice falls through to the next slider caste by deficit, then to minors. This applies to soldier, supermajor and replete slider eggs and to requested alates (whose request then waits for a bigger cap). The food part counts the species `eggFungusFrac` share as paid in fungus when enough fungus is stored. Before, the queen chose the slider caste, could not pay it, and stopped laying entirely (minors included) for as long as storage stayed below 5 × E(N) (soldier) or 50 × E(N) (supermajor) — hours in long runs, carried into every run by `automated_brood`. A caste that storage CAN hold but that is not yet affordable still waits for the food (the deficit rule of §5.5 is unchanged). |
| C72 | Bottleneck priority (gameplay fix; DESIGN §2.2) | Priority is now `raid` > `frost` > `hungry` > `bn_housing` > `bn_brood_slots` > `bn_food_cap` > `bn_lay_rate` > `bn_food` (the food cap used to rank above housing and slots). Housing and brood slots block eggs outright, and food then piles up at the cap only as a consequence, so the badge said "Food cap · storage full" while the real limit was "Housing · eggs blocked" (DESIGN §2.2's own example), and the threshold-job nurse shift (§8.1 jobs, keyed on `bn_brood_slots`) never fired while food sat at the cap. `capT` still accumulates underneath. The food cap still outranks the lay rate (both bind when nothing blocks eggs and food sits at the cap; the cap is the one the player relieves with Granaries). |
| C73 | Mobilize draft (gameplay fix F1; DESIGN §9.8) | Mobilize drafts `frac` × idle minors plus `frac` × foragers (the documented "25 % of idle and forager minors"): the foragers are taken out of `jobs.forager` explicitly and the battle records the draft as `b.mob = { n, forager }` (extra Battle field). When the 20 s window ends (`effectEnded mobilize:<uid>`) or the battle ends, `combat.releaseMobilized` returns the survivors: the forager share (`mob.forager × survivors / mob.n`, limited to the minors now idle, since auto jobs may have re-assigned them) goes back to `jobs.forager`; the rest were idle and are idle again. In `endBattle` this happens before the casualties are removed, so the dead come out of the draft (idle first). Before, the draft was a proportional cut of every job (diggers, nurses, scouts … via `jobs.enforce`) and nobody was ever put back, leaving ~18 % of the workforce idle for good in manual mode. |
| C74 | Mold follows its chamber (gameplay fix F8) | A mold spot belongs to its chamber (`data.chamber`). At the start of every online `events.tick` (the same tick as the command, since commands run first) a spot whose chamber no longer exists (demolished) is removed together with its `mold:<uid>` effect, and the outbreak process ends once none of its spots is left. A spot outside its chamber's footprint (relocated) moves into the new footprint, keeping its offset within the rectangle (wrapped), so it stays visible, clickable and harmful. No RNG is drawn. Before, demolish/relocate left an orphan spot over empty tunnel that kept the bloom spreading, and a relocated chamber stayed at 50 % with no visible mold on it. |
| C75 | Run-1 event gap (balance rule, approved; DESIGN §18.1, §24.1) | In run 1 (`run.index === 0`) the gap to the next random event is `min(exponential draw, EVENT_GAP.firstRunMaxSec = 150 s)` at both places the scheduler sets `nextIn` (after the scripted fruit, and after each roll; the non-finite fallback is capped too). It is still one draw, so the RNG stream is unchanged. Later runs keep the plain exponential schedule (mean 240 s). Requested by the balance pass: between 18 and 30 min research and reveals alone leave 3–4 minute gaps, which uncapped draws fill only about half the time against the "something changes every 2–4 minutes" target (§2.2, §28.1). The extra events add food earned, so the Flight gate (`FLIGHT.fRunMin`) may need re-tuning (the balance tuner suggested 1.7–2e8). Resolved in C89: with C76 removing the reward spikes at the same time, the gate went down to 1.4e8 instead. |
| C76 | "Seconds of income" uses smoothed income (balance rule, approved; DESIGN §3) | One-shot rewards sized as "X s of income" through `wallet.incomeSeconds` (conquest / hunt / raid loot, event food and insight, golden windfall and discovery, soil caches, field-guide insight) use `d.rates[res].avg`. This is an exponential moving average of the gross rate with time constant `INCOME_AVG.sec = 60` that `economy.tick` advances every step for the ledger resources (exact for any step length; a derived cache without history — load, import, run start — starts it at the current gross). `incomeSeconds` falls back to `gross` when no average exists (hand-filled caches, soil, pheromone). Stated minimums still apply. A momentary spike (harvester stash, Frenzy ×5) therefore no longer multiplies a windfall that lands during it. Not covered: finite source sizing at discovery (C34, `surface.js`) and the click value, which still read the instantaneous gross. |
| C77 | Fallen rivals are compacted (gameplay fix, F26 part; DESIGN §27.3 save size) | At the end of every `rivals.tick` a conquered non-boss rival is reduced to `{ uid, type, tier, hex, alive: false, sighted, fallenAt, n: 0 }`, which is what the war panel ("Conquered" rows), tooltips, toasts, achievements (`conquestType`) and the field guide read. At most `FALLEN_RIVALS.keep = 24` such records stay (the oldest `fallenAt` is dropped first). Conquered rivals still stay in the list (C55). Bosses are never compacted or dropped: Old Ridge and the Front nests are looked up by type for the boss checks, and a pending Front nest regrows from its full record. Measured: a fallen record shrinks from ~270 to ~95 bytes of JSON (about 230 bytes of base64 per conquest in the save). |
| C78 | Hidden-tab time across a reload; the skew notice (runtime fixes F4, F6; DESIGN §21.1) | `meta.lastSeen` is the wall time the simulation has reached; `meta.savedAt` is the wall time of the last save. `main.js` saves with `{ hidden: true }` whenever its frame loop is not advancing the game (tab hidden, or no animation frame for over 1 s): `save` then leaves `lastSeen` where it is (never above `nowMs`) instead of moving it to `nowMs`, which used to discard the whole hidden period when the tab was closed, reloaded or discarded before being shown again. `loadOrNew` credits `gap = now − lastSeen` as before, and its first `hiddenSec = clamp(savedAt − lastSeen, 0, gap)` seconds count as hidden-tab time (100 % up to `OFFLINE.hiddenFullSec`, through `catchUp(gap, now, { hiddenSec })`); the rest follows the offline rules. Nothing is counted twice: state and `lastSeen` are saved together, and an in-tab catch-up moves `lastSeen` to now. A plain `save(nowMs)` (tools, tests, the Settings "Save now" button) still stamps `lastSeen = nowMs` minus any undrained backlog (C79), so legacy saves have `savedAt = lastSeen` and earn no hidden time. `meta.flags.clockSkew` is rewritten on every load (`gap < 0`), so the "clock went backwards" notice shows once, not on every later load. |
| C79 | Short-gap catch-up across frames (runtime fix F25; DESIGN §21.1) | A gap under `OFFLINE.onlineGapSec` still counts fully as online ticks, but `main.js` passes a frame budget to `game.advance(dt, now, { maxTicks: FRAME.maxTicks, budgetMs: FRAME.budgetMs, clock })`: each frame runs at most that many ticks (at least one when due) and the rest stays in `game.acc` as a backlog for the next frames, so a 59 s tab switch no longer runs 590 ticks in one frame (~150 ms freeze). The ticks, their order and the commands are the same, only spread out (a 45 s backlog drained in 20-tick frames ends deep-equal to one 450-tick frame). While a backlog waits, `lastSeen` trails `nowMs` by it, so a save during the drain loses nothing. A backlog plus a new gap that together reach `onlineGapSec` go to `catchUp` (hidden) as one gap. Without a budget (tools, tests) `advance` behaves exactly as §7.1 says (≤ `LOOP.maxTicksPerFrame`, at most one tick banked). `loadOrNew` still runs a < 60 s gap at boot. |
| C80 | One writer per save (runtime fix F5; DESIGN §22) | Two open tabs used to overwrite each other's save (a Flight in one was reverted by the other's autosave). Now: **(1) Save generation.** Every successful `save` writes `TABS.genKey` = previous + 1 (after the save itself); `loadOrNew` reads it first into `game.saveGen`. A `save` that finds the stored generation ahead of its own writes nothing, sets `game.stale`, publishes `saveStale` once and returns `{ ok: false, error: 'stale' }` (no storage banner); a stale game never writes again until it is reloaded. `hardReset` bumps the generation, so another open tab cannot write an abandoned colony back. A missing generation (legacy save, site data cleared) counts as 0 and does not lock a tab out; an unreadable one skips the check. **(2) Tab lock** (`core/tablock.js`, §7.16). The newest tab owns the game: at boot `main.js` claims the lock (`TABS.lockKey` = `{ id, at, beat, deadline }`, heartbeat every `TABS.beatMs`) and, when another live owner exists (heartbeat younger than `TABS.staleMs`), waits up to `TABS.handoverMs + settleMs` for it to flush its save and answer, then loads. Messages use a `BroadcastChannel` (`TABS.channel`), or `storage` events of `TABS.msgKey` when there is none; the lock entry's own `storage` events count as claims, and `main.js` re-checks the entry before every save and when the tab is shown again. The older tab flushes only inside the claimer's window, then stops its loop and saves and shows a full-page overlay "Game open in another tab"; a click reloads the page, which takes the game over with the latest save. The owner drops its entry on `pagehide`; a page restored from the back/forward cache reloads. Without readable storage the lock is off (and nothing can be saved anyway). |
| C81 | Hidden rules made visible; the medium drawer docks (UI fixes F12, F13, F15; DESIGN §9.3, §15.2, §25.1, §25.6 rule 8) | No game rule changes; the UI explains existing ones. `ui/rules.js` mirrors the systems' checks read-only. **Old Ridge:** below `BOSSES.old_ridge_supercolony.immuneUntilOwned` owned hexes the war panel, rival row and map tooltip show "Immune to assault until you own 25 hexes: N/25", and "what would raise it" asks for the missing hexes instead of soldiers (raids stay allowed). System hint integers ≥ 1,000 are formatted with `fmtCount`. **Argentine Front:** nests are labelled "nest 1/3"…; rows, tooltip and war panel state "all 3 within 10 minutes of the first"; once one falls a HUD chip counts down to the regrowth (`min(fallenAt) + windowSec − run.time`, paused offline as in rivals.js) and the shell toasts when a window opens and when fallen nests regrow (rivals.js emits no event for either; the shell compares fallen counts at 4 Hz and never toasts on load or import). **Satellites:** the hex part of `satelliteReason` (`locked`, `max`, `blocked:unowned`, `blocked:terrain`, `blocked:entrance`) is checked before the column picker opens; the Map panel shows the rule and how many hexes qualify, the hex tooltip and selection say why a hex fails. **Reasons:** every `code:detail` a validator returns has text in `REASON_DETAILS`; bare codes whose meaning depends on the command use `REASON_BY_COMMAND`. **Medium layout:** while open, the drawer is a grid column beside the stage (`clamp(300px, 38vw, 380px)`), so the canvases shrink instead of being covered; closed, it is off-canvas as before. |
| C82 | Reveal queue across runs (fix F7; DESIGN §23) | `meta.reveal.queue` only holds keys unlocked in the current run. `unlocks.onRunStart` drops queued keys the new run has not unlocked (a `flight_button` still waiting when the player flew no longer pops 28 s into the next run, and no longer delays that run's real reveals), and `unlocks.tick` drops any queued key that is seen or not unlocked (old saves) instead of revealing it. A dropped key queues again when its condition holds in a later run. |
| C83 | Whole-number prestige costs (fix F18; DESIGN §13.7, §14.5, §15.5) | Alates, kinship and genes are whole-number currencies (every award is floored), so Bloodline / Federation / Genome costs are rounded **up**: `traits.nodeCost` returns `ceil(base × growth^L)` (Hardy Workers 5, 18, 62 … instead of 5, 17.5, 61.25). Costs that were already whole are unchanged. The UI prints these three currencies with `fmtCount` ("5", not "5.0") in costs and in Stats. Fractions already in an older save stay until spent. |
| C84 | Chronobiology starting season (fix F17; DESIGN §17.1) | `setChronobiology { lengthSec, start }`: the length applies at once and keeps the position within the year (`t` scales, as before). `start` no longer jumps the running clock (that let a player skip any winter on demand): it is stored as the optional `meta.season.start` (`start: null` clears it, an absent `start` keeps it) and `startRun` applies it at every later run start — landing, Supercolony, Speciation — while the gene is owned (`seasons.chronoStart`). A Seasonal Wisdom pick in the landing chooser wins over it. Supersedes the `setChronobiology` reading in §18.1. The panel's season picker defaults to "Any" (no stored start). |
| C85 | Strata silhouettes (fix F26, strata part; DESIGN §25.8, §27.3) | `StrataRecord.cells` is the nest silhouette — the open (tunnel / chamber) cells — packed by `core/save.bitsEncode`: `"bits:"` + one base64url character per 6 cells, trailing empty characters dropped, so a record is at most ⌈3200 / 6⌉ = 534 characters whatever the nest looks like (the RLE of full cell codes passed 1 KB for a dug-out nest; 12 records were 13–14 KB of a 60–68 KB save). Older `"rle:"` records are re-packed at the next run end. The fossil renderer only ever drew open cells; its `decodeRle` reads both forms (open cells decode as tunnels). A 21 h save shrinks from 59.2 KB to 44.9 KB; `tests/integration.saveSize.test.js` keeps a late save with 12 worst-case records under `SAVE.targetBytes`. (C77 compacts fallen rivals.) |
| C86 | Next-unlock estimate at the source (UI hand-off; DESIGN §23; amends C57) | `d.progress.nextUnlock` now measures what the HUD used to patch: `{ adults: n }` and the first hatch (`run.stats.hatched`) follow the brood pipeline — cohorts already growing hatch at `(1 − p) × T`, then eggs at the lay rate each need one development time `T = BROOD.baseSec × mbt / max(1, nurseTerm) / bSpeed × broodFactor` (the lay rate is still 0 while housing blocks laying or the colony is Hungry, C57); housing full = free places / lay rate; food cap = room / net food rate; the autumn-of-year-0 and first-winter reveals use the season clock. Of two timed keys the earlier-scheduled one wins when due within one reveal gap (C63). When nothing timed is within 120 s, the first pending player-driven step in schedule order is returned with `eta −1` (an adult count while laying is blocked, Trail slots, Research once Scouts exist, Map), which the HUD names with its condition. |
| C87 | Offline catch-up cost (fix F24; DESIGN §21.3, §27.3) | Results are unchanged (identical state after 24 h on five saves from 40 min to 21 h). Advisor / UI-only estimates are not rebuilt on offline steps — the best untrailed source (`surface.derive`, skipped while `d.offlineLog` is set), Next Goals (`achievements`) and the next-unlock ribbon (`unlocks`) — because `game.catchUp` ends with a fresh online derive pass. The trail allocator caches each trail's next-chunk candidate and refreshes only the trails a chunk changed (same choices and numbers); `yieldParts` shares slope, D_nav, source lookup and origin haul per tick; passability reads a per-terrain table; `nest.autoLevelStep` checks a level's cost before planning its growth geometry; an earned achievement's duration timer is no longer kept. 24 h now takes about 40 % less time (best of 3, five saves from 40 min to 21 h: 0.28–0.56 s → 0.18–0.29 s on a busy reference machine), still well above the 60 ms budget: the schedule's 1,490 full steps cost ≈ 100–200 µs each across ~20 systems. Meeting the budget needs fewer offline steps or a cheaper offline trail model — a design decision. `tests/integration.offlinePerf.test.js` guards the skips and a generous time bound. |
| C88 | Prestige UI reachability (fixes F10, F11, F16, F19, F21; no rule change) | The landing chooser has a Bloodline shop (`modals.landingShop`): `buyTrait` was already allowed while the chooser is open, and `startRun` reads the traits at landing, so run-start traits bought with the alates just earned apply to that landing; buying Seasonal Wisdom there adds the season row. Automaton Instincts owners get an "Adaptation autobuyer" switch in Prestige → Bloodline (it sets `autobuy.on` and `autobuy.adaptations`), since the Federation sub-tab with the master toggle is hidden or a greyed preview for the whole first cycle. STRETCH Genome nodes (Biomes) are not listed. The Budding tip and the Supercolony checklist name the Old Ridge's "2,500 alates this cycle" condition. While the chooser is open the rail shows the run about to start ("run N · landing", from `meta.counters.runs`), not the skeleton run's "run 1". |
| C89 | Balance re-tune after the bug-hunt fixes (data only; DESIGN §9.3, §13.1, §15.1, §15.2, §15.5, §15.7, §16; Balance Verification "Re-tune pass") | No code changes; every number lives in `src/data`. **Speciation:** the gate `SPEC.kinshipMin` 400 → **1,000**, and genes = `floor(SC_genes(kinship_era / 50))` (`SPEC` mult 1, div 50, exp 1; was `3 × √(kinship_era / 100)`), so the gate pays 20 genes. **Bosses:** Old Ridge `1e6 × (1+m)^1.5` (apBase 3e5 → **1e6**); Argentine Front `1e8 × 10^s` (apGrowth 100 → **10**; it reaches 1e295 at s = 287). **Genome and Flight:** `unicolonial_sprawl` costs `6 × 1.13^L` (was `5 × 3^L`; MAX past 1e280 at L ≈ 5,260); Flight gate `FLIGHT.fRunMin` 1.5e8 → **1.4e8** (11 alates). **Why:** after C70/C71 (laying no longer tick-capped) the bot speciated at 12–13 h and merged at 4:32–4:52; the census ending was unreachable (4.5e8 in 52 meta-model weeks) and now lands at 8.05 weeks. **Stability:** §16 rule 5 now names Unicolonial Sprawl as the census engine (implied exponent ≈ 5.7 on colony_scale); the meta-model's stability check includes the colony_scale bought with each layer's currency (`tools/meta-model.mjs`: `shopScale`, `MODEL.scaleWeight`, costs rounded up as in C83); layer-3 gain ratios ≤ 1.54. **Tests:** `meta.contractive` asserts the ending within `ENDING_WEEKS` (6–10 weeks); the todo is removed. |
| C90 | Raids from a fallen rival (final-QA fix; DESIGN §9.10; follows C77) | A raid whose rival is no longer alive (or no longer in the list) when its warning ends is called off: it closes as `raidResult { win: true }` with nothing lost, starts no fight, and no raiders return (the nest is gone). A raid already fighting when its rival falls finishes its current sequence; `theft` reads `traits` only when the record still has them (a C77 compact record has none). Before this, a rival conquered during its raid's warning crashed `raids.theft` once compacted (16 h bot run, seed 3), and a compacted rival's trail raid still killed workers. Tests: `tests/war.fallenRaids.test.js`. |
| C91 | Housing counts only brood that will live in housing (player report: soldier slider did nothing; DESIGN §2.2, §5.4) | Housing room = housing − minor adults − minor brood (`population.housingBrood`). Soldier/supermajor brood already occupies Barracks berths, replete brood its replete berths and alate brood its cells, so counting it against housing too blocked every soldier egg whenever the Galleries were full even with berths free. `layBatch` caps each caste by its own home only (plus brood slots and food). The housing bottleneck, the next-unlock adult ETA and the Colony panel housing bar use the same count. Test: `colony.laying` "C91: …". |

### 18.1 Accepted package readings (`// ARCH-R:`)

At integration every `// ARCH-Q:` comment was reviewed. Cross-package readings are pinned above (C48–C65); the rest are local readings, accepted as written and re-tagged `// ARCH-R:` in the code. New ambiguities still get `// ARCH-Q:` (§16) until the next integration resolves them. Register of the local readings:

| File | Accepted readings |
|---|---|
| `core/actions.js` | `cmd.type` is re-asserted after spreading `args`. |
| `core/bus.js` | Logs caught handler exceptions with `console.error` (§1 rule 3 now lists it). |
| `core/commands.js` | Names ≤ 40 chars, flag/slot keys ≤ 64, `__proto__` / `constructor` / `prototype` rejected; `uiFlag false` deletes the flag, `equipCosmetic null` deletes the slot; handler exceptions become `commandRejected { reason: 'invalid:exception', detail }`. |
| `core/effects.js` | Re-adding an id keeps a permanent effect (`t = -1`) permanent. |
| `core/game.js` | `createGame` runs no step; derive-pass events are published after load/import; `save()` also sets `lastSeen` (unless `{ hidden }`, C78); `loadOrNew` returns `restoredFrom`; `advance` frame budget (C79); save generation (C80). |
| `core/guard.js` | The full walk also clamps values above `CLAMP_MAX` in magnitude and turns `-0` into 0 (negative sentinels kept). |
| `core/offline.js` | `simulateOffline` defaults `eff` to `offlineCapEff(s, d).eff`; extra exports `emptySummary`, `mergeSummaries`, `skipSeasonTime`. |
| `core/wallet.js` | `timeToAfford` returns -1 when a capped resource is needed beyond its cap. |
| `data/economy.js`, `data/jobs.js` | Extra keys `BROOD.fungalTimeMult`, `CLICK.avgSec`, `SLIDERS`, `WINTER_R`, `ACH_FX`; invented numbers `THRESHOLDS.shiftStep` 0.02 / `shiftMax` 0.5 and `PRESETS` (3 slots, 40-char names). |
| `data/research.js` | `formic_acid` (250) sits one row below its prerequisite `polymorphism` (300). |
| `data/sources.js` | One prey type per spawn (weighted pick, at most one alive); "prey ×2 near a log" = ×2 spawn weight within 2 hexes; the termite swarm spawns at ring 2–6. |
| `main.js` | Dynamic render imports (§14.7 "as built"). |
| `ui/hud.js`, `ui/onboarding.js`, `ui/text.js`, `ui/panels/stats.js` | Overlay buttons other than climate follow the feature that gives them meaning; glow keys (C58); cosmetic slot names derived from cosmetic ids; the Stats panel shows the layers reached (§4 records no per-layer timestamps). |
| `render/nestRenderer.js`, `render/overlays.js`, `render/surfaceInput.js`, `render/surfaceRenderer.js` | Midden "overloaded" = more than 100 adults × colonyScale per level; the climate overlay mirrors WP6's frost formula for display; the tournament tool passes unit counts from the tool object (0 when absent); `canvas:*` glow keys (C58); "particles ≤ 300" per view; trail width scales with √zoom and opacity never drops below 0.18. |
| `systems/achievements.js`, `systems/fieldguide.js` | "Outnumbered" = start.you < start.foe; "trail ≥ N hexes" = `path.length − 1`; cartographer = every hex inside the current radius; "at cap" = the bottleneck's 99 % rule (C33); a flight landed after a reload cannot judge the snapshot-based flight achievements; "first trail" = the first player-drawn trail; rivals looked up by `rivalType` or uid; "first tournament" read broadly. |
| `systems/adaptations.js`, `systems/automation.js` | Autobuyer "cheapest" = sum of a level's cost components; autobuyers need the master toggle; turning on an unowned feature is `locked`; auto-flight `peak` fires below 97 % of the recorded peak; Auto-Supercolony runs online only and keeps the current (possibly null) edict; the 1 Hz cadence counts whole-second crossings (at most `AUTOMATION.maxPassesPerTick` per tick). |
| `systems/bottleneck.js`, `systems/economy.js`, `systems/jobs.js`, `systems/population.js`, `systems/stats.js` | `bn_food` compares food above the egg reserve with the next minor egg; `net` rates are income − sinks, not clipped by a full store; `softcapHit` once per derived cache (may repeat after a reload); `winterHungry` resets each winter; auto jobs run with `autoJobs` or `thresholdJobs`, locked/capped shares go to the other jobs; "honeydew short" = the next alate egg or honeydew Adaptation level costs more than stored; `shiftJob` moves as many as it can; species `eggFungusFrac` is paid in fungus only when stored; `groomBrood` accepts any brood-group chamber; reason codes `invalid:garrison`, `requirements`; `soldiersRaised` counts soldier and supermajor eggs; `d.stats` extras `digRaw`, `upkeepWinter`, `forageWinter`; the nanitic worker term is 1 at 0 minors. (C51 and C52 cover the derive-pass, food and brood readings.) |
| `systems/combat.js`, `systems/raids.js`, `systems/rivals.js` | Battle extra fields `rival`, `esc`, `lost`; a battle where neither side can deal damage ends after `BATTLE.maxSec` (more AP wins); one raid per rival at a time; the raided trail is the one with most workers (border trails ×2, deterministic); a raid on a deleted or safe trail fizzles; "30 s of income" is taken in the trail's main resource; an empty garrison skips to theft; `dispatchGuard` on a nest raid is `invalid:nest`; extra rivals spawn at tier max(topTier, highest alive) + 1; prey and the termite mound fight as one unit with ATK = HP = AP; rival traits apply in every battle with that rival (propaganda on assaults only); conquest multipliers stack; a truce also blocks tournaments, bribing cancels raids in warning; tournaments live in `war.battles` (kind `'tournament'`) and default to withdraw after `ACTIONS.tournament.choiceSec`; Mobilize and the Alarm Rally cooldown are core effects (`mobilize:<uid>`, `alarm_rally:cd`); guard and reinforcement parties merge into their battle. (C55 covers bosses.) |
| `systems/events.js`, `systems/golden.js` | The termite swarm is a 50 % follow-up within 120 s of a rainstorm; the lizard "Reroute*" default resolves with no losses; antlion and lizard hexes lie strictly between origin and source; myrmecophile eating happens after its bonus ends; cordyceps resolves `'averted'` when deaths stay under `num.avertLoss`; mold spots capped at `num.maxSpots`; event food rewards use the one-shot 2× cap overflow; fruit and picnic harvests are detected locally (`'harvested'`); gifts on the map are capped at `OFFLINE.findMax`, and a beetle gift while a beetle is out opens a positive event. (C49 covers `beetleSpawned` timing, C61 later-run beetles.) |
| `systems/hardships.js`, `systems/prestige.js`, `systems/traits.js` | `startHardship` also accepts `alatesLife ≥ 150` directly; tier detection runs offline; one strata record per run (Supercolony marks it `cycle`, Speciation `era`); only Flights found daughters; trait and node costs use a number `base`; STRETCH genome nodes are `locked`. (C53, C54 and C56 cover startRun, brood bank and Peaceful Start.) |
| `systems/mapgen.js`, `systems/surface.js`, `systems/trails.js` | Revealed finite sources are sized at generation with gross 0 (base stock); the species option of `generateMap` is unused; `sweet_inheritance` is skipped without its trait data; the first seed patch sits on ring 2; duplicate root columns are dropped; fruit rots at 1 % of max per second; random spawn timers pause offline; the claim channel drains all pheromone (eff not applied twice); longest trail = `path.length − 1`; `cancelChannel` refunds up to the cap; "owned plant hex" = an owned flower patch or leaf plant hex; stocks deplete over `env.econDt`; regrowing seed patches are never removed at 0; Mass Recruit pins 50 % of the foragers not explicitly assigned to a trail. |
| `systems/nest.js`, `systems/nestgeom.js` | Species `royalStart` raises the Royal Chamber limit; an amber bead dug offline spawns no beetle; placement extras do not scale with k; shaft records are pushed with `open: false` when queued; `applyBlueprint` skips locked, invalid or unaffordable chambers (L1 footprint at the saved corner); relocation and shaft jobs cannot be cancelled and level-up soil and extras are not refunded; `blueprint_memory` alone enables blueprints; adjacency and hygiene paths count tunnel cells only. (C60 covers the advisor.) |
| `systems/seasons.js`, `systems/unlocks.js` | Under `eternal_winter` frost sits at F_max permanently; `index` is the canonical `SEASON_ORDER` index; `setChronobiology { start }` stores the starting season for the next run start and never jumps the clock; the length keeps the position (C84). (C50 and C57 cover mods and reveals.) |

*End of contract.*
