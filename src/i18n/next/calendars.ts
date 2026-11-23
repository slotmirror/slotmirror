import { formatCount, overviewDe, overviewEn } from "./overview";

/**
 * Strings of the calendars page of the redesign. The English object defines the shape; the German
 * one must match it. `en.ts` and `de.ts` wire both under `next.calendars`.
 */
export const calendarsEn = {
  title: "Calendars",
  listLabel: "Connected calendars",
  connectCalendar: "Connect calendar",
  connectMenu: "Choose a calendar service",
  // The quoted labels are Google's own and need a manual check against the live consent screen.
  googleHint:
    "Google will show “Google hasn’t verified this app”, because this deployment uses its own app. Choose “Advanced”, then “Go to … (unsafe)”.",
  emptyTitle: "Connect your first calendar",
  emptyText: overviewEn.empty.noneText,
  singleHint: "Connect a second calendar to start mirroring between them.",
  workingHours: "Working hours",
  mirroredCount: (count: number) => `From ${formatCount(count, "en")} calendars`,
  connectAgain: "Reconnect",
  reconnectTitle: (name: string) => `${name}: connection lost`,
  reconnectText: "Nothing is copied to or from this calendar until you reconnect it.",
  openCalendar: (name: string) => `Open ${name}`,
  /** `?c=` names a calendar that the state does not have, for example after a disconnect. */
  gone: "This calendar is no longer connected.",

  // Panel
  sectionCalendar: "Calendar",
  name: "Name",
  nameHint: "Leave empty to use the name from the address.",
  colour: "Colour",
  colourHint: "Only in slotmirror, not in your calendars.",
  colourAuto: "Automatic",
  namePlaceholder: (name: string) => `Default: ${name}`,
  sectionIncoming: (name: string) => `Copies into ${name}`,
  sectionOutgoing: (name: string) => `Copies from ${name}`,
  /** The tooltip of a calendar's status: it counts the mirrorings into the calendar. */
  statusHint: (name: string) => `Status of the copies into ${name}`,
  /** The switch's accessible name; the grid shows `workingHours`, which it contains. */
  hoursSwitch: "Limit to working hours",
  hoursHint:
    "Only events that touch these hours are copied in, with their full times. You can turn this off per mirroring.",
  days: "Days",
  hoursRange: "Hours",
  startTime: "Start time",
  endTime: "End time",
  untilMidnight: "Until midnight",
  timeZone: "Time zone",
  sectionMirrored: "Copy from these calendars",
  /** The accessible name of the switch of one calendar. */
  copyCalendar: (name: string) => `Copy ${name}`,
  mainCalendar: "Main",
  mirroredHint: "Only calendars that are on are copied into your other calendars.",
  noCalendars: "No calendars loaded yet.",
  reload: "Reload calendars",
  bufferBefore: "Buffer before",
  bufferAfter: "Buffer after",
  minutes: "min",
  bufferHint: "Added before and after every copy from this calendar. Not for all‑day events.",
  bufferMixed:
    "The mirrorings from this calendar have different buffers. Saving sets one value for each of them.",
  sectionConnection: "Connection",
  connectedLabel: "Connected since",
  disconnect: "Disconnect",
  disconnectHint:
    "Disconnecting removes the copies slotmirror wrote into this calendar and deletes its access.",
  /** `list` names the mirrorings ("Work to Home"); `count` is how many there are. */
  hoursAffected: (count: number, list: string) =>
    count === 1 ? `Changes what ${list} copies.` : `Changes what these mirrorings copy: ${list}.`,
  sourceOff: (name: string) =>
    `“${name}” is no longer copied. Its copies disappear from your other calendars.`,

  // Refusals
  // No "Nothing was saved.": a save writes in several steps, and the steps before a conflict stay.
  // The panel then shows the stored values.
  conflict:
    "Not all of it was saved. This calendar was changed in another tab or on another device while you saved. The panel now shows what is stored. Make your change again if it is missing.",
  /**
   * The form was drawn before another tab or device changed the calendar. The check runs before
   * the first write, so nothing was saved, and the panel shows the stored values.
   */
  conflictStale:
    "Not saved. This calendar was changed in another tab or on another device after you opened it. The panel now shows the current settings. Make your change again if you still want it.",
  /** The reason under the field that caused a refusal. The panel says "Nothing was saved." on top. */
  fieldErrors: {
    color: "This colour is not available. Reload the page.",
    days: "Choose at least one weekday.",
    time: "Enter a start and an end, for example 08:00 and 18:00.",
    order: "The end must be after the start. For the end of the day, turn on “Until midnight”.",
    zone: "Unknown time zone. Example: Europe/Vienna.",
    buffer: (max: number) => `A whole number of minutes from 0 to ${max}.`,
  },
};

export type CalendarsMessages = typeof calendarsEn;

export const calendarsDe: CalendarsMessages = {
  title: "Kalender",
  listLabel: "Verbundene Kalender",
  connectCalendar: "Kalender verbinden",
  connectMenu: "Kalenderdienst wählen",
  googleHint:
    "Google zeigt „Google hat diese App nicht überprüft“, weil diese Installation eine eigene App nutzt. Wähle „Erweitert“ und dann „Weiter zu … (unsicher)“.",
  emptyTitle: "Verbinde deinen ersten Kalender",
  emptyText: overviewDe.empty.noneText,
  singleHint: "Verbinde einen zweiten Kalender, um zwischen beiden zu spiegeln.",
  workingHours: "Arbeitszeit",
  mirroredCount: (count) => `Aus ${formatCount(count, "de")} Kalendern`,
  connectAgain: "Neu verbinden",
  reconnectTitle: (name) => `${name}: Verbindung unterbrochen`,
  reconnectText:
    "Bis du ihn neu verbindest, wird nichts aus diesem oder in diesen Kalender kopiert.",
  openCalendar: (name) => `${name} öffnen`,
  gone: "Dieser Kalender ist nicht mehr verbunden.",

  sectionCalendar: "Kalender",
  name: "Name",
  nameHint: "Leer lassen, um den Namen aus der Adresse zu verwenden.",
  colour: "Farbe",
  colourHint: "Nur in slotmirror, nicht in deinen Kalendern.",
  colourAuto: "Automatisch",
  namePlaceholder: (name) => `Standard: ${name}`,
  sectionIncoming: (name) => `Kopien in ${name}`,
  sectionOutgoing: (name) => `Kopien aus ${name}`,
  statusHint: (name) => `Status der Kopien in ${name}`,
  hoursSwitch: "Auf Arbeitszeit beschränken",
  hoursHint:
    "Nur Termine, die diese Zeit berühren, werden hierher kopiert, mit ihrer vollen Dauer. Pro Spiegelung kannst du das ausschalten.",
  days: "Tage",
  hoursRange: "Uhrzeit",
  startTime: "Beginn",
  endTime: "Ende",
  untilMidnight: "Bis Mitternacht",
  timeZone: "Zeitzone",
  sectionMirrored: "Aus diesen Kalendern kopieren",
  copyCalendar: (name) => `${name} kopieren`,
  mainCalendar: "Hauptkalender",
  mirroredHint: "Nur eingeschaltete Kalender werden in deine anderen Kalender kopiert.",
  noCalendars: "Noch keine Kalender geladen.",
  reload: "Kalender neu laden",
  bufferBefore: "Puffer davor",
  bufferAfter: "Puffer danach",
  minutes: "Min.",
  bufferHint:
    "Wird vor und nach jeder Kopie aus diesem Kalender ergänzt. Nicht bei ganztägigen Terminen.",
  bufferMixed:
    "Die Spiegelungen aus diesem Kalender haben verschiedene Puffer. Beim Speichern gilt ein Wert für jede davon.",
  sectionConnection: "Verbindung",
  connectedLabel: "Verbunden seit",
  disconnect: "Trennen",
  disconnectHint:
    "Beim Trennen entfernt slotmirror die Kopien, die es in diesen Kalender geschrieben hat, und löscht den Zugang.",
  hoursAffected: (count, list) =>
    count === 1
      ? `Ändert, was ${list} kopiert.`
      : `Ändert, was diese Spiegelungen kopieren: ${list}.`,
  sourceOff: (name) =>
    `„${name}“ wird nicht mehr kopiert. Die Kopien daraus verschwinden aus deinen anderen Kalendern.`,

  conflict:
    "Nicht alles wurde gespeichert. Dieser Kalender wurde beim Speichern in einem anderen Tab oder auf einem anderen Gerät geändert. Das Panel zeigt jetzt, was gespeichert ist. Ändere es noch einmal, wenn deine Änderung fehlt.",
  conflictStale:
    "Nicht gespeichert. Dieser Kalender wurde in einem anderen Tab oder auf einem anderen Gerät geändert, nachdem du ihn geöffnet hast. Das Panel zeigt jetzt die aktuellen Einstellungen. Ändere sie noch einmal, wenn du deine Änderung weiter willst.",
  fieldErrors: {
    color: "Diese Farbe ist nicht verfügbar. Lade die Seite neu.",
    days: "Wähle mindestens einen Wochentag.",
    time: "Gib Beginn und Ende ein, zum Beispiel 08:00 und 18:00.",
    order: "Das Ende muss nach dem Beginn liegen. Für das Tagesende schalte „Bis Mitternacht“ ein.",
    zone: "Unbekannte Zeitzone. Beispiel: Europe/Vienna.",
    buffer: (max) => `Eine ganze Zahl von Minuten zwischen 0 und ${max}.`,
  },
};
