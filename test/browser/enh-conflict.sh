#!/bin/zsh
# Conflict between two tabs: the calendar panel of `sim-u-dev-1` is open, and
# another client renames the calendar with the version (`v`) the page was rendered with. The page
# then saves its own edit with Cmd/Ctrl+Enter. The server refuses it with 409 and the page shows
# the stored values: the notice is visible, has the focus and is announced, the name field shows
# the other client's name, the panel is clean, and a leave opens no dialog.
# Usage: test/browser/enh-conflict.sh [base-url]     (default http://localhost:8822)
# Then the same with "Save and leave" to a page outside the app, which saves in the background:
# a 409 and a 400 at a field each show the panel the server rendered.
# IT SAVES: the other client renames the first calendar; the name is put back at the end.
BASE=${1:-http://localhost:8822}
ab() { agent-browser --session "${AB_SESSION:-enh}" "$@"; }
source "${0:A:h}/lib.sh"

CAL="$BASE/calendars?c=sim-u-dev-1"
open_enhanced "$CAL" || { echo '{"pass":false,"error":"enhance did not load"}'; exit 1; }
MOD=Meta
[[ $(evalj 'document.documentElement.dataset.platform') == other ]] && MOD=Control
ORIGINAL=$(runj 'return { name: panelForm().elements.name.value };' | jq -r .name)
[[ -n $ORIGINAL && $ORIGINAL != null ]] || { echo '{"pass":false,"error":"no start name"}'; exit 1; }
NAME=$(jq -Rn --arg n "$ORIGINAL" '$n')

check "the panel form carries its version" "$(runj '
  const v = panelForm().elements.v?.value;
  window.__v = v;
  return { pass: Boolean(v), v };
')"

check "another client renames the calendar with the same version" "$(runj "
  const body = new URLSearchParams(new FormData(panelForm()));
  body.set('name', $NAME + ' other');
  body.delete('back');
  const res = await fetch(panelForm().action, { method: 'POST', body, credentials: 'same-origin' });
  return { pass: res.ok && res.redirected, status: res.status, redirected: res.redirected };
")"

# This tab edits the name, which it still shows as the old one, and saves from the keyboard.
runj "countPosts(); window.__m = dbg().merges; const n = panelForm().elements.name; n.focus();
  n.value = $NAME + ' mine'; n.dispatchEvent(new Event('input', { bubbles: true })); return { pass: isDirty() };" >/dev/null
ab press "$MOD+Enter" >/dev/null 2>&1
check "the save is refused: stored values, notice focused and announced, panel clean" "$(runj "
  await until(() => dbg().merges > window.__m);
  await sleep(200);
  const f = panelForm();
  const note = document.querySelector('aside.detail [data-conflict]') ?? document.querySelector('aside.detail .notice-warn');
  const said = document.getElementById('announcer')?.textContent ?? '';
  const name = f.elements.name;
  return { pass: posts() === 1 && dbg().last.kind === 'conflict' && Boolean(note) && note.getClientRects().length > 0 &&
      document.activeElement === note && said.trim() === note.textContent.trim() &&
      name.value === $NAME + ' other' && name.defaultValue === name.value && !isDirty() && dirtyText() === '' &&
      f.elements.v?.value !== window.__v,
    posts: posts(), kind: dbg().last.kind, note: note?.textContent?.trim().slice(0, 60), focus: document.activeElement?.className,
    said: said.slice(0, 60), value: name.value, dirty: isDirty(), newV: f.elements.v?.value !== window.__v };
")"

check "a leave after the conflict opens no dialog" "$(runj '
  const passed = document.dispatchEvent(new CustomEvent("enhance:before-visit", { bubbles: true, cancelable: true,
    detail: { url: location.origin + "/", method: "get", kind: "api", form: null, resume: () => {} } }));
  const dialog = document.querySelector("aside.detail dialog[data-guard]");
  const open = Boolean(dialog?.open);
  if (open) dialog.close();
  return { pass: passed && !open, passed, open };
')"

# Put the name back through the panel (with the new version).
check "name put back" "$(runj "
  const f = panelForm();
  f.elements.name.value = $NAME;
  f.elements.name.dispatchEvent(new Event('input', { bubbles: true }));
  const m = dbg().merges;
  f.querySelector('[data-save]').click();
  await until(() => dbg().merges > m);
  await sleep(100);
  return { pass: panelForm().elements.name.value === $NAME && !isDirty() && dbg().last.kind === 'save',
    name: panelForm().elements.name.value, kind: dbg().last.kind };
")"

# "Save and leave" to a target outside the app pages saves in the background (review 10, major 1). A 409
# there shows the conflict panel like a normal save: stored values, notice focused, clean, still
# on the page. A 400 at a field shows that field's error and keeps the input.
LEAVE='const leaveAndSave = async () => {
    window.slotmirror.visit("/privacy");
    await until(() => document.querySelector("aside.detail dialog[data-guard]")?.open, 3000);
    document.querySelector("aside.detail dialog[data-guard] [data-guard-save]").click();
  };'
open_enhanced "$CAL" || { echo '{"pass":false,"error":"enhance did not load"}'; exit 1; }
check "background save: a 409 shows the stored values and the notice" "$(runj "$LEAVE
  const f = panelForm();
  const body = new URLSearchParams(new FormData(f));
  body.set('name', $NAME + ' other');
  body.delete('back');
  const other = await fetch(f.action, { method: 'POST', body, credentials: 'same-origin' });
  countPosts();
  f.elements.name.value = $NAME + ' mine';
  f.elements.name.dispatchEvent(new Event('input', { bubbles: true }));
  await leaveAndSave();
  const note = () => document.querySelector('aside.detail [data-conflict]');
  await until(() => note(), 5000);
  await sleep(150);
  const name = panelForm().elements.name;
  return { pass: other.redirected && posts() === 1 && Boolean(note()) && document.activeElement === note() &&
      name.value === $NAME + ' other' && !isDirty() && location.pathname === '/calendars',
    posts: posts(), note: Boolean(note()), focus: document.activeElement?.id || document.activeElement?.name,
    value: name.value, dirty: isDirty(), path: location.pathname };
")"
check "background save: a 400 at a field shows that field and keeps the input" "$(runj "$LEAVE
  countPosts();
  const f = panelForm();
  f.elements.name.value = $NAME + ' refused';
  f.elements.name.dispatchEvent(new Event('input', { bubbles: true }));
  const radio = f.querySelector('input[name=color]:not(:checked)');
  radio.value = 'bogus';
  radio.click();
  await leaveAndSave();
  await until(() => document.querySelector('aside.detail [data-savebar][data-refused]'), 5000);
  await sleep(150);
  const a = document.activeElement;
  const g = panelForm();
  return { pass: posts() === 1 && g.elements.name.value === $NAME + ' refused' && isDirty() &&
      (a?.getAttribute('aria-invalid') === 'true' || a?.closest('[aria-invalid=true]') !== null || a?.matches('.notice-danger')) &&
      dirtyText() !== '' && location.pathname === '/calendars',
    posts: posts(), value: g.elements.name.value, focus: a?.name || a?.className, count: dirtyText(), path: location.pathname };
")"
open_enhanced "$CAL" || { echo '{"pass":false,"error":"enhance did not load"}'; exit 1; }
check "name put back after the background saves" "$(runj "
  const f = panelForm();
  if (f.elements.name.value === $NAME) return { pass: true };
  f.elements.name.value = $NAME;
  f.elements.name.dispatchEvent(new Event('input', { bubbles: true }));
  const m = dbg().merges;
  f.querySelector('[data-save]').click();
  await until(() => dbg().merges > m);
  await sleep(100);
  return { pass: panelForm().elements.name.value === $NAME && !isDirty(), name: panelForm().elements.name.value };
")"

report enh-conflict
