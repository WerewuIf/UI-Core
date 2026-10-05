# Core

Core adds a row of small buttons to the game, styled like the game's own. Each one opens a tool without leaving the page:

| Button | What it does |
|---|---|
| 💎 | **Crystal Presets**: save and restore your power-crystal setups |
| ⚔️ | **Gear Presets**: save and apply equipment sets |
| 🐾 | **Pet Presets**: save and apply pet teams, including their sigils and elemental orbs |
| ⚙️ | **Addons**: see what's loaded, turn things on or off |

It also tidies a few game pages (guild, home, battle) in the background.

---

## Install (about 2 minutes)

**1. Get Tampermonkey.** It's a free browser extension that runs scripts on websites: [tampermonkey.net](https://www.tampermonkey.net/) (Chrome, Edge, Firefox, Safari).

**2. Turn off any old versions.** Open Tampermonkey's dashboard and switch **off** these if you have them (leaving them on makes everything run twice):

- Power Crystals — Presets
- Inventory Helper + Gear Presets
- UI Cleanup
- Pet Team Presets
- Battle Page Restructure
- any "DS Central" script

**3. Install Core.** Open this link and click **Install**:

**https://raw.githubusercontent.com/WerewuIf/UI-Core/main/core.user.js**

**4. Open the game and reload the page** (hold **Shift** and press **Reload**, or press **Ctrl+Shift+R**).

You should now see the buttons in the bottom-right corner: **💎 ⚔️ 🐾 ⚙️**. The first load takes a moment while Core downloads its tools; after that it's instant.

**Your saved presets carry over automatically.** You don't need to export or import anything.

---

## Using it

- Click a button to open its panel. Click **×**, press **Esc**, or click outside to close it.
- Click **⚙️** to see every tool. A green **OK** means it's running. **SKIPPED** just means that tool isn't needed on the page you're on.
- Untick a tool in **⚙️** to turn it off, then reload the page.

**Updates are automatic.** If a tool is updated you'll see a message saying *"updated — reload to apply"*. Just reload the page. Core itself is updated by Tampermonkey (it checks about once a day; you can also click **Check for userscript updates** in its dashboard).

**Which version do I have?** Open **⚙️**. The top line says **Core v…**.

---

## Something not working?

| Problem | Try this |
|---|---|
| No buttons appear | Make sure Tampermonkey is on and **Core** is enabled in its dashboard, then reload with **Ctrl+Shift+R**. |
| Buttons appear twice, or things act strangely | An old script is still on. Turn off the old ones from step 2. |
| Only ⚙️ shows | Reload once or twice. If it's still just ⚙️, check your internet connection and reload again. |
| A tool shows a red row in ⚙️ | Click the **↻** button on that row and reload. If it stays red, tell whoever gave you the link and tell them what the row says. |
| Things look old, or a fix doesn't show up | Reloading the page doesn't update the script itself. Open **⚙️** and check the version, then re-open the install link in step 3 and click **Reinstall** / **Update**. |
| Still stuck | Open **⚙️ → Clear cache**, then reload. |

---

## Turn it off

- **Temporarily:** switch **Core** off in Tampermonkey's dashboard and reload.
- **Go back to the old scripts:** switch Core off and switch your old scripts back on. Your presets are untouched either way.
