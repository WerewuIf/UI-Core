/* Crystal Presets — Core addon (migrated from the standalone userscript).
 * Loaded by core.user.js; `Core` is in scope. No @require / header needed.
 * Floating 💎 button + panel; toasts via Core.ui.toast; power_crystals.php reads via Core.net (shared cache).
 */

(function () {
  'use strict';

  /* ---------------------------------------------------------------------
   * WHAT THIS DOES
   *
   * Adds a "Crystal Presets" panel: capture the crystals currently linked
   * to your gear as a named preset, restore one at will, and edit presets
   * in a virtual grid that never touches the server until you save.
   *
   * A few things about the underlying page shape this in:
   *
   * - Equipment pieces are identified here by their ICON image, not
   *   equipment_inv_id. The id is only visible in the DOM via an EMPTY
   *   slot's onclick="openPickerModal(id)" — a fully-filled card has no
   *   empty slot button, so no id is exposed anywhere on it. The icon is
   *   always rendered regardless of fill state, so it's the one thing we
   *   can reliably key on. The actual id gets resolved live, right when
   *   it's needed to equip something.
   *
   * - A crystal can't be equipped anywhere while it's still linked
   *   elsewhere, and equip/unequip don't take a slot index (the server
   *   auto-fills whichever slot is open). So restoring a preset is a
   *   two-phase unequip-then-equip: first free every crystal that's in
   *   the wrong place (which also reveals empty-slot buttons — and thus
   *   ids — on any card that was fully filled), then place every crystal
   *   that's missing, re-checking each target card's open-slot id right
   *   before each individual equip call.
   *
   * - Presets live in localStorage, namespaced by the player id pulled
   *   from the sidebar profile link, so they're per-account and persist
   *   across sessions without any server involvement.
   *
   * - Off the crystals page, equipment/crystal state doesn't exist in the
   *   live DOM at all, so every read goes through getContextDoc(), which
   *   lazily fetches and parses power_crystals.php and caches the result
   *   in pcpContextDoc. That cache is kept fresh automatically after any
   *   equip/unequip this script performs, but it can go stale if you
   *   change equipment some other way (e.g. a second tab) — the ⟳
   *   Refresh button in the presets panel forces a re-fetch.
   *
   * This is self-contained — it doesn't require the AJAX helper script,
   * though the two are meant to sit side by side. This one never touches
   * pickCrystal/submitUnequipCrystal/submitUpgradeCrystal; it does its
   * own equip/unequip calls directly.
   * --------------------------------------------------------------------- */

  // Module B (the presets UI: trigger button, modal, capture/restore/edit)
  // now runs on every page of the site. Module A (the live equip/unequip/
  // upgrade/activate AJAX overrides) still only makes sense on
  // power_crystals.php, since that's the only page with those forms and
  // modals — it's gated separately, further down, with onCrystalsPage().

  const CRYSTALS_PATH = '/power_crystals.php';
  const CRYSTALS_URL = new URL(CRYSTALS_PATH, location.origin).href;

  function onCrystalsPage() {
    return !!document.querySelector('.equipment-grid');
  }

  let pcpPostBusy = false;      // guards an individual preset fetch
  let presetOpBusy = false;     // guards a whole capture/restore operation
  let crystalActionBusy = false; // guards Equip/Unequip/Upgrade buttons (Module 2)

  // When we're not sitting on power_crystals.php, equipment/crystal state
  // has to come from a fetched-and-parsed copy of that page instead of the
  // live DOM. This holds the most recent one (kept fresh after every
  // equip/unequip POST); getContextDoc() populates/refreshes it lazily.
  let pcpContextDoc = onCrystalsPage() ? document : null;

    // Every crystal form now requires this hidden token.
  let pcpIntent = '';
  function readIntent(root) {
    const el = root && root.querySelector('input[name="crystal_intent"]');
    return el ? el.value : '';
  }
  function setIntent(value) {
    if (!value) return;
    pcpIntent = value;
    // keep the page's own hidden forms (outside .page-wrap) in sync
    document.querySelectorAll('input[name="crystal_intent"]').forEach((i) => { i.value = value; });
  }

  // ---------- small shared utilities ----------

  function notify(msg, ok = true) {
    if (typeof window.showNotification === 'function') {
      window.showNotification(msg, ok ? 'success' : 'error');
      return;
    }
    Core.ui.toast(msg, ok, 3000);
  }

  function escapeHtmlLocal(str) {
    return String(str ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  // ---- same "const NAME = <json>;" slicer as the AJAX helper, so this
  //      script's own actions keep availableCrystals/levelUpgradeData/
  //      starUpgradeData in sync too, if that script happens to be
  //      installed alongside this one ----
  function sliceDecl(text, name, nextName) {
    const startRe = new RegExp('const\\s+' + name + '\\s*=\\s*');
    const sm = startRe.exec(text);
    if (!sm) return null;
    const from = sm.index + sm[0].length;
    const rest = text.slice(from);
    const endRe = nextName
      ? new RegExp(';\\s*const\\s+' + nextName)
      : /;\s*let\s+pickerEquipmentId/;
    const em = endRe.exec(rest);
    return em ? rest.slice(0, em.index) : rest;
  }

  function syncCrystalData(doc) {
    const script = Array.from(doc.querySelectorAll('script'))
      .find((s) => s.textContent.includes('const availableCrystals'));
    if (!script) return;
    const text = script.textContent;

    try {
      const raw = sliceDecl(text, 'availableCrystals', 'levelUpgradeData');
      if (raw != null && typeof availableCrystals !== 'undefined') {
        const parsed = JSON.parse(raw.trim());
        availableCrystals.length = 0;
        availableCrystals.push(...parsed);
      }
    } catch (_) { /* best-effort */ }

    try {
      const raw = sliceDecl(text, 'levelUpgradeData', 'starUpgradeData');
      if (raw != null && typeof levelUpgradeData !== 'undefined') {
        const parsed = JSON.parse(raw.trim());
        Object.keys(levelUpgradeData).forEach((k) => delete levelUpgradeData[k]);
        Object.assign(levelUpgradeData, parsed);
      }
    } catch (_) { /* ditto */ }

    try {
      const raw = sliceDecl(text, 'starUpgradeData', null);
      if (raw != null && typeof starUpgradeData !== 'undefined') {
        const parsed = JSON.parse(raw.trim());
        Object.keys(starUpgradeData).forEach((k) => delete starUpgradeData[k]);
        Object.assign(starUpgradeData, parsed);
      }
    } catch (_) { /* ditto */ }
  }

  function applyFreshHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    setIntent(readIntent(doc));   // must happen before replaceWith moves nodes out of doc
    const freshWrap = doc.querySelector('.page-wrap');
    if (!freshWrap) return { ok: false, flash: null, doc: null };

    // Only splice the fresh markup into the live page when we're actually
    // on power_crystals.php. On any other page there's no .page-wrap of
    // ours to replace — we just want the parsed doc for its data. (Note:
    // replaceWith() moves freshWrap out of `doc` and into the live
    // document, so after this branch runs, `doc` itself is used only for
    // syncCrystalData below — reads should go through `document` instead.)
    if (onCrystalsPage()) {
      const liveWrap = document.querySelector('.page-wrap');
      if (liveWrap) liveWrap.replaceWith(freshWrap);
    }

    syncCrystalData(doc);
    return { ok: true, flash: freshWrap.querySelector('.flash'), doc };
  }

  // ---------- presets fetch helpers ----------

  async function ensureIntent() {
    if (pcpIntent) return pcpIntent;
    setIntent(readIntent(await getContextDoc()));
    return pcpIntent;
  }

  async function postAction(fields) {
    if (pcpPostBusy) return { ok: false, error: 'busy' };
    pcpPostBusy = true;
    try {
      const intent = await ensureIntent();
      if (!intent) return { ok: false, error: 'no crystal_intent token found on the page' };

      const body = new URLSearchParams(Object.assign({ crystal_intent: intent }, fields));
      const res = await fetch(CRYSTALS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        credentials: 'include',
      });
      if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
      const html = await res.text();
      const result = applyFreshHtml(html);
      if (!result.ok) return { ok: false, error: 'bad response' };
      pcpContextDoc = onCrystalsPage() ? document : result.doc;

      // A rejected action still returns a full page, just with an error flash.
      if (result.flash && result.flash.classList.contains('err')) {
        return { ok: false, error: result.flash.textContent.trim() || 'rejected by server' };
      }
      return { ok: true, flash: result.flash, doc: pcpContextDoc };
    } catch (err) {
      return { ok: false, error: String(err) };
    } finally {
      pcpPostBusy = false;
    }
  }

  function equipCrystal(crystalId, equipmentInvId) {
    return postAction({
      action: 'equip_crystal',
      crystal_id: String(crystalId),
      equipment_inv_id: String(equipmentInvId)
    });
  }

  function unequipCrystal(crystalId) {
    return postAction({ action: 'unequip_crystal', crystal_id: String(crystalId) });
  }

  // ---------- reading the page ----------

  function getPlayerId() { return Core.player.id(); }

  function findPanelByHeading(root, text) {
    return Array.from(root.querySelectorAll('.panel')).find((p) => {
      const h2 = p.querySelector('.panel-head h2');
      return h2 && h2.textContent.trim() === text;
    }) || null;
  }

  // Resolves to the document we should read equipment/crystal state from:
  // the live document when on power_crystals.php, otherwise a fetched and
  // parsed copy of it (cached in pcpContextDoc, refreshed after every
  // equip/unequip action by postAction). Pass forceRefresh to re-fetch.
  async function getContextDoc(forceRefresh = false) {
    if (onCrystalsPage()) return document;
    if (!pcpContextDoc || forceRefresh) {
      const html = await Core.net.fetchText(CRYSTALS_URL, forceRefresh ? { force: true } : {});
      const doc = new DOMParser().parseFromString(html, 'text/html');
      syncCrystalData(doc);
      setIntent(readIntent(doc));
      pcpContextDoc = doc;
    }
    return pcpContextDoc;
  }

  // crystal_id -> { name, image }, sourced from the Activated Crystals
  // panel, which lists every activated crystal whether linked or not.
  function scanCrystalCatalog(root) {
    root = root || document;
    const catalog = {};
    const panel = findPanelByHeading(root, 'Activated Crystals');
    if (!panel) return catalog;
    panel.querySelectorAll('.crystal-card').forEach((card) => {
      const imgBtn = card.querySelector('button.crystal-image');
      const upBtn = card.querySelector('[onclick^="openUpgradeModal"]');
      if (!imgBtn || !upBtn) return;
      const idMatch = /openUpgradeModal\('(?:level|star)'\s*,\s*(\d+)\)/.exec(upBtn.getAttribute('onclick') || '');
      if (!idMatch) return;
      const id = idMatch[1];
      const nameMatch = /openInfoFromData\(this,\s*'([^']*)'\)/.exec(imgBtn.getAttribute('onclick') || '');
      const img = imgBtn.querySelector('img');
      const starBadge = imgBtn.querySelector('.star-badge');
      const levelSpan = card.querySelector('.level-line span:first-child');
      const infoHtml = imgBtn.getAttribute('data-info') || '';
      catalog[id] = {
        name: nameMatch ? nameMatch[1] : ('Crystal #' + id),
        image: img ? img.src : '',
        level: levelSpan ? levelSpan.textContent.trim() : '',
        stars: starBadge ? starBadge.textContent.trim() : '',
        infoHtml,
      };
    });
    return catalog;
  }

  // one entry per equipment card: icon key, slot capacity, currently
  // linked crystal ids, and (if any slot is open) that equipment's id.
  function scanEquipmentSnapshot(root) {
    root = root || document;
    const panel = findPanelByHeading(root, 'Equipment');
    if (!panel) return [];
    return Array.from(panel.querySelectorAll('.equipment-card')).map((card) => {
      const artImg = card.querySelector('.art-frame img');
      const key = artImg ? artImg.src : null;
      const slotBtns = Array.from(card.querySelectorAll('.slot-row .slot-btn'));
      const crystalIds = [];
      let emptyEquipmentInvId = null;
      slotBtns.forEach((btn) => {
        const onclick = btn.getAttribute('onclick') || '';
        if (btn.classList.contains('filled')) {
          const m = /openConfirmUnequip\((\d+)\)/.exec(onclick);
          if (m) crystalIds.push(m[1]);
        } else {
          const m = /openPickerModal\((\d+)\)/.exec(onclick);
          if (m && emptyEquipmentInvId == null) emptyEquipmentInvId = m[1];
        }
      });
      return { key, slotCount: slotBtns.length, crystalIds, equipmentInvId: emptyEquipmentInvId };
    }).filter((e) => e.key);
  }

  // ---------- storage ----------

  const STORAGE_KEY = 'pcPresets_' + getPlayerId();

  function loadPresets() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
    catch (_) { return []; }
  }

  function savePresets(list) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch (_) { /* ignore */ }
  }

  function makePresetId() {
    return 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // ---------- capture / restore ----------

  async function captureCurrent() {
    const name = prompt('Name this preset:', 'Preset ' + (loadPresets().length + 1));
    if (name == null) return;
    let snap;
    try {
      snap = scanEquipmentSnapshot(await getContextDoc());
    } catch (err) {
      notify('Could not reach power_crystals.php to read current equipment.', false);
      return;
    }
    const items = snap
      .filter((e) => e.crystalIds.length)
      .map((e) => ({ key: e.key, crystalIds: e.crystalIds.slice() }));
    if (!items.length) {
      notify('Nothing is currently linked — nothing to capture.', false);
      return;
    }
    const preset = { id: makePresetId(), name: name.trim() || 'Untitled preset', items, updatedAt: Date.now() };
    const list = loadPresets();
    list.push(preset);
    savePresets(list);
    renderPresetList();
    notify('Saved preset "' + preset.name + '".', true);
  }

  async function restorePreset(preset) {
    if (presetOpBusy) { notify('Please wait for the current action to finish.', false); return; }
    if (!confirm('Restore preset "' + preset.name + '"? This re-equips crystals to match the saved layout.')) return;

    presetOpBusy = true;
    Core.float.close('crystal-presets');

    try {
      let currentSnap;
      try {
        currentSnap = scanEquipmentSnapshot(await getContextDoc());
      } catch (err) {
        notify('Could not reach power_crystals.php to read current equipment.', false);
        return;
      }
      const currentLinks = {}; // crystalId -> key
      currentSnap.forEach((e) => e.crystalIds.forEach((id) => { currentLinks[id] = e.key; }));

      const currentKeys = new Set(currentSnap.map((e) => e.key));
      const desiredLinks = {}; // crystalId -> key, only for gear currently equipped
      let skippedOrphans = 0;
      preset.items.forEach((item) => {
        if (!currentKeys.has(item.key)) { skippedOrphans++; return; }
        item.crystalIds.forEach((id) => { desiredLinks[id] = item.key; });
      });

      const toUnequip = Object.keys(currentLinks).filter((id) => desiredLinks[id] !== currentLinks[id]);
      const toEquip = Object.keys(desiredLinks).filter((id) => currentLinks[id] !== desiredLinks[id]);
      const total = toUnequip.length + toEquip.length;

      if (!total) {
        notify(skippedOrphans ? 'Already matches (ignoring gear no longer equipped).' : 'Already matches this preset.', true);
        return;
      }

      let done = 0;

      for (const crystalId of toUnequip) {
        const r = await unequipCrystal(crystalId);
        if (!r.ok) { notify('Stopped: failed to unequip crystal #' + crystalId + (r.error ? ' — ' + r.error : '.'), false); return; }
        done++;
        notify('Restoring "' + preset.name + '"… (' + done + '/' + total + ')', true);
      }

      for (const crystalId of toEquip) {
        const key = desiredLinks[crystalId];
        const freshSnap = scanEquipmentSnapshot(await getContextDoc());
        const target = freshSnap.find((e) => e.key === key);
        const equipmentInvId = target ? target.equipmentInvId : null;
        if (!equipmentInvId) {
          notify('Skipped crystal #' + crystalId + ' — no open slot found.', false);
          continue;
        }
        const r = await equipCrystal(crystalId, equipmentInvId);
        if (!r.ok) { notify('Stopped: failed to equip crystal #' + crystalId + (r.error ? ' — ' + r.error : '.'), false); return; }
        done++;
        notify('Restoring "' + preset.name + '"… (' + done + '/' + total + ')', true);
      }

      notify(
        skippedOrphans
          ? 'Preset restored. ' + skippedOrphans + ' saved slot(s) skipped (gear not currently equipped).'
          : 'Preset "' + preset.name + '" restored.',
        true
      );
    } finally {
      presetOpBusy = false;
    }
  }

  function parseCrystalEffect(infoHtml) {
    if (!infoHtml) return { type: 'unknown', value: 0 };
    const atk = /<span>Attack<\/span>\s*<strong>(\d+)<\/strong>/.exec(infoHtml);
    if (atk) return { type: 'attack', value: parseInt(atk[1], 10) || 0 };
    const def = /<span>Defense<\/span>\s*<strong>(\d+)<\/strong>/.exec(infoHtml);
    if (def) return { type: 'defense', value: parseInt(def[1], 10) || 0 };
    return { type: 'unknown', value: 0 };
  }

  function computeBestAssignmentForCards(workingItems, currentSnap, catalog, selectedKeys) {
    // Free whatever the selected cards currently hold — those crystals go back into the pool.
    selectedKeys.forEach((key) => {
      const idx = workingItems.findIndex((i) => i.key === key);
      if (idx >= 0) workingItems.splice(idx, 1);
    });

    // Track which remaining (non-selected) item currently holds each crystal, so we can
    // pull it off that card if auto-assign decides to reuse it on a selected card instead.
    const holderOf = {}; // crystalId -> workingItems entry
    workingItems.forEach((item) => {
      item.crystalIds.forEach((id) => { holderOf[id] = item; });
    });

    // Every activated crystal is a candidate now, including ones currently equipped
    // on non-selected cards — taking one just unequips it from that card in the preset.
    const candidates = Object.keys(catalog)
      .map((id) => {
        const c = catalog[id];
        const eff = parseCrystalEffect(c.infoHtml);
        return { id, type: eff.type, value: eff.value, level: parseInt((c.level || '').replace(/\D/g, ''), 10) || 0 };
      });

    const byBest = (a, b) => (b.value - a.value) || (b.level - a.level);
    const attackPool = candidates.filter((c) => c.type === 'attack').sort(byBest);
    const defensePool = candidates.filter((c) => c.type === 'defense').sort(byBest);
    const otherPool = candidates.filter((c) => c.type !== 'attack' && c.type !== 'defense').sort(byBest);

    function takeFrom(pool) {
      if (!pool.length) return null;
      const picked = pool.shift();
      const holder = holderOf[picked.id];
      if (holder) {
        holder.crystalIds = holder.crystalIds.filter((cid) => cid !== picked.id);
        if (!holder.crystalIds.length) {
          const idx = workingItems.indexOf(holder);
          if (idx >= 0) workingItems.splice(idx, 1);
        }
        delete holderOf[picked.id];
      }
      return picked.id;
    }

    // Now type-aware: won't offer a type that's already on this card.
    function bestRemainingType(usedTypes) {
      const opts = [];
      if (!usedTypes.has('attack') && attackPool.length) opts.push(['attack', attackPool[0]]);
      if (!usedTypes.has('defense') && defensePool.length) opts.push(['defense', defensePool[0]]);
      if (!usedTypes.has('other') && otherPool.length) opts.push(['other', otherPool[0]]);
      if (!opts.length) return null;
      opts.sort((a, b) => byBest(a[1], b[1]));
      return opts[0][0];
    }

    let assignedCount = 0;
    currentSnap.forEach((eq) => {
      if (!selectedKeys.has(eq.key)) return;
      const ids = [];
      const usedTypes = new Set(); // per-card type tracker

      const atkId = takeFrom(attackPool);
      if (atkId) { ids.push(atkId); usedTypes.add('attack'); }
      const defId = takeFrom(defensePool);
      if (defId) { ids.push(defId); usedTypes.add('defense'); }

      while (ids.length < eq.slotCount) {
        const type = bestRemainingType(usedTypes);
        if (!type) break;
        const id = type === 'attack' ? takeFrom(attackPool) : type === 'defense' ? takeFrom(defensePool) : takeFrom(otherPool);
        if (!id) break;
        ids.push(id);
        usedTypes.add(type);
      }

      if (ids.length) {
        workingItems.push({ key: eq.key, crystalIds: ids });
        assignedCount++;
      }
    });

    return { assignedCount };
  }

  // ---------- Module A: Crystal AJAX Helper ----------

  async function runCrystalAction(form, successMsg) {
    if (crystalActionBusy) return false;
    crystalActionBusy = true;
    try {
      const body = new URLSearchParams(new FormData(form));
      const res = await fetch(location.href, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        credentials: 'include',
      });
      if (!res.ok) {
        notify('Action failed (' + res.status + ').', false);
        return false;
      }
      const html = await res.text();
      const { ok, flash } = applyFreshHtml(html);
      if (!ok) {
        notify('Unexpected response from server.', false);
        return false;
      }
      if (flash) {
        notify(flash.textContent.trim(), !flash.classList.contains('err'));
      } else {
        notify(successMsg, true);
      }
      return true;
    } catch (err) {
      notify('Server error.', false);
      return false;
    } finally {
      crystalActionBusy = false;
    }
  }

  // Everything below only applies on power_crystals.php itself — the
  // forms, modals, and globals (pickerEquipmentId, pendingUnequipCrystalId,
  // etc.) it references only exist on that page.
  if (onCrystalsPage()) {

    // ---- Equip: overrides the page's own pickCrystal(), which normally
    //      hard-submits #equipCrystalForm ----
    window.pickCrystal = async function (crystalId) {
      document.getElementById('equipCrystalId').value = crystalId;
      document.getElementById('equipEquipmentId').value = pickerEquipmentId;
      const form = document.getElementById('equipCrystalForm');
      if (await runCrystalAction(form, 'Crystal equipped.')) {
        pickerEquipmentId = 0;
      }
      if (typeof closeModal === 'function') closeModal('pickerModal');
    };

    // ---- Unequip: overrides submitUnequipCrystal() ----
    window.submitUnequipCrystal = async function () {
      if (!pendingUnequipCrystalId) return;
      document.getElementById('unequipCrystalId').value = pendingUnequipCrystalId;
      const form = document.getElementById('unequipCrystalForm');
      if (await runCrystalAction(form, 'Crystal removed.')) {
        pendingUnequipCrystalId = 0;
      }
      if (typeof closeModal === 'function') closeModal('confirmModal');
    };

    // ---- Level Up / Star Up: overrides submitUpgradeCrystal() ----
    window.submitUpgradeCrystal = async function () {
      if (!pendingUpgradeAction || !pendingUpgradeCrystalId) return;
      document.getElementById('upgradeCrystalAction').value = pendingUpgradeAction;
      document.getElementById('upgradeCrystalId').value = pendingUpgradeCrystalId;
      const form = document.getElementById('upgradeCrystalForm');
      if (await runCrystalAction(form, 'Crystal upgraded.')) {
        pendingUpgradeAction = '';
        pendingUpgradeCrystalId = 0;
      }
      if (typeof closeModal === 'function') closeModal('upgradeModal');
    };

    // ---- Activate: a real <form> with a real submit button, so (unlike
    //      the three above) this DOES fire a `submit` event — caught here
    //      in the capture phase, ahead of the form's own
    //      onsubmit="return confirm(...)" attribute. ----
    document.addEventListener('submit', function (e) {
      const form = e.target;
      if (!(form instanceof HTMLFormElement)) return;
      const actionField = form.querySelector('input[name="action"]');
      if (!actionField || actionField.value !== 'activate_crystal') return;

      e.preventDefault();
      e.stopPropagation();

      if (!confirm('Activate this crystal? Once activated, it can no longer be used as fodder.')) {
        return;
      }
      runCrystalAction(form, 'Crystal activated.');
    }, true);

  }

  // ---------- UI ----------

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .pcp-row { display:flex; justify-content:space-between; align-items:center; gap:12px;
        padding:12px; background:#11192d; border:1px solid rgba(255,255,255,.06);
        border-radius:14px; margin-bottom:10px; flex-wrap:wrap; }
      .pcp-row-name { font-weight:800; }
      .pcp-row-meta { color:#9caad0; font-size:12px; margin-top:2px; }
      .pcp-equipped-badge{
        display:inline-block; font-size:10px; font-weight:800; letter-spacing:.03em;
        text-transform:uppercase; color:#8ee6a8; background:rgba(46,204,113,.12);
        border:1px solid rgba(46,204,113,.35); border-radius:999px; padding:2px 7px;
        vertical-align:middle; margin-left:6px;
      }
      .pcp-row-icons { display:flex; flex-wrap:wrap; gap:4px; margin-top:6px; align-items:center; }
      .pcp-row-icons img { width:24px; height:24px; border-radius:6px; object-fit:cover;
        border:1px solid rgba(255,255,255,.08); background:#0d1322; }
      .pcp-row-icons span { font-size:11px; color:#9caad0; }
      .pcp-row-actions { display:flex; gap:6px; flex-wrap:wrap; }
      .pcp-row-actions .pcp-btn { padding:6px 10px; font-size:12px; }
      .pcp-editor-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));
        gap:14px; max-height:50vh; overflow:auto; padding-right:4px; }
      .pcp-eq-card { background:#11192d; border:1px solid rgba(255,255,255,.06); border-radius:16px;
        padding:14px; display:flex; gap:12px; align-items:center; }
      .pcp-eq-icon { width:56px; height:56px; border-radius:12px; overflow:hidden; background:#0d1322;
        border:1px solid rgba(255,255,255,.08); flex-shrink:0; }
      .pcp-eq-icon img { width:100%; height:100%; object-fit:cover; display:block; }
      .pcp-orphan-row { display:flex; align-items:center; gap:10px; background:#11192d;
        border:1px solid rgba(255,255,255,.06); border-radius:12px; padding:8px 10px; margin-top:8px; }
      .pcp-orphan-row img { width:32px; height:32px; border-radius:8px; object-fit:cover; }
      .pcp-orphan-row span { flex:1; color:#9caad0; font-size:13px; }

      .pcp-menu-btn{ width:34px; height:34px; padding:0; display:inline-flex; align-items:center;
        justify-content:center; font-size:18px; line-height:1; border-radius:10px; }
      .pcp-menu-dropdown{ position:fixed; z-index:300050;
        background:#171e33; border:1px solid rgba(255,255,255,.1); border-radius:12px;
        box-shadow:0 12px 28px rgba(0,0,0,.45); min-width:150px; padding:6px; display:none; }
      .pcp-menu-dropdown.open{ display:block; }
      .pcp-menu-item{ display:block; width:100%; text-align:left; background:none; border:none;
        color:#e7ecff; padding:8px 10px; border-radius:8px; font-size:13px; cursor:pointer;
        font-family:Arial,sans-serif; }
      .pcp-menu-item:hover{ background:rgba(255,255,255,.06); }
      .pcp-menu-item.danger{ color:#ff8a97; }

      .pcp-slot-remove{
        position:absolute; top:2px; right:2px; width:16px; height:16px;
        border-radius:50%; border:none; background:rgba(10,15,28,.85);
        color:#fff; font-size:12px; line-height:16px; padding:0; cursor:pointer;
        display:flex; align-items:center; justify-content:center;
      }
      .pcp-slot-remove:hover{ background:rgba(255,107,122,.9); }

      .pcp-eq-card{
        cursor:pointer;
        position:relative;
        transition: transform .15s ease, box-shadow .15s ease, border-color .15s ease, background .15s ease;
      }
      .pcp-eq-card:hover{
        transform: translateY(-2px);
        border-color: rgba(110,168,255,.3);
        box-shadow: 0 8px 20px rgba(0,0,0,.35);
        background:#141d38;
      }
      .pcp-eq-card.pcp-selected{
        border-color: rgba(110,168,255,.35);
        background: rgba(110,168,255,.05);
        box-shadow: inset 3px 0 0 #6ea8ff;
      }
      .pcp-eq-card.pcp-selected:hover{
        transform: translateY(-2px);
        box-shadow: 0 0 0 2px rgba(110,168,255,.45) inset, 0 10px 24px rgba(110,168,255,.22);
      }

      .pcp-slot-stars{
        position:absolute; left:2px; bottom:2px;
        font-size:9px; font-weight:800;
        background:rgba(10,15,28,.85);
        border-radius:999px; padding:1px 4px;
        color:#ffd978;
        pointer-events:none;
      }

      #pcpModal.show, #pcpEditorModal.show, #pcpPickerModal.show, #pcpDetailModal.show {
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;
      }
      #pcpModal.show::before, #pcpEditorModal.show::before,
      #pcpPickerModal.show::before, #pcpDetailModal.show::before {
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;
      }

      .pcp-free-counter{
        color:#9caad0; font-size:13px; font-weight:600; margin-bottom:10px;
      }

      /* =====================================================================
         Self-contained replacements for classes this UI used to borrow from
         power_crystals.php's own <head> stylesheet (.modal, .btn*, .picker-*,
         .crystal-image, .star-badge, .slot-row/.slot-btn, .confirm-actions,
         .empty-state). That stylesheet only loads on power_crystals.php, so
         elsewhere those classes had no rules — .modal in particular has no
         default display:none off that page, so the modals sat visible and
         unstyled instead of just looking wrong.
         ===================================================================== */

      .pcp-modal{
        position:fixed;
        inset:0;
        background:rgba(6,10,18,.74);
        display:none;
        align-items:center;
        justify-content:center;
        padding:20px;
        z-index:300000;
        backdrop-filter:blur(7px);
      }
      .pcp-modal.show{ display:flex; }
      /* scrolls, but no visible scrollbar */
      .pcp-modal-card, .pcp-editor-grid, .pcp-picker-grid{ scrollbar-width:none; -ms-overflow-style:none; }
      .pcp-modal-card::-webkit-scrollbar, .pcp-editor-grid::-webkit-scrollbar, .pcp-picker-grid::-webkit-scrollbar{ display:none; width:0; height:0; }

      .pcp-modal-card{
        width:min(780px, 100%);
        max-height:90vh;
        overflow:auto;
        background:linear-gradient(180deg, rgba(24,34,56,.98), rgba(14,20,34,.98));
        border:1px solid rgba(255,255,255,.08);
        border-radius:24px;
        box-shadow:0 26px 60px rgba(0,0,0,.38);
        padding:22px;
        color:#eef3ff;
        font-family:Arial,sans-serif;
      }

      .pcp-modal-head{
        display:flex;
        justify-content:space-between;
        align-items:center;
        gap:12px;
        margin-bottom:16px;
      }
      .pcp-modal-title{ margin:0; font-size:24px; }
      .pcp-close-btn{
        width:40px; height:40px; border-radius:12px; border:none;
        background:#18223a; color:#fff; font-size:22px; cursor:pointer;
      }

      .pcp-btn{
        border:none; cursor:pointer; text-decoration:none; color:#fff;
        background:linear-gradient(135deg, #3657a7, #4b6dd0);
        padding:10px 14px; border-radius:12px; font-weight:700;
        font-family:Arial,sans-serif; font-size:14px;
        box-shadow:0 8px 18px rgba(41,72,155,.28); transition:.18s ease;
      }
      .pcp-btn:hover{ transform:translateY(-1px); filter:brightness(1.05); }
      .pcp-btn-soft{ background:linear-gradient(135deg, #222d49, #2b3859); box-shadow:none; }
      .pcp-btn-danger{ background:linear-gradient(135deg, #7b3040, #b4465c); }
      .pcp-btn-success{ background:linear-gradient(135deg, #217f5b, #33b57f); }
      .pcp-btn:disabled{
        opacity:.45; cursor:not-allowed; transform:none !important;
        filter:none !important; box-shadow:none;
      }

      .pcp-picker-grid{
        display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:14px;
      }
      .pcp-picker-card{
        background:#10182a; border:1px solid rgba(255,255,255,.06);
        border-radius:18px; padding:14px; text-align:center;
      }
      .pcp-picker-card .pcp-crystal-image{ width:138px; height:138px; border-radius:18px; }
      .pcp-picker-meta{ color:#9caad0; font-size:12px; margin-top:10px; text-align:center; }
      .pcp-picker-card .pcp-btn{ width:100%; margin-top:12px; }

      .pcp-crystal-image{
        position:relative; width:138px; height:138px; border:none; padding:0;
        border-radius:22px; overflow:hidden; background:#0d1322; cursor:pointer;
        box-shadow:0 14px 28px rgba(0,0,0,.22); display:block; margin:0 auto;
      }
      .pcp-crystal-image img{
        width:100%; height:100%; object-fit:cover; display:block; transition:transform .2s ease;
      }
      .pcp-crystal-image:hover img{ transform:scale(1.05); }

      .pcp-star-badge{
        position:absolute; top:8px; right:8px; min-width:34px; text-align:center;
        background:rgba(8,12,22,.82); border:1px solid rgba(255,255,255,.1); color:#ffd978;
        border-radius:999px; padding:5px 8px; font-size:12px; font-weight:800;
        backdrop-filter:blur(8px);
      }

      .pcp-slot-row{ display:flex; gap:10px; flex-wrap:wrap; }
      .pcp-slot-btn{
        width:48px; height:48px; border-radius:14px; border:1px dashed rgba(255,255,255,.16);
        background:#10182a; cursor:pointer; position:relative; overflow:hidden;
        transition: transform .12s ease, box-shadow .12s ease, background .12s ease, border-color .12s ease;
      }
      .pcp-slot-btn:hover{ transform:scale(1.07); box-shadow:0 4px 10px rgba(0,0,0,.35); z-index:1; }
      .pcp-slot-btn.empty::before{ content:"+"; color:#8ea1d9; font-size:22px; font-weight:700; }
      .pcp-slot-btn.filled{ border-style:solid; border-color:rgba(110,168,255,.35); background:#0f1628; }
      .pcp-slot-btn.filled img{ width:100%; height:100%; object-fit:cover; display:block; }
      /* No ::after "×" here (unlike the page's native .slot-btn.filled) —
         .pcp-slot-remove already supplies a real, clickable remove button in
         the same corner, so there's nothing to hide. */

      .pcp-confirm-actions{ display:flex; justify-content:flex-end; gap:10px; flex-wrap:wrap; }

      .pcp-empty-state{
        padding:34px 18px; text-align:center; color:#9caad0;
        background:rgba(255,255,255,.02); border:1px dashed rgba(255,255,255,.08); border-radius:18px;
      }

      /* info-stack / info-box / info-line / info-empty stay UNPREFIXED: this
         markup is server-supplied verbatim via each crystal's data-info
         attribute (see scanCrystalCatalog's infoHtml), so we can't rename
         classes we didn't generate. This just duplicates the CSS, since the
         page's own copy only loads on power_crystals.php. */
      .info-stack{ display:grid; gap:12px; }
      .info-box{ background:#11192d; border:1px solid rgba(255,255,255,.06); border-radius:16px; padding:14px; }
      .info-box h4{ margin:0 0 10px; font-size:14px; color:#cfd8f7; }
      .info-line{
        display:flex; justify-content:space-between; gap:16px; padding:7px 0;
        border-bottom:1px solid rgba(255,255,255,.05); font-size:14px; color:#eef3ff;
      }
      .info-line:last-child{ border-bottom:none; }
      .info-empty{ color:#9caad0; font-size:14px; }
    `;
    document.head.appendChild(style);
  }

  function closePcpModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove('show');
  }

  // One shared dropdown attached to <body>, positioned via JS. Keeps it out of
  // any scrollable ancestor so it can't grow a modal's scroll area anymore.
  let presetMenuMountedFor = null;
  function getPresetMenuEl() {
    let el = document.getElementById('pcpSharedMenu');
    if (!el) {
      el = document.createElement('div');
      el.id = 'pcpSharedMenu';
      el.className = 'pcp-menu-dropdown';
      document.body.appendChild(el);
    }
    return el;
  }

  function togglePresetMenu(anchorBtn, preset) {
    const menu = getPresetMenuEl();
    const isOpenForThis = menu.classList.contains('open') && presetMenuMountedFor === preset.id;
    menu.classList.remove('open');
    if (isOpenForThis) { presetMenuMountedFor = null; return; }

    menu.innerHTML = '';
    [
      ['Edit', () => openEditor(preset)],
      ['Rename', () => renamePreset(preset)],
      ['Duplicate', () => duplicatePreset(preset)],
      ['Delete', () => deletePreset(preset), true],
    ].forEach(([label, fn, danger]) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'pcp-menu-item' + (danger ? ' danger' : '');
      item.textContent = label;
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.classList.remove('open');
        presetMenuMountedFor = null;
        fn();
      });
      menu.appendChild(item);
    });

    const rect = anchorBtn.getBoundingClientRect();
    menu.style.top = (rect.bottom + 6) + 'px';
    menu.style.left = 'auto';
    menu.style.right = (window.innerWidth - rect.right) + 'px';
    menu.classList.add('open');
    presetMenuMountedFor = preset.id;
  }

  function mkBtn(cls, label, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pcp-btn ' + cls;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  // NOTE: async now — off the crystals page there's no live DOM to read
  // equipment/crystal state from, so this has to fetch (or reuse a cached
  // fetch of) power_crystals.php via getContextDoc() before it can render
  // anything meaningful. Pass forceRefresh=true to bypass the cache (used
  // by the ⟳ Refresh button).
  async function renderPresetList(forceRefresh = false) {
    const wrap = document.getElementById('pcpList');
    const presets = loadPresets();
    if (!presets.length) {
      wrap.innerHTML = '<div class="pcp-empty-state">No saved presets yet. Capture your current setup or start a blank one.</div>';
      return;
    }

    wrap.innerHTML = '<div class="pcp-empty-state">Loading current equipment…</div>';

    let ctxDoc;
    try {
      ctxDoc = await getContextDoc(forceRefresh);
    } catch (err) {
      wrap.innerHTML = '<div class="pcp-empty-state">Could not reach the Power Crystals page to read current equipment. Check your connection and try again.</div>';
      return;
    }

    const catalog = scanCrystalCatalog(ctxDoc);
    const currentSnap = scanEquipmentSnapshot(ctxDoc);
    wrap.innerHTML = '';
    presets.forEach((preset) => {
      const row = document.createElement('div');
      row.className = 'pcp-row';

      const info = document.createElement('div');
      const totalCrystals = preset.items.reduce((n, i) => n + i.crystalIds.length, 0);
      const isEquipped = presetMatchesCurrent(preset, currentSnap);
      info.innerHTML = `<div class="pcp-row-name">${escapeHtmlLocal(preset.name)}${isEquipped ? ' <span class="pcp-equipped-badge">Equipped</span>' : ''}</div>
        <div class="pcp-row-meta">${preset.items.length} equipment piece(s) · ${totalCrystals} crystal(s)</div>`;

      const icons = document.createElement('div');
      icons.className = 'pcp-row-icons';
      // Every piece is shown (no "+N" cut-off); the strip wraps onto more lines if needed.
      preset.items.forEach((item) => {
        const img = document.createElement('img');
        img.src = item.key;
        img.title = item.crystalIds.length + ' crystal(s) linked';
        icons.appendChild(img);
      });
      info.appendChild(icons);
      row.appendChild(info);

      const actions = document.createElement('div');
      actions.className = 'pcp-row-actions';
      actions.appendChild(mkBtn('pcp-btn-success', '▶ Restore', () => restorePreset(preset)));
      const menuBtn = mkBtn('pcp-btn-soft pcp-menu-btn', '⋯', (e) => {
        e.stopPropagation();
        togglePresetMenu(menuBtn, preset);
      });
      actions.appendChild(menuBtn);
      row.appendChild(actions);

      wrap.appendChild(row);
    });
  }

    function presetMatchesCurrent(preset, currentSnap) {
    const currentLinks = {};
    currentSnap.forEach((e) => e.crystalIds.forEach((id) => { currentLinks[id] = e.key; }));

    const currentKeys = new Set(currentSnap.map((e) => e.key));
    const desiredLinks = {};
    preset.items.forEach((item) => {
      if (!currentKeys.has(item.key)) return;
      item.crystalIds.forEach((id) => { desiredLinks[id] = item.key; });
    });

    const toUnequip = Object.keys(currentLinks).some((id) => desiredLinks[id] !== currentLinks[id]);
    const toEquip = Object.keys(desiredLinks).some((id) => currentLinks[id] !== desiredLinks[id]);
    return !toUnequip && !toEquip;
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
    if (!confirm('Delete preset "' + preset.name + '"? This cannot be undone.')) return;
    savePresets(loadPresets().filter((p) => p.id !== preset.id));
    renderPresetList();
  }

  function setSlot(workingItems, key, index, crystalIdOrNull) {
    let item = workingItems.find((i) => i.key === key);
    if (!item) {
      if (crystalIdOrNull == null) return;
      item = { key, crystalIds: [] };
      workingItems.push(item);
    }
    if (crystalIdOrNull == null) {
      item.crystalIds.splice(index, 1);
    } else {
      item.crystalIds[index] = crystalIdOrNull;
    }
    item.crystalIds = item.crystalIds.filter(Boolean);
    if (!item.crystalIds.length) {
      const idx = workingItems.indexOf(item);
      if (idx >= 0) workingItems.splice(idx, 1);
    }
  }

  function openCrystalPicker(catalog, usedIds, onPick) {
    const body = document.getElementById('pcpPickerBody');
    const available = Object.keys(catalog).filter((id) => !usedIds.has(id));
    if (!available.length) {
      body.innerHTML = '<div class="pcp-empty-state">No unused activated crystals available.</div>';
    } else {
      body.innerHTML = '<div class="pcp-picker-grid"></div>';
      const grid = body.querySelector('.pcp-picker-grid');
      available.forEach((id) => {
        const c = catalog[id];
        const card = document.createElement('div');
        card.className = 'pcp-picker-card';
        card.innerHTML = `
          <div class="pcp-crystal-image" style="cursor:default;">
            <img src="${c.image}">
            ${c.stars ? `<div class="pcp-star-badge">${escapeHtmlLocal(c.stars)}</div>` : ''}
          </div>
          <div class="pcp-picker-meta">${escapeHtmlLocal(c.name)}${c.level ? ' · ' + escapeHtmlLocal(c.level) : ''}</div>
        `;
        const chooseBtn = mkBtn('pcp-btn-success', 'Choose', () => {
          closePcpModal('pcpPickerModal');
          onPick(id);
        });
        card.appendChild(chooseBtn);
        grid.appendChild(card);
      });
    }
    document.getElementById('pcpPickerModal').classList.add('show');
  }

  function openCrystalDetailModal(c, crystalId, onRemove) {
    document.getElementById('pcpDetailTitle').textContent = c ? c.name : ('Crystal #' + crystalId);
    document.getElementById('pcpDetailBody').innerHTML =
      (c && c.infoHtml) ? c.infoHtml : '<div class="info-empty">No details available.</div>';
    const removeBtn = document.getElementById('pcpDetailRemoveBtn');
    removeBtn.onclick = () => {
      closePcpModal('pcpDetailModal');
      onRemove();
    };
    document.getElementById('pcpDetailModal').classList.add('show');
  }

  function renderEditorGrid(workingItems, currentSnap, catalog, selectedKeys) {
    const grid = document.getElementById('pcpEditorGrid');
    const usedIds = new Set(workingItems.flatMap((i) => i.crystalIds));

    const freeCount = Object.keys(catalog).length - usedIds.size;
    const counterEl = document.getElementById('pcpFreeCounter');
    if (counterEl) counterEl.textContent = freeCount + ' crystal(s) free';

    grid.innerHTML = '';

    currentSnap.forEach((eq) => {
      const item = workingItems.find((i) => i.key === eq.key);
      const ids = item ? item.crystalIds : [];

      const card = document.createElement('div');
      card.className = 'pcp-eq-card' + (selectedKeys.has(eq.key) ? ' pcp-selected' : '');
      card.title = 'Click to include/exclude from Auto-assign Best';
      card.addEventListener('click', (e) => {
        if (e.target.closest('.slot-btn')) return; // let slot buttons handle their own clicks
        const nowSelected = !selectedKeys.has(eq.key);
        if (nowSelected) selectedKeys.add(eq.key); else selectedKeys.delete(eq.key);
        card.classList.toggle('pcp-selected', nowSelected);
      });

      const iconWrap = document.createElement('div');
      iconWrap.className = 'pcp-eq-icon';
      const iconImg = document.createElement('img');
      iconImg.src = eq.key;
      iconWrap.appendChild(iconImg);
      card.appendChild(iconWrap);

      const slotsWrap = document.createElement('div');
      slotsWrap.className = 'pcp-slot-row';
      for (let i = 0; i < eq.slotCount; i++) {
        const crystalId = ids[i];
        const btn = document.createElement('button');
        btn.type = 'button';
        if (crystalId) {
          btn.className = 'pcp-slot-btn filled';
          const c = catalog[crystalId];
          const img = document.createElement('img');
          if (c && c.image) img.src = c.image;
          img.title = c ? c.name : ('Crystal #' + crystalId);
          btn.appendChild(img);

          if (c && c.stars) {
            const starsEl = document.createElement('span');
            starsEl.className = 'pcp-slot-stars';
            starsEl.textContent = c.stars;
            btn.appendChild(starsEl);
          }

          btn.addEventListener('click', () => {
            openCrystalDetailModal(c, crystalId, () => {
              setSlot(workingItems, eq.key, i, null);
              renderEditorGrid(workingItems, currentSnap, catalog, selectedKeys);
            });
          });

          const removeBtn = document.createElement('button');
          removeBtn.type = 'button';
          removeBtn.className = 'pcp-slot-remove';
          removeBtn.title = 'Remove from slot';
          removeBtn.textContent = '×';
          removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            setSlot(workingItems, eq.key, i, null);
            renderEditorGrid(workingItems, currentSnap, catalog, selectedKeys);
          });
          btn.appendChild(removeBtn);
        } else {
          btn.className = 'pcp-slot-btn empty';
          btn.addEventListener('click', () => {
            openCrystalPicker(catalog, usedIds, (chosenId) => {
              setSlot(workingItems, eq.key, i, chosenId);
              renderEditorGrid(workingItems, currentSnap, catalog, selectedKeys);
            });
          });
        }
        slotsWrap.appendChild(btn);
      }
      card.appendChild(slotsWrap);
      grid.appendChild(card);
    });

    const orphanWrap = document.getElementById('pcpOrphanSection');
    const currentKeys = new Set(currentSnap.map((e) => e.key));
    const orphans = workingItems.filter((i) => !currentKeys.has(i.key) && i.crystalIds.length);
    orphanWrap.innerHTML = '';
    if (orphans.length) {
      const hdr = document.createElement('div');
      hdr.style.cssText = 'margin-top:16px; color:var(--muted); font-size:13px;';
      hdr.textContent = 'Saved but not currently equipped (kept as-is; remove if you no longer want them):';
      orphanWrap.appendChild(hdr);
      orphans.forEach((o) => {
        const row = document.createElement('div');
        row.className = 'pcp-orphan-row';
        const img = document.createElement('img');
        img.src = o.key;
        const label = document.createElement('span');
        label.textContent = o.crystalIds.length + ' crystal(s)';
        const rm = mkBtn('pcp-btn-danger', 'Remove', () => {
          const idx = workingItems.indexOf(o);
          if (idx >= 0) workingItems.splice(idx, 1);
          renderEditorGrid(workingItems, currentSnap, catalog, selectedKeys);
        });
        row.appendChild(img);
        row.appendChild(label);
        row.appendChild(rm);
        orphanWrap.appendChild(row);
      });
    }
  }

  // NOTE: async now, same reason as renderPresetList — needs a context doc
  // before it has any equipment/catalog data to build the grid from. The
  // modal is shown immediately with a loading placeholder so it doesn't
  // feel unresponsive while the fetch is in flight.
  async function openEditor(preset) {
    const modal = document.getElementById('pcpEditorModal');
    document.getElementById('pcpEditorName').textContent = preset.name;
    document.getElementById('pcpFreeCounter').textContent = '';
    document.getElementById('pcpEditorGrid').innerHTML = '<div class="empty-state">Loading current equipment…</div>';
    document.getElementById('pcpOrphanSection').innerHTML = '';
    modal.classList.add('show');

    const working = JSON.parse(JSON.stringify(preset));

    let ctxDoc;
    try {
      ctxDoc = await getContextDoc();
    } catch (err) {
      document.getElementById('pcpEditorGrid').innerHTML =
        '<div class="empty-state">Could not reach the Power Crystals page to read current equipment. Check your connection and try again.</div>';
      return;
    }

    const currentSnap = scanEquipmentSnapshot(ctxDoc);
    const catalog = scanCrystalCatalog(ctxDoc);

    const selectedKeys = new Set(
      Array.isArray(working.selectedKeys)
        ? working.selectedKeys.filter((key) => currentSnap.some((eq) => eq.key === key))
        : currentSnap
            .filter((eq) => {
              const item = working.items.find((i) => i.key === eq.key);
              return item && item.crystalIds.length > 0;
            })
            .map((eq) => eq.key)
    );

    document.getElementById('pcpEditorName').textContent = working.name;
    renderEditorGrid(working.items, currentSnap, catalog, selectedKeys);

    document.getElementById('pcpEditorAutoAssign').onclick = () => {
      if (!selectedKeys.size) { notify('Select at least one equipment piece first.', false); return; }
      const result = computeBestAssignmentForCards(working.items, currentSnap, catalog, selectedKeys);
      renderEditorGrid(working.items, currentSnap, catalog, selectedKeys);
      notify(
        result.assignedCount
          ? 'Auto-assigned best crystals to ' + result.assignedCount + ' item(s).'
          : 'No crystals were available to assign.',
        !!result.assignedCount
      );
    };

    document.getElementById('pcpEditorSave').onclick = () => {
      working.selectedKeys = Array.from(selectedKeys);
      working.updatedAt = Date.now();
      const list = loadPresets();
      const idx = list.findIndex((p) => p.id === working.id);
      if (idx >= 0) list[idx] = working; else list.push(working);
      savePresets(list);
      renderPresetList();
      closePcpModal('pcpEditorModal');
      notify('Saved preset "' + working.name + '".', true);
    };
  }

  let pcpPanel = null, pcpHome = null;

  function buildUI() {
    injectStyles();

    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="pcp-modal" id="pcpModal">
        <div class="pcp-modal-card" style="max-width:640px;">
          <div class="pcp-modal-head">
            <h3 class="pcp-modal-title">Crystal Presets</h3>
            <button type="button" class="pcp-close-btn" data-pcp-close="pcpModal">&times;</button>
          </div>
          <div id="pcpList"></div>
          <div class="pcp-confirm-actions" style="margin-top:16px;">
            <button type="button" class="pcp-btn pcp-btn-soft" id="pcpRefreshBtn" title="Re-fetch current equipment from the Power Crystals page">⟳ Refresh</button>
            <div style="flex:1 1 auto;"></div>
            <button type="button" class="pcp-btn pcp-btn-soft" id="pcpNewBlank">+ New Preset</button>
            <button type="button" class="pcp-btn pcp-btn-success" id="pcpCaptureBtn">Capture</button>
          </div>
        </div>
      </div>

      <div class="pcp-modal" id="pcpEditorModal">
        <div class="pcp-modal-card" style="max-width:820px;">
          <div class="pcp-modal-head">
            <h3 class="pcp-modal-title">Edit Preset — <span id="pcpEditorName"></span></h3>
            <button type="button" class="pcp-close-btn" data-pcp-close="pcpEditorModal">&times;</button>
          </div>
          <div id="pcpFreeCounter" class="pcp-free-counter"></div>
          <div id="pcpEditorGrid" class="pcp-editor-grid"></div>
          <div id="pcpOrphanSection"></div>
          <div class="pcp-confirm-actions" style="margin-top:16px;">
            <button type="button" class="pcp-btn pcp-btn-soft" id="pcpEditorAutoAssign">⚡ Auto-assign Best (Selected)</button>
            <div style="flex:1 1 auto;"></div>
            <button type="button" class="pcp-btn pcp-btn-soft" data-pcp-close="pcpEditorModal">Cancel</button>
            <button type="button" class="pcp-btn pcp-btn-success" id="pcpEditorSave">Save Preset</button>
          </div>
        </div>
      </div>

      <div class="pcp-modal" id="pcpPickerModal">
        <div class="pcp-modal-card">
          <div class="pcp-modal-head">
            <h3 class="pcp-modal-title">Choose a Crystal</h3>
            <button type="button" class="pcp-close-btn" data-pcp-close="pcpPickerModal">&times;</button>
          </div>
          <div id="pcpPickerBody"></div>
        </div>
      </div>

      <div class="pcp-modal" id="pcpDetailModal">
        <div class="pcp-modal-card" style="max-width:520px;">
          <div class="pcp-modal-head">
            <h3 class="pcp-modal-title" id="pcpDetailTitle">Crystal</h3>
            <button type="button" class="pcp-close-btn" data-pcp-close="pcpDetailModal">&times;</button>
          </div>
          <div id="pcpDetailBody"></div>
          <div class="pcp-confirm-actions" style="margin-top:16px;">
            <button type="button" class="pcp-btn pcp-btn-soft" data-pcp-close="pcpDetailModal">Close</button>
            <button type="button" class="pcp-btn pcp-btn-danger" id="pcpDetailRemoveBtn">Remove from Slot</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(wrap);

    // The main presets panel is shown by Core's floating-button system (the 💎 button) instead of
    // its own modal. It's built here, parked in a hidden holder so getElementById() keeps
    // working, and moved into Core's panel when the button is clicked.
    const mainModal = wrap.querySelector('#pcpModal');
    pcpPanel = document.createElement('div');
    pcpPanel.id = 'pcpPanel';
    mainModal.querySelectorAll('.pcp-modal-card > :not(.pcp-modal-head)').forEach((n) => pcpPanel.appendChild(n));
    mainModal.remove();
    pcpHome = document.createElement('div');
    pcpHome.style.display = 'none';
    pcpHome.appendChild(pcpPanel);
    document.body.appendChild(pcpHome);

    document.body.addEventListener('click', (e) => {
      const closeBtn = e.target.closest('[data-pcp-close]');
      if (closeBtn) closePcpModal(closeBtn.getAttribute('data-pcp-close'));
      if (!e.target.closest('.pcp-menu-dropdown') && !e.target.closest('.pcp-menu-btn')) {
        const menu = document.getElementById('pcpSharedMenu');
        if (menu) menu.classList.remove('open');
        presetMenuMountedFor = null;
      }
    });

    ['pcpEditorModal', 'pcpPickerModal', 'pcpDetailModal'].forEach((id) => {
      document.getElementById(id).addEventListener('click', (e) => {
        if (e.target.id === id) closePcpModal(id);
      });
    });

    document.getElementById('pcpRefreshBtn').addEventListener('click', () => renderPresetList(true));

    document.getElementById('pcpNewBlank').addEventListener('click', () => {
      const name = prompt('Name this new preset:', 'Preset ' + (loadPresets().length + 1));
      if (name == null) return;
      openEditor({ id: makePresetId(), name: name.trim() || 'Untitled preset', items: [], updatedAt: Date.now() });
    });

    document.getElementById('pcpCaptureBtn').addEventListener('click', captureCurrent);
  }

  buildUI();

  // Register the floating 💎 button + panel with Core.
  Core.float.add({
    id: 'crystal-presets', title: 'Crystal Presets', icon: '💎', order: 10,
    render(el) { el.replaceChildren(pcpPanel); },
    onShow() { renderPresetList(); },
    onHide() { if (pcpHome && pcpPanel) pcpHome.appendChild(pcpPanel); },
  });
})();