// UI unit tests — toast rate limit (≤ 2 per 10 s; overflow queued or dropped; DESIGN §25.2, §25.6 rule 6) and the
// welcome-back stat lines (DESIGN §21.6). Owner: WP9.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToastQueue, TOAST_LIMIT } from '../src/ui/toasts.js';
import { welcomeLines, hasTimelapse } from '../src/ui/welcome.js';
import { isAbandonConfirmed, ABANDON_WORD } from '../src/ui/modals.js';
import { bottleneckText, seasonInfo } from '../src/ui/hud.js';
import { createState } from '../src/core/state.js';
import { createDerived } from '../src/core/derived.js';

test('limit is 2 toasts per 10 s', () => {
  assert.equal(TOAST_LIMIT.max, 2);
  assert.equal(TOAST_LIMIT.windowMs, 10000);
});

test('at most 2 toasts show in any 10 s window; low priority overflow is dropped', () => {
  const q = createToastQueue();
  assert.equal(q.push({ text: 'a', priority: 'low' }, 0), 'shown');
  assert.equal(q.push({ text: 'b', priority: 'low' }, 1000), 'shown');
  assert.equal(q.push({ text: 'c', priority: 'low' }, 2000), 'dropped');
  assert.equal(q.recent(2000), 2);
  assert.equal(q.push({ text: 'd', priority: 'low' }, 10000), 'shown', 'the first slot frees after 10 s');
  assert.equal(q.push({ text: 'e', priority: 'low' }, 10500), 'dropped');
  assert.equal(q.push({ text: 'f', priority: 'low' }, 11000), 'shown');
});

test('high priority overflow is queued and released as the window frees, in order', () => {
  const q = createToastQueue();
  q.push({ text: 'a', priority: 'high' }, 0);
  q.push({ text: 'b', priority: 'high' }, 0);
  assert.equal(q.push({ text: 'c', priority: 'high' }, 100), 'queued');
  assert.equal(q.push({ text: 'd', priority: 'high' }, 200), 'queued');
  assert.equal(q.push({ text: 'e', priority: 'low' }, 300), 'dropped', 'low priority never jumps the queue');
  assert.equal(q.pending(), 2);
  assert.deepEqual(q.pump(5000), []);
  assert.deepEqual(q.pump(10000).map((t) => t.text), ['c', 'd']);
  assert.equal(q.pending(), 0);
  // the window never holds more than 2
  let shown = 0;
  const times = [];
  const q2 = createToastQueue();
  for (let t = 0; t < 60000; t += 250) {
    const r = q2.push({ text: 'x' + t, priority: t % 1000 === 0 ? 'high' : 'low' }, t);
    if (r === 'shown') { shown++; times.push(t); }
    for (const x of q2.pump(t)) { shown++; times.push(t); void x; }
  }
  for (let i = 2; i < times.length; i++) assert.ok(times[i] - times[i - 2] >= 10000, 'third toast within 10 s at ' + times[i]);
  assert.ok(shown >= 10);
});

test('identical toasts within the window are deduplicated; the queue is bounded', () => {
  const q = createToastQueue({ maxQueue: 3 });
  assert.equal(q.push({ text: 'same' }, 0), 'shown');
  assert.equal(q.push({ text: 'same' }, 500), 'dropped');
  q.push({ text: 'x' }, 600);
  for (let i = 0; i < 10; i++) q.push({ text: 'h' + i, priority: 'high' }, 700 + i);
  assert.equal(q.pending(), 3);
  assert.equal(q.push(null, 0), 'dropped');
});

test('welcome-back lines report only what happened, with the storage nudge', () => {
  const lines = welcomeLines({ seconds: 3 * 3600 + 120, eff: 0.5, foodGained: 12345, foodWasted: 1240, hatched: 87, cellsDug: 40,
    chambersDone: 1, seasons: 2, sourcesDepleted: 0, savedFinds: 1, diapause: 0, cells: [1, 2], chambers: [] });
  const keys = lines.map((l) => l.key);
  assert.deepEqual(keys, ['away', 'food', 'wasted', 'hatched', 'cells', 'chambers', 'seasons', 'finds']);
  assert.match(lines[0].text, /3h 02m/);
  assert.match(lines[0].text, /50%/);
  assert.match(lines.find((l) => l.key === 'wasted').text, /1\.24K food lost to full granaries/);
  assert.equal(lines.find((l) => l.key === 'wasted').kind, 'nudge');
  assert.equal(hasTimelapse({ cells: [1], chambers: [] }), true);
  assert.equal(hasTimelapse({ cells: [], chambers: [] }), false);
  assert.deepEqual(welcomeLines(null).map((l) => l.key), ['away']);
});

test('hard reset confirmation needs exactly "abandon"', () => {
  assert.equal(ABANDON_WORD, 'abandon');
  assert.equal(isAbandonConfirmed('abandon'), true);
  assert.equal(isAbandonConfirmed('  abandon '), true);
  assert.equal(isAbandonConfirmed('Abandon'), false);
  assert.equal(isAbandonConfirmed('abando'), false);
  assert.equal(isAbandonConfirmed(''), false);
  assert.equal(isAbandonConfirmed(null), false);
});

test('bottleneck badge copy (DESIGN §2.2: "Bottleneck: Housing · eggs blocked 34s")', () => {
  const s = createState();
  const d = createDerived();
  assert.equal(bottleneckText(s, d), '');
  s.run.bottleneck = { id: 'bn_housing', since: 10, capT: 0 };
  s.run.time = 44;
  assert.equal(bottleneckText(s, d), 'Bottleneck: Housing · eggs blocked 34s');
  s.run.bottleneck.id = 'hungry';
  assert.equal(bottleneckText(s, d), 'Hungry: assign more foragers');
  s.run.bottleneck.id = 'raid';
  assert.equal(bottleneckText(s, d), 'Raid incoming!');
});

test('season dial: hand position and long-summer order', () => {
  const s = createState();
  const d = createDerived();
  d.season.id = 'summer';
  d.season.index = 1;
  d.season.tIn = 180;
  d.season.len = 360;
  d.season.toNext = 180;
  const si = seasonInfo(s, d);
  assert.equal(si.frac, 0.375);
  assert.equal(si.toNext, 180);
  s.cycle.edict = 'edict_of_long_summer';
  assert.deepEqual(seasonInfo(s, d).order, ['spring', 'summer', 'summer', 'autumn']);
});

test("'top' priority (the catch-up summary) shows at once even when the window is full, and counts against it", () => {
  const q = createToastQueue();
  q.push({ text: 'a', priority: 'high' }, 0);
  q.push({ text: 'b', priority: 'high' }, 100);
  assert.equal(q.push({ text: 'c', priority: 'high' }, 200), 'queued');
  assert.equal(q.push({ text: 'caught up', priority: 'top' }, 300), 'shown');
  assert.equal(q.recent(300), 3);
  assert.equal(q.pump(5000).length, 0, 'the queued toast still waits for the window');
});
