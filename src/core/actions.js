// UI-facing actions: validate synchronously, save before prestige, enqueue for the next tick.
// Owner: WP1. Contract: ARCHITECTURE §7.5. UI, render and tools mutate the game only through these functions.
// ARCH-R: §7.5 builds cmd = { type, ...args }; a stray args.type would override the command type, so cmd.type is
// re-asserted after the spread.

import { validateCommand, REGISTRY } from './commands.js';

/** Command types that trigger game.hooks.beforePrestige (save first, DESIGN §22). */
export const PRESTIGE_TYPES = new Set(['fly', 'startHardship', 'supercolony', 'speciate']);

/**
 * Create the actions object for a game: `do(type, args)` plus one function per registered command type
 * (e.g. actions.placeChamber({ chamber: 'gallery', x: 5, y: 3 })). Commands apply at the start of the next tick.
 * @param {import('./types.js').Game} game
 * @param {Record<string, import('./types.js').Handler>} [reg=REGISTRY]
 * @returns {import('./types.js').Actions}
 */
export function createActions(game, reg = REGISTRY) {
  /** @type {import('./types.js').Actions} */
  const actions = {
    do(type, args = {}) {
      const cmd = { type, ...(args && typeof args === 'object' ? args : {}) };
      cmd.type = type;
      const reason = validateCommand(game.s, game.d, cmd, reg);
      if (reason) return { ok: false, reason };
      if (PRESTIGE_TYPES.has(type) && game.hooks && typeof game.hooks.beforePrestige === 'function') {
        try {
          game.hooks.beforePrestige();
        } catch {
          // a failing save must not block the prestige (game.save reports storage errors itself)
        }
      }
      game.queue.push(cmd);
      return { ok: true, reason: null };
    },
  };
  for (const type of Object.keys(reg)) {
    if (type === 'do') continue;
    actions[type] = (args = {}) => actions.do(type, args);
  }
  return actions;
}
