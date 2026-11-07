import * as z from "zod/mini";
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
import { carrier, log } from "./telemetry";

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
const SPACES = /([\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+)/;
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
/** "://" or ":/" before a letter or digit, as in "msteams:/l/…". The emoticon ":/" stays. */
const SCHEME_SLASH = /:\/[\p{L}\p{N}/]/u;
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

/** Bytes of percent-encoded text. A URL parser decodes them in the host before IDNA. */
const PERCENT_RUN = /(?:%[\da-f]{2})+/gi;
/** Replaces an invalid UTF-8 sequence with U+FFFD and never throws. */
const UTF8 = new TextDecoder();

function percentDecoded(run: string): string {
  const bytes = new Uint8Array(run.length / 3);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = Number.parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16);
  return UTF8.decode(bytes);
}

/**
 * The form of a word that the link rules read: percent-decoded, NFKC, without format characters
 * and the characters that IDNA ignores (variation selectors, the combining grapheme joiner),
 * without marks at the start of a label, with ideographic and full-width dots as "." and
 * backslashes as "/", in lower case. It never reaches an answer, so that "m²" stays "m²".
 */
function detectionForm(word: string): string {
  return word
    .replace(PERCENT_RUN, percentDecoded)
    .normalize("NFKC")
    .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "")
    .replace(/(?<=^|[.\u3002\uff0e\uff61])\p{M}+/gu, "")
    .replace(/[\u3002\uff0e\uff61]/g, ".")
    .replaceAll("\\", "/")
    .toLowerCase();
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
  const topLevel = labels[count - 2] !== "" && TOP_LEVEL.test(labels[count - 1] as string);
  // "www." before a host name with a top-level domain, also without a path: "www.example.com".
  // "WWW.Kongress" names no host.
  if (topLevel) {
    for (let index = 0; index < count - 2; index++) {
      if ((labels[index] as string).endsWith("www")) return "drop";
    }
  }
  // A host anywhere in the word, followed by a path, query or fragment: "x@example.com/join?pwd=1".
  if (path && topLevel) return "drop";
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
  const verdict = coreVerdict(core);
  // Any dropped word with the Meet host marks the field for its code: "https://meet.google.com".
  return verdict === "drop" && MEET_HOST.test(core) ? "meet" : verdict;
}

/** The Meet host as a whole host name: not "notmeet.google.com" and not "meet.google.com.evil". */
const MEET_HOST = /(?:^|[^\p{L}\p{N}.-])meet\.google\.com\.?(?![\p{L}\p{N}-]|\.[\p{L}\p{N}])/u;

function coreVerdict(core: string): Verdict {
  if (core === "") return "keep";
  if (core.startsWith("//") || SCHEME_SLASH.test(core) || QUERY.test(core)) return "drop";
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
 * ")", while "(https://…)" and "<https://…>" go as a whole. Openers in the order they stand,
 * closers in the order they stand.
 */
function strayBrackets(word: string): { open: string[]; close: string[] } {
  const counts = new Map<string, number>();
  for (const char of word) {
    if (char in PAIRS) counts.set(char, (counts.get(char) ?? 0) + 1);
    const opener = CLOSERS[char];
    if (opener) counts.set(opener, (counts.get(opener) ?? 0) - 1);
  }
  const open: string[] = [];
  for (const char of word) {
    if (!(char in PAIRS)) break;
    const balance = counts.get(char) ?? 0;
    if (balance > 0) {
      open.push(char);
      counts.set(char, balance - 1);
    }
  }
  const close: string[] = [];
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
      close.push(char);
      counts.set(opener, balance + 1);
    }
  }
  return { open, close: close.reverse() };
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

/**
 * A word split before each Markdown link target: "[Join](https://…)" gives "[Join]" and
 * "(https://…)", "![img](https://…)" gives "![img]" and "(https://…)".
 */
function markdownPieces(word: string): string[] {
  if (!word.includes("](")) return [word];
  const pieces = word.split("](");
  return pieces.map((piece, index) =>
    index === 0 ? `${piece}]` : index === pieces.length - 1 ? `(${piece}` : `(${piece}]`,
  );
}

/** How many kept words back the "[" of a Markdown link label may stand. */
const LABEL_WORDS = 8;
/** White space that a URL parser removes, so that it joins the words around it into one link. */
const URL_IGNORED = /^[\t\n\r]+$/;

/** A piece of a word, with what the link rules decided about it. */
interface Piece {
  text: string;
  /** White space stood before it. */
  gap: boolean;
  /** The first piece of its word. */
  first: boolean;
  drop: boolean;
}

/**
 * A title or location without links. Null if links were removed and no letter or digit remains.
 *
 * The text is split into words at white space, and a word that is or holds a link goes as a
 * whole: a meeting link often holds its passcode, so no part of it may leave. The rules are
 * generic, not a list of meeting services: a new service, a regional host or an address without a
 * scheme is a link all the same. The price is that a word shaped like a host and a path, such as
 * "Node.js/React", goes too. Kept words keep their characters; the rules read a normalized copy.
 * Words that only tabs and line breaks separate are also read as one, because a URL parser drops
 * those characters: if they form a link together, all of them go.
 * Only tests pass `maxLength`, to show that the filter takes linear time also without the cut.
 */
export function withoutLinks(text: string, maxLength = MAX_TEXT_LENGTH): string | null {
  if (text === "") return "";
  const cut = text.length > maxLength;
  const parts = (cut ? text.slice(0, maxLength) : text).split(SPACES);

  const words: { text: string; space: string; drop: boolean }[] = [];
  for (let index = 0; index < parts.length; index += 2) {
    const word = parts[index] as string;
    if (word !== "") words.push({ text: word, space: parts[index - 1] ?? "", drop: false });
  }
  // Words joined by tabs and line breaks only, which a URL parser joins: "https:\n//a.com\n/j/1".
  const groups: { start: number; end: number }[] = [];
  for (let start = 0; start < words.length;) {
    let end = start + 1;
    while (end < words.length && URL_IGNORED.test((words[end] as { space: string }).space)) end++;
    groups.push({ start, end });
    start = end;
  }
  const textOf = (group: { start: number; end: number }) =>
    words
      .slice(group.start, group.end)
      .map((word) => word.text)
      .join("");
  const dropGroup = (group: { start: number; end: number }) => {
    for (let index = group.start; index < group.end; index++) {
      (words[index] as { drop: boolean }).drop = true;
    }
  };
  // The cut drops the word at the cut, and every word that tabs and line breaks join to it: the
  // rest of a link could follow. A cut right after a tab or line break joins the last word to the
  // cut-off text the same way.
  const lastGroup = groups.at(-1);
  if (cut && lastGroup && (parts.at(-1) !== "" || URL_IGNORED.test(parts.at(-2) ?? ""))) {
    dropGroup(lastGroup);
  }
  let meet = false;
  for (const group of groups) {
    if (group.end - group.start < 2) continue;
    const verdict = linkVerdict(textOf(group));
    if (verdict !== "keep") dropGroup(group);
    if (verdict === "meet") meet = true;
  }
  const pieces: (Piece & { word: number })[] = [];
  for (const [index, word] of words.entries()) {
    for (const [number, piece] of markdownPieces(word.text).entries()) {
      const verdict = word.drop ? "drop" : linkVerdict(piece);
      if (verdict === "meet") meet = true;
      pieces.push({
        text: piece,
        gap: number === 0 && word.space !== "",
        first: number === 0,
        drop: verdict !== "keep",
        word: index,
      });
    }
  }
  // Once a Meet link went, so does every word of the field shaped like its code, also one that a
  // separator or a word stands apart from ("meet.google.com - abc-defg-hij"), or that a line break
  // splits ("abc\n-defg-hij").
  if (meet) {
    for (const group of groups) if (MEET_CODE.test(coreOf(textOf(group)))) dropGroup(group);
    for (const piece of pieces) {
      if ((words[piece.word] as { drop: boolean }).drop) piece.drop = true;
      else if (MEET_CODE.test(coreOf(piece.text))) piece.drop = true;
    }
  }

  const kept: { gap: boolean; text: string }[] = [];
  let dropped = cut;
  // While pieces are dropped: whether white space stood before the first of them, and the opening
  // brackets that wait for the next kept piece.
  let afterDrop = false;
  let gapBefore = false;
  const opens: string[] = [];
  let previousKept = false;
  for (const piece of pieces) {
    if (piece.drop) {
      if (!afterDrop) gapBefore = piece.gap;
      afterDrop = true;
      dropped = true;
      const last = kept.at(-1);
      // "[Join](https://…)" keeps "Join", "![img](https://…)" keeps "img".
      if (!piece.first && previousKept && last?.text.endsWith("]")) {
        last.text = last.text.slice(0, -1);
        for (let back = kept.length - 1; back >= Math.max(0, kept.length - LABEL_WORDS); back--) {
          const label = kept[back] as { text: string };
          const open = label.text.startsWith("![") ? 2 : label.text.startsWith("[") ? 1 : 0;
          if (open > 0) {
            label.text = label.text.slice(open);
            break;
          }
        }
      }
      const stray = strayBrackets(piece.text);
      // Closers are collected and appended once, so that many of them take linear time.
      let closers = "";
      for (const bracket of stray.close) {
        if (opens.at(-1) === CLOSERS[bracket]) opens.pop();
        else closers += bracket;
      }
      if (last && closers !== "") last.text = withoutTrailingSeparators(last.text) + closers;
      for (const bracket of stray.open) opens.push(bracket);
      previousKept = false;
      continue;
    }
    previousKept = true;
    if (!afterDrop) {
      kept.push({ gap: piece.gap, text: piece.text });
      continue;
    }
    // A separator between the text and a link goes with the link: "Room 4 / <link> / floor 2".
    const last = kept.at(-1);
    if (
      isSeparators(piece.text) &&
      (!last || isSeparators(last.text) || SEPARATORS.has(last.text.at(-1) ?? ""))
    ) {
      continue;
    }
    kept.push({ gap: gapBefore || piece.gap, text: opens.join("") + piece.text });
    opens.length = 0;
    afterDrop = false;
  }
  // Separators that stood before a link at the end: "Agenda: <link>".
  while (afterDrop && kept.length > 0) {
    const last = kept.at(-1) as { text: string };
    last.text = withoutTrailingSeparators(last.text);
    if (last.text !== "") break;
    kept.pop();
  }
  // Every run of white space, also a single tab or line break, turns into one space. A label that
  // lost its brackets can be empty ("[ Join](…)"), so runs are collapsed once more.
  const cleaned = kept
    .map((piece, index) => (index > 0 && piece.gap ? ` ${piece.text}` : piece.text))
    .join("")
    .replace(/ {2,}/g, " ")
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
      carrier(),
    );
    if (read.kind === "throttled") return failure("throttled", read.retryAfterMs);
    if (read.kind === "unavailable") return failure("gone");
    return { source, events: read.events };
  } catch (error) {
    log.error("mcp.list_events_read_failed", { accountId: source.accountId }, error);
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
