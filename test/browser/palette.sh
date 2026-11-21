#!/bin/zsh
# The command palette and the keyboard shortcuts (public/next/palette.js), in the mode of the run
# (MODE=on: enhanced navigation; MODE=off: plain page loads). Real key presses through
# agent-browser. Prints one JSON object with pass/fail per check.
# Usage: MODE=on|off test/browser/palette.sh [base-url]     (default http://localhost:8822)
# It saves nothing. It changes the first mirroring's panel without saving and resets it, switches
# the theme to dark and back, and turns the single-key switch off and on again.
BASE=${1:-http://localhost:8822}
MODE=${MODE:-on}
ab() { agent-browser --session "${AB_SESSION:-pal}" "$@"; }
source "${0:A:h}/lib.sh"
# A fresh tab: one at Chrome's cap of 50 history entries goes back past scripted entries.
ab close >/dev/null 2>&1

MOD=Meta
ROW="$BASE/mirroring?d=sim-u-dev-2~sim-u-dev-1"
open_mode "$BASE/mirroring" || { echo '{"pass":false,"error":"mode did not start"}'; exit 1; }
[[ $(evalj 'document.documentElement.dataset.platform') == other ]] && MOD=Control
runj 'localStorage.removeItem("slotmirror-recent"); localStorage.removeItem("slotmirror-single-keys"); return {pass:true};' >/dev/null
THEME=$(evalj 'localStorage.getItem("slotmirror-theme") || "system"')

# keys(...): key presses on the focused element, one after the other within milliseconds.
KEYS='const keys = (...ks) => { for (const k of ks) document.activeElement.dispatchEvent(new KeyboardEvent("keydown",
    { key: k, bubbles: true, cancelable: true, shiftKey: k === "?" })); };'
PAL='const pal = () => document.querySelector("#palette");
  const box = () => pal().querySelector("input");
  const act = () => document.getElementById(box().getAttribute("aria-activedescendant") || "-");'

check "no destructive item, trigger hidden without the js class" "$(runj "$PAL"'
  const texts = [...pal().querySelectorAll("[role=option]")].map((o) => o.textContent);
  const bad = texts.filter((x) => /sign out|delete|abmelden|löschen/i.test(x));
  const forms = [...pal().querySelectorAll("form")].map((f) => f.getAttribute("action"));
  document.documentElement.classList.remove("js");
  const hidden = getComputedStyle(document.querySelector(".palette-trigger")).display === "none";
  document.documentElement.classList.add("js");
  return { pass: texts.length > 10 && bad.length === 0 && forms.every((a) => a === "/calendars/refresh") && hidden,
    count: texts.length, bad, forms, hidden };
')"

document_focus='document.querySelector(".page-title").focus(); return {pass:true};'
runj "$document_focus" >/dev/null
ab press "$MOD+k" >/dev/null
check "Cmd/Ctrl+K opens the palette with the first option active" "$(runj "$PAL"'
  await until(() => pal().open, 2000);
  return { pass: pal().open && document.activeElement === box() && act()?.getAttribute("href") === "/",
    open: pal().open, active: act()?.textContent };
')"

ab press Escape >/dev/null
check "Escape closes and returns the focus" "$(runj "$PAL"'
  await until(() => !pal().open, 2000);
  return { pass: !pal().open && document.activeElement.classList.contains("page-title"), focus: document.activeElement.className };
')"

runj "$document_focus" >/dev/null
ab press "$MOD+k" >/dev/null
check "the empty palette shows pages and actions only, rows carry their identity and kind" "$(runj "$PAL"'
  await until(() => pal().open, 2000);
  const shown = [...pal().querySelectorAll(".pg:not([hidden])")].map((g) => g.getAttribute("aria-labelledby"));
  const mir = pal().querySelector("[role=option][href*=\"/mirroring?d=sim-u-dev-\"]");
  const cal = pal().querySelector("[role=option][href=\"/calendars?c=sim-u-dev-2\"]");
  const mark = mir?.querySelector(".po-id .lmark");
  const swatch = cal?.querySelector(".po-id .cal-swatch rect");
  const fill = swatch ? getComputedStyle(swatch).fill : "";
  const r = { shown, level: mir?.dataset.level, markLevel: mark?.dataset.level, fill,
    glyph: Boolean(cal?.querySelector(".po-id .pglyph")), kind: mir?.querySelector(".po-kind")?.textContent,
    hiddenName: mir?.querySelector(".po-id")?.getAttribute("aria-hidden") };
  r.pass = JSON.stringify(shown) === JSON.stringify(["pg-pages", "pg-actions"]) && Boolean(mark) &&
    r.markLevel === r.level && /rgb|oklab|color/.test(fill) && r.glyph && Boolean(r.kind) && r.hiddenName === "true";
  return r;
')"
ab press Escape >/dev/null

# The query that is a calendar's name puts that calendar first, before the mirrorings that start
# with it (review 8, F).
CAL2=$(evalj 'document.querySelector("#palette [role=option][href=\"/calendars?c=sim-u-dev-2\"] .po-label").textContent')
runj "$document_focus" >/dev/null
ab press "$MOD+k" >/dev/null
ab type "#palette input" "$CAL2" >/dev/null
check "a calendar's name ranks that calendar first" "$(runj "$PAL"'
  await sleep(400);
  const groups = [...pal().querySelectorAll(".pg:not([hidden])")].map((g) => g.getAttribute("aria-labelledby"));
  return { pass: act()?.getAttribute("href") === "/calendars?c=sim-u-dev-2", active: act()?.textContent, groups };
')"
ab press Escape >/dev/null

runj 'const i = document.createElement("input"); i.id = "pal-probe"; document.querySelector(".content").prepend(i); i.focus(); return {pass:true};' >/dev/null
ab press "$MOD+k" >/dev/null
check "Cmd/Ctrl+K opens from inside a text field" "$(runj "$PAL"'
  await until(() => pal().open, 2000);
  return { pass: pal().open, open: pal().open };
')"
ab press Escape >/dev/null

# Real key presses (agent-browser's `type` inserts text without key events).
runj 'document.querySelector("#pal-probe").focus(); return {pass:true};' >/dev/null
for key in g c "Shift+?"; do ab press "$key" >/dev/null; done
check "single keys do nothing in a text field" "$(runj "$PAL$KEYS"'
  keys("g", "c", "?");
  await sleep(1000);
  const probe = document.querySelector("#pal-probe");
  const r = { pass: location.pathname === "/mirroring" && probe?.value === "gc?" && !document.querySelector("#shortcuts").open,
    path: location.pathname, value: probe?.value };
  probe?.remove();
  return r;
')"

runj "$document_focus" >/dev/null
ab press "$MOD+k" >/dev/null
ab type "#palette input" "konto 2 konto 1" >/dev/null
check "a query ranks the mirroring first and announces the count" "$(runj "$PAL"'
  await sleep(500);
  const label = act()?.querySelector(".po-label")?.textContent;
  const count = pal().querySelector("[data-count]").textContent;
  return { pass: act()?.getAttribute("href") === "/mirroring?d=sim-u-dev-2~sim-u-dev-1" && /\d/.test(count),
    label, count };
')"

check "arrows move the active option and wrap" "$(runj "$PAL"'
  const first = act();
  box().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
  const last = act();
  box().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  return { pass: last !== first && act() === first && last.getAttribute("aria-selected") !== "true" && first.getAttribute("aria-selected") === "true" };
')"

runj 'window.__palMark = 1; return {pass:true};' >/dev/null
ab press Enter >/dev/null
check "Enter opens the mirroring's panel ($MODE)" "$(runj "$PAL"'
  await until(() => document.querySelector("aside.detail form.detail-form") && location.search.includes("sim-u-dev-2~sim-u-dev-1"), 6000);
  const kept = window.__palMark === 1;
  const wantKept = '"$([[ $MODE == on ]] && echo true || echo false)"';
  return { pass: Boolean(panelForm()) && !pal().open && kept === wantKept, kept, url: location.search };
')"

runj "$document_focus" >/dev/null
ab press "$MOD+k" >/dev/null
check "the recent option shows first, as an address only" "$(runj "$PAL"'
  await until(() => pal().open, 2000);
  const group = pal().querySelector("[data-recent]");
  const stored = localStorage.getItem("slotmirror-recent");
  return { pass: !group.hidden && group.querySelector("[role=option]")?.getAttribute("href") === "/mirroring?d=sim-u-dev-2~sim-u-dev-1" &&
      act()?.closest("[data-recent]") === group && !/konto/i.test(stored), stored };
')"
ab type "#palette input" "dark" >/dev/null
ab press Enter >/dev/null
check "the theme item switches the theme" "$(runj "$PAL"'
  await sleep(200);
  return { pass: document.documentElement.dataset.theme === "dark" && !pal().open && localStorage.getItem("slotmirror-theme") === "dark",
    theme: document.documentElement.dataset.theme };
')"
runj "$document_focus" >/dev/null
ab press "$MOD+k" >/dev/null
check "the current theme carries a check" "$(runj "$PAL"'
  await until(() => pal().open, 2000);
  const opts = [...pal().querySelectorAll("[data-action^=\"theme:\"]")];
  const state = Object.fromEntries(opts.map((o) => [o.dataset.action, o.getAttribute("aria-checked") + "/" + !o.querySelector(".po-check").hidden]));
  return { pass: state["theme:dark"] === "true/true" && state["theme:light"] === "false/false" && state["theme:system"] === "false/false", state };
')"
ab press Escape >/dev/null
runj "localStorage.setItem('slotmirror-theme', '$THEME'); document.querySelector('#user-menu [data-theme-choice=\"$THEME\"]').click(); return {pass:true};" >/dev/null

# The unsaved-changes guard: a palette choice is a leave like a link click.
runj 'panelForm().querySelector("input[name=copy][value=title]").click(); return { pass: isDirty() };' >/dev/null
ab press "$MOD+k" >/dev/null
ab type "#palette input" "calendars" >/dev/null
runj 'countPosts(); return {pass:true};' >/dev/null
ab press Enter >/dev/null
check "a palette choice with a dirty panel opens the guard" "$(runj "$PAL"'
  const guard = () => document.querySelector("aside.detail dialog[data-guard]");
  await until(() => guard()?.open, 3000);
  const open = guard()?.open;
  const url = location.pathname + location.search;
  guard()?.querySelector("[data-guard-keep]")?.click();
  await sleep(100);
  const stillDirty = isDirty();
  document.querySelector("[data-discard]")?.click();
  await sleep(100);
  return { pass: Boolean(open) && url === "/mirroring?d=sim-u-dev-2~sim-u-dev-1" && stillDirty && !isDirty() && posts() === 0,
    open, url, stillDirty };
')"

# "Open account menu" finds sign out and delete words, and only opens the menu.
runj "$document_focus" >/dev/null
ab press "$MOD+k" >/dev/null
ab type "#palette input" "abmelden" >/dev/null
runj 'countPosts(); window.__palMenu = location.href; return {pass:true};' >/dev/null
ab press Enter >/dev/null
check "the account menu option opens the menu and nothing else" "$(runj "$PAL"'
  const menu = document.querySelector("#user-menu");
  await until(() => menu.matches(":popover-open"), 2000);
  const r = { pass: menu.matches(":popover-open") && !pal().open && posts() === 0 && location.href === window.__palMenu &&
      menu.contains(document.activeElement), focus: document.activeElement?.textContent?.trim() };
  menu.hidePopover();
  return r;
')"

# j and k move between the rows of a list.
runj 'document.querySelectorAll(".list a.list-row")[0].focus(); return {pass:true};' >/dev/null
ab press j >/dev/null
J=$(runj 'const rows = [...document.querySelectorAll(".list a.list-row")]; return { pass: document.activeElement === rows[1], at: rows.indexOf(document.activeElement) };')
ab press k >/dev/null
check "j and k move between list rows" "$(runj 'const rows = [...document.querySelectorAll(".list a.list-row")];
  const j = '"$J"';
  return { pass: j.pass && document.activeElement === rows[0], j: j.at, k: rows.indexOf(document.activeElement) };')"

runj "$document_focus" >/dev/null
ab press "Shift+?" >/dev/null
check "? opens the shortcut sheet" "$(runj '
  await until(() => document.querySelector("#shortcuts").open, 2000);
  return { pass: document.querySelector("#shortcuts").open && document.querySelectorAll("#shortcuts .sheet-row").length >= 8 };
')"
ab press Escape >/dev/null

runj "$document_focus" >/dev/null
ab press g >/dev/null
ab press m >/dev/null
check "g then m goes to Mirroring" "$(runj '
  await until(() => location.pathname === "/mirroring" && !location.search, 6000);
  return { pass: location.pathname === "/mirroring" && !location.search, url: location.pathname + location.search };
')"

runj "$document_focus" >/dev/null
ab press g >/dev/null
ab press c >/dev/null
runj 'await until(() => location.pathname === "/calendars" && document.readyState === "complete", 6000); return {pass:true};' >/dev/null
check "the single-key switch turns g sequences and ? off" "$(runj '
  const box = document.querySelector("[data-single-keys]");
  const wasOn = box.checked;
  box.click();
  return { pass: wasOn && !box.checked && localStorage.getItem("slotmirror-single-keys") === "off", wasOn };
')"
# The keys of a sequence go in one call, within milliseconds: two separate key presses can be more
# than 1 s apart under load, and a "nothing happened" check would then pass without testing.
runj "$document_focus" >/dev/null
check "with the switch off, g a and ? do nothing" "$(runj "$KEYS"'
  keys("g", "a", "?");
  await sleep(1200);
  return { pass: location.pathname === "/calendars" && !document.querySelector("#shortcuts").open, url: location.pathname };
')"
runj 'document.querySelectorAll(".list a.row-open")[0].focus(); return {pass:true};' >/dev/null
ab press j >/dev/null
check "with the switch off, j does not move between rows; the arrow does" "$(runj '
  const rows = [...document.querySelectorAll(".list a.row-open")];
  const afterJ = rows.indexOf(document.activeElement);
  rows[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  const afterArrow = rows.indexOf(document.activeElement);
  const box = document.querySelector("[data-single-keys]");
  if (!box.checked) box.click();
  return { pass: afterJ === 0 && afterArrow === 1, afterJ, afterArrow, restored: localStorage.getItem("slotmirror-single-keys") === "on" };
')"

# Blocked storage (review 6, L6): the switch still turns single keys off, for this page.
runj "$document_focus" >/dev/null
check "with blocked storage the switch still turns g sequences off" "$(runj '
  const desc = Object.getOwnPropertyDescriptor(window, "localStorage");
  Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new DOMException("blocked", "SecurityError"); } });
  window.__restoreStorage = () => Object.defineProperty(window, "localStorage", desc);
  let blocked = false;
  try { localStorage.getItem("x"); } catch { blocked = true; }
  const box = document.querySelector("[data-single-keys]");
  box.click();
  document.querySelector(".page-title").focus();
  return { pass: blocked && !box.checked, blocked };
')"
check "  ... g o does nothing" "$(runj "$KEYS"'
  keys("g", "o");
  await sleep(1200);
  const r = { pass: location.pathname === "/calendars", url: location.pathname };
  window.__restoreStorage();
  const box = document.querySelector("[data-single-keys]");
  box.click();
  return { ...r, restored: localStorage.getItem("slotmirror-single-keys") === "on" && box.checked };
')"

report palette
