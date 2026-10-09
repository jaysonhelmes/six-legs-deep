// C291 Build list "one step away": a locked chamber is listed (greyed, with its requirement) only when its unlock is one
// step away — the research it needs is buyable now, or one part of a combination is left and that part is; chambers
// further away stay hidden, milestone chambers appear when they arrive; unlocked chambers stay above locked ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newState } from './helpers.js';
import { UNLOCKS } from '../src/data/unlocks.js';
import { RESEARCH } from '../src/data/research.js';
import { CHAMBERS, CHAMBER_ORDER } from '../src/data/chambers.js';
import { chamberListing, condKnown } from '../src/ui/panels/build.js';
import { setRevealProvider } from '../src/ui/reveal.js';
import { isAvailable } from '../src/systems/research.js';

function withReveal(fn) {
  setRevealProvider((s, key) => !!(s && s.run && s.run.unlocked && s.run.unlocked[key]));
  try { return fn(); } finally { setRevealProvider(null); }
}

function base() {
  const s = newState(1);
  for (const k of Object.keys(s.run.unlocked)) if (k.startsWith('chamber_')) delete s.run.unlocked[k];
  Object.assign(s.run.unlocked, { panel_build: true, panel_research: true, chamber_gallery: true });
  s.run.research = {};
  return s;
}

const unlockOf = (id) => UNLOCKS.find((u) => u.key === CHAMBERS[id].unlock);
const researchOf = (id) => {
  const c = unlockOf(id).cond;
  return typeof c.research === 'string' ? c.research : null;
};

test('C291: every research-gated chamber shows exactly when its research is buyable now (same rule for all)', () => {
  withReveal(() => {
    const gated = CHAMBER_ORDER.filter((id) => id !== 'royal_chamber' && researchOf(id));
    assert.ok(gated.includes('fungus_garden') && gated.includes('deep_vault'));
    for (const id of gated) {
      const r = researchOf(id);
      const s = base();
      // two or more steps away: some prerequisite is missing (nodes with no prerequisites are always one step away)
      if (RESEARCH[r].prereq.length) {
        assert.equal(chamberListing(s).ids.includes(id), isAvailable(s, r), id + ' hidden while ' + r + ' is not buyable');
      }
      // one step away: own every prerequisite (and theirs) so the node is buyable now
      const own = (n) => { for (const p of RESEARCH[n].prereq) { own(p); s.run.research[p] = 1; } };
      own(r);
      assert.equal(isAvailable(s, r), true);
      const L = chamberListing(s);
      assert.equal(L.states[id], 'locked', id + ' one step away: listed, greyed');
      // unlocked: listed above every locked chamber
      s.run.research[r] = 1;
      s.run.unlocked[CHAMBERS[id].unlock] = true;
      const L2 = chamberListing(s);
      assert.equal(L2.states[id], 'open');
      const firstLocked = L2.ids.findIndex((x) => L2.states[x] === 'locked');
      if (firstLocked >= 0) assert.ok(L2.ids.indexOf(id) < firstLocked, id + ' above the locked ones');
    }
  });
});

test('C291: Fungus Garden and Deep Vault follow the same rule (two steps hidden, one step shown)', () => {
  withReveal(() => {
    const s = base();
    let L = chamberListing(s);
    assert.ok(!L.ids.includes('fungus_garden') && !L.ids.includes('deep_vault'));
    s.run.research.aphid_husbandry = 1;   // Leafcutting buyable: Fungiculture is still two steps away
    assert.ok(!chamberListing(s).ids.includes('fungus_garden'));
    s.run.research.leafcutting = 1;       // Fungiculture buyable now
    assert.equal(chamberListing(s).states.fungus_garden, 'locked');
    for (const r of ['coordinated_digging', 'load_chains', 'clay_masonry', 'ventilation_shafts']) s.run.research[r] = 1;
    assert.ok(!chamberListing(s).ids.includes('deep_vault'), 'Gallery Arches still missing');
    s.run.research.gallery_arches = 1;
    L = chamberListing(s);
    assert.equal(L.states.deep_vault, 'locked');
    // without the Research tab no research step can be taken
    delete s.run.unlocked.panel_research;
    L = chamberListing(s);
    assert.ok(!L.ids.includes('fungus_garden') && !L.ids.includes('deep_vault'));
  });
});

test('C291: milestone chambers stay hidden until they arrive; combinations need at most one step left', () => {
  withReveal(() => {
    const s = base();
    const L = chamberListing(s);
    for (const id of ['nursery', 'scent_library', 'midden', 'gate', 'water_well', 'granary']) assert.ok(!L.ids.includes(id), id);
    // all: two buyable research parts left = two steps (hidden); one left = one step (shown)
    const both = { all: [{ research: 'polymorphism' }, { research: 'aphid_husbandry' }] };
    assert.equal(condKnown(s, both), false);
    s.run.research.polymorphism = 1;
    assert.equal(condKnown(s, both), true);
    // a milestone part that is not met keeps a combination hidden
    assert.equal(condKnown(s, { all: [{ research: 'aphid_husbandry' }, { adults: 1e9 }] }), false);
    // any: one buyable part is enough (Carapace Store: first chitin, or research Polymorphism)
    const s2 = base();
    assert.equal(chamberListing(s2).states.carapace_store, 'locked');
    // a flag part counts once its own unlock is one step away
    assert.equal(condKnown(s2, { flag: 'chamber_barracks' }), true, 'Barracks unlock is one research away');
    assert.equal(condKnown(s2, { flag: 'chamber_deep_vault' }), false);
  });
});
