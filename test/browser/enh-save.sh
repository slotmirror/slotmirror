#!/bin/zsh
# Enhanced saves on the first mirroring and the first calendar of the dev user: the dirty count
# after a save (with and without the default sync), one POST per save and per double click, a
# refused save, a failed fetch and a redirect out of the app pages. Prints JSON with pass/fail per check.
# Usage: test/browser/enh-save.sh [base-url]     (default http://localhost:8822)
# IT SAVES: it changes the level and the working-hours switch of the first mirroring and puts
# both back at the end. The refused save changes nothing.
BASE=${1:-http://localhost:8822}
ab() { agent-browser --session "${AB_SESSION:-enh}" "$@"; }
source "${0:A:h}/lib.sh"

ROW="$BASE/mirroring?d=sim-u-dev-2~sim-u-dev-1"
CAL="$BASE/calendars?c=sim-u-dev-1"
open_enhanced "$ROW" || { echo '{"pass":false,"error":"enhance did not load"}'; exit 1; }

# What the server rendered at the start, to put back at the end.
START=$(runj 'const f = panelForm(); return { pass: true, copy: f.elements.copy.value, who: f.elements.who.value,
  workHours: f.elements.workHours.checked };')

check "save with syncDefaults: one POST, no saved in URL, Saved shown, bar clean" "$(runj '
  countPosts();
  const f = panelForm();
  f.elements.workHours.click();
  const dirtyBefore = isDirty();
  const m = dbg().merges;
  f.querySelector("[data-save]").click();
  await until(() => dbg().merges > m);
  await sleep(150);
  const saved = document.querySelector("aside.detail [data-saved]");
  return { pass: dirtyBefore && posts() === 1 && !location.search.includes("saved") && Boolean(saved) && !saved.hidden &&
      !isDirty() && dirtyText() === "" && dbg().last.kind === "save" && !document.querySelector(".prop[data-changed]"),
    posts: posts(), url: location.search, saved: saved?.textContent.trim(), dirty: isDirty(), kind: dbg().last.kind,
    workHours: panelForm().elements.workHours.checked, ms: dbg().last.ms };
')"

check "save updates the list row (level) together with the panel" "$(runj '
  countPosts();
  const row = () => [...document.querySelectorAll("a.list-row")].find((a) => a.href === location.href);
  const before = row().textContent.replace(/\s+/g, " ").trim();
  const f = panelForm();
  f.querySelector("input[name=copy][value=title]").click();
  const m = dbg().merges;
  f.querySelector("[data-save]").click();
  await until(() => dbg().merges > m);
  await sleep(100);
  const after = row().textContent.replace(/\s+/g, " ").trim();
  return { pass: posts() === 1 && before !== after && panelForm().elements.copy.value === "title" && !isDirty(),
    before, after, posts: posts() };
')"

check "double click on Save sends one POST" "$(runj '
  countPosts();
  const f = panelForm();
  f.querySelector("input[name=copy][value=busy]").click();
  const m = dbg().merges;
  const save = f.querySelector("[data-save]");
  save.click();
  save.click();
  save.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  await until(() => dbg().merges > m);
  await sleep(300);
  return { pass: posts() === 1 && panelForm().elements.copy.value === "busy" && !isDirty(), posts: posts(),
    copy: panelForm().elements.copy.value };
')"

check "failed fetch on save keeps the input and shows the error note" "$(runj '
  const f = panelForm();
  f.querySelector("input[name=copy][value=title]").click();
  const real = window.fetch;
  window.fetch = () => Promise.reject(new TypeError("offline"));
  const m = dbg().merges;
  f.querySelector("[data-save]").click();
  const note = () => panelForm().querySelector("[data-save-error=failed]");
  await until(() => note() && !note().hidden, 4000);
  window.fetch = real;
  const out = { noteShown: Boolean(note() && !note().hidden), copy: panelForm().elements.copy.value, merges: dbg().merges - m,
    pending: panelForm().hasAttribute("data-pending"), stillDirty: isDirty(), url: location.search };
  panelForm().reset();
  await sleep(50);
  return { pass: out.noteShown && out.copy === "title" && out.merges === 0 && !out.pending && out.stillDirty &&
      !out.url.includes("saved"), ...out };
')"

check "a save answered from outside the app pages shows the session note, nothing saved" "$(runj '
  const f = panelForm();
  f.querySelector("input[name=copy][value=title]").click();
  const real = window.fetch;
  window.fetch = (u, o = {}) => real("/privacy", { credentials: "same-origin" });
  const m = dbg().merges;
  f.querySelector("[data-save]").click();
  const note = () => panelForm().querySelector("[data-save-error=session]");
  await until(() => note() && !note().hidden, 6000);
  window.fetch = real;
  const out = { noteShown: Boolean(note() && !note().hidden), copy: panelForm().elements.copy.value, merges: dbg().merges - m,
    saved: Boolean(document.querySelector("aside.detail [data-saved]:not([hidden])")), url: location.pathname };
  panelForm().reset();
  await sleep(50);
  return { pass: out.noteShown && out.copy === "title" && out.merges === 0 && !out.saved && out.url === "/mirroring", ...out };
')"

# Put the mirroring back as it was at the start (only if the start state was read).
RESTORE=$(runj "const start = $START; const f = panelForm();
  if (!start.copy) return { pass: false, error: 'no start state' };
  f.querySelector('input[name=copy][value=' + start.copy + ']').click();
  if (f.querySelector('input[name=who][value=' + start.who + ']')) f.querySelector('input[name=who][value=' + start.who + ']').click();
  if (f.elements.workHours.checked !== start.workHours) f.elements.workHours.click();
  if (isDirty()) { const m = dbg().merges; f.querySelector('[data-save]').click(); await until(() => dbg().merges > m); await sleep(100); }
  const g = panelForm();
  return { pass: g.elements.copy.value === start.copy && g.elements.who.value === start.who &&
    g.elements.workHours.checked === start.workHours && !isDirty(), copy: g.elements.copy.value, who: g.elements.who.value,
    workHours: g.elements.workHours.checked };")
check "mirroring put back to the start state" "$RESTORE"

open_enhanced "$CAL"
# Bug (a) of the speed plan. Idiomorph copies the `checked` and `value` attributes of every field
# except the focused one (`ignoreActiveValue`): a save with Cmd+Enter in a text field keeps its old
# `value` attribute, so the saved text still counts as a change. Turning the default sync off once
# shows that the fix matters; with it on, the bar is clean.
keyboard_save() {
  runj "dbg().syncDefaults = $1;
  const f = panelForm();
  const name = f.elements.name;
  name.focus();
  name.value = $2;
  name.dispatchEvent(new Event('input', { bubbles: true }));
  const m = dbg().merges;
  name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true }));
  await until(() => dbg().merges > m);
  await sleep(150);
  const g = panelForm().elements.name;
  const out = { kind: dbg().last.kind, dirty: isDirty(), count: dirtyText(), value: g.value, defaultValue: g.defaultValue,
    focused: document.activeElement === g || document.activeElement.id };
  dbg().syncDefaults = true;
  return out;"
}
ORIGINAL=$(runj 'return { name: panelForm().elements.name.value };' | jq -r .name)
BUG=$(keyboard_save false "'$ORIGINAL x'")
# Since review 6 (M2) a save no longer keeps the focused field's old value, so the merge alone
# also ends clean; syncDefaults stays for the attributes that Idiomorph leaves.
check "without syncDefaults a keyboard save also ends clean (the focused field follows the server)" \
  "$(jq -c '. + {pass: (.kind == "save" and .dirty == false)}' <<<"$BUG")"
open_enhanced "$CAL"
FIXED=$(keyboard_save true "'$ORIGINAL'")
check "with syncDefaults the bar is clean after the same save (and the name is back)" \
  "$(jq -c --arg o "$ORIGINAL" '. + {pass: (.kind == "save" and .dirty == false and .count == "" and .value == $o and .defaultValue == $o)}' <<<"$FIXED")"
check "refused save keeps the input, stays on the entry, focuses the error" "$(runj '
  countPosts();
  const f = panelForm();
  const name = f.elements.name;
  const typed = name.value + " refused-test";
  name.value = typed;
  name.dispatchEvent(new Event("input", { bubbles: true }));
  const radio = f.querySelector("input[name=color]:not(:checked)");
  radio.value = "bogus";
  radio.click();
  const url = location.href;
  const length = history.length;
  const m = dbg().merges;
  f.querySelector("[data-save]").click();
  await until(() => dbg().merges > m);
  await sleep(100);
  const danger = document.querySelector("aside.detail .notice-danger");
  const a = document.activeElement;
  // The refused input is the default of the panel now; the bar keeps the count of the server.
  const refusedCount = Number(document.querySelector("aside.detail [data-savebar]")?.dataset.refusedCount);
  const count = dirtyText();
  return { pass: posts() === 1 && dbg().last.kind === "refused" && location.href === url && history.length === length &&
      Boolean(danger) && (a === danger || a.getAttribute("aria-invalid") === "true") && panelForm().elements.name.value === typed &&
      refusedCount > 0 && count.includes(String(refusedCount)),
    kind: dbg().last.kind, error: danger?.textContent.trim(), active: a.className || a.name, name: panelForm().elements.name.value,
    refusedCount, count };
')"
# After a refusal the count is against what is stored (review 10, minor 7): the leave dialog says
# the refused count, and one more edit adds to it.
check "after a refused save the leave dialog and one more edit count against the stored values" "$(runj '
  const bar = document.querySelector("aside.detail [data-savebar]");
  const n = Number(bar.dataset.refusedCount);
  [...document.querySelectorAll("a.row-open")].find((a) => !a.href.includes("sim-u-dev-1")).click();
  await sleep(300);
  const dialog = document.querySelector("aside.detail dialog[data-guard]");
  const title = dialog?.querySelector("[data-guard-title]")?.textContent ?? "";
  dialog?.querySelector("[data-guard-keep]")?.click();
  await sleep(100);
  const sw = panelForm().elements.workHoursOn;
  sw.click();
  const more = dirtyText();
  sw.click();
  const back = dirtyText();
  // With the field names from the server (`data-refused-fields`), a refused field edited again
  // still counts once. The server does not send them yet: set here to test the rule.
  bar.dataset.refusedFields = "name color";
  const name = panelForm().elements.name;
  const was = name.value;
  name.value = was + "!";
  name.dispatchEvent(new Event("input", { bubbles: true }));
  const again = dirtyText();
  name.value = was;
  name.dispatchEvent(new Event("input", { bubbles: true }));
  delete bar.dataset.refusedFields;
  return { pass: n > 0 && title.includes(String(n)) && more.includes(String(n + 1)) && back.includes(String(n)) &&
      n === 2 && again.includes("2"), n, title, more, back, again };
')"
# M1 of review 6: the refused input is not stored, so the panel stays unsaved: a row click asks,
# Keep stays, and Discard loads the stored values again (a reset would return to the draft).
# The name field keeps the focus (Keep editing returns there; Safari does not focus a clicked
# button), and the stored page answers at once: the merge comes before the browser's next
# rendering step, which is when an inert panel loses its focus. Without the blur in `go()` the
# merge kept the focused field's refused value (it failed about 1 run in 5 with a real fetch).
check "after a refused save leaving asks; Keep stays; Discard shows the stored name, clean" "$(runj '
  const typed = panelForm().elements.name.value;
  const url = location.href;
  const m = dbg().merges;
  [...document.querySelectorAll("a.row-open")].find((a) => !a.href.includes("sim-u-dev-1")).click();
  await sleep(300);
  const dialog = document.querySelector("aside.detail dialog[data-guard]");
  const asked = Boolean(dialog?.open);
  if (asked) dialog.querySelector("[data-guard-keep]").click();
  await sleep(100);
  const kept = location.href === url && panelForm().elements.name.value === typed && dbg().merges === m;
  const stored = await (await fetch(location.href, { credentials: "same-origin" })).text();
  const real = window.fetch;
  window.fetch = (u, o = {}) => {
    if ((o.method || "GET").toUpperCase() !== "GET") return real(u, o);
    window.fetch = real;
    return Promise.resolve(new Response(stored, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }));
  };
  panelForm().elements.name.focus();
  const focused = document.activeElement === panelForm().elements.name;
  panelForm().querySelector("[data-discard]").click();
  await until(() => dbg().merges > m);
  window.fetch = real;
  await sleep(150);
  const name = panelForm().elements.name;
  return { pass: asked && kept && focused && dbg().merges === m + 1 && dbg().last.kind === "refresh" &&
      !name.value.includes("refused-test") && name.value === name.defaultValue && !isDirty() &&
      !document.querySelector("[data-refused]") && location.href === url,
    asked, kept, focused, kind: dbg().last.kind, name: name.value, dirty: isDirty(), url: location.search };
')"
# Nothing was saved: a fresh page shows the old name.
ab open "$CAL" >/dev/null 2>&1
check "refused save changed nothing on the server" "$(runj '
  return { pass: !panelForm().elements.name.value.includes("refused-test"), name: panelForm().elements.name.value };
')"

# L10 of review 6: the server stored the save, but the page after its redirect failed (500 here,
# faked in the page). The bar says "Saved" with a reload hint, the panel is clean, a leave asks
# nothing. The name is put back afterwards.
open_enhanced "$CAL"
NAME0=$(runj 'return { name: panelForm().elements.name.value };' | jq -r .name)
NAMEJ=$(jq -Rn --arg n "$NAME0" '$n')
check "a stored save whose page fails says saved, panel clean, leave asks nothing" "$(runj "
  const real = window.fetch;
  window.fetch = async (u, o = {}) => {
    const res = await real(u, o);
    if ((o.method || 'GET').toUpperCase() !== 'POST') return res;
    window.fetch = real;
    const fake = new Response(document.documentElement.outerHTML, { status: 500, headers: { 'content-type': 'text/html' } });
    Object.defineProperty(fake, 'url', { value: res.url });
    Object.defineProperty(fake, 'redirected', { value: res.redirected });
    return fake;
  };
  const f = panelForm();
  window.__v0 = f.elements.v?.value;
  f.elements.name.value = $NAMEJ + ' x';
  f.elements.name.dispatchEvent(new Event('input', { bubbles: true }));
  f.querySelector('[data-save]').click();
  const note = () => document.querySelector('aside.detail [data-save-error=stale]');
  await until(() => note() && !note().hidden, 5000);
  const shown = Boolean(note() && !note().hidden);
  const passed = document.dispatchEvent(new CustomEvent('enhance:before-visit', { bubbles: true, cancelable: true,
    detail: { url: location.origin + '/', method: 'get', kind: 'api', form: null, resume: () => {} } }));
  const guard = document.querySelector('aside.detail dialog[data-guard]');
  const asked = Boolean(guard?.open);
  if (asked) guard.close();
  const stored = new DOMParser().parseFromString(await (await real(location.href)).text(), 'text/html')
    .querySelector('#detail-form [name=name]')?.getAttribute('value');
  return { pass: shown && dirtyText() === '' && passed && !asked && stored === $NAMEJ + ' x',
    shown, text: note()?.textContent?.trim(), count: dirtyText(), asked, stored };
")"
# The page after the stored save failed, so the form still had the old version: the script takes
# the version of the stored state, and the next save is not refused as a conflict (minor 5).
check "the next save after it goes through, not as a conflict" "$(runj "
  const f = panelForm();
  await until(() => f.elements.v?.value && f.elements.v.value !== window.__v0, 5000);
  const fresh = f.elements.v?.value !== window.__v0;
  f.elements.name.value = $NAMEJ;
  f.elements.name.dispatchEvent(new Event('input', { bubbles: true }));
  const m = dbg().merges;
  f.querySelector('[data-save]').click();
  await until(() => dbg().merges > m);
  await sleep(100);
  return { pass: fresh && dbg().last.kind === 'save' && panelForm().elements.name.value === $NAMEJ,
    fresh, kind: dbg().last.kind, name: panelForm().elements.name.value };
")"
open_enhanced "$CAL"
check "name put back after L10" "$(runj "
  const f = panelForm();
  if (f.elements.name.value === $NAMEJ) return { pass: true };
  f.elements.name.value = $NAMEJ;
  f.elements.name.dispatchEvent(new Event('input', { bubbles: true }));
  const m = dbg().merges;
  f.querySelector('[data-save]').click();
  await until(() => dbg().merges > m);
  await sleep(100);
  return { pass: panelForm().elements.name.value === $NAMEJ && !isDirty(), name: panelForm().elements.name.value };
")"

report enh-save
