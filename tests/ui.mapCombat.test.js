// Map and combat pass, UI side (ARCHITECTURE §18 C182, C184, C185, C187): source tooltips that say what a source gives,
// detour copy, "Trails 7 / 11", the Lycaenid escort and antlion context-menu items, and the raid alert that only offers
// a button when something can be done.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceTipLines, sourceGivesText, detourText, trailSlotsText, raidAlertCopy, reasonText, eventToast } from '../src/ui/text.js';
import { tipForTarget } from '../src/ui/tooltips.js';
import { escortMenuItems, eventObjectMenuItems, raidAlertInfo } from '../src/ui/panels/map.js';
import { SOURCES } from '../src/data/sources.js';
import { EVENTS } from '../src/data/events.js';
import { hexIndex } from '../src/core/hex.js';
import { newState, makeDerived } from './helpers.js';

function src(type, extra = {}) {
  return { uid: 70, type, hex: hexIndex(4, 0), stock: 120, max: 150, level: 1, herdT: 0, age: 0, ttl: -1, cd: 0, data: {}, ...extra };
}

test('C184: a source tooltip lists what it gives per worker, the stock with its unit, and its lifetime', () => {
  assert.equal(sourceGivesText('dead_insect'), 'Food 0.6 + Chitin 0.01 per forager');
  assert.equal(sourceGivesText('aphid_colony'), 'Honeydew 0.08 per herder');
  assert.equal(sourceGivesText('leaf_plant'), 'Leaves 0.3 per leafcutter');
  assert.equal(sourceGivesText('prey_beetle'), '');
  const s = newState(1);
  const d = makeDerived();
  const lines = sourceTipLines(s, d, src('dead_insect', { ttl: 200 }));
  assert.ok(lines[0].startsWith('Food 0.6 + Chitin 0.01 per forager'), lines[0]);
  assert.ok(lines.some((l) => /^Stock 120 \/ 150 food: gone when empty\.$/.test(l)), lines.join(' | '));
  assert.ok(lines.some((l) => l.startsWith('Gone in ')));
  const seed = sourceTipLines(s, d, src('seed_patch'));
  assert.ok(seed.some((l) => /regrows 1% of max per second/.test(l)), seed.join(' | '));
  const flower = sourceTipLines(s, d, src('flower_patch', { stock: -1, max: -1 }));
  assert.ok(flower.some((l) => l === 'Never runs out.'));
  assert.ok(flower[0].startsWith('Food 0.55 + Honeydew 0.005 per forager'));
  const prey = sourceTipLines(s, d, src('prey_cricket', { stock: -1, max: -1 }));
  assert.ok(/^Hunt it: power /.test(prey[0]), prey[0]);
  const lyc = sourceTipLines(s, d, src('lycaenid_caterpillar', { stock: -1, max: -1 }));
  assert.ok(/while 5 escort soldiers guard its trail/.test(lyc[0]), lyc[0]);
  // the canvas tooltip uses them
  s.run.surface.sources.push(src('dead_insect'));
  const tip = tipForTarget({ view: 'surface', kind: 'source', id: 70 }, s, d);
  assert.ok(tip.lines.some((l) => l.startsWith('Food 0.6 + Chitin 0.01 per forager')), tip.lines.join(' | '));
});

test('C184: aphid colonies show their level and the progress to the next (+1 per 6 min while half herded, max 3)', () => {
  const s = newState(1);
  const d = makeDerived();
  const fx = SOURCES.aphid_colony.fx;
  const a = src('aphid_colony', { stock: -1, max: -1, level: 2, herdT: fx.levelSec * 0.45 });
  s.run.surface.sources.push(a);
  s.run.surface.trails.push({ uid: 71, origin: 0, src: 70, path: [0, a.hex], len: 4, job: 'herder', workers: 6, escorts: 0, S: 0, born: 0, reroutes: [] });
  d.surface.trails = [{ uid: 71, workers: 9 }];
  const lines = sourceTipLines(s, d, a);
  assert.ok(lines.includes('Level 2 / 3: 45% to level 3.'), lines.join(' | '));
  assert.ok(lines.some((l) => /\+1 level per 6:00 while ≥ 8 herders work it \(now 9\)\./.test(l) || /\+1 level per 6 min while ≥ 8 herders work it \(now 9\)\./.test(l)), lines.join(' | '));
  assert.ok(lines.some((l) => l.startsWith('Capacity 16 herders')), 'capacity 8 × level');
  const max = sourceTipLines(s, d, { ...a, level: 3 });
  assert.ok(max.includes('Level 3 / 3 (max).'));
});

test('C182 / C184: detour copy and the trail-slot label', () => {
  assert.equal(detourText(null), null);
  assert.equal(detourText({ mode: 'detour', why: 'molehill' }).short, 'Detour');
  assert.match(detourText({ mode: 'detour', why: 'puddle' }).line, /flooded puddle.*returns to its route/);
  assert.match(detourText({ mode: 'paused', why: 'molehill' }).line, /^Paused: a molehill/);
  assert.equal(trailSlotsText(7, 11), 'Trails 7 / 11');
  assert.equal(eventToast({ type: 'raidResult', win: true, calledOff: 'fallen' }).text, 'Raid called off — their nest has fallen.');
  assert.equal(eventToast({ type: 'raidResult', win: true }).text, 'Raid repelled!');
  assert.match(eventToast({ type: 'expeditionFind', kind: 'fossil_cache' }).text, /fossil cache at the map edge/);
  assert.match(eventToast({ type: 'expeditionFind', kind: 'rich_seed_patch' }).text, /rich seed patch/);
});

test('C185: right-clicking a Lycaenid trail offers +1 / +5 escorts with the count; an antlion pit offers soldiers', () => {
  const s = newState(1);
  const d = makeDerived();
  s.run.colony.adults.soldier = 3;
  const t = { uid: 80, origin: 0, src: 81, path: [0, 5], len: 1, job: 'lycaenid', workers: 0, escorts: 2, S: 0, born: 0, reroutes: [] };
  s.run.surface.trails.push(t);
  const items = escortMenuItems(s, d, t);
  assert.equal(items.length, 2);
  assert.equal(items[0].label, 'Add escort (+1) · Escorts 2/5');
  assert.deepEqual(items[0].args, { uid: 80, n: 3 });
  assert.equal(items[0].type, 'assignEscorts');
  assert.deepEqual(items[1].args, { uid: 80, n: 3 }, '+5 capped by the 1 soldier at home');
  assert.deepEqual(escortMenuItems(s, d, { ...t, job: 'forager' }), []);
  s.run.colony.adults.soldier = 2;   // all on the trail: none at home → the command refuses with a reason
  assert.deepEqual(escortMenuItems(s, d, t)[1].args, { uid: 80, n: 5 }, 'C236: never past the 5 a Lycaenid trail needs');
  t.escorts = 5;
  const full = escortMenuItems(s, d, t);
  assert.equal(full.length, 1);
  assert.ok(full[0].disabled && full[0].type === null && full[0].label.includes('5/5'), 'C236: full trail offers no more');
  t.escorts = 2;
  assert.equal(reasonText('invalid:count', 'assignEscorts'), 'No soldiers at home to send as escorts.');
  s.run.events.objects.push({ uid: 90, kind: 'antlion', hex: 5, cell: -1, t: -1, data: { occ: 89 } });
  const ant = eventObjectMenuItems(s, d, 90);
  assert.deepEqual(ant, [{ label: 'Send ' + EVENTS.ev_antlion_pit.num.soldiers + ' soldiers to clear', type: 'clearAntlion', args: { uid: 90 } }]);
  assert.match(reasonText('requirements:soldiers', 'clearAntlion'), /needs 3 soldiers at home/);
  const tip = tipForTarget({ view: 'surface', kind: 'eventObject', id: 90 }, s, d);
  assert.match(tip.lines[0], /click to send 3 garrison soldiers/);
});

test('C187: the raid alert offers Defend only when the garrison can go; otherwise it says what is needed', () => {
  assert.deepEqual(raidAlertCopy({ trailRaid: true, garrison: 4, guardSent: false, polymorphism: true, escorts: 0 }).action, 'dispatch');
  const none = raidAlertCopy({ trailRaid: false, garrison: 0, guardSent: false, polymorphism: false, escorts: 0 });
  assert.equal(none.action, null);
  assert.match(none.text, /^No soldiers at home — research Polymorphism to raise soldiers; the garrison defends the entrance automatically\.$/);
  const none2 = raidAlertCopy({ trailRaid: true, garrison: 0, guardSent: false, polymorphism: true, escorts: 0 });
  assert.equal(none2.action, null);
  assert.match(none2.text, /raise soldiers/);
  assert.equal(raidAlertCopy({ trailRaid: false, garrison: 7, guardSent: false, polymorphism: true, escorts: 0 }).action, 'view');
  const s = newState(1);
  const d = makeDerived();
  assert.equal(raidAlertInfo(s, d), null);
  s.run.war.raids.push({ uid: 5, rival: 1, target: { type: 'nest' }, raiders: 3, warn: 20, phase: 'warning', guard: 0 });
  const a = raidAlertInfo(s, d);
  assert.equal(a.raid.uid, 5);
  assert.equal(a.action, null);
  assert.match(a.text, /No soldiers at home/);
});
