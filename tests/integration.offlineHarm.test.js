// INTEGRATION regression tests (ARCHITECTURE §18 C68; DESIGN §3, §18.1, §21.4): events are frozen offline and
// nothing harmful happens offline. Mold spots neither spread nor halve their chamber offline; harmful timed event
// effects (sealed entrance, flood, drought …) neither apply nor count down offline and are back on return; helpful
// event effects keep running offline as before. Runs the real step() through simulateOffline / game.catchUp.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../src/core/game.js';
import { step } from '../src/core/step.js';
import { simulateOffline } from '../src/core/offline.js';
import { addEffect, effectMult } from '../src/core/effects.js';
import * as events from '../src/systems/events.js';
import { quietWorld, fakeEnv } from './helpers.js';

/** A quiet game with a few dozen workers (mold needs ≥ 50 adults to be eligible, forceEvent ignores that). */
function game(seed = 5) {
  const g = createGame({ nowMs: 0, storage: null });
  g.newGame(0, seed);
  quietWorld(g.s);
  g.runFor(120);
  g.s.run.colony.adults.minor = 60;
  g.s.run.colony.jobs.forager = 60;
  g.runFor(1);
  return g;
}

const molds = (s) => s.run.events.objects.filter((o) => o.kind === 'mold');
const royalEff = (s, d) => d.nest.chambers[s.run.nest.chambers.findIndex((c) => c.uid === 1)].eff;

test('mold bloom offline: no spread, no ×0.5 on the chamber while away; spots, penalty and spread timer resume on return', () => {
  const g = game();
  events.forceEvent(g.s, g.d, 'ev_mold_bloom', fakeEnv());
  const spots = molds(g.s).length;
  assert.ok(spots >= 3);
  assert.ok(molds(g.s).every((o) => o.data.chamber === 1), 'only the Royal Chamber exists');
  g.tickOnce();
  const molded = royalEff(g.s, g.d);
  const proc = g.s.run.events.active.find((a) => a.id === 'ev_mold_bloom');
  const tLeft = proc.t;
  const effIds = g.s.run.effects.filter((e) => e.id.startsWith('mold:')).map((e) => e.id).sort();
  assert.equal(effIds.length, spots);

  const seen = [];
  const watched = (s, d, dt, cmds, opts) => {
    const ev = step(s, d, dt, cmds, opts);
    seen.push(royalEff(s, d));
    return ev;
  };
  simulateOffline(g.s, g.d, 3600, { eff: 1, stepFn: watched });
  assert.ok(seen.length > 10);
  const clean = molded / 0.5 ** spots;
  for (const e of seen) assert.ok(Math.abs(e - clean) < 1e-9 * clean, 'offline the Royal Chamber works unpenalised: ' + e + ' vs ' + clean);
  assert.equal(molds(g.s).length, spots, 'no spread offline');
  assert.equal(g.s.run.events.active.find((a) => a.id === 'ev_mold_bloom').t, tLeft, 'spread timer paused');
  assert.deepEqual(g.s.run.effects.filter((e) => e.id.startsWith('mold:')).map((e) => e.id).sort(), effIds, 'spots kept');

  // Through the real catch-up path (hidden tab and closed tab alike) and back online.
  g.catchUp(2 * 3600, 3 * 3600e3, { hidden: true });
  g.catchUp(2 * 3600, 5 * 3600e3, { hidden: false });
  assert.equal(molds(g.s).length, spots);
  g.tickOnce();
  assert.ok(Math.abs(royalEff(g.s, g.d) - molded) < 1e-9 * molded, 'the penalty is back online');
  g.runFor(tLeft + 1);
  assert.equal(molds(g.s).length, spots + 1, 'spreading resumes online');
});

test('harmful timed event effects neither apply nor count down offline; helpful ones run as before', () => {
  const g = game(6);
  const s = g.s;
  addEffect(s, { id: 'ev_rainstorm_seal', stat: 'surface_work', mult: 0, t: 60 });   // "Seal entrance": no foraging
  addEffect(s, { id: 'ev_queens_vigor', stat: 'lay', mult: 3, t: 60 });              // helpful
  g.tickOnce();
  assert.equal(effectMult(s, 'surface_work'), 0);
  const sealT = s.run.effects.find((e) => e.id === 'ev_rainstorm_seal').t;
  const fRun0 = s.run.fRun;
  simulateOffline(s, g.d, 1800, { eff: 1 });
  assert.ok(s.run.fRun > fRun0 + 1, 'foragers worked offline despite the sealed entrance (' + fRun0 + ' → ' + s.run.fRun + ')');
  const seal = s.run.effects.find((e) => e.id === 'ev_rainstorm_seal');
  assert.ok(seal, 'the seal is still there on return');
  assert.equal(seal.t, sealT, 'and its 60 s have not run down');
  assert.equal(s.run.effects.some((e) => e.id === 'ev_queens_vigor'), false, 'the helpful buff ran its course offline');
  // Online it applies and counts down again.
  g.tickOnce();
  assert.equal(effectMult(s, 'surface_work'), 0);
  assert.ok(s.run.effects.find((e) => e.id === 'ev_rainstorm_seal').t < sealT);
});

test('isHarmfulEffect: event effects by direction; non-event effects never', () => {
  const H = events.isHarmfulEffect;
  assert.equal(H({ id: 'mold:12', stat: 'chamber', mult: 0.5, add: 0 }), true);
  assert.equal(H({ id: 'ev_flood', stat: 'chamber_layer', mult: 0, add: 0 }), true);
  assert.equal(H({ id: 'ev_drought_leaves', stat: 'source_type', mult: 0.5, add: 0 }), true);
  assert.equal(H({ id: 'ev_drought_honeydew', stat: 'honeydew', mult: 1.5, add: 0 }), false);
  assert.equal(H({ id: 'ev_brood_mites', stat: 'brood_time', mult: 1.5, add: 0 }), true);
  assert.equal(H({ id: 'ev_frost_snap', stat: 'frost_snap', mult: 1, add: 4 }), true);
  assert.equal(H({ id: 'ev_rival_mating_flight', stat: 'ap_rival', mult: 0.7, add: 0 }), false);
  assert.equal(H({ id: 'ev_myrmecophile_guest', stat: 'forage_add', mult: 1, add: 0.15 }), false);
  assert.equal(H({ id: 'ev_wandering_queen_parasite', stat: 'lay', mult: 0.5, add: 0 }), true);
  assert.equal(H({ id: 'boon_royal_vigor', stat: 'lay', mult: 0.5, add: 0 }), false, 'not an event effect');
  assert.equal(H(null), false);
});

test('online steps are untouched: harmful event effects apply and tick normally', () => {
  const g = game(7);
  addEffect(g.s, { id: 'ev_ophiocordyceps', stat: 'forage', mult: 0.8, t: 5 });
  g.tickOnce();
  assert.ok(Math.abs(effectMult(g.s, 'forage') - 0.8) < 1e-12);
  g.runFor(6);
  assert.equal(g.s.run.effects.some((e) => e.id === 'ev_ophiocordyceps'), false);
});
