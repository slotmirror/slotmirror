#!/bin/zsh
# Enhanced navigation on /mirroring: open, switch and close a panel, back and forward, and
# 50 navigations without new listeners. Prints one JSON object with pass/fail per check.
# Usage: test/browser/enh-panel.sh [base-url]     (default http://localhost:8822)
# It opens pages and clicks links. It changes and saves nothing.
BASE=${1:-http://localhost:8822}
ab() { agent-browser --session "${AB_SESSION:-enh}" "$@"; }
source "${0:A:h}/lib.sh"

ab set viewport 1280 420 >/dev/null 2>&1
open_enhanced "$BASE/mirroring" || { echo '{"pass":false,"error":"enhance did not load"}'; exit 1; }

check "open panel keeps list scroll and focuses the panel heading" "$(runj '
  const list = document.querySelector(".page-scroll");
  list.scrollTop = 60;
  const before = list.scrollTop;
  const m = dbg().merges;
  document.querySelectorAll("a.list-row")[3].click();
  await until(() => dbg().merges > m && document.querySelector("aside.detail"));
  await sleep(50);
  const after = document.querySelector(".page-scroll").scrollTop;
  return { pass: before > 0 && Math.abs(after - before) <= 1 && document.activeElement.id === "detail-title" &&
      dbg().last.kind === "panel-open" && location.search.includes("d="),
    before, after, active: document.activeElement.id, kind: dbg().last.kind, ms: dbg().last.ms, morphMs: dbg().last.morphMs };
')"

check "switch rows keeps list scroll, panel to top, heading focused" "$(runj '
  const before = document.querySelector(".page-scroll").scrollTop;
  const detail = document.querySelector(".detail-body"); detail.scrollTop = 80;
  const m = dbg().merges;
  const target = document.querySelectorAll("a.list-row")[4];
  const href = target.href;
  target.click();
  await until(() => dbg().merges > m);
  await sleep(50);
  return { pass: dbg().last.kind === "panel-switch" && location.href === href && document.activeElement.id === "detail-title" &&
      Math.abs(document.querySelector(".page-scroll").scrollTop - before) <= 1 && document.querySelector(".detail-body").scrollTop === 0,
    kind: dbg().last.kind, url: location.search, active: document.activeElement.id };
')"

check "close returns focus to the row" "$(runj '
  const open = location.href;
  const m = dbg().merges;
  document.querySelector("aside.detail a.detail-close").click();
  await until(() => dbg().merges > m);
  await sleep(50);
  const a = document.activeElement;
  return { pass: dbg().last.kind === "panel-close" && !document.querySelector("aside.detail") &&
      a.matches("a.list-row") && a.href === open, kind: dbg().last.kind, active: a.getAttribute("href") };
')"

# History: list -> row 3 -> row 4 -> list. Back twice, forward once.
check "back restores the last panel without a reload" "$(runj '
  window.__sameDoc = 1;
  const m = dbg().merges;
  history.back();
  await until(() => dbg().merges > m);
  return { pass: window.__sameDoc === 1 && Boolean(document.querySelector("aside.detail")) && location.search.includes("d=") &&
      dbg().last.kind === "pop", url: location.search, kind: dbg().last.kind };
')"
check "back again shows the earlier panel, forward the later one" "$(runj '
  const second = location.href;
  let m = dbg().merges;
  history.back();
  await until(() => dbg().merges > m);
  const first = location.href;
  const okBack = Boolean(document.querySelector("aside.detail")) && first !== second;
  m = dbg().merges;
  history.forward();
  await until(() => dbg().merges > m);
  return { pass: window.__sameDoc === 1 && okBack && location.href === second && Boolean(document.querySelector("aside.detail")),
    first, second, now: location.href };
')"

check "a press prefetches; the click uses it (one GET)" "$(runj '
  const link = [...document.querySelectorAll("a.list-row")].find((a) => a.href !== location.href);
  const gets = [];
  const real = window.fetch;
  window.fetch = (u, o = {}) => { if ((o.method || "GET") === "GET") gets.push(String(u)); return real(u, o); };
  const hits = dbg().prefetchHits;
  const m = dbg().merges;
  link.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
  await sleep(80);
  link.click();
  await until(() => dbg().merges > m);
  window.fetch = real;
  return { pass: dbg().prefetchHits === hits + 1 && gets.length === 1 && location.href === link.href, gets: gets.length, hits: dbg().prefetchHits - hits };
')"

check "50 navigations add no listeners and no scripts" "$(runj '
  const rows = [...document.querySelectorAll("a.list-row")].map((a) => a.href);
  let added = 0;
  const real = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (...args) {
    if (this === document || this === window) added++;
    return real.apply(this, args);
  };
  const scripts = document.scripts.length;
  const start = performance.now();
  try {
    for (let i = 0; i < 50; i++) await window.slotmirror.visit(rows[i % rows.length]);
  } finally {
    EventTarget.prototype.addEventListener = real;
  }
  return { pass: added === 0 && document.scripts.length === scripts && window.__sameDoc === 1 && dbg().fallbacks === 0,
    added, scriptsBefore: scripts, scriptsAfter: document.scripts.length, avgMs: Math.round((performance.now() - start) / 50) };
')"

ab set viewport 1280 720 >/dev/null 2>&1
report enh-panel
