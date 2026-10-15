/* Account Switcher — Core addon (rewrite of the standalone "Account Switcher Drawer" userscript).
 * Loaded by core.user.js; `Core` is in scope. No @require / header needed.
 * Floating 👥 button + panel (Core.float). Save accounts (alias, username/email, password) and switch with one click:
 * the addon signs out and signs in with background requests, then reloads the page. No DOM patching.
 *
 * - Accounts live in ONE localStorage key (core:accountSwitcher), NOT per player: switching changes the player id.
 * - "Active" is the account whose player id matches the page you are on. The id is learned right after a switch
 *   (or by ticking "I'm signed in as this account" when adding one).
 * - The Add dialog detects the player you are signed in as right now (Core.player.info: name, level, profile picture),
 *   fills in the alias, and keeps whatever you typed if you cancel (in memory only, until the page reloads).
 * - The site's login form is described in CFG below. Change it there if the site changes its form.
 *
 * SECURITY: passwords are stored in plain text in this browser's localStorage, the same storage the game's own
 * scripts can read (the old userscript used Tampermonkey storage, which the page cannot read). Use it only on
 * a browser you trust.
 */

const ID = 'account-switcher';
const { h, btn } = Core.ui;

const CFG = {
  logoutUrl: '/signout.php',
  loginUrl: '/signin.php',                 // serves the form AND accepts the POST
  fields: { username: 'email', password: 'password', submit: 'submit' },
  submitValue: 'Sign In',
  passwordSelectors: ['input[name="password"]', 'input[type="password"]'],   // still on the page after login = failed
  errorSelectors: ['.error', '.alert', '.alert-danger', '.login-error', '#error', '[class*="error"]'],
};

// Fixed key on purpose (not 'core:<pid>:…'): the saved list has to survive switching players.
const db = Core.store('accounts', { key: 'core:accountSwitcher', def: { accounts: [], pending: null } });

const uid = () => 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const COLORS = ['#4b5ef5', '#22b8a3', '#f5a24b', '#f5514b', '#a14bf5', '#3fb96b', '#f54b9c', '#4baef5'];
const colorOf = (seed) => { let n = 0; for (const ch of String(seed)) n = (n * 31 + ch.charCodeAt(0)) >>> 0; return COLORS[n % COLORS.length]; };
const initialOf = (a) => ((a.alias || a.username || '?').trim()[0] || '?').toUpperCase();
const livePid = () => { const p = Core.player.id(); return p && p !== 'default' ? String(p) : null; };
const isActive = (a) => !!a.pid && a.pid === livePid();
// Name / level / avatar of the signed-in player (Core 3.9+; older Core only knows the id).
const who = () => (Core.player.info ? Core.player.info() : { id: livePid(), name: null, level: null, avatar: null });

// A switch ends in a page reload. On that next load, remember which player id the account turned out to be.
// (If the id is unchanged we can't tell a stale id from the same account, so nothing is learned.)
(function learnPid() {
  const p = db.get().pending, pid = livePid();
  if (!p || !pid) return;
  db.update((d) => {
    const a = d.accounts.find((x) => x.id === p.id);
    if (a && pid !== p.prevPid) a.pid = pid;
    d.pending = null;
  });
})();

// Keep the active account's picture and level fresh.
(function syncIdentity() {
  const w = who(), pid = livePid();
  const a = pid && db.get().accounts.find((x) => x.pid === pid);
  if (!a || !((w.avatar && a.avatar !== w.avatar) || (w.level && a.level !== w.level))) return;
  db.update((d) => {
    const t = d.accounts.find((x) => x.pid === pid);
    if (w.avatar) t.avatar = w.avatar;
    if (w.level) t.level = w.level;
  });
})();

/* ---------------------------------------------------------------- styles --- */
Core.ui.css(ID, `
  .as-top{ display:flex; gap:10px; align-items:center; margin-bottom:14px; }
  .as-top .core-input{ flex:1 1 180px; }
  .as-count{ color:#9caad0; font-size:12px; white-space:nowrap; }

  .as-grid{ display:grid; grid-template-columns:repeat(auto-fill,minmax(210px,1fr)); gap:12px; }
  .as-card{ display:flex; flex-direction:column; gap:10px; position:relative; outline:none;
    background:#11192d; border:1px solid rgba(255,255,255,.06); border-radius:16px; padding:12px;
    transition:transform .15s ease, box-shadow .15s ease, border-color .15s ease, background .15s ease; }
  /* The whole card is the button (same hover feel as the other presets' cards). */
  .as-card[role=button]{ cursor:pointer; }
  .as-card[role=button]:hover, .as-card[role=button]:focus-visible{
    transform:translateY(-2px); border-color:rgba(110,168,255,.3); box-shadow:0 8px 20px rgba(0,0,0,.35); background:#141d38; }
  .as-card[role=button]:focus-visible{ box-shadow:0 0 0 2px rgba(110,168,255,.45) inset, 0 8px 20px rgba(0,0,0,.35); }
  .as-card[role=button]:active{ transform:translateY(0); }
  .as-card.active{ border-color:rgba(51,181,127,.55); background:linear-gradient(180deg,#132a22,#11192d 70%); }

  .as-card-top{ display:flex; justify-content:space-between; align-items:flex-start; }
  .as-avatar{ width:44px; height:44px; border-radius:14px; flex-shrink:0; display:flex; align-items:center; justify-content:center; overflow:hidden;
    font:800 18px Arial,sans-serif; color:#fff; box-shadow:inset 0 0 0 1px rgba(255,255,255,.2), 0 4px 10px rgba(0,0,0,.35); }
  .as-avatar img{ width:100%; height:100%; object-fit:cover; display:block; }
  .as-avatar.big{ width:64px; height:64px; border-radius:20px; font-size:26px; }
  .as-more{ background:none; border:none; color:#7f8ab8; font:800 18px/1 Arial,sans-serif; cursor:pointer;
    width:28px; height:28px; border-radius:9px; opacity:0; transition:opacity .15s ease, background .15s ease; }
  .as-card:hover .as-more, .as-more:focus-visible, .as-more[data-core-menu-anchor]{ opacity:1; }
  .as-more:hover{ background:rgba(255,255,255,.08); color:#fff; }
  @media (hover:none){ .as-more{ opacity:1; } }

  /* Text takes the spare height, so every card in a row is the same height and the footers line up. */
  .as-card-text{ flex:1 1 auto; min-width:0; }
  .as-alias{ font:800 14px Arial,sans-serif; color:#eef3ff; overflow-wrap:anywhere; }
  .as-user{ font-size:12px; color:#9caad0; margin-top:3px; overflow-wrap:anywhere; word-break:break-all; }
  .as-card-foot{ border-top:1px solid rgba(255,255,255,.06); padding-top:9px; font:700 12px Arial,sans-serif;
    display:flex; justify-content:space-between; align-items:center; gap:8px; }
  .as-lv{ color:#9caad0; font:700 11px Arial,sans-serif; }
  .as-go{ display:inline-block; color:#8fa0ff; transition:transform .15s ease, color .15s ease; }
  .as-card:hover .as-go{ transform:translateX(3px); color:#b7c3ff; }
  .as-live{ color:#8ee6a8; }

  .as-form{ display:flex; flex-direction:column; gap:14px; }
  .as-form-head{ display:flex; align-items:center; gap:14px; }
  .as-form-head .as-avatar{ width:56px; height:56px; border-radius:18px; font-size:22px; }
  .as-form-sub{ color:#9caad0; font-size:12px; margin-top:3px; }
  .as-field label{ display:block; font:700 11px Arial,sans-serif; color:#9caad0; margin-bottom:6px; letter-spacing:.02em; }
  /* The site styles every input[type=text] (background, border, padding). Flipping the password field to
     type=text for "show" made it pick that up and jump, so these rules out-rank it (element + 2 classes). */
  .as-form input.core-input, .as-form textarea.core-input{ width:100%; box-sizing:border-box; border:1px solid #2b3859;
    border-radius:10px; background:#0d1322; color:#eef3ff; padding:8px 10px; font:13px Arial,sans-serif; outline:none; }
  .as-form input.core-input:focus, .as-form textarea.core-input:focus{ border-color:#4b6dd0; }
  .as-form textarea.as-ta{ font:12px/1.5 monospace; }
  .as-pass{ position:relative; }
  .as-form .as-pass input.core-input{ padding-right:42px; }
  .as-pass input::-ms-reveal, .as-pass input::-ms-clear{ display:none; }
  .as-link{ background:none; border:none; padding:0; margin-left:6px; color:#8fa0ff; font:700 12px Arial,sans-serif; cursor:pointer; text-decoration:underline; }
  .as-eye{ position:absolute; right:5px; top:50%; transform:translateY(-50%); background:none; border:none; cursor:pointer;
    font-size:15px; width:30px; height:30px; border-radius:8px; opacity:.7; }
  .as-eye:hover{ opacity:1; background:rgba(255,255,255,.08); }
  .as-check{ display:flex; gap:8px; align-items:flex-start; color:#cfd8f7; font-size:12.5px; cursor:pointer; line-height:1.4; }
  .as-check input{ margin-top:2px; }
  .as-ta{ width:100%; font:12px/1.5 monospace; resize:vertical; min-height:150px; }

  .as-switch-body{ display:flex; flex-direction:column; align-items:center; text-align:center; gap:10px; padding:6px 0 2px; }
  .as-switch-title{ font:700 16px Arial,sans-serif; color:#eef3ff; overflow-wrap:anywhere; }
  .as-status{ min-height:18px; color:#9caad0; font-size:12.5px; }
  .as-status.err{ color:#ff8a97; }
  .as-status.busy::before{ content:''; display:inline-block; width:11px; height:11px; margin-right:8px; vertical-align:-1px;
    border:2px solid rgba(255,255,255,.2); border-top-color:#8fa0ff; border-radius:50%; animation:as-spin .7s linear infinite; }
  @keyframes as-spin{ to{ transform:rotate(360deg); } }
`);

/* --------------------------------------------------------------- helpers --- */
// The profile picture when we have one (falls back to the coloured initial if it fails to load).
function fillAvatar(el, acc) {
  el.style.background = colorOf(acc.alias || acc.username || acc.id || '?');
  el.replaceChildren(initialOf(acc));
  if (!acc.avatar) return;
  const img = h('img', { src: acc.avatar, alt: '', onerror: () => { img.remove(); el.textContent = initialOf(acc); } });
  el.replaceChildren(img);
}
function avatar(acc, big) {
  const el = h('div', { class: 'as-avatar' + (big ? ' big' : '') });
  fillAvatar(el, acc);
  return el;
}

function confirmBox(title, body, label, onYes) {
  const m = Core.ui.modal({ id: 'as-confirm', title, width: 400 });
  m.setBody(h('p', { style: { margin: 0, color: '#cfd8f7' } }, body));
  m.setActions([
    { spacer: true },
    { label: 'Cancel', kind: 'soft', close: true },
    { label, kind: 'danger', onClick: onYes, close: true },
  ]);
  m.setTitle(title);
  m.open();
}

function askDelete(acc) {
  confirmBox('Delete account', 'Remove "' + acc.alias + '" from this list? This only forgets it here; the game account is not touched.', 'Delete', () => {
    db.update((d) => { d.accounts = d.accounts.filter((a) => a.id !== acc.id); });
    Core.ui.toast('Deleted "' + acc.alias + '".', true);
  });
}

/* ------------------------------------------------------------- switching --- */
// Sign out, then POST the login form with background requests. A login that comes back still showing a
// password field failed; the site's own error text (if any) is passed on.
async function signInAs(acc) {
  await fetch(new URL(CFG.logoutUrl, location.origin), { credentials: 'include' }).catch(() => { /* a redirect fetch dislikes: fine */ });
  const params = { [CFG.fields.username]: acc.username, [CFG.fields.password]: acc.password };
  if (CFG.fields.submit) params[CFG.fields.submit] = CFG.submitValue;
  const res = await Core.net.post(CFG.loginUrl, params);
  if (!res.ok) throw new Error('Login request failed (HTTP ' + res.status + ').');
  const doc = new DOMParser().parseFromString(res.text, 'text/html');
  if (CFG.passwordSelectors.some((s) => doc.querySelector(s))) {
    const err = CFG.errorSelectors.map((s) => doc.querySelector(s)).find(Boolean);
    throw new Error((err && err.textContent.trim()) || 'Login failed. Check the saved username and password.');
  }
}

function openSwitch(acc) {
  const m = Core.ui.modal({ id: 'as-switch', title: 'Switch account', width: 420 });
  const cur = db.get().accounts.find(isActive);
  const status = h('div', { class: 'as-status' });
  m.setBody(h('div', { class: 'as-switch-body' },
    avatar(acc, true),
    h('div', { class: 'as-switch-title' }, 'Switch to ', h('b', {}, acc.alias), '?'),
    h('div', { class: 'core-dim' }, (cur ? 'You will be signed out of ' + cur.alias : 'You will be signed out') + ' and this page will reload.'),
    status));

  const go = async () => {
    m.setActions([{ spacer: true }, { label: 'Switching…', kind: 'soft' }]);
    m.foot.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    status.className = 'as-status busy';
    status.textContent = 'Signing out and back in…';
    try {
      await signInAs(acc);
      db.update((d) => { d.pending = { id: acc.id, prevPid: livePid() }; });
      Core.net.invalidate();                       // cached pages belong to the old player, in every tab
      status.textContent = 'Signed in. Reloading…';
      location.reload();
    } catch (err) {
      status.className = 'as-status err';
      status.textContent = (err && err.message || 'Could not switch.') + ' You may be signed out now; try again.';
      actions();
    }
  };
  const actions = () => m.setActions([
    { spacer: true },
    { label: 'Cancel', kind: 'soft', close: true },
    { label: 'Switch', kind: 'success', onClick: go },
  ]);
  actions();
  m.open();
}

/* ---------------------------------------------------------- add / edit ---- */
// An unsaved "new account" form survives Cancel / ✕ / Esc / clicking outside (memory only: it holds a password,
// so it is dropped on reload). It is cleared once the account is saved.
let draft = null, editCtx = null;

function openEdit(acc) {
  const isNew = !acc;
  const m = Core.ui.modal({ id: 'as-edit', width: 440, onClose: () => { if (editCtx) { editCtx.stash(); editCtx = null; } } });
  m.setTitle(isNew ? 'Add account' : 'Edit account');

  const w = who(), pid = livePid();
  const unsaved = isNew && !!pid && !db.get().accounts.some((a) => a.pid === pid);   // you're signed in as someone not saved yet
  const detected = unsaved && (w.name || w.avatar) ? w : null;
  const d = isNew ? draft : null;

  const mk = (props) => h('input', Object.assign({ class: 'core-input', autocomplete: 'off' }, props));
  const alias = mk({ placeholder: 'e.g. Main, Alt 1', value: acc ? acc.alias : ((d && d.alias) || (detected && detected.name) || ''), maxlength: '40' });
  const user = mk({ placeholder: 'Email / username', value: acc ? acc.username : (d ? d.user : '') });
  const pass = mk({ type: 'password', placeholder: 'Password', value: acc ? acc.password : (d ? d.pass : ''), autocomplete: 'new-password' });
  const eye = h('button', { class: 'as-eye', type: 'button', title: 'Show / hide password', onclick: () => {
    pass.type = pass.type === 'password' ? 'text' : 'password';
    eye.textContent = pass.type === 'password' ? '👁' : '🙈';
  } }, '👁');
  const err = h('div', { class: 'core-err' });

  // "I'm signed in as this account": ties the saved account to the current player (Active badge, picture, level).
  const here = unsaved ? h('input', { type: 'checkbox' }) : null;
  if (here) here.checked = d ? !!d.here : !!detected;

  const preview = h('div', { class: 'as-avatar' });
  const nameEl = h('div', { class: 'as-switch-title' });
  const paint = () => {
    nameEl.textContent = alias.value.trim() || user.value.trim() || (isNew ? 'New account' : 'Unnamed');
    fillAvatar(preview, { alias: alias.value.trim() || user.value.trim(), avatar: acc ? acc.avatar : (here && here.checked ? w.avatar : null) });
  };
  [alias, user].forEach((i) => i.addEventListener('input', paint));
  if (here) here.addEventListener('change', paint);
  paint();

  const sub = h('div', { class: 'as-form-sub' });
  if (d) {
    sub.append('Unsaved draft restored.', h('button', { class: 'as-link', type: 'button', onclick: () => {
      draft = null;
      // Truly blank, so you can add an account you are NOT signed in as: no detected name, "signed in" box unticked.
      alias.value = ''; user.value = ''; pass.value = ''; err.textContent = '';
      if (here) here.checked = false;
      paint(); alias.focus();
    } }, 'Start over'));
  } else if (detected) {
    sub.textContent = 'Detected you: ' + (w.name || 'this player') + (w.level ? ' · LV ' + w.level : '') + '. Add the login below.';
  } else sub.textContent = 'Saved in this browser only.';

  const field = (label, control) => h('div', { class: 'as-field' }, h('label', {}, label), control);
  const fail = (msg, el) => { err.textContent = msg; el.focus(); };

  let done = false;
  editCtx = { stash() {
    if (!isNew || done) return;
    draft = (alias.value || user.value || pass.value) ? { alias: alias.value, user: user.value, pass: pass.value, here: !!(here && here.checked) } : null;
  } };

  const save = () => {
    const u = user.value.trim(), p = pass.value;
    if (!u) return fail('Enter the email / username.', user);
    if (!p) return fail('Enter the password.', pass);
    const a = alias.value.trim() || u;
    db.update((dd) => {
      if (isNew) {
        const n = { id: uid(), alias: a, username: u, password: p };
        if (here && here.checked) { n.pid = pid; if (w.avatar) n.avatar = w.avatar; if (w.level) n.level = w.level; }
        dd.accounts.push(n);
      } else {
        const t = dd.accounts.find((x) => x.id === acc.id);
        if (!t) return;
        if (t.username !== u) { delete t.pid; delete t.avatar; delete t.level; }   // a different login: what we learned no longer applies
        Object.assign(t, { alias: a, username: u, password: p });
      }
    });
    done = true; if (isNew) draft = null;
    m.close();
    Core.ui.toast(isNew ? 'Added "' + a + '".' : 'Saved "' + a + '".', true);
  };
  [alias, user, pass].forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } }));

  m.setBody(h('div', { class: 'as-form' },
    h('div', { class: 'as-form-head' }, preview, h('div', {}, nameEl, sub)),
    field('Alias', alias),
    field('Email / username', user),
    field('Password', h('div', { class: 'as-pass' }, pass, eye)),
    here ? h('label', { class: 'as-check' }, here, h('span', {}, 'I\'m signed in as this account right now (shows it as Active, with its picture)')) : null,
    err));

  m.setActions([
    ...(isNew ? [] : [{ label: 'Delete', kind: 'danger', onClick: () => { done = true; m.close(); askDelete(acc); } }]),
    { spacer: true },
    { label: 'Cancel', kind: 'soft', close: true },
    { label: isNew ? 'Add' : 'Save', kind: 'success', onClick: save },
  ]);
  m.open();
  (isNew && !alias.value ? alias : user).focus();
}

/* --------------------------------------------------------- import / export --- */
function openIO() {
  const m = Core.ui.modal({ id: 'as-io', title: 'Import / Export', width: 520 });
  const ta = h('textarea', { class: 'core-input as-ta', spellcheck: 'false', placeholder: 'Paste accounts here to import (a JSON list)…' });
  m.setBody(h('div', { class: 'as-form' },
    h('div', { class: 'core-dim' }, 'Export copies your saved accounts as JSON, passwords included in plain text. Import adds the pasted accounts, skipping any email you already have (the alias doesn\'t matter).'),
    ta));
  m.setActions([
    { label: '⧉ Copy export', kind: 'soft', onClick: async () => {
      const list = db.get().accounts.map(({ alias: a, username, password }) => ({ alias: a, username, password }));
      try { await navigator.clipboard.writeText(JSON.stringify(list, null, 2)); Core.ui.toast('Copied ' + list.length + ' account(s).', true); }
      catch (_) { ta.value = JSON.stringify(list, null, 2); ta.select(); Core.ui.toast('Copy blocked: the JSON is in the box.', false); }
    } },
    { spacer: true },
    { label: 'Close', kind: 'soft', close: true },
    { label: 'Import', kind: 'success', onClick: () => {
      let src;
      try { src = JSON.parse(ta.value); } catch (_) { Core.ui.toast('That isn\'t valid JSON.', false); return; }
      const rows = (Array.isArray(src) ? src : src && src.accounts) || [];
      let added = 0, dupes = 0;
      db.update((d) => {
        // An account is the same account when its EMAIL is the same (ignoring case and stray spaces), whatever alias it
        // goes by. This also drops repeats inside the pasted list itself. Rows may call the field "email" or "username".
        const key = (s) => String(s || '').trim().toLowerCase();
        const have = new Set(d.accounts.map((a) => key(a.username)));
        rows.forEach((r) => {
          if (!r || typeof r !== 'object') return;
          const login = typeof r.email === 'string' && r.email.trim() ? r.email : r.username;
          if (typeof login !== 'string' || typeof r.password !== 'string' || !login.trim()) return;
          const u = login.trim();
          if (have.has(key(u))) { dupes++; return; }
          have.add(key(u));
          d.accounts.push({ id: uid(), alias: String(r.alias || '').trim() || u, username: u, password: r.password });
          added++;
        });
      });
      const skipped = dupes ? ' Skipped ' + dupes + ' with an email you already have.' : '';
      Core.ui.toast(added ? 'Imported ' + added + ' account(s).' + skipped : (dupes ? 'Nothing new: all ' + dupes + ' emails are already saved.' : 'Nothing new to import.'), !!added);
      if (added) m.close();
    } },
  ]);
  m.open();
}

/* ----------------------------------------------------------------- panel --- */
function accountCard(acc) {
  const active = isActive(acc);
  const more = h('button', { class: 'as-more', type: 'button', title: 'Edit or delete' }, '⋯');
  const items = [
    { label: '✏️ Edit', onClick: () => openEdit(acc) },
    { label: '🗑️ Delete', danger: true, onClick: () => askDelete(acc) },
  ];
  // Hover the ⋯ to open the menu (a click opens it too, and keeps it open: that is how touch screens use it).
  // Older Core without hoverMenu falls back to the click-only menu.
  if (Core.ui.hoverMenu) Core.ui.hoverMenu(more, items);
  else more.addEventListener('click', (e) => { e.stopPropagation(); Core.ui.menu(more, items); });
  const card = h('div', active ? { class: 'as-card active' } : { class: 'as-card', role: 'button', tabindex: '0', title: 'Switch to ' + acc.alias },
    h('div', { class: 'as-card-top' }, avatar(acc), more),
    h('div', { class: 'as-card-text' }, h('div', { class: 'as-alias' }, acc.alias), h('div', { class: 'as-user' }, acc.username)),
    h('div', { class: 'as-card-foot' }, active ? h('span', { class: 'as-live' }, '● Active') : h('span', { class: 'as-go' }, 'Switch →'),
      acc.level ? h('span', { class: 'as-lv' }, 'LV ' + acc.level) : null));
  if (!active) {
    const pick = () => openSwitch(acc);
    card.addEventListener('click', pick);
    card.addEventListener('keydown', (e) => { if (e.target === card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pick(); } });
  }
  return card;
}

Core.float.add({
  id: ID, title: 'Account Switcher', icon: '👥', order: 40, width: 780,

  render(el) {
    const { accounts } = db.get();
    const list = h('div', {});
    const draw = (q) => {
      const s = String(q || '').trim().toLowerCase();
      const shown = accounts.filter((a) => !s || a.alias.toLowerCase().includes(s) || a.username.toLowerCase().includes(s));
      if (!accounts.length) list.replaceChildren(h('div', { class: 'core-empty' }, 'No accounts saved yet. Add one below, then switch with a single click.'));
      else if (!shown.length) list.replaceChildren(h('div', { class: 'core-empty' }, 'No account matches "' + q + '".'));
      else list.replaceChildren(h('div', { class: 'as-grid' }, shown.map(accountCard)));
    };

    const top = accounts.length > 4
      ? h('div', { class: 'as-top' },
        h('input', { class: 'core-input', placeholder: 'Find an account…', autocomplete: 'off', oninput: (e) => draw(e.target.value) }),
        h('span', { class: 'as-count' }, accounts.length + ' saved'))
      : null;

    el.replaceChildren(...[
      top, list,
      h('div', { class: 'core-footer' },
        btn('⇅ Import / Export', 'soft', openIO),
        h('div', { class: 'core-spacer' }),
        btn('+ Add Account', 'success', () => openEdit(null)))].filter(Boolean));
    draw('');
  },
});

// Any change (this tab or another) redraws the panel if it is open.
db.watch(() => Core.float.refresh(ID));
