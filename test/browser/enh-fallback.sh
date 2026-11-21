#!/bin/zsh
# Enhanced navigation when it gives up or when another form posts (review 10):
# - A GET that falls back to a normal page load leaves nothing behind: Back from the
#   back-forward cache shows a usable panel (no `inert`, no `aria-busy`, no `.is-pending`).
# - Input typed in the panel while another form's POST is on its way (the palette's "Reload
#   calendars") stays after the merge and counts as a change.
# Usage: test/browser/enh-fallback.sh [base-url]     (default http://localhost:8822)
# It saves nothing: the reload's answer is faked in the page, and the typed input is discarded.
BASE=${1:-http://localhost:8822}
ab() { agent-browser --session "${AB_SESSION:-enh}" "$@"; }
source "${0:A:h}/lib.sh"

ROW="$BASE/mirroring?d=sim-u-dev-2~sim-u-dev-1"
CAL="$BASE/calendars?c=sim-u-dev-1"
open_enhanced "$ROW" || { echo '{"pass":false,"error":"enhance did not load"}'; exit 1; }

# A link below an app page whose answer is not an app page (404): enhance.js falls back to a full load.
# The GET is slowed down, so the busy cue and the pending mark are on before the load.
ab eval 'window.__bf = 1;
  const real = window.fetch;
  window.fetch = (u, o) => String(u).includes("/mirroring/no-such-page") ? new Promise((r) => setTimeout(r, 500)).then(() => real(u, o)) : real(u, o);
  const a = document.createElement("a"); a.href = "/mirroring/no-such-page"; a.id = "fb-link"; a.textContent = "x";
  document.querySelector("aside.detail .detail-body").append(a); a.click(); 1' >/dev/null 2>&1
wait_for 'location.pathname === "/mirroring/no-such-page" && document.readyState === "complete"'
ab back >/dev/null 2>&1
wait_for 'location.pathname === "/mirroring" && document.readyState === "complete"'
check "after a fallback load, Back shows a usable panel" "$(runj '
  await sleep(300);
  const aside = document.querySelector("aside.detail");
  const r = { cached: window.__bf === 1, inert: Boolean(aside?.inert), busy: document.documentElement.hasAttribute("aria-busy"),
    pending: document.querySelectorAll(".is-pending").length };
  // Without the back-forward cache the page is new and the check would prove nothing.
  r.pass = r.cached && Boolean(aside) && !r.inert && !r.busy && r.pending === 0;
  return r;
')"

# Another form posts while the panel is open; the person types into the panel meanwhile.
open_enhanced "$CAL" || { echo '{"pass":false,"error":"enhance did not load"}'; exit 1; }
check "input typed during another form's POST stays and counts" "$(runj '
  const real = window.fetch;
  let posts = 0;
  // The reload is answered with this page, as the server would after its redirect.
  window.fetch = async (u, o = {}) => {
    if ((o.method || "GET").toUpperCase() !== "POST") return real(u, o);
    posts++;
    await sleep(700);
    const res = await real(location.href);
    const fake = new Response(await res.text(), { status: 200, headers: { "content-type": "text/html" } });
    Object.defineProperty(fake, "url", { value: location.href });
    Object.defineProperty(fake, "redirected", { value: true });
    return fake;
  };
  const form = document.getElementById("palette-reload");
  form.elements.back.value = location.pathname + location.search;
  const m = dbg().merges;
  form.requestSubmit();
  await sleep(150);
  const name = panelForm().elements.name;
  const typed = name.value + " typed";
  name.focus();
  name.value = typed;
  name.dispatchEvent(new Event("input", { bubbles: true }));
  await until(() => dbg().merges > m);
  await sleep(150);
  window.fetch = real;
  const now = panelForm().elements.name;
  const r = { posts, kind: dbg().last.kind, value: now.value, dirty: isDirty(), count: dirtyText() };
  r.pass = posts === 1 && now.value === typed && isDirty();
  panelForm().querySelector("[data-discard]")?.click();
  await sleep(100);
  r.discarded = !isDirty();
  return r;
')"

report enh-fallback
