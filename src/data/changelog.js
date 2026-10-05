// Player-facing patch notes, newest first. Every update adds one entry at the TOP of CHANGELOG and bumps its version
// (CURRENT_VERSION follows the first entry); the in-game "What's new" modal and the update pill read this table.
// Write for players: no clarification numbers, file names or developer terms. Each entry: { version, date
// (YYYY-MM-DD), title, notes?: string[], sections?: [{ heading, notes: string[] }] }. Owner: WP9 (data only).
// Contract: ARCHITECTURE §2, §14.6, §18 C150; DESIGN §25.3.

/** @typedef {{ heading: string, notes: string[] }} ChangelogSection */
/** @typedef {{ version: string, date: string, title: string, notes?: string[], sections?: ChangelogSection[] }} ChangelogEntry */

/** @type {ReadonlyArray<ChangelogEntry>} */
export const CHANGELOG = deepFreeze([
  {
    version: '0.9.0',
    date: '2026-10-04',
    title: 'War Hall, reserved rooms and wider trails',
    sections: [
      { heading: 'Nest', notes: [
        'New chamber: the War Hall houses supermajors. The Barracks now house soldiers only.',
        'Placing a chamber that grows reserves its full-size room right away (F picks the corner it starts in), so level-ups simply fill it.',
        'Blueprints dig their own access tunnels to planned chambers, and Use now works in the middle of a run.',
        'Water pockets can be moved by a single tile.',
        'The inspect panel opens with a short description of what each chamber does.',
        'L levels the cheapest chamber of the selected type, Shift+L the selected one, and Q over a chamber picks its type to place another.',
      ] },
      { heading: 'Map', notes: [
        'Trails always start at an entrance; older trails that forked from another trail were moved onto an entrance.',
        'Trunk Trails now reward trails that share a path, and shared stretches are drawn as separate lanes.',
        'With Trunk Trails, every trail from every entrance claims territory, however short.',
        'Boulders appear on the map, and puddle edges no longer spill past their hexes.',
      ] },
      { heading: 'Interface', notes: [
        'Adaptations have their own tab.',
        'Research shows one branch at a time, each branch button counting what you can buy.',
        'Achievements list their requirements and a "Recently earned" section.',
        'Clearer alate wording, and a "What increases flight alates" box with the current value of every factor.',
        'Landing sites and boons that would be useless under your coming Hardship are no longer offered.',
        'Field Guide entries link to further reading, and several notes were corrected.',
        'Cosmetics now visibly change the game: every one has its slot and its look, with previews in Settings.',
        'Patch notes: click the version number (Settings, or the bottom of the resource rail) to see what changed in each update.',
      ] },
    ],
  },
  {
    version: '0.8.0',
    date: '2026-10-04',
    title: 'The in-game Manual',
    notes: [
      'New Manual: press H or ?, or click the book icon beside the tabs.',
      'Sections for resources, ant types and jobs, chambers and the nest, the surface, combat, seasons and events, research, prestige and controls.',
      'Only what you have unlocked or seen is listed, so nothing is spoiled.',
      'Numbers come straight from the game and show your current values, including a live breakdown of your projected alates.',
      'Search box, links between related entries, and buttons that open the matching tab.',
    ],
  },
  {
    version: '0.7.0',
    date: '2026-10-04',
    title: 'Colony History and blueprint waits',
    notes: [
      'Planned blueprint chambers say what they are waiting for, in their tooltip, the inspect panel and the Blueprints list.',
      'Chambers may now be built over shafts (except a shaft\'s top two rows); the shaft runs through and comes back if the chamber is moved or demolished.',
      'New Colony History gallery in the Prestige tab: one card per past run with a drawing of its nest, its length, peak ants and what it earned.',
      'Past-run outlines no longer clutter the bedrock in the nest view.',
      'Trails curve around stone instead of clipping it, and stone and flooded puddles explain themselves on hover.',
    ],
  },
  {
    version: '0.6.0',
    date: '2026-10-04',
    title: 'Nest tools, blueprints and seasons',
    sections: [
      { heading: 'Nest', notes: [
        '"Level cheapest" also appears (and levels the selected chamber) when that chamber is the cheapest; buttons show their hotkeys.',
        'Blueprints put the Royal Chamber back at its saved spot, Wells wait for a revealed water pocket, and planned chambers can be cancelled one at a time or all at once.',
        'Drainage research lets you drain or move water pockets.',
        'New research, Root Cultivation: grow your own roots.',
        'Backfill every unneeded tunnel in one click.',
      ] },
      { heading: 'World', notes: [
        'The Army Ant Column card shows the column\'s size, your defenders and the odds.',
        'Right-click Lycaenid caterpillars and fallen fruit to draw a trail to them.',
        'Seasons blend gradually into the next, and the weather is right straight after a reload.',
        'Daughter colonies appear as labelled allied markers, and unscouted rival land no longer shows through the fog.',
      ] },
      { heading: 'Interface', notes: [
        'Alate Rearing moved to the Prestige tab.',
        'Research has a "Hide completed" toggle.',
      ] },
    ],
  },
  {
    version: '0.5.0',
    date: '2026-10-04',
    title: 'Chitin, blueprints and adjacency',
    sections: [
      { heading: 'Colony', notes: [
        'Chitin trickles in on its own: a little from every hatch once soldiers are unlocked, and more from each Midden level.',
        'Chitin reserve slider: soldier eggs only spend chitin above it, and chitin trails get foragers first while chitin is short.',
        'Adaptations show the total cost of ×10 and a Max button that buys as many as you can afford.',
      ] },
      { heading: 'Nest', notes: [
        'Blueprint chambers you cannot build yet stay as planned outlines and are queued at half price once available.',
        'The inspect panel lists exactly what the next level gives.',
        '"Level cheapest" for a chamber type, plus chamber hotkeys.',
        'Adjacency is visible: link badges, a placement preview of bonuses gained or lost, and the rules in chamber descriptions. Groom Brood is explained.',
        'The mound no longer squashes when you scroll the nest.',
      ] },
      { heading: 'Map', notes: [
        'Dragging a trail from an entrance works even when an event object sits on it.',
        'Neighbouring puddles join into pools and garden paths connect.',
        'Diapause shows a chip while it runs, and Stats explain the speed-up.',
      ] },
    ],
  },
  {
    version: '0.4.0',
    date: '2026-10-03',
    title: 'Chamber art and trail tweaks',
    notes: [
      'Every chamber type has its own decoration in the nest view, with gentle animation (off under Reduced motion) and winter looks for some chambers.',
      'Only one trail per destination: add workers to the existing trail instead.',
      'Ritual Tournaments can use foragers as well as idle workers; they go back to foraging afterwards.',
      'One-click trails start from the nearest entrance instead of always the main one.',
    ],
  },
  {
    version: '0.3.0',
    date: '2026-10-03',
    title: 'First player feedback pass',
    sections: [
      { heading: 'Colony', notes: [
        'Automatic jobs have a target slider for every job, and +/− nudges the targets.',
        'Respond to bottlenecks leans toward what is short for a while instead of rewriting your targets.',
        'Sliders no longer flicker between the value you chose and the stored one.',
        'Galleries give more housing per level and the first Granary holds more.',
      ] },
      { heading: 'Nest', notes: [
        'Backfill tool: drag a box with a live preview of what will fill and why anything is refused; the tool stays on and cells being filled are hatched. B toggles it.',
        'Chamber level-ups grow exactly one row or column, with a preview.',
        'Placement rules (such as the Nuptial Chamber\'s minimum depth) are shown up front, with a depth line while placing.',
      ] },
      { heading: 'Interface', notes: [
        'View switcher on every screen size: Above, Below, Stacked or Side by side, remembered; V cycles them.',
        'A swap button flips which side the map and the nest sit on.',
        'Tools such as hex claiming switch off when you change panel tabs.',
        'Raid warnings have their own chip, so the bottleneck badge stays visible.',
        'Rivals never appear on or spread over land you hold.',
      ] },
    ],
  },
  {
    version: '0.2.0',
    date: '2026-10-03',
    title: 'Soldier fix',
    notes: [
      'Soldiers are raised again when the Galleries are full: soldier brood only needs free Barracks berths, not housing.',
      'Clicking a Nursery\'s brood pile or the queen opens the inspect panel, so Relocate appears.',
    ],
  },
  {
    version: '0.1.0',
    date: '2026-10-03',
    title: 'Six Legs Deep',
    notes: [
      'First release: raise an ant colony from a single queen.',
      'Two linked views: the surface hex map with scent trails above, and the nest cut-away below.',
      'Jobs, chambers, research, seasons, rivals, raids and random events.',
      'Three prestige layers: Nuptial Flight, Supercolony and Speciation.',
      'Achievements, a Field Guide, offline progress and saves in your browser.',
    ],
  },
]);

/** The version of the running build (the newest changelog entry). */
export const CURRENT_VERSION = CHANGELOG[0].version;

function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
}
