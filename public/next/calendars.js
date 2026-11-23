// Calendar panel: the working-hours fields follow their switch, and "until midnight" disables the
// end field. `panel.js` runs the save bar. Without this script the form is a plain form with one
// Save button. No user-facing text lives here.
// Listeners are registered once on the document; `sync()` runs when the page is parsed and after
// `enhance.js` changed the page content ("enhance:load"). Safe on pages without the panel.
(() => {
  const loaded = (window.slotmirrorScripts ??= {});
  if (loaded.calendars) return;
  loaded.calendars = true;

  const panelForm = () => document.querySelector("aside.detail form.detail-form");

  function syncFields(form) {
    const hoursFields = form.querySelector("[data-hours-fields]");
    const hoursSwitch = form.elements.workHoursOn;
    const midnight = form.elements.workUntilMidnight;
    const end = form.elements.workEnd;
    if (hoursFields && hoursSwitch) hoursFields.hidden = !hoursSwitch.checked;
    if (end && midnight) end.disabled = midnight.checked;
  }

  const sync = () => {
    const form = panelForm();
    if (!form) return;
    // A zone field without a stored zone gets the browser's zone. Without the script it keeps the
    // server's. The browser's zone becomes the field's default, so that it is not a change, and
    // `workTimeZoneDefault` tells the server, which counts a refused form against it. The mark is
    // not in the server's markup: a new page content drops it, and the zone is set again.
    const zone = form.elements.workTimeZone;
    if (zone?.dataset.browserZone && !zone.hasAttribute("data-zone-set")) {
      zone.setAttribute("data-zone-set", "");
      const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (browserZone) {
        zone.value = browserZone;
        zone.defaultValue = browserZone;
        const base = form.elements.workTimeZoneDefault;
        if (base) base.value = browserZone;
      }
    }
    syncFields(form);
  };

  document.addEventListener("change", (event) => {
    const form = event.target.form;
    if (form && form === panelForm()) syncFields(form);
  });
  // The reset restores the defaults after this event; read the fields once it is done.
  document.addEventListener("reset", (event) => {
    const form = event.target;
    if (form === panelForm()) setTimeout(() => syncFields(form));
  });

  document.addEventListener("enhance:load", sync);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", sync);
  else sync();
})();
