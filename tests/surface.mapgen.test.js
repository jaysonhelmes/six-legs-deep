// WP4 map generation (ARCHITECTURE §8.3 mapgen.js, DESIGN §8.2 / §8.4 / §8.9 / §13.6): determinism, terrain shares,
// reachability, source counts and placement, landing tags, boons, traits, rival specs, root columns, reveal rings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateMap } from '../src/systems/mapgen.js';
import { TERRAIN, TERRAIN_ORDER, MAP } from '../src/data/surface.js';
import { SOURCES } from '../src/data/sources.js';
import { TRAITS as BLOODLINE } from '../src/data/bloodline.js';
import { RIVALS } from '../src/data/rivals.js';
import { HEX_COUNT, ringOf, neighbors, colForHex } from '../src/core/hex.js';

const SEEDS = [1, 2, 3, 77, 12345, 0xdeadbeef];
const code = (id) => TERRAIN[id].code;
const count = (m, type) => m.sources.filter((s) => s.type === type).length;

/** Flood fill from hex 0 over hexes walkable in every season (no stone, no puddle). */
function reach(terrain) {
  const seen = new Uint8Array(HEX_COUNT);
  const q = [0];
  seen[0] = 1;
  for (let k = 0; k < q.length; k++) {
    for (const n of neighbors(q[k])) {
      if (!seen[n] && terrain[n] !== code('stone') && terrain[n] !== code('puddle')) {
        seen[n] = 1;
        q.push(n);
      }
    }
  }
  return seen;
}

test('deterministic per seed; different seeds give different maps; output is plain JSON', () => {
  const a = generateMap(12345);
  const b = generateMap(12345);
  assert.deepEqual(a, b);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a);
  assert.notDeepEqual(generateMap(1).terrain, generateMap(2).terrain);
  assert.equal(a.terrain.length, HEX_COUNT);
  assert.ok(a.terrain.every((c) => Number.isInteger(c) && c >= 0 && c < TERRAIN_ORDER.length));
});

test('terrain shares are within ±3 % of DESIGN §8.2 over the whole map', () => {
  for (const seed of SEEDS) {
    const m = generateMap(seed);
    for (const id of TERRAIN_ORDER) {
      const share = m.terrain.filter((c) => c === code(id)).length / HEX_COUNT;
      assert.ok(Math.abs(share - TERRAIN[id].share) <= 0.03, `seed ${seed}: ${id} share ${share.toFixed(3)} vs ${TERRAIN[id].share}`);
    }
  }
});

test('rings 0–1 are passable and every source and rival nest is reachable from the entrance in every season', () => {
  for (const seed of SEEDS) {
    const m = generateMap(seed, { tags: ['site_wet_hollow', 'site_aphid_dense'] });
    for (let i = 0; i < 7; i++) assert.ok(m.terrain[i] !== code('stone') && m.terrain[i] !== code('puddle'), `seed ${seed} hex ${i}`);
    const seen = reach(m.terrain);
    for (const s of m.sources) assert.equal(seen[s.hex], 1, `seed ${seed}: ${s.type} at ${s.hex} unreachable`);
    for (const r of m.rivalSpecs) assert.equal(seen[r.hex], 1, `seed ${seed}: rival at ${r.hex} unreachable`);
  }
});

test('fixed sources per DESIGN §8.4: crumb on ring 1, 3 seed patches (ring 2–5), 2 flowers (3–6), 4 leaf plants on leaf litter (2–8), 3 aphid colonies on tree roots (3–7), 1 termite mound (9–12, dormant)', () => {
  for (const seed of SEEDS) {
    const m = generateMap(seed);
    assert.equal(count(m, 'crumb_scatter'), 1);
    assert.equal(ringOf(m.sources.find((s) => s.type === 'crumb_scatter').hex), 1);
    assert.ok(m.sources.some((s) => s.type === 'seed_patch' && ringOf(s.hex) === 2), 'a seed patch 2 hexes out (DESIGN §24.1)');
    const want = { seed_patch: 3, flower_patch: 2, leaf_plant: 4, aphid_colony: 3, termite_mound: 1 };
    for (const [type, n] of Object.entries(want)) assert.equal(count(m, type), n, `seed ${seed} ${type}`);
    for (const s of m.sources) {
      const sp = SOURCES[s.type].spawn;
      const r = ringOf(s.hex);
      assert.ok(r >= sp.rMin && r <= sp.rMax, `${s.type} ring ${r}`);
      if (sp.terrain) assert.equal(m.terrain[s.hex], code(sp.terrain), `${s.type} on ${sp.terrain}`);
      assert.equal(!!s.data.dormant, r > MAP.radiusBase, `${s.type} dormant iff beyond radius 8`);
    }
    assert.equal(new Set(m.sources.map((s) => s.hex)).size, m.sources.length, 'one source per hex');
    assert.ok(!m.sources.some((s) => s.hex === 0));
    assert.deepEqual(m.sources.map((s) => s.uid), m.sources.map((_, i) => i + 1));
    assert.equal(m.nextUid, m.sources.length + 1);
  }
});

test('finite sources on starting rings are sized at base (fresh run, no income); others are unsized until seen (C34)', () => {
  const m = generateMap(3);
  for (const s of m.sources) {
    const def = SOURCES[s.type];
    if (!def.stock) {
      assert.equal(s.stock, -1);
      assert.equal(s.max, -1);
    } else if (ringOf(s.hex) <= m.revealRings) {
      assert.equal(s.max, def.stock.base);
      assert.equal(s.stock, def.stock.base);
      assert.equal(s.data.unsized, undefined);
    } else {
      assert.equal(s.data.unsized, true);
      assert.equal(s.stock, 0);
    }
  }
});

test('landing tags: seed meadow +2 seed patches, aphid dense +2 colonies, hostile neighbours tiers 2/3, garden path ×2, wet hollow puddles ×2', () => {
  let paths = 0;
  let paths2 = 0;
  for (const seed of SEEDS) {
    const base = generateMap(seed);
    assert.equal(count(generateMap(seed, { tags: ['site_seed_meadow'] }), 'seed_patch'), 5);
    assert.equal(count(generateMap(seed, { tags: ['site_aphid_dense'] }), 'aphid_colony'), 5);
    const hostile = generateMap(seed, { tags: ['site_hostile_neighbours'] });
    assert.deepEqual(hostile.rivalSpecs.map((r) => r.tier), [2, 3]);
    const wet = generateMap(seed, { tags: ['site_wet_hollow'] });
    const pud = (m) => m.terrain.filter((c) => c === code('puddle')).length;
    assert.ok(pud(wet) >= 1.8 * pud(base), `puddles ${pud(wet)} vs ${pud(base)}`);
    paths += base.terrain.filter((c) => c === code('garden_path')).length;
    paths2 += generateMap(seed, { tags: ['site_garden_path'] }).terrain.filter((c) => c === code('garden_path')).length;
  }
  assert.ok(paths2 > 1.5 * paths, `garden path hexes ${paths2} vs ${paths}`);
});

test('rival specs: tier 1 at ring 4–5 and tier 2 at ring 6–7, at most 2 at radius 8, on passable free hexes', () => {
  for (const seed of SEEDS) {
    const m = generateMap(seed);
    assert.equal(m.rivalSpecs.length, 2);
    const [a, b] = m.rivalSpecs;
    assert.equal(a.tier, 1);
    assert.equal(b.tier, 2);
    assert.ok(ringOf(a.hex) >= 4 && ringOf(a.hex) <= 5);
    assert.ok(ringOf(b.hex) >= 6 && ringOf(b.hex) <= 7);
    for (const r of m.rivalSpecs) {
      assert.ok(!m.sources.some((s) => s.hex === r.hex));
      if (Object.keys(RIVALS).length) assert.equal(RIVALS[r.type].tier, r.tier);
    }
  }
});

test('boons and traits: next_to_aphids and sweet_inheritance add a ring-2 aphid colony; scouts_lead / keen_antennae reveal rings 3 / 4', () => {
  const m = generateMap(5, { boon: 'boon_next_to_aphids' });
  const aph = m.sources.filter((s) => s.type === 'aphid_colony');
  assert.equal(aph.length, 4);
  assert.ok(aph.some((s) => ringOf(s.hex) === 2 && m.terrain[s.hex] === code('tree_root')));
  assert.equal(generateMap(5).revealRings, 2);
  assert.equal(generateMap(5, { boon: 'boon_scouts_lead' }).revealRings, 3);
  if (BLOODLINE.keen_antennae) {
    assert.equal(generateMap(5, { traits: { keen_antennae: 1 } }).revealRings, BLOODLINE.keen_antennae.fx.reveal);
    assert.equal(generateMap(5, { traits: { keen_antennae: 1 }, boon: 'boon_scouts_lead' }).revealRings, 4);
  }
  if (BLOODLINE.sweet_inheritance) {
    const si = generateMap(5, { traits: { sweet_inheritance: 1 } });
    const lv2 = si.sources.filter((s) => s.type === 'aphid_colony' && s.level === BLOODLINE.sweet_inheritance.fx.aphidLevel);
    assert.equal(lv2.length, 1);
    assert.equal(ringOf(lv2[0].hex), BLOODLINE.sweet_inheritance.fx.ring);
  }
  // bad option types are tolerated
  assert.equal(generateMap(5, { tags: 'nope', traits: null }).sources.length, generateMap(5).sources.length);
});

test('rootCols = unique colForHex of flower patches, leaf plants and aphid colonies within ring 3', () => {
  for (const seed of SEEDS) {
    const m = generateMap(seed, { tags: ['site_aphid_dense'] });
    const want = [];
    for (const s of m.sources) {
      if (!['flower_patch', 'leaf_plant', 'aphid_colony'].includes(s.type) || ringOf(s.hex) > MAP.rootRing) continue;
      const c = colForHex(s.hex);
      if (!want.includes(c)) want.push(c);
    }
    assert.deepEqual(m.rootCols, want);
    assert.ok(m.rootCols.every((c) => c >= 1 && c <= 38));
  }
});

test('generation is fast enough for landing previews (3 maps well under 100 ms each)', () => {
  const t0 = performance.now();
  for (let i = 0; i < 9; i++) generateMap(1000 + i, { tags: ['site_garden_path', 'site_wet_hollow'] });
  const per = (performance.now() - t0) / 9;
  assert.ok(per < 100, `${per.toFixed(1)} ms per map`);
});
