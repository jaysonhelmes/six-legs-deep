// Final-QA UI regressions (pure, no DOM). A brand-new player at ~8 min sat on a full 450-food store while the next
// Gallery cost 625, Nurseries 500 and the Scent Library 600: the Build panel showed only a red cost, so waiting looked
// like the answer. A food cost above the food store now says how big the store is and how to raise it, on the chamber
// row and under the inspect panel's next-level cost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overCapHint } from '../src/ui/panels/build.js';

const d = (foodCap) => ({ stats: { foodCap } });

test('build: a food cost above the food store names the store size and the Granary', () => {
  const msg = overCapHint({ food: 625 }, d(450));
  assert.match(msg, /625/);
  assert.match(msg, /450/);
  assert.match(msg, /Granary/);
  assert.ok(msg.split(/\s+/).length <= 16, 'short enough for a row hint');
});

test('build: no hint when the store can hold the cost, for soil-only costs, MAX or missing data', () => {
  assert.equal(overCapHint({ food: 450 }, d(450)), '', 'exactly the cap is payable');
  assert.equal(overCapHint({ food: 100, soil: 5000 }, d(450)), '', 'soil has no store cap');
  assert.equal(overCapHint({ soil: 31 }, d(450)), '');
  assert.equal(overCapHint(null, d(450)), '', 'MAX / no cost');
  assert.equal(overCapHint({ food: 625 }, null), '', 'no derived cache yet');
  assert.equal(overCapHint({ food: 625 }, { stats: {} }), '');
  assert.equal(overCapHint({ food: NaN }, d(450)), '');
});

test('a Nursery picked by its brood pile (kind "nursery") or the queen opens the inspect panel', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../src/ui/panels/build.js', import.meta.url), 'utf8');
  assert.match(src, /sel\.kind === 'chamber' \|\| sel\.kind === 'nursery' \|\| sel\.kind === 'queen'/);
});
