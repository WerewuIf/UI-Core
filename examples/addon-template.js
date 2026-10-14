/* addon-template.js — copy this file, rename it, delete what you don't need.
 *
 * An addon is a PLAIN .js file at a URL: no ==UserScript== header, no @require.
 * `Core` is already in scope (it's also window.Core). Read REFERENCE.md for the full API.
 *
 * To try it without touching GitHub: ⚙️ button → "Add by URL" → paste this file's URL.
 * To ship it: put it in addons/, add one line to addons.json, commit, reload twice.
 */

const ID = 'my-addon';                         // unique; used for the button, storage and enable/disable

// Persistent settings, saved per player in localStorage, shared across tabs.
const settings = Core.store(ID, { def: { opens: 0 } });


/* ---- A. A floating button + panel -------------------------------------------------------
 * This is how an addon gets UI. Core draws the button in the shared floating row (spaced
 * automatically, clear of the site's own buttons), owns the modal, and calls render() every
 * time the panel opens. Delete this block if your addon only tweaks the page. */
Core.float.add({
  id: ID,
  title: 'My Addon',
  icon: '🧪',
  order: 50,                    // position in the row: lower = further right. See REFERENCE.md §4
  width: 700,                   // optional, px

  async render(el) {            // `el` is an empty div inside the panel — fill it
    settings.update((s) => { s.opens++; });
    el.innerHTML = '<div class="core-empty">Loading…</div>';

    // Core.pages.* gives you a Document of a site page. It reuses the live page if you're
    // already on it, otherwise a cached fetch shared with every other addon.
    const doc = await Core.pages.inventory('attack');
    const equipped = doc.querySelectorAll('.section[data-section-key$="-equipped"] .slot-box').length;

    el.replaceChildren(
      Core.ui.h('p', {}, `Equipped items in your PvE set: ${equipped}`),
      Core.ui.h('p', { class: 'core-dim' }, `Opened ${settings.get().opens} time(s) on this account.`),
      Core.ui.h('div', { class: 'core-row' },
        Core.ui.btn('Refetch', 'soft', async () => {
          await Core.pages.inventory('attack', { force: true });   // bypass the cache
          Core.float.refresh(ID);                                  // re-run render()
          Core.ui.toast('Refetched');
        }),
        Core.ui.btn('Close', null, () => Core.float.close(ID))
      )
    );
  },
  // onShow(el) { }   // runs after render
  // onHide()   { }   // runs when the panel closes
});


/* ---- B. Tweak a page --------------------------------------------------------------------
 * Restrict WHERE an addon runs with "match" in addons.json (a regex on path+query, e.g.
 * "^/pets\\.php"); a non-matching page doesn't even download the file. Core.dom.watch runs
 * your function now and again after DOM changes (debounced) — make it IDEMPOTENT. */
Core.dom.watch(() => {
  const nav = document.querySelector('.side-drawer');
  if (!nav || nav.dataset.myAddonDone) return;
  nav.dataset.myAddonDone = '1';
  // ...change the page here...
});


/* ---- C. React to what the site does ----------------------------------------------------
 * Observe the page's own requests: no extra network, the page is untouched. */
Core.net.watch(/inventory_ajax\.php/, ({ text, json }) => {
  // json is the parsed response (or null). Use it to update your UI / badges.
});
