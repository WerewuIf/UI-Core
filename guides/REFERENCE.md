# Core — developer & AI guide

One file for people and AIs who maintain or extend Core. (End-user setup is in `README.md`.)

**Handing the project to an AI:** paste this whole file into the new chat and upload the repo zip. Say what you want changed. It has everything needed; don't re-explain the project. The AI should read this guide and `README.md`, syntax-check what it changes, and test before reporting.

1. [What this is](#1-what-this-is)
2. [Repo layout and current versions](#2-repo-layout-and-current-versions)
3. [How Core works](#3-how-core-works)
4. [Updates and deployment (read twice)](#4-updates-and-deployment-read-twice)
5. [Working with the owner](#5-working-with-the-owner)
6. [Make an addon in 3 steps](#6-make-an-addon-in-3-steps)
7. [How an addon runs](#7-how-an-addon-runs)
8. [Floating buttons — `Core.float`](#8-floating-buttons--corefloat)
9. [Recipes](#9-recipes)
10. [API lookup](#10-api-lookup)
11. [Manifest (`addons.json`)](#11-manifest-addonsjson)
12. [Rules and gotchas](#12-rules-and-gotchas)
13. [Site knowledge (from real pages)](#13-site-knowledge-from-real-pages)
14. [Pets: sigils, orb, Equipped badge, apply](#14-pets-sigils-orb-equipped-badge-apply)
15. [How to work on a change, what is verified, ideas](#15-how-to-work-on-a-change-what-is-verified-ideas)
16. [Brief for an AI that is writing an addon](#16-brief-for-an-ai-that-is-writing-an-addon)

---

## 1. What this is

**Core** is a Tampermonkey userscript system for the browser game at `https://demonicscans.org` (the game calls itself "Veyra"). The owner (GitHub: **WerewuIf**) previously ran five separate userscripts. They are now one tiny bootstrap (`core.user.js`) that loads `core.js` (the real Core), which in turn loads "addons": plain `.js` files hosted in the owner's public GitHub repo and fetched by URL at runtime. Everything is client-side convenience tooling (presets, layout tweaks). There is no server code.

The owner is a game player maintaining this for themselves and a few friends. They are not a professional developer. They write tersely with typos; read for intent. They paste real page HTML and screenshots from the live game, which are your ground truth.

---

## 2. Repo layout and current versions

Repo: `https://github.com/WerewuIf/UI-Core` (public, branch `main`).

```
core.user.js          TINY BOOTSTRAP (v4.0.1). The only thing installed in Tampermonkey. Loads core.js, caches it, swaps in new versions on the next load
core.js               the real Core: loader + toolbox (plain script, not a userscript, ~55 KB). Found at the repo root OR in addons/ (the bootstrap tries both)
addons.json           manifest: the list of addons (id, name, version, url, optional match/early)
addons/
  crystal-presets.js  💎 Crystal Presets (power-crystal setups per equipment piece)
  gear-presets.js     ⚔️ Gear Presets (equipment sets) + site quick-set integration
  pet-presets.js      🐾 Pet team presets: slots, links, sigils, elemental orb, Equipped badge
  ui-cleanup.js       layout tidy + reminders on guild/home/battle pages (page-matched)
  battle.js           battle page restructure + AutoSlash (page-matched, early)
examples/addon-template.js   annotated starter for new addons
README.md             BASIC end-user guide (install, use, troubleshoot). Keep it basic
REFERENCE.md          this guide
```

Versions: Core **3.8.1** (`version:` in `core.js`; ⚙️ shows "Core v3.8.1"), bootstrap **4.0.1**, crystal 1.5.0, gear 3.2.0, pet **2.7.0**, ui-cleanup 2.2.0, battle 15.10.

Recent changes (all tested): Elemental Orb slot; hover ⋯ menus; loader rewrite (instant start from saved copy); Equipped badge that matches pets, links, sigils and orbs exactly on all three teams; apply on an already-matching team finishes at once, with request timeouts; one **Check for updates** button; Core updates itself like an addon; page scroll lock while a modal is open; `Core.me` (stamina, level, exp, gold, server clock, pid from the top bar) and `Core.csrf` (one registry for CSRF tokens); `Core.keepAlive` (Web Lock + loopback WebRTC + silent audio, to keep a background tab alive), `Core.lock` (Web Lock hold/steal/release/elect) and `Core.tab` (main-tab / idle-tab election with take-over, built on Core.lock). Addons not yet migrated to them: pet-presets still keeps its own sigil token.

---

## 3. How Core works

`core.js` does two jobs:

1. **Loads addons.** An addon is a plain `.js` file on GitHub. Core downloads it, caches it, and runs it on the right pages.
2. **Gives every addon the same toolbox**, so addons don't each re-implement toasts, modals, page fetching, caching, storage or floating buttons.

```
Tampermonkey ── core.user.js ──► core.js ──► Core (window.Core)
                                   │   reads addons.json, loads each addon with `Core` in scope
        ┌──────────────────────────┼───────────────────────────┐
   Core.float  buttons + panels    Core.net / Core.pages       Core.store / state / on·emit
   Core.ui     toast modal menu    cached, shared page fetches  saved settings, events
   Core.dom    shared observer     Core.cookies  cookie lock    Core.player  player id
        ▲
   addons/crystal-presets.js · gear-presets.js · pet-presets.js · ui-cleanup.js · battle.js · yours.js
```

What this buys you:

- **One floating row.** Every addon with UI adds its own button through `Core.float.add()`. Core draws the button in a shared dock, owns the modal, and keeps the dock clear of the site's own fixed buttons. There is **no hub** (the owner rejected one).
- **One page cache.** Two addons asking for `inventory.php` cause one request; the cache is dropped after your own POSTs (in all open tabs).
- **One place for "who/what am I" and CSRF.** `Core.me` reads the player's numbers from the site's top bar (and remembers them for pages without one); `Core.csrf` holds every CSRF token source. Addons should use these instead of reading the page themselves (that is how the pid bug happened).
- **One of everything else:** one toast, one modal stack, one cookie lock, one DOM observer, one storage layer.
- The three presets addons keep their original storage keys so players' data carries over: `pcPresets_<pid>`, `gearPresets_<pid>`, `petPresets_<pid>`. **Never change those keys or the preset data shape in a breaking way.**
- Globals, CSS and storage are prefixed `Core` / `core-` / `core:` (originally "DS"; the owner disliked that name, `ds:` keys are obsolete).
- The loader runs addons with `Core` in scope (`new Function`, falling back to an inline script if the site's CSP blocks eval).

---

## 4. Updates and deployment (read twice)

| Code lives in | Reaches users how |
|---|---|
| `addons/*.js` | automatically. Each saved addon is re-checked on (almost) every load (throttled to once a minute, content-compared; GitHub's raw CDN can lag ~5 min). **No `addons.json` change is needed.** |
| `core.js` | automatically, same way, via the bootstrap |
| `core.user.js` (bootstrap) | rarely changes. If it does: bump `@version`, push; Tampermonkey updates it about daily, or reinstall / paste |
| `addons.json` | read on every load. Change it only to add/remove an addon, or change `name`/`match`/`early`/`url`. **If you don't touch it, every addon that is already listed still updates by itself**; what you lose is only: a brand-new addon is not found, a removed one keeps running, and changes to `match`/`early`/`url`/`name` are not applied. Its `version` is just a label (shown in ⚙️) and an optional "fetch this right now" nudge, never required |

How an update lands: a saved copy always starts instantly (the page never waits on GitHub, even if GitHub hangs). In the background the loader fetches the newest file; if it differs, it is saved, and a toast says *"… updated — click here to reload"* (or *"Core updated — click here to reload"*). The next load runs it. A manifest `version` that differs from the saved copy still triggers an immediate fetch, but is optional. ⚙️ shows the version that is RUNNING, and `(vX ready)` when a newer one is saved.

**Check for updates (⚙️)** is the single manual control (there is no per-addon refresh and no Clear cache). It re-reads the manifest, fetches Core and every enabled addon that applies to the current page, compares with the saved copies, and says *"Everything is up to date"* or *"Update ready: Core, Pet Presets — click here to reload"*. Addons that don't match the current page (state "skipped") were never downloaded and are left out, so they can't show a false "update ready".

**Core's bootstrap** (`core.user.js`): looks for `core.js` at the repo root, then in `addons/`. Never saves a `core.js` that doesn't parse. If a saved copy throws on start it is set aside (`coreboot:bad`) and the last copy that survived 4 s (`coreboot:good`) runs instead. Keys: `coreboot:code|good|bad`. The first-ever load is the only time the page waits on GitHub.

Deployment facts:
- Manifest default is in `core.js` (`CONFIG.manifest`): `https://raw.githubusercontent.com/WerewuIf/UI-Core/main/addons.json`. Addon URLs in it are relative to it. Install link for users: `https://raw.githubusercontent.com/WerewuIf/UI-Core/main/core.user.js`.
- **CORS trap:** `github.com/<u>/<r>/raw/...` (GitHub's "Copy raw file") is a redirect the game's site blocks. Core rewrites `github.com/.../raw|blob/...` to `raw.githubusercontent.com/...` (`normalizeUrl`) and falls back to a saved copy if the network fails or the URL changed. Keep both.
- Users must turn off the old standalone scripts or everything runs twice.
- Optional hardening: `sha256` per addon in the manifest. **Security:** whoever can push to the repo runs code inside players' logged-in sessions (addons AND Core). Use 2FA.
- Don't assume a code change is live; say which file it lives in and what to push.

---

## 5. Working with the owner

- **Do not restyle panels/dialogs.** An earlier AI restyled all modal/panel CSS to the game's colours; the user said "revert the css styles, the UIs themselves are fine". The panels keep their original blue-gradient look (`.core-*`, `.pcp-*`, `.gp-*`, `.pp-*`). Only the **floating buttons** copy the game's own rounded ⚔️/🧪 buttons (exact computed style; see §13).
- **One scroller per modal** (the modal card), no nested scroll areas on the top-level panel, and **no visible scrollbars** in modals.
- README = **very basic end-user guide** (no repo/owner/manifest/hardening talk).
- No regex field in the addon manager's "Add by URL" (removed; the manifest `match` field still exists and is used by ui-cleanup/battle).
- "Exact fixes please": minimal, targeted changes; do not rewrite working logic. Addon logic was ported by exact-match patches; only plumbing changed.
- They hate vague claims: **verify in a browser and say what was and was not verified.** They get frustrated by "it should work".
- Finish the whole job in one turn; they have had to say "continue/finish" when a turn ended early. Do the code, tests, docs and packaging together.
- Deliver the changed files (and a zip of the repo when many changed).
- Brevity in the final message: what changed, what was verified, what to do (which files to push), and what is unverified.

---

## 6. Make an addon in 3 steps

**1. Copy `examples/addon-template.js`** to `addons/my-addon.js`. The smallest useful addon is this:

```js
Core.float.add({
  id: 'my-addon', title: 'My Addon', icon: '🔧', order: 50,
  async render(el) {
    const doc = await Core.pages.inventory('attack');          // cached, shared with every addon
    el.replaceChildren(Core.ui.h('p', {}, 'Slots: ' + doc.querySelectorAll('.slot-box').length));
  },
});
```

That's a 🔧 button in the floating row that opens a panel.

**2. List it in `addons.json`:**

```json
{ "id": "my-addon", "name": "My Addon", "version": "1.0.0", "url": "addons/my-addon.js" }
```

Add `"match": "^/pets\\.php"` if it only belongs on certain pages (§11).

**3. Commit, then reload the site twice** (the first reload fetches the new manifest, the second runs the addon). After that, edits to the file are picked up on their own; no `addons.json` change is needed (see §4).

To test before committing: ⚙️ → **Add by URL** with a `http://localhost:8000/addons/my-addon.js` URL (`python3 -m http.server 8000`). Addons served from localhost, 127.x, 192.168.x or 10.x are always fetched fresh (there is no dev-mode switch any more), so a reload picks up every edit.

---

## 7. How an addon runs

- An addon is a **plain script**: no `==UserScript==` header, no `@require`, no `import`.
- `Core` is in scope as a variable (and is `window.Core`).
- It runs in **page scope**, so the site's own globals (`BATTLE_CFG`, `CURRENT_TEAM`, `window.pickCrystal`, …) are reachable by bare name.
- Top-level `const`/`let`/`function` in your file are private to it. They don't leak into the page or collide with other addons.
- When it runs: at `DOMContentLoaded` by default. With `"early": true` in the manifest, at `document-start` (needed for anything that must change the page before it renders; `<body>` may not exist yet, so use `Core.dom.ready` / `Core.dom.when`).
- Addons run in the order listed in `addons.json`.
- If it throws, only that addon fails. The ⚙️ manager shows a red row with the error.
- Updates apply on the **next** page load, never mid-page. Core shows *"Addon … updated — reload to apply"*.

Optional structure: `Core.module({...})` (§10) adds dependencies on other addons and a public API between addons. A plain script doesn't need it.

---

## 8. Floating buttons — `Core.float`

This is the single, central way to put a button on screen. **Do not** create your own `position:fixed` button.

```js
const ctl = Core.float.add({
  id: 'my-addon',            // required, unique
  title: 'My Addon',         // tooltip + panel title
  icon: '🔧',                // button face (emoji or short text)
  order: 50,                 // position in the row: LOWER = FURTHER RIGHT
  width: 860,                // panel width in px (default 860)

  render(el, Core, api) {},  // fill `el`. Runs EVERY time the panel opens
  onShow(el) {},             // after render
  onHide() {},               // when the panel closes (✕, Esc, click outside, Core.float.close)
});
```

Button only, no panel:

```js
Core.float.add({ id: 'quick-sell', icon: '💰', title: 'Sell junk', order: 60, onClick: () => sellJunk() });
```

Control it from anywhere:

| Call | |
|---|---|
| `Core.float.add(def)` | register; returns `{ id, button, open, close, refresh, remove }` |
| `Core.float.open(id)` / `close(id)` | open or close that panel (e.g. another addon's, or your own after an action) |
| `Core.float.closeAll()` | close every panel |
| `Core.float.refresh(id)` | re-run `render()` if that panel is open |
| `Core.float.remove(id)` | remove the button and panel |
| `Core.float.list()` / `get(id)` | ids registered / a controller |

**Order slots in use** (pick a free number; gaps are fine):

| order | id | button |
|---|---|---|
| 10 | `crystal-presets` | 💎 Crystal Presets |
| 20 | `gear-presets` | ⚔️ Gear Presets |
| 30 | `pet-presets` | 🐾 Pet Presets |
| 900 | `addons` | ⚙️ Addon manager (built into Core) |

Use 40–800 for new addons. The ⚙️ manager always stays furthest left.

**Notes**

- The button is an exact copy of the site's own rounded ⚔️ / 🧪 buttons and sits level with them. Core keeps the row clear of the page's other fixed buttons and on screen; on narrow screens it stacks above the site's row. You never position anything.
- Add the button **once per page load**. A duplicate `id` is ignored with a console warning.
- `render` runs on every open, so build fresh each time. If your panel is expensive or has long-lived DOM that other code looks up by `getElementById`, build it once, keep it in a hidden holder, and in `render` do `el.replaceChildren(panel)`, then put it back in `onHide`. The Crystal, Gear and Pet addons do exactly this.
- A `Core.module({ ..., float: { render, onShow, onHide, order } })` registers its button for you (§10).
- Sub-dialogs inside your panel (editors, pickers): use `Core.ui.modal()`, which stacks above the panel automatically. If you build your own modal DOM instead, give it `z-index` above ~100100 (the existing addons use 300000), or it opens behind the panel.

---

## 9. Recipes

### Read another page of the site
```js
const doc  = await Core.pages.inventory('pvp_attack');                 // inventory.php?set=pvp_attack
const text = await Core.net.fetchText('/some_page.php?x=1', { ttl: 60000 });
const mine = Core.pages.define('/guild_shop.php');                      // your own accessor
const shop = await mine();
```
`Core.pages.*` returns the **live `document`** when you're already on that page, otherwise a cached fetched copy. `fetchDoc` gives every caller its own fresh `Document`, so mutating yours can't affect anyone else.

### Send a form POST
```js
const r = await Core.net.post('/inventory_ajax.php', { action: 'equip', id: 123 });
if (!r.ok) return Core.ui.toast('Failed: HTTP ' + r.status, false);
console.log(r.json);        // parsed response or null
```
Matching cached pages are invalidated for you (built-in rules in §10).

### React to what the site does (free, no extra requests)
```js
Core.net.watch(/inventory_ajax\.php/, ({ method, body, json }) => { /* update badges */ });
```
Only sees `fetch()` calls, not classic form submits or `XMLHttpRequest`.

### Change a page
```js
Core.dom.watch(() => {
  const el = document.querySelector('.some-panel');
  if (!el || el.dataset.done) return;
  el.dataset.done = '1';            // idempotent!
  el.style.display = 'none';
});
const el = await Core.dom.when('#late-element');   // resolves null after 15 s
```
One shared observer serves every addon; don't create your own `MutationObserver` on `document`.

### Save settings or data
```js
const cfg = Core.store('my-addon', { def: { sound: true } });
cfg.get().sound;  cfg.set({ sound: false });  cfg.update((c) => { c.sound = !c.sound; });
cfg.watch((v) => { /* changed here or in another tab */ });
```
Stored per player as `core:<playerId>:my-addon`. To keep an **existing** localStorage key (so saved data from an old script survives): `Core.store('x', { key: 'pcPresets_' + pid })`; `key` may be a function.

### Toast, menu, dialog
```js
Core.ui.toast('Saved', true);                  // second arg false = red
Core.ui.menu(buttonEl, [{ label: 'Rename', onClick: rename }, { label: 'Delete', danger: true, onClick: del }]);
Core.ui.modal({ id: 'confirm', title: 'Sure?', body: 'This cannot be undone.',
  actions: [{ label: 'Cancel', kind: 'soft', close: true }, { label: 'Delete', kind: 'danger', onClick: del, close: true }] }).open();
```

### Build DOM
```js
const { h, btn } = Core.ui;
el.append(h('div', { class: 'core-row' }, h('input', { class: 'core-input', placeholder: 'Name' }), btn('Save', 'success', save)));
```
Classes available inside panels: `core-btn` (`-soft` `-success` `-danger`), `core-input`, `core-row`, `core-dim`, `core-empty`, `core-err`, `core-pill`.

### Fetch pages filtered by the monster cookies
```js
const html = await Core.cookies.withMode('alive', () => fetch('/guild_dash.php', { credentials: 'include' }).then((r) => r.text()));
```
`'alive' | 'dead' | 'all'`. The cookies are browser-wide, so Core serialises this across **all tabs** and always restores them. Never touch those cookies yourself.

### Let addons talk to each other
```js
Core.on('my-addon:changed', (data) => { /* any addon */ });     // listen
Core.emit('my-addon:changed', { id: 1 });                       // this tab
Core.emit('my-addon:changed', { id: 1 }, { shared: true });     // also your other tabs
Core.state.set('lastBoss', 42);  Core.state.watch('lastBoss', (v, old) => {});   // in-memory, this page
```
For a proper dependency (use another addon's functions) use `Core.module` + `Core.use` (below).

### A module with a public API and a dependency
```js
Core.module({
  id: 'price-tools', name: 'Price Tools', icon: '💰', version: '1.0.0',
  deps: ['crystal-presets'],                 // waits for these; skipped if they failed
  float: { order: 60, render(el, Core, api) { el.textContent = api.total(); } },   // optional button + panel
  init(Core, ctx) {                          // may be async
    const s = ctx.store('stats', { def: { n: 0 } });   // auto-namespaced storage
    ctx.log('ready');
    return { total: () => s.get().n };       // becomes the public API
  },
});
// elsewhere:  const api = await Core.use('price-tools');   // null if missing/failed      Core.get('price-tools') // sync
```

---

## 10. API lookup

Everything is on `Core`.

### `Core.float` — see §8

### `Core.pages` / `Core.net`

| Call | |
|---|---|
| `pages.inventory(set='attack', opts)` | `inventory.php?set=` — `attack` \| `pvp_attack` \| `defense` |
| `pages.pets(team='attack', opts)` | `pets.php?team=` — same three values |
| `pages.crystals() stats() pvp() quests() battlePass() dungeons()` | the matching pages |
| `pages.define(path, param?, default?)` | build your own accessor |
| `net.fetchText(url, {ttl, force, key, via})` | cached, de-duplicated GET → text. `ttl` ms (default 30 000); `force` skips the cache; `via(run)` wraps the request |
| `net.fetchDoc(url, opts)` / `fetchJson(url, opts)` | same, parsed |
| `net.post(url, params, {json})` | → `{ ok, status, text, json }`; fires invalidation rules |
| `net.invalidate(stringOrRegex?)` | drop cache entries in **every tab** (no argument = all) |
| `net.invalidateOn(whenRegex, dropRegex, bodyRegex?)` | "when a POST hits X, forget cached pages matching Y" |
| `net.watch(regex, cb, {method})` | observe the site's own `fetch` calls |

Built-in invalidation: `inventory_ajax.php` → inventory + pets pages · `power_crystals.php` → crystals page · `pet_link_action.php` / `pet_sigil_action.php` → pets page · `adventurers_(accept|finish|giveup|donate)` → guild page.
All `pages.*` accept `{ fetch: true }` (force a fetched copy even when you're on that page) and `{ force: true }` (bypass the cache).

### `Core.ui`

| Call | |
|---|---|
| `toast(msg, ok=true, ms=3000)` | one shared toast; safe before `<body>` exists |
| `modal({id, title, width, body, actions, onOpen, onClose})` | stackable; same `id` returns the same instance. Methods: `open() close() setBody() setTitle() setActions()`, props `el`, `isOpen` |
| `menu(anchorEl, [{label, onClick, danger}])` | toggling dropdown under an element |
| `h(tag, props, ...kids)` | create DOM. props: `class`, `style` (object), `html`, `onclick`…, any attribute |
| `btn(label, kind, onClick)` | `kind`: `soft` \| `success` \| `danger` \| null |
| `css(id, text)` | inject a `<style>` once per `id` |
| `dock.add / dock.remove` | low-level floating row used by `Core.float`. Use `Core.float` instead |

### Data, state, events, DOM

| Call | |
|---|---|
| `store(ns, {def, key})` → `{get, set, update, watch}` | persistent JSON, per player, synced across tabs |
| `state.get/set/update/watch` | in-memory, this page only |
| `on / once / off / emit(evt, data, {shared})` | event bus |
| `player.id()` | player id. Tries the sidebar link, then `expPotionSettings.userId`, then the event page's `#ecConfig`, then the last id seen. **Use this, not your own lookup**, or your addon will see a different id on pages without a sidebar |
| `me.get()` | snapshot `{ pid, stamina:{cur,max,regen,nextTickAt}, gold, level, exp:{cur,max,pct}, server:{tzoff,skew}, stale, ageMs }`. Read live from the top bar (`.gtb-inner`); on pages without it, the last saved values with `stale:true`. Gems are not read |
| `me.staminaEstimate(now?)` | stamina now. For a stale snapshot it adds the hourly regen that must have happened since (capped at max). An estimate |
| `me.serverNow()` · `me.secondsToTick()` | the server's clock in ms (offset measured on the last top-bar page); seconds to the next top of the hour on the server's own clock (stamina tick) |
| `me.watch(cb)` · `on('me:update', cb)` | fires when stamina, level, exp or gold really change (not on the ticking timer/clock) |
| `csrf.register(name, {get, page, re, field, expired})` | declare where a token comes from: a page global (`get`), or a page + regex (`page`, `re`) to refetch it, the form `field` POSTs use (null = read-only), and what an expired reply looks like |
| `csrf.get(name)` · `csrf.set(name, token)` · `csrf.refresh(name)` | current token (cached, else the page global) · store one you got from an ajax reply · refetch it from its page |
| `csrf.post(name, url, params)` | POST with the token added; if the reply says it expired (`code:'csrf_expired'` or the `expired` regex) it refreshes and retries **once**. Built-ins: `petSigil` (`PET_SIGIL_CSRF` on `/pets.php`, field `csrf_token`), `expPotion` (`expPotionSettings.csrf`, read-only until its field name is known) |
| `keepAlive.start({lock, rtc, audio})` | keep a background tab from being throttled/frozen/discarded. All three default to true; idempotent; resolves to `status()`. Port of the Ascension Assistant / Cube Suite technique. **Only call it in the tab that really works in the background** (an automation tab), not on every page |
| `keepAlive.stop()` · `keepAlive.status()` | stop everything · `{ lock:bool, rtc:'open'\|'connecting'\|'closed'\|'off', audio:'running'\|'suspended'\|'off' }`. `audio:'suspended'` means the browser has not allowed sound yet; it retries every 15 s and on any click/keypress in the tab |
| `keepAlive.startLock/stopLock` · `startRtc/stopRtc` · `startAudio/stopAudio` | each signal on its own. `lock` = a never-resolving Web Lock named per tab (no gesture needed); `rtc` = loopback RTCPeerConnection data channel, reopened if it closes; `audio` = 20 Hz oscillator at gain 0.001 |
| `lock.hold(name, opts, onLost)` | Promise&lt;boolean&gt;: true once THIS tab holds the Web Lock `name` (kept until `release` or the tab dies). `opts` = `navigator.locks.request` options: `{}` waits in line, `{ifAvailable:true}` resolves false at once if taken, `{steal:true}` takes it (the old holder gets its `onLost`). No Web Locks support: resolves false, never hangs |
| `lock.release(name)` · `held(name)` · `available()` · `query(name)` | release · does this tab hold it · is `navigator.locks` there · `Promise<{held, pending}>` |
| `lock.elect(name, {onLead, onFollow, onLost})` | single-tab election: resolves `'leader'` or `'follower'`; followers are queued and promoted (`onLead`) automatically when the leader's tab closes or crashes. Without Web Locks every tab is a leader. Use `hold` with `steal:true` instead when a newly opened tab should take over |
| `tab.join(name, {onMain, onIdle, queue, steal, keepAlive, retries})` | Promise&lt;'main'\|'idle'&gt;: one tab is MAIN (does the work), the others IDLE, decided by an exclusive Web Lock (like the Assistant's main tab / Cube Suite's primary tab). `onMain`/`onIdle` fire on every role change. `queue:true` = idle tabs wait in line and are promoted automatically the moment the main tab closes/crashes (Cube Suite style); default = they stay idle until someone calls `takeOver` (Assistant style). `steal:true` = take main from the current holder at join. `keepAlive:true` (or `{lock,rtc,audio}`) runs `Core.keepAlive` only while this tab is main. `retries` = waits in ms between tries (default `[0,500,1500]`, so a reloading main can beat its own dying page) |
| `tab.takeOver(name)` | Promise&lt;boolean&gt;: steal main (old main gets `onIdle`); a "Use this tab" button. A queued tab leaves the queue and jumps the line |
| `tab.role(name)` · `isMain(name)` · `leave(name)` · `onRole(name, cb)` | `'main'`/`'idle'`/null · boolean · give up main or stop waiting (the lock goes to the next in line) · listen for role changes (returns unsubscribe); also `Core.on('tab:role', {name, role})` |
| `cookies.withMode(mode, fn)` | see recipe |
| `dom.watch(fn, {for, immediate})` · `dom.when(sel, timeout)` · `dom.ready` | shared observer · wait for element · DOM-ready promise |
| `esc sleep debounce fmt int compact parseJson` | small utilities |

### Modules

`Core.module({ id, name, icon, version, match, deps, early, float, init(Core, ctx) })` · `Core.use(id)` (async) · `Core.get(id)` (sync).
`ctx` = `{ id, store(ns, opts), float(def), log(...) }`. `match` here is a RegExp / string / function; it's separate from the manifest `match`.

### Console

`Core.status()` (module table) · `Core.addons.status` (loader state per addon) · `Core.debug = true` (verbose) · `Core.net.cacheSize` · `Core.float.list()`.

---

## 11. Manifest (`addons.json`)

```json
{
  "addons": [
    { "id": "ui-cleanup", "name": "UI Cleanup", "version": "2.2.0",
      "url": "addons/ui-cleanup.js",
      "match": "^/(guild_dash\\.php|game_dash\\.php)",
      "early": false,
      "sha256": "optional hex digest" }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | unique; also the cache key (`core:code:<id>`) and the enable/disable key |
| `url` | yes | absolute, or relative to `addons.json` |
| `name`, `version` | no | display only. **Not needed for updates**: changed files are picked up on their own (§4). Bumping `version` just makes the update apply on the very next load and updates the label in ⚙️ |
| `match` | no | regex string (or array) tested against `pathname + search`. **No match = the file isn't even downloaded.** Omit = every page |
| `early` | no | `true` = run at document-start |
| `sha256` | no | refuse to run if the file's hash differs |

JSON needs doubled backslashes (`\\.`). Entries run in the order listed. "Add by URL" in ⚙️ with an existing `id` overrides that manifest entry in this browser only.

---

## 12. Rules and gotchas

- [ ] **Buttons come from `Core.float`**, never your own `position:fixed` element.
- [ ] **Never add your own scrollbar to a panel.** The modal card is the one scroller, and its scrollbar is hidden. Don't put `overflow:auto` + `max-height` on your top-level content. A bounded inner list (picker grid) is fine but hide its scrollbar too (`scrollbar-width:none` + `::-webkit-scrollbar{display:none}`).
- [ ] **A new modal class must be added to the page scroll lock** in `core.js` (`html:has(.core-modal.show, .pcp-modal.show, …){overflow:hidden}`), or the site's own scrollbar shows behind it and the page scrolls underneath.
- [ ] **Get the player id from `Core.player.id()`.** Some pages (e.g. the event map) have no sidebar, so a hand-rolled lookup returns the wrong id there and your saved data looks empty.
- [ ] **Idempotent DOM work.** `Core.dom.watch` re-runs your function after DOM changes; mark what you've done (`dataset`, a class) and bail out early.
- [ ] **Read through `Core.net` / `Core.pages`**, not raw `fetch` + `DOMParser`, so pages are shared and caches invalidate. (`fetch` is fine for POSTs the site itself would make; `Core.net.post` is nicer.)
- [ ] **Saved data goes in `Core.store`.** Pass `key` if you must keep an old key.
- [ ] **Don't touch `hide_dead_monsters` / `show_dead_bosses_only` cookies directly.** Use `Core.cookies.withMode`.
- [ ] **No `window.confirm`-style blocking when you can avoid it.** Prefer `Core.ui.modal` (the existing addons still use `confirm` in places).
- [ ] **Scope CSS.** Prefix your class names (`ma-…` for "my addon") and inject once via `Core.ui.css('my-addon', '…')`.
- [ ] **`early: true` means no `<body>` yet.** Wrap DOM access in `Core.dom.ready` / `Core.dom.when`.
- [ ] **Limit where it runs** with `match` in the manifest; it saves a download and avoids stray work on other pages.
- [ ] **Everything must work after a reload twice**: first load downloads, later loads run from cache.
- [ ] **Never put secrets in an addon.** It's a public file.
- [ ] **Go easy on the server.** Use the cache (`ttl`) and don't poll faster than you need.

Learned the hard way:

1. **Player id.** Most pages have `.side-drawer a[href*="player.php?pid="]`; the event map has no sidebar. `Core.player.id()` tries sidebar → `window.expPotionSettings.userId` → `#ecConfig` JSON `userId` → last seen id (`core:lastPid`) → `'default'`. A hand-rolled lookup made presets look empty (saved to `_default`).
2. **Dock placement.** The dock sits level with the site's buttons (`bottom:17px`), slides left in 4 px steps to clear fixed elements, and **stacks above** them on narrow screens (~390 px). It inspects small fixed *groups* (e.g. a column of zoom buttons) and ignores overlays/drawers (≥60% of the viewport). It must never run off-screen.
3. **Slow start / stale updates.** An old loader ignored a saved copy whose URL differed and waited out an 8 s fetch per addon (the "20 seconds"), and only re-checked every 10 minutes. Never reintroduce a network wait on the warm path.
4. **Silent long work looks stuck.** Apply on an already-matching team once re-read every link and sigil one request at a time with no step shown, and no request had a timeout. Show a step for anything slow and time out requests (`fetchTO`, `CFG.REQUEST_TIMEOUT_MS`).
5. **Page scroll.** Hidden modal scrollbars are not enough: the site's own scrollbar stayed visible beside the modal and the page scrolled underneath. Fixed with the `html:has(.core-modal.show, …){overflow:hidden}` lock plus `overscroll-behavior:contain` (needs Chrome 105+/Safari 15.4+/Firefox 121+; iOS not verified).
6. **"Not applicable" is not "updated".** An addon that doesn't match the page is never downloaded; don't flag it as an update.
7. `ui.css` before `<head>` exists defers until the DOM is available.

---

## 13. Site knowledge (from real pages)

**Floating-button style to copy** (site's `.quickset-drawer-trigger` / `.battle-drawer-trigger`): `display:flex; align-items:center; justify-content:center; gap:6px; background:#24263a; border:1px solid #2f324d; box-shadow:0 10px 24px rgba(0,0,0,.6); border-radius:12px; color:#fff; cursor:pointer; font-weight:700; font-size:14px; line-height:1.2; padding:10px 12px`; `:active{transform:scale(.97)}`; they sit at `bottom:17px` (⚔️ `right:120px`, 🧪 `right:65px`). The round ones: chat 💬 `right:14px;bottom:14px` 46px circle `#2a2b3a`; ☰ `left:14px;bottom:14px`.

**Top bar** (`stats.php` and the other pages with site chrome; this is what `Core.me` parses): `.gtb-inner` > `.gtb-left` with `.gtb-stat` blocks (`.gtb-icon`, `.gtb-label`, `.gtb-value`). Stamina: `#stamina_span` holds the current value and the same `.gtb-value` text continues " / 6,890" (max); `#stamina_timer` shows "⏳ 21:08" (mm:ss to the next regen) and its `title` is "Next +383 at the top of the hour" (the regen amount). The hour is the SERVER's local hour. Gold: the `.gtb-stat` labelled "Gold", value abbreviated like `3746394.603K` (K/M/B/T). `#server_time` has `data-epoch` (seconds, the moment the server rendered the page; the text then ticks by script) and `data-tzoff` (seconds east of UTC, e.g. 19800 = +5:30). Right side: `.gtb-level` "LV 5671", `.gtb-exp-top` second span "175,046,828 / 201,072,500", `.gtb-exp-fill` `style="width: 87%"`. There is also a Gems stat and a Buffs button (not read). The pid is not in the bar; it comes from the side drawer link (`Core.player.id()`).

**Keep-alive facts (from the owner's Ascension Assistant v3.7.0 and Cube Suite v2.7.8):** both hold a never-resolving `navigator.locks.request(name, {signal}, () => new Promise(()=>{}))`, run a 20 Hz oscillator at gain 0.001 and a loopback WebRTC data channel; the Assistant picks the one working tab with a Web Lock (`ifAvailable` to try, `steal` to take over, a queued request that is granted when the holder dies). These make a hidden tab far less likely to be frozen or discarded, but browsers give no guarantee, and the tests only use mocks; real behaviour has to be watched in Chrome. Audio only runs after the browser allows it (a click in the tab is enough).

**CSRF facts:** `pets.php` declares `const PET_SIGIL_CSRF = "…"` (readable by bare name from page scope; a page fetch + regex refreshes it); sigil replies carry `csrf_token`; pet link replies carry `csrf`; an expired sigil token replies `{status:'error', code:'csrf_expired', message:'Security token expired…'}`. Many pages set `window.expPotionSettings = {userId, csrf, items}`.

**Site CSS palette** (for reference only; see §5): dark card `#171923`, border `#2B2D44`, row `#12131a`/`#232437`, primary `#4b5ef5`, soft `#2a2b3a`/`#3b3d55`, success `#4caf50`/`#2ecc71`, danger `#e74c3c`, dim text `#9aa0b8`, text `#e0e4ff`.

**pets.php** (`/pets.php?team=attack|pvp_attack|defense`): sections titled "PvE Attack Team" / "PvP Attack Team" / "PvP Defense Team" and "🐾 Pet Inventory". Cards: `.slot-box.pet-card[data-pet-inv-id]` (+ `pet-card-legendary|epic|mythical`), `.pet-img-wrap img`, `.pet-stars-overlay`, `.pet-level`, `[data-attack]`, `[data-defense]`, `.pet-race b`, equipped cards have `unequipPet(slot)`, inventory cards `showEquipModal(id,'pet')`. **Sigil panel per card:** `.pet-sigil-slot.attack|defense|elemental` with `.filled` or `.empty-slot`; filled ones contain `.pet-sigil-copy b` (name) and `img` in `.pet-sigil-orb`; click calls `openPetSigilModal(petInvId, slotType)`. Endpoints: `GET pet_sigils_ajax.php?pet_inv_id=&slot_type=attack|defense|elemental` → `{status:'success', slot_label, pet:{name}, current, options:[{item_id,name,image_url,attack,defense,element,owned,equipped,available}], csrf_token, user_id}`; `POST pet_sigil_action.php` (`action=equip|remove`, `pet_inv_id`, `slot_type`, `item_id`, `csrf_token`; `data.code === 'csrf_expired'` means refetch). Links: `GET /pet_links_ajax.php?pet_inv_id=` and `POST /pet_link_action.php`. Equip/unequip pets: `POST inventory_ajax.php` (`action=equip_pet|unequip_pet`, `team`, `slot_id`, `pet_inv_id`) returns `OK`. Elemental orb copy on the page: "Overrides this pet's element to X while keeping its Element Rate". The page reads `const CURRENT_TEAM`, `PET_SIGIL_CSRF`, `PET_SIGIL_USER_ID`.

**Other pages:** `stats.php` has the full site chrome (topbar, side drawer, chat, quick-set + battle drawers). `event_page.php?event=11` (the Black Crown map) has no site chrome; it carries `<script id="ecConfig" type="application/json">{"userId":…}`. Many pages set `window.expPotionSettings = {userId, csrf, items}`. `power_crystals.php`, `inventory.php?set=attack|pvp_attack|defense`, `pets.php`, `stats.php`, `pvp.php`, `battle_pass.php`, `guild_dash.php`, `game_dash.php` are read via `Core.pages.*`.

---

## 14. Pets: sigils, orb, Equipped badge, apply

In `pet-presets.js`: `SIGIL_SLOTS = ['attack','defense','elemental']`, `SIGIL_LABELS`, `SIGIL_EMPTY_ICON`, `SIGIL_NONE()`, `sigilSlotOf(el)`. A preset stores `sigils: { <petInvId>: {attack, defense, elemental} }` (item ids) and `meta.sigils[itemId]` (name/image). **A missing slot key means "don't touch"** (that is how old presets stay safe). Capture (`captureCurrentToPreset`) loops `SIGIL_SLOTS` calling `fetchSigilInfo`. Restore (`restorePresetToTeam`) runs `sigilRemovalPass` (take off what shouldn't be there) then `sigilEquipPass`, using `findSigilHolder` / `findAllSigilHolders` for items worn by pets outside the preset (forced take-over, `CFG.FORCE_SIGILS`, default true; `CFG.TAKE_FROM_OTHER_TEAMS` for pets). DOM scanners (`scanSigilWearers`, `readCardSigilNames`, `collectSigilWearers`, `presetSigilsMatch`) classify slots by CSS class via `sigilSlotOf`; `installSigilOverride` hooks the page's own sigil modal. Editor chips: `buildSigilLayer` makes `.pp-sigil-layer` with two rows (`.pp-sigil-row`): row 1 = C, row 2 = A B; `pickerSigilChip` + `.pp-picker-sigil-line` mirror this in the link picker; `openSigilChooser` is the chooser dialog. To add another slot type: add it to the constants, give it a chip class/icon, and add a mock for it in your pets test page plus a test case.

**Equipped badge** (`computeEquippedMap`, `presetMatchesLive`, `sigilEntryMatches`): a preset row shows "Equipped · PvE Attack / PvP Attack / PvP Defense" only when that live team matches the preset **exactly**: same pets in the same slots, the same Link 1/2 pets, and the same Attack sigil, Defense sigil and Elemental Orb on every pet the preset describes (mains and their linked pets). Anything different, or unreadable, means no badge. All three teams are checked from any page, and a preset live on two teams shows both. A slot key the preset never recorded is not compared (so presets saved before the orb existed still show). A wanted item whose name can't be looked up counts as a mismatch. Live data comes from the team pages (team and inventory cards render their sigil panel), with `pet_links_ajax.php` for links and `pet_sigils_ajax.php` as a fallback for pets not on the page. The panel re-checks (forced) when opened and after applying.

**Apply** (`restorePresetToTeam`): reads all three team pages, then **checks `presetMatchesLive` first** and reports "already matches" immediately if so. Otherwise: unequip/pull pets, free linked pets, equip, then the "Checking links" and "Checking sigils and orbs" steps. Requests use `fetchTO` (30 s timeout).

---

## 15. How to work on a change, what is verified, ideas

1. Read the relevant code (grep first; the addons are huge). Prefer **exact-match patches** (`str.replace` with an `assert old in s`) over rewrites. Never touch logic you were not asked to touch.
2. `node --check` every changed JS file.
3. Reproduce the user's problem or write the new behaviour as a test **first when practical** (there is no test harness in the repo; small jsdom scripts for logic and Playwright/Chromium for layout and scrollbars work well, with `--hide-scrollbars` turned off so classic scrollbars are measurable), and confirm a test fails on the old code (run it against the old file). The owner values proof that the test can catch the bug. If the old code can't be exercised by the test (different DOM or API), say so instead of claiming it proves the bug.
4. Run the tests. Look at screenshots for anything visual.
5. Bump versions (`version:` in `core.js` if Core changed; `addons.json` is optional for addons, see §4). Update `README.md` (basic!) and this guide if behaviour or API changed.
6. Rebuild the zip, send the changed files, and say which of them the user must push.
7. Final message: what changed; what was verified and how; which file(s) to push; what is **not** verified.

Environment notes for a Linux sandbox: Playwright + Chromium are usually available (`/opt/pw-browsers`); `pip install` needs `--break-system-packages`; `jsdom` via `npm i`.

**Verified vs not verified**

**Verified** (headless Chromium + jsdom, mock pages from the real CSS/markup): loader (incl. self-updating Core bootstrap, manual update check, skipped-addon handling), float API, page scroll lock, dock style identical to the site's quick-set button, dock placement at 320–1280 px on two page types, single scroller, hidden scrollbars, crystal preview, pets capture/restore/forced take-over/old-preset safety/editor layout with the orb, GitHub URL normalisation, offline saved-copy fallback, player-id on sidebar-less pages.

**NOT verified** (no live access): real equip/restore round-trips on the live server; the site's real CSP; `event-core.css` (only layout approximated); the real HTML of `power_crystals.php`/`inventory.php` (crystal/gear scanners are the user's original, unmodified logic); real Elemental Orb behaviour server-side (restrictions such as pet level are unknown; the addon surfaces the server's error text); how things look with the real pet artwork. Say so when relevant.

**Ideas not done (only if the owner asks)**

A changelog panel in ⚙️; owner tooling to hash (`sha256`) addons automatically; gear presets for any new site slot types; making the first-load battle page flash-free.

---

## 16. Brief for an AI that is writing an addon

Paste this block, then describe what you want.

```
You are writing an ADDON for "Core", a Tampermonkey-based loader for demonicscans.org.
An addon is a plain .js file (no ==UserScript== header, no imports). The variable `Core` is in scope.
It runs in page scope on the pages matched in addons.json.

UI RULES
- Floating button + panel: Core.float.add({ id, title, icon, order, width, render(el, Core, api), onShow, onHide })
  (button only: { id, title, icon, order, onClick }). `order` lower = further right; use 40–800. Never create your own fixed button.
- Dialogs/menus/toasts: Core.ui.modal({id,title,body,actions}).open(), Core.ui.menu(anchor, items), Core.ui.toast(msg, ok).
- Build DOM with Core.ui.h(tag, props, ...kids) and Core.ui.btn(label, kind, onClick).
  Classes in panels: core-btn[-soft|-success|-danger], core-input, core-row, core-dim, core-empty, core-err, core-pill.
- Several tabs, one job: Core.tab.join(name,{onMain,onIdle,keepAlive:true}); tell other tabs things with Core.emit(evt,data,{shared:true}). Background tabs: Core.keepAlive.start() only in the tab that must keep running. Lowest level: Core.lock.hold/elect. Never start your own AudioContext/RTCPeerConnection/Web Lock keep-alive.
- Player numbers (stamina, level, exp, gold, server time, pid): Core.me.get(), never your own DOM reads. CSRF tokens: Core.csrf (register a source once, then Core.csrf.post). On a page without the site's top bar, Core.me.get().stale is true.
- Never give the top-level panel its own overflow/scrollbar (the modal card scrolls). Get the player id from Core.player.id().
- Prefix your own CSS classes; inject once with Core.ui.css(id, text).

DATA RULES
- Read site pages with Core.pages.inventory(set) / pets(team) / crystals() / stats() / pvp() / quests() / battlePass() / dungeons()
  or Core.net.fetchText/fetchDoc/fetchJson(url,{ttl,force}). They are cached and shared. Never write your own fetch+DOMParser loop.
- POST with Core.net.post(url, params). Observe the site's own fetches with Core.net.watch(regex, cb).
- Save data with Core.store(ns, { def, key? }) -> { get, set, update, watch } (per player, synced across tabs).
- Monster-cookie-dependent fetches go through Core.cookies.withMode('alive'|'dead'|'all', fn).
- DOM changes: Core.dom.watch(fn) (must be idempotent), Core.dom.when(selector), Core.dom.ready. No own MutationObserver on document.
- Events between addons: Core.on / emit; state: Core.state; dependencies: Core.module({ id, deps, float, init }) + Core.use(id).

DELIVER
1. addons/<id>.js
2. the addons.json entry: { "id", "name", "version", "url": "addons/<id>.js", "match"?: "regex string with doubled backslashes", "early"?: true }
Keep it one file, no external libraries, no localStorage keys outside Core.store, and state any page selectors you are assuming
so I can check them against the real HTML.
```
