import { describe, expect, it } from "vitest";

// Vite inlines the glob at build time. The `vite/client` types are not a dependency here.
// @ts-expect-error `import.meta.glob` is untyped without `vite/client`
const sources: Record<string, string> = import.meta.glob("../src/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
});

/**
 * Comments, then string literals, in one pass from left to right: whichever starts first wins. So
 * a backtick in a comment does not open a template literal that hides code, and "//" in a string
 * is no comment. A comment becomes a space. A template literal keeps only its `${...}` expressions,
 * so that "${error}" is still seen and a ";" or a word inside plain text does not matter.
 */
const TOKEN =
  /\/\/[^\n]*|\/\*[\s\S]*?\*\/|`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g;

function withoutLiterals(code: string): string {
  return code.replace(TOKEN, (token) => {
    if (token.startsWith("/")) return " ";
    if (token.startsWith("`")) {
      return [...token.matchAll(/\$\{[^}]*\}/g)].map((m) => ` ${m[0]} `).join("") || '""';
    }
    return '""';
  });
}

const SAFE_CALLS = /errorFields\([^)]*\)|errorCode\([^)]*\)/g;

/**
 * The same text with comments blanked and string contents kept, but with the brackets, commas and
 * semicolons inside a literal masked. The call scanner reads it where it needs the text of a
 * string, for example an event name.
 */
function shape(code: string): string {
  return code.replace(TOKEN, (token) =>
    token.startsWith("/") ? token.replace(/[^\n]/g, " ") : token.replace(/[(){}[\],;]/g, "_"),
  );
}

/** The index of the bracket that closes the one at `open`, or -1 if it never closes. */
function closing(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const char = code[i];
    if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Splits at top-level commas, outside brackets. Empty parts are dropped. */
function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") depth--;
    else if (char === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

interface LogCall {
  /** The arguments of `error`, `warn` or `info`, split at top-level commas. */
  args: string[];
  /** The arguments of each `.with(...)` link before it. */
  withArgs: string[][];
}

interface LogScan {
  calls: LogCall[];
  /** Uses of `log` that are not a call of a known form, as short texts. */
  stray: string[];
}

/**
 * Every use of `log` in code without comments and literals. A call is `log`, any number of
 * `.with(...)` links and then `.error(`, `.warn(` or `.info(`, with whitespace and line breaks
 * allowed between the parts. Brackets are balanced, so nested ones and multi-line arguments are
 * read whole. Any other use of `log` (an alias, passing it on, `log["error"]`, `log?.error(`, an
 * export) is reported as stray. The import of `log` is not a use.
 */
function scanLogs(code: string): LogScan {
  const text = code.replace(/\bimport\b[^;]*?\bfrom\s*"[^"]*"/g, (m) => " ".repeat(m.length));
  const skip = (from: number) => {
    let i = from;
    while (i < text.length && /\s/.test(text[i] as string)) i++;
    return i;
  };
  /** The call that starts at the `log` at `start`, or null if the use has another form. */
  const readCall = (start: number): LogCall | null => {
    const withArgs: string[][] = [];
    let i = start + 3;
    for (;;) {
      i = skip(i);
      if (text[i] !== ".") return null;
      i = skip(i + 1);
      const name = /^[A-Za-z_$][\w$]*/.exec(text.slice(i))?.[0];
      if (name === undefined) return null;
      i = skip(i + name.length);
      const end = text[i] === "(" ? closing(text, i) : -1;
      if (end === -1) return null;
      const args = splitTop(text.slice(i + 1, end));
      if (name === "with") {
        withArgs.push(args);
        i = end + 1;
      } else if (name === "error" || name === "warn" || name === "info") {
        return { args, withArgs };
      } else {
        return null;
      }
    }
  };
  const calls: LogCall[] = [];
  const stray: string[] = [];
  for (const found of text.matchAll(/(?<![\w$.])log(?![\w$])/g)) {
    const call = readCall(found.index);
    if (call) calls.push(call);
    else
      stray.push(
        text
          .slice(found.index, found.index + 60)
          .replace(/\s+/g, " ")
          .trim(),
      );
  }
  return { calls, stray };
}

/** Names that hold a caught error: any `catch (name)` or `.catch((name) =>`, plus common ones. */
function errorNames(code: string): string[] {
  const names = new Set(["error", "err", "e", "cause"]);
  for (const m of code.matchAll(/\bcatch\s*\(\s*(\w+)/g)) names.add(m[1] as string);
  for (const m of code.matchAll(
    /\.catch\(\s*(?:async\s*)?(?:function\s*)?\(?\s*(\w+)\s*(?::\s*\w+\s*)?\)?\s*(?:=>|\{)/g,
  )) {
    names.add(m[1] as string);
  }
  return [...names];
}

/** Places that send a raw error, message or stack toward a log. Empty if there are none. */
export function rawErrorLogs(source: string): string[] {
  const code = withoutLiterals(source);
  const names = errorNames(code);
  const word = new RegExp(`\\b(?:${names.join("|")})\\b`);
  const found: string[] = [];
  // A console call that names an error value, `.message` or `.stack`.
  for (const m of code.matchAll(/console\.(?:error|warn|log|info|debug)\(([^;]*)\);/g)) {
    const args = (m[1] ?? "").replace(SAFE_CALLS, "");
    if (/\.(message|stack)\b/.test(args) || word.test(args)) found.push(`console(${args.trim()})`);
  }
  // A logger call. The third argument is the caught value itself: the logger keeps only its
  // `errorFields`. The event and the fields must not name an error, `.message` or `.stack`.
  for (const call of scanLogs(code).calls) {
    const [event = "", fields = "", error, ...extra] = call.args;
    const named = [event, fields, ...extra, ...call.withArgs.flat()]
      .join(", ")
      .replace(SAFE_CALLS, "");
    if (/\.(message|stack)\b/.test(named) || word.test(named)) found.push(`log(${named})`);
    if (error !== undefined && !/^\w+$/.test(error)) found.push(`log(..., ${error})`);
    // A remote calendar ID is often an email address; log IDs of slotmirror instead.
    if (/\b(?:calendarId|remoteCalendarId|email)\b/.test(fields)) found.push(`log(${fields})`);
  }
  // `.catch(console.error)` passes the raw error as the argument.
  for (const m of code.matchAll(/\.catch\(\s*console\.\w+\s*\)/g)) found.push(m[0]);
  // The error turned into text: `${error}`, `${e.message}`, JSON.stringify(err), String(err).
  const textual = new RegExp(
    `\\$\\{\\s*(?:${names.join(
      "|",
    )})\\s*(?:\\.(?:message|stack)\\b[^}]*)?\\}|JSON\\.stringify\\(\\s*(?:${names.join(
      "|",
    )})\\b|\\bString\\(\\s*(?:${names.join("|")})\\s*\\)`,
    "g",
  );
  for (const m of code.matchAll(textual)) found.push(m[0]);
  return found;
}

/**
 * Keys that logger calls use today. Each one holds an ID, a code, a status, a count, a duration
 * or a static value, and never what an event or a calendar says. The README promises that logs
 * never hold event titles, calendar names or addresses.
 */
const ALLOWED_KEYS = new Set([
  "accountId", // slotmirror's account ID
  "accounts", // a count
  "action", // "preview" or "run"
  "attempts", // a count
  "auditKind", // a fixed audit kind
  "code", // an error or provider code
  "fromAccountId", // slotmirror's account ID
  "index", // a position in a list
  "instance", // the Durable Object name, which is the account ID
  "issues", // schema issue codes and paths, never the item
  "jobs", // a count
  "method", // the HTTP method
  "orgId", // slotmirror's organisation ID
  "provider", // "google" or "microsoft"
  "purpose", // "sign-in" or "connect"
  "reference", // a short random ID that carries no data
  "route", // the route pattern, not the URL
  "ruleId", // slotmirror's rule ID
  "scanned", // a count
  "status", // an HTTP status
  "statuses", // HTTP statuses
  "tickLimit", // a count
  "time", // a timestamp
  "tool", // the name of an MCP tool
  "toAccountId", // slotmirror's account ID
  "userId", // slotmirror's user ID
  "watchId", // the ID of a push channel that slotmirror made
  "what", // a static label such as "calendar"
]);

/** Values that read like content but are not, each with its reason. Exact text. */
const SAFE_VALUES = new Set([
  "tool.name", // the name of an MCP tool, not of a calendar
  "toolName", // the same
  "this.ctx.id.name", // the Durable Object name, which is the account ID (`getByName(accountId)`)
]);

/** Words that point at what an event or a calendar says, or where it lives. */
const CONTENT_WORDS = new Set(
  [
    "title",
    "subject",
    "summary",
    "location",
    "where",
    "body",
    "description",
    "attendee",
    "organizer",
    "email",
    "mail",
    "address",
    "remote",
  ].flatMap((word) => [word, word + "s", word + "es", word.replace(/y$/, "ies")]),
);

/** An identifier that ends in one of these words is a number or a state: `bodyBytes`, `emailCount`. */
const COUNT_WORDS = new Set([
  "count",
  "counts",
  "length",
  "size",
  "bytes",
  "status",
  "code",
  "ms",
  "total",
  "duration",
  "index",
]);

/** The words of an identifier: `remoteCalendarId` is remote, calendar, id. */
function words(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s_$]+/)
    .filter((word) => word !== "");
}

/** Why an identifier points at content, or null. */
function contentWord(identifier: string): string | null {
  const parts = words(identifier);
  if (COUNT_WORDS.has(parts[parts.length - 1] ?? "")) return null;
  const hit = parts.find((part) => CONTENT_WORDS.has(part));
  if (hit) return hit;
  if (parts[parts.length - 1] === "name") return "name";
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === "calendar" && (parts[i + 1] === "id" || parts[i + 1] === "name")) {
      return "calendar " + parts[i + 1];
    }
  }
  return null;
}

/** A name, then any number of `.name`, `?.name` and `[index]` steps: `calendars[i].name`. */
const CHAIN = /[A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*|\[[^\]]*\])*/g;

/** Content that a value expression names, as short descriptions. */
function contentInValue(value: string): string[] {
  const found: string[] = [];
  for (const [raw] of value.matchAll(CHAIN)) {
    const chain = raw.replace(/\s+/g, "").replace(/\?\./g, ".");
    if (SAFE_VALUES.has(chain) || /\.(?:length|size|byteLength)$/.test(chain)) continue;
    const identifiers = chain.match(/[A-Za-z_$][\w$]*/g) ?? [];
    const hit = identifiers.map(contentWord).find((word) => word !== null);
    if (hit) found.push(`value ${chain} (${hit})`);
    // `cal.id` or `calendars[i].id`: the ID of a calendar is often the remote one.
    const steps = chain.replace(/\[[^\]]*\]/g, "").match(/[A-Za-z_$][\w$]*/g) ?? [];
    const last = steps.at(-1);
    const before = steps.at(-2);
    if (last === "id" && before && /^cal(?:endar)?s?$/i.test(before)) {
      found.push(`value ${chain} (calendar id)`);
    }
  }
  return found;
}

/**
 * Content or an unreadable form in a fields argument, as short descriptions. The fields must be an
 * inline object literal, `undefined` or absent. A named object, a spread, a call result, a quoted
 * or computed key and a key that is not on the allowlist are reported, so that a call that this
 * check cannot read does not pass.
 *
 * Inherent limit: the check is textual. A local variable with a neutral name that holds content
 * (`const n = ev.title; log.error("x.y", { id: n })`) is not seen.
 */
function contentInFields(fields: string, allowed: ReadonlySet<string>): string[] {
  const text = fields.trim();
  if (text === "" || text === "undefined") return [];
  if (!text.startsWith("{") || closing(text, 0) !== text.length - 1) {
    return [`fields "${text}" are not an inline object literal`];
  }
  const found: string[] = [];
  for (const entry of splitTop(text.slice(1, -1))) {
    const parsed = /^([A-Za-z_$][\w$]*)\s*(?::([\s\S]*))?$/.exec(entry);
    if (!parsed) {
      found.push(`entry "${entry}" is a spread, a method, or a quoted or computed key`);
      continue;
    }
    const [, key = "", value = key] = parsed;
    if (!allowed.has(key)) {
      found.push(
        `key ${key} is not on the allowlist; add it only for an ID, code, status, count, duration or static value`,
      );
    }
    found.push(...contentInValue(value));
  }
  return found;
}

/**
 * Logger calls whose fields or `.with(...)` context name event or calendar content, or are not an
 * inline object literal. Empty if there are none.
 */
export function contentLogs(source: string, allowed: ReadonlySet<string> = ALLOWED_KEYS): string[] {
  const found: string[] = [];
  for (const call of scanLogs(withoutLiterals(source)).calls) {
    const arguments_ = [call.args[1] ?? "", ...call.withArgs.map((args) => args[0] ?? "")];
    for (const fields of arguments_) {
      for (const reason of contentInFields(fields, allowed))
        found.push(`log(${fields}): ${reason}`);
    }
  }
  return found;
}

/** Uses of `log` that are not a call of a known form. The check cannot read them. */
export function strayLogUses(source: string): string[] {
  return scanLogs(withoutLiterals(source)).stray.map((use) => `log use is not a call: ${use}`);
}

/** The module that defines `log`. It is not a use. */
const TELEMETRY = "../src/telemetry.ts";

/**
 * Places that must turn an error into text, and why. The test fails if one of them is gone or
 * occurs twice, so the list stays exact.
 */
const ERROR_TEXT_ALLOWED = [
  // The Node runtime copies D1's error form "D1_ERROR: <SQLite message>"; safeMessage() then
  // decides what reaches a log, as on Cloudflare.
  "../src/runtime/node/sql-database.ts: String(error)",
  "../src/runtime/node/sql-database.ts: ${error.message}",
  // A failed migration stops the start and names the file and the SQLite error of its static SQL.
  "../src/runtime/node/migrations.ts: String(error)",
  // Not a log: a sign-in tests the text for D1's UNIQUE refusal and keeps it nowhere.
  "../src/users.ts: String(error)",
];

describe("log hygiene", () => {
  it("logs no raw error, message or stack outside errorFields", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(10);
    const hits = Object.entries(sources).flatMap(([path, code]) =>
      rawErrorLogs(code).map((hit) => `${path}: ${hit}`),
    );
    expect(hits.filter((hit) => !ERROR_TEXT_ALLOWED.includes(hit))).toEqual([]);
    // Each allowed place occurs exactly once: not gone, and not copied.
    expect(hits.filter((hit) => ERROR_TEXT_ALLOWED.includes(hit)).sort()).toEqual(
      [...ERROR_TEXT_ALLOWED].sort(),
    );
  });

  it("calls console only in the runtime adapters", () => {
    const calls = Object.entries(sources).flatMap(([path, code]) =>
      path.startsWith("../src/runtime/")
        ? []
        : [...withoutLiterals(code).matchAll(/\bconsole\.\w+/g)].map((m) => `${path}: ${m[0]}`),
    );
    expect(calls).toEqual([]);
  });

  it("names every log event in dotted lower case", () => {
    const events = Object.entries(sources).flatMap(([path, code]) =>
      scanLogs(shape(code)).calls.map((call) => ({
        path,
        event: call.args[0] ?? "",
      })),
    );
    expect(events.length).toBeGreaterThan(70);
    const bad = events.filter(({ event }) => !/^"[a-z][a-z_]*(\.[a-z][a-z_]*)+"$/.test(event));
    expect(bad).toEqual([]);
  });

  it("logs no event or calendar content", () => {
    const hits = Object.entries(sources).flatMap(([path, code]) => [
      ...contentLogs(code).map((hit) => `${path}: ${hit}`),
      ...(path === TELEMETRY ? [] : strayLogUses(code).map((hit) => `${path}: ${hit}`)),
    ]);
    expect(hits).toEqual([]);
  });

  it("sees code after a backtick in a comment, and no comment inside a string", () => {
    expect(rawErrorLogs("// a `quote\nconsole.error(error);\n// end`")).toHaveLength(1);
    expect(rawErrorLogs('const url = "https://x"; console.error(error);')).toHaveLength(1);
    expect(rawErrorLogs("/* console.error(error); */ const x = 1;")).toHaveLength(0);
  });

  it("finds a raw error in a logger call", () => {
    expect(rawErrorLogs('log.error("x.y", { id }, error);')).toHaveLength(0);
    expect(rawErrorLogs('log.error("x.y", { error });')).toHaveLength(1);
    expect(rawErrorLogs('log.error("x.y", { text: e.message });')).toHaveLength(1);
    expect(rawErrorLogs('log.warn("x.y", { stack: error.stack }, error);')).toHaveLength(1);
    expect(rawErrorLogs('log.error("x.y", {}, error.message);')).toHaveLength(1);
    expect(rawErrorLogs('log.error("x.y", { code: errorCode(error) }, error);')).toHaveLength(0);
    expect(rawErrorLogs('log.with({ id }).error("x.y", { text: e.message });')).toHaveLength(1);
    expect(rawErrorLogs('log.error("x.y", { calendarId }, error);')).toHaveLength(1);
    expect(rawErrorLogs('log.warn("x.y", { email: user.email });')).toHaveLength(1);
    expect(rawErrorLogs("try { x(); } catch (boom) { log.error('x.y', { boom }); }")).toHaveLength(
      1,
    );
  });

  it("finds a raw error in a console call", () => {
    expect(rawErrorLogs('console.error("x", id, error);')).toHaveLength(1);
    expect(rawErrorLogs('console.error("x", e.message);')).toHaveLength(1);
    expect(rawErrorLogs('console.error("x", error.stack);')).toHaveLength(1);
    expect(rawErrorLogs('console.error("x; y", id, errorFields(error));')).toHaveLength(0);
    expect(rawErrorLogs('console.error("x", errorCode(error));')).toHaveLength(0);
  });

  it("finds an error inside a template string", () => {
    expect(rawErrorLogs("console.error(`failed: ${error}`);").length).toBeGreaterThan(0);
    expect(rawErrorLogs("console.error(`failed: ${e.message}`);").length).toBeGreaterThan(0);
    expect(rawErrorLogs("const text = `failed: ${error}`;")).toHaveLength(1);
    expect(rawErrorLogs("console.error(`${provider} failed`, id);")).toHaveLength(0);
  });

  it("tracks the name of a catch parameter", () => {
    expect(
      rawErrorLogs("try { x(); } catch (problem) { console.error('x', problem); }"),
    ).toHaveLength(1);
    expect(
      rawErrorLogs("try { x(); } catch (boom) { console.error(`x ${boom}`); }").length,
    ).toBeGreaterThan(0);
    expect(rawErrorLogs("x().catch((reason) => console.error('x', reason));")).toHaveLength(1);
    expect(rawErrorLogs("try { x(); } catch (problem) { console.error('x', id); }")).toHaveLength(
      0,
    );
  });

  it("finds a stringified error", () => {
    expect(rawErrorLogs("console.error('x', JSON.stringify(err));").length).toBeGreaterThan(0);
    expect(rawErrorLogs("const t = JSON.stringify(error);")).toHaveLength(1);
    expect(rawErrorLogs("const t = String(error);")).toHaveLength(1);
  });

  it("finds .catch(console.error)", () => {
    expect(rawErrorLogs("promise.catch(console.error);")).toHaveLength(1);
    expect(rawErrorLogs("promise.catch( console.warn );")).toHaveLength(1);
  });

  it("tracks the name of a typed catch parameter", () => {
    expect(
      rawErrorLogs("x().catch((reason: unknown) => console.error('x', reason));"),
    ).toHaveLength(1);
    expect(rawErrorLogs("x().catch((reason: unknown) => console.error('x', id));")).toHaveLength(0);
  });

  describe("content check", () => {
    const hits = (code: string, allowed?: ReadonlySet<string>) =>
      contentLogs(code, allowed).length + strayLogUses(code).length;
    // Keys that the cases below use, so that a case tests the value or the form, not the allowlist.
    const open = new Set([
      ...ALLOWED_KEYS,
      "n",
      "title",
      "calendar",
      "label",
      "summaryCount",
      "bodyBytes",
      "remoteStatus",
      "attendeeCount",
      "toolName",
      "place",
      "kids",
      "cal",
    ]);

    it("accepts the forms that the code uses", () => {
      expect(hits('log.error("x.y", { accountId, code: errorCode(error) }, error);')).toBe(0);
      expect(hits('log.error("x.y", { status: response.status, n: items.length });', open)).toBe(0);
      expect(hits('log.error("x.y", { tool: tool.name }, error);')).toBe(0);
      expect(
        hits('log.error("x.y", { instance: this.ctx.id.name ?? this.ctx.id.toString() });'),
      ).toBe(0);
      expect(hits('log.error("x.y");')).toBe(0);
      expect(hits('log.error("x.y", undefined, error);')).toBe(0);
      expect(
        hits('log.error(\n  "x.y",\n  { provider, code: info.code ?? "" },\n  error,\n);'),
      ).toBe(0);
      expect(hits('log.with({ accountId }).error("x.y", { ruleId });')).toBe(0);
    });

    it("does not reject counts, states and the tool name", () => {
      expect(hits('log.error("x.y", { summaryCount: n });', open)).toBe(0);
      expect(hits('log.error("x.y", { bodyBytes });', open)).toBe(0);
      expect(hits('log.error("x.y", { remoteStatus });', open)).toBe(0);
      expect(hits('log.error("x.y", { attendeeCount: ev.attendees.length });', open)).toBe(0);
      expect(hits('log.error("x.y", { toolName: tool.name });', open)).toBe(0);
      expect(hits('log.error("x.y", { tool: toolName });')).toBe(0);
      expect(hits('log.error("x.y", { n: ev.title.length });', open)).toBe(0);
    });

    it("reads the arguments of log.with(...)", () => {
      expect(hits('log.with({ title: ev.title }).error("x.y", { accountId });', open)).toBe(1);
      expect(hits('log.with({ n: ev.subject }).error("x.y");', open)).toBe(1);
      expect(hits('log.with({ n: ev.location }).error("x.y");', open)).toBe(1);
      expect(hits('log.with({ foo: 1 }).error("x.y");')).toBe(1);
      expect(hits('log.with(ctx).error("x.y");')).toBe(1);
    });

    it("reads calls with nested brackets, line breaks and several links", () => {
      expect(hits('log.with({ n: idOf(a) }).error("x.y", { title: ev.title });', open)).toBe(1);
      expect(hits('log.with({ n: pick([a, b]) }).error("x.y", { title: ev.title });', open)).toBe(
        1,
      );
      expect(hits('log\n  .with({ accountId })\n  .warn("x.y", { title: ev.title });', open)).toBe(
        1,
      );
      expect(hits('log.with({ accountId }).with({ n }).error("x.y", { title });', open)).toBe(1);
      expect(hits('log.with({ accountId })\n.with({ title: ev.title })\n.info("x.y");', open)).toBe(
        1,
      );
      expect(hits('log.error(\n "x.y",\n {\n  title:\n   ev.title,\n },\n error,\n);', open)).toBe(
        1,
      );
      expect(hits('log . error ( "x.y" , { title : ev.title } );', open)).toBe(1);
    });

    it("reports a use of log that is not a known call", () => {
      expect(strayLogUses('const logger = log;\nlogger.error("x.y", { title });')).toHaveLength(1);
      expect(strayLogUses("run(log);")).toHaveLength(1);
      expect(strayLogUses("const { error } = log;")).toHaveLength(1);
      expect(strayLogUses('log["error"]("x.y", { title });')).toHaveLength(1);
      expect(strayLogUses('log?.error("x.y");')).toHaveLength(1);
      expect(strayLogUses('const l = log.with({ accountId });\nl.error("x.y");')).toHaveLength(1);
      expect(strayLogUses('log.debug("x.y");')).toHaveLength(1);
      expect(strayLogUses("export { log } from './telemetry';")).toHaveLength(1);
      // Not uses: the import, a property named log, a call that is known.
      expect(strayLogUses('import { carrier, log } from "./telemetry";')).toHaveLength(0);
      expect(strayLogUses('import {\n  log,\n  carrier,\n} from "./telemetry";')).toHaveLength(0);
      expect(strayLogUses("console.log(line); this.log = 1;")).toHaveLength(0);
      expect(strayLogUses('log.error("x.y");')).toHaveLength(0);
    });

    it("accepts only an inline object, undefined or no fields", () => {
      expect(hits('const f = { accountId };\nlog.error("x.y", f);')).toBe(1);
      expect(hits('log.error("x.y", fieldsFrom(ev));')).toBe(1);
      expect(hits('log.error("x.y", { ...f, accountId });')).toBe(1);
      expect(hits('log.error("x.y", { ...{ accountId } });')).toBe(1);
      expect(hits('log.error("x.y", { "accountId": id });')).toBe(1);
      expect(hits('log.error("x.y", { [key]: id });')).toBe(1);
      expect(hits('log.error("x.y", { accountId() { return 1; } });')).toBe(1);
      expect(hits('log.error("x.y", cond ? { accountId } : {});')).toBe(1);
      expect(hits('log.error("x.y", { accountId } as Fields);')).toBe(1);
    });

    it("does not resolve a named object, so a later one or a change cannot hide content", () => {
      expect(
        hits(
          'function a() { const fields = { accountId }; }\nfunction b() { const fields = { title }; log.error("x.y", fields); }',
          open,
        ),
      ).toBe(1);
      expect(hits("function a(fields) { log.error('x.y', fields); }")).toBe(1);
      expect(hits('const f = { accountId };\nf.title = ev.title;\nlog.error("x.y", f);')).toBe(1);
      expect(hits('let f = { accountId };\nif (x) f = { title };\nlog.error("x.y", f);')).toBe(1);
    });

    it("rejects a key that is not on the allowlist", () => {
      expect(contentLogs('log.error("x.y", { foo: 1 });')).toEqual([
        expect.stringContaining("key foo is not on the allowlist"),
      ]);
      expect(contentLogs('log.error("x.y", { foo });')[0]).toContain("an ID, code, status, count");
      expect(contentLogs('log.error("x.y", { accountId, ruleId, status: 500 });')).toEqual([]);
    });

    it("finds content in a value", () => {
      for (const value of [
        "ev.title",
        "ev.subject",
        "ev.summary",
        "ev.location",
        "ev.description",
        "ev.body",
        "ev.organizer",
        "ev.organizer.email",
        "user.email",
        "ev.attendees",
        "ev.attendees.map((a) => a.mail)",
        "ev.addresses",
        "source.address",
        "source.remoteId",
        "remoteCalendarId",
        "calendarId",
        "calendar.id",
        "cal.id",
        "calendars[i].id",
        "calendar.name",
        "calendars[i].name",
        "calendars?.[0]?.name",
        "target.name",
        "account.displayName",
        "`${ev.title}`",
        "(ev.title)",
        "ev.title ?? ''",
      ]) {
        expect(contentLogs(`log.error("x.y", { n: ${value} });`, open), value).not.toEqual([]);
      }
      expect(contentLogs('log.error("x.y", { calendar: calendar.id });', open)).not.toEqual([]);
      expect(contentLogs('log.error("x.y", { n: calendars[i].name });', open)).not.toEqual([]);
      expect(contentLogs('log.error("x.y", { n: target.name });', open)).not.toEqual([]);
    });

    it("keeps the rule from main for calendar IDs and addresses in the raw-error check", () => {
      expect(rawErrorLogs('log.error("x.y", { calendarId }, error);')).toHaveLength(1);
      expect(rawErrorLogs('log.error("x.y", { remoteCalendarId: id });')).toHaveLength(1);
      expect(rawErrorLogs('log.warn("x.y", { email: user.email });')).toHaveLength(1);
    });

    it("reads a raw error in a with argument and in a multi-line chain", () => {
      expect(rawErrorLogs('log.with({ text: e.message }).error("x.y");')).toHaveLength(1);
      expect(
        rawErrorLogs('log\n  .with({ accountId })\n  .error("x.y", { text: e.message });'),
      ).toHaveLength(1);
    });

    it("reads event names through the same scanner", () => {
      const names = (code: string) => scanLogs(shape(code)).calls.map((call) => call.args[0]);
      expect(names('log.error("a.b");\nlog\n  .with({ n: [1, 2] })\n  .warn("c.d", {});')).toEqual([
        '"a.b"',
        '"c.d"',
      ]);
      expect(names('log.error("a(.b", {});')).toEqual(['"a_.b"']);
    });

    it("treats a template literal or a comment like the other checks do", () => {
      // A bracket in a string or comment does not unbalance the call.
      expect(hits('log.error("x.y)", { accountId: "}" /* ) */, status: 1 });')).toBe(0);
      expect(hits('log.error("x.y", { n: `${ev.title}` });', open)).toBe(1);
      expect(hits('// log.error("x.y", { title });\nconst x = 1;')).toBe(0);
    });
  });
});
