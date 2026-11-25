/**
 * Strings of the admin page of the redesign. The English object defines the shape; the German one
 * must match it. `en.ts` and `de.ts` wire both under `next.admin`.
 */
export const adminEn = {
  title: "Admin",
  lead: "People, access and health of this deployment.",
  intro: "Calendar contents stay private to each person. This page shows counts and dates only.",
  onlyAdmins: "Only admins can open this page.",
  tabsLabel: "Admin sections",
  tabs: {
    people: "People",
    access: "Access",
    health: "Health",
  },
  doneDeleted: "The person is deleted. Their copies disappear from the calendars within minutes.",
  cleanupsLink: "Show them",
  cleanupsText: (count: number) =>
    count === 1
      ? "Copies of a deleted person are left in 1 calendar."
      : `Copies of deleted people are left in ${count} calendars.`,

  // People
  peopleLabel: "People",
  peopleHint: "Everyone who signed in to this deployment.",
  peopleEmpty: "Nobody has signed in yet.",
  openPerson: (email: string) => `Open ${email}`,
  calendarsCount: (count: number) =>
    count === 0 ? "No calendars" : count === 1 ? "1 calendar" : `${count} calendars`,
  tokensCount: (count: number) => (count === 1 ? "1 token or app" : `${count} tokens and apps`),
  needsReconnect: (count: number) =>
    count === 1 ? "1 calendar needs reconnecting" : `${count} calendars need reconnecting`,
  signedIn: (time: string) => `Signed in ${time}`,
  neverSignedIn: "Never signed in",
  reconnectSummary: (count: number) =>
    count === 1
      ? "1 person has a calendar with a lost connection. Nothing is copied to or from it until they reconnect it."
      : `${count} people have calendars with a lost connection. Nothing is copied to or from them until each person reconnects them.`,
  addPeople:
    "People appear here when they sign in for the first time. Who may sign in is set with the Worker variables of this deployment.",

  // Panel of one person
  sectionPerson: "Person",
  role: "Role",
  calendars: "Calendars",
  reconnect: "Connection lost",
  lastSignIn: "Last sign-in",
  tokensAndApps: "Tokens and apps",
  none: "None",
  you: "This is you. You cannot unlink or delete yourself here. To delete your own data, use the account menu.",
  sectionSignIn: "Sign-in",
  resetSignIn: "Unlink sign-in",
  resetSignInHint:
    "Unbinds this person from their Microsoft or Google identity and ends their sessions. For 24 hours, a sign-in with a verified address binds them to a new identity. The previous identity stays refused. After that, unlink again.",
  doneReset: "Sign-in unlinked. Their sessions ended.",
  sectionApi: "API access",
  revokeTokens: (count: number) =>
    count === 1 ? "End 1 token or app" : `End ${count} tokens and apps`,
  revokeTokensHint:
    "Ends their API tokens and connected apps at once. Removing someone in the identity provider does not do this.",
  noApiAccess: "This person has no tokens and no connected apps.",
  doneRevoked: "Tokens and apps ended.",
  sectionRemove: "Remove",
  deletePerson: "Delete person",
  deleteHint: "Removes the person with their calendars and all their settings.",

  // Confirmation of a deletion
  confirmDeleteTitle: (email: string) => `Delete ${email}?`,
  confirmDelete: (email: string, calendars: number) =>
    `This deletes ${email} with ${
      calendars === 1 ? "1 connected calendar" : `${calendars} connected calendars`
    }, all their settings and the copies slotmirror wrote, from today on, and it cannot be undone.`,
  confirmDeleteNote:
    "Past copies stay in the calendars. Activity entries stay until the retention period ends, without event contents.",
  confirmDeleteButton: "Delete person",
  cancel: "Cancel",

  // Access
  limitsTitle: "Privacy limits",
  limitsLead:
    "How much of an event may move between work calendars and private calendars. This holds for everyone, also if someone sets more in their own settings.",
  orgAccounts: (list: string) =>
    `Work calendars are those at ${list}. Every other calendar counts as private.`,
  orgNone:
    "No work domain or Entra tenant is set (ALLOWED_DOMAINS, ALLOWED_TENANT_IDS), so there are no limits.",
  tenants: (count: number) => (count === 1 ? "1 Entra tenant" : `${count} Entra tenants`),
  limitToExternal: "Work events in private calendars",
  limitFromExternal: "Private events in work calendars",
  limitNone: "No limit",
  limitAtMost: (level: string) => `At most “${level}”`,
  /** The levels of a limit; "title_location" is between Title and Everything. */
  limitLevels: {
    busy: "Busy only",
    title: "Title",
    title_location: "Title and location",
    full: "Everything",
  },
  limitsHow:
    "Change these limits with the Worker variables MAX_DETAIL_TO_EXTERNAL and MAX_DETAIL_FROM_EXTERNAL.",
  mcpTitle: "MCP for members",
  mcpLead:
    "Whether members, not only admins, may create API tokens, connect apps and use the MCP endpoint. Turned off, the tokens and apps of members stay and stop working.",
  mcpChoices: {
    off: "Admins only",
    all: "All members",
  },
  mcpInvalid: "Choose admins only or all members.",
  save: "Save",
  saved: "Saved",

  // Health
  compareTitle: "Comparison",
  compareLead:
    "Compares each target calendar with its sources: copies that are missing, left over, different or doubled.",
  compareStart: "Start comparison",
  compareCounts: (started: number, open: number, failed: number) =>
    `${started} started, ${open} still open, ${failed} failed. A calendar stays open until its comparison ends. Results appear here within minutes.`,
  compareEmpty: "No comparison yet.",
  compareHorizon:
    "A comparison leaves out the all-day copies of today and the last day of each time window. It counts a finding only if the finding stays after a successful run. A comparison of the whole window also reads writable calendars without a mirroring: every copy from slotmirror there is left over.",
  compareModes: {
    full: "Whole window",
    near: "Next 7 days",
    leftover: "Calendar without a mirroring",
  },
  alertsTitle: "Alerts",
  alertsLead: "Send a test message to the webhook of this deployment. One per minute.",
  alertsOff: "This deployment has no alert webhook, so it sends no alerts.",
  testAlertSend: "Send test alert",
  testAlertResults: {
    sent: "The webhook accepted the test alert.",
    off: "This deployment has no alert webhook. Nothing was sent.",
    failed: "The webhook did not accept the test alert. The Worker log has the reason.",
    limited: "A test alert was requested less than a minute ago. Try again in a minute.",
  },
  activityTitle: "Latest entries",
  activityLead: (count: number) =>
    `The last ${count} entries of everyone in this deployment. Metadata only.`,
  activityAll: "Show all",
  activityEmpty: "No entries yet.",
};

export type AdminMessages = typeof adminEn;

export const adminDe: AdminMessages = {
  title: "Verwaltung",
  lead: "Personen, Zugriff und Zustand dieser Installation.",
  intro:
    "Kalenderinhalte bleiben für jede Person privat. Diese Seite zeigt nur Anzahlen und Zeiten.",
  onlyAdmins: "Nur Admins können diese Seite öffnen.",
  tabsLabel: "Bereiche der Verwaltung",
  tabs: {
    people: "Personen",
    access: "Zugriff",
    health: "Zustand",
  },
  doneDeleted:
    "Die Person ist gelöscht. Ihre Kopien verschwinden in wenigen Minuten aus den Kalendern.",
  cleanupsLink: "Anzeigen",
  cleanupsText: (count: number) =>
    count === 1
      ? "Kopien einer gelöschten Person sind in 1 Kalender übrig."
      : `Kopien gelöschter Personen sind in ${count} Kalendern übrig.`,

  peopleLabel: "Personen",
  peopleHint: "Alle, die sich bei dieser Installation angemeldet haben.",
  peopleEmpty: "Noch hat sich niemand angemeldet.",
  openPerson: (email: string) => `${email} öffnen`,
  calendarsCount: (count: number) =>
    count === 0 ? "Keine Kalender" : count === 1 ? "1 Kalender" : `${count} Kalender`,
  tokensCount: (count: number) => (count === 1 ? "1 Token oder App" : `${count} Tokens und Apps`),
  needsReconnect: (count: number) =>
    count === 1 ? "1 Kalender ohne Verbindung" : `${count} Kalender ohne Verbindung`,
  signedIn: (time: string) => `Angemeldet ${time}`,
  neverSignedIn: "Nie angemeldet",
  reconnectSummary: (count: number) =>
    count === 1
      ? "1 Person hat einen Kalender ohne Verbindung. Bis die Person ihn neu verbindet, wird nichts aus diesem oder in diesen Kalender kopiert."
      : `${count} Personen haben Kalender ohne Verbindung. Bis jede Person ihre Kalender neu verbindet, wird nichts aus diesen oder in diese Kalender kopiert.`,
  addPeople:
    "Personen erscheinen hier, sobald sie sich zum ersten Mal anmelden. Wer sich anmelden darf, legst du mit den Worker-Variablen dieser Installation fest.",

  sectionPerson: "Person",
  role: "Rolle",
  calendars: "Kalender",
  reconnect: "Verbindung unterbrochen",
  lastSignIn: "Letzte Anmeldung",
  tokensAndApps: "Tokens und Apps",
  none: "Keine",
  you: "Das bist du. Dich selbst kannst du hier weder lösen noch löschen. Deine eigenen Daten löschst du über das Kontomenü.",
  sectionSignIn: "Anmeldung",
  resetSignIn: "Anmeldung lösen",
  resetSignInHint:
    "Löst die Bindung an die Microsoft- oder Google-Identität und beendet die Sitzungen. 24 Stunden lang bindet eine Anmeldung mit einer bestätigten Adresse die Person an eine neue Identität. Die bisherige Identität bleibt gesperrt. Danach musst du sie erneut lösen.",
  doneReset: "Anmeldung gelöst. Die Sitzungen sind beendet.",
  sectionApi: "API-Zugriff",
  revokeTokens: (count: number) =>
    count === 1 ? "1 Token oder App beenden" : `${count} Tokens und Apps beenden`,
  revokeTokensHint:
    "Beendet die API-Tokens und verbundenen Apps der Person sofort. Das Entfernen im Identity Provider tut das nicht.",
  noApiAccess: "Diese Person hat keine Tokens und keine verbundenen Apps.",
  doneRevoked: "Tokens und Apps beendet.",
  sectionRemove: "Entfernen",
  deletePerson: "Person löschen",
  deleteHint: "Entfernt die Person mit ihren Kalendern und allen Einstellungen.",

  confirmDeleteTitle: (email: string) => `${email} löschen?`,
  confirmDelete: (email: string, calendars: number) =>
    `Damit werden ${email} mit ${
      calendars === 1 ? "1 verbundenem Kalender" : `${calendars} verbundenen Kalendern`
    }, allen Einstellungen und den von slotmirror geschriebenen Kopien ab heute gelöscht. Das lässt sich nicht rückgängig machen.`,
  confirmDeleteNote:
    "Vergangene Kopien bleiben in den Kalendern. Einträge in der Aktivität bleiben bis zum Ende der Aufbewahrungsfrist, ohne Termininhalte.",
  confirmDeleteButton: "Person löschen",
  cancel: "Abbrechen",

  limitsTitle: "Datenschutz-Grenzen",
  limitsLead:
    "Wie viel von einem Termin höchstens zwischen Firmenkalendern und privaten Kalendern wandert. Das gilt für alle, auch wenn jemand in seinen Einstellungen mehr wählt.",
  orgAccounts: (list: string) =>
    `Als Firmenkalender zählen Kalender bei ${list}. Alle anderen Kalender gelten als privat.`,
  orgNone:
    "Es ist keine Firmen-Domain und kein Entra-Tenant gesetzt (ALLOWED_DOMAINS, ALLOWED_TENANT_IDS). Damit gibt es keine Grenzen.",
  tenants: (count: number) => (count === 1 ? "1 Entra-Tenant" : `${count} Entra-Tenants`),
  limitToExternal: "Firmentermine in privaten Kalendern",
  limitFromExternal: "Private Termine in Firmenkalendern",
  limitNone: "Keine Grenze",
  limitAtMost: (level: string) => `Höchstens „${level}“`,
  limitLevels: {
    busy: "Nur belegt",
    title: "Titel",
    title_location: "Titel und Ort",
    full: "Alles",
  },
  limitsHow:
    "Ändere die Grenzen mit den Worker-Variablen MAX_DETAIL_TO_EXTERNAL und MAX_DETAIL_FROM_EXTERNAL.",
  mcpTitle: "MCP für Mitglieder",
  mcpLead:
    "Ob Mitglieder, nicht nur Admins, API-Tokens anlegen, Apps verbinden und den MCP-Endpunkt nutzen dürfen. Ausgeschaltet bleiben die Tokens und Apps von Mitgliedern bestehen und funktionieren nicht mehr.",
  mcpChoices: {
    off: "Nur Admins",
    all: "Alle Mitglieder",
  },
  mcpInvalid: "Wähle „Nur Admins“ oder „Alle Mitglieder“.",
  save: "Speichern",
  saved: "Gespeichert",

  compareTitle: "Vergleich",
  compareLead:
    "Vergleicht jeden Zielkalender mit seinen Quellen: Kopien, die fehlen, übrig sind, abweichen oder doppelt vorkommen.",
  compareStart: "Vergleich starten",
  compareCounts: (started: number, open: number, failed: number) =>
    `${started} gestartet, ${open} noch offen, ${failed} fehlgeschlagen. Ein Kalender bleibt offen, bis sein Vergleich endet. Ergebnisse erscheinen in wenigen Minuten hier.`,
  compareEmpty: "Noch kein Vergleich.",
  compareHorizon:
    "Ein Vergleich lässt die ganztägigen Kopien von heute und den letzten Tag jedes Zeitraums aus. Ein Treffer zählt erst, wenn er nach einem erfolgreichen Lauf bleibt. Ein Vergleich des ganzen Zeitraums liest auch beschreibbare Kalender ohne Spiegelung: Jede Kopie von slotmirror dort ist übrig.",
  compareModes: {
    full: "Ganzer Zeitraum",
    near: "Nächste 7 Tage",
    leftover: "Kalender ohne Spiegelung",
  },
  alertsTitle: "Alarme",
  alertsLead: "Sende eine Testnachricht an den Webhook dieser Installation. Eine pro Minute.",
  alertsOff: "Diese Installation hat keinen Alarm-Webhook und sendet deshalb keine Alarme.",
  testAlertSend: "Test-Alarm senden",
  testAlertResults: {
    sent: "Der Webhook hat den Test-Alarm angenommen.",
    off: "Diese Installation hat keinen Alarm-Webhook. Es wurde nichts gesendet.",
    failed: "Der Webhook hat den Test-Alarm nicht angenommen. Das Worker-Log nennt den Grund.",
    limited:
      "Ein Test-Alarm wurde vor weniger als einer Minute angefordert. Versuche es in einer Minute wieder.",
  },
  activityTitle: "Letzte Einträge",
  activityLead: (count: number) =>
    `Die letzten ${count} Einträge aller Personen dieser Installation. Nur Metadaten.`,
  activityAll: "Alle anzeigen",
  activityEmpty: "Noch keine Einträge.",
};
