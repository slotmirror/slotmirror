# Components and patterns

Each component emits the classes that `public/next/base.css` documents in its header ("Class API").
Pages compose these components and add only page-specific CSS in their own stylesheet, with a page
prefix (`ov-`, `mx-`, `cal-`, `act-`, `adm-`, `pub-`). If you need a new shared pattern, add it to
`base.css` and `src/pages/next/components.tsx`, not to a page stylesheet.

## Which control for which choice

| The person chooses                      | Use                                                                 | Example                                        |
| --------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------- |
| One of 2 to 4 short options             | Segmented (`Segmented`, radios)                                     | "What others see": Private event / Same as you |
| One of 4 options that each carry a mark | Segmented tiles (`tiles`)                                           | "What is copied" with level marks              |
| Several of a short fixed set            | Segmented with checkboxes (hand-written `.seg` with `role="group"`) | Working days Mon to Sun                        |
| On or off, with an immediate meaning    | Switch (`Switch`)                                                   | Working hours, "until midnight"                |
| One of many colours                     | Swatches (`.swatches`, radios)                                      | Calendar colour, colour of the copies          |
| Several of many colours                 | Swatches with checkboxes and `data-roving`                          | "Only these colours" filter                    |
| One toggle next to swatches             | Choice (`.choice`)                                                  | "Automatic" before the colour swatches         |
| One of many items, or a long list       | Select (`.select`)                                                  | Activity filters, "days ahead" style lists     |
| Free text, a number, a time             | Input (`.input`, `.input.is-narrow`, `type="time"`)                 | Copy title, working hours                      |
| A view of the same page (tab or scope)  | Segmented of links with `aria-current`                              | Language switch, Admin tabs                    |

## App shell

File: `src/pages/next/shell.tsx`, `Shell`. CSS: `base.css` section 3.

Use it for every page inside the app. It renders the head (theme script without `defer`, the
deferred app scripts in a fixed order, the font preload, `base.css` and the page styles), the
sidebar, the palette and shortcut sheet, and one raised main panel.

Props: `title` (page title and window title), `user`, `active` (nav entry), `lead` (one short live
line next to the title, such as "6 mirrorings in sync"; not an explanation), `attention`
(`{ mirroring?, calendars? }`), `width` (`"narrow"` 848 px, `"wide"` 1408 px, default 1120 px),
`actions` (header actions), `panel` (a `Panel`), `styles` (page stylesheets), `palette` (data for
the command palette).

```html
<body class="app" data-app="next">
  <div id="announcer" class="sr-only" aria-live="polite" data-morph-keep data-msg-saved="…"></div>
  <a class="skip" href="#main">…</a>
  <aside class="sidebar">
    <a href="/next" class="brand">…</a>
    <button class="palette-trigger" …></button>
    <nav class="nav" aria-label="…">
      <div class="nav-group">
        <a class="nav-item" aria-current="page" aria-keyshortcuts="G O">…</a>
      </div>
      <div class="nav-group nav-secondary">…</div>
    </nav>
    <button class="user-button" popovertarget="user-menu">…</button>
    <div id="user-menu" class="menu menu-pop" popover="auto">…</div>
  </aside>
  <div class="frame has-panel is-narrow">
    <div class="workspace">
      <main class="pane" id="main" tabindex="-1">
        <header class="page-head">
          <div class="page-head-inner">
            <h1 class="page-title" id="page-title" tabindex="-1">…</h1>
            <p class="page-lead">…</p>
            <div class="page-actions">…</div>
          </div>
        </header>
        <div class="page-scroll"><div class="content">…</div></div>
      </main>
      <aside class="detail" id="detail">…</aside>
    </div>
  </div>
</body>
```

- **Navigation.** Four primary pages (Overview, Mirroring, Calendars, Activity) and a lower group
  (API tokens, Admin) at the bottom. An entry shows only to users with its permission. Icons are
  16 px strokes; the label carries the meaning. On a phone the primary pages become four equal
  tabs with labels only, and the lower group shows icons only, with the labels as accessible names.
- **Attention dot.** `.nav-attention`, 6 px, `--danger`, at the end of the item. Its words are in
  the accessible name (`", needs attention"` in a `.sr-only` span). Mirroring gets it when a
  mirroring failed; Calendars when a calendar lost its connection (`navAttention()` in
  `run-status.tsx`).
- **User menu.** A native popover (no script needed): email, role, language links, theme (needs
  script), the single-key switch, "Sign out", then "Delete my data" in a group of its own between
  separators, in `--danger` (`.menu-item-danger`), then privacy link and version. "Delete my data"
  opens a page that lists what is deleted and asks to confirm.
- **Header action.** `HeaderAction` (`href`, `closeHref`, `open`, `icon`, `children`): a secondary
  button link that opens a panel on this page, such as "For all mirrorings". While its panel is
  open it carries `aria-expanded="true"`, looks pressed (`--fill-selected` with a `--control-line`
  edge) and links to `closeHref`.
- **Widths.** Default for lists with a panel; `narrow` for text and short lists (Admin, API tokens);
  `wide` for the Overview map.

Do: give every page a `title` and an `active` entry when it has one. Do not: put an explanation
into `lead`; it is one ellipsised line.

## List and list row

File: `components.tsx`, `ListGroup` and `ListRow`. CSS: `base.css` section 4.

`ListGroup` props: `title`, `hint`, `label` (accessible name of the `<ul>`), `level` (2 or 3),
`children`. `ListRow` props: `id` (stable, such as `row-m-<from>~<to>`; the merge matches rows by
it), `href` (the whole row is a link), `selected` (`aria-current="true"` on a link row,
`.is-selected` on a plain row), `label` (accessible name when the parts read badly in sequence),
`icon`, `title`, `meta`, `tags`, `count`, `status`.

```html
<section class="list-group">
  <div class="list-group-head">
    <h2>…</h2>
    <span class="list-group-hint">…</span>
  </div>
  <ul class="list-body" aria-label="…">
    <li class="list-item" id="row-…">
      <a class="list-row" href="…" aria-current="true" aria-label="…">
        <span class="row-icon">…</span>
        <span class="row-main"
          ><span class="row-title">…</span><span class="row-meta">…</span></span
        >
        <span class="row-tags">…</span>
        <span class="row-count num">…</span>
        <span class="row-status">…</span>
      </a>
    </li>
  </ul>
</section>
```

- 40 px rows, full bleed inside the content; the rows keep the gutter as padding. The hairline is
  a 1 px background layer (`--sep`), inset by the gutter at both ends: it starts where the text
  starts and ends where the header ends, so it never touches the frame and never stops in mid-air.
  The last row adds the same line at its bottom (`--sep-end`).
- **Fixed columns.** A list can put its rows on fixed columns: set `--row-display: grid`,
  `--row-main-display: contents` and `--row-columns` with the line names `icon`, `title`, `meta`,
  `tags`, `count`, `status`. Example from `mirroring.css`:
  `[icon] 20px [title] 144px [meta] 208px [tags] minmax(0, 1fr) [count] 72px [status] 140px`.
- **Narrow list.** Below 640 px of list width (container query: a panel beside the list from 960
  to 1280 px, a narrow window, a phone) every row takes two lines on fixed tracks: name, count and
  status on the first, the meta (level or address) under the name on the second, the swatch on the
  name's line. Tags hide; below 480 px the count hides too. One line would cut the level: the
  German "Nur belegt, dasselbe wie du" alone is about 190 px.
- **Count** is tabular and right aligned. **Status** is right aligned so that phrases end at one x;
  a time alone sits in a 48 px tabular slot, so the dots of fine rows form one column.
- **Row with an action.** Calendars and Admin rows hold a button, so the row is a `div` with a
  stretched link (`a.row-open` with `::after { inset: 0 }`) and the action sits above it
  (`.row-action`, `z-index: 1`).
- States: hover `--fill-hover` (link rows only), selected `--fill-selected` plus a 1 px inset ring
  in `--control-line` (a fill under dark text cannot reach 3:1; no edge bar), which replaces the
  row's hairlines and the top hairline of the next row, pending
  (`.is-pending`, after 150 ms) `--fill-hover`, focus outline inset 2 px.
- Keyboard: Arrow Up and Down, and `j` and `k`, move between link rows (`panel.js`).
- Phone: rows 48 px, parts wrap, tags hide.

### Status vocabulary

File: `src/pages/next/run-status.tsx`. A row or panel head says its state with a dot and a short
time when all is well, and in words only when it is not. `mirroringRun()` and `calendarRun()` build
a `RunPhrase` (`tone`, `words`, `at`, `text`); `Run` renders it for rows, `RunText` for the panel's
state line.

| State (mirroring)    | Tone   | Shown                                   |
| -------------------- | ------ | --------------------------------------- |
| ok, with a run       | ok     | dot + "8 min" (dot is named "In sync")  |
| ok, no run / waiting | idle   | "No run yet"                            |
| partial              | warn   | "Catching up"                           |
| failed               | danger | "Failed 8 min" or "3 not written 8 min" |
| overdue              | warn   | "No run for 2 h"                        |
| blocked              | danger | "Connection lost"                       |

Calendars add "Paused" (idle) and use "Connection lost" when the account needs a reconnect.

## Status dot and tag

`StatusDot` (`tone`: `ok`, `warn`, `danger`, `idle`; `label`): an 8 px circle. By default it names
its state (`role="img"`, `aria-label` from `t.next.shell.status`); pass `label={false}` when words
next to it say the state. `.dot-idle` is a ring, not a fill.

`Tag` (`children`, `title`): a 20 px muted label, 4 px radius, `--text` at 7% behind `--text-2`.
Tags say only what differs from the plain case ("Working hours", "2 colours"). They hide on a phone.

## Detail panel

File: `components.tsx`, `Panel`. CSS: `base.css` sections 3 and 6.

Props: `title`, `closeHref` (the list without the selection), `form` (`action`, `method`,
`saveMode: "foreground"` for a form whose answer is the page, such as a one-time secret), `escape:
"off"` (Escape does not close a panel that shows something once), `meta` (one muted state line),
`footer` (a `SaveBar`), `saved` (shows "Saved" in the head), `children`.

```html
<aside class="detail" id="detail" aria-labelledby="detail-title" data-escape="off">
  <div class="detail-head">
    <h2 class="detail-title" id="detail-title" tabindex="-1">…</h2>
    <a class="btn btn-ghost detail-back" href="…" aria-label="Back to the list"
      >…<span>Back</span></a
    >
    <span class="detail-saved" role="status" data-saved>…Saved</span>
    <a class="btn btn-ghost btn-icon detail-close" href="…" aria-label="Close">…</a>
  </div>
  <form class="detail-form" id="detail-form" method="post" action="…">
    <div class="detail-body">
      <p class="detail-meta">…</p>
      <section class="section">
        <h3 class="section-title">…</h3>
        …
      </section>
    </div>
    <div class="detail-foot">…save bar…</div>
  </form>
  <dialog class="guard" data-guard>…</dialog>
</aside>
```

- 400 px wide, a hairline on its left, its own scroll. Below 960 px it covers the list; the back
  link (drawn first with CSS `order`, but after the heading in the source) replaces the close
  button.
- **State line** (`meta`): "8 min · 60 copies · View activity". Parts are separated by
  `.detail-meta-sep` (CSS draws "·"). Spell out a state only when it is not ok.
- **Sections** (`Section`, optional `title`): 24 px padding, hairline between sections.
- **"Saved"** appears only in the panel head (`.detail-saved`), never as a toast or notice.

### Property grid

`PropertyRow` props: `label`, `for` (id of the one control), `group` (id of a group of controls),
`hint`, `stacked`, `fields` (form field names, for the changed dot). Helpers: `hintId(id)` gives
`<id>-hint`, `labelId(id)` gives `<id>-label`.

```html
<div class="prop" data-fields="copy">
  <label class="prop-label" for="mx-hours">…</label>
  <!-- or <span id="mx-copy-label"> for a group -->
  <div class="prop-control">…</div>
  <p class="prop-hint" id="mx-copy-hint">…</p>
</div>
```

- Two columns: label 120 px (`--label-w`), 16 px gap, control. The label is centred on the 28 px
  control band. The hint sits under the control, 12 px, 16 px line height.
- `stacked` puts a wide control (segmented with long labels, swatches) under its label across both
  columns.
- A control links its hint with `aria-describedby={hintId(id)}`; a group names itself with
  `aria-labelledby={labelId(group)}`.
- **Changed dot.** When a field of the row differs from the saved value, `panel.js` sets
  `data-changed` on the row and CSS draws a 6 px accent dot after the label.
- `.prop-indent` puts something that belongs to the property above (a disclosure) in the control
  column.

Do: use `PropertyRow` for every property of every panel. Do not: build a label and control pair by
hand; the x positions and the rhythm then drift.

### Save bar

`SaveBar` props: `notes` (a list of `Note`), `forced` (keep the bar open for a form the server
refused; also sets `data-refused`). `Note` props: `children`, `changed` (field names), `off` (id of a
switch), `warn`, `button` (label of the primary button while the warning shows), plus any
`data-*` attribute for a page script.

```html
<div class="savebar" data-savebar data-one="1 change" data-many="{n} changes">
  <div class="savebar-notes is-warn" role="status">
    <svg class="savebar-note-icon">…</svg>
    <div class="savebar-note-list">
      <p data-note data-changed="copy" data-warn data-button="Show titles to everyone" hidden>…</p>
      <p data-note data-warn data-save-error="failed" hidden>…</p>
      <p data-note data-warn data-save-error="session" hidden>…</p>
    </div>
  </div>
  <div class="savebar-row">
    <span class="savebar-text num" data-count></span>
    <button type="button" class="btn btn-ghost" data-discard hidden>Discard</button>
    <button
      type="submit"
      class="btn btn-primary"
      data-save
      data-label="Save"
      data-kbd-mac="⌘↵"
      data-kbd-other="Ctrl ↵"
      aria-keyshortcuts="Meta+Enter Control+Enter"
    >
      Save
    </button>
  </div>
</div>
```

States:

| State             | What shows                                                                           |
| ----------------- | ------------------------------------------------------------------------------------ |
| No script         | A plain Save button, always visible                                                  |
| Clean (script)    | The bar is hidden (`.js .detail-foot:not(.is-dirty)`)                                |
| Dirty             | Bar visible, "3 changes", Discard, Save with the key hint (not on touch)             |
| Consequence note  | One line above the buttons, `--text-2`                                               |
| Warning note      | Warn icon, text in `--text`, Save label swapped to the note's `data-button`          |
| Saving            | Save disabled                                                                        |
| Refused or failed | A save error note shows; the input stays                                             |
| Forced            | The server refused the last save; the bar stays open and the panel counts as unsaved |

A long Save label ("Make 6 mirrorings visible to everyone") wraps onto its own line, right aligned.
The key hint is drawn by CSS after the label (`::after` with `attr(data-kbd-mac)`), because the
script swaps the label text.

## Segmented control

File: `components.tsx`, `Segmented`. CSS: `.seg`, `.seg-item` in `base.css` section 7.

Props: `name`, `label` or `labelledBy`, `describedBy`, `value`, `options` (`value`, `label`, `icon`,
`disabled`), `block` (fill the width), `tiles` (icon above the label, equal widths), `group`
(controls with one group count as one change).

```html
<div
  class="seg is-block is-tiles"
  role="radiogroup"
  aria-labelledby="mx-copy-label"
  aria-describedby="mx-copy-hint"
  data-change-group="level"
>
  <label class="seg-item"
    ><input type="radio" name="copy" value="busy" checked />…<span>Busy only</span></label
  >
</div>
```

- A sunken track (`--control-track`, inset `--line`), items as plain `--text-2` text, the selected
  item raised (`--control-selected`, `--control-line` edge, `--control-shadow`, `--text`).
- The selected look applies to `input:checked`, `[aria-pressed="true"]`, `[aria-current="true"]`
  and `[aria-current="page"]`. So the same class serves radios, checkboxes, theme buttons and
  links (language switch, tabs).
- Keyboard: radios give the native arrow-key behaviour. Focus shows as a 2 px accent outline,
  2 px off the item.
- **Multi-select form.** A hand-written `.seg` with `role="group"` and checkbox inputs, for
  example the working days in `calendars.tsx` (`.seg is-block cal-days`, `data-change-group="days"`).
- Disabled options: 0.45 opacity.

Do: keep labels short; four German labels must fit 288 px. Do not: use a segmented control for more
than four options or for an on and off choice.

## Choice

`.choice`: a single toggle outside a track, with the selected look of a segment and its own
`--line-strong` edge when off. Used for "Automatic" before the calendar colour swatches. No JSX
component; markup:

```html
<label class="choice"
  ><input type="radio" name="color" value="auto" checked /><span>Automatic</span></label
>
```

## Switch

File: `components.tsx`, `Switch`. Props: `name`, `label` (accessible name; must contain the
visible label of its property), `checked`, `value` (default `"1"`), `id`, `disabled`, `describedBy`.

```html
<input
  class="switch"
  type="checkbox"
  role="switch"
  id="cal-midnight"
  name="workUntilMidnight"
  value="1"
  aria-label="…"
/>
```

28 x 16 px. Off: `--control-line` track (3:1), white knob. On: `--accent` track, `--on-accent` knob.
The hit area grows to 40 px on a phone and 44 px on a coarse pointer (`::after`). It is the only
full-radius control.

## Swatches

CSS: `.swatches`, `.swatch`, `.swatch-dot` (`base.css` section 7). A swatch is a 20 px square with
a 4 px radius, like the calendar swatch: one shape means "colour". No JSX component; pages write
the markup (`calendars.tsx`, `ColorChecks` and `ColorRadios` in `mirroring.tsx`).

```html
<div
  class="swatches"
  role="radiogroup"
  aria-labelledby="cal-colour-label"
  aria-describedby="cal-colour-hint"
>
  <label class="swatch" title="Blue">
    <input type="radio" name="color" value="blue" aria-label="Blue" />
    <span class="swatch-dot" style="--c:#…"></span>
  </label>
</div>
```

- 20 px dot with an inset `--swatch-outline`. Chosen: a 2 px ring in `--text`, 2 px away. Hover:
  the same ring in `--line-strong`. Focus: 2 px accent outline, 4 px away.
- `.is-event`: a Google event colour, toned down in dark mode. `.is-none`: "no colour", an empty
  dot struck through in `--control-line`.
- Checkbox groups add `data-roving` (one tab stop, arrow keys, Home, End; `panel.js`) and
  `data-change-group` (one change in the save bar).

## Inputs and selects

`.input` (28 px, `--control-line` edge, `--surface`, 8 px padding; `.is-narrow` 72 px;
`textarea.input` grows) and `.select` (a wrapper with a CSS chevron around a native `<select>`).
Hover darkens the edge; focus shows a 2 px accent outline and an accent edge. Time inputs hide the
browser's clock icon. On a coarse pointer the text is 16 px.

```html
<input class="input cal-time" type="time" name="workStart" value="09:00" aria-label="Start" />
<span class="select"
  ><select name="kind">
    …
  </select></span
>
```

Disclosures (`summary`) get the same chevron, pointing right and turning down when open.

## Buttons

CSS: `.btn` plus one variant (`base.css` section 7). Height `--control-h`, 10 px padding, 13 px
weight 500, `--radius-control`.

| Class               | Look                                               | Use                                                                       |
| ------------------- | -------------------------------------------------- | ------------------------------------------------------------------------- |
| `.btn-primary`      | `--accent` fill, `--on-accent` text                | The one main action of a view (Save)                                      |
| `.btn-secondary`    | `--surface`, `--line-strong` edge                  | Other actions; header actions                                             |
| `.btn-ghost`        | No fill, `--text-2`                                | Close, Back, Discard in the save bar, Cancel                              |
| `.btn-danger`       | `--surface`, `--line-strong` edge, `--danger` text | The final button of a confirmation step                                   |
| `.btn-danger-ghost` | Ghost in `--danger`                                | A destructive choice without weight: "Discard" in the guard, "Disconnect" |
| `.btn-icon`         | Square                                             | Icon-only buttons; always with `aria-label`                               |

Disabled (`[disabled]` or `aria-disabled="true"`): 0.45 opacity, no pointer events. A pending
button (`.is-pending`) shows a progress cursor.

Do: one primary button per view. Do not: put a primary button in a list row.

## Notice

File: `components.tsx`, `Notice`. Props: `kind` (`info`, `warn`, `danger`), `title`, `children`,
`action`.

```html
<div class="notice notice-danger" role="alert">
  <svg aria-hidden="true">…</svg>
  <div class="notice-body">
    <span class="sr-only">Problem: </span>
    <div class="notice-title">…</div>
    …
  </div>
</div>
```

A tinted box: border `--tone` 28% with `--line`, background `--tone` 7% with `--surface`, both in
oklab, text in `--text`. The icon carries the tone. Only `danger` is announced at once
(`role="alert"`). The kind is read before the text. No left accent bar.

Use it for messages inside a page: a refused save in a panel, a page-level problem. Do not use it
for consequences of a save (those go into the save bar) or for "Saved".

## Empty state

`EmptyState` (`title`, `text`, `children` as actions): plain words and one action, left aligned,
max 440 px, 56 px from the top. No illustration.

## Dialogs

Both dialogs are native `<dialog>` elements opened with `showModal()`, so the browser traps focus
and Escape closes them. Backdrop `oklch(0% 0 0 / 0.35)`, `--surface-raised`, `--line-strong` edge,
`--radius-panel`, `--shadow-pop`.

- **Leave dialog** (`GuardDialog` in `components.tsx`, class `.guard`, `data-guard`): title "3
  unsaved changes", text, then "Discard" (`.btn-danger-ghost`), "Keep editing" (secondary,
  `autofocus`), "Save and leave" (primary). Texts come from `data-one`, `data-many`, `data-text-one`,
  `data-text-many`. Escape means "Keep editing".
- **Shortcut sheet** (`ShortcutSheet` in `palette.tsx`, classes `.palette .sheet`): a `dl` of
  shortcuts, a close button in a `method="dialog"` form, the title focused on open.

## Command palette

File: `src/pages/next/palette.tsx` (`Palette`, `PaletteTrigger`), script `public/next/palette.js`.
Opens with Cmd/Ctrl+K or the trigger in the sidebar (an icon button in the phone top bar). The
server renders every option from data the page has loaded; no request is made.

- Groups: Recent (filled by the script), Pages, Mirrorings, Calendars, Actions, Settings.
- The palette only navigates, opens panels, switches theme and language, and reloads calendars.
  No item signs out, deletes or changes a level.
- An ARIA combobox: the input has `role="combobox"`, the list `role="listbox"`, options
  `role="option"` with `aria-selected`. Arrow keys, Page Up and Down, Enter; Tab is held.
- Matching folds case and accents and also matches "ae", "oe", "ue" for umlauts.
- The result count is announced (`data-count` with `data-one`, `data-many`).
- A chosen link is clicked after the dialog closes, so enhanced navigation and the guard treat it
  as any click.
- Key hints (`kbd`) hide on touch.

## Calendar identity

File: `src/pages/next/identity.tsx`.

- **`CalendarSwatch`** (`account`, `label`): a 10 px SVG square, 3 px radius, in the calendar's
  lifted colour. Decorative by default; with `label` it is an image with that name. Put it before
  the calendar's name everywhere a calendar is named.
- **`ProviderGlyph`** (`provider`, `label`): the Microsoft or Google mark, 14 px, one neutral
  colour (`currentColor`, meant for `--text-3`). Use it only where the provider matters: the
  calendar's address line, the connect menu, sign-in buttons. Never tint it (see
  `icons-and-logo.md`).

## Level mark

File: `identity.tsx`, `LevelMark` (`level`, `tint`, `label`). A 16 px mark of what a copy carries.

| Level           | Mark                          | Meaning                                    |
| --------------- | ----------------------------- | ------------------------------------------ |
| `off`           | Dashed outline                | Not copied                                 |
| `busy-private`  | Hatched block + lock          | Busy only; others see a private event      |
| `busy-open`     | Hatched block                 | Busy only; others see the copy's own title |
| `title-private` | Block with one line + lock    | Title; others see no title                 |
| `title-open`    | Block with one line           | Title, for everyone                        |
| `full-private`  | Block with three lines + lock | Everything; others see neither             |
| `full-open`     | Block with three lines        | Everything, for everyone                   |

`tint` colours the hatch or lines in a calendar's colour (usually the source's); the frame stays in
the text colour. The lock is knocked out with `--glyph-ring`; set that token to the background
behind the mark. A new level adds one entry to `MARKS`; the compiler asks for it.

## Overview map

File: `src/pages/next/overview.tsx`, CSS `overview.css`. A table: rows are sources, columns are
targets, the diagonal is empty (`.ov-self`). Cells are 64 px links (`.ov-cell-link`) with the level
mark and level text, then a meta line joined by CSS middle dots.

| Cell class                                  | Look                                                         |
| ------------------------------------------- | ------------------------------------------------------------ |
| `.is-off`                                   | No box, muted text, so running mirrorings stand out as boxes |
| default (ok)                                | `--surface`, `--line` edge                                   |
| `.is-failed`                                | Edge `--danger` 45% with `--line` (70% on hover)             |
| `.is-overdue`, `.is-partial`, `.is-blocked` | Edge `--warn` 45% with `--line` (70% on hover)               |

Hover or focus on a cell lights up its row and column heads. With many calendars the map scrolls
sideways inside its box; the page never does. Below 720 px the map becomes a list that shares the
markup of the other lists. From 1280 px a 340 px side column (needs attention, changes) sits next to
the map.

## Activity rows and groups

File: `src/pages/next/activity.tsx`, CSS `activity.css`. Rows on fixed columns: time, mark, what
happened, who, duration. The route shows as the two calendars' swatches. Joined runs are a native
`<details>` whose `summary` is the row; the chevron sits in the duration column. Filters are
selects in a GET form; applied filters show as removable chips (`.act-chip`, 4 px radius "like a
tag, not a pill"). A pager and a retention note close the page.

## Public layout

File: `src/pages/next/public-layout.tsx`, CSS `public.css`. For sign-in, setup, messages, errors,
consent and privacy for visitors.

Props: `title`, `lead`, `width` (`narrow` 420 px, `wide` 640 px), `languageSwitch` (off on pages
whose query comes from a foreign site), `user`, `children`.

One column on the chrome background: the brand, one raised panel (`.pub-panel`, hairline, 10 px
radius, no shadow), a footer with privacy, language and theme. Shared text parts: `.pub-text`,
`.pub-fine`, `.pub-facts` (label and value pairs), `.pub-steps` (setup checklist), `.pub-providers`
(equal provider buttons, mark in the text colour), `.pub-copy` (a value to copy, as a read-only
code field), `.pub-prose` (privacy text). `.pub-flow` serves the same pages inside `Shell` for a
signed-in user.

## Confirmation step for destructive actions

File: `src/pages/next/admin-parts.tsx`, `DangerSection` and `ConfirmStep`.

1. The panel's last section (`DangerSection`) holds one ghost danger link and a hint. The link goes
   to the same panel with `?confirm=<action>`; nothing is deleted by this click, and it works
   without script.
2. The confirmation panel (`ConfirmStep`) names in one sentence what happens and that it cannot be
   undone, with an optional muted note. A `.btn-danger` submit posts the action; a ghost link
   returns to the panel as it was.

Used for deleting a person (Admin, `confirm=delete`), revoking a token and disconnecting an app
(API tokens, `confirm=revoke`, `confirm=disconnect`).

## Known inconsistencies

None. The consistency pass of 2026-11-18 left one danger ghost button (`.btn-danger-ghost`, base.css),
one stretched row link (`.row-open`, base.css), the disconnect step in the calendar panel
(`?confirm=disconnect`), one `LanguageLink` (exported from `shell.tsx`), no `hidden` on controls
that carry `data-needs-script`, and one session-end text (`shell.panel.sessionEnded`).
