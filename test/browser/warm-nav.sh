#!/bin/zsh
# Counts the requests of a warm navigation between two rows on /mirroring and prints JSON.
# Usage: test/browser/warm-nav.sh [base-url]     (default http://localhost:8822)
# It opens pages and clicks two list links. It changes and saves nothing.
# ENHANCE=1 runs it with enhanced navigation (`?enhance=on`), else in plain mode: the navigation then
# stays in the document, and the script counts the requests made after the click.
BASE=${1:-http://localhost:8822}
ab() { agent-browser --session "${AB_SESSION:-enh}" "$@"; }
source "${0:A:h}/lib.sh"

# Click row N (0-based) and wait until the address shows that row and the page is complete.
click_row() {
  local n=$1 before
  before=$(ab eval 'location.href' | jq -r .)
  ab eval "document.querySelectorAll('a.list-row[href*=\"?d=\"]')[$n].click(); 1" >/dev/null
  for i in {1..80}; do
    sleep 0.25
    state=$(ab eval 'document.readyState + " " + location.href' | jq -r .)
    [[ $state == "complete "* && $state != "complete $before" ]] && return 0
  done
  echo "row $n did not open within 20 s" >&2
  return 1
}

if [[ -n $ENHANCE ]]; then
  open_enhanced "$BASE/mirroring" || { echo "enhance.js is not active" >&2; exit 1; }
else
  open_plain "$BASE/mirroring" || { echo "enhance.js is active; plain mode expected" >&2; exit 1; }
fi
# Visit one panel first, so that every shared file is in the cache of this session.
click_row 0 || exit 1
# The measured navigation: the other row. A new document has a fresh resource timing buffer; the
# same document (enhanced) gets an empty one here.
[[ -n $ENHANCE ]] && ab eval 'performance.clearResourceTimings(); window.__enh = 1; 1' >/dev/null
click_row 1 || exit 1
ab eval '(() => {
  const nav = window.__enh ? { transferSize: null } : performance.getEntriesByType("navigation")[0];
  const res = performance.getEntriesByType("resource");
  const cached = res.filter((r) => r.transferSize === 0 && r.decodedBodySize > 0);
  const revalidated = res.filter((r) => r.transferSize > 0 && r.encodedBodySize === 0);
  const fetched = res.filter((r) => r.encodedBodySize > 0 && r.transferSize > 0);
  const name = (r) => r.name.replace(location.origin, "");
  return JSON.stringify({
    url: location.pathname + location.search,
    htmlTransferBytes: nav.transferSize,
    enhanced: Boolean(window.__enh),
    requests: (window.__enh ? 0 : 1) + res.length,
    fetches: res.filter((r) => r.initiatorType === "fetch").map(name),
    resources: res.length,
    fromCache: cached.length,
    revalidated304: revalidated.length,
    fetchedWithBody: fetched.length,
    renderBlocking: res.filter((r) => r.renderBlockingStatus === "blocking").map(name),
    revalidatedFiles: revalidated.map(name),
    fetchedFiles: fetched.map(name),
  });
})()' | jq -r . | jq --arg base "$BASE" '. + {base: $base}'
