#!/bin/zsh
# Edge cases of enhanced navigation: an edit while a save is on its way, a save that times out
# (15 s) and its late answer, an answer of a new deploy (asset version) with a clean and a dirty
# panel, a stylesheet that does not load, popovers across a merge, back and forward across pages
# with a dirty panel, and clicks during a view transition.
# Prints one JSON object with pass/fail per check.
# Usage: test/browser/enh-edge.sh [base-url]     (default http://localhost:8822)
# IT SAVES: the working-hours switch of the first mirroring (on, off again: the start state comes
# back). The other checks change nothing on the server.
BASE=${1:-http://localhost:8822}
ab() { agent-browser --session "${AB_SESSION:-enh}" "$@"; }
source "${0:A:h}/lib.sh"

ROW="$BASE/mirroring?d=sim-u-dev-2~sim-u-dev-1"
open_enhanced "$ROW" || { echo '{"pass":false,"error":"enhance did not start"}'; exit 1; }
START=$(runj 'return { pass: true, workHours: panelForm().elements.workHours.checked };')

check "an edit made while the save is on its way stays and counts as a change" "$(runj '
  countPosts();
  const real = window.__realFetch;
  // Hold the answer of the POST for 600 ms; the request itself goes out at once.
  window.fetch = (u, o = {}) => {
    const p = real(u, o);
    if ((o.method || "GET").toUpperCase() !== "POST") return p;
    window.__posts.push(String(u));
    return new Promise((r) => setTimeout(() => r(p), 600));
  };
  const f = panelForm();
  f.elements.workHours.click();
  const m = dbg().merges;
  f.querySelector("[data-save]").click();
  await sleep(100);
  const pending = f.hasAttribute("data-pending");
  f.querySelector("input[name=copy][value=title]").click();
  await until(() => dbg().merges > m);
  await sleep(150);
  window.fetch = real;
  const g = panelForm();
  const out = { pending, posts: posts(), kind: dbg().last.kind, copy: g.elements.copy.value,
    dirty: isDirty(), count: dirtyText(), savedSwitch: g.elements.workHours.checked,
    savedDefault: g.elements.workHours.defaultChecked };
  g.reset();
  await sleep(50);
  return { pass: out.pending && out.posts === 1 && out.kind === "save" && out.copy === "title" && out.dirty &&
      out.savedSwitch === out.savedDefault && !isDirty(), ...out };
')"

check "the switch saved above is put back" "$(runj "const start = $START;
  const f = panelForm();
  if (f.elements.workHours.checked !== start.workHours) {
    f.elements.workHours.click();
    const m = dbg().merges; f.querySelector('[data-save]').click(); await until(() => dbg().merges > m); await sleep(100);
  }
  return { pass: panelForm().elements.workHours.checked === start.workHours && !isDirty() };")"

# 15 s: the POST never answers. The page keeps the input, shows the error, never "Saved", and takes
# the next save. A late answer (here a GET after 17 s, so that nothing is written) is ignored.
check "a save without an answer for 15 s shows the error and keeps the input" "$(runj '
  const real = window.fetch;
  let late = null;
  window.fetch = (u, o = {}) => (o.method || "GET").toUpperCase() === "POST"
    ? (late = new Promise((r) => setTimeout(() => r(real(location.href)), 17000)))
    : real(u, o);
  const f = panelForm();
  f.querySelector("input[name=copy][value=title]").click();
  const m = dbg().merges;
  const t = Date.now();
  f.querySelector("[data-save]").click();
  const note = () => panelForm().querySelector("[data-save-error=failed]");
  await until(() => note() && !note().hidden, 20000);
  const after = Math.round((Date.now() - t) / 1000);
  await sleep(120);
  const shown = { noteShown: !note().hidden, after, pending: panelForm().hasAttribute("data-pending"),
    copy: panelForm().elements.copy.value, announced: document.getElementById("announcer").textContent };
  await late;
  await sleep(300);
  window.fetch = real;
  const out = { ...shown, mergesAfterLate: dbg().merges - m,
    saved: Boolean(document.querySelector("aside.detail [data-saved]:not([hidden])")) };
  panelForm().reset();
  await sleep(50);
  return { pass: out.noteShown && out.after >= 14 && out.after <= 17 && !out.pending && out.copy === "title" &&
      out.mergesAfterLate === 0 && !out.saved && out.announced !== "", ...out };
')"

# A new deploy: the answer carries another asset version. Simulated by changing the version that
# this page holds. A clean page loads the next page normally.
# A step, not a check: the next check asserts the normal load and its reason.
runj '
  window.__sameDoc = 1;
  sessionStorage.removeItem("enhance:fallback");
  document.documentElement.dataset.assetV = "older";
  document.querySelectorAll("a.list-row")[1].click();
  return { pass: true };
' >/dev/null
sleep 2
wait_for 'document.readyState === "complete" && !window.__sameDoc'
check "  ... and the reason is the answer" "$(runj '
  const fb = JSON.parse(sessionStorage.getItem("enhance:fallback") || "null");
  return { pass: !window.__sameDoc && fb?.reason === "answer" && Boolean(document.querySelector("aside.detail")), fallback: fb };
')"

# The same with a dirty panel: the guard asks first; Keep stays; Save and leave saves once and the
# normal load that follows asks no browser question ("leave the page?").
open_enhanced "$ROW"
check "after a deploy, a dirty panel still asks first and Keep stays" "$(runj '
  document.documentElement.dataset.assetV = "older";
  const f = panelForm();
  f.querySelector("input[name=copy][value=title]").click();
  const url = location.href;
  document.querySelector("nav a[href=\"/calendars\"]").click();
  await sleep(300);
  const dialog = document.querySelector("aside.detail dialog[data-guard]");
  const open = dialog.open;
  dialog.querySelector("[data-guard-keep]").click();
  await sleep(100);
  return { pass: open && location.href === url && isDirty() && panelForm().elements.copy.value === "title", open };
')"
check "  ... Discard loads the target normally without a browser question" "$(runj '
  window.__sameDoc = 1;
  sessionStorage.removeItem("beforeunloadPrevented");
  addEventListener("beforeunload", (e) => sessionStorage.setItem("beforeunloadPrevented", String(e.defaultPrevented)));
  document.querySelector("nav a[href=\"/calendars\"]").click();
  const asked = await until(() => document.querySelector("aside.detail dialog[data-guard]")?.open, 3000);
  document.querySelector("aside.detail dialog[data-guard] [data-guard-discard]").click();
  return { pass: asked, asked };
')"
sleep 2
wait_for 'document.readyState === "complete" && !window.__sameDoc'
check "  ... landed on Calendars, nothing asked" "$(runj '
  return { pass: !window.__sameDoc && location.pathname === "/calendars" && sessionStorage.getItem("beforeunloadPrevented") === "false",
    path: location.pathname, prevented: sessionStorage.getItem("beforeunloadPrevented") };
')"

open_enhanced "$ROW"
check "after a deploy, Save and leave saves once and loads without a browser question" "$(runj '
  window.__sameDoc = 1;
  countPosts();
  sessionStorage.removeItem("beforeunloadPrevented");
  addEventListener("beforeunload", (e) => sessionStorage.setItem("beforeunloadPrevented", String(e.defaultPrevented)));
  document.documentElement.dataset.assetV = "older";
  const f = panelForm();
  f.elements.workHours.click();
  const target = document.querySelectorAll("a.list-row")[1];
  sessionStorage.setItem("edgeTarget", target.href);
  target.click();
  const asked = await until(() => document.querySelector("aside.detail dialog[data-guard]")?.open, 3000);
  document.querySelector("aside.detail dialog[data-guard] [data-guard-save]").click();
  return { pass: asked, asked };
')"
sleep 2
wait_for 'document.readyState === "complete" && !window.__sameDoc'
check "  ... landed on the target, nothing asked" "$(runj '
  return { pass: !window.__sameDoc && location.href === sessionStorage.getItem("edgeTarget") &&
      sessionStorage.getItem("beforeunloadPrevented") === "false", url: location.search, prevented: sessionStorage.getItem("beforeunloadPrevented") };
')"
# Put the switch of the first mirroring back.
open_enhanced "$ROW"
check "  ... switch put back" "$(runj "const start = $START;
  const f = panelForm();
  if (f.elements.workHours.checked !== start.workHours) {
    f.elements.workHours.click();
    const m = dbg().merges; f.querySelector('[data-save]').click(); await until(() => dbg().merges > m); await sleep(100);
  }
  return { pass: panelForm().elements.workHours.checked === start.workHours && !isDirty() };")"

# A stylesheet that does not load: the page changes after at most 1.5 s, it does not hang.
# Assets are immutable, so a browser that loaded the activity stylesheet before serves it from its
# HTTP cache and the route never fires. agent-browser has no switch to turn the cache off, so this
# check runs in a new session of its own (a new browser, an empty cache), closed again after it.
NOCACHE="${AB_SESSION:-enh}-nocache-$$"
ab() { agent-browser --session "$NOCACHE" "$@"; }
ab network route '**/next/activity.*.css' --abort >/dev/null 2>&1
open_enhanced "$BASE/mirroring"
check "a page whose stylesheet fails still changes, within 1.5 s plus the request" "$(runj '
  window.__sameDoc = 1;
  const m = dbg().merges;
  const t = performance.now();
  document.querySelector("nav a[href=\"/activity\"]").click();
  await until(() => dbg().merges > m, 6000);
  // The route must really have failed the stylesheet, or this check tests nothing.
  const link = [...document.querySelectorAll("link[rel=stylesheet]")].find((l) => /\/next\/activity\.[0-9a-f]+\.css$/.test(l.href));
  // Chrome keeps a sheet object for a failed load, but its rules cannot be read; a loaded
  // same-origin sheet always gives its rules.
  const unreadable = (sheet) => { try { sheet.cssRules; return false; } catch { return true; } };
  const failed = Boolean(link) && (!link.sheet || unreadable(link.sheet));
  return { pass: failed && window.__sameDoc === 1 && dbg().last.kind === "page" && location.pathname === "/activity" &&
      performance.now() - t < 4000, ms: Math.round(performance.now() - t), failed, link: Boolean(link) };
')"
ab network unroute '**/next/activity.*.css' >/dev/null 2>&1
ab close >/dev/null 2>&1
ab() { agent-browser --session "${AB_SESSION:-enh}" "$@"; }

# Popovers: a page change closes an open menu; a merge in place (refresh) keeps it open.
open_enhanced "$BASE/calendars"
check "a merge in place keeps an open menu open; a page change closes it" "$(runj '
  const menu = document.getElementById("user-menu");
  menu.showPopover();
  let m = dbg().merges;
  await window.slotmirror.visit(location.href);
  await until(() => dbg().merges > m);
  const keptOpen = menu.matches(":popover-open") && dbg().last.kind === "refresh";
  const connect = document.getElementById("connect-menu");
  connect?.showPopover();
  m = dbg().merges;
  document.querySelector("nav a[href=\"/mirroring\"]").click();
  await until(() => dbg().merges > m);
  const closed = !document.querySelector(":popover-open");
  return { pass: keptOpen && closed && Boolean(connect), keptOpen, closed, connect: Boolean(connect) };
')"

# Back and forward across pages with a dirty panel.
open_enhanced "$ROW"
check "back and forward across pages with a dirty panel ask first" "$(runj '
  window.__sameDoc = 1;
  let m = dbg().merges;
  document.querySelector("nav a[href=\"/calendars\"]").click();
  await until(() => dbg().merges > m);
  m = dbg().merges;
  history.back();
  await until(() => dbg().merges > m);
  const backOnPanel = location.href.includes("d=sim-u-dev-2") && Boolean(panelForm());
  panelForm().querySelector("input[name=copy][value=title]").click();
  const url = location.href;
  const dialog = () => document.querySelector("aside.detail dialog[data-guard]");
  history.forward();
  await until(() => dialog()?.open, 3000);
  const askedForward = dialog().open;
  dialog().querySelector("[data-guard-keep]").click();
  await sleep(150);
  const stayed = location.href === url && isDirty();
  history.back();
  await until(() => dialog()?.open, 3000);
  const askedBack = dialog().open;
  dialog().querySelector("[data-guard-discard]").click();
  await sleep(600);
  return { pass: window.__sameDoc === 1 && backOnPanel && askedForward && stayed && askedBack && location.href !== url,
    backOnPanel, askedForward, stayed, askedBack, now: location.pathname + location.search };
')"

# A click during a view transition reaches the page. Chrome sends it to <html> while the
# transition runs; enhance.js ends the transition and passes the click on. The transitions are
# slowed down ten times for this (`--vt-scale`).
open_enhanced "$BASE/mirroring"
ab eval 'document.documentElement.style.setProperty("--vt-scale", "10"); 1' >/dev/null 2>&1
ab eval 'window.__sameDoc = 1; window.__vtClick = null; document.addEventListener("click", (e) => { if (document.activeViewTransition || window.__vtRunning) window.__vtClick = (window.__vtClick ? window.__vtClick + " " : "") + (e.target.closest("a")?.getAttribute("href") ?? e.target.localName); }, true); const m = window.slotmirror._debug.merges; document.querySelectorAll("a.list-row")[0].click(); window.__vtRunning = true; setTimeout(() => window.__vtRunning = false, 1500); 1' >/dev/null 2>&1
sleep 0.4
ab click 'nav a[href="/calendars"]' >/dev/null 2>&1
sleep 2
check "a click during a running transition reaches the page" "$(runj '
  document.documentElement.style.removeProperty("--vt-scale");
  return { pass: window.__sameDoc === 1 && /\bhtml\b/.test(window.__vtClick || "") && /\/calendars/.test(window.__vtClick || "") && location.pathname === "/calendars",
    clicked: window.__vtClick, path: location.pathname };
')"

report enh-edge
