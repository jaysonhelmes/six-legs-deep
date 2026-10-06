// WP3 nest generation tests (ARCHITECTURE §8.2 nestgen, DESIGN §7.9): deterministic per seed, feature counts and
// rows, never overlapping the shaft, the Royal Chamber or each other, site tags, extra Royal Chambers (fire ants).
import test from 'node:test';
import assert from 'node:assert/strict';
import { CELL, GRID } from '../src/data/balance.js';
import { ROOTS, STONES, CACHES, WATER } from '../src/data/soilFeatures.js';
import { LAYERS } from '../src/data/strata.js';
import { defaultNestCells, createRun } from '../src/core/state.js';
import { generateNest } from '../src/systems/nestgen.js';
import { idx, xy, bfs } from '../src/systems/nestgeom.js';

/** C181: stones as 8-connected components of STONE cells (the generator keeps a 1-cell margin between boulders). */
export function stoneGroups(cells) {
  const seen = new Uint8Array(cells.length);
  const out = [];
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] !== CELL.STONE || seen[i]) continue;
    const g = [];
    const st = [i];
    seen[i] = 1;
    while (st.length) {
      const c = st.pop();
      g.push(c);
      const [x, y] = xy(c);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= GRID.cols || yy >= GRID.rows) continue;
        const k = idx(xx, yy);
        if (!seen[k] && cells[k] === CELL.STONE) { seen[k] = 1; st.push(k); }
      }
    }
    out.push(g);
  }
  return out;
}

function featureCells(nest) {
  const map = new Map(); // cell → owner tag
  const add = (c, tag) => {
    if (map.has(c)) throw new Error('overlap at ' + xy(c) + ': ' + map.get(c) + ' vs ' + tag);
    map.set(c, tag);
  };
  for (const r of nest.features.roots) for (let y = r.y0; y <= r.y1; y++) add(idx(r.col, y), 'root' + r.col);
  nest.features.water.forEach((w, k) => {
    for (let y = w.y; y < w.y + w.h; y++) for (let x = w.x; x < w.x + w.w; x++) add(idx(x, y), 'water' + k);
  });
  for (const c of nest.features.caches) add(c.i, 'cache');
  for (let i = 0; i < nest.cells.length; i++) if (nest.cells[i] === CELL.STONE) add(i, 'stone');
  return map;
}

test('generateNest is deterministic per seed and options, and differs across seeds', () => {
  const a = generateNest(12345, { tags: [], rootCols: [10, 25] });
  const b = generateNest(12345, { tags: [], rootCols: [10, 25] });
  assert.deepEqual(a, b);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a, 'plain JSON');
  const c = generateNest(54321, { tags: [], rootCols: [10, 25] });
  assert.notDeepEqual(a.cells, c.cells);
});

test('generated nest keeps the default skeleton (shaft, Royal Chamber, main shaft record, ids)', () => {
  const n = generateNest(7);
  const def = defaultNestCells();
  for (let y = 0; y < GRID.shaftRows; y++) assert.equal(n.cells[idx(GRID.mainCol, y)], CELL.TUNNEL);
  for (let i = 0; i < def.length; i++) if (def[i] !== CELL.SOIL) assert.equal(n.cells[i], def[i]);
  const skel = createRun(7).nest;
  assert.deepEqual(n.chambers, skel.chambers);
  assert.deepEqual(n.shafts, skel.shafts);
  assert.equal(n.nextUid, 2);
  assert.equal(n.rev, 1);
  assert.deepEqual(n.queue, []);
  assert.deepEqual(n.backfill, []);
  assert.equal(n.deepestRow, 21);
  assert.equal(n.maint, 0);
});

test('feature counts, rows and no overlaps across 60 seeds', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const n = generateNest(seed * 7919, { rootCols: [3, 20, 35] });
    const owners = featureCells(n); // throws on overlap
    // Never on the shaft or the Royal Chamber.
    for (const c of owners.keys()) {
      const [x, y] = xy(c);
      assert.ok(!(x === GRID.mainCol && y < GRID.shaftRows), 'feature on the shaft');
      const r = GRID.royal;
      // C178: root lines grow down through chambers (the Royal Chamber too); nothing else lands there
      if (String(owners.get(c)).startsWith('root')) continue;
      assert.ok(!(x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h), 'feature on the Royal Chamber');
    }
    // Roots: ≥ 6, ≤ 10, y0 1, y1 in 6..25, distinct columns, never the shaft column.
    const roots = n.features.roots;
    assert.ok(roots.length >= ROOTS.min && roots.length <= ROOTS.max);
    assert.equal(new Set(roots.map((r) => r.col)).size, roots.length);
    for (const r of roots) {
      assert.equal(r.y0, 1);
      assert.ok(r.y1 >= 1 && r.y1 <= ROOTS.yMax);
      assert.notEqual(r.col, GRID.mainCol);
    }
    assert.ok(roots.some((r) => r.col === 3) && roots.some((r) => r.col === 35), 'requested columns kept');
    // Stones (C181): 4–8 boulders of 1–9 cells within rows 8–55.
    for (let i = 0; i < n.cells.length; i++) {
      if (n.cells[i] !== CELL.STONE) continue;
      const y = Math.floor(i / GRID.cols);
      assert.ok(y >= STONES.yMin && y <= STONES.yMax);
    }
    const groups = stoneGroups(n.cells);
    for (const g of groups) assert.ok(g.length >= 1 && g.length <= Math.max(STONES.blobMax, STONES.size * STONES.size), 'stone size ' + g.length);
    assert.ok(groups.length >= STONES.min && groups.length <= STONES.max, 'stones ' + groups.length);
    // Water: 2–3 pockets, 2..3 per side, rows 40–70, not revealed, cells coded WATER.
    const water = n.features.water;
    assert.ok(water.length >= WATER.min && water.length <= WATER.max);
    for (const w of water) {
      assert.ok(w.w >= 2 && w.w <= 3 && w.h >= 2 && w.h <= 3);
      assert.ok(w.y >= WATER.yMin && w.y + w.h - 1 <= WATER.yMax);
      assert.equal(w.revealed, false);
      for (let y = w.y; y < w.y + w.h; y++) for (let x = w.x; x < w.x + w.w; x++) assert.equal(n.cells[idx(x, y)], CELL.WATER);
    }
    // Caches: 8–12 normal ones in rows 5–60 on soil, plus exactly one amber bead in bedrock.
    const normal = n.features.caches.filter((c) => c.kind !== 'amber_bead');
    const amber = n.features.caches.filter((c) => c.kind === 'amber_bead');
    assert.ok(normal.length >= CACHES.min && normal.length <= CACHES.max);
    assert.equal(amber.length, 1);
    const ay = Math.floor(amber[0].i / GRID.cols);
    assert.ok(ay >= LAYERS.bedrock.y0 && ay <= LAYERS.bedrock.y1);
    for (const c of n.features.caches) {
      assert.equal(n.cells[c.i], CELL.SOIL);
      assert.equal(c.found, false);
      assert.equal(c.hinted, false);
      assert.ok(Object.keys(CACHES.kinds).includes(c.kind) || c.kind === 'amber_bead');
    }
    for (const c of normal) {
      const y = Math.floor(c.i / GRID.cols);
      assert.ok(y >= CACHES.yMin && y <= CACHES.yMax);
    }
  }
});

test('boulders and water pockets keep a 1-cell margin from the shaft, the Royal Chamber and each other', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const n = generateNest(seed, { tags: ['site_stony_ground', 'site_wet_hollow'] });
    const hard = (x, y) => {
      if (x < 0 || y < 0 || x >= GRID.cols || y >= GRID.rows) return null;
      const c = n.cells[idx(x, y)];
      return c === CELL.STONE ? 'S' : c === CELL.WATER ? 'W' : c === CELL.TUNNEL || c === CELL.CHAMBER ? 'O' : null;
    };
    for (let y = 0; y < GRID.rows; y++) {
      for (let x = 0; x < GRID.cols; x++) {
        const me = hard(x, y);
        if (me !== 'S' && me !== 'W') continue;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const o = hard(x + dx, y + dy);
            assert.notEqual(o, 'O', 'feature next to an open cell at ' + x + ',' + y);
          }
        }
      }
    }
  }
});

test('site tags: stony ground doubles stones and caches; wet hollow adds 2 water pockets', () => {
  let stonesPlain = 0;
  let stonesStony = 0;
  let cachesPlain = 0;
  let cachesStony = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const p = generateNest(seed);
    const st = generateNest(seed, { tags: ['site_stony_ground'] });
    stonesPlain += stoneGroups(p.cells).length;
    stonesStony += stoneGroups(st.cells).length;
    cachesPlain += p.features.caches.length - 1;
    cachesStony += st.features.caches.length - 1;
    const st1 = stoneGroups(st.cells).length;
    assert.ok(st1 >= 2 * STONES.min - 2 && st1 <= 2 * STONES.max, 'stony stones ' + st1);
    const stc = st.features.caches.length - 1;
    assert.ok(stc >= 2 * CACHES.min && stc <= 2 * CACHES.max, 'stony caches ' + stc);
    const wet = generateNest(seed, { tags: ['site_wet_hollow'] });
    assert.ok(wet.features.water.length >= WATER.min + 2 && wet.features.water.length <= WATER.max + 2);
  }
  assert.ok(stonesStony > 1.6 * stonesPlain);
  assert.ok(cachesStony > 1.6 * cachesPlain);
});

test('root columns: requested columns are used, random ones fill up to 6, at most 10 kept', () => {
  const few = generateNest(3, { rootCols: [5] });
  assert.equal(few.features.roots.length, ROOTS.min);
  assert.equal(few.features.roots[0].col, 5);
  const many = generateNest(3, { rootCols: [1, 3, 5, 7, 9, 11, 13, 15, 17, 23, 25, 27] });
  assert.equal(many.features.roots.length, ROOTS.max);
  // Duplicates collapse; the main shaft column is moved aside.
  const dup = generateNest(3, { rootCols: [8, 8, 20] });
  const cols = dup.features.roots.map((r) => r.col);
  assert.equal(new Set(cols).size, cols.length);
  assert.ok(!cols.includes(20));
});

test('royalCount 2 pre-digs a second active Royal Chamber at row 20 linked to the nest by tunnel', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const n = generateNest(seed, { royalCount: 2 });
    assert.equal(n.chambers.length, 2);
    const r2 = n.chambers[1];
    assert.equal(r2.type, 'royal_chamber');
    assert.equal(r2.uid, 2);
    assert.equal(r2.k, 1);
    assert.equal(r2.status, 'active');
    assert.ok(r2.y >= 20);
    assert.equal(n.nextUid, 3);
    for (let y = r2.y; y < r2.y + r2.h; y++) for (let x = r2.x; x < r2.x + r2.w; x++) assert.equal(n.cells[idx(x, y)], CELL.CHAMBER);
    const open = Uint8Array.from(n.cells.map((c) => (c === CELL.TUNNEL || c === CELL.CHAMBER ? 1 : 0)));
    const dist = bfs(open, [idx(GRID.mainCol, 0)]);
    assert.ok(dist[idx(r2.x, r2.y)] > 0, 'second royal reachable from the entrance');
    featureCells(n);
    for (const c of n.features.caches) {
      const [x, y] = xy(c.i);
      assert.ok(!(x >= r2.x && x < r2.x + r2.w && y >= r2.y && y < r2.y + r2.h));
    }
  }
  const four = generateNest(9, { royalCount: 4 });
  assert.equal(four.chambers.length, 4);
  assert.deepEqual(four.chambers.map((c) => c.k), [0, 1, 2, 3]);
});
