#!/bin/zsh
# Click to panel visible on /mirroring, 10 runs, alternating between two rows.
# Usage: test/browser/timings.sh [base-url] [runs]     (default http://localhost:8822, 10)
# It opens pages and clicks two list links. It changes and saves nothing.
#
# How it measures: a full navigation drops the page and its marks. So the click time is taken on
# the old page with performance.timeOrigin + performance.now() (epoch ms) and kept in
# sessionStorage. The new page reports the epoch of its first contentful paint. The difference is
# the time from the click to the first paint of the panel page. If the page does not reload
# (ENHANCE=1), the click script itself waits, frame by frame, until the address has changed and a
# panel shows, then two more animation frames, and stores that time: the shell only reads it, so
# its polling interval does not count.
#
# ENHANCE=1 switches enhanced navigation on (`?enhance=on`), else plain mode, so the clicks are
# enhanced navigations. PRESS=1 also sends a pointerdown 80 ms before the click, as a real click
# does, so the prefetch on press counts; the time then starts at the press.
BASE=${1:-http://localhost:8822}
RUNS=${2:-10}
ab() { agent-browser --session "${AB_SESSION:-enh}" "$@"; }
source "${0:A:h}/lib.sh"

if [[ -n $ENHANCE ]]; then
  open_enhanced "$BASE/mirroring" || { echo "enhance.js is not active" >&2; exit 1; }
else
  open_plain "$BASE/mirroring" || { echo "enhance.js is active; plain mode expected" >&2; exit 1; }
fi
samples=()
for run in $(seq 1 $RUNS); do
  row=$(( run % 2 ))
  ab eval "(async () => {
    window.__perfDoc = 1;
    sessionStorage.setItem('perfT0', String(performance.timeOrigin + performance.now()));
    sessionStorage.setItem('perfFrom', location.href);
    sessionStorage.removeItem('perfMs');
    const link = document.querySelectorAll('a.list-row[href*=\"?d=\"]')[$row];
    if ('${PRESS:-}') {
      link.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
      await new Promise((r) => setTimeout(r, 80));
    }
    link.click();
    // Enhanced: the same document; measure here, right after the panel is merged.
    if (!'${ENHANCE:-}') return 1;
    const t0 = Number(sessionStorage.getItem('perfT0'));
    const from = sessionStorage.getItem('perfFrom');
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const start = performance.now();
    while (performance.now() - start < 20000) {
      if (location.href !== from && document.querySelector('aside.detail')) break;
      await frame();
    }
    await frame();
    await frame();
    sessionStorage.setItem('perfMs', String(Math.round(performance.timeOrigin + performance.now() - t0)));
    return 1;
  })()" >/dev/null
  ms=""
  for i in {1..80}; do
    sleep 0.25
    out=$(ab eval '(async () => {
      if (document.readyState !== "complete") return "wait";
      const t0 = Number(sessionStorage.getItem("perfT0"));
      if (location.href === sessionStorage.getItem("perfFrom")) return "wait";
      if (!document.querySelector("aside.detail, .detail")) return "wait";
      if (window.__perfDoc) return sessionStorage.getItem("perfMs") || "wait";
      const fcp = performance.getEntriesByName("first-contentful-paint")[0];
      if (!fcp) return "wait";
      return String(Math.round(performance.timeOrigin + fcp.startTime - t0));
    })()' | jq -r .)
    if [[ $out != wait ]]; then ms=$out; break; fi
  done
  [[ -z $ms ]] && { echo "run $run: no panel within 20 s" >&2; continue; }
  samples+=($ms)
done
printf '%s\n' "${samples[@]}" | jq -s --arg base "$BASE" --arg enh "${ENHANCE:-}${PRESS:++press}" '
  sort as $s | ($s | length) as $n |
  {base: $base, runs: $n, samplesMs: $s,
   medianMs: (if $n == 0 then null else ($s[($n - 1) / 2 | floor] + $s[$n / 2 | floor]) / 2 end),
   p75Ms: (if $n == 0 then null else $s[(($n * 0.75) | ceil) - 1] end),
   metric: (if $enh == "" then "click to first paint of the panel page (full navigation)"
     else "click (or press) to two frames after the merged panel (enhanced)" end)}'
