// UI regression tests (pure helpers, no DOM) for bug-hunt findings F16 (STRETCH Genome nodes not offered), F18
// (whole-number prestige currencies print without decimals), F19 (Budding names the Old Ridge's alates condition) and
// F21 (the rail names the run about to start while the landing chooser is open).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brandSubtitle } from '../src/ui/hud.js';
import { TRAIT_TIPS, oldRidgeHint } from '../src/ui/text.js';
import { fmtCost, fmtCount } from '../src/ui/format.js';
import { GENOME_BUYABLE } from '../src/ui/panels/prestige.js';
import { GENOME, GENOME_ORDER } from '../src/data/genome.js';
import { BOSSES } from '../src/data/rivals.js';
import { createState } from '../src/core/state.js';
import { createDerived } from '../src/core/derived.js';

test('F16: the Genome shop lists every buildable node and never the STRETCH Biomes node', () => {
  assert.ok(!GENOME_BUYABLE.includes('biomes'));
  for (const id of GENOME_ORDER) assert.equal(GENOME_BUYABLE.includes(id), !GENOME[id].stretch, id);
});

test('F18: alates, kinship and genes costs print as whole numbers; other resources keep their decimals', () => {
  assert.equal(fmtCost({ alates: 1 })[0].text, '1');
  assert.equal(fmtCost({ kinship: 2 })[0].text, '2');
  assert.equal(fmtCost({ genes: 25 })[0].text, '25');
  assert.equal(fmtCost({ food: 1 })[0].text, '1.0');
});

test('F19: the Budding tip names the Old Ridge alates-this-cycle condition', () => {
  const need = BOSSES.old_ridge_supercolony.alatesCycle;
  assert.ok(TRAIT_TIPS.budding.includes(fmtCount(need)), TRAIT_TIPS.budding);
  assert.match(TRAIT_TIPS.budding, /this cycle/);
  assert.ok(oldRidgeHint().includes(fmtCount(need)));
});

test('F21: the rail shows the run about to start (not "run 1") while the landing chooser is open', () => {
  const s = createState({ seed: 3 });
  const d = createDerived();
  s.meta.counters.runs = 16;   // 16 runs played; the skeleton run behind the chooser has index 0
  s.run.index = 0;
  d.season.year = 20;
  s.meta.pending = { kind: 'landing', options: [], boons: [] };
  const txt = brandSubtitle(s, d);
  assert.ok(!/run 1\b/.test(txt), txt);
  assert.match(txt, /run 17/);
  s.meta.pending = null;
  s.run.index = 16;
  assert.equal(brandSubtitle(s, d), 'Year 20 · run 17');
  s.meta.settings.queenName = 'Maud';
  assert.equal(brandSubtitle(s, d), 'Queen Maud');
});
