# Core — one userscript, many addons

You install **one** userscript (`core.user.js`). Everything else — Crystal Presets, Gear Presets, Pet Presets,
UI Cleanup, Battle Page — is a plain `.js` file on GitHub that Core downloads, caches and runs.

Each addon that has a panel gets **its own floating button** (💎 Crystals, ⚔️ Gear, 🐾 Pets), and a ⚙️ button
manages the addon list. There is no hub: adding a new floating button is one call, `Core.float.add()`.

> **Building an addon?** → [`REFERENCE.md`](REFERENCE.md) (what Core provides, step-by-step, API, a brief you can hand to an AI).
> Start from [`examples/addon-template.js`](examples/addon-template.js).

**Contents** · [1 How it works](#1-how-it-works) · [2 Repo layout](#2-repo-layout) · [3 Setup](#3-setup) · [4 What each addon changed](#4-what-each-addon-changed) · [5 Editing and updating](#5-editing-and-updating) · [6 Manifest](#6-manifest) · [7 Security](#7-security) · [8 Troubleshooting](#8-troubleshooting) · [9 Rollback](#9-rollback) · [10 Testing status](#10-testing-status)

---

## 1. How it works

```
 Tampermonkey                        GitHub (public repo)
┌───────────────┐    fetch        ┌──────────────────┐
│ core.user.js  │ ──────────────► │ addons.json      │  the list of addons
│ (the only     │                 │ addons/*.js      │  the addons themselves
│  script you   │ ◄────────────── └──────────────────┘
│  install)     │     code
└──────┬────────┘
       │ caches code in localStorage, runs each addon with `Core` in scope
       ▼
 demonicscans.org page
 ├─ floating row:  💎 Crystals · ⚔️ Gear · 🐾 Pets · ⚙️ Addons     (one button per addon that has UI)
 ├─ Core.float   the button + panel system every addon uses
 ├─ Core.net     shared page cache, request de-dup, auto-invalidation after POSTs
 ├─ Core.ui      toast / modal / menu          Core.cookies  cross-tab monster-cookie lock
 └─ Core.store · Core.state · Core.on/emit      storage, state and events shared between addons
```

**Load sequence on every page**

1. Tampermonkey runs `core.user.js` at `document-start`.
2. It reads the manifest (`addons.json`) from the **localStorage cache** instantly and re-checks GitHub in the background.
3. For each addon whose `match` fits the page and which isn't disabled, it takes the code from cache (or downloads it the first time) and runs it, in manifest order.
4. In the background, any addon not checked in the last 10 minutes is re-downloaded. If it changed you get a toast *"Addon … updated — reload to apply"*. Updates therefore apply on the **next** load, never mid-page.

Addons marked `"early": true` run at document-start; the rest wait for `DOMContentLoaded`.

---

## 2. Repo layout

```
repo/
├── core.user.js            backup copy of what you install in Tampermonkey (nothing fetches it)
├── addons.json             REQUIRED – the manifest Core reads
├── README.md               this file (optional)
├── REFERENCE.md            addon-building reference (optional)
├── addons/
│   ├── crystal-presets.js  REQUIRED (listed in addons.json)
│   ├── gear-presets.js     REQUIRED
│   ├── pet-presets.js      REQUIRED
│   ├── ui-cleanup.js       REQUIRED
│   └── battle.js           REQUIRED
└── examples/
    └── addon-template.js   optional, copy this to start a new addon
```

| File | On GitHub? | Installed in Tampermonkey? |
|---|---|---|
| `core.user.js` | optional backup | **YES — the only one**. One line to edit: `CONFIG.manifest` |
| `addons.json` | **YES** | no. Uses *relative* URLs, so no editing needed |
| `addons/*.js` | **YES** | **no — do not install these** (plain code, no userscript header) |
| `examples/addon-template.js` | optional | no |


---

## 3. Setup

### Step 1 — Get your manifest URL

Open `addons.json` in the repo → **Raw**, copy the address bar URL. It looks like
`https://raw.githubusercontent.com/<you>/<repo>/main/addons.json`. Open it in a tab: you should see JSON text.
(404 = private repo, wrong branch, or the file isn't at the repo root.)

### Step 2 — Put that URL in the script

top of `core.user.js`:

```js
const CONFIG = { manifest: 'https://raw.githubusercontent.com/YOU/REPO/main/addons.json' };
//                                                   ^^^^^^^^ replace with your Step 2 URL
```

`addons.json` uses relative URLs, so every addon is found next to it. Nothing else needs editing.

### Step 3 — Turn off the old scripts

In Tampermonkey **disable** (don't delete yet, see §9):

- Power Crystals — Presets + AJAX Helper
- Inventory Helper + Gear Presets
- UI Cleanup
- Pet Team Presets + Sigil No-Reload Helper
- Battle Page Restructure (All-in-One)

Leaving any on makes features run twice. The addons read and write the **same localStorage keys** as the originals
(`pcPresets_<pid>`, `gearPresets_<pid>`, `petPresets_<pid>`, `verya_reminders`, the battle panel keys…), so
**saved presets and settings carry over with no export/import.**

### Step 5 — Install Core

Tampermonkey → **+** (Create a new script) → delete the template → paste all of your edited `core.user.js` → **Ctrl+S**.
It should be **enabled** with match `https://demonicscans.org/*`.

### Step 6 — First load

1. Open any page of the site and hard-reload (**Ctrl+Shift+R**).
2. Bottom-right you should see a row: **💎 ⚔️ 🐾 ⚙️**. (Only addons with UI add a button.)
3. Click **⚙️**: every row should show a green **OK** pill. Rows for pages you aren't on (e.g. Battle Page on the dashboard) say **SKIPPED**, which is correct.
4. Click **💎 / ⚔️ / 🐾**: your existing presets should be listed.
5. The very first load downloads each addon; every load after that runs from cache.
6. Console (F12): `Core.status()` and `Core.addons.status`.

### Step 7 — Check each feature once

| Page | What to verify |
|---|---|
| any page | 💎 opens the Crystal panel and lists presets; **Restore** closes the panel and applies |
| `inventory.php` | the site's own ⚔️ button opens the Gear panel; badges still show on equipped items |
| `pets.php` | pet-card augmentations still appear; 🐾 applies a team without a page reload |
| `power_crystals.php` | equip / unequip / upgrade no longer reload the page |
| `guild_dash.php`, `game_dash.php` | tightened layout and reminder badges still show |
| `battle.php` | restructured layout loads without a flash; AutoSlash menu works |

---

## 4. What each addon changed


| Addon | From | Changed | Untouched |
|---|---|---|---|
| `crystal-presets.js` | Power Crystals v1.2.0 | own floating 💎 button → `Core.float`. Toast → `Core.ui.toast`. `power_crystals.php` read → `Core.net.fetchText` (shared cache). Restore closes the panel. | capture/restore engine, AJAX equip/unequip overrides, auto-assign, editor grid, storage key |
| `gear-presets.js` | Inventory Helper + Gear Presets v3.0.0 | own floating ⚔️ button → `Core.float`; the site's native ⚔️ button still opens it. Toasts → `Core.ui.toast`. `inventory.php?set=` read → `Core.net.fetchText`. | smart refresh, equipped badges, restore logic, storage key |
| `pet-presets.js` | Pet Team Presets v2.3.0 | own floating 🐾 button → `Core.float`. Toast → `Core.ui.toast` (the site's notifier is still preferred). `pets.php?team=` read → `Core.net.fetchText`. | sigil override, rarity detection, link rules, team apply, storage key |
| `ui-cleanup.js` | UI Cleanup v2.1 | duplicated cookie-lock code deleted (→ `Core.cookies`). Three toast systems → `Core.ui.toast`. Quest / Battle-Pass / PvP polls → `Core.net.fetchText` (10 s shared cache). The 7 `@match` lines → one `match` regex in `addons.json`. | all layout and reminder logic; wave/dungeon fetches (they need the cookie mode so stay direct) |
| `battle.js` | Battle Page v15.9 | `/stats.php`, `/inventory.php`, `/pets.php` reads → `Core.net.fetchText`. `"early": true` so it still runs at document-start. | everything else. It restructures the page and has no panel |

Net effect: floating buttons are drawn and spaced by one system instead of per-script placement code; seven copy-pasted
toasts → one; the cookie lock exists once; pages two addons both read are fetched once and shared for 10–30 s, and
dropped automatically after your own POSTs, in **all open tabs**.

---

## 5. Editing and updating

**Change an addon.** Edit `addons/<name>.js` on GitHub (pencil → *Commit changes*) or push. Reload the site; within ~10 minutes of the last check Core caches the new code and toasts *"updated — reload to apply"*. To force it: **⚙️ → ↻** on that row, then reload (or **Clear cache**). GitHub's CDN can serve a file up to ~5 minutes stale.

**Add or remove an addon everywhere.** Edit `addons.json`, commit. Each browser toasts *"Addon list changed — reload to apply"*.

**Add an addon for this browser only.** **⚙️ → paste a URL → Add by URL** (optionally a page regex). It runs immediately and survives reloads. 🗑 removes it.

**Disable an addon.** Untick it in ⚙️. Full effect after a reload (a running script can't be unloaded); re-enabling runs it at once.

**Develop locally.** Run `python3 -m http.server 8000` in the repo, **⚙️ → Add by URL** `http://localhost:8000/addons/x.js`, tick **Dev mode** (always fetch fresh), edit → reload.

**Versions.** `version` in `addons.json` is display only; the loader detects changes by file contents.

**Freeze everything.** Put a commit hash instead of `main` in the manifest URL: `https://raw.githubusercontent.com/<you>/<repo>/<commit-sha>/addons.json`.

**New addons** → [`REFERENCE.md`](REFERENCE.md).

---

## 6. Manifest

Fields, `match`, `early`, `sha256`: see [`REFERENCE.md` §7](REFERENCE.md#7-manifest-addonsjson).

---

## 7. Security

A URL decides what code runs **inside your logged-in game session**. Treat the repo like a password:

- Turn on **2-factor authentication** on the GitHub account that owns it. Don't add collaborators you don't fully trust, and read any addon from someone else's repo before using it.
- To harden, pin hashes: `sha256sum addons/*.js` (macOS: `shasum -a 256`), paste each digest into that entry's `"sha256"`. A tampered or half-updated file then refuses to run and shows an error in ⚙️. Update the hash whenever you edit the addon.
- Optionally pin the manifest to a commit SHA (§5).
- `CONFIG.manifest` lives in the Tampermonkey copy, not on GitHub: someone who pushes to the repo can change addons but can't point your install at a different manifest.

---

## 8. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Only ⚙️ shows, no 💎 ⚔️ 🐾 | `CONFIG.manifest` still has `YOU/REPO`, or the URL 404s. Open it in a tab |
| No buttons at all | Core is disabled or its `@match` doesn't fit the page. Check the console for `[Core]` messages |
| ⚙️ says *No addons yet* | same as the first row |
| Row is red: `HTTP 404` | the `url` in `addons.json` doesn't match the file's path (case-sensitive) |
| Row is red: `sha256 mismatch` | you edited the file but not its hash, or the CDN is stale (wait 5 min) |
| Row is red: syntax error | the addon has a JS error; the message has the line number (DevTools → Sources shows the file under its URL) |
| Row is red: `Failed to fetch` | blocked by network/extension, or no CORS headers. `raw.githubusercontent.com`, gists and `http://localhost` work |
| Row is red and the site has a strict CSP | Core tries `new Function`, then an inline `<script>`. If both are blocked the addon can't load. Send the CSP console message and the injection method can be switched |
| Everything runs twice / duplicate buttons | an old standalone script (or "DS Central") is still enabled, Step 4 |
| Edited addon doesn't change | CDN lag (≤5 min) → ⚙️ → ↻ → reload, or turn on Dev mode |
| "Addon updated" never appears | checks happen at most every 10 min per addon. ↻ forces it |
| Battle page flashes unstyled on the very first load | the first load downloads `battle.js`; later loads are from cache |
| A custom addon's editor opens *behind* a panel | its own modal DOM needs `z-index` above ~100100 (or use `Core.ui.modal`) |
| Saved presets "disappeared" | the player id fell back to `default` (sidebar link not found yet). Reload. Presets are under `pcPresets_<pid>` etc. and aren't touched by Core |
| Storage-full warning | cached code is ~700 KB. ⚙️ → **Clear cache**, or remove unused addons |

Console helpers: `Core.status()`, `Core.addons.status`, `Core.debug = true`, `localStorage.getItem('core:addons')`
(your disabled list, custom addons, dev flag).

---

## 9. Rollback

Nothing Core does is destructive and your presets are never rewritten.

1. Tampermonkey: **disable** Core.
2. **Re-enable** the five original userscripts (that's why Step 4 said disable, not delete).
3. Reload. You're back to the old setup with all presets intact.

To wipe Core's own data (cached code, disabled list, preferences — **not** your presets):

```js
Object.keys(localStorage).filter(k => k.startsWith('core:') || k.startsWith('ds:')).forEach(k => localStorage.removeItem(k))
```

(`ds:` is the old name used by the earlier "DS Central" build; it's harmless leftover data.)

---

## 10. Testing status

**Verified** in a simulated browser (jsdom with a mock server) running the real `core.user.js`, the real `addons/*.js` and `examples/addon-template.js`:

- all five addons load without errors on `inventory.php`, `guild_dash.php` and `battle.php`; page-matched addons are skipped elsewhere; the per-addon load states match the previous build on the same pages;
- exactly four dock buttons in order (💎 ⚔️ 🐾 ⚙️), no hub, no `DS` global;
- each button opens its own panel with that addon's real content; ✕ / Esc / `Core.float.close` close it and the content is parked back;
- `Core.float.add` with `onClick` only, `Core.module({ float })`, `float.remove` and duplicate-id warnings behave as documented;
- the ⚙️ manager lists all addons with correct state pills;
- the template addon runs as a real addon (panel, page tweak, cached fetch).

**Not verified** (no access to the live site or your account): how the panels *look* (they reuse your original CSS classes and haven't been screenshot-tested), real equip/restore round-trips against the live server, the site's actual CSP, and behaviour with your real page HTML. Step 7 is the checklist for that.
