#!/bin/zsh
# The panel script WITHOUT enhance.js, as the app loads it today: focus, save bar, Discard, guard,
# Escape, Cmd+Enter, one submit, "Saved" and the working-hours fields of a calendar.
# Prints one JSON object with pass/fail per check.
# Usage: test/browser/panel-plain.sh [base-url]     (default http://localhost:8822)
# IT SAVES the working-hours switch of the first mirroring twice (off, then back on).
BASE=${1:-http://localhost:8822}
ab() { agent-browser --session "${AB_SESSION:-enh}" "$@"; }
source "${0:A:h}/lib.sh"

ROW="$BASE/mirroring?d=sim-u-dev-2~sim-u-dev-1"
open_plain "$ROW" || { echo '{"pass":false,"error":"plain mode did not start"}'; exit 1; }

check "heading focused on load, bar hidden, Discard shown, no enhance" "$(runj '
  return { pass: document.activeElement.id === "detail-title" && !isDirty() && !window.slotmirror &&
      document.documentElement.classList.contains("js") && getComputedStyle(document.querySelector(".detail-foot")).display === "none" &&
      !document.querySelector("[data-discard]").hidden, active: document.activeElement.id };
')"

check "a change counts, Discard resets" "$(runj '
  const f = panelForm();
  f.querySelector("input[name=copy][value=title]").click();
  const counted = isDirty() && dirtyText() !== "";
  const dot = Boolean(f.querySelector("input[name=copy]").closest(".prop[data-fields]")?.hasAttribute("data-changed"));
  const warn = document.querySelector(".savebar-notes").classList.contains("is-warn");
  document.querySelector("[data-discard]").click();
  await sleep(50);
  const dotAfter = document.querySelectorAll(".prop[data-changed]").length;
  return { pass: counted && dot && dotAfter === 0 && !isDirty() && panelForm().elements.copy.value === "busy", counted, warn, dot, dotAfter };
')"

check "row click with changes opens the guard; Keep stays" "$(runj '
  const f = panelForm();
  f.querySelector("input[name=copy][value=title]").click();
  const url = location.href;
  document.querySelectorAll("a.list-row")[1].click();
  await sleep(200);
  const dialog = document.querySelector("dialog[data-guard]");
  const open = dialog.open;
  const title = dialog.querySelector("[data-guard-title]").textContent;
  dialog.querySelector("[data-guard-keep]").click();
  await sleep(50);
  return { pass: open && title !== "" && location.href === url && isDirty(), open, title };
')"

check "Escape with changes opens the guard" "$(runj '
  document.querySelector(".detail-title").focus();
  document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await sleep(200);
  const dialog = document.querySelector("dialog[data-guard]");
  const open = dialog.open;
  dialog.querySelector("[data-guard-keep]").click();
  panelForm().reset();
  await sleep(50);
  return { pass: open && !isDirty(), open };
')"

check "arrow keys move between list rows" "$(runj '
  const rows = [...document.querySelectorAll(".list a.list-row")];
  rows[0].focus();
  rows[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  return { pass: document.activeElement === rows[1] };
')"

# Cmd+Enter saves as a normal form post; a second submit before the answer is dropped.
ab eval '(() => { const f = document.querySelector("aside.detail form.detail-form");
  window.__posts = 0;
  f.elements.workHours.click();
  document.querySelector(".detail-title").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, ctrlKey: true, bubbles: true, cancelable: true }));
  const second = new SubmitEvent("submit", { bubbles: true, cancelable: true });
  f.dispatchEvent(second);
  window.__secondPrevented = second.defaultPrevented;
  sessionStorage.setItem("plainSecond", String(second.defaultPrevented));
  return 1; })()' >/dev/null 2>&1
sleep 2
wait_for 'document.readyState === "complete" && document.querySelector("aside.detail [data-saved]")'
check "Cmd+Enter saves (full load), second submit dropped, Saved shown, saved stripped" "$(runj '
  const saved = document.querySelector("aside.detail [data-saved]");
  return { pass: sessionStorage.getItem("plainSecond") === "true" && Boolean(saved) && !location.search.includes("saved") &&
      panelForm().elements.workHours.checked === false && !isDirty(), saved: saved?.textContent.trim(), url: location.search };
')"

# The note was in the page from the start, which a screen reader does not read out: the live
# region of the shell says "Saved", and the note itself is no live region.
check "after a full load the live region says Saved, the note is no live region" "$(runj '
  const box = document.getElementById("announcer");
  await until(() => box.textContent.trim() !== "");
  const saved = document.querySelector("aside.detail [data-saved]");
  return { pass: box.textContent.trim() === box.dataset.msgSaved && !saved.closest("[role=status], [aria-live]"),
    said: box.textContent.trim(), role: saved.getAttribute("role") };
')"

# Put the switch back.
ab eval '(() => { const f = document.querySelector("aside.detail form.detail-form"); f.elements.workHours.click(); f.querySelector("[data-save]").click(); return 1; })()' >/dev/null 2>&1
sleep 2
wait_for 'document.readyState === "complete" && document.querySelector("aside.detail form.detail-form")'
check "switch put back" "$(runj 'return { pass: panelForm().elements.workHours.checked === true && !isDirty() };')"

ab open "$BASE/calendars?c=sim-u-dev-1" >/dev/null 2>&1
check "calendar panel: hours fields follow the switch, reset restores" "$(runj '
  const f = panelForm();
  const fields = f.querySelector("[data-hours-fields]");
  const shownBefore = !fields.hidden;
  f.elements.workHoursOn.click();
  const hiddenAfter = fields.hidden;
  f.reset();
  await sleep(50);
  return { pass: shownBefore && hiddenAfter && !fields.hidden && !isDirty(), shownBefore, hiddenAfter };
')"

# M1 of review 6 in plain mode: the 400 page renders the refused input as the defaults. Leaving
# must still ask, and Discard loads the stored values (normal loads, so steps between the evals).
ab eval '(() => { const f = document.querySelector("aside.detail form.detail-form");
  sessionStorage.setItem("plainName", f.elements.name.value);
  f.elements.name.value += " refused-test"; f.elements.name.dispatchEvent(new Event("input", { bubbles: true }));
  const r = f.querySelector("input[name=color]:not(:checked)"); r.value = "bogus"; r.click();
  f.querySelector("[data-save]").click(); return 1; })()' >/dev/null 2>&1
sleep 2
wait_for 'document.readyState === "complete" && document.querySelector("aside.detail .notice-danger")'
check "refused save (plain): leaving asks, Keep stays" "$(runj '
  const typed = panelForm().elements.name.value;
  document.querySelectorAll("a.row-open")[1].click();
  await sleep(200);
  const dialog = document.querySelector("aside.detail dialog[data-guard]");
  const asked = Boolean(dialog?.open);
  if (asked) dialog.querySelector("[data-guard-keep]").click();
  let unload = null;
  addEventListener("beforeunload", (e) => (unload = e), { once: true });
  window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
  return { pass: asked && typed.includes("refused-test") && panelForm().elements.name.value === typed && unload?.defaultPrevented === true,
    asked, typed, beforeunload: unload?.defaultPrevented };
')"
ab eval '(() => { document.querySelector("aside.detail [data-discard]").click(); return 1; })()' >/dev/null 2>&1
sleep 2
wait_for 'document.readyState === "complete" && document.querySelector("aside.detail form.detail-form") && !document.querySelector(".notice-danger")'
check "  ... Discard loads the stored name, nothing asked, clean" "$(runj '
  const name = panelForm().elements.name;
  return { pass: name.value === sessionStorage.getItem("plainName") && !isDirty() && !document.querySelector("[data-refused]"),
    name: name.value, url: location.href };
')"

# A conflict without enhance.js (review 10, minor 6): another client renames the calendar with the
# version of this page; this page's normal Save gets the 409 page, which puts the focus on the
# conflict notice and says it. The name is put back afterwards.
CAL="$BASE/calendars?c=sim-u-dev-1"
open_plain "$CAL" || { echo '{"pass":false,"error":"plain mode did not start"}'; exit 1; }
CNAME=$(runj 'return { name: panelForm().elements.name.value };' | jq -r .name)
CNAMEJ=$(jq -Rn --arg n "$CNAME" '$n')
runj "const f = panelForm();
  const body = new URLSearchParams(new FormData(f));
  body.set('name', $CNAMEJ + ' other');
  body.delete('back');
  const res = await fetch(f.action, { method: 'POST', body, credentials: 'same-origin' });
  f.elements.name.value = $CNAMEJ + ' mine';
  f.elements.name.dispatchEvent(new Event('input', { bubbles: true }));
  sessionStorage.setItem('plainConflict', '1');
  f.querySelector('[data-save]').click();
  return { pass: res.redirected };" >/dev/null
sleep 2
wait_for 'document.readyState === "complete" && document.querySelector("aside.detail [data-conflict]")'
check "plain mode: a 409 page focuses the conflict notice and says it" "$(runj '
  await sleep(300);
  const note = document.querySelector("aside.detail [data-conflict]");
  const said = document.getElementById("announcer")?.textContent ?? "";
  return { pass: !window.slotmirror && Boolean(note) && document.activeElement === note && said.trim() === note.textContent.trim(),
    focus: document.activeElement?.id || document.activeElement?.className, said: said.slice(0, 50) };
')"
open_plain "$CAL"
check "  ... name put back" "$(runj "
  const f = panelForm();
  if (f.elements.name.value === $CNAMEJ) return { pass: true };
  const body = new URLSearchParams(new FormData(f));
  body.set('name', $CNAMEJ);
  body.delete('back');
  const res = await fetch(f.action, { method: 'POST', body, credentials: 'same-origin' });
  return { pass: res.redirected, status: res.status };
")"
check "  ... stored name is the start name" "$(runj "
  const doc = new DOMParser().parseFromString(await (await fetch('/calendars?c=sim-u-dev-1')).text(), 'text/html');
  const v = doc.querySelector('#detail-form [name=name]')?.getAttribute('value');
  return { pass: v === $CNAMEJ, name: v };
")"

report panel-plain
