import { formatCount } from "./overview";
import type { LeftBehind } from "../../cleanup";

/**
 * Strings that only the redesigned pages outside the app need: sign-in, setup, consent, messages
 * and errors, and the confirmation pages. Text that is legal or privacy wording (privacy, consent
 * wording, messages) is not repeated here: the new pages read the old keys, so that it stays word
 * for word. Texts that only name things (sign-in lead, setup, confirmations) live here, in the
 * words of the glossary. The English object defines the shape; the German one
 * must match it. `en.ts` and `de.ts` wire both under `next.auth`.
 */
export const authEn = {
  layout: {
    skip: "Skip to content",
    footer: "Footer",
  },
  signIn: {
    options: "Sign-in options",
    googleWarning: "About Google’s warning screen",
    lead: "Mirror busy times between your calendars. By default, others only see that you are busy.",
    fineprint:
      "Attendees are never copied. Titles, locations and notes are copied only if you choose that for a mirroring.",
  },
  setup: {
    progress: (done: number, total: number) => `${done} of ${total} steps done`,
    done: "Done",
    todo: "To do",
    or: "or",
    whereLabel: "Where",
    where: "Cloudflare dashboard, your Worker, Settings, Variables and Secrets",
    variablesLabel: "Variables",
    commandLabel: "Command",
    copy: "Copy",
    copied: "Copied",
    steps: {
      access: "Who may sign in",
      session: "Session secret",
      key: "Token encryption key",
      provider: "Sign-in provider",
    },
    next: "Reload this page after you set the values.",
    title: "Finish the setup",
    lead: "Set the missing values in the steps below.",
    hints: {
      access: "Your own address for a personal deployment, your email domain for a team.",
      session:
        "At least 32 characters. With openssl: openssl rand -base64 48. Without it, the quickstart shows a way for Windows.",
      key: "A base64-encoded 32-byte key. With openssl: openssl rand -base64 32. Without it, the quickstart shows a way for Windows.",
      provider:
        "At least one provider that SIGN_IN_PROVIDERS allows for sign-in. The quickstart shows the app registration steps.",
      providerInvalid: (value: string) =>
        `SIGN_IN_PROVIDERS is set to "${value}". Valid entries are microsoft and google. Write both as: microsoft,google. Or remove the variable to allow every configured provider.`,
    },
    jurisdictionNote:
      "To keep the data in the EU, set DATA_JURISDICTION to eu now, before you connect the first calendar. Changing it later disconnects every calendar. Also set PUBLIC_URL to the address of this Worker for fast updates.",
    docsLink: "Open the quickstart",
  },
  deleteUser: {
    titleSelf: "Delete my data",
    titleOther: (email: string) => `Delete ${email}`,
    intro: "This removes:",
    calendars: (count: number) =>
      count === 1
        ? "1 connected calendar, with its tokens"
        : `${formatCount(count, "en")} connected calendars, with their tokens`,
    mirrorings: "All mirrorings and settings",
    copies: "The copies they wrote, from today on. Past copies stay in the calendars.",
    person: "The person itself",
    activityStays:
      "Activity entries stay until the retention period ends, without event contents. This cannot be undone.",
    confirmSelf: "Delete my data",
    confirmOther: "Delete person",
    cancel: "Cancel",
  },
  disconnect: {
    title: "Disconnect this calendar?",
    text: (email: string) =>
      `slotmirror removes the copies it wrote into the calendars of ${email}, then deletes its tokens and stops reading and writing these calendars.`,
    mirrorings: (count: number) =>
      count === 0
        ? "No mirroring uses this calendar."
        : count === 1
          ? "1 mirroring uses this calendar. It is deleted, and the copies it wrote are removed."
          : `${formatCount(count, "en")} mirrorings use this calendar. They are deleted, and the copies they wrote are removed.`,
    confirm: "Disconnect calendar",
    cancel: "Cancel",
  },
  cleanup: {
    title: "Copies left in calendars",
    lead: "slotmirror could not confirm the removal of these copies after a calendar or a person was removed. Delete what is left by hand in the calendar.",
    reconnectDoesNotHelp:
      "Reconnecting the calendar removes them only if the entry says that it can.",
    runningTitle: "Removals in progress",
    runningLead: "slotmirror is still removing these copies.",
    running: (date: string) =>
      `If the calendar lost its connection, the removal ends around ${date}.`,
    othersTitle: "Deleted people",
    othersLead:
      "These people cannot see this page. Their copies stay in their calendars until someone deletes them.",
    empty: "No copies are left.",
    unnamedCalendar: "A calendar without a stored name",
    count: (count: number) =>
      count === 1 ? "1 copy left" : `${formatCount(count, "en")} copies left`,
    aboutCount: (count: number) =>
      count === 1
        ? "About 1 copy left, from the last run"
        : `About ${formatCount(count, "en")} copies left, from the last run`,
    unknownCount: "The number of copies is not known",
    period: (from: string, to: string) => `Between ${from} and ${to}`,
    marker: (tag: string, title: string) => `Title “${title}”, marker ${tag}`,
    markerOnly: (tag: string) => `Marker ${tag}`,
    markerHelp:
      "The marker is a hidden property of each copy. Calendar apps do not show it, but the provider's API returns it. Past copies stay as a record.",
    reasons: {
      incomplete: "The provider kept failing.",
      token_refused: "The provider refused the connection.",
      no_tokens: "The connection is gone.",
      deadline: "The calendar was not reconnected in time.",
      not_started:
        "The state of this removal is not known. Copies may be left. Reconnecting the calendar can still finish the removal. Otherwise delete them by hand.",
    } satisfies Record<LeftBehind, string>,
  },
  consent: {
    app: "App",
    returnsTo: "Returns to",
    /** How long a grant lasts (`GRANT_DAYS` in `src/mcp-oauth.ts`) and where it ends earlier. */
    lasts: (days: number) =>
      `Access ends after ${days} days at the latest. You can disconnect the app earlier under API tokens.`,
    /** What the app can read. The legal identity lines of the page stay in `consent`. */
    can: [
      "Your connected calendars and whether one has lost its connection.",
      "Your mirrorings, with their level and which filters are on.",
      "The state of the last run of each mirroring.",
    ],
  },
  error: {
    details: "Technical details",
  },
  notFound: {
    title: "Page not found",
    text: "This address does not exist. It may have been mistyped or removed.",
    back: "Go to Overview",
  },
};

export type AuthMessages = typeof authEn;

export const authDe: AuthMessages = {
  layout: {
    skip: "Zum Inhalt springen",
    footer: "Fußbereich",
  },
  signIn: {
    options: "Anmeldeoptionen",
    googleWarning: "Zu Googles Warnhinweis",
    lead: "Spiegle belegte Zeiten zwischen deinen Kalendern. Standardmäßig sehen andere nur, dass du belegt bist.",
    fineprint:
      "Teilnehmende werden nie kopiert. Titel, Orte und Notizen werden nur kopiert, wenn du das für eine Spiegelung wählst.",
  },
  setup: {
    progress: (done, total) => `${done} von ${total} Schritten erledigt`,
    done: "Erledigt",
    todo: "Offen",
    or: "oder",
    whereLabel: "Wo",
    where: "Cloudflare-Dashboard, dein Worker, Settings, Variables and Secrets",
    variablesLabel: "Variablen",
    commandLabel: "Befehl",
    copy: "Kopieren",
    copied: "Kopiert",
    steps: {
      access: "Wer sich anmelden darf",
      session: "Sitzungsgeheimnis",
      key: "Schlüssel für Tokens",
      provider: "Anmeldeanbieter",
    },
    next: "Lade diese Seite neu, sobald du die Werte gesetzt hast.",
    title: "Einrichtung abschließen",
    lead: "Setze die fehlenden Werte in den Schritten unten.",
    hints: {
      access:
        "Deine eigene Adresse für eine persönliche Installation, deine E-Mail-Domain für ein Team.",
      session:
        "Mindestens 32 Zeichen. Mit openssl: openssl rand -base64 48. Ohne openssl zeigt der Quickstart einen Weg für Windows.",
      key: "Ein Base64-kodierter 32-Byte-Schlüssel. Mit openssl: openssl rand -base64 32. Ohne openssl zeigt der Quickstart einen Weg für Windows.",
      provider:
        "Mindestens ein Anbieter, den SIGN_IN_PROVIDERS für die Anmeldung erlaubt. Der Quickstart zeigt die Schritte zur App-Registrierung.",
      providerInvalid: (value) =>
        `SIGN_IN_PROVIDERS steht auf „${value}“. Gültige Einträge sind microsoft und google. Beide schreibst du so: microsoft,google. Oder entferne die Variable, dann gilt jeder eingerichtete Anbieter.`,
    },
    jurisdictionNote:
      "Wenn die Daten in der EU bleiben sollen, setze jetzt DATA_JURISDICTION auf eu, bevor du den ersten Kalender verbindest. Eine spätere Änderung trennt alle Kalender. Setze außerdem PUBLIC_URL auf die Adresse dieses Workers, damit Änderungen schnell ankommen.",
    docsLink: "Quickstart öffnen",
  },
  deleteUser: {
    titleSelf: "Meine Daten löschen",
    titleOther: (email) => `${email} löschen`,
    intro: "Damit wird entfernt:",
    calendars: (count) =>
      count === 1
        ? "1 verbundener Kalender mit seinen Tokens"
        : `${formatCount(count, "de")} verbundene Kalender mit ihren Tokens`,
    mirrorings: "Alle Spiegelungen und Einstellungen",
    copies: "Die geschriebenen Kopien ab heute. Vergangene Kopien bleiben in den Kalendern.",
    person: "Die Person selbst",
    activityStays:
      "Einträge in der Aktivität bleiben bis zum Ende der Aufbewahrungsfrist, ohne Termininhalte. Das lässt sich nicht rückgängig machen.",
    confirmSelf: "Meine Daten löschen",
    confirmOther: "Person löschen",
    cancel: "Abbrechen",
  },
  disconnect: {
    title: "Diesen Kalender trennen?",
    text: (email) =>
      `slotmirror entfernt die Kopien, die es in die Kalender von ${email} geschrieben hat, löscht danach die Tokens und liest und schreibt diese Kalender nicht mehr.`,
    mirrorings: (count) =>
      count === 0
        ? "Keine Spiegelung nutzt diesen Kalender."
        : count === 1
          ? "1 Spiegelung nutzt diesen Kalender. Sie wird gelöscht, und die Kopien, die sie geschrieben hat, werden entfernt."
          : `${formatCount(count, "de")} Spiegelungen nutzen diesen Kalender. Sie werden gelöscht, und die Kopien, die sie geschrieben haben, werden entfernt.`,
    confirm: "Kalender trennen",
    cancel: "Abbrechen",
  },
  cleanup: {
    title: "Übrige Kopien in Kalendern",
    lead: "slotmirror konnte die Entfernung dieser Kopien nicht bestätigen, nachdem ein Kalender oder eine Person entfernt wurde. Lösche, was übrig ist, von Hand im Kalender.",
    reconnectDoesNotHelp:
      "Wenn du den Kalender neu verbindest, werden sie nur entfernt, wenn der Eintrag das nennt.",
    runningTitle: "Laufende Entfernungen",
    runningLead: "slotmirror entfernt diese Kopien noch.",
    running: (date) =>
      `Ist die Verbindung des Kalenders unterbrochen, endet die Entfernung etwa am ${date}.`,
    othersTitle: "Gelöschte Personen",
    othersLead:
      "Diese Personen sehen diese Seite nicht. Ihre Kopien bleiben in ihren Kalendern, bis jemand sie löscht.",
    empty: "Es sind keine Kopien übrig.",
    unnamedCalendar: "Ein Kalender ohne gespeicherten Namen",
    count: (count) => (count === 1 ? "1 Kopie übrig" : `${formatCount(count, "de")} Kopien übrig`),
    aboutCount: (count) =>
      count === 1
        ? "Etwa 1 Kopie übrig, laut letztem Lauf"
        : `Etwa ${formatCount(count, "de")} Kopien übrig, laut letztem Lauf`,
    unknownCount: "Die Anzahl der Kopien ist nicht bekannt",
    period: (from, to) => `Zwischen ${from} und ${to}`,
    marker: (tag, title) => `Titel „${title}“, Marker ${tag}`,
    markerOnly: (tag) => `Marker ${tag}`,
    markerHelp:
      "Der Marker ist eine versteckte Eigenschaft jeder Kopie. Kalender-Apps zeigen ihn nicht, die API des Anbieters liefert ihn. Vergangene Kopien bleiben als Nachweis stehen.",
    reasons: {
      incomplete: "Der Anbieter antwortete weiter mit Fehlern.",
      token_refused: "Der Anbieter lehnte die Verbindung ab.",
      no_tokens: "Die Verbindung fehlt.",
      deadline: "Der Kalender wurde nicht rechtzeitig neu verbunden.",
      not_started:
        "Der Stand dieser Entfernung ist nicht bekannt, es können Kopien übrig sein. Wenn du den Kalender neu verbindest, kann das die Entfernung noch abschließen. Sonst lösche sie von Hand.",
    },
  },
  consent: {
    app: "App",
    returnsTo: "Zurück zu",
    lasts: (days) =>
      `Der Zugriff endet spätestens nach ${days} Tagen. Unter API-Tokens kannst du die App vorher trennen.`,
    can: [
      "Deine verbundenen Kalender und ob bei einem die Verbindung unterbrochen ist.",
      "Deine Spiegelungen, mit Stufe und aktiven Filtern.",
      "Den Stand des letzten Laufs jeder Spiegelung.",
    ],
  },
  error: {
    details: "Technische Details",
  },
  notFound: {
    title: "Seite nicht gefunden",
    text: "Diese Adresse gibt es nicht. Sie ist vielleicht falsch geschrieben oder wurde entfernt.",
    back: "Zur Übersicht",
  },
};
