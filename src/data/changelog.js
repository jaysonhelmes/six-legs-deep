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
    version: '0.12.2',
    date: '2026-10-08',
    title: 'Classic map tiles',
    notes: [
      "The surface map is back to the crisp tile look from v0.10: each hex keeps its own ground with clean edges, joined pools, flagstone paths and solid boulders. (The blended borders from v0.11 are gone.)",
    ],
  },
  {
    version: '0.12.1',
    date: '2026-10-08',
    title: 'Smoother updates',
    notes: [
      "The game now checks for a new version when it loads and updates itself first, so you never play a half-updated mix of old and new files. You may see a short \"Updating…\" screen right after a release; your colony is untouched.",
      "If a new version comes out while you play, an \"Update available\" notice appears. Click it to save and reload into the new version, or dismiss it and keep playing.",
    ],
  },
  {
    version: '0.12.0',
    date: '2026-10-07',
    title: 'A gentler start, sound, and clearer everything',
    sections: [
      { heading: "New players", notes: [
        "The opening is calmer: features arrive one at a time and further apart, and advanced systems wait until you have built a Gallery, drawn a trail and bought your first research. Each new feature introduces itself with a one-line tip.",
        "The small nest view at the start is labelled \"Your nest\" with an Expand button; the Gallery demo only appears when your nest is full and says exactly what to do; clicking the queen no longer throws a panel open.",
      ] },
      { heading: "Sound", notes: [
        "Sound effects for actions and notifications (generated live, no downloads), with on/off, volume and per-category switches in Settings. They start after your first click and pause when the tab is hidden.",
      ] },
      { heading: "Nest and build", notes: [
        "The Royal Chamber has its own Build row; level buttons show their full cost with icons; \"Hide maxed\" toggle; placeable chambers are listed first and undiscovered ones stay hidden.",
        "Frost: the placement preview shows how many cells sit above the frost line, and exposed chambers get an icy outline in winter.",
        "Tunnels you did not dig say who did when you hover them, and the yellow house over the Royal Chamber now explains itself (housing full).",
        "Satellite Nest levels widen your nest by 4 columns each side for new runs. Colony History pictures now show each chamber in colour.",
        "Fixed: a blueprint chamber moved off water could land in a layer you cannot dig yet.",
      ] },
      { heading: "Map and combat", notes: [
        "The Mound now grows by itself as your colony grows, widening your home territory; levels you had are kept.",
        "Fallen fruit, picnics and termite swarms only appear where you can reach them; every gain popup shows its resource icon.",
        "Enemy strength is labelled the same everywhere, rival land can no longer cover your entrances, and only permanent land counts toward peak territory.",
        "Tournaments are worth it: easier to win, 90 s cooldown, and a win gives insight, chitin and delays that rival’s next raid.",
        "Bribe truces really last 5 minutes and show a countdown; repelled raids bring home chitin; Lycaenid trails stop at the 5 escorts they need.",
        "With Aphid Shepherding, right-click an aphid colony to move it. Leafcutters unlock once a Fungus Garden can store their leaves.",
      ] },
      { heading: "Colony", notes: [
        "Colony sections fold and unfold; job buttons show how many ants one click moves (Per click 1 / 10 / 100 / Max).",
        "Nurses are capped at the most that still help (4 per brood slot); caste rows show food upkeep; queued alates can be cancelled and show their cost.",
      ] },
      { heading: "Explanations", notes: [
        "The war-party form explains raid vs assault; won battles say what loot was carried home.",
        "The Map tab explains how trails work (distance, travel time, strength, how workers are shared) and what territory gives, with a trail colour legend.",
        "Clearer descriptions for the Barracks, Digging Claws, Long Legs, Thermal Brood Shuttling, Flight Day, honeydew storage and frost; the Scent Library is always called that.",
        "Research has a search box, and Manual search puts the best matches first.",
      ] },
      { heading: "Balance", notes: [
        "The Nuptial Flight now needs slightly more food gathered (same 13 alates at the threshold) to keep the first Flight around 40-50 minutes.",
      ] },
    ],
  },
  {
    version: '0.11.0',
    date: '2026-10-05',
    title: 'Queens, chitin storage, event log and smarter automation',
    sections: [
      { heading: 'Balance', notes: [
        "The queen no longer speeds up with colony scale, so laying can be your limit again late in the game. Royal Chamber levels above 8 raise laying x1.25 each, every extra queen speeds up all your queens by 25%, and Queen's Feast now gives x1.1 per level.",
        "Chitin has a storage cap that grows with colony scale. Carapace Stores raise it; rewards can overflow to twice the cap and the excess slowly crumbles away.",
        "New in Research: the Archive. Each completed branch opens a permanent track worth +1% to that branch per level, kept through Flights and Supercolonies.",
      ] },
      { heading: 'Prestige and automation', notes: [
        "Forming a Supercolony now counts your current run’s alates toward kinship, as if the colony had flown. A new box shows everything that increases kinship.",
        "Automatic jobs and every autobuyer now come from the Federation (Automated Brood and Autobuyers). Automaton Instincts now gives +2 dig queue and carries your job targets into every run.",
        "Automation switches live where they act: Auto-Flight in the Flight view, Auto-Supercolony in the Supercolony view, the Adaptation autobuyer in the Adaptations tab, chamber and Mound autobuyers in the Build tab.",
        "Auto-Flight waits at least 8 minutes and flies once alates per minute has stayed 3% below its best for 30 s; season changes no longer set it off. It also picks the most useful landing site and boon.",
        "Innate research now resets at every Supercolony (Genetic Memory still keeps it through a Speciation).",
        "New Federation node: Architect’s Table. Open a saved blueprint and edit it without touching your colony.",
        "Fixed: a Brood Bank bought while choosing a landing site now applies to that landing.",
      ] },
      { heading: 'Nest and blueprints', notes: [
        "Hidden water pockets no longer give themselves away or silently block you: build into one and you strike water, and the pocket appears.",
        "Blueprints move chambers off water, find water for Wells, grow roots for Root Aphid Pens and dig winding exit shafts for Nuptial Chambers instead of needing manual fixes.",
        "Roots grow down through chambers and still count for Root Aphid Pens.",
        "New chambers: the Carapace Store (more chitin storage) and the Carapace Workshop (more chitin from every source, and chitin back from fallen soldiers).",
        "Watch the digging: workers chip at the dig face and carry soil out. Underground stones now come in many shapes and sizes. Press Q again to put the build tool away.",
      ] },
      { heading: 'Map and combat', notes: [
        "Trails walk around molehills and flooded spring puddles on their own, then return to their route.",
        "Ground types blend into each other, garden paths curve smoothly and boulders have natural cracks.",
        "Hovering a source shows what it gives each worker; aphid colonies show their level. The map shows trails used and available.",
        "Right-click to add escorts to a Lycaenid trail, or to send soldiers to clear an antlion pit even after its card has gone.",
        "Conquering a rival calls off its incoming raids at once. With no soldiers, the raid alert explains what you need. Auto-retreat moved to the War tab and the war-party window.",
        "Once the map is fully explored, scouts head beyond the border and bring back rare finds.",
      ] },
      { heading: 'Interface', notes: [
        "New Event log: every event and how it ended, raids, blueprints, achievements and more, with filters.",
        "The Stats tab shows where each resource came from and what used it over the last minute.",
        "Hover the queen’s lay rate to see every factor behind it. The top left shows how long the current run has lasted.",
        "The Ants breakdown shows each caste’s limit, and the bottleneck badge keeps a steady size (\"No bottleneck\" when nothing holds you back). Drag the strip between the map and the nest to resize them; on narrow screens the tab row scrolls.",
      ] },
    ],
  },
  {
    version: '0.10.0',
    date: '2026-10-04',
    title: 'Caste targets, living map and grander chambers',
    sections: [
      { heading: 'Colony', notes: [
        'Caste sliders are now targets: set how many soldiers, supermajors and repletes you want with -/+ (x1 or x10), type a number, or press Max to match your berths. The queen raises each caste to its target, then lays workers.',
        'New "Keep berths filled" toggle: the target follows your Barracks, War Hall or Repletion Hall berths, including new ones. It turns on by itself when your first Barracks or War Hall opens.',
        'Each caste row shows how many you have, your target, the berth cap, free berths and the cost per egg. Old percentages are converted to targets automatically.',
        'The Ants count on the left rail breaks down by caste. Click the row to fold it.',
      ] },
      { heading: 'Nest', notes: [
        'Reserved space now looks like a dig site, with freshly dug soil, props and workers, instead of a dotted outline.',
        'Clicking soil in the reserved space of a chamber opens that chamber; hovering shows what it is reserved for.',
        'Chambers look grander as they level: carvings and pillars from level 3; ornate trim, glowing lamps and an emblem from level 7.',
        'The Royal Chamber reserves its full-size room up front and grows into it on its own.',
        'A water pocket can be moved over spare tunnels; they are filled in as part of the move.',
        'A small green triangle on a chamber means its next level is affordable right now.',
        'New Bloodline traits: Deep Spring (a blueprint Water Well with no water nearby gets a spring beside it) and Root Memory (a blueprint Root Aphid Pen gets a free root grown down to it).',
      ] },
      { heading: 'Map', notes: [
        'The surface comes alive: plants sway in the wind, beetles crawl, caterpillars inch along, flies buzz over dead insects, termites bustle and molehills puff soil. Reduced motion turns it off.',
        'You can permanently claim hexes your trails hold; trail-held territory now looks paler and hatched, with a dashed border.',
        'Zoom much closer on the surface map (up to 2.75x).',
        'Hovering a hex tells you what its ground does to trails (sand counts as 1.25 hexes); the Manual has a new Terrain entry.',
      ] },
      { heading: 'Interface', notes: [
        'The Winged Cursor works across the whole game window, with a gold pointer over clickable things.',
      ] },
    ],
  },
  {
    version: '0.9.1',
    date: '2026-10-04',
    title: 'Remove a trail from its destination',
    notes: [
      'Right-click a food source, aphid colony or other destination that already has a trail and choose "Remove trail to here".',
    ],
  },
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
