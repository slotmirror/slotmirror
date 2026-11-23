// Enhanced navigation for the app pages. Without it every link and form is a normal page
// load. With it, app links and forms fetch the next page and Idiomorph merges its body: scroll,
// focus and open dialogs stay. On any doubt a GET falls back to a normal load; a POST keeps the
// page and shows the server's error note, and is never sent twice. Events: "enhance:before-visit"
// (cancelable, before every leave) and "enhance:load" (after each merge, `detail.kind`, and
// `detail.saved` when this script announced a save).
// No user-facing text here: messages come from `#announcer`.
//
// Switches: the shell's `ENHANCED_NAVIGATION` ("never" drops this script; "off" renders
// `<html data-enhance-default="off">`). A browser overrides "on" and "off" with `?enhance=on|off`, which
// it keeps in localStorage. Off, the script does nothing, and every page loads as a normal page.
(() => {
  const w = window;
  const d = document;
  if (w.slotmirror) return;
  let choice = null;
  try {
    const asked = new URLSearchParams(location.search).get("enhance");
    if (asked === "on" || asked === "off") localStorage.setItem("slotmirror-enhance", asked);
    choice = localStorage.getItem("slotmirror-enhance");
  } catch {} // Blocked storage: the shell's default counts.
  if ((choice ?? d.documentElement.dataset.enhanceDefault) === "off") return;

  // Pure rules, exposed for tests ---------------------------------------------------------------

  // The app pages: the base itself (the Overview) and its list pages. The server sets the base in
  // `html[data-app-base]`; it is empty when the Overview is `/`. Keep the names in step with
  // `APP_PAGES` in `src/app-base.ts`. Assets under `/next/` are no app pages.
  const base = d.documentElement.dataset.appBase ?? "";
  const appPage = new RegExp(
    `^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/?$|/(mirroring|calendars|activity|admin|tokens)(/|$))`,
  );
  const inApp = (url, origin) =>
    url.origin === origin &&
    appPage.test(url.pathname) &&
    !/\.(css|js|mjs|json|map|woff2?|svg|png|jpe?g|webp|ico|txt)$/i.test(url.pathname);
  /** The address without `saved` and the hash; the rest of the query stays as written. */
  const stripSaved = (href) => {
    const url = new URL(href);
    url.hash = "";
    url.search = url.search
      .slice(1)
      .split("&")
      .filter((part) => part && part.split("=")[0] !== "saved")
      .join("&");
    return url.href;
  };
  const sameDoc = (a, b) => a.split("#")[0] === b.split("#")[0];
  /** The address of an answer: `fetch` drops the hash, a browser keeps the one asked for, also
   * over a redirect without a hash of its own. */
  const keepHash = (answered, asked) => {
    const url = new URL(answered);
    if (!url.hash) url.hash = new URL(asked).hash;
    return url.href;
  };

  /** "enhance": fetch and merge; "native": ask the guard, then the browser goes; "skip". */
  const linkRule = (o) => {
    if (o.button !== 0 || o.modified || o.prevented || o.download) return "skip";
    if (o.target && o.target !== "_self") return "skip";
    const to = new URL(o.href, o.base);
    if (!/^https?:$/.test(to.protocol) || to.origin !== o.origin) return "skip";
    if (sameDoc(to.href, o.base) && to.hash) return "skip";
    return o.off || o.external || o.hreflang || !inApp(to, o.origin) ? "native" : "enhance";
  };

  /** The same for forms. `back`: the hidden field of the forms that post to old endpoints. */
  const formRule = (o) => {
    if (o.prevented || o.method === "dialog" || (o.target && o.target !== "_self")) return "skip";
    const to = new URL(o.action, o.base);
    if (to.origin !== o.origin) return "skip";
    if (o.off || o.foreground || o.multipart) return "native";
    if (inApp(to, o.origin)) return "enhance";
    const back = o.method === "post" && o.back && inApp(new URL(o.back, o.base), o.origin);
    return back ? "enhance" : "native";
  };

  /** A GET form's address: the action without its query, plus the fields. */
  const getUrl = (action, entries, omitEmpty) => {
    const url = new URL(action);
    url.search = url.hash = "";
    for (const [name, value] of entries) {
      if (typeof value === "string" && !(omitEmpty && value === ""))
        url.searchParams.append(name, value);
    }
    return url.href;
  };

  /** The kind of a navigation, from both addresses and whether a panel shows before and after. */
  const navKind = (o) => {
    if (o.source === "pop") return "pop";
    const same = stripSaved(o.to) === stripSaved(o.from);
    if (o.method === "post") {
      if (o.status === 400) return "refused";
      if (o.status === 409) return "conflict";
      if (!o.redirected) return "result";
      if (same) return "save";
    }
    if (new URL(o.to).pathname !== new URL(o.from).pathname) return "page";
    if (same) return "refresh";
    if (o.source === "form" && o.method === "get") return "filter";
    if (o.oldPanel !== o.newPanel) return o.newPanel ? "panel-open" : "panel-close";
    return o.oldPanel ? "panel-switch" : "same";
  };

  /** What to do with an answer: "merge", "keep" (merge on the same entry), "load", "session",
   * "stale" (a panel save was stored, the page after it failed), "error". */
  const answerRule = (o) => {
    const post = o.method === "post";
    if (o.network) return post ? "error" : "load";
    if (!inApp(new URL(o.url), o.origin)) return post && o.panel ? "session" : "load";
    if (!o.html || !o.app) return post ? "error" : "load";
    const ok = o.status >= 200 && o.status < 300;
    if (!post) return ok && o.sameAssets ? "merge" : "load";
    if (o.status === 400 || o.status === 409 || (ok && !o.redirected)) return "keep";
    // The server redirects only after it stored the save: the page after it failed, not the save.
    if (!ok) return o.redirected && o.panel ? "stale" : "error";
    return o.sameAssets ? "merge" : "load";
  };

  // State ---------------------------------------------------------------------------------------

  const root = d.documentElement;
  const debug = {
    syncDefaults: true,
    merges: 0,
    prefetchHits: 0,
    cacheHits: 0,
    fallbacks: 0,
    last: null,
  };
  const KEEP_ACTIVE = ["save", "refused", "result", "filter", "refresh", "revalidate"];
  // A page change swaps at once: a crossfade of two lists doubles their text.
  const TYPES = { "panel-open": 1, "panel-close": 1 };
  const cache = new Map();
  const prefetches = new Map();
  let seq = 0;
  let getCtl = null;
  let busyTimer = 0;
  let slowTimer = 0;
  let pendingEl = null;
  let transition = null;
  let shownUrl = location.href;
  let headScripts = "";
  let listY = 0;
  let skipNext = false;

  const ready = () => Boolean(w.fetch && w.DOMParser && w.Idiomorph && history.pushState);
  const abs = (el, attr) => new URL(el.getAttribute(attr), location.href);
  /** The head scripts with their versions. The same list on every app page; a change is a deploy. */
  const scriptList = (doc) =>
    [...doc.head.querySelectorAll("script[src]")].map((s) => abs(s, "src").href).join(" ");
  const isApp = (doc) => doc.body?.dataset.app === "next";
  /** The same deploy: asset version, language and head scripts match this page. */
  const fits = (doc) =>
    doc.documentElement.dataset.assetV === root.dataset.assetV &&
    doc.documentElement.lang === root.lang &&
    scriptList(doc) === headScripts;
  const parse = (html) => new DOMParser().parseFromString(html, "text/html");
  const fire = (name, detail, target = d) =>
    target.dispatchEvent(new CustomEvent(name, { bubbles: true, cancelable: true, detail }));
  /** Asks the guard. False if a listener stopped the visit. */
  const beforeVisit = (detail) => fire("enhance:before-visit", detail);

  /** The fallback: a normal page load. The reason stays in sessionStorage for diagnosis. */
  const load = (url, reason) => {
    debug.fallbacks++;
    try {
      sessionStorage.setItem("enhance:fallback", JSON.stringify({ url, reason }));
    } catch {}
    // Back may restore this page from the back-forward cache: nothing of the visit may stay.
    settle();
    location.assign(url);
  };

  /** Says a text of the live region (`data-msg-*`), or `raw` text from the page. */
  const announce = (key, assertive, raw) => {
    const box = d.getElementById("announcer");
    const text = raw ?? box?.dataset[key];
    if (!text) return;
    box.setAttribute("aria-live", assertive ? "assertive" : "polite");
    box.textContent = "";
    setTimeout(() => (box.textContent = text.replace("{title}", d.title)), 50);
  };

  // Scroll and focus ----------------------------------------------------------------------------

  const pane = () => d.querySelector(".page-scroll");
  const detailBody = () => d.querySelector(".detail-body");
  /** On a phone the window scrolls, not the list (it has `overflow: visible` there). */
  const phone = () => !pane() || getComputedStyle(pane()).overflowY === "visible";
  const readScroll = () => ({
    page: pane()?.scrollTop ?? 0,
    detail: detailBody()?.scrollTop ?? 0,
    win: w.scrollY,
  });
  const writeScroll = (pos, panel = pos.detail) => {
    if (pane()) pane().scrollTop = pos.page ?? 0;
    if (detailBody()) detailBody().scrollTop = panel ?? 0;
    w.scrollTo(0, pos.win ?? 0);
  };
  const focusMark = () => {
    const el = d.activeElement;
    const href = el?.getAttribute?.("href");
    return el?.id ? { id: el.id } : href ? { href } : null;
  };
  const replaceState = (patch) => {
    try {
      history.replaceState({ ...history.state, enhance: 1, ...patch }, "", location.href);
    } catch {} // The browser refuses too many calls in a short time; the next one writes it.
  };
  const focus = (el) => {
    if (!el) return false;
    if (!el.hasAttribute("tabindex") && el.tabIndex < 0) el.setAttribute("tabindex", "-1");
    el.focus({ preventScroll: true });
    return d.activeElement === el;
  };
  const find = (s) => d.querySelector(s);
  const rowFor = (href) =>
    [...d.querySelectorAll("a.list-row, a.row-open")].find(
      (a) => stripSaved(a.href) === stripSaved(href),
    );
  const fromMark = (m) =>
    m?.id ? d.getElementById(m.id) : m?.href ? find(`a[href="${CSS.escape(m.href)}"]`) : null;
  /** The field of the open panel that the hash names ("#cal-hours-on"), if any. */
  const hashTarget = () => {
    let id = "";
    try {
      id = decodeURIComponent(location.hash.slice(1));
    } catch {} // A malformed hash names nothing.
    const el = id ? d.getElementById(id) : null;
    return el?.closest("aside.detail") && el.getClientRects().length ? el : null;
  };

  /** Scroll and focus after a merge, by kind (the table in design/system/behaviour.md). */
  const place = (k, state, before, oldUrl) => {
    const top = k === "panel-open" || k === "panel-switch";
    if (k === "pop") writeScroll(state?.scroll ?? {});
    else if (k === "page" || k === "same") writeScroll({});
    else if (k !== "revalidate") {
      const win = phone()
        ? k === "panel-open"
          ? 0
          : k === "panel-close"
            ? listY
            : before.win
        : before.win;
      writeScroll({ ...before, win }, top ? 0 : before.detail);
    }
    if (k === "revalidate" || k === "filter" || k === "result") return;
    if (k === "conflict") {
      const note = find("aside.detail [data-conflict]") ?? find("aside.detail .notice-warn");
      if (focus(note)) note.scrollIntoView({ block: "nearest" });
      else focus(find("#detail-title"));
      return;
    }
    if (k === "refused") {
      const panel = find("aside.detail") ?? d;
      const bad =
        panel.querySelector("[aria-invalid=true]") ?? panel.querySelector(".notice-danger");
      if (bad?.matches("input, select, textarea")) bad.focus();
      else if (focus(bad)) bad.scrollIntoView({ block: "nearest" });
      return;
    }
    // A save with Enter or Cmd+Enter in a field: the focus stays in that field. After a click on
    // Save the button is gone with the clean bar, and the heading takes the focus.
    const active = d.activeElement;
    if (
      k === "save" &&
      active !== d.body &&
      active?.isConnected &&
      active.getClientRects().length
    ) {
      if (!active.closest(".detail-foot")) return;
    }
    // Back and forward: the element focused before, unless it is in the sidebar or the page head.
    // A nav link there only started the visit; the heading says where the person landed.
    const mark = k === "pop" ? fromMark(state?.focus) : null;
    if (mark && !mark.closest(".sidebar, .page-head") && focus(mark)) return;
    if (k === "panel-close" && focus(rowFor(oldUrl))) return;
    // A panel that opens, also from another page (the palette, a link between panels), takes the
    // focus on its title; a hash that names one of its fields ("#cal-hours-on") takes it there.
    const target = k === "page" || k === "panel-open" || k === "panel-switch" ? hashTarget() : null;
    if (focus(target)) {
      target.scrollIntoView({ block: "center" });
      return;
    }
    if (focus(find("#detail-title, aside.detail .detail-title"))) return;
    focus(find("#page-title") ?? find("h1.page-title, main h1"));
  };

  // Merge ---------------------------------------------------------------------------------------

  /** What the server just rendered becomes the baseline for counting changes. Idiomorph leaves the
   * `value` attribute of the focused field as it was (`ignoreActiveValue`). */
  const syncDefaults = (old, fresh) => {
    if (!debug.syncDefaults || old.nodeType !== 1) return;
    const name = old.localName;
    if (name === "input" && (old.type === "checkbox" || old.type === "radio")) {
      old.defaultChecked = fresh.hasAttribute("checked");
    } else if (name === "input" && old.type !== "file") {
      old.defaultValue = fresh.getAttribute("value") ?? "";
    } else if (name === "textarea") old.defaultValue = fresh.defaultValue;
    else if (name === "option") old.defaultSelected = fresh.hasAttribute("selected");
  };

  /** Puts each choice back to what the server rendered. Idiomorph copies `checked` and `selected`
   * one element at a time, and a radio it reuses from another group unchecks its new neighbours.
   * `skip`: the focused control that Idiomorph left as it is, with its options. */
  const syncChoices = (skip) => {
    for (const el of d.body.querySelectorAll("input[type=radio], input[type=checkbox], option")) {
      if (skip?.contains(el)) continue;
      if (el.localName === "option") {
        if (el.selected !== el.defaultSelected) el.selected = el.defaultSelected;
      } else if (el.checked !== el.defaultChecked) el.checked = el.defaultChecked;
    }
  };

  /** The panel that an address shows: the path and the parameters that pick the panel. Another
   * panel takes the server's markup as it is (no morph); any other parameter (a tab, a filter)
   * keeps the panel's scroll and focus. */
  const PANEL_PARAMS = ["d", "c", "u", "k", "a", "confirm", "from"];
  const panelKey = (href) => {
    const url = new URL(href);
    return [url.pathname, ...PANEL_PARAMS.map((p) => url.searchParams.get(p) ?? "")].join("|");
  };

  const fieldState = (form) =>
    [...form.elements]
      .filter((f) => f.name && f.type !== "hidden")
      .map((f) => JSON.stringify([f.name, f.type, f.value, f.checked]));

  /** Edits made while a save was on its way count as a new change: put them back. */
  const reapply = (form, sent, now) => {
    if (!form?.isConnected || !sent || !now) return;
    for (const item of now.filter((f, i) => f !== sent[i])) {
      const [name, type, value, checked] = JSON.parse(item);
      for (const el of form.querySelectorAll(`[name="${CSS.escape(name)}"]`)) {
        if (type !== "checkbox" && type !== "radio") el.value = value;
        else if (el.value === value) el.checked = checked;
      }
    }
  };

  const sheets = (doc) =>
    [...doc.head.querySelectorAll("link[rel=stylesheet]")].map((l) => abs(l, "href").href);

  /** Inserts the missing stylesheets of the new page and waits for them, at most 1.5 s. */
  const addStyles = (doc) => {
    const have = sheets(d);
    const waits = sheets(doc)
      .filter((href) => !have.includes(href))
      .map((href) => {
        const el = d.createElement("link");
        el.rel = "stylesheet";
        el.href = href;
        d.head.append(el);
        return new Promise((done) => (el.onload = el.onerror = done));
      });
    return Promise.race([Promise.all(waits), new Promise((done) => setTimeout(done, 1500))]);
  };

  /**
   * Puts the new document in place: merge, history, scroll, focus, "enhance:load". `nav`: { kind,
   * url, history ("push" | "replace" | "none"), form, sent, state }. In a view transition if one fits.
   */
  const render = async (doc, nav, id) => {
    await addStyles(doc);
    if (id !== seq) return;
    const { kind } = nav;
    const before = readScroll();
    const oldUrl = location.href;
    const keepActive = KEEP_ACTIVE.includes(kind);
    const apply = () => {
      // A background merge never replaces input typed since the answer was asked for.
      if (id !== seq || (kind === "revalidate" && typed())) return;
      try {
        const edits =
          (kind === "save" || kind === "refused") && nav.sent ? fieldState(nav.form) : null;
        const samePanel = panelKey(oldUrl) === panelKey(nav.url);
        const panelNow = find("aside.detail form.detail-form");
        const panelEdits = nav.keepPanel && samePanel && panelNow ? fieldState(panelNow) : null;
        if (!keepActive) for (const el of d.querySelectorAll(":popover-open")) el.hidePopover();
        if (kind === "panel-open" && phone()) listY = w.scrollY;
        const started = performance.now();
        // Another panel replaces the old one: morphing one form into a form of another shape
        // reuses its inputs, and their state drifts from the server's markup. The same panel
        // (a save, a refusal, a revalidation) is merged, so that input typed meanwhile stays.
        const oldPanel = find("aside.detail");
        const newPanel = doc.querySelector("aside.detail");
        let fresh = null;
        // A conflict shows the stored values as they are: the panel is replaced, nothing typed
        // comes back.
        if (
          oldPanel &&
          newPanel &&
          (kind === "conflict" || !samePanel) &&
          !oldPanel.querySelector("dialog[open]")
        ) {
          fresh = d.importNode(newPanel, true);
          oldPanel.replaceWith(fresh);
        }
        const ignoreActiveValue = keepActive && kind !== "save" && kind !== "revalidate";
        w.Idiomorph.morph(d.body, doc.body, {
          morphStyle: "outerHTML",
          // After a save or in the background the focused field shows the server's value too:
          // edits typed while the save was on its way come back through `reapply()`.
          ignoreActiveValue,
          restoreFocus: true,
          callbacks: {
            beforeNodeMorphed: (old) =>
              !(
                old === fresh ||
                (old.nodeType === 1 &&
                  (old.hasAttribute("data-morph-keep") || (old.localName === "dialog" && old.open)))
              ),
            beforeAttributeUpdated: (attr, el) =>
              !(attr === "open" && (el.localName === "details" || el.localName === "dialog")),
            afterNodeMorphed: syncDefaults,
          },
        });
        debug.last = { kind, morphMs: Math.round(performance.now() - started) };
        debug.merges++;
        if (doc.title) d.title = doc.title;
        const want = sheets(doc);
        for (const l of d.head.querySelectorAll("link[rel=stylesheet]"))
          if (!want.includes(l.href)) l.remove();
        // Scripts in a merged body would not run. All of them sit in the head of every app page
        // (a server test keeps it so), and they resync on "enhance:load".
        if (debug.syncDefaults) syncChoices(ignoreActiveValue ? d.activeElement : null);
        reapply(nav.form, nav.sent, edits);
        if (panelEdits) reapply(find("aside.detail form.detail-form"), nav.keepPanel, panelEdits);
        const url = stripSaved(nav.url) + new URL(nav.url).hash;
        if (nav.history === "push") history.pushState({ enhance: 1 }, "", url);
        if (nav.history === "replace")
          history.replaceState({ ...history.state, enhance: 1 }, "", url);
        shownUrl = location.href;
        place(kind, nav.state, before, oldUrl);
        // The new entry knows its place at once: a quick back and forward finds it there.
        replaceState({ scroll: readScroll() });
        // `saved`: this script announces the save, so `panel.js` does not say it again.
        fire("enhance:load", { kind, saved: nav.saved });
        // A panel form redirects only after its save went through (a refusal answers 400).
        if (nav.saved) announce("msgSaved");
        if (kind === "filter" || kind === "pop") announce("msgUpdated");
        if (kind === "conflict") {
          const note = find("aside.detail [data-conflict]") ?? find("aside.detail .notice-warn");
          announce("", true, note?.textContent.trim());
        }
      } catch (error) {
        console.error(error);
        load(kind === "refused" || kind === "result" ? location.href : nav.url, "exception");
      }
    };
    const type = TYPES[kind] === 1 ? kind : TYPES[kind];
    const reduced = w.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!type || !d.startViewTransition || root.dataset.vt === "off" || reduced) return apply();
    transition?.skipTransition();
    try {
      transition = d.startViewTransition({ update: apply, types: [type] });
    } catch {
      transition = d.startViewTransition(apply); // No transition types (Safari 18.0, 18.1).
    }
    // A skipped or hidden-page transition rejects these; the update still runs.
    const running = transition;
    transition.ready.catch(() => {});
    transition.finished
      .catch(() => {})
      .finally(() => {
        if (transition === running) transition = null;
      });
    return transition.updateCallbackDone.catch(() => {});
  };

  // Navigation ----------------------------------------------------------------------------------

  /** Loading cue after 150 ms: `html[aria-busy]` and `.is-pending` on the clicked link or button. */
  /** After 1 s also say "Loading", so that a screen reader knows the click did something. */
  const cue = (el, id) => {
    clearTimeout(busyTimer);
    clearTimeout(slowTimer);
    pendingEl?.classList.remove("is-pending");
    pendingEl = null;
    root.removeAttribute("aria-busy");
    if (id === undefined) return;
    busyTimer = setTimeout(() => {
      if (id !== seq) return;
      root.setAttribute("aria-busy", "true");
      pendingEl = el?.closest?.("a, button") ?? null;
      pendingEl?.classList.add("is-pending");
    }, 150);
    slowTimer = setTimeout(() => id === seq && announce("msgLoading"), 1000);
  };

  /** Ends the cue of a visit and frees the panel that the visit made inert. */
  const settle = () => {
    cue();
    find("aside.detail")?.removeAttribute("inert");
  };

  const request = (url, method = "GET", body, signal) =>
    fetch(url, {
      method,
      ...(body ? { body } : {}),
      signal,
      credentials: "same-origin",
      headers: { "X-Enhance": "1", Accept: "text/html" },
    }).then(async (res) => ({ res, html: await res.text() }));

  /** Last GET pages for back and forward: 10 entries, 60 s. */
  const cacheKey = (href) => {
    const url = new URL(stripSaved(href));
    return url.pathname + url.search;
  };
  const remember = (href, html) => {
    cache.delete(cacheKey(href));
    cache.set(cacheKey(href), { html, at: Date.now() });
    if (cache.size > 10) cache.delete(cache.keys().next().value);
  };
  /** After a POST no page read before it may show: drop the history pages and the prefetches. */
  const forget = () => {
    cache.clear();
    prefetches.clear();
  };

  const saveError = (form, kind, key = "msgErrorServer") => {
    if (key || kind === "session") announce(kind === "session" ? "msgSessionEnded" : key, true);
    if (form?.isConnected && fire("enhance:save-error", { kind }, form)) {
      // No panel script took it: show the note that the server rendered.
      for (const n of form.querySelectorAll("[data-save-error]"))
        n.hidden = n.dataset.saveError !== kind;
    }
  };

  /** One navigation. `o`: { url, method, body, form, sent, el, source, history, state, t0 }. */
  const go = async (o) => {
    const id = ++seq;
    const post = o.method === "post";
    transition?.skipTransition();
    getCtl?.abort();
    getCtl = null;
    if (o.source !== "pop") replaceState({ scroll: readScroll(), focus: focusMark() });
    const t0 = o.t0 ?? performance.now();
    cue(o.el, id);
    // The panel being left takes no input until the next page is in place (the merge drops the
    // attribute): typing there now would be lost. A POST frees it again.
    const leaving = find("aside.detail");
    leaving?.toggleAttribute("inert", !post);
    // The browser takes the focus out of an inert panel only at its next rendering step. An answer
    // merged before it would find a panel field still focused, and the merge would keep that
    // field's value (`ignoreActiveValue`): Discard after a refusal kept the refused name.
    if (!post && leaving?.contains(d.activeElement)) d.activeElement.blur();
    const form = post ? o.form : null;
    const panelForm = form?.querySelector("[data-savebar]") ? form : null;
    // Another form posts (the palette's reload) while a panel is open: what is typed into the
    // panel from now on must survive the merge of the answer.
    const openPanel = post && !panelForm ? find("aside.detail form.detail-form") : null;
    const keepPanel = openPanel ? fieldState(openPanel) : null;
    // A form with a POST on its way takes no second submit. `aria-disabled` keeps the focus.
    const marked = form ? [...form.querySelectorAll("button:not([aria-disabled])")] : [];
    form?.setAttribute("data-pending", "");
    for (const b of marked) if (b.type === "submit") b.setAttribute("aria-disabled", "true");
    const release = () => {
      form?.removeAttribute("data-pending");
      for (const b of marked) b.removeAttribute("aria-disabled");
    };
    let got;
    let timer;
    try {
      const early = !post && prefetches.get(cacheKey(o.url));
      prefetches.delete(cacheKey(o.url));
      if (early && Date.now() - early.at < 5000) {
        debug.prefetchHits++;
        got = await early.promise;
      } else {
        // A GET is aborted by the next visit or after 8 s. A POST never: the server may have written.
        const ctl = new AbortController();
        if (!post) getCtl = ctl;
        const sent = request(o.url, post ? "POST" : "GET", o.body, post ? undefined : ctl.signal);
        sent.catch(() => {});
        const late = new Promise((_, fail) => {
          timer = setTimeout(
            () => {
              if (!post) ctl.abort();
              fail(new Error("timeout"));
            },
            post ? 15000 : 8000,
          );
        });
        got = await Promise.race([sent, late]);
      }
    } catch (error) {
      if (post) {
        forget();
        release();
        if (id === seq) cue();
        return saveError(panelForm ?? form, "failed", "msgErrorNetwork");
      }
      if (id === seq) load(o.url, error?.name === "AbortError" ? "abort" : "network");
      return;
    } finally {
      clearTimeout(timer);
    }
    if (post) forget();
    if (id !== seq) return release();
    cue();
    const { res, html } = got;
    const finalUrl = post ? res.url || o.url : keepHash(res.url || o.url, o.url);
    const isHtml = (res.headers.get("content-type") ?? "").includes("text/html");
    const doc = isHtml ? parse(html) : null;
    const app = Boolean(doc && isApp(doc));
    const verdict = answerRule({
      method: post ? "post" : "get",
      url: finalUrl,
      origin: location.origin,
      html: isHtml,
      app,
      status: res.status,
      redirected: res.redirected,
      panel: Boolean(panelForm),
      sameAssets: app && fits(doc),
    });
    if (verdict !== "merge" && verdict !== "keep") release();
    if (verdict === "load") {
      // A POST that ends in a normal load is done (the save went through before a new deploy):
      // the panel must not ask "leave the page?" about input that the server has.
      if (post) fire("enhance:leave", { url: finalUrl });
      return load(finalUrl, "answer");
    }
    if (verdict === "session") return saveError(panelForm, "session");
    // The bar's own note (a live region) says it; the announcer would only repeat it.
    if (verdict === "stale") return saveError(panelForm, "stale", null);
    if (verdict === "error") return saveError(panelForm ?? form, "failed");
    const kind = navKind({
      from: location.href,
      to: finalUrl,
      method: post ? "post" : "get",
      source: o.source,
      status: res.status,
      redirected: res.redirected,
      oldPanel: Boolean(find("aside.detail")),
      newPanel: Boolean(doc.querySelector("aside.detail")),
    });
    if (!post && !new URL(finalUrl).searchParams.has("saved")) remember(finalUrl, html);
    const keep = verdict === "keep";
    const replace = ["refresh", "filter", "save"].includes(kind);
    const hist = o.history ?? (keep ? "none" : replace ? "replace" : "push");
    const url = keep ? location.href : finalUrl;
    const saved = Boolean(panelForm) && res.redirected && res.ok;
    const nav = { kind, url, history: hist, form: o.form, sent: o.sent, state: o.state, saved };
    nav.keepPanel = keepPanel;
    await render(doc, nav, id);
    release();
    if (debug.last) debug.last.ms = Math.round(performance.now() - t0);
  };

  /** Public: goes to `url` (GET) through the guard. Returns a promise, never undefined. */
  const visit = (url, opts = {}) => {
    const to = new URL(url, location.href);
    const perform = () =>
      ready() && inApp(to, location.origin)
        ? go({ url: to.href, source: "api", ...opts })
        : Promise.resolve(location.assign(to.href));
    return beforeVisit({ url: to.href, method: "get", kind: "api", form: null, resume: perform })
      ? perform()
      : Promise.resolve();
  };

  // Listeners, registered once ------------------------------------------------------------------

  const linkInfo = (event, a) => ({
    href: a.getAttribute("href"),
    base: location.href,
    origin: location.origin,
    button: event.button ?? 0,
    modified: event.metaKey || event.ctrlKey || event.shiftKey || event.altKey,
    prevented: event.defaultPrevented,
    target: a.target,
    download: a.hasAttribute("download"),
    external: (a.getAttribute("rel") ?? "").split(/\s+/).includes("external"),
    hreflang: a.hasAttribute("hreflang"),
    off: Boolean(a.closest("[data-enhance=off]")),
  });

  // While a view transition runs, Chrome sends every click to <html> (also with `pointer-events:
  // none` on `::view-transition`), so a quick second click would be lost. End the transition and
  // pass the click on to what is under the pointer.
  d.addEventListener(
    "click",
    (event) => {
      const running = transition;
      if (!running || event.target !== root || !event.isTrusted) return;
      event.stopPropagation();
      const { clientX: x, clientY: y } = event;
      running.skipTransition();
      running.finished.catch(() => {}).finally(() => d.elementFromPoint(x, y)?.click());
    },
    true,
  );

  d.addEventListener("click", (event) => {
    const a = ready() && event.target.closest?.("a[href]");
    const rule = a ? linkRule(linkInfo(event, a)) : "skip";
    if (rule === "skip") return;
    const url = a.href;
    const t0 = performance.now();
    const perform =
      rule === "enhance"
        ? () => go({ url, el: a, source: "link", t0 })
        : () => location.assign(url);
    if (!beforeVisit({ url, method: "get", kind: "link", form: null, resume: perform })) {
      event.preventDefault();
    } else if (rule === "enhance") {
      event.preventDefault();
      perform();
    }
  });

  d.addEventListener("submit", (event) => {
    if (!ready()) return;
    const form = event.target;
    const by = event.submitter;
    const attr = (name) => by?.getAttribute(`form${name}`) || form.getAttribute(name);
    const method = (attr("method") || "get").toLowerCase();
    const action = by?.hasAttribute("formaction") ? by.formAction : form.action;
    const rule = formRule({
      action,
      method,
      base: location.href,
      origin: location.origin,
      prevented: event.defaultPrevented,
      target: attr("target"),
      off: Boolean(form.closest("[data-enhance=off]") || by?.closest("[data-enhance=off]")),
      foreground: form.dataset.saveMode === "foreground",
      multipart: (attr("enctype") || form.enctype) === "multipart/form-data",
      back: form.elements.back?.value,
    });
    if (rule === "skip") return;
    // A native submit that the guard let through: the repeated submit event passes once.
    if (skipNext) {
      skipNext = false;
      return;
    }
    if (form.hasAttribute("data-pending")) return event.preventDefault();
    let data;
    try {
      data = new FormData(form, by);
    } catch {
      data = new FormData(form);
      if (by?.name) data.append(by.name, by.value);
    }
    const get = method !== "post";
    const url = get ? getUrl(action, data, form.hasAttribute("data-omit-empty")) : action;
    const body = get ? undefined : new URLSearchParams(data);
    const nav = { url, method: get ? "get" : "post", body, form, el: by ?? form, source: "form" };
    nav.sent = get ? null : fieldState(form);
    nav.t0 = performance.now();
    const enhance = rule === "enhance";
    const resume = () => {
      if (enhance) return go(nav);
      skipNext = true;
      return by ? form.requestSubmit(by) : form.requestSubmit();
    };
    if (!beforeVisit({ url, method: nav.method, kind: "form", form, resume })) {
      event.preventDefault();
    } else if (enhance) {
      event.preventDefault();
      go(nav);
    }
  });

  w.addEventListener("popstate", (event) => {
    const url = location.href;
    if (!ready() || sameDoc(url, shownUrl)) {
      shownUrl = url;
      return;
    }
    const state = event.state;
    if (!state?.enhance) return location.reload();
    const before = shownUrl;
    const resume = () => go({ url, source: "pop", history: "push", state });
    if (!beforeVisit({ url, method: "get", kind: "pop", form: null, resume })) {
      // The guard asks first: the address bar shows the page that is still on screen.
      history.pushState({ enhance: 1 }, "", before);
      shownUrl = before;
      return;
    }
    const hit = cache.get(cacheKey(url));
    if (!hit || Date.now() - hit.at > 60000)
      return go({ url, source: "pop", history: "none", state });
    // From the cache at once, then fetched again in the background.
    debug.cacheHits++;
    const id = ++seq;
    getCtl?.abort();
    const doc = parse(hit.html);
    if (!isApp(doc) || !fits(doc)) return load(url, "cache");
    render(doc, { kind: "pop", url, history: "none", state }, id).then(() =>
      revalidate(url, hit.html, id),
    );
  });

  /** A field that differs from what the server rendered (the rule lives in `panel.js`; without
   * it every field counts as changed). */
  const changed = (e) =>
    e.name && e.type !== "hidden" && !(w.slotmirrorScripts?.panel?.isDefault?.(e) ?? false);
  const typed = () => [...d.forms].some((f) => [...f.elements].some(changed));

  /** Merges the fresh page only if it changed and nothing is typed on the page. It never navigates:
   * a bad answer, an ended session or a new deploy is dropped, and the next click handles it. */
  const revalidate = async (url, html, id) => {
    const got = await request(url).catch(() => null);
    if (!got || id !== seq || got.html === html) return;
    if (!got.res.ok || !inApp(new URL(got.res.url || url), location.origin)) return;
    const doc = parse(got.html);
    if (!isApp(doc) || !fits(doc) || typed()) return;
    remember(url, got.html);
    await render(doc, { kind: "revalidate", url: location.href, history: "none" }, id);
  };

  // Prefetch on press, never on hover: a GET of an app page only reads.
  const prefetch = (event) => {
    const a = ready() && event.target.closest?.("a[href]");
    if (!a || (event.type === "pointerdown" && event.pointerType === "touch")) return;
    if (linkRule(linkInfo(event, a)) !== "enhance" || sameDoc(a.href, location.href)) return;
    const key = cacheKey(a.href);
    for (const [k, v] of prefetches) if (Date.now() - v.at > 5000) prefetches.delete(k);
    if (prefetches.has(key)) return;
    const promise = request(a.href);
    promise.catch(() => prefetches.delete(key));
    prefetches.set(key, { at: Date.now(), promise });
  };
  d.addEventListener("pointerdown", prefetch, { passive: true });
  d.addEventListener("touchstart", prefetch, { passive: true });

  // The scroll position lives in the history entry, for back and forward.
  let scrollTimer = 0;
  const keepScroll = () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => replaceState({ scroll: readScroll() }), 200);
  };
  d.addEventListener("scroll", keepScroll, { capture: true, passive: true });
  w.addEventListener("pagehide", () => replaceState({ scroll: readScroll(), focus: focusMark() }));
  // A page from the back-forward cache: a visit that left it may have been cut off mid-way.
  w.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    seq++; // An answer that comes in now belongs to the visit that left.
    settle();
  });

  const init = () => {
    headScripts = scriptList(d);
    shownUrl = location.href;
    const nav = performance.getEntriesByType?.("navigation")[0];
    const restore = nav?.type === "back_forward" && history.state?.scroll;
    replaceState({});
    history.scrollRestoration = "manual";
    if (restore) writeScroll(restore);
  };
  if (d.readyState === "loading") d.addEventListener("DOMContentLoaded", init);
  else init();

  w.slotmirror = {
    visit,
    get enhanced() {
      return ready();
    },
    _debug: debug,
    _test: { linkRule, formRule, getUrl, navKind, answerRule, stripSaved, panelKey, keepHash },
  };
})();
