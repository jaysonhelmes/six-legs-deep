// Shared JSDoc typedefs for the whole code base (no runtime code).
// Owner: WP1. Contract: ARCHITECTURE §4 (state), §5 (derived), §7 (runtime), §8 (system shapes).

/**
 * Resource key accepted by core/wallet.js.
 * @typedef {'food'|'soil'|'insight'|'pheromone'|'chitin'|'honeydew'|'leaves'|'fungus'|'alates'|'kinship'|'genes'} ResKey
 */

/**
 * A cost or reward amount per resource (missing keys = 0).
 * @typedef {{ food?: number, soil?: number, insight?: number, pheromone?: number, chitin?: number, honeydew?: number,
 *             leaves?: number, fungus?: number, alates?: number, kinship?: number, genes?: number }} Cost
 */

/**
 * Growth cost: cost(L) = base × growth^L per resource.
 * @typedef {{ base: Cost, growth: number }} GrowthCost
 */

/**
 * Softcap chain: [threshold, power] pairs applied in sequence.
 * @typedef {Array<[number, number]>} SoftcapChain
 */

/**
 * Reason codes returned by command validation (ARCHITECTURE §7.4). A handler may append ':detail'.
 * @typedef {'unknown'|'paused'|'locked'|'cantAfford'|'invalid'|'max'|'noSlot'|'blocked'|'cooldown'|'busy'|'hardship'|
 *           'notFound'|'queueFull'|'clickCap'|'requirements'|string} ReasonCode
 */

/**
 * Stat keys used by core/effects.js (ARCHITECTURE §7.7).
 * @typedef {'forage'|'forage_trail'|'forage_add'|'forage_unescorted'|'surface_work'|'source_type'|'source'|'honeydew'|
 *           'lay'|'brood_time'|'insight'|'atk_player'|'ap_rival'|'chamber'|'chamber_layer'|'frost_snap'|'flight_w'|
 *           'no_raids'|string} StatKey
 */

/**
 * Timed or persistent modifier stored in s.run.effects.
 * @typedef {Object} Effect
 * @property {string} id      unique source key (e.g. 'ev_queens_vigor', 'rally:12')
 * @property {StatKey} stat
 * @property {number} mult    multiplier (default 1)
 * @property {number} add     additive amount (default 0)
 * @property {null|string|number} scope
 * @property {number} t       seconds remaining, or -1 = until removed
 */

/**
 * Input accepted by addEffect (defaults filled in).
 * @typedef {Object} EffectInput
 * @property {string} id
 * @property {StatKey} stat
 * @property {number} [mult]
 * @property {number} [add]
 * @property {null|string|number} [scope]
 * @property {number} [t]
 * @property {boolean} [reset]  true: the new t replaces the old one instead of max(old, new)
 */

/** @typedef {{ c: 'minor'|'soldier'|'supermajor'|'replete'|'alate', n: number, p: number, t: number }} Cohort */

/**
 * @typedef {Object} Chamber
 * @property {number} uid
 * @property {string} type
 * @property {number} k
 * @property {number} x
 * @property {number} y
 * @property {number} w
 * @property {number} h
 * @property {number} level
 * @property {number} target
 * @property {'digging'|'active'|'growing'|'relocating'} status
 * @property {boolean} blueprint
 * @property {number} bornAt
 */

/**
 * @typedef {Object} DigJob
 * @property {number} uid
 * @property {'tunnel'|'chamber'|'grow'|'shaft'|'relocate'} kind
 * @property {number} chamber
 * @property {number[]} cells
 * @property {number} cur
 * @property {number} prog
 * @property {number} paidFood
 * @property {boolean} blueprint
 */

/** @typedef {{ i: number, kind: 'seed_cache'|'beetle_husk'|'fossil'|'amber_bead', found: boolean, hinted: boolean }} CacheFeature */
/** @typedef {{ x: number, y: number, w: number, h: number, revealed: boolean }} WaterPocket */
/** @typedef {{ col: number, y0: number, y1: number }} RootLine */

/**
 * @typedef {Object} Source
 * @property {number} uid
 * @property {string} type
 * @property {number} hex
 * @property {number} stock   -1 = infinite
 * @property {number} max     -1 = infinite
 * @property {number} level
 * @property {number} herdT
 * @property {number} age
 * @property {number} ttl     -1 = none
 * @property {number} cd
 * @property {Object} data
 */

/**
 * @typedef {Object} Trail
 * @property {number} uid
 * @property {number} origin
 * @property {number} src
 * @property {number[]} path
 * @property {number} len
 * @property {'forager'|'herder'|'leafcutter'|'lycaenid'} job
 * @property {number} workers
 * @property {number} escorts
 * @property {number} S
 * @property {number} born
 * @property {number[]} reroutes
 */

/**
 * @typedef {Object} Rival
 * @property {number} uid
 * @property {string} type
 * @property {number} tier
 * @property {number} hex
 * @property {number} radius
 * @property {number} base
 * @property {number} n
 * @property {number} atk
 * @property {number} hp
 * @property {string[]} traits
 * @property {boolean} alive
 * @property {boolean} sighted
 * @property {number} raidIn
 * @property {number} truce
 * @property {number} bribeCd
 * @property {number} tourCd
 * @property {number} creepIn
 * @property {number} group
 * @property {number} fallenAt
 * @property {number[]} extra
 * @property {number[]} lost
 * @property {number} stolen
 */

/**
 * @typedef {Object} Party
 * @property {number} uid
 * @property {'raid'|'assault'|'hunt'|'termite'|'guard'|'reinforce'} kind
 * @property {{ type: 'rival'|'source'|'raid'|'battle', uid: number }} target
 * @property {number} soldier
 * @property {number} supermajor
 * @property {number[]} path
 * @property {number} pos
 * @property {'out'|'fighting'|'home'} state
 */

/** @typedef {{ militia: number, soldier: number, supermajor: number }} Army */
/** @typedef {{ n: number, atk: number, hp: number }} Foe */

/**
 * @typedef {Object} Battle
 * @property {number} uid
 * @property {string} kind
 * @property {number} hex
 * @property {boolean} below
 * @property {number} party
 * @property {number} raid
 * @property {Army} you
 * @property {Foe} foe
 * @property {{ you: number, foe: number }} start
 * @property {{ you: number, foe: number }} f
 * @property {number} homeMult
 * @property {number} acc
 * @property {number} t
 * @property {number} rally
 * @property {number} retreatAt
 * @property {RewardSpec|null} reward
 * @property {string} tag
 * @property {number} odds
 */

/**
 * @typedef {Object} Raid
 * @property {number} uid
 * @property {number} rival
 * @property {{ type: 'trail', uid: number } | { type: 'nest' }} target
 * @property {number} raiders
 * @property {number} warn
 * @property {'warning'|'trail'|'border'|'gate'|'done'} phase
 * @property {number} guard
 */

/** @typedef {{ foodSec?: number, foodMin?: number, food?: number, chitin?: number, chitinSec?: number, chitinMin?: number, insight?: number, minors?: number }} RewardSpec */
/** @typedef {{ kind: string, hex: number, below?: boolean, you: Army, foe: Foe, homeMult?: number, party?: number, raid?: number, reward?: RewardSpec|null, tag?: string }} BattleSpec */

/** @typedef {{ uid: number, id: string, t: number, choices: string[], data: Object }} EventCard */
/** @typedef {{ uid: number, id: string, t: number, data: Object }} ActiveEvent */
/** @typedef {{ uid: number, kind: string, hex: number, cell: number, t: number, data: Object }} EventObject */

/**
 * @typedef {Object} PendingChoice
 * @property {'landing'} kind
 * @property {Array<{ seed: number, tags: string[] }>} options
 * @property {string[]} boons
 * @property {boolean} chooseSeason
 * @property {number} alates
 * @property {string|null} hardship
 */

/** @typedef {{ kind: 'run'|'cycle'|'era', cells: string, at: number }} StrataRecord */
/** @typedef {{ name: string, chambers: Array<{ type: string, x: number, y: number, w: number, h: number, level: number }>, tunnels: number[] }} Blueprint */

/**
 * The whole game state: one plain JSON object (ARCHITECTURE §4). Subtrees by reset scope:
 * meta (never), era (Speciation), cycle (Supercolony), run (Nuptial Flight).
 * @typedef {Object} State
 * @property {number} v
 * @property {number} rng
 * @property {Object} meta
 * @property {Object} era
 * @property {Object} cycle
 * @property {Object} run
 */

/**
 * Derived cache (ARCHITECTURE §5); never saved, always rebuildable from State.
 * @typedef {Object} Derived
 * @property {Object<string, Object<string, number>>} ledger
 * @property {Object} season
 * @property {Object} meta
 * @property {Object} nest
 * @property {Object} surface
 * @property {Object} stats
 * @property {Object} rates
 * @property {Object} combat
 * @property {Object} progress
 * @property {{ cells: number[], chambers: number[] } | null} offlineLog
 */

/** A player command (ARCHITECTURE §9). @typedef {{ type: string, [key: string]: any }} Command */
/** An event emitted by a tick (ARCHITECTURE §10). @typedef {{ type: string, [key: string]: any }} GameEvent */

/**
 * Command handler (ARCHITECTURE §7.4).
 * @typedef {Object} Handler
 * @property {(s: State, d: Derived, cmd: Command) => (ReasonCode|null)} validate
 * @property {(s: State, d: Derived, cmd: Command, env: Env) => void} apply
 */

/**
 * Tick environment (ARCHITECTURE §7.3).
 * @typedef {Object} Env
 * @property {number} dt         real-time seconds this tick
 * @property {number} econDt     dt × econScale (economy, laying, brood, digging)
 * @property {boolean} offline   true inside simulateOffline
 * @property {number} eff        offline efficiency (1 online)
 * @property {GameEvent[]} events
 * @property {(type: string, payload?: Object) => void} emit
 */

/** @typedef {{ offline?: boolean, eff?: number, econScale?: number }} StepOpts */

/**
 * Offline summary (ARCHITECTURE §7.15).
 * @typedef {Object} OfflineSummary
 * @property {number} seconds
 * @property {number} eff
 * @property {number} foodGained
 * @property {number} foodWasted
 * @property {number} hatched
 * @property {number} cellsDug
 * @property {number} chambersDone
 * @property {number} seasons
 * @property {number} sourcesDepleted
 * @property {number} savedFinds
 * @property {number} diapause
 * @property {number[]} cells
 * @property {number[]} chambers
 */

/** Random number holder: any object with a uint32 `rng` field. @typedef {{ rng: number }} Holder */

/**
 * Storage-like object (window.localStorage or a test double).
 * @typedef {{ getItem(key: string): (string|null), setItem(key: string, val: string): void, removeItem(key: string): void }} StorageLike
 */

/** @typedef {{ get(key: string): (string|null), set(key: string, val: string): boolean, remove(key: string): boolean, lastError: (string|null) }} StorageWrap */

/** @typedef {{ ok: boolean, reason: (ReasonCode|null) }} ActionResult */

/**
 * UI-facing actions (ARCHITECTURE §7.5): `do(type, args)` plus one function per registered command type.
 * @typedef {{ do: (type: string, args?: Object) => ActionResult, [type: string]: (args?: Object) => ActionResult }} Actions
 */

/**
 * The game object (ARCHITECTURE §7.1).
 * @typedef {Object} Game
 * @property {State} s
 * @property {Derived} d
 * @property {ReturnType<typeof import('./bus.js').createBus>} bus
 * @property {Actions} actions
 * @property {Command[]} queue
 * @property {number} acc
 * @property {boolean} storageOk
 * @property {number} saveGen   save generation this game loaded or last wrote (TABS.genKey; ARCHITECTURE §18 C80)
 * @property {boolean} stale     another game wrote a newer save; save() refuses (C80)
 * @property {{ beforePrestige: (null|(() => void)) }} hooks
 * @property {(nowMs: number, seed?: number) => void} newGame
 * @property {(nowMs: number) => { loaded: boolean, error: (string|null), welcome: (OfflineSummary|null) }} loadOrNew
 * @property {(realDtSec: number, nowMs: number, opts?: { maxTicks?: number, budgetMs?: number, clock?: () => number }) => void} advance
 * @property {(gapSec: number, nowMs: number, opts?: { hidden?: boolean, hiddenSec?: number }) => OfflineSummary} catchUp
 * @property {(cmd: Command) => ActionResult} dispatch
 * @property {(dt?: number, opts?: { econScale?: number }) => GameEvent[]} tickOnce
 * @property {(seconds: number, opts?: { dt?: number, onTick?: Function }) => void} runFor
 * @property {(nowMs: number, opts?: { hidden?: boolean }) => { ok: boolean, error: (string|null) }} save
 * @property {(nowMs: number) => string} exportString
 * @property {(str: string, nowMs: number) => { ok: boolean, error: (string|null) }} importString
 * @property {(nowMs: number) => void} hardReset
 */

/**
 * Canvas/UI hit-test target (render/ui; shape owned by WP8, listed here for typing).
 * @typedef {{ kind: string, [key: string]: any }} Target
 */

export {};
