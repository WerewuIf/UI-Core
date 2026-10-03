/* Pet Team Presets + Sigil Helper — Core addon (migrated from the standalone userscript).
 * Loaded by core.user.js; `Core` is in scope. No @require / header needed.
 * Floating 🐾 button + panel; fallback toast via Core.ui.toast (site notifier still preferred); pets.php?team= reads via Core.net.
 */

/* ===========================================================================
 * 2.3.0
 *
 * RARITY IS READ, NOT GUESSED. The Pets page marks rarity on each pet card:
 * pet-card-legendary / pet-card-epic / pet-card-mythical, plus a
 * .pet-rarity-flare badge ("Legendary", "Mythic II", "Mythic IV") on legendary
 * and mythic cards. Cards with none of those are rare or common. That is
 * exactly what readCardRarity() looks at now.
 *
 * EXEMPTIONS USE THE REAL NAMES. In-game the three exemptions are called
 * "Yuelun, the Moonveil Devourer" (Moon Panda), "Aerovarn, the Empyrean
 * Sky-King" (Griffin) and "Fenrir, the Frostfire Worldfang". Matching only
 * "moon panda" / "griffin" never hit them, so both names are listed.
 *
 * CFG.LINK_ALLOW_IDS: inv ids that are never blocked. The game says pets
 * originally below Legendary can be linked even after awakening, but a card
 * only shows its current rarity, so list any awakened pet here if it's wrongly
 * greyed out.
 *
 * APPLY SHOWS EVERY STEP IN THE NORMAL TOAST. While a preset applies, the
 * green toast shows a counter and the latest steps (⏳ running, ✔ done, ✖
 * failed). When it finishes the toast lists the whole run plus anything that
 * needs attention, and stays up longer when something went wrong. Click it to
 * dismiss. No separate box.
 *
 * A PET ON SEVERAL TEAMS IS TAKEN OFF ALL OF THEM. Before, only one other team
 * was remembered, so a pet equipped on two teams stayed equipped on the other
 * and the game refused to link it ("currently equipped"). If the game still
 * refuses with that message, the link now re-reads every team, takes the pet
 * off wherever it still is, and retries once.
 *
 * 2.2.0
 *
 * SIGIL RESTORE IS FORCED, so a preset can't land with an empty slot:
 *   1. every sigil the preset wants removed comes off first, across all three
 *      pets, before anything is equipped — that alone resolves a preset that
 *      just moves one sigil from one of its own pets to another;
 *   2. if a wanted sigil still has no free copy, the pet currently wearing it
 *      is found (by matching the sigil name on the pool cards, then confirming
 *      through pet_sigils_ajax.php) and it's taken off that pet;
 *   3. the slot's old sigil only comes off once the new one is confirmed
 *      available, so a failure leaves the pet as it was instead of bare.
 *   CFG.FORCE_SIGILS = false goes back to reporting the conflict and skipping.
 *
 * NATIVE CARDS:
 * - Link orbs are bigger (36px) and still sit just above the stars pill.
 * - The equipped/linked pills no longer sit in the card flow pushing it down;
 *   they're an overlay on the art, top-left, clear of the info button.
 * - "Equipped" only appears for the team you're currently viewing, so the PvE
 *   view doesn't tell you about PvP rosters. That also drops the two extra
 *   page fetches 2.1.0 needed.
 * - A linked pet's pill names its main, e.g. "🔗 Orryphos the Eternal Echo".
 *
 * EDITOR:
 * - Opens seeded from what each pet actually has right now — real link and
 *   sigil art, not placeholders.
 * - Two states, not three: a slot either holds something or is cleared with ✕.
 *   The "Leave as-is" / "Unlink" buttons are gone; ✕ already does that job.
 * - Links sit under the card as labelled tiles; the two chips on the art are
 *   the Attack and Defense sigils.
 * - The picker carries its own Cancel, since it opens over the editor.
 * ========================================================================= */

(function () {
  'use strict';

  /* =======================================================================
   * Config
   * ===================================================================== */

  const CFG = {
    ORB_SIZE: 52,
    SIGIL_CHIP_SIZE: 52,   // native team-card sigil chips (was fixed at 22px)
    ORBS_ON_TEAM_CARDS: true,
    ORBS_IN_INVENTORY: true,
    INVENTORY_BADGES: true,
    SHOW_EMPTY_ORBS: true,
    AUTO_RELINK: true,
    FORCE_SIGILS: true,
    // Rarities that can't be used as a link, unless the name matches an exemption.
    LINK_BLOCKED_RARITIES: ['legendary', 'mythic'],
    // Matched as lowercase substrings of the pet name. Old and ascended names.
    LINK_EXEMPT_NAMES: ['moon panda', 'yuelun', 'griffin', 'aerovarn', 'fenrir'],
    // Inv ids that are never blocked (e.g. pets awakened up from Epic).
    LINK_ALLOW_IDS: [],
    TAKE_FROM_OTHER_TEAMS: true,   // a preset may pull a pet off another team to use it
    FETCH_CONCURRENCY: 4,
  };

  const TEAM_KEYS = ['attack', 'pvp_attack', 'defense'];
  const TEAM_LABELS = { attack: 'PvE Attack', pvp_attack: 'PvP Attack', defense: 'PvP Defense' };
  const SLOT_IDS = ['1', '2', '3'];
  const LINK_LEVELS = ['1', '2'];
  const SIGIL_SLOTS = ['attack', 'defense'];
  const SIGIL_LABELS = { attack: 'Attack Sigil', defense: 'Defense Sigil' };

  let sigilCsrfToken = (typeof PET_SIGIL_CSRF !== 'undefined') ? PET_SIGIL_CSRF : '';
  const SIGIL_CSRF_EXPIRED_RE = /security token expired/i;

  function extractPetSigilCsrf(html) {
    const m = String(html || '').match(/const\s+PET_SIGIL_CSRF\s*=\s*"([^"]*)"/);
    return m ? m[1] : null;
  }

  let sigilCsrfRefreshInFlight = null;
  async function refreshSigilCsrf() {
    if (sigilCsrfRefreshInFlight) return sigilCsrfRefreshInFlight;
    sigilCsrfRefreshInFlight = (async () => {
      try {
        const res = await fetch('/pets.php', { credentials: 'include', cache: 'no-store' });
        const html = await res.text();
        const fresh = extractPetSigilCsrf(html);
        if (fresh) sigilCsrfToken = fresh;
        return fresh;
      } catch (_) { return null; }
    })();
    try { return await sigilCsrfRefreshInFlight; }
    finally { sigilCsrfRefreshInFlight = null; }
  }

  /* =======================================================================
   * Utilities
   * ===================================================================== */

  function isPetsPage() {
    return location.pathname.replace(/\/+$/, '') === '/pets.php';
  }
  function normalizeTeamKey(raw) {
    raw = String(raw || 'attack').toLowerCase();
    if (['defense', 'def', 'deff', 'pvp_defense', 'pvp_def'].includes(raw)) return 'defense';
    if (['pvp_attack', 'pvpattack', 'attack_pvp', 'pvp'].includes(raw)) return 'pvp_attack';
    return 'attack';
  }
  // The page declares `const CURRENT_TEAM` top-level in a classic script, so a
  // bare reference resolves to it; the URL is the fallback.
  function getUrlTeam() {
    try {
      if (typeof CURRENT_TEAM === 'string' && CURRENT_TEAM) return normalizeTeamKey(CURRENT_TEAM); // eslint-disable-line no-undef
    } catch (_) { /* not pets.php */ }
    return normalizeTeamKey(new URLSearchParams(location.search).get('team') || 'attack');
  }
  function esc(str) {
    return String(str ?? '')
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  }
  function starsLevelTag(p) {
    if (p.stars == null && p.level == null) return '';
    const bits = [];
    if (p.stars > 0) bits.push('★'.repeat(p.stars));
    if (p.level > 0) bits.push('Lv. ' + p.level);
    return bits.join(' · ');
  }
  function asset(url) {
    const v = String(url || '').trim();
    if (!v) return '';
    if (/^https?:\/\//i.test(v) || v.startsWith('/')) return v;
    return '/' + v;
  }
  function shorten(name, max = 22) {
    name = String(name || '');
    return name.length > max ? name.slice(0, max - 1).trimEnd() + '…' : name;
  }
  function debounce(fn, ms) {
    let t = null;
    return function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), ms); };
  }
  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        try { out[i] = await fn(items[i], i); } catch (_) { out[i] = null; }
      }
    }));
    return out;
  }
  function has(obj, key) { return !!obj && Object.prototype.hasOwnProperty.call(obj, key); }

  function notify(msg, ok = true) {
    if (typeof window.showNotification === 'function') {
      window.showNotification(msg, ok ? 'success' : 'error');
      return;
    }
    Core.ui.toast(msg, ok, 3200);
  }

  /* =======================================================================
   * Apply progress: steps shown in the regular toast
   * ===================================================================== */

  let stepRun = null;       // { title, log: [{label, state, err}], done, total }
  let runToastTimer = null;

  function runToastEl() {
    let el = document.getElementById('notification') || document.getElementById('pp-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'pp-toast';
      el.style.cssText = 'position:fixed;top:20px;right:20px;z-index:100060;padding:12px 20px;' +
        'border-radius:10px;color:#fff;font:600 15px Arial,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.4);';
      document.body.appendChild(el);
    }
    return el;
  }
  function hideRunToast() {
    clearTimeout(runToastTimer);
    const el = runToastEl();
    el.style.display = 'none';
    el.style.whiteSpace = '';
    el.style.maxWidth = '';
    el.style.cursor = '';
    el.onclick = null;
  }
  // holdMs 0 = stay until the next update.
  function showRunToast(msg, ok, holdMs) {
    const el = runToastEl();
    clearTimeout(runToastTimer);
    el.textContent = msg;
    el.style.background = ok ? '#2ecc71' : '#e74c3c';
    el.style.whiteSpace = 'pre-line';
    el.style.maxWidth = '460px';
    el.style.cursor = 'pointer';
    el.style.display = 'block';
    el.onclick = hideRunToast;
    if (holdMs) runToastTimer = setTimeout(hideRunToast, holdMs);
  }
  function stepLine(s) {
    return (s.state === 'ok' ? '✔ ' : s.state === 'fail' ? '✖ ' : '⏳ ') + s.label + (s.err ? ' — ' + s.err : '');
  }
  function renderRun() {
    if (!stepRun) return;
    const head = stepRun.title + (stepRun.total ? ` (${stepRun.done}/${stepRun.total})` : '');
    showRunToast([head].concat(stepRun.log.slice(-4).map(stepLine)).join('\n'), true, 0);
  }
  function finishRun(summary, ok, notes) {
    const log = stepRun ? stepRun.log : [];
    const failedErrs = log.filter((s) => s.state === 'fail' && s.err).map((s) => s.err);
    // Notes already shown as a failed step, or plain "X came off Y" results of
    // steps that are listed anyway, would just repeat themselves.
    const extra = (notes || []).filter((n) =>
      !failedErrs.some((e) => n.includes(e)) && !/\bcame off\b|^Took /.test(n));
    const lines = [summary];
    if (log.length && log.length <= 12) log.forEach((s) => lines.push(stepLine(s)));
    else if (log.length) {
      lines.push(`${log.filter((s) => s.state === 'ok').length}/${log.length} steps done`);
      log.filter((s) => s.state === 'fail').forEach((s) => lines.push(stepLine(s)));
    }
    extra.forEach((n) => lines.push('• ' + n));
    const trouble = !ok || extra.length || log.some((s) => s.state === 'fail');
    showRunToast(lines.join('\n'), ok, trouble ? 15000 : 6000);
  }

  // Runs fn as one visible step. With no run in progress it just runs fn.
  async function step(label, fn) {
    if (!stepRun) return fn();
    const s = { label: String(label), state: 'run' };
    stepRun.log.push(s);
    renderRun();
    try { const r = await fn(); s.state = 'ok'; renderRun(); return r; }
    catch (err) { s.state = 'fail'; s.err = (err && err.message) || 'failed'; renderRun(); throw err; }
  }

  // Takes a pet off every team it's still on (re-reads the pages first).
  async function unequipEverywhere(invId, name) {
    let n = 0;
    for (const t of TEAM_KEYS) {
      let doc;
      try { doc = await getContextDoc(t, true); } catch (_) { continue; }
      const eq = scanEquippedPetSlots(doc, t);
      for (const s of SLOT_IDS) {
        if (eq[s] && String(eq[s].invId) === String(invId)) {
          await step(`Take ${name} off ${TEAM_LABELS[t]}`, () => unequipPetFromTeam(s, t));
          n++;
        }
      }
    }
    if (n) dropDocCache();
    return n;
  }

  /* =======================================================================
   * Storage
   * ===================================================================== */

  function getPlayerId() {
    const link = document.querySelector('.side-drawer a[href*="player.php?pid="]');
    const m = link && /pid=(\d+)/.exec(link.getAttribute('href') || '');
    return m ? m[1] : 'default';
  }
  const STORAGE_KEY = 'petPresets_' + getPlayerId();

  function loadPresets() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
    catch (_) { return []; }
  }
  function savePresets(list) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch (_) { /* quota */ }
  }
  function makePresetId() {
    return 'pt_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function blankMeta() { return { pets: {}, sigils: {} }; }

  /* =======================================================================
   * Network
   * ===================================================================== */

  async function postPetAjax(body) {
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
  function equipPetToTeam(invId, slotId, teamKey) {
    const b = new URLSearchParams();
    b.set('action', 'equip_pet');
    b.set('team', teamKey);
    b.set('pet_inv_id', invId);
    b.set('slot_id', slotId);
    return postPetAjax(b);
  }
  function unequipPetFromTeam(slotId, teamKey) {
    const b = new URLSearchParams();
    b.set('action', 'unequip_pet');
    b.set('team', teamKey);
    b.set('slot_id', slotId);
    return postPetAjax(b);
  }

  // ---- links ----

  const linkCache = {};

  async function fetchLinkInfo(invId, force = false) {
    invId = String(invId);
    if (!force && linkCache[invId]) return linkCache[invId];
    const p = (async () => {
      const res = await fetch('/pet_links_ajax.php?pet_inv_id=' + encodeURIComponent(invId),
                              { cache: 'no-store', credentials: 'include' });
      const data = await res.json().catch(() => null);
      if (!data || data.status !== 'success') {
        throw new Error((data && data.message) || 'Failed to load links.');
      }
      const links = { '1': null, '2': null };
      (data.links || []).forEach((l) => {
        const lvl = String(l.link_level);
        if (!has(links, lvl)) return;
        // This endpoint doesn't send link_pet_id on links[] entries — it uses
        // the same inv_id shape as `candidates`. Fall back through every
        // shape we've seen so holderOf (badges + "already linked" picker
        // detection) is keyed by a real pet id instead of "undefined".
        const subId = l.inv_id ?? l.link_pet_id ?? l.pet_inv_id ?? l.id;
        links[lvl] = {
          invId: String(subId),
          name: l.name || ('Pet #' + subId),
          image: asset(l.img || l.image || ''),
        };
      });
      return {
        invId,
        petName: (data.pet && data.pet.name) || ('Pet #' + invId),
        links,
        unlocked: { '1': !!(data.unlocks && data.unlocks.link1), '2': !!(data.unlocks && data.unlocks.link2) },
        candidates: (data.candidates || []).map((c) => ({
          invId: String(c.inv_id),
          name: c.name || ('Pet #' + c.inv_id),
          image: asset(c.img || c.image || ''),
          rarity: rarityFromText(c.rarity ?? c.rarity_name ?? c.rarity_label ?? c.tier),
        })),
        csrf: data.csrf || '',
      };
    })();
    linkCache[invId] = p;
    try { return await p; }
    catch (err) { delete linkCache[invId]; throw err; }
  }
  function dropLinkCache(invId) {
    if (invId) delete linkCache[String(invId)];
    else Object.keys(linkCache).forEach((k) => delete linkCache[k]);
  }

  function postLinkAction(mainInvId, action, opts) {
    const body = new URLSearchParams();
    body.set('action', action);
    body.set('csrf', opts.csrf || '');
    body.set('pet_inv_id', String(mainInvId));
    body.set('link_level', String(opts.level));
    if (action === 'set') body.set('link_pet_id', String(opts.linkPetId));
    return fetch('/pet_link_action.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      credentials: 'include',
    })
      .then((r) => r.json().catch(() => null))
      .then((d) => {
      if (!d || String(d.status).trim() !== 'success') {
        throw new Error((d && d.message) || 'Link action failed.');
      }
      return d;
    });
  }

  // ---- sigils ----

  const sigilCache = {};

  async function fetchSigilInfo(invId, slotType, force = false) {
    const key = invId + '|' + slotType;
    if (!force && sigilCache[key]) return sigilCache[key];
    const p = (async () => {
      const url = '/pet_sigils_ajax.php?pet_inv_id=' + encodeURIComponent(invId) +
            '&slot_type=' + encodeURIComponent(slotType);
      const res = await fetch(url, { cache: 'no-store', credentials: 'include' });
      const data = await res.json().catch(() => null);
      if (!data || data.status !== 'success') {
        throw new Error((data && data.message) || 'Failed to load sigils.');
      }
      const mk = (o) => ({
        itemId: String(o.item_id),
        name: o.name || ('Sigil #' + o.item_id),
        image: asset(o.image_url),
        attack: Number(o.attack || 0),
        defense: Number(o.defense || 0),
        owned: Number(o.owned || 0),
        equipped: Number(o.equipped || 0),
        available: Number(o.available || 0),
      });
      return {
        slotLabel: data.slot_label || SIGIL_LABELS[slotType] || slotType,
        current: data.current ? mk(data.current) : null,
        options: (data.options || []).map(mk),
        csrf: data.csrf || '',   // <-- new
      };
    })();
    sigilCache[key] = p;
    try { return await p; }
    catch (err) { delete sigilCache[key]; throw err; }
  }
  function dropSigilCache(invId) {
    Object.keys(sigilCache).forEach((k) => {
      if (!invId || k.startsWith(String(invId) + '|')) delete sigilCache[k];
    });
  }

  async function postSigilAction(invId, slotType, itemId, _retried = false) {
    const params = new URLSearchParams();
    params.set('action', itemId ? 'equip' : 'remove');
    params.set('pet_inv_id', String(invId));
    params.set('slot_type', slotType);
    if (itemId) params.set('item_id', String(itemId));
    params.set('csrf_token', sigilCsrfToken || '');

    const res = await fetch('/pet_sigil_action.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: params.toString(),
      credentials: 'include',
    });
    const data = await res.json().catch(() => null);

    if (!data || data.status !== 'success') {
      const message = (data && data.message) || 'Sigil update failed.';
      if (!_retried && SIGIL_CSRF_EXPIRED_RE.test(message)) {
        const fresh = await refreshSigilCsrf();
        if (fresh) return postSigilAction(invId, slotType, itemId, true);
      }
      throw new Error(message);
    }
    return data;
  }

  async function fetchMelanippeStableState() {
    const res = await fetch('olympus_melanippe_stable_buy.php?action=state', {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Accept': 'application/json' },
    });

    const data = await res.json().catch(() => null);

    if (!data || data.status !== 'success') {
      throw new Error(
        data?.message || "Could not reach Melanippe's stable."
      );
    }

    return data;
  }

  async function buySigilFromMelanippe(itemId, itemName, btn, invId, slotType) {
    const originalText = btn.textContent;

    btn.disabled = true;
    btn.textContent = 'Checking…';

    try {
      const normalize = (s) => String(s || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');

      const makeOfferKey = (name) => String(name || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');

      const wantedName = normalize(itemName);
      const wantedKey = makeOfferKey(itemName);

      /*
     * Always read the LIVE Melanippe state.
     * Do not rely on the picker card or cached DOM.
     */
      const state = await fetchMelanippeStableState();

      const offers = Array.isArray(state.offers)
      ? state.offers
      : [];

      /*
     * Native Melanippe uses offer.key such as:
     *   fire_sigil
     *   water_sigil
     *
     * Match by display name first, then by the real offer key.
     */
      let offer = offers.find((o) =>
                              normalize(o.name) === wantedName
                             );

      if (!offer) {
        offer = offers.find((o) =>
                            String(o.key || '').trim().toLowerCase() === wantedKey
                           );
      }

      if (!offer || !offer.key) {
        window.alert(
          `Melanippe does not currently sell ${itemName}.`
        );

        btn.disabled = false;
        btn.textContent = originalText;
        return;
      }

      const price = Number(offer.price || 0);
      const gold = Number(state.gold || 0);
      const afterPurchase = gold - price;

      /*
     * Always show the confirmation popup first when the offer exists.
     */
      const confirmed = window.confirm(
        `Buy ${itemName} from Melanippe?\n\n` +
        `Your Gold: ${gold.toLocaleString()}\n` +
        `Cost: ${price.toLocaleString()} Gold\n` +
        `After Purchase: ${afterPurchase.toLocaleString()} Gold`
      );

      if (!confirmed) {
        btn.disabled = false;
        btn.textContent = originalText;
        return;
      }

      /*
     * Never allow a purchase that would make Gold negative.
     */
      if (afterPurchase < 0) {
        window.alert(
          `Invalid purchase.\n\n` +
          `Your Gold: ${gold.toLocaleString()}\n` +
          `Cost: ${price.toLocaleString()} Gold\n` +
          `After Purchase: ${afterPurchase.toLocaleString()} Gold\n\n` +
          `You do not have enough Gold.`
        );

        btn.disabled = false;
        btn.textContent = originalText;
        return;
      }

      btn.textContent = 'Buying…';

      const params = new URLSearchParams({
        offer: String(offer.key),
        qty: '1',
      });

      const res = await fetch('olympus_melanippe_stable_buy.php', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
        },
        body: params.toString(),
        credentials: 'same-origin',
      });

      const data = await res.json().catch(() => null);

      if (!data || data.status !== 'success') {
        throw new Error(
          data?.message || 'Purchase failed.'
        );
      }

      /*
     * The native shop returns its updated state after purchase.
     */
      const newGold = Number(
        data.gold != null ? data.gold : afterPurchase
      );

      window.alert(
        `${itemName} purchased!\n\n` +
        `Gold before: ${gold.toLocaleString()}\n` +
        `Cost: ${price.toLocaleString()} Gold\n` +
        `Gold after: ${newGold.toLocaleString()}`
      );

      btn.textContent = 'Purchased!';

      dropSigilCache(String(invId));

      await openSigilChooser(invId, slotType);

    } catch (err) {
      btn.disabled = false;
      btn.textContent = originalText;

      window.alert(
        err?.message || 'Purchase failed.'
      );
    }
  }

  function sigilBonus(item) {
    if (!item) return '';
    if (item.attack > 0) return '+' + item.attack.toLocaleString() + ' ATK';
    if (item.defense > 0) return '+' + item.defense.toLocaleString() + ' DEF';
    return 'Utility';
  }

  /* =======================================================================
   * Page scanning
   * ===================================================================== */

  function findSectionByTitle(doc, titleText) {
    for (const sec of doc.querySelectorAll('.section')) {
      const t = sec.querySelector('.section-title');
      if (t && t.textContent.trim() === titleText) return sec;
    }
    return null;
  }

  // Rarity as the Pets page marks it: a pet card carries one of
  // pet-card-legendary / pet-card-epic / pet-card-mythical, and legendary and
  // mythic cards also have a .pet-rarity-flare badge ("Legendary", "Mythic IV").
  // A card with none of those is rare or common. rarityFromText() is only for
  // rarity that arrives as plain data (candidate lists), where it's optional.
  const RARITY_PATTERNS = [
    ['mythic', /(^|[^a-z])mythic(al)?([^a-z]|$)/],
    ['legendary', /(^|[^a-z])legendary([^a-z]|$)/],
    ['epic', /(^|[^a-z])epic([^a-z]|$)/],
    ['rare', /(^|[^a-z])rare([^a-z]|$)/],
    ['uncommon', /(^|[^a-z])uncommon([^a-z]|$)/],
    ['common', /(^|[^a-z])common([^a-z]|$)/],
  ];
  function rarityFromText(s) {
    const t = String(s == null ? '' : s).toLowerCase();
    if (!t) return null;
    for (const [name, re] of RARITY_PATTERNS) if (re.test(t)) return name;
    return null;
  }
  function readCardRarity(card) {
    if (!card) return null;
    const cls = card.classList;
    const flare = ((card.querySelector('.pet-rarity-flare') || {}).textContent || '').trim().toLowerCase();
    if (cls.contains('pet-card-mythical') || flare.startsWith('mythic')) return 'mythic';
    if (cls.contains('pet-card-legendary') || flare === 'legendary') return 'legendary';
    if (cls.contains('pet-card-epic')) return 'epic';
    return 'lower'; // plain card: rare or common
  }

  function linkRarityBlock(pet, rarity) {
    if (!rarity || !CFG.LINK_BLOCKED_RARITIES.includes(rarity)) return null;
    if (pet && CFG.LINK_ALLOW_IDS.map(String).includes(String(pet.invId))) return null;
    const nm = String((pet && pet.name) || '').toLowerCase();
    if (CFG.LINK_EXEMPT_NAMES.some((x) => nm.includes(String(x).toLowerCase()))) return null;
    return rarity;
  }

  function scanEquippedPetSlots(doc, teamKey) {
    const section = findSectionByTitle(doc, TEAM_LABELS[teamKey] + ' Team');
    const slots = { '1': null, '2': null, '3': null };
    if (!section) return slots;
    section.querySelectorAll('.pet-card[data-pet-inv-id]').forEach((card) => {
      const btn = Array.from(card.querySelectorAll('button')).find((b) =>
                                                                   /unequipPet\s*\(\s*\d+\s*\)/.test(b.getAttribute('onclick') || ''));
      if (!btn) return;
      const m = /unequipPet\s*\(\s*(\d+)\s*\)/.exec(btn.getAttribute('onclick') || '');
      if (!m || !has(slots, m[1])) return;
      const invId = card.getAttribute('data-pet-inv-id');
      const img = card.querySelector('.pet-img-wrap img');
      const starsEl = card.querySelector('.pet-stars-overlay');
      const levelEl = card.querySelector('.pet-level');
      slots[m[1]] = {
        invId,
        name: img ? img.alt.trim() : ('Pet #' + invId),
        image: img ? img.getAttribute('src') : '',
        stars: starsEl ? (starsEl.textContent.match(/★/g) || []).length : 0,
        level: levelEl ? (parseInt(levelEl.textContent, 10) || 0) : 0,
        rarity: readCardRarity(card),
        sigils: readCardSigilNames(card),
      };
    });
    return slots;
  }

  function scanPetPool(doc) {
    const section = findSectionByTitle(doc, '🐾 Pet Inventory');
    const pool = {};
    if (!section) return pool;
    section.querySelectorAll('.pet-card[data-pet-inv-id]').forEach((card) => {
      const invId = card.getAttribute('data-pet-inv-id');
      const img = card.querySelector('.pet-img-wrap img');
      const starsEl = card.querySelector('.pet-stars-overlay');
      const levelEl = card.querySelector('.pet-level');
      pool[invId] = {
        invId,
        name: img ? img.alt.trim() : ('Pet #' + invId),
        image: img ? img.getAttribute('src') : '',
        stars: starsEl ? (starsEl.textContent.match(/★/g) || []).length : 0,
        level: levelEl ? (parseInt(levelEl.textContent, 10) || 0) : 0,
        rarity: readCardRarity(card),
      };
    });
    return pool;
  }

  // Every pool card renders its sigils, so who is wearing what can be read off
  // the page by name before spending a request to confirm it.
  function scanSigilWearers(doc) {
    const section = findSectionByTitle(doc, '🐾 Pet Inventory');
    const wearers = [];
    if (!section) return wearers;
    section.querySelectorAll('.pet-card[data-pet-inv-id]').forEach((card) => {
      const invId = card.getAttribute('data-pet-inv-id');
      card.querySelectorAll('.pet-sigil-slot.filled').forEach((slot) => {
        const slotType = slot.classList.contains('attack') ? 'attack'
        : (slot.classList.contains('defense') ? 'defense' : null);
        const nameEl = slot.querySelector('.pet-sigil-copy b');
        if (!slotType || !nameEl) return;
        wearers.push({ invId, slotType, name: nameEl.textContent.trim() });
      });
    });
    return wearers;
  }

  function readCardSigilNames(card) {
    const sig = { attack: null, defense: null };
    card.querySelectorAll('.pet-sigil-slot.filled').forEach((slot) => {
      const slotType = slot.classList.contains('attack') ? 'attack'
      : (slot.classList.contains('defense') ? 'defense' : null);
      const nameEl = slot.querySelector('.pet-sigil-copy b');
      if (slotType && nameEl) sig[slotType] = nameEl.textContent.trim();
    });
    return sig;
  }

  const docCache = {};
  async function getContextDoc(teamKey, force = false) {
    if (!force && isPetsPage() && getUrlTeam() === teamKey) return document;
    if (!force && docCache[teamKey]) return docCache[teamKey];
    const html = await Core.net.fetchText('/pets.php?team=' + encodeURIComponent(teamKey), force ? { force: true } : {});
    const doc = new DOMParser().parseFromString(html, 'text/html');
    docCache[teamKey] = doc;
    return doc;
  }
  function dropDocCache(teamKey) {
    if (teamKey) delete docCache[teamKey];
    else Object.keys(docCache).forEach((k) => delete docCache[k]);
  }

  function slotsEqual(a, b) {
    return SLOT_IDS.every((s) => (a[s] ? a[s].invId : null) === (b[s] ? b[s].invId : null));
  }

  function presetSigilsMatch(preset, liveSlots) {
    return SLOT_IDS.every((s) => {
      const wantPet = preset.slots[s];
      if (!wantPet) return true;
      const wantSig = preset.sigils && preset.sigils[wantPet.invId];
      if (!wantSig) return true; // preset never recorded sigils for this pet — nothing to check
      const liveSig = (liveSlots[s] && liveSlots[s].sigils) || { attack: null, defense: null };
      return SIGIL_SLOTS.every((slotType) => {
        if (!has(wantSig, slotType)) return true;
        const wantId = wantSig[slotType];
        const wantName = wantId ? (preset.meta?.sigils?.[wantId]?.name || null) : null;
        return (wantName || null) === (liveSig[slotType] || null);
      });
    });
  }

  /* =======================================================================
   * Link index — who is linked under whom
   * ===================================================================== */

  let linkIndexPromise = null;

  async function buildLinkIndex(force = false) {
    if (linkIndexPromise && !force) return linkIndexPromise;
    linkIndexPromise = (async () => {
      const doc = await getContextDoc(isPetsPage() ? getUrlTeam() : 'attack', force);
      const pool = scanPetPool(doc);

      // Pets in a team slot aren't in the inventory section but can still be
      // holding links, so include them for holder lookup.
      const all = Object.assign({}, pool);
      await mapLimit(TEAM_KEYS, 3, async (t) => {
        const tdoc = await getContextDoc(t, force);
        Object.values(scanPetPool(tdoc)).forEach((p) => { if (!all[p.invId]) all[p.invId] = p; });
        const slots = scanEquippedPetSlots(tdoc, t);
        SLOT_IDS.forEach((s) => { if (slots[s] && !all[slots[s].invId]) all[slots[s].invId] = slots[s]; });
      });

      const ids = Object.keys(all);
      const infos = await mapLimit(ids, CFG.FETCH_CONCURRENCY, (id) => fetchLinkInfo(id, force));
      const byMain = {};
      const holderOf = {};
      const meta = {};
      infos.forEach((info, i) => {
        const id = ids[i];
        meta[id] = all[id];
        if (!info) return;
        byMain[id] = info.links;
        LINK_LEVELS.forEach((lvl) => {
          const sub = info.links[lvl];
          if (!sub || !sub.invId || sub.invId === 'undefined') return;
          holderOf[sub.invId] = { mainId: id, mainName: all[id] ? all[id].name : info.petName, level: lvl };
          if (!meta[sub.invId]) meta[sub.invId] = { invId: sub.invId, name: sub.name, image: sub.image };
        });
      });
      return { byMain, holderOf, meta, pool };
    })();
    try { return await linkIndexPromise; }
    catch (err) { linkIndexPromise = null; throw err; }
  }
  function dropLinkIndex() { linkIndexPromise = null; }

  /* =======================================================================
   * MODULE 1 — sigil equip/remove without a reload (pets.php)
   * ===================================================================== */

  let sigilBusy = false;

  async function refreshPetCardsInPlace(petInvId) {
    try {
      const res = await fetch(location.href, { cache: 'no-store', credentials: 'include' });
      if (!res.ok) return false;
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      const sel = '.pet-card[data-pet-inv-id="' + CSS.escape(String(petInvId)) + '"]';
      const fresh = Array.from(doc.querySelectorAll(sel));
      const live = Array.from(document.querySelectorAll(sel));
      // A sigil change never adds or removes a card; if the counts moved,
      // something else changed underneath us and a reload is safer.
      if (!fresh.length || fresh.length !== live.length) return false;
      live.forEach((card, i) => card.replaceWith(fresh[i].cloneNode(true)));
      if (typeof window.renderElementBadgeIntoCards === 'function') window.renderElementBadgeIntoCards();
      dropSigilCache(String(petInvId));
      scheduleAugment();
      return true;
    } catch (_) {
      return false;
    }
  }

  function installSigilOverride() {
    window.petSigilAction = async function (action, itemId = 0, _retried = false) {
      let invId, slotType;
      try { invId = _petSigilPetInvId; slotType = _petSigilSlotType; }
      catch (_) { return; }
      if (!invId || !slotType || sigilBusy) return;
      sigilBusy = true;

      setPetSigilStatus(action === 'remove' ? 'Removing sigil...' : 'Equipping sigil...');
      try {
        const params = new URLSearchParams();
        params.set('action', action);
        params.set('pet_inv_id', String(invId));
        params.set('slot_type', slotType);
        if (itemId) params.set('item_id', String(itemId));
        params.set('csrf_token', sigilCsrfToken || '');

        const res = await fetch('pet_sigil_action.php', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
          body: params.toString(),
        });
        const data = await res.json().catch(() => null);
        const message = (data && data.message) || 'Sigil update failed.';

        if (!data || data.status !== 'success') {
          if (!_retried && SIGIL_CSRF_EXPIRED_RE.test(message)) {
            const fresh = await refreshSigilCsrf();
            sigilBusy = false;
            if (fresh) return window.petSigilAction(action, itemId, true);
          }
          setPetSigilStatus(message, 'err');
          return;
        }
        setPetSigilStatus(data.message || 'Sigil updated.', 'ok');

        if (!(await refreshPetCardsInPlace(invId))) { setTimeout(() => location.reload(), 300); return; }
        await openPetSigilModal(invId, slotType);
      } catch (_) {
        setPetSigilStatus('Server error.', 'err');
      } finally {
        sigilBusy = false;
      }
    };
  }
  /* =======================================================================
   * MODULE 2 — native card augmentation (pets.php)
   * ===================================================================== */

  function orbEl(sub, unlocked) {
    const orb = document.createElement('div');
    orb.className = 'pp-orb' + (sub ? '' : ' pp-orb-empty') + (unlocked ? '' : ' pp-orb-locked');
    if (sub && sub.image) {
      const img = document.createElement('img');
      img.src = sub.image;
      img.alt = sub.name;
      orb.appendChild(img);
    } else {
      orb.textContent = unlocked ? (sub ? '🐾' : '') : '🔒';
    }
    orb.title = !unlocked ? 'Link slot locked' : (sub ? 'Linked: ' + sub.name : 'No link');
    return orb;
  }

  // Stars are a .pet-stars-overlay pill pinned to the bottom of .pet-img-wrap,
  // so the orbs go in the same wrapper, just above it.
  function ensureOrbs(card, info) {
    const wrap = card.querySelector('.pet-img-wrap');
    if (!wrap) return;
    const fp = LINK_LEVELS
    .map((l) => (info.unlocked[l] ? (info.links[l] ? info.links[l].invId : '-') : 'x'))
    .join(',');
    if (card.dataset.ppOrbs === fp) return;
    card.dataset.ppOrbs = fp;

    let row = wrap.querySelector(':scope > .pp-orb-row');
    if (!row) {
      row = document.createElement('div');
      row.className = 'pp-orb-row';
      if (wrap.querySelector('.pet-stars-overlay')) row.classList.add('pp-orb-row-above-stars');
      wrap.appendChild(row);
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        const invId = card.getAttribute('data-pet-inv-id');
        if (typeof window.openLinksModal === 'function') window.openLinksModal(Number(invId));
      });
    }

    row.innerHTML = '';
    let drew = 0;
    LINK_LEVELS.forEach((level) => {
      const unlocked = !!info.unlocked[level];
      const sub = info.links[level];
      if (!sub && !CFG.SHOW_EMPTY_ORBS) return;
      row.appendChild(orbEl(sub, unlocked));
      drew++;
    });
    row.style.display = drew ? '' : 'none';
  }

  // Overlaid on the art rather than inserted into the card flow, so nothing
  // below moves. Only reports the team currently on screen.
  function ensureBadges(card, invId, equippedHere, index) {
    const wrap = card.querySelector('.pet-img-wrap');
    if (!wrap) return;
    const holder = index && index.holderOf[invId];
    const fp = (equippedHere ? 'eq' : '-') + '#' + (holder ? holder.mainId + ':' + holder.level : '-');
    if (card.dataset.ppBadges === fp) return;
    card.dataset.ppBadges = fp;

    let bar = wrap.querySelector(':scope > .pp-badge-overlay');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'pp-badge-overlay';
      wrap.appendChild(bar);
    }
    bar.innerHTML = '';
    if (equippedHere) {
      const pill = document.createElement('span');
      pill.className = 'pp-pill pp-pill-equipped';
      pill.textContent = 'Equipped';
      pill.title = 'On your ' + TEAM_LABELS[getUrlTeam()] + ' team';
      bar.appendChild(pill);
    }
    if (holder) {
      const pill = document.createElement('span');
      pill.className = 'pp-pill pp-pill-linked';
      pill.textContent = 'Linked to ' + shorten(holder.mainName, 16);
      pill.title = 'Linked as Link ' + holder.level + ' of ' + holder.mainName;
      bar.appendChild(pill);
    }
    bar.style.display = bar.children.length ? '' : 'none';
  }

  let augmenting = false;

  async function augmentNativeCards() {
    if (!isPetsPage() || augmenting) return;
    augmenting = true;
    try {
      const team = getUrlTeam();
      const teamSection = findSectionByTitle(document, TEAM_LABELS[team] + ' Team');

      if (CFG.ORBS_ON_TEAM_CARDS && teamSection) {
        const cards = Array.from(teamSection.querySelectorAll('.pet-card[data-pet-inv-id]'));
        await mapLimit(cards, CFG.FETCH_CONCURRENCY, async (card) => {
          const invId = card.getAttribute('data-pet-inv-id');
          const info = await fetchLinkInfo(invId);
          if (card.isConnected) ensureOrbs(card, info);
        });
      }

      if (CFG.INVENTORY_BADGES || CFG.ORBS_IN_INVENTORY) {
        const pool = findSectionByTitle(document, '🐾 Pet Inventory');
        if (pool) {
          const equipped = new Set(
            Array.from(teamSection ? teamSection.querySelectorAll('.pet-card[data-pet-inv-id]') : [])
            .map((c) => c.getAttribute('data-pet-inv-id')));
          const index = await buildLinkIndex().catch(() => null);
          const poolCards = Array.from(pool.querySelectorAll('.pet-card[data-pet-inv-id]'));
          await mapLimit(poolCards, CFG.FETCH_CONCURRENCY, async (card) => {
            const invId = card.getAttribute('data-pet-inv-id');
            if (CFG.INVENTORY_BADGES) ensureBadges(card, invId, equipped.has(invId), index);
            if (CFG.ORBS_IN_INVENTORY && index && index.byMain[invId]) {
              ensureOrbs(card, { links: index.byMain[invId], unlocked: { '1': true, '2': true } });
            }
          });
        }
      }
    } catch (err) {
      console.warn('[pet presets] augment failed:', err);
    } finally {
      augmenting = false;
    }
  }

  const scheduleAugment = debounce(() => { augmentNativeCards(); }, 350);

  function watchInventoryVisibility() {
    const pool = findSectionByTitle(document, '🐾 Pet Inventory');
    if (!pool || !('IntersectionObserver' in window)) { scheduleAugment(); return; }
    // The link index costs one request per owned pet; don't pay for it until
    // the inventory is actually on screen.
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { io.disconnect(); scheduleAugment(); }
    }, { rootMargin: '250px' });
    io.observe(pool);
  }

  function injectNativeStyles() {
    const s = CFG.ORB_SIZE;
    const sc = CFG.SIGIL_CHIP_SIZE;
    const style = document.createElement('style');
    style.textContent = `
      .pp-orb-row{ position:absolute; left:50%; transform:translateX(-50%); bottom:5px;
        display:flex; gap:9px; align-items:center; cursor:pointer; z-index:3; }
      .pp-orb-row-above-stars{ bottom:34px; }
      .pp-orb{ width:${s}px; height:${s}px; border-radius:50%; overflow:hidden; background:rgba(13,19,34,.9);
        border:2px solid rgba(255,255,255,.3); box-shadow:0 3px 10px rgba(0,0,0,.6);
        display:flex; align-items:center; justify-content:center; font-size:15px; color:#7d87ab; flex:0 0 auto; }
      .pp-orb img{ width:100%; height:100%; object-fit:cover; display:block; }
      .pp-orb-empty{ border-style:dashed; opacity:.45; }
      .pp-orb-locked{ background:rgba(28,19,19,.9); color:#8a6a4a; opacity:.75; }

      .pp-badge-overlay{ position:absolute; top:6px; left:6px; right:34px; display:flex; flex-direction:column;
        align-items:flex-start; gap:3px; z-index:3; pointer-events:none; }
      .pp-pill{ font:800 9px/1.8 Arial,sans-serif; border-radius:999px; padding:0 7px; max-width:100%;
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis; backdrop-filter:blur(2px); }
      .pp-pill-equipped{ color:#8ee6a8; background:rgba(9,40,24,.8); border:1px solid rgba(46,204,113,.5);
        letter-spacing:.04em; text-transform:uppercase; }
      .pp-pill-linked{ color:#c9bcff; background:rgba(22,15,48,.82); border:1px solid rgba(137,116,255,.5); }

    `;
    document.head.appendChild(style);
  }

  /* =======================================================================
   * MODULE 3 — presets
   * ===================================================================== */

  let presetBusy = false;
  let activeApplyPreset = null;
  let menuMountedFor = null;

  // ---------- capture ----------

  async function captureCurrentToPreset(teamKey) {
    let doc;
    try { doc = await getContextDoc(teamKey, true); }
    catch (_) { notify('Could not reach the Pets page to read that team.', false); return; }

    const slots = scanEquippedPetSlots(doc, teamKey);
    if (!SLOT_IDS.some((s) => slots[s])) {
      notify(`Nothing is equipped on ${TEAM_LABELS[teamKey]} — nothing to capture.`, false);
      return;
    }
    const name = prompt('Name this pet preset:', `Preset ${loadPresets().length + 1}`);
    if (name == null) return;

    const preset = {
      id: makePresetId(),
      version: 3,
      name: name.trim() || 'Untitled preset',
      slots,
      links: {},
      sigils: {},
      meta: blankMeta(),
      sourceTeam: teamKey,
      updatedAt: Date.now(),
    };

    for (const s of SLOT_IDS) {
      const pet = slots[s];
      if (!pet) continue;
      preset.meta.pets[pet.invId] = pet;

      try {
        const info = await fetchLinkInfo(pet.invId, true);
        const entry = {};
        LINK_LEVELS.forEach((lvl) => {
          if (!info.unlocked[lvl]) return;           // locked: nothing to record
          const sub = info.links[lvl];
          entry[lvl] = sub ? sub.invId : null;
          if (sub) preset.meta.pets[sub.invId] = sub;
        });
        if (Object.keys(entry).length) preset.links[pet.invId] = entry;
      } catch (_) { /* leave this pet's links alone on restore */ }


      const captureSigils = async (petInfo) => {
        const sig = {};
        for (const slotType of SIGIL_SLOTS) {
          try {
            const info = await fetchSigilInfo(petInfo.invId, slotType, true);
            sig[slotType] = info.current ? info.current.itemId : null;
            if (info.current) preset.meta.sigils[info.current.itemId] = info.current;
          } catch (_) { /* skip */ }
        }
        if (Object.keys(sig).length) preset.sigils[petInfo.invId] = sig;
      };

      await captureSigils(pet);

      const linkedIds = Object.values(preset.links[pet.invId] || {}).filter(Boolean);
      for (const linkedId of linkedIds) {
        const linkedPet = preset.meta.pets[linkedId];
        if (linkedPet) await captureSigils(linkedPet);
      }
    }

    const list = loadPresets();
    list.push(preset);
    savePresets(list);
    renderPresetList();
    notify(`Saved "${preset.name}" from ${TEAM_LABELS[teamKey]}.`, true);
  }

  // ---------- restore ----------

  async function smartRefreshTeamSections(teamKey) {
    try {
      const res = await fetch(location.href, { cache: 'no-store', credentials: 'include' });
      if (!res.ok) { location.reload(); return; }
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      const fresh = findSectionByTitle(doc, TEAM_LABELS[teamKey] + ' Team');
      const live = findSectionByTitle(document, TEAM_LABELS[teamKey] + ' Team');
      if (!fresh || !live) { location.reload(); return; }
      live.replaceWith(fresh.cloneNode(true));
      if (typeof window.renderElementBadgeIntoCards === 'function') window.renderElementBadgeIntoCards();
      scheduleAugment();
    } catch (_) {
      location.reload();
    }
  }

  async function applyLinksForPet(mainInvId, mainName, wanted, notes, stats, phase) {
    let info;
    try { info = await fetchLinkInfo(mainInvId, true); }
    catch (_) { if (phase !== 'unlink') notes.push(`${mainName}: couldn't read links`); return; }

    const toUnlink = [];
    const toLink = [];
    LINK_LEVELS.forEach((level) => {
      if (!has(wanted, level)) return;
      const cur = info.links[level] ? info.links[level].invId : null;
      const want = wanted[level];
      if (cur === want) return;
      if (!info.unlocked[level]) {
        if (want && phase !== 'unlink') notes.push(`${mainName} Link ${level} is locked`);
        return;
      }
      if (cur) toUnlink.push(level);
      if (want) toLink.push({ level, subId: want });
    });
    if (!toUnlink.length && !toLink.length) return;

    for (const level of toUnlink) {
      try {
        await step(`Unlink ${mainName} · Link ${level}`, () => postLinkAction(mainInvId, 'remove', { level, csrf: info.csrf }));
        stats.changed++;
      }
      catch (err) { notes.push(`${mainName} Link ${level}: ${err.message || 'unlink failed'}`); }
    }

    if (phase === 'unlink' || !toLink.length) { dropLinkCache(mainInvId); dropLinkIndex(); return; }

    let fresh = info;
    if (toUnlink.length) {
      try { fresh = await fetchLinkInfo(mainInvId, true); } catch (_) { fresh = info; }
    }

    // Who holds each wanted pet right now. Checked every time, not only when
    // the pet is missing from candidates: the game can list a pet as a
    // candidate while it's still linked elsewhere, then refuse the set.
    let index = null;
    try { index = await buildLinkIndex(true); } catch (_) { /* no index */ }

    for (const { level, subId } of toLink) {
      const holder = index && index.holderOf[subId];
      const heldElsewhere = holder &&
        !(String(holder.mainId) === String(mainInvId) && String(holder.level) === String(level));

      if (heldElsewhere) {
        if (!CFG.AUTO_RELINK) {
          notes.push(`Skipped ${mainName} Link ${level} — that pet is under ${holder.mainName}`);
          continue;
        }
        try {
          const hInfo = await fetchLinkInfo(holder.mainId, true);
          await step(`Take that link off ${holder.mainName}`,
                     () => postLinkAction(holder.mainId, 'remove', { level: holder.level, csrf: hInfo.csrf }));
          notes.push(`Took that link off ${holder.mainName}`);
          delete index.holderOf[subId];
          dropLinkCache(holder.mainId);
          dropLinkIndex();
          fresh = await fetchLinkInfo(mainInvId, true);
        } catch (err) {
          notes.push(`Couldn't free that pet from ${holder.mainName}: ${err.message || 'failed'}`);
          continue;
        }
      } else if (!fresh.candidates.some((c) => c.invId === subId)) {
        notes.push(`Couldn't link Pet #${subId} to ${mainName} (Link ${level})`);
        continue;
      }

      const subName = (fresh.candidates.find((c) => c.invId === subId) || {}).name ||
        (index && index.meta[subId] && index.meta[subId].name) || ('Pet #' + subId);
      const doSet = () => postLinkAction(mainInvId, 'set', { level, linkPetId: subId, csrf: fresh.csrf });
      try {
        try {
          await step(`Link ${subName} → ${mainName} (Link ${level})`, doSet);
        } catch (err) {
          // The game refuses to link a pet that's still on a team. Re-read every
          // team, take it off wherever it still is, and try once more.
          if (!/currently equipped/i.test((err && err.message) || '')) throw err;
          const freed = await unequipEverywhere(subId, subName);
          if (!freed) throw err;
          await step(`Link ${subName} → ${mainName} (Link ${level}), again`, doSet);
        }
        stats.changed++;
      }
      catch (err) { notes.push(`${mainName} Link ${level}: ${err.message || 'link failed'}`); }
    }

    dropLinkCache(mainInvId);
    dropLinkIndex();
  }

  // Who is wearing which sigil, across every team page, so pets in team slots
  // are included (the inventory section alone never lists them).
  async function collectSigilWearers() {
    const wearers = [];
    const names = {};
    const seen = new Set();
    for (const t of TEAM_KEYS) {
      let doc;
      try { doc = await getContextDoc(t, true); } catch (_) { continue; }
      Object.values(scanPetPool(doc)).forEach((p) => { names[p.invId] = p; });
      const eq = scanEquippedPetSlots(doc, t);
      SLOT_IDS.forEach((s) => { if (eq[s]) names[eq[s].invId] = eq[s]; });
      doc.querySelectorAll('.pet-card[data-pet-inv-id]').forEach((card) => {
        const invId = card.getAttribute('data-pet-inv-id');
        card.querySelectorAll('.pet-sigil-slot.filled').forEach((slot) => {
          const slotType = slot.classList.contains('attack') ? 'attack'
            : (slot.classList.contains('defense') ? 'defense' : null);
          const nameEl = slot.querySelector('.pet-sigil-copy b');
          if (!slotType || !nameEl) return;
          const key = invId + '|' + slotType;
          if (seen.has(key)) return;
          seen.add(key);
          wearers.push({ invId, slotType, name: nameEl.textContent.trim() });
        });
      });
    }
    return { wearers, names };
  }

  // `skip(wearer)` returns true for pets that must not give the sigil up.
  async function findSigilHolder(itemId, itemName, skip) {
    const { wearers, names } = await collectSigilWearers();
    const candidates = wearers.filter((w) => w.name === itemName && !(skip && skip(w)));
    for (const c of candidates) {
      try {
        const info = await fetchSigilInfo(c.invId, c.slotType, true);
        if (info.current && info.current.itemId === String(itemId)) {
          return {
            invId: c.invId,
            slotType: c.slotType,
            petName: names[c.invId] ? names[c.invId].name : ('Pet #' + c.invId),
          };
        }
      } catch (_) { /* try the next one */ }
    }
    return null;
  }

  async function findAllSigilHolders(itemId, itemName, excludeInvId /*, teamKey (unused now) */) {
    const { wearers, names } = await collectSigilWearers();
    const holders = [];
    for (const c of wearers.filter((w) => w.name === itemName && String(w.invId) !== String(excludeInvId))) {
      try {
        const info = await fetchSigilInfo(c.invId, c.slotType, true);
        if (info.current && info.current.itemId === String(itemId)) {
          holders.push({
            invId: c.invId,
            slotType: c.slotType,
            name: names[c.invId] ? names[c.invId].name : ('Pet #' + c.invId),
            image: names[c.invId] ? names[c.invId].image : '',
          });
        }
      } catch (_) { /* skip this candidate */ }
    }
    return holders;
  }

  // Phase 1 of the sigil restore: everything the preset wants gone comes off
  // first, which frees copies for phase 2 without any searching.
  async function sigilRemovalPass(preset, pets, notes, stats) {
    for (const pet of pets) {
      const wanted = preset.sigils && preset.sigils[pet.invId];
      if (!wanted) continue;
      for (const slotType of SIGIL_SLOTS) {
        if (!has(wanted, slotType) || wanted[slotType] !== null) continue;
        let info;
        try { info = await fetchSigilInfo(pet.invId, slotType, true); }
        catch (_) { notes.push(`${pet.name} ${SIGIL_LABELS[slotType]}: couldn't read`); continue; }
        if (!info.current) continue;
        try {
          await step(`Remove ${(info.current && info.current.name) || SIGIL_LABELS[slotType]} from ${pet.name}`,
                     () => postSigilAction(pet.invId, slotType, null));
          dropSigilCache(pet.invId);
          stats.changed++;
        }
        catch (err) { notes.push(`${pet.name} ${SIGIL_LABELS[slotType]}: ${err.message || 'remove failed'}`); }
      }
    }
  }

  // Phase 2: equip. The slot's existing sigil is only removed once the wanted
  // one is confirmed available, so a failure never leaves the slot empty.
  async function sigilEquipPass(preset, pets, teamKey, notes, stats) {
    const batchIds = new Set(pets.map((p) => String(p.invId)));

    for (const pet of pets) {
      const wanted = preset.sigils && preset.sigils[pet.invId];
      if (!wanted) continue;

      for (const slotType of SIGIL_SLOTS) {
        if (!has(wanted, slotType)) continue;
        const want = wanted[slotType];
        if (want === null) continue;

        let info;
        try { info = await fetchSigilInfo(pet.invId, slotType, true); }
        catch (_) { notes.push(`${pet.name} ${SIGIL_LABELS[slotType]}: couldn't read`); continue; }

        const cur = info.current ? info.current.itemId : null;
        if (cur === want) continue;

        let opt = info.options.find((o) => o.itemId === want);
        const label = (opt && opt.name) || (preset.meta?.sigils?.[want]?.name) || ('Sigil #' + want);
        if (!opt) { notes.push(`${pet.name}: ${label} isn't owned any more`); continue; }

        if (opt.available <= 0) {
          if (!CFG.FORCE_SIGILS) {
            notes.push(`${pet.name} ${SIGIL_LABELS[slotType]}: every copy of ${label} is equipped`);
            continue;
          }
          // A pet in this batch is protected only if the preset explicitly wants
          // this very sigil on it. A pet the preset says nothing about, or wants
          // something else on, can give it up.
          const protectedWearer = (w) => {
            if (String(w.invId) === String(pet.invId) && w.slotType === slotType) return true;
            if (!batchIds.has(String(w.invId))) return false;
            const entry = preset.sigils && preset.sigils[w.invId];
            if (!entry || !has(entry, w.slotType)) return false;
            return entry[w.slotType] === want;
          };
          const holder = await findSigilHolder(want, opt.name, protectedWearer);
          if (!holder) {
            notes.push(`${pet.name} ${SIGIL_LABELS[slotType]}: no free copy of ${label}, and every pet wearing it is meant to keep it`);
            continue;
          }
          try {
            await step(`Take ${label} off ${holder.petName}`, () => postSigilAction(holder.invId, holder.slotType, null));
            dropSigilCache(holder.invId);
            notes.push(`Took ${label} off ${holder.petName}`);
            info = await fetchSigilInfo(pet.invId, slotType, true);
            opt = info.options.find((o) => o.itemId === want);
          } catch (err) {
            notes.push(`Couldn't free ${label} from ${holder.petName}: ${err.message || 'failed'}`);
            continue;
          }
          if (!opt || opt.available <= 0) {
            notes.push(`${pet.name} ${SIGIL_LABELS[slotType]}: ${label} still has no free copy`);
            continue;
          }
        }

        try {
          await step(`Equip ${label} on ${pet.name} (${SIGIL_LABELS[slotType]})`, async () => {
            if (info.current) await postSigilAction(pet.invId, slotType, null);
            await postSigilAction(pet.invId, slotType, want);
          });
          dropSigilCache(pet.invId);
          stats.changed++;
        } catch (err) {
          notes.push(`${pet.name} ${SIGIL_LABELS[slotType]}: ${err.message || 'equip failed'}`);
        }
      }
    }
  }

  async function restorePresetToTeam(preset, targetTeam) {
    if (presetBusy) { notify('Wait for the current action to finish.', false); return; }
    presetBusy = true;
    stepRun = { title: 'Applying "' + preset.name + '"', log: [], done: 0, total: 0 };
    try {
      // Read all three team pages: a pet this preset wants may be sitting on
      // another team (and so be missing from this team's inventory list).
      const docs = {};
      await step('Reading your pet teams', async () => {
        for (const t of TEAM_KEYS) {
          try { docs[t] = await getContextDoc(t, true); } catch (_) { /* checked below */ }
        }
        if (!docs[targetTeam]) throw new Error('Could not reach the Pets page to read that team.');
      });

      const current = scanEquippedPetSlots(docs[targetTeam], targetTeam);
      const owned = {};       // every pet, wherever it is right now
      const elsewhere = {};   // id -> [{team, slotId}] for every team other than the target
      TEAM_KEYS.forEach((t) => {
        if (!docs[t]) return;
        Object.values(scanPetPool(docs[t])).forEach((p) => { if (!owned[p.invId]) owned[p.invId] = p; });
        const eq = scanEquippedPetSlots(docs[t], t);
        SLOT_IDS.forEach((s) => {
          const p = eq[s];
          if (!p) return;
          if (!owned[p.invId]) owned[p.invId] = p;
          if (t !== targetTeam) (elsewhere[p.invId] = elsewhere[p.invId] || []).push({ team: t, slotId: s });
        });
      });

      const toUnequip = [];
      const toEquip = [];
      const missing = [];
      const blocked = [];
      const missingIds = new Set();

      SLOT_IDS.forEach((slotId) => {
        const want = preset.slots[slotId];
        const cur = current[slotId];
        const wantId = want ? want.invId : null;
        const curId = cur ? cur.invId : null;
        if (wantId === curId) return;
        if (curId) toUnequip.push(slotId);
        if (wantId) {
          if (!owned[wantId]) { missing.push(want.name || ('Pet #' + wantId)); missingIds.add(wantId); return; }
          if (elsewhere[wantId] && !CFG.TAKE_FROM_OTHER_TEAMS) {
            blocked.push(`${want.name || ('Pet #' + wantId)} (on ${elsewhere[wantId].map((x) => TEAM_LABELS[x.team]).join(' & ')})`);
            missingIds.add(wantId);
            return;
          }
          toEquip.push({ slotId, invId: wantId });
        }
      });

      // Pets the preset wants (mains and their links) that sit on another team.
      const wantedIds = new Set();
      SLOT_IDS.forEach((s) => {
        const p = preset.slots[s];
        if (!p || missingIds.has(p.invId)) return;
        wantedIds.add(String(p.invId));
        Object.values((preset.links && preset.links[p.invId]) || {}).forEach((v) => { if (v) wantedIds.add(String(v)); });
      });
      const pulls = CFG.TAKE_FROM_OTHER_TEAMS ? [...wantedIds].filter((id) => elsewhere[id]) : [];

      const pullSteps = pulls.reduce((n, id) => n + elsewhere[id].length, 0);
      const total = toUnequip.length + pullSteps + toEquip.length;
      let done = 0;
      stepRun.total = total;
      const progress = () => { done++; stepRun.done = done; renderRun(); };
      const teamNotes = [];
      const stats = { changed: 0 };
      const linkNotes = [];

      for (const slotId of toUnequip) {
        const was = current[slotId];
        await step(`Unequip ${was ? was.name : 'slot ' + slotId} (slot ${slotId})`,
                   () => unequipPetFromTeam(slotId, targetTeam));
        progress();
      }

      for (const id of pulls) {
        const nm = (owned[id] && owned[id].name) || ('Pet #' + id);
        let pullFailed = false;
        for (const at of elsewhere[id]) {
          try {
            await step(`Take ${nm} off ${TEAM_LABELS[at.team]}`, () => unequipPetFromTeam(at.slotId, at.team));
            teamNotes.push(`${nm} came off ${TEAM_LABELS[at.team]}`);
          } catch (err) {
            pullFailed = true;
            teamNotes.push(`couldn't take ${nm} off ${TEAM_LABELS[at.team]}: ${err.message || 'failed'}`);
          }
          progress();
        }
        if (pullFailed) {
          const k = toEquip.findIndex((x) => String(x.invId) === id);
          if (k >= 0) { toEquip.splice(k, 1); missingIds.add(id); }
        }
      }

      // A pet that's becoming a main can't still be somebody's link.
      if (toEquip.length) {
        let idx = null;
        try { idx = await buildLinkIndex(true); } catch (_) { /* no index */ }
        if (idx) {
          for (const item of toEquip) {
            const h = idx.holderOf[item.invId];
            if (!h) continue;
            const nm = (owned[item.invId] && owned[item.invId].name) || ('Pet #' + item.invId);
            try {
              await step(`Free ${nm} from ${h.mainName}`, async () => {
                const hInfo = await fetchLinkInfo(h.mainId, true);
                await postLinkAction(h.mainId, 'remove', { level: h.level, csrf: hInfo.csrf });
              });
              dropLinkCache(h.mainId);
              dropLinkIndex();
              stats.changed++;
              linkNotes.push(`${nm} came off ${h.mainName} to be a main`);
            } catch (err) {
              linkNotes.push(`couldn't free ${nm} from ${h.mainName}: ${err.message || 'failed'}`);
            }
          }
        }
      }

      for (const item of toEquip) {
        const nm = (owned[item.invId] && owned[item.invId].name) || ('Pet #' + item.invId);
        await step(`Equip ${nm} → slot ${item.slotId}`, () => equipPetToTeam(item.invId, item.slotId, targetTeam));
        progress();
      }

      const pets = SLOT_IDS.map((s) => preset.slots[s]).filter((p) => p && !missingIds.has(p.invId));

      const sigilPets = [...pets];
      const sigilSeen = new Set(sigilPets.map((p) => String(p.invId)));

      for (const pet of pets) {
        const links = preset.links && preset.links[pet.invId];
        if (!links) continue;

        for (const linkedId of Object.values(links)) {
          if (!linkedId || sigilSeen.has(String(linkedId)) || !owned[linkedId]) continue;
          sigilSeen.add(String(linkedId));
          sigilPets.push(preset.meta?.pets?.[linkedId] || owned[linkedId]);
        }
      }

      // Unlink everything first, then link, so a pet freed by a later slot is
      // available to an earlier one.
      for (const phase of ['unlink', 'link']) {
        for (const pet of pets) {
          const wantLinks = preset.links && preset.links[pet.invId];
          if (wantLinks && Object.keys(wantLinks).length) {
            await applyLinksForPet(pet.invId, pet.name, wantLinks, linkNotes, stats, phase);
          }
        }
      }

      const sigilNotes = [];
      await sigilRemovalPass(preset, sigilPets, sigilNotes, stats);
      await sigilEquipPass(preset, sigilPets, targetTeam, sigilNotes, stats);

      dropDocCache();
      dropLinkIndex();
      await step('Refreshing the page', async () => {
        if (isPetsPage()) await smartRefreshTeamSections(getUrlTeam());
        else scheduleAugment();
      });

      const notes = [];
      if (missing.length) notes.push(`Not owned: ${missing.join(', ')}`);
      if (blocked.length) notes.push(`Skipped, on another team: ${blocked.join(', ')}`);
      if (teamNotes.length) notes.push(`Teams — ${teamNotes.join('; ')}`);
      if (linkNotes.length) notes.push(`Links — ${linkNotes.join('; ')}`);
      if (sigilNotes.length) notes.push(`Sigils — ${sigilNotes.join('; ')}`);

      const rawNotes = [].concat(
        missing.length ? [`Not owned: ${missing.join(', ')}`] : [],
        blocked.length ? [`Skipped, on another team: ${blocked.join(', ')}`] : [],
        teamNotes, linkNotes, sigilNotes);
      const summary = (!total && !stats.changed && !notes.length)
        ? `${TEAM_LABELS[targetTeam]} already matches "${preset.name}".`
        : `Applied "${preset.name}" to ${TEAM_LABELS[targetTeam]}.`;
      finishRun(summary, true, rawNotes);
    } catch (err) {
      const msg = 'Stopped: ' + (err?.message || 'action failed');
      finishRun(msg, false, []);
    } finally {
      stepRun = null;
      presetBusy = false;
    }
  }

  /* ------------------------------- styles ----------------------------- */

  function injectPresetStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .pp-modal{ position:fixed; inset:0; background:rgba(6,10,18,.74); display:none;
        align-items:center; justify-content:center; padding:20px; z-index:300000; backdrop-filter:blur(7px); }
      .pp-modal.show{ display:flex; }
      #ppPickerModal{ z-index:300010; background:rgba(4,7,14,.8); }
      .pp-modal-card{ width:min(760px,100%); max-height:90vh; overflow:auto;
        background:linear-gradient(180deg, rgba(24,34,56,.98), rgba(14,20,34,.98));
        border:1px solid rgba(255,255,255,.08); border-radius:22px; box-shadow:0 26px 60px rgba(0,0,0,.38);
        padding:22px; color:#eef3ff; font-family:Arial,sans-serif; }
      .pp-modal-head{ display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:16px; }
      .pp-modal-title{ margin:0; font-size:22px; }
      .pp-close-btn{ width:38px; height:38px; border-radius:12px; border:none; background:#18223a; color:#fff; font-size:20px; cursor:pointer; }
      .pp-modal-sub{ color:#9caad0; font-size:13px; margin-bottom:14px; line-height:1.5; }

      .pp-btn{ border:none; cursor:pointer; color:#fff;
        background:linear-gradient(135deg,#3657a7,#4b6dd0); padding:9px 14px; border-radius:12px;
        font:700 13px Arial,sans-serif; box-shadow:0 8px 18px rgba(41,72,155,.28); }
      .pp-btn:hover{ filter:brightness(1.06); }
      .pp-btn-soft{ background:linear-gradient(135deg,#222d49,#2b3859); box-shadow:none; }
      .pp-btn-success{ background:linear-gradient(135deg,#217f5b,#33b57f); }
      .pp-btn:disabled{ opacity:.5; cursor:not-allowed; }

      .pp-row{ display:flex; justify-content:space-between; align-items:center; gap:12px; padding:12px;
        background:#11192d; border:1px solid rgba(255,255,255,.06); border-radius:14px; margin-bottom:10px; flex-wrap:wrap; }
      .pp-row-name{ font-weight:800; }
      .pp-row-meta{ color:#9caad0; font-size:12px; margin-top:2px; }
      .pp-equipped-badge{ display:inline-block; font:800 10px Arial,sans-serif; letter-spacing:.03em; text-transform:uppercase;
        color:#8ee6a8; background:rgba(46,204,113,.12); border:1px solid rgba(46,204,113,.35); border-radius:999px;
        padding:2px 7px; vertical-align:middle; margin-left:6px; }
      .pp-row-icons{ display:flex; gap:4px; margin-top:6px; flex-wrap:wrap; }
      .pp-row-icons img{ width:24px; height:24px; border-radius:6px; object-fit:cover;
        border:1px solid rgba(255,255,255,.08); background:#0d1322; }
      .pp-row-actions{ display:flex; gap:6px; flex-wrap:wrap; }
      .pp-row-actions .pp-btn{ padding:6px 10px; font-size:12px; }

      .pp-menu-btn{ width:32px; height:32px; padding:0; display:inline-flex; align-items:center; justify-content:center; font-size:17px; }
      .pp-menu-dropdown{ position:fixed; z-index:300050; background:#171e33; border:1px solid rgba(255,255,255,.1);
        border-radius:12px; box-shadow:0 12px 28px rgba(0,0,0,.45); min-width:150px; padding:6px; display:none; }
      .pp-menu-dropdown.open{ display:block; }
      .pp-menu-item{ display:block; width:100%; text-align:left; background:none; border:none; color:#e7ecff;
        padding:8px 10px; border-radius:8px; font:13px Arial,sans-serif; cursor:pointer; }
      .pp-menu-item:hover{ background:rgba(255,255,255,.06); }
      .pp-menu-item.danger{ color:#ff8a97; }

      .pp-empty-state{ padding:30px 18px; text-align:center; color:#9caad0; background:rgba(255,255,255,.02);
        border:1px dashed rgba(255,255,255,.08); border-radius:16px; }

      .pp-editor-grid{ display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:12px; }
      .pp-slot-column{ display:flex; flex-direction:column; gap:8px; }
      .pp-slot-card{ background:#11192d; border:1px solid rgba(255,255,255,.06); border-radius:14px; padding:10px; text-align:center; }
      .pp-slot-label{ font-size:11px; color:#9caad0; margin-bottom:6px; }
      .pp-slot-name{ margin-top:6px; font-size:12px; color:#cfd8f7; overflow-wrap:anywhere; }

      .pp-slot-icon{ width:110px; height:110px; margin:0 auto; border-radius:14px; background:#0d1322; overflow:hidden;
        position:relative; cursor:pointer; border:1px solid rgba(255,255,255,.08);
        display:flex; align-items:center; justify-content:center; }
      .pp-slot-icon > img{ width:100%; height:100%; object-fit:cover; display:block; }
      .pp-slot-icon.empty{ color:#5f6890; font-size:26px; font-weight:800; }
      .pp-slot-remove{ position:absolute; top:2px; right:2px; width:16px; height:16px; border-radius:50%; border:none;
        background:rgba(10,15,28,.85); color:#fff; font-size:11px; line-height:16px; padding:0; cursor:pointer; z-index:4; }
      .pp-slot-remove:hover{ background:rgba(255,107,122,.9); }

      /* Sigils: two chips layered over the base of the pet art. */
      .pp-sigil-layer{ position:absolute; left:0; right:0; bottom:5px; display:flex; gap:7px; justify-content:center; z-index:3; }
      .pp-link-tile .pp-sigil-layer{ gap:3px; bottom:2px; transform:scale(.85); transform-origin:bottom center; }
      .pp-chip{ position:relative; width:32px; height:32px; border-radius:9px;
        background:rgba(9,13,24,.85); border:1px solid rgba(255,255,255,.22); cursor:pointer;
        display:flex; align-items:center; justify-content:center; font-size:13px; color:#95a0c6;
        box-shadow:0 2px 8px rgba(0,0,0,.55); }
      .pp-chip img{ width:100%; height:100%; object-fit:cover; display:block; border-radius:8px; }
      .pp-chip:hover{ border-color:rgba(255,255,255,.5); }
      .pp-chip-empty{ border-style:dashed; opacity:.7; }
      .pp-chip-atk{ box-shadow:0 2px 8px rgba(0,0,0,.55), inset 0 0 0 1px rgba(255,146,85,.3); }
      .pp-chip-def{ box-shadow:0 2px 8px rgba(0,0,0,.55), inset 0 0 0 1px rgba(75,178,255,.3); }
      .pp-x{ position:absolute; top:-5px; right:-5px; width:15px; height:15px; border-radius:50%; border:none;
        background:rgba(10,15,28,.96); color:#fff; font-size:9px; line-height:15px; padding:0; cursor:pointer; z-index:2; }
      .pp-x:hover{ background:rgba(255,107,122,.95); }

      /* Links: tiles under the card. */
      .pp-links-panel{ background:#0d1322; border:1px solid rgba(255,255,255,.06); border-radius:12px; padding:8px; }
      .pp-links-title{ font:800 10px Arial,sans-serif; letter-spacing:.04em; text-transform:uppercase;
        color:#9caad0; margin-bottom:6px; text-align:center; }
      .pp-links-row{ display:flex; gap:8px; justify-content:center; }
      .pp-link-box{ flex:1; text-align:center; min-width:0; }
      .pp-link-label{ font-size:10px; color:#7f8ab8; margin-bottom:4px; }
      .pp-link-tile{
  position:relative;
  width:80px;
  height:80px;
  margin:0 auto;
  border-radius:11px;
  background:#11192d;
  cursor:pointer;
  border:1px solid rgba(255,255,255,.12);
  display:flex;
  align-items:center;
  justify-content:center;
  color:#5f6890;
  font-size:17px;
}
.pp-link-tile img{
  width:100%;
  height:100%;
  object-fit:cover;
  display:block;
  border-radius:10px;
}
      .pp-link-tile img{ width:100%; height:100%; object-fit:cover; display:block; border-radius:10px; }
      .pp-link-tile.locked{ cursor:not-allowed; color:#8a6a4a; background:#171313; }
      .pp-link-tile.empty{ border-style:dashed; opacity:.7; }
      .pp-link-name{ margin-top:5px; font-size:11px; color:#cfd8f7; overflow-wrap:anywhere; }
      .pp-links-loading{ font-size:11px; color:#9caad0; text-align:center; padding:6px 0; }
      .pp-links-error{ font-size:11px; color:#ff8a97; text-align:center; padding:6px 0; }

      .pp-picker-grid{ display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; max-height:55vh; overflow:auto; }
      .pp-picker-card{ background:#10182a; border:1px solid rgba(255,255,255,.06); border-radius:16px; padding:12px; text-align:center; }
      .pp-picker-icon{ width:92px; height:92px; margin:0 auto; border-radius:14px; overflow:visible; background:#0d1322;
        display:flex; align-items:center; justify-content:center; font-size:28px; color:#59627f; position:relative; }
      .pp-picker-icon img{ width:100%; height:100%; object-fit:cover; border-radius:14px; display:block; }
      .pp-picker-name{ font-size:12px; color:#eef3ff; margin:8px 0 4px; overflow-wrap:anywhere; }
      .pp-picker-tag{ font-size:11px; color:#b3a4ff; margin-bottom:8px; }
      .pp-picker-tag.warn{ color:#ffc27a; }
      .pp-picker-badge{
        position:absolute; left:50%; bottom:-8px;
        transform:translateX(-50%);
        font-size:15px; font-weight:800;
        color:#ffd978;
        text-shadow:0 1px 3px rgba(0,0,0,.9), 0 0 4px rgba(0,0,0,.6);
        pointer-events:none;
        z-index:3;
        white-space:nowrap;
        letter-spacing:1px;
      }
      .pp-picker-conflict{ opacity:.72; }
      .pp-picker-conflict .pp-picker-icon{ filter:grayscale(.5); }

      .pp-picker-clickable{ cursor:pointer; transition: transform .12s ease, border-color .12s ease, background .12s ease; }
      .pp-picker-clickable:hover{ transform:translateY(-2px); border-color:rgba(110,168,255,.3); background:#141d38; }

      .pp-picker-sigil-row{ position:absolute; left:50%; bottom:8px; transform:translateX(-50%);
        display:flex; gap:4px; z-index:2; }
      .pp-picker-chip{ width:22px; height:22px; border-radius:6px; overflow:hidden; background:rgba(13,19,34,.9);
        border:1px solid rgba(255,255,255,.25); display:flex; align-items:center; justify-content:center;
        font-size:11px; color:#9aa4c7; box-shadow:0 2px 6px rgba(0,0,0,.5); }
      .pp-picker-chip img{ width:100%; height:100%; object-fit:cover; display:block; }
      .pp-picker-chip-empty{ opacity:.4; border-style:dashed; }

      .pp-set-choice{ display:grid; gap:10px; }
      .pp-set-choice .pp-btn{ width:100%; padding:12px; font-size:14px; }
      .pp-footer{ display:flex; gap:8px; flex-wrap:wrap; margin-top:16px; align-items:center; }

            .pp-buy-action-btn{
        display:block;
        width:170px;
        box-sizing:border-box;
        white-space:nowrap;
        text-align:center;
        margin:0 auto;
      }
    `;
    document.head.appendChild(style);
  }

  /* ----------------------------- list view ---------------------------- */

  function closeModal(id) { document.getElementById(id)?.classList.remove('show'); }
  function mkBtn(cls, label, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pp-btn ' + cls;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  function getMenuEl() {
    let el = document.getElementById('ppSharedMenu');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ppSharedMenu';
      el.className = 'pp-menu-dropdown';
      document.body.appendChild(el);
    }
    return el;
  }
  function toggleMenu(anchor, preset) {
    const menu = getMenuEl();
    const openForThis = menu.classList.contains('open') && menuMountedFor === preset.id;
    menu.classList.remove('open');
    if (openForThis) { menuMountedFor = null; return; }

    menu.innerHTML = '';
    [
      ['Edit', () => openEditor(preset)],
      ['Rename', () => renamePreset(preset)],
      ['Duplicate', () => duplicatePreset(preset)],
      ['Delete', () => deletePreset(preset), true],
    ].forEach(([label, fn, danger]) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'pp-menu-item' + (danger ? ' danger' : '');
      item.textContent = label;
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.classList.remove('open');
        menuMountedFor = null;
        fn();
      });
      menu.appendChild(item);
    });

    const r = anchor.getBoundingClientRect();
    menu.style.top = (r.bottom + 6) + 'px';
    menu.style.right = (window.innerWidth - r.right) + 'px';
    menu.style.left = 'auto';
    menu.classList.add('open');
    menuMountedFor = preset.id;
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

  function countSet(map) {
    let n = 0;
    Object.values(map || {}).forEach((e) => {
      Object.values(e || {}).forEach((v) => { if (v) n++; });
    });
    return n;
  }

  function renderPresetList() {
    const wrap = document.getElementById('ppList');
    if (!wrap) return;
    const presets = loadPresets();
    if (!presets.length) {
      wrap.innerHTML = '<div class="pp-empty-state">No presets yet. Capture a team you already have set up, or start one from scratch.</div>';
      return;
    }

    const onPets = isPetsPage();
    const liveTeam = onPets ? getUrlTeam() : null;
    const liveSlots = onPets ? scanEquippedPetSlots(document, liveTeam) : null;

    wrap.innerHTML = '';
    presets.forEach((preset) => {
      const row = document.createElement('div');
      row.className = 'pp-row';
      const filled = SLOT_IDS.filter((s) => preset.slots[s]).length;
      const nLinks = countSet(preset.links);
      const nSigils = countSet(preset.sigils);
      const matches = liveSlots && slotsEqual(preset.slots, liveSlots) && presetSigilsMatch(preset, liveSlots);

      const meta = [`${filled}/3 pets`];
      if (nLinks) meta.push(`${nLinks} link${nLinks === 1 ? '' : 's'}`);
      if (nSigils) meta.push(`${nSigils} sigil${nSigils === 1 ? '' : 's'}`);

      const info = document.createElement('div');
      info.innerHTML = `<div class="pp-row-name">${esc(preset.name)}${matches ? ` <span class="pp-equipped-badge">Equipped · ${TEAM_LABELS[liveTeam]}</span>` : ''}</div>
        <div class="pp-row-meta">${meta.join(' · ')}</div>`;
      const icons = document.createElement('div');
      icons.className = 'pp-row-icons';
      SLOT_IDS.forEach((s) => {
        const p = preset.slots[s];
        if (!p || !p.image) return;
        const img = document.createElement('img');
        img.src = p.image;
        img.title = p.name;
        icons.appendChild(img);
      });
      info.appendChild(icons);
      row.appendChild(info);

      const actions = document.createElement('div');
      actions.className = 'pp-row-actions';
      actions.appendChild(mkBtn('pp-btn-success', '▶ Apply', () => openApplyModal(preset)));
      const menuBtn = mkBtn('pp-btn-soft pp-menu-btn', '⋯', (e) => { e.stopPropagation(); toggleMenu(menuBtn, preset); });
      actions.appendChild(menuBtn);
      row.appendChild(actions);

      wrap.appendChild(row);
    });
  }

  /* ------------------------------- editor ----------------------------- */

  let editor = null; // { working, pool, index, linkInfo, sigilInfo }

  async function openEditor(preset) {
    document.getElementById('ppEditorName').textContent = preset.name;
    document.getElementById('ppEditorGrid').innerHTML = '<div class="pp-empty-state">Loading pets…</div>';
    document.getElementById('ppEditorModal').classList.add('show');

    const working = JSON.parse(JSON.stringify(preset));
    working.links = working.links || {};
    working.sigils = working.sigils || {};
    working.meta = working.meta || blankMeta();
    working.meta.pets = working.meta.pets || {};
    working.meta.sigils = working.meta.sigils || {};

    let pool;
    try {
      pool = scanPetPool(await getContextDoc(isPetsPage() ? getUrlTeam() : 'attack'));
    } catch (_) {
      document.getElementById('ppEditorGrid').innerHTML =
        '<div class="pp-empty-state">Couldn\'t reach the Pets page. Check your connection and reopen this preset.</div>';
      return;
    }

    editor = { working, pool, index: null, linkInfo: {}, sigilInfo: {}, ghost: {}, mains: {} };
    renderEditorGrid();
    editor.mainsReady = loadMainPets().catch(() => {});
    SLOT_IDS.forEach((s) => { if (working.slots[s]) loadPetState(working.slots[s].invId); });

    buildLinkIndex().then((index) => {
      if (editor && editor.working.id === working.id) { editor.index = index; renderEditorGrid(); }
    }).catch(() => { /* the "under X" hints just won't show */ });

    document.getElementById('ppEditorSave').onclick = () => {
      pruneOrphans(working);
      working.updatedAt = Date.now();
      working.version = 3;
      const list = loadPresets();
      const i = list.findIndex((p) => p.id === working.id);
      if (i >= 0) list[i] = working; else list.push(working);
      savePresets(list);
      renderPresetList();
      closeModal('ppEditorModal');
      notify(`Saved "${working.name}".`, true);
    };
  }

  // How many copies of a sigil this preset already hands out, counting only
  // pets that are actually in it (mains and their links).
  function sigilDemand(itemId, exceptInv, exceptSlot) {
    const { working } = editor;
    const active = new Set();
    SLOT_IDS.forEach((s) => {
      const p = working.slots[s];
      if (!p) return;
      active.add(String(p.invId));
      Object.values(working.links[p.invId] || {}).forEach((v) => { if (v) active.add(String(v)); });
    });
    let n = 0;
    active.forEach((id) => {
      const e = working.sigils[id];
      if (!e) return;
      SIGIL_SLOTS.forEach((st) => {
        if (id === String(exceptInv) && st === exceptSlot) return;
        if (e[st] === String(itemId)) n++;
      });
    });
    return n;
  }

  // Load a pet's real links and sigils, and seed any slot this preset hasn't
  // already decided, so the editor opens showing what the pet actually has.
  function loadPetState(invId) {
    const { working } = editor;

    const isSlotted = () => SLOT_IDS.some((s) => working.slots[s] && working.slots[s].invId === invId);
    const usedElsewhere = (id) =>
      SLOT_IDS.some((s) => working.slots[s] && working.slots[s].invId === id) ||
      Object.keys(working.links).some((m) => m !== invId && Object.values(working.links[m] || {}).includes(id));

    // Only pets sitting in a slot own links in the preset.
    const seedLinks = (info) => {
      if (!isSlotted()) return false;
      const entry = working.links[invId] || {};
      let changed = false;
      LINK_LEVELS.forEach((lvl) => {
        if (!info.unlocked[lvl] || has(entry, lvl)) return;
        const sub = info.links[lvl];
        entry[lvl] = sub && !usedElsewhere(sub.invId) ? sub.invId : null;
        if (entry[lvl]) working.meta.pets[sub.invId] = sub;
        changed = true;
      });
      if (Object.keys(entry).length) working.links[invId] = entry;
      return changed;
    };

    // Seed a slot from the live pet only if the preset hasn't already given
    // every copy of that sigil to someone else. Otherwise seed "none", so the
    // pet gives it up on apply instead of the preset wanting it twice.
    const seedSigil = (slotType, info) => {
      const entry = working.sigils[invId] || {};
      if (has(entry, slotType)) return false;
      const cur = info.current;
      let take = !!cur;
      if (cur) {
        const opt = info.options.find((o) => o.itemId === cur.itemId);
        const owned = Number(cur.owned || (opt && opt.owned) || 0);
        if (owned && sigilDemand(cur.itemId, invId, slotType) >= owned) take = false;
      }
      entry[slotType] = take ? cur.itemId : null;
      if (take) working.meta.sigils[cur.itemId] = cur;
      working.sigils[invId] = entry;
      return true;
    };

    // Deferred on purpose: this is called from inside render, and a nested
    // render would append the columns twice.
    const rerender = () => setTimeout(() => { if (editor) renderEditorGrid(); }, 0);

    const knownLinks = editor.linkInfo[invId];
    if (knownLinks && !knownLinks.loading && !knownLinks.failed) {
      if (seedLinks(knownLinks)) rerender();
    } else if (!knownLinks) {
      editor.linkInfo[invId] = { loading: true };
      fetchLinkInfo(invId).then((info) => {
        if (!editor) return;
        editor.linkInfo[invId] = info;
        seedLinks(info);
        renderEditorGrid();
      }).catch(() => {
        if (!editor) return;
        editor.linkInfo[invId] = { failed: true };
        renderEditorGrid();
      });
    }

    SIGIL_SLOTS.forEach((slotType) => {
      const key = invId + '|' + slotType;
      const known = editor.sigilInfo[key];
      if (known && !known.loading && !known.failed) {
        if (seedSigil(slotType, known)) rerender();
        return;
      }
      if (known) return;
      editor.sigilInfo[key] = { loading: true };
      fetchSigilInfo(invId, slotType).then((info) => {
        if (!editor) return;
        editor.sigilInfo[key] = info;
        seedSigil(slotType, info);
        renderEditorGrid();
      }).catch(() => {
        if (!editor) return;
        editor.sigilInfo[key] = { failed: true };
        renderEditorGrid();
      });
    });
  }

function pruneOrphans(w) {
  const active = new Set(SLOT_IDS.map((s) => w.slots[s]?.invId).filter(Boolean));
  const keepSigils = new Set(active);
  active.forEach((id) => Object.values(w.links[id] || {}).forEach((v) => { if (v) keepSigils.add(v); }));
  if (editor) Object.values(editor.ghost || {}).forEach((g) => Object.values(g).forEach((v) => { if (v) keepSigils.add(v); }));
  Object.keys(w.links || {}).forEach((id) => { if (!active.has(id)) delete w.links[id]; });
  Object.keys(w.sigils || {}).forEach((id) => { if (!keepSigils.has(id)) delete w.sigils[id]; });
}

  // Clearing a slot keeps its links around as a "ghost" that carries over to
// whatever pet goes into that slot next.
function clearSlot(slotId) {
  const { working } = editor;
  const slot = working.slots[slotId];
  if (!slot) return;
  const entry = working.links[slot.invId];
  if (entry && Object.values(entry).some(Boolean)) editor.ghost[slotId] = Object.assign({}, entry);
  delete working.slots[slotId];
  pruneOrphans(working);
  renderEditorGrid();
}

// Reads all three team pages. Records which pets are equipped where (editor.mains)
// and widens editor.pool to every pet you own, including ones sitting on another
// team, so they can be picked as a main or a link.
async function loadMainPets() {
  const results = await mapLimit(TEAM_KEYS, 3, async (t) => {
    const doc = await getContextDoc(t, true);
    return { slots: scanEquippedPetSlots(doc, t), pool: scanPetPool(doc) };
  });
  if (!editor) return;
  const mains = {};
  const all = Object.assign({}, editor.pool);
  results.forEach((r, i) => {
    if (!r) return;
    Object.values(r.pool).forEach((p) => { if (!all[p.invId]) all[p.invId] = p; });
    SLOT_IDS.forEach((s) => {
      const p = r.slots[s];
      if (!p) return;
      (mains[p.invId] = mains[p.invId] || []).push(TEAM_LABELS[TEAM_KEYS[i]]);
      if (!all[p.invId]) all[p.invId] = { invId: p.invId, name: p.name, image: p.image, stars: p.stars, level: p.level, rarity: p.rarity };
    });
  });
  editor.mains = mains;
  editor.pool = all;
  const seenRarities = Object.values(all).map((p) => p.rarity).filter(Boolean);
  if (!seenRarities.length) {
    console.warn('[pet presets] could not read a rarity from any pet card, so the legendary/mythic link rule is not being applied.');
  }
}

function buildGhostLinksPanel(slotId) {
  const { working, index } = editor;
  const entry = editor.ghost[slotId];
  const panel = document.createElement('div');
  panel.className = 'pp-links-panel';

  const title = document.createElement('div');
  title.className = 'pp-links-title';
  title.textContent = '🔗 Kept links';
  panel.appendChild(title);

  const row = document.createElement('div');
  row.className = 'pp-links-row';

  LINK_LEVELS.forEach((level) => {
    const value = entry[level] || null;
    const shown = value
      ? (working.meta.pets[value] || (index && index.meta[value]) || { name: 'Pet #' + value, image: '' })
      : null;

    const box = document.createElement('div');
    box.className = 'pp-link-box';

    const lbl = document.createElement('div');
    lbl.className = 'pp-link-label';
    lbl.textContent = 'Link ' + level;
    box.appendChild(lbl);

    const tile = document.createElement('div');
    tile.className = 'pp-link-tile' + (value ? '' : ' empty');
    tile.style.cursor = 'default';
    if (shown && shown.image) {
      const img = document.createElement('img');
      img.src = shown.image;
      tile.appendChild(img);
    } else {
      tile.textContent = value ? '🐾' : '+';
    }
    if (shown) tile.title = shown.name;

    if (value) {
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'pp-x';
      x.textContent = '×';
      x.title = 'Drop this kept link';
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        entry[level] = null;
        if (!LINK_LEVELS.some((l) => entry[l])) delete editor.ghost[slotId];
        renderEditorGrid();
      });
      tile.appendChild(x);
    }
    box.appendChild(tile);

    const nm = document.createElement('div');
    nm.className = 'pp-link-name';
    nm.textContent = shown ? shown.name : 'None';
    box.appendChild(nm);

    row.appendChild(box);
  });

  panel.appendChild(row);

  const hint = document.createElement('div');
  hint.className = 'pp-links-loading';
  hint.textContent = 'Carries over to the next pet you put in this slot.';
  panel.appendChild(hint);
  return panel;
}

  function renderEditorGrid() {
    if (!editor) return;
    const { working, pool } = editor;
    const grid = document.getElementById('ppEditorGrid');
    grid.innerHTML = '';

    SLOT_IDS.forEach((slotId) => {
      const slot = working.slots[slotId];
      const column = document.createElement('div');
      column.className = 'pp-slot-column';

      const card = document.createElement('div');
      card.className = 'pp-slot-card';

      const label = document.createElement('div');
      label.className = 'pp-slot-label';
      label.textContent = 'Slot ' + slotId;
      card.appendChild(label);

      const icon = document.createElement('div');
      icon.className = 'pp-slot-icon' + (slot ? '' : ' empty');

      if (slot) {
        const img = document.createElement('img');
        img.src = slot.image;
        img.title = slot.name;
        icon.appendChild(img);

        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'pp-slot-remove';
        rm.title = 'Clear this slot';
        rm.textContent = '×';
        rm.addEventListener('click', (e) => {
          e.stopPropagation();
          clearSlot(slotId);
        });
        icon.appendChild(rm);

        icon.appendChild(buildSigilLayer(slot.invId));
      } else {
        const plus = document.createElement('span');
        plus.textContent = '+';
        icon.appendChild(plus);
      }

      icon.addEventListener('click', (e) => {
        if (e.target.closest('.pp-sigil-layer') || e.target.closest('.pp-slot-remove')) return;
        // Wait for the all-teams read so pets that sit on other teams are listed.
        Promise.resolve(editor && editor.mainsReady).then(() => {
          if (!editor) return;
          const used = new Set(SLOT_IDS.filter((s) => s !== slotId && working.slots[s])
                               .map((s) => working.slots[s].invId));
          const items = Object.values(editor.pool)
            .filter((p) => !used.has(p.invId))
            .map((p) => {
              const on = editor.mains[p.invId];
              if (!on) return p;
              return Object.assign({}, p, {
                tag: 'Equipped on ' + on.join(', ') + ' now' + (CFG.TAKE_FROM_OTHER_TEAMS ? '' : ' — apply will skip it'),
                warn: true,
              });
            });

          openChooser({
            title: 'Choose a pet',
            items,
            showSigils: true,
            onPick: (picked) => {
              const chosen = { invId: picked.invId, name: picked.name, image: picked.image, stars: picked.stars, level: picked.level, rarity: picked.rarity };
              const prev = working.slots[slotId];

              // Links to carry over: the kept ones from a cleared slot, or, on a
              // straight swap, the outgoing pet's own links.
              let carry = editor.ghost[slotId] || null;
              if (!carry && prev && prev.invId !== chosen.invId) {
                const old = working.links[prev.invId];
                if (old && LINK_LEVELS.some((l) => old[l])) carry = Object.assign({}, old);
              }
              delete editor.ghost[slotId];

              // A pet that becomes a main can't also be a link in this preset.
              Object.keys(working.links).forEach((mid) => {
                const en = working.links[mid];
                if (!en) return;
                LINK_LEVELS.forEach((l) => { if (en[l] === chosen.invId) en[l] = null; });
              });
              Object.keys(editor.ghost).forEach((sid) => {
                const g = editor.ghost[sid];
                LINK_LEVELS.forEach((l) => { if (g[l] === chosen.invId) g[l] = null; });
                if (!LINK_LEVELS.some((l) => g[l])) delete editor.ghost[sid];
              });

              working.slots[slotId] = { invId: chosen.invId, name: chosen.name, image: chosen.image };
              working.meta.pets[chosen.invId] = chosen;

              // Drop anything seeded for this pet earlier (e.g. while it was only a link tile).
              delete working.links[chosen.invId];
              if (carry) {
                const taken = new Set(SLOT_IDS.filter((s) => working.slots[s]).map((s) => working.slots[s].invId));
                const carried = {};
                LINK_LEVELS.forEach((lvl) => {
                  if (carry[lvl] && !taken.has(carry[lvl])) carried[lvl] = carry[lvl];
                });
                if (Object.keys(carried).length) working.links[chosen.invId] = carried;
              }

              pruneOrphans(working);
              renderEditorGrid();
              loadPetState(chosen.invId);
            },
          });
        });
      });
      card.appendChild(icon);

      const name = document.createElement('div');
      name.className = 'pp-slot-name';
      name.textContent = slot ? slot.name : 'Empty';
      card.appendChild(name);

      column.appendChild(card);
      if (slot) column.appendChild(buildLinksPanel(slot.invId));
      else if (editor.ghost[slotId]) column.appendChild(buildGhostLinksPanel(slotId));
      grid.appendChild(column);
    });
  }

  // ---- links, under the card ----

  function buildLinksPanel(mainInvId) {
    const panel = document.createElement('div');
    panel.className = 'pp-links-panel';

    const title = document.createElement('div');
    title.className = 'pp-links-title';
    title.textContent = '🔗 Pet Links';
    panel.appendChild(title);

    const info = editor.linkInfo[mainInvId];
    if (!info || info.loading) {
      const l = document.createElement('div');
      l.className = 'pp-links-loading';
      l.textContent = 'Loading…';
      panel.appendChild(l);
      return panel;
    }
    if (info.failed) {
      const e = document.createElement('div');
      e.className = 'pp-links-error';
      e.textContent = 'Couldn\'t load links.';
      panel.appendChild(e);
      return panel;
    }

    const row = document.createElement('div');
    row.className = 'pp-links-row';

    LINK_LEVELS.forEach((level) => {
      const { working, index } = editor;
      const entry = working.links[mainInvId] || {};
      const value = has(entry, level) ? entry[level] : null;
      const unlocked = !!info.unlocked[level];

      const box = document.createElement('div');
      box.className = 'pp-link-box';

      const lbl = document.createElement('div');
      lbl.className = 'pp-link-label';
      lbl.textContent = 'Link ' + level;
      box.appendChild(lbl);

      let shown = null;
      if (value) {
        const live = info.links[level] && info.links[level].invId === value ? info.links[level] : null;
        shown = live
        || info.candidates.find((c) => c.invId === value)
        || working.meta.pets[value]
        || (index && index.meta[value])
        || { name: 'Pet #' + value, image: '' };
      }

      const tile = document.createElement('div');
      tile.className = 'pp-link-tile' + (!unlocked ? ' locked' : (value ? '' : ' empty'));

      if (!unlocked) { tile.textContent = '🔒'; tile.title = 'Locked on this pet'; }
      else if (!value) { tile.textContent = '+'; tile.title = 'No link'; }
      else if (shown.image) {
        const img = document.createElement('img');
        img.src = shown.image;
        tile.appendChild(img);
        tile.title = shown.name;
      } else { tile.textContent = '🐾'; tile.title = shown.name; }

      if (unlocked && value) {
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'pp-x';
        x.textContent = '×';
        x.title = 'Unlink';
        x.addEventListener('click', (e) => {
          e.stopPropagation();
          working.links[mainInvId] = working.links[mainInvId] || {};
          working.links[mainInvId][level] = null;
          pruneOrphans(working);
          renderEditorGrid();
        });
        tile.appendChild(x);
      }

      if (unlocked) tile.addEventListener('click', () => openLinkChooser(mainInvId, level, info));
      if (unlocked && value) {
        loadPetState(value);
        tile.appendChild(buildSigilLayer(value));
      }

      box.appendChild(tile);

      const nm = document.createElement('div');
      nm.className = 'pp-link-name';
      nm.textContent = !unlocked ? 'Locked' : (value ? shown.name : 'None');
      box.appendChild(nm);

      row.appendChild(box);
    });

    panel.appendChild(row);
    return panel;
  }

  // Who already holds this sub-pet, checked two ways: (1) another slot in this
  // same preset — this also covers a slot's own live state, since each slot's
  // links are seeded from the real pet the moment it's added (loadPetState),
  // so this catches conflicts even before the user has touched anything; then
  // (2) the live link index, for a holder that isn't part of this preset at
  // all. Checking (1) first means a pet already accounted for by this preset
  // is explained in preset terms ("Linked to Grondakar in this preset") rather
  // than as a live-game fact the picker can't actually act on consistently.
function findLinkConflict(subId, excludeMain, excludeLevel) {
  const { working, index } = editor;

  // Another pet in this same preset already has it: a real conflict.
  for (const mainId of Object.keys(working.links)) {
    const entry = working.links[mainId] || {};
    for (const lvl of LINK_LEVELS) {
      if (mainId === excludeMain && lvl === excludeLevel) continue;
      if (entry[lvl] === subId) {
        const meta = working.meta.pets[mainId];
        return { scope: 'preset', mainId, level: lvl, mainName: meta ? meta.name : ('Pet #' + mainId) };
      }
    }
  }

  // Held live by some other pet. Informational only: Apply takes it off them.
  const holder = index && index.holderOf[subId];
  if (holder && holder.mainId !== excludeMain) {
    const slotted = SLOT_IDS.some((s) => working.slots[s] && working.slots[s].invId === holder.mainId);
    // If the holder is in this preset and the preset has already decided that
    // level (even "none"), the live state is overridden, so no conflict.
    if (slotted && has(working.links[holder.mainId], holder.level)) return null;
    return { scope: 'live', mainId: holder.mainId, level: holder.level, mainName: holder.mainName };
  }
  return null;
}

function openLinkChooser(mainInvId, level, info) {
  const show = () => {
    const { working, index } = editor;
    const otherLevel = level === '1' ? '2' : '1';
    const otherChosen = working.links[mainInvId] ? working.links[mainInvId][otherLevel] : null;

    const items = [];
    const seen = new Set();
    const push = (p) => {
      if (seen.has(p.invId) || p.invId === mainInvId || p.invId === otherChosen) return;
      seen.add(p.invId);
      const known = index && index.meta[p.invId];
      if (known && p.stars == null && (known.stars || known.level)) {
        p = Object.assign({}, p, { stars: known.stars, level: known.level });
      }

      // A pet in another slot of this preset is a main here and can't be a link.
      const slotId = SLOT_IDS.find((s) => working.slots[s] && working.slots[s].invId === p.invId);
      if (slotId) {
        items.push(Object.assign({}, p, {
          mainBlock: {
            label: 'Slot ' + slotId + ' of this preset',
            resolve: () => clearSlot(slotId),
            reopen: show,
          },
        }));
        return;
      }

      // Legendary / mythic pets can't be links (bar the exemptions).
      const rar = p.rarity ||
        (editor.pool[p.invId] && editor.pool[p.invId].rarity) ||
        (index && index.meta[p.invId] && index.meta[p.invId].rarity) || null;
      const barred = linkRarityBlock(p, rar);
      if (barred) {
        items.push(Object.assign({}, p, {
          blocked: barred.charAt(0).toUpperCase() + barred.slice(1) + ' pets can\'t be linked',
        }));
        return;
      }

      // Equipped on a team right now: still allowed. Apply takes it off that team.
      const equippedOn = editor.mains[p.invId];
      const liveTag = equippedOn
        ? 'Equipped on ' + equippedOn.join(', ') + ' now' + (CFG.TAKE_FROM_OTHER_TEAMS ? '' : ' — apply will skip it')
        : '';

      const conflict = findLinkConflict(p.invId, mainInvId, level);
      if (!conflict) {
        items.push(liveTag ? Object.assign({}, p, { tag: liveTag, warn: true }) : p);
        return;
      }

      if (conflict.scope === 'preset') {
        items.push(Object.assign({}, p, {
          conflict: {
            mainName: conflict.mainName,
            resolve: () => {
              working.links[conflict.mainId] = working.links[conflict.mainId] || {};
              working.links[conflict.mainId][conflict.level] = null;
              pruneOrphans(working);
              renderEditorGrid();
            },
            reopen: show,
          },
        }));
      } else {
        items.push(Object.assign({}, p, {
          tag: 'Linked to ' + conflict.mainName + ' now' +
               (CFG.AUTO_RELINK ? ' — moves on apply' : ' — apply will skip it') +
               (liveTag ? ' · ' + liveTag.replace(/^Equipped/, 'equipped') : ''),
          warn: true,
        }));
      }
    };

    info.candidates.forEach(push);
    LINK_LEVELS.forEach((lvl) => {
      const cur = info.links[lvl];
      if (cur) push(Object.assign({}, cur, { tag: lvl === level ? 'Linked here now' : 'On Link ' + lvl }));
    });
    if (index) Object.values(index.meta).forEach(push);
    Object.values(editor.pool || {}).forEach(push);

    openChooser({
      title: 'Link ' + level,
      items,
      showSigils: true,
      onPick: (chosen) => {
        working.links[mainInvId] = working.links[mainInvId] || {};
        working.links[mainInvId][level] = chosen.invId;
        working.meta.pets[chosen.invId] = { invId: chosen.invId, name: chosen.name, image: chosen.image };

        // If this pet was being kept in a cleared slot, it's used here now.
        Object.keys(editor.ghost).forEach((sid) => {
          const g = editor.ghost[sid];
          LINK_LEVELS.forEach((l) => { if (g[l] === chosen.invId) g[l] = null; });
          if (!LINK_LEVELS.some((l) => g[l])) delete editor.ghost[sid];
        });

        pruneOrphans(working);
        renderEditorGrid();
      },
    });
  };
  show();
}

  // ---- sigils, layered on the art ----

  function buildSigilLayer(invId) {
    const layer = document.createElement('div');
    layer.className = 'pp-sigil-layer';
    const { working } = editor;

    SIGIL_SLOTS.forEach((slotType) => {
      const entry = working.sigils[invId] || {};
      const value = has(entry, slotType) ? entry[slotType] : null;
      const state = editor.sigilInfo[invId + '|' + slotType];

      const chip = document.createElement('div');
      chip.className = 'pp-chip pp-chip-' + (slotType === 'attack' ? 'atk' : 'def') + (value ? '' : ' pp-chip-empty');

      const label = SIGIL_LABELS[slotType];
      if (state && state.loading) { chip.textContent = '…'; chip.title = 'Loading ' + label.toLowerCase(); }
      else if (value) {
        const known = working.meta.sigils[value] || (state && state.current && state.current.itemId === value ? state.current : null);
        if (known && known.image) {
          const img = document.createElement('img');
          img.src = known.image;
          chip.appendChild(img);
        } else chip.textContent = '✦';
        chip.title = label + ': ' + (known ? known.name : 'Sigil #' + value);
      } else {
        chip.textContent = slotType === 'attack' ? '⚔' : '🛡';
        chip.title = label + ': none';
      }

      if (value) {
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'pp-x';
        x.textContent = '×';
        x.title = 'Remove this sigil';
        x.addEventListener('click', (e) => {
          e.stopPropagation();
          working.sigils[invId] = working.sigils[invId] || {};
          working.sigils[invId][slotType] = null;
          renderEditorGrid();
        });
        chip.appendChild(x);
      }

      chip.addEventListener('click', (e) => { e.stopPropagation(); openSigilChooser(invId, slotType); });
      layer.appendChild(chip);
    });

    return layer;
  }

  async function openSigilChooser(invId, slotType) {
    const { working } = editor;

    openChooser({
      title: SIGIL_LABELS[slotType],
      loading: true,
    });

    let info;

    try {
      info = await fetchSigilInfo(invId, slotType, true);
    } catch (err) {
      closeModal('ppPickerModal');
      notify(err.message || 'Couldn\'t read sigils for this pet.', false);
      return;
    }

    editor.sigilInfo[invId + '|' + slotType] = info;

    /*
     * Read Melanippe's shop state while building the picker.
     * This lets every zero-owned card show the current balance
     * and the current purchase price BEFORE Buy is clicked.
     */
    let melanippeState = null;

    try {
      melanippeState = await fetchMelanippeStableState();
    } catch (_) {
      melanippeState = null;
    }

    const melanippeGold = Number(melanippeState?.gold || 0);

    const melanippeOffers =
          Array.isArray(melanippeState?.offers)
    ? melanippeState.offers
    : [];

    const items = [];
    const seen = new Set();

    const presetCur = (working.sigils[invId] || {})[slotType] || null;

    info.options.forEach((o) => {
      seen.add(o.itemId);

      const owned = Number(o.owned || 0);
      // "Free" means: owned, minus what the rest of this preset already uses.
      const isCurrent = presetCur === o.itemId;
      const free = owned - sigilDemand(o.itemId, invId, slotType);

      const normalize = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const shopOffer = melanippeOffers.find((offer) => normalize(offer.name) === normalize(o.name));
      const melanippeAvailable = !!(shopOffer && shopOffer.key);
      const melanippePrice = shopOffer ? Number(shopOffer.price || 0) : 0;

      if (free <= 0 && !isCurrent) {
        items.push({
          invId: o.itemId,
          name: o.name,
          image: o.image,
          tag: owned > 0 ? `All ${owned} used in this preset.` : 'You don\'t have any of these.',
          warn: true,
          buy: true,
          melanippeAvailable,
          melanippeGold,
          melanippePrice,
          onBuy: (btn) => { buySigilFromMelanippe(o.itemId, o.name, btn, invId, slotType); },
          onUnlink: owned > 0
            ? () => openUnlinkPicker(o.itemId, o.name, o.image, invId, slotType)
            : undefined,
        });
        return;
      }

      items.push({
        invId: o.itemId,
        name: o.name,
        image: o.image,
        tag: [sigilBonus(o), isCurrent ? 'chosen for this pet' : free + ' free'].join(' · '),
        warn: false,
      });
    });

    if (info.current && !seen.has(info.current.itemId)) {
      items.unshift({
        invId: info.current.itemId,
        name: info.current.name,
        image: info.current.image,
        tag: sigilBonus(info.current) + ' · on this pet',
      });
    }

    openChooser({
      title: info.slotLabel,
      items,

      onPick: (chosen) => {
        working.sigils[invId] = working.sigils[invId] || {};
        working.sigils[invId][slotType] = chosen.invId;

        working.meta.sigils[chosen.invId] = {
          itemId: chosen.invId,
          name: chosen.name,
          image: chosen.image,
        };

        renderEditorGrid();
      },
    });

  }

  /* ------------------------------ chooser ----------------------------- */
  function pickerSigilChip(slotType, info) {
    const chip = document.createElement('div');
    const item = info && info.current;
    chip.className = 'pp-picker-chip' + (item ? '' : ' pp-picker-chip-empty');
    if (item && item.image) {
      const img = document.createElement('img');
      img.src = item.image;
      img.alt = item.name;
      chip.appendChild(img);
    } else {
      chip.textContent = slotType === 'attack' ? '⚔' : '🛡';
    }
    chip.title = SIGIL_LABELS[slotType] + ': ' + (item ? item.name : 'none');
    return chip;
  }

  function openChooser({ title, items, onPick, loading, showSigils }) {
    document.getElementById('ppPickerTitle').textContent = title || 'Choose';
    const body = document.getElementById('ppPickerBody');
    body.innerHTML = '';

    if (loading) {
      body.innerHTML = '<div class="pp-empty-state">Loading…</div>';
      document.getElementById('ppPickerModal').classList.add('show');
      return;
    }

    if (!items || !items.length) {
      const empty = document.createElement('div');
      empty.className = 'pp-empty-state';
      empty.textContent = 'Nothing available to pick here.';
      body.appendChild(empty);
    } else {
      const grid = document.createElement('div');
      grid.className = 'pp-picker-grid';
      items.slice().sort((a, b) => String(a.name).localeCompare(String(b.name))).forEach((p) => {
        const card = document.createElement('div');
        card.className = 'pp-picker-card';

        const icon = document.createElement('div');
        icon.className = 'pp-picker-icon';
        if (p.image) {
          const img = document.createElement('img');
          img.src = p.image;
          icon.appendChild(img);
        } else icon.textContent = '🐾';
        if (p.stars > 0) {
          const badge = document.createElement('div');
          badge.className = 'pp-picker-badge';
          badge.textContent = '★'.repeat(p.stars);
          icon.appendChild(badge);
        }
        card.appendChild(icon);

        const nm = document.createElement('div');
        nm.className = 'pp-picker-name';
        nm.textContent = p.name;
        card.appendChild(nm);

        if (showSigils) {
          const chipRow = document.createElement('div');
          chipRow.className = 'pp-picker-sigil-row';
          icon.appendChild(chipRow);
          Promise.all([
            fetchSigilInfo(p.invId, 'attack').catch(() => null),
            fetchSigilInfo(p.invId, 'defense').catch(() => null),
          ]).then(([atk, def]) => {
            if (!chipRow.isConnected) return;
            chipRow.appendChild(pickerSigilChip('attack', atk));
            chipRow.appendChild(pickerSigilChip('defense', def));
          });
        }

        if (p.mainBlock) {
          card.classList.add('pp-picker-conflict');
          const tag = document.createElement('div');
          tag.className = 'pp-picker-tag warn';
          tag.textContent = 'Main pet (' + p.mainBlock.label + ') — unequip first';
          card.appendChild(tag);
          if (p.mainBlock.resolve) {
            const rmBtn = mkBtn('pp-btn-soft', 'Remove from slot', () => {
              p.mainBlock.resolve();
              p.mainBlock.reopen();
            });
            rmBtn.style.width = '100%';
            card.appendChild(rmBtn);
          }
        } else if (p.blocked) {
          card.classList.add('pp-picker-conflict');
          const tag = document.createElement('div');
          tag.className = 'pp-picker-tag warn';
          tag.textContent = p.blocked;
          card.appendChild(tag);
        } else if (p.conflict) {
          card.classList.add('pp-picker-conflict');
          const tag = document.createElement('div');
          tag.className = 'pp-picker-tag warn';
          tag.textContent = 'Linked to ' + p.conflict.mainName;
          card.appendChild(tag);

          const btn = mkBtn('pp-btn-soft', 'Unlink first', async () => {
            btn.disabled = true;
            btn.textContent = 'Unlinking…';
            try {
              await p.conflict.resolve();
              p.conflict.reopen();
            } catch (err) {
              notify(err.message || 'Could not unlink.', false);
              btn.disabled = false;
              btn.textContent = 'Unlink first';
            }
          });
          btn.style.width = '100%';
          card.appendChild(btn);
        } else {
          const tagText = p.tag;

          if (tagText) {
            const tag = document.createElement('div');
            tag.className =
              'pp-picker-tag' + (p.warn ? ' warn' : '');
            tag.textContent = tagText;
            card.appendChild(tag);
          }

          if (p.buy) {
            const money = document.createElement('div');
            money.className = 'pp-picker-tag';

            if (p.melanippeAvailable) {
              money.innerHTML =
                'Gold: <span style="color:#eef3ff;font-weight:800;">' +
                Number(p.melanippeGold || 0).toLocaleString() +
                '</span>' +
                ' · Cost: <span style="color:#f4d483;font-weight:800;">' +
                Number(p.melanippePrice || 0).toLocaleString() +
                ' Gold</span>';
            } else {
              money.textContent =
                'Melanippe does not currently sell this.';
            }

            card.appendChild(money);

            let btn;

            btn = mkBtn(
              'pp-btn pp-buy-action-btn',
              'Buy from Melanippe',
              () => p.onBuy(btn)
            );

            btn.disabled = !p.melanippeAvailable;

            card.appendChild(btn);

            if (p.onUnlink) {
              const unlinkBtn = mkBtn('pp-btn-soft pp-buy-action-btn', 'Unlink one', p.onUnlink);
              unlinkBtn.style.marginTop = '6px';
              card.appendChild(unlinkBtn);
            }
          } else {
            card.classList.add('pp-picker-clickable');
            card.addEventListener('click', () => {
              closeModal('ppPickerModal');
              onPick(p);
            });
          }
        }
        grid.appendChild(card);
      });
      body.appendChild(grid);
    }

    document.getElementById('ppPickerModal').classList.add('show');
  }

  async function openUnlinkPicker(itemId, itemName, itemImage, invId, slotType) {
    openChooser({ title: 'Remove ' + itemName, loading: true });

    const teamKey = isPetsPage() ? getUrlTeam() : 'attack';
    const holders = await findAllSigilHolders(itemId, itemName, invId, teamKey);

    // Pets in this preset that currently want this sigil, even if the live
    // game has it somewhere else.
    if (editor) {
      const { working } = editor;
      const have = new Set(holders.map((h) => h.invId + '|' + h.slotType));
      const active = new Set();
      SLOT_IDS.forEach((s) => {
        const p = working.slots[s];
        if (!p) return;
        active.add(String(p.invId));
        Object.values(working.links[p.invId] || {}).forEach((v) => { if (v) active.add(String(v)); });
      });
      active.forEach((id) => {
        const e = working.sigils[id];
        if (!e) return;
        SIGIL_SLOTS.forEach((st) => {
          if (e[st] !== String(itemId)) return;
          if (id === String(invId) && st === slotType) return;
          if (have.has(id + '|' + st)) return;
          const m = working.meta.pets[id] || editor.pool[id] || (editor.index && editor.index.meta[id]) || {};
          holders.push({ invId: id, slotType: st, name: m.name || ('Pet #' + id), image: m.image || '' });
        });
      });
    }

    if (!holders.length) {
      closeModal('ppPickerModal');
      notify(`Couldn't find which pet is wearing ${itemName}.`, false);
      return;
    }
    renderUnlinkList(itemId, itemName, itemImage, invId, slotType, holders);
  }

  // Purely virtual: picking a holder here never touches the live game. It
  // just records the choice in the working preset, same as any other pick.
  // Freeing an actual copy is left to sigilEquipPass/FORCE_SIGILS at Apply
  // time, which already knows how to take a copy off whoever holds it then.
  function renderUnlinkList(itemId, itemName, itemImage, invId, slotType, holders) {
    document.getElementById('ppPickerTitle').textContent = 'Remove ' + itemName;
    const body = document.getElementById('ppPickerBody');
    body.innerHTML = '';

    const { working } = editor;
    const grid = document.createElement('div');
    grid.className = 'pp-picker-grid';

    holders.forEach((h) => {
      const card = document.createElement('div');
      card.className = 'pp-picker-card pp-picker-clickable';

      // Does the preset itself already want this exact sigil to stay on h?
      // Only pets actually in the preset count (a slot's pet or one of its
      // links), not leftovers from a pet that was swapped out or unlinked.
      const activeIds = new Set();
      SLOT_IDS.forEach((s) => {
        const sp = working.slots[s];
        if (!sp) return;
        activeIds.add(String(sp.invId));
        Object.values(working.links[sp.invId] || {}).forEach((v) => { if (v) activeIds.add(String(v)); });
      });
      const holderWant = activeIds.has(String(h.invId)) ? working.sigils[h.invId] : null;
      const inPreset = !!(holderWant && holderWant[h.slotType] === itemId);
      if (inPreset) card.classList.add('pp-picker-conflict');

      card.title = inPreset
        ? `${itemName} is also wanted on ${h.name} in this preset`
      : 'Use this sigil (taken from ' + h.name + ' when applied)';

      const icon = document.createElement('div');
      icon.className = 'pp-picker-icon';
      if (h.image) {
        const img = document.createElement('img');
        img.src = h.image;
        icon.appendChild(img);
      } else {
        icon.textContent = '🐾';
      }
      card.appendChild(icon);

      const nm = document.createElement('div');
      nm.className = 'pp-picker-name';
      nm.textContent = h.name;
      card.appendChild(nm);

      const tag = document.createElement('div');
      tag.className = 'pp-picker-tag' + (inPreset ? ' warn' : '');
      tag.textContent = inPreset ? 'Also wanted here in this preset' : SIGIL_LABELS[h.slotType];
      card.appendChild(tag);

      card.addEventListener('click', () => {
        if (inPreset) {
          const ok = confirm(
            `${h.name} is set to keep ${itemName} in this preset.\n\n` +
            `Taking it for this slot will clear ${h.name}'s ${SIGIL_LABELS[h.slotType]} in this preset too.\n\n` +
            `Continue?`
          );
          if (!ok) return;
          working.sigils[h.invId][h.slotType] = null;
        }

        working.sigils[invId] = working.sigils[invId] || {};
        working.sigils[invId][slotType] = itemId;
        working.meta.sigils[itemId] = { itemId, name: itemName, image: itemImage };

        closeModal('ppPickerModal');
        renderEditorGrid();
        notify(
          inPreset
          ? `${itemName} moved here from ${h.name} in this preset.`
          : `${itemName} chosen — it'll be taken from ${h.name} if still in use when you apply this preset.`,
          true
        );
      });

      grid.appendChild(card);
    });

    body.appendChild(grid);
    document.getElementById('ppPickerModal').classList.add('show');
  }

  /* --------------------------- apply / capture ------------------------ */

  function openApplyModal(preset) {
    activeApplyPreset = preset;
    document.getElementById('ppApplyTitle').textContent = `Apply "${preset.name}" to:`;
    document.getElementById('ppApplyModal').classList.add('show');
  }
  async function onApplyTarget(targetTeam, btn) {
    if (!activeApplyPreset) return;
    const preset = activeApplyPreset;
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Applying…';
    closeModal('ppApplyModal');
    await restorePresetToTeam(preset, targetTeam);
    btn.disabled = false;
    btn.textContent = original;
    activeApplyPreset = null;
    renderPresetList();
  }

  /* ------------------------------ build UI ---------------------------- */

  let ppPanel = null, ppHome = null;

  function buildUI() {
    injectPresetStyles();

    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="pp-modal" id="ppModal">
        <div class="pp-modal-card">
          <div class="pp-modal-head">
            <h3 class="pp-modal-title">Pet Team Presets</h3>
            <button type="button" class="pp-close-btn" data-pp-close="ppModal">&times;</button>
          </div>
          <div id="ppList"></div>
          <div class="pp-footer">
            <button type="button" class="pp-btn pp-btn-soft" id="ppNewBlank">+ New preset</button>
            <button type="button" class="pp-btn pp-btn-success" id="ppCaptureBtn">Capture current team</button>
          </div>
        </div>
      </div>

      <div class="pp-modal" id="ppCaptureModal">
        <div class="pp-modal-card" style="max-width:420px;">
          <div class="pp-modal-head">
            <h3 class="pp-modal-title">Capture a team</h3>
            <button type="button" class="pp-close-btn" data-pp-close="ppCaptureModal">&times;</button>
          </div>
          <div class="pp-set-choice">
            <button type="button" class="pp-btn" data-capture-team="attack">PvE Attack</button>
            <button type="button" class="pp-btn" data-capture-team="pvp_attack">PvP Attack</button>
            <button type="button" class="pp-btn" data-capture-team="defense">PvP Defense</button>
          </div>
          <div class="pp-footer">
            <div style="flex:1 1 auto;"></div>
            <button type="button" class="pp-btn pp-btn-soft" data-pp-close="ppCaptureModal">Cancel</button>
          </div>
        </div>
      </div>

      <div class="pp-modal" id="ppApplyModal">
        <div class="pp-modal-card" style="max-width:420px;">
          <div class="pp-modal-head">
            <h3 class="pp-modal-title" id="ppApplyTitle">Apply preset to:</h3>
            <button type="button" class="pp-close-btn" data-pp-close="ppApplyModal">&times;</button>
          </div>
          <div class="pp-set-choice">
            <button type="button" class="pp-btn" data-apply-team="attack">PvE Attack</button>
            <button type="button" class="pp-btn" data-apply-team="pvp_attack">PvP Attack</button>
            <button type="button" class="pp-btn" data-apply-team="defense">PvP Defense</button>
          </div>
          <div class="pp-footer">
            <div style="flex:1 1 auto;"></div>
            <button type="button" class="pp-btn pp-btn-soft" data-pp-close="ppApplyModal">Cancel</button>
          </div>
        </div>
      </div>

      <div class="pp-modal" id="ppEditorModal">
        <div class="pp-modal-card" style="max-width:840px;">
          <div class="pp-modal-head">
            <h3 class="pp-modal-title">Edit preset — <span id="ppEditorName"></span></h3>
            <button type="button" class="pp-close-btn" data-pp-close="ppEditorModal">&times;</button>
          </div>
          <div id="ppEditorGrid" class="pp-editor-grid"></div>
          <div class="pp-footer">
            <div style="flex:1 1 auto;"></div>
            <button type="button" class="pp-btn pp-btn-soft" data-pp-close="ppEditorModal">Cancel</button>
            <button type="button" class="pp-btn pp-btn-success" id="ppEditorSave">Save preset</button>
          </div>
        </div>
      </div>

      <div class="pp-modal" id="ppPickerModal">
        <div class="pp-modal-card">
          <div class="pp-modal-head">
            <h3 class="pp-modal-title" id="ppPickerTitle">Choose</h3>
            <button type="button" class="pp-close-btn" data-pp-close="ppPickerModal">&times;</button>
          </div>
          <div id="ppPickerBody"></div>
          <div class="pp-footer">
            <div style="flex:1 1 auto;"></div>
            <button type="button" class="pp-btn pp-btn-soft" data-pp-close="ppPickerModal">Cancel</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(wrap);

    // The main presets panel is shown by Core's floating-button system (the 🐾 button) instead of
    // its own modal. It's built here, parked in a hidden holder so getElementById() keeps
    // working, and moved into Core's panel when the button is clicked.
    const mainModal = wrap.querySelector('#ppModal');
    ppPanel = document.createElement('div');
    ppPanel.id = 'ppPanel';
    mainModal.querySelectorAll('.pp-modal-card > :not(.pp-modal-head)').forEach((n) => ppPanel.appendChild(n));
    mainModal.remove();
    ppHome = document.createElement('div');
    ppHome.style.display = 'none';
    ppHome.appendChild(ppPanel);
    document.body.appendChild(ppHome);

    document.body.addEventListener('click', (e) => {
      const closeBtn = e.target.closest('[data-pp-close]');
      if (closeBtn) closeModal(closeBtn.getAttribute('data-pp-close'));
      if (!e.target.closest('.pp-menu-dropdown') && !e.target.closest('.pp-menu-btn')) {
        document.getElementById('ppSharedMenu')?.classList.remove('open');
        menuMountedFor = null;
      }
      const captureBtn = e.target.closest('[data-capture-team]');
      if (captureBtn) {
        closeModal('ppCaptureModal');
        captureCurrentToPreset(captureBtn.getAttribute('data-capture-team'));
      }
      const applyBtn = e.target.closest('[data-apply-team]');
      if (applyBtn) onApplyTarget(applyBtn.getAttribute('data-apply-team'), applyBtn);
    });

    ['ppCaptureModal', 'ppApplyModal', 'ppEditorModal', 'ppPickerModal'].forEach((id) => {
      document.getElementById(id).addEventListener('click', (e) => {
        if (e.target.id === id) closeModal(id);
      });
    });

    document.getElementById('ppCaptureBtn').addEventListener('click', () => {
      document.getElementById('ppCaptureModal').classList.add('show');
    });
    document.getElementById('ppNewBlank').addEventListener('click', () => {
      const name = prompt('Name this preset:', `Preset ${loadPresets().length + 1}`);
      if (name == null) return;
      openEditor({
        id: makePresetId(),
        version: 3,
        name: name.trim() || 'Untitled preset',
        slots: { '1': null, '2': null, '3': null },
        links: {},
        sigils: {},
        meta: blankMeta(),
        updatedAt: Date.now(),
      });
    });
  }

  function refreshAfterNativeLinkAction() {
    [400, 1000].forEach((delay) => {
      setTimeout(() => {
        dropLinkCache();
        dropLinkIndex();
        scheduleAugment();
      }, delay);
    });
  }

  //It now remembers every team a pet is on and takes it off all of them.
//Fix 2: If the game still says "currently equipped" when linking, the script re-reads all three teams, takes the pet off wherever it is, and retries once. Both steps show in the toast, and the retry is marked "again".

  /* =======================================================================
   * Boot
   * ===================================================================== */

  buildUI();

  // Register the floating 🐾 button + panel with Core.
  Core.float.add({
    id: 'pet-presets', title: 'Pet Presets', icon: '🐾', order: 30,
    render(el) { el.replaceChildren(ppPanel); },
    onShow() { renderPresetList(); },
    onHide() { if (ppHome && ppPanel) ppHome.appendChild(ppPanel); },
  });

  if (isPetsPage()) {
    installSigilOverride();
    injectNativeStyles();
    watchInventoryVisibility();
    scheduleAugment();

    document.addEventListener('click', (e) => {
      if (e.target.closest?.('#linksModalBody button')) {
        refreshAfterNativeLinkAction();
      }
    }, true);

    new MutationObserver((records) => {
      const touched = records.some((r) => Array.from(r.addedNodes).some((n) =>
                                                                        n.nodeType === 1 &&
                                                                        !n.closest?.('.pp-orb-row, .pp-badge-overlay, .pp-modal') &&
                                                                        (n.matches?.('.pet-card, .section') || n.querySelector?.('.pet-card'))));
      if (touched) scheduleAugment();
    }).observe(document.body, { childList: true, subtree: true });
  }
})();