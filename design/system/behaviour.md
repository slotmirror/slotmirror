# Behaviour

## URL per view state

Every view state that a person can reach lives in the URL, so that reload, back, a shared link and
a page without script all show the same view.

| State                            | Parameter                                            | Example                                                 |
| -------------------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| Open mirroring panel             | `?d=<from>~<to>` (ids URI-encoded)                   | `/mirroring?d=a~b`                                      |
| "For all mirrorings" panel       | `?d=all`                                             | `/mirroring?d=all`                                      |
| Open calendar panel              | `?c=<id>`                                            | `/calendars?c=a`                                        |
| Calendar panel from a mirroring  | `from=<from>~<to>` and the hash of the field         | `/calendars?c=b&from=a~b#cal-hours-on`                  |
| Admin tab, person, confirmation  | `tab`, `u`, `confirm=delete`                         | built by `adminHref()`                                  |
| Token or app panel, confirmation | `k` or `a`, `confirm=revoke` or `confirm=disconnect` | built by `tokensHref()`                                 |
| Activity filters                 | GET form fields, such as `kind=problems`             | `/activity?kind=problems`                               |
| A save just finished             | `saved=1`                                            | removed again by `panel.js` with `history.replaceState` |

Build these addresses with the page helpers (`mirroringHref`, `mirroringSettingsHref`, the calendar
href, `adminHref`, `tokensHref`), not by hand. The server validates every id against the state.
A panel opened from another one (the mirroring's "Change working hours") names it in `from`; its
head then links back to it (`Panel` with `back`), in place of the back link to the list below
960 px.

## One save model per panel

- A panel with settings is one form with one Save button (`Panel` with `form`, `SaveBar`).
  Without script, Save posts the form and the server redirects back with `saved=1`.
- With script, the save bar shows only while the form differs from what the server rendered. It
  counts changes per field: one per name, one per checkbox value. Checkboxes of one name inside a
  `data-change-group` count as one change (the days, a colour filter); a group never joins two
  names, so the two level questions changed together read "2 changes", like their two dots.
- The Save label follows the notes that show: the label of the shown warning note, else of the
  first shown note that names one (`data-button`, for example "Turn off").
- A destructive label brings the danger tone: the note that names it carries `data-tone="danger"`
  (`Note` with `danger`), and `panel.js` copies it to the Save button (`--danger` fill,
  `--on-danger` text, 4.5:1 or more in both themes).
- **One row where it fits.** Count, Discard and Save share one row. If only the keyboard hint
  after the Save label makes the row wrap, `panel.js` sets `data-tight` on the bar and the hint
  goes. A label too long for one row ("Make 6 mirrorings visible to others") puts Save on a row of
  its own and keeps the hint. Below 720 px and on touch there is no hint, and the bar uses the
  page gutter.
- Nothing saves by itself. A level or a visibility never changes without an explicit Save.
- **Consequence notes.** The server renders a `Note` for each consequence; the script shows the
  notes whose fields changed (`data-changed`), whose switch went from on to off (`data-off`), or that
  a page script picks (`data-sentence`, `data-who-note`).
- **Widening.** A change "widens" when others with access to the target see what they did not see
  before: titles or details from any level, or any copy that is not private when a mirroring is
  turned on (`changeEffect()` in `src/pages/next/levels.ts`). Such a note is a warning (`warn`), and
  the Save button names the effect ("Show titles to everyone", "Make 6 mirrorings visible to
  everyone"). A lower level that stays visible says what others still see; "Not copied" says how
  many copies go.
- **Refused save.** The server answers 400 with the panel again, the reason in a danger notice, and
  the bar forced open (`forced`, `data-refused`). The panel counts as unsaved, and the bar shows the
  server's count of refused changes (`data-refused-count`), because the refused input is now the
  form's default.
- **Conflict.** A panel form carries the version it was rendered from (`v`). If another tab or
  device changed the same panel since, the server answers 409 with the stored values, a new
  version and a warning notice (`data-conflict`). The panel is replaced, not merged: nothing typed
  comes back, the panel is clean, and the notice takes the focus and is announced.
- **Stored, but the page failed.** If the redirect after a stored save answers with an error, the
  bar says "Saved" with a reload hint (`data-save-error="stale"`). The input becomes the baseline,
  so a leave does not ask. The script reads the page again and takes its version if the server
  shows what the form holds, so the next save is not refused as a conflict.
- **"Save and leave" to a page outside the app** saves in the background. A refusal (400) or a
  conflict (409) there replaces the panel with the one the server rendered, as a normal save
  would, and the person stays: the reason at its field, or the stored values with the notice.
- **After a refusal** the count is against what is stored: `data-refused-fields` names the fields
  (else `data-refused-count` counts them), and the bar and the leave dialog add later edits to it.
- **Background save failed.** The input stays; a note in the bar says why ("Could not save" or
  "Your session has ended"). The form is never sent twice.

## The unsaved-changes guard

`public/next/panel.js` stops every way of leaving a dirty panel:

| Way out                                   | How it is caught                                                |
| ----------------------------------------- | --------------------------------------------------------------- |
| A link in the app                         | `click` (without enhanced navigation) or `enhance:before-visit` |
| Another form (reload calendars, sign out) | `submit` or `enhance:before-visit`                              |
| Escape                                    | `keydown`; closes the panel when it is clean                    |
| The close or back link                    | as a link                                                       |
| Back and forward                          | `enhance:before-visit` from `popstate`                          |
| `slotmirror.visit()` and the palette      | `enhance:before-visit`                                          |
| Tab close, reload, a foreign link         | `beforeunload` (the browser's own question)                     |

The dialog offers Discard, Keep editing (initial focus, also Escape) and Save and leave. Save and
leave posts the form with the target in its `back` field if the target is an app page; otherwise
it saves in the background and then goes. A form with `saveMode: "foreground"` is submitted as it is
and the target is dropped.

## Enhanced navigation

File: `public/next/enhance.js` with Idiomorph. Links and forms of the app pages fetch the next page and
merge its body; scroll, focus and open dialogs stay. An app page is the Overview or a page in
`APP_PAGES`; the script matches its path through `html[data-app-base]` (`src/app-base.ts`). Assets
stay under `/next/`, and they are no app pages.

- **Intercepted:** same-origin links to an app page (not assets), left click without modifier keys,
  no `target`, no `download`; GET and POST forms to an app page, and POST forms to old endpoints
  whose `back` field points to an app page.
- **Native:** `rel="external"`, links with `hreflang` (the language switch), anything inside
  `[data-enhance="off"]`, forms with `data-save-mode="foreground"` or `multipart/form-data`, and
  every address that is not an app page.
- **Fallbacks:** on any doubt a GET becomes a normal page load (the reason goes to
  `sessionStorage["enhance:fallback"]`). A POST keeps the page and shows the server's note. A
  different asset version, language or head script list means a new deploy: the page loads fully.
- **Switch:** `ENHANCED_NAVIGATION` in `src/pages/next/shell.tsx`: `"on"` (default), `"off"`
  (scripts load but stay idle unless `?enhance=on`), `"never"` (no Idiomorph and no `enhance.js`).
  A browser keeps `?enhance=on` or `?enhance=off` in localStorage.
- **Keep:** an element with `data-morph-keep` (the `#announcer` live region) and an open dialog
  survive a merge.
- **Events:** `enhance:before-visit` (cancelable, before every leave; `detail`: `url`, `method`,
  `kind`, `form`, `resume`), `enhance:load` (after each merge; `detail.kind`, and `detail.saved` after a save), `enhance:leave` (a
  POST ends in a normal load), `enhance:save-error` (a panel save did not arrive), and `panel:update`
  (from `panel.js` on the form after each change; `detail.count`).
- **Transitions:** only a panel opening (slide in) or closing (wipe out) is animated. A page change
  swaps at once: a crossfade of two lists doubles their text. A row switch, a save, a filter and
  back/forward change in place.
- **Another form posts** (the palette's "Reload calendars") while a panel is open: what is typed
  into the panel meanwhile is put back after the merge and counts as a change.
- **A fallback load** ends the busy cue and frees the panel first, and a page restored from the
  back-forward cache drops any answer still on its way: Back never shows an `inert` panel.
- **Panel identity:** another panel (path plus `d`, `c`, `u`, `k`, `a`, `confirm`, `from`) replaces the
  old one; any other change of the address (a tab, a filter, `saved`) merges it, so its scroll and
  focus stay.
- **Busy cue:** after 150 ms, `aria-busy` on `<html>` (the 2 px line) and `.is-pending` on the
  clicked element; after 1 s the live region says "Loading". The panel being left is `inert`.
- **Prefetch:** on press (`pointerdown`, `touchstart`), never on hover. Back and forward use a cache
  of 10 pages for 60 s and revalidate in the background, without replacing typed input.

## How a page script is written

Follow `theme.js`, `panel.js` and the page scripts:

1. Guard against a second run: `const loaded = (window.slotmirrorScripts ??= {}); if (loaded.x) return;`.
2. Register listeners once, on `document`, and find elements when the event comes. The page content
   changes without a reload, so a listener on an element would be lost.
3. Write an idempotent `sync()` that reads the page as it is now. Run it on `DOMContentLoaded` and
   on `enhance:load`. No listeners inside `sync()`.
4. No user-facing text in a script. Texts come from markup: `data-*` attributes (`data-one`,
   `data-many` with `{n}`, `data-label`, `data-msg-*`) or hidden elements.
5. Add the script to `appScripts()` in `shell.tsx`. The list must be the same on every app page;
   all scripts sit in the head, because scripts in a merged body do not run.
6. If the script fails, the page must stay a working plain page (`panel.js` removes the `js`
   class on an error).

## Focus and scroll after navigation

From `place()` in `enhance.js` and `sync()` in `panel.js`:

| Navigation                 | Scroll                                               | Focus                                                                                                               |
| -------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| First load with a panel    | -                                                    | Panel title, without scrolling the list                                                                             |
| Another page               | Top                                                  | Panel title if the page opens with a panel (palette, a link between panels), else page title (`#page-title`)        |
| Panel opens or switches    | List stays, panel body to top (phone: window to top) | Panel title                                                                                                         |
| Address with a field hash  | The field, centred in the panel body                 | That field (`#cal-hours-on`), on a first load and after any panel opening                                           |
| Panel closes               | List stays (phone: back to the list position)        | The row that opened it                                                                                              |
| Back or forward            | Position stored in the history entry                 | The element focused before, unless it is in the sidebar or the page head; then the panel title, else the page title |
| Save                       | Stays                                                | Stays in the field after Enter or Cmd/Ctrl+Enter; panel title after a click on Save                                 |
| Refused save               | Stays                                                | The first `aria-invalid` field, or the danger notice                                                                |
| Conflict (409)             | Panel body stays                                     | The conflict notice, said aloud too (also without `enhance.js`)                                                     |
| Guard: Keep editing        | Stays                                                | The field last edited (button or Escape)                                                                            |
| Filter, background refresh | Stays                                                | Stays                                                                                                               |

The save rule stays as it is on purpose: after a click on Save the button goes away with the clean
bar, so the focus cannot stay on it; the panel title is the nearest stable place. After Enter or
Cmd/Ctrl+Enter the field is still there and keeps the focus.

## Keyboard shortcuts

| Keys                           | Action                                                                 | Where              |
| ------------------------------ | ---------------------------------------------------------------------- | ------------------ |
| Cmd/Ctrl+K                     | Open the command palette                                               | `palette.js`       |
| G then O, M, C, A              | Go to Overview, Mirroring, Calendars, Activity (second key within 1 s) | `palette.js`       |
| ?                              | Show the shortcut sheet                                                | `palette.js`       |
| J or Arrow Down, K or Arrow Up | Next or previous row, while a list row has focus                       | `panel.js`         |
| Enter                          | Open the focused row                                                   | native             |
| Escape                         | Close a dialog, then the panel                                         | native, `panel.js` |
| Cmd/Ctrl+Enter                 | Save the panel, when dirty and no dialog is open                       | `panel.js`         |

Rules for a new shortcut: single keys skip text fields, modifiers, composition (also the Enter with
`keyCode` 229 that Safari sends to end one) and open dialogs; the account menu can turn them off (WCAG
2.1.4, `data-single-keys`, stored in localStorage, in memory if storage is blocked). The switch
covers `g` sequences, `?`, `j` and `k`; the arrow keys always work. Announce the
shortcut with `aria-keyshortcuts` and list it in `ShortcutSheet`. Key hints (`kbd`) show only on
devices with a fine pointer and hover; the save bar also drops its hint below 720 px.

## Command palette

- **Empty query:** recent items, pages and actions. Mirrorings, calendars and settings show once a
  word is typed.
- **Ranking:** every word must match (label start, word start, substring, keyword, letters in
  order). The whole query adds a bonus: the label is the query, starts with it, or has it at a word
  start. Equal scores go by group: pages, calendars, mirrorings, actions, settings.
- **Words:** each item has keywords in both languages, so English words work in German and the
  other way round.
- **Rows:** a mirroring shows the source swatch and its level mark, a calendar its swatch and
  provider mark, and each row its kind at the right end. The server sends each mark once (a
  `template`); a row names its own with `data-level`, `data-p` and `--c`, so the markup stays small
  with many calendars. The current theme carries a check and `aria-checked`.
- **Nothing destructive:** "Open account menu" finds sign out and delete, but only opens the menu.
- **Actions, not things:** connecting a calendar is listed under Actions, not under Calendars.
- **Key hints:** rows show their keys wherever the pointer is fine, also in a narrow window, which
  still has a keyboard; a coarse pointer hides them. Below 520 px the footer of hints goes, because
  its three hints do not fit on one line.

## Without script

- Every link and form is a normal page load. Panels save with a plain Save button.
- `theme.js` (no `defer`) sets `html.js` before the first paint on app pages; public pages get it
  from `public.js`. Controls that need script carry `data-needs-script` and hide without `js`: the
  palette trigger, the palette, the shortcut sheet, the theme choice, the single-key switch.
- If `panel.js` did not load, `theme.js` removes `js` on `load`, so the save bar stays visible.
- Pages answer with CSS where they can: the mirroring panel shows the hints, the preview and the
  title mark of the checked answers with `:has()` selectors, so it follows the form without script.
