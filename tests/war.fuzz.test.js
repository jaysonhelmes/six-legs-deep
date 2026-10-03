// WP5 fuzz: random war commands (with garbage arguments) and online/offline ticks of rivals + raids from a busy war
// state. The state must stay finite, clamped, plain JSON, and no handler may throw. FUZZ_TICKS overrides the count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as rivals from '../src/systems/rivals.js';
import * as raids from '../src/systems/raids.js';
import { RESEARCH_ORDER } from '../src/data/research.js';
import { hexIndex } from '../src/core/hex.js';
import { makeHolder, chance, randInt, pick } from '../src/core/rng.js';
import { newState, makeDerived, fakeEnv, findBadValues, randomCommand } from './helpers.js';

const TICKS = Number(process.env.FUZZ_TICKS) > 0 ? Math.min(Number(process.env.FUZZ_TICKS), 200000) : 20000;
const TYPES = ['launchParty', 'recallParty', 'reinforce', 'battleAction', 'bribe', 'tournament', 'tournamentChoice', 'dispatchGuard'];
const HANDLERS = { ...rivals.handlers, ...raids.handlers };

/** A busy war: ladder, elder and boss rivals, a big army, prey and a termite mound, escorted trails. */
function busyWorld(seed) {
  const s = newState(seed);
  const run = s.run;
  run.colony.adults = { minor: 5000, soldier: 800, supermajor: 40, replete: 0 };
  run.colony.jobs.forager = 3000;
  run.colony.jobs.nurse = 10;
  run.colony.jobs.scout = 5;
  run.unlocked.panel_war = true;
  for (const id of RESEARCH_ORDER) run.research[id] = 1;
  run.res.pheromone = 1e5;
  run.res.honeydew = 1e9;
  run.res.food = 1e6;
  run.surface.radius = 12;
  s.cycle.traits.budding = 1;
  s.cycle.alatesCycle = 3000;
  s.era.federation.megacolony = 1;
  s.meta.automation.autoGuard = true;
  for (let i = 0; i < 469; i++) run.surface.revealed[i] = 1;
  const d = makeDerived({ stats: { foodCap: 1e7, honeydewCap: 1e9, housing: 1e5, berths: 1e4, pheromoneCap: 1e5 },
    rates: { food: { gross: 50 }, chitin: { gross: 1 } } });
  rivals.spawnInitial(s, d, [{ type: 'black_garden_ants', tier: 1, hex: hexIndex(4, 0) }, { type: 'fire_ants', tier: 5, hex: hexIndex(-5, 2) },
    { tier: 8, hex: hexIndex(0, -7) }, { type: 'slave_makers', tier: 6, hex: hexIndex(3, -6) }]);
  for (const r of run.rivals.list) r.sighted = true;
  run.surface.sources.push({ uid: 60, type: 'prey_beetle', hex: hexIndex(-3, 0), stock: -1, max: -1, level: 1, herdT: 0, age: 0, ttl: 300, cd: 0, data: {} },
    { uid: 61, type: 'termite_mound', hex: hexIndex(0, 9), stock: -1, max: -1, level: 1, herdT: 0, age: 0, ttl: -1, cd: 0, data: {} });
  run.surface.trails.push({ uid: 70, origin: 0, src: 60, path: [0, hexIndex(1, 0), hexIndex(2, 0), hexIndex(3, 0)], len: 3, job: 'forager',
    workers: 200, escorts: 30, S: 40, born: 0, reroutes: [] });
  d.surface.trails.push({ uid: 70, workers: 200, safe: false, out: 5 });
  for (let i = 1; i < 40; i++) d.surface.owned[i] = 1;
  d.surface.ownedCount = 39;
  return { s, d };
}

test(`war fuzz: ${TICKS} ticks of random war commands, raids, battles and offline steps stay finite and plain`, () => {
  const { s, d } = busyWorld(4242);
  const h = makeHolder(99);
  const seasons = ['spring', 'summer', 'autumn', 'winter'];
  let applied = 0;
  let battles = 0;
  let raidsSeen = 0;
  for (let i = 0; i < TICKS; i++) {
    const offline = chance(h, 0.01);
    const dt = offline ? 60 : 0.1;
    const env = fakeEnv({ dt, offline });
    if (!offline && chance(h, 0.05)) {
      const cmd = randomCommand(h, s, TYPES, { pGarbage: 0.1 });
      if (cmd.type === 'battleAction' && s.run.war.battles.length && chance(h, 0.5)) cmd.battle = pick(h, s.run.war.battles).uid;
      if (cmd.type === 'tournamentChoice' && s.run.war.battles.length && chance(h, 0.5)) cmd.uid = pick(h, s.run.war.battles).uid;
      const handler = HANDLERS[cmd.type];
      const reason = handler.validate(s, d, cmd);
      assert.ok(reason === null || typeof reason === 'string', `validate ${cmd.type}`);
      if (reason === null) {
        handler.apply(s, d, cmd, env);
        applied++;
      }
    }
    if (chance(h, 0.002)) d.season.id = pick(h, seasons);
    if (chance(h, 0.003)) for (const r of s.run.rivals.list) r.raidIn = Math.min(r.raidIn, randInt(h, 0, 5));
    if (chance(h, 0.001)) s.run.colony.adults.soldier = Math.max(0, s.run.colony.adults.soldier - randInt(h, 0, 300));
    rivals.tick(s, d, dt, env);
    raids.tick(s, d, dt, env);
    s.run.time += dt;
    battles += env.events.filter((e) => e.type === 'battleEnd').length;
    raidsSeen += env.events.filter((e) => e.type === 'raidWarning').length;
    if (i % 997 === 0 || i === TICKS - 1) {
      assert.deepEqual(findBadValues(s), [], `tick ${i}`);
      assert.equal(JSON.stringify(JSON.parse(JSON.stringify(s))), JSON.stringify(s), `tick ${i}: plain JSON`);
      const g = rivals.garrison(s, d);
      assert.ok(g.soldier >= 0 && g.supermajor >= 0);
      assert.ok(s.run.colony.militia >= 0);
    }
  }
  if (process.env.FUZZ_VERBOSE) console.log(`exercised: ${applied} commands, ${battles} battles, ${raidsSeen} raids`);
  assert.ok(applied > 0 && battles > 0 && raidsSeen > 0, `exercised: ${applied} commands, ${battles} battles, ${raidsSeen} raids`);
});
