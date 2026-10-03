// Welcome-back modal: stat lines from the OfflineSummary (food gained, food lost to full storage, ants hatched, cells
// dug, chambers completed, seasons passed, sources depleted, Saved Finds, diapause banked) and a "Watch time-lapse"
// button (render/ceremony.playCeremony('timelapse')). Owner: WP9. Contract: ARCHITECTURE §14.6, §7.15; DESIGN §21.6.

import { h } from './dom.js';
import { fmt, fmtCount, fmtTime, fmtPct } from './format.js';
import { num, arr } from './reveal.js';

/**
 * Stat lines for a welcome-back summary (lines with nothing to report are omitted).
 * @param {Object} summary OfflineSummary
 * @returns {Array<{ key: string, text: string, kind: 'info'|'good'|'nudge' }>}
 */
export function welcomeLines(summary) {
  const sm = summary && typeof summary === 'object' ? summary : {};
  const out = [];
  const secs = num(sm.seconds);
  const eff = num(sm.eff, 1);
  out.push({ key: 'away', kind: 'info', text: 'You were away for ' + fmtTime(secs) + (eff < 1 ? ' (colony worked at ' + fmtPct(eff, { signed: false }) + ')' : '') + '.' });
  if (num(sm.foodGained) > 0) out.push({ key: 'food', kind: 'good', text: '+' + fmt(sm.foodGained) + ' food gathered.' });
  if (num(sm.foodWasted) > 0) out.push({ key: 'wasted', kind: 'nudge', text: fmt(sm.foodWasted) + ' food lost to full granaries. More storage keeps it.' });
  if (num(sm.hatched) > 0) out.push({ key: 'hatched', kind: 'good', text: fmtCount(sm.hatched) + ' ants hatched.' });
  if (num(sm.cellsDug) > 0) out.push({ key: 'cells', kind: 'good', text: fmtCount(sm.cellsDug) + ' cells dug.' });
  if (num(sm.chambersDone) > 0) out.push({ key: 'chambers', kind: 'good', text: fmtCount(sm.chambersDone) + ' chamber' + (num(sm.chambersDone) === 1 ? '' : 's') + ' completed.' });
  if (num(sm.seasons) > 0) out.push({ key: 'seasons', kind: 'info', text: fmtCount(sm.seasons) + ' season' + (num(sm.seasons) === 1 ? '' : 's') + ' passed.' });
  if (num(sm.sourcesDepleted) > 0) out.push({ key: 'sources', kind: 'info', text: fmtCount(sm.sourcesDepleted) + ' food source' + (num(sm.sourcesDepleted) === 1 ? '' : 's') + ' ran out.' });
  if (num(sm.savedFinds) > 0) out.push({ key: 'finds', kind: 'good', text: fmtCount(sm.savedFinds) + ' Saved Find' + (num(sm.savedFinds) === 1 ? '' : 's') + ' waiting on the map.' });
  if (num(sm.diapause) > 0) out.push({ key: 'diapause', kind: 'info', text: fmtTime(sm.diapause) + ' of Diapause banked for later.' });
  return out;
}

/** True when the summary has dig/chamber history worth replaying. */
export function hasTimelapse(summary) {
  return !!summary && (arr(summary.cells).length > 0 || arr(summary.chambers).length > 0);
}

/**
 * Open the welcome-back modal.
 * @param {Object} ctx { game, modals, ext: { playCeremony }, canvases, ceremonyTargets }
 * @param {Object} summary
 */
export function openWelcome(ctx, summary) {
  const { modals } = ctx;
  const lines = welcomeLines(summary);
  const list = h('ul', { class: 'welcome-lines' }, lines.map((l) => h('li', { class: 'wl wl-' + l.kind, dataset: { key: l.key }, text: l.text })));
  const actions = [];
  if (hasTimelapse(summary) && ctx.ext && typeof ctx.ext.playCeremony === 'function') {
    actions.push({ label: 'Watch time-lapse', kind: 'ghost', id: 'timelapse', onClick: () => {
      try {
        const tg = typeof ctx.ceremonyTargets === 'function' ? ctx.ceremonyTargets()
          : { nest: ctx.canvases ? ctx.canvases.below : null, surface: ctx.canvases ? ctx.canvases.above : null };
        const p = ctx.ext.playCeremony('timelapse', { ...tg, summary });
        if (p && typeof p.catch === 'function') p.catch((err) => console.error('[welcome] time-lapse failed', err));
      } catch (err) {
        console.error('[welcome] time-lapse failed', err);
      }
      return true;
    } });
  }
  actions.push({ label: 'Back to the colony', kind: 'primary', id: 'confirm' });
  return modals.open({ title: 'Welcome back', className: 'modal-welcome', tag: 'welcome', body: list, actions });
}
