/* build-engine.js — Core addon: damage prediction and "best build" search for PvE bosses, and a safe apply/revert.
 *
 * The damage formulas, the optimizer search and the page readers are the Veyra Build Optimizer v11.81 (No Gate)
 * code, kept as it was (marked ENGINE below) so the numbers match the userscript. Everything around it is new:
 *   - the pages it reads are Core.model resources (shared with every addon and tab, harvested for free);
 *   - equipping goes through Core.tx ('loadout': lock, journal, verify, automatic restore, orphan recovery);
 *   - the optimizer's panel, mob crawl and PvP tab are NOT ported. Mob stats are read lazily, one boss at a time.
 *
 * Offers (capabilities, REFERENCE.md §17.6):
 *   build.predict(mob, sel?, opts?)       -> { ok, result }              damage of the CURRENT build (or of `sel`) on a boss
 *   build.best(mob, opts?)                -> { ok, best, current, gainPct, ... }   search, changes nothing
 *   build.apply(planOrSel, opts?)         -> { ok, message, changed }    equip a result of build.best (or a `sel`) through Core.tx
 *   build.revert()                        -> { ok, message }             put back what the last build.apply replaced
 *   preset.best.list() / preset.best.apply(id, { target, threshold?, mode?, silent? })   for the automator
 *
 *   mob  = a monster id ("1234"), or { monsterId, name?, atk?, def?, petDef?, eqDef?, element?, ... } (given fields win)
 *   sel  = { mains:[name x3], link1:[name x3], link2:[name x3], gear:{ Weapon:name, ... } }   (names, as the optimizer's dropdowns)
 *   opts = { mode:'noncrit'|'dps', rules:{ exclude:{name:true}, must:{name:true} }, force, critMult, critRate }
 */
(() => {
  'use strict';
  const ID = 'build-engine', VERSION = '1.0.5';
  if (!(Core.apiLevel >= 6 && Core.model && Core.tx)) {
    console.warn('[build-engine] needs Core api level 6 (Core.model + Core.tx); not loaded');
    return;
  }

  /* ===================================================================================
   * ENGINE — from Veyra Build Optimizer v11.81 (No Gate). Edits: the three page readers
   * (scrapeInventory / scrapePets / scrapeClass) take a parsed page instead of fetching
   * it, and the pet-links requests moved out of scrapePets (see `team` below).
   * ================================================================================= */
  const C = {
    BASE_CONST: 225,
    EQUIP_PER_ATK: 20,
    FLOOR: 30,
    S: 1,
    ATK_EXP: 0.25,
    BASTIOR_SOFTCAP: 4e3,
    BASTIOR_A: 8e3,
    BASTIOR_B: 8e3,
    BASTIOR_K: 13.4,
    GROND_SOFTCAP: 4e3,
    GROND_A: 8e3,
    GROND_B: 8e3,
    GROND_K: 15.415,
    CINDERBACK_SOFTCAP: 2500,
    CINDERBACK_A: 8e3,
    CINDERBACK_B: 8e3,
    CB_MOBDEF: 0.7,
    PEN_GRAKTHAR: 0.3,
    PEN_CAP: 0.4,
    ELEM_150K: 15e4,
    ELEM_BONUS: 1,
    DRAGON_PER_PIECE: 0.06,
    SPEC: 0,
    STAM: 1,
    POISON: 0,
  };
  const COUNTERS = {
    FIRE: ["NATURE", "FROST"],
    NATURE: ["LIGHT", "VOID"],
    FROST: ["WATER", "THUNDER"],
    THUNDER: ["WATER", "NATURE"],
    WATER: ["FIRE", "LIGHT"],
    VOID: ["FIRE", "THUNDER"],
    LIGHT: ["VOID", "FROST"],
  };
  const EQUIP_SLOTS = [
    "Weapon",
    "Class Weapon",
    "Helmet",
    "Armor",
    "Boots",
    "Gloves",
    "Ring",
    "Ring 2",
    "Amulet",
  ];
  const PVE_DISABLED_PETS = ["eryndor"];
  const MSTAT_LABELS = [
    "ATTACK",
    "DEFENSE",
    "PET DEFENSE",
    "EQUIPMENT DEFENSE",
    "ELEMENT",
    "ELEMENT RATE",
    "REWARDS UP TO",
    "CRIT RATE RESISTANCE",
    "CRIT DAMAGE RESISTANCE",
    "FINAL DAMAGE RESISTANCE",
    "PASSIVE DAMAGE RESISTANCE",
  ];
  function mstatRe(lab) {
    return new RegExp(lab.replace(/ /g, "\\s+"), "i");
  }
  function visibleText(root) {
    if (!root) return "";
    let src = root;
    try {
      if (root.cloneNode) {
        const c = root.cloneNode(true);
        if (c.querySelectorAll) {
          const junk = c.querySelectorAll("style,script,noscript,template");
          for (let i = 0; i < junk.length; i++)
            junk[i].parentNode && junk[i].parentNode.removeChild(junk[i]);
        }
        src = c;
      }
    } catch (e) {
      src = root;
    }
    return String(src.textContent || "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .join("\n");
  }
  function mstatValue(text, lab) {
    const m = mstatRe(lab).exec(text);
    if (!m) return null;
    const rest = text.slice(m.index + m[0].length);
    let stop = rest.length;
    const nl = rest.indexOf("\n");
    nl >= 0 && (stop = Math.min(stop, nl));
    const mk = rest.indexOf("_");
    mk >= 0 && (stop = Math.min(stop, mk));
    for (let j = 0; j < MSTAT_LABELS.length; j++) {
      const r = mstatRe(MSTAT_LABELS[j]).exec(rest);
      r && r.index > 0 && (stop = Math.min(stop, r.index));
    }
    const same = rest.slice(0, stop).trim();
    if (same) return same;
    const lines = rest.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const v = lines[i].trim();
      if (v && !/^_+$/.test(v)) return v;
    }
    return null;
  }
  function mstatNum(v) {
    if (v === void 0 || v === null) return null;
    const m = String(v)
      .replace(/,/g, "")
      .match(/-?[0-9]+(\.[0-9]+)?/);
    return m ? parseFloat(m[0]) : null;
  }
  function mstatWindow(text) {
    const t = String(text || "");
    const m = /EQUIPMENT\s+DEFENSE/i.exec(t);
    if (!m) return t;
    const head = t.slice(0, m.index);
    const lastAtk = head.toUpperCase().lastIndexOf("ATTACK");
    return t.slice(
      lastAtk >= 0 ? lastAtk : Math.max(0, m.index - 400),
      m.index + 1200,
    );
  }
  function parseMonsterStatsText(text) {
    let t = mstatWindow(text);
    const out = {};
    MSTAT_LABELS.slice()
      .sort((a, b) => b.length - a.length)
      .forEach((lab) => {
        const v = mstatValue(t, lab);
        if (v === null) return;
        out[lab] = v;
        t = t.replace(mstatRe(lab), new Array(lab.length + 1).join("_"));
      });
    return out;
  }
  function applyModalStats(mob, text) {
    const ms = parseMonsterStatsText(text);
    if (!Object.keys(ms).length) return false;
    const a = mstatNum(ms["ATTACK"]);
    a !== null && (mob.atk = a);
    const d = mstatNum(ms["DEFENSE"]);
    d !== null && (mob.def = d);
    const pd = mstatNum(ms["PET DEFENSE"]);
    pd !== null && (mob.petDef = pd);
    const ed = mstatNum(ms["EQUIPMENT DEFENSE"]);
    ed !== null && (mob.eqDef = ed);
    ms["ELEMENT"] !== void 0 &&
      (mob.element = String(ms["ELEMENT"]).toUpperCase());
    const er = mstatNum(ms["ELEMENT RATE"]);
    er !== null && (mob.elemRate = er);
    mob.critRateRes = mstatNum(ms["CRIT RATE RESISTANCE"]);
    mob.critDmgRes = mstatNum(ms["CRIT DAMAGE RESISTANCE"]);
    mob.finalDmgRes = mstatNum(ms["FINAL DAMAGE RESISTANCE"]);
    mob.passiveDmgRes = mstatNum(ms["PASSIVE DAMAGE RESISTANCE"]);
    mob.modalStats = ms;
    return true;
  }
  function pickMobCards(doc) {
    const primary = Array.prototype.slice.call(
      doc.querySelectorAll('.monster-card:not([data-dead="1"])'),
    );
    const extra = Array.prototype.slice
      .call(doc.querySelectorAll('[data-monster-id]:not([data-dead="1"])'))
      .filter(function (el) {
        return !primary.some(function (p) {
          return p === el || (p.contains && p.contains(el));
        });
      });
    return primary.concat(extra);
  }
  const RELIC_LABELS = [
    "Attack",
    "Defense",
    "Lifesteal boost",
    "Crit damage resistance",
    "Crit rate resistance",
    "Enemy Attack reduction",
    "Enemy Defense reduction",
    "PvE damage",
    "Damage against Goblins",
  ];
  let RELICS = {
    pveDamage: 0,
    enemyAtkRed: 0,
    enemyDefRed: 0,
    atk: 0,
    def: 0,
    goblinDmg: 0,
    parsed: false,
    raw: null,
  };
  function relicWindow(text) {
    const t = String(text || "");
    const a = t.indexOf("Current Relic Power");
    if (a < 0) return "";
    const b = t.indexOf("Completed collections", a);
    return t.slice(a, b < 0 ? a + 2e3 : b);
  }
  function parseRelicPower(text) {
    let t = relicWindow(text);
    if (!t) return null;
    const out = {};
    RELIC_LABELS.slice()
      .sort((a, b) => b.length - a.length)
      .forEach(function (lab) {
        const re = new RegExp(lab.replace(/ /g, "\\s+"), "i");
        const m = re.exec(t);
        if (!m) return;
        const rest = t.slice(m.index + m[0].length);
        const v = rest.match(/^[\s:]*\+?(-?[0-9]+(?:\.[0-9]+)?)\s*(%?)/);
        v && (out[lab] = { value: parseFloat(v[1]), pct: v[2] === "%" });
        t = t.replace(re, new Array(lab.length + 1).join("_"));
      });
    const num = (k) => (out[k] ? out[k].value : 0);
    return {
      atk: num("Attack"),
      def: num("Defense"),
      enemyAtkRed: num("Enemy Attack reduction"),
      enemyDefRed: num("Enemy Defense reduction"),
      pveDamage: num("PvE damage") / 100,
      goblinDmg: num("Damage against Goblins") / 100,
      parsed: Object.keys(out).length > 0,
      raw: out,
    };
  }
  function classifyGapEngine(text) {
    const t = String(text || "");
    if (!t) return { kind: null, k: null };
    const NUM = "(\\d[\\d.]*)";
    const X = "\\s*[x\\u00D7]\\s*";
    const DASH = "\\s*[-\\u2010-\\u2015\\u2212]\\s*";
    const AG = "\\(\\s*your\\s+attack" + DASH + "enemy\\s+attack\\s*\\)";
    const DG = "\\(\\s*your\\s+defense" + DASH + "enemy\\s+defense\\s*\\)";
    let m = t.match(
      new RegExp(
        NUM + X + "\\(\\s*" + AG + "\\s*\\+\\s*" + DG + "\\s*\\)",
        "i",
      ),
    );
    if (m) return { kind: "combined", k: parseFloat(m[1]), curve: null };
    m = t.match(new RegExp(NUM + X + AG, "i"));
    if (m) return { kind: "atk", k: parseFloat(m[1]), curve: "grond" };
    m = t.match(new RegExp(NUM + X + DG, "i"));
    if (m) {
      const halves = /stamina\s+is\s+higher\s+than\s+your\s+defense/i.test(t);
      return {
        kind: "def",
        k: parseFloat(m[1]),
        curve: halves ? "cinderback" : "bastior",
        halvesOnStamina: halves,
      };
    }
    return { kind: null, k: null };
  }
  function parseExclusivity(text) {
    const m = String(text || "").match(
      /cannot\s+be\s+used\s+with\s+([^.]+)\./i,
    );
    if (!m) return null;
    return m[1]
      .split(/,|\band\b|\bor\b/)
      .map((x) => x.trim().toLowerCase())
      .filter((x) => x.length > 2);
  }
  function isOrryphos(name) {
    return /orryphos/i.test(name);
  }
  function isLegalMainCombo(mains) {
    if (!mains || !mains.length) return true;
    const combo = mains.filter((p) => p && p.main && p.main.comboGap);
    if (!combo.length) return true;
    const engines = mains.filter(
      (p) =>
        p && p.main && (p.main.grond || p.main.bastior || p.main.cinderback),
    );
    return engines.length === 0;
  }
  let PET_SIGIL_ATK = 0;
  function parsePetSigilATK(text) {
    const t = String(text || "");
    const a = t.indexOf("PvE Attack Team");
    if (a < 0) return null;
    let b = t.indexOf("Pet Inventory", a);
    b < 0 && (b = t.length);
    const block = t.slice(a, b);
    let m,
      sum = 0,
      n = 0;
    const re = /Sigil\s*\+\s*([0-9]+)\s*ATK/gi;
    while ((m = re.exec(block)) !== null) {
      sum += parseInt(m[1], 10);
      n++;
    }
    return { atk: sum, count: n };
  }
  var MOB_OBS = {};
  (function () {
    try {
      MOB_OBS =
        JSON.parse(localStorage.getItem("veyra_mob_observed") || "{}") || {};
    } catch (e) {
      MOB_OBS = {};
    }
  })();
  var MOB_PEN = {};
  (function () {
    try {
      MOB_PEN = JSON.parse(localStorage.getItem("veyra_mob_pen") || "{}") || {};
    } catch (e) {
      MOB_PEN = {};
    }
  })();
  function swParseInventory(doc) {
    const out = { mains: [], inventory: [] };
    if (!doc || !doc.querySelectorAll) return out;
    let mainSection = null,
      invSection = null;
    doc.querySelectorAll(".section").forEach((sec) => {
      const t = sec.querySelector(".section-title");
      const title = t ? t.textContent.trim() : "";
      /PvE Attack Team/i.test(title) && (mainSection = sec);
      /Pet Inventory/i.test(title) && (invSection = sec);
    });
    function card(c, inTeam) {
      const infoBtn = c.querySelector(".info-btn[data-name]");
      const img = c.querySelector("img[alt]");
      const name = infoBtn
        ? infoBtn.getAttribute("data-name").trim()
        : img
          ? img.getAttribute("alt").trim()
          : null;
      if (!name) return null;
      const txt = c.textContent || "";
      let invId = null,
        slot = null;
      Array.from(c.querySelectorAll("button")).forEach((b) => {
        const oc = b.getAttribute("onclick") || "";
        let m = oc.match(/openLinksModal\((\d+)\)/);
        m && invId == null && (invId = parseInt(m[1], 10));
        m = oc.match(/showEquipModal\((\d+)\s*,/);
        m && invId == null && (invId = parseInt(m[1], 10));
        m = oc.match(/unequipPet\((\d+)\)/);
        m && (slot = parseInt(m[1], 10));
      });
      const atkEl = c.querySelector(".pet-atk"),
        defEl = c.querySelector(".pet-def");
      const atk =
        (atkEl &&
          parseInt((atkEl.textContent || "").replace(/[^0-9]/g, ""), 10)) ||
        0;
      const def =
        (defEl &&
          parseInt((defEl.textContent || "").replace(/[^0-9]/g, ""), 10)) ||
        0;
      const sA = txt.match(/Sigil\s*\+\s*([0-9,]+)\s*ATK/i),
        sD = txt.match(/Sigil\s*\+\s*([0-9,]+)\s*DEF/i);
      const race =
        (txt.match(
          /Race:\s*([A-Za-z][A-Za-z\- ]*?)\s*(?:\n|VOID|FIRE|FROST|NATURE|WATER|THUNDER|LIGHT|WIND|Lv\.|$)/,
        ) || [])[1] || null;
      const descBtn = c.querySelector(".info-btn[data-desc]");
      return {
        name,
        invId,
        slot: inTeam ? slot : null,
        inTeam: !!inTeam,
        atk,
        def,
        isLegendary:
          c.classList.contains("pet-card-legendary") ||
          c.classList.contains("legendary"),
        isMythic: c.classList.contains("pet-card-mythical"),
        sigilATK: sA ? parseInt(sA[1].replace(/,/g, ""), 10) : 0,
        sigilDEF: sD ? parseInt(sD[1].replace(/,/g, ""), 10) : 0,
        race: race ? race.trim() : null,
        element: (c.dataset && c.dataset.element) || null,
        passiveText: (descBtn && descBtn.getAttribute("data-desc")) || "",
      };
    }
    mainSection &&
      mainSection.querySelectorAll(".pet-card").forEach((c) => {
        const p = card(c, true);
        p && out.mains.push(p);
      });
    invSection &&
      invSection.querySelectorAll(".pet-card").forEach((c) => {
        const p = card(c, false);
        p && out.inventory.push(p);
      });
    mainSection ||
      invSection ||
      doc.querySelectorAll(".pet-card").forEach((c) => {
        const p = card(c, false);
        p && out.inventory.push(p);
      });
    out.mains.sort((a, b) => (a.slot || 99) - (b.slot || 99));
    return out;
  }
  function swLinkedWhere(cfg, invId) {
    const out = [];
    Object.keys(cfg.links || {}).forEach((m) => {
      (cfg.links[m] || []).forEach((v, i) => {
        v != null &&
          String(v) === String(invId) &&
          out.push({ main: m, level: i + 1 });
      });
    });
    return out;
  }
  function swDiff(cur, target) {
    const acts = [];
    const tl = target.links || {},
      cl = cur.links || {};
    Object.keys(tl).forEach((m) => {
      const want = tl[m] || [null, null],
        have = cl[m] || [null, null];
      [0, 1].forEach((i) => {
        if (String(want[i]) === String(have[i])) return;
        have[i] == null ||
          acts.some(
            (a) =>
              a.type === "unlink" &&
              String(a.main) === String(m) &&
              a.level === i + 1,
          ) ||
          acts.push({ type: "unlink", main: m, level: i + 1, was: have[i] });
        want[i] != null &&
          swLinkedWhere(cur, want[i]).forEach((w) => {
            if (String(w.main) === String(m) && w.level === i + 1) return;
            acts.some(
              (a) =>
                a.type === "unlink" &&
                String(a.main) === String(w.main) &&
                a.level === w.level,
            ) ||
              acts.push({
                type: "unlink",
                main: w.main,
                level: w.level,
                was: want[i],
              });
          });
      });
    });
    const tm = target.mains || [],
      cm = cur.mains || [];
    const unequips = [],
      equips = [];
    for (let s = 0; s < 3; s++) {
      if (String(tm[s]) === String(cm[s])) continue;
      cm[s] != null &&
        unequips.push({ type: "unequip", slot: s + 1, was: cm[s] });
      tm[s] != null && equips.push({ type: "equip", slot: s + 1, pet: tm[s] });
    }
    acts.push.apply(acts, unequips);
    acts.push.apply(acts, equips);
    Object.keys(tl).forEach((m) => {
      const want = tl[m] || [null, null],
        have = cl[m] || [null, null];
      [0, 1].forEach((i) => {
        want[i] != null &&
          String(want[i]) !== String(have[i]) &&
          acts.push({ type: "link", main: m, level: i + 1, pet: want[i] });
      });
    });
    return acts;
  }
  function swMatches(cur, target) {
    const why = [];
    for (let s = 0; s < 3; s++)
      String((target.mains || [])[s]) !== String((cur.mains || [])[s]) &&
        why.push(
          "slot " +
            (s + 1) +
            ": want " +
            (target.mains || [])[s] +
            " have " +
            (cur.mains || [])[s],
        );
    Object.keys(target.links || {}).forEach((m) => {
      const want = target.links[m] || [null, null],
        have = (cur.links || {})[m] || [null, null];
      [0, 1].forEach((i) => {
        String(want[i]) !== String(have[i]) &&
          why.push(
            "link " +
              m +
              ":" +
              (i + 1) +
              ": want " +
              want[i] +
              " have " +
              have[i],
          );
      });
    });
    return { ok: why.length === 0, why };
  }
  function gearParseInventory(doc) {
    const out = { equipped: [], bag: [] };
    if (!doc || !doc.querySelectorAll) return out;
    doc.querySelectorAll(".slot-box").forEach((box) => {
      const invId = box.getAttribute ? box.getAttribute("data-inv-id") : null;
      const img = box.querySelector("img[alt]"),
        info = box.querySelector(".info-btn[data-name]"),
        nm = box.querySelector(".equipment-item-name");
      const name = (
        (info && info.getAttribute("data-name")) ||
        (nm && nm.textContent) ||
        (img && img.getAttribute("alt")) ||
        ""
      ).trim();
      if (invId != null && invId !== "") {
        const _ba = box.getAttribute("data-atk"),
          _bd = box.getAttribute("data-def");
        name &&
          out.bag.push({
            invId: parseInt(invId, 10),
            name,
            typee: (box.getAttribute("data-typee") || "").toLowerCase(),
            atk: _ba === null || _ba === "" ? null : parseInt(_ba, 10) || 0,
            def: _bd === null || _bd === "" ? null : parseInt(_bd, 10) || 0,
          });
        return;
      }
      let slotId = null;
      Array.from(box.querySelectorAll("button")).forEach((b) => {
        const m = (b.getAttribute("onclick") || "").match(
          /unequipItem\((\d+)\)/,
        );
        m && (slotId = parseInt(m[1], 10));
      });
      if (slotId == null || !name) return;
      const label = box.querySelector(".label");
      const first =
        (label &&
          (label.textContent || "")
            .split(/[\n\r]+/)
            .map((x) => x.trim())
            .find((x) => x)) ||
        "";
      const spans = box.querySelectorAll(".boosted-stat, .label span");
      const num = (i) =>
        (spans[i] &&
          parseInt((spans[i].textContent || "").replace(/[^0-9]/g, ""), 10)) ||
        0;
      out.equipped.push({
        slotId,
        slot: first.toLowerCase(),
        name,
        atk: num(0),
        def: num(1),
      });
    });
    out.equipped.sort((a, b) => a.slotId - b.slotId);
    return out;
  }
  async function gearReadPage(fetchFn, sleepFn, tries) {
    let last = "";
    for (let i = 0; i < (tries || 3); i++) {
      i && (await sleepFn(2500));
      let t = "",
        st = 0;
      try {
        const r = await fetchFn(
          "https://demonicscans.org/inventory.php?set=attack",
        );
        st = r.status;
        t = await r.text();
      } catch (e) {
        last = "the inventory request failed (" + e.message + ")";
        continue;
      }
      const g = gearParseInventory(parseHTML(t));
      if (g.equipped.length) return g;
      last =
        st === 200 && g.bag.length
          ? "inventory.php loaded (" +
            g.bag.length +
            " items) but shows no equipped gear in the attack set"
          : "inventory.php did not load properly (HTTP " +
            st +
            ", " +
            t.length +
            " characters, " +
            g.bag.length +
            " items read)";
    }
    throw new Error(
      last + " after " + (tries || 3) + " tries -- refusing to touch gear",
    );
  }
  const LB_SLOT_ID = {
    Weapon: 1,
    Helmet: 2,
    Armor: 3,
    Boots: 4,
    Gloves: 5,
    Ring: 6,
    Amulet: 7,
    "Ring 2": 9,
    "Class Weapon": 10,
  };
  /* A build is the same build wherever its pets stand: the damage maths takes the three mains as a SET and every link as (pet x its level's share), so
   * which slot a main is in and which main a link hangs on change nothing. What it does cost: every pet that moves is a request and a 1.2 s wait.
   * So the search's answer is laid over what is on now: a main already on the team keeps its slot (its links stay with it), and a link stays where it
   * is when the build wants that pet at that level anywhere. Only when the shares of that level differ between the mains (then where a link hangs
   * does count) is it left as the search put it.
   *   sel = { mains, link1, link2 (names, link1[i] / link2[i] belong to mains[i]), ... }   curMains = names by slot now
   *   linkName(main, level) = the link now on that main ('' if none)   sameShare(level, mains) = every main has the same share at that level */
  function alignPets(sel, curMains, linkName, sameShare) {
    const sm = [0, 1, 2].map((i) => (sel.mains || [])[i] || ''), from = [-1, -1, -1], taken = new Set();
    for (let j = 0; j < 3; j++) {
      const n = (curMains || [])[j] || '', i = n ? sm.findIndex((x, k) => x === n && !taken.has(k)) : -1;
      if (i >= 0) { from[j] = i; taken.add(i); }
    }
    for (let i = 0; i < 3; i++) {
      if (taken.has(i)) continue;
      const j = from.indexOf(-1); if (j < 0) break;
      from[j] = i; taken.add(i);
    }
    const out = Object.assign({}, sel, { mains: ['', '', ''], link1: ['', '', ''], link2: ['', '', ''] });
    from.forEach((i, j) => { if (i < 0) return; out.mains[j] = sm[i]; out.link1[j] = (sel.link1 || [])[i] || ''; out.link2[j] = (sel.link2 || [])[i] || ''; });
    [1, 2].forEach((lv) => {
      const key = 'link' + lv, wantAt = out[key], left = wantAt.filter((n, j) => n && out.mains[j]);
      if (!left.length || !sameShare(lv, out.mains.filter(Boolean))) return;
      const res = ['', '', ''];
      out.mains.forEach((m, j) => { if (!m) return; const c = linkName(m, lv), k = c ? left.indexOf(c) : -1; if (k >= 0) { res[j] = c; left.splice(k, 1); } });
      left.forEach((n) => {
        let j = wantAt.findIndex((x, k) => x === n && out.mains[k] && !res[k]);                      // where the search wanted it
        if (j < 0) j = out.mains.findIndex((m, k) => m && !res[k] && !linkName(m, lv));              // else a main with nothing there now
        if (j < 0) j = out.mains.findIndex((m, k) => m && !res[k]);
        if (j >= 0) res[j] = n;
      });
      out[key] = res;
    });
    return out;
  }
  function lbPetTarget(sel, state) {
    const errors = [],
      notes = [],
      names = {};
    const byId = state.byId || {};
    Object.keys(byId).forEach((id) => {
      byId[id] && byId[id].name && (names[String(id)] = byId[id].name);
    });
    Object.keys(state.ajax || {}).forEach((m) => {
      ((state.ajax[m] && state.ajax[m].links) || []).forEach((l) => {
        l && l.inv_id != null && l.name && (names[String(l.inv_id)] = l.name);
      });
    });
    (state.candidates || []).forEach((c) => {
      c &&
        c.inv_id != null &&
        c.name &&
        !names[String(c.inv_id)] &&
        (names[String(c.inv_id)] = c.name);
    });
    const idsOf = (n) => Object.keys(names).filter((id) => names[id] === n);
    const atkOf = (id) => (byId[id] && byId[id].atk) || 0;
    {                                                              // where the pets already stand decides where they go (see alignPets)
      const nowIds = (state.mains || []).map((x) => (x == null ? '' : String(x)));
      const idFor = (n) => { const ids = idsOf(n); return ids.find((id) => nowIds.indexOf(id) >= 0) || ids.find((id) => state.links && state.links[id]) || ids[0] || null; };
      const linkName = (n, lv) => { const id = idFor(n), l = id && state.links ? state.links[id] : null, x = l ? l[lv - 1] : null; return x == null ? '' : names[String(x)] || ''; };
      const shareOf = (n, lv) => {
        const id = idFor(n), cap = lv === 1 ? 0.5 : 0.25, a = id && state.ajax ? state.ajax[id] : null;
        if (!a) return null;                                       // not read: unknown
        const l = (a.links || []).find((x) => x.link_level === lv);
        return l ? Math.min(parseFloat(String(l.share_pct_label || '0').replace('%', '')) / 100, cap) : cap;
      };
      const sameShare = (lv, ms) => { const f = ms.map((n) => shareOf(n, lv)); return f.every((x) => x != null && Math.abs(x - f[0]) < 1e-9); };
      sel = alignPets(sel, nowIds.map((id) => (id ? names[id] || '' : '')), linkName, sameShare);
    }
    const used = {},
      mains = [null, null, null];
    const sm = (sel.mains || []).map((x) => x || ""),
      cm = (state.mains || []).map((x) => (x == null ? null : String(x)));
    for (let i = 0; i < 3; i++)
      if (sm[i] && cm[i] != null && names[cm[i]] === sm[i] && !used[cm[i]]) {
        mains[i] = cm[i];
        used[cm[i]] = true;
      }
    for (let i = 0; i < 3; i++) {
      if (!sm[i] || mains[i]) continue;
      const c = idsOf(sm[i])
        .filter((id) => !used[id])
        .sort(
          (a, b) =>
            (cm.indexOf(b) >= 0 ? 1 : 0) - (cm.indexOf(a) >= 0 ? 1 : 0) ||
            atkOf(b) - atkOf(a),
        );
      if (!c.length) {
        errors.push(
          'main pet "' +
            sm[i] +
            '" ' +
            (idsOf(sm[i]).length
              ? "is selected more often than you own it"
              : "was not found among your pets"),
        );
        continue;
      }
      mains[i] = c[0];
      used[c[0]] = true;
    }
    const links = {},
      want = [],
      linkedNow = {};
    Object.keys(state.links || {}).forEach((m) =>
      (state.links[m] || []).forEach((x) => {
        x != null && (linkedNow[String(x)] = true);
      }),
    );
    for (let i = 0; i < 3; i++) {
      const l1 = (sel.link1 || [])[i] || "",
        l2 = (sel.link2 || [])[i] || "";
      if (!mains[i]) {
        (l1 || l2) &&
          notes.push(
            "links of slot " +
              (i + 1) +
              " ignored (no main pet selected there)",
          );
        continue;
      }
      links[mains[i]] = [null, null];
      l1 && want.push({ m: mains[i], lv: 1, n: l1 });
      l2 && want.push({ m: mains[i], lv: 2, n: l2 });
    }
    want.forEach((w) => {
      const cur = ((state.links || {})[w.m] || [])[w.lv - 1];
      const id = cur == null ? null : String(cur);
      if (id && !used[id] && names[id] === w.n) {
        links[w.m][w.lv - 1] = id;
        used[id] = true;
        w.done = true;
      }
    });
    want
      .filter((w) => !w.done)
      .forEach((w) => {
        const all = idsOf(w.n),
          c = all
            .filter((id) => !used[id])
            .sort((a, b) => (linkedNow[a] ? 1 : 0) - (linkedNow[b] ? 1 : 0));
        if (!c.length) {
          errors.push(
            'link pet "' +
              w.n +
              '" ' +
              (all.length
                ? "is selected more often than you own it (or is also selected as a main)"
                : "was not found among your pets"),
          );
          return;
        }
        links[w.m][w.lv - 1] = c[0];
        used[c[0]] = true;
      });
    return { target: { mains, links }, errors, notes, names };
  }
  function lbGearPlan(want, live, items) {
    const errors = [],
      un = [],
      eq = [],
      have = {},
      used = {};
    ((live && live.equipped) || []).forEach((e) => {
      have[e.slotId] = e;
    });
    const bag = (live && live.bag) || [];
    const exact = (n, a, d) =>
      bag.filter(
        (b) => b.name === n && b.atk === a && b.def === d && !used[b.invId],
      );
    const slots = Object.keys(LB_SLOT_ID),
      changing = [];
    slots.forEach((sl) => {
      const id = LB_SLOT_ID[sl],
        w = (want && want[sl]) || "",
        h = have[id];
      if ((h ? h.name : "") === w) {
        if (h) {
          const m = exact(h.name, h.atk, h.def);
          m.length === 1 && (used[m[0].invId] = true);
        }
      } else changing.push(sl);
    });
    changing.forEach((sl) => {
      const id = LB_SLOT_ID[sl];
      have[id] && un.push({ type: "unequip", slotId: id, name: have[id].name });
    });
    changing.forEach((sl) => {
      const id = LB_SLOT_ID[sl],
        w = (want && want[sl]) || "";
      if (!w) return;
      const hint = (items || []).find((i) => i.name === w && i.slot === sl);
      let c = bag.filter((b) => b.name === w && !used[b.invId]);
      hint &&
      hint.invId != null &&
      c.some((b) => String(b.invId) === String(hint.invId))
        ? (c = c.filter((b) => String(b.invId) === String(hint.invId)))
        : hint &&
          c.some((b) => b.atk === hint.atk && b.def === hint.def) &&
          (c = c.filter((b) => b.atk === hint.atk && b.def === hint.def));
      if (!c.length) {
        errors.push(
          sl +
            ': "' +
            w +
            '" ' +
            (bag.some((b) => b.name === w)
              ? "is selected in more slots than you own copies"
              : "was not found in your item list"),
        );
        return;
      }
      used[c[0].invId] = true;
      eq.push({
        type: "equip",
        invId: c[0].invId,
        slotId: id === 6 || id === 9 ? id : 0,
        name: w,
        wantSlot: id,
      });
    });
    return { acts: un.concat(eq), errors, changes: changing.length };
  }
  function lbGearCheck(want, equipped) {
    const why = [],
      have = {};
    (equipped || []).forEach((e) => {
      have[e.slotId] = e;
    });
    Object.keys(LB_SLOT_ID).forEach((sl) => {
      const id = LB_SLOT_ID[sl],
        w = (want && want[sl]) || "",
        h = have[id] ? have[id].name : "";
      w !== h &&
        why.push(sl + ": want " + (w || "empty") + ", have " + (h || "empty"));
    });
    return { ok: why.length === 0, why };
  }
  function lbGearBySlot(equipped) {
    const o = {};
    Object.keys(LB_SLOT_ID).forEach((sl) => {
      o[sl] = "";
    });
    (equipped || []).forEach((e) => {
      Object.keys(LB_SLOT_ID).forEach((sl) => {
        LB_SLOT_ID[sl] === e.slotId && (o[sl] = e.name);
      });
    });
    return o;
  }
  function lbDescribe(a, names) {
    const n = (id) => (names && names[String(id)]) || "#" + id;
    if (a.type === "equip" && a.pet !== void 0)
      return "equip " + n(a.pet) + " -> main slot " + a.slot;
    if (a.type === "unequip" && a.slot !== void 0)
      return "unequip main slot " + a.slot + " (" + n(a.was) + ")";
    if (a.type === "link")
      return "link " + n(a.pet) + " -> " + n(a.main) + " L" + a.level;
    if (a.type === "unlink")
      return "unlink " + n(a.main) + " L" + a.level + " (" + n(a.was) + ")";
    if (a.type === "unequip") return "take off " + a.name;
    return "put on " + a.name;
  }
  async function lbBench(env, st, ids) {
    for (const m of ids) {
      if (m == null || (st.links && st.links[m])) continue;
      const j = await env.linksOf(m);
      st.ajax = st.ajax || {};
      st.ajax[m] = j;
      const l = [null, null];
      (j.links || []).forEach((x) => {
        (x.link_level !== 1 && x.link_level !== 2) ||
          (l[x.link_level - 1] = x.inv_id);
      });
      st.links[m] = l;
    }
    return st;
  }
  async function lbApplyPets(env, target, names, bench, hook) {
    const keys = (target.mains || []).concat(
      Object.keys(target.links || {}),
      bench || [],
    );
    let cur = await lbBench(env, await env.readState(), keys);
    const acts = swDiff(cur, target);
    hook && hook({ stage: "pets", plan: acts.map((a) => lbDescribe(a, names)) });
    for (const [i, a] of acts.entries()) {
      hook && hook({ stage: "pets", i });
      env.log("  > " + lbDescribe(a, names));
      await env.doPet(a);
      await env.sleep();
    }
    cur = await lbBench(
      env,
      await env.readState(),
      Object.keys(target.links || {}),
    );
    const chk = swMatches(cur, target);
    if (!chk.ok)
      throw new Error(
        "pets / links are not as selected after the change: " +
          chk.why.join("; "),
      );
    return acts.length;
  }
  async function lbApplyGear(env, want, items, hook) {
    const g = await env.gearRead(),
      plan = lbGearPlan(want, g, items);
    if (plan.errors.length) throw new Error(plan.errors.join("; "));
    hook && hook({ stage: "gear", plan: plan.acts.map((a) => lbDescribe(a)) });
    for (const [i, a] of plan.acts.entries()) {
      hook && hook({ stage: "gear", i });
      env.log("  > " + lbDescribe(a));
      await env.gearDo(a);
      await env.sleep();
    }
    if (plan.acts.length) {
      const g2 = await env.gearRead(),
        chk = lbGearCheck(want, g2.equipped);
      if (!chk.ok)
        throw new Error(
          "gear is not as selected after the change: " + chk.why.join("; "),
        );
    }
    return plan.acts.length;
  }
  async function lbRestore(env, snap) {
    const problems = [];
    try {
      const cur = await env.readState(),
        was = (snap.mains || []).map((x) => (x == null ? null : String(x)));
      const t1 = { mains: cur.mains.slice(), links: {} };
      cur.mains.forEach((m) => {
        m != null &&
          was.indexOf(String(m)) < 0 &&
          snap.links &&
          snap.links[m] &&
          (t1.links[m] = snap.links[m].slice());
      });
      Object.keys(t1.links).length && (await lbApplyPets(env, t1, snap.names));
      const t2 = { mains: snap.mains.slice(), links: {} };
      Object.keys(snap.links || {}).forEach((m) => {
        t2.links[m] = snap.links[m].slice();
      });
      await lbApplyPets(env, t2, snap.names);
    } catch (e) {
      problems.push("pets: " + e.message);
    }
    try {
      await lbApplyGear(env, snap.gear, null);
    } catch (e) {
      problems.push("gear: " + e.message);
    }
    if (problems.length) {
      snap.pending = true;
      snap.problems = problems;
      env.save(snap);
      return { ok: false, problems };
    }
    env.save(null);
    return { ok: true, problems: [] };
  }

  let _calMemo = null;                       // set for the length of one search: localStorage + JSON.parse per evaluation was a large part of the cost
  function getCalibration() {
    if (_calMemo) return _calMemo;
    return readCalibration();
  }
  function readCalibration() {
    try {
      const o = JSON.parse(localStorage.getItem("veyra_calibration") || "{}");
      return {
        petAtkBonus: Number(o.petAtkBonus) || 0,
        solvedBonus: o.solvedBonus == null ? null : Number(o.solvedBonus),
        moonveilRate: Number(o.moonveilRate) || 0,
        petFingerprint: o.petFingerprint || null,
      };
    } catch (e) {
      return { petAtkBonus: 0, moonveilRate: 0, petFingerprint: null };
    }
  }
  function petFingerprint(build) {
    if (!build) return null;
    const m = (build.mains || []).map((x) => x.atk || 0).join(",");
    const l = (build.links || [])
      .map((x) => ((x.pet && x.pet.name) || "?") + "@" + (x.factor || 0))
      .sort()
      .join(",");
    return "m[" + m + "]l[" + l + "]";
  }
  function scrapeStatsDoc(doc) {
    let atk = 0,
      def = 0,
      stamina = 0,
      relicATK = 0,
      relicDEF = 0,
      via = null;
    const st = doc.getElementById ? doc.getElementById("stats-state") : null;
    if (st)
      try {
        const j = JSON.parse(st.textContent || "");
        const c = (j && j.core) || {},
          u = (j && j.user) || {};
        atk = parseInt(c.attack != null ? c.attack : u.ATTACK, 10) || 0;
        def = parseInt(c.defense != null ? c.defense : u.DEFENSE, 10) || 0;
        stamina =
          parseInt(c.stamina != null ? c.stamina : u.MAX_STAMINA, 10) || 0;
        relicATK = parseInt(c.relic_attack, 10) || 0;
        relicDEF = parseInt(c.relic_defense, 10) || 0;
        atk && def && stamina && (via = "stats-state");
      } catch (e) {}
    if (!via) {
      const q = (k) => {
        const el = doc.querySelector('[data-value="' + k + '"]');
        return (
          (el && parseInt((el.textContent || "").replace(/[^0-9]/g, ""), 10)) ||
          0
        );
      };
      const a2 = q("attack"),
        d2 = q("defense"),
        s2 = q("stamina");
      if (a2 && d2 && s2) {
        atk = a2;
        def = d2;
        stamina = s2;
        via = "data-value";
      }
    }
    if (!via) {
      const g = (id) => {
        const el = doc.getElementById(id);
        return (
          (el && parseInt((el.textContent || "").replace(/[^0-9]/g, ""), 10)) ||
          0
        );
      };
      const a3 = g("v-attack"),
        d3 = g("v-defense"),
        s3 = g("v-stamina");
      if (a3 || d3 || s3) {
        atk = a3;
        def = d3;
        stamina = s3;
        via = "v-ids";
      }
    }
    return { atk, def, stamina, relicATK, relicDEF, statsVia: via };
  }
  function scrapeStats(doc) {
    doc = doc || document;
    const base = scrapeStatsDoc(doc);
    const atk = base.atk,
      def = base.def,
      stamina = base.stamina;
    const lvlEl = doc.querySelector(".small-level");
    let level = 1;
    if (lvlEl) {
      const lt = lvlEl.textContent || "";
      const lm = lt.match(/LV\.?\s*([0-9,]+)/i);
      level = lm
        ? parseInt(lm[1].replace(/,/g, "")) || 1
        : parseInt(lt.replace(/[^0-9]/g, "")) || 1;
    }
    return {
      atk,
      def,
      stamina,
      level,
      relicATK: base.relicATK,
      relicDEF: base.relicDEF,
      statsVia: base.statsVia,
      baseCritRate: 0,
      hunterCritDmg: 0,
      playerClass: "Unknown",
    };
  }
  function parseClassDoc(doc) {
    try {
      const pill = doc.querySelector(".section-classes-pill");
      if (pill) {
        const txt = pill.textContent.trim();
        const cls = txt.replace(/[\s\S]*Your class:\s*/i, "").trim();
        if (cls) return cls;
      }
    } catch (e) {}
    return "Unknown";
  }
  function parseInventoryDoc(doc) {
    const items = [];
    function normalizeSlot(raw) {
      if (!raw) return null;
      const s = raw.trim().toLowerCase();
      return (
        {
          weapon: "Weapon",
          "class weapon": "Class Weapon",
          class_weapon: "Class Weapon",
          "class-weapon": "Class Weapon",
          helmet: "Helmet",
          hood: "Helmet",
          armor: "Armor",
          vestment: "Armor",
          robe: "Armor",
          boots: "Boots",
          greaves: "Boots",
          gloves: "Gloves",
          ring: "Ring",
          "ring 2": "Ring 2",
          ring2: "Ring 2",
          ring_2: "Ring 2",
          amulet: "Amulet",
        }[s] || null
      );
    }
    function parseDescATK(desc) {
      const m = desc.match(/^ATK\s+([\d,]+(?:\s*\u2192\s*[\d,]+)*)/m);
      if (!m) return 0;
      const nums = m[1].match(/[\d,]+/g);
      if (!nums || !nums.length) return 0;
      return parseInt(nums[nums.length - 1].replace(/,/g, "")) || 0;
    }
    function parseDescDEF(desc) {
      const m = desc.match(/^DEF\s+([\d,]+(?:\s*\u2192\s*[\d,]+)*)/m);
      if (!m) return 0;
      const nums = m[1].match(/[\d,]+/g);
      if (!nums || !nums.length) return 0;
      return parseInt(nums[nums.length - 1].replace(/,/g, "")) || 0;
    }
    function parseInventoryItem(card) {
      const infoBtn = card.querySelector(".info-btn[data-name]");
      const img = card.querySelector("img[alt]");
      const name = infoBtn
        ? infoBtn.getAttribute("data-name").trim()
        : img
          ? img.getAttribute("alt").trim()
          : null;
      if (!name || name === "Empty") return null;
      const rawSlot = card.dataset.typee;
      const slot = normalizeSlot(rawSlot);
      if (!slot) return null;
      let atk = parseInt(card.dataset.atk) || 0;
      let def = parseInt(card.dataset.def) || 0;
      let critDmg = 0,
        critRate = 0,
        monsterDmg = 0,
        dragonDmg = 0,
        pvpDmg = 0,
        element = "NONE",
        elemPct = 0,
        set = "None";
      const descBtn = card.querySelector(".info-btn[data-desc]");
      if (descBtn) {
        const desc = descBtn.getAttribute("data-desc") || "";
        atk || (atk = parseDescATK(desc));
        def || (def = parseDescDEF(desc));
        const cdM = desc.match(
          /Crit(?:ical)?\s*Damage\s*[Bb]y\s*\+?([0-9.]+)%/i,
        );
        cdM && (critDmg = parseFloat(cdM[1]) / 100);
        const crM = desc.match(/Crit(?:ical)?\s*Rate\s*[Bb]y\s*\+?([0-9.]+)%/i);
        crM && (critRate = parseFloat(crM[1]) / 100);
        const mdM =
          desc.match(/Monster\s*Damage\s*[Bb]y\s*\+?([0-9.]+)%/i) ||
          desc.match(/Damage\s*to\s*Monsters\s*[Bb]y\s*\+?([0-9.]+)%/i) ||
          desc.match(/([0-9.]+)%\s*Extra\s*Damage\s*To\s*Monsters/i) ||
          desc.match(/Increase\s+your\s+PvE\s+damage\s+by\s+\+?([0-9.]+)%/i);
        mdM && (monsterDmg = parseFloat(mdM[1]) / 100);
        const pvpM = desc.match(/PvP\s+damage\s+by\s+\+?([0-9.]+)%/i);
        pvpM && (pvpDmg = parseFloat(pvpM[1]) / 100);
        const drM =
          desc.match(
            /(?:Another|Extra|Plus)\s*\+?([0-9.]+)%\s*Against\s*Dragons/i,
          ) ||
          desc.match(
            /([0-9.]+)%\s*(?:bonus|extra)?\s*(?:damage\s*)?Against\s*Dragons/i,
          );
        drM && (dragonDmg = parseFloat(drM[1]) / 100);
        const elemM = desc.match(
          /Element:\s*(FIRE|WATER|FROST|NATURE|THUNDER|VOID|LIGHT)\s*\(\+([0-9.]+)%\)/i,
        );
        if (elemM) {
          element = elemM[1].toUpperCase();
          elemPct = parseFloat(elemM[2]);
        }
        if (element === "NONE") {
          const elemM2 = desc.match(
            /(FIRE|WATER|FROST|NATURE|THUNDER|VOID|LIGHT)\s*\+([0-9.]+)%/i,
          );
          if (elemM2) {
            element = elemM2[1].toUpperCase();
            elemPct = parseFloat(elemM2[2]);
          }
        }
        const setM = desc.match(/Set[:\s]+([A-Za-z\s]+)/i);
        setM && (set = setM[1].trim());
      }
      return {
        name,
        slot,
        atk,
        def,
        critDmg,
        critRate,
        monsterDmg,
        dragonDmg,
        pvpDmg,
        element,
        elemPct,
        set,
        equipped: false,
        invId: card.dataset.invId || null,
      };
    }
    function parseEquippedDisplayBox(card) {
      const btn = card.querySelector("button");
      if (!btn || !btn.textContent.includes("Unequip")) return null;
      const img = card.querySelector("img[alt]");
      const name = img ? img.getAttribute("alt").trim() : null;
      if (!name || name === "Empty") return null;
      const label = card.querySelector(".label");
      let slot = null;
      if (label) {
        const labelText = label.textContent || "";
        const firstLine = labelText
          .split(/[\n\r]+/)
          .map((l) => l.trim())
          .find((l) => l.length > 0);
        slot = normalizeSlot(firstLine);
      }
      if (!slot) return null;
      const boostedSpans = card.querySelectorAll(".boosted-stat");
      const atk =
        (boostedSpans[0] &&
          parseInt(
            (boostedSpans[0].textContent || "").replace(/[^0-9]/g, ""),
          )) ||
        0;
      const def =
        (boostedSpans[1] &&
          parseInt(
            (boostedSpans[1].textContent || "").replace(/[^0-9]/g, ""),
          )) ||
        0;
      return {
        name,
        slot,
        atk,
        def,
        critDmg: 0,
        critRate: 0,
        monsterDmg: 0,
        dragonDmg: 0,
        element: "NONE",
        elemPct: 0,
        set: "None",
        equipped: true,
      };
    }
    const seenNames = new Set();
    doc.querySelectorAll(".slot-box[data-inv-id]").forEach((card) => {
      const item = parseInventoryItem(card);
      if (!item) return;
      if (!seenNames.has(item.name)) {
        seenNames.add(item.name);
        items.push(item);
        item.slot === "Ring" &&
          items.push(Object.assign({}, item, { slot: "Ring 2" }));
      }
    });
    doc.querySelectorAll(".slot-box:not([data-inv-id])").forEach((card) => {
      const item = parseEquippedDisplayBox(card);
      if (!item) return;
      const existing = items.find(
        (i) => i.name === item.name && i.slot === item.slot,
      );
      if (existing) existing.equipped = true;
      else if (!seenNames.has(item.name)) {
        seenNames.add(item.name);
        items.push(item);
        item.slot === "Ring" &&
          items.push(Object.assign({}, item, { slot: "Ring 2" }));
      }
    });
    return items;
  }
  function petAnnotateBaseAtk(mains, links) {
    const atkOf = {};
    [...(mains || []), ...(links || [])].forEach((p) => {
      p &&
        p.name &&
        (!(p.name in atkOf) || (p.atk || 0) > atkOf[p.name]) &&
        (atkOf[p.name] = p.atk || 0);
    });
    [...(mains || []), ...(links || [])].forEach((p) => {
      if (!p) return;
      let now = 0;
      (p.linkedPets || []).forEach((l) => {
        l.atkNow = Math.round((atkOf[l.name] || 0) * (l.factor || 0));
        now += l.atkNow;
        const lab =
          parseFloat(String(l.shareLabel || "").replace("%", "")) / 100;
        l.addAttack &&
          Math.abs(lab - l.factor) < 1e-9 &&
          Math.abs(l.addAttack - l.atkNow) > 1 &&
          console.warn(
            "[VBO11.81] link ATK transfer mismatch for " +
              l.name +
              " on " +
              p.name +
              ": the game says +" +
              l.addAttack +
              ", computed +" +
              l.atkNow +
              " (link ATK " +
              (atkOf[l.name] || 0) +
              " x " +
              l.factor +
              ")",
          );
      });
      p.linkAtkNow = now;
      p.baseAtk = (p.atk || 0) - now;
    });
  }
  function parsePetsDoc(doc) {
    const mains = [],
      links = [];
    const sections = doc.querySelectorAll(".section");
    let mainSection = null,
      invSection = null;
    sections.forEach((sec) => {
      const titleEl = sec.querySelector(".section-title");
      const title = titleEl ? titleEl.textContent.trim() : "";
      /PvE Attack Team/i.test(title) && (mainSection = sec);
      /Pet Inventory/i.test(title) && (invSection = sec);
    });
    function parsePetCard(card) {
      const infoBtn = card.querySelector(".info-btn[data-name]");
      const img = card.querySelector("img[alt]");
      const name = infoBtn
        ? infoBtn.getAttribute("data-name").trim()
        : img
          ? img.getAttribute("alt").trim()
          : null;
      if (!name) return null;
      const isLegendary =
        card.classList.contains("pet-card-legendary") ||
        card.classList.contains("legendary");
      const atkEl = card.querySelector(".pet-atk");
      const defEl = card.querySelector(".pet-def");
      const atk =
        (atkEl && parseInt((atkEl.textContent || "").replace(/[^0-9]/g, ""))) ||
        0;
      const def =
        (defEl && parseInt((defEl.textContent || "").replace(/[^0-9]/g, ""))) ||
        0;
      const lvlEl = card.querySelector(".pet-level, .level-val");
      const level =
        (lvlEl && parseInt((lvlEl.textContent || "").replace(/[^0-9]/g, ""))) ||
        0;
      let petInvId = null;
      const linksBtn = Array.from(card.querySelectorAll("button")).find((b) =>
        /links/i.test(b.textContent),
      );
      if (linksBtn) {
        const oc = linksBtn.getAttribute("onclick") || "";
        const idM = oc.match(/openLinksModal\((\d+)\)/);
        idM && (petInvId = parseInt(idM[1]));
      }
      const descBtn = card.querySelector(".info-btn[data-desc]");
      const passiveText = (descBtn && descBtn.getAttribute("data-desc")) || "";
      const element = card.dataset.element || null;
      const elemRateRaw =
        parseFloat(card.dataset.elementRate || card.dataset.elemRate || 0) || 0;
      const elemRate = elemRateRaw <= 1 ? elemRateRaw * 100 : elemRateRaw;
      return {
        name,
        atk,
        def,
        level,
        passiveText,
        element,
        elemRate,
        isLegendary,
        petInvId,
      };
    }
    function toFrac(v, hasPct) {
      if (isNaN(v) || v === null || v === void 0) return 0;
      if (hasPct) return v / 100;
      return v > 1 ? v / 100 : v;
    }
    function parsePassive(pet) {
      if (PVE_DISABLED_PETS.some((n) => pet.name.toLowerCase().includes(n)))
        return null;
      const txt = pet.passiveText.toLowerCase();
      const contrib = {};
      const crM = txt.match(
        /crit(?:ical)?\s*rate\s*(?:by\s*)?([0-9.]+)\s*(%?)/,
      );
      if (crM) {
        contrib.kind = "crit_rate";
        contrib.val = toFrac(parseFloat(crM[1]), crM[2] === "%");
      }
      const cdM = txt.match(
        /crit(?:ical)?\s*damage\s*(?:by\s*)?([0-9.]+)\s*(%?)/,
      );
      if (cdM) {
        contrib.kind = "crit_dmg";
        contrib.val = toFrac(parseFloat(cdM[1]), cdM[2] === "%");
      }
      const mdM =
        txt.match(
          /([0-9.]+)\s*(%?)\s*(?:extra\s*)?damage\s*(?:to|vs)\s*monsters/,
        ) || txt.match(/damage\s*to\s*monsters\s*(?:by\s*)?([0-9.]+)\s*(%?)/);
      if (mdM) {
        contrib.kind = "monster_dmg";
        contrib.val = toFrac(parseFloat(mdM[1]), mdM[2] === "%");
      }
      const edM = txt.match(/([0-9.]+)\s*(%?)\s*extra\s*elemental\s*damage/);
      if (edM) {
        contrib.kind = "elem_dmg";
        contrib.val = toFrac(parseFloat(edM[1]), edM[2] === "%");
      }
      const erM = txt.match(
        /([0-9.]+)\s*(%?)\s*(fire|water|frost|nature|thunder|void|light)\s*element\s*rate/,
      );
      if (erM) {
        contrib.kind = "elem_rate";
        contrib.elem = erM[3].toUpperCase();
        const rv = parseFloat(erM[1]);
        const hasPct = erM[2] === "%";
        contrib.val = hasPct || rv > 1 ? rv : rv * 100;
      }
      const eqPenM =
        txt.match(
          /(?:gain\s+)?(\d[\d.]*)\s*(%?)\s*equipe?ment\s*defense\s*penetration/,
        ) ||
        txt.match(
          /equipe?ment\s*defense\s*penetration\s*(?:by\s*)?(\d[\d.]*)\s*(%?)/,
        );
      if (eqPenM) {
        contrib.kind = "eq_pen";
        contrib.val = toFrac(parseFloat(eqPenM[1]), eqPenM[2] === "%");
        /attack\s*(?:exceeds|is\s*higher)/i.test(txt)
          ? (contrib.cond = "atkDom")
          : /defense\s*(?:exceeds|is\s*higher)/i.test(txt) &&
            (contrib.cond = "defDom");
        console.log(
          "[VBO11.81] eq_pen parsed:",
          pet.name,
          "| raw:",
          eqPenM[1],
          "hasPct:",
          eqPenM[2] === "%",
          "| val:",
          contrib.val,
          "| cond:",
          contrib.cond,
          "| text:",
          txt.substring(0, 120),
        );
      }
      const petPenM =
        txt.match(
          /(?:gain\s+)?(\d[\d.]*)\s*(%?)\s*pet\s*defense\s*penetration/,
        ) ||
        txt.match(/pet\s*defense\s*penetration\s*(?:by\s*)?(\d[\d.]*)\s*(%?)/);
      if (petPenM) {
        contrib.kind = "pet_pen";
        contrib.val = toFrac(parseFloat(petPenM[1]), petPenM[2] === "%");
        /attack\s*(?:exceeds|is\s*higher)/i.test(txt)
          ? (contrib.cond = "atkDom")
          : /defense\s*(?:exceeds|is\s*higher)/i.test(txt) &&
            (contrib.cond = "defDom");
      }
      const apM =
        txt.match(/(\d[\d.]*)\s*(%?)\s*armor\s*penetration/) ||
        txt.match(/armor\s*penetration\s*(?:by\s*)?(\d[\d.]*)\s*(%?)/);
      if (apM) {
        contrib.kind = "armor_pen";
        contrib.val = toFrac(parseFloat(apM[1]), apM[2] === "%");
      }
      const atkM = txt.match(
        /increase\s+(?:your\s+)?att(?:ack|k)\s+by\s+([0-9.]+)\s*(%?)\s*of\s*\(?\s*(?:your\s+)?att/,
      );
      if (atkM) {
        contrib.kind = "atk";
        const _av = parseFloat(atkM[1]);
        contrib.val = atkM[2] === "%" ? _av / 100 : _av;
        contrib.cond = "atkDom";
      }
      const defBoostM = txt.match(
        /increase\s+(?:your\s+)?def(?:ense)?\s+by\s+([0-9.]+)\s*(%?)\s*of\s*\(?\s*(?:your\s+)?def/,
      );
      if (defBoostM) {
        contrib.kind = "def";
        const _dv = parseFloat(defBoostM[1]);
        contrib.val = _dv > 1 || defBoostM[2] === "%" ? _dv / 100 : _dv;
        contrib.cond = "defDom";
      }
      const defM = txt.match(
        /bonus\s+da?m(?:age|g)\s*(?:equal\s+to|=|of)?\s*([0-9.]+)\s*[x\u00D7].*def(?:ense)?.*enemy\s*def/,
      );
      if (defM) {
        contrib.kind = "def_bonus";
        contrib.val = parseFloat(defM[1]);
        contrib.cond = "defGtMob";
      }
      return Object.keys(contrib).length > 0 ? contrib : null;
    }
    function parsePassiveWithLog(pet) {
      const result = parsePassive(pet);
      const txt = (pet.passiveText || "").toLowerCase();
      txt.includes("penetration") &&
        (!result ||
          (result.kind !== "eq_pen" &&
            result.kind !== "pet_pen" &&
            result.kind !== "armor_pen")) &&
        console.warn(
          "[VBO11.81] Penetration text found but NOT parsed as pen:",
          pet.name,
          "| contrib:",
          result ? result.kind : "null",
          "| text:",
          txt.substring(0, 150),
        );
      return result;
    }
    function isGrond(name) {
      return /grond/i.test(name);
    }
    function isBastior(name) {
      return /bastior/i.test(name);
    }
    function isCinderback(name) {
      return /cinderback/i.test(name);
    }
    function buildMainObj(pet) {
      const m = {};
      const _eng = classifyGapEngine(pet.passiveText);
      if (_eng.kind === "atk") {
        m.grond = true;
        m.grondK = _eng.k;
        m.engineVia = "text";
        m.role = "Damage engine (ATK gap)";
      } else if (_eng.kind === "def" && _eng.curve === "bastior") {
        m.bastior = true;
        m.bastiorK = _eng.k;
        m.engineVia = "text";
        m.role = "DEF-gap engine";
      } else if (_eng.kind === "def" && _eng.curve === "cinderback") {
        m.cinderback = true;
        m.cinderbackK = _eng.k;
        m.engineVia = "text";
        m.cinderbackHalves = !!_eng.halvesOnStamina;
        m.role = "DEF-gap engine (early softcap)";
      } else if (_eng.kind === "combined") {
        m.comboGap = true;
        m.comboK = _eng.k;
        m.unmodelled = "combined ATK+DEF gap";
        m.excludesWith = parseExclusivity(pet.passiveText);
        m.role = "Combined-gap engine (UNMODELLED)";
      }
      if (!m.engineVia && !m.comboGap) {
        if (isGrond(pet.name)) {
          m.grond = true;
          m.role = "Damage engine (ATK gap)";
          m.engineVia = "name";
          const gk = (pet.passiveText || "").match(
            /(\d[\d.]*)\s*[x\u00D7]\s*\(?\s*(?:your\s*)?att(?:ack|k)/i,
          );
          gk && (m.grondK = parseFloat(gk[1]));
        }
        if (isBastior(pet.name)) {
          m.bastior = true;
          m.role = "DEF-gap engine";
          m.engineVia = "name";
          const bk = (pet.passiveText || "").match(
            /(\d[\d.]*)\s*[x\u00D7]\s*\(?\s*(?:your\s*)?def(?:ense)?/i,
          );
          bk && (m.bastiorK = parseFloat(bk[1]));
        }
        if (isCinderback(pet.name)) {
          m.cinderback = true;
          m.role = "DEF-gap engine (early softcap)";
          m.engineVia = "name";
          m.cinderbackHalves = true;
        }
      }
      if (
        !PVE_DISABLED_PETS.some((n) => pet.name.toLowerCase().includes(n)) &&
        pet.passiveText
      ) {
        const cdM = pet.passiveText.match(
          /crit(?:ical)?\s*(?:dmg|damage)\s*(?:by\s*)?(\d[\d.]*)\s*(%?)/i,
        );
        const crM = pet.passiveText.match(
          /crit(?:ical)?\s*rate\s*(?:by\s*)?(\d[\d.]*)\s*(%?)/i,
        );
        const mdM =
          pet.passiveText.match(
            /(\d[\d.]*)\s*(%?)\s*(?:extra\s*)?damage\s*(?:to|vs|versus|against)\s*monsters/i,
          ) ||
          pet.passiveText.match(
            /damage\s*(?:to|vs|versus|against)\s*monsters\s*(?:by\s*)?(\d[\d.]*)\s*(%?)/i,
          );
        cdM && (m.critDmg = toFrac(parseFloat(cdM[1]), cdM[2] === "%"));
        crM && (m.critRate = toFrac(parseFloat(crM[1]), crM[2] === "%"));
        mdM && (m.monsterDmg = toFrac(parseFloat(mdM[1]), mdM[2] === "%"));
        const mvM = pet.passiveText.match(
          /transfer\s+(\d[\d.]*)\s*%\s+of\s+the\s+target.?s\s+pet\s+def/i,
        );
        mvM && (m.moonveilPct = parseFloat(mvM[1]) / 100);
        (cdM || crM || mdM) &&
          console.log(
            "[VBO11.81] Main passive parsed:",
            pet.name,
            "critDmg:",
            m.critDmg,
            "critRate:",
            m.critRate,
            "monsterDmg:",
            m.monsterDmg,
          );
      }
      isOrryphos(pet.name) && (m.noStamina = true);
      return Object.keys(m).length > 0 ? m : null;
    }
    function processPetCard(card, isMainSlot) {
      const pet = parsePetCard(card);
      if (!pet) return;
      const mainObj = buildMainObj(pet);
      const contrib = pet.isLegendary ? null : parsePassiveWithLog(pet);
      const petObj = {
        name: pet.name,
        atk: pet.atk,
        def: pet.def,
        level: pet.level,
        passiveText: pet.passiveText,
        isLegendary: pet.isLegendary,
        element: pet.element,
        elemRate: pet.elemRate,
        petInvId: pet.petInvId,
        ownedNow: true,
        equippedMain: isMainSlot,
        main: mainObj,
        contrib,
        linkable: !pet.isLegendary,
        linkedPets: [],
      };
      const engineRole =
        mainObj && (mainObj.grond || mainObj.bastior || mainObj.noStamina);
      isMainSlot || engineRole || pet.isLegendary
        ? mains.push(petObj)
        : links.push(petObj);
    }
    mainSection &&
      mainSection
        .querySelectorAll(".pet-card")
        .forEach((card) => processPetCard(card, true));
    invSection &&
      invSection
        .querySelectorAll(".pet-card")
        .forEach((card) => processPetCard(card, false));
    mains.length === 0 &&
      links.length === 0 &&
      doc
        .querySelectorAll(".pet-card, .slot-box[data-pet-inv-id]")
        .forEach((card) => {
          const pet = parsePetCard(card);
          if (!pet) return;
          const mainObj = buildMainObj(pet);
          const contrib = pet.isLegendary ? null : parsePassiveWithLog(pet);
          const petObj = {
            name: pet.name,
            atk: pet.atk,
            def: pet.def,
            level: pet.level,
            passiveText: pet.passiveText,
            isLegendary: pet.isLegendary,
            ownedNow: true,
            main: mainObj,
            contrib,
            linkable: !pet.isLegendary,
          };
          mainObj || pet.isLegendary ? mains.push(petObj) : links.push(petObj);
        });
    return { mains, links };
  }
  function mobFromCard(card, name, label, pageTitle, url, diffMode) {
    const monsterId = card.dataset.monsterId || null;
    const isBoss = card.dataset.boss === "1";
    let atk = 0,
      def = 0,
      hp = 0;
    const atkChip = card.querySelector(".atk-chip");
    const defChip = card.querySelector(".def-chip");
    atkChip &&
      (atk = parseInt((atkChip.textContent || "").replace(/[^0-9]/g, "")) || 0);
    defChip &&
      (def = parseInt((defChip.textContent || "").replace(/[^0-9]/g, "")) || 0);
    if (!atk || !def) {
      const statText = card.textContent || "";
      if (!atk) {
        const m = statText.match(/ATK\s*([0-9,]+)/i);
        m && (atk = parseInt(m[1].replace(/,/g, "")) || 0);
      }
      if (!def) {
        const m = statText.match(/DEF\s*([0-9,]+)/i);
        m && (def = parseInt(m[1].replace(/,/g, "")) || 0);
      }
    }
    card.querySelectorAll(".stat-value").forEach((sv) => {
      if (hp) return;
      const hpM = (sv.textContent || "").match(/([0-9,]+)\s*\/\s*([0-9,]+)/);
      hpM && (hp = parseInt(hpM[2].replace(/,/g, "")) || 0);
    });
    if (!hp) {
      const hpM2 = (card.textContent || "").match(/HP[:\s]+([0-9,]+)/i);
      hpM2 && (hp = parseInt(hpM2[1].replace(/,/g, "")) || 0);
    }
    let bFullUrl = null;
    if (monsterId)
      bFullUrl = "https://demonicscans.org/battle.php?id=" + monsterId;
    else {
      const battleLink = card.querySelector("a[href*='battle.php']");
      const bUrl = battleLink ? battleLink.getAttribute("href") : null;
      bFullUrl = bUrl
        ? bUrl.startsWith("http")
          ? bUrl
          : "https://demonicscans.org/" + bUrl.replace(/^\//, "")
        : null;
    }
    const mob = {
      name,
      gate: label,
      wave: pageTitle,
      atk,
      def,
      hp,
      waveUrl: url,
      petDef: 0,
      eqDef: 0,
      element: "None",
      elemRate: 0,
      diffMode,
      battleUrl: bFullUrl,
      effect: "",
      isBoss,
    };
    return { mob, battleUrl: bFullUrl };
  }
  function enrichMobFromBattle(mob, doc) {
    doc.querySelectorAll(".stat-block").forEach((sb) => {
      const labelEl = sb.querySelector(".label");
      const strongEl = sb.querySelector("strong");
      if (!labelEl || !strongEl) return;
      const labelTxt = labelEl.textContent.trim();
      const strongTxt = strongEl.textContent.trim();
      /^Level\s*Req/i.test(labelTxt) &&
        (mob.levelReq = parseInt(strongTxt.replace(/[^0-9]/g, ""), 10) || null);
      labelTxt === "ATK" &&
        (mob.atk = parseInt(strongTxt.replace(/[^0-9]/g, "")) || mob.atk);
      labelTxt === "DEF" &&
        (mob.def = parseInt(strongTxt.replace(/[^0-9]/g, "")) || mob.def);
      labelTxt === "MONSTER PET'S DEF" &&
        (mob.petDef = parseInt(strongTxt.replace(/[^0-9]/g, "")) || 0);
      labelTxt === "MONSTER EQ'S DEF" &&
        (mob.eqDef = parseInt(strongTxt.replace(/[^0-9]/g, "")) || 0);
      if (labelTxt === "Element") {
        mob.element = strongTxt.toUpperCase();
        const rateDiv = sb.querySelector("div");
        if (rateDiv) {
          const rateM = (rateDiv.textContent || "").match(
            /Element\s*Rate:\s*([0-9.]+)%/i,
          );
          rateM && (mob.elemRate = parseFloat(rateM[1]));
        }
      }
    });
    doc.querySelectorAll(".chip").forEach((chip) => {
      const txt = (chip.textContent || "").trim();
      txt.includes("Effect:") &&
        (mob.effect = txt.replace(/^\u{1F9E0}\s*/u, "").trim());
    });
    applyModalStats(mob, visibleText(doc));
    if (mob.levelReq == null) {
      const lrM = visibleText(doc).match(/Level\s*Req[a-z]*\s*:?\s*([0-9,]+)/i);
      lrM && (mob.levelReq = parseInt(lrM[1].replace(/,/g, ""), 10) || null);
    }
    const dmM = (
      doc.textContent ||
      (doc.body && doc.body.textContent) ||
      ""
    ).match(/Damage\s*Multiplier:\s*([0-9.]+)\s*%/i);
    if (dmM) {
      mob.divineMult = parseFloat(dmM[1]) / 100;
      console.log(
        "[VBO11.81] Divine Shield parsed:",
        mob.name,
        "multiplier:",
        mob.divineMult,
      );
    }
  }
  function mobFinalise(m) {
    if (m.battleUrl && !m.monsterId) {
      const _mid = m.battleUrl.match(/[?&]id=(\d+)/);
      _mid && (m.monsterId = _mid[1]);
      const _dg = m.battleUrl.match(/dgmid=(\d+)/);
      _dg && (m.dgmid = _dg[1]);
    }
    delete m.battleUrl;
    return m;
  }
  function effGapGrond(g) {
    if (g <= C.GROND_SOFTCAP) return Math.max(0, g);
    return (
      C.GROND_SOFTCAP +
      C.GROND_A * Math.log(1 + (g - C.GROND_SOFTCAP) / C.GROND_B)
    );
  }
  function effGapBastior(g) {
    if (g <= C.BASTIOR_SOFTCAP) return Math.max(0, g);
    return (
      C.BASTIOR_SOFTCAP +
      C.BASTIOR_A * Math.log(1 + (g - C.BASTIOR_SOFTCAP) / C.BASTIOR_B)
    );
  }
  function effGapCinderback(g) {
    if (g <= C.CINDERBACK_SOFTCAP) return Math.max(0, g);
    return (
      C.CINDERBACK_SOFTCAP +
      C.CINDERBACK_A * Math.log(1 + (g - C.CINDERBACK_SOFTCAP) / C.CINDERBACK_B)
    );
  }
  function condPass(cond, player, mob) {
    if (!cond) return true;
    if (cond === "atkDom")
      return player.atk > mob.atk && player.atk > player.def;
    if (cond === "defDom")
      return player.def > mob.def && player.def > player.atk;
    if (cond === "defGtMob") return player.def > mob.def;
    return true;
  }
  function buildDamage(player, mob, build, lite) {
    const { mains = [], links = [], pieces = {} } = build;
    const _rawAD = (player.atk || 0) + (player.def || 0);
    const _pvpRatio =
      player.level > 1 && _rawAD > 0 ? _rawAD / (5 * (player.level - 1)) : 0;
    const _pvpPen = _pvpRatio >= 0.8 ? 0.4 : _pvpRatio >= 0.6 ? 0.2 : 0;
    const _rawDef = player.def || 0;
    player = Object.assign({}, player, {
      atk: Math.round((player.atk || 0) * (1 + (player.classAtk || 0))),
      def: Math.round((player.def || 0) * (1 + (player.classDef || 0))),
    });
    const _cal = getCalibration();
    const _petSigilATK = PET_SIGIL_ATK || 0;
    const _petDefModal = mob.petDef || 0;
    const _obs = mob.monsterId != null ? MOB_OBS[String(mob.monsterId)] : null;
    const _petDefUsed = _obs && _obs.petDef > 0 ? _obs.petDef : _petDefModal;
    const _petDefSource = _obs && _obs.petDef > 0 ? "observed" : "modal";
    const _linkAware =
      mains.length > 0 && mains.every((m) => typeof m.baseAtk === "number");
    const _linkAtkSel = _linkAware
      ? links.reduce(
          (s, l) =>
            s + Math.round(((l.pet && l.pet.atk) || 0) * (l.factor || 0)),
          0,
        )
      : 0;
    const _petATKcards =
      mains.reduce((s, m) => s + (_linkAware ? m.baseAtk : m.atk || 0), 0) +
      _linkAtkSel +
      0 +
      (_cal.petAtkBonus || 0);
    const grondActive = mains.some((m) => m.main && m.main.grond);
    const bastiorActive = mains.some((m) => m.main && m.main.bastior);
    const cinderbackActive = mains.some((m) => m.main && m.main.cinderback);
    const mainCritDmg = mains.reduce(
      (s, m) => s + ((m.main && m.main.critDmg) || 0),
      0,
    );
    const mainCritRate = mains.reduce(
      (s, m) => s + ((m.main && m.main.critRate) || 0),
      0,
    );
    const mainMonster = mains.reduce(
      (s, m) => s + ((m.main && m.main.monsterDmg) || 0),
      0,
    );
    const equipATK = EQUIP_SLOTS.reduce((s, sl) => {
      const p = pieces[sl];
      return s + ((p && p.atk) || 0);
    }, 0);
    let pieceCritDmg = 0,
      pieceMonster = 0,
      pieceCritRate = 0;
    EQUIP_SLOTS.forEach((sl) => {
      const p = pieces[sl];
      if (p) {
        pieceCritDmg += p.critDmg || 0;
        pieceMonster += p.monsterDmg || 0;
        pieceCritRate += p.critRate || 0;
      }
    });
    const L = {
      critDmg: 0,
      critRate: 0,
      elemDmg: 0,
      monster: 0,
      eqPen: 0,
      petPen: 0,
      armorPen: 0,
      atkAdd: 0,
      defAdd: 0,
      flat: 0,
    };
    const _cbGap = Math.max(0, _rawDef - C.CB_MOBDEF * (mob.def || 0));
    links.forEach((l) => {
      const ct = l.pet.contrib;
      if (!ct) return;
      if (ct.cond === "defGtMob") {
        if (!(_cbGap > 0)) return;
      } else if (!condPass(ct.cond, player, mob)) return;
      const f = l.factor;
      if (isNaN(ct.val) || isNaN(f)) {
        console.error(
          "[VBO11.81] NaN in link contrib!",
          l.pet.name,
          "kind:",
          ct.kind,
          "val:",
          ct.val,
          "factor:",
          f,
          "passive:",
          l.pet.passiveText,
        );
        return;
      }
      if (ct.kind === "crit_dmg") L.critDmg += ct.val * f;
      else if (ct.kind === "crit_rate") L.critRate += ct.val * f;
      else if (ct.kind === "elem_dmg") L.elemDmg += ct.val * f;
      else if (ct.kind === "monster_dmg") L.monster += ct.val * f;
      else if (ct.kind === "eq_pen") L.eqPen += ct.val * f;
      else if (ct.kind === "pet_pen") L.petPen += ct.val * f;
      else if (ct.kind === "armor_pen") L.armorPen += ct.val * f;
      else if (ct.kind === "atk")
        L.atkAdd += ct.val * Math.max(0, player.atk - mob.atk) * f;
      else if (ct.kind === "def")
        L.defAdd += ct.val * Math.max(0, player.def - mob.def) * f;
      else if (ct.kind === "def_bonus") {
        let v = effGapCinderback(_cbGap) * ct.val * f;
        (player.stamina || 0) > _rawDef && (v *= 0.5);
        L.flat += v;
      }
    });
    const atk = player.atk + (player.relicATK || 0) + L.atkAdd;
    const playerDef = player.def + (player.relicDEF || 0) + L.defAdd;
    const _linkEqPen = Math.min(0.95, Math.max(0, L.eqPen || 0)),
      _linkPetPen = Math.min(0.95, Math.max(0, L.petPen || 0));
    const _penObs = MOB_PEN[String(mob.name || "")];
    const _grakthar = /^grakthar$/i.test(String(mob.gate || ""));
    const _basePen =
      _penObs && _penObs.pen != null
        ? _penObs.pen
        : _grakthar
          ? C.PEN_GRAKTHAR
          : _pvpPen;
    const _basePenSource =
      _penObs && _penObs.pen != null
        ? "observed"
        : _grakthar
          ? "grakthar-30"
          : "pvp-tier";
    const _armorPen = Math.min(0.95, Math.max(0, L.armorPen || 0));
    const _armorBase = Math.min(
      C.PEN_CAP,
      1 - (1 - _basePen) * (1 - _armorPen),
    );
    const totalEqPen = 1 - (1 - _armorBase) * (1 - _linkEqPen);
    const totalPetPen = 1 - (1 - _armorBase) * (1 - _linkPetPen);
    const eqDef = (mob.eqDef || 0) * (1 - Math.min(0.95, totalEqPen));
    const _petDefEff = _petDefUsed * (1 - Math.min(0.95, totalPetPen));
    const _mvPctText = mains.reduce(
      (s, m) => s + ((m.main && m.main.moonveilPct) || 0),
      0,
    );
    const _mvRateModel =
      _mvPctText > 0 ? _mvPctText * (1 - Math.min(0.95, totalPetPen)) : 0;
    const _mvRate =
      _mvRateModel > 0
        ? _mvRateModel
        : _cal.moonveilRate > 0
          ? _cal.moonveilRate
          : 0;
    const _moonveil = _mvRate > 0 ? Math.floor(_mvRate * _petDefUsed) : 0;
    const petDef = Math.max(0, _petDefEff - _moonveil);
    const petATKsum = _petATKcards + _moonveil;
    const _mobAtkEff = Math.max(0, (mob.atk || 0) - (RELICS.enemyAtkRed || 0));
    const _mobDefEff = Math.max(0, (mob.def || 0) - (RELICS.enemyDefRed || 0));
    const def = _mobDefEff;
    const equip_term = Math.max(C.FLOOR, equipATK - eqDef) * C.EQUIP_PER_ATK;
    const pet_term = Math.max(C.FLOOR, petATKsum - petDef) * C.EQUIP_PER_ATK;
    const atk_term = 1e3 * Math.pow(Math.max(C.FLOOR, atk - def), C.ATK_EXP);
    const base = (C.BASE_CONST + equip_term + pet_term + atk_term) * C.S;
    const totalStats =
      (player.atk || 0) + (playerDef || 0) + (player.stamina || 0);
    const adFrac =
      totalStats > 0 ? ((player.atk || 0) + (playerDef || 0)) / totalStats : 1;
    const buildScale = adFrac >= 0.6 ? 1 : adFrac >= 0.4 ? 0.6 : 0.3;
    const gap = atk - _mobAtkEff;
    const grondMain = mains.find((m) => m.main && m.main.grond);
    const _grondKParsed = !!(grondMain && grondMain.main.grondK);
    const grondK = _grondKParsed ? grondMain.main.grondK : C.GROND_K;
    if (grondActive && !_grondKParsed && !buildDamage._warnedK) {
      buildDamage._warnedK = true;
      console.warn(
        "[VBO11.81] Grondakar K not parsed from the pet passive; using fallback " +
          C.GROND_K +
          ". Predictions will be wrong for any player whose real K differs.",
      );
    }
    let grond =
      grondActive && gap > 0 && atk >= playerDef
        ? grondK * effGapGrond(gap) * buildScale
        : 0;
    const defGap = (playerDef || 0) - _mobDefEff;
    const bastiorMain = mains.find((m) => m.main && m.main.bastior);
    const _bastiorKParsed = !!(bastiorMain && bastiorMain.main.bastiorK);
    const bastiorK = _bastiorKParsed
      ? bastiorMain.main.bastiorK
      : C.BASTIOR_K || 0;
    if (bastiorActive && !_bastiorKParsed && !buildDamage._warnedBK) {
      buildDamage._warnedBK = true;
      console.warn(
        "[VBO11.81] Bastior K not parsed from the pet passive; using the UNCALIBRATED placeholder " +
          C.BASTIOR_K +
          ". This is not a measured value and predictions using it should not be trusted.",
      );
    }
    let bastior =
      bastiorActive && playerDef >= atk && defGap > 0
        ? bastiorK * effGapBastior(defGap) * buildScale
        : 0;
    const cinderbackMain = mains.find((m) => m.main && m.main.cinderback);
    const _cinderKParsed = !!(
      cinderbackMain && cinderbackMain.main.cinderbackK
    );
    const cinderbackK = _cinderKParsed ? cinderbackMain.main.cinderbackK : 0;
    let cinderback = 0;
    if (cinderbackActive && _cbGap > 0 && _cinderKParsed) {
      cinderback = cinderbackK * effGapCinderback(_cbGap);
      cinderbackMain.main.cinderbackHalves &&
        (player.stamina || 0) > _rawDef &&
        (cinderback *= 0.5);
    } else if (cinderbackActive && !_cinderKParsed && !buildDamage._warnedCK) {
      buildDamage._warnedCK = true;
      console.warn(
        "[VBO11.81] A Cinderback-shaped main is equipped but its K did not parse; contributing 0 rather than guessing. There is no fallback for it.",
      );
    }
    bastior += cinderback;
    const comboMain = mains.find((m) => m.main && m.main.comboGap);
    if (
      comboMain &&
      (grondActive || bastiorActive || cinderbackActive) &&
      !buildDamage._warnedCombo
    ) {
      buildDamage._warnedCombo = true;
      console.warn(
        "[VBO11.81] ILLEGAL PAIRING: a combined ATK+DEF gap pet is equipped with a gap engine, which its own passive forbids (" +
          ((comboMain.main.excludesWith || []).join(", ") || "see passive") +
          "). Its damage is UNMODELLED and this prediction is not trustworthy.",
      );
    }
    let flat = L.flat;
    const _passRes =
      typeof mob.passiveDmgRes === "number" && mob.passiveDmgRes > 0
        ? Math.min(100, mob.passiveDmgRes) / 100
        : null;
    if (_passRes !== null) {
      const mult = 1 - _passRes;
      grond *= mult;
      bastior *= mult;
      flat *= mult;
    } else if (mob.effect) {
      const flatPetM = mob.effect.match(
        /(?:flat pet bonus|pet bonus).*?(\d+)\s*%/i,
      );
      if (flatPetM) {
        const mult = 1 - parseInt(flatPetM[1]) / 100;
        grond *= mult;
        bastior *= mult;
        flat *= mult;
      }
    }
    const pElemBy = {};
    const _elemSources = [];
    EQUIP_SLOTS.forEach((sl) => {
      const p = pieces[sl];
      if (p && p.element && p.element !== "NONE" && p.element !== "None") {
        pElemBy[p.element] = (pElemBy[p.element] || 0) + (p.elemPct || 0);
        lite || _elemSources.push({
          src: "gear",
          slot: sl,
          name: p.name || null,
          elem: p.element,
          pts: p.elemPct || 0,
        });
      }
    });
    mains.forEach((m) => {
      if (m.element && m.elemRate > 0) {
        pElemBy[m.element] = (pElemBy[m.element] || 0) + m.elemRate;
        lite || _elemSources.push({
          src: "main",
          name: m.name || null,
          elem: m.element,
          pts: m.elemRate,
        });
      }
    });
    links.forEach((l) => {
      const el = l.pet && l.pet.element,
        r = (l.pet && l.pet.elemRate) || 0;
      if (el && el !== "NONE" && r > 0 && l.factor > 0) {
        pElemBy[el] = (pElemBy[el] || 0) + r * l.factor;
        lite || _elemSources.push({
          src: "link-card",
          name: l.pet.name || null,
          factor: l.factor,
          elem: el,
          raw: r,
          pts: r * l.factor,
          note: "link card element rate x share [in-game text: stats page VOID 46.793% = (41.055 + 2.5) x 1.07434]",
        });
      }
    });
    links.forEach((l) => {
      if (l.pet.contrib && l.pet.contrib.kind === "elem_rate") {
        const el = l.pet.contrib.elem;
        const base = pElemBy[el] || 0;
        const mult = 1 + (l.pet.contrib.val / 100) * l.factor;
        const after = base * mult;
        lite || _elemSources.push({
          src: "link",
          name: l.pet.name || null,
          factor: l.factor,
          elem: el,
          raw: l.pet.contrib.val,
          base,
          mult,
          pts: after - base,
          note: "AMPLIFIER: base x (1 + raw/100 x factor); no-op when base is 0 [MEASURED n=7, v11.48 run 2: x1.1487 +0.53% vs x1.2974 -1.04% vs flat -1.81%]",
        });
        pElemBy[el] = after;
      }
    });
    let pElem = "None",
      pRate = 0;
    Object.keys(pElemBy).forEach((el) => {
      if (pElemBy[el] > pRate) {
        pRate = pElemBy[el];
        pElem = el;
      }
    });
    const mElem = mob.element || "None",
      mRate = mob.elemRate || 0;
    let penaltyMult = 1,
      elem = 0;
    const _mHasElem =
      !!mElem &&
      String(mElem).trim() !== "" &&
      String(mElem).toUpperCase() !== "NONE";
    if (_mHasElem && pElem !== "None" && pRate > 0)
      if (pElem === mElem)
        pRate >= mRate
          ? (elem = ((pRate - mRate) / 100) * C.ELEM_150K * (1 + L.elemDmg))
          : (penaltyMult = 2 / 3);
      else {
        const pBeats = COUNTERS[pElem] && COUNTERS[pElem].indexOf(mElem) >= 0;
        const mBeats = COUNTERS[mElem] && COUNTERS[mElem].indexOf(pElem) >= 0;
        const pAdj = pRate * (pBeats ? 2 : 1);
        const mAdj = mRate * (mBeats ? 2 : 1);
        pAdj >= mAdj
          ? (elem =
              (Math.max(0, pAdj - mAdj) / 100) * C.ELEM_150K * (1 + L.elemDmg))
          : (penaltyMult = 2 / 3);
      }
    const critMult =
      CRIT_MULT_OVR && CRIT_MULT_OVR > 0
        ? CRIT_MULT_OVR
        : 1.5 +
          (player.hunterCritDmg || 0) +
          mainCritDmg +
          pieceCritDmg +
          L.critDmg;
    const pieceDragon = EQUIP_SLOTS.reduce(
      (s, sl) => s + ((pieces[sl] && pieces[sl].dragonDmg) || 0),
      0,
    );
    const _goblinDmg =
      /goblin/i.test(String(mob.name || "")) && RELICS.goblinDmg > 0
        ? RELICS.goblinDmg
        : 0;
    const monDmgMul =
      1 +
      (mob.race === "Dragon" ? pieceDragon : 0) +
      pieceMonster +
      L.monster +
      mainMonster +
      (RELICS.pveDamage || 0) +
      _goblinDmg;
    const baseE = base * monDmgMul;
    let noncrit, crit;
    if (penaltyMult < 1) {
      noncrit = (baseE + grond + bastior + flat) * penaltyMult;
      crit = (baseE * critMult + grond + bastior + flat) * penaltyMult;
    } else {
      noncrit = baseE + elem + grond + bastior + flat;
      crit = baseE * critMult + elem + grond + bastior + flat;
    }
    const divineMult =
      mob.divineMult > 0 && mob.divineMult < 1 ? mob.divineMult : 1;
    noncrit *= divineMult;
    crit *= divineMult;
    const _finalRes =
      typeof mob.finalDmgRes === "number" && mob.finalDmgRes > 0
        ? Math.min(100, mob.finalDmgRes) / 100
        : 0;
    if (_finalRes > 0) {
      noncrit *= 1 - _finalRes;
      crit *= 1 - _finalRes;
    }
    const cr =
      CRIT_RATE_OVR != null
        ? Math.min(1, CRIT_RATE_OVR)
        : Math.min(
            1,
            (player.baseCritRate || 0) +
              mainCritRate +
              pieceCritRate +
              L.critRate,
          );
    const dps = noncrit * (1 - cr) + crit * cr;
    if (lite) return { noncrit, crit, dps };     // the search only compares these; the chosen build is recomputed in full at the end
    (noncrit && !isNaN(noncrit) && base) ||
      console.warn(
        "[VBO11.81] DAMAGE ANOMALY &#x2014; noncrit:",
        noncrit,
        "base:",
        base,
        "baseE:",
        baseE,
        "equipATK:",
        equipATK,
        "petATK:",
        petATKsum,
        "atk:",
        atk,
        "def:",
        def,
        "grond:",
        grond,
        "bastior:",
        bastior,
        "elem:",
        elem,
        "flat:",
        flat,
        "penaltyMult:",
        penaltyMult,
        "monDmgMul:",
        monDmgMul,
        "mains:",
        mains.length,
        "links:",
        links.length,
        "pieces:",
        Object.keys(pieces).filter((k) => pieces[k]).length,
        "mob.atk:",
        mob.atk,
        "mob.def:",
        mob.def,
        "mob.eqDef:",
        mob.eqDef,
        "mob.petDef:",
        mob.petDef,
      );
    return {
      linkAware: _linkAware,
      linkAtk: _linkAtkSel,
      noncrit,
      crit,
      dps,
      critRate: cr,
      critMult,
      equipATK,
      petATK: petATKsum,
      grond: grond + bastior,
      elem,
      base: baseE,
      monDmgMul,
      pElem,
      pRate,
      penaltyMult,
      pvpPen: _pvpPen,
      pvpRatio: _pvpRatio,
      basePen: _basePen,
      basePenSource: _basePenSource,
      armorPenLinks: _armorPen,
      armorBasePen: _armorBase,
      divineMult,
      relics: RELICS,
      mobAtkEff: _mobAtkEff,
      mobDefEff: _mobDefEff,
      linkATK: 0,
      petSigilATK: _petSigilATK,
      petSigilApplied: 0,
      pElemBy,
      pElemSources: _elemSources,
      petDefUsed: _petDefUsed,
      petDefModal: _petDefModal,
      petDefSource: _petDefSource,
      petAtkBonus: _cal.petAtkBonus,
      moonveilRate: _mvRate,
      moonveilRateModel: _mvRateModel,
      moonveilRateMeasured: _cal.moonveilRate,
      moonveilApplied: _moonveil,
      petDefEff: _petDefEff,
      flat,
      bastior,
      monDmgMul,
      goblinApplied: _goblinDmg,
      grondK,
      grondKParsed: _grondKParsed,
      bastiorK,
      bastiorKParsed: _bastiorKParsed,
      cinderback,
      cinderbackK,
      engineVia:
        (grondMain && grondMain.main.engineVia) ||
        (bastiorMain && bastiorMain.main.engineVia) ||
        (cinderbackMain && cinderbackMain.main.engineVia) ||
        null,
      illegalPairing: !!(
        comboMain &&
        (grondActive || bastiorActive || cinderbackActive)
      ),
      finalDmgRes: _finalRes,
      passiveDmgRes: _passRes,
      critRateRes: mob.critRateRes,
      critDmgRes: mob.critDmgRes,
    };
  }
  let OPT_MODE = "noncrit";
  let CRIT_MULT_OVR = null,
    CRIT_RATE_OVR = null;
  // tick (optional): async function the search awaits between its heavy steps, so the page gets a turn every few tens of ms instead of
  // freezing for the whole search. It is called very often and must be cheap when it has nothing to do; the result is identical either way.
  async function optimizeBuild(player, mob, inventory, pets, rules, current, tick) {
    const _cal = readCalibration();
    _calMemo = _cal;
    const _tick = async () => { if (tick) { await tick(); _calMemo = _cal; } };
    try {
      return await optimizeBuild0(player, mob, inventory, pets, rules, current, _tick);
    } finally {
      _calMemo = null;
    }
  }
  async function optimizeBuild0(player, mob, inventory, pets, rules, current, tick) {
    const metricOf = (r) => (OPT_MODE === "dps" ? r.dps : r.noncrit);
    const _ex = (rules && rules.exclude) || {},
      _must = (rules && rules.must) || {},
      _notes = [];
    const { mains: mainPool0, links: linkPool0 } = pets;
    const mainPool = mainPool0.filter((p) => !_ex[p.name]),
      linkPool = linkPool0.filter((p) => !_ex[p.name]);
    const ownedMains = dedupeByName(
      mainPool.filter((m) => m.ownedNow !== false),
    );
    const ownedLinks = dedupeByName(
      linkPool.filter((l) => l.ownedNow !== false && l.contrib),
    );
    let mainCandidates = dedupeByName([
      ...ownedMains,
      ...linkPool.filter((l) => l.ownedNow !== false),
    ]);
    if (mainCandidates.length > 20) {
      const engine = mainCandidates.filter((p) => p.main);
      const rest = mainCandidates
        .filter((p) => !p.main)
        .sort((a, b) => (b.atk || 0) - (a.atk || 0));
      const forcedFirst = mainCandidates.filter((p) => _must[p.name]);
      mainCandidates = forcedFirst
        .concat([...engine, ...rest].filter((p) => !_must[p.name]))
        .slice(0, 20);
    }
    let _mustMain = mainCandidates
      .filter(
        (p) => _must[p.name] && !ownedLinks.some((l) => l.name === p.name),
      )
      .map((p) => p.name);
    if (_mustMain.length > 3) {
      _notes.push(
        "more than 3 must-use pets can only be mains (" +
          _mustMain.join(", ") +
          ") -- only the first 3 are forced",
      );
      _mustMain = _mustMain.slice(0, 3);
    }
    Object.keys(_must).forEach((n) => {
      !_must[n] ||
        mainCandidates.some((p) => p.name === n) ||
        ownedLinks.some((l) => l.name === n) ||
        _notes.push(
          'must-use pet "' + n + '" is not among your pets -- ignored',
        );
    });
    const bySlot = {};
    EQUIP_SLOTS.forEach((sl) => {
      bySlot[sl] = inventory.filter((i) => i.slot === sl);
    });
    // light evaluation: numbers only (see buildDamage's lite flag); the winner is recomputed in full at the end
    function ev(mains, pieces, links) {
      return buildDamage(player, mob, { mains, pieces, links }, true);
    }
    // what buildDamage reads of a gear piece / link pet: two with the same numbers can never beat each other (the search needs a strict gain)
    const _gearSig = (o) => o.atk + "|" + o.critDmg + "|" + o.monsterDmg + "|" + o.critRate + "|" + o.dragonDmg + "|" + o.element + "|" + o.elemPct;
    const equippedPieces = {};
    EQUIP_SLOTS.forEach((sl) => {
      const eq = inventory.find((i) => i.slot === sl && i.equipped);
      equippedPieces[sl] = eq || null;
    });
    const mainCombos =
      mainCandidates.length <= 3
        ? [mainCandidates]
        : (function (a) {
            const o = [];
            for (let i = 0; i < a.length; i++)
              for (let j = i + 1; j < a.length; j++)
                for (let k = j + 1; k < a.length; k++)
                  o.push([a[i], a[j], a[k]]);
            a.length <= 3 && o.push(a.slice(0, 3));
            return o;
          })(mainCandidates);
    let _legalCombos = mainCombos.filter(
      (ms) => ms.length && isLegalMainCombo(ms),
    );
    if (_mustMain.length) {
      const withMust = _legalCombos.filter((ms) =>
        _mustMain.every((n) => ms.some((m) => m.name === n)),
      );
      withMust.length
        ? (_legalCombos = withMust)
        : _notes.push(
            "no legal team contains all must-use mains (" +
              _mustMain.join(", ") +
              ") -- that rule was dropped",
          );
    }
    let bestMains = _legalCombos[0] || mainCandidates.slice(0, 3),
      bestMainDps = -1;
    const _ranked = [];
    _legalCombos.length < mainCombos.filter((ms) => ms.length).length &&
      console.log(
        "[VBO11.81] Excluded " +
          (mainCombos.filter((ms) => ms.length).length - _legalCombos.length) +
          " illegal main combo(s): a combined ATK+DEF gap pet cannot share a team with a gap engine (its own passive says so).",
      );
    for (let ci = 0; ci < _legalCombos.length; ci++) {
      const ms = _legalCombos[ci];
      const r = ev(ms, equippedPieces, []);
      _ranked.push({ ms, d: metricOf(r), i: _ranked.length });
      if (metricOf(r) > bestMainDps) {
        bestMainDps = metricOf(r);
        bestMains = ms;
      }
      await tick();
    }
    let _converged = false;
    async function refineEquip(mains, pieces, links) {
      let improved = true,
        guard = 0;
      while (improved && guard < 30) {
        improved = false;
        guard++;
        for (const sl of EQUIP_SLOTS) {
          const opts = bySlot[sl];
          if (!opts.length) continue;
          let bestP = pieces[sl],
            bestD = metricOf(ev(mains, pieces, links));
          const seen = new Set();
          for (const opt of opts) {
            if (
              sl === "Ring" &&
              pieces["Ring 2"] &&
              opt.name === pieces["Ring 2"].name
            )
              continue;
            if (
              sl === "Ring 2" &&
              pieces["Ring"] &&
              opt.name === pieces["Ring"].name
            )
              continue;
            const sg = _gearSig(opt);
            if (seen.has(sg)) continue;
            seen.add(sg);
            const t = Object.assign({}, pieces, { [sl]: opt });
            const d = metricOf(ev(mains, t, links));
            if (d > bestD + 1e-4) {
              bestD = d;
              bestP = opt;
              improved = true;
            }
          }
          pieces[sl] = bestP;
          await tick();
        }
      }
      _converged = !improved;
      return pieces;
    }
    async function fillLinks(mains, pieces) {
      const factors = [];
      for (let li = 1; li <= 2; li++)
        for (let mi = 0; mi < 3; mi++) {
          const main = mains[mi];
          const linked =
            main && main.linkedPets
              ? main.linkedPets.find((l) => l.linkLevel === li)
              : null;
          factors.push(linked ? linked.factor : li === 1 ? 0.5 : 0.25);
        }
      const used = new Set(mains.map((m) => m.name));
      const slots = factors.map((f, k) => ({ f, pet: null, lv: k < 3 ? 1 : 2 }));
      const cur = () =>
        slots
          .filter((sl) => sl.pet)
          .map((sl) => ({ pet: sl.pet, factor: sl.f, lv: sl.lv }));
      const withAt = (i, lp) =>
        slots
          .map((sl, k) =>
            k === i
              ? { pet: lp, factor: sl.f, lv: sl.lv }
              : sl.pet
                ? { pet: sl.pet, factor: sl.f, lv: sl.lv }
                : null,
          )
          .filter(Boolean);
      ownedLinks
        .filter((lp) => _must[lp.name] && !used.has(lp.name))
        .forEach((lp) => {
          let bi = -1,
            bd = -Infinity;
          slots.forEach((sl, i) => {
            if (sl.pet) return;
            const d = metricOf(ev(mains, pieces, withAt(i, lp)));
            if (d > bd) {
              bd = d;
              bi = i;
            }
          });
          if (bi >= 0) {
            slots[bi].pet = lp;
            used.add(lp.name);
          } else
            _notes.indexOf(
              'more must-use link pets than link slots -- "' +
                lp.name +
                '" does not fit',
            ) < 0 &&
              _notes.push(
                'more must-use link pets than link slots -- "' +
                  lp.name +
                  '" does not fit',
              );
        });
      for (let si = 0; si < slots.length; si++) {
        const slot = slots[si];
        if (slot.pet) continue;
        await tick();
        const links = cur();
        let bestPet = null,
          bestDps = metricOf(ev(mains, pieces, links));
        ownedLinks.forEach((lp) => {
          if (used.has(lp.name)) return;
          const t = withAt(si, lp);
          const d = metricOf(ev(mains, pieces, t));
          if (d > bestDps + 1e-4) {
            bestDps = d;
            bestPet = lp;
          }
        });
        if (!bestPet) {
          const baseline = metricOf(ev(mains, pieces, links));
          for (const lp of ownedLinks) {
            if (used.has(lp.name)) continue;
            const d = metricOf(ev(mains, pieces, withAt(si, lp)));
            if (d >= baseline - 1e-4) {
              bestPet = lp;
              break;
            }
          }
        }
        if (bestPet) {
          used.add(bestPet.name);
          slot.pet = bestPet;
        }
      }
      const links = cur();
      let swapImproved = true,
        swapGuard = 0;
      while (swapImproved && swapGuard < 10) {
        swapImproved = false;
        swapGuard++;
        for (let i = 0; i < links.length; i++)
          for (let j = i + 1; j < links.length; j++) {
            const currentDps = metricOf(ev(mains, pieces, links));
            const swapped = links.map((l, idx) => {
              if (idx === i) return { pet: links[j].pet, factor: l.factor, lv: l.lv };
              if (idx === j) return { pet: links[i].pet, factor: l.factor, lv: l.lv };
              return l;
            });
            const swapDps = metricOf(ev(mains, pieces, swapped));
            if (swapDps > currentDps + 1e-4) {
              links[i] = swapped[i];
              links[j] = swapped[j];
              swapImproved = true;
            }
          }
      }
      return links;
    }
    // Same steps as before, minus the repeats: fillLinks and refineEquip are deterministic, so (1) the links for the equipped gear are the
    // starting links, (2) fillLinks only has to run again when refineEquip changed a piece, and (3) a second refineEquip with the same links
    // on a finished (fixpoint) gear set cannot change anything.
    const _samePieces = (a, b) => EQUIP_SLOTS.every((sl) => a[sl] === b[sl]);
    const _sameLinks = (a, b) => a.length === b.length && a.every((l, i) => l.pet === b[i].pet && l.factor === b[i].factor);
    async function solveTrio(mains) {
      let pieces = Object.assign({}, equippedPieces);
      const currentLinks = await fillLinks(mains, pieces);
      let links = currentLinks,
        refinedWith = null,
        settled = false;
      for (let pass = 0; pass < 2; pass++) {
        if (settled && refinedWith && _sameLinks(refinedWith, links)) continue;
        const before = Object.assign({}, pieces);
        pieces = await refineEquip(mains, pieces, links);
        refinedWith = links;
        settled = _converged;
        if (!_samePieces(before, pieces)) links = await fillLinks(mains, pieces);
      }
      const optResult = ev(mains, pieces, links);
      const currentResult = ev(mains, equippedPieces, currentLinks);
      if (metricOf(currentResult) >= metricOf(optResult))
        return {
          mains,
          pieces: equippedPieces,
          links: currentLinks,
          result: currentResult,
        };
      return { mains, pieces, links, result: optResult };
    }
    const _sameTrio = (a, b) =>
      a.length === b.length && a.every((m) => b.some((x) => x.name === m.name));
    const _cands = [bestMains];
    _ranked
      .slice()
      .sort((a, b) => b.d - a.d || a.i - b.i)
      .forEach((x) => {
        _cands.length < 10 &&
          !_cands.some((c) => _sameTrio(c, x.ms)) &&
          _cands.push(x.ms);
      });
    let _curOk = false,
      _curMains = null;
    if (current && current.mains && current.mains.length) {
      _curMains = current.mains.filter(Boolean);
      const names = _curMains
        .map((m) => m.name)
        .concat(
          (current.links || [])
            .map((l) => l && l.pet && l.pet.name)
            .filter(Boolean),
        );
      _curOk =
        !names.some((n) => _ex[n]) &&
        Object.keys(_must).every(
          (n) =>
            !_must[n] ||
            names.indexOf(n) >= 0 ||
            !(
              mainCandidates.some((p) => p.name === n) ||
              ownedLinks.some((l) => l.name === n)
            ),
        );
      const pool = _curMains.map(
        (m) => mainCandidates.filter((p) => p.name === m.name)[0] || null,
      );
      pool.every(Boolean) &&
        isLegalMainCombo(pool) &&
        !pool.some((m) => _ex[m.name]) &&
        _mustMain.every((n) => pool.some((m) => m.name === n)) &&
        !_cands.some((c) => _sameTrio(c, pool)) &&
        _cands.push(pool);
    }
    let best = null;
    for (const ms of _cands) {
      const b = await solveTrio(ms);
      (!best || metricOf(b.result) > metricOf(best.result) + 1e-4) &&
        (best = b);
    }
    if (_curOk) {
      const cr = buildDamage(player, mob, {
        mains: _curMains,
        pieces: current.pieces || {},
        links: (current.links || []).filter(Boolean),
      });
      metricOf(cr) >= metricOf(best.result) - 1e-4 &&
        (best = {
          mains: _curMains,
          pieces: current.pieces || {},
          links: (current.links || []).filter(Boolean),
          result: cr,
        });
    }
    // the search compared light results (numbers only); the caller gets the full one, from the same formula, for the build that won
    best = Object.assign({}, best, { result: buildDamage(player, mob, { mains: best.mains, pieces: best.pieces, links: best.links }) });
    best.notes = _notes;
    best.trios = _cands.length;
    return best;
  }
  function dedupeByName(arr) {
    const by = {};
    arr.forEach((p) => {
      const k = (p.name || "").trim().toLowerCase();
      if (!k) return;
      if (!by[k]) {
        by[k] = p;
        return;
      }
      const winner = (p.atk || 0) > (by[k].atk || 0) ? p : by[k];
      const loser = winner === p ? by[k] : p;
      (winner.linkedPets && winner.linkedPets.length) ||
        !loser.linkedPets ||
        !loser.linkedPets.length ||
        (winner.linkedPets = loser.linkedPets);
      !winner.equippedMain &&
        loser.equippedMain &&
        (winner.equippedMain = true);
      !winner.main && loser.main && (winner.main = loser.main);
      !winner.contrib && loser.contrib && (winner.contrib = loser.contrib);
      by[k] = winner;
    });
    return Object.values(by);
  }
  function pct(n) {
    return (n * 100).toFixed(1) + "%";
  }

  /* ===================================================================================
   * END OF ENGINE. Core glue below.
   * ================================================================================= */
  const M = Core.model;
  const store = Core.store(ID, { def: { restore: null, threshold: 2 } });
  const DEFAULT_RELICS = { pveDamage: 0, enemyAtkRed: 0, enemyDefRed: 0, atk: 0, def: 0, goblinDmg: 0, parsed: false, raw: null };
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const bodyOf = (doc) => doc.body || doc.documentElement;
  const parseDoc = (html) => new DOMParser().parseFromString(String(html || ''), 'text/html');
  const parseHTML = (html) => bodyOf(parseDoc(html));            // what the engine's readers expect (an element)
  const badPage = (text) => !!(Core.auth && Core.auth.pageState && typeof text === 'string' && Core.auth.pageState(text) !== 'ok');
  const fresh = (url) => Core.net.fetchText(url, { force: true, ttl: 0 });
  async function pool(items, n, fn) {
    const q = items.slice();
    await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => { while (q.length) await fn(q.shift()); }));
  }

  /* ---- pet link pages: one request per pet, remembered for 5 min, dropped on any write ---- */
  const linkCache = new Map();
  async function petLinks(invId) {
    const hit = linkCache.get(String(invId));
    if (hit && Date.now() - hit.at < 5 * 60e3) return hit.data;
    let data = null;
    try { data = JSON.parse(await fresh('pet_links_ajax.php?pet_inv_id=' + encodeURIComponent(invId))); } catch (e) { data = null; }
    data && data.status === 'success' && linkCache.set(String(invId), { at: Date.now(), data });
    return data;
  }
  const dropLinks = () => linkCache.clear();
  Core.net.watch(/pet_link_action\.php|inventory_ajax\.php/, (r) => {
    // one request per pet is what makes a search slow, and a GEAR change (equip_item / unequip_item) cannot change what any pet has linked:
    // those keep the cache. Anything else (a link, a pet moved) drops it, as before.
    if (/inventory_ajax\.php/.test((r && r.url) || '') && /(^|&)action=(equip|unequip)_item(&|$)/.test(String((r && r.body) || ''))) return;
    dropLinks();
  });

  /* ---- resources ---- */
  M.defined('stats') || M.define('stats', {
    url: 'stats.php', maxAge: 60e3,
    parse(text, ctx) {
      if (badPage(text)) return null;
      const s = scrapeStats(ctx.doc());
      return s.atk && s.def && s.stamina ? s : null;
    },
  });
  M.define('gear', {                                              // PvE attack set: every item (optimizer shape) + what is on / in the bag (apply shape)
    url: 'inventory.php?set=attack', maxAge: 5 * 60e3,
    parse(text, ctx) {
      if (badPage(text)) return null;
      const b = bodyOf(ctx.doc());
      const live = gearParseInventory(b), items = parseInventoryDoc(b);
      return items.length || live.equipped.length ? { items, live } : null;
    },
  });
  M.define('team', {                                              // pets.php?team=attack + each pet's links; no url: nothing may feed it a bare page
    maxAge: 5 * 60e3,
    async load() {
      const html = await fresh('pets.php?team=attack');
      if (badPage(html)) return { pets: null };
      const body = parseHTML(html), pets = parsePetsDoc(body), links = {};
      await pool(pets.mains.concat(pets.links).filter((p) => p.petInvId), 4, async (p) => { links[p.petInvId] = await petLinks(p.petInvId); });
      return { pets, links, text: visibleText(body) };
    },
    parse(p) {
      if (!p || !p.pets || (!p.pets.mains.length && !p.pets.links.length)) return null;
      const pets = p.pets;
      pets.mains.concat(pets.links).forEach((mp) => {
        const data = p.links[mp.petInvId];
        data && data.status === 'success' && Array.isArray(data.links) && (mp.linkedPets = data.links.map((l) => {
          const sharePct = parseFloat((l.share_pct_label || '0').replace('%', '')) / 100;
          const maxFactor = l.link_level === 1 ? 0.5 : 0.25;
          return { name: l.name, linkLevel: l.link_level, factor: Math.min(sharePct, maxFactor), shareLabel: l.share_pct_label || null, addAttack: l.add_attack || 0, effectText: l.effect_text || '', raw: l };
        }));
      });
      petAnnotateBaseAtk(pets.mains, pets.links);
      const sg = parsePetSigilATK(p.text);
      pets.sigil = { atk: sg && sg.count > 0 ? sg.atk : 0, count: (sg && sg.count) || 0 };
      return pets;
    },
  });
  M.define('relics', {
    url: 'relics.php', maxAge: 30 * 60e3,
    parse(text, ctx) {
      if (badPage(text)) return null;
      const r = parseRelicPower(visibleText(bodyOf(ctx.doc())));
      return r && r.parsed ? r : Object.assign({}, DEFAULT_RELICS);
    },
  });
  M.define('class', {
    url: 'classes.php', maxAge: 6 * 3600e3,
    parse(text, ctx) { return badPage(text) ? null : { name: parseClassDoc(bodyOf(ctx.doc())) }; },
  });
  M.define('mob', {                                               // 'mob:<monster id>': boss page + its wave page (one card), ~24 h, kept in localStorage
    maxAge: 24 * 3600e3, hardMaxAge: 24 * 3600e3, persist: true,
    async load(ctx) {
      const id = ctx.arg, battleHtml = await Core.net.fetchText('battle.php?id=' + encodeURIComponent(id), { ttl: 20e3 });
      const back = parseDoc(battleHtml).querySelector("a[href*='active_wave']");
      let href = (back && back.getAttribute('href')) || '';
      if (!href) return { id, battleHtml, waveHtml: null, waveUrl: null };
      href.charAt(0) === '?' && (href = 'active_wave.php' + href);
      const waveUrl = new URL(href, location.origin).href;
      const waveHtml = await Core.net.fetchText(waveUrl, { ttl: 60e3, key: waveUrl + '#alive', via: (run) => Core.cookies.withMode('alive', run) });
      return { id, battleHtml, waveHtml, waveUrl };
    },
    parse(p) {
      if (!p || !p.battleHtml || badPage(p.battleHtml)) return null;
      const bb = parseHTML(p.battleHtml);
      let mob = null;
      if (p.waveHtml) {
        const wdoc = parseDoc(p.waveHtml), wb = bodyOf(wdoc);
        const card = pickMobCards(wb).filter((c) => c.dataset && String(c.dataset.monsterId) === String(p.id))[0];
        const nameEl = card && card.querySelector('h3, .monster-name');
        const rawName = card && (card.dataset.name || (nameEl ? nameEl.textContent.trim() : null));
        if (card && rawName) {
          const name = nameEl ? nameEl.textContent.trim() : rawName.replace(/\b\w/g, (c) => c.toUpperCase());
          const ev = p.waveUrl.match(/[?&]event=(\d+)/), g = p.waveUrl.match(/[?&]gate=(\d+)/);
          const label = ev ? 'Event ' + ev[1] : g ? 'Gate ' + g[1] : 'Unknown';
          const titleEl = wdoc.querySelector('h1, h2, .wave-title, .zone-title');
          const diffEl = Array.from(wdoc.querySelectorAll('strong')).find((x) => /mode/i.test(x.textContent));
          mob = mobFromCard(card, name, label, titleEl ? titleEl.textContent.trim() : label, p.waveUrl, diffEl ? diffEl.textContent.trim() : '').mob;
        }
      }
      if (!mob) {                                                 // no wave card: the boss page alone (name and HP may be missing)
        const h = bb.querySelector('h1, h2, .monster-name');
        mob = { name: (h && h.textContent.trim()) || 'Monster ' + p.id, gate: 'Unknown', wave: '', atk: 0, def: 0, hp: 0, waveUrl: p.waveUrl, petDef: 0, eqDef: 0, element: 'None', elemRate: 0, diffMode: '', battleUrl: null, effect: '', isBoss: false };
      }
      enrichMobFromBattle(mob, bb);
      mob.monsterId = String(p.id);
      mob = mobFinalise(mob);
      return mob.atk && mob.def ? mob : null;
    },
  });

  /* ---- inputs for the engine ---- */
  const ids = ['stats', 'gear', 'team', 'relics', 'class'];
  async function gather(opts, t) {
    const get = (id) => (t ? t.get(id, opts && opts.force ? { force: true } : {}) : M.get(id, opts && opts.force ? { force: true } : {}));
    const ms = {}, timed = (id) => { const t0 = Date.now(); return Promise.resolve(get(id)).then((v) => { ms[id] = Date.now() - t0; return v; }); };
    const r = await Promise.all(ids.map(timed));
    const o = { ms }; ids.forEach((id, i) => { o[id] = r[i]; });
    if (!(o.stats.value && o.stats.value.atk && o.stats.value.def && o.stats.value.stamina)) throw new Error('your stats could not be read (stats.php)');
    return o;
  }
  let prepKey = '', prepVal = null;
  function prepare(g) {
    const key = Core.player.id() + '|' + ids.map((id) => g[id].epoch).join('.');
    if (prepVal && prepKey === key) return prepVal;
    const player = clone(g.stats.value), pets = clone(g.team.value), inventory = clone(g.gear.value.items);
    player.playerClass = (g.class.value && g.class.value.name) || 'Unknown';
    const pc = player.playerClass.toLowerCase();
    if (pc === 'hunter') { player.hunterCritDmg = 0.2; player.classDef = -0.3; }
    else if (pc === 'mage') { player.classAtk = 0.25; player.classDef = -0.5; }
    const relics = g.relics.value && g.relics.value.parsed ? clone(g.relics.value) : Object.assign({}, DEFAULT_RELICS);
    relics.parsed && (!player.relicATK && relics.atk && (player.relicATK = relics.atk), !player.relicDEF && relics.def && (player.relicDEF = relics.def));
    prepKey = key;
    return (prepVal = { key, player, pets, inventory, relics, sigil: (pets.sigil && pets.sigil.atk) || 0, live: clone(g.gear.value.live) });
  }
  // the engine keeps its settings in module variables. settingsFor() returns the function that sets them; a search that yields to the page
  // calls it again after every yield, because a predict() or another search may have run in between and changed them.
  function settingsFor(P, opts) {
    return () => {
      RELICS = P.relics; PET_SIGIL_ATK = P.sigil;
      OPT_MODE = opts && opts.mode === 'dps' ? 'dps' : 'noncrit';
      CRIT_MULT_OVR = opts && opts.critMult != null ? Number(opts.critMult) : null;
      CRIT_RATE_OVR = opts && opts.critRate != null ? Number(opts.critRate) : null;
    };
  }
  function compute(P, opts, fn) { settingsFor(P, opts)(); return fn(); }
  // hands the page a turn. MessageChannel, not setTimeout: a hidden tab clamps timers to 1 s (then 1 min), which would stretch a search enormously.
  let _mc = null, _mcWait = null;
  function yieldToPage() {
    return new Promise((res) => {
      try {
        if (!_mc) { _mc = new MessageChannel(); _mc.port1.onmessage = () => { const f = _mcWait; _mcWait = null; f && f(); }; }
        _mcWait = res; _mc.port2.postMessage(0);
      } catch (e) { setTimeout(res, 0); }
    });
  }
  const mobKeyOf = (mob) => {     // the parts of a boss the damage maths reads (not its id, hp or page): identical bosses share one search
    const obs = mob.monsterId != null ? MOB_OBS[String(mob.monsterId)] : null, pen = MOB_PEN[String(mob.name || '')];
    return JSON.stringify([mob.atk, mob.def, obs && obs.petDef > 0 ? obs.petDef : mob.petDef, mob.eqDef, mob.element || 'None', mob.elemRate, mob.divineMult,
      mob.finalDmgRes, mob.passiveDmgRes, mob.effect || '', mob.race === 'Dragon', /^grakthar$/i.test(String(mob.gate || '')), pen && pen.pen != null ? pen.pen : null,
      /goblin/i.test(String(mob.name || ''))]);
  };
  const mobDefaults = { hp: 0, petDef: 0, eqDef: 0, element: 'None', elemRate: 0, effect: '' };
  async function resolveMob(x, t) {
    const isObj = x && typeof x === 'object';
    const id = isObj ? (x.monsterId != null ? x.monsterId : x.id) : x;
    const complete = isObj && x.atk != null && x.def != null && (x.petDef != null || x.eqDef != null || id == null || id === '');
    if (complete) return Object.assign({}, mobDefaults, clone(x));
    if (id == null || id === '') throw new Error('no boss given (a monster id or { monsterId, ... })');
    const r = await (t ? t.get('mob:' + id) : M.get('mob:' + id));
    return Object.assign({}, mobDefaults, clone(r.value), isObj ? clone(x) : {});
  }
  const shortMob = (m) => ({ monsterId: m.monsterId || null, name: m.name, atk: m.atk, def: m.def, petDef: m.petDef, eqDef: m.eqDef, element: m.element, hp: m.hp });

  /* ---- selections <-> engine builds (the optimizer's dropdown logic, without the dropdowns) ---- */
  function currentSel(P) {
    const eq = P.pets.mains.filter((m) => m.equippedMain && m.ownedNow !== false);
    const lname = (m, lv) => { const l = m && m.linkedPets ? m.linkedPets.find((x) => x.linkLevel === lv) : null; return l ? l.name : ''; };
    const gear = {};
    EQUIP_SLOTS.forEach((sl) => { const e = P.inventory.find((i) => i.slot === sl && i.equipped); gear[sl] = e ? e.name : ''; });
    return { mains: [0, 1, 2].map((i) => (eq[i] ? eq[i].name : '')), link1: [0, 1, 2].map((i) => lname(eq[i], 1)), link2: [0, 1, 2].map((i) => lname(eq[i], 2)), gear };
  }
  function buildFromSel(P, sel) {
    const mainPets = dedupeByName([...P.pets.mains, ...P.pets.links].filter((p) => p.ownedNow !== false));
    const linkPets = dedupeByName(P.pets.links.filter((l) => l.ownedNow !== false));
    const mains = [0, 1, 2].map((i) => (sel.mains && sel.mains[i] ? mainPets.find((p) => p.name === sel.mains[i]) : null)).filter(Boolean);
    const linkOf = (key, lv, dflt) => [0, 1, 2].map((i) => {
      const pet = sel[key] && sel[key][i] ? linkPets.find((p) => p.name === sel[key][i]) : null;
      if (!pet) return null;
      const main = mains[i], linked = main && main.linkedPets ? main.linkedPets.find((l) => l.linkLevel === lv) : null;
      return { pet, factor: linked && linked.name === pet.name ? linked.factor : dflt, lv };
    }).filter(Boolean);
    const pieces = {};
    EQUIP_SLOTS.forEach((sl) => { const name = (sel.gear && sel.gear[sl]) || ''; pieces[sl] = P.inventory.find((i) => i.name === name && i.slot === sl) || null; });
    return { mains, links: [...linkOf('link1', 1, 0.5), ...linkOf('link2', 2, 0.25)], pieces };
  }
  function selFromBest(P, b) {
    const isL1 = (l) => (l.lv ? l.lv === 1 : l.factor > 0.375);
    const l1 = b.links.filter(isL1).map((l) => l.pet.name), l2 = b.links.filter((l) => !isL1(l)).map((l) => l.pet.name);
    const cur = currentSel(P).gear, gear = {};
    EQUIP_SLOTS.forEach((sl) => { gear[sl] = b.pieces[sl] ? b.pieces[sl].name : cur[sl] || ''; });   // no better piece found: keep what is on
    const raw = { mains: [0, 1, 2].map((i) => (b.mains[i] ? b.mains[i].name : '')), link1: [0, 1, 2].map((i) => l1[i] || ''), link2: [0, 1, 2].map((i) => l2[i] || ''), gear };
    const all = P.pets.mains.concat(P.pets.links), petOf = (n) => { const ps = all.filter((p) => p.name === n); return ps.find((p) => p.equippedMain) || ps.find((p) => (p.linkedPets || []).length) || ps[0] || null; };
    const linkOn = (n, lv) => { const p = petOf(n); return p && p.linkedPets ? p.linkedPets.find((x) => x.linkLevel === lv) || null : null; };
    const share = (n, lv) => { const l = linkOn(n, lv); return l ? l.factor : (lv === 1 ? 0.5 : 0.25); };
    return alignPets(raw, currentSel(P).mains, (n, lv) => { const l = linkOn(n, lv); return l ? l.name : ''; },
      (lv, ms) => { const f = ms.map((n) => share(n, lv)); return f.every((x) => Math.abs(x - f[0]) < 1e-9); });
  }
  function petRules(opts) {                                       // the optimizer's saved "must use / exclude" pets, unless the caller passes rules
    if (opts && opts.rules) return { exclude: opts.rules.exclude || {}, must: opts.rules.must || {} };
    let o = null; try { o = JSON.parse(localStorage.getItem('veyra_opt_pet_rules') || 'null'); } catch (e) { o = null; }
    const r = { exclude: {}, must: {} };
    Object.keys(o || {}).forEach((k) => { o[k] === 'x' ? (r.exclude[k] = true) : o[k] === 'm' && (r.must[k] = true); });
    return r;
  }
  const diffSel = (a, b) => {
    const out = [];
    [0, 1, 2].forEach((i) => { (a.mains[i] || '') !== (b.mains[i] || '') && out.push('Main ' + (i + 1) + ': ' + (a.mains[i] || 'none') + ' -> ' + (b.mains[i] || 'none')); });
    ['link1', 'link2'].forEach((k) => [0, 1, 2].forEach((i) => { (a[k][i] || '') !== (b[k][i] || '') && out.push(k.replace('link', 'Link ') + ' of main ' + (i + 1) + ': ' + (a[k][i] || 'none') + ' -> ' + (b[k][i] || 'none')); }));
    EQUIP_SLOTS.forEach((sl) => { (a.gear[sl] || '') !== (b.gear[sl] || '') && out.push(sl + ': ' + (a.gear[sl] || 'none') + ' -> ' + (b.gear[sl] || 'none')); });
    return out;
  };

  /* ---- build.predict / build.best ---- */
  async function predict(mobArg, sel, opts) {
    opts = opts || {};
    const P = prepare(await gather(opts)), mob = await resolveMob(mobArg);
    const build = buildFromSel(P, sel || currentSel(P));
    return { ok: true, mob: shortMob(mob), sel: sel || currentSel(P), result: compute(P, opts, () => buildDamage(P.player, mob, build)) };
  }
  const bestCache = new Map(), inflight = new Map();
  let lastYield = 0, dataGen = 0;                              // dataGen: bumped when gear / pets / stats change, so a search that was running across the change is not cached
  async function best(mobArg, opts) {
    opts = opts || {};
    const T0 = Date.now(), G = await gather(opts), P = prepare(G), T1 = Date.now(), mob = await resolveMob(mobArg), T2 = Date.now(), rules = petRules(opts);
    const key = [P.key, mobKeyOf(mob), opts.mode || 'noncrit', JSON.stringify(rules), opts.critMult, opts.critRate].join('|');
    let hit = bestCache.get(key);
    if (hit && !opts.force) return Object.assign({ cached: true }, hit, { mob: shortMob(mob), timing: { total: Date.now() - T0, cached: true } });
    const flying = inflight.get(key);                          // the same search is already running (another tab or addon asked): wait for it
    if (flying && !opts.force) { await flying.catch(() => {}); const h2 = bestCache.get(key); if (h2) return Object.assign({ cached: true }, h2, { mob: shortMob(mob), timing: { total: Date.now() - T0, cached: true } }); }
    const gen0 = dataGen;
    let done; inflight.set(key, new Promise((r) => { done = r; }));
    const cs = currentSel(P), cur = buildFromSel(P, cs);
    let out;
    try {
      const apply = settingsFor(P, opts);
      out = await compute(P, opts, async () => {
        const curRes = buildDamage(P.player, mob, cur);
        const b = await optimizeBuild(P.player, mob, P.inventory, P.pets, rules, cur, async () => {
          if (Date.now() - lastYield < 40) return;             // only hand the page a turn once ~40 ms of maths has run
          await yieldToPage(); apply(); lastYield = Date.now();
        });
        return { curRes, b };
      });
    } finally { inflight.delete(key); done(); }
    const T3 = Date.now(), sel = selFromBest(P, out.b), r = out.b.result, c = out.curRes;
    hit = {
      ok: true, mode: opts.mode || 'noncrit', mob: shortMob(mob),
      current: { sel: cs, result: c }, best: { sel, result: r, notes: out.b.notes || [] },
      gainPct: (() => { const k = opts.mode === 'dps' ? 'dps' : 'noncrit'; return c && c[k] ? 100 * (r[k] / c[k] - 1) : 0; })(),   // the metric the search maximised, or the equip decision could skip a better build
      gainNoncritPct: c && c.noncrit ? 100 * (r.noncrit / c.noncrit - 1) : 0,
      changes: diffSel(cs, sel),
      timing: { total: T3 - T0, pages: T1 - T0, boss: T2 - T1, search: T3 - T2, slowPage: Object.keys(G.ms || {}).sort((a, b) => G.ms[b] - G.ms[a]).slice(0, 2).map((k) => k + ' ' + G.ms[k] + ' ms').join(', ') },   // pages = reading your stats / gear / pets / relics / class; search = the maths
    };
    if (gen0 === dataGen) {
      bestCache.size > 30 && bestCache.delete(bestCache.keys().next().value);
      bestCache.set(key, hit);
    }
    return hit;
  }
  M.watch('*', (e) => { /gear|team|stats|relics|class/.test(e.id) && (bestCache.clear(), dataGen++); });

  /* ---- apply / revert, through Core.tx ('loadout') ---- */
  function makeEnv(t) {
    const post = (url, body) => t.post(url, body);
    async function linksOf(invId) {
      const txt = await fresh('pet_links_ajax.php?pet_inv_id=' + encodeURIComponent(invId));
      let j = null;
      try { j = JSON.parse(txt); } catch (e) { throw new Error('pet_links_ajax not JSON for ' + invId + ': ' + txt.slice(0, 80)); }
      if (!j || j.status !== 'success') throw new Error('pet_links_ajax status ' + (j && j.status) + ' for ' + invId);
      return j;
    }
    async function readState() {
      const inv = swParseInventory(parseHTML(await fresh('pets.php?team=attack')));
      const mains = [null, null, null];
      inv.mains.forEach((p) => { p.slot >= 1 && p.slot <= 3 && (mains[p.slot - 1] = p.invId); });
      if (inv.mains.length && mains.every((x) => x == null)) throw new Error('team cards found but no unequipPet(slot) ids -- page shape changed, refusing to act');
      const links = {}, ajax = {};
      let candidates = [];
      for (const m of mains) {
        if (m == null) continue;
        const j = await linksOf(m);
        ajax[m] = j;
        const l = [null, null];
        (j.links || []).forEach((x) => { (x.link_level !== 1 && x.link_level !== 2) || (l[x.link_level - 1] = x.inv_id); });
        links[m] = l;
        j.candidates && j.candidates.length && (candidates = j.candidates);
      }
      const byId = {};
      inv.mains.concat(inv.inventory).forEach((p) => { p.invId == null || byId[p.invId] || (byId[p.invId] = p); });
      return { mains, links, ajax, candidates, inv, byId };
    }
    async function doPet(a) {
      if (a.type === 'equip' || a.type === 'unequip') {
        const body = a.type === 'equip' ? 'action=equip_pet&team=attack&pet_inv_id=' + encodeURIComponent(a.pet) + '&slot_id=' + a.slot : 'action=unequip_pet&team=attack&slot_id=' + a.slot;
        const r = await post('inventory_ajax.php', body);
        if (r.status !== 200 || String(r.text).trim() !== 'OK') throw new Error(a.type + ' slot ' + a.slot + ' replied ' + r.status + ' ' + String(r.text).slice(0, 80));
        return;
      }
      const j = await linksOf(a.main);
      if (!j.csrf) throw new Error('no csrf in pet_links_ajax for ' + a.main);
      const body = (a.type === 'link' ? 'action=set' : 'action=remove') + '&csrf=' + encodeURIComponent(j.csrf) + '&pet_inv_id=' + encodeURIComponent(a.main) + '&link_level=' + a.level + (a.type === 'link' ? '&link_pet_id=' + encodeURIComponent(a.pet) : '');
      const r = await post('pet_link_action.php', body);
      const k = r.json;
      if (r.status !== 200 || !k || k.status !== 'success') throw new Error(a.type + ' ' + a.main + ':' + a.level + ' replied ' + r.status + ' ' + String(r.text).slice(0, 120));
    }
    async function gearDo(a) {
      const body = a.type === 'unequip' ? 'action=unequip_item&slot_id=' + a.slotId + '&set=attack' : 'action=equip_item&inv_id=' + encodeURIComponent(a.invId) + '&slot_id=' + a.slotId + '&set=attack';
      const r = await post('inventory_ajax.php', body);
      if (r.status !== 200 || String(r.text).trim() !== 'OK') throw new Error('gear ' + a.type + ' ' + a.name + ' replied ' + r.status + ' ' + String(r.text).slice(0, 100));
    }
    return {
      readState, linksOf, doPet, gearDo,
      gearRead: () => gearReadPage(async (u) => ({ status: 200, text: () => fresh(u) }), (ms) => Core.sleep(ms)),
      sleep: () => Core.sleep(1200), log: (m) => t.step(String(m).trim()), save: () => {},
    };
  }
  async function takeSnapshot(t, bench) {                         // the exact state to go back to
    const env = makeEnv(t), st = await env.readState(), g = await env.gearRead();
    await lbBench(env, st, st.mains.filter((x) => x != null).concat(bench || []));
    const names = lbPetTarget({ mains: [], link1: [], link2: [], gear: {} }, st).names, links = {};
    Object.keys(st.links || {}).forEach((m) => { links[m] = (st.links[m] || [null, null]).slice(); });
    return { ts: Date.now(), mains: st.mains.slice(), links, gear: lbGearBySlot(g.equipped), names };
  }
  async function restoreFrom(before, t) {
    const r = await lbRestore(makeEnv(t), Object.assign({}, before));
    if (!r.ok) throw new Error(r.problems.join('; '));
  }
  async function verifyAgainst(t, wantPets, wantGear) {            // wantPets: { mains, links } (inv ids) | null; wantGear: slot->name | null
    const env = makeEnv(t), why = [];
    if (wantPets) {
      const st = await env.readState();
      await lbBench(env, st, Object.keys(wantPets.links || {}));
      why.push(...swMatches(st, wantPets).why);
    }
    if (wantGear) why.push(...lbGearCheck(wantGear, (await env.gearRead()).equipped).why);
    return { ok: !why.length, why };
  }
  const benchHolders = (P) => P.pets.mains.concat(P.pets.links).filter((p) => p.petInvId && (p.linkedPets || []).length && !p.equippedMain).map((p) => p.petInvId);

  // gear changes your stats, so they are re-read afterwards: but they are not in the tx's stale list, or a stat allocation / potion mid-apply would abort it
  const statsStale = () => { try { typeof M.stale === 'function' && M.stale(['stats'], 'build-engine'); } catch (_) { /* */ } };
  async function apply(arg, opts) {
    opts = opts || {};
    const sel = arg && arg.best ? arg.best.sel : arg && arg.sel ? arg.sel : arg;
    if (!sel || !Array.isArray(sel.mains) || !sel.gear) throw new Error('build.apply needs a result of build.best or a selection { mains, link1, link2, gear }');
    const P = prepare(await gather(opts)), bench = benchHolders(P);
    const hook = typeof opts.onStep === 'function' ? (e) => { try { opts.onStep(e); } catch (_) { /* a progress callback must never break the apply */ } } : null;
    let before = null, expected = null, petActs = 0;
    const res = await Core.tx.run('loadout', {
      owner: ID, kind: 'apply', label: opts.label || 'Best build', ifBusy: opts.silent ? 'fail' : 'wait', stale: ['gear', 'team'],
      snapshot: async (t) => (before = await takeSnapshot(t, bench)),
      async apply(t) {
        const env = makeEnv(t), st = await env.readState();
        const first = lbPetTarget(sel, st);
        if (first.errors.length) throw new Error(first.errors.join('; '));
        await lbBench(env, st, first.target.mains.concat(bench));
        const pt = lbPetTarget(sel, st), g = await env.gearRead(), gp = lbGearPlan(sel.gear, g, P.inventory);
        const errs = pt.errors.concat(gp.errors);
        if (errs.length) throw new Error(errs.join('; '));
        expected = { pets: pt.target, gear: sel.gear };
        petActs = await lbApplyPets(env, pt.target, pt.names, bench, hook);
        const n = petActs + (await lbApplyGear(env, sel.gear, P.inventory, hook));
        return { ok: true, changed: n > 0, count: n };
      },
      verify: async ({ phase, t }) => (phase === 'apply' ? verifyAgainst(t, expected && expected.pets, expected && expected.gear) : before ? verifyAgainst(t, { mains: before.mains, links: before.links }, before.gear) : { ok: true, why: [] }),
      restore: (b, t) => restoreFrom(b, t),
    });
    statsStale();
    (petActs || !res.ok) && dropLinks();                          // gear only and fine: every pet's links are still what they were
    if (res.ok && res.changed && before) store.update((s) => { s.restore = before; });
    return { ok: !!res.ok, changed: !!res.changed, message: res.ok ? (res.changed ? 'build applied' : 'already on') : (res.restored ? 'failed and put back: ' : 'failed: ') + (res.error || '?'), tx: res.tx, restored: res.restored, error: res.error };
  }
  async function revert() {
    const saved = store.get().restore;
    if (!saved) return { ok: false, message: 'nothing to revert' };
    const res = await Core.tx.run('loadout', {
      owner: ID, kind: 'restore', label: 'Revert build', ifBusy: 'wait', stale: ['gear', 'team'],
      apply: (t) => restoreFrom(saved, t),
      verify: ({ t }) => verifyAgainst(t, { mains: saved.mains, links: saved.links }, saved.gear),
    });
    statsStale(); dropLinks();
    res.ok && store.update((s) => { s.restore = null; });
    return { ok: !!res.ok, message: res.ok ? 'previous build put back' : 'revert failed: ' + (res.error || '?') + ' (it is kept, try again)', error: res.error };
  }

  /* ---- offered to the other addons ---- */
  const safe = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { return { ok: false, message: String((e && e.message) || e) }; } };
  const api = { predict: safe(predict), best: safe(best), apply: safe(apply), revert: safe(revert), version: VERSION, _engine: { buildDamage, optimizeBuild, EQUIP_SLOTS, compute, settingsFor, mobKeyOf } };
  Core.module({
    id: ID, name: 'Build Engine', version: VERSION,
    provides: {
      'build.predict': { fn: api.predict, doc: 'damage of your CURRENT build (or of a selection) on a boss', args: '(mob, sel?, { mode?, force? })', returns: 'Promise<{ ok, result: { noncrit, crit, dps, ... } }>' },
      'build.best': { fn: api.best, doc: 'search the best gear + pets + links for a boss; changes nothing', args: "(mob, { mode?: 'noncrit'|'dps', rules?, force? })", returns: 'Promise<{ ok, best: { sel, result }, current, gainPct, changes[] }>' },
      'build.apply': { fn: api.apply, doc: 'equip a build.best result (or a selection) through Core.tx', args: '(planOrSel, { silent? })', returns: 'Promise<{ ok, message, changed }>' },
      'build.revert': { fn: api.revert, doc: 'put back what the last build.apply replaced', returns: 'Promise<{ ok, message }>' },
      'preset.best.list': { fn: () => [{ id: 'best', name: 'Best build for the boss' }], doc: 'the engine as a preset', returns: '[{ id, name }]' },
      'preset.best.apply': {
        doc: 'search for the target boss and equip the best build if it gains enough', args: '(id, { target, threshold? = 2 (%), mode?, silent?, onStep?(ev) })', returns: 'Promise<{ ok, message, changed }>',
        fn: safe(async (_id, o) => {
          o = o || {};
          if (!o.target) return { ok: false, message: 'preset.best.apply needs { target: <boss> }' };
          const b = await best(o.target, { mode: o.mode });
          const min = o.threshold != null ? Number(o.threshold) : store.get().threshold;
          if (!b.changes.length || b.gainPct < min) return { ok: true, changed: false, message: 'current build is within ' + min + '% of the best (' + b.gainPct.toFixed(2) + '%)', gainPct: b.gainPct, timing: b.timing };
          const tApply = Date.now(), r = await apply(b, { silent: o.silent !== false, label: 'Best build: ' + (b.mob.name || ''), onStep: o.onStep });
          return Object.assign(r, { gainPct: b.gainPct, timing: Object.assign({}, b.timing, { apply: Date.now() - tApply }) });
        }),
      },
    },
    init() {
      Core.tx.recovery('loadout', async (journal, t) => {         // an interrupted apply of ours: put `before` back
        if (!journal || journal.owner !== ID || !journal.before) return { ok: false, message: 'not a build-engine journal' };
        await restoreFrom(journal.before, t); statsStale();
        return { ok: true, changed: true };
      }, { stale: ['gear', 'team'] });
      return api;
    },
  });
})();
