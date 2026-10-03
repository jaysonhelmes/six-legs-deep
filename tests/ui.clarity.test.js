// UI clarity regressions (bug-hunt F12, F13, F15 and the polish hand-offs): hidden rules get a visible reason and
// progress — Old Ridge assault immunity (hexes owned / 25), the Argentine Front "all three within 10 minutes" window
// with a countdown, the satellite placement rule (≥ 3 hexes from every entrance) checked before the click, the Royal
// Chamber growth-room refusal, zoom controls in the keyboard reference, and a specific message for every reason code
// a system validator can return. Pure tests (no DOM). Owner: WP9.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as T from '../src/ui/text.js';
import * as rules from '../src/ui/rules.js';
import { rivalStatus, warNotes, formatHint, raiseLines } from '../src/ui/panels/map.js';
import { levelMessage } from '../src/ui/panels/build.js';
import { SHORTCUTS } from '../src/ui/panels/settings.js';
import { activeThreats } from '../src/ui/hud.js';
import { tipForTarget } from '../src/ui/tooltips.js';
import * as rivals from '../src/systems/rivals.js';
import { handlers as prestigeHandlers } from '../src/systems/prestige.js';
import { BOSSES } from '../src/data/rivals.js';
import { FEDERATION } from '../src/data/federation.js';
import { HEX, GRID } from '../src/data/balance.js';
import { hexDist, ringOf } from '../src/core/hex.js';
import { createGame } from '../src/core/game.js';
import { newState, makeDerived, fakeEnv } from './helpers.js';

const GENERIC = new Set([T.REASONS.blocked, T.REASONS.invalid, 'Blocked.']);

/** Skeleton state with panel_war and an army (as in war.rivals.test.js). */
function world({ soldier = 0, seed = 3 } = {}) {
  const s = newState(seed);
  s.run.colony.adults.soldier = soldier;
  s.run.unlocked.panel_war = true;
  const d = makeDerived({ stats: { foodCap: 1e12, honeydewCap: 1e12, housing: 1e6, pheromoneCap: 1e6 }, rates: { food: { gross: 10 } } });
  return { s, d };
}

/** rivals.tick for `sec` seconds, advancing run.time. */
function run(s, d, sec, { dt = 1, offline = false } = {}) {
  const n = Math.round(sec / dt);
  for (let i = 0; i < n; i++) {
    rivals.tick(s, d, dt, fakeEnv({ dt, offline }));
    s.run.time += dt;
  }
}

/** A Front nest falls to an assault (the battleEnd path rivals.tick resolves). */
function fall(s, d, r) {
  const env = fakeEnv();
  env.events.push({ type: 'battleEnd', uid: 1, kind: 'assault', win: true, kills: r.n, party: 0, rival: r.uid, raid: 0,
    survivors: { militia: 0, soldier: 0, supermajor: 0 } });
  rivals.tick(s, d, 0.1, env);
}

// ------------------------------------------------------------------------------------------------ F12 Old Ridge
test('F12: the Old Ridge refusal names the territory rule and the progress, not "Blocked." and more soldiers', () => {
  const need = BOSSES.old_ridge_supercolony.immuneUntilOwned;
  assert.equal(rules.oldRidgeNeed(), need);
  assert.ok(!GENERIC.has(T.reasonText('blocked:immune')), 'blocked:immune has its own text');
  assert.match(T.reasonText('blocked:immune'), new RegExp(String(need) + ' hexes'));

  const { s, d } = world({ soldier: 50 });
  s.cycle.traits.budding = 1;
  s.cycle.alatesCycle = 2500;
  run(s, d, 0.2, { dt: 0.1 });
  const or = s.run.rivals.list.find((r) => r.type === 'old_ridge_supercolony');
  assert.ok(or, 'Old Ridge spawned');
  or.sighted = true;
  d.surface.ownedCount = 7;
  assert.deepEqual(rules.oldRidgeImmunity(s, d, or), { owned: 7, need, left: need - 7 });
  const p = rivals.previewAction(s, d, 'assault', or.uid, { soldier: 50 });
  assert.equal(p.reason, 'blocked:immune');
  // war panel: the reason line carries the progress, the hints ask for territory instead of soldiers
  const notes = warNotes(s, d, or, 'assault');
  assert.ok(notes.some((x) => x.includes('7/' + need) || x.includes('7 / ' + need)), 'progress shown: ' + notes.join(' | '));
  const hints = raiseLines(s, d, p, or, 'assault');
  assert.ok(!hints.some((x) => /more soldiers/.test(x)), 'no soldier hint while immune: ' + hints.join(' | '));
  assert.ok(hints.some((x) => x.includes(String(need - 7)) && /hex/.test(x)), 'territory hint: ' + hints.join(' | '));
  // rival row badge and map tooltip
  const st = rivalStatus(s, d, or);
  assert.match(st.text, /Immune/);
  assert.match(st.text, new RegExp('7/' + need));
  const tip = tipForTarget({ view: 'surface', kind: 'rival', id: or.uid }, s, d);
  assert.ok(tip.lines.some((l) => l.includes(String(need)) && /hex/.test(l)), 'tooltip explains the gate: ' + tip.lines.join(' | '));
  // raids are not gated; at 25 owned hexes the immunity ends and the soldier hint returns
  assert.equal(warNotes(s, d, or, 'raid').some((x) => /Immune/.test(x)), false);
  d.surface.ownedCount = need;
  assert.equal(rules.oldRidgeImmunity(s, d, or), null);
  assert.equal(rivalStatus(s, d, or).text, 'Hostile');
});

test('F12: "what would raise it" soldier counts are formatted (DESIGN §26), not raw integers', () => {
  assert.equal(formatHint('About 18756 more soldiers for a near-certain win'), 'About 18.7K more soldiers for a near-certain win');
  assert.equal(formatHint('About 120 more soldiers'), 'About 120 more soldiers');
  assert.equal(formatHint('Alarm Rally in battle: +25% attack for 20 s'), 'Alarm Rally in battle: +25% attack for 20 s');
});

// ------------------------------------------------------------------------------------------------ F13 Argentine Front
test('F13: the Front window rule and countdown are visible once a nest falls; nests are numbered 1/2/3', () => {
  const { s, d } = world();
  s.era.federation.megacolony = 1;
  run(s, d, 0.1, { dt: 0.1 });
  const front = s.run.rivals.list.filter((r) => r.type === 'great_rival').sort((a, b) => a.uid - b.uid);
  assert.equal(front.length, 3);
  for (const r of front) r.sighted = true;
  const win = BOSSES.great_rival.windowSec;
  assert.equal(rules.frontWindowSec(), win);
  assert.deepEqual(front.map((r) => rules.frontLabel(s, r)), [' (nest 1/3)', ' (nest 2/3)', ' (nest 3/3)']);
  // before any falls: the rule is stated in the war panel, no countdown, no chip
  assert.ok(warNotes(s, d, front[1], 'assault').some((x) => /all 3/i.test(x) && /10m|10:00|10 min/.test(x)), warNotes(s, d, front[1], 'assault').join(' | '));
  assert.equal(rules.frontWindows(s).length, 0);
  assert.equal(activeThreats(s).some((x) => x.id === 'front'), false);

  fall(s, d, front[0]);
  assert.equal(front[0].alive, false);
  run(s, d, 100);
  const info = rules.frontInfo(s, front[0]);
  assert.equal(info.open, true);
  assert.equal(info.fallen, 1);
  assert.ok(Math.abs(info.remaining - (win - 100)) < 0.2, 'countdown ' + info.remaining);
  // the fallen nest shows when it regrows; the standing ones show the deadline
  assert.match(rivalStatus(s, d, front[0]).text, /regrows in/i);
  assert.match(rivalStatus(s, d, front[1]).text, /within/i);
  const chip = activeThreats(s).find((x) => x.id === 'front');
  assert.ok(chip, 'HUD countdown chip');
  assert.ok(Math.abs(chip.t - (win - 100)) < 0.2);
  assert.ok(chip.locate && chip.locate.view === 'surface' && [front[1].hex, front[2].hex].includes(chip.locate.hex), 'locates a standing nest');
  assert.ok(warNotes(s, d, front[2], 'assault').some((x) => /left/.test(x)), 'war panel countdown');

  // the countdown matches the system: the nest regrows when it reaches 0
  run(s, d, win - 100 - 1);
  assert.equal(front[0].alive, false);
  assert.ok(rules.frontInfo(s, front[0]).remaining <= 1.01);
  run(s, d, 2);
  assert.equal(front[0].alive, true, 'regrew after the window');
  assert.equal(rules.frontInfo(s, front[0]).open, false);
  assert.equal(activeThreats(s).some((x) => x.id === 'front'), false);
});

test('F13: the window pauses offline, and so does the countdown', () => {
  const { s, d } = world();
  s.era.federation.megacolony = 1;
  run(s, d, 0.1, { dt: 0.1 });
  const front = s.run.rivals.list.filter((r) => r.type === 'great_rival');
  fall(s, d, front[0]);
  run(s, d, 60);
  const before = rules.frontInfo(s, front[0]).remaining;
  run(s, d, 300, { offline: true });
  assert.ok(Math.abs(rules.frontInfo(s, front[0]).remaining - before) < 0.2, 'offline time does not count');
});

// ------------------------------------------------------------------------------------------------ F15 satellites
test('F15: satellite refusals are specific, and the hex rule matches the placeSatellite validator on every hex', () => {
  for (const code of ['blocked:entrance', 'blocked:unowned', 'blocked:terrain', 'blocked:royalRoom', 'blocked:shaft']) {
    assert.ok(!GENERIC.has(T.reasonText(code)), code);
  }
  const minDist = FEDERATION.satellite_nest.fx.minDist;
  assert.match(T.reasonText('blocked:entrance'), new RegExp(minDist + '\\+? hexes'));

  const game = createGame({ nowMs: 1000 });
  game.newGame(1000, 7);
  const { s, d } = game;
  assert.equal(rules.satelliteHexReason(s, d, 20), 'locked');
  s.era.federation.satellite_nest = 1;
  // a run that just started owns rings 0–2 only: no hex qualifies (the F15 failure scenario)
  assert.deepEqual(rules.satelliteHexes(s, d), []);
  const near = [...d.surface.owned.keys()].find((h) => d.surface.owned[h] > 0 && hexDist(0, h) === 1);
  assert.ok(near > 0, 'an owned ring-1 hex');
  assert.equal(rules.satelliteHexReason(s, d, near), 'blocked:entrance');
  assert.match(rules.satelliteHexWhy(s, d, near, T.reasonText), new RegExp('1 hex away, satellites need ' + minDist + '\\+'));
  assert.equal(rules.satelliteHexReason(s, d, 400), 'blocked:unowned');
  // own a ring of hexes further out; some become valid
  for (let h = 0; h < HEX.count; h++) if (ringOf(h) >= 3 && ringOf(h) <= 4) d.surface.owned[h] = 2;
  const ok = rules.satelliteHexes(s, d);
  assert.ok(ok.length > 0);
  // the column: first one at least colGap from every shaft / entrance column (as the modal picks it)
  const gap = FEDERATION.satellite_nest.fx.colGap;
  const taken = s.run.nest.shafts.map((x) => x.col).concat(s.run.surface.entrances.map((e) => e.col)).filter((c) => c >= 0);
  let col = 0;
  while (col < GRID.cols && !taken.every((c) => Math.abs(c - col) >= gap)) col++;
  const validate = prestigeHandlers.placeSatellite.validate;
  for (let h = 0; h < HEX.count; h++) {
    const mine = rules.satelliteHexReason(s, d, h);
    const real = validate(s, d, { type: 'placeSatellite', hex: h, col });
    if (mine) assert.equal(real, mine, 'hex ' + h);
    else assert.ok(real === null || real === 'blocked:shaft' || real === 'blocked:royalRoom', 'hex ' + h + ' ' + real);
  }
  s.run.surface.entrances.push({ kind: 'satellite', hex: ok[0], col: 30 });
  assert.equal(rules.satelliteHexReason(s, d, ok[ok.length - 1]), 'max', 'every satellite placed');
});

// ------------------------------------------------------------------------------------------------ Royal room, help
test('build inspect: a level-up held back by the Royal Chamber room says so (blocked:royalRoom), not "relocate or clear space"', () => {
  const text = T.reasonText('blocked:royalRoom');
  assert.ok(!GENERIC.has(text));
  assert.match(text, /Royal Chamber/);
  assert.match(text, /L5/);
  const ch = { type: 'granary', status: 'active', level: 3 };
  assert.equal(levelMessage({ max: false, blocked: true, royalRoom: true, grows: true }, ch), text);
  assert.match(levelMessage({ max: false, blocked: true, royalRoom: false, grows: true }, ch), /relocate|clear/i);
  assert.match(levelMessage({ max: false, blocked: false, royalRoom: true, grows: true }, ch), /Royal Chamber/, 'withheld directions are explained');
  assert.equal(levelMessage({ max: true, blocked: false, royalRoom: false }, ch), 'Maximum level.');
  assert.equal(levelMessage({ max: false, blocked: false, royalRoom: false }, { ...ch, status: 'digging' }), 'Finish digging before the next level.');
  assert.equal(levelMessage({ max: false, blocked: false, royalRoom: false }, ch), '');
});

test('the keyboard reference covers the nest zoom controls (Ctrl+wheel / pinch, + − 0 Home, the crown button)', () => {
  const all = SHORTCUTS.map(([k, v]) => k + ' ' + v).join('\n');
  assert.match(all, /Ctrl/);
  assert.match(all, /pinch/i);
  assert.match(all, /Home/);
  assert.match(all, /\+/);
  assert.match(all, /crown|queen/i);
});

// ------------------------------------------------------------------------------------------------ every reason code
test('every "code:detail" reason a system validator can return has specific player text', () => {
  const re = /['"`]((?:unknown|paused|locked|cantAfford|invalid|max|noSlot|blocked|cooldown|busy|hardship|notFound|queueFull|clickCap|requirements):[A-Za-z0-9_]+)['"`]/g;
  const files = readdirSync(new URL('../src/systems/', import.meta.url)).filter((f) => f.endsWith('.js')).map((f) => 'systems/' + f);
  files.push('core/commands.js');
  const found = new Set();
  for (const f of files) {
    const src = readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
    for (const m of src.matchAll(re)) found.add(m[1]);
  }
  assert.ok(found.size > 40, 'scanned ' + found.size + ' codes');
  const missing = [...found].filter((c) => !T.REASON_DETAILS[c]);
  assert.deepEqual(missing, [], 'reason codes without text');
  for (const [k, v] of Object.entries(T.REASON_DETAILS)) assert.ok(!GENERIC.has(v), k + ' is generic');
});

test('bare codes that mean different things per command get command-specific text', () => {
  const cases = [
    ['blocked', 'drawTrail', /route/i], ['blocked', 'rerouteTrail', /route/i], ['blocked', 'demolishChamber', /Royal Chamber/],
    ['blocked', 'cancelJob', /cannot be cancelled/], ['blocked', 'levelChamber', /room to grow/i], ['blocked', 'backfill', /cut a chamber off/],
    ['blocked', 'digTo', /soil/], ['blocked', 'moveAphids', /Aphids already/], ['invalid', 'drawTrail', /food source/],
    ['invalid', 'backfill', /tunnel cells/], ['invalid:owned', 'moveAphids', /your territory/], ['invalid:owned', 'claimHex', /Already your territory/],
    ['invalid:empty', 'shiftJob', /No ants/], ['requirements', 'buyMound', /Mound Building/], ['invalid:nest', 'dispatchGuard', /defends the nest/],
  ];
  for (const [code, type, rx] of cases) assert.match(T.reasonText(code, type), rx, code + ' / ' + type);
  assert.equal(T.reasonText('cantAfford', 'drawTrail'), T.REASONS.cantAfford, 'falls back to the base text');
  assert.equal(T.reasonText('blocked:stone', 'digTunnel'), T.REASON_DETAILS['blocked:stone']);
  assert.equal(T.reasonText('blocked:royalRoom', 'levelChamber'), T.REASON_DETAILS['blocked:royalRoom']);
  assert.equal(T.eventToast({ type: 'commandRejected', reason: 'blocked', cmd: { type: 'cancelJob' } }, newState()).text,
    T.REASON_BY_COMMAND.cancelJob.blocked);
});
