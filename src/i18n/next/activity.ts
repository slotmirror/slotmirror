import { formatCount } from "./overview";

/**
 * Strings of the activity page of the redesign. The sentences of single events come from
 * `describe.ts` (`activity.kinds`, `activity.changes`) and `overview.ts` (`problems.reasons`) and are not repeated
 * here. The English object defines the shape; the German one must match it. `en.ts` and `de.ts`
 * wire both under `next.activity`.
 */
export const activityEn = {
  title: "Activity",
  lead: "What slotmirror did, and what you changed.",
  orgLead: "Entries of everyone in this deployment. Metadata only.",
  today: "Today",
  yesterday: "Yesterday",
  scope: {
    label: "Whose entries",
    own: "Mine",
    org: "Everyone",
  },
  filters: {
    label: "Filter",
    mirroring: "Mirroring",
    calendar: "Calendar",
    kind: "Type",
    allMirrorings: "All mirrorings",
    allCalendars: "All calendars",
    allKinds: "Everything",
    apply: "Apply",
    clear: "Clear all filters",
    active: "Active filters",
    remove: (what: string) => `Remove filter: ${what}`,
    /** The pair of a mirroring in a filter, "Work to Home". */
    mirroringName: (from: string, to: string) => `${from} to ${to}`,
    kinds: {
      sync: "Runs",
      changes: "Changes",
      problems: "Problems",
    },
  },
  row: {
    failed: "Failed",
    /** The label of a warn row: a run that left changes undone, or a lost connection. */
    partial: "Needs attention",
    /** A joined row: runs of one mirroring that changed nothing. */
    repeated: (count: number, first: string, last: string) =>
      first === last
        ? `${formatCount(count, "en")} runs at ${first}`
        : `${formatCount(count, "en")} runs, ${first}–${last}`,
    /** The same event joined: how often, from the first minute to the last. */
    times: (count: number, first: string, last: string) =>
      first === last
        ? `${formatCount(count, "en")} times at ${first}`
        : `${formatCount(count, "en")} times, ${first}–${last}`,
    /** Joined changes of one mirroring: how many saves, from the first minute to the last. */
    changes: (count: number, first: string, last: string) =>
      first === last
        ? `${formatCount(count, "en")} changes at ${first}`
        : `${formatCount(count, "en")} changes, ${first}–${last}`,
    duration: (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`),
    time: "Time",
    /** The list of the single runs in an opened joined row. */
    runs: "Single runs",
  },
  page: {
    label: "Pages of activity",
    older: "Older",
    newest: "Back to newest",
  },
  empty: {
    title: "No activity yet",
    text: "Runs and changes of your calendars appear here.",
    filteredTitle: "Nothing matches these filters",
    filteredText: "Try another mirroring, calendar or type.",
    scanned: "Only the latest entries were searched. Older ones may match.",
    /**
     * The type filter "Problems" alone found nothing. With `days`, every entry was searched, and
     * entries are kept that many days; with `entries`, only the latest that many.
     */
    problemsTitle: (days: number) => `No problems in the last ${formatCount(days, "en")} days`,
    problemsScannedTitle: (entries: number) =>
      `No problems in the latest ${formatCount(entries, "en")} entries`,
    problemsText: "Failed runs, runs that left changes undone and lost connections appear here.",
  },
  list: "Entries",
  retention: (days: number) => `Entries are deleted after ${formatCount(days, "en")} days.`,
};

export type ActivityMessages = typeof activityEn;

export const activityDe: ActivityMessages = {
  title: "Aktivität",
  lead: "Was slotmirror getan hat und was du geändert hast.",
  orgLead: "Einträge aller Personen dieser Installation. Nur Metadaten.",
  today: "Heute",
  yesterday: "Gestern",
  scope: {
    label: "Wessen Einträge",
    own: "Meine",
    org: "Alle",
  },
  filters: {
    label: "Filter",
    mirroring: "Spiegelung",
    calendar: "Kalender",
    kind: "Art",
    allMirrorings: "Alle Spiegelungen",
    allCalendars: "Alle Kalender",
    allKinds: "Alles",
    apply: "Anwenden",
    clear: "Alle Filter entfernen",
    active: "Aktive Filter",
    remove: (what) => `Filter entfernen: ${what}`,
    mirroringName: (from, to) => `${from} nach ${to}`,
    kinds: {
      sync: "Läufe",
      changes: "Änderungen",
      problems: "Probleme",
    },
  },
  row: {
    failed: "Fehlgeschlagen",
    partial: "Zu prüfen",
    repeated: (count, first, last) =>
      first === last
        ? `${formatCount(count, "de")} Läufe um ${first}`
        : `${formatCount(count, "de")} Läufe, ${first}–${last}`,
    times: (count, first, last) =>
      first === last
        ? `${formatCount(count, "de")}-mal um ${first}`
        : `${formatCount(count, "de")}-mal, ${first}–${last}`,
    changes: (count, first, last) =>
      first === last
        ? `${formatCount(count, "de")} Änderungen um ${first}`
        : `${formatCount(count, "de")} Änderungen, ${first}–${last}`,
    duration: (ms) =>
      ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1).replace(".", ",")} s`,
    time: "Zeit",
    runs: "Einzelne Läufe",
  },
  page: {
    label: "Seiten der Aktivität",
    older: "Älter",
    newest: "Zurück zu den neuesten",
  },
  empty: {
    title: "Noch keine Aktivität",
    text: "Läufe und Änderungen deiner Kalender erscheinen hier.",
    filteredTitle: "Nichts passt zu diesen Filtern",
    filteredText: "Probiere eine andere Spiegelung, einen anderen Kalender oder eine andere Art.",
    scanned: "Nur die neuesten Einträge wurden durchsucht. Ältere passen vielleicht.",
    problemsTitle: (days) => `Keine Probleme in den letzten ${formatCount(days, "de")} Tagen`,
    problemsScannedTitle: (entries) =>
      `Keine Probleme in den letzten ${formatCount(entries, "de")} Einträgen`,
    problemsText:
      "Fehlgeschlagene Läufe, Läufe mit offenen Änderungen und unterbrochene Verbindungen erscheinen hier.",
  },
  list: "Einträge",
  retention: (days) => `Einträge werden nach ${formatCount(days, "de")} Tagen gelöscht.`,
};
