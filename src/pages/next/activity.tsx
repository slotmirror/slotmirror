import { appPath } from "../../app-base";
import {
  ACTIVITY_SCAN_ROWS,
  AUDIT_RETENTION_DAYS,
  parseDetail,
  type ActivityRow,
  type RuleOutcome,
} from "../../audit";
import type { EditorState } from "../../editor";
import { useI18n, type I18n, type Messages } from "../../i18n";
import type { CurrentUser } from "../../users";
import { activityHref, type ActivityQuery } from "./activity-link";
import { EmptyState, ListGroup, StatusDot } from "./components";
import { CalendarSwatch } from "./identity";
import {
  changesLevel,
  clockFor,
  describeActivity,
  describeChanges,
  levelChangeCount,
  copiesLeftText,
  currentLevels,
  levelStep,
  timedStepOf,
  type Clock,
  type CurrentLevel,
  type DescribedActivity,
  type TimedStep,
} from "./describe";
import { navAttention } from "./run-status";
import { Shell } from "./shell";

export interface ActivityProps {
  user: CurrentUser;
  state: EditorState;
  /** The latest outcome per rule, for the Mirroring dot. */
  outcomes: RuleOutcome[];
  /** One page of events, newest first. */
  rows: ActivityRow[];
  /** The cursor of the next older page, or null. */
  older: number | null;
  /** The filters that the route accepted. */
  query: ActivityQuery;
  /** The user may switch to the view of the whole organisation. */
  canViewOrg: boolean;
}

// Time and day -------------------------------------------------------------------------------------

interface Formats {
  time: Intl.DateTimeFormat;
  weekday: Intl.DateTimeFormat;
  weekdayYear: Intl.DateTimeFormat;
  parts: Intl.DateTimeFormat;
}

/** Formatters per locale and time zone, built once per isolate: Intl setup costs CPU time. */
const formats = new Map<string, Formats>();

function formatsFor(locale: string, timeZone: string): Formats {
  const key = `${locale}|${timeZone}`;
  let known = formats.get(key);
  if (!known) {
    known = {
      time: new Intl.DateTimeFormat(locale, {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZone,
      }),
      weekday: new Intl.DateTimeFormat(locale, {
        weekday: "long",
        day: "numeric",
        month: "long",
        timeZone,
      }),
      weekdayYear: new Intl.DateTimeFormat(locale, {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone,
      }),
      parts: new Intl.DateTimeFormat("en-US", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        timeZone,
      }),
    };
    formats.set(key, known);
  }
  return known;
}

/** The calendar day of a time in the display zone, as "2026-11-17". */
function dayKey(format: Intl.DateTimeFormat, time: Date): string {
  const parts = Object.fromEntries(
    format.formatToParts(time).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** The day before a "YYYY-MM-DD" key. Plain calendar arithmetic, so a 23 or 25 hour day is safe. */
function previousDay(key: string): string {
  const [year = 0, month = 1, day = 1] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

// Grouping -----------------------------------------------------------------------------------------

/**
 * One row of the list: an event, several runs of one mirroring that changed nothing, or several
 * changes of one mirroring.
 */
export interface ActivityItem {
  key: string;
  described: DescribedActivity;
  email: string | null;
  /** Newest time; the row shows this one. */
  at: string;
  /** Oldest time of the joined rows. Equal to `at` for a single event. */
  first: string;
  count: number;
  /** Set on an item that the same event can join: its kind, title and detail. */
  sameKey?: string;
  /**
   * What the joined rows are. A runs row opens as a list of its runs; "same" joins the same event
   * of the same subject that follows itself, such as a calendar renamed again and again.
   */
  join: "runs" | "changes" | "same" | null;
  /** The joined runs, newest first, with their duration if the row records one. */
  runs: { at: string; durationMs: number | undefined }[];
  /** The joined changes of a mirroring (level or details), newest first. */
  changes: ActivityRow[];
  /** False if the row above in the same day shows the same minute: the time column stays blank. */
  showTime: boolean;
}

export interface ActivityDay {
  key: string;
  heading: string;
  items: ActivityItem[];
}

/**
 * Rows under day headings, newest first. Runs of one mirroring that changed nothing join into one
 * item, as long as no other event of that mirroring lies between them: a run that changed
 * something, a failure or a setting change ends the chain. Events of other mirrorings between
 * them do not, because several mirrorings run in the same minutes. A chain never crosses a day.
 *
 * Changes of one mirroring join too, in two chains that never mix: level changes (added, changed,
 * turned off) and changes of the details only (working hours, colour, categories, buffer). The
 * item shows each time in which others saw more, then the delta from the oldest level to the
 * newest, and the range of minutes. One save writes a row per rule, and every save starts a run,
 * so runs of the mirroring do not end a chain; a pause or a turn on of the mirroring ends both.
 *
 * A time in which others saw more ends where the data ends it: a turn off in a newer row, also in
 * another item or in a context row of a newer page (`ActivityRow.context`), gives the older item
 * its end. Context rows are not shown.
 *
 * `mirroring` is the filter of the list (`<from>~<to>`): its rows do not repeat its name.
 */
export function groupActivity(
  rows: ActivityRow[],
  state: EditorState,
  i18n: I18n,
  now = Date.now(),
  mirroring?: string,
): ActivityDay[] {
  const { t } = i18n;
  const format = formatsFor(i18n.locale, i18n.timeZone);
  const clock = clockFor(i18n);
  const cleanups = cleanupCounts(rows);
  const later = laterSteps(rows);
  const current = currentLevels(state);
  const today = dayKey(format.parts, new Date(now));
  const yesterday = previousDay(today);
  const days: ActivityDay[] = [];
  let open = new Map<string, ActivityItem>();
  let lastMinute = "";
  for (const row of rows) {
    if (row.context) continue;
    const time = new Date(row.createdAt);
    const key = dayKey(format.parts, time);
    let day = days.at(-1);
    if (!day || day.key !== key) {
      const heading =
        key === today
          ? t.next.activity.today
          : key === yesterday
            ? t.next.activity.yesterday
            : key.slice(0, 4) === today.slice(0, 4)
              ? format.weekday.format(time)
              : format.weekdayYear.format(time);
      day = { key, heading, items: [] };
      days.push(day);
      open = new Map();
      lastMinute = "";
    }
    const described = describeActivity(row, state, t, {
      clock,
      mirroring,
      later: later([row]),
      current,
    });
    // The rule names the mirroring; without it the title does.
    const chain = row.ruleId ?? `${row.email ?? ""}|${described.title}`;
    const known = open.get(chain);
    if (described.quiet && known) {
      known.first = row.createdAt;
      known.count++;
      known.join = "runs";
      known.runs.push({ at: row.createdAt, durationMs: described.durationMs });
      continue;
    }
    // Changes chain per mirroring, over all its rules, and per user in the org view. Level changes
    // and detail changes have chains of their own.
    const route = described.route;
    const routeKey = route ? `${row.email ?? ""}|${route.from.id}~${route.to.id}` : null;
    const level = changesLevel(row);
    const isChange = routeKey !== null && (row.kind === "rule_updated" || levelStep(row) !== null);
    const changeChain = isChange ? `change|${level ? "level" : "details"}|${routeKey}` : null;
    if (changeChain) {
      const joined = open.get(changeChain);
      if (joined) {
        joined.first = row.createdAt;
        joined.count++;
        joined.join = "changes";
        joined.changes.push(row);
        joined.described = {
          ...joined.described,
          detail: changesDetail(joined, i18n, clock, cleanups, later(joined.changes), current),
        };
        continue;
      }
    } else if (routeKey && row.kind.startsWith("rule_")) {
      open.delete(`change|level|${routeKey}`);
      open.delete(`change|details|${routeKey}`);
    }
    // The same event of one subject joins, with a count, across the events of other subjects; a
    // different event of the same subject ends the chain. Runs and changes never take part.
    const same = changeChain ? null : sameEvent(row, described);
    const sameChain = same ? `same|${row.email ?? ""}|${same.subject}` : null;
    const repeated = sameChain ? open.get(sameChain) : undefined;
    if (same && repeated?.sameKey === same.key) {
      repeated.first = row.createdAt;
      repeated.count++;
      repeated.join = "same";
      continue;
    }
    const minute = format.time.format(time);
    const removed = changeChain ? removedAfterOff([row], cleanups, t) : "";
    const item: ActivityItem = {
      key: String(row.id),
      described: removed
        ? { ...described, detail: [described.detail, removed].filter(Boolean).join(" · ") }
        : described,
      email: row.email,
      at: row.createdAt,
      first: row.createdAt,
      count: 1,
      join: null,
      runs: [{ at: row.createdAt, durationMs: described.durationMs }],
      changes: changeChain ? [row] : [],
      showTime: minute !== lastMinute,
    };
    lastMinute = minute;
    day.items.push(item);
    if (same && sameChain) {
      item.sameKey = same.key;
      open.set(sameChain, item);
    }
    if (described.quiet) open.set(chain, item);
    else open.delete(chain);
    if (changeChain) open.set(changeChain, item);
  }
  return days;
}

/**
 * What a row is about and what it says, for joining the same event (see `groupActivity`): the
 * subject is its calendar or mirroring, the key its kind, title and detail. Null for runs and
 * changes of a mirroring, which have their own joining.
 */
function sameEvent(
  row: ActivityRow,
  described: DescribedActivity,
): { subject: string; key: string } | null {
  if (row.kind === "sync_run" || row.kind === "rule_updated") return null;
  const subject = described.route
    ? `${described.route.from.id}~${described.route.to.id}`
    : described.account
      ? `@${described.account.id}`
      : "";
  return { subject, key: `${row.kind}|${described.title}|${described.detail}` };
}

/**
 * The detail of joined changes: what others could see and when, the delta, the copies removed
 * after a turn off, and how many saves in which minutes. A save writes a row per rule: level rows
 * count the saves that changed the level, detail rows the distinct seconds.
 */
function changesDetail(
  item: ActivityItem,
  i18n: I18n,
  clock: Clock,
  cleanups: Map<string, number>,
  later: TimedStep[],
  current: CurrentLevel,
): string {
  const { t } = i18n;
  const route = item.described.route;
  const parts = [
    describeChanges(item.changes, t, clock, later, { current, target: route?.to.name }),
  ];
  const left = route ? copiesLeftText(item.changes, route.to.name, t, later) : "";
  if (left && !parts.some((part) => part.includes(left))) parts.push(left);
  const removed = removedAfterOff(item.changes, cleanups, t);
  if (removed) parts.push(removed);
  const levelSaves = levelChangeCount(item.changes).count;
  const saves =
    levelSaves > 0
      ? levelSaves
      : new Set(item.changes.map((row) => row.createdAt.slice(0, 19))).size;
  if (saves >= 2) parts.push(t.next.activity.row.changes(saves, clock(item.first), clock(item.at)));
  return parts.join(" · ");
}

/**
 * For rows of a list (newest first, context rows included), a function that gives the later steps
 * of the rules of some of its rows, oldest first: the steps of newer rows of the same rules that
 * are not among them. Each rule counts from its newest row among them.
 */
function laterSteps(rows: ActivityRow[]): (of: ActivityRow[]) => TimedStep[] {
  const byRule = new Map<string, { index: number; step: TimedStep }[]>();
  const indexOf = new Map<ActivityRow, number>();
  rows.forEach((row, index) => {
    indexOf.set(row, index);
    const step = row.ruleId ? timedStepOf(row) : null;
    if (!step) return;
    byRule.set(step.ruleId, [...(byRule.get(step.ruleId) ?? []), { index, step }]);
  });
  return (of) => {
    const newest = new Map<string, number>();
    for (const row of of) {
      const index = indexOf.get(row);
      if (!row.ruleId || index === undefined) continue;
      newest.set(row.ruleId, Math.min(newest.get(row.ruleId) ?? index, index));
    }
    const found: { index: number; step: TimedStep }[] = [];
    for (const [ruleId, index] of newest) {
      for (const entry of byRule.get(ruleId) ?? []) {
        if (entry.index < index) found.push(entry);
      }
    }
    return found.toSorted((a, b) => b.index - a.index).map((entry) => entry.step);
  };
}

/**
 * The copies that the removal of each rule took away, by rule ID, from the `cleanup_finished`
 * rows of the page. Only a removal that reports its result writes such a row.
 */
function cleanupCounts(rows: ActivityRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.kind !== "cleanup_finished" || !row.ruleId || counts.has(row.ruleId)) continue;
    const { removed } = parseDetail(row.detail) as { removed?: unknown };
    if (typeof removed === "number") counts.set(row.ruleId, removed);
  }
  return counts;
}

/** "{n} copies removed" for the rules that the rows turned off, if their removal reported. */
function removedAfterOff(rows: ActivityRow[], cleanups: Map<string, number>, t: Messages): string {
  const ruleIds = new Set(
    rows.flatMap((row) =>
      levelStep(row)?.after.choice === "off" && row.ruleId ? [row.ruleId] : [],
    ),
  );
  const counts = [...ruleIds].flatMap((ruleId) => {
    const count = cleanups.get(ruleId);
    return count === undefined ? [] : [count];
  });
  if (counts.length === 0) return "";
  return t.next.describe.activity.detail.cleanupRemoved(counts.reduce((a, b) => a + b, 0));
}

// Page ---------------------------------------------------------------------------------------------

/**
 * One row of the log: time, mark, what happened, optionally who and how long. Admin uses it too,
 * with `showDuration` in its health tab: durations are engineering data, the Activity page leaves
 * them out. The time shows only on the first row of a minute; later rows keep it for screen
 * readers. Every row reserves the swatch slot, so that the titles start in one column.
 */
export function ActivityRowItem(props: {
  item: ActivityItem;
  showUser: boolean;
  showDuration?: boolean;
}) {
  const { item } = props;
  const i18n = useI18n();
  const { t, formatTimestamp } = i18n;
  const text = t.next.activity;
  const format = formatsFor(i18n.locale, i18n.timeZone);
  const { described } = item;
  const hhmm = (iso: string) => format.time.format(new Date(iso));
  const runs = item.join === "runs";
  const same =
    item.join === "same" ? text.row.times(item.count, hhmm(item.first), hhmm(item.at)) : "";
  const detail = runs
    ? `${described.detail} · ${text.row.repeated(item.count, hhmm(item.first), hhmm(item.at))}`
    : same
      ? [described.detail, same].filter(Boolean).join(" · ")
      : described.detail;
  const tone = described.tone;
  const showDuration = props.showDuration === true;
  const cells = (
    <>
      <time
        class={item.showTime ? "act-time num" : "act-time num is-repeat"}
        datetime={item.at}
        title={
          item.count > 1
            ? `${formatTimestamp(item.first)} - ${formatTimestamp(item.at)}`
            : formatTimestamp(item.at)
        }
      >
        {item.showTime ? hhmm(item.at) : <span class="sr-only">{hhmm(item.at)}</span>}
      </time>
      <span class="act-mark">
        {tone ? (
          <StatusDot tone={tone} label={tone === "danger" ? text.row.failed : text.row.partial} />
        ) : null}
      </span>
      <span class="act-main">
        {/* The two calendars of a mirroring as their colours, or the one calendar of a calendar
            event; the title names them. */}
        <span class="act-route" aria-hidden="true">
          {described.route ? (
            <>
              <CalendarSwatch account={described.route.from} />
              <CalendarSwatch account={described.route.to} />
            </>
          ) : described.account ? (
            <CalendarSwatch account={described.account} />
          ) : null}
        </span>
        <span class="row-title act-title" title={described.rawKind}>
          {described.title}
        </span>
        {detail ? <span class="row-meta act-detail">{detail}</span> : null}
      </span>
      {props.showUser ? <span class="act-user">{item.email ?? "-"}</span> : null}
      {showDuration && described.durationMs !== undefined && !runs ? (
        <span class="act-dur num">{text.row.duration(described.durationMs)}</span>
      ) : null}
    </>
  );
  const explain = described.explain ? <p class="act-explain">{described.explain}</p> : null;
  if (!runs) {
    return (
      <li class="list-item">
        {described.href ? (
          <a class="list-row act-row" href={described.href} data-tone={tone ?? undefined}>
            {cells}
          </a>
        ) : (
          <div class="list-row act-row" data-tone={tone ?? undefined}>
            {cells}
          </div>
        )}
        {explain}
      </li>
    );
  }
  // Joined runs: a native disclosure that lists each run, so it opens by keyboard and without
  // script. The chevron is the one of every disclosure (`summary::before` in base.css).
  return (
    <li class="list-item">
      <details class="act-group">
        <summary class="list-row act-row" data-tone={tone ?? undefined}>
          {cells}
        </summary>
        <ol class="act-runs" aria-label={text.row.runs}>
          {item.runs.map((run) => (
            <li class="act-run">
              <time class="act-run-time num" datetime={run.at} title={formatTimestamp(run.at)}>
                {hhmm(run.at)}
              </time>
              {showDuration && run.durationMs !== undefined ? (
                <span class="act-run-dur num">{text.row.duration(run.durationMs)}</span>
              ) : null}
            </li>
          ))}
        </ol>
      </details>
    </li>
  );
}

/** The mirrorings that the filter offers: those with a rule, as "Work to Home". */
function mirroringOptions(state: EditorState, t: Messages): { value: string; label: string }[] {
  const text = t.next.activity.filters;
  const directions = new Set(state.rules.map((entry) => `${entry.from}~${entry.to}`));
  const names = new Map(state.accounts.map((account) => [account.id, account.name]));
  return state.directions
    .filter((direction) => directions.has(`${direction.from}~${direction.to}`))
    .map((direction) => ({
      value: `${direction.from}~${direction.to}`,
      label: text.mirroringName(names.get(direction.from) ?? "", names.get(direction.to) ?? ""),
    }));
}

/**
 * A filter in the URL that its select cannot show, as a removable label. The selects show the
 * calendar and the type always; a mirroring only if it has a rule. A chip next to a select that
 * already shows the filter would only repeat it.
 */
function AppliedFilters(props: { state: EditorState; query: ActivityQuery }) {
  const { t } = useI18n();
  const text = t.next.activity.filters;
  const { query } = props;
  const names = new Map(props.state.accounts.map((account) => [account.id, account.name]));
  const [from = "", to = ""] = (query.d ?? "").split("~");
  const chips: { label: string; without: ActivityQuery }[] = [];
  const shown = new Set(mirroringOptions(props.state, t).map((option) => option.value));
  if (query.d && !shown.has(query.d)) {
    chips.push({
      label: text.mirroringName(names.get(from) ?? "", names.get(to) ?? ""),
      without: { scope: query.scope, c: query.c, kind: query.kind },
    });
  }
  if (chips.length === 0) return null;
  return (
    <ul class="act-applied" aria-label={text.active}>
      {chips.map((chip) => (
        <li>
          <a
            class="act-chip"
            href={activityHref(chip.without)}
            aria-label={text.remove(chip.label)}
          >
            <span>{chip.label}</span>
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </a>
        </li>
      ))}
    </ul>
  );
}

function FilterSelect(props: {
  name: string;
  label: string;
  value: string | undefined;
  all: string;
  options: { value: string; label: string }[];
}) {
  return (
    <label class="act-field">
      <span class="sr-only">{props.label}</span>
      <span class="select">
        <select name={props.name}>
          <option value="" selected={!props.value}>
            {props.all}
          </option>
          {props.options.map((option) => (
            <option value={option.value} selected={option.value === props.value}>
              {option.label}
            </option>
          ))}
        </select>
      </span>
    </label>
  );
}

/** A GET form: filter state lives in the URL. The script submits on change and hides the button. */
function FilterRow(props: { state: EditorState; query: ActivityQuery }) {
  const { t } = useI18n();
  const text = t.next.activity.filters;
  const { state, query } = props;
  const org = query.scope === "org";
  const mirrorings = mirroringOptions(state, t);
  return (
    <form
      class="act-filters"
      method="get"
      action={appPath("/activity")}
      aria-label={text.label}
      data-omit-empty
    >
      {org ? <input type="hidden" name="scope" value="org" /> : null}
      {/* In the org view these filters show the rows of the viewer's own mirrorings and calendars:
          the rules and calendars of other people are not in the state. */}
      <FilterSelect
        name="d"
        label={text.mirroring}
        value={query.d}
        all={text.allMirrorings}
        options={mirrorings}
      />
      <FilterSelect
        name="c"
        label={text.calendar}
        value={query.c}
        all={text.allCalendars}
        options={state.accounts.map((account) => ({ value: account.id, label: account.name }))}
      />
      <FilterSelect
        name="kind"
        label={text.kind}
        value={query.kind}
        all={text.allKinds}
        options={(["sync", "changes", "problems"] as const).map((value) => ({
          value,
          label: text.kinds[value],
        }))}
      />
      <button type="submit" class="btn btn-secondary" data-apply>
        {text.apply}
      </button>
    </form>
  );
}

function Pager(props: { older: number | null; query: ActivityQuery }) {
  const { t } = useI18n();
  const text = t.next.activity.page;
  const { query } = props;
  if (props.older === null && query.before === undefined) return null;
  return (
    <nav class="act-pager" aria-label={text.label}>
      {query.before !== undefined ? (
        <a class="btn btn-ghost" href={activityHref({ ...query, before: undefined })}>
          {text.newest}
        </a>
      ) : null}
      {props.older !== null ? (
        <a
          class="btn btn-secondary"
          href={activityHref({ ...query, before: props.older })}
          rel="next"
        >
          {text.older}
        </a>
      ) : null}
    </nav>
  );
}

function Scope(props: { query: ActivityQuery }) {
  const { t } = useI18n();
  const text = t.next.activity.scope;
  const org = props.query.scope === "org";
  return (
    <span class="seg" role="group" aria-label={text.label}>
      <a
        class="seg-item"
        href={activityHref({ d: props.query.d, c: props.query.c, kind: props.query.kind })}
        aria-current={org ? undefined : "true"}
      >
        {text.own}
      </a>
      <a
        class="seg-item"
        href={activityHref({
          scope: "org",
          d: props.query.d,
          c: props.query.c,
          kind: props.query.kind,
        })}
        aria-current={org ? "true" : undefined}
      >
        {text.org}
      </a>
    </span>
  );
}

/**
 * Activity: when each mirroring last ran and what it did, whether something failed, and what
 * happened at one time. Rows sit under day headings. The filters are a GET form and links, so the
 * page works without script.
 */
export function ActivityPage(props: ActivityProps) {
  const i18n = useI18n();
  const t: Messages = i18n.t;
  const text = t.next.activity;
  const { query, state } = props;
  const org = query.scope === "org";
  const filtered = Boolean(query.d || query.c || query.kind);
  const problemsOnly =
    query.kind === "problems" && !query.d && !query.c && query.before === undefined;
  const days = groupActivity(props.rows, state, i18n, Date.now(), query.d);
  return (
    <Shell
      title={text.title}
      user={props.user}
      active="activity"
      palette={{ state }}
      attention={navAttention(state, props.outcomes, Date.now())}
      actions={props.canViewOrg ? <Scope query={query} /> : undefined}
      styles={["/next/activity.css"]}
    >
      <div class="act">
        <FilterRow state={state} query={query} />
        <AppliedFilters state={state} query={query} />
        {days.length === 0 ? (
          problemsOnly ? (
            // Only "Problems" is chosen: say over which entries nothing failed, so that the empty
            // list does not read like a broken filter.
            <EmptyState
              title={
                props.older === null
                  ? text.empty.problemsTitle(AUDIT_RETENTION_DAYS)
                  : text.empty.problemsScannedTitle(ACTIVITY_SCAN_ROWS)
              }
              text={props.older === null ? text.empty.problemsText : text.empty.scanned}
            >
              <a class="btn btn-secondary" href={activityHref({ scope: query.scope })}>
                {text.filters.clear}
              </a>
            </EmptyState>
          ) : filtered || query.before !== undefined ? (
            <EmptyState
              title={text.empty.filteredTitle}
              text={props.older !== null ? text.empty.scanned : text.empty.filteredText}
            >
              <a class="btn btn-secondary" href={activityHref({ scope: query.scope })}>
                {text.filters.clear}
              </a>
            </EmptyState>
          ) : (
            <EmptyState title={text.empty.title} text={text.empty.text} />
          )
        ) : (
          <div class="list act-list">
            {days.map((day) => (
              <ListGroup title={day.heading} label={`${text.list}: ${day.heading}`}>
                {day.items.map((item) => (
                  <ActivityRowItem item={item} showUser={org} />
                ))}
              </ListGroup>
            ))}
          </div>
        )}
        <Pager older={props.older} query={query} />
        <p class="act-retention">{text.retention(AUDIT_RETENTION_DAYS)}</p>
      </div>
    </Shell>
  );
}
