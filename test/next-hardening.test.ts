/**
 * Findings of the code review of the redesign: a GET that only reads, a form that is read before
 * the action, cross-site and foreign-ID POSTs that change nothing, and the cost of a calendar save.
 */
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/app-env";
import { createApiToken, listApiTokens } from "../src/api-tokens";
import { DEFAULT_ORG_ID } from "../src/access";
import { loadEditorState, setDirection } from "../src/editor";
import { de } from "../src/i18n/de";
import { en } from "../src/i18n/en";
import worker from "../src/index";
import { saveCalendar } from "../src/next-calendars";
import type { Action } from "../src/permissions";
import { routePermissions } from "../src/route-permissions";
import { loadUser } from "../src/users";
import { BASE, countingEnv, signIn } from "./helpers";

/** A user with two accounts of two calendars each. `extra` adds more calendars to the first one. */
async function setup(prefix: string, extra = 0, language: "en" | "de" = "en") {
  const { user, cookie } = await signIn(`${prefix}@org.example`);
  const accounts = [
    [`${prefix}-z`, `${prefix}@zeta.example`, "microsoft", "2026-01-01T10:00:00.000Z"],
    [`${prefix}-a`, `${prefix}@alpha.example`, "google", "2026-01-01T11:00:00.000Z"],
  ] as const;
  for (const [id, email, provider, createdAt] of accounts) {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, provider, email, created_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(id, user.id, provider, email, createdAt),
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, ?, 'Main', 1, 1, 1)",
      ).bind(`${id}-cal`, id, `${id}-remote`),
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, ?, 'Side', 1, 0, 0)",
      ).bind(`${id}-side`, id, `${id}-side-remote`),
    ]);
    await env.ACCOUNT_SYNC.getByName(id).storeTokens(
      id,
      { refreshToken: "r", accessToken: "a", accessExpiresAt: Date.now() + 3_600_000 },
      provider,
    );
  }
  const z = `${prefix}-z`;
  for (let index = 0; index < extra; index++) {
    await env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, ?, ?, 1, 0, 0)",
    )
      .bind(`${z}-x${index}`, z, `${z}-x${index}-remote`, `Extra ${index}`)
      .run();
  }
  return { user, cookie, z, a: `${prefix}-a`, language };
}

/** Every stored value of a user that a hostile request could change. */
async function snapshot(userId: string) {
  const [accounts, calendars, rules, settings, audit] = await Promise.all([
    env.DB.prepare(
      "SELECT id, display_name, color, work_hours, source_options, in_block_group FROM accounts WHERE user_id = ? ORDER BY id",
    )
      .bind(userId)
      .all(),
    env.DB.prepare(
      "SELECT c.id, c.is_source FROM calendars c JOIN accounts a ON a.id = c.account_id WHERE a.user_id = ? ORDER BY c.id",
    )
      .bind(userId)
      .all(),
    env.DB.prepare("SELECT id, options, enabled, origin FROM rules WHERE user_id = ? ORDER BY id")
      .bind(userId)
      .all(),
    env.DB.prepare("SELECT sync_settings FROM users WHERE id = ?").bind(userId).all(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE user_id = ?").bind(userId).all(),
  ]);
  return {
    accounts: accounts.results,
    calendars: calendars.results,
    rules: rules.results,
    settings: settings.results,
    audit: audit.results,
  };
}

function get(path: string, cookie: string, language = "en") {
  return exports.default.fetch(`${BASE}${path}`, {
    headers: { cookie, "accept-language": language },
    redirect: "manual",
  });
}

/** A POST with the given headers and a body that is no form unless `body` says so. */
function rawPost(
  path: string,
  cookie: string,
  init: { headers?: HeadersInit; body?: string } = {},
) {
  return exports.default.fetch(`${BASE}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, ...init.headers },
    body: init.body,
  });
}

function formPost(
  path: string,
  cookie: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
) {
  return rawPost(path, cookie, {
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

const CROSS_SITE = { origin: "https://evil.example", "sec-fetch-site": "cross-site" };

let providerCalls: string[];

beforeEach(() => {
  providerCalls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    providerCalls.push(url);
    if (url.includes("calendarView")) return Response.json({ value: [] });
    if (url.includes("googleapis.com/calendar")) return Response.json({ items: [] });
    return new Response("unexpected", { status: 500 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a GET of a /next page only reads", () => {
  /** The same request through a counted env, so that D1 statements and Durable Object calls show. */
  async function countedGet(path: string, cookie: string, language = "en") {
    const counted = countingEnv();
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${BASE}${path}`, {
        headers: { cookie, "accept-language": language },
        redirect: "manual",
      }),
      counted.env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return { response, counts: counted.counts };
  }

  const PATHS = (c: string) => ["/", "/mirroring", "/calendars", `/calendars?c=${c}`, "/activity"];

  it("leaves users.sync_settings unchanged and calls no provider", async () => {
    const { user, cookie, z } = await setup("hard-get");
    // The first load stores the colours of the accounts; the GETs below must add nothing to it.
    await loadEditorState(env, user.id);
    const before = await snapshot(user.id);
    for (const path of PATHS(z)) {
      const { response } = await countedGet(path, cookie, "de");
      expect(response.status, path).toBe(200);
    }
    expect(await snapshot(user.id)).toEqual(before);
    expect(providerCalls).toEqual([]);
  });

  it("makes no provider or Durable Object call for a user whose accounts have no calendars", async () => {
    const { user, cookie } = await signIn("hard-nocal@org.example");
    await env.DB.prepare(
      "INSERT INTO accounts (id, user_id, provider, email) VALUES ('hard-nocal-1', ?, 'microsoft', 'hard-nocal@work.example')",
    )
      .bind(user.id)
      .run();
    await loadEditorState(env, user.id);
    const before = await snapshot(user.id);
    for (const path of PATHS("hard-nocal-1")) {
      const { response, counts } = await countedGet(path, cookie);
      expect(response.status, path).toBe(200);
      expect(counts.durable, path).toEqual([]);
    }
    expect(providerCalls).toEqual([]);
    expect(await snapshot(user.id)).toEqual(before);
  });

  it("stays within a D1 budget per page: the session lookup and one batch", async () => {
    const { user, cookie, z } = await setup("hard-budget", 20);
    // The first load stores the account colours; count the loads that follow.
    await loadEditorState(env, user.id);
    // `calls`: D1 round trips. `statements`: statements inside batches, which also bounds the rows
    // a page reads: the overview reads the state (4), the outcomes (1) and two lists (2).
    const budget: Record<string, { calls: number; statements: number }> = {
      "/": { calls: 2, statements: 7 },
      "/mirroring": { calls: 2, statements: 5 },
      "/calendars": { calls: 2, statements: 5 },
      [`/calendars?c=${z}`]: { calls: 2, statements: 5 },
      // The filter of the log needs the state first, so the page reads in two steps. The first step
      // reads the state (4) and the outcomes (1) for the nav dot.
      "/activity": { calls: 3, statements: 5 },
    };
    for (const path of PATHS(z)) {
      const { counts } = await countedGet(path, cookie);
      expect(counts.d1, `${path} D1 calls`).toBeLessThanOrEqual(budget[path]?.calls ?? 0);
      expect(counts.batchStatements, `${path} statements`).toBeLessThanOrEqual(
        budget[path]?.statements ?? 0,
      );
      expect(counts.durable, path).toEqual([]);
    }
  });

  it("still shows the block title of the user's language before a first rule", async () => {
    const { cookie } = await setup("hard-title");
    const html = await (await get("/mirroring?d=all", cookie, "de")).text();
    expect(html).toMatch(
      new RegExp(`name="blockTitle"[^>]*value="${de.editor.defaultBlockTitle}"`),
    );
    const english = await (await get("/mirroring?d=all", cookie, "en")).text();
    expect(english).toMatch(
      new RegExp(`name="blockTitle"[^>]*value="${en.editor.defaultBlockTitle}"`),
    );
  });

  it("stores the block title of the user's language with the first rule", async () => {
    const { user, cookie, z, a } = await setup("hard-first");
    const response = await formPost(
      "/mirroring",
      cookie,
      { scope: "direction", from: a, to: z, copy: "busy", back: "/mirroring" },
      { "accept-language": "de" },
    );
    expect(response.status).toBe(303);
    const row = await env.DB.prepare("SELECT sync_settings AS json FROM users WHERE id = ?")
      .bind(user.id)
      .first<{ json: string }>();
    expect(JSON.parse(row?.json ?? "{}").blockTitle).toBe(de.editor.defaultBlockTitle);
  });
});

describe("a POST without a form body", () => {
  const ADMIN = "admin@example.com";

  it("does nothing and answers 400 on the calendar and mirroring routes", async () => {
    const { user, cookie, z } = await setup("hard-empty");
    const before = await snapshot(user.id);
    for (const path of ["/mirroring", "/calendars/refresh", `/calendars/${z}`]) {
      const none = await rawPost(path, cookie);
      expect(none.status, `${path} without body`).toBe(400);
      const wrongType = await rawPost(path, cookie, {
        headers: { "content-type": "text/plain" },
        body: "name=x",
      });
      expect(wrongType.status, `${path} with text/plain`).toBe(400);
    }
    expect(await snapshot(user.id)).toEqual(before);
    // "Check again" did not reach a provider.
    expect(providerCalls).toEqual([]);
  });

  it("does nothing and answers 400 on the token routes", async () => {
    const { user, cookie } = await signIn("hard-empty-tokens@org.example");
    await createApiToken(env, user, { name: "laptop", days: 7 });
    const [row] = await listApiTokens(env.DB, user.id);
    for (const path of [
      "/tokens",
      `/tokens/${row?.id}/revoke`,
      `/tokens/apps/${crypto.randomUUID()}/revoke`,
    ]) {
      expect((await rawPost(path, cookie)).status, path).toBe(400);
    }
    expect(await listApiTokens(env.DB, user.id)).toHaveLength(1);
  });

  it("does nothing and answers 400 on the admin routes", async () => {
    const { cookie } = await signIn(ADMIN);
    const victim = await signIn("hard-empty-victim@org.example");
    await createApiToken(env, victim.user, { name: "laptop", days: 7 });
    for (const action of ["delete", "reset-sign-in", "revoke-tokens"]) {
      const response = await rawPost(`/admin/users/${victim.user.id}/${action}`, cookie);
      expect(response.status, action).toBe(400);
    }
    expect((await rawPost("/admin/mcp-policy", cookie)).status).toBe(400);
    expect(await loadUser(env, victim.user.id, victim.user.sessionVersion)).not.toBeNull();
    expect(await listApiTokens(env.DB, victim.user.id)).toHaveLength(1);
    const org = await env.DB.prepare("SELECT mcp_for_members AS value FROM orgs WHERE id = ?")
      .bind(DEFAULT_ORG_ID)
      .first<{ value: string }>();
    expect(org?.value).toBe("all");
  });
});

describe("a cross-site POST", () => {
  it("is refused on the mirroring and calendar routes and changes nothing", async () => {
    const { user, cookie, z, a } = await setup("hard-xsite");
    await setDirection(env, user, a, z, "busy");
    const before = await snapshot(user.id);
    const posts: [string, Record<string, string>][] = [
      ["/mirroring", { scope: "direction", from: a, to: z, copy: "full", who: "open" }],
      [`/calendars/${z}`, { name: "Hijacked", color: "green", workHoursShown: "1" }],
      ["/calendars/refresh", { back: "/calendars" }],
    ];
    for (const [path, fields] of posts) {
      const response = await formPost(path, cookie, fields, CROSS_SITE);
      expect(response.status, path).toBe(403);
      expect(response.headers.get("location"), path).toBeNull();
    }
    expect(await snapshot(user.id)).toEqual(before);
    expect(providerCalls).toEqual([]);
  });
});

describe("a save with the real IDs of another user", () => {
  it("changes nothing for the owner, in the mirroring and in the calendar route", async () => {
    const owner = await setup("hard-own");
    await setDirection(env, owner.user, owner.a, owner.z, "busy");
    const stranger = await signIn("hard-stranger@org.example");
    const before = await snapshot(owner.user.id);
    const strangerBefore = await snapshot(stranger.user.id);

    const mirroring = await formPost("/mirroring", stranger.cookie, {
      scope: "direction",
      from: owner.a,
      to: owner.z,
      copy: "full",
      who: "open",
      onlyCategories: "Work",
      back: "/mirroring",
    });
    expect(mirroring.status).toBe(400);
    expect(mirroring.headers.get("location")).toBeNull();

    const all = await formPost("/mirroring", stranger.cookie, {
      scope: "all",
      daysAhead: "7",
      blockTitle: "Hijacked",
      markPrivate: "on",
    });
    expect([303, 400]).toContain(all.status);

    const calendar = await formPost(`/calendars/${owner.z}`, stranger.cookie, {
      name: "Stolen",
      color: "green",
      workHoursShown: "1",
      workHoursOn: "1",
      workStart: "08:00",
      workEnd: "18:00",
      workTimeZone: "Europe/Vienna",
      bufferShown: "1",
      bufferBefore: "10",
      bufferAfter: "10",
      sourceShown: `${owner.z}-cal`,
    });
    expect(calendar.status).toBe(404);

    expect(await snapshot(owner.user.id)).toEqual(before);
    // The stranger's own data holds no trace of it either, apart from the title default.
    const after = await snapshot(stranger.user.id);
    expect(after.rules).toEqual(strangerBefore.rules);
    expect(after.accounts).toEqual(strangerBefore.accounts);
  });
});

describe("the calendar save needs the actions of both kinds of writes", () => {
  /** A probe app with the permission gate, a user, and an `allows` that denies some actions. */
  async function probe(denied: Action[]) {
    const { user } = await signIn("hard-perm@org.example");
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("user", await loadUser(c.env, user.id, user.sessionVersion));
      await next();
    });
    app.use(
      "*",
      routePermissions(
        () => new Response("refused", { status: 403 }),
        (_user, action) => !denied.includes(action),
      ),
    );
    let ran = 0;
    app.post("/calendars/:id", (c) => {
      ran++;
      return c.text("saved");
    });
    return { app, ran: () => ran };
  }

  it("runs the handler only with accounts:write and rules:write", async () => {
    const both = await probe([]);
    expect((await both.app.request("/calendars/x", { method: "POST" }, env)).status).toBe(200);
    expect(both.ran()).toBe(1);
  });

  it("refuses a role that has one action but not the other", async () => {
    for (const denied of [["rules:write"], ["accounts:write"]] as Action[][]) {
      const gate = await probe(denied);
      const response = await gate.app.request("/calendars/x", { method: "POST" }, env);
      expect(response.status, denied.join()).toBe(404);
      expect(gate.ran(), denied.join()).toBe(0);
    }
  });
});

describe("the cost of a calendar save", () => {
  function panel(z: string, fields: Record<string, string>) {
    const form = new FormData();
    form.set("workHoursShown", "1");
    form.set("workHoursHad", "0");
    form.set("sourceShown", `${z}-cal`);
    form.set("source", `${z}-cal`);
    form.append("sourceShown", `${z}-side`);
    for (let index = 0; index < 20; index++) form.append("sourceShown", `${z}-x${index}`);
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    return form;
  }

  it("reads the state once and writes nothing if nothing changed", async () => {
    const { user, z } = await setup("hard-cost-same", 20);
    // The first load stores the account colours; the panel as drawn carries the stored values.
    await loadEditorState(env, user.id);
    const before = await snapshot(user.id);
    const counted = countingEnv();
    const form = panel(z, { name: "", color: "auto" });
    expect(await saveCalendar(counted.env, user, en, z, form)).toEqual({ ok: true });
    // One batch reads the editor state, and that is all. Before: 26 calls for 22 calendars.
    expect(counted.counts.d1).toBe(1);
    expect(counted.counts.batchStatements).toBe(4);
    expect(counted.counts.durable).toEqual([]);
    expect(await snapshot(user.id)).toEqual(before);
  });

  it("writes only the name if only the name changed", async () => {
    const { user, z } = await setup("hard-cost-name", 20);
    await loadEditorState(env, user.id);
    const counted = countingEnv();
    expect(
      await saveCalendar(counted.env, user, en, z, panel(z, { name: "Work", color: "auto" })),
    ).toEqual({ ok: true });
    // State read, the rename read, the rename write and its audit event. Before: 28.
    expect(counted.counts.d1).toBeLessThanOrEqual(4);
    expect(counted.counts.durable).toEqual([]);
    const row = await env.DB.prepare("SELECT display_name FROM accounts WHERE id = ?")
      .bind(z)
      .first<{ display_name: string }>();
    expect(row?.display_name).toBe("Work");
  });

  it("writes one calendar if one of 22 calendars was switched on", async () => {
    const { user, z } = await setup("hard-cost-one", 20);
    await loadEditorState(env, user.id);
    const counted = countingEnv();
    const form = panel(z, { name: "", color: "auto" });
    form.append("source", `${z}-x3`);
    expect(await saveCalendar(counted.env, user, en, z, form)).toEqual({ ok: true });
    // State read, the default title, the switch, the check for rules to add and the state read
    // for it: not one call per calendar of the account. Before: 28.
    expect(counted.counts.d1).toBeLessThanOrEqual(6);
    const stored = await env.DB.prepare("SELECT is_source FROM calendars WHERE id = ?")
      .bind(`${z}-x3`)
      .first<{ is_source: number }>();
    expect(stored?.is_source).toBe(1);
  });

  it("asks each account once for the sync, after its last write", async () => {
    const { user, z, a } = await setup("hard-cost-sync", 2);
    await setDirection(env, user, a, z, "busy");
    await loadEditorState(env, user.id);
    const counted = countingEnv();
    const form = panel(z, { name: "", color: "auto", bufferShown: "1" });
    form.set("bufferBefore", "5");
    form.set("bufferAfter", "5");
    form.delete("source");
    form.append("source", `${z}-cal`);
    form.append("source", `${z}-side`);
    form.append("source", `${z}-x0`);
    form.append("source", `${z}-x1`);
    expect(await saveCalendar(counted.env, user, en, z, form)).toEqual({ ok: true });
    const syncs = counted.counts.durable.filter((call) => call.endsWith(":requestSync"));
    expect(new Set(syncs).size).toBe(syncs.length);
  });
});
