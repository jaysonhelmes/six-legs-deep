// World data (WP6): the 40 Field Guide entries of DESIGN §20, each with an in-house 40–60 word biology note.
// Owner: WP6. Contract: ARCHITECTURE §6.6: FIELD_GUIDE[id] = { id, title, cat, trigger, note }.
// `trigger` uses a small condition language read by systems/fieldguide.js:
//   { all: [...] } · { any: [...] } · { path, gte } (state path) · { adults: n } · { research: id } · { ach: id } ·
//   { counter, gte } (meta.counters) · { caste: id } (first adult of that caste; alates: first reared) ·
//   { chamber: type } (a live chamber) · { source: type } (on a revealed hex) · { rival: type } (sighted) ·
//   { ev: eventId } (that random event happened) · { emitted: eventType } (an event of that type this tick) ·
//   { mound: level } · { season: id } · { census: n } · { custom: name }. `{ all: [] }` is always true.

/** Deep-freeze helper (plain objects and arrays). */
const f = (o) => {
  for (const k of Object.keys(o)) if (o[k] && typeof o[k] === 'object') f(o[k]);
  return Object.freeze(o);
};

/** Entry builder. */
const G = (id, title, cat, trigger, note) => ({ id, title, cat, trigger, note });

/** One-shot insight paid on unlock: max(min, sec × gross insight/s). */
export const FG_REWARD = f({ sec: 30, min: 10 });

/** Display order (DESIGN §20 order). */
export const FG_ORDER = f([
  'fg_founding_queen', 'fg_nanitics', 'fg_trail_pheromone', 'fg_double_bridge', 'fg_tandem_running', 'fg_polyethism',
  'fg_polymorphism', 'fg_trophic_eggs', 'fg_repletes', 'fg_supermajors', 'fg_alates', 'fg_nuptial_flight', 'fg_trophobiosis',
  'fg_root_aphids', 'fg_lycaenid', 'fg_fungus_gardens', 'fg_weeder_ants', 'fg_midden', 'fg_mound_heat', 'fg_overwintering',
  'fg_seed_harvesting', 'fg_square_law', 'fg_ritual_tournaments', 'fg_black_garden_ant', 'fg_pavement_ant', 'fg_red_wood_ant',
  'fg_carpenter_ant', 'fg_fire_ant', 'fg_slave_maker', 'fg_army_ant', 'fg_argentine_ant', 'fg_ladybird', 'fg_antlion',
  'fg_horned_lizard', 'fg_ophiocordyceps', 'fg_phengaris', 'fg_phorid_flies', 'fg_myrmecophiles', 'fg_twenty_quadrillion', 'fg_amber',
]);

/** The entries. */
export const FIELD_GUIDE = f({
  fg_founding_queen: G('fg_founding_queen', 'Claustral Founding', 'founding', { all: [] },
    'After her mating flight a young queen sheds her wings, seals herself into a small chamber and never leaves it. She lives off fat '
    + 'reserves and the breakdown of her now useless flight muscles, converting that stored energy into eggs and saliva for her first '
    + 'larvae. Months may pass before a single worker emerges.'),
  fg_nanitics: G('fg_nanitics', 'Nanitics', 'founding', { any: [{ path: 'run.stats.hatched', gte: 1 }, { adults: 1 }] },
    'The first workers a founding queen raises are unusually small. Fed only on her limited reserves, these nanitics are undersized '
    + 'but perfectly functional, and they quickly take over foraging, nursing and digging. Within a few generations, better nourished '
    + "larvae grow into workers of normal size and the colony's growth begins to accelerate."),
  fg_trail_pheromone: G('fg_trail_pheromone', 'Trail Pheromones', 'behaviour', { any: [{ custom: 'drawnTrail' }, { custom: 'secondTrail' }] },
    'A forager that finds food lays a chemical trail on her way home by touching her abdomen to the ground. Nestmates follow it and '
    + 'reinforce it if the food is still there. The signal evaporates within minutes, so abandoned routes fade on their own and the '
    + 'colony shifts its effort to fresher finds.'),
  fg_double_bridge: G('fg_double_bridge', 'The Double Bridge', 'behaviour', { any: [{ research: 'double_bridge' }, { ach: 'ach_double_bridge' }] },
    'When two bridges of different length connect a nest to food, ants that happen to take the short one return sooner and mark it '
    + 'more often. That small head start snowballs: the shorter path gathers more pheromone, attracts more followers and soon carries '
    + 'nearly all the traffic, with no ant ever comparing the distances.'),
  fg_tandem_running: G('fg_tandem_running', 'Tandem Running', 'behaviour', { research: 'tandem_running' },
    'Some ants recruit one nestmate at a time. A leader walks toward a food source or new nest site with a single follower tapping '
    + 'her legs and abdomen. If contact breaks, the leader waits until the follower catches up. It is slow, but the follower learns '
    + 'the route and can later lead others.'),
  fg_polyethism: G('fg_polyethism', 'Age Polyethism', 'behaviour', { research: 'age_polyethism' },
    "In many colonies a worker's job changes as she ages. Young adults stay deep inside, tending brood and the queen. Middle-aged "
    + 'workers build and maintain the nest. The oldest take on the riskiest work outside as foragers and guards, so the colony spends '
    + 'its most expendable members where losses are most likely.'),
  fg_polymorphism: G('fg_polymorphism', 'Polymorphism', 'castes', { research: 'polymorphism' },
    'Workers of one colony can differ enormously in size and shape even though they are sisters. The difference is set during larval '
    + 'development: how much food a larva receives, and the levels of juvenile hormone it experiences, decide whether it becomes a '
    + 'small minor worker or a large-headed soldier.'),
  fg_trophic_eggs: G('fg_trophic_eggs', 'Trophic Eggs', 'castes', { research: 'trophic_eggs' },
    'Not every egg is meant to hatch. Queens and workers of many species lay infertile trophic eggs that serve purely as food, a '
    + 'protein-rich package passed to larvae or to the queen herself. It is an efficient way to move nutrients through the colony when '
    + 'other food is scarce.'),
  fg_repletes: G('fg_repletes', 'Repletes', 'castes', { caste: 'replete' },
    'Honeypot ants turn some workers into living storage jars. Repletes hang from the ceilings of deep chambers while foragers fill '
    + 'their crops with liquid food until their abdomens swell to the size of a grape. In lean seasons, nestmates stroke them and '
    + 'receive droplets back, mouth to mouth.'),
  fg_supermajors: G('fg_supermajors', 'Supermajors', 'castes', { caste: 'supermajor' },
    'A few ant genera, Pheidole among them, can produce supermajors: giant workers many times heavier than ordinary minors, with '
    + 'enormous heads packed with muscle. They are costly to raise and rarely seen, but when the nest is attacked they plug the '
    + 'entrances and crush intruders with their mandibles.'),
  fg_alates: G('fg_alates', 'Alates', 'founding', { caste: 'alate' },
    'Alates are the winged males and virgin queens a mature colony produces once it can afford them. They take no part in work. Fed '
    + 'and groomed by their sisters, they wait in the nest, sometimes for weeks, until the weather is right for the flight that will '
    + 'found new colonies.'),
  fg_nuptial_flight: G('fg_nuptial_flight', 'Nuptial Flights', 'founding', { counter: 'flights', gte: 1 },
    'On a warm, still day after rain, colonies across a whole region release their alates at nearly the same moment. Swarms from many '
    + 'nests mix in the air, which helps queens find unrelated mates. Afterwards each mated queen lands, breaks off her wings and '
    + 'searches for a place to dig.'),
  fg_trophobiosis: G('fg_trophobiosis', 'Trophobiosis', 'farming', { custom: 'aphidHerded' },
    'Aphids feed on plant sap and excrete the surplus sugar as honeydew. Ants collect it, often stroking the aphids with their antennae '
    + 'to prompt a droplet, and in return they guard the herd against ladybirds and parasitic wasps. Some ants even carry their aphids '
    + 'to fresh plants.'),
  fg_root_aphids: G('fg_root_aphids', 'Root Aphids', 'farming', { chamber: 'root_aphid_pen' },
    'Several ant species keep aphids underground, in chambers built around the roots of grasses and shrubs. The aphids tap the roots '
    + 'for sap while the ants tend them in darkness, safe from predators and weather. Some colonies move their herds deeper in autumn '
    + 'and carry aphid eggs through winter.'),
  fg_lycaenid: G('fg_lycaenid', 'Lycaenid Caterpillars', 'farming', { source: 'lycaenid_caterpillar' },
    'Many caterpillars of blue and hairstreak butterflies have glands that secrete sugary droplets and organs that release '
    + 'ant-attracting chemicals. Ants that find one stand guard over it and drink the reward. The caterpillar gets bodyguards against '
    + 'wasps and spiders, and the ants get a steady supply of sweet food.'),
  fg_fungus_gardens: G('fg_fungus_gardens', 'Fungus Gardens', 'farming', { chamber: 'fungus_garden' },
    'Leafcutter ants do not eat the leaves they carry. They chew the fragments into a pulp and use it to feed a fungus that grows only '
    + 'in their nests. The fungus produces swollen tips rich in fats and sugars, which feed the larvae. It is agriculture, millions of '
    + 'years older than ours.'),
  fg_weeder_ants: G('fg_weeder_ants', 'Weeder Ants', 'farming', { research: 'weeder_ants' },
    'A fungus garden is a constant target for invading moulds. Small gardener ants patrol it, licking the surface clean, plucking out '
    + 'infected patches and carrying them to waste dumps. Many also carry bacteria on their bodies that produce antibiotics, a living '
    + 'chemical defence that keeps the crop healthy.'),
  fg_midden: G('fg_midden', 'Middens', 'nest', { chamber: 'midden' },
    'Colonies keep their waste well away from brood and food stores. Workers carry dead nestmates, food scraps and spent fungus to a '
    + 'refuse pile, a habit called necrophoresis. Midden workers often stay with the waste for life and are kept apart from the '
    + 'nursery, which limits the spread of disease.'),
  fg_mound_heat: G('fg_mound_heat', 'Mound Heating', 'nest', { mound: 5 },
    'The thatched mounds of wood ants work as solar collectors. Their sloped surfaces catch the low morning sun, and workers move brood '
    + "up and down through the mound to follow the warmest layers. The colony's own metabolism adds heat too, keeping the core warm "
    + 'long after sunset.'),
  fg_overwintering: G('fg_overwintering', 'Overwintering', 'nest', { season: 'winter' },
    'Ants cannot keep their bodies warm, so temperate colonies retreat deep below the frost line when autumn ends. They cluster in '
    + 'still, humid chambers and slip into a cold torpor called diapause, barely moving or eating. Stored fat and full crops carry them '
    + 'through until spring warms the soil again.'),
  fg_seed_harvesting: G('fg_seed_harvesting', 'Seed Harvesting', 'farming', { source: 'seed_patch' },
    'Harvester ants gather seeds by the thousand and store them in dry underground granaries. Workers husk the seeds and discard the '
    + 'chaff outside the nest. After rain, damp seeds are carried up to dry in the sun before they can sprout, and a well-stocked '
    + 'colony can live on its stores for months.'),
  fg_square_law: G('fg_square_law', 'The Square Law', 'behaviour', { any: [{ emitted: 'battleStart' }, { path: 'run.stats.battles', gte: 1 }] },
    'In open battle, ant armies follow a rule first worked out for human warfare: fighting strength grows with the square of numbers, '
    + 'because every fighter can engage an enemy at once. Field studies of ant fights have found the same pattern. Doubling a force '
    + 'roughly quadruples its power, so numbers usually beat individual strength.'),
  fg_ritual_tournaments: G('fg_ritual_tournaments', 'Ritual Tournaments', 'behaviour', { custom: 'tournament' },
    'Neighbouring honeypot ant colonies settle many disputes without bloodshed. Workers meet at the border and perform stilt-legged '
    + 'displays, raising their bodies and inflating their abdomens to look as large as possible. The side that shows more and bigger '
    + 'workers usually wins, and a badly outmatched colony may be overrun and lose its brood.'),
  fg_black_garden_ant: G('fg_black_garden_ant', 'Black Garden Ant', 'species', { rival: 'black_garden_ants' },
    'Lasius niger is one of the most common ants in gardens and pavements across Europe. Its colonies can hold thousands of workers '
    + 'under a single queen who may live for decades. It farms aphids intensively, and its huge synchronised mating flights fill summer '
    + 'evenings with winged ants.'),
  fg_pavement_ant: G('fg_pavement_ant', 'Pavement Ant', 'species', { rival: 'pavement_ants' },
    'Tetramorium pavement ants are famous for their spring turf wars. Neighbouring colonies pour out onto the pavement by the thousand '
    + 'and wrestle, bite and drag one another in a seething mass that can last for hours. Surprisingly few ants die; the battles seem '
    + 'to settle where each colony may forage.'),
  fg_red_wood_ant: G('fg_red_wood_ant', 'Red Wood Ant', 'species', { rival: 'red_wood_ants' },
    'Formica wood ants build large thatched mounds in forests and defend wide territories. They have no sting; instead they bite and '
    + 'spray formic acid from the tip of the abdomen, sometimes several workers at once. A disturbed mound gives off a sharp vinegar '
    + 'smell as thousands of workers take aim.'),
  fg_carpenter_ant: G('fg_carpenter_ant', 'Carpenter Ant', 'species', { rival: 'carpenter_ants' },
    'Camponotus carpenter ants excavate galleries in dead or damp wood. They do not eat the wood but push the sawdust out of the nest '
    + 'in small piles. Large colonies spread across several satellite nests linked by trails, and major workers with powerful jaws '
    + 'defend the entrances.'),
  fg_fire_ant: G('fg_fire_ant', 'Fire Ant', 'species', { rival: 'fire_ants' },
    'Solenopsis invicta stings with a venom made of alkaloids that burns and leaves a white blister. When floods cover their nests, '
    + 'workers link legs and jaws to form a living raft that floats with the queen and brood aboard until it reaches dry ground. '
    + 'Introduced populations have spread across several continents.'),
  fg_slave_maker: G('fg_slave_maker', 'Slave-maker Ant', 'species', { rival: 'slave_makers' },
    "Formica sanguinea raids the nests of other Formica species and carries off their pupae. The captives hatch in the raiders' nest, "
    + 'accept it as home and work for their captors, foraging and tending brood. The raiding species can survive on its own but grows '
    + 'far faster with stolen labour.'),
  fg_army_ant: G('fg_army_ant', 'Army Ants', 'species', { ev: 'ev_army_ant_column' },
    'Eciton army ants build no permanent nest. Hundreds of thousands of workers hunt in a moving swarm front that flushes out insects, '
    + 'spiders and even small vertebrates, and they shelter at night in a living bivouac made of their own linked bodies. Colonies '
    + 'alternate between nomadic raiding phases and stationary breeding phases.'),
  fg_argentine_ant: G('fg_argentine_ant', 'Argentine Ant', 'species', { rival: 'great_rival' },
    'In its introduced range, the Argentine ant barely distinguishes nestmates from strangers across huge distances. Workers from nests '
    + 'hundreds of kilometres apart treat each other as family, forming supercolonies that span coastlines. Without internal wars, '
    + 'they can overwhelm native ants in sheer numbers.'),
  fg_ladybird: G('fg_ladybird', 'Ladybirds', 'hazards', { ev: 'ev_ladybug_raid' },
    'Ladybirds and their larvae are among the most voracious aphid predators, each eating dozens of aphids a day. For ants that farm '
    + 'aphids they are a direct threat to the herd. Workers attack them on sight, biting legs and antennae and trying to tip the beetles '
    + 'off the plant.'),
  fg_antlion: G('fg_antlion', 'Antlions', 'hazards', { ev: 'ev_antlion_pit' },
    'An antlion larva digs a cone-shaped pit in loose sand and buries itself at the bottom with only its jaws exposed. An ant that '
    + 'steps over the rim slides down the crumbling walls, and the larva flicks sand at it to bring it within reach. The adult is a '
    + 'delicate, lacewing-like insect.'),
  fg_horned_lizard: G('fg_horned_lizard', 'Horned Lizards', 'hazards', { ev: 'ev_horned_lizard' },
    'Horned lizards of the American deserts live mainly on ants, especially harvester ants. A lizard settles beside a busy foraging '
    + 'trail and picks off workers one by one, sometimes eating hundreds in a single meal. Mucus in its throat binds the ants, '
    + 'protecting the lizard from their stings.'),
  fg_ophiocordyceps: G('fg_ophiocordyceps', 'Zombie-ant Fungus', 'hazards', { ev: 'ev_ophiocordyceps' },
    'Ophiocordyceps fungi infect carpenter ants and take control of their behaviour. An infected worker leaves the nest, climbs '
    + 'vegetation and clamps its jaws onto a leaf vein before dying. A stalk then grows from its head and rains spores onto the trail '
    + 'below. Healthy colonies remove sick workers quickly.'),
  fg_phengaris: G('fg_phengaris', 'The Large Blue', 'hazards', { ev: 'ev_phengaris_caterpillar' },
    'The Large Blue butterfly has a caterpillar that smells like an ant larva. Workers carry it into their nest and place it among '
    + 'their own brood. Depending on the species, it either begs food like a cuckoo or quietly eats the ant larvae, and it emerges as a '
    + 'butterfly the following summer.'),
  fg_phorid_flies: G('fg_phorid_flies', 'Phorid Flies', 'hazards', { ev: 'ev_phorid_flies' },
    'Tiny phorid flies hover above ant trails waiting to strike. A female darts down and injects an egg into a worker; the larva later '
    + 'moves into the head, eats its contents and finally decapitates its host. The mere presence of these flies makes whole trails '
    + 'slow down and hide.'),
  fg_myrmecophiles: G('fg_myrmecophiles', 'Myrmecophiles', 'hazards', { ev: 'ev_myrmecophile_guest' },
    "Ant nests host a crowd of uninvited guests: beetles, crickets, mites and silverfish. Many of them copy the colony's scent so well "
    + 'that workers feed and groom them as nestmates. Some guests clean up waste, but others quietly prey on brood, and the colony '
    + 'rarely notices the difference.'),
  fg_twenty_quadrillion: G('fg_twenty_quadrillion', 'Twenty Quadrillion', 'world', { census: 1e9 },
    'A recent estimate puts the number of ants alive on Earth at around twenty quadrillion, roughly two and a half million for every '
    + 'person. Together they weigh more than all wild birds and mammals combined. The figure is rough, but it shows how completely '
    + 'ants have spread across the land.'),
  fg_amber: G('fg_amber', 'Ants in Amber', 'world', { counter: 'amber', gte: 1 },
    'Ants trapped in tree resin tens of millions of years ago survive today in amber, every hair and joint intact. The oldest known '
    + 'ants come from Cretaceous amber about a hundred million years old, alongside dinosaurs. Some early forms had wasp-like features, '
    + 'showing how ants evolved from wasp ancestors.'),
});
