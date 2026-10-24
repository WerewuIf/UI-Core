/* automator.js — Automator addon for Core (one file, swappable parts)
 *
 * Plain script, no ==UserScript== header. `Core` is in scope (>= 3.16.0: Core.auth, Core.potions, Core.tab, Core.me, and Core.caps/call for presets;
 * on an older Core everything works except the per-boss preset dropdowns).
 *
 *   PART 0  KERNEL     config, log, diagnostics, action queue, player state, auth guard, part registry, scheduler
 *   PART 1  BOSSES     wave bosses: roster, authoritative page scans, attack engine, side-mob (toggle), potions,
 *                      auto-farm coordination, preset bridge (gear / crystal / pet, found through Core capabilities)
 *   PART 1b BUILD KIT  crystals + sigils that follow the Build Engine's gear / pets, and the way back (swappable: without it Auto still
 *                      picks gear + pets, it just leaves crystals and sigils alone)
 *   PART 2  DUNGEONS   Castle bosses (+ Khaal phases), Shadowbridge Gribble swarm. NOT the cube: Cube Suite owns it.
 *                      Swappable: turn the part off (or delete it) and the wave bosses keep working.
 *   PART 3  DUELS      Phase duels, shared by wave and dungeon bosses
 *   PART 4  LOOT       graveyard scan + EXP-aware auto-loot
 *   PART 4b LOOT SCAN  reads every boss's loot / level / EXP cap into the cap choices; Export .txt (swappable)
 *   PART 5  [slots]    quests / adventurers guild / PvP / dailies: Kernel.register({ id, name, icon, every, tick, panel })
 *   PART 5  PANEL      Core.float panel: Overview, Bosses (Waves | Dungeons, waves grouped by area), Loot, Settings, Activity
 *
 * LOOT DATA: the Loot scan (PART 4b, the Scan button at the top of the Bosses tab) reads every boss's battle page and saves its loot DMG
 * requirements, Level Req and EXP Cap into one store ('automator-loot'). Here they become the cap choices of each boss, the
 * default cap of a boss is its highest loot requirement, and bosses the roster did not know yet are added. Export .txt writes it all out.
 */
Core.module({
  id: 'automator', name: 'Automator', icon: '🤖', version: '1.10.1',
  // Offered to other addons through Core capabilities (guides/CAPABILITIES.md):
  //   automator.status() -> the status string     automator.start() / automator.stop()     automator.scan() -> scan the bosses now
  provides: (api) => api && api.start ? {
    'automator.status': { fn: api.status, doc: 'what the automator is doing right now', returns: 'string' },
    'automator.start':  { fn: api.start,  doc: 'start auto-attacking the ticked bosses' },
    'automator.stop':   { fn: api.stop,   doc: 'stop attacking' },
    'automator.scan':   { fn: api.scanNow, doc: 'rescan the bosses now' },
  } : {},
  init(Core) {
'use strict';
const ID = 'automator', VERSION = '1.10.3';
if (window.__automatorLoaded) { console.warn('[automator] already loaded', window.__automatorLoaded); return null; }
window.__automatorLoaded = VERSION;

/* ===================================================================================================================
 * PART 0 — KERNEL
 * ================================================================================================================ */

const BASE = location.origin;
const sleep = Core.sleep;
const ts = () => new Date().toLocaleTimeString('en-GB', { hour12: false });
const esc = Core.esc;
const cookie = (n) => { const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + n + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : null; };
function parseNum(v, fb = 0) { const n = parseInt(String(v == null ? '' : v).replace(/[,\s_]/g, ''), 10); return Number.isFinite(n) ? n : fb; }
function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 1e12) return (n / 1e12).toFixed(2) + 'T';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}
function fmtDur(ms) {
  let s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's';
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60);
  const out = [];
  if (d) out.push(d + 'd'); if (h) out.push(h + 'h'); if (m && !d) out.push(m + 'm');
  return out.join(' ') || '0m';
}
// "5B", "750m", "1.5b", "2,000,000,000" -> number (null if unreadable)
function parseCap(str) {
  const m = String(str == null ? '' : str).trim().replace(/[,_\s]/g, '').match(/^(\d+(?:\.\d+)?)([kmbt])?$/i);
  if (!m) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[(m[2] || '').toLowerCase()] || 1;
  return Math.round(parseFloat(m[1]) * mult);
}
const parseHtml = (html) => new DOMParser().parseFromString(html, 'text/html');

/* ---- config (one Core.store, per player, shared across tabs) ---------------------------------------------------- */
const OPT_MODE = 'dps';                                               // what the Build Engine maximises:  'noncrit' = the best plain (non-crit) hit  |  'dps' = the best average hit (non-crit and crit, weighted by crit rate)
const DEFAULT_CFG = {
  v: 2,                                // 2 = the old-default migrations in mergeCfg() have run (they must not rerun: they used to overwrite a value you typed)
  targets: [],                         // nameLow list = enabled bosses, in priority order (first alive + uncapped wins)
  bosses: {},                          // nameLow -> { cap, targeting:'auto|normal|shielded', <kind>:'' | '__keep' | presetId (one per preset kind offered: gear, crystal, pet, …; '' = use the default loadout), schedule:[{ at:'HH:MM', cap }] (server time) }
  loadout: {},                         // preset kind -> preset id applied on every boss without a pick of its own ('' = keep what is equipped)
  autoBuild: { enabled: false, order: true, crystals: true, sigils: true, restore: true },   // enabled: every boss (wave, Generals, dungeon bosses and mobs) gets the Build Engine's best gear + pets. crystals: Auto-assign Best on the gear that is on. sigils: move with the pets. order: fewest build changes between bosses. restore: put your own build back when the run stops
  defaultBossCap: 3_000_000_000,
  maxTier: 'WORLD_BREAKER',            // always the strongest; pickTier steps down only when less is left under the cap
  classOverride: 'auto', useClassSkill: true,
  attackDelayMs: 0,                    // extra pause between swings, WAVE bosses (0: swings are only spaced by the request gap)
  dungeonAttackDelayMs: 0,             // dungeon bosses chain swings back-to-back
  minActionGapMs: 450, skillToAttackGapMs: 1250,
  fightScanMs: 300000,                 // THE scan interval: wave pages and dungeon maps follow this (Settings → Timing, in minutes). The graveyard has no timer: Scan graveyard / Loot now / out of stamina
  spawnLeadMs: 5000,
  mana: { enabled: true, type: 'S', threshold: 20 },     // drink a mana potion when MP <= threshold (or below the class skill's cost)
  stam: { enabled: false, item: 'Large Stamina Potion', save: { thresholdPct: 100 } },     // item: 'Large Stamina Potion' | 'Full Stamina Potion'
  hp: { enabled: false, thresholdPct: 0 },                // drinks when the server says you are dead (HP 0)
  autoFarmControl: true,
  autoDuel: true,
  sideMob: { enabled: false },                         // shield pierce on a side mob: automatic once switched on (off: it shouldn't be needed)
  autoLoot: { enabled: false, mode: 'toLevel', claimGapMs: 250 },
  parts: { bosses: true, dungeons: true, duels: true, loot: true },
  logFilter: 'all',
};
const cfgStore = Core.store(ID, { def: DEFAULT_CFG });
const stateStore = Core.store(ID + '-state', { def: { run: false, afPaused: 0, board: {}, status: 'STOPPED', statusAt: 0, mainTab: '' } });
const logStore = Core.store(ID + '-log', { def: [] });

function mergeCfg(saved) {
  const d = JSON.parse(JSON.stringify(DEFAULT_CFG)), s = saved && typeof saved === 'object' ? saved : {};
  const out = Object.assign(d, s);
  for (const k of ['mana', 'hp', 'sideMob', 'autoLoot', 'autoBuild']) out[k] = Object.assign({}, DEFAULT_CFG[k], s[k] || {});
  { const ab = out.autoBuild; ab.enabled = !!ab.enabled; ab.order = ab.crystals = ab.sigils = ab.restore = true; }   // only Auto is a choice: fewest changes, best crystals, sigils following the pets and putting your build back are always on (old saves with them off are overridden)
  delete out.sideMob.locked; delete out.sideMob.lockedKey; delete out.sideMob.source;      // (old picks: the pierce is automatic now)
  out.autoLoot.mode = 'toLevel';                                     // claims only what levels you up: not a setting any more
  out.parts = Object.assign({}, DEFAULT_CFG.parts); Object.keys(out.parts).forEach((k) => { out.parts[k] = true; });   // modules are always on
  out.maxTier = 'WORLD_BREAKER';
  // stamina: one potion (Large or Full). Older saves had two slots (A, then B): keep whichever was switched on.
  const os = s.stam || {}, A = os.A || {}, B = os.B || {};
  const on = os.enabled != null ? !!os.enabled : !!(A.enabled || B.enabled);
  const item = os.item || (A.enabled ? A.item : B.enabled ? B.item : '') || DEFAULT_CFG.stam.item;
  out.stam = { enabled: on, item: /full/i.test(item) ? 'Full Stamina Potion' : 'Large Stamina Potion', save: (() => { const sv = Object.assign({}, DEFAULT_CFG.stam.save, os.save); if (sv.enabled === false) sv.thresholdPct = 100; delete sv.enabled; return sv; })() };   // the switch is gone: it was off -> 100 (never save)
  out.hp.thresholdPct = 0;
  if (!(s.v >= 2)) {                                                  // old defaults move to the new ones, ONCE (matching on the value alone also rewrote a 30 s scan or 500 ms claim gap you chose yourself, on every reload / tab sync)
    if (out.fightScanMs === 30000) out.fightScanMs = 300000;
    if (out.attackDelayMs === 350) out.attackDelayMs = 0;
    if (out.autoLoot.claimGapMs === 500) out.autoLoot.claimGapMs = 250;
  }
  out.v = 2;
  delete out.autoLoot.scanMs; delete out.maxIdleRecheckMs;            // retired: the graveyard no longer scans on a timer
  delete out.mana.fullMaxAt0; delete out.mana.fillTo; delete out.mana.name;
  out.loadout = s.loadout && typeof s.loadout === 'object' ? Object.assign({}, s.loadout) : {};
  if (out.loadout.best && out.loadout.best !== '__keep') out.autoBuild.enabled = true;
  delete out.loadout.best;
  out.targets = Array.isArray(s.targets) ? s.targets.slice() : [];
  out.bosses = s.bosses && typeof s.bosses === 'object' ? s.bosses : {};
  out.shadowAll = !!s.shadowAll;                                   // show every Shadowbridge mob type (off: only the Gribbles and the boss are loaded)
  out.ignored = Array.isArray(s.ignored) ? s.ignored.filter((x) => typeof x === 'string') : [];      // monsters you removed: the loot scan never adds them back
  for (const o of Object.values(out.bosses)) {                               // one "switch cap at" pair -> the first cap change
    if (!o) continue;
    if (o.switchAt && o.capAfterSwitch != null && !Array.isArray(o.schedule)) o.schedule = [{ at: o.switchAt, cap: o.capAfterSwitch }];
    delete o.switchAt; delete o.capAfterSwitch;
    if (o.best === '__keep') { if (!o.gear) o.gear = '__keep'; if (!o.pet) o.pet = '__keep'; }              // the old "Best" dropdown: keep equipped = keep gear + pets
    delete o.best; delete o.build;                                                                         // (a boss follows the Loadout card unless it has a gear / pet pick of its own)
  }
  return out;
}
let cfg = mergeCfg(cfgStore.get());
function saveCfg() { cfgStore.set(cfg); }
cfgStore.watch((v) => { if (v && JSON.stringify(v) !== JSON.stringify(cfg)) { cfg = mergeCfg(v); UI.dirty(); } });

/* ---- log (batched writes, newest last) -------------------------------------------------------------------------- */
const Log = (() => {
  let rows = []; let timer = 0, dirty = false;
  try { const r = logStore.get(); if (Array.isArray(r)) rows = r; } catch (_) { /* */ }
  const kindOf = (m, k) => {
    if (k) return k;
    if (/^[^a-z]*(❌|⛔)/i.test(m)) return 'err';
    if (/^[^a-z]*(⚠️|⏳|🔒)/i.test(m)) return 'warn';
    if (/^[^a-z]*⚔️/.test(m)) return 'dmg';
    if (/^[^a-z]*🔮/.test(m)) return 'skill';
    if (/^[^a-z]*(✅|🔓)/.test(m)) return 'ok';
    return 'info';
  };
  function flush() { timer = 0; if (!dirty) return; dirty = false; try { logStore.set(rows); } catch (_) { /* */ } }
  function add(msg, kind) {
    rows.push({ t: ts(), k: kindOf(msg, kind), m: String(msg) });
    if (rows.length > 300) rows.splice(0, rows.length - 300);
    dirty = true; if (!timer) timer = setTimeout(flush, 2500);
    UI.dirty('log');
  }
  const clear = () => { rows = []; dirty = true; flush(); UI.dirty('log'); };
  const all = () => rows;
  logStore.watch((v) => { if (Array.isArray(v) && !Tab.isMain()) { rows = v; UI.dirty('log'); } });
  window.addEventListener('beforeunload', flush);
  return { add, clear, all, flush };
})();
const log = (m, k) => Log.add(m, k);

/* ---- diagnostics: every skipped tick says why ------------------------------------------------------------------- */
const Diag = (() => {
  const counts = {}, events = []; let last = { reason: '', at: 0, detail: '' };
  function skip(reason, detail) {
    counts[reason] = (counts[reason] || 0) + 1;
    if (last.reason !== reason || last.detail !== (detail || '')) {
      events.push({ t: ts(), reason, detail: detail || '' }); if (events.length > 80) events.shift();
      UI.dirty('diag');
    }
    last = { reason, at: Date.now(), detail: detail || '' };
  }
  const clear = () => { for (const k of Object.keys(counts)) delete counts[k]; events.length = 0; last = { reason: '', at: 0, detail: '' }; UI.dirty('diag'); };
  return { skip, counts, events, last: () => last, clear };
})();

/* ---- one request at a time for everything that changes state (attack, join, potion, loot, auto-farm) ------------- */
const Act = (() => {
  let chain = Promise.resolve(), lastDone = 0;
  // gap = minimum quiet time since the previous action finished
  function run(fn, gap = 0) {
    const p = chain.then(async () => {
      const wait = gap - (Date.now() - lastDone); if (wait > 0) await sleep(wait);
      try { return await fn(); } finally { lastDone = Date.now(); }
    });
    chain = p.catch(() => {});
    return p;
  }
  return { run, mark: () => { lastDone = Date.now(); } };
})();
// boss scan (alive pages) and graveyard scan (dead pages) swap the site's cookie mode: they take turns, never overlap
const Lane = (() => { let tail = Promise.resolve(), n = 0; return { busy: () => n > 0, run(fn) { n++; const p = tail.then(fn).finally(() => n--); tail = p.catch(() => {}); return p; } }; })();

const withTimeout = (p, ms, dflt) => Promise.race([p, new Promise((res) => setTimeout(() => res(dflt), ms))]);
// POST through Core.net (keeps the page caches honest). Never throws.
async function post(url, params) {
  try {
    const r = await withTimeout(Core.net.post(url, params), 20000, { ok: false, status: 0, text: '', json: null, timeout: true });
    if (r && !r.json && r.text && Core.auth && /<\s*html|login-container/i.test(r.text.slice(0, 4000))) {
      const st = Core.auth.pageState(r.text); if (st && st !== 'ok') Guard.fault(st, url);
    }
    return r || { ok: false, status: 0, text: '', json: null };
  } catch (e) { return { ok: false, status: 0, text: String((e && e.message) || e), json: null, error: true }; }
}
// POST as multipart FormData, the exact shape 3.0.0 used for join / damage (known to work against the live site). Never throws.
async function postForm(url, fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields || {})) if (v !== undefined && v !== null) fd.append(k, v);
  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), 20000) : 0;
  try {
    const res = await window.fetch(url, { method: 'POST', credentials: 'include', body: fd, signal: ac ? ac.signal : undefined });
    const text = await res.text();
    const json = Core.parseJson(text);
    if (!json && text && /<\s*html|login-container/i.test(text.slice(0, 4000))) { const st = Guard.pageState(text); if (st !== 'ok') Guard.fault(st, url); }
    return { ok: res.ok, status: res.status, text, json };
  } catch (e) { return { ok: false, status: 0, text: String((e && e.message) || e), json: null, error: true }; }
  finally { if (timer) clearTimeout(timer); }
}
const uid = () => { const c = cookie('demon'); if (c && /^\d+$/.test(c)) return c; const p = Core.player.id(); return p && p !== 'default' ? String(p) : ''; };

/* ---- player state ---------------------------------------------------------------------------------------------- */
const Me = {
  hp: 0, maxHp: 1, mp: 0, maxMp: 1, statsAt: 0, syncAt: 0, mpKnown: false, hpKnown: false,
  stam() { const m = Core.me.get(); return m && m.stamina && m.stamina.cur != null ? m.stamina.cur : 0; },
  stamKnown() { const m = Core.me.get(); return !!(m && m.stamina && m.stamina.cur != null); },
  maxStam() { const m = Core.me.get(); return m && m.stamina && m.stamina.max ? m.stamina.max : 1; },
  expPct() { const m = Core.me.get(); const e = m && m.exp; return e && e.max > 0 ? (e.cur / e.max) * 100 : null; },
  level() { const m = Core.me.get(); return (m && m.level) || 0; },
  // HP / MP are not tracked by Core.me. The wave pages carry them as `.player-resources .res-row` (label + "cur / max"; game_dash.php does not):
  // the scan already fetches those pages, so Scan.page feeds this for free; refresh() reads a wave page when it needs them now.
  readRes(doc) {
    let h = null, hMax = null, m = null, mMax = null;
    doc.querySelectorAll('.player-resources .res-row').forEach((row) => {
      const lbl = (row.querySelector('.res-label') || {}).textContent || '';
      const meta = ((row.querySelector('.res-meta') || {}).textContent || '').trim(); if (!meta) return;
      const [a, b] = meta.split('/');
      if (/\bhp\b/i.test(lbl)) { h = parseNum(a, h); if (b) hMax = parseNum(b, hMax); }
      else if (/\b(mp|mana)\b/i.test(lbl)) { m = parseNum(a, m); if (b) mMax = parseNum(b, mMax); }
    });
    if (h === null) { const el = doc.querySelector('.playerhp .muted'); if (el) { const [a, b] = el.textContent.trim().split('/'); h = parseNum(a, h); if (b) hMax = parseNum(b, hMax); } }
    if (m === null) {
      const el = doc.getElementById('mp_span') || doc.querySelector('[id*="mana"]');
      if (el) { m = parseNum(el.textContent, m); const mm = (el.parentElement ? el.parentElement.textContent : '').match(/([\d,]+)\s*\/\s*([\d,]+)/); if (mm) { m = parseNum(mm[1]); mMax = parseNum(mm[2]); } }
    }
    if (hMax) Me.maxHp = hMax; if (mMax) Me.maxMp = mMax;
    if (h !== null && h >= 0) { Me.hp = h; Me.hpKnown = true; }
    if (m !== null) { Me.mp = m; if (Me.maxMp > 1) Me.mpKnown = true; }
    if (h !== null || m !== null) { Me.statsAt = Date.now(); UI.dirty('status'); }
    return h !== null;
  },
  async refresh(maxAgeMs = 15000) {
    if (Date.now() - Me.statsAt < maxAgeMs) return true;
    const read = async (url) => {
      let html;
      try { html = await Core.net.fetchText(url, { force: true, ttl: 0 }); } catch (e) { Diag.skip('stats-fetch-failed', e.message); return null; }
      const doc = parseHtml(html), st = Guard.pageState(doc); if (st !== 'ok') { Guard.fault(st, url); return null; }
      return Me.readRes(doc);
    };
    const low = [...cfg.targets, ...Roster.list.map((d) => d.low)].find((l) => bossLoc(l)), loc = low && bossLoc(low);
    const got = (loc && (await read(`/active_wave.php?gate=${loc.gate}&wave=${loc.wave}`))) || (await read('/game_dash.php'));      // game_dash.php has no resource block: only a fallback
    if (got === null) return false;
    if (Date.now() - Me.syncAt > 60000) { Me.syncAt = Date.now(); try { Promise.resolve(Core.me.sync()).catch(() => {}); } catch (_) { /* */ } }   // stamina / EXP / level came with the dashboard fetch
    Me.statsAt = Date.now();
    return true;
  },
  fromAttack(j) {
    try { Core.me.fromAttack(j); } catch (_) { /* Core older than 3.14 */ }
    const mana = j && (j.mana !== undefined ? j.mana : j.mp); if (mana !== undefined && mana !== null) Me.mp = parseNum(mana, Me.mp);   // damage.php answers `mana`; `hp` in it is the BOSS's, ours is retaliation.user_hp_after
    const hpAfter = j && j.retaliation && j.retaliation.user_hp_after; if (hpAfter !== undefined) Me.hp = parseNum(hpAfter, Me.hp);
  },
};

/* ---- server clock (Core.me.serverNow is the server's own clock in ms) ------------------------------------------ */
// Server wall-clock minutes since midnight. Core.clock is on the SERVER's zone (India, UTC+5:30); the raw UTC getters used
// before were 5h30 off, so a scheduled cap switch fired at the wrong time. null until a page with the top bar was seen.
function serverMinutes() {
  try { const p = Core.clock.parts(); return p && p.known ? p.hour * 60 + p.minute : null; } catch (_) { return null; }
}
function parseClock(str) {   // "HH:MM" or "H:MM AM/PM" -> 'HH:MM' | null
  const m = String(str || '').trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i); if (!m) return null;
  let h = parseInt(m[1], 10); const mi = m[2] != null ? parseInt(m[2], 10) : 0; const ap = m[3] && m[3].toLowerCase();
  if (mi < 0 || mi > 59) return null;
  if (ap) { if (h < 1 || h > 12) return null; h = ap === 'am' ? (h === 12 ? 0 : h) : (h === 12 ? 12 : h + 12); } else if (h < 0 || h > 23) return null;
  return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
}

/* ---- tab leadership: Core.tab (Web Locks). Only the MAIN tab works; the others just show the panel -------------- */
const Tab = (() => {
  let role = null;
  const isMain = () => role === 'main' || (role === null && !(navigator.locks && navigator.locks.request));
  async function join() {
    if (isDuelPage()) { role = 'idle'; return; }      // the duel page is driven by Duels.bootPage(); another tab does the farming
    try {
      role = await Core.tab.join(ID, {
        queue: true,                                     // idle tabs are promoted the moment the main tab closes/crashes
        onMain: () => { role = 'main'; Kernel.becameMain(); UI.dirty(); },
        onIdle: () => { role = 'idle'; Kernel.becameIdle(); UI.dirty(); },
      });
    } catch (e) { role = 'main'; log('⚠️ Core.tab unavailable — this tab acts as main (' + e.message + ')', 'warn'); Kernel.becameMain(); }
    // NB: Core.tab.join() already fires onMain/onIdle for the role it settles on; calling becameMain() again here ran the
    // main-tab setup twice.
  }
  return { join, isMain, role: () => role, takeOver: () => Core.tab.takeOver(ID) };
})();

/* ---- auth guard: a login / maintenance page is a STOP signal, never "the boss is dead" --------------------------- */
const Guard = (() => {
  let faulted = '', resumeIntent = false, busy = false, lastInfo = '';
  const BLOCK_RE = /just a moment|challenges\.cloudflare\.com|checking your browser|under maintenance|be right back/i;
  const CHROME_RE = /gtb-inner|id\s*=\s*["']stamina_span["']/i;
  // 'blocked' when the page looks like a challenge / maintenance page AND has none of the game's own top bar
  function detectBlocked(x) {
    if (x == null) return '';
    if (typeof x === 'string') return BLOCK_RE.test(x.slice(0, 4000)) && !CHROME_RE.test(x) ? 'blocked' : '';
    if (!x.querySelector) return '';
    const text = (x.title || '') + ' ' + ((x.body && x.body.textContent) || '').slice(0, 600);
    return BLOCK_RE.test(text) && !x.querySelector('.gtb-inner') && !x.getElementById('stamina_span') ? 'blocked' : '';
  }
  try { if (Core.auth && Core.auth.addDetector) Core.auth.addDetector(detectBlocked); } catch (_) { /* older Core */ }
  // 'ok' | 'signedout' | <blocked state>
  function pageState(docOrText) {
    try {
      if (Core.auth && Core.auth.pageState) { const s = Core.auth.pageState(docOrText); if (s && s !== 'ok') return s; }
    } catch (_) { /* fall through to local checks */ }
    const b = detectBlocked(docOrText); if (b) return b;
    const doc = typeof docOrText === 'string' ? null : docOrText;
    if (doc && doc.querySelector && doc.querySelector('#login-container')) return 'signedout';
    if (typeof docOrText === 'string' && /id\s*=\s*["']login-container["']/i.test(docOrText)) return 'signedout';
    return 'ok';
  }
  const chromeOk = (doc) => !!(doc && doc.querySelector && (doc.querySelector('.gtb-inner') || doc.getElementById('stamina_span')));
  function fault(kind, where) {
    if (faulted === kind) return;
    faulted = kind; lastInfo = kind + (where ? ' @ ' + where : '');
    log(`🔒 ${kind === 'signedout' ? 'signed out' : 'site unavailable (' + kind + ')'} (${where || 'page'}) — stopping`, 'warn');
    Diag.skip('auth-' + kind, where || '');
    handle(kind).catch((e) => log('❌ auth handling: ' + e.message, 'err'));
  }
  async function handle(kind) {
    if (busy) return; busy = true;
    try {
      resumeIntent = Run.wanted();
      Run.pause('auth');
      if (kind === 'signedout' && Core.auth) {
        const st = Core.auth.status ? Core.auth.status() : {};
        if (!st.configured) { log('⚠️ re-login is UNCONFIGURED — add a login source (Account Switcher) or sign in by hand; the Automator stays stopped', 'warn'); lastInfo = 'unconfigured'; return; }
        const ok = await Core.auth.ensure();
        if (ok) { clear(); log('🔓 signed back in — resuming', 'ok'); if (resumeIntent) Run.resume('auth'); }
        else log('❌ automatic re-login failed (' + ((Core.auth.status() || {}).lastError || 'unknown') + ') — staying stopped', 'err');
        return;
      }
      // maintenance / challenge page: wait for the site, never sign in against it
      for (let i = 0; i < 120 && faulted; i++) {
        await sleep(30000);
        let up = false; try { up = Core.auth ? await Core.auth.check({ force: true }) : true; } catch (_) { up = false; }
        if (up) { clear(); log('🔓 site is back — resuming', 'ok'); if (resumeIntent) Run.resume('auth'); return; }
      }
    } finally { busy = false; }
  }
  function clear() { faulted = ''; lastInfo = ''; }
  // a validated, signed-in page: lets a manual login (or another tab's) lift the fault
  function ok() { if (faulted) { clear(); if (resumeIntent) Run.resume('auth'); } }
  const info = () => ({ faulted, lastInfo, status: Core.auth && Core.auth.status ? Core.auth.status() : null });
  if (Core.on) {
    Core.on('auth:signedin', () => { if (faulted) { clear(); log('🔓 signed in — resuming', 'ok'); if (resumeIntent) Run.resume('auth'); } });
    Core.on('auth:signedout', () => { if (!faulted && Run.wanted()) fault('signedout', 'another tab'); });
    Core.on('auth:blocked', (d) => { if (!faulted && Run.wanted()) fault((d && d.state) || 'blocked', 'auth'); });
  }
  return { pageState, chromeOk, fault, ok, info, isFaulted: () => !!faulted };
})();

/* ---- UI hook (the real panel is PART 6 and installs itself with UI.hook; until then dirty() is a no-op) ------------ */
const UI = (() => { let fn = null; return { dirty(what) { if (fn) fn(what); }, hook(f) { fn = f; } }; })();
// What is being worked on right now, by key ('scan' = boss scan / graveyard / start-up): { label, done, total }. Shown in the Overview and Graveyard.
const Work = (() => {
  const m = new Map(), ping = () => UI.dirty('status');
  return { set(k, label, done, total, step) { m.set(k, { label, done: done || 0, total: total || 0, step: step || '' }); ping(k); }, clear(k) { if (m.delete(k)) ping(k); }, get: (k) => m.get(k) || null };
})();
const pctOf = (w) => (w && w.total > 0 ? Math.min(100, w.done / w.total * 100) : 0);

/* ---- run control: the user's intent (persisted, shared) + reasons the engine is paused ---------------------------- */
const Status = (() => {
  let local = 'STOPPED';
  function set(s) {
    if (s === local) return; local = s; UI.dirty('status');
    if (Tab.isMain()) stateStore.update((st) => { st.status = s; st.statusAt = Date.now(); });
    try { Core.emit('automator:state', { state: s, run: Run.wanted() }); } catch (_) { /* */ }
  }
  const get = () => (Tab.isMain() ? local : (stateStore.get() || {}).status || 'FOLLOWER');
  return { set, get };
})();

/* What the build switch is doing right now: Status SWITCHING + Work 'build' = { title, step label, done of total }, so the footer and the Overview
 * show "Switching build for X · Crystals · step 3 of 3" with a bar. start() with no steps shows nothing (everything was already on). */
const Prog = (() => {
  let steps = [], title = '', prev = '', mine = 'SWITCHING';
  const show = (i) => Work.set('build', title, i, steps.length, steps[i] || '');
  return {
    start(t, list, status) { if (!list || !list.length) { steps = []; return; } steps = list.slice(); title = t; mine = status || 'SWITCHING'; prev = Status.get(); Status.set(mine); show(0); },
    at(label) { if (!steps.length) return; const i = steps.indexOf(label); if (i >= 0) show(i); },
    // swaps one step for the finer steps it is made of (each crystal / sigil move); go(i) shows one of them. sub() returns the index of the first, or -1
    sub(label, list) { if (!steps.length || !list || !list.length) return -1; const i = steps.indexOf(label); if (i < 0) return -1; steps.splice(i, 1, ...list); show(i); return i; },
    go(i) { if (steps.length && i >= 0 && i < steps.length) show(i); },
    note(label, text) { const i = steps.indexOf(label); if (i < 0) return; steps[i] = text; show(i); },        // a step keeps its place but says more about what it is doing
    end() { if (!steps.length) return; steps = []; Work.clear('build'); if (Status.get() === mine) Status.set(prev && prev !== mine ? prev : (Run.wanted() ? 'RUNNING' : 'STOPPED')); },
  };
})();

const Run = (() => {
  let wanted = !!(stateStore.get() || {}).run;
  const pausedBy = new Set();
  const persist = (v) => { wanted = v; stateStore.update((s) => { s.run = v; }); };
  function start() {
    if (wanted && !pausedBy.size) return;
    if (!cfg.targets.length) { log('⚠️ no bosses selected — tick at least one in Bosses', 'warn'); return; }
    pausedBy.clear(); persist(true); Kernel.engineStart(true); log('🚀 started', 'ok'); UI.dirty();
  }
  function stop(reason) {
    persist(false); pausedBy.clear(); Engine.halt(); Kernel.engineStop();
    log('🛑 ' + (reason || 'stopped'), 'info'); Status.set('STOPPED'); UI.dirty();
    if (Tab.isMain()) AF.resumeIfWePaused('stopped').catch(() => {});
    if (Tab.isMain() && Presets.origin.get()) Presets.restore('the run stopped').catch(() => {});
  }
  function pause(why) { pausedBy.add(why); Engine.halt(); Status.set('PAUSED'); UI.dirty(); }
  function resume(why) { pausedBy.delete(why); if (wanted && !pausedBy.size) Kernel.engineStart(true); UI.dirty(); }
  // other tabs start / stop the run through the shared state
  stateStore.watch((s) => {
    if (!s) return;
    const w = !!s.run;
    if (w === wanted) return;
    wanted = w;
    if (w) Kernel.engineStart(true); else { pausedBy.clear(); Engine.halt(); Kernel.engineStop(); }
    UI.dirty();
  });
  return {
    wanted: () => wanted,
    paused: () => pausedBy.size > 0, pausedBy: () => [...pausedBy],
    active: () => wanted && pausedBy.size === 0 && Tab.isMain(),
    start, stop, pause, resume,
  };
})();

/* ---- part registry + scheduler ---------------------------------------------------------------------------------- */
// A part is { id, name, icon, every?: ms | () => ms, tick?: async (ctx) => {}, panel?: (el) => {}, onMain?, onIdle? }.
// Parts that declare `every` + `tick` are run by the kernel in the MAIN tab only, one at a time, when cfg.parts[id] is on.
// The boss engine itself is a long loop owned by PART 1 (Kernel.engineStart); a new automation part only needs register().
const Kernel = (() => {
  const parts = new Map(), lastRun = new Map(); let hb = 0, busy = new Set();
  const enabled = (p) => cfg.parts[p.id] !== false;
  function register(p) { parts.set(p.id, p); if (cfg.parts[p.id] === undefined) cfg.parts[p.id] = true; UI.dirty(); return p; }
  const isOn = (id) => cfg.parts[id] !== false;
  async function beat() {
    if (!Tab.isMain()) return;
    const now = Date.now();
    for (const p of parts.values()) {
      if (!p.tick || !p.every || !enabled(p) || busy.has(p.id)) continue;
      if (Guard.isFaulted()) continue;
      const ev = typeof p.every === 'function' ? p.every() : p.every; if (!(ev > 0)) continue;
      if (now - (lastRun.get(p.id) || 0) < ev) continue;                 // measured from the last run, read live: a changed interval takes effect at once (a stored "next time" kept the old one)
      busy.add(p.id); lastRun.set(p.id, now);
      Promise.resolve().then(() => p.tick({ cfg })).catch((e) => log(`⚠️ ${p.name || p.id}: ${e.message}`, 'warn')).finally(() => busy.delete(p.id));
    }
  }
  function startBeat() { if (!hb) hb = setInterval(() => beat().catch(() => {}), 1000); }
  function stopBeat() { if (hb) { clearInterval(hb); hb = 0; } }
  function keepAlive(on) {
    try { if (on) Core.keepAlive.start(); else Core.keepAlive.stop(); } catch (_) { /* older Core */ }
  }
  function engineStart(force) { if (!Tab.isMain()) return; keepAlive(true); Engine.start(force); }
  function engineStop() { keepAlive(false); }
  function becameMain() {
    Board.load();                      // shared state is reloaded whenever leadership changes (3.0.0 never did)
    startBeat(); AF.recover();
    for (const p of parts.values()) { try { p.onMain && p.onMain(); } catch (_) { /* */ } }
    if (Run.wanted()) engineStart(true);
    Status.set(Run.wanted() ? 'RUNNING' : 'STOPPED');
  }
  function becameIdle() {
    Engine.halt(); stopBeat(); keepAlive(false);
    for (const p of parts.values()) { try { p.onIdle && p.onIdle(); } catch (_) { /* */ } }
  }
  return { register, parts, engineStart, engineStop, becameMain, becameIdle, enabled, isOn };
})();

/* ===================================================================================================================
 * PART 1 — BOSSES (wave bosses + the engine every part plugs targets into)
 * ================================================================================================================ */

/* ---- roster: boss table (3.0.0's, minus the cube's Polyhedral Apex), domain pairs, phase groups ------------------ */
const Roster = (() => {
  const list = [], byLow = new Map(), groups = new Map();
  const NAME_STOP = new Set(['the', 'of', 'a', 'an', 'and', '&']);
  const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w && !NAME_STOP.has(w));
  function namesMatch(a, b) {
    const wa = words(a), wb = words(b); if (!wa.length || !wb.length) return false;
    const sb = new Set(wb), overlap = wa.filter((w) => sb.has(w)).length;
    return overlap >= Math.max(1, Math.ceil(Math.min(wa.length, wb.length) * 0.6));
  }
  const shortName = (s) => String(s || '').split(/[,:\-–—]/)[0].trim().toLowerCase();
  function looksLikePhase2Of(def, scraped) {
    const a = shortName(def && def.name), b = shortName(scraped); if (!a || !b) return false;
    return a === b || a.includes(b) || b.includes(a);
  }
  function add(def) {
    const low = def.name.toLowerCase(); if (byLow.has(low)) return byLow.get(low);
    def.low = low; def.kind = def.kind || 'wave'; list.push(def); byLow.set(low, def); return def;
  }
  const get = (low) => byLow.get(String(low || '').toLowerCase());
  const members = (def) => (def && def.group ? groups.get(def.group) || [def] : [def]);
  const canon = (def) => (def && def.group ? (groups.get(def.group) || [def])[0] : def);
  const groupOf = (def) => members(def).map((b) => b.name);
  // phase 2 of a boss: same group, same place, new name
  function addPhase(parent, name, capOverride) {
    const low = name.toLowerCase(); if (byLow.has(low)) return byLow.get(low);
    const gid = parent.group || ('auto-' + parent.low);
    if (!parent.group) { parent.group = gid; groups.set(gid, [parent]); }
    const p2 = Object.assign({}, canon(parent), { name, low, group: gid }); if (capOverride != null) p2.defaultCap = capOverride;
    list.push(p2); byLow.set(low, p2); groups.get(gid).push(p2);
    // a phase inherits its sibling's "enabled" tick, or the loop would never pick it up
    if (members(parent).some((m) => cfg.targets.includes(m.low)) && !cfg.targets.includes(low)) { cfg.targets.push(low); saveCfg(); }
    return p2;
  }
  function remove(low) {                                             // only for entries the loot scan added (the built-in list is never edited)
    const d = byLow.get(String(low || '').toLowerCase()); if (!d) return false;
    const g = d.group && groups.get(d.group); if (g) { const k = g.indexOf(d); if (k >= 0) g.splice(k, 1); }
    const k = list.indexOf(d); if (k >= 0) list.splice(k, 1);
    byLow.delete(d.low); return true;
  }
  return { list, add, get, remove, members, canon, groupOf, addPhase, namesMatch, looksLikePhase2Of };
})();

(function seedWaveRoster() {
  const W = [
    { name: 'General Skarn the Radiant Bastion', defaultCap: 3e9, gate: 3, wave: 8 },
    { name: 'General Vessir the Sunfang Duelist', defaultCap: 3e9, gate: 3, wave: 8 },
    { name: 'General Hrazz the Dawnflame Oathkeeper', defaultCap: 3e9, gate: 3, wave: 8 },
    { name: 'Drakzareth The Tyrant Lizard King', defaultCap: 3e9, gate: 3, wave: 8 },
    { name: 'Oceanus The Water Titan', defaultCap: 3e9, gate: 5, wave: 9 },
    { name: 'Poseidon, The Sea Emperor', defaultCap: 0, gate: 5, wave: 9 },
  ];
  W.forEach((d) => Roster.add(d));
  // Each domain wave hosts a Herald (frequent, weaker) and a Sovereign (rare) on the SAME page.
  const PAIRS = [
    [10, ['Pan, Wild Herald of Hermes', 1e8], ['Hermes, Divine Herald of the Endless Road', 1e8]],
    [11, ['Orion, Eternal Hunter of Artemis', 1e9], ['Artemis, Divine Huntress of the Moonlit Wilds', 1e9]],
    [12, ['Triton, Herald of the Deep Crown', 1e9], ['Poseidon, Sovereign of the Drowned Steps', 3e9]],
    [13, ['Deimos, Herald of Panic', 1e9], ['Ares, Sovereign of the Red Bastion', 3e9]],
    [14, ['Asclepius, Herald of Golden Mercy', 1e9], ['Apollo, Sovereign of the Sun Basilica', 3e9]],
    [15, ['Nike, Herald of Unbroken Victory', 1e9], ['Athena, Sovereign of the Ivory War Library', 3e9]],
    [16, ['Nemesis, Herald of Reckoning', 1e9], ['Hera, Sovereign of the Crown Court', 3e9]],
    [17, ['Aeolus, Herald of Bound Winds', 1e9], ['Zeus, Sovereign of the Storm Throne', 3e9]],
  ];
  PAIRS.forEach(([wave, h, s]) => { Roster.add({ name: h[0], defaultCap: h[1], gate: 5, wave }); Roster.add({ name: s[0], defaultCap: s[1], gate: 5, wave }); });
  // Known evolved (phase 2) names. Anything not listed is auto-detected on the page (same gate/wave + same short name).
  const P2 = {
    'artemis, divine huntress of the moonlit wilds': 'artemis, lunar duelist of the sacred hunt',
    'hermes, divine herald of the endless road': 'hermes, fleet duelist of the crossroads',
    'apollo, sovereign of the sun basilica': 'apollo, duelist of the sun court',
    'ares, sovereign of the red bastion': 'ares, duelist of the blood oath',
    'poseidon, sovereign of the drowned steps': 'poseidon, duelist of the crushing tide',
    'zeus, sovereign of the storm throne': 'zeus, duelist of the storm throne',
    'hera, sovereign of the crown court': 'hera, duelist of the crown court',
    'athena, sovereign of the ivory war library': 'athena, duelist of the ivory war library',
  };
  Object.entries(P2).forEach(([p1, p2]) => { const parent = Roster.get(p1); if (parent) Roster.addPhase(parent, p2); });
})();

const bossName = (low) => { const d = Roster.get(low); return (d && d.name) || low; };
/* The cap a boss starts from: your own number, else (skip stays skip) its highest loot DMG req from the loot scan, else the roster default. */
function baseCapOf(low) {
  const def = Roster.get(low), o = cfg.bosses[low] || {};
  if (o.cap != null) return o.cap;
  if (def && def.defaultCap === 0) return 0;                         // a boss the roster skips on purpose stays skipped
  const top = LootData.top(low); if (top != null) return top;
  return def && def.defaultCap != null ? def.defaultCap : cfg.defaultBossCap;
}
// Which timed-cap row is in force for this boss right now, read the way a person would read the list: the latest change whose time has already come today
// (server time); before the day's first change it is the default. One exception, for a dungeon that carries on past midnight: with no change yet today, the
// cap it was last on (Board.capHeld) stays until a NEW dungeon (a different dungeon id) clears it (see refreshBoss). Nothing here remembers when anything opened.
function capNow(low) {
  const def = Roster.get(low), o = cfg.bosses[low] || {}, base = baseCapOf(low);
  if (def && def.kind !== 'wave' && Array.isArray(o.schedule) && o.schedule.length) {   // dungeon bosses only
    const mins = serverMinutes();
    if (mins != null) {
      const e = Board.get(low); let best = null;
      for (const b of o.schedule) { const [hr, mi] = String(b.at).split(':').map(Number), t = hr * 60 + (mi || 0); if (mins >= t && (!best || t >= best.t) && Number.isFinite(b.cap)) best = { t, cap: b.cap, row: b }; }
      if (best) {
        if (e && (!e.capHeld || e.capHeld.at !== best.row.at)) Board.patch(low, { capHeld: { at: best.row.at } });   // remember which row we are on (only changes a few times a day)
        return { cap: best.cap, row: best.row };
      }
      const held = e && e.capHeld && o.schedule.find((b) => b.at === e.capHeld.at && Number.isFinite(b.cap));
      if (held) return { cap: held.cap, row: held };
    }
  }
  return { cap: base, row: null };
}
function bossCap(low) { return capNow(low).cap; }
function bossLoc(low) {
  const def = Roster.get(low), o = cfg.bosses[low] || {};
  const gate = o.gate != null ? o.gate : def && def.gate, wave = o.wave != null ? o.wave : def && def.wave;
  return gate && wave ? { gate, wave } : null;
}

/* ---- where a wave sits in the world. The Bosses tab groups by this, and the loot export uses the same names.
 *      Gate 5 wave 9 is the Ocean wave (Oceanus + the Sea Emperor); the Olympus waves 10-17 are named by their god, so the
 *      Poseidon of wave 12 (Olympus) is not the Poseidon of wave 9 (Ocean). A wave nobody named yet lands in "More waves". ---- */
const WaveMap = (() => {
  const GROUPS = {
    generals: { id: 'generals', title: 'Generals', sub: 'Gate 3', ico: '⚔️', order: 1 },
    ocean:    { id: 'ocean',    title: 'Ocean',    sub: 'Gate 5', ico: '🌊', order: 2 },
    olympus:  { id: 'olympus',  title: 'Olympus',  sub: 'Gate 5', ico: '🏛️', order: 3 },
    other:    { id: 'other',    title: 'More waves', sub: 'found by the loot scan', ico: '🗺️', order: 4 },
  };
  const WAVES = {
    '3/8': ['generals', 'Generals'], '5/9': ['ocean', 'Oceanus'],
    '5/10': ['olympus', 'Hermes'], '5/11': ['olympus', 'Artemis'], '5/12': ['olympus', 'Poseidon'], '5/13': ['olympus', 'Ares'],
    '5/14': ['olympus', 'Apollo'], '5/15': ['olympus', 'Athena'], '5/16': ['olympus', 'Hera'], '5/17': ['olympus', 'Zeus'],
  };
  function of(gate, wave) {
    const k = `${gate}/${wave}`, hit = WAVES[k];
    if (hit) return { key: k, group: GROUPS[hit[0]], label: hit[1] };
    return { key: k, group: GROUPS.other, label: gate ? `Gate ${gate}` : '' };
  }
  return { of, groups: GROUPS };
})();

/* ---- loot data: written by the loot scan (PART 4b) into one store. Every loot DMG req is a cap choice, the highest is the default cap ---- */
/* Divine shield: the Olympus gods (+ Poseidon the Sea Emperor) cut your damage to 50%; each of THEIR relics you hold adds 5% (10 = full). Counts: Materials list of /inventory.php, refreshed every 30 min. Informational only. */
const Relics = (() => {
  const TTL = 30 * 60 * 1000, warned = new Map(), store = Core.store(ID + '-relics', { def: { at: 0, n: {} } }), load = () => Object.assign({ at: 0, n: {} }, store.get());
  const MAP = { 'hermes, divine herald of the endless road': 'Swiftbreaker', 'artemis, divine huntress of the moonlit wilds': 'Moonbreaker', 'poseidon, sovereign of the drowned steps': 'Deepbreaker', 'ares, sovereign of the red bastion': 'Warbreaker',
    'apollo, sovereign of the sun basilica': 'Sunbreaker', 'athena, sovereign of the ivory war library': 'Aegisbreaker', 'hera, sovereign of the crown court': 'Crownbreaker', 'zeus, sovereign of the storm throne': 'Stormbreaker', 'poseidon, the sea emperor': 'Tidebreaker' };
  let data = load(), busy = false;
  function info(low) {                                               // null = no divine shield
    const d = Roster.get(low), c = d && Roster.canon(d), relic = MAP[c ? c.low : String(low).toLowerCase()]; if (!relic) return null;
    const have = data.at ? data.n[relic.toLowerCase() + ' relic'] || 0 : null;
    return { relic: relic + ' Relic', have, pct: have == null ? null : 50 + 5 * Math.min(10, have), short: have != null && have < 10 };
  }
  async function refresh() {
    const s = load(); if (s.at > data.at) data = s; if (busy || Date.now() - data.at < TTL) return; busy = true;
    try {
      const doc = parseHtml(await Core.net.fetchText('/inventory.php', { ttl: 30000, key: 'ma:inv-relics' })), n = {};
      if (Guard.pageState(doc) !== 'ok' || !doc.querySelector('.slot-box')) return;   // not the inventory: keep the last counts
      Object.values(MAP).forEach((r) => { n[r.toLowerCase() + ' relic'] = 0; }); doc.querySelectorAll('.slot-box').forEach((b) => { const k = String(((b.querySelector('.info-btn') || { dataset: {} }).dataset.name) || '').trim().toLowerCase(), m = /\bx\s*(\d[\d,]*)/i.exec(b.textContent || ''); if (k in n && m) n[k] = parseInt(m[1].replace(/,/g, ''), 10) || 0; });
      data = { at: Date.now(), n }; store.set(data); UI.dirty('relics');
    } catch (_) { /* keep the last counts */ } finally { busy = false; }
  }
  function warn(t) { const i = info(t.low); if (!i || !i.short || Date.now() - (warned.get(i.relic) || 0) < TTL) return;
    warned.set(i.relic, Date.now()); log(`✨ ${esc(t.name)}: ${i.have}/10 ${esc(i.relic)} — only ${i.pct}% of your damage gets through`, 'warn');
  }
  return { info, refresh, warn };
})();

const lootStore = Core.store(ID + '-loot', { def: { v: 1, at: 0, bosses: {} } });
const LootData = (() => {
  const norm = (v) => (v && typeof v === 'object' && v.bosses && typeof v.bosses === 'object' ? v : { v: 1, at: 0, bosses: {} });
  let d = norm(lootStore.get());
  const get = (low) => d.bosses[String(low || '').toLowerCase()] || null;
  // a dungeon boss's later phases drop the same loot as its first phase: they read the first phase's record
  const src = (low) => { const f = Roster.get(low); return f && f.kind !== 'wave' && Roster.canon(f) !== f ? get(Roster.canon(f).low) || get(low) : get(low); };
  // the game's phase number of a boss form: wave bosses have a PvP duel that counts as a phase (our phase 2 = game phase 3). Dungeon bosses have no phase-only loot: old behaviour
  const ownPhase = (low) => { const d = Roster.get(low), i = d ? Roster.members(d).indexOf(d) : 0; return i < 1 || !d || d.kind !== 'wave' ? 1 : i + 2; };
  // [{ req, items:[names], ph:[phase-only names], gp }], lowest requirement first. locked=true: loot of a LATER phase (shown on this form, but only that phase's own damage unlocks it)
  function tiers(low, locked) {
    const e = src(low), m = new Map(), own = ownPhase(low), wave = (Roster.get(low) || {}).kind === 'wave';
    ((e && e.loot) || []).forEach((it) => {
      if (!(Number.isFinite(it.dmgReq) && it.dmgReq > 0) || !it.name || (wave && it.gp > own) !== !!locked) return;
      const t = m.get(it.dmgReq) || { req: it.dmgReq, items: [], ph: [], gp: it.gp }; if (!t.items.includes(it.name)) t.items.push(it.name); if (wave && it.gp && !t.ph.includes(it.name)) t.ph.push(it.name); m.set(it.dmgReq, t);
    });
    return [...m.values()].sort((x, y) => x.req - y.req);
  }
  const top = (low) => { const t = tiers(low); return t.length ? t[t.length - 1].req : null; };
  let iconMap = null, iconFor = null;                                // item name -> picture, from whichever boss's scan had one (the same item looks the same everywhere)
  const icon = (name) => {
    if (iconFor !== d) { iconFor = d; iconMap = new Map(); Object.values(d.bosses).forEach((b) => ((b && b.loot) || []).forEach((it) => { if (it && it.icon && it.name && !iconMap.has(it.name)) iconMap.set(it.name, it.icon); })); }
    return iconMap.get(name) || null;
  };
  // bosses the roster does not know yet: a wave boss joins its wave (a second phase of a known boss there becomes that boss's next phase);
  // a Castle boss is only added when the scan saw where it stands
  function apply() {
    let added = 0;
    for (const [low, e] of Object.entries(d.bosses)) {
      if (!e || !e.name || Roster.get(low) || cfg.ignored.includes(low)) continue;
      const cap = top(low);
      if (e.kind === 'wave' && e.isBoss && e.gate > 0 && e.wave > 0) {                                  // (a wave monster the scan did not mark as a boss is never added)
        const sib = /duelist/i.test(e.name) && !/\b(herald|sovereign)\b/i.test(e.name) && Roster.list.find((x) => x.kind === 'wave' && x.gate === e.gate && x.wave === e.wave && Roster.canon(x) === x && Roster.looksLikePhase2Of(x, e.name));   // (phase 2 names are the "... Duelist ..." ones; two bosses that merely share a first name stay separate)
        if (sib) Roster.addPhase(sib, e.name); else Roster.add({ name: e.name, defaultCap: cap != null ? cap : cfg.defaultBossCap, gate: e.gate, wave: e.wave, fromScan: true });
        added++;
      } else if (e.kind === 'dungeon' && e.boss && e.locationId > 0 && e.dtype === 'hard') {
        Roster.add({ name: e.name, defaultCap: cap != null ? cap : 2e9, kind: 'dungeon', locationId: e.locationId, dtype: 'hard', fromScan: true }); added++;
      }
    }
    return added;
  }
  // a saved record is a boss when the roster knows it (or the Gribble swarm), the scan marked it (isBoss / a dungeon boss pin)
  const isBossRecord = (low, e) => !!(e && (e.isBoss || e.boss || Roster.get(low) || Roster.list.some((r) => r.swarmMatch && r.swarmMatch.test(e.name || low))));
  // older scans saved every monster on the page: take the regular mobs back out (returns their names)
  function purge() {
    const keepB = {}, gone = [];
    Object.entries(d.bosses).forEach(([low, e]) => { if (isBossRecord(low, e)) keepB[low] = e; else gone.push(low); });
    if (gone.length) { d = Object.assign({}, d, { bosses: keepB }); lootStore.set(d); }
    return gone;
  }
  // remove a monster for good: out of the saved scan data, and onto the list the scan skips
  function dismiss(low) {
    low = String(low || '').toLowerCase();
    if (!cfg.ignored.includes(low)) cfg.ignored.push(low);
    if (d.bosses[low]) { const b = Object.assign({}, d.bosses); delete b[low]; d = Object.assign({}, d, { bosses: b }); lootStore.set(d); }
    saveCfg();
  }
  lootStore.watch((v) => { d = norm(v); const n = apply(); if (n) log(`🆕 loot scan added ${n} boss${n === 1 ? '' : 'es'} to the Bosses tab`, 'info'); UI.dirty(); });
  return { get, src, tiers, top, ownPhase, icon, apply, purge, dismiss, isBossRecord, all: () => d.bosses, at: () => d.at || 0 };
})();

/* ---- board: what we KNOW about each boss right now. Only a validated page / confirmed reply may change it. -------- */
const boardStore = Core.store(ID + '-board', { def: {} });
const Board = (() => {
  let b = {}, saveT = 0, dirty = false;
  const get = (low) => b[low];
  function load() { const s = boardStore.get(); b = s && typeof s === 'object' ? s : {}; }
  function save() { saveT = 0; if (!dirty) return; dirty = false; if (Tab.isMain()) boardStore.set(b); }
  function touch() { dirty = true; if (!saveT) saveT = setTimeout(save, 2000); UI.dirty('status'); }
  function put(low, obj) { b[low] = obj; touch(); return obj; }
  function patch(low, p) { b[low] = Object.assign({}, b[low] || {}, p); touch(); return b[low]; }
  // damage we have confirmed on this exact monster life (monster ids are unique per life: no carry-over)
  const dealt = (t) => { const e = b[t.low]; if (!e) return t.userDmg || 0; if (t.kind === 'dungeon-swarm' || (e.swarm && t.monsterId)) { const s = (e.swarm || []).find((x) => String(x.monsterId) === String(t.monsterId) && String(x.instanceId) === String(t.instanceId)); return Math.max(t.userDmg || 0, s ? s.userDmg || 0 : 0); } return String(e.monsterId) === String(t.monsterId) ? Math.max(t.userDmg || 0, e.userDmg || 0) : (t.userDmg || 0); };
  function confirm(t, total) {
    if (!(total > 0)) return;
    const e = b[t.low]; if (!e) return;
    if (e.swarm) { const s = e.swarm.find((x) => String(x.monsterId) === String(t.monsterId) && String(x.instanceId) === String(t.instanceId)); if (s && total > (s.userDmg || 0)) { s.userDmg = total; touch(); } return; }
    if (String(e.monsterId) === String(t.monsterId) && total > (e.userDmg || 0)) { e.userDmg = total; touch(); }
  }
  // a later phase's loot counts only damage dealt IN that phase: base = damage dealt before it (read once per monster life, see phaseBase)
  const base = (low) => { const e = b[low]; return e && e.phBaseFor != null && e.phBaseFor === String(e.monsterId) ? e.phBase || 0 : 0; };
  const baseKnown = (low) => { const d = Roster.get(low), e = b[low]; return !d || d.kind !== 'wave' || Roster.members(d).indexOf(d) < 1 || !!(e && e.phBaseFor != null && e.phBaseFor === String(e.monsterId)); };
  load();
  window.addEventListener('beforeunload', () => { dirty = true; save(); });
  boardStore.watch((v) => { if (v && !Tab.isMain()) { b = v; UI.dirty('status'); } });
  // a gribble (swarm mob) died or was capped by the server: forget just that one
  function dropSwarm(t) { const e = b[t.low]; if (!e || !e.swarm) return; e.swarm = e.swarm.filter((x) => !(String(x.monsterId) === String(t.monsterId) && String(x.instanceId) === String(t.instanceId))); if (!e.swarm.length) e.alive = false; touch(); }
  return { get, load, put, patch, dealt, base, baseKnown, confirm, dropSwarm, all: () => b, save };
})();

/* ---- targets: everything the engine may attack right now, in priority order (first tick = first priority) --------- */
function candidates() {
  const out = [], now = Date.now();
  for (const low of cfg.targets) {
    const def = Roster.get(low), e = Board.get(low); if (!def || !e || e.alive !== true) continue;
    if (def.kind !== 'wave' && !Kernel.isOn('dungeons')) continue;      // the Dungeons part is switched off: wave bosses only
    if (def.kind === 'wave' && !Kernel.isOn('bosses')) continue;         // the Wave bosses part is switched off
    const cap = bossCap(low); if (cap <= 0) continue;
    const capT = cap + Board.base(low);
    if (e.pausedUntil && e.pausedUntil > now) continue;
    if (def.kind === 'dungeon-swarm') {
      for (const s of e.swarm || []) { if ((s.userDmg || 0) < cap) out.push({ low, name: def.name, kind: 'dungeon', monsterId: s.monsterId, instanceId: s.instanceId, locationId: s.locationId, userDmg: s.userDmg || 0, cap, swarm: true }); }
      continue;
    }
    if (!e.monsterId) continue;
    if (Board.baseKnown(low) && (e.userDmg || 0) >= capT) continue;
    if (e.needsDuel && e.duelRetryAt && e.duelRetryAt > now) continue;
    out.push({ low, name: e.name || def.name, kind: def.kind === 'wave' ? 'wave' : 'dungeon', monsterId: e.monsterId, instanceId: e.instanceId, locationId: e.locationId, userDmg: e.userDmg || 0, cap: capT });
  }
  return out;
}
const targetKey = (t) => `${t.kind}:${t.instanceId || ''}:${t.monsterId}`;

/* ---- slots the other parts fill in. Each has a harmless stub, so deleting PART 2 / 3 / 4 never breaks the wave bosses ---- */
const Dungeons = { nextCheck: () => Infinity, refresh: async () => {}, sideMobs: null, corpses: null };   // PART 2 fills this
const Duels = { fight: null, bootPage: () => {} };                                                         // PART 3 fills this
const Loot = { onStamStall: async () => {} };                                                              // PART 4 fills this
const LootScan = { available: false, state: { running: false, stop: false, label: '', done: 0, total: 0, read: 0, added: 0, notes: [], error: '', startedAt: 0, endedAt: 0 }, run: async () => {}, stop() {}, download() {}, text: () => '', learn() {} };   // PART 4b fills this

/* ---- skills, tiers, damage profile (3.0.0 algorithm kept; profile keyed per boss NAME so it can't grow forever) ---- */
const SKILLS = {
  HEROIC: { id: -2, cost: 50, label: 'Heroic Slash' }, ULTIMATE: { id: -3, cost: 100, label: 'Ultimate Slash' },
  LEGENDARY: { id: -4, cost: 200, label: 'Legendary Slash' }, WORLD_BREAKER: { id: -5, cost: 1000, label: 'World Breaker' },
  POWER: { id: -1, cost: 10, label: 'Power Slash' }, SLASH: { id: 0, cost: 1, label: 'Slash' },
};
const TIER_CHAIN = ['WORLD_BREAKER', 'LEGENDARY', 'ULTIMATE', 'HEROIC', 'POWER', 'SLASH'];
const FALLBACK_DMG = { WORLD_BREAKER: 1_200_000, LEGENDARY: 450_000, ULTIMATE: 180_000, HEROIC: 55_000 };
const CLASS_SKILLS = { cleric: { id: 9, cost: 30, label: 'Judgment Seal' }, hunter: { id: 7, cost: 20, label: 'Killer Instinct' }, warrior: { id: 3, cost: 20, label: "Warrior's Aura" }, mage: { id: 5, cost: 30, label: 'Arcane Sacrifice' } };
const profStore = Core.store(ID + '-profile', { def: {} });
const DmgProfile = (() => {
  const map = profStore.get() || {};
  const median = (a) => { if (!a || !a.length) return null; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const globalMedian = () => { const all = []; Object.values(map).forEach((a) => all.push(...a)); return median(all); };
  function record(low, tier, dmg) {
    const cost = SKILLS[tier] && SKILLS[tier].cost; if (!cost || !(dmg > 0)) return;
    const a = map[low] || (map[low] = []); a.push(dmg / cost); if (a.length > 30) a.shift();
    const keys = Object.keys(map); if (keys.length > 60) delete map[keys[0]];
    profStore.set(map);
  }
  const est = (low, tier) => { const r = median(map[low]) ?? globalMedian(); const c = SKILLS[tier].cost; return r != null ? r * c : (FALLBACK_DMG[tier] || c * 1100); };
  return { record, est, hasData: () => globalMedian() != null };
})();
function pickTier(low, remaining, maxTier, stam) {
  let idx = TIER_CHAIN.indexOf(maxTier); if (idx < 0) idx = 0;
  const floor = TIER_CHAIN.length - 1;
  if (!DmgProfile.hasData()) idx = floor;           // calibrate with the smallest tier first
  while (idx < floor) { const t = TIER_CHAIN[idx]; if (DmgProfile.est(low, t) <= remaining && SKILLS[t].cost <= stam) break; idx++; }
  return TIER_CHAIN[idx];
}
function classifyReject(msg) {
  const m = String(msg || '').toLowerCase();
  if (/you are dead|you have died|you died/.test(m)) return { reason: 'player-dead', backoffMs: 0 };
  if (m.includes('pvp duel phase')) return { reason: 'duel-phase' };
  if (/too quickly|slow down|cooldown/.test(m)) return { reason: 'cooldown', backoffMs: 1200 };
  if (m.includes('not enough stamina')) return { reason: 'stam' };
  if (/not enough mp|mana/.test(m)) return { reason: 'mp', backoffMs: 200 };
  if (/invalid monster|already dead|not found/.test(m)) return { reason: 'dead' };
  return { reason: 'unknown', backoffMs: 800 };
}

/* ---- wave scanning: a page only changes the board when it is VALID (signed in, site chrome present) --------------- */
const Scan = (() => {
  const warned = new Set();
  const cardAlive = (c) => {
    if (c.dataset.dead === '1') return false;
    if (c.dataset.unjoined === '1' || c.dataset.joined === '1' || c.dataset.userJoined === '1' || c.dataset.inbattle === '1') return true;
    return !!c.querySelector('[onclick*="deal_damage"], .attack-btn, a[href*="battle.php"]');
  };
  function cardId(c) {
    if (c.dataset.monsterId) return c.dataset.monsterId;
    const a = c.querySelector('a[href*="battle.php"]');
    if (a) { try { const u = new URL(a.getAttribute('href'), BASE); return u.searchParams.get('id') || u.searchParams.get('monster_id') || ''; } catch (_) { /* */ } }
    return '';
  }
  // returns true when the page was valid and the board was updated
  async function page(gate, wave) {
    let html;
    try { html = await Core.net.fetchText(`/active_wave.php?gate=${gate}&wave=${wave}`, { force: true, ttl: 0, key: `ma:wave:${gate}:${wave}`, via: (run) => Core.cookies.withMode('alive', run) }); }
    catch (e) { Diag.skip('wave-fetch-failed', `${gate}/${wave} ${e.message}`); return false; }
    const doc = parseHtml(html);
    const st = Guard.pageState(doc);
    if (st !== 'ok') { Guard.fault(st, `wave ${gate}/${wave}`); return false; }       // login/maintenance = STOP, never "dead"
    if (!Guard.chromeOk(doc)) { Diag.skip('wave-page-no-chrome', `${gate}/${wave}`); return false; }
    Guard.ok(); Me.readRes(doc);                          // the sidebar on this page has our HP / mana
    const now = Date.now(), seen = new Set(), tracked = new Set();
    for (const d of Roster.list) { const loc = bossLoc(d.low); if (loc && loc.gate === gate && loc.wave === wave) tracked.add(d.low); }
    doc.querySelectorAll('.monster-container .monster-card, .monster-card').forEach((card) => {
      if (!cardAlive(card)) return;
      const id = cardId(card); const raw = (card.dataset.name || (card.querySelector('.monster-name,.name,h2,h3') || {}).textContent || '').trim();
      if (!id || !raw) return;
      let low = raw.toLowerCase(), def = Roster.get(low);
      if (!def) {                                      // unknown name on a boss page: is it a phase of a tracked boss?
        for (const t of tracked) { const d = Roster.get(t); if (d && d.kind === 'wave' && Roster.looksLikePhase2Of(Roster.canon(d), raw)) { def = Roster.addPhase(Roster.canon(d), raw); log(`🆕 auto-detected phase for ${esc(d.name)}: ${esc(raw)}`, 'info'); break; } }
      }
      if (!def && card.dataset.boss === '1') LootScan.learn({ name: ((card.querySelector('.monster-name,.name,h2,h3') || {}).textContent || raw).trim(), kind: 'wave', gate, wave, id, bossish: true });   // a boss the roster does not know yet
      if (!def || seen.has(def.low)) return;
      low = def.low; seen.add(low);
      LootScan.learn({ name: def.name, kind: 'wave', gate, wave, id });
      const prev = Board.get(low), same = prev && String(prev.monsterId) === String(id);
      const img = card.querySelector('img');
      Board.put(low, Object.assign({}, same ? prev : {}, {
        low, name: raw, kind: 'wave', alive: true, monsterId: id, gate, wave, seenAt: now,
        userDmg: Math.max(parseNum(card.dataset.userdmg, 0), same ? prev.userDmg || 0 : 0),   // server total, or ours if it lags
        expire: parseNum(card.dataset.expire, 0), firstAliveAt: same ? prev.firstAliveAt : now,
        needsDuel: same ? prev.needsDuel : false, icon: img ? img.getAttribute('src') : undefined, nextTs: 0,
      }));
    });
    const widget = {}; doc.querySelectorAll('.auto-summon-card').forEach((c) => { const n = ((c.querySelector('.auto-summon-name') || {}).textContent || '').toLowerCase().trim(); if (n) widget[n] = parseNum(c.dataset.nextTs, 0); });
    for (const low of tracked) {
      if (seen.has(low)) continue;
      Board.put(low, { low, name: bossName(low), kind: 'wave', alive: false, seenAt: now, gate, wave, nextTs: widget[low] || 0 });
    }
    return true;
  }
  function nextCheck(low) {
    const def = Roster.get(low), now = Date.now(); if (!def || bossCap(low) <= 0) return Infinity;
    if (def.kind !== 'wave') return Dungeons.nextCheck(def);
    const e = Board.get(low); if (!e || !e.seenAt) return now;
    if (e.alive) return e.seenAt + cfg.fightScanMs;
    if (e.nextTs && e.nextTs * 1000 + 120000 > now) return Math.max(e.seenAt + 5000, Math.min(e.nextTs * 1000 - cfg.spawnLeadMs, e.seenAt + cfg.fightScanMs));
    return e.seenAt + cfg.fightScanMs;
  }
  const dueLows = (force) => cfg.targets.filter((l) => force || nextCheck(l) <= Date.now());
  const anyDue = () => dueLows(false).length > 0;
  const nextDueIn = () => { let m = Infinity; for (const l of cfg.targets) m = Math.min(m, nextCheck(l)); return Math.max(0, m - Date.now()); };
  async function scanNow(force) {
    const due = dueLows(force), pages = new Map(), dd = [], t0 = Date.now();
    for (const low of due) {
      const def = Roster.get(low); if (!def) continue;
      if (def.kind !== 'wave') { dd.push(low); continue; }
      const loc = bossLoc(low);
      if (!loc) { if (!warned.has(low)) { warned.add(low); log(`⚠️ ${esc(bossName(low))}: no gate/wave known — set it in Bosses`, 'warn'); } continue; }
      pages.set(`${loc.gate}/${loc.wave}`, loc);
    }
    const total = pages.size + dd.length; let n = 0;
    if (force && total) log(`🔎 scanning ${total} place${total === 1 ? '' : 's'} for your bosses…`, 'info');
    try {
      for (const loc of pages.values()) { if (!Run.active()) return; Work.set('scan', `Scanning Gate ${loc.gate} · Wave ${loc.wave}`, n++, total); await page(loc.gate, loc.wave); await sleep(150); }
      if (dd.length) await Dungeons.refresh(dd, (label) => Work.set('scan', label, n++, total));
    } finally { Work.clear('scan'); }
    if (force && total) { const up = due.filter((l) => (Board.get(l) || {}).alive === true).length; log(`🔎 scan done · ${up} of ${due.length} boss${due.length === 1 ? '' : 'es'} up · ${((Date.now() - t0) / 1000).toFixed(1)}s`, 'info'); }
  }
  const run = (force) => Lane.run(() => scanNow(force));
  // just this boss's own page (its wave page, or its dungeon): after a phase duel only that boss changed, not the other waves
  const one = (low) => Lane.run(async () => {
    const def = Roster.get(low); if (!def) return;
    try {
      if (def.kind !== 'wave') { Work.set('scan', `Checking ${bossName(low)}`, 0, 1); await Dungeons.refresh([low], () => {}); return; }
      const loc = bossLoc(low); if (!loc) return;
      Work.set('scan', `Checking Gate ${loc.gate} · Wave ${loc.wave}`, 0, 1); await page(loc.gate, loc.wave);
    } finally { Work.clear('scan'); }
  });
  return { page, run, one, anyDue, nextDueIn, nextCheck, cardAlive, cardId };
})();

/* ---- auto-farm coordination (crash-safe: the flag is written BEFORE pausing, and recovered on boot) --------------- */
const AF = (() => {
  const raw = (url, body) => fetch(url + (body ? '' : '?_=' + Date.now()), body ? { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' }, body } : { credentials: 'include' }).then((r) => r.json()).catch(() => null);
  const getEnabled = async () => { const j = await raw('/auto_farm_status.php'); return j && j.ok ? j.settings.IS_ENABLED === 1 : null; };
  const set = async (en) => { const j = await Act.run(() => raw('/auto_farm_actions.php', `action=toggle&enabled=${en ? 1 : 0}`)); return !!(j && j.ok); };
  const paused = () => !!(stateStore.get() || {}).afPaused;
  async function pauseIfNeeded() {
    if (!cfg.autoFarmControl || paused()) return;
    if ((await getEnabled()) === true) {
      stateStore.update((s) => { s.afPaused = Date.now(); });
      if (await set(false)) log('🛑 paused server Auto-Farm', 'info'); else stateStore.update((s) => { s.afPaused = 0; });
    }
  }
  async function resumeIfWePaused(why) {
    if (!paused()) return;
    if (await set(true)) { stateStore.update((s) => { s.afPaused = 0; }); log(`▶️ resumed server Auto-Farm${why ? ' (' + why + ')' : ''}`, 'info'); }
  }
  function recover() { if (paused() && !Run.wanted()) resumeIfWePaused('recovered after reload').catch(() => {}); }
  return { pauseIfNeeded, resumeIfWePaused, recover };
})();

/* ---- potions: Core.potions coordinates stamina / HP / any item across tabs and scripts ---------------------------- */
const Potions = (() => {
  const MP_PER = { S: 20, M: 40, L: 60, XL: 100 };
  const NAMES = { S: ['Mana Potion S', 'Mana Potion', 'Small Mana Potion'], M: ['Mana Potion M', 'Medium Mana Potion'], L: ['Mana Potion L', 'Large Mana Potion', 'Full Mana Potion'], XL: ['Mana Potion XL'] };
  let manaName = '', outUntil = 0, refilling = false, warnedAt = 0;
  const warn = (m) => { if (Date.now() - warnedAt > 30000) { warnedAt = Date.now(); log(m, 'warn'); } };
  async function resolveMana() {
    if (manaName) return manaName;
    for (const n of NAMES[cfg.mana.type] || NAMES.S) { const f = await Core.potions.find(n).catch(() => null); if (f) { manaName = n; return n; } }
    return '';
  }
  async function refillMana(why, minMp) {
    if (!cfg.mana.enabled || refilling || Date.now() < outUntil) return false;
    if (!Me.mpKnown) await Me.refresh(0);
    if (!Me.mpKnown) return false;
    let target = Math.max(cfg.mana.threshold + 1, minMp || 0); if (Me.maxMp > 0) target = Math.min(target, Me.maxMp);
    if (Me.mp >= target) return false;
    refilling = true;
    try {
      const name = await resolveMana();
      if (!name) { outUntil = Date.now() + 60000; warn('⚠️ no Mana Potion found in sidebar/inventory'); return false; }
      const need = Math.max(1, Math.ceil((target - Me.mp) / (MP_PER[cfg.mana.type] || 20))), before = Me.mp; let used = 0;
      for (let i = 0; i < need; i++) {
        const r = await Core.potions.use(name, { force: true });
        if (!r.ok) { if (r.reason === 'none-available') { outUntil = Date.now() + 60000; log(`🛑 out of ${esc(name)} — pausing refills 60s`, 'warn'); } break; }
        used++; await sleep(300);
      }
      Me.statsAt = 0; await Me.refresh(0);
      if (used) { stats.mpRefills += used; log(`💧 ${esc(name)} ×${used} (${why || 'auto'}) · MP ${before} → ${Me.mp}/${Me.maxMp}`, 'info'); }
      return used > 0;
    } finally { refilling = false; }
  }
  let saveWarn = 0;
  function canUseStam() {
    const t = cfg.stam.save.thresholdPct;
    if (!(t > 0 && t < 100)) return true;                                  // 100 (or nothing) = never save
    const pct = Me.expPct(); if (pct == null) return true;
    if (pct >= t) { if (Date.now() - saveWarn > 30000) { saveWarn = Date.now(); log(`⏸️ stamina potions paused — EXP ${pct.toFixed(1)}% ≥ save threshold`, 'info'); } return false; }
    return true;
  }
  async function refillStamina() {
    const c = cfg.stam; if (!c.enabled || !canUseStam()) return false;
    const r = await Core.potions.stamina({ item: c.item });
    if (r.ok) {
      try { await Core.me.sync(); } catch (_) { /* */ }
      stats.stamA++; log(`🧪 ${esc(c.item)} ${r.used ? 'used' : 'covered by another script'} · stamina ${Me.stam()}/${Me.maxStam()}`, 'info'); return true;
    }
    if (r.reason === 'none-available') warn(`⚠️ no ${esc(c.item)} left`);
    return false;
  }
  async function heal(why) {
    if (!cfg.hp.enabled) return false;
    const r = await Core.potions.hp();
    if (!r.ok) { warn('⚠️ HP potion failed: ' + (r.reason || r.message || '')); return false; }
    stats.hpUses++; Me.hp = Me.maxHp; Me.statsAt = 0; log(`💊 HP potion${why ? ' — ' + why : ''}`, 'ok'); return true;
  }
  const hpTrip = () => cfg.hp.enabled && Me.hp > 0 && Me.maxHp > 1 && cfg.hp.thresholdPct > 0 && Me.hp <= Math.ceil(Me.maxHp * cfg.hp.thresholdPct / 100);
  return { refillMana, refillStamina, heal, hpTrip };
})();
const stats = { hits: 0, dmg: 0, cycles: 0, stamA: 0, stamB: 0, hpUses: 0, mpRefills: 0, started: Date.now() };

/* ---- class detection ---------------------------------------------------------------------------------------------- */
async function detectClass() {
  try {
    const doc = parseHtml(await Core.net.fetchText('/classes.php', { ttl: 600000 }));
    const t = ((doc.querySelector('.section-classes-pill') || {}).textContent || '').toLowerCase();
    const c = ['warrior', 'cleric', 'hunter', 'mage'].find((k) => t.includes(k));
    if (c && cfg.detectedClass !== c) { cfg.detectedClass = c; saveCfg(); log(`🧙 class detected: ${c}`, 'info'); }
  } catch (e) { log('⚠️ class detection failed: ' + e.message, 'warn'); }
}
const effectiveClass = () => { const o = (cfg.classOverride || 'auto').toLowerCase(); if (o !== 'auto' && CLASS_SKILLS[o]) return o; return CLASS_SKILLS[cfg.detectedClass] ? cfg.detectedClass : null; };

/* ---- build kit: crystals and sigils follow the build ----------------------------------------------------------------
 * The Build Engine chooses gear + pets (+ links). Crystals sit on a piece of gear and sigils on a pet, so once the engine has moved to
 * other gear / pets they would be on the wrong piece or the wrong pet. This part does the two follow-up jobs on its own (it reads the
 * pages itself, no other addon is needed):
 *   crystals.best()          Crystal Presets' "Auto-assign Best", ported: every activated crystal is a candidate, the best attack and
 *                            defense crystals go on the gear that is equipped NOW
 *   sigils.carry(teamBefore) the sigils the old pets wore go to the pets that took their place (same main slot / same link level)
 * and the way back, so a restore never puts anything "on any free piece":
 *   crystals.restore(snap)   every crystal goes back on the piece of gear it was on (matched by the gear's art)
 *   sigils.undo(moves)       every sigil that was moved goes back to the pet it came from, in reverse order
 * The pure parts (choosing, diffing, planning) sit between KIT-BEGIN and KIT-END: tests/kit.test.js loads them as they are.
 */
/* KIT-BEGIN */
const Kit = (() => {
  const SLOTS = ['attack', 'defense', 'elemental'];
  const numIn = (s) => { const m = /(\d[\d,]*)/.exec(String(s == null ? '' : s)); return m ? parseInt(m[1].replace(/,/g, ''), 10) || 0 : 0; };
  // a crystal's effect from its info panel: Attack / Defense value, anything else is "other"
  function effectOf(infoHtml) {
    const s = String(infoHtml || '');
    const a = /<span>\s*Attack\s*<\/span>\s*<strong>\s*([\d,]+)\s*<\/strong>/i.exec(s); if (a) return { type: 'attack', value: numIn(a[1]) };
    const d = /<span>\s*Defense\s*<\/span>\s*<strong>\s*([\d,]+)\s*<\/strong>/i.exec(s); if (d) return { type: 'defense', value: numIn(d[1]) };
    return { type: 'other', value: 0 };
  }
  // layout: { cardKey: [crystalId] }. cards: [{ key, slotCount, crystalIds }] (page order). catalog: { id: { type, value, level } }.
  // The same algorithm as Crystal Presets' Auto-assign Best with every equipped card selected: card by card the best attack crystal, the
  // best defense crystal, then the best remaining type that is not on that card yet. Equal crystals keep the one already worn (then the
  // lower id), so asking twice gives the same answer and nothing is moved for nothing.
  function bestLayout(cards, catalog) {
    const worn = new Set(); cards.forEach((c) => (c.crystalIds || []).forEach((id) => worn.add(String(id))));
    const all = Object.keys(catalog || {}).map((id) => ({ id: String(id), type: catalog[id].type || 'other', value: Number(catalog[id].value) || 0, level: Number(catalog[id].level) || 0 }));
    const byBest = (a, b) => (b.value - a.value) || (b.level - a.level) || ((worn.has(b.id) ? 1 : 0) - (worn.has(a.id) ? 1 : 0)) || (Number(a.id) - Number(b.id)) || (a.id < b.id ? -1 : 1);
    const pools = { attack: all.filter((c) => c.type === 'attack').sort(byBest), defense: all.filter((c) => c.type === 'defense').sort(byBest), other: all.filter((c) => c.type !== 'attack' && c.type !== 'defense').sort(byBest) };
    const layout = {};
    cards.forEach((card) => {
      const ids = [], used = new Set(), take = (t) => { const c = pools[t].shift(); if (!c) return false; ids.push(c.id); used.add(t); return true; };
      const cap = Math.max(0, card.slotCount | 0);
      if (cap > ids.length) take('attack'); if (cap > ids.length) take('defense');
      while (ids.length < cap) {
        const opts = ['attack', 'defense', 'other'].filter((t) => !used.has(t) && pools[t].length).map((t) => [t, pools[t][0]]).sort((x, y) => byBest(x[1], y[1]));
        if (!opts.length || !take(opts[0][0])) break;
      }
      layout[card.key] = ids;
    });
    return layout;
  }
  const layoutOf = (cards) => { const l = {}; cards.forEach((c) => { l[c.key] = (c.crystalIds || []).map(String); }); return l; };
  // current / wanted layouts -> what to take off and what to put on. A crystal that is in the right place is left alone.
  function layoutDiff(current, wanted) {
    const at = {}, want = {}, order = [];
    Object.keys(current || {}).forEach((k) => current[k].forEach((id) => { at[String(id)] = k; }));
    Object.keys(wanted || {}).forEach((k) => wanted[k].forEach((id) => { want[String(id)] = k; order.push([String(id), k]); }));
    return { unequip: Object.keys(at).filter((id) => want[id] !== at[id]), equip: order.filter(([id, k]) => at[id] !== k).map(([id, key]) => ({ id, key })) };
  }
  // restore: every piece of gear that is on now gets what the snapshot says it had (nothing if it was not in it); gear that is not on is skipped
  function restoreWanted(snapLayout, cards) {
    const wanted = {}, skipped = [];
    cards.forEach((c) => { wanted[c.key] = ((snapLayout || {})[c.key] || []).map(String).slice(0, Math.max(0, c.slotCount | 0)); });
    Object.keys(snapLayout || {}).forEach((k) => { if (!cards.some((c) => c.key === k) && snapLayout[k].length) skipped.push(k); });
    return { wanted, skipped };
  }
  // sigils: team = { m: { '1': inv, '2': inv, '3': inv }, l: { '1': { '1': inv, '2': inv }, ... } } (PvE team: mains by slot, links by main slot and level).
  // The positions where a different pet now stands: [{ pos, from, to }]. A pet that stayed where it was is not touched.
  function positionChanges(before, after) {
    const out = [], get = (t, a, b) => { const x = t && t[a] && (b == null ? t[a] : t[a][b]); return x ? String(x) : ''; };
    ['1', '2', '3'].forEach((s) => {
      const f = get(before, 'm', s), t = get(after, 'm', s); if (f && t && f !== t) out.push({ pos: 'main ' + s, from: f, to: t });
      ['1', '2'].forEach((lv) => { const lf = before && before.l && before.l[s] ? String(before.l[s][lv] || '') : '', lt = after && after.l && after.l[s] ? String(after.l[s][lv] || '') : ''; if (lf && lt && lf !== lt) out.push({ pos: 'link ' + lv + ' of main ' + s, from: lf, to: lt }); });
    });
    return out;
  }
  return { SLOTS, effectOf, bestLayout, layoutOf, layoutDiff, restoreWanted, positionChanges };
})();
/* KIT-END */

const BuildKit = (() => {
  const CRYSTALS = '/power_crystals.php', teamUrl = (t) => '/pets.php?team=' + t;
  const GAP = 120;                                                   // ms between two writes: the game answers each with a full page
  const getText = async (url) => {
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null, timer = ac ? setTimeout(() => ac.abort(), 20000) : 0;
    try { const r = await window.fetch(url, { credentials: 'include', cache: 'no-store', signal: ac ? ac.signal : undefined }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.text(); }
    finally { if (timer) clearTimeout(timer); }
  };
  const getJson = async (url) => { const j = Core.parseJson(await getText(url)); if (!j) throw new Error('not JSON: ' + url); return j; };
  const postUrl = async (url, fields, accept) => {
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null, timer = ac ? setTimeout(() => ac.abort(), 20000) : 0;
    try {
      const r = await window.fetch(url, { method: 'POST', credentials: 'include', headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, accept ? { Accept: accept } : {}), body: new URLSearchParams(fields).toString(), signal: ac ? ac.signal : undefined });
      return { ok: r.ok, status: r.status, text: await r.text() };
    } catch (e) { return { ok: false, status: 0, text: String((e && e.message) || e) }; } finally { if (timer) clearTimeout(timer); }
  };
  const heading = (doc, text) => Array.from(doc.querySelectorAll('.panel')).find((p) => { const h2 = p.querySelector('.panel-head h2'); return h2 && h2.textContent.trim() === text; }) || null;

  /* ---------------------------------------------- crystals ---------------------------------------------- */
  function readCrystals(doc) {
    if (Guard.pageState(doc) !== 'ok') throw new Error('crystals page: ' + Guard.pageState(doc));
    const intentEl = doc.querySelector('input[name="crystal_intent"]'), catalog = {}, cards = [], seen = {};
    const cp = heading(doc, 'Activated Crystals');
    if (cp) cp.querySelectorAll('.crystal-card').forEach((card) => {
      const imgBtn = card.querySelector('button.crystal-image'), up = card.querySelector('[onclick^="openUpgradeModal"]'); if (!imgBtn || !up) return;
      const m = /openUpgradeModal\('(?:level|star)'\s*,\s*(\d+)\)/.exec(up.getAttribute('onclick') || ''); if (!m) return;
      const eff = Kit.effectOf(imgBtn.getAttribute('data-info') || ''), lv = card.querySelector('.level-line span:first-child');
      const cimg = card.querySelector('img'), cnm = card.querySelector('.crystal-name, .crystal-title, .name, .title, h3, h4, strong');
      catalog[m[1]] = { type: eff.type, value: eff.value, level: lv ? parseInt(String(lv.textContent).replace(/\D/g, ''), 10) || 0 : 0, name: String((cnm && cnm.textContent) || (cimg && (cimg.getAttribute('alt') || cimg.getAttribute('title'))) || '').trim().slice(0, 40) };
    });
    const ep = heading(doc, 'Equipment');
    if (ep) ep.querySelectorAll('.equipment-card').forEach((card) => {
      const img = card.querySelector('.art-frame img'), src = img ? (img.getAttribute('src') || '') : ''; if (!src) return;
      seen[src] = (seen[src] || 0) + 1;                              // two pieces with the same art: told apart by their order on the page
      const key = seen[src] > 1 ? src + '#' + seen[src] : src, ids = []; let inv = null;
      const slots = Array.from(card.querySelectorAll('.slot-row .slot-btn'));
      slots.forEach((btn) => {
        const oc = btn.getAttribute('onclick') || '';
        if (btn.classList.contains('filled')) { const u = /openConfirmUnequip\((\d+)\)/.exec(oc); if (u) ids.push(u[1]); }
        else { const p = /openPickerModal\((\d+)\)/.exec(oc); if (p && inv == null) inv = p[1]; }
      });
      const gnm = card.querySelector('.equipment-name, .item-name, .eq-name, .name, .title, h3, h4, strong'), glabel = String((img && (img.getAttribute('alt') || img.getAttribute('title'))) || (gnm && gnm.textContent) || '').trim().slice(0, 40);
      cards.push({ key, label: /\.(webp|png|jpe?g|gif)$/i.test(glabel) ? '' : glabel, slotCount: slots.length, crystalIds: ids, equipmentInvId: inv });
    });
    return { intent: intentEl ? intentEl.value : '', catalog, cards };
  }
  const loadCrystals = async () => readCrystals(parseHtml(await getText(CRYSTALS)));
  async function crystalAct(st, fields) {
    const r = await postUrl(CRYSTALS, Object.assign({ crystal_intent: st.intent }, fields));
    if (!r.ok) return { ok: false, error: 'HTTP ' + (r.status || '?') };
    const doc = parseHtml(r.text); if (!doc.querySelector('.page-wrap')) return { ok: false, error: 'unexpected reply' };
    const flash = doc.querySelector('.page-wrap .flash');
    if (flash && flash.classList.contains('err')) return { ok: false, error: flash.textContent.trim() || 'rejected' };
    try { return { ok: true, st: readCrystals(doc) }; } catch (e) { return { ok: false, error: e.message }; }
  }
  // takes the unequips first, then the equips (a crystal cannot go on while it is still linked); one retry for a crystal that is still linked
  // to gear that is not on. Never throws.
  async function runDiff(st, diff) {
    let moves = 0; const notes = [];
    const label = (key) => { const i = st.cards.findIndex((x) => x.key === key), c = st.cards[i]; return (c && c.label) || 'gear piece ' + (i + 1); };   // never the picture's path
    const nm = (id) => { const c = st.catalog[String(id)]; return c ? (c.name || (typeof c.type === 'string' && c.type ? c.type.charAt(0).toUpperCase() + c.type.slice(1) + ' crystal' : 'crystal')) + (c.level ? ' Lv' + c.level : '') : 'crystal #' + id; };
    const plan = [...diff.unequip.map((id) => 'Take off ' + nm(id)), ...diff.equip.map((m) => 'Put ' + nm(m.id) + ' on ' + label(m.key))];
    const base = Prog.sub('Crystals', plan); let k = 0; const tick = () => { if (base >= 0) Prog.go(base + k); k++; };   // every move is a step of the status bar
    for (const id of diff.unequip) {
      tick();
      const r = await crystalAct(st, { action: 'unequip_crystal', crystal_id: String(id) });
      if (!r.ok) return { ok: false, moves, message: `could not take crystal #${id} off: ${r.error}`, notes };
      st = r.st; moves++; await sleep(GAP);
    }
    for (const m of diff.equip) {
      tick();
      const put = async () => { const c = st.cards.find((x) => x.key === m.key); if (!c || !c.equipmentInvId) return { ok: false, error: 'no open slot on ' + label(m.key) }; return crystalAct(st, { action: 'equip_crystal', crystal_id: String(m.id), equipment_inv_id: String(c.equipmentInvId) }); };
      let r = await put();
      if (!r.ok && !/no open slot/.test(r.error || '')) {              // maybe still linked to a piece that is not on: free it, once
        try { st = await loadCrystals(); } catch (_) { /* keep the old state */ }                  // a rejected write may have rotated the token
        const u = await crystalAct(st, { action: 'unequip_crystal', crystal_id: String(m.id) });
        if (u.ok) { st = u.st; r = await put(); }
      }
      if (!r.ok) { notes.push(`crystal #${m.id}: ${r.error}`); continue; }
      st = r.st; moves++; await sleep(GAP);
    }
    return { ok: !notes.length, moves, message: notes.length ? notes.join('; ') : '', notes, st };
  }
  const crystals = {
    ready: () => true,
    async snapshot() {
      const st = await loadCrystals(), layout = Kit.layoutOf(st.cards), worn = new Set([].concat(...Object.values(layout)));
      return { at: Date.now(), layout, free: Object.keys(st.catalog).filter((id) => !worn.has(id)), labels: Object.fromEntries(st.cards.map((c) => [c.key, c.label])) };   // free: not worn at that time
    },
    // the crystals on the gear that is on right now ({ gearKey: [crystalId] }), or null when the page could not be read
    async current() { try { return Kit.layoutOf((await loadCrystals()).cards); } catch (_) { return null; } },
    async best() {
      try {
        const st = await loadCrystals(), cards = st.cards.filter((c) => c.slotCount > 0);
        if (!cards.length) return { ok: true, changed: false, moves: 0, message: 'no equipped gear has crystal slots' };
        if (!Object.keys(st.catalog).length) return { ok: true, changed: false, moves: 0, message: 'no activated crystals' };
        const diff = Kit.layoutDiff(Kit.layoutOf(st.cards), Kit.bestLayout(cards, st.catalog));
        if (!diff.unequip.length && !diff.equip.length) return { ok: true, changed: false, moves: 0, message: 'already the best', layout: Kit.layoutOf(st.cards) };
        const r = await runDiff(st, diff), layout = r.st ? Kit.layoutOf(r.st.cards) : null; delete r.st; return Object.assign({ changed: r.moves > 0, placed: diff.equip.map((m) => m.id), layout }, r);   // placed: so a restore can free the ones that were free before
      } catch (e) { return { ok: false, changed: false, moves: 0, message: (e && e.message) || String(e) }; }
    },
    // snap = snapshot(). placed = what best() put on (ids): those that were free at the time are freed again, also when they sit on gear that
    // is not on any more (the equipment page cannot show those, so they are asked for by id; a refusal is ignored).
    async restore(snap, extra) {
      try {
        if (!snap || !snap.layout) return { ok: false, moves: 0, message: 'nothing to restore' };
        let st = await loadCrystals(); const { wanted, skipped } = Kit.restoreWanted(snap.layout, st.cards);
        const diff = Kit.layoutDiff(Kit.layoutOf(st.cards), wanted), gone = skipped.map((k) => (snap.labels && snap.labels[k]) || k);
        let r = { ok: true, moves: 0, message: '' };
        if (diff.unequip.length || diff.equip.length) { r = await runDiff(st, diff); st = r.st || st; }
        const free = new Set((snap.free || []).map(String)), keep = new Set([].concat(...Object.values(wanted)).map(String));
        for (const id of ((extra && extra.placed) || []).map(String)) {
          if (!free.has(id) || keep.has(id)) continue;
          const u = await crystalAct(st, { action: 'unequip_crystal', crystal_id: id });
          if (u.ok) { st = u.st; r.moves++; await sleep(GAP); } else { try { st = await loadCrystals(); } catch (_) { /* */ } }
        }
        if (gone.length) r.message = (r.message ? r.message + '; ' : '') + `${gone.join(', ')} not equipped: its crystals were left`;
        r.skipped = gone; delete r.st; return r;
      } catch (e) { return { ok: false, moves: 0, message: (e && e.message) || String(e) }; }
    },
  };

  /* ---------------------------------------------- sigils ---------------------------------------------- */
  let csrf = '';
  const readCsrf = async () => { try { const m = /const\s+PET_SIGIL_CSRF\s*=\s*"([^"]*)"/.exec(await getText('/pets.php')); if (m) csrf = m[1]; } catch (_) { /* the ajax reply carries one too */ } return csrf; };
  async function sigilInfo(inv, slot) {
    const j = await getJson(`/pet_sigils_ajax.php?pet_inv_id=${encodeURIComponent(inv)}&slot_type=${encodeURIComponent(slot)}`);
    if (j.status !== 'success') throw new Error(j.message || 'could not read the sigils');
    if (j.csrf) csrf = j.csrf;
    const mk = (o) => ({ itemId: String(o.item_id), name: o.name || ('Sigil #' + o.item_id), available: Number(o.available || 0) });
    return { current: j.current ? mk(j.current) : null, options: (j.options || []).map(mk) };
  }
  async function sigilAct(inv, slot, itemId, retried) {
    if (!csrf) await readCsrf();
    const f = { action: itemId ? 'equip' : 'remove', pet_inv_id: String(inv), slot_type: slot, csrf_token: csrf || '' }; if (itemId) f.item_id = String(itemId);
    const r = await postUrl('/pet_sigil_action.php', f, 'application/json'), j = Core.parseJson(r.text);
    if (!j || j.status !== 'success') {
      const msg = (j && j.message) || 'sigil update failed';
      if (!retried && /security token expired/i.test(msg) && (await readCsrf())) return sigilAct(inv, slot, itemId, true);
      throw new Error(msg);
    }
    await sleep(GAP); return j;
  }
  // the PvE team now: mains by slot and, for each main, its Link 1 / Link 2 pets
  async function readTeam() {
    const doc = parseHtml(await getText(teamUrl('attack'))); if (Guard.pageState(doc) !== 'ok') throw new Error('pets page: ' + Guard.pageState(doc));
    const sec = Array.from(doc.querySelectorAll('.section')).find((s) => ((s.querySelector('.section-title') || {}).textContent || '').trim() === 'PvE Attack Team');
    const team = { m: {}, l: {} };
    if (sec) sec.querySelectorAll('.pet-card[data-pet-inv-id]').forEach((card) => {
      const b = Array.from(card.querySelectorAll('button')).find((x) => /unequipPet\s*\(\s*\d+\s*\)/.test(x.getAttribute('onclick') || '')), m = b && /unequipPet\s*\(\s*(\d+)\s*\)/.exec(b.getAttribute('onclick') || '');
      if (m) team.m[m[1]] = card.getAttribute('data-pet-inv-id');
    });
    for (const s of Object.keys(team.m)) {
      try {
        const j = await getJson('/pet_links_ajax.php?pet_inv_id=' + encodeURIComponent(team.m[s])); team.l[s] = {};
        if (j.status === 'success') (j.links || []).forEach((x) => { const id = x.inv_id != null ? x.inv_id : (x.link_pet_id != null ? x.link_pet_id : x.pet_inv_id); if (id != null && (x.link_level === 1 || x.link_level === 2)) team.l[s][x.link_level] = String(id); });
      } catch (_) { /* this main's links stay unknown: no carry for them */ }
    }
    return team;
  }
  const sigils = {
    ready: () => true,
    team: readTeam,
    // before = readTeam() taken before the engine changed the pets. Moves the sigils of every position whose pet changed. Never throws.
    async carry(before) {
      const undo = [], notes = [];
      try {
        const changes = Kit.positionChanges(before, await readTeam());
        const base = Prog.sub('Sigils', changes.map((c) => 'Move sigils · ' + c.pos)); let k = 0;
        for (const c of changes) {
          if (base >= 0) Prog.go(base + k); k++;
          for (const slot of Kit.SLOTS) {
            let old; try { old = await sigilInfo(c.from, slot); } catch (e) { notes.push(`${c.pos} ${slot}: ${e.message}`); continue; }
            if (!old.current) continue;
            const want = old.current;
            try {
              let now = await sigilInfo(c.to, slot);
              if (now.current && now.current.itemId === want.itemId) continue;
              let opt = now.options.find((o) => o.itemId === want.itemId), removedFrom = null;
              if (!opt) { notes.push(`${c.pos}: ${want.name} is not usable on the new pet`); continue; }
              if (opt.available <= 0) {                              // every copy is worn: the old pet gives it up
                await sigilAct(c.from, slot, null); removedFrom = c.from;
                now = await sigilInfo(c.to, slot); opt = now.options.find((o) => o.itemId === want.itemId);
                if (!opt || opt.available <= 0) { notes.push(`${c.pos}: no free ${want.name}`); undo.push({ pet: c.from, slot, restore: want.itemId, took: null }); continue; }
              }
              const prev = now.current ? now.current.itemId : null;
              if (prev) await sigilAct(c.to, slot, null);
              await sigilAct(c.to, slot, want.itemId);
              undo.push({ pet: c.to, slot, restore: prev, took: want.itemId, giveBack: removedFrom ? { pet: removedFrom, item: want.itemId } : null });
            } catch (e) { notes.push(`${c.pos} ${slot}: ${e.message}`); }
          }
        }
        return { ok: !notes.length, moved: undo.filter((u) => u.took).length, undo, message: notes.join('; ') };
      } catch (e) { return { ok: false, moved: undo.filter((u) => u.took).length, undo, message: (e && e.message) || String(e) }; }
    },
    // moves = the undo entries of every carry so far, undone newest first
    async undo(moves) {
      const notes = []; let n = 0;
      const list = (moves || []).slice().reverse(), base = Prog.sub('Sigils', list.map((u) => 'Put back ' + u.slot + ' sigil')); let k = 0;
      for (const u of list) {
        if (base >= 0) Prog.go(base + k); k++;
        try {
          if (u.took) {
            const cur = await sigilInfo(u.pet, u.slot);
            if (cur.current && cur.current.itemId === u.took) { await sigilAct(u.pet, u.slot, null); n++; }
            if (u.restore) { const o = (await sigilInfo(u.pet, u.slot)).options.find((x) => x.itemId === u.restore); if (o && o.available > 0) { await sigilAct(u.pet, u.slot, u.restore); n++; } else notes.push(`${u.slot}: the old sigil is not free`); }
            if (u.giveBack) { const o = (await sigilInfo(u.giveBack.pet, u.slot)).options.find((x) => x.itemId === u.giveBack.item); if (o && o.available > 0) { await sigilAct(u.giveBack.pet, u.slot, u.giveBack.item); n++; } else notes.push(`${u.slot}: could not give it back`); }
          } else if (u.restore) {                                    // a sigil taken off a pet that could not pass it on
            const o = (await sigilInfo(u.pet, u.slot)).options.find((x) => x.itemId === u.restore); if (o && o.available > 0) { await sigilAct(u.pet, u.slot, u.restore); n++; }
          }
        } catch (e) { notes.push(`${u.slot}: ${e.message}`); }
      }
      return { ok: !notes.length, moved: n, message: notes.join('; ') };
    },
  };
  return { crystals, sigils };
})();

/* ---- preset bridge (found through Core capabilities) ---------------------------------------------------------------
 * The automator knows no preset addon by name and Core knows nothing about presets. Any addon that offers the pair
 *
 *     preset.<kind>.list    ()                    -> [{ id, name }]            saved presets
 *     preset.<kind>.apply   (id, { silent, target }) -> Promise<{ ok, message }>   equip it, never a confirm() dialog
 *
 * through Core capabilities (guides/CAPABILITIES.md) gets a "<kind> preset" dropdown on every boss, and the chosen preset is applied
 * when the engine moves to that boss. Today that is gear, crystal and pet; an addon that later offers preset.title.* shows up here
 * with no change to either side. A kind that is not offered shows nothing; a late-loading addon redraws the panel (caps:changed).
 */
const Presets = (() => {
  const FIRST = ['gear', 'crystal', 'pet'];                                        // applied in this order; any other kind follows A-Z
  const RESERVED = new Set(['cap', 'gate', 'wave', 'targeting', 'schedule', 'switchAt', 'capAfterSwitch']);   // boss fields a kind must not shadow
  const applied = {}, failedAt = {};
  const haveCaps = () => typeof Core.caps === 'function' && typeof Core.call === 'function';
  const kinds = () => {
    if (!haveCaps()) return [];
    const ks = [];
    for (const c of Core.caps('preset.')) {
      const m = /^preset\.([a-z0-9-]+)\.list$/.exec(c.cap);
      if (m && !RESERVED.has(m[1]) && Core.has('preset.' + m[1] + '.apply')) ks.push(m[1]);
    }
    const rank = (k) => { const i = FIRST.indexOf(k); return i < 0 ? 99 : i; };
    return ks.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
  };
  const available = (kind) => kinds().includes(kind);
  function list(kind) {
    const f = haveCaps() ? Core.cap('preset.' + kind + '.list') : null; if (!f) return [];
    try { return (f() || []).map((p) => ({ id: String(p.id), name: String(p.name == null ? p.id : p.name) })); } catch (_) { return []; }
  }
  const nameOf = (kind, id) => { const p = list(kind).find((x) => x.id === String(id)); return p ? p.name : String(id); };
  // The Build Engine offers the pseudo-kind 'best' (preset.best.*): it needs the boss (any boss: wave, General, dungeon boss or mob).
  const BEST = 'best';
  const BEST_MIN_GAIN = 0.1;                                          // %: the engine equips its best unless that is within this of what is on (its own default, 2%, would leave up to 2% damage on the table)
  const bossOf = (t) => ({ monsterId: t.monsterId, name: t.name, kind: t.kind });
  // What the Build Engine is asked to search for. A wave boss (Generals included) is just its id: the engine reads its battle page itself.
  // A dungeon boss / mob has no such page (battle.php?dgmid=..&instance_id=..), so its stats are read here from its own battle page and handed
  // over complete (the engine takes given stats as they are). null = the stats could not be read: the engine is NOT asked, because it would
  // search for some other monster.
  const dgMobs = new Map();
  async function engineMob(t) {
    if (!t || t.kind !== 'dungeon' || t.instanceId == null) return t ? bossOf(t) : null;
    const key = t.monsterId + ':' + t.instanceId, hit = dgMobs.get(key);
    if (hit && Date.now() - hit.at < (hit.mob ? 20 * 60000 : 45000)) return hit.mob ? Object.assign(bossOf(t), hit.mob) : null;
    let mob = null;
    try {
      const html = await Core.net.fetchText(`/battle.php?dgmid=${encodeURIComponent(t.monsterId)}&instance_id=${encodeURIComponent(t.instanceId)}`, { ttl: 60000 });
      if (Guard.pageState(html) === 'ok') {
        const m = {}, num = (x) => parseInt(String(x).replace(/[^0-9]/g, ''), 10) || 0, doc = parseHtml(html);
        doc.querySelectorAll('.stat-block').forEach((sb) => {          // the same blocks the engine reads on a wave boss's page
          const l = sb.querySelector('.label'), v = sb.querySelector('strong'); if (!l || !v) return;
          const lab = l.textContent.trim(), txt = v.textContent.trim();
          if (lab === 'ATK') m.atk = num(txt); else if (lab === 'DEF') m.def = num(txt);
          else if (lab === "MONSTER PET'S DEF") m.petDef = num(txt); else if (lab === "MONSTER EQ'S DEF") m.eqDef = num(txt);
          else if (lab === 'Element') { m.element = txt.toUpperCase(); const r = /Element\s*Rate:\s*([0-9.]+)%/i.exec((sb.querySelector('div') || {}).textContent || ''); if (r) m.elemRate = parseFloat(r[1]); }
        });
        doc.querySelectorAll('.monster-stat-cell').forEach((c) => {   // the View Monster Stats popup (it is in the page's own HTML): Attack, Defense, Pet Defense, Equipment Defense, Element, Element Rate + the four resistances
          const l = c.querySelector('.label'), v = c.querySelector('strong'); if (!l || !v) return;
          const lab = l.textContent.trim().toLowerCase(), txt = v.textContent.trim();
          if (lab === 'attack') m.atk = m.atk || num(txt); else if (lab === 'defense') m.def = m.def || num(txt);
          else if (lab === 'pet defense') m.petDef = m.petDef || num(txt); else if (lab === 'equipment defense') m.eqDef = m.eqDef || num(txt);
          else if (lab === 'element') { if (m.element == null && !/^none$/i.test(txt)) m.element = txt.toUpperCase(); }
          else if (lab === 'element rate') { if (m.elemRate == null) { const r = /([0-9.]+)\s*%/.exec(txt); if (r) m.elemRate = parseFloat(r[1]); } }
          else if (lab === 'crit rate resistance') m.critRateRes = parseFloat(txt) || 0;           // the engine uses these in its damage maths, the same names it fills for a wave boss
          else if (lab === 'crit damage resistance') m.critDmgRes = parseFloat(txt) || 0;
          else if (lab === 'final damage resistance') m.finalDmgRes = parseFloat(txt) || 0;
          else if (lab === 'passive damage resistance') m.passiveDmgRes = parseFloat(txt) || 0;
        });
        doc.querySelectorAll('.chip').forEach((c) => { const x = (c.textContent || '').trim(); if (x.includes('Effect:')) m.effect = x.replace(/^\u{1F9E0}\s*/u, '').trim(); });   // "🧠 Effect: …", as the engine reads it on a wave boss
        { const dm = /Damage\s*Multiplier:\s*([0-9.]+)\s*%/i.exec((doc.body && doc.body.textContent) || ''); if (dm) m.divineMult = parseFloat(dm[1]) / 100; }   // Divine Shield, as the engine reads it on a wave boss
        if (m.atk && m.def) mob = Object.assign({ petDef: 0, eqDef: 0, element: 'None' }, m);
      }
    } catch (_) { mob = null; }
    dgMobs.set(key, { at: Date.now(), mob });
    return mob ? Object.assign(bossOf(t), mob) : null;
  }
  const noBest = (t) => !t;                                           // the engine can search for any boss: wave bosses, Generals, dungeon bosses and mobs alike
  const memoOf = (kind, want, t) => (kind === BEST ? 'best@' + (t && t.monsterId != null ? t.monsterId : '') : String(want));   // best is judged per boss
  // Called between swings, when the engine moves to a boss. Applies what the boss gets, in the order that makes sense: gear and pets first
  // (the Build Engine's 'best' is one of them), THEN crystals (they sit on the gear that is on now) and sigils (they sit on the pets that
  // are on now). Every preset apply gets { silent: true, boss }; kind 'best' also gets target = the boss, which is what the engine searches for.
  //
  // What a boss gets: the Loadout card decides, a pick in the boss's own picker (gear / crystal / pet) wins for that kind.
  //   Loadout 🤖 Auto best   every boss: the engine's best gear + pets. Crystals: Auto-assign Best on the gear that is on (unless 💎 is off or the
  //                          boss has a crystal pick). Sigils: move to the pets that took their place. The saved presets are OFF while this is on.
  //   Loadout 📌 Saved       the saved gear / crystal / pet presets are equipped before every boss that has no pick of its own.
  // A boss with its own gear or pet pick is "own": the engine is not asked for it, whatever the Loadout card says.
  const BKIND = ['gear', 'pet'];
  const pickKinds = () => kinds().filter((k) => k !== BEST);       // what the pickers show: 'best' is the Auto switch, not a preset
  const buildOf = (low) => { const o = cfg.bosses[low] || {}; return o.gear || o.pet ? 'own' : ''; };
  const globalAuto = () => available(BEST) && !!(cfg.autoBuild && cfg.autoBuild.enabled);
  const autoFor = (low, t) => globalAuto() && !noBest(t) && buildOf(low) !== 'own';
  // the Loadout card's preset for a kind; '' while Auto is on (crystals: only while 💎 Best crystals is on too)
  const defaultPick = (kind) => (globalAuto() && (kind !== 'crystal' || (cfg.autoBuild || {}).crystals !== false) ? '' : String((cfg.loadout || {})[kind] || ''));
  const crystalAuto = (low, t) => globalAuto() && !!t && (cfg.autoBuild || {}).crystals !== false && !((cfg.bosses[low] || {}).crystal);   // sits on whatever gear is on, so a boss with its own gear pick gets it too
  const sigilAuto = (low, t) => autoFor(low, t) && (cfg.autoBuild || {}).sigils !== false;
  function wanted(low, t) {
    const o = cfg.bosses[low] || {}, auto = autoFor(low, t), out = {};
    for (const kind of kinds()) {
      const mine = o[kind];
      let want = mine === '__keep' ? '' : (mine || defaultPick(kind));
      if (auto && BKIND.includes(kind)) want = '';                    // the engine picks gear + pets
      if (kind === BEST) want = auto ? BEST : '';
      if (want) out[kind] = String(want);
    }
    if (crystalAuto(low, t)) out.crystal = '__best';
    return out;
  }

  /* what was on before the automator first changed anything: gear + pets (the engine's own read), crystals by piece of gear, and the sigils
   * it moved. Kept until you put it back (or forget it), also across a reload. */
  const originStore = Core.store(ID + '-origin', { def: null });
  let capturing = false, buildEpoch = 0;                              // buildEpoch: counts gear changes, so crystals are placed again after each
  const Origin = {
    get: () => originStore.get() || null,
    async ensure(t) {
      if (Origin.get() || capturing) return;
      capturing = true;
      try {
        const o = { at: Date.now(), boss: t ? t.name : '', sel: null, crystals: null, moves: [], left: null, probe: t ? { low: t.low, name: t.name, kind: t.kind, monsterId: t.monsterId, instanceId: t.instanceId, locationId: t.locationId, cap: t.cap, userDmg: t.userDmg } : null };   // left: the build this automator put on last (to see whether you changed it yourself); probe: the boss to read it against
        if (t && available(BEST)) { try { const r = await withTimeout(Promise.resolve(Core.call('build.predict', (await engineMob(t)) || bossOf(t))), 60000, null); if (r && r.ok !== false && r.sel && r.sel.gear) o.sel = r.sel; } catch (_) { /* no gear / pet read */ } }
        try { o.crystals = await withTimeout(BuildKit.crystals.snapshot(), 30000, null); } catch (_) { /* no crystal read */ }
        originStore.set(o);
        log(`📌 remembered your build (${o.sel ? 'gear + pets' : 'gear / pets NOT read'}${o.crystals ? ' + crystals' : ''}) so it can be put back`, o.sel ? 'info' : 'warn');
      } finally { capturing = false; }
    },
    addPlaced(ids) { if (!ids || !ids.length) return; const o = Origin.get(); if (!o) return; o.placed = Array.from(new Set((o.placed || []).concat(ids.map(String)))); originStore.set(o); },
    addMoves(list) { if (!list || !list.length) return; const o = Origin.get(); if (!o) return; o.moves = (o.moves || []).concat(list); originStore.set(o); },
    clear() { originStore.set(null); },
    // Someone else (you, another tab, another addon) changed the build: whatever that touched is no longer "what was on before", so it is NOT put back
    // over your change. gear / pets / crystals each only lose their own part; when nothing is left to put back, the memory goes.
    touched(owner) {
      const o = Origin.get(); if (!o || capturing) return;
      const parts = { 'gear-presets': ['sel', 'crystals'], 'pet-presets': ['sel'], 'build-engine': ['sel', 'crystals'], 'crystal-presets': ['crystals'] }[owner] || ['sel', 'crystals', 'moves'];
      parts.forEach((k) => { if (k === 'moves') o.moves = []; else o[k] = null; }); if (parts.includes('crystals')) o.placed = [];
      if (!o.sel && !o.crystals && !(o.moves || []).length) { Origin.clear(); log('📌 you changed your build yourself, so the automator will not put the old one back over it', 'info'); }
      else { originStore.set(o); log(`📌 you changed ${parts.map((k) => ({ sel: 'gear + pets', crystals: 'crystals', moves: 'sigils' }[k])).join(' + ')} yourself, so that part will not be put back`, 'info'); }
    },
    // read the build that is on right now (gear + pets) the way the capture did
    async read(t) { try { const r = await withTimeout(Promise.resolve(Core.call('build.predict', (t && (await engineMob(t))) || (t && bossOf(t)) || {})), 45000, null); return r && r.ok !== false && r.sel && r.sel.gear ? r.sel : null; } catch (_) { return null; } },
    // the crystals this automator left on the gear (so a restore can tell you moved them yourself). layout: given, or read now.
    async markCrystals(layout) { const o = Origin.get(); if (!o || !o.crystals) return; const l = layout || await BuildKit.crystals.current(); const o2 = Origin.get(); if (l && o2) { o2.crystalsLeft = l; originStore.set(o2); } },
    async markLeft(t) { const o = Origin.get(); if (!o || !o.sel || !available(BEST)) return; const sel = await Origin.read(t); const o2 = Origin.get(); if (sel && o2) { o2.left = sel; originStore.set(o2); } },
  };
  let chain = Promise.resolve();                                      // ensure() and restore() take turns, never overlap
  const exclusive = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

  let ensuring = false, ownUntil = 0;                                   // ownUntil: loadout events of this tab right after our own change are ours
  const ensure = (low, t) => exclusive(() => ensureNow(low, t));
  async function ensureNow(low, t) {
    const W = wanted(low, t), auto = autoFor(low, t), sig = sigilAuto(low, t);
    ensuring = true;
    let changedAny = false;
    try {
      const all = kinds(), first = ['gear', 'pet', BEST].filter((k) => all.includes(k));
      const seq = [...first, ...all.filter((k) => !first.includes(k) && k !== 'crystal'), ...(all.includes('crystal') ? ['crystal'] : [])];
      const stepOf = (k) => (k === BEST ? 'Gear + pets' : k === 'gear' ? 'Gear' : k === 'pet' ? 'Pets' : k === 'crystal' ? 'Crystals' : k.charAt(0).toUpperCase() + k.slice(1));
      const todo = []; if (Object.keys(W).length && !Origin.get()) todo.push('Remembering your build');
      for (const kind of seq) { const want = W[kind]; if (!want || (kind === 'crystal' && want === '__best') || applied[kind] === memoOf(kind, want, t)) continue; todo.push(stepOf(kind)); if (kind === BEST && sig) todo.push('Sigils'); }
      if (W.crystal === '__best' && (todo.length || applied.crystal !== '__best@' + buildEpoch)) todo.push('Crystals');
      Prog.start('Switching build for ' + bossName(low), todo);
      if (Object.keys(W).length) { Prog.at('Remembering your build'); await Origin.ensure(t); }   // before anything moves: what is on now is what gets put back
      for (const kind of seq) {
        const want = W[kind];
        if (!want || (kind === 'crystal' && want === '__best')) continue;
        const memo = memoOf(kind, want, t);
        if (applied[kind] === memo) continue;
        const key = kind + ':' + memo;
        if (Date.now() - (failedAt[key] || 0) < 300000) continue;           // a failed apply is not retried for 5 min (best: per boss)
        const label = kind === BEST ? 'best gear + pets' : `${kind} preset "${esc(nameOf(kind, want))}"`;
        Prog.at(stepOf(kind));
        log(`🎒 applying ${label} for ${esc(bossName(low))}…`, 'info');
        const boss = t ? await engineMob(t) : { name: bossName(low) };
        if (!boss) { failedAt[key] = Date.now(); log(`⚠️ ${label}: could not read ${esc(bossName(low))}'s stats, so what is equipped stays`, 'warn'); continue; }
        const opts = kind === BEST ? { silent: true, boss, target: boss, threshold: BEST_MIN_GAIN, mode: OPT_MODE } : { silent: true, boss };
        let teamBefore = null;
        if (kind === BEST && sig) { try { teamBefore = await withTimeout(BuildKit.sigils.team(), 30000, null); } catch (_) { teamBefore = null; } }
        let r;
        try { r = await withTimeout(Core.call('preset.' + kind + '.apply', String(want), opts), 120000, { ok: false, message: 'timed out' }); }
        catch (e) { r = { ok: false, message: (e && e.code === 'NO_CAP') ? 'the addon that offered it is gone' : ((e && e.message) || String(e)) }; }
        if (r && r.ok !== false) {
          applied[kind] = memo; log(`✅ ${kind === BEST ? 'best gear + pets' : kind + ' preset'} ${r.changed === false ? 'already on' : 'applied'}`, 'ok'); try { await Core.me.sync(); } catch (_) { /* */ } Me.statsAt = 0;
          if (kind === 'gear' || (kind === BEST && r.changed)) buildEpoch++;
          if (r.changed !== false) changedAny = true;
          if (kind === 'crystal') await Origin.markCrystals();
          if (kind === BEST && r.changed) {
            delete applied.gear; delete applied.pet;                  // the engine moved gear / pets: those memos no longer describe what is on
            if (sig && teamBefore) {                                  // sigils sit on pets: move them to the pets that took their place
              Prog.at('Sigils');
              const c = await BuildKit.sigils.carry(teamBefore);
              Origin.addMoves(c.undo);
              if (c.moved) log(`✨ ${c.moved} sigil${c.moved === 1 ? '' : 's'} moved to the new pets`, 'ok');
              if (!c.ok) log(`⚠️ sigils: ${esc(c.message)}`, 'warn');
            }
          }
        } else { failedAt[key] = Date.now(); log(`⚠️ ${label} failed: ${esc((r && r.message) || 'unknown')}`, 'warn'); }
      }
      if (changedAny) await Origin.markLeft(t);                       // what we leave on: a later restore checks you did not change it yourself
      if (W.crystal === '__best') {                                   // crystals sit on the gear that is on now, so after gear
        const memo = '__best@' + buildEpoch, key = 'crystal:' + memo;
        if (applied.crystal !== memo && Date.now() - (failedAt[key] || 0) >= 300000) {
          Prog.at('Crystals');
          log(`💎 best crystals on the gear for ${esc(bossName(low))}…`, 'info');
          const r = await withTimeout(BuildKit.crystals.best(), 180000, { ok: false, message: 'timed out' });
          Origin.addPlaced(r && r.placed);
          if (r && r.ok !== false) { await Origin.markCrystals(r.layout); }
          if (r && r.ok !== false) { applied.crystal = memo; log(r.changed ? `✅ crystals placed (${r.moves} step${r.moves === 1 ? '' : 's'})` : '✅ crystals already the best', 'ok'); }
          else { failedAt[key] = Date.now(); log(`⚠️ best crystals: ${esc((r && r.message) || 'unknown')}`, 'warn'); }
        }
      }
    } finally { ensuring = false; ownUntil = Date.now() + 2500; Prog.end(); }
  }
  // Put back what was there before: gear + pets, then the crystals onto the same pieces of gear, then every moved sigil to its pet.
  const restore = (why) => exclusive(() => restoreNow(why));
  async function restoreNow(why) {
    const o = Origin.get(); if (!o) return { ok: false, message: 'nothing remembered to put back' };
    ensuring = true;
    const notes = []; let liveSel = null;
    try {
      // Crystals: the Crystal Presets / the crystals page do not announce a change, so it is read: what sits on the gear now (still the gear we left)
      // against what we left there. Different = you moved them yourself: they stay as they are.
      if (o.crystals && !o.crystalsLeft && !(o.placed || []).length && why !== 'you asked') { o.crystals = null; originStore.set(o); }   // never moved by this automator: nothing to put back
      if (o.crystals && o.crystalsLeft && why !== 'you asked') {
        const now = await BuildKit.crystals.current(), norm = (l) => JSON.stringify(Object.keys(l || {}).sort().map((k) => [k, (l[k] || []).map(String).sort()]));
        if (now && norm(now) !== norm(o.crystalsLeft)) { o.crystals = null; o.placed = []; originStore.set(o); log('📌 your crystals are not what the automator left, so they were moved by you: they stay as they are', 'info'); }
      }
      // The build on now is not the one this automator left (you changed it while it was paused / idle / the page was closed): leave it alone.
      if (o.sel && o.left && o.probe && why !== 'you asked') {
        const live = liveSel = await Origin.read(o.probe);
        if (live && Plan.distance(Plan.sigFromSel(live, null), Plan.sigFromSel(o.left, null)) > 0) {
          Origin.clear(); Object.keys(applied).forEach((k) => delete applied[k]); buildEpoch++;   // what we remembered applying is not on any more
          log('📌 your gear / pets are not what the automator left, so they were changed by you: they stay as they are', 'info');
          return { ok: true, message: 'you changed your build yourself, so it was left as it is' };
        }
      }
      let backWhat = ''; try { if (o.sel && o.probe) { const live = liveSel || await Origin.read(o.probe); if (live) backWhat = Plan.describe(Plan.sigFromSel(live, null), Plan.sigFromSel(o.sel, null)); } } catch (_) { /* no detail */ }   // what will change, for the status text
      Prog.start('Putting your build back', [...(o.sel ? ['Gear + pets'] : []), ...(o.crystals ? ['Crystals'] : []), ...((o.moves || []).length ? ['Sigils'] : [])]);
      log(`↩ putting your build back${why ? ' (' + esc(why) + ')' : ''}…`, 'info');
      if (o.sel && Core.has && Core.has('build.apply')) {
        Prog.at('Gear + pets'); if (backWhat) Prog.note('Gear + pets', 'Gear + pets · ' + backWhat);
        const r = await withTimeout(Promise.resolve(Core.call('build.apply', { sel: o.sel }, { label: 'Your build' })), 240000, { ok: false, message: 'timed out' });
        if (r && r.ok !== false) log(`✅ gear + pets ${r.changed === false ? 'were already as before' : 'put back'}`, 'ok'); else notes.push('gear + pets: ' + ((r && r.message) || 'failed'));
      } else if (!o.sel) notes.push('gear + pets were not read, so they stay as they are');
      if (o.crystals) {
        Prog.at('Crystals');
        const r = await withTimeout(BuildKit.crystals.restore(o.crystals, { placed: o.placed }), 240000, { ok: false, message: 'timed out' });
        if (r && r.ok !== false) log(`✅ crystals ${r.moves ? 'put back on their gear' : 'were already as before'}${r.message ? ' (' + esc(r.message) + ')' : ''}`, 'ok'); else notes.push('crystals: ' + ((r && r.message) || 'failed'));
      }
      if ((o.moves || []).length) {
        Prog.at('Sigils');
        const r = await withTimeout(BuildKit.sigils.undo(o.moves), 240000, { ok: false, message: 'timed out' });
        if (r && r.ok !== false) log(`✅ sigils back on their pets (${r.moved})`, 'ok'); else notes.push('sigils: ' + ((r && r.message) || 'failed'));
      }
      Object.keys(applied).forEach((k) => delete applied[k]); buildEpoch++;
      if (notes.length) { log(`⚠️ not everything went back: ${esc(notes.join(' · '))} — it is still remembered, try again`, 'warn'); return { ok: false, message: notes.join('; ') }; }
      Origin.clear(); try { await Core.me.sync(); } catch (_) { /* */ } Me.statsAt = 0;
      return { ok: true, message: 'your build is back' };
    } catch (e) { log('⚠️ restore: ' + esc((e && e.message) || String(e)), 'warn'); return { ok: false, message: (e && e.message) || String(e) }; }
    finally { ensuring = false; ownUntil = Date.now() + 2500; Prog.end(); }
  }
  // Someone else changed the build (a human preset click, another tab, the engine): what this tab remembers applying may be stale.
  // Which memos an owner can invalidate; an unknown owner clears everything.
  const OWNS = { 'gear-presets': ['gear', BEST], 'pet-presets': ['pet', BEST], 'crystal-presets': ['crystal'], 'build-engine': ['gear', 'pet', BEST] };
  function foreignEnd(d) {
    if (d && d.tab === Core.tabId && (ensuring || Date.now() < ownUntil)) return;   // our own applies (this tab): ensure() keeps its memo itself
    const ks = (d && OWNS[d.owner]) || Object.keys(applied);
    ks.forEach((k) => { delete applied[k]; });
    if (Tab.isMain()) Origin.touched(d && d.owner);                    // you (or another tab) changed the build: that part is no longer ours to put back
  }
  if (typeof Core.on === 'function') Core.on('loadout:end', foreignEnd);
  // "gear: Boss gear · pet: Boss pets" for the Status tab, or an em dash when nothing was applied this session
  const summary = () => { const a = kinds().filter((k) => applied[k]).map((k) => k + ': ' + (String(applied[k]).startsWith('__best') ? 'best' : nameOf(k, String(applied[k]).split('@')[0]))); if (applied.crystal && !kinds().includes('crystal')) a.push('crystal: best'); return a.length ? a.join(' · ') : '—'; };
  const note = () => !haveCaps() ? 'needs Core 3.16.0+' : (kinds().length ? kinds().map((k) => `${k} (${list(k).length})`).join(' · ') : 'none offered');
  return { kinds, pickKinds, available, list, ensure, wanted, autoFor, buildOf, defaultPick, crystalAuto, engineMob, summary, note, restore, origin: Origin, applied: () => Object.assign({}, applied), forget: () => { Object.keys(applied).forEach((k) => delete applied[k]); buildEpoch++; } };
})();

/* ---- build planner: which boss next, so the build changes as little as possible ------------------------------------------
 * Every boss that is about to be fought has a "build signature": what will be equipped for it (the Build Engine's best gear + pets, or the
 * saved presets' names) and its crystal preset. distance() counts the changes between two builds (one per gear slot, per pet, per link,
 * 1 for another crystal preset); order() puts the bosses in the order that needs the fewest changes from the build that is on now.
 * Up to EXACT_MAX bosses: the cheapest order of all (DP over subsets). More: nearest-first, then improved until no
 * reversal / move makes it cheaper. No cut-off, no setting: it is a sort by distance, the same for every boss. Your own order of the list plays no part (ties are settled by name). Plan is pure (no Core, no DOM): tests/plan.test.js loads it as it is.
 */
/* PLAN-BEGIN */
const Plan = (() => {
  const UNRELATED = 20, EXACT_MAX = 12;
  const nz = (v) => (v == null ? '' : String(v));
  const cryst = (c) => (c == null || c === '' ? null : String(c));
  // sig: { any, tag, gear:{Slot:name}, mains:[name], links:{main:[l1,l2]}, crystal } — any: needs no change (keeps what is equipped); tag: a saved-preset build, not comparable with a searched one
  function sigFromSel(sel, crystal) {
    const mains = [], links = {};
    ((sel && sel.mains) || []).forEach((m, i) => { m = nz(m); if (!m) return; mains.push(m); links[m] = [nz(((sel.link1) || [])[i]), nz(((sel.link2) || [])[i])]; });
    return { any: false, tag: '', gear: Object.assign({}, (sel && sel.gear) || {}), mains, links, crystal: cryst(crystal) };
  }
  const tagSig = (tag, crystal) => ({ any: false, tag: String(tag), gear: {}, mains: [], links: {}, crystal: cryst(crystal) });
  const anySig = (crystal) => ({ any: true, tag: '', gear: {}, mains: [], links: {}, crystal: cryst(crystal) });
  function distance(a, b) {
    let d = a.crystal != null && b.crystal != null && a.crystal !== b.crystal ? 1 : 0;
    if (a.any || b.any) return d;
    if (a.tag !== b.tag) return d + UNRELATED;
    if (a.tag) return d;
    new Set([...Object.keys(a.gear), ...Object.keys(b.gear)]).forEach((slot) => { if (nz(a.gear[slot]) !== nz(b.gear[slot])) d++; });
    const am = new Set(a.mains), bm = new Set(b.mains);
    am.forEach((m) => { if (!bm.has(m)) d++; });
    bm.forEach((m) => {
      if (!am.has(m)) { d += 1 + (b.links[m] || []).filter(Boolean).length; return; }
      const la = a.links[m] || ['', ''], lb = b.links[m] || ['', ''];
      for (let i = 0; i < 2; i++) if (nz(la[i]) !== nz(lb[i])) d++;
    });
    return d;
  }
  const dist0 = (start, sig) => (start ? distance(start, sig) : 0);
  function cost(start, sigs) { let c = 0, cur = start; sigs.forEach((s) => { c += dist0(cur, s); cur = s; }); return c; }
  // items: [{ key, sig }] in any order (the order you gave them is ignored). Returns { keys, cost, mode }. Always a real sort by build distance,
  // no cut-off and no ranking: the cost of an order is the sum of the changes between each boss and the one fought right BEFORE it (the first
  // one is measured from the build that is on now), so a chain A -> B -> C is paid A->B + B->C. Up to EXACT_MAX bosses the cheapest chain of
  // all (DP over subsets); more: nearest-first from that build, then improved (reverse a stretch / move one boss) until no step makes it
  // cheaper. Equal chains are settled by boss name, so the same bosses always give the same order.
  function order(items, start) {
    items = (items || []).slice().sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const n = items.length;
    if (!n) return { keys: [], cost: 0, mode: 'exact' };
    const sigs = items.map((i) => i.sig), keysOf = (idx) => idx.map((i) => items[i].key);
    const D = sigs.map((a) => sigs.map((b) => distance(a, b))), S = sigs.map((a) => dist0(start, a));
    if (n <= EXACT_MAX) {
      const BIG = 1e6, FULL = (1 << n) - 1;
      const best = new Float64Array((FULL + 1) * n).fill(Infinity), from = new Int16Array((FULL + 1) * n).fill(-1);
      const pen = (i, pos) => i * (n - pos);                         // equal chains: the name that sorts first goes first (items are sorted by name above)
      for (let i = 0; i < n; i++) best[(1 << i) * n + i] = S[i] * BIG + pen(i, 0);
      for (let m = 1; m <= FULL; m++) {
        let pos = 0; for (let x = m; x; x &= x - 1) pos++;
        for (let l = 0; l < n; l++) {
          const cur = best[m * n + l]; if (cur === Infinity) continue;
          for (let j = 0; j < n; j++) {
            if (m & (1 << j)) continue;
            const nm = m | (1 << j), c = cur + D[l][j] * BIG + pen(j, pos);
            if (c < best[nm * n + j]) { best[nm * n + j] = c; from[nm * n + j] = l; }
          }
        }
      }
      let l = 0; for (let i = 1; i < n; i++) if (best[FULL * n + i] < best[FULL * n + l]) l = i;
      const idx = []; let m = FULL;
      while (l >= 0) { idx.push(l); const pl = from[m * n + l]; m &= ~(1 << l); l = pl; }
      idx.reverse();
      return { keys: keysOf(idx), cost: cost(start, idx.map((i) => sigs[i])), mode: 'exact' };
    }
    const left = items.map((_, i) => i), idx = []; let last = -1;
    while (left.length) {                                            // nearest-first (reduce keeps the first by name on a tie)
      const d = (i) => (last < 0 ? S[i] : D[last][i]), pick = left.reduce((a, b) => (d(b) < d(a) ? b : a));
      idx.push(pick); left.splice(left.indexOf(pick), 1); last = pick;
    }
    const len = (p) => { let c = 0; for (let i = 0; i < p.length; i++) c += i ? D[p[i - 1]][p[i]] : S[p[i]]; return c; };
    let bestLen = len(idx), improved = true, guard = 0;
    while (improved && guard++ < 50) {
      improved = false;
      for (let i = 0; i < n - 1; i++) for (let j = i + 1; j < n; j++) {                       // reverse a stretch
        const p = idx.slice(0, i).concat(idx.slice(i, j + 1).reverse(), idx.slice(j + 1)), c = len(p);
        if (c < bestLen) { idx.splice(0, n, ...p); bestLen = c; improved = true; }
      }
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {                               // move one boss elsewhere
        if (i === j) continue;
        const p = idx.slice(), x = p.splice(i, 1)[0]; p.splice(j, 0, x); const c = len(p);
        if (c < bestLen) { idx.splice(0, n, ...p); bestLen = c; improved = true; }
      }
    }
    return { keys: keysOf(idx), cost: cost(start, idx.map((i) => sigs[i])), mode: 'heuristic' };
  }
  // "Weapon, Ring + 2 pets": what changing from build a to build b touches (for the status text)
  function describe(a, b) {
    const slots = [...new Set([...Object.keys(a.gear), ...Object.keys(b.gear)])].filter((k) => nz(a.gear[k]) !== nz(b.gear[k]));
    let pets = 0; const am = new Set(a.mains);
    b.mains.forEach((m) => { if (!am.has(m)) { pets += 1 + (b.links[m] || []).filter(Boolean).length; return; } const la = a.links[m] || ['', ''], lb = b.links[m] || ['', '']; for (let i = 0; i < 2; i++) if (nz(la[i]) !== nz(lb[i])) pets++; });
    am.forEach((m) => { if (!b.mains.includes(m)) pets++; });
    const parts = [...slots.slice(0, 4), ...(slots.length > 4 ? ['+' + (slots.length - 4) + ' more'] : []), ...(pets ? [pets + ' pet' + (pets === 1 ? '' : 's')] : [])];
    return parts.join(', ');
  }
  return { sigFromSel, tagSig, anySig, distance, order, cost, describe };
})();
/* PLAN-END */

const Planner = (() => {
  const cache = new Map();                                            // boss -> { at, sel } : the engine's best selection (valid while your gear / pets did not change)
  const TTL = 15 * 60000, SEARCH_MS = 90000;
  let lastLog = '', onNow = null;                                     // onNow: the build the last pick will have equipped (used when no fresh search says what is on)
  const on = () => !!(cfg.autoBuild && cfg.autoBuild.order) && Presets.available('best');
  const reset = () => { cache.clear(); lastLog = ''; onNow = null; };
  const crystalNow = () => { const c = Presets.applied().crystal; return c ? String(c).split('@')[0] : null; };
  // -> { sig, cur }   cur = the live selection (from the same search), for the starting point
  const ckey = (t) => t.low + ':' + (t.monsterId != null ? t.monsterId : '');            // a dungeon swarm is many mobs with one name: one search per kind of mob
  async function sigFor(t) {
    const w = Presets.wanted(t.low, t), crystal = w.crystal != null && w.crystal !== '__best' ? w.crystal : null;   // auto crystals follow the gear: the gear distance already counts them
    if (w.best) {
      let hit = cache.get(ckey(t)), cur = null;
      if (!hit || Date.now() - hit.at > TTL) {
        let r = null; const mob = await Presets.engineMob(t);
        try { r = mob ? await withTimeout(Promise.resolve(Core.call('build.best', mob, { mode: OPT_MODE })), SEARCH_MS, null) : null; } catch (_) { r = null; }
        if (r && r.ok !== false && r.best && r.best.sel) { hit = { at: Date.now(), sel: r.best.sel }; cache.set(ckey(t), hit); cur = r.current && r.current.sel; }
        else hit = null;
      }
      if (hit) return { sig: Plan.sigFromSel(hit.sel, crystal), cur };
      return { sig: Plan.tagSig('unknown:' + t.low, crystal), cur: null };              // no answer from the engine: treated as a full switch
    }
    if (w.gear || w.pet) return { sig: Plan.tagSig('gear:' + (w.gear || '-') + '/pet:' + (w.pet || '-'), crystal), cur: null };
    return { sig: Plan.anySig(crystal), cur: null };                                     // keep-equipped: costs nothing wherever it runs
  }
  // list = candidates(). Returns the boss to fight next (the one that is cheapest to reach from the build that is on). Never throws: on any trouble it is list[0], the old behaviour.
  async function pick(list, curLow) {
    if (!on() || list.length < 2) return list[0];
    const keep = curLow ? list.find((t) => t.low === curLow) : null;
    if (keep) return keep;                                                              // finish the boss you are on: leaving it is a build change too
    try {
      // Every boss that has no fresh search yet costs one Build Engine search (up to a minute or two each, one after another: the engine does
      // one at a time). Searches are kept for 15 min, so the next pick is instant. The status shows which boss is being searched.
      const seenK = new Set(), stale = list.filter((t) => { const k = ckey(t); if (seenK.has(k) || !Presets.wanted(t.low, t).best || (cache.get(k) || {}).at > Date.now() - TTL) return false; seenK.add(k); return true; });
      if (stale.length) { log(`🧭 planning the order for ${list.length} bosses (${stale.length} to search)…`, 'info'); await Promise.all(stale.map((t) => Presets.engineMob(t).catch(() => null))); }
      const label = (t) => (t.name || t.low).split(/[ ,]/)[0], names = stale.map((t, i) => `${label(t)} (${i + 1}/${stale.length})`);
      Prog.start('Planning the build order', names, 'PLANNING');
      // Bosses that need the very same build are ONE stop (15 Gribbles = one build, fought back to back), so the order is a real shortest chain
      // over the different builds only, and equal builds always sit together. Within a stop: by name.
      const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.keys(v).sort().reduce((o, k) => { o[k] = canon(v[k]); return o; }, {}) : v);
      const groups = new Map(), wild = []; let fresh = null;
      for (const t of list) {
        const si = stale.indexOf(t); if (si >= 0) Prog.at(names[si]);
        const r = await sigFor(t);
        if (r.cur && !fresh) fresh = Plan.sigFromSel(r.cur, crystalNow());
        if (r.sig.any) { wild.push(t); continue; }
        const fp = JSON.stringify(canon(r.sig)); if (!groups.has(fp)) groups.set(fp, { sig: r.sig, ts: [], fp }); groups.get(fp).ts.push(t);
      }
      const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : String(a.instanceId || '').localeCompare(String(b.instanceId || ''), undefined, { numeric: true }) || (a.monsterId > b.monsterId ? 1 : a.monsterId < b.monsterId ? -1 : 0));
      const gl = [...groups.values()]; gl.forEach((g) => { g.ts.sort(byName); g.key = (g.ts[0].name || g.ts[0].low) + '|' + g.fp; });
      const start = fresh || onNow;
      const res = Plan.order(gl.map((g) => ({ key: g.key, sig: g.sig })), start);
      const byKey = new Map(gl.map((g) => [g.key, g]));
      const stops = res.keys.map((k) => byKey.get(k)).filter(Boolean);
      const seq = wild.slice().sort(byName).concat(...stops.map((g) => g.ts));
      // "Gribbles ×15 → Oceanus": the same boss in a row is one entry
      const parts = []; seq.forEach((t) => { const n = label(t), l = parts[parts.length - 1]; if (l && l.n === n) l.c++; else parts.push({ n, c: 1 }); });
      const line = parts.map((x) => (x.c > 1 ? `${x.n} ×${x.c}` : x.n)).join(' → ') + ` (${res.cost} change${res.cost === 1 ? '' : 's'}${res.mode === 'heuristic' ? ', nearest-first' : ''})`;
      if (line !== lastLog) { lastLog = line; log('🧭 build order: ' + esc(line), 'ok'); }
      const first = seq[0] || list[0], fg = stops.find((g) => g.ts.includes(first));
      if (fg) onNow = fg.sig;                                                              // the engine is about to put this build on
      return first;
    } catch (e) { log('⚠️ build planner: ' + esc((e && e.message) || String(e)) + ' — using your order', 'warn'); return list[0]; }
    finally { Prog.end(); }
  }
  return { on, pick, reset };
})();

/* ---- side-mob / shielded-boss support (TOGGLE in Settings, off by default: it should not be needed) --------------------
 * A shielded boss rejects the class skill ("divine shield" / "couldn't pierce"). With the toggle on this is fully automatic:
 * we remember the boss is shielded and cast ONLY the class skill on a live regular mob (never a boss): first one in an open
 * normal dungeon (Shadowbridge), else one on the boss's wave page. The damage attack always goes to the real boss.
 * No per-boss setting, no picker.
 */
const SideMob = (() => {
  const shStore = Core.store(ID + '-shielded', { def: [] });
  const shielded = new Set(shStore.get() || []);
  const saveSh = () => { let a = [...shielded]; if (a.length > 300) { a = a.slice(-300); shielded.clear(); a.forEach((k) => shielded.add(k)); } shStore.set(a); };
  const SHIELD_RE = /divine shield|couldn'?t pierce|cannot pierce/i;
  const isShieldMsg = (m) => SHIELD_RE.test(String(m == null ? '' : m));
  const keyOf = (t) => (t.kind || 'wave') + ':' + t.monsterId + (t.instanceId ? ':' + t.instanceId : '');
  const modeOf = () => 'auto';                                      // always: divert once the server says the boss is shielded
  const eligible = (t) => !!cfg.sideMob.enabled && modeOf(t.low) !== 'normal';
  const isShielded = (t) => shielded.has(keyOf(t));
  const mark = (t) => { const k = keyOf(t); if (!shielded.has(k)) { shielded.add(k); saveSh(); } };
  let cache = null; const joined = new Map();

  async function waveMob(t) {
    const loc = bossLoc(t.low); if (!loc) return null;
    let html; try { html = await Lane.run(() => Core.net.fetchText(`/active_wave.php?gate=${loc.gate}&wave=${loc.wave}`, { ttl: 15000, key: `ma:wave:${loc.gate}:${loc.wave}`, via: (run) => Core.cookies.withMode('alive', run) })); } catch (_) { return null; }
    const doc = parseHtml(html); if (Guard.pageState(doc) !== 'ok') return null;
    for (const card of doc.querySelectorAll('.monster-container .monster-card, .monster-card')) {
      if (!Scan.cardAlive(card)) continue;
      const id = Scan.cardId(card); if (!id || String(id) === String(t.monsterId)) continue;
      const name = (card.dataset.name || '').trim().toLowerCase();
      if (!name || Roster.get(name)) continue;                          // never a boss
      const mob = { kind: 'wave', monsterId: String(id), name: card.dataset.name || 'wave mob', low: name };
      if (!shielded.has(keyOf(mob))) return mob;
    }
    return null;
  }
  async function find(t) {
    const now = Date.now();
    if (cache && cache.exp > now && keyOf(cache.mob) !== keyOf(t) && !shielded.has(keyOf(cache.mob))) return cache.mob;
    let mob = null;
    try { if (Dungeons.sideMobs) mob = await Dungeons.sideMobs(keyOf(t), shielded); } catch (_) { /* fall back to a wave mob */ }
    if (!mob) { mob = await waveMob(t); if (mob) log(`🌊 no dungeon mob for the pierce — using wave mob ${esc(mob.name)}`, 'info'); }
    if (mob) cache = { mob, exp: now + 30000 };
    else log('⚠️ no usable side mob (all dungeon / wave mobs empty, shielded or locked)', 'warn');
    return mob;
  }
  const forgetCache = () => { cache = null; };
  const targetFields = (m) => (m.kind === 'dungeon' ? { dgmid: m.monsterId, instance_id: m.instanceId, location_id: m.locationId } : { monster_id: m.monsterId });
  // a side mob must be joined before it takes a cast (kept for 60 s; rejoin after an inactivity kick)
  async function join(m, force) {
    const k = keyOf(m);
    if (!force && (joined.get(k) || 0) > Date.now()) return true;
    const u = uid(); if (!u) return false;
    const r = await Act.run(() => postForm(m.kind === 'dungeon' ? '/dungeon_join_battle.php' : '/user_join_battle.php',
      m.kind === 'dungeon' ? { dgmid: m.monsterId, instance_id: m.instanceId, user_id: u, location_id: m.locationId } : { monster_id: m.monsterId, user_id: u }), cfg.minActionGapMs);
    if (r.ok) joined.set(k, Date.now() + 60000);
    return r.ok;
  }
  const isRejoin = (m) => /removed due to inactivity|rejoin the battle/i.test(String(m || ''));
  return { isShieldMsg, eligible, isShielded, mark, find, forgetCache, join, isRejoin, targetFields, keyOf, modeOf, shielded: () => shielded.size, forget: () => { shielded.clear(); saveSh(); cache = null; } };
})();

/* ---- the attack engine -------------------------------------------------------------------------------------------
 * One loop, owned by the MAIN tab. Every pass: (1) scan whatever is due (wave pages are scanned WHILE fighting too, so a second
 * spawn never waits for the first), (2) pick the first alive + uncapped target in priority order, (3) one swing.
 * A swing is join -> class skill -> attack, exactly the 3.0.0 request shapes. Every failure has a reason and a wait; a rejected
 * reply is never retried instantly.
 */
const Engine = (() => {
  let token = 0, loopRunning = false, forceScan = true, current = null, curLow = '', idleSince = 0, wake = false, idleRestoreAt = 0;
  let skillOffUntil = 0, stallLogAt = 0, lastFightAt = 0;
  const skip = new Map(), fails = new Map(), capLogged = new Set();
  const live = (tk) => tk === token && Run.active();
  async function sleepLive(tk, ms) {
    const end = Date.now() + ms;
    while (live(tk) && !wake && Date.now() < end) await sleep(Math.min(500, Math.max(0, end - Date.now())));
    wake = false;
  }
  const tfields = (t) => (t.kind === 'dungeon' ? { dgmid: t.monsterId, instance_id: t.instanceId, location_id: t.locationId } : { monster_id: t.monsterId });
  // ---- build change in progress (Core.tx 'loadout') -------------------------------------------------------------------
  // While gear / pets / crystals are being rewritten (a human preset click, another tab, the Build Engine) no join, skill or attack is
  // sent: the swing would hit a half-built loadout. Our own Presets.ensure runs between swings, so it never waits on itself.
  // Without Core.tx (older Core) there is nothing to wait for. The wait is time-boxed; after that the request is not sent and the
  // normal failure path (wait, retry) takes over.
  const BUILD_WAIT_MS = 180000;
  const buildBusy = () => { try { return Core.tx && typeof Core.tx.busy === 'function' ? Core.tx.busy('loadout') : null; } catch (_) { return null; } };
  let buildWake = null;
  if (typeof Core.on === 'function') Core.on('loadout:end', () => { if (buildWake) buildWake(); });
  async function holdForBuild(tk) {
    if (!buildBusy()) return true;
    const b = buildBusy();
    log('⏸ build change in progress, waiting' + (b && b.owner && b.owner !== 'unknown' ? ' (' + esc(b.owner) + ')' : ''), 'info'); Diag.skip('build-change', 'a gear / pet / crystal change is running');
    const end = Date.now() + BUILD_WAIT_MS;
    while (live(tk) && buildBusy()) {
      if (Date.now() >= end) { log('⚠️ build change still running after ' + Math.round(BUILD_WAIT_MS / 60000) + ' min — not swinging', 'warn'); return false; }
      await new Promise((res) => { const to = setTimeout(res, 750); buildWake = () => { clearTimeout(to); res(); }; });   // woken by loadout:end, else a short poll
      buildWake = null;
    }
    return live(tk);
  }
  const HELD = { ok: false, status: 0, text: '', json: null, held: true };       // what act() answers when the build never settled
  const act = (t, fn, gap) => { const tk = token; return Act.run(async () => ((await holdForBuild(tk)) ? fn() : HELD), t.kind === 'dungeon' ? 0 : gap); };
  const remPct = (cap, dealt) => (cap > 0 ? (Math.max(0, cap - dealt) / cap * 100).toFixed(1) : '0');
  let lastWarn = { msg: '', at: 0 };
  const warnOnce = (msg) => { if (lastWarn.msg !== msg || Date.now() - lastWarn.at > 30000) { lastWarn = { msg, at: Date.now() }; log(msg, 'warn'); } };

  // one cast of the class skill (optionally redirected to a side mob). Returns { used, total (of the cast target), shield, stop }
  async function castSkill(t, cs, tk, target) {
    const r = await act(t, () => postForm('/damage.php', Object.assign(SideMob.targetFields(target), { skill_id: cs.id, stamina_cost: 1 })), cfg.minActionGapMs);
    if (!live(tk)) return { stop: true };
    const j = r.json || {}, msg = String(j.message || j.error || '');
    if (j.status === 'success' || j.totaldmgdealt !== undefined) {
      const mana = j.mana !== undefined ? j.mana : j.mp; Me.mp = mana !== undefined && mana !== null ? parseNum(mana) : Math.max(0, Me.mp - cs.cost);
      try { Core.me.fromAttack(j); } catch (_) { /* */ }
      return { used: true, total: parseNum(j.totaldmgdealt, NaN) };
    }
    return { used: false, msg, cr: classifyReject(msg || JSON.stringify(j)), r };
  }

  // "Your damage" minus "Phase DMG" on the boss's own page = what was dealt before this phase (0 for phase 1, or when the page has no Phase DMG chip)
  async function phaseBase(t) {
    const def = Roster.get(t.low), e = Board.get(t.low);
    if (!e || !def || def.kind !== 'wave' || Roster.members(def).indexOf(def) < 1) return 0;
    if (Board.baseKnown(t.low)) return Board.base(t.low);
    try {
      const html = await Core.net.fetchText(t.kind === 'dungeon' ? `/battle.php?dgmid=${encodeURIComponent(t.monsterId)}&instance_id=${encodeURIComponent(t.instanceId)}` : `/battle.php?id=${encodeURIComponent(t.monsterId)}`, { force: true, ttl: 0 });
      if (Guard.pageState(html) !== 'ok') return 0;
      const doc = parseHtml(html), el = doc.getElementById('yourDamageValue'), chip = Array.from(doc.querySelectorAll('.chip')).find((c) => /^phase dmg/i.test((c.textContent || '').trim()));
      const mine = el ? parseNum(el.textContent, null) : null, ph = chip ? parseNum(chip.textContent.replace(/^[^:]*:/, ''), null) : null;
      if (mine == null || (chip && (ph == null || ph > mine))) return 0;               // unreadable: try again next swing
      const base = chip ? mine - ph : 0;
      Board.patch(t.low, { phBase: base, phBaseFor: String(t.monsterId) });
      if (base > 0) log(`📐 ${esc(t.name)}: ${fmtNum(base)} was dealt before this phase, so its cap counts only damage from here`, 'info');
      return base;
    } catch (_) { return 0; }
  }

  async function swing(t, tk) {
    const raw = bossCap(t.low), cap = raw + await phaseBase(t); let cur = Board.dealt(t);
    if (!(raw > 0) || cur >= cap) return { ok: false, reason: 'capped' };
    const userId = uid();
    if (!userId) return { ok: false, reason: 'auth' };

    // 1) JOIN (every swing, like 3.0.0)
    const jr = await act(t, () => postForm(t.kind === 'dungeon' ? '/dungeon_join_battle.php' : '/user_join_battle.php',
      t.kind === 'dungeon' ? { dgmid: t.monsterId, instance_id: t.instanceId, location_id: t.locationId } : { monster_id: t.monsterId, user_id: userId }), cfg.minActionGapMs);
    if (!live(tk)) return { ok: false, reason: 'halt' };
    if (jr.text && /invalid monster|already dead/i.test(jr.text)) return { ok: false, reason: 'dead' };
    if (jr.status === 0) warnOnce('⚠️ join request failed: ' + esc(jr.text));

    // 2) CLASS SKILL (optional bonus hit; mana is refilled first when it is low)
    if (!Me.stamKnown()) { try { await Core.me.sync(); } catch (_) { /* */ } }
    const cls = cfg.useClassSkill ? effectiveClass() : null, cs = cls ? CLASS_SKILLS[cls] : null;
    const wb = pickTier(t.low, Math.max(0, cap - cur), cfg.maxTier, Me.stam()) === 'WORLD_BREAKER';   // the class skill is only cast before World Breaker
    let skillUsed = false;
    if (cs && wb && Date.now() >= skillOffUntil) {
      if (Me.mpKnown && (Me.mp <= cfg.mana.threshold || Me.mp < cs.cost)) await Potions.refillMana('auto', cs.cost);
      if (!live(tk)) return { ok: false, reason: 'halt' };
      if (Me.mp >= cs.cost || !Me.mpKnown) {
        const eligible = SideMob.eligible(t);
        let target = t, side = null;
        if (eligible && (SideMob.modeOf(t.low) === 'shielded' || SideMob.isShielded(t))) {
          side = await SideMob.find(t);
          if (side) { target = side; log(`🛡→🐀 ${esc(t.name)} shielded — casting ${cs.label} on side mob ${esc(side.name)} #${esc(side.monsterId)}`, 'skill'); }
          else if (SideMob.modeOf(t.low) === 'shielded') warnOnce(`🛡 ${esc(t.name)}: targeting is "shielded" but no side mob was found — casting on the boss`);
        }
        for (let attempt = 1; attempt <= 2 && live(tk); attempt++) {
          if (side && !(await SideMob.join(side, false))) { side = null; target = t; }
          const c = await castSkill(t, cs, tk, target);
          if (c.stop) return { ok: false, reason: 'halt' };
          if (c.used) {
            if (!side && c.total > cur) { cur = c.total; Board.confirm(t, c.total); }
            log(`🔮 ${cs.label} → ${side ? 'side mob ' + esc(side.name) : esc(t.name)}`, 'skill'); skillUsed = true; break;
          }
          if (SideMob.isShieldMsg(c.msg)) {
            if (!side) {
              SideMob.mark(t);
              if (eligible) { side = await SideMob.find(t); if (side) { target = side; log(`🛡 ${esc(t.name)} shielded — diverting ${cs.label} to ${esc(side.name)}`, 'skill'); continue; } }
              warnOnce(`🛡 ${esc(t.name)} shielded — no side mob to pierce with`); break;
            }
            SideMob.mark(side); SideMob.forgetCache(); side = await SideMob.find(t);
            if (side) { target = side; continue; }
            warnOnce(`🛡 no unshielded side mob left for ${esc(t.name)}`); break;
          }
          if (side && SideMob.isRejoin(c.msg)) { await SideMob.join(side, true); continue; }
          if (c.cr.reason === 'cooldown') { await sleepLive(tk, cfg.skillToAttackGapMs); continue; }
          if (c.cr.reason === 'mp') { skillOffUntil = Date.now() + 30000; Diag.skip('skill-no-mana', 'class skill paused 30s'); break; }
          if (c.cr.reason === 'duel-phase' || c.cr.reason === 'dead' || c.cr.reason === 'player-dead') return Object.assign({ ok: false }, c.cr);
          break;
        }
      } else Diag.skip('skill-skipped-low-mp', `${Me.mp}/${cs.cost}`);
    }
    const attackGap = skillUsed ? cfg.skillToAttackGapMs : (cs && wb ? 600 : 120);

    // 3) ATTACK (tier downgrade until the estimated hit fits what is left under the cap and the stamina on hand)
    if (!Me.stamKnown()) { try { await Core.me.sync(); } catch (_) { /* */ } }
    let tier = pickTier(t.low, Math.max(0, cap - cur), cfg.maxTier, Me.stam());
    for (let attempt = 1; attempt <= 3 && live(tk); attempt++) {
      if (Me.stam() < SKILLS[tier].cost) {
        if (!(await Potions.refillStamina())) return { ok: false, reason: 'stam' };
        tier = pickTier(t.low, Math.max(0, cap - cur), cfg.maxTier, Me.stam());
      }
      const pre = cur;
      const r = await act(t, () => postForm('/damage.php', Object.assign(tfields(t), { skill_id: SKILLS[tier].id, stamina_cost: SKILLS[tier].cost })), attackGap);
      if (!live(tk)) return { ok: false, reason: 'halt' };
      const j = r.json || {};
      if (j.status === 'success' || j.totaldmgdealt !== undefined) {
        const raw = parseNum(j.damage, 0), total = Number.isFinite(parseNum(j.totaldmgdealt, NaN)) && j.totaldmgdealt !== undefined ? parseNum(j.totaldmgdealt) : pre + raw;
        const perHit = total > pre ? total - pre : raw;          // the confirmed delta, not j.damage (it has reported 0 while the total climbed)
        DmgProfile.record(t.low, tier, perHit);
        stats.hits++; stats.dmg += perHit;
        Me.fromAttack(j);
        Board.confirm(t, total); cur = Math.max(cur, total);
        fails.delete(targetKey(t));
        log(`${skillUsed ? '🔮 ' + (cs ? cs.label : 'skill') + ' + ' : ''}⚔️ ${esc(t.name)} · ${SKILLS[tier].label} · hit ${fmtNum(perHit)} · total ${fmtNum(total)} · rem ${remPct(cap, cur)}%`, 'dmg');
        UI.dirty('status');
        return { ok: true, perHit, total, tier };
      }
      const msg = String(j.message || j.error || (r.status === 0 ? r.text : '') || JSON.stringify(j));
      const cr = classifyReject(msg);
      if (SideMob.isShieldMsg(msg)) {
        SideMob.mark(t);
        if (cs && SideMob.eligible(t)) {
          const side = await SideMob.find(t);
          if (side && (await SideMob.join(side, false))) {
            const c = await castSkill(t, cs, tk, side);
            if (c.stop) return { ok: false, reason: 'halt' };
            if (c.used) { log(`🛡→🐀 buffed via side mob ${esc(side.name)} — retrying ${SKILLS[tier].label} on ${esc(t.name)}`, 'skill'); await sleepLive(tk, 250); attempt--; continue; }
            if (SideMob.isShieldMsg(c.msg)) { SideMob.mark(side); SideMob.forgetCache(); }
          }
        }
        warnOnce(`🛡 ${esc(t.name)} blocked — the shield was not pierced`);
        return { ok: false, reason: 'shielded', backoffMs: 3000 };
      }
      if (cr.reason === 'stam') {                                   // our stamina number was stale: ask the server, then re-pick
        try { await Core.me.sync(); } catch (_) { /* */ }
        const t2 = pickTier(t.low, Math.max(0, cap - cur), cfg.maxTier, Me.stam());
        if (t2 === tier && Me.stam() < SKILLS[tier].cost) { if (!(await Potions.refillStamina())) return { ok: false, reason: 'stam' }; }
        tier = pickTier(t.low, Math.max(0, cap - cur), cfg.maxTier, Me.stam()); continue;
      }
      if (cr.reason === 'cooldown') { if (attempt < 3) { await sleepLive(tk, cr.backoffMs); continue; } return Object.assign({ ok: false }, cr); }
      if (cr.reason === 'dead' || cr.reason === 'player-dead' || cr.reason === 'duel-phase') return Object.assign({ ok: false }, cr);
      if (r.status === 0) { if (attempt < 3) { await sleepLive(tk, 500); continue; } return { ok: false, reason: 'net', backoffMs: 800, detail: r.text }; }
      return { ok: false, reason: cr.reason, backoffMs: cr.backoffMs || 800, detail: msg };
    }
    return { ok: false, reason: 'unknown', backoffMs: 800 };
  }

  async function onReject(t, res, tk) {
    const low = t.low, loc = bossLoc(low);
    switch (res.reason) {
      case 'halt': return;
      case 'capped': {
        const k = targetKey(t);
        if (!capLogged.has(k)) { capLogged.add(k); if (capLogged.size > 400) capLogged.clear(); log(`✅ ${esc(t.name)} capped (${fmtNum(Math.max(0, Board.dealt(t) - Board.base(low)))}/${fmtNum(bossCap(low))})`, 'ok'); }
        if (t.swarm) Board.dropSwarm(t);
        return;
      }
      case 'dead':
        log(`⏭️ ${esc(t.name)} is dead`, 'info');
        if (t.swarm) Board.dropSwarm(t); else Board.patch(low, { alive: false });
        if (t.kind === 'wave' && loc) await Lane.run(() => Scan.page(loc.gate, loc.wave));     // the page knows the respawn time
        else if (t.kind === 'dungeon') await Dungeons.refresh([low]);
        return;
      case 'auth': Guard.fault('signedout', 'no login cookie'); return;
      case 'player-dead': {
        Me.hp = 0; UI.dirty('status');
        if (!(await Potions.heal('player reported dead'))) { Run.stop('dead with no usable HP potion'); return; }
        await sleepLive(tk, 700); return;
      }
      case 'stam': {
        try { await Loot.onStamStall(); } catch (e) { log('⚠️ stamina-stall loot: ' + e.message, 'warn'); }
        try { await Core.me.sync(); } catch (_) { /* */ }
        if (Me.stam() >= SKILLS.SLASH.cost) return;                  // a level-up from loot refilled it: never really stalled
        // stamina only comes back on the hour (Core.me.secondsToTick): wait for that, not for a request every 2.5 s
        const secs = (() => { try { return Core.me.secondsToTick(); } catch (_) { return 60; } })();
        const wait = Math.min(60000, Math.max(5000, secs * 1000 + 1500));
        Status.set('NO STAMINA');
        if (Date.now() - stallLogAt > 600000) { stallLogAt = Date.now(); log(`⏳ out of stamina (${Me.stam()}/${Me.maxStam()}) and no potion — waiting for the next regen (${fmtDur(secs * 1000)})`, 'warn'); }
        Diag.skip('no-stamina', `${Me.stam()}/${Me.maxStam()} — regen in ${fmtDur(secs * 1000)}`);
        await sleepLive(tk, wait); return;
      }
      case 'duel-phase': {
        log(`⚔️ ${esc(t.name)} requires a Phase Duel`, 'warn');
        const now = Date.now();
        Board.patch(low, { needsDuel: true, needsDuelAt: now, duelRetryAt: now + 60000 });
        if (cfg.autoDuel && Kernel.isOn('duels') && Duels.fight) {
          Status.set('DUEL');
          const won = await Duels.fight(t, () => live(tk));
          if (won === null) return;                                  // halted / not possible: the retry timer holds it back
          if (won) { Board.patch(low, { needsDuel: false, duelRetryAt: 0 }); log(`✅ Phase Duel for ${esc(t.name)} won — resuming`, 'ok'); try { await Scan.one(low); } catch (_) { /* the next regular scan finds the new phase */ } }   // only this boss's page: the new phase shows up there, the other waves did not change
          else log(`⚠️ Phase Duel for ${esc(t.name)} not won — retrying in 60s`, 'warn');
        } else Diag.skip('duel-needed', `${t.name}: auto-duel is off`);
        return;
      }
      case 'shielded': await sleepLive(tk, res.backoffMs || 3000); return;
      default: {                                                      // unknown / net / mp / cooldown that ran out: log ONCE, then wait
        const k = targetKey(t), n = (fails.get(k) || 0) + 1; fails.set(k, n);
        warnOnce(`⚠️ ${esc(t.name)}: ${res.reason}${res.detail ? ' — ' + esc(String(res.detail).slice(0, 140)) : ''} (try ${n})`);
        Diag.skip('attack-' + res.reason, `${t.name}: ${String(res.detail || '').slice(0, 100)}`);
        if (n >= 4) { skip.set(k, Date.now() + 60000); fails.delete(k); log(`⏸️ ${esc(t.name)} skipped for 60s after ${n} failed swings`, 'warn'); }
        await sleepLive(tk, Math.max(res.backoffMs || 0, 800));
      }
    }
  }

  async function loop(tk) {
    Status.set('RUNNING'); Work.set('scan', 'Loading your stats…');
    await Promise.all([withTimeout(Core.me.sync().catch(() => {}), 10000), withTimeout(Me.refresh(0).catch(() => {}), 10000)]);   // bounded: a slow reply can no longer park the start
    Work.clear('scan');
    if (!cfg.detectedClass) detectClass().catch(() => {});
    while (live(tk)) {
      try {
        if (Guard.isFaulted()) { await sleepLive(tk, 2000); continue; }
        if (Lane.busy()) { await sleepLive(tk, 500); continue; }          // the graveyard scan has the site's cookie mode: wait for it
        Relics.refresh(); if (forceScan || Scan.anyDue()) { const f = forceScan; forceScan = false; if (f) Status.set('SCANNING'); await Scan.run(f); if (!live(tk)) break; }
        const now = Date.now();
        const list = candidates().filter((t) => !((skip.get(targetKey(t)) || 0) > now));
        if (!list.length) {
          current = null; curLow = '';
          if (!idleSince) idleSince = now;
          Status.set('WAITING');
          Diag.skip('no-target', `${cfg.targets.length} selected — none alive and under its cap`);
          if (now - idleSince > 15000) await AF.resumeIfWePaused('nothing to fight');
          if (now - idleSince > 20000 && now - idleRestoreAt > 300000 && Tab.isMain() && Presets.origin.get()) {   // nothing queued and nothing in action: your own build goes back (a failed try waits 5 min)
            idleRestoreAt = now; await Presets.restore('nothing to fight'); if (!live(tk)) break;
          }
          const next = Scan.nextDueIn();
          await sleepLive(tk, Math.min(5000, Math.max(500, Number.isFinite(next) ? next : 5000)));
          continue;
        }
        idleSince = 0;
        const t = await Planner.pick(list, curLow);
        if (!live(tk)) break;
        if (t.low !== curLow) {
          current = t; curLow = t.low;
          log(`🎯 target: ${esc(t.name)} (cap ${fmtNum(t.cap)}, dealt ${fmtNum(t.userDmg)})`, 'ok'); Relics.warn(t);
          try { Core.emit('automator:target', { name: t.name, low: t.low, kind: t.kind, cap: t.cap }); } catch (_) { /* */ }
          await Presets.ensure(t.low, t);
          if (!live(tk)) break;
        } else current = t;
        Status.set('FIGHTING');
        await AF.pauseIfNeeded();
        await Me.refresh(15000);
        if (Potions.hpTrip()) await Potions.heal(`HP ${Me.hp}/${Me.maxHp}`);
        stats.cycles++; lastFightAt = Date.now();
        const res = await swing(t, tk);
        if (!live(tk)) break;
        if (res.ok) {
          const gap = t.kind === 'dungeon' ? cfg.dungeonAttackDelayMs : cfg.attackDelayMs;
          if (gap > 0) await sleepLive(tk, gap);
        } else await onReject(t, res, tk);
      } catch (e) {
        log(`❌ engine error: ${e.message} — continuing in 5s`, 'err'); Diag.skip('engine-error', e.message);
        await sleepLive(tk, 5000);
      }
    }
    if (tk === token) loopRunning = false;
  }

  function start(force) {
    if (force) forceScan = true;
    if (loopRunning || !Run.active() || isDuelPage()) { poke(); return; }
    loopRunning = true; token++; idleSince = 0;
    loop(token).catch((e) => { log('❌ engine stopped: ' + e.message, 'err'); loopRunning = false; });
  }
  function halt() { token++; loopRunning = false; current = null; curLow = ''; wake = true; }
  function poke(force) { if (force) forceScan = true; wake = true; }
  return { start, halt, poke, current: () => current, isLooping: () => loopRunning, scanNow: () => poke(true), clearSkips: () => { skip.clear(); fails.clear(); } };
})();

/* ===================================================================================================================
 * PART 2 — DUNGEONS (swappable: switch the part off, or delete this block, and the wave bosses keep working)
 * Castle of the Fallen Prince bosses (+ Khaal's second phase), the Shadowbridge Gribble swarm, mobs for the shield pierce,
 * and the dungeon pages the graveyard reads. NOT the cube / Polyhedral Crucible: Cube Suite owns it completely.
 * ================================================================================================================ */
const SHADOW_TERR = {
  1: { name: 'Brood Pits', mobs: ['Krak One-Horn', 'Nib Wickfingers', 'Orc Stone-Rend', 'Skrit Gear', 'Vorga Ash-Shaman'] },
  2: { name: 'Plunder Warrens', mobs: ['Gribble Junk-Magus', 'Makra the Mireborn', 'Shagra Bone-Singer', 'Talla Flint-Stem', 'Urzul Iron-Tusks'] },
  3: { name: 'Shattered Stone Causeways', mobs: ['Droknar Night-Blade', 'Hruk Forge-Eater', 'Pip Tanglefoot', 'Rukka The Wolf Raider', 'Zorgra Frost-Vein'] },
  4: { name: 'Territory Center', mobs: ['Brog Skull', 'Gorvash the Stone-Ram', 'Gribble Junk-Magus', 'Rukka The Wolf Raider', 'Tharka Blood-Howl'] },
};
const SHADOW_BOSS_LOC = 5, SHADOW_LOCS = [1, 2, 3, 4, SHADOW_BOSS_LOC];
// The other Shadowbridge mob types, one entry per NAME (a mob seen in two territories is one entry that covers both). Not loaded unless
// "Show all mobs" is on (cfg.shadowAll) or the entry is ticked: the Gribbles and the boss are the Shadowbridge list.
const shadowExtras = (() => {
  const by = new Map();
  Object.entries(SHADOW_TERR).forEach(([loc, t]) => t.mobs.forEach((m) => { if (/gribble/i.test(m)) return; const e = by.get(m) || { mob: m, locs: [], terr: [] }; e.locs.push(+loc); e.terr.push(t.name); by.set(m, e); }));
  return [...by.values()];
})();
function setShadowExtras(on) {
  shadowExtras.forEach((e) => {
    const name = e.mob, low = name.toLowerCase();
    if (on || cfg.targets.includes(low)) {
      if (!Roster.get(low)) Roster.add({ name, defaultCap: 1e6, kind: 'dungeon-swarm', dtype: 'easy', extra: true, locationId: e.locs[0], locationIds: e.locs, terr: e.terr.join(' + '),
        swarmMatch: new RegExp('^\\s*' + e.mob.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'i') });
    } else if (Roster.get(low)) Roster.remove(low);
  });
}
(function seedDungeonRoster() {
  [
    { name: 'The Goblin Royal Vizier', defaultCap: 2e9, kind: 'dungeon', locationId: 6, dtype: 'hard' },
    { name: 'Vorrak the Bloodbound Berserker', defaultCap: 2e9, kind: 'dungeon', locationId: 7, dtype: 'hard' },
    { name: 'Grimgrowl the Chimera', defaultCap: 2e9, kind: 'dungeon', locationId: 8, dtype: 'hard' },
    { name: 'Drazhul The Broken Crown', defaultCap: 2e9, kind: 'dungeon', locationId: 9, dtype: 'hard' },
    { name: 'Khaal The Abomination Prince', defaultCap: 3e9, kind: 'dungeon', locationId: 10, dtype: 'hard', mapGated: true },
    { name: 'Gribbles', defaultCap: 1e6, kind: 'dungeon-swarm', dtype: 'easy', locationIds: [2, 4], swarmMatch: /gribble/i },
    { name: 'Prince Grixkar The Hybrid', defaultCap: 3e9, kind: 'dungeon', locationId: 5, dtype: 'easy', mapGated: true },
  ].forEach((d) => Roster.add(d));
  const khaal = Roster.get('khaal the abomination prince');
  if (khaal) Roster.addPhase(khaal, 'Khaal Sovereign of the Shattered Bloodline', 2e9);
})();

setShadowExtras(!!cfg.shadowAll);

Object.assign(Dungeons, (() => {
  const LIST = '/guild_dungeon.php', LOC = '/guild_dungeon_location.php';
  const typeOfTitle = (t) => { t = String(t || '').toLowerCase(); return t.includes('shadowbridge') ? 'easy' : t.includes('castle') ? 'hard' : t.includes('crucible') ? 'crucible' : ''; };
  const pillTexts = (el) => Array.from(el.querySelectorAll('.pill')).map((p) => (p.textContent || '').trim().toLowerCase());
  function monName(card) {
    const el = card.querySelector('div[style*="font-weight:700"]');
    if (!el) return (card.getAttribute('data-name') || '').trim();
    const c = el.cloneNode(true); c.querySelectorAll('.pill').forEach((x) => x.remove()); return c.textContent.trim();
  }
  function dgmidOf(card) {
    const a = card.querySelector('a.btn[href*="battle.php"]') || card.querySelector('a[href*="battle.php"]') || card.querySelector('a[href*="dgmid="]');
    if (!a) return '';
    try { return new URL(a.getAttribute('href'), BASE).searchParams.get('dgmid') || ''; } catch (_) { return ''; }
  }
  const iconOf = (card) => { const i = card.querySelector('img'); if (!i) return undefined; try { return new URL(i.getAttribute('src'), BASE).href; } catch (_) { return undefined; } };
  function expPerDmg(card) {
    for (const sp of card.querySelectorAll('.statpill')) {
      if (((sp.querySelector('.k') || {}).textContent || '').trim().toLowerCase() === 'exp/dmg') { const v = parseFloat(((sp.querySelector('.v') || {}).textContent || '').trim()); return Number.isFinite(v) ? v : null; }
    }
    return null;
  }
  async function pool(items, fn, n) {
    const out = new Array(items.length); let i = 0;
    await Promise.all(Array.from({ length: Math.min(n || 4, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
    return out;
  }
  // fetch + validate. null = fetch failed; { doc: null, state } = login / maintenance page (Guard already stopped the run)
  async function getDoc(url, ttl, key) {
    let html;
    try { html = await Core.net.fetchText(url, { ttl, key: key || 'ma:' + url }); } catch (e) { Diag.skip('dungeon-fetch-failed', url + ' ' + e.message); return null; }
    const st = Guard.pageState(html); if (st !== 'ok') { Guard.fault(st, url); return { html, doc: null, state: st }; }
    return { html, doc: parseHtml(html), state: 'ok' };
  }

  /* ---- open + finished instances, by type (easy = Shadowbridge, hard = Castle, crucible = cube: listed, never touched) ---- */
  let inst = { at: 0, v: { easy: [], hard: [], crucible: [] }, ended: { easy: [], hard: [], crucible: [] } };
  async function instances(force) {
    if (!force && Date.now() - inst.at < 30000) return inst;
    const r = await getDoc(LIST, force ? 0 : 30000, 'ma:dungeon-list'); if (!r || !r.doc) return inst;
    const v = { easy: [], hard: [], crucible: [] }, ended = { easy: [], hard: [], crucible: [] };
    r.doc.querySelectorAll('.grid:not(.ended) .card').forEach((card) => {
      const a = card.querySelector('a[href*="guild_dungeon_enter.php?id="]'), h = card.querySelector('.h'); if (!a || !h) return;
      let id = ''; try { id = new URL(a.getAttribute('href'), BASE).searchParams.get('id') || ''; } catch (_) { /* */ }
      const t = typeOfTitle(h.textContent); if (id && t) v[t].push(String(id));
    });
    const clears = r.doc.querySelectorAll('.grid.ended')[0];            // [0] = Clears (corpses still lootable), [1] = Failed
    if (clears) clears.querySelectorAll('.card').forEach((card) => {
      const t = typeOfTitle((card.querySelector('.h') || {}).textContent), m = (card.textContent || '').match(/Instance #(\d+)/); if (t && m) ended[t].push(m[1]);
    });
    inst = { at: Date.now(), v, ended };
    return inst;
  }
  async function pins(id) {                                              // the instance map: one pin per location
    const r = await getDoc(`/guild_dungeon_instance.php?id=${id}`, 10000, 'ma:dinst:' + id); if (!r || !r.doc) return null;
    const out = [];
    r.doc.querySelectorAll('a.pin').forEach((pin) => {
      const m = (pin.getAttribute('href') || '').match(/location_id=(\d+)/);
      const label = ((pin.querySelector('.label') || {}).textContent || '').replace(/\s+/g, ' ').trim();
      const cm = label.match(/(\d+)\s*\/\s*(\d+)/), done = cm ? parseInt(cm[1], 10) : null, total = cm ? parseInt(cm[2], 10) : null;
      out.push({ locationId: m ? parseInt(m[1], 10) : null, isLocked: pin.classList.contains('locked'),
        isBoss: /\bboss\b/i.test(label) || /\bboss\b/i.test(pin.getAttribute('title') || ''), isDone: done !== null && total > 0 && done >= total });
    });
    return out;
  }
  async function dmgOn(id, dgmid) {                                       // the server's own damage total for us on that monster
    try {
      const html = await Core.net.fetchText(`/battle.php?dgmid=${encodeURIComponent(dgmid)}&instance_id=${encodeURIComponent(id)}`, { force: true, ttl: 0 });
      if (Guard.pageState(html) !== 'ok') return null;
      const el = parseHtml(html).getElementById('yourDamageValue'); return el ? parseNum(el.textContent, null) : null;
    } catch (_) { return null; }
  }

  /* ---- a boss's phase: same group, same place, new name ---- */
  function resolveLive(def, scraped) {
    if (scraped) {
      const m = Roster.members(def).find((c) => Roster.namesMatch(c.name, scraped)); if (m) return m;
      if (!Roster.get(scraped.toLowerCase()) && Roster.looksLikePhase2Of(def, scraped)) {
        const p = Roster.addPhase(Roster.canon(def), scraped);
        log(`🆕 auto-detected phase for ${esc(Roster.canon(def).name)}: ${esc(scraped)}`, 'info'); return p;
      }
    }
    return def;
  }

  /* ---- one boss (one monster per location) ---- */
  async function discover(def) {
    const ins = await instances(), list = ins.v[def.dtype] || []; if (!list.length) return null;
    let sawDead = null, sawLocked = null;
    for (const id of list) {
      let locId = def.locationId;
      if (def.mapGated) {                                                  // Khaal: the map pin says whether the throne is open
        const p = await pins(id), bp = p && p.find((x) => x.isBoss);
        if (bp && bp.isLocked) { sawLocked = { locked: true, live: def, inst: id }; continue; }
        if (bp && bp.locationId) locId = bp.locationId;
      }
      const r = await getDoc(`${LOC}?instance_id=${id}&location_id=${locId}`, 8000, `ma:dloc:${id}:${locId}`);
      if (!r) continue; if (!r.doc) return undefined;
      if (/route is still sealed/i.test(r.html)) { sawLocked = { locked: true, live: def, inst: id }; continue; }
      const locked = Array.from(r.doc.querySelectorAll('.wrap .row .pill')).map((p) => (p.textContent || '').trim().toLowerCase()).includes('locked');
      const card = r.doc.querySelector('.mon');
      if (!card) { if (locked) sawLocked = { locked: true, live: def, inst: id }; continue; }
      const scraped = monName(card), live = resolveLive(def, scraped);
      if (card.classList.contains('dead')) { sawDead = { dead: true, live, inst: id }; continue; }
      const ps = pillTexts(card);
      if (locked || ps.includes('locked')) { sawLocked = { locked: true, live, inst: id }; continue; }
      const dgmid = dgmidOf(card); if (!dgmid) continue;
      const joined = ps.includes('joined');
      return { live, inst: id, loc: locId, id: dgmid, name: scraped || live.name, icon: iconOf(card), userDmg: joined ? ((await dmgOn(id, dgmid)) || 0) : 0 };
    }
    return sawDead || sawLocked || null;
  }
  const base = (low, p) => Object.assign({ low, name: bossName(low), kind: 'dungeon' }, p);
  async function refreshBoss(def) {
    const f = await discover(def); if (f === undefined) return;            // undefined: a login / maintenance page, the guard has taken over
    const now = Date.now(), liveLow = f && f.live ? f.live.low : def.low;
    for (const s of Roster.members(def)) { if (s.low === liveLow) continue; const pe = Board.get(s.low); if (pe && pe.alive !== false) Board.patch(s.low, { alive: false, locked: false, noInstance: false, seenAt: now }); }
    const prev = Board.get(liveLow) || {}, sameInst = f && prev.instanceId && String(prev.instanceId) === String(f.inst);
    const capHeld = !f || sameInst ? prev.capHeld : null;   // a different dungeon id = a new dungeon: nothing is held over (see capNow). Same id = same dungeon and the same mobs, so it stays
    if (!f) { Board.patch(liveLow, base(liveLow, { alive: false, locked: false, noInstance: true, seenAt: now })); return; }
    if (f.dead) { Board.patch(liveLow, base(liveLow, sameInst ? { alive: false, locked: false, noInstance: false, instanceId: f.inst, capHeld, seenAt: now } : { alive: false, locked: false, noInstance: false, instanceId: f.inst, capHeld, monsterId: undefined, userDmg: 0, seenAt: now })); return; }
    if (f.locked) { Board.patch(liveLow, base(liveLow, { alive: false, locked: true, noInstance: false, instanceId: f.inst, capHeld, seenAt: now })); return; }
    LootScan.learn({ name: f.name || def.name, kind: 'dungeon', dtype: def.dtype, locationId: f.loc || Roster.canon(def).locationId, boss: true, id: f.id, instanceId: f.inst, bossish: true });
    const same = sameInst && String(prev.monsterId) === String(f.id);
    Board.patch(liveLow, base(liveLow, {
      alive: true, locked: false, noInstance: false, monsterId: f.id, instanceId: f.inst, capHeld, locationId: f.loc || Roster.canon(def).locationId, name: f.name, icon: f.icon,
      userDmg: Math.max(same ? prev.userDmg || 0 : 0, f.userDmg || 0), firstAliveAt: same && prev.firstAliveAt ? prev.firstAliveAt : now, needsDuel: same ? prev.needsDuel : false, seenAt: now,
    }));
  }

  /* ---- the Gribble swarm: many small mobs, one fightable target per live Gribble still under the cap ---- */
  async function refreshSwarm(def) {
    const ins = await instances(), cap = bossCap(def.low), prev = Board.get(def.low) || {}, now = Date.now(), jobs = []; let icon = prev.icon;     // the Gribble's picture, from any Gribble card (dead ones too)
    for (const id of ins.v[def.dtype] || []) for (const loc of def.locationIds) {
      const r = await getDoc(`${LOC}?instance_id=${id}&location_id=${loc}`, 8000, `ma:dloc:${id}:${loc}`);
      if (!r) continue; if (!r.doc) return;
      if (/route is still sealed/i.test(r.html)) continue;
      for (const card of r.doc.querySelectorAll('.mon')) {
        if (!def.swarmMatch.test(monName(card))) continue;
        icon = iconOf(card) || icon;
        if (card.classList.contains('dead')) continue;
        const dgmid = dgmidOf(card); if (dgmid) { jobs.push({ id: String(id), loc, dgmid, joined: pillTexts(card).includes('joined') }); LootScan.learn({ name: monName(card), kind: 'dungeon', dtype: def.dtype, locationId: loc, boss: false, id: dgmid, instanceId: String(id) }); }
      }
      await sleep(100);
    }
    const found = [];
    await pool(jobs, async (j) => {
      const old = (prev.swarm || []).find((x) => String(x.monsterId) === j.dgmid && String(x.instanceId) === j.id);
      let dealt = old ? old.userDmg || 0 : 0, chk = old ? old.chk || 0 : 0;
      // a swing reply keeps the number current; ask the server only for a Gribble we have never seen, or once in a while (dropped replies)
      if (j.joined && (!old || now - chk > 600000)) { const f = await dmgOn(j.id, j.dgmid); if (Number.isFinite(f)) { dealt = Math.max(dealt, f); chk = now; } }
      if (cap > 0 && dealt >= cap) return;
      found.push({ monsterId: j.dgmid, instanceId: j.id, locationId: j.loc, userDmg: dealt, chk });
    }, 4);
    const ids = (ins.v[def.dtype] || []).map(String), sig = ids.slice().sort().join(','), isNew = sig !== '' && sig !== (prev.instSig || '');   // the dungeon ids it lives in, as one string: a different set than last time = a new dungeon (an empty list changes nothing)
    Board.put(def.low, { low: def.low, name: def.name, kind: 'dungeon-swarm', icon, alive: found.length > 0, swarm: found, totalAlive: jobs.length, seenAt: Date.now(), instSig: sig || prev.instSig || '', capHeld: isNew ? null : prev.capHeld });
  }

  /* ---- the Scan hooks ---- */
  function nextCheck(def) {
    const now = Date.now(), e = Board.get(def.low); if (!e || !e.seenAt) return now;
    return e.seenAt + cfg.fightScanMs * (e.locked ? 2 : 1);
  }
  async function refresh(lows, step) {
    const seen = new Set();
    for (const low of lows) {
      const def = Roster.get(low); if (!def || def.kind === 'wave') continue;
      const key = def.group ? 'g:' + def.group : def.low; if (seen.has(key)) continue; seen.add(key);
      if (step) step('Checking ' + def.name);
      try { if (def.kind === 'dungeon-swarm') await refreshSwarm(def); else await refreshBoss(def); }
      catch (e) { log(`⚠️ dungeon check (${esc(def.name)}): ${e.message}`, 'warn'); }
      await sleep(150);
    }
  }

  /* ---- a live regular (non-boss) dungeon mob for the shield pierce: Shadowbridge first; the cube is never used ---- */
  async function sideMobs(excludeKey, shielded) {
    const ins = await instances();
    for (const id of ins.v.easy || []) for (const loc of [1, 3, 2, 4]) {
      const r = await getDoc(`${LOC}?instance_id=${id}&location_id=${loc}`, 8000, `ma:dloc:${id}:${loc}`);
      if (!r || !r.doc || /route is still sealed/i.test(r.html)) continue;
      for (const card of r.doc.querySelectorAll('.mon')) {
        if (card.classList.contains('dead')) continue;
        const name = monName(card), dgmid = dgmidOf(card), known = Roster.get(name.toLowerCase()); if (!dgmid || (known && known.kind !== 'dungeon-swarm')) continue;
        const key = `dungeon:${dgmid}:${id}`; if (key === excludeKey || (shielded && shielded.has(key))) continue;
        return { kind: 'dungeon', monsterId: dgmid, instanceId: String(id), locationId: loc, name: name || 'dungeon mob', low: name.toLowerCase() };
      }
    }
    return null;
  }

  /* ---- for the graveyard (PART 4): finished-but-lootable corpses of a location ---- */
  const lockedUntil = new Map();
  async function deadMobs(id, loc, label) {
    const k = id + ':' + loc; if ((lockedUntil.get(k) || 0) > Date.now()) return [];
    const r = await getDoc(`${LOC}?instance_id=${id}&location_id=${loc}`, 8000, `ma:dloc:${k}`); if (!r || !r.doc) return [];
    const hp = Array.from(r.doc.querySelectorAll('.wrap .row .pill')).map((p) => (p.textContent || '').trim().toLowerCase());
    if (/route is still sealed/i.test(r.html) || hp.includes('locked')) { lockedUntil.set(k, Date.now() + 300000); return []; }
    lockedUntil.delete(k);
    const out = [];
    for (const card of r.doc.querySelectorAll('.mon')) {
      if (!card.classList.contains('dead')) continue;
      const pills = Array.from(card.querySelectorAll('.pill'));
      if (!pills.some((p) => (p.textContent || '').trim().toLowerCase() === 'joined')) continue;                       // never fought it
      if (!pills.some((p) => (p.getAttribute('title') || '').toLowerCase().includes('you can loot this'))) continue;   // already claimed
      const dgmid = dgmidOf(card); if (!dgmid) continue;
      out.push({ dgmid, name: monName(card) || label || `Location ${loc}`, icon: iconOf(card), expPerDmg: expPerDmg(card), needsLoot: true });
    }
    return out;
  }

  return { nextCheck, refresh, sideMobs, instances, pins, deadMobs, dmgOn, pool, monName, dgmidOf };
})());

/* ===================================================================================================================
 * PART 3 — PHASE DUELS (shared by wave and dungeon bosses)
 * The boss's own battle page carries the "Enter Phase Duel" link: we read the query string off it and drive the duel through
 * pvp_style_state.php / pvp_style_action.php directly, so the duel page never has to be opened. If the duel page IS opened
 * (by hand, or by a click), bootPage() plays it there and returns to the boss.
 * ================================================================================================================ */
function isDuelPage() { return /\/pvp_style_battle\.php/i.test(location.pathname); }

Kernel.register({ id: 'duels', name: 'Phase duels', icon: '👊' });
Object.assign(Duels, (() => {
  const enc = encodeURIComponent;
  let running = false, warnedAt = 0;
  async function resolveQs(t) {
    const url = t.kind === 'dungeon' ? `/battle.php?dgmid=${enc(t.monsterId)}&instance_id=${enc(t.instanceId)}` : `/battle.php?id=${enc(t.monsterId)}`;
    try {
      const html = await Core.net.fetchText(url, { force: true, ttl: 0 });
      if (Guard.pageState(html) !== 'ok') return null;
      const m = html.match(/href="(pvp_style_battle\.php\?[^"]+)"/i); if (!m) return null;
      return new URL(m[1].replace(/&amp;/g, '&'), BASE).search.replace(/^\?/, '');
    } catch (_) { return null; }
  }
  async function jsonFetch(url, opts) {
    const res = await fetch(url, Object.assign({ credentials: 'same-origin' }, opts));
    const j = await res.json().catch(() => null);
    if (!res.ok || !j || !j.ok) throw new Error((j && (j.error || j.message)) || `HTTP ${res.status}`);
    return j;
  }
  const getState = (qs, since) => { const p = new URLSearchParams(qs); p.set('since_log_id', String(since || 0)); return jsonFetch(`/pvp_style_state.php?${p}`); };
  const doAction = (qs, act, extra) => {
    const b = new URLSearchParams(qs); b.set('action', act); Object.entries(extra || {}).forEach(([k, v]) => b.set(k, String(v)));
    return jsonFetch('/pvp_style_action.php', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, body: b.toString() });
  };
  const pickTarget = (st) => { const en = ((st.teams || {}).enemy || {}).players_by_num || {}; for (const n of Object.keys(en)) { const p = en[n]; if (p && p.key && p.alive) return p; } return null; };
  const POWER_RE = /power\s*slash/i, SLASH_RE = /\bslash\b/i;
  // Power Slash first; then plain Slash (else the cheapest attack). Enemy-targeting skills only: no buffs / heals.
  const pickSkills = (skills) => {
    const atk = (skills || []).filter((x) => x && x.target === 'enemy'), ps = atk.find((x) => POWER_RE.test(x.name || '')), rest = atk.filter((x) => x !== ps);
    return [ps, rest.find((x) => !POWER_RE.test(x.name || '') && SLASH_RE.test(x.name || '')) || rest.slice().sort((a, b) => (Number(a.cost) || 0) - (Number(b.cost) || 0))[0]].filter(Boolean);
  };

  // true = won, false = gave up (10 losses / retry refused), null = halted or timed out
  async function play(qs, stillOn, maxMs) {
    const me0 = uid(), t0 = Date.now(); let since = 0, losses = 0;
    while (stillOn() && Date.now() - t0 < maxMs) {
      try {
        const st = await getState(qs, since);
        (st.new_logs || []).forEach((r) => { since = Math.max(since, parseInt(r.id || 0, 10)); });
        if (st.match && st.match.ended) {
          if (String(st.match.winner_side || '') === 'ally') return true;
          if (++losses > 10) { log('⚠️ Phase Duel lost 10 times — giving up for now', 'warn'); return false; }
          log('☠️ Phase Duel lost — retrying', 'warn');
          try { await doAction(qs, 'retry'); since = 0; } catch (e) { log(`⚠️ Phase Duel retry failed (${e.message})`, 'warn'); return false; }
        } else {
          const turn = st.turn || {}, me = st.me || {};
          if (me.in_match && String(turn.user_id) === String(me0) && turn.side === 'ally' && me.alive) {
            const target = pickTarget(st), skills = target ? pickSkills(me.skills) : []; let err = null, used = null;
            for (const skill of skills) {                                    // Power Slash when it goes through, otherwise fall back to Slash
              try { await doAction(qs, 'use_skill', { skill_id: skill.id, target_key: target.key }); used = skill; break; } catch (e) { err = e; }
            }
            if (used) log(`⚔️ [Duel] used ${esc(used.name || 'a skill')} on ${esc(target.username || 'the enemy')}`, 'dmg');
            else if (err) log(`⚠️ [Duel] action failed: ${err.message}`, 'warn');
            else if (Date.now() - warnedAt > 30000) { warnedAt = Date.now(); log('⚠️ [Duel] no usable skill / target this turn', 'warn'); }
          }
        }
      } catch (e) { if (Date.now() - warnedAt > 30000) { warnedAt = Date.now(); log(`⚠️ [Duel] state error: ${e.message}`, 'warn'); } }
      await sleep(1600);
    }
    return null;
  }

  // called by the engine when a swing is answered "PvP duel phase": fight it headless, then the engine resumes the boss
  async function fight(t, stillOn) {
    if (running) return null; running = true;
    try {
      const qs = await resolveQs(t);
      if (!qs) { log(`⚠️ no "Enter Phase Duel" link on ${esc(t.name)}'s battle page`, 'warn'); return null; }
      log(`👊 Phase Duel for ${esc(t.name)} — fighting`, 'ok');
      const r = await play(qs, stillOn, 15 * 60000);
      if (r === true) log('✅ Phase Duel won', 'ok');
      return r;
    } finally { running = false; }
  }

  // the duel page itself is open in this tab (by hand): play it here, then go back to the boss
  async function bootPage() {
    if (!isDuelPage() || !cfg.autoDuel) return;
    const qs = location.search.replace(/^\?/, '');
    log('👊 Phase Duel page detected — auto-fighting', 'ok');
    const r = await play(qs, () => true, 30 * 60000);
    if (r === null) return;
    log(r ? '✅ Phase Duel won — returning to the boss' : '⚠️ Phase Duel not won — returning to the boss', r ? 'ok' : 'warn');
    setTimeout(() => { location.href = '/battle.php?id=' + enc(new URLSearchParams(qs).get('active_id') || ''); }, 1200);
  }
  return { fight, bootPage };
})());

/* ===================================================================================================================
 * PART 4 — LOOT: graveyard scan (dead monsters you fought, still lootable) + EXP-aware auto-loot
 * Claims only when the attack loop hits "no stamina and no potion" (Loot.onStamStall), or when you press a button in Graveyard.
 * Mode toLevel: take the corpse that fits the EXP still needed, biggest first, stop as soon as the level rises. Mode all: take everything.
 * The cube instance (Polyhedral Crucible) is never listed or touched.
 * ================================================================================================================ */
Kernel.register({
  id: 'loot', name: 'Graveyard & loot',  icon: '🪦',          // no periodic scan: the graveyard is read on demand (Scan graveyard / Loot now / out of stamina)
});
Object.assign(Loot, (() => {
  const st = { rows: [], scanning: false, looting: false, estimating: false, lastScanAt: 0, lastStuckAt: 0, claiming: new Set() };
  const rate = new Map(), capInfo = new Map(), upTo = new Map(), dmgCache = new Map();
  const syncMe = async () => { try { await Core.me.sync(); } catch (_) { /* */ } };
  const expNeeded = () => { const m = Core.me.get(), e = m && m.exp; return e && e.max > 0 ? Math.max(0, e.max - e.cur) : null; };

  /* ---- wave corpses: the wave page with the monster cookies set to show dead ones ---- */
  async function waveRows() {
    const seen = new Set(), locs = [], out = [];
    for (const d of Roster.list) { if (d.kind !== 'wave') continue; const l = bossLoc(d.low); if (!l) continue; const k = l.gate + '/' + l.wave; if (!seen.has(k)) { seen.add(k); locs.push(l); } }
    for (const [i, l] of locs.entries()) {
      Work.set('scan', `Graveyard · Gate ${l.gate} · Wave ${l.wave}`, i, locs.length);
      let html;
      try { html = await Core.net.fetchText(`/active_wave.php?gate=${l.gate}&wave=${l.wave}`, { ttl: 20000, key: `ma:gy:${l.gate}:${l.wave}`, via: (run) => Core.cookies.withMode('all', run) }); }
      catch (e) { log(`⚠️ graveyard fetch failed (${l.gate}/${l.wave}): ${e.message}`, 'warn'); continue; }
      const doc = parseHtml(html), s = Guard.pageState(doc);
      if (s !== 'ok') { Guard.fault(s, `graveyard ${l.gate}/${l.wave}`); return out; }
      if (!Guard.chromeOk(doc)) { Diag.skip('graveyard-page-no-chrome', `${l.gate}/${l.wave}`); continue; }
      const nowSec = Math.floor(Date.now() / 1000);
      doc.querySelectorAll('.monster-card[data-dead="1"]').forEach((card) => {          // dead bosses too: their battle page still shows the loot
        const nm = (card.dataset.name || '').trim(), cid = Scan.cardId(card);
        if (nm && cid && (card.dataset.boss === '1' || Roster.get(nm.toLowerCase()))) LootScan.learn({ name: Roster.get(nm.toLowerCase()) ? Roster.get(nm.toLowerCase()).name : ((card.querySelector('.monster-name,.name,h2,h3') || {}).textContent || nm).trim(), kind: 'wave', gate: l.gate, wave: l.wave, id: cid, bossish: card.dataset.boss === '1' });
      });
      doc.querySelectorAll('.monster-card[data-dead="1"][data-joined="1"]').forEach((card) => {
        const dmg = parseNum(card.dataset.userdmg, 0); if (dmg <= 0) return;
        const exp = parseNum(card.dataset.expire, 0); if (exp > 0 && exp < nowSec) return;       // despawned: nothing to claim
        const id = card.dataset.monsterId, raw = (card.dataset.name || '').trim(); if (!id || !raw) return;
        const img = card.querySelector('img');
        out.push({ key: 'wave:' + id, kind: 'wave', gate: l.gate, wave: l.wave, area: WaveMap.of(l.gate, l.wave).group.id, monsterId: String(id), name: raw, nameLow: raw.toLowerCase(), isBoss: !!Roster.get(raw.toLowerCase()), icon: img ? img.getAttribute('src') : undefined, userDamage: dmg, needsLoot: true });
      });
      await sleep(150);
    }
    return out;
  }

  /* ---- dungeon corpses: Castle locations the map shows as cleared, Shadowbridge Gribble rooms. Never the cube. ---- */
  async function dungeonRows() {
    Work.set('scan', 'Graveyard · dungeon maps', 0, 0);
    const ins = await Dungeons.instances(true), out = [];
    const counted = (label, fn, total) => { let n = 0; Work.set('scan', label, 0, total); return (j) => fn(j).finally(() => Work.set('scan', label, ++n, total)); };
    const all = (t) => [...new Set([...(ins.v[t] || []), ...(ins.ended[t] || [])])];
    const push = (rows, inst, loc, isBoss, dtype) => rows.forEach((r) => { LootScan.learn({ name: r.name, kind: 'dungeon', dtype, locationId: loc, boss: isBoss, id: r.dgmid, instanceId: inst }); out.push({ key: `dungeon:${inst}:${r.dgmid}`, kind: 'dungeon', dtype, area: dtype === 'hard' ? 'castle' : 'shadow', monsterId: r.dgmid, instanceId: inst, locationId: loc, name: r.name, nameLow: r.name.toLowerCase(), isBoss, icon: r.icon, userDamage: null, needsLoot: true, expPerDmg: r.expPerDmg }); });
    const hard = all('hard'), pinSets = await Dungeons.pool(hard, (id) => Dungeons.pins(id), 3), jobs = [];
    hard.forEach((id, i) => (pinSets[i] || []).forEach((p) => { if (!p.isLocked && p.isDone && p.locationId != null) jobs.push({ inst: id, loc: p.locationId }); }));
    const hr = await Dungeons.pool(jobs, counted('Graveyard · Castle rooms', (j) => Dungeons.deadMobs(j.inst, j.loc), jobs.length), 4);
    jobs.forEach((j, i) => push(hr[i] || [], j.inst, j.loc, true, 'hard'));
    const easy = []; all('easy').forEach((id) => SHADOW_LOCS.forEach((loc) => easy.push({ inst: id, loc })));
    const er = await Dungeons.pool(easy, counted('Graveyard · Shadowbridge rooms', (j) => Dungeons.deadMobs(j.inst, j.loc), easy.length), 4);
    easy.forEach((j, i) => push(er[i] || [], j.inst, j.loc, j.loc === SHADOW_BOSS_LOC, 'easy'));
    return out;
  }

  async function scan(manual) {
    if (st.scanning) return; st.scanning = true; UI.dirty('loot');
    try { await Lane.run(async () => {
      const t0 = Date.now(), before = st.lastScanAt ? st.rows.length : -1, prev = Status.get(); Status.set('GRAVEYARD');
      if (manual === true) log('🪦 scanning the graveyard…', 'info');
      try {
        const w = await waveRows();
        const d = Kernel.isOn('dungeons') ? await dungeonRows() : [];
        st.rows = [...w, ...d]; st.lastScanAt = Date.now();
        if (manual === true || st.rows.length !== before) log(`🪦 graveyard scan done · ${st.rows.length} corpse${st.rows.length === 1 ? '' : 's'} (${w.length} wave, ${d.length} dungeon) · ${((Date.now() - t0) / 1000).toFixed(1)}s`, 'info');
      } catch (e) { log(`⚠️ graveyard scan error: ${e.message}`, 'warn'); }
      finally { Work.clear('scan'); if (Status.get() === 'GRAVEYARD') Status.set(prev); }
    }); await estimateAll().catch(() => {});                          // the total EXP of what the scan found (after the site lane is free again)
    } finally { st.scanning = false; UI.dirty('loot'); }          // always released: a throw before the inner try used to leave scanning=true and block every later scan AND the out-of-stamina loot
  }

  /* ---- EXP estimate per corpse (one battle page per monster NAME gives rate, cap and reward level) ---- */
  const battleUrl = (r) => (r.kind === 'dungeon' ? `/battle.php?dgmid=${r.monsterId}&instance_id=${r.instanceId}` : `/battle.php?id=${r.monsterId}`);
  const block = (doc, label) => Array.from(doc.querySelectorAll('.stat-block')).find((b) => ((b.querySelector('.label') || {}).textContent || '').trim() === label);
  async function loadInfo(r) {
    const ld = LootData.get(r.nameLow);                                                 // saved by the loot pickup: no battle page needed for these
    if (ld) {
      if (!rate.has(r.nameLow) && Number.isFinite(ld.expPerDmg)) rate.set(r.nameLow, ld.expPerDmg);
      if (!capInfo.has(r.nameLow) && Number.isFinite(ld.expCapDmg)) capInfo.set(r.nameLow, { capDmg: ld.expCapDmg });
      if (!upTo.has(r.nameLow) && Number.isFinite(ld.upTo)) upTo.set(r.nameLow, ld.upTo);
    }
    const needName = !rate.has(r.nameLow) || !upTo.has(r.nameLow), needDmg = r.userDamage == null;
    if (needDmg && dmgCache.has(r.key)) r.userDamage = dmgCache.get(r.key);
    if (!needName && r.userDamage != null) return;
    let doc = null;
    try { const html = await Core.net.fetchText(battleUrl(r), { force: true, ttl: 0 }); if (Guard.pageState(html) === 'ok') doc = parseHtml(html); } catch (_) { /* */ }
    if (!doc) return;
    if (r.userDamage == null) { const el = doc.getElementById('yourDamageValue'); r.userDamage = el ? parseNum(el.textContent, null) : null; dmgCache.set(r.key, r.userDamage); }
    if (!rate.has(r.nameLow)) { const b = block(doc, 'EXP / DMG'), v = b ? parseFloat(((b.querySelector('strong') || {}).textContent || '').trim()) : NaN; rate.set(r.nameLow, Number.isFinite(v) ? v : null); }
    if (!capInfo.has(r.nameLow)) {
      const b = block(doc, 'EXP Cap'), dm = b && b.textContent.match(/Deal\s*~?([\d,]+)\s*dmg to hit cap/i);
      capInfo.set(r.nameLow, { capDmg: dm ? parseNum(dm[1]) : null });
    }
    if (!upTo.has(r.nameLow)) {
      const cell = Array.from(doc.querySelectorAll('.monster-stat-cell')).find((c) => ((c.querySelector('.label') || {}).textContent || '').trim() === 'Rewards Up To');
      const m = cell && ((cell.querySelector('strong') || {}).textContent || '').match(/([\d,]+)/);
      upTo.set(r.nameLow, m ? parseNum(m[1]) : null);
    }
  }
  async function estimate(r) {                                // number = predicted xp, 0 = out-levelled, null = unknown
    await loadInfo(r);
    if (!Number.isFinite(r.userDamage)) return null;
    const lim = upTo.get(r.nameLow); if (lim != null && Me.level() > lim) return 0;
    const rt = r.expPerDmg != null ? r.expPerDmg : rate.get(r.nameLow); if (rt == null) return null;
    const ci = capInfo.get(r.nameLow), eff = ci && ci.capDmg != null ? Math.min(r.userDamage, ci.capDmg) : r.userDamage;
    return Math.ceil(eff * rt);
  }
  // estimated EXP of every corpse of the last scan, kept on the row (row.est: a number, 0 = out-levelled, null = unknown). The Loot tab sums them.
  async function estimateAll() {
    const rows = st.rows.filter((r) => r.needsLoot !== false); if (!rows.length) return;
    st.estimating = true; UI.dirty('loot');
    try {
      let n = 0; Work.set('scan', 'Graveyard · estimating EXP', 0, rows.length);
      await Dungeons.pool(rows, async (r) => {
        try { const e = await estimate(r); r.est = Number.isFinite(e) ? e : null; } catch (_) { r.est = null; }
        Work.set('scan', 'Graveyard · estimating EXP', ++n, rows.length);
      }, 4);
    } finally { Work.clear('scan'); st.estimating = false; UI.dirty('loot'); }
  }
  // biggest corpse that still fits the EXP gap first; when nothing fits, the smallest one closes it
  function descendingPlan(known, needed) {
    const pool = known.slice().sort((a, b) => b.est - a.est), plan = []; let left = needed;
    while (left > 0 && pool.length) { let i = pool.findIndex((x) => x.est <= left); if (i === -1) i = pool.length - 1; const [p] = pool.splice(i, 1); plan.push(p.r); left -= p.est; }
    return plan;
  }
  async function buildPlan(rows) {
    await syncMe(); const needed = expNeeded(); if (!(needed > 0)) return [];
    const known = []; let total = 0;
    await Dungeons.pool(rows, async (r) => { const est = await estimate(r); if (est != null && est > 0) { known.push({ r, est }); total += est; } }, 4);
    if (total < needed) { log(`⏸️ known EXP (${fmtNum(total)}) is short of the ${fmtNum(needed)} needed — no loot this pass`, 'info'); return []; }
    return descendingPlan(known, needed);
  }

  /* ---- claiming (one request at a time, through the action queue) ---- */
  async function claim(row) {
    const r = await Act.run(() => (row.kind === 'dungeon'
      ? post('/dungeon_loot.php', { instance_id: row.instanceId, dgmid: row.monsterId, user_id: uid() })
      : post('/loot.php', { monster_id: row.monsterId })), cfg.minActionGapMs);
    const j = r && r.json;
    const ok = !!(j && j.status === 'success') || (row.kind === 'wave' && !j && /success|looted|claimed/i.test((r && r.text) || ''));
    return { ok, expDelta: Number(j && j.rewards && j.rewards.exp) || 0 };
  }
  async function pass() {
    if (st.looting) return;
    const claimable = st.rows.filter((r) => r.needsLoot !== false); if (!claimable.length) return;
    st.looting = true; UI.dirty('loot');
    try {
      const plan = await buildPlan(claimable); if (!plan.length) return;
      await syncMe(); const startLevel = Me.level();
      for (const row of plan) {
        if (!Tab.isMain()) break;
        const res = await claim(row);
        if (res.ok) {
          log(`🎒 looted ${esc(row.name)}${row.isBoss ? ' 👑' : ''}${res.expDelta ? ` (+${fmtNum(res.expDelta)} EXP)` : ''}`, 'ok');
          st.rows = st.rows.filter((x) => x.key !== row.key);
          if (res.expDelta > 0) await syncMe();
          if (Me.level() > startLevel) { log('✅ leveled up — stopping the loot pass', 'ok'); break; }
        } else log(`⚠️ loot claim failed for ${esc(row.name)}`, 'warn');
        UI.dirty('loot'); await sleep(cfg.autoLoot.claimGapMs ?? 250);
      }
    } finally { st.looting = false; UI.dirty('loot'); }
  }
  async function claimGroup(nameLow, area) {                   // the "Claim all" button of one monster name, within one area
    const ck = (area || '') + '|' + nameLow;
    if (st.claiming.has(ck)) return; st.claiming.add(ck); UI.dirty('loot');
    try {
      for (const row of st.rows.filter((r) => r.nameLow === nameLow && (r.area || '') === (area || '') && r.needsLoot !== false)) {
        const res = await claim(row);
        if (res.ok) { log(`🎒 looted ${esc(row.name)}${res.expDelta ? ` (+${fmtNum(res.expDelta)} EXP)` : ''}`, 'ok'); row.needsLoot = false; if (res.expDelta > 0) await syncMe(); }
        else log(`⚠️ claim failed for ${esc(row.name)}`, 'warn');
        UI.dirty('loot'); await sleep(cfg.autoLoot.claimGapMs ?? 250);
      }
      st.rows = st.rows.filter((r) => r.needsLoot !== false);
    } finally { st.claiming.delete(ck); UI.dirty('loot'); }
  }
  async function onStamStall() {
    if (!cfg.autoLoot.enabled || !Kernel.isOn('loot') || !Tab.isMain()) return;
    if (st.scanning || st.looting || Date.now() - st.lastStuckAt < 15000) return;
    st.lastStuckAt = Date.now();
    log('⏸️ out of stamina and no potion — checking the graveyard for loot', 'info');
    await scan(); await pass();
  }
  // "Loot now": always look first (the rows are only as fresh as the last scan), then claim
  async function scanAndPass() { await scan(true); await pass(); }
  return { onStamStall, scan, pass, scanAndPass, claimGroup, state: st, estimate, claimOne: async (row) => { const r = await claim(row); if (r.ok) { st.rows = st.rows.filter((x) => x.key !== row.key); UI.dirty('loot'); } return r; } };
})());

/* ===================================================================================================================
 * PART 4b — LOOT SCAN (swappable: delete this block and the Bosses tab just loses its Scan / Export buttons)
 * Reads every boss's battle page once per monster NAME (dead ones included, like the "Possible Loot" panel does) and keeps
 *   loot tier, item, drop %, DMG req · Level Req · EXP Cap % (and the damage it takes to reach it) · EXP / DMG · HP
 * in the loot store (PART 1: LootData). Every loot DMG req becomes a cap choice of that boss, and bosses the roster did not
 * know yet are added. "Export .txt" writes everything saved so far as a plain-text report.
 * Read-only: GET requests only, one at a time through the same action queue as the attacks (so it keeps their pace and
 * never overlaps an attack), stops on a login / maintenance page. Never joins, attacks, loots or equips. The cube is left alone.
 * Extra wave pages can be added by hand before pressing Scan:  window.LOOT_SCAN = { waves: [[5, 18]] }
 * ================================================================================================================ */
Object.assign(LootScan, (() => {
  const st = LootScan.state;
  class Halt extends Error { }                                   // a deliberate stop (Stop pressed, signed out, site down)
  const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const numIn = (s) => { const m = clean(s).replace(/,/g, '').match(/\d+(?:\.\d+)?/); return m ? Number(m[0]) : null; };
  const gapMs = () => Math.max(250, cfg.minActionGapMs || 450);
  const note = (m) => { st.notes.push(m); };
  const step = (label) => { st.label = label; UI.dirty('scan'); };
  const check = () => { if (st.stop) throw new Halt('stopped'); };
  let found = {};                                                // nameLow -> record, for this run
  const skipped = new Set();                                     // regular mobs seen and left alone, for this run

  /* WHO COUNTS AS A BOSS (regular mobs are never saved, and the scan only ADDS a monster it is sure about): a monster the roster already
   * knows (or the Gribble swarm), or one the page itself marks as a boss with data-boss="1". Nothing you removed is ever read again. */
  const isKnown = (low, name) => !!Roster.get(low) || Roster.list.some((r) => r.swarmMatch && r.swarmMatch.test(name || low));
  const bossish = (card) => card.dataset.boss === '1';

  /* one GET through the action queue, validated. mode: 'all' shows dead monsters on wave pages (Core swaps the cookies under its lock) */
  async function page(url, where, mode) {
    check();
    if (Guard.isFaulted()) throw new Halt('the site is signed out or unavailable right now');
    let html;
    try {
      html = await Act.run(() => Core.net.fetchText(url, Object.assign({ force: true, ttl: 0, key: 'ma:scan:' + (mode || '') + url }, mode ? { via: (run) => Core.cookies.withMode(mode, run) } : {})), gapMs());
    } catch (e) { throw new Error(`${where}: ${e.message}`); }
    const doc = parseHtml(html), s = Guard.pageState(doc);
    if (s !== 'ok') { Guard.fault(s, 'loot scan'); throw new Halt(s === 'signedout' ? 'you are signed out' : 'the site is unavailable'); }
    if (!Guard.chromeOk(doc)) throw new Error(`${where}: not a normal game page`);
    return doc;
  }

  /* a battle page -> loot + requirements (the same selectors as the "Possible Loot" panel on the wave page) */
  function parseBattle(doc) {
    const stat = (label) => Array.from(doc.querySelectorAll('.stat-block')).find((b) => clean((b.querySelector('.label') || {}).textContent).toLowerCase() === label) || null;
    const val = (b) => numIn(b && (b.querySelector('strong') || {}).textContent);
    const expBlock = stat('exp cap'), m = expBlock && /deal\s*~?\s*([\d,]+)/i.exec(expBlock.textContent || '');
    const loot = [], panel = Array.from(doc.querySelectorAll('.panel')).find((p) => /possible loot/i.test((p.querySelector('strong') || {}).textContent || ''));
    if (panel) {
      let tier = '';
      Array.from((panel.querySelector('.loot-grid') || panel).children).forEach((child) => {
        if (child.matches && child.matches('h4.tier-head')) { tier = clean(child.textContent).toUpperCase(); return; }
        (child.querySelectorAll ? child.querySelectorAll('.loot-card') : []).forEach((card) => {
          const chips = Array.from(card.querySelectorAll('.chip')).map((c) => clean(c.textContent));
          const im = card.querySelector('img'), icon = im ? (im.getAttribute('src') || im.getAttribute('data-src') || '') : '';
          loot.push({ tier, name: clean((card.querySelector('.loot-name') || {}).textContent), icon: icon || undefined, gp: (card.classList.contains('phase-loot-card') || chips.some((t) => /^phase\s*\d/i.test(t))) ? numIn(chips.find((t) => /^phase\s*\d/i.test(t))) || 3 : undefined, dropPct: numIn(chips.find((t) => /drop:/i.test(t))), dmgReq: numIn(chips.find((t) => /dmg req:/i.test(t))) });
        });
      });
    }
    const upCell = Array.from(doc.querySelectorAll('.monster-stat-cell')).find((c) => clean((c.querySelector('.label') || {}).textContent) === 'Rewards Up To'), upM = upCell && /([\d,]+)/.exec((upCell.querySelector('strong') || {}).textContent || '');
    return { upTo: upM ? numIn(upM[1]) : null, levelReq: val(stat('level req')), expCapPct: val(expBlock), expCapDmg: m ? numIn(m[1]) : null, expPerDmg: val(stat('exp / dmg')), hp: val(stat('monster hp')), loot };
  }
  const hasData = (b) => !!(b.loot.length || b.levelReq || b.hp);
  const readBattle = async (url, where) => parseBattle(await page(url, where));
  function keep(name, extra, b) {
    const low = clean(name).toLowerCase(), old = LootData.get(low);
    // a page that shows no loot panel this time must not wipe loot we already know
    const rec = Object.assign({ name: clean(name), scannedAt: Date.now() }, extra, { isBoss: true }, b);
    if (!rec.loot.length && old && Array.isArray(old.loot) && old.loot.length) rec.loot = old.loot;
    found[low] = rec; st.read = Object.keys(found).length; UI.dirty('scan');
  }

  /* ---- waves ---- */
  async function discoverWaves() {
    const waves = new Map(), add = (g, w) => { if (g > 0 && w > 0) waves.set(g + '/' + w, [g, w]); };
    Roster.list.forEach((d) => { if (d.kind === 'wave') { const l = bossLoc(d.low); if (l) add(l.gate, l.wave); } });
    Object.values(LootData.all()).forEach((e) => { if (e && e.kind === 'wave') add(e.gate, e.wave); });
    ((window.LOOT_SCAN && window.LOOT_SCAN.waves) || []).forEach(([g, w]) => add(+g, +w));
    // best effort: a wave page the gates pages link to (this does not stop the scan when the page looks different)
    const queue = ['/gates.php'], seen = new Set();
    while (queue.length && seen.size < 12) {
      const path = queue.shift(); if (seen.has(path)) continue; seen.add(path); step('Looking for wave pages…');
      let doc; try { doc = await page(path, path); } catch (e) { if (e instanceof Halt) throw e; note(`${path}: ${e.message}`); continue; }
      doc.querySelectorAll('a[href]').forEach((a) => {
        let u; try { u = new URL(a.getAttribute('href'), location.origin); } catch (_) { return; }
        if (u.origin !== location.origin) return;
        if (/active_wave\.php$/.test(u.pathname)) add(+u.searchParams.get('gate'), +u.searchParams.get('wave'));
        else if (/(gate|wave)/i.test(u.pathname + u.search) && !/battle\.php|guild|pvp/i.test(u.pathname)) queue.push(u.pathname + u.search);
      });
    }
    return [...waves.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  }
  /* One wave page in one cookie view (Core swaps hide_dead_monsters / show_dead_bosses_only around the request).
   * 'alive' has to be the real alive view: no dead card in it. If Core's swap did not take, ask once more, then say so. */
  async function waveDoc(gate, wave, mode) {
    const where = `Gate ${gate} · Wave ${wave}`, url = `/active_wave.php?gate=${gate}&wave=${wave}`, dead = (d) => d.querySelector('.monster-card[data-dead="1"]');
    let doc = await page(url, where, mode);
    if (mode === 'alive' && dead(doc)) {
      doc = await page(url, where, mode);
      if (dead(doc)) note(`${where}: asked for the alive view but the page still listed dead monsters, so live ones may have been missed`);
    }
    return doc;
  }
  /* monster name -> its cards on a wave page (alive ones only when aliveOnly) */
  function cardsByName(doc, aliveOnly) {
    const names = new Map();
    doc.querySelectorAll('.monster-card').forEach((c) => {
      if (aliveOnly && c.dataset.dead === '1') return;
      const name = clean((c.querySelector('h3,.monster-name,.name,h2') || {}).textContent) || clean(c.dataset.name);       // the visible title keeps its capitals; data-name is lowercase
      const id = Scan.cardId(c); if (!name || !id) return;
      if (cfg.ignored.includes(name.toLowerCase()) || (!isKnown(name.toLowerCase(), name) && !bossish(c))) { skipped.add(name.toLowerCase()); return; }          // a regular mob: not saved, its battle page is not even opened
      const e = names.get(name.toLowerCase()) || { name, ids: [] }; e.ids.push({ id, dead: c.dataset.dead === '1' }); names.set(name.toLowerCase(), e);
    });
    return names;
  }
  async function readNames(names, gate, wave) {
    for (const e of names.values()) {
      let got = false;
      for (const { id } of e.ids.sort((a, b) => a.dead - b.dead)) {         // alive first; a dead one is fine too, it still shows its loot
        let b; try { b = await readBattle(`/battle.php?id=${encodeURIComponent(id)}`, e.name); } catch (err) { if (err instanceof Halt) throw err; note(`${e.name}: ${err.message}`); continue; }
        if (!hasData(b)) continue;
        keep(e.name, { kind: 'wave', gate, wave }, b); got = true; break;
      }
      if (!got) note(`${e.name} (Gate ${gate} · Wave ${wave}): its battle page showed no loot or stats`);
    }
  }
  async function scanWave(gate, wave) {
    // 1. the alive view: every monster that is up right now (the one you are fighting included, in whichever phase it is in)
    await readNames(cardsByName(await waveDoc(gate, wave, 'alive'), true), gate, wave);
    // 2. roster bosses of this wave with no data yet (a phase counts for its whole boss): they may be dead, so look at the "all" view once
    const bosses = Roster.list.filter((d) => { const l = d.kind === 'wave' && Roster.canon(d) === d && bossLoc(d.low); return l && l.gate === gate && l.wave === wave; });
    const have = (d) => Roster.members(d).some((m) => found[m.low] || LootData.get(m.low));
    let missing = bosses.filter((d) => !have(d));
    if (missing.length) {
      const all = cardsByName(await waveDoc(gate, wave, 'all'), false), pick = new Map();
      all.forEach((e, low) => { if (missing.some((d) => Roster.members(d).some((m) => m.low === low))) pick.set(low, e); });
      await readNames(pick, gate, wave);
      missing = bosses.filter((d) => !have(d));
    }
    missing.forEach((d) => note(`${d.name}${Roster.members(d).length > 1 ? ' (or its later phase)' : ''}: not on the Gate ${gate} · Wave ${wave} page, alive or dead (not spawned yet?), so no loot data`));
  }

  /* ---- dungeons (Shadowbridge = easy, Castle = hard; the Crucible is the cube and is never touched) ---- */
  async function scanDungeons() {
    if (!Dungeons.instances || !Dungeons.pins || !Dungeons.monName) { note('The Dungeons part is not installed, so dungeons were skipped'); return; }
    const ins = await Dungeons.instances(true);
    for (const type of ['hard', 'easy']) {
      const label = type === 'hard' ? 'Castle' : 'Shadowbridge', id = (ins.v[type] || [])[0] || (ins.ended[type] || [])[0];
      if (!id) { note(`${label}: no instance open or finished right now, skipped`); continue; }
      step(label); check();
      const pins = await Dungeons.pins(id);
      if (!pins) { note(`${label}: could not read the map`); continue; }
      let read = 0;
      for (const pin of pins) {
        if (pin.locationId == null) continue;
        if (read >= 60) break;
        if (pin.isLocked) { note(`${label} location ${pin.locationId}: sealed, skipped (scan again once it is open)`); continue; }
        step(`${label} · location ${pin.locationId}`);
        let doc; try { doc = await page(`/guild_dungeon_location.php?instance_id=${id}&location_id=${pin.locationId}`, `${label} location ${pin.locationId}`); } catch (e) { if (e instanceof Halt) throw e; note(e.message); continue; }
        if (/route is still sealed/i.test((doc.body && doc.body.textContent) || '')) { note(`${label} location ${pin.locationId}: sealed, skipped`); continue; }
        const seen = new Set(), cards = Array.from(doc.querySelectorAll('.mon')), lone = new Set(cards.map((c) => clean(Dungeons.monName(c)).toLowerCase())).size === 1;
        for (const card of cards) {
          const name = Dungeons.monName(card), dgmid = Dungeons.dgmidOf(card), low = clean(name).toLowerCase();
          if (!name || !dgmid || seen.has(low) || read >= 60) continue; seen.add(low);
          if (cfg.ignored.includes(low) || (!isKnown(low, name) && !(pin.isBoss && lone))) { skipped.add(low); continue; }                 // a regular dungeon mob: left alone
          try {
            const b = await readBattle(`/battle.php?dgmid=${encodeURIComponent(dgmid)}&instance_id=${encodeURIComponent(id)}`, name);
            if (hasData(b)) { keep(name, { kind: 'dungeon', dtype: type, locationId: pin.locationId, boss: !!pin.isBoss }, b); read++; }
          } catch (e) { if (e instanceof Halt) throw e; note(`${name}: ${e.message}`); }
        }
      }
    }
  }

  /* ---- run / stop ---- */
  function save() {
    const rows = Object.keys(found); if (!rows.length) return 0;
    const prev = (() => { const o = lootStore.get(), b = o && o.bosses && typeof o.bosses === 'object' ? o.bosses : {}, out = {}; Object.keys(b).forEach((k) => { if (LootData.isBossRecord(k, b[k])) out[k] = b[k]; }); return out; })();     // (regular mobs saved by an earlier scan are dropped here too)
    st.added = rows.filter((k) => !Roster.get(k) && !prev[k]).length;
    lootStore.set({ v: 1, at: Date.now(), bosses: Object.assign({}, prev, found) });
    return rows.length;
  }
  async function run() {
    if (st.running) return;
    Object.assign(st, { running: true, stop: false, label: 'Starting…', done: 0, total: 0, read: 0, added: 0, notes: [], error: '', skipped: 0, startedAt: Date.now(), endedAt: 0 });
    found = {}; skipped.clear(); UI.dirty('scan'); log('🔎 loot scan started (read-only)', 'info');
    try {
      const waves = await discoverWaves();
      st.total = waves.length + 1; UI.dirty('scan');
      for (const [g, w] of waves) {
        step(`Gate ${g} · Wave ${w}`);
        try { await scanWave(g, w); } catch (e) { if (e instanceof Halt) throw e; note(`Gate ${g} · Wave ${w}: ${e.message}`); }
        st.done++; UI.dirty('scan');
      }
      try { await scanDungeons(); } catch (e) { if (e instanceof Halt) throw e; note('Dungeons: ' + e.message); }
      st.done++;
    } catch (e) { st.error = e instanceof Halt ? (e.message === 'stopped' ? '' : e.message) : String((e && e.message) || e); }
    finally {
      st.skipped = skipped.size;
      let n = 0; try { n = save(); } catch (e) { st.error = 'could not save: ' + e.message; }
      st.running = false; st.endedAt = Date.now(); st.label = '';
      if (!n) { if (!st.error) st.error = 'nothing was read. Are you signed in?'; }
      log(`${st.error ? '⚠️' : '✅'} loot scan ${st.stop ? 'stopped' : 'finished'}: ${n} monster${n === 1 ? '' : 's'} read${st.added ? ', ' + st.added + ' new' : ''}${st.skipped ? ', ' + st.skipped + ' regular mob' + (st.skipped === 1 ? '' : 's') + ' left out' : ''}${st.notes.length ? ', ' + st.notes.length + ' note' + (st.notes.length === 1 ? '' : 's') : ''}${st.error ? ' — ' + st.error : ''}`, st.error ? 'warn' : 'ok');
      UI.dirty('scan'); UI.dirty('loot');
    }
  }
  const stop = () => { if (st.running) { st.stop = true; st.label = 'Stopping…'; UI.dirty('scan'); } };

  /* ---- export: everything saved so far, as plain text ---- */
  const shortN = (n) => (Number.isFinite(n) ? fmtNum(n).replace(/\.?0+([TBMK])$/, '$1') : '?');
  const fullN = (n) => (Number.isFinite(n) ? Number(n).toLocaleString('en-US') : '?');
  const when = (t) => { if (!t) return 'never'; const d = new Date(t), p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
  const TIER_RANK = { MYTHIC: 0, LEGENDARY: 1, EPIC: 2, RARE: 3, UNCOMMON: 4, COMMON: 5 };
  function whereOf(e) {
    if (e.kind === 'wave') { const w = WaveMap.of(e.gate, e.wave); return { sort: (e.gate || 0) * 1000 + (e.wave || 0), head: `${w.group.title} · Gate ${e.gate} · Wave ${e.wave}${w.group.id === 'other' ? '' : ' · ' + w.label}`, short: `G${e.gate} W${e.wave}` }; }
    const hard = e.dtype === 'hard';
    return { sort: 1e6 + (hard ? 0 : 1e4) + (e.locationId || 0), head: `${hard ? 'Castle' : 'Shadowbridge'} · location ${e.locationId || '?'}`, short: `${hard ? 'Castle' : 'Shadowbridge'} #${e.locationId || '?'}` };
  }
  function text() {
    const ridx = new Map(Roster.list.map((d, i) => [d.low, i])), ri = (e) => { const k = ridx.get(e.name.toLowerCase()); return k == null ? -1 : k; };
    const rows = Object.values(LootData.all()).filter((e) => e && e.name).map((e) => ({ e, w: whereOf(e) }))
      .sort((a, b) => a.w.sort - b.w.sort || (ri(a.e) - ri(b.e)) || a.e.name.localeCompare(b.e.name));
    const L = [], rule = '='.repeat(78), thin = '-'.repeat(78);
    L.push('AUTOMATOR · LOOT SCAN FINDINGS', rule, `Exported        ${when(Date.now())}   (Automator v${VERSION})`, `Data saved      ${when(LootData.at())}`, `Monsters        ${rows.length}`, '');
    if (!rows.length) { L.push('Nothing has been scanned yet. Press Scan in the Bosses tab.'); return L.join('\r\n'); }

    L.push('CAP CHOICES (the loot DMG requirements; the highest one is the default cap)', thin);
    const nw = Math.min(46, Math.max(...rows.map((r) => r.e.name.length)));
    rows.forEach(({ e, w }) => {
      const reqs = Array.from(new Set((e.loot || []).map((l) => l.dmgReq).filter((n) => n > 0))).sort((a, b) => a - b).map(shortN).join(' · ') || '-';
      L.push(`${e.name.slice(0, nw).padEnd(nw)}  ${w.short.padEnd(13)}  ${reqs}`);
    });
    L.push('', '');

    L.push('DETAILS', rule);
    let head = '';
    rows.forEach(({ e, w }) => {
      if (w.head !== head) { head = w.head; L.push('', `■ ${head}`, thin); }
      L.push(e.name + (e.boss ? '  [boss location]' : ''));
      const bits = [e.levelReq ? `Level req ${fullN(e.levelReq)}` : '', e.expCapPct != null ? `EXP cap ${e.expCapPct}%${e.expCapDmg ? ` (~${shortN(e.expCapDmg)} dmg to reach it)` : ''}` : '', e.expPerDmg != null ? `EXP/DMG ${e.expPerDmg}` : '', e.hp ? `HP ${shortN(e.hp)}` : ''].filter(Boolean);
      L.push('   ' + (bits.join('  ·  ') || 'no stats found'));
      const loot = (e.loot || []).slice().sort((a, b) => (b.dmgReq || 0) - (a.dmgReq || 0) || (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9) || String(a.name).localeCompare(String(b.name)));
      if (!loot.length) L.push('   (no loot shown)');
      loot.forEach((l) => L.push(`   ${(l.dmgReq > 0 ? shortN(l.dmgReq) + ' dmg' : 'no dmg req').padStart(11)}   ${String(l.tier || '').padEnd(10)} ${l.name}${l.dropPct != null ? `  (${l.dropPct}% drop)` : ''}`));
      L.push(`   scanned ${when(e.scannedAt)}`, '');
    });

    if (st.notes.length) { L.push('', 'NOT READ / NOTES FROM THE LAST SCAN', thin); st.notes.forEach((n) => L.push('- ' + n)); }
    return L.join('\r\n');
  }
  function download() {
    const body = text(), n = Object.keys(LootData.all()).length, d = new Date(), p = (x) => String(x).padStart(2, '0');
    const name = `automator-loot-scan-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.txt`;
    try {
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([body], { type: 'text/plain;charset=utf-8' })); a.download = name;
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
      log(`⬇ exported ${n} monster${n === 1 ? '' : 's'} to ${name}`, 'info');
    } catch (e) { log('❌ export failed: ' + e.message, 'err'); }
    return name;
  }

  /* ---- automatic pickup: a boss seen (alive or dead) that has no loot data yet is read the moment it is discovered, so the Scan button is only
   *      needed for waves nobody has looked at yet. One read-only battle page per NAME, queued, spaced out, retried at most every 30 minutes. ---- */
  const auto = { queue: new Map(), busy: false, tried: new Map() };
  function learn(info) {
    try {
      if (!info || !info.name || !info.id || !Tab.isMain()) return;
      const low = clean(info.name).toLowerCase();
      if (auto.queue.has(low) || cfg.ignored.includes(low)) return;
      const have = LootData.get(low); if (have && Array.isArray(have.loot) && have.loot.length) return;
      if (!info.bossish && !isKnown(low, info.name)) return;                 // a regular mob: never read
      if (Date.now() - (auto.tried.get(low) || 0) < 30 * 60000 || auto.queue.size >= 40) return;
      auto.queue.set(low, info); drain();
    } catch (_) { /* never breaks a scan */ }
  }
  async function drain() {
    if (auto.busy) return; auto.busy = true;
    try {
      await sleep(1500);                                                   // let the scan that found it finish first
      while (auto.queue.size) {
        if (st.running || Guard.isFaulted() || !Tab.isMain()) break;         // the manual scan is doing it, or the site is down
        const [low, info] = auto.queue.entries().next().value; auto.queue.delete(low);
        const have = LootData.get(low); if (have && Array.isArray(have.loot) && have.loot.length) continue;
        auto.tried.set(low, Date.now());
        try {
          const url = info.kind === 'dungeon' ? `/battle.php?dgmid=${encodeURIComponent(info.id)}&instance_id=${encodeURIComponent(info.instanceId)}` : `/battle.php?id=${encodeURIComponent(info.id)}`;
          const html = await Act.run(() => Core.net.fetchText(url, { force: true, ttl: 0, key: 'ma:learn:' + url }), gapMs());
          const doc = parseHtml(html), ps = Guard.pageState(doc);
          if (ps !== 'ok') { Guard.fault(ps, 'loot pickup'); break; }
          if (!Guard.chromeOk(doc)) continue;
          const b = parseBattle(doc); if (!hasData(b)) continue;
          const extra = info.kind === 'dungeon' ? { kind: 'dungeon', dtype: info.dtype, locationId: info.locationId, boss: !!info.boss } : { kind: 'wave', gate: info.gate, wave: info.wave };
          const rec = Object.assign({ name: clean(info.name), scannedAt: Date.now() }, extra, { isBoss: true }, b);
          const cur = lootStore.get(), prev = cur && cur.bosses && typeof cur.bosses === 'object' ? cur.bosses : {};
          lootStore.set({ v: 1, at: Date.now(), bosses: Object.assign({}, prev, { [low]: rec }) });
          log(`📚 picked up the loot options of ${esc(rec.name)} (${rec.loot.length} drop${rec.loot.length === 1 ? '' : 's'})`, 'info');
          UI.dirty();
        } catch (e) { if (Guard.isFaulted()) break; }
        await sleep(600);
      }
    } finally { auto.busy = false; }
  }
  return { available: true, run, stop, download, text, learn };
})());

/* ===================================================================================================================
 * PART 5 — PANEL (one Core.float button + panel)
 *   Overview   what it is doing now: vitals, bosses being farmed, session numbers (collapsible groups)
 *   Bosses     loot scan strip, Waves | Dungeons switch; waves grouped by area (Generals / Ocean / Olympus), one row per wave with its bosses as
 *              bubbles (dungeons: Castle / Shadowbridge by location). Tapping a boss opens its picker under the row (one at a time, no tabs):
 *              Gear / Crystal / Pet dropdowns, damage cap (the number, a track of loot levels to tap, and what the cap gets you), timed cap (dungeon bosses).
 *              ☑ Select: tick bosses (one by one, by wave, by group, All shown, or Farming), choose gear / crystal / pet / cap once, Apply to all of them.
 *              "⧉ Copy loadout to…" in a boss's picker starts that with the boss's own picks filled in.
 *   Settings   potions (stamina + save near EXP cap, HP, mana, auto-loot), fighting switches, request timing
 *   Loot       the graveyard
 *   Activity   log + skip reasons in one place
 * Look: the rounded, gradient look of Boss DMG Automator 3.0.0 (pills, bubbles, underline tabs, big Start / Stop) at a smaller size, on Core's
 * palette. Core's own classes (core-btn ...) where they fit, ma-* for the rest. The modal frame is tightened for this panel only.
 * Forms are never redrawn while you are typing in them.
 * ================================================================================================================ */
const Panel = (() => {
  const { h, btn } = Core.ui;
  const TABS = [['home', 'Overview', '🏠'], ['bosses', 'Bosses', '👹'], ['loot', 'Loot', '🪦'], ['settings', 'Settings', '⚙️'], ['activity', 'Activity', '📜']];
  const DIRTY_TAB = { status: 'home', log: 'activity', diag: 'activity', loot: 'loot', relics: 'bosses' };   // 'scan' repaints only the strip
  const uiStore = Core.store(ID + '-ui', { def: { tab: 'home', open: {}, filter: '', bsec: 'waves' } });
  const ui = Object.assign({ tab: 'home', open: {}, filter: '', bsec: 'waves' }, uiStore.get() || {}); if (!ui.open || typeof ui.open !== 'object') ui.open = {};
  const saveUi = () => uiStore.set(ui);
  if (ui.tab === 'supplies') ui.tab = 'settings';                  // the Supplies tab is part of Settings now
  let root = null, tab = TABS.some((t) => t[0] === ui.tab) ? ui.tab : 'home', shown = false, drawT = 0;
  const phaseSel = {};                                              // boss entry -> which phase the boss page is on
  /* Select mode (Bosses tab): tap bosses to tick them, pick gear / crystal / pet / cap once, apply to all. Not saved: it is a one-off action. */
  const BK = { on: false, sel: new Set(), ph: null, pick: {}, cap: '', n: 3e9, msg: '', from: '' };
  const isOpen = (key, dflt) => (ui.open[key] != null ? !!ui.open[key] : !!dflt);

  (function css() {
    const old = document.getElementById('ma-css'); if (old) old.remove();
    const s = document.createElement('style'); s.id = 'ma-css';
    s.textContent = `
/* frame: Core's modal card, tightened for this panel only (less padding, smaller title, footer flush with the bottom edge) */
.core-modal-card:has(.ma-root){padding:12px 14px 0;border-radius:24px}
.core-modal-card:has(.ma-root) .core-modal-head{margin-bottom:6px}
.core-modal-card:has(.ma-root) .core-modal-title{font-size:16px;font-weight:800}
.ma-root{display:flex;flex-direction:column;font:12.5px/1.35 Arial,sans-serif;color:#eef3ff}
.ma-root *{box-sizing:border-box}
.ma-root button{font-family:inherit}
.ma-root .core-btn{padding:6px 12px;font-size:12px;border-radius:12px}
/* tabs: underline, the active one tinted (3.0.0) */
.ma-tabs{display:flex;gap:2px;margin:0 0 9px;border-bottom:1px solid rgba(255,255,255,.08);overflow-x:auto;scrollbar-width:none}
.ma-tabs::-webkit-scrollbar{display:none}
.ma-tab{flex:1 0 auto;background:none;border:none;border-bottom:2px solid transparent;margin-bottom:-1px;color:#9caad0;font:700 11.5px Arial,sans-serif;padding:7px 8px;border-radius:10px 10px 0 0;cursor:pointer;white-space:nowrap;transition:.15s ease}
.ma-tab:hover{color:#cfd8f7}.ma-tab.on{color:#6ea8ff;border-bottom-color:#6ea8ff;background:rgba(110,168,255,.08)}
.ma-body{min-height:200px;padding-bottom:6px}
/* cards */
.ma-card{background:#11192d;border:1px solid rgba(255,255,255,.06);border-radius:16px;padding:9px 12px;margin-bottom:7px}
.ma-card.off{background:#0f1628}
.ma-card-h{display:flex;align-items:center;gap:9px}
.ma-card-t{flex:1;min-width:0}.ma-card-t b{display:block;font-size:12.5px;color:#fff}.ma-card-t small{display:block;color:#8b97bd;font-size:11px;line-height:1.3}
.ma-card-b{margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,.06)}
.ma-ico{flex:0 0 auto;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:14px;background:#1a2440;border:1px solid rgba(255,255,255,.07);border-radius:10px}
.ma-cap{color:#6e7a9c;font:800 9.5px Arial,sans-serif;text-transform:uppercase;letter-spacing:.07em;margin:10px 4px 4px}
.ma-note{color:#8b97bd;font-size:11px;line-height:1.4;margin:4px 3px}
.ma-empty{padding:14px 12px;text-align:center;color:#8b97bd;background:rgba(255,255,255,.02);border:1px dashed rgba(255,255,255,.1);border-radius:16px;font-size:12px;line-height:1.4}
.ma-empty .core-btn{margin-top:8px}
.ma-alert{margin-bottom:7px;padding:7px 11px;border-radius:14px;font-size:11.5px;line-height:1.4;background:rgba(255,107,122,.08);border:1px solid rgba(255,107,122,.28);color:#ff9aa6}
.ma-alert.info{background:rgba(110,168,255,.08);border-color:rgba(110,168,255,.25);color:#b9d2ff}
.ma-alert .core-btn{margin-top:6px;padding:5px 10px;font-size:11.5px}
/* switch */
.ma-sw{position:relative;display:inline-block;width:32px;height:18px;flex:0 0 auto;cursor:pointer}
.ma-sw input{opacity:0;width:0;height:0;position:absolute}
.ma-sl{position:absolute;inset:0;background:#2b3552;border-radius:18px;transition:.15s}
.ma-sl::before{content:'';position:absolute;width:12px;height:12px;left:3px;top:3px;background:#dfe6ff;border-radius:50%;transition:.15s}
.ma-sw input:checked+.ma-sl{background:linear-gradient(135deg,#3657a7,#4b6dd0)}.ma-sw input:checked+.ma-sl::before{transform:translateX(14px);background:#fff}
.ma-sw input:focus-visible+.ma-sl{box-shadow:0 0 0 2px rgba(110,168,255,.55)}
.ma-sw.sm{width:30px;height:17px}.ma-sw.sm .ma-sl::before{width:11px;height:11px}.ma-sw.sm input:checked+.ma-sl::before{transform:translateX(13px)}
/* segmented + chips: pills */
.ma-seg{display:flex;gap:4px}.ma-seg.full .ma-seg-btn{flex:1}
.ma-seg-btn{background:#0d1322;border:1px solid #27324f;color:#aeb9dc;font:700 11.5px Arial,sans-serif;padding:5px 11px;border-radius:999px;cursor:pointer;transition:.15s;white-space:nowrap}
.ma-seg-btn:disabled{opacity:.45;cursor:not-allowed}.ma-seg-btn:hover{border-color:#3b4a73}.ma-seg-btn.on{background:rgba(75,115,224,.2);border-color:#6ea8ff;color:#d6e5ff}
.ma-chips{display:flex;gap:4px;flex-wrap:wrap}
.ma-chip{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:#0d1322;border:1px solid #27324f;color:#9caad0;font:700 11.5px Arial,sans-serif;padding:5px 11px;border-radius:999px;cursor:pointer;transition:.15s}
.ma-chip:hover{border-color:#3b4a73;color:#cfd8f7}.ma-chip.on{background:rgba(75,115,224,.2);border-color:#6ea8ff;color:#d6e5ff}
.ma-chip i{font-style:normal;margin-left:5px;opacity:.7}
/* inputs */
.ma-in{box-sizing:border-box;width:92px;background:#101a33;border:1px solid rgba(255,255,255,.12);color:#eef3ff;border-radius:10px;padding:5px 9px;font:12.5px Arial,sans-serif;transition:.15s}
.ma-in:focus{outline:none;border-color:#6ea8ff;box-shadow:0 0 0 2px rgba(110,168,255,.18)}
select.ma-in{width:auto;max-width:100%;cursor:pointer;padding-right:4px}
.ma-num{display:inline-flex;align-items:center;gap:5px}.ma-num i{font-style:normal;color:#6e7a9c;font-size:11px;line-height:1}
.ma-in.flash{animation:ma-flash .9s ease-out}
@keyframes ma-flash{0%{background:rgba(110,168,255,.55);border-color:#6ea8ff}100%{background:#0d1322}}
.ma-search{box-sizing:border-box;flex:1;min-width:0;background:#101a33;border:1px solid rgba(255,255,255,.12);color:#eef3ff;border-radius:12px;padding:6px 11px;font:12.5px Arial,sans-serif}
.ma-search:focus{outline:none;border-color:#6ea8ff}
/* label + control rows */
.ma-set{display:flex;align-items:center;gap:10px;padding:5px 0}
.ma-set+.ma-set{border-top:1px solid rgba(255,255,255,.05)}
.ma-set.sub{margin:0 0 3px 6px;padding:0 0 0 10px;gap:8px;border-top:0;border-left:2px solid rgba(110,168,255,.25)}
.ma-set.sub .ma-set-t b{display:inline;font:400 11.5px Arial,sans-serif;color:#aeb9dc}.ma-set.sub .ma-set-t small{display:inline;margin-left:6px;font-size:10.5px;color:#6e7a9c}
.ma-set.sub .ma-in{padding:3px 7px;font-size:12px;border-radius:8px}
.ma-about{margin:10px 3px 2px;text-align:center;opacity:.8}
.ma-grp{padding:1px 12px}.ma-sr-w+.ma-sr-w{border-top:1px solid rgba(255,255,255,.05)}
.ma-sr{display:flex;align-items:center;gap:10px;padding:8px 0}
.ma-sr-o{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:end;gap:10px 12px;margin:0 0 10px 38px;padding:10px 12px 11px;background:#0d1322;border:1px solid rgba(255,255,255,.05);border-radius:12px}
.ma-opt{display:flex;flex-direction:column;align-items:stretch;gap:5px;min-width:0}
.ma-opt>.ma-opt-l{color:#7f8bb1;font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ma-opt.row{flex-direction:row;flex-wrap:wrap;align-items:center;gap:2px 10px}.ma-opt.row>.ma-opt-l{flex:1;color:#c3cdef;font-size:12px;font-weight:600;letter-spacing:0;text-transform:none}.ma-opt.row>small{flex-basis:100%}
.ma-opt>small{color:#6e7a9c;font-size:10.5px;line-height:1.2}
.ma-opt .ma-in{width:100%;min-width:0;box-sizing:border-box;height:32px;padding:0 10px;font-size:12.5px;border-radius:9px}
.ma-opt .ma-num{position:relative;display:flex;width:100%}.ma-opt .ma-num .ma-in{flex:1 1 auto;width:auto;padding-right:44px}
.ma-opt .ma-num i{position:absolute;right:11px;top:50%;transform:translateY(-50%);pointer-events:none}
.ma-opt .ma-seg{width:100%}.ma-opt .ma-seg-btn{padding:5px 9px;font-size:11px}
.ma-opt-l small{margin-left:6px;color:#6e7a9c;font-size:10px;font-weight:400;letter-spacing:0;text-transform:none}
.ma-opt.wide{grid-column:1/-1}
/* timing: the labels may wrap, the fields stay level */
.ma-sr-o.tm{margin:0 0 2px}.ma-sr-o.tm .ma-opt-l{white-space:normal;line-height:1.25}.ma-sr-o.tm .ma-opt-l small{display:block;margin:1px 0 0}
.ma-sr-o.tm>.ma-opt:last-child:nth-child(odd){grid-column:1/-1}
@media (max-width:420px){.ma-sr-o:not(.tm){grid-template-columns:minmax(0,1fr);margin-left:0}}
.ma-card.off .ma-ico{opacity:.55}.ma-card.off .ma-card-t b{color:#aeb9dc}
.ma-card-b .ma-set{padding:6px 0}.ma-card-b .ma-fld{margin:2px 0 4px}
.ma-fold-t small{margin-left:2px}
.ma-set-t{flex:1;min-width:0}.ma-set-t b{display:block;font:600 12.5px Arial,sans-serif;color:#e8edff}.ma-set-t small{display:block;color:#8b97bd;font-size:11px;line-height:1.3}
.ma-fld{margin:7px 0}.ma-fld>label,.ma-fld>.ma-lbl{display:flex;align-items:baseline;gap:8px;color:#c4cdeb;font:700 11.5px Arial,sans-serif;margin-bottom:4px}.ma-fld>label small,.ma-lbl small{font-weight:400;color:#6e7a9c;font-size:11px}
.ma-two{display:grid;grid-template-columns:1fr 1fr;gap:8px}
/* folds */
.ma-fold{margin-bottom:6px;border:1px solid rgba(255,255,255,.06);border-radius:16px;background:#11192d;overflow:hidden}
.ma-fold-h{display:flex;align-items:center;gap:8px;padding:7px 11px;cursor:pointer;user-select:none}
.ma-fold-h:hover{background:rgba(255,255,255,.025)}
.ma-fch{color:#6e7a9c;font-size:10px;transition:.15s;width:9px}.ma-fold.open>.ma-fold-h>.ma-fch{transform:rotate(90deg)}
.ma-fold-t{flex:1;min-width:0;font:800 12.5px Arial,sans-serif;color:#eef3ff;display:flex;align-items:center;gap:7px}
.ma-fold-t small{font:400 11px Arial,sans-serif;color:#6e7a9c}
.ma-fold-b{padding:0 8px 8px}
.ma-link{background:none;border:none;color:#7fa6ff;font:700 11px Arial,sans-serif;cursor:pointer;padding:2px 5px;border-radius:8px}.ma-link:hover{color:#b5ccff;background:rgba(127,166,255,.1)}
.ma-pill{display:inline-flex;align-items:center;font:800 9.5px Arial,sans-serif;letter-spacing:.03em;text-transform:uppercase;padding:2px 8px;border-radius:999px;border:1px solid rgba(255,255,255,.12);color:#9caad0;background:rgba(255,255,255,.05);white-space:nowrap}
.ma-pill.ok{color:#8ee6a8;border-color:rgba(46,204,113,.35);background:rgba(46,204,113,.12)}.ma-pill.warn{color:#ffd978;border-color:rgba(227,179,65,.35);background:rgba(227,179,65,.1)}
.ma-pill.err{color:#ff9aa6;border-color:rgba(255,107,122,.35);background:rgba(255,107,122,.1)}.ma-pill.cap{color:#8fb7a0;border-color:rgba(143,183,160,.3)}.ma-pill.blue{color:#9fc1ff;border-color:rgba(110,168,255,.35);background:rgba(110,168,255,.12)}
/* loot scan strip (top of Bosses) */
.ma-scan{display:flex;align-items:center;gap:9px;padding:8px 10px;margin-bottom:7px;border-radius:16px;background:linear-gradient(135deg,#17233f,#11192d);border:1px solid rgba(110,168,255,.2)}
.ma-scan-t{flex:1;min-width:0}.ma-scan-t b{display:block;font:800 12px Arial,sans-serif;color:#fff}.ma-scan-t small{display:block;color:#9aa7cf;font-size:11px;line-height:1.35}
.ma-scan .ma-bar{margin-top:5px;height:5px}
.ma-scan-b{display:flex;gap:5px;flex:0 0 auto}.ma-scan-b .core-btn{padding:6px 11px}
.ma-scan-n{margin:-3px 4px 7px;padding:6px 10px;border-radius:12px;background:rgba(227,179,65,.07);border:1px solid rgba(227,179,65,.2);color:#ffd978;font-size:11px;line-height:1.45}
.ma-scan-n div+div{margin-top:2px}
/* Waves | Dungeons */
.ma-sec{display:flex;gap:6px;margin:0 0 7px}
.ma-sec button{flex:1;display:flex;align-items:center;justify-content:center;gap:7px;background:#0d1322;border:1px solid #27324f;color:#9caad0;font:800 12px Arial,sans-serif;padding:7px 10px;border-radius:14px;cursor:pointer;transition:.15s}
.ma-sec button:hover{border-color:#3b4a73;color:#cfd8f7}
.ma-sec button.on{background:rgba(110,168,255,.12);border-color:#6ea8ff;color:#d6e5ff}
.ma-sec button i{font-style:normal;font-size:10px;padding:1px 8px;border-radius:99px;background:rgba(255,255,255,.07);color:#9caad0}
.ma-sec button.on i{background:rgba(110,168,255,.28);color:#fff}
.ma-tool{display:flex;gap:6px;margin:0 0 7px}
.ma-tbtn{flex:0 0 auto;background:#0d1322;border:1px solid rgba(255,255,255,.12);color:#9caad0;font:700 11.5px Arial,sans-serif;padding:0 11px;border-radius:12px;cursor:pointer;transition:.15s;white-space:nowrap}
.ma-tbtn:hover{border-color:#3b4a73;color:#cfd8f7}.ma-tbtn.on{background:rgba(75,115,224,.2);border-color:#6ea8ff;color:#d6e5ff}
/* a wave = one row: its label + the bosses on it as bubbles (and the editor of an open boss underneath) */
.ma-wv{display:grid;grid-template-columns:64px minmax(0,1fr);gap:6px 8px;align-items:center;padding:5px 0}
.ma-wv+.ma-wv{border-top:1px solid rgba(255,255,255,.05)}
.ma-wv-l{align-self:stretch;display:flex;flex-direction:column;justify-content:center;padding:0 4px;border-radius:12px;cursor:pointer;min-width:0}
.ma-wv-l:hover{background:rgba(255,255,255,.04)}
.ma-wv-l b{font:800 13px Arial,sans-serif;color:#cfd8f7}.ma-wv-l small{font-size:10.5px;color:#7c88ad;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ma-wv-l.on b{color:#8fb7ff}
.ma-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;min-width:0}
.ma-grid.solo{padding:4px 0 0}
.ma-bb{position:relative;display:flex;align-items:center;gap:8px;min-width:0;padding:6px 9px 6px 7px;border-radius:14px;background:#0f1628;border:1px solid rgba(255,255,255,.06);cursor:pointer;transition:.15s}
.ma-bb:hover{background:#141d38}
.ma-bb.on{background:rgba(75,115,224,.11);border-color:rgba(110,168,255,.38)}
.ma-bb.open{border-color:#6ea8ff;box-shadow:0 0 0 2px rgba(110,168,255,.16)}
.ma-bb-n{flex:1;min-width:0}
.ma-bb-n b{display:block;font:700 12px/1.25 Arial,sans-serif;color:#eef3ff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ma-bb-n small{display:block;color:#7c88ad;font-size:10.5px;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ma-bb-n small .st-ok{color:#8ee6a8}.ma-bb-n small .st-warn{color:#ffd978}.ma-bb-n small .st-cap{color:#8fb7a0}.ma-bb-n small .st-blue{color:#9fc1ff}.ma-bb-n small .st-err{color:#ff9aa6}
.ma-bb-n small .capv{color:#aeb9dc;font-weight:700}.ma-bb-n small .ma-rl{color:#ffd978;font-weight:800}
/* the editor of an open boss */
.ma-big{display:flex;align-items:center;gap:10px;margin-bottom:7px}.ma-big .ma-in{font:800 17px Arial,sans-serif;padding:7px 10px}.ma-big small{color:#7c88ad;font-size:11px;line-height:1.35}
.ma-ed{grid-column:1/-1;margin:1px 0 3px;padding:9px 11px 10px;background:#16213f;border:1px solid rgba(110,168,255,.34);border-radius:16px}.ma-ed .ma-in,.ma-bulk .ma-in{background:#101a33}
.ma-ed-h{display:flex;align-items:center;gap:8px;margin-bottom:4px}.ma-ed-t{flex:1;min-width:0;display:flex;align-items:center;gap:4px 8px;flex-wrap:wrap}.ma-ed-t b{font:800 13px Arial,sans-serif;color:#fff;overflow-wrap:anywhere}
.ma-ed-t small{display:flex;align-items:center;gap:6px;flex-wrap:wrap;color:#7c88ad;font-size:10.5px}
.ma-in.off,.ma-in:disabled{opacity:.45;cursor:not-allowed}   /* Auto is choosing: plain greyed-out disabled, same look as any disabled control */
.ma-origin{margin:9px 0 0;padding:9px 11px;border-radius:14px;background:linear-gradient(180deg,#1c2a52,#162241);border:1px solid rgba(255,255,255,.08)}
.ma-origin-r{display:flex;align-items:center;gap:8px 12px;flex-wrap:wrap}.ma-origin-t{flex:1;min-width:150px}.ma-origin-b{display:flex;align-items:center;gap:6px;flex:0 0 auto}.ma-origin-b .core-btn{padding:6px 14px;font-size:12px}
.ma-origin-t b{display:block;font:800 12px Arial,sans-serif;color:#fff}.ma-origin-t small{display:block;color:#8b97bd;font-size:10.5px;margin-top:2px;line-height:1.35}
.ma-ld{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:6px;margin:2px 0 2px}
.ma-ld label{display:block;font:800 9.5px Arial,sans-serif;color:#6e7a9c;text-transform:uppercase;letter-spacing:.06em;margin:0 3px 3px}
.ma-ld select{width:100%;text-overflow:ellipsis}
.ma-capbar{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-bottom:9px}.ma-capbar .ma-in{font:800 14px Arial,sans-serif;padding:5px 9px}
.ma-capmeta{display:flex;align-items:center;gap:5px;flex-wrap:wrap;flex:1;min-width:120px}.ma-capmeta small{color:#6e7a9c;font-size:10.5px}
.ma-pill.xp{color:#d9c4ff;border-color:rgba(160,122,216,.4);background:rgba(160,122,216,.12)}
.ma-segs{display:inline-flex;gap:2px;align-items:center}.ma-segs i{width:9px;height:5px;border-radius:2px;background:#27324f}.ma-segs i.on{background:#4b73e0}
.ma-lvs{display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:8px}
.ma-lv{position:relative;display:flex;flex-direction:column;gap:9px;padding:13px 9px 9px;background:linear-gradient(180deg,#1c2a52,#162241);border:1px solid rgba(255,255,255,.08);border-radius:14px;cursor:pointer;transition:.15s;overflow:hidden;min-width:0}
.ma-lvh{display:flex;align-items:center;gap:5px;min-height:16px}.ma-lvh b{margin-right:auto}.ma-lvx{color:#d9c4ff;font-size:12px;line-height:1}
.ma-lv::before{content:'';position:absolute;left:0;right:0;top:0;height:3px;background:#2a375f}
.ma-lv:hover{border-color:rgba(159,193,255,.4)}
.ma-lv.got::before{background:linear-gradient(90deg,#3f6be0,#6ea8ff)}
.ma-lv:not(.got){background:#131c36;border-style:dashed;border-color:rgba(255,255,255,.1)}
.ma-lv:not(.got) .ma-lvt{opacity:.5;filter:grayscale(.8)}
.ma-lv.on{background:linear-gradient(180deg,#2a3c72,#1f2f5d);border-color:#6ea8ff;box-shadow:0 0 0 2px rgba(110,168,255,.28),0 6px 16px rgba(20,40,110,.35)}.ma-lv.on::before{background:#b4d0ff}
.ma-lv.on .ma-lvh::after{content:'✓';display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;background:#6ea8ff;color:#0b1430;font:800 10px Arial,sans-serif}
.ma-lv b{font:800 14px Arial,sans-serif;color:#7c89b2;letter-spacing:.01em}.ma-lv.got b{color:#fff}.ma-lv.exp b{color:#d9c4ff}
.ma-timed-bar{display:flex;align-items:center;justify-content:space-between;width:100%;box-sizing:border-box;margin-top:9px;padding:10px 13px;background:#101a33;border:1px solid rgba(255,255,255,.1);border-radius:12px;color:#cfe0ff;font:700 12px Arial,sans-serif;cursor:pointer;text-align:left}.ma-timed-bar:hover{border-color:rgba(159,193,255,.4);background:#14203d}.ma-timed-bar.open{border-color:rgba(110,168,255,.5)}.ma-timed-bar i{font-style:normal;color:#7fa6ff}
.ma-lc{content-visibility:auto;contain-intrinsic-size:auto 56px}
.ma-rgs{display:flex;flex-direction:column}
.ma-rg{position:relative;display:grid;grid-template-columns:16px 52px minmax(0,1fr);align-items:center;gap:6px;padding:7px 8px 7px 6px;border-radius:12px;cursor:pointer;transition:.15s;min-width:0}
.ma-rg::before{content:'';position:absolute;left:13px;top:0;bottom:0;width:2px;background:#27324f}.ma-rg:first-child::before{top:50%}.ma-rg:last-child::before{bottom:50%}.ma-rg.got::before{background:#4b73e0}
.ma-rg-n{position:relative;z-index:1;width:12px;height:12px;margin-left:2px;box-sizing:border-box;border-radius:50%;background:#131c36;border:2px solid #34416b}
.ma-rg.got .ma-rg-n{background:#4b73e0;border-color:#6ea8ff}.ma-rg.on .ma-rg-n{background:#dce9ff;border-color:#6ea8ff;box-shadow:0 0 0 3px rgba(110,168,255,.3)}
.ma-rg:hover{background:rgba(110,168,255,.08)}.ma-rg.on{background:linear-gradient(90deg,rgba(75,115,224,.24),rgba(75,115,224,.05));box-shadow:inset 0 0 0 1px rgba(110,168,255,.45)}
.ma-rg-b{display:flex;flex-direction:column;align-items:flex-start;gap:1px}.ma-rg-v{display:flex;align-items:center;gap:4px}.ma-rg-b b{font:800 14px Arial,sans-serif;color:#7c89b2}.ma-rg.got .ma-rg-b b{color:#fff}.ma-rg.exp .ma-rg-b b{color:#d9c4ff}
.ma-rg-i{display:flex;flex-wrap:wrap;gap:5px 6px;justify-content:flex-start;align-items:center;min-width:0}
.ma-it{display:inline-flex;align-items:center;gap:5px;min-width:0;border-radius:8px;padding-right:7px;background:rgba(110,168,255,.12)}
.ma-rg:not(.got) .ma-it{opacity:.4;filter:grayscale(.8);background:none}
.ma-it.ph{background:rgba(217,196,255,.16);box-shadow:inset 0 0 0 1px rgba(217,196,255,.35)}.ma-rg.lock{cursor:default;opacity:.55}.ma-rg.lock .ma-it{filter:grayscale(.8);background:none}.ma-rg.lock:hover{background:none}.ma-lockh{margin:8px 2px 2px;font:700 11px Arial,sans-serif;color:#9aa6c9}
.ma-it .ma-ti{width:26px;height:26px;aspect-ratio:auto;flex:0 0 26px;border-radius:7px}.ma-rg.got .ma-ti{border-color:rgba(110,168,255,.7)}
.ma-it em{font:700 10.5px Arial,sans-serif;font-style:normal;color:#cfe0ff;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ma-rg .ma-none{justify-self:start;color:#d9c4ff;background:rgba(160,122,216,.14);border:1px solid rgba(160,122,216,.35);border-radius:999px;font:700 10px Arial,sans-serif;padding:3px 8px;letter-spacing:.03em}
.ma-lvt{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px;align-content:start}
.ma-ti{aspect-ratio:1;min-width:0;box-sizing:border-box;border-radius:8px;overflow:hidden;border:1px solid #33406a;background:#131c38;display:flex;align-items:center;justify-content:center}.ma-ti.more{font:800 10px Arial,sans-serif;color:#9caad0}
.ma-lv.got .ma-ti{border-color:rgba(110,168,255,.7)}
.ma-ti img{width:100%;height:100%;object-fit:contain;display:block}
.ma-ti-fb{width:100%;height:100%;display:flex;align-items:center;justify-content:center;font:800 9px Arial,sans-serif;color:#fff}
.ma-ti.xp{border-color:#a07ad8;background:#2a2050;color:#e3d3ff;font:800 17px Arial,sans-serif}
.ma-lv .ma-none{align-self:flex-start;color:#d9c4ff;background:rgba(160,122,216,.14);border:1px solid rgba(160,122,216,.35);border-radius:999px;font:700 10px Arial,sans-serif;padding:3px 8px;letter-spacing:.03em}
/* select several bosses: the check on a bubble, and the bar that applies one setup to all of them */
.ma-ck{flex:0 0 auto;width:20px;height:20px;box-sizing:border-box;border-radius:50%;border:2px solid #33406a;display:flex;align-items:center;justify-content:center;font:900 11px Arial,sans-serif;color:#fff}
.ma-bb.pick{background:rgba(75,115,224,.2);border-color:#6ea8ff}.ma-bb.rlw{border-color:#e3b341;box-shadow:0 0 0 1px rgba(227,179,65,.25)}.ma-bb.pick .ma-ck{background:#4b73e0;border-color:#6ea8ff}
.ma-bulk{position:sticky;top:0;z-index:3;margin:0 0 8px;padding:12px 12px 12px;background:#131d38;border:1px solid rgba(110,168,255,.45);border-radius:14px;box-shadow:0 6px 16px rgba(0,0,0,.35)}
.ma-bk-sel{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:6px;margin-top:7px}.ma-bk-sel select{width:100%;text-overflow:ellipsis}
@media (max-height:720px){.ma-bulk{position:static}}
.ma-bk-h{display:flex;align-items:center;gap:2px;flex-wrap:wrap;margin-top:9px}.ma-bk-l{font:800 9.5px Arial,sans-serif;color:#6e7a9c;text-transform:uppercase;letter-spacing:.06em;margin:0 6px 0 3px}
.ma-bulk .ma-card-h .core-btn{padding:5px 12px;font-size:11.5px}
.ma-bk-from{margin:2px 0 0;color:#9fc1ff;font-size:11px}
.ma-bulk .ma-ld{margin-top:9px}.ma-bulk .ma-in.chg{border-color:#6ea8ff}
.ma-bk-cap{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-top:7px}.ma-bk-cap label{font:800 9.5px Arial,sans-serif;color:#6e7a9c;text-transform:uppercase;letter-spacing:.06em;margin:0 3px}
.ma-bk-go{display:flex;align-items:center;gap:9px;margin-top:8px}.ma-bk-go span{flex:1;min-width:0;font-size:11px;color:#9fb0dc;line-height:1.35}.ma-bk-go .core-btn{padding:7px 16px;font-size:12px}.ma-bk-go .core-btn:disabled{opacity:.4;cursor:default;pointer-events:none}
.ma-what{margin:7px 3px 0;color:#7c88ad;font-size:11px;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ma-reset{display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-top:9px;padding-top:6px;border-top:1px solid rgba(255,255,255,.06)}.ma-reset .sp{flex:1}
.ma-link.warn{color:#ff9b9b}.ma-link.warn:hover{color:#ffc4c4;background:rgba(255,120,120,.1)}
.ma-sched{margin-top:8px;padding:7px 10px;background:#101a33;border:1px solid rgba(255,255,255,.06);border-radius:14px}
.ma-sub-h{display:flex;align-items:center;gap:8px;color:#c4cdeb;font:700 11.5px Arial,sans-serif;margin-bottom:4px}.ma-sub-h .sp{flex:1}.ma-sub-h small{font-weight:400;color:#6e7a9c}
.ma-srow{display:grid;grid-template-columns:112px auto minmax(0,1fr) 24px;align-items:center;gap:7px;margin:1px -5px;padding:3px 5px;border-radius:12px}.ma-srow .arrow{color:#53608a}
.ma-srow{position:relative}.ma-srow>*{position:relative;z-index:1}
.ma-srow.now::before{content:'';position:absolute;z-index:0;left:0;top:0;bottom:0;right:36px;border-radius:12px;background:rgba(61,220,151,.09)}.ma-srow.now .arrow{color:#3ddc97}
.ma-srow .ma-num{position:relative;display:flex;width:100%}.ma-srow .ma-num .ma-in{flex:1 1 auto;width:auto;min-width:0}
.ma-srow .ma-num i{position:absolute;right:11px;top:50%;transform:translateY(-50%);pointer-events:none}.ma-srow .ma-num.u .ma-in{padding-right:58px}
.ma-srow .ma-in,.ma-time{height:30px;box-sizing:border-box}
.ma-time{display:flex;align-items:stretch;width:100%;min-width:0;border:1px solid rgba(255,255,255,.12);border-radius:10px;overflow:hidden;background:#101a33;transition:.15s}
.ma-time:focus-within{border-color:#6ea8ff;box-shadow:0 0 0 2px rgba(110,168,255,.18)}
.ma-time input,.ma-time .t{flex:1 1 0;min-width:0;border:none;background:transparent;color:#eef3ff;font:12.5px Arial,sans-serif;font-variant-numeric:tabular-nums;width:auto;padding:0;text-align:center}
.ma-time input:focus{outline:none;background:rgba(75,115,224,.2)}.ma-time span{display:flex;align-items:center;justify-content:center;color:#6e7a9c}.ma-time .ma-ampm{display:flex;align-items:center}
.ma-time.ro{opacity:.45}
.ma-ampm{flex:0 0 auto;border:none;border-left:1px solid rgba(255,255,255,.12);background:transparent;color:#9fb0e0;font:800 10px Arial,sans-serif;padding:0 10px;cursor:pointer;letter-spacing:.03em}.ma-ampm:hover{background:#18213b;color:#fff}
.ma-x{background:transparent;border:none;color:#6e7a9c;cursor:pointer;width:24px;height:24px;border-radius:50%;font-size:11px;flex:0 0 auto}.ma-x:hover{background:#1c2644;color:#ff9aa6}
.ma-add{width:100%;margin-top:3px;background:transparent;border:1px dashed #33406a;color:#9fb0e0;border-radius:12px;padding:5px 0;font:700 11px Arial,sans-serif;cursor:pointer}.ma-add:hover{border-color:#6ea8ff;color:#fff}
/* avatars */
.ma-av-wrap{position:relative;flex:0 0 auto;width:32px;height:32px}.ma-av-wrap.lg{width:46px;height:46px}.ma-av-wrap.xs{width:26px;height:26px}
.ma-av,.ma-av-fb{width:100%;height:100%;border-radius:11px;display:block}.ma-av-wrap.lg .ma-av,.ma-av-wrap.lg .ma-av-fb{border-radius:13px}
.ma-av{object-fit:cover;background:#0d1322;border:1px solid rgba(255,255,255,.1);box-sizing:border-box}
.ma-av-fb{display:flex;align-items:center;justify-content:center;font:800 14px Arial,sans-serif;color:#fff}.ma-av-wrap.lg .ma-av-fb{font-size:18px}.ma-av-wrap.xs .ma-av-fb{font-size:11px;border-radius:8px}
.ma-crown{position:absolute;bottom:-3px;right:-3px;width:14px;height:14px;border-radius:50%;background:#e3b341;border:2px solid #11192d;color:#3a2c04;font:900 7px/10px Arial,sans-serif;text-align:center}
.ma-bb .ma-crown{border-color:#0f1628}
.ma-bb .ma-dot{position:absolute;top:-2px;left:-2px;width:10px;height:10px;border:2px solid #0f1628;box-shadow:none}
/* overview */
.ma-hero{padding:10px 12px;border-radius:18px;background:linear-gradient(135deg,#17233f,#11192d);border:1px solid rgba(110,168,255,.22);margin-bottom:7px}
.ma-hero-top{display:flex;align-items:center;gap:11px}
.ma-hero-t{flex:1;min-width:0}
.ma-state{display:flex;align-items:center;gap:6px;font:800 10px Arial,sans-serif;text-transform:uppercase;letter-spacing:.07em;color:#8b97bd}
.ma-hero-name{font:800 14.5px/1.25 Arial,sans-serif;color:#fff;margin-top:2px;overflow-wrap:anywhere}
.ma-hero-sub{color:#9aa7cf;font-size:11.5px;margin-top:2px}
.ma-dot{width:8px;height:8px;border-radius:50%;background:#ff6b7a;flex:0 0 auto}.ma-dot.running{background:#33b57f;box-shadow:0 0 0 3px rgba(51,181,127,.2)}.ma-dot.waiting{background:#e3b341}.ma-dot.follower{background:#6e7a8c}
.ma-dot.s-ok{background:#33b57f}.ma-dot.s-warn{background:#e3b341}.ma-dot.s-cap{background:#6e8f7c}.ma-dot.s-blue{background:#6ea8ff}.ma-dot.s-err{background:#ff6b7a}
.ma-bar{height:6px;border-radius:99px;background:#0a0f1c;border:1px solid rgba(255,255,255,.05);overflow:hidden}.ma-bar i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#3657a7,#6ea8ff);transition:width .3s}
.ma-bar.done i{background:linear-gradient(90deg,#217f5b,#33b57f)}
.ma-hero .ma-bar{margin-top:8px}
.ma-vitals{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:6px;margin-bottom:7px}
.ma-meter{background:#11192d;border:1px solid rgba(255,255,255,.06);border-radius:14px;padding:6px 10px}
.ma-meter-top{display:flex;justify-content:space-between;gap:6px;white-space:nowrap;font-size:10px;color:#8b97bd;margin-bottom:4px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}.ma-meter-top span{min-width:0;overflow:hidden;text-overflow:ellipsis}.ma-meter-top b{flex:none;color:#fff;font-size:11px;text-transform:none;letter-spacing:0}
.ma-meter .ma-bar{height:5px}
.ma-meter.hp i{background:linear-gradient(90deg,#b4465c,#ff6b7a)}.ma-meter.st i{background:linear-gradient(90deg,#b08a1d,#e3b341)}.ma-meter.mp i{background:linear-gradient(90deg,#3657a7,#6ea8ff)}.ma-meter.xp i{background:linear-gradient(90deg,#7a4fc4,#a371f7)}
.ma-q{display:flex;align-items:center;gap:9px;padding:5px 6px;border-radius:14px;cursor:pointer}.ma-q:hover{background:rgba(255,255,255,.035)}
.ma-q-n{flex:1;min-width:0}.ma-q-n b{display:block;font:700 12px Arial,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ma-q-n .ma-bar{height:4px;margin-top:3px}
.ma-sum{display:flex;align-items:center;flex-wrap:wrap;gap:5px;margin:8px 2px 2px}.ma-sum .ma-link{margin-left:auto}
.ma-minis{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:4px;margin-top:6px}
.ma-mini{display:flex;align-items:center;gap:7px;min-width:0;padding:4px 7px;background:#0d1322;border:1px solid #1d2742;border-radius:11px;cursor:pointer}.ma-mini:hover{border-color:#3b4a73}
.ma-mini>div{min-width:0}.ma-mini b{display:block;font:700 11px Arial,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ma-mini small{display:block;font-size:10px;color:#7c88ad;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ma-q small{color:#7c88ad;font-size:10.5px;margin-top:2px;display:block}
.ma-stats{display:flex;gap:5px;flex-wrap:wrap;margin:2px 0 6px}
.ma-stat{background:#0d1322;border:1px solid rgba(255,255,255,.06);border-radius:999px;padding:4px 10px;font-size:11px;color:#9aa7cf}.ma-stat b{color:#fff;margin-left:4px}
.ma-actions.ma-block{margin:9px 0 0}.ma-actions.ma-block .core-btn{flex:1 1 100%;width:100%;text-align:center}
.ma-actions{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 8px}.ma-actions .core-btn{padding:6px 12px;font-size:11.5px}
/* graveyard */
.ma-lc{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:16px;background:#11192d;border:1px solid rgba(255,255,255,.06);margin-bottom:5px}
.ma-lc-n{flex:1;min-width:0}.ma-lc-n b{display:block;font:700 12.5px/1.3 Arial,sans-serif}.ma-lc-n small{display:block;color:#7c88ad;font-size:11px}
.ma-claim{background:linear-gradient(135deg,#217f5b,#33b57f)!important;box-shadow:0 6px 14px rgba(33,127,91,.28)!important;padding:6px 13px!important;font-size:11.5px!important}
/* activity */
.ma-log{display:flex;flex-direction:column;gap:4px;max-height:460px;overflow-y:auto;padding-right:2px}
.ma-log::-webkit-scrollbar{width:6px}.ma-log::-webkit-scrollbar-thumb{background:#2b3859;border-radius:4px}
.ma-ll{padding:5px 10px;border-radius:12px;border-left:3px solid #2b3859;background:#0d1322;font:11.5px/1.4 Arial,sans-serif;color:#c9d4f5;overflow-wrap:anywhere}
.ma-ll b{color:#6e7a8c;font-weight:400;margin-right:7px;font-variant-numeric:tabular-nums}
.ma-ll.ok{border-left-color:#33b57f;color:#8ee6a8}.ma-ll.warn{border-left-color:#e3b341;color:#ffd978}.ma-ll.err{border-left-color:#e5484d;color:#ff9a9a}
.ma-ll.dmg{border-left-color:#e3b341;color:#ffe3a3}.ma-ll.skill{border-left-color:#a371f7;color:#d9c4ff}.ma-ll.info{border-left-color:#6ea8ff;color:#c9e6ff}
.ma-ctl{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
/* footer: status + Start / Stop, always visible */
.ma-foot{position:sticky;bottom:0;z-index:2;display:flex;align-items:center;gap:10px;margin:8px -14px 0;padding:9px 14px 12px;background:#0e1422;border-top:1px solid rgba(255,255,255,.08);border-radius:0 0 24px 24px}
.ma-foot-st{flex:1;min-width:0}.ma-foot-st b{display:flex;align-items:center;gap:7px;font:800 11.5px Arial,sans-serif;color:#eef3ff;text-transform:uppercase;letter-spacing:.04em}
.ma-foot-st span{display:block;color:#8b97bd;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ma-foot-st .ma-bar{height:4px;margin-top:5px}
.ma-foot .core-btn{padding:8px 18px;font-size:12.5px;border-radius:12px}
.ma-foot .core-btn-success{box-shadow:0 8px 18px rgba(33,127,91,.3)}.ma-foot .core-btn-danger{box-shadow:0 8px 18px rgba(180,70,92,.3)}
.ma-kv{display:flex;justify-content:space-between;gap:10px;padding:3px 2px;font-size:11.5px;color:#aeb9dc}.ma-kv b{color:#fff}
@media (max-width:560px){.ma-two,.ma-tiers,.ma-grid{grid-template-columns:1fr}.ma-tab{padding:7px 7px}.ma-wv{grid-template-columns:1fr}.ma-wv-l{flex-direction:row;align-items:baseline;gap:8px;padding:2px 4px}}`;
    document.head.appendChild(s);
  })();

  /* ---- building blocks ---- */
  const ago = (t) => (t ? fmtDur(Date.now() - t) + ' ago' : 'never');
  const hueOf = (s) => { let x = 0; for (const c of String(s)) x = (x * 31 + c.charCodeAt(0)) >>> 0; return `hsl(${x % 360} 48% 40%)`; };
  const iconUrl = (i) => { if (!i) return null; try { return new URL(i, BASE).href; } catch (_) { return null; } };
  const badIcons = new Set();                                         // an icon that failed once is not requested again on every redraw
  const imgTag = (src, cls, fb) => (badIcons.has(src) ? fb() : h('img', Object.assign({ src, loading: 'lazy', decoding: 'async', alt: '', onerror: (e) => { badIcons.add(src); e.target.replaceWith(fb()); } }, cls ? { class: cls } : {})));
  function avatar(name, icon, o = {}) {
    const bg = hueOf(String(name || '?').toLowerCase()), letter = (String(name || '?').trim().charAt(0) || '?').toUpperCase();
    const fb = () => h('div', { class: 'ma-av-fb', style: { background: bg } }, letter), src = iconUrl(icon);
    const inner = src ? imgTag(src, 'ma-av', fb) : fb();
    return h('span', { class: 'ma-av-wrap' + (o.size ? ' ' + o.size : '') }, inner, o.boss ? h('span', { class: 'ma-crown', title: 'Boss' }, '♛') : null, o.dot ? h('i', { class: 'ma-dot s-' + o.dot }) : null);
  }
  const stop = (e) => e.stopPropagation();
  const sw = (get, set, o = {}) => h('label', { class: 'ma-sw' + (o.sm ? ' sm' : ''), onclick: stop },
    h('input', { type: 'checkbox', checked: get() ? true : null, onclick: stop, onchange: (e) => { set(e.target.checked); saveCfg(); if (o.redraw !== false) draw(); } }), h('span', { class: 'ma-sl' }));
  const seg = (opts, cur, set, o = {}) => h('div', { class: 'ma-seg' + (o.full ? ' full' : '') }, opts.map(([v, label, tip]) =>
    h('button', { type: 'button', title: tip || null, class: 'ma-seg-btn' + (String(v) === String(cur) ? ' on' : ''), onclick: (e) => { stop(e); if (String(v) !== String(cur)) { set(v); saveCfg(); draw(); } } }, label)));
  const chips = (opts, cur, set) => h('div', { class: 'ma-chips' }, opts.map(([v, label]) => h('button', { type: 'button', class: 'ma-chip' + (String(v) === String(cur) ? ' on' : ''), onclick: (e) => { stop(e); set(v); saveCfg(); draw(); } }, label)));
  const dropdown = (opts, cur, set, off, tip) => h('select', Object.assign({ class: 'ma-in' + (off ? ' off' : ''), onclick: stop, onchange: (e) => { set(e.target.value); saveCfg(); draw(); } }, off ? { disabled: true, title: tip || 'Off while Auto is on' } : {}),
    opts.map(([v, l]) => h('option', Object.assign({ value: v }, String(v) === String(cur) ? { selected: true } : {}), l)));
  const num = (get, set, o = {}) => h('span', { class: 'ma-num' }, h('input', { class: 'ma-in', inputmode: 'decimal', style: o.w ? { width: o.w + 'px' } : null, value: o.fmt ? o.fmt(get()) : get(), onclick: stop,
    onchange: (e) => { const n = (o.parse || parseCap)(e.target.value); if (n != null && Number.isFinite(n) && (o.min == null || n >= o.min) && (o.max == null || n <= o.max)) { set(n); saveCfg(); e.target.value = o.fmt ? o.fmt(n) : n; } else e.target.value = o.fmt ? o.fmt(get()) : get(); } }),
    o.unit ? h('i', {}, o.unit) : null);
  const setting = (title, desc, ctl) => h('div', { class: 'ma-set' }, h('div', { class: 'ma-set-t' }, h('b', {}, title), desc ? h('small', {}, desc) : null), ctl);
  const field = (label, hint, ...kids) => h('div', { class: 'ma-fld' }, h('div', { class: 'ma-lbl' }, label, hint ? h('small', {}, hint) : null), ...kids);
  const caption = (t) => h('div', { class: 'ma-cap' }, t);
  const note = (t) => h('div', { class: 'ma-note' }, t);
  const pill = (txt, kind) => h('span', { class: 'ma-pill' + (kind ? ' ' + kind : '') }, txt);
  const fold = (key, dflt, head, body, o = {}) => {
    const op = o.force || isOpen(key, dflt);
    return h('div', { class: 'ma-fold' + (op ? ' open' : '') + (o.sub ? ' sub' : '') },
      h('div', { class: 'ma-fold-h', onclick: () => { ui.open[key] = !op; saveUi(); draw(); } }, h('span', { class: 'ma-fch' }, '▸'), h('span', { class: 'ma-fold-t' }, ...[].concat(head)), ...(o.aside ? [].concat(o.aside) : [])),
      op ? h('div', { class: 'ma-fold-b' }, ...[].concat(body())) : null);
  };
  const card = (icon, title, desc, on, setOn, body) => h('div', { class: 'ma-card' + (on ? '' : ' off') },
    h('div', { class: 'ma-card-h' }, h('span', { class: 'ma-ico' }, icon), h('div', { class: 'ma-card-t' }, h('b', {}, title), h('small', {}, desc)), setOn ? sw(() => on, setOn) : null),
    body ? h('div', { class: 'ma-card-b' }, ...[].concat(body)) : null);

  // settings rows: [icon] title / description ........ control; the options of an enabled row sit in a line under it
  const srow = (icon, title, desc, ctl, opts) => { opts = (opts || []).filter(Boolean); return h('div', { class: 'ma-sr-w' },
    h('div', { class: 'ma-sr' }, h('span', { class: 'ma-ico' }, icon), h('div', { class: 'ma-set-t' }, h('b', {}, title), desc ? h('small', {}, desc) : null), ctl),
    opts.length ? h('div', { class: 'ma-sr-o' }, ...opts) : null); };
  const opt = (label, ctl, hint, mode) => h('div', { class: 'ma-opt' + (mode ? ' wide' : '') + (mode === 'row' ? ' row' : '') }, h('span', { class: 'ma-opt-l' }, label), ctl, hint ? h('small', {}, hint) : null);
  const group = (...rows) => h('div', { class: 'ma-card ma-grp' }, ...rows.filter(Boolean));

  /* ---- time helpers (server clock) ---- */
  const toMin = (at) => { const [hr, mi] = String(at || '00:00').split(':').map(Number); return (hr || 0) * 60 + (mi || 0); };
  const fmtClock = (mins) => { const hr = Math.floor(mins / 60) % 24, mi = mins % 60; return `${(hr % 12) || 12}:${String(mi).padStart(2, '0')} ${hr >= 12 ? 'PM' : 'AM'}`; };
  const hhmm = (mins) => String(Math.floor(mins / 60) % 24).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0');
  function timePicker(at, onSet) {
    const hr = Math.floor(toMin(at) / 60), mi0 = toMin(at) % 60;
    let st = { h12: (hr % 12) || 12, mi: mi0, pm: hr >= 12 };
    const hi = h('input', { maxlength: 2, inputmode: 'numeric', value: String(st.h12).padStart(2, '0'), onclick: (e) => { stop(e); e.target.select(); } });
    const mi = h('input', { maxlength: 2, inputmode: 'numeric', value: String(st.mi).padStart(2, '0'), onclick: (e) => { stop(e); e.target.select(); } });
    const commit = () => {
      let a = parseInt(hi.value, 10), b = parseInt(mi.value, 10);
      if (!(a >= 1 && a <= 12)) a = st.h12; if (!(b >= 0 && b <= 59)) b = st.mi;
      st = { h12: a, mi: b, pm: st.pm }; onSet(String((a % 12) + (st.pm ? 12 : 0)).padStart(2, '0') + ':' + String(b).padStart(2, '0'));
    };
    hi.addEventListener('change', commit); mi.addEventListener('change', commit);
    return h('div', { class: 'ma-time' }, hi, h('span', {}, ':'), mi, h('button', { type: 'button', class: 'ma-ampm', title: 'Toggle AM / PM', onclick: (e) => { stop(e); st.pm = !st.pm; commit(); } }, st.pm ? 'PM' : 'AM'));
  }

  /* ---- boss helpers ---- */
  const ovr = (low) => cfg.bosses[low] || (cfg.bosses[low] = {});
  const baseCap = (low) => baseCapOf(low);
  const short = (n) => fmtNum(n).replace(/\.?0+([TBMK])$/, '$1');   // 3.00B -> 3B, 1.50B -> 1.5B
  let tSet = null, tSrc = null, tN = -1;                              // the selected bosses as a Set (the list is changed in place and replaced, so check both)
  const targetSet = () => { if (tSrc !== cfg.targets || tN !== cfg.targets.length) { tSrc = cfg.targets; tN = cfg.targets.length; tSet = new Set(cfg.targets); } return tSet; };
  const isOn = (def) => { const t = targetSet(); return Roster.members(def).some((m) => t.has(m.low)); };
  const iconOfBoss = (low) => { const e = Board.get(low); return e && e.icon; };
  const waveOf = (def) => { const l = bossLoc(def.low); return l ? l.wave : 0; };
  function bossState(low) {
    const def = Roster.get(low), e = Board.get(low), cap = bossCap(low); if (!def) return ['?', 'err'];
    if (cap <= 0) return ['skipped', ''];
    if (!e || !e.seenAt) return ['not scanned', 'warn'];
    if (def.kind === 'dungeon-swarm') return [`${(e.swarm || []).length} open`, (e.swarm || []).length ? 'ok' : ''];
    if (e.alive) { if (e.needsDuel) return ['needs duel', 'warn']; return Board.baseKnown(low) && (e.userDmg || 0) >= cap + Board.base(low) ? ['capped', 'cap'] : ['alive', 'ok']; }
    if (e.locked) return ['locked', 'warn'];
    if (e.noInstance) return ['no dungeon', ''];
    if (e.nextTs && e.nextTs * 1000 > Date.now()) return ['respawn ' + fmtDur(e.nextTs * 1000 - Date.now()), 'blue'];
    return ['not up', ''];
  }
  function entryState(def) {   // the phase that is actually up, else the first
    const ms = Roster.members(def), live = ms.find((m) => { const e = Board.get(m.low); return e && e.alive; });
    return bossState((live || ms[0]).low);
  }
  function nextChange(low) {
    const d = Roster.get(low), o = cfg.bosses[low]; if (!d || d.kind === 'wave' || !o || !Array.isArray(o.schedule) || !o.schedule.length) return null;   // timed caps are for dungeon bosses
    const now = serverMinutes(); if (now == null) return null;
    return o.schedule.map((b) => ({ t: toMin(b.at), cap: b.cap })).sort((a, b) => a.t - b.t).find((b) => b.t > now) || null;
  }
  let idxMap = null, idxN = -1;                                       // roster position by name, rebuilt only when the roster changes
  const rIdx = (low) => { if (!idxMap || idxN !== Roster.list.length) { idxMap = new Map(); Roster.list.forEach((d, i) => idxMap.set(d.low, i)); idxN = Roster.list.length; } const d = Roster.get(low); return d ? idxMap.get(d.low) : -1; };
  function setMany(defs, on) {
    defs.forEach((def) => {
      const ms = Roster.members(def);
      if (on) ms.forEach((m) => { if (!cfg.targets.includes(m.low)) cfg.targets.push(m.low); });
      else cfg.targets = cfg.targets.filter((l) => !ms.some((m) => m.low === l));
    });
    cfg.targets.sort((x, y) => rIdx(x) - rIdx(y));          // no manual ordering: strongest-listed first, same order as the Bosses tab
    saveCfg(); Engine.poke(true); draw();
  }
  const selectedEntries = () => { const seen = new Set(), out = []; cfg.targets.forEach((low) => { const d = Roster.get(low); if (!d) return; const c = Roster.canon(d); if (!seen.has(c.low)) { seen.add(c.low); out.push(c); } }); return out.sort((x, y) => rIdx(x.low) - rIdx(y.low)); };

  /* ---- footer (always visible): status + Start / Stop ---- */
  const STATE_TXT = { FIGHTING: 'Fighting', RUNNING: 'Running', SCANNING: '🔎 Scanning bosses', GRAVEYARD: '🪦 Scanning graveyard', WAITING: 'Waiting for a boss', 'NO STAMINA': 'Out of stamina', DUEL: 'Phase duel', SWITCHING: '🎒 Switching build', PLANNING: '🧭 Planning build order', PAUSED: 'Paused', STOPPED: 'Stopped', FOLLOWER: 'Another tab is running it' };
  const dotOf = (st) => (!Tab.isMain() ? 'follower' : /FIGHT|RUN|DUEL|SCAN|GRAVE|SWITCH|PLAN/.test(st) ? 'running' : /WAIT|STAMINA/.test(st) ? 'waiting' : /PAUSE/.test(st) ? 'follower' : '');
  function footer() {
    const st = Status.get(), cur = Engine.current(), run = Run.wanted() && !Run.paused();
    const wk = Work.get('build') || Work.get('scan'), sub = wk ? (wk.step ? `${wk.label} · ${wk.step}${wk.total > 1 ? ` (${Math.min(wk.done + 1, wk.total)}/${wk.total})` : ''}` : wk.label) : cur ? '🎯 ' + cur.name : (Tab.isMain() ? (cfg.targets.length ? 'no target right now' : 'no bosses selected') : 'this tab is following');
    return h('div', { class: 'ma-foot' },
      h('div', { class: 'ma-foot-st' }, h('b', {}, h('i', { class: 'ma-dot ' + dotOf(st) }), STATE_TXT[st] || st), h('span', { title: sub }, sub), wk && wk.total > 1 ? h('div', { class: 'ma-bar' }, h('i', { style: { width: Math.max(6, pctOf({ done: wk.done + 0.5, total: wk.total })).toFixed(1) + '%' } })) : null),
      run ? btn('⏹ Stop', 'danger', () => { Run.stop('stopped from the panel'); draw(); }) : btn('▶ Start', 'success', () => { Run.start(); draw(); }));
  }
  const go = (t) => { tab = t; ui.tab = t; saveUi(); draw(); };
  const tabsBar = () => h('div', { class: 'ma-tabs' }, TABS.map(([id, label, ico]) => h('button', { type: 'button', class: 'ma-tab' + (id === tab ? ' on' : ''), onclick: () => go(id) }, ico + ' ' + label)));

  /* =================================================== OVERVIEW =================================================== */
  const meter = (label, cur, max, cls, known, txt) => {
    const pct = known && max > 0 ? Math.min(100, cur / max * 100) : 0;
    return h('div', { class: 'ma-meter ' + cls }, h('div', { class: 'ma-meter-top' }, h('span', {}, label), h('b', {}, known ? (txt || `${fmtNum(cur)} / ${fmtNum(max)}`) : '—')), h('div', { class: 'ma-bar' }, h('i', { style: { width: pct.toFixed(1) + '%' } })));
  };
  function tHome() {
    const st = Status.get(), cur = Engine.current(), out = [];
    const gi = Guard.info(); if (gi.faulted || gi.lastInfo) out.push(h('div', { class: 'ma-alert' }, '🔒 ' + (gi.lastInfo || gi.faulted) + (gi.lastInfo === 'unconfigured' ? ' — add a login source (Account Switcher) or sign in by hand' : '')));
    if (!Tab.isMain()) out.push(h('div', { class: 'ma-alert info' }, 'Another tab is the main one and does the attacking. This tab only shows what it is doing.', h('div', {}, btn('Take over this tab', 'soft', () => { Tab.takeOver(); }))));

    // hero: what it is doing right now
    let nextIn = null; try { const n = Scan.nextDueIn(); if (Number.isFinite(n)) nextIn = n; } catch (_) { /* */ }
    if (cur) {
      const ev = Board.get(cur.low) || {}, cap = bossCap(cur.low), dmg = Math.max(0, Math.max(ev.userDmg || 0, Board.dealt(cur)) - Board.base(cur.low)), bw = Work.get('build'), pct = bw && bw.total ? pctOf({ done: bw.done + 0.5, total: bw.total }) : cap > 0 ? Math.min(100, dmg / cap * 100) : 0;
      out.push(h('div', { class: 'ma-hero' }, h('div', { class: 'ma-hero-top' }, avatar(cur.name, ev.icon, { size: 'lg', boss: true }),
        h('div', { class: 'ma-hero-t' }, h('div', { class: 'ma-state' }, h('i', { class: 'ma-dot ' + dotOf(st) }), STATE_TXT[st] || st), h('div', { class: 'ma-hero-name' }, cur.name), h('div', { class: 'ma-hero-sub' }, bw ? `🎒 ${bw.step || bw.label}${bw.total > 1 ? ` · step ${Math.min(bw.done + 1, bw.total)} of ${bw.total}` : ''}` : `${fmtNum(dmg)} of ${fmtNum(cap)} damage · ${pct.toFixed(0)}%`))),
        h('div', { class: 'ma-bar' + (!bw && pct >= 100 ? ' done' : '') }, h('i', { style: { width: pct.toFixed(1) + '%' } }))));
    } else {
      const l = Diag.last(), why = l.reason ? `${l.reason}${l.detail ? ' — ' + l.detail : ''}` : '', wk = Work.get('build') || Work.get('scan');
      out.push(h('div', { class: 'ma-hero' }, h('div', { class: 'ma-hero-top' }, h('span', { class: 'ma-ico', style: { width: '50px', height: '50px', fontSize: '24px', borderRadius: '13px' } }, wk ? (st === 'GRAVEYARD' ? '🪦' : st === 'SWITCHING' ? '🎒' : st === 'PLANNING' ? '🧭' : '🔎') : Run.wanted() ? '⏳' : '💤'),
        h('div', { class: 'ma-hero-t' }, h('div', { class: 'ma-state' }, h('i', { class: 'ma-dot ' + dotOf(st) }), STATE_TXT[st] || st),
          h('div', { class: 'ma-hero-name' }, wk ? wk.label : !cfg.targets.length ? 'No bosses selected' : Run.wanted() ? 'No target right now' : 'Ready when you are'),
          h('div', { class: 'ma-hero-sub' }, wk ? (wk.total ? `${wk.step ? wk.step + ' · ' : ''}Step ${Math.min(wk.done + 1, wk.total)} of ${wk.total}` : 'One moment…') : !cfg.targets.length ? 'Pick what to farm in the Bosses tab.' : Run.wanted() && nextIn != null ? 'Next check in ' + fmtDur(nextIn) + (why ? ' · last skip: ' + why : '') : (why ? 'Last skip: ' + why : 'Press Start to begin.')))),
        wk && wk.total ? h('div', { class: 'ma-bar' }, h('i', { style: { width: pctOf({ done: wk.done + (wk.step ? 0.5 : 0), total: wk.total }).toFixed(1) + '%' } })) : null));
    }

    // vitals
    const xp = Me.expPct();
    out.push(h('div', { class: 'ma-vitals', style: { marginTop: '8px', marginBottom: 0 } },
      meter('HP', Me.hp, Me.maxHp, 'hp', Me.hpKnown), meter('Stam', Me.stam(), Me.maxStam(), 'st', Me.stamKnown()),
      meter('Mana', Me.mp, Me.maxMp, 'mp', Me.mpKnown), meter('Lv ' + (Me.level() || '?'), xp || 0, 100, 'xp', xp != null, xp != null ? xp.toFixed(1) + '%' : '')));

    // bosses being farmed: a one-line summary, the ones that are up right now, and everything else folded away
    const sel = selectedEntries();
    const go2 = (def) => () => { ui.bsec = def.kind === 'wave' ? 'waves' : 'dungeons'; ui.sel = def.low; go('bosses'); };
    const rows = sel.map((def) => { const [txt, kind] = entryState(def); return { def, txt, kind, live: (Roster.members(def).find((m) => { const e = Board.get(m.low); return e && e.alive; }) || def).low }; });
    const isUp = (r) => r.kind === 'ok' || r.txt === 'needs duel';                                   // up and under its cap, or waiting on a duel
    const upNow = rows.filter(isUp), rest = rows.filter((r) => !isUp(r));
    const bigRow = (r) => {
      const def = r.def, ev = Board.get(r.live) || {}, cap = bossCap(r.live), dmg = Math.max(0, (ev.userDmg || 0) - Board.base(r.live)), swarm = def.kind === 'dungeon-swarm';
      return h('div', { class: 'ma-q', onclick: go2(def) }, avatar(def.name, ev.icon || iconOfBoss(def.low), { boss: true }),
        h('div', { class: 'ma-q-n' }, h('b', {}, def.name), swarm ? null : h('div', { class: 'ma-bar' + (cap > 0 && dmg >= cap ? ' done' : '') }, h('i', { style: { width: (cap > 0 ? Math.min(100, dmg / cap * 100) : 0).toFixed(1) + '%' } })), swarm ? null : h('small', {}, `${fmtNum(dmg)} / ${fmtNum(cap)}`)), pill(r.txt, r.kind));
    };
    const miniRow = (r) => h('div', { class: 'ma-mini', title: r.def.name, onclick: go2(r.def) }, avatar(r.def.name, iconOfBoss(r.live), { size: 'xs' }), h('div', {}, h('b', {}, nameOf(r.def)), h('small', { class: 'st-' + (r.kind || 'x') }, r.txt)));
    const tally = (k, label) => { const n = rest.filter((r) => k(r)).length; return n ? pill(`${n} ${label}`, k === isCapped ? 'cap' : k === isWait ? 'blue' : 'warn') : null; };
    const isCapped = (r) => r.kind === 'cap', isWait = (r) => r.kind === 'blue' || r.kind === '' , isOther = (r) => !isCapped(r) && !isWait(r);
    const few = rows.length <= 6, all = isOpen('ov:rest', false);
    out.push(fold('ov:targets', true, ['🎯 Bosses to farm', h('small', {}, sel.length ? `${sel.length} selected · ${upNow.length} up` : '')], () => {
      if (!sel.length) return [h('div', { class: 'ma-empty', style: { margin: '8px 0 0' } }, 'Nothing to farm yet.', h('div', {}, btn('Choose bosses', '', () => go('bosses'))))];
      if (few) return rows.map(bigRow);
      const body = [];
      body.push(upNow.length ? h('div', {}, upNow.map(bigRow)) : h('div', { class: 'ma-note', style: { margin: '8px 3px 2px' } }, 'None of them is up right now.'));
      if (rest.length) {
        body.push(h('div', { class: 'ma-sum' }, tally(isCapped, 'capped'), tally(isWait, 'waiting'), tally(isOther, 'other'),
          h('button', { type: 'button', class: 'ma-link', onclick: () => { ui.open['ov:rest'] = !all; saveUi(); draw(); } }, (all ? '▾ hide ' : '▸ show ') + rest.length)));
        if (all) body.push(h('div', { class: 'ma-minis' }, rest.map(miniRow)));
      }
      return body;
    }));

    // numbers
    const up = Date.now() - (stats.started || Date.now()), ap = Presets.summary();
    out.push(fold('ov:session', false, '📊 This session', () => [h('div', { class: 'ma-stats', style: { marginTop: '8px' } }, [['⚔️ Hits', stats.hits], ['💥 Damage', fmtNum(stats.dmg)], ['🧪 Stamina', stats.stamA + stats.stamB], ['💊 HP', stats.hpUses], ['💧 Mana', stats.mpRefills], ['⏱ Up', fmtDur(up)]].map(([k, v]) => h('div', { class: 'ma-stat' }, k, h('b', {}, v)))),
      ap && ap !== '—' ? note('🎒 Equipped by Automator: ' + ap) : null]));
    out.push(h('div', { class: 'ma-actions', style: { marginTop: '12px' } }, btn('🔄 Refresh bosses', 'soft', () => Engine.scanNow()), btn('Clear skips', 'soft', () => { Engine.clearSkips(); Diag.clear(); draw(); })));
    return out;
  }

  /* ==================================================== BOSSES ==================================================== */
  function scheduleEditor(low) {
    const o = cfg.bosses[low] || {}, list = Array.isArray(o.schedule) ? o.schedule : [], now = serverMinutes(), base = baseCapOf(low);
    const sortSave = () => { ovr(low).schedule.sort((a, b) => toMin(a.at) - toMin(b.at)); saveCfg(); draw(); };
    const act = now != null ? list.indexOf(capNow(low).row) : -1;   // the row bossCap() is on right now (-1 = the default)
    const nxt = nextChange(low), inTxt = (m) => (m >= 60 ? Math.floor(m / 60) + ' h ' + (m % 60) + ' min' : m + ' min');
    const rows = list.map((b, i) => h('div', { class: 'ma-srow' + (i === act ? ' now' : '') },
      timePicker(b.at, (at) => { ovr(low).schedule[i].at = at; sortSave(); }), h('span', { class: 'arrow' }, '→'),
      num(() => b.cap, (n) => { ovr(low).schedule[i].cap = n; saveCfg(); }, { fmt: fmtNum }),
      h('button', { type: 'button', class: 'ma-x', title: 'Remove', onclick: (e) => { stop(e); ovr(low).schedule.splice(i, 1); if (!ovr(low).schedule.length) delete ovr(low).schedule; saveCfg(); draw(); } }, '✕')));
    return h('div', { class: 'ma-sched' },
      h('div', { class: 'ma-sub-h' }, 'Server clock', h('span', { class: 'sp' }), h('small', { style: { whiteSpace: 'nowrap' } }, now != null ? fmtClock(now) + ' IST' : 'not read yet')),
      rows.length ? rows : h('div', { class: 'ma-note', style: { margin: '2px 0 6px' } }, 'Change the cap at set times of the day (server clock, IST, daily). Each new dungeon starts from the cap for the current time.'),
      rows.length ? h('div', { class: 'ma-note', style: { margin: '4px 2px 6px' } }, now == null ? 'Waiting for the server clock (open any game page).' : nxt ? `${act < 0 ? `Now at the default, ${fmtNum(base)}. ` : ''}Next change at ${fmtClock(nxt.t)} → ${fmtNum(nxt.cap)}, in ${inTxt(nxt.t - now)}.` : 'No more changes today. A dungeon still running at midnight keeps this cap until a new one starts.') : null,
      h('button', { type: 'button', class: 'ma-add', onclick: (e) => { stop(e); const t = now != null ? hhmm((Math.floor(now / 60) + 1) * 60) : '12:00'; (ovr(low).schedule = ovr(low).schedule || []).push({ at: t, cap: bossCap(low) }); sortSave(); } }, '+ Add a cap change'));
  }
  /* ---- the picker under a boss row: ONE flat card, no tabs, nothing to scroll through.
   *      Gear / Crystal / Pet = three dropdowns side by side (one tap to switch), then the damage cap: the number, one chip per loot requirement. ---- */
  const KIND_ICO = { gear: '⚔️', crystal: '💎', pet: '🐾' };
  const cap1 = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const lvTxt = (n) => 'Lv ' + Number(n).toLocaleString('en-US');
  const presetOpts = (k) => Presets.list(k).map((p) => [p.id, p.name]);
  const loadoutGrid = (pick) => h('div', { class: 'ma-ld' }, Presets.pickKinds().map((k) => h('div', {}, h('label', {}, (KIND_ICO[k] || '🎒') + ' ' + cap1(k)), pick(k))));
  function bossLoadout(low) {                                        // this boss's own pick; "Default" = whatever the Loadout card gives it
    const o = cfg.bosses[low] || {}, AB = cfg.autoBuild || {};
    const t = { low };
    return loadoutGrid((k) => {
      const d = Presets.defaultPick(k), dp = d ? Presets.list(k).find((x) => x.id === String(d)) : null;
      const auto = k === 'crystal' ? Presets.crystalAuto(low, t) : Presets.autoFor(low, t), saved = !!(AB.enabled && Presets.available('best')) && !d;
      const dflt = auto ? 'Default · 🤖 Auto' : d ? 'Default · ' + (dp ? dp.name : d) : saved ? 'Default · keep equipped' : 'Default';
      return dropdown([['', dflt], ['__keep', 'Keep equipped'], ...presetOpts(k)], o[k] || '', (v) => { if (v) ovr(low)[k] = v; else delete ovr(low)[k]; Presets.forget(); Planner.reset(); });
    });
  }

  /* DAMAGE: the number, then one card per loot level: the damage it takes, with the loot it unlocks as pictures. Tap a card to cap there; bright = the cap reaches it. */
  const initials = (n) => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join('');
  function lootIcon(name) {
    const src = iconUrl(LootData.icon(name)), fb = () => h('span', { class: 'ma-ti-fb', style: { background: hueOf(String(name).toLowerCase()) } }, initials(name));
    return src ? imgTag(src, '', fb) : fb();
  }
  function damageBlock(low) {
    const base = baseCap(low), info = LootData.src(low);
    const exp = info && info.expCapDmg > 0 ? info.expCapDmg : 0;
    const rungs = LootData.tiers(low).map((t) => ({ req: t.req, items: t.items, ph: t.ph, exp: t.req === exp })), later = LootData.tiers(low, true), own = LootData.ownPhase(low);
    if (exp && !rungs.some((r) => r.exp)) { rungs.push({ req: exp, items: [], exp: true }); rungs.sort((a, b) => a.req - b.req); }
    const pctTxt = info && info.expCapPct != null ? ` (${info.expCapPct}%)` : '';
    const setCap = (v) => (e) => { stop(e); ovr(low).cap = v; saveCfg(); draw(); };
    const reached = rungs.filter((r) => r.req <= base).length, rl = Relics.info(low);
    const head = h('div', { class: 'ma-capbar' }, num(() => baseCap(low), (n) => { ovr(low).cap = n; draw(); }, { fmt: fmtNum, w: 84 }),
      h('div', { class: 'ma-capmeta' },
        info && info.levelReq ? pill(lvTxt(info.levelReq)) : null,
        rl && rl.have != null ? h('span', { title: `${rl.relic}: ${rl.have}/10 (each relic adds 5% damage, 10 = full)` }, pill(`✨ ${rl.have}/10 · ${rl.pct}% dmg`, rl.short ? 'warn' : 'ok')) : null,
        info && info.expCapPct != null ? pill(`EXP cap ${info.expCapPct}%`, 'xp') : null,
        rungs.length && base > 0 ? pill(`${reached}/${rungs.length} levels`, reached === rungs.length ? 'ok' : '') : null,
        exp && base > 0 ? h('small', {}, base >= exp ? '★ EXP cap reached' : '★ EXP cap needs +' + short(exp - base)) : null,
        h('small', {}, '0 = skip')));
    if (!rungs.length) {
      return [head, chips([[1e8, '100M'], [5e8, '500M'], [1e9, '1B'], [2e9, '2B'], [3e9, '3B'], [5e9, '5B']], base, (v) => { ovr(low).cap = v; }),
        h('div', { class: 'ma-what' }, base <= 0 ? 'Cap 0: this boss is skipped.' : !info ? (LootScan.available ? 'No loot data yet. Press Scan at the top to read it.' : 'No loot data for this boss yet.') : '')];
    }
    const topReq = rungs[rungs.length - 1].req;
    const at = new Map();                                              // item -> every level that drops it (for the hover text)
    rungs.forEach((r) => r.items.forEach((nm) => { const e = at.get(nm) || []; e.push(r.req); at.set(nm, e); }));
    // a loot ladder: one row per level; levels the cap reaches are bright, the rest are greyed out
    const rows = rungs.map((r) => {
      const MAXT = 12, tiles = r.items.slice(0, MAXT).map((nm) => h('span', { class: 'ma-it' + (r.ph.includes(nm) ? ' ph' : ''), title: `${nm}${r.ph.includes(nm) ? ' (phase loot: only damage dealt in this phase counts)' : ''}\nDrops at ${at.get(nm).map(short).join(' · ')} damage` }, h('span', { class: 'ma-ti' }, lootIcon(nm)), h('em', {}, nm)));
      if (r.items.length > MAXT) tiles.push(h('span', { class: 'ma-it', title: r.items.slice(MAXT).join(', ') }, h('span', { class: 'ma-ti more' }, '+' + (r.items.length - MAXT))));
      return h('div', { class: 'ma-rg' + (r.req <= base ? ' got' : '') + (r.req === base ? ' on' : '') + (r.exp ? ' exp' : ''), title: `Cap at ${fmtNum(r.req)}` + (r.items.length ? ': ' + r.items.join(', ') : ''), onclick: setCap(r.req) },
        h('span', { class: 'ma-rg-n' }),
        h('div', { class: 'ma-rg-b' }, h('span', { class: 'ma-rg-v' }, h('b', {}, short(r.req)), r.exp ? h('span', { class: 'ma-lvx', title: `Reaches the EXP cap${pctTxt}` }, '★') : null)),
        tiles.length ? h('div', { class: 'ma-rg-i' }, tiles) : h('span', { class: 'ma-none' }, 'EXP cap'));
    });
    // loot of a later phase is on this form too, but locked: only damage dealt in THAT phase unlocks it (like the lock on the battle page)
    const lockRows = later.length ? [h('div', { class: 'ma-lockh' }, `🔒 Phase ${later[0].gp > 2 ? later[0].gp - 1 : later[0].gp} loot · only damage dealt in that phase counts`),
      h('div', { class: 'ma-rgs' }, later.map((r) => h('div', { class: 'ma-rg lock', title: `Needs ${fmtNum(r.req)} damage dealt in that phase: ${r.items.join(', ')}` },
        h('span', { class: 'ma-rg-n' }), h('div', { class: 'ma-rg-b' }, h('span', { class: 'ma-rg-v' }, h('b', {}, short(r.req)), h('span', {}, '🔒'))),
        h('div', { class: 'ma-rg-i' }, r.items.slice(0, 12).map((nm) => h('span', { class: 'ma-it', title: nm }, h('span', { class: 'ma-ti' }, lootIcon(nm)), h('em', {}, nm))))))) ] : [];
    return [head, h('div', { class: 'ma-rgs' }, rows), ...lockRows, own > 1 ? h('div', { class: 'ma-what' }, 'This phase\'s cap counts only damage dealt in this phase (earlier phases are not counted).') : null,
      base <= 0 ? h('div', { class: 'ma-what' }, 'Cap 0: this boss is skipped.') : base > topReq ? h('div', { class: 'ma-what' }, `Above the top level (${short(topReq)}): the extra damage adds nothing.`) : null];
  }
  function placeOf(m) {
    if (m.kind === 'wave') { const l = bossLoc(m.low); return l ? `Gate ${l.gate} · Wave ${l.wave}` : ''; }
    return (m.dtype === 'easy' || m.kind === 'dungeon-swarm' ? 'Shadowbridge' : 'Castle') + (m.terr ? ' · ' + m.terr : m.locationId ? ' · location ' + m.locationId : m.locationIds ? ' · locations ' + m.locationIds.join(' + ') : '');
  }
  /* a boss the loot scan added (not in the built-in list): remove it, and the scan will not bring it back */
  function removeAdded(defs) {
    defs.forEach((def) => Roster.members(def).slice().forEach((m) => {
      LootData.dismiss(m.low); Roster.remove(m.low);
      cfg.targets = cfg.targets.filter((l) => l !== m.low); delete cfg.bosses[m.low];
    }));
    if (ui.sel && !Roster.get(ui.sel)) { ui.sel = ''; saveUi(); }
    saveCfg(); Engine.poke(true); draw();
  }
  function bossEditor(def) {
    const ms = Roster.members(def), idx = Math.min(phaseSel[def.low] || 0, ms.length - 1), m = ms[idx], low = m.low, o = cfg.bosses[low] || {}, kinds = Presets.pickKinds();
    const sched = Array.isArray(o.schedule) && o.schedule.length > 0, tOpen = isOpen('time', sched), [txt, kind] = entryState(def), place = placeOf(m);
    const timedBtn = m.kind !== 'wave' ? h('button', { type: 'button', class: 'ma-timed-bar' + (tOpen ? ' open' : ''), onclick: () => { ui.open.time = !tOpen; saveUi(); draw(); } }, h('span', {}, '⏰ Timed cap' + (sched ? ' · ' + o.schedule.length + ' set' + (serverMinutes() != null ? ' · now ' + short(bossCap(low)) : '') : '')), h('i', {}, tOpen ? '▾' : '▸')) : null;
    const resetBtn = Object.keys(o).length ? h('button', { type: 'button', class: 'ma-link', onclick: () => { delete cfg.bosses[low]; saveCfg(); draw(); } }, '↺ Reset') : null;
    const copyBtn = kinds.length ? h('button', { type: 'button', class: 'ma-link', title: 'Give other bosses this boss’s gear / crystal / pet picks', onclick: (e) => { stop(e); startBulk(def, low); } }, '⧉ Copy loadout to…') : null;
    const removeBtn = def.fromScan ? h('button', { type: 'button', class: 'ma-link warn', title: 'The loot scan added this boss. Remove it from the list (a rescan will not bring it back).', onclick: (e) => { stop(e); removeAdded([def]); } }, '🗑 Remove') : null;
    return h('div', { class: 'ma-ed' },
      h('div', { class: 'ma-ed-h' }, h('div', { class: 'ma-ed-t' }, h('b', { title: m.name }, m.name), place ? h('small', {}, place) : null), pill(txt, kind),
        h('button', { type: 'button', class: 'ma-x', title: 'Close', onclick: (e) => { stop(e); ui.sel = ''; saveUi(); draw(); } }, '✕')),
      ms.length > 1 ? h('div', { style: { margin: '0 0 6px' } }, seg(ms.map((x, i) => [i, 'Phase ' + (i + 1), x.name]), idx, (v) => { phaseSel[def.low] = v; }, { full: true })) : null,
      Presets.pickKinds().length ? bossLoadout(low) : null,
      caption('🎯 Damage cap'), ...damageBlock(low),
      timedBtn, m.kind !== 'wave' && tOpen ? scheduleEditor(low) : null,
      resetBtn || removeBtn || copyBtn ? h('div', { class: 'ma-reset' }, h('span', { class: 'sp' }), copyBtn, resetBtn, removeBtn) : null);
  }
  /* ---- Loadout: the one place for how builds are chosen ---------------------------------------------------------------
   * The default gear / crystal / pet presets, plus one 🤖 Auto best button (top right): the engine picks gear + pets for each boss, crystals and
   * sigils follow. Fewest build changes and putting your build back are always on. "Apply to several bosses" opens the tick-and-apply bar. */
  const ageTxt = (t) => { const m = Math.max(0, Math.round((Date.now() - t) / 60000)); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; };
  let restoring = false, restoreMsg = '';
  function originRow() {
    const o = Presets.origin.get(); if (!o) return null;
    const parts = [o.sel ? 'gear + pets' : '', o.crystals ? 'crystals' : '', (o.moves || []).length ? 'sigils' : ''].filter(Boolean).join(', ');
    return h('div', { class: 'ma-origin' },
      h('div', { class: 'ma-origin-r' },
        h('div', { class: 'ma-origin-t' }, h('b', {}, '📌 Saved build'), h('small', {}, `${ageTxt(o.at)} · before ${o.boss || 'the first boss'} · ${parts || 'nothing readable'}`)),
        h('div', { class: 'ma-origin-b' },
          btn(restoring ? 'Restoring…' : '↩ Restore', 'success', () => { if (restoring) return; restoring = true; restoreMsg = ''; draw(); Presets.restore('you asked').then((r) => { restoreMsg = r.ok ? '✅ ' + r.message : '⚠️ ' + r.message; }).finally(() => { restoring = false; draw(); }); }),
          h('button', { type: 'button', class: 'ma-link', title: 'Throw the saved build away: it will not be put back', onclick: () => { Presets.origin.clear(); restoreMsg = ''; draw(); } }, 'Forget'))),
      restoreMsg ? h('div', { class: 'ma-note', style: { margin: '6px 0 0' } }, restoreMsg) : null);
  }
  function loadoutPanel() {
    const AB = cfg.autoBuild, has = Presets.available('best'), kinds = Presets.pickKinds(), reset = () => { Presets.forget(); Planner.reset(); };
    const auto = has && AB.enabled;
    const body = [];
    if (!has) body.push(note('🤖 Auto needs the Build Engine addon, and it is not loaded.'));
    body.push(note(auto ? 'Best gear, pets, crystals and sigils for every boss, dungeons included. Your build is put back when nothing is left to fight.' : 'Equipped before every boss without its own pick. Your build is put back when nothing is left to fight.'));
    if (kinds.length) body.push(loadoutGrid((k) => {
      const off = auto && (k !== 'crystal' || AB.crystals !== false);           // Auto is choosing it: the dropdown says so instead of showing a preset
      const AUTO_TIP = { gear: 'Auto: the Build Engine equips the best gear for each boss.', pet: 'Auto: the Build Engine picks the best pets for each boss; sigils follow them.', crystal: 'Auto: best attack crystals assigned on whatever gear is equipped.' };
      return dropdown(off ? [['', '🤖 Auto']] : [['', 'Keep equipped'], ...presetOpts(k)], off ? '' : (cfg.loadout || {})[k] || '', (v) => { cfg.loadout = cfg.loadout || {}; if (v) cfg.loadout[k] = v; else delete cfg.loadout[k]; reset(); }, off, AUTO_TIP[k] || 'Auto is choosing this for every boss.');
    }));
    else body.push(note('No gear / crystal / pet preset addon is loaded.'));
    const o = originRow(); if (o) body.push(o);
    const autoBtn = h('div', { class: 'ma-seg' }, h('button', { type: 'button', disabled: !has || null, title: has ? 'Picks the best gear, pets, crystals and sigils for each boss, so the presets are off' : 'Needs the Build Engine addon', class: 'ma-seg-btn' + (auto ? ' on' : ''), onclick: (e) => { stop(e); if (!has) return; AB.enabled = !AB.enabled; if (AB.enabled && BK.on) { endBulk(); } reset(); saveCfg(); draw(); } }, '🤖 Auto'));
    const picks = kinds.filter((k) => cfg.loadout && cfg.loadout[k]);     // the presets above that are set: that is what there is to give to other bosses
    if (!auto && picks.length) body.push(h('div', { class: 'ma-actions ma-block' }, btn('Apply these to several bosses…', 'success', () => { BK.on = true; BK.sel = new Set(); BK.pick = {}; BK.cap = ''; BK.msg = ''; BK.from = ''; BK.ph = null; picks.forEach((k) => { BK.pick[k] = String(cfg.loadout[k]); }); ui.sel = ''; saveUi(); draw(); })));   // nothing set (or Auto on) = nothing to apply, no button
    return h('div', { class: 'ma-card' }, h('div', { class: 'ma-card-h' }, h('span', { class: 'ma-ico' }, '🎒'), h('div', { class: 'ma-card-t' }, h('b', {}, 'Loadout'), h('small', {}, 'How a boss gets its gear, pets, crystals and sigils')), autoBtn), h('div', { style: { marginTop: '9px' } }, ...body));
  }

  /* a boss as a bubble: avatar (dot = state), short name, cap · state, switch. Tap it to select it (one at a time) and open its editor. */
  const nameOf = (d) => (d.kind === 'dungeon-swarm' ? d.name : /vizier/i.test(d.name) ? 'Vizier' : splitName(d.name)[0]);   // shorthand for every boss (wave + dungeon); only the normal dungeon mobs (Gribbles etc.) keep the full name
  function splitName(n) {
    n = String(n || ''); const c = n.indexOf(',');
    if (c > 0) return [n.slice(0, c).trim(), n.slice(c + 1).trim()];
    const m = /^(.+?)\s+(the\s.+)$/i.exec(n);                         // "Oceanus The Water Titan" -> Oceanus | The Water Titan
    return m && !/\bof$/i.test(m[1]) ? [m[1], m[2]] : [n, ''];
  }
  const loadoutBits = (def) => {                                     // "build: auto best · gear: PVE Full SS" for the first phase that has its own picks
    const kinds = Presets.pickKinds();
    for (const m of Roster.members(def)) {
      const o = cfg.bosses[m.low]; if (!o) continue;
      const a = [...kinds.filter((k) => o[k]).map((k) => k + ': ' + (o[k] === '__keep' ? 'keep equipped' : (Presets.list(k).find((x) => x.id === String(o[k])) || { name: o[k] }).name))];
      if (a.length) return a;
    }
    return [];
  };
  function bubble(def) {
    const pickMode = BK.on, picked = pickMode && BK.sel.has(def.low);
    const on = isOn(def), op = !pickMode && ui.sel === def.low, ms = Roster.members(def), cap = bossCap(def.low), [txt, kind] = entryState(def), nx = nextChange(def.low), ld = loadoutBits(def);
    const loc = def.kind === 'wave' ? '' : def.locationId ? 'Loc ' + def.locationId : def.locationIds ? 'Loc ' + def.locationIds.join('/') : '';
    const rl = Relics.info(def.low), bits = [h('span', { class: 'capv' }, cap > 0 ? 'cap ' + short(cap) : 'skipped'), rl && rl.short ? h('span', { class: 'ma-rl', title: `${rl.relic}: ${rl.have}/10 — only ${rl.pct}% of your damage gets through` }, `✨ ${rl.pct}%`) : '', nx ? `→ ${short(nx.cap)} ${fmtClock(nx.t)}` : '', ld.length ? h('span', { title: ld.join('\n') }, '🎒') : '', loc, ms.length > 1 ? ms.length + ' phases' : '', on ? h('span', { class: 'st-' + (kind || 'x') }, txt) : ''].filter(Boolean);
    const sub = []; bits.forEach((b, i) => { if (i) sub.push(' · '); sub.push(b); });
    return h('div', { class: 'ma-bb' + (on ? ' on' : '') + (op ? ' open' : '') + (picked ? ' pick' : '') + (rl && rl.short ? ' rlw' : ''), title: def.name + (ld.length ? '\n' + ld.join('\n') : ''),
      onclick: pickMode ? () => toggleSel([def]) : () => { ui.sel = op ? '' : def.low; saveUi(); draw(); if (!op) setTimeout(() => { const e = root && root.querySelector('.ma-ed'); if (e && e.scrollIntoView) e.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, 40); } },
      avatar(def.name, iconOfBoss(def.low), { boss: true, dot: on ? kind || 'x' : '' }),
      h('div', { class: 'ma-bb-n' }, h('b', {}, nameOf(def)), h('small', {}, ...sub)),
      pickMode ? h('span', { class: 'ma-ck' }, picked ? '✓' : '') : sw(() => on, (v) => setMany([def], v), { sm: true, redraw: false }));
  }
  /* one row = a label (W12 for a wave, L6 for a dungeon territory) + its bosses as bubbles */
  function rowOf(label, defs, wv) {
    const open = BK.on ? [] : defs.filter((d) => ui.sel === d.low), all = defs.every(isOn), allPick = BK.on && defs.every((d) => BK.sel.has(d.low)), anyPick = BK.on && defs.some((d) => BK.sel.has(d.low));
    const lab = wv ? h('div', { class: 'ma-wv-l' + ((BK.on ? anyPick : defs.some(isOn)) ? ' on' : ''), title: BK.on ? `${allPick ? 'Untick' : 'Tick'} every boss of this wave` : `Switch every boss of this wave ${all ? 'off' : 'on'}`, onclick: () => { if (BK.on) toggleSel(defs); else setMany(defs, !all); } }, h('b', {}, wv.wave ? 'W' + wv.wave : '?'), h('small', { title: label }, label)) : null;
    return h('div', { class: 'ma-wv', style: wv ? null : { gridTemplateColumns: 'minmax(0,1fr)' } }, lab, h('div', { class: 'ma-grid' }, defs.map(bubble)), ...open.map(bossEditor));
  }

  /* ---- select mode: tick several bosses, choose gear / crystal / pet / cap once, apply to every ticked boss ---- */
  const selCount = () => { let n = 0; BK.sel.forEach((l) => { if (Roster.get(l)) n++; }); return n; };
  function toggleSel(defs, force) {
    const on = force != null ? force : !defs.every((d) => BK.sel.has(d.low));
    defs.forEach((d) => { if (on) BK.sel.add(d.low); else BK.sel.delete(d.low); });
    BK.msg = ''; draw();
  }
  function startBulk(def, low) {                                      // from a boss's editor: carry its picks over, then tick the bosses to give them to
    const o = cfg.bosses[low || def.low] || {};
    BK.on = true; BK.sel = new Set(); BK.pick = {}; BK.cap = ''; BK.msg = ''; BK.from = def.name;
    Presets.pickKinds().forEach((k) => { if (o[k]) BK.pick[k] = o[k]; });
    const cp = baseCapOf(low || def.low); if (cp > 0) { BK.cap = 'num'; BK.n = cp; } else if (cp === 0) BK.cap = 'skip';      // its damage cap is copied too (tap the chip again to leave it out)
    const ms = Roster.members(def); BK.ph = ms.length > 1 ? ms.map((m) => { const mo = cfg.bosses[m.low] || {}, r = { cap: baseCapOf(m.low) }; Presets.pickKinds().forEach((k) => { if (mo[k]) r[k] = mo[k]; }); return r; }) : null;   // a boss with phases: each phase goes to the same phase of the target
    ui.sel = ''; saveUi(); draw();
    setTimeout(() => { const e = root && root.querySelector('.ma-bulk'); if (e && e.scrollIntoView) e.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, 40);
  }
  function endBulk() { BK.on = false; BK.ph = null; BK.sel = new Set(); BK.pick = {}; BK.cap = ''; BK.msg = ''; BK.from = ''; draw(); }
  const bulkChanges = () => Presets.pickKinds().filter((k) => BK.pick[k]).length + (BK.cap ? 1 : 0);
  function applyBulk() {
    const defs = [...BK.sel].map((l) => Roster.get(l)).filter(Boolean), kinds = Presets.pickKinds(), did = new Set(), mode = BK.cap; let capDefs = 0, noExp = 0;
    defs.forEach((def) => {
      let capped = false;
      Roster.members(def).forEach((m, i) => {                                                            // every phase of the boss gets it (phase by phase when the copied boss has phases)
        const o = ovr(m.low), sp = BK.ph && BK.ph[Math.min(i, BK.ph.length - 1)], pk = sp || BK.pick, md = sp ? (sp.cap > 0 ? 'num' : sp.cap === 0 ? 'skip' : '') : mode, nn = sp ? sp.cap : BK.n;
        kinds.forEach((k) => { const v = pk[k]; if (!v) return; if (v === '__default') delete o[k]; else o[k] = v; did.add(k); });
        if (md === 'max') { delete o.cap; capped = true; }
        else if (md === 'skip') { o.cap = 0; capped = true; }
        else if (md === 'num') { o.cap = Math.max(0, Math.round(nn) || 0); capped = true; }
        else if (md === 'exp') { const i = LootData.get(m.low); if (i && i.expCapDmg > 0) { o.cap = i.expCapDmg; capped = true; } }
        if (!Object.keys(o).length) delete cfg.bosses[m.low];
      });
      if (capped) capDefs++; else if (mode === 'exp') noExp++;
    });
    saveCfg(); Engine.poke(true);
    const parts = [...did]; if (capDefs) parts.push('cap' + (capDefs < defs.length ? ` (${capDefs} of ${defs.length})` : '')); const cnt = defs.length;
    BK.msg = parts.length ? `✅ ${parts.join(' + ')} applied to ${cnt} boss${cnt === 1 ? '' : 'es'}` + (noExp ? ` · ${noExp} ${noExp === 1 ? 'has' : 'have'} no EXP cap data, so ${noExp === 1 ? 'its' : 'their'} cap was left alone` : '') : '⚠ nothing changed' + (noExp ? ': none of them has EXP cap data (scan the loot first)' : '');
    BK.sel = new Set();                                                // ready for the next bosses: the copied loadout / cap / phases stay until Cancel, so Apply goes green again as soon as one is ticked
    draw();
  }
  function bulkBar(sec) {
    const kinds = Presets.pickKinds(), n = selCount(), chg = bulkChanges();
    const lnk = (label, title, fn) => h('button', { type: 'button', class: 'ma-link', title, onclick: (e) => { stop(e); fn(); } }, label);
    // one dropdown per loadout kind: the unset state IS "no change" and wears the kind's name, so no labels and no "Leave as is"
    const pickBox = (k) => {
      const ico = KIND_ICO[k] || '🎒', cur = BK.pick[k] || '', opts = [['__default', 'Default loadout'], ['__keep', 'Keep equipped'], ...presetOpts(k)];
      return h('select', { class: 'ma-in' + (cur ? ' chg' : ''), title: cap1(k) + ': ' + (cur ? 'will change' : 'no change'), onclick: stop, onchange: (e) => { if (e.target.value) BK.pick[k] = e.target.value; else delete BK.pick[k]; BK.ph = null; BK.msg = ''; draw(); } },
        h('option', { value: '' }, 'No change'), ...opts.map(([v, l]) => h('option', Object.assign({ value: v }, String(v) === String(cur) ? { selected: true } : {}), l)));
    };
    const capChip = (v, label, tip) => h('button', { type: 'button', title: tip, class: 'ma-chip' + (BK.cap === v ? ' on' : ''), onclick: (e) => { stop(e); BK.cap = BK.cap === v ? '' : v; BK.ph = null; BK.msg = ''; draw(); } }, label);   // tap again to clear
    const plan = [...kinds.filter((k) => BK.pick[k]).map((k) => { const o = [['__default', 'default loadout'], ['__keep', 'keep equipped'], ...presetOpts(k)].find(([v]) => v === BK.pick[k]); return `${cap1(k)} → ${o ? o[1] : '…'}`; }),
      ...(BK.cap ? [{ max: 'Cap → max loot', exp: 'Cap → EXP cap', skip: 'Cap → skip', num: 'Cap → ' + fmtNum(BK.n) }[BK.cap]] : [])].join(' · ');
    const ok = n && chg, go = btn(ok ? `Apply to ${n} boss${n === 1 ? '' : 'es'}` : 'Apply', ok ? 'success' : 'soft', applyBulk); go.disabled = !ok;   // greyed out until there is something to apply; Cancel is the way out
    return h('div', { class: 'ma-bulk' },
      h('div', { class: 'ma-card-h' }, h('span', { class: 'ma-ico' }, '🎒'),
        h('div', { class: 'ma-card-t' }, h('b', {}, BK.from ? `Copy from ${BK.from}` : 'Apply to several bosses'), h('small', {}, n ? `${n} boss${n === 1 ? '' : 'es'} selected` : 'Tap bosses below to select them')),
        btn('Cancel', 'soft', endBulk)),
      h('div', { class: 'ma-bk-h' }, h('span', { class: 'ma-bk-l' }, 'Select'),
        lnk('All shown', 'Select every boss in the list below (it follows the filter)', () => toggleSel(shownDefs(sec), true)),
        lnk('Farming', 'Select the bosses that are switched on', () => toggleSel(Roster.list.filter((d) => Roster.canon(d) === d && isOn(d)), true)),
        lnk('None', 'Clear the selection', () => toggleSel([...BK.sel].map((l) => Roster.get(l)).filter(Boolean), false))),
      BK.from ? h('div', { class: 'ma-bk-from' }, `Loadout and cap copied from ${BK.from}${BK.ph ? ', phase by phase' : ''}. Select the bosses that should get it.`) : null,
      kinds.length ? loadoutGrid(pickBox) : null,
      h('div', { class: 'ma-bk-cap' }, h('label', {}, '🎯 Cap'),
        capChip('max', 'Max loot', 'Cap at the highest loot level'), capChip('exp', 'EXP cap', 'Cap at the damage that reaches the EXP cap'), capChip('skip', 'Skip', 'Cap 0: the boss is skipped'), capChip('num', 'Set…', 'Type a number'),
        BK.cap === 'num' ? num(() => BK.n, (v) => { BK.n = v; BK.ph = null; }, { fmt: fmtNum, w: 90 }) : null),
      h('div', { class: 'ma-bk-go' }, go, h('span', {}, BK.msg || (plan ? plan + (n ? '' : ' · now select bosses') : 'Pick a cap or a loadout to apply. Anything you leave alone stays as it is.'))));
  }
  function waveGroups(defs) {
    const groups = new Map();
    defs.forEach((def) => {
      const l = bossLoc(def.low), w = WaveMap.of(l && l.gate, l && l.wave);
      let g = groups.get(w.group.id); if (!g) groups.set(w.group.id, (g = Object.assign({}, w.group, { waves: new Map(), defs: [] })));
      let wv = g.waves.get(w.key); if (!wv) g.waves.set(w.key, (wv = { gate: l && l.gate, wave: l && l.wave, label: w.label, defs: [] }));
      wv.defs.push(def); g.defs.push(def);
    });
    return [...groups.values()].sort((a, b) => a.order - b.order).map((g) => {
      const waves = [...g.waves.values()].sort((a, b) => (a.gate || 0) - (b.gate || 0) || (a.wave || 0) - (b.wave || 0)); waves.forEach((wv) => wv.defs.sort((a, b) => rIdx(a.low) - rIdx(b.low)));
      const nums = waves.map((x) => x.wave).filter(Boolean);
      const sub = g.id === 'other' ? g.sub : nums.length > 1 ? `${g.sub} · waves ${Math.min(...nums)}–${Math.max(...nums)}` : nums.length ? `${g.sub} · wave ${nums[0]}` : g.sub;
      return Object.assign(g, { waves, sub });
    });
  }
  function dungeonGroups(defs) {
    const isShadow = (d) => d.kind === 'dungeon-swarm' || d.dtype === 'easy', locOf = (d) => d.locationId || (d.locationIds || [0])[0] || 0;
    const sort = (a) => a.slice().sort((x, y) => (x.extra ? 1 : 0) - (y.extra ? 1 : 0) || locOf(x) - locOf(y) || rIdx(x.low) - rIdx(y.low));     // Gribbles, the boss, then the others
    return [{ id: 'castle', title: 'Castle', ico: '🏰', sub: 'hard', defs: sort(defs.filter((d) => !isShadow(d))) }, { id: 'shadow', title: 'Shadowbridge', ico: '🌉', sub: 'easy', defs: sort(defs.filter(isShadow)) }].filter((g) => g.defs.length);
  }
  const shownDefs = (sec) => {                                        // the bosses the list shows right now (this section, after the filter)
    const f = (ui.filter || '').trim().toLowerCase();
    return Roster.list.filter((d) => Roster.canon(d) === d && (sec === 'dungeons' ? d.kind !== 'wave' : d.kind === 'wave') && (!f || Roster.members(d).some((m) => m.name.toLowerCase().includes(f))));
  };
  function bossSections(sec) {
    const f = (ui.filter || '').trim().toLowerCase(), force = !!f;
    const match = (d) => !f || Roster.members(d).some((m) => m.name.toLowerCase().includes(f));
    const canon = Roster.list.filter((d) => Roster.canon(d) === d && match(d));
    const lit = (d) => (BK.on ? BK.sel.has(d.low) : isOn(d));            // select mode counts ticked bosses, otherwise switched-on ones
    const counts = (defs) => { const n = defs.filter(lit).length; return h('span', { class: 'ma-pill' + (n ? ' blue' : '') }, n + '/' + defs.length); };
    const bulk = (defs) => [h('button', { class: 'ma-link', type: 'button', onclick: (e) => { stop(e); if (BK.on) toggleSel(defs, true); else setMany(defs, true); } }, 'All'), h('button', { class: 'ma-link', type: 'button', onclick: (e) => { stop(e); if (BK.on) toggleSel(defs, false); else setMany(defs, false); } }, 'None')];
    const showAll = () => h('button', { class: 'ma-link', type: 'button', title: 'The other Shadowbridge mob types are not loaded until you show them', onclick: (e) => { stop(e); cfg.shadowAll = !cfg.shadowAll; setShadowExtras(cfg.shadowAll); saveCfg(); draw(); } }, cfg.shadowAll ? 'Hide others' : 'Show all mobs');
    const mk = (g, body) => fold('grp:' + g.id, g.defs.some(lit), [g.ico + ' ' + g.title, g.sub ? h('small', {}, g.sub) : null], body, { force, aside: [counts(g.defs), ...bulk(g.defs), ...(g.id === 'shadow' ? [showAll()] : [])] });
    let out;
    if (sec === 'dungeons') out = dungeonGroups(canon.filter((d) => d.kind !== 'wave')).map((g) => mk(g, () => { const rows = []; for (let i = 0; i < g.defs.length; i += 2) rows.push(rowOf('', g.defs.slice(i, i + 2), null)); return rows; }));
    else out = waveGroups(canon.filter((d) => d.kind === 'wave')).map((g) => mk(g, () => g.waves.map((wv) => rowOf(wv.label, wv.defs, wv))));
    if (!out.length) out = [h('div', { class: 'ma-empty' }, f ? `No ${sec === 'dungeons' ? 'dungeon' : 'wave'} boss matches “${ui.filter}”.` : 'No bosses known yet.')];
    return out;
  }

  /* ---- loot scan strip (the buttons of PART 4b). Repainted on its own while a scan runs, so the tab does not redraw. ---- */
  let scanBox = null, scanOpen = false;
  function scanBar() {
    const s = LootScan.state, n = Object.keys(LootData.all()).length, out = [];
    if (s.running) {
      const pct = s.total ? Math.min(100, Math.round(s.done / s.total * 100)) : 0;
      out.push(h('div', { class: 'ma-scan' }, h('span', { class: 'ma-ico' }, '⏳'),
        h('div', { class: 'ma-scan-t' }, h('b', {}, `Scanning loot… ${pct}%`), h('small', {}, (s.label || '') + (s.read ? ` · ${s.read} read` : '')), h('div', { class: 'ma-bar' }, h('i', { style: { width: pct + '%' } }))),
        h('div', { class: 'ma-scan-b' }, btn('■ Stop', 'danger', () => LootScan.stop()))));
      return out;
    }
    const sub = s.error ? '⚠ ' + s.error : n ? `${n} monsters · scanned ${ago(LootData.at())}` + (s.endedAt ? ` · last run read ${s.read}${s.added ? ', ' + s.added + ' new' : ''}${s.skipped ? ' · ' + s.skipped + ' regular mob' + (s.skipped === 1 ? '' : 's') + ' left out' : ''}` : '') : 'Reads every boss’s loot, level requirement and EXP cap.';
    out.push(h('div', { class: 'ma-scan' }, h('span', { class: 'ma-ico' }, '🔎'), h('div', { class: 'ma-scan-t' }, h('b', {}, 'Loot scan'), h('small', { title: sub }, sub)),
      h('div', { class: 'ma-scan-b' }, btn(n ? '↻ Rescan' : '🔎 Scan', 'soft', () => LootScan.run()), n ? btn('⬇ Export .txt', 'soft', () => LootScan.download()) : null)));
    if (s.notes.length) {
      out.push(h('div', { style: { margin: '-3px 4px 6px' } }, h('button', { type: 'button', class: 'ma-link', onclick: () => { scanOpen = !scanOpen; paintScan(); } }, `⚠ ${s.notes.length} thing${s.notes.length === 1 ? '' : 's'} could not be read ${scanOpen ? '▾' : '▸'}`)));
      if (scanOpen) out.push(h('div', { class: 'ma-scan-n' }, s.notes.map((t) => h('div', {}, t))));
    }
    return out;
  }
  function paintScan() { if (scanBox && scanBox.isConnected) scanBox.replaceChildren(...scanBar()); }

  function tBosses() {
    Relics.refresh(); const out = [];
    if (LootScan.available) { scanBox = h('div', {}, ...scanBar()); out.push(scanBox); } else scanBox = null;
    const canon = Roster.list.filter((d) => Roster.canon(d) === d), dunOn = Kernel.isOn('dungeons');
    const sets = { waves: canon.filter((d) => d.kind === 'wave'), dungeons: dunOn ? canon.filter((d) => d.kind !== 'wave') : [] };
    const sec = dunOn && ui.bsec === 'dungeons' ? 'dungeons' : 'waves';
    const badge = (id) => { const f = (ui.filter || '').trim().toLowerCase(), defs = sets[id]; return f ? String(defs.filter((d) => Roster.members(d).some((m) => m.name.toLowerCase().includes(f))).length) : `${defs.filter(isOn).length}/${defs.length}`; };
    const badges = {};
    out.push(h('div', { class: 'ma-sec' }, [['waves', '🌊 Waves'], ...(dunOn ? [['dungeons', '🏰 Dungeons']] : [])].map(([id, label]) => h('button', { type: 'button', class: id === sec ? 'on' : '', onclick: () => { ui.bsec = id; saveUi(); draw(); } }, label, (badges[id] = h('i', {}, badge(id)))))));
    const kinds = Presets.pickKinds(), box = h('div', {}), fill = () => { box.replaceChildren(...bossSections(sec)); Object.keys(badges).forEach((id) => { badges[id].textContent = badge(id); }); };
    out.push(h('div', { class: 'ma-tool' }, h('input', { class: 'ma-search', placeholder: '🔎 Filter bosses…', value: ui.filter || '', oninput: (e) => { ui.filter = e.target.value; saveUi(); fill(); } }),
      kinds.length || Presets.available('best') ? h('button', { type: 'button', class: 'ma-tbtn' + (ui.open.loadout || BK.on ? ' on' : ''), title: 'How bosses get their gear, pets, crystals and sigils — and apply a setup to several bosses', onclick: () => { ui.open.loadout = !(ui.open.loadout || BK.on); if (!ui.open.loadout && BK.on) endBulk(); saveUi(); draw(); } }, '🎒 Loadout' + (Presets.available('best') ? (cfg.autoBuild.enabled ? ' · Auto' : ' · Saved') : '')) : null));
    if (BK.on) out.push(bulkBar(sec));                                // selecting: this ONE panel (it wears the Loadout card's look); otherwise the Loadout card
    else if ((kinds.length || Presets.available('best')) && ui.open.loadout) out.push(loadoutPanel());
    fill(); out.push(box);
    return out;
  }

  /* ===================================================== LOOT ===================================================== */
  function tLoot() {
    const L = cfg.autoLoot, s = Loot.state, groups = new Map();
    const AREAS = [...Object.values(WaveMap.groups).sort((a, b) => a.order - b.order).map((g) => ({ id: g.id, title: g.title, ico: g.ico })), { id: 'castle', title: 'Castle', ico: '🏰' }, { id: 'shadow', title: 'Shadowbridge', ico: '🌉' }];
    const areaOf = (r) => r.area || (r.kind === 'wave' ? WaveMap.of(r.gate, r.wave).group.id : (r.dtype === 'hard' ? 'castle' : 'shadow'));   // same monster name in two areas = two cards
    s.rows.filter((r) => r.needsLoot !== false).forEach((r) => { const area = areaOf(r), key = area + '|' + r.nameLow; const g = groups.get(key) || { name: r.name, low: r.nameLow, area, rows: [], boss: r.isBoss, icon: r.icon }; g.rows.push(r); if (!g.icon && r.icon) g.icon = r.icon; groups.set(key, g); });
    const need = (() => { const m = Core.me.get(), e = m && m.exp; return e && e.max > 0 ? Math.max(0, e.max - e.cur) : null; })();
    const list = [...groups.entries()].sort((a, b) => (b[1].boss - a[1].boss) || a[1].name.localeCompare(b[1].name)), total = list.reduce((n, [, g]) => n + g.rows.length, 0);
    const lootCard = ([low, g]) => {
      const dmg = g.rows.reduce((n, r) => n + (Number.isFinite(r.userDamage) ? r.userDamage : 0), 0), busy = s.claiming.has(low);
      const b = btn(busy ? 'Claiming…' : 'Claim', 'soft', () => { Loot.claimGroup(g.low, g.area); }); b.classList.add('ma-claim');
      return h('div', { class: 'ma-lc' }, avatar(g.name, g.icon, { boss: g.boss }), h('div', { class: 'ma-lc-n' }, h('b', {}, g.name), h('small', {}, `${g.rows.length} corpse${g.rows.length === 1 ? '' : 's'}${dmg ? ' · ' + fmtNum(dmg) + ' damage' : ''}`)), b);
    };
    const sections = AREAS.map((a) => ({ a, items: list.filter(([, g]) => g.area === a.id) })).filter((x) => x.items.length)
      .map(({ a, items }) => { const n = items.reduce((c, [, g]) => c + g.rows.length, 0); return fold('loot:' + a.id, true, [a.ico + ' ' + a.title, h('small', {}, `${n} corpse${n === 1 ? '' : 's'}`)], () => items.map(lootCard)); });
    return [
      h('div', { class: 'ma-alert info' }, L.enabled ? 'Auto-loot is on: it claims these when you run out of stamina.' : 'Auto-loot is off.', ' ', h('button', { type: 'button', class: 'ma-link', onclick: () => go('settings') }, 'Change in Settings')),
      h('div', { class: 'ma-actions' }, btn(s.scanning ? 'Scanning…' : '🔎 Scan graveyard', 'soft', () => { Loot.scan(true); }), btn(s.looting ? 'Looting…' : '🎒 Loot now', 'success', () => { Loot.scanAndPass(); })),
      (() => {                                                       // one line: lootable · XP · level-ups · when scanned · EXP to the next level
        if (!s.lastScanAt) return note('Not scanned yet.');
        const rows = [...groups.values()].flatMap((g) => g.rows), known = rows.filter((r) => Number.isFinite(r.est)), xp = known.reduce((n, r) => n + r.est, 0), unk = rows.length - known.length;
        const me = Core.me.get(), ex = me && me.exp, cost = ex && ex.max > 0 ? ex.max : 0;      // levels: the first needs what is left of this one, each next one is guessed at the same size
        const lvUp = cost && need != null && xp > 0 ? (xp >= need ? 1 + Math.floor((xp - need) / cost) : 0) : null;
        const bits = [`${total} lootable`];
        if (total) {
          bits.push(s.estimating && !known.length ? '✨ estimating…' : '✨ ~' + fmtNum(xp) + ' XP');
          if (lvUp != null) bits.push(lvUp > 0 ? '📈 ~+' + lvUp + ' level' + (lvUp === 1 ? '' : 's') : '📈 0 levels · ' + Math.round((ex.cur + xp) / cost * 100) + '% to next');
          if (s.estimating && known.length) bits.push('estimating…'); else if (unk) bits.push(unk + ' unknown');
        }
        bits.push('scanned ' + ago(s.lastScanAt));
        if (need != null) bits.push(fmtNum(need) + ' EXP to next level');
        return h('div', { class: 'ma-note', title: 'Level-ups are an estimate: the first level needs what is left of the one you are on, every next level is assumed to need about as much as this one' }, bits.join(' · '));
      })(),
      ...(list.length ? sections
        : [h('div', { class: 'ma-empty' }, s.lastScanAt ? 'Nothing lootable right now.' : 'Not scanned yet, press Scan graveyard.')])];
  }

  /* =============================== SETTINGS (potions, fighting, timing) =============================== */
  function tSettings() {
    const S = cfg.stam, SV = S.save, H = cfg.hp, M = cfg.mana, L = cfg.autoLoot;
    const au = Guard.info(), cls = effectiveClass(), cs = cls ? CLASS_SKILLS[cls] : null;
    const skillOn = cfg.useClassSkill;
    return [
      caption('Potions & loot'),
      group(
        srow('⚡', 'Stamina', 'Drinks a potion when you run out', sw(() => S.enabled, (v) => { S.enabled = v; }), S.enabled ? [
          opt('Potion', dropdown([['Large Stamina Potion', 'Large'], ['Full Stamina Potion', 'Full']], S.item, (v) => { S.item = v; })),
          opt(['Save past', h('small', {}, '100 = never')], num(() => SV.thresholdPct, (n) => { SV.thresholdPct = n; }, { parse: parseFloat, min: 1, max: 100, unit: '% EXP' }))] : null),
        srow('❤️', 'Health', 'Drinks when HP hits 0', sw(() => H.enabled, (v) => { H.enabled = v; H.thresholdPct = 0; }, { redraw: false })),
        srow('💧', 'Mana', 'Drinks when MP runs low', sw(() => M.enabled, (v) => { M.enabled = v; }), M.enabled ? [
          opt('Potion', dropdown([['S', 'Small · 20'], ['M', 'Medium · 40'], ['L', 'Large · 60'], ['XL', 'XL · 100']], M.type, (v) => { M.type = v; })),
          opt('Drink at or below', num(() => M.threshold, (n) => { M.threshold = n; }, { min: 0, unit: 'MP' }))] : null),
        srow('🪦', 'Auto-loot', 'Out of stamina: claims only what levels you up', sw(() => L.enabled, (v) => { L.enabled = v; }))),
      caption('Fighting'),
      group(
        srow('✨', 'Class skill', (cs ? cs.label : 'Not detected') + ' · cast before each World Breaker slash', sw(() => cfg.useClassSkill, (v) => { cfg.useClassSkill = v; }), skillOn ? [
          !cs ? opt('Class', seg([['warrior', 'Warrior'], ['cleric', 'Cleric'], ['hunter', 'Hunter'], ['mage', 'Mage']], cfg.classOverride, (v) => { cfg.classOverride = v; }), null, true) : null,
          opt('Pierce shielded mobs', sw(() => cfg.sideMob.enabled, (v) => { cfg.sideMob.enabled = v; }, { redraw: false, sm: true }), `${cs ? cs.label : 'class skill'} on a regular mob`, 'row')] : null),
        srow('⚔️', 'Phase duels', 'Fought automatically', sw(() => cfg.autoDuel, (v) => { cfg.autoDuel = v; }, { redraw: false })),
        srow('⏸️', 'Pause server auto-farm', 'So the two never fight over stamina', sw(() => cfg.autoFarmControl, (v) => { cfg.autoFarmControl = v; }, { redraw: false }))),
      caption('Advanced'),
      fold('adv', false, ['⏱ Timing', h('small', {}, 'pauses between requests')], () => [h('div', { class: 'ma-sr-o tm' },
        opt(['Scan every', h('small', {}, 'Waves, dungeons, and loot')], num(() => cfg.fightScanMs / 60000, (n) => { cfg.fightScanMs = Math.round(n * 60000); }, { unit: 'min', min: 0.1, parse: parseFloat })),
        opt('Wave attack cooldown', num(() => cfg.attackDelayMs, (n) => { cfg.attackDelayMs = n; }, { unit: 'ms', min: 0 })),
        opt('Dungeon attack cooldown', num(() => cfg.dungeonAttackDelayMs, (n) => { cfg.dungeonAttackDelayMs = n; }, { unit: 'ms', min: 0 })),
        skillOn ? opt('Skill → attack gap', num(() => cfg.skillToAttackGapMs, (n) => { cfg.skillToAttackGapMs = n; }, { unit: 'ms', min: 0 })) : null,
        L.enabled ? opt('Gap between loot claims', num(() => L.claimGapMs, (n) => { L.claimGapMs = n; }, { unit: 'ms', min: 0 })) : null)]),
      h('div', { class: 'ma-note ma-about' }, `v${VERSION} · re-login ${au.status ? (au.status.configured ? 'set up' : 'not set up') : 'unavailable'} · ${Presets.note()}`,
        ' · ', h('button', { type: 'button', class: 'ma-link', onclick: () => { SideMob.forget(); draw(); } }, `forget ${SideMob.shielded()} shielded mob${SideMob.shielded() === 1 ? '' : 's'}`))];
  }

  const logRow = (r) => h('div', { class: 'ma-ll ' + r.k }, h('b', {}, r.t), r.m.replace(/<[^>]+>/g, ''));
  let lastRow = null;                                                // newest log line already on screen
  function paintLog() {                                              // a new log line only appends a row: no rebuild of the panel or the list
    const box = root && root.querySelector('.ma-log'), f = cfg.logFilter || 'all', all = Log.all(), i = all.indexOf(lastRow);
    if (!box || !lastRow || f === 'skips' || i < 0) return false;
    const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
    all.slice(i + 1).filter((r) => f === 'all' || r.k === f).forEach((r) => box.append(logRow(r)));
    while (box.childElementCount > 200) box.firstChild.remove();
    lastRow = all[all.length - 1]; if (stick) box.scrollTop = box.scrollHeight;
    schedule(4000); return true;                                     // the filter counts catch up a moment later
  }
  function tActivity() {
    const f = cfg.logFilter || 'all', all = Log.all(); lastRow = all[all.length - 1] || null; const cnt = (k) => all.filter((r) => r.k === k).length, l = Diag.last(), nSkip = Object.values(Diag.counts).reduce((a, b) => a + b, 0);
    const chipDefs = [['all', 'All', all.length], ['dmg', 'Hits', cnt('dmg')], ['skill', 'Skills', cnt('skill')], ['warn', 'Warnings', cnt('warn')], ['err', 'Errors', cnt('err')], ['skips', 'Skips', nSkip]];
    const out = [h('div', { class: 'ma-alert info' }, l.reason ? h('span', {}, h('b', {}, 'Last skip: '), `${l.reason}${l.detail ? ' — ' + l.detail : ''} · ${ago(l.at)}`) : 'Nothing has been skipped. It attacks whenever a boss is up and under its cap.'),
      h('div', { class: 'ma-chips', style: { margin: '0 0 10px' } }, chipDefs.map(([v, label, n]) => h('button', { type: 'button', class: 'ma-chip' + (v === f ? ' on' : ''), onclick: () => { cfg.logFilter = v; saveCfg(); draw(); } }, label, n ? h('i', {}, n) : null)))];
    if (f === 'skips') {
      const counts = Object.entries(Diag.counts).sort((a, b) => b[1] - a[1]);
      out.push(counts.length ? h('div', { class: 'ma-chips', style: { marginBottom: '10px' } }, counts.map(([k, n]) => pill(`${k} · ${n}`, 'warn'))) : null);
      out.push(Diag.events.length ? h('div', { class: 'ma-log' }, Diag.events.slice(-60).map((e) => h('div', { class: 'ma-ll warn' }, h('b', {}, e.t), e.reason + (e.detail ? ' — ' + e.detail : '')))) : h('div', { class: 'ma-empty' }, 'No skips recorded.'));
      out.push(h('div', { class: 'ma-actions', style: { marginTop: '10px' } }, btn('Clear', 'soft', () => { Diag.clear(); draw(); })));
    } else {
      const rows = all.filter((r) => f === 'all' || r.k === f).slice(-200);
      out.push(rows.length ? h('div', { class: 'ma-log' }, rows.map(logRow)) : h('div', { class: 'ma-empty' }, 'Nothing logged yet.'));
      out.push(h('div', { class: 'ma-actions', style: { marginTop: '10px' } }, btn('Clear log', 'soft', () => Log.clear())));
    }
    return out;
  }

  const BUILD = { home: tHome, bosses: tBosses, loot: tLoot, settings: tSettings, activity: tActivity };
  function scroller(el) { for (let n = el && el.parentElement; n; n = n.parentElement) { const o = getComputedStyle(n).overflowY; if ((o === 'auto' || o === 'scroll') && n.scrollHeight > n.clientHeight) return n; } return null; }
  /* A redraw builds the tab off-screen first. For the automatic ones (a timer, a status change) the page is only touched when the result
   * differs from what is showing: most ticks change nothing, so nothing is replaced, no image reloads, no scroll jump, no lost focus. */
  let lastSig = '', lastTab = '';
  const sigOf = (box) => box.innerHTML + '\u0001' + Array.from(box.querySelectorAll('input,select')).map((e) => (e.type === 'checkbox' ? (e.checked ? 1 : 0) : e.value)).join('\u0002');
  function draw(auto) {
    if (!root || !shown || !root.isConnected) return;
    let body; try { body = BUILD[tab]() } catch (e) { body = [h('div', { class: 'ma-alert' }, 'panel error: ' + e.message)]; console.warn('[automator] panel', e); }
    const next = [tabsBar(), h('div', { class: 'ma-body' }, ...[].concat(body).filter(Boolean)), footer()];
    const tmp = document.createElement('div'); tmp.append(...next);
    const sig = tab + '\u0003' + sigOf(tmp);
    if (auto === true && sig === lastSig && root.firstChild) return;
    lastSig = sig;
    const sc = scroller(root), top = sc ? sc.scrollTop : 0, pl = root.querySelector('.ma-log'), stick = !pl || pl.scrollTop + pl.clientHeight >= pl.scrollHeight - 30, lt = pl ? pl.scrollTop : 0;
    root.replaceChildren(...next);
    if (sc) sc.scrollTop = top;
    const nl = root.querySelector('.ma-log'); if (nl) nl.scrollTop = stick ? nl.scrollHeight : lt;      // the log keeps its place in the same frame (newest line is at the bottom: follow it unless you scrolled up)
  }
  const typing = () => root && root.contains(document.activeElement) && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
  function schedule(ms) { if (drawT) return; drawT = setTimeout(() => { drawT = 0; if (typing() || document.hidden) schedule(1500); else draw(true); }, ms || 400); }
  if (typeof Core.on === 'function') Core.on('caps:changed', (d) => { if (shown && d && (d.added || []).some((n) => n.startsWith('preset.'))) schedule(300); });   // a preset addon loaded late
  UI.hook((what) => { if (!shown) return; if (what === 'scan') { if (tab === 'bosses') paintScan(); return; } if (what === 'log' && tab === 'activity' && paintLog()) return; if (what === undefined || what === 'status' || DIRTY_TAB[what] === tab) schedule(); });
  let beat = 0;
  setInterval(() => { if (!shown || !root || !root.isConnected || document.hidden) return; if (++beat % 3 === 0 && (tab === 'home') && !typing()) draw(true); }, 1000);   // overview: vitals + timers refresh every 3 s

  function register() {
    Core.float.add({ id: ID, title: 'Automator', icon: '🤖', order: 40, width: 560,
      render(el) { root = h('div', { class: 'ma-root' }); el.replaceChildren(root); shown = true; draw(); },
      onShow() { shown = true; }, onHide() { shown = false; } });
  }
  return { register, draw };
})();
/* ===================================================================================================================
 * PART 6 — BOOT
 * ================================================================================================================ */
Kernel.register({ id: 'bosses', name: 'Wave bosses', icon: '🌊' });
(function dropRegularMobs() {
  const gone = LootData.purge(); if (!gone.length) return;
  const set = new Set(gone); let t = 0;
  cfg.targets = cfg.targets.filter((x) => { if (set.has(x)) { t++; return false; } return true; });
  gone.forEach((l) => { delete cfg.bosses[l]; });
  saveCfg(); log(`🧹 removed ${gone.length} regular mob${gone.length === 1 ? '' : 's'} that an earlier loot scan had saved${t ? ' (and ' + t + ' target tick' + (t === 1 ? '' : 's') + ')' : ''}`, 'info');
})();
LootData.apply();
Panel.register();
Duels.bootPage().catch((e) => log('❌ duel page: ' + e.message, 'err'));
Tab.join().catch((e) => log('❌ tab leadership: ' + e.message, 'err'));

return {
  version: VERSION, cfg: () => cfg, draw: Panel.draw, board: Board.all, status: Status.get,
  start: Run.start, stop: Run.stop, scanNow: Engine.scanNow, register: Kernel.register, loot: LootData.all, lootScan: LootScan,
};

  },
});
