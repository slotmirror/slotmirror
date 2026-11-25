import type { Query } from "./batch";
import { auditStatement, recordAudit, type AuditEvent } from "./audit";
import { resolveAccountColorState, type AccountColor } from "./colors";
import {
  PASS_CALENDAR_PREFIX,
  parseRuleOptions,
  ruleOptionsSchema,
  type Provider,
  type RuleOptions,
} from "./config";
import { detailLevelFor, type AccountIdentity, type DetailLevel } from "./detail-policy";
import { accountSync } from "./durable";
import { displayTimeZone } from "./i18n";
import { carrier, log } from "./telemetry";
import {
  ALL_WEEKDAYS,
  canonicalTimeZone,
  hasWorkingHours,
  workingHoursProblem,
  type WorkingHoursProblem,
} from "./sync/working-hours";
import type { CurrentUser } from "./users";

/**
 * The calendar editor shows one choice per direction between two accounts: from the source
 * calendars of one account into the main calendar of the other. A direction is one rule in D1 per
 * source calendar, all with the same choice, so the sync engine stays unaware of the editor. The
 * main calendar is a source until the user turns it off; other calendars, such as subscriptions,
 * are sources only once the user turns them on.
 *
 * Accounts in the block group see each other as busy. Those rules have origin "group". A choice
 * that differs from the group is a rule with origin "custom". "Off" between two group members is a
 * custom rule that is disabled, so that the group does not bring it back.
 */
export type Choice = "off" | "busy" | "title" | "full";

export const CHOICES: readonly Choice[] = ["off", "busy", "title", "full"];

/**
 * What a direction shows, as the editor offers it: a detail level, and for every copied level
 * whether the copies carry the private mark. Others then see a private item (Microsoft) or "busy"
 * (Google) instead of the copy's title. Storage stays `detailLevel` plus `markPrivate`.
 */
export type Level =
  | "off"
  | "busy-private"
  | "busy-open"
  | "title-private"
  | "title-open"
  | "full-private"
  | "full-open";

export const LEVELS: readonly Level[] = [
  "off",
  "busy-private",
  "busy-open",
  "title-private",
  "title-open",
  "full-private",
  "full-open",
];

/** A direction's level from its detail level and private mark. Off carries no mark. */
export function levelOf(choice: Choice, markPrivate: boolean): Level {
  if (choice === "off") return choice;
  return `${choice}-${markPrivate ? "private" : "open"}`;
}

/**
 * Read a choice of the editor: a level, or a bare detail level, which keeps the mark of the
 * direction (see `setDirections`). Off takes no mark. Anything else is null.
 */
export function parseLevel(value: string): { choice: Choice; markPrivate?: boolean } | null {
  if ((CHOICES as readonly string[]).includes(value)) return { choice: value as Choice };
  const [choice, mark, ...rest] = value.split("-");
  if (rest.length > 0 || (choice !== "busy" && choice !== "title" && choice !== "full")) {
    return null;
  }
  if (mark === "private") return { choice, markPrivate: true };
  if (mark === "open") return { choice, markPrivate: false };
  return null;
}

/**
 * The mark of a direction's copies as one answer: true only if every enabled rule of the direction
 * is private, so that a direction with mixed marks shows the more visible state. Null if no rule
 * is enabled; the caller then decides, usually from the user's default.
 */
export function directionMarksPrivate(direction: Pick<EditorDirection, "slots">): boolean | null {
  const marks = direction.slots.flatMap((slot) =>
    slot.rule?.enabled ? [slot.rule.options.markPrivate] : [],
  );
  return marks.length === 0 ? null : marks.every(Boolean);
}

export interface EditorAccount {
  id: string;
  provider: Provider;
  email: string;
  tenantId: string | null;
  /** When the account was connected, as stored (an ISO time). */
  createdAt: string;
  inGroup: boolean;
  /** The provider refused the refresh token; nothing syncs until the user connects again. */
  needsReconnect: boolean;
  /** Display name: the one the user gave, or else the derived one. */
  name: string;
  /** Short name derived from the address. */
  derivedName: string;
  /** The name the user gave; null if the account uses the derived name. */
  customName: string | null;
  /** Colour in the pages: the stored one, or the next unused one. */
  color: AccountColor;
  /** True if the user chose the colour; false if it is automatic. */
  colorChosen: boolean;
  /** Main calendar; null until the calendars are loaded or if the account has none it can write. */
  calendar: { id: string; remoteId: string; canEdit: boolean } | null;
  /** Every calendar of the account, for the choice of sources. */
  calendars: { id: string; name: string; isMain: boolean; isSource: boolean }[];
  /** Working hours of the account (see `setAccountWorkHours`); null if it has none. */
  workHours: AccountWorkHours | null;
  /**
   * The working hours as stored, for a write that must find them unchanged. Optional, so that a
   * state built by hand without it still type-checks; such a state guards nothing here.
   */
  workHoursJson?: string | null;
  /** Options of the account as a source (see `SourceOptions`); null if it never stored any. */
  sourceOptions: SourceOptions | null;
}

/** The rule of one source calendar within a direction; null if it has none yet. */
interface Slot {
  sourceCalendarId: string;
  rule: SlotRule | null;
}

interface SlotRule {
  id: string;
  enabled: boolean;
  origin: "group" | "custom";
  options: RuleOptions;
  /** The options as stored, so that a write can require that they did not change meanwhile. */
  optionsJson: string;
}

export interface EditorDirection {
  from: string;
  to: string;
  ruleId: string | null;
  choice: Choice;
  origin: "group" | "custom" | null;
  /** The level the rule runs with after the org caps, and whether a cap lowered it. */
  effective: Choice;
  capped: boolean;
  /** The highest choice the org caps allow. */
  maxChoice: Choice;
  options: RuleOptions | null;
  /** One entry per source calendar. ruleId, choice and options above come from the first rule. */
  slots: Slot[];
  /**
   * "Off" exceptions kept from calendars that are no longer sources (see `setSourceCalendar`), so
   * that the group does not replace them when a source comes back.
   */
  parked: SlotRule[];
  /** The source account has group rules into another calendar of the target, e.g. an old main. */
  elsewhere: boolean;
}

/** Settings for all rules of a user. The editor shows them once, not per direction. */
export type SyncSettings = Pick<
  RuleOptions,
  "daysAhead" | "skipAllDay" | "skipTentative" | "markPrivate" | "blockTitle" | "skipCategories"
>;

/** The settings of the editor state: the stored ones, and whether a block title is among them. */
export type EditorSettings = SyncSettings & {
  /**
   * True if `users.sync_settings` holds a block title. If not, `blockTitle` is the schema default,
   * and a page shows the default of the user's language instead (see `withLocalizedTitle`).
   * `parseEditorState` always sets it; a stub state without it counts as stored.
   */
  blockTitleStored?: boolean;
};

export interface EditorState {
  accounts: EditorAccount[];
  directions: EditorDirection[];
  settings: EditorSettings;
  /** Rules that do not run between two main calendars. The editor lists them, so none hides. */
  others: { ruleId: string; source: string; target: string; choice: Choice }[];
  /** Every rule of the user, with its source and target account, for changes per account. */
  rules: { from: string; to: string; rule: SlotRule }[];
}

const PUBLIC_PROVIDERS: Record<string, string> = {
  "gmail.com": "Gmail",
  "googlemail.com": "Gmail",
  "outlook.com": "Outlook",
  "hotmail.com": "Outlook",
  "live.com": "Outlook",
  "icloud.com": "iCloud",
  "me.com": "iCloud",
};

/**
 * Short names from the addresses: "Gmail" for gmail.com, the first label of the domain otherwise.
 * If two accounts get the same name, both add the part before the @.
 */
export function shortNames(emails: string[]): string[] {
  const base = emails.map((email) => {
    const [local = "", domain = ""] = email.toLowerCase().split("@");
    return { local, name: PUBLIC_PROVIDERS[domain] ?? domain.split(".")[0] ?? email };
  });
  return base.map(({ local, name }) =>
    base.filter((other) => other.name === name).length > 1 ? `${name} (${local})` : name,
  );
}

function choiceOf(options: RuleOptions, enabled: boolean): Choice {
  if (!enabled) return "off";
  // "title_location" is not offered in the editor; it shows as the nearest lower choice.
  return options.detailLevel === "title_location" ? "title" : options.detailLevel;
}

const RANK: Record<Choice, number> = { off: 0, busy: 1, title: 2, full: 3 };

function toChoice(level: DetailLevel): Choice {
  return level === "title_location" ? "title" : level;
}

interface AccountRow {
  id: string;
  provider: Provider;
  email: string;
  tenantId: string | null;
  createdAt: string;
  inGroup: number;
  displayName: string | null;
  needsReconnect: number;
  color: string | null;
  workHours: string | null;
  sourceOptions: string | null;
}

interface CalendarRow {
  id: string;
  accountId: string;
  remoteId: string;
  name: string;
  canEdit: number;
  isMain: number;
  isSource: number;
}

interface RuleRow {
  id: string;
  sourceId: string;
  targetId: string;
  options: string;
  enabled: number;
  origin: "group" | "custom";
  sourceName: string;
  sourceAccountId: string;
  targetName: string;
  targetAccountId: string;
}

/**
 * The four reads of the editor state, for one D1 batch. A page that needs more than the state puts
 * these statements into its own batch and hands the results to `parseEditorState`.
 */
export function editorStatements(db: D1Database, userId: string): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `SELECT id, provider, email, tenant_id AS tenantId, created_at AS createdAt,
              in_block_group AS inGroup,
              display_name AS displayName, needs_reconnect AS needsReconnect, color,
              work_hours AS workHours, source_options AS sourceOptions
       FROM accounts WHERE user_id = ? ORDER BY created_at, id`,
      )
      .bind(userId),
    db
      .prepare(
        `SELECT c.id, c.account_id AS accountId, c.remote_id AS remoteId, c.name,
              c.can_edit AS canEdit, c.is_default AS isMain, c.is_source AS isSource
       FROM calendars c JOIN accounts a ON a.id = c.account_id
       WHERE a.user_id = ? ORDER BY c.is_default DESC, c.name`,
      )
      .bind(userId),
    db
      .prepare(
        `SELECT r.id, r.source_calendar_id AS sourceId, r.target_calendar_id AS targetId, r.options,
              r.enabled, r.origin, sc.name AS sourceName, sc.account_id AS sourceAccountId,
              tc.name AS targetName, tc.account_id AS targetAccountId
       FROM rules r
       JOIN calendars sc ON sc.id = r.source_calendar_id
       JOIN calendars tc ON tc.id = r.target_calendar_id
       WHERE r.user_id = ?`,
      )
      .bind(userId),
    db.prepare("SELECT sync_settings AS json FROM users WHERE id = ?").bind(userId),
  ];
}

/** `editorStatements` and `parseEditorState` as a query for a batch (see `src/batch.ts`). */
export function editorQuery(
  env: Env,
  userId: string,
): Query<{ state: EditorState; colorWrites: D1PreparedStatement[] }> {
  return {
    statements: editorStatements(env.DB, userId),
    parse: (results) => parseEditorState(env, results),
  };
}

/** The editor state. One batch reads it, which counts as one D1 query per invocation. */
export async function loadEditorState(env: Env, userId: string): Promise<EditorState> {
  const results = await env.DB.batch(editorStatements(env.DB, userId));
  const { state, colorWrites } = parseEditorState(env, results);
  if (colorWrites.length > 0) await env.DB.batch(colorWrites);
  return state;
}

/**
 * The editor state from the results of `editorStatements`. It writes nothing. Accounts without a
 * stored colour get the next unused one for display; `colorWrites` holds the statements that store
 * them, so that they stay when another account gets a colour later. Run them only if the list is
 * not empty: that is rare, and not part of the page's batch.
 */
export function parseEditorState(
  env: Env,
  results: D1Result[],
): { state: EditorState; colorWrites: D1PreparedStatement[] } {
  const [accountResult, calendarResult, ruleResult, settingsResult] = results;
  const accountRows = (accountResult?.results ?? []) as AccountRow[];
  const calendarRows = (calendarResult?.results ?? []) as CalendarRow[];
  const ruleRows = (ruleResult?.results ?? []) as RuleRow[];
  const settingsRow = settingsResult?.results[0] as { json: string } | undefined;
  const calendarById = new Map(calendarRows.map((calendar) => [calendar.id, calendar]));
  // A disabled rule that `setSourceCalendar` marked, while its calendar is not a source.
  const isParked = (row: RuleRow) =>
    row.enabled === 0 &&
    isMarkedParked(row.options) &&
    calendarById.get(row.sourceId)?.isSource === 0;
  const names = shortNames(accountRows.map((row) => row.email));
  const colors = resolveAccountColorState(accountRows.map((row) => row.color));
  // Assigned colours are stored by the caller, so that they stay when another account gets a
  // colour later.
  const colorWrites = accountRows
    .filter((row, index) => colors[index]?.stored !== row.color)
    .map((row) =>
      env.DB.prepare("UPDATE accounts SET color = ? WHERE id = ?").bind(
        colors[accountRows.indexOf(row)]?.stored ?? null,
        row.id,
      ),
    );
  const accounts: EditorAccount[] = accountRows.map((row, index) => {
    const own = calendarRows.filter((calendar) => calendar.accountId === row.id);
    const main = own.find((calendar) => calendar.isMain === 1);
    const derivedName = names[index] ?? row.email;
    return {
      id: row.id,
      provider: row.provider,
      email: row.email,
      tenantId: row.tenantId,
      createdAt: row.createdAt,
      inGroup: row.inGroup === 1,
      needsReconnect: row.needsReconnect === 1,
      name: row.displayName ?? derivedName,
      derivedName,
      // A stored name equal to the derived one came from a form that sent the derived name back.
      customName: row.displayName === derivedName ? null : row.displayName,
      color: colors[index]?.color ?? "slate",
      colorChosen: colors[index]?.chosen ?? false,
      calendar: main ? { id: main.id, remoteId: main.remoteId, canEdit: main.canEdit === 1 } : null,
      calendars: own.map((calendar) => ({
        id: calendar.id,
        name: calendar.name,
        isMain: calendar.isMain === 1,
        isSource: calendar.isSource === 1,
      })),
      workHours: parseAccountHours(row.workHours),
      workHoursJson: row.workHours,
      sourceOptions: parseSourceOptions(row.sourceOptions),
    };
  });

  const byPair = new Map(ruleRows.map((row) => [`${row.sourceId}>${row.targetId}`, row]));

  const directions: EditorDirection[] = [];
  for (const from of accounts) {
    const sources = from.calendars.filter((calendar) => calendar.isSource);
    for (const to of accounts) {
      if (from.id === to.id || sources.length === 0 || !to.calendar) continue;
      const slots: Slot[] = sources.map((source) => {
        const row = byPair.get(`${source.id}>${to.calendar?.id}`);
        return {
          sourceCalendarId: source.id,
          rule: row
            ? {
                id: row.id,
                enabled: row.enabled === 1,
                origin: row.origin,
                options: parseRuleOptions(row.options),
                optionsJson: row.options,
              }
            : null,
        };
      });
      const parkedRows = ruleRows.filter(
        (row) =>
          isParked(row) && row.sourceAccountId === from.id && row.targetId === to.calendar?.id,
      );
      const first = slots.find((slot) => slot.rule)?.rule ?? null;
      const choice = first ? choiceOf(first.options, first.enabled) : "off";
      const max = toChoice(detailLevelFor(env, "full", from, to).level);
      const effective = RANK[choice] > RANK[max] ? max : choice;
      directions.push({
        from: from.id,
        to: to.id,
        ruleId: first?.id ?? null,
        choice,
        origin: first?.origin ?? null,
        effective,
        capped: effective !== choice,
        maxChoice: max,
        options: first?.options ?? null,
        slots,
        parked: parkedRows.map((row) => ({
          id: row.id,
          enabled: false,
          origin: "custom" as const,
          options: parseRuleOptions(row.options),
          optionsJson: row.options,
        })),
        // Custom rules into another calendar, such as a manual rule, do not count: they are not
        // the group's blocks, and the group's rule into the main calendar does not repeat them.
        elsewhere: ruleRows.some(
          (row) =>
            row.origin === "group" &&
            row.sourceAccountId === from.id &&
            row.targetAccountId === to.id &&
            row.targetId !== to.calendar?.id,
        ),
      });
    }
  }
  // Every rule the directions above do not cover shows in its own list, so that none hides.
  // Parked exceptions write nothing and come back with their calendar, so they do not show.
  const covered = new Set([
    ...directions.flatMap((direction) => direction.slots.flatMap((slot) => slot.rule?.id ?? [])),
    ...ruleRows.filter(isParked).map((row) => row.id),
  ]);
  const nameOf = (accountId: string) =>
    accounts.find((account) => account.id === accountId)?.name ?? "?";
  const others = ruleRows
    .filter((row) => !covered.has(row.id))
    .map((row) => ({
      ruleId: row.id,
      source: `${nameOf(row.sourceAccountId)} · ${row.sourceName}`,
      target: `${nameOf(row.targetAccountId)} · ${row.targetName}`,
      choice: choiceOf(parseRuleOptions(row.options), row.enabled === 1),
    }));
  const json = settingsRow?.json ?? "{}";
  const ruleOptions = ruleRows.map((row) => parseRuleOptions(row.options));
  const daysAhead = shownDaysAhead(json, ruleOptions);
  const skipAllDay = shownSkipAllDay(json, ruleOptions);
  const rules = ruleRows.map((row) => ({
    from: row.sourceAccountId,
    to: row.targetAccountId,
    rule: {
      id: row.id,
      enabled: row.enabled === 1,
      origin: row.origin,
      options: parseRuleOptions(row.options),
      optionsJson: row.options,
    },
  }));
  const settings = {
    ...parseSettings(json),
    daysAhead,
    skipAllDay,
    blockTitleStored: hasStoredBlockTitle(json),
  };
  return { state: { accounts, directions, others, rules, settings }, colorWrites };
}

/** True if the stored settings hold a block title, whatever its value. */
function hasStoredBlockTitle(json: string): boolean {
  try {
    return (JSON.parse(json) as { blockTitle?: unknown }).blockTitle !== undefined;
  } catch {
    return false;
  }
}

/**
 * The state with the block title a page shows. A user who stored no title and has no rules sees the
 * default of their language, `title`, because their first rule will get it (see
 * `setDefaultBlockTitle`). A stored title always shows as stored, also "Busy". A user with rules
 * and no stored title keeps the schema default, which their rules carry.
 */
export function withLocalizedTitle(state: EditorState, title: string): EditorState {
  const { settings } = state;
  if (
    settings.blockTitleStored !== false ||
    state.rules.length > 0 ||
    settings.blockTitle === title
  ) {
    return state;
  }
  return { ...state, settings: { ...settings, blockTitle: title } };
}

/**
 * True if the rule is a parked "off" exception. The mark lives in the options JSON outside the
 * schema, so parsing drops it: a copy or a replacement of the rule is not parked.
 */
function isMarkedParked(optionsJson: string): boolean {
  return (JSON.parse(optionsJson) as { parked?: unknown }).parked === true;
}

function parseSettings(json: string): SyncSettings {
  const { daysAhead, skipAllDay, skipTentative, markPrivate, blockTitle, skipCategories } =
    parseRuleOptions(json);
  return { daysAhead, skipAllDay, skipTentative, markPrivate, blockTitle, skipCategories };
}

/**
 * The window the settings show: the stored one, or else the largest `daysAhead` of the user's
 * rules. Rules can be older than the stored settings; a default would shrink them on any save.
 */
function shownDaysAhead(json: string, rules: RuleOptions[]): number {
  const stored = (JSON.parse(json) as { daysAhead?: unknown }).daysAhead;
  if (stored !== undefined || rules.length === 0) return parseSettings(json).daysAhead;
  return Math.max(...rules.map((options) => options.daysAhead));
}

/**
 * The all-day switch the settings show: the stored one, or else on if any rule of the user skips
 * all-day events. Stored settings often lack it, and rules can be older than the default. New rules
 * take the switch, so the default alone would turn the skip off for them.
 */
function shownSkipAllDay(json: string, rules: RuleOptions[]): boolean {
  const stored = (JSON.parse(json) as { skipAllDay?: unknown }).skipAllDay;
  if (stored !== undefined || rules.length === 0) return parseSettings(json).skipAllDay;
  return rules.some((options) => options.skipAllDay);
}

/** Settings from the form. The window can be missing, for example if no choice matched. */
export type SettingsForm = Omit<SyncSettings, "daysAhead"> & {
  daysAhead?: number;
  /** The window that the form showed. */
  daysAheadShown?: number;
  /** The all-day switch that the form showed. */
  skipAllDayShown?: boolean;
  /**
   * The private switch that the form showed. Unless the switch turned on, each rule keeps its own
   * value, which the editor sets per direction. See `markPrivateScope`.
   */
  markPrivateShown?: boolean;
  /**
   * Who sees new mirrorings: "private" (only you) or "open" (everyone with access). It sets the
   * default for new mirrorings. If present, `markPrivate` and `markPrivateShown` do not count.
   */
  newWho?: "private" | "open";
  /** With `newWho`: also give every existing rule that value. Without `newWho` it does nothing. */
  applyWho?: boolean;
};

/**
 * What a settings save does with the private mark:
 * - "keep": the default and every rule keep their mark.
 * - "default": only the default for new mirrorings changes.
 * - "all": the default and every rule change, except rules whose level set a mark in the same save.
 *
 * `newWho` decides if present. Without it, the old switch counts, and it is asymmetric, because the
 * old forms send no sign that the user meant to apply it to all rules. "On" goes to all rules,
 * because it can only narrow. With `markPrivateShown`, an unchanged "on" and any "off" set only the
 * default. Without that marker, the form is a page from before the marker or a form without the
 * switch: a missing "on" changes nothing, so an absent checkbox never makes a copy more visible.
 */
export function markPrivateScope(
  form: Pick<SettingsForm, "markPrivate" | "markPrivateShown" | "newWho" | "applyWho">,
): { scope: "keep" | "default" | "all"; markPrivate: boolean } {
  if (form.newWho === "private" || form.newWho === "open") {
    const markPrivate = form.newWho === "private";
    return { scope: form.applyWho === true ? "all" : "default", markPrivate };
  }
  const { markPrivate, markPrivateShown } = form;
  if (markPrivateShown !== undefined) {
    // Only a switch turned on reaches every rule. "Off" never opens an existing rule.
    return { scope: markPrivate && !markPrivateShown ? "all" : "default", markPrivate };
  }
  return { scope: markPrivate ? "all" : "keep", markPrivate };
}

/**
 * How many mirrorings it would widen or narrow to give every rule the mark of `who`, as a
 * settings save with `applyWho` does. A mirroring is a direction, or a rule under "Other rules".
 * Only enabled rules count, because a disabled rule writes no copies. A mirroring widens if any of
 * its rules is private and the value is "open"; it narrows if any is open and the value is
 * "private". So a mirroring with mixed marks counts in both directions.
 */
export function visibilityEffect(
  state: Pick<EditorState, "directions" | "others" | "rules">,
  who: "private" | "open",
): { widened: number; narrowed: number } {
  const markPrivate = who === "private";
  const mirrorings = [
    ...state.directions.map((direction) =>
      direction.slots.flatMap((slot) =>
        slot.rule?.enabled ? [slot.rule.options.markPrivate] : [],
      ),
    ),
    ...state.others.map((other) =>
      state.rules
        .filter(({ rule }) => rule.id === other.ruleId && rule.enabled)
        .map(({ rule }) => rule.options.markPrivate),
    ),
  ];
  // Mirrorings with a rule whose mark the value would change.
  const changed = mirrorings.filter((marks) => marks.some((mark) => mark !== markPrivate)).length;
  return markPrivate ? { widened: 0, narrowed: changed } : { widened: changed, narrowed: 0 };
}

/** Options of a new rule: the user's settings with the given detail level. */
function newRuleOptions(settings: SyncSettings, detailLevel: Choice): RuleOptions {
  return ruleOptionsSchema.parse({
    ...settings,
    detailLevel: detailLevel === "off" ? "busy" : detailLevel,
  });
}

/**
 * Store the settings and apply them to every rule of the user. The detail level of each rule
 * stays; it is the choice per direction. The window applies only if the user changed it from the
 * one the form showed, and only in that direction: a higher window raises the rules below it, a
 * lower one lowers the rules above it. The other rules keep their own. A smaller window queues the
 * removal of the blocks beyond it, which no run reads any more. The all-day switch applies only if
 * the user changed it from the one the form showed; then every rule follows. Otherwise each rule
 * keeps its own value, because a rule that turns to skipping loses its all-day blocks. The private
 * mark goes to the default or to every rule as `markPrivateScope` says, because the editor sets the
 * mark per direction. Only "on" or an explicit `applyWho` reaches every rule, so a settings save
 * never makes a copy more visible unless the user asked for that. Throws `EditorConflict` if a rule
 * changed since the read; then nothing is stored.
 */
export async function setSettings(
  env: Env,
  user: CurrentUser,
  form: SettingsForm,
  syncs?: Set<string>,
  /**
   * Rules "sourceCalendarId>targetCalendarId" whose mark a level of the same save set, as
   * `setDirections` returns them. A switched mark skips them.
   */
  keepMarks: ReadonlySet<string> = new Set(),
  /**
   * A state the caller read and checked in this request, for example against the version of the
   * form. If the rules or the settings that this function reads differ from it, nothing is
   * written and `EditorConflict` is thrown. The batch then also writes the settings row only if it
   * is still as this function read it, so a save between that read and the batch fails it too.
   * Changes of the org caps or of account names in that window are not checked.
   */
  checked?: EditorState,
): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.options, r.enabled, tc.can_edit AS canEdit, tc.account_id AS targetAccountId,
            tc.remote_id AS remoteCalendarId, r.source_calendar_id AS sourceCalendarId,
            r.target_calendar_id AS targetCalendarId, sc.account_id AS sourceAccountId,
            sa.email AS sourceEmail, sa.tenant_id AS sourceTenantId,
            ta.email AS targetEmail, ta.tenant_id AS targetTenantId
     FROM rules r JOIN calendars tc ON tc.id = r.target_calendar_id
     JOIN calendars sc ON sc.id = r.source_calendar_id
     JOIN accounts sa ON sa.id = sc.account_id JOIN accounts ta ON ta.id = tc.account_id
     WHERE r.user_id = ?`,
  )
    .bind(user.id)
    .all<{
      id: string;
      options: string;
      enabled: number;
      canEdit: number;
      targetAccountId: string;
      remoteCalendarId: string;
      sourceCalendarId: string;
      targetCalendarId: string;
      sourceAccountId: string;
      sourceEmail: string;
      sourceTenantId: string | null;
      targetEmail: string;
      targetTenantId: string | null;
    }>();
  const stored = await env.DB.prepare("SELECT sync_settings AS json FROM users WHERE id = ?")
    .bind(user.id)
    .first<{ json: string }>();
  const json = stored?.json ?? "{}";
  const ruleOptions = results.map((row) => parseRuleOptions(row.options));
  const current = shownDaysAhead(json, ruleOptions);
  const currentSkipAllDay = shownSkipAllDay(json, ruleOptions);
  if (checked) {
    // The same rules with the same options, and the same settings as `parseEditorState` shows.
    const read = new Map(results.map((row) => [row.id, `${row.enabled}:${row.options}`]));
    const seen = new Map(
      checked.rules.map(({ rule }) => [rule.id, `${rule.enabled ? 1 : 0}:${rule.optionsJson}`]),
    );
    const sameRules = read.size === seen.size && [...read].every(([id, v]) => seen.get(id) === v);
    const shownNow = {
      ...parseSettings(json),
      daysAhead: current,
      skipAllDay: currentSkipAllDay,
      blockTitleStored: hasStoredBlockTitle(json),
    };
    if (!sameRules || JSON.stringify(shownNow) !== JSON.stringify(checked.settings)) {
      throw new EditorConflict();
    }
  }
  const {
    daysAhead: chosen,
    daysAheadShown,
    skipAllDayShown,
    markPrivateShown: _markPrivateShown,
    newWho: _newWho,
    applyWho: _applyWho,
    skipAllDay,
    ...rest
  } = form;
  const mark = markPrivateScope(form);
  // A page from before `daysAheadShown` existed showed the stored window, or the default.
  const shown = daysAheadShown ?? parseSettings(json).daysAhead;
  const windowChanged = chosen !== undefined && chosen !== shown;
  // A page from before `skipAllDayShown` existed can show another default, so compare with now.
  const skipAllDayChanged = skipAllDay !== (skipAllDayShown ?? currentSkipAllDay);
  const settings: SyncSettings = {
    ...rest,
    daysAhead: windowChanged ? chosen : current,
    skipAllDay: skipAllDayChanged ? skipAllDay : currentSkipAllDay,
    markPrivate: mark.scope === "keep" ? parseSettings(json).markPrivate : mark.markPrivate,
  };
  const windowOf = (previous: number) =>
    !windowChanged
      ? previous
      : settings.daysAhead > shown
        ? Math.max(previous, settings.daysAhead)
        : Math.min(previous, settings.daysAhead);
  // One batch, so that the save stores all changes or none, and stays within the D1 queries of one
  // invocation however many rules the user has.
  const updates: D1PreparedStatement[] = checked
    ? [
        // Only over the settings that were checked: another save after this read fails the batch.
        env.DB.prepare(
          "UPDATE users SET sync_settings = ? WHERE id = ? AND sync_settings IS ?",
        ).bind(JSON.stringify(settings), user.id, stored?.json ?? null),
        requireChange(env),
      ]
    : [
        env.DB.prepare("UPDATE users SET sync_settings = ? WHERE id = ?").bind(
          JSON.stringify(settings),
          user.id,
        ),
      ];
  const trims = new Map<string, { ruleId: string; remoteCalendarId: string }[]>();
  /** A row per rule whose mark this save changed, so each mirroring keeps a trace of it. */
  const markChanges: AuditEvent[] = [];
  for (const row of results) {
    const previous = parseRuleOptions(row.options);
    const keepMark = keepMarks.has(`${row.sourceCalendarId}>${row.targetCalendarId}`);
    const options = ruleOptionsSchema.parse({
      ...previous,
      ...settings,
      daysAhead: windowOf(previous.daysAhead),
      skipAllDay: skipAllDayChanged ? settings.skipAllDay : previous.skipAllDay,
      markPrivate: mark.scope === "all" && !keepMark ? mark.markPrivate : previous.markPrivate,
    });
    // A parked exception stays parked. A rule that changed since the read fails the batch.
    const stored = isMarkedParked(row.options) ? { ...options, parked: true } : options;
    updates.push(
      env.DB.prepare(
        "UPDATE rules SET options = ? WHERE id = ? AND options = ? AND enabled = ?",
      ).bind(JSON.stringify(stored), row.id, row.options, row.enabled),
      requireChange(env),
    );
    // "For all mirrorings" can change what others see of a mirroring's copies: the row names the
    // level before and after, like a save of the mirroring. A disabled rule copies nothing.
    if (row.enabled === 1 && options.markPrivate !== previous.markPrivate) {
      markChanges.push({
        orgId: user.orgId,
        userId: user.id,
        accountId: row.targetAccountId,
        ruleId: row.id,
        kind: "rule_updated",
        detail: {
          // With the org caps, as the sync applies them: never a wider level than the copies get.
          ...cappedLevelAuditDetail(env, options, true, ...identities(row)),
          ...previousDetail(cappedLevelOfRule(env, previous, true, ...identities(row))),
          ...fromAccountDetail(row.sourceAccountId),
        },
      });
    }
    // A disabled rule has its blocks removed already; a read-only calendar refuses the deletes.
    if (options.daysAhead < previous.daysAhead && row.enabled === 1 && row.canEdit === 1) {
      const queue = trims.get(row.targetAccountId) ?? [];
      queue.push({ ruleId: row.id, remoteCalendarId: row.remoteCalendarId });
      trims.set(row.targetAccountId, queue);
    }
  }
  await guardedBatch(env, updates);
  // One call per target account. Like every queueing, a failure is logged and does not fail the save.
  for (const [accountId, rules] of trims) {
    try {
      await accountSync(env, accountId).queueRemovals(rules, { trim: true }, carrier());
    } catch (error) {
      log.error("removal.trim_queue_failed", { accountId }, error);
    }
  }
  const settingsChanged: AuditEvent = {
    orgId: user.orgId,
    userId: user.id,
    kind: "settings_changed",
    // The block title and category names are the user's own words; the log keeps counts only.
    detail: {
      daysAhead: settings.daysAhead,
      skipAllDay: settings.skipAllDay,
      skipTentative: settings.skipTentative,
      markPrivate: settings.markPrivate,
      skipCategories: settings.skipCategories.length,
    },
  };
  if (markChanges.length === 0) await recordAudit(env.DB, settingsChanged);
  else {
    // One batch for the rows; the change is done, so a broken log must not fail the request.
    try {
      await env.DB.batch(
        [...markChanges, settingsChanged].map((event) => auditStatement(env.DB, event)),
      );
    } catch (error) {
      log.error("audit.write_failed", { auditKind: "settings_changed" }, error);
    }
  }
  await requestSyncs(env, new Set(results.map((row) => row.targetAccountId)), syncs);
}

/** Longest name an account can get. */
export const MAX_NAME_LENGTH = 40;

/**
 * Give an account a name, or go back to the derived one with an empty name. The derived name
 * itself counts as empty, so that the account keeps following its address. The log records a
 * rename only if the name on the pages changes.
 */
export async function renameAccount(
  env: Env,
  user: CurrentUser,
  accountId: string,
  name: string,
  /**
   * The account as the caller read and checked it in this request. The name is then written only
   * if it is still the one of that read; otherwise `EditorConflict` is thrown.
   */
  checked?: EditorAccount,
): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT id, email, display_name AS displayName FROM accounts WHERE user_id = ?
     ORDER BY created_at, id`,
  )
    .bind(user.id)
    .all<{ id: string; email: string; displayName: string | null }>();
  const index = results.findIndex((row) => row.id === accountId);
  const row = results[index];
  if (!row) return;
  const derived = shortNames(results.map((r) => r.email))[index] ?? row.email;
  const trimmed = name.trim().slice(0, MAX_NAME_LENGTH);
  const stored = trimmed === "" || trimmed === derived ? null : trimmed;
  if (stored === row.displayName) return;
  if (checked) {
    // `customName` is null for no name and for a stored name equal to the derived one.
    const updated = await env.DB.prepare(
      `UPDATE accounts SET display_name = ?1 WHERE id = ?2 AND user_id = ?3
         AND (display_name IS ?4 OR (?4 IS NULL AND display_name = ?5))`,
    )
      .bind(stored, accountId, user.id, checked.customName, checked.derivedName)
      .run();
    if (updated.meta.changes === 0) throw new EditorConflict();
  } else {
    await env.DB.prepare("UPDATE accounts SET display_name = ? WHERE id = ? AND user_id = ?")
      .bind(stored, accountId, user.id)
      .run();
  }
  if ((stored ?? derived) === (row.displayName ?? derived)) return;
  // The name is the user's own label; the log records that it changed, not the name.
  await recordAudit(env.DB, {
    orgId: user.orgId,
    userId: user.id,
    accountId,
    kind: "account_renamed",
  });
}

/**
 * Give an account a colour, or make it automatic again with null. The colour only marks the
 * account in the pages, so the audit log does not record it.
 */
export async function setAccountColor(
  env: Env,
  user: CurrentUser,
  accountId: string,
  color: AccountColor | null,
  /**
   * The account as the caller read and checked it in this request. The colour is then written
   * only if it is still the one of that read; otherwise `EditorConflict` is thrown.
   */
  checked?: EditorAccount,
): Promise<boolean> {
  if (checked) {
    // As `resolveAccountColorState` stores them: a chosen colour by its key, an automatic one
    // with the prefix "auto:" (the editor read stores the assigned ones).
    const before = checked.colorChosen ? checked.color : `auto:${checked.color}`;
    const updated = await env.DB.prepare(
      "UPDATE accounts SET color = ? WHERE id = ? AND user_id = ? AND color IS ?",
    )
      .bind(color, accountId, user.id, before)
      .run();
    if (updated.meta.changes === 0) throw new EditorConflict();
    return true;
  }
  const updated = await env.DB.prepare("UPDATE accounts SET color = ? WHERE id = ? AND user_id = ?")
    .bind(color, accountId, user.id)
    .run();
  return updated.meta.changes > 0;
}

/** Working hours as the rule options store them. A field that is missing keeps its value. */
export type WorkingHours = Partial<
  Pick<RuleOptions, "workDays" | "workStart" | "workEnd" | "workTimeZone">
>;

/** Working hours of an account, complete and valid, with a known zone. */
export type AccountWorkHours = Required<WorkingHours>;

/** Working hours that filter nothing: the defaults of every rule. */
export const NO_WORKING_HOURS: AccountWorkHours = {
  workDays: [...ALL_WEEKDAYS],
  workStart: "",
  workEnd: "",
  workTimeZone: "",
};

/** The stored working hours of an account, or null if it has none or the JSON is broken. */
function parseAccountHours(json: string | null): AccountWorkHours | null {
  if (!json) return null;
  let parsed;
  try {
    parsed = ruleOptionsSchema.safeParse(JSON.parse(json));
  } catch {
    return null;
  }
  if (!parsed.success || !hasWorkingHours(parsed.data)) return null;
  const { workDays, workStart, workEnd, workTimeZone } = parsed.data;
  return { workDays, workStart, workEnd, workTimeZone };
}

/** The hours of a rule as one comparable value. */
function hoursKey(hours: WorkingHours): string {
  return JSON.stringify([hours.workDays, hours.workStart, hours.workEnd, hours.workTimeZone]);
}

/**
 * Working hours as an account stores them, or a problem with them. Hours that filter nothing
 * become null. Without a zone the hours get the deployment's zone, so that they stay put if
 * TIME_ZONE changes later. A zone must be one Intl knows; it is stored by its canonical name.
 */
export function accountWorkHours(
  env: Env,
  hours: AccountWorkHours | null,
): { hours: AccountWorkHours | null } | { problem: WorkingHoursProblem } {
  if (!hours) return { hours: null };
  const input = {
    workDays: [...hours.workDays].sort((a, b) => a - b),
    workStart: hours.workStart.trim(),
    workEnd: hours.workEnd.trim(),
    workTimeZone: hours.workTimeZone.trim(),
  };
  const problem = workingHoursProblem(input);
  if (problem) return { problem };
  if (!hasWorkingHours(input)) return { hours: null };
  const zone = input.workTimeZone || displayTimeZone(env.TIME_ZONE);
  return { hours: { ...input, workTimeZone: canonicalTimeZone(zone) } };
}

/**
 * Set or clear the working hours of an account. Every rule into the account that uses working
 * hours gets the new ones, with null it loses them: the rules of the directions, parked rules and
 * rules into other calendars of the account. The account and its rules change in one batch.
 * Returns false if the account is not the user's. Throws `EditorConflict` if a rule changed since
 * the read.
 *
 * `switchOn` names source accounts whose mirrorings into this account start to use the new hours
 * too ("only in working hours" on), in the same batch. So a failure between the hours and the
 * switch cannot leave the hours stored and the mirrorings off, and a retry completes. With hours
 * that did not change, only the switch is written. `state` is a state the caller read in this
 * request; the guards on the rules still catch a change made meanwhile. `syncs` collects the
 * accounts to sync instead of asking at once.
 */
export async function setAccountWorkHours(
  env: Env,
  user: CurrentUser,
  accountId: string,
  hours: AccountWorkHours | null,
  options: {
    switchOn?: readonly string[];
    syncs?: Set<string>;
    /**
     * A state the caller read and checked in this request. The rules are written only if they
     * are as in that state, and the account's hours only if they are as stored then; otherwise
     * `EditorConflict` is thrown and nothing of this batch is stored.
     */
    state?: EditorState;
  } = {},
): Promise<boolean> {
  const state = options.state ?? (await loadEditorState(env, user.id));
  const account = state.accounts.find((a) => a.id === accountId);
  if (!account) return false;
  const changed =
    hoursKey(account.workHours ?? NO_WORKING_HOURS) !== hoursKey(hours ?? NO_WORKING_HOURS);
  const switchOn = new Set(hours ? (options.switchOn ?? []) : []);
  if (!changed && switchOn.size === 0) return true;
  const patches: RulePatch[] = [];
  if (changed) {
    for (const { from, to, rule } of state.rules) {
      if (to === accountId && hasWorkingHours(rule.options)) {
        patches.push({ from, to, rule, patch: hours ?? NO_WORKING_HOURS });
      }
    }
  }
  if (hours) {
    for (const direction of state.directions) {
      if (direction.to !== accountId || !switchOn.has(direction.from)) continue;
      for (const { rule } of direction.slots) {
        if (rule) patches.push({ from: direction.from, to: accountId, rule, patch: hours });
      }
    }
  }
  await writePatches(
    env,
    user,
    patches,
    !changed
      ? []
      : options.state && account.workHoursJson !== undefined
        ? [
            env.DB.prepare(
              "UPDATE accounts SET work_hours = ? WHERE id = ? AND user_id = ? AND work_hours IS ?",
            ).bind(hours ? JSON.stringify(hours) : null, accountId, user.id, account.workHoursJson),
            requireChange(env),
          ]
        : [
            env.DB.prepare("UPDATE accounts SET work_hours = ? WHERE id = ? AND user_id = ?").bind(
              hours ? JSON.stringify(hours) : null,
              accountId,
              user.id,
            ),
          ],
    options.syncs,
  );
  return true;
}

/**
 * The origin of a rule for a choice: "group" for an enabled busy rule between two group members,
 * otherwise "custom". Details such as working hours, the colour or the buffer do not count: they
 * never change the origin, so that turning them on and off cannot make an exception a group rule.
 */
function groupOrigin(
  bothInGroup: boolean,
  enabled: boolean,
  options: RuleOptions,
): "group" | "custom" {
  return bothInGroup && choiceOf(options, enabled) === "busy" ? "group" : "custom";
}

/**
 * Store the block title of the user's language as the default, for a user who has neither chosen
 * a title nor has rules. Existing rules keep their title, so that no block is renamed.
 */
export async function setDefaultBlockTitle(env: Env, userId: string, title: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE users SET sync_settings = json_set(sync_settings, '$.blockTitle', ?)
     WHERE id = ? AND json_type(sync_settings, '$.blockTitle') IS NULL
       AND NOT EXISTS (SELECT 1 FROM rules WHERE user_id = ?)`,
  )
    .bind(title, userId, userId)
    .run();
}

/** Longest Outlook category name for blocks. */
export const MAX_CATEGORY_LENGTH = 100;

/** A Google event colour as a source event carries it in `categories`. */
const GOOGLE_COLOR_CATEGORY = /^color:(?:[1-9]|1[01])$/;

/** Why a block colour is not valid for a target provider, or null if it is valid. */
export function blockColorProblem(
  provider: Provider,
  value: string,
): "comma" | "tooLong" | "invalid" | null {
  if (blockColorFor(provider, value) !== null) return null;
  if (provider === "microsoft" && value.includes(",")) return "comma";
  if (provider === "microsoft" && value.trim().length > MAX_CATEGORY_LENGTH) return "tooLong";
  return "invalid";
}

/**
 * The block colour as stored for a target provider, or null if the value is not valid there:
 * a Google event colour "1" to "11", or an Outlook category name. Empty means no colour. Graph
 * takes categories as a list, but classic Outlook keeps them as one comma-separated string and
 * splits a name at its comma, so a name with a comma is refused.
 */
export function blockColorFor(provider: Provider, value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  if (provider === "google") return /^(?:[1-9]|1[01])$/.test(trimmed) ? trimmed : null;
  return trimmed.length <= MAX_CATEGORY_LENGTH && !trimmed.includes(",") ? trimmed : null;
}

/** Most categories that one direction carries into its copies. The schema allows the same. */
export const MAX_PASS_CATEGORIES = 50;

/**
 * One category that a block carries: the source value and the target value. `tentative` shows the
 * block of a busy event as tentative; it fits a direction from Google to Outlook only.
 */
export interface PassPair {
  from: string;
  to: string;
  tentative?: boolean;
}

/** A carried category as a rule stores it. */
export type StoredPassPair = Required<PassPair>;

/**
 * Why a list of carried categories is not valid for a direction. `tentative`: a row asks for a
 * tentative copy in a direction other than Google to Outlook. `calendar`: a row names a calendar
 * that is not a source calendar of the direction.
 */
export type PassProblem = "from" | "to" | "incomplete" | "tooMany" | "tentative" | "calendar";

/** True if copies of a direction can show as tentative through a carried category. */
export function canPassTentative(source: Provider, target: Provider): boolean {
  return source === "google" && target === "microsoft";
}

/**
 * True if a direction takes rows for a whole source calendar (`calendar:<ID>`). Only from Google
 * to Outlook: there each row picks its source from a list, which can hold the calendars too.
 * Outlook names are typed, so a name can start with the prefix, and between two Google calendars
 * the panel shows colour boxes only.
 */
export function canPassCalendar(source: Provider, target: Provider): boolean {
  return source === "google" && target === "microsoft";
}

/** The slotmirror IDs of the source calendars of a direction, for `passCategoriesFor`. */
export function passSourceCalendars(direction: Pick<EditorDirection, "slots">): string[] {
  return direction.slots.map((slot) => slot.sourceCalendarId);
}

/** The calendar ID of a carried row's source `calendar:<ID>`, or null for a category or colour. */
export function passCalendarOf(from: string): string | null {
  const trimmed = from.trim();
  return trimmed.startsWith(PASS_CALENDAR_PREFIX)
    ? trimmed.slice(PASS_CALENDAR_PREFIX.length)
    : null;
}

/**
 * Check and normalise the carried categories of a direction. `from` must fit the source: a Google
 * colour as `color:<id>`, or an Outlook name. `to` must fit the target as a block colour does. An
 * empty `to` means the same value as `from`, which only fits two calendars of one provider. Values
 * are trimmed, and a row without `from` is an empty row and is dropped. A repeated row (without
 * case) is dropped: across providers a row whose `from` and `to` both repeat an earlier row,
 * between calendars of one provider a row whose `from` repeats. The first row wins, also if a
 * repeated row has another `tentative`. A row with `tentative` outside Google to Outlook is
 * refused, not dropped: the person asked for something that the target would not show.
 *
 * From Google to Outlook, `from` can also name a whole source calendar as `calendar:<ID>`, for
 * events without a colour, such as those that Todoist writes. The ID must be one of
 * `sourceCalendars`, the slotmirror IDs of the direction's source calendars; any other is refused,
 * so that a row never names a calendar of another account or user. Without the list no calendar
 * row passes.
 */
export function passCategoriesFor(
  source: Provider,
  target: Provider,
  pairs: readonly PassPair[],
  sourceCalendars: readonly string[] = [],
): { pairs: StoredPassPair[] } | { problem: PassProblem } {
  const seen = new Set<string>();
  const result: StoredPassPair[] = [];
  for (const pair of pairs) {
    const from = pair.from.trim();
    if (from === "") {
      // The name decides whether a row exists. From Google to Outlook the name is the target, so
      // a name without a colour is a row that lacks its source, not an empty row.
      if (source === "google" && target !== "google" && pair.to.trim() !== "") {
        return { problem: "incomplete" };
      }
      continue;
    }
    const calendar = source === "google" ? passCalendarOf(from) : null;
    if (calendar !== null) {
      if (!canPassCalendar(source, target)) return { problem: "from" };
      if (!sourceCalendars.includes(calendar)) return { problem: "calendar" };
    }
    const fits =
      calendar !== null ||
      (source === "google"
        ? GOOGLE_COLOR_CATEGORY.test(from)
        : blockColorFor("microsoft", from) !== null);
    if (!fits) return { problem: "from" };
    const to = blockColorFor(target, pair.to);
    if (to === null) return { problem: "to" };
    if (to === "" && source !== target) return { problem: "incomplete" };
    const tentative = pair.tentative === true;
    if (tentative && !canPassTentative(source, target)) return { problem: "tentative" };
    // Across providers a row pairs two different values, so one colour can map to several names
    // and only a repeated pair is a repeated row. Between calendars of one provider the panel
    // shows one list of names, which cannot hold two rows of one name: the first row wins.
    const rowKey = JSON.stringify(
      source === target ? [from.toLowerCase()] : [from.toLowerCase(), to.toLowerCase()],
    );
    if (seen.has(rowKey)) continue;
    seen.add(rowKey);
    result.push({ from, to, tentative });
  }
  if (result.length > MAX_PASS_CATEGORIES) return { problem: "tooMany" };
  return { pairs: result };
}

/**
 * Options that belong to a source account, not to a direction: every rule from the account shares
 * them. The account stores them, so that they stay while the account has no rules, and new rules
 * from it take them. Another such option needs its key here and a field in the editor.
 */
export const SOURCE_OPTION_KEYS = ["bufferBefore", "bufferAfter"] as const;

export type SourceOptionKey = (typeof SOURCE_OPTION_KEYS)[number];

export type SourceOptions = Pick<RuleOptions, SourceOptionKey>;

/** Buffers in minutes. A buffer that is missing keeps its value. */
export type BlockBuffer = Partial<Pick<RuleOptions, "bufferBefore" | "bufferAfter">>;

function pickSourceOptions(options: RuleOptions): SourceOptions {
  return Object.fromEntries(SOURCE_OPTION_KEYS.map((key) => [key, options[key]])) as SourceOptions;
}

/** The stored source options of an account, or null if it has none or the JSON is broken. */
function parseSourceOptions(json: string | null): SourceOptions | null {
  if (!json) return null;
  let parsed;
  try {
    parsed = ruleOptionsSchema.safeParse(JSON.parse(json));
  } catch {
    return null;
  }
  return parsed.success ? pickSourceOptions(parsed.data) : null;
}

/**
 * The source options of an account as the editor shows them: the stored ones, or else those of
 * its first rule, or else the defaults. `mixed` names the options in which a rule from the account
 * differs, such as rules from before the account stored its options. Null for an unknown account.
 */
export function sourceOptionsOf(
  state: EditorState,
  accountId: string,
): { options: SourceOptions; mixed: SourceOptionKey[] } | null {
  const account = state.accounts.find((a) => a.id === accountId);
  if (!account) return null;
  const rules = state.rules.filter(({ from }) => from === accountId);
  const first = rules[0]?.rule.options;
  const options = account.sourceOptions ?? pickSourceOptions(first ?? ruleOptionsSchema.parse({}));
  const mixed = SOURCE_OPTION_KEYS.filter((key) =>
    rules.some(({ rule }) => rule.options[key] !== options[key]),
  );
  return { options, mixed };
}

/**
 * The source options for a new rule from an account: the stored ones, or else those that all its
 * rules share. Options in which its rules differ keep the value of the new rule's model.
 */
function newRuleSource(state: EditorState, accountId: string): Partial<SourceOptions> {
  const account = state.accounts.find((a) => a.id === accountId);
  if (account?.sourceOptions) return account.sourceOptions;
  const current = sourceOptionsOf(state, accountId);
  if (!current) return {};
  return Object.fromEntries(
    SOURCE_OPTION_KEYS.filter((key) => !current.mixed.includes(key)).map((key) => [
      key,
      current.options[key],
    ]),
  );
}

/**
 * The buffer of a source account, which all rules from it share: "mixed" if its rules differ,
 * null for an unknown account. The editor shows and writes one buffer per source.
 */
export function sourceBuffer(
  state: EditorState,
  accountId: string,
): Required<BlockBuffer> | "mixed" | null {
  const current = sourceOptionsOf(state, accountId);
  if (!current) return null;
  if (current.mixed.includes("bufferBefore") || current.mixed.includes("bufferAfter")) {
    return "mixed";
  }
  const { bufferBefore, bufferAfter } = current.options;
  return { bufferBefore, bufferAfter };
}

/**
 * Changes of the editor that only touch rule options, so that one batch can store all of them:
 * - `colors`: the block colour of one direction.
 * - `workHours`: per direction, true copies the target account's working hours into the rules,
 *   false clears them.
 * - `onlyCategories`: per direction, the opt-in list of its rules. An empty list is no filter.
 * - `passCategories`: per direction, the categories that its blocks carry from the source event.
 *   An empty list carries none.
 * - `sources`: per source account, options for the account and every rule from it.
 */
export interface RuleDetails {
  colors?: { from: string; to: string; value: string }[];
  workHours?: { from: string; to: string; on: boolean }[];
  onlyCategories?: { from: string; to: string; names: string[] }[];
  passCategories?: { from: string; to: string; pairs: PassPair[] }[];
  sources?: { from: string; options: Partial<SourceOptions> }[];
}

/** Why rule details cannot be stored, or null if they can. */
export type RuleDetailsProblem =
  | { kind: "color"; problem: "comma" | "tooLong" | "invalid" }
  | { kind: "source" }
  | { kind: "noWorkHours"; account: string }
  /** A Google source has colours only, so a name would stop every event of the direction. */
  | { kind: "onlyCategories" }
  | { kind: "passCategories"; reason: PassProblem }
  /** The direction is not the user's, or no longer exists. */
  | {
      kind: "direction";
      field: "color" | "workHours" | "onlyCategories" | "passCategories";
    };

/**
 * Check rule details against a state before anything is written, so that an invalid detail
 * refuses the whole save. Working hours can be turned on only for an account that has them.
 */
export function ruleDetailsProblem(
  state: EditorState,
  details: RuleDetails,
): RuleDetailsProblem | null {
  for (const { from, to, value } of details.colors ?? []) {
    const target = state.accounts.find((account) => account.id === to);
    const known = state.directions.some((d) => d.from === from && d.to === to);
    if (!target || !known) return { kind: "direction", field: "color" };
    const problem = blockColorProblem(target.provider, value);
    if (problem) return { kind: "color", problem };
  }
  for (const { from, options } of details.sources ?? []) {
    const known = state.accounts.some((account) => account.id === from);
    if (!known || !ruleOptionsSchema.safeParse(options).success) return { kind: "source" };
  }
  for (const { from, to, on } of details.workHours ?? []) {
    const target = state.accounts.find((account) => account.id === to);
    const direction = state.directions.find((d) => d.from === from && d.to === to);
    if (!target || !direction) return { kind: "direction", field: "workHours" };
    // Rules that kept hours from before the account had any keep them; see `setRuleDetails`.
    const has = direction.options !== null && hasWorkingHours(direction.options);
    if (on && !target.workHours && !has) return { kind: "noWorkHours", account: target.name };
  }
  for (const { from, to, names } of details.onlyCategories ?? []) {
    const source = state.accounts.find((account) => account.id === from);
    const known = state.directions.some((d) => d.from === from && d.to === to);
    if (!source || !known) return { kind: "direction", field: "onlyCategories" };
    if (source.provider === "google" && !names.every((name) => GOOGLE_COLOR_CATEGORY.test(name))) {
      return { kind: "onlyCategories" };
    }
  }
  for (const { from, to, pairs } of details.passCategories ?? []) {
    const source = state.accounts.find((account) => account.id === from);
    const target = state.accounts.find((account) => account.id === to);
    const direction = state.directions.find((d) => d.from === from && d.to === to);
    if (!source || !target || !direction) return { kind: "direction", field: "passCategories" };
    const checked = passCategoriesFor(
      source.provider,
      target.provider,
      pairs,
      passSourceCalendars(direction),
    );
    if ("problem" in checked) return { kind: "passCategories", reason: checked.problem };
  }
  return null;
}

/**
 * Store rule details (see `RuleDetails`) in one batch, with one audit event per changed rule.
 * Call it after the choices and source calendars of the same save, so that it reaches their new
 * rules. A direction without rules, for example one that lost its last source in the same save,
 * has nothing to change and is skipped. So is the copy of working hours from an account that has
 * none any more; its rules keep theirs. Source options are stored on the account even if it has
 * no rules. Returns false for details that `ruleDetailsProblem` refuses against the current state.
 * Throws `EditorConflict` if a rule changed since the read; then nothing is stored.
 */
export async function setRuleDetails(
  env: Env,
  user: CurrentUser,
  details: RuleDetails,
  syncs?: Set<string>,
  /**
   * A state the caller read and checked in this request. The rules are then patched only if
   * their options and on/off state are as in that read; otherwise `EditorConflict` is thrown and
   * nothing of the batch is stored. The source options on the account row have no such guard.
   */
  checked?: EditorState,
): Promise<boolean> {
  const state = checked ?? (await loadEditorState(env, user.id));
  const problem = ruleDetailsProblem(state, details);
  if (problem && problem.kind !== "direction" && problem.kind !== "noWorkHours") return false;
  const patches: RulePatch[] = [];
  const accounts: D1PreparedStatement[] = [];
  const forDirection = (direction: EditorDirection, patch: Partial<RuleOptions>) => {
    for (const { rule } of direction.slots) {
      if (rule) patches.push({ from: direction.from, to: direction.to, rule, patch });
    }
  };
  for (const { from, to, value } of details.colors ?? []) {
    const target = state.accounts.find((account) => account.id === to);
    const direction = state.directions.find((d) => d.from === from && d.to === to);
    const blockColor = target ? blockColorFor(target.provider, value) : null;
    if (direction && blockColor !== null) forDirection(direction, { blockColor });
  }
  for (const { from, options } of details.sources ?? []) {
    const current = sourceOptionsOf(state, from);
    if (!current) continue;
    // Every rule from the account: those of its directions, parked ones and manual ones.
    for (const entry of state.rules) {
      if (entry.from === from) {
        patches.push({ from, to: entry.to, rule: entry.rule, patch: options });
      }
    }
    // json_patch merges into what the account has, so that a concurrent save of another source
    // option keeps its value. An account without stored options, or with broken ones, starts from
    // what the page showed.
    accounts.push(
      env.DB.prepare(
        `UPDATE accounts SET source_options = json_patch(
           CASE WHEN json_valid(source_options) THEN source_options ELSE ? END, ?)
         WHERE id = ? AND user_id = ?`,
      ).bind(JSON.stringify(current.options), JSON.stringify(options), from, user.id),
    );
  }
  for (const { from, to, on } of details.workHours ?? []) {
    const target = state.accounts.find((account) => account.id === to);
    const direction = state.directions.find((d) => d.from === from && d.to === to);
    if (!target || !direction) continue;
    if (!on) forDirection(direction, NO_WORKING_HOURS);
    else if (target.workHours) forDirection(direction, target.workHours);
  }
  for (const { from, to, names } of details.onlyCategories ?? []) {
    const direction = state.directions.find((d) => d.from === from && d.to === to);
    if (direction) forDirection(direction, { onlyCategories: names });
  }
  for (const { from, to, pairs } of details.passCategories ?? []) {
    const source = state.accounts.find((account) => account.id === from);
    const target = state.accounts.find((account) => account.id === to);
    const direction = state.directions.find((d) => d.from === from && d.to === to);
    if (!source || !target || !direction) continue;
    const calendars = passSourceCalendars(direction);
    const checked = passCategoriesFor(source.provider, target.provider, pairs, calendars);
    if ("pairs" in checked) forDirection(direction, { passCategories: checked.pairs });
  }
  await writePatches(env, user, patches, accounts, syncs);
  return true;
}

/** Set the block colour of one direction. See `setRuleDetails`. */
export async function setBlockColor(
  env: Env,
  user: CurrentUser,
  fromId: string,
  toId: string,
  value: string,
  syncs?: Set<string>,
): Promise<boolean> {
  return setRuleDetails(env, user, { colors: [{ from: fromId, to: toId, value }] }, syncs);
}

/**
 * A change of the options of one rule from account `from` into account `to`. Patches of a rule
 * apply in order.
 */
interface RulePatch {
  from: string;
  to: string;
  rule: SlotRule;
  patch: Partial<RuleOptions>;
}

/**
 * A save of the editor found rules that another request changed after this one read them, for
 * example in another tab. Nothing of the batch that found it was stored.
 */
export class EditorConflict extends Error {
  constructor() {
    super("Rules changed since they were read");
    this.name = "EditorConflict";
  }
}

/** Text in the error of `requireChange`, so that no other failure counts as a conflict. */
const UNCHANGED_ROW = "slotmirror-unchanged-row";

/**
 * A statement that fails its batch, and so rolls back every write of the batch, if the statement
 * before it changed no row. SQLite has no RAISE outside triggers; json_extract() with an invalid
 * path fails instead, and its error names the path. The path depends on changes(), so SQLite
 * cannot evaluate it ahead of time.
 */
export function requireChange(env: Env): D1PreparedStatement {
  return env.DB.prepare(
    `SELECT json_extract('{}', CASE WHEN changes() > 0 THEN '$' ELSE '${UNCHANGED_ROW}' END)`,
  );
}

/** True for the failure of `requireChange`. */
function isRequiredChangeMissing(error: unknown): boolean {
  return error instanceof Error && error.message.includes(UNCHANGED_ROW);
}

/** Run a batch with `requireChange` guards; a failed guard throws `EditorConflict`. */
export async function guardedBatch(
  env: Env,
  statements: D1PreparedStatement[],
): Promise<D1Result[]> {
  try {
    return await env.DB.batch(statements);
  } catch (error) {
    if (isRequiredChangeMissing(error)) throw new EditorConflict();
    throw error;
  }
}

/**
 * Write option patches and `before` in one D1 batch, with one audit event per changed rule, then
 * ask each target account with a changed enabled rule to sync, or add it to `syncs`. Each rule is
 * written only if its options are still the ones that were read; otherwise the whole batch fails
 * and this throws `EditorConflict`. The origin of a rule stays, and a parked rule stays parked.
 */
async function writePatches(
  env: Env,
  user: CurrentUser,
  patches: RulePatch[],
  before: D1PreparedStatement[] = [],
  syncs?: Set<string>,
): Promise<void> {
  const merged = new Map<string, RulePatch>();
  for (const entry of patches) {
    const known = merged.get(entry.rule.id);
    merged.set(
      entry.rule.id,
      known ? { ...known, patch: { ...known.patch, ...entry.patch } } : entry,
    );
  }
  const statements = [...before];
  const targets = new Set<string>();
  for (const { from, to, rule, patch } of merged.values()) {
    const parsed = ruleOptionsSchema.safeParse({ ...rule.options, ...patch });
    if (!parsed.success) continue;
    const options = parsed.data;
    const changes = detailChanges(rule.options, options);
    if (Object.keys(changes).length === 0) continue;
    // The source account names the mirroring once the rule is gone (see `fromAccountDetail`).
    const detail = { ...changes, ...fromAccountDetail(from) };
    const stored = isMarkedParked(rule.optionsJson) ? { ...options, parked: true } : options;
    statements.push(
      env.DB.prepare(
        "UPDATE rules SET options = ? WHERE id = ? AND user_id = ? AND options = ? AND enabled = ?",
      ).bind(JSON.stringify(stored), rule.id, user.id, rule.optionsJson, rule.enabled ? 1 : 0),
      requireChange(env),
      auditStatement(env.DB, {
        orgId: user.orgId,
        userId: user.id,
        accountId: to,
        ruleId: rule.id,
        kind: "rule_updated",
        detail,
      }),
    );
    // A disabled rule writes no blocks, so its target has nothing to sync.
    if (rule.enabled) targets.add(to);
  }
  if (statements.length === 0) return;
  await guardedBatch(env, statements);
  await requestSyncs(env, targets, syncs);
}

/**
 * The audit detail of a change of rule details: what changed, without the user's own words. The
 * category name of the colour and the category names of the filter and of the carried categories
 * stay out; the log records that the colour changed and how many entries each list has.
 */
function detailChanges(old: RuleOptions, options: RuleOptions): Record<string, string> {
  const detail: Record<string, string> = {};
  if (options.blockColor !== old.blockColor) detail.blockColor = "changed";
  if (options.onlyCategories.join("\u0000") !== old.onlyCategories.join("\u0000")) {
    detail.onlyCategories = String(options.onlyCategories.length);
  }
  // Carried categories are the user's own words too; the log keeps the count.
  if (JSON.stringify(options.passCategories) !== JSON.stringify(old.passCategories)) {
    detail.passCategories = String(options.passCategories.length);
  }
  if (options.bufferBefore !== old.bufferBefore || options.bufferAfter !== old.bufferAfter) {
    detail.bufferBefore = String(options.bufferBefore);
    detail.bufferAfter = String(options.bufferAfter);
  }
  if (hoursKey(options) !== hoursKey(old)) {
    detail.workDays = options.workDays.join(",");
    detail.workStart = options.workStart;
    detail.workEnd = options.workEnd;
    detail.workTimeZone = options.workTimeZone;
  }
  return detail;
}

/**
 * The details of one direction that a save sends with its level (see `setDirections`): the colour
 * of the copies, working hours on or off, the list of categories, the carried categories. A
 * missing field stays as it is.
 */
export interface DirectionDetails {
  blockColor?: string;
  workHours?: boolean;
  onlyCategories?: string[];
  passCategories?: PassPair[];
}

/**
 * The option patch of direction details for a target, as `setRuleDetails` writes them. A colour
 * that the target's provider refuses is left out; `ruleDetailsProblem` refuses it before a save.
 * Working hours turned on copy the target's; a target without hours leaves the rules' own. Carried
 * categories are stored as `passCategoriesFor` normalises them; a list it refuses is left out.
 */
function directionPatch(
  source: EditorAccount,
  target: EditorAccount,
  direction: EditorDirection,
  details: DirectionDetails,
): Partial<RuleOptions> {
  const patch: Partial<RuleOptions> = {};
  if (details.blockColor !== undefined) {
    const blockColor = blockColorFor(target.provider, details.blockColor);
    if (blockColor !== null) patch.blockColor = blockColor;
  }
  if (details.workHours === false) Object.assign(patch, NO_WORKING_HOURS);
  else if (details.workHours === true && target.workHours) Object.assign(patch, target.workHours);
  if (details.onlyCategories !== undefined) patch.onlyCategories = details.onlyCategories;
  if (details.passCategories !== undefined) {
    const checked = passCategoriesFor(
      source.provider,
      target.provider,
      details.passCategories,
      passSourceCalendars(direction),
    );
    if ("pairs" in checked) patch.passCategories = checked.pairs;
  }
  return patch;
}

/**
 * Delete a rule and the blocks it wrote. A failed cleanup is recorded, the rule goes anyway. The
 * audit row names the source account and the level the rule had, because the rule ID leads nowhere
 * once the rule is gone. It has no `choice`: the rule went, the mirroring can go on with the rules
 * of other source calendars. The activity page still ends the times of the rule there.
 */
export async function deleteRuleWithBlocks(
  env: Env,
  user: CurrentUser,
  ruleId: string,
): Promise<boolean> {
  const target = await env.DB.prepare(
    `SELECT tc.account_id AS accountId, tc.remote_id AS remoteCalendarId,
            sc.account_id AS fromAccount, r.options, r.enabled,
            sa.email AS sourceEmail, sa.tenant_id AS sourceTenantId,
            ta.email AS targetEmail, ta.tenant_id AS targetTenantId
     FROM rules r
     JOIN calendars tc ON tc.id = r.target_calendar_id
     JOIN calendars sc ON sc.id = r.source_calendar_id
     JOIN accounts sa ON sa.id = sc.account_id
     JOIN accounts ta ON ta.id = tc.account_id
     WHERE r.id = ? AND r.user_id = ?`,
  )
    .bind(ruleId, user.id)
    .first<
      {
        accountId: string;
        remoteCalendarId: string;
        fromAccount: string;
        options: string;
        enabled: number;
      } & AuditIdentities
    >();
  if (!target) return false;

  const queued = await queueRemoval(env, ruleId, target);
  await env.DB.prepare("DELETE FROM rules WHERE id = ? AND user_id = ?")
    .bind(ruleId, user.id)
    .run();
  await recordAudit(env.DB, {
    orgId: user.orgId,
    userId: user.id,
    accountId: target.accountId,
    ruleId,
    kind: "rule_deleted",
    detail: {
      ...(queued ? { cleanup: "queued" } : { cleanupFailed: true }),
      ...fromAccountDetail(target.fromAccount),
      ...previousDetail(
        cappedLevelOfRule(
          env,
          parseRuleOptions(target.options),
          target.enabled === 1,
          ...identities(target),
        ),
      ),
    },
  });
  return true;
}

/**
 * Hand the removal of a rule's blocks to the target account's Durable Object, which runs it in an
 * alarm. The blocks carry the rule's tag, so the rule can change or go right away.
 */
async function queueRemoval(
  env: Env,
  ruleId: string,
  target: { accountId: string; remoteCalendarId: string },
  options: { trim?: boolean } = {},
): Promise<boolean> {
  try {
    await accountSync(env, target.accountId).queueRemoval(
      ruleId,
      target.remoteCalendarId,
      options,
      carrier(),
    );
    return true;
  } catch (error) {
    log.error("removal.queue_failed", { ruleId }, error);
    return false;
  }
}

/**
 * Set one direction. "busy" between two group members becomes a group rule again; every other
 * choice is a custom rule. "off" removes the blocks; between group members it keeps a disabled
 * custom rule, so that the group does not recreate it. See `setDirections`.
 */
export async function setDirection(
  env: Env,
  user: CurrentUser,
  fromId: string,
  toId: string,
  choice: Choice,
  syncs?: Set<string>,
): Promise<void> {
  await setDirections(env, user, [{ from: fromId, to: toId, choice }], syncs);
}

/** What happens after the write batch of `setDirections` for one of its statements. */
type DirectionFollowUp =
  /** An upsert: a new rule, or the rule of a concurrent request for the same pair. */
  | {
      kind: "upsert";
      index: number;
      id: string;
      from: string;
      to: string;
      target: RemovalTarget;
      choice: Choice;
      markPrivate?: boolean;
      details?: Record<string, string>;
    }
  /** A rule disabled or changed in place. */
  | {
      kind: "updated";
      ruleId: string;
      from: string;
      to: string;
      choice: Choice;
      markPrivate?: boolean;
      details?: Record<string, string>;
      remove?: RemovalTarget;
      /** The level of the rule before the change, for the audit log (see `previousDetail`). */
      previous: { choice: Choice; markPrivate: boolean };
    }
  /**
   * A rule deleted: its blocks go too. `from` and `previous` let the audit row name the mirroring
   * and the level it had, because the rule ID leads nowhere once the rule is gone.
   */
  | {
      kind: "deleted";
      index: number;
      ruleId: string;
      from: string;
      to: string;
      remove: RemovalTarget;
      previous: { choice: Choice; markPrivate: boolean };
    }
  /** A parked exception that another choice replaced. */
  | { kind: "unparked"; index: number; ruleId: string; from: string; to: string };

interface RemovalTarget {
  accountId: string;
  remoteCalendarId: string;
}

/**
 * Set several directions with one read and one write batch, so that a page save with many
 * directions stays within the D1 queries of one invocation. See `setDirection` for each choice.
 * A rule changes only if its options are still the ones that were read; otherwise the batch fails
 * as a whole and this throws `EditorConflict`. After the batch, the removals of blocks go to each
 * target account in one call, and the audit events follow in a second batch.
 *
 * `details` of a copied choice go into the same write as the level, so that no run sees a wider
 * level without the filter that the user saved with it, and a failed save stores neither.
 * `written` collects the pairs "from>to" that the batch wrote; a pair that is missing was skipped,
 * for example a target that slotmirror cannot write.
 */
export async function setDirections(
  env: Env,
  user: CurrentUser,
  changes: {
    from: string;
    to: string;
    choice: Choice;
    markPrivate?: boolean;
    details?: DirectionDetails;
  }[],
  syncs?: Set<string>,
  written?: Set<string>,
  /**
   * A state the caller read and checked in this request, for example against the version of the
   * form. The batch then updates and deletes a rule only if its options and its on/off state are
   * as in that read, and creates a rule only where that read had none; otherwise it throws
   * `EditorConflict` and stores nothing. Parked exceptions are deleted without that guard: they
   * write nothing, and a choice other than "off" replaces them anyway.
   */
  checked?: EditorState,
): Promise<Set<string>> {
  // A pair given twice counts once, with its last choice.
  const latest = new Map(changes.map((change) => [`${change.from}>${change.to}`, change]));
  /** Rules "sourceCalendarId>targetCalendarId" whose private mark this call took from the request. */
  const marked = new Set<string>();
  if (latest.size === 0) return marked;
  const state = checked ?? (await loadEditorState(env, user.id));
  const statements: D1PreparedStatement[] = [];
  const followUps: DirectionFollowUp[] = [];
  const targets = new Set<string>();
  const push = (...added: D1PreparedStatement[]) => {
    statements.push(...added);
    return statements.length - added.length;
  };
  const upsert = (rule: {
    id: string;
    sourceCalendarId: string;
    targetCalendarId: string;
    options: RuleOptions;
    origin: "group" | "custom";
    enabled: boolean;
  }) =>
    // With a checked state the rule did not exist then: one that another request created since
    // fails the batch instead of being replaced.
    checked
      ? push(upsertStatement(env, user, rule, true), requireChange(env))
      : push(upsertStatement(env, user, rule));

  for (const change of latest.values()) {
    const to = state.accounts.find((account) => account.id === change.to);
    const from = state.accounts.find((account) => account.id === change.from);
    const direction = state.directions.find((d) => d.from === change.from && d.to === change.to);
    if (!from || !to?.calendar || !direction) continue;
    let choice = change.choice;
    // "Off" needs no write access, so that a rule never keeps writing into a read-only calendar.
    if (choice !== "off" && !to.calendar.canEdit) continue;
    const target = { accountId: to.id, remoteCalendarId: to.calendar.remoteId };
    const bothInGroup = from.inGroup && to.inGroup;
    // The sync applies the caps anyway; storing the capped value keeps the page honest. A capped
    // request counts as bare, except that a private request stays private: a cap never makes the
    // copies more visible than the request asked.
    const capped = RANK[choice] > RANK[direction.maxChoice];
    if (capped) choice = direction.maxChoice;
    const requested = capped && change.markPrivate !== true ? undefined : change.markPrivate;
    // The mark a bare choice keeps: the direction's own while it is copied, else the default. A
    // disabled rule's mark is stale: it is the one it had when it was turned off.
    const keptMark = directionMarksPrivate(direction) ?? state.settings.markPrivate;
    const patch =
      choice === "off" || !change.details
        ? {}
        : directionPatch(from, to, direction, change.details);
    const firstStatement = statements.length;

    // A parked rule stands for "off". Another choice replaces it, so that it cannot bring back an
    // old "off" when its calendar or the direction's last source comes back.
    if (choice !== "off") {
      for (const parked of direction.parked) {
        const index = push(
          env.DB.prepare("DELETE FROM rules WHERE id = ? AND user_id = ? AND enabled = 0").bind(
            parked.id,
            user.id,
          ),
        );
        followUps.push({ kind: "unparked", index, ruleId: parked.id, from: from.id, to: to.id });
      }
    }

    for (const slot of direction.slots) {
      const { rule } = slot;
      if (choice === "off") {
        if (!rule) {
          // Between group members, a disabled exception keeps the group from adding the rule.
          if (bothInGroup) {
            const id = crypto.randomUUID();
            const index = upsert({
              id,
              sourceCalendarId: slot.sourceCalendarId,
              targetCalendarId: to.calendar.id,
              options: {
                ...newRuleOptions(state.settings, "busy"),
                ...newRuleSource(state, from.id),
              },
              origin: "custom",
              enabled: false,
            });
            followUps.push({ kind: "upsert", index, id, from: from.id, to: to.id, target, choice });
          }
          continue;
        }
        if (!bothInGroup) {
          // With a checked state, only the rule as it was read: one that another request changed
          // since fails the batch. Without, a later request wins.
          const index = checked
            ? push(
                env.DB.prepare(
                  "DELETE FROM rules WHERE id = ? AND user_id = ? AND options = ? AND enabled = ?",
                ).bind(rule.id, user.id, rule.optionsJson, rule.enabled ? 1 : 0),
                requireChange(env),
              )
            : push(
                env.DB.prepare("DELETE FROM rules WHERE id = ? AND user_id = ?").bind(
                  rule.id,
                  user.id,
                ),
              );
          followUps.push({
            kind: "deleted",
            index,
            ruleId: rule.id,
            from: from.id,
            to: to.id,
            remove: target,
            previous: previousLevel(env, rule, from, to),
          });
          continue;
        }
        push(
          env.DB.prepare(
            `UPDATE rules SET enabled = 0, origin = 'custom'
             WHERE id = ? AND user_id = ? AND options = ? AND enabled = ?`,
          ).bind(rule.id, user.id, rule.optionsJson, rule.enabled ? 1 : 0),
          requireChange(env),
        );
        followUps.push({
          kind: "updated",
          ruleId: rule.id,
          from: from.id,
          to: to.id,
          choice,
          remove: target,
          previous: previousLevel(env, rule, from, to),
        });
        continue;
      }

      // A new rule gets the options of its source, which all rules from the source share. The
      // private mark goes into the same write as the level, so that no run sees a level without
      // the mark that the user chose with it. A request with a mark sets it on every rule. A bare
      // choice keeps each enabled rule's own mark, so that a rule of a mixed direction never
      // becomes more visible; other rules take the direction's mark or the default.
      const markPrivate = requested ?? (rule?.enabled ? rule.options.markPrivate : keptMark);
      if (requested !== undefined) marked.add(`${slot.sourceCalendarId}>${to.calendar.id}`);
      const base: RuleOptions = rule?.options ?? {
        ...(direction.options ?? newRuleOptions(state.settings, choice)),
        ...newRuleSource(state, from.id),
      };
      const options: RuleOptions = { ...base, ...patch, detailLevel: choice, markPrivate };
      const details = detailChanges(base, options);
      const origin = groupOrigin(bothInGroup, true, options);
      if (rule) {
        push(
          env.DB.prepare(
            `UPDATE rules SET options = ?, enabled = 1, origin = ?
             WHERE id = ? AND user_id = ? AND options = ? AND enabled = ?`,
          ).bind(
            JSON.stringify(options),
            origin,
            rule.id,
            user.id,
            rule.optionsJson,
            rule.enabled ? 1 : 0,
          ),
          requireChange(env),
        );
        // The mark the rule gets, also for a bare choice: the row names the level after exactly.
        followUps.push({
          kind: "updated",
          ruleId: rule.id,
          from: from.id,
          to: to.id,
          choice,
          markPrivate,
          details,
          previous: previousLevel(env, rule, from, to),
        });
      } else {
        const id = crypto.randomUUID();
        const index = upsert({
          id,
          sourceCalendarId: slot.sourceCalendarId,
          targetCalendarId: to.calendar.id,
          options,
          origin,
          enabled: true,
        });
        followUps.push({
          kind: "upsert",
          index,
          id,
          from: from.id,
          to: to.id,
          target,
          choice,
          markPrivate,
          details,
        });
      }
    }
    if (choice !== "off") targets.add(to.id);
    if (statements.length > firstStatement) written?.add(`${change.from}>${change.to}`);
  }
  if (statements.length === 0) return marked;
  const results = await guardedBatch(env, statements);

  const removals = new Map<string, { ruleId: string; remoteCalendarId: string }[]>();
  const remove = (ruleId: string, target: RemovalTarget) => {
    const queue = removals.get(target.accountId) ?? [];
    queue.push({ ruleId, remoteCalendarId: target.remoteCalendarId });
    removals.set(target.accountId, queue);
  };
  const audits: AuditEvent[] = [];
  const event = (
    to: string,
    ruleId: string,
    kind: AuditEvent["kind"],
    detail: NonNullable<AuditEvent["detail"]>,
  ) => audits.push({ orgId: user.orgId, userId: user.id, accountId: to, ruleId, kind, detail });
  const deleted: {
    ruleId: string;
    from: string;
    to: string;
    accountId: string;
    previous: { choice: Choice; markPrivate: boolean };
  }[] = [];
  for (const followUp of followUps) {
    switch (followUp.kind) {
      case "upsert": {
        const stored = results[followUp.index]?.results[0] as { id: string } | undefined;
        if (!stored) break;
        const created = stored.id === followUp.id;
        // A concurrent request created the rule, and it can have written blocks already.
        if (followUp.choice === "off") {
          if (created) break;
          remove(stored.id, followUp.target);
        }
        event(followUp.to, stored.id, created ? "rule_created" : "rule_updated", {
          choice: followUp.choice,
          ...markDetail(followUp.choice === "off" ? undefined : followUp.markPrivate),
          ...followUp.details,
          ...fromAccountDetail(followUp.from),
        });
        break;
      }
      case "updated":
        if (followUp.remove) remove(followUp.ruleId, followUp.remove);
        event(followUp.to, followUp.ruleId, "rule_updated", {
          choice: followUp.choice,
          ...markDetail(followUp.choice === "off" ? undefined : followUp.markPrivate),
          ...followUp.details,
          ...previousDetail(followUp.previous),
          ...fromAccountDetail(followUp.from),
        });
        break;
      case "deleted":
        // A concurrent request deleted the rule first; it queued the removal and wrote the audit.
        if ((results[followUp.index]?.meta.changes ?? 0) === 0) break;
        remove(followUp.ruleId, followUp.remove);
        deleted.push({
          ruleId: followUp.ruleId,
          from: followUp.from,
          to: followUp.to,
          accountId: followUp.remove.accountId,
          previous: followUp.previous,
        });
        break;
      case "unparked":
        // A parked exception writes no blocks, so there is nothing to remove.
        if ((results[followUp.index]?.meta.changes ?? 0) === 0) break;
        event(followUp.to, followUp.ruleId, "rule_deleted", {
          parked: "replaced",
          ...fromAccountDetail(followUp.from),
        });
        break;
    }
  }
  // One call per target account. Like every queueing, a failure is logged and noted in the audit.
  const queued = new Map<string, boolean>();
  for (const [accountId, rules] of removals) {
    try {
      await accountSync(env, accountId).queueRemovals(rules, {}, carrier());
      queued.set(accountId, true);
    } catch (error) {
      log.error("removal.queue_failed", { accountId }, error);
      queued.set(accountId, false);
    }
  }
  // A save that turns a mirroring off deletes its rules. The row says so as a level change to "off"
  // and names the source account, so that the activity page can show the mirroring (the target
  // is the row's account). IDs and levels only.
  for (const { ruleId, from, to, accountId, previous } of deleted) {
    event(to, ruleId, "rule_deleted", {
      ...(queued.get(accountId) ? { cleanup: "queued" } : { cleanupFailed: true }),
      choice: "off",
      ...fromAccountDetail(from),
      ...previousDetail(previous),
    });
  }
  if (audits.length > 0) {
    // The change is done; like `recordAudit`, a broken log must not fail the request.
    try {
      await env.DB.batch(audits.map((audit) => auditStatement(env.DB, audit)));
    } catch (error) {
      log.error("audit.write_failed", { auditKind: "rule_updated" }, error);
    }
  }
  await requestSyncs(env, targets, syncs);
  return marked;
}

/** The private mark of a level for the audit log, if it has one. */
function markDetail(markPrivate: boolean | undefined): { markPrivate?: boolean } {
  return markPrivate === undefined ? {} : { markPrivate };
}

/**
 * The level of a stored rule between two accounts, with the org caps: its choice, and its mark. A
 * disabled rule is off.
 */
function previousLevel(
  env: Env,
  rule: SlotRule,
  from: EditorAccount,
  to: EditorAccount,
): { choice: Choice; markPrivate: boolean } {
  return cappedLevelOfRule(env, rule.options, rule.enabled, from, to);
}

/** Address and tenant of the two accounts of a rule, as a query reads them for the org caps. */
interface AuditIdentities {
  sourceEmail: string;
  sourceTenantId: string | null;
  targetEmail: string;
  targetTenantId: string | null;
}

/** The two identities of a row with `AuditIdentities`, in the order the cap helpers take them. */
function identities(row: AuditIdentities): [AccountIdentity, AccountIdentity] {
  return [
    { email: row.sourceEmail, tenantId: row.sourceTenantId },
    { email: row.targetEmail, tenantId: row.targetTenantId },
  ];
}

/** `levelOfRule` with the org caps applied, as the sync applies them. */
function cappedLevelOfRule(
  env: Env,
  options: RuleOptions,
  enabled: boolean,
  source: AccountIdentity,
  target: AccountIdentity,
): { choice: Choice; markPrivate: boolean } {
  const { choice } = cappedLevelAuditDetail(env, options, enabled, source, target);
  return { choice, markPrivate: options.markPrivate };
}

/**
 * The level a rule has after a change, for its audit row: the choice, and the mark it actually got
 * while it copies. Off carries no mark. The activity page reads the pair as the level after, so a
 * row that names the level never leaves the mark to a guess.
 */
export function levelAuditDetail(
  options: RuleOptions,
  enabled: boolean,
): { choice: Choice; markPrivate?: boolean } {
  const choice = choiceOf(options, enabled);
  return choice === "off" ? { choice } : { choice, markPrivate: options.markPrivate };
}

/**
 * `levelAuditDetail` with the org caps applied, as the sync applies them: for a rule whose stored
 * options can name more than the caps allow (the old rules page, a rule held by an offboarding).
 * The row then never names a wider level than the copies get.
 */
export function cappedLevelAuditDetail(
  env: Env,
  options: RuleOptions,
  enabled: boolean,
  source: AccountIdentity,
  target: AccountIdentity,
): { choice: Choice; markPrivate?: boolean } {
  const { level } = detailLevelFor(env, options.detailLevel, source, target);
  return levelAuditDetail({ ...options, detailLevel: level }, enabled);
}

/**
 * The source account of a rule, for every `rule_*` audit row. With the row's own account (the
 * target) it names the mirroring also after the rule is deleted, so the activity page can keep the
 * row under its mirroring and its filters can find it. An ID only, never an address.
 */
export function fromAccountDetail(from: string): { fromAccount: string } {
  return { fromAccount: from };
}

/**
 * The level before a change, for the `rule_updated` audit row, so that the activity page can show
 * "{old} → {new}" and drop changes that cancel out. Flat fields, because an audit detail holds
 * plain values. Only the level: never a name, a title or a category. Off carries no mark: the mark
 * of a disabled rule is the one it had when it was turned off.
 */
export function previousDetail(previous: { choice: Choice; markPrivate: boolean }): {
  previousChoice: Choice;
  previousMarkPrivate?: boolean;
} {
  return previous.choice === "off"
    ? { previousChoice: "off" }
    : { previousChoice: previous.choice, previousMarkPrivate: previous.markPrivate };
}

/**
 * Turn a calendar on or off as a source of its account. On: it gets a rule for every direction
 * of the account, with that direction's choice, or the group's rule between group members. Off:
 * its rules go, with their blocks. An "off" exception into a main calendar stays as a parked rule,
 * so that the group does not turn the direction on when the calendar comes back.
 */
export async function setSourceCalendar(
  env: Env,
  user: CurrentUser,
  calendarId: string,
  isSource: boolean,
  syncs?: Set<string>,
  /**
   * The caller read the calendar with the other value and checked that read in this request. If
   * another request switched it since, `EditorConflict` is thrown and nothing is written. Without
   * it, a calendar that already has the value is left as it is.
   */
  checked?: boolean,
): Promise<void> {
  const updated = await env.DB.prepare(
    `UPDATE calendars SET is_source = ?
     WHERE id = ? AND is_source <> ?
       AND account_id IN (SELECT id FROM accounts WHERE user_id = ?)`,
  )
    .bind(isSource ? 1 : 0, calendarId, isSource ? 1 : 0, user.id)
    .run();
  if (updated.meta.changes === 0) {
    if (checked) throw new EditorConflict();
    return;
  }

  if (!isSource) {
    const { results } = await env.DB.prepare(
      `SELECT r.id, r.enabled, r.origin, tc.is_default AS isMain, tc.account_id AS accountId,
              tc.remote_id AS remoteCalendarId, sc.account_id AS fromAccount
       FROM rules r JOIN calendars tc ON tc.id = r.target_calendar_id
       JOIN calendars sc ON sc.id = r.source_calendar_id
       WHERE r.source_calendar_id = ? AND r.user_id = ?`,
    )
      .bind(calendarId, user.id)
      .all<{
        id: string;
        enabled: number;
        origin: string;
        isMain: number;
        accountId: string;
        remoteCalendarId: string;
        fromAccount: string;
      }>();
    for (const row of results) {
      if (row.enabled === 0 && row.origin === "custom" && row.isMain === 1) {
        await env.DB.prepare(
          "UPDATE rules SET options = json_set(options, '$.parked', json('true')) WHERE id = ?",
        )
          .bind(row.id)
          .run();
        // A paused rule can still have blocks; an exception has none, and the queue finds none.
        const queued = await queueRemoval(env, row.id, row);
        // A pause of the old rules page left its copies showing; this removal ends them, so the
        // row says so. The rule was off already: the level stays "off". IDs and levels only.
        await recordAudit(env.DB, {
          orgId: user.orgId,
          userId: user.id,
          accountId: row.accountId,
          ruleId: row.id,
          kind: "rule_updated",
          detail: {
            choice: "off",
            previousChoice: "off",
            cleanup: queued ? "queued" : "none",
            ...fromAccountDetail(row.fromAccount),
          },
        });
      } else {
        await deleteRuleWithBlocks(env, user, row.id);
      }
    }
    return;
  }

  // A parked exception is current only if no other source calendar has a rule for the direction.
  // Otherwise the other calendar holds the choice, and the parked rule gives way to a copy of it.
  const state = await loadEditorState(env, user.id);
  const stale: { ruleId: string; from: string; accountId: string }[] = [];
  for (const direction of state.directions) {
    const own = direction.slots.find((slot) => slot.sourceCalendarId === calendarId);
    const other = direction.slots.some((slot) => slot !== own && slot.rule);
    if (own?.rule && isMarkedParked(own.rule.optionsJson) && other) {
      stale.push({ ruleId: own.rule.id, from: direction.from, accountId: direction.to });
      own.rule = null;
    }
  }
  const results = await addMissingRules(
    env,
    user,
    state,
    [
      ...stale.map(({ ruleId }) =>
        env.DB.prepare(
          `DELETE FROM rules WHERE id = ? AND user_id = ? AND enabled = 0
           AND json_extract(options, '$.parked') = 1`,
        ).bind(ruleId, user.id),
      ),
      // The calendar is a source again: its rules that stay are no longer parked.
      env.DB.prepare(
        "UPDATE rules SET options = json_remove(options, '$.parked') WHERE source_calendar_id = ? AND user_id = ?",
      ).bind(calendarId, user.id),
    ],
    syncs,
  );
  const deleted = stale.filter((_, index) => (results[index]?.meta.changes ?? 0) > 0);
  for (const { ruleId, from, accountId } of deleted) {
    // An exception writes no blocks, so there is nothing to remove.
    await audit(env, user, accountId, ruleId, "rule_deleted", {
      parked: "replaced",
      ...fromAccountDetail(from),
    });
  }
}

/**
 * Undo an exception: back to the group's busy, or no rule outside the group. The block colour,
 * the working hours, the opt-in list and the carried categories go back to none too, and the
 * private mark to the one of the settings, so that the direction is the plain default again.
 * The buffer stays: it belongs to the source, not to the direction. A group direction can still
 * get a colour later; that does not make it an exception. A read-only target stays as it is:
 * `can_edit` can be wrong, so a reset must not remove blocks there. "Off" is the explicit way.
 */
export async function resetDirection(
  env: Env,
  user: CurrentUser,
  fromId: string,
  toId: string,
): Promise<void> {
  const state = await loadEditorState(env, user.id);
  const from = state.accounts.find((account) => account.id === fromId);
  const to = state.accounts.find((account) => account.id === toId);
  if (!from || !to?.calendar?.canEdit) return;
  // The hours go first; outside the group the rules go anyway. One sync request at the end, also
  // after a conflict: the steps before it stay written.
  const syncs = new Set<string>();
  try {
    await setRuleDetails(env, user, { workHours: [{ from: fromId, to: toId, on: false }] }, syncs);
    // The group's busy carries the mark of the settings, named here because a bare busy would keep
    // the direction's own mark; see `setDirections`.
    const choice = from.inGroup && to.inGroup ? "busy" : "off";
    const markPrivate = choice === "busy" ? state.settings.markPrivate : undefined;
    await setDirections(env, user, [{ from: fromId, to: toId, choice, markPrivate }], syncs);
    await setBlockColor(env, user, fromId, toId, "", syncs);
    // Last, so that a rule that goes away never runs without its list. The carried categories go
    // too: they are an opt-in of the exception, not of the group.
    await setRuleDetails(
      env,
      user,
      {
        onlyCategories: [{ from: fromId, to: toId, names: [] }],
        passCategories: [{ from: fromId, to: toId, pairs: [] }],
      },
      syncs,
    );
  } finally {
    await requestSyncs(env, syncs);
  }
}

/** A rule that a direction lacks, with its source account for the audit log. */
interface MissingRule {
  id: string;
  fromAccountId: string;
  /** Address and tenant of both accounts, for the org caps of the level in the audit log. */
  source: AccountIdentity;
  target: AccountIdentity;
  sourceCalendarId: string;
  targetCalendarId: string;
  targetAccountId: string;
  options: RuleOptions;
  origin: "group" | "custom";
  enabled: boolean;
}

/**
 * The rules that make every direction complete:
 * - A direction with a rule gets a copy of it for each source calendar without one, so that all
 *   its rules have the same choice. A parked "off" exception counts as such a rule.
 * - A direction without rules between two group members gets a group rule ("busy") for each
 *   source calendar.
 *
 * A source calendar that has a rule keeps it, so an exception, also a disabled one, wins over the
 * group. A read-only target gets nothing, because turning a direction on needs write access. A
 * direction with rules into another calendar of the target account, such as the main calendar
 * before it changed, gets nothing either: a second set of rules would write every block twice.
 */
function missingRules(state: EditorState): MissingRule[] {
  const missing: MissingRule[] = [];
  for (const direction of state.directions) {
    const from = state.accounts.find((account) => account.id === direction.from);
    const to = state.accounts.find((account) => account.id === direction.to);
    if (!from || !to?.calendar?.canEdit || direction.elsewhere) continue;
    const model = direction.slots.find((slot) => slot.rule)?.rule ?? direction.parked[0];
    if (!model && !(from.inGroup && to.inGroup)) continue;
    // A copy takes the current options of its source and the current hours of its target: a
    // parked model can be older than both.
    const hours = model && hasWorkingHours(model.options) ? (to.workHours ?? NO_WORKING_HOURS) : {};
    const options = {
      ...(model?.options ?? newRuleOptions(state.settings, "busy")),
      ...newRuleSource(state, from.id),
      ...hours,
    };
    for (const slot of direction.slots) {
      if (slot.rule) continue;
      missing.push({
        id: crypto.randomUUID(),
        fromAccountId: from.id,
        source: { email: from.email, tenantId: from.tenantId },
        target: { email: to.email, tenantId: to.tenantId },
        sourceCalendarId: slot.sourceCalendarId,
        targetCalendarId: to.calendar.id,
        targetAccountId: to.id,
        options,
        origin: model?.origin ?? "group",
        enabled: model?.enabled ?? true,
      });
    }
  }
  return missing;
}

/**
 * Statements that insert the missing rules, each with its audit event. A concurrent request can
 * insert the same pair first; the insert then does nothing, and its audit event is not written.
 */
function insertStatements(
  env: Env,
  user: Pick<CurrentUser, "id" | "orgId">,
  rules: MissingRule[],
): D1PreparedStatement[] {
  return rules.flatMap((rule) => [
    env.DB.prepare(
      `INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options, enabled, origin)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_calendar_id, target_calendar_id) DO NOTHING`,
    ).bind(
      rule.id,
      user.id,
      rule.sourceCalendarId,
      rule.targetCalendarId,
      JSON.stringify(rule.options),
      rule.enabled ? 1 : 0,
      rule.origin,
    ),
    auditStatement(
      env.DB,
      {
        orgId: user.orgId,
        userId: user.id,
        accountId: rule.targetAccountId,
        ruleId: rule.id,
        kind: "rule_created",
        // The level and mark the copy gets from its model, with the org caps as the sync applies
        // them: a model from the old rules page can store more than the caps allow.
        detail: {
          ...cappedLevelAuditDetail(env, rule.options, rule.enabled, rule.source, rule.target),
          ...fromAccountDetail(rule.fromAccountId),
        },
      },
      "rule_exists",
    ),
  ]);
}

/** Target accounts that got an enabled rule from `insertStatements`, run at `offset` in a batch. */
function syncTargets(rules: MissingRule[], results: D1Result[], offset: number): Set<string> {
  const targets = new Set<string>();
  rules.forEach((rule, index) => {
    const inserted = (results[offset + 2 * index]?.meta.changes ?? 0) > 0;
    if (inserted && rule.enabled) targets.add(rule.targetAccountId);
  });
  return targets;
}

/**
 * Ask accounts to sync, or add them to `syncs`, so that a save with several steps asks each
 * account once, after its last write.
 *
 * The write is stored when this runs, so a failed request must not fail the save: the save would
 * show the error page for stored values, and the accounts after it would not be asked. A failure
 * is logged per account. The hourly full cycle of the cron then syncs that account, so the change
 * can take up to an hour to reach a watched calendar.
 */
export async function requestSyncs(
  env: Env,
  accountIds: Iterable<string>,
  syncs?: Set<string>,
): Promise<void> {
  for (const id of accountIds) {
    if (syncs) {
      syncs.add(id);
      continue;
    }
    try {
      await accountSync(env, id).requestSync(carrier());
    } catch (error) {
      log.error("sync.request_failed", { accountId: id }, error);
    }
  }
}

/**
 * Add the rules that the directions of a user lack (see `missingRules`). Call it after anything
 * that can make a rule possible: a source calendar turned on, calendars loaded or refreshed, a
 * target that became writable. A second call adds nothing. Cost: one read batch, and one write
 * batch only if a rule is missing.
 */
export async function reconcileRules(
  env: Env,
  user: Pick<CurrentUser, "id" | "orgId">,
): Promise<void> {
  await addMissingRules(env, user, await loadEditorState(env, user.id));
}

/** Run `before` and the inserts of the missing rules in one batch, then request the syncs. */
async function addMissingRules(
  env: Env,
  user: Pick<CurrentUser, "id" | "orgId">,
  state: EditorState,
  before: D1PreparedStatement[] = [],
  syncs?: Set<string>,
): Promise<D1Result[]> {
  const missing = missingRules(state);
  if (missing.length === 0 && before.length === 0) return [];
  const results = await env.DB.batch([...before, ...insertStatements(env, user, missing)]);
  await requestSyncs(env, syncTargets(missing, results, before.length), syncs);
  return results;
}

/** Add an account to the block group or remove it. See `setGroupMemberships`. */
export async function setGroupMembership(
  env: Env,
  user: CurrentUser,
  accountId: string,
  inGroup: boolean,
): Promise<void> {
  await setGroupMemberships(env, user, [accountId], inGroup);
}

/**
 * Add accounts to the block group or remove them. Joining creates a busy rule to and from every
 * other member, and adopts existing busy rules with default options. Leaving deletes the group
 * rules of the accounts with their blocks; custom rules stay. The writes go in batches, so that
 * the quick start for all accounts stays within the D1 queries of one invocation.
 */
export async function setGroupMemberships(
  env: Env,
  user: CurrentUser,
  accountIds: readonly string[],
  inGroup: boolean,
): Promise<void> {
  if (accountIds.length === 0) return;
  if (!inGroup) {
    await leaveGroup(env, user, accountIds);
    return;
  }
  const updates = await env.DB.batch(accountIds.map((id) => membershipUpdate(env, user, id, true)));
  const changed = new Set(accountIds.filter((_, i) => (updates[i]?.meta.changes ?? 0) > 0));
  if (changed.size === 0) return;
  const statements = [...changed].map((accountId) => groupChangedAudit(env, user, accountId, true));

  const state = await loadEditorState(env, user.id);
  for (const direction of state.directions) {
    if (!changed.has(direction.from) && !changed.has(direction.to)) continue;
    const from = state.accounts.find((account) => account.id === direction.from);
    const to = state.accounts.find((account) => account.id === direction.to);
    if (!from?.inGroup || !to?.inGroup || !to.calendar?.canEdit) continue;
    for (const { rule } of direction.slots) {
      if (
        rule?.origin === "custom" &&
        rule.enabled &&
        choiceOf(rule.options, true) === "busy" &&
        hasDefaultOptions(rule.options, state.settings, newRuleSource(state, direction.from))
      ) {
        // Only if the rule is unchanged: a concurrent request may have customised it.
        statements.push(
          env.DB.prepare(
            `UPDATE rules SET origin = 'group'
             WHERE id = ? AND enabled = 1 AND origin = 'custom' AND options = ?`,
          ).bind(rule.id, rule.optionsJson),
        );
        // Copies for other source calendars of the direction follow the adopted rule.
        rule.origin = "group";
      }
    }
  }
  await addMissingRules(env, user, state, statements);
}

/**
 * Leave the group: the membership and the deletion of the group rules commit together, and the
 * removal of the blocks is queued only after that. A call for an account that is out of the group
 * already still deletes group rules left over from an earlier failure.
 */
async function leaveGroup(
  env: Env,
  user: CurrentUser,
  accountIds: readonly string[],
): Promise<void> {
  // Every group rule from or to a leaving account, whatever calendar it targets: after a change of
  // the main calendar, group rules into the old one are outside the editor's directions.
  const { results: deletions } = await env.DB.prepare(
    `SELECT r.id AS ruleId, tc.account_id AS accountId, tc.remote_id AS remoteCalendarId,
            sc.account_id AS fromAccount, r.options, r.enabled,
            sa.email AS sourceEmail, sa.tenant_id AS sourceTenantId,
            ta.email AS targetEmail, ta.tenant_id AS targetTenantId
     FROM rules r
     JOIN calendars sc ON sc.id = r.source_calendar_id
     JOIN calendars tc ON tc.id = r.target_calendar_id
     JOIN accounts sa ON sa.id = sc.account_id
     JOIN accounts ta ON ta.id = tc.account_id
     WHERE r.user_id = ?1 AND r.origin = 'group'
       AND (sc.account_id IN (SELECT value FROM json_each(?2))
         OR tc.account_id IN (SELECT value FROM json_each(?2)))`,
  )
    .bind(user.id, JSON.stringify(accountIds))
    .all<
      {
        ruleId: string;
        accountId: string;
        remoteCalendarId: string;
        fromAccount: string;
        options: string;
        enabled: number;
      } & AuditIdentities
    >();
  const results = await env.DB.batch([
    ...accountIds.map((id) => membershipUpdate(env, user, id, false)),
    ...deletions.map(({ ruleId }) =>
      env.DB.prepare("DELETE FROM rules WHERE id = ? AND user_id = ? AND origin = 'group'").bind(
        ruleId,
        user.id,
      ),
    ),
  ]);
  const changed = (index: number) => (results[index]?.meta.changes ?? 0) > 0;
  const audits = accountIds.flatMap((accountId, index) =>
    changed(index) ? [groupChangedAudit(env, user, accountId, false)] : [],
  );
  for (const [index, deletion] of deletions.entries()) {
    // A concurrent request deleted the rule first; it queued the removal and wrote the audit.
    if (!changed(accountIds.length + index)) continue;
    const queued = await queueRemoval(env, deletion.ruleId, deletion);
    audits.push(
      auditStatement(env.DB, {
        orgId: user.orgId,
        userId: user.id,
        accountId: deletion.accountId,
        ruleId: deletion.ruleId,
        kind: "rule_deleted",
        detail: {
          ...(queued ? { cleanup: "queued" } : { cleanupFailed: true }),
          ...fromAccountDetail(deletion.fromAccount),
          ...previousDetail(
            cappedLevelOfRule(
              env,
              parseRuleOptions(deletion.options),
              deletion.enabled === 1,
              ...identities(deletion),
            ),
          ),
        },
      }),
    );
  }
  if (audits.length === 0) return;
  // The change is done; like `recordAudit`, a broken log must not fail the request.
  try {
    await env.DB.batch(audits);
  } catch (error) {
    log.error("audit.write_failed", { auditKind: "group_changed" }, error);
  }
}

function membershipUpdate(env: Env, user: CurrentUser, accountId: string, inGroup: boolean) {
  const value = inGroup ? 1 : 0;
  return env.DB.prepare(
    "UPDATE accounts SET in_block_group = ? WHERE id = ? AND user_id = ? AND in_block_group <> ?",
  ).bind(value, accountId, user.id, value);
}

function groupChangedAudit(env: Env, user: CurrentUser, accountId: string, inGroup: boolean) {
  return auditStatement(env.DB, {
    orgId: user.orgId,
    userId: user.id,
    accountId,
    kind: "group_changed",
    detail: { inGroup },
  });
}

/** True if a rule has the options of a new group rule: the settings and its source's options. */
function hasDefaultOptions(
  options: RuleOptions | null,
  settings: SyncSettings,
  source: Partial<SourceOptions>,
): boolean {
  if (!options) return false;
  const { detailLevel: _level, ...rest } = options;
  const { detailLevel: _default, ...defaults } = { ...newRuleOptions(settings, "busy"), ...source };
  return JSON.stringify(rest) === JSON.stringify(defaults);
}

/**
 * Insert a rule, or write this request's choice into the rule of the same pair. Two requests can
 * add the same pair at once, for example after a double click or from two tabs; the UNIQUE
 * constraint on the pair would refuse the second insert. Here the later request wins, as if it
 * came second. The statement returns the ID of the stored rule; it is this rule's ID if the
 * statement created it.
 */
function upsertStatement(
  env: Env,
  user: CurrentUser,
  rule: {
    id: string;
    sourceCalendarId: string;
    targetCalendarId: string;
    options: RuleOptions;
    origin: "group" | "custom";
    enabled: boolean;
  },
  /** Insert only: a rule that exists for the pair stays, and the statement changes no row. */
  insertOnly = false,
): D1PreparedStatement {
  return env.DB.prepare(
    insertOnly
      ? `INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options, enabled, origin)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (source_calendar_id, target_calendar_id) DO NOTHING
         RETURNING id`
      : `INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options, enabled, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (source_calendar_id, target_calendar_id) DO UPDATE SET
       options = excluded.options, enabled = excluded.enabled, origin = excluded.origin
     WHERE rules.user_id = excluded.user_id
     RETURNING id`,
  ).bind(
    rule.id,
    user.id,
    rule.sourceCalendarId,
    rule.targetCalendarId,
    JSON.stringify(rule.options),
    rule.enabled ? 1 : 0,
    rule.origin,
  );
}

async function audit(
  env: Env,
  user: CurrentUser,
  accountId: string,
  ruleId: string,
  kind: "rule_created" | "rule_updated" | "rule_deleted",
  detail: Record<string, string>,
): Promise<void> {
  await recordAudit(env.DB, {
    orgId: user.orgId,
    userId: user.id,
    accountId,
    ruleId,
    kind,
    detail,
  });
}
