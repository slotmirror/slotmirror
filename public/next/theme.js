// Theme for the redesign. Loaded in the head without defer, so that the theme is set before the
// first paint. "?theme=light|dark|system" sets and stores the choice; else the stored choice
// counts; "system" (or nothing) leaves the browser's color scheme in charge.
//
// On app pages (`<html data-asset-v>`) it also sets the `js` class before the body is parsed, so
// that the save bar of a panel never flashes. The public pages set it in `public.js`, which holds
// back the consent buttons. Listeners are registered once; `sync()` runs when the page is parsed
// and after `enhance.js` changed the page content ("enhance:load").
(() => {
  const KEY = "slotmirror-theme";
  const CHOICES = ["system", "light", "dark"];
  const root = document.documentElement;
  // A window without a browser's title bar: the desktop shell, or an installed app.
  if (/slotmirror-desktop\//.test(navigator.userAgent)) root.dataset.shell = "desktop";
  else if (
    matchMedia("(display-mode: standalone), (display-mode: window-controls-overlay)").matches
  ) {
    root.dataset.shell = "standalone";
  }
  const loaded = (window.slotmirrorScripts ??= {});
  if (loaded.theme) return;
  loaded.theme = true;
  if (root.hasAttribute("data-asset-v")) root.classList.add("js");
  // The keyboard hints in CSS show Cmd on Apple systems and Ctrl elsewhere.
  const platform = navigator.userAgentData?.platform ?? navigator.platform ?? "";
  root.dataset.platform = /mac|iphone|ipad/i.test(platform) ? "mac" : "other";

  const read = () => {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  };
  const write = (value) => {
    try {
      localStorage.setItem(KEY, value);
    } catch {
      // Private mode or blocked storage: the choice lasts for this page only.
    }
  };

  const apply = (choice) => {
    if (choice === "light" || choice === "dark") root.dataset.theme = choice;
    else delete root.dataset.theme;
    // The title bar colour follows a chosen theme; the metas' media queries only follow the system.
    // The head is never merged, so this runs again only on a new choice.
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
      const scheme =
        choice === "light" || choice === "dark"
          ? choice
          : meta.media.includes("dark")
            ? "dark"
            : "light";
      if (meta.dataset[scheme]) meta.content = meta.dataset[scheme];
    }
    for (const button of document.querySelectorAll("[data-theme-choice]")) {
      button.setAttribute("aria-pressed", String(button.dataset.themeChoice === choice));
    }
  };

  const fromUrl = new URLSearchParams(location.search).get("theme");
  let choice = CHOICES.includes(fromUrl) ? fromUrl : null;
  if (choice) write(choice);
  else choice = CHOICES.includes(read()) ? read() : "system";
  apply(choice);

  // The theme choice needs this script. Its controls carry `data-needs-script`, which the
  // stylesheet hides until the `js` class is set, so there is nothing to show here.
  const sync = () => apply(choice);

  document.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-theme-choice]");
    if (!button) return;
    choice = button.dataset.themeChoice;
    write(choice);
    apply(choice);
  });
  document.addEventListener("enhance:load", sync);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", sync);
  else sync();

  // The save bar hides itself under `js` until the panel script shows it. If that script did not
  // load, the bar must stay a plain Save button.
  window.addEventListener("load", () => {
    if (!loaded.panel && document.querySelector("[data-savebar]")) root.classList.remove("js");
  });
})();
