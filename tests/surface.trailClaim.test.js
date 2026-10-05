// C162 (player report): "I can't permanently claim hexes that have been temporarily claimed by a trail." Hexes held
// only by a trail (Trunk Trails, d.surface.owned code 4) can be claimed for good at the normal cost and stay owned
// once the trail is deleted; trail-held land counts as owned for the adjacency rule. Owner: WP4 (ARCHITECTURE §18 C162).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as surface from '../src/systems/surface.js';
import { RESEARCH } from '../src/data/research.js';
import { hexIndex } from '../src/core/hex.js';
import { newState, makeDerived, fakeEnv } from './helpers.js';

const H = surface.handlers;

function run(s, d, cmd) {
  const env = fakeEnv();
  const reason = H[cmd.type].validate(s, d, cmd);
  if (reason === null) H[cmd.type].apply(s, d, cmd, env);
  return { reason, events: env.events };
}

/** A trail from the main entrance straight out to (4, 0) with Trunk Trails owned: (2..4, 0) are trail-held. */
function world() {
  const s = newState(1);
  const d = makeDerived({ stats: { pheromoneCap: 1000 } });
  const S = s.run.surface;
  const path = [0, hexIndex(1, 0), hexIndex(2, 0), hexIndex(3, 0), hexIndex(4, 0)];
  for (const h of path) S.revealed[h] = 1;
  for (const h of [hexIndex(3, 1), hexIndex(4, -1), hexIndex(5, -1)]) S.revealed[h] = 1;
  S.sources.push({ uid: 60, type: 'seed_patch', hex: hexIndex(4, 0), stock: 1, max: 1, level: 1, herdT: 0, age: 0, ttl: -1, cd: 0, data: {} });
  S.trails.push({ uid: 61, origin: 0, src: 60, path, len: 4, job: 'forager', workers: 0, escorts: 0, S: 0, born: 0, reroutes: [] });
  s.run.research.trunk_trails = 1;
  s.run.unlocked.hex_claim = true;
  S.rev++;
  surface.derive(s, d);
  return { s, d, path };
}

const skip = !RESEARCH.trunk_trails && 'needs research data';

test('C162: a trail-held hex (owned 4) can be claimed for good at the normal claim cost', { skip }, () => {
  const { s, d } = world();
  const h = hexIndex(3, 0);
  assert.equal(d.surface.owned[h], surface.OWN_TRAIL, 'held by the trail');
  assert.equal(surface.canClaim(s, d, h), null, 'claimable, not "already owned"');
  s.run.res.pheromone = 100;
  const cost = surface.claimCost(s).pheromone;
  const r = run(s, d, { type: 'claimHex', hex: h });
  assert.equal(r.reason, null);
  assert.equal(s.run.surface.claimed[h], 1);
  assert.equal(s.run.surface.claims, 1);
  assert.ok(Math.abs(s.run.res.pheromone - (100 - cost)) < 1e-9, 'paid the normal claim cost');
  surface.derive(s, d);
  assert.equal(d.surface.owned[h], 2, 'now claimed land (code 2)');
  assert.equal(surface.canClaim(s, d, h), 'invalid:owned', 'a claimed hex cannot be claimed twice');
  // permanent land stays permanent: auto land is still refused
  assert.equal(surface.canClaim(s, d, hexIndex(1, 0)), 'invalid:owned');
});

test('C162: a claimed trail hex stays owned when the trail is deleted; the unclaimed trail hexes are lost', { skip }, () => {
  const { s, d } = world();
  const h = hexIndex(3, 0);
  s.run.res.pheromone = 100;
  assert.equal(run(s, d, { type: 'claimHex', hex: h }).reason, null);
  surface.derive(s, d);
  const count = d.surface.ownedCount;
  s.run.surface.trails.length = 0;
  s.run.surface.rev++;
  surface.derive(s, d);
  assert.equal(d.surface.owned[h], 2, 'still owned without the trail');
  assert.equal(d.surface.owned[hexIndex(2, 0)], 0, 'trail-held, unclaimed: lost with the trail');
  assert.equal(d.surface.owned[hexIndex(4, 0)], 0);
  assert.equal(d.surface.ownedCount, count - 2);
});

test('C162: trail-held land counts as owned for the claim adjacency rule', { skip }, () => {
  const { s, d } = world();
  // (5, -1) touches only the trail end (4, 0) (trail-held) — nothing permanent nearby
  const h = hexIndex(5, -1);
  assert.equal(d.surface.owned[h], 0);
  assert.equal(surface.canClaim(s, d, h), null);
  s.run.research.trunk_trails = 0;
  surface.derive(s, d);
  assert.equal(surface.canClaim(s, d, h), 'invalid:adjacent', 'without the trail-held land it is not adjacent');
});

test('C162: an unaffordable claim on a trail-held hex opens a channel that completes', { skip }, () => {
  const { s, d } = world();
  const h = hexIndex(4, 0);
  s.run.res.pheromone = 2;
  assert.equal(run(s, d, { type: 'claimHex', hex: h }).reason, null);
  assert.ok(s.run.surface.channel && s.run.surface.channel.hex === h);
  s.run.res.pheromone = 50;
  surface.tick(s, d, 0.1, fakeEnv());
  assert.equal(s.run.surface.channel, null);
  assert.equal(s.run.surface.claimed[h], 1);
});
