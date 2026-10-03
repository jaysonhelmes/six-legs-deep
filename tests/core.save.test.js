// WP1 unit tests: core/save.js (RLE, FNV-1a, base64, export/import round-trip, error codes, fixture, storage wrapper)
// and core/migrations.js (#8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  RLE_PATHS, rleEncode, rleDecode, encodeState, decodeState, fnv1a, utf8ToBase64, base64ToUtf8, toExportString,
  fromExportString, storageWrap,
} from '../src/core/save.js';
import { MIGRATIONS, migrate, fillDefaults } from '../src/core/migrations.js';
import { SCHEMA_VERSION, createState } from '../src/core/state.js';
import { addEffect } from '../src/core/effects.js';
import { SAVE } from '../src/data/balance.js';
import { newState, makeFakeStorage } from './helpers.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** A state with non-default content everywhere the codec has to carry it. */
function busyState() {
  const s = newState(31337);
  s.run.res.food = 123.456;
  s.run.res.insight = 1e250;
  s.run.colony.adults.minor = 17.25;
  s.run.colony.brood.push({ c: 'minor', n: 3, p: 0.4, t: 12 });
  s.run.nest.cells[45] = 1;
  s.run.nest.cells[3199] = 4;
  s.run.surface.revealed[700] = 1;
  s.run.surface.claimed[5] = 1;
  s.run.surface.terrain[20] = 7;
  s.meta.settings.colonyName = 'Fourmilière ☃ 蟻';
  s.meta.strata.push({ kind: 'run', cells: rleEncode([0, 0, 1]), at: 99 });
  s.meta.pending = { kind: 'landing', options: [{ seed: 5, tags: ['site_rich_loam'] }], boons: ['boon_old_trails'], chooseSeason: false, alates: 12, hardship: null };
  addEffect(s, { id: 'rally:2', stat: 'forage_trail', scope: 2, mult: 2, t: 30 });
  return s;
}

test('RLE: documented example, round-trips, edge cases, malformed input throws', () => {
  assert.equal(rleEncode([0, 0, 0, 1]), 'rle:0*3,1');
  assert.deepEqual(rleDecode('rle:0*3,1'), [0, 0, 0, 1]);
  assert.equal(rleEncode([]), 'rle:');
  assert.deepEqual(rleDecode('rle:'), []);
  assert.equal(rleEncode([2.5, 2.5, -1]), 'rle:2.5*2,-1');
  const cells = createState().run.nest.cells;
  assert.deepEqual(rleDecode(rleEncode(cells)), cells);
  assert.ok(rleEncode(cells).length < 200);
  for (const bad of ['0*3', 'rle:0*', 'rle:*3', 'rle:a*2', 'rle:1*0', 'rle:1*2.5', 'rle:1,,2', 'rle:0*99999999']) {
    assert.throws(() => rleDecode(bad), undefined, bad);
  }
});

test('encodeState packs RLE_PATHS without touching the original; decodeState inverts it', () => {
  const s = busyState();
  const before = JSON.stringify(s);
  const enc = encodeState(s);
  assert.equal(JSON.stringify(s), before);
  assert.deepEqual(RLE_PATHS, ['run.nest.cells', 'run.surface.terrain', 'run.surface.revealed', 'run.surface.claimed', 'run.surface.conquered']);
  assert.equal(typeof enc.run.nest.cells, 'string');
  assert.ok(enc.run.surface.terrain.startsWith('rle:'));
  assert.equal(enc.meta.strata[0].cells, 'rle:0*2,1'); // strata cells are stored already encoded
  assert.deepStrictEqual(decodeState(enc), s);
});

test('FNV-1a 32-bit known vectors (over UTF-8 bytes)', () => {
  assert.equal(fnv1a(''), '811c9dc5');
  assert.equal(fnv1a('a'), 'e40c292c');
  assert.equal(fnv1a('foobar'), 'bf9cf968');
  assert.equal(fnv1a('€'), fnv1a('€'));
  assert.match(fnv1a('anything'), /^[0-9a-f]{8}$/);
});

test('base64 (UTF-8) known vectors and round-trips; invalid input throws', () => {
  assert.equal(utf8ToBase64(''), '');
  assert.equal(utf8ToBase64('Man'), 'TWFu');
  assert.equal(utf8ToBase64('Ma'), 'TWE=');
  assert.equal(utf8ToBase64('M'), 'TQ==');
  assert.equal(utf8ToBase64('€'), '4oKs');
  assert.equal(utf8ToBase64('hello world'), 'aGVsbG8gd29ybGQ=');
  for (const str of ['', 'a', 'ab', 'abc', 'Fourmilière ☃ 蟻 🐜', JSON.stringify(busyState())]) {
    assert.equal(base64ToUtf8(utf8ToBase64(str)), str);
  }
  for (const bad of ['abc', 'ab$=', '=abc', 'a===', '//8=']) assert.throws(() => base64ToUtf8(bad), undefined, bad);
});

test('save → export → import yields a deep-equal state (#8)', () => {
  for (const s of [createState(), busyState()]) {
    const str = toExportString(s, 1700000000000);
    assert.ok(str.startsWith(SAVE.prefix));
    const r = fromExportString(str);
    assert.equal(r.ok, true);
    assert.equal(r.savedAt, 1700000000000);
    assert.deepStrictEqual(r.state, s);
  }
});

test('export payload is { v, savedAt, state } and the skeleton save is well under the 60 KB target', () => {
  const s = createState();
  const str = toExportString(s, 5);
  const body = str.slice(SAVE.prefix.length);
  const json = base64ToUtf8(body.slice(0, body.lastIndexOf(':')));
  const payload = JSON.parse(json);
  assert.deepEqual(Object.keys(payload), ['v', 'savedAt', 'state']);
  assert.equal(payload.v, SCHEMA_VERSION);
  assert.equal(body.slice(body.lastIndexOf(':') + 1), fnv1a(json));
  assert.ok(str.length < SAVE.targetBytes / 4, 'skeleton save is ' + str.length + ' bytes');
});

test('corrupted checksum and other damage are rejected with the documented error codes (#8)', () => {
  const s = busyState();
  const str = toExportString(s, 1);
  const cut = str.lastIndexOf(':');
  const sum = str.slice(cut + 1);
  const flipped = sum.slice(0, -1) + (sum.endsWith('0') ? '1' : '0');
  assert.deepEqual(fromExportString(str.slice(0, cut + 1) + flipped), { ok: false, error: 'badChecksum' });
  // flip one base64 character in the payload
  const i = SAVE.prefix.length + 40;
  const ch = str[i] === 'A' ? 'B' : 'A';
  assert.equal(fromExportString(str.slice(0, i) + ch + str.slice(i + 1)).error, 'badChecksum');
  assert.deepEqual(fromExportString('SLD2:' + str.slice(5)), { ok: false, error: 'badPrefix' });
  assert.deepEqual(fromExportString(42), { ok: false, error: 'badPrefix' });
  assert.deepEqual(fromExportString('SLD1:abc'), { ok: false, error: 'badChecksum' });
  assert.deepEqual(fromExportString('SLD1:a$c=:12345678'), { ok: false, error: 'badBase64' });
  const badJson = '{"v":1,';
  assert.deepEqual(fromExportString(SAVE.prefix + utf8ToBase64(badJson) + ':' + fnv1a(badJson)), { ok: false, error: 'badJson' });
  const newer = JSON.stringify({ v: SCHEMA_VERSION + 1, savedAt: 0, state: encodeState(s) });
  assert.deepEqual(fromExportString(SAVE.prefix + utf8ToBase64(newer) + ':' + fnv1a(newer)), { ok: false, error: 'tooNew' });
  const older = JSON.stringify({ v: 0, savedAt: 0, state: encodeState(s) });
  assert.deepEqual(fromExportString(SAVE.prefix + utf8ToBase64(older) + ':' + fnv1a(older)), { ok: false, error: 'migrationFailed' });
  const enc = encodeState(s);
  enc.run.nest.cells = 'rle:0*5';
  const shortGrid = JSON.stringify({ v: 1, savedAt: 0, state: enc });
  assert.deepEqual(fromExportString(SAVE.prefix + utf8ToBase64(shortGrid) + ':' + fnv1a(shortGrid)), { ok: false, error: 'invalidState' });
  const noState = JSON.stringify({ v: 1, savedAt: 0 });
  assert.deepEqual(fromExportString(SAVE.prefix + utf8ToBase64(noState) + ':' + fnv1a(noState)), { ok: false, error: 'invalidState' });
});

test('import tolerates pasted whitespace, fills missing keys and guards non-finite values', () => {
  const s = createState();
  const enc = encodeState(s);
  delete enc.meta.settings.showScaleLabel;
  delete enc.run.golden;
  enc.run.res.food = null; // a NaN serialised by JSON.stringify
  const json = JSON.stringify({ v: 1, savedAt: 9, state: enc });
  const str = SAVE.prefix + utf8ToBase64(json) + ':' + fnv1a(json);
  const spaced = str.replace(/(.{60})/g, '$1\n  ');
  const orig = console.error;
  console.error = () => {};
  let r;
  try { r = fromExportString(spaced); } finally { console.error = orig; }
  assert.equal(r.ok, true);
  assert.equal(r.state.meta.settings.showScaleLabel, true);
  assert.deepEqual(r.state.run.golden, s.run.golden);
  assert.equal(r.state.run.res.food, 0);
  assert.equal(r.state.meta.stats.nanGuards, 1);
});

test('v1 fixture loads (every migration has a fixture)', () => {
  const file = join(FIXTURES, 'save_v1.txt');
  assert.ok(existsSync(file), 'tests/fixtures/save_v1.txt exists');
  const r = fromExportString(readFileSync(file, 'utf8'));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.state.v, SCHEMA_VERSION);
  assert.equal(r.savedAt, 1767225600000);
  assert.equal(r.state.run.seed, 4242);
  assert.equal(r.state.run.res.food, 77.5);
  assert.equal(r.state.meta.settings.colonyName, 'Fixture Colony');
  assert.deepEqual(r.state.run.colony.brood, [{ c: 'minor', n: 2, p: 0.5, t: 3 }]);
  assert.equal(r.state.run.nest.cells[20 * 40 + 22], 1);
  for (const v of Object.keys(MIGRATIONS)) {
    assert.ok(existsSync(join(FIXTURES, 'save_v' + v + '.txt')), 'fixture for migration from v' + v);
  }
});

test('migrate: no-op at the current version; runs the chain; missing step throws', () => {
  const p = { v: SCHEMA_VERSION, savedAt: 1, state: { a: 1 } };
  assert.equal(migrate(p), p);
  MIGRATIONS[0] = (payload) => ({ ...payload, state: { ...payload.state, migrated: true } });
  try {
    const out = migrate({ v: 0, savedAt: 1, state: { a: 1 } });
    assert.equal(out.v, SCHEMA_VERSION);
    assert.deepEqual(out.state, { a: 1, migrated: true });
  } finally {
    delete MIGRATIONS[0];
  }
  assert.throws(() => migrate({ v: 0, state: {} }));
  assert.throws(() => migrate(null));
  assert.throws(() => migrate({ v: 'x', state: {} }));
});

test('fillDefaults: copies missing keys recursively (plain objects only), never merges arrays or overwrites values', () => {
  const st = { a: { b: 1 }, list: [9], keep: null };
  const defs = { a: { b: 2, c: 3 }, list: [1, 2, 3], keep: { x: 1 }, extra: { deep: [1] } };
  fillDefaults(st, defs);
  assert.deepEqual(st, { a: { b: 1, c: 3 }, list: [9], keep: null, extra: { deep: [1] } });
  assert.notEqual(st.extra, defs.extra);
  const partial = { v: 1, meta: { settings: { notation: 'scientific' } } };
  fillDefaults(partial);
  assert.equal(partial.meta.settings.notation, 'scientific');
  assert.equal(partial.meta.settings.autosaveSec, 15);
  assert.equal(partial.run.nest.cells.length, 3200);
  assert.equal(fillDefaults(null), null);
});

test('storageWrap: every call guarded; null storage; lastError', () => {
  const ok = storageWrap(makeFakeStorage({ k: 'v' }));
  assert.equal(ok.get('k'), 'v');
  assert.equal(ok.get('nope'), null);
  assert.equal(ok.set('a', 'b'), true);
  assert.equal(ok.get('a'), 'b');
  assert.equal(ok.remove('a'), true);
  assert.equal(ok.lastError, null);
  const bad = storageWrap(makeFakeStorage({}, new Set(['get', 'set', 'remove'])));
  const orig = console.error;
  console.error = () => {};
  try {
    assert.equal(bad.get('k'), null);
    assert.equal(bad.set('k', 'v'), false);
    assert.match(bad.lastError, /Quota/);
    assert.equal(bad.remove('k'), false);
  } finally {
    console.error = orig;
  }
  const none = storageWrap(null);
  assert.equal(none.get('k'), null);
  assert.equal(none.set('k', 'v'), false);
  assert.equal(none.remove('k'), false);
  assert.equal(none.lastError, 'noStorage');
});
