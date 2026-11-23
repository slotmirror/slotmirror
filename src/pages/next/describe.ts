import { appPath } from "../../app-base";
import { parseDetail, type ActivityRow, type CleanupDetail } from "../../audit";
import {
  CHOICES,
  levelOf,
  type Choice,
  type EditorAccount,
  type EditorState,
  type Level,
} from "../../editor";
import { useI18n, type I18n, type Messages } from "../../i18n";
import { tally, type CompareFailedDetail, type CompareRunDetail } from "../../sync/compare";
import { stillSeen } from "./levels";
import { failureSentence } from "./overview";

/**
 * A time as "14:16" in the display zone of the page. `day` gives the calendar day of a time in that
 * zone ("2026-11-21") and `date` a short date ("Nov 21", "21.11."), for times on another day. A
 * clock without them falls back to the UTC day of the ISO string.
 */
export type Clock = ((iso: string) => string) & {
  day?: (iso: string) => string;
  date?: (iso: string) => string;
};

const clocks = new Map<string, Clock>();

/** The clock of a locale and time zone, built once per isolate: Intl setup costs CPU time. */
export function clockFor(i18n: Pick<I18n, "locale" | "timeZone">): Clock {
  const key = `${i18n.locale}|${i18n.timeZone}`;
  let clock = clocks.get(key);
  if (!clock) {
    const format = new Intl.DateTimeFormat(i18n.locale, {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: i18n.timeZone,
    });
    const days = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: i18n.timeZone,
    });
    const dates = new Intl.DateTimeFormat(
      i18n.locale,
      i18n.locale.startsWith("de")
        ? { day: "2-digit", month: "2-digit", timeZone: i18n.timeZone }
        : { day: "numeric", month: "short", timeZone: i18n.timeZone },
    );
    const valid = (iso: string) => !Number.isNaN(new Date(iso).getTime());
    clock = Object.assign((iso: string) => (valid(iso) ? format.format(new Date(iso)) : ""), {
      day: (iso: string) => (valid(iso) ? days.format(new Date(iso)) : iso.slice(0, 10)),
      date: (iso: string) => (valid(iso) ? dates.format(new Date(iso)) : iso.slice(5, 10)),
    });
    clocks.set(key, clock);
  }
  return clock;
}

/** The calendar day of a time on a clock, as "YYYY-MM-DD". */
function dayOf(clock: Clock, iso: string): string {
  return clock.day ? clock.day(iso) : iso.slice(0, 10);
}

/** The day before a "YYYY-MM-DD" key. Plain calendar arithmetic, so a 23 or 25 hour day is safe. */
function dayBefore(key: string): string {
  const [year = 0, month = 1, day = 1] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

/** The clock of the page that renders now; outside a page, English in UTC. */
function pageClock(): Clock {
  return clockFor(useI18n());
}

/** One audit row in plain language: the activity page uses this too. */
export interface DescribedActivity {
  title: string;
  detail: string;
  /** "danger" for a failed or stopped event, "warn" for a run that left changes undone. */
  tone: "danger" | "warn" | null;
  /** The calendars of the row's mirroring, if its rule still exists. */
  route?: { from: EditorAccount; to: EditorAccount };
  /** The calendar of a row without a mirroring, by the address of its connected account. */
  account?: EditorAccount;
  /** A finished run that changed nothing and failed at nothing. */
  quiet: boolean;
  durationMs?: number;
  /** Set if the catalog has no text for the kind: the title is neutral and this is the raw kind. */
  rawKind?: string;
  /** A sentence under the row: what happened and what to do. */
  explain?: string;
  /** Where the row leads: the mirroring of a run that ended without a result. */
  href?: string;
}

/** The page of a mirroring, as `mirroringHref` in `mirroring.tsx` builds it (no import: a cycle). */
function mirroringPage(from: string, to: string): string {
  return `${appPath("/mirroring")}?d=${encodeURIComponent(from)}~${encodeURIComponent(to)}`;
}

/**
 * The title of a kind. The log can hold a kind that this version does not know (retention keeps
 * rows of a removed feature for 90 days), so the lookup must not assume the catalog is complete.
 */
export function kindTitle(
  kind: string,
  name: string | null,
  t: Messages,
): { title: string; rawKind?: string } {
  const titles: Record<string, ((name: string | null) => string) | undefined> =
    t.next.describe.activity.kinds;
  const title = Object.hasOwn(titles, kind) ? titles[kind] : undefined;
  return title
    ? { title: title(name) }
    : { title: t.next.describe.activity.otherKind, rawKind: kind };
}

const FAILED_KINDS = new Set<ActivityRow["kind"]>([
  "sync_failed",
  "sync_run_aborted",
  "account_disconnect_failed",
  "token_refresh_failed",
  "compare_failed",
]);

/** The calendars of a row's rule, if the rule still exists. */
function routeOf(
  ruleId: string | null | undefined,
  state: EditorState,
): { from: EditorAccount; to: EditorAccount } | undefined {
  const end = ruleId ? state.rules.find((entry) => entry.rule.id === ruleId) : undefined;
  const from = end ? state.accounts.find((account) => account.id === end.from) : undefined;
  const to = end ? state.accounts.find((account) => account.id === end.to) : undefined;
  return from && to ? { from, to } : undefined;
}

/** The connected calendar of a row, by its ID or address, which the user's own view carries. */
function accountOf(row: ActivityRow, state: EditorState): EditorAccount | undefined {
  if (row.accountId) {
    const byId = state.accounts.find((account) => account.id === row.accountId);
    if (byId) return byId;
  }
  return row.accountEmail
    ? state.accounts.find((account) => account.email === row.accountEmail)
    : undefined;
}

/**
 * A calendar whose account was disconnected: its row is gone, so it has no name, only a neutral
 * label and colour. The ID keeps its mirrorings apart from those of other calendars.
 */
function goneAccount(id: string, t: Messages): EditorAccount {
  const name = t.next.describe.activity.goneCalendar;
  const account: EditorAccount = {
    id,
    provider: "microsoft",
    email: "",
    tenantId: null,
    createdAt: "",
    inGroup: false,
    needsReconnect: false,
    name,
    derivedName: name,
    customName: null,
    color: "slate",
    colorChosen: false,
    calendar: null,
    calendars: [],
    workHours: null,
    sourceOptions: null,
  };
  gone.add(account);
  return account;
}

/** The stand-ins of `goneAccount`: a title that starts with one starts with a capital. */
const gone = new WeakSet<EditorAccount>();

/**
 * The calendars of a row's mirroring. A save that turned a mirroring off deleted its rules, so their
 * IDs lead nowhere, also on the older rows of those rules. Every `rule_*` row names the source
 * account as `fromAccount` (`src/editor.ts`), and the row's own account is the target. A calendar
 * whose account was disconnected has no row any more: it shows as `goneAccount`, by its ID. That
 * needs the row's account ID, which only the viewer's own rows carry. Rows from before
 * `fromAccount` have no mirroring once their rule is gone.
 */
function routeOfRow(
  row: ActivityRow,
  state: EditorState,
  t: Messages,
): { from: EditorAccount; to: EditorAccount } | undefined {
  const route = routeOf(row.ruleId, state);
  if (route || !row.kind.startsWith("rule_")) return route;
  const { fromAccount } = parseDetail(row.detail) as LooseDetail;
  if (typeof fromAccount !== "string" || fromAccount === "") return undefined;
  const to = accountOf(row, state) ?? (row.accountId ? goneAccount(row.accountId, t) : undefined);
  if (!to) return undefined;
  const from =
    state.accounts.find((account) => account.id === fromAccount) ?? goneAccount(fromAccount, t);
  return { from, to };
}

/** "429:13,400:2" as "429 ×13, 400 ×2". */
function formatStatusList(statuses: string): string {
  return statuses
    .split(",")
    .map((pair) => pair.replace(":", " ×"))
    .join(", ");
}

/** The outcome of a comparison: counts or the reason of its failure. Hashes stay in the log. */
export function describeCompareDetail(row: ActivityRow, t: Messages): string {
  const text = t.next.describe.activity.detail;
  const detail = parseDetail(row.detail) as Partial<CompareRunDetail & CompareFailedDetail>;
  if (row.kind === "compare_failed") {
    const reason = detail.reason ? text.compareReasons[detail.reason] : "";
    return detail.code ? `${reason} (${detail.code})` : reason;
  }
  const parts: string[] = [];
  if (detail.deviations) {
    parts.push(
      text.compareFound(
        detail.missing ?? 0,
        detail.surplus ?? 0,
        detail.mismatched ?? 0,
        detail.duplicates ?? 0,
      ),
    );
  } else if (detail.clean) {
    parts.push(text.compareClean(detail.expected ?? 0));
  }
  if (detail.cleared) {
    const found = tally(detail.clearedHits?.split(",") ?? []);
    parts.push(
      text.compareCleared(
        detail.cleared,
        text.compareFound(found.missing, found.surplus, found.mismatched, found.duplicates),
      ),
    );
  }
  if (detail.unconfirmed) parts.push(text.compareUnconfirmed(detail.unconfirmed));
  if (detail.hitsCapped) parts.push(text.compareCapped);
  if (parts.length > 0) return parts.join(", ");
  return detail.mode === "leftover" ? text.compareNoLeftovers : text.compareNothing;
}

/** The outcome of an offboarding's removal: what went, what stayed, and why. */
function describeCleanupDetail(row: ActivityRow, t: Messages): string {
  const text = t.next.describe.activity.detail;
  const { result, removed, left, estimated } = parseDetail(row.detail) as Partial<CleanupDetail>;
  const parts = [text.cleanupRemoved(removed ?? 0)];
  if (left) parts.push(estimated ? text.cleanupAbout(left) : text.cleanupLeft(left));
  if (result && result !== "removed") parts.push(text.cleanupReasons[result]);
  return parts.join(", ");
}

/**
 * The detail line of the audit kinds that carry one, in the words of the glossary. It reads the
 * `next` catalog only: the old `describe` of the old activity page says "rule", "block" and "sync".
 */
export function describeDetail(row: ActivityRow, t: Messages): string {
  const text = t.next.describe.activity;
  const detail = parseDetail(row.detail);
  if (row.kind === "sync_run") {
    const changes = text.changes(detail.create ?? 0, detail.update ?? 0, detail.delete ?? 0);
    if (detail.dryRun) return text.detail.preview(changes);
    const parts = [changes];
    if (detail.failed) parts.push(t.next.describe.changes.failed(detail.failed));
    if (detail.throttled) parts.push(text.detail.throttled(detail.throttled));
    if (detail.remaining) parts.push(text.detail.remaining(detail.remaining));
    if (detail.statuses) parts.push(text.detail.statuses(formatStatusList(detail.statuses)));
    return parts.join(", ");
  }
  // The row explains itself in `explain` (see `describeActivity`); the detail stays empty.
  if (row.kind === "sync_run_aborted") return "";
  if (row.kind === "alert_sent") {
    const alerts: Record<string, string> = text.detail.alerts;
    return alerts[detail.code ?? ""] ?? detail.code ?? "";
  }
  if (row.kind === "compare_run" || row.kind === "compare_failed") {
    return describeCompareDetail(row, t);
  }
  if (row.kind === "cleanup_finished") return describeCleanupDetail(row, t);
  if (row.kind === "account_disconnect_failed") return text.detail.disconnectFailed;
  return detail.code ?? "";
}

/**
 * One audit row in plain language. A calendar gets its name where the data names it: the audit row
 * holds the address of the connected calendar, and the state maps that to the name the user knows.
 * A sync event names both calendars if its rule still exists; otherwise only the target.
 */
export function describeActivity(
  row: ActivityRow,
  state: EditorState,
  t: Messages,
  options: {
    clock?: Clock;
    /** The mirroring the list is filtered to, as `<from>~<to>`: its rows do not repeat its name. */
    mirroring?: string;
    /** Later changes of the row's rule, oldest first: they can end a time the row started. */
    later?: TimedStep[];
    /** The current levels of the rules, for times whose end lies beyond the rows. */
    current?: CurrentLevel;
  } = {},
): DescribedActivity {
  const text = t.next.describe;
  const problems = t.next.overview.problems;
  const account = accountOf(row, state);
  const name = account?.name ?? null;
  const detail = parseDetail(row.detail);
  const route = routeOfRow(row, state, t);
  const step = levelStep(row);
  const named = route !== undefined && options.mirroring !== `${route.from.id}~${route.to.id}`;
  let note = "";
  let tone: DescribedActivity["tone"] = FAILED_KINDS.has(row.kind)
    ? "danger"
    : row.kind === "account_paused"
      ? "warn"
      : null;
  let quiet = false;
  if (row.kind === "sync_run" && !detail.dryRun) {
    const changes = [detail.create ?? 0, detail.update ?? 0, detail.delete ?? 0] as const;
    const parts = changes.some(Boolean)
      ? [text.activity.changes(...changes)]
      : (detail.failed ?? 0) > 0
        ? []
        : [text.activity.noChanges];
    quiet = !changes.some(Boolean) && !(detail.failed ?? 0);
    if (detail.failed) {
      parts.push(text.changes.failed(detail.failed));
      tone = "warn";
    }
    note = parts.join(", ");
  } else if (row.kind === "sync_failed") {
    const sentence = failureSentence({ kind: "sync_failed", detail }, problems);
    note = sentence.code ? `${sentence.text} ${sentence.code}` : sentence.text;
  } else if (
    row.kind === "sync_run" ||
    row.kind === "sync_run_aborted" ||
    row.kind === "account_disconnect_failed" ||
    row.kind === "cleanup_finished" ||
    row.kind === "alert_sent" ||
    row.kind === "compare_run" ||
    row.kind === "compare_failed"
  ) {
    note = describeDetail(row, t);
  }
  const known = kindTitle(row.kind, name, t);
  let title = known.title;
  // A change of the level or the details of a mirroring: the mirroring is the title, what changed
  // is the detail. A turned off mirroring says so, also after its rule was deleted. A turn on or a
  // pause keeps its own title and names its level in the detail.
  const toggle = row.kind === "rule_enabled" || row.kind === "rule_paused";
  const levelChange = row.kind === "rule_updated" || (step !== null && row.kind === "rule_deleted");
  const turnedOff = step !== null && step.after.choice === "off" && step.before?.choice !== "off";
  if (route && named) {
    const { from, to } = { from: route.from.name, to: route.to.name };
    if (row.kind === "sync_run") title = text.activity.route(from, to);
    if (row.kind === "sync_failed") title = text.activity.routeFailed(from, to);
    if (row.kind === "sync_run_aborted") title = text.activity.routeStopped(from, to);
    if (row.kind === "rule_created") title = text.activity.routeAdded(from, to);
    if (levelChange) {
      title = turnedOff ? text.activity.routeOff(from, to) : text.activity.routeChanged(from, to);
    }
    // "a disconnected calendar to work added" starts the title: "A disconnected …".
    if (gone.has(route.from)) title = title.charAt(0).toUpperCase() + title.slice(1);
  } else if (route) {
    // The list shows this mirroring only: the title names what happened, not the mirroring again.
    title = kindTitle(row.kind, null, t).title;
    if (levelChange && turnedOff) title = text.activity.turnedOff;
  }
  if (route && (levelChange || row.kind === "rule_created" || (toggle && step !== null))) {
    note = describeChanges([row], t, options.clock, options.later, {
      current: options.current,
      target: route?.to.name,
    });
  }
  // A rule whose copies were not queued for removal: they can still be in the target. A time of
  // the row may say so already.
  const left = route ? copiesLeftText([row], route.to.name, t, options.later) : "";
  if (left && !note.includes(left)) note = [note, left].filter(Boolean).join(" · ");
  // Another change of a mirroring names which one, unless the list shows only that one.
  if (route && named && !note && row.kind.startsWith("rule_")) {
    note = text.activity.route(route.from.name, route.to.name);
  }
  return {
    title,
    detail: note,
    tone,
    route,
    account: route ? undefined : account,
    quiet,
    durationMs: detail.durationMs,
    rawKind: known.rawKind,
    ...(row.kind === "sync_run_aborted"
      ? {
          explain: text.activity.detail.abortedExplain,
          ...(route ? { href: mirroringPage(route.from.id, route.to.id) } : {}),
        }
      : {}),
  };
}

/** What one entry of the changes list is about. */
export type ChangeSubject =
  | { route: { from: EditorAccount; to: EditorAccount } }
  | { account: EditorAccount }
  | { text: string };

/** A level as an audit row records it. `markPrivate` is missing where the row does not name it. */
export interface RecordedLevel {
  choice: Choice;
  markPrivate?: boolean;
}

/** The level of one rule before and after a change. `before` is missing in old rows. */
export interface LevelStep {
  before?: RecordedLevel;
  after: RecordedLevel;
}

/**
 * One entry of "Changes, last 24 h". A mirroring gets one entry with everything that happened to
 * it: the times in which others saw more, the level changes (without those that cancel out and
 * showed nothing more to others), the other changes and the runs added up.
 * A calendar event or a change of the settings for all mirrorings is an entry of its own.
 */
export interface ChangeEntry {
  /** `m:<from>~<to>` for a mirroring; other entries have other prefixes. */
  key: string;
  /** The newest row that the entry shows. */
  at: string;
  subject: ChangeSubject;
  /** The mirroring of the entry. Set exactly when `subject` is a route. */
  route?: { from: EditorAccount; to: EditorAccount };
  /** How often the level changed, one per save. 0 if it did not, or if the changes cancel out. */
  levelChanges: number;
  /** The level after the newest change. Set exactly when `levelChanges` is above 0. */
  latestLevel?: RecordedLevel & { label: string };
  /** Each time in which others saw more of a mirroring's copies, in words, oldest first. */
  exposures?: string[];
  /** The other changes of a mirroring in words, newest first, each once. */
  details: string[];
  /** Sums over the runs of a mirroring that created, updated, removed or failed something. */
  sync?: { created: number; updated: number; removed: number; failed: number };
  /**
   * What the user changed, in words: for a mirroring the level and the details joined with " · ",
   * for other entries the event. Missing for a mirroring whose only news are runs.
   */
  text?: string;
  /** Rows joined into this entry. */
  count: number;
}

type LooseDetail = Record<string, unknown>;

function isChoice(value: unknown): value is Choice {
  return typeof value === "string" && (CHOICES as readonly string[]).includes(value);
}

function recorded(choice: Choice, markPrivate: unknown): RecordedLevel {
  return choice !== "off" && typeof markPrivate === "boolean"
    ? { choice, markPrivate }
    : { choice };
}

/** Kinds whose rows can name a level change of their rule. */
const LEVEL_KINDS = new Set<ActivityRow["kind"]>([
  "rule_created",
  "rule_updated",
  "rule_deleted",
  "rule_enabled",
  "rule_paused",
]);

/**
 * The level change of a `rule_created` or `rule_updated` row, from its audit detail; null for
 * other rows and for a change of details only. `setDirections` in `src/editor.ts` records the
 * level before as `previousChoice` and `previousMarkPrivate`; older rows have no `before`. A new
 * rule starts from "off". A `rule_deleted` row of a save that turned the mirroring off has the
 * choice "off". A turn on or a pause of the old rules page names its level since that field
 * exists; older ones name none. A row without a mark changed only the detail level: a rule that
 * was copied before keeps its mark (`setDirections`), so the mark after is the mark before.
 */
export function levelStep(row: ActivityRow): LevelStep | null {
  if (!LEVEL_KINDS.has(row.kind)) return null;
  const detail = parseDetail(row.detail) as LooseDetail;
  if (!isChoice(detail.choice)) return null;
  // A deleted rule is a level change only if a save turned its mirroring off; older rows and
  // other deletions name no choice.
  if (row.kind === "rule_deleted" && detail.choice !== "off") return null;
  const before =
    row.kind === "rule_created"
      ? ({ choice: "off" } satisfies RecordedLevel)
      : isChoice(detail.previousChoice)
        ? recorded(detail.previousChoice, detail.previousMarkPrivate)
        : undefined;
  const mark =
    typeof detail.markPrivate === "boolean"
      ? detail.markPrivate
      : before && before.choice !== "off"
        ? before.markPrivate
        : undefined;
  const after = recorded(detail.choice, mark);
  return before ? { before, after } : { after };
}

/**
 * Two recorded levels are the same if they name the same choice and, for a copied choice, the
 * same mark. An unknown mark is never the same: a change that may have changed what others see
 * must not disappear.
 */
export function sameLevel(a: RecordedLevel, b: RecordedLevel): boolean {
  if (a.choice !== b.choice) return false;
  if (a.choice === "off") return true;
  return a.markPrivate !== undefined && a.markPrivate === b.markPrivate;
}

/** A level in the words of the level summaries; the bare choice if the mark is not known. */
export function levelLabel(level: RecordedLevel, t: Messages): string {
  if (level.choice === "off") return t.next.shell.levels.summary.off;
  if (level.markPrivate === undefined) return t.next.describe.changes.choices[level.choice];
  return t.next.shell.levels.summary[levelOf(level.choice, level.markPrivate)];
}

/** A level at which others with access to the target see the copies as the owner does. */
export type OpenLevel = "busy-open" | "title-open" | "full-open";

/**
 * A time in which others saw the copies of a mirroring as they are: from the save that showed them,
 * until the save that hid them again. `until` is missing while the rows show no such save. `from`
 * is missing only for a time that began before the rows and ended in them (see `exposuresOf`).
 */
export interface Exposure {
  level: OpenLevel;
  from?: string;
  until?: string;
  /**
   * The rows show no end, but the rule's current level shows less (also "off"): the time ended
   * after the rows, at a time the rows do not hold (see `exposuresWithin`).
   */
  ended?: boolean;
  /**
   * The rule was removed, and no queued removal of its copies is known: its deletion row says the
   * removal failed, or the rows do not hold that row. The copies may still show (see
   * `exposuresWithin`).
   */
  removed?: boolean;
  /**
   * The newest step of the rule was a pause that queued no removal (`cleanup: "none"`, the old
   * rules page): the copies stay in the target and keep showing.
   */
  kept?: boolean;
}

/**
 * The current level of a rule by its ID: undefined if the rule is gone, null if its level is not
 * known (another person's row, or a state without options).
 */
export type CurrentLevel = (ruleId: string) => Level | null | undefined;

/** The current levels of the rules of a state, for `exposuresWithin`. */
export function currentLevels(state: EditorState): CurrentLevel {
  return (ruleId) => {
    if (ruleId === "") return null;
    const entry = state.rules.find(({ rule }) => rule.id === ruleId);
    if (!entry) return undefined;
    const { rule } = entry;
    // A disabled rule (paused, an exception turned off, held by an offboarding) copies nothing. A
    // state without the field does not know.
    if (rule.enabled === false) return "off";
    if (rule.enabled !== true) return null;
    const choice = rule.options?.detailLevel;
    const mark = rule.options?.markPrivate;
    if (choice === undefined || typeof mark !== "boolean") return null;
    return levelOf(choice === "title_location" ? "title" : choice, mark);
  };
}

/** What `exposuresWithin` and the texts of exposures take besides the steps. */
export interface ExposureOptions {
  /** Keep times that began before the steps and ended in them (see `exposuresOf`). */
  seeded?: boolean;
  /** The current levels: a time without an end in the rows ends if its rule shows less now. */
  current?: CurrentLevel;
  /** For a list of the last hours: a time of another day names "yesterday" or its date. */
  now?: number;
  /** The name of the target calendar, for "copies may still be in {target}". */
  target?: string;
}

/** A level change of one rule, with its time. */
export interface TimedStep {
  ruleId: string;
  step: LevelStep;
  at: string;
  /**
   * The rule went without a level change of its mirroring, for example with its source calendar:
   * it ends the rule's times, but the mirroring's level stays (see `removalStep`).
   */
  removal?: boolean;
  /**
   * The removal of the rule's copies could not be queued (`cleanupFailed`): the copies can still
   * be in the target, so the step ends no time.
   */
  copiesLeft?: boolean;
  /** A pause that queued no removal (`cleanup: "none"`): the copies stay, so it ends no time. */
  copiesKept?: boolean;
}

/** The level of a recorded level; null if its mark is not known. */
function knownLevel(level: RecordedLevel): Level | null {
  if (level.choice === "off") return "off";
  return level.markPrivate === undefined ? null : levelOf(level.choice, level.markPrivate);
}

function isOpen(level: Level | null): level is OpenLevel {
  return level === "busy-open" || level === "title-open" || level === "full-open";
}

/**
 * The level that a step reaches, for finding times in which others saw more. A copied choice
 * without a known mark counts as open: an unknown never hides a widening.
 */
function reachedLevel(level: RecordedLevel): Level {
  if (level.choice === "off") return "off";
  return levelOf(level.choice, level.markPrivate ?? false);
}

/**
 * True if a step to an open level let others see more than before. `stillSeen(after, before)`
 * names what others still see when `after` goes back to `before`: it is set exactly when others
 * saw more at `after`. From "Not copied", or from a level that is not known, every open level
 * shows more.
 */
function widened(before: RecordedLevel | undefined, after: OpenLevel): boolean {
  const known = before ? knownLevel(before) : null;
  if (known === null || known === "off") return true;
  return stillSeen(after, known) !== null;
}

/** True if others see less after a step than at `level`. An unknown mark counts as open. */
function hides(level: OpenLevel, after: RecordedLevel): boolean {
  if (after.choice === "off") return true;
  return stillSeen(level, levelOf(after.choice, after.markPrivate ?? false)) !== null;
}

/**
 * The times in which others saw more of a mirroring's copies than before, oldest first, per rule.
 * A level that was open before the oldest step has no start in the steps and is left out: these
 * steps did not widen it. With `seeded`, such a time is kept without `from` if a step ends it, so
 * that a list of a fixed window names a widening that began before it. A step down to a lower open
 * level ends the higher time; the lower level keeps the start of the time it ends, since others
 * saw at least that much since then. A step to a copied choice without a known mark counts as open.
 */
export function exposuresOf(steps: TimedStep[], options: ExposureOptions = {}): Exposure[] {
  const byRule = new Map<string, TimedStep[]>();
  for (const step of steps) byRule.set(step.ruleId, [...(byRule.get(step.ruleId) ?? []), step]);
  const found: Exposure[] = [];
  for (const list of byRule.values()) {
    let open: { level: OpenLevel; from: string | null }[] = [];
    const before = list[0]?.step.before;
    const seeded = before ? knownLevel(before) : null;
    if (isOpen(seeded)) open.push({ level: seeded, from: null });
    for (const { step, at, copiesLeft, copiesKept } of list) {
      // Copies that may still be in the target keep showing what they showed.
      const closed =
        copiesLeft || copiesKept ? [] : open.filter((entry) => hides(entry.level, step.after));
      open = open.filter((entry) => !closed.includes(entry));
      for (const entry of closed) {
        if (entry.from !== null) found.push({ level: entry.level, from: entry.from, until: at });
        else if (options.seeded) found.push({ level: entry.level, until: at });
      }
      const after = reachedLevel(step.after);
      if (!isOpen(after) || open.some((entry) => entry.level === after)) continue;
      // The earliest start of the times it ends; none if one of them began before the steps.
      let inherited: string | null = null;
      for (const entry of closed) {
        if (entry.from === null) {
          inherited = null;
          break;
        }
        if (inherited === null || entry.from < inherited) inherited = entry.from;
      }
      open.push({ level: after, from: widened(step.before, after) ? at : inherited });
    }
    for (const entry of open) {
      if (entry.from !== null) found.push({ level: entry.level, from: entry.from });
    }
  }
  const key = (exposure: Exposure) => exposure.from ?? exposure.until ?? "";
  return found.toSorted((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/**
 * The times that `own` steps started, with their ends in `later` steps of the same rules (newer
 * rows of the same data, oldest first). A turn off in a newer row of a page then ends a time that
 * an older row of the page started, also across items. Times that began in `later` stay out.
 *
 * A time without an end in these rows is checked against `current`, for example when its end lies
 * beyond the scan of later rows:
 * - The last step left copies behind (`copiesLeft`), or the rule is gone and the rows hold no
 *   deletion with a queued removal: `removed`, the copies may still show.
 * - The current level shows less, also "off" (a disabled, paused or held rule): `ended`. If it is
 *   a lower open level, a time at that level stays open from the start of the time it ends, as a
 *   step down does in `exposuresOf`.
 * - The current level still shows it, or it is not known: it stays open.
 */
export function exposuresWithin(
  own: TimedStep[],
  later: TimedStep[] = [],
  options: ExposureOptions = {},
): Exposure[] {
  if (later.length === 0 && !options.current) return exposuresOf(own, options);
  const found: Exposure[] = [];
  for (const ruleId of new Set(own.map((step) => step.ruleId))) {
    const mine = own.filter((step) => step.ruleId === ruleId);
    const starts = new Set(mine.map((step) => step.at));
    const next = later.filter((step) => step.ruleId === ruleId);
    const steps = [...mine, ...next];
    const copiesLeft = steps.at(-1)?.copiesLeft === true;
    // A paused rule reads as "off" in the state, but a pause that queued no removal left its
    // copies showing: the newest known step decides, not the state.
    const copiesKept = steps.at(-1)?.copiesKept === true;
    const level = options.current?.(ruleId);
    const stillOpen = new Set<OpenLevel>();
    // Starts of the times that a lower open level now ends.
    const lowered: string[] = [];
    for (const exposure of exposuresOf(steps, options)) {
      const ownStart = exposure.from !== undefined && starts.has(exposure.from);
      const ownEnd = exposure.from === undefined && starts.has(exposure.until ?? "");
      if (!ownStart && !ownEnd) continue;
      if (exposure.until !== undefined) found.push(exposure);
      else if (copiesKept) found.push({ ...exposure, kept: true });
      else if (copiesLeft || (options.current !== undefined && level === undefined)) {
        found.push({ ...exposure, removed: true });
      } else if (
        options.current === undefined ||
        level === null ||
        (level !== undefined && level !== "off" && stillSeen(exposure.level, level) === null)
      ) {
        found.push(exposure);
        stillOpen.add(exposure.level);
      } else {
        found.push({ ...exposure, ended: true });
        if (exposure.from !== undefined) lowered.push(exposure.from);
      }
    }
    if (isOpen(level ?? null) && lowered.length > 0 && !stillOpen.has(level as OpenLevel)) {
      found.push({ level: level as OpenLevel, from: lowered.toSorted()[0] });
    }
  }
  const key = (exposure: Exposure) => exposure.from ?? exposure.until ?? "";
  return found.toSorted((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/**
 * A time of an exposure: the clock alone, or with `now` for a time of another day "yesterday 14:04"
 * or "Nov 19, 14:04".
 */
function stamp(iso: string, t: Messages, clock: Clock, now?: number): string {
  const text = t.next.describe.changes.exposure;
  const time = clock(iso);
  if (now === undefined) return time;
  const day = dayOf(clock, iso);
  const today = dayOf(clock, new Date(now).toISOString());
  if (day === today) return time;
  if (day === dayBefore(today)) return text.yesterday(time);
  return text.dated(clock.date ? clock.date(iso) : iso.slice(5, 10), time);
}

/**
 * An exposure in words: "Titles visible to others 14:16–14:18", "… from 14:16" if open, "… from
 * 14:16, ended later" if it ended after the rows, "… from 14:16, then removed; copies may still be
 * in {target}" if its rule went without a known removal of the copies. An end on another day than
 * the start has its date ("10:00 – Nov 21, 08:30"). With `now`, a start of another day names it
 * (see `stamp`).
 */
export function exposureText(
  exposure: Exposure,
  t: Messages,
  clock: Clock,
  now?: number,
  target?: string,
): string {
  const text = t.next.describe.changes.exposure;
  const what = text.what[exposure.level];
  if (exposure.from === undefined) {
    return text.until(what, stamp(exposure.until ?? "", t, clock, now));
  }
  const from = stamp(exposure.from, t, clock, now);
  if (exposure.until === undefined) {
    if (exposure.removed) return text.fromRemoved(what, from, target);
    if (exposure.kept) return text.fromKept(what, from, target);
    return exposure.ended ? text.fromEnded(what, from) : text.from(what, from);
  }
  // One minute only if it is the same minute; an end on another day has its date.
  if (exposure.from.slice(0, 16) === exposure.until.slice(0, 16)) return text.at(what, from);
  if (dayOf(clock, exposure.from) !== dayOf(clock, exposure.until)) {
    const date = clock.date ? clock.date(exposure.until) : exposure.until.slice(5, 10);
    return text.rangeDays(what, from, text.dated(date, clock(exposure.until)));
  }
  return text.range(what, from, clock(exposure.until));
}

/** The exposures of steps in words, each once (one save writes a row per rule). */
function exposureTexts(
  steps: TimedStep[],
  t: Messages,
  clock: Clock,
  later: TimedStep[] = [],
  options: ExposureOptions = {},
): string[] {
  return [
    ...new Set(
      exposuresWithin(steps, later, options).map((exposure) =>
        exposureText(exposure, t, clock, options.now, options.target),
      ),
    ),
  ];
}

/** True if a `rule_deleted` row says that the removal of the rule's copies was not queued. */
function leftCopies(row: ActivityRow): boolean {
  if (row.kind !== "rule_deleted") return false;
  return (parseDetail(row.detail) as LooseDetail).cleanupFailed === true;
}

/**
 * True if a row stopped a rule without a removal of its copies (`cleanup: "none"`): a pause of the
 * old rules page, or a parked rule whose removal could not be queued.
 */
function keptCopies(row: ActivityRow): boolean {
  if (row.kind !== "rule_paused" && row.kind !== "rule_updated") return false;
  return (parseDetail(row.detail) as LooseDetail).cleanup === "none";
}

/** True if the newest step of any rule among `steps` (oldest first) left its copies behind. */
function newestLeftCopies(steps: TimedStep[]): boolean {
  const newest = new Map<string, TimedStep>();
  for (const step of steps) newest.set(step.ruleId, step);
  return [...newest.values()].some((step) => step.copiesLeft === true || step.copiesKept === true);
}

/**
 * "Copies may still be in {target}" if the newest known step of one of the rows' rules left its
 * copies behind: a deletion whose removal failed, or a pause without a removal. `later` holds the
 * newer steps of the same rules (oldest first): a turn off with a queued removal or a turn on
 * again after such a step takes the sentence away, as in `exposuresWithin`. Empty otherwise.
 */
export function copiesLeftText(
  rows: ActivityRow[],
  target: string,
  t: Messages,
  later: TimedStep[] = [],
): string {
  return newestLeftCopies([...timedSteps(rows), ...later])
    ? t.next.describe.changes.copiesLeft(target)
    : "";
}

/**
 * The end of a rule that went without a level change of its mirroring: a `rule_deleted` row
 * without the choice "off" (a source calendar turned off, a rule deleted on the old page, a group
 * left), or a pause from before pauses named their level. The rule copies nothing after it.
 */
export function removalStep(row: ActivityRow): LevelStep | null {
  if (row.kind !== "rule_deleted" && row.kind !== "rule_paused") return null;
  if (levelStep(row)) return null;
  const detail = parseDetail(row.detail) as LooseDetail;
  // A parked exception that another choice replaced wrote nothing.
  if (detail.parked !== undefined) return null;
  const before = isChoice(detail.previousChoice)
    ? recorded(detail.previousChoice, detail.previousMarkPrivate)
    : undefined;
  return before ? { before, after: { choice: "off" } } : { after: { choice: "off" } };
}

/** The level steps and rule ends of one row, with its rule and time. */
export function timedStepOf(row: ActivityRow): TimedStep | null {
  const copiesLeft = {
    ...(leftCopies(row) ? { copiesLeft: true } : {}),
    ...(keptCopies(row) ? { copiesKept: true } : {}),
  };
  const step = levelStep(row);
  if (step) return { ruleId: row.ruleId ?? "", step, at: row.createdAt, ...copiesLeft };
  const end = removalStep(row);
  return end
    ? { ruleId: row.ruleId ?? "", step: end, at: row.createdAt, removal: true, ...copiesLeft }
    : null;
}

/** The level steps of rows (newest first) with their rule and time, oldest first. */
function timedSteps(rows: ActivityRow[]): TimedStep[] {
  return [...rows].reverse().flatMap((row) => {
    const step = timedStepOf(row);
    return step ? [step] : [];
  });
}

/** The steps that change the level of a mirroring: rule ends without one stay out. */
function levelSteps(steps: TimedStep[]): LevelStep[] {
  return steps.flatMap(({ step, removal }) => (removal ? [] : [step]));
}

/** The level changes of one mirroring added up: how many, from which level, to which. */
interface NetLevelChange {
  count: number;
  before?: RecordedLevel;
  after: RecordedLevel;
  /** The newest level equals the level before the oldest change. */
  cancelled: boolean;
}

/**
 * Steps of one mirroring, oldest first, as saves. A step that did not change its rule is left out.
 * Following steps with the same level after are one save: one save writes a row per rule, and a
 * mirroring has a rule per source calendar. Null if no step is left.
 */
function netLevelChange(steps: LevelStep[]): NetLevelChange | null {
  const changes = steps.filter((step) => !step.before || !sameLevel(step.before, step.after));
  const saves = changes.filter((step, index) => {
    const previous = changes[index - 1]?.after;
    return (
      !previous ||
      previous.choice !== step.after.choice ||
      previous.markPrivate !== step.after.markPrivate
    );
  });
  const first = saves[0];
  const last = saves.at(-1);
  if (!first || !last) return null;
  return {
    count: saves.length,
    before: first.before,
    after: last.after,
    cancelled: first.before !== undefined && sameLevel(first.before, last.after),
  };
}

/**
 * The details a `rule_updated` row names (`writePatches` and `setDirections` in `src/editor.ts`).
 * The category names and the block title are never in the row.
 */
function detailWords(detail: LooseDetail, t: Messages): string[] {
  const text = t.next.describe.changes;
  const words: string[] = [];
  if (typeof detail.workDays === "string") words.push(text.hours);
  if (detail.blockColor !== undefined) words.push(text.colour);
  if (typeof detail.onlyCategories === "string") {
    words.push(text.categories(Number(detail.onlyCategories) || 0));
  }
  if (typeof detail.bufferBefore === "string" && typeof detail.bufferAfter === "string") {
    words.push(text.buffer(detail.bufferBefore, detail.bufferAfter));
  }
  return words;
}

/**
 * What one or more level or detail rows of one mirroring changed, newest row first, for the
 * activity page. First every time in which others saw more than before (see `exposuresOf`), so
 * that changes which end where they started never hide it. Then the level as "{old} → {new}" (or
 * "Now: {new}" for rows without the level before, or after an exposure that ended where it
 * started), then the details, each once.
 */
export function describeChanges(
  rows: ActivityRow[],
  t: Messages,
  clock: Clock = pageClock(),
  /** Later changes of the same rules, oldest first: they end times that `rows` started. */
  later: TimedStep[] = [],
  options: ExposureOptions = {},
): string {
  const text = t.next.describe.changes;
  const timed = timedSteps(rows);
  const steps = levelSteps(timed);
  const net = netLevelChange(steps);
  const parts: string[] = exposureTexts(timed, t, clock, later, options);
  if (net) {
    const after = levelLabel(net.after, t);
    if (net.cancelled) {
      parts.push(parts.length > 0 ? text.now(after) : text.levelBack(after, net.count));
    } else if (net.before) parts.push(`${levelLabel(net.before, t)} → ${after}`);
    else parts.push(text.now(after));
  }
  for (const row of rows) {
    for (const word of detailWords(parseDetail(row.detail) as LooseDetail, t)) {
      if (!parts.includes(word)) parts.push(word);
    }
  }
  // A level row that changed nothing, for example a rule that had this level already.
  if (parts.length === 0) {
    const last = steps.at(-1);
    return last ? text.now(levelLabel(last.after, t)) : text.changed;
  }
  return parts.join(" · ");
}

/**
 * How many saves changed the level in `rows` of one mirroring (newest first), and whether they
 * cancel out. The activity page adds the count to a joined row.
 */
export function levelChangeCount(rows: ActivityRow[]): { count: number; cancelled: boolean } {
  const net = netLevelChange(levelSteps(timedSteps(rows)));
  return { count: net?.count ?? 0, cancelled: net?.cancelled ?? false };
}

/** True if a row changed the level of its rule, also an old row without the level before. */
export function changesLevel(row: ActivityRow): boolean {
  const step = levelStep(row);
  return step !== null && (!step.before || !sameLevel(step.before, step.after));
}

/** What a change that is not about a mirroring says. */
function eventText(row: ActivityRow, t: Messages): string {
  const text = t.next.describe.changes;
  switch (row.kind) {
    case "rule_created": {
      const step = levelStep(row);
      return step ? text.added(levelLabel(step.after, t)) : text.changed;
    }
    case "rule_updated":
      return describeChanges([row], t);
    case "rule_deleted":
      return text.deleted;
    case "rule_enabled":
      return text.enabled;
    case "rule_paused":
      return text.paused;
    case "settings_changed":
      return text.settings;
    case "account_connected":
      return text.connected;
    case "account_disconnected":
      return text.disconnected;
    case "account_renamed":
      return text.renamed;
    default:
      return text.changed;
  }
}

/** The rows of one mirroring while `changeEntries` reads them, newest first. */
interface MirroringRows {
  route: { from: EditorAccount; to: EditorAccount };
  steps: TimedStep[];
  details: { word: string; at: string }[];
  toggles: { on: boolean; at: string }[];
  sync?: NonNullable<ChangeEntry["sync"]>;
  syncAt?: string;
  count: number;
}

const newer = (a: string | undefined, b: string | undefined): string | undefined =>
  a === undefined ? b : b === undefined ? a : a > b ? a : b;

/**
 * One mirroring's entry, or null if nothing is left once the changes that cancel out are gone.
 * Changes that let others see more never cancel out: the entry names each such time first.
 */
function mirroringEntry(
  rows: MirroringRows,
  t: Messages,
  clock: Clock,
  options: ExposureOptions,
): ChangeEntry | null {
  const text = t.next.describe.changes;
  const oldestFirst = [...rows.steps].reverse();
  const net = netLevelChange(levelSteps(oldestFirst));
  // The list covers a fixed window: a time that began before it and ended in it is named too.
  const exposures = exposureTexts(oldestFirst, t, clock, [], {
    ...options,
    seeded: true,
    target: rows.route.to.name,
  });
  const level = net && (!net.cancelled || exposures.length > 0) ? net : null;
  let at = level ? rows.steps[0]?.at : undefined;
  const details: string[] = [];
  // A pause and a turn on again cancel out: the oldest and the newest toggle differ.
  const lastToggle = rows.toggles[0];
  const firstToggle = rows.toggles.at(-1);
  if (lastToggle && firstToggle && lastToggle.on === firstToggle.on) {
    details.push(lastToggle.on ? text.enabled : text.paused);
    at = newer(at, lastToggle.at);
  }
  for (const { word, at: wordAt } of rows.details) {
    if (!details.includes(word)) details.push(word);
    at = newer(at, wordAt);
  }
  // The newest step of each rule decides, as for the times: rows.steps is newest first.
  const left = text.copiesLeft(rows.route.to.name);
  const copiesLeft = newestLeftCopies(oldestFirst);
  if (copiesLeft && !exposures.some((words) => words.includes(left))) details.push(left);
  at = newer(at, rows.syncAt);
  if (!level && details.length === 0 && !rows.sync) return null;
  const parts = [
    ...exposures,
    ...(level ? [text.levelChanged(level.count, levelLabel(level.after, t))] : []),
    ...details,
  ];
  const { from, to } = rows.route;
  return {
    key: `m:${from.id}~${to.id}`,
    at: at ?? "",
    subject: { route: rows.route },
    route: rows.route,
    levelChanges: level?.count ?? 0,
    ...(level ? { latestLevel: { ...level.after, label: levelLabel(level.after, t) } } : {}),
    exposures,
    details,
    ...(rows.sync ? { sync: rows.sync } : {}),
    ...(parts.length > 0 ? { text: parts.join(" · ") } : {}),
    count: rows.count,
  };
}

/**
 * The entries of the changes list, newest first. Everything about one mirroring is one entry (see
 * `ChangeEntry`); runs without a change never reach this (`recentChanges` leaves them out). Other
 * changes that read the same join, with a count. A run whose rule is gone counts under its target
 * calendar; so does a change of a rule that is gone, because its mirroring is not known any more.
 */
export function changeEntries(
  rows: ActivityRow[],
  state: EditorState,
  t: Messages,
  clock: Clock = pageClock(),
  /** Now, so that a time of another day names "yesterday" or its date. */
  now: number = Date.now(),
): ChangeEntry[] {
  const mirrorings = new Map<string, MirroringRows>();
  const others = new Map<string, ChangeEntry>();
  const emptySync = () => ({ created: 0, updated: 0, removed: 0, failed: 0 });
  for (const row of rows) {
    if (row.context) continue;
    const route = routeOfRow(row, state, t);
    const account = accountOf(row, state);
    const detail = parseDetail(row.detail);
    if (row.kind === "sync_run" && detail.dryRun) continue;
    if (route) {
      const key = `${route.from.id}~${route.to.id}`;
      const known = mirrorings.get(key) ?? {
        route,
        steps: [],
        details: [],
        toggles: [],
        count: 0,
      };
      known.count++;
      mirrorings.set(key, known);
      if (row.kind === "sync_run") {
        const sums = known.sync ?? emptySync();
        sums.created += detail.create ?? 0;
        sums.updated += detail.update ?? 0;
        sums.removed += detail.delete ?? 0;
        sums.failed += detail.failed ?? 0;
        known.sync = sums;
        known.syncAt = newer(known.syncAt, row.createdAt);
        continue;
      }
      const step = levelStep(row);
      const timed = timedStepOf(row);
      if (timed) known.steps.push(timed);
      // A turn on or a pause that names its level is a level change; older ones are toggles.
      if ((row.kind === "rule_enabled" || row.kind === "rule_paused") && !step) {
        known.toggles.push({ on: row.kind === "rule_enabled", at: row.createdAt });
      } else if (row.kind === "rule_updated") {
        const words = detailWords(detail as LooseDetail, t);
        if (!step && words.length === 0) words.push(t.next.describe.changes.changed);
        for (const word of words) known.details.push({ word, at: row.createdAt });
      } else if (!step) {
        known.details.push({ word: eventText(row, t), at: row.createdAt });
      }
      continue;
    }
    if (row.kind === "sync_run") {
      if (!account) continue;
      const key = `sync:@${account.id}`;
      const entry = others.get(key) ?? {
        key,
        at: row.createdAt,
        subject: { text: t.next.describe.activity.kinds.sync_run(account.name) },
        levelChanges: 0,
        details: [],
        sync: emptySync(),
        count: 0,
      };
      const sums = entry.sync ?? emptySync();
      sums.created += detail.create ?? 0;
      sums.updated += detail.update ?? 0;
      sums.removed += detail.delete ?? 0;
      sums.failed += detail.failed ?? 0;
      entry.sync = sums;
      entry.count++;
      others.set(key, entry);
      continue;
    }
    const subject: ChangeSubject =
      row.kind === "settings_changed"
        ? { text: t.next.describe.changes.allMirrorings }
        : account
          ? { account }
          : { text: kindTitle(row.kind, null, t).title };
    const text = eventText(row, t);
    const about =
      "account" in subject ? `@${subject.account.id}` : "text" in subject ? subject.text : "";
    const key = `edit:${about}:${text}`;
    const known = others.get(key);
    if (known) known.count++;
    else {
      others.set(key, {
        key,
        at: row.createdAt,
        subject,
        levelChanges: 0,
        details: [],
        text,
        count: 1,
      });
    }
  }
  const entries = [
    ...[...mirrorings.values()]
      .map((rows) => mirroringEntry(rows, t, clock, { current: currentLevels(state), now }))
      .filter((entry): entry is ChangeEntry => entry !== null),
    ...others.values(),
  ];
  return entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}
