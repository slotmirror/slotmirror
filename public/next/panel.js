// Detail panel of the redesign, shared by the Mirroring and Calendars pages. The panel works
// without this script: it is one form with a Save button. The script adds:
//   - the save bar: it shows while the form differs from what the server rendered, counts the
//     changes and shows the notes that the server rendered for it;
//   - a guard: a leave with unsaved changes (link, other form, Escape, history, tab close) asks
//     first;
//   - focus and keys: the panel heading takes the focus when the page opens, Escape closes the
//     panel, Cmd/Ctrl+Enter saves, Arrow Up/Down move between list rows, a group of checkbox
//     colours is one tab stop.
// All user-facing text comes from the page (data- attributes and hidden elements), none from here.
// Page scripts listen for the "panel:update" event on the form after each change.
//
// The script registers its listeners once and finds the panel when an event comes, because
// `enhance.js` replaces the page content without a reload. `sync()` runs on DOMContentLoaded and
// after each such change ("enhance:load"). The shell loads it in the head of every app page with
// `defer`; `theme.js` sets the `js` class before the first paint.
(() => {
  const loaded = (window.slotmirrorScripts ??= {});
  if (loaded.panel) return;
  loaded.panel = {};
  document.documentElement.classList.add("js");

  /** True while the script submits the panel or leaves the page on purpose, so no guard fires. */
  let leaving = false;
  /** A normal submit is on its way. A second one would send the form twice. */
  let submitting = false;
  /** A save in the background is on its way. */
  let busy = false;
  /** What happens after a save or a discard in the guard: a function that takes the person on. */
  let pending = null;
  /** The address of a link target on an app page: the server can return there after the save. */
  let pendingUrl = null;
  /** The `back` value that the server rendered, per form. A guard save changes the field. */
  const backDefaults = new WeakMap();
  /** The field that got the last input in the panel: "Keep editing" returns there. */
  let lastField = null;
  /** The guard closed with "Keep editing" (the button or Escape). */
  let kept = false;

  const enhanced = () => Boolean(window.slotmirror?.enhanced);
  /** Goes to an address: through `enhance.js` if it runs, else as a normal navigation. */
  const go = (url) => window.slotmirror?.visit(url) ?? location.assign(url);
  // An app page is the base (the Overview) or one of its list pages, as in `enhance.js`.
  const base = document.documentElement.dataset.appBase ?? "";
  const appPage = new RegExp(
    `^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/?$|/(mirroring|calendars|activity|admin|tokens)(/|$))`,
  );
  const inApp = (url) => url.origin === location.origin && appPage.test(url.pathname);

  /** The parts of the open panel, looked up now: the page may have changed since the last event. */
  const parts = () => {
    const aside = document.querySelector("aside.detail");
    const form = aside?.querySelector("form.detail-form") ?? null;
    const bar = form?.querySelector("[data-savebar]") ?? null;
    const foot = bar?.closest(".detail-foot") ?? null;
    return {
      aside,
      form: bar && foot ? form : null,
      bar,
      foot,
      dialog: aside?.querySelector("dialog[data-guard]") ?? null,
      closeLink: aside?.querySelector("a.detail-close") ?? null,
    };
  };

  /** A save of the panel form is on its way: our own, or one that `enhance.js` sends. */
  const saving = (form) => submitting || busy || Boolean(form?.hasAttribute("data-pending"));

  /** True while a field shows what the server rendered. Also used by `enhance.js`. */
  const isDefault = (field) => {
    if (field.type === "radio" || field.type === "checkbox") {
      return field.checked === field.defaultChecked;
    }
    if (field.localName === "select") {
      const options = [...field.options];
      if (field.multiple) return options.every((o) => o.selected === o.defaultSelected);
      // Without a `selected` option the first one shows; with several, the last one counts.
      return field.selectedIndex === (options.findLast((o) => o.defaultSelected)?.index ?? 0);
    }
    // A button or a fieldset has no value of its own to change.
    return !("defaultValue" in field) || field.value === field.defaultValue;
  };
  loaded.panel.isDefault = isDefault;

  /** The fields that a person can change: named, not hidden, not a button. */
  const fields = (form) =>
    [...form.elements].filter(
      (field) => field.name && !["hidden", "submit", "button", "reset"].includes(field.type),
    );

  /** One change per field: per name, and per checkbox value. Checkboxes of one name in a
   * `data-change-group` (the days, a colour filter) count as one change; a group never joins
   * fields of different names, so two changed questions read "2 changes". */
  const countChanges = (form, also = new Set()) => {
    if (!form) return 0;
    const units = new Map();
    for (const field of fields(form)) {
      const toggle = field.type === "checkbox";
      const group = field.closest("[data-change-group]")?.dataset.changeGroup;
      const key = group
        ? `${group}:${field.name}`
        : toggle
          ? `${field.name}:${field.value}`
          : field.name;
      units.set(
        key,
        units.get(key) ||
          also.has(field.name) ||
          also.has(`${field.name}:${field.value}`) ||
          !isDefault(field),
      );
    }
    return [...units.values()].filter(Boolean).length;
  };

  /** The server refused the last save and rendered its input as the defaults (`data-refused`):
   * the fields hold what the server does not store, so the panel counts as unsaved. */
  const refused = (form) => Boolean(form?.querySelector("[data-savebar][data-refused]"));

  /**
   * The changes against what is stored, as the bar and the leave dialog say them. After a refusal
   * the refused input is the default: the server names the fields that differ from what is stored
   * (`data-refused-fields`) or at least counts them (`data-refused-count`).
   */
  const changeCount = (form) => {
    const number = countChanges(form);
    const bar = form?.querySelector("[data-savebar]");
    if (!bar || !refused(form)) return number;
    const names = bar.dataset.refusedFields;
    if (names !== undefined) return countChanges(form, new Set(names.split(" ").filter(Boolean)));
    // Only a count: one more edit adds to it. A field changed twice may count twice.
    return (Number(bar.dataset.refusedCount) || 0) + number;
  };
  const isDirty = () => {
    const { form } = parts();
    return countChanges(form) > 0 || refused(form);
  };

  const changedNames = (form) =>
    new Set(
      fields(form)
        .filter((field) => !isDefault(field))
        .map((f) => f.name),
    );

  const hideErrors = (bar) => {
    for (const note of bar.querySelectorAll("[data-save-error]")) note.hidden = true;
  };

  /** The field of the panel that the address's hash names, if it is shown. */
  const hashField = () => {
    let id = "";
    try {
      id = decodeURIComponent(location.hash.slice(1));
    } catch {} // A malformed hash names nothing.
    const el = id ? document.getElementById(id) : null;
    return el?.closest("aside.detail") && el.getClientRects().length ? el : null;
  };

  /** The tone and the button label follow the notes that show. The label comes from the shown
   * warning note, else from the first shown note that names one ("Turn off"). */
  const refreshBar = (bar) => {
    const save = bar.querySelector("[data-save]");
    const shown = [...bar.querySelectorAll("[data-note]")].filter((note) => !note.hidden);
    const warn = shown.find((note) => "warn" in note.dataset);
    const labelled = warn?.dataset.button ? warn : shown.find((note) => note.dataset.button);
    bar.querySelector(".savebar-notes")?.classList.toggle("is-warn", Boolean(warn));
    // The label replaces the no-script spans of the button (`data-label-for`) the first time.
    const label = labelled?.dataset.button || save?.dataset.label;
    if (save && label && save.textContent !== label) save.textContent = label;
    // A destructive label ("Turn off") brings its tone: the note that names it says so.
    const tone = labelled?.dataset.button ? labelled.dataset.tone : undefined;
    if (save && tone) save.dataset.tone = tone;
    else if (save) delete save.dataset.tone;
    fit(bar);
  };

  /**
   * One row where it fits. If the row wraps only because of the keyboard hint after the Save label,
   * the bar drops the hint (`data-tight`). A label too long for one row wraps anyway and keeps the
   * hint. It reads the layout once per change of the bar and on resize, never on scroll.
   */
  const fit = (bar) => {
    const row = bar.querySelector(".savebar-row");
    const save = bar.querySelector("[data-save]");
    if (!row || !save?.getClientRects().length) return;
    const wraps = () =>
      row.getBoundingClientRect().height > save.getBoundingClientRect().height + 1;
    bar.removeAttribute("data-tight");
    if (!wraps()) return;
    bar.setAttribute("data-tight", "");
    if (wraps()) bar.removeAttribute("data-tight");
  };
  let fitFrame = 0;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(fitFrame);
    fitFrame = requestAnimationFrame(() => {
      const bar = document.querySelector("aside.detail [data-savebar]");
      if (bar) fit(bar);
    });
  });

  const update = () => {
    const { aside, form, bar, foot } = parts();
    if (!form) return;
    const number = countChanges(form);
    const count = bar.querySelector("[data-count]");
    foot.classList.toggle("is-dirty", number > 0 || bar.hasAttribute("data-forced"));
    const shown = changeCount(form);
    if (count) {
      count.textContent =
        shown === 0
          ? ""
          : (shown === 1 ? bar.dataset.one : bar.dataset.many).replace("{n}", String(shown));
    }

    // Notes that the server wrote for fields: "changed" names fields, "off" names a switch.
    const names = changedNames(form);
    for (const note of bar.querySelectorAll("[data-note]")) {
      if (note.dataset.changed) {
        note.hidden = !note.dataset.changed.split(" ").some((name) => names.has(name));
      } else if (note.dataset.off) {
        const toggle = document.getElementById(note.dataset.off);
        note.hidden = !(toggle && toggle.defaultChecked && !toggle.checked);
      }
    }
    // A property row with a changed field gets `data-changed` (CSS draws a dot at its label).
    const rows = new Map();
    for (const field of fields(form)) {
      const row = field.closest(".prop[data-fields]");
      if (row) rows.set(row, rows.get(row) || !isDefault(field));
    }
    for (const [row, changed] of rows) row.toggleAttribute("data-changed", changed);
    if (number > 0) aside.querySelector("[data-saved]")?.remove();
    if (!busy) hideErrors(bar);
    // The page scripts set the notes of their own (`data-note` without a rule) and call back.
    form.dispatchEvent(
      new CustomEvent("panel:update", { bubbles: true, detail: { count: number } }),
    );
    refreshBar(bar);
  };
  loaded.panel.update = update;

  /** The panel stays as it is and the save bar says why. `text` is the server's reason, if any. */
  const fail = (kind, text) => {
    busy = false;
    const { bar } = parts();
    if (!bar) return;
    const save = bar.querySelector("[data-save]");
    if (save) save.disabled = false;
    for (const note of bar.querySelectorAll("[data-save-error]")) {
      const shown = note.dataset.saveError === kind;
      note.hidden = !shown;
      if (shown && kind === "failed") note.textContent = text || note.dataset.default || "";
    }
    refreshBar(bar);
  };

  const restoreBack = (form) => {
    const backField = form.elements.back;
    if (backField && backDefaults.has(form)) backField.value = backDefaults.get(form);
  };

  /**
   * Submits the form as a normal form (or through `enhance.js`, which takes the submit event).
   * `target` replaces the `back` field for this submit. A field that the browser refuses to submit
   * puts the old value back and shows the browser's hint.
   */
  const submitForm = (form, target) => {
    if (saving(form)) return false;
    const backField = form.elements.back;
    if (target && backField) backField.value = target;
    if (!form.checkValidity()) {
      restoreBack(form);
      form.reportValidity();
      return false;
    }
    form.requestSubmit();
    return true;
  };

  /** The panel that the server rendered again for a refusal (400) or a conflict (409), or null. */
  const answerOf = async (response) => {
    try {
      if (response.redirected || !(response.headers.get("content-type") ?? "").includes("html")) {
        return null;
      }
      const doc = new DOMParser().parseFromString(await response.text(), "text/html");
      return doc.querySelector("aside.detail");
    } catch {
      return null;
    }
  };

  /** The reason in a panel the server rendered: the conflict first, as `enhance.js` does. */
  const reasonIn = (aside) =>
    (
      aside?.querySelector("[data-conflict]") ??
      aside?.querySelector(".notice-danger") ??
      aside?.querySelector(".notice-warn")
    )?.textContent?.trim() ?? "";

  /**
   * After a conflict or a refusal the focus goes to what the person must read: the conflict
   * notice (said aloud too), else the first field the server marked, else the danger notice.
   * Returns false if there is none.
   */
  const focusAnswer = () => {
    const { aside } = parts();
    const conflict = aside?.querySelector("[data-conflict]");
    const target =
      conflict ??
      aside?.querySelector("[aria-invalid=true]") ??
      aside?.querySelector(".notice-danger");
    if (!target) return false;
    if (!target.matches("input, select, textarea, button, [tabindex]")) target.tabIndex = -1;
    target.focus();
    const box = document.getElementById("announcer");
    if (conflict && box) {
      box.setAttribute("aria-live", "assertive");
      box.textContent = "";
      setTimeout(() => (box.textContent = reasonIn(aside)), 50);
    }
    return true;
  };

  /**
   * Shows the panel of a refusal or a conflict in place of the open one, as a normal submit
   * would: the server's reason at its field, its count, and after a conflict the stored values
   * with a new version. The page scripts sync as after a merge.
   */
  const showAnswer = (fresh, kind) => {
    const { aside } = parts();
    if (!aside || !fresh?.querySelector("form.detail-form")) return false;
    aside.replaceWith(document.importNode(fresh, true));
    document.dispatchEvent(new CustomEvent("enhance:load", { detail: { kind } }));
    focusAnswer();
    return true;
  };

  /**
   * Saves without leaving the page, then runs `then`. It counts as saved only if the server sent
   * the person back to a page of the app with the saved mark: any other answer (the sign-in
   * page after a session ended, a refusal, an error) leaves the panel and its input alone. It
   * never submits the form again: the request may have reached the server.
   */
  const saveInBackground = async (form, then) => {
    busy = true;
    const save = form.querySelector("[data-save]");
    if (save) save.disabled = true;
    hideErrors(form.querySelector("[data-savebar]"));
    let response;
    try {
      response = await fetch(form.action, {
        method: "POST",
        body: new FormData(form),
        credentials: "same-origin",
      });
    } catch {
      fail("failed");
      return;
    }
    const landed = new URL(response.url, location.href);
    if (
      response.redirected &&
      response.ok &&
      inApp(landed) &&
      landed.searchParams.get("saved") === "1"
    ) {
      busy = false;
      leaving = true;
      then();
      return;
    }
    if (response.redirected && !inApp(landed)) {
      fail("session");
      return;
    }
    const answer =
      response.status === 400 || response.status === 409 ? await answerOf(response) : null;
    busy = false;
    if (answer && showAnswer(answer, response.status === 409 ? "conflict" : "refused")) return;
    fail("failed", reasonIn(answer));
  };

  // The guard dialog -----------------------------------------------------------------------------

  const openGuard = (then, target) => {
    const { form, dialog } = parts();
    if (!dialog || typeof dialog.showModal !== "function") {
      // No dialog support: the browser's own question (beforeunload) stands in.
      then();
      return;
    }
    pending = then;
    pendingUrl = target ?? null;
    const number = changeCount(form) || 1;
    dialog.querySelector("[data-guard-title]").textContent = (
      number === 1 ? dialog.dataset.one : dialog.dataset.many
    ).replace("{n}", String(number));
    const guardText = dialog.querySelector("[data-guard-text]");
    if (guardText) {
      guardText.textContent = number === 1 ? dialog.dataset.textOne : dialog.dataset.textMany;
    }
    dialog.showModal();
  };

  const leave = (then) => {
    leaving = true;
    then();
  };

  const guardKeep = (dialog) => {
    pending = null;
    kept = true;
    dialog.close();
  };

  const guardDiscard = (dialog) => {
    const then = pending;
    dialog.close();
    pending = null;
    if (then) leave(then);
  };

  const guardSave = (dialog) => {
    const then = pending;
    const target = pendingUrl;
    dialog.close();
    pending = null;
    const { form, bar } = parts();
    if (!then || !form || saving(form)) return;
    hideErrors(bar);
    // A form whose answer is the page itself (a one-time secret) is submitted as it is. The
    // answer replaces this page, and the target is dropped: a second request would repeat it.
    if (form.dataset.saveMode === "foreground") {
      submitForm(form, null);
      return;
    }
    // A target on an app page goes through the form's own `back` field, which the server checks.
    // This is a normal submit (or the enhanced one), so a refusal shows the page with its reason.
    if (target && form.elements.back && appPage.test(target.split(/[?#]/)[0])) {
      submitForm(form, target);
      return;
    }
    // Any other target: save in the background, then go. A field the browser refuses (a required
    // answer left open) stops it before anything is sent: the person keeps editing at that field.
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    void saveInBackground(form, then);
  };

  /**
   * A leave is about to happen: `then` performs it, `target` is its address or null. Returns true
   * if the guard stopped it (the dialog asks, or a save is on its way).
   */
  const stopLeave = (then, target) => {
    const { form } = parts();
    if (!form) return false;
    // A save is on its way: a leave now could cut the answer off.
    if (saving(form)) return true;
    if (leaving || !isDirty()) return false;
    openGuard(then, target);
    return true;
  };

  // Listeners, registered once ------------------------------------------------------------------

  document.addEventListener("click", (event) => {
    const button = event.target.closest?.("button");
    if (!button) return;
    const dialog = button.closest("dialog[data-guard]");
    if (dialog) {
      if (button.hasAttribute("data-guard-keep")) guardKeep(dialog);
      else if (button.hasAttribute("data-guard-discard")) guardDiscard(dialog);
      else if (button.hasAttribute("data-guard-save")) guardSave(dialog);
      return;
    }
    if (button.hasAttribute("data-discard")) {
      const { form } = parts();
      if (!form || button.form !== form) return;
      if (!refused(form)) return form.reset();
      // A reset would return to the refused input: load the stored values of the panel again.
      const url = new URL(backDefaults.get(form) || location.href, location.href);
      url.searchParams.delete("saved");
      leave(() => go(url.href));
    }
  });

  // Escape closes a modal dialog by itself: that is "Keep editing". `cancel` does not bubble.
  document.addEventListener(
    "cancel",
    (event) => {
      if (!event.target.matches?.("dialog[data-guard]")) return;
      pending = null;
      kept = true;
    },
    true,
  );
  // After "Keep editing" the focus goes back to the field last edited, not to what opened the
  // guard. The dialog has put the focus back by the time `close` comes.
  document.addEventListener(
    "close",
    (event) => {
      if (!event.target.matches?.("dialog[data-guard]")) return;
      const back = kept && lastField?.isConnected && lastField.form === parts().form;
      kept = false;
      if (back) lastField.focus();
    },
    true,
  );

  const edited = (event) => {
    const { form } = parts();
    if (!form || event.target.form !== form) return;
    lastField = event.target;
    update();
  };
  document.addEventListener("input", edited);
  document.addEventListener("change", edited);
  // Reset puts the defaults back after the event; read the form once it is done.
  document.addEventListener("reset", (event) => {
    if (event.target === parts().form) setTimeout(update);
  });

  // A page restored from the history can hold typed values that differ from the defaults.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      leaving = false;
      submitting = false;
      const save = parts().bar?.querySelector("[data-save]");
      if (save) save.disabled = false;
    }
    update();
  });

  // Submit of the panel form: the page changes at once and must not trigger the guard. A second
  // submit before the answer arrives is dropped: the first request may already have done its work
  // on the server. Capture phase, so that this runs before `enhance.js` takes the submit.
  document.addEventListener(
    "submit",
    (event) => {
      const { form } = parts();
      if (!form || event.target !== form) return;
      if (saving(form)) {
        event.preventDefault();
        return;
      }
      submitting = true;
      leaving = true;
      setTimeout(() => {
        if (!event.defaultPrevented) {
          const save = form.querySelector("[data-save]");
          if (save) save.disabled = true;
          return;
        }
        // Another script stopped the submit. Either the page stays, or `enhance.js` sends the
        // form (it has read the fields by now and marks the form with `data-pending`). In both
        // cases the state goes back.
        submitting = false;
        leaving = false;
        restoreBack(form);
      });
    },
    true,
  );

  // Without `enhance.js`: another form on the page (reload calendars, sign out) leaves the panel.
  document.addEventListener("submit", (event) => {
    if (enhanced()) return;
    const other = event.target;
    const { form } = parts();
    if (!form || other === form || event.defaultPrevented) return;
    const submitter = event.submitter;
    const again = () => {
      if (submitter) other.requestSubmit(submitter);
      else other.requestSubmit();
    };
    if (stopLeave(again, null)) event.preventDefault();
  });

  // Without `enhance.js`: a click on a link inside the app while the form is dirty asks first.
  document.addEventListener("click", (event) => {
    if (enhanced()) return;
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest?.("a[href]");
    if (!link || (link.target && link.target !== "_self") || link.hasAttribute("download")) return;
    const to = new URL(link.href, location.href);
    if (to.origin !== location.origin) return;
    if (to.pathname === location.pathname && to.search === location.search && to.hash) return;
    if (stopLeave(() => go(to.href), to.pathname + to.search)) event.preventDefault();
  });

  // With `enhance.js`: every leave (link, form, history, `visit()`) comes through this event.
  document.addEventListener("enhance:before-visit", (event) => {
    const { form } = parts();
    if (!form) return;
    const detail = event.detail ?? {};
    if (detail.form === form) {
      // The panel's own save. A save in the background is still on its way: wait for it.
      if (busy) event.preventDefault();
      return;
    }
    const to = new URL(detail.url, location.href);
    const target =
      detail.method === "get" && to.origin === location.origin ? to.pathname + to.search : null;
    if (stopLeave(detail.resume ?? (() => go(to.href)), target)) event.preventDefault();
  });

  // `enhance.js` loads the answer of a finished save as a normal page (after a deploy).
  document.addEventListener("enhance:leave", () => (leaving = true));

  /**
   * After "stored, but the page failed" the form still holds the version it was drawn from, so
   * the next save would be refused as a conflict. Read the page again: if the server shows what
   * the form holds, take its version. If it shows something else, keep the old one, so that the
   * next save says truthfully that the panel changed.
   */
  const refreshVersion = async (form) => {
    const field = form.elements.v;
    if (!field) return;
    try {
      const response = await fetch(location.href, {
        credentials: "same-origin",
        headers: { Accept: "text/html" },
      });
      if (!response.ok) return;
      const doc = new DOMParser().parseFromString(await response.text(), "text/html");
      const fresh = doc.querySelector("aside.detail form.detail-form");
      const v = fresh?.elements.v?.value;
      if (
        !v ||
        !field.isConnected ||
        form.getAttribute("action") !== fresh.getAttribute("action")
      ) {
        return;
      }
      const held = (f) => {
        const data = new URLSearchParams(new FormData(f));
        data.delete("v");
        data.delete("back");
        data.sort();
        return data.toString();
      };
      // Compare the defaults: what the form holds as stored, not what was typed since.
      const stored = form.cloneNode(true);
      stored.reset();
      if (held(stored) === held(fresh)) {
        field.value = v;
        field.defaultValue = v;
      }
    } catch {} // The version stays: the next save is refused as a conflict and shows the panel.
  };

  // `enhance.js` reports a save that did not arrive: the panel keeps its input. "stale": the server
  // stored the save, but the page after it failed. The input is what is stored now, so it becomes
  // the baseline; the bar stays open with its note (`data-save-error="stale"`) until the next change.
  document.addEventListener("enhance:save-error", (event) => {
    const { form, bar } = parts();
    if (!form || event.target !== form) return;
    event.preventDefault();
    const kind = event.detail?.kind;
    if (kind === "stale" && bar.querySelector('[data-save-error="stale"]')) {
      for (const field of fields(form)) {
        if (field.type === "radio" || field.type === "checkbox") {
          field.defaultChecked = field.checked;
        } else if (field.localName === "select") {
          for (const option of field.options) option.defaultSelected = option.selected;
        } else if ("defaultValue" in field) field.defaultValue = field.value;
      }
      bar.setAttribute("data-forced", "");
      update();
      fail("stale");
      void refreshVersion(form);
      return;
    }
    fail(kind === "session" ? "session" : "failed");
  });

  // Closing the tab or reloading fall to the browser's own question.
  window.addEventListener("beforeunload", (event) => {
    if (leaving || !isDirty()) return;
    event.preventDefault();
    event.returnValue = "";
  });

  /** Roving focus for a group of checkboxes: one tab stop, arrow keys move between them. */
  const rovingItems = (group) => [...group.querySelectorAll("input")];
  const activate = (items, item) => {
    for (const other of items) other.tabIndex = other === item ? 0 : -1;
  };
  document.addEventListener("focusin", (event) => {
    const group = event.target.closest?.("[data-roving]");
    if (!group) return;
    const items = rovingItems(group);
    if (items.includes(event.target)) activate(items, event.target);
  });

  document.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const group = event.target.closest?.("[data-roving]");
    if (group) {
      const items = rovingItems(group);
      const at = items.indexOf(event.target);
      if (at < 0) return;
      let next;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (at + 1) % items.length;
      else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        next = (at - 1 + items.length) % items.length;
      } else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = items.length - 1;
      else return;
      event.preventDefault();
      items[next].focus();
      return;
    }
    // Arrow Up and Down, and `j` and `k`, move between the rows of the list that opens panels.
    // `j` and `k` are single keys: the switch in the account menu turns them off (`palette.js`).
    const step = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 }[event.key];
    if (!step || event.shiftKey || event.isComposing) return;
    const single = event.key === "j" || event.key === "k";
    if (single && window.slotmirrorScripts?.palette?.singleKeys?.() === false) return;
    const row = event.target.closest?.("a.list-row, a.row-open");
    if (!row) return;
    const rows = [...document.querySelectorAll(".list a.list-row, .list a.row-open")];
    const next = rows[rows.indexOf(row) + step];
    if (!next) return;
    event.preventDefault();
    next.focus();
  });

  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented) return;
    const { aside, form, closeLink } = parts();
    if (!aside) return;
    if (!form) {
      // A panel without a form has nothing to guard. Escape still closes it, except a panel that
      // holds something shown once (`data-escape="off"`): a key must not throw that away.
      if (aside.dataset.escape !== "off" && escapePressed(event) && closeLink) go(closeLink.href);
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      // Not while a dialog is open (the guard, the palette, the shortcut sheet), and not twice.
      // Not the Enter that ends an input method composition (Safari: keyCode 229).
      if (event.isComposing || event.keyCode === 229) return;
      if (document.querySelector("dialog[open]") || !isDirty()) return;
      event.preventDefault();
      submitForm(form, null);
      return;
    }
    if (!escapePressed(event) || !closeLink) return;
    if (saving(form)) return;
    const to = new URL(closeLink.href, location.href);
    event.preventDefault();
    if (isDirty()) {
      openGuard(() => go(to.href), to.pathname + to.search);
    } else {
      leaving = true;
      go(to.href);
    }
  });

  /** Escape that is not meant for something else: a menu, a dialog, an input method. */
  const escapePressed = (event) => {
    if (event.key !== "Escape" || event.isComposing) return false;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
    if (document.querySelector("dialog[open]")) return false;
    try {
      return !document.querySelector(":popover-open");
    } catch {
      return true;
    }
  };

  // State of the page as it is now --------------------------------------------------------------

  let shownCount = 0;

  /** Runs when the page is parsed and after each change of the page content. No listeners here. */
  const sync = (kind, announced) => {
    leaving = false;
    submitting = false;
    pending = null;
    pendingUrl = null;
    kept = false;

    // "Saved" is a message about the page as it was loaded: show it about four seconds, and drop
    // the parameter so that a reload does not show it again.
    const url = new URL(location.href);
    if (url.searchParams.has("saved")) {
      url.searchParams.delete("saved");
      history.replaceState(history.state, "", url);
    }
    const saved = document.querySelector("aside.detail [data-saved]");
    // The mark is not in the server's markup, so a new page content drops it again.
    if (saved && !saved.hidden && !saved.hasAttribute("data-shown")) {
      const mark = String(++shownCount);
      saved.setAttribute("data-shown", mark);
      // One announcement per save, from `#announcer`. After a merge `enhance.js` says it
      // (`detail.saved`). After a full load (a save without enhanced navigation) the note was in
      // the page from the start, which no screen reader reads out, so the live region says it
      // here. The note is no live region: a merge inserts it, and some screen readers announce an
      // inserted status, which made "Saved" twice.
      const box = document.getElementById("announcer");
      const text = box?.dataset.msgSaved;
      if (!announced && text) {
        box.setAttribute("aria-live", "polite");
        box.textContent = "";
        setTimeout(() => {
          if (saved.getAttribute("data-shown") === mark) box.textContent = text;
        }, 100);
      }
      setTimeout(() => {
        if (saved.getAttribute("data-shown") === mark) saved.hidden = true;
      }, 4000);
    }

    // Focus into the panel, without scrolling the list, when the page opens with it. After a
    // change of the page content, `enhance.js` decides where the focus goes.
    // A page that answers a refused or conflicting save (no script navigation): the reason first.
    // A hash that names a field of the panel ("#cal-hours-on", the link from a mirroring's
    // working hours) takes the focus there; the browser scrolled to it already.
    if (
      kind === "initial" &&
      !(
        document.querySelector(
          "aside.detail [data-savebar][data-refused], aside.detail [data-conflict]",
        ) && focusAnswer()
      )
    ) {
      const field = hashField();
      if (field) {
        field.focus({ preventScroll: true });
        field.scrollIntoView({ block: "center" });
      } else document.querySelector("aside.detail .detail-title")?.focus({ preventScroll: true });
    }

    for (const group of document.querySelectorAll("[data-roving]")) {
      const items = rovingItems(group);
      if (items.length > 0) activate(items, items.find((item) => item.checked) ?? items[0]);
    }

    const { form, bar } = parts();
    if (!form) return;
    const discard = bar.querySelector("[data-discard]");
    if (discard) discard.hidden = false;
    backDefaults.set(form, form.elements.back?.value);
    update();
  };

  const run = (kind, announced = false) => {
    try {
      sync(kind, announced);
    } catch (error) {
      // A failure leaves the panel a plain form with a Save button.
      document.documentElement.classList.remove("js");
      console.error(error);
    }
  };
  document.addEventListener("enhance:load", (event) =>
    run(event.detail?.kind ?? "load", event.detail?.saved === true),
  );
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => run("initial"));
  } else {
    run("initial");
  }
})();
