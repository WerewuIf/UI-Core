/* ==========================================================================
 * Sidebar  (Core addon, every page that has the game's side drawer)
 *
 *  - Rebuilds the menu list in YOUR order. Items you don't want are hidden, not deleted: they stay in the options list.
 *  - Uses the game's own sidebar classes (side-nav-item / side-icon / side-label), so it follows whatever the game's CSS looks like today.
 *    The only CSS this adds is the small ⚙ button.
 *  - ⚙ in the sidebar header opens this addon's options (the same window as Addons panel > Options): tick to show, ▲ ▼ to re-order.
 *  - "Emberfall" always points at the NEWEST event the game lists, whatever it is called this season.
 *  - A menu entry the game adds later that isn't in this list is kept (at the end) instead of silently disappearing.
 *
 * Needs Core 3.18+ (Core.settings). On an older Core it still re-orders with the default order, just without the ⚙.
 * Add to addons.json:  { "id": "sidebar", "name": "Sidebar", "version": "1.0.0", "url": "addons/sidebar.js", "button": false }
 *
 * Debugging: window.__uicSidebar.render() redraws, .items() shows what was drawn.
 * ========================================================================== */
(function sidebar() {
  'use strict';

  if (window.__uicSidebar) return;

  const ID = 'sidebar';

  /* The order you asked for. `native` = the href prefix of the game's own entry (used to borrow its current label/icon and to find the newest event). */
  const ITEMS = [
    { id: 'event',        icon: '🔥', label: 'Emberfall Event',   href: '/event_page.php', event: true },
    { id: 'guild',        icon: '🏰', label: 'Guild',             href: '/guild_dash.php' },
    { id: 'battlepass',   icon: '🎟️', label: 'Battle Pass',       href: '/battle_pass.php' },
    { id: 'pvp',          icon: '⚔️', label: 'PvP',               href: '/pvp.php' },
    { id: 'artisans',     icon: '⚒️', label: 'Artisans Guild',    href: '/blacksmith.php' },
    { id: 'adventurers',  icon: '✨', label: 'Adventurers Guild', href: '/adventurers_guild.php', keepNativeLabel: true },
    { id: 'crystals',     icon: '💎', label: 'Power Crystals',    href: '/power_crystals.php' },
    { id: 'pets',         icon: '🐾', label: 'Pets',              href: '/pets.php' },
    { id: 'inventory',    icon: '🎒', label: 'Inventory',         href: '/inventory.php' },
    { id: 'merchant',     icon: '🛒', label: 'Merchant',          href: '/merchant.php' },
    { id: 'collections',  icon: '📚', label: 'Collections',       href: '/collections.php' },
    { id: 'achievements', icon: '🏆', label: 'Achievements',      href: '/achievements.php' },
    { id: 'classes',      icon: '🎓', label: 'Classes',           href: '/classes.php' },
    { id: 'shadow',       icon: '🥷', label: 'Shadow Army',       href: '/shadow_army.php' },
    // off by default (still in the options list if you want them back)
    { id: 'home',         icon: '🏠', label: 'Home',              href: '/game_dash.php',         hidden: true },
    { id: 'mail',         icon: '✉',  label: 'Mail',              href: '/game_mail.php',         hidden: true },
    { id: 'stats',        icon: '📊', label: 'Stats',             href: '/stats.php',             hidden: true },
    { id: 'browse',       icon: '⚑',  label: 'Browse Guilds',     href: '/guild_join_create.php', hidden: true },
    { id: 'blackmerchant', icon: '🕯️', label: 'Black Merchant',   href: '/black_merchant.php',    hidden: true },
  ];

  const Core = window.Core;
  const hasSettings = !!(Core && Core.settings && Core.settings.define);
  if (hasSettings) {
    Core.settings.define(ID, {
      title: 'Sidebar', icon: '☰',
      fields: [
        { key: 'items', type: 'orderlist', label: 'Menu items', help: 'Tick = shown. Use ▲ ▼ to change the order.', items: ITEMS.map(({ id, icon, label, hidden }) => ({ id, icon, label, hidden: !!hidden })) },
        { key: 'showNew', type: 'bool', label: 'Keep new game menu items', help: 'A menu entry the game adds later that is not in the list above is shown at the end.', default: true },
      ],
    });
  } else if (Core && Core.ui) console.warn('[sidebar] this Core has no Core.settings (needs 3.18+): using the default order, no options button.');

  /* --------------------------------------------------------------- helpers */
  const path = (s) => String(s || '').replace(/^[a-z]+:\/\/[^/]+/i, '').split(/[?#]/)[0].replace(/\/+$/, '').toLowerCase() || '/';
  const query = (s) => { const i = String(s || '').indexOf('?'); return i < 0 ? new URLSearchParams() : new URLSearchParams(String(s).slice(i + 1).split('#')[0]); };
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (v == null || v === false) continue; if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v); }
    kids.flat().forEach((c) => { if (c != null) n.append(c.nodeType ? c : document.createTextNode(String(c))); });
    return n;
  };
  const cfg = () => (hasSettings ? { list: Core.settings.list(ID, 'items'), showNew: Core.settings.get(ID, 'showNew') !== false } : { list: ITEMS.map((i) => Object.assign({}, i, { hidden: !!i.hidden })), showNew: true });

  /* ------------------------------------------------------------------ build */
  let drawn = [], busy = false;

  // What the game's own menu lists right now: { href, icon, label } per entry.
  function nativeEntries(nav) {
    return [...nav.querySelectorAll('a.side-nav-item')].filter((a) => !a.dataset.uic).map((a) => ({
      href: a.getAttribute('href') || '',
      icon: ((a.querySelector('.side-icon') || {}).textContent || '').trim(),
      label: ((a.querySelector('.side-label') || {}).textContent || a.textContent || '').trim(),
    }));
  }
  // Highest event=N wins ("the newest one").
  function newestEvent(native) {
    const ev = native.filter((n) => path(n.href) === '/event_page.php');
    ev.sort((a, b) => (parseInt(query(b.href).get('event'), 10) || 0) - (parseInt(query(a.href).get('event'), 10) || 0));
    return ev[0] || null;
  }

  function make(item, here) {
    const active = path(item.href) === here.path && (!item.event || query(item.href).get('event') === here.query.get('event'));
    return el('a', { class: 'side-nav-item' + (active ? ' active' : ''), href: item.href, 'data-uic': item.id },
      el('span', { class: 'side-icon' }, item.icon), el('span', { class: 'side-label' }, item.label));
  }

  function render() {
    const nav = document.querySelector('#sideDrawer .side-nav, .side-drawer .side-nav');
    if (!nav || busy) return;
    busy = true;
    try {
      // The game's own entries are read ONCE (our own are marked data-uic and skipped), then kept.
      const native = nav._uicNative || (nav._uicNative = nativeEntries(nav));
      const here = { path: path(location.pathname), query: new URLSearchParams(location.search) };
      const { list, showNew } = cfg();
      const nativeBy = new Map(native.map((n) => [path(n.href) + (path(n.href) === '/event_page.php' ? '' : ''), n]));
      const out = [], used = new Set();
      list.forEach((it) => {
        if (it.hidden) { used.add(path(it.href)); return; }
        const meta = ITEMS.find((x) => x.id === it.id) || it;
        let item = { id: it.id, icon: meta.icon, label: it.label || meta.label, href: meta.href };
        if (meta.event) {
          const ne = newestEvent(native);
          if (!ne) return;                               // no event running: nothing to show
          item = { id: it.id, icon: ne.icon || meta.icon, label: ne.label || meta.label, href: ne.href };
        } else {
          const n = nativeBy.get(path(meta.href));
          if (n && n.icon && meta.keepNativeLabel) { item.label = n.label || item.label; item.icon = n.icon || item.icon; }
          if (n && n.href) item.href = n.href;           // keep any query string the game uses
        }
        used.add(path(item.href));
        out.push(item);
      });
      if (showNew) {
        const known = new Set(ITEMS.map((i) => path(i.href)));
        const shownEvent = out.find((o) => o.id === 'event');
        native.forEach((n) => {
          const p = path(n.href);
          if (!n.href || /logout|^#/.test(n.href)) return;
          if (known.has(p) || used.has(p)) return;
          out.push({ id: 'new:' + p, icon: n.icon || '•', label: n.label || p, href: n.href });
        });
        void shownEvent;
      }
      nav.replaceChildren(...out.map((o) => make(o, here)));
      drawn = out;
    } finally { busy = false; }
  }

  function addGear() {
    if (!hasSettings) return;
    const title = document.querySelector('#sideDrawer .side-title, .side-drawer .side-title');
    if (!title || title.querySelector('.uic-side-gear')) return;
    const gear = el('button', { class: 'uic-side-gear', type: 'button', title: 'Sidebar options', 'aria-label': 'Sidebar options', onclick: (e) => { e.preventDefault(); e.stopPropagation(); Core.settings.open(ID); } }, '⚙');
    const close = title.querySelector('.side-close-btn');
    if (close) close.before(gear); else title.append(gear);
  }
  function css() {
    if (document.getElementById('uic-sidebar-css')) return;
    const s = el('style', { id: 'uic-sidebar-css' });
    s.textContent = '.uic-side-gear{margin-left:auto;margin-right:6px;background:#1e1f2c;border:1px solid #2b2d44;color:#cfd3ea;border-radius:8px;padding:3px 8px;font-size:13px;line-height:1.2;cursor:pointer}'
      + '.uic-side-gear:hover{background:#2a2c44;color:#fff}';
    (document.head || document.documentElement).appendChild(s);
  }

  /* ------------------------------------------------------------------ start */
  function start() {
    css(); addGear(); render();
    if (hasSettings) Core.settings.onChange(ID, () => render());
    // If the game redraws its menu (or our list is wiped), draw ours again. The observer ignores our own changes.
    const nav = document.querySelector('#sideDrawer .side-nav, .side-drawer .side-nav');
    if (nav) {
      let t = 0;
      new MutationObserver(() => {
        if (busy) return;
        const foreign = [...nav.children].some((c) => !c.dataset || !c.dataset.uic);
        if (!foreign) return;
        clearTimeout(t); t = setTimeout(() => { nav._uicNative = null; render(); addGear(); }, 50);
      }).observe(nav, { childList: true });
    }
    window.__uicSidebar = { render, items: () => drawn.slice() };
  }

  function boot() {
    if (document.querySelector('#sideDrawer .side-nav, .side-drawer .side-nav')) return start();
    // The drawer is not there yet (script ran very early) or this page has none: wait a little, then give up quietly.
    let tries = 0;
    const iv = setInterval(() => {
      if (document.querySelector('#sideDrawer .side-nav, .side-drawer .side-nav')) { clearInterval(iv); start(); }
      else if (++tries > 100) clearInterval(iv);
    }, 100);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true }); else boot();
})();

/* ==========================================================================
 * Pets  (Core addon, pets.php only)
 *
 *  - Every pet card (equipped and inventory) gets a line under its EXP numbers:  "Needs 91,410 EXP  ·  10 M + 3 S"  and a [Feed] button.
 *  - The treats (name, EXP each, how many you own) are read from the game's own Feed window on the page, so a new treat size
 *    or a changed value is picked up by itself. Nothing is hard-coded except a fallback if that window is missing.
 *  - Hover (or tap) the line for every way to cover the gap: each treat alone and mixes. Treats you don't own enough of are marked.
 *  - [Feed] sends the shown combo to pet_feed.php (the same request the game's Feed window makes), largest treats first, and updates
 *    the card, every other card of that pet, and your treat counts. It only feeds what you own, and asks first (switch off in Options).
 *  - The line stays right after feeding, levelling, or anything else that changes the numbers. The old version only calculated once.
 *
 * Options (Addons panel > Options): show the Feed button, ask before feeding.
 * Add to addons.json:  { "id": "pets", "name": "Pets", "version": "1.0.0", "url": "addons/pets.js", "button": false,
 *                        "match": "^/pets\\.php" }
 *
 * Debugging: window.__uicPets.treats() = what was read from the Feed window, .refresh() redraws, .last = last pet_feed.php reply.
 * ========================================================================== */
(function pets() {
  'use strict';

  if (!/\/pets\.php/i.test(location.pathname)) return;
  if (window.__uicPets) return;

  const ID = 'pets';
  const DEFAULTS = { feedButton: true, confirm: true };
  const FALLBACK = [{ id: '36', label: 'XL', exp: 100000 }, { id: '96', label: 'M', exp: 9000 }, { id: '32', label: 'S', exp: 300 }];   // only used if the Feed window is missing
  const Core = window.Core;
  const hasSettings = !!(Core && Core.settings && Core.settings.define);

  if (hasSettings) {
    Core.settings.define(ID, {
      title: 'Pets', icon: '🐾',
      fields: [
        { key: 'feedButton', type: 'bool', label: 'Show a Feed button on each pet', default: DEFAULTS.feedButton, help: 'Feeds the treats shown beside it, to reach the next level.' },
        { key: 'confirm', type: 'bool', label: 'Ask before feeding', default: DEFAULTS.confirm },
      ],
    });
  }
  const mem = Object.assign({}, DEFAULTS);
  const S = {
    get: (k) => (hasSettings ? Core.settings.get(ID, k) : mem[k]),
  };

  /* --------------------------------------------------------------- helpers */
  const NF = new Intl.NumberFormat();
  const fmt = (n) => NF.format(Math.max(0, Math.floor(Number(n) || 0)));
  const num = (t) => { const n = parseInt(String(t == null ? '' : t).replace(/[^\d-]/g, ''), 10); return Number.isFinite(n) ? n : NaN; };
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (v == null || v === false) continue; if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? '' : v); }
    kids.flat().forEach((c) => { if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c))); });
    return n;
  };
  const toast = (msg, ok) => { try { if (Core && Core.ui && Core.ui.toast) { Core.ui.toast(msg, ok !== false, 3500); return; } } catch (_) {} if (ok === false) console.warn('[pets]', msg); };
  const parseJson = (raw) => { if (Core && Core.parseJson) return Core.parseJson(raw); try { return JSON.parse(raw); } catch (_) { return null; } };
  const DBG = { last: null };

  /* ---------------------------------------------------------------- treats */
  // Read from the game's Feed window:  .card[data-item-id]  with  "+9000 EXP",  .food-qty (owned),  a .feed-btn.
  function readTreats() {
    const out = [];
    document.querySelectorAll('#petFoodModal .card[data-item-id]').forEach((card) => {
      const exp = num((/\+\s*([\d,]+)\s*EXP/i.exec(card.textContent) || [])[1]);
      if (!(exp > 0)) return;
      const nameEl = [...card.querySelectorAll('div')].find((d) => /font-weight:\s*600/.test(d.getAttribute('style') || ''));
      const name = nameEl ? nameEl.textContent.trim() : 'Treat';
      const label = (name.split(/\s+/).pop() || name).slice(0, 4);
      const qtyEl = card.querySelector('.food-qty');
      out.push({ id: card.getAttribute('data-item-id'), name, label, exp, own: qtyEl ? Math.max(0, num(qtyEl.textContent) || 0) : 0, card });
    });
    if (!out.length) return FALLBACK.map((t) => Object.assign({ name: t.label, own: Infinity, card: null, assumed: true }, t)).sort((a, b) => b.exp - a.exp);
    return out.sort((a, b) => b.exp - a.exp);
  }

  // Cover `need` EXP: largest treats as many whole times as fit, then the smallest one rounds up the rest.
  function bestCombo(need, treats) {
    const parts = []; let rem = need;
    treats.forEach((t, i) => {
      if (rem <= 0) return;
      const last = i === treats.length - 1;
      const n = last ? Math.ceil(rem / t.exp) : Math.floor(rem / t.exp);
      if (n > 0) { parts.push({ t, n }); rem -= n * t.exp; }
    });
    return parts;
  }
  const owned = (parts) => parts.every((p) => p.n <= p.t.own);
  const label = (parts) => parts.map((p) => p.n + ' ' + p.t.label).join(' + ') || '—';
  const total = (parts) => parts.reduce((s, p) => s + p.n * p.t.exp, 0);

  // Everything worth showing in the hover list, best first, no duplicates.
  function allCombos(need, treats) {
    const rows = []; const seen = new Set();
    const add = (name, parts) => { const k = label(parts); if (!parts.length || seen.has(k)) return; seen.add(k); rows.push({ name, parts }); };
    add('Least waste', bestCombo(need, treats));
    treats.forEach((t) => add(t.label + ' only', [{ t, n: Math.ceil(need / t.exp) }]));
    if (treats.length > 1) {
      const small = treats[treats.length - 1];
      treats.slice(0, -1).forEach((big) => {
        const max = Math.floor(need / big.exp); if (max < 1) return;
        const steps = []; for (let m = max; m >= 1; m--) steps.push(m);
        const pick = steps.length > 5 ? [0, 1, 2, 3, 4].map((i) => steps[Math.round(i * (steps.length - 1) / 4)]) : steps;   // keep the list short
        [...new Set(pick)].forEach((m) => add('Mix', [{ t: big, n: m }, { t: small, n: Math.ceil((need - m * big.exp) / small.exp) }].filter((p) => p.n > 0)));
      });
    }
    return rows;
  }

  /* ----------------------------------------------------------------- cards */
  const cards = () => [...document.querySelectorAll('.slot-box[data-pet-inv-id]')].filter((c) => c.querySelector('.exp-current') && c.querySelector('.exp-required'));
  const needOf = (c) => num(c.querySelector('.exp-required').textContent) - num(c.querySelector('.exp-current').textContent);
  const petName = (c) => { const img = c.querySelector('.pet-img-wrap img'); return (img && img.getAttribute('alt')) || 'this pet'; };

  let treats = [];
  function decorate(c) {
    const need = needOf(c);
    let box = c.querySelector(':scope .uic-pet-need');
    if (!(need > 0)) { if (box) box.remove(); return; }
    if (!box) {
      box = el('div', { class: 'uic-pet-need' });
      const anchor = c.querySelector('.exp-top') || c.querySelector('.exp-current').parentNode;
      anchor.insertAdjacentElement('afterend', box);
    }
    const parts = bestCombo(need, treats), ok = owned(parts);
    box.dataset.need = String(need);
    box.replaceChildren();
    const txt = el('span', { class: 'uic-pet-txt' + (ok ? '' : ' short'), title: 'Hover for every combination' }, 'Needs ', el('b', null, fmt(need)), ' EXP · ', label(parts));
    box.append(txt);
    if (S.get('feedButton')) {
      const btn = el('button', { type: 'button', class: 'uic-pet-feed', disabled: !ok, title: ok ? 'Feed ' + label(parts) + ' to ' + petName(c) : 'You do not own enough of these treats' }, 'Feed');
      btn.addEventListener('click', (e) => { e.stopPropagation(); feed(c); });
      box.append(btn);
    }
    txt.addEventListener('mouseenter', (e) => showTip(c, txt, e, false));
    txt.addEventListener('mouseleave', () => { if (!tip.pinned) hideTip(); });
    txt.addEventListener('click', (e) => { e.stopPropagation(); if (tip.pinned && tip.owner === txt) { hideTip(); } else { showTip(c, txt, e, true); } });
  }
  function refresh() { treats = readTreats(); cards().forEach(decorate); if (tip.owner && !document.contains(tip.owner)) hideTip(); }

  /* --------------------------------------------------------------- tooltip */
  const tip = { node: null, owner: null, pinned: false };
  function showTip(c, owner, ev, pin) {
    const need = needOf(c); if (!(need > 0)) return;
    if (!tip.node) { tip.node = el('div', { class: 'uic-pet-tip' }); document.body.appendChild(tip.node); }
    tip.owner = owner; tip.pinned = !!pin;
    const rows = allCombos(need, treats);
    tip.node.replaceChildren(
      el('div', { class: 'uic-pet-tip-h' }, petName(c) + ' — ', el('b', null, fmt(need) + ' EXP'), ' to next level'),
      ...rows.map((r) => {
        const ok = owned(r.parts); const over = total(r.parts) - need;
        const lack = r.parts.filter((p) => p.n > p.t.own).map((p) => (p.n - p.t.own) + ' more ' + p.t.label);
        return el('div', { class: 'uic-pet-row' + (ok ? '' : ' short') },
          el('span', { class: 'n' }, r.name), el('span', { class: 'c' }, label(r.parts)),
          el('span', { class: 'o' }, ok ? (over ? '+' + fmt(over) + ' extra' : 'exact') : 'need ' + lack.join(', ')));
      }),
      el('div', { class: 'uic-pet-tip-f' }, 'You own: ' + (treats.map((t) => fmt(t.own) + ' ' + t.label).join(' · ') || 'no treats')));
    tip.node.style.display = 'block';
    const r = owner.getBoundingClientRect(), w = tip.node.offsetWidth, h = tip.node.offsetHeight;
    let left = Math.min(Math.max(8, r.left), Math.max(8, innerWidth - w - 8));
    let top = r.bottom + 6; if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 6);
    tip.node.style.left = left + 'px'; tip.node.style.top = top + 'px';
  }
  function hideTip() { if (tip.node) tip.node.style.display = 'none'; tip.pinned = false; tip.owner = null; }

  /* --------------------------------------------------------------- feeding */
  let busy = false;
  async function feedOnce(petId, item, qty) {
    const body = new URLSearchParams({ pet_inv_id: petId, item_id: item, qty: String(qty) });
    let raw;
    try {
      const res = await fetch('pet_feed.php', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(), credentials: 'same-origin' });
      raw = await res.text();
    } catch (_) { return { ok: false, message: 'Network error' }; }
    DBG.last = raw;
    const data = parseJson(raw);
    if (!data) return { ok: false, message: 'Unreadable reply from pet_feed.php' };
    if (data.status !== 'success') return { ok: false, message: String(data.message || 'The server refused to feed') };
    return { ok: true, data, used: typeof data.qty_used === 'number' ? Math.max(1, data.qty_used) : qty };
  }
  // Same fields the game's own Feed window updates, on every card of this pet.
  function paintPet(petId, d) {
    document.querySelectorAll('.slot-box[data-pet-inv-id="' + petId + '"]').forEach((c) => {
      const set = (sel, v) => { const n = c.querySelector(sel); if (n && v != null) n.textContent = v; };
      if (typeof d.level === 'number') set('.pet-level', d.level);
      if (typeof d.attack === 'number') set('[data-attack]', d.attack);
      if (typeof d.defense === 'number') set('[data-defense]', d.defense);
      const pow = c.querySelector('[data-power]'); if (pow && typeof d.power_text === 'string') { pow.textContent = d.power_text; pow.style.display = d.power_text ? '' : 'none'; }
      if (typeof d.exp_current === 'number') set('[data-exp-current]', d.exp_current);
      if (typeof d.exp_required === 'number') set('[data-exp-required]', d.exp_required);
      const fill = c.querySelector('[data-exp-fill]'); if (fill && typeof d.exp_percent === 'number') fill.style.width = d.exp_percent + '%';
    });
  }
  function useUp(t, used) {
    if (!t.card) return;
    const q = t.card.querySelector('.food-qty'), inp = t.card.querySelector('.feed-qty');
    const left = Math.max(0, (num(q && q.textContent) || 0) - used);
    if (q) q.textContent = String(left);
    if (inp) { inp.max = String(left); if (num(inp.value) > left) inp.value = String(Math.max(1, left)); }
    if (left === 0) t.card.remove();
  }
  async function feed(c) {
    if (busy) return;
    const petId = c.getAttribute('data-pet-inv-id'), need = needOf(c);
    if (!petId || !(need > 0)) return;
    treats = readTreats();
    const parts = bestCombo(need, treats);
    if (!parts.length || !owned(parts) || parts.some((p) => p.t.assumed)) { toast('Not enough treats for ' + petName(c), false); return; }
    if (S.get('confirm') && !window.confirm('Feed ' + label(parts) + ' to ' + petName(c) + '?\n(' + fmt(total(parts)) + ' EXP for ' + fmt(need) + ' needed)')) return;
    busy = true; document.querySelectorAll('.uic-pet-feed').forEach((b) => { b.disabled = true; });
    let fed = 0, failed = '';
    for (const p of parts) {
      const r = await feedOnce(petId, p.t.id, p.n);
      if (!r.ok) { failed = r.message; break; }
      fed += r.used; useUp(p.t, r.used); paintPet(petId, r.data);
    }
    busy = false; refresh();
    if (failed) toast((fed ? 'Fed ' + fed + ', then stopped: ' : 'Could not feed: ') + failed, false);
    else toast('Fed ' + label(parts) + ' to ' + petName(c));
  }

  /* ------------------------------------------------------------------- css */
  function css() {
    if (document.getElementById('uic-pets-css')) return;
    const s = document.createElement('style'); s.id = 'uic-pets-css';
    s.textContent = `
      .uic-pet-need{display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap;margin-top:4px;font-size:12px;color:#cfd3ef}
      .uic-pet-txt{cursor:help;border-bottom:1px dotted #5a5f8f}
      .uic-pet-txt.short{color:#ffb4a8}
      .uic-pet-txt b{color:#fff}
      .uic-pet-feed{background:#2b2d52;color:#fff;border:1px solid #3a3d66;border-radius:6px;padding:3px 10px;font-size:12px;font-weight:700;cursor:pointer}
      .uic-pet-feed:hover:not(:disabled){background:#3a3e78}
      .uic-pet-feed:disabled{opacity:.4;cursor:not-allowed}
      .uic-pet-tip{position:fixed;z-index:10001;display:none;min-width:260px;max-width:min(360px,calc(100vw - 16px));background:#161827;color:#dfe3ff;border:1px solid #3a3d66;border-radius:10px;padding:10px 12px;box-shadow:0 10px 28px rgba(0,0,0,.5);font-size:12px;line-height:1.5}
      .uic-pet-tip-h{margin-bottom:6px;color:#fff}
      .uic-pet-tip-f{margin-top:6px;padding-top:6px;border-top:1px solid #2b2d44;color:#9aa3d6}
      .uic-pet-row{display:grid;grid-template-columns:92px 1fr auto;gap:8px;padding:2px 0}
      .uic-pet-row .n{color:#9aa3d6}.uic-pet-row .c{font-weight:700;color:#fff}.uic-pet-row .o{color:#90ee90;text-align:right}
      .uic-pet-row.short .c{color:#ffb4a8}.uic-pet-row.short .o{color:#ffb4a8}
    `;
    (document.head || document.documentElement).appendChild(s);
  }

  /* ----------------------------------------------------------------- start */
  function start() {
    if (document.getElementById('uic-pets-css')) return;
    css(); refresh();
    // Redraw whenever the page changes a pet's numbers, a treat count, or adds/removes cards. One pass per burst of changes.
    let t = 0; const queue = () => { clearTimeout(t); t = setTimeout(refresh, 60); };
    const root = document.querySelector('.container') || document.body;
    new MutationObserver((muts) => { if (muts.every((m) => m.target.nodeType === 1 && m.target.closest && m.target.closest('.uic-pet-need, .uic-pet-tip'))) return; queue(); })
      .observe(root, { childList: true, subtree: true, characterData: true });
    const modal = document.getElementById('petFoodModal');
    if (modal) new MutationObserver(queue).observe(modal, { childList: true, subtree: true, characterData: true });
    document.addEventListener('click', (e) => { if (tip.pinned && !(tip.node && tip.node.contains(e.target))) hideTip(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); });
    if (hasSettings) Core.settings.onChange(ID, refresh);
    window.__uicPets = { treats: () => treats.map((x) => ({ id: x.id, label: x.label, exp: x.exp, own: x.own })), refresh, get last() { return DBG.last; } };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
})();

/* ==========================================================================
 * Dungeon Attack  (Core addon, guild_dungeon_location.php only)
 *
 *  Attack from the monster list itself, without opening battle.php for every monster.
 *   - A "Quick attack" bar above the list: skill, hits per monster, [Attack selected] / [Stop], and a live status line.
 *   - A tick box on every monster, and a ⚡ Hit button next to its Fight link (hits THAT monster with the chosen skill × hits).
 *   - Joins a monster first when it says "not joined" (switch off under ⚙ Options).
 *   - Every reply updates the card (HP bar and numbers, joined / dead), the "Left:" counter and your top bar (stamina, exp).
 *   - Stops by itself when: you press Stop, stamina runs out, you die, or the server refuses. With the potion options ticked it drinks a
 *     stamina / full HP potion through Core.potions (shared with every other addon, so one potion is used, not one per addon) and carries on.
 *   - Same requests the battle page makes: POST dungeon_join_battle.php {dgmid, instance_id} and POST damage.php {instance_id, dgmid, skill_id, stamina_cost}.
 *
 * Options (Addons panel > Options, or ⚙ on the bar): skill, hits per monster, pause between hits, auto-join, potions.
 * Add to addons.json:  { "id": "dungeon-attack", "name": "Dungeon Attack", "version": "1.0.0", "url": "addons/dungeon-attack.js", "button": false,
 *                        "match": "^/guild_dungeon_location\\.php" }
 *
 * Debugging: window.__uicDungeonAttack.last = the last raw reply from damage.php.
 * ========================================================================== */
(function dungeonAttack() {
  'use strict';

  if (!/\/guild_dungeon_location\.php/i.test(location.pathname)) return;
  if (window.__uicDungeonAttack) return;

  const ID = 'dungeon-attack';
  const SKILLS = [[1, 0, 'Slash'], [10, -1, 'Power Slash'], [50, -2, 'Heroic Slash'], [100, -3, 'Ultimate Slash'], [200, -4, 'Legendary Slash'], [1000, -5, 'World Breaker Slash']];   // [stamina cost, skill_id, name]
  const DEFAULTS = { skill: 1, hits: 1, delay: 250, autoJoin: true, staminaPotion: false, hpPotion: false };
  const Core = window.Core;
  const hasSettings = !!(Core && Core.settings && Core.settings.define);

  if (hasSettings) {
    Core.settings.define(ID, {
      title: 'Dungeon Attack', icon: '⚡',
      fields: [
        { key: 'skill', type: 'select', label: 'Skill', options: SKILLS.map((s) => [s[0], s[2] + ' (' + s[0] + ' stamina)']), default: DEFAULTS.skill },
        { key: 'hits', type: 'number', label: 'Hits per monster', min: 1, max: 100000, default: DEFAULTS.hits, help: 'Stops earlier on a monster that dies.' },
        { key: 'delay', type: 'number', label: 'Pause between hits (ms)', min: 0, max: 10000, step: 50, default: DEFAULTS.delay, help: 'The game may refuse hits that come too fast.' },
        { key: 'autoJoin', type: 'bool', label: 'Join "not joined" monsters first', default: DEFAULTS.autoJoin },
        { key: 'staminaPotion', type: 'bool', label: 'Drink a stamina potion when out of stamina', default: DEFAULTS.staminaPotion, help: 'Uses items from your inventory.' },
        { key: 'hpPotion', type: 'bool', label: 'Drink a Full HP potion when dead', default: DEFAULTS.hpPotion, help: 'Uses items from your inventory.' },
      ],
    });
  }
  const mem = Object.assign({}, DEFAULTS);
  const S = {
    get: (k) => (hasSettings ? Core.settings.get(ID, k) : mem[k]),
    set: (k, v) => { if (hasSettings) Core.settings.set(ID, k, v); else mem[k] = v; },
  };

  /* --------------------------------------------------------------- helpers */
  const NF = new Intl.NumberFormat();
  const fmt = (n) => NF.format(Math.max(0, Math.floor(Number(n) || 0)));
  const compact = (n) => (Core && Core.compact ? Core.compact(n) : fmt(n));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const params = new URLSearchParams(location.search);
  const instanceId = params.get('instance_id') || '';
  const skillOf = (cost) => SKILLS.find((s) => s[0] === Number(cost)) || SKILLS[0];
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (v == null || v === false) continue; if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? '' : v); }
    kids.flat().forEach((c) => { if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c))); });
    return n;
  };
  const parseJson = (raw) => { if (Core && Core.parseJson) return Core.parseJson(raw); try { return JSON.parse(raw); } catch (_) { return null; } };
  const DBG = { last: null };

  /* ----------------------------------------------------------------- cards */
  const cards = () => [...document.querySelectorAll('.mon')].filter((c) => c.querySelector('a[href*="dgmid="]'));
  const midOf = (c) => { const a = c.querySelector('a[href*="dgmid="]'); const m = a && /[?&]dgmid=(\d+)/.exec(a.getAttribute('href')); return m ? m[1] : null; };
  const nameOf = (c) => { const box = c.querySelector('div[style*="font-weight:700"], div[style*="font-weight: 700"]'); if (!box) return 'monster'; const t = [...box.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ').replace(/\s+/g, ' ').trim(); return t || 'monster'; };
  const pills = (c) => [...c.querySelectorAll('.pill')];
  const hasPill = (c, word) => pills(c).some((p) => p.textContent.trim().toLowerCase() === word);
  const isDead = (c) => c.classList.contains('dead') || hasPill(c, 'dead') || /^\s*0\s*\/\s*[\d,]+\s*HP/i.test(hpTextEl(c) ? hpTextEl(c).textContent : '');
  const isJoined = (c) => hasPill(c, 'joined');
  const hpTextEl = (c) => [...c.querySelectorAll('.muted')].find((m) => /\bHP\b/.test(m.textContent) && /\d\s*\/\s*\d/.test(m.textContent) && !m.querySelector('a'));
  const byMid = (mid) => cards().find((c) => midOf(c) === String(mid));

  function setPill(c, text) {
    let p = pills(c).find((x) => /^(joined|not joined|dead)$/i.test(x.textContent.trim()));
    if (!p) { const row = c.querySelector('.row'); if (!row) return; p = el('span', { class: 'pill' }); row.append(p); }
    p.textContent = text;
  }
  function paintHp(c, hp) {
    if (!hp || typeof hp.value === 'undefined') return;
    const max = Number(hp.max) || 0, val = Math.max(0, Number(hp.value) || 0);
    const pct = typeof hp.percent === 'number' ? hp.percent : (max ? (val / max) * 100 : 0);
    const fill = c.querySelector('.bar .fill'); if (fill) fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
    const t = hpTextEl(c); if (t && max) t.textContent = fmt(val) + ' / ' + fmt(max) + ' HP';
  }
  function markDead(c) {
    if (isDead(c) && hasPill(c, 'dead')) return;
    c.classList.add('dead'); setPill(c, 'dead'); c.classList.add('uic-da-dead');
    const cb = c.querySelector('.uic-da-pick input'); if (cb) { cb.checked = false; cb.disabled = true; }
    const left = [...document.querySelectorAll('.pill')].find((p) => /^Left:\s*[\d,]+$/i.test(p.textContent.trim()));
    if (left) { const n = parseInt(left.textContent.replace(/[^\d]/g, ''), 10) || 0; left.textContent = 'Left: ' + Math.max(0, n - 1); }
    refreshBar();
  }

  /* -------------------------------------------------------------- requests */
  async function joinMonster(mid) {
    const body = new URLSearchParams({ dgmid: mid, instance_id: instanceId });
    const res = await fetch('dungeon_join_battle.php', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, body: body.toString(), credentials: 'same-origin' });
    const txt = (await res.text()).toLowerCase();
    DBG.lastJoin = txt;
    return txt.includes('successfully') || txt.includes('already');
  }
  // One hit. Always resolves: { kind: 'ok' | 'stamina' | 'dead_player' | 'cooldown' | 'notjoined' | 'monster_dead' | 'error', ... }
  async function hit(mid, cost) {
    const sk = skillOf(cost);
    const body = new URLSearchParams({ instance_id: instanceId, dgmid: mid, skill_id: String(sk[1]), stamina_cost: String(sk[0]) });
    let raw;
    try {
      const res = await fetch('damage.php', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, body: body.toString(), credentials: 'same-origin' });
      raw = await res.text();
    } catch (e) { return { kind: 'error', message: 'Network error' }; }
    DBG.last = raw;
    const data = parseJson(raw);
    if (!data) return { kind: 'error', message: 'Unreadable reply from damage.php', raw };
    const msg = String(data.message || '');
    const low = msg.toLowerCase();
    if (data.status === 'success') {
      const m = /You have dealt\s*<strong>([\d,]+)<\/strong>/i.exec(msg);
      return { kind: 'ok', data, damage: m ? Number(m[1].replace(/,/g, '')) : null, dead: !!(data.hp && Number(data.hp.value) <= 0) };
    }
    if (low.includes('not enough stamina')) return { kind: 'stamina', message: msg };
    if (low.includes('you are dead') || low.includes('you are defeated')) return { kind: 'dead_player', message: msg };
    if (low.includes('slow down') || low.includes('too quickly') || low.includes('cooldown')) return { kind: 'cooldown', message: msg };
    if (low.includes('not joined') || low.includes('join the battle') || low.includes('must join')) return { kind: 'notjoined', message: msg };
    if (/monster.*(dead|defeated|killed)|already (dead|defeated)/.test(low)) return { kind: 'monster_dead', message: msg };
    return { kind: 'error', message: msg || 'The server refused the attack', data };
  }

  /* ------------------------------------------------------------------- run */
  const run = { on: false, stop: false, queue: 0, done: 0, hits: 0, damage: 0, kills: 0, note: '' };
  const strip = (msg) => String(msg || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

  async function attackMonsters(mids) {
    if (run.on) return;
    const cost = Number(S.get('skill')) || 1, hits = Math.max(1, Math.floor(Number(S.get('hits')) || 1)), delay = Math.max(0, Number(S.get('delay')) || 0);
    Object.assign(run, { on: true, stop: false, queue: mids.length, done: 0, hits: 0, damage: 0, kills: 0, note: '' });
    paintStatus(); refreshBar();
    let why = '';
    outer:
    for (const mid of mids) {
      if (run.stop) { why = 'stopped'; break; }
      let c = byMid(mid);
      if (!c || isDead(c)) { run.done++; continue; }
      if (S.get('autoJoin') && !isJoined(c)) {
        run.note = 'Joining ' + nameOf(c) + '…'; paintStatus();
        let joined = false;
        try { joined = await joinMonster(mid); } catch (_) { /* below */ }
        if (!joined) { why = 'Could not join ' + nameOf(c); break; }
        setPill(c, 'joined');
      }
      let n = 0, cool = 0, retriedJoin = false, drinks = 0;
      while (n < hits) {
        if (run.stop) { why = 'stopped'; break outer; }
        c = byMid(mid);
        run.note = nameOf(c || document.body) + ' · hit ' + (n + 1) + '/' + hits; paintStatus();
        const r = await hit(mid, cost);
        if (r.kind === 'ok') {
          n++; run.hits++; if (r.damage != null) run.damage += r.damage;
          if (Core && Core.me && Core.me.fromAttack) { try { Core.me.fromAttack(r.data); } catch (_) { /* top bar only */ } }
          if (c) paintHp(c, r.data.hp);
          if (r.dead) { if (c) markDead(c); run.kills++; break; }
        } else if (r.kind === 'monster_dead') { if (c) markDead(c); break; }
        else if (r.kind === 'cooldown') { if (++cool > 6) { why = 'The game keeps saying "slow down" — raise the pause between hits'; break outer; } await sleep(700); continue; }
        else if (r.kind === 'notjoined') {
          if (retriedJoin) { why = 'Could not join ' + (c ? nameOf(c) : 'the monster'); break outer; }
          retriedJoin = true; let j = false; try { j = await joinMonster(mid); } catch (_) { /* */ }
          if (!j) { why = 'Could not join ' + (c ? nameOf(c) : 'the monster'); break outer; }
          if (c) setPill(c, 'joined'); continue;
        } else if (r.kind === 'stamina' || r.kind === 'dead_player') {
          const key = r.kind === 'stamina' ? 'staminaPotion' : 'hpPotion';
          if (S.get(key) && Core && Core.potions && drinks < 3) {
            drinks++; run.note = r.kind === 'stamina' ? 'Out of stamina — drinking a potion…' : 'You died — drinking a Full HP potion…'; paintStatus();
            let used = null; try { used = await (r.kind === 'stamina' ? Core.potions.stamina() : Core.potions.hp()); } catch (_) { /* */ }
            if (used && used.ok) { await sleep(400); continue; }
            why = (r.kind === 'stamina' ? 'Out of stamina' : 'You are dead') + ' and no potion could be used' + (used && used.reason ? ' (' + used.reason + ')' : '');
          } else why = r.kind === 'stamina' ? 'Out of stamina' : 'You are dead (heal, then press Attack again)';
          break outer;
        } else { why = strip(r.message) || 'The server refused the attack'; break outer; }
        if (n < hits && delay) await sleep(delay);
      }
      run.done++;
      if (delay && !run.stop) await sleep(delay);
    }
    run.on = false;
    run.note = (why && why !== 'stopped' ? '⚠ ' + why + ' · ' : why === 'stopped' ? 'Stopped · ' : '✔ Done · ') + fmt(run.hits) + ' hits' + (run.damage ? ', ' + compact(run.damage) + ' damage' : '') + (run.kills ? ', ' + run.kills + ' killed' : '');
    paintStatus(why && why !== 'stopped' ? 'bad' : 'ok'); refreshBar();
  }

  /* -------------------------------------------------------------------- UI */
  let bar = null, statusEl = null, attackBtn = null, stopBtn = null, skillSel = null, hitsInp = null, selCount = null;
  const picked = () => cards().filter((c) => { const cb = c.querySelector('.uic-da-pick input'); return cb && cb.checked && !isDead(c); });

  function paintStatus(tone) {
    if (!statusEl) return;
    statusEl.className = 'uic-da-status' + (tone ? ' ' + tone : '');
    statusEl.textContent = run.on ? '⏳ ' + run.note + ' · monster ' + Math.min(run.done + 1, run.queue) + '/' + run.queue + ' · ' + fmt(run.hits) + ' hits' + (run.damage ? ' · ' + compact(run.damage) : '') : run.note;
  }
  function refreshBar() {
    if (!bar) return;
    const n = picked().length;
    if (selCount) selCount.textContent = String(n);
    attackBtn.disabled = run.on || n === 0;
    stopBtn.disabled = !run.on;
    document.querySelectorAll('.uic-da-hit').forEach((b) => { b.disabled = run.on; });
  }
  function syncControls() { if (skillSel) skillSel.value = String(S.get('skill')); if (hitsInp) hitsInp.value = String(S.get('hits')); }

  function decorateCard(c) {
    if (c.dataset.uicDa) return;
    const mid = midOf(c); if (!mid) return;
    c.dataset.uicDa = '1';
    const dead = isDead(c);
    const cb = el('input', { type: 'checkbox', title: 'Select for Attack selected' }); cb.disabled = dead;
    cb.addEventListener('change', refreshBar);
    c.insertBefore(el('label', { class: 'uic-da-pick' }, cb), c.firstChild);
    const fight = c.querySelector('a[href*="dgmid="]');
    const btn = el('button', { class: 'uic-da-hit', type: 'button', title: 'Attack this monster with the chosen skill', onclick: (e) => { e.preventDefault(); attackMonsters([mid]); } }, '⚡ Hit');
    if (dead) { btn.disabled = true; c.classList.add('uic-da-dead'); }
    if (fight && fight.parentNode) fight.after(btn); else c.append(btn);
  }
  function selectWhere(fn) { cards().forEach((c) => { const cb = c.querySelector('.uic-da-pick input'); if (cb) cb.checked = !cb.disabled && !isDead(c) && fn(c); }); refreshBar(); }

  function build() {
    const list = cards();
    if (!list.length) return false;
    const first = list[0].closest('.panel') || list[0].parentNode;
    skillSel = el('select', { class: 'uic-da-in', title: 'Skill' }, SKILLS.map((s) => el('option', { value: String(s[0]) }, s[2] + ' · ' + s[0])));
    skillSel.addEventListener('change', () => S.set('skill', Number(skillSel.value)));
    hitsInp = el('input', { class: 'uic-da-in uic-da-num', type: 'number', min: '1', max: '100000', title: 'Hits per monster' });
    hitsInp.addEventListener('change', () => { const n = Math.max(1, Math.floor(Number(hitsInp.value) || 1)); hitsInp.value = String(n); S.set('hits', n); });
    selCount = el('b', null, '0');
    attackBtn = el('button', { class: 'uic-da-go', type: 'button', onclick: () => attackMonsters(picked().map(midOf)) }, '⚡ Attack selected (', selCount, ')');
    stopBtn = el('button', { class: 'uic-da-stop', type: 'button', onclick: () => { run.stop = true; run.note = 'Stopping after this hit…'; paintStatus(); } }, '■ Stop');
    statusEl = el('div', { class: 'uic-da-status' });
    const link = (t, fn) => el('button', { class: 'uic-da-link', type: 'button', onclick: fn }, t);
    bar = el('div', { class: 'panel uic-da' },
      el('div', { class: 'uic-da-row' }, el('span', { class: 'uic-da-title' }, '⚡ Quick attack'), skillSel, el('span', { class: 'uic-da-x' }, '×'), hitsInp, el('span', { class: 'uic-da-dim' }, 'hits each'),
        hasSettings ? el('button', { class: 'uic-da-gear', type: 'button', title: 'Options', onclick: () => Core.settings.open(ID) }, '⚙') : null),
      el('div', { class: 'uic-da-row' }, attackBtn, stopBtn, el('span', { class: 'uic-da-dim' }, 'Select:'),
        link('all alive', () => selectWhere(() => true)), link('not joined', () => selectWhere((c) => !isJoined(c))), link('joined', () => selectWhere((c) => isJoined(c))), link('none', () => selectWhere(() => false))),
      statusEl);
    first.parentNode.insertBefore(bar, first);
    list.forEach(decorateCard);
    syncControls(); refreshBar();
    return true;
  }
  function css() {
    const s = el('style', { id: 'uic-da-css' });
    s.textContent = `
      .uic-da{display:flex;flex-direction:column;gap:8px}
      .uic-da-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
      .uic-da-title{font-weight:800;margin-right:6px}
      .uic-da-dim{color:#9aa0b8;font-size:12px}
      .uic-da-x{color:#9aa0b8}
      .uic-da-in{background:#0f1020;border:1px solid #232437;border-radius:8px;color:#f1f1ff;padding:7px 9px;font-size:13px}
      .uic-da-num{width:84px}
      .uic-da-go,.uic-da-stop,.uic-da-hit,.uic-da-gear{border:none;border-radius:9px;cursor:pointer;font-weight:800;font-size:13px;color:#fff}
      .uic-da-go{background:linear-gradient(135deg,#5562ff,#7b4dff);padding:8px 14px}
      .uic-da-stop{background:#7b3040;padding:8px 12px}
      .uic-da-hit{background:#2b2d52;margin-left:8px;padding:5px 10px;border:1px solid #3a3d66}
      .uic-da-gear{background:#222d49;padding:6px 9px;margin-left:auto}
      .uic-da button:disabled,.uic-da-hit:disabled{opacity:.4;cursor:not-allowed}
      .uic-da-link{background:none;border:none;color:#8fa6ff;cursor:pointer;font-size:12px;font-weight:700;padding:2px 4px}
      .uic-da-link:hover{text-decoration:underline}
      .uic-da-status{min-height:18px;font-size:12px;color:#cfd3ea}
      .uic-da-status.ok{color:#90ee90}.uic-da-status.bad{color:#ff8a80}
      .uic-da-pick{display:flex;align-items:flex-start;padding:2px 8px 0 0}
      .uic-da-pick input{width:18px;height:18px;cursor:pointer;accent-color:#6f75ff}
      .mon.uic-da-dead{opacity:.55}
    `;
    (document.head || document.documentElement).appendChild(s);
  }

  /* ----------------------------------------------------------------- start */
  function start() {
    if (document.getElementById('uic-da-css')) return;
    css();
    if (!build()) return;
    // Rows the page adds later (or redraws) get their controls too.
    const host = cards()[0] && cards()[0].parentNode;
    if (host) new MutationObserver(() => { cards().forEach(decorateCard); refreshBar(); }).observe(host, { childList: true });
    if (hasSettings) Core.settings.onChange(ID, syncControls);
    window.addEventListener('beforeunload', () => { run.stop = true; });
    window.__uicDungeonAttack = { run, get last() { return DBG.last; }, attack: attackMonsters, build };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
})();


/* ==========================================================================
 * Artisans Guild  (UI Cleanup module: blacksmith.php, legendary_forge.php, legendary_decraft.php)
 *
 *  Two tabs, same look as the Merchant rework:
 *    Craft      recipes from the Blacksmith, with a Grakthar / Olympus / Events switch
 *    Legendary  Upgrade (Legendary Forge) and Decraft, switched inside the tab
 *
 *  - Click a tile to open a dialog: quantity, quick chips, Max, what it will use, one button.
 *  - Craft and Upgrade keep going until the count is done, you press Stop, or something runs out.
 *    Every request updates the materials on screen from the server's reply. No page reloads, no alert().
 *  - Max is worked out from your materials (and gold for upgrades). Decraft always keeps 1 copy.
 *  - "Decraft spares" lists everything with 2+ copies; nothing is ticked until you tick it.
 *  - All three pages show the same view; the URL only decides which tab opens first.
 *
 * Self-contained. Append to the end of addons/ui-cleanup.js, or load as its own addon with
 *   "match": "^/(blacksmith|legendary_forge|legendary_decraft)\\.php"
 *
 * Debugging: after any action, window.__uicArtisans.last holds the raw server reply
 * (status, url, first 1500 characters). Paste that if a craft misbehaves.
 * ========================================================================== */
(function artisansGuild() {
  'use strict';

  const PATH = (location.pathname.match(/([a-z_]+)\.php/i) || [])[1] || '';
  if (!/^(blacksmith|legendary_forge|legendary_decraft)$/i.test(PATH)) return;
  if (window.__uicArtisans) return;

  /* ---------------------------------------------------------------- config */
  const CFG = {
    craftDelayMs: 150,
    upgradeDelayMs: 250,
    prefsKey: 'uic_artisans_prefs',
    gates: [                     // used only if the page's own gate menu can't be read
      { gate: '3', label: 'Grakthar' },
      { gate: '5', label: 'Olympus' },
      { gate: '0', label: 'Events' },
    ],
  };
  const URL_CRAFT = 'blacksmith.php';
  const URL_FORGE = 'legendary_forge.php';
  const URL_DECRAFT = 'legendary_decraft.php';

  /* --------------------------------------------------------------- helpers */
  const NF = new Intl.NumberFormat();
  const fmt = (n) => NF.format(Math.max(0, Math.floor(Number(n) || 0)));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const num = (s) => parseInt(String(s ?? '').replace(/[^\d-]/g, ''), 10) || 0;
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  function fixText(s) {
    return String(s || '')
      .replace(/â€™/g, '’').replace(/â€˜/g, '‘')
      .replace(/â€œ/g, '“').replace(/â€\u009d/g, '”')
      .replace(/â€“/g, '–').replace(/â€”/g, '—')
      .replace(/â€¦/g, '…').replace(/Â/g, '');
  }
  const txt = (el) => fixText(norm(el && el.textContent));

  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return e;
  }

  const prefs = (() => {
    const d = { tab: '', mode: 'upgrade', gate: '', sort: {}, only: {} };
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(CFG.prefsKey) || '{}') || {}; } catch (_) {}
    Object.assign(d, saved);
    // Older versions kept one shared sort string; sort and "only…" are now remembered per view.
    if (!d.sort || typeof d.sort !== 'object') d.sort = {};
    if (!d.only || typeof d.only !== 'object') d.only = {};
    return d;
  })();
  const viewKey = () => (S.tab === 'craft' ? 'craft' : S.mode);
  const getSort = () => prefs.sort[viewKey()] || 'default';
  const getOnly = () => !!prefs.only[viewKey()];
  const savePrefs = () => { try { localStorage.setItem(CFG.prefsKey, JSON.stringify(prefs)); } catch (_) {} };

  function toast(msg, ok = true) {
    try {
      if (typeof Core !== 'undefined' && Core.ui && Core.ui.toast) { Core.ui.toast(msg, ok, 3500); return; }
    } catch (_) {}
    const t = h('div', { class: 'uag-toast' + (ok ? '' : ' is-bad'), role: 'status', text: msg });
    document.body.append(t);
    setTimeout(() => t.remove(), 3500);
  }

  /* ----------------------------------------------------------------- state */
  const S = {
    tab: 'craft',                // craft | legendary
    mode: 'upgrade',             // upgrade | decraft (inside the Legendary tab)
    gate: '3',
    gates: CFG.gates.slice(),
    craft: {},                   // gate -> { recipes, stale }
    forge: null,                 // { items, csrf, stale }
    decraft: null,               // { items, stale }
    gold: 0,
    goldExact: false,
    query: '',
    busy: false,
    err: '',
  };
  const DBG = { last: null };
  window.__uicArtisans = { S, get last() { return DBG.last; } };

  /* --------------------------------------------------------------- parsing */
  function qtyPair(s) {
    const m = /(-?[\d,]+)\s*\/\s*([\d,]+)/.exec(s || '');
    return m ? [num(m[1]), num(m[2])] : [0, 0];
  }

  function parseMats(nodes, qtySel) {
    return [...nodes].map((n) => {
      const [have, need] = qtyPair(n.querySelector(qtySel)?.textContent);
      const img = n.querySelector('img');
      return {
        name: fixText(n.getAttribute('title') || img?.getAttribute('alt') || ''),
        img: img?.getAttribute('src') || '',
        have, need,
      };
    });
  }

  const canMake = (mats) => {
    const per = mats.filter((m) => m.need > 0).map((m) => Math.floor(m.have / m.need));
    return per.length ? Math.min(...per) : 0;
  };

  function parseGates(root) {
    const tabs = [...root.querySelectorAll('.gate-menu .gate-tab')];
    const gates = tabs.map((a) => {
      const g = /[?&]gate=(\d+)/.exec(a.getAttribute('href') || '');
      return g ? { gate: g[1], label: txt(a.querySelector('span')) || 'Gate ' + g[1], count: num(a.querySelector('.gate-count')?.textContent) } : null;
    }).filter(Boolean);
    const active = tabs.find((a) => a.classList.contains('active'));
    const ag = active && /[?&]gate=(\d+)/.exec(active.getAttribute('href') || '');
    return { gates, active: ag ? ag[1] : null };
  }

  function parseCraft(root) {
    return [...root.querySelectorAll('.recipe-grid .card')].map((card) => {
      const id = card.querySelector('input[name="recipe_id"]')?.value;
      if (!id) return null;
      const info = card.querySelector('.info-btn');
      const d = (k) => fixText(info?.getAttribute('data-' + k) || '');
      const el = d('element');
      const rec = {
        id,
        name: txt(card.querySelector('.result-name')) || d('name'),
        img: card.querySelector('.result-img')?.getAttribute('src') || d('img'),
        atk: num(card.querySelector('.result-attack')?.textContent),
        def: num(card.querySelector('.result-defense')?.textContent),
        legendary: !!card.querySelector('.legendary-badge') || card.classList.contains('legendary'),
        desc: d('desc'),
        power: d('power'),
        element: el && el !== 'NONE' ? `${el}${d('elementrate') && d('elementrate') !== '0' ? ' ' + d('elementrate') + '%' : ''}` : '',
        reqs: parseMats(card.querySelectorAll('.reqs .req'), '.qty'),
      };
      rec.max = canMake(rec.reqs);
      return rec;
    }).filter(Boolean);
  }

  function parseForge(root) {
    const items = [...root.querySelectorAll('.cardWrap')].map((w, i) => {
      const card = w.querySelector('.card');
      if (!card) return null;
      const btn = w.querySelector('button.upgrade');
      const m = /upgrade\(\s*(\d+)\s*,\s*(\d+)/.exec(btn?.getAttribute('onclick') || '');
      const stats = txt(card.querySelector('.stats'));
      const badge = txt(w.querySelector('.badge'));
      const mats = parseMats(card.querySelectorAll('.matRow .mat'), '.qty');
      const goldNeed = num((/Requires:\s*([\d,]+)/i.exec(txt(card.querySelector('.gold'))) || [])[1]);
      const it = {
        key: m ? m[1] : 'x' + i,
        invId: m ? m[1] : '',
        exp: m ? m[2] : '',
        name: txt(card.querySelector('.name')),
        img: card.querySelector('.img')?.getAttribute('src') || '',
        badge: badge || 'Legendary',
        mythical: card.classList.contains('mythicalGlow') || /myth/i.test(badge),
        level: num((/Lv\s*(\d+)/i.exec(stats) || [])[1]),
        atk: num((/([\d,]+)\s*ATK/i.exec(stats) || [])[1]),
        def: num((/([\d,]+)\s*DEF/i.exec(stats) || [])[1]),
        power: txt(card.querySelector('.power')).replace(/^⚡\s*/, ''),
        nextTitle: txt(card.querySelector('.nextTitle')),
        deltas: [...card.querySelectorAll('.nextStats .delta')].map((x) => txt(x)),
        mats, goldNeed,
        canUpgrade: !!btn && !btn.disabled && !!m,
        hint: txt(card.querySelector('.hint')),
      };
      Object.defineProperty(it, 'levels', { get() { return this.canUpgrade ? upgradeLevels(this) : 0; }, enumerable: true });
      return it;
    }).filter(Boolean);

    let csrf = '';
    for (const s of root.querySelectorAll('script')) {
      const c = /UPGRADE_CSRF\s*=\s*["']([^"']+)["']/.exec(s.textContent || '');
      if (c) { csrf = c[1]; break; }
    }
    const goldEl = root.querySelector('.topbar-ctl .mini strong');
    return { items, csrf, gold: goldEl ? num(goldEl.textContent) : null };
  }

  function parseDecraft(root) {
    return [...root.querySelectorAll('.card')].map((card) => {
      const sel = card.querySelector('.decraft-qty');
      const id = sel?.getAttribute('data-item-id');
      if (!id) return null;
      const have = num(card.querySelector(`[id="have-${id}"]`)?.textContent);
      const meta = txt(card.querySelector('.meta'));
      return {
        id,
        name: txt(card.querySelector('.name')),
        img: card.querySelector('.img')?.getAttribute('src') || '',
        badge: txt(card.querySelector('.legendary-badge')) || 'Legendary',
        atk: num((/ATK:\s*([\d,]+)/i.exec(meta) || [])[1]),
        def: num((/DEF:\s*([\d,]+)/i.exec(meta) || [])[1]),
        have,
        max: Math.max(0, have - 1),
      };
    }).filter(Boolean);
  }

  /* ------------------------------------------------------------------- net */
  async function getDoc(url) {
    const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) throw new Error(`The server replied ${res.status}.`);
    const html = await res.text();
    if (res.url && /login|signin/i.test(res.url) && !/blacksmith|legendary/i.test(res.url)) throw new Error('You are signed out. Reload the page and sign in again.');
    return new DOMParser().parseFromString(html, 'text/html');
  }

  const isLive = (path) => PATH.toLowerCase() === path;

  function applyGate(g, doc) {
    const pg = parseGates(doc);
    if (pg.gates.length) S.gates = pg.gates;
    S.craft[g] = { recipes: parseCraft(doc), stale: false };
    return S.craft[g];
  }

  async function loadGate(g, force) {
    const cur = S.craft[g];
    if (cur && !cur.stale && !force) return cur;
    const doc = (isLive('blacksmith') && !force && !cur && String(g) === liveGate()) ? document : await getDoc(`${URL_CRAFT}?gate=${g}`);
    return applyGate(g, doc);
  }

  function liveGate() {
    const a = parseGates(document).active;
    return a || CFG.gates[0].gate;
  }

  function applyForge(doc) {
    const f = parseForge(doc);
    const cap = Math.max(0, ...f.items.filter((x) => !x.canUpgrade && !x.mythical && x.level > 1).map((x) => x.level));
    S.forge = { items: f.items, cap, csrf: f.csrf || (S.forge && S.forge.csrf) || '', stale: false };
    if (f.gold != null) { S.gold = f.gold; S.goldExact = true; showGold(); }
    return S.forge;
  }

  async function loadForge(force) {
    if (S.forge && !S.forge.stale && !force) return S.forge;
    return applyForge(isLive('legendary_forge') && !force && !S.forge ? document : await getDoc(URL_FORGE));
  }

  async function loadDecraft(force) {
    if (S.decraft && !S.decraft.stale && !force) return S.decraft;
    const doc = isLive('legendary_decraft') && !force && !S.decraft ? document : await getDoc(URL_DECRAFT);
    S.decraft = { items: parseDecraft(doc), stale: false };
    return S.decraft;
  }

  // After any successful action the other lists may be out of date. They reload when next shown.
  function markStale(except) {
    for (const k of Object.keys(S.craft)) if (k !== except) S.craft[k].stale = true;
    if (except !== 'forge' && S.forge) S.forge.stale = true;
    if (except !== 'decraft' && S.decraft) S.decraft.stale = true;
  }

  /* ------------------------------------------------------------------ gold */
  function readTopbarGold() {
    for (const stat of document.querySelectorAll('.gtb-stat')) {
      if (txt(stat.querySelector('.gtb-label')).toLowerCase() === 'gold') {
        const v = stat.querySelector('.gtb-value');
        if (!v) continue;
        const raw = v.dataset && v.dataset.value;
        if (raw && Number.isFinite(Number(raw))) return { n: Number(raw), exact: true };
        const t = norm(v.textContent);
        const m = /^([\d.,]+)\s*([kmbt]?)$/i.exec(t);
        if (m) {
          const mult = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[m[2].toLowerCase()] || 1;
          return { n: Math.round(parseFloat(m[1].replace(/,/g, '')) * mult), exact: !m[2] };
        }
      }
    }
    return null;
  }

  function showGold() {
    const v = fmt(S.gold);
    document.querySelectorAll('.gtb-stat').forEach((stat) => {
      if (txt(stat.querySelector('.gtb-label')).toLowerCase() === 'gold') {
        const el = stat.querySelector('.gtb-value');
        if (el) { if (el.dataset) el.dataset.value = String(S.gold); el.textContent = v; }
      }
    });
    const chip = document.getElementById('goldBalance'); if (chip) chip.textContent = v;
    const mini = document.querySelector('.topbar-ctl .mini strong'); if (mini) mini.textContent = v;
    document.querySelectorAll('.side-chip').forEach((c) => {
      if (c.textContent.includes('🪙')) { const s = c.querySelector('span:last-child'); if (s) s.textContent = v; }
    });
  }

  function spendGold(n) { S.gold = Math.max(0, S.gold - n); showGold(); }

  function initGold() {
    const t = readTopbarGold();
    if (t) { S.gold = t.n; S.goldExact = t.exact; }
    const mini = document.querySelector('.topbar-ctl .mini strong');
    if (mini) { S.gold = num(mini.textContent); S.goldExact = true; }
  }

  /* ----------------------------------------------------------- action runs */
  // Runs step(i) up to `count` times. A step returns { ok, msg, stop }.
  // The run ends when a step fails, a step asks to stop, Stop is pressed, or the count is reached.
  function runBatch({ count, delay, step, onTick }) {
    const ctl = { stop: false, done: 0, fail: '', note: '' };
    ctl.promise = (async () => {
      for (let i = 0; i < count && !ctl.stop; i++) {
        let r;
        try { r = await step(i); } catch (e) { r = { ok: false, msg: (e && e.message) || 'Network error.', stop: true }; }
        if (r.ok) ctl.done++;
        else ctl.fail = r.msg || 'The server refused that request.';
        if (r.note) ctl.note = r.note;
        if (onTick) onTick(ctl.done, count);
        if (!r.ok || r.stop) break;
        if (i < count - 1 && !ctl.stop) await sleep(delay);
      }
      return ctl;
    })();
    return ctl;
  }

  /* ----- craft */
  const findRec = (g, id) => (S.craft[g]?.recipes || []).find((r) => r.id === id);

  async function craftOnce(g, id) {
    const rec = findRec(g, id);
    if (!rec) return { ok: false, msg: 'That recipe is no longer listed.', stop: true };
    if (canMake(rec.reqs) < 1) return { ok: false, msg: 'Not enough materials for another craft.', stop: true };
    const before = rec.reqs.map((r) => r.have);

    let res, text;
    try {
      res = await fetch('craft_item.php', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ recipe_id: id }),
      });
      text = await res.text();
    } catch (_) {
      return { ok: false, msg: 'Network error. Nothing was crafted.', stop: true };
    }
    DBG.last = { action: 'craft', status: res.status, url: res.url, redirected: res.redirected, body: text.slice(0, 1500) };
    if (!res.ok) return { ok: false, msg: `The server replied ${res.status}.`, stop: true };

    const t = text.trim();
    if (t[0] === '{') {                                   // a JSON reply
      let j = null; try { j = JSON.parse(t); } catch (_) {}
      if (j) {
        const ok = j.ok === true || j.success === true || j.status === 'success';
        if (!ok) return { ok: false, msg: j.message || j.error || 'The forge refused that craft.', stop: true };
        rec.reqs.forEach((r) => { r.have = Math.max(0, r.have - r.need); });
        rec.max = canMake(rec.reqs);
        return { ok: true };
      }
    }

    // An HTML reply: the page the server sent back already shows the new materials.
    const doc = new DOMParser().parseFromString(text, 'text/html');
    if (doc.querySelector('input[type="password"]')) return { ok: false, msg: 'You are signed out. Reload the page and sign in again.', stop: true };
    const shown = parseGates(doc).active;
    if (doc.querySelector('.recipe-grid .card') && (!shown || shown === g)) applyGate(g, doc);
    else {
      if (doc.querySelector('.recipe-grid .card') && shown) applyGate(shown, doc);
      try { await loadGate(g, true); } catch (e) { return { ok: false, msg: e.message, stop: true }; }
    }
    const after = findRec(g, id);
    if (!after) return { ok: true };
    return after.reqs.some((r, i) => r.have < before[i])
      ? { ok: true }
      : { ok: false, msg: 'No materials were used, so the server did not craft it.', stop: true };
  }

  /* ----- upgrade */
  function upgradeLevels(it) {
    const per = it.mats.filter((m) => m.need > 0).map((m) => Math.floor(m.have / m.need));
    if (it.goldNeed > 0 && S.goldExact) per.push(Math.floor(S.gold / it.goldNeed));
    // Legendary items stop at a level cap the page never states. It is read off the items that have no
    // Upgrade button (the highest level among those). If the game raises the cap, those items get a
    // button again, the number below drops out, and nothing is capped until the page shows a new one.
    const cap = S.forge && S.forge.cap;
    if (cap && !it.mythical) per.push(Math.max(0, cap - it.level));
    return per.length ? Math.min(...per) : 0;
  }

  async function upgradeOnce(key) {
    const f = S.forge;
    const it = f && f.items.find((x) => x.key === key);
    if (!it || !it.canUpgrade) return { ok: false, msg: 'This item cannot be upgraded any further.', stop: true };
    if (!f.csrf) return { ok: false, msg: 'Could not read the forge security token. Reload the page.', stop: true };
    const lv = it.level, goldNeed = it.goldNeed;

    let res, text;
    try {
      res = await fetch('legendary_upgrade.php', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ inv_id: it.invId, expected_level: it.exp, csrf_token: f.csrf }),
      });
      text = await res.text();
    } catch (_) {
      return { ok: false, msg: 'Network error. Nothing was upgraded.', stop: true };
    }
    DBG.last = { action: 'upgrade', status: res.status, url: res.url, redirected: res.redirected, body: text.slice(0, 1500) };
    let j = null; try { j = JSON.parse(text); } catch (_) {}
    if (!j) return { ok: false, msg: `Unexpected reply from the forge (status ${res.status}).`, stop: true };
    if (j.status !== 'success') return { ok: false, msg: j.message || 'The upgrade was refused.', stop: true };

    if (goldNeed) spendGold(goldNeed);
    try { applyForge(await getDoc(URL_FORGE)); } catch (_) { /* the next step reports it */ }
    markStale('forge');
    const next = S.forge.items.find((x) => x.key === key) || S.forge.items.find((x) => x.name === it.name && x.level > lv);
    if (!next) return { ok: true, stop: true, note: `${it.name} is now past Lv ${lv}.` };
    if (!next.canUpgrade) return { ok: true, stop: true, note: `${it.name} reached Lv ${next.level}, the maximum.` };
    if (next.levels < 1) return { ok: true, stop: true, note: `${it.name} is Lv ${next.level}. You are short on materials${S.goldExact ? ' or gold' : ''} for the next level.` };
    return { ok: true, key: next.key };
  }

  /* ----- decraft */
  async function decraftOnce(id, qty) {
    let res, j = null;
    try {
      const fd = new FormData(); fd.append('item_id', id); fd.append('qty', String(qty));
      res = await fetch('decraft_item.php', { method: 'POST', credentials: 'same-origin', body: fd });
      const text = await res.text();
      DBG.last = { action: 'decraft', status: res.status, url: res.url, redirected: res.redirected, body: text.slice(0, 1500) };
      try { j = JSON.parse(text); } catch (_) {}
    } catch (_) {
      return { ok: false, msg: 'Network error. Nothing was decrafted.', stop: true };
    }
    if (!j) return { ok: false, msg: `Unexpected reply from the server (status ${res.status}).`, stop: true };
    if (!j.ok) return { ok: false, msg: j.error || 'Decraft failed.', stop: true };
    const it = (S.decraft?.items || []).find((x) => x.id === id);
    if (it) {
      const rem = Number.isFinite(Number(j.remaining_qty)) ? Number(j.remaining_qty) : it.have - qty;
      it.have = rem; it.max = Math.max(0, rem - 1);
    }
    markStale('decraft');
    return { ok: true, returned: j.returned_materials };
  }

  function addReturned(bag, list) {
    if (!Array.isArray(list)) return;
    for (const m of list) {
      if (m == null) continue;
      if (typeof m === 'string') { bag[m] = (bag[m] || 0) + 1; continue; }
      const name = m.name || m.item_name || m.material || m.title || m.item || '';
      const q = Number(m.qty ?? m.quantity ?? m.amount ?? m.count ?? m.returned ?? 0) || 0;
      const k = fixText(name) || 'Unnamed material';
      bag[k] = (bag[k] || 0) + q;
    }
  }
  const bagLine = (bag) => Object.entries(bag).map(([k, v]) => (v ? `${k} ×${fmt(v)}` : k)).join(', ');

  /* ------------------------------------------------------------ UI pieces */
  function modal(extra) {
    const back = h('div', { class: 'uag-backdrop' });
    const dlg = h('div', { class: 'uag-dlg ' + (extra || ''), role: 'dialog', 'aria-modal': 'true' });
    const x = h('button', { class: 'uag-x', type: 'button', 'aria-label': 'Close', text: '×' });
    dlg.append(x); back.append(dlg);
    let closing = null;
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    function close() {
      if (!back.isConnected) return;
      back.remove(); document.body.classList.remove('uag-lock');
      document.removeEventListener('keydown', key, true);
      if (closing) closing();
    }
    x.addEventListener('click', close);
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    document.addEventListener('keydown', key, true);
    document.body.classList.add('uag-lock');
    document.body.append(back);
    return { dlg, close, onClose: (fn) => { closing = fn; } };
  }

  function qtyControl({ max, value = 1, chips = [1, 5, 10, 25, 50, 100], onChange }) {
    const api = { max: Math.max(0, max), value: 1 };
    const input = h('input', { class: 'uag-qty-input', type: 'number', inputmode: 'numeric', min: '1', 'aria-label': 'Quantity' });
    const minus = h('button', { class: 'uag-step', type: 'button', 'aria-label': 'One less', text: '−' });
    const plus = h('button', { class: 'uag-step', type: 'button', 'aria-label': 'One more', text: '+' });
    const chipRow = h('div', { class: 'uag-chips' });
    const set = (n, silent) => {
      api.value = clamp(Math.floor(Number(n) || 1), 1, Math.max(1, api.max));
      input.value = String(api.value);
      minus.disabled = api.value <= 1 || api.max < 1;
      plus.disabled = api.value >= api.max;
      input.disabled = api.max < 1;
      if (!silent && onChange) onChange(api.value);
    };
    const drawChips = () => {
      chipRow.replaceChildren(
        ...chips.filter((c) => c < api.max).map((c) => h('button', { class: 'uag-chip', type: 'button', text: String(c), onclick: () => set(c) })),
        h('button', { class: 'uag-chip uag-chip-max', type: 'button', text: api.max > 0 ? `Max ${fmt(api.max)}` : 'Max', disabled: api.max < 1, onclick: () => set(api.max) }),
      );
    };
    minus.addEventListener('click', () => set(api.value - 1));
    plus.addEventListener('click', () => set(api.value + 1));
    input.addEventListener('input', () => { if (input.value !== '') set(input.value); });
    input.addEventListener('blur', () => set(input.value));
    api.setMax = (m) => { api.max = Math.max(0, m); input.max = String(api.max); drawChips(); set(api.value, true); };
    api.el = h('div', { class: 'uag-qty-row' }, h('div', { class: 'uag-qty' }, minus, input, plus), chipRow);
    api.setMax(max); set(value, true);
    return api;
  }

  function progress() {
    const bar = h('i');
    const label = h('span', { class: 'uag-prog-txt' });
    const stop = h('button', { class: 'uag-btn', type: 'button', text: 'Stop' });
    const el = h('div', { class: 'uag-prog', hidden: true }, h('span', { class: 'uag-bar' }, bar), label, stop);
    return {
      el, stop,
      set(done, total, text) { el.hidden = false; bar.style.width = (total ? (done / total) * 100 : 0) + '%'; label.textContent = text; },
      hide() { el.hidden = true; },
    };
  }

  const art = (src, cls) => h('span', { class: cls || 'uag-art' }, src ? h('img', { src, alt: '', loading: 'lazy' }) : null);
  const pill = (text, kind) => h('span', { class: 'uag-pill' + (kind ? ' uag-pill-' + kind : ''), text });

  function matRows(mats, mult) {
    return h('div', { class: 'uag-mats' }, mats.map((m) => {
      const need = m.need * mult;
      const short = m.have < need;
      return h('div', { class: 'uag-mat' + (short ? ' is-short' : '') },
        art(m.img, 'uag-mat-art'),
        h('span', { class: 'uag-mat-name', text: m.name }),
        h('span', { class: 'uag-mat-num' }, h('b', { text: fmt(m.have) }), h('i', { text: ` needs ${fmt(need)}` })),
      );
    }));
  }

  function bindRun({ go, qty, prog, result, label, armed }) {
    // Wires one dialog button to a batch run. Returns helpers the caller uses to start it.
    let ctl = null, confirming = false;
    const reset = () => { confirming = false; go.classList.remove('is-armed'); };
    return {
      get running() { return !!ctl; },
      get ctl() { return ctl; },
      disarm: reset,
      async start(opts) {
        if (armed && !confirming) {
          confirming = true; go.classList.add('is-armed');
          go.textContent = armed(qty.value);
          return;
        }
        reset(); result.textContent = ''; result.className = 'uag-result';
        S.busy = true; go.disabled = true; qty.el.classList.add('is-locked');
        prog.stop.onclick = () => { if (ctl) { ctl.stop = true; prog.stop.disabled = true; } };
        prog.stop.disabled = false;
        ctl = runBatch({ ...opts, onTick: (d, t) => { prog.set(d, t, opts.progressText(d, t)); } });
        prog.set(0, opts.count, opts.progressText(0, opts.count));
        const out = await ctl.promise;
        ctl = null; S.busy = false; prog.hide(); qty.el.classList.remove('is-locked');
        return out;
      },
    };
  }

  /* ------------------------------------------------------------ dialogs */
  function openCraft(g, id) {
    const get = () => findRec(g, id);
    const M = modal();
    const r0 = get();
    const qty = qtyControl({ max: r0.max, onChange: () => paint() });
    const mats = h('div');
    const result = h('div', { class: 'uag-result', role: 'status', 'aria-live': 'polite' });
    const prog = progress();
    const go = h('button', { class: 'uag-btn uag-btn-primary uag-go', type: 'button' });
    const runner = bindRun({ go, qty, prog, result });
    M.onClose(() => { if (runner.ctl) runner.ctl.stop = true; renderBody(); });

    const facts = [['Attack', fmt(r0.atk)], ['Defense', fmt(r0.def)]];
    if (r0.element) facts.push(['Element', r0.element]);
    M.dlg.append(
      h('div', { class: 'uag-dlg-head' }, art(r0.img, 'uag-dlg-art'),
        h('div', { class: 'uag-dlg-title' }, h('h3', { text: r0.name }),
          h('div', { class: 'uag-dlg-tags' }, r0.legendary ? pill('Legendary', 'leg') : null),
          r0.desc ? h('p', { class: 'uag-desc', text: r0.desc }) : null)),
      h('dl', { class: 'uag-facts' }, facts.map(([k, v]) => h('div', {}, h('dt', { text: k }), h('dd', { text: v })))),
      r0.power ? h('p', { class: 'uag-power', text: '⚡ ' + r0.power }) : null,
      h('h4', { class: 'uag-sub', text: 'Uses per craft' }), mats,
      h('h4', { class: 'uag-sub', text: 'How many?' }), qty.el, prog.el, result, h('div', { class: 'uag-actions' }, go),
    );

    function paint() {
      const r = get(); if (!r) return;
      r.max = canMake(r.reqs);
      qty.setMax(r.max);
      mats.replaceChildren(matRows(r.reqs, qty.value));
      go.textContent = r.max < 1 ? 'Not enough materials' : `Craft ${fmt(qty.value)}`;
      go.disabled = S.busy || r.max < 1;
    }
    paint();

    go.addEventListener('click', async () => {
      const n = qty.value;
      const out = await runner.start({
        count: n, delay: CFG.craftDelayMs,
        step: () => craftOnce(g, id),
        progressText: (d, t) => `Crafting ${d} of ${t}…`,
      });
      if (!out) return;
      if (out.done) markStale(String(g));
      const used = out.done;
      result.className = 'uag-result ' + (out.fail ? 'is-bad' : 'is-ok');
      result.textContent = out.fail
        ? `${used ? `Crafted ${fmt(used)} of ${fmt(n)}. ` : ''}${out.fail}`
        : `Crafted ${fmt(used)} × ${get()?.name || r0.name}.`;
      if (used) toast(`Crafted ${fmt(used)} × ${r0.name}`);
      paint(); renderBody();
    });
  }

  function openUpgrade(key) {
    let cur = key;
    const get = () => S.forge.items.find((x) => x.key === cur);
    const it0 = get();
    const M = modal();
    const qty = qtyControl({ max: Math.max(1, it0.levels), chips: [1, 2, 3, 5, 10], onChange: () => paint() });
    const body = h('div');
    const result = h('div', { class: 'uag-result', role: 'status', 'aria-live': 'polite' });
    const prog = progress();
    const go = h('button', { class: 'uag-btn uag-btn-primary uag-go', type: 'button' });
    const runner = bindRun({ go, qty, prog, result });
    M.onClose(() => { if (runner.ctl) runner.ctl.stop = true; renderBody(); });
    M.dlg.append(body, h('h4', { class: 'uag-sub', text: 'Levels to upgrade' }), qty.el, prog.el, result, h('div', { class: 'uag-actions' }, go));

    function paint() {
      const it = get() || it0;
      qty.setMax(it.canUpgrade ? Math.max(it.levels, 0) : 0);
      const mult = qty.value;
      const goldShort = it.goldNeed && S.goldExact && S.gold < it.goldNeed * mult;
      body.replaceChildren(
        h('div', { class: 'uag-dlg-head' }, art(it.img, 'uag-dlg-art'),
          h('div', { class: 'uag-dlg-title' }, h('h3', { text: it.name }),
            h('div', { class: 'uag-dlg-tags' }, pill(it.badge, it.mythical ? 'myth' : 'leg'), pill('Lv ' + it.level)),
            it.power ? h('p', { class: 'uag-desc', text: '⚡ ' + it.power }) : null)),
        h('dl', { class: 'uag-facts' },
          h('div', {}, h('dt', { text: 'Attack' }), h('dd', { text: fmt(it.atk) })),
          h('div', {}, h('dt', { text: 'Defense' }), h('dd', { text: fmt(it.def) })),
          h('div', {}, h('dt', { text: it.nextTitle ? it.nextTitle.replace(/^Next Level\s*·\s*/i, 'Next: ') : 'Next level' }),
            h('dd', { text: it.deltas.length ? it.deltas.join(' · ') : '—' }))),
        it.canUpgrade
          ? h('div', {}, h('h4', { class: 'uag-sub', text: 'Uses for the next level' }), matRows(it.mats, 1),
            it.goldNeed ? h('div', { class: 'uag-gold' + (goldShort ? ' is-short' : '') }, '🪙 ', h('b', { text: fmt(it.goldNeed) }), ` gold per level · you have ${S.goldExact ? fmt(S.gold) : 'about ' + fmt(S.gold)}`) : null,
            mult > 1 ? h('p', { class: 'uag-hint', text: 'Later levels can cost more. The run stops by itself when something runs short.' }) : null)
          : h('p', { class: 'uag-hint', text: it.hint || 'Max level reached.' }));
      go.textContent = !it.canUpgrade ? 'Max level' : it.levels < 1 ? 'Not enough to upgrade' : mult > 1 ? `Upgrade up to ${mult} levels` : 'Upgrade';
      go.disabled = S.busy || !it.canUpgrade || it.levels < 1;
    }
    paint();

    go.addEventListener('click', async () => {
      const startLv = (get() || it0).level;
      const n = qty.value;
      const out = await runner.start({
        count: n, delay: CFG.upgradeDelayMs,
        step: async () => { const r = await upgradeOnce(cur); if (r.key) cur = r.key; return r; },
        progressText: (d, t) => `Upgrading ${d} of ${t}…`,
      });
      if (!out) return;
      const now = get();
      result.className = 'uag-result ' + (out.fail ? 'is-bad' : 'is-ok');
      const gained = out.done ? `Upgraded ${fmt(out.done)} level${out.done > 1 ? 's' : ''}${now ? `, now Lv ${now.level}` : ''}. ` : '';
      result.textContent = (gained + (out.fail || out.note || '')).trim() || `Upgraded from Lv ${startLv}.`;
      if (out.done) toast(`${it0.name} upgraded ×${out.done}`);
      paint(); renderBody();
    });
  }

  function openDecraft(id) {
    const get = () => S.decraft.items.find((x) => x.id === id);
    const it0 = get();
    const M = modal();
    const qty = qtyControl({ max: it0.max, chips: [1, 5, 10, 25, 50, 100], onChange: () => { runner.disarm(); paint(); } });
    const info = h('div');
    const result = h('div', { class: 'uag-result', role: 'status', 'aria-live': 'polite' });
    const prog = progress();
    const go = h('button', { class: 'uag-btn uag-btn-danger uag-go', type: 'button' });
    const runner = bindRun({ go, qty, prog, result, armed: (n) => `Destroy ${fmt(n)} — press again to confirm` });
    let out_returned = null;
    M.onClose(() => renderBody());
    M.dlg.append(info, h('h4', { class: 'uag-sub', text: 'How many to decraft?' }), qty.el, prog.el, result, h('div', { class: 'uag-actions' }, go));

    function paint() {
      const it = get() || it0;
      qty.setMax(it.max);
      info.replaceChildren(
        h('div', { class: 'uag-dlg-head' }, art(it.img, 'uag-dlg-art'),
          h('div', { class: 'uag-dlg-title' }, h('h3', { text: it.name }),
            h('div', { class: 'uag-dlg-tags' }, pill(it.badge, 'leg')),
            h('p', { class: 'uag-desc', text: `You have ${fmt(it.have)}. You always keep 1, so you can decraft up to ${fmt(it.max)}. This destroys the items and returns their crafting materials.` }))),
        h('dl', { class: 'uag-facts' },
          h('div', {}, h('dt', { text: 'Attack' }), h('dd', { text: fmt(it.atk) })),
          h('div', {}, h('dt', { text: 'Defense' }), h('dd', { text: fmt(it.def) })),
          h('div', {}, h('dt', { text: 'You keep' }), h('dd', { text: fmt(it.have - qty.value) }))));
      go.textContent = it.max < 1 ? 'Need 2 copies' : `Decraft ${fmt(qty.value)}`;
      go.disabled = S.busy || it.max < 1;
    }
    paint();

    go.addEventListener('click', async () => {
      const n = qty.value;
      const out = await runner.start({
        count: 1, delay: 0,
        step: async () => { const r = await decraftOnce(id, n); if (r.ok) { out_returned = r.returned; } return r; },
        progressText: () => 'Decrafting…',
      });
      if (!out) return;
      result.className = 'uag-result ' + (out.fail ? 'is-bad' : 'is-ok');
      if (out.fail) result.textContent = out.fail;
      else {
        const bag = {}; addReturned(bag, out_returned);
        result.textContent = `Decrafted ${fmt(n)}. ${Object.keys(bag).length ? 'Returned: ' + bagLine(bag) + '.' : ''} ${fmt(get()?.have)} left.`.replace(/\s+/g, ' ');
        toast(`Decrafted ${fmt(n)} × ${it0.name}`);
      }
      paint(); renderBody();
    });
  }

  function openDecraftAll() {
    const items = S.decraft.items.filter((x) => x.max > 0);
    const M = modal('uag-dlg-wide');
    const picked = new Set();
    const list = h('div', { class: 'uag-pick' });
    const summary = h('div', { class: 'uag-hint' });
    const result = h('div', { class: 'uag-result', role: 'status', 'aria-live': 'polite' });
    const prog = progress();
    const go = h('button', { class: 'uag-btn uag-btn-danger uag-go', type: 'button' });
    let armed = false, running = false;
    M.onClose(() => { running = false; ctlStop = true; renderBody(); });
    let ctlStop = false;

    const total = () => items.filter((x) => picked.has(x.id)).reduce((s, x) => s + x.max, 0);
    function paint() {
      armed = false; go.classList.remove('is-armed');
      list.replaceChildren(...items.map((x) => {
        const cb = h('input', { type: 'checkbox', checked: picked.has(x.id), onchange: (e) => { e.target.checked ? picked.add(x.id) : picked.delete(x.id); paint(); } });
        return h('label', { class: 'uag-pick-row' + (picked.has(x.id) ? ' is-on' : '') }, cb, art(x.img, 'uag-mat-art'),
          h('span', { class: 'uag-mat-name', text: x.name }),
          h('span', { class: 'uag-mat-num' }, h('b', { text: '×' + fmt(x.max) }), h('i', { text: ` keeps 1 of ${fmt(x.have)}` })));
      }));
      summary.textContent = picked.size ? `${picked.size} item type${picked.size > 1 ? 's' : ''} selected · ${fmt(total())} copies will be destroyed.` : 'Tick what you want to decraft. Nothing is selected yet.';
      go.textContent = picked.size ? `Decraft ${fmt(total())} copies` : 'Select items first';
      go.disabled = running || !picked.size;
    }

    M.dlg.append(
      h('h3', { class: 'uag-ba-title', text: 'Decraft spares' }),
      h('p', { class: 'uag-desc', text: 'Each ticked item is decrafted down to 1 copy. You get the crafting materials back.' }),
      h('div', { class: 'uag-pick-tools' },
        h('button', { class: 'uag-link', type: 'button', text: 'Select all', onclick: () => { items.forEach((x) => picked.add(x.id)); paint(); } }),
        h('button', { class: 'uag-link', type: 'button', text: 'Clear', onclick: () => { picked.clear(); paint(); } })),
      list, summary, prog.el, result, h('div', { class: 'uag-actions' }, go));
    paint();

    go.addEventListener('click', async () => {
      if (!armed) { armed = true; go.classList.add('is-armed'); go.textContent = `Destroy ${fmt(total())} — press again to confirm`; return; }
      const queue = items.filter((x) => picked.has(x.id));
      const bag = {}; let destroyed = 0, failed = '';
      running = true; ctlStop = false; go.disabled = true; result.textContent = ''; result.className = 'uag-result';
      prog.stop.disabled = false; prog.stop.onclick = () => { ctlStop = true; prog.stop.disabled = true; };
      for (let i = 0; i < queue.length && !ctlStop; i++) {
        const x = queue[i]; const n = x.max;
        prog.set(i, queue.length, `Decrafting ${x.name} (${i + 1} of ${queue.length})…`);
        const r = await decraftOnce(x.id, n);
        if (!r.ok) { failed = `${x.name}: ${r.msg}`; break; }
        destroyed += n; picked.delete(x.id); addReturned(bag, r.returned);
        await sleep(150);
      }
      running = false; prog.hide();
      result.className = 'uag-result ' + (failed ? 'is-bad' : 'is-ok');
      result.textContent = `Decrafted ${fmt(destroyed)} copies. ${Object.keys(bag).length ? 'Returned: ' + bagLine(bag) + '.' : ''} ${failed}`.replace(/\s+/g, ' ').trim();
      if (destroyed) toast(`Decrafted ${fmt(destroyed)} copies`);
      for (let i = items.length - 1; i >= 0; i--) if (items[i].max < 1) items.splice(i, 1);
      paint(); renderBody();
    });
  }

  /* --------------------------------------------------------------- the page */
  let root, panel, tabEls = {};

  const TABS = [
    { id: 'craft', ico: '🔨', label: 'Craft' },
    { id: 'legendary', ico: '✨', label: 'Legendary' },
  ];

  function tabInfo(id) {
    if (id === 'craft') {
      const c = S.craft[S.gate];
      if (!c) return 'Blacksmith recipes';
      return `${c.recipes.filter((r) => r.max > 0).length} of ${c.recipes.length} ready`;
    }
    const bits = [];
    if (S.forge) bits.push(`${S.forge.items.filter((x) => x.canUpgrade && x.levels > 0).length} upgradable`);
    if (S.decraft) bits.push(`${S.decraft.items.filter((x) => x.max > 0).length} with spares`);
    return bits.join(' · ') || 'Upgrade and decraft';
  }

  function build() {
    const container = document.querySelector('.container') || document.body;
    [...container.children].forEach((c) => {
      if (c.matches('.gate-menu, .gate-selection, .recipe-grid, .grid, .note')) c.classList.add('uag-native');
    });
    const switchbar = h('div', { class: 'uag-switchbar' },
      h('button', { class: 'uag-link', type: 'button', text: 'Show classic view', onclick: (e) => {
        const on = document.body.classList.toggle('uag-classic');
        e.currentTarget.textContent = on ? 'Show new view' : 'Show classic view';
      } }));
    const tabs = h('div', { class: 'uag-tabs', role: 'tablist' }, TABS.map((t) => {
      const b = h('button', { class: 'uag-tab', type: 'button', role: 'tab', 'data-tab': t.id, onclick: () => selectTab(t.id) },
        h('span', { class: 'uag-tab-ico', text: t.ico }),
        h('span', { class: 'uag-tab-main' }, h('b', { text: t.label }), h('small', { class: 'uag-tab-sub' })));
      tabEls[t.id] = b; return b;
    }));
    panel = h('div', { class: 'uag-panel' });
    root = h('section', { class: 'uag', 'data-tab': S.tab }, switchbar, tabs, panel);
    const anchor = container.querySelector('.topbar');
    if (anchor) anchor.after(root); else container.prepend(root);
  }

  function selectTab(id) {
    S.tab = id; prefs.tab = id; savePrefs();
    S.query = '';
    renderBody();
  }

  const loading = (msg) => h('div', { class: 'uag-empty' }, msg);

  async function renderBody() {
    if (!root) return;
    root.dataset.tab = S.tab;
    for (const t of TABS) {
      tabEls[t.id].setAttribute('aria-selected', String(t.id === S.tab));
      tabEls[t.id].querySelector('.uag-tab-sub').textContent = tabInfo(t.id);
    }
    const mine = ++renderBody.n;
    try {
      if (S.tab === 'craft') {
        const c = S.craft[S.gate];
        if (!c || c.stale) panel.replaceChildren(loading('Loading recipes…'));
        await loadGate(S.gate);
        if (mine !== renderBody.n) return;
        paintCraft();
      } else if (S.mode === 'upgrade') {
        if (!S.forge || S.forge.stale) panel.replaceChildren(loading('Loading the Legendary Forge…'));
        await loadForge();
        if (mine !== renderBody.n) return;
        paintUpgrade();
      } else {
        if (!S.decraft || S.decraft.stale) panel.replaceChildren(loading('Loading decraftable items…'));
        await loadDecraft();
        if (mine !== renderBody.n) return;
        paintDecraft();
      }
    } catch (e) {
      if (mine !== renderBody.n) return;
      panel.replaceChildren(h('div', { class: 'uag-empty' }, h('p', { text: (e && e.message) || 'Could not load this list.' }),
        h('button', { class: 'uag-btn', type: 'button', text: 'Try again', onclick: () => {
          if (S.tab === 'craft') delete S.craft[S.gate]; else if (S.mode === 'upgrade') S.forge = null; else S.decraft = null;
          renderBody();
        } })));
    }
    for (const t of TABS) tabEls[t.id].querySelector('.uag-tab-sub').textContent = tabInfo(t.id);
  }
  renderBody.n = 0;

  function toolbar({ sorts, readyLabel, extra }) {
    const search = h('input', { class: 'uag-search', type: 'search', placeholder: 'Search…', value: S.query, 'aria-label': 'Search' });
    search.addEventListener('input', () => { S.query = search.value; paintList(); });
    const sort = h('select', { class: 'uag-select', 'aria-label': 'Sort' }, sorts.map(([v, l]) => h('option', { value: v, text: l, selected: getSort() === v })));
    sort.addEventListener('change', () => { prefs.sort[viewKey()] = sort.value; savePrefs(); paintList(); });
    const cb = h('input', { type: 'checkbox', checked: getOnly() });
    cb.addEventListener('change', () => { prefs.only[viewKey()] = cb.checked; savePrefs(); paintList(); });
    return h('div', { class: 'uag-toolbar' }, search, sort, h('label', { class: 'uag-check' }, cb, readyLabel), h('span', { class: 'uag-grow' }), extra);
  }

  let paintList = () => {};

  function shell(...kids) {
    panel.replaceChildren(...kids);
  }

  function tile({ item, img, pillText, pillKind, name, lines, foot, disabled, onClick, bad }) {
    return h('button', { class: 'uag-tile' + (disabled ? ' is-off' : '') + (bad ? ' is-poor' : ''), type: 'button', onclick: onClick },
      h('span', { class: 'uag-art' }, img ? h('img', { src: img, alt: '', loading: 'lazy' }) : null,
        pillText ? h('span', { class: 'uag-pill uag-pill-' + (pillKind || 'leg') + ' uag-pill-abs', text: pillText }) : null),
      h('span', { class: 'uag-name', text: name }),
      h('span', { class: 'uag-lines' }, lines),
      foot);
  }

  function sortBy(list, mode, getters) {
    const out = list.slice();
    const g = getters[mode];
    if (g) out.sort(g);
    return out;
  }

  /* ----- craft view */
  function paintCraft() {
    const c = S.craft[S.gate]; if (!c) return;
    const gateBar = h('div', { class: 'uag-gates', role: 'group', 'aria-label': 'Recipe gate' }, S.gates.map((g) =>
      h('button', { class: 'uag-gate', type: 'button', 'aria-pressed': String(g.gate === S.gate), onclick: () => { S.gate = g.gate; prefs.gate = g.gate; savePrefs(); S.query = ''; renderBody(); } },
        g.label, g.count != null ? h('small', { text: String(g.count) }) : null)));
    const grid = h('div', { class: 'uag-grid' });
    const tb = toolbar({
      sorts: [['default', 'Page order'], ['ready', 'Most craftable'], ['name', 'Name']],
      readyLabel: 'Only what I can craft',
    });
    shell(gateBar, tb, grid, h('p', { class: 'uag-hint', text: 'Search also matches material names, so you can find everything a material is used in.' }));
    paintList = () => {
      const q = S.query.trim().toLowerCase();
      let list = c.recipes.filter((r) => (!q || r.name.toLowerCase().includes(q) || r.reqs.some((m) => m.name.toLowerCase().includes(q))) && (!getOnly() || r.max > 0));
      list = sortBy(list, getSort(), { ready: (a, b) => b.max - a.max, name: (a, b) => a.name.localeCompare(b.name) });
      grid.replaceChildren(...(list.length ? list.map((r) => tile({
        img: r.img, pillText: r.legendary ? 'Legendary' : '', name: r.name,
        lines: [`🔪 ${fmt(r.atk)} · 🛡️ ${fmt(r.def)}`],
        bad: r.max < 1, disabled: r.max < 1,
        foot: h('span', { class: 'uag-stock' },
          h('span', { class: 'uag-minimats' }, r.reqs.map((m) => h('span', { class: 'uag-mini' + (m.have < m.need ? ' is-short' : ''), title: `${m.name}: ${fmt(m.have)} / ${fmt(m.need)}` }, art(m.img, 'uag-mini-art'), h('b', { text: fmt(m.need) })))),
          h('span', { class: 'uag-stock-txt', text: r.max > 0 ? `Can craft ${fmt(r.max)}` : 'Missing materials' })),
        onClick: () => openCraft(S.gate, r.id),
      })) : [h('div', { class: 'uag-empty', text: 'No recipes match.' })]));
    };
    paintList();
  }

  /* ----- upgrade view */
  function segmented() {
    return h('div', { class: 'uag-seg', role: 'group', 'aria-label': 'Legendary section' },
      [['upgrade', 'Upgrade'], ['decraft', 'Decraft']].map(([id, label]) =>
        h('button', { class: 'uag-segbtn', type: 'button', 'aria-pressed': String(S.mode === id), text: label,
          onclick: () => { S.mode = id; prefs.mode = id; savePrefs(); S.query = ''; renderBody(); } })));
  }

  function paintUpgrade() {
    const f = S.forge;
    const grid = h('div', { class: 'uag-grid' });
    const goldChip = h('span', { class: 'uag-goldchip', title: S.goldExact ? '' : 'Read from the top bar, so it may be rounded' }, '🪙 ', h('b', { text: (S.goldExact ? '' : '≈ ') + fmt(S.gold) }));
    const tb = toolbar({
      sorts: [['default', 'Page order'], ['ready', 'Upgradable first'], ['level', 'Highest level'], ['name', 'Name']],
      readyLabel: 'Only upgradable now', extra: goldChip,
    });
    shell(segmented(), tb, grid);
    paintList = () => {
      const q = S.query.trim().toLowerCase();
      let list = f.items.filter((x) => (!q || x.name.toLowerCase().includes(q)) && (!getOnly() || (x.canUpgrade && x.levels > 0)));
      list = sortBy(list, getSort(), {
        ready: (a, b) => (b.canUpgrade && b.levels > 0) - (a.canUpgrade && a.levels > 0) || b.levels - a.levels,
        level: (a, b) => b.level - a.level,
        name: (a, b) => a.name.localeCompare(b.name),
      });
      grid.replaceChildren(...(list.length ? list.map((x) => {
        const ready = x.canUpgrade && x.levels > 0;
        return tile({
          img: x.img, pillText: x.badge, pillKind: x.mythical ? 'myth' : 'leg', name: x.name,
          lines: [`Lv ${x.level} · 🔪 ${fmt(x.atk)} · 🛡️ ${fmt(x.def)}`],
          bad: !ready, disabled: !x.canUpgrade,
          foot: h('span', { class: 'uag-stock' },
            x.canUpgrade && x.deltas.length ? h('span', { class: 'uag-deltas', text: x.deltas.join(' · ') }) : null,
            h('span', { class: 'uag-stock-txt', text: !x.canUpgrade ? 'Max level' : ready ? `Can upgrade ${fmt(x.levels)} level${x.levels > 1 ? 's' : ''}` : 'Missing materials' })),
          onClick: () => openUpgrade(x.key),
        });
      }) : [h('div', { class: 'uag-empty', text: 'No items match.' })]));
    };
    paintList();
  }

  /* ----- decraft view */
  function paintDecraft() {
    const d = S.decraft;
    const grid = h('div', { class: 'uag-grid' });
    const spares = d.items.filter((x) => x.max > 0).length;
    const bulk = h('button', { class: 'uag-btn', type: 'button', text: 'Decraft spares…', disabled: !spares, onclick: () => openDecraftAll() });
    const tb = toolbar({
      sorts: [['default', 'Page order'], ['ready', 'Most spares'], ['name', 'Name']],
      readyLabel: 'Only with spares', extra: bulk,
    });
    shell(segmented(), tb, grid);
    paintList = () => {
      const q = S.query.trim().toLowerCase();
      let list = d.items.filter((x) => (!q || x.name.toLowerCase().includes(q)) && (!getOnly() || x.max > 0));
      list = sortBy(list, getSort(), { ready: (a, b) => b.max - a.max, name: (a, b) => a.name.localeCompare(b.name) });
      grid.replaceChildren(...(list.length ? list.map((x) => tile({
        img: x.img, pillText: x.badge, name: x.name,
        lines: [`🔪 ${fmt(x.atk)} · 🛡️ ${fmt(x.def)}`],
        bad: x.max < 1, disabled: x.max < 1,
        foot: h('span', { class: 'uag-stock' }, h('span', { class: 'uag-stock-txt', text: x.max > 0 ? `${fmt(x.have)} owned · ${fmt(x.max)} spare` : `${fmt(x.have)} owned · need 2 to decraft` })),
        onClick: () => openDecraft(x.id),
      })) : [h('div', { class: 'uag-empty', text: 'No items match.' })]));
    };
    paintList();
  }

  /* ------------------------------------------------------------------- CSS */
  const CSS = `
.uag{--acc:#FF9F43;--ink:#2a1500;margin:16px 0;color:#E0E0E0}
.uag[data-tab="legendary"],.uag-dlg{--acc:#FFD369;--ink:#241a00}
.uag *,.uag-dlg *{box-sizing:border-box}
.uag-native{display:none!important}
body.uag-classic .uag-native{display:block!important}
body.uag-classic .uag-native.recipe-grid,body.uag-classic .uag-native.grid{display:grid!important}
body.uag-classic .uag{display:none}
body.uag-lock{overflow:hidden}
.uag-switchbar{display:flex;justify-content:flex-end;margin:-4px 0 -8px}
.uag-link{background:none;border:0;color:#9aa0b8;font:inherit;font-size:12px;cursor:pointer;padding:4px 2px;text-decoration:underline}
.uag-link:hover{color:#EDEFF6}
.uag-tabs{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.uag-tab{--t:#FF9F43;appearance:none;font:inherit;color:#B9BBD1;cursor:pointer;text-align:left;display:flex;align-items:center;gap:12px;padding:12px 16px;background:#171923;border:1px solid #232437;border-radius:12px;transition:border-color .15s,background .15s,color .15s}
.uag-tab[data-tab="legendary"]{--t:#FFD369}
.uag-tab:hover{background:#1c1e2b;color:#EDEFF6}
.uag-tab[aria-selected="true"]{color:#F1F2FA;border-color:var(--t);background:linear-gradient(180deg,color-mix(in srgb,var(--t) 13%,#1A1B25),#1A1B25)}
.uag-tab-ico{font-size:24px;line-height:1}
.uag-tab-main{display:flex;flex-direction:column;min-width:0}
.uag-tab-main b{font-size:15px}
.uag-tab-main small{font-size:12px;color:#9aa0b8}
.uag-panel{background:#1A1B25;border:1px solid #232437;border-radius:12px;padding:14px;margin-top:10px;box-shadow:0 6px 18px rgba(0,0,0,.35)}
.uag-gates,.uag-seg{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}
.uag-gate,.uag-segbtn{appearance:none;font:inherit;font-size:13px;font-weight:600;color:#B9BBD1;background:#171923;border:1px solid #2B2D44;border-radius:999px;padding:7px 14px;cursor:pointer;display:inline-flex;align-items:center;gap:8px}
.uag-gate small{font-size:11px;color:#8d93ad;font-weight:500}
.uag-gate:hover,.uag-segbtn:hover{color:#EDEFF6;background:#1c1e2b}
.uag-gate[aria-pressed="true"],.uag-segbtn[aria-pressed="true"]{color:var(--ink);background:var(--acc);border-color:var(--acc)}
.uag-gate[aria-pressed="true"] small{color:var(--ink);opacity:.75}
.uag-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:14px}
.uag-grow{flex:1}
.uag-search,.uag-select{font:inherit;font-size:13px;color:#EDEFF6;background:#12131A;border:1px solid #2B2D44;border-radius:8px;padding:8px 10px;min-width:0}
.uag-search{width:200px}
.uag-search:focus,.uag-select:focus,.uag-qty-input:focus{outline:2px solid var(--acc);outline-offset:1px}
.uag-check{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:#B9BBD1;cursor:pointer;user-select:none}
.uag-check input,.uag-pick-row input{accent-color:var(--acc)}
.uag-goldchip{font-size:13px;color:#B9BBD1}
.uag-goldchip b{color:#FFD369;font-variant-numeric:tabular-nums}
.uag-btn{appearance:none;font:inherit;font-size:13px;font-weight:600;color:#EDEFF6;background:#2A2B3A;border:1px solid #2B2D44;border-radius:8px;padding:9px 14px;cursor:pointer;transition:background .15s,transform .1s}
.uag-btn:hover:not(:disabled){background:#34364A}
.uag-btn:active:not(:disabled){transform:translateY(1px)}
.uag-btn:disabled{opacity:.5;cursor:not-allowed}
.uag-btn-primary{background:var(--acc);border-color:var(--acc);color:var(--ink)}
.uag-btn-primary:hover:not(:disabled){background:var(--acc);filter:brightness(1.08)}
.uag-btn-danger{background:#3a1f26;border-color:#6b2f3b;color:#ffb3bf}
.uag-btn-danger:hover:not(:disabled){background:#4a2630}
.uag-btn-danger.is-armed{background:#c0394f;border-color:#c0394f;color:#fff}
.uag-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:12px}
.uag-empty{grid-column:1/-1;padding:28px 0;text-align:center;color:#9aa0b8}
.uag-empty p{margin:0 0 10px}
.uag-hint{margin:14px 0 0;font-size:12px;color:#7f869f}
.uag-tile{appearance:none;font:inherit;color:inherit;text-align:left;cursor:pointer;display:flex;flex-direction:column;gap:7px;padding:9px;background:#171923;border:1px solid #2B2D44;border-radius:12px;min-width:0;transition:border-color .15s,transform .12s,background .15s}
.uag-tile:hover{border-color:var(--acc);background:#1b1d29;transform:translateY(-2px)}
.uag-tile:active{transform:translateY(0)}
.uag-tile:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.uag-tile.is-off{border-style:dashed}
.uag-tile.is-off .uag-art img{filter:grayscale(.7);opacity:.6}
.uag-tile.is-off .uag-name{color:#8d93ad}
.uag-art{position:relative;display:block;aspect-ratio:1;border-radius:9px;overflow:hidden;background:#20212E}
.uag-art img{width:100%;height:100%;object-fit:cover;display:block}
.uag-pill{font-size:10.5px;font-weight:700;line-height:1;padding:4px 7px;border-radius:999px;background:rgba(18,19,26,.82);border:1px solid #3a3d5a;color:#cfd4ff;display:inline-block}
.uag-pill-abs{position:absolute;top:6px;left:6px;backdrop-filter:blur(3px)}
.uag-pill-leg{border-color:#7a6320;color:#ffe08a}
.uag-pill-myth{border-color:#426fd1;color:#a9c4ff}
.uag-name{font-weight:600;font-size:13.5px;color:#F1F2FA;line-height:1.25;min-height:2.5em;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.uag-lines{font-size:12.5px;color:#B9BBD1;font-variant-numeric:tabular-nums}
.uag-stock{display:flex;flex-direction:column;gap:6px;margin-top:auto}
.uag-stock-txt{font-size:11.5px;color:#9aa0b8}
.uag-tile:not(.is-poor) .uag-stock-txt{color:var(--acc)}
.uag-deltas{font-size:11.5px;color:#9fd5b0;line-height:1.3}
.uag-minimats{display:flex;flex-wrap:wrap;gap:4px}
.uag-mini{display:inline-flex;align-items:center;gap:3px;background:#12131A;border:1px solid #2B2D44;border-radius:6px;padding:2px 5px 2px 2px;font-size:11px;color:#9fd5b0}
.uag-mini.is-short{color:#f08a8a;border-color:#5a2f37}
.uag-mini-art,.uag-mat-art{display:block;width:22px;height:22px;border-radius:5px;overflow:hidden;background:#20212E;flex-shrink:0}
.uag-mini-art img,.uag-mat-art img{width:100%;height:100%;object-fit:cover;display:block}
.uag-mat-art{width:30px;height:30px}
/* dialog */
.uag-backdrop{position:fixed;inset:0;z-index:10100;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.68)}
.uag-dlg{position:relative;width:min(460px,100%);max-height:calc(100dvh - 32px);overflow:auto;background:#1A1B25;color:#E0E0E0;border:1px solid #2B2D44;border-radius:14px;padding:18px;box-shadow:0 16px 40px rgba(0,0,0,.55);font-family:'Segoe UI',Arial,sans-serif}
.uag-dlg-wide{width:min(580px,100%)}
.uag-x{position:absolute;top:8px;right:10px;background:none;border:0;color:#9aa0b8;font-size:24px;line-height:1;cursor:pointer;padding:4px 8px}
.uag-x:hover{color:#fff}
.uag-dlg-head{display:flex;gap:14px;margin-right:18px}
.uag-dlg-art{display:block;width:92px;height:92px;flex-shrink:0;border-radius:10px;overflow:hidden;background:#20212E}
.uag-dlg-art img{width:100%;height:100%;object-fit:cover;display:block}
.uag-dlg-title{min-width:0}
.uag-dlg-title h3,.uag-ba-title{margin:0 0 6px;font-size:18px;color:#F1F2FA}
.uag-dlg-tags{display:flex;gap:6px;margin-bottom:6px}
.uag-dlg-tags:empty{display:none}
.uag-desc{margin:0;font-size:13px;line-height:1.45;color:#B9BBD1;max-height:8em;overflow:auto}
.uag-power{margin:10px 0 0;font-size:12.5px;line-height:1.4;color:#cbd1ff}
.uag-facts{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:16px 0 10px}
.uag-facts div{background:#171923;border:1px solid #2B2D44;border-radius:9px;padding:8px 10px;min-width:0}
.uag-facts dt{font-size:11.5px;color:#9aa0b8;margin-bottom:2px}
.uag-facts dd{margin:0;font-size:13px;font-weight:600;color:#F1F2FA;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.uag-sub{margin:14px 0 8px;font-size:13px;font-weight:600;color:#B9BBD1}
.uag-mats{display:flex;flex-direction:column;gap:6px}
.uag-mat,.uag-pick-row{display:flex;align-items:center;gap:10px;background:#171923;border:1px solid #2B2D44;border-radius:9px;padding:6px 10px 6px 6px}
.uag-mat-name{flex:1;min-width:0;font-size:13px;color:#E0E0E0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.uag-mat-num{font-size:12.5px;color:#9aa0b8;font-variant-numeric:tabular-nums;white-space:nowrap}
.uag-mat-num b{color:#9fd5b0}
.uag-mat.is-short{border-color:#5a2f37}
.uag-mat.is-short .uag-mat-num b,.uag-mat.is-short .uag-mat-num i{color:#f08a8a}
.uag-gold{margin-top:8px;font-size:13px;color:#B9BBD1}
.uag-gold b{color:#FFD369;font-variant-numeric:tabular-nums}
.uag-gold.is-short b{color:#f08a8a}
.uag-qty-row{display:flex;flex-direction:column;gap:10px}
.uag-qty-row.is-locked{opacity:.55;pointer-events:none}
.uag-qty{display:inline-flex;align-self:flex-start;align-items:center;background:#12131A;border:1px solid #2B2D44;border-radius:10px;padding:3px}
.uag-step{width:36px;height:36px;border-radius:8px;border:0;background:#232433;color:#EDEFF6;font-size:18px;font-weight:700;cursor:pointer}
.uag-step:hover:not(:disabled){background:#2e3047}
.uag-step:disabled{opacity:.4;cursor:not-allowed}
.uag-qty-input{width:84px;text-align:center;font:inherit;font-size:15px;font-weight:600;color:#F1F2FA;background:transparent;border:0;-moz-appearance:textfield;font-variant-numeric:tabular-nums}
.uag-qty-input::-webkit-outer-spin-button,.uag-qty-input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.uag-chips{display:flex;flex-wrap:wrap;gap:6px}
.uag-chip{appearance:none;font:inherit;font-size:12px;font-weight:600;color:#B9BBD1;background:#171923;border:1px solid #2B2D44;border-radius:999px;padding:5px 11px;cursor:pointer}
.uag-chip:hover:not(:disabled){color:#fff;border-color:var(--acc)}
.uag-chip-max{color:var(--acc);border-color:color-mix(in srgb,var(--acc) 45%,#2B2D44)}
.uag-chip:disabled{opacity:.4;cursor:not-allowed}
.uag-prog{display:flex;align-items:center;gap:10px;margin-top:14px}
.uag-prog[hidden]{display:none}
.uag-bar{flex:0 0 90px;height:6px;border-radius:999px;background:#2a2b3a;overflow:hidden}
.uag-bar i{display:block;height:100%;width:0;background:var(--acc);border-radius:999px;transition:width .15s}
.uag-prog-txt{flex:1;font-size:12.5px;color:#B9BBD1;min-width:0}
.uag-result{margin-top:12px;font-size:13px;line-height:1.45;color:#B9BBD1}
.uag-result:empty{display:none}
.uag-result.is-ok{color:#9fd5b0}
.uag-result.is-bad{color:#f4a3ae}
.uag-actions{display:flex;margin-top:16px}
.uag-go{flex:1;padding:12px 14px;font-size:14px}
.uag-pick{display:flex;flex-direction:column;gap:6px;max-height:min(46dvh,380px);overflow:auto;margin-top:8px}
.uag-pick-row{cursor:pointer}
.uag-pick-row.is-on{border-color:#6b2f3b;background:#201820}
.uag-pick-tools{display:flex;gap:14px;margin-top:10px}
.uag-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:10200;background:#1A1B25;color:#EDEFF6;border:1px solid #2B2D44;border-radius:10px;padding:10px 16px;font-size:13px;box-shadow:0 8px 24px rgba(0,0,0,.5)}
.uag-toast.is-bad{border-color:#6b2f3b;color:#ffb3bf}
@media (max-width:560px){
  .uag-tabs{grid-template-columns:1fr 1fr;gap:8px}.uag-tab{padding:10px 12px}
  .uag-search{width:100%;flex:1 1 100%}
  .uag-grid{grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px}
  .uag-backdrop{align-items:flex-end;padding:0}
  .uag-dlg{width:100%;max-height:92dvh;border-radius:16px 16px 0 0}
  .uag-facts{grid-template-columns:1fr 1fr}
}
@media (prefers-reduced-motion:reduce){.uag *,.uag-dlg *{transition:none!important}}
`;

  /* ------------------------------------------------------------------ start */
  function start() {
    if (!document.body) return false;
    if (!document.querySelector('.container')) return false;
    document.head.append(h('style', { id: 'uag-css', text: CSS }));

    S.tab = PATH === 'blacksmith' ? 'craft' : 'legendary';
    if (PATH === 'legendary_decraft') S.mode = 'decraft';
    else if (PATH === 'legendary_forge') S.mode = 'upgrade';
    else { S.tab = prefs.tab === 'legendary' ? 'legendary' : 'craft'; S.mode = prefs.mode === 'decraft' ? 'decraft' : 'upgrade'; }
    if (!['upgrade', 'decraft'].includes(S.mode)) S.mode = 'upgrade';

    if (PATH === 'blacksmith') {
      const pg = parseGates(document);
      if (pg.gates.length) S.gates = pg.gates;
      // A ?gate= in the address wins. Otherwise reopen the gate you used last, if it still exists.
      const urlGate = /[?&]gate=(\d+)/.exec(location.search);
      const want = urlGate ? urlGate[1] : (S.gates.some((g) => g.gate === prefs.gate) ? prefs.gate : '');
      S.gate = want || pg.active || S.gates[0].gate;
      if (S.gate === pg.active) S.craft[S.gate] = { recipes: parseCraft(document), stale: false };
    } else {
      S.gate = prefs.gate || S.gates[0].gate;
    }
    initGold();
    if (PATH === 'legendary_forge') applyForge(document);
    if (PATH === 'legendary_decraft') S.decraft = { items: parseDecraft(document), stale: false };

    build();
    renderBody();
    // Fill in the other tab's counts quietly once the page is idle.
    setTimeout(() => {
      Promise.allSettled([loadForge(), loadDecraft()]).then(() => { if (!S.busy) for (const t of TABS) tabEls[t.id].querySelector('.uag-tab-sub').textContent = tabInfo(t.id); });
    }, 800);
    return true;
  }

  function boot() {
    let done = false;
    const tryStart = () => {
      if (done) return;
      try { done = start(); } catch (err) { console.error('[Artisans Guild] failed to start:', err); done = true; }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tryStart, { once: true });
    else tryStart();
    if (!done) {
      const mo = new MutationObserver(() => { tryStart(); if (done) mo.disconnect(); });
      mo.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => mo.disconnect(), 15000);
    }
  }
  boot();
})();

/* ==========================================================================
 * Black Merchant  (UI Cleanup module, black_merchant.php only)
 *
 *  - One tab per store (Soul Shop, Boss Shop, ...), each showing its own currency and balance.
 *    Tabs are built from whatever stores the page lists, so a new store appears by itself.
 *  - Click a tile to open a buy dialog: quantity, quick chips, Max, total cost, balance after.
 *  - Max is the smaller of what you have left to buy and what your balance covers.
 *  - Search, sort, "Hide sold out". These, and the store you were on, are remembered.
 *  - Balances update on every store that uses the same currency after each purchase.
 *
 * Self-contained. Append to the end of addons/ui-cleanup.js, or load as its own addon with
 *   "match": "^/black_merchant\\.php"
 *
 * Debugging: window.__uicBlackMerchant.last holds the last raw reply from black_buy.php.
 * ========================================================================== */
(function blackMerchant() {
  'use strict';

  if (!/\/black_merchant\.php/i.test(location.pathname)) return;
  if (window.__uicBlackMerchant) return;

  /* ---------------------------------------------------------------- config */
  const CFG = { prefsKey: 'uic_blackmerchant_prefs', maxPerBuy: 100000 };

  /* --------------------------------------------------------------- helpers */
  const NF = new Intl.NumberFormat();
  const fmt = (n) => NF.format(Math.max(0, Math.floor(Number(n) || 0)));
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const num = (s) => parseInt(String(s ?? '').replace(/[^\d-]/g, ''), 10) || 0;
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const fixText = (s) => String(s || '')
    .replace(/â€™/g, '’').replace(/â€˜/g, '‘').replace(/â€œ/g, '“').replace(/â€\u009d/g, '”')
    .replace(/â€“/g, '–').replace(/â€”/g, '—').replace(/â€¦/g, '…').replace(/Â/g, '');
  const txt = (el) => fixText(norm(el && el.textContent));

  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return e;
  }

  const prefs = (() => {
    const d = { store: '', sort: 'default', hideSold: false };
    try { return Object.assign(d, JSON.parse(localStorage.getItem(CFG.prefsKey) || '{}')); } catch (_) { return d; }
  })();
  const savePrefs = () => { try { localStorage.setItem(CFG.prefsKey, JSON.stringify(prefs)); } catch (_) {} };

  function toast(msg, ok = true) {
    try { if (typeof Core !== 'undefined' && Core.ui && Core.ui.toast) { Core.ui.toast(msg, ok, 3500); return; } } catch (_) {}
    const t = h('div', { class: 'ubm-toast' + (ok ? '' : ' is-bad'), role: 'status', text: msg });
    document.body.append(t); setTimeout(() => t.remove(), 3500);
  }

  /* ----------------------------------------------------------------- state */
  const S = { stores: [], active: '', query: '', busy: false };
  const DBG = { last: null };
  window.__uicBlackMerchant = { S, get last() { return DBG.last; } };

  /* --------------------------------------------------------------- parsing */
  function parseStores(root) {
    return [...root.querySelectorAll('.storePanel')].map((panel, si) => {
      const cur = panel.getAttribute('data-currency-item') || '';
      const box = panel.querySelector('.currencyBox');
      const store = {
        id: panel.getAttribute('data-store') || String(si),
        name: txt(panel.querySelector('.storeName')).replace(/^[^\p{L}\p{N}]+/u, '') || 'Store ' + (si + 1),
        desc: txt(panel.querySelector('.storeDesc')),
        cur,
        curName: txt(box && box.querySelector('span[style*="800"]')) || 'Currency',
        curImg: box?.querySelector('.curImg')?.getAttribute('src') || '',
        balance: num(panel.querySelector('.curBal')?.textContent),
        offers: [],
      };
      store.offers = [...panel.querySelectorAll('.offerCard')].map((c, oi) => {
        const max = num(c.getAttribute('data-max'));
        const lim = /(\d+)\s*\/\s*(\d+)/.exec(txt(c.querySelector('.limitText')));
        const bought = num(c.getAttribute('data-bought'));
        return {
          id: c.getAttribute('data-offer'),
          name: txt(c.querySelector('.name')) || 'Offer ' + (oi + 1),
          img: c.querySelector('.img')?.getAttribute('src') || '',
          price: num(c.getAttribute('data-price')),
          cur: c.getAttribute('data-currency') || cur,
          max,
          // "3 / 5 left for you" is what the server last said; fall back to max - bought; max 0 means no limit
          left: max <= 0 ? Infinity : lim ? num(lim[1]) : Math.max(0, max - bought),
          order: oi,
        };
      });
      return store;
    });
  }

  const canBuy = (st, o) => Math.min(o.left, o.price > 0 ? Math.floor(st.balance / o.price) : o.left, CFG.maxPerBuy);
  const limited = (o) => Number.isFinite(o.left);

  /* ------------------------------------------------------------------- buy */
  async function buy(st, o, qty) {
    let res, text, j = null;
    try {
      res = await fetch('black_buy.php', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ bmitem: o.id, qty: String(qty) }),
      });
      text = await res.text();
      DBG.last = { status: res.status, url: res.url, body: text.slice(0, 1500) };
      try { j = JSON.parse(text); } catch (_) {}
    } catch (_) {
      return { ok: false, msg: 'Network error. Nothing was bought.' };
    }
    if (!j) return { ok: false, msg: `Unexpected reply from the server (status ${res.status}).` };
    if (j.status !== 'success') return { ok: false, msg: j.message || 'Purchase failed.' };

    // Currency balance: use the server's number, otherwise subtract the cost. Every store sharing this currency follows.
    const newBal = j.new_balance && j.new_balance.count != null ? Number(j.new_balance.count) : null;
    for (const s of S.stores) if (s.cur === o.cur) s.balance = newBal != null && Number.isFinite(newBal) ? newBal : Math.max(0, s.balance - o.price * qty);
    // What is left for you
    if (j.left_for_you != null && Number.isFinite(parseInt(j.left_for_you, 10))) o.left = parseInt(j.left_for_you, 10);
    else if (limited(o)) o.left = Math.max(0, o.left - qty);
    return { ok: true, msg: j.message || 'Purchased.' };
  }

  /* ------------------------------------------------------------ UI pieces */
  function modal() {
    const back = h('div', { class: 'ubm-backdrop' });
    const dlg = h('div', { class: 'ubm-dlg', role: 'dialog', 'aria-modal': 'true' });
    const x = h('button', { class: 'ubm-x', type: 'button', 'aria-label': 'Close', text: '×' });
    dlg.append(x); back.append(dlg);
    let closing = null;
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    function close() {
      if (!back.isConnected) return;
      back.remove(); document.body.classList.remove('ubm-lock'); document.removeEventListener('keydown', key, true);
      if (closing) closing();
    }
    x.addEventListener('click', close);
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    document.addEventListener('keydown', key, true);
    document.body.classList.add('ubm-lock'); document.body.append(back);
    return { dlg, close, onClose: (fn) => { closing = fn; } };
  }

  function qtyControl({ max, onChange, chips = [1, 5, 10, 25, 50, 100] }) {
    const api = { max: Math.max(0, max), value: 1 };
    const input = h('input', { class: 'ubm-qty-input', type: 'number', inputmode: 'numeric', min: '1', 'aria-label': 'Quantity' });
    const minus = h('button', { class: 'ubm-step', type: 'button', 'aria-label': 'One less', text: '−' });
    const plus = h('button', { class: 'ubm-step', type: 'button', 'aria-label': 'One more', text: '+' });
    const chipRow = h('div', { class: 'ubm-chips' });
    const set = (n, silent) => {
      api.value = clamp(Math.floor(Number(n) || 1), 1, Math.max(1, api.max));
      input.value = String(api.value);
      minus.disabled = api.value <= 1 || api.max < 1; plus.disabled = api.value >= api.max; input.disabled = api.max < 1;
      if (!silent && onChange) onChange(api.value);
    };
    const drawChips = () => chipRow.replaceChildren(
      ...chips.filter((c) => c < api.max).map((c) => h('button', { class: 'ubm-chip', type: 'button', text: String(c), onclick: () => set(c) })),
      h('button', { class: 'ubm-chip ubm-chip-max', type: 'button', text: api.max > 0 ? `Max ${fmt(api.max)}` : 'Max', disabled: api.max < 1, onclick: () => set(api.max) }));
    minus.addEventListener('click', () => set(api.value - 1));
    plus.addEventListener('click', () => set(api.value + 1));
    input.addEventListener('input', () => { if (input.value !== '') set(input.value); });
    input.addEventListener('blur', () => set(input.value));
    api.setMax = (m) => { api.max = Math.max(0, m); input.max = String(api.max); drawChips(); set(api.value, true); };
    api.el = h('div', { class: 'ubm-qty-row' }, h('div', { class: 'ubm-qty' }, minus, input, plus), chipRow);
    api.setMax(max); set(1, true);
    return api;
  }

  const art = (src, cls) => h('span', { class: cls || 'ubm-art' }, src ? h('img', { src, alt: '', loading: 'lazy' }) : null);

  function openBuy(storeId, offerId) {
    const getStore = () => S.stores.find((s) => s.id === storeId);
    const getOffer = () => getStore()?.offers.find((o) => o.id === offerId);
    const st0 = getStore(), o0 = getOffer();
    const M = modal();
    const qty = qtyControl({ max: canBuy(st0, o0), onChange: () => paint() });
    const info = h('div');
    const result = h('div', { class: 'ubm-result', role: 'status', 'aria-live': 'polite' });
    const go = h('button', { class: 'ubm-btn ubm-btn-primary ubm-go', type: 'button' });
    M.onClose(() => renderBody());
    M.dlg.append(info, h('h4', { class: 'ubm-sub', text: 'How many?' }), qty.el, result, h('div', { class: 'ubm-actions' }, go));

    function paint() {
      const st = getStore(), o = getOffer(); if (!st || !o) return;
      const max = canBuy(st, o);
      qty.setMax(max);
      const total = o.price * qty.value;
      info.replaceChildren(
        h('div', { class: 'ubm-dlg-head' }, art(o.img, 'ubm-dlg-art'),
          h('div', { class: 'ubm-dlg-title' }, h('h3', { text: o.name }),
            h('div', { class: 'ubm-dlg-tags' }, h('span', { class: 'ubm-pill', text: st.name })),
            h('p', { class: 'ubm-desc', text: limited(o) ? `${fmt(o.left)} of ${fmt(o.max)} left for you.` : 'No purchase limit.' }))),
        h('dl', { class: 'ubm-facts' },
          h('div', {}, h('dt', { text: 'Price each' }), h('dd', {}, art(st.curImg, 'ubm-cur'), fmt(o.price))),
          h('div', {}, h('dt', { text: `You have` }), h('dd', { text: fmt(st.balance) })),
          h('div', {}, h('dt', { text: 'After buying' }), h('dd', { class: total > st.balance ? 'is-bad' : '', text: fmt(Math.max(0, st.balance - total)) }))),
        h('p', { class: 'ubm-total' }, 'Total: ', h('b', { text: fmt(total) }), ` ${st.curName}`));
      go.textContent = max < 1 ? (limited(o) && o.left < 1 ? 'Sold out' : `Not enough ${st.curName}`) : `Buy ${fmt(qty.value)}`;
      go.disabled = S.busy || max < 1;
    }
    paint();

    go.addEventListener('click', async () => {
      const st = getStore(), o = getOffer(), n = qty.value;
      S.busy = true; go.disabled = true; go.textContent = 'Buying…'; qty.el.classList.add('is-locked');
      const r = await buy(st, o, n);
      S.busy = false; qty.el.classList.remove('is-locked');
      result.className = 'ubm-result ' + (r.ok ? 'is-ok' : 'is-bad');
      result.textContent = r.ok ? `${r.msg} (${fmt(n)} × ${o.name})` : r.msg;
      if (r.ok) toast(`Bought ${fmt(n)} × ${o.name}`);
      paint(); renderBody();
    });
  }

  /* --------------------------------------------------------------- the page */
  let root, tabsEl, panel;

  function build() {
    const container = document.querySelector('.container') || document.body;
    container.querySelectorAll(':scope > .storePanel').forEach((p) => p.classList.add('ubm-native'));
    const switchbar = h('div', { class: 'ubm-switchbar' },
      h('button', { class: 'ubm-link', type: 'button', text: 'Show classic view', onclick: (e) => {
        const on = document.body.classList.toggle('ubm-classic');
        e.currentTarget.textContent = on ? 'Show new view' : 'Show classic view';
      } }));
    tabsEl = h('div', { class: 'ubm-tabs', role: 'tablist' });
    panel = h('div', { class: 'ubm-panel' });
    root = h('section', { class: 'ubm', 'aria-label': 'Black Merchant' }, switchbar, tabsEl, panel);
    const anchor = container.querySelector('.topbar');
    if (anchor) anchor.after(root); else container.prepend(root);
  }

  const storeStock = (st) => st.offers.filter((o) => canBuy(st, o) > 0).length;

  function renderTabs() {
    tabsEl.style.setProperty('--n', String(Math.max(1, S.stores.length)));
    tabsEl.replaceChildren(...S.stores.map((st) =>
      h('button', { class: 'ubm-tab', type: 'button', role: 'tab', 'aria-selected': String(st.id === S.active), onclick: () => { S.active = st.id; prefs.store = st.id; savePrefs(); S.query = ''; renderBody(); } },
        art(st.curImg, 'ubm-tab-ico'),
        h('span', { class: 'ubm-tab-main' }, h('b', { text: st.name }), h('small', { text: `${storeStock(st)} of ${st.offers.length} you can buy now` })),
        h('span', { class: 'ubm-tab-bal', title: st.curName, text: fmt(st.balance) }))));
  }

  function renderBody() {
    if (!root) return;
    renderTabs();
    const st = S.stores.find((s) => s.id === S.active);
    if (!st) { panel.replaceChildren(h('div', { class: 'ubm-empty', text: 'No stores found on this page.' })); return; }

    const search = h('input', { class: 'ubm-search', type: 'search', placeholder: 'Search…', value: S.query, 'aria-label': 'Search' });
    search.addEventListener('input', () => { S.query = search.value; paintList(); });
    const sort = h('select', { class: 'ubm-select', 'aria-label': 'Sort' }, [['default', 'Page order'], ['price', 'Price, low to high'], ['name', 'Name'], ['afford', 'Affordable first']]
      .map(([v, l]) => h('option', { value: v, text: l, selected: prefs.sort === v })));
    sort.addEventListener('change', () => { prefs.sort = sort.value; savePrefs(); paintList(); });
    const cb = h('input', { type: 'checkbox', checked: prefs.hideSold });
    cb.addEventListener('change', () => { prefs.hideSold = cb.checked; savePrefs(); paintList(); });
    const grid = h('div', { class: 'ubm-grid' });
    panel.replaceChildren(
      st.desc ? h('p', { class: 'ubm-store-desc', text: st.desc }) : null,
      h('div', { class: 'ubm-toolbar' }, search, sort, h('label', { class: 'ubm-check' }, cb, 'Hide sold out')),
      grid);

    function paintList() {
      const q = S.query.trim().toLowerCase();
      let list = st.offers.filter((o) => (!q || o.name.toLowerCase().includes(q)) && !(prefs.hideSold && limited(o) && o.left < 1));
      const sorters = {
        price: (a, b) => a.price - b.price || a.order - b.order,
        name: (a, b) => a.name.localeCompare(b.name),
        afford: (a, b) => (canBuy(st, b) > 0) - (canBuy(st, a) > 0) || a.order - b.order,
      };
      list = list.slice().sort(sorters[prefs.sort] || ((a, b) => a.order - b.order));
      // Sold-out items always sink to the end, whatever the sort.
      list.sort((a, b) => (limited(a) && a.left < 1) - (limited(b) && b.left < 1));
      grid.replaceChildren(...(list.length ? list.map((o) => {
        const sold = limited(o) && o.left < 1, can = canBuy(st, o) > 0;
        return h('button', { class: 'ubm-tile' + (sold ? ' is-sold' : '') + (!can && !sold ? ' is-poor' : ''), type: 'button', onclick: () => openBuy(st.id, o.id) },
          h('span', { class: 'ubm-art' }, o.img ? h('img', { src: o.img, alt: '', loading: 'lazy' }) : null, sold ? h('span', { class: 'ubm-sold', text: 'Sold out' }) : null),
          h('span', { class: 'ubm-name', text: o.name }),
          h('span', { class: 'ubm-price' }, art(st.curImg, 'ubm-cur'), h('b', { text: fmt(o.price) })),
          h('span', { class: 'ubm-stock' },
            limited(o) ? h('span', { class: 'ubm-bar' }, h('i', { style: `width:${o.max > 0 ? clamp((o.left / o.max) * 100, 0, 100) : 0}%` })) : null,
            h('span', { class: 'ubm-stock-txt', text: limited(o) ? `${fmt(o.left)} / ${fmt(o.max)} left` : 'No limit' })));
      }) : [h('div', { class: 'ubm-empty', text: 'Nothing matches.' })]));
    }
    paintList();
  }

  /* ------------------------------------------------------------------- CSS */
  const CSS = `
.ubm,.ubm-dlg{--acc:#9b8cff;--ink:#12102a}
.ubm{margin:16px 0;color:#E0E0E0}
.ubm *,.ubm-dlg *{box-sizing:border-box}
.ubm-native{display:none!important}
body.ubm-classic .ubm-native{display:block!important}
body.ubm-classic .ubm{display:none}
body.ubm-lock{overflow:hidden}
.ubm-switchbar{display:flex;justify-content:flex-end;margin:-4px 0 -8px}
.ubm-link{background:none;border:0;color:#9aa0b8;font:inherit;font-size:12px;cursor:pointer;padding:4px 2px;text-decoration:underline}
.ubm-link:hover{color:#EDEFF6}
.ubm-tabs{display:grid;grid-template-columns:repeat(var(--n,2),minmax(0,1fr));gap:10px}
.ubm-tab{appearance:none;font:inherit;color:#B9BBD1;cursor:pointer;text-align:left;display:flex;align-items:center;gap:12px;padding:12px 16px;background:#171923;border:1px solid #232437;border-radius:12px;min-width:0;transition:border-color .15s,background .15s,color .15s}
.ubm-tab:hover{background:#1c1e2b;color:#EDEFF6}
.ubm-tab[aria-selected="true"]{color:#F1F2FA;border-color:var(--acc);background:linear-gradient(180deg,color-mix(in srgb,var(--acc) 14%,#1A1B25),#1A1B25)}
.ubm-tab-ico{display:block;width:34px;height:34px;flex-shrink:0;border-radius:9px;overflow:hidden;background:#20212E}
.ubm-tab-ico img{width:100%;height:100%;object-fit:cover;display:block}
.ubm-tab-main{display:flex;flex-direction:column;min-width:0;flex:1}
.ubm-tab-main b{font-size:15px}
.ubm-tab-main small{font-size:12px;color:#9aa0b8}
.ubm-tab-bal{font-weight:700;font-size:15px;color:var(--acc);font-variant-numeric:tabular-nums}
.ubm-panel{background:#1A1B25;border:1px solid #232437;border-radius:12px;padding:14px;margin-top:10px;box-shadow:0 6px 18px rgba(0,0,0,.35)}
.ubm-store-desc{margin:0 0 12px;font-size:13px;line-height:1.45;color:#9aa0b8;max-width:72ch}
.ubm-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:14px}
.ubm-search,.ubm-select{font:inherit;font-size:13px;color:#EDEFF6;background:#12131A;border:1px solid #2B2D44;border-radius:8px;padding:8px 10px;min-width:0}
.ubm-search{width:200px}
.ubm-search:focus,.ubm-select:focus,.ubm-qty-input:focus{outline:2px solid var(--acc);outline-offset:1px}
.ubm-check{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:#B9BBD1;cursor:pointer;user-select:none}
.ubm-check input{accent-color:var(--acc)}
.ubm-btn{appearance:none;font:inherit;font-size:13px;font-weight:600;color:#EDEFF6;background:#2A2B3A;border:1px solid #2B2D44;border-radius:8px;padding:9px 14px;cursor:pointer;transition:background .15s,transform .1s}
.ubm-btn:hover:not(:disabled){background:#34364A}
.ubm-btn:disabled{opacity:.5;cursor:not-allowed}
.ubm-btn-primary{background:var(--acc);border-color:var(--acc);color:var(--ink)}
.ubm-btn-primary:hover:not(:disabled){background:var(--acc);filter:brightness(1.08)}
.ubm-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:12px}
.ubm-empty{grid-column:1/-1;padding:28px 0;text-align:center;color:#9aa0b8}
.ubm-tile{appearance:none;font:inherit;color:inherit;text-align:left;cursor:pointer;display:flex;flex-direction:column;gap:7px;padding:9px;background:#171923;border:1px solid #2B2D44;border-radius:12px;min-width:0;transition:border-color .15s,transform .12s,background .15s}
.ubm-tile:hover{border-color:var(--acc);background:#1b1d29;transform:translateY(-2px)}
.ubm-tile:active{transform:translateY(0)}
.ubm-tile:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.ubm-art{position:relative;display:block;aspect-ratio:1;border-radius:9px;overflow:hidden;background:#20212E}
.ubm-art img{width:100%;height:100%;object-fit:cover;display:block}
.ubm-sold{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(12,13,19,.62);font-weight:700;font-size:13px;color:#d6d9ee}
.ubm-tile.is-sold .ubm-art img{filter:grayscale(.85);opacity:.55}
.ubm-tile.is-sold .ubm-name,.ubm-tile.is-sold .ubm-price{color:#7f869f}
.ubm-tile.is-sold{border-style:dashed}
.ubm-name{font-weight:600;font-size:13.5px;color:#F1F2FA;line-height:1.25;min-height:2.5em;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ubm-price{display:flex;align-items:center;gap:6px;font-size:14px}
.ubm-price b{color:var(--acc);font-variant-numeric:tabular-nums}
.ubm-tile.is-poor .ubm-price b{color:#f08a8a}
.ubm-cur{display:inline-block;vertical-align:middle;width:18px;height:18px;border-radius:5px;overflow:hidden;background:#20212E;margin-right:6px;flex-shrink:0}
.ubm-price .ubm-cur{margin-right:0}
.ubm-cur img{width:100%;height:100%;object-fit:cover;display:block}
.ubm-stock{display:flex;flex-direction:column;gap:4px;margin-top:auto}
.ubm-bar{display:block;height:5px;border-radius:999px;background:#2a2b3a;overflow:hidden}
.ubm-bar i{display:block;height:100%;background:var(--acc);border-radius:999px}
.ubm-stock-txt{font-size:11.5px;color:#9aa0b8}
.ubm-backdrop{position:fixed;inset:0;z-index:10100;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.68)}
.ubm-dlg{position:relative;width:min(440px,100%);max-height:calc(100dvh - 32px);overflow:auto;background:#1A1B25;color:#E0E0E0;border:1px solid #2B2D44;border-radius:14px;padding:18px;box-shadow:0 16px 40px rgba(0,0,0,.55);font-family:'Segoe UI',Arial,sans-serif}
.ubm-x{position:absolute;top:8px;right:10px;background:none;border:0;color:#9aa0b8;font-size:24px;line-height:1;cursor:pointer;padding:4px 8px}
.ubm-x:hover{color:#fff}
.ubm-dlg-head{display:flex;gap:14px;margin-right:18px}
.ubm-dlg-art{display:block;width:92px;height:92px;flex-shrink:0;border-radius:10px;overflow:hidden;background:#20212E}
.ubm-dlg-art img{width:100%;height:100%;object-fit:cover;display:block}
.ubm-dlg-title{min-width:0}
.ubm-dlg-title h3{margin:0 0 6px;font-size:18px;color:#F1F2FA}
.ubm-dlg-tags{display:flex;gap:6px;margin-bottom:6px}
.ubm-pill{font-size:10.5px;font-weight:700;line-height:1;padding:4px 7px;border-radius:999px;background:rgba(18,19,26,.82);border:1px solid #4a4580;color:#cfc9ff}
.ubm-desc{margin:0;font-size:13px;line-height:1.45;color:#B9BBD1}
.ubm-facts{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:16px 0 10px}
.ubm-facts div{background:#171923;border:1px solid #2B2D44;border-radius:9px;padding:8px 10px;min-width:0}
.ubm-facts dt{font-size:11.5px;color:#9aa0b8;margin-bottom:2px}
.ubm-facts dd{margin:0;font-size:13px;font-weight:600;color:#F1F2FA;font-variant-numeric:tabular-nums;overflow-wrap:anywhere;display:flex;align-items:center}
.ubm-facts dd.is-bad{color:#f08a8a}
.ubm-total{margin:6px 0 0;font-size:13px;color:#B9BBD1}
.ubm-total b{color:var(--acc);font-variant-numeric:tabular-nums}
.ubm-sub{margin:14px 0 8px;font-size:13px;font-weight:600;color:#B9BBD1}
.ubm-qty-row{display:flex;flex-direction:column;gap:10px}
.ubm-qty-row.is-locked{opacity:.55;pointer-events:none}
.ubm-qty{display:inline-flex;align-self:flex-start;align-items:center;background:#12131A;border:1px solid #2B2D44;border-radius:10px;padding:3px}
.ubm-step{width:36px;height:36px;border-radius:8px;border:0;background:#232433;color:#EDEFF6;font-size:18px;font-weight:700;cursor:pointer}
.ubm-step:hover:not(:disabled){background:#2e3047}
.ubm-step:disabled{opacity:.4;cursor:not-allowed}
.ubm-qty-input{width:84px;text-align:center;font:inherit;font-size:15px;font-weight:600;color:#F1F2FA;background:transparent;border:0;-moz-appearance:textfield;font-variant-numeric:tabular-nums}
.ubm-qty-input::-webkit-outer-spin-button,.ubm-qty-input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.ubm-chips{display:flex;flex-wrap:wrap;gap:6px}
.ubm-chip{appearance:none;font:inherit;font-size:12px;font-weight:600;color:#B9BBD1;background:#171923;border:1px solid #2B2D44;border-radius:999px;padding:5px 11px;cursor:pointer}
.ubm-chip:hover:not(:disabled){color:#fff;border-color:var(--acc)}
.ubm-chip-max{color:var(--acc);border-color:color-mix(in srgb,var(--acc) 45%,#2B2D44)}
.ubm-chip:disabled{opacity:.4;cursor:not-allowed}
.ubm-result{margin-top:12px;font-size:13px;line-height:1.45;color:#B9BBD1}
.ubm-result:empty{display:none}
.ubm-result.is-ok{color:#9fd5b0}
.ubm-result.is-bad{color:#f4a3ae}
.ubm-actions{display:flex;margin-top:16px}
.ubm-go{flex:1;padding:12px 14px;font-size:14px}
.ubm-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:10200;background:#1A1B25;color:#EDEFF6;border:1px solid #2B2D44;border-radius:10px;padding:10px 16px;font-size:13px;box-shadow:0 8px 24px rgba(0,0,0,.5)}
.ubm-toast.is-bad{border-color:#6b2f3b;color:#ffb3bf}
@media (max-width:560px){
  .ubm-tabs{grid-template-columns:1fr}
  .ubm-search{width:100%;flex:1 1 100%}
  .ubm-grid{grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px}
  .ubm-backdrop{align-items:flex-end;padding:0}
  .ubm-dlg{width:100%;max-height:92dvh;border-radius:16px 16px 0 0}
}
@media (prefers-reduced-motion:reduce){.ubm *,.ubm-dlg *{transition:none!important}}
`;

  /* ------------------------------------------------------------------ start */
  function start() {
    if (!document.body || !document.querySelector('.container .storePanel')) return false;
    document.head.append(h('style', { id: 'ubm-css', text: CSS }));
    S.stores = parseStores(document);
    S.active = S.stores.some((s) => s.id === prefs.store) ? prefs.store : (S.stores[0] && S.stores[0].id) || '';
    build();
    renderBody();
    return true;
  }

  function boot() {
    let done = false;
    const tryStart = () => {
      if (done) return;
      try { done = start(); } catch (err) { console.error('[Black Merchant] failed to start:', err); done = true; }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tryStart, { once: true });
    else tryStart();
    if (!done) {
      const mo = new MutationObserver(() => { tryStart(); if (done) mo.disconnect(); });
      mo.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => mo.disconnect(), 15000);
    }
  }
  boot();
})();
