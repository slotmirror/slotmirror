#!/bin/zsh
# The unsaved-changes guard with enhanced navigation, on the first mirroring of the dev user: a
# changed level, then a row click, a nav click, Escape and history back must each open the guard
# and keep page and input; Discard goes on without saving; Save and continue saves once and goes on.
# Prints one JSON object with pass/fail per check.
# Usage: test/browser/enh-guard.sh [base-url]     (default http://localhost:8822)
# IT SAVES once (Save and continue sets the level to "Title") and puts the level back at the end.
BASE=${1:-http://localhost:8822}
ab() { agent-browser --session "${AB_SESSION:-enh}" "$@"; }
source "${0:A:h}/lib.sh"

open_enhanced "$BASE/mirroring" || { echo '{"pass":false,"error":"enhance did not load"}'; exit 1; }
# Open the panel through enhance, so that history has an entry to go back to.
runj 'const m = dbg().merges; document.querySelectorAll("a.list-row")[0].click(); await until(() => dbg().merges > m); return {pass:true};' >/dev/null

GUARD_OPEN='const dialog = () => document.querySelector("aside.detail dialog[data-guard]");
  const keep = async () => { dialog().querySelector("[data-guard-keep]").click(); await sleep(50); };'

dirty() {
  runj 'const f = panelForm(); if (f.elements.copy.value !== "title") f.querySelector("input[name=copy][value=title]").click();
    return { pass: isDirty() };' >/dev/null
}

dirty
check "row click with changes opens the guard, Keep stays" "$(runj "$GUARD_OPEN"'
  const url = location.href;
  countPosts();
  document.querySelectorAll("a.list-row")[1].click();
  await sleep(300);
  const open = dialog().open;
  await keep();
  // "Keep editing" returns to the field last edited, not to the row that opened the guard.
  const field = panelForm().querySelector("input[name=copy][value=title]");
  // The focus moves on the close event of the dialog, which comes after a task: wait for it.
  await until(() => document.activeElement === field, 1500);
  const focusBack = document.activeElement === field;
  return { pass: open && location.href === url && panelForm().elements.copy.value === "title" && isDirty() && posts() === 0 && focusBack,
    open, url: location.search, focusBack, focus: document.activeElement?.name || document.activeElement?.className };
')"

check "nav click with changes opens the guard" "$(runj "$GUARD_OPEN"'
  const url = location.href;
  document.querySelector("nav a[href=\"/calendars\"]").click();
  await sleep(300);
  const open = dialog().open;
  await keep();
  return { pass: open && location.href === url && isDirty(), open };
')"

check "Escape with changes opens the guard" "$(runj "$GUARD_OPEN"'
  const url = location.href;
  document.querySelector("aside.detail .detail-title").focus();
  document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await sleep(300);
  const open = dialog().open;
  await keep();
  return { pass: open && location.href === url && isDirty(), open };
')"

# Escape on the guard itself is "Keep editing" too: a real key press, so the dialog's own cancel runs.
runj "$GUARD_OPEN"'document.querySelectorAll("a.list-row")[1].click(); await until(() => dialog().open, 3000); return { pass: dialog().open };' >/dev/null
ab press Escape >/dev/null 2>&1
check "Escape on the guard keeps editing and returns to the edited field" "$(runj "$GUARD_OPEN"'
  await until(() => !dialog().open, 2000);
  const field = panelForm().querySelector("input[name=copy][value=title]");
  await until(() => document.activeElement === field, 1500);
  return { pass: !dialog().open && isDirty() && document.activeElement === field,
    focus: document.activeElement?.name || document.activeElement?.className };
')"

check "history back with changes opens the guard and keeps the address" "$(runj "$GUARD_OPEN"'
  const url = location.href;
  window.__sameDoc = 1;
  history.back();
  await until(() => dialog().open, 3000);
  const open = dialog().open;
  await keep();
  await sleep(100);
  return { pass: open && location.href === url && isDirty() && window.__sameDoc === 1, open, url: location.search };
')"

check "Discard goes on without saving" "$(runj "$GUARD_OPEN"'
  countPosts();
  const target = document.querySelectorAll("a.list-row")[1].href;
  document.querySelectorAll("a.list-row")[1].click();
  await until(() => dialog()?.open, 3000);
  const m = dbg().merges;
  dialog().querySelector("[data-guard-discard]").click();
  await until(() => dbg().merges > m);
  return { pass: posts() === 0 && location.href === target && !isDirty(), posts: posts(), url: location.search };
')"

# Back to the first row; change the level; Save and continue to the second row.
runj 'const m = dbg().merges; document.querySelectorAll("a.list-row")[0].click(); await until(() => dbg().merges > m); return {pass:true};' >/dev/null
dirty
check "Save and continue saves once and lands on the target" "$(runj "$GUARD_OPEN"'
  countPosts();
  const first = location.href;
  const link = document.querySelectorAll("a.list-row")[1];
  const target = link.href;
  link.click();
  await until(() => dialog()?.open, 3000);
  const m = dbg().merges;
  dialog().querySelector("[data-guard-save]").click();
  await until(() => dbg().merges > m);
  await sleep(100);
  const row = [...document.querySelectorAll("a.list-row")].find((a) => a.href === first);
  return { pass: posts() === 1 && location.href === target && /Title/i.test(row.textContent) && !isDirty(),
    posts: posts(), url: location.search, firstRow: row.textContent.replace(/\s+/g, " ").trim() };
')"

# Put the first mirroring back to "Busy only".
check "level of the first mirroring put back" "$(runj '
  let m = dbg().merges;
  document.querySelectorAll("a.list-row")[0].click();
  await until(() => dbg().merges > m);
  const f = panelForm();
  f.querySelector("input[name=copy][value=busy]").click();
  m = dbg().merges;
  f.querySelector("[data-save]").click();
  await until(() => dbg().merges > m);
  return { pass: panelForm().elements.copy.value === "busy" && panelForm().elements.who.value === "private" && !isDirty() };
')"

# A required answer left open (a mixed-marks mirroring has no "What others see" checked) stops
# "Save" in the guard for a target outside the app pages before anything is sent; the person lands on the
# open question. POSTs are blocked here, so nothing is saved even if the check fails.
check "guard Save with a required answer open sends nothing and focuses the answer" "$(runj "$GUARD_OPEN"'
  const real = window.fetch;
  let sent = 0;
  window.fetch = (u, o = {}) => (o.method || "GET").toUpperCase() === "POST"
    ? (sent++, Promise.reject(new TypeError("blocked by the check"))) : real(u, o);
  const f = panelForm();
  // As the server marks a mirroring with mixed marks (`data-mixed`): mirroring.js then asks for
  // an answer (`required`) while a copied level is chosen.
  f.querySelector(".mx-who")?.setAttribute("data-mixed", "");
  for (const r of f.querySelectorAll("input[name=who]")) { r.required = true; r.checked = false; }
  f.querySelector("input[name=who]").dispatchEvent(new Event("change", { bubbles: true }));
  const url = location.href;
  window.slotmirror.visit("/privacy");
  await until(() => dialog()?.open, 3000);
  const asked = Boolean(dialog()?.open);
  dialog().querySelector("[data-guard-save]").click();
  await sleep(600);
  window.fetch = real;
  const a = document.activeElement;
  return { pass: asked && sent === 0 && !dialog().open && location.href === url && a?.name === "who" && isDirty(),
    asked, sent, focus: a?.name || a?.className, url: location.pathname };
')"
# A fresh panel: the check changed the form in the page only.
open_enhanced "$BASE/mirroring"
runj 'const m = dbg().merges; document.querySelectorAll("a.list-row")[0].click(); await until(() => dbg().merges > m); return {pass:true};' >/dev/null

# The leave dialog also stands in front of a Back whose page is in the history cache (review 6).
runj 'for (const i of [1, 0]) { const m = dbg().merges; document.querySelectorAll("a.list-row")[i].click(); await until(() => dbg().merges > m); await sleep(100); } return {pass:true};' >/dev/null
dirty
check "Back to a cached page with changes opens the guard first" "$(runj "$GUARD_OPEN"'
  const url = location.href;
  const hits = dbg().cacheHits;
  history.back();
  await until(() => dialog().open, 3000);
  const open = dialog().open;
  await keep();
  await sleep(100);
  return { pass: open && location.href === url && isDirty() && dbg().cacheHits === hits, open, url: location.search,
    cacheHits: dbg().cacheHits - hits };
')"
check "  ... and the same Back, clean, comes from the cache" "$(runj "$GUARD_OPEN"'
  document.querySelector("[data-discard]").click();
  await sleep(100);
  const hits = dbg().cacheHits;
  const m = dbg().merges;
  const target = document.querySelectorAll("a.list-row")[1].href;
  history.back();
  await until(() => dbg().merges > m, 3000);
  return { pass: !dialog()?.open && dbg().cacheHits === hits + 1 && location.href === target && !isDirty(),
    cacheHits: dbg().cacheHits - hits, url: location.search };
')"

report enh-guard
