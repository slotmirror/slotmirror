#!/bin/zsh
# Runs the browser checks of one mode, one script after the other in one browser session, and
# prints one JSON line per script: {script, mode, pass, passed, total, failed}. Exits 1 if any
# script failed or printed no result.
#   MODE=on  (default): enhanced navigation; the enh-* scripts plus nav-both and layout-narrow.
#   MODE=off: plain mode (kill switch); panel-plain plus nav-both and layout-narrow.
# Both modes end with palette.sh (command palette and shortcuts, own session "pal").
# Usage: MODE=on|off [RETRIES=n] test/browser/run-all.sh [base-url]   (default http://localhost:8822)
# Some scripts save and put the values back; see the head of each script.
BASE=${1:-http://localhost:8822}
MODE=${MODE:-on}
DIR=${0:A:h}
OUT=$(mktemp -d)

if [[ $MODE == off ]]; then
  RUNS=("panel-plain.sh" "nav-both.sh" "layout-narrow.sh" "focus-panel.sh" "palette.sh")
else
  RUNS=("enh-panel.sh" "enh-save.sh" "enh-guard.sh" "enh-pages.sh" "enh-edge.sh" "enh-stale.sh" "enh-swap.sh" "enh-conflict.sh" "enh-fallback.sh"
    "enh-phone.sh 844"
    "enh-phone.sh 480" "nav-both.sh" "layout-narrow.sh" "focus-panel.sh" "savebar.sh" "palette.sh")
fi

failed=0
# The helpers first: a broken `check` would let every script pass.
if ! zsh "$DIR/lib-selftest.sh" >"$OUT/lib-selftest.txt" 2>&1; then
  print -r -- "$(jq -nc --arg m "$MODE" '{script: "lib-selftest", mode: $m, pass: false}')"
  failed=1
fi
for run in "${RUNS[@]}"; do
  args=(${(s: :)run})
  name="${args[1]%.sh}${args[2]:+-${args[2]}}"
  # A failing script runs again up to $RETRIES times (CI sets 1: the checks poll with timeouts).
  attempt=0
  while :; do
    # Each run starts in a fresh tab of the same session: a tab at Chrome's cap of 50 history
    # entries goes back past entries that a script pushed without a real user gesture.
    agent-browser --session "${AB_SESSION:-enh}" close >/dev/null 2>&1
    MODE=$MODE zsh "$DIR/${args[1]}" "$BASE" "${args[@]:1}" >"$OUT/$name.json" 2>"$OUT/$name.err"
    code=$?
    line=$(jq -c --arg s "$name" --arg m "$MODE" --argjson code "$code" --argjson try "$attempt" \
      '{script: $s, mode: $m, pass: (.pass == true and $code == 0), passed, total, exit: $code,
        retries: $try, failed: [.checks[]? | select(.pass | not) | .check]}' "$OUT/$name.json" 2>/dev/null)
    if [[ -z $line ]]; then
      line=$(jq -nc --arg s "$name" --arg m "$MODE" --argjson code "$code" --argjson try "$attempt" \
        '{script: $s, mode: $m, pass: false, passed: 0, total: 0, exit: $code, retries: $try,
          failed: ["no JSON result"]}')
    fi
    [[ $(jq -r .pass <<<"$line") == true || $attempt -ge ${RETRIES:-0} ]] && break
    attempt=$((attempt + 1))
  done
  print -r -- "$line"
  [[ $(jq -r .pass <<<"$line") == true ]] || failed=1
done
print -r -- "$(jq -nc --arg m "$MODE" --arg d "$OUT" --argjson f "$failed" '{summary: true, mode: $m, pass: ($f == 0), outputs: $d}')"
exit $failed
