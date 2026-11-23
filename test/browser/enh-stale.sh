#!/bin/zsh
# Enhanced navigation and stale state (review 6, round 3): a save the server normalizes ends clean
# (M2), edits typed while a save is on its way stay (M2), a panel being left takes no input (M4),
# a revalidated page shows the server's value in a clean focused field (M3), a save drops the
# prefetches (L1), and Cmd+Enter behind an open dialog does not save (L4).
# Usage: test/browser/enh-stale.sh [base-url]     (default http://localhost:8822)
# IT SAVES: it renames the first calendar (as "another client" and through the panel) and puts the
# name back at the end. The normalized save stores nothing new.
BASE=${1:-http://localhost:8822}
ab() { agent-browser --session "${AB_SESSION:-enh}" "$@"; }
source "${0:A:h}/lib.sh"

LIST="$BASE/calendars"
CAL="$BASE/calendars?c=sim-u-dev-1"
open_enhanced "$CAL" || { echo '{"pass":false,"error":"enhance did not load"}'; exit 1; }
ORIGINAL=$(runj 'return { name: panelForm().elements.name.value };' | jq -r .name)
[[ -n $ORIGINAL && $ORIGINAL != null ]] || { echo '{"pass":false,"error":"no start name"}'; exit 1; }
NAME=$(jq -Rn --arg n "$ORIGINAL" '$n')

# Cmd+Enter in the name field with a value the server trims.
check "M2: a keyboard save that the server normalizes ends clean, focus stays" "$(runj "
  countPosts();
  const name = panelForm().elements.name;
  name.focus();
  name.value = $NAME + ' ';
  name.dispatchEvent(new Event('input', { bubbles: true }));
  const m = dbg().merges;
  name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true }));
  await until(() => dbg().merges > m);
  await sleep(150);
  const g = panelForm().elements.name;
  return { pass: posts() === 1 && dbg().last.kind === 'save' && g.value === $NAME && g.defaultValue === $NAME && !isDirty() &&
      dirtyText() === '' && document.activeElement === g,
    kind: dbg().last.kind, value: g.value, defaultValue: g.defaultValue, count: dirtyText(), active: document.activeElement.id };
")"

check "M2: an edit typed while the save is on its way stays and counts" "$(runj "
  const real = window.fetch;
  window.fetch = (u, o = {}) => (o.method || 'GET').toUpperCase() === 'POST'
    ? sleep(800).then(() => real(u, o)) : real(u, o);
  const name = panelForm().elements.name;
  name.focus();
  name.value = $NAME + ' ';
  name.dispatchEvent(new Event('input', { bubbles: true }));
  const m = dbg().merges;
  name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true }));
  await sleep(200);
  name.value = $NAME + ' typed';
  name.dispatchEvent(new Event('input', { bubbles: true }));
  await until(() => dbg().merges > m);
  await sleep(150);
  window.fetch = real;
  const g = panelForm().elements.name;
  const out = { kind: dbg().last.kind, value: g.value, defaultValue: g.defaultValue, dirty: isDirty(), count: dirtyText() };
  panelForm().reset();
  await sleep(50);
  return { pass: out.kind === 'save' && out.value === $NAME + ' typed' && out.defaultValue === $NAME && out.dirty, ...out };
")"

# M4: GETs answer late. A click on another row starts the leave with a clean panel; typing into
# the old panel during the wait must not be possible (it would be lost by the merge).
check "M4: the panel being left takes no input while the next page loads" "$(runj "
  const real = window.fetch;
  window.fetch = (u, o = {}) => (o.method || 'GET').toUpperCase() === 'GET'
    ? sleep(1500).then(() => real(u, o)) : real(u, o);
  const m = dbg().merges;
  [...document.querySelectorAll('a.row-open')].find((a) => a.href.includes('sim-u-dev-2')).click();
  await sleep(300);
  const name = panelForm().elements.name;
  const inert = Boolean(name.closest('[inert]'));
  name.focus();
  const focused = document.activeElement === name;
  if (focused) { name.value += ' lost'; name.dispatchEvent(new Event('input', { bubbles: true })); }
  await until(() => dbg().merges > m, 6000);
  await sleep(150);
  window.fetch = real;
  return { pass: inert && !focused && location.search.includes('sim-u-dev-2') && !document.querySelector('aside.detail[inert]'),
    inert, focused, url: location.search };
")"

# L4: a dirty panel and the palette open with no matching option: Cmd+Enter does nothing.
open_enhanced "$CAL"
check "L4: Cmd+Enter behind the open palette does not save" "$(runj "
  countPosts();
  const name = panelForm().elements.name;
  name.value = $NAME + ' palette';
  name.dispatchEvent(new Event('input', { bubbles: true }));
  const palette = document.getElementById('palette');
  palette.showModal();
  const input = palette.querySelector('input');
  input.focus();
  input.value = 'zzqqxx';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true }));
  await sleep(600);
  const out = { posts: posts(), open: palette.open, value: panelForm().elements.name.value };
  palette.close();
  panelForm().reset();
  await sleep(50);
  return { pass: out.posts === 0 && out.value === $NAME + ' palette' && !isDirty(), ...out };
")"

# L1: a prefetch from before a save must not show after it.
check "L1: a save drops the prefetches; the next page shows the new name" "$(runj "
  const row3 = () => [...document.querySelectorAll('a.row-open')].find((a) => a.href.includes('sim-u-dev-3'));
  row3().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0 }));
  await sleep(300);
  const hits = dbg().prefetchHits;
  const f = panelForm();
  f.elements.name.value = $NAME + 'x';
  f.elements.name.dispatchEvent(new Event('input', { bubbles: true }));
  let m = dbg().merges;
  f.querySelector('[data-save]').click();
  await until(() => dbg().merges > m);
  await sleep(100);
  m = dbg().merges;
  row3().click();
  await until(() => dbg().merges > m);
  await sleep(100);
  const row1 = [...document.querySelectorAll('a.row-open')].find((a) => a.href.includes('sim-u-dev-1'));
  return { pass: row1.textContent.includes($NAME + 'x') && dbg().prefetchHits === hits && location.search.includes('sim-u-dev-3'),
    row1: row1.textContent.replace(/\\s+/g, ' ').trim(), prefetchUsed: dbg().prefetchHits - hits };
")"

# Put the name back through the panel.
put_back() {
  open_enhanced "$CAL"
  runj "const f = panelForm(); if (f.elements.name.value === $NAME) return { pass: true, name: f.elements.name.value };
    f.elements.name.value = $NAME; f.elements.name.dispatchEvent(new Event('input', { bubbles: true }));
    const m = dbg().merges; f.querySelector('[data-save]').click(); await until(() => dbg().merges > m); await sleep(100);
    return { pass: panelForm().elements.name.value === $NAME && !isDirty(), name: panelForm().elements.name.value };"
}
check "name put back after L1" "$(put_back)"

# M3: open the panel by a row click (the page is cached), focus the name, Escape. Another client
# renames the calendar. Back shows the cached page and revalidates: the clean focused field must
# take the new name, so that a later save does not write the old one back.
open_enhanced "$LIST"
check "M3: after Back, revalidation puts the server's name into the clean focused field" "$(runj "
  let m = dbg().merges;
  [...document.querySelectorAll('a.row-open')].find((a) => a.href.includes('sim-u-dev-1')).click();
  await until(() => dbg().merges > m);
  await sleep(100);
  const body = new URLSearchParams(new FormData(panelForm()));
  body.set('name', $NAME + 'y');
  body.delete('back');
  const action = panelForm().action;
  const name = panelForm().elements.name;
  name.focus();
  m = dbg().merges;
  name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await until(() => dbg().merges > m && !document.querySelector('aside.detail'));
  const other = await fetch(action, { method: 'POST', body, credentials: 'same-origin' });
  m = dbg().merges;
  history.back();
  await until(() => dbg().merges > m + 1 && dbg().last.kind === 'revalidate', 6000);
  await sleep(150);
  const g = panelForm().elements.name;
  return { pass: other.ok && dbg().last.kind === 'revalidate' && g.value === $NAME + 'y' && g.defaultValue === $NAME + 'y' && !isDirty(),
    kind: dbg().last.kind, value: g.value, defaultValue: g.defaultValue, title: document.querySelector('#detail-title')?.textContent,
    focused: document.activeElement === g };
")"
check "name put back after M3" "$(put_back)"

report enh-stale
