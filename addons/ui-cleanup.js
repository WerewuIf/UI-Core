/* UI Cleanup — Core addon (migrated from the standalone userscript).
 * Loaded by core.user.js; `Core` is in scope. No @require / header needed.
 * Cookie helper + 3 toast copies removed (Core.cookies / Core.ui.toast); quest/battle-pass/PvP polls share Core.net cache.
 * Page scoping now lives in addons.json ("match"); the old @match list is mirrored there.
 */

/* =====================================================================
   MERGE NOTES (v2.0)
   ---------------------------------------------------------------------
   This file folds the standalone "Reminders Tracker" script (the one
   that used to @match game_dash.php on its own and draw a floating
   bottom-right box) directly into MODULE 4 below. What changed:

   - The floating widget is gone. Its four data sources — wave bosses,
     Adventurer's Guild quests, PvP tokens, and Guild Dungeon bosses —
     are now fetched in the background and surfaced as a small count
     badge directly on the matching dashboard tile: Gates, Adventurer's
     Guild, Guild, and Live PvP.
   - Hovering a tile (desktop/mouse) or tapping it once (touch — the
     first tap previews instead of navigating, the second tap goes
     through) opens a small panel under the tile listing the live
     detail for that category. Each row is a direct link to the
     relevant page — or, for a spawned single-boss Guild Dungeon
     target, straight to the fight itself (battle.php?dgmid=...&
     instance_id=...), the same "direct link" resolution Module 2
     already does for the dungeon map's boss pins.
   - Quest parsing was rewritten against the quest board's actual row
     markup (.quest-row / .quest-main-title / .quest-side .quest-reward
     / .quest-cooldown-box .quest-cooldown-timer[data-cooldown-ts] /
     .quest-status-note) instead of the old banner-pill text guessing.
     The previous "available quests" badge relied on that guesswork,
     which is the more likely reason it was reading 0 / not updating.
   - Tracker on/off toggles and the damage-display toggle persist under
     the same localStorage key the old widget used ('verya_reminders'),
     so any existing saved preferences carry over. They're edited from
     a small ⚙ button next to the dashboard title now, instead of the
     widget's old Settings button.
   - Modules 1–3 (guild dashboard, dungeon map/list, battle back-button)
     are untouched.
   ===================================================================== */

/* Cross-tab-safe monster-cookie helper: now provided by Core (Core.cookies.withMode).
   window.__gsCookies is still defined by the core for any old script that checks it. */

/* =====================================================================
   MODULE 1: Guild Dashboard Cleanup
   Runs only on guild_dash.php — everything below is scoped in its own
   closure and no-ops immediately if the path doesn't match.
   ===================================================================== */
(function () {
  'use strict';
  if (!/\/guild_dash\.php/.test(location.pathname)) return;

  let dashInitialScrollDone = false;
  function applyInitialScroll() {
    if (dashInitialScrollDone) return;
    const header = document.querySelector('.gd-header-panel');
    const announce = document.querySelector('.gd-announce-slim');
    if (!header || !announce) return; // not built yet — next run() will retry
    dashInitialScrollDone = true;

    const doScroll = () => {
      // Account for the pinned .game-topbar so the announcement doesn't
      // end up tucked underneath it.
      const topbar = document.querySelector('.game-topbar');
      const topbarHeight = topbar ? topbar.getBoundingClientRect().height : 0;
      const target = header.getBoundingClientRect().bottom + window.scrollY + 8 - topbarHeight;
      window.scrollTo({ top: Math.max(0, target), behavior: 'instant' });
    };
    requestAnimationFrame(() => requestAnimationFrame(doScroll));
    setTimeout(doScroll, 400);
  }

  // ---------- helpers ----------

  function findPanelByHeading(text) {
    return Array.from(document.querySelectorAll('.panel')).find(p => {
      const h = p.querySelector('.title');
      return h && h.textContent.trim() === text;
    });
  }

  // Inline style attributes beat external CSS regardless of specificity
  // (short of !important), so anything we're about to resize/reflow via
  // our stylesheet needs its old inline style cleared first.
  function clearInlineStyle(el) {
    if (el) el.removeAttribute('style');
  }

  function formatNumber(str) {
    const n = parseInt(String(str).replace(/,/g, ''), 10);
    return isNaN(n) ? str : n.toLocaleString();
  }


  // ---------- styles ----------

  function injectStyles() {
    if (document.getElementById('gd-cleanup-styles')) return;
    const style = document.createElement('style');
    style.id = 'gd-cleanup-styles';
    style.textContent = `
      /* --- hero: banner + floating back button, replaces the stacked back+banner --- */
      .gd-hero { position: relative; border-radius: 12px; overflow: hidden; margin-bottom: 12px; }
      .gd-hero img.gd-banner { width: 100%; max-height: 150px; object-fit: cover; display: block; }
      .gd-hero .gd-back {
        position: absolute; top: 10px; left: 10px; z-index: 2;
        padding: 6px 12px !important; font-size: 13px !important;
        background: rgba(15,17,26,0.75) !important; backdrop-filter: blur(4px);
      }

      /* --- header panel tightened --- */
      .gd-header-panel { padding: 12px 14px !important; }
      .gd-header-panel img[alt="Guild Emblem"] { width: 72px !important; height: 72px !important; }
      .gd-header-panel h1.title { font-size: 18px !important; }

      /* --- generic pill/chip, reused across header meta, treasury, buildings --- */
      .gd-chip {
        display: inline-flex; align-items: center; gap: 4px;
        background: #171923; border: 1px solid #2B2D44; border-radius: 999px;
        padding: 3px 10px; font-size: 12px; color: #cdd4ff; white-space: nowrap;
      }
      .gd-chip strong { color: #EDEFF6; font-weight: 700; font-variant-numeric: tabular-nums; }
      .gd-meta-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
      .gd-meta-row .gd-chip { font-size: 11px; }

      /* --- announcement: slim single line, tap/click to expand full text --- */
      .gd-announce-slim {
        display: flex; align-items: center; gap: 8px;
        padding: 8px 12px !important; cursor: pointer;
      }
      .gd-announce-slim .gd-a-text {
        flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        font-size: 13px;
      }
      .gd-announce-slim a { color: #8aa2ff; }

      /* --- announcement: tap-to-expand affordance + expanded state ---
         The title-attribute tooltip only reaches long text on desktop
         hover — touch devices have no hover state, so a long announcement
         would otherwise be unreachable past the ellipsis on mobile. This
         lets the whole bar toggle between truncated and full wrapped text. */
      .gd-announce-slim .gd-a-toggle {
        flex: 0 0 auto; font-size: 10px; color: #8a90ad; padding-left: 2px;
      }
      .gd-announce-slim.gd-announce-expanded {
        align-items: flex-start;
      }
      .gd-announce-slim.gd-announce-expanded .gd-a-text {
        white-space: normal; overflow: visible; text-overflow: clip; line-height: 1.4;
      }

      /* --- treasury: fixed-width grid instead of flex-wrap, so chips line
         up into real columns/rows rather than packing to content-width
         and breaking wherever they happen to fit. Values right-aligned
         within each chip via space-between. --- */
      .gd-resource-row {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
        gap: 8px; margin: 8px 0;
      }
      .gd-resource-row .gd-chip {
        width: 100%; box-sizing: border-box;
        justify-content: space-between;
      }

      /* --- treasury footer: your balances + donate/ledger, folded into the same compact look --- */
      .gd-treasury-footer {
        display: flex; align-items: center; flex-wrap: wrap; gap: 8px;
        margin-top: 10px; padding-top: 10px; border-top: 1px dashed #2B2D44;
      }
      .gd-treasury-footer .gd-chip { font-size: 11px; }
      .gd-treasury-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-left: auto; }
      .gd-treasury-actions .btn { padding: 5px 10px !important; font-size: 12px !important; margin-bottom: 0 !important; }

      /* --- buildings: same fixed-width grid as treasury. Each item keeps
         its full chip box (flex row: name / level pill / Enter button)
         so a name long enough to want to wrap (e.g. "Guild Center
         (Center)") ellipsizes instead of pushing the button onto its own
         line — min-width:0 on both the item and the name span is what
         lets the name actually shrink; flex items default to
         min-width:auto, which refuses to shrink below content size. --- */
      .gd-building-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
        gap: 8px; margin-top: 8px;
      }
      .gd-building-item {
        display: flex; align-items: center; gap: 8px;
        background: #171923; border: 1px solid #2B2D44; border-radius: 10px;
        padding: 6px 10px; font-size: 13px;
        justify-content: space-between;
        flex-wrap: nowrap;
        min-width: 0;
      }
      .gd-building-item .name {
        flex: 1 1 auto; min-width: 0;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .gd-building-item .lvl {
        flex: 0 0 auto;
        font-size: 11px; color: #8aa2ff; background: #12141f; border: 1px solid #2B2D44;
        border-radius: 999px; padding: 1px 7px;
      }
      .gd-building-item .btn { flex: 0 0 auto; margin-left: auto; padding: 4px 10px !important; font-size: 12px !important; }

      /* --- open dungeons: slim rows + link to the full history page --- */
      .gd-dungeon-toolbar { display: flex; justify-content: flex-end; margin-bottom: 8px; }
      .gd-dungeon-toolbar .btn { padding: 5px 10px !important; font-size: 12px !important; }
      .gd-dungeon-list { display: flex; flex-direction: column; gap: 6px; }
      .gd-dungeon-row {
        display: flex; align-items: center; gap: 10px;
        background: #171923; border: 1px solid #2B2D44; border-radius: 10px;
        padding: 6px 10px;
      }
      .gd-dungeon-row img {
        width: 40px; height: 40px; object-fit: cover; border-radius: 8px;
        border: 1px solid #2B2D44; flex-shrink: 0;
      }
      .gd-dungeon-row .body { flex: 1; min-width: 0; }
      .gd-dungeon-row .name { font-weight: 700; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .gd-dungeon-row .meta { font-size: 11px; color: #8a90ad; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .gd-dungeon-row .actions { display: flex; gap: 6px; flex-shrink: 0; }
      .gd-dungeon-row .actions .btn { padding: 5px 10px !important; font-size: 12px !important; }
      .gd-dungeon-empty { font-size: 13px; color: #8a90ad; padding: 10px 0; }

      /* --- chat feed tightened --- */
      #guildChatPreview .msg { padding: 4px 0 !important; gap: 8px !important; display: flex; }
      #guildChatPreview .avatar { width: 26px !important; height: 26px !important; flex: 0 0 26px !important; border-radius: 6px; }
      #guildChatPreview .u { font-size: 12px !important; }
      #guildChatPreview .t { font-size: 10px !important; opacity: .6; margin-left: 6px; }
      #guildChatPreview .text { font-size: 12px !important; line-height: 1.35; }

      /* --- general row breathing room --- */
      .wrap > .row { gap: 12px !important; }
    `;
    document.head.appendChild(style);
  }

  // ---------- hero: back button + banner merged, header tightened ----------

  function buildHero() {
    if (document.getElementById('gd-hero')) return;

    const backBtn = document.querySelector('.wrap > a.btn[href="game_dash.php"]');
    const bannerImg = document.querySelector('.wrap img[alt="Guild Banner"]');
    const bannerPanel = bannerImg?.closest('.panel');
    if (!backBtn || !bannerImg || !bannerPanel) return;

    const hero = document.createElement('div');
    hero.id = 'gd-hero';
    hero.className = 'gd-hero';

    // The banner ships with an inline max-height:220px which would otherwise
    // silently win over our 150px rule since inline styles beat stylesheet rules.
    clearInlineStyle(bannerImg);
    bannerImg.classList.add('gd-banner');
    backBtn.classList.add('gd-back');

    bannerPanel.before(hero);
    hero.appendChild(bannerImg);
    hero.appendChild(backBtn);
    bannerPanel.remove();

    const headerPanel = Array.from(document.querySelectorAll('.wrap > .panel'))
    .find(p => p.querySelector('h1.title'));
    if (headerPanel) {
      headerPanel.classList.add('gd-header-panel');
      condenseMetaLine(headerPanel);
    }
  }

  // "Role: X • Leader: Y • Members: Z • Guild Level: W" -> pill chips
  function condenseMetaLine(headerPanel) {
    const metaDiv = headerPanel.querySelector('.muted');
    if (!metaDiv) return;

    const parts = metaDiv.innerHTML.split('•').map(s => s.trim()).filter(Boolean);
    const row = document.createElement('div');
    row.className = 'gd-meta-row';

    parts.forEach(html => {
      const chip = document.createElement('span');
      chip.className = 'gd-chip';
      chip.innerHTML = html;
      row.appendChild(chip);
    });

    metaDiv.replaceWith(row);
  }

  // ---------- announcement ----------

  function slimAnnouncement() {
    const panel = document.querySelector('.panel[style*="161824"]');
    if (!panel || panel.classList.contains('gd-announce-slim')) return;

    const textDiv = panel.querySelector('div[style*="font-size:15px"]');
    if (!textDiv) return;

    const raw = textDiv.textContent.replace(/\s+/g, ' ').trim();
    panel.classList.add('gd-announce-slim');
    panel.title = raw;
    panel.innerHTML = '';

    const icon = document.createElement('span');
    icon.textContent = '📣';

    const textSpan = document.createElement('span');
    textSpan.className = 'gd-a-text';

    // linkify a leading URL so it stays clickable even though the line is truncated
    const urlMatch = raw.match(/https?:\/\/\S+/);
    if (urlMatch) {
      const before = raw.slice(0, urlMatch.index);
      const after = raw.slice(urlMatch.index + urlMatch[0].length);
      const a = document.createElement('a');
      a.href = urlMatch[0];
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = urlMatch[0];
      textSpan.append(before, a, after);
    } else {
      textSpan.textContent = raw;
    }

    const toggle = document.createElement('span');
    toggle.className = 'gd-a-toggle';
    toggle.textContent = '▾';
    toggle.title = 'Show full announcement';

    panel.append(icon, textSpan, toggle);

    // Clicking/tapping anywhere on the bar (except the linkified URL, which
    // should navigate instead) toggles between the truncated one-liner and
    // full wrapped text, so long announcements stay reachable on touch
    // devices that have no hover state for the title-attribute tooltip.
    panel.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      const expanded = panel.classList.toggle('gd-announce-expanded');
      toggle.textContent = expanded ? '▴' : '▾';
      toggle.title = expanded ? 'Collapse' : 'Show full announcement';
    });
  }

  // ---------- treasury ----------

  const RESOURCE_ICONS = {
    'gold': '🪙', 'gems': '💎', 'food': '🍞', 'wood': '🌲',
    'stone': '🪨', 'iron': '⛏️', 'arcane crystals': '🔮'
  };

  function condenseTreasury() {
    const panel = findPanelByHeading('Treasury');
    const grid = panel?.querySelector('.grid2');
    if (!grid) return;

    const row = document.createElement('div');
    row.className = 'gd-resource-row';

    grid.querySelectorAll('.res').forEach(res => {
      const [nameEl, valueEl] = res.querySelectorAll('div');
      const name = nameEl?.textContent.trim() || '';
      const value = valueEl?.textContent.trim() || '';
      const icon = RESOURCE_ICONS[name.toLowerCase()] || '📦';
      const chip = document.createElement('span');
      chip.className = 'gd-chip';
      chip.innerHTML = `${icon} ${name}: <strong>${value}</strong>`;
      row.appendChild(chip);
    });

    grid.replaceWith(row);
    condenseTreasuryFooter(panel);
  }

  // "Your balances — Gold: X • Gems: Y" + Donate/Ledger buttons -> a slim
  // chip + button row underneath the resource chips. Labelled "Your Gold" /
  // "Your Gems" (rather than reusing "Gold"/"Gems") since those labels would
  // otherwise be indistinguishable from the guild treasury chips right above.
  function condenseTreasuryFooter(panel) {
    if (!panel || panel.querySelector('.gd-treasury-footer')) return;

    const balances = Array.from(panel.querySelectorAll(':scope > .muted'))
    .find(m => /your balances/i.test(m.textContent));
    if (!balances) return;

    const actionsRow = balances.nextElementSibling;
    const footer = document.createElement('div');
    footer.className = 'gd-treasury-footer';

    const labels = ['🪙 Your Gold', '💎 Your Gems'];
    balances.querySelectorAll('strong').forEach((s, i) => {
      const chip = document.createElement('span');
      chip.className = 'gd-chip';
      chip.innerHTML = `${labels[i] || '•'}: <strong>${formatNumber(s.textContent.trim())}</strong>`;
      footer.appendChild(chip);
    });

    if (actionsRow && actionsRow.querySelector('a.btn')) {
      actionsRow.classList.add('gd-treasury-actions');
      footer.appendChild(actionsRow);
    }

    balances.replaceWith(footer);
  }

  // ---------- buildings ----------

  function condenseBuildings() {
    const panel = findPanelByHeading('Buildings');
    const table = panel?.querySelector('table');
    if (!table) return;

    const grid = document.createElement('div');
    grid.className = 'gd-building-grid';

    table.querySelectorAll('tbody tr').forEach(tr => {
      const cells = tr.querySelectorAll('td');
      const name = cells[0]?.textContent.trim();
      const level = cells[1]?.textContent.trim();
      const link = cells[2]?.querySelector('a.btn');
      if (!name || !link) return;

      const item = document.createElement('div');
      item.className = 'gd-building-item';
      item.innerHTML = `<span class="name" title="${name}">${name}</span><span class="lvl">Lv ${level}</span>`;
      item.appendChild(link);
      grid.appendChild(item);
    });

    table.replaceWith(grid);
  }

  // ---------- open dungeons ----------
  // This page only ever has data for currently-open dungeons — history lives on
  // guild_dungeon.php (handled by the dungeon-cleanup module below), so instead
  // of pretending to show history here, we link straight to it.

  function condenseDungeons() {
    const panel = findPanelByHeading('Open Dungeons');
    const cardsRow = panel?.querySelector(':scope > .row');
    if (!cardsRow) return;

    if (!panel.querySelector('.gd-dungeon-toolbar')) {
      const toolbar = document.createElement('div');
      toolbar.className = 'gd-dungeon-toolbar';
      toolbar.innerHTML = `<a class="btn" href="guild_dungeon.php">📜 View Dungeon History</a>`;
      panel.querySelector('h2.title').after(toolbar);
    }

    const cards = Array.from(cardsRow.children);
    const list = document.createElement('div');
    list.className = 'gd-dungeon-list';

    if (!cards.length) {
      const empty = document.createElement('div');
      empty.className = 'gd-dungeon-empty';
      empty.textContent = 'No dungeons currently open.';
      list.appendChild(empty);
    }

    cards.forEach(card => {
      const img = card.querySelector('img');
      const name = card.querySelector('div[style*="font-weight:700"]')?.textContent.trim();
      const meta = card.querySelector('.muted')?.textContent.trim();
      const links = card.querySelectorAll('a.btn');
      if (!img || !name) return;

      // The card image ships with an inline width:100%/aspect-ratio:1/1 which
      // would otherwise override our 40x40 thumbnail sizing (inline beats
      // stylesheet rules), leaving a giant squished image in the slim row.
      clearInlineStyle(img);

      const row = document.createElement('div');
      row.className = 'gd-dungeon-row';

      const body = document.createElement('div');
      body.className = 'body';
      body.innerHTML = `<div class="name">${name}</div><div class="meta">${meta || ''}</div>`;

      const actions = document.createElement('div');
      actions.className = 'actions';
      links.forEach(a => actions.appendChild(a));

      row.append(img, body, actions);
      list.appendChild(row);
    });

    cardsRow.replaceWith(list);
  }

  // ---------- dispatch ----------

  function run() {
    injectStyles();
    buildHero();
    slimAnnouncement();
    condenseTreasury();
    condenseBuildings();
    condenseDungeons();
    applyInitialScroll();
  }

  let rerunTimer = null;
  function scheduleRun() {
    clearTimeout(rerunTimer);
    rerunTimer = setTimeout(run, 50);
  }
  const observer = new MutationObserver(scheduleRun);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), 20000);

  run();
})();


/* =====================================================================
   MODULE 2: Dungeon Map + Location + List Cleanup
   Runs on guild_dungeon.php, guild_dungeon_instance.php, and
   guild_dungeon_location.php — scoped in its own closure, dispatches
   internally based on which of those three page types it detects.
   ===================================================================== */
(function () {
  'use strict';

  const PIN_SIZE_PERCENT = 15;

  // Two independent toggles, both persisted in localStorage:
  //  - DIRECT_LINK: whether a single-boss pin's href points straight at the
  //    fight instead of the location page. This only controls where
  //    clicking the pin takes you — the boss name/damage label on the pin
  //    renders either way, since that's purely informational.
  //  - BACK_SKIP: whether leaving a single-boss fight (battle.php, handled
  //    in Module 3 below) sends you straight back to the instance map
  //    instead of the location page. Deliberately independent of
  //    DIRECT_LINK — e.g. you can leave pins pointing at the location page
  //    (DIRECT_LINK off) but still skip it on the way back (BACK_SKIP on),
  //    or any other combination of the two.
  const DIRECT_LINK_STORAGE_KEY = 'dungeonMapDirectBossLinksEnabled';
  const BACK_SKIP_STORAGE_KEY = 'dungeonBattleSkipsLocationOnBackEnabled';

  function isToggleEnabled(key, defaultOn) {
    const stored = localStorage.getItem(key);
    return stored === null ? defaultOn : stored === '1';
  }
  function setToggleEnabled(key, enabled) {
    localStorage.setItem(key, enabled ? '1' : '0');
  }
  function isDirectLinkEnabled() { return isToggleEnabled(DIRECT_LINK_STORAGE_KEY, true); }

  // Reloading on toggle keeps this simple and reliable: upgrading a pin
  // touches its href, image, and label (plus an async damage fetch), and
  // unwinding all of that cleanly in place isn't worth it when a reload
  // gives a guaranteed-correct state either way.
  function buildToggle(storageKey, defaultOn, label, title) {
    const wrap = document.createElement('label');
    wrap.className = 'map-toggle';
    wrap.title = title;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = isToggleEnabled(storageKey, defaultOn);
    checkbox.addEventListener('change', () => {
      setToggleEnabled(storageKey, checkbox.checked);
      location.reload();
    });

    const text = document.createElement('span');
    text.textContent = label;

    wrap.appendChild(checkbox);
    wrap.appendChild(text);
    return wrap;
  }

  // ---------- shared helpers ----------

  function readBossName(monBlock) {
    const nameContainer = monBlock.querySelector('div[style*="font-weight:700"]');
    if (!nameContainer) return '';

    const clone = nameContainer.cloneNode(true);

    // Remove every pill
    clone.querySelectorAll('.pill').forEach(el => el.remove());

    return clone.textContent.trim();
  }

  // Fetches the boss's own battle.php page once and pulls out everything
  // the pin needs: current damage, whether loot is still claimable, and
  // the player's own user id (battle.php inlines `const USER_ID = N;`,
  // same value the page's own Loot button POSTs).
  async function readFightPageInfo(fightHref) {
    try {
      const res = await fetch(fightHref, { credentials: 'same-origin' });
      if (!res.ok) return { damageText: null, needsLoot: false, userId: null };
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');

      const dmgEl = doc.querySelector('#yourDamageValue');
      const damageText = dmgEl ? dmgEl.textContent.trim() : null;

      // battle.php only renders #loot-button when the monster is dead AND
      // this player hasn't claimed loot yet — otherwise it shows the
      // "✅ You already claimed your loot." note instead. Same check the
      // page's own script uses (`document.getElementById('loot-button')`).
      const needsLoot = !!doc.getElementById('loot-button');

      const userIdMatch = html.match(/const USER_ID = (\d+);/);
      const userId = userIdMatch ? userIdMatch[1] : null;

      return { damageText, needsLoot, userId };
    } catch (err) {
      console.warn('[dungeon-map] could not read fight page info for', fightHref, err);
      return { damageText: null, needsLoot: false, userId: null };
    }
  }

  function showMapToast(msg, type) { Core.ui.toast(msg, type !== 'error', 3000); }

  // Adds a small 🎁 button to the corner of a pin that POSTs straight to
  // dungeon_loot.php — the same request battle.php's own Loot button
  // sends — so you can claim loot without leaving the map.
  function renderLootStatus(pin, { isDead, needsLoot, dgmid, instanceId, userId }) {
    const label = pin.querySelector('.label');
    if (!label) return;

    const existing = label.querySelector('.boss-label-loot-btn');
    if (existing) existing.remove();

    if (!isDead) return; // alive — no loot button at all

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'boss-label-loot-btn';

    if (needsLoot && dgmid && instanceId) {
      btn.classList.add('boss-label-loot-claim');
      btn.textContent = '🎁 Claim';
      btn.title = 'Claim loot';
      btn.dataset.dgmid = dgmid;
      btn.dataset.instanceId = instanceId;
      if (userId) btn.dataset.userId = userId;

      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (btn.classList.contains('boss-label-loot-loading') || btn.classList.contains('boss-label-loot-done')) return;
        btn.classList.add('boss-label-loot-loading');
        btn.textContent = '...';

        const body = new URLSearchParams();
        body.set('instance_id', btn.dataset.instanceId);
        body.set('dgmid', btn.dataset.dgmid);
        if (btn.dataset.userId) body.set('user_id', btn.dataset.userId);

        try {
          const res = await fetch('dungeon_loot.php', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString()
          });
          const raw = await res.text();
          let data = null;
          try { data = JSON.parse(raw); } catch (err) { /* not JSON */ }

          if (data && data.status === 'success') {
            showMapToast(data.message || 'Loot claimed!', 'success');
            btn.classList.remove('boss-label-loot-loading', 'boss-label-loot-claim');
            btn.classList.add('boss-label-loot-done');
            btn.textContent = '✅ Looted';
            btn.disabled = true;
          } else {
            showMapToast((data && data.message) || 'Failed to loot.', 'error');
            btn.classList.remove('boss-label-loot-loading');
            btn.textContent = '🎁 Claim';
          }
        } catch (err) {
          showMapToast('Server error.', 'error');
          btn.classList.remove('boss-label-loot-loading');
          btn.textContent = '🎁 Claim';
        }
      });
    } else {
      btn.classList.add('boss-label-loot-done');
      btn.textContent = '✅ Looted';
      btn.disabled = true;
    }

    const namePill = label.querySelector('.boss-label-pill:not(.boss-label-dmg)');
    if (namePill && namePill.nextSibling) {
      label.insertBefore(btn, namePill.nextSibling);
    } else {
      label.appendChild(btn);
    }
  }

  function injectStyles() {
    if (document.getElementById('dungeon-map-pin-styles')) return;
    const style = document.createElement('style');
    style.id = 'dungeon-map-pin-styles';
    style.textContent = `
      /* --- map / pins (instance page) --- */
      .mapframe { width: 100% !important; margin: 0 !important; }
      .mapwrap { position: relative !important; width: 100% !important; }
      .mapwrap .map { width: 100% !important; height: auto !important; display: block !important; }
      .pin {
        width: ${PIN_SIZE_PERCENT}% !important;
        height: auto !important;
        aspect-ratio: 1 / 1 !important;
      }
      .pin .label.boss-label {
        display: flex; flex-direction: column; align-items: center; gap: 2px;
        max-width: 110px; background: transparent; border: none; padding: 0;
      }
      .pin .label.boss-label .boss-label-pill {
        display: inline-block; max-width: 100%; white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis;
        padding: 1px 6px; border-radius: 999px; font-size: 10px; line-height: 1.4;
        background: #0f111a; border: 1px solid var(--border, #232437); color: var(--text, #EDEFF6);
      }

      .pin .label.boss-label .boss-label-pill.boss-label-dmg {
        background: #3a1f1f; border-color: #6a2b2b; color: #ffb3b3; font-weight: 700;
      }

      /* --- claim-loot button, overlaid on a pin whose single boss is
         dead and still has unclaimed loot waiting on battle.php --- */
      .pin .boss-label-loot-btn {
        display: block; width: 100%; max-width: 110px; margin: 0 auto;
        padding: 1px 6px; border-radius: 999px; font-size: 10px; line-height: 1.4;
        font-family: inherit; font-weight: 700; cursor: pointer;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        background: linear-gradient(90deg, #34d058, #28a745);
        color: #fff;
        border: 1px solid #2f9e44;
        box-shadow: 0 0 8px rgba(40,167,69,.5), 0 4px 12px rgba(0,0,0,.5);
        text-shadow: 0 0 3px rgba(0,0,0,.7);
      }
      .pin .boss-label-loot-btn:hover { filter: brightness(1.12); }
      .pin .boss-label-loot-btn.boss-label-loot-loading { filter: brightness(0.85); cursor: progress; }
      .pin .boss-label-loot-btn.boss-label-loot-done {
        cursor: default;
        background: #23253a;
        color: #8a90ad;
        border: 1px solid #2B2D44;
        box-shadow: none;
        text-shadow: none;
      }
      #dungeon-map-toast {
        position: fixed; top: 20px; right: 20px; z-index: 99999;
        padding: 12px 20px; border-radius: 10px; box-shadow: 0 4px 12px rgba(0,0,0,.4);
        font-size: 14px; color: #fff; display: none;
      }
      #dungeon-map-toast.dmt-success { background: #2ecc71; }
      #dungeon-map-toast.dmt-error { background: #e74c3c; }


      /* --- leaderboard, shared compact styling (instance + location) --- */
      #dungeon-lb-inline { display: flex; flex-direction: column; overflow-y: auto; }
      .dungeon-lb-compact { }
      .dungeon-lb-compact .lb-row { padding: 6px !important; gap: 8px !important; }
      .dungeon-lb-compact .avatar { width: 24px !important; height: 24px !important; }
      .dungeon-lb-compact .lb-left,
      .dungeon-lb-compact .lb-row { font-size: 12px !important; }
      .dungeon-lb-compact .h { font-size: 14px !important; margin-bottom: 6px !important; }

      /* --- compact top bar: title, status, buttons, hp, heal ---
         Wraps onto multiple lines instead of scrolling horizontally, gets
         its own subtle panel treatment so it reads as one grouped toolbar,
         and splits into a left cluster (identity/status info) and a right
         cluster (controls: the map toggles + Back button) pinned to
         the far edge via margin-left:auto on #dungeon-bar-right. */
      #dungeon-compact-bar {
        display: flex; align-items: center; flex-wrap: wrap;
        gap: 14px; row-gap: 10px;
        padding: 10px 14px; width: 100%; box-sizing: border-box;
        background: rgba(255,255,255,0.03);
        border: 1px solid var(--border, #232437);
        border-radius: 8px;
      }
      #dungeon-compact-bar > * { flex-shrink: 0; }
      #dungeon-compact-bar .h { font-size: 14px !important; margin: 0 !important; white-space: nowrap; }
      #dungeon-compact-bar .muted { font-size: 12px !important; margin: 0 !important; white-space: nowrap; }
      #dungeon-compact-bar .pill { font-size: 11px !important; padding: 3px 8px !important; }
      #dungeon-compact-bar #dungeon-header-btns { display: flex; gap: 6px; margin: 0 !important; }
      #dungeon-compact-bar #dungeon-header-btns .btn { padding: 5px 10px !important; font-size: 13px !important; line-height: 1.2; }
      #dungeon-compact-bar .healbox {
        display: flex; align-items: center; gap: 8px; white-space: nowrap;
        background: transparent !important;
        border: none !important;
        box-shadow: none !important;
        padding: 0 !important;
        border-radius: 0 !important;
      }
      #dungeon-compact-bar .healbox .muted { display: none; } /* "Revive in" / "Free heal in" label — countdown says it already */
      #dungeon-compact-bar .healbox .btn { padding: 5px 10px !important; font-size: 12px !important; }
      #dungeon-compact-bar .healbox .countdown { font-size: 13px !important; font-weight: 600; }
      #dungeon-compact-bar .divider { width: 1px; height: 20px; background: rgba(255,255,255,0.12); flex-shrink: 0; align-self: center; }

      /* --- compact top bar: minified HP readout (JS strips the site's
         inline flex-basis:100%, which used to force this onto its own
         full-width row; numbers are abbreviated via compactHpBar()).
         .playerhp grows to fill the gap left over by #dungeon-bar-right's
         margin-left:auto, and its .bar stretches with it (capped so it
         doesn't balloon on very wide windows) while the heart icon and
         numbers stay fixed-width. --- */
      #dungeon-compact-bar .playerhp {
        display: flex !important; align-items: center; gap: 6px;
        white-space: nowrap;
        flex: 1 1 auto !important; min-width: 0; width: auto !important;
        justify-content: flex-start !important;
      }
      #dungeon-compact-bar .playerhp .pill { font-size: 12px !important; padding: 2px 6px !important; flex: 0 0 auto !important; }
      #dungeon-compact-bar .playerhp .bar { flex: 1 1 auto !important; width: auto !important; min-width: 24px !important; max-width: 220px !important; height: 8px !important; }
      #dungeon-compact-bar .playerhp .muted { font-size: 11px !important; flex: 0 0 auto !important; white-space: nowrap; }

      /* --- compact top bar: right-anchored control cluster (map toggles +
         Back button), pushed to the far edge of the bar --- */
      #dungeon-bar-right {
        display: flex; align-items: center; gap: 14px;
        margin-left: auto !important;
      }
      #dungeon-compact-bar .map-toggle {
        display: flex; align-items: center; gap: 6px;
        font-size: 12px; color: var(--text, #EDEFF6);
        cursor: pointer; white-space: nowrap; user-select: none;
      }
      #dungeon-compact-bar .map-toggle input {
        margin: 0; cursor: pointer;
      }

      /* --- location page: relocated loot toolbar --- */
      #dungeon-loc-loot-bar {
        display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
        padding: 4px 4px 10px;
      }
      #dungeon-loc-loot-bar .pill { font-size: 11px; }
      #dungeon-loc-loot-bar .btn { padding: 5px 10px; font-size: 12px; }

      /* --- location page: party info folded into leaderboard panel --- */
      #dungeon-loc-party-inline {
        display: flex; gap: 6px; margin-bottom: 8px; flex-wrap: wrap;
      }
      #dungeon-loc-party-inline .pill { font-size: 11px; }

      /* --- location page: tighter monster cards --- */
      .mon { padding: 8px !important; margin-bottom: 6px !important; }
      .mon > img { width: 44px !important; height: 44px !important; object-fit: cover; border-radius: 6px; }
      .mon .statrow { gap: 4px !important; margin-top: 6px !important; }
      .mon .statpill { padding: 2px 5px !important; font-size: 10px !important; }
      .mon .muted[style*="margin-top:20px"] { margin-top: 8px !important; margin-bottom: 0 !important; }

      /* --- dungeon list page: merged title/tags/back bar --- */
      #dungeon-list-header-bar {
        display: flex; align-items: center; flex-wrap: wrap;
        gap: 14px; row-gap: 10px;
        padding: 10px 14px; width: 100%; box-sizing: border-box;
        background: rgba(255,255,255,0.03);
        border: 1px solid var(--border, #232437);
        border-radius: 8px;
        margin-bottom: 12px;
      }
      #dungeon-list-header-bar h2 { margin: 0 !important; font-size: 16px !important; white-space: nowrap; }
      #dungeon-list-back-group {
        display: flex; align-items: center; gap: 8px;
        margin: 0 !important; white-space: nowrap;
      }
      #dungeon-list-back-group .btn { padding: 5px 10px !important; font-size: 13px !important; white-space: nowrap; }
      #dungeon-list-header-tags { display: flex; gap: 8px; flex-wrap: wrap; margin-left: auto; }
      #dungeon-list-header-tags .tag { font-size: 11px !important; padding: 3px 8px !important; white-space: nowrap; }

      /* --- dungeon list page: rules notice, one slim line with a tooltip for the full text --- */
      .rules-callout.dungeon-rules-slim {
        display: flex; align-items: center; gap: 8px;
        padding: 6px 12px !important; margin: 0 0 14px !important;
        font-size: 12px; line-height: 1.4; cursor: help;
      }
      .rules-callout.dungeon-rules-slim .rules-slim-icon { flex-shrink: 0; }
      .rules-callout.dungeon-rules-slim .rules-slim-text {
        flex: 1 1 auto; min-width: 0;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }

      /* --- dungeon list page: shared row list, used for BOTH the active
         grid and the past-instance grids so the whole page reads as one
         consistent scannable list instead of cards-up-top / rows-below.
         The site's own .card rule sets flex-direction:column and
         max-width:350px (leftover from its original card-grid look) —
         both fight a horizontal row, so both get explicitly overridden. --- */
      .dungeon-list-condensed { display: flex !important; flex-direction: column !important; gap: 6px !important; }
      .dungeon-list-row {
        display: flex !important;
        flex-direction: row !important;
        align-items: center; gap: 10px;
        padding: 12px 16px !important;
        width: 100% !important;
        max-width: none !important;
      }
      .dungeon-list-thumb { width: 52px !important; height: 52px !important; object-fit: cover; border-radius: 6px; flex-shrink: 0; }
      .dungeon-list-row > .body {
        display: flex !important; flex-wrap: wrap;
        align-items: center; gap: 10px;
        flex: 1; min-width: 0;
        padding: 0 !important; margin: 0 !important;
      }
      .dungeon-list-name { font-size: 13px !important; font-weight: normal !important; margin: 0 !important; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; max-width: 220px; }
      .dungeon-list-tags { display: flex; gap: 6px; flex-wrap: wrap; margin: 0 !important; flex: 1 1 auto; min-width: 0; }
      .dungeon-list-tags .tag { font-size: 10px !important; padding: 2px 6px !important; white-space: nowrap; }
      .dungeon-list-actions { display: flex !important; gap: 6px; margin: 0 !important; margin-left: auto !important; flex-shrink: 0; }
      .dungeon-list-actions .btn { padding: 4px 8px !important; font-size: 12px !important; }

      /* --- dungeon list page: active-row specifics — slightly larger thumb
         and slightly roomier tags/buttons than the past-instance rows, since
         these are the ones you're about to act on --- */
      .dungeon-list-thumb-active { width: 64px !important; height: 64px !important; }
      .dungeon-list-row-active .dungeon-list-tags .tag { font-size: 11px !important; }
      .dungeon-list-row-active .dungeon-list-actions .btn { font-size: 13px !important; padding: 6px 12px !important; }
      .dungeon-list-timing { flex-shrink: 0; white-space: nowrap; margin: 0 !important; }
      .dungeon-list-timing .tag { font-size: 11px !important; }

      /* --- dungeon list page: per-card Info button, icon-only with tooltip --- */
      .card a.btn[data-list-info-iconified="1"] { padding: 4px 8px !important; font-size: 13px !important; }
    `;
    document.head.appendChild(style);
  }

  // ---------- instance-page-only helpers ----------

  function renderLabel(pin, bossName, damageText) {
    const label = pin.querySelector('.label');
    if (!label) return;
    label.innerHTML = '';
    label.classList.add('boss-label');

    const namePill = document.createElement('div');
    namePill.className = 'boss-label-pill';
    namePill.textContent = bossName;
    namePill.title = bossName;
    label.appendChild(namePill);

    const dmgPill = document.createElement('div');
    dmgPill.className = 'boss-label-pill boss-label-dmg';
    dmgPill.textContent = damageText || '0';
    label.appendChild(dmgPill);
  }

  // Fetches the pin's location page to find out whether it's a single-boss
  // spot, and if so renders the boss name/damage label on the pin. This
  // ALWAYS runs, regardless of the Direct Links toggle — the label is purely
  // informational. Only when Direct Links is on does this also rewrite the
  // pin's href to jump straight to the fight; otherwise the href is left
  // pointing at the location page as normal.
  async function upgradePin(pin) {
    if (pin.classList.contains('locked')) return;
    if (pin.dataset.pinInfoLoaded === '1') return;
    const locationHref = pin.getAttribute('href');
    if (!locationHref || locationHref.startsWith('javascript:')) return;

    try {
      const res = await fetch(locationHref, { credentials: 'same-origin' });
      if (!res.ok) return;
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');

      const monBlocks = doc.querySelectorAll('.mon');
      if (monBlocks.length !== 1) return; // multiple bosses, keep normal click-through

      const monBlock = monBlocks[0];
      const fightLink = monBlock.querySelector('a.btn[href*="battle.php"]');
      const bossImg = monBlock.querySelector('img');
      if (!fightLink || !bossImg) return;

      const fightHref = fightLink.getAttribute('href');
      pin.dataset.pinInfoLoaded = '1';

      if (isDirectLinkEnabled()) {
        pin.setAttribute('href', fightHref);
        pin.classList.add('direct-boss-link');
      }

      const pinImg = pin.querySelector('img');
      if (pinImg && bossImg.getAttribute('src')) pinImg.src = bossImg.getAttribute('src');

      const isDead = monBlock.classList.contains('dead');
      const bossName = readBossName(monBlock);
      const { damageText, needsLoot, userId } = await readFightPageInfo(fightHref);
      renderLabel(pin, bossName, damageText);

      let dgmid = null, instanceId = null;
      if (isDead) {
        try {
          const fu = new URL(fightHref, location.href);
          dgmid = fu.searchParams.get('dgmid');
          instanceId = fu.searchParams.get('instance_id');
        } catch (e) { /* ignore */ }
      }
      renderLootStatus(pin, { isDead, needsLoot, dgmid, instanceId, userId });
    } catch (err) {
      console.warn('[dungeon-map] failed to upgrade pin for', locationHref, err);
    }
  }

  function removeExtraPanels() {
    document.querySelectorAll('.panel').forEach(panel => {
      if (panel.querySelector('.stats')) panel.remove();
    });
    document.querySelectorAll('.legend').forEach(el => el.remove());
  }

  function moveLeaderboardIntoMapPanel() {
    if (document.getElementById('dungeon-lb-inline')) return;

    const mapPanel = document.querySelector('.mapframe')?.closest('.panel');
    const lbList = document.querySelector('.lb');
    const lbPanel = lbList?.closest('.panel');
    if (!mapPanel || !lbList || !lbPanel || mapPanel === lbPanel) return;

    mapPanel.removeAttribute('style');

    const lbHeading = lbPanel.querySelector('.h');
    const mapframe = mapPanel.querySelector('.mapframe');

    const lbWrap = document.createElement('div');
    lbWrap.id = 'dungeon-lb-inline';
    lbWrap.className = 'dungeon-lb-compact';
    if (lbHeading) lbWrap.appendChild(lbHeading);
    lbWrap.appendChild(lbList);

    mapPanel.style.cssText = 'display:flex; gap:16px; align-items:stretch; flex-wrap:wrap; width:100%;';
    if (mapframe) mapframe.style.cssText += 'flex:3 1 400px; min-width:0;';
    lbWrap.style.cssText = 'flex:1 0 280px; min-width:220px; max-width:320px;';

    mapPanel.appendChild(lbWrap);
    lbPanel.remove();
  }

  // ---------- location-page-only helpers ----------

  // Removes the banner panel, but relocates the Total/Left pills + Loot All
  // button into a slim toolbar right under the monster-list panel heading
  // instead of deleting them.
  function cleanupLocationLootPanel() {
    if (document.getElementById('dungeon-loc-loot-bar')) return;

    const banner = document.querySelector('.loc-banner');
    const bannerPanel = banner?.closest('.panel');
    if (!bannerPanel) return;

    const lootBtn = bannerPanel.querySelector('#lootAllBtn');
    const pills = Array.from(bannerPanel.querySelectorAll('.pill'));

    const monstersPanel = Array.from(document.querySelectorAll('.panel')).find(p => {
      const h = p.querySelector('.h');
      return h && h.textContent.includes('Monsters in this location');
    });

    if (monstersPanel) {
      const bar = document.createElement('div');
      bar.id = 'dungeon-loc-loot-bar';
      pills.forEach(p => bar.appendChild(p));
      if (lootBtn) bar.appendChild(lootBtn);

      const heading = monstersPanel.querySelector('.h');
      if (heading) heading.after(bar);
      else monstersPanel.prepend(bar);
    }

    bannerPanel.style.display = 'none';
  }

  // Folds the "📊 Location / Party" pills (players alive / status) into the
  // top of the "🏅 Guild Damage" panel and removes the now-empty panel.
  function compactPartyIntoLeaderboard() {
    if (document.getElementById('dungeon-loc-party-inline')) return;

    const findPanel = (label) => Array.from(document.querySelectorAll('.panel')).find(p => {
      const h = p.querySelector('.h');
      return h && h.textContent.includes(label);
    });

    const partyPanel = findPanel('Location / Party');
    const lbPanel = findPanel('Guild Damage');
    if (!partyPanel || !lbPanel) return;

    const pills = Array.from(partyPanel.querySelectorAll('.pill'));
    if (!pills.length) { partyPanel.remove(); return; }

    const wrap = document.createElement('div');
    wrap.id = 'dungeon-loc-party-inline';
    pills.forEach(p => wrap.appendChild(p));

    const heading = lbPanel.querySelector('.h');
    if (heading) heading.after(wrap);
    else lbPanel.prepend(wrap);

    partyPanel.style.display = 'none';
  }

  function styleLeaderboardPanelCompact() {
    const lbPanel = Array.from(document.querySelectorAll('.panel')).find(p => {
      const h = p.querySelector('.h');
      return h && h.textContent.includes('Guild Damage');
    });
    if (lbPanel) lbPanel.classList.add('dungeon-lb-compact');
  }

  // ---------- list-page-only helpers ----------

  // Merges the title row (h2 + guild/role/gold tags) and the separate
  // back-button row into one compact bar, and drops the stray <br> that
  // used to sit between them.
  function compactListHeader() {
    if (document.getElementById('dungeon-list-header-bar')) return;

    const titleRow = Array.from(document.querySelectorAll('.wrap > .row'))
    .find(r => r.querySelector('h2'));
    if (!titleRow) return;

    const backRow = titleRow.nextElementSibling;
    const strayBr = backRow && backRow.nextElementSibling && backRow.nextElementSibling.tagName === 'BR'
    ? backRow.nextElementSibling : null;

    const h2 = titleRow.querySelector('h2');
    const tags = Array.from(titleRow.querySelectorAll('.tag'));
    if (!h2) return;

    const bar = document.createElement('div');
    bar.id = 'dungeon-list-header-bar';

    bar.appendChild(h2);

    // Relocate the ORIGINAL back-button row as a unit instead of pulling
    // just the <a> out of it. The site's own script tags whatever element
    // holds the Back button with margin-top + data-back-mt-applied (and
    // sometimes drops in an extra button, like "Scan") — if that row is
    // gone, the site's script walks up and tags our whole header bar
    // instead, which is what pushed the entire bar down. Keeping the row
    // alive as a small nested group means it still finds its target, and
    // our CSS flattens the margin regardless of when the site's script fires.
    if (backRow) {
      backRow.id = 'dungeon-list-back-group';
      bar.appendChild(makeDivider());
      bar.appendChild(backRow);
    }

    if (tags.length) {
      bar.appendChild(makeDivider());
      const tagWrap = document.createElement('div');
      tagWrap.id = 'dungeon-list-header-tags';
      tags.forEach(t => tagWrap.appendChild(t));
      bar.appendChild(tagWrap);
    }

    titleRow.parentNode.insertBefore(bar, titleRow);
    titleRow.remove();
    if (strayBr) strayBr.remove();
  }

  // Collapses the "Dungeon Closure Rule" panel from icon+title+multi-line
  // text down to one truncated line; the full text is still available via
  // the native title-attribute tooltip on hover.
  function shrinkRulesCallout() {
    const callout = document.querySelector('.rules-callout');
    if (!callout || callout.classList.contains('dungeon-rules-slim')) return;

    const iconText = callout.querySelector('.rules-icon')?.textContent.trim() || '⚠️';
    const titleText = callout.querySelector('.rules-title')?.textContent.trim() || '';
    const bodyText = callout.querySelector('.rules-text')?.textContent.replace(/\s+/g, ' ').trim() || '';

    callout.innerHTML = '';
    callout.classList.add('dungeon-rules-slim');
    callout.title = titleText ? `${titleText}: ${bodyText}` : bodyText;

    const iconSpan = document.createElement('span');
    iconSpan.className = 'rules-slim-icon';
    iconSpan.textContent = iconText;
    callout.appendChild(iconSpan);

    const textSpan = document.createElement('span');
    textSpan.className = 'rules-slim-text';
    if (titleText) {
      const strong = document.createElement('strong');
      strong.textContent = titleText + ':';
      textSpan.appendChild(strong);
      textSpan.appendChild(document.createTextNode(' ' + bodyText));
    } else {
      textSpan.textContent = bodyText;
    }
    callout.appendChild(textSpan);
  }

  // Strips the long flavor-text blurb from each active-dungeon card. It's
  // the first ".meta" inside the card body and, unlike the stats line right
  // after it, has no ".tag" children — that's how we tell them apart.
  function removeActiveCardDescriptions() {
    document.querySelectorAll('.grid:not(.ended) > .card > .body').forEach(body => {
      const firstMeta = body.querySelector(':scope > .meta');
      if (firstMeta && !firstMeta.querySelector('.tag')) firstMeta.remove();
    });
  }

  // Turns the "Active Dungeon Templates" grid into the same tight row
  // format as the past-instance lists below it: small thumb, name, stats
  // as wrapping tags, actions on the end. Must run AFTER
  // removeActiveCardDescriptions() — once the blurb is gone, the stats
  // ".meta" is the only one left, so ":scope > .meta" grabs the right thing.
  function condenseActiveGrid() {
    const grid = document.querySelector('.grid:not(.ended)');
    if (!grid || grid.classList.contains('dungeon-list-condensed')) return;
    grid.classList.add('dungeon-list-condensed');

    grid.querySelectorAll(':scope > .card').forEach(card => {
      card.classList.add('dungeon-list-row', 'dungeon-list-row-active');

      const banner = card.querySelector(':scope > img.banner');
      if (banner) banner.classList.add('dungeon-list-thumb', 'dungeon-list-thumb-active');

      const body = card.querySelector(':scope > .body');
      if (!body) return;

      body.querySelector(':scope > .h')?.classList.add('dungeon-list-name');

      const tagsRow = body.querySelector(':scope > .meta');
      tagsRow?.classList.add('dungeon-list-tags');

      const actionRow = body.querySelector(':scope > .row');
      if (actionRow) actionRow.classList.add('dungeon-list-actions');

      // Pull the "Opened … / live timer" pill out of the stat-tag row into
      // its own slot between tags and actions — it's status/timing info,
      // not a stat alongside cost/locations/monsters, so it reads better
      // set apart.
      const timingTag = tagsRow?.querySelector(':scope > .tag.warn');
      if (timingTag && actionRow) {
        const timingWrap = document.createElement('div');
        timingWrap.className = 'dungeon-list-timing';
        timingWrap.appendChild(timingTag);
        body.insertBefore(timingWrap, actionRow);
      }
    });
  }

  // Turns a "Previous Instances" grid of full cards into a tight vertical
  // list: small thumbnail, name, all tags (including the leftover loot
  // status line) folded onto one row, actions on the end. Drops the long
  // description, which just repeats the same 3 dungeon blurbs every time.
  function condenseEndedGrid(grid) {
    if (!grid || grid.classList.contains('dungeon-list-condensed')) return;
    grid.classList.add('dungeon-list-condensed');

    grid.querySelectorAll(':scope > .card').forEach(card => {
      card.classList.add('dungeon-list-row');

      const banner = card.querySelector(':scope > img.banner');
      if (banner) banner.classList.add('dungeon-list-thumb');

      const body = card.querySelector(':scope > .body');
      if (!body) return;

      body.querySelector(':scope > .h')?.classList.add('dungeon-list-name');

      const metas = Array.from(body.querySelectorAll(':scope > .meta'));
      metas[0]?.remove(); // the long description
      const tagRow = metas[1];
      tagRow?.classList.add('dungeon-list-tags');

      const actionRow = body.querySelector(':scope > .row');
      if (actionRow) {
        actionRow.classList.add('dungeon-list-actions');
        // fold trailing status text ("Awaiting leader/vice to loot.",
        // "✅ Already looted") into the tag row as a pill instead of
        // leaving it stuck in the middle of the buttons
        const statusText = actionRow.querySelector(':scope > .meta');
        if (statusText && tagRow) {
          statusText.className = 'tag';
          tagRow.appendChild(statusText);
        }
      }
    });
  }

  function condenseEndedGrids() {
    document.querySelectorAll('.grid.ended').forEach(condenseEndedGrid);
  }

  // Every card's "ℹ️ Info" button becomes icon-only, "Info" kept as a tooltip.
  function iconifyCardInfoButtons() {
    document.querySelectorAll('.card a.btn').forEach(btn => {
      if (btn.dataset.listInfoIconified === '1') return;
      if (!btn.textContent.includes('Info')) return;
      btn.title = 'Info';
      btn.textContent = 'ℹ️';
      btn.dataset.listInfoIconified = '1';
    });
  }

  // Extracts the dungeon *template* id from a card's ℹ️ Info link
  // (dungeon_info.php?id=N). This is the one identifier that's stable
  // across the Active/Clears/Failed sections — instance ids, open times,
  // and loot status all differ per-run, but the template id doesn't.
  function getDungeonTemplateId(card) {
    const infoLink = card.querySelector('a.btn[href*="dungeon_info.php"]');
    if (!infoLink) return null;
    try {
      const url = new URL(infoLink.getAttribute('href'), location.href);
      const id = url.searchParams.get('id');
      return id !== null ? parseInt(id, 10) : null;
    } catch (e) { return null; }
  }

  // Reorders one grid's cards by template id (falls back to name if a card
  // has no Info link for some reason). Running the same comparator on every
  // grid means Active, Clears, and Failed all end up in the same relative
  // order, instead of each section's own natural order (open time for
  // Active, most-recent-instance-first for Clears/Failed).
  function sortDungeonListGrid(grid) {
    const cards = Array.from(grid.children).filter(el => el.classList.contains('card'));
    if (cards.length < 2) return;

    const withKeys = cards.map(card => ({
      card,
      id: getDungeonTemplateId(card),
      name: card.querySelector('.h')?.textContent.trim() || ''
    }));

    withKeys.sort((a, b) => {
      if (a.id !== null && b.id !== null && a.id !== b.id) return a.id - b.id;
      if (a.id !== null && b.id === null) return -1;
      if (a.id === null && b.id !== null) return 1;
      return a.name.localeCompare(b.name);
    });

    // Skip touching the DOM if it's already in the right order — avoids
    // needless reflow every time the MutationObserver reruns run().
    const alreadySorted = withKeys.every((entry, i) => entry.card === cards[i]);
    if (alreadySorted) return;

    const frag = document.createDocumentFragment();
    withKeys.forEach(entry => frag.appendChild(entry.card));
    grid.appendChild(frag);
  }

  function sortAllDungeonListGrids() {
    document.querySelectorAll('.grid.dungeon-list-condensed').forEach(sortDungeonListGrid);
  }

  // ---------- shared header compaction (both page types) ----------

  function iconifyButtons(btnRow) {
    btnRow.querySelectorAll('.btn').forEach(btn => {
      const text = btn.textContent.trim();

      if (text.includes('Info')) {
        btn.remove();
        return;
      }

      if (btn.dataset.iconified === '1') return;

      if (text.includes('Back')) {
        btn.title = text;
        btn.textContent = '⬅ Back';
        btn.dataset.iconified = '1';
      } else if (text.includes('Loot')) {
        btn.title = text;
        btn.textContent = '💰 Loot All';
        btn.dataset.iconified = '1';
      }
    });
  }

  function makeDivider() {
    const d = document.createElement('div');
    d.className = 'divider';
    return d;
  }

  function formatCompactNumber(n) {
    return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
  }

  // Strips the site's inline style off the HP block (it's how the "148,364
  // / 541,900" readout was forcing flex-basis:100% and knocking itself onto
  // its own full-width row) so our CSS sizing takes over, then abbreviates
  // the current/max numbers ("148,364 / 541,900" -> "148K / 542K") and swaps
  // the "HP" pill for a heart icon so the whole thing fits in the gap next
  // to the heal box instead of needing a row to itself. Exact numbers are
  // kept as a tooltip.
  function compactHpBar(hpBar) {
    if (hpBar.dataset.compacted === '1') return;
    hpBar.dataset.compacted = '1';
    hpBar.removeAttribute('style');

    const muted = hpBar.querySelector('.muted');
    if (muted) {
      const match = muted.textContent.match(/([\d,]+)\s*\/\s*([\d,]+)/);
      if (match) {
        const cur = parseInt(match[1].replace(/,/g, ''), 10);
        const max = parseInt(match[2].replace(/,/g, ''), 10);
        if (!isNaN(cur) && !isNaN(max)) {
          muted.textContent = `${formatCompactNumber(cur)} / ${formatCompactNumber(max)}`;
          muted.title = `${match[1]} / ${match[2]}`;
        }
      }
    }

    const pill = hpBar.querySelector('.pill');
    if (pill && pill.textContent.trim().toUpperCase() === 'HP') {
      pill.title = 'HP';
      pill.textContent = '❤️';
    }
  }

  // Works on both instance and location pages: both have a top .row whose
  // first child div contains .h, and a sibling .row holding the action
  // button(s). healBox is optional since it's only rendered when relevant.
  // showMapToggles is true only on the instance page, since that's the
  // only page where the pin/back-skip toggles apply.
  function compactEverything(showMapToggles) {
    if (document.getElementById('dungeon-compact-bar')) return;

    const outerRow = Array.from(document.querySelectorAll('.row'))
    .find(r => r.querySelector(':scope > div > .h'));
    if (!outerRow) return;

    const titleDiv = outerRow.children[0];
    const btnRow = outerRow.querySelector('[data-back-mt-applied]') || outerRow.querySelector(':scope > .row');
    const hpBar = document.querySelector('.playerhp');
    const healBox = document.querySelector('.healbox');
    if (!titleDiv || !btnRow || !hpBar) return;

    btnRow.id = 'dungeon-header-btns';
    btnRow.style.cssText = 'margin-top:0;';
    iconifyButtons(btnRow);

    titleDiv.style.cssText = 'display:flex; align-items:center; gap:8px;';

    compactHpBar(hpBar);

    const bar = document.createElement('div');
    bar.id = 'dungeon-compact-bar';
    outerRow.parentNode.insertBefore(bar, outerRow);

    // Left cluster: identity/status info, in reading order.
    bar.appendChild(titleDiv);

    if (healBox) {
      bar.appendChild(makeDivider());
      bar.appendChild(healBox);
    }

    // HP bar sits right after Heal, in the same left cluster — it grows
    // via flex to fill the gap between Heal and the right-anchored control
    // cluster instead of stretching onto its own row.
    bar.appendChild(makeDivider());
    bar.appendChild(hpBar);

    // Right cluster: controls (map toggles + Back), pinned to the far edge
    // of the bar via margin-left:auto so they stay clear of the status info
    // instead of sitting wherever they happen to land.
    const rightGroup = document.createElement('div');
    rightGroup.id = 'dungeon-bar-right';

    if (showMapToggles) {
      rightGroup.appendChild(buildToggle(
        DIRECT_LINK_STORAGE_KEY, true,
        '🎯 Direct Links',
        'On: single-boss pins link straight to the fight. Off: pins link to the location page as normal — the name/damage label on the pin still shows either way.'
      ));
      rightGroup.appendChild(buildToggle(
        BACK_SKIP_STORAGE_KEY, true,
        '↩️ Skip Location on Back',
        'On: leaving a single-boss fight returns straight to this map instead of the location page. Off: returns to the location page as normal. Independent of Direct Links.'
      ));
      rightGroup.appendChild(makeDivider());
    }
    rightGroup.appendChild(btnRow);

    bar.appendChild(makeDivider());
    bar.appendChild(rightGroup);

    outerRow.remove();
  }

  // ---------- page detection + dispatch ----------

  function isDungeonListPage() {
    return /\/guild_dungeon\.php$/.test(location.pathname);
  }

  function isDungeonInstancePage() {
    return !!document.querySelector('.mapframe') && !!document.querySelector('.lb');
  }

  function isLocationPage() {
    return /guild_dungeon_location\.php/.test(location.pathname)
  }

  function run() {
    const onList = isDungeonListPage();
    const onInstance = isDungeonInstancePage();
    const onLocation = isLocationPage();
    if (!onList && !onInstance && !onLocation) return;

    injectStyles();

    if (onList) {
      compactListHeader();
      shrinkRulesCallout();
      removeActiveCardDescriptions();
      condenseActiveGrid();
      condenseEndedGrids();
      sortAllDungeonListGrids();
      iconifyCardInfoButtons();
    }

    if (onInstance) {
      // Runs unconditionally: pin labels (name/damage) render regardless of
      // the Direct Links toggle — that toggle only controls whether the
      // pin's href also gets rewritten, which is handled inside upgradePin.
      document.querySelectorAll('.mapframe a.pin').forEach(upgradePin);
      removeExtraPanels();
      moveLeaderboardIntoMapPanel();
    }

    if (onLocation) {
      cleanupLocationLootPanel();
      compactPartyIntoLeaderboard();
      styleLeaderboardPanelCompact();
    }

    compactEverything(onInstance);
  }

  // Everything run() calls is idempotent (each step checks for its own
  // "already done" marker before touching the DOM), so it's safe to call
  // repeatedly. This lets us react to content the page renders shortly
  // after document-end (e.g. via its own AJAX) instead of only getting one
  // shot at document-idle and missing anything that wasn't there yet.
  let rerunTimer = null;
  function scheduleRun() {
    clearTimeout(rerunTimer);
    rerunTimer = setTimeout(run, 50);
  }

  const observer = new MutationObserver(scheduleRun);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), 20000); // stop watching once the page has had time to settle

  run();
})();


/* =====================================================================
   MODULE 3: Battle Page — Skip Location on Back
   Runs only on battle.php for a dungeon monster. Controlled by its own
   "Skip Location on Back" toggle (set from the instance-page toolbar in
   Module 2) — entirely independent of the Direct Links toggle. If the
   fight's location has exactly one boss (same condition Module 2 uses
   before it will upgrade a pin), the Back button is retargeted to jump
   straight to the instance map instead of the location page.
   ===================================================================== */
(function () {
  'use strict';
  if (!/\/battle\.php/.test(location.pathname)) return;
  if (!(window.BATTLE_CFG && window.BATTLE_CFG.isDungeon)) return;

  const BACK_SKIP_STORAGE_KEY = 'dungeonBattleSkipsLocationOnBackEnabled';

  function isBackSkipEnabled() {
    const stored = localStorage.getItem(BACK_SKIP_STORAGE_KEY);
    return stored === null ? true : stored === '1'; // on by default
  }
  if (!isBackSkipEnabled()) return;

  async function run() {
    // Find the "⬅ Back" link that points at the location page.
    const backLink = Array.from(document.querySelectorAll('a.btn'))
    .find(a => (a.getAttribute('href') || '').includes('guild_dungeon_location.php'));
    if (!backLink || backLink.dataset.backSkipChecked === '1') return;
    backLink.dataset.backSkipChecked = '1';

    const locationHref = backLink.getAttribute('href');
    let instanceId;
    try {
      instanceId = new URL(locationHref, location.href).searchParams.get('instance_id');
    } catch (e) { return; }
    if (!instanceId) return;

    try {
      const res = await fetch(locationHref, { credentials: 'same-origin' });
      if (!res.ok) return;
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');

      // Only skip the location page if it only ever shows this one boss —
      // the same threshold Module 2's upgradePin() uses for direct links.
      if (doc.querySelectorAll('.mon').length !== 1) return;

      backLink.setAttribute('href', `guild_dungeon_instance.php?id=${encodeURIComponent(instanceId)}`);
      backLink.textContent = '⬅ Back to Map';
    } catch (err) {
      console.warn('[battle-back] failed to check location boss count', err);
    }
  }

  let rerunTimer = null;
  function scheduleRun() {
    clearTimeout(rerunTimer);
    rerunTimer = setTimeout(run, 50);
  }
  const observer = new MutationObserver(scheduleRun);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), 20000);

  run();
})();


/* =====================================================================
   MODULE 4: Main Dashboard Cleanup + Live Tile Notifications
   Runs only on game_dash.php. Merges the former standalone "Reminders
   Tracker" script directly into the dashboard nav: each relevant tile
   gets a small live-count badge plus a hover (mouse) / tap (touch)
   panel showing the actual live detail for that category, with rows
   that link straight to the matching page or fight. See the MERGE
   NOTES comment block at the top of this file for the full rundown.
   ===================================================================== */
(function () {
  'use strict';

  // Feature-detect rather than trust the @match list alone. This guard
  // means the script simply no-ops anywhere those two markers aren't both
  // present, instead of misfiring on an unrelated page.
  function isDashboardPage() {
    return /\/game_dash\.php/.test(location.pathname) &&
      !!document.querySelector('.hero-section[aria-label="Core Activities"]') &&
      !!document.querySelector('.gates-flex');
  }
  if (!isDashboardPage()) return;

  let gdInitialScrollDone = false;
  function applyInitialScroll() {
    if (gdInitialScrollDone) return;
    const howto = document.querySelector('.howto-info');
    const categories = document.querySelector('.dc-nav-categories');
    if (!howto || !categories) return; // not built yet — next run() will retry
    gdInitialScrollDone = true;

    const doScroll = () => {
      // Account for the pinned .game-topbar so the nav categories don't
      // end up tucked underneath it.
      const topbar = document.querySelector('.game-topbar');
      const topbarHeight = topbar ? topbar.getBoundingClientRect().height : 0;
      const target = howto.getBoundingClientRect().bottom + window.scrollY + 8 - topbarHeight;
      window.scrollTo({ top: Math.max(0, target), behavior: 'instant' });
    };
    setTimeout(doScroll, 350);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function escapeAttr(s) {
    return escapeHtml(s);
  }

  function parseBigNumber(value) {
    if (typeof value === 'number') return value;
    const cleaned = String(value ?? '').replace(/,/g, '').replace(/[^\d.-]/g, '');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : NaN;
  }

  function formatBigNumber(value) {
    const n = parseBigNumber(value);
    if (!Number.isFinite(n)) return '0';

    const abs = Math.abs(n);
    const units = [
      [1e12, 'T'],
      [1e9, 'B'],
      [1e6, 'M'],
      [1e3, 'K'],
    ];

    for (const [limit, suffix] of units) {
      if (abs >= limit) {
        const scaled = n / limit;
        const places = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
        return `${scaled.toFixed(places).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1')} ${suffix}`;
      }
    }

    return Math.round(n).toLocaleString();
  }


  // Maps a menu item's href to a category label. Keyed by href (not by the
  // visible name) since hrefs are the stable identifier — display text could
  // change without this map going stale. Anything not listed here falls into
  // "More" rather than silently vanishing, so a future new menu item still
  // shows up (just uncategorized) instead of being dropped.
  const MENU_CATEGORIES = {
    'inventory.php': 'Character',
    'power_crystals.php': 'Character',
    'relics.php': 'Character',
    'pets.php': 'Character',
    'stats.php': 'Character',
    'shadow_army.php': 'Character',
    'blacksmith.php': 'Crafting & Trading',
    'legendary_forge.php': 'Crafting & Trading',
    'legendary_decraft.php': 'Crafting & Trading',
    'merchant.php': 'Crafting & Trading',
    'black_merchant.php': 'Crafting & Trading',
    'guild_dash.php': 'Guild & Community',
    'adventurers_guild.php': 'Guild & Community',
    'referrals.php': 'Guild & Community',
    'chat.php': 'Guild & Community',
    'weekly.php': 'Guild & Community',
    'achievements.php': 'Progress & Info',
    'collections.php': 'Progress & Info',
    'guide.php': 'Progress & Info',
    'patches.php': 'Progress & Info',
    'index.php': 'Progress & Info', // only item in its own "Reading" category, folded in here instead
    'weekly_deals.php':'Crafting & Trading',
  };
  // "Live Now" isn't listed here — those items come from the hero section,
  // not this map, and are rendered separately in the left column.
  const CATEGORY_ORDER = ['Character', 'Crafting & Trading', 'Guild & Community', 'Progress & Info', 'More'];

  // Which live-data key each tile's href maps to, for the badge + panel below.
  const TILE_KEY_BY_HREF = {
    'gates.php': 'gates',
    'pvp.php': 'pvp',
    'adventurers_guild.php': 'quests',
    'guild_dash.php': 'guild',
    'battle_pass.php': 'battlepass'
  };
  const KEY_HREF = { gates: 'gates.php', pvp: 'pvp.php', quests: 'adventurers_guild.php', guild: 'guild_dash.php', battlepass: 'battle_pass.php' };

  /* =====================================================================
     LIVE DATA — merged from the old Reminders Tracker
     ===================================================================== */

  const SOURCE_WAVES = [
    { label: 'G1W3', url: 'https://demonicscans.org/active_wave.php?gate=3&wave=8', settingKey: 'waveGate3W8' },
    { label: 'G2W1', url: 'https://demonicscans.org/active_wave.php?gate=5&wave=9', settingKey: 'waveGate5W9' },
    { label: 'G2W2-1', url: 'https://demonicscans.org/active_wave.php?gate=5&wave=10', settingKey: 'waveGate5W10' },
    { label: 'G2W2-2', url: 'https://demonicscans.org/active_wave.php?gate=5&wave=11', settingKey: 'waveGate5W11' }
  ];
  const WAVE_GROUP_LABELS = {
    'G1W3': 'Generals',
    'G2W1': 'Poseidon',
    'G2W2-1': 'Hermes',
    'G2W2-2': 'Artemis'
  };

  // Groups by source label, preserving SOURCE_WAVES order so sections
  // always appear in gate/wave progression regardless of fetch order.
  function groupWavesBySource(waves) {
    const map = new Map();
    SOURCE_WAVES.forEach((s) => map.set(s.label, []));
    waves.forEach((b) => {
      if (!map.has(b.sourceLabel)) map.set(b.sourceLabel, []);
      map.get(b.sourceLabel).push(b);
    });
    return map;
  }

  function normalizeWaveBossKey(name) {
    return String(name || '').trim().toLowerCase();
  }

  // Per-boss-name threshold, falling back to the boss's group default
  // (Generals/Poseidon/Hermes/Artemis) until that specific name has its
  // own override saved in Advanced settings.
  function getWaveThreshold(boss) {
    const key = normalizeWaveBossKey(boss.name);
    const override = live.damageThresholds.waveNames ? live.damageThresholds.waveNames[key] : undefined;
    if (Number.isFinite(override)) return override;
    const source = SOURCE_WAVES.find((s) => s.label === boss.sourceLabel);
    return source ? live.damageThresholds[source.settingKey] : undefined;
  }

  const QUESTS_URL = 'https://demonicscans.org/adventurers_guild.php';
  const PVP_URL = 'https://demonicscans.org/pvp.php';
  const DUNGEON_LIST_URL = 'https://demonicscans.org/guild_dungeon.php';
  const BATTLE_PASS_URL = 'https://demonicscans.org/battle_pass.php';
  const DUNGEON_LOC_URL = 'https://demonicscans.org/guild_dungeon_location.php';
  const DUNGEON_BATTLE_URL = 'https://demonicscans.org/battle.php';
  const DUNGEON_BOSS_LOCATIONS = {
    easy: [
      { locId: 5, label: 'Grixkar (Boss)', thresholdKey: 'dungeonBossEasy' }
    ],
    hard: [
      { locId: 6, label: "Vizier", thresholdKey: 'dungeonMini' },
      { locId: 7, label: 'Vorrak', thresholdKey: 'dungeonMini' },
      { locId: 8, label: 'Grimgrowl', thresholdKey: 'dungeonMini' },
      { locId: 9, label: 'Drazhul', thresholdKey: 'dungeonMini' },
      { locId: 10, label: 'khaal (Boss)', thresholdKey: 'dungeonBossHard' }
    ],
    crucible: [
      { locId: 14, label: 'The Apex (Boss)', thresholdKey: 'dungeonBossCrucible' }
    ]
  };

  const DUNGEON_SWARM_LOCATIONS = {
    easy: [
      { locId: 2, label: 'P. Warrens - gribs' },
      { locId: 4, label: 'T. Center - gribs' }
    ]
  };

  const SWARM_HIT_THRESHOLD = 1000000; // kept as the fallback default for gribs

  const DEFAULT_DAMAGE_THRESHOLDS = {
    swarm: SWARM_HIT_THRESHOLD,        // gribs (Shadowbridge swarm)
    // wave bosses — each group configurable individually
    waveGate3W8: 3000000000,           // Generals
    waveGate5W9: 3000000000,           // Poseidon
    waveGate5W10: 3000000000,          // Hermes
    waveGate5W11: 3000000000,          // Artemis
    // dungeon bosses — each configurable individually
    dungeonBossEasy: 3000000000,       // Grixkar
    dungeonBossHard: 3000000000,       // khaal
    dungeonBossCrucible: 500000000,    // The Apex
    // minis stay grouped as one shared value (by type, not per-mini)
    dungeonMini: 2000000000            // Vizier/Vorrak/Grimgrowl/Drazhul
  };
  const REFRESH_MS = 5 * 60 * 1000; // 5 minutes
  // Maps each onclick function name (as parsed by extractRowActions) to the
  // real same-origin endpoint it calls and the order of POST params it
  // sends. Anything not listed here has no direct-fire path and falls back
  // to just opening the Adventurer's Guild page.
  const QUEST_ACTION_ENDPOINTS = {
    acceptQuest:      { url: '/adventurers_accept_quest.php',   params: ['quest_id'] },
    finishQuest:      { url: '/adventurers_finish_quest.php',   params: ['quest_id'] },
    giveUpQuest:      { url: '/adventurers_giveup_quest.php',   params: ['quest_id'] },
    donateGatherItem: { url: '/adventurers_donate_gather.php',  params: ['quest_id', 'item_id'] }
  };
  // Mirrors the confirm() text each function shows on the real page, so the
  // safety prompt is preserved even though we're firing the request from
  // the dashboard instead of clicking the real button.
  const QUEST_ACTION_CONFIRM = {
    acceptQuest: "Accept this quest from the Adventurer's Guild?",
    finishQuest: "Turn in this quest at the Adventurer's Guild?",
    giveUpQuest: "Abandon this quest? Progress will be lost.",
    donateGatherItem: "Donate one of this item towards your quest? You must own more than one."
  };

  const STORAGE_KEY = 'verya_reminders'; // kept from the old Reminders Tracker for backward-compat
  const DEFAULT_TRACK_SETTINGS = {
    waveGate3W8: true, waveGate5W9: true, waveGate5W10: true, waveGate5W11: true,
    quests: true, battlePassQuests: true, pvp: true,
    dungeonEasyBoss: true, dungeonHardBoss: true, dungeonCrucibleBoss: true, dungeonEasySwarm: true
  };

  const live = {
    trackSettings: { ...DEFAULT_TRACK_SETTINGS },
    damageThresholds: { ...DEFAULT_DAMAGE_THRESHOLDS },
    showDamage: true,
    hideGemOffer: true, // default ON — gem offer banner hidden unless toggled off in settings
    serverOffsetSec: null,
    waves: [],
    quests: { rows: [], available: 0, active: [], error: null },
    battlepass: { dayLabel: '', rows: [], unfinished: 0, error: null },
    pvp: { soloTokens: null, soloMaxTokens: null, partyTokens: null, partyMaxTokens: null, error: null },
    dungeon: { easy: { open: false, rows: [] }, hard: { open: false, rows: [] }, crucible: { open: false, rows: [] }, easySwarm: { open: false, locations: [] } }
  };

  function normalizeTrackSettings(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    return {
      waveGate3W8: s.waveGate3W8 !== false,
      waveGate5W9: s.waveGate5W9 !== false,
      waveGate5W10: s.waveGate5W10 !== false,
      waveGate5W11: s.waveGate5W11 !== false,
      quests: s.quests !== false,
      battlePassQuests: s.battlePassQuests !== false,
      pvp: s.pvp !== false,
      dungeonEasyBoss: s.dungeonEasyBoss !== false,
      dungeonHardBoss: s.dungeonHardBoss !== false,
      dungeonCrucibleBoss: s.dungeonCrucibleBoss !== false,
      dungeonEasySwarm: s.dungeonEasySwarm !== false
    };
  }

  function normalizeDamageThresholds(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    function num(v, fallback) {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : fallback;
    }
    const out = {};
    Object.keys(DEFAULT_DAMAGE_THRESHOLDS).forEach((key) => {
      out[key] = num(s[key], DEFAULT_DAMAGE_THRESHOLDS[key]);
    });
    // Per-boss-name overrides for wave bosses, keyed by normalized name —
    // sparse on purpose. Any name with no explicit override here just
    // falls back to its group's threshold in `out` above.
    out.waveNames = {};
    if (s.waveNames && typeof s.waveNames === 'object') {
      Object.keys(s.waveNames).forEach((key) => {
        const n = num(s.waveNames[key], null);
        if (n !== null) out.waveNames[key] = n;
      });
    }
    return out;
  }

  function loadAllSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { showDamage: true, hideGemOffer: true, trackSettings: { ...DEFAULT_TRACK_SETTINGS }, damageThresholds: { ...DEFAULT_DAMAGE_THRESHOLDS } };
      const parsed = JSON.parse(raw);
      const maybeTrackRoot = (parsed && parsed.trackSettings) ? parsed.trackSettings : parsed;
      return {
        showDamage: parsed?.showDamage !== false,
        hideGemOffer: parsed?.hideGemOffer !== false,
        trackSettings: normalizeTrackSettings(maybeTrackRoot),
        damageThresholds: normalizeDamageThresholds(parsed?.damageThresholds)
      };
    } catch (_) {
      return { showDamage: true, hideGemOffer: true, trackSettings: { ...DEFAULT_TRACK_SETTINGS }, damageThresholds: { ...DEFAULT_DAMAGE_THRESHOLDS } };
    }
  }

  function persistAllSettings(next) {
    // Preserve a "minimized" flag the old floating widget may have left
    // behind, instead of clobbering it, in case that script is ever re-enabled.
    let existingMinimized;
    try { existingMinimized = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}').minimized; } catch (_) { /* ignore */ }
    const toSave = { showDamage: next.showDamage, hideGemOffer: next.hideGemOffer, trackSettings: next.trackSettings, damageThresholds: next.damageThresholds };
    if (existingMinimized !== undefined) toSave.minimized = existingMinimized;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
  }

  function nowSec() {
    const local = Math.floor(Date.now() / 1000);
    return live.serverOffsetSec === null ? local : local + live.serverOffsetSec;
  }

  function formatDuration(seconds) {
    const sec = Math.max(0, Math.floor(seconds));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  // Hides (or restores) the anniversary/gem-offer promo banner based on the
  // live.hideGemOffer setting. Cheap + idempotent (just a style toggle), so
  // it's safe to call on every run() pass — it'll catch the banner whenever
  // the site injects it, even if that happens after our own init.
  function applyGemOfferVisibility() {
    document.querySelectorAll('.ny-gems-shop, .anniversary-promo').forEach((el) => {
      el.style.display = live.hideGemOffer ? 'none' : '';
    });
  }

  function showDashToast(msg, type) { Core.ui.toast(msg, type !== 'error', 3000); }

  //adventure guild
  async function runQuestAction(fn, args, btn) {
    const endpoint = QUEST_ACTION_ENDPOINTS[fn];
    if (!endpoint) {
      // No known direct endpoint for this action — just send the person to
      // the real page rather than guessing at a request shape.
      window.location.href = QUESTS_URL;
      return;
    }
    if (!window.confirm(QUEST_ACTION_CONFIRM[fn] || 'Proceed with this action?')) return;

    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '...';

    try {
      const body = new URLSearchParams();
      endpoint.params.forEach((p, i) => body.set(p, args[i]));
      const res = await fetch(endpoint.url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });
      const raw = await res.text();
      let data = null;
      try { data = JSON.parse(raw); } catch (e) { /* not JSON */ }

      if (data && data.status === 'ok') {
        showDashToast(data.message || 'Done!', 'success');
        await refreshLiveData(); // re-pulls the quest board so the panel/badge update in place
      } else {
        showDashToast((data && data.message) || 'Action failed.', 'error');
        btn.disabled = false;
        btn.textContent = originalText;
      }
    } catch (err) {
      showDashToast('Server error.', 'error');
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }

  // ---------- wave bosses (Gates) ----------

  function parseServerEpoch(doc) {
    const serverEl = doc.querySelector('#server_time');
    const epoch = parseInt(serverEl?.getAttribute('data-epoch') || '', 10);
    return Number.isFinite(epoch) ? epoch : null;
  }

  function parseMonsterStatsByName(doc, sourceUrl) {
    // The fight link lives on the .monster-card grid entries (the ones with
    // the "View" button → battle.php?id=...), NOT on .auto-summon-card —
    // that card has no link at all. Same place userDmg already comes from.
    const cards = Array.from(doc.querySelectorAll('[data-name][data-userdmg]'));
    const map = new Map();
    cards.forEach((card) => {
      const rawName = (card.getAttribute('data-name') || '').trim();
      if (!rawName) return;
      const userDmgRaw = card.getAttribute('data-userdmg');
      const userDmg = userDmgRaw !== null ? Number(userDmgRaw) : NaN;
      const isDead = card.getAttribute('data-dead') === '1';

      let fightHref = null;
      const fightLink = card.querySelector('a[href*="battle.php"]');
      if (fightLink) {
        const hrefAttr = fightLink.getAttribute('href');
        if (hrefAttr) {
          try { fightHref = new URL(hrefAttr, sourceUrl).href; }
          catch (e) { fightHref = hrefAttr; }
        }
      }

      const key = bossBaseName(rawName).toLowerCase();
      const existing = map.get(key);
      const candidate = { userDmg: Number.isFinite(userDmg) ? userDmg : null, isDead, fightHref };
      if (!existing) {
        map.set(key, candidate);
      } else {
        // Prefer a card that's alive AND has a real link over a dead one;
        // among ties, prefer whichever has higher recorded damage.
        const score = (c) => (c.fightHref && !c.isDead ? 2 : c.fightHref ? 1 : 0);
        const existingScore = score(existing);
        const newScore = score(candidate);
        if (newScore > existingScore || (newScore === existingScore && (candidate.userDmg ?? -1) > (existing.userDmg ?? -1))) {
          map.set(key, candidate);
        }
      }
    });
    return map;
  }

  function bossBaseName(raw) {
    return String(raw || '')
      .split(',')[0]
      .trim();
  }

  function parseWaveBossCards(doc, sourceLabel, sourceUrl) {
    const cards = Array.from(doc.querySelectorAll('.auto-summon-card'));
    const statsMap = parseMonsterStatsByName(doc, sourceUrl);

    return cards.map((card, index) => {
      const name = (card.querySelector('.auto-summon-name')?.textContent || `Boss ${index + 1}`).trim();
      const statusEl = card.querySelector('.auto-summon-status');
      const statusText = (statusEl?.textContent || '').replace(/\s+/g, ' ').trim();
      const statusClass = statusEl?.className || '';
      const nextTsRaw = parseInt(card.getAttribute('data-next-ts') || '', 10);
      const nextTs = Number.isFinite(nextTsRaw) ? nextTsRaw : null;
      const aliveAttr = card.getAttribute('data-alive') === '1';
      const aliveByClass = /\balive\b/i.test(statusClass);
      const aliveByText = /\b(alive|spawned)\b/i.test(statusText);
      const isSpawned = aliveAttr || aliveByClass || aliveByText;

      const stats = statsMap.get(bossBaseName(name).toLowerCase()) || null;
      let userDmg = stats ? stats.userDmg : null;
      if (!Number.isFinite(userDmg)) {
        const ownDmgRaw = card.getAttribute('data-userdmg');
        if (ownDmgRaw !== null) {
          const parsed = Number(ownDmgRaw);
          if (Number.isFinite(parsed)) userDmg = parsed;
        }
      }

      // The fight link comes from the matching .monster-card (via
      // statsMap above), not from .auto-summon-card itself, which has no
      // link in its markup at all — only used when the boss is up.
      const fightHref = stats ? stats.fightHref : null;

      return {
        name,
        nextTs,
        isSpawned,
        sourceLabel,
        userDmg: Number.isFinite(userDmg) ? userDmg : null,
        url: (isSpawned && fightHref) ? fightHref : sourceUrl
      };
    });
  }

  // Cross-tab-safe (see the SHARED helper at the top of this file). The
  // dashboard only ever wants live (alive) bosses.
  function withMonsterCookies(fn) {
    return Core.cookies.withMode('alive', fn);
  }
  function fetchSingleWave(source) {
    return withMonsterCookies(async () => {
      const res = await fetch(source.url, { method: 'GET', credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const bosses = parseWaveBossCards(doc, source.label, source.url);
      const serverEpoch = parseServerEpoch(doc);
      return { bosses, serverEpoch, label: source.label, url: source.url };
    });
  }

  // ---------- quest board (Adventurer's Guild) ----------
  // Parses the ACTUAL quest-board row markup instead of guessing from the
  // summary banner-pill text — this is also the more likely reason the
  // previous available-quest badge was reading 0 / not updating.

  function findQuestBoardList(doc) {
    // Prefer the scoped selector (the board is the FIRST .quest-list in the
    // section — "Your Active Quests" is a separate, later .quest-list), but
    // fall back to the first .quest-list anywhere if that wrapper isn't found.
    return doc.querySelector('.quests-section > .quest-list') || doc.querySelector('.quest-list');
  }

  // "Your Active Quests" is the LATER .quest-list on the page. Anything
  // still sitting in this list is, by definition, accepted but not turned
  // in yet — so we just need the count/rows, no per-row status parsing.
  function findActiveQuestsList(doc) {
    const lists = Array.from(doc.querySelectorAll('.quest-list'));
    return lists.length > 1 ? lists[lists.length - 1] : null;
  }

  // Generic action extractor: reads any button/a.btn inside a row, parses its
  // onclick as `fnName(arg1, arg2, ..., this)`, and keeps fnName + the
  // non-"this" args. Works for acceptQuest, finishQuest, giveUpQuest,
  // donateGatherItem (id + itemId), or anything else the board adds later,
  // without hardcoding per-function parsing.
  function extractRowActions(row) {
    return Array.from(row.querySelectorAll('button, a.btn')).map((el) => {
      const onclick = el.getAttribute('onclick') || '';
      const m = onclick.match(/^\s*(\w+)\(([^)]*)\)/);
      if (!m) return null;
      const args = m[2].split(',').map((a) => a.trim()).filter((a) => a && a !== 'this');
      return {
        fn: m[1],
        args,
        label: (el.textContent || '').replace(/\s+/g, ' ').trim() || m[1],
        disabled: el.disabled === true || el.hasAttribute('disabled')
      };
    }).filter(Boolean);
  }

  function parseActiveQuestRow(row) {
    const title = (row.querySelector('.quest-main-title')?.textContent || row.textContent || '')
    .replace(/\s+/g, ' ').trim();
    const reward = (row.querySelector('.quest-side .quest-reward')?.textContent || '')
    .replace(/\s+/g, ' ').trim();
    const progress = (row.querySelector('.quest-progress')?.textContent || '')
    .replace(/\s+/g, ' ').trim();
    return { title: title || 'Quest', reward, progress, actions: extractRowActions(row) };
  }

  function parseQuestRow(row) {
    const title = (row.querySelector('.quest-main-title')?.textContent || '').replace(/\s+/g, ' ').trim();
    const reward = (row.querySelector('.quest-side .quest-reward')?.textContent || '').replace(/\s+/g, ' ').trim();
    const cooldownEl = row.querySelector('.quest-cooldown-box .quest-cooldown-timer[data-cooldown-ts]');
    const statusNote = row.querySelector('.quest-status-note');
    const cooldownTs = cooldownEl ? parseInt(cooldownEl.getAttribute('data-cooldown-ts'), 10) : null;

    let status = 'available';
    let statusText = '';
    if (Number.isFinite(cooldownTs)) {
      status = 'cooldown';
    } else if (statusNote) {
      const noteText = statusNote.textContent.replace(/\s+/g, ' ').trim();
      if (/finish or abandon/i.test(noteText)) {
        status = 'available';
      } else {
        status = 'blocked';
        statusText = noteText;
      }
    }

    return { title: title || 'Quest', reward, status, statusText, cooldownTs, actions: extractRowActions(row) };
  }

  async function fetchQuestBoard() {
    const html = await Core.net.fetchText(QUESTS_URL, { ttl: 10000 });
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const board = findQuestBoardList(doc);
    if (!board) throw new Error('Could not find the quest board.');
    const rows = Array.from(board.querySelectorAll(':scope > .quest-row')).map(parseQuestRow);
    const available = rows.filter((r) => r.status === 'available').length;

    const activeList = findActiveQuestsList(doc);
    let active = [];
    if (activeList) {
      active = Array.from(activeList.querySelectorAll(':scope > .quest-row')).map(parseActiveQuestRow);
      // Fallback if the active list doesn't reuse .quest-row markup — count
      // its direct children instead of silently reading 0.
      if (!active.length) {
        active = Array.from(activeList.children).map((el) => ({
          title: el.textContent.replace(/\s+/g, ' ').trim() || 'Quest',
          reward: ''
        }));
      }
    }

    return { rows, available, active };
  }

  // ---------- battle pass daily quests ----------

  function findBattlePassQuestCard(doc) {
    return Array.from(doc.querySelectorAll('.card')).find((c) => {
      const t = c.querySelector('.title');
      return t && /daily quests/i.test(t.textContent || '');
    }) || null;
  }

  function parseBattlePassQuestRow(row) {
    const title = (row.querySelector(':scope > div > strong')?.textContent || '').replace(/\s+/g, ' ').trim();

    const metaEl = Array.from(row.querySelectorAll(':scope > .muted')).find((m) => /target/i.test(m.textContent || ''));
    const meta = metaEl ? metaEl.textContent.replace(/\s+/g, ' ').trim() : '';

    // The progress line isn't a direct child of .quest — it's nested one
    // level down inside the wrapper div alongside the .progress bar.
    const progressEl = Array.from(row.querySelectorAll(':scope > div .muted'))
    .find((m) => /\d+\s*\/\s*\d+/.test(m.textContent || ''));
    const progressText = progressEl ? progressEl.textContent.replace(/\s+/g, ' ').trim() : '';

    const fractionMatch = progressText.match(/(\d+)\s*\/\s*(\d+)/);
    const current = fractionMatch ? parseInt(fractionMatch[1], 10) : null;
    const target = fractionMatch ? parseInt(fractionMatch[2], 10) : null;
    const completed = /✅|completed/i.test(progressText);

    return { title: title || 'Quest', meta, current, target, completed };
  }

  async function fetchBattlePassSnapshot() {
    const html = await Core.net.fetchText(BATTLE_PASS_URL, { ttl: 10000 });
    const doc = new DOMParser().parseFromString(html, 'text/html');

    const card = findBattlePassQuestCard(doc);
    if (!card) return { dayLabel: '', rows: [], unfinished: 0 };

    const dayLabel = (card.querySelector('.title')?.textContent || '').replace(/\s+/g, ' ').trim();
    const rows = Array.from(card.querySelectorAll(':scope > .quest')).map(parseBattlePassQuestRow);
    const unfinished = rows.filter((r) => !r.completed).length;

    console.log({ dayLabel, rows, unfinished });
    return { dayLabel, rows, unfinished };
  }

  // ---------- PvP tokens ----------

  function parseTokensFromPill(pill) {
    if (!pill) return { tokens: null, maxTokens: null };
    const valueEl = pill.querySelector('span');
    const rawText = (valueEl?.textContent || pill.textContent || '').replace(/\s+/g, ' ').trim();
    const slashMatch = rawText.match(/(\d+)\s*\/\s*(\d+)/);
    if (slashMatch) {
      return { tokens: parseInt(slashMatch[1], 10), maxTokens: parseInt(slashMatch[2], 10) };
    }
    const digits = rawText.replace(/[^\d]/g, '');
    return { tokens: digits ? parseInt(digits, 10) : null, maxTokens: null };
  }

  function findTokensPillIn(scope) {
    if (!scope) return null;
    return Array.from(scope.querySelectorAll('.info-pill')).find((p) => /tokens\s*:/i.test(p.textContent || '')) || null;
  }

  // Scoped to the Solo Ladder .section (matched by its title text) so we
  // never accidentally grab the party card's Tokens pill instead.
  function findSoloLadderSection(doc) {
    return Array.from(doc.querySelectorAll('.section')).find((s) => {
      const t = s.querySelector('.section-title');
      return t && /solo/i.test(t.textContent || '') && /ladder/i.test(t.textContent || '');
    }) || null;
  }

  function parsePvpTokens(doc) {
    const soloSection = findSoloLadderSection(doc);
    const solo = parseTokensFromPill(findTokensPillIn(soloSection));

    if (!Number.isFinite(solo.tokens)) {
      const coinEl = doc.querySelector('#pvp-coins');
      if (coinEl) {
        const tokenText = (coinEl.textContent || '').replace(/[^\d]/g, '');
        const parsed = parseInt(tokenText || '', 10);
        if (Number.isFinite(parsed)) solo.tokens = parsed;
        const coinRowText = (coinEl.closest('.coin-row')?.textContent || '').replace(/\s+/g, ' ').trim();
        const maxMatch = coinRowText.match(/\/\s*(\d+)/);
        if (maxMatch) solo.maxTokens = parseInt(maxMatch[1], 10);
      }
    }

    // Party tokens only exist inside an actual .party-card — if the player
    // isn't currently in a party, that card isn't rendered at all, so this
    // just stays null and the panel skips the row entirely.
    const partyCard = doc.querySelector('.section--party-ladder .party-card');
    const party = parseTokensFromPill(findTokensPillIn(partyCard));

    return {
      soloTokens: Number.isFinite(solo.tokens) ? solo.tokens : null,
      soloMaxTokens: Number.isFinite(solo.maxTokens) ? solo.maxTokens : null,
      partyTokens: Number.isFinite(party.tokens) ? party.tokens : null,
      partyMaxTokens: Number.isFinite(party.maxTokens) ? party.maxTokens : null
    };
  }

  async function fetchPvpSnapshot() {
    const html = await Core.net.fetchText(PVP_URL, { ttl: 10000 });
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const { soloTokens, soloMaxTokens, partyTokens, partyMaxTokens } = parsePvpTokens(doc);
    if (!Number.isFinite(soloTokens)) throw new Error('Could not parse PvP token count.');
    return { soloTokens, soloMaxTokens, partyTokens, partyMaxTokens };
  }

  // ---------- guild dungeon bosses (Guild) ----------

  function extractActiveDungeonIds(doc) {
    const result = { easy: [], hard: [], crucible: [] };
    doc.querySelectorAll('.grid:not(.ended) .card').forEach((card) => {
      const link = card.querySelector('a[href*="guild_dungeon_enter.php?id="]');
      const titleEl = card.querySelector('.h');
      if (!link || !titleEl) return;
      const id = new URL(link.href, window.location.origin).searchParams.get('id');
      const title = (titleEl.textContent || '').trim().toLowerCase();
      if (!id) return;
      if (title.includes('shadowbridge')) result.easy.push(id);
      else if (title.includes('castle')) result.hard.push(id);
      else if (title.includes('crucible')) result.crucible.push(id);
    });
    return result;
  }

  // "That route is still sealed." pages render as basically nothing — no
  // .wrap/.row/.pill header, no .mon card — so the normal locked-pill check
  // never fires and it falls through to "not spawned" instead. Detect the
  // bare sealed-message body directly and treat it the same as locked.
  function isSealedRouteDoc(doc) {
    return /route is still sealed/i.test(doc.body?.textContent || '');
  }

  async function fetchDungeonBossLocationState(instanceId, locId) {
    const url = `${DUNGEON_LOC_URL}?instance_id=${encodeURIComponent(instanceId)}&location_id=${locId}`;
    const res = await fetch(url, { method: 'GET', credentials: 'same-origin', cache: 'no-store' });

    // Sealed routes come back as an HTTP 403 whose body is just the sealed
    // message — read the body BEFORE checking res.ok, or the 403 throws
    // before we ever get a chance to recognize this case.
    const html = await res.text();
    if (/route is still sealed/i.test(html)) {
      return { isSpawned: false, isDead: false, image: '', isLocked: true, dgmid: null, instanceId };
    }
    if (!res.ok) throw new Error(`Dungeon location HTTP ${res.status}`);

    const doc = new DOMParser().parseFromString(html, 'text/html');

    const headerPills = Array.from(doc.querySelectorAll('.wrap .row .pill')).map((p) => (p.textContent || '').trim().toLowerCase());
    const isLocked = headerPills.includes('locked');
    const bossCard = doc.querySelector('.mon');
    const imgSrcRaw = bossCard?.querySelector('img')?.getAttribute('src') || '';
    const image = imgSrcRaw ? new URL(imgSrcRaw, window.location.origin).href : '';

    if (!bossCard) return { isSpawned: false, isDead: false, image: '', isLocked, dgmid: null, instanceId };
    const isDead = bossCard.classList.contains('dead');

    function extractDgmidFromHref(href) {
      if (!href) return null;
      try {
        const url = new URL(href, window.location.origin);
        const fromQuery = url.searchParams.get('dgmid');
        if (fromQuery) return fromQuery;
      } catch (_) { /* malformed href, fall through to regex */ }
      const m = href.match(/[?&]dgmid=(\d+)/);
      return m ? m[1] : null;
    }

    let dgmid = null;
    const candidatesInsideCard = ['a.btn[href*="dgmid="]', 'a[href*="dgmid="]', 'a[href*="battle.php"]'];
    for (const sel of candidatesInsideCard) {
      if (dgmid) break;
      const el = bossCard.querySelector(sel);
      if (el) dgmid = extractDgmidFromHref(el.getAttribute('href'));
    }
    if (!dgmid) {
      const docCandidates = ['a[href*="battle.php"][href*="dgmid="]', 'a[href*="dgmid="]'];
      for (const sel of docCandidates) {
        if (dgmid) break;
        doc.querySelectorAll(sel).forEach((el) => {
          if (dgmid) return;
          dgmid = extractDgmidFromHref(el.getAttribute('href'));
        });
      }
    }
    if (!dgmid) {
      const withAttr = bossCard.querySelector('[data-dgmid]') || doc.querySelector('[data-dgmid]');
      if (withAttr) dgmid = withAttr.getAttribute('data-dgmid');
    }
    if (!dgmid) {
      const m = (doc.documentElement?.innerHTML || '').match(/[?&]dgmid=(\d+)/);
      if (m) dgmid = m[1];
    }

    return { isSpawned: !isDead && !isLocked, isDead, image, isLocked, dgmid, instanceId };
  }

  async function fetchDungeonBossDamage(instanceId, dgmid) {
    if (!instanceId || !dgmid) return null;
    try {
      const url = `${DUNGEON_BATTLE_URL}?dgmid=${encodeURIComponent(dgmid)}&instance_id=${encodeURIComponent(instanceId)}`;
      const res = await fetch(url, { method: 'GET', credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) return null;
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const dmgEl = doc.getElementById('yourDamageValue');
      if (!dmgEl) return null;
      const parsed = parseInt((dmgEl.textContent || '').replace(/[^\d]/g, ''), 10);
      return Number.isFinite(parsed) ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  async function resolveDungeonLocation(instanceIds, locDef) {
    if (!instanceIds.length) {
      return { label: locDef.label, locId: locDef.locId, isSpawned: false, isDead: false, isLocked: false, userDmg: null, doneByDamage: false, dgmid: null, instanceId: null };
    }
    const results = await Promise.all(
      instanceIds.map((id) => fetchDungeonBossLocationState(id, locDef.locId).catch(() => null))
    );
    const valid = results.filter(Boolean);
    const spawned = valid.find((r) => r.isSpawned) || null;
    const dead = valid.find((r) => r.isDead) || null;
    const anyLocked = valid.length > 0 && valid.every((r) => r.isLocked);

    let userDmg = null;
    if (spawned && spawned.dgmid && spawned.instanceId) {
      userDmg = await fetchDungeonBossDamage(spawned.instanceId, spawned.dgmid);
    }

    const threshold = live.damageThresholds[locDef.thresholdKey];
    const doneByDamage = Number.isFinite(userDmg) && Number.isFinite(threshold) && userDmg >= threshold;

    return {
      label: locDef.label,
      locId: locDef.locId,
      isSpawned: !!spawned,
      isDead: !spawned && !!dead,
      isLocked: anyLocked && !spawned && !dead,
      userDmg,
      doneByDamage,
      dgmid: spawned?.dgmid || null,
      instanceId: spawned?.instanceId || null
    };
  }

  function parseSwarmMonsterRef(monEl, sourceUrl) {
    const isDead = monEl.classList.contains('dead');

    const nameContainer = monEl.querySelector('div[style*="font-weight:700"]');
    let name = '';
    if (nameContainer) {
      const clone = nameContainer.cloneNode(true);
      clone.querySelectorAll('.pill, .row').forEach((el) => el.remove());
      name = clone.textContent.replace(/\s+/g, ' ').trim();
    }

    const fightLink = monEl.querySelector('a.btn[href*="battle.php"]');
    let dgmid = null, instanceId = null;
    if (fightLink) {
      const hrefAttr = fightLink.getAttribute('href');
      try {
        const u = new URL(hrefAttr, sourceUrl);
        dgmid = u.searchParams.get('dgmid');
        instanceId = u.searchParams.get('instance_id');
      } catch (e) { /* ignore */ }
    }
    return { name, isDead, dgmid, instanceId };
  }

  // Only "Gribble ..." monsters count toward the swarm total — anything else
  // in that location (other mob types that may share the room) is ignored.
  function parseSwarmLocationPage(doc, sourceUrl) {
    return Array.from(doc.querySelectorAll('.mon'))
      .map((el) => parseSwarmMonsterRef(el, sourceUrl))
      .filter((m) => /gribble/i.test(m.name));
  }

  async function fetchSwarmLocationState(instanceId, locId) {
    const url = `${DUNGEON_LOC_URL}?instance_id=${encodeURIComponent(instanceId)}&location_id=${locId}`;
    const res = await fetch(url, { method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) throw new Error(`Dungeon location HTTP ${res.status}`);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');


    const headerPills = Array.from(doc.querySelectorAll('.wrap .row .pill')).map((p) => (p.textContent || '').trim().toLowerCase());
    if (headerPills.includes('locked')) return { isLocked: true, monsters: [] };

    return { isLocked: false, monsters: parseSwarmLocationPage(doc, url) };
  }

  // Aggregates a whole territory down to hit/total counts. Damage still needs
  // one battle.php fetch per gribble (dead or alive — a dead one's damage is
  // still what decides whether it counts as "hit"), but only the aggregate
  // survives; no per-monster rows are kept or rendered.
  async function resolveSwarmLocationCounts(instanceIds, locDef) {
    if (!instanceIds.length) {
      return { label: locDef.label, locId: locDef.locId, instanceId: null, isLocked: false, total: 0, hit: 0, notHit: 0 };
    }

    const results = await Promise.all(
      instanceIds.map((id) => fetchSwarmLocationState(id, locDef.locId).catch(() => null))
    );
    const valid = results.filter(Boolean);
    const anyLocked = valid.length > 0 && valid.every((r) => r.isLocked);
    const monsters = valid.flatMap((r) => r.monsters);

    const damages = await Promise.all(monsters.map((m) =>
                                                   (m.dgmid && m.instanceId) ? fetchDungeonBossDamage(m.instanceId, m.dgmid) : Promise.resolve(null)
                                                  ));
    const hit = damages.filter((d) => Number.isFinite(d) && d >= live.damageThresholds.swarm).length;

    return {
      label: locDef.label,
      locId: locDef.locId,
      instanceId: instanceIds[0],
      isLocked: anyLocked && monsters.length === 0,
      total: monsters.length,
      hit,
      notHit: Math.max(monsters.length - hit, 0)
    };
  }

  async function fetchDungeonSnapshot(includeEasy, includeHard, includeCrucible, includeEasySwarm) {
    const res = await fetch(DUNGEON_LIST_URL, { method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) throw new Error(`Dungeon page HTTP ${res.status}`);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');

    const ids = extractActiveDungeonIds(doc);

    const [easyRows, hardRows, crucibleRows, easySwarmLocs] = await Promise.all([
      includeEasy ? Promise.all(DUNGEON_BOSS_LOCATIONS.easy.map((locDef) => resolveDungeonLocation(ids.easy, locDef))) : Promise.resolve([]),
      includeHard ? Promise.all(DUNGEON_BOSS_LOCATIONS.hard.map((locDef) => resolveDungeonLocation(ids.hard, locDef))) : Promise.resolve([]),
      includeCrucible ? Promise.all(DUNGEON_BOSS_LOCATIONS.crucible.map((locDef) => resolveDungeonLocation(ids.crucible, locDef))) : Promise.resolve([]),
      includeEasySwarm ? Promise.all(DUNGEON_SWARM_LOCATIONS.easy.map((locDef) => resolveSwarmLocationCounts(ids.easy, locDef))) : Promise.resolve([])
    ]);

    return {
      easy: { open: includeEasy ? ids.easy.length > 0 : false, rows: easyRows },
      hard: { open: includeHard ? ids.hard.length > 0 : false, rows: hardRows },
      crucible: { open: includeCrucible ? ids.crucible.length > 0 : false, rows: crucibleRows },
      easySwarm: { open: includeEasySwarm ? ids.easy.length > 0 : false, locations: easySwarmLocs }
    };
  }

  // ---------- pull it all together ----------

  async function refreshLiveData() {
    // Always fetch everything, regardless of trackSettings — the toggles
    // now only control which categories count toward the notification
    // badge (see renderAllBadgesAndPanels), not what gets fetched/shown.
    const [waveSettled, questSettled, battlePassSettled, pvpSettled, dungeonSettled] = await Promise.all([
      Promise.allSettled(SOURCE_WAVES.map(fetchSingleWave)),
      Promise.allSettled([fetchQuestBoard()]),
      Promise.allSettled([fetchBattlePassSnapshot()]),
      Promise.allSettled([fetchPvpSnapshot()]),
      Promise.allSettled([fetchDungeonSnapshot(true, true, true, true)])
    ]);

    const waveOk = waveSettled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    live.waves = waveOk.flatMap((x) => x.bosses.map((b) => ({ ...b })));
    const epochSource = waveOk.find((x) => Number.isFinite(x.serverEpoch));
    if (epochSource) live.serverOffsetSec = epochSource.serverEpoch - Math.floor(Date.now() / 1000);

    const q = questSettled.find((r) => r.status === 'fulfilled');
    live.quests = q
      ? { rows: q.value.rows, available: q.value.available, active: q.value.active, error: null }
    : { rows: [], available: 0, active: [], error: 'unavailable' };

    const bp = battlePassSettled.find((r) => r.status === 'fulfilled');
    live.battlepass = bp
      ? { dayLabel: bp.value.dayLabel, rows: bp.value.rows, unfinished: bp.value.unfinished, error: null }
    : { dayLabel: '', rows: [], unfinished: 0, error: 'unavailable' };

    const p = pvpSettled.find((r) => r.status === 'fulfilled');
    live.pvp = p
      ? { soloTokens: p.value.soloTokens, soloMaxTokens: p.value.soloMaxTokens, partyTokens: p.value.partyTokens, partyMaxTokens: p.value.partyMaxTokens, error: null }
    : { soloTokens: null, soloMaxTokens: null, partyTokens: null, partyMaxTokens: null, error: 'unavailable' };

    const d = dungeonSettled.find((r) => r.status === 'fulfilled');
    live.dungeon = d ? d.value : { easy: { open: false, rows: [] }, hard: { open: false, rows: [] }, crucible: { open: false, rows: [] }, easySwarm: { open: false, locations: [] } };

    renderAllBadgesAndPanels();
  }

  /* =====================================================================
     BADGES + HOVER/TAP PANELS
     ===================================================================== */

  function findTile(key) {
    return document.querySelector(`[data-dc-key="${key}"]`) ||
      document.querySelector(`a[href="${KEY_HREF[key]}"], a[href$="/${KEY_HREF[key]}"]`);
  }

  function setBadge(tile, value, variant) {
    if (!tile) return;
    let badge = tile.querySelector(':scope > .dc-live-badge');
    if (value === null || value === undefined) {
      badge?.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'dc-live-badge';
      tile.appendChild(badge);
    }
    badge.classList.toggle('dc-live-badge-info', variant === 'info');
    badge.classList.toggle('dc-live-badge-action', variant !== 'info');
    badge.textContent = String(value);
  }

  function ensurePanel(tile) {
    let panel = tile.querySelector(':scope > .dc-live-panel');
    if (panel) return panel;
    panel = document.createElement('div');
    panel.className = 'dc-live-panel';
    panel.addEventListener('click', (e) => {
      const btn = e.target.closest('.dc-live-action-btn');
      if (btn) {
        // The panel lives inside the tile's own <a href="..."> wrapper, so
        // without preventDefault the browser still follows that link the
        // instant this click finishes — cancelling the fetch below mid-flight.
        // stopPropagation alone does NOT stop that native anchor navigation.
        e.preventDefault();
        e.stopPropagation();
        if (btn.dataset.fn && !btn.disabled) {
          let args = [];
          try { args = JSON.parse(btn.dataset.args || '[]'); } catch (err) { args = []; }
          runQuestAction(btn.dataset.fn, args, btn);
        }
        return;
      }
      // Everything else inside the panel (real <a class="dc-live-row"> links
      // for Gates/Guild, or static rows) should keep its normal behavior —
      // just stop it bubbling up and re-triggering the tile's own toggle logic.
      e.stopPropagation();
    });
    tile.appendChild(panel);
    return panel;
  }

  function openPanel(tile) {
    const panel = tile.querySelector(':scope > .dc-live-panel');
    if (!panel) return;
    document.querySelectorAll('.dc-live-panel.dc-open').forEach((p) => {
      if (p !== panel) {
        p.classList.remove('dc-open', 'dc-panel-flip', 'dc-panel-up');
        p.closest('.dc-menu-card')?.classList.remove('dc-panel-open');
      }
    });
    tile.classList.add('dc-panel-open');
    panel.classList.remove('dc-panel-flip', 'dc-panel-up');
    panel.classList.add('dc-open');

    const tileRect = tile.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();

    if (panelRect.right > window.innerWidth - 8) panel.classList.add('dc-panel-flip');

    // Reserve extra room for the browser's native link-preview status bar,
    // which overlaps the bottom of the viewport whenever a link is hovered
    // but isn't reflected in window.innerHeight.
    const STATUS_BAR_SAFETY_PX = 44;
    const EDGE_SAFETY_PX = 8;

    // Measure "space below" against the whole scrollable PAGE, not just the
    // current viewport. Panels aren't fixed-position, so if the page has
    // room below the tile, the page can just scroll to reveal it — a short
    // browser window isn't a real reason to flip the panel upward into
    // the header. "Space above" stays viewport-relative since that's a
    // real hard limit (nothing exists above the top of the screen).
    const tileBottomInDoc = tileRect.bottom + window.scrollY;
    const spaceBelowDoc = document.documentElement.scrollHeight - tileBottomInDoc - STATUS_BAR_SAFETY_PX;
    const spaceAboveViewport = tileRect.top - EDGE_SAFETY_PX;

    if (panelRect.height > spaceBelowDoc && spaceAboveViewport > spaceBelowDoc) {
      // Genuinely near the bottom of the page (not just a short viewport)
      // with more usable room above than below.
      panel.classList.add('dc-panel-up');
      panel.style.maxHeight = Math.max(120, spaceAboveViewport) + 'px';
    } else {
      // Opening down. If the panel is simply taller than the viewport
      // itself, cap it to one viewport's worth and let it scroll
      // internally instead of growing indefinitely.
      const viewportCap = window.innerHeight - EDGE_SAFETY_PX * 2;
      if (panelRect.height > viewportCap) {
        panel.style.maxHeight = Math.max(120, viewportCap) + 'px';
      }
    }
  }

  // Browser zoom (Ctrl +/-) fires a resize event, not mouseleave — without
  // this, a panel left open before a zoom change stays stuck open at a
  // position that was only ever validated for the old zoom level.
  window.addEventListener('resize', () => {
    document.querySelectorAll('.dc-live-panel.dc-open').forEach((p) => {
      p.classList.remove('dc-open', 'dc-panel-flip', 'dc-panel-up');
      p.style.maxHeight = '';
      p.closest('.dc-menu-card')?.classList.remove('dc-panel-open');
    });
  });
  function closePanel(tile) {
    tile.classList.remove('dc-panel-open');
    const panel = tile.querySelector(':scope > .dc-live-panel');
    if (panel) {
      panel.classList.remove('dc-open', 'dc-panel-flip', 'dc-panel-up');
      panel.style.maxHeight = '';
    }
  }
  // Desktop/mouse: hover opens the panel, the tile's own click still
  // navigates normally. Touch (no hover capability): the first tap opens
  // the panel instead of navigating; a second tap (panel already open)
  // falls through and navigates as usual.
  function attachPanelInteraction(tile) {
    if (tile.dataset.dcPanelAttached === '1') return;
    tile.dataset.dcPanelAttached = '1';
    ensurePanel(tile);
    const supportsHover = window.matchMedia('(hover: hover)').matches;
    if (supportsHover) {
      let closeTimer = null;
      tile.addEventListener('mouseenter', () => {
        if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
        openPanel(tile);
      });
      tile.addEventListener('mouseleave', () => {
        closeTimer = setTimeout(() => closePanel(tile), 150);
      });
    } else {
      tile.addEventListener('click', (e) => {
        const panel = tile.querySelector(':scope > .dc-live-panel');
        if (panel && !panel.classList.contains('dc-open')) {
          e.preventDefault();
          openPanel(tile);
        }
      });
      document.addEventListener('click', (e) => {
        if (!tile.contains(e.target)) closePanel(tile);
      });
    }
  }

  function sortWaveRows(rows) {
    return [...rows].sort((a, b) => {
      if (a.isSpawned !== b.isSpawned) return a.isSpawned ? -1 : 1;
      return (a.nextTs ?? Infinity) - (b.nextTs ?? Infinity);
    });
  }

  function questSortRank(r) {
    if (r.status === 'available') return 0;
    if (r.status === 'cooldown') return 1;
    return 2;
  }
  function sortQuestRows(rows) {
    return [...rows].sort((a, b) => {
      const ra = questSortRank(a), rb = questSortRank(b);
      if (ra !== rb) return ra - rb;
      if (ra === 1) return (a.cooldownTs ?? Infinity) - (b.cooldownTs ?? Infinity);
      return 0;
    });
  }

  function renderGatesPanel(panel) {
    if (!live.waves.length) {
      panel.innerHTML = '<div class="dc-live-empty">No wave bosses tracked right now.</div>';
      return;
    }
    const now = nowSec();
    const grouped = groupWavesBySource(live.waves);
    const sections = Array.from(grouped.entries())
    .filter(([, list]) => list.length)
    .map(([label, list]) => {
      const rows = sortWaveRows(list);
      const heading = WAVE_GROUP_LABELS[label] || label;
      return `
          <div class="dc-live-subtitle">${escapeHtml(heading)}</div>
          ${rows.map((b) => {
        const tag = b.isSpawned
        ? `<span class="dc-live-tag dc-live-tag-spawned">Spawned${Number.isFinite(b.userDmg) && live.showDamage ? ' — ' + escapeHtml(formatBigNumber(b.userDmg)) : ''}</span>`
              : (b.nextTs ? `<span class="dc-live-tag dc-live-tag-wait">In ${escapeHtml(formatDuration(b.nextTs - now))}</span>` : `<span class="dc-live-tag dc-live-tag-wait">Waiting</span>`);
          return `<a class="dc-live-row" href="${escapeAttr(b.url || '#')}">
              <span class="dc-live-row-name">${escapeHtml(b.name)}</span>
              ${tag}
            </a>`;
        }).join('')}
        `;
      }).join('');

    panel.innerHTML = `
      ${sections}
    `;
  }

  function renderWaveThresholdRows(modal) {
    const container = modal.querySelector('.dc-live-wave-thresholds');
    if (!container) return;

    // Dedupe by normalized name — one editable row per actual monster,
    // not one per sighting/source.
    const seen = new Map();
    live.waves.forEach((b) => {
      const key = normalizeWaveBossKey(b.name);
      if (!key || seen.has(key)) return;
      seen.set(key, b);
    });

    if (!seen.size) {
      container.innerHTML = '<div class="dc-live-empty">No wave bosses detected yet — reopen this after the next refresh.</div>';
      return;
    }

    container.innerHTML = Array.from(seen.entries()).map(([key, b]) => {
      const source = SOURCE_WAVES.find((s) => s.label === b.sourceLabel);
      const fallback = source ? (live.damageThresholds[source.settingKey] ?? DEFAULT_DAMAGE_THRESHOLDS[source.settingKey]) : 0;
      return `<label class="dc-live-threshold">
        <span>${escapeHtml(b.name)}</span>
        <span class="dc-live-threshold-input-wrap">
          <input type="text" inputmode="numeric" data-t-name="${escapeAttr(key)}" data-t-fallback="${fallback}" placeholder="${fallback}">
          <span class="dc-live-threshold-preview"></span>
        </span>
      </label>`;
    }).join('');
  }


  function renderActionButtons(actions) {
    if (!actions || !actions.length) return '';
    return `<div class="dc-live-actions">${actions.map((a) => {
      if (a.disabled) {
        return `<button type="button" class="dc-live-action-btn" disabled>${escapeHtml(a.label)}</button>`;
      }
      return `<button type="button" class="dc-live-action-btn" data-fn="${escapeAttr(a.fn)}" data-args="${escapeAttr(JSON.stringify(a.args))}">${escapeHtml(a.label)}</button>`;
    }).join('')}</div>`;
  }

  function renderQuestsPanel(panel) {
    const q = live.quests;
    if (q.error) {
      panel.innerHTML = '<div class="dc-live-empty">Could not load the quest board.</div>';
      return;
    }
    if (!q.rows.length && !(q.active && q.active.length)) {
      panel.innerHTML = '<div class="dc-live-empty">No quests posted right now.</div>';
      return;
    }
    const now = nowSec();
    const boardRows = sortQuestRows(q.rows);
    const unfinished = q.available + (q.active?.length || 0);
    panel.innerHTML = `
      <div class="dc-live-title">Quests — ${unfinished} unfinished</div>
      ${q.active && q.active.length ? `
        <div class="dc-live-subtitle">Accepted, not turned in</div>
        ${q.active.map((r) => `
          <div class="dc-live-row dc-live-row-static dc-live-row-multiline">
            <div class="dc-live-row-main">
              <span class="dc-live-row-name">${escapeHtml(r.title)}</span>
              <span class="dc-live-tag dc-live-tag-spawned">Active</span>
            </div>
            ${r.reward ? `<div class="dc-live-row-sub">${escapeHtml(r.reward)}</div>` : ''}
            ${r.progress ? `<div class="dc-live-row-sub">${escapeHtml(r.progress)}</div>` : ''}
            ${renderActionButtons(r.actions)}
          </div>
        `).join('')}
      ` : ''}
      ${boardRows.length ? `
        <div class="dc-live-subtitle">On the board</div>
        ${boardRows.map((r) => {
      let tag;
      if (r.status === 'available') tag = '<span class="dc-live-tag dc-live-tag-spawned">Available</span>';
      else if (r.status === 'cooldown') tag = `<span class="dc-live-tag dc-live-tag-wait">${escapeHtml(formatDuration(r.cooldownTs - now))}</span>`;
      else tag = `<span class="dc-live-tag dc-live-tag-blocked">${escapeHtml(r.statusText || 'Blocked')}</span>`;
      return `<div class="dc-live-row dc-live-row-static dc-live-row-multiline">
            <div class="dc-live-row-main">
              <span class="dc-live-row-name">${escapeHtml(r.title)}</span>
              ${tag}
            </div>
            ${r.reward ? `<div class="dc-live-row-sub">${escapeHtml(r.reward)}</div>` : ''}
            ${renderActionButtons(r.actions)}
          </div>`;
    }).join('')}
      ` : ''}
      <a class="dc-live-footer-link" href="${QUESTS_URL}">Open Adventurer's Guild →</a>
    `;
  }

  function renderBattlePassPanel(panel) {
    const bp = live.battlepass;
    if (bp.error) {
      panel.innerHTML = '<div class="dc-live-empty">Could not load Battle Pass quests.</div>';
      return;
    }
    if (!bp.rows.length) {
      panel.innerHTML = '<div class="dc-live-empty">No daily quests posted right now.</div>';
      return;
    }
    const sorted = [...bp.rows].sort((a, b) => Number(a.completed) - Number(b.completed));
    panel.innerHTML = `
      <div class="dc-live-title">${escapeHtml(bp.dayLabel || 'Battle Pass Quests')}</div>
      ${sorted.map((r) => {
      const tag = r.completed
      ? '<span class="dc-live-tag dc-live-tag-spawned">✅ Completed</span>'
      : `<span class="dc-live-tag dc-live-tag-wait">${escapeHtml(r.current !== null && r.target !== null ? `${r.current}/${r.target}` : 'In progress')}</span>`;
      return `<div class="dc-live-row dc-live-row-static dc-live-row-multiline">
          <div class="dc-live-row-main">
            <span class="dc-live-row-name">${escapeHtml(r.title)}</span>
            ${tag}
          </div>
          ${r.meta ? `<div class="dc-live-row-sub">${escapeHtml(r.meta)}</div>` : ''}
        </div>`;
    }).join('')}
      <a class="dc-live-footer-link" href="${BATTLE_PASS_URL}">Open Battle Pass →</a>
    `;
  }

  function renderGuildPanel(panel) {
    function renderBossRows(rows) {
      return rows.map((data) => {
        let tag;
        if (data.isSpawned && data.doneByDamage) {
          // Spawned, but you've already hit your set threshold — no longer counted toward the badge.
          tag = `<span class="dc-live-tag dc-live-tag-spawned">Done${Number.isFinite(data.userDmg) && live.showDamage ? ' — ' + escapeHtml(formatBigNumber(data.userDmg)) : ''}</span>`;
        } else if (data.isSpawned) {
          tag = `<span class="dc-live-tag dc-live-tag-spawned">Spawned${Number.isFinite(data.userDmg) && live.showDamage ? ' — ' + escapeHtml(formatBigNumber(data.userDmg)) : ''}</span>`;
        } else if (data.isDead) tag = '<span class="dc-live-tag dc-live-tag-blocked">Dead</span>';
        else if (data.isLocked) tag = '<span class="dc-live-tag dc-live-tag-blocked">Locked</span>';
        else tag = '<span class="dc-live-tag dc-live-tag-wait">Not spawned</span>';
        const href = (data.isSpawned && data.dgmid && data.instanceId)
        ? `${DUNGEON_BATTLE_URL}?dgmid=${encodeURIComponent(data.dgmid)}&instance_id=${encodeURIComponent(data.instanceId)}`
          : DUNGEON_LIST_URL;
        return `<a class="dc-live-row" href="${escapeAttr(href)}"><span class="dc-live-row-name">${escapeHtml(data.label)}</span>${tag}</a>`;
      }).join('');
    }

    function renderSwarmRows(locations) {
      return locations.map((loc) => {
        const href = loc.instanceId
        ? `${DUNGEON_LOC_URL}?instance_id=${encodeURIComponent(loc.instanceId)}&location_id=${loc.locId}`
          : DUNGEON_LIST_URL;
        const tagClass = loc.isLocked
        ? 'dc-live-tag-blocked'
        : (loc.hit >= loc.total && loc.total > 0 ? 'dc-live-tag-spawned' : 'dc-live-tag-wait');
        const tagText = loc.isLocked ? 'Locked' : `${loc.hit}/${loc.total} hit`;
        return `<a class="dc-live-row" href="${escapeAttr(href)}"><span class="dc-live-row-name">${escapeHtml(loc.label)}</span><span class="dc-live-tag ${tagClass}">${escapeHtml(tagText)}</span></a>`;
      }).join('');
    }

    let html = '<div class="dc-live-title">Guild Dungeon</div>';

    const easyOpen = live.dungeon.easy.open || live.dungeon.easySwarm.open;
    html += `<div class="dc-live-subtitle">Shadowbridge (Easy)</div>`;
    if (!easyOpen) {
      html += `<div class="dc-live-row dc-live-row-static"><span class="dc-live-row-name">Dungeon not opened yet</span></div>`;
    } else {
      html += renderBossRows(live.dungeon.easy.rows);
      html += renderSwarmRows(live.dungeon.easySwarm.locations);
    }

    html += `<div class="dc-live-subtitle">Castle (Hard)</div>`;
    if (!live.dungeon.hard.open) {
      html += `<div class="dc-live-row dc-live-row-static"><span class="dc-live-row-name">Dungeon not opened yet</span></div>`;
    } else {
      html += renderBossRows(live.dungeon.hard.rows);
    }

    html += `<div class="dc-live-subtitle">Polyhedral Crucible</div>`;
    if (!live.dungeon.crucible.open) {
      html += `<div class="dc-live-row dc-live-row-static"><span class="dc-live-row-name">Dungeon not opened yet</span></div>`;
    } else {
      html += renderBossRows(live.dungeon.crucible.rows);
    }

    panel.innerHTML = html;
  }

  function renderPvpPanel(panel) {
    const p = live.pvp;
    if (p.error || !Number.isFinite(p.soloTokens)) {
      panel.innerHTML = '<div class="dc-live-empty">Could not load PvP tokens.</div>';
      return;
    }
    const soloMaxSuffix = Number.isFinite(p.soloMaxTokens) ? `/${p.soloMaxTokens}` : '';
    // Party row is only rendered if party tokens were actually detected
    // (i.e. the player is currently in a party) — otherwise it's skipped.
    const partyRow = Number.isFinite(p.partyTokens)
    ? `<div class="dc-live-row dc-live-row-static">
          <span class="dc-live-row-name">Party Tokens</span>
          <span class="dc-live-tag dc-live-tag-spawned">${escapeHtml(String(p.partyTokens))}${escapeHtml(Number.isFinite(p.partyMaxTokens) ? `/${p.partyMaxTokens}` : '')}</span>
        </div>`
      : '';
    panel.innerHTML = `
      <div class="dc-live-title">PvP Arena</div>
      <div class="dc-live-row dc-live-row-static">
        <span class="dc-live-row-name">Solo Tokens</span>
        <span class="dc-live-tag dc-live-tag-spawned">${escapeHtml(String(p.soloTokens))}${escapeHtml(soloMaxSuffix)}</span>
      </div>
      ${partyRow}
      <a class="dc-live-footer-link" href="${PVP_URL}">Open PvP Arena →</a>
    `;
  }

  function renderAllBadgesAndPanels() {
    const t = live.trackSettings;

    const gatesTile = findTile('gates');
    if (gatesTile) {
      // Panel still lists every wave; only toggled-on sources count toward the badge.
      const spawnedCount = live.waves.filter((b) => {
        if (!b.isSpawned) return false;
        const source = SOURCE_WAVES.find((s) => s.label === b.sourceLabel);
        if (source && !t[source.settingKey]) return false;
        const threshold = getWaveThreshold(b);
        if (Number.isFinite(b.userDmg) && Number.isFinite(threshold) && b.userDmg >= threshold) return false;
        return true;
      }).length;
      setBadge(gatesTile, spawnedCount > 0 ? spawnedCount : null, 'action');
      renderGatesPanel(ensurePanel(gatesTile));
    }

    const pvpTile = findTile('pvp');
    if (pvpTile) {
      setBadge(pvpTile, (t.pvp && Number.isFinite(live.pvp.soloTokens)) ? live.pvp.soloTokens : null, 'info');
      renderPvpPanel(ensurePanel(pvpTile));
    }

    const questsTile = findTile('quests');
    if (questsTile) {
      const unfinished = live.quests.available + (live.quests.active?.length || 0);
      setBadge(questsTile, (t.quests && unfinished > 0) ? unfinished : null, 'action');
      renderQuestsPanel(ensurePanel(questsTile));
    }

    const guildTile = findTile('guild');
    if (guildTile) {
      const bossSpawned = [
        t.dungeonEasyBoss ? live.dungeon.easy : null,
        t.dungeonHardBoss ? live.dungeon.hard : null,
        t.dungeonCrucibleBoss ? live.dungeon.crucible : null
      ]
      .filter((cat) => cat && cat.open)
      .flatMap((cat) => cat.rows)
      .filter((d) => d.isSpawned && !d.doneByDamage).length; // spawned AND still under your threshold
      const swarmNotHit = (t.dungeonEasySwarm && live.dungeon.easySwarm && live.dungeon.easySwarm.open)
      ? live.dungeon.easySwarm.locations.filter((loc) => loc.notHit > 0).length
      : 0;
      const badgeCount = bossSpawned + swarmNotHit;
      setBadge(guildTile, badgeCount > 0 ? badgeCount : null, 'action');
      renderGuildPanel(ensurePanel(guildTile));
    }
    const bpTile = findTile('battlepass');
    if (bpTile) {
      setBadge(bpTile, (t.battlePassQuests && live.battlepass.unfinished > 0) ? live.battlepass.unfinished : null, 'action');
      renderBattlePassPanel(ensurePanel(bpTile));
    }
  }

  // ---------- settings (⚙ button next to the dashboard title) ----------

  function buildSettingsControl() {
    if (document.getElementById('dc-live-settings-btn')) return;
    const bar = document.getElementById('dc-top-bar');
    if (!bar) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'dc-live-settings-btn';
    btn.className = 'dc-live-settings-btn';
    btn.title = 'Live tracker settings';
    btn.textContent = '⚙';
    bar.appendChild(btn);

    const modal = document.createElement('div');
    modal.className = 'dc-live-modal';
    modal.innerHTML = `
      <div class="dc-live-modal-card">
        <div class="dc-live-modal-head">
          <div class="dc-live-modal-title">Live Tracker Settings</div>
          <button type="button" class="dc-live-modal-close">Close</button>
        </div>
        <div class="dc-live-modal-body">
          <button type="button" class="dc-live-advanced-toggle">Advanced ▸</button>

          <div class="dc-live-basic-body">
            <div class="dc-live-modal-desc">Uncheck to not show unread indicator.</div>
            <label class="dc-live-check"><input type="checkbox" data-k="waveGate3W8"> Generals</label>
            <label class="dc-live-check"><input type="checkbox" data-k="waveGate5W9"> Poseidon</label>
            <label class="dc-live-check"><input type="checkbox" data-k="waveGate5W10">Hermes</label>
            <label class="dc-live-check"><input type="checkbox" data-k="waveGate5W11">Artemis</label>
            <label class="dc-live-check"><input type="checkbox" data-k="quests"> Adventurer quests</label>
            <label class="dc-live-check"><input type="checkbox" data-k="battlePassQuests"> Battle Pass quests</label>
            <label class="dc-live-check"><input type="checkbox" data-k="pvp"> PvP tokens</label>
            <label class="dc-live-check"><input type="checkbox" data-k="dungeonEasyBoss"> Shadowbridge</label>
            <label class="dc-live-check"><input type="checkbox" data-k="dungeonHardBoss">Castle of the F.P</label>
            <label class="dc-live-check"><input type="checkbox" data-k="dungeonCrucibleBoss"> Polyhedral Crucible</label>
            <label class="dc-live-check"><input type="checkbox" data-k="dungeonEasySwarm"> Gribbles (Shadowbridge)</label>
            <hr>
            <label class="dc-live-check"><input type="checkbox" data-k="showDamage"> Show damage on spawned bosses</label>
            <label class="dc-live-check"><input type="checkbox" data-k="hideGemOffer"> Hide gem offer banner</label>
          </div>

          <div class="dc-live-advanced-body" hidden>
            <div class="dc-live-modal-desc">Auto-clear the unread badge once your damage on that target crosses these totals. Type the full number — the preview on the right updates live.</div>

            <div class="dc-live-threshold-group-label">Wave Bosses (Gates)</div>
            <div class="dc-live-wave-thresholds"><!-- populated live from currently-detected bosses --></div>

            <div class="dc-live-threshold-group-label">Dungeon Bosses</div>
            <label class="dc-live-threshold"><span>Grixkar (Shadowbridge)</span><span class="dc-live-threshold-input-wrap"><input type="text" inputmode="numeric" data-t="dungeonBossEasy" placeholder="3000000000"><span class="dc-live-threshold-preview"></span></span></label>
            <label class="dc-live-threshold"><span>khaal (Castle)</span><span class="dc-live-threshold-input-wrap"><input type="text" inputmode="numeric" data-t="dungeonBossHard" placeholder="3000000000"><span class="dc-live-threshold-preview"></span></span></label>
            <label class="dc-live-threshold"><span>The Apex (Crucible)</span><span class="dc-live-threshold-input-wrap"><input type="text" inputmode="numeric" data-t="dungeonBossCrucible" placeholder="500000000"><span class="dc-live-threshold-preview"></span></span></label>

            <div class="dc-live-threshold-group-label">Other</div>
            <label class="dc-live-threshold"><span>HD minis (all 4)</span><span class="dc-live-threshold-input-wrap"><input type="text" inputmode="numeric" data-t="dungeonMini" placeholder="2000000000"><span class="dc-live-threshold-preview"></span></span></label>
            <label class="dc-live-threshold"><span>Gribbles</span><span class="dc-live-threshold-input-wrap"><input type="text" inputmode="numeric" data-t="swarm" placeholder="1000000"><span class="dc-live-threshold-preview"></span></span></label>
          </div>
        </div>
        <div class="dc-live-modal-actions">
          <button type="button" class="dc-live-modal-save">Save</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);


    btn.addEventListener('click', () => {
      sync();
      modal.querySelector('.dc-live-advanced-body').setAttribute('hidden', '');
      modal.querySelector('.dc-live-basic-body').removeAttribute('hidden');
      modal.querySelector('.dc-live-advanced-toggle').textContent = 'Advanced ▸';
      modal.classList.add('open');
    });
    modal.querySelector('.dc-live-modal-close').addEventListener('click', () => modal.classList.remove('open'));
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('open'); });



    function updateThresholdPreview(inp) {
      const preview = inp.nextElementSibling;
      if (!preview || !preview.classList.contains('dc-live-threshold-preview')) return;
      const digits = inp.value.replace(/[^\d]/g, '');
      preview.textContent = digits ? formatBigNumber(digits) : '';
    }

    function sync() {
      modal.querySelectorAll('input[data-k]').forEach((inp) => {
        const k = inp.dataset.k;
        if (k === 'showDamage') inp.checked = live.showDamage !== false;
        else if (k === 'hideGemOffer') inp.checked = live.hideGemOffer !== false;
        else inp.checked = !!live.trackSettings[k];
      });
      renderWaveThresholdRows(modal);
      modal.querySelectorAll('input[data-t]').forEach((inp) => {
        const key = inp.dataset.t;
        const raw = live.damageThresholds[key] ?? DEFAULT_DAMAGE_THRESHOLDS[key];
        inp.value = String(raw);
        updateThresholdPreview(inp);
      });
      modal.querySelectorAll('input[data-t-name]').forEach((inp) => {
        const key = inp.dataset.tName;
        const fallback = Number(inp.dataset.tFallback) || 0;
        const raw = (live.damageThresholds.waveNames && live.damageThresholds.waveNames[key] !== undefined)
        ? live.damageThresholds.waveNames[key]
        : fallback;
        inp.value = String(raw);
        updateThresholdPreview(inp);
      });
    }

    modal.querySelectorAll('input[data-t]').forEach((inp) => {
      inp.addEventListener('input', () => {
        const cursorFromEnd = inp.value.length - inp.selectionStart;
        inp.value = inp.value.replace(/[^\d]/g, '');
        const pos = Math.max(0, inp.value.length - cursorFromEnd);
        inp.setSelectionRange(pos, pos);
        updateThresholdPreview(inp);
      });
    });

    modal.querySelector('.dc-live-wave-thresholds').addEventListener('input', (e) => {
      const inp = e.target.closest('input[data-t-name]');
      if (!inp) return;
      const cursorFromEnd = inp.value.length - inp.selectionStart;
      inp.value = inp.value.replace(/[^\d]/g, '');
      const pos = Math.max(0, inp.value.length - cursorFromEnd);
      inp.setSelectionRange(pos, pos);
      updateThresholdPreview(inp);
    });

    modal.querySelector('.dc-live-advanced-toggle').addEventListener('click', (e) => {
      const btn = e.currentTarget;
      const basicBody = modal.querySelector('.dc-live-basic-body');
      const advBody = modal.querySelector('.dc-live-advanced-body');
      const goingAdvanced = advBody.hasAttribute('hidden');
      if (goingAdvanced) {
        basicBody.setAttribute('hidden', '');
        advBody.removeAttribute('hidden');
        btn.textContent = '← Back';
      } else {
        advBody.setAttribute('hidden', '');
        basicBody.removeAttribute('hidden');
        btn.textContent = 'Advanced ▸';
      }
    });

    modal.querySelector('.dc-live-modal-save').addEventListener('click', () => {
      const next = {};
      modal.querySelectorAll('input[data-k]').forEach((inp) => {
        if (inp.dataset.k === 'showDamage') live.showDamage = inp.checked;
        else if (inp.dataset.k === 'hideGemOffer') live.hideGemOffer = inp.checked;
        else next[inp.dataset.k] = inp.checked;
      });
      live.trackSettings = normalizeTrackSettings(next);

      const nextThresholds = { ...live.damageThresholds };
      modal.querySelectorAll('input[data-t]').forEach((inp) => {
        const key = inp.dataset.t;
        const digits = inp.value.replace(/[^\d]/g, '');
        const parsed = Number(digits);
        if (digits && Number.isFinite(parsed) && parsed >= 0) nextThresholds[key] = parsed;
      });

      const nextWaveNames = { ...(live.damageThresholds.waveNames || {}) };
      modal.querySelectorAll('input[data-t-name]').forEach((inp) => {
        const key = inp.dataset.tName;
        const digits = inp.value.replace(/[^\d]/g, '');
        const parsed = Number(digits);
        if (digits && Number.isFinite(parsed) && parsed >= 0) nextWaveNames[key] = parsed;
      });
      nextThresholds.waveNames = nextWaveNames;

      live.damageThresholds = normalizeDamageThresholds(nextThresholds);

      persistAllSettings({ showDamage: live.showDamage, hideGemOffer: live.hideGemOffer, trackSettings: live.trackSettings, damageThresholds: live.damageThresholds });
      modal.classList.remove('open');
      applyGemOfferVisibility();
      refreshLiveData().catch((err) => console.warn('[dashboard-live] refresh failed', err));
    });
  }


  // ---------- init ----------

  let liveDataStarted = false; // guards only the one-time settings-load + refresh loop
  async function initLiveData() {
    // Re-attach every time run() calls this (each call is cheap/idempotent
    // per-tile via dcPanelAttached / getElementById checks), so if the site
    // ever replaces the dashboard DOM later on, badges/panels come right
    // back instead of staying dark because a one-time flag already fired.
    buildSettingsControl();
    let anyFreshlyAttached = false;
    ['gates', 'pvp', 'quests', 'guild', 'battlepass'].forEach((key) => {
      const tile = findTile(key);
      if (!tile) return;
      if (tile.dataset.dcPanelAttached !== '1') anyFreshlyAttached = true;
      attachPanelInteraction(tile);
    });
    // Only repaint badges/panels here if a tile is GENUINELY new (e.g. the
    // site replaced the whole dashboard DOM) — never just because run()
    // fired. run() fires on every DOM mutation anywhere on the page, and
    // this page has several 1-second timers (stamina, buffs, wave timers,
    // server clock) that each rewrite a text node every second. Rebuilding
    // panel.innerHTML that often was tearing out and replacing the open
    // panel's rows mid-click, which is exactly why direct-link clicks
    // were silently landing on nothing. Normal refreshes every 5 minutes
    // (via refreshLiveData below) are the only re-renders we want.
    if (anyFreshlyAttached) {
      renderAllBadgesAndPanels();
    }

    if (liveDataStarted) return;
    liveDataStarted = true;

    const all = loadAllSettings();
    live.trackSettings = all.trackSettings;
    live.showDamage = all.showDamage;
    live.hideGemOffer = all.hideGemOffer;
    live.damageThresholds = all.damageThresholds;
    applyGemOfferVisibility();

    try {
      await refreshLiveData();
    } catch (err) {
      console.warn('[dashboard-live] initial refresh failed', err);
    }
    setInterval(() => {
      refreshLiveData().catch((err) => console.warn('[dashboard-live] refresh failed', err));
    }, REFRESH_MS);
  }

  /* =====================================================================
     LAYOUT / STYLES (original dashboard cleanup, plus live-tile CSS)
     ===================================================================== */

  function injectStyles() {
    if (document.getElementById('dc-cleanup-styles')) return;
    const style = document.createElement('style');
    style.id = 'dc-cleanup-styles';
    style.textContent = `


      /* --- page width: the dashboard's own .container ran edge-to-edge,
         wider than the game's top HUD bar (stamina/gold/gems/etc.), so
         everything below looked stretched out past where that bar stops.
         Cap it at a fixed width and center it instead — tweak
         --dc-max-width if it doesn't line up with the HUD on your screen.
         "How to Play" ships with its own narrower margin/max-width on top
         of that, so it visually floats inset while everything else is
         flush; null that out so it uses the same edge. */
      :root { --dc-max-width: 1500px; }
      .container {
        max-width: var(--dc-max-width) !important; margin-left: auto !important; margin-right: auto !important;
        padding-left: 20px !important; padding-right: 20px !important; box-sizing: border-box !important;
      }
      .howto-info { margin-left: 0 !important; margin-right: 0 !important; width: auto !important; max-width: none !important; }

      /* --- top bar: just the title + active-player count now. The old
         green-dot chip and the "forgot your password" line were removed
         entirely per request — the count is folded straight into the
         title instead of living in its own pill. --- */
      #dc-top-bar {
        display: flex; align-items: center; justify-content: center; flex-wrap: wrap;
        gap: 10px; row-gap: 8px;
        padding: 12px 14px; margin-bottom: 10px;
        background: #171923; border: 1px solid #2B2D44; border-radius: 12px;
      }
      .dc-title { font-size: 18px; margin: 0; flex: 0 0 auto; color: #EDEFF6; }
      .dc-title-sub {
        font-size: 12px; font-weight: 400; margin-left: 10px;
        color: #8a90ad; vertical-align: middle;
      }

      /* --- how to play: collapsible + tightened typography --- */
      .howto-info-header h2 { font-size: 15px !important; margin: 0 !important; }
      .howto-toggle { padding: 4px 10px !important; font-size: 12px !important; }
      .howto-info-body { font-size: 13px !important; line-height: 1.45 !important; }
      .howto-info-body p { margin: 0 0 8px !important; }
      .howto-info-body ul { margin: 4px 0 8px !important; padding-left: 18px !important; }
      .howto-info-body li { margin-bottom: 4px !important; }
      .howto-info-scroll { overflow: hidden; max-height: 2000px; transition: max-height .3s ease; }
      .howto-info.collapsed .howto-info-scroll { max-height: 0; }

      /* --- unified nav: Live Now and the category grid are now two
         INDEPENDENT cards side by side, rather than both living inside one
         shared bordered panel. Previously the outer panel had to stretch
         to match whichever side was taller, which left a dead strip of
         panel background under the shorter side. Giving each side its own
         background/border/radius means each one is only ever as tall as
         its own content. --- */
      .dc-nav-panel {
        background: transparent;
        border: none;
        padding: 0;
        margin-bottom: 16px;
      }

      .dc-nav-layout {
        display: flex;
        align-items: stretch;
        flex-wrap: nowrap;
        gap: 16px;
      }

      .dc-nav-live-col {
        flex: 1 1 260px;
        max-width: 340px;
        display: flex;
        flex-direction: column;
        gap: var(--dc-live-col-gap, 16px);
        background: #12131c; border: 1px solid #2B2D44; border-radius: 14px;
        padding: 18px;
      }

      .dc-nav-categories {
        flex: 1 1 0;
        min-width: 0;
        display: grid;
        grid-template-columns: repeat(var(--dc-cat-count, 4), minmax(0, 1fr));
        grid-template-rows: 1fr;      /*explicit: the one row IS the full height, no ambiguity */
        justify-content: start;
        align-items: start;
        gap: 20px;
        background: #12131c; border: 1px solid #2B2D44; border-radius: 14px;
        padding: 18px;
      }

      .dc-nav-cat-block {
        min-width: 0;
        container-type: inline-size;
        display: flex;
        flex-direction: column;
        height: 100%;          /* explicit, not implied */
        box-sizing: border-box; /* opadding/border don't push it past 100% */
      }

      .dc-nav-heading {
        font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
        color: #8a90ad; margin-bottom: 10px; padding-bottom: 6px;
        border-bottom: 1px solid #23253a; text-align: center;
        min-height: 30px;              /*  reserves room for 2 lines */
        display: flex;
        align-items: flex-end;          /*bottom-aligns text so the border lines up across columns */
        justify-content: center;
        line-height: 1.3;
      }
      .dc-nav-empty {
        font-size: 12px; color: #6b7089; padding: 10px 2px;
      }

      /* --- tile grid, used by every right-hand category block ---
         auto-fill + a fixed minmax floor keeps tiles from ballooning on
         wide screens or shrinking illegibly small on narrow ones; tiles
         size to their own content. */
      .dc-menu-grid {
        display: grid !important;
        grid-template-columns: repeat(auto-fill, minmax(108px, 1fr)) !important;
        grid-auto-rows: 1fr;      /* rows split the available height equally */
        gap: 14px !important;
        flex: 1 1 auto;
        min-height: 0;
        align-content: stretch;   /* was: center — stretch lets rows actually expand */
      }
      .dc-menu-card {
        position: relative;
        display: flex !important; flex-direction: column !important;
        align-items: center !important; justify-content: center !important;
        gap: 8px !important; min-height: 170px !important;
        padding: 24px 8px !important;
        background: #171923; border: 1px solid #2B2D44; border-radius: 12px;
        text-decoration: none; color: inherit;
        transition: transform .15s ease, border-color .15s ease, background .15s ease;
      }
      .dc-menu-card:hover,
      .dc-menu-card.dc-panel-open { transform: translateY(-2px); border-color: #3d3f5c; background: #1c1f2c; z-index: 50; }
      /* Keyboard focus: the site's own reset likely suppresses the default
         outline, so give tab users their own clearly visible ring instead
         of losing focus indication entirely. */
      .dc-menu-card:focus-visible {
        outline: 2px solid #8aa2ff; outline-offset: 2px;
        transform: translateY(-2px); border-color: #3d3f5c;
      }

      /* Live Now cards: horizontal row (icon left, text right) so several
         can stack in a narrow left column without wasting height, and get
         a warm accent instead of a giant banner. */
      .dc-menu-card-live {
        flex-direction: row !important;
        justify-content: flex-start !important;
        align-items: center !important;
        min-height: unset !important;
        padding: var(--dc-live-pad-y, 26px) var(--dc-live-pad-x, 22px) !important;
        gap: var(--dc-live-tile-gap, 18px) !important;
        border-color: rgba(251,191,36,.28);
        background: #191a26;
        transition: transform .15s ease, border-color .15s ease, background .15s ease, padding .2s ease, gap .2s ease;
      }
      .dc-menu-card-live:hover { border-color: rgba(251,191,36,.5); }
      .dc-menu-card-live .dc-menu-icon {
        width: var(--dc-live-icon, 128px) !important;
        height: var(--dc-live-icon, 128px) !important;
        object-fit: cover !important;
        flex-shrink: 0;                 /* NEW — icon can't be squeezed once text grows */
        transition: width .2s ease, height .2s ease;
      }
      .dc-menu-card-live .dc-menu-text {
        display: flex; flex-direction: column; align-items: flex-start; gap: 3px;
        flex: 1 1 0%;                   /* NEW — take all remaining row width */
        width: 100%;                    /* NEW — pair with flex-basis:0 so it doesn't shrink-to-fit */
        min-width: 0;
      }
      .dc-menu-card-live .dc-menu-label {
        text-align: left; font-size: var(--dc-live-label-font, 14px) !important;
        min-height: 0; display: block; justify-content: normal;
        transition: font-size .2s ease;
      }
      .dc-menu-card-live .dc-menu-meta {
        text-align: left; white-space: normal; max-width: 100%;
        font-size: var(--dc-live-meta-font, 11px);
        /* Caps a long meta line (e.g. the Anniversary countdown) at 2 lines
           instead of letting it grow the card indefinitely taller than its
           siblings — anything past that truncates with an ellipsis. */
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
        overflow: hidden;
        transition: font-size .2s ease;
      }
      .dc-menu-card-live .dc-menu-badge { position: static; margin: 0; font-size: 10px; padding: 2px 7px; }

      .dc-menu-card-disabled {
        opacity: .6;
        pointer-events: none; /* no hover lift, no click, no tap-to-preview */
      }

      .dc-menu-badge {
        position: absolute; top: 6px; left: 6px; z-index: 1;
        font-size: 9px; font-weight: 700; letter-spacing: .04em;
        padding: 1px 6px; border-radius: 999px;
        background: rgba(15,17,26,.85); color: #cdd4ff; border: 1px solid #2B2D44;
      }
      .dc-menu-badge-live { color: #86efac; border-color: rgba(134,239,172,.35); }

      .dc-menu-icon {
        width: clamp(64px, 95%, 148px) !important;
        height: auto !important;
        aspect-ratio: 1 / 1;
        object-fit: contain !important; flex: 0 0 auto !important;
        border-radius: 8px;
      }
      .dc-menu-label {
        font-size: 12.5px !important; line-height: 1.25 !important;
        text-align: center; color: #cdd4ff;
        min-height: 2.5em; /* reserves 2 lines worth of space (2 x 1.25 line-height)
                              so a 1-line title takes up the same vertical room as a
                              wrapped 2-line title, keeping every card the same height */
        display: flex; align-items: center; justify-content: center;
      }
      .dc-menu-meta {
        font-size: 9px; color: #8a90ad; text-align: center; line-height: 1.2;
        max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }

      /* Tiles shrink based on how wide their own category column actually is,
         not overall viewport width — this is what stops a 4-across category
         layout from collapsing each block to one oversized tile per row. */
      @container (max-width: 300px) {
        .dc-menu-grid { grid-template-columns: repeat(auto-fill, minmax(90px, 1fr)) !important; gap: 10px !important; }
        .dc-menu-card { min-height: 128px !important; padding: 14px 6px !important; }
        .dc-menu-label { font-size: 11px !important; min-height: 2.2em !important; }
      }
      @container (max-width: 200px) {
        .dc-menu-grid { grid-template-columns: repeat(auto-fill, minmax(64px, 1fr)) !important; gap: 8px !important; }
        .dc-menu-card { min-height: 96px !important; padding: 10px 4px !important; }
        .dc-menu-label { font-size: 9.5px !important; min-height: 2em !important; }
      }

      .side-label,
      .side-nav-item {
          font-weight: 400 !important;
          text-shadow: none !important;
          transform: none !important;
      }

      /* --- live tile badges (quests / dungeon bosses / gates / pvp) --- */
      .dc-live-badge {
        position: absolute; top: 6px; right: 6px; z-index: 3;
        min-width: 16px; height: 16px; padding: 0 5px; box-sizing: border-box;
        display: flex; align-items: center; justify-content: center;
        font-size: 10px; font-weight: 700; border-radius: 999px;
        border: 1px solid #12131c; line-height: 1; font-variant-numeric: tabular-nums;
      }
      .dc-live-badge-action { background: #e0334d; color: #fff; }
      .dc-live-badge-info { background: #2b3a66; color: #cdd9ff; border-color: rgba(138,162,255,.35); }

      /* --- hover/tap panel, anchored to its tile (tiles are position:relative) --- */
      .dc-live-panel {
        position: absolute; top: calc(100% + 8px); left: 0; z-index: 20;
        width: 260px; max-width: 80vw;
        background: #12131c; border: 1px solid #2B2D44; border-radius: 10px;
        box-shadow: 0 10px 26px rgba(0,0,0,.5);
        padding: 10px; display: none; flex-direction: column; gap: 6px;
        text-align: left;
        overflow-y: auto;
      }
      .dc-live-panel.dc-open { display: flex; }
      .dc-live-panel.dc-panel-flip { left: auto; right: 0; }
      .dc-live-panel.dc-panel-up { top: auto; bottom: calc(100% + 8px); }
      .dc-live-title {
        font-size: 11px; font-weight: 700; color: #8a90ad;
        text-transform: uppercase; letter-spacing: .04em;
        margin-bottom: 2px;
      }
      .dc-live-subtitle {
        font-size: 10px; font-weight: 700; color: #6b7089;
        text-transform: uppercase; letter-spacing: .03em;
        margin: 4px 0 -2px;
      }
      .dc-live-row {
        display: flex; align-items: center; justify-content: space-between; gap: 8px;
        padding: 6px 8px; border-radius: 8px; background: #171923; border: 1px solid #2B2D44;
        text-decoration: none; color: inherit; font-size: 12px;
      }
      #dc-toast {
        position: fixed; top: 20px; right: 20px; z-index: 99999;
        padding: 12px 20px; border-radius: 10px; box-shadow: 0 4px 12px rgba(0,0,0,.4);
        font-size: 14px; color: #fff; display: none;
      }
      #dc-toast.dc-toast-success { background: #2ecc71; }
      #dc-toast.dc-toast-error { background: #e74c3c; }

      .dc-live-row:hover { border-color: #3d3f5c; }
      .dc-live-row-static { cursor: default; }
      .dc-live-row-multiline { flex-direction: column; align-items: stretch; gap: 3px; }
      .dc-live-row-main { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .dc-live-row-sub { font-size: 10px; color: #8a90ad; }
      .dc-live-row-name { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .dc-live-tag {
        flex-shrink: 0; font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 999px;
        white-space: nowrap;
      }
      .dc-live-tag-spawned { color: #7cffb8; background: rgba(0,255,140,.10); border: 1px solid rgba(0,255,140,.35); }
      .dc-live-tag-wait { color: #ffd369; background: rgba(255,211,105,.10); border: 1px solid rgba(255,211,105,.35); }
      .dc-live-tag-blocked { color: #ff9a9a; background: rgba(255,60,60,.08); border: 1px solid rgba(255,60,60,.3); }
      .dc-live-empty { font-size: 12px; color: #8a90ad; padding: 6px 2px; }
      .dc-live-footer-link { font-size: 11px; color: #8aa2ff; text-align: center; padding-top: 2px; text-decoration: none; }
      .dc-live-footer-link:hover { text-decoration: underline; }

      .dc-live-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
      .dc-live-action-btn {
        border: 1px solid rgba(0,255,140,.35); background: rgba(0,255,140,.10); color: #7cffb8;
        border-radius: 8px; padding: 4px 10px; font-size: 11px; font-weight: 700; cursor: pointer;
      }
      .dc-live-action-btn:hover { background: rgba(0,255,140,.18); }
      .dc-live-action-btn:disabled { opacity: .5; cursor: default; }

      /* --- settings gear button + modal --- */
      .dc-live-settings-btn {
        margin-left: 8px; border: 1px solid #2B2D44; background: #171923; color: #cdd4ff;
        border-radius: 8px; padding: 4px 9px; font-size: 13px; cursor: pointer;
      }
      .dc-live-settings-btn:hover { border-color: #3d3f5c; }
      .dc-live-modal {
        position: fixed; inset: 0; z-index: 10080; background: rgba(0,0,0,.6);
        display: none; align-items: center; justify-content: center; padding: 14px;
      }
      .dc-live-modal.open { display: flex; }
      .dc-live-modal-card {
        width: min(340px, 92vw); background: #171a2a; border: 1px solid #2b2d44;
        border-radius: 12px; box-shadow: 0 14px 34px rgba(0,0,0,.55); overflow: hidden;
      }
      .dc-live-modal-head {
        display: flex; align-items: center; justify-content: space-between;
        padding: 10px 12px; border-bottom: 1px solid #2b2d44; background: #141728;
      }
      .dc-live-modal-title { font-size: 13px; font-weight: 800; color: #ffd369; }
      .dc-live-modal-head button, .dc-live-modal-actions button {
        border: 1px solid #2b2d44; background: #23263b; color: #e6e9ff;
        border-radius: 8px; padding: 5px 9px; font-size: 12px; cursor: pointer;
      }
      .dc-live-modal-body { padding: 12px; display: flex; flex-direction: column; gap: 8px; }
      .dc-live-modal-desc { font-size: 11px; color: #8a90ad; margin-bottom: 4px; }
      .dc-live-check { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #e6e9ff; }
      .dc-live-modal-body hr { border: none; border-top: 1px solid #2b2d44; margin: 4px 0; width: 100%; }
      .dc-live-advanced-toggle { align-self: flex-start; background: transparent !important; border: none !important; color: #8aa2ff !important; padding: 0 !important; font-size: 12px !important; }
      .dc-live-advanced-body { display: flex; flex-direction: column; gap: 8px; }
      .dc-live-advanced-body[hidden] { display: none; }
      .dc-live-threshold-group-label { font-size: 10px; font-weight: 700; color: #6b7089; text-transform: uppercase; letter-spacing: .03em; margin: 6px 0 -2px; }
      .dc-live-threshold {
        display: flex; align-items: center; justify-content: space-between; gap: 8px;
        font-size: 12px; color: #e6e9ff;
        padding-bottom: 6px; border-bottom: 1px solid #1c1e2c;
      }
      .dc-live-threshold:last-child { border-bottom: none; padding-bottom: 0; }
      .dc-live-threshold-input-wrap { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
      .dc-live-threshold input {
        width: 108px; background: #12141f; border: 1px solid #2B2D44; border-radius: 6px;
        color: #e6e9ff; padding: 3px 6px; font-size: 12px; text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .dc-live-threshold > span:first-child {
        min-width: 0;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
      }
      .dc-live-threshold-preview {
        min-width: 30px; text-align: left; color: #7cffb8; font-size: 11px; font-weight: 700;
        font-variant-numeric: tabular-nums;
      }

      .dc-live-wave-thresholds { display: flex; flex-direction: column; gap: 8px; }
      .dc-live-threshold-group { color: #6b7089; font-weight: 400; font-size: 10px; }

      .dc-live-modal-actions { display: flex; justify-content: flex-end; gap: 8px; padding: 0 12px 12px; }

      /* Fires earlier than the 480px breakpoint below, since the fixed
         250px category columns overflow well before phones get that
         narrow — this is what's causing the sideways stretch/squish. */
      @media (max-width: 900px) {
        .dc-nav-layout { flex-direction: column; align-items: stretch; }
        .dc-nav-live-col { flex: 0 0 auto; width: 100%; max-width: none !important; }
        .dc-nav-categories {
          width: 100%;
          padding: 10px !important;
          /* Fixed column count driven by JS (--dc-cat-count = however many
             category blocks actually exist), with minmax(0, 1fr) so each
             column is free to shrink as far as it needs to. This is what
             guarantees zero wrapping — auto-fit/auto-fill pick column count
             from available width, so they can (and did) drop to 2 or even 1
             per row once space got tight. A fixed count never does that;
             it just makes every column narrower instead of dropping one. */
          grid-template-columns: repeat(var(--dc-cat-count, 4), minmax(0, 1fr)) !important;
          gap: 8px !important;
        }
        .dc-nav-cat-block {
          min-width: 0;
        }
        /* Small minmax lets each block's own tile grid fall back to 1 icon
           per row once the block itself gets narrow (which it will, now
           that up to 4-5 of them share one row) — that's what keeps the
           outer row from ever needing to wrap. */

        .dc-nav-heading { font-size: 10px !important; margin-bottom: 6px !important; }
      }

      @media (max-width: 480px) {
        .dc-nav-categories { grid-template-columns: repeat(2, 1fr) !important; gap: 14px !important; }

        .dc-menu-card-live .dc-menu-icon { width: min(var(--dc-live-icon, 128px), 96px) !important; height: min(var(--dc-live-icon, 128px), 96px) !important; }
        .dc-live-panel { width: 200px; }
      }

    `;
    document.head.appendChild(style);
  }

  // ---------- top bar: title + active-player count merged, chip and
  // password/contact line removed entirely ----------

  function buildTopBar() {
    if (document.getElementById('dc-top-bar')) return;

    const container = document.querySelector('.container');
    const h1 = container?.querySelector(':scope > h1');
    if (!h1) return;

    const statBox = container.querySelector(':scope > .active-players-today');
    // The "forgot your password" line ships as a bare <h3>, styled inline
    // (centered, green) so it visually reads like an urgent banner rather
    // than routine support info. Per request, this is now dropped entirely
    // rather than relocated.
    const supportLine = Array.from(container.querySelectorAll(':scope > h3'))
    .find(h => /forgot your password/i.test(h.textContent));

    const bar = document.createElement('div');
    bar.id = 'dc-top-bar';

    const title = document.createElement('h1');
    title.className = 'dc-title';
    title.textContent = h1.textContent.trim();

    if (statBox) {
      const count = statBox.querySelector('.active-players-today-count')?.textContent.trim();
      const sub = document.createElement('span');
      sub.className = 'dc-title-sub';
      sub.textContent = `${count || '—'} active`;
      title.appendChild(sub);
      statBox.remove();
    }

    bar.appendChild(title);

    if (supportLine) supportLine.remove(); // dropped entirely, not relocated

    h1.replaceWith(bar);
  }

  // ---------- how to play: collapsible by default ----------

  function makeHowToCollapsible() {
    const box = document.querySelector('.howto-info');
    const scroll = box?.querySelector('.howto-info-scroll');
    const toggle = box?.querySelector('#howtoToggle');
    if (!box || !scroll || !toggle || box.dataset.dcCollapsible === '1') return;
    box.dataset.dcCollapsible = '1';

    // The page ships its own click handler + cookie persistence for this
    // toggle (COOKIE_NAME 'veyraHowtoCollapsed'). We deliberately don't
    // touch the button or add our own listener — doing so previously meant
    // cloning it to strip the page's handler, but the page's init runs on
    // DOMContentLoaded and re-queries by ID, so it could re-attach a second
    // listener to our clone and the two would double-fire on every click.
    // Instead we just: (1) provide the CSS max-height animation the page's
    // plain classList toggle doesn't do on its own, (2) default to
    // collapsed for anyone who hasn't already set a preference, without
    // overriding an explicit "keep it open" choice already in the cookie,
    // and (3) keep aria-hidden in sync with whichever script (page's or a
    // future load of ours) ends up toggling the "collapsed" class, so the
    // zero-height content isn't still announced to screen readers.
    function syncAria() {
      scroll.setAttribute('aria-hidden', String(box.classList.contains('collapsed')));
    }
    new MutationObserver(syncAria).observe(box, { attributes: true, attributeFilter: ['class'] });

    const cookieMatch = document.cookie.match(/(?:^|;\s*)veyraHowtoCollapsed=([^;]*)/);
    const explicitlyKeptOpen = cookieMatch && cookieMatch[1] === '0';
    if (!explicitlyKeptOpen) {
      // No stored preference, or the stored preference is "collapsed" —
      // either way, start collapsed (most returning players already know
      // how to play). The page's own init reads the same cookie, so it
      // won't fight this once it runs.
      box.classList.add('collapsed');
      toggle.textContent = 'Show';
      toggle.setAttribute('aria-expanded', 'false');
    }
    syncAria();
  }

  // ---------- unified nav: Live Now column + flowing category blocks ----------

  // Pulls the one non-tag meta line out of a hero card's body (e.g. "Level
  // 40 • 50/100 (50%) • Ends in 1d 03h 01m" or "Browse All Gates"). Some
  // cards (PvP, Vampire Castle) don't have one, which is fine — meta is
  // optional throughout.
  function readHeroMeta(card) {
    const metaEl = card.querySelector('.event-body > div[style*="font-size:14px"]');
    if (!metaEl) return '';
    // Clone so we don't touch the live DOM, then turn <br> into a real
    // space before reading textContent — otherwise text on either side
    // of a <br> (e.g. the anniversary card's "label" / "countdown" spans)
    // gets concatenated with no separator at all.
    const clone = metaEl.cloneNode(true);
    clone.querySelectorAll('br').forEach(br => br.replaceWith(' '));
    return clone.textContent.replace(/\s+/g, ' ').trim();
  }

  // variant: 'grid' (default, square tile for category blocks) or 'live'
  // (horizontal row for the stacked left column).
  function buildTile(item, variant) {
    const isLive = variant === 'live';
    const isDisabled = !!item.disabled;

    // Disabled cards (no href — e.g. an anniversary event that hasn't
    // started yet) render as a plain <div>, not an <a>, so there's nothing
    // to click and nowhere misleading for it to "navigate" to.
    const el = document.createElement(isDisabled ? 'div' : 'a');
    if (!isDisabled) el.href = item.href;
    el.className = 'dc-menu-card'
      + (isLive ? ' dc-menu-card-live' : '')
      + (isDisabled ? ' dc-menu-card-disabled' : '');
    if (isDisabled) el.setAttribute('aria-disabled', 'true');

    // Tag the tile with its live-data key, if it has one, so the badge +
    // hover/tap panel below can find it directly instead of re-deriving it.
    const dcKey = item.href ? TILE_KEY_BY_HREF[item.href] : null;
    if (dcKey) el.dataset.dcKey = dcKey;

    // Only show the native tooltip when there's no live panel to redundantly cover it
    if (!dcKey) {
      el.title = item.meta ? `${item.title} — ${item.meta}` : item.title;
    }

    let badgeEl = null;
    if (item.badge) {
      badgeEl = document.createElement('span');
      badgeEl.className = 'dc-menu-badge' + (item.badge === 'LIVE' ? ' dc-menu-badge-live' : '');
      badgeEl.textContent = item.badge;
      if (!isLive) el.appendChild(badgeEl); // grid tiles: absolute-positioned corner badge
    }

    if (item.src) {
      const img = document.createElement('img');
      img.src = item.src;
      img.alt = item.title;
      img.className = 'dc-menu-icon';
      el.appendChild(img);
    }

    const label = document.createElement('span');
    label.className = 'dc-menu-label';
    label.textContent = item.title;

    const meta = item.meta
    ? Object.assign(document.createElement('span'), { className: 'dc-menu-meta', textContent: item.meta })
    : null;

    if (isLive) {
      // Icon on the left, badge/title/meta stacked to its right.
      const textWrap = document.createElement('span');
      textWrap.className = 'dc-menu-text';
      if (badgeEl) textWrap.appendChild(badgeEl);
      textWrap.appendChild(label);
      if (meta) textWrap.appendChild(meta);
      el.appendChild(textWrap);
    } else {
      el.appendChild(label);
      if (meta) el.appendChild(meta);
    }

    return el;
  }

  // Scales the "Live Now" tiles down as more of them show up, so a 4th
  // (or 5th) item fits without the column just growing taller. 1-3 items
  // keeps today's size; each item past that shrinks icon/padding/gaps by
  // ~12%, floored at MIN so tiles never get illegibly small.
  function applyLiveTileScaling(liveCol, count) {
    const BASE = { icon: 128, tileGap: 18, padY: 26, padX: 22, colGap: 16, labelFont: 14, metaFont: 11 };
    const MIN  = { icon: 68,  tileGap: 6,  padY: 10, padX: 10, colGap: 6,  labelFont: 11, metaFont: 9  };

    const steps = Math.max(0, count - 3);
    const factor = Math.max(0.5, 1 - steps * 0.15);
    const scale = (base, min) => Math.max(min, Math.round(base * factor));

    liveCol.style.setProperty('--dc-live-icon', scale(BASE.icon, MIN.icon) + 'px');
    liveCol.style.setProperty('--dc-live-tile-gap', scale(BASE.tileGap, MIN.tileGap) + 'px');
    liveCol.style.setProperty('--dc-live-pad-y', scale(BASE.padY, MIN.padY) + 'px');
    liveCol.style.setProperty('--dc-live-pad-x', scale(BASE.padX, MIN.padX) + 'px');
    liveCol.style.setProperty('--dc-live-col-gap', scale(BASE.colGap, MIN.colGap) + 'px');
    liveCol.style.setProperty('--dc-live-label-font', scale(BASE.labelFont, MIN.labelFont) + 'px');
    liveCol.style.setProperty('--dc-live-meta-font', scale(BASE.metaFont, MIN.metaFont) + 'px');
  }


  function buildUnifiedNav() {
    if (document.getElementById('dc-nav')) return;

    const heroSection = document.querySelector('.hero-section[aria-label="Core Activities"]');
    const menuFlex = document.querySelector('.gates-flex');
    const menuPanel = menuFlex?.closest('.section.card');
    if (!heroSection || !menuFlex || !menuPanel) return;

    // ---- gather Live Now items (left column) ----
    const liveItems = [];
    heroSection.querySelectorAll('.hero-grid > .hero-card').forEach(card => {
      const img = card.querySelector('img');
      const href = card.getAttribute('href');
      const isDisabled = card.classList.contains('is-disabled') || card.getAttribute('aria-disabled') === 'true' || !href;
      liveItems.push({
        href: href || null,
        disabled: isDisabled,
        src: img?.getAttribute('src') || '',
        title: card.querySelector('.event-title')?.textContent.trim() || img?.alt || 'Untitled',
        badge: card.querySelector('.event-badge')?.textContent.trim() || '',
        meta: readHeroMeta(card),
      });
    });

    // ---- gather + group everything else (right-hand category blocks) ----
    const grouped = new Map();
    menuFlex.querySelectorAll(':scope > .gate-link').forEach(link => {
      const href = link.getAttribute('href') || '#';
      const img = link.querySelector('img');
      const category = MENU_CATEGORIES[href] || 'More';
      const item = {
        href,
        src: img?.getAttribute('src') || '',
        title: link.querySelector('.gate-card-name')?.textContent.trim() || img?.alt || 'Untitled',
        badge: '',
        meta: '',
      };
      if (!grouped.has(category)) grouped.set(category, []);
      grouped.get(category).push(item);
    });

    const orderedCategories = [
      ...CATEGORY_ORDER.filter(c => grouped.has(c)),
      ...Array.from(grouped.keys()).filter(c => !CATEGORY_ORDER.includes(c)), // any surprise category, shown last
    ];

    // ---- build the panel ----
    const nav = document.createElement('div');
    nav.id = 'dc-nav';
    nav.className = 'dc-nav-panel';

    const layout = document.createElement('div');
    layout.className = 'dc-nav-layout';
    nav.appendChild(layout);

    // Left column: Core Activities, stacked top to bottom, in its own card.
    const liveCol = document.createElement('div');
    liveCol.className = 'dc-nav-live-col';

    const liveHeading = document.createElement('div');
    liveHeading.className = 'dc-nav-heading';
    liveHeading.textContent = 'Live Now';
    liveCol.appendChild(liveHeading);

    if (liveItems.length) {
      liveItems.forEach(item => liveCol.appendChild(buildTile(item, 'live')));
    } else {
      const empty = document.createElement('div');
      empty.className = 'dc-nav-empty';
      empty.textContent = 'Nothing live right now.';
      liveCol.appendChild(empty);
    }
    applyLiveTileScaling(liveCol, liveItems.length);
    layout.appendChild(liveCol);

    // Right side: smaller category blocks, in their own card, flowing
    // left-to-right and wrapping to fill the row before starting a new one.
    const categoriesCol = document.createElement('div');
    categoriesCol.className = 'dc-nav-categories';

    let catBlockCount = 0;
    orderedCategories.forEach(category => {
      const list = grouped.get(category);
      if (!list?.length) return;
      catBlockCount++;

      const block = document.createElement('div');
      block.className = 'dc-nav-cat-block';

      const heading = document.createElement('div');
      heading.className = 'dc-nav-heading';
      heading.textContent = category;
      block.appendChild(heading);

      const grid = document.createElement('div');
      grid.className = 'dc-menu-grid';
      list.forEach(item => grid.appendChild(buildTile(item)));
      block.appendChild(grid);

      categoriesCol.appendChild(block);
    });
    // Exact number of category blocks, so the 900px layout below can force
    // that many columns instead of guessing — a fixed count never wraps,
    // where auto-fit/auto-fill always risks it once space runs low.
    categoriesCol.style.setProperty('--dc-cat-count', String(catBlockCount));
    layout.appendChild(categoriesCol);


    heroSection.replaceWith(nav);
    menuPanel.remove();
  }

  // ---------- dispatch ----------

  function run() {
    injectStyles();
    buildTopBar();
    makeHowToCollapsible();
    buildUnifiedNav();
    applyGemOfferVisibility();
    // Only kick off the live-data layer once our nav (with its data-dc-key
    // tags) actually exists — initLiveData() itself is idempotent via
    // liveInitStarted, so repeated run() calls before that point are cheap.
    if (document.getElementById('dc-nav')) {
      initLiveData();
    }
    applyInitialScroll();
  }

  let rerunTimer = null;
  function scheduleRun() {
    clearTimeout(rerunTimer);
    rerunTimer = setTimeout(run, 50);
  }
  const observer = new MutationObserver(scheduleRun);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  // Deliberately never disconnected: if the site periodically replaces the
  // dashboard's own DOM, this is what notices and reruns build/init so the
  // nav, badges, and panels come back instead of staying gone for good.

  run();
})();

/* =====================================================================
   MODULE 5: Wave Page Loot Preview Overlays + Toolbar
   Runs only on active_wave.php. For each unique monster name on the
   page, fetches that monster's own battle.php page once, parses the
   "🎁 Possible Loot" panel, and overlays a row of tiny item-icon chips
   along the bottom of the monster image. A toolbar sized to the cards
   grid sits above it, with: search by name, filter by specific loot
   item, quick-select which monsters to show, an HP filter, a Hide
   Loot toggle, and a Group by Type toggle that physically reorders
   cards into named sections with full-width divider headers.

   v-next notes:
   - Group-by-type dividers are now collapsible: click/tap a divider to
     fold its section away. A collapsed section stays in the DOM (so it
     can be re-expanded) but its cards are hidden and the divider shows
     a "matching/total · hidden" count instead of the divider vanishing.
   - The "Hide Loot" hover-to-reveal (and touch tap-to-peek) is now
     scoped to the monster image itself (.wlo-img-wrap), not the whole
     card — hovering the name/stats area no longer reveals the strip.
   - After a card's loot is fetched, the bottom strip is measured
     against the image's height. If it would cover more than 40% of
     the image, it's swapped for a small "🎁 N" indicator plus a bigger,
     cleaner side panel (like the dashboard's hover panels, with the
     same flip-to-the-other-side logic) that opens on hover/tap of the
     image instead of overlaying the art.
   ===================================================================== */
(function () {
  'use strict';
  if (!/\/active_wave\.php/.test(location.pathname)) return;

  const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
  const numFrom = (s) => {
    const m = clean(s).replace(/,/g, '').match(/[\d.]+/);
    return m ? Number(m[0]) : null;
  };
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

  // ---------- page mode: detected ONCE at load, never changes for this tab ----------
  // 'alive' = alive-only view, 'dead' = dead-only view, 'all' = both shown.
  // Every refresh, cookie swap and cross-tab sync key below is scoped by this,
  // so an alive tab and a dead tab can never overwrite each other.
  function detectPageMode() {
    const cards = Array.from(document.querySelectorAll('.monster-card'));
    const deadCount = cards.filter((c) => c.dataset.dead === '1').length;
    if (cards.length && deadCount === cards.length) return 'dead';
    if (deadCount > 0) return 'all';
    const hide = (document.cookie.match(/(?:^|;\s*)hide_dead_monsters=([^;]*)/) || [])[1];
    const only = (document.cookie.match(/(?:^|;\s*)show_dead_bosses_only=([^;]*)/) || [])[1];
    if (!cards.length) {
      // Empty page: a dead-only page may still show its "Dead Monsters" header.
      const hasDeadHeader = Array.from(document.querySelectorAll('.monster-section-title'))
        .some((el) => /dead monsters/i.test(el.textContent || ''));
      if (hasDeadHeader || only === '1') return 'dead';
    }
    // All cards alive (or none): alive-only page unless the cookies say dead monsters are shown too.
    return hide === '1' ? 'alive' : 'all';
  }
  const PAGE_MODE = detectPageMode();
  console.log('[wave-loot] page mode:', PAGE_MODE);

  function formatShort(n) {
    if (!Number.isFinite(n)) return '?';
    const abs = Math.abs(n);
    const units = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
    for (const [limit, suffix] of units) {
      if (abs >= limit) {
        const scaled = n / limit;
        const places = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
        return scaled.toFixed(places).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1') + suffix;
      }
    }
    return Math.round(n).toLocaleString();
  }

  // Reads the wave page's own data-userdmg attribute directly off the
  // card — same attribute the dashboard module reads when it fetches a
  // COPY of this page — so no extra network round-trip is needed here.
  function getCardDamage(card) {
    const raw = card.dataset.userdmg;
    const n = raw !== undefined ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : 0;
  }
  function cardHasDamage(card) {
    return getCardDamage(card) > 0;
  }

  // How much of the image height the bottom strip is allowed to occupy
  // before we switch that card over to the side-panel display instead.
  const SIDE_PANEL_COVERAGE_THRESHOLD = 0.7;

  // ---------- loot parsing ----------

  function parseLootFromDoc(doc, baseUrl) {
    const lootPanel = Array.from(doc.querySelectorAll('.panel')).find((p) =>
      clean(p.querySelector('strong')?.textContent).includes('Possible Loot')
    );
    const items = [];
    if (!lootPanel) return items;

    const grid = lootPanel.querySelector('.loot-grid') || lootPanel;
    let currentTier = 'UNKNOWN';

    Array.from(grid.children).forEach((child) => {
      if (child.matches?.('h4.tier-head')) {
        currentTier = clean(child.textContent).toUpperCase();
        return;
      }
      const cards = child.querySelectorAll?.('.loot-card');
      if (!cards || !cards.length) return;
      cards.forEach((card) => {
        const img = card.querySelector('img');
        const name = clean(card.querySelector('.loot-name')?.textContent || '');
        const desc = clean(card.querySelector('.loot-desc')?.textContent || '');
        const chips = Array.from(card.querySelectorAll('.chip')).map((c) => clean(c.textContent));
        const dropText = chips.find((t) => /drop:/i.test(t)) || '';
        const dmgText = chips.find((t) => /dmg req:/i.test(t)) || '';
        let src = '';
        if (img?.getAttribute('src')) {
          try { src = new URL(img.getAttribute('src'), baseUrl).href; } catch (e) { src = img.getAttribute('src'); }
        }
        items.push({
          tier: currentTier,
          name,
          desc,
          src,
          dropPct: numFrom(dropText),
          dmgReq: numFrom(dmgText)
        });
      });
    });
    return items;
  }

  // ---------- EXP/DMG ratio parsing ----------
  // Unlike loot, this value is already computed server-side on battle.php
  // (a <div class="stat-block"> with label "EXP / DMG" and the ratio in
  // <strong>) — no need to reconstruct it from EXP text on the wave card.

  function parseExpDmgRatioFromDoc(doc) {
    const block = Array.from(doc.querySelectorAll('.stat-block')).find((b) =>
      clean(b.querySelector('.label')?.textContent).toUpperCase() === 'EXP / DMG'
    );
    if (!block) return null;
    const raw = clean(block.querySelector('strong')?.textContent);
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  // One fetch + parse per battle.php URL, shared by loot, EXP/DMG and element.
  const battleDocCache = new Map();
  function fetchBattleDoc(viewUrl) {
    if (!battleDocCache.has(viewUrl)) {
      battleDocCache.set(viewUrl, (async () => {
        const res = await fetch(viewUrl, { credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();
        return { doc: new DOMParser().parseFromString(html, 'text/html'), html };
      })().catch((err) => { battleDocCache.delete(viewUrl); throw err; }));
    }
    return battleDocCache.get(viewUrl);
  }

  async function fetchExpDmgRatio(viewUrl) {
    return parseExpDmgRatioFromDoc((await fetchBattleDoc(viewUrl)).doc);
  }

  async function fetchLootForUrl(viewUrl) {
    return parseLootFromDoc((await fetchBattleDoc(viewUrl)).doc, viewUrl);
  }

  // ---------- styles ----------

  function injectStyles() {
    if (document.getElementById('wlo-styles')) return;
    const style = document.createElement('style');
    style.id = 'wlo-styles';
    style.textContent = `
      .wlo-img-wrap { position: relative; display: block; width: 100%; container-type: inline-size; }

      .monster-card { position: relative; }
      .monster-card.wlo-card-elevated { z-index: 999 !important; }

      .wlo-strip {
        position: absolute; left: 0; right: 0; bottom: 0;
        display: flex; justify-content: center; flex-wrap: wrap;
        gap: 4px; gap: clamp(3px, 1.5cqw, 6px);
        padding: 3px 3px 3px; padding: clamp(3px, 1.5cqw, 6px) 3px 3px;
        background: linear-gradient(to top, rgba(10,11,18,.9), rgba(10,11,18,0));
      }

      .wlo-chip {
        display: flex; flex-direction: column; align-items: center; gap: 2px;
        width: 34px; width: clamp(32px, 20cqw, 42px);
      }
      .wlo-thumb {
        position: relative;
        width: 34px; height: 34px;
        width: clamp(32px, 20cqw, 42px); height: clamp(32px, 20cqw, 42px);
        border-radius: 15%; overflow: hidden; background: #12131c;
        border: 1.5px solid rgba(255,255,255,.3);
      }
      .wlo-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .wlo-thumb.wlo-tier-epic   { border-color: rgba(168,85,247,.9); box-shadow: 0 0 0 1px rgba(168,85,247,.35); }
      .wlo-thumb.wlo-tier-rare   { border-color: rgba(59,130,246,.9); box-shadow: 0 0 0 1px rgba(59,130,246,.35); }
      .wlo-thumb.wlo-tier-common { border-color: rgba(148,163,184,.9); }

      .wlo-drop {
        position: absolute; top: -4px; right: -4px;
        font-size: 10px; font-size: clamp(9px, 4.2cqw, 11px);
        font-weight: 900; line-height: 1;
        padding: 2px 5px; border-radius: 999px;
        background: #0a0a0f; color: #ffe066;
        border: 1.5px solid rgba(255,255,255,.85);
        box-shadow: 0 1px 3px rgba(0,0,0,.7);
        white-space: nowrap;
      }

      /* --- dmg requirement, now overlaid across the base of the icon
         itself instead of sitting in a separate pill underneath it. Cyan
         instead of the drop-badge's gold so the two don't blur together
         at a glance. --- */
      .wlo-dmg {
        position: absolute; left: 0; right: 0; bottom: 0; z-index: 2;
        font-size: 8px; font-size: clamp(7px, 3.6cqw, 10px);
        font-weight: 800; line-height: 1.5; text-align: center;
        white-space: nowrap; overflow: hidden;
        padding: 0 2px;
        color: #7cd8ff;
        background: rgba(10,11,18,.78);
        border-top: 1px solid rgba(124,216,255,.5);
      }

      /* Met checkmark moves to the top-left corner now that the bottom
         edge is taken up by the dmg-requirement bar. */
      .wlo-thumb.wlo-met::after {
        content: '✓';
        position: absolute;
        left: 1px;
        top: 1px;
        width: 12px;
        height: 12px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 8px;
        font-weight: 900;
        line-height: 1;
        color: #0a0a0f;
        background: #4ade80;
        border: 1px solid rgba(10,11,18,.85);
        border-radius: 50%;
        pointer-events: none;
        z-index: 3;
      }

      .wlo-loot-panel-row.wlo-loot-panel-row-met::before {
        content: '';
        position: absolute;
        inset: 0;
        background: rgba(74,222,128,.28);
        border-radius: 8px;
        z-index: 0;
        pointer-events: none;
      }
      /* lift the actual row content above the fill layer so text/thumb still render on top of it */
      .wlo-loot-panel-row.wlo-loot-panel-row-met > * {
        position: relative;
        z-index: 1;
      }
      /* --- Hide Loot: hover/peek now scoped to the image itself, not
         the whole card --- */
      html.wlo-all-hidden .wlo-strip { display: none !important; }
      html.wlo-all-hidden .wlo-img-wrap:hover .wlo-strip { display: flex !important; }
      html.wlo-all-hidden .wlo-img-wrap.wlo-peek .wlo-strip { display: flex !important; }

      /* --- dense-loot side panel: small on-image indicator + a bigger
         panel that opens to the side on hover/tap of the image --- */
      .wlo-loot-indicator {
        position: absolute; left: 50%; bottom: 6px; transform: translateX(-50%);
        display: flex; align-items: center; gap: 4px;
        font-size: 11px; font-weight: 800; color: #ffd369;
        background: rgba(10,11,18,.85); border: 1px solid rgba(255,211,105,.4);
        border-radius: 999px; padding: 3px 9px; white-space: nowrap;
        pointer-events: none;
      }

      /* Strip-mode cards: hide the pill whenever the strip itself is being
         shown — Hide Loot off (strip always visible), or Hide Loot on but
         currently hovering/peeking (strip revealed). Side-panel-mode cards
         have no strip to conflict with, so their pill just always shows. */
      .wlo-img-wrap:not(.wlo-side-mode) .wlo-loot-indicator { display: none; }
      html.wlo-all-hidden .wlo-img-wrap:not(.wlo-side-mode) .wlo-loot-indicator { display: flex; }
      html.wlo-all-hidden .wlo-img-wrap:not(.wlo-side-mode):hover .wlo-loot-indicator { display: none; }
      html.wlo-all-hidden .wlo-img-wrap:not(.wlo-side-mode).wlo-peek .wlo-loot-indicator { display: none; }

      .wlo-loot-panel {
        position: absolute; top: 0; left: calc(100% + 10px); z-index: 30;
        width: 260px; max-width: 70vw; max-height: min(420px, 90vh);
        overflow-y: auto;
        background: #12131c; border: 1px solid #2B2D44; border-radius: 10px;
        box-shadow: 0 10px 26px rgba(0,0,0,.55);
        padding: 10px;
        opacity: 0; visibility: hidden; transform: translateX(-4px);
        transition: opacity .12s ease, transform .12s ease;
        pointer-events: none;
      }
      .wlo-loot-panel.wlo-open {
        opacity: 1; visibility: visible; transform: translateX(0);
        pointer-events: auto;
      }
      .wlo-loot-panel.wlo-flip-left { left: auto; right: calc(100% + 10px); }
      .wlo-loot-panel.wlo-flip-up { top: auto; bottom: 0; }

      .wlo-loot-panel-title {
        font-size: 11px; font-weight: 700; color: #8a90ad;
        text-transform: uppercase; letter-spacing: .04em;
        margin-bottom: 8px;
      }
      .wlo-loot-panel-list { display: flex; flex-direction: column; gap: 8px; }
      .wlo-loot-panel-row { display: flex; gap: 10px; position: relative; }
      .wlo-loot-panel-row.wlo-loot-panel-row-met {
        background: rgba(74,222,128,.08);
        border-radius: 8px;
        margin: -4px -6px;
        padding: 4px 6px;
      }
      .wlo-loot-panel-thumb {
        width: 44px; height: 44px; flex-shrink: 0; border-radius: 15%;
        overflow: hidden; background: #0e0f18;
        border: 2px solid rgba(255,255,255,.3);
      }
      .wlo-loot-panel-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .wlo-loot-panel-thumb.wlo-tier-epic   { border-color: rgba(168,85,247,.9); }
      .wlo-loot-panel-thumb.wlo-tier-rare   { border-color: rgba(59,130,246,.9); }
      .wlo-loot-panel-thumb.wlo-tier-common { border-color: rgba(148,163,184,.9); }
      .wlo-loot-panel-body { min-width: 0; flex: 1; }
      .wlo-loot-panel-name-row { display: flex; align-items: center; justify-content: center; gap: 6px; }
      .wlo-loot-panel-name { font-size: 12.5px; font-weight: 700; color: #e6e9ff; min-width: 0; white-space: normal; word-break: break-word; text-align: center; flex: 1 1 auto; }
      .wlo-loot-panel-drop { font-size: 11px; font-weight: 800; color: #ffe066; flex-shrink: 0; }
      .wlo-loot-panel-meta { font-size: 10.5px; color: #ffd369; margin-top: 2px; }
      .wlo-loot-panel-desc { font-size: 10.5px; color: #8a90ad; margin-top: 2px; line-height: 1.3; }

      #wlo-toolbar {
        box-sizing: border-box;
        display: flex; flex-wrap: wrap; align-items: center; justify-content: center;
        gap: 10px; padding: 10px 14px; margin: 0 auto 14px;
      }
      #wlo-toolbar-inner {
        display: flex; flex-wrap: wrap; align-items: center; justify-content: center;
        gap: 10px; width: 100%;
        background: #171923; border: 1px solid #2B2D44; border-radius: 10px;
        padding: 10px 14px;
      }
      #wlo-toolbar input[type="text"] {
        padding: 6px 9px; font-size: 12px;
        background: #12141f; color: #e6e9ff;
        border: 1px solid #2B2D44; border-radius: 6px;
        min-width: 140px;
      }
      #wlo-toolbar select {
        padding: 6px 9px; font-size: 12px;
        background: #12141f; color: #e6e9ff;
        border: 1px solid #2B2D44; border-radius: 6px;
      }
      #wlo-toolbar input[type="text"]::placeholder { color: #6b7089; }
      .wlo-tb-check {
        display: flex; align-items: center; gap: 6px;
        font-size: 12px; color: #cdd4ff; cursor: pointer; user-select: none;
        white-space: nowrap;
      }
      .wlo-tb-check input { cursor: pointer; }

      .wlo-dd { position: relative; display: inline-block; }
      .wlo-dd-btn {
        padding: 6px 10px; font-size: 12px;
        background: #12141f; color: #e6e9ff;
        border: 1px solid #2B2D44; border-radius: 6px;
        cursor: pointer; min-width: 130px; text-align: left;
        white-space: nowrap;
      }
      .wlo-dd-btn:hover { border-color: #3d3f5c; }
      .wlo-dd-panel {
        display: none; position: absolute; top: 100%; left: 0; margin-top: 4px;
        background: #12141f; border: 1px solid #2B2D44; border-radius: 8px;
        padding: 8px; z-index: 1000; min-width: 220px; max-height: 260px;
        overflow-y: auto;
      }
      .wlo-dd.wlo-dd-open .wlo-dd-panel { display: block; }
      .wlo-dd-search {
        width: 100%; box-sizing: border-box; margin-bottom: 6px;
        padding: 5px 7px; font-size: 11px;
        background: #0e0f18; color: #e6e9ff;
        border: 1px solid #2B2D44; border-radius: 5px;
      }
      .wlo-dd-item {
        display: flex; align-items: center; gap: 7px;
        font-size: 12px; color: #cdd4ff; padding: 3px 2px; cursor: pointer;
      }
      .wlo-dd-item input { cursor: pointer; flex-shrink: 0; }
      .wlo-dd-item span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .wlo-dd-actions { display: flex; gap: 6px; margin-top: 6px; padding-top: 6px; border-top: 1px solid #23253a; }
      .wlo-dd-actions button {
        flex: 1; font-size: 11px; padding: 4px 6px; border-radius: 5px; cursor: pointer;
        border: 1px solid #2B2D44; background: #171923; color: #cdd4ff;
      }
      .wlo-dd-actions button:hover { border-color: #3d3f5c; }

      /* --- group-by-type divider: full-width regardless of whether the
         cards container is CSS grid, flexbox, or block. Now clickable
         to collapse/expand its section. --- */
      .wlo-group-divider {
        grid-column: 1 / -1; flex-basis: 100%; width: 100%; box-sizing: border-box;
        display: flex; align-items: center; justify-content: space-between;
        gap: 8px; margin: 10px 0 2px; padding: 7px 12px;
        background: #171923; border: 1px solid #2B2D44; border-radius: 8px;
        font-size: 12px; font-weight: 700; color: #cdd4ff;
        text-transform: uppercase; letter-spacing: .03em;
        cursor: pointer; user-select: none;
      }
      .wlo-group-divider:hover { border-color: #3d3f5c; }
      .wlo-group-divider:first-child { margin-top: 0; }
      .wlo-group-divider-left { display: flex; align-items: center; gap: 8px; }
      .wlo-group-divider-caret {
        display: inline-block; font-size: 9px; line-height: 1;
        transition: transform .15s ease;
      }
      .wlo-group-divider.wlo-group-collapsed .wlo-group-divider-caret {
        transform: rotate(-90deg);
      }
      .wlo-group-divider-count {
        font-size: 11px; font-weight: 700; color: #8a90ad;
        text-transform: none; letter-spacing: normal;
      }

      #wlo-toast {
        position: fixed; top: 20px; right: 20px; z-index: 99999;
        padding: 12px 20px; border-radius: 10px; box-shadow: 0 4px 12px rgba(0,0,0,.4);
        font-size: 14px; color: #fff; display: none;
      }
      #wlo-toast.wlo-toast-success { background: #2ecc71; }
      #wlo-toast.wlo-toast-error { background: #e74c3c; }

      .wlo-refresh-btn {
        padding: 6px 10px; font-size: 12px; line-height: 1;
        background: #12141f; color: #e6e9ff;
        border: 1px solid #2B2D44; border-radius: 6px;
        cursor: pointer; white-space: nowrap;
      }
      .wlo-refresh-btn:hover { border-color: #3d3f5c; }
      .wlo-refresh-btn:disabled { opacity: .5; cursor: default; }
    `;
    document.head.appendChild(style);
  }

  function tierClass(tier) {
    const t = (tier || '').toLowerCase();
    if (t.includes('epic')) return 'wlo-tier-epic';
    if (t.includes('rare')) return 'wlo-tier-rare';
    if (t.includes('common')) return 'wlo-tier-common';
    return '';
  }

  function buildTooltip(item) {
    const bits = [item.name];
    if (item.tier) bits.push(`Tier: ${item.tier}`);
    if (Number.isFinite(item.dropPct)) bits.push(`Drop: ${item.dropPct}%`);
    if (Number.isFinite(item.dmgReq)) bits.push(`DMG req: ${item.dmgReq.toLocaleString()}`);
    if (item.desc) bits.push(item.desc);
    return bits.join('\n');
  }

  // ---------- compact bottom-strip (used unless it would overflow) ----------

  function buildStripElement(items, userDmg) {
    const strip = document.createElement('div');
    strip.className = 'wlo-strip';

    items.forEach((item) => {
      if (!item.src) return;
      const chip = document.createElement('div');
      chip.className = 'wlo-chip';
      chip.title = buildTooltip(item);

      const thumb = document.createElement('div');
      thumb.className = 'wlo-thumb ' + tierClass(item.tier);

      const img = document.createElement('img');
      img.src = item.src;
      img.alt = item.name;
      thumb.appendChild(img);

      if (Number.isFinite(item.dropPct)) {
        const drop = document.createElement('span');
        drop.className = 'wlo-drop';
        drop.textContent = `${item.dropPct}%`;
        thumb.appendChild(drop);
      }

      if (Number.isFinite(item.dmgReq)) thumb.dataset.dmgReq = String(item.dmgReq);
      thumb.classList.toggle('wlo-met', Number.isFinite(item.dmgReq) && Number.isFinite(userDmg) && userDmg >= item.dmgReq);

      // Dmg requirement now lives INSIDE the thumb, overlaid across its
      // base, instead of as a separate pill below the icon.
      if (Number.isFinite(item.dmgReq)) {
        const dmg = document.createElement('span');
        dmg.className = 'wlo-dmg';
        dmg.textContent = formatShort(item.dmgReq);
        thumb.appendChild(dmg);
      }

      chip.appendChild(thumb);
      strip.appendChild(chip);
    });

    return strip;
  }

  // Measures the strip's natural height against the image's rendered
  // height, bypassing whatever hide/reveal state is currently active
  // (briefly forcing display:flex + visibility:hidden so layout happens
  // without a visible flash), then reverts to let the real CSS state
  // take back over.
  function shouldUseSidePanel(wrap, strip) {
    if (isAlwaysSidePanelEnabled()) return true;
    strip.style.setProperty('display', 'flex', 'important');
    strip.style.visibility = 'hidden';
    const imgHeight = wrap.getBoundingClientRect().height;
    const stripHeight = strip.getBoundingClientRect().height;
    strip.style.removeProperty('display');
    strip.style.removeProperty('visibility');

    if (!imgHeight || !stripHeight) return false;
    return (stripHeight / imgHeight) > SIDE_PANEL_COVERAGE_THRESHOLD;
  }

  // ---------- bigger, cleaner side panel (used when the strip would overflow) ----------

  function buildLootPanelElement(items, userDmg) {
    const panel = document.createElement('div');
    panel.className = 'wlo-loot-panel';

    const title = document.createElement('div');
    title.className = 'wlo-loot-panel-title';
    title.textContent = `Possible Loot (${items.length})`;
    panel.appendChild(title);

    const list = document.createElement('div');
    list.className = 'wlo-loot-panel-list';

    items.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'wlo-loot-panel-row';

      const thumb = document.createElement('div');
      thumb.className = 'wlo-loot-panel-thumb ' + tierClass(item.tier);
      if (item.src) {
        const img = document.createElement('img');
        img.src = item.src;
        img.alt = item.name;
        thumb.appendChild(img);
      }
      row.appendChild(thumb);

      const body = document.createElement('div');
      body.className = 'wlo-loot-panel-body';

      const nameRow = document.createElement('div');
      nameRow.className = 'wlo-loot-panel-name-row';
      const name = document.createElement('span');
      name.className = 'wlo-loot-panel-name';
      name.textContent = item.name;
      nameRow.appendChild(name);
      if (Number.isFinite(item.dropPct)) {
        const drop = document.createElement('span');
        drop.className = 'wlo-loot-panel-drop';
        drop.textContent = `${item.dropPct}%`;
        nameRow.appendChild(drop);
      }
      body.appendChild(nameRow);

      if (Number.isFinite(item.dmgReq)) row.dataset.dmgReq = String(item.dmgReq);
      row.classList.toggle('wlo-loot-panel-row-met', Number.isFinite(item.dmgReq) && Number.isFinite(userDmg) && userDmg >= item.dmgReq);
      const metaBits = [];
      if (item.tier) metaBits.push(item.tier);
      if (Number.isFinite(item.dmgReq)) metaBits.push(`DMG req: ${formatShort(item.dmgReq)}`);
      if (metaBits.length) {
        const meta = document.createElement('div');
        meta.className = 'wlo-loot-panel-meta';
        meta.textContent = metaBits.join(' • ');
        body.appendChild(meta);
      }

      row.appendChild(body);
      list.appendChild(row);
    });

    panel.appendChild(list);
    return panel;
  }

  // Hover (mouse) opens the panel with JS-computed flip-to-the-other-side
  // positioning, same idea as the dashboard's tile hover panels. Touch
  // (no hover) toggles it open/closed on tap of the image.
  function attachLootSidePanel(wrap, panel) {
    const supportsHover = window.matchMedia('(hover: hover)').matches;
    const card = wrap.closest('.monster-card');

    function openPanel() {
      document.querySelectorAll('.wlo-loot-panel.wlo-open').forEach((p) => {
        if (p !== panel) {
          p.classList.remove('wlo-open', 'wlo-flip-left', 'wlo-flip-up');
          p.closest('.monster-card')?.classList.remove('wlo-card-elevated');
        }
      });
      panel.classList.remove('wlo-flip-left', 'wlo-flip-up');
      panel.classList.add('wlo-open');
      card?.classList.add('wlo-card-elevated');

      const rect = panel.getBoundingClientRect();
      if (rect.right > window.innerWidth - 8) panel.classList.add('wlo-flip-left');

      const afterRect = panel.getBoundingClientRect();
      if (afterRect.bottom > window.innerHeight - 8) panel.classList.add('wlo-flip-up');
    }
    function closePanel() {
      panel.classList.remove('wlo-open', 'wlo-flip-left', 'wlo-flip-up');
      card?.classList.remove('wlo-card-elevated');
    }

    if (supportsHover) {
      let closeTimer = null;
      const cancelClose = () => { if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; } };

      // Checks real hover state at fire-time instead of trusting the
      // mouseleave event itself. During a window resize, the card's box
      // shifts under a stationary cursor, which makes the browser fire
      // genuine mouseleave/mouseenter pairs even though you never moved —
      // closing+reopening the panel each time, which animates via its own
      // opacity/transform transition and reads as "pulsing." Bailing out
      // here when the cursor is still actually over wrap/panel means a
      // spurious leave event never results in a close at all.
      function scheduleClose() {
        clearTimeout(closeTimer);
        closeTimer = setTimeout(() => {
          if (wrap.matches(':hover') || panel.matches(':hover')) return;
          closePanel();
        }, 150);
      }

      wrap.addEventListener('mouseenter', () => {
        cancelClose();
        if (panel.classList.contains('wlo-open')) return;
        openPanel();
      });
      wrap.addEventListener('mouseleave', scheduleClose);
      panel.addEventListener('mouseenter', cancelClose);
      panel.addEventListener('mouseleave', scheduleClose);
    } else {
      wrap.addEventListener('click', (e) => {
        if (e.target.closest('.wlo-loot-panel')) return; // clicks inside the panel don't toggle it
        if (e.target.closest('a, button')) return;
        e.preventDefault();
        e.stopPropagation();
        if (panel.classList.contains('wlo-open')) closePanel(); else openPanel();
      });
      document.addEventListener('click', (e) => {
        if (!wrap.contains(e.target)) closePanel();
      });
    }
  }

  function switchToSidePanel(wrap, strip, items, indicator, userDmg) {
    strip.remove();
    wrap.classList.add('wlo-side-mode');

    // indicator was already created + appended by renderLootDisplay
    indicator.textContent = `🎁 ${items.length}`;

    const panel = buildLootPanelElement(items, userDmg);
    wrap.appendChild(panel);
    attachLootSidePanel(wrap, panel);
  }

  function rebuildLootDisplays() {
    document.querySelectorAll('.monster-card').forEach((card) => {
      const wrap = card.querySelector(':scope > .wlo-img-wrap');
      const name = getCardGroupKey(card);
      const viewUrl = getViewUrl(card);
      if (!wrap || !name || !viewUrl) return;

      wrap.querySelectorAll('.wlo-strip, .wlo-loot-indicator, .wlo-loot-panel').forEach((el) => el.remove());
      wrap.classList.remove('wlo-side-mode');
      delete wrap.dataset.wloRendered;

      const userDmg = getCardDamage(card);
      ensureLoot(name, viewUrl).then((items) => renderLootDisplay(wrap, items, userDmg));
    });
  }

  function renderLootDisplay(wrap, items, userDmg) {
    if (!items.length || wrap.dataset.wloRendered === '1') return;
    wrap.dataset.wloRendered = '1';

    const strip = buildStripElement(items, userDmg);
    wrap.appendChild(strip);

    const indicator = document.createElement('div');
    indicator.className = 'wlo-loot-indicator';
    indicator.textContent = `🎁 ${items.length}`;
    wrap.appendChild(indicator);

    // "Always Vertical Panel" skips the measurement dance entirely.
    if (isAlwaysSidePanelEnabled()) {
      switchToSidePanel(wrap, strip, items, indicator, userDmg);
      return;
    }

    // Re-checks a bounded number of times as layout settles, then stops
    // for good. Only `wrap` is observed — NOT `strip`. shouldUseSidePanel()
    // restyles `strip` to measure it; observing `strip` too meant that
    // restyle counted as a genuine resize of an observed target, which
    // re-queued this same callback forever (the "pulsing"). The check is
    // also deferred to rAF, outside the observer's synchronous callback,
    // so the restyle-to-measure can't retrigger itself in the same tick.
    let switched = false;
    let checkCount = 0;
    const MAX_CHECKS = 6;

    function check() {
      if (switched || checkCount >= MAX_CHECKS) return;
      checkCount++;
      if (shouldUseSidePanel(wrap, strip)) {
        switched = true;
        switchToSidePanel(wrap, strip, items, indicator, userDmg);
        ro.disconnect();
        return;
      }
      if (checkCount >= MAX_CHECKS) ro.disconnect();
    }

    const ro = new ResizeObserver(() => {
      if (switched || checkCount >= MAX_CHECKS) return;
      requestAnimationFrame(check);
    });
    ro.observe(wrap);

    requestAnimationFrame(check);
  }

  function updateMetIndicators() {
    document.querySelectorAll('.monster-card').forEach((card) => {
      const wrap = card.querySelector(':scope > .wlo-img-wrap');
      if (!wrap) return;
      const userDmg = getCardDamage(card);

      wrap.querySelectorAll('.wlo-thumb[data-dmg-req]').forEach((thumb) => {
        const req = Number(thumb.dataset.dmgReq);
        thumb.classList.toggle('wlo-met', Number.isFinite(req) && Number.isFinite(userDmg) && userDmg >= req);
      });

      wrap.querySelectorAll('.wlo-loot-panel-row[data-dmg-req]').forEach((row) => {
        const req = Number(row.dataset.dmgReq);
        row.classList.toggle('wlo-loot-panel-row-met', Number.isFinite(req) && Number.isFinite(userDmg) && userDmg >= req);
      });
    });
  }

  function ensureImgWrapper(card) {
    let wrap = card.querySelector(':scope > .wlo-img-wrap');
    if (wrap) return wrap;
    const img = card.querySelector(':scope > img.monster-img');
    if (!img) return null;
    wrap = document.createElement('div');
    wrap.className = 'wlo-img-wrap';
    img.before(wrap);
    wrap.appendChild(img);
    return wrap;
  }

  // ---------- global hide state ----------

  const HIDE_ALL_KEY = 'wloHideAllLoot';
  function isHideAllEnabled() { return localStorage.getItem(HIDE_ALL_KEY) === '1'; }
  function setHideAllEnabled(v) {
    localStorage.setItem(HIDE_ALL_KEY, v ? '1' : '0');
    document.documentElement.classList.toggle('wlo-all-hidden', v);
  }

  const ALWAYS_SIDE_PANEL_KEY = 'wloAlwaysSidePanel';
  function isAlwaysSidePanelEnabled() { return localStorage.getItem(ALWAYS_SIDE_PANEL_KEY) === '1'; }
  function setAlwaysSidePanelEnabled(v) {
    localStorage.setItem(ALWAYS_SIDE_PANEL_KEY, v ? '1' : '0');
  }

  // ---------- group-by-type state ----------

  const GROUP_KEY = 'wloGroupByType';
  function isGroupByTypeEnabled() { return localStorage.getItem(GROUP_KEY) === '1'; }
  function setGroupByTypeEnabled(v) {
    localStorage.setItem(GROUP_KEY, v ? '1' : '0');
    applyGrouping();
  }

  // Which group keys are currently collapsed. Persisted in localStorage so
  // collapsed sections stay collapsed across page reloads/navigations.
  const COLLAPSED_GROUPS_KEY = 'wloCollapsedGroups';

  function loadCollapsedGroups() {
    try {
      const arr = JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_KEY) || '[]');
      return new Set(Array.isArray(arr) ? arr : []);
    } catch (_) {
      return new Set();
    }
  }
  function saveCollapsedGroups() {
    try {
      localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(Array.from(collapsedGroups)));
    } catch (_) { /* ignore quota errors */ }
  }

  const collapsedGroups = loadCollapsedGroups();

  function toggleGroupCollapse(key) {
    if (collapsedGroups.has(key)) collapsedGroups.delete(key);
    else collapsedGroups.add(key);
    saveCollapsedGroups();

    const container = getCardsContainer();
    const divider = container && Array.from(container.querySelectorAll(':scope > .wlo-group-divider'))
      .find((d) => d.dataset.wloGroupKey === key);
    if (divider) divider.classList.toggle('wlo-group-collapsed', collapsedGroups.has(key));

    applyFilters();
  }
  // ---------- refresh (manual + auto) ----------

  const REFRESH_INTERVAL_KEY = 'wloRefreshIntervalMs';
  const REFRESH_TYPE_KEY = 'wloRefreshType'; // 'none' | 'soft' | 'hard'

  function getRefreshIntervalMs() {
    const n = Number(localStorage.getItem(REFRESH_INTERVAL_KEY));
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }
  function setRefreshIntervalMs(ms) {
    localStorage.setItem(REFRESH_INTERVAL_KEY, String(ms));
  }
  function getRefreshType() {
    const v = localStorage.getItem(REFRESH_TYPE_KEY);
    return (v === 'soft' || v === 'hard') ? v : 'none';
  }
  function setRefreshType(type) {
    localStorage.setItem(REFRESH_TYPE_KEY, (type === 'soft' || type === 'hard') ? type : 'none');
  }

  function showWaveToast(msg, type) { Core.ui.toast(msg, type !== 'error', 3000); }

  // Refetches this same active_wave.php URL, pulls the fresh set of
  // .monster-card nodes out of the response, and swaps them into the live
  // cards container in place — no navigation, no toolbar/filter reset.
  // Fresh cards carry none of our own dataset markers (wloDone, wloRendered,
  // wloOrigIndex, etc.), so the normal run() pipeline treats them as
  // brand-new: it re-fetches loot (served instantly from lootCache when the
  // monster name repeats — no extra network round-trip there) and
  // re-applies whatever filters/grouping/search is already set in the bar.
  async function fetchFreshHtml() {
    // Fetch with THIS tab's mode cookies (alive / dead / all), under the
    // cross-tab lock, so we always get back the same kind of page we're on.
    return Core.cookies.withMode(PAGE_MODE, async () => {
      const res = await fetch(location.href, { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    });
  }

  // Serializes just the cards container's markup (not the whole page) —
  // this is what gets broadcast to other tabs, so the payload stays small.
  function extractCardsContainerHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const anchor = doc.querySelector('.monster-card') || doc.querySelector('.monster-section-title');
    if (anchor && anchor.parentElement) return anchor.parentElement.innerHTML;
    // A real wave page that simply has no cards right now (e.g. the last
    // alive mob just died) is valid: return '' so the cards get cleared.
    if (doc.querySelector('#server_time, .auto-summon-card')) return '';
    throw new Error('Refreshed page did not look like a wave page (logged out?).');
  }

  // Applies already-fetched cards markup (ours or another tab's) to the
  // live DOM. Shared by softRefresh() and the cross-tab 'data' listener.
  function applyContainerHtml(containerHtml) {
    const container = getCardsContainer();
    if (!container) {
      // Page started with no cards and no known container: only a reload can rebuild it.
      if (containerHtml) hardRefresh();
      return;
    }

    const temp = document.createElement('div');
    temp.innerHTML = containerHtml;

    container.querySelectorAll(':scope > .wlo-group-divider').forEach((el) => el.remove());
    container.querySelectorAll(':scope > .monster-card, :scope > .monster-section-title').forEach((el) => el.remove());

    const frag = document.createDocumentFragment();
    Array.from(temp.querySelectorAll(':scope > .monster-card, :scope > .monster-section-title'))
      .forEach((node) => frag.appendChild(node));
    container.appendChild(frag);

    run();
  }
  let softRefreshInFlight = false;
  async function softRefresh() {
    if (softRefreshInFlight) return;
    softRefreshInFlight = true;
    try {
      const html = await fetchFreshHtml();
      const containerHtml = extractCardsContainerHtml(html);
      applyContainerHtml(containerHtml);
      broadcastFreshData(containerHtml); // share it so other tabs skip their own fetch
      showWaveToast('Wave data refreshed.', 'success');
    } catch (err) {
      console.warn('[wave-loot] soft refresh failed', err);
      showWaveToast('Refresh failed — try again.', 'error');
    } finally {
      softRefreshInFlight = false;
    }
  }

  function hardRefresh() {
    // Set THIS tab's mode cookies inside the cross-tab lock, then reload. The
    // request goes out with them; the backup stays in localStorage and the
    // next page load's recover() (shared helper) puts the cookies back.
    Core.cookies.withMode(PAGE_MODE, () => {
      location.reload();
      return new Promise((resolve) => setTimeout(resolve, 10000)); // release if the reload never happens
    });
  }

  async function doRefresh(isAuto) {
    const type = getRefreshType();
    if (type === 'none') return;
    if (pageHasDeadMonstersSection()) return; // nothing here will ever change

    if (isAuto && Date.now() - getLastRefreshAt() < 2000) {
      // Defensive: another tab's timer already fired within the last couple
      // seconds. scheduleAutoRefresh()'s own re-check below should prevent
      // this in normal operation — this just covers same-tick races.
      return;
    }

    if (type === 'hard') {
      markRefreshedNow();
      hardRefresh();
    } else if (type === 'soft') {
      if (isAuto) {
        await claimLeadershipAndRefresh(); // election decides whether THIS tab fetches
      } else {
        await softRefresh();
      }
    }
  }

  // setTimeout-based (not setInterval) so every fire re-checks the shared
  // cross-tab clock and re-times itself off it — this is what keeps
  // multiple open tabs on the same wave refreshing together instead of
  // each running its own independent, drifting interval.
  let autoRefreshTimer = null;
  function scheduleAutoRefresh() {
    if (autoRefreshTimer) { clearTimeout(autoRefreshTimer); autoRefreshTimer = null; }
    const type = getRefreshType();
    const ms = getRefreshIntervalMs();
    if (type === 'none' || !ms || pageHasDeadMonstersSection()) return;

    const wait = Math.max(0, ms - (Date.now() - getLastRefreshAt()));
    autoRefreshTimer = setTimeout(async () => {
      if (Date.now() - getLastRefreshAt() < ms) {
        // Another tab refreshed while we waited — re-time off it instead
        // of firing a redundant fetch of our own.
        scheduleAutoRefresh();
        return;
      }
      await doRefresh(true);
      scheduleAutoRefresh();
    }, wait);
  }

  function syncRefreshControlsForDeadMonsters() {
    const bar = document.getElementById('wlo-toolbar');
    if (!bar) return;
    const typeSelect = bar.querySelector('#wlo-refresh-type');
    const intervalSelect = bar.querySelector('#wlo-refresh-interval');
    const refreshBtn = bar.querySelector('#wlo-refresh-now');
    const hpSelect = bar.querySelector('#wlo-hp-filter');
    if (!typeSelect || !intervalSelect || !refreshBtn) return;

    if (pageHasDeadMonstersSection()) {
      typeSelect.style.display = 'none';
      intervalSelect.style.display = 'none';
      refreshBtn.style.display = 'none';
      if (hpSelect) hpSelect.style.display = 'none';
      if (autoRefreshTimer) { clearTimeout(autoRefreshTimer); autoRefreshTimer = null; }
      return;
    }

    typeSelect.style.display = '';
    if (hpSelect) hpSelect.style.display = '';
    const show = typeSelect.value !== 'none';
    intervalSelect.style.display = show ? '' : 'none';
    refreshBtn.style.display = show ? '' : 'none';
    scheduleAutoRefresh();
  }

  let wloOrigIndexCounter = 0;


  function getCardGroupKey(card) {
    return clean(card.dataset.name || card.querySelector('h3')?.textContent || '').toLowerCase();
  }

  let cachedCardsContainer = null;
  function getCardsContainer() {
    const anchor = document.querySelector('.monster-card') || document.querySelector('.monster-section-title');
    if (anchor && anchor.parentElement) cachedCardsContainer = anchor.parentElement;
    return (cachedCardsContainer && cachedCardsContainer.isConnected) ? cachedCardsContainer : null;
  }

  // Physically reorders cards into contiguous per-name blocks, each
  // preceded by a full-width, collapsible divider. Skips the DOM rewrite
  // if the current layout already matches, so this is safe to call on
  // every filter/toggle change without causing needless reflow.
  function applyGrouping() {
    const container = getCardsContainer();
    if (!container) return;
    const enabled = isGroupByTypeEnabled();

    const cards = Array.from(container.querySelectorAll(':scope > .monster-card'))
      .sort((a, b) => {
        const aHas = cardHasDamage(a) ? 1 : 0;
        const bHas = cardHasDamage(b) ? 1 : 0;
        if (aHas !== bHas) return bHas - aHas; // damaged cards always before undamaged

        if (isExpDmgSortHighestEnabled()) {
          const aRatio = expDmgRatioByName.get(getCardGroupKey(a));
          const bRatio = expDmgRatioByName.get(getCardGroupKey(b));
          const aOk = Number.isFinite(aRatio);
          const bOk = Number.isFinite(bRatio);
          if (aOk !== bOk) return bOk - aOk; // known ratio before still-loading
          if (aOk && bOk && aRatio !== bRatio) return bRatio - aRatio; // higher ratio first
        }

        return (Number(a.dataset.wloOrigIndex) || 0) - (Number(b.dataset.wloOrigIndex) || 0);
      });

    const desired = [];
    if (enabled) {
      const groups = new Map();
      cards.forEach((card) => {
        const key = getCardGroupKey(card);
        if (!groups.has(key)) {
          const label = clean(card.dataset.name || card.querySelector('h3')?.textContent || key);
          groups.set(key, { key, label, cards: [] });
        }
        groups.get(key).cards.push(card);
      });
      groups.forEach((g) => {
        desired.push({ type: 'divider', key: g.key, label: g.label });
        g.cards.forEach((c) => desired.push({ type: 'card', node: c }));
      });
    } else {
      cards.forEach((c) => desired.push({ type: 'card', node: c }));
    }

    // Reuse existing divider nodes by key so toggle-collapsed state and
    // event listeners survive a re-run; anything not pulled into `desired`
    // below gets removed afterward.
    const seenKeys = new Set(desired.filter((d) => d.type === 'divider').map((d) => d.key));
    const existingDividers = new Map();
    container.querySelectorAll(':scope > .wlo-group-divider').forEach((div) => {
      existingDividers.set(div.dataset.wloGroupKey, div);
    });

    // Resolve each desired slot to its actual node WITHOUT touching the
    // container yet, so we can check whether a reorder is even needed.
    const resolvedNodes = desired.map((d) => {
      if (d.type === 'divider') {
        let divider = existingDividers.get(d.key);
        if (!divider) {
          divider = document.createElement('div');
          divider.className = 'wlo-group-divider';
          divider.dataset.wloGroupKey = d.key;
          if (collapsedGroups.has(d.key)) divider.classList.add('wlo-group-collapsed');
          divider.innerHTML = `
            <span class="wlo-group-divider-left">
              <span class="wlo-group-divider-caret">▾</span>
              <span>${escapeHtml(d.label)}</span>
            </span>
            <span class="wlo-group-divider-count"></span>
          `;
          divider.addEventListener('click', () => toggleGroupCollapse(d.key));
        }
        return divider;
      }
      d.node.style.removeProperty('order'); // clean up leftover order from an older version
      return d.node;
    });

    existingDividers.forEach((div, key) => {
      if (!seenKeys.has(key)) div.remove();
    });

    // Skip the reorder entirely if the container is already in the right
    // order. Even a no-op appendChild() is a real DOM mutation — and with
    // the page's MutationObserver watching for the first 20s, an unneeded
    // reorder re-triggers run() -> applyGrouping() -> another reorder,
    // repeatedly. With several monster cards, each one's loot finishing
    // its own async fetch was enough to kick this loop off on its own —
    // and moving a currently-hovered card's node out and back in mid-loop
    // is what fired spurious mouseleave/mouseenter on it, which is what
    // was actually opening and closing the side panel ("pulsing").
    const currentNodes = Array.from(container.children);
    const alreadyInOrder = resolvedNodes.length === currentNodes.length
      && resolvedNodes.every((node, i) => node === currentNodes[i]);

    if (!alreadyInOrder) {
      const frag = document.createDocumentFragment();
      resolvedNodes.forEach((node) => frag.appendChild(node));
      container.appendChild(frag);
    }

    updateGroupDividerCounts();
  }

  // Recomputes each divider's "matching/total" count based on the
  // per-card wloMatchesFilter flag set in applyFilters(), independent of
  // whether the section is currently collapsed. A divider is hidden
  // entirely only when nothing in it matches the active filters — a
  // manually collapsed section with matches stays visible (collapsed) so
  // it can be expanded again.
  function updateGroupDividerCounts() {
    const container = getCardsContainer();
    if (!container) return;
    let currentDivider = null, totalInGroup = 0, matchingInGroup = 0;
    const flush = () => {
      if (!currentDivider) return;
      const countEl = currentDivider.querySelector('.wlo-group-divider-count');
      const collapsed = currentDivider.classList.contains('wlo-group-collapsed');
      if (countEl) {
        countEl.textContent = collapsed
          ? `${matchingInGroup}/${totalInGroup} · hidden`
          : `${matchingInGroup}/${totalInGroup}`;
      }
      currentDivider.style.display = matchingInGroup > 0 ? '' : 'none';
    };
    Array.from(container.children).forEach((el) => {
      if (el.classList.contains('wlo-group-divider')) {
        flush();
        currentDivider = el; totalInGroup = 0; matchingInGroup = 0;
      } else if (el.classList.contains('monster-card')) {
        totalInGroup++;
        if (el.dataset.wloMatchesFilter === '1') matchingInGroup++;
      }
    });
    flush();
  }



  // ---------- cross-tab refresh sync + leader election ----------
  // Keyed by the exact URL (gate/wave live in the query string) so tabs on
  // different waves never dedupe against each other.
  const TAB_ID = Math.random().toString(36).slice(2) + '_' + Date.now();

  function getRefreshSyncKey() {
    return 'wloLastRefreshAt::' + PAGE_MODE + '::' + location.pathname + location.search;
  }
  function getLastRefreshAt() {
    const n = Number(localStorage.getItem(getRefreshSyncKey()));
    return Number.isFinite(n) ? n : 0;
  }
  function getLockKey() {
    return 'wloRefreshLock::' + PAGE_MODE + '::' + location.pathname + location.search;
  }
  const REFRESH_LOCK_TTL_MS = 8000; // long enough to cover a slow fetch

  // BroadcastChannel now does double duty: 'refreshed' is a lightweight
  // nudge (re-time only), 'data' carries the actual fetched cards markup
  // so every OTHER tab can apply it directly instead of fetching it again.
  const wloRefreshChannel = ('BroadcastChannel' in window)
    ? new BroadcastChannel('wlo-wave-refresh::' + PAGE_MODE + '::' + location.pathname + location.search)
    : null;

  let pendingLeaderWaitTimer = null;
  let pendingLeaderWaitResolved = false;
  let pendingLeaderWaitResolveFn = null;
  function resolvePendingLeaderWait() {
    pendingLeaderWaitResolved = true;
    if (pendingLeaderWaitTimer) { clearTimeout(pendingLeaderWaitTimer); pendingLeaderWaitTimer = null; }
    if (pendingLeaderWaitResolveFn) { const fn = pendingLeaderWaitResolveFn; pendingLeaderWaitResolveFn = null; fn(); }
  }

  wloRefreshChannel?.addEventListener('message', (e) => {
    if (e.data?.type === 'refreshed') {
      scheduleAutoRefresh();
    } else if (e.data?.type === 'data') {
      if (e.data.mode !== PAGE_MODE) return; // belt-and-braces: never apply another mode's cards
      resolvePendingLeaderWait();
      if (e.data.tabId !== TAB_ID) {
        applyContainerHtml(e.data.html); // another tab already fetched this — reuse it
      }
      scheduleAutoRefresh();
    }
  });
  // Fallback: browsers without BroadcastChannel just fall back to each tab
  // fetching on its own schedule — there's no payload to relay through
  // localStorage alone, only the 'storage' event's re-timing nudge.
  window.addEventListener('storage', (e) => {
    if (e.key === getRefreshSyncKey()) scheduleAutoRefresh();
  });

  function markRefreshedNow() {
    const now = Date.now();
    localStorage.setItem(getRefreshSyncKey(), String(now));
    wloRefreshChannel?.postMessage({ type: 'refreshed', at: now });
  }

  // Shares a just-fetched refresh with every other open tab on this wave.
  function broadcastFreshData(containerHtml) {
    const now = Date.now();
    localStorage.setItem(getRefreshSyncKey(), String(now));
    wloRefreshChannel?.postMessage({ type: 'data', html: containerHtml, at: now, tabId: TAB_ID, mode: PAGE_MODE });
  }

  // ---------- leader election: one fetch per cycle, not one per tab ----------
  // Whichever tab's timer fires first tries to claim a short-lived lock in
  // localStorage. Only the tab that wins does the real fetch; every other
  // tab just waits for its broadcast and reuses the result — 10 tabs open
  // on the same wave make 1 request, not 10.
  function claimLeadershipAndRefresh() {
    return new Promise((resolve) => {
      const key = getLockKey();
      const now = Date.now();
      let existing = null;
      try { existing = JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { /* ignore */ }

      if (existing && (now - existing.ts) < REFRESH_LOCK_TTL_MS) {
        // Someone already claimed this refresh recently — just wait for
        // their broadcast (with a fallback below).
        waitForLeaderOrFallback().then(resolve);
        return;
      }

      // Tentatively claim it, then double-check after a short random
      // jitter — this is what stops two tabs whose timers fire in the same
      // tick from both believing they won. Whichever write lands LAST
      // wins; the other one sees that on its re-read and stands down.
      localStorage.setItem(key, JSON.stringify({ tabId: TAB_ID, ts: now }));
      setTimeout(() => {
        let current = null;
        try { current = JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { /* ignore */ }
        if (current && current.tabId === TAB_ID) {
          softRefresh().then(resolve); // we won — fetch for real, then broadcast
        } else {
          waitForLeaderOrFallback().then(resolve); // someone else's claim landed after ours
        }
      }, 25 + Math.random() * 75);
    });
  }

  function waitForLeaderOrFallback() {
    return new Promise((resolve) => {
      pendingLeaderWaitResolved = false;
      pendingLeaderWaitResolveFn = resolve;
      clearTimeout(pendingLeaderWaitTimer);
      pendingLeaderWaitTimer = setTimeout(() => {
        if (!pendingLeaderWaitResolved) {
          // The elected leader never broadcast back (closed tab, network
          // hiccup, etc.) — fetch it ourselves rather than wait forever.
          pendingLeaderWaitResolveFn = null;
          softRefresh().then(resolve);
        }
      }, 6000);
    });
  }

  // ---------- dead-monsters guard ----------
  // No longer skips dead pages: a dead-mode tab now refreshes using dead-mode
  // cookies (see PAGE_MODE / fetchFreshHtml) instead of being frozen.
  function pageHasDeadMonstersSection() {
    return false;
  }


  // ---------- EXP/DMG sort state ----------

  const EXPDMG_SORT_KEY = 'wloExpDmgSortHighest';
  function isExpDmgSortHighestEnabled() { return localStorage.getItem(EXPDMG_SORT_KEY) === '1'; }
  function setExpDmgSortHighestEnabled(v) {
    localStorage.setItem(EXPDMG_SORT_KEY, v ? '1' : '0');
    applyGrouping(); // re-sorts cards; also refreshes filter/divider state
  }

  // ---------- touch tap-to-peek (devices with no hover), scoped to the image ----------

  function attachTapPeek() {
    if (window.matchMedia('(hover: hover)').matches) return;
    document.addEventListener('click', (e) => {
      const wrap = e.target.closest('.wlo-img-wrap');
      document.querySelectorAll('.wlo-img-wrap.wlo-peek').forEach((w) => {
        if (w !== wrap) w.classList.remove('wlo-peek');
      });
      // Side-panel-mode images have their own tap handling (open/close the
      // panel) attached in attachLootSidePanel — don't also toggle peek there.
      if (wrap && isHideAllEnabled() && !wrap.classList.contains('wlo-side-mode')) {
        if (e.target.closest('a, button')) return;
        wrap.classList.toggle('wlo-peek');
      }
    });
  }

  // ---------- filtering state ----------

  const lootItemNamesCache = new Map();
  const selectedMonsters = new Set();
  const selectedLootItems = new Set();
  const knownLootItemNames = new Set();
  const expDmgRatioByName = new Map(); // name -> ratio|null, filled in once ensureExpDmg resolves
  let monsterNameQuery = '';

  function getCardHpPercent(card) {
    const fill = card.querySelector('.hp-fill');
    if (!fill) return null;
    const m = (fill.style.width || '').match(/([\d.]+)%/);
    return m ? parseFloat(m[1]) : null;
  }

  function hpMatches(pct, filterValue) {
    if (!filterValue) return true;
    if (pct === null) return false;
    if (filterValue === 'full') return pct >= 99.9;
    const gt = filterValue.match(/^gt(\d+)$/);
    if (gt) return pct > Number(gt[1]);
    const lt = filterValue.match(/^lt(\d+)$/);
    if (lt) return pct < Number(lt[1]);
    return true;
  }

  function expDmgMatches(ratio, filterValue) {
    if (!filterValue) return true;
    if (ratio === null || ratio === undefined) return false; // not fetched yet, or genuinely unknown
    const gt = filterValue.match(/^gt([\d.]+)$/);
    if (gt) return ratio > Number(gt[1]);
    const lt = filterValue.match(/^lt([\d.]+)$/);
    if (lt) return ratio < Number(lt[1]);
    return true;
  }

  function applyFilters() {
    const nameQuery = monsterNameQuery;
    const hpFilter = document.getElementById('wlo-hp-filter')?.value || '';

    document.querySelectorAll('.monster-card').forEach((card) => {
      const name = getCardGroupKey(card);

      const nameOk = !nameQuery || name.includes(nameQuery);
      const hpOk = hpMatches(getCardHpPercent(card), hpFilter);
      const monsterOk = selectedMonsters.size === 0 || selectedMonsters.has(name);

      let lootOk = true;
      if (selectedLootItems.size > 0) {
        const itemsForCard = lootItemNamesCache.get(name);
        lootOk = !!itemsForCard && Array.from(selectedLootItems).some((sel) => itemsForCard.has(sel));
      }

      const matches = nameOk && hpOk && monsterOk && lootOk;
      card.dataset.wloMatchesFilter = matches ? '1' : '0';

      const collapsed = isGroupByTypeEnabled() && collapsedGroups.has(name);
      card.style.display = (matches && !collapsed) ? '' : 'none';
    });

    updateGroupDividerCounts();
  }

  // ---------- generic checkbox multi-select dropdown ----------

  function buildDropdown({ id, buttonLabel, searchable, searchPlaceholder, onSearchInput }) {
    const dd = document.createElement('div');
    dd.className = 'wlo-dd';
    dd.id = id;
    dd.innerHTML = `
      <button type="button" class="wlo-dd-btn">${buttonLabel}</button>
      <div class="wlo-dd-panel">
        ${searchable ? `<input type="text" class="wlo-dd-search" placeholder="${searchPlaceholder || 'Search...'}">` : ''}
        <div class="wlo-dd-list"></div>
        <div class="wlo-dd-actions">
          <button type="button" class="wlo-dd-clear">Clear</button>
        </div>
      </div>
    `;

    const btn = dd.querySelector('.wlo-dd-btn');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = dd.classList.contains('wlo-dd-open');
      document.querySelectorAll('.wlo-dd.wlo-dd-open').forEach((o) => o.classList.remove('wlo-dd-open'));
      if (!wasOpen) dd.classList.add('wlo-dd-open');
    });

    if (searchable) {
      const search = dd.querySelector('.wlo-dd-search');
      search.addEventListener('input', () => {
        const q = search.value.toLowerCase();
        dd.querySelectorAll('.wlo-dd-item').forEach((item) => {
          item.style.display = item.dataset.label.includes(q) ? '' : 'none';
        });
        if (onSearchInput) onSearchInput(q); // merged: also live-filters cards directly
      });
      search.addEventListener('click', (e) => e.stopPropagation());
    }

    dd.querySelector('.wlo-dd-panel').addEventListener('click', (e) => e.stopPropagation());
    return dd;
  }

  document.addEventListener('click', () => {
    document.querySelectorAll('.wlo-dd.wlo-dd-open').forEach((o) => o.classList.remove('wlo-dd-open'));
  });

  function addDropdownItem(dd, value, label, selectedSet, onChange, buttonLabelPrefix) {
    const list = dd.querySelector('.wlo-dd-list');
    if (list.querySelector(`input[data-value="${CSS.escape(value)}"]`)) return;

    const row = document.createElement('label');
    row.className = 'wlo-dd-item';
    row.dataset.label = label.toLowerCase();

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.value = value;
    cb.checked = selectedSet.has(value);

    const span = document.createElement('span');
    span.textContent = label;
    span.title = label;

    row.appendChild(cb);
    row.appendChild(span);
    list.appendChild(row);

    cb.addEventListener('change', () => {
      if (cb.checked) selectedSet.add(value); else selectedSet.delete(value);
      updateDropdownButtonLabel(dd, selectedSet, buttonLabelPrefix);
      onChange();
    });
  }

  function updateDropdownButtonLabel(dd, selectedSet, prefix) {
    const btn = dd.querySelector('.wlo-dd-btn');
    btn.textContent = selectedSet.size > 0 ? `${prefix} (${selectedSet.size}) ▾` : `${prefix} ▾`;
  }

  // ---------- toolbar ----------

  let toolbarResizeObs = null;

  function syncToolbarWidth(bar, container) {
    const w = container.getBoundingClientRect().width;
    if (w > 0) bar.style.width = w + 'px';
  }

  function buildToolbar() {
    if (document.getElementById('wlo-toolbar')) return;
    const container = getCardsContainer();
    if (!container || !container.parentElement) return;

    const bar = document.createElement('div');
    bar.id = 'wlo-toolbar';
    bar.innerHTML = `<div id="wlo-toolbar-inner">
      <select id="wlo-hp-filter">
        <option value="">All HP</option>
        <option value="full">Full HP (100%)</option>
        <option value="gt75">HP &gt; 75%</option>
        <option value="gt50">HP &gt; 50%</option>
        <option value="gt25">HP &gt; 25%</option>
        <option value="lt75">HP &lt; 75%</option>
        <option value="lt50">HP &lt; 50%</option>
        <option value="lt25">HP &lt; 25%</option>
        <option value="lt10">HP &lt; 10%</option>
      </select>
      <select id="wlo-refresh-type" title="None: no auto-refresh. Soft: re-fetch and swap in updated cards. Hard: full page reload.">
        <option value="none">No refresh</option>
        <option value="soft">Soft refresh</option>
        <option value="hard">Hard refresh</option>
      </select>
      <select id="wlo-refresh-interval" title="How often to auto-refresh (ignored when 'No refresh' is selected)">
        <option value="10000">Every 10s</option>
        <option value="30000">Every 30s</option>
        <option value="60000">Every 1m</option>
        <option value="120000">Every 2m</option>
        <option value="300000">Every 5m</option>
        <option value="600000">Every 10m</option>
      </select>
      <button type="button" id="wlo-refresh-now" class="wlo-refresh-btn" title="Refresh now">🔄 Refresh</button>
    </div>`;

    container.parentElement.insertBefore(bar, container);
    syncToolbarWidth(bar, container);

    if (toolbarResizeObs) toolbarResizeObs.disconnect();
    toolbarResizeObs = new ResizeObserver(() => syncToolbarWidth(bar, container));
    toolbarResizeObs.observe(container);
    window.addEventListener('resize', () => syncToolbarWidth(bar, container));

    const inner = bar.querySelector('#wlo-toolbar-inner');
    const hpSelect = bar.querySelector('#wlo-hp-filter');

    const monsterDd = buildDropdown({
      id: 'wlo-monster-dd',
      buttonLabel: 'Monsters ▾',
      searchable: true,
      searchPlaceholder: 'Search by name...',
      onSearchInput: (q) => {
        monsterNameQuery = q;
        if (selectedMonsters.size === 0) {
          monsterDd.querySelector('.wlo-dd-btn').textContent = q ? `Monsters (🔍) ▾` : 'Monsters ▾';
        }
        applyFilters();
      }
    });
    inner.insertBefore(monsterDd, hpSelect);
    const seenMonsterNames = new Set();
    document.querySelectorAll('.monster-card').forEach((card) => {
      const raw = clean(card.dataset.name || card.querySelector('h3')?.textContent || '');
      const key = raw.toLowerCase();
      if (!key || seenMonsterNames.has(key)) return;
      seenMonsterNames.add(key);
      addDropdownItem(monsterDd, key, raw, selectedMonsters, applyFilters, 'Monsters');
    });
    monsterDd.querySelector('.wlo-dd-clear').addEventListener('click', () => {
      selectedMonsters.clear();
      monsterDd.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = false; });
      const searchBox = monsterDd.querySelector('.wlo-dd-search');
      if (searchBox) searchBox.value = '';
      monsterNameQuery = '';
      monsterDd.querySelectorAll('.wlo-dd-item').forEach((item) => { item.style.display = ''; });
      updateDropdownButtonLabel(monsterDd, selectedMonsters, 'Monsters');
      applyFilters();
    });

    const lootDd = buildDropdown({ id: 'wlo-loot-item-dd', buttonLabel: 'Loot Item ▾', searchable: true });
    inner.insertBefore(lootDd, hpSelect);
    lootDd.querySelector('.wlo-dd-clear').addEventListener('click', () => {
      selectedLootItems.clear();
      lootDd.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = false; });
      updateDropdownButtonLabel(lootDd, selectedLootItems, 'Loot Item');
      applyFilters();
    });
    buildToolbar._lootDd = lootDd;

    const optionsDd = buildDropdown({ id: 'wlo-options-dd', buttonLabel: 'Options ▾', searchable: false });
    inner.insertBefore(optionsDd, hpSelect);
    optionsDd.querySelector('.wlo-dd-actions')?.remove(); // no bulk-clear needed for 3 independent toggles
    optionsDd.querySelector('.wlo-dd-list').innerHTML = `
      <label class="wlo-dd-item"><input type="checkbox" id="wlo-hide-toggle"><span>Hide Loot</span></label>
      <label class="wlo-dd-item"><input type="checkbox" id="wlo-side-panel-toggle"><span>Always Vertical Panel</span></label>
      <label class="wlo-dd-item"><input type="checkbox" id="wlo-group-toggle"><span>Group by Type</span></label>
      <label class="wlo-dd-item"><input type="checkbox" id="wlo-expdmg-sort"><span>Sort by Highest EXP/DMG</span></label>
    `;

    function updateOptionsLabel() {
      const count = [isHideAllEnabled(), isAlwaysSidePanelEnabled(), isGroupByTypeEnabled(), isExpDmgSortHighestEnabled()].filter(Boolean).length;
      optionsDd.querySelector('.wlo-dd-btn').textContent = count > 0 ? `Options (${count}) ▾` : 'Options ▾';
    }

    const hideBox = optionsDd.querySelector('#wlo-hide-toggle');
    hideBox.checked = isHideAllEnabled();
    hideBox.addEventListener('change', () => { setHideAllEnabled(hideBox.checked); updateOptionsLabel(); });
    document.documentElement.classList.toggle('wlo-all-hidden', isHideAllEnabled());

    const sidePanelBox = optionsDd.querySelector('#wlo-side-panel-toggle');
    sidePanelBox.checked = isAlwaysSidePanelEnabled();
    sidePanelBox.addEventListener('change', () => {
      setAlwaysSidePanelEnabled(sidePanelBox.checked);
      rebuildLootDisplays();
      updateOptionsLabel();
    });

    const groupBox = optionsDd.querySelector('#wlo-group-toggle');
    groupBox.checked = isGroupByTypeEnabled();
    groupBox.addEventListener('change', () => { setGroupByTypeEnabled(groupBox.checked); applyFilters(); updateOptionsLabel(); });

    const sortBox = optionsDd.querySelector('#wlo-expdmg-sort');
    sortBox.checked = isExpDmgSortHighestEnabled();
    sortBox.addEventListener('change', () => { setExpDmgSortHighestEnabled(sortBox.checked); updateOptionsLabel(); });

    updateOptionsLabel();

    hpSelect.addEventListener('change', applyFilters);

    const typeSelect = bar.querySelector('#wlo-refresh-type');
    const intervalSelect = bar.querySelector('#wlo-refresh-interval');
    const refreshBtn = bar.querySelector('#wlo-refresh-now');

    function syncRefreshControlsVisibility() {
      const show = typeSelect.value !== 'none';
      intervalSelect.style.display = show ? '' : 'none';
      refreshBtn.style.display = show ? '' : 'none';
    }

    typeSelect.value = getRefreshType();
    intervalSelect.value = String(getRefreshIntervalMs() || 60000);
    syncRefreshControlsVisibility();

    typeSelect.addEventListener('change', () => {
      setRefreshType(typeSelect.value);
      syncRefreshControlsVisibility();
      scheduleAutoRefresh();
    });
    intervalSelect.addEventListener('change', () => {
      setRefreshIntervalMs(Number(intervalSelect.value) || 60000);
      scheduleAutoRefresh();
    });

    refreshBtn.addEventListener('click', async () => {
      if (pageHasDeadMonstersSection()) return; // button should be hidden, but guard anyway
      const type = getRefreshType() === 'hard' ? 'hard' : 'soft';
      if (type === 'hard') { markRefreshedNow(); hardRefresh(); return; }
      refreshBtn.disabled = true;
      const original = refreshBtn.textContent;
      refreshBtn.textContent = '⏳ Refreshing…';
      try {
        await softRefresh(); // fetches, applies, AND broadcasts to any other open tabs
      } finally {
        refreshBtn.disabled = false;
        refreshBtn.textContent = original;
        scheduleAutoRefresh();
      }
    });

    syncRefreshControlsForDeadMonsters();
  }

  function registerLootItemName(rawName) {
    const key = rawName.toLowerCase();
    if (!key || knownLootItemNames.has(key)) return;
    knownLootItemNames.add(key);
    const lootDd = buildToolbar._lootDd;
    if (lootDd) addDropdownItem(lootDd, key, rawName, selectedLootItems, applyFilters, 'Loot Item');
  }

  // ---------- dispatch ----------

  const lootCache = new Map();
  const expDmgCache = new Map(); // name -> Promise<ratio|null>, one fetch per monster type

  function getViewUrl(card) {
    const link = card.querySelector('a[href*="battle.php?id="]');
    return link ? link.href : null;
  }

  function ensureLoot(name, viewUrl) {
    if (!lootCache.has(name)) {
      lootCache.set(name, fetchLootForUrl(viewUrl)
        .then((items) => {
          const nameSet = new Set();
          items.forEach((i) => {
            if (!i.name) return;
            nameSet.add(i.name.toLowerCase());
            registerLootItemName(i.name);
          });
          lootItemNamesCache.set(name, nameSet);
          return items;
        })
        .catch((err) => {
          console.warn('[wave-loot] failed to load loot for', name, err);
          lootItemNamesCache.set(name, new Set());
          return [];
        }));
    }
    return lootCache.get(name);
  }


  function ensureExpDmg(name, viewUrl) {
    if (!expDmgCache.has(name)) {
      expDmgCache.set(name, fetchExpDmgRatio(viewUrl)
        .then((ratio) => {
          expDmgRatioByName.set(name, ratio);
          applyGrouping();
          return ratio;
        })
        .catch((err) => {
          console.warn('[wave-loot] failed to load EXP/DMG ratio for', name, err);
          expDmgRatioByName.set(name, null);
          return null;
        }));
    }
    return expDmgCache.get(name);
  }

  let attachedTapPeek = false;

  function run() {
    injectStyles();
    buildToolbar();
    syncRefreshControlsForDeadMonsters();
    if (!attachedTapPeek) { attachTapPeek(); attachedTapPeek = true; }
    let anyNew = false;
    const newNamesForExpDmg = new Map(); // name -> viewUrl, resolved after everything else below
    document.querySelectorAll('.monster-card').forEach((card) => {
      if (card.dataset.wloDone === '1') return;
      const name = getCardGroupKey(card);
      const viewUrl = getViewUrl(card);
      const wrap = ensureImgWrapper(card);
      if (!name || !viewUrl || !wrap) return;

      card.dataset.wloDone = '1';
      card.dataset.wloOrigIndex = String(wloOrigIndexCounter++);
      anyNew = true;
      const userDmg = getCardDamage(card);
      ensureLoot(name, viewUrl).then((items) => {
        renderLootDisplay(wrap, items, userDmg);
        applyFilters();
      });

      if (!expDmgCache.has(name)) newNamesForExpDmg.set(name, viewUrl);
    });

    applyGrouping();
    updateMetIndicators();
    if (anyNew) applyFilters();

    newNamesForExpDmg.forEach((viewUrl, name) => ensureExpDmg(name, viewUrl));
  }

  let rerunTimer = null;
  function scheduleRun() {
    clearTimeout(rerunTimer);
    rerunTimer = setTimeout(run, 50);
  }
  const observer = new MutationObserver(scheduleRun);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), 20000);

  run();
})();