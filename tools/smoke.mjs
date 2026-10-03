#!/usr/bin/env node
// Headless play smoke test (integration step, ARCHITECTURE §17): builds the game the way src/main.js does, minus the
// DOM (createGame with storage null, loadOrNew, the beforePrestige hook, frame-sized game.advance calls), then plays
// ~40 simulated minutes like a player through game.actions only, acting on revealed features (unlocks.isRevealed) and
// the systems' [q] queries. Fails (exit 1) on any exception, console error, NaN guard repair, non-finite or
// non-JSON value in the state, stalled growth, or too small a colony. Owner: integration.
// Usage: node tools/smoke.mjs [--minutes 40] [--seed 1] [--quiet] [--export <file>]
//   --export writes the end-of-play save string (Settings → Import in the browser loads it: a quick mid-game save).

import { writeFileSync } from 'node:fs';
import { createGame } from '../src/core/game.js';
import { step } from '../src/core/step.js';
import { createDerived } from '../src/core/derived.js';
import { adultsTotal, broodTotal } from '../src/core/state.js';
import { canAfford } from '../src/core/wallet.js';
import { countInRadius, neighbors } from '../src/core/hex.js';
import * as nest from '../src/systems/nest.js';
import * as trails from '../src/systems/trails.js';
import * as surface from '../src/systems/surface.js';
import * as research from '../src/systems/research.js';
import * as adaptations from '../src/systems/adaptations.js';
import * as rivals from '../src/systems/rivals.js';
import * as unlocks from '../src/systems/unlocks.js';
import { RESEARCH_ORDER } from '../src/data/research.js';
import { ADAPTATION_ORDER } from '../src/data/adaptations.js';
import { UNLOCKS } from '../src/data/unlocks.js';
import { EVENTS } from '../src/data/events.js';

// ------------------------------------------------------------------------------------------------------------------
// Arguments and the frame model
// ------------------------------------------------------------------------------------------------------------------

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? Number(argv[i + 1]) : dflt;
};
const MINUTES = arg('--minutes', 40) > 0 ? arg('--minutes', 40) : 40;
const SEED = Number.isFinite(arg('--seed', 1)) ? arg('--seed', 1) : 1;
const QUIET = argv.includes('--quiet');
const EXPORT_PATH = (() => {
  const i = argv.indexOf('--export');
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
})();

/** Frame lengths (s) cycled like an uneven browser frame rate; several frames carry 2–3 ticks. */
const FRAMES = [1 / 60, 1 / 30, 0.05, 0.1, 0.25, 1 / 60, 0.05];
const T0_MS = 1_700_000_000_000;

// ------------------------------------------------------------------------------------------------------------------
// Failure bookkeeping (console.error is where the bus and guard report caught exceptions)
// ------------------------------------------------------------------------------------------------------------------

const failures = [];
const warnings = [];
const fail = (msg) => { if (failures.length < 50) failures.push(msg); };
const consoleErrors = [];
const origError = console.error;
console.error = (...a) => {
  consoleErrors.push(a.map((x) => (x && x.stack) || String(x)).join(' '));
  origError.apply(console, a);
};

/** Walk the state: every number finite and within [−1e295, 1e295], no undefined, no non-plain objects. */
function checkState(s, where) {
  const bad = [];
  const walk = (v, path) => {
    if (bad.length > 5) return;
    if (v === null) return;
    const t = typeof v;
    if (t === 'number') {
      if (!Number.isFinite(v) || Math.abs(v) > 1e295 || Object.is(v, -0)) bad.push(path + '=' + v);
      return;
    }
    if (t === 'string' || t === 'boolean') return;
    if (t === 'undefined' || t === 'function' || t === 'symbol' || t === 'bigint') { bad.push(path + ' is ' + t); return; }
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) walk(v[i], path + '[' + i + ']'); return; }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) { bad.push(path + ' is not a plain object'); return; }
    for (const k of Object.keys(v)) walk(v[k], path + '.' + k);
  };
  walk(s, 's');
  if (bad.length) fail(where + ': bad state values: ' + bad.join(', '));
  const json = JSON.stringify(s);
  if (JSON.stringify(JSON.parse(json)) !== json) fail(where + ': state is not JSON-stable');
}

/** State paths a derive pass may legitimately advance: unlock/reveal bookkeeping (conditions met right now) and the
 *  scout target (re-picked from the rebuilt frontier; work is 0 so nothing is revealed). */
const DERIVE_MAY_CHANGE = ['s.meta.tick', 's.meta.seen', 's.meta.reveal', 's.run.unlocked', 's.run.surface.scout.target'];

/**
 * A dt = 0 derive pass on a fresh d (what load, import and catch-up do) must not change the simulation state
 * (ARCHITECTURE §7.2: every system accepts dt = 0), apart from DERIVE_MAY_CHANGE. Runs on a deep copy.
 */
function checkDerivePass(s, where) {
  const copy = JSON.parse(JSON.stringify(s));
  const before = JSON.parse(JSON.stringify(s));
  step(copy, createDerived(), 0, [], {});
  const diffs = [];
  const walk = (a, b, p) => {
    if (diffs.length >= 5 || DERIVE_MAY_CHANGE.some((x) => p === x || p.startsWith(x + '.'))) return;
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], p + '.' + k);
    } else if (a !== b) diffs.push(p + ': ' + JSON.stringify(a) + ' → ' + JSON.stringify(b));
  };
  walk(before, copy, 's');
  if (diffs.length) fail(where + ': a dt = 0 derive pass changed the state: ' + diffs.join('; '));
}

// ------------------------------------------------------------------------------------------------------------------
// Boot (src/main.js without the DOM)
// ------------------------------------------------------------------------------------------------------------------

let nowMs = T0_MS;
const game = createGame({ nowMs, storage: null });
const loaded = game.loadOrNew(nowMs);            // storage null → a new game, like a first visit
game.hooks.beforePrestige = () => game.save(nowMs);
if (loaded.loaded || loaded.error) fail('loadOrNew without storage should start a new game: ' + JSON.stringify(loaded));
// A fixed seed for reproducibility (main.js lets newGame derive it from the wall clock).
game.newGame(nowMs, SEED);

const counts = Object.create(null);    // event counts by type
const rejected = Object.create(null);  // rejection reasons by command type
const accepted = Object.create(null);  // accepted commands by type
const activated = Object.create(null); // chambers completed by type
const unlockLog = [];
game.bus.on('*', (e) => {
  counts[e.type] = (counts[e.type] || 0) + 1;
  if (e.type === 'nanGuard') fail('nanGuard repair at ' + e.path);
  if (e.type === 'commandRejected' && typeof e.reason === 'string' && e.reason.startsWith('invalid:exception')) {
    fail('handler exception for ' + (e.cmd && e.cmd.type) + ': ' + (e.detail || e.reason));
  }
  if (e.type === 'chamberActivated') activated[e.chamberType] = (activated[e.chamberType] || 0) + 1;
  if (e.type === 'unlock') unlockLog.push([game.s.run.time, e.key]);
});

/** Player action through game.actions (validated now, applied at the next tick). */
function act(type, args = {}) {
  let r;
  try {
    r = game.actions.do(type, args);
  } catch (err) {
    fail('actions.do(' + type + ') threw: ' + ((err && err.stack) || err));
    return false;
  }
  if (r.ok) accepted[type] = (accepted[type] || 0) + 1;
  else {
    const m = (rejected[type] = rejected[type] || Object.create(null));
    m[r.reason] = (m[r.reason] || 0) + 1;
  }
  return r.ok;
}

/** [q] query; an exception is a failure (queries must never throw on a live state). */
function q(name, fn, ...a) {
  try {
    return fn(...a);
  } catch (err) {
    fail('query ' + name + ' threw: ' + ((err && err.stack) || err));
    return null;
  }
}

// ------------------------------------------------------------------------------------------------------------------
// The player
// ------------------------------------------------------------------------------------------------------------------

let rv = Object.create(null);   // revealed keys this decision
let lastJobsAt = -1e9;

function revealed() {
  const out = Object.create(null);
  for (const def of UNLOCKS) if (unlocks.isRevealed(game.s, def.key)) out[def.key] = true;
  return out;
}

function clicks(dt, state) {
  const s = game.s;
  const rate = s.run.time < 600 ? 4 : 1;   // eager early clicking, then casual
  state.acc += rate * dt;
  const crumb = s.run.surface.sources.find((x) => x && x.type === 'crumb_scatter');
  while (state.acc >= 1) {
    state.acc -= 1;
    if (crumb) act('clickForage', { src: crumb.uid });
  }
  if (s.run.golden.beetle) act('clickBeetle', {});
  if (s.run.golden.pupa) act('clickPupa', { choice: 'windfall' });
  if (s.run.golden.gifts.length) act('openGift', { index: 0 });
}

function eventCard() {
  const card = game.s.run.events.card;
  if (!card) return;
  const def = EVENTS[card.id] && Array.isArray(EVENTS[card.id].choices) ? EVENTS[card.id].choices.find((c) => c.def) : null;
  const choice = def ? def.id : Array.isArray(card.choices) && card.choices.length ? card.choices[0] : null;
  if (choice) act('eventChoice', { uid: card.uid, choice });
}

function jobsPolicy() {
  const { s, d } = game;
  if (s.run.time - lastJobsAt < 5) return;
  lastJobsAt = s.run.time;
  const c = s.run.colony;
  const m = Math.max(0, Math.floor(c.adults.minor - c.militia));
  if (m <= 0) return;
  const r = { forager: 0.6, digger: rv.job_digger ? 0.2 : 0, nurse: rv.panel_colony ? 0.1 : 0, scout: rv.job_scout ? 0.1 : 0 };
  if (rv.job_digger && s.run.nest.queue.length > 2) { r.digger += 0.1; r.forager -= 0.1; }
  if (!(d.surface && Array.isArray(d.surface.frontier) && d.surface.frontier.length)) { r.forager += r.scout; r.scout = 0; }
  const jobs = { forager: 0, digger: Math.floor(m * r.digger), nurse: Math.min(Math.floor(m * r.nurse), Math.floor(4 * (d.stats.broodSlots || 0))),
    scout: Math.floor(m * r.scout), herder: 0, leafcutter: 0, gardener: 0 };
  jobs.forager = m - jobs.digger - jobs.nurse - jobs.scout;
  if (Object.keys(jobs).some((k) => Math.abs((c.jobs[k] || 0) - jobs[k]) >= Math.max(1, 0.03 * m))) act('setJobs', { jobs });
}

/** Place a chamber at the advisor's spot, else level the cheapest active one that can grow. */
function grow(type, { placeOnly = false } = {}) {
  const { s, d } = game;
  if (s.run.nest.queue.length >= 3) return false;
  const pc = q('placementCost', nest.placementCost, s, type);
  if (pc && canAfford(s, pc)) {
    const spot = q('findPlacement', nest.findPlacement, s, d, type);
    if (spot && act('placeChamber', { chamber: type, x: spot.x, y: spot.y })) return true;
  }
  if (placeOnly) return false;
  for (const ch of s.run.nest.chambers) {
    if (!ch || ch.type !== type || ch.status !== 'active') continue;
    const info = q('levelInfo', nest.levelInfo, s, d, ch.uid);
    if (!info || !info.cost || info.max || info.blocked || !canAfford(s, info.cost)) continue;
    // No direction: the engine picks the first valid one that leaves the Royal Chamber room to reach the Flight level.
    if (act('levelChamber', { uid: ch.uid })) return true;
  }
  return false;
}

function buildPolicy() {
  const { s, d } = game;
  const st = d.stats;
  const c = s.run.colony;
  const brood = broodTotal(s);
  if (rv.chamber_gallery && st.housing - (c.adults.minor + brood) < Math.max(3, 0.15 * st.housing) && grow('gallery')) return;
  if (rv.chamber_nursery && brood >= 0.9 * st.broodSlots && grow('nursery')) return;
  if (rv.chamber_granary && s.run.res.food >= 0.85 * st.foodCap && grow('granary')) return;
  if (rv.chamber_scent_library && !s.run.nest.chambers.some((x) => x && x.type === 'scent_library') && grow('scent_library', { placeOnly: true })) return;
  if (rv.chamber_barracks && c.casteTargets.soldier > 0 && c.adults.soldier + c.adults.supermajor + 1 >= st.berths && grow('barracks')) return;
  if (rv.royal_levelup) {
    const royal = s.run.nest.chambers.find((x) => x && x.uid === 1);
    if (royal && royal.status === 'active' && grow('royal_chamber')) return;
  }
  if (rv.mound) {
    const mc = q('moundCost', surface.moundCost, s);
    if (mc && s.run.res.soil >= 2 * (mc.soil || 0) && canAfford(s, mc)) act('buyMound', {});
  }
}

function researchPolicy() {
  const s = game.s;
  if (!rv.panel_research) return;
  // A player who wants to fight saves for Polymorphism (soldiers, War panel) as soon as it is on offer.
  if (q('research.isAvailable', research.isAvailable, s, 'polymorphism')) {
    if (canAfford(s, research.cost(s, 'polymorphism'))) act('buyResearch', { id: 'polymorphism' });
    return;
  }
  let best = null;
  let bestC = Infinity;
  for (const id of RESEARCH_ORDER) {
    if (!q('research.isAvailable', research.isAvailable, s, id)) continue;
    const c = q('research.cost', research.cost, s, id);
    if (c && c.insight < bestC) { bestC = c.insight; best = id; }
  }
  if (best && canAfford(s, research.cost(s, best))) act('buyResearch', { id: best });
}

function adaptPolicy() {
  const { s, d } = game;
  if (!rv.panel_colony) return;
  let best = null;
  let bestF = Infinity;
  for (const id of ADAPTATION_ORDER) {
    if (!q('adaptations.isAvailable', adaptations.isAvailable, s, id)) continue;
    const c = q('adaptations.cost', adaptations.cost, s, id, 1);
    if (c && canAfford(s, c) && (c.food || 0) < bestF) { bestF = c.food || 0; best = id; }
  }
  const budget = Math.max(30 * (d.rates.food.gross || 0), 0.5 * s.run.res.food);
  if (best && bestF <= budget) act('buyAdaptation', { id: best, n: 1 });
}

function trailPolicy() {
  const { s, d } = game;
  const wantChitin = rv.caste_soldier && s.run.res.chitin < 20;
  const hasInsectTrail = () => s.run.surface.trails.some((t) => {
    const x = s.run.surface.sources.find((o) => o && o.uid === t.src);
    return x && x.type === 'dead_insect';
  });
  if (!(d.surface.slotsUsed < d.surface.slots)) {
    // Slots full but soldiers need chitin: drop the weakest trail (never the crumb) to make room for a dead insect.
    if (!wantChitin || hasInsectTrail()) return;
    const insects = (q('bestTargets', trails.bestTargets, s, d, 'forager') || []).filter((t) => {
      const x = s.run.surface.sources.find((o) => o && o.uid === t.src);
      return x && x.type === 'dead_insect';
    });
    if (!insects.length) return;
    const crumb = s.run.surface.sources.find((x) => x && x.type === 'crumb_scatter');
    const weakest = d.surface.trails.filter((e) => e && (!crumb || s.run.surface.trails.find((t) => t.uid === e.uid && t.src !== crumb.uid)))
      .sort((a, b) => (a.workers || 0) - (b.workers || 0))[0];
    if (weakest) act('deleteTrail', { uid: weakest.uid });
    return;
  }
  const list = q('bestTargets', trails.bestTargets, s, d, 'forager');
  const origins = q('trailOrigins', trails.trailOrigins, s, d);
  if (!Array.isArray(list) || !list.length) return;
  const origin = Array.isArray(origins) && origins.length ? origins[0] : 0;
  // Soldier eggs need chitin: once soldiers are on offer, a dead insect goes first.
  const typeOf = (uid) => { const x = s.run.surface.sources.find((o) => o && o.uid === uid); return x ? x.type : null; };
  const order = rv.caste_soldier && s.run.res.chitin < 20
    ? list.filter((t) => typeOf(t.src) === 'dead_insect').concat(list.filter((t) => typeOf(t.src) !== 'dead_insect'))
    : list;
  for (const t of order.slice(0, 3)) if (act('drawTrail', { origin, target: t.hex })) return;
}

function claimPolicy() {
  const { s, d } = game;
  if (!rv.hex_claim || s.run.surface.channel) return;
  const cost = q('claimCost', surface.claimCost, s);
  if (!cost || !canAfford(s, cost)) return;
  const n = countInRadius(s.run.surface.radius);
  for (let h = 0; h < n; h++) {
    if (!(d.surface.owned[h] > 0)) continue;
    for (const nb of neighbors(h)) {
      if (nb < n && !(d.surface.owned[nb] > 0) && s.run.surface.revealed[nb] && q('canClaim', surface.canClaim, s, d, nb) === null) {
        act('claimHex', { hex: nb });
        return;
      }
    }
  }
}

const war = { raids: 0, wins: 0, previews: 0 };
function military() {
  const { s, d } = game;
  const c = s.run.colony;
  if (rv.caste_soldier && c.casteTargets.soldier !== 0.15) act('setCasteTargets', { soldier: 0.15, supermajor: 0, replete: 0 });
  if (!rv.panel_war || s.run.war.parties.length) return;
  const g = q('garrison', rivals.garrison, s, d) || { soldier: 0, supermajor: 0 };
  const army = { soldier: Math.floor(g.soldier), supermajor: Math.floor(g.supermajor) };
  if (army.soldier + army.supermajor <= 0) return;
  for (const r of s.run.rivals.list) {
    if (!r || !r.alive || !r.sighted) continue;
    const p = q('previewAction', rivals.previewAction, s, d, 'raid', r.uid, army);
    if (!p) continue;
    war.previews++;
    for (const k of ['win', 'youAP', 'foeAP']) if (!Number.isFinite(p[k])) fail('previewAction ' + k + ' not finite: ' + p[k]);
    if (p.ok && p.foeAP > 0 && p.youAP >= 1.35 * p.foeAP && act('launchParty', { kind: 'raid', target: { type: 'rival', uid: r.uid }, ...army })) {
      war.raids++;
      return;
    }
  }
}

function think() {
  rv = revealed();
  eventCard();
  jobsPolicy();
  researchPolicy();
  buildPolicy();
  adaptPolicy();
  trailPolicy();
  claimPolicy();
  military();
}

// ------------------------------------------------------------------------------------------------------------------
// Play
// ------------------------------------------------------------------------------------------------------------------

const t0 = Date.now();
const clickState = { acc: 0 };
const samples = [];   // per-minute { t, food, fRun, adults, insight, soil }
let nextThink = 0;
let nextMinute = 0;
let frame = 0;
game.bus.on('battleEnd', (e) => { if (e.win && e.kind === 'raid') war.wins++; });

const endSec = MINUTES * 60;
while (game.s.run.time < endSec - 1e-9) {
  const dt = FRAMES[frame++ % FRAMES.length];
  if (game.s.run.time >= nextThink) {
    nextThink += 1;
    try {
      think();
    } catch (err) {
      fail('policy threw at ' + game.s.run.time.toFixed(1) + ' s: ' + ((err && err.stack) || err));
    }
  }
  clicks(dt, clickState);
  nowMs += dt * 1000;
  try {
    game.advance(dt, nowMs);
  } catch (err) {
    fail('game.advance threw at ' + game.s.run.time.toFixed(1) + ' s: ' + ((err && err.stack) || err));
    break;
  }
  if (game.s.run.time >= nextMinute) {
    nextMinute += 60;
    const s = game.s;
    samples.push({ t: Math.round(s.run.time), food: s.run.res.food, fRun: s.run.fRun, adults: adultsTotal(s),
      insight: s.run.res.insight, soil: s.run.res.soil, chambers: s.run.nest.chambers.length });
    checkState(s, 'minute ' + Math.round(s.run.time / 60));
    checkDerivePass(s, 'minute ' + Math.round(s.run.time / 60));
  }
  if (failures.length >= 20) break;
}
const playMs = Date.now() - t0;

// ------------------------------------------------------------------------------------------------------------------
// Persistence and offline paths (save codec, export → import, a 1 h hidden-tab catch-up)
// ------------------------------------------------------------------------------------------------------------------

const s1 = game.s;
const end = { t: s1.run.time, food: s1.run.res.food, fRun: s1.run.fRun, adults: adultsTotal(s1), chambers: s1.run.nest.chambers.length,
  research: Object.keys(s1.run.research).length, trails: s1.run.surface.trails.length, insight: s1.run.res.insight };
let exportOk = false;
try {
  const str = game.exportString(nowMs);
  if (EXPORT_PATH) writeFileSync(EXPORT_PATH, str);
  const before = JSON.stringify(game.s.run);
  const r = game.importString(str, nowMs);
  exportOk = r.ok && JSON.stringify(game.s.run) === before;   // import = decode + a dt = 0 derive pass
  if (!exportOk) fail('export → import round trip changed the run (' + JSON.stringify(r) + ')');
} catch (err) {
  fail('export/import threw: ' + ((err && err.stack) || err));
}
let offline = null;
try {
  const fBefore = game.s.run.fRun;
  nowMs += 3600 * 1000;
  game.advance(3600, nowMs);   // a hidden hour arrives as one large frame → catchUp
  offline = { fRunGain: game.s.run.fRun - fBefore, adults: adultsTotal(game.s) };
  checkState(game.s, 'after 1 h catch-up');
  if (!(offline.fRunGain > 0)) fail('no production during the 1 h catch-up');
  for (let i = 0; i < 50; i++) { nowMs += 100; game.advance(0.1, nowMs); }   // and play on
  checkState(game.s, 'after catch-up ticks');
} catch (err) {
  fail('catch-up threw: ' + ((err && err.stack) || err));
}

// ------------------------------------------------------------------------------------------------------------------
// Verdict
// ------------------------------------------------------------------------------------------------------------------

if (consoleErrors.length) fail(consoleErrors.length + ' console.error call(s); first: ' + consoleErrors[0].slice(0, 400));
if (!(end.adults > 50)) fail('adults ' + end.adults.toFixed(1) + ' ≤ 50 after ' + MINUTES + ' min');
for (let i = 10; i < samples.length; i += 10) {
  if (!(samples[i].fRun > samples[i - 10].fRun)) fail('f_run did not grow between minute ' + (i - 10) + ' and ' + i);
}
if (!(end.fRun > 1e3)) fail('f_run only ' + end.fRun);
for (const type of ['clickForage', 'placeChamber', 'setJobs', 'drawTrail', 'buyResearch', 'buyAdaptation']) {
  if (!accepted[type]) fail('never managed to ' + type);
}
for (const type of ['gallery', 'nursery', 'granary']) if (!activated[type]) fail('no ' + type + ' was completed');
if (!(counts.hatched > 0)) fail('nothing hatched');
if (!war.raids) warnings.push('no raid launched (never ≥ 1.35× a sighted rival; ' + war.previews + ' previews)');

const fmt = (x) => (Math.abs(x) >= 1e4 ? x.toExponential(2) : (Math.round(x * 10) / 10).toString());
const report = {
  ok: failures.length === 0,
  seed: SEED,
  minutes: MINUTES,
  wallMs: playMs,
  end: Object.fromEntries(Object.entries(end).map(([k, v]) => [k, typeof v === 'number' ? Number(fmt(v)) || v : v])),
  chambersCompleted: activated,
  accepted,
  rejected,
  war,
  offline,
  unlocks: unlockLog.map(([t, k]) => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0') + ' ' + k),
  events: counts,
  failures,
  warnings,
};

if (!QUIET) {
  console.log('Six Legs Deep headless smoke test: seed ' + SEED + ', ' + MINUTES + ' simulated minutes (' + (playMs / 1000).toFixed(1) + ' s wall)');
  console.log('minute  food        f_run       adults   insight   soil      chambers');
  for (const x of samples.filter((_, i) => i % 5 === 0 || i === samples.length - 1)) {
    console.log(String(Math.round(x.t / 60)).padStart(6) + '  ' + fmt(x.food).padEnd(10) + '  ' + fmt(x.fRun).padEnd(10) + '  ' +
      fmt(x.adults).padEnd(7) + '  ' + fmt(x.insight).padEnd(8) + '  ' + fmt(x.soil).padEnd(8) + '  ' + x.chambers);
  }
  console.log('chambers completed: ' + JSON.stringify(activated));
  console.log('commands accepted:  ' + JSON.stringify(accepted));
  console.log('war: ' + JSON.stringify(war) + (offline ? '   1 h catch-up: +' + fmt(offline.fRunGain) + ' f_run' : ''));
  console.log('unlocks: ' + report.unlocks.join(', '));
  for (const w of warnings) console.log('WARN  ' + w);
  for (const f of failures) console.log('FAIL  ' + f);
  console.log(report.ok ? 'SMOKE OK' : 'SMOKE FAILED (' + failures.length + ')');
} else {
  console.log(JSON.stringify(report));
}
process.exitCode = report.ok ? 0 : 1;
