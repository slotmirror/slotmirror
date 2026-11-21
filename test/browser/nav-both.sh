#!/bin/zsh
# Navigation that must behave the same with and without enhanced navigation: public pages, the
# language switch, sign-out, links to old pages and other sites, modified and middle clicks, Enter
# in a text field, a select in the panel form, and the Admin and Tokens pages.
# MODE=on (default) runs it with `enhance.js` active, MODE=off in plain mode.
# Prints one JSON object with pass/fail per check.
# Usage: MODE=on|off test/browser/nav-both.sh [base-url]     (default http://localhost:8822)
# IT SAVES the first calendar once with Enter in its name field, without a change (same values).
BASE=${1:-http://localhost:8822}
MODE=${MODE:-on}
ab() { agent-browser --session "${AB_SESSION:-enh}" "$@"; }
source "${0:A:h}/lib.sh"

open_mode "$BASE/mirroring" || { echo "{\"pass\":false,\"error\":\"mode $MODE did not start\"}"; exit 1; }
ENH=$([[ $MODE == off ]] && echo false || echo true)

# A signed-out visitor gets the start page, which is `/` too. The local server signs in every
# request; a proxy header turns that off, so the request below is a visitor's. (`/privacy` uses the
# app shell for a signed-in user; from an app page it is a normal page load, see below.)
check "the signed-out start page runs without enhance.js" "$(runj '
  const doc = new DOMParser().parseFromString(await (await fetch("/", { credentials: "omit", headers: { "X-Forwarded-For": "203.0.113.7" } })).text(), "text/html");
  const scripts = [...doc.scripts].map((s) => s.getAttribute("src"));
  return { pass: !scripts.some((s) => /enhance|idiomorph/.test(s || "")) && !doc.body.hasAttribute("data-app"), scripts };
')"

# Links and forms the browser must handle itself. A listener on window, registered last, sees
# whether anything stopped the default; it then stops it, so that the browser stays here.
LEAVE_PROBE='const probe = (type) => new Promise((resolve) => {
    const f = (e) => { removeEventListener(type, f); const was = e.defaultPrevented; e.preventDefault(); resolve(was); };
    addEventListener(type, f);
    setTimeout(() => { removeEventListener(type, f); resolve("none"); }, 1500);
  });'

check "links to pages outside the app, other sites and new tabs stay with the browser" "$(runj "$LEAVE_PROBE"'
  const main = document.querySelector("main");
  const out = {};
  for (const [href, attrs] of [["/rules", {}], ["/account/delete", {}], ["/cleanup", {}], ["/privacy", {}],
      ["https://example.com/", {}], ["/calendars", { target: "_blank" }], ["/calendars", { download: "" }]]) {
    const a = document.createElement("a");
    a.href = href;
    for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
    a.textContent = "x";
    main.append(a);
    const seen = probe("click");
    a.click();
    out[href + (attrs.target ? " _blank" : attrs.download !== undefined ? " download" : "")] = await seen;
    a.remove();
  }
  return { pass: Object.values(out).every((v) => v === false) && window.slotmirror?._debug?.merges === (window.slotmirror ? 0 : undefined), ...out };
')"

check "modified and middle clicks on a row stay with the browser" "$(runj "$LEAVE_PROBE"'
  const row = document.querySelectorAll("a.list-row")[0];
  const out = {};
  for (const [name, init] of [["meta", { metaKey: true }], ["ctrl", { ctrlKey: true }], ["shift", { shiftKey: true }], ["middle", { button: 1 }]]) {
    const seen = probe("click");
    row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init }));
    out[name] = await seen;
  }
  return { pass: Object.values(out).every((v) => v === false), ...out };
')"

check "sign-out is a normal form post" "$(runj "$LEAVE_PROBE"'
  const form = document.querySelector("#user-menu form[action=\"/auth/logout\"]");
  const seen = probe("submit");
  form.requestSubmit();
  const prevented = await seen;
  return { pass: prevented === false, prevented };
')"

check "the language switch loads the page fully, in the other language" "$(runj '
  window.__sameDoc = 1;
  document.querySelector("#user-menu a[hreflang=de]").click();
  return { pass: true };
')"
sleep 2
wait_for 'document.readyState === "complete" && !window.__sameDoc'
check "  ... German, a new document" "$(runj '
  return { pass: !window.__sameDoc && document.documentElement.lang === "de" && Boolean(window.slotmirror) === '"$ENH"', lang: document.documentElement.lang };
')"
ab eval 'window.__sameDoc = 1; document.querySelector("#user-menu a[hreflang=en]").click(); 1' >/dev/null 2>&1
sleep 2
wait_for 'document.readyState === "complete" && !window.__sameDoc'
check "  ... and back to English" "$(runj 'return { pass: document.documentElement.lang === "en", lang: document.documentElement.lang };')"

open_mode "$BASE/calendars?c=sim-u-dev-1"
check "a select in the panel form counts only while it differs" "$(runj '
  const f = panelForm();
  const s = document.createElement("select");
  s.name = "probeSelect";
  s.innerHTML = "<option value=a>a</option><option value=b selected>b</option><option value=c>c</option>";
  f.querySelector(".detail-body").append(s);
  s.dispatchEvent(new Event("change", { bubbles: true }));
  const atStart = dirtyText();
  s.value = "c";
  s.dispatchEvent(new Event("change", { bubbles: true }));
  const changed = dirtyText();
  s.value = "b";
  s.dispatchEvent(new Event("change", { bubbles: true }));
  const back = dirtyText();
  const plain = document.createElement("select");
  plain.name = "probePlain";
  plain.innerHTML = "<option>x</option><option>y</option>";
  f.querySelector(".detail-body").append(plain);
  plain.dispatchEvent(new Event("change", { bubbles: true }));
  const noSelected = dirtyText();
  s.remove();
  plain.remove();
  panelForm().dispatchEvent(new Event("change", { bubbles: true }));
  return { pass: atStart === "" && changed !== "" && back === "" && noSelected === "" && !isDirty(), atStart, changed, back, noSelected };
')"

ab eval 'window.__sameDoc = 1; window.__posts = 0; 1' >/dev/null 2>&1
if [[ $MODE == off ]]; then
  ab eval 'document.querySelector("#detail-form input[name=name]").focus(); 1' >/dev/null 2>&1
  ab press Enter >/dev/null 2>&1
  sleep 2
  wait_for 'document.readyState === "complete" && !window.__sameDoc'
  check "Enter in the name field saves (normal post), Saved shows" "$(runj '
    const saved = document.querySelector("aside.detail [data-saved]");
    return { pass: !window.__sameDoc && Boolean(saved) && !location.search.includes("saved") && !isDirty(), url: location.search };
  ')"
else
  ab eval 'window.__m = window.slotmirror._debug.merges; (() => { const real = window.fetch; window.__postCount = 0; window.fetch = (u, o = {}) => { if ((o.method || "GET").toUpperCase() === "POST") window.__postCount++; return real(u, o); }; })(); document.querySelector("#detail-form input[name=name]").focus(); 1' >/dev/null 2>&1
  ab press Enter >/dev/null 2>&1
  sleep 1.5
  check "Enter in the name field saves once (enhanced), Saved shows, focus stays" "$(runj '
    await until(() => dbg().merges > window.__m);
    await sleep(150);
    const saved = document.querySelector("aside.detail [data-saved]");
    return { pass: window.__sameDoc === 1 && window.__postCount === 1 && dbg().last.kind === "save" && Boolean(saved) && !saved.hidden &&
        document.activeElement?.name === "name" && !isDirty(), posts: window.__postCount, kind: dbg().last.kind, active: document.activeElement?.name || document.activeElement?.id };
  ')"
fi

# Admin: tabs, a person's panel, its confirmation, back to the list.
open_mode "$BASE/admin"
step() {
  # step <selector> <expected search regex>: click, wait for the page (merge or load), check.
  ab eval "window.__sameDoc = 1; window.__m = window.slotmirror ? window.slotmirror._debug.merges : 0; document.querySelector('$1').click(); 1" >/dev/null 2>&1
  sleep 0.6
  wait_for "document.readyState === 'complete' && ($ENH ? window.slotmirror._debug.merges > window.__m : !window.__sameDoc)"
  runj "return { pass: new RegExp('$2').test(location.search) && ($ENH ? window.__sameDoc === 1 : !window.__sameDoc) &&
      document.querySelector('h1.page-title') !== null, url: location.search };"
}
check "admin: access tab" "$(step '.adm-tabs a[href*="tab=access"]' 'tab=access')"
check "admin: health tab (one more stylesheet)" "$(step '.adm-tabs a[href*="tab=health"]' 'tab=health')"
check "admin: people tab" "$(step '.adm-tabs a[href="/admin"]' '^$')"
check "admin: a person's panel" "$(step 'a.row-open[href*="u="]' 'u=')"
if [[ $(ab eval 'String(Boolean(document.querySelector("aside.detail a[href*=\"confirm=delete\"]")))' | jq -r .) == true ]]; then
  check "admin: the delete confirmation of that person" "$(step 'aside.detail a[href*="confirm=delete"]' 'confirm=delete')"
else
  # The dev instance has one person, the admin, who cannot delete themselves: no confirmation.
  check "admin: no delete confirmation for yourself (the only person here; not run)" '{"pass":true,"skipped":true}'
fi
check "admin: close the panel" "$(step 'aside.detail a.detail-close' '^$')"

# Back and forward put the focus on the page heading, not on the nav link that started the visit
# (review 8, M2). Only enhanced navigation manages the focus; a plain load starts at the top.
if [[ $MODE == on ]]; then
  open_mode "$BASE/mirroring"
  ab eval 'window.__m = window.slotmirror._debug.merges; document.querySelector(".sidebar nav a[href=\"/calendars\"]").focus(); 1' >/dev/null 2>&1
  ab click '.sidebar nav a[href="/calendars"]' >/dev/null 2>&1
  wait_for "window.slotmirror._debug.merges > window.__m && location.pathname === '/calendars'"
  ab eval 'window.__m = window.slotmirror._debug.merges; 1' >/dev/null 2>&1
  ab back >/dev/null 2>&1
  wait_for "window.slotmirror._debug.merges > window.__m && location.pathname === '/mirroring'"
  check "Back puts the focus on the page heading, not on the nav link" "$(runj '
    await sleep(150);
    const el = document.activeElement;
    return { pass: el?.id === "page-title" && !el.closest(".sidebar"), kind: dbg().last?.kind,
      focus: el?.id || el?.getAttribute("href") || el?.localName };
  ')"
  ab eval 'window.__m = window.slotmirror._debug.merges; 1' >/dev/null 2>&1
  ab forward >/dev/null 2>&1
  wait_for "window.slotmirror._debug.merges > window.__m && location.pathname === '/calendars'"
  check "Forward puts the focus on the page heading" "$(runj '
    await sleep(150);
    const el = document.activeElement;
    return { pass: el?.id === "page-title", focus: el?.id || el?.getAttribute("href") || el?.localName };
  ')"
else
  check "Back and forward focus (enhanced only; not run in plain mode)" '{"pass":true,"skipped":true}'
fi

check "tokens: 404 while MCP is off here (the page itself is covered by test/enhance-shell.test.ts)" "$(runj '
  const r = await fetch("/tokens");
  return { pass: r.status === 404, status: r.status };
')"

report "nav-both:$MODE"
