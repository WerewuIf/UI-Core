/* Battle Page Restructure — Core addon (migrated from the standalone userscript).
 * Loaded by core.user.js; `Core` is in scope. No @require / header needed.
 * Runs early (document-start) — addons.json sets "early": true. /stats.php, /inventory.php, /pets.php reads share the Core.net cache.
 */

//               v15.9 adds: WYVERN / REINDEER BONUSES ARE NOW AUTO-DETECTED (no more hand-set ELEMENT_BONUS).
//                 Read from the passive text of your PvE team AND their linked pets:
//                   - "X% <ELEMENT> Element Rate Increase" (Nullscale Wyvern: VOID) multiplies that
//                     element's rate by (1 + X%) in the advantage formula. Works for any element name.
//                   - "X% Extra Elemental Damage ..." (Hellfrost Reindeer) multiplies elemental damage
//                     by (1 + X%).
//                 Main-team pets count at full value. A LINKED pet's passive counts at its link share
//                 (Link 1 = 50%, Link 2 = 25%) -- unless the Links panel's own effect text for that link
//                 already shows a smaller (i.e. pre-scaled) number, in which case that server number is used.
//                 PvP-only lines are ignored. The tooltip's "Bonuses" line lists each detected bonus and
//                 where it came from; the console logs every link passive under "[BattlePage] link passive".
//                 ELEMENT_BONUS is now only a manual EXTRA on top of the detected values (leave at 0).
//               v15.8 adds: LINKED PETS NOW COUNT TOWARD YOUR ELEMENT RATE. A pet on your PvE team
//                 contributes its own element rate in full (e.g. 5%); the pet in its Link 1 slot
//                 contributes 50% of ITS element rate (2.5%), Link 2 contributes 25% (1.25%). These
//                 are added into the same per-element totals as gear + main pets, so the
//                 highest-rate element (and therefore your element / advantage) reflects links too.
//                 Same-race link bonuses are NOT applied to element (the game says transferred-stat
//                 boosts don't touch elemental contribution). The tooltip shows a Sources line
//                 (gear / pets / links) for your element so the total can be sanity-checked against
//                 the game, and the console logs every link contribution under "[BattlePage] link element".
//               v15.7 fixes (ELEMENT CHECK REWRITTEN TO MATCH THE GAME'S DAMAGE FORMULA):
//                 The old isElementDisadvantaged() was wrong in several places. It is replaced by
//                 computeElementMatchup(), which follows the rules from the Damage Formula panel:
//                   - Monster has no element  -> whole check skipped (no icon).
//                   - Your element = your highest-rate element (gear + PvE team). Ties now resolve
//                     via ELEMENT_TIE_ORDER instead of "whichever key came first".
//                   - Your strength <= 5%: the monster's rate counts as 0.5% and you can NOT take the
//                     disadvantage (this includes having no element at all -> green, not red).
//                   - Counter doubling: if element A counters element B, A's rate is x2. This applies
//                     to whichever side counters (you, the monster, or neither).
//                   - Advantage = your adjusted rate - monster's adjusted rate. Below 0 = disadvantage
//                     (all damage -33%), i.e. red. A lower rate than the monster's is NOT automatically
//                     fine any more (the old "pRate < mRate -> OK" shortcut was backwards).
//                   - Elemental damage = (your adj. rate - monster adj. rate) x 1500 x stamina_cost.
//                     The tooltip shows it per 1 stamina and for a World Breaker hit.
//                 Suggestions now list the exact minimum rate each counter element / the monster's own
//                 element needs to reach advantage >= 0 (no longer "any rate").
//                 ELEMENT_BONUS (Wyvern for Void, Reindeer for elemental damage) defaults to 0 because the
//                 script can't read pet bonuses; set them by hand near WARN_COUNTERS.
//               v15.6 adds:
//                 ELEMENT WARNING ICON (always on when the monster has an element): the first icon on
//                 the warning rail, with the monster's element as its emoji. GREEN = your current
//                 element passes the script's elemental check (counters / higher); RED = it fails it (or you have none).
//                 Hover/tap it for: monster element + rate, your element + rate, the suggested counter
//                 elements with the minimum rate each needs (and what you have of each), and the
//                 same-element rate needed. Replaces the old yellow "Elemental disadvantage" icon.
//                 Verdict = computeElementMatchup() (rewritten in v15.7, see above): green = not
//                 disadvantaged, red = disadvantaged.
//                 Yellow "?" icon = monster element couldn't be read yet (opening "View Monster Stats"
//                 fills it in automatically).
//                 The monster's element is read from the live stats grid, else from a one-time
//                 re-fetch of this page.

//               v15.3 fixes:
//                 (1) LEADERBOARD vs ATTACK LOG STILL DIDN'T END EVENLY, AND LEADERBOARD GREW A
//                     PHANTOM HORIZONTAL SCROLLBAR THAT HID THE NAMES: giving Leaderboard the same
//                     "overflow-y:auto + max-height" treatment as Log in v15.2 had a side effect
//                     neither of us caught — per the CSS overflow spec, setting only overflow-y to
//                     a non-'visible' value forces the OTHER axis (overflow-x) to compute as 'auto'
//                     too. That gave Leaderboard's body a horizontal scrollbar it never needed, and
//                     the presence of that scrollable axis let the row's flex children size to
//                     their preferred (max-content) width instead of being constrained to the
//                     visible column width — which is what pushed the name off to the right, out of
//                     view, behind the "DMG" figure. Leaderboard no longer gets a max-height/
//                     scrollbox at all (the game already paginates it — see the v12.0 note below),
//                     and Log/Battle Info/Rewards now pin overflow-x:hidden alongside overflow-y:
//                     auto so this can't recur on any of them. Leaderboard and Log are still made
//                     to end at the same spot when both are expanded, but now via align-self:stretch
//                     on just that pair (see .bm-pair-stretch below) rather than by force-capping
//                     Leaderboard's height — and that stretch is turned off the moment either one is
//                     collapsed, so collapsing still shrinks down to just its toggle bar instead of
//                     leaving a tall empty box (same concern the v15.1 INFO-GRID COLLAPSE fix was
//                     about).
//                 (2) LEADERBOARD/LOG NAME TRUNCATION HARDENED: belt-and-suspenders on top of (1) —
//                     .lb-row and its scroll ancestors now pin min-width:0 / overflow-x:hidden
//                     explicitly rather than relying on the default (which is what let this regress
//                     in the first place) so a name column collapsing to zero width can't quietly
//                     happen again.
//                 (3) ATTACK-TIME FLICKER, THE REMAINING BIT: v15.2 fixed the forced-layout half of
//                     this; the piece it explicitly left as "separate, pre-existing" — the
//                     Leaderboard/Attack Log toggle header flashing away and back on every hit — is
//                     fixed now too. The native game replaces those two panels' innerHTML wholesale
//                     on every attack, which wipes our toggle-bar wrapper; it was getting rebuilt by
//                     the shared MutationObserver, but that's on a 50ms debounce shared with every
//                     other DOM change on the page, so the header was visibly gone for up to 50ms
//                     after every hit. Leaderboard and Log now each get their own dedicated,
//                     un-debounced MutationObserver scoped just to that one element, so the toggle
//                     bar gets rebuilt in the same tick as the native swap instead of waiting in
//                     line behind the shared debounce.
//                 (4) AUTOSLASH DELAY MENU OPENED DOWNWARD, OFF THE BOTTOM OF THE SCREEN: it was
//                     positioned relative to the caret assuming the caret had room below it — true
//                     back when the attack buttons lived inline in the monster card, no longer true
//                     now that they live in the v15.0 bar pinned to the bottom of the viewport. The
//                     menu now opens upward from the caret (falling back to downward only if there
//                     genuinely isn't room above either), and uses position:fixed + a viewport-
//                     relative measurement instead of document coordinates so it doesn't drift out
//                     of place if the page is scrolled while it's open.
//               v15.2 fixes:
//                 (1) DAMAGE RANKING REWARDS NOW SCROLLS: it had no capped height at all, so a
//                     monster with many rank brackets just made the whole column sprawl. It now
//                     gets the same max-height + scrollbar treatment as Log/Battle Info.
//                 (2) LEADERBOARD vs ATTACK LOG NO LONGER END UNEVENLY: Leaderboard was
//                     deliberately left unbounded back in v12.0 (each panel had its own full-width
//                     row then, so height didn't need to match anything). Now that the wide-screen
//                     layout pairs it side-by-side with Attack Log in the 2-up grid, it gets the
//                     same capped height + scrollbar so both panels in a row end at the same spot.
//                 (3) ATTACK-TIME FLICKER REDUCED: pinTopStatBar()/pinAttackBar() were reading
//                     .offsetHeight (which forces a synchronous browser layout) on every single
//                     run() — and run() re-fires on a ~50ms debounce for every DOM mutation,
//                     including the leaderboard/log/HP-bar rewrites that happen on every hit. During
//                     AutoSlash that added up to a lot of forced layout work packed into a very
//                     short window. Both bars now only get measured once, the first time they're
//                     pinned; a shared remeasureStickyBars() handles keeping them in sync on resize
//                     instead. (Note: some brief flicker of the Leaderboard/Attack Log toggle
//                     header on every hit is a separate, pre-existing thing — the native game fully
//                     replaces those two panels' HTML on every attack, which wipes and then rebuilds
//                     our collapse-toggle wrapper each time; see the v11.0 note further down.)
//                 (4) HEAL ROW CENTERED: was right-aligned; centered to match everything else now
//                     that the pill/bubble background around it is gone (see v15.1).
//                 (5) LEADERBOARD DAMAGE NUMBERS NO LONGER WRAP: the Leaderboard column got roughly
//                     half as wide once it moved into the 2-up grid, which was wrapping the damage
//                     figure/"DMG" label across multiple lines. The player name now truncates with
//                     an ellipsis instead, so the damage number always stays on one line.
//               v15.1 fixes:
//                 (1) BOTTOM BAR NO LONGER SPREAD OUT / FULL-WIDTH: it was left:0/right:0 full
//                     viewport width with buttons allowed to wrap, which both spaced them out
//                     more than before AND let the bar's background bleed across the whole bottom
//                     edge — covering native page controls sitting in the bottom corners. It's now
//                     a small pill sized to its own content (buttons stay in one tight, non-
//                     wrapping row, same tight spacing as before), centered via left:50% + a
//                     transform (not vw-based sizing), so it stays put and the same size whether
//                     the page is zoomed in or out, and never touches the left/right edges.
//                 (2) HEAL ROW "BUBBLE" REMOVED: the pill background/border/padding wrapping the
//                     Heal/potion controls is gone — just the plain right-aligned row now.
//                 (3) INFO-GRID COLLAPSE BUG FIXED: on the wide-screen 2-up info grid, panels were
//                     stretching (default grid align-items:stretch) to match the height of
//                     whichever panel shared their row, so collapsing a panel still left a full-
//                     height empty box instead of shrinking — same reason the (unrelated, native)
//                     Monster Debuffs card was showing a big empty gap next to Rewards. Panels now
//                     size to their own content (align-items:start) instead.
//               v15.0 fixes:
//                 (1) STAMINA STAYS VISIBLE WHILE SCROLLED: the game's own top stat bar (Stamina /
//                   Gold / Gems / Server / Buffs / Level / EXP — the ".gtb-inner" row) is now
//                   pinned with position:sticky so it stays on screen instead of scrolling away
//                   once you're down near the attack buttons. Only position/z-index is touched;
//                   the bar's own markup and whatever script keeps its numbers updated is
//                   untouched. If a second bar (e.g. an HP/MP row) sits directly underneath it in
//                   the DOM, that gets pinned too, stacked right below using the first bar's
//                   measured height — but that row belongs to a DIFFERENT userscript entirely, so
//                   this script never creates, styles, or duplicates any HP/MP display of its own
//                   at the top of the page.
//               (2) ATTACK BUTTONS PINNED TO THE BOTTOM OF THE SCREEN: Slash / AutoSlash / World
//                   Breaker (whatever ".battle-actions-buttons" ends up containing) now live in a
//                   fixed bar pinned to the bottom of the viewport instead of inside the monster
//                   card, so they're always reachable with zero scrolling, however far down the
//                   page you are. The "⚔️ Attacks" label and the now-empty divider strip it lived
//                   in are trimmed down rather than left as a dead gap.
//               (3) LOOT MOVED INTO A REAL 3RD COLUMN ON WIDE SCREENS: Loot used to render as one
//                   big block below the entire grid, leaving the whole right-hand side of the
//                   arena empty on wide screens. It's now a genuine grid child, so past ~1400px
//                   viewport width it becomes a sidebar column next to the monster card instead —
//                   below that width it still renders exactly as before (a full-width block under
//                   the grid).
//               (4) INFO COLUMN TILES 2-UP ON WIDE SCREENS: Leaderboard / Attack Log / Battle Info
//                   / Damage Ranking Rewards switch from one tall stack of rows to a 2-column grid
//                   on wide screens, cutting the vertical scroll needed to reach the bottom panels
//                   roughly in half. (If a monster only has 3 of the 4 panels, the last one spans
//                   the full width instead of leaving a lopsided single-column gap next to it.)
//               (5) BIGGER HP/MP BARS: your HP/MP bars and the monster's HP bar are taller and
//                   allowed more width now that there's more breathing room around them, instead
//                   of staying thin lines inside a mostly-empty card.
//               v14.0 fixes:
//                 (1) HEAL CONTROLS SPLIT OFF THE "YOU" LINE: Heal/potion controls no longer share
//                     a line with the "YOU" tag. YOU now sits alone, centered, on its own row; Heal
//                     sits in its own row directly below, aligned to the right.
//                 (2) MONSTER HP NO LONGER ABBREVIATED: dropped the v13.0 formatCompact()/
//                     compactMonsterHpLabel() logic that shortened huge HP values (e.g. "2.40T").
//                     The exact full number is always shown now — see (3) for why that no longer
//                     causes wrapping problems.
//                 (3) MONSTER HP BAR IS HORIZONTAL AGAIN: the v11-v13 "big vertical red bar"
//                     treatment (portrait on the left, HP rotated 90 degrees into a pillar on the
//                     right) is gone. The monster's HP bar is a full-width horizontal bar directly
//                     under the portrait again — same orientation the game natively uses, just
//                     bigger/bolder. This is what actually fixes the label-wrapping problem: a long
//                     HP string gets a full card-width line to sit on instead of a ~70px vertical
//                     label column.
//                 (4) "VIEW MONSTER STATS" -> TOP-LEFT CORNER: relocated off the name/note stack
//                     into a small pinned badge in the monster card's top-left corner.
//                 (5) AUTO-DIE COUNTDOWN -> TOP-RIGHT CORNER: the "will Auto die in HH:MM:SS" chip
//                     moves to a matching pinned badge in the top-right corner, instead of sitting
//                     inline under the monster name.
//                 (6) DAMAGE RANKING REWARDS PANEL: if the page has a ".ranking-rewards-panel" (it
//                     isn't present on every monster), it's now folded into the same collapsible-
//                     panel system as Leaderboard/Attack Log/Battle Info, plus gets matching
//                     card/chip styling for its rank brackets and reward items instead of rendering
//                     as plain unstyled HTML. No-ops harmlessly if the panel doesn't exist on a
//                     given page.
//               v13.0 fixes:
//                 (1) YOU / Heal row + HP / MP bars read as mismatched sizes ("wonky") — gave the
//                     heal controls one shared pill container and forced the HP/MP bar wrappers to
//                     the exact same width.
//                 (2) Boss HP pillar label ragged-wrapping a huge HP value across three lines —
//                     superseded by fix (3) above (horizontal bar), formatCompact() removed.
//                 (3) The "Joined" chip rendering as an orphaned box below the whole card —
//                     relocated up next to the monster name/auto-die chip with matching pill
//                     styling.
//                 (4) The class-skill bar leaving a large dead gap with only one or two skills —
//                     capped skill slots to content-sized, centered chips.
//                 (5) The left-hand info column tracking the viewport while scrolling — reset any
//                     sticky positioning back to static.
//                 (6) "View Monster Stats" rendering as a full-width block — superseded by fix (4)
//                     above (top-left corner badge).
//               v12.0 fixes:
//                 (1) POISON AUTOSLASH DID NOTHING: asSendSlashOnce() queried a *direct*-child
//                     selector that stopped matching once integrateAutoSlash() wrapped the button.
//                     Fixed with a descendant selector.
//                 (2) MONSTER HP <-> YOUR HP/MP SWAPPED: monster HP got the big-bar treatment,
//                     your HP/MP kept the plain native horizontal bars.
//                 (3) YOUR DAMAGE RELOCATED: moved into its own row directly under the arena.
//                 (4) VIEW MONSTER STATS MOVED: under the monster's name/note block.
//                 (5) LEADERBOARD SCROLL REMOVED: native game already paginates it.
//                 (6) HEAL ROW INLINE WITH "YOU": superseded by v14.0 fix (1) above.
//                 (7) AUTO-DIE CHIP STAYS ON MONSTER CARD: superseded by v14.0 fix (5) above.
//               v11.0 fixes:
//                 (1) COLLAPSE DIDN'T ACTUALLY HIDE THE ATTACK LOG: bare text nodes have no
//                     display property, so every collapsible panel's content now lives inside one
//                     ".bm-panel-body" wrapper that gets hidden as a whole.
//                 (2) MONSTER ART FIXED AT 340x420 REGARDLESS OF ZOOM/SCREEN: replaced with fluid
//                     sizing via a single --bm-portrait-w custom property.
//                 (3) MONSTER STATS: the site's own "View Monster Stats" modal replaced the old
//                     inline stat-line this script used to rebuild; old merge code kept as a
//                     harmless no-op for older templates.
//                 (4) Modest type-scale bump + distinct left-border accent per info panel.
//               v10.1 adds:
//                 (6) COLLAPSIBLE SIDE PANELS with per-panel localStorage-persisted state.
//               v10.0 fixes:
//                 (1) Monster image bump (superseded by fluid sizing in v11.0).
//                 (2) Real AUTO caret button; AutoSlash clicks the native Slash button.
//                 (3) Duplicate World Breaker button guard.
//                 (4) Info column row order.
//                 (5) Single shared MutationObserver that never disconnects.

(function () {
  'use strict';

  if (window.__bpOverhaulInstalled) return;
  window.__bpOverhaulInstalled = true;

  // =====================================================================
  // Shared helpers (used by layout, AutoSlash, and World Breaker alike)
  // =====================================================================

  const nf = new Intl.NumberFormat();
  function fmt(n) { return nf.format(Number(n) || 0); }
  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  function clearInlineStyle(el) {
    if (el) el.removeAttribute('style');
  }

  function make(tag, className, html) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function setHtmlIfExists(id, html) {
    document.querySelectorAll(`[id="${id}"]`).forEach(el => { el.innerHTML = html; });
  }

  function setStyleIfExists(id, prop, value) {
    document.querySelectorAll(`[id="${id}"]`).forEach(el => { el.style[prop] = value; });
  }

  function computeReqExp(level) {
    return Math.round(100 + Math.pow(2.5 * (level + 1), 2));
  }

  function showNotification(msg, type = 'success') {
    const note = document.getElementById('notification');
    if (!note) return;
    note.innerHTML = msg;
    note.style.background = (type === 'error') ? '#e74c3c' : '#2ecc71';
    note.style.display = 'block';
    setTimeout(() => { note.style.display = 'none'; }, type === 'error' ? 8000 : 3000);
  }

  // Robust JSON parser: the attack endpoint sometimes prefixes/suffixes the
  // JSON payload with stray text, so try several extraction strategies.
  function parseJsonMaybe(raw) {
    const text = String(raw ?? '');
    const trimmed = text.replace(/^\uFEFF/, '').trim();
    const candidates = [text, trimmed];

    const firstLine = trimmed.split(/\r?\n/, 1)[0];
    if (firstLine && firstLine.trim().startsWith('{')) candidates.push(firstLine.trim());

    const firstJsonObject = (() => {
      const start = trimmed.indexOf('{');
      if (start < 0) return '';
      let depth = 0, inString = false, escaped = false;
      for (let i = start; i < trimmed.length; i++) {
        const ch = trimmed[i];
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') inString = true;
        else if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) return trimmed.slice(start, i + 1);
        }
      }
      return '';
    })();
    if (firstJsonObject) candidates.push(firstJsonObject);

    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(trimmed.slice(firstBrace, lastBrace + 1));

    for (const candidate of candidates) {
      if (!candidate) continue;
      try { return JSON.parse(candidate); } catch (_) {}
    }
    return null;
  }

  function isDungeonBattle() {
    const params = new URLSearchParams(window.location.search);
    return params.has('dgmid') && params.has('instance_id');
  }

  function getBattleCfg() {
    return window.BATTLE_CFG || {};
  }

  function getAttackEndpoint() {
    const cfg = getBattleCfg();
    return (cfg.endpoints && cfg.endpoints.ATTACK) || 'damage.php';
  }

  function getMonsterId() {
    const cfg = getBattleCfg();
    const params = new URLSearchParams(window.location.search);
    return Number(cfg.id || 0) || Number(params.get('monster_id') || params.get('id') || params.get('mid') || 0) || 0;
  }

  // Unifies the old AutoSlash getAttackPayload() and World Breaker baseQS():
  // prefers BATTLE_CFG fields, falls back to URL params either way.
  function buildAttackBody(skillId, staminaCost) {
    const cfg = getBattleCfg();
    const params = new URLSearchParams(window.location.search);
    const body = new URLSearchParams();

    if (isDungeonBattle() || cfg.isDungeon) {
      const dgmid = cfg.dgmid || params.get('dgmid');
      const instanceId = cfg.instanceId || params.get('instance_id');
      if (instanceId) body.set('instance_id', String(instanceId));
      if (dgmid) body.set('dgmid', String(dgmid));
    } else {
      const monsterId = getMonsterId();
      if (monsterId) body.set('monster_id', String(monsterId));
    }

    body.set('skill_id', String(skillId));
    body.set('stamina_cost', String(staminaCost));
    return body;
  }

  async function sendAttack(skillId, staminaCost) {
    const body = buildAttackBody(skillId, staminaCost);
    const endpoint = getAttackEndpoint();

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: body.toString(),
      credentials: 'same-origin'
    });

    const raw = await res.text();
    const data = parseJsonMaybe(raw);
    return { res, raw, data };
  }

  // ---- v10.0: transparent attack-response watcher ----
  // AutoSlash used to build its own request and apply its own UI updates —
  // a second code path running in parallel with a manual click. Now it
  // clicks the page's real native Slash button instead, so the native
  // handler does the request AND the UI update exactly as it would for a
  // human click. The only thing AutoSlash still needs is to know *what
  // happened* (damage dealt, out of stamina, on cooldown) so it can decide
  // whether to keep going. This wraps window.fetch once, clones the
  // response for reading (the clone never touches what the native code
  // receives), and hands matching responses to whoever is waiting — pure
  // observation, zero interference.
  const attackResponseWaiters = [];

  function getRequestBodySkillId(init) {
    try {
      const body = init && init.body;
      if (!body) return null;
      const text = (typeof body === 'string') ? body : String(body);
      const m = text.match(/(?:^|&)skill_id=([^&]*)/);
      return m ? decodeURIComponent(m[1]) : null;
    } catch (_) { return null; }
  }

  function installAttackResponseWatcher() {
    if (window.__bpFetchWatcherInstalled) return;
    window.__bpFetchWatcherInstalled = true;

    const nativeFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      const url = (typeof input === 'string') ? input : (input && input.url) || '';
      const promise = nativeFetch(input, init);

      if (attackResponseWaiters.length && String(url).indexOf(getAttackEndpoint()) !== -1) {
        const skillId = getRequestBodySkillId(init);
        promise.then(res => {
          res.clone().text().then(raw => {
            const data = parseJsonMaybe(raw);
            for (let i = attackResponseWaiters.length - 1; i >= 0; i--) {
              const waiter = attackResponseWaiters[i];
              if (waiter.skillId === null || waiter.skillId === skillId) {
                attackResponseWaiters.splice(i, 1);
                clearTimeout(waiter.timer);
                waiter.resolve({ raw, data });
              }
            }
          }).catch(() => {});
        }).catch(() => {});
      }

      return promise;
    };
  }

  function waitForAttackResponse(skillId, timeoutMs = 8000) {
    installAttackResponseWatcher();
    return new Promise(resolve => {
      const waiter = { skillId, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const idx = attackResponseWaiters.indexOf(waiter);
        if (idx !== -1) attackResponseWaiters.splice(idx, 1);
        resolve(null);
      }, timeoutMs);
      attackResponseWaiters.push(waiter);
    });
  }



  function extractDamage(data) {
    if (!data || String(data.status || '').trim() !== 'success') return null;
    const logs = Array.isArray(data.logs) ? data.logs : [];
    const row = logs.find(r => r && r.SKILL_NAME === 'Slash' && Number.isFinite(Number(r.DAMAGE)));
    if (row) return Number(row.DAMAGE);
    if (logs[0] && Number.isFinite(Number(logs[0].DAMAGE))) return Number(logs[0].DAMAGE);
    const msg = String(data.message || '');
    const m = msg.match(/You have dealt\s*<strong>([\d,]+)<\/strong>/i);
    if (m) return Number(m[1].replace(/,/g, ''));
    return null;
  }

  function isCooldownMessage(msg) {
    const s = String(msg || '').toLowerCase();
    return s.includes('slow down') || s.includes('too quickly') || s.includes('wait for the cooldown');
  }

  function isNoStaminaMessage(msg) {
    return String(msg || '').toLowerCase().includes('not enough stamina');
  }

  // ---- shared post-attack UI updates (HP/MP/stamina/exp/leaderboard/log) ----

  function animateMonster() {
    const monsterImage = document.getElementById('monsterImage');
    if (!monsterImage) return;
    monsterImage.classList.add('attack');
    setTimeout(() => monsterImage.classList.remove('attack'), 200);
  }

  function updateHpUI(hp) {
    if (!hp) return;
    if (typeof hp.percent === 'number') setStyleIfExists('hpFill', 'width', hp.percent + '%');
    if (typeof hp.value !== 'undefined' && typeof hp.max !== 'undefined') {
      setHtmlIfExists('hpText', `❤️ ${fmt(hp.value)} / ${fmt(hp.max)} HP`);
    }
  }

  function updateStaminaUI(stamina) {
    if (stamina === undefined || stamina === null) return;
    setHtmlIfExists('stamina_span', fmt(stamina));
  }

  function updateManaUI(mana, playerMaxMana = 200) {
    if (typeof mana !== 'number') return;
    const manaVal = Math.max(0, Math.min(playerMaxMana, mana));
    const manaPct = playerMaxMana > 0 ? (manaVal / playerMaxMana) * 100 : 0;
    setStyleIfExists('pManaFill', 'width', manaPct + '%');
    setHtmlIfExists('pManaText', `💠 ${fmt(manaVal)} / ${fmt(playerMaxMana)} MP`);
  }

  function updateRetaliationUI(retaliation, playerMaxHp = 415500) {
    if (!retaliation || typeof retaliation.user_hp_after !== 'number') return;
    const afterHP = retaliation.user_hp_after;
    const pct = Math.max(0, Math.min(100, (afterHP / playerMaxHp) * 100));
    setStyleIfExists('pHpFill', 'width', pct + '%');
    setHtmlIfExists('pHpText', `💚 ${fmt(afterHP)} / ${fmt(playerMaxHp)} HP`);
  }

  function addExpUIFallback(amount) {
    const expTop = document.querySelector('.gtb-exp-top span:last-child');
    const expFill = document.querySelector('.gtb-exp-fill');
    const lvlEl = document.querySelector('.gtb-level');
    if (!expTop || !expFill || !lvlEl) return;

    let level = parseInt((lvlEl.textContent || '').replace(/[^0-9]/g, ''), 10) || 0;
    const parts = (expTop.textContent || '').split('/');
    let current = parseInt((parts[0] || '').replace(/[^0-9]/g, ''), 10);
    let required = parseInt((parts[1] || '').replace(/[^0-9]/g, ''), 10);

    if (!Number.isFinite(current) || !Number.isFinite(required)) {
      current = 0;
      required = computeReqExp(level);
    }

    current += Math.max(0, Number(amount) || 0);
    required = computeReqExp(level);

    while (current >= required) {
      current -= required;
      level += 1;
      required = computeReqExp(level);
    }

    lvlEl.textContent = 'LV ' + level;
    expTop.textContent = `${fmt(current)} / ${fmt(required)}`;
    expFill.style.width = Math.min(100, (current / required) * 100) + '%';
  }

  function updateLeaderboardAndLogFromData(data) {
    const leaderboardRows = Array.isArray(data.leaderboard) ? data.leaderboard : [];
    if (leaderboardRows.length) {
      const lbHtml =
            '<strong>📊 Attackers Leaderboard</strong>' +
            '<div class="lb-list">' +
            leaderboardRows.map((row, i) => {
              const picture = (typeof row.PICTURE === 'string' && row.PICTURE.trim()) ? row.PICTURE : 'images/default_avatar.png';
              const username = escapeHtml(row.USERNAME || 'Unknown');
              const playerId = Number(row.ID) || 0;
              return `
            <div class="lb-row">
              <span class="lb-rank">#${i + 1}</span>
              <img class="lb-avatar" src="${escapeHtml(picture)}" alt="">
              <span class="lb-name">
                <a style="color:white;" href="player.php?pid=${playerId}">${username}</a>
              </span>
              <span class="lb-dmg">${fmt(row.DAMAGE_DEALT)}</span>
            </div>`;
            }).join('') +
            '</div>';

      const leaderboardPanel = document.querySelector('.leaderboard-panel');
      if (leaderboardPanel) leaderboardPanel.innerHTML = lbHtml;
    }

    const logs = Array.isArray(data.logs) ? data.logs : [];
    if (logs.length) {
      const logHtml =
            '<strong>📜 Attack Log</strong><br>' +
            logs.map(row => {
              const extra = row.EXTRA_INFO !== 'NONE' ? ` (${escapeHtml(row.EXTRA_INFO || '')})` : '';
              return `⚔️ ${escapeHtml(row.USERNAME || 'Unknown')} used ${escapeHtml(row.SKILL_NAME || 'Slash')}${extra} for ${fmt(row.DAMAGE)} DMG!<br>`;
            }).join('');

      const logPanel = document.querySelector('.log-panel');
      if (logPanel) logPanel.innerHTML = logHtml;
    }

    return leaderboardRows;
  }

  function updateTotalDamageFromData(data, leaderboardRows) {
    let totalDamageValue = null;
    if (typeof data.totaldmgdealt === 'number' && Number.isFinite(data.totaldmgdealt)) {
      totalDamageValue = Number(data.totaldmgdealt);
    } else if (Array.isArray(leaderboardRows)) {
      const myId = Number(window.USER_ID || 0);
      const myRow = leaderboardRows.find(r => Number(r.ID) === myId);
      if (myRow && typeof myRow.DAMAGE_DEALT !== 'undefined') {
        totalDamageValue = Number(myRow.DAMAGE_DEALT);
      }
    }

    if (totalDamageValue !== null && Number.isFinite(totalDamageValue)) {
      document.querySelectorAll('[id="yourDamageValue"]').forEach(el => {
        el.textContent = fmt(totalDamageValue);
      });
      if (typeof window.updateCapNotice === 'function') {
        try { window.updateCapNotice(totalDamageValue); } catch (_) {}
      }
    }
  }

  // Orchestrator used by BOTH AutoSlash hits and World Breaker hits, so
  // they can no longer drift out of sync with each other or with a manual
  // click. Prefers the page's own updater if present.
  function applyAttackSuccess(data) {
    if (typeof window.updateAttackSuccessUI === 'function') {
      try { window.updateAttackSuccessUI(data); return; }
      catch (err) { console.warn('[BattlePage] page updateAttackSuccessUI failed, using fallback:', err); }
    }

    animateMonster();
    updateHpUI(data.hp);
    updateStaminaUI(data.stamina);
    if (typeof data.mana === 'number') updateManaUI(data.mana, window.PLAYER_MAX_MANA || 200);
    if (data.retaliation) updateRetaliationUI(data.retaliation, window.PLAYER_MAX_HP || 415500);

    if (data.phase && data.phase.image) {
      const imgEl = document.getElementById('monsterImage');
      if (imgEl) imgEl.src = data.phase.image;
    }

    const leaderboardRows = updateLeaderboardAndLogFromData(data);
    updateTotalDamageFromData(data, leaderboardRows);

    if (typeof window.addExpUI === 'function') {
      try { window.addExpUI(Number(data.xp_delta ?? 10)); }
      catch (_) { addExpUIFallback(Number(data.xp_delta ?? 10)); }
    } else {
      addExpUIFallback(Number(data.xp_delta ?? 10));
    }

    // v9.0: refresh the reactive EXP-cap chip + loot-lock overlays immediately
    // rather than only relying on the MutationObserver picking up the DOM
    // change — matters for long unattended AutoSlash/World-Breaker sessions.
    updateExpCapChip();
    updateLootLockOverlays();


    if ((!data.phase || !data.phase.changed) && Number(data.hp && data.hp.value) <= 0) {
      location.reload();
    }
  }

  // =====================================================================
  // Styles
  // =====================================================================

  function injectStyles() {
    if (!document.head || document.getElementById('bm5-styles')) return;
    const style = document.createElement('style');
    style.id = 'bm5-styles';
    style.textContent = `

    /* v16: native CSS scroll-driven animation instead of a JS
         scroll+rAF handler. A JS scroll listener always lags the
         compositor's own scroll by at least a frame -- that lag is what
         reads as jitter on an element tracking another element's edge.
         animation-timeline hands the interpolation to the compositor
         directly, so there's no JS in the per-frame path at all. */
      @supports (animation-timeline: scroll()) {
        .bm-align-catchup {
          animation-name: bm-align-catchup;
          animation-duration: 1s;
          animation-timing-function: linear;
          animation-fill-mode: both;
          animation-timeline: scroll(root block);
        }
      }
      @keyframes bm-align-catchup {
        from { transform: translateY(0); }
        to   { transform: translateY(var(--bm-align-gap, 0px)); }
      }

      .bm-backbar { margin-bottom: 10px !important; }
      .bm-backbar > a.btn { padding: 6px 12px !important; font-size: 12px !important; }

      /* --- overall page column ---
         Caps the back-link, the battle-grid, AND the loot panel to one
         consistent, centered width. */
      #bm-page-wrap { max-width: min(1320px, 96vw); margin: 0 auto; padding: 0 16px; box-sizing: border-box; }

      /* =================================================================
         v15.0: STICKY TOP STAT BAR — pins the game's own top stat bar
         (Stamina/Gold/Gems/Server/Buffs/Level/EXP) so Stamina stays
         visible while scrolled down near the attack buttons. Only
         position/z-index is touched; the bar's own markup and whatever
         script maintains its numbers is untouched. If a second bar sits
         directly under it (e.g. an HP/MP row maintained by a different
         userscript entirely), that gets pinned too, stacked right
         beneath using the first bar's measured height — this script
         never builds or duplicates an HP/MP display of its own here. */
      .bm-sticky-topbar {
        position: sticky !important; top: 0 !important; z-index: 10000 !important;
        box-shadow: 0 6px 16px rgba(0,0,0,.35) !important;
      }
      .bm-sticky-hpbar {
        position: sticky !important; z-index: 9999 !important;
        top: var(--bm-topbar-h, 34px) !important;
        box-shadow: 0 6px 16px rgba(0,0,0,.30) !important;
      }

      /* v15.1: STICKY BOTTOM ATTACK BAR — Slash / AutoSlash / World
         Breaker move into a small pill fixed to the bottom-center of the
         viewport so they're always reachable without scrolling. Sized to
         its own content (not left:0/right:0 full-bleed) so it never
         stretches out or covers native controls sitting in the bottom
         corners of the screen, and stays visually the same — centered,
         a fixed distance up from the bottom, hugging its buttons —
         whether the page is zoomed in or out. */
      #bm-bottom-bar {
        position: fixed !important;
        left: 50% !important; bottom: 14px !important;
        transform: translateX(-50%) !important;
        z-index: 10001 !important;
        display:flex !important; justify-content:center !important;
        width: max-content !important; max-width: 94vw !important;
        padding: 8px 10px !important;
        background: rgba(15,16,26,.95) !important;
        border: 1px solid rgba(255,255,255,.09) !important;
        border-radius: 999px !important;
        box-shadow: 0 10px 26px rgba(0,0,0,.5) !important;
        backdrop-filter: blur(6px) !important;
      }
      .bm-bottom-bar-inner {
        justify-content:center !important; flex-wrap:nowrap !important; gap:6px !important;
        max-width:none !important; width:auto !important; margin:0 !important;
        overflow-x:auto !important; scrollbar-width:none !important;
      }
      .bm-bottom-bar-inner::-webkit-scrollbar { display:none !important; }
      /* Reserve room at the end of the page content so the floating bar
         never sits on top of the tail end of it (Loot). */
      #bm-page-wrap { padding-bottom: calc(var(--bm-bottom-bar-h, 54px) + 30px) !important; }

      /* --- battle grid ---
         .right-col is repurposed as the Info column (Battle Info /
         Leaderboard / Attack Log, stacked). .monster-card carries the
         monster art/HP, attacks, and your HP/MP + Heal. The DOM order
         stays monster-card-then-right-col (so mobile still stacks
         sensibly: monster+attacks+you first, info column below), but on
         desktop we flip which grid column each one visually sits in so
         the Info column reads on the left. */
      .battle-grid { grid-gap: 14px !important; align-items: start !important; }
      @media (min-width: 1000px) {
        .battle-grid { grid-template-columns: 1fr 1.7fr !important; }
        .monster-card { grid-column: 2 !important; grid-row: 1 !important; }
        .right-col { grid-column: 1 !important; grid-row: 1 !important; }
      }


      .right-col {
        display:flex !important; flex-direction:column !important; gap:14px !important;
      }

      /* v15.0: Loot is now a real grid child of .battle-grid (see
         wrapPageColumn()) instead of a sibling appended after it, so it
         can become a proper 3rd column on wide screens rather than
         rendering as a big empty-feeling block below everything. Below
         the wide breakpoint it still spans the full row, unchanged from
         before. */
      .bm-loot-col { grid-column: 1 / -1 !important; grid-row: 2 !important; }

      /* v15.0: on wide screens, open a real 3rd column for Loot and let
         the info column (Leaderboard/Attack Log/Battle Info/Rewards)
         tile 2-up instead of stacking as one tall column of rows — fills
         the empty space around the arena and cuts the vertical scroll
         needed to reach the bottom panels roughly in half. */
      @media (min-width: 1400px) {
        #bm-page-wrap { max-width: min(1680px, 97vw) !important; }
        .battle-grid { grid-template-columns: 0.8fr 1.35fr 1fr !important; grid-gap: 18px !important; }
        .bm-loot-col { grid-column: 3 !important; grid-row: 1 !important; }

        /* Leaderboard, then Attack Log, then Battle Info/Rewards, stacked
           full-width top to bottom instead of a 2-up grid -- each pane gets
           the full width of the info column to breathe. */
        .right-col {
          display:flex !important; flex-direction:column !important; gap:14px !important;
        }
      }

      .battle-card { padding: 16px 18px !important; gap: 10px !important; }
      .eyebrow { font-size: 11px !important; padding: 3px 8px !important; }

      /* --- monster arena: red accent, centered content ---
         v14.0: the card is now a positioning context for two pinned
         corner badges (View Monster Stats top-left, auto-die countdown
         top-right — see .bm-corner below), so the arena head gets a
         little extra top margin to keep the centered title clear of
         them. */
      .monster-card { border-left: 3px solid #b13b3b !important; position: relative !important; }
      .bm-arena-head {
        display:flex; flex-direction:column; align-items:center; text-align:center;
        gap:6px; margin:30px auto 10px !important; width:100%;
      }
      .bm-arena-head > .eyebrow {
        background:#2a1414 !important; border-color:#6a2b2b !important; color:#ff9a9a !important;
      }
      .bm-arena-head .card-title { justify-content:center; font-size:18px !important; }
      .bm-arena-chips { display:flex; justify-content:center; flex-wrap:wrap; gap:8px; }
      .bm-arena-chips .chip { padding:3px 9px !important; font-size:11.5px !important; }
      /* Joined/DMG status pills render below the You section instead of above
         the portrait — this modifier adds the spacing/divider for that. */
      .bm-arena-chips--below {
        margin: 8px auto 2px !important;
        padding-top: 8px !important;
        border-top: 1px solid rgba(177,59,59,.25);
      }
      .bm-arena-note { font-size:11px !important; color:#9aa0b8; }

      /* --- v14.0: pinned corner badges on the monster card itself ---
         View Monster Stats sits top-left, the auto-die countdown sits
         top-right, instead of both crowding the centered name/note
         stack. Purely positional wrappers; the real content (button /
         chip) keeps its own look via .bm-corner-stats-btn / .bm-corner-chip. */
      .bm-corner {
        position:absolute !important; top:10px !important; z-index:5 !important;
        max-width:46% !important; display:flex !important; align-items:center !important;
      }
      .bm-corner:empty { display:none !important; }
      .bm-corner-topleft { left:10px !important; }
      .bm-corner-topright { right:10px !important; justify-content:flex-end !important; }
      .bm-corner-stats-btn {
        display:inline-block !important; width:auto !important; max-width:100% !important;
        margin:0 !important; padding:5px 10px !important; font-size:11px !important;
        white-space:nowrap !important; overflow:hidden !important; text-overflow:ellipsis !important;
      }
      .bm-corner-chip {
        margin:0 !important; padding:4px 9px !important; font-size:10.5px !important;
        white-space:nowrap !important; max-width:100% !important;
        overflow:hidden !important; text-overflow:ellipsis !important;
      }


      /* v15.4: matchup warning icons, pinned to the monster card's left edge */
      .bm-arena-row { position:relative !important; }
      .bm-warn-rail {
        position:absolute !important; left:6px !important; top:50% !important;
        transform:translateY(-50%) !important; z-index:6 !important;
        display:flex !important; flex-direction:column !important; gap:8px !important;
      }
      .bm-warn-icon {
        position:relative !important; width:36px !important; height:36px !important;
        border-radius:50% !important; display:flex !important; align-items:center !important;
        justify-content:center !important; font-size:18px !important; cursor:pointer !important;
        border:1px solid rgba(0,0,0,.35) !important; box-shadow:0 3px 8px rgba(0,0,0,.4) !important;
        user-select:none !important;
      }



      .bm-warn-icon.bm-warn-red { background:#b13b3b !important; }
      .bm-warn-icon.bm-warn-yellow { background:#c99a1f !important; }
      /* v15.6: green = element OK; tooltips keep line breaks */
      .bm-warn-icon.bm-warn-green { background:#2e9e5b !important; }
      .bm-warn-tip { white-space:pre-line !important; }
      .bm-warn-tip {
        position:absolute !important; left:44px !important; top:50% !important;
        transform:translateY(-50%) !important; min-width:200px !important; max-width:260px !important;
        background:#171923 !important; border:1px solid #2b2e49 !important; border-radius:10px !important;
        padding:9px 11px !important; font-size:11.5px !important; line-height:1.45 !important;
        color:#e7e9f5 !important; box-shadow:0 10px 24px rgba(0,0,0,.5) !important;
        display:none !important; z-index:20 !important; text-align:left !important;
      }
      .bm-warn-icon.bm-warn-open .bm-warn-tip,
      .bm-warn-icon:hover .bm-warn-tip { display:block !important; }
      .bm-warn-tip strong { color:#fff !important; display:block !important; margin-bottom:3px !important; }
      @media (max-width:640px) {
        .bm-warn-rail { left:4px !important; gap:8px !important; }
        .bm-warn-icon { width:30px !important; height:30px !important; font-size:15px !important; }
        .bm-warn-tip { left:38px !important; max-width:190px !important; font-size:12px !important; }
      }


      /* --- fluid monster-portrait sizing ---
         Single source of truth: --bm-portrait-w. Everything else (image
         height) derives from it via calc(), so the whole arena scales
         together instead of drifting apart at different card widths /
         browser zoom levels.

         The first declaration is a plain vw-based fallback for browsers
         without container-query-unit support; the second (cqw, relative
         to the monster-card's OWN rendered width, not the full viewport)
         overrides it wherever it's supported. v15.0: raised the cap from
         400px to 460px now that the card has more room to work with on
         wide screens. */
      .monster-card { container-type: inline-size; }
      .monster-card {
        --bm-portrait-w: clamp(220px, 30vw, 460px);
        --bm-portrait-w: clamp(220px, 44cqw, 460px);
        --bm-portrait-h: calc(var(--bm-portrait-w) * 420 / 340);
      }
      @media (max-width: 640px) {
        .monster-card { --bm-portrait-w: clamp(170px, 54vw, 300px); }
      }

      /* --- arena row: just the monster portrait, centered. ---
         v14.0: the monster's HP bar no longer rides along here as a
         vertical pillar — it gets its own full-width horizontal row
         directly below (see .bm-monster-hp-row further down). */
      .bm-arena-row {
        display:flex !important; align-items:center !important; justify-content:center !important;
        width:100%; margin:0 auto 4px !important;
      }
      .bm-arena-image {
        width:var(--bm-portrait-w) !important; height:var(--bm-portrait-h) !important; margin:0 !important;
      }
      .bm-monster-img {
        width:100% !important; height:100% !important; max-height:none !important;
        object-fit:cover; display:block !important; margin:0 auto !important;
        border-radius:10px !important; border:1px solid #2b2e49 !important;
        background:#0f101a !important; padding:6px !important;
        box-shadow:0 8px 20px rgba(0,0,0,.5) !important;
      }

      /* --- monster HP: full-width horizontal bar under the portrait (v14.0).
         Bigger/bolder than the plain native bar (taller, red-tinted
         border) but no longer rotated into a narrow vertical pillar, so
         the HP text always has a full line to sit on and never wraps,
         and the exact full number is always shown (no abbreviation).
         v15.0: taller still, and allowed to grow wider, now that there's
         more room around the arena to use. --- */
      .bm-monster-hp-row {
        display:flex !important; flex-direction:column !important; align-items:center !important;
        gap:4px !important; width:100% !important; max-width:620px !important;
        margin:4px auto 10px !important;
      }
      .bm-monster-hp-row .bm-monster-hp-bar {
        width:100% !important; height:20px !important; border-radius:10px !important;
        margin-top:0 !important; border:1px solid rgba(177,59,59,.45) !important;
      }
      .bm-monster-hp-row .hp-text {
        font-size:12.5px !important; text-align:center !important; margin:0 !important;
        white-space:normal !important; word-break:normal !important; overflow-wrap:normal !important;
      }

      /* --- "Your Damage" display (v12.0): sits directly under the arena
         (portrait + monster HP row), outside the You section. --- */
      .bm-damage-display {
        display:flex !important; align-items:center !important; justify-content:center !important;
        width:100%; margin:0 auto 10px !important; text-align:center;
      }

      /* --- You section ---
         v14.0: "YOU" tag gets its own centered row; Heal/potion controls
         get their own row directly below, aligned to the right, instead
         of sharing a line with YOU. Your HP + MP bars keep their native
         "game original" horizontal look underneath.
         v15.0: allowed a bit wider so the bigger HP/MP bars below have
         more room. */
      .bm-player-meta {
        display:flex !important; flex-direction:column !important; align-items:center !important;
        gap:8px !important; width:100%; max-width:480px !important; margin:0 auto 8px !important;
      }
      .bm-player-meta-head {
        display:flex !important; align-items:center !important; justify-content:center !important;
        flex-wrap:wrap !important; gap:10px !important; width:100%;
      }
      .bm-player-meta-head > .eyebrow {
        background:#132a1a !important; border-color:#2f9e44 !important; color:#8de3a3 !important;
      }
      .bm-heal-row {
        display:flex !important; align-items:center !important; justify-content:center !important;
        flex-wrap:wrap !important; gap:8px !important; width:100% !important;
      }
      .bm-heal-row .btn,
      .bm-heal-row > button {
        padding:5px 10px !important; font-size:11.5px !important;
        line-height:1.3 !important; white-space:nowrap !important;
      }
      .bm-heal-row > *:not(button):not(.btn) {
        font-size:11.5px !important; color:#9aa0b8 !important;
        white-space:nowrap !important;
      }
      .bm-player-meta .btn { padding:6px 10px !important; font-size:12px !important; }

      .bm-player-vitals {
        display:flex !important; flex-direction:column !important; gap:6px !important;
        width:100% !important; max-width:460px !important; margin:2px auto 0 !important;
      }
      .bm-vital { width:100% !important; }
      .bm-vital > div,
      .bm-vital .hp-bar,
      .bm-vital [class*="bar"] {
        width:100% !important; max-width:100% !important; box-sizing:border-box !important;
      }
      .bm-vital .hp-text { width:100% !important; }

      /* v15.0: taller so your HP/MP bars cover more of the extra room
         now available instead of staying thin lines. */
      .hp-bar { height:18px !important; border-radius:10px !important; margin-top:5px !important; }
      .hp-text { font-size:11.5px !important; margin-top:4px !important; text-align:center; }

      #bm-bottom-bar .bm-slain-actions {
        display: flex !important;
        flex-direction: row !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 6px !important;
        margin: 0 !important;
        overflow: visible !important;
      }
      #bm-bottom-bar .bm-slain-actions > button,
      #bm-bottom-bar .bm-slain-actions > a.btn {
        width: 140px !important;
        padding: 9px 8px !important;
        font-size: 12.5px !important;
        font-weight: 700 !important;
        line-height: 1.3 !important;
        white-space: nowrap !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        text-align: center !important;
        border-radius: 10px !important;
        box-sizing: border-box !important;
        margin: 0 !important;
      }

      #bm-bottom-bar .bm-slain-actions > button.bm-slain-placeholder {
        background: #2a2c3d !important;
        color: #7b7f95 !important;
        border: 1px solid rgba(255,255,255,.06) !important;
        cursor: default !important;
        opacity: 0.85 !important;
        box-shadow: none !important;
      }

      .bm-exp-gain-note {
        font-size:12px !important; font-weight:600 !important;
        color:#e7c76f !important;
        background:rgba(233,193,78,.08) !important;
        border:1px solid rgba(233,193,78,.25) !important;
        border-radius:8px !important;
        padding:6px 10px !important;
      }

      /* --- attack controls: below the You section, above the bottom.
         Attack FX toggle is pinned to the top-right corner as a small
         icon; position:relative anchors that corner.
         v15.0: the button row itself gets pulled out of here into the
         fixed bottom bar (see pinAttackBar()), so this becomes a slim
         divider that just anchors the FX-toggle corner once emptied. */
      .bm-arena-controls {
        position:relative !important;
        display:flex; flex-direction:column; align-items:center; gap:8px;
        margin:10px auto !important; width:100%;
        padding:10px 28px !important;
        border-top:1px solid rgba(255,255,255,.08);
        border-bottom:1px solid rgba(255,255,255,.08);
      }
      .bm-arena-controls.bm-controls-emptied {
        padding:6px 28px !important;
        min-height:0 !important;
      }
      .bm-controls-label {
        background:#2a1414 !important; border-color:#6a2b2b !important; color:#ff9a9a !important;
      }
      .battle-actions-buttons { justify-content: center !important; gap: 6px !important; }
      .battle-actions-buttons button { min-width:100px !important; padding:9px 12px !important; font-size:12.5px !important; }

      /* FX toggle, pinned corner icon */
      .bm-fx-corner {
        position:absolute !important; top:8px !important; right:8px !important;
        margin:0 !important;
      }
      .bm-fx-corner #fxToggleBtn {
        padding:4px 6px !important; font-size:11px !important; line-height:1 !important;
      }

      /* =================================================================
         AutoSlash — integrated as a normal flex sibling next to the Slash
         button. A plain flex child can't be overlapped by other CSS
         regardless of what runs elsewhere, so this class of bug is
         structurally impossible rather than patched. */
      #autoSlashWrapper {
        display:inline-flex !important;
        align-items:stretch !important;
        align-self: center !important;
        gap:0 !important;
        min-width:0 !important;
        margin:0 !important;
        overflow:hidden !important;     /* clips children to one shared pill shape */
        border-radius: 10px !important;
        box-shadow:0 4px 10px rgba(0,0,0,0.25) !important; /* single shadow, not one per segment */
      }
      #autoSlashWrapper > button[data-skill-id="0"].attack-btn {
        border-radius:0 !important;
        box-shadow:none !important;
        margin:0 !important;
        min-width:0 !important;
      }
      /* The toggle and the caret are two separate <button> elements (see
         integrateAutoSlash) rather than a caret glyph living inside the
         toggle button, so there is no shared click target to mis-hit. */
      #autoSlashBtn {
        position:static !important;
        display:inline-flex !important;
        align-items:center; justify-content:center; gap:6px;
        padding:9px 13px !important;
        margin:0 !important;
        background:#4b5ef5;
        color:#fff;
        border:none;
        border-radius:0 !important;
        box-shadow:none !important;
        border-left:1px solid rgba(255,255,255,0.18) !important;
        cursor:pointer;
        white-space:nowrap !important;
        min-width:0 !important;
      }
      #autoSlashBtn:hover { filter: brightness(1.10); }
      #autoSlashBtn[data-running="1"] {
        background: linear-gradient(135deg, #3d50e0, #3040c8);
      }
      .auto-slash-dot {
        width: 7px; height: 7px; border-radius: 999px;
        background: rgba(255,255,255,0.40); flex: 0 0 auto;
        transition: background 0.2s, box-shadow 0.2s;
      }
      .auto-slash-dot.running {
        background: #42f58d; box-shadow: 0 0 5px rgba(66,245,141,0.70);
      }
      .auto-slash-label { letter-spacing: 0.04em; line-height: 1; }


      /* Caret: real ~26px-wide button, not a glyph inside the toggle. */
      #autoSlashCaretBtn {
        position:static !important;
        display:inline-flex !important;
        align-items:center !important; justify-content:center !important;
        width:26px !important; min-width:26px !important;
        margin:0 !important; padding:9px 0 !important;   /* was: 0 !important */
        background:#4b5ef5;
        color:rgba(255,255,255,0.85);
        border:none;
        box-shadow:none !important;
        border-top-left-radius:0 !important;
        border-bottom-left-radius:0 !important;
        border-left:1px solid rgba(255,255,255,0.22) !important;
        cursor:pointer;
        font-size:10px !important;
      }
      #autoSlashCaretBtn:hover { filter: brightness(1.10); color:#fff; }
      #autoSlashCaretBtn[aria-expanded="true"] { background:#3040c8; }
      #autoSlashBtn[data-running="1"] + #autoSlashCaretBtn {
        background: linear-gradient(135deg, #3d50e0, #3040c8);
      }

      #autoSlashMenu {
        /* v15.3: fixed (viewport-relative), not absolute (document-
           relative) — the caret now lives in the fixed bottom bar, see
           asToggleMenu(). */
        position: fixed; min-width: 220px; z-index: 99999;
        padding: 8px; border-radius: 12px; border: 1px solid #24263a;
        background: #1a1b25; box-shadow: 0 10px 24px rgba(0,0,0,0.6);
      }
      #autoSlashMenu[hidden] { display: none !important; }
      .auto-slash-menu-head {
        padding: 4px 8px 10px; font-size: 11px; color: #9aa0b8;
        text-transform: uppercase; letter-spacing: 0.06em;
      }
      .auto-slash-delay {
        width: 100%; display: flex; align-items: center; justify-content: space-between;
        gap: 10px; padding: 9px 10px; margin: 0 0 6px 0;
        border: 1px solid #2b2e49; border-radius: 10px; background: #171923;
        color: #fff; cursor: pointer; font: inherit;
        box-shadow: 0 4px 10px rgba(0,0,0,0.25); text-align: left;
      }
      .auto-slash-delay:hover { filter: brightness(1.08); }
      .auto-slash-delay[aria-pressed="true"] { background: #202235; border-color: #3a45a5; }
      .auto-slash-check { min-width: 14px; text-align: right; color: #cfeccc; font-weight: 800; }
      .auto-slash-footer { padding: 4px 8px 2px; font-size: 11px; color: #9aa0b8; line-height: 1.35; }

      /* =================================================================
         World Breaker Slash — only injected as a fallback when the site's
         own native button (data-skill-id="-5") isn't present; styled as a
         class instead of inline cssText so it inherits the same sizing
         rules as every other attack button. */
      .wb-btn {
        background: #4b5ef5 !important;
        color: #fff !important;
        border: none !important;
        cursor: pointer !important;
        box-shadow: 0 4px 10px rgba(0,0,0,0.25) !important;
      }
      .wb-btn:hover { filter: brightness(1.10); }
      .wb-btn[disabled] { opacity: 0.7 !important; cursor: progress !important; }

      /* --- merged stat chips (monster ATK/DEF + Level Req/EXP Cap/etc.) --- */
      .bm-chip-grid { display:flex; flex-wrap:wrap; align-items:flex-start; gap:10px !important; }
      .bm-stat-chip {
        background:#171923 !important; border:1px solid #2b2e49 !important; border-radius:999px !important;
        padding:8px 13px !important; min-width:0 !important; box-shadow:none !important;
      }
      .bm-stat-chip.bm-stat-chip--has-note {
        border-radius:12px !important; display:flex !important; flex-direction:column !important;
        align-items:flex-start !important; gap:3px !important; padding:9px 13px !important;
        min-width:150px !important;
      }
      .bm-stat-chip-inner { display:inline-flex; align-items:center; gap:7px; }
      .bm-stat-chip-inner .label { display:inline !important; font-size:11px !important; text-transform:uppercase; color:#9aa0b8; font-weight:600; letter-spacing:.4px; }
      .bm-stat-chip-inner strong { font-size:15px !important; color:#fff; }
      .bm-stat-chip-note { font-size:11.5px !important; color:#9aa0b8 !important; line-height:1.4 !important; margin:0 !important; }
      .bm-info-note { margin-top:8px !important; padding:9px 11px !important; font-size:12.5px !important; }

      /* EXP Cap chip once your native DMG counter clears the "~X dmg to
         hit cap" threshold on its own note line. */
      .bm-stat-chip.bm-cap-reached {
        background:#132a1a !important; border-color:#2f9e44 !important;
      }
      .bm-stat-chip.bm-cap-reached .bm-stat-chip-inner .label,
      .bm-stat-chip.bm-cap-reached .bm-stat-chip-inner strong,
      .bm-stat-chip.bm-cap-reached .bm-stat-chip-note { color:#8de3a3 !important; }

      .battleinfo-card .muted { font-size:13px !important; line-height:1.55 !important; }

      /* --- damage formula drawer: bigger text + real table styling --- */
      .formula-box { padding:12px 14px !important; }
      .formula-header .title { font-size:14px !important; }
      .formula-header .hint { font-size:11.5px !important; }
      .formula-body { font-size:13px !important; line-height:1.6 !important; }
      .formula-body code { font-size:12.5px !important; line-height:1.6 !important; padding:10px 12px !important; }
      .formula-body table { width:100% !important; }
      .formula-body table td, .formula-body table th { padding:6px 8px !important; font-size:12.5px !important; }
      .formula-body table th {
        background:rgba(255,255,255,.05) !important; text-transform:uppercase;
        font-size:11px !important; letter-spacing:.4px; color:#9aa0b8 !important;
      }
      .formula-body table tbody tr:nth-child(even) td { background:rgba(255,255,255,.03); }

      /* --- Info column: Leaderboard / Attack Log / Battle Info, always
         visible, stacked as full-width rows filling the left-hand
         .right-col (no tabs, no toggling, no side-by-side grid on
         narrower screens — see the v15.0 wide-screen override above for
         the 2-up grid). Each gets its own accent color so the three read
         as clearly distinct sections instead of one grey block. --- */
      .right-col .bm-info-pane { container-type: inline-size; }

      @container (max-width: 360px) {
        .lb-row { gap: 6px !important; }
        .lb-rank { width: 18px !important; font-size: 11px !important; }
        .lb-avatar { width: 18px !important; height: 18px !important; }
        .lb-dmg { font-size: 11px !important; }
      }

      .right-col .log-panel { border-left:3px solid #5b8dee !important; }
      .right-col .battleinfo-card { border-left:3px solid #7bd3a0 !important; }

      /* --- collapsible side panels ---
         Each panel's ENTIRE content — including bare text nodes, which
         is what the Attack Log is mostly made of — gets moved into one
         ".bm-panel-body" wrapper the first time ensurePanelBody() sees
         that panel without one. A toggle bar is then inserted as the
         panel's first child, ahead of that wrapper. Collapsing just
         hides ".bm-panel-body" as a whole. */
      .bm-panel-collapsed > .bm-panel-body { display:none !important; }

      .bm-panel-toggle-btn {
        display:flex !important; align-items:center !important; gap:8px !important;
        width:100% !important; margin:0 0 10px 0 !important; padding:9px 12px !important;
        background:#171923 !important; border:1px solid #2b2e49 !important; border-radius:9px !important;
        color:#e7e9f5 !important; font-size:12px !important; font-weight:700 !important;
        letter-spacing:.3px !important; text-transform:uppercase !important; cursor:pointer !important;
      }
      .bm-panel-toggle-btn:hover { filter:brightness(1.12); border-color:#3a45a5 !important; }
      .bm-panel-toggle-caret {
        display:inline-flex !important; width:14px !important; justify-content:center !important;
        flex-shrink:0 !important; color:#9aa0b8 !important;
      }
      .bm-panel-toggle-label { flex:1 1 auto !important; text-align:left !important; }

      /* The leaderboard/log panels rebuild their own pill-style <strong>
         header every time their content is replaced. Since that
         duplicates our toggle-bar label, hide it once it lands inside
         the panel body wrapper. */
      .right-col .log-panel .bm-panel-body > strong:first-child,
      .right-col .leaderboard-panel .bm-panel-body > strong:first-child {
        display:none !important;
      }

      /* v15.2: Leaderboard and Damage Ranking Rewards now get the same
         capped-height scroll box as Log/Battle Info. Leaderboard used to
         be left unbounded (v12.0 — "native game already paginates it"),
         which was fine back when every panel had its own full-width row.
         Now that the wide-screen layout pairs them side-by-side in a
         2-up grid, an unbounded Leaderboard just grows taller than
         whatever it's paired with, so the two never end at the same
         height — capping both to the same box height keeps every pair
         lined up evenly. */
      /* v15.3: Leaderboard dropped from this scroll-box treatment — see
         the v15.3 changelog note (1) at the top of the file for why
         giving it its own overflow-y:auto was actively harmful (it
         silently turned on overflow-x:auto too, which is what was
         hiding the names behind a phantom horizontal scrollbar). The
         game already paginates Leaderboard on its own, so it doesn't
         need a height cap here at all. overflow-x:hidden is now pinned
         explicitly (not left to the default) on the panels that DO
         scroll, so this exact class of bug can't quietly reappear on
         Log/Battle Info/Rewards either. */
      .right-col .log-panel .bm-panel-body,
      .right-col .battleinfo-card .bm-panel-body,
      .right-col .ranking-rewards-panel .bm-panel-body,
      .right-col .leaderboard-panel .bm-panel-body {
        max-height: 320px;
        overflow-y: auto;
        overflow-x: hidden;
        scrollbar-width: thin;
        scrollbar-color: rgba(255,255,255,.18) #171923;
      }

      .phase-loot-head.bm-phase-head-row {
        display:flex !important; align-items:center !important; justify-content:space-between !important;
        gap:10px !important;
      }
      .bm-phase-refresh-btn {
        flex:0 0 auto !important;
        background:#171923 !important; border:1px solid #2b2e49 !important; border-radius:8px !important;
        color:#e7e9f5 !important; font-size:13px !important; line-height:1 !important;
        padding:5px 8px !important; cursor:pointer !important;
      }
      .bm-phase-refresh-btn:hover { filter:brightness(1.15); border-color:#3a45a5 !important; }
      .bm-phase-refresh-btn[disabled] { opacity:.6 !important; cursor:progress !important; }
      .bm-phase-refresh-btn.bm-spinning { animation: bm-phase-spin 0.8s linear infinite; }
      @keyframes bm-phase-spin { from { transform:rotate(0deg); } to { transform:rotate(360deg); } }

      /* The native site CSS caps .leaderboard-panel ITSELF (not just the
       .bm-panel-body wrapper inside it) with its own max-height/overflow-y —
         that's the untouched box causing the native/irregular scrollbar and
         the resulting overflow-x:auto side effect that hides the names. */
      .right-col .leaderboard-panel {
        max-height: none !important;
        overflow: visible !important;
        overflow-x: hidden !important;
        min-width: 0 !important;
      }
      .right-col .leaderboard-panel::-webkit-scrollbar {
        display: none !important;
      }
      .right-col .log-panel .bm-panel-body::-webkit-scrollbar,
      .right-col .battleinfo-card .bm-panel-body::-webkit-scrollbar,
      .right-col .ranking-rewards-panel .bm-panel-body::-webkit-scrollbar { width:6px; }
      .right-col .log-panel .bm-panel-body::-webkit-scrollbar-thumb,
      .right-col .battleinfo-card .bm-panel-body::-webkit-scrollbar-thumb,
      .right-col .ranking-rewards-panel .bm-panel-body::-webkit-scrollbar-thumb { background:rgba(255,255,255,.16); border-radius:999px; }
      .right-col .log-panel .bm-panel-body::-webkit-scrollbar-corner,
      .right-col .battleinfo-card .bm-panel-body::-webkit-scrollbar-corner,
      .right-col .ranking-rewards-panel .bm-panel-body::-webkit-scrollbar-corner { background: transparent; }


      .right-col .log-panel .bm-panel-body {
        font-size:12.5px !important; line-height:1.65 !important;
      }
      /* v15.3: hardened against the name-column-collapsing regression
         described in changelog note (1)/(2) above — min-width:0 is now
         pinned on the row itself too (a flex row's own default
         min-width is 'auto', which can refuse to shrink below its
         children's natural content width even when a child further
         down asks to shrink), and widths are bound to 100% explicitly
         so none of this depends on an ancestor NOT having horizontal
         overflow enabled. */
      /* v15.4: name column truncates with an ellipsis instead of pushing
         DMG off-screen, so the horizontal scrollbar (and its overflow-x:auto
         side effects) is no longer needed at all. */
      .lb-list {
        width:100% !important;
        display:block !important;
        overflow:visible !important;
      }
      .lb-row {
        padding:5px 0 !important; gap:9px !important;
        display:flex !important; align-items:center !important; flex-wrap:nowrap !important;
        width:100% !important; min-width:0 !important; box-sizing:border-box !important;
      }
      .lb-rank { width:24px !important; flex:0 0 auto !important; font-size:12px !important; }
      .lb-avatar { width:22px !important; height:22px !important; flex:0 0 auto !important; }
      .lb-name {
        font-size:12px !important;
        flex:1 1 auto !important;
        min-width:0 !important;
        white-space:nowrap !important;
        overflow:hidden !important;
        text-overflow:ellipsis !important;
      }
      .lb-name a {
        display:block !important;
        min-width:0 !important;
        white-space:nowrap !important;
        overflow:hidden !important;
        text-overflow:ellipsis !important;
      }
      .lb-dmg {
        font-size:12px !important; flex:0 0 auto !important;
        white-space:nowrap !important; text-align:right !important;
      }
      .lb-dmg::after { content: none; }


      /* --- Damage Ranking Rewards panel (v14.0) ---
         Only rendered by the site on some monsters, so this is purely
         additive styling + the same collapse mechanism used for
         Leaderboard/Log/Battle Info (see PANEL_DEFS) — harmless no-op if
         ".ranking-rewards-panel" isn't present on a given page. */
      .ranking-rewards-panel { border-left: 3px solid #e9c14e !important; }
      .ranking-rewards-head {
        display:flex !important; align-items:center !important; justify-content:space-between !important;
        gap:10px !important; flex-wrap:wrap !important;
        margin:0 0 10px !important; padding-bottom:8px !important;
        border-bottom:1px solid rgba(255,255,255,.08) !important;
      }
      .ranking-rewards-head strong { font-size:14px !important; }
      .rank-bracket { margin:0 0 14px !important; }
      .rank-bracket:last-child { margin-bottom:0 !important; }
      .rank-bracket-title {
        display:inline-block !important; font-size:12.5px !important; font-weight:700 !important;
        letter-spacing:.3px !important; color:#e7c76f !important; margin-bottom:6px !important;
        padding:4px 10px !important; border-radius:8px !important;
        background:rgba(233,193,78,.08) !important;
      }
      .rank-reward-items { display:flex !important; flex-wrap:wrap !important; gap:10px !important; }
      .rank-reward-card {
        display:flex !important; align-items:center !important; gap:10px !important;
        background:#171923 !important; border:1px solid #2b2e49 !important; border-radius:10px !important;
        padding:8px 10px !important; min-width:210px !important; flex:1 1 240px !important;
      }
      .rank-reward-card img {
        width:40px !important; height:40px !important; object-fit:contain !important;
        flex-shrink:0 !important; border-radius:6px !important; background:#0f101a !important;
      }
      .rank-reward-meta { display:flex !important; flex-direction:column !important; gap:2px !important; min-width:0 !important; }
      .rank-reward-name { font-size:12.5px !important; font-weight:700 !important; color:#fff !important; }
      .rank-reward-desc { font-size:11px !important; color:#9aa0b8 !important; line-height:1.35 !important; }

      /* --- Possible Loot ---
         Always visible, no collapse/toggle. Capped to the same width as
         everything else on narrow/medium screens; on wide screens it's a
         grid child (.bm-loot-col, see above) and fills its own column
         instead. Responsive card grid so cards reflow to fit whichever
         width it ends up with. */
      .bm-loot-panel > strong {
        display:flex; align-items:center; gap:8px;
        font-size:15px !important;
        padding-bottom:8px !important;
        border-bottom:1px solid rgba(255,255,255,.08);
        margin-bottom:6px !important;
      }
      .tier-head {
        display:flex; align-items:center; gap:8px;
        margin:14px 0 8px !important; font-size:14px !important;
        padding:6px 10px !important;
        border-radius:8px;
        background:rgba(255,255,255,.03);
        border-left:3px solid currentColor;
      }
      .loot-row {
        display:grid !important;
        grid-template-columns:repeat(auto-fill, minmax(200px, 1fr)) !important;
        gap:10px !important;
      }
      .loot-card {
        width:100% !important; max-width:100% !important; padding:8px !important; gap:8px !important;
        min-height:92px !important;
        box-sizing:border-box !important;
        overflow:hidden !important;
        position:relative !important; /* anchors the lock overlay below */
      }
      .loot-img-wrap { flex-basis:56px !important; width:56px !important; height:56px !important; box-sizing:border-box !important; }
      .loot-name { font-size:13px !important; }
      .loot-desc {
        font-size:11px !important; max-height:30px !important;
        overflow:hidden !important;
        display:-webkit-box !important; -webkit-line-clamp:2 !important; -webkit-box-orient:vertical !important;
      }
      .loot-stats { gap:5px !important; }
      .loot-stats .chip { font-size:10px !important; padding:2px 6px !important; }


      .bm-loot-panel { position:relative !important; }
      .bm-loot-panel > strong { padding-right:110px !important; }

      .bm-loot-hide-btn {
        position:absolute !important; top:6px !important; right:0 !important;
        z-index:5 !important;
        background:#171923 !important; border:1px solid #2b2e49 !important; border-radius:8px !important;
        color:#e7e9f5 !important; font-size:11px !important; font-weight:700 !important;
        padding:5px 10px !important; cursor:pointer !important; white-space:nowrap !important;
      }
      .bm-loot-hide-btn:hover { filter:brightness(1.15); border-color:#3a45a5 !important; }

      .bm-loot-panel.bm-hide-locked .bm-loot-lock-overlay {
        display: none !important;
      }

      .bm-loot-lock-overlay {
        position:absolute; inset:0; z-index:5; pointer-events:none;
        background:rgba(8,9,14,.72); border-radius:12px;
        display:flex; align-items:center; justify-content:center;
        font-size:26px;
        transition: opacity .15s ease;
      }
      .loot-card:hover > .bm-loot-lock-overlay {
        opacity: 0;
      }
-
      /* a) Restyle the player meta container */
      .bm-player-meta {
        background: rgba(255,255,255,.025) !important;
        border: 1px solid rgba(255,255,255,.07) !important;
        border-radius: 12px !important;
        padding: 12px 14px !important;
      }

      /* b) Desaturate the native bar fills slightly */
      #hpFill, #pHpFill, #pManaFill {
        filter: saturate(0.82) brightness(0.96) !important;
      }

      /* (3) Class skill bar: with only one or two skills, letting the row
         stretch to the card's full width leaves a big dead gap next to
         them. Cap slots to their own content size and center the row
         instead so the section reads as compact regardless of how many
         skills a class has. */
      .class-skill-bar {
        display:flex !important; flex-wrap:wrap !important;
        justify-content:center !important; align-items:flex-start !important;
        gap:10px !important;
      }
      .class-skill-bar > div[style]:not([class]) { width:100% !important; text-align:center !important; }
      .skill-slot {
        flex:0 0 auto !important;
        width:clamp(84px, 24vw, 128px) !important;
        text-align:center !important;
        display:flex !important;
        flex-direction:column !important;
        align-items:center !important;
      }
      .skill-slot .skill-name,
      .skill-slot .skill-cost {
        width:100% !important;
        text-align:center !important;
      }

      /* (4) Info column (Leaderboard / Attack Log / Battle Info) should
         scroll away with the rest of the page, not track the viewport.
         Whatever's applying sticky positioning to it gets reset here. */
      .right-col,
      .right-col .bm-info-pane,
      .right-col .leaderboard-panel,
      .right-col .log-panel,
      .right-col .battleinfo-card {
        position: static !important; top: auto !important; align-self: auto !important;
      }

      /* (5) "Joined" chip: relocated by relocateJoinedChip() up next to the
         monster name/status chips; this gives it the same pill styling as
         its new neighbors so it reads as part of that group rather than a
         leftover box. */
      .bm-chip-joined {
        display:inline-flex !important; align-items:center !important;
        font-size:11.5px !important; padding:3px 9px !important;
        border-radius:999px !important;
      }

      /* --- Leaderboard display-mode toggle (Name+DMG / Name only / DMG only) --- */
      .bm-lb-mode-btn {
        display:block !important; width:100% !important; margin:0 0 10px !important;
        padding:6px 12px !important; font-size:11px !important; font-weight:700 !important;
        letter-spacing:.3px !important; text-transform:uppercase !important;
        background:#171923 !important; border:1px solid #2b2e49 !important; border-radius:9px !important;
        color:#9aa0b8 !important; cursor:pointer !important; text-align:center !important;
      }
      .bm-lb-mode-btn:hover { filter:brightness(1.12); border-color:#3a45a5 !important; }

      .leaderboard-panel[data-lb-mode="name"] .lb-dmg { display:none !important; }
      .leaderboard-panel[data-lb-mode="dmg"] .lb-name { display:none !important; }

      .phase-announce { display:none !important; }
      .phase-announce.bm-pa-visible { display:block !important; }

      .bm-pa-toggle {
        position:absolute !important; left:8px !important; top:8px !important; z-index:7 !important;
        width:26px !important; height:26px !important; border-radius:50% !important;
        display:flex !important; align-items:center !important; justify-content:center !important;
        font-size:13px !important; line-height:1 !important; padding:0 !important;
        background:#171923 !important; border:1px solid rgba(0,0,0,.35) !important;
        color:#9aa0b8 !important; cursor:pointer !important;
        box-shadow:0 3px 8px rgba(0,0,0,.4) !important;
      }
      .bm-pa-toggle:hover { filter:brightness(1.2); }
      .bm-pa-toggle.bm-pa-toggle-active {
        background:#4b5ef5 !important; color:#fff !important; border-color:rgba(255,255,255,.25) !important;
      }

      .bm-slain-actions-anchor {
        position: relative !important;
      }

      #bm-loot-xp-wrap {
        position: absolute !important;
        bottom: 100% !important;
        transform: translateX(-50%) !important;
        display: flex !important;
        flex-direction: column !important;
        align-items: stretch !important;
        z-index: 10002 !important;
        background: #171923 !important;
        border: 1px solid #2b2e49 !important;
        border-bottom: none !important;
        border-radius: 8px 8px 0 0 !important;
        box-shadow: 0 4px 10px rgba(0,0,0,.3) !important;
        overflow: hidden !important;
        transition: border-color .15s ease !important;
      }
      #bm-loot-xp-wrap.bm-loot-xp-open { border-color: #3a45a5 !important; }

      #bm-loot-xp-trigger {
        width: 40px !important; height: 20px !important;
        align-self: center !important;
        display: flex !important; align-items: center !important; justify-content: center !important;
        background: transparent !important;
        border: none !important;
        color: #9aa0b8 !important;
        cursor: pointer !important; padding: 0 !important; margin: 0 !important;
        transition: color .15s ease !important;
      }
      #bm-loot-xp-trigger:hover,
      #bm-loot-xp-trigger.bm-loot-xp-trigger-open { color: #e7e9f5 !important; }

      .bm-loot-xp-caret {
        display: inline-block !important;
        font-size: 13px !important;
        line-height: 1 !important;
      }

      #bm-loot-xp-drawer {
        overflow: hidden !important;
        max-height: 0 !important;
        transition: max-height .22s ease !important;
      }
      #bm-loot-xp-wrap.bm-loot-xp-open #bm-loot-xp-drawer {
        max-height: 34px !important;
      }
      #bm-loot-xp-drawer > span {
        display: block !important;
        padding: 7px 14px !important;
        font-size: 12.5px !important; font-weight: 700 !important;
        color: #e7e9f5 !important; white-space: nowrap !important;
      }


    `;
    document.head.appendChild(style);
  }

  // =====================================================================
  // Layout restructure
  // =====================================================================

  function compactBackBar() {
    const grid = document.querySelector('.battle-grid');
    const backWrap = grid && grid.previousElementSibling;
    if (!backWrap || !backWrap.classList || backWrap.dataset.bmDone === '1') return;
    if (!backWrap.querySelector || !backWrap.querySelector(':scope > a.btn')) return;
    backWrap.classList.add('bm-backbar');
    backWrap.dataset.bmDone = '1';
  }

  // =====================================================================
  // v15.0: sticky top stat bar
  // =====================================================================
  //
  // We only know the Stamina row by its own class (".gtb-inner") — the
  // exact markup of whatever wraps it (background, padding, the outer
  // "bar" look) isn't part of this script's known selectors. Rather than
  // assume a fixed number of parent hops, this walks up a few ancestors
  // looking for one whose class name actually signals "this is the top
  // bar" (e.g. contains "top-bar"/"topbar"/"gtb"); if nothing matches it
  // falls back to the immediate parent, which is right in the vast
  // majority of layouts.
  function findTopBarWrapper(gtbInner) {
    let el = gtbInner.parentElement;
    for (let i = 0; el && i < 4; i++, el = el.parentElement) {
      if (el.tagName === 'BODY' || el.tagName === 'HTML') break;
      if (/top-?bar|gtb(?!-inner)/i.test(el.className || '')) return el;
    }
    return gtbInner.parentElement;
  }

  function pinTopStatBar() {
    const gtbInner = document.querySelector('.gtb-inner');
    if (!gtbInner) return;

    const bar = findTopBarWrapper(gtbInner);
    if (!bar) return;

    // v15.2: reading .offsetHeight forces a synchronous layout. Doing
    // that on every run() — which fires on a ~50ms debounce for EVERY
    // DOM mutation, including the leaderboard/log/HP updates that fire
    // repeatedly during AutoSlash — was a real contributor to the
    // "everything flickers while attacking" issue. Only measure once,
    // the first time this bar gets pinned; remeasureStickyBars() (called
    // from the resize listener in start()) handles keeping it in sync
    // if the bar's height ever actually changes later.
    if (bar.dataset.bmPinned === '1') return;
    bar.classList.add('bm-sticky-topbar');
    document.documentElement.style.setProperty('--bm-topbar-h', bar.offsetHeight + 'px');
    bar.dataset.bmPinned = '1';
  }

  function buildMonsterArena() {
    const card = document.querySelector('.monster-card');
    if (!card || card.dataset.bmArenaDone === '1') return;

    const headline = card.querySelector(':scope > .card-headline');
    const actionsCard = card.querySelector(':scope > .battle-actions-card');
    const hpWrap = card.querySelector(':scope > .monster-hp-wrap');
    const frame = card.querySelector(':scope > .monster-frame');
    if (!headline || !hpWrap || !frame) return;

    const eyebrow = card.querySelector(':scope > .eyebrow');
    const titleEl = headline.querySelector('.card-title');
    const labelLeft = actionsCard && actionsCard.querySelector('.label-left');
    const statusNote = actionsCard && actionsCard.querySelector('.battle-actions-head > div:not(.label-left)');

    const head = make('div', 'bm-arena-head');
    if (eyebrow) head.appendChild(eyebrow);
    if (titleEl) head.appendChild(titleEl);

    const chipsRow = make('div', 'bm-arena-chips bm-arena-chips--below');
    if (labelLeft) {
      Array.from(labelLeft.querySelectorAll('.chip')).forEach(chip => chipsRow.appendChild(chip));
    }
    const hasChips = chipsRow.childElementCount > 0;

    if (statusNote && statusNote.textContent.trim()) {
      statusNote.classList.add('bm-arena-note');
      head.appendChild(statusNote);
    }

    card.insertBefore(head, headline);
    headline.remove();

    const actionsHead = actionsCard && actionsCard.querySelector(':scope > .battle-actions-head');
    if (actionsHead) actionsHead.remove();
    let controls = null;
    if (actionsCard) {
      if (actionsCard.querySelector(':scope > *')) {
        actionsCard.classList.add('bm-arena-controls');
        controls = actionsCard;
      } else {
        actionsCard.remove();
      }
    }

    frame.classList.add('bm-arena-image');

    // v14.0: the arena row now holds ONLY the monster portrait, centered.
    // The monster's own HP bar used to ride along as a rotated vertical
    // pillar next to the image (v12.0-v13.0) — that's what caused the HP
    // value label to ragged-wrap. It now gets its own full-width
    // horizontal row directly below instead (hpRow), same orientation the
    // game natively uses, just bigger/bolder, and the exact number is
    // always shown (no abbreviation — see updateHpUI()).
    const arenaRow = make('div', 'bm-arena-row');
    arenaRow.appendChild(frame);

    const hpRow = make('div', 'bm-monster-hp-row');
    hpRow.id = 'bm-monster-hp-row';
    const hpBar = hpWrap.querySelector(':scope > .hp-bar');
    const hpLabels = hpWrap.querySelectorAll(':scope > .hp-text');
    if (hpBar) {
      hpBar.classList.add('bm-monster-hp-bar');
      hpRow.appendChild(hpBar);
      hpLabels.forEach(l => hpRow.appendChild(l));
      hpWrap.remove();
    } else {
      // Fallback: couldn't find the expected .hp-bar structure inside
      // monster-hp-wrap on this page — keep the whole native block
      // intact rather than risk deleting it.
      hpRow.appendChild(hpWrap);
    }

    // Placeholder for the native "Your Damage" display — filled in by
    // relocateDamageDisplay() once #yourDamageValue is located. Sits
    // right below the HP row, outside/above the You section.
    const damageDisplay = make('div', 'bm-damage-display');
    damageDisplay.id = 'bm-damage-display';

    const playerMeta = make('div', 'bm-player-meta');
    playerMeta.id = 'bm-player-meta';

    head.after(arenaRow);
    arenaRow.after(hpRow);
    hpRow.after(damageDisplay);
    damageDisplay.after(playerMeta);

    // v14.0: two pinned corner badges directly on the card — View Monster
    // Stats (top-left) and the auto-die countdown (top-right). Filled in
    // by relocateMonsterStatsButton() / moveMonsterEffectNote() once those
    // elements are located; absolutely positioned, so insertion order
    // doesn't affect where they render.
    const cornerStats = make('div', 'bm-corner bm-corner-topleft');
    cornerStats.id = 'bm-corner-stats';
    const cornerTimer = make('div', 'bm-corner bm-corner-topright');
    cornerTimer.id = 'bm-corner-timer';
    card.appendChild(cornerStats);
    card.appendChild(cornerTimer);

    let anchor = playerMeta;
    if (hasChips) { anchor.after(chipsRow); anchor = chipsRow; }

    if (controls) {
      const controlsLabel = make('div', 'eyebrow bm-controls-label', '⚔️ Attacks');
      controls.insertBefore(controlsLabel, controls.firstChild);
      anchor.after(controls);
    }

    card.dataset.bmArenaDone = '1';
  }

  // v14.0: the "Joined" chip was rendering as its own orphaned box well
  // below the rest of the card, disconnected from anything it relates to.
  // Moves it up next to the monster name / status chips, where the other
  // status chips already live, and gives it matching pill styling.
  // Matched purely by exact text content ("Joined") on a leaf element,
  // since the native markup for it isn't part of the known selectors
  // this script already tracks.
  function relocateJoinedChip() {
    const card = document.querySelector('.monster-card');
    const head = document.querySelector('.monster-card > .bm-arena-head');
    if (!card || !head) return;

    const candidate = Array.from(card.querySelectorAll('button, .chip, a.btn, span, div'))
    .find(el => el.dataset.bmJoinedDone !== '1'
          && el.children.length === 0
          && !head.contains(el)
          && /^joined$/i.test((el.textContent || '').trim()));
    if (!candidate) return;

    candidate.classList.add('bm-chip-joined');
    candidate.dataset.bmJoinedDone = '1';
    head.appendChild(candidate);
  }


  // Drops the "☠️ Monster has been slain!" heading and moves just the
  // Claim Loot / Extraction buttons into the same fixed bottom bar the
  // attack buttons live in — by the time this panel exists, the attack
  // buttons row is gone anyway, so there's no conflict.
  // Turns a ".muted" status line ("You already claimed your loot.",
  // "This monster is shadowless.") into a short label for the grayed-out
  // placeholder button, instead of showing the full sentence.
  function bmSlainPlaceholderLabel(noteText) {
    const t = noteText.toLowerCase();
    if (t.includes('already claimed')) return '✅ Claimed';
    if (t.includes('already') && t.includes('extract')) return '☠ Extracted';
    if (t.includes('shadowless')) return '☠ Shadowless';
    return noteText; // fallback: show the original message verbatim
  }

  function replaceWithSlainPlaceholder(oldEl, label) {
    const placeholder = document.createElement('button');
    placeholder.type = 'button';
    placeholder.disabled = true;
    placeholder.className = 'btn bm-slain-placeholder';
    placeholder.textContent = label;
    oldEl.replaceWith(placeholder);
  }

  // Watches for the SAME visual cue the native success handlers already
  // produce (opening the loot/extract modal) instead of touching fetch or
  // the API at all. Purely cosmetic -- the real state change already
  // happened server-side; this just mirrors it immediately instead of
  // making you wait for the reload to see it.
  function watchLootAndExtractModals() {
    const lootModal = document.getElementById('lootModal');
    if (lootModal && !lootModal.dataset.bmWatched) {
      lootModal.dataset.bmWatched = '1';
      new MutationObserver(() => {
        if (lootModal.style.display === 'flex') {
          const lootBtn = document.getElementById('loot-button');
          if (lootBtn) replaceWithSlainPlaceholder(lootBtn, '✅ Claimed');
        }
      }).observe(lootModal, { attributes: true, attributeFilter: ['style'] });
    }

    const extractCard = document.getElementById('extractCard');
    if (extractCard && !extractCard.dataset.bmWatched) {
      extractCard.dataset.bmWatched = '1';
      new MutationObserver(() => {
        if (extractCard.classList.contains('success')) {
          const extractBtn = document.getElementById('extract-shadow-btn');
          if (extractBtn) replaceWithSlainPlaceholder(extractBtn, '☠ Extracted');
        }
      }).observe(extractCard, { attributes: true, attributeFilter: ['class'] });
    }
  }

  // Locates the "Monster has been slain!" panel. Prefers the known
  // buttons (cheap, unambiguous) but falls back to matching on the
  // panel's own leading text when NEITHER loot nor extraction is
  // available (both already used/inapplicable — e.g. loot already
  // claimed AND the monster is shadowless — so the panel is just the
  // heading plus two ".muted" notes and no buttons at all).
  function findSlainPanel() {
    const lootBtn = document.getElementById('loot-button');
    if (lootBtn) return lootBtn.closest('div');

    const extractBtn = document.getElementById('extract-shadow-btn');
    if (extractBtn) return extractBtn.closest('div');

    // v15.7 fix: previously scoped this search to .monster-card, which was
    // an unverified assumption -- the button-based lookups above never
    // relied on any particular container, they just closest()'d up from
    // wherever the button actually was. If this panel's real location is
    // outside .monster-card, the scoped search silently found nothing and
    // pinSlainActionsBar() no-op'd, leaving the raw unstyled .muted lines
    // on screen. Search the whole document instead, same as the button path.
    return Array.from(document.querySelectorAll('div')).find(d => {
      const first = d.childNodes[0];
      return first && first.nodeType === 3
      && /monster has been slain/i.test(first.textContent)
      && d.querySelectorAll(':scope > .muted').length >= 1
      && !d.querySelector(':scope > button');
    }) || null;
  }

  function pinSlainActionsBar() {
    const panel = findSlainPanel();
    if (!panel) return;

    let bar = document.getElementById('bm-bottom-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'bm-bottom-bar';
      document.body.appendChild(bar);
    }

    if (panel.parentElement === bar) return; // already relocated

    const originalParent = panel.parentElement;

    Array.from(panel.childNodes).forEach(node => {
      const isButton = node.nodeType === 1 && (node.tagName === 'BUTTON' || node.tagName === 'A');
      if (isButton) return;

      const isMutedNote = node.nodeType === 1 && node.classList && node.classList.contains('muted');
      if (isMutedNote) {
        const placeholder = document.createElement('button');
        placeholder.type = 'button';
        placeholder.disabled = true;
        placeholder.className = 'btn bm-slain-placeholder';
        placeholder.textContent = bmSlainPlaceholderLabel(node.textContent.trim());
        panel.insertBefore(placeholder, node);
      }
      node.remove();
    });

    panel.removeAttribute('style');
    Array.from(panel.children).forEach(child => child.removeAttribute('style'));

    panel.classList.add('bm-bottom-bar-inner', 'bm-slain-actions');
    bar.appendChild(panel);

    if (originalParent && originalParent !== bar
        && !originalParent.children.length && !originalParent.textContent.trim()) {
      originalParent.style.display = 'none';
    }

    document.documentElement.style.setProperty('--bm-bottom-bar-h', bar.offsetHeight + 'px');
  }

  function compactMonsterImage() {
    const img = document.getElementById('monsterImage');
    if (!img || img.classList.contains('bm-monster-img')) return;
    clearInlineStyle(img);
    img.classList.add('bm-monster-img');
  }

  // v14.0: relocated into the pinned top-left corner badge instead of
  // sitting under the monster name/note stack.
  function relocateMonsterStatsButton() {
    const card = document.querySelector('.monster-card');
    if (!card) return;
    const btn = card.querySelector(':scope > .monster-stats-button');
    const corner = document.getElementById('bm-corner-stats');
    if (!btn || !corner || btn.dataset.bmRelocated === '1') return;

    btn.classList.add('bm-corner-stats-btn');
    corner.appendChild(btn);
    btn.dataset.bmRelocated = '1';
  }

  // Dormant on current monster templates (the native stats modal replaced
  // this inline stat-line), left in only so older/other monster pages
  // that might still emit ".monster-card > .stat-line" keep working.
  function mergeMonsterStatsIntoInfo() {
    const monsterStatLine = document.querySelector('.monster-card > .stat-line');
    const infoStatLine = document.querySelector('.battleinfo-card .stat-line');
    if (!monsterStatLine || !infoStatLine) return;
    Array.from(monsterStatLine.children).forEach(child => infoStatLine.appendChild(child));
    monsterStatLine.remove();
  }

  // v14.0: the "will Auto die in HH:MM:SS" countdown chip now moves into
  // the pinned top-right corner badge instead of sitting inline under the
  // monster name.
  function moveMonsterEffectNote() {
    const corner = document.getElementById('bm-corner-timer');
    if (!corner) return;

    // v15.5 FIX: was querying '.monster-card > .chip' (direct child) to find the
    // legacy chip. That only matches BEFORE the first relocation -- once the chip
    // is moved into #bm-corner-timer (itself a child of .monster-card), it's no
    // longer a *direct* child of .monster-card, so the selector silently stopped
    // matching on every run after the first. The code then believed the legacy
    // chip was gone and kept rebuilding a duplicate mini-chip next to it forever.
    // Locating it by the #nodmgCountdown id instead works no matter where it's
    // been moved to.
    const nodmgEl = document.getElementById('nodmgCountdown');
    const legacyChip = nodmgEl ? nodmgEl.closest('.chip') : null;
    const autoDieBar = document.getElementById('autoDieBar');

    if (autoDieBar && autoDieBar.style.display !== 'none') autoDieBar.style.display = 'none';
    if (autoDieBar) observeAutoDieBar(autoDieBar);

    if (legacyChip) {
      // Legacy chip always wins when present -- never let the bar-derived
      // mini-chip coexist with it.
      const stale = document.getElementById('bm-autodie-chip');
      if (stale) stale.remove();
      if (legacyChip.parentElement !== corner) {
        legacyChip.classList.add('bm-corner-chip');
        corner.appendChild(legacyChip);
      }
      return;
    }

    if (!autoDieBar) return;

    // No legacy chip anywhere on this monster -- fall back to mirroring the bar.
    let miniChip = document.getElementById('bm-autodie-chip');
    if (!miniChip) {
      miniChip = make('div', 'chip bm-corner-chip');
      miniChip.id = 'bm-autodie-chip';
      corner.appendChild(miniChip);
    }
    const timerEl = document.getElementById('autoDieTimer');
    const val = timerEl ? timerEl.textContent.trim() : '';
    if (miniChip.dataset.bmVal !== val) {
      miniChip.textContent = '⏳This monster will auto die in ' + val;
      miniChip.dataset.bmVal = val;
    }
  }

  // v15.4: un-debounced observer scoped to just #autoDieBar — reapplies
  // display:none the instant its style/content changes, instead of waiting
  // on the shared 50ms-debounced observer (which never watches attributes).
  function observeAutoDieBar(bar) {
    if (!bar || bar.dataset.bmInstantObserver === '1') return;
    const observer = new MutationObserver(() => moveMonsterEffectNote());
    observer.observe(bar, { attributes: true, attributeFilter: ['style', 'class'], childList: true, subtree: true });
    bar.dataset.bmInstantObserver = '1';
  }

  function chipifyStats() {
    const statLine = document.querySelector('.battleinfo-card .stat-line');
    if (!statLine || statLine.dataset.bmChipified === '1') return;
    statLine.classList.add('bm-chip-grid');

    statLine.querySelectorAll(':scope > .stat-block').forEach(block => {
      const label = block.querySelector('.label');
      const strong = block.querySelector('strong');
      const note = block.querySelector('div:not(.label)');
      if (!label || !strong) return;

      block.classList.add('bm-stat-chip');

      const wrap = make('span', 'bm-stat-chip-inner');
      wrap.appendChild(label);
      wrap.appendChild(strong);

      block.innerHTML = '';
      block.appendChild(wrap);

      if (note && note.textContent.trim()) {
        note.classList.add('bm-stat-chip-note');
        note.removeAttribute('style');
        block.classList.add('bm-stat-chip--has-note');
        block.appendChild(note);
      }
    });

    statLine.dataset.bmChipified = '1';
  }

  // =====================================================================
  // v15.4: MATCHUP WARNINGS — pulls together your level/ATK/DEF/stamina,
  // this monster's Level Req / EXP Cap state, and (once the native "View
  // Monster Stats" modal has been opened at least once — its values aren't
  // rendered anywhere else) its ATK/DEF/element/resistances, into a stack
  // of warning icons pinned to the monster card's left edge. Hover/click an
  // icon for the reasoning.
  // =====================================================================

  // v15.5: replaced the flat "1.3x" guess with the ACTUAL damage-engine formula
  // from the build-optimizer script's buildDamage(): each term is
  // max(FLOOR, gap) * multiplier -- no ratio exists in the real formula. Below
  // FLOOR the term is pinned at its minimum regardless of how negative the gap
  // is, so the warning is just "are you under the floor, and by how much."
  const DMG_ENGINE = { FLOOR: 30, EQUIP_PER_ATK: 20, ATK_EXP: 0.25 };
  function atkTermValue(gap) { return 1000 * Math.pow(Math.max(DMG_ENGINE.FLOOR, gap), DMG_ENGINE.ATK_EXP); }
  function pctStr(frac) { return ((frac || 0) * 100).toFixed(1) + '%'; }
  function toFrac(v, hasPct) {
    if (isNaN(v) || v === null || v === undefined) return 0;
    if (hasPct) return v / 100;
    return v > 1 ? v / 100 : v;
  }
  function parsePenetrationFromText(text) {
    const txt = (text || '').toLowerCase();
    const out = {};
    const eqPenM = txt.match(/(?:gain\s+)?(\d[\d.]*)\s*(%?)\s*equipe?ment\s*defense\s*penetration/)
    || txt.match(/equipe?ment\s*defense\s*penetration\s*(?:by\s*)?(\d[\d.]*)\s*(%?)/);
    if (eqPenM) out.eqPen = toFrac(parseFloat(eqPenM[1]), eqPenM[2] === '%');
    const petPenM = txt.match(/(?:gain\s+)?(\d[\d.]*)\s*(%?)\s*pet\s*defense\s*penetration/)
    || txt.match(/pet\s*defense\s*penetration\s*(?:by\s*)?(\d[\d.]*)\s*(%?)/);
    if (petPenM) out.petPen = toFrac(parseFloat(petPenM[1]), petPenM[2] === '%');
    const apM = txt.match(/(\d[\d.]*)\s*(%?)\s*armor\s*penetration/)
    || txt.match(/armor\s*penetration\s*(?:by\s*)?(\d[\d.]*)\s*(%?)/);
    if (apM) out.armorPen = toFrac(parseFloat(apM[1]), apM[2] === '%');
    return out;
  }
  function parsePetCardBasic(card) {
    const infoBtn = card.querySelector('.info-btn[data-name]');
    const img = card.querySelector('img[alt]');
    const name = infoBtn ? infoBtn.getAttribute('data-name').trim() : (img ? img.getAttribute('alt').trim() : null);
    if (!name) return null;
    const descBtn = card.querySelector('.info-btn[data-desc]');
    const passiveText = descBtn ? (descBtn.getAttribute('data-desc') || '') : '';
    let petInvId = null;
    const linksBtn = Array.from(card.querySelectorAll('button')).find(b => /links/i.test(b.textContent));
    if (linksBtn) {
      const oc = linksBtn.getAttribute('onclick') || '';
      const idM = oc.match(/openLinksModal\((\d+)\)/);
      if (idM) petInvId = parseInt(idM[1], 10);
    }
    return { name, passiveText, petInvId };
  }

  let playerRemoteStats = null;
  let playerRemoteStatsPromise = null;
  function fetchPlayerRemoteStats() {
    if (playerRemoteStats) return Promise.resolve(playerRemoteStats);
    if (playerRemoteStatsPromise) return playerRemoteStatsPromise;
    playerRemoteStatsPromise = Core.net.fetchText('/stats.php')
      .then(html => {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const num = id => {
        const el = doc.getElementById(id);
        return el ? (parseInt((el.textContent || '').replace(/[^0-9]/g, ''), 10) || 0) : 0;
      };
      playerRemoteStats = { atk: num('v-attack'), def: num('v-defense'), stamina: num('v-stamina') };
      return playerRemoteStats;
    })
      .catch(() => { playerRemoteStats = { atk: 0, def: 0, stamina: 0 }; return playerRemoteStats; });
    return playerRemoteStatsPromise;
  }

  function getPlayerLevel() {
    const lvlEl = document.querySelector('.gtb-level');
    if (!lvlEl) return 0;
    return parseInt((lvlEl.textContent || '').replace(/[^0-9]/g, ''), 10) || 0;
  }

  // Battle Info's chipified stat-line: Level Req / EXP Cap / EXP-DMG / Monster HP
  function getMonsterInfoChips() {
    const out = {};
    document.querySelectorAll('.battleinfo-card .bm-stat-chip').forEach(chip => {
      const label = chip.querySelector('.label');
      const strong = chip.querySelector('strong');
      if (!label || !strong) return;
      out[label.textContent.trim()] = {
        value: strong.textContent.trim(),
        capReached: chip.classList.contains('bm-cap-reached')
      };
    });
    return out;
  }

  // "View Monster Stats" modal — only populated once the player has opened
  // it at least once this page load; nothing else on the page has ATK/DEF/
  // resistances for the monster.
  function getMonsterModalStats() {
    const grid = document.querySelector('.monster-stats-grid');
    if (!grid) return null;
    const out = { resistances: [] };
    grid.querySelectorAll('.monster-stat-cell').forEach(cell => {
      const label = cell.querySelector('.label');
      const strong = cell.querySelector('strong');
      if (!label || !strong) return;
      const l = label.textContent.trim(), v = strong.textContent.trim();
      if (l === 'Attack') out.atk = parseInt(v.replace(/[^0-9]/g, ''), 10) || 0;
      else if (l === 'Defense') out.def = parseInt(v.replace(/[^0-9]/g, ''), 10) || 0;
      else if (l === 'Pet Defense') out.petDef = parseInt(v.replace(/[^0-9]/g, ''), 10) || 0;
      else if (l === 'Equipment Defense') out.eqDef = parseInt(v.replace(/[^0-9]/g, ''), 10) || 0;
      else if (l === 'Element') out.element = v.toUpperCase();
      else if (l === 'Element Rate') out.elemRate = parseFloat(v) || 0;
      else if (cell.classList.contains('resistance')) {
        const pctVal = parseFloat(v) || 0;
        if (pctVal > 0) out.resistances.push({ label: l, value: pctVal });
      }
    });
    return out;
  }

  function getDivineShieldMult() {
    const m = (document.body.textContent || '').match(/Damage\s*Multiplier:\s*([0-9.]+)\s*%/i);
    return m ? parseFloat(m[1]) : null;
  }

  // Same COUNTERS table the Build Optimizer script uses for its damage
  // engine. NOTE: some event mobs show elements outside this 7-element list
  // (e.g. "WIND") — those simply get no counter bonus either way below,
  // they still go through the plain rate comparison.
  const WARN_COUNTERS = {
    FIRE: ['NATURE','FROST'], NATURE: ['LIGHT','VOID'], FROST: ['WATER','THUNDER'],
    THUNDER: ['WATER','NATURE'], WATER: ['FIRE','LIGHT'], VOID: ['FIRE','THUNDER'],
    LIGHT: ['VOID','FROST']
  };

  // v15.7: rules taken from the game's Damage Formula panel.
  // Manual EXTRA bonuses, added on top of the auto-detected ones (0.25 = +25%). Leave at 0 --
  // v15.9 reads "X% <ELEMENT> Element Rate Increase" (Wyvern) and "X% Extra Elemental Damage"
  // (Reindeer) from your team + linked pets by itself.
  const ELEMENT_BONUS = { wyvernVoid: 0, reindeer: 0 };
  // Element-rate multiplier bonus for element e, from detected passives (bonus.rate) + manual override.
  function elemBonusOf(bonus, e) {
    const det = (bonus && bonus.rate && e && bonus.rate[e]) || 0;
    return det + (e === 'VOID' ? ELEMENT_BONUS.wyvernVoid : 0);
  }
  function elemDmgBonusOf(bonus) { return ELEMENT_BONUS.reindeer + ((bonus && bonus.dmg) || 0); }
  // In-game tie order is "predetermined". This is a PLACEHOLDER: confirm the real order.
  const ELEMENT_TIE_ORDER = ['FIRE', 'WATER', 'FROST', 'NATURE', 'THUNDER', 'VOID', 'LIGHT'];
  // Share of a LINKED pet's element rate that counts for you (link slot -> fraction of that pet's own rate).
  // Main pet = 100% (5%), Link 1 = 50% (2.5%), Link 2 = 25% (1.25%).
  const LINK_ELEMENT_SHARE = { 1: 0.5, 2: 0.25 };
  const ELEMENT_DMG_PER_POINT = 1500;   // per 1% of advantage, per stamina
  const ELEMENT_WEAK_MAX = 5;           // your strength <= 5% -> can't take a disadvantage
  const ELEMENT_WEAK_MONSTER_RATE = 0.5; // ...and the monster counts as 0.5%

  // advantage = (your rate, x2 if you counter it, x(1+Wyvern) if Void)
  //           - (monster rate, x2 if it counters you)
  // elemental damage = advantage * 1500 * (1+Reindeer) * stamina_cost
  function computeElementMatchup(pElem, pRate, mElem, mRate, bonus) {
    if (!mElem || mElem === 'None' || !(mRate > 0)) return null;        // no monster element: skipped
    pRate = pElem ? (Number(pRate) || 0) : 0;
    const weak = pRate <= ELEMENT_WEAK_MAX;
    const mEff = weak ? ELEMENT_WEAK_MONSTER_RATE : mRate;
    const pStrong = !!pElem && elemBeats(pElem, mElem);
    const mStrong = !!pElem && elemBeats(mElem, pElem);
    const pBonus = pElem ? elemBonusOf(bonus, pElem) : 0;   // e.g. Wyvern +20.48% on VOID
    const pAdj = pRate * (pStrong ? 2 : 1) * (1 + pBonus);
    const mAdj = mEff * (mStrong ? 2 : 1);
    const adv = pAdj - mAdj;
    return { adv, pAdj, mAdj, pStrong, mStrong, weak, mEff, pBonus, dmgBonus: elemDmgBonusOf(bonus), disadvantaged: !weak && adv < 0 };
  }

  // Kept under the old name so nothing else that calls it breaks.
  function isElementDisadvantaged(pElem, pRate, mElem, mRate, bonus) {
    const mu = computeElementMatchup(pElem, pRate, mElem, mRate, bonus);
    return mu ? { disadvantaged: mu.disadvantaged, mu } : null;
  }

  // Best-effort player elemental rate. This duplicates a slice of the Build
  // Optimizer script's scraping logic since these two scripts run on
  // different pages (battle.php vs stats.php) and can never share state at
  // runtime. Counts EQUIPPED gear + the equipped PvE team + (v15.8) that team's
  // linked pets at their link-slot share (Link 1 = 50%, Link 2 = 25%).
  function scrapeEquippedElementRates(invDoc) {
    const rates = {}, byName = {};
    invDoc.querySelectorAll('.slot-box[data-inv-id]').forEach(card => {
      const infoBtn = card.querySelector('.info-btn[data-name]');
      const img = card.querySelector('img[alt]');
      const name = infoBtn ? infoBtn.getAttribute('data-name').trim() : (img ? img.getAttribute('alt').trim() : null);
      if (!name || byName[name]) return;
      const descBtn = card.querySelector('.info-btn[data-desc]');
      let element = null, elemPct = 0;
      if (descBtn) {
        const desc = descBtn.getAttribute('data-desc') || '';
        const elemM = desc.match(/Element:\s*(FIRE|WATER|FROST|NATURE|THUNDER|VOID|LIGHT)\s*\(\+([0-9.]+)%\)/i)
        || desc.match(/(FIRE|WATER|FROST|NATURE|THUNDER|VOID|LIGHT)\s*\+([0-9.]+)%/i);
        if (elemM) { element = elemM[1].toUpperCase(); elemPct = parseFloat(elemM[2]); }
      }
      byName[name] = { element, elemPct };
    });
    invDoc.querySelectorAll('.slot-box:not([data-inv-id])').forEach(card => {
      const btn = card.querySelector('button');
      if (!btn || !btn.textContent.includes('Unequip')) return;
      const img = card.querySelector('img[alt]');
      const name = img ? img.getAttribute('alt').trim() : null;
      const item = name && byName[name];
      if (item && item.element) rates[item.element] = (rates[item.element] || 0) + item.elemPct;
    });
    return rates;
  }
  function scrapeMainTeamElementRates(petDoc) {
    const rates = {};
    let mainSection = null;
    petDoc.querySelectorAll('.section').forEach(sec => {
      const titleEl = sec.querySelector('.section-title');
      if (titleEl && /PvE Attack Team/i.test(titleEl.textContent.trim())) mainSection = sec;
    });
    if (!mainSection) return rates;
    mainSection.querySelectorAll('.pet-card').forEach(card => {
      const el = card.dataset.element;
      const rateRaw = parseFloat(card.dataset.elementRate || card.dataset.elemRate || 0) || 0;
      if (!el || !rateRaw) return;
      const rate = rateRaw <= 1 ? rateRaw * 100 : rateRaw;
      rates[el.toUpperCase()] = (rates[el.toUpperCase()] || 0) + rate;
    });
    return rates;
  }
  // v15.8: every pet card on pets.php carries data-pet-inv-id / data-element / data-element-rate
  // (rate is a fraction: 0.05 = 5%). Index them so a LINKED pet's own element can be looked up.
  function readCardElement(card) {
    const el = (card.dataset.element || '').trim().toUpperCase();
    const raw = parseFloat(card.dataset.elementRate || card.dataset.elemRate || 0) || 0;
    if (!el || el === 'NONE' || !(raw > 0)) return null;
    return { element: el, rate: raw <= 1 ? raw * 100 : raw };
  }
  // v15.9: passive-text parsing for the two element bonuses.
  //   "20.48% Void Element Rate Increase"           -> rate.VOID = 0.2048
  //   "20.99% Extra Elemental Damage To Monsters"   -> dmg = 0.2099
  const ELEMENT_NAME_RE = 'FIRE|WATER|FROST|NATURE|THUNDER|VOID|LIGHT';
  function parseElementPassives(text) {
    const out = { rate: {}, dmg: 0 };
    const t = String(text || '').split(/\n|<br\s*\/?>/i).filter(line => !/pvp\s*only/i.test(line)).join('\n');
    if (!t) return out;
    const rateRe = new RegExp('(\\d+(?:\\.\\d+)?)\\s*%\\s*(' + ELEMENT_NAME_RE + ')\\s*element\\s*rate\\s*(?:increase|bonus)', 'gi');
    let m;
    while ((m = rateRe.exec(t))) {
      const el = m[2].toUpperCase();
      out.rate[el] = (out.rate[el] || 0) + parseFloat(m[1]) / 100;
    }
    const dm = t.match(/(\d+(?:\.\d+)?)\s*%\s*(?:extra|bonus|additional)\s*elemental\s*damage/i)
      || t.match(/increase[sd]?\s*(?:your\s*)?elemental\s*damage\s*(?:to\s*monsters\s*)?by\s*(\d+(?:\.\d+)?)\s*%/i);
    if (dm) out.dmg = parseFloat(dm[1]) / 100;
    return out;
  }
  // Card's live passive line ([data-power]) first, its info-button description as fallback.
  function parsePassivesFromCard(card) {
    const power = card.querySelector('[data-power]');
    const a = parseElementPassives(power ? power.textContent : '');
    const basic = parsePetCardBasic(card);
    const b = parseElementPassives(basic ? basic.passiveText : '');
    return { rate: Object.keys(a.rate).length ? a.rate : b.rate, dmg: a.dmg || b.dmg };
  }
  function indexPetPassives(petDoc) {
    const byInv = {}, byName = {};
    petDoc.querySelectorAll('.pet-card[data-pet-inv-id]').forEach(card => {
      const parsed = parsePassivesFromCard(card);
      const id = parseInt(card.getAttribute('data-pet-inv-id'), 10);
      if (id && !byInv[id]) byInv[id] = parsed;
      const basic = parsePetCardBasic(card);
      if (basic && basic.name && !byName[basic.name]) byName[basic.name] = parsed;
    });
    return { byInv, byName };
  }
  // A linked pet's passive: if the Links panel's own text for that link already shows a SMALLER
  // number than the pet's full passive, it is pre-scaled by the server -> trust it. Otherwise scale
  // the full value by the link share.
  function scaleLinkedPassive(full, serverVal, share) {
    if (serverVal > 0 && serverVal < full - 1e-9) return serverVal;
    return full * share;
  }
  function indexPetElements(petDoc) {
    const byInv = {}, byName = {};
    petDoc.querySelectorAll('.pet-card[data-pet-inv-id]').forEach(card => {
      const info = readCardElement(card);
      if (!info) return;
      const id = parseInt(card.getAttribute('data-pet-inv-id'), 10);
      if (id) byInv[id] = info;
      const basic = parsePetCardBasic(card);
      if (basic && basic.name && !byName[basic.name]) byName[basic.name] = info;
    });
    return { byInv, byName };
  }
  function scrapeEquippedGearATK(invDoc) {
    let total = 0;
    invDoc.querySelectorAll('.slot-box:not([data-inv-id])').forEach(card => {
      const btn = card.querySelector('button');
      if (!btn || !btn.textContent.includes('Unequip')) return;
      const label = card.querySelector('.label');
      if (!label) return;
      const atkMatch = (label.textContent || '').match(/([\d,]+)\s*ATK/i);
      const atk = atkMatch ? parseInt(atkMatch[1].replace(/,/g, ''), 10) || 0 : 0;
      total += atk;
    });
    return total;
  }

  function scrapeMainTeamPetATK(petDoc) {
    let total = 0, mainSection = null;
    petDoc.querySelectorAll('.section').forEach(sec => {
      const titleEl = sec.querySelector('.section-title');
      if (titleEl && /PvE Attack Team/i.test(titleEl.textContent.trim())) mainSection = sec;
    });
    if (!mainSection) return 0;
    mainSection.querySelectorAll('.pet-card').forEach(card => {
      const atkEl = card.querySelector('.pet-atk');
      total += atkEl ? (parseInt((atkEl.textContent || '').replace(/[^0-9]/g, ''), 10) || 0) : 0;
    });
    return total;
  }

  let playerGearPetPromise = null;
  function fetchPlayerGearPetSummary() {
    if (playerGearPetPromise) return playerGearPetPromise;
    playerGearPetPromise = Promise.all([
      Core.net.fetchText('/inventory.php').catch(() => null),
      Core.net.fetchText('/pets.php').catch(() => null)
    ]).then(([invHtml, petHtml]) => {
      const result = { element: null, rates: {}, sources: {}, bonus: { rate: {}, dmg: 0, src: [] }, ratesKnown: false, equipATK: 0, petATK: 0, eqPen: 0, petPen: 0, armorPen: 0 };
      const rates = {};
      const addBonus = (kind, elem, frac, pet, where) => {
        if (!(frac > 0)) return;
        if (kind === 'rate') result.bonus.rate[elem] = (result.bonus.rate[elem] || 0) + frac;
        else result.bonus.dmg += frac;
        result.bonus.src.push({ label: kind === 'rate' ? `${elem} rate` : 'elem dmg', pct: frac, pet: pet || '?', where: where || '' });
      };
      const addSource = (elem, kind, amount) => {
        const src = result.sources[elem] || (result.sources[elem] = { gear: 0, pets: 0, links: 0 });
        src[kind] += amount;
        rates[elem] = (rates[elem] || 0) + amount;
      };
      if (invHtml) {
        const invDoc = new DOMParser().parseFromString(invHtml, 'text/html');
        const gearRates = scrapeEquippedElementRates(invDoc);
        Object.keys(gearRates).forEach(k => addSource(k, 'gear', gearRates[k]));
        result.equipATK = scrapeEquippedGearATK(invDoc);
      }

      function finish() {
        let best = null, bestRate = 0;
        // v15.7: strictly-greater wins, iterated in ELEMENT_TIE_ORDER, so ties resolve deterministically.
        const order = ELEMENT_TIE_ORDER.concat(Object.keys(rates).filter(k => ELEMENT_TIE_ORDER.indexOf(k) < 0));
        order.forEach(k => { const r = rates[k] || 0; if (r > bestRate) { bestRate = r; best = k; } });
        result.element = best ? { element: best, rate: bestRate } : null;
        result.rates = Object.assign({}, rates);
        result.ratesKnown = !!(invHtml && petHtml);
        return result;
      }
      if (!petHtml) return finish();

      const petDoc = new DOMParser().parseFromString(petHtml, 'text/html');
      const petRates = scrapeMainTeamElementRates(petDoc);
      Object.keys(petRates).forEach(k => addSource(k, 'pets', petRates[k]));
      result.petATK = scrapeMainTeamPetATK(petDoc);
      const petElemIndex = indexPetElements(petDoc);

      // Penetration: name -> passiveText for every owned pet, then sum
      // eq_pen/pet_pen/armor_pen off pets actually LINKED to the equipped
      // PvE team (via pet_links_ajax.php), at FULL parsed value -- matches
      // the build-optimizer script's v11.3 finding that penetration
      // passives are NOT scaled by link factor (unlike crit/monster-dmg/
      // elem passives, which are).
      const passiveByName = {};
      petDoc.querySelectorAll('.pet-card').forEach(card => {
        const p = parsePetCardBasic(card);
        if (p) passiveByName[p.name] = p.passiveText;
      });
      let mainSection = null;
      petDoc.querySelectorAll('.section').forEach(sec => {
        const titleEl = sec.querySelector('.section-title');
        if (titleEl && /PvE Attack Team/i.test(titleEl.textContent.trim())) mainSection = sec;
      });
      const mains = mainSection ? Array.from(mainSection.querySelectorAll('.pet-card')).map(parsePetCardBasic).filter(Boolean) : [];

      // v15.9: passives on the MAIN team count at full value.
      const passiveIndex = indexPetPassives(petDoc);
      if (mainSection) {
        mainSection.querySelectorAll('.pet-card').forEach(card => {
          const nm = (parsePetCardBasic(card) || {}).name || 'main pet';
          const pp = parsePassivesFromCard(card);
          Object.keys(pp.rate).forEach(el => addBonus('rate', el, pp.rate[el], nm, 'main'));
          addBonus('dmg', null, pp.dmg, nm, 'main');
        });
      }

      return Promise.all(mains.map(main => {
        if (!main.petInvId) return null;
        return fetch(`/pet_links_ajax.php?pet_inv_id=${main.petInvId}`, { credentials: 'same-origin' })
          .then(r => r.json()).catch(() => null);
      })).then(linkResults => {
        linkResults.forEach((data, mainIdx) => {
          if (!data || data.status !== 'success' || !Array.isArray(data.links)) return;
          data.links.forEach(l => {
            // v15.8: linked pet's element counts at its link-slot share (Link 1 = 50%, Link 2 = 25%).
            const linkedElem = petElemIndex.byInv[Number(l.link_pet_id)] || petElemIndex.byName[l.name];
            const share = LINK_ELEMENT_SHARE[Number(l.link_level)];
            if (linkedElem && share) {
              const add = linkedElem.rate * share;
              addSource(linkedElem.element, 'links', add);
              console.debug('[BattlePage] link element', mains[mainIdx] && mains[mainIdx].name, '-> link', l.link_level, l.name,
                            linkedElem.element, linkedElem.rate + '% x' + share + ' = +' + add);
            }
            // v15.9: linked pet's Wyvern/Reindeer-style passives, at link share (or the server's own scaled number).
            const fullP = passiveIndex.byInv[Number(l.link_pet_id)] || passiveIndex.byName[l.name];
            if (fullP && share) {
              const srvP = parseElementPassives(l.effect_text);
              Object.keys(fullP.rate).forEach(el => {
                const val = scaleLinkedPassive(fullP.rate[el], srvP.rate[el] || 0, share);
                console.debug('[BattlePage] link passive', l.name, el + ' rate', 'full', fullP.rate[el], 'server', srvP.rate[el] || 0, '->', val);
                addBonus('rate', el, val, l.name, 'link ' + l.link_level);
              });
              if (fullP.dmg > 0) {
                const val = scaleLinkedPassive(fullP.dmg, srvP.dmg || 0, share);
                console.debug('[BattlePage] link passive', l.name, 'elem dmg', 'full', fullP.dmg, 'server', srvP.dmg || 0, '->', val);
                addBonus('dmg', null, val, l.name, 'link ' + l.link_level);
              }
            }
            const text = passiveByName[l.name] || l.effect_text || '';
            const parsed = parsePenetrationFromText(text);
            if (parsed.eqPen) result.eqPen += parsed.eqPen;
            if (parsed.petPen) result.petPen += parsed.petPen;
            if (parsed.armorPen) result.armorPen += parsed.armorPen;
          });
        });
        return finish();
      });
    }).catch(err => {
      console.error('[BattlePage] fetchPlayerGearPetSummary failed:', err);
      return { element: null, rates: {}, sources: {}, bonus: { rate: {}, dmg: 0, src: [] }, ratesKnown: false, equipATK: 0, petATK: 0, eqPen: 0, petPen: 0, armorPen: 0 };
    });
    return playerGearPetPromise;
  }

  function buildWarnings(playerLevel, remoteStats, infoChips, modalStats, divineMult, playerElem, gearPet) {
    const warns = [];

    const lvReq = infoChips['Level Req'];
    if (lvReq) {
      const req = parseInt(lvReq.value.replace(/[^0-9]/g, ''), 10) || 0;
      if (playerLevel && req && playerLevel < req) {
        warns.push({ color: 'red', icon: '⛔', title: 'Below level requirement',
                    detail: `This monster requires LV ${fmt(req)}; you are LV ${fmt(playerLevel)}.` });
      }
    }

    const expCap = infoChips['EXP Cap'];
    if (expCap && expCap.capReached) {
      warns.push({ color: 'yellow', icon: '📈', title: 'EXP cap reached',
                  detail: `You've already dealt enough damage to hit this monster's EXP cap (${expCap.value}). Further hits give no extra EXP.` });
    }

    if (modalStats && remoteStats) {
      const mobDefEff = (modalStats.def || 0) * (1 - Math.min(0.95, remoteStats.armorPen || 0));
      const atkGap = (remoteStats.atk || 0) - mobDefEff;
      if (modalStats.def > 0 && atkGap < DMG_ENGINE.FLOOR) {
        const deficit = Math.round(DMG_ENGINE.FLOOR - atkGap);
        const floored = Math.round(atkTermValue(atkGap));
        warns.push({ color: 'red', icon: '🗡️', title: 'ATK damage term floored',
                    detail: `Your ATK (${fmt(remoteStats.atk)}) vs this monster's DEF (${fmt(Math.round(mobDefEff))}${remoteStats.armorPen ? `, after your ${pctStr(remoteStats.armorPen)} armor penetration` : ''}) is only a ${fmt(Math.round(atkGap))} gap. Below a ${DMG_ENGINE.FLOOR} gap this damage term is capped at its minimum (${fmt(floored)}) and gets zero benefit from further ATK — you need at least ${fmt(deficit)} more ATK just to start climbing above the floor.` });
      }

      if (typeof modalStats.eqDef === 'number' && modalStats.eqDef > 0) {
        const eqDefEff = modalStats.eqDef * (1 - Math.min(0.95, remoteStats.eqPen || 0));
        const eqGap = (remoteStats.equipATK || 0) - eqDefEff;
        if (eqGap < DMG_ENGINE.FLOOR) {
          const deficit = Math.round(DMG_ENGINE.FLOOR - eqGap);
          warns.push({ color: 'red', icon: '🧱', title: 'Equipment damage term floored',
                      detail: `Your equipped gear ATK total (${fmt(remoteStats.equipATK || 0)}) vs this monster's Equipment Defense (${fmt(Math.round(eqDefEff))}${remoteStats.eqPen ? `, after your ${pctStr(remoteStats.eqPen)} equipment penetration` : ''}) is only a ${fmt(Math.round(eqGap))} gap. This term is floored — you need at least ${fmt(deficit)} more equipped ATK to escape it.` });
        }
      }

      if (typeof modalStats.petDef === 'number' && modalStats.petDef > 0) {
        const petDefEff = modalStats.petDef * (1 - Math.min(0.95, remoteStats.petPen || 0));
        const petGap = (remoteStats.petATK || 0) - petDefEff;
        if (petGap < DMG_ENGINE.FLOOR) {
          const deficit = Math.round(DMG_ENGINE.FLOOR - petGap);
          warns.push({ color: 'red', icon: '🐾', title: 'Pet damage term floored',
                      detail: `Your main pets' ATK total (${fmt(remoteStats.petATK || 0)}) vs this monster's Pet Defense (${fmt(Math.round(petDefEff))}${remoteStats.petPen ? `, after your ${pctStr(remoteStats.petPen)} pet penetration` : ''}) is only a ${fmt(Math.round(petGap))} gap. This term is floored — you need at least ${fmt(deficit)} more pet ATK to escape it.` });
        }
      }

      // Separate concern from the three floored-term checks above: this is
      // damage you TAKE on retaliation, not damage you deal. There's no
      // confirmed retaliation formula in either script, so this stays a
      // rough amount-based heuristic rather than a formula-derived one.
      if (modalStats.atk > 0 && remoteStats.def > 0 && remoteStats.def < modalStats.atk) {
        const short = Math.round(modalStats.atk - remoteStats.def);
        warns.push({ color: 'yellow', icon: '🛡️', title: 'DEF below monster ATK',
                    detail: `Monster ATK (${fmt(modalStats.atk)}) exceeds your DEF (${fmt(remoteStats.def)}) by ${fmt(short)} — possible increased damage taken on retaliation. Unlike the damage-dealt checks above, this isn't derived from a confirmed formula.` });
      }
    }

    if (modalStats && modalStats.resistances.length) {
      warns.push({ color: 'yellow', icon: '🧊', title: 'Monster has resistances',
                  detail: modalStats.resistances.map(r => `${r.label}: ${r.value}%`).join(', ') });
    }

    // v15.6: the element check is now an always-on green/red icon, added first below.

    if (divineMult !== null && divineMult < 100) {
      warns.push({ color: 'yellow', icon: '✨', title: 'Divine Shield active',
                  detail: `Incoming damage is currently multiplied by ${divineMult.toFixed(1)}%.` });
    }

    const rank = { red: 0, yellow: 1, green: 2 };
    warns.sort((a, b) => (rank[a.color] ?? 1) - (rank[b.color] ?? 1));
    const elemWarn = buildElementWarning(gearPet);
    if (elemWarn) warns.unshift(elemWarn); // element icon always sits first on the rail
    return warns;
  }

  let lastRenderedWarnKey = null;

  function warnKey(warns) {
    return warns.map(w => w.color + '|' + w.icon + '|' + w.title + '|' + w.detail).join('\n');
  }

  function renderWarnings(warns) {
    const arenaRow = document.querySelector('.bm-arena-row');
    if (!arenaRow) return;
    let rail = arenaRow.querySelector('.bm-warn-rail');

    const key = warnKey(warns);
    if (key === lastRenderedWarnKey && (rail || !warns.length)) return;
    lastRenderedWarnKey = key;

    if (!warns.length) { if (rail) rail.remove(); return; }
    if (!rail) { rail = make('div', 'bm-warn-rail'); arenaRow.appendChild(rail); }
    rail.innerHTML = '';
    warns.forEach(w => {
      const icon = make('div', `bm-warn-icon bm-warn-${w.color}`, w.icon);
      icon.appendChild(make('div', 'bm-warn-tip', `<strong>${escapeHtml(w.title)}</strong>${escapeHtml(w.detail)}`));
      icon.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasOpen = icon.classList.contains('bm-warn-open');
        rail.querySelectorAll('.bm-warn-icon').forEach(i => i.classList.remove('bm-warn-open'));
        if (!wasOpen) icon.classList.add('bm-warn-open');
      });
      rail.appendChild(icon);
    });
  }
  document.addEventListener('click', () => {
    document.querySelectorAll('.bm-warn-icon.bm-warn-open').forEach(i => i.classList.remove('bm-warn-open'));
  });

  let warnRefreshBusy = false;
  function refreshWarnings() {
    if (warnRefreshBusy) return;
    warnRefreshBusy = true;
    const playerLevel = getPlayerLevel();
    const infoChips = getMonsterInfoChips();
    const modalStats = getMonsterModalStats();
    const divineMult = getDivineShieldMult();
    Promise.all([fetchPlayerRemoteStats(), fetchPlayerGearPetSummary()])
      .then(([remoteStatsBase, gearPet]) => {
      const remoteStats = Object.assign({}, remoteStatsBase, {
        equipATK: gearPet.equipATK, petATK: gearPet.petATK,
        eqPen: gearPet.eqPen, petPen: gearPet.petPen, armorPen: gearPet.armorPen
      });
      renderWarnings(buildWarnings(playerLevel, remoteStats, infoChips, modalStats, divineMult, gearPet.element, gearPet));
      warnRefreshBusy = false;
    })
      .catch(err => {
      console.error('[BattlePage] refreshWarnings failed:', err);
      warnRefreshBusy = false;
    });
  }


  // =====================================================================
  // v15.6: ELEMENT WARNING — always-on green/red icon (see changelog).
  // Monster element source, in order:
  //   1. the live "View Monster Stats" grid, if it's populated;
  //   2. a one-time re-fetch of this same page (only helps if the server
  //      renders that grid in the raw HTML rather than filling it via JS);
  //   3. otherwise a yellow "?" icon; it turns green/red by itself once the
  //      modal is opened.
  // =====================================================================

  const ELEMENT_EMOJI = { FIRE: '🔥', WATER: '💧', FROST: '❄️', NATURE: '🌿', THUNDER: '⚡', VOID: '🌀', LIGHT: '✨' };

  function readElementFromGrid(root) {
    const grid = root.querySelector('.monster-stats-grid');
    if (!grid) return { status: 'unknown' };
    let element = null, rate = 0, found = false;
    grid.querySelectorAll('.monster-stat-cell').forEach(cell => {
      const label = cell.querySelector('.label');
      const strong = cell.querySelector('strong');
      if (!label || !strong) return;
      const l = label.textContent.trim(), v = strong.textContent.trim();
      if (l === 'Element') { found = true; element = v.toUpperCase(); }
      else if (l === 'Element Rate') rate = parseFloat(v) || 0;
    });
    if (!found) return { status: 'unknown' };
    if (!element || element === 'NONE' || !(rate > 0)) return { status: 'none' };
    return { status: 'element', element, rate };
  }

  let monsterElemFallback = null;
  let monsterElemFallbackPromise = null;
  function fetchMonsterElementFallback() {
    if (monsterElemFallbackPromise) return monsterElemFallbackPromise;
    monsterElemFallbackPromise = fetch(location.href, { credentials: 'same-origin', cache: 'no-store' })
      .then(r => (r.ok ? r.text() : ''))
      .then(html => {
        monsterElemFallback = html
          ? readElementFromGrid(new DOMParser().parseFromString(html, 'text/html'))
          : { status: 'unknown' };
      })
      .catch(() => { monsterElemFallback = { status: 'unknown' }; })
      .then(() => { scheduleRun(); });
    return monsterElemFallbackPromise;
  }

  function currentMonsterElement() {
    const live = readElementFromGrid(document);
    if (live.status !== 'unknown') return live;
    if (monsterElemFallback && monsterElemFallback.status !== 'unknown') return monsterElemFallback;
    if (!monsterElemFallbackPromise) fetchMonsterElementFallback();
    return { status: 'unknown', loading: !monsterElemFallback };
  }

  function elemPct(n) { return (Math.round((Number(n) || 0) * 10) / 10) + '%'; }
  function elemNum(n) { return String(Math.round((Number(n) || 0) * 10) / 10); }
  function elemBeats(a, b) { return !!(WARN_COUNTERS[a] && WARN_COUNTERS[a].indexOf(b) >= 0); }

  function elemDmgPerStamina(mu) {
    return Math.round(mu.adv * ELEMENT_DMG_PER_POINT * (1 + (mu.dmgBonus || 0)));
  }

  function explainElementMatchup(mu, pElem, pRate, mElem) {
    const out = [];
    if (!pElem) out.push('You have no element (strength 0%).');
    if (mu.weak) out.push(`Your strength is \u2264${ELEMENT_WEAK_MAX}%, so you can't take the disadvantage; the monster counts as ${ELEMENT_WEAK_MONSTER_RATE}%.`);
    const pTerm = pElem
      ? `${pElem} ${elemPct(pRate)}${mu.pStrong ? ' \u00D72 (you counter it)' : ''}${mu.pBonus ? ` \u00D7${(1 + mu.pBonus).toFixed(4)}` + ` (${pElem} rate bonus +${elemPct(mu.pBonus * 100)})` : ''}`
      : '0%';
    const mTerm = `${mElem} ${elemPct(mu.mEff)}${mu.mStrong ? ' \u00D72 (it counters you)' : ''}`;
    out.push(`Advantage = ${pTerm} \u2212 ${mTerm} = ${elemNum(mu.adv)}` + (mu.disadvantaged ? ' \u2192 all damage \u221233%.' : '.'));
    const per = elemDmgPerStamina(mu);
    const wb = Number(WB_STAMINA_COST) || 1000;
    out.push(`Elemental damage = advantage \u00D7 ${fmt(ELEMENT_DMG_PER_POINT)}${mu.dmgBonus ? ` \u00D7 ${(1 + mu.dmgBonus).toFixed(4)} (elemental damage bonus +${elemPct(mu.dmgBonus * 100)})` : ''} \u00D7 stamina = ${fmt(per)} per stamina (${fmt(per * wb)} for a ${fmt(wb)}-stamina World Breaker).`);
    return out.join('\n');
  }

  // Minimum rate an element needs so that advantage >= 0 against this monster.
  // (At <=5% you are safe from the disadvantage anyway, so a threshold <=5 means "any rate".)
  function minRateToPass(e, mElem, mRate, bonus) {
    const mult = (elemBeats(e, mElem) ? 2 : 1) * (1 + elemBonusOf(bonus, e));
    const mMult = elemBeats(mElem, e) ? 2 : 1;
    return (mRate * mMult) / mult;
  }

  function buildElementWarning(gearPet) {
    const m = currentMonsterElement();
    if (m.status === 'none') return null;            // monster has no element: no icon
    if (m.status === 'unknown') {
      if (m.loading) return null;                    // still trying the page re-fetch
      return { color: 'yellow', icon: '❔', title: 'Monster element unknown',
               detail: 'Open \u201CView Monster Stats\u201D once so the monster\u2019s element can be read. This icon turns green/red by itself afterwards.' };
    }

    const known = !!(gearPet && gearPet.ratesKnown);
    const rates = (gearPet && gearPet.rates) || {};
    const own = known ? gearPet.element : null;      // your CURRENT element = your highest-rate one
    const icon = ELEMENT_EMOJI[m.element] || '⚡';

    const lines = [`Monster: ${m.element} ${elemPct(m.rate)}`];
    let color = 'yellow', title = 'Element check unavailable';

    if (!known) {
      lines.push('You: could not read your gear/pets.');
    } else {
      const mu = computeElementMatchup(own ? own.element : null, own ? own.rate : 0, m.element, m.rate, gearPet.bonus);
      color = mu.disadvantaged ? 'red' : 'green';
      title = mu.disadvantaged ? `Element disadvantage vs ${m.element}` : `Element OK vs ${m.element}`;
      lines.push(`You: ${own ? `${own.element} ${elemPct(own.rate)}` : 'no element'}`);
      const srcOwn = own && gearPet.sources && gearPet.sources[own.element];
      if (srcOwn) {
        const bits = [];
        if (srcOwn.gear) bits.push(`gear ${elemPct(srcOwn.gear)}`);
        if (srcOwn.pets) bits.push(`main pets ${elemPct(srcOwn.pets)}`);
        if (srcOwn.links) bits.push(`links ${elemPct(srcOwn.links)}`);
        if (bits.length) lines.push('Sources: ' + bits.join(' \u00B7 '));
      }
      const bsrc = gearPet.bonus && gearPet.bonus.src;
      if (bsrc && bsrc.length) {
        lines.push('Bonuses: ' + bsrc.map(b => `${b.label} +${elemPct(b.pct * 100)} (${b.pet}${b.where ? ', ' + b.where : ''})`).join(' \u00B7 '));
      }
      lines.push(explainElementMatchup(mu, own ? own.element : null, own ? own.rate : 0, m.element));
    }

    // Suggestions: the minimum rate each element needs for advantage >= 0.
    const fmtNeed = (e) => {
      const need = minRateToPass(e, m.element, m.rate, gearPet && gearPet.bonus);
      const have = rates[e] || 0;
      const cur = own && own.element === e ? ' (current)' : '';
      return `${e} ${need <= ELEMENT_WEAK_MAX ? 'any rate' : '\u2265' + elemPct(need)} (you ${elemPct(have)})${cur}`;
    };
    const counters = ELEMENT_TIE_ORDER.filter(e => elemBeats(e, m.element));
    lines.push('Counters: ' + (counters.length ? counters.map(fmtNeed).join(' \u00B7 ') : 'none known'));
    lines.push('Same element: ' + fmtNeed(m.element));
    lines.push('The element you use is your highest-rate one (gear + PvE team), so a suggested element also has to be your top element.');

    return { color, icon, title, detail: lines.join('\n') };
  }


  function getYourDamage() {
    const el = document.getElementById('yourDamageValue');
    if (!el) return null;
    const n = parseInt((el.textContent || '').replace(/[^\d]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  }

  function updateExpCapChip() {
    const capBlock = Array.from(document.querySelectorAll('.battleinfo-card .stat-block, .battleinfo-card .bm-stat-chip')).find(b => {
      const label = b.querySelector('.label');
      return label && /EXP\s*CAP/i.test(label.textContent);
    });
    const note = capBlock && capBlock.querySelector('.bm-stat-chip-note, div:not(.label)');
    if (!capBlock || !note) return;

    const capMatch = note.textContent.replace(/,/g, '').match(/(\d+)/);
    const yourDmg = getYourDamage();
    if (!capMatch || yourDmg === null) return;

    const capThreshold = parseInt(capMatch[1], 10);
    capBlock.classList.toggle('bm-cap-reached', yourDmg >= capThreshold);
  }

  function updateLootLockOverlays() {
    const yourDmg = getYourDamage();

    document.querySelectorAll('.loot-card').forEach(card => {
      const chips = Array.from(card.querySelectorAll('.loot-stats .chip'));
      const reqChip = chips.find(c => /DMG req/i.test(c.textContent));
      if (!reqChip) return;
      const req = parseInt(reqChip.textContent.replace(/[^\d]/g, ''), 10);
      if (!Number.isFinite(req)) return;

      // Any card tagged with a "Phase N" chip is phase-gated and must be judged
      // against that phase's own damage, never whole-fight total damage —
      // total can clear a later phase's requirement while the player hasn't
      // actually dealt that much damage IN that phase yet.
      const isPhaseGated = !!chips.find(c => /^phase\s*\d/i.test(c.textContent.trim()));
      const phaseChip = chips.find(c => /^phase dmg/i.test(c.textContent.trim()));
      const phaseVal = phaseChip ? parseInt(phaseChip.textContent.replace(/[^\d]/g, ''), 10) : NaN;

      const current = isPhaseGated
      ? (Number.isFinite(phaseVal) ? phaseVal : -Infinity)   // no readable phase figure -> stay locked
      : (Number.isFinite(phaseVal) ? phaseVal : (Number.isFinite(yourDmg) ? yourDmg : 0));

      const unlocked = current >= req;
      let overlay = card.querySelector(':scope > .bm-loot-lock-overlay');

      card.classList.toggle('bm-loot-card-locked', !unlocked);

      if (unlocked) {
        if (overlay) overlay.remove();
        card.querySelectorAll('.lock-badge').forEach(badge => badge.remove());
      } else if (!overlay) {
        overlay = make('div', 'bm-loot-lock-overlay', '🔒');
        card.appendChild(overlay);
      }
    });
  }

  function fmtCompactExp(n) {
    n = Number(n) || 0;
    const abs = Math.abs(n);
    if (abs >= 1e12) return (n / 1e12).toFixed(2).replace(/\.00$/, '') + 'T';
    if (abs >= 1e9)  return (n / 1e9).toFixed(2).replace(/\.00$/, '') + 'B';
    if (abs >= 1e6)  return (n / 1e6).toFixed(2).replace(/\.00$/, '') + 'M';
    if (abs >= 1e3)  return (n / 1e3).toFixed(2).replace(/\.00$/, '') + 'K';
    return fmt(n);
  }

  function findInfoChipByLabel(labelRe) {
    return Array.from(document.querySelectorAll('.battleinfo-card .stat-block, .battleinfo-card .bm-stat-chip'))
      .find(b => {
      const label = b.querySelector('.label');
      return label && labelRe.test(label.textContent);
    });
  }

  function getExpPerDmg() {
    const block = findInfoChipByLabel(/EXP\s*\/\s*DMG/i);
    const strong = block && block.querySelector('strong');
    const val = strong ? parseFloat(strong.textContent.replace(/,/g, '')) : NaN;
    return Number.isFinite(val) ? val : null;
  }

  function getExpCapDamageThreshold() {
    const capBlock = findInfoChipByLabel(/EXP\s*CAP/i);
    const note = capBlock && capBlock.querySelector('.bm-stat-chip-note, div:not(.label)');
    if (!note) return null;
    const m = note.textContent.replace(/,/g, '').match(/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }

  function ensureLootXpDrawer() {
    const lootBtn = document.getElementById('loot-button');
    const panel = lootBtn && lootBtn.closest('.bm-slain-actions');

    if (!lootBtn || !panel) {
      const stale = document.getElementById('bm-loot-xp-wrap');
      if (stale) stale.remove();
      return null;
    }

    if (!lootBtn.dataset.bmRenamed) {
      lootBtn.textContent = '🎁 Loot';
      lootBtn.dataset.bmRenamed = '1';
    }

    panel.classList.add('bm-slain-actions-anchor');

    let wrap = document.getElementById('bm-loot-xp-wrap');
    if (wrap) return { wrap, panel, lootBtn, text: document.getElementById('bm-loot-xp-text') };

    wrap = document.createElement('div');
    wrap.id = 'bm-loot-xp-wrap';

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.id = 'bm-loot-xp-trigger';
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-label', 'Toggle XP preview');

    const drawer = document.createElement('div');
    drawer.id = 'bm-loot-xp-drawer';
    const text = document.createElement('span');
    text.id = 'bm-loot-xp-text';
    drawer.appendChild(text);

    // normal column: trigger (1st child) sits on top, drawer (2nd child)
    // sits at the bottom, flush on the button. The drawer's max-height
    // transition is what physically pushes the trigger upward as it opens,
    // and drops it back down as it collapses -- no separate JS animation
    // needed, it falls straight out of the reflow.
    wrap.appendChild(trigger);
    wrap.appendChild(drawer);
    panel.appendChild(wrap);

    function setXpTriggerOpen(open) {
      wrap.classList.toggle('bm-loot-xp-open', open);
      trigger.classList.toggle('bm-loot-xp-trigger-open', open);
      trigger.setAttribute('aria-expanded', String(open));
      // Real up/down caret glyphs instead of a plain "^" character.
      trigger.innerHTML = open
        ? '<span class="bm-loot-xp-caret">&#9662;</span>'  // ▾ open -> click to drop back down
      : '<span class="bm-loot-xp-caret">&#9652;</span>'; // ▴ closed -> click to slide up
    }
    setXpTriggerOpen(false);

    trigger.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setXpTriggerOpen(!wrap.classList.contains('bm-loot-xp-open'));
    });

    document.addEventListener('click', (e) => {
      if (wrap.contains(e.target)) return;
      setXpTriggerOpen(false);
    }, true);

    return { wrap, panel, lootBtn, text };
  }

  function updateLootXpBadge() {
    const refs = ensureLootXpDrawer();
    if (!refs) return;
    const { wrap, lootBtn, text } = refs;

    const expPerDmg = getExpPerDmg();
    const yourDmg = getYourDamage();
    if (expPerDmg === null || yourDmg === null) return;

    const capThreshold = getExpCapDamageThreshold();
    const cappedDmg = capThreshold !== null ? Math.min(yourDmg, capThreshold) : yourDmg;
    const projectedExp = Math.round(cappedDmg * expPerDmg);

    text.textContent = `+${fmtCompactExp(projectedExp)} XP`;

    // lootBtn's offsetParent is now .bm-slain-actions-anchor (position:
    // relative), same as wrap's -- so offsetLeft is directly comparable.
    const left = lootBtn.offsetLeft + lootBtn.offsetWidth / 2;
    wrap.style.left = left + 'px';
  }

  async function refreshPhaseLootData(btn) {
    if (btn.dataset.busy === '1') return;
    btn.dataset.busy = '1';
    btn.disabled = true;
    btn.classList.add('bm-spinning');

    try {
      const res = await fetch(location.href, { credentials: 'same-origin', cache: 'no-store' });
      const html = await res.text();
      const freshDoc = new DOMParser().parseFromString(html, 'text/html');

      const liveSections = Array.from(document.querySelectorAll('.phase-loot-section'));
      const freshSections = Array.from(freshDoc.querySelectorAll('.phase-loot-section'));

      liveSections.forEach((liveSection, sIdx) => {
        const freshSection = freshSections[sIdx];
        if (!freshSection) return;

        const liveCards = Array.from(liveSection.querySelectorAll('.loot-card'));
        const freshCards = Array.from(freshSection.querySelectorAll('.loot-card'));

        liveCards.forEach((liveCard, cIdx) => {
          const freshCard = freshCards[cIdx];
          if (!freshCard) return;

          // Copy every chip's text (Drop / DMG req / Phase DMG / Phase N) verbatim.
          const liveChips = liveCard.querySelectorAll('.loot-stats .chip');
          const freshChips = freshCard.querySelectorAll('.loot-stats .chip');
          liveChips.forEach((liveChip, chIdx) => {
            const freshChip = freshChips[chIdx];
            if (freshChip && freshChip.textContent !== liveChip.textContent) {
              liveChip.textContent = freshChip.textContent;
            }
          });

          // Sync the server's own locked/unlocked class too, since that's
          // also baked in at render time and goes stale the same way.
          liveCard.classList.toggle('locked', freshCard.classList.contains('locked'));
          liveCard.classList.toggle('unlocked', freshCard.classList.contains('unlocked'));
        });
      });

      updateLootLockOverlays();
      showNotification('Phase loot refreshed.', 'success');
    } catch (err) {
      console.error('[BattlePage] refreshPhaseLootData failed:', err);
      showNotification('Refresh failed — try reloading the page.', 'error');
    } finally {
      btn.disabled = false;
      btn.classList.remove('bm-spinning');
      btn.dataset.busy = '0';
    }
  }

  function injectPhaseLootRefreshButtons() {
    document.querySelectorAll('.phase-loot-head').forEach(head => {
      if (head.dataset.bmRefreshDone === '1') return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bm-phase-refresh-btn';
      btn.title = 'Refresh phase damage & lock status';
      btn.textContent = '🔄';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        refreshPhaseLootData(btn);
      });
      head.classList.add('bm-phase-head-row');
      head.appendChild(btn);
      head.dataset.bmRefreshDone = '1';
    });
  }

  function buildPlayerVitals() {
    const card = document.querySelector('.player-card');
    if (!card || card.dataset.bmDone === '1') return;

    const headline = card.querySelector(':scope > .card-headline');
    const bars = Array.from(card.querySelectorAll(':scope > div')).filter(d =>
                                                                          d.querySelector(':scope > .hp-bar')
                                                                         );

    if (headline) headline.classList.add('bm-player-headline');

    if (bars.length) {
      const vitals = make('div', 'bm-player-vitals');
      bars.forEach(b => { b.classList.add('bm-vital'); vitals.appendChild(b); });
      (headline || card.firstElementChild).after(vitals);
    }

    card.dataset.bmDone = '1';
  }

  function tagHealRow() {
    const btn = document.getElementById('usePotionBtn');
    const row = btn && btn.closest('.inline-chips');
    if (!row || row.dataset.bmDone === '1') return;
    row.classList.add('bm-heal-row');
    row.dataset.bmDone = '1';
  }

  function buildInfoRow() {
    const rightCol = document.querySelector('.right-col');
    const infoCard = document.querySelector('.battleinfo-card');
    const lbPane = document.querySelector('.leaderboard-panel');
    const logPane = document.querySelector('.log-panel');
    if (!rightCol || !infoCard || !lbPane || !logPane) return;
    if (rightCol.dataset.bmInfoDone === '1') return;

    infoCard.classList.add('bm-info-pane');
    lbPane.classList.add('bm-info-pane');
    logPane.classList.add('bm-info-pane');

    rightCol.appendChild(lbPane);
    rightCol.appendChild(logPane);
    rightCol.appendChild(infoCard);

    rightCol.dataset.bmInfoDone = '1';
  }

  // =====================================================================
  // Collapsible side panels — Leaderboard / Attack Log / Battle Info /
  // Damage Ranking Rewards can each be individually collapsed down to
  // just their toggle bar. State is per-panel and persisted in
  // localStorage so it survives reloads.
  //
  // Every panel's content — element children AND bare text nodes alike —
  // lives inside one ".bm-panel-body" wrapper (see ensurePanelBody).
  // That's the fix for the Attack Log specifically: its markup is mostly
  // raw text sitting directly between <a>/<span>/<br> tags rather than
  // each line living in its own element, so a CSS rule that only sets
  // display:none on *element* siblings of the toggle button left that
  // bare text fully visible while "collapsed". Hiding one wrapper instead
  // of enumerating siblings sidesteps the issue regardless of what mix of
  // node types a panel happens to contain.
  //
  // The leaderboard/log panels get their *entire* innerHTML replaced by
  // updateLeaderboardAndLogFromData() (or the page's own
  // updateAttackSuccessUI()) after every attack, which wipes the wrapper
  // along with everything else. ensurePanelBody()/ensurePanelCollapseToggle()
  // rebuild it fresh whenever it's missing — they run on every run(), and
  // the shared MutationObserver schedules a run() shortly after any such
  // DOM rewrite, so the toggle bar reappears within ~50ms with no
  // special-casing needed.
  //
  // v14.0: the Damage Ranking Rewards panel (".ranking-rewards-panel")
  // isn't rendered on every monster — ensurePanelCollapseToggle() already
  // no-ops cleanly if its selector doesn't match anything on the page, so
  // adding it to PANEL_DEFS is enough; no extra guard code needed.
  // =====================================================================

  const PANEL_COLLAPSE_STORAGE_KEY = 'bpPanelCollapseState';

  function loadPanelCollapseState() {
    try {
      const raw = localStorage.getItem(PANEL_COLLAPSE_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (_) { return {}; }
  }

  function savePanelCollapseState(state) {
    try { localStorage.setItem(PANEL_COLLAPSE_STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
  }

  const panelCollapseState = loadPanelCollapseState();

  function isPanelCollapsed(key) {
    return !!panelCollapseState[key];
  }

  const PANEL_LABELS = {
    leaderboard: '📊 Leaderboard',
    log: '📜 Attack Log',
    battleinfo: 'ℹ️ Battle Info',
    rankingRewards: '🏆 Rewards',
  };

  const PANEL_DEFS = [
    { selector: '.leaderboard-panel', key: 'leaderboard' },
    { selector: '.log-panel', key: 'log' },
    { selector: '.battleinfo-card', key: 'battleinfo' },
    { selector: '.ranking-rewards-panel', key: 'rankingRewards' },
  ];

  function applyPanelCollapseVisuals(panel, key) {
    const collapsed = isPanelCollapsed(key);
    panel.classList.toggle('bm-panel-collapsed', collapsed);
    const btn = panel.querySelector(':scope > .bm-panel-toggle-btn');
    if (!btn) return;
    btn.setAttribute('aria-expanded', String(!collapsed));
    btn.title = collapsed ? 'Expand panel' : 'Collapse panel';
    const caret = btn.querySelector('.bm-panel-toggle-caret');
    if (caret) caret.textContent = collapsed ? '▸' : '▾';
  }

  function setPanelCollapsed(panel, key, collapsed) {
    panelCollapseState[key] = !!collapsed;
    savePanelCollapseState(panelCollapseState);
    applyPanelCollapseVisuals(panel, key);
    // v15.3: collapsing/expanding either half of the Leaderboard/Log
    // pair changes whether they should be height-matched right now —
    // see syncLbLogPairAlignment() below.
    syncLbLogPairAlignment();
  }


  const LB_MODE_STORAGE_KEY = 'bpLbDisplayMode';
  const LB_MODES = ['both', 'name', 'dmg'];
  const LB_MODE_LABELS = { both: 'ALL', name: 'Name', dmg: 'DMG' };

  function loadLbMode() {
    try {
      const raw = localStorage.getItem(LB_MODE_STORAGE_KEY);
      return LB_MODES.includes(raw) ? raw : 'both';
    } catch (_) { return 'both'; }
  }
  function saveLbMode(mode) {
    try { localStorage.setItem(LB_MODE_STORAGE_KEY, mode); } catch (_) {}
  }
  let lbDisplayMode = loadLbMode();

  function applyLbMode(panel) {
    if (!panel) return;
    panel.dataset.lbMode = lbDisplayMode;
    const btn = panel.querySelector(':scope > .bm-lb-mode-btn');
    if (btn) btn.textContent = LB_MODE_LABELS[lbDisplayMode];
  }

  function setLbMode(panel, mode) {
    lbDisplayMode = mode;
    saveLbMode(mode);
    applyLbMode(panel);
  }

  function ensureLbModeToggle(panel) {
    if (!panel) return;
    let btn = panel.querySelector(':scope > .bm-lb-mode-btn');
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bm-lb-mode-btn';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const idx = LB_MODES.indexOf(lbDisplayMode);
        setLbMode(panel, LB_MODES[(idx + 1) % LB_MODES.length]);
      });
      const collapseBtn = panel.querySelector(':scope > .bm-panel-toggle-btn');
      if (collapseBtn) collapseBtn.after(btn);
      else panel.insertBefore(btn, panel.firstChild);
    }
    applyLbMode(panel);
  }

  // Moves every current child of `panel` — element or bare text node
  // alike — into a single ".bm-panel-body" wrapper, if one doesn't
  // already exist. This is what makes collapsing reliable regardless of
  // whether a panel's markup wraps each line in an element (leaderboard,
  // battle info, ranking rewards) or mixes in raw text directly (attack log).
  function ensurePanelBody(panel) {
    let body = panel.querySelector(':scope > .bm-panel-body');
    if (body) return body;

    body = document.createElement('div');
    body.className = 'bm-panel-body';
    while (panel.firstChild) {
      body.appendChild(panel.firstChild);
    }
    panel.appendChild(body);
    return body;
  }

  function ensurePanelCollapseToggle(panel, key) {
    if (!panel) return;

    const body = ensurePanelBody(panel);

    if (!panel.querySelector(':scope > .bm-panel-toggle-btn')) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bm-panel-toggle-btn';
      btn.dataset.panelKey = key;
      btn.innerHTML =
        `<span class="bm-panel-toggle-caret">${isPanelCollapsed(key) ? '▸' : '▾'}</span>` +
        `<span class="bm-panel-toggle-label">${escapeHtml(PANEL_LABELS[key] || key)}</span>`;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setPanelCollapsed(panel, key, !isPanelCollapsed(key));
      });
      // Inserted as the FIRST child, ahead of the body wrapper, so it
      // always renders at the top and is never touched by the innerHTML
      // rewrites that only ever hit the *pre-wrap* content (which
      // ensurePanelBody immediately re-wraps on the next run()).
      panel.insertBefore(btn, body);
    }

    applyPanelCollapseVisuals(panel, key);
  }

  // v15.3: Leaderboard + Attack Log are always paired together in the
  // wide-screen 2-up grid row (see buildInfoRow — they're appended in
  // lb-then-log order, so they always land in the same row). Stretch
  // them to match each other's height, but ONLY while both are
  // expanded — see the .bm-pair-stretch CSS comment for why collapsed
  // panels are excluded from this.
  function syncLbLogPairAlignment() {
    const lb = document.querySelector('.right-col .leaderboard-panel');
    const log = document.querySelector('.right-col .log-panel');
    if (!lb || !log) return;
    const bothExpanded = !lb.classList.contains('bm-panel-collapsed') && !log.classList.contains('bm-panel-collapsed');
    lb.classList.toggle('bm-pair-stretch', bothExpanded);
    log.classList.toggle('bm-pair-stretch', bothExpanded);
  }

  // v15.3: closes the last bit of attack-time flicker called out (as a
  // known, separate issue) in the v15.2 changelog. The native game
  // replaces Leaderboard's/Log's ENTIRE innerHTML on every attack,
  // wiping our toggle-bar wrapper along with everything else in that
  // panel; the shared MutationObserver already rebuilds it, but only
  // after a 50ms debounce shared with every other DOM change on the
  // page, so the header was visibly gone for a beat after every hit. A
  // dedicated, un-debounced observer scoped to just this one element
  // rebuilds it in the same tick as the native swap instead.
  function observePanelForInstantRebuild(panel, key) {
    if (!panel || panel.dataset.bmInstantObserver === '1') return;
    const observer = new MutationObserver(() => {
      ensurePanelCollapseToggle(panel, key);
      if (key === 'leaderboard') ensureLbModeToggle(panel);
      syncLbLogPairAlignment();
    });
    observer.observe(panel, { childList: true });
    panel.dataset.bmInstantObserver = '1';
  }

  function setupPanelCollapse() {
    PANEL_DEFS.forEach(({ selector, key }) => {
      ensurePanelCollapseToggle(document.querySelector(selector), key);
    });
    ensureLbModeToggle(document.querySelector('.leaderboard-panel'));

    // v15.3: instant rebuild + height-pairing wiring for the Leaderboard/
    // Attack Log pair specifically — see observePanelForInstantRebuild()
    // and syncLbLogPairAlignment() above.
    observePanelForInstantRebuild(document.querySelector('.leaderboard-panel'), 'leaderboard');
    observePanelForInstantRebuild(document.querySelector('.log-panel'), 'log');
    syncLbLogPairAlignment();
  }

  function relocatePlayerBars() {
    const meta = document.getElementById('bm-player-meta');
    const playerCard = document.querySelector('.player-card');
    if (!meta || !playerCard) return;
    if (meta.dataset.bmDone === '1') return;

    const youEyebrow = playerCard.querySelector(':scope > .eyebrow');
    const vitals = Array.from(playerCard.querySelectorAll(':scope > .bm-player-vitals > .bm-vital'));
    const healRow = playerCard.querySelector(':scope > .bm-heal-row');

    // v14.0: "YOU" and the Heal controls no longer share one line. YOU
    // gets its own centered row; Heal gets its own row directly below,
    // right-aligned via the .bm-heal-row CSS (justify-content: flex-end).
    const metaHead = make('div', 'bm-player-meta-head');
    if (youEyebrow) metaHead.appendChild(youEyebrow);
    meta.appendChild(metaHead);

    if (healRow) meta.appendChild(healRow);

    // Player HP/MP keep their native "game original" bar — no rotation
    // into vertical pillars (that treatment belongs solely to the
    // monster's own HP bar; see buildMonsterArena).
    vitals.forEach(vital => meta.appendChild(vital));

    playerCard.remove();

    meta.dataset.bmDone = '1';
  }

  // v12.0: relocate the native "Your Damage" display to sit directly
  // under the arena (portrait + monster HP row), outside the You section
  // entirely. We only know this element by its id (#yourDamageValue,
  // already used elsewhere in this script to update the number after each
  // attack) — not the exact markup the page wraps it in — so this grabs
  // the smallest recognizable "label + value" wrapper around it (chip /
  // stat-block / stat-line row) and moves that whole block.
  function relocateDamageDisplay() {
    const slot = document.getElementById('bm-damage-display');
    const valueEl = document.getElementById('yourDamageValue');
    if (!slot || !valueEl || slot.dataset.bmDone === '1') return;

    const block = valueEl.closest('.chip, .stat-block, .inline-chips, .stat-line > div') || valueEl.parentElement || valueEl;
    slot.appendChild(block);

    slot.dataset.bmDone = '1';
  }

  function relocateFxToggle() {
    const controls = document.querySelector('.bm-arena-controls');
    const fxRow = controls && controls.querySelector('.fx-inline');
    if (!fxRow || fxRow.dataset.bmDone === '1') return;

    const btn = fxRow.querySelector('#fxToggleBtn');
    const desc = Array.from(fxRow.children).find(el => el !== btn);
    if (btn && desc) {
      btn.title = desc.textContent.trim();
      desc.remove();
    }

    fxRow.classList.add('bm-fx-corner');
    fxRow.dataset.bmDone = '1';
  }

  function findLootPanel() {
    return Array.from(document.querySelectorAll('.panel')).find(p => {
      const strong = p.querySelector(':scope > strong');
      return strong && strong.textContent.includes('Possible Loot');
    });
  }

  function organizeLootPanel() {
    const panel = findLootPanel();
    if (!panel || panel.dataset.bmDone === '1') return;
    panel.classList.add('bm-loot-panel');
    panel.dataset.bmDone = '1';
  }

  const LOOT_HIDE_LOCKED_KEY = 'bpHideLockedLoot';
  function loadHideLockedLoot() {
    try { return localStorage.getItem(LOOT_HIDE_LOCKED_KEY) === '1'; } catch (_) { return false; }
  }
  function saveHideLockedLoot(val) {
    try { localStorage.setItem(LOOT_HIDE_LOCKED_KEY, val ? '1' : '0'); } catch (_) {}
  }
  let hideLockedLoot = loadHideLockedLoot();

  function applyHideLockedLootVisual(panel) {
    panel = panel || findLootPanel();
    if (!panel) return;
    panel.classList.toggle('bm-hide-locked', hideLockedLoot);
    const btn = panel.querySelector(':scope > .bm-loot-hide-btn');
    if (btn) btn.textContent = hideLockedLoot ? '👁️ Show Locks' : '🙈 Hide Locks';
  }

  function injectLootHideToggle() {
    const panel = findLootPanel();
    if (!panel) return;

    if (panel.querySelector(':scope > .bm-loot-hide-btn')) {
      applyHideLockedLootVisual(panel);
      return;
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bm-loot-hide-btn';
    btn.textContent = hideLockedLoot ? '👁️ Show Locked' : '🙈 Hide Locked';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      hideLockedLoot = !hideLockedLoot;
      saveHideLockedLoot(hideLockedLoot);
      applyHideLockedLootVisual(panel);
    });
    panel.appendChild(btn);
    applyHideLockedLootVisual(panel);
  }

  const PHASE_ANNOUNCE_STORAGE_KEY = 'bpPhaseAnnounceVisible';
  function loadPhaseAnnounceVisible() {
    try { return localStorage.getItem(PHASE_ANNOUNCE_STORAGE_KEY) === '1'; } catch (_) { return false; }
  }
  function savePhaseAnnounceVisible(val) {
    try { localStorage.setItem(PHASE_ANNOUNCE_STORAGE_KEY, val ? '1' : '0'); } catch (_) {}
  }
  let phaseAnnounceVisible = loadPhaseAnnounceVisible(); // defaults to hidden (false)

  function applyPhaseAnnounceVisibility() {
    document.querySelectorAll('.phase-announce').forEach(el => {
      el.classList.toggle('bm-pa-visible', phaseAnnounceVisible);
    });
    const btn = document.querySelector('.bm-pa-toggle');
    if (btn) {
      btn.classList.toggle('bm-pa-toggle-active', phaseAnnounceVisible);
      btn.title = phaseAnnounceVisible ? 'Hide phase announcement' : 'Show phase announcement';
    }
  }

  function injectPhaseAnnounceToggle() {
    const arenaRow = document.querySelector('.bm-arena-row');
    if (!arenaRow) return;

    const hasAnnouncement = !!document.querySelector('.phase-announce');
    const existing = arenaRow.querySelector(':scope > .bm-pa-toggle');

    if (!hasAnnouncement) {
      if (existing) existing.remove();
      return;
    }

    if (existing) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bm-pa-toggle';
    btn.textContent = '📢';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      phaseAnnounceVisible = !phaseAnnounceVisible;
      savePhaseAnnounceVisible(phaseAnnounceVisible);
      applyPhaseAnnounceVisibility();
    });
    arenaRow.appendChild(btn);
  }

  function wrapPageColumn() {
    const grid = document.querySelector('.battle-grid');
    if (!grid || !grid.parentNode) return;

    let wrap = document.getElementById('bm-page-wrap');
    if (!wrap) {
      const backWrap = grid.previousElementSibling;
      wrap = make('div');
      wrap.id = 'bm-page-wrap';
      grid.parentNode.insertBefore(wrap, backWrap || grid);
      if (backWrap) wrap.appendChild(backWrap);
      wrap.appendChild(grid);
    }

    // v15.0: Loot used to be appended as a SIBLING after the grid (a big
    // block below everything, leaving the whole right side of the arena
    // empty on wide screens). It's now made a direct child of the grid
    // itself instead, tagged .bm-loot-col, so it can become a real 3rd
    // grid column on wide screens (see injectStyles) instead of empty
    // space there — and still just renders as a full-width block below
    // the grid on narrower screens, same as before.
    const lootPanel = findLootPanel();
    if (lootPanel) {
      lootPanel.classList.add('bm-loot-col');
      if (lootPanel.parentNode !== grid) {
        grid.appendChild(lootPanel);
      }
    }
  }

  // =====================================================================
  // v15.0: sticky bottom attack bar
  // =====================================================================
  //
  // Moves .battle-actions-buttons (Slash / AutoSlash wrapper / World
  // Breaker — whatever it currently contains) into a bar fixed to the
  // bottom of the viewport, so the attack buttons are always reachable
  // without scrolling. Looked up by class each run rather than scoped to
  // .bm-arena-controls, so this keeps working correctly on every run()
  // regardless of whether the row is still in its original spot (first
  // run) or already relocated into the bottom bar (every run after).
  function pinAttackBar() {
    const buttonsRow = document.querySelector('.battle-actions-buttons');
    if (!buttonsRow) return;

    let bar = document.getElementById('bm-bottom-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'bm-bottom-bar';
      document.body.appendChild(bar);
    }

    if (buttonsRow.parentElement !== bar) {
      buttonsRow.classList.add('bm-bottom-bar-inner');
      bar.appendChild(buttonsRow);

      // The button row's old home (.bm-arena-controls) is left with just
      // the "⚔️ Attacks" label and the FX-toggle corner once the buttons
      // move out — drop the now-redundant label and shrink the wrapper
      // down instead of leaving an empty bordered strip behind.
      const controls = document.querySelector('.bm-arena-controls');
      if (controls) {
        const label = controls.querySelector(':scope > .bm-controls-label');
        if (label) label.remove();
        controls.classList.add('bm-controls-emptied');
      }

      // v15.2: only force-measure (.offsetHeight forces a synchronous
      // layout) the first time the row actually moves in, not on every
      // run() — see the matching note in pinTopStatBar().
      document.documentElement.style.setProperty('--bm-bottom-bar-h', bar.offsetHeight + 'px');
    }
  }

  // v15.2: re-measure both sticky bars on resize/orientation-change only
  // (not on the mutation-driven run() loop — see pinTopStatBar/
  // pinAttackBar), so a breakpoint or button-row wrap change still gets
  // picked up without paying a forced-layout cost on every attack.
  function remeasureStickyBars() {
    const topBar = document.querySelector('.bm-sticky-topbar');
    if (topBar) document.documentElement.style.setProperty('--bm-topbar-h', topBar.offsetHeight + 'px');
    const bottomBar = document.getElementById('bm-bottom-bar');
    if (bottomBar) document.documentElement.style.setProperty('--bm-bottom-bar-h', bottomBar.offsetHeight + 'px');
  }

  let bottomBarCenterX = null;
  let bottomBarCenterDirty = true;

  function markBottomBarCenterDirty() { bottomBarCenterDirty = true; }

  // The bottom bar used to center on the VIEWPORT (left:50% in CSS), but
  // .battle-grid's columns aren't equal width (0.8fr/1.35fr/1fr on wide
  // screens, 1fr/1.7fr on medium), so viewport-center != monster-card
  // center -- the bar visibly drifted off from the mob. This centers it
  // on the monster card's own rect instead. Only reads layout
  // (forces a reflow) when dirty, so it's not paying that cost on every
  // attack -- just once, plus whenever markBottomBarCenterDirty() is
  // called from the resize handler.
  function alignBottomBarToMonster() {
    const bar = document.getElementById('bm-bottom-bar');
    const monsterCard = document.querySelector('.monster-card');
    if (!bar || !monsterCard) return;

    if (bottomBarCenterDirty) {
      const rect = monsterCard.getBoundingClientRect();
      if (!rect.width) return; // not laid out yet -- stays dirty, retried next run()
      bottomBarCenterX = rect.left + rect.width / 2;
      bottomBarCenterDirty = false;
    }

    if (bottomBarCenterX !== null) {
      bar.style.setProperty('left', bottomBarCenterX + 'px', 'important');
    }
  }

  // =====================================================================
  // v15.12: SCROLL-LINKED COLUMN CATCH-UP ALIGNMENT (jank-free)
  // =====================================================================
  //
  // v15.11 (sticky-based) is reverted: forcing the shorter column's grid
  // cell taller than its own content, to host a `position: sticky` inner
  // wrapper, does exactly what sticky does -- freezes content on screen
  // -- but that leaves the now-oversized cell showing real dead space
  // below its actual content for most of the scroll range (only filling
  // in once sticky "unsticks" right at the very end). Confirmed by
  // screenshot: a big blank gap under the monster-card panel well before
  // the page bottom.
  //
  // Back to a transform-based catch-up, but with the actual root cause
  // fixed this time. The earlier transform version (v15.6-v15.10)
  // recomputed grid.getBoundingClientRect() / el.offsetHeight /
  // scrollHeight on EVERY scroll-driven rAF frame. Each of those forces
  // a synchronous layout flush, and on a page that's already mutating
  // constantly (HP bars, auto-die countdown, leaderboard/log rewrites),
  // repeatedly measuring-after-invalidating is real main-thread cost
  // sitting directly in the scroll path -- enough to slip a frame behind
  // the compositor's actual scroll position. Invisible at fast scroll
  // speed (motion blur hides a frame of lag), very visible at slow,
  // deliberate scroll speed, where the eye can lock onto the offset.
  //
  // Fix: split into (a) a cheap geometry cache, recomputed ONLY when
  // run() fires (DOM mutation or resize) -- never on scroll -- and (b) a
  // scroll handler that does pure arithmetic against that cache plus the
  // already-known window.scrollY, then writes one transform. No layout
  // reads at all on the scroll path, so there is nothing left to fall
  // behind on -- the transform lands in the same frame the compositor
  // scrolls, at any scroll speed.
  // =====================================================================

  let columnAlignGeom = null; // { gridDocTop, scrollRoom, cols: [{el, gap}] }

  function getColumnCandidates() {
    return [
      document.querySelector('.right-col'),
      document.querySelector('.monster-card'),
      document.querySelector('.bm-loot-col')
    ].filter(Boolean);
  }

  function getSameRowColumns(candidates) {
    if (candidates.length < 2) return [];
    const tops = candidates.map(el => {
      let top = 0, node = el;
      while (node) { top += node.offsetTop || 0; node = node.offsetParent; }
      return top;
    });
    const sameRow = candidates.filter((_, i) => Math.abs(tops[i] - tops[0]) < 4);
    return sameRow.length >= 2 ? sameRow : [];
  }

  // Reads layout (offsetHeight / getBoundingClientRect / scrollHeight).
  // Call this ONLY from run() or the resize handler -- never from the
  // scroll path -- and cache the result for paintColumnAlign() to use.
  const SUPPORTS_SCROLL_TIMELINE =
        typeof CSS !== 'undefined' && CSS.supports && CSS.supports('animation-timeline: scroll()');

  function clearCssScrollAlign(candidates) {
    candidates.forEach(el => {
      el.classList.remove('bm-align-catchup');
      el.style.removeProperty('--bm-align-gap');
      el.style.animationRange = '';
      if (el.style.transform) el.style.transform = '';
    });
  }

  function applyCssScrollAlign(alignCols, gridDocTop, scrollRoom) {
    alignCols.forEach(({ el, gap }) => {
      el.classList.add('bm-align-catchup');
      el.style.setProperty('--bm-align-gap', gap.toFixed(1) + 'px');
      if (scrollRoom > 0) {
        el.style.animationRange = `${Math.round(gridDocTop)}px ${Math.round(gridDocTop + scrollRoom)}px`;
      } else {
        // Whole row already fits one viewport -- nothing to scroll
        // through, so just sit at the caught-up offset, no animation.
        el.classList.remove('bm-align-catchup');
        el.style.animationRange = '';
        el.style.transform = `translateY(${gap.toFixed(1)}px)`;
      }
    });
  }

  function recomputeColumnAlignGeometry() {
    const grid = document.querySelector('.battle-grid');
    const candidates = getColumnCandidates();
    const cols = getSameRowColumns(candidates);

    if (!grid || cols.length < 2) {
      clearCssScrollAlign(candidates);
      columnAlignGeom = null;
      return;
    }

    candidates.forEach(el => { if (!SUPPORTS_SCROLL_TIMELINE && el.style.transform) el.style.transform = ''; });

    const heights = cols.map(el => el.offsetHeight);
    const hMax = Math.max(...heights);
    if (hMax - Math.min(...heights) < 4) {
      clearCssScrollAlign(candidates);
      columnAlignGeom = null;
      return;
    }

    const gridDocTop = grid.getBoundingClientRect().top + window.scrollY;
    const scrollRoom = Math.max(0, hMax - window.innerHeight);

    const alignCols = cols
    .map((el, i) => ({ el, gap: hMax - heights[i] }))
    .filter(c => c.gap >= 4);

    const keep = new Set(alignCols.map(c => c.el));
    candidates.forEach(el => { if (!keep.has(el)) clearCssScrollAlign([el]); });

    if (!alignCols.length) { columnAlignGeom = null; return; }

    if (SUPPORTS_SCROLL_TIMELINE) {
      applyCssScrollAlign(alignCols, gridDocTop, scrollRoom);
      columnAlignGeom = null; // compositor handles it; JS fallback path stays idle
    } else {
      columnAlignGeom = { gridDocTop, scrollRoom, cols: alignCols };
    }
  }

  function paintColumnAlign() {
    const geom = columnAlignGeom; // null under the CSS path -- this is then a no-op
    if (!geom) return;

    let progress;
    if (geom.scrollRoom <= 0) {
      progress = 1;
    } else {
      const scrolledIntoSection = window.scrollY - geom.gridDocTop;
      progress = Math.max(0, Math.min(1, scrolledIntoSection / geom.scrollRoom));
    }

    geom.cols.forEach(({ el, gap }) => {
      el.style.willChange = 'transform';
      el.style.transform = `translateY(${(progress * gap).toFixed(1)}px)`;
    });
  }

  let columnAlignTicking = false;
  function scheduleColumnPaint() {
    if (SUPPORTS_SCROLL_TIMELINE) return; // compositor-driven, nothing to schedule
    if (columnAlignTicking) return;
    columnAlignTicking = true;
    requestAnimationFrame(() => {
      paintColumnAlign();
      columnAlignTicking = false;
    });
  }

  function initColumnCatchupAlign() {
    if (window.__bmColumnAlignInit) return;
    window.__bmColumnAlignInit = true;
    window.addEventListener('scroll', scheduleColumnPaint, { passive: true });
  }

  // =====================================================================
  // AutoSlash (integrated) — a normal flex sibling, no absolute
  // positioning, no margin-reservation hack. See CSS comments.
  // =====================================================================

  const AUTOSLASH_DAMAGE_THRESHOLD = 3000000;
  const AUTOSLASH_DEFAULT_REGULAR_DELAY_MS = 850;
  const AUTOSLASH_DEFAULT_DUNGEON_DELAY_MS = 0;

  let asBusy = false;
  let asRunning = false;
  let asLoopPromise = null;
  let asUiReady = false;
  let asAutoBtn = null;
  let asCaretBtn = null;
  let asAutoMenu = null;
  let asDelayLabel = null;

  function asGetDelayStorageKey() {
    return isDungeonBattle() ? 'autoSlashDelayMs_dungeon' : 'autoSlashDelayMs_regular';
  }

  function asGetDefaultDelay() {
    return isDungeonBattle() ? AUTOSLASH_DEFAULT_DUNGEON_DELAY_MS : AUTOSLASH_DEFAULT_REGULAR_DELAY_MS;
  }

  function asLoadSavedDelay() {
    const raw = localStorage.getItem(asGetDelayStorageKey());
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(0, n) : asGetDefaultDelay();
  }

  function asSaveDelay(ms) {
    localStorage.setItem(asGetDelayStorageKey(), String(ms));
  }

  let attackDelayMs = asLoadSavedDelay();

  function asSyncDelayMenu() {
    if (!asAutoMenu) return;
    asAutoMenu.querySelectorAll('.auto-slash-delay').forEach(btn => {
      const val = Number(btn.dataset.delay || 0);
      const pressed = val === attackDelayMs;
      btn.setAttribute('aria-pressed', String(pressed));
      const mark = btn.querySelector('.auto-slash-check');
      if (mark) mark.textContent = pressed ? '✓' : '';
    });
    if (asDelayLabel) {
      asDelayLabel.textContent = isDungeonBattle()
        ? `Dungeon delay: ${attackDelayMs}ms`
      : `Regular delay: ${attackDelayMs}ms`;
    }
  }

  function asCloseMenu() {
    if (!asAutoMenu) return;
    asAutoMenu.hidden = true;
    if (asCaretBtn) asCaretBtn.setAttribute('aria-expanded', 'false');
  }

  function asToggleMenu(force) {
    if (!asAutoMenu || !asCaretBtn) return;
    const open = typeof force === 'boolean' ? force : asAutoMenu.hidden;

    if (!open) {
      asAutoMenu.hidden = true;
      asCaretBtn.setAttribute('aria-expanded', 'false');
      return;
    }

    // v15.3: the caret lives in the v15.0 bar pinned to the bottom of
    // the viewport now, so opening the menu *downward* (the old
    // behavior) pushed it off the bottom edge of the screen. Open
    // upward instead, ending just above the caret; position:fixed +
    // viewport-relative coordinates (no scrollX/scrollY) so it doesn't
    // drift if the page is scrolled while it's open. The menu is
    // [hidden] (display:none) until measured, so it's briefly made
    // layout-visible-but-invisible to get its real height first —
    // otherwise getBoundingClientRect() would just report zero.
    asAutoMenu.hidden = false;
    asAutoMenu.style.visibility = 'hidden';
    const menuRect = asAutoMenu.getBoundingClientRect();
    const caretRect = asCaretBtn.getBoundingClientRect();

    let left = caretRect.right - menuRect.width;
    left = Math.max(8, Math.min(left, window.innerWidth - menuRect.width - 8));

    let top = caretRect.top - menuRect.height - 8;
    if (top < 8) top = caretRect.bottom + 8; // no room above either — fall back to opening down

    asAutoMenu.style.left = `${Math.round(left)}px`;
    asAutoMenu.style.top = `${Math.round(top)}px`;
    asAutoMenu.style.visibility = '';
    asCaretBtn.setAttribute('aria-expanded', 'true');
  }

  function asSetDelay(ms) {
    const n = Number(ms);
    attackDelayMs = Number.isFinite(n) ? Math.max(0, n) : asGetDefaultDelay();
    asSaveDelay(attackDelayMs);
    asSyncDelayMenu();
  }

  function asSetStatus(text) {
    if (!asAutoBtn) return;
    asAutoBtn.dataset.running = asRunning ? '1' : '0';
    const label = asAutoBtn.querySelector('.auto-slash-label');
    const dot = asAutoBtn.querySelector('.auto-slash-dot');
    if (label) label.textContent = asRunning ? 'AUTO ON' : 'AUTO';
    if (dot) dot.classList.toggle('running', asRunning);
    asAutoBtn.title = asRunning
      ? `Posion Auto Slash is running. Click to stop. Delay: ${attackDelayMs}ms`
    : `Poison Auto Slash is off. Click to start. Delay: ${attackDelayMs}ms`;
    if (text) asAutoBtn.setAttribute('data-state', text);
  }

  function asStopAutomation() {
    asRunning = false;
    asBusy = false;
    asSetStatus('idle');
    asSyncDelayMenu();
  }

  // AutoSlash clicks the page's real, native Slash button — same element
  // a manual click would hit — so the site's own handler runs start to
  // finish (request + UI update) exactly once, through exactly one path.
  // The intercepted response is only read to decide whether to keep
  // looping; this script's own bolt-on bits (EXP-cap chip, loot-lock
  // overlays) get an explicit refresh since native code doesn't know
  // about them.
  async function asSendSlashOnce() {
    if (asBusy || !asRunning) return null;

    // v12.0 fix: this used to be a *direct*-child selector
    // (".battle-actions-buttons > button..."), which only matched
    // BEFORE integrateAutoSlash() wraps the native Slash button inside
    // #autoSlashWrapper. Once wrapped, the button becomes a grandchild
    // of .battle-actions-buttons, not a direct child, so this query
    // silently returned null on every cycle and AutoSlash just looped
    // (retrying forever) without ever actually clicking anything.
    // Descendant selector (no ">") matches regardless of the wrapper.
    const slashBtn = document.querySelector('.battle-actions-buttons button.attack-btn[data-skill-id="0"]');
    if (!slashBtn || slashBtn.disabled) return { retry: true, damage: null };

    asBusy = true;

    try {
      const waiting = waitForAttackResponse('0');
      slashBtn.click();
      const result = await waiting;

      updateExpCapChip();
      updateLootLockOverlays();


      if (!result) return { retry: true, damage: null };

      const { raw, data } = result;

      if (!data) {
        const rawMsg = String(raw || '').trim();
        if (isCooldownMessage(rawMsg)) return { retry: true, damage: null };
        if (isNoStaminaMessage(rawMsg)) {
          asStopAutomation();
          return null;
        }
        return { retry: true, damage: null };
      }

      const msg = String(data.message || '').trim();

      if (isNoStaminaMessage(msg)) {
        asStopAutomation();
        return null;
      }
      if (isCooldownMessage(msg)) return { retry: true, damage: null };

      if (String(data.status).trim() !== 'success') {
        return { retry: true, damage: null };
      }

      const damage = extractDamage(data);
      if (damage === null) return { retry: true, damage: null };

      if (damage < AUTOSLASH_DAMAGE_THRESHOLD) {
        showNotification(`Damage under ${fmt(AUTOSLASH_DAMAGE_THRESHOLD)}. Stopping.`, 'error');
        asStopAutomation();
        return null;
      }

      asSetStatus(`${fmt(damage)} hit`);
      return { retry: true, damage };
    } catch (err) {
      console.error('AutoSlash cycle failed:', err);
      return { retry: true, damage: null };
    } finally {
      asBusy = false;
    }
  }

  async function asAttackLoop() {
    if (asLoopPromise) return asLoopPromise;
    asLoopPromise = (async () => {
      while (asRunning) {
        const result = await asSendSlashOnce();
        if (!asRunning) break;
        if (!result || result.retry !== true) break;
        await sleep(attackDelayMs);
      }
      asLoopPromise = null;
    })();
    return asLoopPromise;
  }

  function asStartAutomation() {
    if (asRunning) return;
    asRunning = true;
    asSetStatus('starting');
    asAttackLoop();
  }

  function integrateAutoSlash() {
    if (asUiReady) return;

    // v12.0: descendant selector here too (see asSendSlashOnce comment) —
    // harmless either way pre-wrap, but keeps both lookups consistent.
    const slashBtn = document.querySelector('.battle-actions-buttons button.attack-btn[data-skill-id="0"]');
    if (!slashBtn) return;

    if (document.getElementById('autoSlashBtn')) {
      asUiReady = true;
      return;
    }

    const wrapper = document.createElement('div');
    wrapper.id = 'autoSlashWrapper';
    slashBtn.parentNode.insertBefore(wrapper, slashBtn);
    wrapper.appendChild(slashBtn);

    asAutoBtn = document.createElement('button');
    asAutoBtn.type = 'button';
    asAutoBtn.id = 'autoSlashBtn';
    asAutoBtn.className = 'auto-slash-toggle';
    asAutoBtn.dataset.running = '0';
    asAutoBtn.innerHTML = `
      <span class="auto-slash-dot"></span>
      <span class="auto-slash-label">AUTO</span>
    `;
    asAutoBtn.title = `Auto Slash is off. Click to start. Delay: ${attackDelayMs}ms`;
    wrapper.appendChild(asAutoBtn);

    asCaretBtn = document.createElement('button');
    asCaretBtn.type = 'button';
    asCaretBtn.id = 'autoSlashCaretBtn';
    asCaretBtn.className = 'auto-slash-caret';
    asCaretBtn.setAttribute('aria-expanded', 'false');
    asCaretBtn.setAttribute('aria-haspopup', 'true');
    asCaretBtn.title = 'AutoSlash delay settings';
    asCaretBtn.textContent = '▾';
    wrapper.appendChild(asCaretBtn);

    asAutoMenu = document.createElement('div');
    asAutoMenu.id = 'autoSlashMenu';
    asAutoMenu.hidden = true;

    asDelayLabel = document.createElement('div');
    asDelayLabel.className = 'auto-slash-menu-head';
    asDelayLabel.textContent = isDungeonBattle()
      ? `Dungeon delay: ${attackDelayMs}ms`
    : `Regular delay: ${attackDelayMs}ms`;
    asAutoMenu.appendChild(asDelayLabel);

    for (const ms of [0, 650, 850, 1200, 1600]) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'auto-slash-delay';
      item.dataset.delay = String(ms);
      item.setAttribute('aria-pressed', String(ms === attackDelayMs));
      item.innerHTML = `
        <span>${ms} ms</span>
        <span class="auto-slash-check">${ms === attackDelayMs ? '✓' : ''}</span>
      `;
      item.addEventListener('click', () => {
        asSetDelay(ms);
        asCloseMenu();
      });
      asAutoMenu.appendChild(item);
    }

    const footer = document.createElement('div');
    footer.className = 'auto-slash-footer';
    footer.textContent = 'AUTO starts and stops with this button. Use the caret ▾ for delay presets.';
    asAutoMenu.appendChild(footer);

    document.body.appendChild(asAutoMenu);

    asAutoBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (asRunning) asStopAutomation(); else asStartAutomation();
    });

    asCaretBtn.addEventListener('click', (e) => {
      e.preventDefault();
      asToggleMenu();
    });

    document.addEventListener('click', (e) => {
      const insideToggle = asAutoBtn && asAutoBtn.contains(e.target);
      const insideCaret = asCaretBtn && asCaretBtn.contains(e.target);
      const insideMenu = asAutoMenu && asAutoMenu.contains(e.target);
      if (!insideToggle && !insideCaret && !insideMenu) asCloseMenu();
    }, true);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') asCloseMenu();
    }, true);

    window.addEventListener('pagehide', asStopAutomation);
    window.addEventListener('beforeunload', asStopAutomation);

    asSyncDelayMenu();
    asSetStatus('idle');
    asUiReady = true;
  }

  // Mirrors the ACTUAL computed size of a real native attack button onto
  // the Slash/AUTO/caret buttons, via inline !important — which always
  // beats any stylesheet !important regardless of selector specificity or
  // source order, so this can't lose to the site's CSS no matter how it's
  // structured.
  const AS_VERTICAL_SYNC_PROPS = ['paddingTop', 'paddingBottom', 'fontSize', 'fontWeight', 'fontFamily', 'lineHeight', 'boxSizing', 'minHeight', 'height'];
  const AS_FULL_SYNC_PROPS = AS_VERTICAL_SYNC_PROPS.concat(['paddingLeft', 'paddingRight', 'letterSpacing']);

  function asKebab(prop) {
    return prop.replace(/([A-Z])/g, '-$1').toLowerCase();
  }

  function asFindReferenceButton() {
    // Any native attack button that ISN'T one we've modified/injected.
    return Array.from(document.querySelectorAll('.battle-actions-buttons button.attack-btn'))
      .find(btn => btn.id !== 'autoSlashBtn' && btn.id !== 'autoSlashCaretBtn'
            && btn.getAttribute('data-skill-id') !== '0' && btn.id !== WB_BTN_ID);
  }

  function syncAttackButtonSizing() {
    const reference = asFindReferenceButton();
    if (!reference) return;
    const cs = getComputedStyle(reference);

    const radius = [
      cs.borderTopLeftRadius, cs.borderTopRightRadius,
      cs.borderBottomRightRadius, cs.borderBottomLeftRadius
    ].join(' ');

    const wrapper = document.getElementById('autoSlashWrapper');
    if (wrapper) {
      // cs.borderRadius (the shorthand) isn't reliably populated by
      // getComputedStyle in every engine — read the four longhand corners
      // instead, which are always guaranteed.
      wrapper.style.setProperty('border-radius', radius, 'important');
    }

    const slashBtn = document.querySelector('#autoSlashWrapper > button[data-skill-id="0"]');
    const autoBtn = document.getElementById('autoSlashBtn');
    const caretBtn = document.getElementById('autoSlashCaretBtn');

    [slashBtn, autoBtn].filter(Boolean).forEach(btn => {
      AS_FULL_SYNC_PROPS.forEach(prop => btn.style.setProperty(asKebab(prop), cs[prop], 'important'));
    });
    // Caret only gets vertical sync (height/font) so it stays a narrow
    // ~26px chevron button instead of ballooning to full pill width.
    if (caretBtn) {
      AS_VERTICAL_SYNC_PROPS.forEach(prop => caretBtn.style.setProperty(asKebab(prop), cs[prop], 'important'));
    }

    // World Breaker Slash was styled purely by its own .wb-btn CSS class
    // (different font-weight, no radius/height sync against the other
    // attack buttons) which is exactly why it never matched Slash/AUTO's
    // size and style. Only touch it when it's OUR injected fallback
    // button (id match guarantees that) -- the native WB button, when
    // present, is already a normal .attack-btn and needs no help.
    const wbBtn = document.getElementById(WB_BTN_ID);
    if (wbBtn) {
      wbBtn.style.setProperty('border-radius', radius, 'important');
      AS_FULL_SYNC_PROPS.forEach(prop => wbBtn.style.setProperty(asKebab(prop), cs[prop], 'important'));
    }
  }

  // =====================================================================
  // World Breaker Slash (integrated) — only injects a button if the
  // site's own native World Breaker button (data-skill-id="-5") is not
  // already present, so it never creates a duplicate.
  // =====================================================================

  const WB_BTN_ID = 'wb-world-breaker-btn';
  const WB_BTN_TEXT = 'World Breaker Slash (1000)';
  const WB_SKILL_ID = '-5';
  const WB_STAMINA_COST = '1000';
  const WB_COOLDOWN_MS = 800;

  function wbSetButtonBusy(btn, busy) {
    if (!btn) return;
    btn.disabled = !!busy;
    btn.textContent = busy ? 'Attacking…' : WB_BTN_TEXT;
  }

  function wbNativeButton(host) {
    const btn = host.querySelector('button[data-skill-id="-5"]');
    return (btn && btn.id !== WB_BTN_ID) ? btn : null;
  }

  async function wbSendWorldBreaker() {
    return sendAttack(WB_SKILL_ID, WB_STAMINA_COST);
  }

  function injectWorldBreakerButton() {
    const host = document.querySelector('.battle-actions-buttons');
    if (!host) return;

    // Native button already present on this monster/page — don't duplicate
    // it, and clean up our own injected button if one is lingering from a
    // previous monster where the native button wasn't unlocked yet.
    if (wbNativeButton(host)) {
      const ours = document.getElementById(WB_BTN_ID);
      if (ours) ours.remove();
      return;
    }

    if (document.getElementById(WB_BTN_ID)) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = WB_BTN_ID;
    btn.className = 'wb-btn';
    btn.textContent = WB_BTN_TEXT;

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.disabled) return;

      wbSetButtonBusy(btn, true);
      try {
        const { res, raw, data } = await wbSendWorldBreaker();
        const msg = (data && typeof data.message === 'string') ? data.message.trim() : '';

        if (data && String(data.status).trim() === 'success') {
          applyAttackSuccess(data);
          if (msg) showNotification(msg, 'success');
        } else {
          const text = msg || raw || `HTTP ${res.status}`;
          showNotification(escapeHtml(String(text).slice(0, 240)), 'error');
        }
      } catch (err) {
        console.error('World Breaker request error:', err);
        showNotification(escapeHtml(err?.message || 'Server error'), 'error');
      } finally {
        setTimeout(() => wbSetButtonBusy(btn, false), WB_COOLDOWN_MS);
      }
    });

    host.appendChild(btn);
  }

  // =====================================================================
  // Dispatch / lifecycle — a single shared MutationObserver for the whole
  // merged script. No auto-disconnect — a timed disconnect would silently
  // kill the reactive EXP-cap/loot-lock updates during long AutoSlash/
  // World Breaker sessions, which is exactly when they matter most.
  // AutoSlash also explicitly refreshes those two after every cycle (see
  // asSendSlashOnce) since it no longer runs applyAttackSuccess itself.
  // =====================================================================

  function run() {
    injectStyles();
    pinTopStatBar();
    compactBackBar();
    buildMonsterArena();
    injectPhaseAnnounceToggle();
    applyPhaseAnnounceVisibility();
    compactMonsterImage();
    relocateMonsterStatsButton();
    relocateDamageDisplay();
    mergeMonsterStatsIntoInfo();
    moveMonsterEffectNote();
    relocateJoinedChip();
    chipifyStats();
    updateExpCapChip();
    updateLootLockOverlays();
    refreshWarnings();
    buildPlayerVitals();
    tagHealRow();
    buildInfoRow();
    setupPanelCollapse();
    relocatePlayerBars();
    relocateFxToggle();
    pinSlainActionsBar();
    watchLootAndExtractModals();
    updateLootXpBadge();
    organizeLootPanel();
    injectLootHideToggle();
    injectPhaseLootRefreshButtons();
    wrapPageColumn();
    integrateAutoSlash();
    injectWorldBreakerButton();
    syncAttackButtonSizing();
    pinAttackBar();
    alignBottomBarToMonster();
    recomputeColumnAlignGeometry();
    paintColumnAlign();
  }
  let rerunTimer = null;
  function scheduleRun() {
    clearTimeout(rerunTimer);
    rerunTimer = setTimeout(run, 50);
  }

  function start() {
    const observer = new MutationObserver(scheduleRun);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    // v15.2: viewport resizes don't touch the DOM, so the MutationObserver
    // won't catch them — re-measure the sticky bars explicitly (debounced
    // so a drag-resize doesn't force layout on every intermediate frame)
    // so their offsets stay correct across breakpoint changes.
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        remeasureStickyBars();
        markBottomBarCenterDirty();
        alignBottomBarToMonster();
        recomputeColumnAlignGeometry();
        paintColumnAlign();
      }, 150);
    });
    initColumnCatchupAlign();
    run();
  }


  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();