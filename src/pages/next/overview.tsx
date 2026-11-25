import { appPath } from "../../app-base";
import type { Child } from "hono/jsx";
import type { RecentChanges, RuleOutcome } from "../../audit";
import { SILENT_RULE_MS } from "../../alerts";
import {
  type EditorAccount,
  type EditorDirection,
  type EditorState,
  type Level,
} from "../../editor";
import { useI18n, type Locale } from "../../i18n";
import type { OverviewMessages } from "../../i18n/next/overview";
import { reconnectUrl } from "./links";
import { EmptyState, ListGroup, ListRow, Notice, StatusDot, type Tone } from "./components";
import { activityHref } from "./activity-link";
import { changeEntries, type ChangeEntry, type ChangeSubject } from "./describe";
import { CalendarSwatch, LevelMark } from "./identity";
import { directionLevel, directionOf } from "./levels";
import { mirroringHref } from "./mirroring";
import { navAttention } from "./run-status";
import { Shell } from "./shell";
import type { PageBase } from "./types";
import { hoursText } from "./work-hours";

export interface OverviewProps extends PageBase {
  /** Runs with changes and the user's own changes of the last 24 hours (see `recentChanges`). */
  changes: RecentChanges;
  /** Calendars with blocks that an offboarding could not remove, and those still being cleaned. */
  cleanups: { left: number; running: number };
  /** The time the page treats as now. Tests set it; the route leaves it out. */
  now?: number;
}

/** Entries of the changes list. More are on the activity page. */
const CHANGES_SHOWN = 8;

/** From this many overdue mirrorings on, one row stands for all of them: a stalled cron, not N faults. */
const OVERDUE_JOINED = 3;

// Time ------------------------------------------------------------------------------------------

const AGE_UNITS: readonly [Intl.NumberFormatOptions["unit"] & string, number][] = [
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

/** Unit formatters per locale, built once per isolate: Intl setup costs CPU time. */
const ageFormats = new Map<string, Intl.NumberFormat>();

function ageFormat(locale: Locale, unit: string): Intl.NumberFormat {
  const key = `${locale}|${unit}`;
  let format = ageFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "short" });
    ageFormats.set(key, format);
  }
  return format;
}

/**
 * How long ago, in the short form of every status on the page: "8 min", "9 hr", "2 days". Below a
 * minute it is `nowText`. The one short-unit formatter of the Overview and the row status
 * (`run-status.tsx`), so that the header, the cells and the lists use the same units.
 */
export function shortAge(iso: string, now: number, locale: Locale, nowText: string): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  for (const [unit, length] of AGE_UNITS) {
    if (seconds >= length) return ageFormat(locale, unit).format(Math.round(seconds / length));
  }
  return nowText;
}

/**
 * The ages of several mirrorings as one: "3 days" when they match, "3-4 days" when only the number
 * differs, "3 hr - 4 days" when the units differ. `young` is the age of the newest, `old` of the
 * oldest. The dash is an en dash.
 */
export function ageRange(young: string, old: string): string {
  if (young === old) return old;
  const split = (age: string) => /^(\d+)\s*(.*)$/.exec(age);
  const a = split(young);
  const b = split(old);
  if (a && b && a[2] === b[2]) return `${a[1]}\u2013${b[1]}${b[2] ? ` ${b[2]}` : ""}`;
  return `${young} \u2013 ${old}`;
}

/** A short age with the exact time in its title. */
function Age(props: { at: string; now: number }) {
  const { locale, t, formatTimestamp } = useI18n();
  return (
    <time class="ov-age num" datetime={props.at} title={formatTimestamp(props.at)}>
      {shortAge(props.at, props.now, locale, t.next.overview.age.now)}
    </time>
  );
}

// Failures ----------------------------------------------------------------------------------------

type ReasonKind = keyof OverviewMessages["problems"]["reasons"];

/**
 * Which sentence an error code of a failed run gets. The codes come from `errorCode` in
 * `src/audit.ts`: `token_<code>`, `graph_<status>[_<reason>]`, `google_<status>[_<reason>]`,
 * `penalty` and plain error names. A throttle that the provider reports as 403 or 5xx counts as
 * throttled. Anything else is "unknown", and the page shows the code in muted text.
 */
export function reasonKind(code: string): ReasonKind {
  const lower = code.toLowerCase();
  if (lower === "needs_reconnect" || lower.startsWith("token_")) return "token";
  if (lower === "penalty" || /throttl|ratelimit|rate_limit|quota|toomany/.test(lower)) {
    return "throttled";
  }
  const status = /^(?:graph|google|http)_(\d{3})/.exec(lower)?.[1];
  if (status === "429") return "throttled";
  if (status?.startsWith("5")) return "server";
  if (status === "401" || status === "403") return "denied";
  if (status === "404" || status === "410") return "missing";
  return "unknown";
}

/** The first HTTP status of a run's `statuses` field ("429 ApplicationThrottled:13,400:2"). */
function firstStatus(statuses: string | undefined): string | undefined {
  return /^(\d{3})/.exec(statuses ?? "")?.[1];
}

/** The sentence for a failed outcome: its reason, or the count of changes that did not go. */
export function failureSentence(
  outcome: Pick<RuleOutcome, "kind" | "detail">,
  text: OverviewMessages["problems"],
): { text: string; code?: string } {
  const { detail } = outcome;
  if (outcome.kind === "sync_failed") {
    if (!detail.code) return { text: text.failedNoReason };
    const kind = reasonKind(detail.code);
    return kind === "unknown"
      ? { text: text.reasons.unknown, code: detail.code }
      : { text: text.reasons[kind] };
  }
  const changes = text.failedChanges(detail.failed ?? 0);
  const status = firstStatus(detail.statuses);
  if (!status) return { text: changes };
  const kind = reasonKind(`http_${status}`);
  return kind === "unknown"
    ? { text: `${changes} ${text.reasons.unknown}`, code: status }
    : { text: `${changes} ${text.reasons[kind]}` };
}

// Numbers ------------------------------------------------------------------------------------------

/**
 * The state of one mirroring that runs, worst first: a calendar of it waits for a reconnect, its
 * latest run failed or left changes undone, it is overdue, it never ran, or it is fine.
 */
export type MirroringState = "blocked" | "failed" | "partial" | "overdue" | "waiting" | "ok";

/** What the latest runs say about one mirroring that is on. */
export interface MirroringStat {
  state: MirroringState;
  /** Blocks the mirroring holds after its latest runs; null if no run reported the counts. */
  blocks: number | null;
  /** Time of the newest run or failure; null if the mirroring has not run yet. */
  at: string | null;
  /**
   * The oldest of the latest outcomes of its rules: when the rule that waited longest last ran.
   * An overdue mirroring shows this time.
   */
  stale: string | null;
  /** Changes that the latest runs could not write. */
  notWritten: number;
  /** Changes that wait for the provider after a throttle (`remaining`). */
  waiting: number;
  /** The newest failed outcome, for the sentence of its reason. */
  failure: RuleOutcome | null;
}

/**
 * Blocks a run left in the target: `unchanged + create + update`, as `src/read-model.ts` counts
 * them. Null if a field is missing, as in a failed run, so that "unknown" never shows as 0.
 */
export function blocksOf(detail: RuleOutcome["detail"]): number | null {
  const { unchanged, create, update } = detail;
  if (typeof unchanged !== "number" || typeof create !== "number" || typeof update !== "number") {
    return null;
  }
  return unchanged + create + update;
}

/** The rules of a direction that run: turned on, and the direction is not off. */
function runningRules(direction: EditorDirection): Set<string> {
  if (direction.effective === "off") return new Set();
  return new Set(direction.slots.flatMap((slot) => (slot.rule?.enabled ? [slot.rule.id] : [])));
}

/**
 * One stat per direction that runs, keyed `<from>~<to>`. A direction with several source calendars
 * adds the blocks of its rules. Only the latest outcome per rule is known (`latestRuleOutcomes`).
 *
 * Every finished run writes a `sync_run` row, with or without changes (`executeRule` in
 * `src/account-sync.ts`), and each rule runs at least once an hour. So the latest outcome is the
 * last time the rule ran, not the last time it changed something. A rule whose latest outcome is
 * older than `SILENT_RULE_MS` is overdue: the operator's silence alert (`src/alerts.ts`) uses the
 * same threshold. A mirroring into or out of a calendar that waits for a reconnect is "blocked";
 * the alert leaves those out too.
 */
export function mirroringStats(
  state: EditorState,
  outcomes: RuleOutcome[],
  now: number,
): Map<string, MirroringStat> {
  const broken = new Set(
    state.accounts.filter((account) => account.needsReconnect).map((account) => account.id),
  );
  const stats = new Map<string, MirroringStat>();
  for (const direction of state.directions) {
    const running = runningRules(direction);
    if (running.size === 0) continue;
    const stat: MirroringStat = {
      state: "ok",
      blocks: null,
      at: null,
      stale: null,
      notWritten: 0,
      waiting: 0,
      failure: null,
    };
    let failed = false;
    for (const outcome of outcomes) {
      if (!outcome.enabled || !running.has(outcome.ruleId)) continue;
      if (!stat.at || outcome.createdAt > stat.at) stat.at = outcome.createdAt;
      if (!stat.stale || outcome.createdAt < stat.stale) stat.stale = outcome.createdAt;
      const notWritten = outcome.detail.failed ?? 0;
      if (outcome.kind === "sync_failed" || notWritten > 0) {
        failed = true;
        stat.notWritten += notWritten;
        if (!stat.failure || outcome.createdAt > stat.failure.createdAt) stat.failure = outcome;
      }
      stat.waiting += outcome.detail.remaining ?? 0;
      const blocks = blocksOf(outcome.detail);
      if (blocks !== null) stat.blocks = (stat.blocks ?? 0) + blocks;
    }
    if (broken.has(direction.from) || broken.has(direction.to)) stat.state = "blocked";
    else if (failed) stat.state = "failed";
    else if (stat.waiting > 0) stat.state = "partial";
    else if (stat.stale && now - Date.parse(stat.stale) > SILENT_RULE_MS) stat.state = "overdue";
    else if (!stat.at) stat.state = "waiting";
    stats.set(`${direction.from}~${direction.to}`, stat);
  }
  return stats;
}

/** Blocks flowing in one direction of travel for a calendar. */
export interface Flow {
  /** Mirrorings that run. */
  mirrorings: number;
  /** Sum of their blocks; null if none reported a count. */
  blocks: number | null;
}

/** Per calendar: blocks it receives (mirrorings with it as target) and sends (as source). */
export function calendarFlows(
  state: EditorState,
  stats: Map<string, MirroringStat>,
): Map<string, { receives: Flow; sends: Flow }> {
  const result = new Map<string, { receives: Flow; sends: Flow }>();
  for (const account of state.accounts) {
    result.set(account.id, {
      receives: { mirrorings: 0, blocks: null },
      sends: { mirrorings: 0, blocks: null },
    });
  }
  const add = (flow: Flow | undefined, stat: MirroringStat) => {
    if (!flow) return;
    flow.mirrorings++;
    if (stat.blocks !== null) flow.blocks = (flow.blocks ?? 0) + stat.blocks;
  };
  for (const [key, stat] of stats) {
    const [from = "", to = ""] = key.split("~");
    add(result.get(to)?.receives, stat);
    add(result.get(from)?.sends, stat);
  }
  return result;
}

// Header state ------------------------------------------------------------------------------------

export interface HeaderState {
  tone: Tone;
  text: string;
  /** The newest run, for "last run 8 min ago". */
  checked: string | null;
}

/**
 * The live state in the page header. Fine: "6 mirrorings in sync". Otherwise how many need
 * attention, in the words of the "Needs attention" list: "2 of 6 need attention", danger when one
 * failed. The list below says what each one has. A calendar that needs a reconnect counts once, as
 * a calendar; its mirrorings do not count again.
 */
export function headerState(
  stats: Map<string, MirroringStat>,
  reconnect: number,
  text: OverviewMessages["state"],
): HeaderState {
  const total = stats.size;
  const count = (state: MirroringState) =>
    [...stats.values()].filter((stat) => stat.state === state).length;
  let checked: string | null = null;
  for (const stat of stats.values()) {
    if (stat.at && (!checked || stat.at > checked)) checked = stat.at;
  }
  const failed = count("failed");
  const overdue = count("overdue");
  const partial = count("partial");
  const waiting = count("waiting");
  const parts: string[] = [];
  const attention = failed + overdue + partial;
  if (attention > 0) parts.push(text.needAttention(attention, total));
  if (reconnect > 0) parts.push(text.reconnect(reconnect));
  if (parts.length > 0) {
    const tone: Tone = failed > 0 || reconnect > 0 ? "danger" : "warn";
    return { tone, text: parts.join(" · "), checked };
  }
  if (total === 0) return { tone: "idle", text: text.nothing, checked: null };
  if (waiting === total) return { tone: "idle", text: text.waiting(total), checked: null };
  const fine = text.inSync(total - waiting);
  return {
    tone: "ok",
    text: waiting > 0 ? `${fine} · ${text.waitingMore(waiting)}` : fine,
    checked,
  };
}

/**
 * "8 min ago" / "vor 8 Min." from the one short age of the page (`shortAge`), so that the header,
 * the cells and the attention list use the same units. Under a minute: "just now".
 */
function agoText(iso: string, now: number, locale: Locale, text: OverviewMessages["age"]): string {
  const age = shortAge(iso, now, locale, "");
  return age === "" ? text.justNow : text.ago(age);
}

function HeaderLead(props: { state: HeaderState; now: number }) {
  const { t, locale, formatTimestamp } = useI18n();
  const { state } = props;
  return (
    <span class={`ov-state is-${state.tone}`}>
      <StatusDot tone={state.tone} label={false} />
      <span class="ov-state-text">{state.text}</span>
      {state.checked ? (
        <time
          class="ov-state-time num"
          datetime={state.checked}
          title={formatTimestamp(state.checked)}
        >
          {` · ${t.next.overview.state.checked(agoText(state.checked, props.now, locale, t.next.overview.age))}`}
        </time>
      ) : null}
    </span>
  );
}

// Names -------------------------------------------------------------------------------------------

/** A calendar's swatch and name. */
function Name(props: { account: EditorAccount }) {
  return (
    <span class="ov-name">
      <CalendarSwatch account={props.account} />
      <span class="ov-name-text">{props.account.name}</span>
    </span>
  );
}

/** "Konto 2 to Konto 1", each name with its swatch: a route reads the same on every page. */
function Route(props: { from: EditorAccount; to: EditorAccount }) {
  const { t } = useI18n();
  return (
    <span class="ov-route">
      <Name account={props.from} />
      <span class="ov-to">{` ${t.next.overview.map.to} `}</span>
      <Name account={props.to} />
    </span>
  );
}

// Needs attention ---------------------------------------------------------------------------------

/** One thing that needs the user's attention. */
export interface Attention {
  key: string;
  tone: Tone;
  subject: Child;
  /** When it happened, or when the overdue mirroring last ran. */
  at?: string;
  /** The state in one word, in the tone's colour, before the sentence. */
  state?: string;
  text: string;
  /** Muted code of an error that has no sentence yet. */
  code?: string;
  primary: Child;
  secondary?: Child;
}

const TONE_RANK: Record<Tone, number> = { danger: 0, warn: 1, idle: 2, ok: 3 };

function attentionOf(
  props: OverviewProps,
  stats: Map<string, MirroringStat>,
  showOperatorNotice: boolean,
  now: number,
): Attention[] {
  const { t, locale } = useI18n();
  const text = t.next.overview.problems;
  const noRun = (iso: string) => text.noRun(shortAge(iso, now, locale, t.next.overview.age.now));
  const accounts = new Map(props.state.accounts.map((account) => [account.id, account]));
  const items: Attention[] = [];
  const activity = (d: string) => (
    <a class="btn btn-ghost" href={activityHref({ d, kind: "problems" })}>
      {text.viewActivity}
    </a>
  );
  const open = (from: string, to: string) => (
    <a class="btn btn-secondary" href={mirroringHref(from, to)}>
      {text.openMirroring}
    </a>
  );

  for (const account of props.state.accounts.filter((entry) => entry.needsReconnect)) {
    items.push({
      key: `reconnect-${account.id}`,
      tone: "danger",
      subject: <Name account={account} />,
      state: text.reconnectState,
      text: text.reconnectText,
      primary: (
        <a
          class="btn btn-secondary"
          href={reconnectUrl(account)}
          aria-label={text.reconnectLabel(account.name)}
        >
          {text.reconnect}
        </a>
      ),
      secondary: (
        <a
          class="btn btn-ghost"
          href={`${appPath("/calendars")}?c=${encodeURIComponent(account.id)}`}
        >
          {text.openCalendar}
        </a>
      ),
    });
  }

  const missing = props.state.accounts.filter(
    (account) => !account.calendar && !account.needsReconnect,
  );
  if (missing.length > 0) {
    const google = missing.some((account) => account.provider === "google");
    items.push({
      key: "missing",
      tone: "warn",
      subject: text.missingTitle(missing.map((account) => account.name).join(", ")),
      text: google ? `${text.missingText} ${text.missingGoogle}` : text.missingText,
      primary: (
        <form method="post" action={`${appPath("/calendars")}/refresh`}>
          <input type="hidden" name="back" value={appPath("/")} />
          <button type="submit" class="btn btn-secondary">
            {text.reload}
          </button>
        </form>
      ),
    });
  }

  const overdue: { key: string; from: EditorAccount; to: EditorAccount; at: string }[] = [];
  for (const [key, stat] of stats) {
    const [fromId = "", toId = ""] = key.split("~");
    const from = accounts.get(fromId);
    const to = accounts.get(toId);
    if (!from || !to) continue;
    if (stat.state === "failed" && stat.failure) {
      const sentence = failureSentence(stat.failure, text);
      items.push({
        key: `failed-${key}`,
        tone: "danger",
        subject: <Route from={from} to={to} />,
        at: stat.failure.createdAt,
        state: text.failed,
        text: sentence.text,
        code: sentence.code,
        primary: open(fromId, toId),
        secondary: activity(key),
      });
    } else if (stat.state === "partial" && stat.at) {
      items.push({
        key: `partial-${key}`,
        tone: "warn",
        subject: <Route from={from} to={to} />,
        at: stat.at,
        state: text.partial,
        text: text.partialText(stat.waiting),
        primary: open(fromId, toId),
        secondary: activity(key),
      });
    } else if (stat.state === "overdue" && stat.stale) {
      overdue.push({ key, from, to, at: stat.stale });
    }
  }
  if (overdue.length >= OVERDUE_JOINED) {
    const oldest = overdue.reduce((a, b) => (a.at < b.at ? a : b));
    const newest = overdue.reduce((a, b) => (a.at > b.at ? a : b));
    items.push({
      key: "overdue",
      tone: "warn",
      subject: text.overdueMany(overdue.length),
      at: oldest.at,
      state: text.noRun(
        ageRange(
          shortAge(newest.at, now, locale, t.next.overview.age.now),
          shortAge(oldest.at, now, locale, t.next.overview.age.now),
        ),
      ),
      text: text.overdueText,
      primary: (
        <a class="btn btn-secondary" href={appPath("/mirroring")}>
          {text.openMirrorings}
        </a>
      ),
      secondary: (
        <a class="btn btn-ghost" href={activityHref({ kind: "sync" })}>
          {text.viewActivity}
        </a>
      ),
    });
  } else {
    for (const entry of overdue) {
      items.push({
        key: `overdue-${entry.key}`,
        tone: "warn",
        subject: <Route from={entry.from} to={entry.to} />,
        at: entry.at,
        state: noRun(entry.at),
        text: text.overdueText,
        primary: open(entry.from.id, entry.to.id),
        secondary: (
          <a class="btn btn-ghost" href={activityHref({ d: entry.key })}>
            {text.viewActivity}
          </a>
        ),
      });
    }
  }

  if (props.cleanups.left > 0) {
    items.push({
      key: "cleanup-left",
      tone: "warn",
      subject: text.cleanupLeftTitle(props.cleanups.left),
      text: text.cleanupLeftText,
      primary: (
        <a class="btn btn-secondary" href="/cleanup">
          {text.cleanupShow}
        </a>
      ),
    });
  }
  if (props.cleanups.running > 0) {
    items.push({
      key: "cleanup-running",
      tone: "idle",
      subject: text.cleanupRunningTitle(props.cleanups.running),
      text: text.cleanupRunningText,
      primary: (
        <a class="btn btn-secondary" href="/cleanup">
          {text.cleanupShow}
        </a>
      ),
    });
  }
  if (showOperatorNotice) {
    items.push({
      key: "operator",
      tone: "idle",
      subject: t.accounts.operatorNoticeTitle,
      text: props.operatorNotice,
      primary: (
        <a class="btn btn-secondary" href="/privacy">
          {t.accounts.operatorNoticeLink}
        </a>
      ),
    });
  }
  // Stable: within a tone the order above holds (reconnect, missing, failed, partial, overdue).
  return items.sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone]);
}

function NeedsAttention(props: { items: Attention[]; now: number }) {
  const { t } = useI18n();
  const text = t.next.overview.problems;
  return (
    <section class="ov-section ov-attention" aria-labelledby="ov-attention-title">
      <div class="ov-head">
        <h2 class="ov-title" id="ov-attention-title">
          {text.label}
        </h2>
      </div>
      <ul class="ov-rows">
        {props.items.map((item) => (
          <li class="ov-att" data-key={item.key}>
            <div class="ov-row-head">
              <StatusDot tone={item.tone} label={false} />
              <span class="ov-subject">{item.subject}</span>
              {item.at ? <Age at={item.at} now={props.now} /> : null}
            </div>
            <p class="ov-att-text">
              {item.state ? (
                <span class={`ov-tone is-${item.tone}`}>{`${item.state} `}</span>
              ) : null}
              {item.text}
              {item.code ? <span class="ov-code">{` ${item.code}`}</span> : null}
            </p>
            <div class="ov-att-actions">
              {item.primary}
              {item.secondary}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

// Map --------------------------------------------------------------------------------------------

/** The second line of a cell or phone row, as plain text for the accessible name. */
function statusText(
  stat: MirroringStat | undefined,
  text: OverviewMessages["map"],
  relative: (iso: string) => string,
  age: (iso: string) => string,
): string {
  if (!stat) return "";
  const blocks = stat.blocks === null ? null : text.blocks(stat.blocks);
  switch (stat.state) {
    case "blocked":
      return text.blocked;
    case "failed":
      return [text.failed, stat.notWritten > 0 ? text.notWritten(stat.notWritten) : null]
        .filter(Boolean)
        .join(", ");
    case "partial":
      return [blocks, text.waiting(stat.waiting)].filter(Boolean).join(", ");
    case "overdue":
      // The block count of an overdue mirroring is old; the cell says only how long it has been.
      return text.overdue(age(stat.stale ?? ""));
    case "waiting":
      return text.noRun;
    case "ok":
      return [blocks, stat.at ? text.lastRun(relative(stat.at)) : null].filter(Boolean).join(", ");
  }
}

/** The second line of a cell: count, state in words when it is not fine, short age. */
function StatusLine(props: { stat: MirroringStat; now: number }) {
  const { locale, t } = useI18n();
  const text = t.next.overview.map;
  const { stat } = props;
  const blocks =
    stat.blocks === null ? null : <span class="ov-count num">{text.blocks(stat.blocks)}</span>;
  switch (stat.state) {
    case "blocked":
      return <span class="ov-tone is-danger">{text.blocked}</span>;
    case "failed":
      return (
        <>
          <span class="ov-tone is-danger">
            {stat.notWritten > 0 ? text.notWritten(stat.notWritten) : text.failed}
          </span>
          {stat.failure ? <Age at={stat.failure.createdAt} now={props.now} /> : null}
        </>
      );
    case "partial":
      return (
        <>
          {blocks}
          <span class="ov-tone is-warn">{text.waiting(stat.waiting)}</span>
        </>
      );
    case "overdue":
      return (
        <span class="ov-tone is-warn">
          {text.overdue(shortAge(stat.stale ?? "", props.now, locale, t.next.overview.age.now))}
        </span>
      );
    case "waiting":
      return <span class="ov-muted">{text.noRun}</span>;
    case "ok":
      return (
        <>
          {blocks}
          {stat.at ? <Age at={stat.at} now={props.now} /> : null}
        </>
      );
  }
}

/** A header of the map: swatch and name, then what flows, working hours, or a broken connection. */
function AxisHead(props: { account: EditorAccount; flow: Flow; side: "receives" | "sends" }) {
  const { t } = useI18n();
  const text = t.next.overview.map;
  const { account, flow } = props;
  let meta: Child = null;
  if (account.needsReconnect) {
    meta = (
      <a class="ov-reconnect" href={`${appPath("/calendars")}?c=${encodeURIComponent(account.id)}`}>
        {text.needsReconnect}
      </a>
    );
  } else if (flow.mirrorings === 0) {
    meta = props.side === "receives" ? text.receivesNothing : text.sendsNothing;
  } else if (flow.blocks !== null) {
    meta = (
      <span class="num">
        {props.side === "receives" ? text.receives(flow.blocks) : text.sends(flow.blocks)}
      </span>
    );
  }
  const hours = props.side === "receives" && account.workHours ? account.workHours : null;
  return (
    <>
      <Name account={account} />
      {meta ? <span class="ov-axis-meta">{meta}</span> : null}
      {hours ? (
        <span class="ov-axis-meta" title={hoursText(t, hours)}>
          {hoursText(t, hours)}
        </span>
      ) : null}
    </>
  );
}

interface Cell {
  level: Level;
  stat: MirroringStat | undefined;
  /** The second line as words, for the accessible names. */
  status: string;
  /** The accessible name of a list row, which shows the full level. */
  label: string;
}

/**
 * The level every copied cell of the map shares, or null when they differ or nothing is copied.
 * Then the map says it once in its head, and the cells show only mark, copies and time.
 */
export function uniformLevel(state: EditorState, calendars: EditorAccount[]): Level | null {
  const copied = new Set<Level>();
  for (const from of calendars) {
    for (const to of calendars) {
      if (from.id === to.id) continue;
      const direction = directionOf(state, from.id, to.id);
      const level = direction ? directionLevel(state, direction) : "off";
      if (level !== "off") copied.add(level);
    }
  }
  return copied.size === 1 ? ([...copied][0] ?? null) : null;
}

function WhatGoesWhere(props: {
  state: EditorState;
  stats: Map<string, MirroringStat>;
  flows: Map<string, { receives: Flow; sends: Flow }>;
  now: number;
}) {
  const { t, locale } = useI18n();
  const text = t.next.overview.map;
  const levels = t.next.shell.levels;
  const { state } = props;
  const calendars = state.accounts.filter((account) => account.calendar);
  const none: Flow = { mirrorings: 0, blocks: null };
  const uniform = uniformLevel(state, calendars);
  const cell = (from: EditorAccount, to: EditorAccount): Cell => {
    const direction = directionOf(state, from.id, to.id);
    const level = direction ? directionLevel(state, direction) : "off";
    const stat = level === "off" ? undefined : props.stats.get(`${from.id}~${to.id}`);
    const status = statusText(
      stat,
      text,
      (iso) => agoText(iso, props.now, locale, t.next.overview.age),
      (iso) => shortAge(iso, props.now, locale, t.next.overview.age.now),
    );
    return {
      level,
      stat,
      status,
      label: text.cell(from.name, to.name, levels.summary[level], status),
    };
  };
  /** The label a map cell shows: none when the head names the one level of all copies. */
  const shownLabel = (level: Level): string | null =>
    level === "off" ? text.notCopied : level === uniform ? null : levels.summary[level];
  return (
    <section class="ov-section ov-map" aria-labelledby="ov-map-title">
      <div class="ov-head">
        <h2 class="ov-title" id="ov-map-title">
          {text.title}
        </h2>
        {uniform ? (
          <p class="ov-hint ov-uniform">
            <LevelMark level={uniform} />
            {text.allCopies(levels.summary[uniform])}
          </p>
        ) : null}
      </div>
      <div class="ov-map-scroll" role="region" aria-label={text.tableLabel} tabindex={0}>
        <table class="ov-matrix">
          <thead>
            <tr class="ov-axis-row">
              <td class="ov-corner" />
              <th class="ov-axis" scope="colgroup" colspan={calendars.length}>
                {text.axisTo}
              </th>
            </tr>
            <tr>
              <th class="ov-axis ov-axis-from" scope="col">
                {text.axisFrom}
              </th>
              {calendars.map((to) => (
                <th class="ov-col" scope="col">
                  <AxisHead
                    account={to}
                    flow={props.flows.get(to.id)?.receives ?? none}
                    side="receives"
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {calendars.map((from) => (
              <tr>
                <th class="ov-row" scope="row">
                  <AxisHead
                    account={from}
                    flow={props.flows.get(from.id)?.sends ?? none}
                    side="sends"
                  />
                </th>
                {calendars.map((to) => {
                  // A calendar does not mirror into itself: an empty cell with a quiet line.
                  if (from.id === to.id) return <td class="ov-self" />;
                  const { level, stat, status, label } = cell(from, to);
                  const kind = level === "off" ? "off" : (stat?.state ?? "waiting");
                  const shown = shownLabel(level);
                  return (
                    <td class="ov-cell">
                      <a
                        class={`ov-cell-link is-${kind}`}
                        href={mirroringHref(from.id, to.id)}
                        aria-label={
                          shown
                            ? text.cellShort(
                                shown,
                                from.name,
                                to.name,
                                levels.summary[level],
                                status,
                              )
                            : label
                        }
                        data-direction={`${from.id}~${to.id}`}
                      >
                        {/* With a label: mark and label, the state on a second line. Without
                            (the head names the level): mark and state on one line. */}
                        <span class="ov-cell-main">
                          <LevelMark
                            level={level}
                            tint={level === "off" ? undefined : from.color}
                          />
                          {shown ? (
                            <span class="ov-level">{shown}</span>
                          ) : stat ? (
                            <span class="ov-cell-meta">
                              <StatusLine stat={stat} now={props.now} />
                            </span>
                          ) : null}
                        </span>
                        {shown && stat ? (
                          <span class="ov-cell-meta">
                            <StatusLine stat={stat} now={props.now} />
                          </span>
                        ) : null}
                      </a>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Below 720 px the matrix gives way to a list grouped by target. */}
      <div class="list ov-map-list">
        {calendars.map((to) => (
          <ListGroup
            title={text.appearsIn(to.name)}
            label={text.appearsIn(to.name)}
            hint={to.workHours ? hoursText(t, to.workHours) : undefined}
          >
            {calendars
              .filter((from) => from.id !== to.id)
              .map((from) => {
                const { level, stat, label } = cell(from, to);
                return (
                  <ListRow
                    href={mirroringHref(from.id, to.id)}
                    label={label}
                    icon={<CalendarSwatch account={from} />}
                    title={from.name}
                    meta={
                      <span class="ov-list-level">
                        <LevelMark level={level} tint={level === "off" ? undefined : from.color} />
                        {levels.summary[level]}
                      </span>
                    }
                    status={
                      stat ? (
                        <span class="ov-cell-meta">
                          <StatusLine stat={stat} now={props.now} />
                        </span>
                      ) : undefined
                    }
                  />
                );
              })}
          </ListGroup>
        ))}
      </div>
    </section>
  );
}

// Changes in the last 24 hours ------------------------------------------------------------------

function Subject(props: { subject: ChangeSubject }) {
  const { subject } = props;
  if ("route" in subject) return <Route from={subject.route.from} to={subject.route.to} />;
  if ("account" in subject) return <Name account={subject.account} />;
  return <span class="ov-subject-text">{subject.text}</span>;
}

/**
 * What the runs of a mirroring did, as one part of the line: "3 new, 2 changed, 1 removed", and
 * the changes that failed in the danger tone. `lead` puts the " · " before it, after the words of
 * the user's changes. Null when the runs changed nothing.
 */
function SyncCounts(props: { sync: NonNullable<ChangeEntry["sync"]>; lead: boolean }) {
  const { t } = useI18n();
  const text = t.next.describe.changes;
  const { sync } = props;
  const parts = [
    sync.created > 0 ? text.created(sync.created) : null,
    sync.updated > 0 ? text.updated(sync.updated) : null,
    sync.removed > 0 ? text.removed(sync.removed) : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0 && sync.failed === 0) return null;
  const lead = props.lead ? " · " : "";
  return (
    <>
      {parts.length > 0 ? <span class="num">{`${lead}${parts.join(", ")}`}</span> : null}
      {sync.failed > 0 ? (
        <span class="ov-tone is-danger num">{`${parts.length > 0 ? ", " : lead}${text.failed(sync.failed)}`}</span>
      ) : null}
    </>
  );
}

function Changes(props: { entries: ChangeEntry[]; changes: RecentChanges; now: number }) {
  const { t, formatTimestamp } = useI18n();
  const text = t.next.describe.changes;
  const shown = props.entries.slice(0, CHANGES_SHOWN);
  // The read stops at its row limit; then rows older than the oldest read were not looked at.
  const cut =
    props.changes.oldest !== null &&
    props.changes.scanned >= props.changes.limit &&
    props.changes.oldest > props.changes.since
      ? props.changes.oldest
      : null;
  return (
    <section class="ov-section ov-changes" aria-labelledby="ov-changes-title">
      <div class="ov-head">
        <h2 class="ov-title" id="ov-changes-title">
          {text.title}
        </h2>
        <a class="link ov-all" href={activityHref()}>
          {text.all}
        </a>
      </div>
      {shown.length === 0 ? (
        <p class="ov-empty">{text.empty}</p>
      ) : (
        <ul class="ov-rows">
          {shown.map((entry) => (
            <li class="ov-chg" data-key={entry.key}>
              <div class="ov-row-head">
                <span class="ov-subject">
                  <Subject subject={entry.subject} />
                </span>
                <Age at={entry.at} now={props.now} />
              </div>
              {/* One row per mirroring: what the user changed (the level with its count, then
                  the other changes), then what the runs did. Other entries count repeats. */}
              <p class="ov-chg-text">
                {entry.text ? <span>{entry.text}</span> : null}
                {entry.sync ? <SyncCounts sync={entry.sync} lead={Boolean(entry.text)} /> : null}
                {!entry.route && !entry.sync && entry.count > 1 ? (
                  <span class="ov-muted">{` · ${text.times(entry.count)}`}</span>
                ) : null}
              </p>
            </li>
          ))}
        </ul>
      )}
      {cut ? <p class="ov-empty">{text.cut(formatTimestamp(cut))}</p> : null}
    </section>
  );
}

// Empty and first-run states -----------------------------------------------------------------------

function FirstRun(props: { state: EditorState; ready: number }) {
  const { t } = useI18n();
  const text = t.next.overview.empty;
  if (props.ready >= 2) {
    return (
      <form method="post" action="/rules/group/all">
        <input type="hidden" name="back" value={appPath("/")} />
        <EmptyState title={text.startTitle} text={text.startText(props.ready)}>
          <button type="submit" class="btn btn-primary">
            {text.start}
          </button>
        </EmptyState>
      </form>
    );
  }
  const none = props.state.accounts.length === 0;
  return (
    <EmptyState
      title={none ? text.noneTitle : text.oneTitle}
      text={none ? text.noneText : text.oneText}
    >
      <a class="btn btn-primary" href={appPath("/calendars")}>
        {text.connect}
      </a>
    </EmptyState>
  );
}

// Page -------------------------------------------------------------------------------------------

/**
 * Overview. The header says at once whether everything is fine. The map shows what goes where,
 * with the state of each mirroring in its cell; a list on a phone. On the right, what needs
 * attention (absent when nothing does) and what changed in the last 24 hours.
 */
export function OverviewPage(props: OverviewProps) {
  const { t } = useI18n();
  const text = t.next.overview;
  const { state } = props;
  const now = props.now ?? Date.now();
  const stats = mirroringStats(state, props.outcomes, now);
  const ready = state.accounts.filter((account) => account.calendar).length;
  const reconnect = state.accounts.filter((account) => account.needsReconnect).length;
  const firstRun =
    ready < 2 ||
    (state.directions.every((direction) => !direction.ruleId) &&
      !state.accounts.some((account) => account.inGroup));
  const showOperatorNotice = props.operatorNotice !== "" && (ready < 2 || reconnect > 0);
  const attention = attentionOf(props, stats, showOperatorNotice, now);
  const entries = changeEntries(props.changes.rows, state, t);
  const header = firstRun && reconnect === 0 ? null : headerState(stats, reconnect, text.state);
  const showChanges = !firstRun || entries.length > 0;
  const side = attention.length > 0 || showChanges;
  return (
    <Shell
      title={text.title}
      user={props.user}
      active="overview"
      palette={{ state, providers: props.providers }}
      width="wide"
      attention={navAttention(state, props.outcomes, now, stats)}
      lead={header ? <HeaderLead state={header} now={now} /> : undefined}
      styles={["/next/overview.css"]}
    >
      {/* `--n`, the number of calendars on the map, sizes the map's track from 1920 px. */}
      <div class="ov" style={`--n:${ready}`}>
        {props.notice ? (
          <Notice kind={props.notice.kind === "error" ? "danger" : "info"}>
            {props.notice.text}
          </Notice>
        ) : null}
        <div class={side ? "ov-grid" : "ov-grid is-single"}>
          <div class="ov-main">
            {firstRun ? (
              <FirstRun state={state} ready={ready} />
            ) : (
              <WhatGoesWhere
                state={state}
                stats={stats}
                flows={calendarFlows(state, stats)}
                now={now}
              />
            )}
          </div>
          {side ? (
            <div class="ov-side">
              {attention.length > 0 ? <NeedsAttention items={attention} now={now} /> : null}
              {showChanges ? <Changes entries={entries} changes={props.changes} now={now} /> : null}
            </div>
          ) : null}
        </div>
      </div>
    </Shell>
  );
}
