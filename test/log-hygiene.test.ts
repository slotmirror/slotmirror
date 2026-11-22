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
      return [...token.matchAll(/\$\{([^}]*)\}/g)].map((m) => ` \${${m[1]}} `).join("") || '""';
    }
    return '""';
  });
}

const SAFE_CALLS = /errorFields\([^)]*\)|errorCode\([^)]*\)/g;

/** A logger call, also on a logger that `log.with(...)` made. */
const LOG_CALL = /\blog(?:\.with\([^)]*\))?\.(?:error|warn|info)\(/g;

/** The arguments of the call whose "(" is at `open`, split at top-level commas. */
function callArgs(code: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < code.length; i++) {
    const char = code[i];
    if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") {
      depth--;
      if (depth === 0) {
        args.push(code.slice(start, i));
        return args.map((arg) => arg.trim()).filter((arg) => arg !== "");
      }
    } else if (char === "," && depth === 1) {
      args.push(code.slice(start, i));
      start = i + 1;
    }
  }
  return args;
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
  for (const m of code.matchAll(LOG_CALL)) {
    const [event = "", fields = "", error, ...extra] = callArgs(code, m.index + m[0].length - 1);
    const named = [event, fields, ...extra].join(", ").replace(SAFE_CALLS, "");
    if (/\.(message|stack)\b/.test(named) || word.test(named)) found.push(`log(${named})`);
    if (error !== undefined && !/^\w+$/.test(error)) found.push(`log(..., ${error})`);
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
 * Words that point at content: what an event or a calendar says, or where it lives. A log field
 * must name an ID, a code, a status or a count. The README promises that logs never hold event
 * titles, calendar names or addresses.
 */
const CONTENT_WORDS = new Set([
  "title",
  "subject",
  "summary",
  "location",
  "where",
  "body",
  "description",
  "attendee",
  "attendees",
  "organizer",
  "email",
  "mail",
  "address",
  "remote",
]);

/** The words of an identifier: `remoteCalendarId` is remote, calendar, id. */
function words(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s_]+/)
    .filter((word) => word !== "");
}

/**
 * Why an identifier points at content, or null. `name` alone is fine as a value (`tool.name`), but
 * not as a key, and a calendar ID or name is not fine in either place: a remote calendar ID is
 * often an email address, so log IDs of slotmirror instead.
 */
function contentWord(identifier: string, asKey: boolean): string | null {
  const parts = words(identifier);
  const hit = parts.find((part) => CONTENT_WORDS.has(part));
  if (hit) return hit;
  if (parts.includes("name") && (asKey || parts.length > 1)) return "name";
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === "calendar" && (parts[i + 1] === "id" || parts[i + 1] === "name")) {
      return "calendar " + parts[i + 1];
    }
  }
  return null;
}

/** Splits at top-level commas, outside brackets. */
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

/** The index of the bracket that closes the one at `open`. */
function matching(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{" || code[i] === "(" || code[i] === "[") depth++;
    else if (code[i] === "}" || code[i] === ")" || code[i] === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return code.length - 1;
}

/**
 * Content that a fields argument names, as short descriptions. Looks at each key and at every
 * identifier in each value. A fields object built beforehand (`log.error("x.y", f)` or
 * `{ ...f }`) is read from its `const f = { ... }` in the same file. Fields that this check
 * cannot read (a call result, a parameter) are reported too, so nothing passes unseen.
 */
function contentInFields(code: string, fields: string, seen = new Set<string>()): string[] {
  const text = fields.trim();
  if (/^\w+$/.test(text)) {
    if (seen.has(text)) return [];
    seen.add(text);
    const built = new RegExp(`\\b(?:const|let|var)\\s+${text}\\b[^=]*=\\s*\\{`).exec(code);
    if (!built) return [`fields "${text}" is not built in this file`];
    const open = built.index + built[0].length - 1;
    return contentInFields(code, code.slice(open, matching(code, open) + 1), seen);
  }
  if (!text.startsWith("{")) return text === "" ? [] : [`fields "${text}" is not an object`];
  const found: string[] = [];
  for (const entry of splitTop(text.slice(1, text.lastIndexOf("}")))) {
    if (entry.startsWith("...")) {
      found.push(...contentInFields(code, entry.slice(3), seen));
      continue;
    }
    const key = /^(\w+|""|\[)/.exec(entry)?.[1] ?? "";
    if (key === '""' || key === "[") {
      found.push(`key "${entry}" is quoted or computed`);
      continue;
    }
    const word = contentWord(key, true);
    if (word) found.push(`key ${key} (${word})`);
    const value = entry.includes(":") ? entry.slice(entry.indexOf(":") + 1) : "";
    for (const identifier of value.match(/[A-Za-z_]\w*/g) ?? []) {
      const valueWord = contentWord(identifier, false);
      if (valueWord) found.push(`value ${identifier} (${valueWord})`);
    }
    // A bare `.name` is fine (`tool.name`), but the name of a calendar, event or account is not.
    for (const [, receiver = ""] of value.matchAll(/(\w+)\??\.name\b/g)) {
      if (
        words(receiver).some((word) => ["calendar", "cal", "event", "ev", "account"].includes(word))
      ) {
        found.push(`value ${receiver}.name (name)`);
      }
    }
  }
  return found;
}

/** Logger calls whose fields name event or calendar content. Empty if there are none. */
export function contentLogs(source: string): string[] {
  const code = withoutLiterals(source);
  const found: string[] = [];
  for (const m of code.matchAll(LOG_CALL)) {
    const fields = callArgs(code, m.index + m[0].length - 1)[1] ?? "";
    for (const reason of contentInFields(code, fields)) found.push(`log(${fields}): ${reason}`);
  }
  return found;
}

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

  it("logs no event or calendar content", () => {
    const hits = Object.entries(sources).flatMap(([path, code]) =>
      contentLogs(code).map((hit) => `${path}: ${hit}`),
    );
    expect(hits).toEqual([]);
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
      [...code.matchAll(/\blog(?:\.with\([^)]*\))?\.(?:error|warn|info)\(\s*([^,)]*)/g)].map(
        (m) => ({
          path,
          event: (m[1] ?? "").trim(),
        }),
      ),
    );
    expect(events.length).toBeGreaterThan(70);
    const bad = events.filter(({ event }) => !/^"[a-z][a-z_]*(\.[a-z][a-z_]*)+"$/.test(event));
    expect(bad).toEqual([]);
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

  it("finds content in the fields of a logger call", () => {
    expect(contentLogs('log.error("x.y", { id, code: errorCode(error) }, error);')).toHaveLength(0);
    expect(contentLogs('log.error("x.y", { accountId, status: 500, count: n });')).toHaveLength(0);
    expect(contentLogs('log.error("x.y", { tool: tool.name });')).toHaveLength(0);
    expect(contentLogs('log.error("x.y", { title: ev.title });').length).toBeGreaterThan(0);
    expect(contentLogs('log.error("x.y", { remote: source.remoteId });').length).toBeGreaterThan(0);
    expect(contentLogs('log.error("x.y", { where: ev.location });').length).toBeGreaterThan(0);
    expect(contentLogs('log.error("x.y", { id: ev.subject });').length).toBeGreaterThan(0);
    expect(contentLogs('log.warn("x.y", { n: ev.attendees.length });').length).toBeGreaterThan(0);
    expect(contentLogs('log.warn("x.y", { calendar: cal.name });').length).toBeGreaterThan(0);
    expect(contentLogs('log.warn("x.y", { label: calendar.displayName });').length).toBeGreaterThan(
      0,
    );
    expect(contentLogs('log.warn("x.y", { calendarId });').length).toBeGreaterThan(0);
    expect(contentLogs('log.warn("x.y", { email: user.email });').length).toBeGreaterThan(0);
    expect(contentLogs('log.with({ id }).warn("x.y", { body: ev.body });').length).toBeGreaterThan(
      0,
    );
  });

  it("finds content in a fields object that was built beforehand", () => {
    expect(
      contentLogs('const f = { where: ev.location };\nlog.error("x.y", f);').length,
    ).toBeGreaterThan(0);
    expect(contentLogs('const f = { id };\nlog.error("x.y", f);')).toHaveLength(0);
    expect(
      contentLogs('const f = { place: ev.location };\nlog.error("x.y", { ...f, id });').length,
    ).toBeGreaterThan(0);
    // Fields that this check cannot read are reported, so that nothing passes unseen.
    expect(contentLogs('log.error("x.y", fieldsFrom(ev));').length).toBeGreaterThan(0);
    expect(contentLogs('log.error("x.y", f);').length).toBeGreaterThan(0);
  });

  it("tracks the name of a typed catch parameter", () => {
    expect(
      rawErrorLogs("x().catch((reason: unknown) => console.error('x', reason));"),
    ).toHaveLength(1);
    expect(rawErrorLogs("x().catch((reason: unknown) => console.error('x', id));")).toHaveLength(0);
  });
});
