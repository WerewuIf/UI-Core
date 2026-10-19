/* =============================================================================
 * Cube Suite  (Core addon, version 3.2.3)  -  port of the Tampermonkey script "Cube Suite" 2.7.8
 *
 * Runs inside Core (addons/core.js): `Core` is in scope, so this file is NOT a userscript.
 * List it in addons.json (see the entry in the notes) or add its raw URL in the Addons panel.
 *
 * What moved onto Core's API
 *   Core.clock      server time (schedule switches, PvP cap step at 16:00). Replaces page-scraped data-epoch.
 *   Core.tab        which tab runs the loop (Web Lock, queued) + Core.keepAlive in that tab.
 *   (UI)            no dock icon: the panel loads straight onto the page as the old floating, draggable window.
 *   Core.player     player id / name, Core.me exp - no extra dashboard fetch when the sidebar is there.
 *
 * Bug fixes are marked  // FIX:  in the code.
 * v2 review pass (PvP self-detection by id, explicit pick_slot params, single-shot POSTs, PvE/SA network fail-safes,
 * tab-handoff settings reload, guild-check retry, HTML escaping) is marked  // FIX2:
 * v3.2.1 audit pass (PvE bootstrap/cap/tab/potion fixes, SA assign+retreat failure detection, PvP turn retry,
 * stale guild-check overlay, panel on-screen clamp) is marked  // FIX:  with (a)-(d) tags.
 * v3.2.2: looksLikeBlankErrorPage removed (HTTP status only), Fast Run scan every 1 s, potion inv id read from the sidebar drawer.
 * ========================================================================== */
(async function () {
  'use strict';

  if (!/\/guild_dungeon_cube\.php$/.test(location.pathname) || !new URLSearchParams(location.search).get('instance_id')) return;
  if (!window.Core || !window.Core.__isCore) { console.warn('[Cube Suite] Core is not loaded'); return; }

  const RUN_KEY = '__dungeonCubeSuite_v3';
  if (window[RUN_KEY]) return;
  window[RUN_KEY] = true;

  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │ GAME FLOW OVERVIEW   do not remove documentation comments in script!!   │
  // │                                                                         │
  // │ ── PVP FLOW ─────────────────────────────────────────────────────────── │
  // │                                                                         │
  // │ 1. guild_dungeon.php                                                    │
  // │    → locate the active "Polyhedral Crucible" instance + extract its id  │
  // │                                                                         │
  // │ 2. guild_dungeon_cube.php?instance_id=X                                 │
  // │    → node table; rows use <tr data-select-node="7|8">                   │
  // │    Node 7 (Ring Ward)  – available while the cube is active             │
  // │    Node 8 (Duel Heart) – has .statusPill.status-hidden + .tableLocked   │
  // │      until ALL node-7 PvP matches are cleared; script skips it then     │
  // │                                                                         │
  // │ 3. pvp_style_node.php?source=cube&instance_id=X&node_id=Y              │
  // │    → lists .match cards for a node; relevant badges:                    │
  // │      .badge.clear              → cleared, done, unjoinable              │
  // │      .badge.live text="LIVE"   → in-progress, unjoinable                │
  // │      .badge.live text="Elite…" → elite difficulty (more rewards), still joinable       │
  // │      .badge.open               → open, waiting for players              │
  // │    A .warn div means you're committed to a match (~2 h cooldown).       │
  // │    We still parse match cards during cooldown to count self-slots;      │
  // │    we only skip the "find something to join" step.                      │
  // │                                                                         │
  // │ 4. pvp_style_battle.php?source=cube&instance_id=X&node_id=Y&match_no=Z │
  // │    → actual match room; ally slots are #bottomTeamCard .pSlot           │
  // │      Open:     class="pSlot joinable"  data-key=""  data-user-id="0"   │
  // │                data-username="Open Slot"  (placeholder img present)     │
  // │      Occupied: class="pSlot"  data-key="ally:N"  data-user-id="12345"  │
  // │    POST pvp_style_action.php  action=pick_slot&slot_index=N  to join.   │
  // │                                                                         │
  // │ PVP ACTIONS (pvp_style_action.php):                                     │
  // │   action=pick_slot    – claim an open slot              (used)          │
  // │   action=start_trial  – force-start the match; FAST RUN + LEADER only   │
  // │                         starts ANY match on an unlocked node that has    │
  // │                         ≥1 occupant, regardless of the configured target │
  // │                         match numbers — those govern joining, not starts │
  // │   action=leave_room   – leave a slot before match starts                │
  // │   action=surrender    – forfeit an in-progress match                    │
  // │                                                                         │
  // │ JOIN COUNTER — derived LIVE from node pages each scan cycle.            │
  // │   Never stored in localStorage.  Counts matches where the player        │
  // │   currently occupies a slot (hasSelf===true) across both nodes.         │
  // │   Resets to 0 on instance change, then repopulates on next scan.        │
  // │   Catches manually joined matches automatically — no sync needed.       │
  // │   pvpReadOnlyScan keeps the counter live even when master is OFF:       │
  // │   automation paused but monitoring continues at normal poll rate.       │
  // │                                                                         │
  // │ NODE STATS PILL STATES (pvpNodeStats[nodeId]):                          │
  // │   hasSelf    — player currently occupies a slot in an active match      │
  // │   onCooldown — match finished but 2h lockout still active (NOT in match)│
  // │   hasOpen    — open slots available to join                             │
  // │   allCleared — every match on this node is cleared                      │
  // │   Priority order in UI: locked > cleared > hasSelf > onCooldown >       │
  // │   hasOpen > no matches                                                  │
  // │                                                                         │
  // │ TAB DEDUP — blocking overlay on second tab.                             │
  // │   On init, each tab checks localStorage for an active heartbeat.        │
  // │   If one exists from a different TAB_ID, a full-screen overlay          │
  // │   is shown and the script does not start. The overlay clears            │
  // │   automatically when the other tab closes (beforeunload removes         │
  // │   the key → storage event) or its heartbeat expires (TAB_EXPIRE_MS).   │
  // │   On unblock, this tab claims ownership, starts the heartbeat,          │
  // │   mounts the UI, and begins the run loop.                               │
  // │                                                                         |
  // │ MODE SWITCH — switching Normal ↔ Fast Run always pauses master toggle.  │
  // │   Prevents the wrong mode's scan logic from firing mid-switch while     │
  // │   state (fastRunState, joinedNodeX) may not yet reflect the new mode.   │
  // │   pvpScanViceLeader (start_trial) is gated to Fast Run + isLeader only: │
  // │   it never fires in Normal mode or when the leader flag is off, even    │
  // │   if the function is somehow reachable. The isLeader flag itself        │
  // │   survives reloads (persisted in PVP_FAST_RUN_KEY) but is unaffected    │
  // │   by instance changes — flip it off manually when handing off control.  │
  // │                                                                         │
  // │ ── SHADOW ARMY FLOW ─────────────────────────────────────────────────── │
  // │                                                                         │
  // │ 1. guild_dungeon_cube.php?instance_id=X                                 │
  // │    → same node table; Army nodes identified by .statusPill "army" pill  │
  // │      and a data-enter-node button (default targets: Nodes 5, 6, 11)     │
  // │                                                                         │
  // │ 2. guild_dungeon_cube_army_enter.php?source=game_dash&instance_id=X     │
  // │    &node_id=Y                                                            │
  // │    → node page; contains inline JS:                                     │
  // │        let fightCards  = [{ match_no, status, battle_id,                │
  // │                              attackers_preview }];                       │
  // │        let activeMatchNo = N;   // > 0 when committed to a fight        │
  // │                                                                         │
  // │ 3. guild_dungeon_cube_army_action.php                                   │
  // │    POST action=enter_fight   → { battle_id }                            │
  // │    POST action=contributors  → damage leaderboard                       │
  // │                                                                         │
  // │ 4. shadow_army_live_battle.php                                          │
  // │    POST action=join_battle    → full state (captains, engagements)      │
  // │    POST action=assign_target  → pair attacker_captain → defender        │
  // │    POST action=retreat_captain → pull captain back from combat IMOPORTANT!         │
  // │                                                                         │
  // │ SA MODES:                                                               │
  // │   Ordinary  – assign one captain → attack → retreat (safe DPS)         │
  // │   Fast Run  – assign all captains(one captain to one defender) → attack → no retreat (nuke/max DPS) │
  // │                                                                         │
  // │ NO FIGHT CAP — SA participates in every available live fight that we    │
  // │   havent participated in (except when fast run).                        │
  // │   Duplicate-participation is prevented per-session by a key store       │
  // │   (SA_PARTICIPATED_KEY) tied to the active dungeon instance.            │
  // │   On instance change the key store is reset automatically.              │
  // │   SA participated count reads localStorage — always accurate even when  │
  // │   master toggle is OFF; no extra network request needed.                │
  // │                                                                         │
  // │ ── PASSIVE MONITORING (master toggle OFF) ───────────────────────────── │
  // │   Disabling master toggle pauses all join/fight actions but does NOT    │
  // │   stop monitoring.  pvpReadOnlyScan runs each tick in place of the      │
  // │   full pvpTick: it scans node pages, counts hasSelf slots, and writes   │
  // │   pvpLiveJoinCount so the UI always reflects the real join state        │
  // │   (including matches joined manually while automation was paused).      │
  // │   SA participated count comes from localStorage — always current.       │
  // │   runLoop uses the normal interval when master is OFF regardless of     │
  // │   mode; fast-mode 1 s polling only fires when actively auto-joining.  │
  // └─────────────────────────────────────────────────────────────────────────┘

  const DUNGEONS_URL      = 'https://demonicscans.org/guild_dungeon.php';
  const CUBE_DUNGEON_BASE = 'https://demonicscans.org/guild_dungeon_cube.php';
  const DASH_URL          = 'https://demonicscans.org/game_dash.php';
  const FETCH_TIMEOUT_MS  = 8_000;
  const CUBE_STATE_MAX_STALE_MS = 5 * 60_000;

  const GUILD_NAME        = '[AHAB] Casual Ahab';
  const GUILD_MEMBERS_URL = 'https://demonicscans.org/guild_members.php';

  const PVP_SOURCE            = 'cube';
  const PVP_NODE_URL_BASE     = 'https://demonicscans.org/pvp_style_node.php';
  const PVP_ACTION_URL        = 'https://demonicscans.org/pvp_style_action.php';
  const PVP_NODE_PRIORITY     = [7, 8];
  const PVP_NODE_TITLES = { 7: 'Ring Ward', 8: 'Duel Heart' };
  const PVP_SCHEDULE = [
    { hour: 0,  minute: 0, limit: 6,  label: 'capped' }, // from midnight — capped at 6
    { hour: 16, minute: 0, limit: 40, label: 'ffa' },    // from 4PM server time — FFA opens, cap raises to 40
  ];
  const PVP_SCAN_INTERVAL_MS  = 60_000;
  const PVP_FAST_INTERVAL_MS  = 1_000;   // Fast Run scan interval
  const PVP_DEBUG             = false;

  const PVP_STATE_URL           = 'https://demonicscans.org/pvp_style_state.php';
  const PVP_BATTLE_POLL_MS      = 1_200;  // active monitor poll rate once the match is live
  const PVP_BATTLE_WAIT_POLL_MS = 2_000;  // poll rate while joined but waiting on start_trial
  const PVP_POWER_SLASH_RE      = /power\s*slash/i;
  const PVP_SLASH_RE = /\bslash\b/i;   // token-generating basic attack

  const PVP_TYRANT_NODE_ID      = 9;
  const PVP_TYRANT_ENABLED_KEY  = 'autocube_pvp_tyrant_enabled_v1';

  const SA_SOURCE         = 'game_dash';
  const SA_NODE_URL_BASE  = 'https://demonicscans.org/guild_dungeon_cube_army_enter.php';
  const SA_ACTION_API     = 'https://demonicscans.org/guild_dungeon_cube_army_action.php';
  const SA_BATTLE_API     = 'https://demonicscans.org/shadow_army_live_battle.php';
  const SA_HEAL_URL       = 'https://demonicscans.org/shadow_army.php';
  const SA_TARGET_NODES   = [5, 6, 11];  // army nodes scanned each cycle
  const SA_SCAN_MS        = 120_000;
  const SA_NODE_GAP_MS    = 1_500;    // pause between scanning consecutive nodes
  const SA_ASSIGN_GAP_MS  = 300;      // pause between assign_target calls (Fast Run)
  const SA_HIT_GAP_MS     = 800;      // pause between assign and retreat (Ordinary)
  const SA_JOIN_DELAY_MS  = 800;      // pause after join_battle before reading state
  const SA_DAMAGE_POLL_MS = 1_200;    // interval between damage confirmation polls
  const SA_DAMAGE_TRIES   = 4;        // max polls waiting for damage to register

  const SA_SCHEDULE = [
    { nodeId: 5,  hour: 1, minute: 0, matchNo: 1, mode: 'fastrun' }, // Stage 1, Match 1 (1:00 AM)
    { nodeId: 5,  hour: 2, minute: 0, matchNo: 2, mode: 'fastrun' }, // Stage 1, Match 2 (2:00 AM)
    { nodeId: 5,  hour: 3, minute: 0, matchNo: 3, mode: 'fastrun' }, // Stage 1, Match 3 (3:00 AM)
    { nodeId: 5,  hour: 4, minute: 0, matchNo: 4, mode: 'fastrun' }, // Stage 1, Match 4 (4:00 AM)
    { nodeId: 6,  hour: 5, minute: 0, matchNo: 1, mode: 'fastrun' }, // Stage 2, Match 1 (5:00 AM)
    { nodeId: 6,  hour: 6, minute: 0, matchNo: 2, mode: 'fastrun' }, // Stage 2, Match 2 (6:00 AM)
    { nodeId: 6,  hour: 7, minute: 0, matchNo: 3, mode: 'fastrun' }, // Stage 2, Match 3 (7:00 AM)
    { nodeId: 6,  hour: 8, minute: 0, matchNo: 4, mode: 'fastrun' }, // Stage 2, Match 4 (8:00 AM)
    { nodeId: 11, hour: 9, minute: 0, matchNo: 1, mode: 'fastrun' }, // Stage 3, Final Match (9:00 AM)
  ];

  const SA_SCHED_NUKE_KEY    = 'autocube_sa_sched_nuke_v1';
  const SA_SCHED_HANDLED_KEY = 'autocube_sa_sched_handled_v1';

  const SA_SCHED_PREV_KEY = (() => {
    const prevByKey = new Map();
    const lastKeyForNode = new Map();
    for (const e of SA_SCHEDULE) {
      const key = `${e.nodeId}:h${e.hour}:m${e.minute ?? 0}`;
      if (lastKeyForNode.has(e.nodeId)) prevByKey.set(key, lastKeyForNode.get(e.nodeId));
      lastKeyForNode.set(e.nodeId, key);
    }
    return prevByKey;
  })(); // scheduleKey -> previous scheduleKey for the same node (undefined if it's the first slot)

  const saLastBattleState  = {}; // nodeId -> { captains, engagements, matchNo }
  const pvpLastNodeMatches = {}; // nodeId -> matchCard[] from last scan
  let saLastServerTime = null; // { localSeconds, localHour, localMinute } — updated from page fetches
  let saLastServerTzoff = null;

  const saHealedCaptainIds = new Set(); // captain ids we've already sent heal for this session
  const saGloballyEngagedCaptainIds = new Set(); // Fast Run: captains assigned this tick across all battles
  const saScheduledNukingMatch = new Map(); // nodeId -> matchNo currently being scheduled-nuked (ordinary mode)

  const PVE_LOCATION_BASE = 'https://demonicscans.org/guild_dungeon_location.php';
  const PVE_JOIN_URL      = 'https://demonicscans.org/dungeon_join_battle.php';
  const PVE_ATTACK_URL    = 'https://demonicscans.org/damage.php';
  const PVE_BATTLE_BASE   = 'https://demonicscans.org/battle.php';
  const PVE_INVENTORY_URL = 'https://demonicscans.org/inventory.php';
  const PVE_USE_ITEM_URL  = 'https://demonicscans.org/use_item.php';
  const PVE_HEAL_URL      = 'https://demonicscans.org/user_heal_potion.php';

  const PVE_TARGET_NODES = [2, 3, 10, 12]; // Gate Prism, Ash Lane, Crown Lens, Zenith Lock (Boss)
  const PVE_NODE_TO_LOCATION = {// Node IDs are table id > actual location id. e.g row id 2 in table > location id 11
    2: 11,
    3: 12,
    10: 13,
    12: 14,
  };
  const PVE_NODE_LABELS = { 2: 'Gate Prism', 3: 'Ash Lane', 10: 'Crown Lens', 12: 'Zenith Lock' };

  const PVE_MODE_NOTES = {
    exp:       'Stops at each mob\'s server EXP cap. No setup needed.',
    fixed:     'One damage cap for all mobs. ',
    monster:   'Per-mob caps below. 0 = skip that mob.',
    loot:      'Stops once you\'ve hit the DMG req for the rarest drop on each mob.',
    scheduled: 'Per-node, time-based caps — build breakpoints below per node (Normal mode only).',
  };

  const PVE_ATTACKS = [
    { id: 'slash',      stamina: 1,    skill: 0,  label: 'Slash' },
    { id: 'power',      stamina: 10,   skill: -1, label: 'Power Slash' },
    { id: 'heroic',     stamina: 50,   skill: -2, label: 'Heroic Slash' },
    { id: 'ultimate',   stamina: 100,  skill: -3, label: 'Ultimate Slash' },
    { id: 'legendary',  stamina: 200,  skill: -4, label: 'Legendary Slash' },
    { id: 'worldbreak', stamina: 1000, skill: -5, label: 'World Breaker Slash' },
  ];

  const PVE_STARTING_ATTACK_ID = 'power'; // hardcoded bootstrap attack — no longer user-configurable

  const PVE_BOOTSTRAP_CONCURRENCY = 5; // parallel battle.php lookups, only for never-seen mobs
  const PVE_PROFILE_KEY = 'autocube_pve_profiles_v1';        // Normal vs Fast Run settings
  const PVE_MOB_STATE_KEY_PREFIX = 'autocube_pve_mobstate_'; // + instanceId — per-mob damage tracking

  const PVP_FAST_RUN_KEY    = 'autocube_fast_run_v2';   // fast-run node/match targets
  const SA_PARTICIPATED_KEY = 'sa_participated_v1';     // {nodeId:matchNo} dedup set per instance
  const MASTER_ENABLED_KEY  = 'ds_suite_master_enabled_v1';
  const SHARED_MODE_KEY     = 'ds_suite_mode_v1';       // 'normal' | 'fast'
  const POS_KEY             = 'ds_suite_pos_v1';
  const COLLAPSED_KEY       = 'ds_suite_collapsed_v1';
  const PVE_ATTACK_DMG_KEY_PREFIX = 'autocube_pve_attackdmg_';
  const PVP_ACTIVE_MATCHES_KEY = 'autocube_pvp_active_matches_v1';
  const LOG_SESSION_KEY = 'ds_suite_log_session_v1';

  let uiBox             = null;
  let currentInstanceId = null;
  let pvpBusy           = false;
  let saBusy            = false;
  let saFirstTickDone   = false;
  let dsAutoModeResetDone = false; // guards the auto Fast Run -> Normal reset, once per instance
  let saAllClearedForNow = false;
  const saNodeStats = {}; // nodeId -> { total, activeFightNo, allCleared, hasAvailable }
  const pveDeadMobsByNode  = {}; // nodeId -> Set<dgmid>    , live per-scan, not persisted
  const pveDeadNamesByNode = {}; // nodeId -> Set<normalizedName>
  const pvpNodeStats     = {};
  let cubeStateCache = { data: null, forInstance: '', at: 0 };

  let logStickToBottom = true;

  let pveBusy           = false;
  let pveStaminaWaiting = false;
  const pveLockedNodesLogged    = new Set();
  const pveNodeStats            = {}; // nodeId -> { locked, allClear, mobCount }
  const pveDiscoveredMobsByNode = {}; // nodeId -> Map<normalizedName, displayName>, for the mob-picker UI
  const pveSessionVerified = new Set();

  let pveMobStateInstanceId = null;
  let pveMobState           = new Map(); // dgmid -> { damage, expCap, name, nodeId }
  let pveMobStateSaveTimer  = 0;

  let runLoopTimer            = 0;
  let runLoopInFlight         = false;
  let runLoopRestartRequested = false;
  let activeTab         = 'pvp';   // 'pvp' | 'sa' | 'log'
  let activeLogFilter   = 'all';   // 'all' | 'pvp' | 'sa'

  let pvpLiveJoinCount = 0;
  let pvpHasScanned    = false;
  const pvpLockedNodesLogged   = new Set();
  const saLockedNodesLogged    = new Set();
  const pvpCooldownByNode  = {};
  let pvpCountdownInterval = 0;     // shared 1s ticker; runs while ANY node has an active cooldown

  const pvpStartedMatchKeys = new Set();
  let pvpSourceParams = {};

  const pvpActiveBattleLoops = new Set();

  const PVE_KNOWN_MOBS = {
    2:  ['Mireglass Stalker', 'Prismblade Reaver', 'Siege-Root Howler'],
    3:  ['Bastion Iterant', 'Calibration Warden', 'Null Choir Adept', 'Polyhedral Devourer'],
    10: ["Creator's Chosen Executor", 'Crown Resonator', 'Warform of the Creator', 'Zenith Lancer'],
    12: ['The Polyhedral Apex'],
  };

  const FETCH_RETRY_ATTEMPTS   = 3;
  const FETCH_RETRY_BASE_DELAY = 300;

  const PVE_DMG_HISTORY_MAX = 20;   // raw hits kept per (monster, attack) — bounds storage, lets stat growth phase old hits out
  const PVE_OUTLIER_LOW_MULT = 0.5;
  const PVE_OUTLIER_MULT    = 1.5;  // discard hits over 1.5x the median as crit/anomaly outliers
  const PVE_KEEP_FRACTION   = 0.6;  // of what's left, average only the bottom 60% — conservative on purpose

  const pveCollapsedNodes = new Set(PVE_TARGET_NODES);

  const TAB_NAME = 'cube-suite';
  let tabBlockerEl = null;
  let dsTabIsMain  = false;

  function dsSetBlockMsg(icon, title, note) {
    const el = uiBox?.querySelector('.ds-tab-block-msg');
    if (!el) return;
    el.querySelector('.ds-tbl-icon').textContent  = icon;
    el.querySelector('.ds-tbl-title').textContent = title;
    el.querySelector('.ds-tbl-note').innerHTML    = note;
  }
  function dsShowBlock(icon, title, note) {
    dsSetBlockMsg(icon, title, note);
    uiBox?.classList.add('ds-tab-blocked');
  }
  function dsHideBlock() {
    uiBox?.classList.remove('ds-tab-blocked');
  }

  function dsShowTabBlocker() {
    if (tabBlockerEl) return;
    dsShowBlock('🚫', 'Already running in another tab',
                'Close that tab <br>and this panel will resume automatically. OR just use the other tab');
    tabBlockerEl = uiBox;
  }
  function dsHideTabBlocker() {
    if (!tabBlockerEl) return;
    dsHideBlock();
    tabBlockerEl = null;
  }

  function dsExtractGuildName(doc) {
    const h1 = doc.querySelector('h1.title');
    if (!h1) return '';
    const result = h1.textContent.split('—').pop().trim();
    return result;
  }

  let dsGuildCheckTransient = false;
  async function dsVerifyGuild(gen = dsMainGeneration) {
    dsGuildCheckTransient = false;
    dsShowBlock('⏳', 'Verifying guild membership…', `Checking ${GUILD_NAME}`);
    const { ok, text } = await fetchText(GUILD_MEMBERS_URL);
    // FIX: demoted while the request was in flight - the "other tab" overlay must stay, so touch nothing
    if (gen !== dsMainGeneration) return false;
    if (!ok || !text) {
      dsGuildCheckTransient = true;
      dsShowBlock('⚠️', 'Could not reach guild page', 'Retrying automatically…');
      return false;
    }
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const actualName = dsExtractGuildName(doc);
    if (!actualName) {
      dsGuildCheckTransient = true;
      dsShowBlock('⚠️', 'Could not read guild info', 'Retrying automatically…');
      return false;
    }
    if (actualName !== GUILD_NAME) {
      dsShowBlock('🚫', 'Members only', `You must be a member of<br>${GUILD_NAME} to use this script.`);
      return false;
    }
    dsHideBlock();
    return true;
  }

  let dsWakeCancels = [], dsWakeKey = '';
  function dsDisarmScheduleWakeups() { dsWakeCancels.forEach(c => c()); dsWakeCancels = []; dsWakeKey = ''; }
  function dsArmScheduleWakeups() {
    const secs = new Set([...SA_SCHEDULE, ...PVP_SCHEDULE].map(dsScheduleEntrySeconds));
    // FIX (b): PvE scheduled-cap breakpoints (active profile) wake the loop too, not just SA/PvP ones
    try {
      for (const list of Object.values(pveGetProfile().nodeSchedules || {}))
        for (const e of list || []) if (!e.noTime && Number.isFinite(dsScheduleEntrySeconds(e))) secs.add(dsScheduleEntrySeconds(e));
    } catch (_) { /* bad profile json: SA/PvP wake-ups still work */ }
    const key = [...secs].sort((a, b) => a - b).join(',');
    if (key === dsWakeKey) return;   // nothing changed (called every tick so schedule edits / mode switches re-arm)
    dsDisarmScheduleWakeups();
    dsWakeKey = key;
    for (const sec of secs) {
      const hh = String(Math.floor(sec / 3600)).padStart(2, '0');
      const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
      dsWakeCancels.push(Core.clock.at(null, `${hh}:${mm}`, () => {
        addLog('sys', 'info', `Server clock reached ${hh}:${mm} - checking schedules now`);
        dsRestartLoop();
      }, { grace: 120_000 }));
    }
  }

  let dsMainGeneration = 0;   // bumps on every promotion / demotion so a stale guild-check loop can tell it was superseded
  function dsOnMainTab() {
    dsTabIsMain = true;
    const gen = ++dsMainGeneration;
    dsHideTabBlocker();
    masterEnabled            = dsLoadMasterEnabled();
    pvpTyrantEnabled         = pvpLoadTyrantEnabled();
    saScheduledNukeEnabled   = saLoadScheduledNukeEnabled();
    refreshUI();
    (async () => {
      let ok = await dsVerifyGuild(gen);
      for (let attempt = 0; !ok && dsGuildCheckTransient && dsTabIsMain && gen === dsMainGeneration; attempt++) {
        await sleep(Math.min(60_000, 5_000 * 2 ** attempt));   // 5s, 10s, 20s, 40s, 60s...
        if (!dsTabIsMain || gen !== dsMainGeneration) return;
        ok = await dsVerifyGuild(gen);
      }
      if (!ok || !dsTabIsMain || gen !== dsMainGeneration) return;
      dsArmScheduleWakeups();
      void runLoop();
    })();
  }

  function dsOnIdleTab() {
    dsTabIsMain = false;
    dsMainGeneration++;
    dsDisarmScheduleWakeups();
    if (runLoopTimer) { clearTimeout(runLoopTimer); runLoopTimer = 0; }
    dsShowTabBlocker();
  }

  function dsInitTabSync() {
    mountUI(); // always mount so the panel works regardless of blocked state
    Core.tab.join(TAB_NAME, { queue: true, keepAlive: true, onMain: dsOnMainTab, onIdle: dsOnIdleTab });
  }

  async function withRetry(fn, attempts = FETCH_RETRY_ATTEMPTS, baseDelay = FETCH_RETRY_BASE_DELAY) {
    let last;
    for (let i = 0; i < attempts; i++) {
      last = await fn();
      if (!last.shouldRetry) return last;
      if (i < attempts - 1) {
        pvpLog(`Blank/error page — retrying (${i + 1}/${attempts - 1})`);
        await sleep(baseDelay * (i + 1) + Math.floor(Math.random() * 100));
      }
    }
    return last;
  }

  const PVE_DISCOVERED_KEY = 'autocube_pve_discovered_v1'; // nodeId -> [normalizedName,...]

  function pveLoadDiscovered() {
    try { return JSON.parse(localStorage.getItem(PVE_DISCOVERED_KEY)) || {}; }
    catch { return {}; }
  }
  function pveSaveDiscovered(map) { dsSafeSetItem(PVE_DISCOVERED_KEY, JSON.stringify(map)); }

  function dsLoadMasterEnabled() {
    const raw = localStorage.getItem(MASTER_ENABLED_KEY);
    return raw === null ? true : raw === '1';
  }
  function dsSaveMasterEnabled(v) { dsSafeSetItem(MASTER_ENABLED_KEY, v ? '1' : '0'); }
  function dsLoadCollapsed()      { return localStorage.getItem(COLLAPSED_KEY) === '1'; }
  function dsSaveCollapsed(v)     { dsSafeSetItem(COLLAPSED_KEY, v ? '1' : '0'); }
  function dsLoadPos() {
    try { return JSON.parse(localStorage.getItem(POS_KEY)); } catch { return null; }
  }
  function dsSavePos(pos) { dsSafeSetItem(POS_KEY, JSON.stringify(pos)); }

  function dsLoadMode()  { return localStorage.getItem(SHARED_MODE_KEY) === 'fast' ? 'fast' : 'normal'; }
  function dsSaveMode(m) { dsSafeSetItem(SHARED_MODE_KEY, m === 'fast' ? 'fast' : 'normal'); }
  function dsIsFastMode(){ return dsLoadMode() === 'fast'; }

  function pvpLoadTyrantEnabled()  { return localStorage.getItem(PVP_TYRANT_ENABLED_KEY) === '1'; }
  function pvpSaveTyrantEnabled(v) { dsSafeSetItem(PVP_TYRANT_ENABLED_KEY, v ? '1' : '0'); }

  function saLoadScheduledNukeEnabled() {
    const raw = localStorage.getItem(SA_SCHED_NUKE_KEY);
    return raw === null ? true : raw === '1'; // default on
  }
  function saSaveScheduledNukeEnabled(v) { dsSafeSetItem(SA_SCHED_NUKE_KEY, v ? '1' : '0'); }

  function saLoadSchedHandled(instanceId) {
    try {
      const raw = localStorage.getItem(SA_SCHED_HANDLED_KEY);
      if (!raw) return { instanceId: String(instanceId), keys: [] };
      const obj = JSON.parse(raw);
      if (obj.instanceId !== String(instanceId)) return { instanceId: String(instanceId), keys: [] };
      return { instanceId: String(instanceId), keys: Array.isArray(obj.keys) ? obj.keys : [] };
    } catch { return { instanceId: String(instanceId), keys: [] }; }
  }
  function saMarkSchedHandled(instanceId, key) {
    const data = saLoadSchedHandled(instanceId);
    if (!data.keys.includes(key)) {
      data.keys.push(key);
      dsSafeSetItem(SA_SCHED_HANDLED_KEY, JSON.stringify(data));
    }
  }

  let masterEnabled    = dsLoadMasterEnabled();
  let collapsed        = dsLoadCollapsed();
  let pvpTyrantEnabled = pvpLoadTyrantEnabled();
  let saScheduledNukeEnabled = saLoadScheduledNukeEnabled();

  const MAX_LOG = 300;
  function dsLoadLogFromSession() {
    try {
      const raw = sessionStorage.getItem(LOG_SESSION_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.slice(-MAX_LOG) : [];
    } catch { return []; }
  }
  const logLines = dsLoadLogFromSession();

  function dsEscapeHtml(msg) {
    return String(msg).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  const DS_SRC_COLORS = { pvp: '#7eb8f0', sa: '#c49afa', pve: '#8fd19e', sys: '#71727d' };
  const DS_LVL_COLORS = { warn: '#f0b429', error: '#ff6b6b', info: '' };

  function dsBuildLogLineHtml({ time, source, level, msg }) {
    const tag     = level === 'error' ? 'ERR' : level.toUpperCase();
    const escaped = dsEscapeHtml(msg);
    const color   = DS_SRC_COLORS[source] || '#8b8d98';
    const lvlColor = DS_LVL_COLORS[level] || '';
    return `<div class="ds-log-line" data-source="${source}" data-level="${level}" style="display:flex;gap:6px;align-items:baseline;padding:2px 0;border-bottom:1px solid #1a1b20;">` +
      `<span class="ds-log-time" style="flex-shrink:0;font-size:9.5px;">${time}</span>` +
      `<span style="flex-shrink:0;font-size:9px;font-weight:700;padding:1px 5px;border-radius:4px;background:${color}22;color:${color};border:1px solid ${color}44;">${source.toUpperCase()}</span>` +
      `${level !== 'info' ? `<span style="flex-shrink:0;font-size:9px;font-weight:700;color:${lvlColor};">${tag}</span>` : ''}` +
      `<span style="flex:1;${lvlColor ? `color:${lvlColor}` : ''}">${escaped}</span></div>`;
  }

  let logSaveTimer = 0;
  function scheduleLogSave() {
    if (logSaveTimer) return;
    logSaveTimer = setTimeout(() => {
      logSaveTimer = 0;
      try { sessionStorage.setItem(LOG_SESSION_KEY, JSON.stringify(logLines)); } catch {}
    }, 500);
  }

  function appendLogLineToDom(entry) {
    if (!uiBox || !uiBox.isConnected) return;
    if (activeLogFilter !== 'all' && entry.source !== activeLogFilter) return;
    const el = uiBox.querySelector('#ds-log');
    if (!el) return;
    const empty = el.querySelector('.ds-log-empty');
    if (empty) empty.remove();
    el.insertAdjacentHTML('beforeend', dsBuildLogLineHtml(entry));
    while (el.childElementCount > MAX_LOG) el.removeChild(el.firstChild);
    if (logStickToBottom) el.scrollTop = el.scrollHeight;
  }

  function addLog(source, level, msg) {
    const time = new Date().toLocaleTimeString();
    const entry = { time, source, level, msg: String(msg) };
    logLines.push(entry);
    if (logLines.length > MAX_LOG) logLines.shift();
    scheduleLogSave();
    appendLogLineToDom(entry);
  }

  const pvpInfo = msg => { console.log('[PvP]',   msg); addLog('pvp', 'info',  msg); };
  const pvpWarn = msg => { console.warn('[PvP]',  msg); addLog('pvp', 'warn',  msg); };
  const pvpLog  = msg => { PVP_DEBUG && console.log('[PvP]', msg); };

  const saInfo  = msg => { console.info('[SA]',   msg); addLog('sa',  'info',  msg); };
  const saWarn  = msg => { console.warn('[SA]',   msg); addLog('sa',  'warn',  msg); };
  const saErr   = msg => { console.error('[SA]',  msg); addLog('sa',  'error', msg); };

  const pveInfo = msg => { console.info('[PvE]', msg); addLog('pve', 'info', msg); };
  const pveWarn = msg => { console.warn('[PvE]', msg); addLog('pve', 'warn', msg); };

  const sleep    = ms => new Promise(r => setTimeout(r, ms));
  const normText = v  => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const playerKey = v => normText(v);

  async function fetchText(url, options = {}) {
    const { idempotent = false, ...fetchOpts } = options;
    const isRead  = String(fetchOpts.method || 'GET').toUpperCase() === 'GET';
    const attempts = (isRead || idempotent) ? FETCH_RETRY_ATTEMPTS : 1;
    const result = await withRetry(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const res  = await fetch(url, {
          credentials: 'same-origin',
          cache: 'no-store',
          ...fetchOpts,
          signal: controller.signal,
        });
        const text  = await res.text();
        // FIX: no blank/short-page heuristic - only the HTTP status decides (5xx is retried for GET / idempotent calls)
        return { res, text, ok: res.ok, status: res.status, shouldRetry: res.status >= 500 };
      } catch (err) {
        return { res: null, text: '', ok: false, status: 0, error: String(err?.message || err), shouldRetry: true };
      } finally {
        clearTimeout(timeout);
      }
    }, attempts);
    const { shouldRetry, ...clean } = result;
    if (!clean.ok) {
      const short = url.replace(location.origin, '');
      addLog('sys', 'warn',
             `Fetch failed after retries: ${short}` +
             `${clean.status ? ` (status ${clean.status})` : ''}` +
             `${clean.error ? ` — ${clean.error}` : ''}`
            );
    }
    return clean;
  }

  async function fetchDoc(url, label = '') {
    pvpLog(`fetchDoc (${label}): ${url}`);
    const { ok, text } = await fetchText(url);
    if (!ok || !text) return null;
    return new DOMParser().parseFromString(text, 'text/html');
  }

  async function fetchJson(url, options = {}) {
    const result = await fetchText(url, options);
    let data = null;
    try { data = JSON.parse(result.text); } catch {}
    return { ...result, data };
  }

  function saParseServerTime(html) {
    const epochM = html.match(/data-epoch="(\d+)"/);
    const tzoffM = html.match(/data-tzoff="(-?\d+)"/);
    if (!epochM) return null;
    const epoch  = Number(epochM[1]);
    const tzoff  = tzoffM ? Number(tzoffM[1]) : 0;
    const localS = (epoch + tzoff) % 86400;
    return {
      tzoff,
      localSeconds: localS,
      localHour:    Math.floor(localS / 3600),
      localMinute:  Math.floor((localS % 3600) / 60),
    };
  }

  function dsScheduleEntrySeconds(entry) {
    return (entry.hour * 3600) + ((entry.minute ?? 0) * 60);
  }

  function dsGetActiveScheduleEntry(schedule, now, fallback = null) {
    if (now == null || !schedule?.length) return fallback;
    let active = fallback;
    let activeSec = -1;
    for (const entry of schedule) {
      const sec = dsScheduleEntrySeconds(entry);
      if (now >= sec && sec >= activeSec) { active = entry; activeSec = sec; }
    }
    return active;
  }

  function saGetDueScheduledItems(localSeconds, instanceId) {
    if (localSeconds == null) return [];
    const handled = new Set(saLoadSchedHandled(instanceId).keys);

    return SA_SCHEDULE
      .map(e => ({
      ...e,
      mode: e.mode === 'ordinary' ? 'ordinary' : 'fastrun', // data-driven, defaults preserve old nuke-everything behavior
      key: `${e.nodeId}:h${e.hour}:m${e.minute ?? 0}`,
    }))
      .filter(e => !handled.has(e.key))
      .filter(e => localSeconds >= dsScheduleEntrySeconds(e))
      .filter(e => {
      const prevKey = SA_SCHED_PREV_KEY.get(e.key);
      return prevKey == null || handled.has(prevKey);
    });
  }

  function saMarkNukeStopped(nodeId) {  //fix stale state
    if (saScheduledNukingMatch.delete(nodeId) && saNodeStats[nodeId]) {
      saNodeStats[nodeId] = { ...saNodeStats[nodeId], schedNukeActive: false };
      refreshUI();
    }
  }

  async function saRunScheduledNuke(instanceId, nodeId, matchNo, playerName, playerId, participatedKeys, mode = 'fastrun') {
    const label = mode === 'ordinary' ? 'Scheduled hit' : 'Scheduled nuke';
    saInfo(`${label}: node ${nodeId} match #${matchNo} — scanning…`);
    const nodeUrl = new URL(SA_NODE_URL_BASE, location.origin);
    nodeUrl.searchParams.set('source',      SA_SOURCE);
    nodeUrl.searchParams.set('instance_id', instanceId);
    nodeUrl.searchParams.set('node_id',     String(nodeId));
    const { ok, text } = await fetchText(nodeUrl.href);
    if (!ok) { saMarkNukeStopped(nodeId); return 'error'; }
    const t = saParseServerTime(text);
    if (t) saSetServerTime(t);
    const { activeFightNo, fights } = saParseNodePage(text);

    const keys = participatedKeys || new Set(saLoadParticipated(instanceId).keys);
    const alreadyNukingThis = saScheduledNukingMatch.get(nodeId) === matchNo;
    saNodeStats[nodeId] = {
      ...(saNodeStats[nodeId] || {}),
      total: fights.length,
      activeFightNo: alreadyNukingThis ? matchNo : activeFightNo,
      allCleared:   fights.length > 0 && fights.every(f => f.status === 'cleared'),
      hasAvailable: fights.some(f => f.liveBtn && f.status !== 'cleared' && !keys.has(`${nodeId}:${f.matchNo}`)),
      schedNukeActive: alreadyNukingThis,
    };
    refreshUI();

    if (!fights.length) {
      saInfo(`${label}: node ${nodeId} — no fights on page`);
      saMarkNukeStopped(nodeId);
      return 'no_fights';
    }

    const target = fights.find(f => f.matchNo === matchNo) || null;
    if (!target) {
      saInfo(`${label}: node ${nodeId} match #${matchNo} — not found yet`);
      saMarkNukeStopped(nodeId);
      return 'not_live';
    }
    if (target.status === 'cleared') {
      saInfo(`${label}: node ${nodeId} match #${matchNo} — already cleared`);
      saMarkNukeStopped(nodeId);
      delete saLastBattleState[nodeId];
      return 'already_cleared';
    }
    if (!target.liveBtn) {
      saInfo(`${label}: node ${nodeId} match #${matchNo} — not live yet`);
      saMarkNukeStopped(nodeId);
      return 'not_live';
    }

    let battleId = null;
    if (target.battleId > 0) {
      const bs = await saJoinBattle(String(target.battleId)).catch(() => null);
      if (bs) battleId = String(target.battleId);
    }
    if (!battleId) {
      saInfo(`${label}: node ${nodeId} match #${matchNo} — no resolvable battle — entering…`);
      battleId = await saEnterFight(instanceId, nodeId, target.matchNo);
      if (!battleId) {
        saWarn(`${label}: node ${nodeId} match #${matchNo} — could not get battle_id`);
        saMarkNukeStopped(nodeId);
        return 'error';
      }
    } else {
      saInfo(`${label}: node ${nodeId} match #${matchNo} — battle ${battleId} found — checking for idle captains…`);
    }

    await saHealDeadCaptains(`pre-attempt, node ${nodeId} match #${matchNo}`);
    await sleep(SA_JOIN_DELAY_MS); // let the heal register server-side before we check idle captains

    saNodeStats[nodeId] = { ...(saNodeStats[nodeId] || {}), activeFightNo: target.matchNo };
    saScheduledNukingMatch.set(nodeId, target.matchNo);
    refreshUI();

    let result = 'error';
    try {
      result = mode === 'ordinary'
        ? await saExecuteOrdinary(battleId, instanceId, nodeId, matchNo, playerName, playerId, false)
      : await saExecuteFastRun(battleId, instanceId, nodeId, matchNo, playerName, playerId);
    } catch (e) {
      saWarn(`${label}: node ${nodeId} match #${matchNo} — combat step threw: ${e.message}`);
    }

    let finalResult = result;
    {
      const landedHit = result === 'fought' || result === 'already_fought';
      if (landedHit) {
        keys.add(`${nodeId}:${target.matchNo}`);
        saMarkParticipated(instanceId, nodeId, target.matchNo);
      }
      if (result === 'captain_dead') { await saHealDeadCaptains(`node ${nodeId}: captain KO'd`); }

      let freshFights = fights;
      if (landedHit) {
        const refetch = await fetchText(nodeUrl.href).catch(() => null);
        if (refetch?.ok) freshFights = saParseNodePage(refetch.text).fights;
      }

      const targetFreshStatus = freshFights.find(f => f.matchNo === target.matchNo)?.status;
      const targetNowCleared  = targetFreshStatus === 'cleared';
      const updAfter    = freshFights.some(f => f.liveBtn && f.status !== 'cleared' && !keys.has(`${nodeId}:${f.matchNo}`));
      const freshAllClr = freshFights.length > 0 && freshFights.every(f => f.status === 'cleared');

      const stillNuking = mode === 'fastrun'
      && !['already_cleared', 'finished', 'captain_dead', 'error'].includes(result)
      && !targetNowCleared;

      saNodeStats[nodeId] = {
        ...(saNodeStats[nodeId] || {}),
        total: freshFights.length,
        activeFightNo: stillNuking ? target.matchNo : 0,
        hasAvailable: updAfter,
        allCleared: freshAllClr,
        justFought: landedHit,
        lastFightNo: target.matchNo,
        schedNukeActive: stillNuking,
      };

      if (stillNuking) {
        saScheduledNukingMatch.set(nodeId, target.matchNo);
      } else {
        saMarkNukeStopped(nodeId);
        delete saLastBattleState[nodeId];
        if (mode === 'fastrun') {
          if (result === 'fought' && targetNowCleared) finalResult = 'finished';
        } else if (['fought', 'already_fought', 'retreat_pending', 'captain_dead'].includes(result)) {
          finalResult = 'finished';
        }
      }

      refreshUI();
      saInfo(`${label}: node ${nodeId} match #${matchNo} — ${result}${landedHit ? ' ✓' : ''}${targetNowCleared && landedHit ? ' (match cleared)' : ''}`);
    }
    return finalResult;
  }

  let playerInfoCache = null;
  let pvpSelfId = '';

  async function getPlayerInfo() {
    const r = await getPlayerInfoRaw();
    if (r && r.id) pvpSelfId = String(r.id);
    return r;
  }

  async function getPlayerInfoRaw() {
    if (playerInfoCache) return playerInfoCache;
    const who = Core.player.info();
    const sideName = String(who.name || '').replace(/\s+/g, ' ').trim();
    if (sideName && who.id) return (playerInfoCache = { name: sideName, id: String(who.id) });
    const { ok, text: dashText } = await fetchText(DASH_URL);
    if (!ok || !dashText) return { name: '', id: '' };
    const _dst = saParseServerTime(dashText);
    if (_dst) saSetServerTime(_dst);
    const doc = new DOMParser().parseFromString(dashText, 'text/html');
    let name = '';
    for (const sel of ['.small-user .small-name', '.small-name',
                       'a[href^="player.php?pid="] .small-name']) {
      const el  = doc.querySelector(sel);
      const raw = (el?.textContent || '').replace(/\s+/g, ' ').trim();
      if (raw) { name = raw; break; }
    }
    let id = '';
    const pidLink = doc.querySelector('a[href^="player.php?pid="]');
    if (pidLink) {
      const m = (pidLink.getAttribute('href') || '').match(/[?&]pid=(\d+)/i);
      if (m) id = m[1];
    }
    if (!id) {
      const m2 = (doc.body?.innerHTML || '').match(/player\.php\?pid=(\d+)/i);
      if (m2) id = m2[1];
    }
    const result = { name, id };
    if (name || id) playerInfoCache = result; // never cache a failed/empty read
    return result;
  }

  function extractCubeInstanceId(html) {
    const doc     = new DOMParser().parseFromString(html, 'text/html');
    const section = [...doc.querySelectorAll('.section-title')].find(el =>
                                                                     normText(el.textContent).includes('active dungeon templates'));
    if (!section) return null;
    let grid = section.nextElementSibling;
    while (grid && !grid.classList.contains('grid')) grid = grid.nextElementSibling;
    if (!grid) return null;
    const cubeCard = [...grid.querySelectorAll('.card')].find(card => {
      const title  = normText(card.querySelector('.h')?.textContent);
      const banner = normText(card.querySelector('img.banner')?.getAttribute('src') || '');
      const body   = normText(card.textContent);
      return title.includes('polyhedral crucible')
      || banner.includes('the_cube.webp')
      || body.includes('cube layout');
    });
    if (!cubeCard) return null;
    const link = [...cubeCard.querySelectorAll('a[href]')].find(a =>
                                                                (a.getAttribute('href') || '').includes('guild_dungeon_enter.php?id='));
    if (!link) return null;
    return new URL(link.getAttribute('href'), location.origin).searchParams.get('id');
  }

  async function getActiveCubeInstanceId() {
    const urlId = new URLSearchParams(location.search).get('instance_id');
    if (urlId) return urlId;
    const res = await fetch(DUNGEONS_URL, { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) return null;
    return extractCubeInstanceId(await res.text());
  }

  function pvpDefaultFastRunState() {
    return {
      isLeader    : false,
      node7MatchNo: 0,
      node8MatchNo: 0,
      node7Results: {},   // matchNo (string) -> { joined, cleared }
      node8Results: {},   // same shape for node 8
      lastInstanceId: '',
      seenInstanceIds: [],
    };
  }

  function pvpGetMatchResult(state, nodeId, matchNo) {
    if (nodeId !== 7 && nodeId !== 8) return { joined: false, cleared: false };
    const map = nodeId === 7 ? state.node7Results : state.node8Results;
    return (map && map[String(matchNo)]) || { joined: false, cleared: false };
  }

  function pvpSetMatchResult(state, nodeId, matchNo, patch) {
    if (nodeId !== 7 && nodeId !== 8) return;
    const key = String(matchNo);
    if (nodeId === 7) state.node7Results = { ...(state.node7Results || {}), [key]: { ...(state.node7Results?.[key] || {}), ...patch } };
    else              state.node8Results = { ...(state.node8Results || {}), [key]: { ...(state.node8Results?.[key] || {}), ...patch } };
  }

  function pvpMarkNodeDone(nodeId, matchNo, cleared = false) {
    const s = pvpLoadFastRunState();
    pvpSetMatchResult(s, nodeId, matchNo, { joined: true, ...(cleared ? { cleared: true } : {}) });
    pvpSaveFastRunState(s);
    refreshUI();
  }

  function pvpLoadFastRunState() {
    try {
      const raw = localStorage.getItem(PVP_FAST_RUN_KEY);
      return raw ? { ...pvpDefaultFastRunState(), ...JSON.parse(raw) } : pvpDefaultFastRunState();
    } catch { return pvpDefaultFastRunState(); }
  }

  function pvpSaveFastRunState(state) {
    dsSafeSetItem(PVP_FAST_RUN_KEY, JSON.stringify(state));
  }

  function pvpLoadActiveMatches(instanceId) {
    try {
      const raw = localStorage.getItem(PVP_ACTIVE_MATCHES_KEY);
      if (!raw) return [];
      const obj = JSON.parse(raw);
      if (obj.instanceId !== String(instanceId)) return [];
      return Array.isArray(obj.matches) ? obj.matches : [];
    } catch { return []; }
  }

  function pvpSaveActiveMatch(instanceId, nodeId, matchNo) {
    const matches = pvpLoadActiveMatches(instanceId);
    const key = `${nodeId}:${matchNo}`;
    if (!matches.some(m => `${m.nodeId}:${m.matchNo}` === key)) {
      matches.push({ nodeId: Number(nodeId), matchNo: Number(matchNo) });
      dsSafeSetItem(PVP_ACTIVE_MATCHES_KEY,
                    JSON.stringify({ instanceId: String(instanceId), matches }));
    }
  }

  function pvpClearActiveMatch(instanceId, nodeId, matchNo) {
    const matches = pvpLoadActiveMatches(instanceId).filter(
      m => !(Number(m.nodeId) === Number(nodeId) && Number(m.matchNo) === Number(matchNo))
    );
    dsSafeSetItem(PVP_ACTIVE_MATCHES_KEY,
                  JSON.stringify({ instanceId: String(instanceId), matches }));
  }

  function pvpUpdateSourceParams(params = {}) {
    pvpSourceParams = {};
    for (const [k, v] of Object.entries(params))
      if (v != null && String(v) !== '') pvpSourceParams[k] = String(v);
  }

  function pvpSyncSourceParamsFromLocation() {
    const p = new URLSearchParams(location.search);
    pvpUpdateSourceParams({
      instance_id : p.get('instance_id'),
      node_id     : p.get('node_id'),
      match_no    : p.get('match_no'),
    });
  }

  function parseCubeStateFromHtml(html) {
    const marker = 'const STATE = ';
    const idx    = html.indexOf(marker);
    if (idx === -1) return null;
    const start  = html.indexOf('{', idx + marker.length);
    if (start === -1) return null;
    let depth = 0, i = start, inStr = false, esc = false;
    for (; i < html.length; i++) {
      const c = html[i];
      if (esc)               { esc = false; continue; }
      if (c === '\\' && inStr) { esc = true;  continue; }
      if (c === '"')         { inStr = !inStr; continue; }
      if (inStr)             continue;
      if (c === '{')         depth++;
      if (c === '}' && --depth === 0) { i++; break; }
    }
    try { return JSON.parse(html.slice(start, i)); } catch { return null; }
  }

  async function getCubeState(instanceId) {
    const now = Date.now();
    const ttl = dsIsFastMode() ? 5_000 : PVP_SCAN_INTERVAL_MS;
    if (
      cubeStateCache.forInstance === String(instanceId) &&
      cubeStateCache.data &&
      now - cubeStateCache.at < ttl
    ) return cubeStateCache.data;

    const { ok, text } = await fetchText(`${CUBE_DUNGEON_BASE}?instance_id=${instanceId}`);
    if (!ok || !text) return (cubeStateCache.data && now - cubeStateCache.at < CUBE_STATE_MAX_STALE_MS) ? cubeStateCache.data : null;
    const _cst = saParseServerTime(text);
    if (_cst) saSetServerTime(_cst);
    const state = parseCubeStateFromHtml(text);
    if (state) cubeStateCache = { data: state, forInstance: String(instanceId), at: now };
    return state;
  }

  async function pvpGetAvailableNodes(instanceId) {
    const cubeState = await getCubeState(instanceId);

    if (!cubeState?.nodes?.length) {
      pvpWarn('Could not read cube STATE nodes; defaulting node 7');
      return new Set([7]);
    }
    const available = new Set();
    for (const node of cubeState.nodes) {
      if (node.type !== 'pvp')                          continue;  // not a PvP node
      if (!node.is_revealed)                            continue;  // not yet visible
      if (node.status === 'hidden' || node.status === 'locked') continue;
      available.add(Number(node.id));
    }

    if (!available.size) {
      pvpWarn(`No revealed PvP nodes in STATE (${cubeState.nodes.length} total); defaulting node 7`);
      available.add(7);
    }
    pvpLog(`Available PvP nodes: [${[...available].join(', ')}]`);
    return available;
  }

  function pvpExtractCooldownTimer(doc) {
    const liveTimerEl = doc.getElementById('liveTimer');
    const spanText = (liveTimerEl?.textContent || '').trim();
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(spanText)) return spanText;

    const bodyText = doc.body?.textContent || '';
    const m =
          bodyText.match(/committed to match #\d+ for about\s+([\d:]+)\s+more/i) ||
          bodyText.match(/locked to match #\d+ for about\s+([\d:]+)\s+more/i);
    return m ? m[1] : '';
  }

  function pvpSetCooldown(nodeId, timerStr) {
    const entry = pvpCooldownByNode[nodeId] || (pvpCooldownByNode[nodeId] = { active: false, timeStr: '', fetchedAt: 0, logged: false });
    entry.active = true;
    if (timerStr) { entry.timeStr = timerStr; entry.fetchedAt = Date.now(); }
    if (!entry.logged) {
      entry.logged = true;
      pvpInfo(`Node ${nodeId}: cooldown active${timerStr ? ` — ${timerStr} remaining` : ''}`);
    }
    pvpStartCountdownDisplay();
    refreshUI();
  }

  function pvpClearCooldown(nodeId) {
    const entry = pvpCooldownByNode[nodeId];
    if (!entry || (!entry.active && !entry.logged)) return; // nothing to clear
    entry.active  = false;
    entry.timeStr = '';
    if (entry.logged) {
      entry.logged = false;
      pvpInfo(`Node ${nodeId}: cooldown cleared — resuming`);
    }
    refreshUI();
  }

  function pvpWipeCooldown(nodeId) {
    delete pvpCooldownByNode[nodeId];
  }

  function pvpGetLiveCooldownStr(nodeId) {
    const entry = pvpCooldownByNode[nodeId];
    if (!entry || !entry.active || !entry.timeStr) return '';
    const elapsed = Math.floor((Date.now() - entry.fetchedAt) / 1000);
    const parts   = entry.timeStr.split(':').map(Number);
    let total;
    if (parts.length === 3)      total = parts[0] * 3600 + parts[1] * 60 + parts[2];
    else if (parts.length === 2) total = parts[0] * 60 + parts[1];
    else return entry.timeStr;
    const rem = Math.max(0, total - elapsed);
    if (rem === 0) { entry.active = false; return ''; }
    const h = Math.floor(rem / 3600);
    const m = Math.floor((rem % 3600) / 60);
    const s = rem % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
  }

  function pvpAnyCooldownActive() {
    return Object.values(pvpCooldownByNode).some(e => e && e.active);
  }

  function pvpStartCountdownDisplay() {
    if (pvpCountdownInterval) return;
    pvpCountdownInterval = setInterval(() => {
      if (!pvpAnyCooldownActive()) { clearInterval(pvpCountdownInterval); pvpCountdownInterval = 0; }
      refreshUI();
    }, 1_000);
  }

  function pvpLogNodeLockTransition(nodeId, isAvailable) {
    if (!isAvailable && !pvpLockedNodesLogged.has(nodeId)) {
      pvpLockedNodesLogged.add(nodeId);
      pvpInfo(`Node ${nodeId}: is still locked/unavailable`);
    } else if (isAvailable && pvpLockedNodesLogged.has(nodeId)) {
      pvpLockedNodesLogged.delete(nodeId);
      pvpInfo(`Node ${nodeId}: now available`);
    }
  }

  function saLogNodeLockTransition(nodeId, isAvailable) {
    if (!isAvailable && !saLockedNodesLogged.has(nodeId)) {
      saLockedNodesLogged.add(nodeId);
      saInfo(`Node ${nodeId}: is still locked/unavailable`);
    } else if (isAvailable && saLockedNodesLogged.has(nodeId)) {
      saLockedNodesLogged.delete(nodeId);
      saInfo(`Node ${nodeId}: now available`);
    }
  }

  function pvpReadSlotPlayerName(slot) {
    const du = (slot.dataset.username || '').trim();
    if (du && du.toLowerCase() !== 'open slot') return du;
    const nameEl = slot.querySelector('.name');
    if (!nameEl) return '';
    const t = normText(nameEl.textContent);
    if (!t || /^slot\s*\d+$/i.test(t) || /^(empty|open( slot)?|vacant|available)$/i.test(t)) return '';   // FIX: "Open Slot" placeholder
    return t;
  }

  function pvpSlotHasRealOccupant(slot) {
    if (pvpReadSlotPlayerName(slot)) return true;
    const userId = (slot.dataset.userId || '').trim();
    const key    = (slot.dataset.key    || '').trim();
    const hasImg = !!slot.querySelector('img');
    return (hasImg && (userId !== '' && userId !== '0' || key !== ''))
    || (userId !== '' && userId !== '0')
    || key !== '';
  }

  function pvpSlotIsSelf(el, currentPlayerKey = '') {
    if (el.querySelector('.selfMark')) return true;
    const uid = String(el.dataset.userId || '').trim();
    if (pvpSelfId && uid && uid !== '0' && uid === pvpSelfId) return true;
    if (pvpSelfId) {
      for (const img of el.querySelectorAll('img')) {
        if ((img.getAttribute('src') || '').includes(`user_${pvpSelfId}_`)) return true;
      }
    }
    const name = pvpReadSlotPlayerName(el);
    if (currentPlayerKey && name) {
      const a = playerKey(name);
      if (a === currentPlayerKey) return true;
      const strip = v => v.replace(/^\s*\[[^\]]*\]\s*/, '').trim();
      const sa = strip(a), sb = strip(currentPlayerKey);
      if (sa && sa === sb) return true;
    }
    return false;
  }

  function pvpSlotLooksOpen(slot) {
    if (pvpSlotHasRealOccupant(slot)) return false;
    if (slot.dataset.open === '1' || slot.classList.contains('joinable') ||
        slot.classList.contains('open') || slot.classList.contains('vacant') ||
        slot.classList.contains('available')) return true;
    const labels = [...slot.querySelectorAll('.empty')].map(el => normText(el.textContent));
    if (labels.some(t => t === 'empty' || /^slot\s*\d+$/i.test(t) ||
                    /^(open|vacant|available)$/i.test(t))) return true;
    const noName = !slot.querySelector('.name');
    if (noName && slot.querySelector('img')) {
      pvpWarn(`Slot has no occupant but contains <img> — counted as open (would previously have been excluded): ${slot.outerHTML.slice(0, 200)}`);
    }
    return noName;
  }

  function pvpExtractSlotNumber(el, fallback) {
    const fromAttr = parseInt(el.dataset.slot || el.getAttribute('data-slot') || '', 10);
    if (fromAttr > 0) return fromAttr;
    for (const em of el.querySelectorAll('.empty')) {
      const m = normText(em.textContent).match(/^slot\s*(\d+)$/i);
      if (m) return parseInt(m[1], 10);
    }
    return fallback;
  }

  function pvpFindJoinableSlots(doc, currentPlayerKey = '') {
    const selectors = ['#bottomTeamCard .pSlot', '.slots .pSlot', '.slots .slot', '.pSlot', '.slot'];
    const seen = new Set(), all = [];
    for (const sel of selectors)
      for (const el of doc.querySelectorAll(sel))
        if (!seen.has(el)) { seen.add(el); all.push(el); }
    const out = []; let fi = 0;
    for (const el of all) {
      if (el.dataset.side === 'enemy') continue;
      fi++;
      const slotNum    = pvpExtractSlotNumber(el, fi);
      const isSelf     = pvpSlotIsSelf(el, currentPlayerKey);   // FIX2: id / avatar / .selfMark / tag-insensitive name
      const open       = pvpSlotLooksOpen(el);
      if (!isSelf && open) { el.dataset._autocubeSlotNum = String(slotNum); out.push(el); }
    }
    return out;
  }

  function pvpIsPlayerInDoc(doc, currentPlayerKey) {
    if (!currentPlayerKey && !pvpSelfId) return false;
    const selectors = ['#bottomTeamCard .pSlot', '.slots .pSlot', '.slots .slot', '.pSlot', '.slot'];
    const seen = new Set();
    for (const sel of selectors)
      for (const el of doc.querySelectorAll(sel)) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (el.dataset.side === 'enemy') continue;
        if (pvpSlotIsSelf(el, currentPlayerKey)) return true;   // FIX2
      }
    return false;
  }

  const pvpHasCooldown = (doc = document) =>
  !!(doc.querySelector('.warn'));

  function pvpParseMatchCards(doc, currentPlayerKey = '', instanceId = null, nodeId = null) {
    return [...doc.querySelectorAll('.match')].map((card, idx) => {
      const title    = normText(card.querySelector('.matchTitle')?.textContent || '');
      const metaText = normText(card.querySelector('.meta')?.textContent || '');
      const matchNo  = parseInt(metaText.match(/match\s*#(\d+)/i)?.[1] || '', 10) || (idx + 1);
      const clearedBadge = !!card.querySelector('.badge.clear');
      const isInProgress = [...card.querySelectorAll('.badge.live')]
      .some(b => normText(b.textContent) === 'live');
      const isElite      = [...card.querySelectorAll('.badge')]
      .some(b => normText(b.textContent).includes('elite'));
      const slotEls      = [...card.querySelectorAll('.slots .slot, .slots .pSlot')];
      const totalSlots   = slotEls.length || 5;

      const href = (instanceId != null && nodeId != null)
      ? new URL(`pvp_style_battle.php?source=${PVP_SOURCE}&instance_id=${instanceId}&node_id=${nodeId}&match_no=${matchNo}`, location.origin).href
      : null;

      const openSlots   = slotEls.length > 0 ? slotEls.filter(pvpSlotLooksOpen).length
      : (href ? 1 : 0);
      const filledSlots = totalSlots - openSlots;
      const names = slotEls.map(pvpReadSlotPlayerName).filter(Boolean);
      const hasSelf = (!!currentPlayerKey || !!pvpSelfId) && slotEls.some(el => pvpSlotIsSelf(el, currentPlayerKey));   // FIX2
      return { card, idx, matchNo, title, isElite, names,
              clearedBadge, isInProgress, filledSlots, openSlots, totalSlots, href, hasSelf };
    });
  }

  function pvpScoreMatch(m) {
    if (m.clearedBadge || m.isInProgress || !m.href || m.hasSelf || m.openSlots <= 0)
      return -Infinity;
    let score = 1000 + m.filledSlots * 200;
    if (m.isElite)                      score += 50;
    if (m.title.includes('ring ward'))  score += 30;
    if (m.title.includes('duel heart')) score += 10;
    score -= (m.idx || 0) * 0.01;   // tiny tie-breaker: earlier card in list preferred
    return score;
  }

  function pvpPickBestMatch(matches) {
    const scored = matches.map(m => ({ ...m, score: pvpScoreMatch(m) })).filter(m => isFinite(m.score));
    if (!scored.length) return null;
    scored.sort((a, b) => b.score - a.score);
    return scored[0];
  }

  function pvpExtractCsrfToken(doc) {
    for (const sel of [
      'meta[name="csrf_token"]', 'meta[name="csrf"]', 'meta[name="csrf-token"]',
      'input[name="csrf"]', 'input[name="csrf_token"]', 'input[name="csrf-token"]',
    ]) {
      const el = doc?.querySelector(sel);
      const t  = el?.content || el?.value || '';
      if (t) return t;
    }
    return '';
  }

  async function pvpPostAction(body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS * 2);
    try {
      const res  = await fetch(PVP_ACTION_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        credentials: 'same-origin', body: body.toString(), signal: controller.signal,
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok)
        throw new Error(json?.error || json?.message || `Action failed (${res.status})`);
      return json;
    } catch (err) {
      if (err && err.name === 'AbortError') throw new Error('Action timed out');
      throw err;
    } finally { clearTimeout(timer); }
  }

  async function pvpTryJoinBattleHref(href, currentPlayerKey = '') {
    const u = new URL(href);
    const tInst = u.searchParams.get('instance_id'), tNode = u.searchParams.get('node_id'), tMatch = u.searchParams.get('match_no');
    pvpUpdateSourceParams({ instance_id: tInst, node_id: tNode, match_no: tMatch });
    const doc = await fetchDoc(href, 'battle page');
    if (!doc) { pvpWarn(`Battle page fetch failed for ${href}`); return { joined: false, alreadyIn: false }; }
    if (pvpIsPlayerInDoc(doc, currentPlayerKey)) {
      pvpInfo('Already occupying a slot in this match');
      return { joined: false, alreadyIn: true };
    }
    const slots = [...new Set(
      pvpFindJoinableSlots(doc, currentPlayerKey)
      .map(el => parseInt(el.dataset._autocubeSlotNum || '0', 10))
      .filter(n => n > 0)
    )].sort((a, b) => a - b);
    if (!slots.length) {
      pvpWarn(`No joinable slots found on battle page (${href}) despite node listing showing open slots`);
      return { joined: false, alreadyIn: false };
    }
    for (const slotNum of slots) {
      try {
        const fresh = await fetchDoc(href, `recheck slot ${slotNum}`);
        if (!fresh) { pvpWarn(`Recheck fetch failed for slot ${slotNum}`); continue; }
        if (pvpIsPlayerInDoc(fresh, currentPlayerKey))
          return { joined: false, alreadyIn: true };
        const stillOpen = pvpFindJoinableSlots(fresh, currentPlayerKey)
        .some(el => parseInt(el.dataset._autocubeSlotNum || '0', 10) === slotNum);
        if (!stillOpen) continue;
        await pvpRoomActionExplicit(tInst, tNode, tMatch, 'pick_slot', { slot_index: slotNum }, fresh);
        return { joined: true, alreadyIn: false };
      } catch (err) {
        const msg = String(err).toLowerCase();
        if (msg.includes('already assigned') || msg.includes('already committed')) {
          pvpInfo('Already assigned to a match on this node (server confirmed)');
          return { joined: false, alreadyIn: true };
        }
        pvpWarn(`pick_slot ${slotNum} failed: ${err}`);
        if (/timed out/i.test(String(err))) {
          const after = await fetchDoc(href, `verify after timeout (slot ${slotNum})`);
          if (after && pvpIsPlayerInDoc(after, currentPlayerKey)) return { joined: true, alreadyIn: false };
        }
      }
    }
    return { joined: false, alreadyIn: false };
  }

  async function pvpTryStartMatch(href) {
    const u = new URL(href);
    const tInst = u.searchParams.get('instance_id'), tNode = u.searchParams.get('node_id'), tMatch = u.searchParams.get('match_no');
    pvpUpdateSourceParams({ instance_id: tInst, node_id: tNode, match_no: tMatch });
    const doc = await fetchDoc(href, 'battle page (start)');
    if (!doc) return false;
    try { await pvpRoomActionExplicit(tInst, tNode, tMatch, 'start_trial', {}, doc); return true; }   // FIX2: explicit params
    catch (err) { pvpWarn(`start_trial failed: ${err}`); return false; }
  }

  async function pvpRoomActionExplicit(instanceId, nodeId, matchNo, action, extra = {}, tokenDoc = document) {
    const body = new URLSearchParams({
      source: PVP_SOURCE,
      action,
      instance_id: String(instanceId),
      node_id: String(nodeId),
      match_no: String(matchNo),
    });
    Object.entries(extra || {}).forEach(([k, v]) => body.set(k, String(v)));
    const token = pvpExtractCsrfToken(tokenDoc);
    if (token) { body.set('csrf', token); body.set('csrf_token', token); }
    return pvpPostAction(body);
  }

  async function pvpFetchBattleState(instanceId, nodeId, matchNo) {
    const url = new URL(PVP_STATE_URL, location.origin);
    url.searchParams.set('source', PVP_SOURCE);
    url.searchParams.set('instance_id', String(instanceId));
    url.searchParams.set('node_id', String(nodeId));
    url.searchParams.set('match_no', String(matchNo));
    const { ok, data } = await fetchJson(url.href);
    if (!ok || !data?.ok) return null;
    return data;
  }

  function pvpPickAliveEnemyKey(state) {
    const enemyMap = state?.teams?.enemy?.players_by_num || {};
    const nums = Object.keys(enemyMap).map(Number).filter(n => !Number.isNaN(n)).sort((a, b) => a - b);
    for (const n of nums) {
      const p = enemyMap[String(n)];
      if (p && p.key && p.alive) return p.key;
    }
    return '';
  }

  function pvpPickAttackSkills(skills) {
    const attackSkills = (skills || []).filter(s => s && s.target === 'enemy');
    const powerSlash = attackSkills.find(s => PVP_POWER_SLASH_RE.test(s.name || ''));
    const slash = attackSkills.find(
      s => (!powerSlash || s.id !== powerSlash.id)
      && !PVP_POWER_SLASH_RE.test(s.name || '')
      && PVP_SLASH_RE.test(s.name || '')
    );
    const fallback = slash ?? attackSkills
    .filter(s => !powerSlash || s.id !== powerSlash.id)
    .sort((a, b) => (Number(a.cost) || 0) - (Number(b.cost) || 0))[0] ?? null;
    return { powerSlash, fallback };
  }

  async function pvpExecuteFastTurn(instanceId, nodeId, matchNo, me, state) {
    const tokens = parseInt(me.tokens || 0, 10);
    const { powerSlash, fallback } = pvpPickAttackSkills(me.skills);
    const targetKey = pvpPickAliveEnemyKey(state);

    if (!targetKey) {
      pvpWarn(`Node ${nodeId} match #${matchNo}: no alive enemy to target this turn`);
      return;
    }

    let chosen = null;
    if (powerSlash && tokens >= (Number(powerSlash.cost) || 0)) {
      chosen = powerSlash;
    } else if (fallback && tokens >= (Number(fallback.cost) || 0)) {
      chosen = fallback;
    }

    if (!chosen) {
      pvpWarn(`Node ${nodeId} match #${matchNo}: nothing affordable this turn (tokens=${tokens})`);
      return;
    }

    const PVP_SKILL_RETRIES = 3;
    for (let attempt = 1; attempt <= PVP_SKILL_RETRIES; attempt++) {
      try {
        await pvpRoomActionExplicit(instanceId, nodeId, matchNo, 'use_skill', {
          skill_id: chosen.id,
          target_key: targetKey,
        });
        pvpInfo(`Node ${nodeId} match #${matchNo}: used ${chosen.name} (cost ${chosen.cost || 0}, had ${tokens}) on ${targetKey}`);
        return true;
      } catch (err) {
        const msg = String(err?.message || err);
        if (attempt < PVP_SKILL_RETRIES && /\b5\d{2}\b/.test(msg)) {
          pvpWarn(`Node ${nodeId} match #${matchNo}: use_skill ${chosen.name} — server error, retrying (${attempt}/${PVP_SKILL_RETRIES})…`);
          await sleep(500 * attempt);
        } else {
          pvpWarn(`Node ${nodeId} match #${matchNo}: use_skill (${chosen.name}) failed — ${msg}`);
          return false;   // FIX: caller may retry this turn (bounded)
        }
      }
    }
  }

  async function pvpRunFastBattleLoop(instanceId, nodeId, matchNo) {
    const loopKey = `${instanceId}:${nodeId}:${matchNo}`;
    if (pvpActiveBattleLoops.has(loopKey)) return;
    pvpActiveBattleLoops.add(loopKey);
    const wasFastModeAtStart = dsIsFastMode();
    pvpInfo(`Node ${nodeId} match #${matchNo}: active battle monitor started`);

    let wasMyTurn = false;
    let turnFails = 0;   // FIX: failed use_skill attempts in the current turn
    let consecutiveErrors = 0;

    try {
      const { id: playerId } = await getPlayerInfo();
      if (!playerId) {
        pvpWarn(`Node ${nodeId} match #${matchNo}: could not resolve own player id — aborting monitor`);
        return;
      }

      while (true) {
        // FIX (c): another tab took over - stop polling / acting (the new main tab restarts its own monitor)
        if (!dsTabIsMain) { pvpInfo(`Node ${nodeId} match #${matchNo}: this tab is no longer the main tab — stopping monitor`); return; }
        const state = await pvpFetchBattleState(instanceId, nodeId, matchNo);
        if (!state) {
          consecutiveErrors++;
          if (consecutiveErrors >= 5) {
            pvpWarn(`Node ${nodeId} match #${matchNo}: state fetch failing repeatedly — stopping monitor`);
            return;
          }
          await sleep(PVP_BATTLE_WAIT_POLL_MS);
          continue;
        }
        consecutiveErrors = 0;

        const ended     = !!(state.match && state.match.ended);
        const roomStatus = state.room_status || '';
        const me         = state.me   || {};
        const turn       = state.turn || {};

        if (ended) {
          const won = (state.match.winner_side || '') === 'ally';
          pvpInfo(`Node ${nodeId} match #${matchNo}: battle ended (${won ? 'won' : 'lost/draw'}) — stopping monitor`);
          pvpClearActiveMatch(instanceId, nodeId, matchNo);
          if (wasFastModeAtStart) pvpMarkNodeDone(nodeId, matchNo, true);
          if (pvpLastNodeMatches[nodeId]) {
            const mi = pvpLastNodeMatches[nodeId].findIndex(m => m.matchNo === matchNo);
            if (mi !== -1) pvpLastNodeMatches[nodeId][mi] = { ...pvpLastNodeMatches[nodeId][mi], hasSelf: false, clearedBadge: true, isInProgress: false };
          }
          const _updCards = pvpLastNodeMatches[nodeId];
          const _nowAllCleared = !!_updCards?.length && _updCards.every(m => m.clearedBadge);
          if (pvpNodeStats[nodeId]) pvpNodeStats[nodeId] = { ...pvpNodeStats[nodeId], hasSelf: false, ...(_nowAllCleared ? { allCleared: true, hasOpen: false } : {}) };
          pvpLiveJoinCount = Math.max(0, pvpLiveJoinCount - 1);
          refreshUI();
          return;
        }

        if (roomStatus !== 'live') {
          await sleep(PVP_BATTLE_WAIT_POLL_MS);
          continue;
        }

        const isMyTurnNow = !!(me.in_match && turn.side === 'ally' &&
                               String(turn.user_id) === String(playerId));

        if (isMyTurnNow && !wasMyTurn) {
          if (masterEnabled) {
            // FIX: a failed use_skill used to forfeit the whole turn; retry up to 3 times per turn (state is re-checked each poll)
            const done = await pvpExecuteFastTurn(instanceId, nodeId, matchNo, me, state);
            if (done !== false || ++turnFails >= 3) wasMyTurn = true;
          } else {
            pvpLog(`Node ${nodeId} match #${matchNo}: my turn but automation paused — waiting`);
          }
        } else if (!isMyTurnNow) {
          wasMyTurn = false;
          turnFails = 0;
        }

        await sleep(PVP_BATTLE_POLL_MS);
      }
    } catch (err) {
      pvpWarn(`Node ${nodeId} match #${matchNo}: battle monitor error — ${err.message}`);
    } finally {
      pvpActiveBattleLoops.delete(loopKey);
    }
  }

  function pvpGetEffectiveScheduleEntry() {
    const now = saNowSeconds();
    return dsGetActiveScheduleEntry(PVP_SCHEDULE, now, PVP_SCHEDULE[0]);
  }
  function pvpGetEffectiveMatchLimit() {
    return pvpGetEffectiveScheduleEntry()?.limit ?? 6;
  }

  async function pvpScanAndJoin(instanceId) {
    const { name: playerName } = await getPlayerInfo();
    if (!playerName) { pvpWarn('Player name unknown; aborting'); return; }
    const currentPlayerKey = playerKey(playerName);
    const availableNodes   = await pvpGetAvailableNodes(instanceId);
    let bestMatch = null, bestNodeId = null;
    let actualSelfCount = 0;
    const seenSelfKeys  = new Set();
    for (const nodeId of PVP_NODE_PRIORITY) {
      try {
        const isAvailable = availableNodes.has(nodeId);
        pvpLogNodeLockTransition(nodeId, isAvailable);
        if (!isAvailable) { pvpNodeStats[nodeId] = { locked: true }; pvpClearCooldown(nodeId); refreshUI(); continue; }
        const nodeUrl = new URL(PVP_NODE_URL_BASE, location.origin);
        nodeUrl.searchParams.set('source',      PVP_SOURCE);
        nodeUrl.searchParams.set('instance_id', instanceId);
        nodeUrl.searchParams.set('node_id',     String(nodeId));
        const doc = await fetchDoc(nodeUrl.href, `node ${nodeId}`);
        if (!doc) continue;
        const inNodeCooldown = pvpHasCooldown(doc);
        if (inNodeCooldown) pvpSetCooldown(nodeId, pvpExtractCooldownTimer(doc));
        else                pvpClearCooldown(nodeId);
        const cards = pvpParseMatchCards(doc, currentPlayerKey, instanceId, nodeId);
        pvpLastNodeMatches[nodeId] = cards;
        let nodeSelfCount = 0;
        for (const m of cards) {
          if (!m.hasSelf) continue;
          const key = `${nodeId}:${m.matchNo}`;
          if (seenSelfKeys.has(key)) continue;
          seenSelfKeys.add(key);
          actualSelfCount++;
          nodeSelfCount++;
          if (!m.clearedBadge) {
            pvpSaveActiveMatch(instanceId, nodeId, m.matchNo);
            void pvpRunFastBattleLoop(instanceId, nodeId, m.matchNo);
          }
        }
        pvpNodeStats[nodeId] = {
          locked    : false,
          onCooldown: inNodeCooldown,
          hasSelf   : cards.some(m => m.hasSelf && !m.clearedBadge),
          hasOpen   : cards.some(m => !m.clearedBadge && !m.isInProgress && m.openSlots > 0 && !m.hasSelf),
          allCleared: cards.length > 0 && cards.every(m => m.clearedBadge),
          matchCount: cards.length,
          selfCount : nodeSelfCount,
        };
        if (pvpNodeStats[nodeId].allCleared) pvpWipeCooldown(nodeId);
        refreshUI();
        const best = pvpPickBestMatch(cards);
        if (!inNodeCooldown && !best && cards.some(m => m.openSlots > 0 && !m.clearedBadge && !m.isInProgress && !m.hasSelf)) {
          pvpWarn(`Node ${nodeId}: ${cards.length} card(s), some show open slots, but none scored joinable — check href/hasSelf logic`);
        }
        if (!inNodeCooldown && best && (!bestMatch || best.score > bestMatch.score)) {
          bestMatch = best; bestNodeId = nodeId;
        }

      } catch (e) {
        pvpWarn(`Node ${nodeId}: scan threw — ${e.message}`);
        continue;
      }
    }

    pvpLiveJoinCount = actualSelfCount;
    pvpHasScanned    = true;
    refreshUI();

    const effLimit = pvpGetEffectiveMatchLimit();
    if (pvpLiveJoinCount >= effLimit) {
      pvpInfo(`Match limit reached (${pvpLiveJoinCount}/${effLimit}) — not joining`);
      return;
    }
    if (!bestMatch?.href) return;

    const u = new URL(bestMatch.href);
    pvpUpdateSourceParams({
      instance_id : u.searchParams.get('instance_id'),
      node_id     : u.searchParams.get('node_id'),
      match_no    : u.searchParams.get('match_no'),
    });
    const { joined, alreadyIn } = await pvpTryJoinBattleHref(bestMatch.href, currentPlayerKey);
    if (joined) {
      pvpLiveJoinCount++;
      pvpInfo(`Joined match #${bestMatch.matchNo} on Node ${bestNodeId} (${pvpLiveJoinCount}/${effLimit})`);
      if (pvpLastNodeMatches[bestNodeId]) {
        const mi = pvpLastNodeMatches[bestNodeId].findIndex(m => m.matchNo === bestMatch.matchNo);
        if (mi !== -1) {
          const m = pvpLastNodeMatches[bestNodeId][mi];
          pvpLastNodeMatches[bestNodeId][mi] = {
            ...m, hasSelf: true,
            openSlots:   Math.max(0, m.openSlots - 1),
            filledSlots: m.filledSlots + 1,
          };
        }
      }
      pvpNodeStats[bestNodeId] = { ...(pvpNodeStats[bestNodeId] || {}), hasSelf: true, hasOpen: false };
      pvpSaveActiveMatch(instanceId, bestNodeId, bestMatch.matchNo);
      void pvpRunFastBattleLoop(instanceId, bestNodeId, bestMatch.matchNo);
      refreshUI();
    } else if (alreadyIn) {
      pvpInfo(`Already in match #${bestMatch.matchNo} on Node ${bestNodeId} — hasSelf missed; correcting`);
      pvpLiveJoinCount++;
      if (pvpLastNodeMatches[bestNodeId]) {
        const mi = pvpLastNodeMatches[bestNodeId].findIndex(m => m.matchNo === bestMatch.matchNo);
        if (mi !== -1)
          pvpLastNodeMatches[bestNodeId][mi] = { ...pvpLastNodeMatches[bestNodeId][mi], hasSelf: true };
      }
      pvpNodeStats[bestNodeId] = { ...(pvpNodeStats[bestNodeId] || {}), hasSelf: true };
      pvpSaveActiveMatch(instanceId, bestNodeId, bestMatch.matchNo);
      void pvpRunFastBattleLoop(instanceId, bestNodeId, bestMatch.matchNo);
      refreshUI();
    }
  }
  async function pvpScanFastRunPlayer(instanceId) {
    const state = pvpLoadFastRunState();

    const res7 = pvpGetMatchResult(state, 7, state.node7MatchNo);
    const res8 = pvpGetMatchResult(state, 8, state.node8MatchNo);
    if (state.node7MatchNo > 0 && res7.joined && !res7.cleared) void pvpRunFastBattleLoop(instanceId, 7, state.node7MatchNo);
    if (state.node8MatchNo > 0 && res8.joined && !res8.cleared) void pvpRunFastBattleLoop(instanceId, 8, state.node8MatchNo);

    const wants7 = state.node7MatchNo > 0 && !res7.joined;
    const wants8 = state.node8MatchNo > 0 && !res8.joined;

    if (state.node7MatchNo > 0 && res7.joined) pvpWipeCooldown(7);
    if (state.node8MatchNo > 0 && res8.joined) pvpWipeCooldown(8);

    const node7Confirmed = !wants7 && !!pvpNodeStats[7]?.allCleared;
    const node8Confirmed = !wants8 && !!pvpNodeStats[8]?.allCleared;
    if (node7Confirmed && node8Confirmed) return; // both nodes confirmed fully cleared

    const { name: playerName } = await getPlayerInfo();
    if (!playerName) return;
    const currentPlayerKey = playerKey(playerName);
    const availableNodes   = await pvpGetAvailableNodes(instanceId);

    for (const nodeId of PVP_NODE_PRIORITY) {
      const matchNo = nodeId === 7 ? state.node7MatchNo : state.node8MatchNo;
      const res     = pvpGetMatchResult(state, nodeId, matchNo);
      try {
        if (pvpNodeStats[nodeId]?.allCleared) continue;
        const isAvailable = availableNodes.has(nodeId);
        pvpLogNodeLockTransition(nodeId, isAvailable);
        if (!isAvailable) { pvpNodeStats[nodeId] = { locked: true }; pvpClearCooldown(nodeId); refreshUI(); continue; }
        const nodeUrl = new URL(PVP_NODE_URL_BASE, location.origin);
        nodeUrl.searchParams.set('source',      PVP_SOURCE);
        nodeUrl.searchParams.set('instance_id', instanceId);
        nodeUrl.searchParams.set('node_id',     String(nodeId));
        const doc = await fetchDoc(nodeUrl.href, `fast run node ${nodeId}`);
        if (!doc) continue;
        if (pvpHasCooldown(doc)) {
          pvpSetCooldown(nodeId, pvpExtractCooldownTimer(doc));
          pvpNodeStats[nodeId] = { ...(pvpNodeStats[nodeId] || {}), locked: false, onCooldown: true, hasOpen: false };
          refreshUI();
          pvpInfo(`Node ${nodeId}: committed to a match — skipping this cycle`);
          continue;
        }
        pvpClearCooldown(nodeId);
        const allCards = pvpParseMatchCards(doc, currentPlayerKey, instanceId, nodeId);
        pvpLastNodeMatches[nodeId] = allCards;
        pvpNodeStats[nodeId] = {
          locked    : false,
          hasSelf   : allCards.some(m => m.hasSelf && !m.clearedBadge),
          hasOpen   : allCards.some(m => !m.clearedBadge && !m.isInProgress && m.openSlots > 0 && !m.hasSelf),
          allCleared: allCards.length > 0 && allCards.every(m => m.clearedBadge),
          matchCount: allCards.length,
        };
        if (pvpNodeStats[nodeId].allCleared) pvpWipeCooldown(nodeId);
        refreshUI();
        if (!matchNo || res.joined) continue; // stats refreshed above — nothing left to join
        const target = allCards.find(m => m.matchNo === matchNo);
        if (!target) {
          pvpInfo(`Node ${nodeId}: match #${matchNo} not found on page yet — will retry`);
          continue;
        }
        if (target.clearedBadge) {
          pvpWipeCooldown(nodeId);
          pvpMarkNodeDone(nodeId, matchNo, true); continue;
        }
        if (target.hasSelf) {
          pvpMarkNodeDone(nodeId, matchNo);
          void pvpRunFastBattleLoop(instanceId, nodeId, matchNo);
          continue;
        }
        if (target.isInProgress) {
          pvpWarn(`Node ${nodeId} match #${matchNo}: went live without us — assign a different match # to try again`); //dont suppress
          pvpNodeStats[nodeId] = { ...(pvpNodeStats[nodeId] || {}), liveWithoutUs: true };
          refreshUI();
          continue;
        }
        if (!target.href || target.openSlots <= 0) {
          pvpWarn(`Node ${nodeId}: assigned match #${matchNo} has no open slots — coordinate with guild`);
          continue;
        }
        const { joined, alreadyIn } = await pvpTryJoinBattleHref(target.href, currentPlayerKey);
        if (joined || alreadyIn) {
          pvpInfo(`${joined ? 'Joined' : 'Already in'} match #${matchNo} on Node ${nodeId}`);
          if (pvpLastNodeMatches[nodeId]) {
            const mi = pvpLastNodeMatches[nodeId].findIndex(m => m.matchNo === matchNo);
            if (mi !== -1) {
              const m = pvpLastNodeMatches[nodeId][mi];
              pvpLastNodeMatches[nodeId][mi] = joined
                ? { ...m, hasSelf: true, openSlots: Math.max(0, m.openSlots - 1), filledSlots: m.filledSlots + 1 }
              : { ...m, hasSelf: true };
            }
          }
          pvpNodeStats[nodeId] = { ...(pvpNodeStats[nodeId] || {}), hasSelf: true };
          pvpMarkNodeDone(nodeId, matchNo);
          void pvpRunFastBattleLoop(instanceId, nodeId, matchNo);
        }

      } catch (e) {
        pvpWarn(`Node ${nodeId}: fast-run scan threw — ${e.message}`);
        continue;
      }
    }
  }

  async function pvpScanViceLeader(instanceId) {
    const available = await pvpGetAvailableNodes(instanceId);
    for (const nodeId of PVP_NODE_PRIORITY) {
      try {
        const isAvailable = available.has(nodeId);
        pvpLogNodeLockTransition(nodeId, isAvailable);
        if (!isAvailable) { pvpNodeStats[nodeId] = { locked: true }; continue; }
        if (pvpNodeStats[nodeId]?.allCleared) continue;
        const nodeUrl = new URL(PVP_NODE_URL_BASE, location.origin);
        nodeUrl.searchParams.set('source',      PVP_SOURCE);
        nodeUrl.searchParams.set('instance_id', instanceId);
        nodeUrl.searchParams.set('node_id',     String(nodeId));
        const doc = await fetchDoc(nodeUrl.href, `leader node ${nodeId}`);
        if (!doc) continue;
        const matches = pvpParseMatchCards(doc, '', instanceId, nodeId);
        for (const match of matches) {
          if (match.clearedBadge || match.isInProgress || !match.href || match.filledSlots <= 0) continue;
          const matchKey = `${instanceId}:${nodeId}:${match.matchNo}`;
          if (pvpStartedMatchKeys.has(matchKey)) continue;
          const started = await pvpTryStartMatch(match.href);
          if (started) {
            pvpStartedMatchKeys.add(matchKey);
            pvpInfo(`Started match #${match.matchNo} on Node ${nodeId}`);
            if (pvpLastNodeMatches[nodeId]) {
              const mi = pvpLastNodeMatches[nodeId].findIndex(m => m.matchNo === match.matchNo);
              if (mi !== -1)
                pvpLastNodeMatches[nodeId][mi] = { ...pvpLastNodeMatches[nodeId][mi], isInProgress: true, openSlots: 0 };
            }
            refreshUI();
          }
        }
        pvpNodeStats[nodeId] = {
          ...(pvpNodeStats[nodeId] || {}),
          locked: false,
          allCleared: matches.length > 0 && matches.every(m => m.clearedBadge),
        };

      } catch (e) {
        pvpWarn(`Node ${nodeId}: leader scan threw — ${e.message}`);
        continue;
      }
    }
  }

  async function pvpGetTyrantStatus(instanceId) {
    const cubeState = await getCubeState(instanceId);
    const node = cubeState?.nodes?.find(n => Number(n.id) === PVP_TYRANT_NODE_ID);
    if (!node) return { available: false };
    const locked   = !node.is_revealed || node.status === 'hidden' || node.status === 'locked';
    const cleared  = node.status === 'cleared';
    return { available: !locked, cleared };
  }

  async function pvpScanTyrantNode(instanceId, { join = true } = {}) {
    if (!pvpTyrantEnabled) { pvpNodeStats[PVP_TYRANT_NODE_ID] = { hidden: true }; pvpWipeCooldown(PVP_TYRANT_NODE_ID); refreshUI(); return; }

    const { available, cleared: stateCleared } = await pvpGetTyrantStatus(instanceId);
    pvpLogNodeLockTransition(PVP_TYRANT_NODE_ID, available);
    if (!available) { pvpNodeStats[PVP_TYRANT_NODE_ID] = { locked: true }; pvpClearCooldown(PVP_TYRANT_NODE_ID); refreshUI(); return; }
    if (stateCleared) {
      pvpNodeStats[PVP_TYRANT_NODE_ID] = { locked: false, allCleared: true, hasSelf: false, hasOpen: false, matchCount: 0 };
      pvpWipeCooldown(PVP_TYRANT_NODE_ID);
      refreshUI();
      return;
    }

    const { name: playerName } = await getPlayerInfo();
    if (!playerName) return;
    const currentPlayerKey = playerKey(playerName);

    const nodeUrl = new URL(PVP_NODE_URL_BASE, location.origin);
    nodeUrl.searchParams.set('source',      PVP_SOURCE);
    nodeUrl.searchParams.set('instance_id', instanceId);
    nodeUrl.searchParams.set('node_id',     String(PVP_TYRANT_NODE_ID));
    const doc = await fetchDoc(nodeUrl.href, 'node 9 (Tyrant Conclave)');
    if (!doc) return;

    const inNodeCooldown = pvpHasCooldown(doc);
    if (inNodeCooldown) pvpSetCooldown(PVP_TYRANT_NODE_ID, pvpExtractCooldownTimer(doc));
    else                pvpClearCooldown(PVP_TYRANT_NODE_ID);

    const cards = pvpParseMatchCards(doc, currentPlayerKey, instanceId, PVP_TYRANT_NODE_ID);
    pvpNodeStats[PVP_TYRANT_NODE_ID] = {
      locked    : false,
      onCooldown: inNodeCooldown,
      hasSelf   : cards.some(m => m.hasSelf && !m.clearedBadge),
      hasOpen   : cards.some(m => !m.clearedBadge && !m.isInProgress && m.openSlots > 0 && !m.hasSelf),
      allCleared: cards.length > 0 && cards.every(m => m.clearedBadge),
      matchCount: cards.length,
    };
    refreshUI();
    if (!join) return; // status-only pass (master OFF) — never act

    if (inNodeCooldown) {
      pvpInfo('Tyrant Conclave: committed to a match — skipping join this cycle');
      const ourCard = cards.find(m => m.hasSelf && !m.clearedBadge);
      if (ourCard) void pvpRunFastBattleLoop(instanceId, PVP_TYRANT_NODE_ID, ourCard.matchNo);
      return;
    }

    const ourCard = cards.find(m => m.hasSelf && !m.clearedBadge);
    if (ourCard) { void pvpRunFastBattleLoop(instanceId, PVP_TYRANT_NODE_ID, ourCard.matchNo); return; }

    const best = pvpPickBestMatch(cards);
    if (!best?.href) return;

    const u = new URL(best.href);
    pvpUpdateSourceParams({
      instance_id : u.searchParams.get('instance_id'),
      node_id     : u.searchParams.get('node_id'),
      match_no    : u.searchParams.get('match_no'),
    });
    const { joined, alreadyIn } = await pvpTryJoinBattleHref(best.href, currentPlayerKey);
    if (joined || alreadyIn) {
      pvpNodeStats[PVP_TYRANT_NODE_ID] = { ...(pvpNodeStats[PVP_TYRANT_NODE_ID] || {}), hasSelf: true, hasOpen: false };
      pvpInfo(`Tyrant Conclave: ${joined ? 'joined' : 'already in'} match #${best.matchNo} — starting battle monitor`);
      refreshUI();
      void pvpRunFastBattleLoop(instanceId, PVP_TYRANT_NODE_ID, best.matchNo);
    }
  }

  async function pvpReadOnlyScan(instanceId) {
    if (pvpBusy) return;
    pvpBusy = true;
    try {
      const { name: playerName } = await getPlayerInfo();
      if (!playerName) { pvpLog('Passive scan: player name unknown'); return; }
      const currentPlayerKey = playerKey(playerName);
      const availableNodes   = await pvpGetAvailableNodes(instanceId);
      let actualSelfCount = 0;
      const seenSelfKeys  = new Set();

      for (const nodeId of PVP_NODE_PRIORITY) {
        const isAvailable = availableNodes.has(nodeId);
        pvpLogNodeLockTransition(nodeId, isAvailable);
        if (!isAvailable) { pvpClearCooldown(nodeId); continue; }
        const nodeUrl = new URL(PVP_NODE_URL_BASE, location.origin);
        nodeUrl.searchParams.set('source',      PVP_SOURCE);
        nodeUrl.searchParams.set('instance_id', instanceId);
        nodeUrl.searchParams.set('node_id',     String(nodeId));
        const doc = await fetchDoc(nodeUrl.href, `passive node ${nodeId}`);
        if (!doc) continue;
        const inNodeCooldown = pvpHasCooldown(doc);
        if (inNodeCooldown) pvpSetCooldown(nodeId, pvpExtractCooldownTimer(doc));
        else                pvpClearCooldown(nodeId);
        const cards = pvpParseMatchCards(doc, currentPlayerKey, instanceId, nodeId);
        pvpLastNodeMatches[nodeId] = cards;
        pvpNodeStats[nodeId] = {
          locked    : false,
          onCooldown: inNodeCooldown,
          hasSelf   : cards.some(m => m.hasSelf && !m.clearedBadge),
          hasOpen   : cards.some(m => !m.clearedBadge && !m.isInProgress && m.openSlots > 0 && !m.hasSelf),
          allCleared: cards.length > 0 && cards.every(m => m.clearedBadge),
          matchCount: cards.length,
        };
        if (pvpNodeStats[nodeId].allCleared) pvpWipeCooldown(nodeId);
        for (const m of cards) {
          if (!m.hasSelf) continue;
          const key = `${nodeId}:${m.matchNo}`;
          if (seenSelfKeys.has(key)) continue;
          seenSelfKeys.add(key);
          actualSelfCount++;
          if (!m.clearedBadge) {
            pvpSaveActiveMatch(instanceId, nodeId, m.matchNo);
            void pvpRunFastBattleLoop(instanceId, nodeId, m.matchNo);
          }
        }
      }

      pvpLiveJoinCount = actualSelfCount;
      pvpHasScanned    = true;
      pvpLog(`Passive scan complete: ${pvpLiveJoinCount}/${pvpGetEffectiveMatchLimit()} joins`);
      if (pvpTyrantEnabled) await pvpScanTyrantNode(instanceId, { join: false });
      refreshUI();
    } catch (err) { pvpWarn(`Passive scan error: ${err.message}`); }
    finally { pvpBusy = false; }
  }

  async function pvpTick(instanceId) {
    if (pvpBusy) return;
    pvpBusy = true;
    try {
      if (!dsIsFastMode()) {
        for (const { nodeId, matchNo } of pvpLoadActiveMatches(instanceId)) {
          void pvpRunFastBattleLoop(instanceId, nodeId, matchNo);
        }
      }
      const fastMode = dsIsFastMode();
      const state    = pvpLoadFastRunState();
      if (fastMode && state.isLeader) {
        await pvpScanFastRunPlayer(instanceId);
        await pvpScanViceLeader(instanceId);
      } else if (fastMode) {
        await pvpScanFastRunPlayer(instanceId);
      } else {
        await pvpScanAndJoin(instanceId);
      }
      await pvpScanTyrantNode(instanceId);
    } catch (err) { pvpWarn(`Tick error: ${err.message}`); }
    finally { pvpBusy = false; pvpHasScanned = true; }
  }

  function saLoadAllParticipated() {
    try {
      const raw = localStorage.getItem(SA_PARTICIPATED_KEY);
      if (!raw) return {};
      const obj = JSON.parse(raw);
      if (obj && obj.instanceId && Array.isArray(obj.keys)) return { [obj.instanceId]: obj.keys }; // migrate old format
      return (obj && typeof obj === 'object') ? obj : {};
    } catch { return {}; }
  }

  function saLoadParticipated(instanceId) {
    const all = saLoadAllParticipated();
    const keys = all[String(instanceId)];
    return { instanceId: String(instanceId), keys: Array.isArray(keys) ? keys : [] };
  }

  function saSaveParticipated(instanceId, keys) {
    const all = saLoadAllParticipated();
    all[String(instanceId)] = keys;
    dsSafeSetItem(SA_PARTICIPATED_KEY, JSON.stringify(all));
  }

  function saMarkParticipated(instanceId, nodeId, matchNo) {
    const data = saLoadParticipated(instanceId);
    const key  = `${nodeId}:${matchNo}`;
    if (!data.keys.includes(key)) { data.keys.push(key); saSaveParticipated(instanceId, data.keys); }
    refreshUI();
  }

  function saGetParticipatedCount(instanceId) {
    return saLoadParticipated(instanceId).keys.length;
  }

  async function saGetAvailableArmyNodes(instanceId) {
    const cubeState = await getCubeState(instanceId);

    if (!cubeState?.nodes?.length) {
      saWarn('Could not read cube STATE nodes; trying all SA target nodes');
      return new Set(SA_TARGET_NODES);
    }

    const available = new Set();
    for (const node of cubeState.nodes) {
      const nodeId = Number(node.id);
      if (!SA_TARGET_NODES.includes(nodeId))            continue;  // not a target node
      if (node.type !== 'army')                         continue;  // not an army node
      if (!node.is_revealed)                            continue;  // not yet visible
      if (node.status === 'hidden' || node.status === 'locked') continue;
      available.add(nodeId);
    }
    if (!available.size) {
      saWarn('No available army nodes in STATE — trying all target nodes');
      return new Set(SA_TARGET_NODES);
    }
    return available;
  }
  async function saReadOnlyScan(instanceId) {
    if (saBusy) return;
    saBusy = true;
    try {
      const { name: playerName, id: playerId } = await getPlayerInfo();
      if (!playerName) { saWarn('Passive SA scan: player name unknown'); return; }
      const participatedData = saLoadParticipated(instanceId);
      const participatedKeys = new Set(participatedData.keys);
      const available        = await saGetAvailableArmyNodes(instanceId);
      let changed = false;
      for (let i = 0; i < SA_TARGET_NODES.length; i++) {
        const nodeId = SA_TARGET_NODES[i];
        const isAvailable = available.has(nodeId);
        saLogNodeLockTransition(nodeId, isAvailable);
        if (!isAvailable) continue;
        if (saNodeStats[nodeId]?.allCleared) continue;
        if (i > 0) await sleep(SA_NODE_GAP_MS);
        const nodeUrl = new URL(SA_NODE_URL_BASE, location.origin);
        nodeUrl.searchParams.set('source',      SA_SOURCE);
        nodeUrl.searchParams.set('instance_id', instanceId);
        nodeUrl.searchParams.set('node_id',     String(nodeId));
        const { ok, text } = await fetchText(nodeUrl.href);
        if (!ok) continue;
        const _rst = saParseServerTime(text);
        if (_rst) saSetServerTime(_rst);

        const { activeFightNo, fights } = saParseNodePage(text);

        const captainTarget = activeFightNo > 0
        ? fights.find(f => f.matchNo === activeFightNo)
        : fights.find(f => f.liveBtn && f.status !== 'cleared');
        if (captainTarget?.battleId > 0) {
          const battleState = await saJoinBattle(String(captainTarget.battleId)).catch(() => null);
          if (battleState?.captains?.length) {
            saLastBattleState[nodeId] = {
              captains: battleState.captains,
              engagements: battleState.engagements || [],
              matchNo: captainTarget.matchNo,
            };
            changed = true;
          }
        }

        for (const fight of fights) {
          const pKey = `${nodeId}:${fight.matchNo}`;
          if (participatedKeys.has(pKey)) continue;
          const quickDmg = saGetOwnDamageFromCard(fight, playerName, playerId);
          if (quickDmg > 0) {
            saInfo(`Passive SA: node ${nodeId} fight #${fight.matchNo} — ${quickDmg} dmg in card data`);
            saMarkParticipated(instanceId, nodeId, fight.matchNo);
            participatedKeys.add(pKey);
            changed = true;
            continue;
          }
          const hasStarted = fight.battleId > 0 || fight.status === 'cleared';
          if (!hasStarted) continue;
          const apiDmg = await saGetOwnDamage(instanceId, nodeId, fight.matchNo, playerName, playerId);
          if (apiDmg > 0) {
            saInfo(`Passive SA: node ${nodeId} fight #${fight.matchNo} — ${apiDmg} dmg via API`);
            saMarkParticipated(instanceId, nodeId, fight.matchNo);
            participatedKeys.add(pKey);
            changed = true;
          }
        }
        const allCleared   = fights.length > 0 && fights.every(f => f.status === 'cleared');
        if (allCleared && saLastBattleState[nodeId]) {
          delete saLastBattleState[nodeId];
          changed = true;
        }
        const hasAvailable = fights.some(f =>
                                         f.liveBtn && f.status !== 'cleared' && !participatedKeys.has(`${nodeId}:${f.matchNo}`));
        saNodeStats[nodeId] = {
          total: fights.length,
          activeFightNo,
          allCleared,
          hasAvailable,
          schedNukeActive: saScheduledNukingMatch.get(nodeId) === activeFightNo,
        };
        refreshUI();
      }
      if (changed) refreshUI();
    } catch (err) { saWarn(`Passive SA scan error: ${err.message}`); }
    finally { saBusy = false; refreshUI(); }
  }

  function saParseCommittedFightNo(html) {
    const m1 = html.match(/let\s+activeMatchNo\s*=\s*(\d+)\s*;/i);
    if (m1) return Number(m1[1]);
    const m2 = html.match(/id="activeFightValue"[^>]*>\s*([^<]+)\s*</i);
    if (m2) {
      const t = m2[1].trim();
      if (normText(t) === 'none') return 0;
      const n = Number((t.match(/\d+/) || [0])[0]);
      return isFinite(n) ? n : 0;
    }
    return 0;
  }

  function saExtractFightCardsJson(html) {
    const m = /let\s+fightCards\s*=\s*\[/i.exec(html);
    if (!m) return [];
    const start = m.index + m[0].length - 1;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = start; i < html.length; i++) {
      const c = html[i];
      if (esc) { esc = false; continue; }
      if (inStr) { if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') { inStr = true; continue; }
      if (c === '[') depth++;
      else if (c === ']' && --depth === 0) { end = i + 1; break; }
    }
    if (end < 0) return [];
    try { return JSON.parse(html.slice(start, end)); } catch { return []; }
  }

  function saParseNodePage(html) {
    const activeFightNo = saParseCommittedFightNo(html);
    const rawCards      = saExtractFightCardsJson(html);
    const fights = rawCards.map((card, idx) => {
      const matchNo          = Number(card.match_no || card.matchNo || idx + 1);
      const status           = normText(card.status || '');
      const battleId         = Number(card.battle_id || 0);
      const liveBtn = status !== 'cleared';
      const attackersPreview = Array.isArray(card.attackers_preview) ? card.attackers_preview : [];
      return { matchNo, status, battleId, liveBtn, attackersPreview };
    });
    return { activeFightNo, fights };
  }

  function saGetOwnDamageFromCard(fight, playerName, playerId) {
    const preview = fight.attackersPreview || [];
    const myId    = String(playerId || '');
    const myName  = normText(playerName || '');
    for (const row of preview) {
      const rowId   = String(row.user_id ?? row.player_id ?? row.pid ?? '');
      const rowName = normText(row.username ?? row.name ?? '');
      const damage  = Number(row.damage_dealt ?? row.damage ?? 0);
      if (myId   && rowId   === myId   && damage > 0) return damage;
      if (myName && rowName === myName && damage > 0) return damage;
      if ((row.is_me || row.me) && damage > 0)        return damage;
    }
    return 0;
  }

  async function saGetOwnDamage(instanceId, nodeId, matchNo, playerName, playerId) {
    try {
      const { data } = await fetchJson(SA_ACTION_API, {
        idempotent: true,   // FIX2: read-only
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body:    new URLSearchParams({
          action: 'contributors', instance_id: String(instanceId),
          node_id: String(nodeId), match_no: String(matchNo),
        }),
      });
      if (!data || data.ok === false) return null;
      const attackers =
            Array.isArray(data?.board?.attackers) ? data.board.attackers :
      Array.isArray(data?.attackers)         ? data.attackers        :
      Array.isArray(data?.contributors)      ? data.contributors     : [];
      const myId   = String(playerId || '');
      const myName = normText(playerName || '');
      for (const entry of attackers) {
        const entryId   = String(entry?.user_id ?? entry?.player_id ?? entry?.pid ?? entry?.owner_user_id ?? '');
        const entryName = normText(entry?.username ?? entry?.name ?? entry?.player ?? entry?.display_name ?? '');
        const damage    = Number(entry?.damage_dealt ?? entry?.damage ?? entry?.dmg ?? 0);
        if (myId   && entryId   && entryId   === myId)  return damage;
        if (myName && entryName && entryName === myName) return damage;
        if (entry?.is_me || entry?.me || entry?.is_mine) return damage;
      }
      return 0;
    } catch { return null; }
  }

  async function saWaitForDamage(instanceId, nodeId, matchNo, playerName, playerId, baseline) {
    for (let i = 0; i < SA_DAMAGE_TRIES; i++) {
      const dmg = await saGetOwnDamage(instanceId, nodeId, matchNo, playerName, playerId);
      if (dmg != null && dmg > baseline) return dmg;
      await sleep(SA_DAMAGE_POLL_MS);
    }
    return baseline;
  }

  async function saEnterFight(instanceId, nodeId, matchNo) {
    const { data, text } = await fetchJson(SA_ACTION_API, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body:    new URLSearchParams({
        action: 'enter_fight', instance_id: String(instanceId),
        node_id: String(nodeId), match_no: String(matchNo),
      }),
    });
    if (!data && !text) return null;
    if (data?.ok === false) { saWarn(`enter_fight rejected: ${data?.message || ''}`); return null; }
    const direct = data?.battle_id || data?.data?.battle_id;
    if (direct) return String(direct);
    const redirect = String(data?.redirect || data?.url || data?.location || text || '');
    const m = redirect.match(/battle_id=(\d+)/i);
    return m ? m[1] : null;
  }

  async function saJoinBattle(battleId) {
    const { data } = await fetchJson(SA_BATTLE_API, {
      idempotent: true,   // FIX2: join_battle only reads state
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body:    new URLSearchParams({ action: 'join_battle', battle_id: String(battleId) }),
    });
    if (!data) return null;
    return data.state || data;
  }

  async function saAssignTarget(battleId, attackerId, defenderId) {
    const { data, status } = await fetchJson(SA_BATTLE_API, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body:    new URLSearchParams({
        action: 'assign_target', battle_id: String(battleId),
        attacker_captain_unit_id: String(attackerId),
        defender_captain_unit_id: String(defenderId),
      }),
    });
    // FIX: a network error / 5xx / non-JSON reply (data == null) or {ok:false} used to count as a successful assign
    if (!data) throw new Error(`no valid reply (status ${status || 'network error'})`);
    if (data.ok === false || (!data.ok && data.message)) throw new Error(data.message || 'rejected');
    return data;
  }

  async function saRetreatCaptain(battleId, captainId) {
    const { data, status } = await fetchJson(SA_BATTLE_API, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body:    new URLSearchParams({
        action: 'retreat_captain', battle_id: String(battleId),
        captain_unit_id: String(captainId),
      }),
    });
    // FIX: same as assign - a failed retreat must not be logged / treated as success
    if (!data) throw new Error(`no valid reply (status ${status || 'network error'})`);
    if (data.ok === false || (!data.ok && data.message)) throw new Error(data.message || 'rejected');
    return data;
  }

  const SA_HEAL_BACKOFF_MS = 30_000;
  const SA_HEAL_REPEAT_MS  = 120_000;
  let saHealInFlight = null, saHealBackoffUntil = 0, saHealLast = null;
  let saHealLogKey = '', saHealLogAt = 0, saHealLogRepeats = 0;

  function saParseHealReply(finalUrl, bodyText) {
    let msg = '', okParam = null;
    try {
      const q = new URL(finalUrl, location.origin).searchParams;   // already percent/plus-decoded
      if (q.has('msg')) msg = q.get('msg') || '';
      if (q.has('ok'))  okParam = q.get('ok');
    } catch (_) { /* no usable url */ }
    if (!msg && bodyText) {                                         // not redirected: maybe a JSON reply
      let j = null; try { j = JSON.parse(bodyText); } catch (_) { /* not JSON */ }
      if (j) { msg = String(j.msg || j.message || ''); if (j.ok !== undefined) okParam = j.ok ? '1' : '0'; }
    }
    msg = msg.trim();
    const ok = okParam === null ? null : /^(1|true|yes)$/i.test(String(okParam));
    const notReady = /no units? (are|is) ready|not ready|nothing to heal|already (full|healed)/i.test(msg);
    const n = msg.match(/\b(\d+)\b/);
    const status = ok === true ? 'healed' : notReady ? 'not_ready' : ok === false ? 'refused' : 'unknown';
    return { status, ok, msg, count: n ? Number(n[1]) : null };
  }

  function saHealLog(reason, r) {
    const key = `${r.status}|${r.msg}`, now = Date.now();
    if (key === saHealLogKey && now - saHealLogAt < SA_HEAL_REPEAT_MS) { saHealLogRepeats++; saHealLogAt = now; return; }
    if (saHealLogRepeats) { saInfo(`Heal-all: same reply again x${saHealLogRepeats}`); saHealLogRepeats = 0; }
    saHealLogKey = key; saHealLogAt = now;
    const said = r.msg ? `"${r.msg}"` : '(no message)';
    const line = `Heal-all (${reason}): ${r.status === 'error' ? 'request failed' : said}`;
    if (r.status === 'error') saWarn(line); else saInfo(line);
  }

  async function saHealDeadCaptains(reason = "Captain(s) KO'd", opts = {}) {
    if (saHealInFlight) return saHealInFlight;
    if (!opts.force && Date.now() < saHealBackoffUntil && saHealLast) return saHealLast;
    saHealInFlight = (async () => {
      let result;
      try {
        const { res, text, ok } = await fetchText(SA_HEAL_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
          body: new URLSearchParams({ action: 'heal_all_units' }).toString(),
        });
        result = (!ok || !res) ? { status: 'error', ok: false, msg: '', count: null } : saParseHealReply(res.url, text);
      } catch (e) {
        result = { status: 'error', ok: false, msg: String(e?.message || e), count: null };
      } finally { saHealInFlight = null; }
      saHealBackoffUntil = (result.status === 'not_ready' || result.status === 'refused') ? Date.now() + SA_HEAL_BACKOFF_MS : 0;
      saHealLast = result;
      saHealLog(reason, result);
      return result;
    })();
    return saHealInFlight;
  }

  const saMyCaptains  = state => (state?.captains || []).filter(
    c => c.side === 'ALLY' && c.is_mine && !c.is_dead && !c.retreat_requested);
  const saLiveEnemies = state => (state?.captains || []).filter(c => c.side === 'ENEMY' && !c.is_dead);

  function saGetTargetingCounts(state) {
    const counts = {};
    for (const eng of (state?.engagements || [])) {
      const def = Number(eng.defender_captain_unit_id);
      counts[def] = (counts[def] || 0) + 1;
    }
    return counts;
  }

  function saPickLeastTargeted(enemies, counts) {
    if (!enemies.length) return null;
    const min  = Math.min(...enemies.map(e => counts[Number(e.id)] || 0));
    const tied = enemies.filter(e => (counts[Number(e.id)] || 0) === min);
    return tied[Math.floor(Math.random() * tied.length)];
  }

  function saGetEngagedMineCaptains(state) {
    const mine = saMyCaptains(state);
    const engagedIds = new Set((state?.engagements || []).map(e => Number(e.attacker_captain_unit_id)));
    return mine.filter(c => engagedIds.has(Number(c.id)));
  }
  function saGetIdleMineCaptains(state) {
    const mine = saMyCaptains(state);
    const engagedIds = new Set((state?.engagements || []).map(e => Number(e.attacker_captain_unit_id)));
    return mine.filter(c =>
                       !engagedIds.has(Number(c.id)) &&
                       !saGloballyEngagedCaptainIds.has(Number(c.id))  // ← cross-battle guard
                      );
  }

  async function saExecuteOrdinary(battleId, instanceId, nodeId, matchNo, playerName, playerId, alreadyResolved) {
    const state = await saJoinBattle(battleId);
    if (!state) { saWarn('join_battle returned null'); return 'error'; }
    const battleStatus = state?.battle?.status || state?.status;
    const matchEndedNow = !!battleStatus && battleStatus !== 'ACTIVE';
    saLastBattleState[nodeId] = { captains: state.captains || [], engagements: state.engagements || [], matchNo, matchEnded: matchEndedNow };
    if (matchEndedNow) { saWarn(`Battle not ACTIVE (${battleStatus})`); return 'finished'; }

    const engaged = saGetEngagedMineCaptains(state);
    if (engaged.length) {
      let allRetreated = true;
      const retreatedIds = [];
      for (const captain of engaged) {
        try {
          await saRetreatCaptain(battleId, captain.id);
          retreatedIds.push(Number(captain.id));
          saInfo(`Ordinary: retried retreat for captain ${captain.id} (was still engaged from a previous cycle)`);
        } catch (e) {
          allRetreated = false;
          saWarn(`Ordinary: retry retreat failed for captain ${captain.id}: ${e.message}`);
        }
      }
      if (retreatedIds.length && saLastBattleState[nodeId]) {
        saLastBattleState[nodeId] = {
          ...saLastBattleState[nodeId],
          engagements: (saLastBattleState[nodeId].engagements || [])
          .filter(e => !retreatedIds.includes(Number(e.attacker_captain_unit_id))),
        };
        refreshUI();
      }
      return allRetreated ? 'fought' : 'retreat_pending';
    }
    const baseDmg = await saGetOwnDamage(instanceId, nodeId, matchNo, playerName, playerId);
    if (baseDmg == null) {   // FIX2: can't prove we haven't already hit this fight - retry next tick instead of guessing
      saWarn('Ordinary: contributors lookup failed - not assigning blind, will retry next tick');
      return 'error';
    }
    if (baseDmg > 0) {
      saInfo(`Ordinary: already dealt ${baseDmg} damage in this fight (confirmed live) — skipping assign`);
      return 'already_fought';
    }
    if (alreadyResolved) return 'fought';
    await sleep(SA_JOIN_DELAY_MS);
    const allMine = (state?.captains || []).filter(c => c.side === 'ALLY' && c.is_mine);
    const mine = allMine.filter(c =>
                                !c.is_dead &&
                                !c.retreat_requested &&
                                !saGloballyEngagedCaptainIds.has(Number(c.id))   // ← cross-node guard, parallel-safe
                               );
    const newlyDead = allMine.filter(c => c.is_dead && !saHealedCaptainIds.has(String(c.id)));
    if (newlyDead.length) {
      newlyDead.forEach(c => saHealedCaptainIds.add(String(c.id)));
      void saHealDeadCaptains(`Ordinary: ${newlyDead.length} captain(s) newly KO'd`);
    }
    allMine.filter(c => !c.is_dead).forEach(c => saHealedCaptainIds.delete(String(c.id)));
    if (allMine.length > 0 && mine.length === 0) return 'captain_dead';
    if (!mine.length) {
      void saHealDeadCaptains('Ordinary: no own captains available, maybe dead from a previous session');
      return 'captain_dead';
    }

    let captain = null;
    let assignedCount = 0;

    for (const candidate of mine) {
      const liveState = await saJoinBattle(battleId);
      if (!liveState) { saWarn('Ordinary: lost battle state while picking captain'); return 'error'; }
      const liveStatus = liveState?.battle?.status || liveState?.status;
      if (liveStatus && liveStatus !== 'ACTIVE') { saInfo('Ordinary: battle ended while picking captain'); return 'finished'; }

      const enemies = saLiveEnemies(liveState);
      if (!enemies.length) { saInfo('Ordinary: no live enemies remaining'); return 'skipped'; }

      const stillUsable = saMyCaptains(liveState).some(c => Number(c.id) === Number(candidate.id))
      && !saGloballyEngagedCaptainIds.has(Number(candidate.id));
      if (!stillUsable) {
        saWarn(`Ordinary: captain ${candidate.id} no longer available — trying next`);
        continue;
      }

      saGloballyEngagedCaptainIds.add(Number(candidate.id));

      let landedFirst = false;
      for (const enemy of enemies) {
        try {
          await saAssignTarget(battleId, candidate.id, enemy.id);
          saInfo(`Ordinary: captain ${candidate.id} → enemy ${enemy.id}`);
          assignedCount++;
          landedFirst = true;
        } catch (e) {
          saWarn(`assign_target failed (captain ${candidate.id} → enemy ${enemy.id}): ${e.message}`);
          if (!landedFirst) break;
        }
        await sleep(SA_ASSIGN_GAP_MS);
      }

      if (landedFirst) {
        captain = candidate;
        const postAssignState = await saJoinBattle(battleId);
        if (postAssignState) {
          saLastBattleState[nodeId] = { captains: postAssignState.captains || [], engagements: postAssignState.engagements || [], matchNo };
          refreshUI(); // show "captain → enemy" right away, not only once retreat fires
        }
        break;
      } else {
        saGloballyEngagedCaptainIds.delete(Number(candidate.id)); // release failed reservation
      }
    }

    if (!captain) { saWarn('Ordinary: no captain could be assigned to anything'); return 'error'; }

    await sleep(SA_HIT_GAP_MS);
    let retreated = false;
    try { await saRetreatCaptain(battleId, captain.id); retreated = true; saInfo(`Retreated captain ${captain.id}`); }
    catch (e) { saWarn(`retreat_captain failed: ${e.message} — captain left engaged, will retry next cycle`); }
    if (retreated) saGloballyEngagedCaptainIds.delete(Number(captain.id));
    if (retreated && saLastBattleState[nodeId]) {
      saLastBattleState[nodeId] = {
        ...saLastBattleState[nodeId],
        engagements: (saLastBattleState[nodeId].engagements || [])
        .filter(e => Number(e.attacker_captain_unit_id) !== Number(captain.id)),
      };
      refreshUI();
    }
    await sleep(SA_DAMAGE_POLL_MS); // let server process retreat's damage tick before polling
    const finalDmg = await saWaitForDamage(instanceId, nodeId, matchNo, playerName, playerId, baseDmg);
    const gained = finalDmg - baseDmg;
    if (gained > 0) saInfo(`Confirmed +${gained} damage (captain ${captain.id} hit ${assignedCount} enem${assignedCount === 1 ? 'y' : 'ies'})`);
    else            saInfo(`Damage not yet visible — will register on next server tick`);

    const postHitState = await saJoinBattle(battleId).catch(() => null);
    const postHitStatus = postHitState?.battle?.status || postHitState?.status;
    const matchEnded = !!postHitStatus && postHitStatus !== 'ACTIVE';
    saLastBattleState[nodeId] = { ...(saLastBattleState[nodeId] || {}), matchNo, matchEnded };

    return retreated ? 'fought' : 'retreat_pending';
  }

  async function saExecuteFastRun(battleId, instanceId, nodeId, matchNo, playerName, playerId) {
    const state = await saJoinBattle(battleId);
    if (!state) { saWarn('Fast Run: join_battle returned null'); return 'error'; }

    for (const eng of (state?.engagements || [])) {
      saGloballyEngagedCaptainIds.add(Number(eng.attacker_captain_unit_id));
    }
    const battleStatus = state?.battle?.status || state?.status;
    const matchEndedNow = !!battleStatus && battleStatus !== 'ACTIVE';
    saLastBattleState[nodeId] = { captains: state.captains || [], engagements: state.engagements || [], matchNo, matchEnded: matchEndedNow };
    if (matchEndedNow) {
      saWarn(`Fast Run: battle not ACTIVE (${battleStatus})`); return 'finished';
    }

    const allMineFR = (state?.captains || []).filter(c => c.side === 'ALLY' && c.is_mine);
    const newlyDeadFR = allMineFR.filter(c => c.is_dead && !saHealedCaptainIds.has(String(c.id)));
    if (newlyDeadFR.length) {
      newlyDeadFR.forEach(c => saHealedCaptainIds.add(String(c.id)));
      void saHealDeadCaptains(`Fast Run: ${newlyDeadFR.length} captain(s) newly KO'd`);
    }
    allMineFR.filter(c => !c.is_dead).forEach(c => saHealedCaptainIds.delete(String(c.id)));
    if (!allMineFR.length) {
      void saHealDeadCaptains('Fast Run: no own captains visible, maybe dead from a previous session');
      return 'captain_dead';
    }
    if (allMineFR.every(c => c.is_dead)) return 'captain_dead';

    const idle    = saGetIdleMineCaptains(state);
    const enemies = saLiveEnemies(state);
    if (!enemies.length) { saInfo('Fast Run: no live enemies remaining'); return 'finished'; }
    if (!idle.length)    { saInfo('Fast Run: no free captains — holding'); return 'no_captains'; }

    const reserved = idle.map(c => Number(c.id));
    reserved.forEach(id => saGloballyEngagedCaptainIds.add(id));

    await sleep(SA_JOIN_DELAY_MS);

    const liveCounts = Object.assign({}, saGetTargetingCounts(state));

    saInfo(`Fast Run: assigning ${idle.length} captain(s) → ${enemies.length} alive enem(y/ies) (least-targeted, random tie-break)…`);

    let assigned = 0;
    for (const captain of idle) {
      const target = saPickLeastTargeted(enemies, liveCounts);
      if (!target) break; // no alive enemies left at all
      try {
        await saAssignTarget(battleId, captain.id, target.id);
        liveCounts[Number(target.id)] = (liveCounts[Number(target.id)] || 0) + 1;
        saInfo(`Fast Run: captain ${captain.id} → enemy ${target.id} (${liveCounts[Number(target.id)]} on that target)`);
        assigned++;
      } catch (e) {
        saWarn(`Fast Run: captain ${captain.id} → enemy ${target.id} failed: ${e.message}`);
        saGloballyEngagedCaptainIds.delete(Number(captain.id)); // release on genuine server error
      }
      await sleep(SA_ASSIGN_GAP_MS);
    }

    if (assigned > 0) {
      const postAssignState = await saJoinBattle(battleId);
      if (postAssignState) {
        saLastBattleState[nodeId] = {
          captains: postAssignState.captains || [],
          engagements: postAssignState.engagements || [],
          matchNo,
        };
      }
    }

    saInfo(`Fast Run: ${assigned}/${idle.length} captain(s) assigned — no retreat (nuke mode)`);
    if (assigned > 0) return 'fought';

    saWarn('Fast Run: all assignment attempts failed');
    return 'error';
  }

  async function saScanNode(instanceId, nodeId, playerName, playerId, participatedKeys, excludeMatchNos = null) {
    saInfo(`Node ${nodeId}: scanning…`);
    saNodeStats[nodeId] = { ...(saNodeStats[nodeId] || {}), scanning: true, justFought: false };
    refreshUI();
    const nodeUrl = new URL(SA_NODE_URL_BASE, location.origin);
    nodeUrl.searchParams.set('source',      SA_SOURCE);
    nodeUrl.searchParams.set('instance_id', instanceId);
    nodeUrl.searchParams.set('node_id',     String(nodeId));
    const { ok, text } = await fetchText(nodeUrl.href);
    if (!ok) {
      saNodeStats[nodeId] = { ...(saNodeStats[nodeId] || {}), scanning: false };
      saWarn(`Node ${nodeId}: page fetch failed`);
      refreshUI();
      return 'error';
    }
    const _sst = saParseServerTime(text);
    if (_sst) saSetServerTime(_sst);

    const { activeFightNo, fights } = saParseNodePage(text);
    const fastMode = dsIsFastMode();

    saNodeStats[nodeId] = {
      total: fights.length,
      activeFightNo,
      allCleared:   fights.length > 0 && fights.every(f => f.status === 'cleared'),
      hasAvailable: fights.some(f => f.liveBtn && f.status !== 'cleared' && !participatedKeys.has(`${nodeId}:${f.matchNo}`)),
    };

    for (const fight of fights) {
      const pKey = `${nodeId}:${fight.matchNo}`;
      if (participatedKeys.has(pKey)) continue;

      const quickDmg = saGetOwnDamageFromCard(fight, playerName, playerId);
      if (quickDmg > 0) {
        saInfo(`Node ${nodeId} fight #${fight.matchNo}: ${quickDmg} dmg in card data — marking seen`);
        saMarkParticipated(instanceId, nodeId, fight.matchNo);
        participatedKeys.add(pKey);
        continue;
      }

      const hasStarted = fight.battleId > 0 || fight.status === 'cleared';
      if (!hasStarted) continue;

      const apiDmg = await saGetOwnDamage(instanceId, nodeId, fight.matchNo, playerName, playerId);
      if (apiDmg > 0) {
        saInfo(`Node ${nodeId} fight #${fight.matchNo}: ${apiDmg} dmg via contributors API — marking seen`);
        saMarkParticipated(instanceId, nodeId, fight.matchNo);
        participatedKeys.add(pKey);
      }
    }

    const allCleared   = fights.length > 0 && fights.every(f => f.status === 'cleared');
    const hasAvailable = fights.some(f =>
                                     f.liveBtn && f.status !== 'cleared' && !participatedKeys.has(`${nodeId}:${f.matchNo}`));
    saNodeStats[nodeId] = { total: fights.length, activeFightNo, allCleared, hasAvailable };
    if (allCleared && saLastBattleState[nodeId]) delete saLastBattleState[nodeId];
    refreshUI();

    const exclude = excludeMatchNos || new Set();
    let target = null;
    if (activeFightNo > 0 && !exclude.has(activeFightNo)) {
      target = fights.find(f => f.matchNo === activeFightNo) || null;
      if (!target) {
        saWarn(`Node ${nodeId}: committed to fight #${activeFightNo} but card not found`);
        if (saNodeStats[nodeId]) saNodeStats[nodeId] = { ...saNodeStats[nodeId], activeFightNo: 0 };
        refreshUI();
        return 'skipped';
      }
    } else {
      if (activeFightNo > 0 && exclude.has(activeFightNo)) {
        saInfo(`Node ${nodeId}: fight #${activeFightNo} reserved for scheduled nuke — looking for another live fight`);
      }
      const liveFights = fights.filter(f => f.liveBtn && f.status !== 'cleared' && !exclude.has(f.matchNo));
      target = liveFights.find(f => !participatedKeys.has(`${nodeId}:${f.matchNo}`)) || liveFights[0] || null;
    }

    if (!target) {
      saInfo(`Node ${nodeId}: no live fights`);
      if (saNodeStats[nodeId]) saNodeStats[nodeId] = { ...saNodeStats[nodeId], activeFightNo: 0 };
      refreshUI();
      return 'skipped';
    }
    if (target.status === 'cleared') {
      saInfo(`Node ${nodeId}: fight #${target.matchNo} already cleared`);
      const freshAllCleared   = fights.length > 0 && fights.every(f => f.status === 'cleared');
      const freshHasAvailable = fights.some(f => f.liveBtn && f.status !== 'cleared' && !participatedKeys.has(`${nodeId}:${f.matchNo}`));
      if (saNodeStats[nodeId]) {
        saNodeStats[nodeId] = { ...saNodeStats[nodeId], activeFightNo: 0, allCleared: freshAllCleared, hasAvailable: freshHasAvailable };
      }
      delete saLastBattleState[nodeId];
      refreshUI();
      return 'skipped';
    }

    const { matchNo, battleId: cardBattleId } = target;
    const pKey = `${nodeId}:${matchNo}`;

    let battleState = null;
    if (cardBattleId > 0) {
      battleState = await saJoinBattle(String(cardBattleId)).catch(() => null);
    }
    const stillCommitted = !!battleState && saGetEngagedMineCaptains(battleState).length > 0;

    if (battleState?.captains?.length) {
      saLastBattleState[nodeId] = {
        captains: battleState.captains,
        engagements: battleState.engagements || [],
        matchNo,
      };
    }

    if (!fastMode && participatedKeys.has(pKey) && !stillCommitted) {
      saInfo(`Node ${nodeId} fight #${matchNo}: already participated`);
      return 'participated';
    }
    if (!fastMode && participatedKeys.has(pKey) && stillCommitted) {
      saInfo(`Node ${nodeId} fight #${matchNo}: still engaged server-side — recovering`);
    }

    let battleId;
    if (stillCommitted && cardBattleId > 0) {
      battleId = String(cardBattleId);
      saInfo(`Node ${nodeId} fight #${matchNo}: already committed, battle ${battleId}`);
    } else {
      saInfo(`Node ${nodeId} fight #${matchNo}: entering fight…`);
      battleId = await saEnterFight(instanceId, nodeId, matchNo);
      if (!battleId) {
        saWarn(`Node ${nodeId} fight #${matchNo}: could not obtain battle_id`);
        if (saNodeStats[nodeId]) saNodeStats[nodeId] = { ...saNodeStats[nodeId], activeFightNo: 0, hasAvailable: false };
        refreshUI();
        return 'error';
      }
    }

    if (saNodeStats[nodeId]) saNodeStats[nodeId] = { ...saNodeStats[nodeId], activeFightNo: matchNo };
    refreshUI();

    saInfo(`Node ${nodeId} fight #${matchNo}: battle ${battleId} — running combat step…`);
    const result = fastMode
    ? await saExecuteFastRun(battleId, instanceId, nodeId, matchNo, playerName, playerId)
    : await saExecuteOrdinary(battleId, instanceId, nodeId, matchNo, playerName, playerId, participatedKeys.has(pKey));

    if (fastMode) {
      if (result === 'fought') {
        saMarkParticipated(instanceId, nodeId, matchNo); // informational only — fast mode never gates on this
        participatedKeys.add(pKey);
        const updAfter = fights.some(f => f.liveBtn && f.status !== 'cleared' && !participatedKeys.has(`${nodeId}:${f.matchNo}`));
        if (saNodeStats[nodeId]) saNodeStats[nodeId] = { ...saNodeStats[nodeId], activeFightNo: matchNo, hasAvailable: updAfter };
        saInfo(`Node ${nodeId} fight #${matchNo}: nuke assignment sent ✓`);
        refreshUI();
        return 'fought';
      }
      if (result === 'no_captains') {
        if (saNodeStats[nodeId]) saNodeStats[nodeId] = { ...saNodeStats[nodeId], activeFightNo: matchNo };
        saInfo(`Node ${nodeId} fight #${matchNo}: no free captains this cycle — holding, will retry`);
        refreshUI();
        return 'no_captains';
      }
      if (result === 'error') {
        if (saNodeStats[nodeId]) saNodeStats[nodeId] = { ...saNodeStats[nodeId], activeFightNo: 0 };
        saWarn(`Node ${nodeId} fight #${matchNo}: fast run step failed`);
        refreshUI();
        return 'error';
      }
      if (result === 'finished') {
        const matchEnded = saLastBattleState[nodeId]?.matchNo === matchNo && !!saLastBattleState[nodeId]?.matchEnded;
        const updAfter = fights.some(f => f.liveBtn && f.status !== 'cleared' && f.matchNo !== matchNo && !participatedKeys.has(`${nodeId}:${f.matchNo}`));
        const nowAllCleared = matchEnded && fights.filter(f => f.matchNo !== matchNo).every(f => f.status === 'cleared');
        if (saNodeStats[nodeId]) saNodeStats[nodeId] = { ...saNodeStats[nodeId], activeFightNo: 0, hasAvailable: updAfter, allCleared: nowAllCleared };
        delete saLastBattleState[nodeId];
        saInfo(`Node ${nodeId} fight #${matchNo}: battle no longer active`);
        refreshUI();
        return 'skipped';
      }
      if (result === 'captain_dead') {
        await saHealDeadCaptains(`node ${nodeId}: captain KO'd`);
        if (saNodeStats[nodeId]) saNodeStats[nodeId] = { ...saNodeStats[nodeId], activeFightNo: 0, hasAvailable: false };
        delete saLastBattleState[nodeId];
        refreshUI();
        return 'skipped';
      }
    }

    if (result === 'already_fought') {
      participatedKeys.add(pKey);
      const updAfter = fights.some(f => f.liveBtn && f.status !== 'cleared' && !participatedKeys.has(`${nodeId}:${f.matchNo}`));
      const nowAllCleared = fights.length > 0 && fights.every(f => f.status === 'cleared');
      if (saNodeStats[nodeId]) saNodeStats[nodeId] = { ...saNodeStats[nodeId], activeFightNo: 0, hasAvailable: updAfter, allCleared: nowAllCleared };
      saMarkParticipated(instanceId, nodeId, matchNo);
      saInfo(`Node ${nodeId} fight #${matchNo}: already participated — no new action needed`);
      refreshUI();
      return 'participated';
    }
    if (result === 'fought') {
      participatedKeys.add(pKey);
      saMarkParticipated(instanceId, nodeId, matchNo);

      const matchEnded = saLastBattleState[nodeId]?.matchNo === matchNo && !!saLastBattleState[nodeId]?.matchEnded;
      const updAfter = fights.some(f => f.liveBtn && f.status !== 'cleared' && f.matchNo !== matchNo && !participatedKeys.has(`${nodeId}:${f.matchNo}`));
      const nowAllCleared = matchEnded && fights.filter(f => f.matchNo !== matchNo).every(f => f.status === 'cleared');

      if (saNodeStats[nodeId]) {
        saNodeStats[nodeId] = {
          ...saNodeStats[nodeId],
          activeFightNo: matchEnded ? 0 : matchNo,
          hasAvailable: updAfter,
          allCleared: nowAllCleared,
          justFought: true,
          lastFightNo: matchNo,
        };
      }
      saInfo(`Node ${nodeId} fight #${matchNo}: Fought & retreated ✓${matchEnded ? ' (match ended)' : ' (still ongoing)'}`);
      refreshUI();
      return 'fought';
    }
    if (result === 'retreat_pending') {
      saWarn(`Node ${nodeId} fight #${matchNo}: retreat still hasn't confirmed — will retry next cycle`);
      return 'retreat_pending'; // captain genuinely still engaged — leave as-is
    }
    if (result === 'captain_dead') {
      await saHealDeadCaptains(`node ${nodeId}: captain KO'd`);
      if (saNodeStats[nodeId]) saNodeStats[nodeId] = { ...saNodeStats[nodeId], activeFightNo: 0, hasAvailable: false };
      delete saLastBattleState[nodeId];
      refreshUI();
      return 'skipped';
    }
    if (result === 'finished') {
      const matchEnded = saLastBattleState[nodeId]?.matchNo === matchNo && !!saLastBattleState[nodeId]?.matchEnded;
      const updAfter = fights.some(f => f.liveBtn && f.status !== 'cleared' && f.matchNo !== matchNo && !participatedKeys.has(`${nodeId}:${f.matchNo}`));
      const nowAllCleared = matchEnded && fights.filter(f => f.matchNo !== matchNo).every(f => f.status === 'cleared');
      if (saNodeStats[nodeId]) saNodeStats[nodeId] = { ...saNodeStats[nodeId], activeFightNo: 0, hasAvailable: updAfter, allCleared: nowAllCleared };
      delete saLastBattleState[nodeId];
      saInfo(`Node ${nodeId} fight #${matchNo}: battle ended before we could act`);
      refreshUI();
      return 'skipped';
    }
    if (saNodeStats[nodeId]) saNodeStats[nodeId] = { ...saNodeStats[nodeId], activeFightNo: 0 };
    saWarn(`Node ${nodeId} fight #${matchNo}: combat unsuccessful`);
    refreshUI();
    return 'error';
  }

  async function saTick(instanceId, opts = {}) {
    const { immediate = false } = opts;
    if (saBusy) { saWarn('SA tick skipped — already running'); return; }
    saBusy = true;
    saGloballyEngagedCaptainIds.clear();
    for (const state of Object.values(saLastBattleState)) {
      for (const eng of (state?.engagements || [])) {
        saGloballyEngagedCaptainIds.add(Number(eng.attacker_captain_unit_id));
      }
    }
    try {
      const participatedData = saLoadParticipated(instanceId);
      const participatedKeys = new Set(participatedData.keys);
      const { name: playerName, id: playerId } = await getPlayerInfo();
      if (!playerName) { saWarn('Could not detect player name'); return; }
      const available = await saGetAvailableArmyNodes(instanceId);
      saInfo(`Available SA nodes: [${[...available].join(', ')}]`);

      if (immediate) saInfo('First tick — running recovery sweep across all SA nodes');

      const tickSeconds = saNowSeconds();
      const schedOwnedNodes = new Set();
      if (saScheduledNukeEnabled && masterEnabled && !dsIsFastMode() && tickSeconds != null) {
        const preSeconds = tickSeconds;
        for (const item of saGetDueScheduledItems(preSeconds, instanceId)) {
          schedOwnedNodes.add(item.nodeId);
        }
      }

      const _scanOneNode = async nodeId => {
        const isAvailable = available.has(nodeId);
        saLogNodeLockTransition(nodeId, isAvailable);
        if (!isAvailable) { refreshUI(); return 'locked'; }
        if (saNodeStats[nodeId]?.allCleared) { refreshUI(); return 'cleared'; }
        if (schedOwnedNodes.has(nodeId)) {
          saInfo(`Node ${nodeId}: scheduled nuke owns this node this tick — skipping ordinary scan`);
          refreshUI();
          return 'sched_owned';
        }
        try {
          const result = await saScanNode(instanceId, nodeId, playerName, playerId, participatedKeys);
          refreshUI();
          return result;
        } catch (e) {
          saWarn(`Node ${nodeId}: scan threw unexpectedly — ${e.message}`);
          if (saNodeStats[nodeId]?.scanning) {
            saNodeStats[nodeId] = { ...(saNodeStats[nodeId] || {}), scanning: false };
          }
          refreshUI();
          return 'error';
        }
      };
      if (dsIsFastMode()) {
        for (const nodeId of SA_TARGET_NODES) await _scanOneNode(nodeId);
      } else {
        await Promise.all(SA_TARGET_NODES.map(_scanOneNode));
      }
      saAllClearedForNow = saComputeAllCleared();

      if (saScheduledNukeEnabled && masterEnabled && !dsIsFastMode() && tickSeconds != null) {
        const liveSeconds = tickSeconds;
        const due = saGetDueScheduledItems(liveSeconds, instanceId);
        if (due.length) {
          saInfo(`Scheduled nuke: ${due.length} window(s) due — processing…`);
          for (const item of due) {
            if (item !== due[0]) await sleep(SA_NODE_GAP_MS);
            const result = await saRunScheduledNuke(instanceId, item.nodeId, item.matchNo, playerName, playerId, participatedKeys, item.mode);
            if (['already_cleared', 'finished'].includes(result)) {
              saMarkSchedHandled(instanceId, item.key);
            }
          }
          saAllClearedForNow = saComputeAllCleared();
          refreshUI();
        }

      }
    } catch (e) { saErr(`SA tick error: ${e.message}`); }
    finally { saBusy = false; refreshUI(); }
  }

  function saComputeAllCleared() {
    return SA_TARGET_NODES.every(nid => !!saNodeStats[nid] && saNodeStats[nid].allCleared);
  }

  function pveDefaultProfile(mode = 'normal') {
    return {
      damageMode: 'monster',
      fixedDamageCap: 0,
      monsterCaps: {},
      damageModel: mode === 'fast' ? 'fast' : 'eco', // 'eco' = stamina-safe, 'fast' = fewest hits
      useStaminaPotion: false,
      staminaPotionExpCap: mode === 'fast' ? 100 : 93.5,
      useHpPotion: false,
      selectedMobsByNode: {},
      nodeSchedules: mode === 'normal' ? {} : undefined,
    };
  }
  function pveDefaultProfiles() { return { normal: pveDefaultProfile('normal'), fast: pveDefaultProfile('fast') }; }
  function pveLoadProfiles() {
    try {
      const raw = localStorage.getItem(PVE_PROFILE_KEY);
      if (!raw) return pveDefaultProfiles();
      const parsed = JSON.parse(raw);
      return {
        normal: { ...pveDefaultProfile('normal'), ...(parsed.normal || {}) },
        fast:   { ...pveDefaultProfile('fast'),   ...(parsed.fast   || {}) },
      };
    } catch { return pveDefaultProfiles(); }
  }
  function pveSaveProfiles(profiles) {
    try {
      dsSafeSetItem(PVE_PROFILE_KEY, JSON.stringify(profiles));
    } catch (e) {
      console.warn('[PvE] saving profiles failed:', e);
    }
  }

  function pveActiveProfileKey() { return dsIsFastMode() ? 'fast' : 'normal'; }
  function pveGetProfile() { return pveLoadProfiles()[pveActiveProfileKey()]; }
  function pveUpdateProfile(mutator, { resetActionable = false, resetActionableNodeId = null } = {}) {
    const profiles = pveLoadProfiles();
    mutator(profiles[pveActiveProfileKey()]);
    pveSaveProfiles(profiles);
    if (resetActionableNodeId != null) {
      if (pveNodeStats[resetActionableNodeId]) pveNodeStats[resetActionableNodeId].noActionable = false;
    } else if (resetActionable) {
      for (const k of Object.keys(pveNodeStats)) {
        if (pveNodeStats[k]) pveNodeStats[k].noActionable = false;
      }
    }
    refreshUI();
  }

  function pveCopyProfileFromOtherMode() {
    const profiles = pveLoadProfiles();
    const current  = pveActiveProfileKey();
    const other    = current === 'fast' ? 'normal' : 'fast';
    const keepDamageMode = profiles[current].damageMode; // mode is per-profile on purpose — never copied
    const copied = JSON.parse(JSON.stringify(profiles[other]));
    copied.damageMode = keepDamageMode;
    profiles[current] = copied;
    pveSaveProfiles(profiles);
    for (const k of Object.keys(pveNodeStats)) {
      if (pveNodeStats[k]) pveNodeStats[k].noActionable = false;
    }
    refreshUI();
    pveInfo(`Copied PvE settings from ${other === 'fast' ? 'Fast Run' : 'Normal'} mode (kept current damage mode: ${keepDamageMode})`);
  }

  function pveMobStateStorageKey(instanceId) { return PVE_MOB_STATE_KEY_PREFIX + instanceId; }

  function pveLoadMobStateForInstance(instanceId) {
    if (pveMobStateInstanceId === instanceId) return; // already loaded for this instance
    pveMobStateInstanceId = instanceId;
    pveMobState = new Map();
    try {
      const raw = localStorage.getItem(pveMobStateStorageKey(instanceId));
      if (raw) for (const [dgmid, entry] of Object.entries(JSON.parse(raw))) pveMobState.set(dgmid, entry);
    } catch { /* start fresh on any parse error */ }
  }

  function pveSaveMobStateNow() {
    if (!pveMobStateInstanceId) return;
    const obj = {};
    for (const [dgmid, entry] of pveMobState.entries()) obj[dgmid] = entry;
    dsSafeSetItem(pveMobStateStorageKey(pveMobStateInstanceId), JSON.stringify(obj));
  }
  function pveSaveMobStateSoon() {
    if (pveMobStateSaveTimer) return;
    pveMobStateSaveTimer = setTimeout(() => { pveMobStateSaveTimer = 0; pveSaveMobStateNow(); }, 400);
  }

  function pveHasMobState(dgmid) { return pveMobState.has(String(dgmid)); }
  function pveGetMobState(dgmid) { return pveMobState.get(String(dgmid)) || null; }
  function pveSetMobState(dgmid, patch) {
    const key = String(dgmid);
    pveMobState.set(key, { ...(pveMobState.get(key) || {}), ...patch });
    pveSaveMobStateSoon();
  }

  async function pveBootstrapMobState(instanceId, dgmid, name, nodeId, force = false) {
    if (!force && pveHasMobState(dgmid)) return pveGetMobState(dgmid);
    const doc = await fetchDoc(
      `${PVE_BATTLE_BASE}?dgmid=${dgmid}&instance_id=${instanceId}`,
      'pve bootstrap'
    );
    if (!doc) {
      if (pveHasMobState(dgmid)) return pveGetMobState(dgmid);
      return null;
    }
    // FIX (a): a login / error page that has markup is not a battle page - storing "damage 0, no cap" for it would
    // persist "no EXP cap" in localStorage. Keep any old state, otherwise store nothing and retry next scan.
    if (!doc.querySelector('#yourStats, #yourDamageValue, #hpText, .stat-block')) {
      pveWarn(`Bootstrap: ${name || dgmid} - page did not look like a battle page (login/error?) - not storing state`);
      return pveHasMobState(dgmid) ? pveGetMobState(dgmid) : null;
    }

    let expCap = null, damage = 0, lootCap = null, monsterMaxHp = null;
    if (doc) {
      const block = [...doc.querySelectorAll('.stat-block')]
      .find(b => normText(b.querySelector('.label')?.textContent) === 'exp cap');
      const capM = block?.querySelector('div')?.textContent.match(/([\d,]+)/);
      if (capM) {
        const parsed = Number(capM[1].replace(/,/g, ''));
        expCap = parsed > 0 ? parsed : null;
      }
      const dmgTxt = doc.querySelector('#yourDamageValue')?.textContent;
      if (dmgTxt) damage = Number(dmgTxt.replace(/[^\d]/g, '')) || 0;
      lootCap = pveParseLootRequirements(doc);

      const maxHpAttr = doc.querySelector('#yourStats')?.getAttribute('data-maxhp');
      if (maxHpAttr) monsterMaxHp = Number(maxHpAttr) || null;
      if (!monsterMaxHp) {
        const hpM = (doc.querySelector('#hpText')?.textContent || '').match(/([\d,]+)\s*\/\s*([\d,]+)/);
        if (hpM) monsterMaxHp = Number(hpM[2].replace(/,/g, '')) || null;
      }
    }
    const isNew = !pveHasMobState(dgmid);
    const entry = { damage, expCap, name, nodeId };
    if (lootCap !== null)      entry.lootCap = lootCap;
    if (monsterMaxHp !== null) entry.monsterMaxHp = monsterMaxHp;
    pveSetMobState(dgmid, entry);
    if (isNew) {
      const capLabel  = expCap  !== null ? String(expCap)  : 'none';
      const lootLabel = lootCap !== null ? String(lootCap) : 'none';
      pveInfo(`Bootstrap: ${name} (${dgmid}) — exp cap ${capLabel}, loot cap ${lootLabel}, existing damage ${damage}${monsterMaxHp ? `, mob HP ${monsterMaxHp.toLocaleString()}` : ''}`);
    }
    return entry;
  }

  function saPruneOldParticipatedKeys(keepInstanceIds) {
    const keep = new Set(keepInstanceIds.map(String));
    const all = saLoadAllParticipated();
    let changed = false;
    for (const instId of Object.keys(all)) {
      if (!keep.has(instId)) { delete all[instId]; changed = true; }
    }
    if (changed) {
      dsSafeSetItem(SA_PARTICIPATED_KEY, JSON.stringify(all));
      saInfo(`Pruned old SA participation records — kept last ${keep.size} instance(s)`);
    }
  }

  function pvePruneOldAttackDmgKeys(keepInstanceIds) {
    const keep = new Set(keepInstanceIds.map(String));
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(PVE_ATTACK_DMG_KEY_PREFIX)) continue;
      const instId = key.slice(PVE_ATTACK_DMG_KEY_PREFIX.length);
      if (!keep.has(instId)) toRemove.push(key);
    }
    toRemove.forEach(k => localStorage.removeItem(k));
    if (toRemove.length) pveInfo(`Pruned ${toRemove.length} stale attack-dmg cache(s) from old dungeon instance(s)`);
  }

  function pveParseLootRequirements(doc) {
    let maxReq = 0;
    for (const chip of doc.querySelectorAll('.loot-card .chip')) {
      const m = normText(chip.textContent).match(/dmg req:\s*([\d,]+)/i);
      if (!m) continue;
      const val = Number(m[1].replace(/,/g, ''));
      if (val > maxReq) maxReq = val;
    }
    return maxReq > 0 ? maxReq : null;
  }

  function pveGetEffectiveCap(profile, name, mobEntry) {
    if (profile.damageMode === 'scheduled') {
      const nodeId   = mobEntry?.nodeId;
      const schedule = profile.nodeSchedules?.[nodeId];
      if (!schedule?.length) return 0; // no breakpoints configured — skip, don't guess

      const timed         = schedule.filter(e => !e.noTime);
      const fallbackEntry = schedule.find(e => e.noTime) || null;

      const now   = saNowSeconds();
      const entry = dsGetActiveScheduleEntry(timed, now, fallbackEntry);

      if (!entry) {
        return 0;
      }
      if (entry.mode === 'skip') return 0;
      if (entry.mode === 'fixed')   return entry.fixedCap > 0 ? entry.fixedCap : null;
      if (entry.mode === 'loot')    return mobEntry?.lootCap ?? null;
      if (entry.mode === 'monster') {
        const table = entry.monsterCaps || profile.monsterCaps;
        const v = table[normText(name)];
        return typeof v === 'number' ? v : 0;
      }
      return mobEntry?.expCap ?? null; // 'exp' — only reached via a breakpoint the operator explicitly set to this mode
    }
    if (profile.damageMode === 'fixed') return profile.fixedDamageCap > 0 ? profile.fixedDamageCap : null;
    if (profile.damageMode === 'loot') {
      return mobEntry?.lootCap ?? null;
    }
    if (profile.damageMode === 'monster') {
      const v = profile.monsterCaps[normText(name)];
      return typeof v === 'number' ? v : 0;
    }
    return mobEntry?.expCap ?? null; // 'exp' mode
  }

  function pveIsMobCapped(dgmid, profile, name) {
    const entry = pveGetMobState(dgmid);
    if (!entry) return false; // never bootstrapped → can't prove capped, treat as active
    const cap = pveGetEffectiveCap(profile, name, entry);
    if (typeof cap !== 'number' || cap <= 0) return false;  // 0 = skip, not "capped"
    return entry.damage >= cap;
  }

  async function pveRunWithLimit(items, limit, worker) {
    let i = 0;
    const runners = Array(Math.min(limit, items.length)).fill(0).map(async () => {
      while (i < items.length) {
        const item = items[i++];
        try { await worker(item); } catch (e) { pveWarn(`Bootstrap failed for ${item.name || item.dgmid}: ${e.message}`); }
      }
    });
    await Promise.all(runners);
  }

  async function pveGetAvailableNodes(instanceId) {
    const cubeState = await getCubeState(instanceId);
    if (!cubeState?.nodes?.length) {
      pveWarn('Could not read cube STATE nodes; trying all PvE target nodes');
      return new Set(PVE_TARGET_NODES);
    }
    const available = new Set();
    for (const node of cubeState.nodes) {
      const nodeId = Number(node.id);
      if (!PVE_TARGET_NODES.includes(nodeId)) continue;
      if (node.status === 'hidden' || node.status === 'locked') continue;
      if (!node.is_revealed) continue;
      available.add(nodeId);
    }
    return available;
  }

  function pveLocationIdFor(nodeId) {
    const nodes = cubeStateCache?.data?.nodes;
    const n = Array.isArray(nodes) ? nodes.find(x => Number(x.id) === Number(nodeId)) : null;
    const linked = Number(n?.linked_location_id);
    return linked > 0 ? linked : PVE_NODE_TO_LOCATION[nodeId];
  }

  function pveLogNodeLockTransition(nodeId, isAvailable) {
    if (!isAvailable && !pveLockedNodesLogged.has(nodeId)) {
      pveLockedNodesLogged.add(nodeId);
      pveInfo(`Node ${nodeId}: is still locked/hidden`);
    } else if (isAvailable && pveLockedNodesLogged.has(nodeId)) {
      pveLockedNodesLogged.delete(nodeId);
      pveInfo(`Node ${nodeId}: now available`);
    }
  }

  async function pveFetchLocationPage(instanceId, locationId) {
    const url = `${PVE_LOCATION_BASE}?instance_id=${instanceId}&location_id=${locationId}`;
    const doc = await fetchDoc(url, `pve location ${locationId}`);
    if (!doc) return { mobs: [], stamina: null, failed: true, looksValid: false };

    const mobs = [];
    const seen = new Set();

    for (const link of doc.querySelectorAll('a.btn[href*="battle.php"][href*="dgmid="]')) {
      const href = link.getAttribute('href') || '';
      const match = href.match(/[?&]dgmid=(\d+)/);
      if (!match) continue;

      const dgmid = match[1];
      if (seen.has(dgmid)) continue;
      seen.add(dgmid);

      const container = link.closest('.mon') || link.closest('div[style*="flex"]') || link.parentElement?.parentElement;

      const isDead = [...(container?.querySelectorAll('.pill') || [])]
      .some(p => normText(p.textContent) === 'dead');

      let name = '';
      const nameDiv = container?.querySelector('div[style*="font-weight:700"]');

      if (nameDiv) {
        name = [...nameDiv.childNodes]
          .filter(n => n.nodeType === Node.TEXT_NODE)
          .map(n => n.textContent.trim())
          .filter(Boolean)
          .join(' ')
          .trim();
      }

      mobs.push({
        dgmid,
        name: name || dgmid,
        isDead,
      });
    }
    const staminaTxt = doc.querySelector('#stamina_span')?.textContent || '';
    const stamina = parseInt(staminaTxt.replace(/[^\d]/g, ''), 10);
    return { mobs, stamina: Number.isFinite(stamina) ? stamina : null, failed: false, looksValid: !!doc.querySelector('#stamina_span') };
  }

  function pveFilterSelectedMobs(mobs, nodeId, profile) {
    const hasKey   = Object.prototype.hasOwnProperty.call(profile.selectedMobsByNode, nodeId);
    const selected = profile.selectedMobsByNode[nodeId];
    if (!hasKey) {
      return profile.damageMode === 'monster' ? [] : mobs;
    }
    const set = new Set(selected || []);
    return mobs.filter(m => set.has(normText(m.name)));
  }

  async function pveJoinMonster(instanceId, dgmid) {
    const body = new URLSearchParams({ dgmid: String(dgmid), instance_id: String(instanceId) });
    const { ok, text } = await fetchText(PVE_JOIN_URL, {
      idempotent: true,   // FIX2: the server answers "already joined", so a repeat is harmless
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: body.toString(),
    });
    if (!ok) return { joined: false, reason: 'request failed' };
    const t = text.toLowerCase();
    if (t.includes('success') || t.includes('already')) return { joined: true, reason: '' };
    return { joined: false, reason: text.trim().slice(0, 160) || 'unknown response' };
  }

  async function pveAttackMonster(instanceId, dgmid, atk) {
    const body = new URLSearchParams({
      dgmid: String(dgmid), instance_id: String(instanceId),
      skill_id: String(atk.skill), stamina_cost: String(atk.stamina),
    });
    const { data, text } = await fetchJson(PVE_ATTACK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: body.toString(),
    });
    return data || { status: 'error', message: text || 'no response body' };
  }

  // FIX: the Battle Consumables sidebar (#battleDrawer .potion-card[data-inv-id]) already carries the inventory id, so read
  // it from the live page when it is there and remember it (dropped again if using it fails); inventory.php is only the fallback.
  const pvePotionInvIds = new Map();
  function pveInvIdFromDrawer(target) {
    for (const card of document.querySelectorAll('.potion-card[data-inv-id]'))
      if (normText(card.querySelector('img')?.alt) === target) return card.getAttribute('data-inv-id');
    return null;
  }
  async function pveFindPotionInvId(name) {
    const target = normText(name);
    const known = pvePotionInvIds.get(target) || pveInvIdFromDrawer(target);
    if (known) { pvePotionInvIds.set(target, known); return known; }
    const doc = await fetchDoc(PVE_INVENTORY_URL, 'pve potion lookup');
    if (!doc) return null;
    for (const slot of doc.querySelectorAll('.slot-box')) {
      const alt = normText(slot.querySelector('img')?.alt);
      if (alt !== target) continue;

      const btn = [...slot.querySelectorAll('button')].find(b =>
                                                            /useItem\(/i.test(b.getAttribute('onclick') || '')
                                                           );
      const onclick = btn?.getAttribute('onclick') || '';
      const m = onclick.match(/useItem\(\s*([0-9]+)/i);
      if (m) { pvePotionInvIds.set(target, m[1]); return m[1]; }
    }
    for (const card of doc.querySelectorAll('.potion-card')) {
      const alt = normText(card.querySelector('img')?.alt);
      if (alt !== target) continue;
      const invId = card.getAttribute('data-inv-id');
      if (invId) { pvePotionInvIds.set(target, invId); return invId; }
    }
    return null;
  }

  async function pveUseLargeStaminaPotion() {
    const invId = await pveFindPotionInvId('Large Stamina Potion');
    if (!invId) { pveWarn('No Large Stamina Potion available'); return false; }
    const used = await fetchText(PVE_USE_ITEM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: new URLSearchParams({ inv_id: invId }).toString(),
    });
    if (!used.ok) { pvePotionInvIds.delete(normText('Large Stamina Potion')); pveWarn('Large Stamina Potion request failed - not counting it as used'); return false; }
    await sleep(100);
    pveInfo('Used a Large Stamina Potion');
    return true;
  }

  async function pveUseFullHpPotion() {
    const { id: playerId } = await getPlayerInfo();
    if (!playerId) { pveWarn('Could not resolve player id for heal potion'); return false; }
    const { ok, data } = await fetchJson(PVE_HEAL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: new URLSearchParams({ user_id: playerId }).toString(),
    });
    if (!ok || String(data?.status || '').trim() !== 'success') {
      pveWarn(`Heal potion failed — ${data?.message || 'no response'}`);
      return false;
    }
    pveInfo(data?.message || 'Used a Full HP Potion');
    await sleep(100); // short buffer so the heal registers server-side before the next attack
    return true;
  }

  function getExpPercent() {
    const e = Core.me.get().exp;   // last values seen if the top bar is not on screen
    return e && e.max ? (e.cur / e.max) * 100 : 0;
  }

  function pveDowngradeAttack(attackId, staminaAvailable) {
    const ordered  = [...PVE_ATTACKS].sort((a, b) => b.stamina - a.stamina);
    const idx      = ordered.findIndex(a => a.id === attackId);
    const sequence = idx === -1 ? ordered : ordered.slice(idx);
    return sequence.find(a => a.stamina <= staminaAvailable) || null;
  }

  function pveAttackDmgStorageKey(instanceId) {
    return PVE_ATTACK_DMG_KEY_PREFIX + instanceId;
  }

  function pveLoadAttackDamageHistory(instanceId) {
    try { return JSON.parse(localStorage.getItem(pveAttackDmgStorageKey(instanceId))) || {}; }
    catch { return {}; }
  }

  function pveSaveAttackDamageHistory(instanceId, map) {
    try {
      dsSafeSetItem(pveAttackDmgStorageKey(instanceId), JSON.stringify(map));
    } catch (e) {
      const keys = Object.keys(map);
      keys.slice(0, Math.ceil(keys.length / 2) || 1).forEach(k => delete map[k]);
      try {
        dsSafeSetItem(pveAttackDmgStorageKey(instanceId), JSON.stringify(map));
      } catch (e2) {
        console.warn('[PvE] attack-dmg history still too large after pruning:', e2);
      }
    }
  }

  function pveRecordAttackDamage(instanceId, monsterName, attackId, dmg) {
    if (!(dmg > 0)) return;
    const key  = normText(monsterName) || '__unknown__';
    const map  = pveLoadAttackDamageHistory(instanceId);
    const node = map[key] || (map[key] = {});
    const hist = node[attackId] || (node[attackId] = []);
    hist.push(dmg);
    if (hist.length > PVE_DMG_HISTORY_MAX) hist.shift();
    pveSaveAttackDamageHistory(instanceId, map);
  }

  function pveConservativeEstimate(hist) {
    if (!hist || !hist.length) return null;
    const sorted0 = [...hist].sort((a, b) => a - b);
    const median  = sorted0[Math.floor(sorted0.length / 2)];
    const trimmed = median > 0 ? hist.filter(v => v >= median * PVE_OUTLIER_LOW_MULT && v <= median * PVE_OUTLIER_MULT) : [...hist];
    const pool    = (trimmed.length ? trimmed : hist).sort((a, b) => a - b);
    const keepN   = Math.max(1, Math.ceil(pool.length * PVE_KEEP_FRACTION));
    const bottom  = pool.slice(0, keepN);
    return bottom.reduce((s, v) => s + v, 0) / bottom.length;
  }

  function pveEstimatedDamage(instanceId, monsterName, attackId) {
    const key  = normText(monsterName) || '__unknown__';
    const hist = pveLoadAttackDamageHistory(instanceId)[key]?.[attackId];
    return pveConservativeEstimate(hist);
  }

  function pvePickAttackBlindFallback(instanceId, monsterName, preferredId, staminaAvailable) {
    const key   = normText(monsterName) || '__unknown__';
    const hist  = pveLoadAttackDamageHistory(instanceId)[key] || {};
    const known = PVE_ATTACKS.filter(a => a.stamina <= staminaAvailable && hist[a.id]?.length);
    if (known.length) return known.sort((a, b) => b.stamina - a.stamina)[0];
    return pveDowngradeAttack(preferredId, staminaAvailable);
  }

  function pvePickAttackFast(instanceId, monsterName, preferredId, staminaAvailable, remaining) {
    const fallback = pveDowngradeAttack(preferredId, staminaAvailable);
    if (typeof remaining !== 'number' || remaining <= 0)
      return pvePickAttackBlindFallback(instanceId, monsterName, preferredId, staminaAvailable);

    const knownRates = PVE_ATTACKS
    .map(a => {
      const est = pveEstimatedDamage(instanceId, monsterName, a.id);
      return (est != null && est > 0) ? est / a.stamina : null;
    })
    .filter(r => r != null);
    if (!knownRates.length) return fallback;

    const sorted   = [...knownRates].sort((a, b) => a - b);
    const baseRate = sorted[Math.floor(sorted.length / 2)];

    const affordable = PVE_ATTACKS
    .filter(a => a.stamina <= staminaAvailable)
    .map(a => {
      const direct = pveEstimatedDamage(instanceId, monsterName, a.id);
      const est = (direct != null && direct > 0) ? direct : baseRate * a.stamina;
      return { ...a, est };
    })
    .filter(a => a.est > 0);
    if (!affordable.length) return fallback;

    const MAX_SINGLE_OVERSHOOT = 1.5;
    const scored = affordable.map(a => {
      const hits = Math.ceil(remaining / a.est);
      const effectiveHits = hits === 1 && a.est > remaining * MAX_SINGLE_OVERSHOOT ? 2 : hits;
      return { ...a, hits, effectiveHits };
    });
    const minEffective = Math.min(...scored.map(a => a.effectiveHits));
    const best = scored
    .filter(a => a.effectiveHits === minEffective)
    .sort((a, b) => a.stamina - b.stamina)[0];
    return best ?? fallback;
  }

  function pvePickAttackConservative(instanceId, monsterName, preferredId, staminaAvailable, remaining) {
    const fallback = pveDowngradeAttack(preferredId, staminaAvailable);
    if (typeof remaining !== 'number' || remaining <= 0) return pvePickAttackBlindFallback(instanceId, monsterName, preferredId, staminaAvailable);

    const histKey = normText(monsterName) || '__unknown__';
    const monsterHist = pveLoadAttackDamageHistory(instanceId)[histKey] || {};

    const withCeil = PVE_ATTACKS
    .filter(a => a.stamina <= staminaAvailable)
    .map(a => {
      const hist = monsterHist[a.id];
      const ceil = (hist && hist.length) ? Math.max(...hist) : null;
      return { ...a, ceil, proven: ceil != null };
    });

    const provenRates = withCeil
    .filter(a => a.proven && a.stamina > 0)
    .map(a => a.ceil / a.stamina);
    const worstRate = provenRates.length ? Math.max(...provenRates) : null;

    const withEstimate = withCeil.map(a =>
                                      a.proven ? a : { ...a, ceil: worstRate != null ? worstRate * a.stamina : null, proven: false }
                                     );

    const fits = withEstimate
    .filter(a => a.ceil != null && a.ceil <= remaining)
    .sort((a, b) => b.stamina - a.stamina);
    if (fits.length) return fits[0];

    const anyKnown = withEstimate.filter(a => a.ceil != null).sort((a, b) => a.stamina - b.stamina);
    if (anyKnown.length) return anyKnown[0];

    return fallback;
  }

  function pvePickAttack(instanceId, monsterName, preferredId, staminaAvailable, remaining, damageModel) {
    return damageModel === 'fast'
      ? pvePickAttackFast(instanceId, monsterName, preferredId, staminaAvailable, remaining)
    : pvePickAttackConservative(instanceId, monsterName, preferredId, staminaAvailable, remaining);
  }

  function updateStam(staminaValue) {
    const span = document.getElementById("stamina_span");
    if (!span) return;
    span.textContent = staminaValue.toLocaleString();
  }

  function updateExp(xpDelta) {
    if (!xpDelta) return;
    const expWrap = document.querySelector(".gtb-exp");
    if (!expWrap) return;
    const topText = expWrap.querySelector(".gtb-exp-top span:last-child");
    const fill = expWrap.querySelector(".gtb-exp-fill");
    if (!topText || !fill) return;
    const match = topText.textContent.match(/([\d,]+)\s*\/\s*([\d,]+)/);
    if (!match) return;
    let current = parseInt(match[1].replace(/,/g, ""), 10);
    const max = parseInt(match[2].replace(/,/g, ""), 10);
    if (!max || max <= 0) return;
    current += xpDelta;
    if (current >= max) {
      current = current - max;
    }
    const percent = (current / max) * 100;
    topText.textContent =
      `${current.toLocaleString()} / ${max.toLocaleString()}`;
    fill.style.width = percent.toFixed(2) + "%";
  }

  async function pveFightMonster(instanceId, dgmid, mobName, profile, knownStamina, effectiveCap, baselineDamage) {
    let stamina = knownStamina ?? Infinity;
    let myDamage = baselineDamage;
    let lastDamage = -1;

    let potionPending = false;   // FIX2: a potion was just used and no attack has landed since
    let hpPotionPending = false; // FIX: an HP potion was just used and no attack has landed since
    let hasRealCap = typeof effectiveCap === 'number' && effectiveCap > 0;
    const mobMaxHp = pveGetMobState(dgmid)?.monsterMaxHp;
    const capText = () => hasRealCap
    ? effectiveCap.toLocaleString()
    : (mobMaxHp ? `${mobMaxHp.toLocaleString()} (mob HP)` : '∞');
    let capStr = capText();

    pveInfo(`${mobName || dgmid}: starting fight — damage ${myDamage.toLocaleString()}/${capStr}`);

    if (hasRealCap && myDamage >= effectiveCap) {
      pveInfo(`${mobName || dgmid}: already at cap (${myDamage.toLocaleString()}/${capStr}) — skipping`);
      return { result: 'capped', staminaAfter: stamina };
    }

    while (true) {
      if (!masterEnabled) {
        pveInfo(`${mobName || dgmid}: automation paused — stopping mid-fight`);
        return { result: 'paused', staminaAfter: stamina };
      }
      // FIX (c): another tab took over - stop instead of attacking in parallel with the new main tab
      if (!dsTabIsMain) {
        pveInfo(`${mobName || dgmid}: this tab is no longer the main tab — stopping mid-fight`);
        return { result: 'paused', staminaAfter: stamina };
      }
      // FIX (b): re-read profile + cap before every attack, so a settings edit or schedule breakpoint applies mid-fight
      {
        profile = pveGetProfile();
        const liveCap = pveGetEffectiveCap(profile, mobName, pveGetMobState(dgmid));
        if (liveCap !== effectiveCap) {
          effectiveCap = liveCap;
          hasRealCap = typeof effectiveCap === 'number' && effectiveCap > 0;
          capStr = capText();
          pveInfo(`${mobName || dgmid}: cap changed mid-fight — now ${hasRealCap ? capStr : liveCap === 0 ? 'skip' : 'none'}`);
          if (liveCap === 0) return { result: 'skipped', staminaAfter: stamina };
          if (hasRealCap && myDamage >= effectiveCap) {
            pveInfo(`${mobName || dgmid}: already at the new cap (${myDamage.toLocaleString()}/${capStr}) — stopping`);
            return { result: 'capped', staminaAfter: stamina };
          }
        }
      }
      const capRemaining = hasRealCap ? (effectiveCap - myDamage) : null;
      const hpRemaining  = (typeof mobMaxHp === 'number' && mobMaxHp > 0) ? Math.max(0, mobMaxHp - myDamage) : null;
      const remaining = [capRemaining, hpRemaining]
      .filter(v => typeof v === 'number')
      .sort((a, b) => a - b)[0] ?? null;
      const atk = pvePickAttack(instanceId, mobName, PVE_STARTING_ATTACK_ID, stamina, remaining, profile.damageModel);
      if (!atk) {
        if (profile.useStaminaPotion) {
          const expPct = getExpPercent();
          if (expPct < (profile.staminaPotionExpCap ?? 100)) {
            if (await pveUseLargeStaminaPotion()) { stamina = Infinity; potionPending = true; continue; }
          } else {
            pveInfo(`${mobName || dgmid}: skipping stamina potion — EXP at ${expPct.toFixed(1)}% (cap ${profile.staminaPotionExpCap}%), letting level-up refill instead`);
          }
        }
        return { result: 'no_stamina', staminaAfter: stamina };
      }
      const result = await pveAttackMonster(instanceId, dgmid, atk);
      if (typeof result.stamina === 'number') {
        stamina = result.stamina;
        updateStam(stamina);
      }
      if (typeof result.xp_delta === "number") {
        updateExp(result.xp_delta);
      }
      const msg = normText(result.message);
      if (msg.includes('not enough stamina')) {
        if (potionPending) { pveWarn(`${mobName || dgmid}: stamina potion did not restore stamina - stopping`); return { result: 'no_stamina', staminaAfter: 0 }; }
        stamina = atk.stamina - 1;
        continue;
      }
      if (msg.includes('already dead')) {
        pveInfo(`${mobName || dgmid}: already dead`);
        return { result: 'killed', staminaAfter: stamina };
      }
      if (msg.includes('you are dead')) {
        pveWarn(`${mobName || dgmid}: you died`);
        // FIX: one potion per death - if we die again before any attack lands, stop instead of burning potions in a loop
        if (profile.useHpPotion && !hpPotionPending && await pveUseFullHpPotion()) {
          hpPotionPending = true;
          continue;
        }
        return { result: 'player_dead', staminaAfter: stamina };
      }
      if (result.status !== 'success') {
        pveWarn(`${mobName || dgmid}: unexpected response — ${result.message || 'no message'}`);
        pveSessionVerified.delete(dgmid);
        return { result: 'error', staminaAfter: stamina };
      }
      potionPending = false;
      hpPotionPending = false;
      lastDamage = myDamage;
      const reported = result.totaldmgdealt == null ? NaN : Number(result.totaldmgdealt);
      const haveTotal = Number.isFinite(reported);
      myDamage = haveTotal ? reported : lastDamage;
      const delta = myDamage - lastDamage;
      pveInfo(`${mobName || dgmid}: ${atk.label} → +${delta} dmg (total ${myDamage}/${capStr}, stamina ${stamina})`);
      if (haveTotal) {
        pveSetMobState(dgmid, { damage: myDamage });
        if (delta > 0) pveRecordAttackDamage(instanceId, mobName, atk.id, delta);
      }
      if (hasRealCap && myDamage >= effectiveCap) {
        pveInfo(`${mobName || dgmid}: reached cap (${myDamage.toLocaleString()}/${capStr}) — stopping`);
        return { result: 'capped', staminaAfter: stamina };
      }
      if (myDamage <= lastDamage) {
        pveInfo(`${mobName || dgmid}: damage stopped climbing — killed`);
        return { result: 'killed', staminaAfter: stamina };
      }
    }
  }

  // FIX (d): Scheduled mode before the first breakpoint fights nothing (by design). Returns "HH:MM" of the first
  // breakpoint while waiting for it, else null - shown on the node pill and logged once.
  const pveSchedWaitLogged = new Set();
  function pveSchedWaitUntil(profile, nodeId) {
    if (profile.damageMode !== 'scheduled') return null;
    const sch = profile.nodeSchedules?.[nodeId] || [];
    const timed = sch.filter(e => !e.noTime), now = saNowSeconds();
    if (!timed.length || now == null || dsGetActiveScheduleEntry(timed, now, sch.find(e => e.noTime) || null)) return null;
    const s = Math.min(...timed.map(dsScheduleEntrySeconds));
    return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
  }

  async function pveScanNode(instanceId, nodeId, locationId, profile, { fight }) {
    if (pveNodeStats[nodeId]?.attacking) {
      pveNodeStats[nodeId] = { ...pveNodeStats[nodeId], attacking: null };
    }
    const page = await pveFetchLocationPage(instanceId, locationId);
    if (page.failed || (!page.mobs.length && !page.looksValid)) {
      pveWarn(`Node ${nodeId}: location page ${page.failed ? 'fetch failed' : 'did not look like a location page'} - leaving node state untouched, will retry`);
      return;
    }
    const { mobs, stamina } = page;

    const discovered = pveDiscoveredMobsByNode[nodeId] || (pveDiscoveredMobsByNode[nodeId] = new Map());
    mobs.forEach(m => { if (m.name) discovered.set(normText(m.name), m.name); });

    {
      const persisted = pveLoadDiscovered();
      const everSeen  = new Set(persisted[nodeId] || []);
      const newKeys   = mobs.map(m => normText(m.name)).filter(k => k && !everSeen.has(k));
      if (newKeys.length) {
        newKeys.forEach(k => everSeen.add(k));
        persisted[nodeId] = [...everSeen];
        pveSaveDiscovered(persisted);

        pveUpdateProfile(p => {
          const list = new Set(p.selectedMobsByNode[nodeId] || []);
          newKeys.forEach(k => list.add(k));
          p.selectedMobsByNode[nodeId] = [...list];
        });
        profile.selectedMobsByNode[nodeId] = [...new Set([...(profile.selectedMobsByNode[nodeId] || []), ...newKeys])];
      }
    }

    const targets = pveFilterSelectedMobs(mobs, nodeId, profile);

    pveDeadMobsByNode[nodeId] = new Set(mobs.filter(m => m.isDead).map(m => m.dgmid));

    const nameGroups = new Map(); // name -> { total, dead }
    for (const m of mobs) {
      const key = normText(m.name);
      const g = nameGroups.get(key) || { total: 0, dead: 0 };
      g.total++;
      if (m.isDead) g.dead++;
      nameGroups.set(key, g);
    }
    pveDeadNamesByNode[nodeId] = new Set(
      [...nameGroups.entries()].filter(([, g]) => g.dead === g.total).map(([k]) => k)
    );

    const aliveMobs = mobs.filter(m => !m.isDead);
    const allClear  = aliveMobs.length === 0 && mobs.length > 0
    ? true          // every mob on page is dead
    : mobs.length === 0; // page has no mobs at all
    const schedWait = pveSchedWaitUntil(profile, nodeId);
    pveNodeStats[nodeId] = { ...(pveNodeStats[nodeId] || {}), mobCount: mobs.length, allClear, schedWait };
    if (schedWait && aliveMobs.length && !pveSchedWaitLogged.has(`${nodeId}@${schedWait}`)) {
      pveSchedWaitLogged.add(`${nodeId}@${schedWait}`);
      pveInfo(`Node ${nodeId}: Scheduled mode — no breakpoint is active yet, nothing is fought here until ${schedWait} (add a "no time" row to fight earlier)`);
    }
    refreshUI();

    const unseenAll = mobs.filter(m => !pveHasMobState(m.dgmid));
    if (unseenAll.length) {
      await pveRunWithLimit(unseenAll, PVE_BOOTSTRAP_CONCURRENCY,
                            m => pveBootstrapMobState(instanceId, m.dgmid, m.name, nodeId));
    }

    if (allClear) return; // nothing left to fight, but bootstrap already ran above

    if (!targets.length) { pveNodeStats[nodeId].noActionable = true; return; }

    const toVerify = targets.filter(
      m => pveHasMobState(m.dgmid) &&
      !pveSessionVerified.has(m.dgmid) &&
      (pveGetMobState(m.dgmid)?.damage ?? 0) > 0
    );
    if (toVerify.length) {
      await pveRunWithLimit(toVerify, PVE_BOOTSTRAP_CONCURRENCY,
                            m => pveBootstrapMobState(instanceId, m.dgmid, m.name, nodeId, true));
      toVerify.forEach(m => pveSessionVerified.add(m.dgmid));
    }

    const aliveTargets   = targets.filter(m => !m.isDead);
    // FIX (a): no stored state + cap would be "none" = the battle page could not be read (bootstrap failed). Unknown is
    // not "no cap" - don't fight it blind, retry the bootstrap next scan.
    const capUnknown = m => !pveGetMobState(m.dgmid) && pveGetEffectiveCap(profile, m.name, null) === null;
    const unknownCap = aliveTargets.filter(capUnknown);
    if (unknownCap.length) pveWarn(`Node ${nodeId}: cap unknown for ${unknownCap.map(m => m.name || m.dgmid).join(', ')} (battle page unreadable) - not fighting until it loads`);
    const actionable     = aliveTargets.filter(m => {
      const entry = pveGetMobState(m.dgmid);
      const cap   = pveGetEffectiveCap(profile, m.name, entry);
      if (cap === 0) return false;                        // cap=0 = deliberately skipped
      if (capUnknown(m)) return false;
      return !pveIsMobCapped(m.dgmid, profile, m.name);
    });
    const fightableAlive = aliveTargets.filter(m => !capUnknown(m) &&
                                               pveGetEffectiveCap(profile, m.name, pveGetMobState(m.dgmid)) !== 0);
    pveNodeStats[nodeId].noActionable = fightableAlive.length > 0 && !actionable.length;
    refreshUI();

    if (!actionable.length || !fight) return;

    for (const mob of aliveTargets) {
      if (actionable.some(a => a.dgmid === mob.dgmid)) continue;
      const entry = pveGetMobState(mob.dgmid);
      const cap   = pveGetEffectiveCap(profile, mob.name, entry);
      if (cap === 0) pveInfo(`Node ${nodeId}: ${mob.name} — skipped (cap set to 0)`);
      else           pveInfo(`Node ${nodeId}: ${mob.name} — already capped (${entry?.damage}/${cap})`);
    }

    let staminaKnown = stamina;
    for (const mob of actionable) {
      if (pveStaminaWaiting || !dsTabIsMain) break;   // FIX (c): stop when the tab lost main status
      if (pveDeadMobsByNode[nodeId]?.has(mob.dgmid)) {
        pveInfo(`Node ${nodeId}: ${mob.name} already dead — skipping`);
        continue;
      }
      const entry = pveGetMobState(mob.dgmid);
      const cap = pveGetEffectiveCap(pveGetProfile(), mob.name, entry);   // FIX (b): live value, not the tick-start snapshot
      if (cap === 0) { pveInfo(`Node ${nodeId}: ${mob.name || mob.dgmid} — skipped (cap is now 0)`); continue; }
      pveInfo(`Node ${nodeId}: joining ${mob.name || mob.dgmid}…`);
      pveNodeStats[nodeId] = { ...(pveNodeStats[nodeId] || {}), attacking: mob.name || mob.dgmid };
      refreshUI();
      const joinRes = await pveJoinMonster(instanceId, mob.dgmid);
      if (!joinRes.joined) {
        const goneHint = /dead|not found|no longer|unavailable|invalid/i.test(joinRes.reason);
        if (goneHint) {
          pveInfo(`Node ${nodeId}: ${mob.name || mob.dgmid} — no longer joinable (${joinRes.reason}) — skipping`);
          (pveDeadMobsByNode[nodeId] || (pveDeadMobsByNode[nodeId] = new Set())).add(mob.dgmid);
        } else {
          pveWarn(`Node ${nodeId}: could not join ${mob.name || mob.dgmid} — ${joinRes.reason}`);
        }
        if (pveNodeStats[nodeId]) pveNodeStats[nodeId] = { ...pveNodeStats[nodeId], attacking: null };
        continue;
      }
      const { result, staminaAfter } = await pveFightMonster(instanceId, mob.dgmid, mob.name, profile, staminaKnown, cap, entry?.damage ?? 0);
      staminaKnown = staminaAfter;
      if (pveNodeStats[nodeId]) pveNodeStats[nodeId] = { ...pveNodeStats[nodeId], attacking: null };
      refreshUI();
      if (result === 'no_stamina') { pveInfo(`Node ${nodeId}: out of stamina — pausing PvE until next cycle`); pveStaminaWaiting = true; break; }
      if (result === 'player_dead') { pveWarn(`Node ${nodeId}: you died — stopping for this cycle`); break; }
      if (result === 'paused') break;
      if (result === 'error') continue;
      pveInfo(`Node ${nodeId}: ${mob.name || mob.dgmid} — ${result}`);
      if (result === 'killed') {
        const deadSet = pveDeadMobsByNode[nodeId] || (pveDeadMobsByNode[nodeId] = new Set());
        deadSet.add(mob.dgmid);
      }
      if (result === 'killed' || result === 'capped') {
        const stillActionable = actionable.filter(m => {
          if (pveDeadMobsByNode[nodeId]?.has(m.dgmid)) return false;
          return !pveIsMobCapped(m.dgmid, profile, m.name);
        });
        if (!stillActionable.length) {
          pveNodeStats[nodeId] = { ...(pveNodeStats[nodeId] || {}), noActionable: true };
          pveInfo(`Node ${nodeId}: all actionable mobs done`);
          refreshUI();
          break;
        }
      }
      refreshUI();
    }
  }

  function pveNodeHasBootstrapData(nodeId) {
    for (const entry of pveMobState.values()) {
      if (Number(entry.nodeId) === nodeId) return true;
    }
    return false;
  }

  async function pveTick(instanceId) {
    if (pveBusy) return;
    pveBusy = true;
    pveStaminaWaiting = false;
    pveLoadMobStateForInstance(instanceId);
    try {
      const profile = pveGetProfile();
      const available = await pveGetAvailableNodes(instanceId);
      for (const nodeId of PVE_TARGET_NODES) {
        if (!dsTabIsMain) break;   // FIX (c)
        const isAvailable = available.has(nodeId);
        pveLogNodeLockTransition(nodeId, isAvailable);
        pveNodeStats[nodeId] = { ...(pveNodeStats[nodeId] || {}), locked: !isAvailable, scanning: false };
        if (!isAvailable || pveStaminaWaiting) { refreshUI(); continue; }

        const locationId = pveLocationIdFor(nodeId);
        if (!locationId) { pveWarn(`Node ${nodeId}: no location_id mapping configured`); continue; }

        if (pveNodeStats[nodeId]?.allClear && pveNodeHasBootstrapData(nodeId)) {
          pveInfo(`Node ${nodeId}: confirmed clear — skipping`);
          continue;
        }

        pveNodeStats[nodeId] = { ...(pveNodeStats[nodeId] || {}), scanning: true };
        refreshUI();
        try {
          await pveScanNode(instanceId, nodeId, locationId, pveGetProfile(), { fight: true });   // FIX: fresh profile per node, not the tick-start snapshot
        } catch (e) {
          pveWarn(`Node ${nodeId}: scan threw — ${e.message}`);
        } finally {
          if (pveNodeStats[nodeId]) pveNodeStats[nodeId] = { ...pveNodeStats[nodeId], scanning: false };
          refreshUI();
        }
      }
    } catch (err) { pveWarn(`Tick error: ${err.message}`); }
    finally { pveBusy = false; }
  }

  async function pveReadOnlyScan(instanceId) {
    if (pveBusy) return;
    pveBusy = true;
    try {
      pveStaminaWaiting = false;
      pveLoadMobStateForInstance(instanceId);
      const profile = pveGetProfile();
      const available = await pveGetAvailableNodes(instanceId);
      for (const nodeId of PVE_TARGET_NODES) {
        const isAvailable = available.has(nodeId);
        pveLogNodeLockTransition(nodeId, isAvailable);
        pveNodeStats[nodeId] = { ...(pveNodeStats[nodeId] || {}), locked: !isAvailable, scanning: false };
        if (!isAvailable) { refreshUI(); continue; }

        const locationId = pveLocationIdFor(nodeId);
        if (!locationId) continue;

        if (pveNodeStats[nodeId]?.allClear && pveNodeHasBootstrapData(nodeId)) continue;

        pveNodeStats[nodeId] = { ...(pveNodeStats[nodeId] || {}), scanning: true };
        refreshUI();
        try {
          await pveScanNode(instanceId, nodeId, locationId, profile, { fight: false });
        } catch (e) {
          pveWarn(`Node ${nodeId}: passive scan threw — ${e.message}`);
        } finally {
          if (pveNodeStats[nodeId]) pveNodeStats[nodeId] = { ...pveNodeStats[nodeId], scanning: false };
          refreshUI();
        }
      }
    } catch (err) { pveWarn(`Passive scan error: ${err.message}`); }
    finally { pveBusy = false; }
  }

  function pvePruneOldMobStateKeys(keepInstanceIds) {
    const keep = new Set(keepInstanceIds.map(String));
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(PVE_MOB_STATE_KEY_PREFIX)) continue;
      const instId = key.slice(PVE_MOB_STATE_KEY_PREFIX.length);
      if (!keep.has(instId)) toRemove.push(key);
    }
    toRemove.forEach(k => localStorage.removeItem(k));
    if (toRemove.length) pveInfo(`Pruned ${toRemove.length} stale mob-state cache(s) from old dungeon instance(s)`);
  }

  function dsSafeSetItem(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (e) {
      if (e && (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014)) {
        console.warn(`[DS] localStorage FULL — could not save "${key}" (${value.length} chars)`);
        addLog('sys', 'warn', `Storage full — skipped saving "${key}" this time`);
      } else {
        console.warn(`[DS] localStorage.setItem("${key}") failed:`, e);
      }
      return false;
    }
  }

  function dsIsDungeonFullyCleared() {
    if (!currentInstanceId) return false;
    const pvpDone = PVP_NODE_PRIORITY.every(nodeId => {
      const stats = pvpNodeStats[nodeId];
      return !!stats && stats.allCleared;
    });
    const tyrantDone = !pvpTyrantEnabled || (() => {
      const t = pvpNodeStats[PVP_TYRANT_NODE_ID];
      return !!t && t.allCleared;
    })();
    const pveDone = PVE_TARGET_NODES.every(nodeId => {
      const stats = pveNodeStats[nodeId];
      return !!stats && (stats.allClear || stats.noActionable);
    });
    return pvpDone && tyrantDone && pveDone && saComputeAllCleared();
  }

  function dsMaybeAutoResetModeOnClear() {
    if (dsAutoModeResetDone) return;
    if (!dsIsFastMode()) return;
    if (!dsIsDungeonFullyCleared()) return;
    dsAutoModeResetDone = true;
    dsSaveMode('normal');
    addLog('sys', 'info', 'Dungeon fully cleared — Fast Run switched back to Normal for the next dungeon.');
    refreshUI();
  }

  async function tick() {
    try {
      if (dsTabIsMain) dsArmScheduleWakeups();   // FIX (b): picks up edited PvE schedules / mode switches
      const instanceId = await getActiveCubeInstanceId();
      if (instanceId && instanceId !== currentInstanceId) {
        const s = pvpLoadFastRunState();
        const seen = Array.isArray(s.seenInstanceIds) ? s.seenInstanceIds : [];
        const isNew = !!s.lastInstanceId && s.lastInstanceId !== instanceId && !seen.includes(instanceId);
        const nextSeen = seen.includes(instanceId) ? seen : [...seen, instanceId].slice(-5);

        currentInstanceId = instanceId;
        pvpLiveJoinCount     = 0;
        pvpHasScanned        = false;
        for (const k of Object.keys(pvpCooldownByNode)) delete pvpCooldownByNode[k];
        if (pvpCountdownInterval) { clearInterval(pvpCountdownInterval); pvpCountdownInterval = 0; }
        saAllClearedForNow = false;
        saFirstTickDone = false;
        dsAutoModeResetDone = false;
        saLastServerTime = null;
        for (const k of Object.keys(saNodeStats)) delete saNodeStats[k];
        pvpLockedNodesLogged.clear();
        saLockedNodesLogged.clear();
        pvpActiveBattleLoops.clear();
        saScheduledNukingMatch.clear();
        pveLockedNodesLogged.clear();
        pveSessionVerified.clear();
        for (const nodeId of Object.keys(pveNodeVerifyTimers)) {
          clearTimeout(pveNodeVerifyTimers[nodeId]);
          delete pveNodeVerifyTimers[nodeId];
        }
        for (const k of Object.keys(pvpNodeStats))          delete pvpNodeStats[k];
        for (const k of Object.keys(saNodeStats))           delete saNodeStats[k];
        for (const k of Object.keys(pveNodeStats))          delete pveNodeStats[k];
        for (const k of Object.keys(pveDiscoveredMobsByNode)) delete pveDiscoveredMobsByNode[k];
        for (const k of Object.keys(pveDeadMobsByNode))    delete pveDeadMobsByNode[k];
        for (const k of Object.keys(pveDeadNamesByNode))   delete pveDeadNamesByNode[k];
        for (const k of Object.keys(saLastBattleState))  delete saLastBattleState[k];
        for (const k of Object.keys(pvpLastNodeMatches))  delete pvpLastNodeMatches[k];
        pveStaminaWaiting = false;
        cubeStateCache = { data: null, forInstance: '', at: 0 };
        pvePruneOldMobStateKeys(nextSeen);
        pvePruneOldAttackDmgKeys(nextSeen);
        saPruneOldParticipatedKeys(nextSeen);
        if (isNew) {
          if (pvpTyrantEnabled) { pvpTyrantEnabled = false; pvpSaveTyrantEnabled(false); }
          addLog('sys', 'info', `Instance changed to #${instanceId}`);
          pvpSaveFastRunState({ ...s, node7Results: {}, node8Results: {}, lastInstanceId: instanceId, seenInstanceIds: nextSeen });
        } else {
          if (s.lastInstanceId !== instanceId && seen.includes(instanceId)) {
            addLog('sys', 'info', `Returned to known instance #${instanceId} — PvP progress preserved`);
          }
          pvpSaveFastRunState({ ...s, lastInstanceId: instanceId, seenInstanceIds: nextSeen });
        }
      }
      if (!uiBox || !uiBox.isConnected) mountUI();
      refreshUI();
      if (!instanceId) return;

      await getCubeState(instanceId);

      if (!masterEnabled) {
        await Promise.all([
          pvpReadOnlyScan(instanceId),
          saReadOnlyScan(instanceId),
          pveReadOnlyScan(instanceId),
        ]);
        dsMaybeAutoResetModeOnClear();
        return;
      }

      const isFirstSaTick = !saFirstTickDone;
      saFirstTickDone = true;

      if (!pveBusy) void pveTick(instanceId); // detached, pveBusy prevents overlap

      await Promise.all([
        pvpTick(instanceId),
        saTick(instanceId, { immediate: isFirstSaTick }),
      ]);
      dsMaybeAutoResetModeOnClear();
    } catch (err) {
      saErr(`Main tick error: ${err?.message || String(err)}`);
    }
  }

  async function runLoop() {
    if (!dsTabIsMain) return; // idle tab: Core.tab will promote us when the main tab goes away
    if (runLoopInFlight) {
      runLoopRestartRequested = true;
      return;
    }
    runLoopInFlight = true;
    if (runLoopTimer) { clearTimeout(runLoopTimer); runLoopTimer = 0; }
    try {
      await tick();
    } finally {
      runLoopInFlight = false;
    }
    const needsQuickRetry = !!currentInstanceId && !pvpHasScanned;
    const delay = runLoopRestartRequested ? 0 : needsQuickRetry ? 8_000 : (masterEnabled && dsIsFastMode()) ? PVP_FAST_INTERVAL_MS : Math.min(PVP_SCAN_INTERVAL_MS, SA_SCAN_MS);
    runLoopRestartRequested = false;
    runLoopTimer = setTimeout(runLoop, delay);
  }

  function dsRestartLoop() {
    if (runLoopInFlight) { runLoopRestartRequested = true; return; }
    if (runLoopTimer) { clearTimeout(runLoopTimer); runLoopTimer = 0; }
    void runLoop();
  }

  function injectStyles() {
    if (document.getElementById('ds-suite-style')) return;
    const style = document.createElement('style');
    style.id = 'ds-suite-style';
    style.textContent = `.ds-panel, .ds-panel * { box-sizing: border-box; }.ds-panel { position: fixed !important; top: 80px; right: 16px; width: 490px; background: #15161a; border: 1px solid #2a2c34; border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,.45); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 13px; color: #e4e4e7; z-index: 2147483000; user-select: none; overflow: hidden; }.ds-panel.ds-collapsed .ds-body { display: none; }.ds-header { display: flex; align-items: center; gap: 8px; padding: 10px 8px 10px 12px; background: #1c1d23; cursor: move; border-bottom: 1px solid #2a2c34; }.ds-panel.ds-collapsed .ds-header { border-bottom: none; }.ds-dot { width: 7px; height: 7px; border-radius: 50%; background: #4b4d57; flex-shrink: 0; transition: background .15s; }.ds-dot.on { background: #22c55e; box-shadow: 0 0 6px rgba(34,197,94,.6); }.ds-dot.monitoring { background: #f59e0b; box-shadow: 0 0 6px rgba(245,158,11,.5); }.ds-title { font-weight: 600; font-size: 13px; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }.ds-inst { font-weight: 400; color: #8b8d98; font-size: 11px; }.ds-iconbtn { background: transparent; border: none; color: #8b8d98; cursor: pointer; width: 22px; height: 22px; border-radius: 6px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; padding: 0; font-size: 12px; line-height: 1; }.ds-iconbtn:hover { background: #2a2c34; color: #e4e4e7; }.ds-pve-sched-syncbtn { background: transparent; border: 1px solid #2a2c34; color: #8b8d98; cursor: pointer; border-radius: 5px; padding: 2px 7px; font-size: 10px; line-height: 1.5; white-space: nowrap; flex-shrink: 0; }.ds-pve-sched-syncbtn:hover { background: #2a2c34; color: #e4e4e7; }.ds-chevron { transition: transform .15s; }.ds-panel.ds-collapsed .ds-chevron { transform: rotate(-90deg); }.ds-switch { position: relative; display: inline-block; width: 30px; height: 17px; flex-shrink: 0; cursor: pointer; }.ds-switch input { opacity: 0; width: 0; height: 0; position: absolute; }.ds-slider { position: absolute; inset: 0; background: #33343d; border-radius: 17px; transition: .15s; }.ds-slider::before { content: ''; position: absolute; width: 13px; height: 13px; left: 2px; top: 2px; background: #e4e4e7; border-radius: 50%; transition: .15s; }.ds-switch input:checked + .ds-slider { background: #6366f1; }.ds-switch input:checked + .ds-slider::before { transform: translateX(13px); }.ds-switch.sm { width: 26px; height: 15px; }.ds-switch.sm .ds-slider::before { width: 11px; height: 11px; }.ds-switch.sm input:checked + .ds-slider::before { transform: translateX(11px); }.ds-body { padding: 12px; max-height: calc(100vh - 100px); overflow-y: auto; }.ds-shared-mode-row { margin-bottom: 12px; }.ds-shared-mode-row .ds-field-label { margin-bottom: 6px; }.ds-shared-tag { font-weight: 400; color: #71727d; font-size: 10.5px; }.ds-tabs { display: flex; gap: 2px; margin-bottom: 12px; background: #1c1d23; border-radius: 8px; padding: 3px; }.ds-tab { flex: 1; background: transparent; border: none; color: #8b8d98; font-size: 12px; font-weight: 600; padding: 7px 0; border-radius: 6px; cursor: pointer; transition: .15s; }.ds-tab.active { background: #2a2c34; color: #e4e4e7; }.ds-tab:hover:not(.active) { color: #c4c5cc; }.ds-tabpanel { display: none; }.ds-tabpanel.active { display: block; }.ds-segmented { display: flex; gap: 6px; margin-bottom: 10px; }.ds-seg-btn { flex: 1; background: #1c1d23; border: 1px solid #2a2c34; color: #c4c5cc; font-size: 12px; padding: 6px 0; border-radius: 7px; cursor: pointer; font-weight: 500; transition: .15s; }.ds-seg-btn.active { background: rgba(99,102,241,.15); border-color: #6366f1; color: #a5a6f6; }.ds-seg-btn:hover:not(.active) { border-color: #3a3c46; }.ds-seg-btn:disabled { opacity: .5; cursor: default; }.ds-status { font-size: 12px; color: #c4c5cc; margin: 0 0 10px; }.ds-note { font-size: 11px; color: #71727d; line-height: 1.5; margin: 0; }.ds-fields-row { display: flex; gap: 10px; margin-bottom: 10px; }.ds-field { flex: 1; min-width: 0; }.ds-field-label { font-size: 11px; font-weight: 600; color: #c4c5cc; margin-bottom: 4px; }.ds-input { width: 100%; background: #1c1d23; border: 1px solid #2a2c34; color: #e4e4e7; border-radius: 6px; padding: 5px 7px; font-size: 12px; }.ds-input:focus { outline: none; border-color: #6366f1; }.ds-input[type="time"] { color-scheme: dark; }.ds-time-picker { display:inline-flex; align-items:stretch; flex-shrink:0; height:26px; border:1px solid #2a2c34; border-radius:6px; overflow:hidden; background:#1c1d23; }.ds-time-picker input.ds-pve-sched-h, .ds-time-picker input.ds-pve-sched-m { border:none; background:transparent; color:#e4e4e7; font-size:13px; font-variant-numeric:tabular-nums; width:22px; padding:0 3px; text-align:center; }.ds-time-picker input.ds-pve-sched-h:focus, .ds-time-picker input.ds-pve-sched-m:focus { outline:none; background:rgba(99,102,241,.16); }.ds-time-picker-colon { display:flex; align-items:center; padding:0 1px; color:#71727d; font-size:13px; }.ds-time-picker-ampm { flex-shrink:0; border:none; border-left:1px solid #2a2c34; background:transparent; color:#8b8d98; font-size:10px; font-weight:700; padding:0 7px; cursor:pointer; letter-spacing:.02em; }.ds-time-picker-ampm:hover { background:#232430; color:#c4c5cc; }.ds-time-picker-notime-chip { border:1px dashed #3a3c46 !important; color:#8b8d98; }.ds-time-picker-notime-chip:hover { border-color:#6366f1 !important; color:#a5a6f6; }.ds-pve-sched-row { margin:8px 0; padding:8px; background:#16171c; border:1px solid #2a2c34; border-radius:7px; }.ds-pve-sched-row.notime { background:#141518; }.ds-pve-sched-row-top { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }.ds-field-status { font-size: 11px; color: #71727d; margin-top: 4px; }.ds-field-status.done { color: #22c55e; }.ds-toggle-row { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #c4c5cc; }.ds-divider { height: 1px; background: #2a2c34; margin: 12px 0; }.ds-pve-node-block { border: 1px solid #2a2c34; border-radius: 7px; padding: 6px 8px; margin-bottom: 6px; }.ds-pve-node-header { display:flex; align-items:center; gap:6px; cursor:pointer; user-select:none; }.ds-pve-node-header:hover .ds-pve-hdr-label { color: #e4e4e7; }.ds-pve-hdr-label { flex:1; font-size:11px; font-weight:600; color:#c4c5cc; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }.ds-pve-mob-row { display:flex; align-items:center; justify-content:space-between; gap:6px; font-size:11px; color:#c4c5cc; padding:2px 0; }.ds-pve-mob-row label { display:flex; align-items:center; gap:6px; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:pointer; }.ds-pve-cap-input { width:126px; flex-shrink:0; padding:3px 5px !important; }.ds-log-header { display: flex; align-items: center; gap: 6px; padding: 0 0 8px; }.ds-log-header .ds-field-label { margin: 0; flex: 1; }.ds-log-filters { display: flex; gap: 4px; }.ds-chip { background: #1c1d23; border: 1px solid #2a2c34; color: #8b8d98; font-size: 10px; font-weight: 600; padding: 3px 8px; border-radius: 5px; cursor: pointer; }.ds-chip.active { background: rgba(99,102,241,.15); border-color: #6366f1; color: #a5a6f6; }.ds-log { background: #0f1013; border: 1px solid #2a2c34; border-radius: 8px; padding: 8px; height: 140px; overflow-y: auto; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 10.5px; line-height: 1.6; }.ds-log-line { color: #c4c5cc; margin-bottom: 1px; white-space: pre-wrap; word-break: break-word; }.ds-log-time { color: #52535c; margin-right: 4px; }.ds-log-src { font-weight: 700; margin-right: 3px; }.ds-log-line[data-source="pvp"] .ds-log-src { color: #7eb8f0; }.ds-log-line[data-source="sa"] .ds-log-src { color: #c49afa; }.ds-log-line[data-source="pve"] .ds-log-src { color: #8fd19e; }.ds-log-line[data-source="sys"] .ds-log-src { color: #71727d; }.ds-log-line[data-level="warn"] { color: #f0b429; }.ds-log-line[data-level="error"] { color: #ff6b6b; }.ds-log-empty { color: #52535c; font-size: 11px; padding: 4px 2px; }.ds-log.ds-log-full { height: calc(100vh - 400px); min-height: 230px; }.ds-pills { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0 8px; align-items: center; }.ds-pill { display: inline-flex; align-items: center; font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 20px; white-space: nowrap; letter-spacing: 0.02em; line-height: 1.5; }.ds-pill-cd { background: rgba(245,158,11,.12); color: #f59e0b; border: 1px solid rgba(245,158,11,.3); }.ds-pill-locked { background: rgba(30,30,40,.4); color: #52535c; border: 1px solid #2a2c34; }.ds-pill-mon { background: rgba(245,158,11,.08); color: #d97706; border: 1px solid rgba(245,158,11,.2); }.ds-pill-node { background: transparent; color: #52535c; border: 1px solid #33343d; font-size: 9.5px; padding: 1px 5px; }.ds-pill-avail { background: rgba(34,197,94,.12); color: #4ade80; border: 1px solid rgba(34,197,94,.3); }/* green: available to join */ .ds-pill-joined { background: rgba(59,130,246,.12); color: #60a5fa; border: 1px solid rgba(59,130,246,.3); }/* blue: currently joined/active */ .ds-pill-cleared { background: rgba(139,92,246,.12); color: #a78bfa; border: 1px solid rgba(139,92,246,.3); }/* violet: node cleared, X/Y joined */ .ds-pills:empty { display: none; margin: 0; }.ds-sa-node-card { border:1px solid #2a2c34; border-radius:7px; padding:8px 10px; margin-bottom:5px; }.ds-sa-node-hdr { display:flex; align-items:center; gap:6px; }.ds-sa-node-label { flex:1; font-size:11px; font-weight:600; color:#c4c5cc; }.ds-sa-cap-list { margin-top:6px; padding-top:6px; border-top:1px solid #1c1d23; }.ds-sa-cap-row { display:flex; align-items:center; gap:5px; padding:2px 0; font-size:11px; color:#c4c5cc; }.ds-sa-cap-icon { flex-shrink:0; width:14px; text-align:center; color:#60a5fa; }.ds-sa-cap-name { flex:0 0 auto; max-width:100px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.ds-sa-cap-arrow { color:#52535c; flex-shrink:0; }.ds-sa-cap-target { color:#a5a6f6; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.ds-pvp-match-card { border:1px solid #2a2c34; border-radius:7px; padding:8px 10px; margin-top:8px; }.ds-linkbtn { background: none; border: none; padding: 0; margin: 0; color: #60a5fa; text-decoration: underline; cursor: pointer; font: inherit; font-weight: 600; }.ds-linkbtn:hover { color: #93c5fd; }.ds-ffa-popover { position: fixed; z-index: 2147483001; width: 320px; background: #15161a; border: 1px solid #2a2c34; border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,.45); padding: 10px; color: #e4e4e7; }.ds-ffa-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }.ds-ffa-title { font-size: 13px; font-weight: 700; }.ds-ffa-close { background: transparent; border: none; color: #8b8d98; font-size: 18px; cursor: pointer; line-height: 1; }.ds-ffa-timeline { position: relative; padding-left: 34px; --row-h: 30px; }.ds-ffa-rail { position: absolute; left: 15px; top: 14px; bottom: 14px; width: 2px; background: #2a2c34; }.ds-ffa-fill { position: absolute; left: 15px; top: 14px; width: 2px; height: calc(var(--ffa-progress) * var(--row-h)); background: #60a5fa; }.ds-ffa-marker { position: absolute; left: 9px; top: calc(14px + (var(--ffa-progress) * var(--row-h)) - 7px); width: 14px; height: 14px; border-radius: 50%; background: #60a5fa; box-shadow: 0 0 0 4px rgba(96,165,250,.12); }.ds-ffa-row { display: grid; grid-template-columns: 76px 1fr auto; gap: 8px; align-items: center; min-height: var(--row-h); font-size: 12px; position: relative; }.ds-ffa-row::before { content: ''; position: absolute; left: -22px; top: 10px; width: 8px; height: 8px; border-radius: 50%; background: #52535c; }.ds-ffa-row.cleared::before { background: #52535c; }.ds-ffa-row.future::before { background: #33343d; }.ds-ffa-time { color: #c4c5cc; }.ds-ffa-node { color: #8b8d98; }.ds-ffa-status { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: #8b8d98; }.ds-ffa-row.cleared .ds-ffa-status { color: #71727d; }.ds-ffa-row.next .ds-ffa-status { color: #60a5fa; }.ds-ffa-row.before::before { background: #3f4655; }.ds-ffa-row.after::before { background: #3f4655; }.ds-ffa-row.before .ds-ffa-status, .ds-ffa-row.after .ds-ffa-status { color: #8b8d98; }.ds-ffa-row.before .ds-ffa-node, .ds-ffa-row.after .ds-ffa-node { color: #c4c5cc; }.ds-ffa-row.before { opacity: 0.72; }.ds-ffa-row.after { opacity: 0.58; }.ds-ffa-row.future { opacity: 0.55; }.ds-ffa-row.before, .ds-ffa-row.after { grid-template-columns: 110px 1fr auto; }.ds-ffa-row.before .ds-ffa-time, .ds-ffa-row.after .ds-ffa-time { white-space: nowrap; }.ds-panel.ds-tab-blocked .ds-body > *:not(.ds-tab-block-msg) { display: none !important; }.ds-panel.ds-tab-blocked .ds-tab-block-msg { display: flex !important; }.ds-tab-block-msg { display: none; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 28px 16px; gap: 10px; min-height: 120px; }.ds-tbl-icon { font-size: 22px; }.ds-tbl-title { font-weight: 700; font-size: 13px; color: #e4e4e7; }.ds-tbl-note { font-size: 11px; color: #8b8d98; line-height: 1.65; }.ds-body { -webkit-overflow-scrolling: touch; transform: translateZ(0); }
      @media (max-width: 520px) {.ds-panel { width: calc(100vw - 16px) !important; right: 8px !important; left: 8px !important; top: auto !important; bottom: 8px !important; }.ds-body { max-height: calc(72vh - 48px); }
      }
    `;
    document.head.appendChild(style);
  }

  let ffaPopupEl = null;
  let saLastServerTimeAt = 0;

  function saSetServerTime(t) {
    if (!t) return;
    saLastServerTime = t;
    saLastServerTimeAt = Date.now();
    if (t.tzoff !== undefined) saLastServerTzoff = t.tzoff;
  }

  function saNowSeconds() {
    try { if (Core.clock.known) return Core.clock.parts().secOfDay; } catch (_) { /* fall through */ }
    if (saLastServerTime) {
      const elapsed = Math.floor((Date.now() - saLastServerTimeAt) / 1000);
      return (saLastServerTime.localSeconds + elapsed) % 86400;
    }
    if (saLastServerTzoff !== null)
      return (Math.floor(Date.now() / 1000) + saLastServerTzoff) % 86400;
    return null;
  }

  function formatFfaHour(hour, minute = 0) {
    const h = ((hour % 12) || 12);
    const ampm = hour < 12 ? 'AM' : 'PM';
    return `${h}:${String(minute).padStart(2, '0')} ${ampm}`;
  }

  function getFfaProgress(now, handledKeys = new Set()) {
    if (now == null) return 0;

    const times = SA_SCHEDULE.map(dsScheduleEntrySeconds);
    const lastItem  = SA_SCHEDULE[SA_SCHEDULE.length - 1];
    const lastKey   = `${lastItem.nodeId}:h${lastItem.hour}:m${lastItem.minute ?? 0}`;

    const preAnchor = times[0] - 3600;
    if (now < preAnchor) return 0;
    if (now < times[0])  return (now - preAnchor) / 3600;

    for (let i = 1; i < times.length; i++) {
      if (now < times[i]) {
        const prev = times[i - 1];
        const frac = (now - prev) / (times[i] - prev);
        return i + frac;
      }
    }
    return handledKeys.has(lastKey) ? times.length + 1 : times.length;
  }

  function getFfaState(instanceId) {
    const now = saNowSeconds();
    if (now === null) return null;
    const times = SA_SCHEDULE.map(dsScheduleEntrySeconds);
    let nextIndex = times.findIndex(t => now < t);
    let tomorrow = false;
    if (nextIndex === -1) { nextIndex = 0; tomorrow = true; }
    const handledKeys = new Set(instanceId ? saLoadSchedHandled(instanceId).keys : []);
    return { now, nextIndex, tomorrow, handledKeys, progress: getFfaProgress(now, handledKeys) };
  }

  function closeFfaPopup() {
    if (!ffaPopupEl) return;
    ffaPopupEl.remove();
    ffaPopupEl = null;
    document.removeEventListener('mousedown', onFfaOutsideClick, true);
    window.removeEventListener('keydown', onFfaEscKey, true);
  }

  function onFfaOutsideClick(e) {
    if (!ffaPopupEl) return;
    if (ffaPopupEl.contains(e.target) || e.target.closest?.('#ds-ffa-help')) return;
    closeFfaPopup();
  }

  function onFfaEscKey(e) {
    if (e.key === 'Escape') closeFfaPopup();
  }

  function openFfaPopup(anchor) {
    closeFfaPopup();

    const rect = anchor.getBoundingClientRect();
    const el = document.createElement('div');
    el.id = 'ds-ffa-popup';
    el.className = 'ds-ffa-popover';
    el.style.visibility = 'hidden';
    el.style.left = `${Math.min(rect.left, window.innerWidth - 340)}px`;
    el.style.top = `${rect.bottom + 8}px`;

    const st = getFfaState(currentInstanceId);

    const rowsHtml = !st
    ? `<p style="--ffa-progress:${st ? st.progress : 0};">Server time not yet known — wait for first SA scan.</p>`
    : [
      `<div class="ds-ffa-row before">
            <span class="ds-ffa-time"> </span>
            <span class="ds-ffa-node">Before</span>
            <span class="ds-ffa-status">start</span>
          </div>`,
      ...SA_SCHEDULE.map((item, idx) => {
        const key = `${item.nodeId}:h${item.hour}:m${item.minute ?? 0}`;
        const rowPos = idx + 1;
        const label = item.nodeId === 11
        ? `Node 11 · Final`   // FIX: no " · Nuke" / " · Hit" suffix
        : `Node ${item.nodeId} · Match ${item.nodeId === 5 ? idx + 1 : idx - 3}`;

        const isDone = st.handledKeys.has(key);
        const isNext = !isDone && !st.tomorrow && rowPos === Math.ceil(st.progress);
        const isPast = !isDone && !isNext && (st.tomorrow || rowPos < Math.ceil(st.progress));

        let status, cls;
        if      (isDone) { status = '✓ done';   cls = 'cleared'; }
        else if (isNext) { status = 'next';     cls = 'next'; }
        else if (isPast) { status = 'past';     cls = 'cleared'; }
        else              { status = 'upcoming'; cls = 'future'; }

        return `
              <div class="ds-ffa-row ${cls}">
                <span class="ds-ffa-time">${formatFfaHour(item.hour, item.minute ?? 0)}</span>
                <span class="ds-ffa-node">${label}</span>
                <span class="ds-ffa-status">${status}</span>
              </div>`;
      }),
      `<div class="ds-ffa-row after">
            <span class="ds-ffa-time"> </span>
            <span class="ds-ffa-node">After</span>
            <span class="ds-ffa-status">end</span>
          </div>`
    ].join('');

    el.innerHTML = `
      <div class="ds-ffa-head">
        <div class="ds-ffa-title">FFA schedule - Server time</div>
        <button class="ds-ffa-close" type="button">×</button>
      </div>
      <div class="ds-ffa-timeline" style="--ffa-progress:${st ? st.progress : 0};">
        <div class="ds-ffa-rail"></div>
        ${st ? '<div class="ds-ffa-fill"></div><div class="ds-ffa-marker"></div>' : ''}
        ${rowsHtml}
      </div>`;

    document.body.appendChild(el);

    const MARGIN = 8;
    const w = el.offsetWidth;
    const h = el.offsetHeight;

    let left = Math.max(MARGIN, Math.min(rect.left, window.innerWidth - w - MARGIN));
    let top  = rect.bottom + MARGIN;
    if (top + h > window.innerHeight - MARGIN) {
      const aboveTop = rect.top - h - MARGIN;
      top = aboveTop >= MARGIN ? aboveTop : Math.max(MARGIN, window.innerHeight - h - MARGIN);
    }

    el.style.left = `${left}px`;
    el.style.top  = `${top}px`;
    el.style.visibility = '';

    ffaPopupEl = el;
    el.querySelector('.ds-ffa-close')?.addEventListener('click', closeFfaPopup);
    document.addEventListener('mousedown', onFfaOutsideClick, true);
    window.addEventListener('keydown', onFfaEscKey, true);
  }

  const pveNodeVerifyTimers = {}; // nodeId -> setTimeout handle

  function pveVerifyNodeSoon(nodeId, delay = 500) {
    nodeId = Number(nodeId);
    if (pveNodeVerifyTimers[nodeId]) clearTimeout(pveNodeVerifyTimers[nodeId]);
    pveNodeVerifyTimers[nodeId] = setTimeout(() => {
      delete pveNodeVerifyTimers[nodeId];
      void pveVerifyNode(nodeId);
    }, delay);
  }
  function pveVerifyAllNodesSoon(delay = 500) {
    for (const nodeId of PVE_TARGET_NODES) pveVerifyNodeSoon(nodeId, delay);
  }
  async function pveVerifyNode(nodeId) {
    const instanceId = currentInstanceId;
    if (!instanceId) return;
    if (pveLockedNodesLogged.has(nodeId) || pveNodeStats[nodeId]?.locked) return;
    if (pveBusy) { pveVerifyNodeSoon(nodeId, 1000); return; }
    const locationId = pveLocationIdFor(nodeId);
    if (!locationId) return;
    pveBusy = true;
    pveNodeStats[nodeId] = { ...(pveNodeStats[nodeId] || {}), scanning: true };
    refreshUI();
    try {
      pveLoadMobStateForInstance(instanceId);
      const profile = pveGetProfile();
      await pveScanNode(instanceId, nodeId, locationId, profile, { fight: false });
    } catch (e) {
      pveWarn(`Node ${nodeId}: verify scan failed — ${e.message}`);
    } finally {
      pveBusy = false;
      if (pveNodeStats[nodeId]) pveNodeStats[nodeId] = { ...pveNodeStats[nodeId], scanning: false };
      refreshUI();
    }
  }

  // FIX: keep a saved / dragged position on screen after load and after the window shrinks
  let dsResizeBound = false;
  function dsClampPanel(p = uiBox) {
    if (!p || !p.style.left || innerWidth < 520) return;   // default (right-anchored) and mobile layouts are CSS-placed
    const l = Math.max(4, Math.min(parseFloat(p.style.left) || 0, innerWidth  - p.offsetWidth  - 4)) + 'px';
    const t = Math.max(4, Math.min(parseFloat(p.style.top)  || 0, innerHeight - p.offsetHeight - 4)) + 'px';
    if (l !== p.style.left) p.style.left = l;
    if (t !== p.style.top)  p.style.top  = t;
  }

  function mountUI() {
    if (document.getElementById('ds-panel')) return;
    injectStyles();
    const panel = document.createElement('div');
    panel.id = 'ds-panel';
    panel.className = 'ds-panel ds-tab-blocked';
    panel.innerHTML = ` <div class="ds-header"> <span class="ds-dot" id="ds-dot"></span> <span class="ds-title">Dungeon Suite <span class="ds-inst" id="ds-inst"></span></span> <label class="ds-switch" title="Enable / disable automation"> <input type="checkbox" id="ds-master-toggle"> <span class="ds-slider"></span> </label> <button class="ds-iconbtn ds-chevron" id="ds-collapse-btn" type="button" title="Collapse">▾</button> </div> <div class="ds-body"> <div class="ds-tab-block-msg"> <div class="ds-tbl-icon">⏳</div> <div class="ds-tbl-title">Starting…</div> <div class="ds-tbl-note">Checking tab status…</div> </div> <div class="ds-shared-mode-row"> <div class="ds-field-label">Mode <span class="ds-shared-tag">— Made by werewulf</span></div> <div class="ds-segmented"> <button class="ds-seg-btn" data-mode="normal" type="button">Normal</button> <button class="ds-seg-btn" data-mode="fast"   type="button">Fast Run</button> </div> </div> <div class="ds-tabs"> <button class="ds-tab" data-tab="pvp" type="button">PvP</button> <button class="ds-tab" data-tab="sa"  type="button">SA</button> <button class="ds-tab" data-tab="pve" type="button">PvE</button> <button class="ds-tab" data-tab="log" type="button">Log</button> </div> <div class="ds-tabpanel" data-tab="pvp"> <p class="ds-status" id="ds-status-pvp"></p> <div class="ds-pills" id="ds-pvp-pills"></div> <div id="ds-pvp-normal"> <p class="ds-note" title="Auto-join cap: 6 matches before 4PM server time, 40 after FFA opens at 4PM. Tyrant Conclave (Node 9) is a separate opt-in node and never counts toward or is limited by this cap.">Scans nodes every ${Math.round(PVP_SCAN_INTERVAL_MS / 1000)}s. Auto-join cap: 6 before 4PM, 40 after (FFA). Monitoring continues when paused.</p> <div id="ds-pvp-match-list"></div> </div> <div id="ds-pvp-fast" style="display:none;"> <div class="ds-fields-row"> <div class="ds-field"> <div class="ds-field-label">Node 7 · Ring Ward</div> <input class="ds-input" data-node="7" type="number" min="0" max="20" value="0"> <div class="ds-field-status" data-node="7">—</div> </div> <div class="ds-field"> <div class="ds-field-label">Node 8 · Duel Heart</div> <input class="ds-input" data-node="8" type="number" min="0" max="20" value="0"> <div class="ds-field-status" data-node="8">—</div> </div> </div> <p class="ds-note" style="margin-bottom:10px;">0 = skip node. Polls every ${(PVP_FAST_INTERVAL_MS / 1000).toFixed(1)}s when active.</p> <div class="ds-toggle-row"> <label class="ds-switch sm"><input type="checkbox" id="ds-leader-toggle"><span class="ds-slider"></span></label> <span>Leader / Vice — starts any match with at least 1 player inside instantly</span> </div> </div> <div class="ds-toggle-row" style="margin:10px 0 0;" title="Tyrant Conclave is a separate opt-in node — it is never counted toward, or limited by, the Node 7/8 join cap above (6 before 4PM, 40 after FFA)."> <label class="ds-switch sm"><input type="checkbox" id="ds-tyrant-toggle"><span class="ds-slider"></span></label> <span>Tyrant Conclave (N9) Final PVP Boss</span> </div> </div> <div class="ds-tabpanel" data-tab="sa"> <p class="ds-status" id="ds-status-sa"></p> <div class="ds-pills" id="ds-sa-pills"></div> <div id="ds-sa-node-list" style="margin-bottom:8px;"></div> <button class="ds-seg-btn" id="ds-sa-heal-all" type="button" style="width:100%;margin-bottom:8px;">Heal All Units</button> <p class="ds-note" id="ds-sa-note"></p> <div id="ds-sa-sched-wrap"> <div class="ds-divider"></div> <div class="ds-toggle-row"> <label class="ds-switch sm"><input type="checkbox" id="ds-sa-sched-nuke"><span class="ds-slider"></span></label> <span title="Also nukes any overdue fights still uncleared that are past ffa"> Scheduled clear — joins &amp; nukes each battle at <button class="ds-linkbtn" id="ds-ffa-help" type="button">FFA</button> </span> </div> </div> </div> <div class="ds-tabpanel" data-tab="pve"> <p class="ds-status" id="ds-status-pve"></p> <div class="ds-pills" id="ds-pve-pills"></div> <div class="ds-fields-row"> <div class="ds-field"> <div class="ds-field-label">Stop condition</div> <select class="ds-input" id="ds-pve-mode"> <option value="exp">EXP cap</option> <option value="fixed">Fixed cap (all mobs)</option> <option value="monster">Per-mob caps</option> <option value="loot">Full loot unlock</option> <option value="scheduled" id="ds-pve-mode-scheduled-opt">Scheduled (per-node, time-based)</option> </select> </div> <div class="ds-field"> <div class="ds-field-label">Damage Model</div> <select class="ds-input" id="ds-pve-damage-model" title="Change the Damage Model that will be used for PVE."> <option value="eco" title="Stamina conservative: Biggest attack that still fits under remaining cap.">Eco</option> <option value="fast" title="Fewest Hits: Prioritizes fewest amount of hits to close the remaining cap.">Fast</option> </select> </div> </div> <p class="ds-note" id="ds-pve-mode-note" style="margin:-4px 0 8px;"></p> <div class="ds-fields-row" id="ds-pve-fixedcap-row" style="display:none;"> <div class="ds-field"> <div class="ds-field-label">Fixed cap</div> <input class="ds-input" id="ds-pve-fixedcap" type="number" min="0" step="1000" placeholder="0 = no limit"> </div> </div> <div class="ds-fields-row"> <div class="ds-toggle-row" style="flex:1;"> <label class="ds-switch sm"><input type="checkbox" id="ds-pve-stam-potion"><span class="ds-slider"></span></label> <span>Auto stamina potion</span> </div> <div class="ds-toggle-row" style="flex:1;"> <label class="ds-switch sm"><input type="checkbox" id="ds-pve-hp-potion"><span class="ds-slider"></span></label> <span>Auto HP potion</span> </div> </div> <div style="display:flex; gap:8px; margin:8px 0; align-items:center;"> <div id="ds-pve-stamcap-wrap" style="flex:1; display:none; justify-content:flex-start;"> <div id="ds-pve-stamcap-row" style="display:flex;align-items:center;gap:5px;font-size:11px;color:#8b8d98;white-space:nowrap;"> <span>Skip LSP ≥</span> <input class="ds-input" id="ds-pve-stamcap" type="number" min="0" max="100" step="0.5" style="width:56px;padding:3px 5px;font-size:11px;"> <span>% EXP</span> </div> </div> <div style="flex:1;"> <button class="ds-seg-btn" id="ds-pve-copy-other" type="button" style="width:100%;padding:6px 14px;"> Copy from <span id="ds-pve-copy-other-label"></span></button> </div> </div> <div id="ds-pve-nodepanels"></div> <p class="ds-note" style="margin-top:6px;">Normal &amp; Fast Run keep separate profiles and mob selections.</p> </div> <div class="ds-tabpanel" data-tab="log"> <div class="ds-log-header" style="margin-bottom:6px;"> <div class="ds-log-filters"> <button class="ds-chip" data-filter="all" type="button">All</button> <button class="ds-chip" data-filter="pvp" type="button">PvP</button> <button class="ds-chip" data-filter="sa"  type="button">SA</button> <button class="ds-chip" data-filter="pve" type="button">PvE</button> <button class="ds-chip" data-filter="sys" type="button">Sys</button> </div> </div> <div class="ds-log ds-log-full" id="ds-log"></div> </div> </div> `;
    document.documentElement.appendChild(panel);
    const pos = dsLoadPos();
    if (innerWidth >= 520 && pos?.left && pos?.top) Object.assign(panel.style, { left: pos.left, top: pos.top, right: 'auto' });
    uiBox = panel;
    wireUI(panel);
    refreshUI();
    dsClampPanel(panel);
    if (!dsResizeBound) { dsResizeBound = true; addEventListener('resize', () => dsClampPanel()); }
    renderLog();
    addLog('sys', 'info', 'Dungeon Suite ready.');
  }

  function wireUI(panel) {
    const hdr = panel.querySelector('.ds-header');
    let from = null;
    hdr.style.touchAction = 'none';
    hdr.onpointerdown = e => {
      if (e.target.closest('.ds-switch, .ds-iconbtn')) return;
      const r = panel.getBoundingClientRect();
      from = { x: e.clientX - r.left, y: e.clientY - r.top };
      hdr.setPointerCapture(e.pointerId);
    };
    hdr.onpointermove = e => {
      if (!from) return;
      const left = Math.max(4, Math.min(e.clientX - from.x, innerWidth - panel.offsetWidth - 4));
      const top  = Math.max(4, Math.min(e.clientY - from.y, innerHeight - panel.offsetHeight - 4));
      Object.assign(panel.style, { left: left + 'px', top: top + 'px', right: 'auto' });
    };
    hdr.onpointerup = () => { if (from) { from = null; dsSavePos({ left: panel.style.left, top: panel.style.top }); } };

    panel.querySelector('#ds-master-toggle').addEventListener('change', e => {
      masterEnabled = e.target.checked;
      dsSaveMasterEnabled(masterEnabled);
      addLog('sys', 'info', masterEnabled ? 'Automation enabled' : 'Automation paused (monitoring active)');
      refreshUI();
      dsRestartLoop();
    });

    panel.querySelector('#ds-collapse-btn').addEventListener('click', () => {
      collapsed = !collapsed; dsSaveCollapsed(collapsed); refreshUI();
    });

    panel.querySelectorAll('.ds-tab').forEach(btn =>
                                              btn.addEventListener('click', () => { activeTab = btn.dataset.tab; refreshUI(); }));

    panel.querySelectorAll('.ds-seg-btn[data-mode]').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode === 'fast' ? 'fast' : 'normal';
        if (dsLoadMode() === mode) return;
        dsSaveMode(mode);
        masterEnabled = false;
        dsSaveMasterEnabled(false);
        addLog('sys', 'info', `Mode → ${mode === 'fast' ? 'Fast Run' : 'Normal'} — automation paused, re-enable to start`);
        refreshUI();
        dsRestartLoop();
      });
    });

    panel.querySelector('#ds-sa-heal-all').addEventListener('click', async () => {
      const btn = panel.querySelector('#ds-sa-heal-all');
      if (btn.disabled) return;
      btn.disabled = true;
      const orig = btn.textContent;
      btn.textContent = 'Healing…';
      try {
        await saHealDeadCaptains('manual', { force: true });
      } finally {
        btn.disabled = false;
        btn.textContent = orig;
      }
    });

    panel.querySelector('#ds-sa-sched-nuke').addEventListener('change', e => {
      saScheduledNukeEnabled = e.target.checked;
      saSaveScheduledNukeEnabled(saScheduledNukeEnabled);
      addLog('sys', 'info', `Scheduled SA nuke ${saScheduledNukeEnabled ? 'enabled' : 'disabled'}`);
      refreshUI();
    });

    panel.querySelectorAll('.ds-input[data-node]').forEach(input => {
      input.addEventListener('change', () => {
        const nodeId = input.dataset.node;
        const next   = Math.min(20, Math.max(0, parseInt(input.value, 10) || 0));
        input.value  = next;
        const s = pvpLoadFastRunState();
        if (String(nodeId) === '7') s.node7MatchNo = next;
        else                        s.node8MatchNo = next;
        pvpSaveFastRunState(s);
        pvpInfo(`Node ${nodeId} match assignment set to ${next || 'none'}`);
        refreshUI();
      });
    });

    panel.querySelector('#ds-pve-mode').addEventListener('change', e => {
      pveUpdateProfile(p => { p.damageMode = e.target.value; }, { resetActionable: true });
      pveVerifyAllNodesSoon();
    });

    panel.querySelector('#ds-pve-fixedcap').addEventListener('change', e => {
      pveUpdateProfile(p => {
        p.fixedDamageCap = Math.max(0, parseInt(e.target.value, 10) || 0);
      }, { resetActionable: true });
      pveVerifyAllNodesSoon();
    });

    panel.querySelector('#ds-pve-damage-model').addEventListener('change', e => {
      pveUpdateProfile(p => { p.damageModel = e.target.value; });
    });

    panel.querySelector('#ds-pve-stam-potion').addEventListener('change', e => {
      pveUpdateProfile(p => { p.useStaminaPotion = e.target.checked; });
    });

    panel.querySelector('#ds-pve-hp-potion').addEventListener('change', e => {
      pveUpdateProfile(p => { p.useHpPotion = e.target.checked; });
    });

    panel.querySelector('#ds-pve-stamcap').addEventListener('change', e => {
      const val = Math.min(100, Math.max(0, parseFloat(e.target.value) || 0));
      pveUpdateProfile(p => { p.staminaPotionExpCap = val; });
    });

    panel.querySelector('#ds-pve-copy-other').addEventListener('click', () => {
      const other = pveActiveProfileKey() === 'fast' ? 'Normal' : 'Fast Run';
      const ok = confirm(`Copy all PvE settings (mode, attack, potions, mob caps & selections) from ${other} into the current profile? This overwrites the current one.`);
      if (ok) pveCopyProfileFromOtherMode();
    });

    const logEl = panel.querySelector('#ds-log');
    logEl.addEventListener('scroll', () => {
      logStickToBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 32;
    });

    panel.querySelector('#ds-pve-nodepanels').addEventListener('change', e => {
      const cb = e.target.closest('[data-pve-mob-node]');
      if (cb) {
        const nodeId = cb.dataset.pveMobNode;
        const name = cb.dataset.pveMobName;
        pveUpdateProfile(p => {
          const hasKey = Object.prototype.hasOwnProperty.call(p.selectedMobsByNode, nodeId);
          let list;
          if (hasKey) {
            list = new Set(p.selectedMobsByNode[nodeId] || []);
          } else if (p.damageMode === 'monster') {
            list = new Set();
          } else {
            const rows = panel.querySelectorAll(`[data-pve-mob-node="${nodeId}"]`);
            list = new Set([...rows].map(el => el.dataset.pveMobName));
          }
          cb.checked ? list.add(name) : list.delete(name);
          p.selectedMobsByNode[nodeId] = [...list];
        }, { resetActionableNodeId: nodeId });
        pveVerifyNodeSoon(nodeId);
        return;
      }

      const capInput = e.target.closest('[data-pve-cap-name]');
      if (capInput) {
        const name = capInput.dataset.pveCapName;
        const nodeId = capInput.dataset.pveCapNode;
        const val = Math.max(0, parseInt(capInput.value, 10) || 0);
        pveUpdateProfile(p => { p.monsterCaps[name] = val; }, { resetActionableNodeId: nodeId });
        pveVerifyNodeSoon(nodeId);
      }
    });

    panel.querySelector('#ds-pve-nodepanels').addEventListener('click', e => {
      const schedOpenBtn = e.target.closest('.ds-pve-sched-open');
      if (schedOpenBtn) {
        const nodeId = Number(schedOpenBtn.dataset.schedOpenNode);
        openPveSchedPopup(nodeId, schedOpenBtn);
        return;
      }

      const toggle = e.target.closest('[data-node-toggle]');
      if (toggle) {
        const nodeId = Number(toggle.dataset.nodeToggle);
        if (pveCollapsedNodes.has(nodeId)) pveCollapsedNodes.delete(nodeId);
        else pveCollapsedNodes.add(nodeId);
        refreshUI();
      }
    });

    panel.querySelector('#ds-tyrant-toggle').addEventListener('change', e => {
      const wantOn = e.target.checked;
      if (wantOn) {
        const ok = confirm(
          '⚠️ Tyrant Conclave\n\n' +
          'Before enabling this feature:\n' +
          '• Be aware that there are limited boss slots.\n' +
          '• Unlawful joins might result in strikes!\n'+
          '• Dont delay and disrupt the guild\'s fast run.\n\n' +
          'Continue and enable auto-join + auto-attack for Node 9?'
        );
        if (!ok) { e.target.checked = false; return; }
      }
      pvpTyrantEnabled = wantOn;
      pvpSaveTyrantEnabled(wantOn);
      if (!wantOn) pvpNodeStats[PVP_TYRANT_NODE_ID] = { hidden: true };
      addLog('sys', 'info', `Tyrant Conclave automation ${wantOn ? 'ENABLED' : 'disabled'}`);
      refreshUI();
      dsRestartLoop();
    });

    panel.querySelector('#ds-ffa-help')?.addEventListener('click', e => {
      e.preventDefault();
      openFfaPopup(e.currentTarget);
    });

    panel.querySelector('#ds-leader-toggle').addEventListener('change', e => {
      const s = pvpLoadFastRunState(); s.isLeader = e.target.checked; pvpSaveFastRunState(s);
      pvpInfo(`Leader/Vice mode ${e.target.checked ? 'enabled' : 'disabled'}`);
      refreshUI();
    });

    panel.querySelectorAll('.ds-chip').forEach(btn =>
                                               btn.addEventListener('click', () => { activeLogFilter = btn.dataset.filter; renderLog(); refreshUI(); }));
  }

  const PVE_SCHED_MODE_LABELS = { exp: 'EXP cap', fixed: 'Fixed cap', monster: 'Per-mob', loot: 'Loot unlock', skip: 'Skip' };

  function pveHour24ToParts(hour24) {
    const h = ((hour24 % 24) + 24) % 24;
    return { h12: (h % 12) || 12, ampm: h < 12 ? 'AM' : 'PM' };
  }
  function pveHour12ToHour24(h12, ampm) {
    h12 = Math.min(12, Math.max(1, h12 || 12));
    if (ampm === 'PM') return h12 === 12 ? 12 : h12 + 12;
    return h12 === 12 ? 0 : h12;
  }

  function pveRenderScheduleRowsHTML(nodeId, schedule) {
    const profile       = pveGetProfile();
    const hasSelKey     = Object.prototype.hasOwnProperty.call(profile.selectedMobsByNode, nodeId);
    const selectedMobs  = new Set(profile.selectedMobsByNode[nodeId] || []);
    const mobEntries = pveGetNodeMobEntries(nodeId)
    .filter(([key]) => !hasSelKey || selectedMobs.has(key));

    const indexed    = (schedule || []).map((entry, idx) => ({ entry, idx }));
    const noTimeItem = indexed.find(x => x.entry.noTime) || null;
    const timedItems = indexed.filter(x => !x.entry.noTime)
    .sort((a, b) => dsScheduleEntrySeconds(a.entry) - dsScheduleEntrySeconds(b.entry));
    const ordered = noTimeItem ? [noTimeItem, ...timedItems] : timedItems;

    const rows = ordered.map(({ entry, idx }) => {
      const isNoTime = !!entry.noTime;
      const modeOpts = Object.entries(PVE_SCHED_MODE_LABELS).map(([m, lbl]) =>
                                                                 `<option value="${m}" ${entry.mode === m ? 'selected' : ''}${m === 'skip' ? ' title="Fight nothing during this window, on purpose."' : ''}>${lbl}</option>`
                                                                ).join('');
      const fixedInput = entry.mode === 'fixed'
      ? `<input type="number" class="ds-input ds-pve-sched-fixedcap" min="0" step="1000"
                   data-sched-node="${nodeId}" data-sched-idx="${idx}"
                   value="${entry.fixedCap ?? 0}" placeholder="cap"
                   style="flex:1 1 92px;min-width:60px;">`
      : '';
      const monsterCapsHtml = entry.mode === 'monster'
      ? `<div class="ds-pve-sched-mobcaps" style="margin-top:6px;padding:6px;background:#0f1013;border:1px solid #2a2c34;border-radius:5px;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px;">
              <span class="ds-note" style="margin:0;">Per-mob caps</span>
              <button type="button" class="ds-pve-sched-syncbtn ds-pve-sched-mobcap-sync" data-sched-node="${nodeId}" data-sched-idx="${idx}"
                      title="Overwrite this breakpoint's per-mob caps with the current values from the global Per-mob caps table. Any edits made here will be lost.">↻ Sync</button>
            </div>
            ${mobEntries.length
      ? mobEntries.map(([key, displayName]) => `
                <div class="ds-pve-mob-row" style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
                  <span style="font-size:11px;">${dsEscapeHtml(displayName)}</span>
                  <input type="number" class="ds-input ds-pve-sched-mobcap" min="0" step="1000"
                         data-sched-node="${nodeId}" data-sched-idx="${idx}" data-sched-mobkey="${dsEscapeHtml(key)}"
                         value="${entry.monsterCaps?.[key] ?? 0}" title="Damage cap (0 = skip)"
                         style="width:92px;flex-shrink:0;">
                </div>`).join('')
      : `<p class="ds-note" style="margin:0;">No mobs discovered yet for this node.</p>`}
          </div>`
      : '';

      const { h12, ampm } = pveHour24ToParts(entry.hour ?? 0);

      const timeControlsHtml = isNoTime
      ? `<button type="button" class="ds-iconbtn ds-time-picker-notime-chip" data-sched-node="${nodeId}" data-sched-idx="${idx}"
                   title="Default — this is what applies when no breakpoint has fired yet (before the earliest one, and on load). Click to give it a specific time instead.">+</button>`
      : `<div class="ds-time-picker">
             <input type="text" inputmode="numeric" maxlength="2" class="ds-pve-sched-h" data-sched-node="${nodeId}" data-sched-idx="${idx}" value="${String(h12).padStart(2, '0')}">
             <span class="ds-time-picker-colon">:</span>
             <input type="text" inputmode="numeric" maxlength="2" class="ds-pve-sched-m" data-sched-node="${nodeId}" data-sched-idx="${idx}" value="${String(entry.minute ?? 0).padStart(2, '0')}">
             <button type="button" class="ds-time-picker-ampm" data-sched-node="${nodeId}" data-sched-idx="${idx}" data-ampm="${ampm}" title="Toggle AM/PM">${ampm}</button>
           </div>
           <button type="button" class="ds-iconbtn ds-time-picker-clear" data-sched-node="${nodeId}" data-sched-idx="${idx}"
                   title="Clear time — makes this the node's default ('no time') breakpoint">×</button>`;

      return `<div class="ds-pve-sched-row${isNoTime ? ' notime' : ''}">
        <div class="ds-pve-sched-row-top">
          ${timeControlsHtml}
          <select class="ds-input ds-pve-sched-mode" data-sched-node="${nodeId}" data-sched-idx="${idx}"
                  style="flex:1;min-width:88px;">${modeOpts}</select>
          ${fixedInput}
          <button type="button" class="ds-iconbtn ds-pve-sched-del" data-sched-node="${nodeId}" data-sched-idx="${idx}" title="Remove breakpoint">✕</button>
        </div>
        ${monsterCapsHtml}
      </div>`;
    }).join('');

    const fallbackNote = (!noTimeItem && timedItems.length)
    ? `<p class="ds-note" style="margin:0 0 4px;">No default row — skips until the first breakpoint fires.</p>`
    : '';

    const howItWorksNote = `<p class="ds-note" style="margin:0 0 6px;">Each row's mode applies from its time until the next one fires.</p>`;

    return `<div class="ds-pve-sched-list" style="margin:6px 0;padding:6px;background:#0f1013;border:1px solid #2a2c34;border-radius:6px;">
      ${howItWorksNote}
      ${fallbackNote}
      ${rows || `<p class="ds-note" style="margin:0 0 4px;">No breakpoints set — this node won't be fought under Scheduled mode.</p>`}
      <button type="button" class="ds-seg-btn ds-pve-sched-add" data-sched-node="${nodeId}" style="width:100%;margin-top:4px;padding:4px 0;font-size:11px;">+ Add breakpoint</button>
    </div>`;
  }

  let pveSchedPopupEl     = null;
  let pveSchedPopupNodeId = null;
  let pveSchedPopupAnchor = null;

  function pveRenderSchedPopupBody(nodeId) {
    const profile  = pveGetProfile();
    const schedule = profile.nodeSchedules?.[nodeId] || [];
    const label    = PVE_NODE_LABELS[nodeId] || `Node ${nodeId}`;
    return `
      <div class="ds-ffa-head">
        <div class="ds-ffa-title">${label} — Scheduled caps</div>
        <button class="ds-ffa-close" type="button">×</button>
      </div>
      ${pveRenderScheduleRowsHTML(nodeId, schedule)}`;
  }

  function pvePositionPopover(el, anchor) {
    const rect = anchor.getBoundingClientRect();
    const MARGIN = 8;
    const w = el.offsetWidth, h = el.offsetHeight;
    let left = Math.max(MARGIN, Math.min(rect.left, window.innerWidth - w - MARGIN));
    let top  = rect.bottom + MARGIN;
    if (top + h > window.innerHeight - MARGIN) {
      const aboveTop = rect.top - h - MARGIN;
      top = aboveTop >= MARGIN ? aboveTop : Math.max(MARGIN, window.innerHeight - h - MARGIN);
    }
    el.style.left = `${left}px`;
    el.style.top  = `${top}px`;
  }

  function closePveSchedPopup() {
    if (!pveSchedPopupEl) return;
    pveSchedPopupEl.remove();
    pveSchedPopupEl = null;
    pveSchedPopupNodeId = null;
    pveSchedPopupAnchor = null;
    document.removeEventListener('mousedown', onPveSchedOutsideClick, true);
    window.removeEventListener('keydown', onPveSchedEscKey, true);
  }
  function onPveSchedOutsideClick(e) {
    if (!pveSchedPopupEl) return;
    if (pveSchedPopupEl.contains(e.target) || e.target.closest?.('.ds-pve-sched-open')) return;
    closePveSchedPopup();
  }
  function onPveSchedEscKey(e) { if (e.key === 'Escape') closePveSchedPopup(); }

  function pveRefreshSchedPopup(nodeId) {
    if (!pveSchedPopupEl || pveSchedPopupNodeId !== nodeId) return;
    pveSchedPopupEl.innerHTML = pveRenderSchedPopupBody(nodeId);
    pveSchedPopupEl.querySelector('.ds-ffa-close')?.addEventListener('click', closePveSchedPopup);
    if (pveSchedPopupAnchor?.isConnected) pvePositionPopover(pveSchedPopupEl, pveSchedPopupAnchor);
  }

  function pveHandleSchedRowChange(e, nodeId) {
    const schedH = e.target.closest('.ds-pve-sched-h');
    const schedM = e.target.closest('.ds-pve-sched-m');
    if (schedH || schedM) {
      const idx    = Number((schedH || schedM).dataset.schedIdx);
      const wrap   = (schedH || schedM).closest('.ds-time-picker');
      const hEl    = wrap.querySelector('.ds-pve-sched-h');
      const mEl    = wrap.querySelector('.ds-pve-sched-m');
      const ampmEl = wrap.querySelector('.ds-time-picker-ampm');
      const ampm   = ampmEl?.dataset.ampm === 'PM' ? 'PM' : 'AM';
      const h12 = Math.min(12, Math.max(1, parseInt(hEl.value, 10) || 12));
      const m   = Math.min(59, Math.max(0, parseInt(mEl.value, 10) || 0));
      hEl.value = String(h12).padStart(2, '0');
      mEl.value = String(m).padStart(2, '0');
      const h24 = pveHour12ToHour24(h12, ampm);
      pveUpdateProfile(p => {
        const list = (p.nodeSchedules || (p.nodeSchedules = {}))[nodeId] || (p.nodeSchedules[nodeId] = []);
        if (list[idx]) { list[idx].hour = h24; list[idx].minute = m; }
      }, { resetActionableNodeId: nodeId });
      pveVerifyNodeSoon(nodeId);
      return;
    }
    const schedMode = e.target.closest('.ds-pve-sched-mode');
    if (schedMode) {
      const idx = Number(schedMode.dataset.schedIdx);
      pveUpdateProfile(p => {
        const list = (p.nodeSchedules || (p.nodeSchedules = {}))[nodeId] || (p.nodeSchedules[nodeId] = []);
        if (!list[idx]) return;
        list[idx].mode = schedMode.value;
        if (schedMode.value === 'monster' && !list[idx].monsterCaps) {
          list[idx].monsterCaps = { ...p.monsterCaps };
        }
      }, { resetActionableNodeId: nodeId });
      pveVerifyNodeSoon(nodeId);
      pveRefreshSchedPopup(nodeId); // fixed-cap / mob-cap fields appear based on mode
      return;
    }
    const schedFixed = e.target.closest('.ds-pve-sched-fixedcap');
    if (schedFixed) {
      const idx = Number(schedFixed.dataset.schedIdx);
      const val = Math.max(0, parseInt(schedFixed.value, 10) || 0);
      pveUpdateProfile(p => {
        const list = (p.nodeSchedules || (p.nodeSchedules = {}))[nodeId] || (p.nodeSchedules[nodeId] = []);
        if (list[idx]) list[idx].fixedCap = val;
      }, { resetActionableNodeId: nodeId });
      pveVerifyNodeSoon(nodeId);
      return;
    }
    const schedMobCap = e.target.closest('.ds-pve-sched-mobcap');
    if (schedMobCap) {
      const idx = Number(schedMobCap.dataset.schedIdx);
      const key = schedMobCap.dataset.schedMobkey;
      const val = Math.max(0, parseInt(schedMobCap.value, 10) || 0);
      pveUpdateProfile(p => {
        const list = (p.nodeSchedules || (p.nodeSchedules = {}))[nodeId] || (p.nodeSchedules[nodeId] = []);
        if (!list[idx]) return;
        if (!list[idx].monsterCaps) list[idx].monsterCaps = {};
        list[idx].monsterCaps[key] = val;
      }, { resetActionableNodeId: nodeId });
      pveVerifyNodeSoon(nodeId);
    }
  }

  function pveHandleSchedRowClick(e, nodeId) {
    const clearBtn = e.target.closest('.ds-time-picker-clear');
    if (clearBtn) {
      const idx = Number(clearBtn.dataset.schedIdx);
      pveUpdateProfile(p => {
        const list = (p.nodeSchedules || (p.nodeSchedules = {}))[nodeId] || (p.nodeSchedules[nodeId] = []);
        if (!list[idx]) return;
        list.forEach((e2, i2) => { if (i2 !== idx) e2.noTime = false; });
        list[idx].noTime = true;
      }, { resetActionableNodeId: nodeId });
      pveVerifyNodeSoon(nodeId);
      pveRefreshSchedPopup(nodeId); // swaps the row to the "No time" chip, reorders, updates fallback note
      return;
    }
    const noTimeChip = e.target.closest('.ds-time-picker-notime-chip');
    if (noTimeChip) {
      const idx = Number(noTimeChip.dataset.schedIdx);
      pveUpdateProfile(p => {
        const list = (p.nodeSchedules || (p.nodeSchedules = {}))[nodeId] || (p.nodeSchedules[nodeId] = []);
        if (list[idx]) list[idx].noTime = false; // keeps whatever hour/minute it last held (00:00 if none yet)
      }, { resetActionableNodeId: nodeId });
      pveVerifyNodeSoon(nodeId);
      pveRefreshSchedPopup(nodeId); // swaps the chip back to hour/minute selects
      return;
    }
    const ampmBtn = e.target.closest('.ds-time-picker-ampm');
    if (ampmBtn) {
      const idx = Number(ampmBtn.dataset.schedIdx);
      const newAmpm = ampmBtn.dataset.ampm === 'PM' ? 'AM' : 'PM';
      ampmBtn.dataset.ampm = newAmpm;
      ampmBtn.textContent = newAmpm;
      const wrap = ampmBtn.closest('.ds-time-picker');
      const hEl  = wrap?.querySelector('.ds-pve-sched-h');
      const h12  = Math.min(12, Math.max(1, parseInt(hEl?.value, 10) || 12));
      const h24  = pveHour12ToHour24(h12, newAmpm);
      pveUpdateProfile(p => {
        const list = (p.nodeSchedules || (p.nodeSchedules = {}))[nodeId] || (p.nodeSchedules[nodeId] = []);
        if (list[idx]) list[idx].hour = h24;
      }, { resetActionableNodeId: nodeId });
      pveVerifyNodeSoon(nodeId);
      return;
    }
    const syncBtn = e.target.closest('.ds-pve-sched-mobcap-sync');
    if (syncBtn) {
      const idx = Number(syncBtn.dataset.schedIdx);
      const ok = confirm('Overwrite this breakpoint\'s per-mob caps with the current global Per-mob caps? Any edits made here will be lost.');
      if (!ok) return;
      pveUpdateProfile(p => {
        const list = p.nodeSchedules?.[nodeId];
        if (list?.[idx]) list[idx].monsterCaps = { ...p.monsterCaps };
      }, { resetActionableNodeId: nodeId });
      pveVerifyNodeSoon(nodeId);
      pveRefreshSchedPopup(nodeId);
      return;
    }
    const addBtn = e.target.closest('.ds-pve-sched-add');
    if (addBtn) {
      pveUpdateProfile(p => {
        const list = (p.nodeSchedules || (p.nodeSchedules = {}))[nodeId] || (p.nodeSchedules[nodeId] = []);
        list.push({ hour: 0, minute: 0, mode: 'exp' });
      }, { resetActionableNodeId: nodeId });
      pveVerifyNodeSoon(nodeId);
      pveRefreshSchedPopup(nodeId);
      return;
    }
    const delBtn = e.target.closest('.ds-pve-sched-del');
    if (delBtn) {
      const idx = Number(delBtn.dataset.schedIdx);
      pveUpdateProfile(p => {
        const list = p.nodeSchedules?.[nodeId];
        if (list) list.splice(idx, 1);
      }, { resetActionableNodeId: nodeId });
      pveVerifyNodeSoon(nodeId);
      pveRefreshSchedPopup(nodeId);
    }
  }

  function openPveSchedPopup(nodeId, anchor) {
    closePveSchedPopup();
    closeFfaPopup(); // only one floating popover at a time

    const el = document.createElement('div');
    el.className = 'ds-ffa-popover';
    el.style.visibility = 'hidden';
    el.innerHTML = pveRenderSchedPopupBody(nodeId);
    document.body.appendChild(el);
    pvePositionPopover(el, anchor);
    el.style.visibility = '';

    pveSchedPopupEl = el;
    pveSchedPopupNodeId = nodeId;
    pveSchedPopupAnchor = anchor;

    el.querySelector('.ds-ffa-close')?.addEventListener('click', closePveSchedPopup);
    el.addEventListener('change', e => pveHandleSchedRowChange(e, nodeId));
    el.addEventListener('click',  e => pveHandleSchedRowClick(e, nodeId));
    el.addEventListener('input', e => pveHandleSchedRowInput(e));

    document.addEventListener('mousedown', onPveSchedOutsideClick, true);
    window.addEventListener('keydown', onPveSchedEscKey, true);
  }

  function pveHandleSchedRowInput(e) {
    const el = e.target;
    const isH = el.classList.contains('ds-pve-sched-h');
    const isM = el.classList.contains('ds-pve-sched-m');
    if (!isH && !isM) return;
    const digits = el.value.replace(/\D/g, '').slice(0, 2);
    if (digits !== el.value) el.value = digits;
    if (digits.length === 2) {
      if (isH) {
        const m = el.closest('.ds-time-picker')?.querySelector('.ds-pve-sched-m');
        if (m) { m.focus(); m.select(); }
      } else {
        el.blur(); // minute is the last box — drop focus, which commits via 'change'
      }
    }
  }

  function pveGetNodeMobEntries(nodeId) {
    const discoveredMap = pveDiscoveredMobsByNode[nodeId] || new Map();
    const mobMap = new Map();

    for (const name of (PVE_KNOWN_MOBS[nodeId] || [])) {
      mobMap.set(normText(name), name);
    }

    for (const [key, name] of discoveredMap) {
      mobMap.set(key, name);
    }

    for (const entry of pveMobState.values()) {
      if (Number(entry.nodeId) !== nodeId || !entry.name) continue;
      mobMap.set(normText(entry.name), entry.name);
    }

    return [...mobMap.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }

  function pveRenderNodePanelsHTML(profile) {
    return PVE_TARGET_NODES.map(nodeId => {
      const label         = PVE_NODE_LABELS[nodeId] || `Node ${nodeId}`;
      const locked        = pveNodeStats[nodeId]?.locked;
      const allClear      = pveNodeStats[nodeId]?.allClear;
      const noActionable  = pveNodeStats[nodeId]?.noActionable;
      const isCollapsed   = pveCollapsedNodes.has(nodeId);

      const entries     = pveGetNodeMobEntries(nodeId);
      const hasKey      = Object.prototype.hasOwnProperty.call(profile.selectedMobsByNode, nodeId);
      const selected    = new Set(profile.selectedMobsByNode[nodeId] || []);
      const monsterMode = profile.damageMode === 'monster';
      const deadSet     = pveDeadNamesByNode[nodeId] || new Set();

      const rows = entries.length
      ? entries.map(([key, displayName]) => {
        const isDead  = deadSet.has(key);
        const checked = monsterMode
        ? selected.has(key)
        : (hasKey ? selected.has(key) : true);

        const nameHtml = isDead
        ? `<span style="text-decoration:line-through;opacity:0.55;">💀 ${dsEscapeHtml(displayName)}</span>`
        : dsEscapeHtml(displayName);

        const capInput = monsterMode
        ? `<input type="number" class="ds-input ds-pve-cap-input" min="0" step="1000"
                   data-pve-cap-name="${dsEscapeHtml(key)}" data-pve-cap-node="${nodeId}"
                   value="${profile.monsterCaps[key] ?? 0}" title="Damage cap (0 = skip)">`
        : '';

        return `<div class="ds-pve-mob-row">
              <label><input type="checkbox" data-pve-mob-node="${nodeId}" data-pve-mob-name="${dsEscapeHtml(key)}" ${checked ? 'checked' : ''}>${nameHtml}</label>
              ${capInput}
            </div>`
      }).join('')
      : `<p class="ds-note" style="margin:4px 0 0;">No mobs available.</p>`;

      const statusPill = locked        ? ' <span class="ds-pill ds-pill-locked">locked</span>'
      : allClear      ? ' <span class="ds-pill ds-pill-cleared">cleared</span>'
      : noActionable  ? ' <span class="ds-pill ds-pill-mon">capped</span>'
      : pveNodeStats[nodeId] ? ' <span class="ds-pill ds-pill-avail">active</span>'
      : '';
      const countTag   = entries.length ? ` · ${entries.length} monster type${entries.length === 1 ? '' : 's'}` : '';
      const chevron    = isCollapsed ? '▸' : '▾';

      const showSchedule = profile.damageMode === 'scheduled' && !dsIsFastMode();
      const schedCount   = (profile.nodeSchedules?.[nodeId] || []).length;
      const schedBtnHtml = showSchedule
      ? `<button type="button" class="ds-iconbtn ds-pve-sched-open" data-sched-open-node="${nodeId}"
                    title="Edit scheduled caps for this node${schedCount ? ` (${schedCount} breakpoint${schedCount === 1 ? '' : 's'})` : ' — none set'}">⏰</button>`
      : '';

      return `<div class="ds-pve-node-block">
        <div class="ds-pve-node-header" data-node-toggle="${nodeId}">
          <span class="ds-pve-hdr-label">${label} (N${nodeId})${countTag}${statusPill}</span>
          ${schedBtnHtml}
          <span style="color:#8b8d98;font-size:10px;">${chevron}</span>
        </div>
        ${isCollapsed ? '' : `<div style="margin-top:6px;" data-pve-node-rows="${nodeId}">${rows}</div>`}
      </div>`;
    }).join('');
  }

  function renderSANodeList(instanceId) {
    if (!instanceId) return '';
    const partKeys = new Set(saLoadParticipated(instanceId).keys);
    const isFast   = dsIsFastMode();

    return SA_TARGET_NODES.map(nodeId => {
      const isLocked = saLockedNodesLogged.has(nodeId);
      const stats    = saNodeStats[nodeId];
      const bstate   = saLastBattleState[nodeId];
      const fought   = [...partKeys].filter(k => k.startsWith(`${nodeId}:`)).length;
      const total    = stats?.total ?? 0;

      let statusText, statusCol;
      if (isLocked) {
        statusText = 'locked'; statusCol = '#52535c';
      } else if (!stats || stats.scanning) {
        statusText = 'scanning…'; statusCol = '#71727d';
      } else if (stats.allCleared) {
        statusText = 'all cleared'; statusCol = '#a78bfa';
      } else if (stats.activeFightNo > 0) {
        const nukeMatchNo = saScheduledNukingMatch.get(nodeId);
        const isNuking = isFast
        || (nukeMatchNo != null && nukeMatchNo === stats.activeFightNo)
        || !!stats.schedNukeActive;
        const isJoined = partKeys.has(`${nodeId}:${stats.activeFightNo}`);

        if (isNuking) {
          statusText = (total > 0 && fought >= total)
            ? `Nuking #${stats.activeFightNo} · waiting to finish`
          : `Nuking fight #${stats.activeFightNo}${total > 0 ? ` / ${total}` : ''}`;
        } else if (isJoined) {
          statusText = `joined · fight #${stats.activeFightNo}`;
        } else {
          statusText = `Fighting fight #${stats.activeFightNo}${total > 0 ? ` / ${total}` : ''}`;
        }
        statusCol = '#60a5fa';
      } else if (stats.justFought) {
        const allDone = total > 0 && fought >= total;
        statusText = allDone
          ? `✓ all ${total} fight${total > 1 ? 's' : ''} participated`
        : `✓ fought #${stats.lastFightNo ?? '?'} · ${fought}/${total || '?'} done`;
        statusCol = allDone ? '#a78bfa' : '#34d399';
      } else if (stats.hasAvailable) {
        statusText = 'available'; statusCol = '#4ade80';
      } else {
        statusText = 'waiting'; statusCol = '#71727d';
      }

      const progressHtml = total > 0
      ? `<span style="font-size:10px;color:#52535c;margin-left:auto;flex-shrink:0;">${fought}/${total}</span>`
      : '';

      let captainHtml = '';
      if (bstate?.captains?.length && stats && !isLocked && !stats.allCleared) {
        const engMap  = new Map((bstate.engagements || []).map(e =>
                                                               [Number(e.attacker_captain_unit_id), Number(e.defender_captain_unit_id)]));
        const mine    = bstate.captains.filter(c => c.side === 'ALLY' && c.is_mine);
        const enemies = new Map(bstate.captains.filter(c => c.side === 'ENEMY').map(c => [Number(c.id), c]));

        const rows = mine.map(c => {
          const capName = dsEscapeHtml(c.name || c.display_name || `Gen.${c.id}`);

          if (c.is_dead) {
            return `<div style="font-size:10px;color:#ff6b6b;padding:2px 0;">💀 ${capName} KO'd</div>`;
          }

          const defId = engMap.get(Number(c.id));
          const enemy = defId ? enemies.get(defId) : null;
          if (enemy) {
            const enName = dsEscapeHtml(enemy.name || enemy.display_name || `E.${enemy.id}`);
            return `<div style="display:flex;align-items:center;gap:5px;font-size:10px;color:#c4c5cc;padding:2px 0;">
              <span style="color:#60a5fa;flex-shrink:0;">⚔</span>
              <span style="flex:0 1 120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${capName}</span>
              <span style="color:#6b7280;flex-shrink:0;">→</span>
              <span style="color:#a5a6f6;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${enName}</span>
            </div>`;
          }
          return `<div style="font-size:10px;color:#52535c;padding:2px 0;">· ${capName} idle</div>`;
        }).join('');

        if (rows) captainHtml = `<div style="margin-top:5px;padding-top:5px;border-top:1px solid #1e1f25;">${rows}</div>`;
      }

      return `<div class="ds-sa-node-card">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:9.5px;font-weight:700;letter-spacing:.05em;color:#52535c;background:#1c1d23;border:1px solid #2a2c34;border-radius:4px;padding:2px 6px;flex-shrink:0;">N${nodeId}</span>
          <span style="font-size:11px;color:${statusCol};font-weight:500;">${statusText}</span>
          ${progressHtml}
        </div>
        ${captainHtml}
      </div>`;
    }).join('');
  }

  function renderPvPNodeList() {
    const fastMode  = dsIsFastMode();
    const fastState = pvpLoadFastRunState();

    return PVP_NODE_PRIORITY.map(nodeId => {
      const isLocked = pvpLockedNodesLogged.has(nodeId);
      const stats    = pvpNodeStats[nodeId];
      const matches  = pvpLastNodeMatches[nodeId];
      const label    = PVP_NODE_TITLES[nodeId] || `Node ${nodeId}`;
      const cdStr    = pvpGetLiveCooldownStr(nodeId); // this node's own cooldown only

      let statusText, statusCol;
      if (isLocked || stats?.locked) {
        statusText = 'locked'; statusCol = '#52535c';
      } else if (!stats) {
        statusText = 'scanning…'; statusCol = '#71727d';
      } else if (stats.allCleared) {
        statusText = 'all cleared'; statusCol = '#a78bfa';
      } else if (stats.liveWithoutUs) {
        statusText = 'live w/o us — reassign'; statusCol = '#ff6b6b';
      } else if (stats.hasSelf) {
        const ourMatch = matches?.find(m => m.hasSelf && !m.clearedBadge);
        statusText = ourMatch ? `joined · match #${ourMatch.matchNo}` : 'joined';
        statusCol  = '#60a5fa';
      } else if (stats.onCooldown) {
        statusText = cdStr ? `cooldown · ${cdStr} left` : 'cooldown';
        statusCol  = '#f59e0b';
      } else if (stats.hasOpen) {
        statusText = 'available'; statusCol = '#4ade80';
      } else {
        statusText = stats.matchCount > 0 ? 'no open matches' : 'waiting';
        statusCol  = '#71727d';
      }

      let assignHtml = '';
      if (fastMode) {
        const matchNo = nodeId === 7 ? fastState.node7MatchNo : fastState.node8MatchNo;
        const res     = pvpGetMatchResult(fastState, nodeId, matchNo);
        const joined  = res.joined;
        const cleared = res.cleared;
        const tag = !matchNo
        ? `<span style="color:#52535c;">target: not assigned</span>`
        : cleared
        ? `<span style="color:#a78bfa;">target #${matchNo} · cleared</span>`
        : joined
        ? `<span style="color:#60a5fa;">target #${matchNo} · joined</span>`
        : `<span style="color:#c4c5cc;">target #${matchNo} · waiting to join</span>`;
        assignHtml = `<div style="margin-top:5px;padding-top:5px;border-top:1px solid #1e1f25;font-size:10px;">${tag}</div>`;
      }

      let breakdownHtml = '';
      if (matches?.length) {
        let cleared = 0, joined = 0, live = 0, available = 0, full = 0;
        for (const m of matches) {
          if      (m.clearedBadge)  cleared++;
          else if (m.hasSelf)       joined++;
          else if (m.isInProgress)  live++;
          else if (m.openSlots > 0) available++;
          else                      full++;
        }
        const chips = [];
        if (cleared)   chips.push(`<span style="color:#a78bfa;">${cleared} cleared</span>`);
        if (joined)    chips.push(`<span style="color:#60a5fa;">${joined} joined</span>`);
        if (live)      chips.push(`<span style="color:#f59e0b;">${live} live</span>`);
        if (available) chips.push(`<span style="color:#4ade80;">${available} open</span>`);
        if (full)      chips.push(`<span style="color:#52535c;">${full} full</span>`);
        breakdownHtml = `<div style="margin-top:5px;padding-top:5px;border-top:1px solid #1e1f25;font-size:10px;color:#c4c5cc;display:flex;gap:8px;flex-wrap:wrap;">` +
          `<span style="color:#52535c;">${matches.length} total ·</span> ` + chips.join(' · ') +
          `</div>`;
      }

      return `<div class="ds-sa-node-card">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:9.5px;font-weight:700;letter-spacing:.05em;color:#52535c;background:#1c1d23;border:1px solid #2a2c34;border-radius:4px;padding:2px 6px;flex-shrink:0;">N${nodeId}</span>
          <span style="font-size:11px;color:#c4c5cc;font-weight:600;">${label}</span>
          <span style="font-size:11px;color:${statusCol};font-weight:500;margin-left:auto;flex-shrink:0;">${statusText}</span>
        </div>
        ${assignHtml}
        ${breakdownHtml}
      </div>`;
    }).join('');
  }

  function refreshUI() {
    if (!uiBox || !uiBox.isConnected) return;
    const fastMode = dsIsFastMode();
    const pvpState = pvpLoadFastRunState();
    const iid      = currentInstanceId;
    const saCount  = iid ? saGetParticipatedCount(iid) : 0;

    uiBox.classList.toggle('ds-collapsed', collapsed);
    uiBox.querySelector('#ds-master-toggle').checked = masterEnabled;

    const dot = uiBox.querySelector('#ds-dot');
    dot.classList.toggle('on',         masterEnabled && !!iid);
    dot.classList.toggle('monitoring', !masterEnabled && !!iid);

    uiBox.querySelector('#ds-inst').textContent = iid ? `· #${iid}` : '· idle';

    uiBox.querySelector('.ds-seg-btn[data-mode="normal"]').classList.toggle('active', !fastMode);
    uiBox.querySelector('.ds-seg-btn[data-mode="fast"]').classList.toggle('active',    fastMode);
    uiBox.querySelectorAll('.ds-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === activeTab));
    uiBox.querySelectorAll('.ds-tabpanel').forEach(p => p.classList.toggle('active', p.dataset.tab === activeTab));

    uiBox.querySelector('#ds-pvp-normal').style.display = fastMode ? 'none' : 'block';
    uiBox.querySelector('#ds-pvp-fast').style.display   = fastMode ? 'block' : 'none';

    const pvpStatusEl = uiBox.querySelector('#ds-status-pvp');
    const monTag = masterEnabled ? '' : ' (monitoring)';
    if (!fastMode) {
      const scheduleEntry = pvpGetEffectiveScheduleEntry();
      const effLimit  = scheduleEntry?.limit ?? 6;
      const isFfaNow  = scheduleEntry?.label === 'ffa';
      const countStr  = pvpHasScanned ? String(pvpLiveJoinCount) : '?';
      const pvpDone   = pvpHasScanned && pvpLiveJoinCount >= effLimit;
      pvpStatusEl.textContent = iid
        ? pvpDone
        ? `Normal${monTag} — ✓ ${pvpLiveJoinCount}/${effLimit} joined${isFfaNow ? ' (FFA)' : ''} — done for this instance`
      : isFfaNow
        ? `Normal${monTag} — ${countStr}/${effLimit} joins (FFA)`
      : `Normal${monTag} — ${countStr}/${effLimit} joins (FFA opens 4PM → cap 40)`
      : 'Normal — no active instance';
    } else {
      const role  = pvpState.isLeader ? 'Leader/Vice' : 'Player';
      const parts = [];
      if (pvpState.node7MatchNo) parts.push(`N7 #${pvpState.node7MatchNo}`);
      if (pvpState.node8MatchNo) parts.push(`N8 #${pvpState.node8MatchNo}`);
      const res7 = pvpGetMatchResult(pvpState, 7, pvpState.node7MatchNo);
      const res8 = pvpGetMatchResult(pvpState, 8, pvpState.node8MatchNo);
      const fastDone = parts.length > 0 &&
            (!pvpState.node7MatchNo || res7.cleared) &&
            (!pvpState.node8MatchNo || res8.cleared);
      pvpStatusEl.textContent = fastDone
        ? `Fast Run${monTag} — ${role} — ✓ all targets cleared`
      : `Fast Run${monTag} — ${role} — ${parts.length ? parts.join(' · ') : 'not assigned'}`;
    }
    const pvpPillsEl = uiBox.querySelector('#ds-pvp-pills');
    if (pvpPillsEl) {

      const nodePills = iid ? PVP_NODE_PRIORITY.map(nodeId => {
        if (fastMode) {
          const isLocked = pvpLockedNodesLogged.has(nodeId);
          if (isLocked) return `<span class="ds-pill ds-pill-locked">N${nodeId} · locked</span>`;

          const matchNo = nodeId === 7 ? pvpState.node7MatchNo : pvpState.node8MatchNo;
          const res     = pvpGetMatchResult(pvpState, nodeId, matchNo);
          if (res.cleared) return `<span class="ds-pill ds-pill-cleared">N${nodeId} · cleared</span>`;
          if (res.joined)  return `<span class="ds-pill ds-pill-joined">N${nodeId} · joined</span>`;
          if (!matchNo)     return `<span class="ds-pill ds-pill-locked">N${nodeId} · not assigned</span>`;
          const stats = pvpNodeStats[nodeId];
          if (!stats)              return `<span class="ds-pill ds-pill-mon">N${nodeId} · waiting</span>`;
          if (stats.allCleared)    return `<span class="ds-pill ds-pill-cleared">N${nodeId} · cleared</span>`;
          if (stats.liveWithoutUs) return `<span class="ds-pill ds-pill-cd">N${nodeId} · live w/o us — reassign</span>`;
          if (stats.hasSelf)       return `<span class="ds-pill ds-pill-joined">N${nodeId} · joined</span>`;
          if (stats.onCooldown) {
            const cd = pvpGetLiveCooldownStr(nodeId);
            return `<span class="ds-pill ds-pill-cd">N${nodeId} · cooldown${cd ? ` 🔒 ${cd}` : ''}</span>`;
          }
          if (stats.hasOpen)       return `<span class="ds-pill ds-pill-avail">N${nodeId} · available</span>`;
          return `<span class="ds-pill ds-pill-mon">N${nodeId} · waiting</span>`;
        }
        const isLocked = pvpLockedNodesLogged.has(nodeId);
        if (isLocked) return `<span class="ds-pill ds-pill-locked">N${nodeId} · locked</span>`;
        const stats = pvpNodeStats[nodeId];
        if (!stats)           return `<span class="ds-pill ds-pill-mon">N${nodeId} · waiting</span>`;
        if (stats.locked)     return `<span class="ds-pill ds-pill-locked">N${nodeId} · locked</span>`;
        if (stats.allCleared) return `<span class="ds-pill ds-pill-cleared">N${nodeId} · cleared</span>`;
        if (stats.hasSelf)    return `<span class="ds-pill ds-pill-joined">N${nodeId} · joined</span>`;
        if (stats.onCooldown) {
          const cd = pvpGetLiveCooldownStr(nodeId);
          return `<span class="ds-pill ds-pill-cd">N${nodeId} · cooldown${cd ? ` 🔒 ${cd}` : ''}</span>`;
        }
        if (stats.hasOpen)    return `<span class="ds-pill ds-pill-avail">N${nodeId} · available</span>`;
        return `<span class="ds-pill ds-pill-mon">N${nodeId} · no matches</span>`;
      }).join('') : '';

      const tStats = pvpNodeStats[PVP_TYRANT_NODE_ID];
      let tyrantPill;
      if (!pvpTyrantEnabled)            tyrantPill = `<span class="ds-pill ds-pill-locked">N9 · Tyrant off</span>`;
      else if (!tStats || tStats.hidden) tyrantPill = `<span class="ds-pill ds-pill-mon">N9 · Tyrant waiting</span>`;
      else if (tStats.locked)           tyrantPill = `<span class="ds-pill ds-pill-locked">N9 · Tyrant locked</span>`;
      else if (tStats.allCleared)       tyrantPill = `<span class="ds-pill ds-pill-cleared">N9 · Tyrant cleared</span>`;
      else if (tStats.hasSelf)          tyrantPill = `<span class="ds-pill ds-pill-joined">N9 · Tyrant joined</span>`;
      else if (tStats.onCooldown) {
        const cd = pvpGetLiveCooldownStr(PVP_TYRANT_NODE_ID);
        tyrantPill = `<span class="ds-pill ds-pill-cd">N9 · Tyrant cooldown${cd ? ` 🔒 ${cd}` : ''}</span>`;
      }
      else if (tStats.hasOpen)          tyrantPill = `<span class="ds-pill ds-pill-avail">N9 · Tyrant available</span>`;
      else                              tyrantPill = `<span class="ds-pill ds-pill-mon">N9 · Tyrant no matches</span>`;

      pvpPillsEl.innerHTML = nodePills + tyrantPill;   // no more standalone cdPill
    }
    for (const nodeId of [7, 8]) {
      const input   = uiBox.querySelector(`.ds-input[data-node="${nodeId}"]`);
      const matchNo = nodeId === 7 ? pvpState.node7MatchNo : pvpState.node8MatchNo;
      const res     = pvpGetMatchResult(pvpState, nodeId, matchNo);
      if (input && !input.matches(':focus')) input.value = matchNo;
      const st = uiBox.querySelector(`.ds-field-status[data-node="${nodeId}"]`);
      if (st) {
        st.classList.toggle('done', !!res.joined);
        st.textContent = !matchNo ? 'not assigned' : res.cleared ? '✓ finished' : res.joined  ? '✓ joined' : 'waiting to join';
      }
    }

    const saSchedNukeEl = uiBox.querySelector('#ds-sa-sched-nuke');
    if (saSchedNukeEl) saSchedNukeEl.checked = saScheduledNukeEnabled;

    const pvpNodeListEl = uiBox.querySelector('#ds-pvp-match-list');
    if (pvpNodeListEl) pvpNodeListEl.innerHTML = renderPvPNodeList();

    uiBox.querySelector('#ds-leader-toggle').checked = pvpState.isLeader;
    uiBox.querySelector('#ds-tyrant-toggle').checked = pvpTyrantEnabled;

    const saStatusEl = uiBox.querySelector('#ds-status-sa');
    const saMode = fastMode ? 'Fast Run (nuke)' : 'Ordinary (retreat)';
    saStatusEl.textContent = iid
      ? saAllClearedForNow
      ? `${saMode}${monTag} — ✓ all fights cleared — awaiting dungeon reset`
    : `${saMode}${monTag} — ${saCount} fight(s) participated this instance`
    : `${saMode} — no active instance`;

    const saPillsEl = uiBox.querySelector('#ds-sa-pills');
    if (saPillsEl) {
      if (iid) {
        const partKeys = saLoadParticipated(iid).keys;
        const perNode  = {};
        for (const k of partKeys) { const [nid] = k.split(':'); perNode[nid] = (perNode[nid] || 0) + 1; }

        saPillsEl.innerHTML = SA_TARGET_NODES.map(nodeId => {
          const isLocked = saLockedNodesLogged.has(nodeId);
          if (isLocked) return `<span class="ds-pill ds-pill-locked">N${nodeId} · locked</span>`;
          const stats  = saNodeStats[nodeId];
          const fought = perNode[String(nodeId)] || 0;
          if (!stats)
            return masterEnabled
              ? `<span class="ds-pill ds-pill-mon">N${nodeId} · scanning…</span>`
            : `<span class="ds-pill ds-pill-mon">N${nodeId} · monitoring</span>`;
          if (stats.scanning)
            return `<span class="ds-pill ds-pill-mon">N${nodeId} · scanning…</span>`;
          if (stats.allCleared) {
            const countTag = stats.total > 0 ? ` · ${fought}/${stats.total} done` : '';
            return `<span class="ds-pill ds-pill-cleared">N${nodeId}${countTag}</span>`;
          }
          if (stats.activeFightNo > 0) {
            const label = partKeys.includes(`${nodeId}:${stats.activeFightNo}`) ? 'joined' : 'in fight';
            return `<span class="ds-pill ds-pill-joined">N${nodeId} · ${label}</span>`;
          }
          if (stats.hasAvailable)
            return `<span class="ds-pill ds-pill-avail">N${nodeId} · available</span>`;
          if (stats.justFought) {
            if (stats.total > 0 && fought >= stats.total)
              return `<span class="ds-pill ds-pill-cleared">N${nodeId} · all done</span>`;
            return `<span class="ds-pill ds-pill-joined">N${nodeId} · fought</span>`;
          }
          return fought > 0
            ? `<span class="ds-pill ds-pill-mon">N${nodeId} · ${fought} done</span>`
          : `<span class="ds-pill ds-pill-mon">N${nodeId} · waiting</span>`;
        }).join('');
      } else {
        saPillsEl.innerHTML = '';
      }
    }
    const saNoteEl = uiBox.querySelector('#ds-sa-note');
    if (saNoteEl) {
      saNoteEl.textContent = fastMode
        ? `All idle captains commit to the current fight (spread across enemies), no retreat — A captain is locked to that fight until it clears. Nodes: ${SA_TARGET_NODES.join(', ')}.`
      : `1 captain per fight — hits all enemies, then retreats.  Nodes: ${SA_TARGET_NODES.join(', ')}.`;
    }

    const saNodeListEl = uiBox.querySelector('#ds-sa-node-list');
    if (saNodeListEl) saNodeListEl.innerHTML = renderSANodeList(iid);

    const pveProfile = pveGetProfile();

    const pveStatusEl = uiBox.querySelector('#ds-status-pve');
    if (pveStatusEl) {
      const scannedRows = PVE_TARGET_NODES.map(id => pveNodeStats[id]).filter(Boolean);
      const unlocked = scannedRows.filter(r => !r.locked);
      const cleared  = unlocked.filter(r => r.allClear);
      const profileLabel = pveActiveProfileKey() === 'fast' ? 'Fast Run' : 'Normal';

      pveStatusEl.textContent = iid
        ? pveStaminaWaiting
        ? `PvE${monTag} — ${profileLabel} profile — waiting for stamina to recover`
      : !scannedRows.length
        ? `PvE${monTag} — ${profileLabel} profile — scanning…`
      : `PvE${monTag} — ${profileLabel} profile — ${unlocked.length - cleared.length} active node(s), ${cleared.length} clear`
      : 'PvE — no active instance';
    }

    const pvePillsEl = uiBox.querySelector('#ds-pve-pills');
    if (pvePillsEl) {
      pvePillsEl.innerHTML = PVE_TARGET_NODES.map(id => {
        const r = pveNodeStats[id];
        const label = PVE_NODE_LABELS[id] || `N${id}`;

        if (!r)              return `<span class="ds-pill ds-pill-mon">${label} · waiting</span>`;
        if (r.locked)        return `<span class="ds-pill ds-pill-locked">${label} · locked</span>`;
        if (r.attacking)     return `<span class="ds-pill ds-pill-joined">${label} · attacking</span>`;
        if (r.scanning)      return `<span class="ds-pill ds-pill-mon">${label} · scanning</span>`;
        if (r.allClear)      return `<span class="ds-pill ds-pill-cleared">${label} · clear</span>`;
        if (r.schedWait)     return `<span class="ds-pill ds-pill-mon">${label} · waits ${r.schedWait}</span>`;   // FIX (d)
        if (r.noActionable)  return `<span class="ds-pill ds-pill-mon">${label} · capped</span>`;
        return `<span class="ds-pill ds-pill-avail">${label} · active</span>`;
      }).join('');
    }
    const pveModeSel = uiBox.querySelector('#ds-pve-mode');
    if (pveModeSel && !pveModeSel.matches(':focus')) {
      pveModeSel.value = pveProfile.damageMode;
    }
    const pveModeScheduledOpt = uiBox.querySelector('#ds-pve-mode-scheduled-opt');
    if (pveModeScheduledOpt) pveModeScheduledOpt.hidden = fastMode;

    const pveModeNoteEl = uiBox.querySelector('#ds-pve-mode-note');
    if (pveModeNoteEl) pveModeNoteEl.textContent = PVE_MODE_NOTES[pveProfile.damageMode] || '';

    uiBox.querySelector('#ds-pve-fixedcap-row').style.display =
      pveProfile.damageMode === 'fixed' ? '' : 'none';

    const pveFixedInput = uiBox.querySelector('#ds-pve-fixedcap');
    if (pveFixedInput && !pveFixedInput.matches(':focus')) {
      pveFixedInput.value = pveProfile.fixedDamageCap || '';
    }

    uiBox.querySelector('#ds-pve-stam-potion').checked = pveProfile.useStaminaPotion;
    uiBox.querySelector('#ds-pve-hp-potion').checked = pveProfile.useHpPotion;

    const pveNodePanelsEl = uiBox.querySelector('#ds-pve-nodepanels');
    if (pveNodePanelsEl && !pveNodePanelsEl.contains(document.activeElement)) {
      const html = pveRenderNodePanelsHTML(pveProfile);   // FIX: don't rebuild identical DOM on every refresh
      if (pveNodePanelsEl.__html !== html) pveNodePanelsEl.innerHTML = pveNodePanelsEl.__html = html;
    }

    uiBox.querySelector('#ds-pve-stam-potion').checked = pveProfile.useStaminaPotion;
    uiBox.querySelector('#ds-pve-hp-potion').checked = pveProfile.useHpPotion;

    const stamCapWrap = uiBox.querySelector('#ds-pve-stamcap-wrap');
    if (stamCapWrap) stamCapWrap.style.display = pveProfile.useStaminaPotion ? 'flex' : 'none';
    const stamCapInput = uiBox.querySelector('#ds-pve-stamcap');
    if (stamCapInput && !stamCapInput.matches(':focus')) {
      stamCapInput.value = pveProfile.staminaPotionExpCap ?? 93.5;
    }

    const saSchedWrapEl = uiBox.querySelector('#ds-sa-sched-wrap');
    if (saSchedWrapEl) saSchedWrapEl.style.display = fastMode ? 'none' : '';

    const copyLabelEl = uiBox.querySelector('#ds-pve-copy-other-label');
    if (copyLabelEl) copyLabelEl.textContent = pveActiveProfileKey() === 'fast' ? 'Normal' : 'Fast Run';

    const pveModelSel = uiBox.querySelector('#ds-pve-damage-model');
    if (pveModelSel && !pveModelSel.matches(':focus')) {
      pveModelSel.value = pveProfile.damageModel;
    }

    uiBox.querySelectorAll('.ds-chip').forEach(btn => btn.classList.toggle('active', btn.dataset.filter === activeLogFilter));
    dsClampPanel();   // FIX: the panel grows with its content (tabs, node lists) - keep it on screen
  }

  function renderLog() {
    if (!uiBox || !uiBox.isConnected) return;
    const el = uiBox.querySelector('#ds-log');
    if (!el) return;
    const filtered = activeLogFilter === 'all' ? logLines : logLines.filter(l => l.source === activeLogFilter);
    el.innerHTML = filtered.length
      ? filtered.map(dsBuildLogLineHtml).join('')
    : `<div class="ds-log-empty">No activity yet.</div>`;
    if (logStickToBottom) el.scrollTop = el.scrollHeight;
  }

  function init() {
    pvpSyncSourceParamsFromLocation();
    if (logLines.length > 0) {
      logLines.push({ time: new Date().toLocaleTimeString(), source: 'sys', level: 'info',
                     msg: '────── session resumed ──────' });
    }
    dsInitTabSync(); // mounts UI and starts runLoop only when this tab owns the lease
  }

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init);

})();
