#!/bin/zsh
# Enhanced navigation swaps one panel for a panel of another shape: mirroring -> "For all
# mirrorings" -> a mirroring row -> a calendar panel through the nav -> Back -> Back -> Forward.
# After each step every control in the panel shows what the server rendered (property and
# attribute agree, each radio group has one checked radio, the checked set equals a plain fetch
# of the same address), the panel is clean, and a leave opens no dialog. The panel is a new node
# after each step, so losing the swap alone fails too (`syncChoices` alone hides the drift).
# Usage: test/browser/enh-swap.sh [base-url]     (default http://localhost:8822)
# It saves nothing.
BASE=${1:-http://localhost:8822}
ab() { agent-browser --session "${AB_SESSION:-enh}" "$@"; }
source "${0:A:h}/lib.sh"

START="$BASE/mirroring?d=sim-u-dev-2~sim-u-dev-1&lang=en"
open_enhanced "$START" || { echo '{"pass":false,"error":"enhance did not load"}'; exit 1; }

# The state of the panel against the markup of the server. Run after each step.
STATE='
  await sleep(350);
  const f = document.getElementById("detail-form");
  if (!f) return { pass: false, error: "no panel form", url: location.search };
  const groups = {};
  const drift = [];
  for (const el of f.querySelectorAll("input, textarea, select")) {
    const t = el.type;
    if (t === "radio") (groups[el.name] ??= []).push(el.checked);
    if (t === "radio" || t === "checkbox") {
      if (el.checked !== el.hasAttribute("checked")) drift.push(el.name + "=" + el.value);
    } else if (el.localName === "select") {
      const want = el.multiple ? null : ([...el.options].findLast((o) => o.hasAttribute("selected"))?.index ?? 0);
      if (el.multiple ? [...el.options].some((o) => o.selected !== o.hasAttribute("selected")) : el.selectedIndex !== want)
        drift.push(el.name + ":select");
    } else if (!["hidden", "file", "submit", "button", "reset"].includes(t) && el.value !== el.defaultValue) {
      drift.push(el.name + ":value");
    }
  }
  const badGroups = Object.entries(groups).filter(([, v]) => v.filter(Boolean).length !== 1).map(([k]) => k);
  const live = [...f.querySelectorAll("input[type=radio], input[type=checkbox]")]
    .filter((el) => el.checked).map((el) => el.name + "=" + el.value).sort();
  const res = await fetch(location.href, { credentials: "same-origin" });
  const doc = new DOMParser().parseFromString(await res.text(), "text/html");
  const sf = doc.getElementById("detail-form");
  const server = sf ? [...sf.querySelectorAll("input[type=radio][checked], input[type=checkbox][checked]")]
    .map((el) => el.name + "=" + el.value).sort() : null;
  const sameSet = JSON.stringify(live) === JSON.stringify(server);
  const count = document.querySelector("aside.detail .savebar-text[data-count]")?.textContent ?? "";
  // A leave asks the guard: a clean panel lets it pass without the dialog.
  const passed = document.dispatchEvent(new CustomEvent("enhance:before-visit", { bubbles: true, cancelable: true,
    detail: { url: location.origin + "/", method: "get", kind: "api", form: null, resume: () => {} } }));
  const dialog = document.querySelector("dialog[data-guard]");
  const guard = Boolean(dialog?.open);
  if (dialog?.open) dialog.close();
  // After a step the panel is a new node (the old one was replaced, not morphed), and a click
  // leaves the focus on the panel title with the panel body at the top. Back and forward put
  // the focus where it was, so only the node counts there.
  const aside = document.querySelector("aside.detail");
  const stepped = window.__stepped === 1;
  const newNode = !stepped || !aside?.__old;
  const kind = dbg().last?.kind ?? null;
  const titleFocus = document.activeElement?.id === "detail-title";
  const bodyTop = aside?.querySelector(".detail-body")?.scrollTop ?? 0;
  const placed = !stepped || kind === "pop" || (titleFocus && bodyTop === 0);
  return { pass: badGroups.length === 0 && drift.length === 0 && sameSet && !isDirty() && count === "" && passed && !guard &&
      newNode && placed,
    url: location.search, badGroups, drift, sameSet, live: live.length, server: server?.length ?? null,
    dirty: isDirty(), count, guard, inert: Boolean(aside?.inert), newNode, kind, titleFocus, bodyTop };
'

# step <name> <action>: runs the action (a shell command), waits for the merge, checks the state.
step() {
  local m
  m=$(evalj 'String(window.slotmirror._debug.merges)')
  # Mark the panel on screen and scroll its body: a morphed panel would keep both.
  ab eval 'window.__stepped = 1; const a = document.querySelector("aside.detail");
    if (a) { a.__old = 1; const b = a.querySelector(".detail-body"); if (b) b.scrollTop = 120; } 1' >/dev/null 2>&1
  eval "$2" >/dev/null 2>&1
  wait_for "window.slotmirror._debug.merges > $m && !document.querySelector('aside.detail[inert]')"
  check "$1" "$(runj "$STATE")"
}

check "plain load of a mirroring panel matches the server" "$(runj "$STATE")"
step "mirroring -> For all mirrorings" 'ab click "header a[href*=\"d=all\"]"'
step "For all mirrorings -> a mirroring row" 'ab click ".list a.list-row[href*=\"d=sim\"]"'
# The calendars page through the nav, then a calendar panel from its list.
m0=$(evalj 'String(window.slotmirror._debug.merges)')
ab click "nav a[href^=\"/calendars\"]" >/dev/null 2>&1
wait_for "window.slotmirror._debug.merges > $m0 && location.pathname === '/calendars'"
step "calendars page -> a calendar panel" 'ab click ".list a.row-open[href*=\"c=\"]"'
# Back over the calendars page (no panel) to the mirroring row, Back to "For all", Forward.
step "Back, Back: the mirroring row" 'ab back; sleep 1; ab back'
step "Back: For all mirrorings" 'ab back'
step "Forward: the mirroring row" 'ab forward'

# No page script adds a listener when it syncs (review 10, minor 9): the node test runs sync() on
# a document without markup; here it runs on a real panel, through a real merge and twice more.
check "sync() adds no listener on a real panel page" "$(runj '
  const real = EventTarget.prototype.addEventListener;
  const added = [];
  EventTarget.prototype.addEventListener = function (type, ...rest) { added.push(type); return real.call(this, type, ...rest); };
  try {
    const m = dbg().merges;
    document.querySelector("header a[href*=\"d=all\"]").click();
    await until(() => dbg().merges > m && !document.querySelector("aside.detail[inert]"));
    for (const kind of ["save", "panel-switch"]) document.dispatchEvent(new CustomEvent("enhance:load", { detail: { kind } }));
    await sleep(200);
  } finally {
    EventTarget.prototype.addEventListener = real;
  }
  return { pass: added.length === 0 && Boolean(panelForm()), added };
')"

report enh-swap
