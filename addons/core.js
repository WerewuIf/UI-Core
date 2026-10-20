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
 *   Core.potions.{stamina,hp,use,find}  (one shared, coordinated potion user: sidebar first, inventory as fallback)
 *   Core.me.get() (stamina, gold, gems, level, exp, server clock) · Core.me.apply / addExp / fromAttack / ingest / sync (feed it newer numbers) · Core.clock (server time zone: weekday, is('mon'), isAfter('14:30'), at(...))
 *   Core.auth.{check,pageState,isSignedOut,ensure,login,register,setCredentials,status}  session check + automatic sign-back-in
 *   Core.compact(n) -> "3.3B" · Core.parseNum("3.3B") -> 3300000000
 * Full reference with examples: REFERENCE.md in the repo.
 * ========================================================================== */
(function (root) {
  'use strict';

  // >>> Raw URL of addons.json
  const CONFIG = { manifest: 'https://raw.githubusercontent.com/WerewuIf/UI-Core/main/addons.json' };

  const API = 4;   // 4: Core.auth.  3: Core.potions, Core.me.apply / addExp / fromAttack / ingest / sync
  if (root.Core && root.Core.__isCore) {
    if (root.Core.apiLevel < API) console.warn('[Core] an older core (api ' + root.Core.apiLevel + ') is already loaded; this script wants ' + API + '.');
    return;
  }

  const TAB = Math.random().toString(36).slice(2);
  const warn = (...a) => console.warn('[Core]', ...a);
  const dlog = (...a) => { if (Core.debug) console.log('[Core]', ...a); };

  // Turns a ".../main/..." raw.githubusercontent.com URL into the newest commit's immutable URL, so GitHub's CDN
  // (cache-control: max-age=300; a ?query does NOT bypass it) cannot answer with an old copy. It costs one GitHub API
  // call (60 per hour per IP when not logged in), so only a manual "Check for updates" asks for it (fresh = true);
  // automatic checks keep the plain branch URL (at most ~5 minutes old). If the lookup fails, the plain URL is used and
  // window.__coreShaError says why, so the update check can report it instead of claiming "up to date".
  let shaJob = null, shaAt = 0;
  function latestSha() {
    if (shaJob && Date.now() - shaAt < 10000) return shaJob;   // one lookup is shared by everything in the same check
    shaAt = Date.now();
    const job = root.fetch('https://api.github.com/repos/WerewuIf/UI-Core/commits/main', { headers: { Accept: 'application/vnd.github.sha' }, cache: 'no-cache' })
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 403 || r.status === 429 ? 'GitHub is rate-limiting update lookups (60 per hour per IP)' : 'GitHub API HTTP ' + r.status);
        const sha = (await r.text()).trim();
        if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('unexpected reply from the GitHub API');
        return sha;
      });
    job.catch(() => { if (shaJob === job) shaJob = null; });   // a failed lookup is never reused
    return (shaJob = job);
  }
  async function pinned(url, fresh) {
    if (!fresh) return url;
    try {
      const sha = await latestSha();
      root.__coreShaError = null;
      return url.replace(/(raw\.githubusercontent\.com\/WerewuIf\/UI-Core\/)(?:refs\/heads\/)?main\//, '$1' + sha + '/');
    } catch (err) { root.__coreShaError = String((err && err.message) || err); return url; }
  }

  /* ------------------------------------------------------------- utils --- */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const fmt = (n) => Number(n || 0).toLocaleString();
  const int = (s) => parseInt(String(s ?? '').replace(/[^\d-]/g, ''), 10) || 0;
  // Short number: 3303348038 -> "3.3B", 3100000 -> "3.1M", 12345 -> "12.3K". Max 3 significant digits
  // (2 decimals under 10, 1 under 100, none from 100), trailing zeros dropped, K/M/B/T.
  //   o.min  smallest size that gets abbreviated (default 1e3). Below it you get the plain rounded number with
  //          thousands separators, e.g. compact(2279, { min: 1e6 }) -> "2,279".
  // Rounding that reaches the next unit moves up to it: 999950 -> "1M" (not "1000K").
  const SUFFIXES = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  function compact(n, o) {
    n = Number(n) || 0;
    if (!isFinite(n)) return String(n);
    const a = Math.abs(n), min = o && o.min != null ? o.min : 1e3;
    if (a < 1e3 || a < min) return Math.round(n).toLocaleString();
    const scale = (lim) => { const v = a / lim; return Number(v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)); };
    for (let i = 0; i < SUFFIXES.length; i++) {
      if (a < SUFFIXES[i][0]) continue;
      let r = scale(SUFFIXES[i][0]), s = SUFFIXES[i][1];
      if (r >= 1000 && i > 0) { r = scale(SUFFIXES[i - 1][0]); s = SUFFIXES[i - 1][1]; }
      return (n < 0 ? '-' : '') + r + s;
    }
    return String(Math.round(n));
  }
  // The reverse: "3303348.038K" -> 3303348038, "3.3B" -> 3300000000, "2,345" -> 2345. 0 when there is no number.
  // A suffix only counts when it is not the start of a word ("5 bars" is 5, not 5B).
  const PARSE_MULT = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
  function parseNum(x) {
    const m = /(\d[\d.,]*|\.\d+)\s*([KMBT])?(?![A-Za-z])/i.exec(String(x ?? ''));
    return m ? (Math.round(parseFloat(m[1].replace(/,/g, '')) * (PARSE_MULT[(m[2] || '').toUpperCase()] || 1)) || 0) : 0;
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
    // Who am I: { id, name, level, avatar } read from the sidebar block (.small-user); level falls back to the top bar.
    // id is null when unknown; name / level / avatar are null on pages without the sidebar. avatar is an absolute URL.
    info() {
      const box = document.querySelector('.side-drawer .small-user');
      const txt = (sel) => { const e = box && box.querySelector(sel); return e ? e.textContent.trim() : ''; };
      const lv = parseInt((txt('.small-level') || (document.querySelector('.gtb-level') || {}).textContent || '').replace(/[^\d]/g, ''), 10);
      const img = box && box.querySelector('.small-ava img');
      const id = player.id();
      return { id: id === 'default' ? null : id, name: txt('.small-name') || null, level: lv || null, avatar: (img && img.src) || null };
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
      entry.p.then((text) => { textHooks.forEach((fn) => { try { fn(href, text, entry.ts); } catch (e) { warn('onText hook threw', e); } }); }, () => { if (cache.get(key) === entry) cache.delete(key); });
      return entry.p;
    }
    // Everything fetched for real over the network (never a cache hit) is shown to these listeners: fn(href, text, startedAtMs).
    // Core.me uses it to learn the player's numbers from any page that was just fetched, so a fresh fetch beats a stale page.
    const textHooks = [];
    const onText = (fn) => { textHooks.push(fn); return () => { const i = textHooks.indexOf(fn); if (i >= 0) textHooks.splice(i, 1); }; };
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
    invalidateOn(/\/use_item\.php|\/user_heal_potion\.php/, [/\/inventory\.php/, /\/stats\.php/]);
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

    // The ONE global Core touches: window.fetch, so it can see the SITE's own POSTs (to forget stale cached pages and to learn new
    // stamina). It is a Proxy, so the function still looks and behaves like the browser's (name, length, toString, `this`), the
    // request itself is passed through untouched (same headers, referrer, credentials, mode) and the page gets the very same promise back.
    // Nothing is looked at unless the request is to THIS site AND matches a watch() / invalidateOn() pattern: another userscript's
    // traffic, third-party calls and everything else never has its URL kept, its body read or an event fired for it.
    // Honest limit: any wrapper shows up as the "initiator" frame in DevTools' Network tab for every fetch; to avoid even that,
    // set localStorage['core:nohook'] = '1' (then watch / invalidateOn rules stay silent and Core.me relies on its own fetches).
    const interested = (href) => rules.some((r) => r.when.test(href)) || watchers.some((w) => w.re.test(href));
    function observe(input, init, p) {
      let url = typeof input === 'string' ? input : (input && input.url) || String(input), u;
      try { u = new URL(url, root.location.href); } catch (_) { return; }
      if (u.origin !== root.location.origin || !interested(u.href)) return;
      const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      const body = init && typeof init.body === 'string' ? init.body : null;
      p.then((res) => { try { onResponse(u.href, method, body, res); } catch (e) { warn(e); } }, () => {});
    }
    let noHook = false; try { noHook = !!root.localStorage.getItem('core:nohook'); } catch (_) { /* storage blocked: hook as usual */ }
    if (root.fetch && !root.__coreFetchHooked && !noHook) {
      root.__coreFetchHooked = true;
      root.fetch = new Proxy(root.fetch, {
        apply(target, thisArg, args) {
          const p = Reflect.apply(target, thisArg, args);   // exactly what the page asked for, returned as-is
          try { observe(args[0], args[1], p); } catch (_) { /* never break anyone's own fetch */ }
          return p;
        },
      });
    }

    return { fetchText, fetchDoc, fetchJson, post, invalidate, invalidateOn, watch, onText, parseJson, get cacheSize() { return cache.size; } };
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
      .core-modal{position:fixed;inset:0;background:rgba(6,10,18,.86);display:none;align-items:center;justify-content:center;padding:20px}
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
      .core-dock-btn,.core-btn,.core-close,.core-menu-item{margin:0}
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
      .core-addon.core-placeholder{opacity:.35;border-style:dashed;border-color:rgba(110,168,255,.6)}
      .core-ghost{position:fixed;z-index:2147483002;margin:0 !important;box-sizing:border-box;pointer-events:none;will-change:transform;transform:scale(1.015);
        background:#17213a;border-color:rgba(110,168,255,.55);box-shadow:0 16px 34px rgba(0,0,0,.55)}
      html.core-dragging .core-modal,html.core-dragging .core-modal *{cursor:grabbing !important;user-select:none !important;-webkit-user-select:none !important}
      .core-addon-ico{flex:0 0 auto;width:38px;height:38px;display:flex;align-items:center;justify-content:center;font-size:19px;
        background:#24263a;border:1px solid #2f324d;border-radius:11px}
      .core-addon-ico.none{background:none;border:1px dashed rgba(255,255,255,.18);color:#6d7aa3;font-size:15px}
      .core-grip{flex:0 0 auto;width:32px;height:36px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;
        border-radius:9px;cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none;outline:none}
      .core-grip i{display:block;width:16px;height:2px;border-radius:2px;background:#7f8ab8;transition:background .12s}
      .core-grip:hover{background:rgba(255,255,255,.07)}
      .core-grip:hover i,.core-grip:focus-visible i{background:#fff}
      .core-grip:focus-visible{box-shadow:0 0 0 2px rgba(110,168,255,.55)}
      .core-order{margin:0 0 16px}
      .core-order-btns{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px}
      .core-order-chip{display:inline-flex;align-items:center;justify-content:center;min-width:40px;padding:8px 10px;background:#24263a;border:1px solid #2f324d;border-radius:12px;box-shadow:0 4px 10px rgba(0,0,0,.35);font-size:16px;line-height:1.2;cursor:default;transition:transform .12s}
      .core-order-chip:hover{transform:translateY(-1px)}
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
      // Click-outside closes only if the press STARTED on the backdrop too. Selecting text by dragging out of a field
      // and releasing over the backdrop fires a click on the backdrop (common ancestor) and used to close the dialog.
      let downOnBackdrop = false;
      el.addEventListener('pointerdown', (e) => { downOnBackdrop = e.target === el; });
      el.addEventListener('click', (e) => { if (e.target === el && downOnBackdrop) m.close(); });
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

    let menuEl = null, menuFor = null, menuPinned = false, menuHideT = 0;
    function closeMenu() {
      clearTimeout(menuHideT); menuPinned = false;
      if (menuEl) menuEl.classList.remove('open');
      if (menuFor) menuFor.removeAttribute('data-core-menu-anchor');
      menuFor = null;
    }
    function showMenu(anchor, items) {
      if (!menuEl) {
        menuEl = h('div', { class: 'core-menu' }); document.body.appendChild(menuEl);
        // hover menus: the pointer can travel from the anchor onto the menu without it closing
        menuEl.addEventListener('mouseenter', () => clearTimeout(menuHideT));
        menuEl.addEventListener('mouseleave', () => armMenuHide());
      }
      menuFor = anchor; anchor.setAttribute('data-core-menu-anchor', '');
      menuEl.replaceChildren(...items.map((it) => h('button', { class: 'core-menu-item' + (it.danger ? ' danger' : ''), type: 'button', onclick: (e) => { e.stopPropagation(); closeMenu(); it.onClick(); } }, it.label)));
      const r = anchor.getBoundingClientRect();
      Object.assign(menuEl.style, { top: (r.bottom + 6) + 'px', right: (root.innerWidth - r.right) + 'px', left: 'auto' });
      menuEl.classList.add('open');
    }
    // ui.menu(anchorEl, [{label, onClick, danger}]) — toggles a dropdown under anchorEl.
    function menu(anchor, items) {
      base();
      const same = menuEl && menuEl.classList.contains('open') && menuFor === anchor;
      closeMenu();
      if (same) return;
      showMenu(anchor, items);
    }
    // Closes shortly after the pointer has left both the anchor and the menu. A menu opened by a click stays until
    // you pick, click away or press Esc.
    function armMenuHide() {
      clearTimeout(menuHideT);
      menuHideT = setTimeout(() => {
        if (menuPinned || !menuEl || !menuFor) return;
        if (menuFor.matches(':hover') || menuEl.matches(':hover')) return;
        closeMenu();
      }, 220);
    }
    // ui.hoverMenu(anchorEl, items | () => items) — like ui.menu, but a mouse only has to hover the anchor to open it.
    // A click (the way touch screens use it) opens it and keeps it open; clicking again closes it.
    function hoverMenu(anchor, items) {
      const get = () => (typeof items === 'function' ? items() : items);
      const isOpen = () => !!(menuEl && menuEl.classList.contains('open') && menuFor === anchor);
      if (root.matchMedia && root.matchMedia('(hover: hover)').matches) {
        anchor.addEventListener('mouseenter', () => { clearTimeout(menuHideT); if (!isOpen()) { base(); closeMenu(); showMenu(anchor, get()); } });
        anchor.addEventListener('mouseleave', () => armMenuHide());
      }
      anchor.addEventListener('click', (e) => {
        e.stopPropagation(); base();
        if (isOpen() && menuPinned) { closeMenu(); return; }
        if (!isOpen()) { closeMenu(); showMenu(anchor, get()); }
        menuPinned = true;
      });
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
    // Position in the row = rank, lower = closer to the corner (the row is drawn right-to-left). By default the rank
    // is the button's own `order`; setRank(fn(id, order) -> number) lets the user's saved arrangement override it.
    let rankFn = null;
    const rankOf = (i) => (rankFn ? rankFn(i.id, i.order) : i.order);
    const dockSorted = () => { const r = new Map(dockItems.map((i) => [i, rankOf(i)])); return dockItems.slice().sort((a, c) => r.get(a) - r.get(c)); };
    const dock = {
      // ui.dock.add({ id, icon, title, onClick, order }) -> button element
      add(o) {
        base();
        const b = h('button', { class: 'core-dock-btn', type: 'button', title: o.title || '', 'data-dock-id': o.id, onclick: o.onClick }, o.icon || '\u2022');
        dockItems.push({ id: o.id, order: o.order ?? 100, icon: o.icon || '\u2022', title: o.title || o.id, el: b });
        ready.then(() => {
          if (!dockEl) { dockEl = h('div', { id: 'core-dock' }); document.body.appendChild(dockEl); root.addEventListener('resize', placeDock); }
          dockEl.replaceChildren(...dockSorted().map((i) => i.el));
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
      // Re-sort the row after the arrangement changed.
      refresh() {
        if (!dockEl) return;
        dockEl.replaceChildren(...dockSorted().map((i) => i.el));
        placeDock();
      },
      setRank(fn) { rankFn = typeof fn === 'function' ? fn : null; dock.refresh(); },
      // The buttons now in the row, in on-screen order, LEFT to RIGHT: [{ id, icon, title, el }]
      items() { return dockSorted().reverse().map((i) => ({ id: i.id, icon: i.icon, title: i.title, el: i.el })); },
    };

    return { css, h, btn, toast, modal, menu, hoverMenu, dock };
  })();

  /* ----------------------------------------------------------- modules --- */
  // Core.module({ id, match, deps, early, float, init(Core) })   (optional: plain-script addons don't need it)
  //   match  RegExp (tested on path+query) | string | string[] | fn(location); default: everywhere
  //   deps   module ids that must be READY before init (hard dependency)
  //   early  run at load time instead of waiting for DOMContentLoaded
  //   init   may be async; whatever it returns becomes the module's public api (Core.use / Core.get)
  const mods = new Map();   // id -> { def, state, api, waiters }
  // Shared by the module system and the addon loader: user addons and disabled ids.
  // order: the ids in the order the user arranged them in the Addons panel, top to bottom = the dock's buttons left to right (orderV 2).
  const cfg = store('addons', { def: { custom: [], off: [], order: [], orderV: 2 }, key: 'core:addons' });
  // Which addons have a dock button, and what it looks like, remembered across pages. An addon that is SKIPPED on this page never runs
  // here, so it cannot show its button; without this its place in the list moved from page to page. An addon is known to have a button when
  //   1. its button is on the dock right now, or
  //   2. its entry says so: "button": true | false in addons.json (the author knows; this is the only source for an addon Core never ran), or
  //   3. its button was seen on an earlier page (remembered here, with its icon, title and order).
  // Anything else is treated as "no button" (listed last) until its button is seen once.
  const btnMemo = store('addon-btn', { def: {}, key: 'core:addon-btn' });
  function learnButton(def) {
    if (!def || !def.id || def.id === 'addons') return;
    const m = btnMemo.get() || {}, icon = typeof def.icon === 'string' ? def.icon : '', title = def.title || def.id, order = typeof def.order === 'number' ? def.order : 100, c = m[def.id];
    if (c && c.icon === icon && c.title === title && c.order === order) return;
    m[def.id] = { icon, title, order }; btnMemo.set(m);
  }

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
      learnButton(it.def);
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

  async function fetchCode(e, fresh) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const res = await root.fetch(await pinned(e.url, fresh), { cache: 'no-cache', signal: ctl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      if (e.sha256 && (await sha256hex(text)) !== String(e.sha256).toLowerCase()) throw new Error('sha256 mismatch \u2014 refusing to run');
      return text;
    } finally { clearTimeout(timer); }
  }
  function readAnyCode(e) { try { return JSON.parse(localStorage.getItem(ck(e.id)) || 'null'); } catch (_) { return null; } }
  function readCode(e) { try { const r = JSON.parse(localStorage.getItem(ck(e.id)) || 'null'); return r && r.url === e.url ? r : null; } catch (_) { return null; } }
  // true when the copy was really saved. (A failed write used to be swallowed: the "updated" toast fired anyway, the reload ran the
  // old code again, and nothing said why.) `ver` is the label shown in the Addons panel; it is the manifest's version unless told otherwise.
  function writeCode(e, code, ver) {
    try { localStorage.setItem(ck(e.id), JSON.stringify({ url: e.url, ver: ver !== undefined ? ver : (e.version || ''), code, ts: Date.now(), checked: Date.now() })); return true; }
    catch (err) { warn('could not cache "' + e.id + '" (' + ((err && err.name) || 'storage full') + '): the update is NOT saved'); return false; }
  }
  // Identifies exactly which text is RUNNING right now (the saved copy can already be newer than that).
  function codeHash(t) { let h = 2166136261; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16) + ':' + t.length; }

  function entries() {
    const byId = new Map();
    manifestEntries.forEach((e) => byId.set(e.id, Object.assign({ source: 'manifest' }, e)));
    cfg.get().custom.forEach((e) => byId.set(e.id, Object.assign({ source: 'custom' }, e, { url: normalizeUrl(e.url) })));   // custom id wins = override
    return [...byId.values()];
  }
  function entryMatches(e) {
    if (!e.match) return true;
    const p = root.location.pathname + root.location.search;
    try { return [].concat(e.match).some((x) => new RegExp(x).test(p)); } catch (_) { return true; }
  }

  const updatedToast = (e) => ready.then(() => ui.toast('"' + (e.name || e.id) + '" updated \u2014 click here to reload', true, 12000, () => root.location.reload()));
  // Fetch the newest code in the background. It is saved for the NEXT load; the page keeps running what it has.
  // FIX: a second ask for the same addon used to be DROPPED while the first was still downloading. That lost the one that
  // mattered: the load starts a plain check using the OLD saved manifest entry, then the new manifest arrives (version bumped)
  // and asks again, but that ask was thrown away, so the update only turned up one or two reloads later. It now waits its turn.
  const inflight = new Set(), queued = new Map();
  // An addon that is SKIPPED on this page is refreshed the same way, but quietly: nothing is running it, so there is nothing to reload.
  // It is saved so that the page it belongs to starts on the newest copy, and the Addons panel shows the saved version.
  function refreshInBackground(e, rec) {
    if (inflight.has(e.id)) { queued.set(e.id, e); return Promise.resolve(); }
    inflight.add(e.id);
    const s = rstat(e.id), quiet = !entryMatches(e);
    return fetchCode(e).then(async (t) => {
      let ver = e.version || '';
      // The manifest names a newer version but the file came back unchanged: GitHub's CDN copy (up to 5 min old) is the usual reason.
      // Ask for the newest commit's own URL before believing it, and do not label the old code with the new version meanwhile.
      if (rec && rec.code === t && e.version && rec.ver !== e.version) {
        try { t = await fetchCode(e, true); } catch (_) { /* keep t */ }
        if (rec.code === t && root.__coreShaError) ver = rec.ver;   // could not confirm: stay honest, ask again next load
      }
      const differs = s.ran ? codeHash(t) !== s.ran : !!(!rec || t !== rec.code);
      const saved = writeCode(e, t, ver);
      if (quiet) { if (saved) { s.from = 'cache'; s.bytes = t.length; s.ver = ver; } return; }
      if (differs && saved) { s.update = true; updatedToast(e); }
      else if (differs) ready.then(() => ui.toast('"' + (e.name || e.id) + '" has an update, but this site\u2019s browser storage is full, so it could not be saved', false, 12000));
    }).catch((err) => { warn('background update of "' + e.id + '" failed:', (err && err.message) || err); }).finally(() => {
      inflight.delete(e.id);
      const q = queued.get(e.id);
      if (q) { queued.delete(e.id); refreshInBackground(q, readAnyCode(q)); }   // runs with the copy the first one just saved
    });
  }
  async function prepare(e) {
    const s = rstat(e.id);
    // ANY saved copy (even one saved under a different URL) starts instantly: the page never waits on GitHub.
    const rec = readCode(e) || readAnyCode(e);
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
    s.ran = codeHash(code);
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
    const refresh = pinned(MANIFEST).then((u) => root.fetch(u, { cache: 'no-cache', signal: mctl.signal })).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then((j) => { try { localStorage.setItem('core:manifest', JSON.stringify(j)); } catch (_) { /* */ } return j; });
    // Entry urls may be relative ("addons/x.js"): they resolve against the manifest's own URL,
    // so moving the repo means editing CONFIG.manifest only.
    const resolve = resolveEntries;
    if (cached) {
      manifestEntries = resolve(cached);
      refresh.then((j) => {
        // FIX: only a real change to the list (added / removed / renamed / moved / re-matched) says "reload to apply". A version bump
        // alone used to trigger it too, which sent people to reload before anything had been downloaded.
        const shape = (a) => JSON.stringify((a || []).map((x) => { const c = Object.assign({}, x); delete c.version; delete c.button; return c; }));
        if (shape(j.addons) !== shape(cached.addons)) ready.then(() => ui.toast('Addon list changed \u2014 reload to apply'));
        // A newer addon version in the manifest is fetched right now (no waiting for the 10-minute check).
        const off = new Set(cfg.get().off);
        resolve(j).forEach((e) => {
          const rec = readAnyCode(e);
          if (off.has(e.id)) return;
          // running here: refresh on any doubt. Skipped here: only when the manifest names a different version or URL than the saved copy has
          // (the age-based re-check of skipped addons is keepSkippedFresh).
          const doubt = rec && rec.code && (rec.url !== e.url || (e.version ? rec.ver !== e.version : entryMatches(e)));
          if (doubt) refreshInBackground(e, rec);
        });
      }).catch(() => {});
    } else {
      manifestEntries = resolve(await refresh);
    }
  }

  // What the Addons panel shows for an addon that is not running on this page: the copy that is saved for the page it belongs to.
  function noteSaved(e) {
    const s = rstat(e.id), rec = readAnyCode(e);
    if (rec && rec.code) { s.from = 'cache'; s.bytes = rec.code.length; s.ver = rec.ver || ''; }
    else { s.from = 'not saved yet'; s.bytes = 0; }
  }
  // Skipped addons are never run or downloaded for nothing, but one that has been saved before is kept current: a new version in the
  // manifest refreshes it at once, and otherwise it is re-checked at most every 30 minutes. So the page it belongs to starts on the
  // newest copy instead of toasting "updated" right after it opens.
  const SKIP_RECHECK = 30 * 60 * 1000;
  function keepSkippedFresh(list) {
    const off = new Set(cfg.get().off);
    list.forEach((e) => {
      if (off.has(e.id) || entryMatches(e)) return;
      const rec = readAnyCode(e);
      if (!rec || !rec.code) return;                          // never used in this browser: nothing to keep current
      if (rec.url !== e.url || (e.version && rec.ver !== e.version) || Date.now() - (rec.checked || 0) > SKIP_RECHECK) refreshInBackground(e, rec);
    });
  }
  async function startOne(e) {
    const s = rstat(e.id);
    if (!entryMatches(e)) { s.state = 'skipped'; noteSaved(e); return; }
    s.state = 'loading';
    try { exec(e, await prepare(e)); } catch (err) { s.state = 'error'; s.err = String((err && err.message) || err); }
  }
  async function startAddons() {
    try { await loadManifest(); } catch (err) { warn('manifest failed', err); }
    const list = entries(), off = new Set(cfg.get().off);
    const jobs = list.map((e) => {
      const s = rstat(e.id);
      if (off.has(e.id)) { s.state = 'off'; return null; }
      if (!entryMatches(e)) { s.state = 'skipped'; noteSaved(e); return null; }
      s.state = 'loading';
      return prepare(e).catch((err) => { s.state = 'error'; s.err = String((err && err.message) || err); return null; });
    });
    keepSkippedFresh(list);
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
            const r = await root.fetch(await pinned(MANIFEST, true), { cache: 'no-cache', signal: ctl.signal });
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
      const all = entries().filter((e) => !off.has(e.id)), list = all.filter(entryMatches);
      // Addons that belong to other pages are checked too (only if a copy is saved; one never used here is not downloaded for nothing).
      // They are refreshed quietly: nothing is running them, so they never ask for a reload.
      const others = all.filter((e) => !entryMatches(e) && (readAnyCode(e) || {}).code);
      let failed = 0, unsaved = 0;
      const refreshedOthers = [];
      await Promise.all(others.map(async (e) => {
        try {
          const rec = readAnyCode(e), t = await fetchCode(e, true), s = rstat(e.id);
          if (writeCode(e, t)) { s.from = 'cache'; s.bytes = t.length; s.ver = e.version || ''; if (!rec || rec.code !== t) refreshedOthers.push(e.name || e.id); }
          else unsaved++;
        } catch (err) { failed++; warn('update check of "' + e.id + '" failed:', (err && err.message) || err); }
      }));
      await Promise.all(list.map(async (e) => {
        try {
          const rec = readAnyCode(e), s = rstat(e.id), t = await fetchCode(e, true);
          // "ready" = what is RUNNING differs from the newest file. (Comparing with the saved copy said "up to date" while the page
          // still ran old code whenever a background refresh had already saved the new file.) No saved copy and nothing running = nothing to update.
          if (s.ran ? codeHash(t) !== s.ran : !!(rec && rec.code && rec.code !== t)) s.update = true;
          if (!writeCode(e, t)) unsaved++;
        } catch (err) { failed++; warn('update check of "' + e.id + '" failed:', (err && err.message) || err); }
      }));
      // Core itself: the bootstrap saves a newer core.js for the next load, same as an addon.
      const boot = root.__coreBoot;
      if (boot) { try { await boot.check(true); } catch (_) { failed++; } }
      const ready = [].concat(boot && boot.pending() ? ['Core'] : [], list.filter((e) => rstat(e.id).update).map((e) => e.name || e.id));
      const note = (failed ? ' (' + failed + ' could not be checked)' : '') + (unsaved ? ' (' + unsaved + ' could not be saved: this site\u2019s browser storage is full)' : '')
        + (refreshedOthers.length ? ' \u2014 ' + refreshedOthers.join(', ') + ' refreshed for ' + (refreshedOthers.length > 1 ? 'their own pages' : 'its own page') : '');
      // If GitHub would not name the newest commit, what was fetched may be a CDN copy up to 5 minutes old: say so.
      const lag = root.__coreShaError ? ' \u2014 ' + root.__coreShaError + ', so this may be up to 5 minutes behind' : '';
      if (ready.length) ui.toast('Update ready: ' + ready.join(', ') + ' \u2014 click here to reload' + note + lag, true, 12000, () => root.location.reload());
      else if (lag) ui.toast('Could not confirm you are up to date' + lag + note, false, 12000);
      else ui.toast('Everything is up to date' + note, !failed && !unsaved);
    } finally { checking = false; float.refresh('addons'); }
  }

  // ---- order ----
  // The Addons panel lists addons in the order of the buttons on screen: the TOP of the list is the LEFT-most button.
  // The Addons button (\u2699\ufe0f) always stays at the far left, ahead of the list. cfg.order holds the ids in list order
  // (cfg.orderV = 2). Orders saved by an earlier version (top = nearest the right corner, no orderV) are read back reversed,
  // so nothing moves on screen.
  const savedOrder = () => { const c = cfg.get(), o = Array.isArray(c.order) ? c.order : []; return c.orderV === 2 ? o : o.slice().reverse(); };
  const declared = (e) => (typeof e.button === 'boolean' ? e.button : null);
  const buttonMemo = (e) => (btnMemo.get() || {})[e.id] || null;
  function hasButton(e) {
    if (ui.dock.items().some((b) => b.id === e.id)) return true;
    const d = declared(e);
    return d != null ? d : !!buttonMemo(e);
  }
  function orderedEntries() {
    const es = entries(), byId = new Map(es.map((e) => [e.id, e]));
    const out = savedOrder().filter((id) => byId.has(id)).map((id) => byId.get(id)), seen = new Set(out.map((e) => e.id));
    // not arranged yet: addons with a button follow the dock's built-in order (higher `order` = further left = higher in the list),
    // which every page agrees on because it comes from what was remembered, not from what happens to be running here; then the rest as listed
    const rest = es.filter((e) => !seen.has(e.id));
    // Its remembered order; else the "order" the manifest entry gives (the same number the addon passes to Core.float.add); else last among
    // the button addons until its button has been seen once (so a brand-new button addon never jumps in front of the ones you arranged).
    const ord = (e) => { const m = buttonMemo(e); return m && typeof m.order === 'number' ? m.order : typeof e.order === 'number' ? e.order : -Infinity; };
    const all = out.concat(rest.filter(hasButton).sort((a, c) => ord(c) - ord(a)), rest.filter((e) => !hasButton(e)));
    // An addon with NO button has no place in the dock to arrange, so it is listed after every addon that has one (new or old, arranged or
    // not), whether it is running, skipped on this page, off or still loading. Only whether it HAS a button decides.
    return all.filter(hasButton).concat(all.filter((e) => !hasButton(e)));
  }
  // How a dock button REALLY looks right now, as copies of what is inside it. Most are just an emoji, but some put something live in
  // their button (the Stat Builder shows its unspent-points badge), which used to be listed as the placeholder "\u2022". Ids are
  // stripped from the copies so the page never gets a duplicate id.
  function dockIcon(b) {
    const kids = [...b.el.childNodes].map((n) => {
      const c = n.cloneNode(true);
      if (c.nodeType === 1) [c, ...c.querySelectorAll('[id]')].forEach((x) => x.removeAttribute('id'));
      return c;
    });
    return kids.length ? kids : [b.icon];
  }
  function saveOrder(ids) { cfg.update((c) => { c.order = ids; c.orderV = 2; }); float.refresh('addons'); }
  function nudgeAddon(id, d) {
    const ids = orderedEntries().map((e) => e.id), i = ids.indexOf(id), j = i + d;
    if (i < 0 || j < 0 || j >= ids.length) return;
    ids.splice(j, 0, ids.splice(i, 1)[0]);
    saveOrder(ids);
  }
  // Dock rank of a button (lower = nearer the corner, i.e. further right). Arranged buttons: first in the list = highest
  // rank = left-most. Buttons not arranged yet keep their built-in rank, which is lower than any arranged one, so they sit to
  // the right of them. The Addons button is always left-most.
  const dockRank = (id, dflt) => {
    if (id === 'addons') return 1e9;
    const k = savedOrder().indexOf(id);
    return k >= 0 ? 1e6 - k : dflt;
  };
  ui.dock.setRank(dockRank);
  cfg.watch(() => ui.dock.refresh());   // also fires when another tab rearranges

  // Drag a row by its grip (two bars, right side). A ghost copy follows the pointer while the real row stays behind as
  // a dashed placeholder that slides to where it would land; letting go drops it there. Works with mouse, pen and
  // touch (pointer events). Esc cancels. The grip also takes the Up / Down arrow keys.
  function startRowDrag(ev, row, pane) {
    const rows = () => [...pane.querySelectorAll('.core-addon')];
    const startIds = rows().map((r) => r.getAttribute('data-id'));
    const rect = row.getBoundingClientRect(), grab = ev.clientY - rect.top;
    const scroller = row.closest('.core-modal-card');
    const ghost = row.cloneNode(true);
    ghost.classList.add('core-ghost');
    ghost.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
    Object.assign(ghost.style, { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px' });
    document.body.appendChild(ghost);
    row.classList.add('core-placeholder');
    document.documentElement.classList.add('core-dragging');
    let y = ev.clientY, scrollV = 0, ended = false;

    // slide the other rows smoothly to their new places when the placeholder moves
    function flip(move) {
      const others = rows().filter((r) => r !== row), before = others.map((r) => r.getBoundingClientRect().top);
      move();
      const d = others.map((r, i) => before[i] - r.getBoundingClientRect().top);
      others.forEach((r, i) => { if (d[i]) { r.style.transition = 'none'; r.style.transform = 'translateY(' + d[i] + 'px)'; } });
      void pane.offsetHeight;
      others.forEach((r, i) => { if (d[i]) { r.style.transition = 'transform .16s ease'; r.style.transform = ''; } });
    }
    function place() {
      ghost.style.transform = 'translate3d(0,' + (y - grab - rect.top) + 'px,0) scale(1.015)';
      const centre = y - grab + rect.height / 2;
      for (let guard = 0; guard < 50; guard++) {          // can cross several rows in one move
        const next = row.nextElementSibling, prev = row.previousElementSibling;
        const mid = (r) => { const b = r.getBoundingClientRect(); return b.top + b.height / 2; };
        if (next && next.classList.contains('core-addon') && centre > mid(next)) flip(() => next.after(row));
        else if (prev && prev.classList.contains('core-addon') && centre < mid(prev)) flip(() => prev.before(row));
        else break;
      }
    }
    function edgeScroll() {                                // near the top / bottom of the panel: keep scrolling
      if (!scroller) return;
      const b = scroller.getBoundingClientRect(), edge = 56;
      scrollV = y < b.top + edge ? -Math.ceil((b.top + edge - y) / 4) : y > b.bottom - edge ? Math.ceil((y - (b.bottom - edge)) / 4) : 0;
    }
    const tick = setInterval(() => { if (scrollV && scroller) { scroller.scrollTop += scrollV; place(); } }, 16);
    let raf = 0;
    const onMove = (e) => { y = e.clientY; raf = raf || requestAnimationFrame(() => { raf = 0; if (!ended) { edgeScroll(); place(); } }); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); finish(false); } };   // on window, so it runs before the panel's own Esc-closes-it handler
    const onUp = () => finish(true);
    function finish(commit) {
      if (ended) return; ended = true;
      clearInterval(tick); cancelAnimationFrame(raf);
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerup', onUp, true);
      document.removeEventListener('pointercancel', onUp, true);
      window.removeEventListener('keydown', onKey, true);
      document.documentElement.classList.remove('core-dragging');
      const done = () => {
        ghost.remove(); row.classList.remove('core-placeholder');
        rows().forEach((r) => { r.style.transition = ''; r.style.transform = ''; });
        if (!row.isConnected) return;                      // the panel was redrawn meanwhile
        const ids = rows().map((r) => r.getAttribute('data-id'));
        if (commit && ids.join('|') !== startIds.join('|')) saveOrder(ids);
      };
      if (!row.isConnected) { done(); return; }
      if (!commit) {                                       // put it back where it was
        const at = startIds.indexOf(row.getAttribute('data-id')), others = rows().filter((r) => r !== row);
        if (others[at]) others[at].before(row); else if (others.length) others[others.length - 1].after(row);
      }
      const to = row.getBoundingClientRect();              // the ghost settles into the slot, then the real row takes over
      ghost.style.transition = 'transform .14s ease, box-shadow .14s ease';
      ghost.style.transform = 'translate3d(0,' + (to.top - rect.top) + 'px,0)'; ghost.style.boxShadow = 'none';
      setTimeout(done, 150);
    }
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('pointercancel', onUp, true);
    window.addEventListener('keydown', onKey, true);
    place();
  }

  function renderAddonsTab(el) {
    const c = cfg.get();
    const list = orderedEntries();
    const buttons = new Map(ui.dock.items().map((b) => [b.id, b]));   // which addons really have a button (and its icon)
    const rows = list.map((e) => {
      const s = rstat(e.id);
      const cb = h('input', { type: 'checkbox', onchange: (ev) => setEnabled(e.id, ev.target.checked) });
      cb.checked = !c.off.includes(e.id);
      const btn = buttons.get(e.id), mem = buttonMemo(e), has = hasButton(e);
      // It runs, has no button, and nobody says it should: forget an old memory of one (an addon that dropped its button).
      if (s.state === 'ok' && !btn && mem && declared(e) !== true && performance.now() > 15000) { const m = btnMemo.get() || {}; delete m[e.id]; btnMemo.set(m); }
      // The icon of this addon's button, so each row says which button it is. No icon = it works in the background.
      // An addon that is not running here shows the icon it was last seen with (or a plain box when only the author said "button": true),
      // so skipped rows look like the rest.
      const ico = btn
        ? h('div', { class: 'core-addon-ico', title: 'Button: ' + btn.title }, dockIcon(btn))
        : has
          ? h('div', { class: 'core-addon-ico', title: 'Button' + (mem ? ': ' + mem.title : '') + ' (shown on the pages where this addon runs)' }, (mem && mem.icon) || '◻')
          : h('div', { class: 'core-addon-ico none', title: s.state === 'ok' || declared(e) === false ? 'No button: this addon works in the background' : 'No button known yet (' + s.state + ')' }, '—');
      const noBtn = !has && (declared(e) === false || s.state === 'ok') ? ' · no button' : '';
      const grip = h('div', { class: 'core-grip', tabindex: '0', role: 'button', title: 'Drag to rearrange', 'aria-label': 'Rearrange ' + (e.name || e.id) + ': drag, or press Up / Down', 'data-grip': e.id },
        h('i'), h('i'));
      const row = h('div', { class: 'core-addon', 'data-id': e.id }, ico, cb,
        h('div', { class: 'core-addon-main' },
          h('div', { class: 'core-addon-name' }, e.name || e.id, h('span', { class: 'core-dim' }, '  ' + e.id + ((s.ver || e.version) ? ' v' + (s.ver || e.version) + (s.ver && e.version && s.ver !== e.version ? ' (v' + e.version + ' ready)' : '') : '') + ' · ' + e.source + noBtn)),
          h('div', { class: 'core-dim' }, e.url),
          s.err ? h('div', { class: 'core-err' }, s.err) : null),
        h('div', { class: 'core-addon-meta' },
          h('span', { class: 'core-pill core-pill-' + s.state }, s.state + (s.update ? ' · update ready' : '')),
          s.from ? h('span', { class: 'core-dim' }, s.from + (s.bytes ? ' · ' + Math.round(s.bytes / 1024) + ' KB' : '')) : null),
        e.source === 'custom' ? ui.btn('🗑', 'danger', () => removeCustom(e.id)) : null,
        grip);
      if (!has) {   // no button = nothing to arrange: keep the row's layout, drop the handle
        grip.style.visibility = 'hidden'; grip.removeAttribute('tabindex'); grip.removeAttribute('role'); grip.setAttribute('aria-hidden', 'true');
        return row;
      }
      grip.addEventListener('pointerdown', (ev) => {
        if (ev.pointerType === 'mouse' && ev.button !== 0) return;
        ev.preventDefault();
        startRowDrag(ev, row, el);
      });
      grip.addEventListener('keydown', (ev) => {
        const d = ev.key === 'ArrowUp' ? -1 : ev.key === 'ArrowDown' ? 1 : 0;
        if (!d) return;
        ev.preventDefault();
        nudgeAddon(e.id, d);
        const again = el.querySelector('[data-grip="' + e.id + '"]'); if (again) again.focus();
      });
      return row;
    });
    // What the dock really looks like right now, left to right, so the arrangement above can be checked at a glance.
    const shown = ui.dock.items();
    const orderHint = h('div', { class: 'core-order' },
      shown.length ? h('div', { class: 'core-order-btns', title: 'Your buttons, left to right' }, shown.map((b) => h('span', { class: 'core-order-chip', title: b.title }, dockIcon(b)))) : null,
      h('div', { class: 'core-dim' }, 'Drag the bars on the right of a row to rearrange. The top of the list is the left-most button; \u2699\ufe0f stays at the far left.'));
    const url = h('input', { class: 'core-input', placeholder: 'Addon URL (.js)', title: 'e.g. https://raw.githubusercontent.com/you/repo/main/addons/x.js', style: { flex: '1 1 240px', minWidth: '120px' } });
    el.replaceChildren(
      h('div', { class: 'core-dim', style: { marginBottom: '12px' } }, 'Core v' + Core.version + (root.__coreBoot && root.__coreBoot.pending() && root.__coreBoot.readyVersion() ? ' (v' + root.__coreBoot.readyVersion() + ' ready)' : '') + '  \u00b7  Manifest: ' + (MANIFEST || '(none)')),
      orderHint,
      ...rows.length ? rows : [h('div', { class: 'core-empty' }, 'No addons yet. Add a URL below or set CONFIG.manifest.')],
      h('div', { class: 'core-row', style: { marginTop: '16px' } }, url,
        ui.btn('Add by URL', 'success', () => { addCustom(url.value); url.value = ''; }),
        ui.btn('Check for updates', 'soft', checkForUpdates)));
  }
  // The addon manager is just another floating item - same system every addon uses.
  float.add({ id: 'addons', title: 'Addons', icon: '\u2699\ufe0f', order: 900, width: 900, render: renderAddonsTab });


  /* ---------------------------------------------------------------- me --- */
  // The player's own numbers, read once here so no addon re-implements it: stamina (+ regen and next tick),
  // level, exp, gold, gems, the server clock, and the player id. Source: the site's top bar (.gtb-inner). On pages
  // without that bar (event map, fetched documents) get() returns the last values seen, marked stale.
  //
  // The bar is live. The site's own scripts tick #stamina_timer and #server_time every second, and add the hourly
  // stamina to #stamina_span when the timer reaches 0 (the server already did it at HH:00:00). Core.dom.watch re-reads
  // the bar after every DOM change, so get() and 'me:update' follow those updates with no polling of their own.
  //
  // Big gold / gems are shown in short form in the bar ("3303348.038K" -> "3.3B"; see shortenBar). The exact value
  // is kept in data-core-raw and that is what get() returns, so shortening never costs precision. EXP, level and
  // stamina are left exactly as the site draws them.
  const me = (() => {
    const saved = store('me', { def: {} });
    const srvStore = store('server', { def: null, key: 'core:server' });   // server clock offset, shared by every player
    const DEFAULT_TZ = 19800;        // the game's server is on India time (UTC+5:30) until a page says otherwise
    const nint = (x) => parseInt(String(x == null ? '' : x).replace(/[^\d-]/g, ''), 10) || 0;
    const stat = (bar, label) => {
      const el = Array.from(bar.querySelectorAll('.gtb-stat')).find((e) => {
        const l = e.querySelector('.gtb-label'); return l && l.textContent.trim().toLowerCase() === label;
      });
      return el ? el.querySelector('.gtb-value') : null;
    };

    // ---- short form for the big numbers in the bar ----
    const SHORT_STATS = ['gold', 'gems'];
    const SHORT_MIN = 1e6;           // under this the site's own text ("2.279K") is already short
    function statNum(v) {            // exact value of a gold/gems element, whether or not we shortened it
      const t = v.textContent.trim(), raw = v.getAttribute('data-core-raw');
      return raw && v.getAttribute('data-core-short') === t ? +raw : parseNum(t);
    }
    function shortenBar(bar) {
      SHORT_STATS.forEach((label) => {
        const v = stat(bar, label);
        if (!v) return;
        const t = v.textContent.trim();
        if (v.getAttribute('data-core-short') === t) return;             // still the text we wrote
        const n = parseNum(t);
        if (Math.abs(n) >= SHORT_MIN) {
          const s = compact(n, { min: SHORT_MIN });
          v.setAttribute('data-core-raw', String(n)); v.setAttribute('data-core-short', s);
          v.title = n.toLocaleString();                                   // hover for the exact number
          v.textContent = s;
        } else if (v.hasAttribute('data-core-short')) {                  // the site rewrote it to something small
          v.removeAttribute('data-core-raw'); v.removeAttribute('data-core-short'); v.removeAttribute('title');
        }
      });
    }

    // ---- server clock ----
    // The page's #server_time holds data-epoch (server seconds at the moment it rendered the page) and data-tzoff
    // (seconds east of UTC). skew = server clock minus this browser's clock, measured once per page and remembered
    // (core:server) so pages without a top bar still know the server's time. The site's own text clock only counts
    // seconds from that epoch (and stalls in background tabs), so Core never reads the displayed text.
    let srv = null;                  // { tzoff, skew, known } measured on THIS page
    let fb = null, fbAt = 0;         // last remembered value, re-read at most every 5 s
    const renderedAt = () => {       // when the server rendered this page, on the browser's clock (about); null = can't tell
      try {
        const n = performance.getEntriesByType('navigation')[0];
        // A back/forward load can come straight from cache with an old epoch, and a page that has been open a while
        // is too late to measure from: neither tells us anything about the clock.
        if (n && n.responseStart > 0 && n.type !== 'back_forward' && performance.now() < 20000) return performance.timeOrigin + n.responseStart;
      } catch (_) { /* fall through */ }
      return null;
    };
    function measure(st) {
      const prior = srvStore.get(), at = renderedAt(), attr = st.getAttribute('data-tzoff');
      const tzoff = attr != null && attr !== '' && isFinite(+attr) ? +attr : (prior && prior.tzoff != null ? prior.tzoff : DEFAULT_TZ);
      const epochMs = (+st.getAttribute('data-epoch')) * 1000;
      let skew;
      if (at != null) skew = epochMs - at;
      else if (prior && isFinite(prior.skew)) skew = prior.skew;         // old/cached page: its epoch is stale, trust the last good measurement
      else skew = epochMs - Date.now();                                  // nothing better: assume the page is fresh
      if (at != null || !prior) srvStore.set({ tzoff, skew, ts: Date.now() });
      return { tzoff, skew, known: true };
    }
    // { tzoff, skew, known }. known:false = never seen a top bar, so this is the India-time default with no skew.
    function server() {
      if (srv) return Object.assign({}, srv);
      const t = Date.now();
      if (t - fbAt > 5000) { fbAt = t; fb = srvStore.get() || (saved.get() || {}).server || null; }
      return fb && isFinite(fb.skew) ? { tzoff: fb.tzoff == null ? DEFAULT_TZ : fb.tzoff, skew: fb.skew, known: true } : { tzoff: DEFAULT_TZ, skew: 0, known: false };
    }

    // doc = the live page (default) or any fetched Document that has the top bar. Only the live page can tell who the player is,
    // show their avatar, or measure the server clock.
    function readBar(doc) {
      const isLive = !doc || doc === document;
      const bar = (doc || document).querySelector('.gtb-inner');
      if (!bar) return null;
      const out = { pid: player.id() };
      const sp = bar.querySelector('#stamina_span');
      if (sp) {
        const box = sp.closest('.gtb-value'), mm = box && /([\d,]+)\s*\/\s*([\d,]+)/.exec(box.textContent);
        const tm = bar.querySelector('#stamina_timer');
        const regen = tm && /\+\s*([\d,]+)/.exec(tm.getAttribute('title') || '');
        const t = tm && /(\d+):(\d+)(?::(\d+))?/.exec(tm.textContent || '');
        const secs = t ? (t[3] != null ? (+t[1]) * 3600 + (+t[2]) * 60 + (+t[3]) : (+t[1]) * 60 + (+t[2])) : null;
        out.stamina = { cur: nint(sp.textContent), max: mm ? nint(mm[2]) : 0, regen: regen ? nint(regen[1]) : 0, nextTickAt: secs == null ? 0 : Date.now() + secs * 1000 };
      }
      const g = stat(bar, 'gold'); if (g) out.gold = statNum(g);
      const gm = stat(bar, 'gems'); if (gm) out.gems = statNum(gm);
      const lv = bar.querySelector('.gtb-level'); if (lv) out.level = nint(lv.textContent);
      if (isLive) { const who = player.info(); if (who.name) out.name = who.name; if (who.avatar) out.avatar = who.avatar; }
      const ex = bar.querySelector('.gtb-exp-top');
      if (ex) {
        const spans = ex.querySelectorAll('span'), mm = /([\d,]+)\s*\/\s*([\d,]+)/.exec(spans.length ? spans[spans.length - 1].textContent : ex.textContent);
        const fill = bar.querySelector('.gtb-exp-fill'), w = fill && /([\d.]+)\s*%/.exec(fill.getAttribute('style') || '');
        if (mm) out.exp = { cur: nint(mm[1]), max: nint(mm[2]), pct: w ? parseFloat(w[1]) : (nint(mm[2]) ? Math.round(nint(mm[1]) / nint(mm[2]) * 1000) / 10 : 0) };
      }
      const st = isLive && bar.querySelector('#server_time');
      if (st && st.getAttribute('data-epoch')) { if (!srv) srv = measure(st); out.server = Object.assign({}, srv); }
      return out;
    }

    // ---- what is known, and who is newest ----
    // The bar on the page is only a COPY of the player's numbers, and often an old one: a page can be hours old, a background tab's
    // timers are throttled, another tab may have used a potion since. So the bar is one witness among several, and every witness is
    // stamped with WHEN it saw the numbers:
    //   - the bar changing (the site's own script moved it)        stamped when Core noticed
    //   - a response or page that was fetched (attack, game_dash)  stamped when that REQUEST STARTED, so it can never beat a change
    //                                                              seen after it was already on its way
    //   - another tab's snapshot (core:<pid>:me)                   stamped by that tab
    // The newest witness wins. When it beats the bar, the bar is rewritten to match (stamina, exp, level); gold and gems are tracked
    // but never rewritten. A fetched value therefore always beats a stale bar, and a bar the site just changed beats an older fetch.
    const GROUPS = ['stamina', 'exp', 'level', 'gold', 'gems'];
    const WRITE = { stamina: true, exp: true, level: true };
    const known = {};     // group -> { v, at, src }    the best value we have
    const seenDom = {};   // group -> signature of what the bar showed when Core last looked at it or wrote it (tells the site's change from ours)
    const gsig = (g, v) => JSON.stringify(g === 'stamina' || g === 'exp' ? [v && v.cur, v && v.max] : v);
    const fin = (x) => (x != null && x !== '' && isFinite(+x) ? +x : null);
    const atMap = () => { const m = {}; GROUPS.forEach((g) => { if (known[g]) m[g] = known[g].at; }); return m; };
    const newestAt = () => Math.max(0, ...GROUPS.map((g) => (known[g] ? known[g].at : 0)));
    // A page restored from the browser's back/forward cache shows the numbers it had when it was left: unknown age, so it never beats anything.
    const firstAt = () => (renderedAt() != null ? Date.now() : 0);

    function writeDom(g, v) {
      const bar = document.querySelector('.gtb-inner');
      if (!bar || !WRITE[g] || v == null) return;
      try {
        if (g === 'stamina') {
          const sp = bar.querySelector('#stamina_span');
          if (sp && nint(sp.textContent) !== v.cur) sp.textContent = fmt(v.cur);
        } else if (g === 'exp') {
          const top = bar.querySelector('.gtb-exp-top span:last-child'), fill = bar.querySelector('.gtb-exp-fill');
          if (v.max > 0) {
            if (top) top.textContent = fmt(v.cur) + ' / ' + fmt(v.max);
            if (fill) fill.style.width = Math.min(100, v.cur / v.max * 100) + '%';
          }
        } else if (g === 'level') {
          const lv = bar.querySelector('.gtb-level');
          if (lv && nint(lv.textContent) !== v) lv.textContent = /\d/.test(lv.textContent) ? lv.textContent.replace(/\d[\d,]*/, String(v)) : 'LV ' + v;
        }
      } catch (e) { warn('could not update the top bar', e); }
      const now = readBar();
      if (now && now[g] != null) seenDom[g] = gsig(g, now[g]);   // remember it as ours, so it is not mistaken for the site's change
    }
    // Looks at the bar. A group whose numbers differ from what we last saw there was changed by the site just now: that is the
    // newest news, unless something fetched is already newer, in which case the bar is put right.
    function observeDom() {
      const live = readBar();
      if (!live) return null;
      const now = Date.now();
      GROUPS.forEach((g) => {
        if (live[g] == null) return;
        const sig = gsig(g, live[g]);
        if (seenDom[g] === sig) return;
        const first = seenDom[g] === undefined, at = first ? firstAt() : now, k = known[g];
        seenDom[g] = sig;
        if (!k || at >= k.at) known[g] = { v: live[g], at, src: 'page' };
        else if (gsig(g, k.v) !== sig) writeDom(g, k.v);
      });
      return live;
    }
    function merge(g, prev, raw) {
      if (g === 'stamina') return Object.assign({ cur: 0, max: 0, regen: 0, nextTickAt: 0 }, prev, raw);
      if (g === 'exp') { const e = Object.assign({ cur: 0, max: 0, pct: 0 }, prev, raw); e.pct = e.max ? Math.round(e.cur / e.max * 1000) / 10 : e.pct; return e; }
      return raw;
    }
    function norm(p) {
      const out = {};
      ['stamina', 'exp'].forEach((g) => {
        const x = p[g]; if (x == null) return;
        const o = typeof x === 'object' ? x : { cur: x };
        if (fin(o.cur) == null) return;
        const v = { cur: fin(o.cur) };
        ['max', 'regen', 'nextTickAt'].forEach((f) => { if (fin(o[f]) != null) v[f] = fin(o[f]); });
        out[g] = v;
      });
      ['level', 'gold', 'gems'].forEach((g) => { if (fin(p[g]) != null) out[g] = fin(p[g]); });
      return out;
    }
    // true when the value really changed. The same value from a newer witness only refreshes its timestamp.
    function put(g, raw, at, src) {
      const k = known[g];
      if (k && k.at > at) return false;                       // something newer is already known
      const v = merge(g, k && k.v, raw);
      if (k && gsig(g, k.v) === gsig(g, v)) { known[g] = { v: k.v, at, src }; return false; }
      known[g] = { v, at, src };
      writeDom(g, v);
      return true;
    }

    function merged(live) {
      const sv = live ? null : (saved.get() || {});
      const out = Object.assign({}, live || Object.assign({ pid: player.id() }, sv));
      GROUPS.forEach((g) => {
        const k = known[g];
        if (k && (live || !(sv.at && sv.at[g] > k.at))) out[g] = k.v;
      });
      if (live && live.stamina && out.stamina) out.stamina = Object.assign({}, out.stamina, { regen: live.stamina.regen || out.stamina.regen, nextTickAt: live.stamina.nextTickAt || out.stamina.nextTickAt });
      return out;
    }
    // Change detector: ignores the ticking timer/clock so 'me:update' only fires when a real value moved.
    const sigOf = (v) => JSON.stringify([v.stamina && [v.stamina.cur, v.stamina.max, v.stamina.regen], v.gold, v.gems, v.level, v.exp && [v.exp.cur, v.exp.max]]);
    let lastSig = '', lastSave = 0;
    function publish() {
      const live = observeDom(), cur = merged(live), now = Date.now();
      const sig = sigOf(cur), changed = sig !== lastSig;
      if (cur.pid !== 'default' && (changed || now - lastSave > 30000)) { lastSave = now; saved.set(Object.assign({}, cur, { ts: now, at: atMap() })); }
      if (changed) { lastSig = sig; emit('me:update', Object.assign({ stale: false, ageMs: 0 }, cur)); }
      return live;
    }
    function refresh() {
      const bar = document.querySelector('.gtb-inner');
      if (!bar) return null;
      shortenBar(bar);
      return publish();
    }
    function get() {
      const live = observeDom(), out = merged(live), ts = Date.now();
      if (live) return Object.assign({ stale: false, ageMs: 0, ts }, out, { server: live.server || server(), at: atMap() });
      const c = saved.get() || {}, newest = Math.max(newestAt(), c.ts || 0), at = Object.assign({}, c.at);
      GROUPS.forEach((g) => { if (known[g] && known[g].at > (at[g] || 0)) at[g] = known[g].at; });
      // no top bar here: what this tab was told, or the last snapshot any tab saved
      return Object.assign(out, { server: server(), stale: !(newestAt() && ts - newestAt() < 60000), ageMs: newest ? ts - newest : null, at });
    }

    // ---- telling Core.me something newer ----
    // apply({ stamina: 812, exp: { cur, max }, level: 41, gold, gems }, { at?, src? })
    //   Absolute numbers (never "add 5"). Every field is optional. stamina / exp may be a plain number (keeps the known max) or an object.
    //   at = when YOU saw these numbers (ms since epoch, default now). Anything already known that is newer is kept. Returns true if a number changed.
    function apply(patch, o = {}) {
      if (!patch || typeof patch !== 'object') return false;
      const at = o.at != null ? o.at : Date.now(), src = o.src || 'api', p = norm(patch);
      observeDom();                                          // learn what the page itself changed first, so it is not overwritten blindly
      let changed = false;
      Object.keys(p).forEach((g) => { if (put(g, p[g], at, src)) changed = true; });
      if (changed) publish();
      return changed;
    }
    // The one place that turns "I earned this much exp" into the bar: adds to the known exp, rolls over into the next level with the
    // game's formula, and (on a level-up, which refills stamina) asks the server for the real numbers.
    // Returns true when it took care of the exp, false when it could not (no exp known yet, e.g. no top bar was ever seen): only then should
    // a caller do its own bar update.
    const expRequired = (level) => Math.round(100 + Math.pow(2.5 * (level + 1), 2));
    function addExp(delta, o = {}) {
      delta = fin(delta);
      if (!(delta > 0)) return false;
      observeDom();
      const e = known.exp && known.exp.v, l = known.level ? known.level.v : null;
      if (!e || !(e.max > 0)) return false;
      let cur = e.cur + delta, max = e.max, level = l;
      for (let n = 0; cur >= max && n < 1000; n++) {
        if (level == null) return false;                     // would level up but the level is unknown: do not guess
        cur -= max; level += 1; max = expRequired(level);
      }
      const up = level !== l;
      const patch = { exp: { cur, max } }; if (level != null) patch.level = level;
      apply(patch, { at: o.at, src: o.src || 'attack' });
      if (up) syncSoon();
      return true;                                           // handled (even if a newer number made apply keep its own): callers must not add it a second time
    }
    // Hand it an attack response ({ stamina, xp_delta, ... }) and it does the rest. opts.expDefault = exp to add when the response has none.
    function fromAttack(d, o = {}) {
      if (!d || typeof d !== 'object') return false;
      let changed = false;
      if (fin(d.stamina) != null && apply({ stamina: fin(d.stamina) }, { at: o.at, src: 'attack' })) changed = true;
      const xp = d.xp_delta != null ? fin(d.xp_delta) : (o.expDefault != null ? fin(o.expDefault) : null);
      if (xp != null && addExp(xp, { at: o.at, src: 'attack' })) changed = true;
      return changed;
    }
    // Reads the top bar of a FETCHED page (a Document, or its HTML) and applies it. This is what makes a fresh fetch beat a stale page.
    function ingest(src, o = {}) {
      let doc = src;
      try { if (typeof src === 'string') doc = new DOMParser().parseFromString(src, 'text/html'); } catch (_) { return false; }
      if (!doc || !doc.querySelector || doc === document) return false;
      const r = readBar(doc);
      if (!r) return false;
      const patch = {}; GROUPS.forEach((g) => { if (r[g] != null) patch[g] = r[g]; });
      syncedAt = Date.now();
      return apply(patch, { at: o.at, src: o.src || 'fetch' });
    }
    // Fetches a light page that carries the top bar and applies it: the real numbers, right now. Several callers share one request.
    const SYNC_URL = '/game_dash.php';
    let syncJob = null, syncedAt = 0, hiddenAt = 0;
    function sync() {
      if (syncJob) return syncJob;
      const before = newestAt();
      const job = net.fetchText(SYNC_URL, { force: true }).catch(() => null)
        .then(() => Object.assign(get(), { synced: newestAt() > before }))
        .finally(() => { if (syncJob === job) syncJob = null; });
      return (syncJob = job);
    }
    const syncSoon = debounce(() => { sync(); }, 600);

    // Pages fetched by Core (and anything handed to ingest) carry numbers: take them.
    net.onText((href, text, at) => { if (text && /id=["']stamina_span["']/.test(text)) ingest(text, { at, src: 'fetch' }); });
    // Any attack response says exactly how much stamina is left (a plain number, so taking it can never double-count).
    // Exp is NOT taken from here: the page's own script already adds it to the bar for its own attacks, and an "add" would count twice.
    net.watch(/\/damage\.php/, (r) => { if (r.json && fin(r.json.stamina) != null) apply({ stamina: fin(r.json.stamina) }, { src: 'attack' }); }, { method: 'POST' });
    // After any potion (stamina, hp, ...) the numbers moved and no response says how: ask the server.
    net.watch(/\/use_item\.php|\/user_heal_potion\.php/, () => syncSoon(), { method: 'POST' });
    // A tab that was hidden for a while (its timers are throttled) shows old numbers: when it comes back, fetch the real ones.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
      if (hiddenAt && Date.now() - hiddenAt > 60000 && Date.now() - syncedAt > 60000 && document.querySelector('.gtb-inner')) syncSoon();
    });
    // Another tab of the same player saved newer numbers: take whatever is newer than what this tab knows.
    saved.watch((v) => {
      if (!v || !v.at || (v.pid && v.pid !== player.id())) return;
      let changed = false;
      observeDom();
      GROUPS.forEach((g) => { const t = v.at[g]; if (v[g] != null && t > ((known[g] && known[g].at) || 0) && put(g, v[g], t, 'tab')) changed = true; });
      if (changed) publish();
    });

    // Stamina now. When the numbers are old (stale snapshot) this adds the hourly regen that must have happened since.
    function staminaEstimate(now = Date.now()) {
      const s = get().stamina;
      if (!s) return null;
      if (!s.regen || !s.nextTickAt || now < s.nextTickAt) return s.cur;
      return Math.min(s.max || Infinity, s.cur + (Math.floor((now - s.nextTickAt) / 3600000) + 1) * s.regen);
    }
    // The server's clock (ms since epoch). Uses the offset measured on the last page that had the top bar.
    function serverNow() { return Date.now() + server().skew; }
    // Seconds until the next top of the hour on the SERVER's local clock (when stamina ticks).
    function secondsToTick(now = serverNow()) { return 3600 - (Math.floor(now / 1000) + server().tzoff) % 3600; }
    const watch = (cb) => on('me:update', cb);
    dom.watch(refresh);
    return { get, refresh, staminaEstimate, serverNow, secondsToTick, server, watch, apply, addExp, fromAttack, ingest, sync, expRequired };
  })();

  /* ------------------------------------------------------------- clock --- */
  // The game's clock, on the SERVER's time zone (India, UTC+5:30, no daylight saving), not the player's. The game's
  // "Monday" starts at 00:00 there, and stamina ticks on its hour, so "only on Mondays" or "after 14:30" has to be
  // asked of THIS clock. It also puts the weekday next to the time in the top bar ("🕒 Server Thu 4:10:43 AM").
  //
  //   Core.clock.now()                 server time as epoch ms (same scale as Date.now(); only the offset is measured)
  //   Core.clock.parts(ms?)            { year, month 1-12, date, hour, minute, second, dow, isoDow, dayName, dayShort,
  //                                      secOfDay, ymd 'YYYY-MM-DD', hms 'HH:MM:SS', iso '...+05:30', offset '+05:30',
  //                                      tzoff (seconds), epoch, known }     dow: 0 = Sunday .. 6 = Saturday (JS getDay)
  //                                                                          isoDow: 1 = Monday .. 7 = Sunday
  //   Core.clock.dow() · isoDow() · dayName(short?)     today's weekday as a number / name
  //   Core.clock.dayIndex(d)           'mon' | 'Monday' | 1 -> 1 (0 and 7 both mean Sunday); -1 if it isn't a day
  //   Core.clock.is('mon') · is('sat', 'sun') · is(['sat', 'sun'])      is it one of these days (server time)
  //   Core.clock.isAfter('14:30', day?) · isBefore('18:00', day?)      time of day, 'HH:MM[:SS]' or '2:30 pm'; day optional
  //   Core.clock.between('09:00', '17:00')                             may wrap midnight: between('22:00', '02:00')
  //   Core.clock.matches({ day, after, before })   all given parts must hold: matches({ day: ['sat', 'sun'], after: '14:00' })
  //   Core.clock.when(spec, fn)        runs fn(parts) only if matches(spec); returns whether it ran
  //   Core.clock.next(day, time, from?) -> epoch ms of the next time it is that day + time (day null/'*' = any day)
  //   Core.clock.until(day, time)      ms from now to that moment
  //   Core.clock.at(day, time, fn, { repeat = true, grace = 300000 }) -> cancel()   call fn(parts) at that moment, every
  //                                    week (or every day when day is null). A moment missed by more than `grace` ms
  //                                    (computer asleep, tab frozen) is skipped.
  //   Core.clock.onDay(cb) · onTick(cb) -> unsubscribe   server date rolled over / every second; also on the bus as
  //                                    'clock:day' and 'clock:tick' once either is subscribed.
  //   Core.clock.known                 false until a page with the top bar has been seen (then it is the India default)
  const clock = (() => {
    const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const DAY_MS = 864e5;
    const p2 = (n) => (n < 10 ? '0' : '') + n;

    function dayIndex(d) {
      if (typeof d === 'number') return Number.isInteger(d) && d >= 0 && d <= 7 ? d % 7 : -1;
      const s = String(d == null ? '' : d).trim().toLowerCase();
      if (/^\d$/.test(s)) return dayIndex(+s);
      return s.length >= 3 ? DAYS.findIndex((n) => n.toLowerCase().startsWith(s)) : -1;
    }
    function dayList(args) {
      const out = [];
      [].concat(args).flat(Infinity).forEach((d) => { const i = dayIndex(d); if (i < 0) warn('clock: "' + d + '" is not a day of the week'); else out.push(i); });
      return out;
    }
    function timeSecs(t) {                 // 'HH:MM', 'HH:MM:SS', '2:30 pm', or seconds since midnight -> seconds, -1 if invalid
      if (typeof t === 'number') return t >= 0 && t < 86400 ? Math.floor(t) : -1;
      const m = /^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]m)?\s*$/i.exec(String(t == null ? '' : t));
      if (!m) { warn('clock: "' + t + '" is not a time (use HH:MM)'); return -1; }
      let h = +m[1]; const mi = +m[2], s = +(m[3] || 0), ap = (m[4] || '').toLowerCase();
      if (ap) { if (h < 1 || h > 12) return -1; h = (h % 12) + (ap === 'pm' ? 12 : 0); }
      return h > 23 || mi > 59 || s > 59 ? -1 : h * 3600 + mi * 60 + s;
    }

    const now = () => Date.now() + me.server().skew;
    function parts(ms) {
      const sv = me.server(), t = ms == null ? Date.now() + sv.skew : +ms;
      const d = new Date(t + sv.tzoff * 1000);                 // shifted, so the UTC getters read the SERVER's wall clock
      const dow = d.getUTCDay(), hour = d.getUTCHours(), minute = d.getUTCMinutes(), second = d.getUTCSeconds();
      const year = d.getUTCFullYear(), month = d.getUTCMonth() + 1, date = d.getUTCDate();
      const a = Math.abs(sv.tzoff), offset = (sv.tzoff < 0 ? '-' : '+') + p2(Math.floor(a / 3600)) + ':' + p2(Math.floor((a % 3600) / 60));
      const ymd = year + '-' + p2(month) + '-' + p2(date), hms = p2(hour) + ':' + p2(minute) + ':' + p2(second);
      return {
        epoch: t, tzoff: sv.tzoff, offset, known: sv.known,
        year, month, date, hour, minute, second,
        dow, isoDow: dow || 7, dayName: DAYS[dow], dayShort: DAYS[dow].slice(0, 3),
        secOfDay: hour * 3600 + minute * 60 + second, ymd, hms, iso: ymd + 'T' + hms + offset,
      };
    }

    const dow = () => parts().dow;
    const isoDow = () => parts().isoDow;
    const dayName = (short) => (short ? parts().dayShort : parts().dayName);
    const is = (...days) => dayList(days).includes(parts().dow);
    function isAfter(time, day) {
      const s = timeSecs(time); if (s < 0) return false;
      const p = parts(); return (day == null || dayList([day]).includes(p.dow)) && p.secOfDay >= s;
    }
    function isBefore(time, day) {
      const s = timeSecs(time); if (s < 0) return false;
      const p = parts(); return (day == null || dayList([day]).includes(p.dow)) && p.secOfDay < s;
    }
    function between(from, to) {
      const a = timeSecs(from), b = timeSecs(to); if (a < 0 || b < 0) return false;
      const s = parts().secOfDay; return a <= b ? s >= a && s < b : s >= a || s < b;
    }
    function matches(spec) {
      if (spec == null) return true;
      if (typeof spec !== 'object' || Array.isArray(spec)) spec = { day: spec };
      const p = parts();
      if (spec.day != null && !dayList([spec.day]).includes(p.dow)) return false;
      if (spec.after != null) { const s = timeSecs(spec.after); if (s < 0 || p.secOfDay < s) return false; }
      if (spec.before != null) { const s = timeSecs(spec.before); if (s < 0 || p.secOfDay >= s) return false; }
      return true;
    }
    function when(spec, fn) { if (!matches(spec)) return false; fn(parts()); return true; }

    // Next moment (epoch ms) at or after `from` (default now) that is one of `day` at `time`. Null if the arguments are invalid.
    function next(day, time, from) {
      const secs = time == null ? 0 : timeSecs(time); if (secs < 0) return null;
      const set = day == null || day === '*' ? null : dayList([day]);
      if (set && !set.length) return null;
      const off = me.server().tzoff * 1000, f = (from == null ? now() : +from) + off;   // server wall clock, as if it were UTC
      const midnight = f - (((f % DAY_MS) + DAY_MS) % DAY_MS);
      for (let k = 0; k < 8; k++) {
        const t = midnight + k * DAY_MS + secs * 1000;
        if (t >= f && (!set || set.includes(new Date(t).getUTCDay()))) return t - off;
      }
      return null;
    }
    const until = (day, time) => { const t = next(day, time); return t == null ? null : Math.max(0, t - now()); };

    // One shared 1 s ticker, started by the first at / onDay / onTick. Jobs compare against the clock instead of
    // using one long setTimeout, so a sleeping computer or a throttled background tab can't make them drift.
    const jobs = new Set();
    let timer = null, lastYmd = null;
    function tick() {
      const t = now();
      jobs.forEach((j) => {
        if (t < j.target) return;
        const late = t - j.target;
        if (j.repeat) j.target = next(j.day, j.time, Math.max(t, j.target) + 1000); else jobs.delete(j);
        if (late <= j.grace) { try { j.fn(parts(t)); } catch (e) { warn('clock.at callback threw', e); } }
      });
      const p = parts(t);
      if (lastYmd !== null && p.ymd !== lastYmd) emit('clock:day', p);
      lastYmd = p.ymd;
      emit('clock:tick', p);
    }
    const ensureTicker = () => { if (!timer) { lastYmd = parts().ymd; timer = setInterval(tick, 1000); } };
    function at(day, time, fn, o = {}) {
      const target = next(day, time);
      if (target == null || typeof fn !== 'function') return () => {};
      const job = { day, time, fn, target, repeat: o.repeat !== false, grace: o.grace == null ? 300000 : o.grace };
      jobs.add(job); ensureTicker();
      return () => jobs.delete(job);
    }
    const onDay = (cb) => { ensureTicker(); return on('clock:day', cb); };
    const onTick = (cb) => { ensureTicker(); return on('clock:tick', cb); };

    // The weekday beside the server time in the top bar. It is its own element: the site's script rewrites the
    // text of #server_time every second, so anything put inside it would be erased. Idempotent (dom.watch).
    ui.css('clock', '.gtb-day{font-weight:700;color:#ffd166;margin-right:4px}'
      + '.gtb-stat.time-chip .gtb-label{display:none}');   // the 🕒 already says "server"; frees room for the weekday and the buttons beside the level
    function paintDay() {
      const st = document.getElementById('server_time'), chip = st && st.closest('.gtb-stat');
      if (!chip) return;
      let el = chip.querySelector('.gtb-day');
      if (!el) { el = h('span', { class: 'gtb-day' }); st.before(el); }
      const p = parts(), tip = p.dayName + ', ' + p.date + ' ' + MONTHS[p.month - 1] + ' ' + p.year + ' · server time (UTC' + p.offset + ')';
      if (el.textContent !== p.dayShort) el.textContent = p.dayShort;
      if (el.title !== tip) el.title = tip;
    }
    dom.watch(paintDay);

    return {
      now, parts, dow, isoDow, dayName, dayIndex, is, isAfter, isBefore, between, matches, when, next, until, at, onDay, onTick,
      get known() { return me.server().known; },
    };
  })();


  /* -------------------------------------------------------------- csrf --- */
  // One registry for the site's CSRF tokens, so a later site change that adds a token to more endpoints is one
  // register() call, not a hunt through every addon.
  //   Core.csrf.register(name, { get, page, re, field, expired })
  //     get      () => token | null     read it from the current page (a page global)
  //     page     '/pets.php'            a page that carries the token ...
  //     re       /const X = "(...)"/    ... and the regex whose group 1 is the token (used by refresh)
  //     field    'csrf_token'           form field name POSTs send it under (null = read-only)
  //     expired  /regex/                tells an "expired" reply apart (also matches json.code === 'csrf_expired')
  //   Core.csrf.get(name) · set(name, token) · refresh(name) -> Promise<token|null> · post(name, url, params)
  // post() adds the token, and if the reply says it expired, refreshes it and retries ONCE.
  const csrf = (() => {
    const src = new Map(), tok = new Map(), busy = new Map();
    function register(name, o) { src.set(name, Object.assign({ field: 'csrf_token', expired: /token expired|csrf_expired/i }, o)); return api; }
    function get(name) {
      if (tok.has(name) && tok.get(name)) return tok.get(name);
      const s = src.get(name);
      let v = null; try { v = s && s.get ? s.get() : null; } catch (_) { /* not on this page */ }
      if (v) tok.set(name, String(v));
      return v ? String(v) : '';
    }
    function set(name, token) { if (token) tok.set(name, String(token)); return token; }
    function refresh(name) {
      const s = src.get(name);
      if (!s || !s.page || !s.re) return Promise.resolve(null);
      if (busy.has(name)) return busy.get(name);
      const p = (async () => {
        try {
          const html = await (await root.fetch(abs0(s.page), { credentials: 'include', cache: 'no-store' })).text();
          const m = s.re.exec(html);
          if (m && m[1]) { tok.set(name, m[1]); return m[1]; }
        } catch (_) { /* leave the old token */ }
        return null;
      })();
      busy.set(name, p);
      p.finally(() => busy.delete(name));
      return p;
    }
    const abs0 = (u) => new URL(u, root.location.origin).href;
    const isExpired = (s, r) => !!((r.json && (r.json.code === 'csrf_expired' || s.expired.test(String(r.json.message || '')))) || (!r.json && s.expired.test(String(r.text || '').slice(0, 300))));
    async function post(name, url, params, o = {}) {
      const s = src.get(name);
      if (!s) throw new Error('unknown csrf source: ' + name);
      if (!s.field) throw new Error('csrf source "' + name + '" is read-only (no field)');
      const send = () => {
        const p = new URLSearchParams(params instanceof URLSearchParams ? params.toString() : (params || {}));
        p.set(s.field, get(name));
        return net.post(url, p, Object.assign({ json: true }, o));
      };
      let r = await send();
      if (isExpired(s, r)) { tok.delete(name); await refresh(name); r = await send(); }
      return r;
    }
    on('auth:signedin', () => tok.clear());   // tokens belong to the session that was just replaced
    const api = { register, get, set, refresh, post };
    // Known from the real pages (see the guide, "Site knowledge"):
    register('petSigil', { page: '/pets.php', re: /const\s+PET_SIGIL_CSRF\s*=\s*"([^"]*)"/, get: () => (typeof PET_SIGIL_CSRF === 'undefined' ? null : PET_SIGIL_CSRF), field: 'csrf_token', expired: /security token expired|csrf_expired/i });
    register('expPotion', { get: () => (root.expPotionSettings && root.expPotionSettings.csrf) || null, field: null });
    return api;
  })();


  /* -------------------------------------------------------------- lock --- */
  // Web Locks, as the Ascension Assistant / Cube Suite use them. A lock is held by a promise that never
  // resolves, and the browser frees it the instant this tab's JS context goes away (closed, crashed, discarded):
  // nothing to poll, no stale timestamp, no read-then-write race between two tabs.
  //   Core.lock.hold(name, opts, onLost) -> Promise<boolean>
  //       opts is navigator.locks.request's: {} waits in line until granted, { ifAvailable:true } resolves false
  //       at once if someone else has it, { steal:true } takes it from the holder (who gets onLost).
  //       Resolves true once THIS tab holds it, and keeps holding until release(name) or the tab ends.
  //   Core.lock.release(name) · held(name) · available() · query(name) -> Promise<{ held, pending }>
  //   Core.lock.elect(name, { onLead, onFollow, onLost }) -> Promise<'leader'|'follower'>
  //       one tab leads, the others follow and are promoted automatically when the leader's tab dies.
  const lock = (() => {
    const releasers = {};
    const available = () => !!(navigator.locks && typeof navigator.locks.request === 'function');
    function hold(name, opts, onLost) {
      return new Promise((resolve) => {
        if (!available()) { resolve(false); return; }
        if (releasers[name]) { resolve(true); return; }            // this tab already holds it
        let granted = false;
        try {
          navigator.locks.request(name, opts || {}, (l) => {
            if (!l) { resolve(false); return; }                      // ifAvailable and it was taken
            granted = true; resolve(true);
            return new Promise((release) => { releasers[name] = release; });
          }).then(() => {}, (e) => {
            if (!granted) resolve(false);
            else if (e && e.name === 'AbortError') { delete releasers[name]; if (onLost) { try { onLost(); } catch (err) { warn('lock onLost threw', err); } } }
          });
        } catch (_) { resolve(false); }
      });
    }
    function release(name) { const r = releasers[name]; if (r) { delete releasers[name]; r(); } }
    async function query(name) {
      try {
        const q = await navigator.locks.query();
        return { held: q.held.filter((x) => x.name === name).length, pending: q.pending.filter((x) => x.name === name).length };
      } catch (_) { return { held: 0, pending: 0 }; }
    }
    async function elect(name, o = {}) {
      if (!available()) { if (o.onLead) o.onLead(); return 'leader'; }   // no Web Locks: behave like a single tab
      if (await hold(name, { ifAvailable: true }, o.onLost)) { if (o.onLead) o.onLead(); return 'leader'; }
      if (o.onFollow) o.onFollow();
      hold(name, {}, o.onLost).then((ok) => { if (ok && o.onLead) o.onLead(); });   // queued: granted when the leader's tab dies
      return 'follower';
    }
    return { hold, release, held: (n) => !!releasers[n], available, query, elect };
  })();

  /* --------------------------------------------------------- keepAlive --- */
  // Keeps a background tab from being throttled, frozen or discarded. Three independent signals (browsers treat
  // them as "this tab is doing something"; none is a guarantee, so use all of them for an automation tab):
  //   lock   a Web Lock held by this tab (exempts it from freezing/discarding; no gesture needed)
  //   rtc    a loopback WebRTC data channel inside the page (no signaling, no camera/mic prompt)
  //   audio  a near-silent 20 Hz oscillator (spares "recently audible" tabs). Needs the browser's autoplay
  //          permission: it retries resume() every 15 s and on any click/keypress in the tab.
  //   Core.keepAlive.start({ lock, rtc, audio })   all default true  -> Promise<status>
  //   Core.keepAlive.stop() · status() -> { on:bool, lock:bool, rtc:'open'|'connecting'|'closed'|'off', audio:'running'|'suspended'|'off' }
  //   startLock/stopLock · startRtc/stopRtc · startAudio/stopAudio   each signal on its own
  //   Core.keepAlive.on() -> bool: has it been asked to run in this tab (whatever the signals are doing right now)
  //   Core.on('keepalive:change', status => ...)   fires on every real change of status() / on(), whoever caused it
  //                                    (a button, an addon, Core.tab). status() also carries `on`. Per tab, not shared.
  // Only start it in the tab that really works in the background; every call is idempotent.
  const keepAlive = (() => {
    const LOCK = 'core_keepalive:' + TAB;       // per-tab name so a 2nd tab is never queued behind the 1st
    let wantLock = false, lockOn = false, wantRtc = false, rtc = null, rtcTimer = null, audio = null, resumeTimer = null, gesture = null;

    // Tell listeners when something visible changed (deduped, so it is safe to call after every step).
    let lastSig = '';
    const wanted = () => wantLock || wantRtc || !!audio;
    function notify() {
      const st = status(), sig = JSON.stringify(st);
      if (sig === lastSig) return;
      lastSig = sig; emit('keepalive:change', st);
    }

    let lockP = null;
    function startLock() {
      wantLock = true;
      notify();
      if (lockOn) return Promise.resolve(true);
      if (lockP) return lockP;                                   // a request is already in flight
      lockP = lock.hold(LOCK, {}).then((ok) => { lockP = null; if (ok && !wantLock) { lock.release(LOCK); notify(); return false; } lockOn = ok; notify(); return ok; });
      return lockP;
    }
    function stopLock() { wantLock = false; lockOn = false; lock.release(LOCK); notify(); }

    function startRtc() {
      wantRtc = true;
      if (rtc || typeof RTCPeerConnection === 'undefined') return;
      try {
        const pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
        pc1.onicecandidate = (e) => { if (e.candidate) pc2.addIceCandidate(e.candidate).catch(() => {}); };
        pc2.onicecandidate = (e) => { if (e.candidate) pc1.addIceCandidate(e.candidate).catch(() => {}); };
        const channel = pc1.createDataChannel('core-keepalive');
        // If it ever drops (e.g. after a long freeze/resume), reopen it rather than silently losing the exemption.
        channel.onclose = () => { if (rtc && rtc.channel === channel) { rtc = null; if (wantRtc) { clearTimeout(rtcTimer); rtcTimer = setTimeout(startRtc, 1000); } } notify(); };
        channel.onopen = notify;
        rtc = { pc1, pc2, channel };
        notify();
        pc1.createOffer().then((o) => pc1.setLocalDescription(o))
          .then(() => pc2.setRemoteDescription(pc1.localDescription))
          .then(() => pc2.createAnswer()).then((a) => pc2.setLocalDescription(a))
          .then(() => pc1.setRemoteDescription(pc2.localDescription))
          .catch((e) => warn('keep-alive RTC negotiation failed', e && e.message));
      } catch (e) { warn('keep-alive RTC failed to start', e && e.message); }
    }
    function stopRtc() {
      wantRtc = false; clearTimeout(rtcTimer);
      if (rtc) { try { rtc.channel.onclose = null; rtc.pc1.close(); rtc.pc2.close(); } catch (_) { /* */ } rtc = null; }
      notify();
    }

    const tryResume = () => { if (audio && audio.ctx.state === 'suspended') audio.ctx.resume().catch(() => {}); };
    function startAudio() {
      if (audio) return;
      try {
        const Ctx = root.AudioContext || root.webkitAudioContext;
        if (!Ctx) return;
        const ctx = new Ctx(), gain = ctx.createGain(), osc = ctx.createOscillator();
        gain.gain.value = 0.001; osc.frequency.value = 20;
        osc.connect(gain).connect(ctx.destination); osc.start();
        audio = { ctx, osc };
        ctx.onstatechange = notify;
        tryResume();
        notify();
        gesture = tryResume;
        document.addEventListener('click', gesture, true); document.addEventListener('keydown', gesture, true);
        resumeTimer = setInterval(tryResume, 15000);
      } catch (e) { warn('keep-alive audio failed to start', e && e.message); }
    }
    function stopAudio() {
      clearInterval(resumeTimer); resumeTimer = null;
      if (gesture) { document.removeEventListener('click', gesture, true); document.removeEventListener('keydown', gesture, true); gesture = null; }
      if (audio) { try { audio.ctx.onstatechange = null; audio.osc.stop(); audio.ctx.close(); } catch (_) { /* */ } audio = null; }
      notify();
    }

    const status = () => ({ on: wanted(), lock: lockOn, rtc: rtc ? rtc.channel.readyState : 'off', audio: audio ? audio.ctx.state : 'off' });
    async function start(o = {}) {
      if (o.audio !== false) startAudio();
      if (o.rtc !== false) startRtc();
      if (o.lock !== false) await startLock();
      return status();
    }
    function stop() { stopLock(); stopRtc(); stopAudio(); }
    return { start, stop, status, on: wanted, startLock, stopLock, startRtc, stopRtc, startAudio, stopAudio };
  })();

  /* --------------------------------------------------------------- tab --- */
  // "Which tab does the work?" Several tabs of the game are open; one is the MAIN tab (runs the automation,
  // owns the keep-alive), the rest are IDLE. Decided by an exclusive Web Lock (Core.lock), exactly like the
  // Ascension Assistant's main tab and the Cube Suite's primary tab, so there is no timestamp to go stale and
  // no two-tabs-both-win race: the browser frees the lock the instant the main tab closes, crashes or is discarded.
  //   Core.tab.join(name, { onMain, onIdle, queue, steal, keepAlive, retries }) -> Promise<'main'|'idle'>
  //       onMain()/onIdle()  called on every change of role (also fired for the first decision)
  //       queue      true: an idle tab waits in line and is promoted automatically when the main tab dies
  //                  (Cube Suite style). false (default): it stays idle until the user takes over (Assistant style).
  //       steal      true: take main from whoever has it right now (use for a tab that must win, e.g. a reload).
  //       keepAlive  true / {lock,rtc,audio}: run Core.keepAlive while this tab is main, stop it when it is not.
  //       retries    waits in ms between attempts to get a free lock at join. Default [0, 500, 1500]: a reloading
  //                  main can briefly lose to its own dying page, so it tries a few times before settling for idle.
  //   Core.tab.takeOver(name) -> Promise<boolean>   steal main (the old main gets onIdle) - a "Use this tab" button
  //   Core.tab.role(name) -> 'main'|'idle'|null · isMain(name) · leave(name) -> give up main / stop waiting
  //   Core.tab.onRole(name, cb) -> unsubscribe     cb(role) on every change, from any caller (also Core.on('tab:role'))
  // Tell the other tabs something with Core.emit(evt, data, { shared: true }); they get it through Core.on(evt, fn).
  // Without Web Locks support every tab is main (fail open: nothing blocks, nothing is exclusive).
  const tab = (() => {
    const joined = {};                                   // name -> { role, o, abort, listeners:Set }
    const lname = (n) => 'core_tab:' + n;
    function setRole(name, role) {
      const j = joined[name];
      if (!j || j.role === role) return;
      j.role = role;
      if (j.o.keepAlive) { if (role === 'main') keepAlive.start(j.o.keepAlive === true ? {} : j.o.keepAlive); else keepAlive.stop(); }
      const cbs = [role === 'main' ? j.o.onMain : j.o.onIdle, ...j.listeners];
      cbs.forEach((fn) => { if (fn) { try { fn(role); } catch (e) { warn('tab role handler threw', e); } } });
      dispatch('tab:role', { name, role });
    }
    function lostMain(name) {
      const j = joined[name];
      if (!j) return;
      setRole(name, 'idle');
      if (j.o.queue) enqueue(name);                      // wait for the next turn
    }
    function enqueue(name) {
      const j = joined[name];
      if (!j || j.abort) return;
      j.abort = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const opts = j.abort ? { signal: j.abort.signal } : {};
      lock.hold(lname(name), opts, () => lostMain(name)).then((ok) => {
        j.abort = null;
        if (ok && joined[name] === j) setRole(name, 'main');
        else if (ok) lock.release(lname(name));          // left while waiting
      });
    }
    async function join(name, o = {}) {
      if (joined[name]) return joined[name].role;
      const j = joined[name] = { role: null, o, abort: null, listeners: new Set() };
      if (!lock.available()) { setRole(name, 'main'); return 'main'; }
      let ok = false;
      if (o.steal) ok = await lock.hold(lname(name), { steal: true }, () => lostMain(name));
      else for (const wait of (o.retries || [0, 500, 1500])) {
        if (wait) await sleep(wait);
        if (joined[name] !== j) return j.role;           // left while retrying
        ok = await lock.hold(lname(name), { ifAvailable: true }, () => lostMain(name));
        if (ok) break;
      }
      if (joined[name] !== j) { if (ok) lock.release(lname(name)); return j.role; }
      if (ok) setRole(name, 'main');
      else { setRole(name, 'idle'); if (o.queue) enqueue(name); }
      return j.role;
    }
    async function takeOver(name) {
      const j = joined[name];
      if (!j) return false;
      if (j.role === 'main') return true;
      if (!lock.available()) return false;
      if (j.abort) { j.abort.abort(); j.abort = null; }  // stop waiting in line; we are jumping the queue
      const ok = await lock.hold(lname(name), { steal: true }, () => lostMain(name));
      if (ok && joined[name] === j) setRole(name, 'main');
      else if (!ok && j.o.queue) enqueue(name);
      return ok;
    }
    function leave(name) {
      const j = joined[name];
      if (!j) return;
      delete joined[name];
      if (j.abort) { j.abort.abort(); j.abort = null; }
      lock.release(lname(name));
      if (j.role === 'main' && j.o.keepAlive) keepAlive.stop();
      j.role = null;
    }
    function onRole(name, cb) {
      const j = joined[name];
      if (!j) return () => {};
      j.listeners.add(cb);
      return () => j.listeners.delete(cb);
    }
    return { join, takeOver, leave, onRole, role: (n) => (joined[n] ? joined[n].role : null), isMain: (n) => !!joined[n] && joined[n].role === 'main' };
  })();

  /* ----------------------------------------------------------- potions --- */
  // ONE place that uses potions, so several addons / tabs / scripts that all notice "0 stamina" at the same moment burn ONE potion
  // between them instead of one each.
  //   Core.potions.stamina(opts?)   use a Large Stamina Potion (opts.item = another potion's name)
  //   Core.potions.hp(opts?)        use a Full HP Potion (the site's heal request; nothing to look up)
  //   Core.potions.use(name, opts?) any consumable by its name
  //   Core.potions.find(name, { fresh })  -> { invId, source: 'sidebar'|'memory'|'inventory' } | null (no potion is used)
  // All of the use calls resolve (never throw) to { ok, used, shared, source?, reason?, message? }:
  //   used:true            this call consumed a potion
  //   shared:true, used:false   somebody else's potion already covers this need (see below), nothing was consumed, ok is true
  //   ok:false             nothing was used; reason: 'none-available' | 'failed' | 'no-player'
  // Where the potion comes from: the live page's Battle Consumables sidebar (.potion-card[data-inv-id]) first, then the id remembered
  // from last time, then inventory.php. A stale id that fails is dropped and inventory.php is tried once.
  // Coordination, per kind of potion (stamina / hp / the item name):
  //   - callers that arrive while one is being used simply wait for it and share its result;
  //   - across tabs a Web Lock serialises the check-then-use, and the time of the last use is kept in localStorage;
  //   - a use that finished at or after opts.since (when YOU saw the need, ms since epoch) already covers you. Without `since`
  //     the last opts.settleMs (default 3000) count, which is enough for a loop that reacts a moment after another one did.
  //   - opts.force = true skips the sharing and always consumes one.
  const potions = (() => {
    const norm = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().toLowerCase();
    const STAMINA = 'Large Stamina Potion';
    const memo = new Map();                 // normalised name -> inventory id
    const flight = new Map();               // kind -> Promise of the use in progress
    const lastKey = (kind) => 'core:potion:' + player.id() + ':' + kind;
    const readLast = (kind) => { try { return JSON.parse(localStorage.getItem(lastKey(kind)) || 'null'); } catch (_) { return null; } };
    const writeLast = (kind) => { try { localStorage.setItem(lastKey(kind), JSON.stringify({ ts: Date.now() })); } catch (_) { /* not shared then; the in-tab sharing still works */ } };
    const locked = (name, fn) => (navigator.locks && navigator.locks.request ? navigator.locks.request(name, fn) : fn());

    const fromSidebar = (name) => {
      const t = norm(name);
      for (const c of document.querySelectorAll('.potion-card[data-inv-id]')) {
        const img = c.querySelector('img');
        if (norm(img && img.alt) === t) return c.getAttribute('data-inv-id');
      }
      return null;
    };
    // A request that hangs must not hold the cross-tab lock (and so every other tab's potions) for ever.
    const soon = (p, ms, dflt) => Promise.race([p, new Promise((res) => setTimeout(() => res(dflt), ms))]);
    const TIMEOUT = 15000;
    const post = (url, params) => soon(net.post(url, params), TIMEOUT, { ok: false, status: 0, text: '', json: null });
    async function fromInventory(name) {
      const t = norm(name), doc = await soon(net.fetchDoc('/inventory.php', { force: true }), TIMEOUT, null).catch(() => null);
      if (!doc) return null;
      for (const slot of doc.querySelectorAll('.slot-box')) {
        const img = slot.querySelector('img');
        if (norm(img && img.alt) !== t) continue;
        const b = [...slot.querySelectorAll('button')].find((x) => /useItem\(/i.test(x.getAttribute('onclick') || ''));
        const m = b && /useItem\(\s*([0-9]+)/i.exec(b.getAttribute('onclick') || '');
        if (m) return m[1];
      }
      for (const c of doc.querySelectorAll('.potion-card[data-inv-id]')) {
        const img = c.querySelector('img');
        if (norm(img && img.alt) === t) return c.getAttribute('data-inv-id');
      }
      return null;
    }
    async function find(name, o = {}) {
      const t = norm(name);
      if (!o.fresh) {
        const s = fromSidebar(name); if (s) return { invId: s, source: 'sidebar' };
        const m = memo.get(t); if (m) return { invId: m, source: 'memory' };
      }
      const i = await fromInventory(name);
      if (i) { memo.set(t, i); return { invId: i, source: 'inventory' }; }
      return null;
    }

    const failed = (r) => !r.ok || (r.json && /^(error|fail)/i.test(String(r.json.status || '').trim()));
    async function consume(name) {
      const t = norm(name), tried = new Set();
      let seen = false;
      for (let pass = 0; pass < 2; pass++) {              // pass 0: sidebar / memory, pass 1: straight from inventory.php
        const f = await find(name, { fresh: pass === 1 });
        if (!f || tried.has(f.invId)) break;
        seen = true; tried.add(f.invId);
        const r = await post('/use_item.php', { inv_id: f.invId });
        if (!failed(r)) return { ok: true, used: true, shared: false, source: f.source, invId: f.invId };
        memo.delete(t);
      }
      return { ok: false, used: false, shared: false, reason: seen ? 'failed' : 'none-available' };
    }
    async function heal() {
      const pid = player.id();
      if (!pid || pid === 'default') return { ok: false, used: false, shared: false, reason: 'no-player' };
      const r = await post('/user_heal_potion.php', { user_id: pid });
      const ok = r.ok && !!r.json && String(r.json.status || '').trim() === 'success';
      return { ok, used: ok, shared: false, reason: ok ? undefined : 'failed', message: r.json && r.json.message };
    }

    function coordinate(kind, o, act) {
      const since = o.since != null ? o.since : Date.now() - (o.settleMs != null ? o.settleMs : 3000);
      if (!o.force && flight.has(kind)) return flight.get(kind).then((r) => (r.ok ? Object.assign({}, r, { used: false, shared: true }) : r));
      const p = locked('core-potion:' + kind, async () => {
        const last = readLast(kind);
        if (!o.force && last && last.ts >= since) return { ok: true, used: false, shared: true, reason: 'covered' };
        const r = await act();
        if (r.ok) writeLast(kind);
        return r;
      }).catch((err) => ({ ok: false, used: false, shared: false, reason: 'failed', message: String((err && err.message) || err) }))
        .finally(() => { if (flight.get(kind) === p) flight.delete(kind); });
      flight.set(kind, p);
      return p;
    }

    return {
      find,
      use: (name, o = {}) => coordinate('item:' + norm(name), o, () => consume(name)),
      stamina: (o = {}) => { const n = o.item || STAMINA; return coordinate(o.item ? 'item:' + norm(n) : 'stamina', o, () => consume(n)); },
      hp: (o = {}) => coordinate('hp', o, heal),
    };
  })();

  /* -------------------------------------------------------------- auth --- */
  // Is the player signed in, and if not, sign back in. Same flow the Reaction Farmer uses (POST /signin.php, then
  // /stats.php must no longer show #login-container), made shareable so no addon needs its own copy.
  //
  //   Core.auth.check({ force })        -> Promise<boolean>  signed in? One shared request, answer reused for 5 s.
  //                                        Rejects when the site can't be reached or shows a blocked page (maintenance...),
  //                                        which is NOT the same as signed out.
  //   Core.auth.pageState(docOrText)    -> 'ok' | 'signedout' | <detector name>   free test on a page or reply you ALREADY
  //                                        fetched (a login page where the real page should be). Fires the events below.
  //   Core.auth.isSignedOut(docOrText)  -> boolean           pageState(...) === 'signedout'
  //   Core.auth.ensure()                -> Promise<boolean>  signed in already, or sign back in. One attempt at a time, across
  //                                        every tab. false = could not (the reason is in status().lastError).
  //   Core.auth.login(creds?)           -> Promise<{ ok, error?, unconfigured?, waiting?, unavailable? }>
  //   Core.auth.register({ id, name, credentials, configured })  -> unregister
  //                                        A source of logins, e.g. the account switcher. credentials() returns
  //                                        { email, password } for the account that should be signed in (or null); it may be
  //                                        async. configured() is an optional sync "is it set up" for status().
  //                                        Sources are asked in registration order, then the saved login.
  //   Core.auth.setCredentials(email, password) · clearCredentials() · importLegacy()
  //                                        A login saved by hand (fallback). NOTE it is plain text in this site's localStorage,
  //                                        readable by every script on the page. importLegacy() copies the Reaction Farmer's
  //                                        saved login over once, on request; it is never read silently.
  //   Core.auth.addDetector(fn)         fn(docOrText) -> state name | falsy. Teach it a page that means "stop" (maintenance).
  //   Core.auth.status()                -> { signedIn, configured, source, sources[], legacyFound, lastOk, lastError, retryAt }
  //
  // Events: 'auth:signedout' { reason } · 'auth:signedin' { via } · 'auth:blocked' { state } · 'auth:failed' { error }
  // A failed automatic sign-in is not repeated for 60 s, so a wrong password can't be sent in a loop.
  const auth = (() => {
    const SIGNIN = '/signin.php', PROBE = '/stats.php';
    const PROBE_TTL = 5000, RETRY_MS = 60000;
    const LEGACY_KEY = 'veyraFarmLogin';
    const saved = store('auth', { def: {}, key: 'core:auth' });
    const sources = [], detectors = [];
    const LOGIN_RE = /id\s*=\s*["']login-container["']/i;
    let signedIn = null, probedAt = 0, probeJob = null, loginJob = null;
    let lastOk = 0, lastError = '', retryAt = 0;
    const lsGet = (k) => { try { return JSON.parse(root.localStorage.getItem(k) || 'null'); } catch (_) { return null; } };

    // 'ok', 'signedout', or the name a detector gave.
    function stateOf(x) {
      if (typeof x === 'string' ? LOGIN_RE.test(x) : !!(x && typeof x.querySelector === 'function' && x.querySelector('#login-container'))) return 'signedout';
      for (const d of detectors) {
        let r = ''; try { r = d(x) || ''; } catch (e) { warn('auth detector threw', e); }
        if (r) return String(r);
      }
      return 'ok';
    }
    // State changes go through the bus so every tab (and every listener) sees the same thing.
    on('auth:signedout', () => { signedIn = false; probedAt = Date.now(); emit('net:invalidate', { all: true }); });   // cached copies may be login pages now
    on('auth:blocked', () => { probedAt = 0; });   // a maintenance page means the cached answer can't be trusted
    on('auth:signedin', () => { signedIn = true; probedAt = Date.now(); pidCache = null; emit('net:invalidate', { all: true }); });

    function pageState(x) {
      const s = stateOf(x);
      if (s === 'signedout') { if (signedIn !== false) emit('auth:signedout', { reason: 'login page' }, { shared: true }); }
      else if (s !== 'ok') emit('auth:blocked', { state: s });
      return s;
    }
    const isSignedOut = (x) => pageState(x) === 'signedout';

    function check(o = {}) {
      if (!o.force && signedIn !== null && Date.now() - probedAt < PROBE_TTL) return Promise.resolve(signedIn);
      if (probeJob) return o.force ? probeJob.then(() => 0, () => 0).then(() => check(o)) : probeJob;   // a forced probe never reuses one that started earlier
      const job = (async () => {
        const res = await root.fetch(PROBE, { credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status + ' from ' + PROBE);
        const s = stateOf(await res.text());
        if (s !== 'ok' && s !== 'signedout') { emit('auth:blocked', { state: s }); throw new Error('site unavailable: ' + s); }
        const up = s === 'ok';
        probedAt = Date.now();
        if (o.quiet) signedIn = up;
        else if (up && signedIn !== true) emit('auth:signedin', { via: 'check' });
        else if (!up && signedIn !== false) emit('auth:signedout', { reason: 'login page' }, { shared: true });
        return up;
      })();
      probeJob = job;
      const done = () => { if (probeJob === job) probeJob = null; };
      job.then(done, done);
      return job;
    }

    async function credentials() {
      for (const s of sources) {
        try {
          const c = await s.credentials();
          if (c && c.email && c.password) return { email: String(c.email), password: String(c.password), source: s.id };
        } catch (e) { warn('auth source "' + s.id + '" threw', e); }
      }
      const m = saved.get() || {};
      return m.email && m.password ? { email: m.email, password: m.password, source: 'saved' } : null;
    }

    const nav = root.navigator;
    const locked = (fn) => (nav && nav.locks && nav.locks.request ? nav.locks.request('core:auth', fn) : fn());
    function fail(msg, extra) { lastError = msg; emit('auth:failed', { error: msg }); return Object.assign({ ok: false, error: msg }, extra); }

    function login(given) {
      if (loginJob) return loginJob;
      const job = locked(async () => {
        if (!given) {
          // another tab may have signed in while this one waited for the lock
          let up = false;
          try { up = await check({ force: true }); }
          catch (e) { return fail('cannot reach the site: ' + ((e && e.message) || e), { unavailable: true }); }   // down / maintenance: never send a login to it
          if (up) return { ok: true, already: true };
          if (Date.now() < retryAt) return { ok: false, waiting: true, error: lastError || 'waiting before the next sign-in attempt' };
        }
        const c = given ? { email: given.email, password: given.password, source: 'given' } : await credentials();
        if (!c || !c.email || !c.password) return fail('no login configured', { unconfigured: true });
        let r;
        try { r = await net.post(SIGNIN, { email: c.email, password: c.password, submit: 'Sign In' }); }
        catch (e) { retryAt = Date.now() + RETRY_MS; return fail('sign-in request failed: ' + ((e && e.message) || e)); }
        let up = false; try { up = await check({ force: true, quiet: true }); } catch (_) { /* */ }
        if (!up) {
          const why = [...new DOMParser().parseFromString(r.text, 'text/html').querySelectorAll('p.error')].map((e) => e.textContent.trim()).filter(Boolean).join(' ');
          retryAt = Date.now() + RETRY_MS;
          return fail(why || 'sign-in failed (HTTP ' + r.status + ')');
        }
        lastOk = Date.now(); lastError = ''; retryAt = 0;
        emit('auth:signedin', { via: c.source }, { shared: true });
        return { ok: true, source: c.source };
      });
      loginJob = job;
      const done = () => { if (loginJob === job) loginJob = null; };
      job.then(done, done);
      return job;
    }

    async function ensure() {
      let up;
      try { up = await check(); } catch (e) { lastError = 'cannot tell if signed in: ' + ((e && e.message) || e); return false; }
      return up ? true : !!(await login()).ok;
    }

    function register(src) {
      if (!src || !src.id || typeof src.credentials !== 'function') { warn('auth.register needs { id, credentials }'); return () => {}; }
      const i = sources.findIndex((s) => s.id === src.id);
      if (i >= 0) sources.splice(i, 1);
      sources.push(src);
      return () => { const k = sources.indexOf(src); if (k >= 0) sources.splice(k, 1); };
    }
    function setCredentials(email, password) {
      if (!email || !password) return false;
      saved.set({ email: String(email).trim(), password: String(password) }); retryAt = 0; return true;
    }
    const clearCredentials = () => { saved.set({}); };
    function importLegacy() { const l = lsGet(LEGACY_KEY); return !!(l && l.email && l.password && setCredentials(l.email, l.password)); }
    const addDetector = (fn) => { if (typeof fn === 'function') detectors.push(fn); return () => { const i = detectors.indexOf(fn); if (i >= 0) detectors.splice(i, 1); }; };

    function status() {
      const m = saved.get() || {}, has = !!(m.email && m.password), l = lsGet(LEGACY_KEY);
      const list = sources.map((s) => { let ok = true; try { if (s.configured) ok = !!s.configured(); } catch (_) { ok = false; } return { id: s.id, name: s.name || s.id, configured: ok }; });
      list.push({ id: 'saved', name: 'Saved login', configured: has });
      const first = list.find((x) => x.configured);
      return { signedIn, configured: !!first, source: first ? first.id : '', sources: list, legacyFound: !has && !!(l && l.email), lastOk, lastError, retryAt };
    }

    return { check, pageState, isSignedOut, ensure, login, register, setCredentials, clearCredentials, importLegacy, addDetector, status };
  })();

  /* ------------------------------------------------------------ export --- */
  const Core = {
    __isCore: true, apiLevel: API, version: '3.15.0', debug: false, tabId: TAB,
    esc, sleep, debounce, fmt, int, compact, parseNum, parseJson,
    on, off, once, emit,
    state, store, player,
    net, pages, dom, cookies, ui, me, clock, csrf, lock, keepAlive, tab, potions, auth,
    module: module_, use, get, status,
    float, addons: { list: entries, add: addCustom, remove: removeCustom, enable: setEnabled, status: rt, reload: startOne },
  };
  root.Core = Core;
  dlog('core ready', Core.version);

  startAddons();
})(window);
