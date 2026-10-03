// Test-save generator (dev tool): plays the pacing bot headlessly and exports saves at key points of the game,
// so a tester can jump straight to mid-game or a prestige layer via Settings → Import.
// Usage: node tools/make-saves.mjs [--seed 1] [--out test-saves]   (about 7 minutes; the Speciation save is most of it)
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createGame } from '../src/core/game.js';
import { flightRequirements, superRequirements, specRequirements } from '../src/systems/prestige.js';
import { Bot } from './simulate.mjs';

const THINK_SEC = 1; // same cadence as the pacing bot's POLICY.thinkSec

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
};
const seed = Number(arg('seed', 1)) >>> 0;
const outDir = arg('out', 'test-saves');
mkdirSync(outDir, { recursive: true });

const fmt = (sec) => Math.floor(sec / 3600) + 'h ' + String(Math.floor((sec % 3600) / 60)).padStart(2, '0') + 'm';

/**
 * Plays from a new game until `done(g)` is true, then exports.
 * @param {string} file
 * @param {string} label
 * @param {(g: any) => boolean} done
 * @param {number} dt
 * @param {number} maxSec
 */
function make(file, label, done, dt, maxSec) {
  const g = createGame({ nowMs: 0, storage: null });
  g.newGame(0, seed);
  const bot = new Bot(g);
  const t0 = Date.now();
  let ok = false;
  while (g.s.meta.simTime < maxSec) {
    if (done(g)) { ok = true; break; }
    bot.clicks(dt);
    if (g.s.meta.simTime + 1e-9 >= bot.nextThink) {
      bot.nextThink = g.s.meta.simTime + THINK_SEC;
      bot.think();
    }
    g.tickOnce(dt);
  }
  if (!ok && done(g)) ok = true;
  const path = join(outDir, file);
  writeFileSync(path, g.exportString(0));
  const s = g.s;
  console.log((ok ? 'OK   ' : 'MISS ') + label.padEnd(26) + ' sim ' + fmt(s.meta.simTime) + ' · run ' + (s.run.index + 1)
    + ' · flights ' + s.meta.counters.flights + ' · alates ' + Math.floor(s.cycle.alates)
    + ' · kinship ' + Math.floor(s.era.kinship) + '  → ' + path
    + '  (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
}

make('1-mid-game-40min.txt', 'mid-game (40 min)', (g) => g.s.meta.simTime >= 2400, 0.1, 2400);
make('2-ready-to-fly.txt', 'ready for Nuptial Flight', (g) => flightRequirements(g.s, g.d).ok, 0.1, 3 * 3600);
make('3-ready-to-merge.txt', 'ready for Supercolony', (g) => superRequirements(g.s, g.d).ok, 1, 14 * 3600);
make('4-ready-to-speciate.txt', 'ready for Speciation', (g) => specRequirements(g.s, g.d).ok, 1, 60 * 3600);
