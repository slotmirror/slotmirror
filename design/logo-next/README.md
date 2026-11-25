# Logo directions (draft, 2026-11-17)

Four candidate directions for the redesign. Direction A, `eyes/`, is the shipped logo: the favicon,
the app icons and the mark in the app come from it. The other three directions stay drafts and are
not in use. The previous logo is in `design/logo/`.

| Directory     | Direction                                                                 |
| ------------- | ------------------------------------------------------------------------- |
| `eyes/`       | A, Eyes refined: the current mark redrawn                                 |
| `reflection/` | B, Reflection: one tile, the original above a mirror line, the copy below |
| `letter/`     | C, Wordmark: Inter Display only, the s in an accent tile as square mark   |
| `turn/`       | D, Turn: an s from one hook and the same hook turned 180 degrees          |

Files per direction:

- `mark.svg`, `mark-dark.svg`: 24 px and up. `mark-mono.svg` uses `currentColor`.
- `mark-small*.svg`: the 16 px drawing (also used at 20 px). `eyes/` has `mark-20*.svg` for 20 px.
- `lockup.svg`, `lockup-dark.svg`: mark and wordmark; the wordmark is Inter Display as outlines.
- `app-icon.svg`, `app-icon-dark.svg`: 512 px superellipse tile for the desktop app. iOS and
  Android apply their own mask; export a full-bleed square from the same mark for them.
- `favicon.svg`: the 16 px drawing with light and dark in one file (`prefers-color-scheme`).

Rule shared by all directions: the copy has the colour of the original. From 24 px it is hatched
at 45 degrees, like the "busy only" level glyph; below 24 px it is a flat tint.
