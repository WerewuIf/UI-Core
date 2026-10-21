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
 *   PART 4b LOOT SCAN  read-only loot / level / EXP-cap scan, cap tier buttons and plain-text export
 *   PART 5  [slots]    quests / adventurers guild / PvP / dailies: Kernel.register({ id, name, icon, every, tick, panel })
 *   PART 5  PANEL      compact rounded panel; Bosses split into Waves | Dungeons with grouped wave cards
 *
 * Why this exists (3.0.0 bugs fixed here, see the notes): a login/maintenance page used to parse as "no bosses";
 * boss timers were never reloaded after a tab took over; nothing scanned while a boss was being fought; error
 * replies were retried instantly instead of honouring their delay.
 */
Core.module({
  id: 'automator', name: 'Automator', icon: '🤖', version: '1.5.0',
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
const ID = 'automator', VERSION = '1.5.0';
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
  // Upgrade the previous single timed-cap switch to the multi-entry schedule without losing user settings.
  Object.keys(out.bosses).forEach((low) => {
    const o = out.bosses[low];
    if (o && !Array.isArray(o.schedule) && o.switchAt && o.capAfterSwitch != null) {
      const at = parseClock(o.switchAt);
      if (at) o.schedule = [{ at, cap: Number(o.capAfterSwitch) || 0 }];
      delete o.switchAt; delete o.capAfterSwitch;
    }
  });
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
function clockMinutes(value) { const s = parseClock(value); if (!s) return 0; const p = s.split(':').map(Number); return p[0] * 60 + p[1]; }
function bossCap(low) {
  const def = Roster.get(low), o = cfg.bosses[low] || {};
  const base = baseCap(low);
  // Timed cap changes are for dungeon bosses only; they repeat each server day.
  if (def && def.kind !== 'wave' && Array.isArray(o.schedule) && o.schedule.length) {
    const now = serverMinutes();
    if (now != null) {
      const entries = o.schedule.filter((x) => x && parseClock(x.at) && Number.isFinite(Number(x.cap))).slice().sort((a, b) => clockMinutes(a.at) - clockMinutes(b.at));
      let active = null;
      entries.forEach((x) => { if (clockMinutes(x.at) <= now) active = x; });
      if (active) return Number(active.cap);
    }
  }
  // Backward-compatible fallback for a config that has not yet been migrated.
  if (def && def.kind !== 'wave' && o.switchAt && o.capAfterSwitch != null) {
    const mins = serverMinutes(), at = parseClock(o.switchAt);
    if (mins != null && at && mins >= clockMinutes(at)) return Number(o.capAfterSwitch);
  }
  return base;
}
function bossLoc(low) {
  const def = Roster.get(low), o = cfg.bosses[low] || {};
  const gate = o.gate != null ? o.gate : def && def.gate, wave = o.wave != null ? o.wave : def && def.wave;
  return gate && wave ? { gate, wave } : null;
}


/* ---- map wave coordinates to their world area. Grouping is based on Gate/Wave, never on a monster's name. ---- */
const WaveMap = (() => {
  const GROUPS = {
    generals: { id: 'generals', title: 'Generals', sub: 'Gate 3', ico: '⚔️', order: 1 },
    ocean: { id: 'ocean', title: 'Ocean', sub: 'Gate 5', ico: '🌊', order: 2 },
    olympus: { id: 'olympus', title: 'Olympus', sub: 'Gate 5', ico: '🏛️', order: 3 },
    other: { id: 'other', title: 'More waves', sub: 'other locations', ico: '🗺️', order: 4 },
  };
  const WAVES = {
    '3/8': ['generals', 'Generals'],
    '5/9': ['ocean', 'Oceanus'],
    '5/10': ['olympus', 'Hermes'], '5/11': ['olympus', 'Artemis'],
    '5/12': ['olympus', 'Poseidon'], '5/13': ['olympus', 'Ares'],
    '5/14': ['olympus', 'Apollo'], '5/15': ['olympus', 'Athena'],
    '5/16': ['olympus', 'Hera'], '5/17': ['olympus', 'Zeus'],
  };
  function of(gate, wave) {
    const key = `${gate || ''}/${wave || ''}`, hit = WAVES[key];
    if (hit) return { key, group: GROUPS[hit[0]], label: hit[1] };
    return { key, group: GROUPS.other, label: gate && wave ? `Gate ${gate} · Wave ${wave}` : 'Unmapped wave' };
  }
  return { of, groups: GROUPS };
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
const LootScan = { available: false, state: { running: false, stop: false, label: '', done: 0, total: 0, read: 0, added: 0, notes: [], error: '', startedAt: 0, endedAt: 0 }, run: async () => {}, stop() {}, download() {}, text: () => '' }; // PART 4b fills this

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


/* ---- scanned loot data. Loot requirements become choices in each boss's cap editor. ---------------------------- */
const lootStore = Core.store('automator-loot', { def: { v: 1, at: 0, bosses: {} } });
const LootData = (() => {
  const store = lootStore;
  let data = store.get() || { v: 1, at: 0, bosses: {} };
  const all = () => data && data.bosses && typeof data.bosses === 'object' ? data.bosses : {};
  const at = () => Number(data && data.at) || 0;
  const get = (low) => {
    const key = String(low || '').toLowerCase();
    if (all()[key]) return all()[key];
    return Object.values(all()).find((e) => String(e && e.name || '').toLowerCase() === key) || null;
  };
  function tiers(low) {
    const e = get(low), grouped = new Map();
    (e && Array.isArray(e.loot) ? e.loot : []).forEach((item) => {
      const req = Number(item && item.dmgReq);
      if (!(req > 0) || !Number.isFinite(req)) return;
      if (!grouped.has(req)) grouped.set(req, []);
      if (item.name && !grouped.get(req).includes(item.name)) grouped.get(req).push(item.name);
    });
    return [...grouped.entries()].sort((a, b) => a[0] - b[0]).map(([req, items]) => ({ req, items }));
  }
  function updateRoster() {
    Object.values(all()).forEach((e) => {
      if (!e || !e.name) return;
      // For waves, every card is a wave boss. In dungeons, add only locations the map marks as boss locations.
      if (e.kind !== 'wave' && !e.boss) return;
      const low = String(e.name).toLowerCase();
      if (Roster.get(low)) return;
      const maxReq = (Array.isArray(e.loot) ? e.loot : []).reduce((n, l) => Math.max(n, Number(l && l.dmgReq) || 0), 0);
      Roster.add({
        name: e.name, kind: e.kind === 'wave' ? 'wave' : 'dungeon',
        defaultCap: maxReq || Number(e.expCapDmg) || cfg.defaultBossCap,
        gate: e.gate, wave: e.wave, dtype: e.dtype, locationId: e.locationId,
      });
    });
  }
  store.watch((v) => {
    if (v && typeof v === 'object') {
      data = v; updateRoster(); UI.dirty('loot'); UI.dirty('scan');
    }
  });
  updateRoster();
  return { all, get, tiers, at };
})();

function baseCap(low) {
  const def = Roster.get(low), o = cfg.bosses[low] || {};
  if (o.cap != null && Number.isFinite(Number(o.cap))) return Number(o.cap);
  // This roster entry is deliberately skipped by default (cap 0), even if the scanner finds loot on its page.
  if (def && Number(def.defaultCap) === 0) return 0;
  const choices = LootData.tiers(low);
  if (choices.length) return choices[choices.length - 1].req;
  return def && def.defaultCap != null ? Number(def.defaultCap) : Number(cfg.defaultBossCap) || 0;
}

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
          loot.push({ tier, name: clean((card.querySelector('.loot-name') || {}).textContent), dropPct: numIn(chips.find((t) => /drop:/i.test(t))), dmgReq: numIn(chips.find((t) => /dmg req:/i.test(t))) });
        });
      });
    }
    return { levelReq: val(stat('level req')), expCapPct: val(expBlock), expCapDmg: m ? numIn(m[1]) : null, expPerDmg: val(stat('exp / dmg')), hp: val(stat('monster hp')), loot };
  }
  const hasData = (b) => !!(b.loot.length || b.levelReq || b.hp);
  const readBattle = async (url, where) => parseBattle(await page(url, where));
  function keep(name, extra, b) {
    const low = clean(name).toLowerCase(), old = LootData.get(low);
    // a page that shows no loot panel this time must not wipe loot we already know
    const rec = Object.assign({ name: clean(name), scannedAt: Date.now() }, extra, b);
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
  async function scanWave(gate, wave) {
    const doc = await page(`/active_wave.php?gate=${gate}&wave=${wave}`, `Gate ${gate} · Wave ${wave}`, 'all');
    const names = new Map();
    doc.querySelectorAll('.monster-card').forEach((c) => {
      const name = clean(c.dataset.name || (c.querySelector('.monster-name,.name,h2,h3') || {}).textContent);
      const id = Scan.cardId(c); if (!name || !id) return;
      const e = names.get(name.toLowerCase()) || { name, ids: [] }; e.ids.push({ id, dead: c.dataset.dead === '1' }); names.set(name.toLowerCase(), e);
    });
    for (const e of names.values()) {
      let got = false;
      for (const { id } of e.ids.sort((a, b) => a.dead - b.dead)) {         // alive first; a dead one is fine too, it still shows its loot
        let b; try { b = await readBattle(`/battle.php?id=${encodeURIComponent(id)}`, e.name); } catch (err) { if (err instanceof Halt) throw err; note(`${e.name}: ${err.message}`); continue; }
        if (!hasData(b)) continue;
        keep(e.name, { kind: 'wave', gate, wave }, b); got = true; break;
      }
      if (!got) note(`${e.name} (Gate ${gate} · Wave ${wave}): its battle page showed no loot or stats`);
    }
    // roster bosses of this wave that were not on the page at all (not spawned, so there is nothing to open)
    Roster.list.forEach((d) => {
      const l = d.kind === 'wave' && bossLoc(d.low); if (!l || l.gate !== gate || l.wave !== wave) return;
      if (names.has(d.low) || found[d.low]) return;
      if (Roster.members(d).some((m) => names.has(m.low) || found[m.low])) return;
      if (!LootData.get(d.low)) note(`${d.name}: not on the Gate ${gate} · Wave ${wave} page (not spawned yet?), so no loot data`);
    });
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
        const seen = new Set();
        for (const card of doc.querySelectorAll('.mon')) {
          const name = Dungeons.monName(card), dgmid = Dungeons.dgmidOf(card), low = clean(name).toLowerCase();
          if (!name || !dgmid || seen.has(low) || read >= 60) continue; seen.add(low);
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
    const prev = (() => { const o = lootStore.get(); return o && o.bosses && typeof o.bosses === 'object' ? o.bosses : {}; })();
    st.added = rows.filter((k) => !Roster.get(k) && !prev[k]).length;
    lootStore.set({ v: 1, at: Date.now(), bosses: Object.assign({}, prev, found) });
    return rows.length;
  }
  async function run() {
    if (st.running) return;
    Object.assign(st, { running: true, stop: false, label: 'Starting…', done: 0, total: 0, read: 0, added: 0, notes: [], error: '', startedAt: Date.now(), endedAt: 0 });
    found = {}; UI.dirty('scan'); log('🔎 loot scan started (read-only)', 'info');
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
      let n = 0; try { n = save(); } catch (e) { st.error = 'could not save: ' + e.message; }
      st.running = false; st.endedAt = Date.now(); st.label = '';
      if (!n) { if (!st.error) st.error = 'nothing was read. Are you signed in?'; }
      log(`${st.error ? '⚠️' : '✅'} loot scan ${st.stop ? 'stopped' : 'finished'}: ${n} monster${n === 1 ? '' : 's'} read${st.added ? ', ' + st.added + ' new' : ''}${st.notes.length ? ', ' + st.notes.length + ' note' + (st.notes.length === 1 ? '' : 's') : ''}${st.error ? ' — ' + st.error : ''}`, st.error ? 'warn' : 'ok');
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
    const rows = Object.values(LootData.all()).filter((e) => e && e.name).map((e) => ({ e, w: whereOf(e) }))
      .sort((a, b) => a.w.sort - b.w.sort || (Roster.list.findIndex((d) => d.low === a.e.name.toLowerCase()) - Roster.list.findIndex((d) => d.low === b.e.name.toLowerCase())) || a.e.name.localeCompare(b.e.name));
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
  return { available: true, run, stop, download, text };
})());

/* ===================================================================================================================
 * PART 5 — PANEL (compact rounded UI; boss bubbles, grouped Waves | Dungeons, scan-driven cap picks)
 * Uses Core controls plus the smaller rounded bubble skin in ma-* classes.
 * Forms are never redrawn while you are typing in them.
 * ================================================================================================================ */
const Panel = (() => {
  const { h, btn } = Core.ui;
  const TABS = [['status', 'Status'], ['bosses', 'Bosses'], ['potions', 'Potions'], ['graveyard', 'Graveyard'], ['log', 'Log'], ['diag', 'Diagnostics'], ['settings', 'Settings']];
  const DIRTY_TAB = { status: 'status', log: 'log', diag: 'diag', loot: 'bosses' };
  const uiStore = Core.store(ID + '-ui', { def: { tab: 'status', open: {}, filter: '', bsec: 'waves' } });
  const ui = Object.assign({ tab: 'status', open: {}, filter: '', bsec: 'waves' }, uiStore.get() || {});
  const saveUi = () => { ui.tab = tab; uiStore.set(ui); };
  const phaseSel = {};
  let root = null, tab = ui.tab || 'status', open = false, drawT = 0;

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
.ma-field{margin:6px 0}.ma-fld-h{display:flex;align-items:baseline;gap:8px;color:#c4cdeb;font:700 11.5px Arial,sans-serif;margin-bottom:4px}.ma-fld-h small{font-weight:400;color:#7c88ad;font-size:10.5px}.ma-note{color:#8b97bd;font-size:10.5px;line-height:1.4;margin:4px 2px}.ma-time-input{width:104px}
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
.ma-seg-btn:hover{border-color:#3b4a73}.ma-seg-btn.on{background:rgba(75,115,224,.2);border-color:#6ea8ff;color:#d6e5ff}
.ma-chips{display:flex;gap:4px;flex-wrap:wrap}
.ma-chip{background:#0d1322;border:1px solid #27324f;color:#9caad0;font:700 11px Arial,sans-serif;padding:3px 10px;border-radius:999px;cursor:pointer;transition:.15s}
.ma-chip:hover{border-color:#3b4a73;color:#cfd8f7}.ma-chip.on{background:rgba(75,115,224,.2);border-color:#6ea8ff;color:#d6e5ff}
.ma-chip i{font-style:normal;margin-left:5px;opacity:.7}
/* inputs */
.ma-in{box-sizing:border-box;width:92px;background:#0d1322;border:1px solid rgba(255,255,255,.12);color:#eef3ff;border-radius:10px;padding:5px 9px;font:12.5px Arial,sans-serif;transition:.15s}
.ma-in:focus{outline:none;border-color:#6ea8ff;box-shadow:0 0 0 2px rgba(110,168,255,.18)}
select.ma-in{width:auto;max-width:100%;cursor:pointer;padding-right:4px}
.ma-num{display:inline-flex;align-items:center;gap:5px}.ma-num i{font-style:normal;color:#6e7a9c;font-size:11px}
.ma-in.flash{animation:ma-flash .9s ease-out}
@keyframes ma-flash{0%{background:rgba(110,168,255,.55);border-color:#6ea8ff}100%{background:#0d1322}}
.ma-search{box-sizing:border-box;flex:1;min-width:0;background:#0d1322;border:1px solid rgba(255,255,255,.12);color:#eef3ff;border-radius:12px;padding:6px 11px;font:12.5px Arial,sans-serif}
.ma-search:focus{outline:none;border-color:#6ea8ff}
/* label + control rows */
.ma-set{display:flex;align-items:center;gap:10px;padding:5px 0}
.ma-set+.ma-set{border-top:1px solid rgba(255,255,255,.05)}
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
.ma-scan-t{flex:1;min-width:0}.ma-scan-t b{display:block;font:800 12px Arial,sans-serif;color:#fff}.ma-scan-t small{display:block;color:#9aa7cf;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
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
.ma-bb-n small .capv{color:#aeb9dc;font-weight:700}
/* the editor of an open boss */
.ma-ed{grid-column:1/-1;margin:1px 0 3px;padding:9px 11px 10px;background:#0b1120;border:1px solid rgba(110,168,255,.28);border-radius:16px}
.ma-ed-h{display:flex;align-items:center;gap:8px;margin-bottom:6px}.ma-ed-h b{flex:1;min-width:0;font:800 12px Arial,sans-serif;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ma-ed-sub{color:#7c88ad;font-size:11px;margin:-2px 2px 5px}
.ma-capline{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.ma-capline .ma-capinfo{color:#7c88ad;font-size:11px}
.ma-tiers{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px;margin-top:6px}
.ma-tier{display:flex;align-items:center;gap:8px;min-width:0;text-align:left;background:#0d1322;border:1px solid #27324f;color:#aeb9dc;border-radius:12px;padding:5px 10px;cursor:pointer;transition:.15s}
.ma-tier b{flex:0 0 auto;min-width:34px;font:800 12px Arial,sans-serif;color:#e8edff}
.ma-tier span{flex:1;min-width:0;font-size:10.5px;color:#7c88ad;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ma-tier:hover{border-color:#4b5f94;background:#111a30}
.ma-tier.on{background:rgba(75,115,224,.2);border-color:#6ea8ff}.ma-tier.on b{color:#fff}.ma-tier.on span{color:#b9c9f0}
.ma-tier.exp b{color:#c9a8ff}
.ma-ld{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:6px;margin-top:2px}
.ma-ld label{display:block;font:800 9.5px Arial,sans-serif;color:#6e7a9c;text-transform:uppercase;letter-spacing:.06em;margin:0 3px 2px}
.ma-ld select{width:100%}
.ma-sched{margin-top:8px;padding:7px 10px;background:#0a0f1c;border:1px solid rgba(255,255,255,.06);border-radius:14px}
.ma-sub-h{display:flex;align-items:center;gap:8px;color:#c4cdeb;font:700 11.5px Arial,sans-serif;margin-bottom:4px}.ma-sub-h .sp{flex:1}.ma-sub-h small{font-weight:400;color:#6e7a9c}
.ma-srow{display:flex;align-items:center;gap:7px;margin:4px 0}.ma-srow .arrow{color:#53608a}
.ma-time{display:inline-flex;align-items:stretch;height:28px;border:1px solid rgba(255,255,255,.12);border-radius:10px;overflow:hidden;background:#0d1322;flex:0 0 auto}
.ma-time input{border:none;background:transparent;color:#eef3ff;font:12.5px Arial,sans-serif;font-variant-numeric:tabular-nums;width:22px;padding:0 2px;text-align:center}
.ma-time input:focus{outline:none;background:rgba(75,115,224,.2)}.ma-time span{display:flex;align-items:center;color:#6e7a9c}
.ma-ampm{border:none;border-left:1px solid rgba(255,255,255,.12);background:transparent;color:#9fb0e0;font:800 10px Arial,sans-serif;padding:0 8px;cursor:pointer;letter-spacing:.03em}.ma-ampm:hover{background:#18213b;color:#fff}
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
.ma-vitals{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:6px;margin-bottom:7px}
.ma-meter{background:#11192d;border:1px solid rgba(255,255,255,.06);border-radius:14px;padding:6px 10px}
.ma-meter-top{display:flex;justify-content:space-between;gap:6px;font-size:10px;color:#8b97bd;margin-bottom:4px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}.ma-meter-top b{color:#fff;font-size:11px;text-transform:none;letter-spacing:0}
.ma-meter .ma-bar{height:5px}
.ma-meter.hp i{background:linear-gradient(90deg,#b4465c,#ff6b7a)}.ma-meter.st i{background:linear-gradient(90deg,#b08a1d,#e3b341)}.ma-meter.mp i{background:linear-gradient(90deg,#3657a7,#6ea8ff)}.ma-meter.xp i{background:linear-gradient(90deg,#7a4fc4,#a371f7)}
.ma-q{display:flex;align-items:center;gap:9px;padding:5px 6px;border-radius:14px;cursor:pointer}.ma-q:hover{background:rgba(255,255,255,.035)}
.ma-q-n{flex:1;min-width:0}.ma-q-n b{display:block;font:700 12px Arial,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ma-q-n .ma-bar{height:4px;margin-top:3px}
.ma-q small{color:#7c88ad;font-size:10.5px;margin-top:2px;display:block}
.ma-stats{display:flex;gap:5px;flex-wrap:wrap;margin:2px 0 6px}
.ma-stat{background:#0d1322;border:1px solid rgba(255,255,255,.06);border-radius:999px;padding:4px 10px;font-size:11px;color:#9aa7cf}.ma-stat b{color:#fff;margin-left:4px}
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
.ma-foot .core-btn{padding:8px 18px;font-size:12.5px;border-radius:12px}
.ma-foot .core-btn-success{box-shadow:0 8px 18px rgba(33,127,91,.3)}.ma-foot .core-btn-danger{box-shadow:0 8px 18px rgba(180,70,92,.3)}
.ma-kv{display:flex;justify-content:space-between;gap:10px;padding:3px 2px;font-size:11.5px;color:#aeb9dc}.ma-kv b{color:#fff}
@media (max-width:560px){.ma-two,.ma-tiers,.ma-grid{grid-template-columns:1fr}.ma-tab{padding:7px 7px}.ma-wv{grid-template-columns:1fr}.ma-wv-l{flex-direction:row;align-items:baseline;gap:8px;padding:2px 4px}}
`;
    document.head.appendChild(s);
  })();

  /* ---- tiny form helpers ---- */
  const ago = (t) => (t ? fmtDur(Date.now() - t) + ' ago' : 'never');
  const pill = (txt, kind) => h('span', { class: 'core-pill' + (kind ? ' core-pill-' + kind : '') }, txt);
  const card = (k, v) => h('div', { class: 'ma-card' }, h('div', { class: 'ma-k' }, k), h('div', { class: 'ma-v' }, v));
  const sec = (t) => h('div', { class: 'ma-sec' }, t);
  const fld = (label, el) => h('label', { class: 'ma-fld' }, h('span', { class: 'core-dim' }, label), el);
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
    return h('div', { class: 'ma-head' }, pill(st, kind), h('span', { class: 'core-dim' }, cur ? '🎯 ' + cur.name : (Tab.isMain() ? 'no target' : 'another tab is running it')),
      h('span', { style: { flex: '1 1 auto' } }),
      run ? btn('⏹ Stop', 'danger', () => { Run.stop('stopped from the panel'); draw(); }) : btn('▶ Start', 'success', () => { Run.start(); draw(); }));
  }
  function tabsBar() { return h('div', { class: 'ma-tabs' }, TABS.map(([id, label]) => h('button', { type: 'button', class: 'ma-tab' + (id === tab ? ' on' : ''), onclick: () => { tab = id; saveUi(); draw(); } }, label))); }

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
  function tStatus() {
    const m = Core.me.get() || {}, e = m.exp, cls = effectiveClass();
    const out = [h('div', { class: 'ma-grid' },
      card('Role', Tab.isMain() ? 'main tab (works)' : 'follower'), card('Stamina', Me.stamKnown() ? `${fmtNum(Me.stam())} / ${fmtNum(Me.maxStam())}` : '?'),
      card('HP', Me.hpKnown ? `${fmtNum(Me.hp)} / ${fmtNum(Me.maxHp)}` : '?'), card('MP', Me.mpKnown ? `${fmtNum(Me.mp)} / ${fmtNum(Me.maxMp)}` : '?'),
      card('Level · EXP', `${Me.level() || '?'} · ${Me.expPct() != null ? Me.expPct().toFixed(1) + '%' : '?'}`), card('Class', cls || 'unknown'),
      card('Hits · damage', `${stats.hits} · ${fmtNum(stats.dmg)}`), card('Potions used', `stam ${stats.stamA + stats.stamB} · hp ${stats.hpUses} · mana ${stats.mpRefills}`),
      card('Presets applied', Presets.summary()))];
    const conf = Conflicts.list(); if (conf.length) out.push(h('div', { class: 'core-err' }, '⛔ ' + conf.join(' · ')));
    const gi = Guard.info(); if (gi.faulted || gi.lastInfo) out.push(h('div', { class: 'core-err' }, '🔒 ' + (gi.lastInfo || gi.faulted) + (gi.lastInfo === 'unconfigured' ? ' — add a login source (Account Switcher) or sign in by hand' : '')));
    if (!Tab.isMain()) out.push(h('div', { class: 'core-row' }, h('span', { class: 'core-dim' }, 'Another tab is the main one and does the attacking.'), btn('Take over this tab', 'soft', () => { Tab.takeOver(); })));
    out.push(h('div', { class: 'core-row' }, btn('🔄 Refresh bosses', 'soft', () => Engine.scanNow()), btn('Clear skips', 'soft', () => { Engine.clearSkips(); Diag.clear(); draw(); })));
    if (!cfg.targets.length) out.push(h('div', { class: 'core-empty' }, 'No bosses selected — tick the ones to farm in the Bosses tab, then press Start.'));
    else out.push(h('table', { class: 'ma-table' }, h('thead', {}, h('tr', {}, ['#', 'Boss', 'State', 'Your damage', 'Cap'].map((t) => h('th', {}, t)))),
      h('tbody', {}, cfg.targets.map((low, i) => {
        const [txt, kind] = bossState(low), ev = Board.get(low) || {}, def = Roster.get(low);
        const dealt = def && def.kind === 'dungeon-swarm' ? '—' : fmtNum(ev.userDmg || 0);
        return h('tr', {}, h('td', {}, i + 1), h('td', {}, bossName(low)), h('td', {}, pill(txt, kind)), h('td', {}, dealt), h('td', {}, fmtNum(bossCap(low))));
      }))));
    return out;
  }

  /* ---- Bosses UI helpers: small controls shared by the bubble editor ------------------------------------------ */
  const ovr = (low) => cfg.bosses[low] || (cfg.bosses[low] = {});
  const toMin = (v) => { const s = parseClock(v); if (!s) return 0; const p = s.split(':').map(Number); return p[0] * 60 + p[1]; };
  const hhmm = (v) => { let m = Math.max(0, Math.floor(Number(v) || 0)) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
  const fmtClock = (v) => hhmm(v);
  const stop = (e) => { if (e && e.stopPropagation) e.stopPropagation(); };
  const short = (n) => fmtNum(Number(n) || 0).replace(/\.0([TBMK])$/, '$1');
  const note = (txt) => h('div', { class: 'ma-note' }, txt);
  const field = (label, sub, ...kids) => h('div', { class: 'ma-fld' },
    h('div', { class: 'ma-fld-h' }, h('b', {}, label), sub ? h('small', {}, sub) : null), ...kids);
  const chips = (items, current, set) => h('div', { class: 'ma-chips' }, items.map(([value, label]) => h('button', {
    type: 'button', class: 'ma-chip' + (Number(value) === Number(current) ? ' on' : ''),
    onclick: (e) => { stop(e); set(value); saveCfg(); Engine.poke(true); draw(); }
  }, label)));
  const dropdown = (items, current, set) => h('select', { class: 'ma-in dropdown', value: current == null ? '' : String(current),
    onchange: (e) => { set(e.target.value); saveCfg(); Presets.forget(); Engine.poke(true); draw(); }
  }, items.map(([v, label]) => h('option', { value: String(v), selected: String(v) === String(current == null ? '' : current) ? true : null }, label)));
  const num = (get, set, opt = {}) => h('span', { class: 'ma-num' }, h('input', {
    class: 'ma-in', style: { width: (opt.w || 100) + 'px' }, value: (opt.fmt || fmtNum)(Number(get()) || 0), inputMode: 'decimal',
    onchange: (e) => { const n = parseCap(e.target.value); if (n == null || n < 0) { e.target.value = (opt.fmt || fmtNum)(Number(get()) || 0); return; }
      set(n); e.target.value = (opt.fmt || fmtNum)(n); saveCfg(); Engine.poke(true); }
  }));
  const timePicker = (v, set) => h('input', { class: 'ma-in ma-time-input', type: 'time', value: parseClock(v) || '12:00',
    onchange: (e) => { const at = parseClock(e.target.value); if (at) set(at); }
  });
  const seg = (items, current, set, opt = {}) => h('div', { class: 'ma-seg' + (opt.full ? ' full' : '') }, items.map(([value, label, title]) => h('button', {
    type: 'button', class: 'ma-seg-btn' + (String(value) === String(current) ? ' on' : ''), title: title || '',
    onclick: (e) => { stop(e); set(value); draw(); }
  }, label)));
  const sw = (get, set, opt = {}) => h('label', { class: 'ma-sw' + (opt.sm ? ' sm' : ''), onclick: stop },
    h('input', { type: 'checkbox', checked: get() ? true : null, onchange: (e) => { set(e.target.checked); if (opt.redraw !== false) draw(); } }),
    h('span', { class: 'ma-sl' }));
  function setMany(defs, enabled) {
    const lows = new Set(); defs.forEach((d) => Roster.members(d).forEach((m) => lows.add(m.low)));
    if (enabled) { cfg.targets.forEach((x) => lows.delete(x)); cfg.targets.push(...lows); }
    else cfg.targets = cfg.targets.filter((low) => !lows.has(low));
    saveCfg(); Engine.poke(true); draw();
  }
  const isOn = (def) => Roster.members(def).some((m) => cfg.targets.includes(m.low));
  function entryState(def) {
    const [txt, kind] = bossState(def.low);
    if (/alive/.test(txt)) return [txt, 'ok'];
    if (/capped|cap 0|disabled/.test(txt)) return [txt, 'cap'];
    if (/not scanned|not up|no open|respawns|locked|sealed|Phase Duel/.test(txt)) return [txt, 'warn'];
    return [txt, kind === 'error' ? 'err' : 'blue'];
  }
  function nextChange(low) {
    const def = Roster.get(low), o = cfg.bosses[low] || {}, now = serverMinutes();
    if (!def || def.kind === 'wave' || now == null) return null;
    const list = Array.isArray(o.schedule) ? o.schedule : [];
    let best = null, gap = Infinity;
    list.forEach((x) => { const at = toMin(x.at); if (!Number.isFinite(Number(x.cap))) return; const d = (at - now + 1440) % 1440 || 1440; if (d < gap) { gap = d; best = { t: at, cap: Number(x.cap) }; } });
    if (!best && o.switchAt && o.capAfterSwitch != null) { const at = toMin(o.switchAt); if (at > now) best = { t: at, cap: Number(o.capAfterSwitch) }; }
    return best;
  }
  const rIdx = (low) => { const i = Roster.list.findIndex((d) => d.low === low); return i < 0 ? 1e9 : i; };
  const iconOfBoss = (low) => { const n = bossName(low).toLowerCase(); return /poseidon|ocean|water|triton|tide|sea/.test(n) ? '🌊' : /hermes|apollo|zeus|ares|athena|artemis|hera|olymp|pan\b/.test(n) ? '🏛️' : /general|skarn|vessir|hrazz|drakzareth/.test(n) ? '⚔️' : '👹'; };
  function avatar(name, icon, opt = {}) {
    const initials = String(name || '?').split(/[\s,]+/).filter(Boolean).slice(0, 2).map((x) => x[0]).join('').toUpperCase();
    return h('span', { class: 'ma-av-wrap' + (opt.size ? ' ' + opt.size : '') },
      h('span', { class: 'ma-av-fb', style: { background: 'linear-gradient(135deg,#2a3c68,#17213b)' }, title: name }, icon || initials || '👹'),
      opt.boss ? h('span', { class: 'ma-crown', title: 'Boss' }, '♛') : null,
      opt.dot ? h('i', { class: 'ma-dot s-' + opt.dot }) : null);
  }
  function fold(key, defaultOpen, title, body, opt = {}) {
    const expanded = opt.force || (ui.open[key] == null ? !!defaultOpen : !!ui.open[key]);
    const aside = opt.aside || [];
    return h('div', { class: 'ma-fold' + (expanded ? ' open' : '') },
      h('div', { class: 'ma-fold-h', onclick: () => { if (!opt.force) { ui.open[key] = !expanded; saveUi(); draw(); } } },
        h('span', { class: 'ma-fch' }, '▶'), h('div', { class: 'ma-fold-t' }, ...(Array.isArray(title) ? title : [title])),
        h('span', { class: 'ma-fold-aside', onclick: stop }, ...aside)),
      expanded ? h('div', { class: 'ma-fold-b' }, ...(typeof body === 'function' ? [].concat(body()) : [].concat(body))) : null);
  }

  /* ==================================================== BOSSES ==================================================== */
  /* ==================================================== BOSSES ==================================================== */
  function scheduleEditor(low) {
    const o = cfg.bosses[low] || {}, list = Array.isArray(o.schedule) ? o.schedule : [], now = serverMinutes();
    const sortSave = () => { ovr(low).schedule.sort((a, b) => toMin(a.at) - toMin(b.at)); saveCfg(); draw(); };
    const rows = list.map((b, i) => h('div', { class: 'ma-srow' },
      timePicker(b.at, (at) => { ovr(low).schedule[i].at = at; sortSave(); }), h('span', { class: 'arrow' }, '→'),
      num(() => b.cap, (n) => { ovr(low).schedule[i].cap = n; saveCfg(); }, { fmt: fmtNum, w: 96 }),
      h('span', { style: { flex: 1 } }), h('button', { type: 'button', class: 'ma-x', title: 'Remove', onclick: (e) => { stop(e); ovr(low).schedule.splice(i, 1); if (!ovr(low).schedule.length) delete ovr(low).schedule; saveCfg(); draw(); } }, '✕')));
    return h('div', { class: 'ma-sched' },
      h('div', { class: 'ma-sub-h' }, '⏰ Change the cap during the day', h('span', { class: 'sp' }), now != null ? h('small', {}, 'server time now ' + fmtClock(now)) : null),
      rows.length ? rows : h('div', { class: 'ma-note', style: { margin: '2px 0 6px' } }, 'The cap stays the same all day. Add a change to raise or lower it from a set server time (it starts over at midnight).'),
      h('button', { type: 'button', class: 'ma-add', onclick: (e) => { stop(e); const t = now != null ? hhmm((Math.floor(now / 60) + 1) * 60) : '12:00'; (ovr(low).schedule = ovr(low).schedule || []).push({ at: t, cap: bossCap(low) }); sortSave(); } }, '+ Add a cap change'));
  }
  function loadoutPick(kind, low) {
    const list = Presets.list(kind), cur = (cfg.bosses[low] || {})[kind] || '';
    return dropdown([['', '— keep current —'], ...list.map((p) => [p.id, p.name])], cur, (v) => { if (v) ovr(low)[kind] = v; else delete ovr(low)[kind]; });
  }
  const KIND_ICO = { gear: '⚔️', crystal: '💎', pet: '🐾' };
  const cap1 = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const itemsText = (items) => (items.length > 2 ? items.slice(0, 2).join(', ') + ' +' + (items.length - 2) : items.join(', '));
  const lvTxt = (n) => 'Lv ' + Number(n).toLocaleString('en-US');

  /* the cap field. Tapping a loot tier (or the EXP-cap damage) writes that number into the field and saves it. */
  let flashCap = '';
  function setCap(low, n) { ovr(low).cap = n; saveCfg(); flashCap = low; draw(); setTimeout(() => { flashCap = ''; }, 1000); }
  function capField(low) {
    const base = baseCap(low), tiers = LootData.tiers(low), info = LootData.get(low), mine = cfg.bosses[low] && cfg.bosses[low].cap != null;
    const input = num(() => baseCap(low), (n) => { ovr(low).cap = n; }, { fmt: fmtNum, w: 100 });
    if (flashCap === low) input.querySelector('input').classList.add('flash');
    const bits = info ? [info.levelReq ? lvTxt(info.levelReq) : '', info.expCapPct != null ? `EXP cap ${info.expCapPct}%` : '', info.scannedAt ? 'scanned ' + ago(info.scannedAt) : ''].filter(Boolean) : [];
    const kids = [h('div', { class: 'ma-capline' }, input,
      mine && tiers.length ? h('button', { type: 'button', class: 'ma-link', title: 'forget my number and use the highest loot requirement', onclick: (e) => { stop(e); delete ovr(low).cap; saveCfg(); draw(); } }, '↺ top tier') : null,
      bits.length ? h('span', { class: 'ma-capinfo' }, bits.join(' · ')) : null)];
    const opts = tiers.slice().reverse().map((t) => ({ req: t.req, label: itemsText(t.items), full: t.items.join(', '), exp: false }));
    if (info && info.expCapDmg > 0 && !tiers.some((t) => t.req === info.expCapDmg)) opts.push({ req: info.expCapDmg, label: 'EXP cap' + (info.expCapPct != null ? ' ' + info.expCapPct + '%' : ''), full: 'the damage that reaches the EXP cap', exp: true });
    if (opts.length) kids.push(h('div', { class: 'ma-tiers' }, opts.map((t) => h('button', { type: 'button', class: 'ma-tier' + (t.req === base ? ' on' : '') + (t.exp ? ' exp' : ''), title: `${fmtNum(t.req)} damage: ${t.full}. Click to use it as the cap.`, onclick: (e) => { stop(e); setCap(low, t.req); } },
      h('b', {}, short(t.req)), h('span', {}, t.label)))));
    else kids.push(h('div', { style: { marginTop: '6px' } }, chips([[1e8, '100M'], [5e8, '500M'], [1e9, '1B'], [2e9, '2B'], [3e9, '3B'], [5e9, '5B']], base, (v) => { ovr(low).cap = v; })));
    if (!info) kids.push(note(LootScan.available ? 'No loot data for this boss yet. Press Scan at the top to read it.' : 'No loot data for this boss yet.'));
    if (base <= 0) kids.push(note('Cap 0 means this boss is skipped.'));
    return field('Damage cap', opts.length ? 'tap a loot requirement to use it' : 'stop hitting once you have dealt this much', ...kids);
  }
  function bossEditor(def) {
    const ms = Roster.members(def), idx = Math.min(phaseSel[def.low] || 0, ms.length - 1), m = ms[idx], low = m.low, out = [];
    out.push(h('div', { class: 'ma-ed-h' }, h('b', { title: m.name }, m.name), h('button', { type: 'button', class: 'ma-x', title: 'Close', onclick: (e) => { stop(e); ui.open['boss:' + def.low] = false; saveUi(); draw(); } }, '✕')));
    if (ms.length > 1) out.push(h('div', { style: { margin: '0 0 4px' } }, seg(ms.map((x, i) => [i, 'Phase ' + (i + 1), x.name]), idx, (v) => { phaseSel[def.low] = v; }, { full: true })));
    out.push(capField(low));
    if (m.kind !== 'wave') out.push(scheduleEditor(low));                       // timed cap changes: dungeon bosses only
    const kinds = Presets.kinds();
    if (kinds.length) out.push(h('div', { class: 'ma-ld', style: { marginTop: '8px' } }, kinds.map((k) => h('div', {}, h('label', {}, (KIND_ICO[k] || '🎒') + ' ' + cap1(k)), loadoutPick(k, low)))));
    if (cfg.sideMob.enabled) out.push(field('Shield targeting', 'for bosses that block the class skill', seg([['auto', 'Auto'], ['normal', 'Never divert'], ['shielded', 'Always divert']], SideMob.modeOf(low), (v) => { ovr(low).targeting = v; }, { full: true })));
    if (cfg.bosses[low] && Object.keys(cfg.bosses[low]).length) out.push(h('div', { style: { marginTop: '6px' } }, h('button', { type: 'button', class: 'ma-link', onclick: () => { delete cfg.bosses[low]; saveCfg(); draw(); } }, '↺ Reset this boss to defaults')));
    return h('div', { class: 'ma-ed' }, ...out);
  }
  /* a boss as a bubble: avatar (dot = state), short name, cap · state, switch. Tap it to open its editor. */
  function splitName(n) {
    n = String(n || ''); const c = n.indexOf(',');
    if (c > 0) return [n.slice(0, c).trim(), n.slice(c + 1).trim()];
    const m = /^(.+?)\s+(the\s.+)$/i.exec(n);                         // "Oceanus The Water Titan" -> Oceanus | The Water Titan
    return m && !/\bof$/i.test(m[1]) ? [m[1], m[2]] : [n, ''];
  }
  function bubble(def) {
    const on = isOn(def), key = 'boss:' + def.low, op = !!ui.open[key], ms = Roster.members(def), cap = bossCap(def.low), [txt, kind] = entryState(def), nx = nextChange(def.low);
    const loc = def.kind === 'wave' ? '' : def.locationId ? 'Loc ' + def.locationId : def.locationIds ? 'Loc ' + def.locationIds.join('/') : '';
    const bits = [h('span', { class: 'capv' }, cap > 0 ? 'cap ' + short(cap) : 'skipped'), nx ? `→ ${short(nx.cap)} ${fmtClock(nx.t)}` : '', loc, ms.length > 1 ? ms.length + ' phases' : '', on ? h('span', { class: 'st-' + (kind || 'x') }, txt) : ''].filter(Boolean);
    const sub = []; bits.forEach((b, i) => { if (i) sub.push(' · '); sub.push(b); });
    return h('div', { class: 'ma-bb' + (on ? ' on' : '') + (op ? ' open' : ''), title: def.name, onclick: () => { ui.open[key] = !op; saveUi(); draw(); } },
      avatar(def.name, iconOfBoss(def.low), { boss: true, dot: on ? kind || 'x' : '' }),
      h('div', { class: 'ma-bb-n' }, h('b', {}, splitName(def.name)[0]), h('small', {}, ...sub)),
      sw(() => on, (v) => setMany([def], v), { sm: true, redraw: false }));
  }
  /* one wave = one row: "W12 Poseidon" + its bosses; an open boss's editor sits right under the row */
  function rowOf(label, defs, wv) {
    const open = defs.filter((d) => ui.open['boss:' + d.low]), all = defs.every(isOn);
    const lab = wv ? h('div', { class: 'ma-wv-l' + (defs.some(isOn) ? ' on' : ''), title: `Switch every boss of this wave ${all ? 'off' : 'on'}`, onclick: () => setMany(defs, !all) }, h('b', {}, wv.wave ? 'W' + wv.wave : '?'), h('small', { title: label }, label)) : null;
    return h('div', { class: 'ma-wv', style: wv ? null : { gridTemplateColumns: 'minmax(0,1fr)' } }, lab, h('div', { class: 'ma-grid' }, defs.map(bubble)), ...open.map(bossEditor));
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
    const castle = defs.filter((d) => !(d.kind === 'dungeon-swarm' || d.dtype === 'easy')), shadow = defs.filter((d) => d.kind === 'dungeon-swarm' || d.dtype === 'easy');
    const sort = (a) => a.slice().sort((x, y) => (x.locationId || (x.locationIds || [0])[0] || 0) - (y.locationId || (y.locationIds || [0])[0] || 0) || rIdx(x.low) - rIdx(y.low));
    return [{ id: 'castle', title: 'Castle', ico: '🏰', sub: 'hard', defs: sort(castle) }, { id: 'shadow', title: 'Shadowbridge', ico: '🌉', sub: 'easy', defs: sort(shadow) }].filter((g) => g.defs.length);
  }
  function bossSections(sec) {
    const f = (ui.filter || '').trim().toLowerCase(), force = !!f;
    const match = (d) => !f || Roster.members(d).some((m) => m.name.toLowerCase().includes(f));
    const canon = Roster.list.filter((d) => Roster.canon(d) === d && match(d));
    const counts = (defs) => { const n = defs.filter(isOn).length; return h('span', { class: 'ma-pill' + (n ? ' blue' : '') }, n + '/' + defs.length); };
    const bulk = (defs) => [h('button', { class: 'ma-link', type: 'button', onclick: (e) => { stop(e); setMany(defs, true); } }, 'All'), h('button', { class: 'ma-link', type: 'button', onclick: (e) => { stop(e); setMany(defs, false); } }, 'None')];
    const mk = (g, body) => fold('grp:' + g.id, g.defs.some(isOn), [g.ico + ' ' + g.title, g.sub ? h('small', {}, g.sub) : null], body, { force, aside: [counts(g.defs), ...bulk(g.defs)] });
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
    const sub = s.error ? '⚠ ' + s.error : n ? `${n} monsters · scanned ${ago(LootData.at())}` + (s.endedAt ? ` · last run read ${s.read}${s.added ? ', ' + s.added + ' new' : ''}` : '') : 'Reads every boss’s loot, level requirement and EXP cap.';
    out.push(h('div', { class: 'ma-scan' }, h('span', { class: 'ma-ico' }, '🔎'), h('div', { class: 'ma-scan-t' }, h('b', {}, 'Loot scan'), h('small', { title: sub }, sub)),
      h('div', { class: 'ma-scan-b' }, btn(n ? '↻ Rescan' : '🔎 Scan', 'soft', () => LootScan.run()), n ? btn('⬇ Export .txt', 'soft', () => LootScan.download()) : null)));
    if (s.notes.length) {
      out.push(h('div', { style: { margin: '-3px 4px 6px' } }, h('button', { type: 'button', class: 'ma-link', onclick: () => { scanOpen = !scanOpen; paintScan(); } }, `⚠ ${s.notes.length} thing${s.notes.length === 1 ? '' : 's'} could not be read ${scanOpen ? '▾' : '▸'}`)));
      if (scanOpen) out.push(h('div', { class: 'ma-scan-n' }, s.notes.map((t) => h('div', {}, t))));
    }
    return out;
  }
  function paintScan() { if (scanBox) scanBox.replaceChildren(...scanBar()); }

  function tBosses() {
    const out = [];
    if (LootScan.available) { scanBox = h('div', {}); paintScan(); out.push(scanBox); } else scanBox = null;
    const canon = Roster.list.filter((d) => Roster.canon(d) === d), dunOn = Kernel.isOn('dungeons');
    const sets = { waves: canon.filter((d) => d.kind === 'wave'), dungeons: dunOn ? canon.filter((d) => d.kind !== 'wave') : [] };
    const sec = dunOn && ui.bsec === 'dungeons' ? 'dungeons' : 'waves';
    const badge = (id) => { const f = (ui.filter || '').trim().toLowerCase(), defs = sets[id]; return f ? String(defs.filter((d) => Roster.members(d).some((m) => m.name.toLowerCase().includes(f))).length) : `${defs.filter(isOn).length}/${defs.length}`; };
    const badges = {};
    out.push(h('div', { class: 'ma-sec' }, [['waves', '🌊 Waves'], ...(dunOn ? [['dungeons', '🏰 Dungeons']] : [])].map(([id, label]) => h('button', { type: 'button', class: id === sec ? 'on' : '', onclick: () => { ui.bsec = id; saveUi(); draw(); } }, label, (badges[id] = h('i', {}, badge(id)))))));
    const box = h('div', {}), fill = () => { box.replaceChildren(...bossSections(sec)); Object.keys(badges).forEach((id) => { badges[id].textContent = badge(id); }); };
    out.push(h('div', { class: 'ma-tool' }, h('input', { class: 'ma-search', placeholder: '🔎 Filter bosses…', value: ui.filter || '', oninput: (e) => { ui.filter = e.target.value; saveUi(); fill(); } })));
    fill(); out.push(box);

    return out;
  }

  /* ---- POTIONS ---- */
  function tPotions() {
    const m = cfg.mana, A = cfg.stam.A, B = cfg.stam.B, S = cfg.stam.save, H = cfg.hp;
    return [sec('Mana'),
      h('div', {}, check('Refill mana automatically', () => m.enabled, (v) => { m.enabled = v; }), check('When max MP is 0 fill the bar', () => m.fullMaxAt0, (v) => { m.fullMaxAt0 = v; })),
      h('div', {}, fld('potion size', sel([['S', 'S (20 MP)'], ['M', 'M (40 MP)'], ['L', 'L (60 MP)'], ['XL', 'XL (100 MP)']], m.type, (v) => { m.type = v; }, 120)), textIn(m, 'name', 170, 'exact item name (optional)', 'auto'), intIn(m, 'threshold', 60, 'refill at MP ≤'), intIn(m, 'fillTo', 60, 'fill up to MP')),
      sec('Stamina (Core.potions: sidebar → remembered id → inventory)'),
      h('div', {}, check('Potion A', () => A.enabled, (v) => { A.enabled = v; }), textIn(A, 'item', 190, 'item name'), check('Potion B (next)', () => B.enabled, (v) => { B.enabled = v; }), textIn(B, 'item', 190, 'item name')),
      h('div', {}, check('Save stamina near the EXP cap', () => S.enabled, (v) => { S.enabled = v; }), pctIn(S, 'thresholdPct', 70, 'pause at EXP %')),
      sec('HP'), h('div', {}, check('Drink an HP potion when low', () => H.enabled, (v) => { H.enabled = v; }), pctIn(H, 'thresholdPct', 70, 'at HP ≤ %'))];
  }

  /* ---- GRAVEYARD ---- */
  function tGraveyard() {
    const L = cfg.autoLoot, s = Loot.state, groups = new Map();
    s.rows.filter((r) => r.needsLoot !== false).forEach((r) => { const g = groups.get(r.nameLow) || { name: r.name, rows: [], boss: r.isBoss }; g.rows.push(r); groups.set(r.nameLow, g); });
    const need = (() => { const m = Core.me.get(), e = m && m.exp; return e && e.max > 0 ? Math.max(0, e.max - e.cur) : null; })();
    return [h('div', {}, check('Auto-loot when out of stamina', () => L.enabled, (v) => { L.enabled = v; }), fld('mode', sel([['toLevel', 'only what reaches the next level'], ['all', 'everything']], L.mode, (v) => { L.mode = v; }, 230)), intIn(L, 'scanMs', 80, 'scan every (ms)'), intIn(L, 'claimGapMs', 70, 'gap between claims (ms)')),
      h('div', { class: 'core-row' }, btn(s.scanning ? 'Scanning…' : '🔎 Scan graveyard', 'soft', () => { Loot.scan(); }), btn(s.looting ? 'Looting…' : '🎒 Loot now (per mode)', 'success', () => { Loot.pass(); }),
        h('span', { class: 'core-dim' }, `${[...groups.values()].reduce((n, g) => n + g.rows.length, 0)} lootable · last scan ${ago(s.lastScanAt)}${need != null ? ' · EXP to next level ' + fmtNum(need) : ''}`)),
      groups.size ? h('table', { class: 'ma-table' }, h('thead', {}, h('tr', {}, ['Monster', 'Corpses', 'Known damage', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, [...groups.entries()].map(([low, g]) => h('tr', {}, h('td', {}, g.name + (g.boss ? ' 👑' : '')), h('td', {}, g.rows.length), h('td', {}, fmtNum(g.rows.reduce((n, r) => n + (Number.isFinite(r.userDamage) ? r.userDamage : 0), 0))),
          h('td', {}, btn(s.claiming.has(low) ? 'Claiming…' : 'Claim all', 'soft', () => { Loot.claimGroup(low); })))))) : h('div', { class: 'core-empty' }, s.lastScanAt ? 'Nothing lootable right now.' : 'Press Scan graveyard to look.')];
  }

  /* ---- LOG ---- */
  function tLog() {
    const f = cfg.logFilter || 'all', rows = Log.all().filter((r) => f === 'all' || r.k === f).slice(-160).reverse();
    return [h('div', { class: 'core-row' }, sel([['all', 'all'], ['ok', 'ok'], ['warn', 'warnings'], ['err', 'errors'], ['dmg', 'hits'], ['skill', 'skills'], ['info', 'info']], f, (v) => { cfg.logFilter = v; draw(); }, 130), btn('Clear log', 'soft', () => Log.clear())),
      rows.length ? h('div', {}, rows.map((r) => h('div', { class: 'ma-line ' + r.k }, h('b', {}, r.t + ' '), r.m.replace(/<[^>]+>/g, '')))) : h('div', { class: 'core-empty' }, 'Nothing logged yet.')];
  }

  /* ---- DIAGNOSTICS ---- */
  function tDiag() {
    const l = Diag.last(), counts = Object.entries(Diag.counts).sort((a, b) => b[1] - a[1]), au = Guard.info();
    return [h('div', { class: 'ma-grid' }, card('Why isn’t it attacking?', l.reason ? `${l.reason}${l.detail ? ' — ' + l.detail : ''}` : 'nothing skipped'), card('Last skip', ago(l.at)),
      card('Preset capabilities', Presets.note()),
      card('Re-login', au.status ? (au.status.configured ? 'configured' : 'unconfigured') : 'Core.auth missing'), card('Shielded mobs known', SideMob.shielded()), card('Version', VERSION)),
      h('div', { class: 'core-row' }, btn('Clear diagnostics', 'soft', () => Diag.clear()), btn('Forget shielded mobs', 'soft', () => { SideMob.forget(); draw(); })),
      sec('Skip reasons (count)'), counts.length ? h('table', { class: 'ma-table' }, h('tbody', {}, counts.map(([k, n]) => h('tr', {}, h('td', {}, k), h('td', {}, n))))) : h('div', { class: 'core-dim' }, 'none'),
      sec('Recent events'), Diag.events.length ? h('div', {}, Diag.events.slice(-40).reverse().map((e) => h('div', { class: 'ma-line' }, h('b', {}, e.t + ' '), e.reason + (e.detail ? ' — ' + e.detail : '')))) : h('div', { class: 'core-dim' }, 'none')];
  }

  /* ---- SETTINGS ---- */
  function tSettings() {
    const tiers = TIER_CHAIN.slice(0, 4).map((t) => [t, SKILLS[t].label + ' (' + SKILLS[t].cost + ' stam)']);
    return [sec('Attacks'),
      h('div', {}, fld('highest skill tier', sel(tiers, cfg.maxTier, (v) => { cfg.maxTier = v; }, 220)), fld('class skill', sel([['auto', 'auto' + (cfg.detectedClass ? ' (' + cfg.detectedClass + ')' : '')], ['warrior', 'warrior'], ['cleric', 'cleric'], ['hunter', 'hunter'], ['mage', 'mage']], cfg.classOverride, (v) => { cfg.classOverride = v; }, 160)),
        check('Use the class skill', () => cfg.useClassSkill, (v) => { cfg.useClassSkill = v; })),
      h('div', {}, intIn(cfg, 'attackDelayMs', 70, 'wave swing gap (ms)'), intIn(cfg, 'dungeonAttackDelayMs', 70, 'dungeon swing gap (ms)'), intIn(cfg, 'minActionGapMs', 70, 'min gap between requests (ms)'), intIn(cfg, 'skillToAttackGapMs', 70, 'skill → attack gap (ms)')),
      h('div', {}, intIn(cfg, 'defaultBossCap', 90, 'default boss cap'), intIn(cfg, 'fightScanMs', 70, 'rescan while fighting (ms)'), intIn(cfg, 'idleRecheckMs', 70, 'recheck idle boss (ms)'), intIn(cfg, 'dungeonPollMs', 70, 'dungeon poll (ms)')),
      sec('Behaviour'),
      h('div', {}, check('Pause the server auto-farm while fighting', () => cfg.autoFarmControl, (v) => { cfg.autoFarmControl = v; }), check('Fight Phase Duels automatically', () => cfg.autoDuel, (v) => { cfg.autoDuel = v; }),
        check('Shield pierce on a side mob (only if a boss is shielded)', () => cfg.sideMob.enabled, (v) => { cfg.sideMob.enabled = v; draw(); })),
      sec('Parts (switch one off and the rest keep working)'),
      h('div', {}, [...Kernel.parts.values()].map((p) => check(`${p.icon || ''} ${p.name || p.id}`, () => Kernel.isOn(p.id), (v) => { cfg.parts[p.id] = v; Engine.poke(true); })))];
  }

  const BUILD = { status: tStatus, bosses: tBosses, potions: tPotions, graveyard: tGraveyard, log: tLog, diag: tDiag, settings: tSettings };
  function scroller(el) { for (let n = el && el.parentElement; n; n = n.parentElement) { const o = getComputedStyle(n).overflowY; if ((o === 'auto' || o === 'scroll') && n.scrollHeight > n.clientHeight) return n; } return null; }
  function draw() {
    if (!root || !open || !root.isConnected) return;
    const sc = scroller(root), top = sc ? sc.scrollTop : 0;
    let body; try { body = BUILD[tab]() } catch (e) { body = [h('div', { class: 'core-err' }, 'panel error: ' + e.message)]; console.warn('[automator] panel', e); }
    root.replaceChildren(header(), tabsBar(), h('div', { class: 'ma-body' }, ...[].concat(body)));
    if (sc) sc.scrollTop = top;
  }
  const typing = () => root && root.contains(document.activeElement) && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
  function schedule(ms) { if (drawT) return; drawT = setTimeout(() => { drawT = 0; if (typing()) schedule(1500); else draw(); }, ms || 400); }
  if (typeof Core.on === 'function') Core.on('caps:changed', (d) => { if (open && d && (d.added || []).some((n) => n.startsWith('preset.'))) schedule(300); });   // a preset addon loaded late
  UI.hook((what) => { if (!open) return; if (what === 'scan') { if (tab === 'bosses') paintScan(); return; } if (what === undefined || DIRTY_TAB[what] === tab || (what === 'loot' && tab === 'graveyard') || (what === 'status' && tab === 'status')) schedule(); });

  function register() {
    Core.float.add({ id: ID, title: 'Automator', icon: '🤖', order: 40, width: 560,
      render(el) { root = h('div', { class: 'ma-root' }); el.replaceChildren(root); open = true; draw(); },
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
  start: Run.start, stop: Run.stop, scanNow: Engine.scanNow, register: Kernel.register, loot: LootData.all, lootScan: LootScan,
};

  },
});
