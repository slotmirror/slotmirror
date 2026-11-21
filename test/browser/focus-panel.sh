#!/bin/zsh
# Where the focus lands when a panel opens, in the mode of the run (MODE=on: enhanced navigation;
# MODE=off: plain page loads): a palette jump from another page, the link from a mirroring's
# working hours to the calendar panel, and a direct load. Prints one JSON object with pass/fail
# per check.
# Usage: MODE=on|off test/browser/focus-panel.sh [base-url]     (default http://localhost:8822)
# It opens pages, the palette and links. It changes and saves nothing.
BASE=${1:-http://localhost:8822}
MODE=${MODE:-on}
ab() { agent-browser --session "${AB_SESSION:-focus}" "$@"; }
source "${0:A:h}/lib.sh"

MOD=Meta
MIR="/mirroring?d=sim-u-dev-2~sim-u-dev-1"
HOURS="/calendars?c=sim-u-dev-1&from=sim-u-dev-2~sim-u-dev-1#cal-hours-on"
ab set viewport 1440 900 >/dev/null 2>&1
open_mode "$BASE/calendars" || { echo '{"pass":false,"error":"mode did not start"}'; exit 1; }
[[ $(evalj 'document.documentElement.dataset.platform') == other ]] && MOD=Control

# A palette jump from the calendars page to a mirroring: the panel title, not the page title.
runj 'document.querySelector(".page-title").focus(); return {pass:true};' >/dev/null
ab press "$MOD+k" >/dev/null
ab type "#palette input" "konto 2 konto 1" >/dev/null
runj 'await sleep(400); return {pass:true};' >/dev/null
ab press Enter >/dev/null
check "a palette jump to a mirroring from another page focuses the panel title ($MODE)" "$(runj '
  await until(() => location.pathname === "/mirroring" && document.querySelector("aside.detail form.detail-form"), 6000);
  await until(() => document.activeElement?.id === "detail-title", 1500);
  return { pass: document.activeElement?.id === "detail-title" && location.search.includes("d=sim-u-dev-2~sim-u-dev-1"),
    active: document.activeElement?.id || document.activeElement?.className, url: location.search };
')"

# And back the other way: a calendar from the mirroring page.
runj 'document.querySelector(".page-title").focus(); return {pass:true};' >/dev/null
ab press "$MOD+k" >/dev/null
CAL1=$(evalj 'document.querySelector("#palette [role=option][href=\"/calendars?c=sim-u-dev-1\"] .po-label").textContent')
ab type "#palette input" "$CAL1" >/dev/null
runj 'await sleep(400); return {pass:true};' >/dev/null
ab press Enter >/dev/null
check "a palette jump to a calendar from another page focuses the panel title ($MODE)" "$(runj '
  await until(() => location.pathname === "/calendars" && document.querySelector("aside.detail"), 6000);
  await until(() => document.activeElement?.id === "detail-title", 1500);
  return { pass: document.activeElement?.id === "detail-title" && location.search.includes("c=sim-u-dev-1"),
    active: document.activeElement?.id || document.activeElement?.className, url: location.search };
')"

# The working hours link of a mirroring opens the calendar panel at its working hours.
open_mode "$BASE$MIR" || { echo '{"pass":false,"error":"mirroring did not open"}'; exit 1; }
# The click and the check are two calls: in plain mode the click loads a new document.
LINK=$(runj '
  const link = [...document.querySelectorAll("aside.detail .prop-hint a.link")].find((a) => a.href.includes("/calendars"));
  setTimeout(() => link?.click(), 0);
  return { pass: Boolean(link), href: link?.getAttribute("href") };
')
wait_for 'location.pathname === "/calendars" && document.readyState === "complete" && document.querySelector("aside.detail #cal-hours-on")'
check "the working hours link goes to the calendar panel's working hours ($MODE)" "$(runj '
  const link = '"$LINK"';
  const href = link.href;
  await until(() => document.activeElement?.id === "cal-hours-on", 1500);
  const el = document.activeElement;
  const r = el.getBoundingClientRect();
  const body = document.querySelector(".detail-body").getBoundingClientRect();
  const shown = r.top >= body.top && r.bottom <= body.bottom;
  return { pass: link.pass && el.id === "cal-hours-on" && shown && location.hash === "#cal-hours-on" &&
      new URLSearchParams(location.search).get("from") === "sim-u-dev-2~sim-u-dev-1",
    href, active: el.id || el.tagName, shown, url: location.search + location.hash };
')"

# A direct load: the hash field, and without a hash the panel title.
open_mode "$BASE$HOURS" || { echo '{"pass":false,"error":"calendar did not open"}'; exit 1; }
check "a direct load with the hash focuses the working hours" "$(runj '
  await until(() => document.activeElement?.id === "cal-hours-on", 1500);
  return { pass: document.activeElement?.id === "cal-hours-on", active: document.activeElement?.id || document.activeElement?.tagName };
')"
open_mode "$BASE$MIR" || { echo '{"pass":false,"error":"mirroring did not open"}'; exit 1; }
check "a direct load without a hash focuses the panel title" "$(runj '
  await until(() => document.activeElement?.id === "detail-title", 1500);
  return { pass: document.activeElement?.id === "detail-title", active: document.activeElement?.id || document.activeElement?.tagName };
')"

report focus-panel
