#!/bin/zsh
# Enhanced page changes: the next page's stylesheet is in place before the body changes, the
# activity filter keeps the focus on its select, the theme row stays visible, and a failed fetch or
# an answer from outside the app pages falls back to a normal page load. Prints JSON with pass/fail.
# Usage: test/browser/enh-pages.sh [base-url]     (default http://localhost:8822)
# It opens pages, clicks links and changes a filter. It saves nothing.
BASE=${1:-http://localhost:8822}
ab() { agent-browser --session "${AB_SESSION:-enh}" "$@"; }
source "${0:A:h}/lib.sh"

open_enhanced "$BASE/mirroring" || { echo '{"pass":false,"error":"enhance did not load"}'; exit 1; }

check "page change loads the other stylesheet before the body changes" "$(runj '
  let atFirstChange = null;
  const has = () => [...document.styleSheets].some((s) => (s.href || "").match(/\/next\/calendars\.[0-9a-f]+\.css$/) && s.cssRules.length > 0);
  const hadBefore = has();
  const observer = new MutationObserver(() => { if (atFirstChange === null) atFirstChange = has(); });
  observer.observe(document.body, { childList: true, subtree: true });
  const m = dbg().merges;
  document.querySelector("nav a[href=\"/calendars\"]").click();
  await until(() => dbg().merges > m);
  observer.disconnect();
  const old = [...document.querySelectorAll("link[rel=stylesheet]")].some((l) => l.href.match(/\/next\/mirroring\.[0-9a-f]+\.css$/));
  return { pass: !hadBefore && atFirstChange === true && !old && dbg().last.kind === "page" &&
      document.activeElement.matches("h1"), hadBefore, atFirstChange, oldStylesheetLeft: old, active: document.activeElement.tagName };
')"

check "theme row stays visible after a merge (data-needs-script)" "$(runj '
  const row = document.querySelector("#user-menu [data-needs-script]");
  return { pass: Boolean(row) && !row.hidden && document.documentElement.classList.contains("js"), hidden: row?.hidden };
')"

open_enhanced "$BASE/activity"
check "activity filter keeps the focus on the select, replaces the entry" "$(runj '
  const select = [...document.querySelectorAll("form.act-filters select")].find((s) => s.options.length > 1);
  if (!select) return { pass: false, error: "no filter select with options" };
  const name = select.name;
  select.focus();
  const length = history.length;
  const value = select.options[1].value;
  select.value = value;
  const m = dbg().merges;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await until(() => dbg().merges > m);
  await sleep(100);
  const a = document.activeElement;
  const url = new URL(location.href);
  const out = { kind: dbg().last.kind, active: a.name, value: a.value, url: location.search, emptyInUrl: [...url.searchParams.values()].includes(""),
    lengthSame: history.length === length };
  // Back to no filter.
  const m2 = dbg().merges;
  a.value = "";
  a.dispatchEvent(new Event("change", { bubbles: true }));
  await until(() => dbg().merges > m2);
  return { pass: out.kind === "filter" && out.active === name && out.value === value && url.searchParams.get(name) === value &&
      !out.emptyInUrl && out.lengthSame && document.activeElement.name === name, ...out };
')"

# A failed fetch on a link: the browser loads the page normally.
open_enhanced "$BASE/mirroring"
ab eval 'window.__sameDoc = 1; sessionStorage.removeItem("enhance:fallback"); window.fetch = () => Promise.reject(new TypeError("offline")); document.querySelectorAll("a.list-row")[0].click(); 1' >/dev/null 2>&1
sleep 2
wait_for 'document.readyState === "complete" && !window.__sameDoc'
check "failed fetch on a link falls back to a normal page load" "$(runj '
  const fb = JSON.parse(sessionStorage.getItem("enhance:fallback") || "null");
  return { pass: !window.__sameDoc && location.search.includes("d=") && fb?.reason === "network" && Boolean(document.querySelector("aside.detail")),
    url: location.search, fallback: fb };
')"

# An answer from outside the app pages (a session that ended): a normal page load to that address.
open_enhanced "$BASE/mirroring"
ab eval 'window.__sameDoc = 1; sessionStorage.removeItem("enhance:fallback"); const real = window.fetch; window.fetch = () => real("/privacy", { credentials: "same-origin" }); document.querySelectorAll("a.list-row")[0].click(); 1' >/dev/null 2>&1
sleep 2
wait_for 'document.readyState === "complete" && !window.__sameDoc'
check "an answer from outside the app pages falls back to a normal load of that address" "$(runj '
  const fb = JSON.parse(sessionStorage.getItem("enhance:fallback") || "null");
  return { pass: !window.__sameDoc && location.pathname === "/privacy" && fb?.reason === "answer", path: location.pathname, fallback: fb };
')"

report enh-pages
