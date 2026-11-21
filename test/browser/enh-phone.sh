#!/bin/zsh
# The phone layout (390 x 844 by default), where the window scrolls instead of the list: open a
# panel from a row low on the page, save, go back to the list, and history back and forward.
# Prints one JSON object with pass/fail per check.
# Usage: test/browser/enh-phone.sh [base-url] [height]     (default http://localhost:8822, 844)
# Run it at 844 and at a short height (for example 480), where the list is longer than the window.
# IT SAVES the level of the last mirroring twice (changed, then back to the start value).
BASE=${1:-http://localhost:8822}
HEIGHT=${2:-844}
ab() { agent-browser --session "${AB_SESSION:-enh}" "$@"; }
source "${0:A:h}/lib.sh"

ab set viewport 390 "$HEIGHT" >/dev/null 2>&1
open_enhanced "$BASE/mirroring" || { echo '{"pass":false,"error":"enhance did not start"}'; exit 1; }

check "the window scrolls on a phone, and a row low on the page opens the panel at the top" "$(runj '
  const pane = document.querySelector(".page-scroll");
  const windowScrolls = getComputedStyle(pane).overflowY === "visible";
  const scrolls = document.documentElement.scrollHeight > innerHeight + 4;
  scrollTo(0, document.documentElement.scrollHeight);
  await sleep(300);
  const listY = scrollY;
  window.__listY = listY;
  const rows = document.querySelectorAll("a.list-row");
  const row = rows[rows.length - 1];
  window.__rowHref = row.href;
  const m = dbg().merges;
  row.click();
  await until(() => dbg().merges > m);
  await sleep(150);
  const detail = document.querySelector("aside.detail").getBoundingClientRect();
  // The panel starts under the phone header (logo and tabs) and covers the list.
  return { pass: windowScrolls && (listY > 0 || !scrolls) && dbg().last.kind === "panel-open" && scrollY === 0 && detail.top <= 120 &&
      detail.width >= 380 && document.activeElement.id === "detail-title", windowScrolls, listY, scrolls, scrollY, top: detail.top, width: detail.width, active: document.activeElement.id, kind: dbg().last.kind };
')"

check "a save on a phone keeps the place, shows Saved and leaves the bar clean" "$(runj '
  const f = panelForm();
  const start = f.elements.copy.value;
  scrollTo(0, 120);
  await sleep(100);
  const y = scrollY;
  f.querySelector(`input[name=copy][value=${start === "title" ? "busy" : "title"}]`).click();
  let m = dbg().merges;
  f.querySelector("[data-save]").click();
  await until(() => dbg().merges > m);
  await sleep(150);
  const saved = document.querySelector("aside.detail [data-saved]");
  const out = { kind: dbg().last.kind, y, after: scrollY, saved: Boolean(saved && !saved.hidden), dirty: isDirty() };
  // Back to the start state.
  panelForm().querySelector(`input[name=copy][value=${start}]`).click();
  m = dbg().merges;
  panelForm().querySelector("[data-save]").click();
  await until(() => dbg().merges > m);
  await sleep(100);
  return { pass: out.kind === "save" && Math.abs(out.after - out.y) <= 1 && out.saved && !out.dirty &&
      panelForm().elements.copy.value === start && !isDirty(), start, ...out };
')"

check "the back link returns to the list at the row's place, with the focus on the row" "$(runj '
  const m = dbg().merges;
  document.querySelector("aside.detail a.detail-back").click();
  await until(() => dbg().merges > m);
  await sleep(150);
  const a = document.activeElement;
  return { pass: dbg().last.kind === "panel-close" && !document.querySelector("aside.detail") && Math.abs(scrollY - window.__listY) <= 2 &&
      a.matches("a.list-row") && a.href === window.__rowHref, kind: dbg().last.kind, scrollY, listY: window.__listY, active: a.getAttribute("href") };
')"

check "history back opens the panel again at the top, forward returns to the list place" "$(runj '
  let m = dbg().merges;
  history.back();
  await until(() => dbg().merges > m);
  await sleep(200);
  const back = { panel: Boolean(document.querySelector("aside.detail")), y: scrollY };
  m = dbg().merges;
  history.forward();
  await until(() => dbg().merges > m);
  await sleep(200);
  return { pass: back.panel && !document.querySelector("aside.detail") && Math.abs(scrollY - window.__listY) <= 2,
    back, forwardY: scrollY, listY: window.__listY };
')"

ab set viewport 1280 720 >/dev/null 2>&1
report enh-phone
