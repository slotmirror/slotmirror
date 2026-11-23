/** Number formats per language, built once per isolate: Intl setup costs CPU time. */
const numberFormats = new Map<string, Intl.NumberFormat>();

/**
 * A count with the separators of its language: 1240 is "1,240" in English and "1.240" in German.
 * The other catalogs of the redesign import it for every count that can grow large.
 */
export function formatCount(count: number, locale: "en" | "de"): string {
  let format = numberFormats.get(locale);
  if (!format) {
    format = new Intl.NumberFormat(locale);
    numberFormats.set(locale, format);
  }
  return format.format(count);
}

const nEn = (count: number) => formatCount(count, "en");
const nDe = (count: number) => formatCount(count, "de");

/** "1 mirroring" or "6 mirrorings". */
const mirroringsEn = (count: number) => `${nEn(count)} ${count === 1 ? "mirroring" : "mirrorings"}`;
/** "1 copy" or "40 copies", for the heads of the map. */
const blocksEn = (count: number) => (count === 1 ? "1 copy" : `${nEn(count)} copies`);
const blocksDe = (count: number) => (count === 1 ? "1 Kopie" : `${nDe(count)} Kopien`);

const mirroringsDe = (count: number) =>
  `${nDe(count)} ${count === 1 ? "Spiegelung" : "Spiegelungen"}`;

/**
 * Strings of the overview page of the redesign. The English object defines the shape; the German
 * one must match it. `en.ts` and `de.ts` wire both under `next.overview`. The sentences that describe audit rows are in `describe.ts`. The activity
 * page reads the failure sentences in `problems` through `describeActivity`.
 */
export const overviewEn = {
  title: "Overview",
  /** The live state in the page header, next to the title. */
  state: {
    inSync: (count: number) => `${mirroringsEn(count)} in sync`,
    /** The newest run, after the state: "6 mirrorings in sync · newest run 8 min ago". */
    checked: (ago: string) => `newest run ${ago}`,
    /** Mirrorings that failed, have not run for an hour or are catching up: the list says which. */
    needAttention: (count: number, total: number) =>
      `${nEn(count)} of ${nEn(total)} ${count === 1 ? "needs" : "need"} attention`,
    reconnect: (count: number) =>
      count === 1 ? "1 calendar needs reconnecting" : `${nEn(count)} calendars need reconnecting`,
    waiting: (count: number) =>
      count === 1
        ? "1 mirroring waiting for its first run"
        : `${nEn(count)} mirrorings waiting for their first run`,
    /** Some mirrorings are fine, the others have not run yet. */
    waitingMore: (count: number) =>
      count === 1 ? "1 waiting for its first run" : `${nEn(count)} waiting for their first run`,
    nothing: "Nothing is mirrored",
  },
  /** Short ages: "8 min", "9 hr". `now` is for less than a minute. */
  age: {
    now: "now",
    /** A short age as a time in the past: "8 min ago". */
    ago: (age: string) => `${age} ago`,
    justNow: "just now",
  },
  problems: {
    label: "Needs attention",
    failed: "Failed.",
    partial: "Catching up.",
    /** The state of a mirroring that has not run for an hour, as the map and the lists say it. */
    noRun: (time: string) => `No run for ${time}.`,
    overdueText: "Mirrorings run at least once an hour.",
    /** The subject when several mirrorings have not run: one row stands for all of them. */
    overdueMany: (count: number) => `${nEn(count)} mirrorings`,
    openMirrorings: "Open mirroring list",
    partialText: (count: number) =>
      count === 1
        ? "1 change waits for the provider. slotmirror tries again on its own."
        : `${nEn(count)} changes wait for the provider. slotmirror tries again on its own.`,
    reconnectState: "Connection lost.",
    reconnectText: "Nothing is copied to or from this calendar until you reconnect it.",
    reconnect: "Reconnect",
    reconnectLabel: (name: string) => `Reconnect ${name}`,
    openMirroring: "Open mirroring",
    openCalendar: "Open calendar",
    viewActivity: "View activity",
    missingTitle: (names: string) => `Calendars of ${names} could not be loaded`,
    missingText: "Until they load, this calendar is missing from the map and from every mirroring.",
    missingGoogle:
      "For Google: allow calendar access when you connect. If that does not help, the operator must turn on the Google Calendar API.",
    reload: "Reload calendars",
    failedNoReason: "The last run did not finish.",
    failedChanges: (count: number) =>
      count === 1
        ? "1 change could not be written."
        : `${nEn(count)} changes could not be written.`,
    reasons: {
      token: "The sign-in with the provider no longer works.",
      throttled: "The provider is slowing slotmirror down. It tries again on its own.",
      server: "The provider had a problem on its side. slotmirror tries again on its own.",
      denied: "The provider refused access to the calendar.",
      missing: "The provider could not find a calendar or an event.",
      unknown: "slotmirror has no explanation for this error yet.",
    },
    cleanupLeftTitle: (count: number) =>
      count === 1 ? "Copies left in 1 calendar" : `Copies left in ${nEn(count)} calendars`,
    cleanupLeftText:
      "slotmirror could not confirm that it removed them. Delete what is left by hand in the calendar.",
    cleanupRunningTitle: (count: number) =>
      count === 1
        ? "Removing copies from 1 calendar"
        : `Removing copies from ${nEn(count)} calendars`,
    cleanupRunningText: "slotmirror is still working on it.",
    cleanupShow: "Show details",
  },
  map: {
    title: "What goes where",
    tableLabel: "Which calendar appears in which",
    axisFrom: "From",
    axisTo: "Appears in",
    to: "to",
    appearsIn: (name: string) => `Appears in ${name}`,
    receives: (count: number) => `receives ${blocksEn(count)}`,
    sends: (count: number) => `sends ${blocksEn(count)}`,
    receivesNothing: "receives nothing",
    sendsNothing: "sends nothing",
    needsReconnect: "Connection lost",
    /** The copies one mirroring holds; the key keeps its old name. */
    blocks: (count: number) => (count === 1 ? "1 copy" : `${nEn(count)} copies`),
    noRun: "No run yet",
    failed: "Failed",
    notWritten: (count: number) => `${nEn(count)} not written`,
    waiting: (count: number) => `${nEn(count)} waiting`,
    overdue: (time: string) => `No run for ${time}`,
    blocked: "Connection lost",
    notCopied: "Not copied",
    /** In the map's head when every copied cell has the same level; the cells then omit it. */
    allCopies: (level: string) => `All copies: ${level}`,
    lastRun: (time: string) => `last run ${time}`,
    cell: (from: string, to: string, level: string, status: string) =>
      `${from} to ${to}: ${level}${status ? `. ${status}` : ""}`,
    /**
     * The accessible name of a map cell. It starts with the cell's visible label, so that voice
     * control finds it, and adds the full level when the label is shorter.
     */
    cellShort: (shown: string, from: string, to: string, level: string, status: string) =>
      `${shown}: ${from} to ${to}${level === shown ? "" : ` (${level})`}${status ? `. ${status}` : ""}`,
  },
  empty: {
    noneTitle: "Connect your first calendar",
    noneText:
      "slotmirror copies the busy times of one calendar into another, so nobody books you twice.",
    oneTitle: "Connect a second calendar",
    oneText:
      "Busy times are copied between two calendars, for example your work and your private calendar.",
    connect: "Connect calendar",
    startTitle: "Nothing is mirrored yet",
    startText: (count: number) =>
      count === 2
        ? "Both calendars then show each other's events as busy. You can change each mirroring later."
        : `Each of the ${nEn(count)} calendars then shows the others' events as busy. You can change each mirroring later.`,
    start: "Mirror all as busy",
  },
};

export type OverviewMessages = typeof overviewEn;

export const overviewDe: OverviewMessages = {
  title: "Übersicht",
  state: {
    inSync: (count) => `${mirroringsDe(count)} aktuell`,
    checked: (ago) => `jüngster Lauf ${ago}`,
    needAttention: (count, total) => `${nDe(count)} von ${nDe(total)} zu prüfen`,
    reconnect: (count) =>
      count === 1 ? "1 Kalender ohne Verbindung" : `${nDe(count)} Kalender ohne Verbindung`,
    waiting: (count) =>
      count === 1
        ? "1 Spiegelung wartet auf den ersten Lauf"
        : `${nDe(count)} Spiegelungen warten auf den ersten Lauf`,
    waitingMore: (count) =>
      count === 1 ? "1 wartet auf den ersten Lauf" : `${nDe(count)} warten auf den ersten Lauf`,
    nothing: "Es wird nichts gespiegelt",
  },
  age: {
    now: "jetzt",
    ago: (age) => `vor ${age}`,
    justNow: "gerade eben",
  },
  problems: {
    label: "Zu prüfen",
    failed: "Fehlgeschlagen.",
    partial: "Holt auf.",
    noRun: (time) => `${time} ohne Lauf.`,
    overdueText: "Spiegelungen laufen mindestens einmal pro Stunde.",
    overdueMany: (count) => `${nDe(count)} Spiegelungen`,
    openMirrorings: "Spiegelungen öffnen",
    partialText: (count) =>
      count === 1
        ? "1 Änderung wartet auf den Anbieter. slotmirror versucht es von selbst wieder."
        : `${nDe(count)} Änderungen warten auf den Anbieter. slotmirror versucht es von selbst wieder.`,
    reconnectState: "Verbindung unterbrochen.",
    reconnectText:
      "Bis du ihn neu verbindest, wird nichts aus diesem oder in diesen Kalender kopiert.",
    reconnect: "Neu verbinden",
    reconnectLabel: (name) => `${name} neu verbinden`,
    openMirroring: "Spiegelung öffnen",
    openCalendar: "Kalender öffnen",
    viewActivity: "Aktivität ansehen",
    missingTitle: (names) => `Die Kalender von ${names} konnten nicht geladen werden`,
    missingText:
      "Bis sie geladen sind, fehlt dieser Kalender in der Karte und in jeder Spiegelung.",
    missingGoogle:
      "Bei Google: Erlaube beim Verbinden den Kalenderzugriff. Hilft das nicht, muss der Betreiber die Google Calendar API einschalten.",
    reload: "Kalender neu laden",
    failedNoReason: "Der letzte Lauf wurde nicht abgeschlossen.",
    failedChanges: (count) =>
      count === 1
        ? "1 Änderung konnte nicht geschrieben werden."
        : `${nDe(count)} Änderungen konnten nicht geschrieben werden.`,
    reasons: {
      token: "Die Anmeldung beim Anbieter funktioniert nicht mehr.",
      throttled: "Der Anbieter bremst slotmirror. slotmirror versucht es von selbst wieder.",
      server: "Beim Anbieter gab es ein Problem. slotmirror versucht es von selbst wieder.",
      denied: "Der Anbieter hat den Zugriff auf den Kalender verweigert.",
      missing: "Der Anbieter hat einen Kalender oder einen Termin nicht gefunden.",
      unknown: "Für diesen Fehler hat slotmirror noch keine Erklärung.",
    },
    cleanupLeftTitle: (count) =>
      count === 1
        ? "In 1 Kalender sind Kopien übrig"
        : `In ${nDe(count)} Kalendern sind Kopien übrig`,
    cleanupLeftText:
      "slotmirror konnte das Entfernen nicht bestätigen. Lösche den Rest von Hand im Kalender.",
    cleanupRunningTitle: (count) =>
      count === 1
        ? "Kopien werden aus 1 Kalender entfernt"
        : `Kopien werden aus ${nDe(count)} Kalendern entfernt`,
    cleanupRunningText: "slotmirror arbeitet noch daran.",
    cleanupShow: "Details zeigen",
  },
  map: {
    title: "Was geht wohin",
    tableLabel: "Welcher Kalender erscheint in welchem",
    axisFrom: "Von",
    axisTo: "Erscheint in",
    to: "nach",
    appearsIn: (name) => `Erscheint in ${name}`,
    receives: (count) => `empfängt ${blocksDe(count)}`,
    sends: (count) => `sendet ${blocksDe(count)}`,
    receivesNothing: "empfängt nichts",
    sendsNothing: "sendet nichts",
    needsReconnect: "Verbindung unterbrochen",
    blocks: (count) => (count === 1 ? "1 Kopie" : `${nDe(count)} Kopien`),
    noRun: "Noch kein Lauf",
    failed: "Fehlgeschlagen",
    notWritten: (count) => `${nDe(count)} nicht geschrieben`,
    waiting: (count) => `${nDe(count)} warten`,
    overdue: (time) => `${time} ohne Lauf`,
    blocked: "Verbindung unterbrochen",
    notCopied: "Nicht kopiert",
    allCopies: (level) => `Alle Kopien: ${level}`,
    lastRun: (time) => `letzter Lauf ${time}`,
    cell: (from, to, level, status) => `${from} nach ${to}: ${level}${status ? `. ${status}` : ""}`,
    cellShort: (shown, from, to, level, status) =>
      `${shown}: ${from} nach ${to}${level === shown ? "" : ` (${level})`}${status ? `. ${status}` : ""}`,
  },
  empty: {
    noneTitle: "Verbinde deinen ersten Kalender",
    noneText:
      "slotmirror kopiert die belegten Zeiten eines Kalenders in einen anderen, damit dich niemand doppelt bucht.",
    oneTitle: "Verbinde einen zweiten Kalender",
    oneText:
      "Belegte Zeiten werden zwischen zwei Kalendern kopiert, zum Beispiel zwischen deinem Arbeits- und deinem Privatkalender.",
    connect: "Kalender verbinden",
    startTitle: "Noch wird nichts gespiegelt",
    startText: (count) =>
      count === 2
        ? "Dann zeigen beide Kalender die Termine des anderen als belegt. Jede Spiegelung kannst du später ändern."
        : `Dann zeigt jeder der ${nDe(count)} Kalender die Termine der anderen als belegt. Jede Spiegelung kannst du später ändern.`,
    start: "Alle als belegt spiegeln",
  },
};
