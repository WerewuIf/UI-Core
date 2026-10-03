# Core — addon reference

How to build a new addon. Read §1–§3 and you can write one; the rest is lookup.
(Setup and day-to-day use are in `README.md`.)

1. [What Core is](#1-what-core-is)
2. [Make an addon in 3 steps](#2-make-an-addon-in-3-steps)
3. [How an addon runs](#3-how-an-addon-runs)
4. [Floating buttons — `Core.float`](#4-floating-buttons--corefloat)
5. [Recipes](#5-recipes)
6. [API lookup](#6-api-lookup)
7. [Manifest (`addons.json`)](#7-manifest-addonsjson)
8. [Rules and gotchas](#8-rules-and-gotchas)
9. [Brief for an AI that is writing an addon](#9-brief-for-an-ai-that-is-writing-an-addon)

---

## 1. What Core is

**Core** is the one userscript you install (`core.user.js`). It does two jobs:

1. **Loads addons.** An addon is a plain `.js` file on GitHub. Core downloads it, caches it, and runs it on the right pages.
2. **Gives every addon the same toolbox**, so addons don't each re-implement toasts, modals, page fetching, caching, storage or floating buttons.

```
Tampermonkey ── core.user.js ──► Core (window.Core)
                                   │   reads addons.json, loads each addon with `Core` in scope
        ┌──────────────────────────┼───────────────────────────┐
   Core.float  buttons + panels    Core.net / Core.pages       Core.store / state / on·emit
   Core.ui     toast modal menu    cached, shared page fetches  saved settings, events
   Core.dom    shared observer     Core.cookies  cookie lock    Core.player  player id
        ▲
   addons/crystal-presets.js · gear-presets.js · pet-presets.js · ui-cleanup.js · battle.js · yours.js
```

What this buys you:

- **One floating row.** Every addon with UI adds its own button (💎 ⚔️ 🐾 …) through `Core.float.add()`. Core lays them out and keeps them clear of the site's own fixed buttons. A new addon needs no placement code.
- **One page cache.** Two addons asking for `inventory.php` cause one request. The cache is dropped automatically after your own POSTs (in all open tabs).
- **One of everything else:** one toast, one modal stack, one cookie lock, one DOM observer, one storage layer.

Naming: the global is `Core`; CSS classes and storage keys are prefixed `core-` / `core:`. The word "Core" appears only as that identifier, so renaming it later is a find-and-replace.

---

## 2. Make an addon in 3 steps

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

Add `"match": "^/pets\\.php"` if it only belongs on certain pages (§7).

**3. Commit, then reload the site twice** (the first reload fetches the new manifest, the second runs the addon).

To test before committing: ⚙️ → **Add by URL** with a `http://localhost:8000/addons/my-addon.js` URL (`python3 -m http.server 8000`), and tick **Dev mode** so it always fetches fresh.

---

## 3. How an addon runs

- An addon is a **plain script**: no `==UserScript==` header, no `@require`, no `import`.
- `Core` is in scope as a variable (and is `window.Core`).
- It runs in **page scope**, so the site's own globals (`BATTLE_CFG`, `CURRENT_TEAM`, `window.pickCrystal`, …) are reachable by bare name.
- Top-level `const`/`let`/`function` in your file are private to it. They don't leak into the page or collide with other addons.
- When it runs: at `DOMContentLoaded` by default. With `"early": true` in the manifest, at `document-start` (needed for anything that must change the page before it renders; `<body>` may not exist yet, so use `Core.dom.ready` / `Core.dom.when`).
- Addons run in the order listed in `addons.json`.
- If it throws, only that addon fails. The ⚙️ manager shows a red row with the error.
- Updates apply on the **next** page load, never mid-page. Core shows *"Addon … updated — reload to apply"*.

Optional structure: `Core.module({...})` (§6) adds dependencies on other addons and a public API between addons. A plain script doesn't need it.

---

## 4. Floating buttons — `Core.float`

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

- Add the button **once per page load**. A duplicate `id` is ignored with a console warning.
- `render` runs on every open, so build fresh each time. If your panel is expensive or has long-lived DOM that other code looks up by `getElementById`, build it once, keep it in a hidden holder, and in `render` do `el.replaceChildren(panel)`, then put it back in `onHide`. The Crystal, Gear and Pet addons do exactly this.
- A `Core.module({ ..., float: { render, onShow, onHide, order } })` registers its button for you (§6).
- Sub-dialogs inside your panel (editors, pickers): use `Core.ui.modal()`, which stacks above the panel automatically. If you build your own modal DOM instead, give it `z-index` above ~100100 (the existing addons use 300000), or it opens behind the panel.

---

## 5. Recipes

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
Matching cached pages are invalidated for you (built-in rules in §6).

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

## 6. API lookup

Everything is on `Core`.

### `Core.float` — see §4

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
| `cookies.withMode(mode, fn)` | see recipe |
| `dom.watch(fn, {for, immediate})` · `dom.when(sel, timeout)` · `dom.ready` | shared observer · wait for element · DOM-ready promise |
| `esc sleep debounce fmt int compact parseJson` | small utilities |

### Modules

`Core.module({ id, name, icon, version, match, deps, early, float, init(Core, ctx) })` · `Core.use(id)` (async) · `Core.get(id)` (sync).
`ctx` = `{ id, store(ns, opts), float(def), log(...) }`. `match` here is a RegExp / string / function; it's separate from the manifest `match`.

### Console

`Core.status()` (module table) · `Core.addons.status` (loader state per addon) · `Core.debug = true` (verbose) · `Core.net.cacheSize` · `Core.float.list()`.

---

## 7. Manifest (`addons.json`)

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
| `name`, `version` | no | display only (bump `version` when you change the file so the manager shows it) |
| `match` | no | regex string (or array) tested against `pathname + search`. **No match = the file isn't even downloaded.** Omit = every page |
| `early` | no | `true` = run at document-start |
| `sha256` | no | refuse to run if the file's hash differs |

JSON needs doubled backslashes (`\\.`). Entries run in the order listed. "Add by URL" in ⚙️ with an existing `id` overrides that manifest entry in this browser only.

---

## 8. Rules and gotchas

- [ ] **Buttons come from `Core.float`**, never your own `position:fixed` element.
- [ ] **Never add your own scrollbar to a panel.** The modal card is the one scroller. Don't put `overflow:auto` + `max-height` on your top-level content, or you get a second scrollbar. (A bounded inner list, e.g. a picker grid, is fine.)
- [ ] **Get the player id from `Core.player.id()`.** Some pages (e.g. the event map) have no sidebar, so a hand-rolled lookup returns the wrong id there and your saved data looks empty.
- [ ] **Match the site's look** (table below). Use the `core-*` classes, or these exact values in your own CSS.
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

### Matching the site's look

Core's own UI uses the site's exact values, copied from its stylesheet. If you write your own CSS, use the same ones:

| Thing | Value |
|---|---|
| Dialog card | `background:#171923; border:1px solid #2B2D44; border-radius:12px; box-shadow:0 10px 30px rgba(0,0,0,.4); padding:14px; color:#E0E0E0` |
| Backdrop | `rgba(0,0,0,.6)`, flat (no blur) |
| Close button | `background:#2a2d44; border:0; color:#fff; padding:6px 10px; border-radius:8px`, label `Close ✕` |
| Inner row / card | `background:#12131a; border:1px solid #232437; border-radius:10px` |
| Primary button | `background:#4b5ef5; color:#fff; border-radius:8px; padding:8px 10px; font:700 13px Arial; box-shadow:0 4px 10px rgba(0,0,0,.4)` |
| Soft button | `background:#2a2b3a; border:1px solid #3b3d55; color:#e0e4ff` |
| Success / danger | `#4caf50` / `#e74c3c` |
| Text | main `#E0E0E0`, headings `#F1F2FA`, dim `#9aa0b8` |
| Input | `background:#12131A; border:1px solid #2B2D44; border-radius:8px; color:#EDEFF6; padding:10px` |
| Floating button | built by `Core.float` (46px circle, `#2a2b3a`, `1px solid #2b2d44`, hover `#343648`) |

---

## 9. Brief for an AI that is writing an addon

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
- Match the site's look: dark card #171923, border #2B2D44, radius 12px, rows #12131a, primary #4b5ef5, dim text #9aa0b8.
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
