// ==UserScript==
// @name         Core (addon loader)
// @namespace    https://example.local/
// @version      4.0.0
// @description  Tiny bootstrap: loads Core from GitHub and keeps it up to date by itself, like the addons.
// @match        https://demonicscans.org/*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/WerewuIf/UI-Core/main/core.user.js
// @downloadURL  https://raw.githubusercontent.com/WerewuIf/UI-Core/main/core.user.js
// ==/UserScript==

/* =============================================================================
 * Core bootstrap. You install THIS once; you should rarely need to touch it again.
 *
 * It does one job: run core.js (the real Core) and keep it current.
 *   - A saved copy of core.js starts instantly on every page; the page never waits on GitHub.
 *   - On every load it re-checks core.js in the background. If it changed, the new copy is saved and a
 *     toast says "Core updated - click here to reload". The next load runs it. (Same as addons.)
 *   - A new core.js that doesn't even parse is never saved. One that parses but crashes on start is
 *     set aside and the last copy that started fine keeps running.
 *   - First ever load (nothing saved yet) has to fetch core.js once before anything appears.
 *
 * Keep core.js and this file at the repo ROOT, next to addons.json. This file only needs a new @version
 * (and a Tampermonkey update) if CORE_URL or this bootstrap logic itself changes.
 * ========================================================================== */
(function (root) {
  'use strict';
  if (root.__coreBoot) return;

  const CORE_URL = 'https://raw.githubusercontent.com/WerewuIf/UI-Core/main/core.js';
  const K = 'coreboot:code', K_GOOD = 'coreboot:good', K_BAD = 'coreboot:bad';
  const warn = (...a) => console.warn('[Core boot]', ...a);

  const ls = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (_) { return false; } },
  };

  async function fetchText(url) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const res = await root.fetch(url, { cache: 'no-cache', signal: ctl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.text();
    } finally { clearTimeout(timer); }
  }
  // false only when the text is definitely not valid JavaScript. (If the site's CSP blocks eval we can't
  // tell, so we assume it is fine.)
  function parses(code) {
    try { new Function(code); return true; } catch (err) { return !(err instanceof SyntaxError); }
  }
  function run(code, tag) {
    const body = code + '\n//# sourceURL=' + CORE_URL + (tag ? '#' + tag : '');
    let fn = null;
    try { fn = new Function(body); } catch (err) { if (err instanceof SyntaxError) throw err; /* CSP blocks eval -> inline fallback */ }
    if (fn) { fn(); return; }
    const s = document.createElement('script');
    s.textContent = '(function(){' + body + '\n})();';
    (document.head || document.documentElement).appendChild(s);
    s.remove();
  }
  const started = () => !!(root.Core && root.Core.__isCore);
  function start(code, tag) {
    try { run(code, tag); } catch (err) { warn('core.js failed to start' + (tag ? ' (' + tag + ')' : ''), err); }
    return started();
  }

  let running = null;      // the exact text that is executing right now
  let toasted = false;

  // Fetch the newest core.js; keep it for the NEXT load. Never touches what is running.
  async function check() {
    const text = await fetchText(CORE_URL);
    if (!parses(text)) { warn('the new core.js does not parse; keeping the old one'); return { changed: false, rejected: true }; }
    const bad = ls.get(K_BAD);
    if (bad && bad.code === text) return { changed: false, rejected: true };   // already known to crash on start
    const cur = ls.get(K);
    if (cur && cur.code === text) return { changed: false };
    ls.set(K, { code: text, ts: Date.now() });
    return { changed: true };
  }
  function pending() { const cur = ls.get(K); return !!(cur && cur.code && running != null && cur.code !== running); }
  function readyVersion() {
    const cur = ls.get(K), m = cur && cur.code && /version:\s*'([0-9][0-9.]*)'/.exec(cur.code);
    return m ? m[1] : '';
  }
  function toastOnce(tries) {
    if (toasted) return;
    if (root.Core && root.Core.ui && root.Core.ui.toast) {
      toasted = true;
      root.Core.ui.toast('Core updated — click here to reload', true, 12000, () => root.location.reload());
    } else if ((tries || 0) < 40) setTimeout(() => toastOnce((tries || 0) + 1), 500);
  }
  function revalidate() {
    check().then(() => { if (pending()) toastOnce(0); }).catch(() => { /* offline or GitHub down: keep what we have */ });
  }
  // A copy that is still alive a few seconds after start is remembered as the last good one.
  function rememberGood(code) {
    setTimeout(() => {
      if (!started()) return;
      const good = ls.get(K_GOOD);
      if (!good || good.code !== code) ls.set(K_GOOD, { code, ts: Date.now() });
    }, 4000);
  }

  root.__coreBoot = { version: '4.0.0', url: CORE_URL, check, pending, readyVersion };

  const saved = ls.get(K);
  if (saved && saved.code) {
    running = saved.code;
    let ok = start(saved.code);
    if (!ok) {
      // The newest copy crashed on start: set it aside and fall back to the last one that worked.
      const good = ls.get(K_GOOD);
      ls.set(K_BAD, { code: saved.code, ts: Date.now() });
      if (good && good.code && good.code !== saved.code) {
        ls.set(K, good);
        running = good.code;
        ok = start(good.code, 'last-good');
      }
    }
    if (ok) rememberGood(running);
    revalidate();
  } else {
    // First ever load: nothing saved, so this is the one time we have to wait for the network.
    fetchText(CORE_URL).then((text) => {
      if (!parses(text)) throw new Error('core.js does not parse');
      ls.set(K, { code: text, ts: Date.now() });
      running = text;
      if (start(text)) rememberGood(text);
    }).catch((err) => warn('could not load core.js (will try again on the next page)', err));
  }
})(window);
