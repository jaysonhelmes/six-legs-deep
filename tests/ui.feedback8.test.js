// Player feedback pass 8 (ARCHITECTURE §18 C241–C250): cosmetic unlock lines, map-anchored hatch patterns, silent stale
// spam clicks, the fungal blight clean-up (cleanBlight was never dispatched), truce + attacks, map right-click menus
// (hex options under sources, no Claim on owned land, no Flag on revealed hexes, bribe cost), Mass Recruit and the raid
// arrow target. (C243 caste fill defaults: colony.casteTargets; C246 autobuyers: meta.automation / meta.feedback6.)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { FDocument } from './fakedom.js';
import { newState, makeDerived, fakeEnv } from './helpers.js';
import * as rivals from '../src/systems/rivals.js';
import * as events from '../src/systems/events.js';
import { handlers as trailHandlers } from '../src/systems/trails.js';
import { OWN_TRAIL } from '../src/systems/surface.js';
import { TRUCE, ACTIONS } from '../src/data/combat.js';
import { EVENTS } from '../src/data/events.js';
import { COSMETICS } from '../src/data/cosmetics.js';
import { ABILITIES } from '../src/data/surface.js';
import { cosmeticUnlock, staleClickReject, eventToast, reasonText } from '../src/ui/text.js';
import { patternMatrix, anchorPattern } from '../src/render/palette.js';
import { setRevealAll } from '../src/ui/reveal.js';
import { fmtTime } from '../src/ui/format.js';

const doc = new FDocument();
const prevDoc = globalThis.document;
const prevWin = globalThis.window;
globalThis.document = doc;
globalThis.window = doc.defaultView;
const map = await import('../src/ui/panels/map.js');
const settings = await import('../src/ui/panels/settings.js');
const hud = await import('../src/ui/hud.js');
after(() => {
  setRevealAll(false);
  globalThis.document = prevDoc;
  globalThis.window = prevWin;
});

function warWorld({ soldier = 20 } = {}) {
  const s = newState(3);
  s.run.colony.adults.soldier = soldier;
  s.run.unlocked.panel_war = true;
  const d = makeDerived({ stats: { foodCap: 1e12, honeydewCap: 1e12, housing: 1e6, pheromoneCap: 1e6 }, rates: { food: { gross: 10 } } });
  const r = rivals.createRival(s, { type: 'pavement_ants', hex: 60 });
  r.sighted = true;
  return { s, d, r };
}

// ------------------------------------------------------------------------------------------------ C241 cosmetics
test('C241: every cosmetic names the achievement that unlocks it; unearned secret achievements stay hidden', () => {
  const s = newState(1);
  for (const id of Object.keys(COSMETICS)) {
    const u = cosmeticUnlock(id, s);
    assert.ok(u.achId, id + ' has an achievement');
    assert.ok(u.text.length > 10, id);
  }
  const winter = cosmeticUnlock('cos_snowcap_mound', s);
  assert.match(winter.text, /First Winter: Reach the spring of year 1\./);
  const crown = cosmeticUnlock('cos_crown', s);
  assert.equal(crown.secret, true);
  assert.equal(crown.text, 'Unlocked by a secret achievement.');
  s.meta.achievements[crown.achId] = 10;
  assert.match(cosmeticUnlock('cos_crown', s).text, /Queen's Favourite: Click the queen 500 times/);
  s.meta.cosmetics.owned = { cos_crown: true };
  assert.match(settings.cosmeticUnlockLine('cos_crown', s), /^✓ Crown \(Queen, owned\): Unlocked by/);
  assert.match(settings.cosmeticUnlockLine('cos_gold_trail', s), /^• Gold Trails \(Trail colour, locked\): Unlocked by the achievement One Family/);
});

// ------------------------------------------------------------------------------------------------ C242 patterns
test('C242: hatch patterns are anchored to the map (translate to the world origin, scale by zoom)', () => {
  assert.deepEqual(patternMatrix(120, -40, 2), { a: 2, b: 0, c: 0, d: 2, e: 120, f: -40 });
  assert.deepEqual(patternMatrix(NaN, 5, 0), { a: 1, b: 0, c: 0, d: 1, e: 0, f: 5 });
  let got = null;
  const pat = { setTransform: (m) => { got = m; } };
  assert.equal(anchorPattern(pat, 10, 20, 1.5), pat);
  assert.equal(got.a, 1.5);
  assert.equal(got.e, 10);
  assert.equal(got.f, 20);
  assert.equal(anchorPattern(null, 1, 2, 3), null, 'no pattern: no-op');
  assert.deepEqual(anchorPattern({}, 1, 2, 3), {}, 'no setTransform: unchanged');
});

// ------------------------------------------------------------------------------------------------ C244 stale clicks
test('C244: a spam click on an already-collected object is silent; real refusals still toast', () => {
  const stale = { type: 'commandRejected', reason: 'notFound', cmd: { type: 'clickEventObject', uid: 5 } };
  assert.equal(staleClickReject(stale), true);
  assert.equal(eventToast(stale, newState(1)), null);
  const cap = { type: 'commandRejected', reason: 'clickCap', cmd: { type: 'clickEventObject', uid: 5 } };
  assert.equal(staleClickReject(cap), false);
  const other = { type: 'commandRejected', reason: 'notFound', cmd: { type: 'deleteTrail', uid: 5 } };
  assert.ok(eventToast(other, newState(1)), 'other commands still explain themselves');
  // the double click: the second queued click finds nothing when it applies → apply-time rejection (now silent)
  const s = newState(2);
  const d = makeDerived();
  s.run.events.objects.push({ uid: 77, kind: 'rival_alate', hex: 4, cell: -1, t: 20, data: { occ: 1 } });
  const h = events.handlers.clickEventObject;
  assert.equal(h.validate(s, d, { type: 'clickEventObject', uid: 77 }), null);
  h.apply(s, d, { type: 'clickEventObject', uid: 77 }, fakeEnv());
  assert.equal(h.validate(s, d, { type: 'clickEventObject', uid: 77 }), 'notFound');
});

// ------------------------------------------------------------------------------------------------ C245 blight
test('C245: fungal blight — a garden click picks Clean and counts; 20 clicks in time clean it; blightStatus reports progress', () => {
  const s = newState(4);
  const d = makeDerived();
  s.run.res.fungus = 100;
  const n = EVENTS.ev_fungal_blight.num;
  assert.equal(events.blightStatus(s), null);
  assert.ok(events.forceEvent(s, d, 'ev_fungal_blight', fakeEnv()) !== false);
  assert.equal(s.run.events.card && s.run.events.card.id, 'ev_fungal_blight');
  assert.deepEqual(events.blightStatus(s).phase, 'card');
  const h = events.handlers.cleanBlight;
  const click = () => {
    const env = fakeEnv();
    assert.equal(h.validate(s, d, { type: 'cleanBlight' }), null);
    h.apply(s, d, { type: 'cleanBlight' }, env);
    return env.events;
  };
  click();
  assert.equal(s.run.events.card, null, 'the first garden click picks Clean');
  let st = events.blightStatus(s);
  assert.equal(st.phase, 'clean');
  assert.equal(st.clicks, 1);
  assert.equal(st.left, n.clicks - 1);
  assert.ok(st.t > 0 && st.t <= n.cleanSec);
  let evs = [];
  for (let i = 1; i < n.clicks; i++) { s.run.time += 0.2; evs = click(); }   // 5 clicks a second (cap 15/s)
  assert.ok(evs.some((e) => e.type === 'eventResolved' && e.choice === 'cleaned'));
  assert.equal(events.blightStatus(s), null);
  assert.equal(s.run.res.fungus, 100, 'nothing lost');
  assert.equal(h.validate(s, d, { type: 'cleanBlight' }), 'notFound');
});

test('C245: the HUD chip counts the clicks left and the time and locates the Fungus Garden', () => {
  const s = newState(4);
  s.run.nest.chambers.push({ uid: 9, type: 'fungus_garden', x: 4, y: 8, w: 3, h: 2, level: 1, status: 'active' });
  s.run.events.active.push({ uid: 50, id: 'ev_fungal_blight', t: 12, data: { k: 'blight', occ: 3, clicks: 15 } });
  const chips = hud.activeThreats(s, makeDerived());
  const chip = chips.find((c) => c.id === 'blight');
  assert.ok(chip, 'blight chip');
  assert.equal(chip.label, 'Blight: 5 clicks left');
  assert.equal(chip.t, 12);
  assert.match(chip.tip, /Click the Fungus Garden \(Below\) 5 more times/);
  assert.ok(chip.locate && chip.locate.chamber === 9);
});

// ------------------------------------------------------------------------------------------------ C247 truce
test('C247: attacking a rival under truce needs confirmation (policy break), ends the truce and halves its raid clock', () => {
  const { s, d, r } = warWorld();
  const lp = rivals.handlers.launchParty;
  const cmd = { type: 'launchParty', kind: 'raid', target: { type: 'rival', uid: r.uid }, soldier: 5, supermajor: 0 };
  assert.equal(lp.validate(s, d, cmd), null, 'no truce: fine');
  r.truce = 200;
  r.raidIn = 100;
  assert.equal(TRUCE.attackPolicy, 'break');
  assert.equal(lp.validate(s, d, cmd), 'confirm:truce');
  assert.equal(lp.validate(s, d, { ...cmd, breakTruce: 'yes' }), 'invalid');
  const ok = { ...cmd, breakTruce: true };
  assert.equal(lp.validate(s, d, ok), null);
  const p = rivals.previewAction(s, d, 'raid', r.uid, { soldier: 5 });
  assert.equal(p.ok, true, 'odds still shown');
  assert.equal(p.truceBreak, true);
  const env = fakeEnv();
  lp.apply(s, d, ok, env);
  assert.equal(r.truce, 0, 'the truce (and the bribe) is gone');
  assert.equal(r.raidIn, 100 * TRUCE.breakRaidMult, 'next raid sooner');
  assert.ok(env.events.some((e) => e.type === 'truceBroken' && e.rival === r.uid));
  assert.ok(eventToast({ type: 'truceBroken', rival: r.uid }, s));
  assert.equal(s.run.war.parties.length, 1);
  // policy 'block': the alternative rule, switched by the data flag
  assert.equal(rivals.truceAttackReason({ truce: 5 }, true, 'block'), 'blocked:truce');
  assert.equal(rivals.truceAttackReason({ truce: 5 }, false, 'break'), 'confirm:truce');
  assert.equal(rivals.truceAttackReason({ truce: 5 }, true, 'break'), null);
  assert.equal(rivals.truceAttackReason({ truce: 0 }, false, 'block'), null);
  assert.match(reasonText('confirm:truce', 'launchParty'), /attacking breaks it/);
});

test('C247: the war form says "Truce: m:ss left — attacking breaks it"', () => {
  const r = { truce: 125 };
  assert.equal(map.truceNote(r, 'raid'), 'Truce: ' + fmtTime(125) + ' left — attacking breaks it.');
  assert.equal(map.truceNote(r, 'assault', 'block'), 'Truce: ' + fmtTime(125) + ' left — no attacks until it ends.');
  assert.equal(map.truceNote(r, 'hunt'), '');
  assert.equal(map.truceNote({ truce: 0 }, 'raid'), '');
  assert.match(map.TRUCE_BREAK_CONFIRM.title, /Break the truce\?/);
  assert.match(map.TRUCE_BREAK_CONFIRM.message, /bribe is lost/);
});

// ------------------------------------------------------------------------------------------------ C249 menus
test('C249: hex menu — no Claim on permanent land (trail-held can be claimed for good), no Flag on revealed hexes', () => {
  setRevealAll(true);
  const s = newState(5);
  const d = makeDerived();
  s.run.research.antennation = true;
  const owned = new Uint8Array(d.surface.owned.length || 400);
  d.surface.owned = owned;
  const labels = (hex) => map.hexMenuItems(s, d, hex).map((x) => x.label);
  s.run.surface.revealed[12] = 0;
  assert.deepEqual(labels(12), ['Claim hex', 'Flag for scouts']);
  s.run.surface.revealed[12] = 1;
  assert.deepEqual(labels(12), ['Claim hex'], 'revealed: no flag');
  owned[12] = 2;
  assert.deepEqual(labels(12), [], 'claimed for good: no claim');
  owned[12] = OWN_TRAIL;
  assert.deepEqual(labels(12), ['Claim hex for good']);
  s.run.surface.flagged = [12];
  assert.ok(labels(12).includes('Unflag'), 'a flagged hex can still be unflagged');
  setRevealAll(false);
});

test('C249: rival menu — bribe shows its honeydew cost and yours, disabled with a reason; attacks note the truce', () => {
  const { s, d, r } = warWorld();
  const cost = rivals.bribeCost(s, d, r).honeydew;
  s.run.res.honeydew = 0;
  let items = map.rivalMenuItems(s, d, r.uid);
  assert.deepEqual(items.slice(0, 2).map((x) => x.label), ['Raid…', 'Assault…']);
  assert.equal(items[0].chooser.kind, 'war');
  let b = items[2];
  assert.equal(b.disabled, true);
  assert.match(b.label, /^Bribe: .* honeydew \(you have [^)]*\): not enough$/);
  s.run.res.honeydew = cost * 2;
  b = map.bribeMenuItem(s, d, r);
  assert.equal(b.disabled, undefined);
  assert.equal(b.type, 'bribe');
  r.truce = 90;
  items = map.rivalMenuItems(s, d, r.uid);
  assert.equal(items[0].label, 'Raid… (breaks the truce)');
  assert.equal(items[2].disabled, true);
  assert.ok(items[2].label.includes('truce active (' + fmtTime(90) + ' left)'));
  r.truce = 0;
  r.bribeCd = 30;
  assert.match(map.bribeMenuItem(s, d, r).label, /Bribe again in/);
  assert.equal(ACTIONS.bribe.apMult > 0, true);
});

// ------------------------------------------------------------------------------------------------ C250 Mass Recruit
test('C250: Mass Recruit is offered on a trail to a termite swarm / picnic spill only, with its reason when it cannot run', () => {
  setRevealAll(true);
  const s = newState(6);
  const d = makeDerived();
  s.run.unlocked.ability_mark = true;
  const S = s.run.surface;
  const swarm = { uid: S.nextUid++, type: 'termite_swarm', hex: 7, stock: 30, max: 30, level: 1, herdT: 0, age: 0, ttl: 45, cd: 0, data: {} };
  const seed = { uid: S.nextUid++, type: 'seed_patch', hex: 8, stock: 30, max: 30, level: 1, herdT: 0, age: 0, ttl: -1, cd: 0, data: {} };
  S.sources.push(swarm, seed);
  const trail = { uid: 900, src: swarm.uid, job: 'forager', path: [0, 7], workers: 0, escorts: 0, S: 10 };
  S.trails.push(trail);
  assert.equal(map.massRecruitItem(s, d, { ...trail, src: seed.uid }), null, 'not for ordinary sources');
  s.run.res.pheromone = 0;
  let it = map.massRecruitItem(s, d, trail);
  assert.equal(it.disabled, true);
  assert.equal(it.reason, 'cantAfford');
  assert.match(it.label, /Mass Recruit \(20 pheromone\): Not enough pheromone\./);
  s.run.res.pheromone = 100;
  it = map.massRecruitItem(s, d, trail);
  assert.equal(it.type, 'massRecruit');
  assert.deepEqual(it.args, { src: swarm.uid });
  assert.equal(trailHandlers.massRecruit.validate(s, d, { type: 'massRecruit', ...it.args }), null);
  assert.match(it.tip, /50% of your loose foragers/);
  assert.equal(ABILITIES.mass_recruit.cost.pheromone, 20);
  setRevealAll(false);
});
