# slotmirror design system

This folder describes the design language of the app pages under `/next` and of the public pages
(sign-in, setup, messages). It describes the code as it is. If the code and this text disagree, the
code wins, and this text needs a fix.

## The language in ten lines

1. Calm and dense. A 13 px base size, 40 px list rows, 28 px controls, one 4 px grid.
2. Neutral greys with a slight blue hue (OKLCH hue 255), one blue accent (hue 258).
3. Calendar colours are the only strong colours on a page. They mark identity, not state.
4. State colours (`--ok`, `--warn`, `--danger`) appear as small dots and short words, never as fills.
5. The hatch motif: a hatched block is a copy, a solid block is the original. The logo, the level
   mark and the preview of a busy copy use it.
6. One raised main panel on a chrome background, a detail panel on the right, no cards in cards.
7. Hairlines, not boxes. Separators take no height (a 1 px layer), so rows stay on whole pixels.
8. Server-rendered pages. Every page works without script; script adds speed and comfort only.
9. Light and dark everywhere, from the same tokens (`light-dark()` in `public/next/base.css`).
10. Plain words. A state is spelled out only when it is not fine.

## Principles

- **One accent.** Use `--accent` for the primary button, focus rings, links, the switch when on and
  the changed-property dot. A second accent colour dilutes the one action on the screen.
- **Identity is not state.** A calendar colour never says "ok" or "failed". The two meanings must
  not compete for one colour channel.
- **Words over colour.** Every coloured mark has text next to it or an accessible name. Colour
  blindness and forced colours must not hide a state.
- **Quiet when fine.** A fine state shows a dot and a time ("8 min"). Words such as "Failed" appear
  only when something needs attention, so that they stand out.
- **One way per pattern.** One save model, one status vocabulary, one property grid, one place for
  "Saved". Each repetition of a pattern teaches the next screen.
- **No script needed.** Links and forms are real links and forms. A control that needs script
  carries `data-needs-script`, and CSS hides it on a page without the `js` class.
- **Fixed geometry.** Columns, row heights and control heights do not move when content or the
  panel changes. The list keeps its x when the panel opens.
- **Touch is a first-class input.** On a coarse pointer every control is 44 px high and inputs
  are 16 px, so that iOS does not zoom.

## Not allowed

- Gradients, glass effects (backdrop blur), glow.
- Emoji in the UI.
- Full-radius pills. The one exception is the switch (`.switch`, radius 8 px on a 16 px track).
  Status dots are circles; colour swatches are small squares.
- Icon tiles with coloured backgrounds.
- Coloured accent bars on the left edge of cards, callouts or notices.
- Decorative illustration, also in empty states (`.empty` is "plain words and one action").
- `<hr>` elements. Use a section hairline (`.section + .section`) or `.menu-sep` in a menu.
- Controls that show only on hover. Touch has no hover, and keyboard users cannot find them.
- A tinted provider mark (see `icons-and-logo.md`).
- `prefers-color-scheme` media queries in page CSS. Themes come only from `light-dark()` tokens
  and `html[data-theme]`.

## How to check a UI change

Do all of these before you call a UI change done:

1. Both themes. Use the theme switch in the user menu, or `?theme=light` and `?theme=dark`.
2. Two widths: 1440 px and 390 px. Also look at 960 px, where the panel starts to cover the list.
3. Both languages. German strings are longer; the layout must hold them at 390 px and at 320 px.
4. Keyboard only: Tab order, visible focus, Escape, Cmd/Ctrl+Enter, the arrow keys in lists.
5. Without JavaScript. Every page must load, link and save as plain HTML.
6. The browser checks in both modes against a dev server:
   `MODE=on test/browser/run-all.sh` and `MODE=off test/browser/run-all.sh`
   (see `test/browser/README.md`).
7. The size budget test, `test/perf-budget.node.test.ts`. The CSS budget has little headroom, so
   a new rule in `base.css` or a page stylesheet can fail it.
8. `pnpm check` (format, lint, typecheck, tests), as for every commit.

## Files

| File                                   | Content                                                             |
| -------------------------------------- | ------------------------------------------------------------------- |
| [tokens.md](tokens.md)                 | Every custom property, type, spacing, breakpoints, motion, contrast |
| [components.md](components.md)         | Components and patterns: JSX, class contract, states, keyboard      |
| [behaviour.md](behaviour.md)           | URL state, save model, guard, enhanced navigation, focus, keys      |
| [writing.md](writing.md)               | Vocabulary, level wording, sentence patterns, formats, i18n         |
| [icons-and-logo.md](icons-and-logo.md) | Icons, level mark, provider glyphs, app icons, logo state           |

## Source files

| Path                               | Content                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------- |
| `public/next/base.css`             | Tokens, reset, shell, list, panel, controls, motion, palette            |
| `public/next/<page>.css`           | Page additions: overview, mirroring, calendars, activity, admin, public |
| `src/pages/next/components.tsx`    | Shared JSX: list, panel, save bar, property row, controls, notice       |
| `src/pages/next/shell.tsx`         | App shell, navigation, header action, head, script list                 |
| `src/pages/next/identity.tsx`      | Calendar swatch, provider glyph, level mark                             |
| `src/pages/next/run-status.tsx`    | The status vocabulary of rows and panel heads                           |
| `src/pages/next/palette.tsx`       | Command palette, shortcut sheet, single-key switch                      |
| `src/pages/next/public-layout.tsx` | Layout of the pages outside the app                                     |
| `public/next/*.js`                 | Theme, panel, enhanced navigation, palette, page scripts                |
| `src/i18n/next/`                   | Message catalogs of the redesign                                        |
