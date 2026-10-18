/* stat-autobuilder.js - Veyra Stat Auto-Builder 18.9.5 as a Core addon.
 *
 * The planner, safety checks, journal and run logic are the userscript's, unchanged. Only the plumbing moved to Core:
 *   button + panel  -> Core.float        settings + journal -> Core.store (same localStorage keys as before)
 *   stats page read -> Core.pages.stats  cross-tab lock     -> Core.lock
 * Turn the old standalone userscript OFF in Tampermonkey (it would otherwise be a second copy).
 */
(function () {
  'use strict';

  // The standalone userscript sets this same flag, so whichever runs first wins and the two never both run.
  if (window.__veyraStatAutoBuilderLoaded) {
    console.warn('[stat-autobuilder] the standalone Veyra Stat Auto-Builder userscript is already running - turn it off in Tampermonkey.');
    Core.ui.toast('Stat Auto-Builder: turn off the old standalone userscript, then reload.', false, 8000);
    return;
  }
  window.__veyraStatAutoBuilderLoaded = true;

  // ---------------------------------------------------------------------
  // CONSTANTS
  // ---------------------------------------------------------------------

  const STORAGE_KEY = 'veyra_stat_autobuilder_v9';
  const ALLOCATE_URL = '/stats_ajax.php';

  // The stats page only ever sends 1 / 5 / 50 / 100 / all. Every request this script sends is built
  // from the first four, so it is always a request the page itself could have produced. 'all' is never
  // used: it spends whatever the server holds, not what the plan says.
  const ALLOWED_AMOUNTS = [100, 50, 5, 1];
  const JOURNAL_KEY = 'veyra_stat_autobuilder_journal';
  const LOCK_NAME = 'veyra_stat_autobuilder_lock';
  const ID = 'stat-autobuilder';
  // `key` keeps the userscript's own localStorage keys, so saved settings and any interrupted allocation carry over.
  const settings = Core.store(ID, { key: STORAGE_KEY });
  const journalStore = Core.store(ID + '-journal', { key: JOURNAL_KEY });

  const POLL_MIN_SECONDS = 20;
  const REQUEST_DELAY_MS = 350;
  const POINTS_PER_LEVEL = 5;
  // v18.9: Level targets are planned to stay met ONE level-up ahead. A level-up adds 5 to the Level-ratio
  // denominator at once, so a plan that lands exactly on the line would dip below it until the next check.
  // Costs about (ratio * 5) extra ATK/DEF once. Fixed - it is no longer a setting.
  const LEVEL_UP_BUFFER = 1;
  const SCHEMA = 3; // settings schema; 3 = v18.9 (one Level + one Pet pick, no spare/buffer settings)

  const STATS = ['attack', 'defense', 'stamina'];
  const SHORT = { attack: 'ATK', defense: 'DEF', stamina: 'STA' };
  const NAME = { attack: 'Attack', defense: 'Defense', stamina: 'Stamina' };
  const ICON = { attack: '⚔', defense: '🛡', stamina: '⚡' };

  // Things you can maintain / see in the advisor.
  //  level: (ATK + DEF) / ((Level - 1) * 5) must be at least t          (EXP + penetration bonus)
  //  pet  : ATK + DEF must be MORE than t of your total stats (ATK + DEF + STM)   (ATK/DEF Pet tiers)
  // lc / pc are your own thresholds (their `t` and `label` follow the settings, see applyCustom()).
  const TARGETS = {
    l08: { label: 'Level 0.8', kind: 'level', t: 0.8, bonus: '+15% EXP, +15% pet & equipment penetration' },
    l06: { label: 'Level 0.6', kind: 'level', t: 0.6, bonus: '+10% EXP, +10% pet & equipment penetration' },
    p60: { label: 'Pet 0.6', kind: 'pet', t: 0.6, bonus: 'ATK/DEF Pet: bonus damage' },
    p40: { label: 'Pet 0.4', kind: 'pet', t: 0.4, bonus: 'ATK/DEF Pet: second tier' },
    lc: { label: 'Level 0.70', kind: 'level', t: 0.7, bonus: 'Your own Level ratio', custom: true },
    pc: { label: 'Pet 0.50', kind: 'pet', t: 0.5, bonus: 'Your own Pet ratio', custom: true }
  };
  const TARGET_ORDER = ['l08', 'l06', 'lc', 'p60', 'p40', 'pc'];

  // v18.9: one pick per group. A higher Level (or Pet) tier already includes the lower ones, so picking two
  // from the same group would be redundant. One Level AND one Pet can be held together.
  const GROUPS = [
    { id: 'lvl', name: 'Level', keys: ['l08', 'l06', 'lc'], note: '(ATK + DEF) ÷ ((Level − 1) × 5) must be at least the ratio' },
    { id: 'pet', name: 'Pet', keys: ['p60', 'p40', 'pc'], note: 'Pet ratio = (ATK + DEF) ÷ all your stats; it must be MORE than this' }
  ];

  // ---------------------------------------------------------------------
  // SMALL HELPERS
  // ---------------------------------------------------------------------

  function toInt(v) {
    const n = parseInt(String(v == null ? '0' : v).replace(/[^0-9-]/g, ''), 10);
    return Number.isFinite(n) ? n : 0;
  }

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const fmt = (n) => Number(n || 0).toLocaleString();
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  // ---------------------------------------------------------------------
  // SETTINGS
  // ---------------------------------------------------------------------

  //   mode         - 'manual' (spend exactly the amounts you set) | 'target' (reach and hold targets for you)
  //   lvl / pet    - the Level target and the Pet target to maintain (null = none). At least one is set.
  //   combat       - maintain only: where the ATK/DEF points go - 'attack' | 'defense' | 'build'
  //   pattern      - manual only: points per stat
  //   customLevel  - threshold for the custom Level target (0.05 - 0.99)
  //   customPet    - threshold for the custom Pet target   (0.05 - 0.99)
  const DEFAULTS = {
    enabled: false,
    mode: 'target',
    lvl: 'l08',
    pet: null,
    combat: 'build',
    pattern: { attack: 4, defense: 0, stamina: 1 },
    pollSeconds: 60,
    customLevel: 0.7,
    customPet: 0.5,
    customKind: 'level',
    carry: {},
    carrySig: '',
    schema: SCHEMA
  };

  const cleanPoints = (v) => clamp(toInt(v), 0, 9999);
  const cleanRatio = (v, fallback) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? clamp(Math.round(n * 100) / 100, 0.05, 0.99) : fallback;
  };

  function loadState() {
    const saved = settings.get() || null;
    const sv = saved && typeof saved === 'object' ? saved : {};
    const s = Object.assign({}, DEFAULTS, sv);
    s.enabled = !!s.enabled;
    s.mode = s.mode === 'manual' ? 'manual' : 'target';
    s.customLevel = cleanRatio(s.customLevel, DEFAULTS.customLevel);
    s.customPet = cleanRatio(s.customPet, DEFAULTS.customPet);
    s.customKind = s.customKind === 'pet' ? 'pet' : 'level';

    // Targets: v18.9 keeps one Level and one Pet. Older saves held a list; keep the STRICTEST of each group
    // (holding the strictest one already holds the looser ones).
    const val = (k) => (k === 'lc' ? s.customLevel : k === 'pc' ? s.customPet : TARGETS[k].t);
    const strictest = (keys) => keys.slice().sort((a, b) => val(b) - val(a))[0] || null;
    if ('lvl' in sv || 'pet' in sv) {
      s.lvl = GROUPS[0].keys.includes(sv.lvl) ? sv.lvl : null;
      s.pet = GROUPS[1].keys.includes(sv.pet) ? sv.pet : null;
    } else {
      const wanted = Array.isArray(sv.targets) ? sv.targets : sv.target ? [sv.target] : [];
      s.lvl = strictest(GROUPS[0].keys.filter((k) => wanted.includes(k)));
      s.pet = strictest(GROUPS[1].keys.filter((k) => wanted.includes(k)));
    }
    if (!s.lvl && !s.pet) s.lvl = DEFAULTS.lvl;
    // Settings that no longer exist.
    ['targets', 'target', 'buffer', 'staminaUntil'].forEach((k) => delete s[k]);

    if (!['attack', 'defense', 'build'].includes(s.combat)) s.combat = DEFAULTS.combat;
    const pat = Object.assign({}, DEFAULTS.pattern, s.pattern || {});
    s.pattern = {};
    STATS.forEach((k) => (s.pattern[k] = cleanPoints(pat[k])));
    s.pollSeconds = Math.max(POLL_MIN_SECONDS, toInt(s.pollSeconds) || 60);
    s.schema = SCHEMA;
    s.carry = s.carry && typeof s.carry === 'object' ? s.carry : {};
    s.carrySig = String(s.carrySig || '');
    return s;
  }

  let state = loadState();

  const heldKeys = (s) => [s.lvl, s.pet].filter(Boolean);

  // The custom targets read their ratio from the settings.
  function applyCustom() {
    TARGETS.lc.t = state.customLevel;
    TARGETS.lc.label = 'Level ' + state.customLevel.toFixed(2);
    TARGETS.pc.t = state.customPet;
    TARGETS.pc.label = 'Pet ' + state.customPet.toFixed(2);
  }
  applyCustom();

  function saveState() {
    settings.set(state);
  }

  // ---------------------------------------------------------------------
  // THE PLANNER (pure maths - no DOM, no network)
  // ---------------------------------------------------------------------

  const sumAtkDef = (st) => (st.attack || 0) + (st.defense || 0);
  const allStats = (st) => (st.attack || 0) + (st.defense || 0) + (st.stamina || 0);
  const totalEarned = (st) => Math.max(0, (st.level || 0) - 1) * POINTS_PER_LEVEL;
  const tkOf = (t) => Math.round(t * 1000); // thousandths: integer maths, so exact boundaries behave
  const patternSum = (s) => STATS.reduce((a, k) => a + s.pattern[k], 0);

  const levelRatio = (st) => (totalEarned(st) > 0 ? sumAtkDef(st) / totalEarned(st) : 0);
  const petShare = (st) => (allStats(st) > 0 ? sumAtkDef(st) / allStats(st) : 0);

  // Does `st` meet the target right now?
  function meets(T, st) {
    const tk = tkOf(T.t);
    return T.kind === 'level' ? totalEarned(st) > 0 && 1000 * sumAtkDef(st) >= tk * totalEarned(st) : allStats(st) > 0 && 1000 * sumAtkDef(st) > tk * allStats(st);
  }

  // Fewest ATK/DEF points that must go in, out of x points spent right now (the rest go to Stamina),
  // for the target to be met afterwards.
  function needFor(T, st, x) {
    const tk = tkOf(T.t);
    const c = sumAtkDef(st);
    if (T.kind === 'level') {
      const num = tk * totalEarned(st) - 1000 * c;
      return num > 0 ? Math.ceil(num / 1000 - 1e-9) : 0;
    }
    const num = tk * (allStats(st) + x) - 1000 * c;
    return num < 0 ? 0 : Math.floor(num / 1000) + 1;
  }

  // Split n whole points across `keys` by weight. The rounding error is carried to the next
  // plan, so a small share still gets its turn.
  function distribute(keys, weights, n, carryIn) {
    const out = {};
    const carryOut = {};
    keys.forEach((k) => {
      out[k] = 0;
      carryOut[k] = 0;
    });
    if (n <= 0 || !keys.length) {
      keys.forEach((k) => (carryOut[k] = carryIn[k] || 0));
      return { out, carryOut };
    }

    let active = keys.filter((k) => weights[k] > 0);
    const w = {};
    if (active.length) active.forEach((k) => (w[k] = weights[k]));
    else {
      active = keys.slice();
      active.forEach((k) => (w[k] = 1));
    }
    const W = active.reduce((a, k) => a + w[k], 0);
    const eff = {};
    keys.forEach((k) => (eff[k] = 0));
    active.forEach((k) => (eff[k] = (n * w[k]) / W + (carryIn[k] || 0)));

    // Largest-remainder rounding so the total is always exactly n.
    const base = {};
    let S = 0;
    keys.forEach((k) => {
      base[k] = Math.max(0, Math.floor(eff[k] + 1e-9));
      S += base[k];
    });
    const frac = (k) => eff[k] - base[k];
    const desc = keys.slice().sort((a, b) => frac(b) - frac(a) || (w[b] || 0) - (w[a] || 0));
    for (let i = 0; S < n; i++, S++) base[desc[i % desc.length]]++;
    const asc = keys.slice().sort((a, b) => frac(a) - frac(b));
    for (let i = 0, guard = 0; S > n && guard++ < 1000; i++) {
      const k = asc[i % asc.length];
      if (base[k] > 0) {
        base[k]--;
        S--;
      }
    }

    keys.forEach((k) => {
      out[k] = base[k];
      carryOut[k] = clamp(eff[k] - base[k], -2, 2);
    });
    return { out, carryOut };
  }

  // MANUAL: spend x points by exactly the amounts the user set.
  function planSpend(pattern, x, carryIn) {
    const r = distribute(STATS, pattern, Math.max(0, Math.floor(x)), carryIn || {});
    return { attack: r.out.attack, defense: r.out.defense, stamina: r.out.stamina, x, short: 0, forced: false, needs: [], nextCarry: r.carryOut };
  }

  // MAINTAIN: keep every chosen target met using the FEWEST ATK/DEF points that does it; everything else
  // goes to Stamina. Stamina never lowers the Level ratio (the denominator is points earned, not where they
  // went) and it dilutes the Pet share, so when you are over the targets the extra batch can go to Stamina and
  // the ratios just drift down until the tightest one reaches its line. At the line it spends only what holding
  // it takes (0.8 -> ~4 of 5 per level, 0.6 -> ~3 of 5). If you are behind, everything goes to ATK/DEF until
  // you catch up.
  //
  // Each target gives a minimum number of ATK/DEF points; with a Level and a Pet target the plan takes the
  // larger of the two, which satisfies both (more ATK/DEF never hurts either). `needs` lists each target's own
  // minimum so the UI can show which one decides. Level targets are also kept met LEVEL_UP_BUFFER level-ups
  // ahead (see the constant). The Level ratio ignores where points go, but the Pet share does not, so a Pet
  // target is what stops a huge Stamina dump from breaking it.
  // `weights` ({attack, defense}) divides the ATK/DEF part.
  function planMaintain(st, targetKeys, weights, xIn, carryIn) {
    const keys = (Array.isArray(targetKeys) ? targetKeys : [targetKeys]).filter((k) => TARGETS[k]);
    const carry = carryIn || {};
    const x = Math.max(0, Math.floor(xIn));
    const out = { attack: 0, defense: 0, stamina: 0 };
    const nextCarry = Object.assign({}, carry);
    const needs = [];
    let need = 0;
    if (x > 0) {
      let want = 0;
      keys.forEach((k) => {
        const T = TARGETS[k];
        const nowNeed = needFor(T, st, x);
        const ahead = T.kind === 'level' ? Object.assign({}, st, { level: st.level + LEVEL_UP_BUFFER }) : st;
        const bufNeed = needFor(T, ahead, x);
        need = Math.max(need, nowNeed);
        want = Math.max(want, bufNeed);
        needs.push({ key: k, need: Math.max(nowNeed, bufNeed) });
      });
      const c = Math.min(Math.max(need, want), x);
      const r = distribute(['attack', 'defense'], weights, c, carry);
      out.attack = r.out.attack;
      out.defense = r.out.defense;
      nextCarry.attack = r.carryOut.attack;
      nextCarry.defense = r.carryOut.defense;
      out.stamina = x - c;
    }
    return { attack: out.attack, defense: out.defense, stamina: out.stamina, x, short: Math.max(0, need - x), forced: need > 0, needs, nextCarry };
  }

  // Weights for dividing the ATK/DEF part of a maintain plan.
  function combatWeights(combat, st) {
    if (combat === 'attack') return { attack: 1, defense: 0 };
    if (combat === 'defense') return { attack: 0, defense: 1 };
    const a = (st && st.attack) || 0;
    const d = (st && st.defense) || 0;
    return a + d > 0 ? { attack: a, defense: d } : { attack: 1, defense: 0 };
  }

  // THE one planning entry point. The Allocate button, the info line and "If I spend at once" all call this,
  // so what the preview shows is what a real run would send.
  //   cfg = { maintain, targets, combat, pattern, carry }
  function planFor(st, x, cfg) {
    return cfg.maintain ? planMaintain(st, cfg.targets, combatWeights(cfg.combat, st), x, cfg.carry) : planSpend(cfg.pattern, x, cfg.carry);
  }

  // SAFETY CHECK (pure): apply `plan` to `st` and return the keys of the targets that would NOT be met
  // right after. Used before anything is sent (the plan is refused if it would break a target it claims to
  // hold) and after spending (read back from the server's own numbers).
  function verifyPlan(st, plan, keys) {
    const after = Object.assign({}, st, {
      attack: (st.attack || 0) + (plan.attack || 0),
      defense: (st.defense || 0) + (plan.defense || 0),
      stamina: (st.stamina || 0) + (plan.stamina || 0),
      points: Math.max(0, (st.points || 0) - (plan.x || 0))
    });
    return keys.filter((k) => TARGETS[k] && !meets(TARGETS[k], after));
  }

  // FORECAST (pure): what happens to ONE target if every point from now on is spent in the proportions
  // of `pat` - your unspent points first, then 5 more per level-up. Exact integer maths, no simulation.
  //   ok      - is the target met after your unspent points are spent that way
  //   kind    - 'holds' (stays met for good) | 'drops' (met now, breaks later) |
  //             'reaches' (not met now, gets there) | 'never' (not met, never gets there)
  //   n       - level-ups from now until the change ('drops': the first level-up where it is broken)
  //   atLevel - your level at that point
  //   f       - long-run share of points going to ATK/DEF (the ratio the pattern converges to)
  // Both ratios move linearly in the number of level-ups n, so   value(n) = b + m * n   and the
  // answer is where that crosses zero.
  function projectPattern(T, st, pat) {
    const a = (pat.attack || 0) + (pat.defense || 0);
    const S = a + (pat.stamina || 0);
    if (S <= 0) return null;
    const tk = tkOf(T.t);
    const u = st.points || 0;
    const c = sumAtkDef(st);
    const spent = 1000 * (S * c + u * a);
    const m = 5 * (1000 * a - tk * S);
    const b = T.kind === 'level' ? spent - tk * S * totalEarned(st) : spent - tk * S * (allStats(st) + u);
    const good = (v) => (T.kind === 'level' ? v >= 0 : v > 0);
    const f = a / S;
    const level = st.level || 0;
    let kind;
    let n = 0;
    if (good(b)) {
      if (m >= 0) kind = 'holds';
      else {
        kind = 'drops';
        const q = b / -m;
        n = T.kind === 'level' ? Math.floor(q) + 1 : Math.ceil(q);
        if (T.kind === 'pet' && n < 1) n = 1;
      }
    } else if (m > 0) {
      kind = 'reaches';
      const q = -b / m;
      n = T.kind === 'level' ? Math.ceil(q) : Math.floor(q) + 1;
      if (n < 1) n = 1;
    } else {
      kind = 'never';
    }
    return { ok: good(b), kind, n, atLevel: level + n, f };
  }

  // ADVISOR (read-only): one row per target.
  //  reached  - met right now
  //  need     - ATK/DEF points still missing (if not reached)
  //  levels   - not reached: level-ups needed if everything from now on goes to ATK/DEF (0 = your unspent points get you there)
  //  free     - reached: of your unspent points, how many can go to Stamina and it is still met. Level targets are kept
  //             one level-up ahead (LEVEL_UP_BUFFER), exactly like a real plan, so this matches what Allocate does.
  //  runTo    - reached: if ALL future points went to Stamina, the last level at which it is still met (null = never breaks)
  function advise(st) {
    const u = st.points || 0;
    const c = sumAtkDef(st);
    const rows = TARGET_ORDER.map((key) => {
      const T = TARGETS[key];
      const tk = tkOf(T.t);
      const reached = meets(T, st);
      let need = 0;
      let free = 0;
      let levels = 0;
      let runTo = null;
      if (!reached) {
        need = T.kind === 'level' ? Math.ceil((tk * totalEarned(st) - 1000 * c) / 1000 - 1e-9) : Math.floor((tk * allStats(st) - 1000 * c) / (1000 - tk)) + 1;
        const p = projectPattern(T, st, { attack: 1, defense: 0, stamina: 0 });
        if (p && p.kind === 'reaches') levels = p.n;
      } else {
        if (u > 0) {
          const ahead = T.kind === 'level' ? Object.assign({}, st, { level: st.level + LEVEL_UP_BUFFER }) : st;
          free = u - Math.min(Math.max(needFor(T, st, u), needFor(T, ahead, u)), u);
        }
        const p = projectPattern(T, st, { attack: 0, defense: 0, stamina: 1 });
        if (p && p.ok && p.kind === 'drops') runTo = (st.level || 0) + p.n - 1;
      }
      return { key, label: T.label, bonus: T.bonus, kind: T.kind, reached, need, free, levels, runTo };
    });
    return { rows, levelRatio: levelRatio(st), petShare: petShare(st) };
  }

  // WHAT-IF (pure): you spend `n` points in one go. Runs the SAME planFor() a real run uses, then reports for
  // each held target the value right after, whether it is met, and whether it is still met one level-up later.
  //   cfg = { maintain, targets, combat, pattern, carry }
  function whatIf(st, n, cfg) {
    // Unspent points come from level-ups (5 each), and every level-up also adds 5 to the Level-ratio
    // denominator. So "n points at once" means (n - what you hold) / 5 more levels: the level goes up and the
    // ratio drops, which is exactly what makes the planner put ATK/DEF in once the batch is big enough.
    // n is rounded up to a whole number of level-ups. n <= what you hold = a plain spend, level unchanged.
    const held = st.points || 0;
    const gained = Math.ceil(Math.max(0, n - held) / POINTS_PER_LEVEL);
    const total = gained > 0 ? held + gained * POINTS_PER_LEVEL : n;
    const hypo = Object.assign({}, st, { level: (st.level || 0) + gained, points: total });
    const plan = planFor(hypo, total, cfg);
    const after = Object.assign({}, st, {
      level: hypo.level,
      attack: (st.attack || 0) + plan.attack,
      defense: (st.defense || 0) + plan.defense,
      stamina: (st.stamina || 0) + plan.stamina,
      points: 0
    });
    const checks = cfg.targets.map((key) => {
      const T = TARGETS[key];
      const now = meets(T, after);
      const ahead = T.kind === 'level' ? meets(T, Object.assign({}, after, { level: (after.level || 0) + LEVEL_UP_BUFFER })) : now;
      const nd = (plan.needs || []).find((z) => z.key === key);
      return { key, label: T.label, kind: T.kind, now, ahead, value: T.kind === 'level' ? levelRatio(after) : petShare(after), need: nd ? nd.need : null };
    });
    // Targets you did NOT pick that are met now but would be lost by this spend (e.g. a big Stamina dump
    // breaking a Pet tier you are not holding). cfg.watch = the targets worth watching.
    const lost = (cfg.watch || []).filter((k) => TARGETS[k] && !cfg.targets.includes(k) && meets(TARGETS[k], st) && !meets(TARGETS[k], after)).map((k) => TARGETS[k].label);
    return { plan, after, checks, lost, gained, total };
  }

  const configSig = (s) => JSON.stringify([s.mode, s.lvl, s.pet, s.combat, s.pattern, s.customLevel, s.customPet]);
  const targetLabels = (s) => heldKeys(s).map((k) => TARGETS[k].label).join(' + ');
  const cfgFromState = (carry) => ({ maintain: state.mode === 'target', targets: heldKeys(state), watch: visibleKeys(), combat: state.combat, pattern: state.pattern, carry });
  const previewCarry = () => (state.carrySig === configSig(state) ? state.carry : {});

  if (window.__VEYRA_TEST__) {
    window.__VEYRA_TEST__.api = { planSpend, planMaintain, planFor, projectPattern, whatIf, verifyPlan, combatWeights, advise, meets, needFor, levelRatio, petShare, configSig, TARGETS, DEFAULTS, applyCustom, LEVEL_UP_BUFFER };
  }

  // ---------------------------------------------------------------------
  // LIVE DATA (read from stats.php)
  // ---------------------------------------------------------------------

  const tokens = { csrf: '', view: '' };
  let latest = null; // { points, attack, defense, stamina, level }
  let lastFetchAt = 0;

  function readLevel(doc) {
    for (const sel of ['.small-level', '.gtb-level', '#sidebar-level']) {
      const el = doc.querySelector(sel);
      if (!el) continue;
      const m = String(el.textContent || '').match(/LV\s*([0-9,]+)/i);
      if (m) return toInt(m[1]);
    }
    const m = String(doc.body ? doc.body.textContent : '').match(/\bLV\s*([0-9,]+)/i);
    return m ? toInt(m[1]) : 0;
  }

  function parseStatsDoc(doc) {
    let out = null;

    // The page embeds its own state: user numbers plus the csrf / view tokens.
    const node = doc.getElementById('stats-state');
    if (node) {
      try {
        const st = JSON.parse(node.textContent);
        if (st && st.user) {
          out = {
            points: toInt(st.user.STAT_POINTS),
            attack: toInt(st.user.ATTACK),
            defense: toInt(st.user.DEFENSE),
            stamina: toInt(st.user.MAX_STAMINA),
            level: 0
          };
          if (st.csrf) tokens.csrf = String(st.csrf);
          if (st.view) tokens.view = String(st.view);
        }
      } catch (_e) {
        out = null;
      }
    }

    // Fallback: the rendered numbers (no tokens this way, so spending is refused until they load).
    if (!out) {
      const read = (k) => {
        const el = doc.querySelector('[data-value="' + k + '"]');
        return el ? toInt(el.textContent) : null;
      };
      const points = read('points');
      const attack = read('attack');
      if (points != null && attack != null) {
        out = { points, attack, defense: read('defense') || 0, stamina: read('stamina') || 0, level: 0 };
      }
    }

    if (!out) return null;
    out.level = readLevel(doc) || (latest ? latest.level : 0);
    return out;
  }

  async function fetchStats() {
    const doc = await Core.pages.stats({ fetch: true, force: true }); // always a fresh fetch, even on stats.php itself
    const parsed = parseStatsDoc(doc);
    if (!parsed) throw new Error('Could not read stats (logged out, or the page layout changed).');
    latest = parsed;
    lastFetchAt = Date.now();
    return parsed;
  }

  // ---------------------------------------------------------------------
  // NETWORK: spend points (mirrors what the stats page itself sends)
  // ---------------------------------------------------------------------

  function rejected(msg) {
    const e = new Error(msg);
    e.isRejection = true;
    return e;
  }

  function newRequestId() {
    const a = new Uint8Array(24);
    crypto.getRandomValues(a);
    return Array.from(a, (n) => n.toString(16).padStart(2, '0')).join('');
  }

  function fatal(msg) {
    const e = new Error(msg);
    e.fatal = true;
    return e;
  }

  // ---- journal: the one in-flight request, written BEFORE it is sent --------------------------
  function readJournal() {
    try {
      const j = journalStore.get();
      if (j && typeof j.id === 'string' && STATS.includes(j.stat) && ALLOWED_AMOUNTS.includes(j.amount) && j.before && typeof j.csrf === 'string' && typeof j.view === 'string') return j;
    } catch (_e) {
      /* unreadable journal counts as no journal */
    }
    return null;
  }
  function writeJournal(j) {
    journalStore.set(j);
    // Core.store swallows write errors, so read it back: no journal on disk means nothing gets spent.
    const back = journalStore.get();
    return !!back && back.id === j.id;
  }
  function clearJournal() {
    journalStore.set(null); // readJournal() treats this as "no journal"
  }

  // Sends one journaled request. The same request_id is used for every attempt and for any later
  // replay, so the server applies it at most once no matter how many times it is sent.
  async function postAllocation(j) {
    const body = new URLSearchParams({
      action: 'allocate',
      stat: j.stat,
      amount: String(j.amount),
      csrf: j.csrf,
      view: j.view,
      request_id: j.id
    }).toString();

    let lastErr = new Error('The server could not confirm this allocation.');
    for (let attempt = 0; attempt < 3; attempt++) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 20000);
      try {
        const res = await fetch(ALLOCATE_URL, {
          method: 'POST',
          credentials: 'same-origin',
          keepalive: true,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
          signal: abort.signal
        });
        let json = null;
        try {
          json = await res.json();
        } catch (_e) {
          json = null;
        }

        if (res.status >= 500 || json == null) {
          lastErr = new Error('The server could not confirm this allocation.');
        } else if (!res.ok || !json.ok) {
          const err = rejected(json.msg || 'Allocation was rejected.');
          err.attempt = attempt;
          throw err;
        } else {
          if (json.view) tokens.view = String(json.view);
          const level = latest ? latest.level : 0;
          if (json.user && json.user.STAT_POINTS != null) {
            latest = {
              points: toInt(json.user.STAT_POINTS),
              attack: toInt(json.user.ATTACK),
              defense: toInt(json.user.DEFENSE),
              stamina: toInt(json.user.MAX_STAMINA),
              level
            };
          } else {
            await fetchStats();
          }
          syncUI();
          return;
        }
      } catch (e) {
        if (e.isRejection) throw e;
        lastErr = e;
      } finally {
        clearTimeout(timer);
      }
      await sleep(1500);
    }
    throw lastErr;
  }

  // After the server has answered with a rejection for a request that may already have been applied
  // by an earlier attempt: read the real numbers and compare with the journal's snapshot.
  async function settleJournal(j) {
    const fresh = await fetchStats();
    const delta = fresh[j.stat] - j.before[j.stat];
    if (delta === j.amount) return 'applied';
    if (delta === 0) return 'not-applied';
    return 'unknown';
  }

  async function sendChunk(stat, amount) {
    if (!tokens.csrf || !tokens.view) throw rejected('No session tokens yet - reload and try again.');
    const j = {
      id: newRequestId(),
      stat,
      amount,
      csrf: tokens.csrf,
      view: tokens.view,
      t: Date.now(),
      before: { points: latest.points, attack: latest.attack, defense: latest.defense, stamina: latest.stamina }
    };
    if (!writeJournal(j)) throw new Error('Could not write the safety journal - nothing was spent.');

    try {
      await postAllocation(j);
    } catch (e) {
      // Refused on the very first send: the server did not apply it.
      if (e.isRejection && e.attempt === 0) {
        clearJournal();
        throw e;
      }
      // Rejected after earlier attempts: the server has answered, so compare the real numbers.
      if (e.isRejection) {
        const outcome = await settleJournal(j);
        if (outcome === 'applied') {
          clearJournal();
          return;
        }
        clearJournal();
        if (outcome === 'not-applied') throw e;
        throw fatal('Your ' + NAME[stat] + ' changed by an unexpected amount during allocation (something else spent points). Check your stats, then turn auto back on.');
      }
      // No answer at all (timeout, dropped connection, 5xx): the journal stays on disk. The next
      // run replays this exact request_id before anything else is spent.
      throw e;
    }
    clearJournal();
  }

  // Splits any amount into allowed chunks, one journaled request per chunk.
  async function allocate(stat, amount) {
    let left = Math.floor(amount);
    for (const step of ALLOWED_AMOUNTS) {
      while (left >= step) {
        if (!latest || latest.points < step) throw new Error('Not enough unspent points for the next chunk - stopped before spending it.');
        await sendChunk(stat, step);
        left -= step;
        if (left > 0) await sleep(REQUEST_DELAY_MS);
      }
    }
  }

  // Finishes a request left over from an interrupted run (page reload, closed tab, dropped connection).
  // Returns true when nothing is pending any more, false when it could not be settled yet.
  async function recoverJournal() {
    const j = readJournal();
    if (!j) return true;
    setStatus('Finishing an interrupted allocation (' + j.amount + ' ' + SHORT[j.stat] + ')...');
    try {
      try {
        await postAllocation(j);
      } catch (e) {
        if (!e.isRejection) throw e;
        const outcome = await settleJournal(j);
        if (outcome === 'unknown') {
          clearJournal();
          disableAuto('Stopped: your ' + NAME[j.stat] + ' changed by an unexpected amount around an interrupted allocation. Check your stats, then turn auto back on.');
          return false;
        }
      }
      clearJournal();
      await fetchStats();
      syncUI();
      return true;
    } catch (e) {
      setStatus('Could not settle the interrupted allocation yet (' + e.message + '). Nothing else is spent until it is settled; trying again next check.');
      return false;
    }
  }

  // ---------------------------------------------------------------------
  // RUN LOGIC
  // ---------------------------------------------------------------------

  let running = false;
  let failStreak = 0;

  function disableAuto(reason) {
    state.enabled = false;
    saveState();
    if (els.auto) els.auto.checked = false;
    if (reason) {
      setStatus(reason);
      Core.ui.toast(reason, false, 10000);
    }
    syncUI();
  }

  // The carried rounding error only makes sense for the choices it was built under.
  function currentCarry() {
    const sig = configSig(state);
    if (state.carrySig !== sig) {
      state.carry = {};
      state.carrySig = sig;
    }
    return state.carry;
  }

  // manual = the Allocate button. In "My amounts" mode that spends exactly one round (auto spends every
  // full round you have points for). In "Maintain" mode both spend all your unspent points.
  async function runOnce(manual) {
    if (running || (!manual && !state.enabled) || !latest) return;

    if (!latest.level) {
      setStatus('Level not found on the page - not spending anything.');
      return;
    }

    const maintain = state.mode === 'target';
    let spendable;
    if (maintain) {
      spendable = latest.points;
      if (spendable < 1) {
        setStatus('No unspent points.');
        return;
      }
    } else {
      const sum = patternSum(state);
      if (sum <= 0) {
        setStatus('Choose how many points go to each stat first.');
        return;
      }
      spendable = manual ? sum : Math.floor(latest.points / sum) * sum;
      if (spendable < 1 || latest.points < spendable) {
        setStatus('Waiting for points: you have ' + fmt(latest.points) + ', need ' + fmt(sum) + '.');
        return;
      }
    }

    running = true;
    try {
      const cfg = cfgFromState(currentCarry());
      const plan = planFor(latest, spendable, cfg);

      // PRE-SPEND SAFETY CHECK. If the plan can reach every held target (short = 0) then applying it must
      // leave them all met. If it somehow would not, refuse BEFORE sending anything. When the plan cannot
      // reach a target at all (short > 0) it is the "catching up" case and is allowed.
      if (maintain && plan.short === 0) {
        const broken = verifyPlan(latest, plan, cfg.targets);
        if (broken.length) throw new Error('Safety check: this plan would leave ' + broken.map((k) => TARGETS[k].label).join(' + ') + ' unmet - nothing was spent.');
      }

      let spent = 0;
      const start = { attack: latest.attack, defense: latest.defense, stamina: latest.stamina };

      // ATK/DEF first, Stamina last, so your ratios can never dip part-way through a plan.
      for (const stat of ['attack', 'defense', 'stamina']) {
        const amt = plan[stat];
        if (!amt) continue;
        const before = latest.points;
        await allocate(stat, amt);
        spent += amt;
        if (latest.points >= before) throw new Error('Points did not go down after allocating - stopped to be safe.');
        await sleep(REQUEST_DELAY_MS);
      }

      state.carry = plan.nextCarry;
      state.carrySig = configSig(state);
      saveState();
      failStreak = 0;

      // Report what the server really applied (read back from its own responses), not just the plan.
      const actual = {};
      STATS.forEach((k) => (actual[k] = latest[k] - start[k]));
      let msg = 'Allocated ' + fmt(spent) + ' pts: ' + STATS.map((k) => SHORT[k] + ' ' + fmt(actual[k])).join(' · ') + '.';
      if (STATS.some((k) => actual[k] !== plan[k])) msg += ' (Plan was ' + STATS.map((k) => SHORT[k] + ' ' + fmt(plan[k])).join(' · ') + ' - they differ, check your stats.)';
      if (maintain && plan.short > 0) msg += ' Still ' + fmt(plan.short) + ' ATK/DEF short of ' + targetLabels(state) + '.';
      // POST-SPEND CHECK on the server's own numbers.
      if (maintain && plan.short === 0) {
        const unmet = cfg.targets.filter((k) => !meets(TARGETS[k], latest));
        if (unmet.length) msg += ' ⚠️ Not met right now: ' + unmet.map((k) => TARGETS[k].label).join(' + ') + ' - check your stats.';
      }
      setStatus(msg);
    } catch (e) {
      failStreak++;
      try {
        await fetchStats(); // refresh numbers and tokens from the server before anything else
      } catch (_e) {
        /* the next poll will try again */
      }
      if (e.fatal) disableAuto('Stopped: ' + e.message);
      else if (manual) setStatus('Error: ' + e.message);
      else if (failStreak >= 2) disableAuto('Stopped after repeated errors: ' + e.message);
      else setStatus('Error: ' + e.message + ' - will re-check and try once more.');
    } finally {
      running = false;
      syncUI();
    }
  }

  // Only one tab at a time may recover or spend. Web Locks are atomic and are released by the browser
  // the moment the tab reloads, closes or crashes, so there is no lease to expire.
  // Core.lock.hold() answers true when THIS tab already holds the lock, so a flag keeps a second caller in the
  // same tab out (the raw Web Lock did that by itself).
  let exclusiveHeld = false;
  async function withExclusive(fn) {
    if (!Core.lock.available()) return fn();
    if (exclusiveHeld) return { busy: true };
    exclusiveHeld = true;
    try {
      if (!(await Core.lock.hold(LOCK_NAME, { ifAvailable: true }))) return { busy: true };
      return await fn();
    } finally {
      exclusiveHeld = false;
      Core.lock.release(LOCK_NAME);
    }
  }

  let busyRetry = null;
  async function exclusiveRun(manual) {
    if (running) return;
    try {
      const out = await withExclusive(async () => {
        if (!latest || Date.now() - lastFetchAt > 2000) await fetchStats(); // plan from the server's numbers, not a stale copy
        if (!(await recoverJournal())) return;
        await runOnce(manual);
      });
      if (out && out.busy) {
        setStatus('Another tab is allocating - checking again in a few seconds.');
        if (!manual && !busyRetry) {
          busyRetry = setTimeout(() => {
            busyRetry = null;
            pollNow();
          }, 5000);
        }
      }
    } catch (e) {
      setStatus('Error: ' + e.message);
    }
  }

  // ---------------------------------------------------------------------
  // POLLING
  // ---------------------------------------------------------------------

  let pollTimer = null;
  let pollInFlight = false;

  function clearPoll() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function schedulePoll() {
    clearPoll();
    pollTimer = setTimeout(pollStats, Math.max(POLL_MIN_SECONDS, state.pollSeconds) * 1000);
  }

  function pollNow() {
    clearPoll();
    pollStats();
  }

  async function pollStats() {
    if (pollInFlight) return;
    pollInFlight = true;
    try {
      await fetchStats();
      syncUI();
      if (state.enabled || readJournal()) await exclusiveRun(false);
      else setStatus('Idle.');
    } catch (e) {
      setStatus('Check failed: ' + e.message);
    } finally {
      pollInFlight = false;
      schedulePoll();
    }
  }

  // ---------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------

  let els = {};
  let whatN = null; // the "if I spend at once" box; null = empty = use your real unspent points (not saved)

  function setStatus(msg) {
    if (els.status) els.status.textContent = msg;
  }

  const isEditing = (el) => document.activeElement === el;
  const lvText = (n) => (n > 99999 ? '100,000+' : fmt(n));

  // My-amounts mode forecast line.
  function projText(p) {
    if (!p) return '—';
    if (p.kind === 'holds') return 'holds';
    if (p.kind === 'drops') return 'drops at LV ' + lvText(p.atLevel);
    if (p.kind === 'reaches') return 'reached at LV ' + lvText(p.atLevel);
    return 'never reached';
  }

  // Maintain-mode row text. "free" is only shown when NOT all of your unspent points can go to Stamina.
  function advRowText(r, u) {
    if (r.reached) {
      const part = u > 0 && r.free < u ? (r.free > 0 ? fmt(r.free) + '/' + fmt(u) + ' free · ' : '→ ATK/DEF · ') : '';
      return part + (r.runTo != null ? 'STA→LV ' + lvText(r.runTo) : 'ok');
    }
    return 'need ' + fmt(r.need) + (r.need > u && r.levels ? ' · ~' + fmt(r.levels) + ' lv' : '');
  }

  // Text of the "If I spend at once" box, in plain words. Pure: takes the whatIf() result.
  function previewLines(s, n, w, maintain) {
    const held = s.points || 0;
    let head;
    if (w.gained > 0) head = fmt(w.total) + ' pts = ' + (held > 0 ? fmt(held) + ' held + ' : '') + fmt(w.gained) + ' level-up' + (w.gained === 1 ? '' : 's') + ' (LV ' + fmt(w.after.level) + ')';
    else head = n < held ? fmt(n) + ' of ' + fmt(held) + ' pts' : fmt(w.total) + ' pts';
    const lines = [head, STATS.map((k) => SHORT[k] + ' ' + fmt(w.plan[k])).join(' · '), 'Level ratio ' + levelRatio(w.after).toFixed(3) + ' · Pet ratio ' + (petShare(w.after) * 100).toFixed(1) + '%'];
    let decider = null;
    if (maintain && w.checks.length > 1) {
      const sorted = w.checks.slice().sort((a, b) => (b.need || 0) - (a.need || 0));
      if ((sorted[0].need || 0) > (sorted[1].need || 0)) decider = sorted[0].key;
    }
    const marks = w.checks.map((c) => (!c.now ? '❌ ' + c.label + ' not met' : !c.ahead ? '⚠️ ' + c.label + ' breaks next lv' : '✅ ' + c.label + ' holds') + (c.key === decider ? ' (sets ATK/DEF)' : ''));
    w.lost.forEach((label) => marks.push('⚠️ ' + label + ' lost (not held)'));
    lines.push(marks.join(' · '));
    if (maintain && w.plan.short > 0) lines.push('⚠️ ' + fmt(w.plan.short) + ' ATK/DEF short: all pts → ATK/DEF');
    return lines;
  }

  // Presents previewLines() as: head line, one tile per stat, the two ratios, status pills. previewLines() itself is
  // untouched (it is also what the test hook exposes); this only decides how its lines look.
  function renderPreview(el, lines, w) {
    const div = (cls, text) => {
      const d = document.createElement('div');
      d.className = cls;
      if (text != null) d.textContent = text;
      return d;
    };
    const tiles = div('sb-pv-tiles');
    STATS.forEach((k) => {
      const t = div('sb-pv-tile');
      t.append(div('sb-pv-k', ICON[k] + ' ' + SHORT[k]), div('sb-pv-v', fmt(w.plan[k])));
      tiles.appendChild(t);
    });
    const ratios = div('sb-pv-ratio');
    (lines[2] || '').split(' · ').forEach((r) => ratios.appendChild(div('', r)));
    const marks = div('sb-pv-marks');
    (lines[3] || '').split(' · ').filter(Boolean).forEach((m) => {
      marks.appendChild(div('core-pill ' + (m.startsWith('✅') ? 'core-pill-ok' : m.startsWith('❌') ? 'core-pill-error' : 'core-pill-loading'), m));
    });
    const kids = [div('sb-pv-head', lines[0]), tiles, ratios, marks];
    if (lines[4]) kids.push(div('sb-pv-warn', lines[4]));
    el.replaceChildren(...kids);
  }

  // Rows shown in the Targets list: the four presets, plus a custom one only while it is the chosen one.
  function visibleKeys() {
    const held = heldKeys(state);
    return TARGET_ORDER.filter((k) => !TARGETS[k].custom || held.includes(k));
  }

  function syncUI() {
    if (!els.drawer) return;
    const s = latest || { points: 0, attack: 0, defense: 0, stamina: 0, level: 0 };
    const maintain = state.mode === 'target';
    const sum = patternSum(state);
    const rows = {};
    if (s.level > 1) advise(s).rows.forEach((r) => (rows[r.key] = r));

    els.badge.textContent = s.points > 999 ? '999+' : String(s.points);
    els.points.textContent = fmt(s.points);
    els.level.textContent = s.level ? 'LV ' + fmt(s.level) : 'LV --';
    els.ratio.textContent = s.level > 1 ? levelRatio(s).toFixed(3) : '—';
    els.share.textContent = allStats(s) > 0 ? (petShare(s) * 100).toFixed(1) + '%' : '—';
    if (tipFor) {
      renderTip();
      placeTip();
    }

    // Mode + inputs.
    els.modeBtns.forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));
    els.manualRows.style.display = maintain ? 'none' : 'flex';
    els.combatBox.style.display = maintain ? 'block' : 'none';
    els.combatBtns.forEach((b) => b.classList.toggle('active', b.dataset.combat === state.combat));
    els.combatText.textContent = state.combat === 'build' ? 'Split like your stats (' + fmt(s.attack) + ' : ' + fmt(s.defense) + ')' : '';
    STATS.forEach((k) => {
      els['cur_' + k].textContent = fmt(s[k]);
      if (!isEditing(els['p_' + k])) els['p_' + k].value = state.pattern[k];
    });

    // Targets list: Level rows and Pet rows, one pick each. Tap a row to hold it (tap it again to drop it).
    els.advLabel.title = maintain
      ? 'Tap a row to hold that target - one Level and one Pet at most (0.8 already includes 0.6, Pet 0.6 includes 0.4).\nHighlighted = held · 40/85 free = 40 of your 85 unspent points can go to Stamina and it still holds (hidden when all can)\nSTA→LV = last level reachable with every point in Stamina'
      : 'Forecast if every point from now on is spent as set above (' + (sum > 0 ? (((state.pattern.attack + state.pattern.defense) / sum) * 100).toFixed(0) : 0) + '% to ATK/DEF)\n✅/❌ = after your unspent points are spent that way';
    const ck = state.customKind === 'pet' ? 'pc' : 'lc';
    els.customKind.value = state.customKind;
    if (!isEditing(els.customVal)) els.customVal.value = (ck === 'pc' ? state.customPet : state.customLevel).toFixed(2);
    els.customVal.title = ck === 'pc' ? 'Pet ratio (ATK+DEF share of all stats) must be MORE than this' : 'Level ratio (ATK+DEF) / ((Level-1)*5) must be at least this';
    els.customAdd.textContent = state[ck === 'pc' ? 'pet' : 'lvl'] === ck ? 'Update' : '+ Custom';
    els.adv.innerHTML = '';
    if (s.level > 1) {
      const keys = visibleKeys();
      GROUPS.forEach((g) => {
        const col = document.createElement('div'); // one column per group: Level on the left, Pet on the right
        col.className = 'sb-advcol';
        const head = document.createElement('div');
        head.className = 'sb-label';
        head.textContent = g.name;
        col.appendChild(head);
        els.adv.appendChild(col);
        g.keys.filter((k) => keys.includes(k)).forEach((k) => {
          const r = rows[k];
          const T = TARGETS[k];
          const sel = state[g.id] === k;
          const row = document.createElement('div');
          row.className = 'sb-advrow sb-pick' + (sel ? ' sb-advon' : '');
          const l = document.createElement('span');
          l.className = 'sb-advl';
          l.textContent = r.label;
          const v = document.createElement('span');
          v.className = 'sb-muted';
          if (maintain) {
            row.title = r.bonus;
            v.textContent = (r.reached ? '✅ ' : '❌ ') + advRowText(r, s.points);
          } else {
            const p = sum > 0 ? projectPattern(T, s, state.pattern) : null;
            row.title = r.bonus + (p ? ' — long run: ' + (p.f * 100).toFixed(1) + '% of your points go to ATK/DEF; this needs ' + (T.kind === 'level' ? '≥ ' : '> ') + T.t + '.' : '');
            v.textContent = (p ? (p.ok ? '✅ ' : '❌ ') : '') + projText(p);
          }
          row.addEventListener('click', () => {
            const other = state[g.id === 'lvl' ? 'pet' : 'lvl'];
            if (sel) {
              if (!other) {
                setStatus('Keep at least one target on.');
                return;
              }
              state[g.id] = null;
            } else state[g.id] = k;
            changed();
          });
          row.append(l, v);
          col.appendChild(row);
        });
      });
    }

    // Allocate button + plan line (same planner as a real run).
    if (maintain) {
      if (s.level) {
        const x = s.points > 0 ? s.points : POINTS_PER_LEVEL; // with none unspent, preview the next level-up's 5
        const p = planFor(s, x, cfgFromState(previewCarry()));
        els.info.textContent =
          (s.points > 0 ? 'Allocate ' + fmt(x) + ' now: ' : 'Next level (' + x + ' pts): ') +
          STATS.map((k) => SHORT[k] + ' ' + fmt(p[k])).join(' · ') +
          (p.forced ? ' · catching up (below ' + targetLabels(state) + ')' : '');
      } else els.info.textContent = '';
      els.allocBtn.textContent = 'Allocate ' + fmt(s.points) + ' points';
      els.allocBtn.disabled = s.points < 1 || running;
      els.need.textContent = '';
      els.autoText.textContent = 'Whenever you have unspent points, reach and keep ' + targetLabels(state) + '.';
    } else {
      els.info.textContent = sum > 0 ? 'Total: ' + fmt(sum) + ' points' : 'Choose how many points go to each stat';
      els.allocBtn.textContent = sum > 0 ? 'Allocate ' + fmt(sum) + ' points' : 'Allocate';
      els.allocBtn.disabled = sum <= 0 || s.points < sum || running;
      els.need.textContent = sum > 0 && s.points < sum ? 'You have ' + fmt(s.points) + ' unspent, need ' + fmt(sum) + '.' : '';
      els.autoText.textContent = sum > 0 ? 'Whenever you have ' + fmt(sum) + ' unspent points, allocate them this way.' : '';
    }

    // "If I spend at once": empty box = your real unspent points, planned exactly like the Allocate button.
    if (!(s.level > 1) || (!maintain && sum <= 0)) {
      els.whatOut.textContent = '';
      els.whatN.placeholder = '';
    } else {
      const dflt = maintain ? (s.points > 0 ? s.points : POINTS_PER_LEVEL) : Math.max(sum, Math.floor(s.points / sum) * sum);
      const n = whatN != null ? whatN : dflt;
      els.whatN.placeholder = String(dflt);
      const w = whatIf(s, n, cfgFromState(previewCarry()));
      const lines = previewLines(s, n, w, maintain);
      renderPreview(els.whatOut, lines, w);
    }
  }

  // ---------------------------------------------------------------------
  // FORMULA TOOLTIP (hover on desktop, tap on touch, focus with keyboard)
  // ---------------------------------------------------------------------

  let tipFor = null;

  function tipContent(kind) {
    const s = latest || { points: 0, attack: 0, defense: 0, stamina: 0, level: 0 };
    const ad = fmt(s.attack) + ' + ' + fmt(s.defense);
    if (kind === 'ratio') {
      const ok = s.level > 1;
      return {
        title: 'Level ratio',
        formula: '(ATK + DEF) ÷ ((Level − 1) × 5)',
        working: ok ? '(' + ad + ') ÷ ((' + fmt(s.level) + ' − 1) × 5)' : 'level not read yet',
        result: ok ? levelRatio(s).toFixed(4) : '—',
        keys: ['l08', 'l06']
      };
    }
    const ok = allStats(s) > 0;
    return {
      title: 'Pet ratio',
      formula: '(ATK + DEF) ÷ (ATK + DEF + STA)',
      working: ok ? '(' + ad + ') ÷ ' + fmt(allStats(s)) : 'no stats read yet',
      result: ok ? (petShare(s) * 100).toFixed(2) + '%' : '—',
      keys: ['p60', 'p40']
    };
  }

  function renderTip() {
    if (!tipFor || !els.tipBody) return;
    const c = tipContent(tipFor.dataset.tip);
    const s = latest;
    const mk = (cls, text) => {
      const d = document.createElement('div');
      d.className = cls;
      d.textContent = text;
      return d;
    };
    const used = mk('sb-tip-used', '');
    c.keys.forEach((key) => {
      const T = TARGETS[key];
      const row = document.createElement('div');
      row.className = 'sb-tip-row';
      const ok = !!(s && s.level > 1 && meets(T, s));
      const l = document.createElement('span');
      l.textContent = (ok ? '✅ ' : '❌ ') + T.label;
      const r = document.createElement('span');
      r.textContent = T.kind === 'level' ? 'needs ≥ ' + T.t.toFixed(1) : 'needs > ' + Math.round(T.t * 100) + '%';
      row.append(l, r);
      used.appendChild(row);
    });
    els.tipBody.textContent = '';
    els.tipBody.append(mk('sb-tip-title', c.title), mk('sb-tip-formula', c.formula), mk('sb-tip-work', '= ' + c.working), mk('sb-tip-result', '= ' + c.result), used);
  }

  function placeTip() {
    const tip = els.tip;
    if (!tip || !tipFor) return;
    const r = tipFor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const left = clamp(r.left + r.width / 2 - tw / 2, 8, Math.max(8, vw - tw - 8));
    const below = r.bottom + 10 + th <= vh - 8 || r.top - 10 - th < 8;
    tip.style.left = Math.round(left) + 'px';
    tip.style.top = Math.round(below ? r.bottom + 10 : r.top - 10 - th) + 'px';
    tip.dataset.side = below ? 'below' : 'above';
    tip.style.setProperty('--ax', Math.round(clamp(r.left + r.width / 2 - left, 16, Math.max(16, tw - 16))) + 'px');
  }

  function showTip(chip) {
    if (!els.tip) return;
    tipFor = chip;
    renderTip();
    placeTip();
    els.tip.classList.add('on');
  }

  function hideTip() {
    tipFor = null;
    if (els.tip) els.tip.classList.remove('on');
  }

  function buildUI() {
    // The unspent-points badge rides on the Core dock button (attached in init).
    const badge = document.createElement('span');
    badge.id = 'sbDrawerBadge';
    badge.className = 'core-pill';
    badge.textContent = '0';

    // Built once and re-attached by Core.float every time the panel opens (see init).
    const drawer = document.createElement('div');
    drawer.id = 'sbDrawer';
    const $ = (sel) => drawer.querySelector(sel);

    const rows = STATS.map(
      (k) => `
        <div class="sb-arow" id="sbRow_${k}">
          <div class="sb-aname"><span>${ICON[k]} ${NAME[k]}</span><span class="sb-muted" id="sbCur_${k}">0</span></div>
          <div class="sb-step">
            <button type="button" class="sb-stepbtn core-btn core-btn-soft" data-step="${k}" data-d="-1">−</button>
            <input type="number" class="sb-stepin core-input" id="sbP_${k}" min="0" max="9999" step="1">
            <button type="button" class="sb-stepbtn core-btn core-btn-soft" data-step="${k}" data-d="1">+</button>
          </div>
        </div>`
    ).join('');
    drawer.innerHTML = `
      <div class="sb-col">
        <div class="sb-card sb-hero">
          <span class="sb-label">Unspent points</span>
          <div class="sb-big" id="sbPoints">0</div>
          <span id="sbLevel" class="core-pill">LV --</span>
          <div class="sb-chips">
            <span class="sb-chip" data-tip="ratio" tabindex="0"><span class="sb-muted">Level ratio</span><b id="sbRatio">—</b></span>
            <span class="sb-chip" data-tip="share" tabindex="0"><span class="sb-muted">Pet ratio</span><b id="sbShare">—</b></span>
          </div>
        </div>

        <div class="sb-card">
          <div class="sb-seg">
            <button type="button" class="sb-seg-btn" data-mode="target">Target</button>
            <button type="button" class="sb-seg-btn" data-mode="manual">My amounts</button>
          </div>
          <div class="sb-label" id="sbAdvLabel" style="cursor:help">Targets ⓘ</div>
          <div id="sbAdv"></div>
          <div class="sb-customrow" id="sbCustomRow">
            <select class="sb-cinput sb-csel core-input" id="sbCKind"><option value="level">Level</option><option value="pet">Pet</option></select>
            <input type="number" class="sb-cinput core-input" id="sbCV" min="0.05" max="0.99" step="0.01">
            <button type="button" class="sb-mini core-btn core-btn-soft" id="sbCAdd">+ Custom</button>
          </div>
          <div id="sbManualRows">${rows}</div>
          <div id="sbCombat">
            <div class="sb-sublabel">Points for ATK/DEF go to</div>
            <div class="sb-seg">
              <button type="button" class="sb-seg-btn" data-combat="attack">Attack</button>
              <button type="button" class="sb-seg-btn" data-combat="defense">Defense</button>
              <button type="button" class="sb-seg-btn" data-combat="build">Like my stats</button>
            </div>
            <div class="sb-muted" id="sbCombatText"></div>
          </div>
        </div>
      </div>

      <div class="sb-col">
        <div class="sb-card">
          <div class="sb-row between"><span class="sb-label" style="cursor:help" title="Leave empty to use your real unspent points. Uses the same planner as the Allocate button.">If I spend at once</span><input type="number" class="sb-input core-input" id="sbWhatN" min="1" step="1"></div>
          <div class="sb-preview" id="sbWhatOut"></div>
        </div>

        <div class="sb-card">
          <div class="sb-total" id="sbInfo"></div>
          <button type="button" class="sb-primary core-btn" id="sbAlloc">Allocate</button>
          <div class="sb-muted" id="sbNeed"></div>
        </div>

        <div class="sb-card">
          <div class="sb-row between">
            <span class="sb-strong">Repeat automatically</span>
            <label class="sb-switch"><input type="checkbox" id="sbAuto"><span class="sb-slider"></span></label>
          </div>
          <div class="sb-muted" id="sbAutoText"></div>
          <div class="sb-status" id="sbStatus">Ready.</div>
        </div>

        <details class="sb-card sb-adv">
          <summary>Advanced</summary>
          <div class="sb-row between">
            <span>Check every</span>
            <span class="sb-inline"><input type="number" class="sb-input core-input" id="sbPoll" min="${POLL_MIN_SECONDS}"> <span class="sb-muted">sec</span></span>
          </div>
        </details>
      </div>
    `;

    const tip = document.createElement('div');
    tip.id = 'sbTip';
    tip.className = 'sb-tip';
    tip.setAttribute('role', 'tooltip');
    tip.innerHTML = '<div class="sb-tip-arrow"></div><div class="sb-tip-body"></div>';
    document.body.appendChild(tip);

    els = {
      drawer,
      tip,
      tipBody: tip.querySelector('.sb-tip-body'),
      badge,
      level: $('#sbLevel'),
      points: $('#sbPoints'),
      ratio: $('#sbRatio'),
      share: $('#sbShare'),
      modeBtns: Array.from(drawer.querySelectorAll('[data-mode]')),
      advLabel: $('#sbAdvLabel'),
      adv: $('#sbAdv'),
      customKind: $('#sbCKind'),
      customVal: $('#sbCV'),
      customAdd: $('#sbCAdd'),
      stepBtns: Array.from(drawer.querySelectorAll('[data-step]')),
      manualRows: $('#sbManualRows'),
      combatBox: $('#sbCombat'),
      combatBtns: Array.from(drawer.querySelectorAll('[data-combat]')),
      combatText: $('#sbCombatText'),
      info: $('#sbInfo'),
      allocBtn: $('#sbAlloc'),
      need: $('#sbNeed'),
      auto: $('#sbAuto'),
      autoText: $('#sbAutoText'),
      status: $('#sbStatus'),
      whatN: $('#sbWhatN'),
      whatOut: $('#sbWhatOut'),
      pollSeconds: $('#sbPoll')
    };
    STATS.forEach((k) => {
      els['p_' + k] = $('#sbP_' + k);
      els['cur_' + k] = $('#sbCur_' + k);
    });
  }

  function changed() {
    saveState();
    syncUI();
  }

  function wireEvents() {
    let touched = false;
    Array.from(els.drawer.querySelectorAll('[data-tip]')).forEach((chip) => {
      const isMouse = (e) => !e.pointerType || e.pointerType === 'mouse';
      chip.addEventListener('pointerdown', (e) => {
        touched = !isMouse(e);
      });
      chip.addEventListener('pointerenter', (e) => {
        if (isMouse(e)) showTip(chip);
      });
      chip.addEventListener('pointerleave', (e) => {
        if (isMouse(e)) hideTip();
      });
      chip.addEventListener('focus', () => {
        if (!touched) showTip(chip);
      });
      chip.addEventListener('blur', hideTip);
      chip.addEventListener('click', () => {
        if (!touched) return;
        touched = false;
        if (tipFor === chip) hideTip();
        else showTip(chip);
      });
    });
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (tipFor && !tipFor.contains(e.target)) hideTip();
      },
      true
    );
    document.addEventListener('scroll', hideTip, true); // the modal card is the scroller
    window.addEventListener('resize', hideTip);

    els.auto.addEventListener('change', () => {
      state.enabled = els.auto.checked;
      failStreak = 0;
      saveState();
      if (state.enabled) {
        setStatus('Auto-allocate on - checking now…');
        pollNow();
      } else {
        setStatus('Auto-allocate off.');
      }
      syncUI();
    });

    els.modeBtns.forEach((b) =>
      b.addEventListener('click', () => {
        state.mode = b.dataset.mode;
        changed();
      })
    );

    els.customKind.addEventListener('change', () => {
      state.customKind = els.customKind.value;
      changed();
    });
    els.customVal.addEventListener('change', () => {
      const pet = state.customKind === 'pet';
      const v = cleanRatio(els.customVal.value, pet ? state.customPet : state.customLevel);
      if (pet) state.customPet = v;
      else state.customLevel = v;
      applyCustom();
      changed();
    });
    els.customAdd.addEventListener('click', () => {
      // choosing the custom Level (or Pet) replaces whatever Level (or Pet) was held
      if (state.customKind === 'pet') state.pet = 'pc';
      else state.lvl = 'lc';
      changed();
    });

    els.whatN.addEventListener('input', () => {
      const v = els.whatN.value.trim();
      whatN = v === '' ? null : clamp(toInt(v), 1, 100000000);
      syncUI();
    });
    els.combatBtns.forEach((b) =>
      b.addEventListener('click', () => {
        state.combat = b.dataset.combat;
        changed();
      })
    );
    STATS.forEach((k) =>
      els['p_' + k].addEventListener('change', () => {
        state.pattern[k] = cleanPoints(els['p_' + k].value);
        els['p_' + k].value = state.pattern[k];
        changed();
      })
    );
    els.stepBtns.forEach((b) =>
      b.addEventListener('click', () => {
        const k = b.dataset.step;
        state.pattern[k] = cleanPoints(state.pattern[k] + toInt(b.dataset.d));
        changed();
      })
    );
    els.allocBtn.addEventListener('click', () => exclusiveRun(true));
    els.pollSeconds.addEventListener('change', () => {
      state.pollSeconds = Math.max(POLL_MIN_SECONDS, toInt(els.pollSeconds.value) || 60);
      els.pollSeconds.value = state.pollSeconds;
      saveState();
      schedulePoll();
    });
  }

  // ---------------------------------------------------------------------
  // STYLES
  // ---------------------------------------------------------------------

  function injectStyles() {
    const css = `
#sbDrawerBadge{padding:1px 7px;font-size:11px;letter-spacing:0;text-transform:none;color:#cfdcff;border-color:rgba(110,168,255,.4);background:rgba(110,168,255,.12);font-variant-numeric:tabular-nums}
#sbDrawer{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start;color:#eef3ff;font:13px Arial,sans-serif;box-sizing:border-box}
.sb-col{display:flex;flex-direction:column;gap:12px;min-width:0}
@media (max-width:760px){#sbDrawer{grid-template-columns:1fr}}
#sbDrawer *{box-sizing:border-box}
.sb-card{background:#11192d;border:1px solid rgba(255,255,255,.06);border-radius:16px;padding:12px;display:flex;flex-direction:column;gap:8px;flex-shrink:0}
.sb-hero{align-items:center;text-align:center;gap:6px}
.sb-hero .sb-chips{width:100%}
.sb-label,.sb-sublabel{font-size:11px;color:#9caad0;font-weight:700;text-transform:uppercase;letter-spacing:.03em}
.sb-sublabel{margin-bottom:6px}
.sb-strong{font-weight:800;color:#eef3ff;font-size:13px}
.sb-muted{font-size:12px;color:#9caad0;line-height:1.5}
.sb-muted:empty,#sbNeed:empty,#sbInfo:empty,.sb-preview:empty{display:none}
.sb-row{display:flex;align-items:center;gap:8px;font-size:13px;color:#eef3ff}
.sb-row.between{justify-content:space-between}
.sb-inline{display:inline-flex;align-items:center;gap:6px}
.sb-status{font-size:12px;color:#9caad0;line-height:1.4}
.sb-preview{display:flex;flex-direction:column;gap:10px;font-variant-numeric:tabular-nums}
.sb-pv-head{font-size:12px;color:#9caad0}
.sb-pv-tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.sb-pv-tile{background:#0d1322;border:1px solid rgba(255,255,255,.06);border-radius:12px;padding:10px 4px;text-align:center}
.sb-pv-k{font-size:11px;font-weight:700;color:#9caad0;letter-spacing:.03em}
.sb-pv-v{font-size:24px;font-weight:800;color:#eef3ff;line-height:1.25}
.sb-pv-ratio{display:flex;justify-content:space-between;gap:8px;font-size:12px;color:#cfd8f7}
.sb-pv-marks{display:flex;flex-wrap:wrap;gap:6px}
.sb-pv-marks .core-pill{text-transform:none;font-size:11px;letter-spacing:0;padding:3px 9px}
.sb-pv-warn{font-size:12px;color:#ffd978}
.sb-big{font-size:40px;font-weight:800;color:#eef3ff;font-variant-numeric:tabular-nums;line-height:1}
.sb-chips{display:flex;gap:8px}
.sb-chip{flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;background:#0d1322;border:1px solid rgba(255,255,255,.06);border-radius:12px;padding:9px 4px;font-variant-numeric:tabular-nums;text-align:center;cursor:help;outline:none}
.sb-chip b{font-size:16px;font-weight:800;color:#eef3ff}
.sb-chip:focus-visible{border-color:#4b6dd0}
.sb-chip .sb-muted{border-bottom:1px dotted #4b6dd0}
#sbDrawer .sb-input{width:72px}
#sbDrawer .sb-stepin{width:62px;text-align:center;font-weight:700;font-variant-numeric:tabular-nums}
#sbDrawer .sb-cinput{width:76px;text-align:center;font-weight:700;font-variant-numeric:tabular-nums}
#sbDrawer .sb-csel{width:78px;text-align:left}
#sbDrawer .sb-stepbtn{width:34px;height:34px;padding:0;font-size:18px;line-height:1;box-shadow:none}
#sbDrawer .sb-mini{flex:1;padding:8px 2px;white-space:nowrap}
#sbDrawer .sb-primary{width:100%;padding:11px;font-size:14px}
.sb-arow{display:flex;align-items:center;justify-content:space-between;gap:8px}
.sb-aname{display:flex;align-items:baseline;gap:8px;font-size:13px;font-weight:800;color:#eef3ff}
.sb-step{display:flex;align-items:center;gap:4px}
#sbManualRows{display:flex;flex-direction:column;gap:6px}
.sb-total{font-size:12px;color:#9caad0;font-weight:700}
.sb-seg{display:flex;background:#0d1322;border:1px solid #2b3859;border-radius:12px;padding:3px;gap:3px}
.sb-seg-btn{flex:1;background:transparent;border:none;color:#9caad0;font:700 12px Arial,sans-serif;padding:8px 4px;border-radius:9px;cursor:pointer}
.sb-seg-btn:hover{color:#eef3ff}
.sb-seg-btn.active{background:linear-gradient(135deg,#3657a7,#4b6dd0);color:#fff}
#sbAdv{display:grid;grid-template-columns:1fr 1fr;gap:8px;align-items:start}
.sb-advcol{display:flex;flex-direction:column;gap:4px;min-width:0}
.sb-advrow{display:flex;flex-direction:column;align-items:flex-start;gap:1px;padding:6px 10px;border:1px solid transparent;border-radius:12px;font-size:12px;transition:transform .15s ease,box-shadow .15s ease,border-color .15s ease,background .15s ease}
.sb-advl{font-weight:800;color:#eef3ff}
.sb-pick{cursor:pointer}
.sb-pick:hover{transform:translateY(-2px);border-color:rgba(110,168,255,.3);box-shadow:0 8px 20px rgba(0,0,0,.35);background:#141d38}
.sb-advon{border-color:rgba(110,168,255,.35);background:rgba(110,168,255,.05);box-shadow:inset 3px 0 0 #6ea8ff}
.sb-advon:hover{border-color:rgba(110,168,255,.35);background:rgba(110,168,255,.05);box-shadow:0 0 0 2px rgba(110,168,255,.45) inset,0 10px 24px rgba(110,168,255,.22)}
.sb-customrow{display:flex;gap:6px;align-items:center}
.sb-tip{position:fixed;z-index:300000;width:min(270px,calc(100vw - 16px));box-sizing:border-box;background:#171e33;border:1px solid rgba(255,255,255,.1);border-radius:12px;box-shadow:0 12px 28px rgba(0,0,0,.45);padding:12px 13px;color:#eef3ff;font:12px/1.4 Arial,sans-serif;pointer-events:none;opacity:0;visibility:hidden;transform:translateY(4px);transition:opacity .12s ease,transform .12s ease,visibility .12s}
.sb-tip[data-side=above]{transform:translateY(-4px)}
.sb-tip.on{opacity:1;visibility:visible;transform:none}
.sb-tip-arrow{position:absolute;left:var(--ax,50%);width:10px;height:10px;background:#171e33;border:1px solid rgba(255,255,255,.1);transform:translateX(-50%) rotate(45deg)}
.sb-tip[data-side=below] .sb-tip-arrow{top:-6px;border-right:none;border-bottom:none}
.sb-tip[data-side=above] .sb-tip-arrow{bottom:-6px;border-left:none;border-top:none}
.sb-tip-title{font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#9caad0;margin-bottom:8px}
.sb-tip-formula{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;background:#0d1322;border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:8px 9px;color:#cfd8f7}
.sb-tip-work{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;color:#9caad0;margin-top:8px;font-variant-numeric:tabular-nums;word-break:break-word}
.sb-tip-result{font-size:20px;font-weight:800;color:#fff;margin-top:2px;font-variant-numeric:tabular-nums}
.sb-tip-used{margin-top:10px;padding-top:9px;border-top:1px solid rgba(255,255,255,.06);display:flex;flex-direction:column;gap:4px}
.sb-tip-row{display:flex;justify-content:space-between;gap:8px;font-size:12px}
.sb-tip-row span:last-child{color:#9caad0}
.sb-switch{position:relative;display:inline-flex;align-items:center}
.sb-switch input{position:absolute;opacity:0;pointer-events:none}
.sb-slider{position:relative;width:40px;height:22px;border-radius:999px;background:#2b3859;border:1px solid rgba(255,255,255,.08);transition:background .18s ease}
.sb-slider::before{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .18s ease}
.sb-switch input:checked + .sb-slider{background:linear-gradient(135deg,#3657a7,#4b6dd0)}
.sb-switch input:checked + .sb-slider::before{left:20px}
.sb-switch input:focus-visible + .sb-slider{box-shadow:0 0 0 2px rgba(110,168,255,.55)}
.sb-adv summary{cursor:pointer;font-size:11px;font-weight:700;color:#9caad0;text-transform:uppercase;letter-spacing:.03em}
.sb-adv[open] summary{margin-bottom:6px}
`;
    Core.ui.css(ID, css);
  }

  if (window.__VEYRA_TEST__) {
    Object.assign(window.__VEYRA_TEST__.api, { advRowText, previewLines, exclusiveRun, recoverJournal, fetchStats, readJournal, getLatest: () => latest, getState: () => state, setState: (p) => Object.assign(state, p), runOnce });
  }

  // ---------------------------------------------------------------------
  // INIT
  // ---------------------------------------------------------------------

  function init() {
    injectStyles();
    buildUI();
    wireEvents();
    const ctl = Core.float.add({
      id: ID,
      title: 'Auto Stat Builder',
      order: 40,
      width: 800,
      render(el) {
        el.replaceChildren(els.drawer);
        syncUI();
      },
      onHide: hideTip
    });
    // Like the userscript's button: just the unspent-points number (Core would otherwise show a placeholder dot).
    if (ctl) ctl.button.replaceChildren(els.badge);
    els.auto.checked = state.enabled;
    els.pollSeconds.value = state.pollSeconds;
    syncUI();

    setStatus('Ready.');
    setTimeout(pollStats, 800);
  }

  Core.dom.ready.then(init);
})();
