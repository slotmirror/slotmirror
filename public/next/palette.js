// Command palette (Cmd/Ctrl+K) and shortcuts. The server renders options, sheet and texts
// (src/pages/next/palette.tsx). A chosen link or reload button is clicked after the dialog closed,
// so enhance.js and the unsaved-changes guard treat it as any click. Single keys (g o/m/c/a, ?)
// skip text fields, modifiers, composition and open dialogs; the user menu turns them off
// (WCAG 2.1.4). j/k live in panel.js. Speed plan, sections 6 and 7.
(() => {
  const w = window;
  const d = document;
  const loaded = (w.slotmirrorScripts ??= {});
  if (loaded.palette) return;

  // Matching (pure, exposed for tests)
  const fold = (s) => s.toLowerCase().replace(/ß/g, "ss").normalize("NFD").replace(/[̀-ͯ]/g, "");
  const translit = (s) =>
    fold(s.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue"));
  const entry = (label, keywords = "") => ({
    l: fold(label),
    t: translit(label),
    k: fold(keywords),
  });
  const wordStart = (hay, at) => at === 0 || !/[a-z0-9]/.test(hay[at - 1]);
  // Letters in order with gaps of at most 3.
  const loose = (hay, tok) => {
    let at = -1;
    for (const ch of tok) {
      const next = hay.indexOf(ch, at + 1);
      if (next < 0 || (at >= 0 && next - at > 4)) return false;
      at = next;
    }
    return true;
  };
  // All tokens must match: label start 100, word start 70, substring 40, keyword 30/20, loose 15.
  // In typed order +10, before the previous token half, so "konto 2 konto 1" finds "Konto 2 to …".
  // The whole query adds the best of: the label is the query +200, the label starts with it +100,
  // it starts a word of the label +60. So "konto 2" puts the calendar "Konto 2" first.
  const score = (e, query) => {
    const q = fold(query).trim().replace(/\s+/g, " ");
    const tokens = q.split(" ").filter(Boolean);
    let total = 0;
    let pos = 0;
    for (const tok of tokens) {
      const hay = e.l.includes(tok) ? e.l : e.t;
      let best = 0;
      let end = pos;
      for (let at = hay.indexOf(tok); at >= 0; at = hay.indexOf(tok, at + 1)) {
        let s = at === 0 ? 100 : wordStart(hay, at) ? 70 : 40;
        s = at >= pos ? s + 10 : s / 2;
        if (s > best) [best, end] = [s, at + tok.length];
      }
      if (!best) {
        const at = e.k.indexOf(tok);
        best = at < 0 ? (loose(e.l, tok) ? 15 : 0) : wordStart(e.k, at) ? 30 : 20;
      }
      if (!best) return 0;
      total += best;
      pos = end;
    }
    if (!total) return 0;
    const at = e.l.indexOf(q);
    return total + (e.l === q ? 200 : at === 0 ? 100 : at > 0 && wordStart(e.l, at) ? 60 : 0);
  };

  // Storage: blocked storage keeps choices in memory, for this page only.
  const memory = new Map();
  const store = (key, value) => {
    if (value !== undefined) memory.set(key, value);
    try {
      if (value !== undefined) return localStorage.setItem(key, value);
      return localStorage.getItem(key) ?? memory.get(key) ?? null;
    } catch {
      return memory.get(key) ?? null;
    }
  };
  const RECENT = "slotmirror-recent";
  const SINGLE = "slotmirror-single-keys";
  // Ids only, never names: a link's address, else `data-id` ("a:reload").
  const recents = () => {
    try {
      const list = JSON.parse(store(RECENT) ?? "[]");
      return Array.isArray(list) ? list.filter((id) => typeof id === "string").slice(0, 5) : [];
    } catch {
      return [];
    }
  };
  const idOf = (el) =>
    el.dataset.id ?? (el.hasAttribute("hreflang") ? "" : el.getAttribute("href"));
  const remember = (id) => {
    if (id && !id.startsWith("t:") && id !== "a:keys") {
      store(RECENT, JSON.stringify([id, ...recents().filter((x) => x !== id)].slice(0, 5)));
    }
  };
  const singleKeys = () => store(SINGLE) !== "off";

  // The palette

  const $ = (sel, root = d) => root.querySelector(sel);
  const dialog = () => $("#palette");
  const input = () => $("#palette input");
  const OPTION = "[role=option]";
  // Groups by id (`pg-<id>`): the server's order for an empty query, and the tie-break otherwise.
  const ORDER = ["pages", "mirrorings", "calendars", "actions", "settings"];
  const PRIORITY = ["pages", "calendars", "mirrorings", "actions", "settings"];
  /** With an empty query only recents, pages and actions show; the rest needs a word. */
  const BROWSE = ["pages", "actions"];
  const groupId = (group) => (group.getAttribute("aria-labelledby") ?? "").slice(3);
  let items = [];
  let active = null;
  let countTimer = 0;
  let passing = false;

  const setActive = (el) => {
    if (active) active.removeAttribute("aria-selected");
    active = el ?? null;
    const box = input();
    if (active) {
      active.setAttribute("aria-selected", "true");
      box?.setAttribute("aria-activedescendant", active.id);
      active.scrollIntoView?.({ block: "nearest" });
    } else box?.removeAttribute("aria-activedescendant");
  };

  // The recent options as copies, first in the list.
  const fillRecent = (dlg) => {
    const group = $("[data-recent]", dlg);
    if (!group) return [];
    for (const old of group.querySelectorAll(OPTION)) old.remove();
    const ids = recents();
    let n = 0;
    for (const id of ids) {
      const source = [...dlg.querySelectorAll(`.pg:not([data-recent]) ${OPTION}`)].find(
        (el) => idOf(el) === id,
      );
      if (!source) continue;
      const copy = source.cloneNode(true);
      copy.id = `pr-${n++}`;
      copy.removeAttribute("aria-selected");
      group.append(copy);
    }
    return ids;
  };

  const filter = () => {
    const dlg = dialog();
    const query = input()?.value.trim() ?? "";
    const list = $("[role=listbox]", dlg);
    const recentGroup = $("[data-recent]", dlg);
    const ranks = recents();
    const groups = [...list.querySelectorAll(".pg:not([data-recent])")];
    let shown = 0;
    for (const it of items) {
      it.s = query ? score(it.e, query) : BROWSE.includes(groupId(it.group)) ? 1 : 0;
    }
    for (const group of groups) {
      const mine = items.filter((it) => it.group === group);
      const rank = (it) => (ranks.includes(idOf(it.el)) ? ranks.indexOf(idOf(it.el)) : 9);
      mine.sort((a, b) =>
        query
          ? b.s - a.s || rank(a) - rank(b) || a.e.l.length - b.e.l.length || a.i - b.i
          : a.i - b.i,
      );
      let best = 0;
      for (const it of mine) {
        it.el.hidden = !it.s;
        group.append(it.el);
        best = Math.max(best, it.s);
        if (it.s) shown++;
      }
      group.hidden = best === 0;
      group._best = query ? best : 0;
    }
    const tie = query ? PRIORITY : ORDER;
    const at = (group) => {
      const i = tie.indexOf(groupId(group));
      return i < 0 ? tie.length : i;
    };
    groups.sort((a, b) => b._best - a._best || at(a) - at(b));
    for (const group of groups) list.append(group);
    if (recentGroup) recentGroup.hidden = Boolean(query) || !recentGroup.querySelector(OPTION);
    $(".palette-empty", dlg).hidden = shown > 0;
    const first = [...list.querySelectorAll(`${OPTION}:not([hidden])`)].find(
      (el) => !el.closest("[hidden]"),
    );
    setActive(first);
    clearTimeout(countTimer);
    countTimer = setTimeout(() => {
      const out = $("[data-count]", dlg);
      if (out)
        out.textContent = (shown === 1 ? out.dataset.one : out.dataset.many).replace("{n}", shown);
    }, 300);
  };

  const order = () => {
    const list = $("#palette [role=listbox]");
    return list ? [...list.querySelectorAll(OPTION)].filter((el) => !el.closest("[hidden]")) : [];
  };

  /** Identity in the rows: the server sends one mark per kind in `template[data-marks]`, and each
   * row only names its own (`data-level`, `data-p`, the colour in `--c`), so the markup stays small
   * with many calendars. The kind of the row comes from its group (`data-kind`). Rows rebuilt by a
   * merge lose this and get it again here. */
  const decorate = (dlg) => {
    const marks = $("template[data-marks]", dlg)?.content;
    for (const el of dlg.querySelectorAll(`.pg:not([data-recent]) ${OPTION}`)) {
      if (el.querySelector(".po-id, .po-kind")) continue;
      const pick = (sel) => marks?.querySelector(sel)?.cloneNode(true);
      const parts = [];
      if (el.style.getPropertyValue("--c")) parts.push(pick(".cal-swatch"));
      if (el.dataset.level)
        parts.push(pick(`.lmark[data-level="${CSS.escape(el.dataset.level)}"]`));
      if (el.dataset.p) parts.push(pick(`[data-p="${CSS.escape(el.dataset.p)}"] .pglyph`));
      const found = parts.filter(Boolean);
      if (found.length) {
        const box = d.createElement("span");
        box.className = "po-id";
        box.setAttribute("aria-hidden", "true");
        for (const mark of found) {
          // The colour comes from the row: drop the sample colour of the template.
          mark.style.removeProperty("--c");
          box.append(mark);
        }
        el.prepend(box);
      }
      const kind = el.closest(".pg")?.dataset.kind;
      if (kind) {
        const tag = d.createElement("span");
        tag.className = "po-kind";
        tag.setAttribute("aria-hidden", "true");
        tag.textContent = kind;
        el.append(tag);
      }
    }
    // The current theme: a check and `aria-checked` (the user menu knows the choice).
    const current = $("#user-menu [data-theme-choice][aria-pressed=true]")?.dataset.themeChoice;
    for (const el of dlg.querySelectorAll(`${OPTION}[data-action^="theme:"]`)) {
      const on = el.dataset.action === `theme:${current}`;
      el.setAttribute("aria-checked", String(on));
      let check = $(".po-check", el);
      if (!check) {
        check = marks?.querySelector(".po-check")?.cloneNode(true);
        if (check) $(".po-label", el)?.after(check);
      }
      if (check) check.hidden = !on;
    }
  };

  const open = () => {
    const dlg = dialog();
    if (!dlg || dlg.open || typeof dlg.showModal !== "function") return;
    try {
      for (const pop of d.querySelectorAll(":popover-open")) pop.hidePopover();
    } catch {} // No popover support.
    decorate(dlg);
    fillRecent(dlg);
    items = [...dlg.querySelectorAll(`.pg:not([data-recent]) ${OPTION}`)].map((el, i) => {
      el.tabIndex = -1;
      const group = el.closest(".pg");
      const words = `${el.dataset.k ?? ""} ${group.dataset.k ?? ""}`;
      return { el, i, group, e: entry($(".po-label", el)?.textContent ?? "", words) };
    });
    input().value = "";
    dlg.showModal();
    filter();
    input().focus();
  };

  const close = () => {
    const dlg = dialog();
    if (dlg?.open) dlg.close();
  };

  // The reload returns to the page on screen (the server checks `back`). Capture: before
  // `enhance.js` reads the fields.
  d.addEventListener(
    "submit",
    (event) => {
      const back = event.target.id === "palette-reload" && event.target.elements.back;
      if (back) back.value = location.pathname + location.search;
    },
    true,
  );

  // Theme and sheet run here; a link or the reload button by a click.
  const run = (el) => {
    remember(idOf(el));
    const action = el.dataset.action ?? "";
    close();
    if (action.startsWith("theme:")) {
      $(`#user-menu [data-theme-choice="${action.slice(6)}"]`)?.click();
    } else if (action === "shortcuts") {
      $("#shortcuts")?.showModal();
    } else if (action === "menu") {
      // Only opens the menu: signing out or deleting stays a choice in the menu itself.
      const menu = $("#user-menu");
      try {
        menu?.showPopover({ source: $(".user-button") });
      } catch {
        try {
          menu?.showPopover();
        } catch {} // No popover support.
      }
      $("a[href], button:not([hidden])", menu ?? d.body)?.focus();
    } else {
      passing = true;
      try {
        el.click();
      } finally {
        passing = false;
      }
    }
  };

  d.addEventListener("input", (event) => {
    if (event.target === input()) filter();
  });

  d.addEventListener(
    "close",
    (event) => {
      if (event.target !== dialog()) return;
      // Back to the server's order for the next open and for the merge.
      const box = input();
      if (box) box.value = "";
      if (items.length) filter();
      setActive(null);
    },
    true,
  );

  d.addEventListener(
    "click",
    (event) => {
      if (passing) return;
      const trigger = event.target.closest?.(".palette-trigger");
      if (trigger) {
        event.preventDefault();
        open();
        return;
      }
      const dlg = dialog();
      if (event.target === dlg) return close(); // the backdrop
      const option = event.target.closest?.(`#palette ${OPTION}`);
      if (!option || event.button || event.metaKey || event.ctrlKey || event.shiftKey) return;
      event.preventDefault();
      run(option);
    },
    true,
  );

  d.addEventListener(
    "mousemove",
    (event) => {
      const option = event.target.closest?.(`#palette ${OPTION}`);
      if (option && option !== active) setActive(option);
    },
    { passive: true },
  );

  // Keys

  const typing = (el) =>
    el?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable=false])");
  const GO = { o: "O", m: "M", c: "C", a: "A" };
  let gAt = 0;

  d.addEventListener(
    "keydown",
    (event) => {
      // The Enter that ends an input method composition: Safari sends keyCode 229 for it.
      if (event.isComposing || event.keyCode === 229) return;
      const mod = event.metaKey || event.ctrlKey;
      if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
        const dlg = dialog();
        const other = [...d.querySelectorAll("dialog[open]")].find(
          (x) => x !== dlg && x.id !== "shortcuts",
        );
        if (!dlg || other) return; // The guard asks: it stays in front.
        event.preventDefault();
        $("#shortcuts")?.close();
        if (dlg.open) close();
        else open();
        return;
      }
      if (event.target !== input() || !dialog()?.open) return;
      const all = order();
      const at = all.indexOf(active);
      const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 8, PageUp: -8 }[event.key];
      if (step && all.length) {
        event.preventDefault();
        const next =
          Math.abs(step) === 1
            ? (at + step + all.length) % all.length
            : Math.min(all.length - 1, Math.max(0, at + step));
        setActive(all[next]);
      } else if (event.key === "Enter" && active) {
        event.preventDefault();
        run(active);
      } else if (event.key === "Tab") event.preventDefault();
    },
    true,
  );

  d.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing || !singleKeys()) return;
    if (event.ctrlKey || event.metaKey || event.altKey || typing(event.target)) return;
    if (d.querySelector("dialog[open]")) return;
    const key = event.key.toLowerCase();
    if (event.key === "?") {
      event.preventDefault();
      $("#shortcuts")?.showModal();
      return;
    }
    if (event.shiftKey) return;
    if (gAt && Date.now() - gAt < 1000 && GO[key]) {
      gAt = 0;
      const link = $(`.sidebar a[aria-keyshortcuts="G ${GO[key]}"]`);
      if (link) {
        event.preventDefault();
        link.click();
      }
      return;
    }
    gAt = key === "g" ? Date.now() : 0;
  });

  // The switch in the user menu.
  d.addEventListener("change", (event) => {
    if (event.target.matches?.("[data-single-keys]")) {
      store(SINGLE, event.target.checked ? "on" : "off");
    }
  });
  const sync = () => {
    for (const box of d.querySelectorAll("[data-single-keys]")) box.checked = singleKeys();
  };
  d.addEventListener("enhance:load", sync);
  if (d.readyState === "loading") d.addEventListener("DOMContentLoaded", sync);
  else sync();

  loaded.palette = { score, entry, fold, open, singleKeys };
})();
