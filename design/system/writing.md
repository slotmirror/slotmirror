# Writing

All user-facing text lives in `src/i18n/`. The redesign's catalogs are in `src/i18n/next/` (`shell`,
`overview`, `mirroring`, `calendars`, `activity`, `admin`, `tokens`, `palette`, `auth`). Each file
exports an English object that defines the shape and a German object typed with it; `en.ts` and
`de.ts` wire them under `t.next.*`.

## Adding a string

1. Add the key to the English object of the right catalog. Add a doc comment if the use is not
   obvious.
2. Add the German value. The type (`typeof <name>En`) fails the typecheck if it is missing, and
   `test/i18n.test.ts` fails if the catalogs differ.
3. Counts are functions: `(count: number) => …`, with a singular form for 1. Format the number with
   `formatCount(count, locale)` from `src/i18n/next/overview.ts` (`Intl.NumberFormat`).
4. A text a script needs goes into markup as a `data-*` attribute or a hidden element, never into
   the script. Placeholders in such strings use `{n}` or `{title}`.

## Vocabulary

One word per concept. English and German as shipped in the catalogs:

| Concept                                          | English                                                                              | German                                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| One direction from a source to a target calendar | mirroring                                                                            | Spiegelung                                                                                               |
| A block written into the target                  | copy, copies                                                                         | Kopie, Kopien                                                                                            |
| A connected account or calendar                  | calendar                                                                             | Kalender                                                                                                 |
| The route of a mirroring                         | "{from} to {to}" (`fromTo`)                                                          | "{from} nach {to}"                                                                                       |
| What a copy carries                              | "What is copied"                                                                     | "Was kopiert wird"                                                                                       |
| Who else sees a copy                             | "What others see"                                                                    | "Was andere sehen"                                                                                       |
| A sync run                                       | run ("Last run 8 min")                                                               | Lauf ("Letzter Lauf …")                                                                                  |
| Nav pages                                        | Overview, Mirroring, Calendars, Activity, API tokens, Admin                          | Übersicht, Spiegelung, Kalender, Aktivität, API-Tokens, Verwaltung                                       |
| Providers                                        | Microsoft 365, Google Calendar                                                       | Microsoft 365, Google Kalender                                                                           |
| Status words                                     | In sync, Needs attention, Failed, No run yet                                         | Aktuell, Zu prüfen, Fehlgeschlagen, Noch kein Lauf                                                       |
| Run phrases                                      | Failed, "{n} not written", Catching up, Paused, "No run for {time}", Connection lost | Fehlgeschlagen, "{n} nicht geschrieben", Holt auf, Pausiert, "{time} ohne Lauf", Verbindung unterbrochen |

## Level and visibility wording

Two questions decide a level: "What is copied" (`copyOptions`) and "What others see"
(`whoOptions`).

| Answer        | English       | German          |
| ------------- | ------------- | --------------- |
| copy `off`    | Not copied    | Nicht kopiert   |
| copy `busy`   | Busy only     | Nur belegt      |
| copy `title`  | Title         | Titel           |
| copy `full`   | Everything    | Alles           |
| who `private` | Private event | Privater Termin |
| who `open`    | Same as you   | Dasselbe wie du |

Summary forms (`t.next.shell.levels`), for rows, the panel and the palette, and the short forms for
map cells:

| Level           | Summary (en)             | Short (en)     | Summary (de)         | Short (de)     |
| --------------- | ------------------------ | -------------- | -------------------- | -------------- |
| `off`           | Not copied               | Off            | Nicht kopiert        | Aus            |
| `busy-private`  | Busy only, private       | Busy, private  | Nur belegt, privat   | Belegt, privat |
| `busy-open`     | Busy only, for everyone  | Busy           | Nur belegt, für alle | Belegt         |
| `title-private` | Title, private           | Title, private | Titel, privat        | Titel, privat  |
| `title-open`    | Title, for everyone      | Title          | Titel, für alle      | Titel          |
| `full-private`  | Everything, private      | All, private   | Alles, privat        | Alles, privat  |
| `full-open`     | Everything, for everyone | All            | Alles, für alle      | Alles          |

## Sentence patterns

- **Consequence notes** (save bar) say who will see what after the save, with both calendar names:
  "Others with access to {to} will see the titles of your events in {from}." A private level says
  what you see and what others do not: "You will see the titles from {from} in {to}. Others see no
  title." A lower level that stays visible: "Others still see the titles of your events." Removal:
  "60 copies will be removed from {target}."
- **Self-renaming primary button.** While a widening note shows, Save names the effect: "Show titles
  to everyone", "Show details to everyone", "Show “{title}” to everyone" (titles up to 24
  characters, else "Show copies to everyone"), "Make 6 mirrorings visible to everyone".
- **Status phrases** are short and lead with the state: "Failed 8 min", "Connection lost". A fine
  state is only a time.
- **Errors** say what happened and that nothing is lost: "Could not save. Your changes are still
  here." A session end says what to do: "Sign in again in another tab, then save."
- **The leave dialog** counts: "3 unsaved changes", "If you leave now, the changes are lost."
- **Empty states**: a title, one sentence, one action. No illustration, no joke.
- **Labels**: verb plus object for actions ("Delete my data", "Save and leave", "Connect Google
  Calendar"); nouns for properties ("What is copied", "Working hours").

## Numbers, dates and times

- Counts: `formatCount()` (`Intl.NumberFormat` per locale): "1,234" in English, "1.234" in German.
- Short ages: `shortAge()` in `src/pages/next/overview.tsx`, `Intl.NumberFormat` with
  `style: "unit"` and `unitDisplay: "short"` in days, hours or minutes; under a minute the
  catalog's "now" word. The exact time goes into the `title` of the `<time>` element
  (`formatTimestamp`).
- Weekdays: Monday first, short names from `t.next.shell.weekdays` ("Mon", "Mo").
- Numbers in columns carry `.num` (tabular figures).

## Style

- Sentence case for titles, labels and buttons ("What is copied", "Keep editing").
- A list separator in a line is the middle dot " · ", drawn by CSS where it
  can be (`.detail-meta-sep`, `.ov-cell-meta`).
- Quotes: “…” in English, „…“ in German, around a copy title or a level name.
- German addresses the person with "du" ("Deine Änderungen sind noch da", "Melde dich … an").
- Name the product in lower case: slotmirror.
- No em dashes in UI text. Ranges use an en dash without spaces ("Mon–Fri", "{first}–{last}" in Activity).

## Known inconsistencies

- **Two words for the open visibility.** The answer to "What others see" is "Same as you", but the
  level summaries say "for everyone" and the Save labels "to everyone". One value, two names.
- **English counts without `formatCount`.** `t.next.shell.run.notWritten` in English interpolates
  the raw number; the German form and `copies` use `formatCount()`.
- **Two session-end texts.** `panel.sessionEnded` adds "Sign in again in another tab, then save.";
  `enhance.sessionEnded` (the live region) ends before that sentence.
