// UI unit tests — player copy: reason codes, tooltip word limit (DESIGN §25.6 rule 4), names, unlock hints, event
// toasts. Owner: WP9.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../src/ui/text.js';
import { createState } from '../src/core/state.js';
import { DOC_UNLOCK_KEYS } from './helpers.js';

const REASON_CODES = ['unknown', 'paused', 'locked', 'cantAfford', 'invalid', 'max', 'noSlot', 'blocked', 'cooldown', 'busy', 'hardship',
  'notFound', 'queueFull', 'clickCap', 'requirements'];

test('every ReasonCode of ARCHITECTURE §7.4 has player text; details and unknown codes degrade gracefully', () => {
  for (const code of REASON_CODES) {
    assert.ok(typeof T.REASONS[code] === 'string' && T.REASONS[code].length > 0, code);
    assert.equal(T.reasonText(code), T.REASONS[code]);
  }
  assert.equal(T.reasonText('noSlot:trail'), T.REASON_DETAILS['noSlot:trail']);
  assert.equal(T.reasonText('blocked:somethingNew'), T.REASONS.blocked, 'unknown detail falls back to its code');
  assert.equal(T.reasonText('weird'), T.REASONS.invalid);
  assert.equal(T.reasonText(null), '');
});

test('tooltip copy is at most 12 words (DESIGN §25.6 rule 4)', () => {
  const tables = { RES_TIPS: T.RES_TIPS, SEASON_TIPS: T.SEASON_TIPS, BOTTLENECK_TIPS: T.BOTTLENECK_TIPS, OVERLAY_TIPS: T.OVERLAY_TIPS,
    JOB_TIPS: T.JOB_TIPS, CASTE_TIPS: T.CASTE_TIPS, CHAMBER_TIPS: T.CHAMBER_TIPS, ADAPT_TIPS: T.ADAPT_TIPS, RESEARCH_TIPS: T.RESEARCH_TIPS,
    TRAIT_TIPS: T.TRAIT_TIPS, FED_TIPS: T.FED_TIPS, GENOME_TIPS: T.GENOME_TIPS, SITE_TIPS: T.SITE_TIPS, BOON_TIPS: T.BOON_TIPS,
    EDICT_TIPS: T.EDICT_TIPS, SPECIES_TIPS: T.SPECIES_TIPS, UNLOCK_HINTS: T.UNLOCK_HINTS, WAR_TIPS: T.WAR_TIPS, TACTIC_TIPS: T.TACTIC_TIPS,
    TAB_TIPS: T.TAB_TIPS };
  for (const [name, table] of Object.entries(tables)) {
    for (const [id, copy] of Object.entries(table)) {
      assert.ok(T.wordCount(copy) <= 12, `${name}.${id} has ${T.wordCount(copy)} words: "${copy}"`);
    }
  }
  for (const [id, v] of Object.entries(T.HARDSHIP_TIPS)) {
    assert.ok(T.wordCount(v.rule) <= 12 && T.wordCount(v.reward) <= 12, id);
  }
  for (const [ev, choices] of Object.entries(T.CHOICE_TIPS)) {
    for (const [c, copy] of Object.entries(choices)) assert.ok(T.wordCount(copy) <= 12, `${ev}.${c}: ${copy}`);
  }
});

test('research copy covers all 58 nodes of DESIGN §11 and every Adaptation, chamber and job', () => {
  assert.equal(Object.keys(T.RESEARCH_TIPS).length, 58);
  assert.equal(Object.keys(T.ADAPT_TIPS).length, 10);
  assert.equal(Object.keys(T.CHAMBER_TIPS).length, 17); // C136 War Hall
  for (const j of ['forager', 'digger', 'nurse', 'scout', 'herder', 'leafcutter', 'gardener']) assert.ok(T.JOB_TIPS[j], j);
});

test('every documented unlock key (ARCHITECTURE §11) has a condition hint and a label', () => {
  for (const key of DOC_UNLOCK_KEYS) {
    if (key === 'tab_guide' || key === 'tab_stats' || key === 'tab_settings') continue; // always visible
    assert.ok(T.UNLOCK_HINTS[key], 'hint for ' + key);
    assert.ok(T.unlockLabel(key).length > 0, 'label for ' + key);
  }
  assert.equal(T.unlockHint('no_such_key'), 'Keep growing your colony.');
});

test('names: data table names when present, readable fallbacks otherwise', () => {
  assert.equal(T.humanize('ach_first_brood'), 'First brood');
  assert.equal(T.humanize('scent_library'), 'Scent library');
  assert.equal(T.nameOf('chamber', 'scent_library'), 'Scent Library');
  assert.equal(T.nameOf('res', 'honeydew'), 'Honeydew');
  assert.equal(T.nameOf('rival', 'great_rival'), 'The Argentine Front');
  assert.equal(T.nameOf('research', 'foraging_refinement').endsWith('Refinement'), true);
  assert.equal(T.nameOf('event', 'ev_some_future_event'), 'Some future event');
  assert.equal(T.nameOf('chamber', null), '');
});

test('event toasts: rate-limit priority and names resolved by uid (payload `type` collides with the event type)', () => {
  const s = createState();
  s.run.rivals.list.push({ uid: 7, type: 'pavement_ants', tier: 2, alive: true, sighted: true });
  s.run.nest.chambers.push({ uid: 5, type: 'gallery', k: 0, x: 1, y: 1, w: 3, h: 2, level: 1, target: 1, status: 'active', blueprint: false, bornAt: 0 });
  assert.equal(T.eventToast({ type: 'achievement', id: 'ach_first_brood' }).priority, 'high');
  assert.match(T.eventToast({ type: 'conquest', uid: 7, tier: 2 }, s).text, /Pavement Ants/);
  assert.match(T.eventToast({ type: 'chamberActivated', uid: 5, level: 1 }, s).text, /Gallery/);
  assert.match(T.eventToast({ type: 'raidWarning', uid: 1, rival: 7, target: { type: 'nest' }, warn: 21 }, s).text, /Pavement Ants.*21s/);
  assert.equal(T.eventToast({ type: 'commandRejected', reason: 'clickCap' }).priority, 'low');
  assert.equal(T.eventToast({ type: 'adultsDied', caste: 'minor', n: 3, cause: 'battle' }), null, 'battle losses are shown by the battle result');
  assert.equal(T.eventToast({ type: 'cellDug', i: 3 }), null);
  assert.equal(T.eventToast(null), null);
});

test('import errors map every save-codec error code to readable text', () => {
  for (const code of ['badPrefix', 'badBase64', 'badChecksum', 'badJson', 'tooNew', 'migrationFailed', 'invalidState']) {
    assert.ok(T.importErrorText(code).length > 10, code);
  }
  assert.equal(T.importErrorText('???'), 'The save could not be read.');
});

test('cosmetic slots are derived from ids', () => {
  assert.equal(T.cosmeticSlot('cos_palette_autumn'), 'palette');
  assert.equal(T.cosmeticSlot('golden_queen_crown'), 'crown');
  assert.equal(T.cosmeticSlot('ladybug_pet'), 'pet');
  assert.equal(T.cosmeticSlot('mystery'), 'misc');
});

test('eventToast names chambers and rivals from the §10 sub-type keys (chamberType / rivalType, C48)', () => {
  assert.equal(T.eventToast({ type: 'chamberActivated', uid: 99, chamberType: 'gallery', level: 1 }).text, T.nameOf('chamber', 'gallery') + ' complete.');
  assert.equal(T.eventToast({ type: 'rivalSighted', uid: 99, rivalType: 'black_garden_ants' }).text, T.nameOf('rival', 'black_garden_ants') + ' spotted!');
  assert.equal(T.eventToast({ type: 'conquest', uid: 99, rivalType: 'pavement_ants', tier: 2 }).text, 'Conquered: ' + T.nameOf('rival', 'pavement_ants') + '!');
});
