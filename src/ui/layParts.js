// Queen lay-rate breakdown for the tooltip on the lay rate (ARCHITECTURE §18 C192; DESIGN §5.1, §12.4). Uses
// d.stats.layParts (C198, systems/stats.js layStack) when present; otherwise (a hand-filled derived cache, older code) a
// display-only mirror of systems/stats.js recompute's lay
// formula: per active Royal Chamber (base + Royal Feeding × level) × 1.15^(L − 1), then × Royal Pheromones ×
// Spermathecal Reserve × Queen's Feast^level × prestige (Bloodline etc.) × season × event effects × Brood refinement ×
// achievements × Colony Scale. When the product misses d.stats.layRate by more than 1 % an "Other" factor closes the gap,
// so the tooltip always ends on the real rate. Owner: WP9. Pure (Node imports it).

import { LAY, ACH_FX } from '../data/economy.js';
import { ADAPTATIONS } from '../data/adaptations.js';
import { RESEARCH, REFINEMENT } from '../data/research.js';
import { EVENTS } from '../data/events.js';
import { num, arr, obj } from './reveal.js';
import { nameOf, humanize, SEASON_NAMES } from './text.js';

const fxOf = (table, id, key, dflt) => {
  const e = table && Object.prototype.hasOwnProperty.call(table, id) ? table[id] : null;
  const v = e && e.fx ? e.fx[key] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
};

/** Event name behind an effect id ('ev_wandering_queen_adopt' → Wandering Queen). */
function effectName(id) {
  const t = String(id || '');
  let best = '';
  for (const k of Object.keys(EVENTS)) if (t.startsWith(k) && k.length > best.length) best = k;
  return best ? nameOf('event', best) : humanize(t.split(':')[0]);
}

/**
 * Lay-rate parts. Each part: { label, kind: 'base' | 'mult', value } where 'base' parts add eggs/s (the queens) and
 * 'mult' parts multiply. total = d.stats.layRate. Pure.
 * @param {Object} s
 * @param {Object} d
 * @returns {{ parts: Array<{ label: string, kind: string, value: number }>, total: number, hungry: boolean, source: 'stats'|'ui' }}
 */
export function layBreakdown(s, d) {
  const st = obj(d && d.stats);
  const total = num(st.layRate);
  const run = obj(s && s.run);
  const hungry = !!(run.colony && run.colony.hungry);
  // the economy's own breakdown wins when present
  if (Array.isArray(st.layParts) && st.layParts.length) {
    const parts = st.layParts.filter((p) => p && typeof p.label === 'string')
      // C198 shape: { label, add, value } per queen, { label, mult, value } per multiplier (a 'kind' field is accepted too)
      .map((p) => {
        const base = 'add' in p || p.kind === 'base' || p.kind === 'add';
        return { label: p.label, kind: base ? 'base' : 'mult', value: num(p.value, base ? 0 : 1) };
      });
    // what each queen's own rate is made of (the economy folds it into the queen line)
    const rf0 = run.hardship === 'claustral_founding' ? 0 : num(obj(run.adaptations).royal_feeding);
    const firstMult = parts.findIndex((p) => p.kind === 'mult');
    const notes = [{ label: 'Each queen: base', kind: 'note', value: LAY.base }];
    if (rf0 > 0) notes.push({ label: 'Royal Feeding ×' + rf0 + ' (+' + LAY.perRF + ' each)', kind: 'note', value: LAY.perRF * rf0 });
    notes.push({ label: 'then × her Royal Chamber level', kind: 'note', value: 0 });
    if (parts.some((p) => p.kind === 'base')) parts.splice(firstMult < 0 ? parts.length : firstMult, 0, ...notes);
    return { parts, total, hungry, source: 'stats' };
  }
  const parts = [];
  const A = obj(run.adaptations);
  const rf = run.hardship === 'claustral_founding' ? 0 : num(A.royal_feeding);
  const royal = arr(d && d.nest && d.nest.agg && d.nest.agg.royal).map(num).filter((L) => L > 0);
  let lay = 0;
  royal.forEach((L, i) => {
    const one = (LAY.base + LAY.perRF * rf) * LAY.perRC ** (L - 1);
    lay += one;
    const who = royal.length > 1 ? 'Queen ' + (i + 1) : 'Queen';
    parts.push({ label: who + ' (Royal Chamber L' + L + ')', kind: 'base', value: one });
  });
  if (royal.length) {
    parts.push({ label: 'Base per queen', kind: 'note', value: LAY.base });
    if (rf > 0) parts.push({ label: 'Royal Feeding ×' + rf + ' (+' + LAY.perRF + ' each, per queen)', kind: 'note', value: LAY.perRF * rf });
    parts.push({ label: 'Royal Chamber levels (×' + LAY.perRC + ' per level above 1)', kind: 'note', value: 0 });
  }
  const mult = [];
  const research = obj(run.research);
  if (research.royal_pheromones) mult.push({ label: nameOf('research', 'royal_pheromones'), value: fxOf(RESEARCH, 'royal_pheromones', 'lay', 1) });
  if (research.spermathecal_reserve) mult.push({ label: nameOf('research', 'spermathecal_reserve'), value: fxOf(RESEARCH, 'spermathecal_reserve', 'lay', 1) });
  const qf = num(A.queens_feast);
  if (qf > 0) mult.push({ label: nameOf('adaptation', 'queens_feast') + ' ×' + qf, value: fxOf(ADAPTATIONS, 'queens_feast', 'lay', 1) ** qf });
  const pre = num(d && d.meta && d.meta.prestige && d.meta.prestige.lay, 1);
  mult.push({ label: 'Bloodline, species & prestige', value: pre });
  const season = d && d.season ? d.season : {};
  mult.push({ label: 'Season (' + (SEASON_NAMES[season.id] || season.id || 'spring') + ')', value: num(season.mods && season.mods.lay, 1) });
  for (const e of arr(run.effects)) {
    if (e && e.stat === 'lay' && (e.scope === null || e.scope === undefined) && typeof e.mult === 'number') mult.push({ label: effectName(e.id), value: e.mult });
  }
  const refL = num(run.refinements && run.refinements.brood);
  if (refL > 0) mult.push({ label: 'Brood refinement ×' + refL, value: num(REFINEMENT.mult, 1) ** refL });
  let ach = 1;
  const earned = obj(s && s.meta && s.meta.achievements);
  for (const id of Object.keys(ACH_FX)) {
    const v = ACH_FX[id].lay;
    if (typeof v === 'number' && Object.prototype.hasOwnProperty.call(earned, id) && earned[id] !== null) ach *= v;
  }
  if (ach !== 1) mult.push({ label: 'Achievements', value: ach });
  const cs = num(d && d.meta && d.meta.colonyScale, 1);
  if (cs !== 1) mult.push({ label: 'Colony Scale', value: cs });
  if (hungry) mult.push({ label: 'Hungry: laying stopped', value: 0 });
  let product = lay;
  for (const m of mult) product *= m.value;
  if (!hungry && product > 0 && total > 0 && Math.abs(total / product - 1) > 0.01) mult.push({ label: 'Other effects', value: total / product });
  for (const m of mult) parts.push({ label: m.label, kind: 'mult', value: m.value });
  return { parts, total, hungry, source: 'ui' };
}

/**
 * Tooltip lines for layBreakdown(): queens first ("Queen (Royal Chamber L5) 0.35/s"), then every multiplier that is
 * not ×1 ("Royal Pheromones ×1.50"), then the total.
 * @param {ReturnType<typeof layBreakdown>} b
 * @param {{ fmtRate: Function, fmtMult: Function }} f
 * @returns {string[]}
 */
export function layTipLines(b, { fmtRate, fmtMult }) {
  const lines = [];
  for (const p of b.parts) {
    if (p.kind === 'base') lines.push(p.label + ' ' + fmtRate(p.value));
    else if (p.kind === 'note') { if (p.value > 0) lines.push('  ' + p.label + ': ' + fmtRate(p.value)); else lines.push('  ' + p.label); }
    else if (Math.abs(p.value - 1) > 1e-9) lines.push(p.label + ' ' + fmtMult(p.value));
  }
  lines.push('= ' + fmtRate(b.total) + (b.hungry ? ' (hungry)' : ''));
  return lines;
}
