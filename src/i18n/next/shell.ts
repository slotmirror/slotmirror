import { formatCount } from "./overview";

/**
 * Strings of the redesigned shell and of the shared components in `src/pages/next/components.tsx`.
 * The English object defines the shape; the German one must match it. `en.ts` and `de.ts` wire
 * both under `next.shell`.
 */
export const shellEn = {
  nav: {
    main: "Main navigation",
    skip: "Skip to content",
    overview: "Overview",
    mirroring: "Mirroring",
    calendars: "Calendars",
    activity: "Activity",
    tokens: "API tokens",
    admin: "Admin",
    /** Read after a nav entry with an attention dot. */
    attention: "needs attention",
  },
  user: {
    menu: "Account menu",
    language: "Language",
    theme: "Theme",
    themeSystem: "System",
    themeLight: "Light",
    themeDark: "Dark",
    privacy: "Privacy",
    version: "Version",
    deleteMyData: "Delete my data",
    signOut: "Sign out",
  },
  panel: {
    close: "Close",
    back: "Back to the list",
    backShort: "Back",
    /** The head of a calendar panel opened from a mirroring's working hours: the way back. */
    backToMirroring: "Back to the mirroring",
    saveFailed: "Could not save. Your changes are still here.",
    sessionEnded:
      "Your session has ended, so nothing was saved. Your changes are still here. Sign in again in another tab, then save.",
    /** The notice on top of a panel whose refusal names its reason at a field. */
    notSaved: "Nothing was saved.",
    /**
     * A save in the background was stored, but the page after it did not load. The script shows
     * it in the save bar.
     */
    savedNotShown: "Saved. The page could not be updated; reload to see the result.",
    guard: {
      titleOne: "1 unsaved change",
      titleMany: "{n} unsaved changes",
      /** The dialog text for one change and for several. The script picks it with the count. */
      textOne: "If you leave now, the change is lost.",
      text: "If you leave now, the changes are lost.",
      saveAndContinue: "Save and leave",
      discard: "Discard",
      keepEditing: "Keep editing",
    },
  },
  levels: {
    /** One short line per level, for rows and the panel. */
    summary: {
      off: "Not copied",
      "busy-private": "Busy only, private",
      "busy-open": "Busy only, same as you",
      "title-private": "Title, private",
      "title-open": "Title, same as you",
      "full-private": "Everything, private",
      "full-open": "Everything, same as you",
    },
  },
  providers: {
    microsoft: "Microsoft 365",
    google: "Google Calendar",
  },
  /** Short weekday names, Monday first, where the pages print working hours ("Mon–Fri"). */
  weekdays: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  status: {
    ok: "In sync",
    warn: "Needs attention",
    danger: "Failed",
    idle: "No run yet",
  },
  /**
   * The one status vocabulary of rows and panel heads: a dot and a short time when all is well,
   * the state in words only when it is not.
   */
  run: {
    /** The accessible form of a fine state, "Last run 8 min". */
    lastRun: (time: string) => `Last run ${time}`,
    failed: "Failed",
    notWritten: (count: number) =>
      count === 1 ? "1 not written" : `${formatCount(count, "en")} not written`,
    catchingUp: "Catching up",
    paused: "Paused",
    overdue: (time: string) => `No run for ${time}`,
    connectionLost: "Connection lost",
    noRun: "No run yet",
    copies: (count: number) => (count === 1 ? "1 copy" : `${formatCount(count, "en")} copies`),
    viewActivity: "View activity",
  },
  notice: {
    info: "Note",
    warn: "Warning",
    danger: "Problem",
  },
  common: {
    save: "Save",
    discard: "Discard",
    saved: "Saved",
    changesOne: "1 change",
    changesMany: "{n} changes",
    /** The keyboard hint after the Save label, by platform. Not read aloud. */
    saveKey: { mac: "⌘↵", other: "Ctrl ↵" },
  },
  /**
   * What the live region of the app pages says during in-app navigation. `{title}` is the new
   * window title. Not shown, only read aloud.
   */
  enhance: {
    saved: "Saved",
    updated: "Updated: {title}",
    loading: "Loading",
    errorNetwork: "No connection to the server. Your changes are still here.",
    errorServer: "Could not save. Your changes are still here.",
  },
};

export type ShellMessages = typeof shellEn;

export const shellDe: ShellMessages = {
  nav: {
    main: "Hauptnavigation",
    skip: "Zum Inhalt springen",
    overview: "Übersicht",
    mirroring: "Spiegelung",
    calendars: "Kalender",
    activity: "Aktivität",
    tokens: "API-Tokens",
    admin: "Verwaltung",
    attention: "zu prüfen",
  },
  user: {
    menu: "Kontomenü",
    language: "Sprache",
    theme: "Darstellung",
    themeSystem: "System",
    themeLight: "Hell",
    themeDark: "Dunkel",
    privacy: "Datenschutz",
    version: "Version",
    deleteMyData: "Meine Daten löschen",
    signOut: "Abmelden",
  },
  panel: {
    close: "Schließen",
    back: "Zurück zur Liste",
    backShort: "Zurück",
    backToMirroring: "Zurück zur Spiegelung",
    saveFailed: "Speichern fehlgeschlagen. Deine Änderungen sind noch da.",
    sessionEnded:
      "Deine Sitzung ist abgelaufen, deshalb wurde nichts gespeichert. Deine Änderungen sind noch da. Melde dich in einem anderen Tab neu an und speichere dann.",
    notSaved: "Es wurde nichts gespeichert.",
    savedNotShown:
      "Gespeichert. Die Seite konnte nicht aktualisiert werden; lade sie neu, um das Ergebnis zu sehen.",
    guard: {
      titleOne: "1 ungespeicherte Änderung",
      titleMany: "{n} ungespeicherte Änderungen",
      textOne: "Wenn du jetzt gehst, ist die Änderung weg.",
      text: "Wenn du jetzt gehst, sind die Änderungen weg.",
      saveAndContinue: "Speichern und gehen",
      discard: "Verwerfen",
      keepEditing: "Weiter bearbeiten",
    },
  },
  levels: {
    summary: {
      off: "Nicht kopiert",
      "busy-private": "Nur belegt, privat",
      "busy-open": "Nur belegt, wie bei dir",
      "title-private": "Titel, privat",
      "title-open": "Titel, wie bei dir",
      "full-private": "Alles, privat",
      "full-open": "Alles, wie bei dir",
    },
  },
  providers: {
    microsoft: "Microsoft 365",
    google: "Google Kalender",
  },
  weekdays: ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"],
  status: {
    ok: "Aktuell",
    warn: "Zu prüfen",
    danger: "Fehlgeschlagen",
    idle: "Noch kein Lauf",
  },
  run: {
    lastRun: (time) => `Letzter Lauf ${time}`,
    failed: "Fehlgeschlagen",
    notWritten: (count) => `${formatCount(count, "de")} nicht geschrieben`,
    catchingUp: "Holt auf",
    paused: "Pausiert",
    overdue: (time) => `${time} ohne Lauf`,
    connectionLost: "Verbindung unterbrochen",
    noRun: "Noch kein Lauf",
    copies: (count) => (count === 1 ? "1 Kopie" : `${formatCount(count, "de")} Kopien`),
    viewActivity: "Aktivität ansehen",
  },
  notice: {
    info: "Hinweis",
    warn: "Warnung",
    danger: "Problem",
  },
  common: {
    save: "Speichern",
    discard: "Verwerfen",
    saved: "Gespeichert",
    changesOne: "1 Änderung",
    changesMany: "{n} Änderungen",
    saveKey: { mac: "⌘↵", other: "Strg ↵" },
  },
  enhance: {
    saved: "Gespeichert",
    updated: "Aktualisiert: {title}",
    loading: "Wird geladen",
    errorNetwork: "Keine Verbindung zum Server. Deine Änderungen sind noch da.",
    errorServer: "Speichern fehlgeschlagen. Deine Änderungen sind noch da.",
  },
};
