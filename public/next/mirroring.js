// Mirroring page of the redesign. The page works without this script: every control is a form
// field, the panel posts as one form, and CSS shows the hints of the chosen answers. `panel.js` runs
// the save bar. This script adds the save-bar notes that depend on more than one field:
//   - one mirroring: the note of the level that is chosen (who will see what), shown when it
//     differs from the saved level, and a note when only "who sees it" changes. It also disables
//     "who sees it" while the level is "Not copied". The server renders one note for each level that
//     shows more than the saved one, so no table of levels lives here;
//   - all mirrorings: the warning while "everyone" and "also apply" are both chosen.
// It also adds a row to the carried categories ("Add a row"), a button that only shows with script.
// All text comes from the page, none from this file.
// It listens once on the document, so it works after `enhance.js` changed the page content, and
// does nothing on a page without these forms.
(() => {
  const loaded = (window.slotmirrorScripts ??= {});
  if (loaded.mirroring) return;
  loaded.mirroring = true;

  /** The value of the radio group that the server rendered as checked. */
  const savedValue = (form, name) =>
    [...form.querySelectorAll(`input[name="${name}"]`)].find((field) => field.defaultChecked)
      ?.value;

  const mirroring = (form) => {
    const copy = form.elements.copy?.value;
    const who = form.elements.who?.value;
    // A mirroring with mixed marks needs an answer for a copied level, never for "Not copied". The
    // server asks for it too, for a page without this script.
    const mixed = Boolean(form.querySelector(".mx-who[data-mixed]"));
    for (const radio of form.querySelectorAll('input[name="who"]')) {
      radio.disabled = copy === "off";
      radio.required = mixed && copy !== "off";
    }

    // The two questions as one level, like the server maps them: anything but "open" is private.
    // A mirroring with mixed marks preselects no answer: until one is chosen, no level note shows.
    const now =
      copy === "off" ? "off" : who ? `${copy}-${who === "open" ? "open" : "private"}` : null;
    for (const note of form.querySelectorAll("[data-sentence]")) {
      note.hidden = note.dataset.sentence !== now;
    }
    const whoNote = form.querySelector("[data-who-note]");
    if (whoNote) {
      whoNote.hidden = !(
        copy !== "off" &&
        copy === savedValue(form, "copy") &&
        who !== savedValue(form, "who")
      );
    }
  };

  const all = (form) => {
    const note = form.querySelector("[data-apply-note]");
    if (!note) return;
    note.hidden = !(form.elements.newWho?.value === "open" && form.elements.applyWho?.checked);
  };

  document.addEventListener("panel:update", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.querySelector("[data-mx]")) mirroring(form);
    else all(form);
  });

  // "Add a row" of the carried categories between providers: a copy of the last row, empty. The
  // rows send their fields in order, so the fields need no index of their own. A "Tentative"
  // switch sends nothing while it is off, so it sends the index of its row: the new row gets the
  // next one, unticked. Its fields count as unchanged until the person fills them: the empty value
  // is also their default. A choice marked `data-pass-stale` names a calendar that is no longer a
  // source; only the row that stored it offers it, so the new row drops it.
  document.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("[data-pass-add]") : null;
    const rows = button?.closest(".prop")?.querySelector(".mx-pass-rows");
    const last = rows?.lastElementChild;
    if (!last) return;
    const row = last.cloneNode(true);
    const index = String(rows.children.length);
    for (const field of row.querySelectorAll("input, select")) {
      field.removeAttribute("aria-invalid");
      if (field.type === "checkbox") {
        field.defaultChecked = false;
        field.checked = false;
        field.value = index;
      } else if (field.localName === "select") {
        for (const option of field.querySelectorAll("option[data-pass-stale]")) option.remove();
        for (const option of field.options) {
          option.defaultSelected = option.value === "";
          option.selected = option.value === "";
        }
      } else {
        field.defaultValue = "";
        field.value = "";
      }
    }
    rows.append(row);
    row.querySelector("input, select")?.focus();
  });

  // The panel script runs first (head order) and counts before this listener exists: count again,
  // so that its "panel:update" reaches this script.
  if (document.readyState !== "loading") loaded.panel?.update?.();
})();
