# Helpers for the browser checks. Source it after defining `ab` and `BASE` in the script:
#   BASE=${1:-http://localhost:8822}
#   ab() { agent-browser --session "${AB_SESSION:-enh}" "$@"; }
#   source "${0:A:h}/lib.sh"
# The shell loads every script from the head, so nothing is added to a page here. The mode of a
# run is a flag in the browser: `?enhance=on|off` stores it in localStorage, and it overrides the
# server's default (`ENHANCED_NAVIGATION` in src/pages/next/shell.tsx) until the next flag.

# Opens an address and waits until the page and its deferred scripts ran (max ~10 s): under load
# an eval right after `open` can come before them and read a page without its scripts.
open_page() {
  ab open "$1" >/dev/null 2>&1 || return 1
  wait_for 'document.readyState === "complete" && window.slotmirrorScripts && window.slotmirrorScripts.panel' ||
    wait_for 'document.readyState === "complete"'
}

# Stores the mode in this browser session: on or off.
set_mode() {
  open_page "$BASE/?enhance=$1" || return 1
  local now
  now=$(ab eval 'String(Boolean(window.slotmirror && window.slotmirror.enhanced))' 2>/dev/null | jq -r .)
  [[ $1 == on && $now == true ]] || [[ $1 == off && $now == false ]]
}

# Opens a page with enhanced navigation running. Fails if enhance.js is not active there.
open_enhanced() {
  open_page "$1" || return 1
  local out
  out=$(ab eval 'String(Boolean(window.slotmirror && window.slotmirror.enhanced))' 2>/dev/null | jq -r .)
  if [[ $out != true ]]; then
    set_mode on || return 1
    open_page "$1" || return 1
    out=$(ab eval 'String(Boolean(window.slotmirror && window.slotmirror.enhanced))' 2>/dev/null | jq -r .)
  fi
  [[ $out == true ]]
}

# Opens a page in plain mode (every link and form a normal page load). Fails if enhance runs.
open_plain() {
  open_page "$1" || return 1
  local out
  out=$(ab eval 'String(Boolean(window.slotmirror))' 2>/dev/null | jq -r .)
  if [[ $out != false ]]; then
    set_mode off || return 1
    open_page "$1" || return 1
    out=$(ab eval 'String(Boolean(window.slotmirror))' 2>/dev/null | jq -r .)
  fi
  [[ $out == false ]]
}

# Opens a page in the mode of this run ($MODE: on or off).
open_mode() { if [[ ${MODE:-on} == off ]]; then open_plain "$1"; else open_enhanced "$1"; fi; }

# Evaluates JS that returns a JSON string and prints the parsed JSON.
evalj() { ab eval "$1" 2>/dev/null | jq -r . ; }

# Waits until the JS expression is truthy (max ~10 s). Returns 1 on timeout.
wait_for() {
  local i
  for i in {1..40}; do
    [[ $(ab eval "Boolean($1)" 2>/dev/null) == true ]] && return 0
    sleep 0.25
  done
  return 1
}

# In-page helpers, put in front of an async eval: `until(fn, ms)` polls until fn() is truthy,
# `posts()` counts POSTs sent through window.fetch since `countPosts()`.
JS_PRELUDE='const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (f()) return true; } catch {} await sleep(50); } return false; };
const dbg = () => window.slotmirror._debug;
const countPosts = () => { if (!window.__realFetch) window.__realFetch = window.fetch; window.__posts = []; window.fetch = (u, o = {}) => { if ((o.method || "GET").toUpperCase() === "POST") window.__posts.push(String(u)); return window.__realFetch(u, o); }; };
const posts = () => (window.__posts || []).length;
const panelForm = () => document.querySelector("aside.detail form.detail-form");
const dirtyText = () => document.querySelector("aside.detail [data-count]")?.textContent || "";
const isDirty = () => Boolean(document.querySelector("aside.detail .detail-foot.is-dirty"));'

# Runs an async check body (JS that returns an object) with the prelude, prints compact JSON.
runj() {
  ab eval "(async () => { $JS_PRELUDE
    try { const r = await (async () => { $1 })(); return JSON.stringify(r); }
    catch (e) { return JSON.stringify({ pass: false, error: String(e) }); } })()" 2>/dev/null | jq -c 'fromjson? // {pass:false, error:"no answer"}'
}

RESULTS=()
# check <name> <json with .pass>. Output that is not one JSON object counts as a failed check.
check() {
  local json=${2:-'{"pass":false,"error":"empty"}'}
  jq -se 'length == 1 and (.[0] | type == "object")' <<<"$json" >/dev/null 2>&1 ||
    json=$(jq -nc --arg raw "${json[1,200]}" '{pass: false, error: "no JSON object", raw: $raw}')
  RESULTS+=("$(jq -nc --arg n "$1" --argjson d "$json" '{check: $n, pass: ($d.pass == true), detail: $d}')")
}
# report <script name>: one JSON object with every check. Call it last: its status is the
# script's exit code, 1 if any check failed or there was none.
report() {
  local json
  json=$(printf '%s\n' "${RESULTS[@]}" | jq -s --arg s "$1" --arg load "$(uptime | sed 's/.*load averages*: //')" \
    '{script: $s, load: $load, pass: (length > 0 and all(.[]; .pass)), passed: map(select(.pass)) | length, total: length, checks: .}')
  print -r -- "$json"
  [[ $(jq -r .pass <<<"$json") == true ]]
}
