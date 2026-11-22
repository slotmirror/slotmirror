import * as z from "zod/mini";
import { SILENT_RULE_MS } from "./alerts";
import { recentRuleRuns, statusOf, type RecentRun, type SyncRunDetail } from "./audit";
import { parseRuleOptions } from "./config";
import { detailLevelResolver } from "./detail-policy";
import { hasWorkingHours } from "./sync/working-hours";

/**
 * What the read-only API may show. Each field is named here on purpose: the tools never pass on a
 * row, `rules.options` or an audit `detail`. Tenant IDs, remote calendar IDs, category names, block
 * titles and audit texts stay out. All queries read D1 and take the user from the token. Only
 * `list_events` also reads calendars, through each account's Durable Object; see `mcp-events.ts`.
 */

/**
 * Rules in one answer. `ORDER BY r.rowid` follows the index `rules_user`, so the LIMIT stops the
 * read without a sort, and both rule tools name the same rules. Each rule costs about 6 µs of CPU
 * for its options (measured warm in Node), and a cold isolate is slower: 200 keeps far below 10 ms.
 */
const MAX_LISTED_RULES = 200;
/** Accounts in one answer. The sort reads all accounts of the user, which this bounds as well. */
const MAX_LISTED_ACCOUNTS = 100;

/**
 * The answer shapes. They are strict: the MCP tools publish them as `outputSchema`, and a test
 * refuses an answer that carries a field outside them.
 */
const accountView = z.strictObject({
  id: z.string(),
  provider: z.string(),
  email: z.string(),
  name: z.string(),
  needsReconnect: z.boolean(),
  calendars: z.number(),
});
export type AccountView = z.infer<typeof accountView>;
export const accountsAnswer = z.strictObject({
  accounts: z.array(accountView),
  truncated: z.boolean(),
});

export async function readAccounts(
  db: D1Database,
  userId: string,
): Promise<z.infer<typeof accountsAnswer>> {
  const { results } = await db
    .prepare(
      `SELECT a.id, a.provider, a.email, COALESCE(a.display_name, a.email) AS name,
              a.needs_reconnect AS needsReconnect,
              (SELECT COUNT(*) FROM calendars c WHERE c.account_id = a.id) AS calendars
       FROM accounts a WHERE a.user_id = ? ORDER BY a.created_at, a.id LIMIT ?`,
    )
    .bind(userId, MAX_LISTED_ACCOUNTS + 1)
    .all<Omit<AccountView, "needsReconnect"> & { needsReconnect: number }>();
  return {
    truncated: results.length > MAX_LISTED_ACCOUNTS,
    accounts: results
      .slice(0, MAX_LISTED_ACCOUNTS)
      .map((row) => ({ ...row, needsReconnect: row.needsReconnect === 1 })),
  };
}

const calendarRef = z.strictObject({ accountId: z.string(), calendar: z.string() });

const ruleView = z.strictObject({
  id: z.string(),
  source: calendarRef,
  target: calendarRef,
  enabled: z.boolean(),
  /** The level the rule runs with, after the deployment's caps. Null: the options do not parse. */
  detailLevel: z.nullable(z.string()),
  daysAhead: z.nullable(z.number()),
  bufferBefore: z.nullable(z.number()),
  bufferAfter: z.nullable(z.number()),
  /** Whether a filter is on. Category names can be content themselves, so they stay out. */
  filters: z.nullable(z.strictObject({ categories: z.boolean(), workingHours: z.boolean() })),
});
export type RuleView = z.infer<typeof ruleView>;
export const rulesAnswer = z.strictObject({ rules: z.array(ruleView), truncated: z.boolean() });

function ruleSettings(
  detailLevelFor: ReturnType<typeof detailLevelResolver>,
  json: string,
  source: { email: string; tenantId: string | null },
  target: { email: string; tenantId: string | null },
) {
  try {
    const options = parseRuleOptions(json);
    return {
      detailLevel: detailLevelFor(options.detailLevel, source, target).level,
      daysAhead: options.daysAhead,
      bufferBefore: options.bufferBefore,
      bufferAfter: options.bufferAfter,
      filters: {
        categories: options.skipCategories.length > 0 || options.onlyCategories.length > 0,
        workingHours: hasWorkingHours(options),
      },
    };
  } catch {
    return {
      detailLevel: null,
      daysAhead: null,
      bufferBefore: null,
      bufferAfter: null,
      filters: null,
    };
  }
}

export async function readRules(env: Env, userId: string): Promise<z.infer<typeof rulesAnswer>> {
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.options, r.enabled,
            sc.account_id AS sourceAccountId, sc.name AS sourceCalendar,
            sa.email AS sourceEmail, sa.tenant_id AS sourceTenantId,
            tc.account_id AS targetAccountId, tc.name AS targetCalendar,
            ta.email AS targetEmail, ta.tenant_id AS targetTenantId
     FROM rules r
     JOIN calendars sc ON sc.id = r.source_calendar_id
     JOIN accounts sa ON sa.id = sc.account_id
     JOIN calendars tc ON tc.id = r.target_calendar_id
     JOIN accounts ta ON ta.id = tc.account_id
     WHERE r.user_id = ? ORDER BY r.rowid LIMIT ?`,
  )
    .bind(userId, MAX_LISTED_RULES + 1)
    .all<{
      id: string;
      options: string;
      enabled: number;
      sourceAccountId: string;
      sourceCalendar: string;
      sourceEmail: string;
      sourceTenantId: string | null;
      targetAccountId: string;
      targetCalendar: string;
      targetEmail: string;
      targetTenantId: string | null;
    }>();
  const detailLevelFor = detailLevelResolver(env);
  return {
    truncated: results.length > MAX_LISTED_RULES,
    rules: results.slice(0, MAX_LISTED_RULES).map((row) => ({
      id: row.id,
      source: { accountId: row.sourceAccountId, calendar: row.sourceCalendar },
      target: { accountId: row.targetAccountId, calendar: row.targetCalendar },
      enabled: row.enabled === 1,
      ...ruleSettings(
        detailLevelFor,
        row.options,
        { email: row.sourceEmail, tenantId: row.sourceTenantId },
        { email: row.targetEmail, tenantId: row.targetTenantId },
      ),
    })),
  };
}

const ruleStatusView = z.strictObject({
  ruleId: z.string(),
  enabled: z.boolean(),
  /**
   * "paused": the rule is off. "reconnect": an account of the rule needs reconnecting, so the
   * rule does not run. "stale": the last outcome was fine but is older than the window of the run
   * alerts, so the rule stopped without an error. "unknown": no run within the audit rows that one
   * call reads. None of these is ever reported as healthy.
   */
  state: z.enum(["ok", "partial", "error", "paused", "reconnect", "stale", "unknown"]),
  at: z.nullable(z.string()),
  code: z.optional(z.string()),
  failed: z.optional(z.number()),
  remaining: z.optional(z.number()),
  changes: z.optional(
    z.strictObject({
      create: z.number(),
      update: z.number(),
      delete: z.number(),
      unchanged: z.number(),
    }),
  ),
  /**
   * Blocks that the last successful run wanted in the target, inside the rule's sync window. This
   * is the state of that run, not a live count of the calendar. `blocksExact` is true only if the
   * run finished all its work, it is the latest outcome, and the rule still runs.
   */
  blocks: z.nullable(z.number()),
  blocksExact: z.boolean(),
  blocksAt: z.nullable(z.string()),
});
export type RuleStatusView = z.infer<typeof ruleStatusView>;
export const statusAnswer = z.strictObject({
  rules: z.array(ruleStatusView),
  truncated: z.boolean(),
});

function changesOf(detail: Partial<SyncRunDetail>) {
  return {
    create: detail.create ?? 0,
    update: detail.update ?? 0,
    delete: detail.delete ?? 0,
    unchanged: detail.unchanged ?? 0,
  };
}

function ruleStatus(
  rule: { id: string; enabled: boolean; stalled: boolean },
  latest: RecentRun | undefined,
  lastRun: RecentRun | undefined,
  now: number,
): RuleStatusView {
  // An aborted run ended at a platform limit and wrote no result: it counts as a failure.
  const aborted = latest?.kind === "sync_run_aborted";
  const state = !rule.enabled
    ? "paused"
    : rule.stalled
      ? "reconnect"
      : !latest
        ? "unknown"
        : latest.kind === "sync_run_aborted"
          ? "error"
          : statusOf({ ...latest, kind: latest.kind }).state;
  // A sync that stops without an error writes nothing: no failure, no abort. Only age shows it.
  const stale =
    (state === "ok" || state === "partial") &&
    latest !== undefined &&
    now - Date.parse(latest.createdAt) > SILENT_RULE_MS;
  const changes = lastRun ? changesOf(lastRun.detail) : undefined;
  const remaining = latest?.detail.remaining ?? 0;
  const failed = latest?.detail.failed ?? 0;
  return {
    ruleId: rule.id,
    enabled: rule.enabled,
    state: stale ? "stale" : state,
    at: latest?.createdAt ?? null,
    ...(aborted ? { code: "aborted" } : latest?.detail.code ? { code: latest.detail.code } : {}),
    ...(failed > 0 ? { failed } : {}),
    ...(remaining > 0 ? { remaining } : {}),
    ...(changes ? { changes } : {}),
    blocks: changes ? changes.unchanged + changes.create + changes.update : null,
    blocksExact:
      rule.enabled &&
      !rule.stalled &&
      !stale &&
      latest !== undefined &&
      latest === lastRun &&
      latest.kind === "sync_run" &&
      failed === 0 &&
      remaining === 0,
    blocksAt: lastRun?.createdAt ?? null,
  };
}

/** Rows of the audit log that one status call reads at most. */
function runRowLimit(rules: number): number {
  return Math.min(1000, Math.max(100, rules * 10));
}

export async function readSyncStatus(
  db: D1Database,
  userId: string,
  now = Date.now(),
): Promise<z.infer<typeof statusAnswer>> {
  // A rule does not run while its source or target account needs reconnecting: the sync skips it,
  // and writes no audit row that would show it.
  const { results } = await db
    .prepare(
      `SELECT r.id, r.enabled, MAX(sa.needs_reconnect, ta.needs_reconnect) AS stalled
       FROM rules r
       JOIN calendars sc ON sc.id = r.source_calendar_id
       JOIN accounts sa ON sa.id = sc.account_id
       JOIN calendars tc ON tc.id = r.target_calendar_id
       JOIN accounts ta ON ta.id = tc.account_id
       WHERE r.user_id = ? ORDER BY r.rowid LIMIT ?`,
    )
    .bind(userId, MAX_LISTED_RULES + 1)
    .all<{ id: string; enabled: number; stalled: number }>();
  const rules = results.slice(0, MAX_LISTED_RULES);
  const runs = await recentRuleRuns(db, userId, runRowLimit(rules.length));
  const latest = new Map<string, RecentRun>();
  const lastRun = new Map<string, RecentRun>();
  for (const run of runs) {
    if (!latest.has(run.ruleId)) latest.set(run.ruleId, run);
    if (run.kind === "sync_run" && !lastRun.has(run.ruleId)) lastRun.set(run.ruleId, run);
  }
  return {
    truncated: results.length > MAX_LISTED_RULES,
    rules: rules.map((rule) =>
      ruleStatus(
        { id: rule.id, enabled: rule.enabled === 1, stalled: rule.stalled === 1 },
        latest.get(rule.id),
        lastRun.get(rule.id),
        now,
      ),
    ),
  };
}

/**
 * Source calendars that one `list_events` call reads at most. Each costs one Durable Object call of
 * this invocation, so this keeps far below the Free plan's 50 subrequests; the provider pages count
 * on the budget of each account's own instance.
 */
export const MAX_EVENT_CALENDARS = 25;

/**
 * A calendar that `list_events` reads. `remoteId` and `tenantId` serve the read and the detail
 * cap; they never reach an answer.
 */
export interface EventSource {
  calendarId: string;
  calendar: string;
  remoteId: string;
  accountId: string;
  email: string;
  account: string;
  tenantId: string | null;
  needsReconnect: boolean;
}

/** The `accounts` and `calendars` arguments of `list_events`. */
export interface EventSourceFilters {
  accounts?: readonly string[] | undefined;
  calendars?: readonly string[] | undefined;
}

/**
 * LIKE patterns for a filter, or null for no filter. SQLite folds the case of ASCII letters only,
 * so every other character matches any one character. The caller checks each row again with the
 * full case rules; the pattern only has to find every calendar the check accepts.
 */
function likePatterns(values: readonly string[] | undefined): string | null {
  if (!values || values.length === 0) return null;
  return JSON.stringify(
    values.map((value) =>
      // Code points, as SQLite matches `_` against one character.
      Array.from(value.trim())
        .map((char) => {
          if (char === "!" || char === "%" || char === "_") return `!${char}`;
          return char.charCodeAt(0) < 0x80 ? char : "_";
        })
        .join(""),
    ),
  );
}

/**
 * The user's source calendars, the ones the editor reads, and the time zone of the user's first
 * account with working hours. Only calendars that the user turned on as sources are read: a
 * calendar shared with the account, but never chosen, stays out. The filters apply before the
 * limit, so that every calendar the filters name can be read; `truncated` says that more calendars
 * match than one call reads.
 */
export async function readEventSources(
  db: D1Database,
  userId: string,
  filters: EventSourceFilters = {},
): Promise<{ sources: EventSource[]; truncated: boolean; workTimeZone: string | null }> {
  const { results } = await db
    .prepare(
      `SELECT c.id AS calendarId, c.name AS calendar, c.remote_id AS remoteId,
              a.id AS accountId, a.email, COALESCE(a.display_name, a.email) AS account,
              a.tenant_id AS tenantId, a.needs_reconnect AS needsReconnect
       FROM calendars c JOIN accounts a ON a.id = c.account_id
       WHERE a.user_id = ?1 AND c.is_source = 1
         AND (?2 IS NULL OR EXISTS (SELECT 1 FROM json_each(?2) f
              WHERE a.id LIKE f.value ESCAPE '!' OR a.email LIKE f.value ESCAPE '!'))
         AND (?3 IS NULL OR EXISTS (SELECT 1 FROM json_each(?3) f
              WHERE c.name LIKE f.value ESCAPE '!' OR c.id LIKE f.value ESCAPE '!'))
       ORDER BY a.created_at, a.id, c.name, c.id LIMIT ?4`,
    )
    .bind(
      userId,
      likePatterns(filters.accounts),
      likePatterns(filters.calendars),
      MAX_EVENT_CALENDARS + 1,
    )
    .all<Omit<EventSource, "needsReconnect"> & { needsReconnect: number }>();
  // The zone does not depend on the filters, so that a date means the same day with and without.
  const { results: hours } = await db
    .prepare(
      `SELECT a.work_hours AS workHours FROM accounts a
       WHERE a.user_id = ? AND a.work_hours IS NOT NULL
         AND EXISTS (SELECT 1 FROM calendars c WHERE c.account_id = a.id AND c.is_source = 1)
       ORDER BY a.created_at, a.id LIMIT ?`,
    )
    .bind(userId, MAX_EVENT_CALENDARS + 1)
    .all<{ workHours: string }>();
  let workTimeZone: string | null = null;
  for (const row of hours) {
    try {
      const zone = (JSON.parse(row.workHours) as { workTimeZone?: unknown }).workTimeZone;
      if (typeof zone === "string" && zone !== "") {
        workTimeZone = zone;
        break;
      }
    } catch {
      // A stored value that does not parse names no zone.
    }
  }
  return {
    truncated: results.length > MAX_EVENT_CALENDARS,
    workTimeZone,
    sources: results.slice(0, MAX_EVENT_CALENDARS).map((row) => ({
      calendarId: row.calendarId,
      calendar: row.calendar,
      remoteId: row.remoteId,
      accountId: row.accountId,
      email: row.email,
      account: row.account,
      tenantId: row.tenantId,
      needsReconnect: row.needsReconnect === 1,
    })),
  };
}

const eventView = z.strictObject({
  accountId: z.string(),
  /** The account's display name, or its address. */
  account: z.string(),
  calendar: z.string(),
  /** Null if the event is private, or a detail cap of the deployment withholds it. */
  title: z.nullable(z.string()),
  location: z.nullable(z.string()),
  /** ISO 8601 with the offset of the answer's time zone; a date (YYYY-MM-DD) for all-day events. */
  start: z.string(),
  /** Exclusive. For all-day events the day after the last day. */
  end: z.string(),
  allDay: z.boolean(),
  showAs: z.enum(["free", "tentative", "busy", "oof", "workingElsewhere", "unknown"]),
  private: z.boolean(),
  declined: z.boolean(),
  /** One occurrence of a recurring series. */
  recurring: z.boolean(),
  /** A block that slotmirror wrote. Listed only with `includeMirrors`. */
  mirror: z.boolean(),
});
export type EventView = z.infer<typeof eventView>;

const eventReadError = z.strictObject({
  accountId: z.string(),
  calendar: z.string(),
  /**
   * "reconnect": the account needs reconnecting. "throttled": the provider asked to wait. "gone":
   * the provider no longer finds the calendar or lets the account read it. "failed": anything else.
   */
  code: z.enum(["reconnect", "throttled", "gone", "failed"]),
  retryAfterSeconds: z.optional(z.number()),
});
export type EventReadError = z.infer<typeof eventReadError>;

export const eventsAnswer = z.strictObject({
  start: z.string(),
  end: z.string(),
  timeZone: z.string(),
  events: z.array(eventView),
  /** Calendars that could not be read. The events of the other calendars are complete. */
  errors: z.array(eventReadError),
  /** More events matched than one answer lists. */
  truncated: z.boolean(),
  /** The user has more source calendars than one call reads; the rest were not read. */
  calendarsTruncated: z.boolean(),
});
export type EventsAnswer = z.infer<typeof eventsAnswer>;
