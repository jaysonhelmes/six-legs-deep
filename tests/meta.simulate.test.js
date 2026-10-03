// WP7: the pacing bot's helpers and a short headless smoke run (tools/simulate.mjs must run against any tree; the
// full DESIGN §28.2 report is meaningful only after integration).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, maxGap, fmtTime, simulate, formatReport } from '../tools/simulate.mjs';

test('parseArgs: defaults and flags', () => {
  assert.deepEqual(parseArgs([]), { hours: 2, seed: 1, dt: 0.1, until: null, strict: false, json: false, quiet: false, shadow: true });
  const o = parseArgs(['--hours', '12', '--seed', '7', '--dt', '1', '--until', 'supercolony', '--strict', '--json', '--quiet', '--no-shadow']);
  assert.deepEqual(o, { hours: 12, seed: 7, dt: 1, until: 'supercolony', strict: true, json: true, quiet: true, shadow: false });
  assert.equal(parseArgs(['--until', 'lunch']).until, null);
  assert.equal(parseArgs(['--dt', '5']).dt, 0.1);
});

test('maxGap and fmtTime', () => {
  assert.equal(maxGap([], 0, 100), 100);
  assert.equal(maxGap([10, 50, 60], 0, 100), 40);
  assert.equal(maxGap([90, 10], 0, 100), 80);
  assert.equal(maxGap([150], 0, 100), 100, 'outside the window is ignored');
  assert.equal(fmtTime(15), '0:15');
  assert.equal(fmtTime(3725), '1:02:05');
  assert.equal(fmtTime(-1), '—');
});

test('a 3-minute headless run completes and reports', () => {
  const r = simulate({ hours: 0.05, seed: 3, dt: 0.1, quiet: true, shadow: false });
  assert.ok(r.simulatedSec >= 179.9 && r.simulatedSec <= 180.1);
  assert.equal(r.stopped, null);
  assert.ok(Array.isArray(r.milestones) && r.milestones.length > 10);
  assert.ok(Array.isArray(r.checks) && r.checks.length >= 8);
  for (const c of r.checks) assert.ok(['pass', 'fail', 'skip'].includes(c.status));
  assert.equal(typeof formatReport(r), 'string');
  assert.deepEqual(JSON.parse(JSON.stringify(r)).seed, 3);
});
