/* automator.js — Automator addon for Core (one file, swappable parts)
 *
 * Plain script, no ==UserScript== header. `Core` is in scope (>= 3.16.0: Core.auth, Core.potions, Core.tab, Core.me, and Core.caps/call for presets;
 * on an older Core everything works except the per-boss preset dropdowns).
 * Replaces "Boss DMG Automator 3.0.0" (and must not run together with it or with Rahik's DMG Boss Script).
 *
 *   PART 0  KERNEL     config, log, diagnostics, action queue, player state, auth guard, part registry, scheduler
 *   PART 1  BOSSES     wave bosses: roster, authoritative page scans, attack engine, side-mob (toggle), potions,
 *                      auto-farm coordination, preset bridge (gear / crystal / pet, found through Core capabilities)
 *   PART 2  DUNGEONS   Castle bosses (+ Khaal phases), Shadowbridge Gribble swarm. NOT the cube: Cube Suite owns it.
 *                      Swappable: turn the part off (or delete it) and the wave bosses keep working.
 *   PART 3  DUELS      Phase duels, shared by wave and dungeon bosses
 *   PART 4  LOOT       graveyard scan + EXP-aware auto-loot
 *   PART 5  [slots]    quests / adventurers guild / PvP / dailies: Kernel.register({ id, name, icon, every, tick, panel })
 *   PART 6  PANEL      Core.float panel: Status, Bosses, Potions, Graveyard, Log, Diagnostics
 *
 * Why this exists (3.0.0 bugs fixed here, see the notes): a login/maintenance page used to parse as "no bosses";
 * boss timers were never reloaded after a tab took over; nothing scanned while a boss was being fought; error
 * replies were retried instantly instead of honouring their delay.
 */
Core.module({
  id: 'automator', name: 'Automator', icon: '🤖', version: '1.1.0',
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
const ID = 'automator', VERSION = '1.1.0';
if (window.__automatorLoaded) { console.warn('[automator] already loaded', window.__automatorLoaded); return null; }
window.__automatorLoaded = VERSION;

/* ===================================================================================================================
 * PART 0 — KERNEL
 * ================================================================================================================ */

const BASE = location.origin;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toLocaleTimeString('en-GB', { hour12: false });
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
const loadJSON = (k, fb) => { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : fb; } catch (_) { return fb; } };

/* ---- config (one Core.store, per player, shared across tabs) ---------------------------------------------------- */
const DEFAULT_CFG = {
  v: 1,
  targets: [],                         // nameLow list = enabled bosses, in priority order (first alive + uncapped wins)
  bosses: {},                          // nameLow -> { cap, gate, wave, targeting:'auto|normal|shielded', <kind>:'' (one per preset kind that is offered: gear, crystal, pet, …), switchAt:'HH:MM', capAfterSwitch }
  defaultBossCap: 3_000_000_000,
  maxTier: 'LEGENDARY',
  classOverride: 'auto', useClassSkill: true,
  attackDelayMs: 350,                  // between swings, WAVE bosses
  dungeonAttackDelayMs: 0,             // dungeon bosses chain swings back-to-back
  minActionGapMs: 450, skillToAttackGapMs: 1250,
  fightScanMs: 30000,                  // while fighting: rescan a target's wave page at least this often
  idleRecheckMs: 30000,                // not alive / capped: recheck this often (or at the known respawn time)
  maxIdleRecheckMs: 300000, spawnLeadMs: 5000,
  dungeonPollMs: 45000,
  mana: { enabled: true, type: 'S', name: '', threshold: 20, fillTo: 60, fullMaxAt0: true },
  stam: { A: { enabled: false, item: 'Full Stamina Potion' }, B: { enabled: false, item: 'Large Stamina Potion' }, save: { enabled: false, thresholdPct: 93.5 } },
  hp: { enabled: false, thresholdPct: 0 },
  autoFarmControl: true,
  autoDuel: true,
  sideMob: { enabled: false, lockedKey: '' },          // shielded-boss side-mob targeting (off: it shouldn't be needed)
  autoLoot: { enabled: false, mode: 'toLevel', scanMs: 60000, claimGapMs: 500 },
  parts: { bosses: true, dungeons: true, duels: true, loot: true },
  logFilter: 'all',
};
const cfgStore = Core.store(ID, { def: DEFAULT_CFG });
const stateStore = Core.store(ID + '-state', { def: { run: false, afPaused: 0, board: {}, status: 'STOPPED', statusAt: 0, mainTab: '' } });
const logStore = Core.store(ID + '-log', { def: [] });

function mergeCfg(saved) {
  const d = JSON.parse(JSON.stringify(DEFAULT_CFG)), s = saved && typeof saved === 'object' ? saved : {};
  const out = Object.assign(d, s);
  for (const k of ['mana', 'hp', 'sideMob', 'autoLoot', 'parts']) out[k] = Object.assign({}, DEFAULT_CFG[k], s[k] || {});
  out.stam = { A: Object.assign({}, DEFAULT_CFG.stam.A, (s.stam || {}).A), B: Object.assign({}, DEFAULT_CFG.stam.B, (s.stam || {}).B), save: Object.assign({}, DEFAULT_CFG.stam.save, (s.stam || {}).save) };
  out.targets = Array.isArray(s.targets) ? s.targets.slice() : [];
  out.bosses = s.bosses && typeof s.bosses === 'object' ? s.bosses : {};
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
  hp: 0, maxHp: 1, mp: 0, maxMp: 1, statsAt: 0, mpKnown: false, hpKnown: false,
  stam() { const m = Core.me.get(); return m && m.stamina && m.stamina.cur != null ? m.stamina.cur : 0; },
  stamKnown() { const m = Core.me.get(); return !!(m && m.stamina && m.stamina.cur != null); },
  maxStam() { const m = Core.me.get(); return m && m.stamina && m.stamina.max ? m.stamina.max : 1; },
  expPct() { const m = Core.me.get(); const e = m && m.exp; return e && e.max > 0 ? (e.cur / e.max) * 100 : null; },
  level() { const m = Core.me.get(); return (m && m.level) || 0; },
  // HP / MP are not tracked by Core.me: read them off game_dash.php (the same fetch also feeds Core.me stamina/exp/level).
  async refresh(maxAgeMs = 15000) {
    if (Date.now() - Me.statsAt < maxAgeMs) return true;
    const started = Date.now();
    let html;
    try { html = await Core.net.fetchText('/game_dash.php', { force: true, ttl: 0 }); }
    catch (e) { Diag.skip('stats-fetch-failed', e.message); return false; }
    const doc = parseHtml(html);
    const st = Guard.pageState(doc); if (st !== 'ok') { Guard.fault(st, 'game_dash.php'); return false; }
    let h = null, hMax = null, m = null, mMax = null;
    doc.querySelectorAll('.player-resources .res-row').forEach((row) => {
      const lbl = (row.querySelector('.res-label') || {}).textContent || '';
      const meta = ((row.querySelector('.res-meta') || {}).textContent || '').trim(); if (!meta) return;
      const [a, b] = meta.split('/');
      if (/hp/i.test(lbl)) { h = parseNum(a, h); if (b) hMax = parseNum(b, hMax); }
      else if (/mp|mana/i.test(lbl)) { m = parseNum(a, m); if (b) mMax = parseNum(b, mMax); }
    });
    if (h === null) { const el = doc.querySelector('.playerhp .muted'); if (el) { const [a, b] = el.textContent.trim().split('/'); h = parseNum(a, h); if (b) hMax = parseNum(b, hMax); } }
    if (m === null) {
      const el = doc.getElementById('mp_span') || doc.querySelector('[id*="mana"]');
      if (el) { m = parseNum(el.textContent, m); const mm = (el.parentElement ? el.parentElement.textContent : '').match(/([\d,]+)\s*\/\s*([\d,]+)/); if (mm) { m = parseNum(mm[1]); mMax = parseNum(mm[2]); } }
    }
    if (hMax) Me.maxHp = hMax; if (mMax) Me.maxMp = mMax;
    if (h !== null && h >= 0) { Me.hp = h; Me.hpKnown = true; }
    if (m !== null) { Me.mp = m; if (Me.maxMp > 1) Me.mpKnown = true; }
    Me.statsAt = started;
    UI.dirty('status');
    return true;
  },
  fromAttack(j) {
    try { Core.me.fromAttack(j); } catch (_) { /* Core older than 3.14 */ }
    if (j && j.mp !== undefined) Me.mp = parseNum(j.mp, Me.mp);
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

const Run = (() => {
  let wanted = !!(stateStore.get() || {}).run;
  const pausedBy = new Set();
  const persist = (v) => { wanted = v; stateStore.update((s) => { s.run = v; }); };
  function start() {
    if (wanted && !pausedBy.size) return;
    if (!cfg.targets.length) { log('⚠️ no bosses selected — tick at least one in Bosses', 'warn'); return; }
    if (Conflicts.check()) return;
    pausedBy.clear(); persist(true); Kernel.engineStart(true); log('🚀 started', 'ok'); UI.dirty();
  }
  function stop(reason) {
    persist(false); pausedBy.clear(); Engine.halt(); Kernel.engineStop();
    log('🛑 ' + (reason || 'stopped'), 'info'); Status.set('STOPPED'); UI.dirty();
    if (Tab.isMain()) AF.resumeIfWePaused('stopped').catch(() => {});
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

/* ---- never run next to Rahik's script or the old standalone Boss DMG Automator (double attacks) ------------------ */
const Conflicts = {
  list() {
    const out = [];
    if (window._rahikHeartbeatStarted) out.push("Rahik's DMG Boss Script is active on this page");
    try {
      const run = localStorage.getItem('dmgbot_run_v1') === 'true';
      const lead = loadJSON('dmgbot_leader_v1', null);
      if (run && lead && lead.expiresAt && lead.expiresAt > Date.now()) out.push('Boss DMG Automator 3.0.0 is still running in another tab (turn that userscript off)');
    } catch (_) { /* */ }
    return out;
  },
  check() {
    const c = Conflicts.list(); if (!c.length) return false;
    c.forEach((m) => log('⛔ ' + m + ' — not starting, it would attack twice', 'err'));
    Diag.skip('conflict', c.join('; ')); return true;
  },
};

/* ---- part registry + scheduler ---------------------------------------------------------------------------------- */
// A part is { id, name, icon, every?: ms | () => ms, tick?: async (ctx) => {}, panel?: (el) => {}, onMain?, onIdle? }.
// Parts that declare `every` + `tick` are run by the kernel in the MAIN tab only, one at a time, when cfg.parts[id] is on.
// The boss engine itself is a long loop owned by PART 1 (Kernel.engineStart); a new automation part only needs register().
const Kernel = (() => {
  const parts = new Map(), nextAt = new Map(); let hb = 0, busy = new Set();
  const enabled = (p) => cfg.parts[p.id] !== false;
  function register(p) { parts.set(p.id, p); if (cfg.parts[p.id] === undefined) cfg.parts[p.id] = true; UI.dirty(); return p; }
  const isOn = (id) => cfg.parts[id] !== false;
  async function beat() {
    if (!Tab.isMain()) return;
    const now = Date.now();
    for (const p of parts.values()) {
      if (!p.tick || !p.every || !enabled(p) || busy.has(p.id)) continue;
      if (Guard.isFaulted()) continue;
      if ((nextAt.get(p.id) || 0) > now) continue;
      const ev = typeof p.every === 'function' ? p.every() : p.every; if (!(ev > 0)) continue;
      busy.add(p.id); nextAt.set(p.id, now + ev);
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
  return { list, add, get, members, canon, groupOf, addPhase, namesMatch, looksLikePhase2Of };
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
function bossCap(low) {
  const def = Roster.get(low), o = cfg.bosses[low] || {};
  const base = o.cap != null ? o.cap : (def && def.defaultCap != null ? def.defaultCap : cfg.defaultBossCap);
  if (o.switchAt && o.capAfterSwitch != null) {       // "from this SERVER time on, use this cap"
    const mins = serverMinutes();
    if (mins != null) { const [h, m] = o.switchAt.split(':').map(Number); if (mins >= h * 60 + (m || 0)) return o.capAfterSwitch; }
  }
  return base;
}
function bossLoc(low) {
  const def = Roster.get(low), o = cfg.bosses[low] || {};
  const gate = o.gate != null ? o.gate : def && def.gate, wave = o.wave != null ? o.wave : def && def.wave;
  return gate && wave ? { gate, wave } : null;
}

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
  load();
  window.addEventListener('beforeunload', () => { dirty = true; save(); });
  boardStore.watch((v) => { if (v && !Tab.isMain()) { b = v; UI.dirty('status'); } });
  // a gribble (swarm mob) died or was capped by the server: forget just that one
  function dropSwarm(t) { const e = b[t.low]; if (!e || !e.swarm) return; e.swarm = e.swarm.filter((x) => !(String(x.monsterId) === String(t.monsterId) && String(x.instanceId) === String(t.instanceId))); if (!e.swarm.length) e.alive = false; touch(); }
  return { get, load, put, patch, dealt, confirm, dropSwarm, all: () => b, save };
})();

/* ---- targets: everything the engine may attack right now, in priority order (first tick = first priority) --------- */
function candidates() {
  const out = [], now = Date.now();
  for (const low of cfg.targets) {
    const def = Roster.get(low), e = Board.get(low); if (!def || !e || e.alive !== true) continue;
    if (def.kind !== 'wave' && !Kernel.isOn('dungeons')) continue;      // the Dungeons part is switched off: wave bosses only
    if (def.kind === 'wave' && !Kernel.isOn('bosses')) continue;         // the Wave bosses part is switched off
    const cap = bossCap(low); if (cap <= 0) continue;
    if (e.pausedUntil && e.pausedUntil > now) continue;
    if (def.kind === 'dungeon-swarm') {
      for (const s of e.swarm || []) { if ((s.userDmg || 0) < cap) out.push({ low, name: def.name, kind: 'dungeon', monsterId: s.monsterId, instanceId: s.instanceId, locationId: s.locationId, userDmg: s.userDmg || 0, cap, swarm: true }); }
      continue;
    }
    if (!e.monsterId) continue;
    if ((e.userDmg || 0) >= cap) continue;
    if (e.needsDuel && e.duelRetryAt && e.duelRetryAt > now) continue;
    out.push({ low, name: e.name || def.name, kind: def.kind === 'wave' ? 'wave' : 'dungeon', monsterId: e.monsterId, instanceId: e.instanceId, locationId: e.locationId, userDmg: e.userDmg || 0, cap });
  }
  return out;
}
const targetKey = (t) => `${t.kind}:${t.instanceId || ''}:${t.monsterId}`;

/* ---- slots the other parts fill in. Each has a harmless stub, so deleting PART 2 / 3 / 4 never breaks the wave bosses ---- */
const Dungeons = { nextCheck: () => Infinity, refresh: async () => {}, sideMobs: null, corpses: null };   // PART 2 fills this
const Duels = { fight: null, bootPage: () => {} };                                                         // PART 3 fills this
const Loot = { onStamStall: async () => {} };                                                              // PART 4 fills this

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
    Guard.ok();
    const now = Date.now(), seen = new Set(), tracked = new Set();
    for (const [low, loc] of Object.entries(Object.fromEntries(Roster.list.map((d) => [d.low, bossLoc(d.low)])))) if (loc && loc.gate === gate && loc.wave === wave) tracked.add(low);
    doc.querySelectorAll('.monster-container .monster-card, .monster-card').forEach((card) => {
      if (!cardAlive(card)) return;
      const id = cardId(card); const raw = (card.dataset.name || (card.querySelector('.monster-name,.name,h2,h3') || {}).textContent || '').trim();
      if (!id || !raw) return;
      let low = raw.toLowerCase(), def = Roster.get(low);
      if (!def) {                                      // unknown name on a boss page: is it a phase of a tracked boss?
        for (const t of tracked) { const d = Roster.get(t); if (d && d.kind === 'wave' && Roster.looksLikePhase2Of(Roster.canon(d), raw)) { def = Roster.addPhase(Roster.canon(d), raw); log(`🆕 auto-detected phase for ${esc(d.name)}: ${esc(raw)}`, 'info'); break; } }
      }
      if (!def || seen.has(def.low)) return;
      low = def.low; seen.add(low);
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
    if (e.alive) return e.seenAt + ((e.userDmg || 0) >= bossCap(low) ? cfg.idleRecheckMs : cfg.fightScanMs);
    if (e.nextTs && e.nextTs * 1000 + 120000 > now) return Math.max(e.seenAt + 5000, Math.min(e.nextTs * 1000 - cfg.spawnLeadMs, e.seenAt + cfg.maxIdleRecheckMs));
    return e.seenAt + cfg.idleRecheckMs;
  }
  const dueLows = (force) => cfg.targets.filter((l) => force || nextCheck(l) <= Date.now());
  const anyDue = () => dueLows(false).length > 0;
  const nextDueIn = () => { let m = Infinity; for (const l of cfg.targets) m = Math.min(m, nextCheck(l)); return Math.max(0, m - Date.now()); };
  async function run(force) {
    const due = dueLows(force), pages = new Map(), dd = [];
    for (const low of due) {
      const def = Roster.get(low); if (!def) continue;
      if (def.kind !== 'wave') { dd.push(low); continue; }
      const loc = bossLoc(low);
      if (!loc) { if (!warned.has(low)) { warned.add(low); log(`⚠️ ${esc(bossName(low))}: no gate/wave known — set it in Bosses`, 'warn'); } continue; }
      pages.set(`${loc.gate}/${loc.wave}`, loc);
    }
    for (const loc of pages.values()) { if (!Run.active()) return; await page(loc.gate, loc.wave); await sleep(150); }
    if (dd.length) await Dungeons.refresh(dd);
  }
  return { page, run, anyDue, nextDueIn, nextCheck, cardAlive, cardId };
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
    if (cfg.mana.name) return cfg.mana.name;
    if (manaName) return manaName;
    for (const n of NAMES[cfg.mana.type] || NAMES.S) { const f = await Core.potions.find(n).catch(() => null); if (f) { manaName = n; return n; } }
    return '';
  }
  async function refillMana(why) {
    if (!cfg.mana.enabled || refilling || Date.now() < outUntil) return false;
    if (!Me.mpKnown) await Me.refresh(0);
    if (!Me.mpKnown) return false;
    const target = cfg.mana.fullMaxAt0 && Me.mp <= 0 ? Me.maxMp : cfg.mana.fillTo;
    if (Me.mp >= target) return false;
    refilling = true;
    try {
      const name = await resolveMana();
      if (!name) { outUntil = Date.now() + 60000; warn('⚠️ no Mana Potion found in sidebar/inventory — set its exact name in Potions'); return false; }
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
    if (!cfg.stam.save.enabled) return true;
    const pct = Me.expPct(); if (pct == null) return true;
    if (pct >= cfg.stam.save.thresholdPct) { if (Date.now() - saveWarn > 30000) { saveWarn = Date.now(); log(`⏸️ stamina potions paused — EXP ${pct.toFixed(1)}% ≥ save threshold`, 'info'); } return false; }
    return true;
  }
  async function refillStamina() {
    if (!canUseStam()) return false;
    for (const slot of ['A', 'B']) {
      const c = cfg.stam[slot]; if (!c.enabled) continue;
      const r = await Core.potions.stamina({ item: c.item });
      if (r.ok) {
        try { await Core.me.sync(); } catch (_) { /* */ }
        stats['stam' + slot]++; log(`🧪 ${esc(c.item)} ${r.used ? 'used' : 'covered by another script'} · stamina ${Me.stam()}/${Me.maxStam()}`, 'info'); return true;
      }
      if (r.reason === 'none-available') warn(`⚠️ no ${esc(c.item)} left`);
    }
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
  const RESERVED = new Set(['cap', 'gate', 'wave', 'targeting', 'switchAt', 'capAfterSwitch']);   // boss fields a kind must not shadow
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
  // Called between swings, when the engine moves to a boss. Applies the boss's preset of each kind if it is not already on.
  async function ensure(low) {
    const o = cfg.bosses[low] || {};
    for (const kind of kinds()) {
      const want = o[kind]; if (!want || applied[kind] === String(want)) continue;
      const key = kind + ':' + want;
      if (Date.now() - (failedAt[key] || 0) < 300000) continue;           // a failed apply is not retried for 5 min
      log(`🎒 applying ${kind} preset "${esc(nameOf(kind, want))}" for ${esc(bossName(low))}…`, 'info');
      let r;
      try { r = await withTimeout(Core.call('preset.' + kind + '.apply', String(want), { silent: true }), 120000, { ok: false, message: 'timed out' }); }
      catch (e) { r = { ok: false, message: (e && e.code === 'NO_CAP') ? 'the addon that offered it is gone' : ((e && e.message) || String(e)) }; }
      if (r && r.ok !== false) { applied[kind] = String(want); log(`✅ ${kind} preset applied`, 'ok'); try { await Core.me.sync(); } catch (_) { /* */ } Me.statsAt = 0; }
      else { failedAt[key] = Date.now(); log(`⚠️ ${kind} preset "${esc(nameOf(kind, want))}" failed: ${esc((r && r.message) || 'unknown')}`, 'warn'); }
    }
  }
  // "gear: Boss gear · pet: Boss pets" for the Status tab, or an em dash when nothing was applied this session
  const summary = () => { const a = kinds().filter((k) => applied[k]).map((k) => k + ': ' + nameOf(k, applied[k])); return a.length ? a.join(' · ') : '—'; };
  const note = () => !haveCaps() ? 'needs Core 3.16.0+' : (kinds().length ? kinds().map((k) => `${k} (${list(k).length})`).join(' · ') : 'none offered');
  return { kinds, available, list, ensure, summary, note, applied: () => Object.assign({}, applied), forget: () => { Object.keys(applied).forEach((k) => delete applied[k]); } };
})();

/* ---- side-mob / shielded-boss support (TOGGLE, off by default: it should not be needed) ------------------------------
 * A shielded boss rejects the class skill ("divine shield" / "couldn't pierce"). With the toggle on we remember that, and cast
 * ONLY the class skill on a live non-boss, non-shielded mob (a dungeon mob, else a wave mob); the damage attack always goes to
 * the real boss. Per boss: targeting normal (never divert) | shielded (always divert) | auto (divert once the server says so).
 */
const SideMob = (() => {
  const shStore = Core.store(ID + '-shielded', { def: [] });
  const shielded = new Set(shStore.get() || []);
  const saveSh = () => { let a = [...shielded]; if (a.length > 300) { a = a.slice(-300); shielded.clear(); a.forEach((k) => shielded.add(k)); } shStore.set(a); };
  const SHIELD_RE = /divine shield|couldn'?t pierce|cannot pierce/i;
  const isShieldMsg = (m) => SHIELD_RE.test(String(m == null ? '' : m));
  const keyOf = (t) => (t.kind || 'wave') + ':' + t.monsterId + (t.instanceId ? ':' + t.instanceId : '');
  const modeOf = (low) => { const m = (cfg.bosses[low] || {}).targeting; return m === 'normal' || m === 'shielded' ? m : 'auto'; };
  const eligible = (t) => !!cfg.sideMob.enabled && modeOf(t.low) !== 'normal';
  const isShielded = (t) => shielded.has(keyOf(t));
  const mark = (t) => { const k = keyOf(t); if (!shielded.has(k)) { shielded.add(k); saveSh(); } };
  let cache = null; const joined = new Map();

  async function waveMob(t) {
    const loc = bossLoc(t.low); if (!loc) return null;
    let html; try { html = await Core.net.fetchText(`/active_wave.php?gate=${loc.gate}&wave=${loc.wave}`, { ttl: 15000, key: `ma:wave:${loc.gate}:${loc.wave}`, via: (run) => Core.cookies.withMode('alive', run) }); } catch (_) { return null; }
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
    const now = Date.now(), lk = cfg.sideMob.locked;
    if (lk && lk.monsterId && lk.instanceId) {
      const mob = { kind: 'dungeon', monsterId: String(lk.monsterId), instanceId: String(lk.instanceId), locationId: lk.locationId || lk.locId || '', name: lk.name || 'locked side mob' };
      if (!shielded.has(keyOf(mob)) && keyOf(mob) !== keyOf(t)) return mob;
    }
    if (cache && cache.exp > now && keyOf(cache.mob) !== keyOf(t) && !shielded.has(keyOf(cache.mob))) return cache.mob;
    let mob = null;
    try { if (Dungeons.sideMobs) mob = await Dungeons.sideMobs(keyOf(t), shielded); } catch (_) { /* fall back to a wave mob */ }
    if (!mob) { mob = await waveMob(t); if (mob) log(`🌊 no dungeon mob for the pierce — using wave mob ${esc(mob.name)}`, 'info'); }
    if (mob) cache = { mob, exp: now + 30000 };
    else log('⚠️ no usable side mob (all dungeon / wave mobs empty, locked or shielded)', 'warn');
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
  let token = 0, loopRunning = false, forceScan = true, current = null, curLow = '', idleSince = 0, wake = false;
  let skillOffUntil = 0, stallLogAt = 0, lastFightAt = 0;
  const skip = new Map(), fails = new Map(), capLogged = new Set();
  const live = (tk) => tk === token && Run.active();
  async function sleepLive(tk, ms) {
    const end = Date.now() + ms;
    while (live(tk) && !wake && Date.now() < end) await sleep(Math.min(500, Math.max(0, end - Date.now())));
    wake = false;
  }
  const tfields = (t) => (t.kind === 'dungeon' ? { dgmid: t.monsterId, instance_id: t.instanceId, location_id: t.locationId } : { monster_id: t.monsterId });
  const act = (t, fn, gap) => Act.run(fn, t.kind === 'dungeon' ? 0 : gap);
  const remPct = (cap, dealt) => (cap > 0 ? (Math.max(0, cap - dealt) / cap * 100).toFixed(1) : '0');
  let lastWarn = { msg: '', at: 0 };
  const warnOnce = (msg) => { if (lastWarn.msg !== msg || Date.now() - lastWarn.at > 30000) { lastWarn = { msg, at: Date.now() }; log(msg, 'warn'); } };

  // one cast of the class skill (optionally redirected to a side mob). Returns { used, total (of the cast target), shield, stop }
  async function castSkill(t, cs, tk, target) {
    const r = await act(t, () => postForm('/damage.php', Object.assign(SideMob.targetFields(target), { skill_id: cs.id, stamina_cost: 1 })), cfg.minActionGapMs);
    if (!live(tk)) return { stop: true };
    const j = r.json || {}, msg = String(j.message || j.error || '');
    if (j.status === 'success' || j.totaldmgdealt !== undefined) {
      Me.mp = j.mp !== undefined ? parseNum(j.mp) : Math.max(0, Me.mp - cs.cost);
      try { Core.me.fromAttack(j); } catch (_) { /* */ }
      return { used: true, total: parseNum(j.totaldmgdealt, NaN) };
    }
    return { used: false, msg, cr: classifyReject(msg || JSON.stringify(j)), r };
  }

  async function swing(t, tk) {
    const cap = bossCap(t.low); let cur = Board.dealt(t);
    if (!(cap > 0) || cur >= cap) return { ok: false, reason: 'capped' };
    const userId = uid();
    if (!userId) return { ok: false, reason: 'auth' };

    // 1) JOIN (every swing, like 3.0.0)
    const jr = await act(t, () => postForm(t.kind === 'dungeon' ? '/dungeon_join_battle.php' : '/user_join_battle.php',
      t.kind === 'dungeon' ? { dgmid: t.monsterId, instance_id: t.instanceId, location_id: t.locationId } : { monster_id: t.monsterId, user_id: userId }), cfg.minActionGapMs);
    if (!live(tk)) return { ok: false, reason: 'halt' };
    if (jr.text && /invalid monster|already dead/i.test(jr.text)) return { ok: false, reason: 'dead' };
    if (jr.status === 0) warnOnce('⚠️ join request failed: ' + esc(jr.text));

    // 2) CLASS SKILL (optional bonus hit; mana is refilled first when it is low)
    const cls = cfg.useClassSkill && cfg.mana.enabled ? effectiveClass() : null, cs = cls ? CLASS_SKILLS[cls] : null;
    let skillUsed = false;
    if (cs && Date.now() >= skillOffUntil) {
      if (Me.mpKnown && (Me.mp <= cfg.mana.threshold || Me.mp < cs.cost)) await Potions.refillMana('auto');
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
    const attackGap = cs ? (skillUsed ? cfg.skillToAttackGapMs : 600) : 120;

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
        if (!capLogged.has(k)) { capLogged.add(k); if (capLogged.size > 400) capLogged.clear(); log(`✅ ${esc(t.name)} capped (${fmtNum(Board.dealt(t))}/${fmtNum(bossCap(low))})`, 'ok'); }
        if (t.swarm) Board.dropSwarm(t);
        return;
      }
      case 'dead':
        log(`⏭️ ${esc(t.name)} is dead`, 'info');
        if (t.swarm) Board.dropSwarm(t); else Board.patch(low, { alive: false });
        if (t.kind === 'wave' && loc) await Scan.page(loc.gate, loc.wave);     // the page knows the respawn time
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
          if (won) { Board.patch(low, { needsDuel: false, duelRetryAt: 0 }); forceScan = true; log(`✅ Phase Duel for ${esc(t.name)} won — resuming`, 'ok'); }
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
    Status.set('RUNNING');
    try { await Core.me.sync(); } catch (_) { /* */ }
    await Me.refresh(0);
    if (!cfg.detectedClass) detectClass().catch(() => {});
    while (live(tk)) {
      try {
        if (Guard.isFaulted()) { await sleepLive(tk, 2000); continue; }
        if (forceScan || Scan.anyDue()) { const f = forceScan; forceScan = false; await Scan.run(f); if (!live(tk)) break; }
        const now = Date.now();
        const list = candidates().filter((t) => !((skip.get(targetKey(t)) || 0) > now));
        if (!list.length) {
          current = null; curLow = '';
          if (!idleSince) idleSince = now;
          Status.set('WAITING');
          Diag.skip('no-target', `${cfg.targets.length} selected — none alive and under its cap`);
          if (now - idleSince > 15000) await AF.resumeIfWePaused('nothing to fight');
          const next = Scan.nextDueIn();
          await sleepLive(tk, Math.min(5000, Math.max(500, Number.isFinite(next) ? next : 5000)));
          continue;
        }
        idleSince = 0;
        const t = list[0];
        if (t.low !== curLow) {
          current = t; curLow = t.low;
          log(`🎯 target: ${esc(t.name)} (cap ${fmtNum(t.cap)}, dealt ${fmtNum(t.userDmg)})`, 'ok');
          try { Core.emit('automator:target', { name: t.name, low: t.low, kind: t.kind, cap: t.cap }); } catch (_) { /* */ }
          await Presets.ensure(t.low);
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
(function seedDungeonRoster() {
  [
    { name: 'The Goblin Royal Vizier', defaultCap: 2e9, kind: 'dungeon', locationId: 6, dtype: 'hard' },
    { name: 'Vorrak the Bloodbound Berserker', defaultCap: 2e9, kind: 'dungeon', locationId: 7, dtype: 'hard' },
    { name: 'Grimgrowl the Chimera', defaultCap: 2e9, kind: 'dungeon', locationId: 8, dtype: 'hard' },
    { name: 'Drazhul The Broken Crown', defaultCap: 2e9, kind: 'dungeon', locationId: 9, dtype: 'hard' },
    { name: 'Khaal The Abomination Prince', defaultCap: 3e9, kind: 'dungeon', locationId: 10, dtype: 'hard', mapGated: true },
    { name: 'Gribbles (Shadowbridge)', defaultCap: 1e6, kind: 'dungeon-swarm', dtype: 'easy', locationIds: [2, 4], swarmMatch: /gribble/i },
  ].forEach((d) => Roster.add(d));
  const khaal = Roster.get('khaal the abomination prince');
  if (khaal) Roster.addPhase(khaal, 'Khaal Sovereign of the Shattered Bloodline', 2e9);
})();

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
      if (def.mapGated) {                                                  // Khaal: the map pin says whether the throne is open
        const p = await pins(id), bp = p && p.find((x) => x.isBoss);
        if (bp && bp.isLocked) { sawLocked = { locked: true, live: def, inst: id }; continue; }
      }
      const r = await getDoc(`${LOC}?instance_id=${id}&location_id=${def.locationId}`, 8000, `ma:dloc:${id}:${def.locationId}`);
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
      return { live, inst: id, id: dgmid, name: scraped || live.name, icon: iconOf(card), userDmg: joined ? ((await dmgOn(id, dgmid)) || 0) : 0 };
    }
    return sawDead || sawLocked || null;
  }
  const base = (low, p) => Object.assign({ low, name: bossName(low), kind: 'dungeon' }, p);
  async function refreshBoss(def) {
    const f = await discover(def); if (f === undefined) return;            // undefined: a login / maintenance page, the guard has taken over
    const now = Date.now(), liveLow = f && f.live ? f.live.low : def.low;
    for (const s of Roster.members(def)) { if (s.low === liveLow) continue; const pe = Board.get(s.low); if (pe && pe.alive !== false) Board.patch(s.low, { alive: false, locked: false, noInstance: false, seenAt: now }); }
    const prev = Board.get(liveLow) || {}, sameInst = f && prev.instanceId && String(prev.instanceId) === String(f.inst);
    if (!f) { Board.patch(liveLow, base(liveLow, { alive: false, locked: false, noInstance: true, seenAt: now })); return; }
    if (f.dead) { Board.patch(liveLow, base(liveLow, sameInst ? { alive: false, locked: false, noInstance: false, instanceId: f.inst, seenAt: now } : { alive: false, locked: false, noInstance: false, instanceId: f.inst, monsterId: undefined, userDmg: 0, seenAt: now })); return; }
    if (f.locked) { Board.patch(liveLow, base(liveLow, { alive: false, locked: true, noInstance: false, instanceId: f.inst, seenAt: now })); return; }
    const same = sameInst && String(prev.monsterId) === String(f.id);
    Board.patch(liveLow, base(liveLow, {
      alive: true, locked: false, noInstance: false, monsterId: f.id, instanceId: f.inst, locationId: Roster.canon(def).locationId, name: f.name, icon: f.icon,
      userDmg: Math.max(same ? prev.userDmg || 0 : 0, f.userDmg || 0), firstAliveAt: same && prev.firstAliveAt ? prev.firstAliveAt : now, needsDuel: same ? prev.needsDuel : false, seenAt: now,
    }));
  }

  /* ---- the Gribble swarm: many small mobs, one fightable target per live Gribble still under the cap ---- */
  async function refreshSwarm(def) {
    const ins = await instances(), cap = bossCap(def.low), prev = Board.get(def.low) || {}, now = Date.now(), jobs = [];
    for (const id of ins.v[def.dtype] || []) for (const loc of def.locationIds) {
      const r = await getDoc(`${LOC}?instance_id=${id}&location_id=${loc}`, 8000, `ma:dloc:${id}:${loc}`);
      if (!r) continue; if (!r.doc) return;
      if (/route is still sealed/i.test(r.html)) continue;
      for (const card of r.doc.querySelectorAll('.mon')) {
        if (card.classList.contains('dead')) continue;
        if (!def.swarmMatch.test(monName(card))) continue;
        const dgmid = dgmidOf(card); if (dgmid) jobs.push({ id: String(id), loc, dgmid, joined: pillTexts(card).includes('joined') });
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
    Board.put(def.low, { low: def.low, name: def.name, kind: 'dungeon-swarm', alive: found.length > 0, swarm: found, totalAlive: jobs.length, seenAt: Date.now() });
  }

  /* ---- the Scan hooks ---- */
  function nextCheck(def) {
    const now = Date.now(), e = Board.get(def.low); if (!e || !e.seenAt) return now;
    if (e.alive && def.kind !== 'dungeon-swarm' && (e.userDmg || 0) >= bossCap(def.low)) return e.seenAt + cfg.idleRecheckMs;
    return e.seenAt + (e.locked ? cfg.dungeonPollMs * 2 : cfg.dungeonPollMs);
  }
  async function refresh(lows) {
    const seen = new Set();
    for (const low of lows) {
      const def = Roster.get(low); if (!def || def.kind === 'wave') continue;
      const key = def.group ? 'g:' + def.group : def.low; if (seen.has(key)) continue; seen.add(key);
      try { if (def.kind === 'dungeon-swarm') await refreshSwarm(def); else await refreshBoss(def); }
      catch (e) { log(`⚠️ dungeon check (${esc(def.name)}): ${e.message}`, 'warn'); }
      await sleep(150);
    }
  }

  /* ---- a live non-boss mob for the shield pierce (Shadowbridge orcs first; the cube is never used) ---- */
  async function sideMobs(excludeKey, shielded) {
    const ins = await instances();
    for (const id of ins.v.easy || []) for (const loc of [1, 3, 2, 4]) {
      const r = await getDoc(`${LOC}?instance_id=${id}&location_id=${loc}`, 8000, `ma:dloc:${id}:${loc}`);
      if (!r || !r.doc || /route is still sealed/i.test(r.html)) continue;
      for (const card of r.doc.querySelectorAll('.mon')) {
        if (card.classList.contains('dead')) continue;
        const name = monName(card), dgmid = dgmidOf(card); if (!dgmid || Roster.get(name.toLowerCase())) continue;
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

  return { nextCheck, refresh, sideMobs, instances, pins, deadMobs, dmgOn, pool };
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
  const pickSkill = (skills) => { const u = (skills || []).filter((s) => s.target === 'enemy' || s.target === 'self'); return u.length ? u.slice().sort((a, b) => (b.cost || 0) - (a.cost || 0))[0] : null; };   // highest cost = hardest hit

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
            const target = pickTarget(st), skill = pickSkill(me.skills);
            if (skill && (skill.target === 'self' || target)) {
              try { await doAction(qs, 'use_skill', { skill_id: skill.id, target_key: skill.target === 'self' ? '' : target.key }); log(`⚔️ [Duel] used ${esc(skill.name || 'a skill')}${target ? ` on ${esc(target.username || 'the enemy')}` : ''}`, 'dmg'); }
              catch (e) { log(`⚠️ [Duel] action failed: ${e.message}`, 'warn'); }
            } else if (Date.now() - warnedAt > 30000) { warnedAt = Date.now(); log('⚠️ [Duel] no usable skill / target this turn', 'warn'); }
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
  id: 'loot', name: 'Graveyard & loot', icon: '🪦',
  every: () => (cfg.autoLoot.enabled ? cfg.autoLoot.scanMs || 60000 : 0),
  tick: () => Loot.scan(),
});
Object.assign(Loot, (() => {
  const st = { rows: [], scanning: false, looting: false, lastScanAt: 0, lastStuckAt: 0, claiming: new Set() };
  const rate = new Map(), capInfo = new Map(), upTo = new Map(), dmgCache = new Map();
  const syncMe = async () => { try { await Core.me.sync(); } catch (_) { /* */ } };
  const expNeeded = () => { const m = Core.me.get(), e = m && m.exp; return e && e.max > 0 ? Math.max(0, e.max - e.cur) : null; };

  /* ---- wave corpses: the wave page with the monster cookies set to show dead ones ---- */
  async function waveRows() {
    const seen = new Set(), locs = [], out = [];
    for (const d of Roster.list) { if (d.kind !== 'wave') continue; const l = bossLoc(d.low); if (!l) continue; const k = l.gate + '/' + l.wave; if (!seen.has(k)) { seen.add(k); locs.push(l); } }
    for (const l of locs) {
      let html;
      try { html = await Core.net.fetchText(`/active_wave.php?gate=${l.gate}&wave=${l.wave}`, { ttl: 20000, key: `ma:gy:${l.gate}:${l.wave}`, via: (run) => Core.cookies.withMode('all', run) }); }
      catch (e) { log(`⚠️ graveyard fetch failed (${l.gate}/${l.wave}): ${e.message}`, 'warn'); continue; }
      const doc = parseHtml(html), s = Guard.pageState(doc);
      if (s !== 'ok') { Guard.fault(s, `graveyard ${l.gate}/${l.wave}`); return out; }
      if (!Guard.chromeOk(doc)) { Diag.skip('graveyard-page-no-chrome', `${l.gate}/${l.wave}`); continue; }
      const nowSec = Math.floor(Date.now() / 1000);
      doc.querySelectorAll('.monster-card[data-dead="1"][data-joined="1"]').forEach((card) => {
        const dmg = parseNum(card.dataset.userdmg, 0); if (dmg <= 0) return;
        const exp = parseNum(card.dataset.expire, 0); if (exp > 0 && exp < nowSec) return;       // despawned: nothing to claim
        const id = card.dataset.monsterId, raw = (card.dataset.name || '').trim(); if (!id || !raw) return;
        const img = card.querySelector('img');
        out.push({ key: 'wave:' + id, kind: 'wave', monsterId: String(id), name: raw, nameLow: raw.toLowerCase(), isBoss: !!Roster.get(raw.toLowerCase()), icon: img ? img.getAttribute('src') : undefined, userDamage: dmg, needsLoot: true });
      });
      await sleep(150);
    }
    return out;
  }

  /* ---- dungeon corpses: Castle locations the map shows as cleared, Shadowbridge Gribble rooms. Never the cube. ---- */
  async function dungeonRows() {
    const ins = await Dungeons.instances(true), out = [];
    const all = (t) => [...new Set([...(ins.v[t] || []), ...(ins.ended[t] || [])])];
    const push = (rows, inst, loc, isBoss) => rows.forEach((r) => out.push({ key: `dungeon:${inst}:${r.dgmid}`, kind: 'dungeon', monsterId: r.dgmid, instanceId: inst, locationId: loc, name: r.name, nameLow: r.name.toLowerCase(), isBoss, icon: r.icon, userDamage: null, needsLoot: true, expPerDmg: r.expPerDmg }));
    const hard = all('hard'), pinSets = await Dungeons.pool(hard, (id) => Dungeons.pins(id), 3), jobs = [];
    hard.forEach((id, i) => (pinSets[i] || []).forEach((p) => { if (!p.isLocked && p.isDone && p.locationId != null) jobs.push({ inst: id, loc: p.locationId }); }));
    const hr = await Dungeons.pool(jobs, (j) => Dungeons.deadMobs(j.inst, j.loc), 4);
    jobs.forEach((j, i) => push(hr[i] || [], j.inst, j.loc, true));
    const easy = []; all('easy').forEach((id) => [2, 4].forEach((loc) => easy.push({ inst: id, loc })));
    const er = await Dungeons.pool(easy, (j) => Dungeons.deadMobs(j.inst, j.loc, 'Gribble'), 4);
    easy.forEach((j, i) => push(er[i] || [], j.inst, j.loc, false));
    return out;
  }

  async function scan() {
    if (st.scanning) return; st.scanning = true; UI.dirty('loot');
    try {
      const w = await waveRows();
      const d = Kernel.isOn('dungeons') ? await dungeonRows() : [];
      st.rows = [...w, ...d]; st.lastScanAt = Date.now();
    } catch (e) { log(`⚠️ graveyard scan error: ${e.message}`, 'warn'); }
    finally { st.scanning = false; UI.dirty('loot'); }
  }

  /* ---- EXP estimate per corpse (one battle page per monster NAME gives rate, cap and reward level) ---- */
  const battleUrl = (r) => (r.kind === 'dungeon' ? `/battle.php?dgmid=${r.monsterId}&instance_id=${r.instanceId}` : `/battle.php?id=${r.monsterId}`);
  const block = (doc, label) => Array.from(doc.querySelectorAll('.stat-block')).find((b) => ((b.querySelector('.label') || {}).textContent || '').trim() === label);
  async function loadInfo(r) {
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
  // biggest corpse that still fits the EXP gap first; when nothing fits, the smallest one closes it
  function descendingPlan(known, needed) {
    const pool = known.slice().sort((a, b) => b.est - a.est), plan = []; let left = needed;
    while (left > 0 && pool.length) { let i = pool.findIndex((x) => x.est <= left); if (i === -1) i = pool.length - 1; const [p] = pool.splice(i, 1); plan.push(p.r); left -= p.est; }
    return plan;
  }
  async function buildPlan(rows) {
    if (cfg.autoLoot.mode === 'all') return rows;
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
          if (cfg.autoLoot.mode === 'toLevel' && Me.level() > startLevel) { log('✅ leveled up — stopping the loot pass', 'ok'); break; }
        } else log(`⚠️ loot claim failed for ${esc(row.name)}`, 'warn');
        UI.dirty('loot'); await sleep(cfg.autoLoot.claimGapMs || 500);
      }
    } finally { st.looting = false; UI.dirty('loot'); }
  }
  async function claimGroup(nameLow) {                         // the "Claim all" button of one monster name
    if (st.claiming.has(nameLow)) return; st.claiming.add(nameLow); UI.dirty('loot');
    try {
      for (const row of st.rows.filter((r) => r.nameLow === nameLow && r.needsLoot !== false)) {
        const res = await claim(row);
        if (res.ok) { log(`🎒 looted ${esc(row.name)}${res.expDelta ? ` (+${fmtNum(res.expDelta)} EXP)` : ''}`, 'ok'); row.needsLoot = false; if (res.expDelta > 0) await syncMe(); }
        else log(`⚠️ claim failed for ${esc(row.name)}`, 'warn');
        UI.dirty('loot'); await sleep(cfg.autoLoot.claimGapMs || 500);
      }
      st.rows = st.rows.filter((r) => r.needsLoot !== false);
    } finally { st.claiming.delete(nameLow); UI.dirty('loot'); }
  }
  async function onStamStall() {
    if (!cfg.autoLoot.enabled || !Kernel.isOn('loot') || !Tab.isMain()) return;
    if (st.scanning || st.looting || Date.now() - st.lastStuckAt < 15000) return;
    st.lastStuckAt = Date.now();
    log('⏸️ out of stamina and no potion — checking the graveyard for loot', 'info');
    await scan(); await pass();
  }
  return { onStamStall, scan, pass, claimGroup, state: st, estimate, claimOne: async (row) => { const r = await claim(row); if (r.ok) { st.rows = st.rows.filter((x) => x.key !== row.key); UI.dirty('loot'); } return r; } };
})());

/* ===================================================================================================================
 * PART 5 — PANEL (one Core.float button + panel: Status, Bosses, Potions, Graveyard, Log, Diagnostics, Settings)
 * Same look as Gear / Crystal / Pet Presets and Account Switcher: Core's own classes (core-btn / core-input / core-footer /
 * core-empty / core-pill / core-dim) plus a few ma-* ones that copy the preset addons' card rows (#11192d, 14px corners).
 * One scroller (Core's modal), no nested scroll areas. Forms are never redrawn while you are typing in them.
 * ================================================================================================================ */
const Panel = (() => {
  const { h, btn } = Core.ui;
  const TABS = [['status', 'Status'], ['bosses', 'Bosses'], ['potions', 'Potions'], ['graveyard', 'Graveyard'], ['log', 'Log'], ['diag', 'Diagnostics'], ['settings', 'Settings']];
  const DIRTY_TAB = { status: 'status', log: 'log', diag: 'diag', loot: 'graveyard' };
  let root = null, tab = 'status', open = false, drawT = 0;
  const openOpts = new Set();   // bosses whose "Options" are expanded (kept across redraws)

  (function css() {
    if (document.getElementById('ma-css')) return;
    const s = document.createElement('style'); s.id = 'ma-css';
    s.textContent = `
.ma-hero{display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:12px 14px;margin-bottom:12px;background:#11192d;border:1px solid rgba(255,255,255,.06);border-radius:16px}
.ma-hero-main{flex:1 1 220px;min-width:0}
.ma-hero-top{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ma-hero-target{margin-top:6px;font:800 14px Arial,sans-serif;color:#eef3ff;overflow-wrap:anywhere}
.ma-tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
.ma-tab{padding:7px 12px}
.ma-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-bottom:12px}
.ma-card{background:#11192d;border:1px solid rgba(255,255,255,.06);border-radius:14px;padding:10px 12px;min-width:0}
.ma-k{font:700 11px Arial,sans-serif;color:#9caad0;text-transform:uppercase;letter-spacing:.03em;margin-bottom:4px}
.ma-v{font:800 14px Arial,sans-serif;color:#eef3ff;overflow-wrap:anywhere}
.ma-panel{background:#11192d;border:1px solid rgba(255,255,255,.06);border-radius:14px;padding:12px 14px;margin-bottom:10px}
.ma-sec{font:800 12px Arial,sans-serif;color:#9fc1ff;text-transform:uppercase;letter-spacing:.05em;margin:0 0 10px}
.ma-sec.out{margin:14px 0 8px}
.ma-note{color:#9caad0;font-size:12px;margin:0 0 12px}
.ma-row{display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:12px;margin-bottom:10px;background:#11192d;border:1px solid rgba(255,255,255,.06);border-radius:14px}
.ma-row.on{border-color:rgba(51,181,127,.45);background:linear-gradient(180deg,#132a22,#11192d 70%)}
.ma-row-main{flex:1 1 200px;min-width:0}
.ma-row-name{font-weight:800;color:#eef3ff;overflow-wrap:anywhere}
.ma-row-meta{color:#9caad0;font-size:12px;margin-top:2px;overflow-wrap:anywhere}
.ma-row-actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.ma-row-actions .core-btn{padding:6px 10px;font-size:12px}
.ma-num{flex:0 0 auto;width:28px;height:28px;border-radius:10px;background:#18223a;color:#cfd8f7;font:800 12px Arial,sans-serif;display:flex;align-items:center;justify-content:center}
.ma-tick,.ma-chk input{accent-color:#4b6dd0;width:17px;height:17px;margin:0;cursor:pointer;flex:0 0 auto}
.ma-bar{height:5px;border-radius:999px;background:#0d1322;margin-top:8px;overflow:hidden}
.ma-bar i{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,#3657a7,#4b6dd0)}
.ma-bar.full i{background:linear-gradient(90deg,#217f5b,#33b57f)}
.ma-fields{display:flex;flex-wrap:wrap;align-items:flex-end}
.ma-fields:has(.ma-fld) .ma-chk{min-height:33px}
.ma-fld{display:inline-flex;flex-direction:column;gap:6px;margin:0 12px 10px 0;vertical-align:top}
.ma-fld.in-row{margin:0}
.ma-fl{font:700 11px Arial,sans-serif;color:#9caad0;letter-spacing:.02em}
.ma-chk{display:inline-flex;gap:8px;align-items:center;margin:0 18px 10px 0;color:#dbe4ff;font:13px Arial,sans-serif;cursor:pointer}
.ma-det{flex:1 1 100%;min-width:0;border-top:1px solid rgba(255,255,255,.06);padding-top:8px}
.ma-det summary{cursor:pointer;color:#9caad0;font:700 12px Arial,sans-serif}
.ma-det summary:hover{color:#eef3ff}
.ma-opts{padding-top:12px}
.ma-log{background:#0d1322;border:1px solid rgba(255,255,255,.06);border-radius:14px;padding:10px 12px}
.ma-line{font:12px/1.6 monospace;color:#c9d4f5;overflow-wrap:anywhere}.ma-line b{color:#7f8fb8;font-weight:400}
.ma-line.err{color:#ff8a97}.ma-line.warn{color:#ffd978}.ma-line.ok{color:#8ee6a8}.ma-line.dmg{color:#9fc1ff}.ma-line.skill{color:#d6a8ff}
.ma-kv{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.05);font-size:13px;color:#dbe4ff}
.ma-kv:last-child{border-bottom:none}.ma-kv span:last-child{color:#9caad0}`;
    document.head.appendChild(s);
  })();

  /* ---- tiny form helpers ---- */
  const ago = (t) => (t ? fmtDur(Date.now() - t) + ' ago' : 'never');
  const pill = (txt, kind) => h('span', { class: 'core-pill' + (kind ? ' core-pill-' + kind : '') }, txt);
  const card = (k, v) => h('div', { class: 'ma-card' }, h('div', { class: 'ma-k' }, k), h('div', { class: 'ma-v' }, v));
  const sec = (t, out) => h('div', { class: 'ma-sec' + (out ? ' out' : '') }, t);
  const box = (...kids) => h('div', { class: 'ma-panel' }, kids);
  const foot = (...kids) => h('div', { class: 'core-footer' }, kids);
  const fld = (label, el, inRow) => h('label', { class: 'ma-fld' + (inRow ? ' in-row' : '') }, h('span', { class: 'ma-fl' }, label), el);
  const changed = (fn) => (e) => { fn(e.target); saveCfg(); };
  const check = (label, get, set) => h('label', { class: 'ma-chk' }, h('input', { type: 'checkbox', checked: get() ? true : null, onchange: changed((el) => set(el.checked)) }), label);
  const sel = (opts, cur, set, w) => h('select', { class: 'core-input', style: w ? { width: w + 'px' } : null, onchange: changed((el) => set(el.value)) },
    opts.map(([v, l]) => h('option', Object.assign({ value: v }, String(v) === String(cur) ? { selected: true } : {}), l)));
  const intIn = (obj, key, w, label) => fld(label, h('input', { class: 'core-input', style: { width: (w || 80) + 'px' }, value: obj[key], onchange: changed((el) => { const n = parseCap(el.value); if (n != null) obj[key] = n; else el.value = obj[key]; }) }));
  const pctIn = (obj, key, w, label) => fld(label, h('input', { class: 'core-input', style: { width: (w || 70) + 'px' }, value: obj[key], onchange: changed((el) => { const n = parseFloat(el.value); if (Number.isFinite(n) && n >= 0 && n <= 100) obj[key] = n; else el.value = obj[key]; }) }));
  const textIn = (obj, key, w, label, ph) => fld(label, h('input', { class: 'core-input', style: { width: (w || 140) + 'px' }, value: obj[key] || '', placeholder: ph || '', onchange: changed((el) => { obj[key] = el.value.trim(); }) }));
  const redraw = () => draw();

  /* ---- header (always visible) ---- */
  function header() {
    const st = Status.get(), cur = Engine.current(), run = Run.wanted() && !Run.paused();
    const kind = /FIGHT|RUN/.test(st) ? 'ok' : /STOP|PAUSE|NO |DEAD|FOLLOW/.test(st) ? 'error' : 'loading';
    return h('div', { class: 'ma-hero' },
      h('div', { class: 'ma-hero-main' },
        h('div', { class: 'ma-hero-top' }, pill(st, kind), h('span', { class: 'core-dim' }, Tab.isMain() ? 'main tab' : 'follower tab')),
        h('div', { class: 'ma-hero-target' }, cur ? '🎯 ' + cur.name : (Tab.isMain() ? 'No target right now' : 'Another tab is running it'))),
      run ? btn('⏹ Stop', 'danger', () => { Run.stop('stopped from the panel'); draw(); }) : btn('▶ Start', 'success', () => { Run.start(); draw(); }));
  }
  function tabsBar() { return h('div', { class: 'ma-tabs' }, TABS.map(([id, label]) => h('button', { type: 'button', class: 'core-btn ma-tab' + (id === tab ? '' : ' core-btn-soft'), onclick: () => { tab = id; draw(); } }, label))); }

  /* ---- STATUS ---- */
  function bossState(low) {
    const def = Roster.get(low), e = Board.get(low), cap = bossCap(low); if (!def) return ['?', 'error'];
    if (cap <= 0) return ['cap 0 (disabled)', ''];
    if (!e || !e.seenAt) return ['not scanned yet', 'loading'];
    if (def.kind === 'dungeon-swarm') return [`${(e.swarm || []).length} under cap / ${e.totalAlive || 0} alive`, (e.swarm || []).length ? 'ok' : ''];
    if (e.alive) { if (e.needsDuel) return ['needs Phase Duel', 'loading']; return (e.userDmg || 0) >= cap ? ['capped', ''] : ['alive', 'ok']; }
    if (e.locked) return ['locked / sealed', 'loading'];
    if (e.noInstance) return ['no open dungeon', ''];
    if (e.nextTs && e.nextTs * 1000 > Date.now()) return ['respawns in ' + fmtDur(e.nextTs * 1000 - Date.now()), ''];
    return ['not up', ''];
  }
  function statusRow(low, i) {
    const [txt, kind] = bossState(low), ev = Board.get(low) || {}, def = Roster.get(low), cap = bossCap(low);
    const swarm = !!(def && def.kind === 'dungeon-swarm'), dealt = ev.userDmg || 0, pct = cap > 0 ? Math.min(100, dealt / cap * 100) : 0;
    return h('div', { class: 'ma-row' + (kind === 'ok' ? ' on' : '') },
      h('div', { class: 'ma-num' }, i + 1),
      h('div', { class: 'ma-row-main' },
        h('div', { class: 'ma-row-name' }, bossName(low)),
        h('div', { class: 'ma-row-meta' }, swarm ? 'cap ' + fmtNum(cap) + ' per mob' : `${fmtNum(dealt)} / ${fmtNum(cap)} damage`),
        swarm || !(cap > 0) ? null : h('div', { class: 'ma-bar' + (pct >= 100 ? ' full' : '') }, h('i', { style: { width: pct.toFixed(1) + '%' } }))),
      pill(txt, kind));
  }
  function tStatus() {
    const m = Core.me.get() || {}, e = m.exp, cls = effectiveClass();
    const out = [h('div', { class: 'ma-grid' },
      card('Role', Tab.isMain() ? 'main tab (works)' : 'follower'), card('Stamina', Me.stamKnown() ? `${fmtNum(Me.stam())} / ${fmtNum(Me.maxStam())}` : '?'),
      card('HP', Me.hpKnown ? `${fmtNum(Me.hp)} / ${fmtNum(Me.maxHp)}` : '?'), card('MP', Me.mpKnown ? `${fmtNum(Me.mp)} / ${fmtNum(Me.maxMp)}` : '?'),
      card('Level · EXP', `${Me.level() || '?'} · ${Me.expPct() != null ? Me.expPct().toFixed(1) + '%' : '?'}`), card('Class', cls || 'unknown'),
      card('Hits · damage', `${stats.hits} · ${fmtNum(stats.dmg)}`), card('Potions used', `stam ${stats.stamA + stats.stamB} · hp ${stats.hpUses} · mana ${stats.mpRefills}`),
      card('Presets applied', Presets.summary()))];
    const conf = Conflicts.list(); if (conf.length) out.push(h('div', { class: 'core-err', style: { marginBottom: '10px' } }, '⛔ ' + conf.join(' · ')));
    const gi = Guard.info(); if (gi.faulted || gi.lastInfo) out.push(h('div', { class: 'core-err', style: { marginBottom: '10px' } }, '🔒 ' + (gi.lastInfo || gi.faulted) + (gi.lastInfo === 'unconfigured' ? ' — add a login source (Account Switcher) or sign in by hand' : '')));
    if (!Tab.isMain()) out.push(h('div', { class: 'ma-row' }, h('div', { class: 'ma-row-main core-dim' }, 'Another tab is the main one and does the attacking.'), btn('Take over this tab', 'soft', () => { Tab.takeOver(); })));
    out.push(sec('Bosses', true));
    if (!cfg.targets.length) out.push(h('div', { class: 'core-empty' }, 'No bosses selected — tick the ones to farm in the Bosses tab, then press Start.'));
    else out.push(h('div', {}, cfg.targets.map(statusRow)));
    out.push(foot(btn('🔎 Scan now', 'soft', () => Engine.scanNow()), btn('Clear skips', 'soft', () => { Engine.clearSkips(); Diag.clear(); draw(); })));
    return out;
  }

  /* ---- BOSSES ---- */
  const ovr = (low) => cfg.bosses[low] || (cfg.bosses[low] = {});
  function move(low, d) { const i = cfg.targets.indexOf(low), j = i + d; if (i < 0 || j < 0 || j >= cfg.targets.length) return; [cfg.targets[i], cfg.targets[j]] = [cfg.targets[j], cfg.targets[i]]; saveCfg(); Engine.poke(true); draw(); }
  function toggle(low, on) {
    const i = cfg.targets.indexOf(low);
    if (on && i < 0) { cfg.targets.push(low); Roster.members(Roster.get(low)).forEach((m) => { if (!cfg.targets.includes(m.low)) cfg.targets.push(m.low); }); }
    if (!on && i >= 0) { const grp = Roster.members(Roster.get(low)).map((m) => m.low); cfg.targets = cfg.targets.filter((x) => !grp.includes(x)); }
    saveCfg(); Engine.poke(true); draw();
  }
  function presetSel(kind, low) {
    const list = Presets.list(kind);
    return fld(kind + ' preset', sel([['', '— keep current —'], ...list.map((p) => [p.id, p.name])], ovr(low)[kind] || '', (v) => { ovr(low)[kind] = v; }, 190));
  }
  function bossRow(def) {
    const low = def.low, on = cfg.targets.includes(low), o = cfg.bosses[low] || {}, loc = bossLoc(low), swarm = def.kind === 'dungeon-swarm';
    const phaseOf = def.group && Roster.canon(def) !== def ? 'phase of ' + Roster.canon(def).name : '';
    const opts = h('details', { class: 'ma-det', open: openOpts.has(low) ? true : null, ontoggle: (e) => { if (e.target.open) openOpts.add(low); else openOpts.delete(low); } }, h('summary', {}, 'Options'),
      h('div', { class: 'ma-opts ma-fields' },
        cfg.sideMob.enabled ? fld('shield targeting', sel([['auto', 'auto'], ['normal', 'normal (never divert)'], ['shielded', 'shielded (always divert)']], SideMob.modeOf(low), (v) => { ovr(low).targeting = v; }, 190)) : null,
        ...Presets.kinds().map((k) => presetSel(k, low)),
        Presets.kinds().length ? null : h('div', { class: 'ma-note' }, 'No preset addon loaded — gear / crystal / pet presets show up here when they are.'),
        fld('switch cap at (server time)', h('input', { class: 'core-input', style: { width: '90px' }, value: o.switchAt || '', placeholder: 'HH:MM', onchange: changed((el) => { const v = parseClock(el.value); if (!el.value.trim()) delete ovr(low).switchAt; else if (v) { ovr(low).switchAt = v; el.value = v; } else el.value = o.switchAt || ''; }) })),
        fld('cap after switch', h('input', { class: 'core-input', style: { width: '100px' }, value: o.capAfterSwitch != null ? fmtNum(o.capAfterSwitch) : '', onchange: changed((el) => { if (!el.value.trim()) delete ovr(low).capAfterSwitch; else { const n = parseCap(el.value); if (n != null) ovr(low).capAfterSwitch = n; } }) })),
        def.kind === 'wave' ? fld('gate / wave', h('span', {}, h('input', { class: 'core-input', style: { width: '56px' }, value: loc ? loc.gate : '', onchange: changed((el) => { const n = parseInt(el.value, 10); if (n > 0) ovr(low).gate = n; }) }), ' ', h('input', { class: 'core-input', style: { width: '56px' }, value: loc ? loc.wave : '', onchange: changed((el) => { const n = parseInt(el.value, 10); if (n > 0) ovr(low).wave = n; }) }))) : null));
    return h('div', { class: 'ma-row' + (on ? ' on' : '') },
      h('input', { type: 'checkbox', class: 'ma-tick', title: on ? 'Farming this boss' : 'Tick to farm this boss', checked: on ? true : null, onchange: (e) => toggle(low, e.target.checked) }),
      h('div', { class: 'ma-row-main' },
        h('div', { class: 'ma-row-name' }, bossName(low), ' ', pill(def.kind === 'wave' ? `wave ${loc ? loc.gate + '/' + loc.wave : '?'}` : swarm ? 'dungeon · swarm' : 'dungeon', '')),
        phaseOf ? h('div', { class: 'ma-row-meta' }, phaseOf) : null),
      h('div', { class: 'ma-row-actions' },
        fld('cap', h('input', { class: 'core-input', style: { width: '90px' }, value: fmtNum(bossCap(low)), title: 'damage cap for this boss (5B, 750M, 2,000,000,000 …); 0 = skip', onchange: changed((el) => { const n = parseCap(el.value); if (n != null) { ovr(low).cap = n; el.value = fmtNum(n); } else el.value = fmtNum(bossCap(low)); }) }), true),
        on ? h('span', { class: 'ma-row-actions' }, btn('↑', 'soft', () => move(low, -1)), btn('↓', 'soft', () => move(low, 1)), h('span', { class: 'core-dim' }, '#' + (cfg.targets.indexOf(low) + 1))) : null),
      opts);
  }
  function tBosses() {
    const on = cfg.targets.map((l) => Roster.get(l)).filter(Boolean), off = Roster.list.filter((d) => !cfg.targets.includes(d.low) && (d.kind === 'wave' || Kernel.isOn('dungeons')));
    return [h('div', { class: 'ma-note' }, 'The first alive boss that is still under its cap is attacked, in the order below (↑ ↓). Phases of one boss are ticked together.'),
      h('div', {}, [...on, ...off].map(bossRow))];
  }

  /* ---- POTIONS ---- */
  function tPotions() {
    const m = cfg.mana, A = cfg.stam.A, B = cfg.stam.B, S = cfg.stam.save, H = cfg.hp;
    return [
      box(sec('Mana'),
        h('div', { class: 'ma-fields' }, check('Refill mana automatically', () => m.enabled, (v) => { m.enabled = v; }), check('When max MP is 0 fill the bar', () => m.fullMaxAt0, (v) => { m.fullMaxAt0 = v; })),
        h('div', { class: 'ma-fields' }, fld('potion size', sel([['S', 'S (20 MP)'], ['M', 'M (40 MP)'], ['L', 'L (60 MP)'], ['XL', 'XL (100 MP)']], m.type, (v) => { m.type = v; }, 130)), textIn(m, 'name', 180, 'exact item name (optional)', 'auto'), intIn(m, 'threshold', 70, 'refill at MP ≤'), intIn(m, 'fillTo', 70, 'fill up to MP'))),
      box(sec('Stamina'), h('div', { class: 'ma-note' }, 'Uses Core.potions: sidebar first, then the remembered id, then your inventory.'),
        h('div', { class: 'ma-fields' }, check('Potion A', () => A.enabled, (v) => { A.enabled = v; }), textIn(A, 'item', 200, 'item name')),
        h('div', { class: 'ma-fields' }, check('Potion B (next)', () => B.enabled, (v) => { B.enabled = v; }), textIn(B, 'item', 200, 'item name')),
        h('div', { class: 'ma-fields' }, check('Save stamina near the EXP cap', () => S.enabled, (v) => { S.enabled = v; }), pctIn(S, 'thresholdPct', 80, 'pause at EXP %'))),
      box(sec('HP'), h('div', { class: 'ma-fields' }, check('Drink an HP potion when low', () => H.enabled, (v) => { H.enabled = v; }), pctIn(H, 'thresholdPct', 80, 'at HP ≤ %')))];
  }

  /* ---- GRAVEYARD ---- */
  function tGraveyard() {
    const L = cfg.autoLoot, s = Loot.state, groups = new Map();
    s.rows.filter((r) => r.needsLoot !== false).forEach((r) => { const g = groups.get(r.nameLow) || { name: r.name, rows: [], boss: r.isBoss }; g.rows.push(r); groups.set(r.nameLow, g); });
    const need = (() => { const m = Core.me.get(), e = m && m.exp; return e && e.max > 0 ? Math.max(0, e.max - e.cur) : null; })();
    const lootable = [...groups.values()].reduce((n, g) => n + g.rows.length, 0);
    return [
      box(sec('Auto-loot'), h('div', { class: 'ma-fields' }, check('Auto-loot when out of stamina', () => L.enabled, (v) => { L.enabled = v; })),
        h('div', { class: 'ma-fields' }, fld('mode', sel([['toLevel', 'only what reaches the next level'], ['all', 'everything']], L.mode, (v) => { L.mode = v; }, 250)), intIn(L, 'scanMs', 90, 'scan every (ms)'), intIn(L, 'claimGapMs', 90, 'gap between claims (ms)'))),
      h('div', { class: 'ma-note' }, `${lootable} lootable · last scan ${ago(s.lastScanAt)}${need != null ? ' · EXP to next level ' + fmtNum(need) : ''}`),
      groups.size ? h('div', {}, [...groups.entries()].map(([low, g]) => h('div', { class: 'ma-row' },
        h('div', { class: 'ma-row-main' }, h('div', { class: 'ma-row-name' }, g.name + (g.boss ? ' 👑' : '')),
          h('div', { class: 'ma-row-meta' }, `${g.rows.length} corpse${g.rows.length === 1 ? '' : 's'} · known damage ${fmtNum(g.rows.reduce((n, r) => n + (Number.isFinite(r.userDamage) ? r.userDamage : 0), 0))}`)),
        h('div', { class: 'ma-row-actions' }, btn(s.claiming.has(low) ? 'Claiming…' : 'Claim all', 'soft', () => { Loot.claimGroup(low); }))))) : h('div', { class: 'core-empty' }, s.lastScanAt ? 'Nothing lootable right now.' : 'Press Scan graveyard to look.'),
      foot(btn(s.scanning ? 'Scanning…' : '🔎 Scan graveyard', 'soft', () => { Loot.scan(); }), h('div', { class: 'core-spacer' }), btn(s.looting ? 'Looting…' : '🎒 Loot now (per mode)', 'success', () => { Loot.pass(); }))];
  }

  /* ---- LOG ---- */
  function tLog() {
    const f = cfg.logFilter || 'all', rows = Log.all().filter((r) => f === 'all' || r.k === f).slice(-160).reverse();
    return [h('div', { class: 'core-row' }, sel([['all', 'all'], ['ok', 'ok'], ['warn', 'warnings'], ['err', 'errors'], ['dmg', 'hits'], ['skill', 'skills'], ['info', 'info']], f, (v) => { cfg.logFilter = v; draw(); }, 140), h('div', { class: 'core-spacer' }), btn('Clear log', 'soft', () => Log.clear())),
      rows.length ? h('div', { class: 'ma-log' }, rows.map((r) => h('div', { class: 'ma-line ' + r.k }, h('b', {}, r.t + ' '), r.m.replace(/<[^>]+>/g, '')))) : h('div', { class: 'core-empty' }, 'Nothing logged yet.')];
  }

  /* ---- DIAGNOSTICS ---- */
  function tDiag() {
    const l = Diag.last(), counts = Object.entries(Diag.counts).sort((a, b) => b[1] - a[1]), au = Guard.info();
    return [h('div', { class: 'ma-grid' }, card('Why isn’t it attacking?', l.reason ? `${l.reason}${l.detail ? ' — ' + l.detail : ''}` : 'nothing skipped'), card('Last skip', ago(l.at)),
      card('Preset capabilities', Presets.note()),
      card('Re-login', au.status ? (au.status.configured ? 'configured' : 'unconfigured') : 'Core.auth missing'), card('Shielded mobs known', SideMob.shielded()), card('Version', VERSION)),
      box(sec('Skip reasons (count)'), counts.length ? h('div', {}, counts.map(([k, n]) => h('div', { class: 'ma-kv' }, h('span', {}, k), h('span', {}, n)))) : h('div', { class: 'core-dim' }, 'none')),
      box(sec('Recent events'), Diag.events.length ? h('div', {}, Diag.events.slice(-40).reverse().map((e) => h('div', { class: 'ma-line' }, h('b', {}, e.t + ' '), e.reason + (e.detail ? ' — ' + e.detail : '')))) : h('div', { class: 'core-dim' }, 'none')),
      foot(btn('Clear diagnostics', 'soft', () => Diag.clear()), btn('Forget shielded mobs', 'soft', () => { SideMob.forget(); draw(); }))];
  }

  /* ---- SETTINGS ---- */
  function tSettings() {
    const tiers = TIER_CHAIN.slice(0, 4).map((t) => [t, SKILLS[t].label + ' (' + SKILLS[t].cost + ' stam)']);
    return [
      box(sec('Attacks'),
        h('div', { class: 'ma-fields' }, fld('highest skill tier', sel(tiers, cfg.maxTier, (v) => { cfg.maxTier = v; }, 230)), fld('class skill', sel([['auto', 'auto' + (cfg.detectedClass ? ' (' + cfg.detectedClass + ')' : '')], ['warrior', 'warrior'], ['cleric', 'cleric'], ['hunter', 'hunter'], ['mage', 'mage']], cfg.classOverride, (v) => { cfg.classOverride = v; }, 170))),
        h('div', { class: 'ma-fields' }, check('Use the class skill', () => cfg.useClassSkill, (v) => { cfg.useClassSkill = v; }))),
      box(sec('Timing'),
        h('div', { class: 'ma-fields' }, intIn(cfg, 'attackDelayMs', 90, 'wave swing gap (ms)'), intIn(cfg, 'dungeonAttackDelayMs', 90, 'dungeon swing gap (ms)'), intIn(cfg, 'minActionGapMs', 90, 'min gap between requests (ms)'), intIn(cfg, 'skillToAttackGapMs', 90, 'skill → attack gap (ms)')),
        h('div', { class: 'ma-fields' }, intIn(cfg, 'defaultBossCap', 100, 'default boss cap'), intIn(cfg, 'fightScanMs', 90, 'rescan while fighting (ms)'), intIn(cfg, 'idleRecheckMs', 90, 'recheck idle boss (ms)'), intIn(cfg, 'dungeonPollMs', 90, 'dungeon poll (ms)'))),
      box(sec('Behaviour'),
        h('div', { class: 'ma-fields' }, check('Pause the server auto-farm while fighting', () => cfg.autoFarmControl, (v) => { cfg.autoFarmControl = v; }), check('Fight Phase Duels automatically', () => cfg.autoDuel, (v) => { cfg.autoDuel = v; }),
          check('Shield pierce on a side mob (only if a boss is shielded)', () => cfg.sideMob.enabled, (v) => { cfg.sideMob.enabled = v; draw(); }))),
      box(sec('Parts'), h('div', { class: 'ma-note' }, 'Switch one off and the rest keep working.'),
        h('div', { class: 'ma-fields' }, [...Kernel.parts.values()].map((p) => check(`${p.icon || ''} ${p.name || p.id}`, () => Kernel.isOn(p.id), (v) => { cfg.parts[p.id] = v; Engine.poke(true); }))))];
  }

  const BUILD = { status: tStatus, bosses: tBosses, potions: tPotions, graveyard: tGraveyard, log: tLog, diag: tDiag, settings: tSettings };
  function scroller(el) { for (let n = el && el.parentElement; n; n = n.parentElement) { const o = getComputedStyle(n).overflowY; if ((o === 'auto' || o === 'scroll') && n.scrollHeight > n.clientHeight) return n; } return null; }
  function draw() {
    if (!root || !open || !root.isConnected) return;
    const sc = scroller(root), top = sc ? sc.scrollTop : 0;
    let body; try { body = BUILD[tab]() } catch (e) { body = [h('div', { class: 'core-err' }, 'panel error: ' + e.message)]; console.warn('[automator] panel', e); }
    root.replaceChildren(header(), tabsBar(), ...[].concat(body));
    if (sc) sc.scrollTop = top;
  }
  const typing = () => root && root.contains(document.activeElement) && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
  function schedule(ms) { if (drawT) return; drawT = setTimeout(() => { drawT = 0; if (typing()) schedule(1500); else draw(); }, ms || 400); }
  if (typeof Core.on === 'function') Core.on('caps:changed', (d) => { if (open && d && (d.added || []).some((n) => n.startsWith('preset.'))) schedule(300); });   // a preset addon loaded late
  UI.hook((what) => { if (!open) return; if (what === undefined || DIRTY_TAB[what] === tab || (what === 'status' && tab === 'status')) schedule(); });

  function register() {
    Core.float.add({ id: ID, title: 'Automator', icon: '🤖', order: 40,
      render(el) { root = h('div', {}); el.replaceChildren(root); open = true; draw(); },
      onShow() { open = true; }, onHide() { open = false; } });
  }
  return { register, draw };
})();

/* ===================================================================================================================
 * PART 6 — BOOT
 * ================================================================================================================ */
Kernel.register({ id: 'bosses', name: 'Wave bosses', icon: '🌊' });
Panel.register();
Duels.bootPage().catch((e) => log('❌ duel page: ' + e.message, 'err'));
Tab.join().catch((e) => log('❌ tab leadership: ' + e.message, 'err'));

return {
  version: VERSION, cfg: () => cfg, board: Board.all, status: Status.get,
  start: Run.start, stop: Run.stop, scanNow: Engine.scanNow, register: Kernel.register,
};

  },
});
