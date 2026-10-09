#!/usr/bin/env node
// Headless pacing bot (ARCHITECTURE §15.4, DESIGN §28.2): plays the real game through game.actions and the systems'
// [q] queries only, records a milestone table and checks the DESIGN §28.2 bot-time windows. Owner: WP7.
// Usage: node tools/simulate.mjs [--hours 2] [--seed 1] [--dt 0.1] [--until flight|supercolony|speciation] [--strict]
//                                [--json] [--quiet] [--no-shadow]
// --strict exits 1 if any check fails. The "alates projected at 90 min" check needs an uninterrupted run 1; when the
// bot flies earlier, a shadow copy of the game (export → import) keeps playing run 1 without flying until 90:00
// (disable with --no-shadow).

import { pathToFileURL } from 'node:url';
import { createGame } from '../src/core/game.js';
import { adultsTotal, broodTotal } from '../src/core/state.js';
import { canAfford } from '../src/core/wallet.js';
import { neighbors, countInRadius } from '../src/core/hex.js';
import { GRID } from '../src/data/balance.js';
import * as nest from '../src/systems/nest.js';
import * as nestgeom from '../src/systems/nestgeom.js';
import * as trails from '../src/systems/trails.js';
import * as surface from '../src/systems/surface.js';
import * as research from '../src/systems/research.js';
import * as adaptations from '../src/systems/adaptations.js';
import * as rivals from '../src/systems/rivals.js';
import * as jobs from '../src/systems/jobs.js';
import * as traitsSys from '../src/systems/traits.js';
import * as unlocks from '../src/systems/unlocks.js';
import { UNLOCKS } from '../src/data/unlocks.js';
import { RESEARCH, RESEARCH_ORDER, BRANCH_ORDER } from '../src/data/research.js';
import { ADAPTATION_ORDER } from '../src/data/adaptations.js';
import { CHAMBERS } from '../src/data/chambers.js';
import { GEOM } from '../src/data/strata.js';
import { EVENTS } from '../src/data/events.js';
import { FLIGHT } from '../src/data/prestige.js';
import { TRAITS } from '../src/data/bloodline.js';
import { FED_ORDER } from '../src/data/federation.js';
import { GENOME_ORDER, SPECIES, SPECIES_ORDER } from '../src/data/genome.js';

// ------------------------------------------------------------------------------------------------------------------
// Bot policy constants (DESIGN §28.2 and Balance Verification "Bot")
// ------------------------------------------------------------------------------------------------------------------

const POLICY = Object.freeze({
  thinkSec: 1,                         // decisions once per simulated second
  clickFast: 4, clickSlow: 1,          // clicks/s
  clickFastRun1Sec: 600, clickFastLaterSec: 180,
  rushWeight: 0.25,                    // rush nuptial_preparation once f_run ≥ FLIGHT.tabFRun (the Prestige tab appears) by weighting
                                       // its prerequisite chain at 25 % of its cost (cheapest-weighted)
  warWeight: 0.7,                      // once a rival nest is sighted, polymorphism counts at 70 % of its cost (DESIGN §24.1 beat)
  fightRatio: 1.35,                    // fight when youAP ≥ 1.35 × foeAP …
  assaultWin: 0.99,                    // … and assault whenever the preview shows a ≥ 99 % victory (fortune ±10 %: AP ≥ ~1.22×)
  clicksPerThink: 3,                   // event objects clicked away per decision (mold spots, ladybugs, footsteps, alates, aphids)
  flyMinRunSec: 480,                   // fly only after 8 min …
  flyCycleFrac: 0.5,                   // … and once the projection is ≥ 50 % of alates_cycle
  flyMaxRunSec: 3 * 3600,              // safety valve: fly anyway after 3 h in one run
  mergeFrac: 0.3,                      // merge at projected kinship ≥ 30 % of kinship_life
  edict: 'edict_of_plenty',
  jobRatio: { forager: 0.6, digger: 0.2, nurse: 0.1, scout: 0.1 },
  diggerRatioSoil: 0.3,                // digger share when soil is the binding resource
  housingMargin: 0.15,                 // build housing when free housing < 15 %
  slotFill: 0.9,                       // build brood slots when brood ≥ 90 % of slots
  storageFill: 0.9,                    // build storage when food ≥ 90 % of the cap …
  capNeedFrac: 0.8,                    // … (soil-bound: only if the next Gallery / Library level costs > 80 % of the cap)
  adaptIncomeSec: 30,                  // buy an Adaptation when it costs ≤ 30 s of food income …
  adaptFoodFrac: 0.5,                  // … or ≤ 50 % of stored food
  adaptChitinFrac: 0.25,               // chitin-costing Adaptations only when they cost ≤ 25 % of stored chitin (soldier eggs need it)
  chitinReserve: 50,                   // with soldiers unlocked and less chitin than this, keep a trail on a dead insect
  workshopSec: 1200,                   // C199: place the Carapace Workshop from 20 min into a run
  maxQueue: 4,                         // do not queue new chambers past this many dig jobs
  libraries: 2,                        // Scent Libraries to place (DESIGN §7.6 max instances)
  // C151 caste target counts: soldiers / supermajors per minor adult (≈ the old 15 % / 5 % egg shares)
  soldierPerMinor: 0.15 / 0.8, supermajorPerMinor: 0.05 / 0.8,
  traitPriority: ['founding_stores', 'nanitic_vigor', 'automaton_instincts', 'remembered_paths', 'keen_antennae', 'ancestral_memory',
    'hardy_workers', 'deep_diggers', 'fertile_queen', 'royal_court', 'wide_wings', 'vast_galleries', 'long_memory', 'swarm_instinct',
    'warrior_lineage', 'seasonal_wisdom', 'sweet_inheritance', 'ancestral_blueprint', 'brood_bank', 'polygyny', 'budding'],
  buddingSaveAt: 1500,                 // save alates for budding once alates_cycle ≥ this
  royalTargetLevel: FLIGHT.royalLevel,  // the flight requirement
  savingFrac: 0.2,                     // while saving for the Royal Chamber, Adaptations may use only 20 % of the usual budget
});

/** Float tolerance for simulated-time comparisons (0.1 s steps accumulate drift). */
const EPS = 1e-6;

/** Chamber growth envelope level (DESIGN §7.4: footprints grow until L8), placement scan tries, preferred rows. */
const GROW_L = (GEOM && GEOM.footprintMaxL) || 8;
const PLACE_TRIES = 30;
const PLACE_ROW = Object.freeze({ default: 8, granary: 4, scent_library: 26, barracks: 6, war_hall: 34, midden: 30, nuptial_chamber: 12 });

const PURCHASE_TYPES = new Set(['buyAdaptation', 'buyResearch', 'buyRefinement', 'placeChamber', 'levelChamber',
  'claimHex', 'buyTrait', 'buyFederation', 'buyGenome']);
const PURCHASE_EVENTS = new Set(['adaptationBought', 'researchBought', 'refinementBought', 'chamberLeveled', 'moundLeveled', 'claimDone']);

// ------------------------------------------------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------------------------------------------------

/** Call a query; null on exception (another package may still be a stub or half-built). */
function q(fn, ...args) {
  try {
    return fn(...args);
  } catch {
    return null;
  }
}

/**
 * The unlock keys a player can see right now ({ key: true }): unlocked AND revealed (unlocks.isRevealed). The bot acts
 * only on revealed features, like a player whose UI hides unrevealed tabs and controls (integration fix: acting on
 * gameplay availability let it buy research at 0:00 and reshuffle the reveal queue).
 */
export function revealedKeys(s) {
  const out = Object.create(null);
  for (const def of UNLOCKS) if (unlocks.isRevealed(s, def.key)) out[def.key] = true;
  return out;
}

/** Format seconds as h:mm:ss / m:ss, or '—'. */
export function fmtTime(sec) {
  if (!(sec >= 0)) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0 ? h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') : m + ':' + String(s).padStart(2, '0');
}

/** Largest gap between sorted timestamps within [start, end] (both ends count as boundaries). */
export function maxGap(times, start, end) {
  const ts = times.filter((t) => t >= start && t <= end).sort((a, b) => a - b);
  let prev = start;
  let gap = 0;
  for (const t of ts) {
    gap = Math.max(gap, t - prev);
    prev = t;
  }
  return Math.max(gap, end - prev);
}

/** Parse CLI arguments. */
export function parseArgs(argv) {
  const o = { hours: 2, seed: 1, dt: 0.1, until: null, strict: false, json: false, quiet: false, shadow: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--hours') o.hours = Number(next());
    else if (a === '--seed') o.seed = Number(next());
    else if (a === '--dt') o.dt = Number(next());
    else if (a === '--until') o.until = next();
    else if (a === '--strict') o.strict = true;
    else if (a === '--json') o.json = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--no-shadow') o.shadow = false;
  }
  if (!(o.hours > 0)) o.hours = 2;
  if (!Number.isFinite(o.seed)) o.seed = 1;
  if (!(o.dt > 0) || o.dt > 1) o.dt = 0.1;
  if (o.until && !['flight', 'supercolony', 'speciation'].includes(o.until)) o.until = null;
  return o;
}

// ------------------------------------------------------------------------------------------------------------------
// The bot
// ------------------------------------------------------------------------------------------------------------------

/** A bot playing one game. `noFly` keeps it in the current run (shadow run). */
export class Bot {
  constructor(game, { noFly = false } = {}) {
    this.g = game;
    this.noFly = noFly;
    this.clickAcc = 0;
    this.nextThink = 0;
    this.disabled = new Set();
    this.errors = 0;
    this.errorSamples = [];
    this.purchases = [];      // simTime of accepted purchases
    this.lastJobsAt = -1e9;
    this.flewHook = null;     // called before the first flight (shadow run)
    this.rv = Object.create(null); // revealed unlock keys, refreshed every think()
    this.chitinCutAt = -1e9;  // simTime the chitin policy last freed a trail slot
  }

  /** Enqueue a command through game.actions; disables a type the registry does not know. */
  act(type, args = {}) {
    if (this.disabled.has(type)) return false;
    let r;
    try {
      r = this.g.actions.do(type, args);
    } catch (e) {
      this.err(type, e);
      return false;
    }
    if (!r.ok && r.reason === 'unknown') this.disabled.add(type);
    if (r.ok && PURCHASE_TYPES.has(type)) this.purchases.push(this.g.s.meta.simTime);
    return r.ok;
  }

  /** Record a policy error (first few kept as samples). */
  err(where, e) {
    this.errors++;
    if (this.errorSamples.length < 5) this.errorSamples.push(where + ': ' + String((e && e.message) || e));
  }

  /** Queue this tick's clicks (4/s early in a run, then 1/s). */
  clicks(dt) {
    const s = this.g.s;
    if (s.meta.pending) return;
    const fastFor = s.run.index === 0 ? POLICY.clickFastRun1Sec : POLICY.clickFastLaterSec;
    const rate = s.run.time < fastFor ? POLICY.clickFast : POLICY.clickSlow;
    this.clickAcc += rate * dt;
    const src = s.run.surface.sources.find((x) => x && x.type === 'crumb_scatter');
    while (this.clickAcc >= 1) {
      this.clickAcc -= 1;
      if (src) this.act('clickForage', { src: src.uid });
    }
    if (s.run.golden.beetle) this.act('clickBeetle', {});
    if (s.run.golden.pupa) this.act('clickPupa', { choice: 'windfall' });
    if (s.run.golden.gifts.length > 0) this.act('openGift', { index: 0 });
  }

  /** One decision step. Each policy is isolated so a half-built package cannot stop the bot. */
  think() {
    const s = this.g.s;
    this.rv = revealedKeys(s);
    const steps = s.meta.pending
      ? ['prestigeShop', 'landing']
      : ['eventCard', 'eventObjects', 'jobsPolicy', 'researchPolicy', 'buildPolicy', 'adaptPolicy', 'trailPolicy', 'claimPolicy',
        'military', 'rearing', 'prestigeShop', 'automationToggles', 'satellites', 'prestigeMoves'];
    for (const name of steps) {
      try {
        this[name]();
      } catch (e) {
        this.err(name, e);
      }
      if (this.g.s !== s) break;
    }
  }

  // --- policies ------------------------------------------------------------------------------------------------

  eventCard() {
    const card = this.g.s.run.events.card;
    if (!card) return;
    const def = EVENTS[card.id] && Array.isArray(EVENTS[card.id].choices) ? EVENTS[card.id].choices.find((c) => c.def) : null;
    const choice = def ? def.id : Array.isArray(card.choices) ? card.choices[card.choices.length - 1] : null;
    if (choice) this.act('eventChoice', { uid: card.uid, choice });
  }

  /** Click event objects away like an active player (DESIGN §18.2 counterplay): scrape mold spots, scatter footsteps,
   *  swat ladybugs, catch flying rival alates and golden aphids. A few per decision; each uses one click (cap 15/s). */
  eventObjects() {
    const s = this.g.s;
    let n = POLICY.clicksPerThink;
    for (const o of s.run.events.objects.slice()) {
      if (n <= 0) return;
      if (o.kind === 'mold') { if (this.act('scrapeMold', { uid: o.uid })) n--; }
      else if (['footstep', 'ladybug', 'rival_alate', 'golden_aphid'].includes(o.kind)) { if (this.act('clickEventObject', { uid: o.uid })) n--; }
    }
  }

  /** Unlocked jobs and the target counts of the fixed ratio table (diggers shifted toward a binding soil need). */
  jobTargets() {
    const { s, d } = this.g;
    const c = s.run.colony;
    const u = this.rv;
    const m = Math.max(0, Math.floor(c.adults.minor - c.militia));
    const counts = { forager: 0, digger: 0, nurse: 0, scout: 0, herder: 0, leafcutter: 0, gardener: 0 };
    let free = m;
    const capOf = (job) => {
      const v = q(jobs.jobCap, s, d, job);
      return Number.isFinite(v) ? Math.max(0, Math.floor(v)) : free;
    };
    if (u.job_herder) { counts.herder = Math.min(capOf('herder'), Math.floor(0.15 * m)); free -= counts.herder; }
    if (u.job_gardener) { counts.gardener = Math.min(capOf('gardener'), Math.floor(0.1 * m)); free -= counts.gardener; }
    // C238: leafcutters only once a Fungus Garden stores leaves (jobCap is 0 before)
    if (u.job_leafcutter) { counts.leafcutter = Math.min(free, capOf('leafcutter'), counts.gardener > 0 ? counts.gardener : Math.floor(0.05 * m)); free -= counts.leafcutter; }
    const r = { ...POLICY.jobRatio };
    if (this.soilBinding) { r.digger = POLICY.diggerRatioSoil; r.forager = 1 - r.digger - r.nurse - r.scout; }
    if (!u.job_digger) { r.forager += r.digger; r.digger = 0; }
    if (!u.panel_colony) { r.forager += r.nurse; r.nurse = 0; }
    const frontier = d.surface && Array.isArray(d.surface.frontier) ? d.surface.frontier.length : 1;
    if (!u.job_scout || frontier === 0) { r.forager += r.scout; r.scout = 0; }
    const nurseMax = Math.floor(4 * (d.stats.broodSlots || 0));
    counts.digger = Math.floor(free * r.digger);
    counts.nurse = Math.min(nurseMax, Math.floor(free * r.nurse));
    counts.scout = Math.floor(free * r.scout);
    counts.forager = Math.max(0, free - counts.digger - counts.nurse - counts.scout);
    return { counts, m };
  }

  jobsPolicy() {
    const { s } = this.g;
    if (s.meta.simTime - this.lastJobsAt < 5) return;
    this.lastJobsAt = s.meta.simTime;
    const c = s.run.colony;
    const { counts, m } = this.jobTargets();
    if (m <= 0) return;
    const autoOk = !!(s.run.research.age_polyethism || (s.era.federation.automated_brood || 0) > 0); // C166: not automaton_instincts
    if (autoOk && this.rv.job_presets) {
      if (!c.autoJobs) this.act('setAutoJobs', { on: true });
      const targets = {};
      for (const k of Object.keys(counts)) targets[k] = counts[k] / m;
      const cur = c.jobTargets;
      if (Object.keys(targets).some((k) => Math.abs((cur[k] || 0) - targets[k]) > 0.02)) this.act('setJobTargets', { targets });
      return;
    }
    if (Object.keys(counts).some((k) => Math.abs((c.jobs[k] || 0) - counts[k]) >= Math.max(1, 0.02 * m))) this.act('setJobs', { jobs: counts });
  }

  /** Prerequisite closure of a research node, prerequisites first. */
  chain(id, out = [], seen = new Set()) {
    if (seen.has(id) || !RESEARCH[id]) return out;
    seen.add(id);
    for (const p of RESEARCH[id].prereq || []) this.chain(p, out, seen);
    out.push(id);
    return out;
  }

  researchPolicy() {
    const { s } = this.g;
    if (!this.rv.panel_research) return;   // the Research tab is hidden until revealed
    const owned = (id) => !!s.run.research[id];
    // Cheapest-weighted: once f_run ≥ FLIGHT.tabFRun the nuptial_preparation chain counts at POLICY.rushWeight of its cost.
    const rush = s.run.fRun >= FLIGHT.tabFRun && RESEARCH.nuptial_preparation && !owned('nuptial_preparation')
      ? new Set(this.chain('nuptial_preparation')) : null;
    // A sighted rival makes Polymorphism (soldiers) urgent, as in the DESIGN §24.1 beat script (rival ~9 min → Polymorphism ~13 min).
    const banned = s.run.hardship === 'pacifist' || s.run.hardship === 'monomorphic';
    const war = !banned && RESEARCH.polymorphism && !owned('polymorphism') && s.run.rivals.list.some((r) => r && r.alive && r.sighted)
      ? new Set(this.chain('polymorphism')) : null;
    let target = null;
    let best = Infinity;
    for (const id of RESEARCH_ORDER) {
      if (!q(research.isAvailable, s, id)) continue;
      const c = q(research.cost, s, id);
      let w = 1;
      if (rush && rush.has(id)) w = Math.min(w, POLICY.rushWeight);
      if (war && war.has(id)) w = Math.min(w, POLICY.warWeight);
      const v = (c && Number.isFinite(c.insight) ? c.insight : Infinity) * w;
      if (v < best) { best = v; target = id; }
    }
    if (target) {
      if (canAfford(s, q(research.cost, s, target))) this.act('buyResearch', { id: target });
      return;
    }
    let bestB = null;
    let bestC = Infinity;
    for (const b of BRANCH_ORDER) {
      const c = q(research.refinementCost, s, b);
      if (c && c.insight < bestC) { bestC = c.insight; bestB = b; }
    }
    if (bestB && canAfford(s, q(research.refinementCost, s, bestB))) this.act('buyRefinement', { branch: bestB });
  }

  /** Chambers of a type (live list). */
  chambersOf(type) {
    return this.g.s.run.nest.chambers.filter((c) => c && c.type === type);
  }

  /** Rect { x0, y0, x1, y1 } (inclusive) a chamber may grow into: the Royal Chamber's centred L8 box, otherwise the
   *  chamber's L8 envelope anchored at its corner and growing right / down (the bot always grows that way), united
   *  with its current footprint. Keeping new chambers out of these rects means nothing is ever boxed in. */
  reservedRect(ch) {
    // C137: the game's own reservation when the chamber has one
    if (ch.res && Number.isInteger(ch.res.x)) return { x0: ch.res.x, y0: ch.res.y, x1: ch.res.x + ch.res.w - 1, y1: ch.res.y + ch.res.h - 1 };
    const fp = q(nestgeom.footprint, ch.type, GROW_L) || { w: ch.w, h: ch.h };
    if (ch.uid === 1) {
      const side = Math.max(0, fp.w - ch.w);
      return { x0: ch.x - side, y0: ch.y, x1: ch.x + ch.w - 1 + side, y1: ch.y + Math.max(ch.h, fp.h) - 1 };
    }
    return { x0: ch.x, y0: ch.y, x1: ch.x + Math.max(ch.w, fp.w) - 1, y1: ch.y + Math.max(ch.h, fp.h) - 1 };
  }

  /** A placement spot whose growth envelope stays clear of every reserved rect (closest to the preferred point). */
  placeSpot(type) {
    const { s, d } = this.g;
    const fp1 = q(nestgeom.footprint, type, 1);
    const env = q(nestgeom.footprint, type, GROW_L);
    if (!fp1 || !env || !(fp1.w > 0)) return q(nest.findPlacement, s, d, type);
    const cells = s.run.nest.cells;
    const rects = s.run.nest.chambers.filter(Boolean).map((ch) => this.reservedRect(ch));
    // Shaft cells block growth (nest cellBlock 'blocked:shaft'): an envelope across one boxes the chamber in. Same mask as
    // nestgeom: each open shaft's column from row 0 down while the cells are tunnel.
    const shaftCell = new Uint8Array(GRID.cols * GRID.rows);
    for (const sh of s.run.nest.shafts || []) {
      if (!sh || !sh.open || !(sh.col >= 0 && sh.col < GRID.cols)) continue;
      for (let y = 0; y < GRID.rows; y++) {
        const i = y * GRID.cols + sh.col;
        if (cells[i] !== 1) break;
        shaftCell[i] = 1;
      }
    }
    const royal = s.run.nest.chambers.find((ch) => ch && ch.uid === 1);
    const tx = royal ? royal.x + royal.w / 2 : GRID.mainCol;
    const ty = type === 'nursery' && royal ? royal.y : PLACE_ROW[type] ?? PLACE_ROW.default;
    const cands = [];
    for (let y = 1; y + env.h <= GRID.rows; y++) {
      for (let x = 1; x + env.w <= GRID.cols - 1; x++) {
        const r = { x0: x, y0: y, x1: x + env.w - 1, y1: y + env.h - 1 };
        if (rects.some((o) => !(r.x1 < o.x0 || r.x0 > o.x1 || r.y1 < o.y0 || r.y0 > o.y1))) continue;
        let ok = true;
        for (let yy = r.y0; yy <= r.y1 && ok; yy++) {
          for (let xx = r.x0; xx <= r.x1; xx++) {
            const c = cells[yy * GRID.cols + xx];
            if ((c !== 0 && c !== 1) || shaftCell[yy * GRID.cols + xx]) { ok = false; break; }   // soil or tunnel, never a shaft
          }
        }
        if (ok) cands.push({ x, y, score: Math.abs(x + fp1.w / 2 - tx) + 2 * Math.abs(y - ty) });
      }
    }
    cands.sort((a, b) => a.score - b.score);
    for (const c of cands.slice(0, PLACE_TRIES)) {
      const v = q(nest.validatePlacement, s, d, type, c.x, c.y);
      if (v && v.ok) return { x: c.x, y: c.y };
    }
    // Dense late layouts (blueprints) can leave no spot with a clear growth envelope: fall back to the game's own
    // advisor for the Nuptial Chamber and for a type's first instance (without them long runs stalled: no Flight, no merge,
    // or no Gallery at all).
    if (type === 'nuptial_chamber' || this.chambersOf(type).length === 0) {
      const p = q(nest.findPlacement, s, d, type);
      if (p && Number.isInteger(p.x) && Number.isInteger(p.y)) return { x: p.x, y: p.y };
    }
    return null;
  }

  /** Growth directions: right / down (the reserved envelope) for every chamber; the Royal Chamber widens toward the
   *  side with more reserved room, then down. */
  dirOrder(ch) {
    if (ch.uid !== 1) return ['right', 'down', 'left', 'up'];
    return ch.x + ch.w / 2 >= GRID.mainCol ? ['left', 'right', 'down', 'up'] : ['right', 'left', 'down', 'up'];
  }

  /**
   * Options for a chamber type: place a new instance and / or level an existing one (growing chambers need a free
   * direction). Each option: { kind, cost, spot | uid, dir }.
   */
  chamberOptions(type, { placeOnly = false, levelOnly = false } = {}) {
    const { s, d } = this.g;
    const opts = [];
    if (!CHAMBERS[type]) return opts;
    if (!levelOnly && s.run.nest.queue.length < POLICY.maxQueue) {
      const cost = q(nest.placementCost, s, type);
      const spot = cost ? this.placeSpot(type) : null;
      if (cost && spot) opts.push({ kind: 'place', cost, spot });
    }
    if (!placeOnly) {
      for (const ch of this.chambersOf(type)) {
        if (ch.status !== 'active') continue;
        const info = q(nest.levelInfo, s, d, ch.uid);
        if (!info || !info.cost || info.blocked || info.max) continue;
        // C137: a chamber with a reservation grows into it in a fixed order (no direction)
        const dir = info.grows && !info.reserved ? this.dirOrder(ch).find((k) => info.dirs && info.dirs[k]) : undefined;
        if (info.grows && !info.reserved && !dir) continue;
        opts.push({ kind: 'level', cost: info.cost, uid: ch.uid, dir });
      }
    }
    opts.sort((a, b) => (a.cost.food || 0) - (b.cost.food || 0));
    return opts;
  }

  /** True if the cheapest option of any of these chamber types costs more food than POLICY.capNeedFrac of the food cap. */
  capBlocks(types) {
    const cap = this.g.d.stats.foodCap;
    return types.some((t) => { const o = this.chamberOptions(t)[0]; return !!o && (o.cost.food || 0) > POLICY.capNeedFrac * cap; });
  }

  /** Queue the cheapest affordable option of a type. Returns true if queued; flags soil as binding when only soil is short. */
  growType(type, flags = {}) {
    const s = this.g.s;
    const opts = this.chamberOptions(type, flags);
    const pick = opts.find((o) => canAfford(s, o.cost));
    if (!pick) {
      if (opts.some((o) => (o.cost.food || 0) <= s.run.res.food && (o.cost.soil || 0) > s.run.res.soil)) this.soilBinding = true;
      return false;
    }
    if (pick.kind === 'place') return this.act('placeChamber', { chamber: type, x: pick.spot.x, y: pick.spot.y });
    return this.act('levelChamber', pick.dir ? { uid: pick.uid, dir: pick.dir } : { uid: pick.uid });
  }

  buildPolicy() {
    const { s, d } = this.g;
    const u = this.rv;
    const c = s.run.colony;
    const st = d.stats;
    const agg = d.nest.agg;
    this.soilBinding = false;
    this.saving = false;
    const brood = broodTotal(s);
    const housingFull = st.housing - (c.adults.minor + brood) < 1;
    // 1. Flight path: Nuptial Chamber once researched; Royal Chamber toward L5 (saving for it while it can grow).
    if (s.run.research.nuptial_preparation && this.chambersOf('nuptial_chamber').length === 0 && this.growType('nuptial_chamber', { placeOnly: true })) return;
    // … and grow it to its max level: every level adds 5 alate cells (DESIGN §5.4; 10 → 25 cells = +30 % flight alates).
    if (this.chambersOf('nuptial_chamber').some((ch) => ch.status === 'active') && this.growType('nuptial_chamber', { levelOnly: true })) return;
    const royal = s.run.nest.chambers.find((ch) => ch && ch.uid === 1);
    if (u.royal_levelup && royal && royal.status === 'active' && royal.level < POLICY.royalTargetLevel) {
      if (this.growType('royal_chamber', { levelOnly: true })) return;
      const ro = this.chamberOptions('royal_chamber', { levelOnly: true });
      if (ro.length > 0) {
        if ((ro[0].cost.food || 0) > st.foodCap) {
          if (u.chamber_granary && this.growType('granary')) return; // the cap must rise before the Royal can level
        } else {
          this.saving = true;
          if (!housingFull) return;
        }
      }
    }
    // 2. Housing, brood slots, storage.
    if (u.chamber_gallery && st.housing - (c.adults.minor + brood) < Math.max(3, POLICY.housingMargin * st.housing) && this.growType('gallery')) return;
    if (this.saving) return;
    if (u.chamber_nursery && brood >= POLICY.slotFill * st.broodSlots && this.growType('nursery')) return;
    // Storage when food sits at the cap — but while soil is the binding resource, only if the cap blocks the next Gallery
    // or Library level (granaries otherwise soak up the soil those need).
    if (u.chamber_granary && s.run.res.food >= POLICY.storageFill * st.foodCap && (!this.soilBinding || this.capBlocks(['gallery', 'scent_library']))
      && this.growType('granary')) return;
    // C198: while the lay rate binds, grow the queens first: the cheapest Royal Chamber level, or another Royal Chamber
    // once Polygyny / Queens' Council allow one (the lay rate no longer scales with colony scale).
    if (royal && u.royal_levelup && royal.level >= POLICY.royalTargetLevel && s.run.bottleneck.id === 'bn_lay_rate'
      && this.growType('royal_chamber')) return;
    // C199: chitin storage. A Carapace Store when chitin sits near its cap; one Carapace Workshop (chitin ×1.1 per level)
    // from POLICY.workshopSec into a run (a run-1 player is busy with the first conquest before that).
    if (u.chamber_carapace_store && (s.run.res.chitin || 0) >= POLICY.storageFill * (st.chitinCap ?? Infinity)
      && this.growType('carapace_store')) return;
    if (u.chamber_carapace_workshop && s.run.time >= POLICY.workshopSec && this.chambersOf('carapace_workshop').length === 0
      && this.growType('carapace_workshop', { placeOnly: true })) return;
    // 3. Economy chambers.
    if (u.chamber_scent_library && this.chambersOf('scent_library').length < POLICY.libraries && this.growType('scent_library', { placeOnly: true })) return;
    if (u.chamber_midden && this.chambersOf('midden').length === 0 && this.growType('midden', { placeOnly: true })) return;
    if (u.chamber_root_aphid_pen && this.chambersOf('root_aphid_pen').length < 2 && this.growType('root_aphid_pen', { placeOnly: true })) return;
    if (u.chamber_fungus_garden && this.chambersOf('fungus_garden').length === 0 && this.growType('fungus_garden', { placeOnly: true })) return;
    // C136: Barracks berths house soldiers only; supermajors need War Hall berths
    const needBerths = u.chamber_barracks && c.casteGoals.soldier > 0 && c.adults.soldier + 1 >= st.berths;
    if (needBerths && this.growType('barracks')) return;
    const needWar = u.chamber_war_hall && c.casteGoals.supermajor > 0 && c.adults.supermajor + 1 >= (st.warBerths || 0);
    if (needWar && this.growType('war_hall')) return;
    // Libraries before the Royal Chamber: insight is the run-1 research bottleneck, and Royal levels past L5 only raise the lay
    // rate, which matters only while housing is free (a housing-capped colony lays nothing).
    if (agg.libraryInsight > 0 && this.growType('scent_library', { levelOnly: true })) return;
    if (royal && u.royal_levelup && !housingFull && this.growType('royal_chamber', { levelOnly: true })) return;
    if (this.chambersOf('carapace_workshop').length > 0 && this.growType('carapace_workshop', { levelOnly: true })) return;
    // 4. C220: the Mound grows on its own with the colony (nothing to buy).
  }

  adaptPolicy() {
    const { s, d } = this.g;
    if (!this.rv.panel_colony) return;     // Adaptations live in the Colony tab
    let best = null;
    let bestFood = Infinity;
    for (const id of ADAPTATION_ORDER) {
      if (!q(adaptations.isAvailable, s, id)) continue;
      const c = q(adaptations.cost, s, id, 1);
      if (!c || !canAfford(s, c)) continue;
      // Chitin also pays for every soldier egg (DESIGN §5.2): spend only a small share of the stock on Adaptations.
      if ((c.chitin || 0) > POLICY.adaptChitinFrac * (s.run.res.chitin || 0)) continue;
      const food = c.food || 0;
      if (food < bestFood) { bestFood = food; best = id; }
    }
    if (!best) return;
    const gross = d.rates.food.gross || 0;
    const limit = Math.max(POLICY.adaptIncomeSec * gross, POLICY.adaptFoodFrac * s.run.res.food) * (this.saving ? POLICY.savingFrac : 1);
    if (bestFood <= limit) this.act('buyAdaptation', { id: best, n: 1 });
  }

  trailPolicy() {
    const { s, d } = this.g;
    const u = this.rv;
    if (u.caste_soldier && (s.run.res.chitin || 0) < POLICY.chitinReserve && this.chitinTrail()) return;
    if (!(d.surface.slotsUsed < d.surface.slots)) return;
    const cands = [];
    for (const job of ['forager', u.job_herder ? 'herder' : null, u.job_leafcutter ? 'leafcutter' : null]) {
      if (!job) continue;
      const list = q(trails.bestTargets, s, d, job);
      if (Array.isArray(list)) for (const t of list) cands.push(t);
    }
    cands.sort((a, b) => (b.score || 0) - (a.score || 0));
    const origins = q(trails.trailOrigins, s, d);
    const origin = Array.isArray(origins) && origins.length ? origins[0] : 0;
    for (const t of cands.slice(0, 3)) if (this.act('drawTrail', { origin, target: t.hex })) return;
  }

  /** Soldier eggs cost chitin (DESIGN §5.2): while chitin is short, keep one trail on a dead insect (0.01 chitin per
   *  forager), freeing the forager trail with the lowest output when every slot is in use. True if it acted. */
  chitinTrail() {
    const { s, d } = this.g;
    const S = s.run.surface;
    const typeOf = (uid) => { const src = S.sources.find((x) => x && x.uid === uid); return src ? src.type : null; };
    if (S.trails.some((t) => typeOf(t.src) === 'dead_insect')) return false;
    const list = q(trails.bestTargets, s, d, 'forager');
    const insect = Array.isArray(list) ? list.find((t) => typeOf(t.src) === 'dead_insect') : null;
    if (!insect) return false;
    if (d.surface.slotsUsed < d.surface.slots) {
      const origins = q(trails.trailOrigins, s, d);
      return this.act('drawTrail', { origin: Array.isArray(origins) && origins.length ? origins[0] : 0, target: insect.hex });
    }
    if (s.meta.simTime - this.chitinCutAt < 60) return false;             // at most one trail freed per minute
    const out = new Map((d.surface.trails || []).map((t) => [t.uid, t.out || 0]));
    const worst = S.trails.filter((t) => t.job === 'forager').sort((a, b) => (out.get(a.uid) || 0) - (out.get(b.uid) || 0))[0];
    if (!worst || !this.act('deleteTrail', { uid: worst.uid })) return false;
    this.chitinCutAt = s.meta.simTime;
    return true;                                                           // the insect trail is drawn next decision
  }

  claimPolicy() {
    const { s, d } = this.g;
    if (!this.rv.hex_claim || s.run.surface.channel) return;
    const cost = q(surface.claimCost, s);
    if (!cost || !canAfford(s, cost)) return;
    const owned = d.surface.owned;
    const n = countInRadius(s.run.surface.radius);
    for (let h = 0; h < n; h++) {
      if (!(owned[h] > 0)) continue;
      for (const nb of neighbors(h)) {
        if (nb >= n || owned[nb] > 0 || !s.run.surface.revealed[nb]) continue;
        if (q(surface.canClaim, s, d, nb) === null) {
          this.act('claimHex', { hex: nb });
          return;
        }
      }
    }
  }

  military() {
    const { s, d } = this.g;
    const u = this.rv;
    const c = s.run.colony;
    const banned = s.run.hardship === 'pacifist' || s.run.hardship === 'monomorphic';
    if (!banned && u.caste_soldier) {
      // C151: target counts scale with the workforce; re-sent when either drifts by more than 5 % (or 1 ant).
      const m = c.adults.minor;
      const want = { soldier: Math.max(1, Math.round(m * POLICY.soldierPerMinor)),
        supermajor: u.caste_supermajor ? Math.round(m * POLICY.supermajorPerMinor) : 0 };
      const off = (k) => Math.abs(want[k] - c.casteGoals[k]) > Math.max(1, 0.05 * want[k]);
      if (c.casteFill.soldier || c.casteFill.supermajor || off('soldier') || off('supermajor')) this.act('setCasteTargets', want);
    }
    const g = q(rivals.garrison, s, d) || { soldier: 0, supermajor: 0 };
    // C136: supermajors no longer share the Barracks, so soldiers are not retired to make room for them.
    if (!u.panel_war || banned || s.run.war.parties.length > 0 || !(g.soldier + g.supermajor > 0)) return;
    const army = { soldier: Math.floor(g.soldier), supermajor: Math.floor(g.supermajor) };
    for (const r of s.run.rivals.list) {
      if (!r || !r.alive || !r.sighted) continue;
      for (const kind of ['assault', 'raid']) {
        const p = q(rivals.previewAction, s, d, kind, r.uid, army);
        // Assault (conquest) first whenever the preview is favourable: AP ≥ fightRatio × defence, or a near-certain win.
        const good = p && p.ok && p.foeAP > 0 && (p.youAP >= POLICY.fightRatio * p.foeAP || (kind === 'assault' && p.win >= POLICY.assaultWin));
        if (good) {
          if (this.act('launchParty', { kind, target: { type: 'rival', uid: r.uid }, ...army })) return;
        }
      }
    }
    for (const src of s.run.surface.sources) {
      if (!src || !/^prey_/.test(src.type) || !s.run.surface.revealed[src.hex]) continue;
      const p = q(rivals.previewAction, s, d, 'hunt', src.uid, army);
      if (p && p.ok && p.foeAP > 0 && p.youAP >= POLICY.fightRatio * p.foeAP) {
        if (this.act('launchParty', { kind: 'hunt', target: { type: 'source', uid: src.uid }, ...army })) return;
      }
    }
  }

  rearing() {
    const { s, d } = this.g;
    if (this.rv.alate_rearing && d.nest.agg.nuptial.active && !s.meta.automation.autoRear) this.act('setAutomation', { patch: { autoRear: true } });
  }

  /** Spend alates / kinship / genes (one purchase per currency per think). */
  prestigeShop() {
    const s = this.g.s;
    const cheapest = (ids, costFn, res) => {
      let best = null;
      let bestC = Infinity;
      for (const id of ids) {
        const c = q(costFn, s, id);
        if (c && c[res] < bestC && canAfford(s, c)) { bestC = c[res]; best = id; }
      }
      return best;
    };
    let traitIds = POLICY.traitPriority.filter((id) => TRAITS[id]);
    if (s.cycle.alatesCycle >= POLICY.buddingSaveAt && !(s.cycle.traits.budding > 0)) traitIds = ['budding'];
    const t = cheapest(traitIds, traitsSys.traitCost, 'alates');
    if (t) this.act('buyTrait', { id: t });
    let fedIds = FED_ORDER.slice();
    if (s.era.kinshipLife >= 50 && !(s.era.federation.megacolony > 0)) fedIds = ['megacolony'];
    const f = cheapest(fedIds, traitsSys.fedCost, 'kinship');
    if (f) this.act('buyFederation', { id: f });
    const gn = cheapest(GENOME_ORDER, traitsSys.genomeCost, 'genes');
    if (gn) this.act('buyGenome', { id: gn });
    if ((s.era.federation.heirloom_bloodline || 0) > 0) {
      const costOf = (id) => { const tr = TRAITS[id]; return tr ? tr.cost.base * tr.cost.growth ** (s.cycle.traits[id] || 0) : 0; };
      const top = Object.keys(s.cycle.traits).filter((id) => s.cycle.traits[id] > 0 && TRAITS[id]).sort((a, b) => costOf(b) - costOf(a)).slice(0, 3);
      if (top.length && top.join() !== s.era.heirlooms.join()) this.act('setHeirlooms', { ids: top });
    }
  }

  landing() {
    const p = this.g.s.meta.pending;
    if (!p || p.kind !== 'landing') return;
    this.act('chooseLanding', { index: 0, boon: Array.isArray(p.boons) && p.boons.length ? p.boons[0] : null });
  }

  automationToggles() {
    const s = this.g.s;
    const on = (s.era.federation.autobuyers || 0) > 0; // C166: the Adaptation autobuyer is Federation-only
    const a = s.meta.automation.autobuy;   // C246: both autobuyers, as the old master switch did
    if (on && !(a.adaptations && a.chambers)) this.act('setAutomation', { patch: { autobuy: { adaptations: true, chambers: true } } });
  }

  satellites() {
    const { s, d } = this.g;
    const L = s.era.federation.satellite_nest || 0;
    const have = s.run.surface.entrances.filter((e) => e && e.kind === 'satellite').length;
    if (!(L > have)) return;
    const owned = d.surface.owned;
    const n = countInRadius(s.run.surface.radius);
    const cols = [];
    for (let col = 1; col < GRID.cols - 1; col += 3) cols.push(col);
    let tries = 0;
    // actions.do validates synchronously and enqueues only a valid command, so probing candidates is side-effect free.
    for (let h = n - 1; h > 0 && tries < 200; h--) {
      if (!(owned[h] > 0)) continue;
      for (const col of cols) {
        tries++;
        if (this.act('placeSatellite', { hex: h, col })) return;
        if (this.disabled.has('placeSatellite')) return;
      }
    }
  }

  prestigeMoves() {
    const { s, d } = this.g;
    const proj = d.meta.proj;
    if (proj.spec && proj.spec.ok) {
      const sp = SPECIES_ORDER.find((id) => s.meta.speciesUnlocked[id] && SPECIES[id] && !s.meta.signatureGenes[SPECIES[id].sig])
        || SPECIES_ORDER.find((id) => s.meta.speciesUnlocked[id]) || 'garden_ant';
      if (this.act('speciate', { species: sp })) return;
    }
    if (proj.superc && proj.superc.ok && proj.kinship >= POLICY.mergeFrac * s.era.kinshipLife && proj.kinship > 0) {
      if (this.act('supercolony', { edict: POLICY.edict })) return;
    }
    if (this.noFly || !proj.fly || !proj.fly.ok) return;
    const run = s.run;
    const peakPassed = run.prestige.peakRate > 0 && proj.perMin < FLIGHT.peakGlow * run.prestige.peakRate;
    const worth = run.time >= POLICY.flyMinRunSec && proj.alates >= POLICY.flyCycleFrac * s.cycle.alatesCycle;
    if ((worth && peakPassed) || run.time >= POLICY.flyMaxRunSec) {
      if (this.flewHook) {
        const hook = this.flewHook;
        this.flewHook = null;
        hook();
      }
      this.act('fly', {});
    }
  }
}

// ------------------------------------------------------------------------------------------------------------------
// Milestones and the simulation driver
// ------------------------------------------------------------------------------------------------------------------

/** 2e8 → '2e8' (milestone labels follow the data). */
const sci = (x) => Number(x).toExponential().replace(/\.?0*e\+?/, 'e');

const MILESTONES = [
  ['firstWorker', 'First worker'], ['galleryPlaced', 'First Gallery placed'], ['galleryBuilt', 'First Gallery built'],
  ['granary', 'Granary built'], ['nursery', 'Nursery built'], ['firstInsight', 'First insight'], ['firstResearch', 'First research'],
  ['scentLibrary', 'Scent Library built'], ['adults100', '100 adults'], ['adults500', '500 adults'], ['adults1000', '1,000 adults'],
  ['fRunTab', 'f_run ' + sci(FLIGHT.tabFRun) + ' (Prestige tab)'], ['fRunGate', 'f_run ' + sci(FLIGHT.fRunMin) + ' (Flight gate)'], ['royalL5', 'Royal Chamber L5'],
  ['nuptialPrep', 'nuptial_preparation'], ['firstConquest', 'First conquest'], ['flightAvailable', 'Flight available'],
  ['firstFlight', 'First Flight'], ['oldRidgeSeen', 'Old Ridge appears'], ['oldRidgeFallen', 'Old Ridge conquered'],
  ['firstSuper', 'First Supercolony'], ['frontSeen', 'Argentine Front appears'], ['frontFallen', 'Argentine Front broken'],
  ['firstSpec', 'First Speciation'],
];

/** Tracks milestone times (simTime) from events and state. */
class Tracker {
  constructor() {
    this.t = {};
    this.values = {};
    this.unlockTimes = [];      // unlock reveals, research and event cards (first-30-min gap check)
    this.run1Activity = [];     // purchases and unlocks during run 1 (no-purchase window)
    this.run1End = -1;
  }

  mark(key, time, value) {
    if (this.t[key] === undefined) {
      this.t[key] = time;
      if (value !== undefined) this.values[key] = value;
    }
  }

  observe(g, events) {
    const s = g.s;
    const d = g.d;
    const now = s.meta.simTime;
    const run1 = s.run.index === 0 && !s.meta.pending && this.run1End < 0;
    for (const e of events) {
      switch (e.type) {
        case 'hatched': this.mark('firstWorker', now); break;
        case 'chamberActivated': {
          const ch = s.run.nest.chambers.find((c) => c && c.uid === e.uid);
          const type = ch ? ch.type : null;
          if (type === 'gallery') this.mark('galleryBuilt', now);
          if (type === 'granary') this.mark('granary', now);
          if (type === 'nursery') this.mark('nursery', now);
          if (type === 'scent_library') this.mark('scentLibrary', now);
          if (run1) this.run1Activity.push(now);
          break;
        }
        case 'researchBought':
          this.mark('firstResearch', now);
          if (e.id === 'nuptial_preparation') this.mark('nuptialPrep', now);
          this.unlockTimes.push(now);
          break;
        case 'unlock': this.unlockTimes.push(now); if (run1) this.run1Activity.push(now); break;
        case 'eventSpawned': this.unlockTimes.push(now); break;
        case 'conquest': this.mark('firstConquest', now); break;
        case 'flightComplete':
          this.mark('firstFlight', now, e.alates);
          if (this.run1End < 0) this.run1End = now;
          break;
        case 'supercolonyComplete': this.mark('firstSuper', now, e.kinship); break;
        case 'speciationComplete': this.mark('firstSpec', now, e.genes); break;
        default: break;
      }
      if (run1 && PURCHASE_EVENTS.has(e.type)) this.run1Activity.push(now);
    }
    if (s.meta.pending) return;
    const a = adultsTotal(s);
    if (a >= 100) this.mark('adults100', now);
    if (a >= 500) this.mark('adults500', now);
    if (a >= 1000) this.mark('adults1000', now);
    if (s.run.res.insight > 0) this.mark('firstInsight', now);
    if (s.run.nest.chambers.some((c) => c && c.type === 'gallery')) this.mark('galleryPlaced', now);
    if (s.run.fRun >= FLIGHT.tabFRun) this.mark('fRunTab', now);
    if (s.run.fRun >= FLIGHT.fRunMin) this.mark('fRunGate', now);
    if (d.nest.agg.royalL >= FLIGHT.royalLevel) this.mark('royalL5', now);
    if (d.meta.proj.fly.ok) this.mark('flightAvailable', now);
    for (const r of s.run.rivals.list) {
      if (!r) continue;
      if (r.type === 'old_ridge_supercolony') {
        this.mark('oldRidgeSeen', now);
        if (!r.alive && r.fallenAt >= 0) this.mark('oldRidgeFallen', now);
      }
      if (r.type === 'great_rival') this.mark('frontSeen', now);
    }
    if (d.meta.proj.spec.front) this.mark('frontFallen', now);
    if (s.run.index === 0 && this.values.alates90 === undefined && now >= 5400) this.values.alates90 = d.meta.proj.alates;
  }
}

/**
 * Run the pacing simulation.
 * @param {{ hours?: number, seed?: number, dt?: number, until?: string|null, quiet?: boolean, shadow?: boolean, log?: (s: string) => void }} [opts]
 * @returns {Object} report
 */
export function simulate(opts = {}) {
  const o = { ...parseArgs([]), ...opts };
  const log = o.log || ((line) => process.stderr.write(line + '\n'));
  const g = createGame({ nowMs: 0, storage: null });
  g.newGame(0, o.seed >>> 0);
  const bot = new Bot(g);
  const tr = new Tracker();
  let shadow = null;
  if (o.shadow) {
    bot.flewHook = () => {
      const s = g.s;
      if (s.run.index !== 0 || s.meta.simTime >= 5400) return;
      shadow = runShadow(g.exportString(0), o.dt, 5400);
    };
  }
  const total = o.hours * 3600;
  const n = Math.floor(total / o.dt + 1e-9);
  const t0 = Date.now();
  let nextLog = 3600;
  let stopped = null;
  for (let i = 0; i < n; i++) {
    bot.clicks(o.dt);
    if (g.s.meta.simTime + 1e-9 >= bot.nextThink) {
      bot.nextThink = g.s.meta.simTime + POLICY.thinkSec;
      bot.think();
    }
    let ev;
    try {
      ev = g.tickOnce(o.dt);
    } catch (e) {
      bot.err('tick', e);
      stopped = 'tick error: ' + String((e && e.message) || e);
      break;
    }
    tr.observe(g, ev);
    if (!o.quiet && g.s.meta.simTime >= nextLog) {
      nextLog += 3600;
      log('[sim] ' + fmtTime(g.s.meta.simTime) + '  run ' + g.s.run.index + '  adults ' + Math.round(adultsTotal(g.s))
        + '  fRun ' + g.s.run.fRun.toExponential(2) + '  alatesLife ' + g.s.meta.counters.alatesLife + '  kinshipLife '
        + g.s.era.kinshipLife + '  (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s wall)');
    }
    if (o.until === 'flight' && tr.t.firstFlight !== undefined) { stopped = 'until flight'; break; }
    if (o.until === 'supercolony' && tr.t.firstSuper !== undefined) { stopped = 'until supercolony'; break; }
    if (o.until === 'speciation' && tr.t.firstSpec !== undefined) { stopped = 'until speciation'; break; }
  }
  if (shadow && tr.values.alates90 === undefined) tr.values.alates90 = shadow.alates90;
  return buildReport(g, bot, tr, o, { stopped, wallSec: (Date.now() - t0) / 1000, shadow });
}

/** Keep playing run 1 (no flying) on an imported copy until `untilSec` of simTime; returns the projection then. */
function runShadow(exported, dt, untilSec) {
  const g2 = createGame({ nowMs: 0, storage: null });
  const res = g2.importString(exported, 0);
  if (!res.ok) return { alates90: undefined, error: res.error };
  const b2 = new Bot(g2, { noFly: true });
  while (g2.s.meta.simTime < untilSec - 1e-9) {
    b2.clicks(dt);
    if (g2.s.meta.simTime + 1e-9 >= b2.nextThink) {
      b2.nextThink = g2.s.meta.simTime + POLICY.thinkSec;
      b2.think();
    }
    g2.tickOnce(dt);
  }
  return { alates90: g2.d.meta.proj.alates, errors: b2.errors };
}

/** Evaluate a time window check: pass / fail / skip (not simulated far enough). */
function windowCheck(name, t, lo, hi, simulated) {
  if (t !== undefined) return { name, status: t >= lo - EPS && t <= hi + EPS ? 'pass' : 'fail', value: t, unit: 'time', lo, hi };
  return { name, status: simulated + EPS >= hi ? 'fail' : 'skip', value: null, unit: 'time', lo, hi };
}

/** Build the report object (milestones, gaps, checks). */
function buildReport(g, bot, tr, o, extra) {
  const sim = g.s.meta.simTime;
  const end30 = sim + EPS >= 1800 ? 1800 : sim;
  const gap30 = sim > 0 ? maxGap(tr.unlockTimes, 0, end30) : null;
  const run1End = tr.run1End >= 0 ? tr.run1End : sim;
  const run1Times = tr.run1Activity.concat(bot.purchases.filter((t) => t <= run1End));
  const noBuy = sim > 0 ? maxGap(run1Times, 0, run1End) : null;
  const checks = [
    windowCheck('first worker 15–30 s', tr.t.firstWorker, 15, 30, sim),
    { name: 'no gap > 3 min between unlocks/reveals/event cards in the first 30 min', status: sim + EPS >= 1800 ? (gap30 <= 180 + EPS ? 'pass' : 'fail') : 'skip', value: gap30, unit: 'time' },
    { name: 'no window > 10 min without a purchase or unlock in run 1', status: sim + EPS >= 600 ? (noBuy <= 600 + EPS ? 'pass' : 'fail') : 'skip', value: noBuy, unit: 'time' },
    windowCheck('first conquest 12–35 min', tr.t.firstConquest, 720, 2100, sim),
    windowCheck('Flight available 38–60 min', tr.t.flightAvailable, 2280, 3600, sim),
    { name: '≥ 25 alates projected at 90 min', status: tr.values.alates90 !== undefined ? (tr.values.alates90 >= 25 ? 'pass' : 'fail') : 'skip', value: tr.values.alates90 ?? null, unit: 'count' },
    windowCheck('first Supercolony 4.5–10 h', tr.t.firstSuper, 4.5 * 3600, 10 * 3600, sim),
    windowCheck('first Speciation 24–80 h', tr.t.firstSpec, 24 * 3600, 80 * 3600, sim),
  ];
  if (tr.t.oldRidgeSeen !== undefined) checks.push(windowCheck('Old Ridge beaten inside layer 2 (≤ 10 h)', tr.t.oldRidgeFallen, 0, 10 * 3600, sim));
  if (tr.t.frontSeen !== undefined) checks.push(windowCheck('Argentine Front beaten inside layer 3 (≤ 80 h)', tr.t.frontFallen, 0, 80 * 3600, sim));
  const s = g.s;
  return {
    seed: o.seed, dt: o.dt, hours: o.hours, until: o.until, simulatedSec: sim, wallSec: extra.wallSec, stopped: extra.stopped,
    milestones: MILESTONES.map(([key, label]) => ({ key, label, time: tr.t[key] ?? null, value: tr.values[key] ?? null })),
    alates90: tr.values.alates90 ?? null, shadowUsed: !!extra.shadow,
    maxGapFirst30MinSec: gap30, longestNoPurchaseRun1Sec: noBuy,
    final: { runIndex: s.run.index, adults: adultsTotal(s), fRun: s.run.fRun, alatesLife: s.meta.counters.alatesLife,
      flights: s.meta.counters.flights, kinshipLife: s.era.kinshipLife, supercolonies: s.meta.counters.supercolonies,
      genesLife: s.meta.genesLife, speciations: s.meta.counters.speciations },
    botErrors: bot.errors, botErrorSamples: bot.errorSamples, disabledCommands: [...bot.disabled].sort(),
    checks, ok: checks.every((c) => c.status !== 'fail'),
  };
}

/** Human-readable report. */
export function formatReport(r) {
  const lines = [];
  lines.push('Six Legs Deep pacing bot — seed ' + r.seed + ', dt ' + r.dt + ', ' + fmtTime(r.simulatedSec) + ' simulated in '
    + r.wallSec.toFixed(1) + ' s' + (r.stopped ? ' (' + r.stopped + ')' : ''));
  lines.push('');
  lines.push('Milestone'.padEnd(34) + 'Time'.padStart(10) + '   Value');
  for (const m of r.milestones) lines.push(m.label.padEnd(34) + fmtTime(m.time ?? -1).padStart(10) + (m.value !== null ? '   ' + m.value : ''));
  lines.push('Alates projected at 90 min'.padEnd(34) + String(r.alates90 ?? '—').padStart(10) + (r.shadowUsed ? '   (shadow run 1)' : ''));
  lines.push('Largest unlock gap, first 30 min'.padEnd(34) + fmtTime(r.maxGapFirst30MinSec ?? -1).padStart(10));
  lines.push('Longest no-purchase window, run 1'.padEnd(34) + fmtTime(r.longestNoPurchaseRun1Sec ?? -1).padStart(10));
  lines.push('');
  lines.push('Checks (DESIGN §28.2):');
  for (const c of r.checks) lines.push('  [' + c.status.toUpperCase().padEnd(4) + '] ' + c.name + (c.value !== null && c.value !== undefined ? '  (' + (c.unit === 'time' ? fmtTime(c.value) : c.value) + ')' : ''));
  lines.push('');
  const f = r.final;
  lines.push('Final: run ' + f.runIndex + ', adults ' + Math.round(f.adults) + ', fRun ' + Number(f.fRun).toExponential(2) + ', flights '
    + f.flights + ', alates_life ' + f.alatesLife + ', supercolonies ' + f.supercolonies + ', kinship_life ' + f.kinshipLife
    + ', speciations ' + f.speciations + ', genes_life ' + f.genesLife);
  if (r.disabledCommands.length) lines.push('Commands not registered (skipped): ' + r.disabledCommands.join(', '));
  if (r.botErrors) lines.push('Bot policy errors: ' + r.botErrors + ' — ' + r.botErrorSamples.join(' | '));
  lines.push('Overall: ' + (r.ok ? 'OK' : 'FAIL'));
  return lines.join('\n');
}

/** CLI entry. */
function main(argv) {
  const o = parseArgs(argv);
  const r = simulate({ ...o, quiet: o.quiet || o.json });
  if (o.json) console.log(JSON.stringify(r, null, 2));
  else console.log(formatReport(r));
  return o.strict && !r.ok ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exitCode = main(process.argv.slice(2));
