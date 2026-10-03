// Save size in long games (bug-hunt F26, strata part): Strata records are packed nest silhouettes with a bounded size,
// older RLE records are re-packed at the next run end, and a late-game save that has rotated 12 worst-case nests
// through the Strata stays under SAVE.targetBytes (DESIGN §27.3 "save size ≤ 60 KB"). Fixture: a 21 h bot save.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fromExportString, toExportString, bitsEncode, bitsDecode } from '../src/core/save.js';
import { createDerived } from '../src/core/derived.js';
import { doFlight, strataSilhouette } from '../src/systems/prestige.js';
import { decodeRle } from '../src/render/nestRenderer.js';
import { SAVE, GRID, CELL } from '../src/data/balance.js';
import { RESET } from '../src/data/prestige.js';
import { fakeEnv } from './helpers.js';

const N = GRID.cols * GRID.rows;
const late = () => {
  const r = fromExportString(fs.readFileSync(new URL('./fixtures/late_21h.txt', import.meta.url), 'utf8').trim());
  assert.equal(r.ok, true, r.error);
  return r.state;
};

/** Worst case for any run-length code: every other cell open, alternating tunnels and chambers. */
function checkerNest() {
  const cells = new Array(N);
  for (let i = 0; i < N; i++) cells[i] = (i + Math.floor(i / GRID.cols)) % 2 ? (i % 3 ? CELL.TUNNEL : CELL.CHAMBER) : (i % 5 ? CELL.SOIL : CELL.STONE);
  return cells;
}

test('F26: bitsEncode / bitsDecode round-trip a mask; trailing empty cells cost nothing', () => {
  const mask = new Array(N).fill(0);
  for (const i of [0, 5, 6, 77, 1599, 1600, N - 1]) mask[i] = 1;
  assert.deepEqual(bitsDecode(bitsEncode(mask), N), mask);
  assert.equal(bitsEncode(new Array(N).fill(0)), 'bits:');
  const top = new Array(N).fill(0);
  top[3] = 1;
  assert.equal(bitsEncode(top).length, 'bits:'.length + 1);
});

test('F26: a Strata record keeps exactly the open cells and is bounded in size whatever the nest', () => {
  const cells = checkerNest();
  const rec = strataSilhouette(cells);
  assert.ok(rec.length <= 'bits:'.length + Math.ceil(N / 6), 'record ' + rec.length + ' chars');
  const back = decodeRle(rec);   // the renderer's decoder (fossils draw tunnel / chamber cells)
  assert.equal(back.length, N);
  for (let i = 0; i < N; i++) {
    const open = cells[i] === CELL.TUNNEL || cells[i] === CELL.CHAMBER;
    assert.equal(back[i] === CELL.TUNNEL || back[i] === CELL.CHAMBER, open, 'cell ' + i);
  }
});

test('F26: a late-game save that rotates 12 worst-case nests through the Strata stays under the 60 KB target', () => {
  const s = late();
  const d = createDerived();
  const lateRun = JSON.stringify(s.run);
  const before = toExportString(s, 1).length;
  for (let k = 0; k < RESET.strataMax; k++) {
    s.run = JSON.parse(lateRun);
    s.run.nest.cells = checkerNest();
    doFlight(s, d, fakeEnv());
    if (k === 0) {
      assert.ok(s.meta.strata.every((r) => typeof r.cells === 'string' && r.cells.startsWith('bits:')),
        'older RLE records are re-packed at the first run end');
    }
  }
  s.run = JSON.parse(lateRun);   // back to the (large) late-game run for the size check
  s.meta.pending = null;
  assert.equal(s.meta.strata.length, RESET.strataMax);
  const str = toExportString(s, 1);
  assert.ok(str.length <= SAVE.targetBytes, 'save is ' + str.length + ' bytes (target ≤ ' + SAVE.targetBytes + '; fixture was ' + before + ')');
  const strataBytes = JSON.stringify(s.meta.strata).length;
  assert.ok(strataBytes <= RESET.strataMax * (Math.ceil(N / 6) + 64), 'strata ' + strataBytes + ' B');
  const r = fromExportString(str);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.state.meta.strata, s.meta.strata);
});
