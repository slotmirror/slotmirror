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
 * The longest title or location that `list_events` filters. Longer text is cut before the filter,
 * which bounds its CPU time, and the cut word goes too: the rest of a link could follow it.
 */
export const MAX_TEXT_LENGTH = 2_000;

/** White space between words. U+FEFF is missing on purpose: it hides inside a host name. */
const SPACES = /([\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+)/;
/** Punctuation around a word, as in "(see https://…)" or "<https://…>". */
const EDGE_OPEN = /[\p{Ps}\p{Pi}\p{Pf}<"'`*]/u;
const EDGE_CLOSE = /[\p{Pe}\p{Pi}\p{Pf}>"'`*.,;:!?]/u;
/**
 * Schemes without "//". A list, because "Re:Budget" looks like a scheme too. A scheme counts only
 * if a digit, "@", "?", "/", "=" or "." follows it, so that "SMS:Kampagne" stays a word.
 */
const SCHEME =
  /(?<!\p{L})(?:https?|ftps?|sftp|mailto|tel|sips?|callto|skype|facetime(?:-audio)?|xmpp|sms|msteams|zoommtg|zoomus|webex|data|javascript|vbscript|file):/gu;
const SCHEME_REST = /[\d@?/=.]/;
/** A query string or a passcode parameter, as in "?pwd=" or "confno=". */
const QUERY = /(?:\?[\p{L}\p{N}_.-]+|pwd|passcode)=/u;
const HOST_CHAR = /[\p{L}\p{M}\p{N}.-]/u;
const WORD_CHAR = /[\p{L}\p{N}]/u;
const TOP_LEVEL = /^(?:\p{L}[\p{L}\p{M}]+|xn--[\p{L}\p{M}\p{N}-]+)$/u;
const OCTET = /^\d{1,3}$/;
const DIGIT = /^\d$/;
/** Meeting services, whose host names go also without a path. Subdomains count too. */
const MEETING_HOSTS = [
  "zoom.us",
  "zoomgov.com",
  "teams.microsoft.com",
  "teams.live.com",
  "teams.cloud.microsoft",
  "teams.microsoft.us",
  "meet.google.com",
  "webex.com",
  "join.skype.com",
  "meet.lync.com",
  "bluejeans.com",
  "facetime.apple.com",
  "meetings.ringcentral.com",
  "8x8.vc",
  "whereby.com",
  "gotomeeting.com",
  "gotomeet.me",
  "meet.jit.si",
  "chime.aws",
];
/** The code of a Google Meet call, as in "meet.google.com abc-defg-hij". */
const MEET_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
/** Characters that separate parts of a title, as in "Room 4 / floor 2". */
const SEPARATORS = new Set(Array.from("\\,;:|/_·•–\u2014-"));

/** Percent-encoded characters of a link, as in "https%3A%2F%2Fexample.com". */
const ENCODED: Record<string, string> = {
  "%2e": ".",
  "%2f": "/",
  "%3a": ":",
  "%3d": "=",
  "%3f": "?",
  "%23": "#",
  "%40": "@",
};

/**
 * The form of a word that the link rules read: NFKC, without invisible format characters, with
 * ideographic and full-width dots as "." and backslashes as "/", in lower case, with the
 * characters of a link decoded. It never reaches an answer, so that "m²" stays "m²".
 */
function detectionForm(word: string): string {
  return word
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/[\u3002\uff0e\uff61]/g, ".")
    .replaceAll("\\", "/")
    .toLowerCase()
    .replace(/%(?:2e|2f|3a|3d|3f|23|40)/g, (code) => ENCODED[code] as string);
}

/** A word without the punctuation around it, in its detection form. */
function coreOf(word: string): string {
  const chars = Array.from(detectionForm(word));
  let start = 0;
  while (start < chars.length && EDGE_OPEN.test(chars[start] as string)) start++;
  let end = chars.length;
  while (end > start && EDGE_CLOSE.test(chars[end - 1] as string)) end--;
  return chars.slice(start, end).join("");
}

type Verdict = "keep" | "drop" | "meet";

/**
 * What a run of host characters (letters, digits, "." and "-") means. `after` is the index of the
 * character after the run, `lastWord` the index of the word's last letter or digit.
 */
function hostVerdict(run: string, chars: string[], after: number, lastWord: number): Verdict {
  let end = run.length;
  while (end > 0 && run[end - 1] === ".") end--;
  const name = run.slice(0, end);
  for (const host of MEETING_HOSTS) {
    if (name === host || name.endsWith(`.${host}`)) {
      return host === "meet.google.com" ? "meet" : "drop";
    }
  }
  let next = after;
  let port = false;
  if (chars[next] === ":" && DIGIT.test(chars[next + 1] ?? "")) {
    next++;
    while (DIGIT.test(chars[next] ?? "")) next++;
    port = true;
  }
  const follower = chars[next];
  const path = (follower === "/" || follower === "?" || follower === "#") && lastWord > next;
  const labels = name.split(".");
  const count = labels.length;
  if (count < 2) return "keep";
  // A host anywhere in the word, followed by a path, query or fragment: "x@example.com/join?pwd=1".
  if (path && labels[count - 2] !== "" && TOP_LEVEL.test(labels[count - 1] as string)) {
    return "drop";
  }
  if ((path || port) && count >= 4 && labels.slice(-4).every((label) => OCTET.test(label))) {
    return "drop";
  }
  return "keep";
}

/**
 * Whether a word is or holds a link. Each test reads the word once or a fixed number of times, so
 * that a long title takes linear time.
 */
function linkVerdict(word: string): Verdict {
  const core = coreOf(word);
  if (core === "") return "keep";
  if (core.startsWith("//") || core.includes(":/") || core.includes("www.") || QUERY.test(core)) {
    return "drop";
  }
  let lastRest = -1;
  for (let i = core.length - 1; i >= 0; i--) {
    if (SCHEME_REST.test(core[i] as string)) {
      lastRest = i;
      break;
    }
  }
  for (const match of core.matchAll(SCHEME)) {
    if (lastRest >= match.index + match[0].length) return "drop";
  }
  const chars = Array.from(core);
  let lastWord = -1;
  for (let i = chars.length - 1; i >= 0; i--) {
    if (WORD_CHAR.test(chars[i] as string)) {
      lastWord = i;
      break;
    }
  }
  // Runs of host characters do not overlap, so this loop reads each character a fixed number of
  // times.
  let i = 0;
  while (i < chars.length) {
    if (!HOST_CHAR.test(chars[i] as string)) {
      i++;
      continue;
    }
    let j = i;
    while (j < chars.length && HOST_CHAR.test(chars[j] as string)) j++;
    const verdict = hostVerdict(chars.slice(i, j).join(""), chars, j, lastWord);
    if (verdict !== "keep") return verdict;
    i = j;
  }
  return "keep";
}

const PAIRS: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">" };
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{", ">": "<" };

/**
 * The brackets of a dropped word that belong to the text around it: "(see https://…)" keeps its
 * ")", while "(https://…)" and "<https://…>" go as a whole.
 */
function strayBrackets(word: string): { open: string; close: string } {
  const counts = new Map<string, number>();
  for (const char of word) {
    if (char in PAIRS) counts.set(char, (counts.get(char) ?? 0) + 1);
    const opener = CLOSERS[char];
    if (opener) counts.set(opener, (counts.get(opener) ?? 0) - 1);
  }
  let open = "";
  for (const char of word) {
    if (!(char in PAIRS)) break;
    const balance = counts.get(char) ?? 0;
    if (balance > 0) {
      open += char;
      counts.set(char, balance - 1);
    }
  }
  let close = "";
  const chars = Array.from(word);
  for (let i = chars.length - 1; i >= 0; i--) {
    const char = chars[i] as string;
    const opener = CLOSERS[char];
    if (!opener) {
      if (EDGE_CLOSE.test(char)) continue;
      break;
    }
    const balance = counts.get(opener) ?? 0;
    if (balance < 0) {
      close = char + close;
      counts.set(opener, balance + 1);
    }
  }
  return { open, close };
}

function isSeparators(text: string): boolean {
  for (const char of text) if (!SEPARATORS.has(char)) return false;
  return true;
}

/** Every separator is one UTF-16 unit, so this reads only the separators at the end. */
function withoutTrailingSeparators(text: string): string {
  let end = text.length;
  while (end > 0 && SEPARATORS.has(text[end - 1] as string)) end--;
  return text.slice(0, end);
}

/** A word split before each Markdown link target: "[Join](https://…)" gives "[Join]", "(https://…)". */
function markdownPieces(word: string): string[] {
  if (!word.includes("](")) return [word];
  const pieces = word.split("](");
  return pieces.map((piece, index) =>
    index === 0 ? `${piece}]` : index === pieces.length - 1 ? `(${piece}` : `(${piece}]`,
  );
}

/** How many kept words back the "[" of a Markdown link label may stand. */
const LABEL_WORDS = 8;

/**
 * A title or location without links. Null if links were removed and no letter or digit remains.
 *
 * The text is split into words at white space, and a word that is or holds a link goes as a
 * whole: a meeting link often holds its passcode, so no part of it may leave. The rules are
 * generic, not a list of meeting services: a new service, a regional host or an address without a
 * scheme is a link all the same. The price is that a word shaped like a host and a path, such as
 * "Node.js/React", goes too. Kept words keep their characters; the rules read a normalized copy.
 * Only tests pass `maxLength`, to show that the filter takes linear time also without the cut.
 */
export function withoutLinks(text: string, maxLength = MAX_TEXT_LENGTH): string | null {
  if (text === "") return "";
  const cut = text.length > maxLength;
  const parts = (cut ? text.slice(0, maxLength) : text).split(SPACES);
  if (cut) parts[parts.length - 1] = "";

  const kept: { space: string; text: string }[] = [];
  // The cut drops the word at the cut.
  let dropped = cut;
  // While words are dropped: the white space before the first of them, and the opening brackets
  // that wait for the next kept word.
  let afterDrop = false;
  let spaceBefore = "";
  let opens = "";
  let meet = false;
  for (let index = 0; index < parts.length; index += 2) {
    const word = parts[index] as string;
    if (word === "") continue;
    const pieces = markdownPieces(word);
    let previousKept = false;
    for (const [number, piece] of pieces.entries()) {
      const space = number === 0 ? (parts[index - 1] ?? "") : "";
      let verdict = linkVerdict(piece);
      if (verdict === "keep" && meet && MEET_CODE.test(coreOf(piece))) verdict = "drop";
      meet = verdict === "meet";
      if (verdict !== "keep") {
        if (!afterDrop) spaceBefore = space;
        afterDrop = true;
        dropped = true;
        const last = kept.at(-1);
        // "[Join](https://…)" keeps "Join".
        if (number > 0 && previousKept && last?.text.endsWith("]")) {
          last.text = last.text.slice(0, -1);
          for (let back = kept.length - 1; back >= Math.max(0, kept.length - LABEL_WORDS); back--) {
            const label = kept[back] as { text: string };
            if (label.text.startsWith("[")) {
              label.text = label.text.slice(1);
              break;
            }
          }
        }
        const stray = strayBrackets(piece);
        for (const bracket of stray.close) {
          if (opens.endsWith(CLOSERS[bracket] as string)) opens = opens.slice(0, -1);
          else if (last) last.text = withoutTrailingSeparators(last.text) + bracket;
        }
        opens += stray.open;
        previousKept = false;
        continue;
      }
      previousKept = true;
      if (!afterDrop) {
        kept.push({ space, text: piece });
        continue;
      }
      // A separator between the text and a link goes with the link: "Room 4 / <link> / floor 2".
      const last = kept.at(-1);
      if (
        isSeparators(piece) &&
        (!last || isSeparators(last.text) || SEPARATORS.has(last.text.at(-1) ?? ""))
      ) {
        continue;
      }
      kept.push({ space: spaceBefore || space, text: opens + piece });
      opens = "";
      afterDrop = false;
    }
  }
  // Separators that stood before a link at the end: "Agenda: <link>".
  while (afterDrop && kept.length > 0) {
    const last = kept.at(-1) as { text: string };
    last.text = withoutTrailingSeparators(last.text);
    if (last.text !== "") break;
    kept.pop();
  }
  const cleaned = kept
    .map((piece) => piece.space + piece.text)
    .join("")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (dropped && !WORD_CHAR.test(cleaned)) return null;
  return cut && cleaned !== "" ? `${cleaned}…` : cleaned;
}

/**
 * Years that a date argument may name. Later years would need more than four digits in ISO 8601
 * once a window or an offset moves past 9999, and no calendar holds events from before 1970.
 */
const FIRST_YEAR = 1970;
const LAST_YEAR = 2199;

/**
 * The time of a checked date (`YYYY-MM-DD`) at UTC midnight, or NaN if the date does not exist
 * (Date.UTC rolls 2026-02-30 over into March) or lies outside FIRST_YEAR to LAST_YEAR.
 */
function realDate(year: string, month: string, day: string): number {
  if (Number(year) < FIRST_YEAR || Number(year) > LAST_YEAR) return Number.NaN;
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

/** UTC midnight of a date that DATE matched. */
function utcMidnight(date: RegExpExecArray): number {
  return Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]));
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
  // A window that ends on a date starts at the midnight before, also on a day with a clock change.
  const endDate = input.end === undefined ? null : DATE.exec(input.end);
  start ??= endDate
    ? localInstant(zone, utcMidnight(endDate) - DAY_MS, 0)
    : (end as number) - DAY_MS;
  // A window that starts on a date ends at the next midnight, also on a day with a clock change.
  const startDate = input.start === undefined ? null : DATE.exec(input.start);
  end ??= startDate ? localInstant(zone, utcMidnight(startDate) + DAY_MS, 0) : start + DAY_MS;
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
  } = await readEventSources(env.DB, userId, input);
  const zone = canonicalTimeZone(
    input.timeZone ?? (workTimeZone && isTimeZone(workTimeZone) ? workTimeZone : "UTC"),
  );
  const window = windowOf(input, zone, now);
  if ("problem" in window) return window;

  const range = { start: new Date(window.start), end: new Date(window.end) };
  // Instances of different accounts read in parallel; each instance queues its own calls.
  const reads = await Promise.all(sources.map((source) => readCalendar(env, source, range)));

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
