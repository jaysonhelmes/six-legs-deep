// WP6 unit tests: season clock, modifiers, frost line, forecast, chronobiology (ARCHITECTURE §8.5, DESIGN §17).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, makeDerived, fakeEnv } from './helpers.js';
import * as seasons from '../src/systems/seasons.js';
import { SEASON_ORDER, LONG_SUMMER_ORDER, YEAR, SEASON_MODS, FROST } from '../src/data/seasons.js';
import { RESEARCH } from '../src/data/research.js';
import { MOUND } from '../src/data/surface.js';
import { addEffect } from '../src/core/effects.js';

/** Tick seasons for `sec` seconds in steps of dt; returns every event. */
function run(s, d, sec, dt = 0.1, opts = {}) {
  const out = [];
  const n = Math.round(sec / dt);
  for (let i = 0; i < n; i++) {
    const env = fakeEnv({ dt, ...opts });
    seasons.tick(s, d, dt, env);
    out.push(...env.events.map((e) => ({ ...e, at: s.meta.season.year * 4 * s.meta.season.lengthSec + s.meta.season.t })));
  }
  return out;
}

test('data: season order, long-summer order and year constants', () => {
  assert.deepEqual([...SEASON_ORDER], ['spring', 'summer', 'autumn', 'winter']);
  assert.deepEqual([...LONG_SUMMER_ORDER], ['spring', 'summer', 'summer', 'autumn']);
  assert.equal(YEAR.lengthSec, 360);
  for (const id of SEASON_ORDER) assert.ok(SEASON_MODS[id], id);
  assert.equal(SEASON_MODS.winter.forageMild, 0.6);
  assert.ok(Object.isFrozen(SEASON_MODS.winter));
});

test('a new game starts in spring and the first winter begins at 18:00 (seasonChanged emitted)', () => {
  const s = newState();
  const d = makeDerived();
  seasons.tick(s, d, 0, fakeEnv());
  assert.equal(d.season.id, 'spring');
  assert.equal(d.season.toNext, 360);
  const ev = run(s, d, 1079.9, 0.1);
  assert.equal(d.season.id, 'autumn');
  const changes = ev.filter((e) => e.type === 'seasonChanged').map((e) => e.id);
  assert.deepEqual(changes, ['summer', 'autumn']);
  const ev2 = run(s, d, 0.2, 0.1);
  assert.equal(d.season.id, 'winter');
  assert.equal(ev2.filter((e) => e.type === 'seasonChanged').length, 1);
  assert.equal(ev2.find((e) => e.type === 'seasonChanged').id, 'winter');
  assert.ok(Math.abs(s.meta.season.t - 1080.1) < 1e-6);
});

test('winterSoon fires once, 60 s before winter', () => {
  const s = newState();
  const d = makeDerived();
  const ev = run(s, d, 1080, 0.5);
  const soon = ev.filter((e) => e.type === 'winterSoon');
  assert.equal(soon.length, 1);
  assert.ok(Math.abs(soon[0].at - (1080 - YEAR.forecastSec)) <= 0.5, 'at ' + soon[0].at);
});

test('season modifiers are copied into d.season.mods (spring/summer/autumn/winter)', () => {
  const s = newState();
  const d = makeDerived();
  for (const [t, id] of [[10, 'spring'], [400, 'summer'], [800, 'autumn'], [1100, 'winter']]) {
    s.meta.season.t = t;
    seasons.tick(s, d, 0, fakeEnv());
    assert.equal(d.season.id, id);
    assert.equal(d.season.index, SEASON_ORDER.indexOf(id));
    assert.equal(d.season.srcId, id);
    const m = SEASON_MODS[id];
    for (const k of ['lay', 'broodTime', 'dig', 'insight', 'foodCap', 'rivalAggro', 'rivalDormant', 'flightW', 'puddlesBlock']) {
      assert.equal(d.season.mods[k], m[k], id + '.' + k);
    }
    assert.equal(d.season.mods.forageMild, undefined, 'mods keeps the d shape');
  }
});

test('year-0 winter is mild (forage 0.6, frost to row 10); year-1 winter is hard (0.3, row 18)', () => {
  const s = newState();
  const d = makeDerived();
  s.meta.season.t = 1080 + 200;
  seasons.tick(s, d, 0, fakeEnv());
  assert.equal(d.season.mild, true);
  assert.equal(d.season.mods.forage, SEASON_MODS.winter.forageMild);
  assert.equal(d.season.frostMax, FROST.maxRowMild);
  assert.equal(d.season.frostRow, FROST.maxRowMild);
  s.meta.season.year = 1;
  seasons.tick(s, d, 0, fakeEnv());
  assert.equal(d.season.mild, false);
  assert.equal(d.season.mods.forage, SEASON_MODS.winter.forage);
  assert.equal(d.season.frostMax, FROST.maxRow);
});

test('frost descends over 90 s, holds, and retreats over the last 60 s of winter', () => {
  const s = newState();
  const d = makeDerived();
  s.meta.season.year = 1;
  const at = (e) => {
    s.meta.season.t = 1080 + e;
    seasons.tick(s, d, 0, fakeEnv());
    return d.season.frostRow;
  };
  const F = FROST.maxRow;
  assert.equal(at(0), 0);
  assert.ok(Math.abs(at(45) - F / 2) < 1e-9);
  assert.ok(Math.abs(at(89.999) - F) < 0.01);
  assert.equal(at(90), F);
  assert.equal(at(200), F);
  assert.equal(at(300), F);
  assert.ok(Math.abs(at(330) - F / 2) < 1e-9);
  assert.ok(at(359.9) < 0.1);
  s.meta.season.t = 100;
  seasons.tick(s, d, 0, fakeEnv());
  assert.equal(d.season.frostRow, 0, 'no frost outside winter');
});

test('frost line: thermoregulation and mound reductions, minimum 4', () => {
  const s = newState();
  const d = makeDerived();
  s.meta.season.year = 1;
  s.meta.season.t = 1080 + 180;
  s.run.surface.mound = 9;
  seasons.tick(s, d, 0, fakeEnv());
  assert.equal(d.season.frostMax, FROST.maxRow - Math.floor(9 / MOUND.frostPerLevels));
  s.run.surface.mound = 60;
  seasons.tick(s, d, 0, fakeEnv());
  assert.equal(d.season.frostMax, FROST.maxRow - MOUND.frostMax, 'mound reduction caps');
  const thermo = RESEARCH.thermoregulation && RESEARCH.thermoregulation.fx ? RESEARCH.thermoregulation.fx.frost : 0;
  s.run.research.thermoregulation = 1;
  seasons.tick(s, d, 0, fakeEnv());
  assert.equal(d.season.frostMax, Math.max(FROST.minRow, FROST.maxRow - MOUND.frostMax - thermo));
  s.meta.season.year = 0;
  seasons.tick(s, d, 0, fakeEnv());
  assert.equal(d.season.frostMax, Math.max(FROST.minRow, FROST.maxRowMild - MOUND.frostMax - thermo));
  if (thermo > 0) assert.equal(d.season.frostMax, FROST.minRow, 'mild winter with every reduction bottoms out at 4');
});

test('frost snap: snapRow follows the frost_snap effect; thermal_brood_shuttling is immune', () => {
  const s = newState();
  const d = makeDerived();
  addEffect(s, { id: 'ev_frost_snap', stat: 'frost_snap', add: FROST.snapRows, t: FROST.snapSec });
  seasons.tick(s, d, 0, fakeEnv());
  assert.equal(d.season.snapRow, FROST.snapRows);
  s.run.research.thermal_brood_shuttling = 1;
  seasons.tick(s, d, 0, fakeEnv());
  assert.equal(d.season.snapRow, 0);
});

test('edict_of_long_summer: spring, summer, summer, autumn; autumn bonuses off (srcId neutral, foodCap 1)', () => {
  const s = newState();
  const d = makeDerived();
  s.cycle.edict = 'edict_of_long_summer';
  const ids = [];
  for (const t of [10, 400, 800, 1100]) {
    s.meta.season.t = t;
    seasons.tick(s, d, 0, fakeEnv());
    ids.push(d.season.id);
  }
  assert.deepEqual(ids, ['spring', 'summer', 'summer', 'autumn']);
  assert.equal(d.season.srcId, 'neutral');
  assert.equal(d.season.mods.foodCap, 1);
  assert.equal(d.season.frostRow, 0);
  assert.equal(d.season.index, SEASON_ORDER.indexOf('autumn'));
  // No winter in the year: no winterSoon, and the summer→summer slot change is not a season change.
  s.meta.season.t = 0;
  const ev = run(s, d, 1440, 1);
  assert.equal(ev.filter((e) => e.type === 'winterSoon').length, 0);
  assert.deepEqual(ev.filter((e) => e.type === 'seasonChanged').map((e) => e.id), ['summer', 'autumn', 'spring']);
  assert.equal(s.meta.season.year, 1);
});

test('eternal_winter hardship: always winter, never mild, frost held at F_max', () => {
  const s = newState();
  const d = makeDerived();
  s.run.hardship = 'eternal_winter';
  for (const t of [0, 400, 800, 1100]) {
    s.meta.season.t = t;
    seasons.tick(s, d, 0, fakeEnv());
    assert.equal(d.season.id, 'winter');
    assert.equal(d.season.mild, false);
    assert.equal(d.season.mods.forage, SEASON_MODS.winter.forage);
    assert.equal(d.season.frostRow, FROST.maxRow);
  }
});

test('boon_long_spring: extra spring seconds hold the clock in spring', () => {
  const s = newState();
  const d = makeDerived();
  seasons.addExtraSpring(s, 180);
  assert.equal(s.meta.season.extraSpring, 180);
  seasons.addExtraSpring(s, NaN);
  seasons.addExtraSpring(s, -5);
  assert.equal(s.meta.season.extraSpring, 180);
  seasons.tick(s, d, 0, fakeEnv());
  assert.equal(d.season.toNext, 360 + 180, 'toNext includes the held spring');
  run(s, d, 100, 0.5);
  assert.equal(s.meta.season.t, 0);
  assert.ok(Math.abs(s.meta.season.extraSpring - 80) < 1e-9);
  run(s, d, 100, 0.5);
  assert.equal(s.meta.season.extraSpring, 0);
  assert.ok(Math.abs(s.meta.season.t - 20) < 1e-9);
  // Bonus banked in summer is spent when spring returns.
  const s2 = newState();
  s2.meta.season.t = 400;
  seasons.addExtraSpring(s2, 50);
  seasons.skipTime(s2, 100);
  assert.equal(s2.meta.season.t, 500);
  assert.equal(s2.meta.season.extraSpring, 50);
  seasons.skipTime(s2, 940 + 30);   // reaches spring after 940 s, then holds 30 s
  assert.equal(s2.meta.season.year, 1);
  assert.equal(s2.meta.season.t, 0);
  assert.equal(s2.meta.season.extraSpring, 20);
  seasons.skipTime(s2, 20 + 15);    // the rest of the bonus, then 15 s of spring
  assert.equal(s2.meta.season.extraSpring, 0);
  assert.equal(s2.meta.season.t, 15);
});

test('skipTime advances only the clock and wraps years in O(1)', () => {
  const s = newState();
  const before = JSON.stringify(s.run);
  seasons.skipTime(s, 3 * 1440 + 100);
  assert.equal(s.meta.season.year, 3);
  assert.ok(Math.abs(s.meta.season.t - 100) < 1e-6);
  seasons.skipTime(s, 1e9);
  assert.ok(s.meta.season.t >= 0 && s.meta.season.t < 1440);
  assert.equal(JSON.stringify(s.run), before);
  seasons.skipTime(s, -10);
  seasons.skipTime(s, NaN);
  assert.ok(Number.isFinite(s.meta.season.t));
});

test('setSeason jumps to the start of that season in the current year; seasonAt is pure', () => {
  const s = newState();
  s.meta.season.t = 1000;
  s.meta.season.year = 2;
  seasons.setSeason(s, 'summer');
  assert.equal(s.meta.season.t, 360);
  assert.equal(s.meta.season.year, 2);
  seasons.setSeason(s, 'bogus');
  assert.equal(s.meta.season.t, 360);
  s.cycle.edict = 'edict_of_long_summer';
  seasons.setSeason(s, 'winter');
  assert.equal(s.meta.season.t, 360, 'winter is not in the long-summer order');
  const snap = JSON.stringify(s);
  assert.deepEqual(seasons.seasonAt(s.meta, 1100), { id: 'winter', index: 3, tIn: 20 });
  assert.deepEqual(seasons.seasonAt(s.meta, 800, { longSummer: true }), { id: 'summer', index: 1, tIn: 80 });
  assert.equal(seasons.seasonAt(s.meta, 5, { eternalWinter: true }).id, 'winter');
  assert.equal(seasons.seasonAt(s.meta, 1440 + 5).id, 'spring', 't wraps');
  assert.equal(JSON.stringify(s), snap);
});

test('the clock keeps running offline and during the landing pause', () => {
  const s = newState();
  const d = makeDerived();
  run(s, d, 60, 60, { offline: true });
  assert.equal(s.meta.season.t, 60);
});

test('forecast: next season, time to it, and the weather event announced by events.js', () => {
  const s = newState();
  const d = makeDerived();
  s.meta.season.t = 300;
  seasons.tick(s, d, 0, fakeEnv());
  assert.equal(d.season.forecast.next, 'summer');
  assert.equal(d.season.forecast.inSec, 60);
  assert.equal(d.season.forecast.weather, null);
  s.run.events.active.push({ uid: 9, id: 'ev_rainstorm', t: 30, data: { k: 'forecast', forecast: true } });
  seasons.tick(s, d, 0, fakeEnv());
  assert.equal(d.season.forecast.weather, 'ev_rainstorm');
  s.meta.season.t = 1100;
  seasons.tick(s, d, 0, fakeEnv());
  assert.equal(d.season.forecast.next, 'spring');
});

test('setChronobiology: locked without the gene; validates length and start; rescales the clock', () => {
  const s = newState();
  const d = makeDerived();
  const h = seasons.handlers.setChronobiology;
  assert.equal(h.validate(s, d, { type: 'setChronobiology', lengthSec: 300 }), 'locked');
  s.meta.genome.chronobiology = 1;
  assert.match(h.validate(s, d, { lengthSec: 100 }), /^invalid/);
  assert.match(h.validate(s, d, { lengthSec: 1000 }), /^invalid/);
  assert.match(h.validate(s, d, { lengthSec: NaN }), /^invalid/);
  assert.match(h.validate(s, d, { lengthSec: '300' }), /^invalid/);
  assert.match(h.validate(s, d, { lengthSec: 300, start: 'monsoon' }), /^invalid/);
  assert.equal(h.validate(s, d, { lengthSec: 180, start: 'autumn' }), null);
  assert.equal(h.validate(s, d, { lengthSec: 720 }), null);
  s.meta.season.t = 540;   // middle of summer at 360 s seasons
  const env = fakeEnv();
  h.apply(s, d, { lengthSec: 720 }, env);
  assert.equal(s.meta.season.lengthSec, 720);
  assert.equal(s.meta.season.t, 1080, 'position within the year kept');
  assert.equal(d.season.id, 'summer');
  assert.equal(d.season.len, 720);
  // F17 (ARCHITECTURE §18): `start` no longer jumps the running clock; it is stored and applied at the next run start.
  h.apply(s, d, { lengthSec: 180, start: 'autumn' }, env);
  assert.equal(s.meta.season.t, 270, 'position within the year kept');
  assert.equal(d.season.id, 'summer');
  assert.equal(s.meta.season.start, 'autumn');
  assert.ok(!env.events.some((e) => e.type === 'seasonChanged'));
});

test('a step crossing a boundary integrates time-weighted mods; a step ending on a boundary keeps the old season', () => {
  const s = newState();
  const d = makeDerived();
  // [300, 360): all spring, even though the clock ends in summer.
  s.meta.season.t = 300;
  seasons.tick(s, d, 60, fakeEnv({ dt: 60, offline: true }));
  assert.equal(d.season.id, 'summer');
  assert.equal(d.season.mods.foodCap, SEASON_MODS.spring.foodCap);
  assert.equal(d.season.mods.forage, SEASON_MODS.spring.forage);
  assert.equal(d.season.mods.puddlesBlock, true);
  // [360, 420): all summer.
  seasons.tick(s, d, 60, fakeEnv({ dt: 60, offline: true }));
  assert.equal(d.season.mods.forage, SEASON_MODS.summer.forage);
  assert.equal(d.season.mods.puddlesBlock, false);
  // [690, 750): half summer, half autumn.
  s.meta.season.t = 690;
  seasons.tick(s, d, 60, fakeEnv({ dt: 60, offline: true }));
  assert.equal(d.season.id, 'autumn');
  assert.ok(Math.abs(d.season.mods.foodCap - (SEASON_MODS.summer.foodCap + SEASON_MODS.autumn.foodCap) / 2) < 1e-12);
  assert.ok(Math.abs(d.season.mods.forage - (SEASON_MODS.summer.forage + SEASON_MODS.autumn.forage) / 2) < 1e-12);
  // [1070, 1100) in year 0: 10 s autumn + 20 s mild winter; booleans follow the majority (winter: dormant).
  s.meta.season.t = 1070;
  seasons.tick(s, d, 30, fakeEnv({ dt: 30, offline: true }));
  const want = (SEASON_MODS.autumn.forage * 10 + SEASON_MODS.winter.forageMild * 20) / 30;
  assert.ok(Math.abs(d.season.mods.forage - want) < 1e-12, 'mild winter forage in the blend');
  assert.equal(d.season.mods.rivalDormant, true);
  // A derive pass (dt = 0) shows the current season's mods.
  seasons.tick(s, d, 0, fakeEnv());
  assert.equal(d.season.mods.forage, SEASON_MODS.winter.forageMild);
  assert.equal(d.season.mods.forageMild, undefined, 'mods keeps the d shape');
});

test('0.1 s ticks snap onto the season boundary (offline season count = online)', () => {
  const s = newState();
  const d = makeDerived();
  run(s, d, 360, 0.1);
  assert.equal(s.meta.season.t, 360, 'no float drift left at the boundary');
  assert.equal(d.season.id, 'summer');
  run(s, d, 1080, 0.1);
  assert.equal(s.meta.season.year, 1);
  assert.equal(s.meta.season.t, 0);
  assert.equal(s.meta.season.year * 4 + Math.floor(s.meta.season.t / s.meta.season.lengthSec), 4);
});

test('a corrupt clock never produces NaN in d.season', () => {
  const s = newState();
  const d = makeDerived();
  s.meta.season.t = NaN;
  s.meta.season.lengthSec = 0;
  seasons.tick(s, d, 0.1, fakeEnv());
  for (const k of ['tIn', 'toNext', 'len', 'frostRow', 'frostMax', 'snapRow']) assert.ok(Number.isFinite(d.season[k]), k);
  assert.ok(Number.isFinite(s.meta.season.t));
});
