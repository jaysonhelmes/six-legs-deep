// Gameplay-rules regression tests — Mobilize (F1, ARCHITECTURE §18 C73; DESIGN §9.8 "25 % of idle and forager minors
// join as militia for 20 s"): the draft comes from idle minors and foragers only (never diggers, nurses …), and the
// drafted foragers go back to foraging when the 20 s window ends or the battle ends; casualties come out of the draft.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as rivals from '../src/systems/rivals.js';
import * as combat from '../src/systems/combat.js';
import { tick as jobsTick, idleMinors } from '../src/systems/jobs.js';
import { tickEffects } from '../src/core/effects.js';
import { TACTICAL } from '../src/data/combat.js';
import { newState, makeDerived, fakeEnv } from './helpers.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ± ${tol}, got ${a}`);
const { battleAction } = rivals.handlers;

/** 1,000 minors: forager 600, digger 200, nurse 100, idle 100; 10 soldiers; a long, harmless border fight. */
function setup() {
  const s = newState(3);
  const col = s.run.colony;
  col.adults.minor = 1000;
  col.adults.soldier = 10;
  col.jobs.forager = 600;
  col.jobs.digger = 200;
  col.jobs.nurse = 100;
  s.run.unlocked.panel_war = true;
  s.run.res.pheromone = 1000;
  const d = makeDerived({ stats: { foodCap: 1e12, honeydewCap: 1e12, housing: 1e6, pheromoneCap: 1e6 }, rates: { food: { gross: 10 } } });
  // A foe that can neither kill nor be killed within the test: the fight outlasts the 20 s window.
  const uid = combat.startBattle(s, d, { kind: 'border', hex: 0, you: { soldier: 10 }, foe: { n: 1e6, atk: 0, hp: 1e12 } }, null);
  return { s, d, uid };
}

/** effects + rivals (battles) + jobs consistency for `sec` seconds, like step() orders them. */
function run(s, d, sec, dt = 0.1) {
  const n = Math.round(sec / dt);
  for (let i = 0; i < n; i++) {
    const env = fakeEnv({ dt });
    tickEffects(s, dt, env);
    rivals.tick(s, d, dt, env);
    jobsTick(s, d, dt, env);
    s.run.time += dt;
  }
}

function mobilize(s, d, uid) {
  const cmd = { type: 'battleAction', battle: uid, action: 'mobilize' };
  assert.equal(battleAction.validate(s, d, cmd), null);
  battleAction.apply(s, d, cmd, fakeEnv());
}

test('F1: Mobilize drafts 25 % of idle and 25 % of foragers; diggers and nurses keep working', () => {
  const { s, d, uid } = setup();
  mobilize(s, d, uid);
  run(s, d, 1);
  const col = s.run.colony;
  near(col.militia, 0.25 * (100 + 600), 1e-6, 'militia');
  near(col.jobs.forager, 600 - 150, 1e-6, 'foragers drafted');
  near(col.jobs.digger, 200, 1e-6, 'diggers untouched');
  near(col.jobs.nurse, 100, 1e-6, 'nurses untouched');
  near(idleMinors(s), 100 - 25, 1e-6, 'idle drafted');
});

test('F1: when the 20 s window ends, drafted foragers return to foraging and drafted idle minors to idle', () => {
  const { s, d, uid } = setup();
  mobilize(s, d, uid);
  run(s, d, TACTICAL.mobilize.sec + 2);
  const col = s.run.colony;
  assert.ok(s.run.war.battles.some((b) => b.uid === uid), 'the fight is still going on');
  near(col.militia, 0, 1e-9, 'militia released');
  near(col.jobs.forager, 600, 1e-6, 'foragers back');
  near(col.jobs.digger, 200, 1e-6);
  near(col.jobs.nurse, 100, 1e-6);
  near(idleMinors(s), 100, 1e-6, 'nobody left idle who was not idle before');
  // Mobilize can be used again once the window is over, and it drafts the same way.
  mobilize(s, d, uid);
  run(s, d, 1);
  near(col.jobs.forager, 450, 1e-6);
  near(col.jobs.digger, 200, 1e-6);
});

test('F1: a fight that ends inside the window returns the surviving drafted foragers; the dead come out of the draft', () => {
  const { s, d, uid } = setup();
  mobilize(s, d, uid);
  run(s, d, 1);
  const env = fakeEnv();
  battleAction.apply(s, d, { type: 'battleAction', battle: uid, action: 'retreat' }, env);
  const col = s.run.colony;
  const lost = TACTICAL.retreat.loss * 175;               // retreat cost on the militia (no phalanx)
  assert.ok(!s.run.war.battles.some((b) => b.uid === uid), 'battle over');
  near(col.militia, 0, 1e-9);
  near(col.adults.minor, 1000 - lost, 1e-6, 'retreat casualties among the militia');
  near(col.jobs.forager, 600 - 150 * TACTICAL.retreat.loss, 1e-6, 'surviving drafted foragers forage again');
  near(col.jobs.digger, 200, 1e-6, 'diggers never pay for the draft');
  near(col.jobs.nurse, 100, 1e-6, 'nurses never pay for the draft');
  near(idleMinors(s), 100 - 25 * TACTICAL.retreat.loss, 1e-6);
});
