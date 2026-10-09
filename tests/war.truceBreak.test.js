// C292 audit of C247 (TRUCE.attackPolicy 'break'): attacking a rival under truce asks first and breaks the truce, for
// raids and assaults, from the War tab form and from the map right-click menu (its war-party chooser).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { FDocument } from './fakedom.js';
import { newState, makeDerived, fakeEnv } from './helpers.js';

const doc = new FDocument();
const prevDoc = globalThis.document;
const prevWin = globalThis.window;
globalThis.document = doc;
globalThis.window = doc.defaultView;
after(() => { globalThis.document = prevDoc; globalThis.window = prevWin; });

const rivals = await import('../src/systems/rivals.js');
const mapPanel = await import('../src/ui/panels/map.js');
const uistate = await import('../src/ui/uistate.js');
const { TRUCE } = await import('../src/data/combat.js');
const { createModalHost } = await import('../src/ui/modals.js');

function world() {
  const s = newState(3);
  s.run.colony.adults.soldier = 40;
  s.run.unlocked.panel_war = true;
  const d = makeDerived({ stats: { foodCap: 1e12, honeydewCap: 1e12, housing: 1e6, pheromoneCap: 1e6 }, rates: { food: { gross: 10 } } });
  const r = rivals.createRival(s, { type: 'pavement_ants', hex: 60 });
  r.sighted = true;
  r.truce = 120;
  r.raidIn = 400;
  return { s, d, r };
}

const flush = () => new Promise((res) => setTimeout(res, 0));

test('C292: policy is break; raid and assault commands need breakTruce and then end the truce', () => {
  assert.equal(TRUCE.attackPolicy, 'break');
  for (const kind of ['raid', 'assault']) {
    const { s, d, r } = world();
    const h = rivals.handlers.launchParty;
    const cmd = { type: 'launchParty', kind, target: { type: 'rival', uid: r.uid }, soldier: 10, supermajor: 0 };
    assert.equal(h.validate(s, d, cmd), 'confirm:truce', kind + ' unconfirmed');
    const ok = { ...cmd, breakTruce: true };
    assert.equal(h.validate(s, d, ok), null, kind + ' confirmed');
    const env = fakeEnv();
    h.apply(s, d, ok, env);
    assert.equal(r.truce, 0, kind + ' breaks the truce');
    assert.equal(r.raidIn, 400 * TRUCE.breakRaidMult);
    assert.ok(env.events.some((e) => e.type === 'truceBroken' && e.rival === r.uid));
  }
});

test('C292: the map right-click menu offers Raid / Assault (breaks the truce) through the war-party chooser', () => {
  const { s, d, r } = world();
  const items = mapPanel.rivalMenuItems(s, d, r.uid);
  for (const [i, kind] of [[0, 'raid'], [1, 'assault']]) {
    assert.match(items[i].label, /\(breaks the truce\)$/);
    assert.deepEqual(items[i].chooser, { kind: 'war', data: { kind, target: { type: 'rival', uid: r.uid } } });
  }
});

/** A war form with a recording game; returns the launchParty calls. */
function formWith(ctxExtra, kind) {
  const { s, d, r } = world();
  const calls = [];
  const game = { s, d, actions: { do: (type, args) => { calls.push({ type, args }); return { ok: true, reason: null }; } } };
  const form = mapPanel.buildWarForm({ game, ui: uistate, ...ctxExtra }, { kind, target: { type: 'rival', uid: r.uid } });
  form.update(s, d);
  const launch = form.el.querySelectorAll('button').find((b) => /^Launch/.test(b.textContent));
  return { form, launch, calls: () => calls.filter((c) => c.type === 'launchParty'), r };
}

for (const kind of ['raid', 'assault']) {
  test('C292: War tab form — ' + kind + ' under truce asks; Cancel sends nothing, Confirm sends breakTruce', async () => {
    let answer = false;
    const asked = [];
    const a = formWith({ confirm: (o) => { asked.push(o); return Promise.resolve(answer); } }, kind);
    a.launch.click();
    await flush();
    assert.equal(asked.length, 1);
    assert.match(asked[0].title, /Break the truce\?/);
    assert.equal(a.calls().length, 0, 'cancelled: nothing launched');
    answer = true;
    a.launch.click();
    await flush();
    assert.equal(a.calls().length, 1);
    assert.equal(a.calls()[0].args.breakTruce, true);
    assert.equal(a.calls()[0].args.kind, kind);
    a.form.destroy();
  });

  test('C292: map chooser (modal) — ' + kind + ' under truce asks through the modal host confirm', async () => {
    const root = doc.createElement('div');
    const modals = createModalHost(root);
    const a = formWith({ modals }, kind);
    a.launch.click();
    await flush();
    const top = modals.top();
    assert.ok(top && /Break the truce\?/.test(top.spec.title), 'confirm dialog opened');
    top.buttons.confirm.click();
    await flush();
    assert.equal(a.calls().length, 1);
    assert.equal(a.calls()[0].args.breakTruce, true);
    a.form.destroy();
  });
}
