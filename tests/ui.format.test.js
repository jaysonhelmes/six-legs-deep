// UI unit tests — number formatting (ARCHITECTURE §14.3, DESIGN §26: every row of the table). Owner: WP9.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  fmt, fmtCount, fmtRate, fmtMult, fmtPct, fmtTime, fmtClock, fmtCost, setNotation, getNotation, MAX_LABEL, INVALID, MINUS, SUFFIXES,
} from '../src/ui/format.js';
import { createState } from '../src/core/state.js';

beforeEach(() => setNotation('suffix'));
afterEach(() => setNotation('suffix'));

test('counts below 1,000 print as integers (847)', () => {
  assert.equal(fmt(847, { kind: 'count' }), '847');
  assert.equal(fmtCount(0), '0');
  assert.equal(fmtCount(999.9), '999');
  assert.equal(fmtCount(3.7), '3');
});

test('resources below 100 print one decimal (12.4); 100–999 print integers (640)', () => {
  assert.equal(fmt(12.4), '12.4');
  assert.equal(fmt(0), '0.0');
  assert.equal(fmt(5), '5.0');
  assert.equal(fmt(99.96), '99.9'); // truncated, never rounded up past what the player has
  assert.equal(fmt(640), '640');
  assert.equal(fmt(100), '100');
  assert.equal(fmt(999.99), '999');
});

test('≥ 1,000: 3 significant digits plus suffix (1.23K, 45.6M, 789B, 1.00Dc)', () => {
  assert.equal(fmt(1234), '1.23K');
  assert.equal(fmt(1000), '1.00K');
  assert.equal(fmt(45.6e6), '45.6M');
  assert.equal(fmt(789e9), '789B');
  assert.equal(fmt(1e33), '1.00Dc');
  assert.equal(fmt(1150), '1.15K'); // float-safe truncation
  assert.equal(fmt(999999), '999K'); // no "1000K"
  assert.equal(fmt(2e16), '20.0Qa');
  const expected = ['K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc'];
  assert.deepEqual(SUFFIXES.slice(1), expected);
  expected.forEach((suf, i) => assert.equal(fmt(10 ** (3 * (i + 1))), '1.00' + suf));
  assert.equal(fmtCount(1234), '1.23K', 'counts use the suffix rule from 1,000 too');
});

test('≥ 1e36: scientific with 3 significant digits (1.23e45)', () => {
  assert.equal(fmt(1.23e45), '1.23e45');
  assert.equal(fmt(1e36), '1.00e36');
  assert.equal(fmt(9.99e295), '9.99e295');
});

test('notation setting: scientific from 1e3, engineering (12.3e6)', () => {
  setNotation('scientific');
  assert.equal(getNotation(), 'scientific');
  assert.equal(fmt(1234), '1.23e3');
  assert.equal(fmt(12.3e6), '1.23e7');
  assert.equal(fmt(640), '640', 'below 1,000 is unchanged');
  setNotation('engineering');
  assert.equal(fmt(12.3e6), '12.3e6');
  assert.equal(fmt(123e6), '123e6');
  assert.equal(fmt(1234), '1.23e3');
  setNotation('bogus');
  assert.equal(getNotation(), 'engineering', 'unknown notations are ignored');
});

test('rates: suffix /s, two significant digits below 10 (0.53/s, 4.20K/s)', () => {
  assert.equal(fmtRate(0.53), '0.53/s');
  assert.equal(fmtRate(3.2), '3.2/s');
  assert.equal(fmtRate(0.0123), '0.012/s');
  assert.equal(fmtRate(12.44), '12.4/s');
  assert.equal(fmtRate(4200), '4.20K/s');
  assert.equal(fmtRate(0), '0/s');
});

test('negative values: leading "−" (−3.2/s)', () => {
  assert.equal(fmtRate(-3.2), MINUS + '3.2/s');
  assert.equal(fmtRate(-3.2), '−3.2/s');
  assert.equal(fmt(-1234), '−1.23K');
  assert.equal(fmtPct(-0.2), '−20%');
});

test('multipliers: × prefix, 2 decimals below 10, then suffix rules (×1.25, ×4.20M)', () => {
  assert.equal(fmtMult(1.25), '×1.25');
  assert.equal(fmtMult(4.2e6), '×4.20M');
  assert.equal(fmtMult(1), '×1.00');
  assert.equal(fmtMult(12.5), '×12.5');
  assert.equal(fmtMult(640), '×640');
  assert.equal(fmtMult(9.999), '×10.0', 'rounding past 10 moves to the next rule');
});

test('percent: sign plus integer, or 1 decimal below 10 % (+15%, +2.5%)', () => {
  assert.equal(fmtPct(0.15), '+15%');
  assert.equal(fmtPct(0.025), '+2.5%');
  assert.equal(fmtPct(0.15, { signed: false }), '15%');
  assert.equal(fmtPct(0.0999), '+10%');
});

test('time: 45s, 4m 05s, 1h 23m, 2d 4h', () => {
  assert.equal(fmtTime(45), '45s');
  assert.equal(fmtTime(245), '4m 05s');
  assert.equal(fmtTime(4980), '1h 23m');
  assert.equal(fmtTime(2 * 86400 + 4 * 3600 + 59), '2d 4h');
  assert.equal(fmtTime(0), '0s');
  assert.equal(fmtTime(-1), INVALID, 'the −1 "never" sentinel prints a dash');
  assert.equal(fmtClock(134), '2:14');
});

test('costs above the cap print MAX; fmtCost reports affordability per resource', () => {
  assert.deepEqual(fmtCost(null), [{ text: MAX_LABEL, ok: false }]);
  assert.equal(MAX_LABEL, 'MAX');
  const s = createState();
  s.run.res.food = 50;
  s.run.res.soil = 10;
  const parts = fmtCost({ soil: 24, food: 40 }, s);
  assert.deepEqual(parts, [{ res: 'food', text: '40.0', ok: true }, { res: 'soil', text: '24.0', ok: false }], 'resource order, not key order');
  assert.deepEqual(fmtCost({}, s), []);
  s.cycle.alates = 3;
  assert.equal(fmtCost({ alates: 3 }, s)[0].ok, true);
});

test('never prints NaN or Infinity: prints "—" and reports the error once', () => {
  const orig = console.error;
  let calls = 0;
  console.error = () => { calls++; };
  try {
    for (const bad of [NaN, Infinity, -Infinity, undefined, null, 'x']) {
      const out = fmt(bad);
      assert.equal(out, '—');
      assert.ok(!/NaN|Infinity/.test(out));
    }
    assert.ok(!/NaN|Infinity/.test(fmtRate(NaN)));
    assert.ok(!/NaN|Infinity/.test(fmtMult(Infinity)));
    assert.ok(!/NaN|Infinity/.test(fmtPct(NaN)));
    assert.ok(!/NaN|Infinity/.test(fmtTime(NaN)));
    assert.ok(!/NaN|Infinity/.test(fmtCost({ food: Infinity }, createState())[0].text));
    assert.ok(calls <= 1, 'the error is reported at most once per session');
  } finally {
    console.error = orig;
  }
});

test('fuzz: every output is finite text for values across the whole stored range', () => {
  for (let e = -6; e <= 295; e += 0.37) {
    const x = 10 ** e;
    for (const s of [fmt(x), fmtCount(x), fmtRate(x), fmtMult(x), fmtPct(x), fmtTime(x)]) {
      assert.equal(typeof s, 'string');
      assert.ok(s.length > 0 && s.length < 16, 'short output for ' + x + ': ' + s);
      assert.ok(!/NaN|Infinity|undefined/.test(s), s);
    }
  }
});
