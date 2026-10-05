// C165 / C162: the hex tooltip says what the ground does to trails ("Sand — slow ground: counts as 1.25 hexes for
// trails."), every terrain has a line in the Manual's terrain table, and a trail-held hex says "Held by trail — claim
// to keep." Owner: WP9 (ARCHITECTURE §18 C162, C165).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { FDocument } from './fakedom.js';
import { newState, makeDerived } from './helpers.js';
import { TERRAIN, TERRAIN_ORDER } from '../src/data/surface.js';
import { terrainTipLines, terrainCostText, TERRAIN_NOTES } from '../src/ui/text.js';

const doc = new FDocument();
const prevDoc = globalThis.document;
const prevWin = globalThis.window;
globalThis.document = doc;
globalThis.window = doc.defaultView;

const { hexTerrainLines, tipForTarget } = await import('../src/ui/tooltips.js');
const { buildEntry, entryText } = await import('../src/ui/manualContent.js');
const { setRevealAll } = await import('../src/ui/reveal.js');

before(() => { setRevealAll(true); });
after(() => {
  setRevealAll(false);
  globalThis.document = prevDoc;
  globalThis.window = prevWin;
});

test('C165: sand says it is slow ground and counts as 1.25 hexes for trails', () => {
  assert.equal(TERRAIN.sand.move, 1.25);
  assert.deepEqual(terrainTipLines('sand'), ['Sand — slow ground: counts as 1.25 hexes for trails.']);
  assert.equal(terrainTipLines('grass')[0], 'Grass — open ground: counts as 1 hex for trails.');
  assert.equal(terrainTipLines('garden_path')[0], 'Garden path — fast ground: counts as 0.5 hexes for trails.');
  assert.equal(terrainTipLines('leaf_litter')[0], 'Leaf litter — slow ground: counts as 1.5 hexes for trails.');
  assert.match(terrainTipLines('log')[1], /Prey/);
  assert.equal(terrainCostText('stone'), null, 'stone is impassable');
});

test('C165: every terrain has a tooltip; impassable terrain keeps the C129 line; a dry puddle shows its cost and spring note', () => {
  for (const id of TERRAIN_ORDER) {
    const lines = terrainTipLines(id);
    assert.ok(lines.length >= 1 && lines.every((l) => typeof l === 'string' && l.length > 0), id);
    assert.ok(lines[0].startsWith(TERRAIN[id].name), id + ' starts with its name');
    assert.ok(id in TERRAIN_NOTES, id + ' has a note entry');
  }
  const d = { surface: { passable: [1, 0, 0, 1] } };
  assert.deepEqual(hexTerrainLines('stone', 1, d), ['Stone — impassable. Trails route around it.']);
  assert.deepEqual(hexTerrainLines('puddle', 2, d), ['Puddle — flooded in spring. Trails route around it.']);
  const dry = hexTerrainLines('puddle', 3, d);
  assert.equal(dry[0], 'Puddle — open ground: counts as 1 hex for trails.');
  assert.match(dry[1], /spring/);
});

test('C165 / C162: the hex tooltip carries the terrain line; a trail-held hex says "Held by trail — claim to keep."', () => {
  const s = newState(1);
  const d = makeDerived();
  const S = s.run.surface;
  const sand = TERRAIN.sand.code;
  S.terrain[5] = sand;
  S.revealed[5] = 1;
  d.surface.owned[5] = 4;
  let tip = tipForTarget({ view: 'surface', kind: 'hex', hex: 5 }, s, d);
  assert.ok(tip.lines.includes('Sand — slow ground: counts as 1.25 hexes for trails.'), tip.lines.join(' | '));
  assert.ok(tip.lines.includes('Held by trail — claim to keep.'));
  d.surface.owned[5] = 2;
  tip = tipForTarget({ view: 'surface', kind: 'hex', hex: 5 }, s, d);
  assert.ok(tip.lines.includes('Your territory.'));
  assert.ok(!tip.lines.includes('Held by trail — claim to keep.'));
});

test('C165: the Manual has a Terrain entry listing every terrain with its trail cost', () => {
  const s = newState(1);
  const d = makeDerived();
  const e = buildEntry(s, d, 'surface:terrain');
  assert.ok(e, 'entry visible from the start');
  const table = e.blocks.find((b) => b && b.table);
  assert.equal(table.table.rows.length, TERRAIN_ORDER.length);
  const text = entryText(e, s, d);
  for (const id of TERRAIN_ORDER) assert.ok(text.includes(TERRAIN[id].name), id);
  assert.ok(text.includes('1.25 hexes'));
  assert.ok(text.includes('Impassable'));
});
