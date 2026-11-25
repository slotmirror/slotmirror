import { runQueries, single, type Query } from "./batch";
import { closeAbandonedTombstones } from "./cleanup";
import { GoogleApiError } from "./providers/google-calendar";
import { GraphError } from "./providers/graph-calendar";
import { TokenError } from "./providers/microsoft";
import { parseProviderErrorMessage } from "./sync/throttle";
import { safeCode, safeMessage } from "./error-fields";
import { log } from "./telemetry";

/**
 * The audit log answers "who did what, and did the sync work". It stores IDs, times, counts and
 * codes. Never put event content or tokens into `detail`.
 */
export type AuditKind =
  | "sign_in"
  | "sign_in_refused"
  | "sign_in_reset"
  | "sign_out"
  | "account_connected"
  | "account_disconnected"
  | "account_disconnect_failed"
  | "cleanup_finished"
  | "account_renamed"
  | "token_refresh_failed"
  | "rule_created"
  | "rule_deleted"
  | "rule_enabled"
  | "rule_paused"
  | "rule_updated"
  | "group_changed"
  | "settings_changed"
  | "user_deleted"
  | "sync_run"
  | "sync_failed"
  | "sync_run_aborted"
  | "account_paused"
  | "account_resumed"
  | "alert_sent"
  | "alert_test"
  | "compare_run"
  | "compare_failed"
  | "api_token_created"
  | "api_token_revoked"
  | "mcp_app_connected"
  | "mcp_app_disconnected"
  | "mcp_policy_changed";

/** How the removal of an offboarding ended. */
export type CleanupResult =
  | "removed"
  | "incomplete"
  | "token_refused"
  | "no_tokens"
  | "deadline"
  | "not_started"
  | "kept";

/**
 * Detail of a `cleanup_finished` event. `left` is the count of the last step that could count, or
 * with `estimated`, of the rule's last sync run if no step could.
 */
export type CleanupDetail = {
  result: CleanupResult;
  removed: number;
  left?: number;
  estimated?: true;
};

/** Detail of a `sync_run` event. */
export interface SyncRunDetail {
  /** ID of the run, as in its start marker. A dry run has no marker and no ID. */
  runId?: string;
  dryRun: boolean;
  create: number;
  update: number;
  delete: number;
  unchanged: number;
  /** Extra blocks of a wanted event that the run planned to delete; part of `delete`. */
  duplicates: number;
  applied: number;
  failed: number;
  remaining: number;
  /** Actions the provider throttled; they are part of `remaining`. */
  throttled: number;
  /** Status and reason of failed and throttled actions, e.g. "429 ApplicationThrottled:13". */
  statuses: string;
  /** Edge reads that failed, so blocks at the start of the window stayed; see `planSync`. */
  edgeReadsFailed: number;
  durationMs: number;
}

export interface AuditEvent {
  orgId: string;
  userId?: string | null;
  accountId?: string | null;
  ruleId?: string | null;
  kind: AuditKind;
  detail?: Record<string, string | number | boolean>;
  /** Makes the event unique: a statement that runs again adds no second row. */
  reportId?: string;
}

/** Audit rows older than this many days are deleted by the cron handler. */
export const AUDIT_RETENTION_DAYS = 90;

/** Audit rows that one lookup of a run's outcome reads at most. */
export const RUN_OUTCOME_SCAN_ROWS = 500;

/** A lookup starts this long before a run's start: the instance and D1 have different clocks. */
const RUN_OUTCOME_SKEW_MS = 60_000;

/** Rows shown on an activity page. */
export const ACTIVITY_LIMIT = 100;

/**
 * The insert of one event, for a batch. With `onlyIf` the row is written only if the event's rule
 * exists, for example after an insert that a concurrent request made a no-op, only if the rule
 * runs, or only if no end of the rule's tombstone is stored. An event with a `reportId` that D1 holds
 * already adds no row.
 */
export function auditStatement(
  db: D1Database,
  event: AuditEvent,
  onlyIf?: "rule_exists" | "rule_runs" | "tombstone_not_ended",
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_events (org_id, user_id, account_id, rule_id, kind, detail, report_id)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?8
       WHERE CASE ?7
         WHEN 0 THEN 1
         WHEN 3 THEN NOT EXISTS (SELECT 1 FROM cleanup_tombstones t
           WHERE t.account_id = ?3 AND t.rule_id = ?4 AND t.state <> 'open')
         ELSE EXISTS (SELECT 1 FROM rules WHERE id = ?4 AND (?7 = 1 OR enabled = 1))
       END
       ON CONFLICT DO NOTHING`,
    )
    .bind(
      event.orgId,
      event.userId ?? null,
      event.accountId ?? null,
      event.ruleId ?? null,
      event.kind,
      JSON.stringify(event.detail ?? {}),
      onlyIf === "tombstone_not_ended"
        ? 3
        : onlyIf === "rule_runs"
          ? 2
          : onlyIf === "rule_exists"
            ? 1
            : 0,
      event.reportId ?? null,
    );
}

/** Write one event. Never throws: a broken log must not break a sync or a sign-in. */
export async function recordAudit(db: D1Database, event: AuditEvent): Promise<void> {
  await recordAuditChecked(db, event);
}

/**
 * `recordAudit` for a caller that must know the outcome. Returns true only if D1 reports a new row.
 */
export async function recordAuditChecked(db: D1Database, event: AuditEvent): Promise<boolean> {
  try {
    const { meta } = await auditStatement(db, event).run();
    return meta.changes > 0;
  } catch (error) {
    log.error("audit.write_failed", { auditKind: event.kind }, error);
    return false;
  }
}

/** The start of a run, as far as a lookup of its outcome needs it. */
export interface RunStart {
  ruleId: string;
  runId: string;
  /** Unix ms. */
  startedAt: number;
}

/**
 * The lookup of one run's outcome event. It walks the index on user and time from the start of the
 * run and stops after `RUN_OUTCOME_SCAN_ROWS` rows. If a run's event lies further on, the run
 * counts as without an outcome. A result event follows the start of its run within minutes, and a
 * marker waits at most one tick, unless D1 stays down.
 */
export function runOutcomeStatement(
  db: D1Database,
  userId: string,
  { ruleId, runId, startedAt }: RunStart,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT ?1 AS runId FROM (
         SELECT rule_id, kind, detail FROM audit_events
         WHERE user_id = ?2 AND created_at >= ?3
         ORDER BY created_at
         LIMIT ?4
       )
       WHERE rule_id = ?5
         AND kind IN ('sync_run', 'sync_failed', 'sync_run_aborted')
         AND json_extract(detail, '$.runId') = ?1
       LIMIT 1`,
    )
    .bind(
      runId,
      userId,
      new Date(startedAt - RUN_OUTCOME_SKEW_MS).toISOString(),
      RUN_OUTCOME_SCAN_ROWS,
      ruleId,
    );
}

/** The IDs among `runs` with an outcome event. One batch is one subrequest. Throws on error. */
export async function runsWithOutcome(
  db: D1Database,
  userId: string,
  runs: RunStart[],
): Promise<Set<string>> {
  const results = await db.batch<{ runId: string }>(
    runs.map((run) => runOutcomeStatement(db, userId, run)),
  );
  return new Set(results.flatMap(({ results: rows }) => rows.map((row) => row.runId)));
}

/** A short code for an error, safe to store: no response bodies, no event content. */
export function errorCode(error: unknown): string {
  if (error instanceof TokenError) {
    // The code comes from the token endpoint; only a plain code goes into a log or the audit log.
    return `token_${/^[a-z0-9_]{1,64}$/i.test(error.code) ? error.code : "unknown_error"}`;
  }
  if (error instanceof GraphError) return withReason(`graph_${error.status}`, error.reason);
  if (error instanceof GoogleApiError) return withReason(`google_${error.status}`, error.reason);
  if (error instanceof Error) {
    // Over the Durable Object boundary a subclass becomes a plain Error with its own properties.
    if (error.name === "Error") {
      // A TokenError that crossed the boundary: its message is its code.
      const code = safeCode(error);
      if (code && error.message.startsWith(code)) return `token_${code}`;
      // A provider error that crossed the boundary: the same code as before it crossed.
      const crossed = parseProviderErrorMessage(error.message);
      if (crossed) {
        return withReason(`${crossed.provider.toLowerCase()}_${crossed.status}`, crossed.reason);
      }
      return safeMessage(error) ?? code ?? "Error";
    }
    return error.name;
  }
  return "unknown";
}

function withReason(code: string, reason: string | undefined): string {
  return reason ? `${code}_${reason}` : code;
}

/** The org and user that own an account, or null if the account is gone. */
export async function accountOwner(
  db: D1Database,
  accountId: string,
): Promise<{ orgId: string; userId: string } | null> {
  return db
    .prepare(
      `SELECT u.org_id AS orgId, u.id AS userId FROM accounts a
       JOIN users u ON u.id = a.user_id WHERE a.id = ?`,
    )
    .bind(accountId)
    .first<{ orgId: string; userId: string }>();
}

/** Delete events past the retention period and close abandoned tombstones. One statement. */
export async function purgeAuditEvents<T = unknown>(
  db: D1Database,
  /** Runs in the same D1 step, so that a read of the cron costs no subrequest of its own. */
  alongside?: D1PreparedStatement,
  now: number = Date.now(),
): Promise<T[]> {
  const cutoff = `-${AUDIT_RETENTION_DAYS} days`;
  const answers = await db.batch<T>([
    db
      .prepare(
        `DELETE FROM audit_events
         WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)`,
      )
      .bind(cutoff),
    // A tombstone holds a calendar name of an account that may be gone. Same retention as the log.
    db
      .prepare(
        `DELETE FROM cleanup_tombstones
         WHERE updated_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)`,
      )
      .bind(cutoff),
    ...closeAbandonedTombstones(db, now),
    ...(alongside ? [alongside] : []),
  ]);
  return alongside ? (answers.at(-1)?.results ?? []) : [];
}

export interface ActivityRow {
  id: number;
  kind: AuditKind;
  detail: string;
  createdAt: string;
  /** Set on the org-wide view only. */
  email: string | null;
  /**
   * The connected account, on the rows of the user who reads them only, also in the org view.
   * Admins do not get the address of another person's calendar.
   */
  accountEmail?: string | null;
  /** The rule of the row, on the rows of the user who reads them only, also in the org view. */
  ruleId?: string | null;
  /**
   * The ID of the row's connected account, on the rows of the user who reads them only. It names
   * the calendar of a mirroring also after its account was disconnected and its row is gone.
   */
  accountId?: string | null;
  /**
   * A row outside the page that the list does not show: a later change of a rule of the page,
   * which can end a time in which others saw more (see `activityPage`). Only the viewer's rows.
   */
  context?: boolean;
}

/** The latest events of one user. */
export async function userActivity(
  db: D1Database,
  userId: string,
  limit = ACTIVITY_LIMIT,
): Promise<ActivityRow[]> {
  const { results } = await db
    .prepare(
      `SELECT e.id, e.kind, e.detail, e.created_at AS createdAt, NULL AS email,
              a.email AS accountEmail, e.rule_id AS ruleId, e.account_id AS accountId
       FROM audit_events e LEFT JOIN accounts a ON a.id = e.account_id
       WHERE e.user_id = ? ORDER BY e.created_at DESC, e.id DESC LIMIT ?`,
    )
    .bind(userId, limit)
    .all<ActivityRow>();
  return results;
}

/** The latest events of an org, with the email of the user they belong to. */
export async function orgActivity(
  db: D1Database,
  orgId: string,
  limit = ACTIVITY_LIMIT,
): Promise<ActivityRow[]> {
  const { results } = await db
    .prepare(
      `SELECT e.id, e.kind, e.detail, e.created_at AS createdAt, u.email
       FROM audit_events e LEFT JOIN users u ON u.id = e.user_id
       WHERE e.org_id = ? ORDER BY e.created_at DESC, e.id DESC LIMIT ?`,
    )
    .bind(orgId, limit)
    .all<ActivityRow>();
  return results;
}

/** Rows per page of the activity page. */
export const ACTIVITY_PAGE_SIZE = 50;

/** Rows that one filtered activity query reads at most, whatever the filter matches. */
export const ACTIVITY_SCAN_ROWS = 1000;

/** The type filter of the activity page. */
export const ACTIVITY_GROUPS = ["sync", "changes", "problems"] as const;
export type ActivityGroup = (typeof ACTIVITY_GROUPS)[number];

/** Events that a user changed on purpose: mirrorings, settings and calendars. */
const CHANGE_KINDS: readonly AuditKind[] = [
  "rule_created",
  "rule_deleted",
  "rule_enabled",
  "rule_paused",
  "rule_updated",
  "group_changed",
  "settings_changed",
  "account_renamed",
  "account_connected",
  "account_disconnected",
];

/** Changes of one rule: their rows name the rule, and since the field exists its source account. */
const RULE_KINDS: readonly AuditKind[] = [
  "rule_created",
  "rule_deleted",
  "rule_enabled",
  "rule_paused",
  "rule_updated",
];

/** Runs that did not finish, checks that failed, and calendars that need a reconnect. */
const PROBLEM_KINDS: readonly AuditKind[] = [
  "sync_failed",
  "sync_run_aborted",
  "token_refresh_failed",
  "account_paused",
  "account_disconnect_failed",
  "compare_failed",
];

/** Conditions on the rows of the inner query, which the activity query names `s`. */
const GROUP_SQL: Record<ActivityGroup, string> = {
  sync: "s.kind IN ('sync_run', 'sync_failed', 'sync_run_aborted')",
  changes: `s.kind IN (${CHANGE_KINDS.map((kind) => `'${kind}'`).join(", ")})`,
  // A partial run is a finished run with failed changes.
  problems: `(s.kind IN (${PROBLEM_KINDS.map((kind) => `'${kind}'`).join(", ")})
    OR (s.kind = 'sync_run' AND COALESCE(json_extract(s.detail, '$.failed'), 0) > 0))`,
};

/** The type filter value in a URL, or undefined if it is absent or unknown. */
export function parseActivityGroup(value: string | undefined): ActivityGroup | undefined {
  return ACTIVITY_GROUPS.find((group) => group === value);
}

export interface ActivityFilter {
  group?: ActivityGroup;
  /** Rows of these rules only. An empty list matches no row. */
  ruleIds?: readonly string[];
  /** Rows of this connected account, in addition to those of `ruleIds` if both are given. */
  accountId?: string;
  /**
   * Also the changes of rules from `from`, into `to`, or both, also of rules that are gone: a
   * save that turned a mirroring off deleted them, so `ruleIds` cannot name them. Every `rule_*`
   * row holds the source as `fromAccount` and the target as its account (`src/editor.ts`). Rows
   * from before that field match through `ruleIds` and `accountId` only.
   */
  turnedOff?: { from?: string; to?: string };
  /** Rows older than the row with this ID in the order `created_at DESC, id DESC`. */
  before?: number;
}

export interface ActivityPage {
  rows: ActivityRow[];
  /** The `before` value of the next older page; null if nothing older matches in the scan. */
  older: number | null;
}

/**
 * Whose rows a page reads. The org view names the calendar and the rule only on the rows of
 * `viewerId`: those are the viewer's own, which the editor state can name. Other people's
 * addresses and rules stay out of the result.
 */
type ActivityScope = { userId: string } | { orgId: string; viewerId?: string };

/**
 * The SQL of the main query of `activityPage` and its bound values, in the order of the `?`.
 * Exported for the query-plan test. A list of rule IDs is one bound value (a JSON array read by
 * `json_each`), because D1 allows 100 bound parameters per query and a user can have more rules.
 */
export function activityPageQuery(
  scope: ActivityScope,
  filter: ActivityFilter,
  limit: number,
): { sql: string; binds: (string | number)[]; filtered: boolean; scanRows: number } {
  const ofUser = "userId" in scope;
  const column = ofUser ? "user_id" : "org_id";
  const id = ofUser ? scope.userId : scope.orgId;
  const conditions: string[] = [];
  const binds: (string | number)[] = [];
  if (filter.group) conditions.push(GROUP_SQL[filter.group]);
  const ends: string[] = [];
  if (filter.ruleIds && (filter.accountId === undefined || filter.ruleIds.length > 0)) {
    if (filter.ruleIds.length > 0) {
      ends.push("s.rule_id IN (SELECT value FROM json_each(?))");
      binds.push(JSON.stringify(filter.ruleIds));
    } else {
      ends.push("0");
    }
  }
  if (filter.accountId !== undefined) {
    ends.push("s.account_id = ?");
    binds.push(filter.accountId);
  }
  if (filter.turnedOff && (filter.turnedOff.from || filter.turnedOff.to)) {
    const off = [
      `s.kind IN (${RULE_KINDS.map((kind) => `'${kind}'`).join(", ")})`,
      "json_extract(s.detail, '$.fromAccount') IS NOT NULL",
    ];
    if (filter.turnedOff.from) {
      off.push("json_extract(s.detail, '$.fromAccount') = ?");
      binds.push(filter.turnedOff.from);
    }
    if (filter.turnedOff.to) {
      off.push("s.account_id = ?");
      binds.push(filter.turnedOff.to);
    }
    ends.push(`(${off.join(" AND ")})`);
  }
  if (ends.length > 0) conditions.push(`(${ends.join(" OR ")})`);
  const filtered = conditions.length > 0;
  const scanRows = filtered ? ACTIVITY_SCAN_ROWS : limit + 1;
  const cursor =
    filter.before === undefined
      ? ""
      : `AND (created_at, id) < (SELECT created_at, id FROM audit_events WHERE id = ? AND ${column} = ?)`;
  const cursorBinds = filter.before === undefined ? [] : [filter.before, id];
  const viewer = "viewerId" in scope ? scope.viewerId : undefined;
  const join = ofUser
    ? "LEFT JOIN accounts a ON a.id = s.account_id"
    : viewer === undefined
      ? "LEFT JOIN users u ON u.id = s.user_id"
      : "LEFT JOIN users u ON u.id = s.user_id LEFT JOIN accounts a ON a.id = s.account_id";
  const select = ofUser
    ? "NULL AS email, a.email AS accountEmail, s.rule_id AS ruleId, s.account_id AS accountId"
    : viewer === undefined
      ? "u.email AS email"
      : `u.email AS email, CASE WHEN s.user_id = ? THEN a.email END AS accountEmail,
         CASE WHEN s.user_id = ? THEN s.rule_id END AS ruleId,
         CASE WHEN s.user_id = ? THEN s.account_id END AS accountId`;
  const selectBinds = !ofUser && viewer !== undefined ? [viewer, viewer, viewer] : [];
  const sql = `SELECT s.id, s.kind, s.detail, s.created_at AS createdAt, ${select}
       FROM (
         SELECT id, kind, detail, created_at, rule_id, account_id, user_id FROM audit_events
         WHERE ${column} = ? ${cursor}
         ORDER BY created_at DESC, id DESC LIMIT ?
       ) s ${join}
       ${filtered ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY s.created_at DESC, s.id DESC LIMIT ?`;
  return {
    sql,
    binds: [...selectBinds, id, ...cursorBinds, scanRows, ...binds, limit + 1],
    filtered,
    scanRows,
  };
}

/**
 * One page of activity, newest first. The inner query reads rows through `audit_events_user_created`
 * or `audit_events_org_created` in the order of the page, from the cursor on, and stops at
 * `ACTIVITY_SCAN_ROWS` (the page size plus one without a filter). The filters apply to these rows
 * only, because `kind`, `rule_id` and `account_id` have no index of their own: a rare match must
 * not read the whole retention period. If the scan ends before the page is full, `older` points at
 * the last row read, so the next page continues there.
 */
async function activityPage(
  db: D1Database,
  scope: ActivityScope,
  filter: ActivityFilter,
  limit: number,
): Promise<ActivityPage> {
  const ofUser = "userId" in scope;
  const column = ofUser ? "user_id" : "org_id";
  const id = ofUser ? scope.userId : scope.orgId;
  const { sql, binds, filtered } = activityPageQuery(scope, filter, limit);
  const cursor =
    filter.before === undefined
      ? ""
      : `AND (created_at, id) < (SELECT created_at, id FROM audit_events WHERE id = ? AND ${column} = ?)`;
  const cursorBinds = filter.before === undefined ? [] : [filter.before, id];
  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all<ActivityRow>();
  const rows = results.slice(0, limit);
  const later = await laterRuleRows(db, scope, filter, rows);
  const page = (older: number | null) => ({ rows: [...later, ...rows], older });
  if (results.length > limit) return page(rows.at(-1)?.id ?? null);
  if (!filtered) return page(null);
  // Fewer matches than a page. If the scan was cut short, older rows may still match.
  const edge = await db
    .prepare(
      `SELECT id FROM audit_events WHERE ${column} = ? ${cursor}
       ORDER BY created_at DESC, id DESC LIMIT 2 OFFSET ?`,
    )
    .bind(id, ...cursorBinds, ACTIVITY_SCAN_ROWS - 1)
    .all<{ id: number }>();
  const [last, beyond] = edge.results;
  return page(last && beyond ? last.id : null);
}

/**
 * On an older page, the changes of the page's rules that came after its newest row, as context
 * rows: a turn off on a newer page ends a time in which others saw more that started here. Only
 * the viewer's own rows (the org view names no other person's rules). The read walks
 * `audit_events_user_created` forward from the page and stops at `ACTIVITY_SCAN_ROWS`; a page
 * without a change of a rule reads nothing.
 */
async function laterRuleRows(
  db: D1Database,
  scope: ActivityScope,
  filter: ActivityFilter,
  rows: ActivityRow[],
): Promise<ActivityRow[]> {
  const viewer = "userId" in scope ? scope.userId : scope.viewerId;
  const newest = rows[0];
  if (filter.before === undefined || viewer === undefined || !newest) return [];
  const ruleIds = [
    ...new Set(
      rows.flatMap((row) => (RULE_KINDS.includes(row.kind) && row.ruleId ? [row.ruleId] : [])),
    ),
  ];
  if (ruleIds.length === 0) return [];
  const { results } = await db
    .prepare(
      `SELECT s.id, s.kind, s.detail, s.created_at AS createdAt, NULL AS email,
              a.email AS accountEmail, s.rule_id AS ruleId, s.account_id AS accountId
       FROM (
         SELECT id, kind, detail, created_at, rule_id, account_id FROM audit_events
         WHERE user_id = ?1 AND (created_at, id) > (?2, ?3)
         ORDER BY created_at ASC, id ASC LIMIT ?4
       ) s LEFT JOIN accounts a ON a.id = s.account_id
       WHERE s.kind IN (${RULE_KINDS.map((kind) => `'${kind}'`).join(", ")})
         AND s.rule_id IN (SELECT value FROM json_each(?5))
       ORDER BY s.created_at DESC, s.id DESC`,
    )
    .bind(viewer, newest.createdAt, newest.id, ACTIVITY_SCAN_ROWS, JSON.stringify(ruleIds))
    .all<ActivityRow>();
  return results.map((row) => ({ ...row, context: true }));
}

/** One page of the events of one user, with the filters and the cursor of the activity page. */
export function userActivityPage(
  db: D1Database,
  userId: string,
  filter: ActivityFilter = {},
  limit = ACTIVITY_PAGE_SIZE,
): Promise<ActivityPage> {
  return activityPage(db, { userId }, filter, limit);
}

/**
 * One page of the events of an org. With `viewerId`, the rows of that user carry their calendar
 * address and rule, so that the page can name the viewer's own mirrorings; the mirroring and
 * calendar filters then match the viewer's own rules and calendars.
 */
export function orgActivityPage(
  db: D1Database,
  orgId: string,
  filter: ActivityFilter = {},
  limit = ACTIVITY_PAGE_SIZE,
  viewerId?: string,
): Promise<ActivityPage> {
  const scoped = viewerId === undefined ? { group: filter.group, before: filter.before } : filter;
  return activityPage(db, viewerId === undefined ? { orgId } : { orgId, viewerId }, scoped, limit);
}

/** Calendars per mode that the admin page shows the last comparison of. */
export const COMPARE_LIMIT = 20;

/**
 * The latest comparison per calendar and mode of an org. Its own query: hourly `sync_run` rows push
 * a comparison out of the rows of `orgActivity`. The limit applies per mode: there are more daily
 * comparisons than full ones, and they must not push the full ones out. It reads the org's rows of
 * the retention period through `audit_events_org_created`, once per view of the admin page.
 */
export async function latestCompares(
  db: D1Database,
  orgId: string,
  limit = COMPARE_LIMIT,
): Promise<ActivityRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, kind, detail, createdAt, email FROM (
         SELECT e.id, e.kind, e.detail, e.created_at AS createdAt, a.email,
                ROW_NUMBER() OVER (
                  PARTITION BY json_extract(e.detail, '$.mode')
                  ORDER BY e.created_at DESC, e.id DESC) AS position
         FROM audit_events e LEFT JOIN accounts a ON a.id = e.account_id
         WHERE e.id IN (
           SELECT MAX(id) FROM audit_events
           WHERE org_id = ? AND kind IN ('compare_run', 'compare_failed')
           GROUP BY account_id, json_extract(detail, '$.calendarId'),
                    json_extract(detail, '$.mode')))
       WHERE position <= ? ORDER BY createdAt DESC, id DESC`,
    )
    .bind(orgId, limit)
    .all<ActivityRow>();
  return results;
}

/** The latest finished (non-dry) run or failure of one rule. */
export interface RuleOutcome {
  ruleId: string;
  accountId: string | null;
  kind: "sync_run" | "sync_failed";
  createdAt: string;
  /** False if the rule is paused or turned off; its outcome is history, not the current state. */
  enabled: boolean;
  detail: Partial<SyncRunDetail> & { code?: string };
}

/**
 * Latest outcome per rule of a user. Dry runs do not count: they write nothing. Only rules that
 * still exist count, so that a deleted rule does not keep a failure on the pages until the log
 * purges it. Outcomes of paused rules carry `enabled: false`.
 */
export async function latestRuleOutcomes(db: D1Database, userId: string): Promise<RuleOutcome[]> {
  const [outcomes] = await runQueries(db, [ruleOutcomesQuery(db, userId)]);
  return outcomes;
}

export function parseDetail(json: string): RuleOutcome["detail"] {
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === "object" && value !== null ? value : {};
  } catch {
    return {};
  }
}

/** One run or failure of a rule, as `recentRuleRuns` reads it. */
/** A run, a failure, or a run that the platform stopped at its CPU or subrequest limit. */
export interface RecentRun {
  ruleId: string;
  kind: "sync_run" | "sync_failed" | "sync_run_aborted";
  createdAt: string;
  detail: Partial<SyncRunDetail> & { code?: string };
}

/**
 * The runs and failures among the newest `limit` audit rows of a user, newest first, without dry
 * runs. Unlike `latestRuleOutcomes`, which reads every audit row of the user, this stops at `limit`:
 * an API client can call it in a loop, and D1 refuses every query of the deployment at its daily
 * limit of rows read. The limit sits in the subquery because a LIMIT on the outer query counts
 * matches, not rows read. A rule that ran only before these rows does not appear.
 */
export async function recentRuleRuns(
  db: D1Database,
  userId: string,
  limit: number,
): Promise<RecentRun[]> {
  const { results } = await db
    .prepare(
      `SELECT rule_id AS ruleId, kind, created_at AS createdAt, detail FROM (
         SELECT id, rule_id, kind, created_at, detail FROM audit_events
         WHERE user_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?
       )
       WHERE rule_id IS NOT NULL AND kind IN ('sync_run', 'sync_failed', 'sync_run_aborted')
       ORDER BY created_at DESC, id DESC`,
    )
    .bind(userId, limit)
    .all<Omit<RecentRun, "detail"> & { detail: string }>();
  return results
    .map((row) => ({ ...row, detail: parseDetail(row.detail) }))
    .filter((row) => !row.detail.dryRun);
}

/** What the accounts page shows for one account. */
export interface AccountSyncStatus {
  /** "paused": every rule into the account that ever ran is paused or turned off. */
  state: "ok" | "partial" | "error" | "paused";
  at: string;
  /** Error code of a failed run. */
  code?: string;
  /** Changes that failed in the last run. */
  failed?: number;
}

const STATE_RANK = { paused: -1, ok: 0, partial: 1, error: 2 } as const;

/**
 * The status of each target account from the latest outcome of each of its rules. The worst
 * state wins, so one broken rule is not hidden by a healthy one. Ties go to the newer event. An
 * account whose rules are all paused shows as paused, with the time of the newest run; the
 * outcome of a paused rule says nothing about the current state.
 */
export function accountStatuses(outcomes: RuleOutcome[]): Map<string, AccountSyncStatus> {
  const statuses = new Map<string, AccountSyncStatus>();
  for (const outcome of outcomes) {
    if (!outcome.accountId) continue;
    if (!outcome.enabled) {
      const current = statuses.get(outcome.accountId);
      if (!current || (current.state === "paused" && outcome.createdAt > current.at)) {
        statuses.set(outcome.accountId, { state: "paused", at: outcome.createdAt });
      }
      continue;
    }
    const status = statusOf(outcome);
    const current = statuses.get(outcome.accountId);
    const worse =
      !current ||
      STATE_RANK[status.state] > STATE_RANK[current.state] ||
      (status.state === current.state && status.at > current.at);
    if (worse) statuses.set(outcome.accountId, status);
  }
  return statuses;
}

export function statusOf(
  outcome: Pick<RuleOutcome, "kind" | "createdAt" | "detail">,
): AccountSyncStatus {
  const at = outcome.createdAt;
  if (outcome.kind === "sync_failed") return { state: "error", at, code: outcome.detail.code };
  const failed = outcome.detail.failed ?? 0;
  if (failed > 0) return { state: "error", at, failed };
  if ((outcome.detail.remaining ?? 0) > 0) return { state: "partial", at };
  return { state: "ok", at };
}

/** Audit rows that the overview's "changes in the last 24 hours" reads at most. */
export const RECENT_CHANGES_SCAN_ROWS = 500;

/** The window of the overview's changes list. */
export const RECENT_CHANGES_WINDOW_MS = 24 * 60 * 60_000;

/** What the overview shows of the last 24 hours, and how much of the window the read covered. */
export interface RecentChanges {
  /** Runs that created, updated, removed or failed something, and changes the user made. */
  rows: ActivityRow[];
  /** Rows read. If it equals the scan limit, rows older than `oldest` were not read. */
  scanned: number;
  /** Time of the oldest row read; null if the window holds no row. */
  oldest: string | null;
  /** The scan limit of the read. */
  limit: number;
  /** Start of the window: rows from this time on were asked for. */
  since: string;
}

/**
 * The changes of one user in the `RECENT_CHANGES_WINDOW_MS` before `now`, newest first: finished runs (not dry runs) that created,
 * updated, removed or failed at least one block, and the changes a user makes on purpose (see
 * `CHANGE_KINDS`). Runs without a change are left out; every rule writes one each hour.
 *
 * The scan reads at most `RECENT_CHANGES_SCAN_ROWS` rows through `audit_events_user_created`,
 * in one statement. The one-row `m` keeps the counts of the scan even when no row matches, so that
 * the page can tell "nothing changed" from "not everything was read".
 */
export async function recentChanges(
  db: D1Database,
  userId: string,
  now: number,
  limit = RECENT_CHANGES_SCAN_ROWS,
): Promise<RecentChanges> {
  const [changes] = await runQueries(db, [recentChangesQuery(db, userId, now, limit)]);
  return changes;
}

// Queries for the one-batch page loads (see `src/batch.ts`). They hold the statements of the reads
// of the same name above, which run them alone, so that a page can run them in one batch.

/** `latestRuleOutcomes` as a query for a batch; the function runs this query alone. */
export function ruleOutcomesQuery(db: D1Database, userId: string): Query<RuleOutcome[]> {
  const statement = db
    .prepare(
      `SELECT e.rule_id AS ruleId, e.account_id AS accountId, e.kind, e.created_at AS createdAt,
              e.detail, r.enabled
       FROM audit_events e JOIN rules r ON r.id = e.rule_id AND r.user_id = ?
       WHERE e.id IN (
         SELECT MAX(id) FROM audit_events
         WHERE user_id = ? AND rule_id IS NOT NULL AND kind IN ('sync_run', 'sync_failed')
           AND COALESCE(json_extract(detail, '$.dryRun'), 0) = 0
         GROUP BY rule_id)`,
    )
    .bind(userId, userId);
  return single(statement, (result) =>
    (
      result.results as (Omit<RuleOutcome, "detail" | "enabled"> & {
        detail: string;
        enabled: number;
      })[]
    ).map((row) => ({ ...row, enabled: row.enabled === 1, detail: parseDetail(row.detail) })),
  );
}

/** `recentChanges` as a query for a batch; the function runs this query alone. */
export function recentChangesQuery(
  db: D1Database,
  userId: string,
  now: number,
  limit = RECENT_CHANGES_SCAN_ROWS,
): Query<RecentChanges> {
  const since = new Date(now - RECENT_CHANGES_WINDOW_MS).toISOString();
  const changeKinds = CHANGE_KINDS.map((kind) => `'${kind}'`).join(", ");
  const statement = db
    .prepare(
      `WITH s AS (
         SELECT id, kind, detail, created_at, rule_id, account_id FROM audit_events
         WHERE user_id = ?1 AND created_at >= ?2
         ORDER BY created_at DESC, id DESC
         LIMIT ?3
       ),
       m AS (SELECT COUNT(*) AS scanned, MIN(created_at) AS oldest FROM s)
       SELECT m.scanned, m.oldest, x.id, x.kind, x.detail, x.createdAt, x.accountEmail, x.ruleId,
              x.accountId
       FROM m LEFT JOIN (
         SELECT s.id, s.kind, s.detail, s.created_at AS createdAt, a.email AS accountEmail,
                s.rule_id AS ruleId, s.account_id AS accountId
         FROM s LEFT JOIN accounts a ON a.id = s.account_id
         WHERE s.kind IN (${changeKinds})
            OR (s.kind = 'sync_run'
                AND COALESCE(json_extract(s.detail, '$.dryRun'), 0) = 0
                AND COALESCE(json_extract(s.detail, '$.create'), 0)
                  + COALESCE(json_extract(s.detail, '$.update'), 0)
                  + COALESCE(json_extract(s.detail, '$.delete'), 0)
                  + COALESCE(json_extract(s.detail, '$.failed'), 0) > 0)
       ) x ON 1
       ORDER BY x.createdAt DESC, x.id DESC`,
    )
    .bind(userId, since, limit);
  return single(statement, (result) => {
    const results = result.results as ({ scanned: number; oldest: string | null } & {
      [K in keyof ActivityRow]: ActivityRow[K] | null;
    })[];
    const first = results[0];
    const rows: ActivityRow[] = [];
    for (const row of results) {
      if (row.id === null || row.kind === null || row.createdAt === null) continue;
      rows.push({
        id: row.id,
        kind: row.kind,
        detail: row.detail ?? "{}",
        createdAt: row.createdAt,
        email: null,
        accountEmail: row.accountEmail ?? null,
        accountId: row.accountId ?? null,
        ruleId: row.ruleId ?? null,
      });
    }
    return { rows, scanned: first?.scanned ?? 0, oldest: first?.oldest ?? null, limit, since };
  });
}
