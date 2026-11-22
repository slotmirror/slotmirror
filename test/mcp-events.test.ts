import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fromJSONSchema, type z } from "zod";
import * as zm from "zod/mini";
import { MAX_SOURCE_CACHE, type AccountSync } from "../src/account-sync";
import { createApiToken } from "../src/api-tokens";
import worker from "../src/index";
import {
  LIST_EVENTS_INPUT_SCHEMA,
  listEventsInput,
  MAX_EVENTS,
  withoutLinks,
} from "../src/mcp-events";
import {
  changeFakeWireEvent,
  type FakeEvent,
  type FakeWireFields,
} from "../src/providers/fake-calendar";
import { eventsAnswer, MAX_EVENT_CALENDARS } from "../src/read-model";
import { BASE, EMPTY_FAKE_SEED, noFakeNetwork, signIn, stopClock } from "./helpers";

const DAY = 86_400_000;
/** A fixed winter window, so that the offsets in the answers do not depend on today's date. */
const START = "2027-01-15";
const END = "2027-01-16";
const at = (hour: number) => `2027-01-15T${String(hour).padStart(2, "0")}:00:00.000Z`;

type Stub = DurableObjectStub<AccountSync>;
const stubs = new Set<string>();

function stubOf(accountId: string): Stub {
  stubs.add(accountId);
  return env.ACCOUNT_SYNC.getByName(accountId);
}

interface RpcBody {
  result?: Record<string, unknown> & {
    structuredContent?: Record<string, unknown>;
    content?: { type: string; text: string }[];
    isError?: boolean;
    tools?: { name: string; inputSchema: unknown; outputSchema: unknown; annotations: object }[];
  };
  error?: { code: number; message: string };
}

interface Answer {
  start: string;
  end: string;
  timeZone: string;
  events: Record<string, unknown>[];
  errors: Record<string, unknown>[];
  truncated: boolean;
  calendarsTruncated: boolean;
}

async function rpc(
  token: string,
  method: string,
  params: object = {},
  overrides?: Partial<Env>,
): Promise<Response> {
  const init = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  };
  if (!overrides) return exports.default.fetch(`${BASE}/mcp`, init);
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${BASE}/mcp`, init),
    { ...env, ...overrides },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

async function toolNames(token: string, overrides?: Partial<Env>): Promise<string[]> {
  const body = (await (await rpc(token, "tools/list", {}, overrides)).json()) as RpcBody;
  return (body.result?.tools ?? []).map((tool) => tool.name);
}

async function callRaw(token: string, args: unknown, overrides?: Partial<Env>) {
  const response = await rpc(
    token,
    "tools/call",
    { name: "list_events", arguments: args },
    overrides,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as RpcBody;
}

async function listEvents(token: string, args: object, overrides?: Partial<Env>) {
  const body = await callRaw(token, args, overrides);
  expect(body.result?.isError, body.result?.content?.[0]?.text).toBeUndefined();
  return body.result?.structuredContent as unknown as Answer;
}

async function user(email = "owner@example.com") {
  const { user: signedIn } = await signIn(email);
  const events = await createApiToken(env, signedIn, { name: "events", days: 30, events: true });
  const plain = await createApiToken(env, signedIn, { name: "plain", days: 30 });
  if (!events || !plain) throw new Error("no token");
  return { userId: signedIn.id, token: events.token, plainToken: plain.token };
}

/** A simulated account with its main calendar as a source calendar. */
async function account(
  userId: string,
  id: string,
  options: { email?: string; calendar?: string; source?: boolean } = {},
): Promise<Stub> {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, 'microsoft', ?)",
    ).bind(id, userId, options.email ?? `${id}@example.com`),
    env.DB.prepare(
      `INSERT INTO calendars (id, account_id, remote_id, name, is_source)
       VALUES (?, ?, 'main', ?, ?)`,
    ).bind(`${id}-main`, id, options.calendar ?? "Work", options.source === false ? 0 : 1),
  ]);
  const stub = stubOf(id);
  await stub.storeTokens(id, {
    refreshToken: "fake",
    accessToken: "fake",
    accessExpiresAt: Date.now() + 365 * DAY,
  });
  await stub.seedFake(EMPTY_FAKE_SEED, 0);
  return stub;
}

/** An event in the provider's wire format, read through the real Graph parser. */
function wireEvent(stub: Stub, key: string, event: FakeWireFields): Promise<void> {
  return runInDurableObject(stub, (_instance, state) =>
    changeFakeWireEvent(state.storage.sql, { change: "create", key, event }, "UTC"),
  );
}

const timed = (hour: number, hours = 1): Pick<FakeWireFields, "start" | "end"> => ({
  start: { dateTime: at(hour).slice(0, 19), timeZone: "UTC" },
  end: { dateTime: at(hour + hours).slice(0, 19), timeZone: "UTC" },
});

const event = (id: string, hour: number, fields: Partial<FakeEvent> = {}): FakeEvent => ({
  id,
  start: at(hour),
  end: at(hour + 1),
  ...fields,
});

beforeEach(async () => {
  stopClock();
  noFakeNetwork();
  await env.DB.batch(
    ["api_tokens", "api_usage", "api_usage_total", "rules", "accounts", "audit_events"].map(
      (table) => env.DB.prepare(`DELETE FROM ${table}`),
    ),
  );
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(
    [...stubs].map((id) =>
      runInDurableObject(stubOf(id), (_instance, state) => state.storage.deleteAlarm()),
    ),
  );
  stubs.clear();
});

describe("who may call list_events", () => {
  it("exists only for a credential whose user allowed events", async () => {
    const { token, plainToken } = await user();
    expect(await toolNames(token)).toEqual([
      "list_accounts",
      "list_rules",
      "get_sync_status",
      "list_events",
    ]);
    expect(await toolNames(plainToken)).toEqual(["list_accounts", "list_rules", "get_sync_status"]);
    const refused = await callRaw(plainToken, {});
    expect(refused.error?.code).toBe(-32602);
    expect(refused.result).toBeUndefined();
  });

  it("does not exist without MCP_EVENTS_ENABLED=1, also for a credential that allowed it", async () => {
    const { token, userId } = await user();
    const stub = await account(userId, "off-a");
    await stub.addFakeEvent(event("secret", 9, { subject: "SECRET-TITLE" }));
    for (const value of ["", "0"]) {
      expect(await toolNames(token, { MCP_EVENTS_ENABLED: value })).not.toContain("list_events");
      const refused = await callRaw(token, { start: START }, { MCP_EVENTS_ENABLED: value });
      expect(refused.error?.code).toBe(-32602);
      expect(JSON.stringify(refused)).not.toContain("SECRET-TITLE");
    }
  });

  it("reads only the token user's calendars, also for an admin", async () => {
    const admin = await user("admin@example.com");
    const other = await user("other@elsewhere.org");
    await (await account(other.userId, "oth-a")).addFakeEvent(event("x", 9, { subject: "Theirs" }));
    await (await account(admin.userId, "adm-a")).addFakeEvent(event("y", 9, { subject: "Mine" }));
    const answer = await listEvents(admin.token, { start: START });
    expect(answer.events.map((item) => item.title)).toEqual(["Mine"]);
  });

  it("marks the tool as reading the outside world, and still read-only", async () => {
    const { token } = await user();
    const body = (await (await rpc(token, "tools/list")).json()) as RpcBody;
    const tool = body.result?.tools?.find((item) => item.name === "list_events");
    expect(tool?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
  });
});

describe("arguments", () => {
  const refusals: [string, unknown, RegExp][] = [
    ["an unknown argument", { userId: "someone" }, /Allowed: start/],
    ["a list", [], /Allowed: start/],
    ["a word as time", { start: "tomorrow" }, /YYYY-MM-DD/],
    ["a time without offset", { start: "2027-01-15T09:00:00" }, /offset/],
    ["a date that does not exist", { start: "2027-02-30" }, /YYYY-MM-DD/],
    ["an unknown zone", { timeZone: "Mars/Base" }, /IANA/],
    ["a window over 31 days", { start: "2027-01-01", end: "2027-02-02" }, /31 days/],
    ["an end before the start", { start: "2027-01-02", end: "2027-01-01" }, /after start/],
    ["an end at the start", { start: "2027-01-02", end: "2027-01-02" }, /after start/],
    ["a long query", { query: "x".repeat(201) }, /Allowed: start/],
    ["a date-time that does not exist", { start: "2026-02-30T10:00Z" }, /YYYY-MM-DD/],
    ["hour 24", { start: "2026-01-01T24:00Z" }, /YYYY-MM-DD/],
    ["minute 60", { start: "2026-01-01T10:60:00Z" }, /YYYY-MM-DD/],
    ["an offset past 23 hours", { start: "2026-01-01T10:00+25:00" }, /YYYY-MM-DD/],
    // Years outside 1970 to 2199: 9999-12-31 used to answer with "+010000-01-01T…".
    ["a year past 2199", { start: "9999-12-31" }, /YYYY-MM-DD/],
    ["an end in a year past 2199", { end: "2200-01-01" }, /YYYY-MM-DD/],
    ["a date-time in a year past 2199", { start: "2200-01-01T00:00:00Z" }, /YYYY-MM-DD/],
    ["a year before 1970", { start: "1969-12-31T23:00:00Z" }, /YYYY-MM-DD/],
  ];
  for (const [label, args, message] of refusals) {
    it(`refuses ${label} with a tool error the model can read`, async () => {
      const { token } = await user();
      const body = await callRaw(token, args);
      expect(body.result?.isError).toBe(true);
      expect(body.result?.content?.[0]?.text).toMatch(message);
      expect(body.result).not.toHaveProperty("structuredContent");
    });
  }

  it("charges no call for arguments it refuses before reading", async () => {
    const { token, userId } = await user();
    await callRaw(token, { start: "tomorrow" });
    await callRaw(token, { timeZone: "Mars/Base" });
    const usage = await env.DB.prepare("SELECT calls FROM api_usage WHERE user_id = ?")
      .bind(userId)
      .first<{ calls: number }>();
    expect(usage).toBeNull();
    // Control: a call that reads is charged.
    await listEvents(token, {});
    const charged = await env.DB.prepare("SELECT calls FROM api_usage WHERE user_id = ?")
      .bind(userId)
      .first<{ calls: number }>();
    expect(charged?.calls).toBe(1);
  });

  it("takes dates from 1970 to 2199", async () => {
    const { token } = await user();
    expect(await listEvents(token, { start: "1970-01-01" })).toMatchObject({
      start: "1970-01-01T00:00:00Z",
      end: "1970-01-02T00:00:00Z",
    });
    expect(await listEvents(token, { start: "2199-12-31" })).toMatchObject({
      start: "2199-12-31T00:00:00Z",
      end: "2200-01-01T00:00:00Z",
    });
  });

  it("starts a window that names only an end date at the midnight before, also across a clock change", async () => {
    const { token } = await user();
    // Vienna moves its clocks on 2026-03-29 (23 hours) and on 2026-10-25 (25 hours).
    for (const [end, start, endIso] of [
      ["2026-03-30", "2026-03-29T00:00:00+01:00", "2026-03-30T00:00:00+02:00"],
      ["2026-10-26", "2026-10-25T00:00:00+02:00", "2026-10-26T00:00:00+01:00"],
      ["2027-01-16", "2027-01-15T00:00:00+01:00", "2027-01-16T00:00:00+01:00"],
    ]) {
      const answer = await listEvents(token, { end, timeZone: "Europe/Vienna" });
      expect(answer).toMatchObject({ start, end: endIso });
    }
    // An end with a time still starts 24 hours before.
    expect(
      await listEvents(token, { end: "2026-03-30T12:00:00+02:00", timeZone: "Europe/Vienna" }),
    ).toMatchObject({ start: "2026-03-29T12:00:00+02:00" });
  });

  it("counts the 31 days in calendar days, also across a clock change", async () => {
    const { token } = await user();
    const vienna = { timeZone: "Europe/Vienna" };
    // October has 745 hours in Vienna, March 743.
    for (const [start, end] of [
      ["2026-10-01", "2026-11-01"],
      ["2027-03-01", "2027-04-01"],
      ["2026-10-01T09:30:00+02:00", "2026-11-01T09:30:00+01:00"],
    ]) {
      // `listEvents` fails the test on a tool error.
      const answer = await listEvents(token, { start, end, ...vienna });
      expect(answer.timeZone).toBe("Europe/Vienna");
    }
    for (const [start, end] of [
      ["2026-10-01", "2026-11-02"],
      ["2027-03-01", "2027-04-02"],
      ["2026-10-01T09:30:00+02:00", "2026-11-01T09:31:00+01:00"],
    ]) {
      const body = await callRaw(token, { start, end, ...vienna });
      expect(body.result?.content?.[0]?.text).toMatch(/31 days/);
    }
  });

  it("reads today in the given zone without a window", async () => {
    const { token } = await user();
    const zone = "Pacific/Kiritimati"; // UTC+14, so its day differs from UTC's for most hours
    const day = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(ms);
    const answer = await listEvents(token, { timeZone: zone });
    expect(answer.timeZone).toBe(zone);
    expect(answer.start).toBe(`${day(Date.now())}T00:00:00+14:00`);
    expect(answer.end).toBe(`${day(Date.now() + DAY)}T00:00:00+14:00`);
  });

  it("takes the zone of the user's working hours when the call names none", async () => {
    const { token, userId } = await user();
    await account(userId, "wh-a");
    await env.DB.prepare("UPDATE accounts SET work_hours = ? WHERE id = 'wh-a'")
      .bind(JSON.stringify({ workTimeZone: "Europe/Vienna" }))
      .run();
    const answer = await listEvents(token, { start: START });
    expect(answer).toMatchObject({
      timeZone: "Europe/Vienna",
      start: "2027-01-15T00:00:00+01:00",
      end: "2027-01-16T00:00:00+01:00",
    });
  });
});

describe("events", () => {
  it("leaves out the blocks that slotmirror wrote, unless asked for", async () => {
    const { token, userId } = await user();
    const source = await account(userId, "mir-a", { calendar: "Work" });
    const target = await account(userId, "mir-b", { calendar: "Home" });
    await env.DB.prepare(
      `INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options)
       VALUES ('mir-rule', ?, 'mir-a-main', 'mir-b-main', '{"daysAhead": 30}')`,
    )
      .bind(userId)
      .run();
    const tomorrow = new Date(Math.floor(Date.now() / DAY) * DAY + DAY + 10 * 3_600_000);
    await source.addFakeEvent({
      id: "meeting",
      start: tomorrow.toISOString(),
      end: new Date(tomorrow.getTime() + 3_600_000).toISOString(),
      subject: "Planning",
    });
    const run = await target.runRule("mir-rule");
    expect(run.stats.create).toBe(1);

    const window = {
      start: new Date(tomorrow.getTime() - 3_600_000).toISOString(),
      end: new Date(tomorrow.getTime() + 2 * 3_600_000).toISOString(),
    };
    const plain = await listEvents(token, window);
    expect(plain.events.map((item) => [item.calendar, item.title, item.mirror])).toEqual([
      ["Work", "Planning", false],
    ]);
    const all = await listEvents(token, { ...window, includeMirrors: true });
    expect(all.events.map((item) => [item.calendar, item.mirror])).toEqual([
      ["Work", false],
      ["Home", true],
    ]);
  });

  it("merges the calendars of all accounts, sorted by start, with all-day events first", async () => {
    const { token, userId } = await user();
    const a = await account(userId, "mrg-a", { calendar: "Work" });
    const b = await account(userId, "mrg-b", { calendar: "Home" });
    await a.addFakeEvent(event("late", 14, { subject: "Review" }));
    await b.addFakeEvent(event("early", 8, { subject: "Gym" }));
    await b.addFakeEvent({
      id: "holiday",
      start: "2027-01-15",
      end: "2027-01-16",
      allDay: true,
      subject: "Holiday",
    });
    const answer = await listEvents(token, { start: START, end: END, timeZone: "Europe/Vienna" });
    expect(answer.events.map((item) => [item.title, item.start, item.end, item.allDay])).toEqual([
      ["Holiday", "2027-01-15", "2027-01-16", true],
      ["Gym", "2027-01-15T09:00:00+01:00", "2027-01-15T10:00:00+01:00", false],
      ["Review", "2027-01-15T15:00:00+01:00", "2027-01-15T16:00:00+01:00", false],
    ]);
    expect(answer.events[1]).toMatchObject({ accountId: "mrg-b", account: "mrg-b@example.com" });
    expect(answer.errors).toEqual([]);
  });

  it("shows title, location, status, series and decline, and never the body", async () => {
    const { token, userId } = await user();
    const stub = await account(userId, "wire-a");
    await wireEvent(stub, "standup", {
      ...timed(9),
      title: "Standup",
      location: "Room 4",
      description: "SECRET-BODY-TEXT dial-in 123",
      repeat: { every: "day", count: 2 },
    });
    await wireEvent(stub, "skip", {
      ...timed(12),
      title: "Lunch talk",
      response: "declined",
      availability: "tentative",
    });
    const response = await callRaw(token, { start: START, end: "2027-01-17", timeZone: "UTC" });
    expect(JSON.stringify(response)).not.toContain("SECRET-BODY-TEXT");
    const answer = response.result?.structuredContent as unknown as Answer | undefined;
    const events = answer?.events;
    expect(events).toEqual([
      expect.objectContaining({
        title: "Standup",
        location: "Room 4",
        start: "2027-01-15T09:00:00Z",
        recurring: true,
        declined: false,
        showAs: "busy",
      }),
      expect.objectContaining({ title: "Lunch talk", recurring: false, declined: true }),
      expect.objectContaining({ title: "Standup", start: "2027-01-16T09:00:00Z", recurring: true }),
    ]);
  });

  it("never shows a meeting link in a title or location", async () => {
    const { token, userId } = await user();
    const stub = await account(userId, "link-a");
    await wireEvent(stub, "a", {
      ...timed(9),
      title: "Sync us02web.zoom.us/j/987?pwd=SECRETPASS",
      location: "https://zoom.us/j/123?pwd=SECRETPASS",
    });
    await wireEvent(stub, "b", {
      ...timed(10),
      title: "Review",
      location: "Room 4 / teams.microsoft.com/l/meetup-join/19%3ameeting_SECRET",
    });
    await wireEvent(stub, "c", {
      ...timed(11),
      title: "meet.google.com/abc-defg-hij",
      location: "www.example.com/room?key=SECRET",
    });
    const answer = await listEvents(token, { start: START });
    expect(answer.events.map((item) => [item.title, item.location])).toEqual([
      ["Sync", null],
      ["Review", "Room 4"],
      [null, null],
    ]);
    expect(JSON.stringify(answer)).not.toMatch(
      /SECRET|zoom|teams\.microsoft|meet\.google|https?:/i,
    );
  });

  it("never shows a link of any host or scheme in a title or location", async () => {
    const { token, userId } = await user();
    const stub = await account(userId, "link-b");
    await wireEvent(stub, "a", {
      ...timed(9),
      title: "Weekly teams.cloud.microsoft/l/meetup-join/19%3aSECRET",
      location: "[Join](https://zoom.us/j/1?pwd=SECRET)",
    });
    await wireEvent(stub, "b", {
      ...timed(10),
      title: "Meetinghttps://example.com/x?token=SECRET",
      location: "Room 4.2, ｈｔｔｐｓ：／／ｚｏｏｍ．ｕｓ／ｊ／１２３?pwd=SECRET",
    });
    const answer = await listEvents(token, { start: START });
    expect(answer.events.map((item) => [item.title, item.location])).toEqual([
      ["Weekly", "Join"],
      ["Meeting", "Room 4.2"],
    ]);
    expect(JSON.stringify(answer)).not.toMatch(/SECRET|zoom|microsoft|https?:/i);
  });

  it("shows a private event only with its time, and a query cannot find its title", async () => {
    const { token, userId } = await user();
    const stub = await account(userId, "prv-a");
    await wireEvent(stub, "doctor", {
      ...timed(9),
      title: "Doctor",
      location: "Clinic",
      visibility: "private",
    });
    const answer = await listEvents(token, { start: START });
    expect(answer.events).toEqual([
      expect.objectContaining({ title: null, location: null, private: true }),
    ]);
    expect(JSON.stringify(answer)).not.toMatch(/Doctor|Clinic/);
    expect((await listEvents(token, { start: START, query: "doctor" })).events).toEqual([]);
  });

  it("holds an org account's events to the deployment's cap toward external accounts", async () => {
    const { token, userId } = await user();
    const org = await account(userId, "cap-org", { email: "me@org.example" });
    const own = await account(userId, "cap-own", { email: "me@example.com" });
    await wireEvent(org, "customer", { ...timed(9), title: "Customer call", location: "Office" });
    await wireEvent(own, "private", { ...timed(11), title: "Dentist", location: "Downtown" });
    // The test bindings cap toward external accounts at "title".
    const titled = await listEvents(token, { start: START });
    expect(titled.events.map((item) => [item.title, item.location])).toEqual([
      ["Customer call", null],
      ["Dentist", "Downtown"],
    ]);
    const busy = await listEvents(token, { start: START }, { MAX_DETAIL_TO_EXTERNAL: "busy" });
    expect(busy.events.map((item) => [item.title, item.location])).toEqual([
      [null, null],
      ["Dentist", "Downtown"],
    ]);
  });

  it("filters by account, calendar name and text", async () => {
    const { token, userId } = await user();
    const a = await account(userId, "flt-a", { calendar: "Work", email: "work@example.com" });
    const b = await account(userId, "flt-b", { calendar: "Family" });
    await a.addFakeEvent(event("one", 9, { subject: "Budget review" }));
    await b.addFakeEvent(event("two", 10, { subject: "School play" }));
    const titles = async (args: object) =>
      (await listEvents(token, { start: START, ...args })).events.map((item) => item.title);
    expect(await titles({ accounts: ["WORK@example.com"] })).toEqual(["Budget review"]);
    expect(await titles({ accounts: ["flt-b"] })).toEqual(["School play"]);
    expect(await titles({ calendars: ["family"] })).toEqual(["School play"]);
    expect(await titles({ query: "BUDGET" })).toEqual(["Budget review"]);
    expect(await titles({})).toEqual(["Budget review", "School play"]);
  });

  it("reads only calendars that the user turned on as sources", async () => {
    const { token, userId } = await user();
    const stub = await account(userId, "src-a", { source: false });
    await stub.addFakeEvent(event("hidden", 9, { subject: "Not chosen" }));
    expect((await listEvents(token, { start: START })).events).toEqual([]);
  });
});

describe("failures and limits", () => {
  it("lists a calendar that fails as an error and still answers with the others", async () => {
    const { token, userId } = await user();
    const good = await account(userId, "iso-a", { calendar: "Work" });
    const broken = await account(userId, "iso-b", { calendar: "Broken" });
    const slow = await account(userId, "iso-c", { calendar: "Slow" });
    const gone = await account(userId, "iso-d", { calendar: "Gone" });
    await account(userId, "iso-e", { calendar: "Stale" });
    await env.DB.prepare("UPDATE accounts SET needs_reconnect = 1 WHERE id = 'iso-e'").run();
    await good.addFakeEvent(event("ok", 9, { subject: "Still here" }));
    await broken.injectFakeFault({ kind: "reads_fail", error: "server" });
    await slow.injectFakeFault({ kind: "reads_fail", error: "throttled", retryAfterMs: 30_000 });
    await gone.injectFakeFault({ kind: "reads_fail", error: "gone" });

    const answer = await listEvents(token, { start: START });
    expect(answer.events.map((item) => item.title)).toEqual(["Still here"]);
    expect(answer.errors).toEqual([
      { accountId: "iso-b", calendar: "Broken", code: "failed" },
      { accountId: "iso-c", calendar: "Slow", code: "throttled", retryAfterSeconds: 30 },
      { accountId: "iso-d", calendar: "Gone", code: "gone" },
      { accountId: "iso-e", calendar: "Stale", code: "reconnect" },
    ]);
  });

  it("cuts the answer at its limit and says so", async () => {
    const { token, userId } = await user();
    const stub = await account(userId, "many-a");
    await stub.seedFake({ account: 1, accounts: 1, days: 2 }, MAX_EVENTS + 20);
    const answer = await listEvents(token, {
      start: new Date(Date.now()).toISOString(),
      end: new Date(Date.now() + 3 * DAY).toISOString(),
    });
    expect(answer.events.length).toBe(MAX_EVENTS);
    expect(answer.truncated).toBe(true);
    // The first events by start are the ones kept.
    const starts = answer.events.map((item) => Date.parse(item.start as string));
    expect(starts).toEqual([...starts].sort((x, y) => x - y));
  });

  it("does not report a short answer as cut", async () => {
    const { token, userId } = await user();
    await (await account(userId, "few-a")).addFakeEvent(event("one", 9));
    expect(await listEvents(token, { start: START })).toMatchObject({
      truncated: false,
      calendarsTruncated: false,
    });
  });

  it("reads a bounded number of calendars per call and says so", async () => {
    const { token, userId } = await user();
    await account(userId, "cal-a");
    await env.DB.batch(
      Array.from({ length: MAX_EVENT_CALENDARS }, (_, i) =>
        env.DB.prepare(
          `INSERT INTO calendars (id, account_id, remote_id, name, is_source)
           VALUES (?, 'cal-a', ?, ?, 1)`,
        ).bind(`cal-a-${i}`, `remote-${i}`, `Extra ${String(i).padStart(2, "0")}`),
      ),
    );
    const answer = await listEvents(token, { start: START });
    expect(answer.calendarsTruncated).toBe(true);
  });

  it("filters accounts and calendars before the calendar limit", async () => {
    const { token, userId } = await user();
    await account(userId, "cap-a");
    await env.DB.batch([
      env.DB.prepare("UPDATE accounts SET work_hours = ? WHERE id = 'cap-a'").bind(
        JSON.stringify({ workTimeZone: "Europe/Vienna" }),
      ),
      ...Array.from({ length: MAX_EVENT_CALENDARS }, (_, i) =>
        env.DB.prepare(
          `INSERT INTO calendars (id, account_id, remote_id, name, is_source)
           VALUES (?, 'cap-a', ?, ?, 1)`,
        ).bind(`cap-a-${i}`, `remote-${i}`, `Extra ${String(i).padStart(2, "0")}`),
      ),
    ]);
    // Sorts after the limit: a later account.
    const late = await account(userId, "cap-z", { calendar: "Späte Übung" });
    await late.addFakeEvent(event("late", 9, { subject: "After the limit" }));

    // Control: without a filter, the limit leaves the later account out.
    const all = await listEvents(token, { start: START });
    expect(all.calendarsTruncated).toBe(true);
    expect(all.events.map((item) => item.title)).not.toContain("After the limit");

    for (const filter of [
      { accounts: ["cap-z"] },
      { accounts: [" CAP-Z@example.com "] },
      { calendars: ["späte übung"] },
      // SQLite folds the case of ASCII letters only; the answer still matches this name.
      { calendars: ["SPÄTE ÜBUNG"] },
    ]) {
      const answer = await listEvents(token, { start: START, ...filter });
      expect(answer.events.map((item) => item.title)).toEqual(["After the limit"]);
      expect(answer.calendarsTruncated).toBe(false);
      // The zone of the first account's working hours applies, also when a filter leaves it out.
      expect(answer.timeZone).toBe("Europe/Vienna");
    }
    // More matching calendars than the limit still say so.
    const many = await listEvents(token, { start: START, accounts: ["cap-a"] });
    expect(many.calendarsTruncated).toBe(true);
    // A filter that names no calendar reads none.
    const none = await listEvents(token, { start: START, calendars: ["Extra_0%"] });
    expect(none).toMatchObject({ events: [], errors: [], calendarsTruncated: false });
  });
});

describe("withoutLinks", () => {
  // Every link must go: the host does not matter, nor whether a scheme or a word comes first.
  const removed: [string, string | null][] = [
    ["Sync teams.cloud.microsoft/l/meetup-join/19%3aSECRET", "Sync"],
    ["gov.teams.microsoft.us/l/meetup-join/SECRET", null],
    ["Call join.skype.com/SECRET", "Call"],
    ["meet.lync.com/org/user/SECRET", null],
    ["Demo bluejeans.com/123/SECRET", "Demo"],
    ["facetime.apple.com/join#v=1&p=SECRET", null],
    ["Board meetings.ringcentral.com/j/SECRET", "Board"],
    ["8x8.vc/company/SECRET", null],
    ["Party example.com/join?pwd=SECRET", "Party"],
    ["Host example.com:8443/SECRET", "Host"],
    ["Host 10.0.0.1:8443/join?SECRET", "Host"],
    ["Room 2 //example.com/x?pwd=SECRET", "Room 2"],
    ["Meetinghttps://example.com/x?token=SECRET", "Meeting"],
    ["Room_https://example.com/SECRET", "Room"],
    ["Sync ｈｔｔｐｓ://ｚｏｏｍ.ｕｓ/ｊ/１２３?pwd=SECRET", "Sync"],
    ["Files ftp://example.com/SECRET", "Files"],
    ["Ask mailto:SECRET@example.com", "Ask"],
    ["Dial tel:+43SECRET", "Dial"],
    ["Open zoommtg://zoom.us/join?confno=SECRET", "Open"],
    ["Teams msteams:/l/meetup-join/SECRET", "Teams"],
    ["Sync www.example.com", "Sync"],
    // What stood around a link goes with it.
    ["[Join](https://zoom.us/j/1?pwd=SECRET)", "Join"],
    ["Call <https://example.com/SECRET>", "Call"],
    ["(see https://example.com/SECRET)", "(see)"],
    ["Room 4, https://example.com/SECRET, floor 2", "Room 4, floor 2"],
    ["Room 4 / https://example.com/SECRET / floor 2", "Room 4 / floor 2"],
    ["Agenda: https://example.com/SECRET", "Agenda"],
    ["zoom.usx/j/SECRET", null],
    ["Sync meet.google.com.evil/SECRET", "Sync"],
    // A meeting service's host goes also without a path.
    ["Call on zoom.us", "Call on"],
  ];
  for (const [text, expected] of removed) {
    it(`removes the link from "${text}"`, () => {
      const cleaned = withoutLinks(text);
      expect(cleaned).toBe(expected);
      expect(cleaned ?? "").not.toMatch(/SECRET|\/\/|[[(<]$/);
    });
  }

  // Text that only looks like part of a link stays as it is.
  const kept = [
    "Room 4.2",
    "Release v1.5",
    "Dr. Smith",
    "St. Pölten",
    "Kick-off 10.30-11.00",
    "Re:Budget",
    "Q&A: wrap-up",
    "Lunch (Café Central)",
    // A plain host without a path can name a venue, and holds no meeting ID or passcode.
    "Party at example.com",
  ];
  for (const text of kept) {
    it(`keeps "${text}"`, () => {
      expect(withoutLinks(text)).toBe(text);
    });
  }

  it("keeps an empty text, and gives null for a text of links only", () => {
    expect(withoutLinks("")).toBe("");
    expect(withoutLinks("https://example.com/a, example.com/b")).toBeNull();
  });
});

describe("source cache", () => {
  type Cache = Map<string, { at: number }>;
  const cacheOf = (instance: unknown) => (instance as { sourceCache: Cache }).sourceCache;

  it("drops expired windows and keeps at most MAX_SOURCE_CACHE", async () => {
    const { userId } = await user();
    const stub = await account(userId, "cache-a");
    const base = Date.parse(at(0));
    const read = (i: number) =>
      stub.readSourceEvents(
        "main",
        { start: new Date(base + i * 60_000), end: new Date(base + DAY + i * 60_000) },
        false,
      );
    for (let i = 0; i < MAX_SOURCE_CACHE + 10; i++) await read(i);
    expect(await runInDurableObject(stub, (instance) => cacheOf(instance).size)).toBe(
      MAX_SOURCE_CACHE,
    );
    // After the cache time, one new read leaves only itself.
    vi.setSystemTime(Date.now() + 61_000);
    await read(1000);
    expect(await runInDurableObject(stub, (instance) => cacheOf(instance).size)).toBe(1);
  });
});

describe("schemas", () => {
  /** See test/mcp.test.ts: a `type` list is served as `anyOf`. */
  function portable(schema: unknown): unknown {
    if (Array.isArray(schema)) return schema.map(portable);
    if (typeof schema !== "object" || schema === null) return schema;
    const entries = Object.entries(schema).map(([key, value]) => [key, portable(value)] as const);
    const node: Record<string, unknown> = Object.fromEntries(entries);
    if (Array.isArray(node.type)) {
      const { type, ...rest } = node;
      return { ...rest, anyOf: (type as string[]).map((one) => ({ type: one })) };
    }
    return node;
  }

  function withoutDescriptions(schema: unknown): unknown {
    return JSON.parse(JSON.stringify(schema), (key, value: unknown) =>
      key === "description" ? undefined : value,
    );
  }

  it("publishes the answer shape and the argument shape of the code", async () => {
    const { token } = await user();
    const body = (await (await rpc(token, "tools/list")).json()) as RpcBody;
    const tool = body.result?.tools?.find((item) => item.name === "list_events");
    expect(tool?.outputSchema).toEqual(portable(zm.toJSONSchema(eventsAnswer, { io: "output" })));
    expect(withoutDescriptions(tool?.inputSchema)).toEqual(
      zm.toJSONSchema(listEventsInput, { io: "input" }),
    );
    expect(tool?.inputSchema).toEqual(LIST_EVENTS_INPUT_SCHEMA);
  });

  it("answers with content that the output schema admits, and nothing more", async () => {
    const { token, userId } = await user();
    const stub = await account(userId, "shape-a");
    await wireEvent(stub, "one", { ...timed(9), title: "Shape", location: "Here" });
    await account(userId, "shape-b");
    await env.DB.prepare("UPDATE accounts SET needs_reconnect = 1 WHERE id = 'shape-b'").run();
    const body = (await (await rpc(token, "tools/list")).json()) as RpcBody;
    const tool = body.result?.tools?.find((item) => item.name === "list_events");
    const schema = fromJSONSchema(tool?.outputSchema as z.core.JSONSchema.BaseSchema);
    const content = await listEvents(token, { start: START });
    expect(content.events.length).toBe(1);
    expect(content.errors.length).toBe(1);
    expect(schema.safeParse(content).error).toBeUndefined();
    // Control: the schema refuses a field outside it, in an event and in an error.
    const widened = { ...content, events: [{ ...content.events[0], body: "x" }] };
    expect(schema.safeParse(widened).success).toBe(false);
    const widenedError = { ...content, errors: [{ ...content.errors[0], remoteId: "r" }] };
    expect(schema.safeParse(widenedError).success).toBe(false);
  });
});
