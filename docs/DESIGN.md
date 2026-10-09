# SIX LEGS DEEP: Game Design Document

**Version 1.0 (synthesis).** This is the single source of truth for implementation.
**Genre:** incremental / idle browser game. **Tech:** plain JavaScript ES modules, zero dependencies, no build step, DOM-free core logic tested with `node --test`.

> **How to read this document**
> - Everything has a stable `snake_case` id: resources, castes, jobs, chambers, research nodes, traits, events, achievements and so on. Code must use these ids verbatim. Display names are free to change; ids are not.
> - Every number lives in one data module, `src/data/balance.js`. The numbers here are **first-pass values**. They were checked and retuned with a full-system balance simulation (Balance Verification, end of document); the headless pacing bot (§28) is the acceptance test that tunes them further. If code and this document disagree, fix one of them; never leave them divergent.
> - **MUST** means required for v1. **SHOULD** means strongly intended. **STRETCH** means it may be cut, in the order of the cut list (§29.2).
> - Formulas use `L` for a level, `k` for an instance index (0-based), `N` for population, `dt` for the tick in seconds, and `^` for exponentiation.

---

## 1. Title, pitch and pillars

### 1.1 Title
**Six Legs Deep.** Alternate title (if needed for branding): *Underfoot*.

### 1.2 Pitch
You are the collective will of a single founding queen, sealed in a damp chamber beneath a garden path with a few crumbs of food. Click the crumb by the entrance to send your first runner. Twenty seconds later your first tiny nanitic worker emerges, and the colony starts to think for itself.

The game is played on **two living canvases joined at the nest entrance**:
- **Below**: a side-view ant farm. You draw tunnels through topsoil, loam, clay, gravel and bedrock, place and enlarge chambers, and watch brood pile up in nurseries and seeds fill the granaries.
- **Above**: a top-down hex map of the backyard. You paint pheromone trails to food, herd aphids, claim territory and send war parties against pavement ants, wood ants and fire ants.

Neither view is decoration. Where you dig decides whether winter frost freezes your brood or a raid empties your granary. Where your trails run decides how much food comes down the shaft.

The colony grows from 1 queen to thousands, then millions. At maturity you rear winged princesses for a **Nuptial Flight** and refound stronger. Later your daughter colonies fuse into a **Supercolony**. Finally your lineage **speciates** into leafcutters, honeypots or fire ants. The very long-term goal is *Twenty Quadrillion*: a supercolony as large as the estimated population of every ant on Earth.

### 1.3 Design pillars
1. **Every view is a lever.** Anything you can buy, you can see. Anything you see that matters, you can click. Each animation is tied to a number the player can change by acting in that view.
2. **Space is a resource.** Both geometries feed the economy:
   - nest geometry: depth, adjacency, distance to the entrance;
   - surface geometry: trail length, territory, borders.
3. **One binding constraint at a time.** The game always shows which of the four constraints is binding: lay rate, brood slots, housing or food cap (§2.2). The central decision every minute is which one to relax next.
4. **Show, never tell.** One glowing hint at a time, diegetic cues, and panels that appear only once they mean something (§25.6).
5. **Idle is respected, active is rewarded.** At equal progress, an active player earns about **1.6–1.8×** what an idle player earns, never 10×. There is no harm while offline.
6. **Biology is the flavour, not the homework.** Every mechanic is a real ant behaviour with a Field Guide note. Mechanics that would be accurate but tedious are simplified (§20).
7. **Numbers stay safe.** There is no big-number library. Every stored value is below 1e295, thanks to polynomial prestige passives, softcaps and cost caps (§12).

---

## 2. Core loop

### 2.1 Timescales
| Timescale | What the player does |
|---|---|
| **Seconds** | Clicks food sources and Golden Beetles. Marks or Rallies a trail. Helps dig. Answers raid warnings and event cards. |
| **Minutes** | Food is spent automatically on eggs, which the queen lays. The player spends food on chambers and Adaptations, soil on chamber levels and the Mound, and insight on research. They reassign jobs, draw trails to newly scouted sources, claim hexes, and raid or conquer rivals. |
| **Run** (first one ~60–90 min; later 20–30 min) | Grow from 1 queen to ~1,000+ ants. Dig into clay and gravel. Conquer 1–3 rivals. Get through 2–3 winters. Rear alates and take the Nuptial Flight. |
| **Meta** | Each layer feeds the next: Alates → Bloodline traits; Kinship → Federation (automation, satellites); Genes → Genome (species, deep multipliers). |

### 2.2 The four binding constraints
Each constraint is shown on the HUD as a **bottleneck badge**. The badge names the active limit and how long it has been binding, for example **"Bottleneck: Housing · eggs blocked 34 s"**.

| id | Constraint | Binding when | Relieved by |
|---|---|---|---|
| `bn_lay_rate` | Queen lay rate | All of these hold: food ≥ egg cost, a brood slot is free, housing is free, yet eggs wait on the lay timer | Royal Chamber levels, extra queens (Polygyny, Queens' Council), Royal Feeding, Queen's Feast, research |
| `bn_brood_slots` | Brood slots | Brood = brood slots | Nursery placement and levels |
| `bn_housing` | Housing | Minor adults + minor brood ≥ housing (soldier/supermajor/replete/alate brood waits in its own berth or cell, C91) | Gallery placement and levels |
| `bn_food_cap` | Food cap | Food ≥ 99% of the cap for more than 5 s | Granary levels, repletes |
| `bn_food` | (secondary) Food | Food < egg cost | More foragers, better trails, Adaptations |

When several bind at once, the badge names the one the player should fix first: a raid warning > frost > Hungry > housing > brood slots > food cap > lay rate > food. Housing and brood slots outrank the food cap because food only piles up at the cap when eggs are blocked (ARCHITECTURE §18 C72).

Relaxing one constraint makes another bind. Tuning MUST keep the binding constraint changing every 2–4 minutes during the first 30 minutes.

### 2.3 Resource flow
```
 clicks ─┐                                  ┌──────────── upkeep ◄──────────────┐
FORAGERS ─(trails, Above)─► FOOD ─► eggs ─► QUEEN ─► BROOD ─► ANTS ─► jobs ────┘
   ▲  territory/trail strength  │                  ▲slots     ▲housing
   │                            ▼                  │          │
 SCOUTS ─► INSIGHT ─► research    DIGGERS ─► DIG WORK ─► dig queue (cells) ─► chambers
   ▲ (+ Scent Library)                        └──► SOIL ─► chamber levels, Mound, Gate
 HERDERS ─► HONEYDEW ─► Queen's Feast, repletes, alate rearing, bribes
 LEAFCUTTERS ─► LEAVES ─► GARDENERS ─► FUNGUS ─► Nutrition ×(all worker output), supermajors
 SOLDIERS ─► raids/conquest/hunts ─► CHITIN, territory, loot, captured workers
 PHEROMONE (regenerates) ─► Mark, Rally, Frenzy, hex claims, battle abilities
 F_run (food earned this run) ─► ALATES ─► (Supercolony) KINSHIP ─► (Speciation) GENES
```
**Design rule (from A):** every run resource has **one dominant producer job and one dominant sink**. That keeps the job panel the main lever all game.

---

## 3. Global conventions

| Topic | Rule |
|---|---|
| Logic tick | Fixed **10 Hz** (`dt = 0.1 s`) inside `step(state, dt, commands)`. Rendering runs separately on `requestAnimationFrame`. Combat sub-steps at 4 Hz using an accumulator (§9.5). |
| Rates | Every rate in this document is per second unless marked otherwise. |
| Cost curve | `cost(L) = base × growth^L`, where `L` = levels already owned. Every base and growth value lives in `balance.js`. Alates, kinship and genes are whole numbers, so Bloodline, Federation and Genome costs are rounded **up** (Hardy Workers costs 5, 18, 62 …; ARCHITECTURE §18 C83). |
| Instance pricing | A new chamber of a type with `k` instances already built costs `F_place × 2.5^k`. Upgrades of instance `k` cost `× 2^k`. |
| Cost cap | When the next cost would exceed `1e280`, the button shows **MAX** and cannot be bought. |
| Clamp | Every stored number is clamped to `[0, 1e295]`. A NaN/Infinity guard reverts the field to its last good value, increments `state.stats.nanGuards` and logs an error. |
| RNG | mulberry32 with its 32-bit state stored in `state.rng`. Every random roll (events, map generation, combat fortune) goes through it, so behaviour is deterministic in tests. Battle previews fork the RNG and never consume the main stream. |
| "Seconds of income" | One-shot rewards are sized as `X s × current gross rate`, measured when the reward is granted. Example: "120 s of food" = 120 × gross food/s. The amount has a stated minimum so it is meaningful at 0:00. The rate is smoothed over about 60 s (a moving average), so a momentary spike such as a harvester stash or a Frenzy does not multiply a windfall (ARCHITECTURE §18 C76). |
| Overflow | One-shot food rewards may push food up to **2× the cap**. While food is above the cap, production adds nothing until food falls below the cap. |
| Death policy | **Starvation never kills.** Food reaching 0 causes the **Hungry** state instead (§5.8). **Adults** die only in battles and in specific counterable events, each telegraphed with a warning window: antlion, horned lizard, cordyceps if ignored, army ant column if you choose to fight. **Brood** can die only from frost in hard winters (§17.3), nest raids (§9.10) and the Phengaris "predator" outcome. **Nothing dies offline.** An optional setting, `harsh_nature`, enables starvation deaths of 0.5% of adults per second while Hungry. It is cosmetic for veterans and is never required. |
| Click cap | Clicks count up to 15 per second. Excess clicks are ignored. |

---

## 4. Resources

### 4.1 Run resources (reset by a Nuptial Flight)

| id | Name | Produced by | Spent on | Cap | Revealed |
|---|---|---|---|---|---|
| `food` | Food | Foragers on trails, clicks, loot, events, caches | Eggs (auto), chambers, Adaptations, upkeep | Yes. `150` at the Royal Chamber plus granaries (§7.6), ×1.25 in autumn, + repletes | 0:00 |
| `soil` | Soil | Dig work, **1 soil per 1 work**, whether the work is spent on queued cells or on "maintenance excavation" when the queue is empty | Chamber level-ups, Mound levels, Gate | None | 3 adults, with the Digger job (~0:30) |
| `insight` | Insight | Scouts revealing hexes, Scent Library, Field Guide entries, fossil caches, conquests | Research | None | First hex revealed (~2:15) |
| `pheromone` | Pheromone | Regenerates: `(0.5 + 0.05 × √adults) × (1.5 with pheromone_glands)` per s | Mark (5), Rally (20), Alarm Rally (25), Mobilize (40), Frenzy (60), hex claims, Mass Recruit (20) | `50 + 50·pheromone_glands + 5 × mound level` | `scent_marking` research (~6 min) |
| `chitin` | Chitin | Dead insects, prey hunts, battles, beetle-husk caches, events, moults (0.025 per hatched adult), Midden recycling (0.05/s per level) | Soldier eggs, supermajors, military Adaptations, Gate | `(500 + Σ Carapace Store capacity) × colony_scale` (§12.8; C199) | First chitin gained (~5 min) |
| `honeydew` | Honeydew | Herders at aphid colonies, Root Aphid Pens, flower patches (trace), Lycaenid caterpillars | Queen's Feast, repletes, alate rearing, Sweet Tooth, bribes | `50 + 0.1 × food cap` | `aphid_husbandry` (~12 min) |
| `leaves` | Leaves | Leafcutters on leaf-plant trails | Fungus Garden input only (a buffered flow) | `500 × Σ fungus garden levels` | `leafcutting` (~25 min); shown only in the Fungus widget |
| `fungus` | Fungus | Gardeners: each turns 0.3 leaves/s into 0.1 fungus/s | Nutrition (continuous), supermajors, Fungal Brood | `1,000 × Σ fungus garden levels` | `fungiculture` (~45–50 min) |

**Reveal pacing:** about one new resource every 5 minutes, and never two in the same minute (§23).

### 4.2 Tracked quantities (not spent)

| id | Meaning |
|---|---|
| `adults` (by caste) | Living adults: `minor`, `soldier`, `supermajor`, `replete`, plus alates in their cells. |
| `brood` | Cohorts `{caste, count, progress}` in development. |
| `housing`, `brood_slots`, `berths` | Population caps (§5). |
| `territory` | Owned hex count. `t_peak` = the peak this run. |
| `f_run` | Gross food earned this run, after softcap, before upkeep. Clicks, loot and events all count. |
| `colony_scale` | A single multiplier on housing, brood slots, berths and lay rate (§5.6). |
| `census` | `adults_total × (1 + 0.25 × satellites)`. Used only for population achievements and Twenty Quadrillion. |

### 4.3 Prestige currencies (each kept through its own reset)

| id | Name | Layer | Kept through | Spent on |
|---|---|---|---|---|
| `alates` | Alates (winged princesses) | 1: Nuptial Flight | Flights | Bloodline traits (§13.7) |
| `kinship` | Kinship | 2: Supercolony | Flights and Supercolonies | Federation nodes (§14.5) |
| `genes` | Genes | 3: Speciation | Everything | Genome nodes (§15.5) |
| `diapause` | Diapause (banked time) | Offline overflow | Everything | 2×/3× time acceleration (§21.5) |

Lifetime counters are kept separately and **never decrease when currency is spent**. Passive bonuses read the lifetime counters:
- `alates_cycle`: alates earned since the last Supercolony;
- `kinship_life`: kinship earned since the last Speciation;
- `kinship_era`: equal to `kinship_life`, named for formula clarity;
- `genes_life`: genes earned all-time.

---

## 5. Queen, brood and population

### 5.1 Lay rate
```
λ = Σ_queens (0.2 + 0.05·RF) × royal(RC) × court × M_lay        [eggs/s]
royal(RC) = 1.15^(min(RC, 8) − 1) × 1.25^max(0, RC − 8)
court     = 1 + 0.25 × (queens − 1)
```
- `RF` = Royal Feeding Adaptation level.
- `RC` = Royal Chamber level. Levels up to the full-size room (L8) give ×1.15 each, as before; every level above it gives ×1.25 (ARCHITECTURE §18 C198).
- `M_lay` is defined in §12.4.
- **Colony scale does not multiply the lay rate** (player decision, C198). It still scales housing, brood slots and berths, so in a large colony the queen is a real bottleneck again: the player answers with Royal Chamber levels (capped in practice by the food cap, since each level costs ×2.2 more food) and extra queens.

With Polygyny (and Queens' Council), each extra Royal Chamber adds its own term with its own level, and every laying queen beyond the first adds +25% to all of them (`court`): three equal queens lay 3 × 1.5 = 4.5× one queen.

The queen lays when **all** of these hold:
1. `food − egg_reserve ≥ egg cost`.
2. A brood slot is free (`brood < brood_slots`).
3. `minor adults + brood < housing`.
4. For soldier eggs: a free Barracks berth exists; for supermajor eggs: a free War Hall berth exists (ARCHITECTURE §18 C136).

`egg_reserve` is a player slider, from 0 to 90% of the food cap, so the player can save up for a purchase. Eggs accumulate on a lay accumulator. When several are due in one tick they are laid together as one cohort.

Food produced while storage sits at the cap may pay for the eggs due in the same step (an egg bought at the cap is refilled at once by production), so laying does not depend on the step length: 60 s offline steps lay as many eggs as 0.1 s online ticks, within 2% (ARCHITECTURE §18 C70).

### 5.2 Egg cost (polynomial, from A)
```
E(N) = 10 × (1 + 0.02·N)^1.5 × M_egg            N = all adults + all brood
```
| N | 0 | 50 | 100 | 200 | 500 | 1,000 | 5,000 | 10,000 | 1e6 | 1e9 |
|---|---|---|---|---|---|---|---|---|---|---|
| E(N) | 10 | 28.3 | 52.0 | 111.8 | 365 | 962 | 10,150 | 28,500 | 2.83e7 | 8.94e11 |

- `M_egg` = `trophic_eggs` ×0.7 × species modifiers.
- **Nanitics.** The first **5** eggs of every run (**25** with the `nanitic_vigor` trait) cost ×0.5. They become normal minors.
- **Caste egg multipliers**, applied to `E(N)`:

| Caste | Food multiplier | Extra cost |
|---|---|---|
| minor | ×1 | — |
| soldier | ×5 | + (1 + 0.02 × soldiers) chitin |
| supermajor | ×50 | + 25 chitin + 5 fungus |
| replete | ×20 | + 10 honeydew |

- **Rule (from A's calibration post-mortem):** housing stays **linear per level** in run 1 (§7.6), and research income never scales with population. Late-run population is gated by **housing**, not by food.

### 5.3 Brood development
```
T = 25 s × M_bt / (1 + min(4, (nurses + 1) / brood_slots)) / B_speed
```
- The **queen counts as 1 nurse**. One nurse per slot halves `T`; four per slot cut it to a fifth.
- `M_bt` = `brood_care` ×0.75 × season (spring ×0.8, winter ×1.5) × Fungal Brood (×0.75) × events (Brood Mites ×1.5) × caste factor (minor 1, soldier 1.7, supermajor 3.75, replete 2.5).
- `B_speed` = the slot-weighted average, over all nurseries plus the Royal Chamber's own 3 slots, of `(1 + adjacency + microclimate)` (§7.7, §17.2). Frozen nurseries contribute **0** for their share.
- **Stages** (used for visuals only): egg for progress < 0.25, larva for 0.25–0.75, pupa for ≥ 0.75.
- **First worker check:** at game start it is spring and there are no nurses, so `T = 25 × 0.8 / (1 + 1/3) = 15 s`. The first egg is laid at 0:00, using the 5 starting food and the nanitic half-price egg, so the **first worker hatches at about 0:15**. This MUST be asserted by a test (window 15–30 s).
- **Moults (player request, ARCHITECTURE §18 C103):** every adult that hatches (any caste, alates included) leaves a pupal case worth **0.025 chitin**, once chitin matters (`caste_soldier` or `res_chitin` unlocked; the first minutes of a first run reveal nothing new). Flat, no channel multiplier. The chitin tooltip shows it as a ~60 s average ("Moults x/s").
- **Cohorts:** brood is stored as cohorts `{caste, count, progress}`. Cohorts laid in the same second merge. Cohorts are distributed across nurseries in proportion to free slots (with `thermal_brood_shuttling`: best microclimate first). That distribution matters for frost (§17.3) and raid reach (§9.10).

### 5.4 Housing, brood slots and berths
| Cap | Formula |
|---|---|
| `housing` | `(10 [Royal Chamber] + Σ gallery_housing(L) × layer_bonus) × M_house × colony_scale` (gallery formula in §7.6) |
| `brood_slots` | `(3 [Royal Chamber] + 3 × Σ nursery levels + hibernaculum capacity) × colony_scale` |
| `berths` (soldiers only) | `8 × Σ barracks levels × colony_scale` |
| `war_berths` (supermajors only) | `4 × Σ war hall levels × colony_scale` (C136). Supermajors above it (older saves, where they shared the Barracks) stay alive but block new supermajor eggs until berths free up. |
| `replete_berths` | `5 × Σ repletion hall levels × colony_scale` |
| `alate_cells` | `10 + 5 × (nuptial chamber level − 1)`; max 25, or 50 with `royal_court`. Not scaled. |

`M_house` = `gallery_arches` ×1.25 × `compact_galleries` ×2 × species modifiers.

### 5.5 Caste targets (the "Diet" controls, from A and B; target counts since ARCHITECTURE §18 C151)
- **Unlock:** `polymorphism` research (each caste row appears with its caste).
- **Target counts (player decision, C151; replaced the caste-share sliders):** for `soldier`, `supermajor` and `replete` the player sets a **target number of ants** with a stepper (− / + by ×1 or ×10, or a typed number) or **Max**, which sets the target to that caste's population cap right now: soldiers → Barracks berths, supermajors → War Hall berths, repletes → Repletion Hall berths. Each row reads "N / target (cap M) · K berths free" and shows the per-egg cost (food plus chitin / fungus / honeydew) and why the caste is or is not being laid.
- On each lay, the caste with the largest deficit (`target − adults − brood of that caste`) is chosen; once every caste has reached its target the queen lays minors. Lost soldiers are replaced; lowering a target below what exists lays no more of that caste and harms nobody. It falls back to the next caste, then minors, if no berth is free or the secondary resources are short (laying never blocks).
- **Keep berths filled (C151):** a toggle per caste; while on, the target equals the caste's current cap and follows new berths. It is **on by default** (C243) for soldiers, supermajors and repletes: it switches on by itself as soon as the caste is unlocked in a run (the target is 0 until berths exist), unless the player already set that caste's target or toggle this run; existing saves switch on every caste the player never set. The player can turn it off (the target then stays at the current cap until changed). The chitin reserve still applies.
- **Carry-over:** with Automated Brood (Federation) the targets and the toggles the player set carry into the next run (Pacifist / Monomorphic zero the castes they ban). Saves from before C151 convert: each caste with a share gets target = max(share × its current cap, the ants of that caste already alive or in brood), rounded; a carried share preset becomes "Keep berths filled".
- A caste whose single egg costs more food than storage can ever hold above the egg reserve is skipped like a full berth: the queen lays the next caste by deficit, then minors, instead of stopping. A caste that storage can hold but cannot pay for yet still waits for the food (ARCHITECTURE §18 C71).
- **Chitin reserve (player request, ARCHITECTURE §18 C104):** a slider under the caste targets, an absolute amount on a ladder 0, 1, 2, 3, 5, 10 … 10,000 chitin (default 0; per run, back to 0 after a prestige). Soldier and supermajor eggs spend only chitin **above** the reserve; at or below it they are skipped like a full berth (minors are laid instead; laying never blocks). Serrated Mandibles, Thick Cuticle and the Gate are not limited by it (the player spends those by hand).
- **Chitin priority (player request, C104):** while chitin is needed — a soldier or supermajor egg is wanted by its target (below the target, with a free berth) but chitin < reserve + its chitin cost, or a reserve is set and chitin < reserve + the next soldier egg — unassigned foragers fill chitin-yielding trails (dead insects, termite swarms: any source with a chitin yield) up to saturation before the usual best-marginal order. Explicit per-trail assignments are untouched. The Map panel marks such trails "chitin priority".
- **Upkeep on the rows (player request, C233):** each caste row reads "Upkeep 0.25 food/s each · 5.0 food/s for 20", and the Castes section shows "Army upkeep X food/s (Y% of all upkeep)", so a target below the cap has a visible payoff: less food upkeep and chitin kept for Adaptations and the Gate. "Keep berths filled" trades both for defence.
- **UI copy:** "Larval diet decides caste" (Field Guide `fg_polymorphism`).

### 5.6 Colony scale
```
colony_scale = 1.2^vast_galleries × (1 + kinship_life)^0.2 × 2^megacolony_galleries × 10^colossal_nests × 2^unicolonial_sprawl × species
```
It multiplies housing, brood slots, berths, replete berths, hibernaculum capacity, gardener slots and the chitin cap **together**, so the population pipeline scales as a unit. It no longer multiplies the lay rate (C198): the queens must keep up through Royal Chamber levels and extra queens (§5.1). It is the engine behind thousands-to-quadrillions of ants. The HUD shows it as "Colony Scale ×4.2M" from the first point it exceeds 1.

### 5.7 Upkeep
| Caste | Food/s each |
|---|---|
| minor | 0.05 |
| soldier | 0.25 |
| supermajor | 1.0 |
| replete | 0.02 |
| alate (in cell) | 0.5 |
| queen | 0 |

- **Upkeep is never multiplied by production multipliers.** It is a teaching constraint that bites in the first 30 minutes and in soldier-heavy colonies, then fades.
- Winter upkeep ×1.0, reduced by `overwintering` ×0.8, `diapause_logic` ×0.75, the Hibernaculum (−10% per level, max −50%) and repletes (each covers 0.05 food/s in winter, up to 50% of total upkeep).

### 5.8 Hungry state
- **Trigger:** food is 0 and net food/s < 0.
- **Effects:** egg laying stops and all output is ×0.75. A droopy-queen sprite and a soft amber vignette appear on both canvases. The badge reads "Hungry: assign more foragers".
- **Ends:** when food > 5% of the cap.
- No ants die, unless `harsh_nature` is on.

---

## 6. Castes and jobs

### 6.1 Castes
| id | Name | Unlock | Egg cost | Upkeep | Stats / effect | Housed in |
|---|---|---|---|---|---|---|
| `queen` | Queen | start | — | 0 | Lays eggs (§5.1). Counts as 1 nurse. | Royal Chamber |
| `minor` | Minor worker | start | E(N) (nanitic ×0.5) | 0.05 | Takes jobs (§6.2). If idle, acts as militia: ATK 0.5, HP 4. | Galleries (housing) |
| `soldier` | Soldier (major) | `polymorphism` (~12–15 min) | 5·E(N) + (1 + 0.02·soldiers) chitin | 0.25 | ATK 4, HP 20 (√(ATK·HP) = 8.94). Garrison, escort, war party. | Barracks berth |
| `supermajor` | Supermajor | `supermajors` research | 50·E(N) + 25 chitin + 5 fungus | 1.0 | ATK 30, HP 250 (√ = 86.6). The rival home bonus is reduced against it (§9.4). | War Hall berth (C136) |
| `replete` | Replete (honeypot) | `living_larders` | 20·E(N) + 10 honeydew | 0.02 | +2% food cap each (additive; ×1.25 if any Granary is adjacent to a Repletion Hall). In winter each pays 0.05 food/s of colony upkeep. Does not work. Hangs swollen from the ceiling. | Repletion Hall berth |
| `alate` | Alate | Nuptial Chamber built | 20·E(N) food + 5 × 1.15^k honeydew (k = alates already reared this run) | 0.5 | No work. Each reared alate adds +2% to flight alates (§13.2). Development `T × 5`. | Alate cell |

- **Retire to workers** (Colony panel, available with `polymorphism`): turns soldiers or supermajors from the garrison (not escorting, marching or fighting) into minors. It needs free housing, gives no refund, and frees berths (Barracks berths for soldiers, War Hall berths for supermajors). Added after the balance pass (Balance Verification, open issue 3): the pacing bot needed it once berths filled with soldiers.

### 6.2 Jobs (minor workers)
| id | Job | Output per worker | Limit / notes |
|---|---|---|---|
| `forager` | Forager | Trail formula (§8.5): base `Y_src` food/s × modifiers | Assigned per trail on the Above map. Unassigned foragers fill the best unsaturated trail. With no trail at all: "loose foraging" at 0.1 food/s. |
| `digger` | Digger | Dig work `W = diggers^0.85 × M_dig`, and soil = W | The exponent < 1 means a million-ant colony never digs the grid out in one tick. |
| `nurse` | Nurse | Brood speed (§5.3) | Useful up to 4 per brood slot. Field Triage needs ≥ 5 nurses. **Cap (C231):** `ceil(4 × brood_slots − 1)` nurses (the queen is the other one; never below 5 with Field Triage), in manual moves and automatic assignment alike; the row reads "N / cap" with a tooltip. Nurses past it changed nothing (brood speed, Brood Mites ≥ 1 per slot and Field Triage are all reached below it). |
| `scout` | Scout | Exploration: the whole scout force produces `scouts^0.6` scout-seconds per second (diminishing, like digging; §8.3); +3 s raid warning each | Unlocks at 12 adults. Explores the nearest frontier, or flagged hexes at 3× priority. |
| `herder` | Herder | 0.08 honeydew/s | Max 8 × colony level per aphid colony (×2 with `aphid_shepherding`). Uses a trail slot. |
| `leafcutter` | Leafcutter | 0.3 leaves/s | Leaf-plant trails. Nothing in winter. Needs leaf storage: until a Fungus Garden is built the job holds no one (assigning is refused, leafcutters at work go back to foraging), since every leaf would be wasted (C238). |
| `gardener` | Gardener | Turns 0.3 leaves/s into 0.1 fungus/s | Max 5 × Σ fungus garden levels × colony_scale. Without leaves it idles, and the garden shows a starvation icon. |
| `idle` | Idle / militia | — | Joins nest defence via Mobilize (§9.9). |

Soldiers are assigned as **garrison** (default), **escort** (per trail), or **war party** (a campaign in progress).

### 6.3 Job automation
- **Manual (start):** +/− buttons and drag between job chips. New adults go to `forager`. **Step (player request, C230):** "Per click 1 · 10 · 100 · Max"; the +/− buttons show the step ("+10", "−1", "+Max") and their tooltips say exactly what one click moves. A step larger than the minor workforce is greyed out and the largest step that fits applies; a new run (Flight, Hardship) starts at 1.
- **Colony tab sections (player request, C229):** Brood, Castes and Jobs fold and unfold by clicking (or Enter on) their heading; the folded set is remembered per browser.
- **`age_polyethism` research (60 insight, ~10–15 min into run 1):** preset ratio sliders. New adults and rebalancing follow the targets (young workers nurse, middle-aged dig, old forage, as flavour). This is deliberately cheap and early. Each job chip gets a target slider (step 5 %); in auto mode +/− nudge the target by 5 % instead of moving workers, and raising one past a 100 % total scales the others down. Every 5 s all workers are reassigned to the targets. A share a job cannot use (locked, or above the herder/gardener cap) is foraged. Turning auto on keeps the current split as the targets (ARCHITECTURE C94).
- **`response_thresholds` research:** auto-assignment retargets the current bottleneck. For example: nurses up when `bn_brood_slots`/brood time binds, diggers up when the dig queue has more than 60 s of work, herders when honeydew is short for a pending purchase. The player's targets stay as set: the automation adds a bias to the bottleneck job, +5 % of the workforce per 5 s while the trigger holds and more workers help (up to +30 %, never past 50 % of workers, nurses never past 4 per brood slot), and −2.5 % per 5 s once it clears (ARCHITECTURE C94).
- **`automaton_instincts` Bloodline trait (5 alates, run 2–3):** dig queue +2, and the job targets you last set carry into every new run; when `age_polyethism` / `response_thresholds` is known at run start (for example as Innate research), its mode starts switched on. (C166: it no longer makes both modes innate or grants the Adaptation autobuyer.)
- **`automated_brood` Federation node:** both modes are innate and on from the first second of every run (§14.5). Automatic jobs without research and every autobuyer are Federation rewards (C166).

### 6.4 Nutrition (ratio multiplier, from A)
- **Unlock:** `fungiculture`.
- The colony eats `0.005 fungus per adult per s`.
- `φ = min(1, fungus supplied / demand)`.
- **All worker output** (forage, dig, herd, leafcut) is ×`(1 + 0.5φ)`. This becomes ×`(1 + 1.0φ)` with `fungal_symbiosis` and ×`(1 + 2.0φ)` for the Leafcutter species.
- Because demand scales with N, the leafcutter + gardener share (about 8–10% of workers) stays a live decision at every colony size.
- The UI shows φ as a "Nutrition" ring on the Fungus widget.
- **Fungal Brood** (a toggle, also unlocked by `fungiculture`): brood time ×0.75, at a cost of 0.5 fungus per egg laid (× caste factor). When fungus runs out, the toggle pauses automatically.
- **Larvae eat first.** Each tick, fungus egg costs (supermajors, Fungal Brood) are paid before Nutrition draws on the stock. Without this rule, Nutrition demand (which scales with N) ate every unit of fungus in large colonies and supermajors could never be laid.

---

## 7. The underground nest (the "Below" canvas, side-view cross-section)

### 7.1 Grid and strata
- The grid is **40 columns × 80 rows** (wider runs: see below), drawn as one continuous cross-section that fills the canvas width: cells are at most 24 px and at least 16 rows stay visible; where the grid is narrower than the canvas, soil continues either side as decoration. A minimap strip shows the whole column.
- **Default view:** the sky down to the deepest chamber, with cells no smaller than about 13 px, and the Royal Chamber always in view. It is re-applied at every layout change until the player moves the camera, and at every run start. On a narrow canvas it zooms past the width so chambers stay big enough to tap. A "Queen ↓" chip appears when the Royal Chamber is scrolled away.
- **Camera:** the wheel scrolls; Ctrl + wheel, trackpad or touch pinch, the `+` / `−` keys and on-canvas − / + buttons zoom (from the whole column down to ~40 px cells); once zoomed past the width, dragging pans sideways too. The crown button, `0` or `Home` re-frames the queen. (ARCHITECTURE §13.5, §13.7.)
- **Wider nests (ARCHITECTURE §18 C215):** each Satellite Nest level (Federation) widens the nest of every run that starts afterwards by 4 columns on each side, up to 64 columns (three levels). The width is fixed for the whole run; the shaft and the Royal Chamber stay centred (in a 48-wide nest the main shaft is column 24). Blueprints saved in a nest of another width are recentred on the main shaft; what no longer fits is left out.
- Row 0 is the soil surface. The main entrance shaft is column 20, rows 0–19, and is pre-dug.
- The **Royal Chamber** is pre-dug at rows 20–21, columns 18–21. That puts it below the hard-winter frost line, so the queen is always safe. It reserves its full-size room, columns 13–21, rows 20–23 (C155), and nest generation keeps boulders and water pockets out of that area on either side.

| Layer id | Rows | Work per cell | Requirement | Gameplay properties |
|---|---|---|---|---|
| `topsoil` | 0–9 | 4 | — | Cheap. Rows 0–5 flood during Rainstorms. Microclimate: spring nursery +15%, summer nursery −15% (overheat). First in line for frost. |
| `loam` | 10–23 | 6 | — | Galleries +10% housing. The hard-winter frost line reaches row 18. |
| `clay` | 24–39 | 10 (7.2 with `clay_masonry`) | — | Humid. Fungus Gardens ×1.5. Granaries ×1.25 capacity but spoil 0.5%/min of the food held there (stopped by `ventilation_shafts`). |
| `gravel` | 40–57 | 16 | — | Dry and stable. Granaries ×1.5 with no spoilage. Scent Library ×1.25. Nurseries +10% in winter. |
| `bedrock` | 58–73 | 40 | `acid_excavation` | Granaries ×1.75. Deep Vault. (Past nests now live in the Colony History gallery, §25.8.) |
| `aquifer` | 74–79 | 120 | Federation `aquifer_access` | Chambers here get +20% effect. Water Wells here count double. |

- A chamber's layer is the layer holding the majority of its cells (ties go to the deeper layer).
- Each cell costs the work of its own layer. Chamber cells cost **×1.5** the tunnel work.

### 7.2 Digging model (from D)
- **Dig rate:** `W = diggers^0.85 × M_dig` work/s (§12.3). **Soil gained = W** at all times.
- **Dig queue:** holds up to **5 jobs** (+2 `load_chains`, +2 `automaton_instincts`). A job is one of:
  - a tunnel path,
  - a new chamber's cells,
  - a level-up's growth cells,
  - a shaft.
- **Speed cap (ARCHITECTURE §18 C252):** however strong the diggers, at most **25 cells a second** are dug (a Help Dig click finishes at most 2 more), so even late-game digging is visibly fast, never instant. Soil income is unaffected.
- The Build tab keeps the queue in a fixed-height box that scrolls, so the chamber list below never jumps; its "Hide maxed" toggle hides a chamber type only when none can be placed and every one built is at its max level (C251).
- All work goes to the **first** job in the queue. The player reorders jobs by dragging the queue chips. Each chip shows work remaining and ETA (`work / W`).
- **The queue keeps running offline.** Coming back to a newly finished chamber, which glows once, is a deliberate idle payoff.
- **A\* preview:** placing a chamber that does not touch an open cell auto-routes a tunnel from the nearest open cell. (Tunnels the player draws are never auto-routed: §7.3, C256.)
- **Tunnels the player did not draw say who dug them (C214):** hovering a tunnel cell names its origin ("Dug by: a mole (Mole Tunnel event)", "access tunnel for the planned Granary", "auto-route to the Gallery", "your blueprint's saved tunnels", "the Nuptial Chamber's exit shaft", "the passage joining your queens' chambers"), and the event log records mole tunnels and blueprint tunnels as they appear.
  - The route is weighted by layer work, and stones are impassable.
  - The preview shows total work and ETA. The player can drag to redraw the route.
- **Help Dig** (click on the active dig face): +5 work + 3% of `W` per click. Counts toward the 15 clicks/s cap.

### 7.3 Tunnels, backfill, relocate, demolish
- **Tunnel:** drag from any open cell. Each cell costs its layer's work (×0.5 with `load_chains`). Tunnels give no housing.
  - The drag digs exactly the cells dragged over (a straight 4-connected line between pointer samples; dragging back undoes), never an auto-route. It stops at the first cell a tunnel cannot cross (stone, water, a chamber, a reserved room, a closed layer) and says why (C256).
- **Backfill:** select open tunnel cells → filled for free over 10 s, one after another from the cell furthest from the entrance, never faster than 20 cells a second (a big batch takes longer; C252). Not allowed if it would disconnect a chamber from every entrance.
  - The Backfill tool (Build panel, or `B` over the nest) paints a box: it fills every tunnel cell in it that can go, skips soil and chambers, and keeps open (red, with the reason) the shaft cells and the cells a chamber still needs. The tool stays on for the next stroke.
  - Cells being backfilled are drawn hatched, filling up from the floor as their 10 s run out.
  - **Backfill unneeded** (Build panel) backfills, after a confirm with the count, every tunnel cell that no chamber, dig job, shaft, entrance or planned blueprint chamber needs to stay connected.
  - **Auto-backfill** (Build panel toggle, off by default, kept across runs): every 30 s the same unneeded tunnels are backfilled (C253).
- **Relocate a chamber:** pick a new valid spot.
  - Cost: 50% of the dig work of the new footprint. The level is kept.
  - The chamber is inactive until its new cells are dug **and** its old room is cleared: clearing takes 3 s + 0.5 s per cell of the old footprint (C254), so a relocation is never instant. The old cells become tunnel. The inspect panel shows both phases.
  - `R` (on the chamber under the cursor, else the selected one) starts it; `R` again, `Esc` or a right-click cancels the relocate tool (C257).
- **Demolish:** refunds 50% of the placement food. Cells become tunnel. The Royal Chamber cannot be demolished.

### 7.4 Placement, activation and enlargement
1. The player picks a chamber in the **Build** panel (or presses `Q` over a chamber of that type, C142; `Q` again, or with no chamber under the cursor, puts the tool away, C180). A **ghost footprint** snaps to the grid.
   - **Full-size reservation (C137):** a chamber that grows shows its L1 room inside the outline of its **full-size room**: its footprint at the level where its growth stops (L8, or its max level when lower; the Royal Chamber too, its 9×4 L8 room, whose corner holds its L5 Flight room; ARCHITECTURE §18 C155). Placing it **reserves** that whole rectangle. `F` (or right-click, or a long-press) flips which corner of the rectangle the small room starts in; the ghost cycles the distinct corners.
   - The reserved rectangle must fit inside the nest, meet the chamber's depth rule (and a Shallow Soil limit) and hold no other chamber, no other reservation and no shaft entrance (the top two shaft rows). Stone, water and closed layers inside are allowed, but growth waits until they are cleared (Acid Excavation, draining or moving the pocket, the layer unlock); the ghost crosses them and counts them.
   - Reserved cells are drawn as works in progress (C154): the soil the chamber will grow into looks freshly excavated but unfinished (a lighter, sandy fresh-dug wash with pick marks and a faint construction hatch, timber props and, close up, a worker or two at the face), clearly unlike a finished cavity or a tunnel; brighter, with its dashed extent, while placing or when the chamber is hovered or selected. Clicking a reserved cell selects and inspects the chamber that owns it; hovering it says "Reserved for Gallery (L3 → full size at L8)". No other chamber may be placed in them, grow into them or reserve them, and no new tunnel may be queued through them (tunnels already there stay; auto-routes go around; draining a pocket inside may cross them).
   - Tint: **green** = valid; **amber** = valid with penalties; **red** = invalid, with the reason.
   - The tooltip lists live modifiers: layer bonus, adjacency bonus or penalty, "frost-exposed in winter" with its cells ("4 of 6 cells above the frost line"; a footprint across the line that is safe says "Safe from frost: most cells below the frost line", and the frost row is drawn across the ghost; C213), "flood zone", "within raid reach (15 cells)", and for granaries the haul-distance effect on forage.
   - It also warns (amber) when the footprint would take the Royal Chamber's last room to grow to **L5**, which the Nuptial Flight requires: "Boxes in the Royal Chamber". The placement is still allowed. (With C137 / C155 the Royal Chamber starts with its full-size room reserved, which holds its L5 room, so this only applies to a Royal Chamber from an older save that had no free room.) The advisor never suggests such a spot unless nothing else fits, and an enlargement with no chosen direction grows away from the queen's room.
2. Validity:
   - The footprint must be undug soil or existing tunnel. It must not overlap stone (unless `acid_excavation`), water or another chamber.
   - **Hidden water (ARCHITECTURE §18 C173):** a water pocket nobody has found yet is plain soil as far as the player knows: it never shows (no tint, no cross, no gap in the reserved-room works, no detour in a drawn tunnel) and never refuses a ghost. When a placement, relocation, level-up or tunnel is confirmed and its footprint, reserved room, route or exit shaft hits one, **"You struck water!"**: the pocket is revealed and that action is not made this time; the player picks again with the pocket in view. Blueprint chambers strike water the same way and then move to the nearest valid spot nearby whose whole reserved room can be dug today (no closed layer such as Bedrock before Acid Excavation, no water or uncut stone) and that a tunnel can reach (C218), or wait.
   - **Shafts do not block chambers** (ARCHITECTURE §18 C125). A footprint may cover shaft cells (main, nuptial or satellite shaft) except a shaft's **top two rows** (row 0, the entrance cell on the surface, and row 1 right below it), which always stay shaft. The covered cells become part of the chamber and the shaft passes straight through it: the entrance stays connected, path distances (haul, raid reach) run through the cavity, and the nest view draws the shaft continuing inside the chamber as a faint passage. The same holds for relocation, enlargement and blueprint chambers. Demolishing or moving the chamber turns its cells back into tunnel, so the shaft is whole again.
   - It must satisfy the chamber's row rule. The Build panel lists each chamber's rule ("Depth 24 or deeper", "Must touch a root", "Needs its own exit shaft"), the ghost's refusal names the numbers ("Must be at depth 24 or deeper (you are at 17)"), and the limit row is drawn as a line while placing.
   - It must connect to an open cell, either directly or via the auto-route.
3. Placement food is paid immediately. The cells join the dig queue. The chamber **activates at 100% excavated** and fills in visibly while being dug.
4. **Enlarge (from A):** a chamber's footprint grows with level up to L8:
   - **each level-up adds exactly one row or one column**, on one side: the height grows at L4 and L7, the width at every other level;
   - height `h = h0 + floor((min(L,8) − 1)/3)`;
   - width `w = w0 + (min(L,8) − 1) − floor((min(L,8) − 1)/3)`.
   - Example: a 3×2 Gallery becomes 8×4 at L8; the Royal Chamber is 7×3 at L5.
   - **A chamber with a reservation grows toward it in a fixed order** (C137): each level's footprint sits in the same corner of the reserved rectangle, so the last growing level fills it exactly; there is no side to pick. The inspect panel names the side and cells ("Grows one column to the left into its reserved space") and, when stone, water or a closed layer sits in the next row or column, why growth waits.
   - Chambers from older saves get a reservation on load when a corner-anchored full-size rectangle around them is free (the fewest obstacles wins; a Royal Chamber only an obstacle-free one, else its L5 room). A Royal Chamber saved with only its L5 room reserved gets its full-size room once, where an obstacle-free one is free (same corner first); otherwise it keeps the L5 room (C155). The others, and a Royal Chamber's levels past a kept L5 room, keep the legacy rule: the player picks the growth direction (left/right for a column, up/down for a row, `G` or the direction buttons) and sees the exact new cells before confirming. The new cells are queued, and that level's effect starts when they are dug.
   - Level-ups that do not grow the footprint (L > 8, or chambers marked "no growth") take effect immediately.
   - If every direction is blocked, the level-up button is disabled ("Blocked: relocate or clear space"). **Layout planning matters.**
   - **The queen's room is protected from growth.** While the Royal Chamber is below L5, another chamber may not grow into the last space the Royal Chamber needs to reach L5: such directions are not offered, and the level-up is refused with "Would wall in the Royal Chamber — level it to L5 first, or relocate." Only a deliberate placement or relocation can take that space, with the amber warning of step 1. The Royal Chamber's own growth stays inside a footprint it can still complete. The block lifts once it reaches L5 (ARCHITECTURE §18 C66).

### 7.5 Chamber cost model
- **Place** (L0→L1): `food = F_place × 2.5^k` (+ listed extras), plus dig work.
- **Level up** (L→L+1): `food = F0 × g^L × 2^k` and `soil = S0 × g^L × 2^k` (+ listed extras), plus growth-cell dig work.
- `k` is the instance index (0 for the first chamber of a type).
- `F_place = 4 × F0` unless the table lists it.
- There is no hard max level unless the table lists one; costs show MAX past 1e280.

### 7.6 Chamber table

| id | Name | Unlock | Max inst. | Footprint L1 | Placement rule | F_place | F0 | S0 | g | Max L | Effect per level |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `royal_chamber` | Royal Chamber | start (pre-dug, L1) | 1 (+1 `polygyny`, +2 `queens_council`) | 4×2, grows | Extra ones: row ≥ 20 | extra: 1e5 × 10^k | 50 | 90 | 2.20 | — | Lay ×1.15 per level above 1. L1 base: 10 housing, 150 food storage, 3 brood slots. **L5 required for the Flight.** |
| `gallery` | Gallery | first time housing is full (≥ 9 adults) | 4 (+2 `gallery_arches`) | 3×2, grows | row ≥ 1 | 40 | 10 | 24 | 1.30 | — | +11 housing per level. Each level above 30 adds `11 + (L − 30)` instead. Loam ×1.1. |
| `nursery` | Nursery | 8 adults | 3 | 3×2, grows | row ≥ 1 | 80 | 20 | 45 | 1.60 | — | +3 brood slots. Microclimate (§17.2). Adjacent to `royal_chamber`: +15% brood speed. |
| `granary` | Granary | food earned ≥ 120 or food cap reached | 3 | 2×2, grows | row ≥ 1 | 60 | 15 | 36 | 1.55 | — | Capacity `400 × 1.65^(L−1)` × layer modifier (clay 1.25 with spoilage, gravel 1.5, bedrock 1.75). |
| `scent_library` | Scent Library | 30 adults | 2 | 3×2, grows | row ≥ 1 | 600 | 150 | 120 | 2.00 | — | +0.05 insight/s. Gravel or deeper ×1.25. Adjacent to `royal_chamber` ×1.10. |
| `midden` | Midden | 120 adults | 2 | 2×2, grows | row ≥ 1 | 200 | 50 | 75 | 1.60 | 8 | Disease-event chance −10% (combined max −80%). +2% all output (additive group, combined max +20%). **Recycling (C103):** +0.05 chitin/s per level (× chamber efficiency: frost, hygiene; × the chitin channel). **Hygiene penalty:** a Nursery or Fungus Garden within 6 path cells gets −20%. |
| `barracks` | Barracks | `polymorphism` | 2 | 3×2, grows | row ≥ 1 | 1,200 | 300 | 150 | 1.70 | — | +8 soldier berths (soldiers only, C136). Soldier/supermajor ATK +5% (combined cap +50%). Within 12 path cells of an entrance: garrison deploys instantly and home AP +10%. |
| `war_hall` | War Hall | `supermajors` | 2 | 4×2, grows | row ≥ 30 | 25,000 | 6,250 | 2,500 | 1.80 | — | +4 supermajor berths (supermajors only; × colony_scale). Every supermajor egg needs a free War Hall berth (C136). |
| `root_aphid_pen` | Root Aphid Pen | `aphid_husbandry` | 2 | 3×2, grows | must touch a `root_line` cell | 1,600 | 400 | 240 | 1.75 | — | +0.05 honeydew/s passive (winter ×0.5). Herders +10% per pen. |
| `fungus_garden` | Fungus Garden | `fungiculture` | 3 | 3×3, grows | row ≥ 24 | 4,000 | 1,000 | 450 | 1.70 | — | +5 gardener slots (× colony_scale), +500 leaf cap, +1,000 fungus cap. Clay ×1.5. Adjacent to a Water Well +30%. |
| `repletion_hall` | Repletion Hall | `living_larders` | 2 | 3×2, grows | row ≥ 1 | 8,000 | 2,000 | 900 | 1.80 | — | +5 replete berths. |
| `hibernaculum` | Hibernaculum | `overwintering` | 2 | 4×2, grows | row ≥ 30 | 8,000 + 150 honeydew | 2,000 | 600 | 1.50 | 10 | Shelters 10 brood/level (× colony_scale) from frost. Winter upkeep −10% (combined max −50%). |
| `thermal_chimney` | Thermal Chimney | `ventilation_shafts` | 1 | 2×4, no growth | must touch row 0 | 6,000 | 1,500 | 600 | 2.00 | 6 | Winter forage penalty −10% relative (max −60%). |
| `gate` | Gate | first raid warning, or 25:00 | 1 | 2×2, no growth | must touch an entrance shaft, rows 0–6 | 2,000 + 20 chitin | 500 (+5 chitin × g^L) | 300 | 1.70 | 10 | Nest-fight defender HP +25%. Theft −10% (floor 2%). |
| `water_well` | Water Well | a water pocket is revealed | 1 per pocket | 2×3, no growth | must touch a `water_pocket` | 2,000 | — | — | — | 1 | Drought immunity. Adjacent Fungus Gardens +30%. |
| `nuptial_chamber` | Nuptial Chamber | `nuptial_preparation` | 1 | 5×3, grows | row ≥ 24, **plus its own exit shaft** to row 0 (any tunnel route that does not use the main shaft) | 20,000 | 5,000 | 1,500 | 2.00 | 4 (9 with `royal_court`) | Alate cells (§5.4). Reared alates are visible inside. The shaft creates the **second entrance hex** (§7.11). |
| `deep_vault` | Deep Vault | `acid_excavation` | 1 | 4×3, grows | row ≥ 58 | 1e5 | 25,000 | 15,000 | 2.50 | 8 | +1 h offline cap, +5% flight alates. |
| `carapace_store` | Carapace Store | chitin revealed, or `polymorphism` | 2 | 2×2, grows | row ≥ 1 | 600 | 150 | 90 | 1.60 | — | Chitin storage cap +300 × 1.6^(L−1) per Store (ARCHITECTURE §18 C179; the cap itself is C199). |
| `carapace_workshop` | Carapace Workshop | a built Barracks, or `phalanx` | 1 | 3×2, grows | row ≥ 1 | 3,000 + 30 chitin | 750 | 300 | 1.75 | 10 | Chitin from every source +10% per level (combined max +100%). Recycles 0.25 chitin per level from every soldier or supermajor that falls. |

All chamber effects are ×1.10 with `ventilation_shafts` and ×0.5 while frost-exposed in winter (§17.3). The Royal Chamber, Gate and Thermal Chimney are immune to frost.

### 7.7 Adjacency rules
Two chambers are **adjacent** if their footprints touch or are linked by a path of ≤ 4 open cells. Hovering a chamber draws faint link lines to its adjacency partners. A chamber that receives a bonus wears a small link badge (red for the Midden's hygiene hit) whose tooltip names the bonus and the partner; the placement and relocation ghost highlights the chambers it would link to and labels the gain or loss ("+15% brood speed (next to Royal Chamber)"); the Build list and inspect panel state each type's rules (ARCHITECTURE §18 C109).

| Rule id | Condition | Effect |
|---|---|---|
| `adj_nursery_royal` | Nursery adjacent to Royal Chamber | +15% brood speed for that nursery's share |
| `adj_library_royal` | Scent Library adjacent to Royal Chamber | That library ×1.10 |
| `adj_granary_repletion` | Any Granary adjacent to a Repletion Hall | Replete food-cap bonus ×1.25 |
| `adj_garden_well` | Fungus Garden adjacent to a Water Well | That garden +30% |
| `hyg_midden` | Midden within 6 path cells of a Nursery or Fungus Garden | That nursery or garden −20% |
| `prox_barracks_entrance` | Barracks within 12 path cells of any entrance | Instant deploy, +10% home AP |

### 7.8 Path distance: haul and raid reach
Path cells are measured by BFS over open cells, starting from the row-0 cell of the main entrance shaft.

- **Haul (from A, a single formula):**
  ```
  h = Σ(storage_cap_i × path_i) / Σ storage_cap_i / 24      [hex-equivalents]
  ```
  - Storage nodes are the Royal Chamber (150) plus granaries.
  - `h` is added to every main-entrance trail's effective distance (§8.5). Trails from satellites and outposts use `h = 0.5`.
  - Example: at the start the Royal Chamber is at path 20, so `h = 0.83`. Adding a shallow granary of capacity 440 (400 × 1.10 with `ventilation_shafts`) at path 8 gives `h = (150·20 + 440·8)/590/24 = 0.46`.
  - **Shallow storage = faster foraging. Deep storage = bigger and safer.**
- **Raid reach (from D):** a Granary or Nursery with any cell within **15 path cells** of an entrance can be robbed or hit in a lost nest defence (§9.10). The ghost overlay shades the reach zone red.

### 7.9 Soil features (seeded per run, from D and B)
| id | Count | Where | Effect |
|---|---|---|---|
| `root_line` | 6–10 | Hangs down from surface plants (flower patch, leaf plant, aphid colony) within ring 3. Column = the plant hex's x mapped to the 40 columns; reaches row 6–25, straight through any chamber in the way (C178). | `root_aphid_pen` must touch one (root cells inside a chamber count). Drawn as pale roots, hanging through chamber cavities. **Cultivated roots** (`root_cultivation`): the player picks a column; a root grows from row 1 at 2 rows/s down to row 30, through chambers, stopping above stone, water or a shaft. Cost 120 honeydew + 800 food, ×1.6 per cultivated root this run; at most 3 (+1 per 5 Mound levels, up to +3). They count as root lines and are drawn slightly greener. |
| `stone` | 4–8 | Boulders of varied shapes (C181): pebbles 1×1, bars 2×1, blocks 2×2, slabs 2×3, L-shapes, irregular blobs of 3–6 cells, the odd 3×3; rows 8–55, never in the Royal Chamber's growth zone. Coloured by stratum (flint, rust-banded ironstone in clay, speckled granite in gravel, slate in bedrock). | Undiggable until `acid_excavation` (then ×3 work per cell). |
| `cache` | 8–12 | Single cells, rows 5–60 | `seed_cache`: food = 90 s (min 50). `beetle_husk`: chitin = max(25, 60 s of chitin income). `fossil`: insight = max(50, 60 s of insight income). `amber_bead` (1 per map, bedrock only): spawns a Golden Beetle immediately and unlocks the Field Guide entry `fg_amber`. **Hint:** the cell shows as discoloured soil when any open cell is within 4 cells (Chebyshev). Collected when dug. Clicking a hint queues a tunnel to it. |
| `water_pocket` | 2–3 | 2×2 to 3×3, rows 40–70 | Cannot be dug. `water_well` must touch one. Revealed like caches: shown when any open cell is within 4 cells, or when a placement or dig strikes it (C173: until then it is plain soil to the player). With `drainage`, a revealed pocket can be **drained** (dig work 2 × layer work and 120 soil per water cell; the cells become diggable soil) or **moved** to plain soil of the same size anywhere in the nest (C255: no distance limit) (1.5 × layer work per water cell; the pocket's own cells count as free, so it can move a single tile, C140; never into a reserved room). The new spot may cover open tunnel cells when filling them in would cut nothing off (no chamber, dig job, planned blueprint chamber or entrance loses its connection); they are filled as part of the move for 1 × their tunnel work each (C157). Never over chambers, shafts or other pockets. A Water Well left touching no pocket is removed and its placement food refunded in full. |

### 7.10 Microclimate and frost
Layer × season modifiers are in §17.2, and the frost line rules are in §17.3. The ghost tooltip and the **Climate overlay** (toggle) preview both, so the player sees why a nursery belongs at row 26 and a granary at row 6.

### 7.11 Entrances and the two-view seam (from D)
- **The seam is the entrance.** The top cell of each shaft is a hex on the Above map.
  - An ant sprite entering a shaft top despawns and respawns on the matching entrance hex in the same frame, and vice versa, so the stream looks continuous.
  - On wide layouts a thin animated "shaft connector" graphic joins the two canvases at the entrance.
- `main_entrance` is shaft column 20, mapped to surface hex `(0,0)`.
- `nuptial_entrance`: when the Nuptial Chamber's exit shaft reaches row 0 at column `c`, a second entrance hex appears.
  - It sits west if `c < 20`, otherwise east, at distance `1 + floor(|c − 20| / 8)` from `(0,0)`. If that hex is impassable, the nearest passable hex is used instead.
  - Trails can start there. Alates launch from it during the Flight ceremony.
- `satellite_entrance` (Supercolony layer):
  - Each satellite is placed on an owned hex at least 3 hexes from other entrances.
  - It adds a shaft column chosen by the player (≥ 4 columns from other shafts), which is dug from row 0 as a queued job.

### 7.12 What the player can click in the nest
| Target | Action |
|---|---|
| Stone | Tooltip: "Stone", whether it can be dug or built on now, else that Acid Excavation research allows it (C251). |
| Empty soil | Drag from an open cell across soil to dig a tunnel. Drop a chamber ghost from the Build panel. Any other drag scrolls (and pans when zoomed in). |
| Reserved cell | The fresh-dug space a chamber will grow into: selects and inspects that chamber (C154). |
| Chamber | Open the inspect panel: level up (with direction), relocate, demolish, see modifiers. The panel says exactly what the next level gives for that chamber ("+11 housing (33 → 44)", "Granary capacity 660 → 1.08K"), its cost, dig work and which side it grows (C107). Hover shows adjacency links. The panel opens with one or two sentences on what the chamber does (C141). A small green ▲ under the level badge marks a chamber whose next level is affordable right now (food and soil, growth not blocked); it hides at overview zoom, and the tooltip says "Upgrade affordable" (C156). Keys: `L` level the cheapest chamber of that type, `Shift+L` level this one (C142), `Q` place another of its type, `G` pick the growth side (older chambers without a reservation), `R` relocate (C108). |
| Active dig face | **Help Dig**. |
| Nursery | **Groom Brood**: each click adds 1% × that nursery's share of all brood slots to the development of every brood cohort in the colony (a nursery with 56% of the slots: +0.56% per click). Counts toward the 15 clicks/s cap; not allowed in the Claustral Founding hardship (ARCHITECTURE §18 C20). |
| Queen | Status card. Counts toward the secret achievement `ach_queens_favorite`. |
| Golden Pupa | Claim Frenzy or Windfall (§18.3). It pulses gold in a Nursery (or the Royal Chamber while there is none) with a "Golden pupa: click" tag and a ring that empties over its 15 s (C217). |
| House pip | The yellow house with "!" over the Royal Chamber while housing is full: its tooltip says eggs wait for room and to build or level Galleries; a click opens the Build tab (C216). |
| Mold spot | Scrape it off (Mold Bloom event). |
| Flood water | Bail: −5 s of flood time per click. |
| Cache hint | Queue a tunnel to it. |
| Water pocket | Inspect: drain or move it (with `drainage`). |
| Planned blueprint chamber | Inspect: cancel it for this run (the Blueprints section also cancels all). |
| Queue chips | Reorder or cancel (cancel refunds 100% of placement food; dug cells stay dug). |
| Overlay buttons | `climate` (season and frost), `raid_reach`, `haul`, `adjacency`. |

### 7.13 Visual feedback (MUST)
- Seed piles in granaries rise with fill %. Clay granaries show mould flecks while spoiling.
- Nurseries show up to 30 brood sprites by stage: white eggs, curled larvae, cocooned pupae. Frozen brood is drawn frosted.
- The queen's abdomen pulses with each egg. She grows slightly with Royal Chamber level.
- Fungus Gardens grow fuzzy white domes in proportion to stock, and turn grey under blight.
- Repletes hang amber from ceilings and swell with the cap bonus.
- Reared alates line the Nuptial Chamber, with wings visible.
- Diggers carry soil pellets up the shaft and drop them on the Mound in the Above view.
- **The dig face is worked visibly (C180):** wherever the first queued job digs (a tunnel, a new chamber, a chamber growing into its reserved room, a shaft), two workers stand at the face with their heads bobbing, the face cell is bitten out from their side as its work completes (so a room opens up cell by cell), two carriers walk soil pellets back along the passage and a small spoil heap sits at their feet. Under reduced motion the crew stands still.
- An overloaded Midden darkens. The frost line is a crisp blue-white edge moving down the rows. In winter a frost-exposed chamber (more than half its cells above the line; exactly half is safe) wears an icy dashed outline and a small ❄ badge, and its tooltip counts the cells (C213).
- The queen's abdomen glows softly with each batch of eggs (toned down, none under reduced motion, C217).
- Chambers look more impressive as they level (C159): L1–2 keep their plain set dressing; L3–6 add wall carvings, supports and more of their contents; L7+ add an ornate trim along the vault, glowing wall lamps, an emblem and more contents again. Every chamber type has its own colours, support material and floor items.

---

## 8. The surface (the "Above" canvas, top-down hex map)

### 8.1 Grid
- Pointy-top axial hexes, 26 px logical, with pan and zoom from 0.6× to 2.75× (C163; was 1.6×). Icons and the terrain stay crisp at the closest zoom: on high-DPI screens the terrain and territory caches switch to a finer resolution while zoomed in past 1.6×.
- **Default view:** the nest centred with rings 0–3 (the start reveal and the crumb) at a comfortable size: filling the width on a phone, up to 1.35× on wide screens. It is re-applied at layout changes until the player pans or zooms, and at every run start.
- Map radius:

| Condition | Radius | Hexes |
|---|---|---|
| Start | 8 | 217 |
| After `sun_compass` | 12 | 469 |
| After Federation `regional_expansion` | 16 | 817 |

- Ring `r` = hex distance from `(0,0)`.
- The map is regenerated from the run's landing-site seed after each Flight (§13.6).

### 8.2 Terrain
| id | Share | Move cost | Notes |
|---|---|---|---|
| `grass` | ~58% | 1.0 | — |
| `sand` | ~8% | 1.25 | — |
| `leaf_litter` | ~12% | 1.5 | Leaf plants spawn here. |
| `garden_path` | ~4% (1–2 strips) | 0.5 | Fast trails. Footstep events land here. |
| `tree_root` | ~4% (clusters) | 1.0 | Aphid colonies spawn here. |
| `stone` | ~6% | impassable | — |
| `puddle` | ~6% | impassable in spring, 1.0 otherwise | Dries in summer. |
| `log` | 0–1 | 1.0 | `fallen_log`: prey ×2 within 2 hexes (carpenter ants nest here). |

Adjacent puddle hexes draw as one pool (shore only on its outer edge) and adjacent garden-path hexes as one continuous paved strip with rounded ends, both on the surrounding ground (ARCHITECTURE C111). Adjacent stone hexes draw as one big boulder: a single irregular, shaded and cracked rock mass over their union on the surrounding ground; a lone stone keeps its own pebble art (C135). Terrain features are drawn only inside the map radius, and each stays inside its own hexes, so the fog and the map edge hide them exactly like plain ground (C135). Each hex keeps its own ground with a clean hex edge (no blended borders between grounds); a garden path runs straight from hex centre to hex centre as flagstones; a boulder shows seams where its stones joined plus a hairline crack per stone (ARCHITECTURE C240, which replaced the blended look of C183 by player choice).

`d` = A\* path length weighted by move cost, ×0.9 with `double_bridge`.

The player sees these effects: hovering a revealed hex says what its ground does to trails ("Sand — slow ground: counts as 1.25 hexes for trails.", "Garden path — fast ground: counts as 0.5 hexes for trails.") plus any note (leaf plants, aphids, footsteps, prey near a log, spring floods), and the Manual's **Terrain** entry lists every terrain with its trail cost and effect (C165).

### 8.3 Fog of war and scouting
- Rings 0–2 are revealed at the start (rings 0–4 with `keen_antennae`).
- The scout force produces `scouts^0.6` scout-seconds per second in total (×2 with `antennation`, ×2 with `keen_antennae`). The exponent below 1 keeps a mass of scouts from revealing the whole map in five minutes, so exploration (and its insight) is spread over the run.
- Revealing one hex at ring `r` costs `10 × r^1.2` scout-seconds:

| Ring | 1 | 3 | 5 | 8 | 12 |
|---|---|---|---|---|---|
| Scout-seconds | 10 | 37 | 69 | 121 | 197 |

- `antennation` doubles scout speed.
- Scouts take the nearest frontier hex first. A flagged hex (click) gets 3× priority.
- Each newly revealed hex grants `insight = 0.75 × ring × (1.5 with antennation) × M_insight` (§12.5). This is Insight's main early source, so **exploring the surface fuels research**.
- First sight of a source or rival type that has a Field Guide entry unlocks it (§20).
- **Expeditions (C188).** Once every hex inside the map is revealed, scouts go beyond the border instead of idling. Their work (the same `scouts^0.6` scout-seconds) builds expedition progress; every 240 scout-seconds (×2 for each further find, at most 2 finds per season) brings back a rare find on a free hex of the map's edge ring, lasting 5 min: a **rich seed patch** (1 food per forager), a **beetle carcass** (0.3 food + 0.05 chitin per forager), a **fossil cache** (click: max(40, 120 s) of insight) or a **lost queen** (click: lay ×1.5 for 2 min). Weights 3 / 3 / 2 / 1. Offline the work banks up to one find, placed on return. The Map tab shows the progress. The scouts' raid-warning bonus is unchanged.

### 8.4 Sources
`r(d) = 1 + 0.35 × (d − 1)` is the richness at path length `d`. The slope is 0.5 with `odometer_navigation`.

| id | Spawn | Yield per worker `Y_src` | Capacity `c` | Stock | Special |
|---|---|---|---|---|---|
| `crumb_scatter` | ring 1, always 1 | 0.5 food | 10 | ∞ | Tutorial glow. Clicking it hand-forages. |
| `seed_patch` | 3 per map, ring 2–5 | 0.5 food | 15 | max = max(300, 300 s of *current* gross food/s), re-evaluated every tick; regrows 1%/s of max | Autumn ×2. `ev_seed_mast_year` ×3. A renewable staple: sizing the max only once at discovery made the ring-2 patch (seen at 0:00) a dead 3 food/s source for the rest of the run, and left flowers (0 in winter) as the only renewables. |
| `flower_patch` | 2 per map, ring 3–6 | 0.55 food + 0.005 honeydew | 20 | ∞ | Summer ×1.5. Winter 0. Drought ×0.3. |
| `dead_insect` | random: 1 per 3 min (max 2 at once), ring 3–8 | 0.6 food + 0.01 chitin | 20 | max(150, 90 s food) | Despawns when empty or after 6 min. |
| `leaf_plant` | 4 per map, ring 2–8 on leaf litter | 0.3 leaves (leafcutters) | 20 | ∞ | Spring ×1.25, summer ×1.5, autumn ×1.25, winter 0. Drought ×0.5. |
| `aphid_colony` | 3 per map, ring 3–7 on tree roots | 0.08 honeydew per herder | 8 × level (level 1–3) | ∞ | +1 level per 6 min while ≥ 50% herded. Winter 0. Target of Ladybug events. With `aphid_shepherding` it can be moved to an owned plant hex: right-click it (or its Map-tab card) → "Move aphid colony…", then click a tinted hex (C237). |
| `prey_caterpillar` / `prey_cricket` / `prey_beetle` | random: 1 per 6 min, ring 4–10 | hunted | — | One-shot: 60 s food + 15·r chitin (cricket ×2, beetle ×4) | Hunting party AP ≥ 50·r / 200·r / 800·r. Despawns after 5 min. |
| `fallen_fruit` | event, ring 3–6 | 2 food | 30 | max(500, 180 s food) | After 4 min it rots at −1% stock/s. Lands only on a revealed hex a trail can reach (C221). |
| `picnic_spill` | event, ring 6–12 | 5 food | 60 | max(2,000, 600 s food) | Contested: −30% yield unless ≥ 1 escort per 10 foragers. |
| `termite_mound` | 1 per map, ring 9–12 (visible after `sun_compass`) | raid only | — | Per raid: 120 s food + 50·r chitin; 5 min cooldown | Neutral defender, AP 28,300. |
| `lycaenid_caterpillar` | `lycaenid_clients`; 1–2 per map, ring 3–6 | — | — | 0.3 × ring honeydew/s (× honeydew multipliers) | Milked by a trail that carries no workers (it uses a slot) and pays only while ≥ 5 escort soldiers are on it (real ant–butterfly mutualism). |
| `rich_seed_patch` | scout expedition find (§8.3), edge ring | 1 food | 20 | max(600, 240 s food) | Lasts 5 min. Drawn as a seed patch with a gold rim. |
| `beetle_carcass` | scout expedition find (§8.3), edge ring | 0.3 food + 0.05 chitin | 20 | max(250, 90 s food) | Lasts 5 min. A chitin source. |
| `harvester_stash` | 1 per conquest, inside conquered territory | 2.5 food | 20 | max(800, 300 s food) | Spoils of war. Capacity 20 like other rich sources: at 80 it absorbed every over-saturated forager and multiplied gross food ×5–10 for a minute, and every income-seconds reward in that minute (a Golden Beetle Windfall is 600 s) with it. |

Finite stocks are sized at discovery (the moment the source is first visible: at spawn on a revealed hex, otherwise when its hex is revealed) as `max(base, k × gross food/s)` (A), so they stay meaningful all game. A stock is counted in the source's main resource (food for every finite source). Seed patches are the exception: their max is re-evaluated every tick (above). In this table `r` in prey, termite and Lycaenid entries is the source hex's ring.

Hovering a source says what it gives and how much is left (C184): "Food 0.6 + Chitin 0.01 per forager", its capacity, "Stock 120 / 150 food: gone when empty." (or regrows / never runs out), its time left, this season's factor, and for an aphid colony its level and progress to the next ("Level 2 / 3: 45% to level 3", +1 per 6 min while at least half its capacity is herded).

### 8.5 Trails (A's economics + B's traffic-driven strength)
- **One trail per destination:** a source can have only one trail leading to it (C100). To put more ants on it, add workers to that trail.
**Drawing.**
- Drag from an origin to a target hex. **Every trail starts at an entrance**: the main one, an outpost, a satellite or the nuptial exit. Trails never fork from other trails (C132; saves with old forks re-route each one from the entrance with the shortest route on load, keeping its workers, escorts and strength, or drop it with a message if nothing can reach it). Deleting a trail therefore never strands another.
- Where several trails use the same hexes, they are drawn as parallel lanes (ordered by trail id, merging and splitting smoothly where the routes join or part), and each trail's ants walk their own lane (C134).
- **Temporary obstacles (C182).** When a molehill appears on, or a spring puddle floods, a hex an existing trail passes through, the trail takes a free, temporary detour round it (the rest of its route stays as drawn) and goes back to its own route as soon as the hex clears. If there is no way round, the trail pauses (no workers, no yield) until the way clears. The trail row and the map mark it (Detour / Paused); a player reroute makes the new route the trail's own.
- A\* auto-routes, and the player can drag waypoints to reroute. Stone (and puddles in spring) are impassable; the drawn trail line is smoothed but never cuts across an impassable hex, and the ants walk the same line (ARCHITECTURE C128). Hovering a stone hex says "Stone — impassable. Trails route around it." (C129).
- The tool previews `d`, yield per worker, capacity and saturation.
- **Trails are free to draw and reroute.** They are limited by **trail slots** (the Map tab and the Above view show "Trails 7 / 11", used / available):

| Source | Slots |
|---|---|
| Base | 3 |
| `trail_memory` | +1 |
| `sun_compass` | +2 |
| `mass_recruitment` | +2 |
| Mound levels 3, 6 and 9 | +1 each |
| Each outpost | +1 |
| Each satellite | +1 |

- Workers are assigned per trail with +/− buttons or drag. Unassigned foragers auto-fill the best unsaturated trail (chitin-yielding trails first while chitin is needed for soldier eggs, §5.5, C104).

**Yield of one trail.**
```
out = Y_src × r(d) × n_eff × eff(d_eff) × (1 + S/100) × terr × season_src × [A_add × M_run × M_time × M_prestige]   (§12)

d_eff   = d + h                                          (haul, §7.8)
eff(x)  = 1 / (1 + (x − 1) / D_nav)
D_nav   = 3 + 1·tandem_running + 2·mass_recruitment + 3·odometer_navigation + 0.25·long_legs + 5·highway_network
n_eff   = n                       if n ≤ c_eff
        = c_eff × (1 + ln(n/c_eff)) otherwise
c_eff   = c × max(1, adults/100)^0.8                      (×2 for herders with aphid_shepherding)
terr    = 1.25 if the source hex is owned; × (1 − 0.05 per rival-territory hex on the path) unless escorted (≥ 1 escort soldier per 10 workers)
trunk   = with trunk_trails: 1.5 if the path has ≥ 5 hexes (else 1), × (1 + 0.25 × shared)            (part of M_run, §12.1)
shared  = fraction of the trail's hexes after its entrance that at least one other trail also covers (C132)
```
**Trunk Trails overlap (C132).** Shared stretches are stronger: a trail whose hexes (not counting its entrance hex, which every trail from that entrance shares) are all also on another trail earns ×1.25; half shared, ×1.125. Each trail sharing the stretch earns its own bonus. Lycaenid milking trails count as partners but take no bonus. The trail list shows "shared N% ×M".
Herder and leafcutter trails use the same formula with their own `Y_src`.

**Trail strength S (pheromone, traffic-driven, from B).**
- Equilibrium: `S_eq = 100 × n / (n + 15 × d)`.
- Strength moves toward equilibrium: `dS/dt = (S_eq − S) × ln 2 / t_half`.
- `t_half` = 45 s (90 s with `persistent_trails`). `double_bridge` halves `t_half` while S is rising.
- `S_max` = 100 (150 with `persistent_trails`).
- Rain resets S to 0 (not with `weather_sense`). An unguarded raid gives S −30.
- **More ants make a stronger trail, and a stronger trail makes each trip faster.** That is real mass-recruitment feedback, and it is visible: trail line width = `1 + log10(workers)` px (clamped 1–6), and opacity = `S / S_max`.

**Research turns distance into value.** Output relative to a d = 1 trail, from `r(d) × eff(d)`:

| d | 1 | 2 | 4 | 6 | 8 |
|---|---|---|---|---|---|
| D_nav = 3 | 1.00 | 1.01 | 1.02 | 1.03 | 1.03 |
| D_nav = 9 | 1.00 | 1.21 | 1.54 | 1.77 | 1.94 |

Early on, far sources are roughly neutral and worth visiting only for their stock. With research they are worth twice as much, which pushes expansion outward, straight into rival land.

**Worked example.**
- Setup: 10 foragers on a seed patch at d = 3. The default strength is at equilibrium, `S = 100·10/(10+45) = 18.2`, and `h = 0.5`.
- Calculation: `0.5 × 1.70 × 10 × eff(3.5) [= 0.545] × 1.182 = 5.48 food/s`, before multipliers.

**Trail abilities (cost pheromone).**

| id | Effect | Cost | Cooldown | Unlock |
|---|---|---|---|---|
| `mark` | +25 strength on one trail (up to S_max) | 5 | 3 s | `scent_marking` |
| `rally` | One trail ×2 output for 30 s (60 s with `mass_recruitment`) | 20 | 120 s | `recruitment_pheromones` |
| `frenzy` | All trails ×2 for 20 s | 60 | 120 s | `frenzy_signal` |
| `mass_recruit` | During a Termite Swarm or Picnic: move 50% of idle and loose foragers to the event source | 20 | — | `scent_marking` |

**Loose foraging:** foragers with no trail at all produce 0.1 food/s each, before multipliers.

### 8.6 Territory
**Owned hexes** are the union of four sources:
1. **Auto:** radius `1 + floor(mound_level / 5)` around each entrance, outpost and satellite.
2. **Claimed:**
   - Which hexes: any revealed hex adjacent to owned land and not rival territory.
   - Cost: `10 × 1.06^claimed` pheromone (claimed 10 → 18, 30 → 57, 50 → 184, 80 → 1,059).
   - If the cost exceeds the current cap, the claim becomes a **channel**: pheromone drains into it at full regen until paid. Cancelling refunds everything.
3. **Conquered:** every hex of a destroyed rival's territory.
4. **Trunk:** with `trunk_trails`, every hex of every trail you have, whatever its length or entrance (C133: the earlier "length ≥ 5" gate left short trails from outposts, satellites and the nuptial exit unowned, while short trails from the main entrance only looked owned because they lie inside its auto radius).
   - Trail-held hexes are **temporary**: they are lost when the trail is deleted or rerouted away. They count as owned land for every benefit and for claim adjacency, and they **can be claimed** at the normal claim cost, after which they stay owned without the trail (C162; claiming them used to be refused as "already your territory").
   - On the map they are drawn apart from permanent land: a paler tint with a fine diagonal hatch and a dashed border, while the solid amber border runs round permanent land. The territory overlay legend calls them "Held by trail", and hovering one says "Held by trail — claim to keep."

**Benefits.**
- +0.5% to all surface yields per owned hex (additive group, max +100%).
- Sources on owned hexes ×1.25.
- Trails entirely inside owned land cannot be raided.
- `t_peak` feeds the Alate formula (§13.2). It counts **permanent** land only (auto radius, claims, conquests, tournament wins): trail-held hexes (Trunk Trails) are temporary and do not raise it, so they cannot be farmed for alates by drawing long trails; claim them to keep them (C222).

**Borders.**
- **Rival land never covers an entrance** (main, nuptial exit, satellite, outpost) **or its auto-claim radius**, at any Mound level; the rival keeps only its own nest hex there (C224). The auto radius grows with the Mound and used to lose to older rival land, which could leave an outpost inside enemy territory.
- Rival territory radius is the per-rival value in the §9.2 table (2 or 3; elder colonies 3). Bosses use 3, and each Argentine Front nest uses 3. (An earlier `1 + ceil(tier/2)` formula disagreed with the table for tiers 4–6; the table wins.)
- Owned hexes adjacent to rival land are **border hexes**. Trails through them are raid targets at ×2 chance.
- Fire ants creep: they gain 1 unowned hex every 3 min (not in winter).
- Border hexes are where Ritual Tournaments happen (§9.7).

### 8.7 Mound (grows with the colony; ARCHITECTURE §18 C220)
- **Unlock:** soil ≥ 300 for the first time; from then on it grows by itself. Levels 6+ need `mound_building` (the Mound waits at L5 until then and catches up at once when the research lands).
- **Growth (no purchase):** `value = 4·log10(1 + A/100) + 2.5·log10(1 + C/20) + 1·log10(1 + D/200)`, level = `floor(value)`, where A = the run's peak adult count, C = the summed levels of the active chambers, D = cells dug this run. Every term is logarithmic, so each further level needs more colony than the last (diminishing returns); the level never goes down within a run. It replaces the old soil purchase (`300 × 1.9^(L−1)` soil): soil was a sink nobody wanted to feed by hand, and the Mound now simply tracks how big and built-out the colony is. Saves from before keep their level as a floor.
- Typical run-1 levels (pacing bot, seed 1): L1 ≈ 4 min (≈ 80 adults), L3 ≈ 6 min, L5 ≈ 10 min, then it waits for Mound Building (≈ 24 min: straight to L7), L8 ≈ 28 min, L9 ≈ 80 min (≈ 2,100 adults). Later runs: about L15 at 10⁵ adults, L20 at 10⁶. The old bot bought L9 at ~42 min and L10 at ~62 min; levels 1–6 now come earlier and 9–10 later.
- The Build tab shows the level and a labelled bar to the next one ("Progress to Mound L5: 45%", or "waiting for Mound Building"), with a line naming what feeds it: peak adults, chamber levels and cells dug, each with the levels it adds (C251); the Mound autobuyer is gone (its saved switch is removed from old saves, C246).
- **Per level:**
  - +5% home AP.
  - −3% winter forage penalty, relative (max −30%).
  - Frost line −1 row per 3 levels (max −6).
- **Milestones:**
  - Levels 3, 6 and 9: +1 trail slot each.
  - Every 5 levels: +1 auto-claim radius.
  - From L5, Footstep events cannot hit the 7 hexes of the main entrance.
  - As the auto-claim radius grows, the territory round every entrance widens over the run (rival land never covers it, §8.6).
- The mound sprite rises smoothly with the growth value (level + progress to the next), and dug soil pellets land on it.

### 8.8 Outposts, satellites and escorts
- **Outpost:** a conquered rival mound. It is a trail origin, gives +1 trail slot, and auto-claims radius 1 (+1 per 5 Mound levels, like every entrance, §8.6).
- **Satellite** (Supercolony layer, §14.5):
  - An extra entrance hex with its own shaft in the Below view. It is a trail origin and gives +1 trail slot.
  - Network bonus: +25% food and dig in the additive group.
- **Escorts:** soldiers assigned to a trail.
  - They remove the rival-territory yield penalty and the picnic contest at 1 escort per 10 workers.
  - They defend that trail against raids, ×1.5 AP with `phalanx`.
  - Exactly 5 escorts milk a Lycaenid caterpillar; a Lycaenid trail holds at most 5 (more add nothing, so the stepper and the menu stop at 5 and the command refuses more; C236).

### 8.9 Map generation (per run, seeded)
1. Terrain from seeded value noise, using the shares in §8.2.
2. Guarantee a passable route from `(0,0)` to every source.
3. Sources per §8.4. Landing-site tags (§13.6) adjust the counts.
4. Rivals:
   - Tier 1 at ring 4–5 and tier 2 at ring 6–7 (tiers 2 and 3 with the `site_hostile_neighbours` tag).
   - Max concurrent rivals: 2 / 3 / 4 at radius 8 / 12 / 16.
   - After a conquest, a replacement rival spawns 10–20 min later in the outermost ring band, at tier = highest tier conquered this run + 1.
5. Plants within ring 3 seed the Below view's root lines (§7.9).
6. Daughter-colony sprites from earlier flights sit at the map edge (§14.6).

### 8.10 What the player can click on the surface
| Target | Action |
|---|---|
| Source hex | Hand-forage: `+click value` food (§10). Open source info. |
| Drag from an origin | Draw a trail (even when an event object such as a myrmecophile guest sits on the entrance: a drag draws, a plain click hits the object; C110). Drag a trail's waypoints to reroute. Dropping on a rival nest, prey or the termite mound opens the war-party chooser (sliders, live odds, Launch). |
| Trail | Select: +/− workers, escorts, Mark, Rally, delete. Right-click a Lycaenid trail or its caterpillar: "Add escort (+1) · Escorts N/5", "Add escorts up to 5" (C185, capped at 5 by C236). Right-click an aphid colony with Aphid Shepherding: "Move aphid colony…" arms a tool that tints the owned flower / leaf hexes it may move to (C237). |
| Hex | Info. Claim (or start a channel). Flag for scouting. Place a satellite or tournament where allowed. While the satellite tool is active, valid hexes are tinted green and the rest greyed out, and hovering a hex says why it fails (for example "Too close to an entrance: 1 hex away, satellites need 3+"). |
| Rival nest | War panel: Raid / Assault / Tournament / Bribe, with the live odds preview (§9.5). |
| Prey / termite mound | Hunt or raid panel with preview. |
| Golden Beetle | Claim reward (§18.3). |
| Event objects | Footstep shadow (scatter), rival alates (catch), ladybugs (shoo), horned lizard (mob). Antlion pit: click or right-click "Send 3 soldiers to clear" at any time while it is there, with the card's rule (C185). Scout finds: fossil cache, lost queen (click). |
| War party marker | Recall, Reinforce. |
| Overlay buttons | `territory`, `trail_strength`, `danger` (raid targets and border hexes), `richness`. |

### 8.11 Ambient life (C161)
The Above map is alive even when nothing happens. This is purely visual (no gameplay effect) and cheap: it is drawn each frame only for the sources and event objects on screen, and the terrain itself stays a static cached picture.
- Seed, flower and leaf patches and the aphids' stems sway in a wind that rolls across the map, so neighbouring plants lean together. The wind is stronger in autumn (up to ×1.6) and in rainstorms (×1.8) and almost still in deep winter (×0.1).
- Live prey crawls a little to and fro; beetles twitch their antennae, crickets hop now and then. Caterpillars (prey, Lycaenid, Phengaris) inch with a body wave. Dead insects stay still, with a fly buzzing over them that lands from time to time.
- Termites mill round their mound; winged termites flutter over a termite swarm. Molehills puff a little soil every 6–9 s.
- Every object has its own fixed phase, so nothing moves in lockstep. **Reduced motion** turns all of it off.

---

## 9. Rivals and combat

### 9.1 Army Power (Lanchester square law, from A)
```
AP = Σ_groups n_i × √(ATK_i × HP_i) × modifiers
```
Because strength scales with the **square** of numbers, splitting an army is punished. Concentrate your forces. The Field Guide entry `fg_square_law` explains this (Franks & Partridge, 1993).

| Unit | ATK | HP | √(ATK·HP) |
|---|---|---|---|
| militia minor | 0.5 | 4 | 1.41 |
| soldier | 4 | 20 | 8.94 |
| supermajor | 30 | 250 | 86.6 |

Unit ATK and HP multipliers are listed in §12.6.

### 9.2 Rival ladder
| id | Name | Tier | Base soldiers | ATK / HP | Base AP | Territory radius | Raid interval (mean) | Trait |
|---|---|---|---|---|---|---|---|---|
| `black_garden_ants` | Black Garden Ants (*Lasius niger*) | 1 | 15 | 3 / 15 | 101 | 2 | 8 min | — |
| `pavement_ants` | Pavement Ants (*Tetramorium*) | 2 | 60 | 4 / 20 | 537 | 2 | 6 min | `swarm`: +20% AP when their committed count exceeds yours |
| `red_wood_ants` | Red Wood Ants (*Formica rufa*) | 3 | 200 | 6 / 30 | 2,683 | 3 | 5 min | `acid_volley`: your AP ×0.9 before battle (cancelled by `formic_acid`) |
| `carpenter_ants` | Carpenter Ants (*Camponotus*) | 4 | 400 | 10 / 60 | 9,798 | 2 | 12 min | `home_fortress`: home bonus ×1.5. Nest sits on a fallen log. |
| `fire_ants` | Fire Ants (*Solenopsis invicta*) | 5 | 1,000 | 8 / 25 | 14,142 | 3 | 4 min | `venom`: your HP ×0.8. `border_creep`. |
| `slave_makers` | Blood-red Slave-makers (*Formica sanguinea*) | 6 | 600 | 12 / 50 | 14,697 | 2 | 7 min | `brood_raiders`: raids go to your nest and **steal** pupae; conquering them returns 3× the captured workers |
| `elder_colony` | Elder Colony (procedural) | k ≥ 7 | AP ÷ √(ATK·HP) | 12·1.2^(k−6) / 60·1.2^(k−6) | **15,000 × 4^(k−6)** (k7 60K, k10 3.84M, k15 3.9e9) | 3 | 6 min | 1–2 random traits from the list above |

- **Rival growth:** soldiers +1%/min (+3%/min in summer), up to ×3 of base. Rivals are dormant in winter, and frozen offline.
- **No rubber-banding.** Rival strength never scales with player power. Difficulty comes only from the fixed ladder, the elder tiers, the landing-site tags, and the boss multipliers tied to layer count (§9.3).

### 9.3 Bosses
| id | Name | Appears | AP | Rules | Gate for |
|---|---|---|---|---|---|
| `old_ridge_supercolony` | The Old Ridge Supercolony | Once `budding` is owned and `alates_cycle ≥ 2,500`, at the outer ring | `1e6 × (1 + m)^1.5` (m = Supercolonies completed, all-time) | Immune to assault until you own ≥ 25 hexes. Raids every 6 min. | Supercolony (§14.1) |
| `great_rival` | The Argentine Front (*Linepithema humile*) | Once Federation `megacolony` is owned | `1e8 × 10^s` in total, split over **3 nest hexes** (s = Speciations completed) | All 3 nests must be conquered within 10 min of the first conquest, or the fallen nests regrow. Raids every 3 min. | Speciation (§15.1) |
| `army_ant_column` | Army Ant Column (*Eciton burchellii*) | Event (§18) | `43,000 × (1 + m)^1.5` | Crosses the map in 90 s. | — (loot if defeated: 1,800 s of food + max(2,000, 600 s) chitin, as in §18.2) |

Boss AP values are tuning knobs. The pacing bot (§28) checks that each boss is beatable inside its layer's time window.
- Each boss spawns at most once per run (at run start if its condition already holds). A conquered boss does not return that run.
- The Army Ant Column used `× 10^m` before the reconciliation pass. That passes 1e300 after about 290 Supercolonies and outgrows every polynomial player curve, so it now scales like the Old Ridge.
- The Old Ridge AP base was `3e5` before the re-tune pass. Once later runs stopped being capped by the tick length (bug-hunt fix F23), the bot beat it 12–53 min after it appeared and merged at 4:32–4:52. At `1e6` the first Supercolony lands at ~5:30–6:00 (bot), inside its 4.5–10 h window with an hour of margin.
- The Argentine Front grew `× 100` per Speciation before the re-tune pass. In the meta-model that walls the 5th Speciation for ~23 weeks, so the ending slips to ~28 weeks. At `× 10` the player's AP stays 10–230× above the Front at each Speciation (meta-model): the Front stays a real fight but never walls an era. At `× 20` it walls the 7th Speciation for ~3.5 weeks. `10^s` reaches 1e295 only at s = 287.

### 9.4 Actions against rivals (from the rival war panel)
| Action | Engages | Your requirement | Reward on win | On loss |
|---|---|---|---|---|
| `raid` | 40% of current defenders, no home bonus | A war party (soldiers/supermajors) | Food = 30 s × √tier of food income (min 50·tier). Chitin = 0.5 × tier per enemy killed. The rival loses the killed soldiers. | Party destroyed |
| `assault` | 100% of defenders with home bonus ×1.25 (×1.5 carpenter) | War party | **Conquest:** nest destroyed; all its hexes become yours; insight 25 × tier (× M_insight); food 120 s × √tier; chitin as for a raid; captured pupae become `5 × tier²` minors (they need housing; overflow is lost); the nest becomes an **outpost**; a `harvester_stash` spawns | Party destroyed |
| `tournament` (STRETCH) | Display contest on a border hex (§9.7) | `ritual_tournaments` | Hex flips to you, no casualties, a prize (insight + chitin) and their next raid 3 min later (C226) | Withdraw, 90 s cooldown |
| `bribe` | — | 2 × rival AP in honeydew | 5 min truce: no raids or tournaments from that rival. Cooldown 10 min. Both timers run in real time, offline and in a hidden tab too, and the truce's time left shows on the map and in the War tab (C225). **Attacking under a truce (C247):** a raid or assault on that rival first asks "Break the truce?"; confirming ends the truce (the bribe is lost) and halves the rival's raid clock, so its next raid comes sooner. The War tab shows "Truce: m:ss left — attacking breaks it". A data flag (`TRUCE.attackPolicy = 'block'`) switches to the alternative rule: no raids or assaults until the truce ends. The right-click Bribe item shows its honeydew cost and yours (C249). | — |
| `hunt` (prey) | Prey defender `AP = 50·r / 200·r / 800·r` | War party | Prey reward (§8.4) | Party destroyed |

- War parties march 1 hex per 2 s along the shortest passable route.
- The party is chosen with sliders (soldiers, supermajors), and the live preview updates as they move.
- Supermajors partly ignore home bonuses: the effective bonus is `1 + (bonus − 1) × (1 − your AP share from supermajors)`.
- `siege_tactics` halves the bonus portion. For example, ×1.25 becomes ×1.125.

### 9.5 Battle resolution: one model, two uses
**Fortune.** At battle start each side rolls `f ~ U(0.9, 1.1)` from the main RNG. It multiplies that side's ATK and HP, so AP scales by `f`.

**Stepped simulation (MUST; drives the visuals).**
- Every 0.25 s, each side deals `Σ n_i × ATK_i × 0.2 × 0.25` damage, computed from counts at the start of the step, so damage is simultaneous.
- Damage is applied to enemy groups in order: militia, then soldiers, then supermajors (for rivals: their soldiers).
- A group loses `damage / HP` units. Counts stay fractional; displays round.
- The battle ends when one side reaches 0 or the player retreats. **AI forces never retreat.**

**Closed form (previews, from A).**
- The side with higher `f × AP` wins.
- The winner keeps `s = √(1 − (AP_lose / AP_win)²)` of every group. The engaged losing force is destroyed.
- Win chance = `P(f₁·AP₁ > f₂·AP₂)`, evaluated on a deterministic 64×64 grid over both fortunes.
- **Preview text:** "Victory 92% · expected losses 12–15 soldiers · loot ≈ 4.2K food, 30 chitin".
- **Enemy strength, one name per figure (C228):** the map tooltip and the Map tab's rival row show **Nest strength** = AP of *all* the rival's soldiers with no home bonus (with "a raid faces ≈ 40% of it"); the War tab's preview shows what *this* party would face: "your power A vs B they field (raid: 40% of their defenders)" or "(assault: all defenders + home bonus)", which also includes swarm, acid volley, propaganda and the supermajor / Siege Tactics reductions. They used to be two unlabelled "power" numbers that differed by ×0.4 to ×1.4.
- **Test invariant:** for homogeneous forces, the stepped simulation's winner survivors fall within 5% of `s`; mixed forces within 10%. In the square law, aimed-fire attrition `dn_B/dt = −0.2·ATK_A·n_A/HP_B` gives exactly this `s`.
- **Worked example:** 17 soldiers (AP 152) assault Black Garden Ants at base strength. The defender's AP is 101 × 1.25 = 126. `s = √(1 − (126/152)²) = 0.56`, so about 9–10 soldiers survive. Without the home bonus (a raid engaging 40% = AP 40), `s = 0.96`.

### 9.6 Combat modifiers (summary)
| Modifier | Effect |
|---|---|
| Home defence (rival) | ×1.25 AP (carpenter ×1.5). Halved portion with `siege_tactics`. Partly ignored by supermajors. |
| Home defence (you) | AP ×(1 + 0.05 × mound level). +10% with Barracks near the entrance. Gate: HP +25%/level in the gate fight. |
| `acid_volley` | Your AP ×0.9 unless `formic_acid` |
| `venom` | Your HP ×0.8 |
| `swarm` | Rival AP ×1.2 if their count > yours |
| `propaganda_pheromones` | Enemy AP ×0.9 on your assaults. 5% of enemies killed join you as minors. |
| `ev_phorid_flies` event | Your ATK ×0.5 for 90 s |
| `ev_rival_mating_flight` event | All rivals AP ×0.7 for 3 min |
| Edicts | `edict_of_war` AP ×2. `edict_of_plenty` AP ×0.75. |

### 9.7 Ritual Tournaments (from B; STRETCH, cut-list #2)
- **Where:** a border hex adjacent to a rival.
- **Your display:** `Σ committed count × size` (minor 1, soldier 3, supermajor 10). Committed ants stop working for the 20 s display. Minors come from idle workers first, then foragers, who return to foraging afterwards (C101).
- **Rival display:** `1.5 × current soldiers × (1 + 0.2 × (tier − 1))` (C226; was 3×, which asked for most of a mid-game colony's minors for one hex).
- **Outcomes:**

| Ratio (yours ÷ rival) | Result |
|---|---|
| ≥ 1.5 (1.4 with `ach_ritualist`; −0.05 per `pacifist` Hardship tier) | The hex flips to you, with no casualties. The rival loses 2% of its soldiers. |
| ≤ 1/1.5 | You withdraw. |
| In between | Choose **escalate** (a raid-sized battle on that hex: 25% of defenders, no home bonus) or **withdraw**. |

- Each rival allows one tournament per 90 s (C226; was 3 min).
- **A win also pays (C226):** insight = max(10 × tier, 30 s × √tier of insight income) and chitin = max(3 × tier, 20 s × √tier of chitin income), and that rival's next raid comes 3 min later. Still no casualties.
- **The preview says what will happen:** "Win: the hex flips to you, no losses" / "Close: escalate to a fight or withdraw" / "Too small: you would withdraw", the display against the ratio needed ("Display 120 vs 80 = ×1.50 (win at ×1.5)"), how much display is missing, and the prize.
- This gives peaceful players, and the `pacifist` Hardship, a real way to expand.

### 9.8 Tactical actions during a battle (from D)
| id | Cost | Effect |
|---|---|---|
| `alarm_rally` | 25 pheromone, 30 s cooldown | +30% ATK for 8 s |
| `mobilize` | 40 pheromone | Fights at your border or nest only: 25% of idle and forager minors join as militia for 20 s. When the 20 s or the battle end, the surviving foragers go back to foraging and the rest are idle again; the dead come out of the draft, never out of other jobs (ARCHITECTURE §18 C73). |
| `reinforce` | — | Send more garrison units; they arrive after travel time |
| `retreat` | — | Pull back. Also triggers automatically when losses ≥ the Auto-retreat slider (default 60%; set with the war party in Map → War and in the war-party chooser, C187). Costs 30% of survivors (10% with `phalanx`). |
| `field_triage` (research) | passive | 30% of your fallen soldiers and supermajors return 60 s after the battle, if ≥ 5 nurses are assigned |

### 9.9 Battle presentation
- A **battle bubble** opens on the hex: two clusters of up to 40 sprites per side, in proportion to the surviving counts. Ants lunge, and sprites are removed in proportion to casualties.
- Corpses stay 5 s, then become **chitin glints** that haulers carry home along the trail. They stand for real loot: the war party's chitin (battleEnd `loot`), and since C227 a repelled raid also pays the chitin of the raiders killed (0.5 × tier per kill, raidResult `loot`), so the toast can state what came home.
- A captured nest hex turns your colour with a ripple, and the rival's trails fade out over 10 s.

### 9.10 Rival raids on you: across both views (from D)
**Eligibility.** All of these must hold:
- the rival's nest has been revealed, or run time ≥ 15 min;
- you have ≥ 50 adults;
- it is not winter;
- the game is not offline;
- no truce is active.

**Timing.**
- Exponential, with mean = raid interval ÷ season factor (summer 1.5, spring 1.25) ÷ aggression.
- Aggression = `1 − 0.08 × pacifist tiers`.

**Party.** 30% of the rival's current soldiers (40% for slave-makers).

**Target.**
- The nest, if the rival is tier ≥ 4 or slave-makers, or on a 25% roll.
- Otherwise, the trail with the most workers that passes within 2 hexes of its territory. If no trail qualifies, the nest.

**Sequence.**
1. **Warning**, lasting `15 s + 3 s × scouts` (max 60 s), +30 s with `early_warning`.
   - Above: a red dashed arrow with a countdown.
   - Below: the shaft flashes red.
   - The bottleneck badge temporarily shows "Raid incoming".
2. **Trail target:**
   - The trail's escorts fight.
   - The garrison can be dispatched. It arrives instantly if a Barracks is within 12 path cells of an entrance; otherwise it travels at 2 s per hex, and late arrivals join as reinforcements.
   - If the trail is undefended or the defence is lost: lose `min(n, 2 × raiders)` foragers, 30 s of that trail's income, and 30 trail strength.
3. **Nest target:**
   - (a) **Border fight** on the entrance hex against the garrison.
   - (b) If lost, the surviving raiders march **down the shaft** (drawn in the Below view) to the **gate fight**: the remaining garrison plus Mobilize militia, with the Gate HP bonus.
   - (c) If lost, **theft and brood loss:**
     - Food stolen = 10% of stored food, × the share of storage held in granaries within 15 path cells. If none are in reach, 3% from the nearest granary. Then × (1 − 0.1 × gate level), floor 2%.
     - Brood: 20% of the brood in nurseries within 15 path cells is killed. Slave-makers steal it instead; conquering them returns 3× as minors.
4. **`early_warning`** adds an **auto-guard** toggle that dispatches the garrison to every raid (for idle play).
5. **A fallen rival's raid is called off.** Conquering a rival cancels its raids still in their warning at once, like a bribe (the warning chip and arrow go; toast "Raid called off — their nest has fallen"; C186). The raid ends as a win with nothing lost and no fight. A raid already fighting finishes its current sequence (ARCHITECTURE §18 C90).

Only trail raids offer a **Dispatch garrison** button; against a nest raid the garrison at home defends the entrance automatically, and the raid row says how many soldiers are home. The Map tab's raid alert offers **Defend** only when the garrison can be sent; otherwise it says what happens or what is needed ("No soldiers at home — research Polymorphism / raise soldiers; the garrison defends the entrance automatically"), with no button that does nothing (C187).

**Lesson the player learns:** granaries and nurseries go deep; Barracks and the Gate go shallow. That is set against the short-haul benefit of shallow granaries (§7.8).

---

## 10. Adaptations (repeatable upgrades bought with food)

| id | Name | Effect per level | Base cost | Growth | Unlock |
|---|---|---|---|---|---|
| `quick_dispatch` | Quick Dispatch | +1 food per click. From L10, clicks also give `min(5%, 1% + 0.1% × (L − 10))` of gross food/s. | 15 food | ×1.7 | first worker |
| `strong_mandibles` | Strong Mandibles | Forager output +10% (additive group) | 25 food | ×1.9 | first worker |
| `royal_feeding` | Royal Feeding | +0.05 eggs/s base lay rate | 40 food | ×1.75 | first worker |
| `digging_claws` | Digging Claws | Dig +25% (additive group) | 30 food | ×1.8 | first digger |
| `potent_trails` | Potent Trails | Forager output ×1.12 | 200 food | ×3.5 | 40 adults |
| `serrated_mandibles` | Serrated Mandibles | Soldier and supermajor ATK ×1.10 | 100 food + 5 chitin | ×2.0 (both) | `polymorphism` |
| `thick_cuticle` | Thick Cuticle | Soldier and supermajor HP ×1.10 | 100 food + 5 chitin | ×2.0 (both) | `polymorphism` |
| `sweet_tooth` | Sweet Tooth | Honeydew ×1.15 | 500 food + 10 honeydew | ×1.9 (both) | `aphid_husbandry` |
| `queens_feast` | Queen's Feast | Lay rate ×1.1 (the queen is fed honeydew by trophallaxis; ×1.25 before C198) | 50 honeydew | ×3.0 | `aphid_husbandry` |
| `long_legs` | Long Legs | D_nav +0.25 | 1,000 food | ×3.0 | `tandem_running` |

**Click value** = `(1 + quick_dispatch) × (2 with ach_clickstorm) + p × gross food/s`. Clicks count toward `f_run`.

**Bulk buying (player request, ARCHITECTURE §18 C105):** each row shows the total cost of the next 10 levels beside its ×10 button (green when affordable, red when not) and a **Max (n)** button that buys the n levels affordable right now (n shown; respects the monomorphic L10 cap).

---

## 11. Research tree (paid in insight)

- There are six branches. The Research tab shows them as a tier grid (columns = branches, rows = cost tiers). Locked nodes are visible but greyed, and show their prerequisites.
- Run 1 completes about 25–30 nodes, and the whole tree is first finished around run 4–6.
- Costs are in insight. Prerequisites are listed explicitly.

### 11.1 Foraging (`foraging`; main output: forager output)
| id | Name | Cost | Prerequisites | Effect |
|---|---|---|---|---|
| `trail_memory` | Trail Memory | 10 | — | Forager ×1.25. +1 trail slot. |
| `scent_marking` | Scent Marking | 25 | trail_memory | Unlocks **Pheromone**, Mark, Mass Recruit and hex claims. |
| `tandem_running` | Tandem Running | 40 | trail_memory | D_nav +1. Unlocks the Long Legs Adaptation. |
| `recruitment_pheromones` | Recruitment Pheromones | 150 | scent_marking | Forager ×1.75. Unlocks Rally. |
| `double_bridge` | Double Bridge | 300 | tandem_running | Trails find shortcuts (`d` ×0.9). Strength rises twice as fast. |
| `persistent_trails` | Persistent Trails | 700 | double_bridge | Evaporation half-life 45 → 90 s. S_max 100 → 150. |
| `sun_compass` | Sun Compass | 1,000 | recruitment_pheromones | Map radius 8 → 12. +2 trail slots. |
| `mass_recruitment` | Mass Recruitment | 2,500 | sun_compass, persistent_trails | D_nav +2. Rally lasts 60 s. +2 trail slots. |
| `frenzy_signal` | Frenzy Signal | 4,000 | mass_recruitment | Unlocks Frenzy. |
| `trunk_trails` | Trunk Trails | 6,000 | mass_recruitment | Trails ≥ 5 hexes ×1.5. Trail hexes count as territory. Overlapping stretches are stronger: each trail ×(1 + 0.25 × its shared-hex fraction) (C132; replaces the old "trails can fork from other trails"). |
| `odometer_navigation` | Odometer Navigation | 15,000 | trunk_trails | D_nav +3. Richness slope 0.35 → 0.5. |

### 11.2 Excavation (`excavation`; main output: dig work)
| id | Name | Cost | Prerequisites | Effect |
|---|---|---|---|---|
| `coordinated_digging` | Coordinated Digging | 15 | — | Dig ×1.5 |
| `load_chains` | Load Chains | 80 | coordinated_digging | Tunnel work −50%. Dig queue +2 slots. |
| `clay_masonry` | Clay Masonry | 300 | load_chains | Clay work 10 → 7.2 |
| `mound_building` | Mound Building | 400 | coordinated_digging | Mound levels 6+ |
| `drainage` | Drainage | 800 | clay_masonry | Immune to floods. Drought penalties halved. Water pockets can be drained or moved (§7.9). |
| `ventilation_shafts` | Ventilation Shafts | 1,200 | clay_masonry | All chamber effects ×1.10. Clay granaries stop spoiling. Unlocks Thermal Chimney. |
| `thermoregulation` | Thermoregulation | 2,000 | ventilation_shafts | Frost line −5 rows. No summer topsoil overheat. |
| `gallery_arches` | Gallery Arches | 3,000 | ventilation_shafts | +2 Gallery instances. Housing ×1.25. |
| `acid_excavation` | Acid Excavation | 10,000 | gallery_arches | Bedrock and stones become diggable. Dig ×2. Unlocks Deep Vault. |
| `compact_galleries` | Compact Galleries | 20,000 | acid_excavation | Housing ×2 |

### 11.3 Brood and Royalty (`brood`; main output: lay rate)
| id | Name | Cost | Prerequisites | Effect |
|---|---|---|---|---|
| `brood_care` | Brood Care | 25 | — | Brood time ×0.75 |
| `age_polyethism` | Age Polyethism | 60 | brood_care | Automatic job assignment by preset ratios (§6.3) |
| `royal_pheromones` | Royal Pheromones | 200 | brood_care | Lay ×1.5 |
| `trophic_eggs` | Trophic Eggs | 500 | royal_pheromones | Egg cost ×0.7 |
| `thermal_brood_shuttling` | Thermal Brood Shuttling | 600 | brood_care | Brood is placed in the best-microclimate nurseries first. No summer overheat penalty. Frost freezes only brood that cannot fit below the frost line or in a Hibernaculum. |
| `nuptial_preparation` | Nuptial Preparation | 800 | royal_pheromones | Unlocks the Nuptial Chamber and alate rearing. **Required for the Flight.** |
| `response_thresholds` | Response Thresholds | 1,200 | age_polyethism | Auto-assignment retargets the current bottleneck |
| `living_larders` | Living Larders | 1,500 | trophic_eggs | Repletes and Repletion Hall |
| `spermathecal_reserve` | Spermathecal Reserve | 4,000 | nuptial_preparation | Lay ×2 |
| `supermajors` | Supermajors | 5,000 | spermathecal_reserve, polymorphism | Supermajor caste |

### 11.4 Husbandry (`husbandry`; main output: honeydew and fungus)
| id | Name | Cost | Prerequisites | Effect |
|---|---|---|---|---|
| `aphid_husbandry` | Aphid Husbandry | 100 | — | Herder job, Root Aphid Pen, Queen's Feast, Sweet Tooth |
| `leafcutting` | Leafcutting | 350 | aphid_husbandry | Leafcutter job |
| `aphid_shepherding` | Aphid Shepherding | 700 | aphid_husbandry | Move aphid colonies onto owned plant hexes. Herder cap ×2. |
| `fungiculture` | Fungiculture | 900 | leafcutting | Fungus Garden, gardeners, Nutrition and the Fungal Brood toggle (§6.4) |
| `lycaenid_clients` | Lycaenid Clients | 1,200 | aphid_shepherding | Lycaenid caterpillars spawn |
| `root_cultivation` | Root Cultivation | 1,500 | aphid_husbandry | Grow your own root lines into the nest (§7.9) |
| `sugar_economy` | Sugar Economy | 2,000 | aphid_shepherding | Honeydew ×2 |
| `weeder_ants` | Weeder Ants | 3,000 | fungiculture | Fungal Blight chance −75%. Fungus ×1.5. |
| `fungal_symbiosis` | Fungal Symbiosis | 6,000 | weeder_ants | Nutrition multiplier `1 + 0.5φ` → `1 + 1.0φ` |

### 11.5 Warfare (`warfare`; main output: AP)
| id | Name | Cost | Prerequisites | Effect |
|---|---|---|---|---|
| `polymorphism` | Polymorphism | 300 | — | Soldiers, Barracks, caste targets |
| `formic_acid` | Formic Acid | 250 | polymorphism | Soldier and supermajor ATK ×1.3. Cancels `acid_volley`. |
| `ritual_tournaments` | Ritual Tournaments | 400 | polymorphism | Tournaments (§9.7) (STRETCH) |
| `phalanx` | Phalanx | 1,000 | formic_acid | Escorts ×1.5 AP. Retreat losses 30% → 10%. |
| `field_triage` | Field Triage | 1,500 | phalanx | 30% of the fallen return after 60 s (needs ≥ 5 nurses) |
| `propaganda_pheromones` | Propaganda Pheromones | 3,500 | phalanx | Enemy AP ×0.9 on your assaults. 5% of enemies killed join you as minors. |
| `siege_tactics` | Siege Tactics | 7,000 | propaganda_pheromones | Rival home bonus halved |
| `war_chemistry` | War Chemistry | 12,000 | siege_tactics | All your AP ×2 |

### 11.6 Communication and Climate (`communication`; main output: insight)
| id | Name | Cost | Prerequisites | Effect |
|---|---|---|---|---|
| `antennation` | Antennation | 30 | — | Scouts ×2 speed. Insight per hex ×1.5. Hex flagging. |
| `chemical_lexicon` | Chemical Lexicon | 120 | antennation | Scent Library ×1.5 |
| `pheromone_glands` | Pheromone Glands | 250 | scent_marking | Pheromone cap +50. Regen ×1.5. |
| `early_warning` | Early Warning | 400 | antennation | Raid warning +30 s. Auto-guard toggle. |
| `seasonal_clock` | Seasonal Clock | 600 | antennation | Season and event forecast strip. Winter penalties −20% relative. |
| `overwintering` | Overwintering | 900 | seasonal_clock | Hibernaculum. Winter upkeep ×0.8. |
| `weather_sense` | Weather Sense | 1,500 | seasonal_clock | Rain no longer resets trail strength. 30 s warning before weather events. |
| `collective_memory` | Collective Memory | 1,800 | chemical_lexicon | Insight ×2. Offline cap +2 h. |
| `diapause_logic` | Diapause Logic | 3,000 | overwintering | Offline efficiency +25%. Winter upkeep ×0.75. |
| `hive_mind` | Hive Mind | 12,000 | collective_memory, response_thresholds | Insight ×1.5. Auto-Mark on every trail when pheromone is full. Saved job presets. |

### 11.7 Refinements and Innate research
- **Refinements:** once every node in a branch is owned, that branch gets a repeatable node, `<branch>_refinement` (for example `foraging_refinement`).
  - Cost `10,000 × 2.5^L` insight.
  - Each level gives ×1.10 to the branch's main output.
  - Refinements reset on a Flight.
- **Archive (player decision, ARCHITECTURE §18 C200):** a permanent insight sink, so Scent Libraries stay useful all game. Each branch has one Archive track, shown in the Research tab under the refinement.
  - It opens once every node of the branch is owned in the current run (the same moment as the refinement), and stays open once it has a level.
  - Level L costs `25,000 × 1.6^L` insight; each level adds **+1%** to the branch's main output (`× (1 + 0.01 × L)`, additive across levels).
  - **Scope: era.** Archive levels survive Flights and Supercolonies and reset at Speciation, like Federation nodes and the other era-scope progress. Why era: a run-scope sink resets every 20–30 minutes (the refinements already fill that role), and a meta-scope one would compound across eras with no reset at all; in the era it accumulates for 1–9 days, which is long enough to feel permanent, and Speciation's fresh species and Genome start it over.
  - Stability (§16): the bonus is linear in the level while the cost is geometric, so each further +1% costs ×1.6 more insight. Insight is softcapped (1e12, p 0.5) and is not a prestige currency, so the Archive is a bounded constant factor on each branch inside one era (about +25–45% at 1e9–1e12 insight banked), never a feedback loop.
- **Innate research (from A):** a node researched in **3 separate runs** becomes Innate (2 runs with `ancestral_memory`).
  - It is granted free at the start of every run.
  - It survives Flights and resets at every **Supercolony** (C167), together with the per-node run counts, so each cycle builds its Innate research again. At a Speciation it resets too unless `genetic_memory` is owned, which keeps the current cycle's Innate research and counts (Genetic Memory does not protect them at a Supercolony).
  - Per-node run counts are kept in `state.era.researchRuns`. A count rises at every run end: Flight, Hardship start, Supercolony or Speciation (the merging run is counted, then the counts reset).
  - The UI shows a small DNA-helix badge on Innate nodes.

---

## 12. Multiplier stacking order

Every production stat follows one shape:
```
Output = clamp( SC( Base × Location × A_add × M_run × M_time × M_prestige ) )
```
- `SC` = the per-stat softcap chain (§12.10).
- `clamp` = `[0, 1e295]`.
- **The additive group (`A_add`) comes first on purpose.** Flat percentage sources dilute each other, so no single cheap upgrade can run away. Everything that compounds sits in a multiplicative group with its own cost curve.

### 12.1 Food (per trail, then summed)
| Group | Contents |
|---|---|
| Base | `Y_src × r(d) × n_eff` |
| Location | `eff(d_eff) × (1 + S/100) × terr` |
| A_add | `1 + 0.10·strong_mandibles + min(1, 0.005·territory) + min(0.2, 0.02·Σ midden L) + 0.25·satellites + event flats (myrmecophile_guest +0.15)` |
| M_run | `1.25 [trail_memory] × 1.75 [recruitment_pheromones] × 1.5 [trunk_trails, trails ≥ 5 hexes only] × (1 + 0.25 × shared) [trunk_trails, per trail, §8.5] × 1.12^potent_trails × (1 + 0.5φ) [nutrition] × 1.1^foraging_refinement × (1 + 0.01 × foraging Archive) × species × edict` |
| M_time | `season_forage × season_src × events (drought, seed_mast, …) × rally × frenzy × golden frenzy (×5) × hungry (0.75)` |
| M_prestige | `Λ × 1.4^hardy_workers × (1+K)^1.25 × (1+G)^1.5 × 1.01^achievements (1.02 with fossil_record) × hardship rewards × signature genes × nanitic_vigor (×3 for the first 50 workers' share)` |

- **Winter forage:** `season_forage = 1 − (1 − 0.3) × (1 − R)`. The base is 0.6 in the first winter (mild). `R` is the combined relative reduction `1 − Π(1 − r_i)`, where the `r_i` are:
  - Thermal Chimney: 0.1/level, max 0.6;
  - Mound: 0.03/level, max 0.3;
  - `seasonal_clock`: 0.2;
  - `seasonal_wisdom`: 0.25;
  - `eternal_winter`: 0.1 per tier.
- **Upkeep** is subtracted after the total. Net food = Σ trails + clicks + one-shots − upkeep.

### 12.2 Clicks
`click = (1 + quick_dispatch) × 2 [ach_clickstorm] + p × gross_food_per_s`. There are no other multipliers, so clicking matters early and fades to a % top-up later.

### 12.3 Dig work and soil
| Group | Contents |
|---|---|
| Base | `diggers^0.85` |
| A_add | `1 + 0.25·digging_claws + midden + 0.25·satellites` |
| M_run | `1.5 [coordinated_digging] × 2 [acid_excavation] × 1.1^excavation_refinement × (1 + 0.01 × excavation Archive) × (1 + 0.5φ) × edict_of_depth (3)` |
| M_time | `winter 1.3 × events` |
| M_prestige | `1.4^deep_diggers × (1+K)^0.5 × (1+G)^0.25 × 1.01^achievements` |

Soil/s = W. Blueprint cells need ⅓ of the work (`ancestral_blueprint`), or ⅕ (`blueprint_memory`).

### 12.4 Lay rate (`M_lay`)
```
M_lay = 1.5 [royal_pheromones] × 2 [spermathecal_reserve] × 1.1^queens_feast × 1.25^fertile_queen × Λ^0.25 × 2^haplodiploid_fecundity
      × season (spring 1.25, winter 0.75) × events (queens_vigor 3, wandering queen 2 / parasite 0.5, golden lay burst 3)
      × 1.3^claustral_founding tiers × 1.1^brood_refinement × (1 + 0.01 × brood Archive level) × species
```
Then `λ = Σ_queens (0.2 + 0.05·RF) × royal(RC) × court × M_lay` (§5.1; no colony_scale since C198). Laying is 0 while Hungry. The queen tooltip shows the parts (`d.stats.layParts`).

### 12.5 Insight
| Group | Contents |
|---|---|
| Base | Library: `Σ 0.05 × L × layer (1.25 gravel+) × adj (1.10)`. Scouting: `0.75 × ring` per revealed hex (scout force `scouts^0.6`, §8.3). One-shots: conquest, caches, Field Guide. |
| M_run | `1.5 [chemical_lexicon, library only] × 2 [collective_memory] × 1.5 [hive_mind] × 1.5 [antennation, scouting only] × 1.1^communication_refinement × (1 + 0.01 × communication Archive) × 1.1 [ventilation, library only]` |
| M_time | `winter 1.5 × pheromone_bloom 2` |
| M_prestige (`M_insight`) | `1.5^swarm_instinct × 10^ancient_instinct × (1+K)^0.5 × (1+G)^0.25 × 1.01^achievements` |

**Insight never scales with population** (A's post-mortem rule).

### 12.6 Combat stats
- `ATK = base × 1.1^serrated_mandibles × 1.3 [formic_acid] × (1 + min(0.5, 0.05·Σ barracks L)) × 1.25^warrior_lineage × 2 [venom_gland] × species (fire_ant 1.5) × alarm_rally (1.3) × phorid_flies (0.5) × fortune`
- `HP = base × 1.1^thick_cuticle × 1.25^warrior_lineage × fortune × venom_received (0.8) × gate (1 + 0.25L, gate fight only)`
- `AP = SC_ap( Σ n × √(ATK × HP) ) × 2 [war_chemistry] × 1.1^warfare_refinement × (1 + 0.01 × warfare Archive) × edict × (1 + G) × home modifiers (§9.6)`

### 12.7 Honeydew, leaves, fungus, chitin
- **Honeydew** = herder trails (`0.08` base, trail formula) × 1.1^root_aphid_pens × 2 [sugar_economy] × (1 + 0.01 × husbandry Archive) × 1.15^sweet_tooth × 2 [sweet_inheritance] × season × (1 + 0.5φ) × `(1+K)^0.5 × (1+G)^0.25 × 1.01^ach`, + Root Aphid Pen passive + flower trace + Lycaenid.
- **Leaves** = leafcutter trails (`0.3` base) × season × (1 + 0.5φ) × 1.4^hardy_workers × same prestige terms as honeydew.
- **Fungus** = `min(gardeners, slots) × 0.1 × leaf supply ratio × 1.5 [weeder_ants] × (1 + 0.01 × husbandry Archive) × layer/well modifiers (slot-weighted) × prestige terms as honeydew`.
- **Chitin** = source rates × `(1+K)^0.5 × (1+G)^0.25 × 1.01^ach × (1 + Σ Carapace Workshop boost)` (C199: the Workshop boost applies to every source: trails, Middens, moults, hunts, battles, events; income-seconds rewards are sized on the unboosted income so the boost applies once). One-shots are sized in seconds of income with minimums. Passive sources (C103): Midden recycling `0.05 × Σ midden level × eff` /s through the same channel; moults 0.025 per hatched adult (flat). Balance aim: they cover roughly 10–25% of the chitin a mid-game colony spends on soldier eggs (pacing bot, seeds 1–8: ~18–27%), so soldiers still need dead insects, hunts and battles.

### 12.8 Caps
- Food cap = `(150 + Σ granary capacity × layer modifier) × (1 + 0.02 × repletes × adj_granary_repletion) × autumn 1.25 × 1.1 [ach_hoarder] × species`.
- Honeydew cap = `50 + 0.1 × food cap`.
- **Chitin cap (player decision, C199)** = `(500 + Σ Carapace Store capacity) × colony_scale`. Income (trails, Middens, moults) fills up to the cap. One-shot rewards (hunts, battles, events, caches) may overflow to 2× the cap, like food. Chitin above the cap decays at **1% of the excess per minute** (online and offline). The chitin reserve (§5.5) can be set no higher than the cap. Colony scale multiplies it because berths, and so soldier egg chitin (1 + 0.02 per soldier), scale with it.
- Housing, slots and berths: see §5.4. `colony_scale`: see §5.6.

### 12.9 Pheromone
- Regen = `(0.5 + 0.05 × √adults) × 1.5 [pheromone_glands]`.
- Cap = `50 + 50·pheromone_glands + 5 × mound level`.

### 12.10 Softcaps and clamps
`sc(x; s, p) = x ≤ s ? x : s × (x/s)^p`. Softcaps are applied in sequence to the **aggregate** rate, and individual sources are scaled pro rata. Any softcapped number shows a small **"sc"** badge with a tooltip giving the raw and effective values.

| Quantity | First softcap (s, p) | Second softcap (s, p) |
|---|---|---|
| Gross food/s | 1e24, 0.5 (s ×1e6 per `thermal_ceiling` level) | 1e60, 0.25 |
| Dig work/s | 1e20, 0.5 (s ×1e6 per `thermal_ceiling` level) | 1e50, 0.25 |
| Insight/s | 1e12, 0.5 | — |
| Honeydew/s, fungus/s, chitin/s | 1e16, 0.5 | — |
| AP (per side) | 1e24, 0.5 | — |
| Alates per flight | 3e4, 0.5 (load-bearing, see §16) | — |
| Kinship per merge | 1e5, 0.5 | — |
| Genes per speciation | 1e4, 0.5 | — |

- With the softcaps, a naive raw food rate of 1e200/s comes out at about 1e73, so the **1e295 clamp** is a backstop that should never be hit.
- The cost curve MAX at 1e280 (§3) keeps every purchase finite.
- The expected practical peak is **1e60–1e100 food/s** at week scale, which is satisfying "big numbers" with no big-number library.

---

## 13. Prestige layer 1: Nuptial Flight (currency: `alates`)

### 13.1 Unlock
All of the following are required:
1. `royal_chamber` L5.
2. `nuptial_preparation` researched.
3. A `nuptial_chamber` built, including its exit shaft (the second entrance).
4. `f_run ≥ 1.85e8`. This guarantees at least 13 alates (the formula is anchored at 1e8 → 10, §13.2).

The **Prestige tab** appears when `f_run ≥ 2e7` or `nuptial_preparation` is researched, whichever comes first. ("Visible" would be ambiguous, because locked research nodes are always shown greyed.) It shows a requirements checklist and the live projection.

### 13.2 Formula
```
alates = floor( SC_alates( 10 × √(f_run / 1e8) × (1 + t_peak/400) × (1 + 0.02 × reared) × W × (1 + K)^0.25
                           × 1.15^wide_wings × (1 + 0.05 × deep_vault) × A_bonus ) )
```
- `reared` = alates reared this run. Max 25, or 50 with `royal_court`.
- `W` (weather) = 1.25 in summer ("flight weather"), 1.5 during a `ev_flight_day` event, otherwise 1.0. **Flights are never blocked by season.**
- `A_bonus` = product of achievement bonuses: `ach_swift_swarm` +10%, `ach_gentle_giants` +5%, `ach_flying_ant_day` +5%.

| Situation | f_run | t_peak | reared | W | Alates |
|---|---|---|---|---|---|
| Formula anchor | 1e8 | 20 | 0 | 1.0 | **10** |
| Flight gate (§13.1) | 1.85e8 | 0 | 0 | 1.0 | **13** |
| Run 1, bot ~45 min (human ~55–65), winter | 1.3e8 | 175 | 25 | 1.0 | **24** |
| Run 1, bot ~60 min (human ~75), summer | 2.1e8 | 200 | 25 | 1.25 | **40** |
| Run 1, bot ~90 min | 4.5e8 | 215 | 25 | 1.0 | **48** |
| Late Layer-1 run | 1e11 | 250 | 25 | 1.0 | **770** |
| Layer-2 run (K = 10, `royal_court`) | 1e13 | 400 | 50 | 1.25 | **28,795** (just under the 3e4 softcap) |

Rows exclude Bloodline and achievement multipliers (`wide_wings`, `A_bonus`) and Deep Vault.

Run-1 rows are medians of the balance simulation (Balance Verification). Conquests and pheromone claims put `t_peak` near 150–220 hexes in run 1, which is why the divisor is 400. `t_peak` counts permanent land only; trail-held (Trunk Trails) hexes are excluded (§8.6, C222).

- **The Flight button** shows the projected alates and "+X/min".
- **The Alates/min meter** (from C) shows `projected ÷ run minutes`. It records the peak, and once the current rate falls below 97% of the peak it glows: "Peak reached 3 min ago: a good time to fly."

### 13.3 Lineage passive (spending never reduces it)
```
Λ = 1 + 0.05 × alates_cycle                   (alates_cycle ≤ 100)
Λ = 6 × √(alates_cycle / 100)                 (above 100)
```
- Applies ×Λ to **food** and ×Λ^0.25 to lay rate.

| alates_cycle | 30 | 100 | 1,000 | 1e5 |
|---|---|---|---|---|
| Λ | ×2.5 | ×6 | ×19 | ×190 |

- Why food only: run food scales almost **linearly** with the food multiplier (measured exponent 0.94, Balance Verification). So alates grow as `√Λ`, and with Λ ∝ √A above the knee, as `A^0.25` before Bloodline purchases.
- Why the knee is at 100, not 1,000: defence in depth. Bought cheapest-first, the Bloodline traits stack, so a Lineage that stays linear up to 1,000 alates leaves almost no stability margin. With the original numbers, cycle 1 blew up (26 → 64 → 238 → 842 → 1,835 → 4,201 → 170,000 alates per flight). With the current numbers, the knee at 100 trims late merge gains by ~30% (about +42 instead of +62 at ~28 h). See §16.
- The run-1 flight (~20–40 alates) feels like a ×2–3 speed-up once traits are added. That is a clearly felt "×2+".

### 13.4 Reset and keep
- **Resets:**
  - all run resources, ants, brood and berths;
  - chambers (the Royal Chamber returns to L1, pre-dug), tunnels and the dig queue;
  - Adaptations, refinements and non-Innate research;
  - territory, the map (new seed) and rivals;
  - pheromone and any event in progress.
- **Kept:**
  - unspent alates, all lifetime counters and `alates_cycle`;
  - Bloodline traits, Innate research and per-node run counts;
  - Hardship rewards, achievements, the Field Guide and statistics;
  - saved blueprints, the Diapause bank, the season clock, settings, cosmetics and Strata.
- `brood_bank` keeps 10% of adults (max 1,000).

### 13.5 Alate rearing (the pre-flight finishing phase, from A)
- Once the Nuptial Chamber is built, the player rears alates in its cells: a button, or an auto-rear toggle.
- **Cost per alate:** `20 × E(N)` food + `5 × 1.15^k` honeydew. Development takes `5 × T`. Upkeep 0.5 food/s each.
- **Effect:** each reared alate gives +2% flight alates, additive (25 reared = +50%; 50 with `royal_court` = +100%). The game words it "Each reared alate gives +2% more alates on your next flight (+2% each, additive: 25 reared = +50%)" (C146).
- They are visible: winged sprites line the chamber, and the count shows on the flight button.
- This creates an active 5–10 minute "finishing" phase before each prestige, which automation later handles.
- **Queue (player request, ARCHITECTURE §18 C232):** "Rear 1" / "Rear 5" add to a queue; nothing is paid when queueing, each egg is paid as the queen lays it. **Cancel queued** empties the queue for free (eggs already laid keep growing). The Flight view shows what queueing 1 and 5 more would cost (food + the rising honeydew, continuing after the alates already laid and queued), on the buttons' tooltips and in a "Queue 1 · Queue 5" line.

### 13.6 Ceremony, landing site and Founding Boon (from C and D)
1. **Ceremony.** The Above canvas zooms out, and up to 120 alate sprites spiral out of the `nuptial_entrance`. The alate counter ticks up, and the weather bonus flashes if any.
2. **Landing site:** choose 1 of 3 previewed seeds. Each preview shows a mini-map plus 1–2 tags:

| Tag id | Effect |
|---|---|
| `site_rich_loam` | Topsoil and loam work −20% |
| `site_seed_meadow` | +2 seed patches; autumn seed bonus ×2.5 |
| `site_aphid_dense` | +2 aphid colonies |
| `site_hostile_neighbours` | Starting rivals are tier 2 and 3; conquest rewards ×1.5 |
| `site_stony_ground` | Stones ×2, caches ×2 |
| `site_garden_path` | Garden-path hexes ×2 (fast trails, more Footsteps) |
| `site_wet_hollow` | +2 water pockets; puddles ×2; fungus +20% |
| `site_sunny_slope` | Topsoil nursery bonus also applies in autumn; no summer overheat |

3. **Founding Boon:** choose 1 of 3, drawn at random:

| Boon id | Effect |
|---|---|
| `boon_next_to_aphids` | An aphid colony at ring 2 |
| `boon_rich_prey` | A dead insect respawns at ring 2 every 2 min for the first 10 min |
| `boon_peaceful_start` | No raids for the first 20 min |
| `boon_royal_vigor` | Lay ×2 for the first 10 min |
| `boon_scouts_lead` | Rings 0–3 revealed |
| `boon_old_trails` | The first 2 trails start at full strength |
| `boon_chitin_hoard` | Start with 50 × (1+K)^0.5 chitin |
| `boon_blueprint_rush` | Blueprint digging ×2 for 10 min |
| `boon_long_spring` | The first spring lasts +3 min |
| `boon_insight_cache` | Start with 100 × M_insight insight |

   - Under a Hardship, options that cannot help are never drawn: Eternal Winter skips Seed Meadow, Sunny Slope and Long Spring (and offers no starting season); Pacifist skips Hostile Neighbours (C147).
4. The new run starts. The daughter colony founded by this flight appears at the map edge (§14.6).

### 13.7 Bloodline traits (spend alates)
| id | Name | Cost | Max L | Effect |
|---|---|---|---|---|
| `founding_stores` | Founding Stores | 1 × 3^L (1, 3, 9) | 3 | Start each run with 500 / 5,000 / 50,000 food (may exceed the cap until spent) and 100 / 1,000 / 10,000 soil |
| `nanitic_vigor` | Nanitic Vigor | 2 | 1 | The first 25 eggs are nanitics. The first 50 workers produce ×3. |
| `remembered_paths` | Remembered Paths | 2 | 1 | Runs start with trails drawn to the 2 best revealed sources, at 50% strength |
| `ancestral_blueprint` | Ancestral Blueprint | 3 | 1 | Save your nest layout. After each flight it auto-queues; blueprint cells dig at 3× speed; blueprint chambers cost −50% placement food. Chambers that are still locked or unaffordable at run start stay **planned** (faint dashed outlines) and queue themselves, at the same price and dig speed, as soon as they unlock and can be paid for (the planned outline's tooltip, its inspect view and the Build panel's Blueprints list say why each one still waits, e.g. "Waiting: stone in the way — needs Acid Excavation" or "Waiting: 2.1K food (blueprint half price)"; ARCHITECTURE §18 C126); a spot that can never be used this run (water, another chamber, a seeded rule) is dropped with a notice (ARCHITECTURE §18 C106). The Royal Chamber starts at its saved spot when that spot works on the new soil (else at the usual spot, with a notice). Water Wells follow the new run's water: each takes the free spot nearest its saved one that touches a revealed water pocket, or is left out when no pocket has room (C119). A saved chamber keeps its full-size reservation and starting corner (C137). **Feedback pass 6 (C174–C177):** a planned chamber whose spot holds water (or strikes hidden water) moves to the nearest valid spot within 6 cells instead of being dropped (or waits); a Water Well that finds no pocket spot within 8 cells uses Deep Spring, else with Drainage moves the nearest free pocket next to its saved spot; a Root Aphid Pen with no root grows one (free with Root Memory, else a normal cultivated root with Root Cultivation; otherwise it waits and says what it needs); a Nuptial Chamber with no straight exit-shaft column digs a routed exit shaft, or moves nearby. Every automatic move is logged (`blueprintAdjusted`) and every chamber queued (`blueprintPlaced`). With the Federation's Architect's Table a saved layout can be edited by hand in a sandbox editor (C180). A planned chamber the open nest does not reach yet, but that could otherwise be placed, gets an **access tunnel** queued first (shortest route through diggable soil, around stone, water and reserved rooms, at blueprint dig speed); it waits with "Waiting: digging access tunnel" and queues once the tunnel is dug (C138). **Use** works during a run too: it applies the blueprint at once (what can be queued is, the rest waits as planned chambers; spots already built are skipped) and after every later flight (C139). |
| `automaton_instincts` | Automaton Instincts | 5 | 1 | Dig queue +2; your last job targets carry into every new run (automatic jobs start on when `age_polyethism` is known that run). C166: automatic jobs and the Adaptation autobuyer are Federation-only. |
| `hardy_workers` | Hardy Workers | 5 × 3.5^L | 12 | Forager, herder and leafcutter output ×1.4 |
| `deep_diggers` | Deep Diggers | 5 × 3.5^L | 12 | Dig work ×1.4 |
| `keen_antennae` | Keen Antennae | 5 | 1 | Rings 0–4 revealed at start. Scouts ×2. |
| `fertile_queen` | Fertile Queen | 8 × 3.5^L | 10 | Lay rate ×1.25 |
| `ancestral_memory` | Ancestral Memory | 8 | 1 | Research becomes Innate after 2 runs instead of 3 |
| `long_memory` | Long Memory | 10 × 4^L | 3 | +2 h offline cap and +10% offline efficiency per level |
| `warrior_lineage` | Warrior Lineage | 10 × 3^L | 5 | Soldier and supermajor ATK and HP ×1.25 |
| `root_memory` | Root Memory | 12 | 1 | With Ancestral Blueprint: a blueprint Root Aphid Pen with no root to touch grows one free cultivated root to it (no cost, not counted against the cultivated-root cap); it waits ("Waiting: Root Memory is growing a root down to it") and queues once the root touches it (ARCHITECTURE §18 C158). |
| `royal_court` | Royal Court | 15 | 1 | Alate cells 25 → 50. Nuptial Chamber max L9. |
| `deep_spring` | Deep Spring | 15 | 1 | With Ancestral Blueprint: a blueprint Water Well whose water search (C119) finds no revealed pocket with room within 8 cells of its saved spot gets a small 2×2 spring pocket welling up beside that spot, so the Well is built there (C158). |
| `seasonal_wisdom` | Seasonal Wisdom | 20 | 1 | Choose the starting season at landing. Winter penalties −25% relative. |
| `swarm_instinct` | Swarm Instinct | 20 × 4^L | 5 | Insight ×1.5 |
| `sweet_inheritance` | Sweet Inheritance | 25 | 1 | A level-2 aphid colony spawns at ring 2. Honeydew ×2. |
| `wide_wings` | Wide Wings | 40 × 5^L | 5 | Flight alates ×1.15 |
| `vast_galleries` | Vast Galleries | 50 × 4^L | 10 | colony_scale ×1.2 |
| `brood_bank` | Brood Bank | 100 | 1 | Keep 10% of adults (max 1,000) through a flight |
| `polygyny` | Polygyny | 250 | 1 | A second Royal Chamber can be placed; lay rates add |
| `budding` | Budding | 500 | 1 | **Required for Supercolony.** The Old Ridge appears. Daughter colonies push trails toward you. |

- Trait cost growth is chosen so that `ln(effect)/ln(cost growth)` stays at or below about 0.27 per trait. Max levels cap the total.
- The balance simulation (Balance Verification) shows flights growing about ×1.3–2 each in cycle 1, not exploding. That holds only with the Lineage knee at 100 (§13.3).

### 13.8 Hardships (challenges)
- **Unlock:** 150 lifetime alates (about 2.5–3 h).
- A Hardship is started from the Prestige tab. It works like a Flight into a constrained run, and alates are earned normally on that run's flight.
- **Tier goal:** `f_run ≥ 1e9 × 100^(t−1)` within the constrained run, for tiers t = 1..5 (1e9, 1e11, 1e13, 1e15, 1e17). Tier 1 sits 10× above the Flight threshold.
- **Persistence:** rewards persist through Flights, are kept at 50% strength through a Supercolony, and reset at Speciation.

| id | Constraint | Reward per tier |
|---|---|---|
| `eternal_winter` | Always winter, hard frost line, no mild year | Winter penalties −10% relative |
| `claustral_founding` | No clicking and no Royal Feeding. "No clicking" covers every click that yields resources, work or progress (hand-forage, Help Dig, Groom Brood, Golden Beetle and Pupa, gifts, rival alates, golden aphid). Counterplay clicks against negative events (mold, flood, blight, ladybugs, footsteps) and the queen stay allowed. | Lay rate ×1.3 |
| `pacifist` | No soldiers or supermajors (tournaments and bribes allowed) | Rival aggression −8%; tournament threshold −0.05 |
| `barren_ground` | All source yields ×0.5 | Richness slope +0.05 |
| `shallow_soil` | Nothing dug below row 23 | All layer work −5% |
| `monomorphic` | Minors only; Adaptations capped at L10 | Worker output ×1.3 |

The Hardships (§13.8) fill the hour 3–6 window with new goals, along with new rival tiers and landing sites. There is **no planned plateau**.

---

## 14. Prestige layer 2: Supercolony (currency: `kinship`)

### 14.1 Unlock
All of the following are required:
1. The `budding` trait.
2. `alates_cycle ≥ 5,000`.
3. `old_ridge_supercolony` conquered in the current run. It is immune until you own 25 hexes (§9.3).

Expected after **6–10 h** of cumulative play: the shipped bot gets there at 5:28–5:59, with the Old Ridge as the last gate (re-tune pass), and a human takes about 1.3× longer (Balance Verification).

### 14.2 Formula
```
kinship = floor( SC_kinship( 2 × ((alates_cycle + alates_run) / 1,000)^0.35 ) )
```
- `alates_run` = the merging run's projected flight alates (§13.2): a Supercolony counts the current run as if it had flown (C168, player request). The Supercolony section shows the split (banked + this run) and a "What increases kinship" breakdown (C169). The unlock gate `alates_cycle ≥ 5,000` (§14.1) still counts banked alates only. The merge also adds `alates_run` to lifetime alates.
- Effect: at a first merge `alates_run` is about 1,400–2,000 alates (meta-model), i.e. +25–30% alates counted and +0 to +1 kinship (5,000 → 3 either way; 6,000 → 3 before, 4 now). The model already counted the merging run as the cycle's last flight, so `prestige_contractive` and the pacing model are unchanged.
| alates_cycle | 5,000 | 20,000 | 1e5 | 1e6 | 1e8 |
|---|---|---|---|---|---|
| Kinship | **3** | **5** | **10** | **22** | **112** |

### 14.3 Passive (from `kinship_life`; spending never reduces it)
| Stat | Multiplier | K = 3 | K = 30 |
|---|---|---|---|
| Food | `(1+K)^1.25` | ×5.66 | ×73 |
| Dig, insight, honeydew, fungus, chitin | `(1+K)^0.5` | ×2 | ×5.6 |
| Flight alates | `(1+K)^0.25` | ×1.41 | ×2.36 |
| colony_scale | `(1+K)^0.2` | ×1.32 | ×1.99 |

In the balance simulation, cycle 1 reaches 5,000 alates at 4.5–5.3 h, while cycle 2 gets there in ~25–45 min. The old rate returns within 2–3 runs.

### 14.4 Reset and keep
- **Resets:** everything a Flight resets, plus:
  - unspent alates and `alates_cycle` (so Lineage resets);
  - Bloodline traits, except the 3 Heirloom picks;
  - Hardship tiers (rewards stay at 50%);
  - Innate research and its per-node run counts (C167, §11.7).
- **Kept:** kinship and `kinship_life`, Federation nodes, achievements, Field Guide, statistics, saved blueprints, Diapause, Strata, signature genes and settings.
- Bloodline traits reset, so `ancestral_blueprint` must be bought again (or kept as an Heirloom) to save new layouts; saved layouts themselves are kept (`blueprint_memory` is the era-long unlock, C170).
- Without either unlock, a saved active blueprint is **not applied** at run start, and Use / Edit are disabled; "Clear active blueprint" (Build tab) deselects it at any time, unlock or not (ARCHITECTURE §18 C258).

### 14.5 Federation nodes (spend kinship)
| id | Name | Cost | Max | Effect |
|---|---|---|---|---|
| `automated_brood` | Automated Brood | 1 | 1 | `age_polyethism` and `response_thresholds` innate (automatic jobs and Respond to bottlenecks on from the start of every run); caste presets: the caste and job targets you last set carry into every new run |
| `blueprint_memory` | Blueprint Library | 1 | 1 | Save 5 layouts. Blueprint cells dig ×5. |
| `architects_table` | Architect's Table | 3 | 1 | Needs `blueprint_memory`. Edit saved blueprint layouts by hand (the editor is the nest UI's; C172). |
| `autobuyers` | Autobuyers | 2 | 1 | Auto-buy Adaptations (switch in the Adaptations tab) and chamber level-ups (switch in the Build tab's Automation box). C246: each autobuyer runs on its own, at most one purchase per second each; no shared priority and no Mound autobuyer (the Mound grows by itself, §8.7) |
| `auto_flight` | Auto-Flight | 3 | 1 | Fly automatically at a target alate count, a run time, or past the alates/min peak. Online, or immediately on return when the condition was met. Settings in Prestige → Flight. **Peak rule (C166):** the run is ≥ 8 min old and the weather-free alates/min (the unfloored projection without the flight-weather factor W, so a season change never trips it) has stayed ≥ 3% below this run's best weather-free rate for 30 s in a row; while the rate keeps rising it waits. **Landing:** the option and boon with the best early-growth score (data `AUTO_LANDING`: lay, food sources, insight; situational bonuses for an active blueprint, Pacifist, Remembered Paths, Keen Antennae; the run's starting season), spring with Seasonal Wisdom. |
| `aquifer_access` | Aquifer Access | 3 | 1 | Dig rows 74–79 |
| `heirloom_bloodline` | Heirloom Bloodline | 5 | 1 | Keep 3 chosen Bloodline traits, with their levels, through Supercolonies |
| `satellite_nest` | Satellite Nest | 2, 3, 5, 8, 13, 21, 34 | 7 | +1 satellite: entrance hex, shaft, trail origin, +1 trail slot, auto-claim radius 1, +25% food and dig (additive group). Satellites add 25% each to the census. |
| `regional_expansion` | Regional Expansion | 6 | 1 | Map radius 12 → 16. Max rivals 4. |
| `megacolony_galleries` | Megacolony Galleries | 4 × 2^L | 5 | colony_scale ×2 |
| `highway_network` | Highway Network | 8 | 1 | D_nav +5. Satellites share the garrison. |
| `diapause_mastery` | Diapause Mastery | 10 | 1 | Offline cap 24 h at 100% efficiency. Diapause spends at 3× speed. |
| `queens_council` | Queens' Council | 13 | 1 | +2 Royal Chambers (needs no trait) |
| `megacolony` | Megacolony | 50 | 1 | **The Argentine Front appears. Required for Speciation.** |

### 14.6 Daughter colonies, ceremony and Royal Edicts
- **Daughter colonies (teaser, from B, C and D).**
  - Each flight founds a daughter colony, shown as an allied nest sprite at the map edge in later runs. Up to 8 are shown; the newest replaces the oldest.
  - With `budding`, they lay faint trails toward your territory.
  - They are cosmetic, but they foreshadow the Supercolony.
- **Ceremony.** Trails link every daughter colony to your nest. The camera pulls back to show the network, then a single queen lands on a fresh map.
- **Royal Edicts** (from C). The player chooses 1 at each merge, and it stays active for the whole cycle:

| id | Effect |
|---|---|
| `edict_of_plenty` | Forage ×2; AP ×0.75 |
| `edict_of_war` | AP ×2; conquest rewards ×1.5; forage ×0.9 |
| `edict_of_depth` | Dig ×3; chamber costs ×0.5 |
| `edict_of_long_summer` | The year runs spring → summer → summer → autumn (no winter); autumn bonuses off (that autumn: food cap ×1, and every source's season factor is 1, so no seed ×2 or prey ×1.5) |

---

## 15. Prestige layer 3: Speciation (currency: `genes`)

### 15.1 Unlock
All of the following are required:
1. The Federation `megacolony` node.
2. The `great_rival` (all 3 nests) defeated in the current run.
3. `kinship_era ≥ 1,000` (20 genes).

Expected after **~35–60 h** of cumulative play, which is **days** of calendar time. The shipped bot breaks the Argentine Front at ~10–12 h, so the kinship gate is the real one: `kinship_era` reaches 1,000 at ~33–37 h (bot). The gate was 200 originally and 400 after the pacing-bot pass. Once later runs stopped being capped by the tick length (bug-hunt fix F23), 400 came at 12–14 h, so the re-tune pass moved it to 1,000 (Balance Verification).

### 15.2 Formula
```
genes = floor( SC_genes( kinship_era / 50 ) )
```
| kinship_era | 200 | 1,000 (gate) | 2,000 | 10,000 | 1e6 |
|---|---|---|---|---|---|
| Genes | **4** | **20** | **40** | **200** | **14,142** (softcap 1e4) |

Linear since the re-tune pass. It was `3 × √(kinship_era / 100)`, which pays 4 / 9 / 13 / 30 for the same columns. Eras after the first end at `kinship_era` 1,000–10,000, and the square root paid them only 10–30 genes. A `genes ≥ 30% of genes_life` habit then needs `kinship_era ∝ genes_life²`, so eras grew quadratically longer: in the meta-model the ending was never reached (census 6e12 after 52 weeks). Layer 3 stays contractive because `kinship_era` resets at every Speciation and grows only weakly with `genes_life` (§16 point 4).

### 15.3 Passive (from `genes_life`)
| Stat | Multiplier | G = 4 | G = 30 |
|---|---|---|---|
| Food | `(1+G)^1.5` | ×11.2 | ×173 |
| Dig, insight, honeydew, fungus, chitin | `(1+G)^0.25` | ×1.50 | ×2.36 |
| AP | `(1+G)` | ×5 | ×31 |

### 15.4 Reset and keep
- **Resets:** everything, including kinship, Federation nodes, Hardship rewards and Innate research (unless `genetic_memory`, which keeps the current cycle's Innate research; Supercolonies reset it regardless, §11.7).
- **Kept:** genes, Genome nodes, species unlocks and signature genes, achievements, Field Guide, statistics, cosmetics, Strata, Diapause and settings.

### 15.5 Genome (spend genes)
| id | Name | Cost | Max | Effect |
|---|---|---|---|---|
| `genetic_memory` | Genetic Memory | 1 | 1 | The current cycle's Innate research survives Speciation (C167: not Supercolonies) |
| `haplodiploid_fecundity` | Haplodiploid Fecundity | 1 × 2^L | 5 | Lay ×2 |
| `eusocial_leap` | Eusocial Leap | 2 | 1 | Each era starts with `automated_brood`, `blueprint_memory` and `autobuyers` owned |
| `metapleural_glands` | Metapleural Glands | 2 | 1 | Immune to disease events (mold, cordyceps, mites, blight) |
| `venom_gland` | Venom Gland | 2 | 1 | ATK ×2 |
| `species_leafcutter` | Leafcutter lineage | 3 | 1 | Unlock the species |
| `species_honeypot` | Honeypot lineage | 3 | 1 | Unlock the species |
| `species_fire_ant` | Fire Ant lineage | 3 | 1 | Unlock the species |
| `dreaming_hive` | Dreaming Hive | 3 | 1 | Offline cap 48 h at 100% |
| `golden_brood` | Golden Brood | 4 | 1 | 1% of hatches are golden ants (×10 output). Drawn gold. |
| `ancient_instinct` | Ancient Instinct | 4 × 3^L | 3 | Insight ×10 |
| `deep_time_automation` | Deep-Time Automation | 5 | 1 | Auto-Supercolony at a target kinship or cycle time (settings in Prestige → Supercolony, C166) |
| `thermal_ceiling` | Thermal Ceiling | 5 × 4^L | 5 | Food and dig first-softcap thresholds ×1e6 |
| `chronobiology` | Chronobiology | 6 | 1 | Set season length (3–12 min) and the starting season |
| `fossil_record` | Fossil Record | 8 | 1 | Achievement bonus ×1.01 → ×1.02 each |
| `colossal_nests` | Colossal Nests | 10 × 3^L | 3 | colony_scale ×10 |
| `unicolonial_sprawl` | Unicolonial Sprawl | 6 × 1.13^L | MAX | colony_scale ×2. The long Twenty Quadrillion grind (was 5 × 3^L before the re-tune pass; see §16 point 5). Base 6 keeps the rounded-up costs strictly increasing (6, 7, 8, 9, 10, 12, …). |
| `biomes` (STRETCH) | Biomes | 25 | 1 | Forest Floor and Desert Dune landing sites |

### 15.6 Species (chosen at the start of each era)
Only species that keep **both views intact** ship in v1.

| id | Name | Unlock | Rule twist | Signature gene (permanent; earned on the first Supercolony as this species) |
|---|---|---|---|---|
| `garden_ant` | Black Garden Ant (*Lasius niger*) | start | Baseline | `sig_generalist`: all production +10% |
| `leafcutter` | Leafcutter (*Atta*) | 3 genes | Food sources ×0.5. Leaf plants ×2. Nutrition `1 + 2φ`. Once `fungiculture` is owned, 25% of each egg's food cost is paid in fungus. Fungus Gardens allowed from row 10. | `sig_fungal_farmers`: Fungus Gardens +100% |
| `honeypot` | Honeypot (*Myrmecocystus*) | 3 genes | `living_larders` innate. Repletes −75% cost and ×5 cap bonus. Winter forage penalty halved. Base food cap ×0.5. | `sig_social_stomach`: +1% all production per 5 repletes (max +50%) |
| `fire_ant` | Fire Ant (*Solenopsis invicta*) | 3 genes | Starts with 2 Royal Chambers (polygyne). Soldier ATK ×1.5 (venom). Rainstorms make rafts (+25% forage for 60 s, no flood). Rivals raid ×2 as often. | `sig_polygyne`: lay ×1.5 |

**Post-v1 (designed, not built):**
- `army_ant`: nomadic bivouac, no chambers.
- `weaver`: a tree canopy replaces the Below view; leaf nests woven with larval silk.
- `silver_ant`: no trails; forages only in heat.
- `bullet_ant`: ants ÷10, stats ×12.

### 15.7 Ceremony and endgame
- **Ceremony.** The supercolony is preserved in **amber** in the Strata band. A cladogram unfolds, and you pick the species your lineage becomes.
- **Twenty Quadrillion** (from B). The final goal is `census ≥ 2e16`, the estimated number of ants alive on Earth (Schultheiss et al., 2022).
  - Reaching it plays an ending sequence and credits, unlocks a golden-queen cosmetic, and lets play continue.
  - It MUST be reachable within the softcaps. The meta-model (`tools/meta-model.mjs`, test `meta.contractive`) asserts it is reached within **6–10 weeks** of efficient play; it measures **8.0 weeks**, after 11 Speciations and ~780 `genes_life` (Balance Verification, re-tune pass). The main tuning knobs are `unicolonial_sprawl`, `colossal_nests`, the gene formula (§15.2) and the Front's growth per Speciation (§9.3).

---

## 16. Prestige stability (why nothing runs away)

The judges flagged a hard rule: every prestige passive is **polynomial in a lifetime counter**, never exponential, and every loop has an effective exponent below 1. A's original chain analysis ignored compounding *within* a cycle. The corrected analysis and the balance simulation (Balance Verification) are below.

1. **Within a run, food is nearly housing-gated.** Measured in the balance simulation at 60 min: ×10 food multiplier → ×8.6 `f_run`, ×100 → ×75 (exponent ≈ 0.94). ×10 dig → ×3.5. ×10 food *and* dig → ×35, because more soil buys more housing.
2. **Layer 1.** `a ∝ √f_run ∝ Λ^0.5`. Λ is linear in `alates_cycle` only up to 100, then `∝ √A`.
   - So `a ∝ A^0.25` above the knee, before Bloodline purchases.
   - Bloodline traits add bounded multipliers. Each has an effect/cost-growth log-ratio ≤ 0.27, and all have max levels. **But the traits stack:** bought cheapest-first, hardy + deep + fertile + vast + wide together add about 0.35–0.5 to the loop exponent. With the original numbers (threshold 1e7, knee 1,000, no low alates softcap), cycle 1 exploded in the simulation: 26 → 64 → 238 → 842 → 1,835 → 4,201 → 170,000 alates per flight. The knee at 100 and the alates softcap together restore the margin.
   - Balance simulation, cycle 1: 23, 20, 29, 36, 54, 81, 182, 213, 651, 645, 967, 1,451, 2,181, 3,780 alates per flight, with runs of ~20–30 min. That is ×1.0–3 per flight, mostly ×1.3–2.
3. **Layer 2.** `K_gain ∝ A_cycle^0.35`, and `A_cycle ∝ K^≈2` (kinship boosts food^1.25, dig/insight^0.5 and alates^0.25).
   - So `K_gain ∝ K^≈0.7 < 1`, and `kinship_life` grows polynomially in merges.
   - **The alates-per-flight softcap at 3e4 (§12.10) is load-bearing.** Kinship re-buys every capped trait within 2–3 flights of each merge, and long runs late in a cycle gave ×10–40 per flight. In an ablation of the current numbers without the softcap:
     - merge gains escalated to +39 at 8.6 h, then +155 and +213 by 19–22 h;
     - single flights reached 4.4e6 alates;
     - `kinship_life` reached 460–620 by 16–22 h, after which merges stalled behind the Old Ridge.

     With the original numbers, merges gave +138 and then +380…582, and flights reached 7.7e9 alates by 25 h.
   - Balance simulation: merges every 1–4 h gave +4, +6…8, +10…15, +10…11, +10…12, +14…17, +21…22, +25…31, … rising to about +50 by 40–47 h. `kinship_life` was ~80–85 at 15 h and ~215–225 at 30 h.
4. **Layer 3.** `genes ∝ kinship_era` (linear since the re-tune pass; it was `√kinship_era`), and genes boost food^1.5 but kinship gain only indirectly.
   - Balance simulation: the first Speciation gave +4 to +5 genes at 39–47 h (bot). The loop is contractive because `kinship_era` resets at every Speciation and `genes_life` raises it only through the passives (§15.3) and the colony_scale it buys. Doubling `genes_life` gives ×1.21 / ×1.54 / ×1.49 genes per Speciation at 4 / 30 / 300 (meta-model, with the Genome bought from it; with the square root it was ×1.07–1.10).
5. **Purchased multipliers** (Bloodline, Federation, Genome) are either capped or priced so that their implied exponent is ≤ 0.6. The one uncapped exception is `unicolonial_sprawl`, the census engine: ×2 colony_scale per level at ×1.13 cost (re-tune pass; it was ×3), an implied exponent of ln 2 / ln 1.13 ≈ 5.7 on colony_scale.
   - This is safe because colony_scale reaches the gene loop only weakly: `f_run ∝ scale^0.5`, alates ∝ √`f_run` (softcapped above 3e4), kinship ∝ alates^0.35, genes ∝ `kinship_era`. The meta-model's layer-3 check spends `genes_life` on the Genome, so this feedback is inside the measured ratios of point 4.
   - At ×3 cost (exponent 0.63) the ending was out of reach: a census of 1.7e13 after 52 weeks of model play, because 2e16 needs ~17 levels beyond Colossal Nests, about 3e8 genes at 5 × 3^L.
6. **Test `prestige_contractive` (MUST).** Using the meta-model in `tools/meta-model.mjs` (ARCHITECTURE.md §15.5), double each layer's input currency at 3 sample points and assert that the next-layer gain ratio is < 2 (local exponent < 1). Assert separately that A's documented thresholds hold:
   - `f_run = 1e8` → 10 alates (before other factors);
   - 5,000 → 3 kinship;
   - 1,000 (the Speciation gate) → 20 genes.

---

## 17. Seasons

### 17.1 Clock
- A year lasts **24 minutes**: four 6-minute seasons in the order `spring → summer → autumn → winter`.
- The clock runs on **real time**. It keeps advancing offline and is **not reset by prestige**. A new game starts at spring 0:00, so the first winter begins at **18:00**.
- `year` counts completed years. **Year 0's winter is mild:** forage ×0.6 instead of ×0.3, the frost line stops at row 10, and no brood is lost to frost.
- **Season dial (HUD):** shows the current season and time to the next one. With `seasonal_clock` it also shows a forecast strip: the next season and the next scheduled weather event, 60 s ahead.
- `chronobiology` (Genome) lets the player set season length to 3–12 min and choose the starting season. A new length applies at once and keeps the position within the year. The chosen starting season applies at every later run start (landing, Supercolony, Speciation), never to the running clock, so it cannot skip a winter on demand (ARCHITECTURE §18 C84). `seasonal_wisdom` lets them choose the starting season at landing, and that pick wins.

### 17.2 Season effects
| Effect | Spring | Summer | Autumn | Winter |
|---|---|---|---|---|
| Forage (`season_forage`) | ×1.0 | ×1.3 | ×1.1 | ×0.3 (×0.6 in year 0), reduced by R (§12.1) |
| Source specials | Puddles block hexes | Flowers ×1.5; fruit events ×2 | Seed patches ×2; prey ×1.5 | Flowers 0; leaves 0; surface aphids 0 |
| Leaves | ×1.25 | ×1.5 | ×1.25 | 0 |
| Honeydew (herders) | ×1.2 | ×1.0 | ×0.75 | 0 surface; Root Aphid Pens ×0.5 |
| Lay rate | ×1.25 | ×1.0 | ×1.0 | ×0.75 |
| Brood time | ×0.8 | ×1.0 | ×1.0 | ×1.5 |
| Dig | ×1.0 | ×1.0 | ×1.0 | ×1.3 |
| Insight | ×1.0 | ×1.0 | ×1.0 | ×1.5 |
| Food cap | ×1.0 | ×1.0 | ×1.25 ("provisioning") | ×1.0 |
| Rivals | Aggression ×1.25 (turf wars) | Aggression ×1.5 | ×1.0 | **Dormant: no raids, no growth** |
| Flight weather `W` | 1.0 | **1.25** | 1.0 | 1.0 (flying is allowed) |
| Events | Rainstorm, flood, ladybug | Drought, footstep, horned lizard, phorid flies, flight day, picnic | Seed mast, frost snap, picnic | Frost snap; few surface events |

**Layer microclimate** (applies to chambers by layer):
| Layer | Spring | Summer | Autumn | Winter |
|---|---|---|---|---|
| `topsoil` | Nursery +15% brood speed | Nursery −15% (overheat), unless `thermoregulation` or `thermal_brood_shuttling` | — | Frost-exposed first |
| `loam` | — | — | — | Exposed above the frost line |
| `clay` | Fungus ×1.5 and granary spoilage apply all year | ← | ← | ← |
| `gravel` | — | — | — | Nursery +10% (stable temperature) |
| `bedrock` / `aquifer` | No seasonal effect | | | |

### 17.3 The frost line (from D)
- **Winter only.** Frost depth `f` descends from row 0 to `F_max` over the first 90 s of winter, holds, and retreats over the last 60 s.
- `F_max` = 18 (year ≥ 1) or 10 (year 0), minus:
  - 5 with `thermoregulation`;
  - 1 per 3 Mound levels (max −6).
  - The minimum is 4.
- A chamber is **exposed** while more than half of its cells are above row `f`.
- **Exposed chambers:**
  - Effects ×0.5, except the Royal Chamber, Gate and Thermal Chimney.
  - Brood in exposed nurseries is **frozen** (no development).
  - In year ≥ 1, and only while online, frozen brood dies at 0.5%/s, unless it is sheltered:
    - Hibernaculum capacity shelters brood first.
    - With `thermal_brood_shuttling`, brood moves to unexposed nurseries with free slots.
- **Telegraphing:**
  - The forecast warns 60 s before winter.
  - The bottleneck badge shows "Frost: N brood freezing".
  - The Climate overlay draws the projected line.
  - Offline, frost only freezes and never kills.

### 17.4 Seasonal rhythm (the intended play pattern)
| Season | Intended focus |
|---|---|
| Summer | Expand, fight and fly: forage high, rivals active, flight weather. |
| Autumn | Bank food: the cap is ×1.25 and seeds are ×2. Watch the **Winter Stores gauge**: stored food + projected winter net income, plus spoilage/min. |
| Winter | The **building season**: dig ×1.3, insight ×1.5, no raids. Surface quiet, nest busy. |
| Spring | Population boom: lay ×1.25, brood ×0.8. Rainstorms. |

---

## 18. Random events

### 18.1 Rules
- **Frequency:** Poisson, mean **one per 240 s** while the tab is visible and the game is online. None in the first 6:00 of the first run. The first event is scripted: `ev_fallen_fruit` at about 8:00.
- **Run-1 gap cap:** in the first run, the next event is due at most **150 s** after the previous one (the random draw is capped, so it is still one draw). Research and reveals alone leave 3–4 minute gaps between 18 and 30 min, and this keeps "something changes every 2–4 minutes" (§2.2, §24.1). Later runs keep the plain schedule (ARCHITECTURE §18 C75).
- **Pity rules (from C):**
  - The first 3 events of the game are positive.
  - At most 1 negative event in any 3 consecutive events.
  - Every negative event has a counterplay.
  - No negative event fires during a raid warning or within 60 s of another negative.
- **Event card:** 30 s to choose. When time runs out, the safe default (marked \*) applies. Weather events get a 30 s warning with `weather_sense`. Events whose remedy is "send soldiers" (`ev_ladybug_raid`, `ev_antlion_pit`, `ev_horned_lizard`) also show a card. Its **Send** / **Mob it** button checks the garrison, and on success the threat ends at once with no losses. An antlion pit can also be cleared from the map at any time while it is there (click it, or right-click "Send 3 soldiers to clear"), with the same rule (C185).
- **Outcomes:** every resolved choice reports what happened in words ("Adopted the wandering queen: lay ×2 for 10 min."), for the event log (C189). Hidden rolls stay hidden.
- **Rewards** are in seconds of income, with minimums.
- **No events offline.** Saved Finds replace them (§18.5).
- Conditions below are AND-ed with the season filter. Weights are relative; the default is 10.

### 18.2 Event table (both views)
| id | Type | Condition | Above / Below presentation | Choices → outcomes |
|---|---|---|---|---|
| `ev_fallen_fruit` | + | Not winter. Weight ×2 in summer. | A fruit thuds onto a ring 3–6 hex | Spawns `fallen_fruit` (§8.4) on a **revealed hex a trail can reach** (off rival land when possible; any revealed reachable hex from ring 2 when the band has none; no event when nothing qualifies). Draw a trail before it rots. Picnic spills and termite swarms follow the same rule (C221). |
| `ev_picnic_spill` | + | Summer or autumn; ≥ 20 min; weight 3 | A blanket appears at ring 6–12 | Spawns `picnic_spill`. Rival foragers contest it. Mass Recruit. |
| `ev_termite_swarm` | + | Within 2 min after a rainstorm (50%) | Winged termites over 2 hexes | Those hexes yield ×10 food plus 0.05 chitin per forager/s for 45 s. Mass Recruit (20 pheromone). |
| `ev_seed_mast_year` | + | Autumn; max once per year; weight 5 | Seed patches glow gold | Seed patches ×3 for the season |
| `ev_pheromone_bloom` | + | Weight 6 | The Scent Library glows | Insight ×2 for 90 s |
| `ev_lost_scout_returns` | + | ≥ 1 scout | A scout trots in | Reveals 3 frontier hexes, + max(30, 120 s) insight |
| `ev_queens_vigor` | + | — | The queen glows | Lay ×3 for 60 s |
| `ev_rival_mating_flight` | + | Summer; a rival exists | Winged rival alates fill the sky | All rivals AP ×0.7 for 3 min (your window to attack). Clicking a flying alate gives 2 s of food each (max 30), shown as a floating "+X food" with the food icon like a hand-foraged crumb (C223; every floating gain on both maps carries its resource icon). |
| `ev_rival_queen_dies` | + | A rival exists | The rival nest dims | That rival AP ×0.5 for 5 min |
| `ev_flight_day` | + | Summer; `nuptial_preparation` owned; weight 2 | Warm still air shimmers | Flight `W` = 1.5 for 3 min. Prompts "Fly now?" if the Flight is available. |
| `ev_golden_aphid` | + | Spring or summer; an aphid colony is herded | A golden aphid on the aphid hex | Click within 15 s: honeydew ×7 for 60 s |
| `ev_mole_tunnel` | ± | ≥ 10 min | Above: a molehill blocks 1 hex for 3 min. Below: a diagonal mole tunnel. | 6–12 undug or tunnel cells (never chambers) become open tunnel for free. Exposes 1 cache hint. C290 treasure mole: the tunnel always ends at a free cache (seeds → food, fossil → insight, beetle husk → chitin; about 1.5–2 min of income or 15 % of the store, with a floor) that the player clicks to collect; the tunnel itself is unneeded, so auto-backfill clears it. |
| `ev_wandering_queen` | choice | ≥ 200 adults | A strange queen at the entrance | **Adopt:** lay ×2 for 10 min; 20% chance she is a social parasite, then lay ×0.5 for 5 min afterward. **Devour\*:** food = max(100, 120 s). |
| `ev_myrmecophile_guest` | choice | ≥ 100 adults | A rove beetle begs at the shaft | **Accept:** +15% food (additive) for 10 min; 50% chance it then eats 5% of brood over 60 s. **Expel\*:** + max(20, 30 s) chitin. |
| `ev_phengaris_caterpillar` | choice | Summer; ≥ 150 adults | A caterpillar that smells like your brood | **Adopt:** 50% cuckoo (honeydew ×0.9 for 3 min) or 50% predator (eats 1 larva per 10 s for 3 min). If it survives 3 min it becomes a butterfly: + max(100, 120 s) insight and `ach_the_large_blue`. **Reject\*:** nothing. |
| `ev_rainstorm` | − | Spring (summer at 30% weight) | Above: rain particles. Below: water fills rows 0–5. | **Seal entrance\*:** no foraging for 60 s, no flood. **Keep foraging:** topsoil chambers −50% for 60 s, with a 25% flood chance (topsoil chambers disabled 2 min; each click on the water bails 5 s). Trail strength resets unless `weather_sense`. `drainage`: no flood and no −50%. Fire ants: rafts instead (§15.6). |
| `ev_drought` | − | Summer | The grass browns; wells shimmer | For 3 min: leaves ×0.5, flowers ×0.3, honeydew ×1.5. A Water Well makes you immune. `drainage` halves the penalties. |
| `ev_mold_bloom` | − | ≥ 50 adults; chance × (1 − midden reduction) | Below: 3–6 grey mold spots on random chambers | Each spot halves its chamber until scraped (click). Unscraped spots spread +1 per 60 s. A spot belongs to its chamber: demolishing the chamber removes its spots, and relocating it moves them along. |
| `ev_ophiocordyceps` | − / choice | ≥ 300 adults; ≥ 20 min; chance × (1 − midden reduction) | Above: a forager climbs a grass stem and locks its jaws | **Quarantine\*:** forager output −20% for 2 min, and the outbreak ends. **Ignore:** 1% of foragers infected, spreading ×1.5/min for 3 min; infected ants die. |
| `ev_ladybug_raid` | − | Spring or summer; an aphid colony is herded | Red dots swarm the aphid hex | Within 30 s: **Send** ≥ 5 garrison soldiers (or have escort AP ≥ 50 × ring on that colony's trail), or click away all 10 ladybugs. **Wait\***: that colony yields 50% for 5 min. |
| `ev_antlion_pit` | − | A trail ≥ 4 hexes exists | A sand crater appears on one trail hex | That trail loses 2% of its workers per minute until rerouted (free) or cleared (**Send** 3 garrison soldiers). **Wait\***: the losses continue until you reroute or clear the pit from the map (C185). |
| `ev_horned_lizard` | − | Summer | A lizard sits on a trail hex for 2 min | **Reroute\*** (free). **Mob it:** send AP ≥ 200 × ring; it leaves, and you gain 60 s of food. **Ignore:** that trail loses 1% of its workers per 10 s. |
| `ev_footstep` | − | Spring or summer; a garden-path hex exists | A shoe shadow grows over a path area for 5 s | Click the shadow to scatter: no effect. Otherwise trails through the 7-hex area are cut (redraw free) and finite sources there are removed. Mound L5+ shields the 7 hexes of the main entrance (§8.7) and every other entrance hex. |
| `ev_brood_mites` | − | ≥ 500 adults | Specks on the brood | Brood time ×1.5 for 2 min, unless nurses ≥ 1 per brood slot |
| `ev_phorid_flies` | − | Summer | Specks hover over trails | Soldier ATK ×0.5 for 90 s. Foragers −10% on trails without escorts. |
| `ev_fungal_blight` | − | A Fungus Garden exists; chance × (1 − 0.75 with `weeder_ants`) | The garden turns grey | **Quarantine\*:** lose 30% of fungus. **Clean:** click the garden 20 times within 15 s for no loss. C245: clicking the Fungus Garden in the nest is the clean action (the first click also picks Clean on the card); the warning chip counts the clicks left and the time, and points at the garden. |
| `ev_army_ant_column` | − / boss | ≥ 30 min; ≥ 500 adults | Above: a dark river crosses your territory over 90 s. Below: the shaft trembles. | **Evacuate trails\*:** no foraging for 60 s, −5% stored food. **Fight:** battle vs AP 43,000 × (1 + m)^1.5; a win gives 1,800 s of food + max(2,000, 600 s) chitin. |
| `ev_frost_snap` | − | Autumn or winter | Frost creeps over rows 0–3 for 2 min | Brood there is frozen; no deaths. `thermal_brood_shuttling` avoids it. |

Disease events (`ev_mold_bloom`, `ev_ophiocordyceps`, `ev_brood_mites`, `ev_fungal_blight`) do not occur with `metapleural_glands`.

### 18.3 Clickable bonuses (outside the event schedule)
| id | Where | Spawn | Lifetime | Reward |
|---|---|---|---|---|
| `golden_beetle` | Random revealed hex (Above) | Every 5–10 min, uniform, while online | 13 s (20 s with `ach_beetle_collector`) | Roll: **Windfall** 45% (10 min of food; may overflow to 2× cap). **Forage Frenzy** 25% (forage ×5 for 60 s). **Lay Burst** 15% (lay ×3 for 30 s). **Discovery** 15% (60 s of insight + 20 × M_insight). |
| `golden_pupa` | Nursery (Below) | Each egg has a 0.2% chance (at most 1 per 3 min). It hatches as a glowing worker visible for 15 s. | 15 s | Click and choose **Forage Frenzy** (×5 forage for 60 s) or **Windfall** (10 min of food) |

### 18.4 Active vs idle budget
- Measured against a purely passive player at 30–60 min, active play should give about:
  - Rally/Mark/Frenzy used on cooldown: +15%;
  - clicks with Quick Dispatch L10+: +15%;
  - events and golden bonuses: +10%;
  - rerouting to finite jackpots: +20%;
  - raids and conquest timing: +10%.
- That totals **×1.6–1.8**, which is the target. Clicks are capped at 15/s.

### 18.5 Saved Finds (offline replacement for events, from C)
- One Saved Find is banked per 2 h away, max 3.
- On return they appear as small gift-box sprites on the Above map. Each opens a random positive event, drawn from `ev_fallen_fruit`, `ev_pheromone_bloom`, `ev_queens_vigor` and `ev_lost_scout_returns`, or a `golden_beetle`.

---

## 19. Achievements

- Each achievement gives **×1.01 to all production** (food, dig, insight, honeydew, leaves, fungus, chitin), multiplicative. That is ×1.02 each with `fossil_record`, so all 81 give ×2.24, or ×4.97 with `fossil_record`.
- Many also give the listed extra reward. Cosmetic rewards are equipped per slot in Settings → Cosmetics (with a preview) and visibly change the game: Crown / Golden Queen on the queen, Royal Amber interface and amber workers, Snow-cap Mound, White Flag, Gold or Picasso (one colour per trail) trails, a Ladybug pet by the mound, the Winged cursor, the "the Underdog" title in the top bar and the Amber Strata frame around the nest view (ARCHITECTURE §18 C149).
- The **Next Goals** tracker (§25.6) always shows the 3 achievements closest to completion, with progress bars.

| id | Name | Condition | Extra reward |
|---|---|---|---|
| **Population** | | | |
| `ach_first_brood` | First Brood | Hatch your first worker | — |
| `ach_hundred_mandibles` | Hundred Mandibles | 100 adults at once | — |
| `ach_thousand_strong` | A Thousand Strong | 1,000 adults | Lay +2% |
| `ach_ten_thousand` | Ten Thousand Strong | 10,000 adults | Lay +2% |
| `ach_myriad` | Myriad | Census 1e6 | Lay +2% |
| `ach_billion_backs` | A Billion Backs | Census 1e9 | — |
| `ach_six_trillion_legs` | Six Trillion Legs | Census 1e12 | — |
| `ach_twenty_quadrillion` | Twenty Quadrillion | Census 2e16 | Ending sequence, credits, golden-queen cosmetic |
| **Food** | | | |
| `ach_first_crumb` | First Crumb | Click a source | — |
| `ach_clickstorm` | Clickstorm | 10,000 lifetime clicks | Click base ×2 |
| `ach_hoarder` | Hoarder | Food at cap for 10 min straight | Food cap +10% |
| `ach_feast` | Feast | f_run ≥ 1e6 | — |
| `ach_ten_million` | Ten Million Crumbs | f_run ≥ 1e7 | — |
| `ach_billion_bites` | Billion Bites | f_run ≥ 1e9 | — |
| `ach_trillion_tonnes` | Trillion Tonnes | f_run ≥ 1e12 | — |
| `ach_diminishing_returns` | Diminishing Returns | Any stat reaches a softcap | — |
| `ach_survivor` | Survivor | Get through a whole winter without going Hungry | Winter upkeep −5% |
| **Excavation** | | | |
| `ach_going_under` | Going Under | Dig a cell in row 10 | Tunnel work −5% |
| `ach_into_the_clay` | Into the Clay | Row 24 | Fungus +10% |
| `ach_gravel_pit` | Gravel Pit | Row 40 | Soil +5% |
| `ach_bedrock_bound` | Bedrock Bound | Row 58 | Dig +5% |
| `ach_wellspring` | Wellspring | Row 74 | — |
| `ach_master_digger` | Master Digger | 1,000 cells dug, lifetime | — |
| `ach_treasure_hunter` | Treasure Hunter | Collect 10 caches | Cache hint radius +1 |
| `ach_amber_finder` | Amber Finder | Collect an amber bead | — |
| **Chambers** | | | |
| `ach_royal_neighbours` | Royal Neighbours | A Nursery adjacent to the Royal Chamber | — |
| `ach_ant_farm` | Ant Farm | 10 chambers active at once | — |
| `ach_grand_gallery` | Grand Gallery | A Gallery reaches its L8 footprint | — |
| `ach_clean_house` | Clean House | Scrape 10 mold spots | Mold chance −10% |
| `ach_seed_bank` | Seed Bank | Food at its cap while a gravel Granary is active (food is one pooled store) | Granary capacity +10% |
| `ach_living_larder` | Living Larder | 50 repletes | Royal amber palette (cosmetic) |
| `ach_architect` | Architect | Relocate 5 chambers | Relocation cost −25% |
| `ach_royal_ascent` | Royal Ascent | Royal Chamber L10 | Lay +5% |
| **Surface** | | | |
| `ach_pathfinder` | Pathfinder | A trail ≥ 4 hexes | — |
| `ach_double_bridge` | Double Bridge | Redraw a trail ≥ 30% shorter (Goss et al.) | Strength rise +10% |
| `ach_highway` | Highway | A trail at S_max for 5 min | S_max +5 |
| `ach_cartographer` | Cartographer | Reveal the whole map | Scouts +50% |
| `ach_land_grab` | Land Grab | Own 50 hexes | Claim cost −10% |
| `ach_shepherd` | Shepherd | Herd 3 aphid colonies at once | Honeydew +10% |
| `ach_peach_fuzz` | Peach Fuzz | Fully harvest a fallen fruit | — |
| `ach_picnic_crasher` | Picnic Crasher | Harvest 100% of a picnic | Golden Beetle +5 s |
| `ach_mutualist` | Mutualist | Milk a Lycaenid caterpillar for 5 min | — |
| **Combat** | | | |
| `ach_border_dispute` | Border Dispute | Win a battle | — |
| `ach_square_law` | Square Law | Win while outnumbered | AP +5% |
| `ach_flawless` | Flawless | Win a nest assault losing < 5% | Alarm Rally cost −20% |
| `ach_pavement_is_ours` | The Pavement Is Ours | Conquer the Pavement Ants | — |
| `ach_total_war` | Total War | 5 conquests in one run | Soldier HP +10% |
| `ach_david_and_goliath` | David and Goliath | Win at < 40% predicted odds | "Underdog" title (cosmetic) |
| `ach_ritualist` | Ritualist | Win 10 tournaments | Tournament threshold 1.5 → 1.4 |
| `ach_phragmosis` | Phragmosis | Repel a nest raid with zero brood lost | Gate +5% |
| `ach_big_game` | Big Game | Hunt a beetle | — |
| `ach_old_ridge_falls` | The Old Ridge Falls | Conquer the Old Ridge | — |
| `ach_front_broken` | The Front Is Broken | Defeat the Argentine Front | — |
| **Seasons and events** | | | |
| `ach_first_winter` | First Winter | Reach spring of year 1 | Snow-cap mound skin |
| `ach_seasoned` | Seasoned | 10 years elapsed | — |
| `ach_golden_touch` | Golden Touch | Catch a Golden Beetle | — |
| `ach_beetle_collector` | Beetle Collector | Catch 50 Golden Beetles | Beetles last 20 s |
| `ach_the_large_blue` | The Large Blue | Raise a Phengaris caterpillar to a butterfly | Insight +5% |
| `ach_zombie_averted` | Zombie Apocalypse Averted | End an Ophiocordyceps outbreak with < 1% losses | — |
| `ach_rain_dancer` | Rain Dancer | Weather 10 rainstorms | — |
| `ach_mole_friend` | Mole Friend | 5 mole tunnels | — |
| `ach_flying_ant_day` | Flying Ant Day | Fly during a Flight Day | Alates +5% |
| **Prestige** | | | |
| `ach_first_flight` | First Flight | Complete a Nuptial Flight | — |
| `ach_swift_swarm` | Swift Swarm | Fly within 20 min of a run start | Alates +10% |
| `ach_gentle_giants` | Gentle Giants | Fly having raised no soldiers that run | Alates +5% |
| `ach_peak_timing` | Peak Timing | Fly within 60 s of the alates/min peak | — |
| `ach_sky_full_of_wings` | Sky Full of Wings | 100 alates in one flight | Winged cursor (cosmetic) |
| `ach_thousand_queens` | A Thousand Queens | 1,000 lifetime alates | — |
| `ach_hardship_tier` | Hardened | Complete any Hardship tier | — |
| `ach_hardship_master` | Unbreakable | All 6 Hardships at tier 5 | — |
| `ach_one_family` | One Family | First Supercolony | Gold trail colour (cosmetic) |
| `ach_living_fossil` | Living Fossil | First Speciation | Amber Strata frame (cosmetic) |
| `ach_sociobiologist` | Sociobiologist | Own every research node in one run | Insight ×1.25 |
| **Secret** (hidden until earned) | | | |
| `ach_queens_favorite` | Queen's Favourite | Click the queen 500 times | Crown cosmetic |
| `ach_overthinker` | Overthinker | Reroute one trail 20 times in one minute | — |
| `ach_pheromone_picasso` | Pheromone Picasso | A trail ≥ 30 hexes | Trail colour cosmetic |
| `ach_lady_luck` | Lady Luck | Click 50 ladybugs | Ladybug pet cosmetic |
| `ach_pacifist_flight` | Pacifist Flight | Fly without any battle that run | White-flag mound cosmetic |
| `ach_wilsons_pride` | Wilson's Pride | Every caste and every job active at once | +3% all production |
| **Field Guide** | | | |
| `ach_naturalist` | Naturalist | 25 Field Guide entries | — |
| `ach_field_guide_complete` | Myrmecologist | All Field Guide entries | — |

---

## 20. Field Guide (codex, from B, merged with C's Colony Notes)

- Each entry unlocks on first encounter. It pays **max(10, 30 s of insight income)** once, and shows a 40–60 word biology note written in-house (no quoting).
- Entries are listed in the Field Guide tab, grouped by category.
- Tooltips elsewhere stay at 12 words or fewer and link to the entry.

| id | Unlocks when | Topic |
|---|---|---|
| `fg_founding_queen` | New game | Claustral founding: the queen raises her first brood on stored reserves |
| `fg_nanitics` | First worker | Tiny first-generation workers |
| `fg_trail_pheromone` | First trail | Recruitment trails and evaporation |
| `fg_double_bridge` | `double_bridge` or the achievement | Colonies converge on the shorter path |
| `fg_tandem_running` | `tandem_running` | Teacher–follower recruitment |
| `fg_polyethism` | `age_polyethism` | Age-based division of labour |
| `fg_polymorphism` | `polymorphism` | Diet and juvenile hormone decide caste |
| `fg_trophic_eggs` | `trophic_eggs` | Infertile eggs as food |
| `fg_repletes` | First replete | Living honey pots |
| `fg_supermajors` | First supermajor | Giant defenders (e.g. *Pheidole*) |
| `fg_alates` | First alate | Winged reproductives |
| `fg_nuptial_flight` | First flight | Synchronised mating flights |
| `fg_trophobiosis` | First herded aphid | Aphids trade honeydew for protection |
| `fg_root_aphids` | First Root Aphid Pen | Underground aphid herds |
| `fg_lycaenid` | First Lycaenid caterpillar | Butterfly larvae that pay ants in sugar |
| `fg_fungus_gardens` | First Fungus Garden | Leafcutter agriculture |
| `fg_weeder_ants` | `weeder_ants` | Gardeners remove parasite fungi |
| `fg_midden` | First Midden | Refuse piles and hygiene (necrophoresis) |
| `fg_mound_heat` | Mound L5 | Mounds as solar collectors |
| `fg_overwintering` | First winter | Cold torpor and diapause |
| `fg_seed_harvesting` | First seed patch | Harvester ants and granaries |
| `fg_square_law` | First battle | Lanchester's square law in ant battles (Franks & Partridge) |
| `fg_ritual_tournaments` | First tournament | Honeypot-ant display contests |
| `fg_black_garden_ant` | Rival sighted | *Lasius niger* |
| `fg_pavement_ant` | Rival sighted | *Tetramorium* spring turf wars |
| `fg_red_wood_ant` | Rival sighted | *Formica* formic acid spray |
| `fg_carpenter_ant` | Rival sighted | *Camponotus* nests in wood |
| `fg_fire_ant` | Rival sighted | *Solenopsis* venom and rafts |
| `fg_slave_maker` | Rival sighted | *Formica sanguinea* brood raids |
| `fg_army_ant` | Army Ant Column | *Eciton* swarm raids |
| `fg_argentine_ant` | Argentine Front | Unicolonial supercolonies |
| `fg_ladybird` | Ladybug raid | Aphid predators |
| `fg_antlion` | Antlion pit | Sand-pit traps |
| `fg_horned_lizard` | Horned lizard | Ant-eating reptiles |
| `fg_ophiocordyceps` | Cordyceps event | Zombie-ant fungus |
| `fg_phengaris` | Phengaris event | The Large Blue's brood mimicry |
| `fg_phorid_flies` | Phorid event | Decapitating flies |
| `fg_myrmecophiles` | Myrmecophile event | Nest guests |
| `fg_twenty_quadrillion` | Census 1e9 | Global ant population estimate (Schultheiss et al., 2022) |
| `fg_amber` | Collect the amber bead | Ants fossilised in amber, and how old the ant lineage is |

There are **40** entries.

---

## 21. Offline progress

### 21.1 Elapsed time
- `Δ = now − state.lastSeen` in wall-clock ms.
  - If `Δ < 0` (the clock went backward), `Δ = 0`; set `state.flags.clockSkew` and show a notice. The flag is rewritten on every load, so the notice shows once, not on every later load.
  - Forward jumps are clamped to the cap.
- **Gaps under 60 s** count fully, as online. They are caught up over several frames (a small budget per frame) instead of in one frame, so returning to the tab never freezes it; the result is identical.
- **Hidden tab:** on `visibilitychange`, the hidden time is simulated at **100% efficiency up to 4 h**. Any remainder follows the offline rules. This also holds when the hidden tab is closed, reloaded or discarded by the browser before it is shown again: the save made while hidden remembers how far the simulation got, and the next load credits that hidden time first (ARCHITECTURE §18 C78, C79).

### 21.2 Cap and efficiency
| Source | Cap | Efficiency |
|---|---|---|
| Base | **4 h** | **50%** |
| `collective_memory` | +2 h | — |
| `long_memory` (×3 levels) | +2 h per level | +10% per level |
| `deep_vault` (×8 levels) | +1 h per level | — |
| `diapause_logic` | — | +25% |
| `diapause_mastery` (Federation) | Set to 24 h | Set to 100% |
| `dreaming_hive` (Genome) | Set to 48 h | Set to 100% |

Efficiency is capped at 100%.

### 21.3 Method
- `simulateOffline(state, seconds)` runs the **same `step()`** with this schedule (from D):
  - 10 s steps for the first 10 minutes;
  - 60 s steps after that;
  - at most 1,500 steps. If more would be needed, the step size is enlarged uniformly. 24 h must simulate in ≤ 60 ms. (Known gap: the shipped code takes about 0.2–0.3 s for 24 h; meeting the budget needs fewer offline steps or a cheaper offline trail model, ARCHITECTURE §18 C87.)
- Brood is stored as cohorts, so large steps stay accurate.
- **Efficiency** multiplies every production rate (food, dig work and soil, insight, honeydew, leaves, fungus, chitin, pheromone) **and upkeep**, so net income scales evenly.
- Laying, brood development, seasons and the dig queue run in real time. Dig work arrives at the efficiency-scaled rate.
- **Test invariant:** `simulateOffline(s, 3600)` at 100% efficiency is within **2%** of 36,000 online ticks of 0.1 s, with events disabled.

### 21.4 What runs and what is frozen
| Runs offline | Frozen offline (no harm) |
|---|---|
| Laying and brood development (cohorts) | Events, Golden Beetles and Golden Pupae. Harmful event effects pause too: a mold spot or a timed penalty neither applies nor counts down offline, and is back unchanged on return (ARCHITECTURE §18 C68). |
| Trails at their current allocation. Strength sits at equilibrium; no Mark bonus. | Raids (both directions), battles, hunts |
| Finite sources deplete. Their workers auto-move to the nearest renewable source. | Rival growth and fire-ant creep |
| The dig queue (chambers complete and glow on return) | Spoilage, frost brood deaths, Hungry penalties (food floors at 0; laying pauses) |
| Insight, honeydew, fungus and chitin rates | Auto-Flight (it fires on return if its condition was met) |
| Pheromone refills to cap; claim channels progress | Tournaments, bribes, truce timers (paused) |
| Seasons (real-time clock); autobuyers | Hardship timers, if any |

The torpor floor (from B) is a backstop. If any code path would reduce adults offline, it may not drop them below 100% of the departure count. In other words, adults are never lost offline.

### 21.5 Diapause bank (from A; STRETCH, cut-list #4)
- Time beyond the cap is banked at **10%** into `diapause`, up to 8 h.
- The player can spend it to run the game at **2× speed** (3× with `diapause_mastery`) while online.
- Events and raids keep their real-time pacing, so acceleration affects only economy and brood.
- While it runs, a HUD chip shows the speed, the bank and the time left (bank ÷ (speed − 1)); its tooltip, the rail row and the Stats panel say what is accelerated (income and upkeep, source depletion, laying, brood growth, digging), what keeps real time (seasons, events, raids, rivals, battles, scouting), the drain and how the bank is earned (ARCHITECTURE C112).

### 21.6 Welcome-back screen (from C)
- A modal with stat lines:
  - food gained and lost to full storage ("1,240 food lost to full granaries": a nudge);
  - ants hatched, cells dug, chambers completed;
  - seasons passed, sources depleted;
  - Saved Finds waiting.
- It includes a **5-second time-lapse** of the nest growing, replayed from the dig-queue completion log.

---

## 22. Saving, loading, export and import

- **Autosave** every 15 s, on `visibilitychange` (hidden), and before every prestige.
  - The main save goes to localStorage key `sld_save`.
  - Backups go to `sld_save_bak_0..2`, rotated every 5 minutes.
  - Every localStorage access is wrapped in try/catch. On failure the game shows a persistent "Saving unavailable: use Export" banner.
- **Export string:** `SLD1:` + base64(UTF-8 JSON) + `:` + FNV-1a 32-bit checksum (hex) of the JSON text.
  - The JSON is `{ v: <schemaVersion>, savedAt: <ms>, state }`.
  - The nest grid is run-length encoded. Target ≤ 60 KB.
  - Export offers copy-to-clipboard and a `.txt` download (the download needs a user click).
- **Import** validates the prefix, checksum and JSON. It then runs the **migration chain** `migrations[v] → v+1` up to the current version.
  - On any failure the current save is untouched and a readable error is shown.
- **Hard reset:** Settings → "Abandon colony". The player must type `abandon` to confirm.
- **One tab at a time:** the newest open tab owns the save. When the game is opened in a second tab, the first one hands over its latest state, stops, and shows "Game open in another tab" with a **Play here** button (which reloads and takes the game back). A tab that has lost ownership never writes its save, and a hard reset in one tab cannot be overwritten by another (ARCHITECTURE §18 C80).
- An imported save is written to storage at once.
- **Test invariants:**
  - save → export → import yields a deep-equal state;
  - every migration from v1 forward is tested with a fixture;
  - a corrupted checksum is rejected.

---

## 23. Unlock and reveal schedule

**Rules (from C):**
- A panel, resource or tab exists only once it is relevant.
- Reveals are queued, so no two happen within 30 s. The queue runs in the order of the table below, so a core reveal that comes due behind a backlog goes ahead of later rows. Each reveal slides in with a soft chime, and its first item is preselected and glowing.
- **New-player pacing (ARCHITECTURE §18 C202).** During the first 20 minutes of the first run, only the **core loop** (crumb → workers → jobs → Gallery → trail → research: the Colony panel, Diggers, Build, Scouts, trail slots, Research, Map, plus Golden Beetle, Chitin, Rivals and raid warnings, which announce something already on screen) keeps the 30 s spacing. Every other reveal waits **50 s** after the previous one. A reveal the colony is stuck on right now counts as core (Granary while the food store is full, Nursery while brood slots bind, Royal Chamber level-ups while the lay rate binds).
- **Reveal gates.** Some reveals wait until the player has used what came before. The feature is unlocked for play on time, but it is only shown once the gate holds. Adaptations, Granary, Nursery and Royal Chamber level-ups wait for the first Gallery. Egg reserve, Achievements, Midden, Season dial, Mound, Random events, Rivals, the Climate overlay and the Gate wait for the **core loop**: a chamber placed, a second trail drawn (or a hex claimed), and a research bought. Scent Library waits for Research, and Potent Trails for trail slots. If the player skips a step, the gates open on their own (Gallery gates at 10:00, the others at 15:00). Later runs are not gated. While a gate holds the queue, the ribbon names the missing step ("Next: Granary · place your first Gallery"), but only once that step's feature is on screen.
- **One callout per new feature.** The first time a panel or feature is revealed, a one-line "what this is / what to do" card appears under the HUD (§25.6 rule 10).
- The **Next-unlock ribbon** always shows the nearest upcoming reveal and its ETA. Adult-count and first-hatch ETAs include the brood still growing and the development time of new eggs. When nothing timed is within 2 minutes, it names the next step and its condition instead (for example "Next: Research · reveal your first hex"; ARCHITECTURE §18 C86).
- A newly revealed panel never takes over the open tab. Its tab slides in with a "new" dot, and the onboarding glow alone points the way (§25.6).

| Feature | Reveal condition | Typical time in run 1 |
|---|---|---|
| Above canvas, crumb glow, Food counter. Below inset (30% height, labelled "Your nest: the queen and her eggs" with an **Expand** button) showing the queen and her first egg. | New game | 0:00 |
| Colony panel (brood pipeline, Forager chip) | First worker | 0:15 |
| Digger job, Soil | 3 adults (core: 30 s after the Colony panel) | ~0:45 |
| Build panel, Gallery blueprint. The Below view grows to full size with the callout "Your nest is full, so the queen stops laying. Build a Gallery for room." Bottleneck badge. Gallery demo (labelled) while housing stays full. | Housing full for the first time (core) | ~1:00–1:15 |
| Scout job; fog frontier shimmer | 12 adults (core) | ~1:45 |
| Trail-slot indicator; ghost-ant demo of trail drawing | Crumb saturated (n > c) (core) | ~2:15 |
| Insight; Research tab showing 3 nodes | First hex revealed (core) | ~2:45 |
| Adaptations tab: `quick_dispatch`, `strong_mandibles`, `royal_feeding` (and `digging_claws` once a digger works) | First worker; shown after the first Gallery is placed | ~3:30 |
| Granary | Food earned ≥ 120 or food cap reached; shown after the first Gallery (at once while the food store is full) | ~2–4 min |
| Nursery | 8 adults; shown after the first Gallery (at once while brood slots bind) | ~2–5 min |
| Map tab | Second trail or first claim (core) | when it happens |
| Royal Chamber level-up | 20 adults; shown after the first Gallery | ~4–6 min |
| Golden Beetle | 5:00 elapsed in the first run | 5:00 |
| Chitin | First chitin gained (dead insect) | ~5 min |
| Pheromone meter, Mark, hex claiming | `scent_marking` (bought by the player, shown at once) | ~6 min |
| Egg reserve slider | First time a purchase is unaffordable because eggs keep spending food, once the Build panel is open; shown after the core loop | ~6–9 min |
| Scent Library | 30 adults; shown after Research | ~6–10 min |
| Achievements tab and Next Goals tracker | 3 achievements earned; shown after the core loop | ~7–12 min |
| `potent_trails` | 40 adults; shown after trail slots | ~8–13 min |
| Midden | 120 adults; shown after the core loop | ~10–15 min |
| Season dial | 5:30 elapsed (first summer at 6:00); shown after the core loop | ~8–16 min |
| Mound | Soil ≥ 300 for the first time; shown after the core loop | ~10–17 min |
| Random events | Scripted `ev_fallen_fruit` (the fruit itself still lands at ~8:00); shown after the core loop | ~10–18 min |
| Soldiers, Barracks, caste targets, War panel | `polymorphism` | ~12–15 min |
| Rival panel, territory borders | First rival nest revealed; shown after the core loop | ~8–12 min |
| Job ratio presets (auto jobs) | `age_polyethism` | ~9–11 min |
| Herders, Honeydew, Root Aphid Pen, Queen's Feast | `aphid_husbandry` | ~10–12 min |
| Climate overlay, Winter Stores gauge | Autumn of year 0; shown after the core loop | 12:00 or a little later |
| Prestige tab (Flight checklist and projection) | `f_run ≥ 2e7` or `nuptial_preparation` researched | ~16–20 min (bot ~13–17) |
| Rally | `recruitment_pheromones` | ~12–15 min |
| Raid warnings | First rival becomes eligible (§9.10) | ≥ 15 min |
| Frost line | First winter | 18:00 |
| Gate | First raid warning, or 25:00; shown after the core loop | ~18–25 min |
| Leafcutters | `leafcutting` | ~16–25 min |
| Hibernaculum | `overwintering` | ~30–40 min |
| Nuptial Chamber and exit shaft | `nuptial_preparation` | ~20–44 min (the bot rushes it at ~20) |
| Fungus widget, Fungus Garden, Nutrition ring | `fungiculture` | ~45–50 min |
| Flight button active | All of §13.1 (gated by `f_run ≥ 1.85e8`) | ~50–75 min (bot ~42–55) |
| Bloodline tab | First Flight | ~60–90 min |
| Hardships | 150 lifetime alates | ~2.5–3 h |
| Supercolony teaser (greyed Federation tab, daughter-colony trails) | 1,000 lifetime alates | ~3–4 h |
| Old Ridge | `budding` and `alates_cycle ≥ 2,500` | ~4–6 h |
| Federation and Edicts | First Supercolony | ~6–10 h |
| Genome / Species preview (greyed) | `kinship_life ≥ 20` | ~8–11 h (balance bot: merges of +4, +6…8, +10…15) |
| Argentine Front | `megacolony` | ~20–40 h |
| Genome / Species | First Speciation | ~35–60 h |

---

## 24. Pacing

### 24.1 Run 1 beat script (first 30 minutes; target times for a human)
| Time | What the player sees and does | Unlock | Teaches |
|---|---|---|---|
| 0:00 | The crumb by the entrance pulses. The Below inset, labelled "Your nest", shows the queen beside her first egg (laid from the 5 starting food); its Expand button opens the full nest view early. Each click sends an ant out and back: +1 food. | Food | Clicking |
| 0:15 | The first nanitic hatches and walks to the crumb. "+0.5/s" appears. The Colony tab arrives alone, with its callout. | Colony panel | Ants earn while you watch |
| 0:45 | "Dig" chip appears, with a callout. Diggers carry pellets up the shaft. | Digger, Soil | Jobs |
| 1:00–1:15 | "House full" pip on the Royal Chamber. The Below view grows to full size with the callout "Your nest is full… Build a Gallery for room." While housing stays full, a ghost ant carries a dashed Gallery outline to a good spot, labelled "Nest full: pick Gallery in the Build tab, then click here", and the Build tab glows. | Build, Gallery, bottleneck badge | Placing and digging |
| 1:45 | Scout chip; the fog edge shimmers. | Scout | Exploration |
| 2:15 | The crumb saturates. Scent particles drift toward a seed patch 2 hexes out, and a ghost ant demonstrates dragging a trail. | Trails | Capacity and distance |
| 2:45 | First hex revealed → insight. The Research tab opens with Trail Memory, Coordinated Digging and Brood Care. | Research | Second currency |
| 2–5 min | Once the first Gallery is placed, about one every 50 s: the Adaptations tab, the Granary (sooner if the food bar is full at 150), the Nursery (sooner if eggs wait for slots), Royal Chamber level-ups (clicking the queen now opens her inspect panel). | Adaptations, Granary, Nursery, Royal upgrades | Storage, slots, lay rate |
| 5:00 | A Golden Beetle scuttles across a hex. A dead insect appears and gives the first chitin. | Golden Beetle, Chitin | Active play |
| 6:00 | Summer: the map turns gold, forage ×1.3. Scent Marking → Pheromone, Mark, claims. | Pheromone | Active meter |
| 6–15 min | Once the core loop is done (a chamber, a second trail, a research), about one every 50 s: Egg reserve, Scent Library, Achievements and Next Goals, Potent Trails, Midden, Season dial, Mound, Random events. Each has its one-line callout. | Achievements, Midden, Seasons, Mound, Events | Guidance; spatial planning; rhythm; soil sink |
| 8:00 | A strawberry thuds onto the map (scripted positive event; the event system is named later, with the core loop done). | — | Jackpots |
| 9:00 | Black Garden Ants revealed at ring 4: rival panel and territory borders appear. | Rivals | Threat |
| 10:00 | Age Polyethism: jobs automate by ratio. | Auto jobs | Automation |
| 11:00 | Aphid Husbandry: herders, honeydew. A Root Aphid Pen must touch a root growing down from a surface plant. | Honeydew | Views linked by roots |
| 12:00 | Autumn: seeds ×2, food cap ×1.25. The Winter Stores gauge and frost forecast appear. | Climate overlay | Planning |
| 13:00 | Polymorphism (300 insight): soldiers, Barracks, caste targets. The Prestige tab follows at ~16–20 min (`f_run ≥ 2e7`) with the Nuptial Flight checklist. | Soldiers, prestige preview | Military; long-term goal |
| 15:00 | Rally. First raid warning possible. | Rally, raids | Defence |
| 18:00 | First (mild) winter: snow, forage ×0.6, dig ×1.3, insight ×1.5. The frost line descends to row 10; shallow brood freezes but does not die. | Frost line | Winter is for building |
| 20–24 | First raid, then first conquest of the Black Garden Ants. The outpost gives new hexes and a trail origin. Gate available. | Conquest | Combat |
| 24:00 | Year 1 spring: lay ×1.25, rainstorms. | — | — |
| 25–30 | Clay layer (row 24), Clay Masonry, Leafcutting. Pavement Ants harass trails. | Clay, leafcutters | Depth tradeoffs |

**About 700–900 ants, ~1e4 food/s and ~14 achievements at 30 min** for a human. The bot is faster: ~1,300 ants, ~1.5–6e4 food/s and 20–21 research nodes at 30 min (Balance Verification, Pacing-bot pass).

### 24.2 Minutes 30–90
| Time | Beat |
|---|---|
| 30–40 | Pavement Ants conquered (~60 soldiers, or Formic Acid + Serrated/Thick). Early Warning, Trophic Eggs. |
| 42:00 | **First hard winter.** The frost line reaches row 18, so nurseries must be deep (or use a Hibernaculum / Thermal Brood Shuttling). |
| 40–50 | Nuptial Preparation (~44 min). Dig the Nuptial Chamber and its exit shaft, which creates the **second entrance hex**. Alate rearing begins. |
| 46–65 | **Flight available** (≥ 13 alates; ~23–31 with reared alates). Fungiculture and Nutrition. Red Wood Ants appear. The Alates/min meter rises. |
| 60–90 | The Flight becomes clearly worth it: **30–60 alates** with reared alates and summer weather. Most players fly. |

### 24.3 Calibration evidence
The first calibration pass (which excluded combat, events, honeydew, fungus and territory) is **superseded** by the full-system balance simulation in **Balance Verification** at the end of this document. Its milestone tables live there and nowhere else, so the numbers cannot drift apart.
- **Humans should be expected at 1.2–1.5× the bot's times.**

**Lessons carried over from A's post-mortem and both calibration passes:**
- Housing stays linear per level through run 1.
- Insight never scales with population. Scouting must also have diminishing returns (`scouts^0.6`); otherwise a 5% scout share reveals the whole map, and banks its insight, within 15 minutes.
- Lineage applies to food only. When it also boosted dig and insight, alates exploded ×3–4 per flight.
- Bloodline trait cost growth must keep `ln(effect)/ln(growth) ≤ ~0.27` per trait. The traits also **stack**, so the Lineage should turn to √ early (knee at 100) for margin.
- A per-flight alates softcap (3e4) is required. Long late-cycle runs otherwise compound into kinship blow-ups.
- Anything that caps a pipeline stage must scale with `colony_scale` (gardener slots did not, and Nutrition starved at ~1e5 adults).
- The shipped pacing bot (§28) must repeat these measurements with every system turned on.

### 24.4 Long-term pacing
| Cumulative time | What the player is doing | New this stage |
|---|---|---|
| 0–30 min | First nest, trails, first conquest | §24.1 |
| 30–90 min | Clay and gravel, Pavement and Wood ants, alate rearing | **First Flight** |
| 1.5–2.5 h | Runs 2–3 (~30–45 min): Founding Stores, Nanitic Vigor, Ancestral Blueprint, Automaton Instincts | Innate research begins (run 3) |
| 2.5–4 h | ~25 min runs, 300–1,000 alates per flight | **Hardships**, tier 3–5 rivals, Sun Compass map |
| 4–6 h | 1,000–5,000 alates per flight. Polygyny, Vast Galleries, Budding. | Old Ridge appears |
| 6–10 h | Old Ridge conquered (25 hexes held) | **First Supercolony** (3–10 kinship), Royal Edict, Federation |
| 10–20 h | Autobuyers, Auto-Flight, satellites, radius-16 map | Mostly hands-off 15–25 min runs |
| 12–45 h | Kinship 50–1,000. Megacolony (50 K) | Argentine Front |
| 35–60 h (days 3–6) | Kinship 1,000 and the Front broken in the same run | **First Speciation** (~20 genes), species choice |
| Week 2+ | Species signature genes, Genome, Hardship tier 5s, Refinements | Collection and mastery |
| Weeks 2–10 | Unicolonial Sprawl grind: ~10 more eras of 2–9 days, each longer than the last | **Twenty Quadrillion** ending (meta-model: 8.0 weeks) |

---

## 25. UI layout

### 25.1 Breakpoints
| Viewport | Layout |
|---|---|
| **Wide-tall** (≥ 1280 wide and ≥ 820 tall) | Three columns. **Left:** resource rail (220 px). **Centre:** the Above canvas on top (~55% of height) and the Below canvas underneath (~45%), joined by the animated shaft connector at the entrance, so it reads as literal above and below. **Right:** tabbed panels (380 px). |
| **Wide-short** (≥ 1280 wide, < 820 tall) | Side by side (D): Below on the left (~30%), Above in the middle (~45%), panels on the right. |
| **Medium** (768–1279) | One canvas area with tabs **Above / Below** and a **Split** toggle that stacks both at reduced size. Panels open in a right-hand drawer that docks beside the canvas while open (the canvas narrows instead of being covered), and the resource rail becomes a top bar. |
| **Narrow** (< 768) | A single full-width canvas with 16 px gutters and view tabs. Panels are a bottom sheet (peek / half / full). The resource bar scrolls horizontally inside itself, never the page. The panel tab row scrolls sideways too, with fade edges where there is more; icon buttons show their name on hover or focus (C197). |
| **First load** (all sizes, from C) | Above fills the canvas area and Below is a 30% inset showing the queen, labelled "Your nest: the queen and her eggs" with an **Expand** button that opens the full view early (C203). Below animates to its full slot at the first housing cap (~1:00), with a callout explaining why. When that happens in a view that hides the nest (the narrow default), the view switches to show the nest, unless the player has chosen a view. |

```
┌────────────┬──────────────────────────────────────────┬──────────────────────┐
│ RESOURCES  │  [season dial] [bottleneck badge] [ribbon: next unlock ETA]   │
│ food  ▮▮▮▯ │ ┌──────────────────────────────────────┐ │ TABS                 │
│ soil       │ │            ABOVE (hex map)           │ │ Colony | Build | Map │
│ insight    │ │   trails · territory · rivals · fog  │ │ Research | Prestige  │
│ pheromone  │ │                 (0,0) entrance       │ │ Achievements | Guide │
│ honeydew   │ └──────────────────╥───────────────────┘ │ Stats | Settings     │
│ chitin     │    flow strip: +food/s ▸ ants ▸ raids    │                      │
│ fungus     │ ┌──────────────────╨───────────────────┐ │ (active panel)       │
│ ─────────  │ │          BELOW (nest cross-section)  │ │                      │
│ colony ×   │ │  strata · chambers · dig queue chips │ │                      │
│ scale      │ │  frost line · brood · scroll bar     │ │                      │
│            │ └──────────────────────────────────────┘ │                      │
│ toasts ▸   │  [overlays: climate raid haul adjacency] │  event card (top)    │
└────────────┴──────────────────────────────────────────┴──────────────────────┘
```

### 25.2 HUD elements
- **Resource rail.** Shows only revealed resources: value, rate/s, a cap bar if capped, an "sc" badge if softcapped, and a red rate when negative.
- **Ants row (player request, ARCHITECTURE §18 C152):** total adults and "+N brood"; under it a foldable breakdown — Workers, Soldiers, Supermajors, Repletes, Alates (reared), Queens — listing only castes that are unlocked or present. Clicking the row folds or unfolds it (remembered per browser). Hidden while the colony has only workers and one queen.
- **Bottleneck badge** (§2.2): a steady width (long names truncate, the timer keeps its place), "No bottleneck" when nothing binds, and a 3 s wait before it switches to a new limit; a limit that briefly trades places keeps its timer (ARCHITECTURE §18 C194). Each caste row of the Ants breakdown shows its cap: workers / housing, soldiers / berths, supermajors / War Hall berths, repletes / replete berths, alates / cells (C193). Beside "Year · run" the brand line shows how long the run has lasted (C196). Hovering a resource adds its top 3 sources and sinks over the last minute (C191); hovering the lay rate lists every factor of the queen's laying (C192). The **season dial** with its forecast strip. The **next-unlock ribbon** with ETA. **Colony Scale** once it exceeds 1.
- **Warning chips** beside the badge: one red chip per active harmful effect (mold with its spot count, blight, flood, rain, drought, phorid flies, mites, ladybugs, antlion, lizard, footstep, army ants, frost snap …, and the Argentine Front countdown once one of its nests falls). Each shows the time left and a tooltip; clicking it brings the spot into view and highlights it, and repeated clicks step through all spots. The toast of a negative event has a matching **Show** button.
- **Flow strip** between the canvases: food/s arriving at the shaft, ants out, active raids and campaigns. It is also the divider: drag it to resize the two views in Stacked and Side by side (each keeps at least 120 px; remembered per browser; double-click resets) (C197).
- **Toasts** at bottom-left, at most 2 per 10 s.
- **Event cards** at top-centre. They are non-modal and show a timer and the default choice.
- **Modals** are used only for irreversible actions: prestige confirmations, hard reset and import.

### 25.3 Panels (right-hand tabs)
| Tab | Contents | Reveal |
|---|---|---|
| Colony | Brood pipeline (eggs, larvae and pupae counts; lay rate; egg reserve slider); caste targets with Max and Keep berths filled (§5.5); Retire to workers (§6.1); job chips with +/− and presets; berth lines (Barracks for soldiers, War Hall for supermajors, Replete). Adaptations have their own tab; alate rearing lives on the Prestige tab, Flight view | First worker |
| Adaptations | The repeatable food upgrades (§10): Buy, ×10 with its total cost, Max (everything affordable now) (ARCHITECTURE §18 C143) | First worker (with the Colony tab) |
| Build | Chamber list (locked items greyed with their unlock condition), dig queue chips, Mound, blueprint save/load | First housing cap |
| Map | Trails list (workers, strength, yield, escorts, Mark/Rally), territory and claim cost, rivals list and war panel, hunts | Second trail or first claim (after trail slots are revealed) |
| Research | One branch at a time (no "All" view; opens the first branch with something available, then the last one viewed, remembered per browser; each branch button counts its available nodes), Innate badges, refinements, "Hide completed" toggle (remembered per browser) (C144) | First insight |
| Prestige | Sub-tabs: Flight (checklist, alate rearing, projection, "What increases flight alates" with the current value of every factor, C146; the weather row explains Flight Day inline: a summer event once Nuptial Preparation is researched, ×1.5 alates for 3 min, C232; alate rearing has Cancel queued and the queue price, C232) · Bloodline · Hardships · Supercolony · Federation · Edicts · Speciation · Genome · Species, each revealed per §23 | `f_run ≥ 2e7` or `nuptial_preparation` researched |
| Achievements | Recently earned (last 8, with time of play since), Next Goals ("Name — requirement"), list with every requirement, secret placeholders (C145) | 3 achievements |
| Field Guide | Entries by category | First entry (new game) |
| Stats | Resources over the last 60 s: per resource, where it came from (trails by source type, clicks, events, loot, passive chambers …) and what used it (eggs, upkeep, chambers, Adaptations, research, spoilage, wasted at the cap …) with bars (C191); the Event log button; run and lifetime statistics: largest battle, deepest tunnel, longest trail, fastest flight, per-layer timings | Always |
| Event log (list icon after the Manual; Stats; the Log link on event-outcome toasts) | A modal list, newest first, of notable happenings with their run time: events and how they ended (choice and outcome), raids and battles, conquests, blueprint placements, drops and adjustments, water strikes, achievements, unlocks, Flights and Supercolonies; filter chips by category. The last 200 stay while the game is open; the last 50 are kept per browser (C190) | Always |
| Settings | Save/export/import, number format, reduced motion, sound, `harsh_nature`, Photo Mode, colony and queen names, keyboard and view controls reference, hard reset | Always |
| Manual (book icon after the utility icons; opens a modal, full screen on phones) | Index of ten sections (Getting started, Resources, Ant types & jobs, Chambers & nest, Surface, Combat & rivals, Seasons & events, Research, Prestige, Controls & hotkeys) and a search box. Each entry is built from the live data tables, so its numbers match the game, with the player's current values and links to related entries and tabs. Only unlocked or seen content appears; nothing unrevealed is named (ARCHITECTURE §18 C131) | Always |
| Patch notes (the version label at the foot of the resource rail on wide screens, and Settings → Save; opens a modal) | Every update, newest first, with its date, a short title and player-facing notes grouped under headings such as Nest, Map or Interface; the newest is expanded and older ones collapse. After an update, a returning player sees a small pill in the toast column, "Updated to vX — see what's new", which opens the notes (× dismisses it); a brand-new player is not shown it. The last version seen is remembered per browser, outside the save (ARCHITECTURE §18 C150) | Always |

### 25.4 Canvas interactions
See §7.12 (Below) and §8.10 (Above). Clicking a rival nest, prey or the termite mound opens its war panel; dragging from an entrance onto one of them opens the war-party chooser, so attacks start on the map. Both canvases support hover tooltips, right-click or long-press for context actions, and keyboard shortcuts:
- `1–9`: tabs (Colony, Build, Map, Adaptations, Research, Prestige, Achievements, Field Guide, Stats; Settings has no number key);
- `Space`: hand-forage the selected source;
- `M`: Mark the selected trail;
- `R`: Rally the selected trail; with a chamber selected in the nest, Relocate it;
- `L` / `Shift+L`: level the cheapest chamber of the selected chamber's type / the selected chamber (C142); `Q`: place another chamber of the hovered (or selected) chamber's type; `F` or right-click while placing: flip the corner the new chamber starts in (C137); `G`: pick the growth side of an older chamber without a reservation;
- `Tab`: switch view on medium and narrow layouts;
- `Esc`: cancel a tool, deselect, then close the drawer or lower the panel sheet;
- `H` or `?`: open or close the Manual.

Camera controls on the canvas the player clicked last: wheel (Above: zoom; Below: scroll, Shift + wheel pans), Ctrl + wheel or pinch (zoom the Below view), `+` / `−` (zoom), `0` / `Home` and the crown button (frame the queen), arrows and PgUp / PgDn (pan or scroll), dragging empty ground (pan the map). Settings lists them all under "Keyboard and view controls".

### 25.5 Rendering and sprites (from D)
- **Sprite budgets:** Below 160, Above 260, battles 40 per side, flight ceremony 120. **Hard cap 600.**
- **Allocation** uses the largest-remainder method:
  - Below: by job (diggers at dig faces, nurses in nurseries, haulers between the shaft and storage, tenders at pens);
  - Above: by each trail's share (min 2 per active trail), plus at least 3 scouts at the frontier, plus escorts and garrison.
- Each view shows a **"1 ● = K ants"** label, where `K = ceil(N_view / budget)`.
- Sprites live in preallocated **typed-array pools** (x, y, t, speed, type, state). There is no per-frame allocation and no collision.
- **Movement:**
  - Below: sprites follow a **BFS distance field**, recomputed only when the grid changes (3,200 cells, < 1 ms).
  - Above: sprites move along **Catmull-Rom splines** through hex centres.
- **Carried item colour:** beige seed, amber honeydew, green leaf, black chitin, white pupa.
- Trail line width `1 + log10(workers)` (1–6 px); opacity `S/S_max`.
- **Caching and limits:** soil and terrain are cached on offscreen canvases, and only changed cells are redrawn. DPR is capped at 2. No `shadowBlur`. Particles ≤ 300 (rain, snow, leaves, spoil pellets).

### 25.6 Onboarding rules (from C)
1. **One glow at a time.** Only the next intended action pulses. A newly revealed tab gets a quiet "new" dot and never switches the open panel, so the glow is the only thing that moves.
   - **Opening (0:00):** until the first gameplay panel appears, the panel column holds a small welcome card (title, one line of story, "Click the glowing crumb to gather food." with an arrow toward the map), not a reference tab. After three clicks it shows a "First worker" progress bar with a countdown. Nothing on it pulses, so the crumb is the only glow. On medium and narrow screens, whose panels start closed, the same line sits over the map until the third click.
2. **Ghost-ant demo** after 8 s of hesitation, showing the gesture (a trail drag, a chamber drop). The chamber demo appears only when the Gallery is revealed, housing is full and no Gallery is placed. It carries a label ("Nest full: pick Gallery in the Build tab, then click here") while the Build tab glows, and it disappears once the Gallery is placed (C203).
3. **Diegetic hints:**
   - scent particles drift toward the best unclaimed source;
   - a "house full" pip;
   - a drooping queen when Hungry;
   - discoloured soil over caches;
   - a red shaft during raids.
4. **Tooltips ≤ 12 words** (for example "Gallery: room for 10 more ants"). Numbers appear on hover, and longer text lives in the Field Guide.
5. **Progressive disclosure:** 1 resource at 0:00, growing to about 8 by 45 min, one at a time (§23).
6. **Modals only for irreversible choices**, and toasts are rate-limited.
7. **Advisor pulse:** in the first hour, if nothing useful will be affordable within 120 s, the limiting chamber or resource pulses.
8. **Readable walls:** war panels show win chance and "what would raise it". No wall in run 1 should need more than ~10 min of waiting.
9. **Next Goals tracker:** the 3 nearest achievements with progress bars.
10. **Feature callouts (C204).** The first reveal of a panel or feature shows a one-line "what this is / what to do" card under the HUD (for example "Diggers carry soil up and dig new rooms. Give one ant the Digger job."). Only one shows at a time. A newer reveal replaces it, "Got it" dismisses it, and it fades after 45 s. Each callout is shown once per colony. The copy never names a feature the player has not seen yet.
11. **Nothing opens by itself.** A click on the queen or the Royal Chamber does not open the Build → Inspect panel until Royal Chamber level-ups are revealed, because before that there is nothing to do there. Other chambers still open their inspect view on click (C203). The advisor pulse (rule 7) never points at an unrevealed chamber; it falls back to the Food counter.

### 25.7 Overlays
| Overlay | Shows |
|---|---|
| `climate` | Season microclimate tint per layer, the projected frost line, flood zone |
| `raid_reach` | Red shading within 15 path cells of each entrance |
| `haul` | Path distance to storage, and the current `h` |
| `adjacency` | Link lines and bonuses or penalties |
| `territory` | Owned hexes (by source type), border hexes, rival land (patterned, colour-blind safe) |
| `trail_strength` | Strength heat along trails |
| `danger` | Likely raid targets, antlion/lizard hexes |
| `richness` | `r(d)` and capacity per source |

### 25.8 Pride features (from C)
- **Strata → Colony History** (ARCHITECTURE C130): each completed run keeps a record: its nest silhouette (tunnels and chambers) plus the run number, the layer that ended it (Nuptial Flight, Supercolony or Speciation), species, duration, peak ants, the alates / kinship / genes earned, the date and any Hardship. The last 12 are kept. They are no longer drawn as fossils in the bedrock; **Prestige → Flight → Colony History** opens a gallery with one card per run (a mini drawing of that nest on its soil layers, newest first; Supercolony and Speciation cards framed in amber). Records from before this change show what they have.
- **Photo Mode:** hide the UI and export either view (or both stacked) as a PNG with a stat card via `canvas.toDataURL`. The download requires a click. (STRETCH, cut-list #5.)
- **Names:** the colony and queen can be named. The queen sprite grows with Royal Chamber level.
- **Cosmetics** from achievements: palettes, mound skins and flags, trail colours, a crown, a ladybug pet, a winged cursor. The winged cursor applies across the whole game window, not only the two views; clickable things show a gold pointer version of it, and text fields keep the text cursor (C164).
- **Statistics page** (§25.3).

### 25.9 Sound (ARCHITECTURE C234–C235)
- **Procedural and quiet.** Every sound is synthesised in the browser (short oscillator and noise envelopes, no audio files). Volumes are gentle; the loudest sound peaks well under full scale.
- **What makes a sound.** *Actions:* a soft tick for hand-foraging and other clicks, a two-note chime for purchases, a rising three-note chime for chamber level-ups and research, a dull thud when a chamber is placed, a scrape for digging, a swish for drawing a trail, a low double drum for a war party, a soft buzz for a refused action, and a barely-there tick on a tab switch. *Alerts:* a chime when an event card appears (a falling two-note warning for a harmful event), a two-tone alarm for a raid warning, a rising or falling phrase for a battle won or lost, a sparkle for an achievement, the reveal chime for an unlock, a short flourish for Nuptial Flight, Supercolony, Speciation and the ending, and a glittering arpeggio when the golden beetle (or a pupa gift) appears. *Ambience:* a soft pad at each season change and a low chime when a chamber is finished.
- **Never a machine gun.** At most 8 sounds per second; the same sound is never repeated within 60 ms (longer for most: the click tick 70 ms, the alarm 2 s); spam-clicking past the click cap is silent; automation never makes action sounds.
- **Settings → Sound:** sound effects on/off, volume, and separate Actions / Alerts / Ambience switches, with a Test button. These are remembered per browser, not in the save, and default to on at half volume.
- **Browser rules:** sound starts after the first click or key press (browsers block audio before that), pauses while the tab is hidden, and stays quiet for a moment after the tab returns so the catch-up does not burst. Without Web Audio the game is simply silent.

---

## 26. Number formatting

| Kind | Rule | Examples |
|---|---|---|
| Counts below 1,000 (ants, hexes, levels) | Integer | `847` |
| Resources below 100 | One decimal | `12.4` |
| Resources 100–999 | Integer | `640` |
| ≥ 1,000 | 3 significant digits plus suffix: K, M, B, T, Qa, Qi, Sx, Sp, Oc, No, Dc (to 1e33) | `1.23K`, `45.6M`, `789B`, `1.00Dc` |
| ≥ 1e36 | Scientific, 3 significant digits | `1.23e45` |
| Settings option | `suffix` (default), `scientific` (from 1e3), `engineering` | `12.3e6` |
| Rates | Suffix `/s`. Below 10, two significant decimals. | `0.53/s`, `4.2K/s` |
| Negative | Leading `−` in red | `−3.2/s` |
| Multipliers | `×` prefix; 2 decimals below 10, then suffix rules | `×1.25`, `×4.20M` |
| Percent | Sign plus integer, or 1 decimal below 10% | `+15%`, `+2.5%` |
| Time | `45s`, `4m 05s`, `1h 23m`, `2d 4h` | — |
| Costs above the cap | `MAX` | — |
| Softcapped | Value plus an "sc" badge; the tooltip shows raw → effective | — |
| Invalid | `format()` never prints NaN or Infinity; it prints `—` and reports the error | — |

All formatting lives in `src/ui/format.js`. The core never formats numbers.

---

## 27. Architecture and implementation contract (from D)

> **Superseded in part by `docs/ARCHITECTURE.md`.** That document is the binding code contract. It replaces the file layout of §27.1, the command and event names of §27.2 (for example `clickSource` → `clickForage`; `raid`/`assault`/`hunt` → `launchParty {kind}`; `chooseBoon` is part of `chooseLanding`), the typed-array and `Map` data shapes of §27.2 (state is plain JSON; typed arrays live only in the derived cache), the `test/` folder (now `tests/`) and the tool name `tools/pacing-bot.mjs` (now `tools/simulate.mjs` plus `tools/meta-model.mjs`). §27.2's determinism rule and §27.3's budgets still apply. The listing below is kept for history.

### 27.1 Files
```
index.html  styles.css  serve.mjs            (node:http static server, ~40 lines, default port 8080)
src/main.js                                  boot, fixed-step loop, wiring
src/data/balance.js                          every constant in this document
src/data/content.js                          id → definition tables (chambers, research, castes, jobs, sources,
                                             rivals, events, achievements, traits, federation, genome, species,
                                             landing tags, boons, edicts, field guide)
src/core/   state.js step.js commands.js rng.js math.js (softcap, clamp, costs)
            brood.js population.js jobs.js economy.js bottleneck.js
            nest.js (grid, strata, dig queue, BFS, A*, placement, adjacency, haul, frost)
            hex.js mapgen.js surface.js trails.js territory.js
            combat.js rivals.js raids.js seasons.js events.js research.js adaptations.js
            prestige.js achievements.js fieldguide.js offline.js save.js migrations.js
src/view/   loop.js camera.js nestView.js surfaceView.js seam.js sprites.js agents.js particles.js
            overlays.js battleBubble.js ceremony.js photo.js
src/ui/     hud.js format.js tooltips.js onboarding.js toasts.js modals.js panels/*.js
test/       *.test.js                        (node --test)
tools/      pacing-bot.mjs meta-model.mjs
```

### 27.2 Core contract
- `step(state, dt, commands) → events[]`.
  - It is **DOM-free and deterministic**. No `Date.now()` or `Math.random()` inside the core: wall time is passed in by `main.js`, and randomness comes from `state.rng`.
  - It mutates `state` in place for speed.
- **Commands** (examples): `clickSource`, `helpDig`, `groomBrood`, `placeChamber`, `levelChamber`, `relocateChamber`, `demolishChamber`, `digTunnel`, `backfill`, `reorderQueue`, `setJobs`, `setCasteTargets`, `setEggReserve`, `drawTrail`, `rerouteTrail`, `deleteTrail`, `assignWorkers`, `assignEscorts`, `mark`, `rally`, `frenzy`, `claimHex`, `flagHex`, `raid`, `assault`, `hunt`, `tournament`, `bribe`, `battleAction`, `eventChoice`, `clickBeetle`, `clickPupa`, `scrapeMold`, `bailFlood`, `buyAdaptation`, `buyResearch`, `rearAlate`, `fly`, `chooseLanding`, `chooseBoon`, `buyTrait`, `startHardship`, `supercolony`, `buyFederation`, `placeSatellite`, `speciate`, `buyGenome`, `setAutomation`, `spendDiapause`, `setSetting`.
- **Events** (examples): `cellDug`, `chamberActivated`, `cacheFound`, `eggLaid`, `hatched`, `frostLine`, `raidWarning`, `battleStart`, `battleTick`, `battleEnd`, `raidResult`, `eventSpawned`, `eventResolved`, `unlock`, `achievement`, `seasonChanged`, `softcapHit`, `flightComplete`. The view and UI read `state` plus events and never write `state` directly.
- **Data shapes:**
  - Brood: cohorts.
  - Nest grid: `Uint8Array` (cell type) + `Uint16Array` (chamber index), run-length encoded in saves.
  - Hexes: axial `(q, r)` with a `Map` keyed by `q,r`.
- **Determinism test:** the same seed and the same command stream must produce a deep-equal state.

### 27.3 Performance budgets
| Item | Budget |
|---|---|
| Core tick (10 Hz) | ≤ 1.5 ms |
| Render (both canvases) | ≤ 6 ms per frame |
| Sprites | ≤ 600 `drawImage` calls from a pre-rendered 8-rotation atlas |
| Particles | ≤ 300 |
| DOM panel updates | 4 Hz, changed text nodes only |
| Offline 24 h simulation | ≤ 60 ms (not met yet: about 0.2–0.3 s, see §21.3 and ARCHITECTURE §18 C87) |
| Catch-up of a gap under 60 s | spread over frames, ≤ ~8 ms of ticks per frame (ARCHITECTURE §18 C79) |
| Battle preview (closed form) | ≤ 0.2 ms |
| Memory | ≤ 40 MB |
| Save size | ≤ 60 KB |

Expected size: about 13–15k lines (core ~6k, view ~3k, UI ~2.5k, tests ~2.5k).

---

## 28. Tests and the pacing bot

### 28.1 Unit invariants (`node --test`)
1. Every cost curve is strictly increasing, and costs above 1e280 report MAX.
2. `sc()` is continuous and monotonic at each threshold.
3. `E(N)` matches the §5.2 table, including `E(200) = 111.8`.
4. **A new game hatches its first worker within 15–30 s with zero input.**
5. Prestige thresholds: base `f_run = 1e8` → 10 alates (formula anchor; the Flight gate `f_run = 1.85e8` gives 13); 5,000 → 3 kinship; 1,000 (the Speciation gate) → 20 genes. Worked examples in §13–15 match to ±1.
6. Lanchester: stepped vs closed form within 5% (homogeneous) and 10% (mixed). The preview is deterministic and does not advance `state.rng`.
7. Offline vs online within 2% (1 h, events off, 100% efficiency).
8. Saves: round trip deep-equal; each migration has a fixture; a corrupted checksum is rejected.
9. **Fuzz** (from D): 1e6 random ticks and commands from extreme states produce no NaN or Infinity, and no stored value exceeds 1e295.
10. Hex distance, A\* path costs, and nest BFS/A\* match hand-computed fixtures.
11. Trail yield matches §8.5, and saturation is continuous at `c`.
12. Determinism (§27.2).
13. `prestige_contractive` (§16).
14. Reveal queue: no two reveals within 30 s.
15. The death policy holds: no adult or brood deaths offline; no starvation deaths with `harsh_nature` off.

### 28.2 Pacing bot (`tools/simulate.mjs`, headless, ≥ 1000× speed, full systems; ARCHITECTURE.md §15.4)
- **Policy (matches the Balance Verification bot, plus the active-player habits of the pacing-bot pass):** greedy purchases by value per second of income (research cheapest-first, rushing `nuptial_preparation` once the Prestige tab threshold `f_run ≥ 2e7` is reached, and `polymorphism` at 70% of its cost once a rival nest is sighted); 4 clicks/s for the first 10 min of run 1 and the first 3 min of later runs, then 1/s; clicks event objects away (mold spots, footsteps, ladybugs, flying rival alates, golden aphids); builds both Scent Libraries and levels them before Royal Chamber levels past L5, which it buys only while housing is free, and grows first whenever the lay rate is the binding constraint past L5 (a level, or another Royal Chamber with Polygyny / Queens' Council; C198); builds a Carapace Store when chitin sits at ≥ 90% of its cap and one Carapace Workshop from 20 min into a run (C199); while soil binds, grows granaries only when the next Gallery or Library level costs more than 80% of the food cap; levels the Nuptial Chamber to its max (25 alate cells); keeps every chamber's growth envelope clear of shafts, and falls back to the game's placement advisor when no such spot exists for a Nuptial Chamber or a type's first chamber; keeps chitin for soldier eggs (chitin Adaptations only at ≤ 25% of the stock; below 50 chitin it keeps a trail on a dead insect); assaults first whenever the preview is favourable (AP ≥ 1.35× the engaged defence, or a ≥ 99% victory), otherwise raids at ≥ 1.35×; retires soldiers when berths are full and supermajors are unlocked; default event choices; flies at the alates/min peak, but only once the projection is ≥ 50% of `alates_cycle` and the run is ≥ 8 min old (a pure peak policy degenerates into 3–8-minute runs once Founding Stores and Innate research make the threshold trivial); a trait priority list; merges as soon as the Old Ridge has fallen and projected kinship is ≥ 30% of `kinship_life`.
- **It fails the build if any of these break:**
  - first worker at 15–30 s;
  - no gap > 3 min between unlocks, reveals or event cards in the first 30 min (research and reveals alone give ≤ 3.6 min in the balance simulation; random events fill the rest);
  - no window > 10 min in run 1 without a purchase or unlock;
  - first conquest between 12 and 35 min (bot; humans ~16–25 min);
  - **Flight available between 38 and 60 min** (bot; humans ~45–75 min);
  - ≥ 25 alates projected at 90 min;
  - **first Supercolony between 4.5 and 10 h** (bot; humans ~6–10 h);
  - first Speciation between 24 and 80 h (bot);
  - census 2e16 reached within 6–10 weeks (meta-model);
  - every boss beatable inside its layer window;
  - `prestige_contractive` holds.

### 28.3 Tuning levers (all in `balance.js`)
| Lever | Controls |
|---|---|
| Gallery growth 1.30, housing 10/level | Mid-run population curve |
| Flight gate 1.85e8 (formula anchor 1e8), exponent 0.5, `t_peak` divisor 400; Prestige tab 2e7 | First Flight timing and payoff growth; when the bot starts its Nuptial Preparation rush |
| Scent Library 0.05/s (growth 2.0), research costs, insight per hex (0.75 × ring), scout exponent 0.6 | Research cadence |
| Lineage 0.05 per alate up to 100, then `6√(A/100)` (food only) | Run-2+ speed-up and cycle-1 stability |
| Alates-per-flight softcap 3e4 | Layer-2 stability (kinship blow-up guard) |
| Territory 0.5%/hex (max +100%), Potent Trails growth 3.5 | Mid-run food curve |
| Bloodline cost growths (3.5–5) | Speed of the layer-1 ramp |
| 5,000 alates cycle threshold, kinship exponent 0.35 | Layer-2 timing |
| `kinship_era` 1,000, genes `kinship_era / 50` | Layer-3 timing |
| Unicolonial Sprawl `6 × 1.13^L` (×2 colony_scale per level), Colossal Nests | Twenty Quadrillion timing (6–10 weeks) |
| Rival ladder ×4 per elder tier, boss AP (Old Ridge `1e6 × (1+m)^1.5`, Front `1e8 × 10^s`, Army Ant Column `43,000 × (1+m)^1.5`), Polymorphism cost 300 | Combat relevance; first-conquest timing; layer gates |
| Winter forage 0.3, frost depth 18 | Seasonal tension |
| Event mean 240 s | Activity density |
| Finite-source capacity (harvester stash 20), Golden Pupa chance 0.2% per egg | Size of income spikes, and so of every income-seconds reward taken during one; the golden-bonus share of `f_run` |

---

## 29. Build milestones and cut list

### 29.1 Milestones (from D, adapted)
1. **Vertical slice:**
   - `step`, brood cohorts, food and clicks, Royal Chamber, galleries and nurseries through the dig queue;
   - one trail, HUD, format, save/load;
   - test: first worker within 15–30 s.
2. **Full nest:** strata, every chamber, placement ghost, enlarge, adjacency, haul, soil features, overlays, frost line.
3. **Surface:** map generation, fog and scouting, sources, trails (strength and saturation), territory and claims, Mound, pheromone abilities, the seam.
4. **Progression:** research, Adaptations, bottleneck badge, onboarding and the reveal queue, achievements, Field Guide.
5. **Rivals and combat:** AP, stepped battles with preview, two-view raids, conquest and outposts, hunts, bribe.
6. **Seasons and events** (with pity rules), Golden Beetle and Pupa, Saved Finds.
7. **Layer 1:**
   - Flight and alate rearing, Bloodline, landing sites and boons, Hardships;
   - offline with the welcome-back screen;
   - pacing bot v1.
8. **Layer 2:** Supercolony, Federation, satellites, Edicts, Old Ridge, autobuyers, Auto-Flight.
9. **Layer 3:**
   - Speciation, Genome, 4 species, Argentine Front;
   - the Twenty Quadrillion ending;
   - Strata and Photo Mode polish.

### 29.2 Cut list (apply in order if behind schedule)
1. Species down to 2 (`garden_ant`, `leafcutter`).
2. Ritual Tournaments.
3. Hardships down to 2 (`eternal_winter`, `pacifist`).
4. Diapause bank.
5. Photo Mode.
6. Biomes (already STRETCH).
7. Royal Edicts.
8. Nutrition multiplier (fungus then becomes only a supermajor and Fungal Brood input).
9. Water pockets and the Water Well.

**Never cut:**
- the dig queue;
- the frost line;
- two-view raids;
- trail math (efficiency, richness, saturation, strength);
- all three prestige layers;
- the onboarding rules;
- harmless offline progress;
- save/export/import.

---

## Appendix A: ID namespaces
| Prefix / set | Used for |
|---|---|
| (none) | Resources (`food`, `soil`, …), castes, jobs, chambers, layers, research nodes, Adaptations, Bloodline traits, Federation nodes, Genome nodes, sources, rivals, soil features, abilities |
| `ach_` | Achievements |
| `ev_` | Random events |
| `fg_` | Field Guide entries |
| `site_` | Landing-site tags |
| `boon_` | Founding Boons |
| `edict_` | Royal Edicts |
| `sig_` | Signature genes |
| `bn_` | Bottleneck types |
| `adj_` / `hyg_` / `prox_` | Adjacency rules |
| `species_` | Genome species-unlock nodes (the species ids themselves have no prefix) |

Ids are unique within their set, and no id may appear in two sets except where a prefix separates them. For example, the research node `double_bridge` and the achievement `ach_double_bridge` are distinct.

---

## Balance Verification

### Method
A throwaway, zero-dependency Node.js simulation (`balance-sim.mjs`, kept outside the repo) modelled the economy in this document. The shipped pacing bot (§28.2) must reproduce these numbers.
- **Modelled:**
  - brood cohorts, egg cost, lay rate, nurses, nanitics; housing, slots, berths and caps;
  - every economic chamber, with footprint dig work, a dig queue, instance pricing and layer work; Mound;
  - all Adaptations and the full research tree (economic effects), Refinements and Innate research;
  - Field Guide insight; scouting by ring;
  - trail economics (richness, efficiency, haul, saturation, strength), loose foraging, finite and renewable sources, dead insects, the scripted fallen fruit and golden beetles;
  - territory claims by pheromone, Rally and Frenzy;
  - seasons with the mild year 0, winter forage, upkeep and the Hungry state;
  - honeydew (herders, pens), leaves, fungus and Nutrition; chitin (insects, prey, battles);
  - soldiers and supermajors, the rival ladder with growth, raids and closed-form assaults, conquest rewards and outposts;
  - Nuptial Flight with rearing, Bloodline traits and Lineage; Supercolony with the Old Ridge, kinship, Federation and Edict of Plenty; a rough Speciation with the Argentine Front and Genome.
- **Not modelled:** random events other than the fruit and beetles; rival raids on the player; frost brood death; tournaments; Hardships; offline time (the bot plays continuously). Without random events, unlock gaps are slightly pessimistic.
- **Bot:**
  - Clicks 4/s for the first 10 min of run 1 and the first 3 min of later runs.
  - Buys by value per second of income, keeps an egg reserve only for near targets, and adapts its digger share to the binding resource. Research is cheapest-weighted, and it rushes `nuptial_preparation` once `f_run ≥ 1e7`.
  - Fights when its AP is ≥ 1.35× the defence.
  - Flight, merge and trait choices follow the §28.2 policy.
- **Measurement:** run-1 figures are medians over 9 seeds of an uninterrupted run 1. Meta figures come from 3 seeds over 60 h, with a 200 h check for number size.
- **Humans:** expect 1.2–1.5× the bot's times.

### Milestones (bot), before → after this pass
These are the throwaway simulation's numbers. The shipped bot's current figures are in **Pacing-bot pass** below; where the two differ, the pacing-bot pass wins.

| Milestone | Target (brief / §28.2) | Before (original numbers) | After (current numbers) |
|---|---|---|---|
| First worker | 15–30 s | 0:15 | 0:15 |
| Unlocks in first 30 min (research + reveals) | Something new every 1–3 min; no dead zone > 5 min | 64–66; max gap 1:50–3:23 (median 2:39); front-loaded (16-22-9-12-5-2 per 5 min) | 47–48; max gap 2:11–3:35 (median 3:12); 16-10-7-9-4-2 per 5 min |
| Longest window with no purchase (first 60 min) | ≤ 10 min | ≤ 2:27 | ≤ 2:48 |
| 100 / 500 / 1,000 adults | — | 6:31 / 10:42 / 20:18 | 6:04 / 12:06 / 32:28 |
| Research nodes at 30 / 60 / 90 min | 25–30 in run 1 | 35 / 43 / 49 | 20 / 25 / 30 |
| Insight earned by 30 / 60 min | — | 24,500 / 48,400 | 3,900 / 9,300 |
| First conquest | 18–35 → now 12–35 (bot) | 8:37 | 16:03 |
| `f_run` 1e7 (Prestige tab) | — | 19:52 | 16:13 |
| **Flight available** | 45–75 min (human) | **19:51** | **43:35** (human ~52–65) |
| Projected alates at 45 / 60 / 75 / 90 min | ≥ 25 at 90 | 159 / 312 / 282 / 500 | 21 / 36 / 36 / 47 |
| **≥ 30 alates projected ("clearly worthwhile")** | by ~90 min (human) | 23:47 | **54:00** (human ~65–80) |
| First Flight taken by the bot | — | 21–22 min, 25–27 alates | 40–43 min, 21–23 alates |
| Cycle-1 alates per flight | ×1.4–2, no blow-up | 26, 64, 238, 842, 1,835, 4,201, **169,920, 1.2e6, 5e6** | 23, 20, 29, 36, 54, 81, 182, 213, 651, 645, 967, 1,451, 2,181, 3,780 |
| Lifetime alates 150 / 1,000 / 5,000 | ~2.5–3 h / ~3–4 h / ~4.5–5 h | 1h00 / 1h25 / 1h41 | 1h57–2h19 / 3h48 / 4h32–5h17 |
| Old Ridge conquered | 4–6 h | 16h57–19h44 (1e6 AP wall; the bot sat in 90–170 min runs) | 4h53–5h31 |
| **First Supercolony** | 6–10 h human (5–10 h bot) | **16h57–19h44**, +138–146 kinship | **4h54–5h36**, +4 kinship (human ~6.5–7.5 h) |
| Kinship per merge | Contractive | +138…146, then +380…582 by 25 h | +4, +6…8, … about +50 by 40–47 h; a merge every 1–4 h |
| `kinship_life` at 15 h / 30 h | ~100 / ~450 (old calibration) | 0 / 518–728 | 80–85 / 216–224 |
| **First Speciation** | Days; 24–80 h bot | Not reached in 30 h | **39h13 / 41h54 / 46h49**, +5 genes (human ~50–65 h) |
| **Largest number reached** | < 1e300 | 1.4e23 (`f_run`, 25 h) | 4e21 by 60 h, 7e21 by 200 h (`f_run`) |

**Ceiling check (analytic).** Even if the raw gross food rate hit 1e300/s, the food softcaps would bring it down to ~3e85/s. A 1e5 s run of that gives `f_run` ≈ 1e91, which is under 3e23 alates per flight (softcapped). From there:
- kinship is softcapped to ~3e6;
- genes are ~500;
- egg cost at the 2e16 census is ~8e22.

Every stored value stays far below the 1e295 clamp, and costs MAX at 1e280.

### What changed in this pass, and why
| Item | Old | New | Reason (simulated effect) |
|---|---|---|---|
| Flight threshold `f_run` (§13.1, §13.2) | 1e7 (10 alates at 1e7) | **1e8** (10 alates at 1e8) | Flight was available at ~20 min. Now ~44 min (bot). |
| `t_peak` divisor in alate formula | 200 | **400** | Conquests and claims put `t_peak` at 150–220 in run 1, so the term was ×1.8–2.1. The Flight was worthwhile the moment it unlocked. |
| Prestige tab reveal | `f_run ≥ 1e6` | **`f_run ≥ 1e7`** | Keeps the same "1/10 of the threshold" relationship. |
| Hardship tier goals | 1e8 × 100^(t−1) | **1e9 × 100^(t−1)** | Tier 1 would otherwise equal the Flight threshold. |
| Insight per revealed hex (§8.3, §12.5) | `ring` | **`0.5 × ring`** | Insight was 6× the intended amount (25k by 30 min; 35 nodes at 30 min). |
| Scouting speed (§6.2, §8.3) | 1 scout-second per scout | **`scouts^0.6`** in total | A 5% scout share revealed the radius-8 map in ~15 min. In an ablation it then left a 5–7 min research dead zone at ~19 min. |
| Scent Library insight / level growth (§7.6, §12.5) | 0.12/s, g 1.80 | **0.05/s, g 2.00** | Libraries became the dominant source (L12 by 60 min). Research is now 20 / 25 / 30 nodes at 30 / 60 / 90 min. |
| Territory bonus (§8.6, §12.1) | +1%/hex, max +200% | **+0.5%/hex, max +100%** | Run-1 territory reaches 150–220 hexes. Slows the mid-run food curve (1,000 adults at 25 → 32 min). |
| Potent Trails cost growth (§10) | ×2.8 | **×3.5** | Its food-bought ×1.12/level gave `food^0.11` amplification. Moves Flight availability out by ~8 min. |
| Polymorphism cost (§11.5) | 60 | **300** | First conquest at 8–11 min. Now ~16 min bot (human ~20–24, matching the §24.1 beat). |
| Seed patch stock (§8.4) | Sized once at discovery | **Re-evaluated every tick** from current gross food/s | The ring-2 patch seen at 0:00 was a dead 3 food/s source forever, and winter (flowers 0) crashed food ~50×. |
| Nursery reveal (§23) | 8 adults **or** brood slots full | **8 adults** | The 3 starting slots fill at ~0:08, so the old rule revealed the Nursery at 0:10. |
| Lineage Λ (§13.3) | Linear to 1,000, then `51√(A/1000)` | **Linear to 100, then `6√(A/100)`** | Stability margin, because stacked Bloodline traits push the loop exponent toward 1. With the original numbers, cycle 1 reached 170k → 5M alates per flight. In ablation it trims late merge gains by ~30%, and it cuts the blow-up by ~30–40% if the softcap is removed. The first Supercolony moves by under 30 min either way (5h08–5h10 → 4h54–5h36). |
| Alates-per-flight softcap (§12.10) | 1e9, p 0.5 | **3e4, p 0.5** | In an ablation with every other change applied but no softcap, merge gains escalated (+39 at 8.6 h, +155 and +213 by 19–22 h) and then walled. Now merge gains grow +4 → ~+50 over 45 h. |
| Old Ridge AP (§9.3) | `1e6 × 10^m` | **`3e5 × (1+m)^1.5`** | At 1e6 the first merge came only at 17–20 h (original numbers), or never within 30 h once the layer-1 runaway was fixed. With ×10 per merge, merge 3 was a hard wall. Now there are 19–21 merges in 60 h, so m ≈ 20 is still beatable. |
| Argentine Front AP (§9.3) | `1e9 × 100^s` | **`1e8 × 100^s`** | Berth-filled potential AP is only ~2–4e8 at 30–40 h. Now first Speciation lands at 39–47 h (bot). |
| Gardener slots (§6.2, §7.6, §5.6) | 5 × Σ garden L | **× colony_scale** | Nutrition demand scales with N but slots did not. φ → 0 and no fungus for supermajors above ~1e5 adults. |
| Fungus priority (§6.4) | (unspecified) | **Egg costs are paid before Nutrition** | Supermajors could never be laid in large colonies. |
| Pacing-bot policy and asserts (§28.2) | Peak-only flights; peak merges; Flight 45–75 min; conquest 18–35 min; Supercolony 5–10 h | **Peak and ≥ 50% of the cycle; merge at ≥ 30% of `kinship_life`; bot windows 38–60 min, 12–35 min, 4.5–10 h** | The pure peak policy produced 3–8 min runs. Windows are restated for the bot rather than for humans. |
| Documentation fixes | §24.1 "85–100 ants, 50–150 food/s at 30 min"; §24.3 tables; §16, §14, §15 calibration numbers | Replaced with simulated values | They contradicted the formulas by ~10–1000×. |

### Reconciliation pass (after the balance pass)
DESIGN.md and ARCHITECTURE.md were cross-checked; ARCHITECTURE §18 C31–C47 records the pinned readings. Design-level changes in this pass:
- **Army Ant Column AP** `43,000 × 10^m` → `43,000 × (1 + m)^1.5` (§9.3, §18.2). The old value exceeded 1e300 after ~290 merges. The §9.3 loot now matches §18.2 (max(2,000, 600 s) chitin, not "20,000·r").
- **Retire to workers** added (§6.1), closing open issue 3 below.
- **Prestige tab**: "`nuptial_preparation` visible" → "researched" (§13.1, §23, §25.3).
- **`fg_amber`** added, so the amber bead's Field Guide entry exists (§7.9, §20). There are now 40 entries.
- **Rival territory radius**: §8.6's `1 + ceil(tier/2)` contradicted the §9.2 table for tiers 4–6. The table wins; bosses, including each Argentine Front nest, use 3.
- Readings pinned without changing numbers: Lycaenid `r` = ring; "send soldiers" remedies use the event card (§18.1); `claustral_founding` "no clicking" scope (§13.8); "autumn bonuses off" (§14.6); "caste presets" (§14.5); finite stock sizing "at discovery" (§8.4); outpost auto-claim radius (§8.8); bosses at most once per run (§9.3); research run counts (§11.7); `ach_seed_bank` (§19).
- §28.2's bot policy now matches the simulated bot (4 clicks/s, fights at ≥ 1.35× AP), so the shipped bot reproduces these tables.
- None of these changes alter run-1 or meta pacing: the Army Ant fight is optional, and its default is Evacuate.

### Pacing-bot pass (shipped bot, all systems)
The shipped bot (`tools/simulate.mjs`) replaced the throwaway simulation as the measuring tool. Run 1: `--until flight --strict` (dt 0.1) on seeds 1, 2, 3 and 7, with seeds 4, 5, 6 and 8 as a robustness check. Layer 2: `--hours 12 --dt 1 --until supercolony`. Before = the numbers and bot at the start of this pass.

**What the bot was missing (fixed first; §28.2 policy text updated):**
- It never got soldiers on 2 of 4 seeds. Polymorphism (300) tied with Double Bridge and Clay Masonry and lost the tie, then the Nuptial Preparation rush took the insight, so it came at ~40 min. On other seeds chitin went to Serrated Mandibles and Thick Cuticle, so soldier eggs (1 + 0.02n chitin each) fell back to minors. It already assaulted first when the preview cleared 1.35×; it now also assaults on any ≥ 99% preview.
- It never scraped mold. One Mold Bloom spread to 24 spots and halved most chambers for the rest of the run, so housing fell from ~1,150 to ~700.
- It never levelled the Nuptial Chamber, so it reared 10 alates instead of 25.
- It built one Scent Library and levelled it last, behind Royal Chamber levels that only raise the lay rate of a housing-capped colony. Research reached 15 nodes by 30 min instead of 20.
- Granaries took ~250k soil between 18 and 30 min because food always sat at the cap.
- It placed chambers whose growth envelope crossed a shaft, and the nest never lets a footprint grow into a shaft. Boxed-in granaries capped food at ~7,000, below the 20,000-food Nuptial Chamber. In dense blueprint layouts it then found no spot for a Nuptial Chamber or a first Gallery at all. Either way the bot could neither fly nor merge, and long runs stalled from ~11 h onward. It now uses the game's placement advisor as a fallback for those.

**Run 1, before → after:**
| Seed | First conquest | Flight available | First Flight (alates) | Alates at 90 min | Largest gap, first 30 min | Research at 30 min |
|---|---|---|---|---|---|---|
| 1 | — → 13:40 | 42:49 → 52:37 | 13 → 25 | 24 → 41 | 4:50 → **4:09** | 15 → 20 |
| 2 | 38:46 → 12:48 | 40:05 → 44:31 | 14 → 24 | 44 → 37 | 3:41 → 2:35 | 15 → 21 |
| 3 | — → 13:47 | 39:38 → 41:49 | 13 → 24 | 23 → 48 | 5:42 → **3:01** | 15 → 21 |
| 7 | 36:53 → 12:41 | 39:59 → 55:03 | 14 → 32 | 56 → 39 | 3:31 → 2:41 | 16 → 21 |
| 4 / 5 / 6 / 8 (after) | 14:45 / 12:18 / 14:05 / 12:52 | 51:43 / 56:06 / 53:24 / 55:23 | 23 / 30 / 25 / 29 | 53 / 41 / 41 / 35 | **3:27** / 2:51 / 2:23 / 2:36 | — |

After the pass, every check passes on seeds 2, 5, 6, 7 and 8. Seeds 1, 3 and 4 miss only the gap check. Other run-1 figures (seeds 1, 2, 3, 7):
- 1,000 adults at 14:37–15:28 (was 17:58–18:16).
- Prestige tab at 14:14–19:30.
- Research 20–21 / 27–28 / 35–36 nodes at 30 / 60 / 90 min without flying (was 15–16 / 19–22 / 21–26).
- No window without a purchase longer than 1:41.

**Layer 2, before → after (dt 1):**
| Seed | Old Ridge appears | First Supercolony |
|---|---|---|
| 1 | 5:47 → 4:08 | not reached in 12 h → **6:13**, +6 kinship |
| 2 | 6:14 → 3:48 | 8:38 → **6:01**, +6 |
| 3 | 4:47 → 4:28 | 10:02 → **5:50**, +5 |
| 7 | 6:27 → 4:07 | 8:07 → **6:02**, +5 |

The 12 h runs also print run-1 checks at dt 1. Those are coarser than the dt 0.1 run-1 table above and are not used here.

**Layer 3 (`--hours 80 --dt 1 --until speciation`):**
- Before this pass, seed 1 stalled from 11 h onward at `kinship_life` 84, with no Nuptial Chamber, so it could neither fly nor merge.
- With the bot fixes and the old gate of 200, seeds 1 and 3 speciated at 18:03 and 16:58. The Argentine Front fell at 15–18 h, and `kinship_life` passed 200 at 16–17 h, about twice the pace of the old calibration (80–85 at 15 h).
- With the gate at 400, seeds 1, 2 and 3 speciate at **29:56 / 31:23 / 30:34**, +6 genes each (human ~36–47 h).

**Numbers changed in this pass:**
| Item | Old | New | Reason (measured effect) |
|---|---|---|---|
| Flight gate `f_run` (§13.1) | 1e8 (10 alates) | **1.5e8** (12 alates; formula anchor still 1e8 → 10) | With conquests working, `f_run` reached 1e8 at 25–40 min. Now the Flight is available at 41:49–56:06 on 8 of 8 seeds. |
| Prestige tab `f_run` (§13.1, §23) | 1e7 | **2e7** | The bot starts its Nuptial Preparation rush at this threshold. At 1e7 the 800-insight saving began at ~13 min and left the longest research gap of the run. The tab now appears at ~14–19 min (bot), ~16–20 for a human (§23). |
| Insight per revealed hex (§8.3, §12.5) | `0.5 × ring` | **`0.75 × ring`** | Research reached only 15 nodes by 30 min with every system on (target 20). Scouting ends at ~18 min, so this only feeds the first half of run 1, where Polymorphism and the cheap nodes are bought. |
| Harvester stash capacity (§8.4) | 80 | **20** | At 80 it absorbed every over-saturated forager: gross food ×5–10 for about a minute. A Golden Beetle Windfall taken in that minute (600 s of current gross) alone exceeded 1e8 `f_run`, and flew one seed at 19 min. |
| Speciation gate `kinship_era` (§15.1) | 200 (4 genes) | **400** (6 genes) | The bot breaks the Front at 15–18 h, so kinship was the only gate. At 200 the first Speciation came at 17–18 h (bot window 24–80). At 400 it comes at 30–31 h, inside §24.4's 4–9 genes. |
| Golden Pupa chance (§18.3) | 1% per egg | **0.2% per egg** (still at most 1 per 3 min) | A laying colony met the 3-min cap: 5–9 Windfalls (600 s of income each) by 45 min, or 24–41% of `f_run`. With Golden Beetles, golden bonuses were 41–55% of `f_run`, against a §18.4 budget of about +10% for events and golden bonuses together. Now pupae give 4–14%, and the spread of Flight times across seeds narrowed from 20 min or more to ~14 min. |

**Remaining misses and why:**
1. **Gap check (§28.2): it fails on seeds 1, 3 and 4 (4:09, 3:01, 3:27).** Which seeds pass is a coin flip: each balance or bot change in this pass reshuffled them. Research and reveals alone leave 3–4 min gaps between 18 and 30 min, for two reasons:
   - The 800-insight Nuptial Preparation saving.
   - From ~22 min, 400–500 insight nodes against ~2 insight/s, once scouting ends and winter's ×1.5 lapses at 24:00.

   Poisson events at 240 s split such a gap only ~40–55% of the time per seed. Data cannot fix this without breaking pinned numbers: research costs, the library rate and the 30 s reveal spacing are pinned by tests, and the event mean must stay within 200–285 s (`world.events.test`).

   **Proposed rule (code, events owner):** in run 1, the next event is due at most 150 s after the previous one. In a sandbox with these numbers it gave ≤ 2:30 on 8 of 8 seeds, and seeds 1, 2, 3, 5 and 8 passed every check. Positive events add `f_run`, so the Flight then came at 35:37–37:32 on seeds 4, 6 and 7. If the rule is adopted, the gate should move to ~1.7–2e8.
2. **Flight timing still depends on luck.** At the gate, a third to a half of `f_run` still comes from one-shot income-seconds rewards: Golden Beetle Windfall 600 s, conquest 120 s × √tier, Devour 120 s, stashes. Each is measured on the *instantaneous* gross food, which finite sources make spike, and `f_run` counts the full reward even when most of it overflows the cap (C1). One beetle click can move the Flight by 10+ min. **Proposed (code):** measure income-seconds rewards on a smoothed gross (e.g. a 60 s average), or count only the food actually added.
3. **Census 2e16 in 6 weeks (`meta.contractive` todo): not reachable with data changes inside §9.3 and §16.** The meta-model reaches 2 Speciations and a census of 4.5e8 in 52 weeks. The Front AP (`1e8 × 100^s`, pinned by `war.combat.test`) outgrows player AP, and each Speciation pays ~10–20 genes. A census of 2e16 needs colony_scale ≈ 7e10, which is ~16 more `unicolonial_sprawl` levels (~2e8 genes at 5 × 3^L). Any price that makes this reachable in 6 weeks gives that node an implied exponent above 1, which breaks §16 rule 5. This needs a design decision: for example, Front growth ×10 per Speciation, a gene formula that scales with the era, or a census source beyond colony_scale.

*Resolved since:* item 1 by the run-1 event gap rule (ARCHITECTURE C75), item 2 by smoothed income for income-seconds rewards (C76), item 3 in the re-tune pass below.

### Re-tune pass (after the bug-hunt fixes)
The bug-hunt round changed rules that move pacing: the run-1 event gap (≤ 150 s, ARCHITECTURE C75), income-seconds rewards on a 60 s average (C76), laying that is no longer capped by the tick length or blocked by an unaffordable slider caste (C70, C71), and Mobilize returning its militia (C73). Same method as the pacing-bot pass: `--until flight --strict` at dt 0.1 on seeds 1, 2, 3 and 7 (4, 5, 6 and 8 for robustness), `--hours 12 --dt 1 --until supercolony`, `--hours 80 --dt 1 --until speciation`, and `tools/meta-model.mjs`. Before = the numbers at the start of this pass with the fixers' code.

**Run 1, before → after (dt 0.1).** The event gap rule did not pull the Flight earlier as predicted: smoothed income took the spikes out of windfalls and conquest food at the same time. Raising the gate to 1.7–2e8 would have pushed seeds 2 and 8 past 60 min, so it went down to 1.4e8 instead, which centres the spread in the 38–60 min window.
| Seed | First conquest | Flight available | First Flight (alates) | Alates at 90 min | Largest gap, first 30 min |
|---|---|---|---|---|---|
| 1 | 14:01 | 41:37 → 41:37 | 27 → 27 | 54 → 54 | 2:30 |
| 2 | 12:32 | 54:13 → 51:56 | 31 → 24 | 42 → 42 | 2:30 |
| 3 | 12:35 | 51:08 → 45:26 | 24 → 24 | 52 → 48 | 2:30 |
| 7 | 13:30 | 48:09 → 45:47 | 25 → 24 | 58 → 49 | 2:30 |
| 4 / 5 / 6 / 8 | 14:11 / 12:26 / 13:00 / 12:55 | 51:04 → 48:31 / 47:40 → 43:49 / 51:24 → 48:36 / 59:48 → 55:18 | 23 / 23 / 23 / 30 | 47 / 46 / 47 / 41 | 2:30 / 1:40 / 2:09 / 2:29 |

Every check passes on all 8 seeds, before and after. Seed 1's `f_run` crosses both gates in the same step (a one-shot reward), so its time does not move.

**Layer 2, before → after (dt 1).** The F23 laying fix made later runs much stronger: the bot beat the Old Ridge 12–53 min after it appeared and merged at 4:32–4:52, only 2–22 min inside the window. At `1e6 × (1+m)^1.5` the Old Ridge is the last gate again. A raise to 6e5 gave 4:54–5:45, and moving its appearance to 4,000 alates as well gave 4:56–5:42. Raising its growth exponent to 2 or 2.5 moved the first Speciation by only +0.5–1.5 h.
| Seed | Old Ridge appears | Old Ridge falls | First Supercolony (kinship) |
|---|---|---|---|
| 1 | 3:59 → 4:08 | 4:52 → 5:59 | 4:52 (5) → **5:59 (9)** |
| 2 | 3:43 → 3:43 | 4:10 → 5:46 | 4:32 (4) → **5:46 (9)** |
| 3 | 4:00 → 3:53 | 4:44 → 5:39 | 4:44 (5) → **5:39 (9)** |
| 7 | 3:47 → 3:54 | 3:59 → 5:28 | 4:51 (6) → **5:28 (8)** |

**Layer 3, before → after (dt 1, 80 h).** Layer 2 now runs about 2.5× faster than in the pacing-bot pass: merges come every 30–80 min, and `kinship_era` reaches 468 by 14 h (it was ~200 at 16–17 h). With the gate at 400 the bot speciated at 12:12–13:06, far below the 24 h floor (13:53–14:23 with the Old Ridge change). The Front is not the binding gate: the bot breaks it at 10–12 h. Kinship growth slows sharply around 800–1,000, where a merge needs ~30% of `kinship_era` and late runs press against the food softcap (1e24), so a gate there is robust across seeds. Gates of 600 / 800 / 1,000 gave 16:26–17:54 / 22:30–23:47 / 34:08–36:05.
| Seed | Argentine Front appears | First Speciation (genes) |
|---|---|---|
| 1 | 7:57 → 8:40 | 12:12 (6) → **34:50 (21)** |
| 2 | 8:06 → 8:28 | 13:06 (6) → **33:01 (21)** |
| 3 | 7:50 → 8:12 | 12:26 (6) → stopped by a tick error at 15:54 (a raid from a conquered rival, reported as a code bug; not a balance issue) |
| 7 | not run → 8:21 | not run → **36:49 (23)** |

The first Speciation now pays ~20 genes instead of 6, because the gate moved up and the gene formula became linear (below). The alternative was lowering the kinship exponent to 0.30, which keeps 5,000 → 3. With it the bot speciated at 27:49–40:31, but the time jumped by a full merge (14 h) depending on whether `kinship_era` landed just above or just below 400, and the meta-model's layer 2 slowed six-fold.

**Twenty Quadrillion (meta-model).** Before: 2 Speciations (at 0.54 and 3.97 weeks) and a peak census of 4.5e8 in 52 weeks. Each of three numbers blocked the ending on its own; with the other changes in place, keeping just one of them old gives:
- the √ gene formula: census 6e12 in 52 weeks;
- the `5 × 3^L` Sprawl price: census 1.7e13 in 52 weeks;
- the Front's ×100 per Speciation: the ending at 27.6 weeks, after a 23-week wall.

After: census 2e16 at **8.05 weeks**, with `genes_life` 779 and a peak of 2.7e16. It takes 11 Speciations, at 2.00, 2.50, 2.79, 3.06, 3.38, 3.84, 4.45, 5.08, 5.74, 6.82 and 8.02 weeks. `prestige_contractive` still passes, with layer-3 ratios of 1.21 / 1.54 / 1.49.
- The model now feeds the colony_scale bought in the Federation and Genome into `f_run`, and its layer-3 check spends `genes_life` on the Genome. Before, the stability check could not see the census engine.
- It buys Genome nodes cheapest-first, with Colossal Nests and Unicolonial Sprawl counted at 25% of their cost (`MODEL.scaleWeight`; at 100% the ending is 9.3 weeks). Costs are rounded up, as in the game.
- Robustness: halving or doubling `adultsPerScale`, ±5 min run length, `specFrac` 0.2–0.5, `fRunBase` 1.0–1.6 and Front growth ×4–×10 all land in **6.4–10.7 weeks**. `mergeFrac` 0.2 / 0.5 gives 4.5 / 13.6 weeks.
- **Calibration gap (open):** the model's layer 2 is about 7× slower than the shipped bot's.
  - The model has `kinship_life` 49 at 15 h and its first Speciation at 337 h; the bot reaches ~470 by 14 h and speciates at 33–37 h.
  - The model keeps its 25-min runs, while the bot's later runs last 8–9 min. With 9-min runs the model reaches the ending in 2.9 weeks.
  - Late in a cycle the bot's `f_run` reaches the food softcap (1e24), which the model does not represent.
  - So the model's weeks are a planning estimate, not a bot measurement. The bot cannot yet run past the first Speciation.

**Numbers changed in this pass:**
| Item | Old | New | Reason (measured effect) |
|---|---|---|---|
| Flight gate `f_run` (§13.1) | 1.5e8 (12 alates) | **1.4e8** (11 alates) | Flight at 41:37–55:18 on 8 seeds (was 41:37–59:48, with seed 8 only 12 s inside the window). |
| Old Ridge AP base (§9.3) | `3e5 × (1+m)^1.5` | **`1e6 × (1+m)^1.5`** | First Supercolony 5:28–5:59 (was 4:32–4:52). |
| Speciation gate `kinship_era` (§15.1) | 400 (6 genes) | **1,000** (20 genes) | First Speciation 33:01–36:49 (was 12:12–13:06). |
| Gene formula (§15.2) | `3 × √(kinship_era / 100)` | **`kinship_era / 50`** | With √, later eras paid 10–30 genes and grew quadratically longer, and the ending was unreachable. |
| Argentine Front growth (§9.3) | ×100 per Speciation | **×10** | ×100 walls the 5th Speciation for ~23 weeks in the model. At ×10 the player's AP stays 10–230× above the Front. |
| Unicolonial Sprawl cost (§15.5) | `5 × 3^L` | **`6 × 1.13^L`** | Census 2e16 at 8.05 weeks (6.4–10.7 across the robustness set). Base 6 keeps the rounded-up costs strictly increasing. |
| Ending test (§15.7, §28.2) | census 2e16 within 6 weeks (`todo`) | **within 6–10 weeks**, asserted | The lead's target for this pass. `meta.contractive` now runs it as a normal test. |

Tests were updated only where they pin these numbers:
- `meta.contractive`: the thresholds now give 20 genes, and the census test has no todo and asserts 6–10 weeks.
- `meta.formulas`: the gene table.
- `meta.layers` and `meta.derive`: the Speciation fixtures use `SPEC.kinshipMin`, and a Speciation pays 20 genes.
- `meta.traits`: the Sprawl cost.
- `war.combat`: Old Ridge `1e6 × (1+m)^1.5`, Front `1e8 × 10^s`.

### Player-report pass: chamber space and growth (ARCHITECTURE §18 C97)
Players asked for "granary and gallery space a little easier" and reported chambers that "expand in 2 directions at once". The footprint now grows one row or column per level (§7.4), which also makes growth cheaper to dig.

| Item | Old | New | Reason (measured effect) |
|---|---|---|---|
| Footprint growth (§7.4) | width every level, height at L4 / L7 too (3×2 → 10×4 at L8) | **one row (L4, L7) or one column per level** (3×2 → 8×4) | The two-axis levels grew an L-shape round a corner. Alone this moved the Flight ~3.5 min earlier (8-seed mean 45.5 → 41.9 min). |
| Gallery housing per level (§7.6) | 10 | **11** | +10%. 12 (+20%) pulled seed 1 to 30 min even with the gate at 2e8: housing is the main growth limit. |
| Granary capacity at L1 (§7.6) | 300 | **400** | +33%, nearly free for pacing on its own. |
| Flight gate `f_run` (§13.1) | 1.4e8 (11 alates) | **1.7e8** (13 alates) | Compensation. Flight available, seeds 1–8 (dt 0.1): before 38:02, 50:21, 37:43, 56:15, 41:21, 50:00, 47:08, 42:58 (mean 45.5); after 38:59, 51:49, 42:07, 38:21, 46:27, 35:51, 52:07, 50:28 (mean 44.5). The strict seeds 1 and 2 stay inside 38–60 min. |

### Feedback pass 6: queens, chitin storage and the Archive (ARCHITECTURE §18 C198–C200)
Player-approved economy changes. Before = the committed v0.10.0 tree (HEAD); after = this pass together with the other feedback-pass-6 packages (automation in the Federation C166, merging-run alates in kinship C168, Carapace chambers C179, map / combat changes), so the run-1 and layer-2 columns also move with their work. Same bot commands as the re-tune pass.

**Why.** On a late save (`test-saves/4-ready-to-speciate`) the lay rate was ~1e8 eggs/s: colony_scale (×807) multiplied it, and M_lay was ~9.6e3, while Royal Chamber levels gave only ×7. The queen never bound; the badge showed housing or brood slots. Chitin had no cap (2.6e7 stored), and insight had no late sink except the run-scope refinements.

**Numbers changed:**
| Item | Old | New | Reason |
|---|---|---|---|
| Lay rate (§5.1, §12.4) | `× colony_scale` | **no colony_scale** | Player decision: the queen should be a recurring late bottleneck. |
| Royal Chamber lay per level (§5.1) | ×1.15 every level | **×1.15 to L8, ×1.25 per level above** | Royal levels become the main late lever. L8 = the full-size room (C155); run 1 (≤ L5–7) is unchanged. At highFrom 5 seed 1 flew at 34:08 (below the 38-min floor). |
| Extra queens (§5.1) | own term only | own term **× court `1 + 0.25 × (queens − 1)`** | Polygyny / Queens' Council: three equal queens lay 4.5× one. |
| Queen's Feast (§10) | lay ×1.25 / level | **×1.10 / level** | It was ×22.7 at L14 on the late save, more than the Royal Chamber; at 1.10 Royal levels lead. Over seeds 1–8 the Flight came at 38:36–51:43 (all in window) with 1.10, but 34:19–49:26 (3 seeds early) with 1.25. |
| Chitin cap (§12.8, §4.1) | none | **`(500 + Σ Carapace Store capacity) × colony_scale`**, one-shots to 2× cap, excess decays 1%/min | Player decision; colony scale because soldier egg chitin scales with berths. |
| Carapace Workshop (§12.7) | — | chitin from every source × (1 + Σ boost) | Player decision (numbers in the chamber table, C179). |
| Chitin reserve max (§5.5) | 10,000 | **min(10,000, chitin cap)** | A reserve above the cap could never be met. |
| Archive (§11.7) | — | **25,000 × 1.6^L insight, +1% main output per level, era scope** | Player decision: a permanent insight sink, so Scent Libraries stay useful. |

**Run 1 (`--until flight --strict`, dt 0.1), before → after:**
| Seed | First conquest | Flight available | First Flight (alates) | Alates at 90 min | Largest gap, first 30 min |
|---|---|---|---|---|---|
| 1 | 13:17 → 12:34 | 42:04 → 40:33 | 26 → 25 | 108 → 80 | 2:26 → 2:30 |
| 2 | 12:41 → 12:49 | 42:43 → 39:04 | 26 → 26 | 77 → 77 | 2:30 → 2:27 |
| 3 | 13:17 → **11:50** | 40:18 → 45:44 | 26 → 26 | 101 → 78 | 2:05 → 2:30 |
| 7 | 13:15 → 13:01 | 39:15 → 40:12 | 25 → 25 | 99 → 89 | 2:30 → 2:30 |
| 4 / 5 / 6 / 8 (after, earlier snapshot of the tree) | 12:21 / 12:46 / 12:26 / 12:50 | 40:42 / 43:07 / 38:36 / 51:43 | — | — | — |

Seed 3 misses the conquest floor by 10 s. With every other package's changes and this pass's numbers reverted it lands at 12:01, so the conquest sits on the 12-min edge independently of this pass; small lay changes move it either way (Queen's Feast ×1.12: 12:03, but the Flight at 35:36).

**Layer 2 (`--hours 12 --dt 1 --until supercolony`):** seed 1: 4:57:15 (+6 kinship) → **4:59:03 (+10)**; seed 2: 4:09:24 (+5, below the 4.5 h floor) → **4:55:15 (+10)**. The larger first merge is C168 (the merging run's projected alates count). Seed 2's dt-1 run-1 Flight check fails both before (35:31) and after (30:47); per the pacing-bot pass, dt-1 run-1 checks are not used.

**Layer 3 (`--hours 80 --dt 1 --until speciation`, seed 1):** before: Front broken at 9:25:45, first Speciation 50:17:56, +22 genes; after: Front broken at 9:04:39, **first Speciation 44:57:08, +23 genes**, every check passes.

**Late-game badge (`test-saves/4-ready-to-speciate`, 120 s from the saved state, dt 0.1, share of time per `run.bottleneck.id`):**
| Driver | Before | After |
|---|---|---|
| Bot (prestige moves disabled) | housing 44.9%, brood slots 43.4%, none 7.9%, food cap 3.6%, food 0.3%, **lay rate 0%** | **lay rate 51.9%**, brood slots 25.1%, food cap 16.0%, none 5.7%, food 1.3% |
| Save's own automation only | housing 94.5%, brood slots 4.0%, none 1.6%, **lay rate 0%** | housing 77.2%, food cap 12.7%, **lay rate 10.1%**, food 0.2% |

The lay rate starts the window at 3.6e4 eggs/s (it was 9.6e7) and the bot lifts the Royal Chamber from L15 to L20 inside the 120 s (2.0e5 eggs/s), so it binds while the queen catches up, then brood slots and the food cap (the next Royal level's price) take over. Each new run starts the queen at L1 again, so this recurs every run.

**Stability (§16).** The lay change removes a colony_scale factor from a stat whose f_run elasticity is small, so it only lowers loop exponents; the meta-model is unchanged (`eLay` 0.25; at 0.4 `prestige_contractive` still passes with a largest exponent of 0.615 and the ending at 6.2 weeks). The Archive is linear in its level against a ×1.6 geometric cost in insight, which is not a prestige currency and is softcapped, and it resets each era: a bounded constant factor, not a loop. `prestige_contractive` passes (largest exponent 0.617, layer 3); the ending is at 7.32 weeks. Stored values: the Archive cost reports MAX past 1e280 (L ≈ 1,350); the chitin cap ≤ (500 + stores) × colony_scale, clamped at 1e295 like every stat.

### Feedback pass 7, map and combat (ARCHITECTURE §18 C220–C228, C236–C238)

Measured with the pacing bot on the last commit plus only this pass's map and combat files (other passes' work in progress excluded), before → after:

| Run | First conquest | Flight available | Alates at 90 min (shadow) | First Supercolony |
|---|---|---|---|---|
| seed 1, dt 0.1 | 12:34 → 12:52 | 40:08 → 48:31 | 115 → 82 | — |
| seed 2, dt 0.1 | 12:49 → 12:22 | 39:04 → 39:47 | 89 → 71 | — |
| seed 1, dt 1, 12 h | 12:57 → 13:00 | 40:22 → 44:43 | 78 → 78 | 4:31 → 5:18 |

Every check still passes. The difference is almost all the Mound (C220): the old bot bought levels at twice their soil cost, reaching L9 at ~42 min and L10 (auto radius 3) at ~62 min; the growing Mound reaches L5 sooner (≈ 10 min) but L9 only at ≈ 80 min and L10 not in run 1, so mid-run trail slots and the wider home radius (and the t_peak it adds) come later. Excluding trail-held hexes from t_peak (C222) changes nothing for the bot, which holds no trail-only land in run 1; for a player with Trunk Trails it removes up to a few dozen hexes from t_peak (≈ +5–10 % alates when they were counted). Tournament prizes and defence chitin are small (tens to hundreds of insight / chitin) and the bot does not use tournaments.

### Open issues for the shipped pacing bot
1. **Flight availability is bimodal.** It lands either before the first hard winter (42–48 min, forage ×0.3) or just after it, depending on the seed. With the shipped bot it is 41–45 or 51–56 min (Pacing-bot pass).
2. **Later cycles start with fast runs.** The first runs of cycle 2+ are 8–12 min speed runs before settling at 20–60 min. That is acceptable with Auto-Flight, but a human may prefer a minimum run length.
3. **Military logistics limit late merges.** Supermajors are capped by fungus and by berths full of soldiers. The simulation's bot "retired" soldiers to minors. **Resolved in the reconciliation pass:** the design now has **Retire to workers** (§6.1). With `(1+m)^1.5` scaling the Old Ridge stayed beatable through m ≈ 20 (60 h). The second Argentine Front (then 1e10; 1e9 since the re-tune pass) was not reached within 200 h, so Genome pacing and Twenty Quadrillion remain unverified.
4. **Untested here:** the active/idle ratio (§18.4) and offline efficiency. Random events are on in the shipped bot (Pacing-bot pass).

*End of document.*

### Feedback pass 7: explanations and search (ARCHITECTURE §18 C207–C211)
Rules restated for players, each checked against the code (no numbers changed):
- **Raid vs assault (§9.4):** a raid fights 40 % of the defenders with no home bonus and loots food (30 s of income × √tier) and kill chitin; the nest survives. An assault fights every defender at home (×1.25, less with supermajors) and a win conquers the nest: its land, an outpost and the spoils. The war-party form says this under the action buttons; won battles name the loot carried home (the glints after a battle are only the visual).
- **Trails (§8.5):** per-worker yield = richness (1 + 0.35 × (length − 1)) × distance efficiency (1 ÷ (1 + (length − 1) ÷ navigation)) × strength (1 + S ÷ 100) × other factors. At the base navigation of 3 richness and efficiency roughly cancel, so long trails only pay more per worker once navigation rises (Tandem Running +1, Long Legs +0.25 a level, …). Length counts ground costs plus the haul to storage for main-entrance trails. Strength tends to 100 × w ÷ (w + 15 × length), so long trails need more workers to stay strong. Free workers go a batch at a time to the best marginal yield, unsaturated trails first, chitin trails first while chitin is short; pinned workers stay put.
- **Territory (§8.6):** +0.5 % forager output per owned hex (up to +100 %, in the same additive group as Strong Mandibles — not other surface yields), owned sources ×1.25, fully-owned trails cannot be raided, peak territory +0.25 % Flight alates per hex, and border hexes make a crossing trail twice as likely to be the trail-raid target.
- **Bonus stacking:** "+X %" bonuses add within their group, then "×Y" multiply the total (Manual: "How bonuses stack").
- **Flight Day:** a rare summer event (needs Nuptial Preparation): 3 minutes of Flight weather ×1.5 instead of summer's ×1.25.
- **Honeydew cap:** 50 + 10 % of the food cap; honeydew is not stored in Granaries but Granaries raise its cap.
- **Frost exposure (§17):** a chamber is exposed when more than half of its rows are above the frost line. **Barracks:** "within 12 path cells" is the walk through tunnels to the nearest entrance shaft (the inspect panel shows it); "home AP" is Army Power when defending the nest.
- **Search:** the Research tab searches names and effects across branches; Manual search ranks title > heading > body and whole words > prefixes > substrings, boosts entries about things you have now, and highlights the words.

### Feedback pass 7: Flight gate re-centre
With the Mound growing on its own and the new reveal pacing, seed 7 reached the Flight gate at 37:21 (below the 38-min floor). `FLIGHT.fRunMin` 1.7e8 → **1.85e8** (still 13 alates at the gate). Flight available, seeds 1–8 (dt 0.1, `--strict`): 40:21, 48:15, 51:27, 50:55, 50:11, 50:30, 39:28, 52:15 — all checks pass on every seed. First Supercolony (seed 1, 12 h, dt 1): 4:59 with 9 kinship.
