// Copy buttons of the new-token panel. The button needs the `js` class (`data-needs-script`), so a page
// without script keeps a value that selects with one click. No user-facing text lives here: the
// server renders the labels into data- attributes. One delegated listener, so the buttons work
// after `enhance.js` changed the page content too.
(() => {
  const loaded = (window.slotmirrorScripts ??= {});
  if (loaded.tokens) return;
  loaded.tokens = true;
  const timers = new WeakMap();

  document.addEventListener("click", async (event) => {
    const button = event.target.closest?.("[data-copy-target]");
    const target = button && document.getElementById(button.dataset.copyTarget);
    if (!target) return;
    const text = target.textContent ?? "";
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // The clipboard may be blocked: select the value, so that the user can copy it by hand.
      const range = document.createRange();
      range.selectNodeContents(target);
      const selection = getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return;
    }
    button.textContent = button.dataset.copiedLabel ?? "";
    clearTimeout(timers.get(button));
    timers.set(
      button,
      setTimeout(() => {
        button.textContent = button.dataset.copyLabel ?? "";
      }, 2000),
    );
  });
})();
