import { formatCount } from "./overview";

/**
 * Strings of the mirroring page of the redesign. The English object defines the shape; the German
 * one must match it. `en.ts` and `de.ts` wire both under `next.mirroring`.
 */
export const mirroringEn = {
  title: "Mirroring",
  settings: "For all mirrorings",
  appearsInPrefix: "Appears in",
  appearsIn: (name: string) => `Appears in ${name}`,
  fromTo: (from: string, to: string) => `${from} to ${to}`,
  hoursHint: (hours: string) => `Working hours ${hours}`,
  tags: {
    categories: (count: number) => (count === 1 ? "1 category" : `${count} categories`),
    colors: (count: number) => (count === 1 ? "1 colour" : `${count} colours`),
    hours: "Working hours",
    color: (name: string) => `Colour ${name}`,
    category: (name: string) => `Category ${name}`,
  },
  /**
   * The accessible name of a list row. `status` holds the copies and the run ("60 copies. Last run
   * 8 min"), or null for a mirroring that is off.
   */
  rowLabel: (source: string, target: string, level: string, status: string | null) =>
    status ? `${source} to ${target}: ${level}. ${status}` : `${source} to ${target}: ${level}`,
  notices: {
    reconnectTitle: (name: string) => `${name}: connection lost`,
    reconnectText: "Nothing is copied to or from it until you reconnect it.",
    reconnect: "Reconnect",
    missingTitle: (names: string) => `No calendars loaded for ${names}`,
    missingText: "slotmirror could not read the calendars yet.",
    missingGoogle:
      "For Google: allow calendar access when you connect. If that does not help, the operator must turn on the Google Calendar API.",
    checkAgain: "Reload calendars",
    startTitle: "Nothing is mirrored yet",
    startText: (count: number) =>
      count === 2
        ? "Both calendars then show each other's events as busy. You can change each mirroring later."
        : `Each of the ${count} calendars then shows the others' events as busy. You can change each mirroring later.`,
    startButton: "Mirror all as busy",
    /** `?d=` names a mirroring that the state does not have, for example after a disconnect. */
    gone: "This mirroring no longer exists.",
  },
  empty: {
    noneTitle: "Connect your first calendar",
    oneTitle: "Connect a second calendar",
    text: "Connect two calendars to mirror between them.",
    action: "Go to calendars",
  },
  whatIsCopied: "What is copied",
  copyOptions: {
    off: "Not copied",
    busy: "Busy only",
    title: "Title",
    full: "Everything",
  },
  /** One line about the chosen answer to "what is copied". */
  copyHints: {
    off: (source: string, target: string) => `Nothing from ${source} appears in ${target}.`,
    busy: "Only the time, without the title.",
    title: "The time and the title.",
    full: "Time, title, location and description.",
  },
  copyHint: {
    cap: (level: string) => `Your organisation allows at most “${level}” here.`,
    readOnly: (target: string) =>
      `slotmirror cannot write to ${target}. You can only turn this mirroring off.`,
  },
  whoSees: "What others see",
  whoOptions: {
    private: "Private event",
    open: "Same as you",
  },
  /**
   * The mark next to the preselected answer of a mirroring that is off: the answer comes from the
   * default under "For all mirrorings", not from the mirroring.
   */
  whoDefaultMark: "Default",
  whoDefaultNote: "Preselected from your default under “For all mirrorings”.",
  /**
   * The calendars of the source carry different marks. No answer is preselected; the one the
   * person picks applies to every calendar of the source.
   */
  mixedMarks: (from: string) =>
    `Some calendars of ${from} are copied as private events, others as they are. When you save, your answer here applies to each of them.`,
  /** One line about the chosen answer to "what others see". It depends on the target provider. */
  whoHint: {
    privateMicrosoft: (target: string) =>
      `Others with access to ${target} see a private event at that time, without title or details.`,
    privateGoogle: (target: string) =>
      `Others with access to ${target} see only “Busy” at that time.`,
    openBusy: (target: string, blockTitle: string) =>
      `Others with access to ${target} see “${blockTitle}” at that time, as you do.`,
    openTitle: (target: string) =>
      `Others with access to ${target} see the titles of your events, as you do.`,
    openFull: (target: string) =>
      `Others with access to ${target} see title, location and description, as you do.`,
    /** Who "others" are, after an open answer. Google also has published calendars. */
    othersMicrosoft:
      "Others are people the calendar is shared with or who manage it. People who only see free/busy never see titles.",
    othersGoogle:
      "Others are people the calendar is shared with or published to, or who manage it. People who only see free/busy never see titles.",
  },
  preview: {
    title: "Preview",
    you: "You see",
    others: "Others see",
    /** A mirroring with mixed marks, before the person answers "What others see". */
    answerFirst: "Choose what others see to show the preview.",
    notThere: (target: string) => `Nothing appears in ${target}.`,
    /** The label of a private copy as others see it, by target provider. */
    privateMicrosoft: "Private event",
    privateGoogle: "Busy",
    stillSees: "Who still sees it?",
    /** Events that are private in the source arrive with the copies' own title, at any level. */
    privateSourceArrives: (source: string, blockTitle: string) =>
      `Events that are private in ${source} arrive only as “${blockTitle}”.`,
  },
  limits: "Limits",
  hours: {
    /** The label in the property grid, under "Limits". The switch is named by `label`, which contains it. */
    short: "Working hours",
    label: (target: string) => `Only during working hours of ${target}`,
    hint: (target: string, hours: string) =>
      `${target}: ${hours}. Only events that touch these hours are copied, with their full times.`,
    /** The hint while the switch is off. */
    hintOff: "Copied at any time.",
    change: "Change working hours",
    missing: (target: string) => `${target} has no working hours yet.`,
    set: "Set working hours",
  },
  only: {
    categories: "Only these categories",
    colors: "Only these colours",
    categoriesHint: (source: string) =>
      `Leave empty to copy every event of ${source}. Separate names with commas.`,
    colorsHint: (source: string) => `Leave empty to copy every event of ${source}.`,
    placeholder: "e.g. Work, Customer",
  },
  copies: {
    title: "Look of the copies",
    color: "Colour of the copies",
    category: "Category of the copies",
    /** Labels in the property grid, under the section title "Look of the copies". */
    colorShort: "Colour",
    categoryShort: "Category",
    none: "No colour",
    categoryPlaceholder: "None set",
  },
  /**
   * The categories or colours that a copy carries from its event, under "Look of the copies".
   * Nothing passes unless it is listed, because a category name or a colour can give away what an
   * event is about.
   */
  pass: {
    /** Labels in the property grid: the source's categories (Outlook) or colours (Google). */
    categories: "Carry categories",
    colors: "Carry colours",
    categoriesHint:
      "A copy carries each of these categories that its event has. No other category passes, because a name can give away what an event is about. Separate names with commas.",
    colorsHint:
      "A copy carries the colour of its event if it is chosen here. No other colour passes, because a colour can give away what an event is about.",
    /** Outlook to Google: each row gives a category of the source a colour in the target. */
    rowsHint:
      "A copy of an event with a listed category gets the colour of its row; the first matching row wins over the colour of the copies. Nothing else passes. Clear a name to remove its row.",
    /** Google to Outlook: each row gives a colour of the source a category in the target. */
    rowsHintColors:
      "A copy of an event in a listed colour gets the category of its row. Nothing else passes. Clear a name to remove its row.",
    placeholder: "e.g. Focus",
    /** The accessible names of the two fields of a row. */
    category: (calendar: string) => `Category in ${calendar}`,
    color: (calendar: string) => `Colour in ${calendar}`,
    /** The empty choice of a row's colour. */
    chooseColor: "Choose a colour",
    addRow: "Add a row",
  },
  /**
   * A save of a form drawn before another tab or device changed the mirroring, or one whose rules
   * changed while it ran. The save is one batch, so nothing was stored; the panel shows the stored
   * values.
   */
  conflict:
    "Not saved. This mirroring was changed in another tab or on another device after you opened it. The panel now shows the current settings. Make your change again if you still want it.",
  /** The reason under the field that caused a refusal. The panel says "Nothing was saved." on top. */
  fieldErrors: {
    categoryComma:
      "A category name cannot contain a comma: Outlook reads the comma as the start of a second category.",
    categoryTooLong: (max: number) => `A category name can have at most ${max} characters.`,
    colorInvalid: "This colour does not fit the calendar. Reload the page.",
    onlyGoogle: "Google events have colours, not categories. Choose colours instead.",
    /** A name to carry with a comma or too many characters. */
    passName: (max: number) =>
      `A category name cannot contain a comma and can have at most ${max} characters.`,
    passIncomplete: "Every row needs a category name and a colour.",
    passTooMany: (max: number) => `You can carry at most ${max} categories.`,
    /** A copied level of a mirroring with mixed marks, without an answer to "What others see". */
    whoRequired: (from: string) =>
      `Choose what others see. Your answer applies to each calendar of ${from}.`,
  },
  /** A save that would have written nothing for the change the user asked for. */
  notSaved: {
    readOnly: (target: string) =>
      `Nothing was saved: slotmirror cannot write to ${target}. You can only turn this mirroring off.`,
    cap: (level: string) => `Nothing was saved: your organisation allows at most “${level}” here.`,
    gone: "Nothing was saved: this mirroring changed in the meantime. Reload the page.",
  },
  bar: {
    /** The label of the Save button while a change shows titles or details to others. */
    button: {
      "title-open": "Show titles to others",
      "full-open": "Show details to others",
    },
    /**
     * The label of the Save button when a mirroring that is off is turned on as "Same as you" at
     * Busy only: others then see the copy's own title. A long title gets the general label.
     */
    buttonBusy: (blockTitle: string) =>
      blockTitle.length <= 24 ? `Show “${blockTitle}” to others` : "Show copies to others",
    /** The label of the Save button while "Not copied" removes copies. */
    turnOff: "Turn off",
    /** Who will see what after the save, for each level that shows more than the saved one. */
    sentence: {
      "busy-private": (from: string, to: string) =>
        `Others with access to ${to} will see when you are busy in ${from}, without a title.`,
      "busy-open": (from: string, to: string, blockTitle: string) =>
        `Others with access to ${to} will see “${blockTitle}” when you are busy in ${from}.`,
      "title-private": (from: string, to: string) =>
        `You will see the titles from ${from} in ${to}. Others see no title.`,
      "title-open": (from: string, to: string) =>
        `Others with access to ${to} will see the titles of your events from ${from}.`,
      "full-private": (from: string, to: string) =>
        `You will see titles and details from ${from} in ${to}. Others see neither.`,
      "full-open": (from: string, to: string) =>
        `Others with access to ${to} will see titles, locations and descriptions of your events from ${from}.`,
    },
    /** "Busy only, same as you" from a level that is copied already: others see the copy's title. */
    busyTitleShown: (to: string, blockTitle: string) =>
      `Others with access to ${to} will see your copies titled “${blockTitle}”.`,
    /** A lower level while "Same as you" stays: what others still see. Not a warning. */
    stillSeesBusy: (blockTitle: string) => `Others still see the copy, titled “${blockTitle}”.`,
    stillSeesTitles: "Others still see the titles of your events.",
    /** "Same as you" back to "Private event": what others see again, by target provider. */
    privateAgain: {
      microsoft: "Others see a private event again.",
      google: "Others see only “Busy” again.",
    },
    /** "Not copied" for a mirroring with copies. `count` is null if the last runs do not say. */
    copiesRemoved: (count: number | null, target: string) =>
      count === null
        ? `The copies in ${target} will be removed.`
        : count === 1
          ? `1 copy will be removed from ${target}.`
          : `${formatCount(count, "en")} copies will be removed from ${target}.`,
    whoChanges: "Existing copies change within a few minutes.",
  },
  all: {
    title: "All mirrorings",
    window: "How far ahead",
    windowHint: "Events up to this many days from today are copied.",
    days: (count: number) => `${count} days`,
    blockTitle: "Title of busy copies",
    blockTitleHint: "Leave empty for “Busy”.",
    blockTitlePlaceholder: (title: string) => `Default: ${title}`,
    whoDefault: "What others see, by default",
    whoDefaultHint:
      "Used when you turn a mirroring on. A mirroring keeps its own choice while it is on.",
    applyWho: (count: number) =>
      count === 1
        ? "Also apply to 1 existing mirroring"
        : `Also apply to ${count} existing mirrorings`,
    applyPrivate: (count: number) =>
      count === 1
        ? "1 mirroring switches to “Private event”. Existing copies change within a few minutes."
        : `${count} mirrorings switch to “Private event”. Existing copies change within a few minutes.`,
    /**
     * What "Same as you" for existing mirrorings shows, per kind of copy. `targets` names the
     * target calendars, joined by `list`.
     */
    applyOpen: {
      busy: (targets: string, blockTitle: string) =>
        `In ${targets}, others will see “${blockTitle}” where they see a private event today.`,
      title: (targets: string) =>
        `In ${targets}, others will see the titles of your events where they see a private event today.`,
      full: (targets: string) =>
        `In ${targets}, others will see titles and details of your events where they see a private event today.`,
      titleOrFull: (targets: string) =>
        `In ${targets}, others will see titles or details of your events where they see a private event today.`,
    },
    applyOpenButton: (count: number) =>
      count === 1
        ? "Make 1 mirroring visible to others"
        : `Make ${count} mirrorings visible to others`,
    list: (names: string[]) =>
      names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`,
    conflict:
      "Not saved. The settings for all mirrorings were changed in another tab or on another device after you opened them. The panel now shows the current settings. Make your change again if you still want it.",
    skipTitle: "What is skipped",
    /**
     * Under the title "What is skipped": a switch that is on skips, so its label says "Skip".
     * The accessible names equal the visible labels.
     */
    skipCategories: "Skip events with these categories",
    skipCategoriesLabel: "Categories",
    skipCategoriesHint: "Separate names with commas.",
    skipCategoriesPlaceholder: "e.g. Private, Focus",
    skipColors: "Skip Google events with these colours",
    skipColorsLabel: "Google colours",
    skipAllDay: "Skip all‑day events",
    skipAllDayLabel: "Skip all‑day events",
    skipAllDayHint:
      "Otherwise holidays and days off block whole days, unless they are marked as free.",
    skipTentative: "Skip tentative events",
    skipTentativeLabel: "Skip tentative events",
    skipTentativeHint: "“Maybe” answers and tentative events do not block.",
  },
};

export type MirroringMessages = typeof mirroringEn;

export const mirroringDe: MirroringMessages = {
  title: "Spiegelung",
  settings: "Für alle Spiegelungen",
  appearsInPrefix: "Erscheint in",
  appearsIn: (name) => `Erscheint in ${name}`,
  fromTo: (from, to) => `${from} nach ${to}`,
  hoursHint: (hours) => `Arbeitszeit ${hours}`,
  tags: {
    categories: (count) => (count === 1 ? "1 Kategorie" : `${count} Kategorien`),
    colors: (count) => (count === 1 ? "1 Farbe" : `${count} Farben`),
    hours: "Arbeitszeit",
    color: (name) => `Farbe ${name}`,
    category: (name) => `Kategorie ${name}`,
  },
  rowLabel: (source, target, level, status) =>
    status ? `${source} nach ${target}: ${level}. ${status}` : `${source} nach ${target}: ${level}`,
  notices: {
    reconnectTitle: (name) => `${name}: Verbindung unterbrochen`,
    reconnectText:
      "Bis du ihn neu verbindest, wird nichts aus diesem oder in diesen Kalender kopiert.",
    reconnect: "Neu verbinden",
    missingTitle: (names) => `Keine Kalender geladen für ${names}`,
    missingText: "slotmirror konnte die Kalender noch nicht lesen.",
    missingGoogle:
      "Bei Google: Erlaube beim Verbinden den Kalenderzugriff. Hilft das nicht, muss der Betreiber die Google Calendar API einschalten.",
    checkAgain: "Kalender neu laden",
    startTitle: "Noch wird nichts gespiegelt",
    startText: (count) =>
      count === 2
        ? "Dann zeigen beide Kalender die Termine des anderen als belegt. Jede Spiegelung kannst du später ändern."
        : `Dann zeigt jeder der ${count} Kalender die Termine der anderen als belegt. Jede Spiegelung kannst du später ändern.`,
    startButton: "Alle als belegt spiegeln",
    gone: "Diese Spiegelung gibt es nicht mehr.",
  },
  empty: {
    noneTitle: "Verbinde deinen ersten Kalender",
    oneTitle: "Verbinde einen zweiten Kalender",
    text: "Verbinde zwei Kalender, um zwischen ihnen zu spiegeln.",
    action: "Zu den Kalendern",
  },
  whatIsCopied: "Was kopiert wird",
  copyOptions: {
    off: "Nicht kopiert",
    busy: "Nur belegt",
    title: "Titel",
    full: "Alles",
  },
  copyHints: {
    off: (source, target) => `In ${target} erscheint nichts aus ${source}.`,
    busy: "Nur die Zeit, ohne Titel.",
    title: "Zeit und Titel.",
    full: "Zeit, Titel, Ort und Beschreibung.",
  },
  copyHint: {
    cap: (level) => `Deine Organisation erlaubt hier höchstens „${level}“.`,
    readOnly: (target) =>
      `slotmirror kann nicht in ${target} schreiben. Du kannst diese Spiegelung nur ausschalten.`,
  },
  whoSees: "Was andere sehen",
  whoOptions: {
    private: "Privater Termin",
    open: "Wie bei dir",
  },
  whoDefaultMark: "Standard",
  whoDefaultNote: "Vorausgewählt aus deinem Standard unter „Für alle Spiegelungen“.",
  mixedMarks: (from) =>
    `Einige Kalender aus ${from} werden als privater Termin kopiert, andere so, wie du sie siehst. Beim Speichern gilt deine Antwort hier für jeden dieser Kalender.`,
  whoHint: {
    privateMicrosoft: (target) =>
      `Andere mit Zugriff auf ${target} sehen zu dieser Zeit einen privaten Termin, ohne Titel und Details.`,
    privateGoogle: (target) =>
      `Andere mit Zugriff auf ${target} sehen zu dieser Zeit nur „Beschäftigt“.`,
    openBusy: (target, blockTitle) =>
      `Andere mit Zugriff auf ${target} sehen zu dieser Zeit „${blockTitle}“, wie du.`,
    openTitle: (target) =>
      `Andere mit Zugriff auf ${target} sehen die Titel deiner Termine, wie du.`,
    openFull: (target) =>
      `Andere mit Zugriff auf ${target} sehen Titel, Ort und Beschreibung, wie du.`,
    othersMicrosoft:
      "Andere sind Personen, für die der Kalender freigegeben ist oder die ihn verwalten. Wer nur Frei/Gebucht sieht, sieht nie Titel.",
    othersGoogle:
      "Andere sind Personen, für die der Kalender freigegeben oder veröffentlicht ist oder die ihn verwalten. Wer nur Frei/Gebucht sieht, sieht nie Titel.",
  },
  preview: {
    title: "Vorschau",
    you: "Du siehst",
    others: "Andere sehen",
    answerFirst: "Wähle, was andere sehen, um die Vorschau zu zeigen.",
    notThere: (target) => `In ${target} erscheint nichts.`,
    privateMicrosoft: "Privater Termin",
    privateGoogle: "Beschäftigt",
    stillSees: "Wer sieht es trotzdem?",
    privateSourceArrives: (source, blockTitle) =>
      `Termine, die in ${source} privat sind, kommen nur als „${blockTitle}“ an.`,
  },
  limits: "Einschränkungen",
  hours: {
    short: "Arbeitszeit",
    label: (target) => `Nur in der Arbeitszeit von ${target}`,
    hint: (target, hours) =>
      `${target}: ${hours}. Nur Termine, die diese Zeit berühren, werden kopiert, mit ihrer vollen Dauer.`,
    hintOff: "Wird zu jeder Zeit kopiert.",
    change: "Arbeitszeit ändern",
    missing: (target) => `${target} hat noch keine Arbeitszeit.`,
    set: "Arbeitszeit festlegen",
  },
  only: {
    categories: "Nur diese Kategorien",
    colors: "Nur diese Farben",
    categoriesHint: (source) =>
      `Leer lassen, um jeden Termin von ${source} zu kopieren. Namen mit Komma trennen.`,
    colorsHint: (source) => `Leer lassen, um jeden Termin von ${source} zu kopieren.`,
    placeholder: "z. B. Arbeit, Kunde",
  },
  copies: {
    title: "Darstellung der Kopien",
    color: "Farbe der Kopien",
    category: "Kategorie der Kopien",
    colorShort: "Farbe",
    categoryShort: "Kategorie",
    none: "Keine Farbe",
    categoryPlaceholder: "Keine festgelegt",
  },
  pass: {
    categories: "Kategorien übernehmen",
    colors: "Farben übernehmen",
    categoriesHint:
      "Eine Kopie übernimmt jede dieser Kategorien, die ihr Termin hat. Keine andere Kategorie wird übernommen, denn ein Name kann verraten, worum es im Termin geht. Namen mit Komma trennen.",
    colorsHint:
      "Eine Kopie übernimmt die Farbe ihres Termins, wenn sie hier gewählt ist. Keine andere Farbe wird übernommen, denn eine Farbe kann verraten, worum es im Termin geht.",
    rowsHint:
      "Die Kopie eines Termins mit einer gelisteten Kategorie bekommt die Farbe ihrer Zeile; die erste passende Zeile geht vor der Farbe der Kopien. Sonst wird nichts übernommen. Lösche einen Namen, um seine Zeile zu entfernen.",
    rowsHintColors:
      "Die Kopie eines Termins in einer gelisteten Farbe bekommt die Kategorie ihrer Zeile. Sonst wird nichts übernommen. Lösche einen Namen, um seine Zeile zu entfernen.",
    placeholder: "z. B. Fokus",
    category: (calendar) => `Kategorie in ${calendar}`,
    color: (calendar) => `Farbe in ${calendar}`,
    chooseColor: "Farbe wählen",
    addRow: "Zeile hinzufügen",
  },
  conflict:
    "Nicht gespeichert. Diese Spiegelung wurde in einem anderen Tab oder auf einem anderen Gerät geändert, nachdem du sie geöffnet hast. Das Panel zeigt jetzt die aktuellen Einstellungen. Ändere sie noch einmal, wenn du deine Änderung weiter willst.",
  fieldErrors: {
    categoryComma:
      "Ein Kategoriename darf kein Komma enthalten: Outlook liest das Komma als Beginn einer zweiten Kategorie.",
    categoryTooLong: (max) => `Ein Kategoriename darf höchstens ${max} Zeichen haben.`,
    colorInvalid: "Diese Farbe passt nicht zum Kalender. Lade die Seite neu.",
    onlyGoogle: "Google-Termine haben Farben, keine Kategorien. Wähle stattdessen Farben.",
    passName: (max) =>
      `Ein Kategoriename darf kein Komma enthalten und höchstens ${max} Zeichen haben.`,
    passIncomplete: "Jede Zeile braucht einen Kategorienamen und eine Farbe.",
    passTooMany: (max) => `Du kannst höchstens ${max} Kategorien übernehmen.`,
    whoRequired: (from) =>
      `Wähle, was andere sehen. Deine Antwort gilt für jeden Kalender aus ${from}.`,
  },
  notSaved: {
    readOnly: (target) =>
      `Es wurde nichts gespeichert: slotmirror kann nicht in ${target} schreiben. Du kannst diese Spiegelung nur ausschalten.`,
    cap: (level) =>
      `Es wurde nichts gespeichert: Deine Organisation erlaubt hier höchstens „${level}“.`,
    gone: "Es wurde nichts gespeichert: Diese Spiegelung wurde inzwischen geändert. Lade die Seite neu.",
  },
  bar: {
    button: {
      "title-open": "Titel für andere zeigen",
      "full-open": "Details für andere zeigen",
    },
    buttonBusy: (blockTitle) =>
      blockTitle.length <= 24 ? `„${blockTitle}“ für andere zeigen` : "Kopien für andere zeigen",
    turnOff: "Ausschalten",
    sentence: {
      "busy-private": (from, to) =>
        `Andere mit Zugriff auf ${to} sehen dann, wann du in ${from} belegt bist, ohne Titel.`,
      "busy-open": (from, to, blockTitle) =>
        `Andere mit Zugriff auf ${to} sehen dann „${blockTitle}“, wenn du in ${from} belegt bist.`,
      "title-private": (from, to) =>
        `Du siehst die Titel aus ${from} in ${to}. Andere sehen keinen Titel.`,
      "title-open": (from, to) =>
        `Andere mit Zugriff auf ${to} sehen dann die Titel deiner Termine aus ${from}.`,
      "full-private": (from, to) =>
        `Du siehst Titel und Details aus ${from} in ${to}. Andere sehen beides nicht.`,
      "full-open": (from, to) =>
        `Andere mit Zugriff auf ${to} sehen dann Titel, Ort und Beschreibung deiner Termine aus ${from}.`,
    },
    busyTitleShown: (to, blockTitle) =>
      `Andere mit Zugriff auf ${to} sehen deine Kopien dann mit dem Titel „${blockTitle}“.`,
    stillSeesBusy: (blockTitle) =>
      `Andere sehen die Kopie weiterhin, mit dem Titel „${blockTitle}“.`,
    stillSeesTitles: "Andere sehen weiterhin die Titel deiner Termine.",
    privateAgain: {
      microsoft: "Andere sehen wieder einen privaten Termin.",
      google: "Andere sehen wieder nur „Beschäftigt“.",
    },
    copiesRemoved: (count, target) =>
      count === null
        ? `Die Kopien in ${target} werden entfernt.`
        : count === 1
          ? `1 Kopie wird aus ${target} entfernt.`
          : `${formatCount(count, "de")} Kopien werden aus ${target} entfernt.`,
    whoChanges: "Vorhandene Kopien ändern sich in den nächsten Minuten.",
  },
  all: {
    title: "Alle Spiegelungen",
    window: "Wie weit voraus",
    windowHint: "Termine bis zu so vielen Tagen ab heute werden kopiert.",
    days: (count) => `${count} Tage`,
    blockTitle: "Titel der Kopien bei „Nur belegt“",
    blockTitleHint: "Leer lassen für „Belegt“.",
    blockTitlePlaceholder: (title) => `Standard: ${title}`,
    whoDefault: "Was andere sehen, als Standard",
    whoDefaultHint:
      "Gilt, wenn du eine Spiegelung einschaltest. Solange sie eingeschaltet ist, behält sie ihre eigene Wahl.",
    applyWho: (count) =>
      count === 1
        ? "Auch auf 1 bestehende Spiegelung anwenden"
        : `Auch auf ${count} bestehende Spiegelungen anwenden`,
    applyPrivate: (count) =>
      count === 1
        ? "1 Spiegelung wechselt zu „Privater Termin“. Vorhandene Kopien ändern sich in den nächsten Minuten."
        : `${count} Spiegelungen wechseln zu „Privater Termin“. Vorhandene Kopien ändern sich in den nächsten Minuten.`,
    applyOpen: {
      busy: (targets, blockTitle) =>
        `In ${targets} sehen andere dann „${blockTitle}“ statt eines privaten Termins.`,
      title: (targets) =>
        `In ${targets} sehen andere dann die Titel deiner Termine statt eines privaten Termins.`,
      full: (targets) =>
        `In ${targets} sehen andere dann Titel und Details deiner Termine statt eines privaten Termins.`,
      titleOrFull: (targets) =>
        `In ${targets} sehen andere dann Titel oder Details deiner Termine statt eines privaten Termins.`,
    },
    applyOpenButton: (count) =>
      count === 1
        ? "1 Spiegelung für andere sichtbar machen"
        : `${count} Spiegelungen für andere sichtbar machen`,
    list: (names) =>
      names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} und ${names.at(-1)}`,
    conflict:
      "Nicht gespeichert. Die Einstellungen für alle Spiegelungen wurden in einem anderen Tab oder auf einem anderen Gerät geändert, nachdem du sie geöffnet hast. Das Panel zeigt jetzt die aktuellen Einstellungen. Ändere sie noch einmal, wenn du deine Änderung weiter willst.",
    skipTitle: "Was übersprungen wird",
    skipCategories: "Termine mit diesen Kategorien überspringen",
    skipCategoriesLabel: "Kategorien",
    skipCategoriesHint: "Namen mit Komma trennen.",
    skipCategoriesPlaceholder: "z. B. Privat, Fokus",
    skipColors: "Google-Termine mit diesen Farben überspringen",
    skipColorsLabel: "Google-Farben",
    skipAllDay: "Ganztägige Termine überspringen",
    skipAllDayLabel: "Ganztägige Termine überspringen",
    skipAllDayHint:
      "Sonst blockieren Feiertage und freie Tage ganze Tage, außer sie sind als frei markiert.",
    skipTentative: "Vorläufige Termine überspringen",
    skipTentativeLabel: "Vorläufige Termine überspringen",
    skipTentativeHint: "„Vielleicht“-Zusagen und vorläufige Termine blockieren nicht.",
  },
};
