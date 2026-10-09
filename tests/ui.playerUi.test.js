// Player-approved UI changes (ARCHITECTURE §18 C143–C149): the Adaptations tab (order, reveal, number keys, ×10 / Max),
// War Hall berth lines, Research without an "All" view, achievement requirements and the "Recently earned" list,
// the reared-alate wording and the "What increases flight alates" box, landing options filtered under Hardships, and
// the cosmetics pipeline (every cosmetic maps to a slot and a render variant). Uses tests/fakedom.js. Owner: WP9.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { FDocument } from './fakedom.js';
import { newState, makeDerived, fakeEnv, makeFakeStorage } from './helpers.js';

const doc = new FDocument();
const prevDoc = globalThis.document;
const prevWin = globalThis.window;
globalThis.document = doc;
globalThis.window = doc.defaultView;

const uistate = await import('../src/ui/uistate.js');
const { visibleTabs, TAB_KEYS } = await import('../src/ui/app.js');
const { setRevealAll, setRevealProvider } = await import('../src/ui/reveal.js');
const colonyPanel = await import('../src/ui/panels/colony.js');
const adaptPanel = await import('../src/ui/panels/adaptations.js');
const researchPanel = await import('../src/ui/panels/research.js');
const achPanel = await import('../src/ui/panels/achievements.js');
const prestigePanel = await import('../src/ui/panels/prestige.js');
const settingsPanel = await import('../src/ui/panels/settings.js');
const { flightFactorRows } = await import('../src/ui/manualContent.js');
const T = await import('../src/ui/text.js');
const prestige = await import('../src/systems/prestige.js');
const { ACHIEVEMENTS, ACH_ORDER } = await import('../src/data/achievements.js');
const { COSMETICS, COSMETIC_SLOT_ORDER } = await import('../src/data/cosmetics.js');
const { LANDING_USELESS, SITE_ORDER, BOON_ORDER } = await import('../src/data/prestige.js');
const cos = await import('../src/render/cosmetics.js');
const { CORE_HANDLERS } = await import('../src/core/commands.js');

before(() => { setRevealAll(false); });
after(() => {
  setRevealAll(false);
  setRevealProvider(null);
  globalThis.document = prevDoc;
  globalThis.window = prevWin;
});

const button = (el, text) => el.querySelectorAll('button').find((b) => b.textContent.trim().startsWith(text)) || null;
const panelCtx = (s, d, calls = []) => ({
  game: { s, d, actions: { do: (type, args) => { calls.push({ type, args }); return { ok: true, reason: null }; } } },
  ui: uistate, bridge: { reject() {}, select() {}, openTab() {} },
});

// ------------------------------------------------------------------------------------------------ C143 Adaptations tab
test('C143: tab order puts Adaptations after Map; it reveals with adapt_basic; number keys follow the order', () => {
  assert.deepEqual(uistate.TAB_IDS.slice(0, 5), ['colony', 'build', 'map', 'adaptations', 'research']);
  assert.equal(uistate.TAB_IDS[3], 'adaptations', 'key 4 opens Adaptations');
  assert.equal(TAB_KEYS.adaptations, 'adapt_basic');
  assert.equal(T.TAB_NAMES.adaptations, 'Adaptations');
  assert.ok(T.wordCount(T.TAB_TIPS.adaptations) <= 12);
  const s = newState(3);
  const shown = new Set(['panel_colony']);
  setRevealProvider((st, key) => shown.has(key));
  assert.deepEqual(visibleTabs(s).filter((id) => !['guide', 'stats', 'settings'].includes(id)), ['colony']);
  shown.add('adapt_basic').add('panel_map');
  assert.deepEqual(visibleTabs(s).filter((id) => !['guide', 'stats', 'settings'].includes(id)), ['colony', 'map', 'adaptations']);
  setRevealProvider(null);
});

test('C143: the Colony tab no longer lists Adaptations; the Adaptations panel has Buy, ×10 and Max (n)', () => {
  const s = newState(4);
  const d = makeDerived();
  s.run.colony.adults.minor = 20;
  s.run.res.food = 1e6;
  s.run.unlocked.adapt_basic = true;
  setRevealProvider(() => true);
  const calls = [];
  const ctx = panelCtx(s, d, calls);
  const ch = doc.createElement('div');
  const cp = colonyPanel.createPanel(ch, ctx);
  cp.update(s, d);
  assert.equal(ch.querySelector('.adapt-list'), null, 'no adaptation list on the Colony tab');
  cp.destroy();
  const host = doc.createElement('div');
  const p = adaptPanel.createPanel(host, ctx);
  p.update(s, d);
  const row = host.querySelector('.buy-row[data-id="quick_dispatch"]');
  assert.ok(row, 'Quick Dispatch row');
  button(row, 'Buy').click();
  assert.deepEqual(calls.at(-1), { type: 'buyAdaptation', args: { id: 'quick_dispatch', n: 1 } });
  s.run.adaptations.quick_dispatch = 1;
  p.update(s, d);
  button(row, '×10').click();
  assert.deepEqual(calls.at(-1), { type: 'buyAdaptation', args: { id: 'quick_dispatch', n: 10 } });
  const n = adaptPanel.adaptBulk(s, 'quick_dispatch').n;
  assert.ok(n >= 10);
  assert.match(button(row, 'Max').textContent, new RegExp('Max \\(' + n + '\\)'));
  button(row, 'Max').click();
  assert.deepEqual(calls.at(-1), { type: 'buyAdaptation', args: { id: 'quick_dispatch', n } });
  assert.equal(colonyPanel.adaptBulk, adaptPanel.adaptBulk, 'colony.js keeps re-exporting adaptBulk');
  p.destroy();
  setRevealProvider(null);
});

test('C143: berth lines show Barracks (soldiers) and War Hall (supermajors) only when the War Hall field exists', () => {
  const s = newState(5);
  setRevealProvider((st, key) => key === 'chamber_barracks' || key === 'caste_supermajor');
  const adults = { minor: 10, soldier: 3, supermajor: 2, replete: 0 };
  assert.deepEqual(colonyPanel.berthLines(s, { berths: 8 }, adults), ['Barracks berths 5/8 (soldiers and supermajors)']);
  assert.deepEqual(colonyPanel.berthLines(s, { berths: 8, warBerths: 4 }, adults),
    ['Barracks berths 3/8 (soldiers)', 'War Hall berths 2/4 (supermajors)']);
  setRevealProvider(() => false);
  assert.deepEqual(colonyPanel.berthLines(s, { berths: 0, warBerths: 0 }, { minor: 1 }), [], 'nothing before the castes are revealed');
  setRevealProvider(null);
});

// ------------------------------------------------------------------------------------------------ C144 research
test('C144 → C281: research shows every branch as a foldable section (no filter row); folds are remembered per browser', () => {
  const store = makeFakeStorage();
  globalThis.window.localStorage = store;
  try {
    assert.ok(!researchPanel.branchFilters().includes('all'));
    const s = newState(6);
    const d = makeDerived();
    const branches = researchPanel.branchFilters();
    const want = researchPanel.defaultBranch(s, null);
    assert.ok(branches.includes(want));
    assert.equal(researchPanel.defaultBranch(s, branches[2]), branches[2], 'a remembered branch wins');
    assert.equal(researchPanel.defaultBranch(s, 'all'), want, 'an invalid remembered value is ignored');
    assert.equal(researchPanel.branchMeta(2, 3, 10), '2 available · 3 / 10 owned');
    const host = doc.createElement('div');
    const p = researchPanel.createPanel(host, panelCtx(s, d));
    p.update(s, d);
    assert.equal(host.querySelectorAll('.seg-btn').length, 0, 'no branch filter row');
    const secs = host.querySelectorAll('.tech-branch');
    assert.equal(secs.length, branches.length, 'one section per branch');
    assert.deepEqual(secs.map((x) => x.dataset.branch), branches, 'in branch order');
    assert.ok(host.querySelector('.hide-owned input'), 'Hide completed stays');
    for (const sec of secs) {
      const t = sec.querySelector('.sec-title');
      assert.equal(t.getAttribute('role'), 'button');
      assert.match(t.textContent, /available · \d+ \/ \d+ owned/);
    }
    const first = secs[0].querySelector('.sec-title');
    first.click();
    assert.equal(secs[0].classList.contains('collapsed'), true);
    assert.match(first.dataset.foldSum, /owned/, 'the folded heading keeps its summary');
    assert.equal(JSON.parse(store.getItem('sld.collapsed'))['research:' + branches[0]], true);
    p.destroy();
    const host2 = doc.createElement('div');
    const p2 = researchPanel.createPanel(host2, panelCtx(s, d));
    p2.update(s, d);
    assert.equal(host2.querySelector('.tech-branch').classList.contains('collapsed'), true, 'remembered per browser');
    p2.destroy();
  } finally {
    delete globalThis.window.localStorage;
  }
});

// ------------------------------------------------------------------------------------------------ C145 achievements
test('C145: goals and cards name the requirement; "Recently earned" lists the newest first with relative time', () => {
  assert.equal(achPanel.goalLabel('ach_wellspring'), 'Wellspring — ' + ACHIEVEMENTS.ach_wellspring.desc.replace(/\.$/, ''));
  assert.equal(achPanel.achRequirement('ach_queens_favorite', false), 'A secret achievement.');
  assert.equal(achPanel.achRequirement('ach_queens_favorite', true), ACHIEVEMENTS.ach_queens_favorite.desc);
  const s = newState(7);
  s.meta.simTime = 4000;
  const ids = ACH_ORDER.slice(0, 10);
  ids.forEach((id, i) => { s.meta.achievements[id] = i * 100; });
  const rec = achPanel.recentAchievements(s);
  assert.equal(rec.length, achPanel.RECENT_MAX);
  assert.equal(rec[0].id, ids[9], 'newest first');
  assert.equal(rec[0].ago, 4000 - 900);
  assert.equal(achPanel.agoText(30), 'just now');
  assert.equal(achPanel.agoText(300), '5 min ago');
  assert.equal(achPanel.agoText(7800), '2 h 10 min ago');
  const d = makeDerived();
  const host = doc.createElement('div');
  const p = achPanel.createPanel(host, panelCtx(s, d));
  p.update(s, d);
  const recent = host.querySelectorAll('.ach-recent-row');
  assert.equal(recent.length, achPanel.RECENT_MAX);
  assert.match(recent[0].textContent, new RegExp(ACHIEVEMENTS[ids[9]].name));
  assert.match(recent[0].textContent, /min ago/);
  const card = host.querySelector('.ach-row[data-id="ach_wellspring"]');
  assert.match(card.textContent, /Dig down to row 74/);
  for (const g of host.querySelectorAll('.goal-row')) assert.match(g.textContent, / — /, 'a goal shows its requirement');
  p.destroy();
});

// ------------------------------------------------------------------------------------------------ C146 prestige wording
test('C146: reared-alate wording is additive (+2% each, 25 = +50%) and the factor box lists every flight factor', () => {
  assert.equal(prestigePanel.rearedRuleText(25), 'Each reared alate gives +2% more alates on your next flight (+2% each, additive: 25 reared = +50%).');
  assert.match(prestigePanel.rearedRuleText(50), /50 reared = \+100%/);
  const s = newState(8);
  const d = makeDerived();
  s.run.fRun = 4e8;
  s.run.tPeak = 40;
  s.run.colony.alatesReared = 10;
  setRevealProvider(() => false);
  let ids = flightFactorRows(s, d).map((r) => r.id);
  assert.deepEqual(ids, ['food', 'territory', 'reared', 'weather'], 'nothing unrevealed is named');
  setRevealProvider(() => true);
  const rows = flightFactorRows(s, d);
  ids = rows.map((r) => r.id);
  for (const k of ['food', 'territory', 'reared', 'weather', 'wide_wings', 'kinship', 'achievements']) assert.ok(ids.includes(k), k);
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by.territory.mult, '×1.10');
  assert.equal(by.reared.mult, '×1.20');
  assert.match(by.reared.how, /additive/);
  assert.match(by.weather.how, /summer ×1\.25, Flight Day ×1\.5/);
  assert.match(by.territory.how, /\+0\.25% per hex/);
  assert.match(by.food.how, /square root/);
  const host = doc.createElement('div');
  uistate.resetUI();
  const p = prestigePanel.createPanel(host, panelCtx(s, d));
  p.update(s, d);
  const sec = host.querySelector('.sec-factors');
  assert.ok(sec && /What increases flight alates/.test(sec.textContent));
  assert.equal(sec.querySelectorAll('.ff-row').length, rows.length);
  assert.match(host.querySelector('.rear-rule').textContent, /additive: 25 reared = \+50%/);
  p.destroy();
  setRevealProvider(null);
});

// ------------------------------------------------------------------------------------------------ C147 landing filter
test('C147: landing options under Eternal Winter never offer season-only sites or boons; normal flights are unchanged', () => {
  const pool = prestige.landingPool('eternal_winter');
  for (const id of LANDING_USELESS.eternal_winter.sites) assert.ok(!pool.sites.includes(id), id);
  assert.ok(!pool.boons.includes('boon_long_spring'));
  assert.deepEqual(prestige.landingPool(null), { sites: SITE_ORDER.slice(), boons: BOON_ORDER.slice() });
  assert.ok(!prestige.landingPool('pacifist').sites.includes('site_hostile_neighbours'));
  const banned = new Set([...LANDING_USELESS.eternal_winter.sites, ...LANDING_USELESS.eternal_winter.boons]);
  for (let seed = 1; seed <= 40; seed++) {
    const s = newState(seed);
    s.cycle.traits.seasonal_wisdom = 1;
    s.run.fRun = 2e8;
    prestige.doFlight(s, makeDerived(), fakeEnv(), { hardship: 'eternal_winter' });
    const p = s.meta.pending;
    assert.equal(p.hardship, 'eternal_winter');
    assert.equal(p.chooseSeason, false, 'no starting season to pick in an always-winter run');
    for (const o of p.options) for (const t of o.tags) assert.ok(!banned.has(t), 'seed ' + seed + ': ' + t);
    for (const b of p.boons) assert.ok(!banned.has(b), 'seed ' + seed + ': ' + b);
    assert.equal(p.boons.length, 3);
  }
  // determinism: the same state flies to the same choices
  const a = newState(11);
  const b = newState(11);
  a.run.fRun = b.run.fRun = 2e8;
  prestige.doFlight(a, makeDerived(), fakeEnv(), { hardship: 'eternal_winter' });
  prestige.doFlight(b, makeDerived(), fakeEnv(), { hardship: 'eternal_winter' });
  assert.deepEqual(a.meta.pending, b.meta.pending);
});

// ------------------------------------------------------------------------------------------------ C149 cosmetics
/** A 2D context stub that counts paint calls. */
function stubCanvas() {
  const st = { paints: 0 };
  const target = { globalAlpha: 1, lineWidth: 1, fillStyle: '#000', strokeStyle: '#000', globalCompositeOperation: 'source-over', font: '', textAlign: '', textBaseline: '' };
  const fns = {
    createRadialGradient: () => ({ addColorStop() {} }), createLinearGradient: () => ({ addColorStop() {} }),
    fill: () => { st.paints++; }, stroke: () => { st.paints++; }, fillRect: () => { st.paints++; }, strokeRect: () => { st.paints++; },
    fillText: () => { st.paints++; }, drawImage: () => { st.paints++; },
  };
  const ctx = new Proxy(target, { get: (t, k) => (k in fns ? fns[k] : k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
  return { canvas: { width: 72, height: 44, getContext: () => ctx }, st };
}

test('C149: every achievement cosmetic maps to a slot and a render variant, and draws a preview', () => {
  const granted = ACH_ORDER.map((id) => ACHIEVEMENTS[id].cosmetic).filter(Boolean);
  assert.ok(granted.length >= 10);
  for (const id of granted) {
    const def = COSMETICS[id];
    assert.ok(def, id + ' is in data/cosmetics.js');
    assert.ok(COSMETIC_SLOT_ORDER.includes(def.slot), id + ' slot');
    assert.ok(cos.RENDER_VARIANTS[def.slot].includes(def.variant), id + ' render variant');
    assert.equal(T.cosmeticSlot(id), def.slot, id + ': Settings equips it into its render slot');
    assert.ok(T.COSMETIC_SLOTS[def.slot]);
    const { canvas, st } = stubCanvas();
    assert.equal(cos.drawCosmeticPreview(canvas, id), true, id + ' preview');
    assert.ok(st.paints > 0, id + ' preview paints');
  }
  for (const id of Object.keys(COSMETICS)) assert.ok(granted.includes(id), id + ' is granted by an achievement');
});

test('C149: equipped cosmetics reach the renderers by slot (legacy keys too) and change what is drawn', () => {
  const s = newState(9);
  const d = makeDerived();
  for (const id of Object.keys(COSMETICS)) s.meta.cosmetics.owned[id] = true;
  const equip = (slot, id) => {
    const cmd = { slot, id };
    assert.equal(CORE_HANDLERS.equipCosmetic.validate(s, d, cmd), null);
    CORE_HANDLERS.equipCosmetic.apply(s, d, cmd);
  };
  assert.equal(cos.queenTint(s), null);
  equip('crown', 'cos_golden_queen');
  assert.equal(cos.queenTint(s), cos.GOLDEN_QUEEN);
  equip('trail', 'cos_gold_trail');
  assert.equal(cos.trailColour(s, 0, '#123456'), COSMETICS.cos_gold_trail.color);
  equip('trail', 'cos_trail_colour');
  assert.notEqual(cos.trailColour(s, 0, '#123456'), cos.trailColour(s, 1, '#123456'), 'Picasso: one colour per trail');
  s.meta.cosmetics.equipped.misc = 'cos_royal_amber';   // a pre-C149 save kept it under 'misc'
  assert.equal(cos.antTint(s), COSMETICS.cos_royal_amber.tint);
  assert.equal(T.cosmeticVariant(s, 'palette'), 'royal_amber');
  equip('title', 'cos_title_underdog');
  s.meta.settings.colonyName = 'Redhill';
  assert.equal(T.colonyTitle(s), 'Redhill the Underdog');
  // the mound helpers paint more with the snow cap, flag and pet equipped
  const paint = () => { const { canvas, st } = stubCanvas(); cos.drawMoundCosmetics(canvas.getContext(), s, { x: 50, y: 50 }, 20, 8, 1); return st.paints; };
  const before0 = paint();
  equip('mound', 'cos_snowcap_mound');
  equip('flag', 'cos_white_flag');
  equip('pet', 'cos_ladybug_pet');
  assert.ok(paint() > before0 + 3, 'snow cap, flag and ladybug drawn');
  delete s.meta.cosmetics.owned.cos_white_flag;
  assert.equal(cos.equippedVariant(s, 'flag'), '', 'an unowned cosmetic is not drawn');
});

test('C149: Settings lists owned cosmetics by slot with a preview and equips into the render slot', () => {
  const s = newState(10);
  const d = makeDerived();
  s.meta.cosmetics.owned.cos_crown = true;
  s.meta.cosmetics.owned.cos_royal_amber = true;
  s.meta.cosmetics.equipped.misc = 'cos_royal_amber';
  const calls = [];
  const host = doc.createElement('div');
  const ctx = panelCtx(s, d, calls);
  ctx.game.save = () => ({ ok: true });
  ctx.game.storageOk = true;
  const p = settingsPanel.createPanel(host, ctx);
  p.update(s, d);
  const slots = host.querySelectorAll('.cos-slot');
  assert.deepEqual(slots.map((x) => x.dataset.slot), ['crown', 'palette']);
  assert.ok(slots[0].querySelector('canvas.cos-preview'), 'preview canvas');
  assert.match(slots[1].textContent, /Deep amber interface/);
  assert.ok(slots[1].classList.contains('equipped'), 'the legacy misc key counts as equipped');
  const sel = slots[1].querySelector('select');
  sel.value = '';
  sel.listeners.change[0]({ type: 'change' });
  assert.deepEqual(calls.slice(-2), [{ type: 'equipCosmetic', args: { slot: 'misc', id: null } }, { type: 'equipCosmetic', args: { slot: 'palette', id: null } }]);
  p.destroy();
});
