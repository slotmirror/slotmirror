#!/bin/zsh
# The lists hold their rows when a panel narrows them (960 to 1100 px, list 318 to 458 px) and
# without a panel from 880 to 1024 px (list 638 to 782 px), in
# German, the longer language, and in English: every row keeps its name, its whole level or
# address and its status, nothing overlaps, a narrow list shows no tag, and the page does not
# scroll sideways.
# From 880 to 1024 px without a panel the same holds, and no status is cut.
# From 1100 to 1920 px with a panel, a tag that does not fit hides as a whole, never cut.
# At 1920 and 2560 px the panel ends at the frame's edge; a hint stays 4 px under its control.
# At 390 px the panel's controls are 44 px tall and whole.
# At 1440 px without a panel, the dots of the rows that show only a time sit at one x.
# Usage: test/browser/layout-narrow.sh [base-url]     (default http://localhost:8822)
# It saves nothing.
BASE=${1:-http://localhost:8822}
ab() { agent-browser --session "${AB_SESSION:-enh}" "$@"; }
source "${0:A:h}/lib.sh"

# Every visible row of the list: no overlap between name, meta and status, the meta not cut, the
# name at least 40 px, no tag; and no sideways scroll of the page.
ROWS='
  await sleep(300);
  const box = (el) => el && el.getBoundingClientRect();
  const shown = (el) => el && getComputedStyle(el).display !== "none" && box(el).width > 0;
  const overlap = (a, b) => a && b && a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
  const rows = [...document.querySelectorAll(".list .list-row")].filter((row) => box(row).width > 0);
  const bad = [];
  // Below 760 px of list width the row has two lines and no tags (base.css).
  const narrow = box(document.querySelector(".list")).width < 760;
  for (const row of rows) {
    const title = row.querySelector(".row-title"), meta = row.querySelector(".row-meta");
    const status = row.querySelector(".row-status"), tags = row.querySelector(".row-tags");
    const t = box(title), m = box(meta), s = box(status);
    const why = [];
    if (t.width < 40) why.push("title " + Math.round(t.width));
    if (overlap(t, m)) why.push("title/meta");
    if (overlap(t, s)) why.push("title/status");
    if (overlap(m, s)) why.push("meta/status");
    if (meta && meta.scrollWidth > meta.clientWidth + 1) why.push("meta cut");
    if (status && status.scrollWidth > status.clientWidth + 1) why.push("status cut");
    if (row.scrollWidth > row.clientWidth + 1) why.push("row overflows " + row.scrollWidth + "/" + row.clientWidth);
    if (narrow && shown(tags)) why.push("tags shown");
    if (why.length) bad.push((title?.textContent ?? "?") + ": " + why.join(", "));
  }
  // A group head keeps its words; only the hint after it may end in an ellipsis.
  for (const head of document.querySelectorAll(".list .list-group-head :is(h2, h3)")) {
    if (box(head).width > 0 && head.scrollWidth > head.clientWidth + 1) bad.push("head cut: " + head.textContent);
  }
  const list = Math.round(box(document.querySelector(".list")).width);
  const panel = Boolean(document.querySelector("aside.detail"));
  const sideways = document.documentElement.scrollWidth > innerWidth;
  return { pass: innerWidth === WANT_WIDTH && rows.length > 0 && panel === WANT_PANEL && bad.length === 0 && !sideways, width: innerWidth, list, rows: rows.length, bad, sideways };
'

for lang in de en; do
  for width in 960 1024 1100; do
    ab set viewport $width 800 >/dev/null 2>&1
    for page in "mirroring?d=sim-u-dev-2~sim-u-dev-1" "calendars?c=sim-u-dev-1"; do
      open_mode "$BASE/$page&lang=$lang" || { echo '{"pass":false,"error":"page did not load"}'; exit 1; }
      check "$lang $width ${page%%\?*} with panel" "$(runj "const WANT_WIDTH = $width, WANT_PANEL = true; $ROWS")"
    done
  done
done

# Without a panel, where the list is 638 to 748 px wide: the status column is not cut.
for lang in de en; do
  for width in 880 920 960 990 1024; do
    ab set viewport $width 800 >/dev/null 2>&1
    for page in mirroring calendars; do
      open_mode "$BASE/$page?lang=$lang" || { echo '{"pass":false,"error":"page did not load"}'; exit 1; }
      check "$lang $width $page without panel" "$(runj "const WANT_WIDTH = $width, WANT_PANEL = false; $ROWS")"
    done
  done
done

# Tags: a tag that does not fit hides as a whole; none is cut. A tag counts as shown when it lies
# inside the tags cell, as hidden when it lies wholly outside it (or the cell is not displayed).
TAGS='
  await sleep(300);
  const box = (el) => el.getBoundingClientRect();
  const cut = [];
  let shown = 0;
  for (const cell of document.querySelectorAll(".list .list-row .row-tags")) {
    if (getComputedStyle(cell).display === "none" || box(cell).width === 0) continue;
    const c = box(cell);
    for (const tag of cell.querySelectorAll(".tag")) {
      const t = box(tag);
      const inside = t.left >= c.left - 0.5 && t.right <= c.right + 0.5 && t.top >= c.top - 0.5 && t.bottom <= c.bottom + 0.5;
      const outside = t.left >= c.right - 0.5 || t.top >= c.bottom - 0.5 || t.right <= c.left + 0.5;
      const clipped = tag.scrollWidth > tag.clientWidth + 1;
      if (inside && !clipped) shown++;
      else if (!outside || clipped) cut.push(tag.textContent + " " + Math.round(Math.min(t.right, c.right) - t.left) + "/" + Math.round(t.width));
    }
  }
  return { pass: innerWidth === WANT_WIDTH && cut.length === 0 && (WANT_WIDTH < 1920 || shown > 0), width: innerWidth, shown, cut };
'
for lang in de en; do
  for width in 1100 1280 1440 1920; do
    ab set viewport $width 900 >/dev/null 2>&1
    for page in "mirroring?d=sim-u-dev-2~sim-u-dev-1" "calendars?c=sim-u-dev-1"; do
      open_mode "$BASE/$page&lang=$lang" || { echo '{"pass":false,"error":"page did not load"}'; exit 1; }
      check "$lang $width ${page%%\?*} tags whole or hidden" "$(runj "const WANT_WIDTH = $width; $TAGS")"
    done
  done
done

# At 1920 and 2560 px the panel ends at the frame's edge, with no empty surface beside it.
for width in 1920 2560; do
  ab set viewport $width 1000 >/dev/null 2>&1
  open_mode "$BASE/mirroring?d=sim-u-dev-2~sim-u-dev-1&lang=en" || { echo '{"pass":false,"error":"page did not load"}'; exit 1; }
  check "$width panel at the frame edge" "$(runj '
    await sleep(300);
    const frame = document.querySelector(".frame").getBoundingClientRect();
    const panel = document.querySelector("aside.detail").getBoundingClientRect();
    const empty = Math.round(frame.right - panel.right);
    return { pass: empty <= 1, empty };
  ')"
done

# A hint sits 4 px under its control, also when the label wraps ("Nur diese Kategorien").
ab set viewport 1440 900 >/dev/null 2>&1
for page in "mirroring?d=sim-u-dev-1~sim-u-dev-2" "calendars?c=sim-u-dev-1"; do
  open_mode "$BASE/$page&lang=de" || { echo '{"pass":false,"error":"page did not load"}'; exit 1; }
  check "de ${page%%\?*} hint under its control" "$(runj '
    await sleep(300);
    const far = [];
    let wrapped = 0;
    for (const prop of document.querySelectorAll("aside.detail .prop:not(.is-stacked)")) {
      const control = prop.querySelector(":scope > .prop-control"), hint = prop.querySelector(":scope > .prop-hint");
      if (!control || !hint || !hint.getBoundingClientRect().height) continue;
      if (prop.querySelector(".prop-label").getBoundingClientRect().height > 28) wrapped++;
      const gap = Math.round(hint.getBoundingClientRect().top - control.getBoundingClientRect().bottom);
      if (gap > 4) far.push(prop.querySelector(".prop-label").textContent.trim() + " " + gap);
    }
    return { pass: far.length === 0, wrapped, far };
  ')"
done

# At 390 px (a phone, or a narrow window with a fine pointer) the panel's controls are 44 px tall
# and none cuts its label.
ab set viewport 390 844 >/dev/null 2>&1
for page in "calendars?c=sim-u-dev-1" "mirroring?d=sim-u-dev-2~sim-u-dev-1"; do
  open_mode "$BASE/$page&lang=de" || { echo '{"pass":false,"error":"page did not load"}'; exit 1; }
  check "de 390 ${page%%\?*} controls 44 px and whole" "$(runj '
    await sleep(300);
    const bad = [];
    for (const el of document.querySelectorAll("aside.detail :is(.seg-item, .choice, .btn, .input, .select select)")) {
      const r = el.getBoundingClientRect();
      if (!r.width || getComputedStyle(el).visibility === "hidden") continue;
      const name = (el.textContent || el.getAttribute("aria-label") || el.name || el.className).trim().slice(0, 20);
      if (r.height < 44 - 0.5) bad.push(name + " h" + Math.round(r.height));
      if (el.scrollWidth > el.clientWidth + 1 && !el.matches("input, select")) bad.push(name + " cut");
    }
    return { pass: bad.length === 0, bad };
  ')"
done

# The status column at 1440 px: rows that show only a time put their dot at one x.
ab set viewport 1440 900 >/dev/null 2>&1
open_mode "$BASE/mirroring?lang=en" || { echo '{"pass":false,"error":"page did not load"}'; exit 1; }
check "dots of time-only rows at one x" "$(runj '
  await sleep(300);
  const xs = [...document.querySelectorAll(".list .list-row .row-status .run")]
    .filter((run) => !run.querySelector(".run-words") && run.querySelector("time"))
    .map((run) => Math.round(run.querySelector(".dot").getBoundingClientRect().left * 2) / 2);
  return { pass: xs.length >= 2 && new Set(xs).size === 1, xs };
')"

report layout-narrow
