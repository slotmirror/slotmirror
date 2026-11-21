#!/bin/zsh
# The save bar and the leave dialog of a panel, with enhanced navigation: one row where the buttons
# fit, the danger tone of a "Turn off", a compact bar on the phone, the three dialog buttons on one
# row, labels that break between words only, and a visible name on every colour swatch. German
# texts, because they are the longest. Prints one JSON object with pass/fail per check.
# Usage: test/browser/savebar.sh [base-url]     (default http://localhost:8822)
# It changes the first mirroring's panel and the "For all mirrorings" panel without saving and
# discards each change. It opens the leave dialog and closes it with "Keep editing".
BASE=${1:-http://localhost:8822}
ab() { agent-browser --session "${AB_SESSION:-savebar}" "$@"; }
source "${0:A:h}/lib.sh"

MIR="$BASE/mirroring?d=sim-u-dev-2~sim-u-dev-1&lang=de"
ALL="$BASE/mirroring?d=all&lang=de"
# The row wraps if it is taller than its Save button.
BAR='const save = () => document.querySelector("aside.detail [data-save]");
  const row = () => document.querySelector("aside.detail .savebar-row");
  const oneRow = () => row().getBoundingClientRect().height <= save().getBoundingClientRect().height + 1;
  const hint = () => getComputedStyle(save(), "::after").content;
  const discard = async () => { document.querySelector("aside.detail [data-discard]")?.click(); await until(() => !isDirty(), 2000); };'

ab set viewport 1440 900 >/dev/null 2>&1
open_enhanced "$MIR" || { echo '{"pass":false,"error":"enhance did not load"}'; exit 1; }
PLATFORM=$(evalj 'document.documentElement.dataset.platform || ""')

check "a long Save label stays on one row at 1440: the keyboard hint goes first" "$(runj "$BAR"'
  panelForm().querySelector("input[name=copy][value=title]").click();
  panelForm().querySelector("input[name=who][value=open]").click();
  await until(() => isDirty() && save().textContent !== save().dataset.label, 2000);
  const r = { label: save().textContent, oneRow: oneRow(), tight: save().closest("[data-savebar]").hasAttribute("data-tight"),
    hint: hint(), platform: "'"$PLATFORM"'" };
  await discard();
  // The hint shows again on the plain Save once the bar has room.
  panelForm().querySelector("input[name=copy][value=title]").click();
  await until(() => isDirty(), 2000);
  r.plainOneRow = oneRow();
  r.plainHint = hint();
  await discard();
  // Fonts differ between machines: the hint may fit. It goes only when it would wrap the row.
  const hintRule = r.tight ? r.hint === "none" : r.hint !== "none";
  r.pass = r.oneRow && r.plainOneRow && r.label.length > 0 && (r.platform === "" || (hintRule && r.plainHint !== "none"));
  return r;
')"

check "a Turn off Save takes the danger tone, the others do not" "$(runj "$BAR"'
  const probe = document.createElement("span");
  probe.style.color = "var(--danger)";
  document.body.append(probe);
  const danger = getComputedStyle(probe).color;
  probe.style.color = "var(--accent)";
  const accent = getComputedStyle(probe).color;
  probe.remove();
  panelForm().querySelector("input[name=copy][value=off]").click();
  await until(() => isDirty(), 2000);
  const off = { label: save().textContent, tone: save().dataset.tone, bg: getComputedStyle(save()).backgroundColor };
  await discard();
  panelForm().querySelector("input[name=copy][value=title]").click();
  await until(() => isDirty(), 2000);
  const title = { label: save().textContent, tone: save().dataset.tone ?? "", bg: getComputedStyle(save()).backgroundColor };
  await discard();
  return { pass: off.tone === "danger" && off.bg === danger && title.tone === "" && title.bg === accent && danger !== accent,
    off, title, danger, accent };
')"

check "the leave dialog keeps its three buttons on one row at 1440" "$(runj "$BAR"'
  panelForm().querySelector("input[name=copy][value=title]").click();
  await until(() => isDirty(), 2000);
  document.querySelector("aside.detail a.detail-close").click();
  const guard = () => document.querySelector("aside.detail dialog[data-guard]");
  await until(() => guard()?.open, 2000);
  const tops = [...guard().querySelectorAll(".guard-actions .btn")].map((b) => Math.round(b.getBoundingClientRect().top));
  const words = [...guard().querySelectorAll(".guard-actions .btn")].map((b) => b.textContent.trim());
  guard().querySelector("[data-guard-keep]").click();
  await sleep(100);
  await discard();
  return { pass: tops.length === 3 && new Set(tops).size === 1, tops, words };
')"

check "every colour swatch shows its name on hover" "$(runj '
  const swatches = [...document.querySelectorAll("aside.detail .swatch")];
  const bad = swatches.filter((s) => !s.title || s.title !== s.querySelector("input")?.getAttribute("aria-label")).length;
  return { pass: swatches.length > 0 && bad === 0, swatches: swatches.length, bad };
')"

open_enhanced "$ALL" || { echo '{"pass":false,"error":"settings panel did not open"}'; exit 1; }
check "property labels break between words, never inside one (1440)" "$(runj '
  const split = [];
  for (const label of document.querySelectorAll("aside.detail .prop-label")) {
    const text = label.firstChild;
    if (!text || text.nodeType !== 3) continue;
    for (const m of text.data.matchAll(/\S+/g)) {
      const range = document.createRange();
      range.setStart(text, m.index);
      range.setEnd(text, m.index + m[0].length);
      if (range.getClientRects().length > 1) split.push(m[0]);
    }
  }
  return { pass: split.length === 0 && document.querySelectorAll("aside.detail .prop-label").length > 3, split };
')"

ab set viewport 390 844 >/dev/null 2>&1
open_enhanced "$MIR" || { echo '{"pass":false,"error":"phone page did not open"}'; exit 1; }
check "on the phone the bar is compact and shows no keyboard hint" "$(runj "$BAR"'
  panelForm().querySelector("input[name=copy][value=title]").click();
  panelForm().querySelector("input[name=who][value=open]").click();
  await until(() => isDirty() && save().textContent !== save().dataset.label, 2000);
  const foot = document.querySelector("aside.detail .detail-foot").getBoundingClientRect().height;
  const r = { foot: Math.round(foot), hint: hint(), oneRow: oneRow(), label: save().textContent };
  await discard();
  return { ...r, pass: r.hint === "none" && r.oneRow && r.foot <= 110 };
')"

ab set viewport 1280 720 >/dev/null 2>&1
report savebar
