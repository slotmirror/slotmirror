/**
 * Strings of the API tokens page of the redesign. The English object defines the shape; the German
 * one must match it. `en.ts` and `de.ts` wire both under `next.tokens`.
 */
export const tokensEn = {
  title: "API tokens",
  lead: "Read access for agents and scripts.",
  intro:
    "A token lets an AI agent or script read your calendars, mirrorings and their runs. It cannot change anything and sees no event content.",
  /** The intro while the deployment offers events. The box is in the form for a new token. */
  introWithEvents:
    "A token lets an AI agent or script read your calendars, mirrorings and their runs. It cannot change anything. It sees event content only if you tick the box for calendar events when you create it.",
  newToken: "New token",
  membersOff:
    "An admin turned MCP off for members of this deployment. You cannot create tokens or connect apps, and your tokens and apps do not work until an admin turns it back on. You can still revoke them.",
  tokensLabel: "Your tokens",
  tokensHint: (endpoint: string) => `Read-only. Endpoint: ${endpoint}`,
  tokensEmpty: "No tokens yet",
  tokensEmptyText: "Create a token to let an agent or script read your mirrorings.",
  openToken: (name: string) => `Open ${name}`,
  endsIn: (lastFour: string) => `Ends in …${lastFour}`,
  expires: (when: string) => `Expires ${when}`,
  expired: "Expired",
  lastUsed: (when: string) => `Used ${when}`,
  neverUsed: "Never used",
  appsLabel: "Connected apps",
  appsHint:
    "Apps that you allowed to read your data with your sign-in, such as Claude. They get no token to copy.",
  appsEmpty: "No connected apps.",
  unnamedApp: "An unnamed app",
  openApp: (name: string) => `Open ${name}`,
  connectedAt: (when: string) => `Connected ${when}`,
  refreshedAt: (when: string) => `Refreshed ${when}`,
  neverRefreshed: "Never refreshed",

  // Panel of a token
  sectionToken: "Token",
  name: "Name",
  endsInLabel: "Ends in",
  created: "Created",
  expiresLabel: "Expires",
  lastUsedLabel: "Last used",
  never: "Never",
  access: "Access",
  readOnly: "Read only",
  readOnlyEvents: "Read only, also calendar events",
  endpoint: "Endpoint",
  sectionRevoke: "Revoke",
  revoke: "Revoke token",
  revokeHint: "Agents and scripts that use this token lose access at once.",
  confirmRevokeTitle: (name: string) => `Revoke ${name}?`,
  confirmRevoke: (name: string) =>
    `The token “${name}” stops working at once, and this cannot be undone.`,
  confirmRevokeButton: "Revoke token",
  cancel: "Cancel",

  // Panel of a connected app
  sectionApp: "App",
  app: "App",
  connected: "Connected",
  refreshed: "Last refresh",
  disconnect: "Disconnect app",
  disconnectHint: "The app loses access at once. To use it again, you connect it again.",
  confirmDisconnectTitle: (name: string) => `Disconnect ${name}?`,
  confirmDisconnect: (name: string) =>
    `“${name}” loses access at once. To use it again, you must allow it again.`,
  confirmDisconnectButton: "Disconnect app",

  // Creating a token
  createTitle: "New token",
  lifetime: "Valid for",
  days: (count: number) => `${count} days`,
  nameHint: "For example the agent or script that uses it.",
  limitsHint: (maxTokens: number, dailyCalls: number) =>
    `You can have ${maxTokens} active tokens. Each person can make ${dailyCalls} tool calls per day.`,
  create: "Create token",
  invalid: "Enter a name and choose a lifetime.",
  limitReached: "You have the maximum of active tokens. Revoke one first.",

  // The token, shown once
  createdTitle: "Copy your token now",
  createdHint:
    "You will not see it again. slotmirror stores only a hash. If you lose it, create a new one.",
  tokenLabel: "Your token",
  claudeCode: "Add it to Claude Code",
  copy: "Copy",
  copied: "Copied",
  done: "Done",
};

export type TokensMessages = typeof tokensEn;

export const tokensDe: TokensMessages = {
  title: "API-Tokens",
  lead: "Lesezugriff für Agenten und Skripte.",
  intro:
    "Mit einem Token kann ein KI-Agent oder Skript deine Kalender, Spiegelungen und deren Läufe lesen. Er kann nichts ändern und sieht keine Termininhalte.",
  introWithEvents:
    "Mit einem Token kann ein KI-Agent oder Skript deine Kalender, Spiegelungen und deren Läufe lesen. Er kann nichts ändern. Termininhalte sieht er nur, wenn du beim Erstellen das Feld für Kalendertermine anhakst.",
  newToken: "Neuer Token",
  membersOff:
    "Ein Admin hat MCP für Mitglieder dieser Installation ausgeschaltet. Du kannst keine Tokens anlegen und keine Apps verbinden, und deine Tokens und Apps funktionieren erst wieder, wenn ein Admin es einschaltet. Widerrufen kannst du sie weiterhin.",
  tokensLabel: "Deine Tokens",
  tokensHint: (endpoint: string) => `Nur lesen. Endpunkt: ${endpoint}`,
  tokensEmpty: "Noch keine Tokens",
  tokensEmptyText:
    "Lege einen Token an, damit ein Agent oder Skript deine Spiegelungen lesen kann.",
  openToken: (name: string) => `${name} öffnen`,
  endsIn: (lastFour: string) => `Endet auf …${lastFour}`,
  expires: (when: string) => `Läuft ab ${when}`,
  expired: "Abgelaufen",
  lastUsed: (when: string) => `Genutzt ${when}`,
  neverUsed: "Nie genutzt",
  appsLabel: "Verbundene Apps",
  appsHint:
    "Apps, denen du mit deiner Anmeldung das Lesen erlaubt hast, etwa Claude. Sie bekommen keinen Token zum Kopieren.",
  appsEmpty: "Keine verbundenen Apps.",
  unnamedApp: "Eine App ohne Namen",
  openApp: (name: string) => `${name} öffnen`,
  connectedAt: (when: string) => `Verbunden ${when}`,
  refreshedAt: (when: string) => `Erneuert ${when}`,
  neverRefreshed: "Nie erneuert",

  sectionToken: "Token",
  name: "Name",
  endsInLabel: "Endet auf",
  created: "Angelegt",
  expiresLabel: "Läuft ab",
  lastUsedLabel: "Zuletzt genutzt",
  never: "Nie",
  access: "Zugriff",
  readOnly: "Nur lesen",
  readOnlyEvents: "Nur lesen, auch Kalendertermine",
  endpoint: "Endpunkt",
  sectionRevoke: "Widerrufen",
  revoke: "Token widerrufen",
  revokeHint: "Agenten und Skripte, die diesen Token nutzen, verlieren sofort den Zugriff.",
  confirmRevokeTitle: (name: string) => `${name} widerrufen?`,
  confirmRevoke: (name: string) =>
    `Der Token „${name}“ funktioniert sofort nicht mehr. Das lässt sich nicht rückgängig machen.`,
  confirmRevokeButton: "Token widerrufen",
  cancel: "Abbrechen",

  sectionApp: "App",
  app: "App",
  connected: "Verbunden",
  refreshed: "Zuletzt erneuert",
  disconnect: "App trennen",
  disconnectHint:
    "Die App verliert sofort den Zugriff. Um sie wieder zu nutzen, verbindest du sie neu.",
  confirmDisconnectTitle: (name: string) => `${name} trennen?`,
  confirmDisconnect: (name: string) =>
    `„${name}“ verliert sofort den Zugriff. Um sie wieder zu nutzen, musst du sie neu erlauben.`,
  confirmDisconnectButton: "App trennen",

  createTitle: "Neuer Token",
  lifetime: "Gültig für",
  days: (count: number) => `${count} Tage`,
  nameHint: "Zum Beispiel der Agent oder das Skript, das ihn nutzt.",
  limitsHint: (maxTokens: number, dailyCalls: number) =>
    `Du kannst ${maxTokens} aktive Tokens haben. Jede Person kann ${dailyCalls} Tool-Aufrufe pro Tag machen.`,
  create: "Token erstellen",
  invalid: "Gib einen Namen ein und wähle eine Laufzeit.",
  limitReached: "Du hast die Höchstzahl aktiver Tokens. Widerrufe zuerst einen.",

  createdTitle: "Kopiere deinen Token jetzt",
  createdHint:
    "Du siehst ihn nicht noch einmal. slotmirror speichert nur einen Hash. Geht er verloren, legst du einen neuen an.",
  tokenLabel: "Dein Token",
  claudeCode: "In Claude Code hinzufügen",
  copy: "Kopieren",
  copied: "Kopiert",
  done: "Fertig",
};
