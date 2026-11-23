// Activity filters: a change submits the form, and the apply button goes away. Empty fields stay
// out of the URL. Without this script the form is a plain GET form with its button.
// Listeners are registered once; `sync()` runs when the page is parsed and after `enhance.js`
// changed the page content ("enhance:load"). Safe on pages without the filter form.
(() => {
  const loaded = (window.slotmirrorScripts ??= {});
  if (loaded.activity) return;
  loaded.activity = true;

  const filterForm = (element) => element?.closest?.("form.act-filters") ?? null;

  const sync = () => {
    for (const form of document.querySelectorAll("form.act-filters")) {
      const apply = form.querySelector("[data-apply]");
      if (apply) apply.hidden = true;
    }
  };

  document.addEventListener("change", (event) => {
    filterForm(event.target)?.requestSubmit();
  });
  // A page restored from the back-forward cache keeps disabled fields.
  addEventListener("pageshow", () => {
    for (const field of document.querySelectorAll("form.act-filters select"))
      field.disabled = false;
  });
  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!form.matches?.("form.act-filters")) return;
    // With `enhance.js` the page stays, and a disabled field would lose the focus: it leaves the
    // empty fields out itself (the form has `data-omit-empty`).
    if (window.slotmirror?.enhanced) return;
    for (const field of form.querySelectorAll("select")) {
      if (!field.value) field.disabled = true;
    }
  });

  document.addEventListener("enhance:load", sync);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", sync);
  else sync();
})();
