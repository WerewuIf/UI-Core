/* Gear Presets + Inventory Helper — Core addon (migrated from the standalone userscript).
 * Loaded by core.user.js; `Core` is in scope. No @require / header needed.
 * Floating ⚔️ button + panel (the site's native ⚔️ button opens it too); toasts via Core.ui.toast; inventory.php reads via Core.net.
 */

/* ===========================================================================
 * v3.0.0 — what changed vs the old "inventory Helper" (v2.0.0):
 *
 * - @match broadened from inventory.php-only to the whole site. Module 1
 *   below is unchanged and stays inert everywhere except inventory.php
 *   (its click handler only reacts to onclick attributes that only exist
 *   on that page), so this is safe.
 * - Added MODULE 2: Gear Presets. This is a new, separate feature built the
 *   same way the "Power Crystals — Presets" script works: named loadouts
 *   saved in localStorage (per-account), captured from and restored to any
 *   of the 3 equipment sets (PvE Attack / PvP Attack / PvP Defense) via the
 *   same equip_item / unequip_item AJAX calls the page itself uses. It
 *   replaces the confusing numbered "Quick Set 1-10" apply flow with named
 *   presets you pick by name, and reads/writes state honestly instead of
 *   guessing — same "trust the server's data, don't hand-roll it" approach
 *   the crystal script takes.
 * - The bottom-right ⚔️ "Quick Sets" button is repointed at the new Gear
 *   Presets panel instead of the native drawer. The native drawer (and its
 *   Pet quick sets, which this script doesn't touch — no visibility into
 *   pets.php's markup to build against) is still reachable via a "legacy"
 *   link inside the new panel.
 * ========================================================================= */

/* ===========================================================================
 * MODULE 1: Equip / Unequip AJAX Helper (inventory.php only, in practice)
 *
 * WHAT WAS BROKEN IN v1 (kept as a changelog — delete if you don't need it):
 *
 * 1. (@match confirmed correct — not the issue, left as-is.)
 *
 * 2. The "Equip" button on every card calls showEquipModal(...), NOT
 *    equipItem(...). The real equipItem()/assignQuickItem() calls only
 *    exist on buttons showEquipModal() injects into #equip-modal-content,
 *    a node that lives OUTSIDE every .slot-box/.crystal-card. So
 *    btn.closest('.slot-box, .crystal-card') always returned null for
 *    the action that matters, and the modal was never closed after a
 *    successful equip.
 *
 * 3. Most equips call equipItem(invId, 0) — slot 0 means "server picks."
 *    The server's plain "OK" response never says which slot it picked,
 *    so there was no honest way to hand-patch the right card except for
 *    the two hardcoded ring slots (6/9).
 *
 * 4. The "Equipped Items" cards never carry an inv-id anywhere in the DOM
 *    (no data-inv-id, only unequipItem(slotId)). So even successful
 *    lookups had invId === null, and the "flip button back to Equip"
 *    logic silently did nothing — stale button + stale badge forever.
 *
 * 5. doEquip/doUnequip never sent `set`, even though the page's own
 *    equipItem()/unequipItem() always send set=<current tab>. Without it
 *    the backend has no idea which loadout (PvE/PvP Attack/PvP Defense)
 *    you meant to change.
 *
 * 6. Quick-set assignment read window.currentSet / window.currentQuickSet,
 *    which don't exist — the page declares those with `const` in a
 *    classic <script>, and top-level const/let never become window
 *    properties. Every quick-set assignment silently fell back to
 *    set_number=1, target_set='attack'.
 *
 * FIX: do the AJAX call to stay snappy (no full navigation), then
 * re-fetch the current URL and swap in the server's own fresh HTML for
 * each tagged section (data-section-key already exists for this in the
 * markup). That's the one source of truth that's always correct,
 * including server-decided slots and ring slots.
 * --------------------------------------------------------------------- */

(function () {
  'use strict';

  const BADGE_CLASS = 'tm-equipped-pill';
  const CARD_SEL = '.slot-box, .crystal-card';
  const SECTION_SEL = '.section[data-section-key]';

  const style = document.createElement('style');
  style.textContent = `
    .slot-box, .crystal-card { position: relative !important; }
    .${BADGE_CLASS} {
      position: absolute; top: 8px; right: 8px; z-index: 50;
      background: #2ecc71; color: #fff; font-size: 11px; font-weight: 800;
      padding: 3px 8px; border-radius: 999px; letter-spacing: .02em;
      box-shadow: 0 2px 8px rgba(0,0,0,.35);
      pointer-events: none; user-select: none; white-space: nowrap;
    }
  `;
  document.head.appendChild(style);

  const toast = (msg, ok = true) => Core.ui.toast(msg, ok, 2200);

  // ---- read the *actual* current view from the URL instead of the
  //      page's unreachable `const` globals ----
  function getUrlParam(name, fallback) {
    const v = new URLSearchParams(location.search).get(name);
    return v === null ? fallback : v;
  }
  function getCurrentSet() {
    const raw = getUrlParam('set', 'attack').toLowerCase();
    if (['defense', 'def', 'deff', 'pvp_defense', 'pvp_def'].includes(raw)) return 'defense';
    if (['pvp_attack', 'pvpattack', 'attack_pvp', 'pvp'].includes(raw)) return 'pvp_attack';
    return 'attack';
  }
  function getCurrentQuickSet() {
    return parseInt(getUrlParam('qset', '1'), 10) || 1;
  }

  function parseArgs(onclick, fnName) {
    const m = String(onclick || '').match(new RegExp(`${fnName}\\s*\\(([^)]*)\\)`));
    if (!m) return [];
    return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  }

  function findActionButton(target) {
    if (!(target instanceof Element)) return null;
    return target.closest('button, a, input[type="button"], input[type="submit"]');
  }

  function getActionFromButton(btn) {
    const onclick = btn?.getAttribute('onclick') || '';
    if (/equipItem\s*\(/i.test(onclick)) return { kind: 'equip', fn: 'equipItem' };
    if (/unequipItem\s*\(/i.test(onclick)) return { kind: 'unequip', fn: 'unequipItem' };
    if (/assignQuickItem\s*\(/i.test(onclick)) return { kind: 'quick', fn: 'assignQuickItem' };
    return null;
  }

  // ---- badge helpers ----
  function getCardButton(card) {
    return card?.querySelector('button[onclick], a[onclick], input[type="button"], input[type="submit"]') || null;
  }
  function isEquippedCard(card) {
    const btn = getCardButton(card);
    if (!btn) return false;
    return /unequipItem\s*\(/i.test(btn.getAttribute('onclick') || '');
  }
  function getCardItemName(card) {
    const img = card.querySelector('img[alt]');
    return img ? img.alt.trim() : '';
  }
  function collectEquippedNames() {
    const names = new Set();
    document.querySelectorAll(CARD_SEL).forEach((card) => {
      if (isEquippedCard(card)) {
        const name = getCardItemName(card);
        if (name) names.add(name);
      }
    });
    return names;
  }
  function refreshBadges() {
    const equippedNames = collectEquippedNames();
    document.querySelectorAll(CARD_SEL).forEach((card) => {
      card.querySelector(`:scope > .${BADGE_CLASS}`)?.remove();
      const directlyEquipped = isEquippedCard(card);
      const name = getCardItemName(card);
      const nameMatched = !directlyEquipped && name && equippedNames.has(name);
      if (directlyEquipped || nameMatched) {
        const badge = document.createElement('div');
        badge.className = BADGE_CLASS;
        badge.textContent = 'EQUIPPED';
        card.appendChild(badge);
      }
    });
  }

  // ---- network calls ----
  async function postAjax(body) {
    const res = await fetch('inventory_ajax.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const raw = await res.text();
    if (raw.trim() === 'OK') return true;
    throw new Error(raw.slice(0, 200) || 'Request failed');
  }
  function doEquip(invId, slotId) {
    const b = new URLSearchParams();
    b.set('action', 'equip_item');
    b.set('inv_id', invId);
    b.set('slot_id', slotId);
    b.set('set', getCurrentSet());
    return postAjax(b);
  }
  function doUnequip(slotId) {
    const b = new URLSearchParams();
    b.set('action', 'unequip_item');
    b.set('slot_id', slotId);
    b.set('set', getCurrentSet());
    return postAjax(b);
  }
  function doAssignQuick(invId, slotId) {
    const b = new URLSearchParams();
    b.set('action', 'assign_quick_item');
    b.set('inv_id', invId);
    b.set('slot_id', slotId);
    b.set('set_number', String(getCurrentQuickSet()));
    b.set('typee', 'equipment');
    b.set('target_set', getCurrentSet());
    return postAjax(b);
  }

  // ---- trust the server's own render instead of hand-rolling DOM state ----
  async function smartRefresh() {
    const res = await fetch(location.href, { cache: 'no-store' });
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');

    doc.querySelectorAll(SECTION_SEL).forEach((fresh) => {
      const key = fresh.getAttribute('data-section-key');
      const live = document.querySelector(`.section[data-section-key="${CSS.escape(key)}"]`);
      if (live) live.replaceWith(fresh);
    });

    if (typeof window.initEquipmentSortFilter === 'function') window.initEquipmentSortFilter();
    if (typeof window.makeInventorySectionsCollapsible === 'function') window.makeInventorySectionsCollapsible();

    refreshBadges();
  }

  async function handleInventoryActionClick(e) {
    const btn = findActionButton(e.target);
    if (!btn) return;

    const action = getActionFromButton(btn);
    if (!action) return;

    const args = parseArgs(btn.getAttribute('onclick') || '', action.fn);
    if (!args.length) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    try {
      btn.disabled = true;
      if (action.kind === 'equip') await doEquip(args[0], args[1]);
      else if (action.kind === 'unequip') await doUnequip(args[0]);
      else if (action.kind === 'quick') await doAssignQuick(args[0], args[1]);

      const modal = document.getElementById('equip-modal');
      if (modal) modal.style.display = 'none';

      await smartRefresh();
      toast('Saved', true);
    } catch (err) {
      toast(err?.message || 'Action failed', false);
    } finally {
      btn.disabled = false;
    }
  }

  // NEW in v3: let Module 2 (Gear Presets) trigger a live DOM refresh after
  // it applies a preset to whichever set is currently on screen. Harmless
  // to expose site-wide — it only does anything useful when called on
  // inventory.php, and Module 2 only calls it in that situation.
  window.__invHelperSmartRefresh = smartRefresh;

  document.addEventListener('click', handleInventoryActionClick, true);
  refreshBadges();
})();

/* ===========================================================================
 * MODULE 2: Gear Presets
 *
 * Mirrors the Power Crystals presets script: named loadouts saved in
 * localStorage per-account, captured from and restored to any of the 3
 * equipment sets via the same equip_item/unequip_item AJAX calls the page
 * itself uses. Runs site-wide (like the crystal script's presets panel) so
 * you can capture/apply from anywhere, fetching inventory.php in the
 * background when you're not already on it.
 *
 * Equip slots, from the "Equipped Items" markup (unequipItem(N)):
 *   1 weapon, 2 helmet, 3 armor, 4 boots, 5 gloves, 6 ring, 7 amulet,
 *   9 ring 2, 10 class weapon. (Slot 8 doesn't appear anywhere — skipped.)
 *
 * Restore is two-phase (unequip everything that needs to change, THEN
 * equip everything that needs to change) — same order the crystal script
 * uses for freeing/placing crystals. For gear this is stricter than it
 * might need to be (equipping over an occupied slot may well auto-replace
 * on this site), but there's no way to verify that without live-testing
 * against the real backend, so this plays it safe instead of assuming.
 * --------------------------------------------------------------------- */

(function () {
  'use strict';

  const SLOT_DEFS = [
    { id: '1', label: 'Weapon', type: 'weapon' },
    { id: '2', label: 'Helmet', type: 'helmet' },
    { id: '3', label: 'Armor', type: 'armor' },
    { id: '4', label: 'Boots', type: 'boots' },
    { id: '5', label: 'Gloves', type: 'gloves' },
    { id: '6', label: 'Ring 1', type: 'ring' },
    { id: '7', label: 'Amulet', type: 'amulet' },
    { id: '9', label: 'Ring 2', type: 'ring' },
    { id: '10', label: 'Class Weapon', type: 'class-weapon' },
  ];
  const GEAR_TYPES = new Set(['weapon', 'helmet', 'armor', 'boots', 'gloves', 'ring', 'amulet', 'class-weapon']);
  const SET_LABELS = { attack: 'PvE Attack', pvp_attack: 'PvP Attack', defense: 'PvP Defense' };
  const SET_KEYS = ['attack', 'pvp_attack', 'defense'];

  let presetOpBusy = false;
  let activeApplyPreset = null;
  let gpMenuMountedFor = null;

  // ---------- small shared utilities ----------

  function notify(msg, ok = true) {
    if (typeof window.showNotification === 'function') {
      window.showNotification(msg, ok ? 'success' : 'error');
      return;
    }
    Core.ui.toast(msg, ok, 3000);
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function isInventoryPage() {
    return location.pathname.replace(/\/+$/, '') === '/inventory.php';
  }
  function normalizeSetKey(raw) {
    raw = (raw || 'attack').toLowerCase();
    if (['defense', 'def', 'deff', 'pvp_defense', 'pvp_def'].includes(raw)) return 'defense';
    if (['pvp_attack', 'pvpattack', 'attack_pvp', 'pvp'].includes(raw)) return 'pvp_attack';
    return 'attack';
  }
  function getUrlSet() {
    return normalizeSetKey(new URLSearchParams(location.search).get('set') || 'attack');
  }

  // ---------- storage ----------

  function getPlayerId() {
    const link = document.querySelector('.side-drawer a[href*="player.php?pid="]');
    if (link) {
      const m = /pid=(\d+)/.exec(link.getAttribute('href') || '');
      if (m) return m[1];
    }
    return 'default';
  }
  const STORAGE_KEY = 'gearPresets_' + getPlayerId();

  function loadPresets() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
    catch (_) { return []; }
  }
  function savePresets(list) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch (_) { /* ignore */ }
  }
  function makePresetId() {
    return 'g_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // ---------- network ----------

  async function postAjaxInventory(body) {
    const res = await fetch('/inventory_ajax.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      credentials: 'include',
    });
    const raw = await res.text();
    if (raw.trim() === 'OK') return true;
    throw new Error(raw.slice(0, 200) || 'Request failed');
  }
  function equipItemToSet(invId, slotArg, setKey) {
    const b = new URLSearchParams();
    b.set('action', 'equip_item');
    b.set('inv_id', invId);
    b.set('slot_id', slotArg);
    b.set('set', setKey);
    return postAjaxInventory(b);
  }
  function unequipItemFromSet(slotId, setKey) {
    const b = new URLSearchParams();
    b.set('action', 'unequip_item');
    b.set('slot_id', slotId);
    b.set('set', setKey);
    return postAjaxInventory(b);
  }

  // ---------- reading state ----------

  // setKey -> parsed Document (cached; use the live document when it's the
  // set currently on screen, otherwise fetch inventory.php?set=<setKey>).
  const contextCache = {};
  async function getContextDoc(setKey, forceRefresh = false) {
    if (!forceRefresh && isInventoryPage() && getUrlSet() === setKey) return document;
    if (!forceRefresh && contextCache[setKey]) return contextCache[setKey];
    const html = await Core.net.fetchText('/inventory.php?set=' + encodeURIComponent(setKey), forceRefresh ? { force: true } : {});
    const doc = new DOMParser().parseFromString(html, 'text/html');
    contextCache[setKey] = doc;
    return doc;
  }
  function invalidateContextCache(setKey) {
    if (setKey) delete contextCache[setKey];
    else Object.keys(contextCache).forEach((k) => delete contextCache[k]);
  }

  // {slotId: {name, image}} from whichever set's "Equipped Items" section.
  function scanEquippedSnapshot(doc) {
    const section = doc.querySelector('.section[data-section-key$="-equipped"]');
    const snap = {};
    if (!section) return snap;
    section.querySelectorAll('.slot-box').forEach((card) => {
      const btn = Array.from(card.querySelectorAll('button')).find((b) =>
                                                                   /unequipItem\s*\(/i.test(b.getAttribute('onclick') || ''));
      if (!btn) return;
      const m = /unequipItem\s*\(\s*(\d+)\s*\)/i.exec(btn.getAttribute('onclick') || '');
      if (!m) return;
      const img = card.querySelector('img[alt]');
      const name = img ? img.alt.trim() : '';
      if (!name) return;
      snap[m[1]] = { name, image: img.src };
    });
    return snap;
  }

  // name -> {name, invId, image, type} from the "Equipment" section. This
  // list is the same regardless of which ?set= you fetched it with (it's
  // just "everything you own"), so one fetch covers all 3 sets.
  function scanEquipmentCatalog(doc) {
    const section = doc.querySelector('.section[data-section-key$="-equipment"]');
    const catalog = {};
    if (!section) return catalog;
    section.querySelectorAll('.slot-box[data-equip="1"]').forEach((card) => {
      const type = (card.dataset.itemType || '').toLowerCase().trim();
      if (!GEAR_TYPES.has(type)) return;
      const img = card.querySelector('img[alt]');
      const name = img ? img.alt.trim() : '';
      if (!name) return;
      catalog[name] = { name, invId: card.dataset.invId, image: img.src, type };
    });
    return catalog;
  }

  let catalogCache = null;
  async function getCatalog(forceRefresh = false) {
    if (!forceRefresh && catalogCache) return catalogCache;
    const setKey = isInventoryPage() ? getUrlSet() : 'attack';
    const doc = await getContextDoc(setKey, forceRefresh);
    catalogCache = scanEquipmentCatalog(doc);
    return catalogCache;
  }

  function slotsEqual(a, b) {
    const keysA = Object.keys(a || {});
    const keysB = Object.keys(b || {});
    if (keysA.length !== keysB.length) return false;
    return keysA.every((k) => b[k] && b[k].name === a[k].name);
  }

  // ---------- capture ----------

  async function captureCurrentToPreset(setKey) {
    let doc;
    try {
      doc = await getContextDoc(setKey, true);
    } catch (err) {
      notify('Could not reach the Inventory page to read current equipment.', false);
      return;
    }
    const snap = scanEquippedSnapshot(doc);
    if (!Object.keys(snap).length) {
      notify(`Nothing is currently equipped in ${SET_LABELS[setKey]} — nothing to capture.`, false);
      return;
    }
    const name = prompt('Name this gear preset:', `Preset ${loadPresets().length + 1}`);
    if (name == null) return;
    const preset = {
      id: makePresetId(),
      name: name.trim() || 'Untitled preset',
      slots: snap,
      sourceSet: setKey,
      updatedAt: Date.now(),
    };
    const list = loadPresets();
    list.push(preset);
    savePresets(list);
    renderPresetList();
    notify(`Saved preset "${preset.name}" (from ${SET_LABELS[setKey]}).`, true);
  }

  // ---------- restore ----------

  async function restorePresetToSet(preset, targetSetKey) {
    if (presetOpBusy) { notify('Please wait for the current action to finish.', false); return; }
    presetOpBusy = true;
    try {
      let doc;
      try {
        doc = await getContextDoc(targetSetKey, true);
      } catch (err) {
        notify('Could not reach the Inventory page to read current equipment.', false);
        return;
      }
      const currentSnap = scanEquippedSnapshot(doc);
      const catalog = scanEquipmentCatalog(doc);

      const toUnequip = [];
      const toEquip = [];
      const missing = [];

      SLOT_DEFS.forEach((def) => {
        const desired = preset.slots[def.id];
        const current = currentSnap[def.id];
        const desiredName = desired ? desired.name : null;
        const currentName = current ? current.name : null;
        if (desiredName === currentName) return;

        if (currentName) toUnequip.push(def.id);
        if (desiredName) {
          const cat = catalog[desiredName];
          if (!cat) { missing.push(desiredName); return; }
          const slotArg = (def.id === '6' || def.id === '9') ? def.id : '0';
          toEquip.push({ slotId: def.id, invId: cat.invId, slotArg });
        }
      });

      const total = toUnequip.length + toEquip.length;
      if (!total) {
        notify(missing.length
               ? `Already matches (${missing.length} saved item(s) no longer owned).`
               : `Already matches this preset in ${SET_LABELS[targetSetKey]}.`, true);
        return;
      }

      let done = 0;
      for (const slotId of toUnequip) {
        await unequipItemFromSet(slotId, targetSetKey);
        done++;
        notify(`Applying "${preset.name}"… (${done}/${total})`, true);
      }
      for (const item of toEquip) {
        await equipItemToSet(item.invId, item.slotArg, targetSetKey);
        done++;
        notify(`Applying "${preset.name}"… (${done}/${total})`, true);
      }

      invalidateContextCache(targetSetKey);
      if (isInventoryPage() && getUrlSet() === targetSetKey && typeof window.__invHelperSmartRefresh === 'function') {
        await window.__invHelperSmartRefresh();
      }
      notify(missing.length
             ? `Preset "${preset.name}" applied to ${SET_LABELS[targetSetKey]}. Skipped: ${missing.join(', ')}`
             : `Preset "${preset.name}" applied to ${SET_LABELS[targetSetKey]}.`, true);
    } catch (err) {
      notify('Stopped: ' + (err?.message || 'action failed'), false);
    } finally {
      presetOpBusy = false;
    }
  }

  // ---------- UI ----------

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .gp-modal{ position:fixed; inset:0; background:rgba(6,10,18,.74); display:none;
        align-items:center; justify-content:center; padding:20px; z-index:300000; backdrop-filter:blur(7px); }
      .gp-modal.show{ display:flex; }
      .gp-modal-card{ width:min(760px, 100%); max-height:90vh; overflow:auto;
        background:linear-gradient(180deg, rgba(24,34,56,.98), rgba(14,20,34,.98));
        border:1px solid rgba(255,255,255,.08); border-radius:22px; box-shadow:0 26px 60px rgba(0,0,0,.38);
        padding:22px; color:#eef3ff; font-family:Arial,sans-serif; }
      .gp-modal-head{ display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:16px; }
      .gp-modal-title{ margin:0; font-size:22px; }
      .gp-close-btn{ width:38px; height:38px; border-radius:12px; border:none; background:#18223a; color:#fff; font-size:20px; cursor:pointer; }

      .gp-btn{ border:none; cursor:pointer; text-decoration:none; color:#fff;
        background:linear-gradient(135deg, #3657a7, #4b6dd0); padding:9px 14px; border-radius:12px;
        font-weight:700; font-family:Arial,sans-serif; font-size:13px; box-shadow:0 8px 18px rgba(41,72,155,.28); }
      .gp-btn:hover{ filter:brightness(1.06); }
      .gp-btn-soft{ background:linear-gradient(135deg, #222d49, #2b3859); box-shadow:none; }
      .gp-btn-success{ background:linear-gradient(135deg, #217f5b, #33b57f); }
      .gp-btn-danger{ background:linear-gradient(135deg, #7b3040, #b4465c); }
      .gp-btn:disabled{ opacity:.5; cursor:not-allowed; }

      .gp-row{ display:flex; justify-content:space-between; align-items:center; gap:12px; padding:12px;
        background:#11192d; border:1px solid rgba(255,255,255,.06); border-radius:14px; margin-bottom:10px; flex-wrap:wrap; }
      .gp-row-name{ font-weight:800; }
      .gp-row-meta{ color:#9caad0; font-size:12px; margin-top:2px; }
      .gp-equipped-badge{ display:inline-block; font-size:10px; font-weight:800; letter-spacing:.03em; text-transform:uppercase;
        color:#8ee6a8; background:rgba(46,204,113,.12); border:1px solid rgba(46,204,113,.35); border-radius:999px;
        padding:2px 7px; vertical-align:middle; margin-left:6px; }
      .gp-row-icons{ display:flex; gap:4px; margin-top:6px; flex-wrap:wrap; }
      .gp-row-icons img{ width:24px; height:24px; border-radius:6px; object-fit:cover; border:1px solid rgba(255,255,255,.08); background:#0d1322; }
      .gp-row-actions{ display:flex; gap:6px; flex-wrap:wrap; }
      .gp-row-actions .gp-btn{ padding:6px 10px; font-size:12px; }

      .gp-menu-btn{ width:32px; height:32px; padding:0; display:inline-flex; align-items:center; justify-content:center; font-size:17px; }
      .gp-menu-dropdown{ position:fixed; z-index:300050; background:#171e33; border:1px solid rgba(255,255,255,.1);
        border-radius:12px; box-shadow:0 12px 28px rgba(0,0,0,.45); min-width:150px; padding:6px; display:none; }
      .gp-menu-dropdown.open{ display:block; }
      .gp-menu-item{ display:block; width:100%; text-align:left; background:none; border:none; color:#e7ecff;
        padding:8px 10px; border-radius:8px; font-size:13px; cursor:pointer; font-family:Arial,sans-serif; }
      .gp-menu-item:hover{ background:rgba(255,255,255,.06); }
      .gp-menu-item.danger{ color:#ff8a97; }

      .gp-empty-state{ padding:30px 18px; text-align:center; color:#9caad0; background:rgba(255,255,255,.02);
        border:1px dashed rgba(255,255,255,.08); border-radius:16px; }

      .gp-editor-grid{ display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:12px; }
      .gp-slot-card{ background:#11192d; border:1px solid rgba(255,255,255,.06); border-radius:14px; padding:10px; text-align:center; }
      .gp-slot-label{ font-size:11px; color:#9caad0; margin-bottom:6px; text-transform:uppercase; letter-spacing:.03em; }
      .gp-slot-icon{ width:64px; height:64px; margin:0 auto; border-radius:12px; background:#0d1322; overflow:hidden;
        position:relative; cursor:pointer; border:1px solid rgba(255,255,255,.08); display:flex; align-items:center; justify-content:center; }
      .gp-slot-icon img{ width:100%; height:100%; object-fit:cover; display:block; }
      .gp-slot-icon.empty{ color:#5f6890; font-size:26px; font-weight:800; }
      .gp-slot-remove{ position:absolute; top:2px; right:2px; width:16px; height:16px; border-radius:50%; border:none;
        background:rgba(10,15,28,.85); color:#fff; font-size:11px; line-height:16px; padding:0; cursor:pointer; }
      .gp-slot-remove:hover{ background:rgba(255,107,122,.9); }
      .gp-slot-name{ margin-top:6px; font-size:12px; color:#cfd8f7; overflow-wrap:anywhere; }

      .gp-picker-grid{ display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:12px; max-height:55vh; overflow:auto; }
      .gp-picker-card{ background:#10182a; border:1px solid rgba(255,255,255,.06); border-radius:16px; padding:12px; text-align:center; }
      .gp-picker-icon{ width:96px; height:96px; margin:0 auto; border-radius:14px; overflow:hidden; background:#0d1322; }
      .gp-picker-icon img{ width:100%; height:100%; object-fit:cover; }
      .gp-picker-name{ font-size:12px; color:#eef3ff; margin:8px 0; overflow-wrap:anywhere; }

      .gp-set-choice{ display:grid; gap:10px; }
      .gp-set-choice .gp-btn{ width:100%; padding:12px; font-size:14px; }
      .gp-modal-sub{ color:#9caad0; font-size:13px; margin-bottom:14px; }
      .gp-footer{ display:flex; gap:8px; flex-wrap:wrap; margin-top:16px; align-items:center; }
    `;
    document.head.appendChild(style);
  }

  function closeGpModal(id) {
    document.getElementById(id)?.classList.remove('show');
  }
  function mkBtn(cls, label, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'gp-btn ' + cls;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  function getGpMenuEl() {
    let el = document.getElementById('gpSharedMenu');
    if (!el) {
      el = document.createElement('div');
      el.id = 'gpSharedMenu';
      el.className = 'gp-menu-dropdown';
      document.body.appendChild(el);
    }
    return el;
  }
  function toggleMenu(anchorBtn, preset) {
    const menu = getGpMenuEl();
    const isOpenForThis = menu.classList.contains('open') && gpMenuMountedFor === preset.id;
    menu.classList.remove('open');
    if (isOpenForThis) { gpMenuMountedFor = null; return; }

    menu.innerHTML = '';
    [
      ['Edit', () => openEditor(preset)],
      ['Rename', () => renamePreset(preset)],
      ['Duplicate', () => duplicatePreset(preset)],
      ['Delete', () => deletePreset(preset), true],
    ].forEach(([label, fn, danger]) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'gp-menu-item' + (danger ? ' danger' : '');
      item.textContent = label;
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.classList.remove('open');
        gpMenuMountedFor = null;
        fn();
      });
      menu.appendChild(item);
    });

    const rect = anchorBtn.getBoundingClientRect();
    menu.style.top = (rect.bottom + 6) + 'px';
    menu.style.right = (window.innerWidth - rect.right) + 'px';
    menu.style.left = 'auto';
    menu.classList.add('open');
    gpMenuMountedFor = preset.id;
  }

  function renamePreset(preset) {
    const name = prompt('Rename preset:', preset.name);
    if (name == null) return;
    const list = loadPresets();
    const target = list.find((p) => p.id === preset.id);
    if (!target) return;
    target.name = name.trim() || target.name;
    target.updatedAt = Date.now();
    savePresets(list);
    renderPresetList();
  }
  function duplicatePreset(preset) {
    const copy = JSON.parse(JSON.stringify(preset));
    copy.id = makePresetId();
    copy.name = preset.name + ' (copy)';
    copy.updatedAt = Date.now();
    const list = loadPresets();
    list.push(copy);
    savePresets(list);
    renderPresetList();
  }
  function deletePreset(preset) {
    if (!confirm(`Delete preset "${preset.name}"? This cannot be undone.`)) return;
    savePresets(loadPresets().filter((p) => p.id !== preset.id));
    renderPresetList();
  }

  async function renderPresetList() {
    const wrap = document.getElementById('gpList');
    const presets = loadPresets();
    if (!presets.length) {
      wrap.innerHTML = '<div class="gp-empty-state">No saved gear presets yet. Capture your current loadout or start a blank one.</div>';
      return;
    }

    wrap.innerHTML = '';
    const rowEls = {};
    presets.forEach((preset) => {
      const row = document.createElement('div');
      row.className = 'gp-row';
      const itemCount = Object.keys(preset.slots).length;

      const info = document.createElement('div');
      info.innerHTML = `<div class="gp-row-name" data-gp-name>${escapeHtml(preset.name)}</div>
        <div class="gp-row-meta">${itemCount} item(s)</div>`;
      const icons = document.createElement('div');
      icons.className = 'gp-row-icons';
      Object.values(preset.slots).forEach((s) => {
        const img = document.createElement('img');
        img.src = s.image;
        img.title = s.name;
        icons.appendChild(img);
      });
      info.appendChild(icons);
      row.appendChild(info);

      const actions = document.createElement('div');
      actions.className = 'gp-row-actions';
      actions.appendChild(mkBtn('gp-btn-success', '▶ Apply', () => openApplyModal(preset)));
      const menuBtn = mkBtn('gp-btn-soft gp-menu-btn', '⋯', (e) => { e.stopPropagation(); toggleMenu(menuBtn, preset); });
      actions.appendChild(menuBtn);
      row.appendChild(actions);

      wrap.appendChild(row);
      rowEls[preset.id] = row;
    });

    // Check every set, not just whichever one is on screen right now, so the
    // badge shows up correctly no matter where this panel is opened from.
    const snapshots = {};
    await Promise.all(SET_KEYS.map(async (setKey) => {
      try {
        const doc = await getContextDoc(setKey);
        snapshots[setKey] = scanEquippedSnapshot(doc);
      } catch (_) { snapshots[setKey] = null; }
    }));

    presets.forEach((preset) => {
      const matchedSets = SET_KEYS.filter((setKey) => snapshots[setKey] && slotsEqual(preset.slots, snapshots[setKey]));
      if (!matchedSets.length) return;
      const nameEl = rowEls[preset.id]?.querySelector('[data-gp-name]');
      if (!nameEl) return;
      const label = matchedSets.map((setKey) => SET_LABELS[setKey]).join(' · ');
      nameEl.insertAdjacentHTML('beforeend', ` <span class="gp-equipped-badge">Equipped · ${label}</span>`);
    });
  }

  // ---- editor ----

  async function openEditor(preset) {
    const modal = document.getElementById('gpEditorModal');
    document.getElementById('gpEditorName').textContent = preset.name;
    document.getElementById('gpEditorGrid').innerHTML = '<div class="gp-empty-state">Loading equipment catalog…</div>';
    modal.classList.add('show');

    const working = JSON.parse(JSON.stringify(preset));
    let catalog;
    try {
      catalog = await getCatalog();
    } catch (err) {
      document.getElementById('gpEditorGrid').innerHTML =
        '<div class="gp-empty-state">Could not reach the Inventory page. Check your connection and try again.</div>';
      return;
    }
    renderEditorGrid(working, catalog);

    document.getElementById('gpEditorSave').onclick = () => {
      working.updatedAt = Date.now();
      const list = loadPresets();
      const idx = list.findIndex((p) => p.id === working.id);
      if (idx >= 0) list[idx] = working; else list.push(working);
      savePresets(list);
      renderPresetList();
      closeGpModal('gpEditorModal');
      notify(`Saved preset "${working.name}".`, true);
    };
  }

  function renderEditorGrid(working, catalog) {
    const grid = document.getElementById('gpEditorGrid');
    grid.innerHTML = '';
    SLOT_DEFS.forEach((def) => {
      const slot = working.slots[def.id];
      const card = document.createElement('div');
      card.className = 'gp-slot-card';

      const label = document.createElement('div');
      label.className = 'gp-slot-label';
      label.textContent = def.label;
      card.appendChild(label);

      const iconWrap = document.createElement('div');
      iconWrap.className = 'gp-slot-icon' + (slot ? '' : ' empty');
      if (slot) {
        const img = document.createElement('img');
        img.src = slot.image;
        img.title = slot.name;
        iconWrap.appendChild(img);
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'gp-slot-remove';
        rm.title = 'Remove';
        rm.textContent = '×';
        rm.addEventListener('click', (e) => {
          e.stopPropagation();
          delete working.slots[def.id];
          renderEditorGrid(working, catalog);
        });
        iconWrap.appendChild(rm);
      } else {
        iconWrap.textContent = '+';
      }
      iconWrap.addEventListener('click', () => {
        openPicker(def, catalog, (chosen) => {
          working.slots[def.id] = { name: chosen.name, image: chosen.image };
          renderEditorGrid(working, catalog);
        });
      });
      card.appendChild(iconWrap);

      const name = document.createElement('div');
      name.className = 'gp-slot-name';
      name.textContent = slot ? slot.name : 'Empty';
      card.appendChild(name);

      grid.appendChild(card);
    });
  }

  function openPicker(def, catalog, onPick) {
    document.getElementById('gpPickerTitle').textContent = 'Choose ' + def.label;
    const body = document.getElementById('gpPickerBody');
    const matches = Object.values(catalog).filter((it) => it.type === def.type)
    .sort((a, b) => a.name.localeCompare(b.name));
    if (!matches.length) {
      body.innerHTML = '<div class="gp-empty-state">No owned items of this type found.</div>';
    } else {
      body.innerHTML = '<div class="gp-picker-grid"></div>';
      const g = body.querySelector('.gp-picker-grid');
      matches.forEach((it) => {
        const card = document.createElement('div');
        card.className = 'gp-picker-card';
        card.innerHTML = `<div class="gp-picker-icon"><img src="${it.image}"></div><div class="gp-picker-name">${escapeHtml(it.name)}</div>`;
        const btn = mkBtn('gp-btn-success', 'Choose', () => { closeGpModal('gpPickerModal'); onPick(it); });
        btn.style.width = '100%';
        card.appendChild(btn);
        g.appendChild(card);
      });
    }
    document.getElementById('gpPickerModal').classList.add('show');
  }

  // ---- apply (target set chooser) ----

  function openApplyModal(preset) {
    activeApplyPreset = preset;
    document.getElementById('gpApplyTitle').textContent = `Apply "${preset.name}" to:`;
    document.getElementById('gpApplyModal').classList.add('show');
  }
  async function onApplyTarget(targetSetKey, btn) {
    if (!activeApplyPreset) return;
    const preset = activeApplyPreset;
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Applying…';
    closeGpModal('gpApplyModal');
    await restorePresetToSet(preset, targetSetKey);
    btn.disabled = false;
    btn.textContent = original;
    activeApplyPreset = null;
    renderPresetList();
  }

  // ---- capture (source set chooser) ----

  function openCaptureModal() {
    document.getElementById('gpCaptureModal').classList.add('show');
  }

  // ---------- build UI ----------

  let gpPanel = null, gpHome = null;

  function buildUI() {
    injectStyles();

    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="gp-modal" id="gpModal">
        <div class="gp-modal-card">
          <div class="gp-modal-head">
            <h3 class="gp-modal-title">Gear Presets</h3>
            <button type="button" class="gp-close-btn" data-gp-close="gpModal">&times;</button>
          </div>
          <div id="gpList"></div>
          <div class="gp-footer">
            <button type="button" class="gp-btn gp-btn-soft" id="gpNewBlank">+ New Preset</button>
            <button type="button" class="gp-btn gp-btn-success" id="gpCaptureBtn">Capture Current</button>
            <div style="flex:1 1 auto;"></div>
            <button type="button" class="gp-btn gp-btn-soft" id="gpLegacyPetsBtn">🐾 Legacy Quick Sets</button>
          </div>
        </div>
      </div>

      <div class="gp-modal" id="gpCaptureModal">
        <div class="gp-modal-card" style="max-width:420px;">
          <div class="gp-modal-head">
            <h3 class="gp-modal-title">Capture Current Gear</h3>
            <button type="button" class="gp-close-btn" data-gp-close="gpCaptureModal">&times;</button>
          </div>
          <div class="gp-modal-sub">Which set's current loadout do you want to save?</div>
          <div class="gp-set-choice">
            <button type="button" class="gp-btn" data-capture-set="attack">PvE Attack Set</button>
            <button type="button" class="gp-btn" data-capture-set="pvp_attack">PvP Attack Set</button>
            <button type="button" class="gp-btn" data-capture-set="defense">PvP Defense Set</button>
          </div>
        </div>
      </div>

      <div class="gp-modal" id="gpApplyModal">
        <div class="gp-modal-card" style="max-width:420px;">
          <div class="gp-modal-head">
            <h3 class="gp-modal-title" id="gpApplyTitle">Apply preset to:</h3>
            <button type="button" class="gp-close-btn" data-gp-close="gpApplyModal">&times;</button>
          </div>
          <div class="gp-modal-sub">This will overwrite whatever's currently equipped in that set.</div>
          <div class="gp-set-choice">
            <button type="button" class="gp-btn" data-apply-set="attack">PvE Attack Set</button>
            <button type="button" class="gp-btn" data-apply-set="pvp_attack">PvP Attack Set</button>
            <button type="button" class="gp-btn" data-apply-set="defense">PvP Defense Set</button>
          </div>
        </div>
      </div>

      <div class="gp-modal" id="gpEditorModal">
        <div class="gp-modal-card" style="max-width:820px;">
          <div class="gp-modal-head">
            <h3 class="gp-modal-title">Edit Preset — <span id="gpEditorName"></span></h3>
            <button type="button" class="gp-close-btn" data-gp-close="gpEditorModal">&times;</button>
          </div>
          <div id="gpEditorGrid" class="gp-editor-grid"></div>
          <div class="gp-footer">
            <div style="flex:1 1 auto;"></div>
            <button type="button" class="gp-btn gp-btn-soft" data-gp-close="gpEditorModal">Cancel</button>
            <button type="button" class="gp-btn gp-btn-success" id="gpEditorSave">Save Preset</button>
          </div>
        </div>
      </div>

      <div class="gp-modal" id="gpPickerModal">
        <div class="gp-modal-card">
          <div class="gp-modal-head">
            <h3 class="gp-modal-title" id="gpPickerTitle">Choose an item</h3>
            <button type="button" class="gp-close-btn" data-gp-close="gpPickerModal">&times;</button>
          </div>
          <div id="gpPickerBody"></div>
        </div>
      </div>
    `;
    document.body.appendChild(wrap);

    // The main presets panel is shown by Core's floating-button system (the ⚔️ button) instead of
    // its own modal. It's built here, parked in a hidden holder so getElementById() keeps
    // working, and moved into Core's panel when the button is clicked.
    const mainModal = wrap.querySelector('#gpModal');
    gpPanel = document.createElement('div');
    gpPanel.id = 'gpPanel';
    mainModal.querySelectorAll('.gp-modal-card > :not(.gp-modal-head)').forEach((n) => gpPanel.appendChild(n));
    mainModal.remove();
    gpHome = document.createElement('div');
    gpHome.style.display = 'none';
    gpHome.appendChild(gpPanel);
    document.body.appendChild(gpHome);

    document.body.addEventListener('click', (e) => {
      const closeBtn = e.target.closest('[data-gp-close]');
      if (closeBtn) closeGpModal(closeBtn.getAttribute('data-gp-close'));
      if (!e.target.closest('.gp-menu-dropdown') && !e.target.closest('.gp-menu-btn')) {
        document.getElementById('gpSharedMenu')?.classList.remove('open');
        gpMenuMountedFor = null;
      }
      const captureBtn = e.target.closest('[data-capture-set]');
      if (captureBtn) {
        closeGpModal('gpCaptureModal');
        captureCurrentToPreset(captureBtn.getAttribute('data-capture-set'));
      }
      const applyBtn = e.target.closest('[data-apply-set]');
      if (applyBtn) {
        onApplyTarget(applyBtn.getAttribute('data-apply-set'), applyBtn);
      }
    });

    ['gpCaptureModal', 'gpApplyModal', 'gpEditorModal', 'gpPickerModal'].forEach((id) => {
      document.getElementById(id).addEventListener('click', (e) => {
        if (e.target.id === id) closeGpModal(id);
      });
    });

    document.getElementById('gpCaptureBtn').addEventListener('click', openCaptureModal);
    document.getElementById('gpNewBlank').addEventListener('click', () => {
      const name = prompt('Name this new preset:', `Preset ${loadPresets().length + 1}`);
      if (name == null) return;
      openEditor({ id: makePresetId(), name: name.trim() || 'Untitled preset', slots: {}, updatedAt: Date.now() });
    });
    document.getElementById('gpLegacyPetsBtn').addEventListener('click', () => {
      Core.float.close('gear-presets');
      document.body.classList.add('qsdrawer-open');
    });
  }

  // Repoint the native bottom-right ⚔️ button at the new panel. Clone+replace
  // strips the native click listener that opened the old drawer, without
  // touching the drawer itself (still there — see the "legacy" link above).
  function revampQuickSetButton() {
    const original = document.getElementById('openQuickSetDrawerBtn');
    if (!original) return;
    const btn = original.cloneNode(true);
    btn.title = 'Gear Presets (replaces the old Quick Sets)';
    original.replaceWith(btn);
    btn.addEventListener('click', () => {
      Core.float.open('gear-presets');
    });
  }

  buildUI();
  revampQuickSetButton();

  // Register the floating ⚔️ button + panel with Core.
  Core.float.add({
    id: 'gear-presets', title: 'Gear Presets', icon: '⚔️', order: 20,
    render(el) { el.replaceChildren(gpPanel); },
    onShow() { renderPresetList(); },
    onHide() { if (gpHome && gpPanel) gpHome.appendChild(gpPanel); },
  });

})();