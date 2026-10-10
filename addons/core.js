/* core.js - the Core loader itself. NOT a userscript: the tiny core.user.js in Tampermonkey downloads this file,
 * caches it, runs it, and swaps in new versions on the next page load (exactly like the addons). */

/* =============================================================================
 * Core — the ONLY userscript you install.
 *
 *  1. Set CONFIG.manifest below to the raw URL of your addons.json.
 *  2. Open the site: every addon that has a panel gets its OWN floating button
 *     (💎 Crystals, ⚔️ Gear, 🐾 Pets, …) and a ⚙️ button manages the addon list.
 *  3. Addons are plain .js files at URLs, listed in addons.json (or added with the
 *     ⚙️ button). No separate userscripts to install.
 *
 * Addon file API (everything hangs off the global `Core`, which is in scope in addon code):
 *   Core.float.add({ id, title, icon, order, width, render(el, Core, api), onShow, onHide })
 *                                  -> floating button + panel.   (or { id, icon, title, onClick } = button only)
 *   Core.float.open(id) · close(id) · closeAll() · refresh(id) · remove(id)
 *   Core.module({ id, name, icon, version, match, deps, early, float, init(Core, ctx) { return api } })
 *   Core.net.{fetchText,fetchDoc,fetchJson,post,invalidate,invalidateOn,watch}
 *   Core.pages.{inventory,pets,crystals,stats,pvp,quests,battlePass,dungeons,define}
 *   Core.cookies.withMode · Core.player.id() · Core.state · Core.store · Core.on/once/emit
 *   Core.dom.{watch,when,ready} · Core.ui.{toast,modal,menu,h,btn,css}
 * Full reference with examples: REFERENCE.md in the repo.
 * ========================================================================== */
(function (root) {
  'use strict';

  // >>> EDIT THIS ONE LINE: raw URL of your addons.json
  const CONFIG = { manifest: 'https://raw.githubusercontent.com/WerewuIf/UI-Core/main/addons.json' };

  const API = 2;
  if (root.Core && root.Core.__isCore) {
    if (root.Core.apiLevel < API) console.warn('[Core] an older core (api ' + root.Core.apiLevel + ') is already loaded; this script wants ' + API + '.');
    return;
  }

  const TAB = Math.random().toString(36).slice(2);
  const warn = (...a) => console.warn('[Core]', ...a);
  const dlog = (...a) => { if (Core.debug) console.log('[Core]', ...a); };

  /* ------------------------------------------------------------- utils --- */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const fmt = (n) => Number(n || 0).toLocaleString();
  const int = (s) => parseInt(String(s ?? '').replace(/[^\d-]/g, ''), 10) || 0;
  function compact(n) {
    n = Number(n) || 0;
    const a = Math.abs(n);
    for (const [lim, s] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) {
      if (a >= lim) return (n / lim).toFixed(a / lim >= 100 ? 0 : a / lim >= 10 ? 1 : 2).replace(/\.?0+$/, '') + s;
    }
    return String(Math.round(n));
  }
  function parseJson(raw) {
    const t = String(raw ?? '').replace(/^\uFEFF/, '').trim();
    try { return JSON.parse(t); } catch (_) { /* fall through */ }
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (_) { /* ignore */ } }
    return null;
  }
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    kids.flat().forEach((c) => { if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c))); });
    return el;
  }

  /* --------------------------------------------------------- event bus --- */
  const handlers = new Map();
  const bc = root.BroadcastChannel ? new root.BroadcastChannel('core-bus') : null;
  function dispatch(evt, data) {
    const set = handlers.get(evt);
    if (set) [...set].forEach((fn) => { try { fn(data, evt); } catch (e) { warn('handler for "' + evt + '" threw', e); } });
  }
  function on(evt, fn) { let s = handlers.get(evt); if (!s) handlers.set(evt, s = new Set()); s.add(fn); return () => s.delete(fn); }
  function off(evt, fn) { const s = handlers.get(evt); if (s) s.delete(fn); }
  function once(evt, fn) { const un = on(evt, (d, e) => { un(); fn(d, e); }); return un; }
  function emit(evt, data, o) {
    dispatch(evt, data);
    if (o && o.shared && bc) { try { bc.postMessage({ evt, data, from: TAB }); } catch (_) { /* not cloneable */ } }
  }
  if (bc) bc.onmessage = (e) => { const m = e.data; if (m && m.from !== TAB) dispatch(m.evt, m.data); };

  /* ------------------------------------------------------------ player --- */
  let pidCache = null;
  // Player id, from the most to least reliable place. Pages differ: most have the sidebar link,
  // but e.g. the event map has no sidebar and only exposes the id in its #ecConfig JSON.
  const player = {
    id() {
      if (pidCache) return pidCache;
      let pid = null;
      try {
        const link = document.querySelector('.side-drawer a[href*="player.php?pid="]');
        const m = link && /pid=(\d+)/.exec(link.getAttribute('href') || '');
        if (m) pid = m[1];
        if (!pid && root.expPotionSettings && root.expPotionSettings.userId) pid = String(root.expPotionSettings.userId);
        if (!pid) {
          const ec = document.getElementById('ecConfig');
          const u = ec && JSON.parse(ec.textContent || '{}').userId;
          if (u) pid = String(u);
        }
      } catch (_) { /* fall through to the remembered id */ }
      if (pid) { pidCache = pid; try { localStorage.setItem('core:lastPid', pid); } catch (_) { /* */ } return pid; }
      try { return localStorage.getItem('core:lastPid') || 'default'; } catch (_) { return 'default'; }
    },
  };

  /* ------------------------------------------------------------- state --- */
  const stateData = {};
  const state = {
    get: (k, d) => (k in stateData ? stateData[k] : d),
    set(k, v) { const old = stateData[k]; if (old === v) return v; stateData[k] = v; dispatch('state:' + k, { value: v, old }); return v; },
    update(k, fn) { return state.set(k, fn(stateData[k])); },
    watch(k, cb) { return on('state:' + k, (p) => cb(p.value, p.old)); },
  };

  /* ------------------------------------------------------------- store --- */
  // One JSON blob per namespace. opts.key lets you keep an existing localStorage
  // key (string or () => string) so current presets keep working untouched.
  const storeKeys = new Map();
  function store(ns, o = {}) {
    const keyOf = () => (o.key ? (typeof o.key === 'function' ? o.key() : o.key) : 'core:' + player.id() + ':' + ns);
    const fresh = () => (o.def === undefined ? undefined : JSON.parse(JSON.stringify(o.def)));
    const api = {
      get() { try { const raw = localStorage.getItem(keyOf()); return raw == null ? fresh() : JSON.parse(raw); } catch (_) { return fresh(); } },
      set(v) { try { localStorage.setItem(keyOf(), JSON.stringify(v)); } catch (e) { warn('store write failed', ns, e); } dispatch('store:' + ns, v); return v; },
      update(fn) { const cur = api.get(); const r = fn(cur); return api.set(r === undefined ? cur : r); },
      watch: (cb) => on('store:' + ns, cb),
    };
    storeKeys.set(ns, keyOf);
    return api;
  }
  root.addEventListener('storage', (e) => {
    storeKeys.forEach((keyOf, ns) => {
      if (keyOf() !== e.key) return;
      let v; try { v = e.newValue == null ? undefined : JSON.parse(e.newValue); } catch (_) { return; }
      dispatch('store:' + ns, v);
    });
  });

  /* --------------------------------------------------------------- net --- */
  const net = (() => {
    const cache = new Map();   // key -> { ts, p, href }
    const rules = [];          // { when, body, drop[] }
    const watchers = [];       // { re, method, cb }
    const abs = (u) => new URL(u, root.location.origin).href;

    // Cached, de-duplicated GET. Same URL in flight = same promise, no 2nd request.
    //   ttl   ms to reuse (default 30s)   force  skip cache
    //   key   custom cache key (use when `via` changes what the server returns)
    //   via   fn(run) => Promise   wrap the request (e.g. Core.cookies.withMode)
    function fetchText(url, o = {}) {
      const href = abs(url);
      const key = o.key || href;
      const hit = cache.get(key);
      if (!o.force && hit && Date.now() - hit.ts < (o.ttl ?? 30000)) return hit.p;
      const run = () => root.fetch(href, { credentials: 'include', cache: 'no-store' })
        .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); });
      const entry = { ts: Date.now(), href, p: o.via ? o.via(run) : run() };
      cache.set(key, entry);
      entry.p.catch(() => { if (cache.get(key) === entry) cache.delete(key); });
      return entry.p;
    }
    // A fresh Document per call (parsing is cheap, the network round trip isn't),
    // so one addon mutating its copy can't corrupt another's.
    const fetchDoc = (url, o) => fetchText(url, o).then((html) => new DOMParser().parseFromString(html, 'text/html'));
    const fetchJson = (url, o) => fetchText(url, o).then(parseJson);

    // Form POST. Goes through the hooked fetch, so cache invalidation rules fire.
    async function post(url, params, o = {}) {
      const body = params instanceof URLSearchParams ? params : new URLSearchParams(params || {});
      const res = await root.fetch(abs(url), {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, o.json ? { Accept: 'application/json' } : {}),
        body: body.toString(),
        credentials: 'include',
      });
      const text = await res.text();
      return { ok: res.ok, status: res.status, text, json: parseJson(text) };
    }

    function dropLocal(spec) {
      if (!spec) return;
      if (spec.all) { cache.clear(); return; }
      const re = spec.re ? new RegExp(spec.re, spec.f || '') : null;
      for (const [k, e] of cache) {
        if (re ? (re.test(k) || re.test(e.href)) : (k.includes(spec.s) || e.href.includes(spec.s))) cache.delete(k);
      }
    }
    on('net:invalidate', dropLocal);
    // Drops matching entries in this tab AND every other tab.
    function invalidate(p) {
      const spec = p == null ? { all: true } : typeof p === 'string' ? { s: p } : { re: p.source, f: p.flags.replace(/[gy]/g, '') };
      emit('net:invalidate', spec, { shared: true });
    }

    // "when a POST hits `when`, forget cached pages matching `drop`"
    function invalidateOn(when, drop, bodyMatch) { rules.push({ when, body: bodyMatch || null, drop: [].concat(drop) }); }
    invalidateOn(/\/inventory_ajax\.php/, [/\/inventory\.php/, /\/pets\.php/]);
    invalidateOn(/\/power_crystals\.php/, /\/power_crystals\.php/);
    invalidateOn(/\/pet_link_action\.php|\/pet_sigil_action\.php/, /\/pets\.php/);
    invalidateOn(/\/adventurers_(accept|finish|giveup|donate)/, /\/adventurers_guild\.php/);

    // Read responses of matching requests without touching what the page receives.
    function watch(re, cb, o = {}) { const w = { re, cb, method: o.method && o.method.toUpperCase() }; watchers.push(w); return () => { const i = watchers.indexOf(w); if (i >= 0) watchers.splice(i, 1); }; }

    function onResponse(url, method, body, res) {
      let href; try { href = abs(url); } catch (_) { return; }
      if (method !== 'GET' && method !== 'HEAD') {
        rules.forEach((r) => { if (r.when.test(href) && (!r.body || r.body.test(body || ''))) r.drop.forEach(invalidate); });
      }
      dispatch('net:response', { url: href, method, body, status: res.status, ok: res.ok });
      watchers.forEach((w) => {
        if (!w.re.test(href) || (w.method && w.method !== method)) return;
        res.clone().text().then((text) => w.cb({ url: href, method, body, status: res.status, ok: res.ok, text, json: parseJson(text) })).catch(() => {});
      });
    }

    if (root.fetch && !root.__coreFetchHooked) {
      root.__coreFetchHooked = true;
      const native = root.fetch.bind(root);
      root.fetch = function (input, init) {
        const p = native(input, init);
        try {
          const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
          const url = typeof input === 'string' ? input : (input && input.url) || String(input);
          const body = init && typeof init.body === 'string' ? init.body : null;
          p.then((res) => { try { onResponse(url, method, body, res); } catch (e) { warn(e); } }, () => {});
        } catch (_) { /* never break the page's own fetch */ }
        return p;
      };
    }

    return { fetchText, fetchDoc, fetchJson, post, invalidate, invalidateOn, watch, parseJson, get cacheSize() { return cache.size; } };
  })();

  /* ------------------------------------------------------------- pages --- */
  // Returns the LIVE document when you're already on that page, otherwise a
  // cached fetched copy. Pass {fetch:true} to force the fetched copy, {force:true} to bypass cache.
  const samePath = (p) => root.location.pathname.replace(/\/+$/, '') === p;
  function pageFn(path, param, dflt) {
    if (!param) return (o = {}) => (samePath(path) && !o.fetch ? Promise.resolve(document) : net.fetchDoc(path, o));
    return (val = dflt, o = {}) => {
      const onIt = samePath(path) && (new URLSearchParams(root.location.search).get(param) || dflt) === val;
      return onIt && !o.fetch ? Promise.resolve(document) : net.fetchDoc(path + '?' + param + '=' + encodeURIComponent(val), o);
    };
  }
  const pages = {
    inventory: pageFn('/inventory.php', 'set', 'attack'),   // set: attack | pvp_attack | defense
    pets: pageFn('/pets.php', 'team', 'attack'),            // team: attack | pvp_attack | defense
    crystals: pageFn('/power_crystals.php'),
    stats: pageFn('/stats.php'),
    pvp: pageFn('/pvp.php'),
    quests: pageFn('/adventurers_guild.php'),
    battlePass: pageFn('/battle_pass.php'),
    dungeons: pageFn('/guild_dungeon.php'),
    define: pageFn,
  };

  /* --------------------------------------------------------------- dom --- */
  let domReady = false;
  const ready = new Promise((r) => (document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', r, { once: true }) : r()));
  const dom = (() => {
    const subs = new Set();
    let mo = null, timer = null;
    function flush() {
      subs.forEach((s) => {
        if (s.until && Date.now() > s.until) { subs.delete(s); return; }
        try { s.fn(); } catch (e) { warn('dom.watch callback threw', e); }
      });
      if (!subs.size && mo) { mo.disconnect(); mo = null; }
    }
    function start() {
      if (mo) return;
      mo = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(flush, 50); });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    }
    // fn must be idempotent. Runs once now, then debounced after any DOM change.
    // opts: { for: ms to stop watching, immediate: false }
    function watch(fn, o = {}) {
      const s = { fn, until: o.for ? Date.now() + o.for : 0 };
      subs.add(s); start();
      if (o.immediate !== false) { try { fn(); } catch (e) { warn(e); } }
      return () => subs.delete(s);
    }
    function when(sel, timeout = 15000) {
      return new Promise((res) => {
        const found = document.querySelector(sel);
        if (found) return res(found);
        const t = setTimeout(() => { un(); res(null); }, timeout);
        const un = watch(() => { const e = document.querySelector(sel); if (e) { clearTimeout(t); un(); res(e); } }, { immediate: false });
      });
    }
    return { watch, when, ready };
  })();

  /* ----------------------------------------------------------- cookies --- */
  // hide_dead_monsters / show_dead_bosses_only are browser-wide; swapping them for a
  // fetch must be serialized across ALL tabs and restored even if a tab dies mid-fetch.
  const cookies = (() => {
    const LOCK = 'guild-suite-monster-cookies', BACKUP = 'guildSuiteCookieBackup';
    const NAMES = ['hide_dead_monsters', 'show_dead_bosses_only'];
    const MODES = { alive: { hide_dead_monsters: '1', show_dead_bosses_only: '0' }, dead: { hide_dead_monsters: '0', show_dead_bosses_only: '1' }, all: { hide_dead_monsters: '0', show_dead_bosses_only: '0' } };
    const get = (n) => { const m = document.cookie.match(new RegExp('(^|;\\s*)' + n + '\\s*=\\s*([^;]+)')); return m ? m[2] : null; };
    const set = (n, v) => { document.cookie = n + '=' + v + '; Path=/; SameSite=Lax'; };
    const restore = (snap) => NAMES.forEach((n) => set(n, snap[n] == null ? '0' : snap[n]));
    const recoverStale = () => {
      try { const raw = localStorage.getItem(BACKUP); if (raw) restore(JSON.parse(raw)); } catch (_) { /* */ }
      try { localStorage.removeItem(BACKUP); } catch (_) { /* */ }
    };
    const locked = (fn) => (navigator.locks && navigator.locks.request ? navigator.locks.request(LOCK, fn) : fn());
    function withMode(mode, fn) {
      return locked(async () => {
        recoverStale();
        const snap = {}; NAMES.forEach((n) => { snap[n] = get(n); });
        try { localStorage.setItem(BACKUP, JSON.stringify(snap)); } catch (_) { /* */ }
        const want = MODES[mode] || MODES.alive;
        NAMES.forEach((n) => set(n, want[n]));
        try { return await fn(); } finally { restore(snap); try { localStorage.removeItem(BACKUP); } catch (_) { /* */ } }
      });
    }
    const recover = () => locked(async () => recoverStale());
    recover().catch(() => {});
    return { withMode, recover };
  })();
  if (!root.__gsCookies) root.__gsCookies = cookies; // legacy name some old scripts check

  /* ---------------------------------------------------------------- ui --- */
  const ui = (() => {
    const CSS = `
      .core-modal{position:fixed;inset:0;background:rgba(6,10,18,.74);display:none;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(7px)}
      .core-modal.show{display:flex}
      .core-modal-card{width:100%;max-height:90vh;overflow:auto;scrollbar-width:none;-ms-overflow-style:none;box-sizing:border-box;background:linear-gradient(180deg,rgba(24,34,56,.98),rgba(14,20,34,.98));border:1px solid rgba(255,255,255,.08);border-radius:22px;box-shadow:0 26px 60px rgba(0,0,0,.38);padding:22px;color:#eef3ff;font-family:Arial,sans-serif}
      .core-modal-card::-webkit-scrollbar{display:none;width:0;height:0}
      /* While any modal is open the page behind it must not scroll (and its scrollbar must not show beside the modal). */
      html:has(.core-modal.show,.pcp-modal.show,.gp-modal.show,.pp-modal.show),
      html:has(.core-modal.show,.pcp-modal.show,.gp-modal.show,.pp-modal.show) body{overflow:hidden !important}
      .core-modal-card,.pcp-modal-card,.gp-modal-card,.pp-modal-card,.pcp-editor-grid,.pcp-picker-grid,.gp-picker-grid,.pp-picker-grid{overscroll-behavior:contain}
      .core-modal-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px}
      .core-modal-title{margin:0;font-size:22px}
      .core-close{width:38px;height:38px;border-radius:12px;border:none;background:#18223a;color:#fff;font-size:20px;cursor:pointer}
      .core-footer{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px;align-items:center}
      .core-footer:empty{display:none}
      .core-spacer{flex:1 1 auto}
      .core-btn{border:none;cursor:pointer;color:#fff;background:linear-gradient(135deg,#3657a7,#4b6dd0);padding:9px 14px;border-radius:12px;font:700 13px Arial,sans-serif;box-shadow:0 8px 18px rgba(41,72,155,.28)}
      .core-btn:hover{filter:brightness(1.06)}
      .core-btn:disabled{opacity:.5;cursor:not-allowed}
      .core-btn-soft{background:linear-gradient(135deg,#222d49,#2b3859);box-shadow:none}
      .core-btn-success{background:linear-gradient(135deg,#217f5b,#33b57f)}
      .core-btn-danger{background:linear-gradient(135deg,#7b3040,#b4465c)}
      .core-empty{padding:30px 18px;text-align:center;color:#9caad0;background:rgba(255,255,255,.02);border:1px dashed rgba(255,255,255,.08);border-radius:16px}
      .core-menu{position:fixed;z-index:2147483000;background:#171e33;border:1px solid rgba(255,255,255,.1);border-radius:12px;box-shadow:0 12px 28px rgba(0,0,0,.45);min-width:150px;padding:6px;display:none}
      .core-menu.open{display:block}
      .core-menu-item{display:block;width:100%;text-align:left;background:none;border:none;color:#e7ecff;padding:8px 10px;border-radius:8px;font:13px Arial,sans-serif;cursor:pointer}
      .core-menu-item:hover{background:rgba(255,255,255,.06)}
      .core-menu-item.danger{color:#ff8a97}
      #core-toast{position:fixed;top:20px;right:20px;z-index:2147483001;max-width:420px;padding:12px 20px;border-radius:10px;color:#fff;font:600 14px Arial,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.4);white-space:pre-line;display:none;cursor:pointer}
      #core-dock{position:fixed;z-index:99990;display:flex;gap:10px;flex-direction:row-reverse}
      /* The floating buttons that open each panel: an exact copy of the game's own
         .quickset-drawer-trigger / .battle-drawer-trigger buttons (the rounded ⚔️ and 🧪 ones). */
      .core-dock-btn{display:flex;align-items:center;justify-content:center;gap:6px;background:#24263a;border:1px solid #2f324d;box-shadow:0 10px 24px rgba(0,0,0,.6);border-radius:12px;color:#fff;cursor:pointer;font-weight:700;font-size:14px;line-height:1.2;padding:10px 12px}
      .core-dock-btn:active{transform:scale(.97)}
      .core-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
      .core-input{box-sizing:border-box;padding:8px 10px;border-radius:10px;border:1px solid #2b3859;background:#0d1322;color:#eef3ff;font:13px Arial,sans-serif}
      .core-dim{color:#9caad0;font-size:12px;overflow-wrap:anywhere}
      .core-err{color:#ff8a97;font-size:12px;margin-top:3px}
      .core-pill{font:800 10px Arial,sans-serif;letter-spacing:.03em;text-transform:uppercase;border-radius:999px;padding:2px 8px;border:1px solid rgba(255,255,255,.15);color:#9caad0}
      .core-pill-ok{color:#8ee6a8;border-color:rgba(46,204,113,.4);background:rgba(46,204,113,.1)}
      .core-pill-error{color:#ff8a97;border-color:rgba(255,107,122,.4);background:rgba(255,107,122,.1)}
      .core-pill-loading{color:#ffd978;border-color:rgba(255,217,120,.4)}
      /* NO scrollbar here: the modal card is the one and only scroller (like the original modals). */
      .core-float-pane{min-width:0}
      .core-addon{display:flex;gap:12px;align-items:center;padding:12px;background:#11192d;border:1px solid rgba(255,255,255,.06);border-radius:14px;margin-bottom:10px}
      .core-addon-main{flex:1 1 auto;min-width:0}
      .core-addon-name{font-weight:800}
      .core-addon-meta{display:flex;flex-direction:column;align-items:flex-end;gap:3px}
      .core-addon .core-btn{padding:6px 10px}
    `;
    let baseDone = false;
    const modals = new Map(), openStack = [];
    let z = 100000;

    function css(id, text) {
      const sid = 'core-css-' + id;
      const host = document.head || document.documentElement;
      if (!host) { ready.then(() => css(id, text)); return; }   // earlier than <html> exists: wait
      if (document.getElementById(sid)) return;
      host.appendChild(h('style', { id: sid }, text));
    }
    function base() {
      if (baseDone) return; baseDone = true;
      css('base', CSS);
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openStack.length) openStack[openStack.length - 1].close(); }, true);
      document.addEventListener('click', (e) => { if (!e.target.closest('.core-menu') && !e.target.closest('[data-core-menu-anchor]')) closeMenu(); }, true);
    }

    const btn = (label, kind, onClick) => h('button', { class: 'core-btn' + (kind ? ' core-btn-' + kind : ''), type: 'button', onclick: onClick }, label);

    // ui.toast(msg, ok = true, ms = 3000). Safe to call before <body> exists.
    function toast(msg, ok = true, ms = 3000, onClick = null) {
      if (!document.body) { ready.then(() => toast(msg, ok, ms, onClick)); return; }
      base();
      let el = document.getElementById('core-toast');
      if (!el) { el = h('div', { id: 'core-toast' }); document.body.appendChild(el); }
      el.onclick = () => { el.style.display = 'none'; if (onClick) onClick(); };
      el.textContent = msg;
      el.style.background = ok ? '#2ecc71' : '#e74c3c';
      el.style.display = 'block';
      clearTimeout(el._t);
      if (ms) el._t = setTimeout(() => { el.style.display = 'none'; }, ms);
    }

    // ui.modal({ id, title, width, body: Node|string, actions:[{label,kind,onClick,close}], onClose })
    // Calling it again with the same id returns the same instance. Later opens stack on top.
    function modal(o = {}) {
      if (o.id && modals.has(o.id)) return modals.get(o.id);
      base();
      const titleEl = h('h3', { class: 'core-modal-title' }, o.title || '');
      const body = h('div', { class: 'core-modal-body' });
      const foot = h('div', { class: 'core-footer' });
      const el = h('div', { class: 'core-modal' },
        h('div', { class: 'core-modal-card', style: { maxWidth: (o.width || 760) + 'px' } },
          h('div', { class: 'core-modal-head' }, titleEl, h('button', { class: 'core-close', type: 'button', onclick: () => m.close() }, '\u00d7')),
          body, foot));
      el.addEventListener('click', (e) => { if (e.target === el) m.close(); });
      const m = {
        el, body, foot,
        setTitle: (t) => { titleEl.textContent = t; },
        setBody(b) { body.replaceChildren(); if (typeof b === 'string') body.innerHTML = b; else if (b) body.append(b); },
        setActions(list) {
          foot.replaceChildren(...(list || []).map((a) => a.spacer ? h('div', { class: 'core-spacer' }) : btn(a.label, a.kind, async (e) => { if (a.onClick) await a.onClick(e, m); if (a.close) m.close(); })));
        },
        get isOpen() { return el.classList.contains('show'); },
        open() {
          // Attach SYNCHRONOUSLY when <body> exists: addons render into the modal right after
          // open(), and document.getElementById() can't see nodes in a detached subtree.
          const go = () => {
            if (!el.isConnected) document.body.appendChild(el);
            el.style.zIndex = ++z; el.classList.add('show');
            if (!openStack.includes(m)) openStack.push(m);
            if (o.onOpen) o.onOpen(m);
          };
          if (document.body) go(); else ready.then(go);
          return m;
        },
        close() {
          if (!m.isOpen) return;
          el.classList.remove('show');
          const i = openStack.indexOf(m); if (i >= 0) openStack.splice(i, 1);
          if (o.onClose) o.onClose(m);
        },
      };
      if (o.body) m.setBody(o.body);
      m.setActions(o.actions);
      if (o.id) modals.set(o.id, m);
      return m;
    }

    let menuEl = null, menuFor = null;
    function closeMenu() { if (menuEl) menuEl.classList.remove('open'); menuFor = null; }
    // ui.menu(anchorEl, [{label, onClick, danger}]) — toggles a dropdown under anchorEl.
    function menu(anchor, items) {
      base();
      if (!menuEl) { menuEl = h('div', { class: 'core-menu' }); document.body.appendChild(menuEl); }
      const same = menuEl.classList.contains('open') && menuFor === anchor;
      closeMenu();
      if (same) return;
      menuFor = anchor; anchor.setAttribute('data-core-menu-anchor', '');
      menuEl.replaceChildren(...items.map((it) => h('button', { class: 'core-menu-item' + (it.danger ? ' danger' : ''), type: 'button', onclick: (e) => { e.stopPropagation(); closeMenu(); it.onClick(); } }, it.label)));
      const r = anchor.getBoundingClientRect();
      Object.assign(menuEl.style, { top: (r.bottom + 6) + 'px', right: (root.innerWidth - r.right) + 'px', left: 'auto' });
      menuEl.classList.add('open');
    }

    // ONE floating button row for every addon, kept clear of the site's own fixed buttons.
    const dockItems = [];
    let dockEl = null;
    function fixedRects(skip) {
      const out = [];
      const near = (r) => { const fb = root.innerHeight - r.bottom; return fb >= -20 && fb <= 420; };   // covers the stacked-row fallback
      document.querySelectorAll('body *').forEach((el) => {
        if (skip.contains(el) || el.closest('.core-modal,.core-menu,#core-toast')) return;
        const s = getComputedStyle(el);
        if (s.position !== 'fixed' || s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return;
        if (r.width <= 220 && r.height <= 140) { if (near(r)) out.push(r); return; }
        // Bigger than a button. A full-screen overlay / drawer is ignored, but a small fixed GROUP of
        // buttons (e.g. a column of zoom controls) is avoided by looking at the buttons inside it.
        if (r.width >= root.innerWidth * 0.6 || r.height >= root.innerHeight * 0.6) return;
        el.querySelectorAll('button,a,input,select,[role="button"]').forEach((c) => {
          const cr = c.getBoundingClientRect();
          if (cr.width && cr.height && cr.width <= 220 && cr.height <= 140 && near(cr)) out.push(cr);
        });
      });
      return out;
    }
    const placeDock = debounce(() => {
      if (!dockEl) return;
      const BOTTOM = 17, GAP = 8, EDGE = 8;           // BOTTOM matches the site's own round/rounded buttons
      const w = dockEl.offsetWidth || 45, hh = dockEl.offsetHeight || 40;
      const others = fixedRects(dockEl);
      const clear = (right, bottom) => {
        const left = root.innerWidth - right - w, top = root.innerHeight - bottom - hh, bot = root.innerHeight - bottom;
        return left >= EDGE && !others.some((r) => !(left > r.right + GAP || left + w < r.left - GAP || top > r.bottom + GAP || bot < r.top - GAP));
      };
      // Lowest row first (level with the site's own buttons), sliding left within each row until it
      // clears them and is fully on screen; if a row has no room (phones), try the next row up.
      let right = 14, bottom = BOTTOM;
      search: for (let b = BOTTOM; b < BOTTOM + 300; b += 4) {
        for (let r = 14; root.innerWidth - r - w >= EDGE; r += 4) {
          if (clear(r, b)) { right = r; bottom = b; break search; }
        }
      }
      dockEl.style.right = right + 'px';
      dockEl.style.bottom = bottom + 'px';
    }, 120);
    const dock = {
      // ui.dock.add({ id, icon, title, onClick, order }) -> button element
      add(o) {
        base();
        const b = h('button', { class: 'core-dock-btn', type: 'button', title: o.title || '', 'data-dock-id': o.id, onclick: o.onClick }, o.icon || '\u2022');
        dockItems.push({ id: o.id, order: o.order ?? 100, el: b });
        ready.then(() => {
          if (!dockEl) { dockEl = h('div', { id: 'core-dock' }); document.body.appendChild(dockEl); root.addEventListener('resize', placeDock); }
          dockEl.replaceChildren(...dockItems.slice().sort((a, c) => a.order - c.order).map((i) => i.el));
          placeDock();
        });
        return b;
      },
      remove(id) {
        const i = dockItems.findIndex((x) => x.id === id);
        if (i < 0) return;
        dockItems[i].el.remove(); dockItems.splice(i, 1);
        if (dockEl) placeDock();
      },
    };

    return { css, h, btn, toast, modal, menu, dock };
  })();

  /* ----------------------------------------------------------- modules --- */
  // Core.module({ id, match, deps, early, float, init(Core) })   (optional: plain-script addons don't need it)
  //   match  RegExp (tested on path+query) | string | string[] | fn(location); default: everywhere
  //   deps   module ids that must be READY before init (hard dependency)
  //   early  run at load time instead of waiting for DOMContentLoaded
  //   init   may be async; whatever it returns becomes the module's public api (Core.use / Core.get)
  const mods = new Map();   // id -> { def, state, api, waiters }
  // Shared by the module system and the addon loader: user addons, disabled ids, dev flag.
  const cfg = store('addons', { def: { custom: [], off: [], dev: false }, key: 'core:addons' });

  function matches(def) {
    const t = def.match, p = root.location.pathname + root.location.search;
    if (!t) return true;
    if (typeof t === 'function') return !!t(root.location);
    if (t instanceof RegExp) return t.test(p);
    return [].concat(t).some((x) => (x instanceof RegExp ? x.test(p) : p.includes(x)));
  }
  function settle(m) { const v = m.state === 'ready' ? m.api : null; m.waiters.splice(0).forEach((w) => w(v)); }
  function slot(id) { let m = mods.get(id); if (!m) mods.set(id, m = { def: null, state: 'absent', api: null, waiters: [] }); return m; }

  function pump() {
    let changed;
    do {
      changed = false;
      for (const m of mods.values()) {
        if (m.state !== 'pending') continue;
        const d = m.def;
        if (!d.early && !domReady) continue;
        const deps = (d.deps || []).map((id) => mods.get(id));
        if (deps.some((x) => x && (x.state === 'skipped' || x.state === 'failed'))) {
          m.state = 'skipped'; warn('module "' + d.id + '" skipped: a dependency did not load'); settle(m); changed = true; continue;
        }
        if (deps.some((x) => !x || x.state !== 'ready')) continue;
        m.state = 'running';
        Promise.resolve().then(() => d.init(Core, ctxFor(d))).then(
          (api) => {
            m.api = api || {}; m.state = 'ready'; dlog('ready', d.id);
            if (d.float) float.add(Object.assign({ id: d.id, title: d.name || d.id, icon: d.icon, api: m.api }, typeof d.float === 'function' ? { render: d.float } : d.float));
          },
          (err) => { m.state = 'failed'; warn('module "' + d.id + '" failed in init', err); }
        ).then(() => { settle(m); dispatch('module:ready', { id: d.id, state: m.state }); pump(); });
      }
    } while (changed);
  }

  function module_(def) {
    if (!def || !def.id || typeof def.init !== 'function') { warn('Core.module needs { id, init }'); return; }
    const m = slot(def.id);
    if (m.def) { warn('duplicate module id "' + def.id + '" ignored'); return; }
    m.def = def;
    if (cfg.get().off.includes(def.id)) { m.state = 'skipped'; dlog('disabled', def.id); settle(m); pump(); return; }
    if (!matches(def)) { m.state = 'skipped'; settle(m); pump(); return; }
    m.state = 'pending';
    pump();
  }
  const use = (id) => new Promise((res) => {
    const m = slot(id);
    if (m.state === 'ready') return res(m.api);
    if (m.state === 'skipped' || m.state === 'failed') return res(null);
    m.waiters.push(res);
  });
  const get = (id) => { const m = mods.get(id); return m && m.state === 'ready' ? m.api : undefined; };
  // Per-module helpers handed to init(Core, ctx): namespaced storage, floating-button registration, tagged logging.
  function ctxFor(d) {
    return {
      id: d.id,
      store: (ns, o) => store(d.id + ':' + ns, o),
      float: (def) => float.add(Object.assign({ id: d.id, title: d.name || d.id, icon: d.icon }, def)),
      log: (...a) => console.log('[' + d.id + ']', ...a),
    };
  }
  function status() {
    const rows = [...mods.entries()].map(([id, m]) => ({ id, state: m.state, deps: ((m.def && m.def.deps) || []).join(', ') }));
    console.table(rows); return rows;
  }

  ready.then(() => { domReady = true; pump(); });
  setTimeout(() => {
    const stuck = [...mods.entries()].filter(([, m]) => m.state === 'pending' || (m.state === 'absent' && m.waiters.length));
    if (stuck.length) warn('still waiting after 10s:', stuck.map(([id, m]) => id + (m.def && m.def.deps ? ' (needs ' + m.def.deps.join(', ') + ')' : '')).join('; '));
  }, 10000);

  /* ---------------------------------------------------------- floating --- */
  // THE one place floating buttons come from. Every addon that wants a button + panel calls
  // Core.float.add(). Core draws the button in the shared dock (auto-spaced, kept clear of the
  // site's own fixed buttons), owns the modal, and calls render()/onShow()/onHide() for you.
  //
  //   Core.float.add({
  //     id, title, icon, order,          identity + dock position (lower = further right)
  //     width,                           panel width in px (default 860)
  //     render(el, Core, api),           fill `el` with your UI. Runs every time the panel opens
  //     onShow(el), onHide(),            after render / when the panel closes
  //     onClick(),                       instead of render: a plain button with no panel
  //   }) -> { id, button, open, close, refresh, remove }
  const float = (() => {
    const items = new Map();   // id -> { def, modal, pane, ctl }

    function add(def) {
      if (!def || !def.id || (typeof def.render !== 'function' && typeof def.onClick !== 'function')) {
        warn('float.add needs { id, render } or { id, onClick }'); return null;
      }
      if (items.has(def.id)) { warn('duplicate float id "' + def.id + '" ignored'); return items.get(def.id).ctl; }
      const it = { def: Object.assign({ title: def.id, order: 100 }, def), modal: null, pane: null, ctl: null };
      const hasPanel = typeof def.render === 'function';

      function paint() {
        it.pane.replaceChildren();
        try { it.def.render(it.pane, Core, it.def.api); }
        catch (e) { it.pane.replaceChildren(h('div', { class: 'core-empty' }, '"' + it.def.title + '" failed: ' + e.message)); warn(e); }
        if (it.def.onShow) try { it.def.onShow(it.pane); } catch (e) { warn(e); }
      }
      function open() {
        if (!hasPanel) { it.def.onClick(); return null; }
        if (!it.modal) {
          it.pane = h('div', { class: 'core-float-pane' });
          it.modal = ui.modal({
            id: 'float:' + def.id, title: (it.def.icon ? it.def.icon + ' ' : '') + it.def.title, width: it.def.width || 860, body: it.pane,
            onOpen: paint,
            onClose: () => { if (it.def.onHide) try { it.def.onHide(); } catch (e) { warn(e); } },
          });
        }
        return it.modal.open();
      }
      const ctl = it.ctl = {
        id: def.id,
        button: ui.dock.add({ id: def.id, icon: it.def.icon, title: it.def.title, order: it.def.order, onClick: open }),
        open,
        close() { if (it.modal) it.modal.close(); },
        refresh() { if (it.modal && it.modal.isOpen) paint(); },
        remove() { if (it.modal) { it.modal.close(); it.modal.el.remove(); } ui.dock.remove(def.id); items.delete(def.id); },
      };
      items.set(def.id, it);
      return ctl;
    }
    const call = (id, fn) => { const it = items.get(id); if (it) return it.ctl[fn](); warn('no floating item "' + id + '"'); return null; };
    return {
      add,
      open: (id) => call(id, 'open'),
      close: (id) => call(id, 'close'),
      refresh: (id) => { const it = items.get(id); if (it) it.ctl.refresh(); },
      remove: (id) => { const it = items.get(id); if (it) it.ctl.remove(); },
      closeAll: () => items.forEach((it) => it.ctl.close()),
      get: (id) => (items.get(id) ? items.get(id).ctl : undefined),
      list: () => [...items.keys()],
    };
  })();

  /* ------------------------------------------------------ addon loader --- */
  // Addons are plain .js files at URLs. Sources: the manifest (CONFIG.manifest) plus
  // URLs added in the Addons tab. Code is cached in localStorage and run immediately from
  // cache; a background check refreshes it for next load (stale-while-revalidate).
  const rt = new Map();                         // id -> { state, from, bytes, err, update }
  const rstat = (id) => { let s = rt.get(id); if (!s) rt.set(id, s = { state: 'idle' }); return s; };
  const ck = (id) => 'core:code:' + id;

  // GitHub's "Copy raw file" button and the browser address bar for a file often give
  //   https://github.com/<user>/<repo>/raw/refs/heads/<branch>/<path>   (or /blob/<branch>/<path>)
  // Those are REDIRECTS, and the browser blocks them from another site (CORS). The real file host is
  //   https://raw.githubusercontent.com/<user>/<repo>/<branch>/<path>
  // so any github.com file link is rewritten to that form, wherever it is used.
  function normalizeUrl(u) {
    u = String(u || '').trim();
    const m = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/(?:raw|blob)\/([^?#]+)(?:[?#].*)?$/i.exec(u);
    return m ? 'https://raw.githubusercontent.com/' + m[1] + '/' + m[2] + '/' + m[3].replace(/^refs\/heads\//, '') : u;
  }
  const MANIFEST = normalizeUrl(CONFIG.manifest);
  let manifestEntries = [];

  const sha256hex = async (t) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, '0')).join('');

  async function fetchCode(e) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const res = await root.fetch(e.url, { cache: 'no-cache', signal: ctl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      if (e.sha256 && (await sha256hex(text)) !== String(e.sha256).toLowerCase()) throw new Error('sha256 mismatch \u2014 refusing to run');
      return text;
    } finally { clearTimeout(timer); }
  }
  function readAnyCode(e) { try { return JSON.parse(localStorage.getItem(ck(e.id)) || 'null'); } catch (_) { return null; } }
  function readCode(e) { try { const r = JSON.parse(localStorage.getItem(ck(e.id)) || 'null'); return r && r.url === e.url ? r : null; } catch (_) { return null; } }
  function writeCode(e, code) { try { localStorage.setItem(ck(e.id), JSON.stringify({ url: e.url, ver: e.version || '', code, ts: Date.now(), checked: Date.now() })); } catch (_) { warn('could not cache "' + e.id + '" (storage full?)'); } }

  function entries() {
    const byId = new Map();
    manifestEntries.forEach((e) => byId.set(e.id, Object.assign({ source: 'manifest' }, e)));
    cfg.get().custom.forEach((e) => byId.set(e.id, Object.assign({ source: 'custom' }, e, { url: normalizeUrl(e.url) })));   // custom id wins = local override
    return [...byId.values()];
  }
  function entryMatches(e) {
    if (!e.match) return true;
    const p = root.location.pathname + root.location.search;
    try { return [].concat(e.match).some((x) => new RegExp(x).test(p)); } catch (_) { return true; }
  }

  const updatedToast = (e) => ready.then(() => ui.toast('"' + (e.name || e.id) + '" updated \u2014 click here to reload', true, 12000, () => root.location.reload()));
  // Fetch the newest code in the background. It is saved for the NEXT load; the page keeps running what it has.
  const inflight = new Set();
  function refreshInBackground(e, rec) {
    if (inflight.has(e.id)) return Promise.resolve();
    inflight.add(e.id);
    const s = rstat(e.id);
    return fetchCode(e).then((t) => {
      if (!rec || t !== rec.code) { s.update = true; updatedToast(e); }
      writeCode(e, t);
    }).catch(() => {}).finally(() => inflight.delete(e.id));
  }
  async function prepare(e) {
    const s = rstat(e.id);
    // ANY saved copy (even one saved under a different URL) starts instantly: the page never waits on GitHub.
    const rec = !cfg.get().dev ? (readCode(e) || readAnyCode(e)) : null;
    if (rec && rec.code) {
      s.from = 'cache'; s.bytes = rec.code.length; s.ver = rec.ver || '';
      const stale = rec.url !== e.url || (e.version && rec.ver !== e.version) || Date.now() - (rec.checked || 0) > 60 * 1000;   // re-check on (almost) every load: a changed file is picked up without bumping the manifest version
      if (stale) refreshInBackground(e, rec);
      return rec.code;
    }
    s.from = 'net'; s.ver = e.version || '';
    const t = await fetchCode(e);          // nothing saved yet: the only case that has to wait
    s.bytes = t.length; writeCode(e, t);
    return t;
  }

  // The addon runs in page-global scope with `Core` in scope, so bare references to the
  // site's own globals (BATTLE_CFG, CURRENT_TEAM, PET_SIGIL_CSRF, ...) keep working.
  function runCode(code, e) {
    const body = code + '\n//# sourceURL=' + e.url;
    let fn = null;
    try { fn = new Function('Core', body); } catch (err) { if (err instanceof SyntaxError) throw err; /* CSP blocks eval -> inline fallback */ }
    if (fn) { fn(Core); return; }
    const s = document.createElement('script');
    s.textContent = '(function(Core){' + body + '\n})(window.Core);';
    (document.head || document.documentElement).appendChild(s);
    s.remove();
  }
  function exec(e, code) {
    const s = rstat(e.id);
    try { runCode(code, e); s.state = 'ok'; s.err = null; }
    catch (err) { s.state = 'error'; s.err = String((err && err.message) || err); warn('addon "' + e.id + '" threw', err); }
  }

  // Entry urls may be relative ("addons/x.js"): they resolve against the manifest's own URL.
  const resolveEntries = (j) => ((j && j.addons) || []).map((e) => Object.assign({}, e, { url: normalizeUrl(new URL(e.url, MANIFEST).href) }));

  async function loadManifest() {
    if (!MANIFEST || /YOU\/REPO/.test(MANIFEST)) return;
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem('core:manifest') || 'null'); } catch (_) { /* */ }
    const mctl = new AbortController(); setTimeout(() => mctl.abort(), 8000);
    const refresh = root.fetch(MANIFEST, { cache: 'no-cache', signal: mctl.signal }).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then((j) => { try { localStorage.setItem('core:manifest', JSON.stringify(j)); } catch (_) { /* */ } return j; });
    // Entry urls may be relative ("addons/x.js"): they resolve against the manifest's own URL,
    // so moving the repo means editing CONFIG.manifest only.
    const resolve = resolveEntries;
    if (cached) {
      manifestEntries = resolve(cached);
      refresh.then((j) => {
        if (JSON.stringify(j.addons) !== JSON.stringify(cached.addons)) ready.then(() => ui.toast('Addon list changed \u2014 reload to apply'));
        // A newer addon version in the manifest is fetched right now (no waiting for the 10-minute check).
        const off = new Set(cfg.get().off);
        resolve(j).forEach((e) => {
          const rec = readAnyCode(e);
          if (off.has(e.id) || !entryMatches(e) || cfg.get().dev) return;
          if (rec && rec.code && (rec.url !== e.url || !e.version || rec.ver !== e.version)) refreshInBackground(e, rec);
        });
      }).catch(() => {});
    } else {
      manifestEntries = resolve(await refresh);
    }
  }

  async function startOne(e) {
    const s = rstat(e.id);
    if (!entryMatches(e)) { s.state = 'skipped'; return; }
    s.state = 'loading';
    try { exec(e, await prepare(e)); } catch (err) { s.state = 'error'; s.err = String((err && err.message) || err); }
  }
  async function startAddons() {
    try { await loadManifest(); } catch (err) { warn('manifest failed', err); }
    const list = entries(), off = new Set(cfg.get().off);
    const jobs = list.map((e) => {
      const s = rstat(e.id);
      if (off.has(e.id)) { s.state = 'off'; return null; }
      if (!entryMatches(e)) { s.state = 'skipped'; return null; }
      s.state = 'loading';
      return prepare(e).catch((err) => { s.state = 'error'; s.err = String((err && err.message) || err); return null; });
    });
    for (let i = 0; i < list.length; i++) {      // fetch in parallel, execute in manifest order
      const code = jobs[i] ? await jobs[i] : null;
      if (code == null) continue;
      if (!list[i].early) await ready;
      exec(list[i], code);
    }
  }

  function addCustom(url) {
    url = normalizeUrl(url);
    if (!/^https?:\/\//i.test(url)) { ui.toast('Enter a full http(s) URL', false); return; }
    const id = url.split(/[?#]/)[0].split('/').pop().replace(/\.js$/i, '') || 'addon';
    const e = { id, name: id, url };
    cfg.update((c) => { c.custom = c.custom.filter((x) => x.id !== id); c.custom.push(e); c.off = c.off.filter((x) => x !== id); });
    startOne(Object.assign({ source: 'custom' }, e)).then(() => float.refresh('addons'));
    ui.toast('Added "' + id + '"');
    float.refresh('addons');
  }
  function removeCustom(id) {
    cfg.update((c) => { c.custom = c.custom.filter((x) => x.id !== id); });
    try { localStorage.removeItem(ck(id)); } catch (_) { /* */ }
    ui.toast('Removed "' + id + '" \u2014 reload to unload it');
    float.refresh('addons');
  }
  function setEnabled(id, on) {
    cfg.update((c) => { c.off = c.off.filter((x) => x !== id); if (!on) c.off.push(id); });
    const e = entries().find((x) => x.id === id), s = rstat(id);
    if (on && e && s.state === 'off') startOne(e).then(() => float.refresh('addons'));
    if (!on) ui.toast('"' + id + '" disabled \u2014 reload to fully unload it');
    float.refresh('addons');
  }
  // The automatic check that runs on every page load, on demand. Re-reads the manifest, fetches each
  // enabled addon and compares it with the saved copy: only a real difference counts as an update.
  // Updates are saved for the next load, exactly like the automatic ones. There is no separate
  // "clear cache": this does the same job and never says "update" when nothing changed.
  let checking = false;
  async function checkForUpdates() {
    if (checking) return;
    checking = true;
    ui.toast('Checking for updates\u2026', true, 1500);
    try {
      if (MANIFEST && !/YOU\/REPO/.test(MANIFEST)) {
        try {
          const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 8000);
          let j;
          try {
            const r = await root.fetch(MANIFEST, { cache: 'no-cache', signal: ctl.signal });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            j = await r.json();
          } finally { clearTimeout(timer); }
          try { localStorage.setItem('core:manifest', JSON.stringify(j)); } catch (_) { /* */ }
          manifestEntries = resolveEntries(j);
        } catch (err) { ui.toast('Could not reach the update list: ' + ((err && err.message) || err), false); return; }
      }
      const off = new Set(cfg.get().off);
      // Same scope as the automatic check: only enabled addons that apply to THIS page. One that doesn't match
      // here was never downloaded, so it can't be "updated" (it is refreshed on a page where it matches).
      const list = entries().filter((e) => !off.has(e.id) && entryMatches(e));
      let failed = 0;
      await Promise.all(list.map(async (e) => {
        try {
          const rec = readAnyCode(e), t = await fetchCode(e);
          if (rec && rec.code && rec.code !== t) rstat(e.id).update = true;   // no saved copy = nothing to update
          writeCode(e, t);
        } catch (_) { failed++; }
      }));
      // Core itself: the bootstrap saves a newer core.js for the next load, same as an addon.
      const boot = root.__coreBoot;
      if (boot) { try { await boot.check(); } catch (_) { failed++; } }
      const ready = [].concat(boot && boot.pending() ? ['Core'] : [], list.filter((e) => rstat(e.id).update).map((e) => e.name || e.id));
      const note = failed ? ' (' + failed + ' could not be checked)' : '';
      if (ready.length) ui.toast('Update ready: ' + ready.join(', ') + ' \u2014 click here to reload' + note, true, 12000, () => root.location.reload());
      else ui.toast('Everything is up to date' + note, !failed);
    } finally { checking = false; float.refresh('addons'); }
  }

  function renderAddonsTab(el) {
    const c = cfg.get();
    const rows = entries().map((e) => {
      const s = rstat(e.id);
      const cb = h('input', { type: 'checkbox', onchange: (ev) => setEnabled(e.id, ev.target.checked) });
      cb.checked = !c.off.includes(e.id);
      return h('div', { class: 'core-addon' }, cb,
        h('div', { class: 'core-addon-main' },
          h('div', { class: 'core-addon-name' }, e.name || e.id, h('span', { class: 'core-dim' }, '  ' + e.id + ((s.ver || e.version) ? ' v' + (s.ver || e.version) + (s.ver && e.version && s.ver !== e.version ? ' (v' + e.version + ' ready)' : '') : '') + ' \u00b7 ' + e.source)),
          h('div', { class: 'core-dim' }, e.url),
          s.err ? h('div', { class: 'core-err' }, s.err) : null),
        h('div', { class: 'core-addon-meta' },
          h('span', { class: 'core-pill core-pill-' + s.state }, s.state + (s.update ? ' \u00b7 update ready' : '')),
          s.from ? h('span', { class: 'core-dim' }, s.from + (s.bytes ? ' \u00b7 ' + Math.round(s.bytes / 1024) + ' KB' : '')) : null),
        e.source === 'custom' ? ui.btn('\ud83d\uddd1', 'danger', () => removeCustom(e.id)) : null);
    });
    const url = h('input', { class: 'core-input', placeholder: 'https://raw.githubusercontent.com/you/repo/main/addons/x.js', style: { flex: '1 1 320px' } });
    const dev = h('input', { type: 'checkbox', onchange: (ev) => cfg.update((x) => { x.dev = ev.target.checked; }) });
    dev.checked = !!c.dev;
    el.replaceChildren(
      h('div', { class: 'core-dim', style: { marginBottom: '12px' } }, 'Core v' + Core.version + (root.__coreBoot && root.__coreBoot.pending() && root.__coreBoot.readyVersion() ? ' (v' + root.__coreBoot.readyVersion() + ' ready)' : '') + '  \u00b7  Manifest: ' + (MANIFEST || '(none)')),
      ...rows.length ? rows : [h('div', { class: 'core-empty' }, 'No addons yet. Add a URL below or set CONFIG.manifest.')],
      h('div', { class: 'core-row', style: { marginTop: '16px' } }, url, ui.btn('Add by URL', 'success', () => { addCustom(url.value); url.value = ''; })),
      h('div', { class: 'core-row' },
        h('label', { class: 'core-dim' }, dev, ' Dev mode: always fetch fresh (for localhost / unpushed edits)'),
        h('div', { class: 'core-spacer' }),
        ui.btn('Check for updates', 'soft', checkForUpdates)));
  }
  // The addon manager is just another floating item - same system every addon uses.
  float.add({ id: 'addons', title: 'Addons', icon: '\u2699\ufe0f', order: 900, width: 900, render: renderAddonsTab });

  /* ------------------------------------------------------------ export --- */
  const Core = {
    __isCore: true, apiLevel: API, version: '3.5.1', debug: false, tabId: TAB,
    esc, sleep, debounce, fmt, int, compact, parseJson,
    on, off, once, emit,
    state, store, player,
    net, pages, dom, cookies, ui,
    module: module_, use, get, status,
    float, addons: { list: entries, add: addCustom, remove: removeCustom, enable: setEnabled, status: rt, reload: startOne },
  };
  root.Core = Core;
  dlog('core ready', Core.version);

  startAddons();
})(window);
