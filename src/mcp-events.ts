import * as z from "zod/mini";
import { errorLogFields } from "./audit";
import { detailLevelResolver, type DetailLevel } from "./detail-policy";
import { accountSync } from "./durable";
import {
  readEventSources,
  type EventReadError,
  type EventSource,
  type EventsAnswer,
  type EventView,
} from "./read-model";
import { isoFromTime } from "./sync/iso-time";
import type { SourceEvent } from "./sync/types";
import {
  canonicalTimeZone,
  isTimeZone,
  localDate,
  localInstant,
  offsetAt,
} from "./sync/working-hours";

/**
 * The MCP tool `list_events`: the user's events across all source calendars of all connected
 * accounts, for a time window. It reads through each account's `AccountSync` instance, which holds
 * the tokens and runs provider calls one at a time, and never calls a provider itself.
 *
 * What it shows follows the sync's privacy rules: a private event shows only its time and status,
 * an org account's events show no more than MAX_DETAIL_TO_EXTERNAL allows, because the agent is
 * outside the org, and no event body ever leaves. Blocks that slotmirror wrote are left out unless
 * asked for, or every mirrored meeting would show twice.
 */

/** Events in one answer. The rest is cut, and `truncated` says so. */
export const MAX_EVENTS = 500;
/** The longest window of one call. A month of a busy calendar takes a few provider pages. */
export const MAX_WINDOW_DAYS = 31;
const MAX_QUERY_LENGTH = 200;
const MAX_FILTER_ITEMS = 25;
const MAX_FILTER_LENGTH = 320;
const DAY_MS = 86_400_000;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** A date and time with an offset. A time without one would depend on the server's zone. */
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-](\d{2}):(\d{2}))$/i;

/**
 * Web addresses, with or without a scheme, and the hosts of meeting services written without one.
 * A meeting link often holds its passcode, so it never leaves in a title or location.
 */
const LINK =
  /\b(?:https?:\/\/|www\.)\S+|\b(?:[\w-]+\.)*(?:zoom\.us|zoomgov\.com|teams\.microsoft\.com|teams\.live\.com|meet\.google\.com|webex\.com|gotomeeting\.com|gotomeet\.me|whereby\.com|meet\.jit\.si|chime\.aws)(?:[/?#]\S*)?/gi;

/** A title or location without links. Null if nothing but links and separators remains. */
export function withoutLinks(text: string): string | null {
  if (text === "") return "";
  const cleaned = text
    .replace(LINK, " ")
    .replace(/\s{2,}/g, " ")
    // Separators that stood between the text and a link, such as "Room 4 / <link>".
    .replace(/^[\s,;|/–-]+|[\s,;|/–-]+$/g, "");
  return /[\p{L}\p{N}]/u.test(cleaned) ? cleaned : null;
}

/** True if a checked date (`YYYY-MM-DD`) exists: Date.UTC rolls 2026-02-30 over into March. */
function realDate(year: string, month: string, day: string): number {
  const time = Date.UTC(Number(year), Number(month) - 1, Number(day));
  return new Date(time).toISOString().slice(0, 10) === `${year}-${month}-${day}`
    ? time
    : Number.NaN;
}

const filterList = z
  .array(z.string().check(z.maxLength(MAX_FILTER_LENGTH)))
  .check(z.maxLength(MAX_FILTER_ITEMS));

export const listEventsInput = z.strictObject({
  start: z.optional(z.string().check(z.maxLength(40))),
  end: z.optional(z.string().check(z.maxLength(40))),
  timeZone: z.optional(z.string().check(z.maxLength(64))),
  accounts: z.optional(filterList),
  calendars: z.optional(filterList),
  query: z.optional(z.string().check(z.maxLength(MAX_QUERY_LENGTH))),
  includeMirrors: z.optional(z.boolean()),
});
export type ListEventsInput = z.infer<typeof listEventsInput>;

/**
 * `inputSchema` of `list_events`, written out for the same reason as the output schemas: no
 * `z.toJSONSchema` in the Worker. A test fails if it and `listEventsInput` differ.
 */
export const LIST_EVENTS_INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    start: {
      type: "string",
      maxLength: 40,
      description:
        "Start of the window: a date (YYYY-MM-DD, midnight in timeZone) or a date and time with an offset. Default: today 00:00 in timeZone.",
    },
    end: {
      type: "string",
      maxLength: 40,
      description: `End of the window, exclusive, in the same forms. Default: one day after start. At most ${MAX_WINDOW_DAYS} days after start.`,
    },
    timeZone: {
      type: "string",
      maxLength: 64,
      description:
        "IANA time zone for dates and for the times in the answer, for example Europe/Vienna. Default: the zone of the user's working hours, else UTC.",
    },
    accounts: {
      type: "array",
      maxItems: MAX_FILTER_ITEMS,
      items: { type: "string", maxLength: MAX_FILTER_LENGTH },
      description: "Only these accounts, by ID or email address, as list_accounts names them.",
    },
    calendars: {
      type: "array",
      maxItems: MAX_FILTER_ITEMS,
      items: { type: "string", maxLength: MAX_FILTER_LENGTH },
      description: "Only calendars with these names.",
    },
    query: {
      type: "string",
      maxLength: MAX_QUERY_LENGTH,
      description: "Only events whose shown title or location contains this text, ignoring case.",
    },
    includeMirrors: {
      type: "boolean",
      description: "Also list the blocks that slotmirror wrote. Default: false.",
    },
  },
  additionalProperties: false,
} as const;

/** Why the arguments of a call were refused. The MCP route turns it into a tool error. */
export type ListEventsProblem = "arguments" | "time" | "zone" | "window";

export type ListEventsResult = { ok: EventsAnswer } | { problem: ListEventsProblem };

/** Check the arguments before any read: a refused call costs no query. */
export function parseListEventsInput(
  raw: unknown,
): { ok: ListEventsInput } | { problem: ListEventsProblem } {
  const parsed = listEventsInput.safeParse(raw);
  if (!parsed.success) return { problem: "arguments" };
  const input = parsed.data;
  for (const value of [input.start, input.end]) {
    if (value !== undefined && !DATE.test(value) && !DATE_TIME.test(value)) {
      return { problem: "time" };
    }
  }
  if (input.timeZone !== undefined && !isTimeZone(input.timeZone)) return { problem: "zone" };
  return { ok: input };
}

/** An instant from a checked argument. A date is midnight in `zone`. NaN if it is no real time. */
function instantOf(value: string, zone: string): number {
  const date = DATE.exec(value);
  if (date) {
    const day = realDate(date[1] as string, date[2] as string, date[3] as string);
    return Number.isNaN(day) ? day : localInstant(zone, day, 0);
  }
  const parts = DATE_TIME.exec(value);
  if (!parts) return Number.NaN;
  const [, year, month, day, hour, minute, second = "00", , , offsetHours, offsetMinutes] = parts;
  // Date.parse rolls 2026-02-30T10:00Z into March and takes T24:00; neither is a real time.
  if (
    Number.isNaN(realDate(year as string, month as string, day as string)) ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    Number(offsetHours ?? 0) > 23 ||
    Number(offsetMinutes ?? 0) > 59
  ) {
    return Number.NaN;
  }
  return Date.parse(value);
}

/** The window of a call, or a problem. Without arguments: today in `zone`. */
export function windowOf(
  input: Pick<ListEventsInput, "start" | "end">,
  zone: string,
  now: number,
): { start: number; end: number } | { problem: ListEventsProblem } {
  let start = input.start === undefined ? undefined : instantOf(input.start, zone);
  let end = input.end === undefined ? undefined : instantOf(input.end, zone);
  if (Number.isNaN(start) || Number.isNaN(end)) return { problem: "time" };
  if (start === undefined && end === undefined) {
    const today = localDate(zone, now);
    start = localInstant(zone, today, 0);
    end = localInstant(zone, today + DAY_MS, 0);
  }
  start ??= (end as number) - DAY_MS;
  // A window that starts on a date ends at the next midnight, also on a day with a clock change.
  const startDate = input.start === undefined ? null : DATE.exec(input.start);
  end ??= startDate
    ? localInstant(
        zone,
        Date.UTC(Number(startDate[1]), Number(startDate[2]) - 1, Number(startDate[3])) + DAY_MS,
        0,
      )
    : start + DAY_MS;
  // The limit counts calendar days in `zone`: a month across a clock change has 745 hours.
  const startDay = localDate(zone, start);
  const wallMinutes = (start + offsetAt(zone, start) - startDay) / 60_000;
  const limit = localInstant(zone, startDay + MAX_WINDOW_DAYS * DAY_MS, wallMinutes);
  if (end <= start || end > limit) return { problem: "window" };
  return { start, end };
}

/** ISO 8601 of an instant in `zone`, with its offset, to the second. */
export function localIso(zone: string, instant: number): string {
  const offset = offsetAt(zone, instant);
  const wall = isoFromTime(instant + offset).slice(0, 19);
  if (offset === 0) return `${wall}Z`;
  const minutes = Math.abs(offset) / 60_000;
  const sign = offset > 0 ? "+" : "-";
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${wall}${sign}${hh}:${mm}`;
}

type CalendarRead =
  | { source: EventSource; events: SourceEvent[] }
  | { source: EventSource; error: EventReadError };

/** One calendar's events, or why they could not be read. Never throws. */
async function readCalendar(
  env: Env,
  source: EventSource,
  window: { start: Date; end: Date },
): Promise<CalendarRead> {
  const failure = (code: EventReadError["code"], retryAfterMs?: number): CalendarRead => ({
    source,
    error: {
      accountId: source.accountId,
      calendar: source.calendar,
      code,
      ...(retryAfterMs === undefined ? {} : { retryAfterSeconds: Math.ceil(retryAfterMs / 1000) }),
    },
  });
  // The sync does not read such an account either; a provider call would fail on its token.
  if (source.needsReconnect) return failure("reconnect");
  try {
    // The comparison read waits out a provider penalty without a call, so that an agent never
    // extends the penalty that the sync waits for, and shares the instance's short source cache.
    const read = await accountSync(env, source.accountId).readCompareEvents(
      source.remoteId,
      window,
    );
    if (read.kind === "throttled") return failure("throttled", read.retryAfterMs);
    if (read.kind === "unavailable") return failure("gone");
    return { source, events: read.events };
  } catch (error) {
    console.error("Reading events for list_events failed", ...errorLogFields(error));
    return failure("failed");
  }
}

function matches(filter: readonly string[] | undefined, values: readonly string[]): boolean {
  if (!filter || filter.length === 0) return true;
  const wanted = new Set(filter.map((value) => value.trim().toLowerCase()));
  return values.some((value) => wanted.has(value.toLowerCase()));
}

/** The view of one event under the account's detail level. */
function viewOf(
  event: SourceEvent,
  source: EventSource,
  level: DetailLevel,
  zone: string,
): EventView {
  const open = !event.isPrivate;
  const showTitle = open && level !== "busy";
  const showLocation = open && (level === "title_location" || level === "full");
  return {
    accountId: source.accountId,
    account: source.account,
    calendar: source.calendar,
    title: showTitle ? withoutLinks(event.subject) : null,
    location: showLocation ? withoutLinks(event.location) : null,
    start: event.allDay ? event.start.slice(0, 10) : localIso(zone, Date.parse(event.start)),
    end: event.allDay ? event.end.slice(0, 10) : localIso(zone, Date.parse(event.end)),
    allDay: event.allDay,
    showAs: event.showAs,
    private: event.isPrivate,
    declined: event.declined,
    recurring: event.occurrenceKey.startsWith("series:"),
    mirror: event.isMirror,
  };
}

/** The instant an event starts, for the sort. An all-day event starts at midnight in `zone`. */
function sortKey(event: SourceEvent, zone: string): number {
  if (!event.allDay) return Date.parse(event.start);
  const day = Date.parse(`${event.start.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(day) ? 0 : localInstant(zone, day, 0);
}

/**
 * Run `list_events` for a user with checked input. `db` is the counting database of the call, so
 * that the query of the source calendars is charged; the reads through the Durable Objects cost
 * no D1 rows.
 */
export async function listEvents(
  env: Env,
  userId: string,
  input: ListEventsInput,
  now = Date.now(),
): Promise<ListEventsResult> {
  const {
    sources,
    truncated: calendarsTruncated,
    workTimeZone,
  } = await readEventSources(env.DB, userId);
  const zone = canonicalTimeZone(
    input.timeZone ?? (workTimeZone && isTimeZone(workTimeZone) ? workTimeZone : "UTC"),
  );
  const window = windowOf(input, zone, now);
  if ("problem" in window) return window;

  const chosen = sources.filter(
    (source) =>
      matches(input.accounts, [source.accountId, source.email]) &&
      matches(input.calendars, [source.calendar, source.calendarId]),
  );
  const range = { start: new Date(window.start), end: new Date(window.end) };
  // Instances of different accounts read in parallel; each instance queues its own calls.
  const reads = await Promise.all(chosen.map((source) => readCalendar(env, source, range)));

  // The agent counts as outside the org: an org account's events show at most what a rule from
  // it to an external account may copy.
  const levelFor = detailLevelResolver(env);
  const external = { email: "", tenantId: null };
  const query = input.query?.trim().toLowerCase() ?? "";
  const found: { key: number; view: EventView }[] = [];
  const errors: EventReadError[] = [];
  for (const read of reads) {
    if ("error" in read) {
      errors.push(read.error);
      continue;
    }
    const { source } = read;
    const level = levelFor("title_location", source, external).level;
    for (const event of read.events) {
      if (event.isMirror && !input.includeMirrors) continue;
      const view = viewOf(event, source, level, zone);
      if (query) {
        // Only what the answer shows can match, so a withheld title cannot leak through a filter.
        const shown = `${view.title ?? ""}\n${view.location ?? ""}`.toLowerCase();
        if (!shown.includes(query)) continue;
      }
      found.push({ key: sortKey(event, zone), view });
    }
  }
  // Stable: events with the same start keep the order of accounts and calendars.
  found.sort((a, b) => a.key - b.key || Number(b.view.allDay) - Number(a.view.allDay));
  return {
    ok: {
      start: localIso(zone, window.start),
      end: localIso(zone, window.end),
      timeZone: zone,
      events: found.slice(0, MAX_EVENTS).map((item) => item.view),
      errors,
      truncated: found.length > MAX_EVENTS,
      calendarsTruncated,
    },
  };
}
