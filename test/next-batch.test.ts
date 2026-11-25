/**
 * One D1 batch per /next page load, the localized block title, the working-hours batch, the timing
 * and cache headers, and the way back of the quick actions that the pages post to the old routes.
 */
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  latestRuleOutcomes,
  recentChanges,
  recentChangesQuery,
  recordAudit,
  ruleOutcomesQuery,
} from "../src/audit";
import { runQueries, single } from "../src/batch";
import { ownCleanups, ownCleanupsQuery } from "../src/cleanup";
import {
  loadEditorState,
  setDefaultBlockTitle,
  setDirection,
  withLocalizedTitle,
} from "../src/editor";
import { de } from "../src/i18n/de";
import { en } from "../src/i18n/en";
import worker from "../src/index";
import { saveCalendar } from "../src/next-calendars";
import { refererBack } from "../src/routes/rules";
import { BASE, countingEnv, signIn } from "./helpers";

async function setup(prefix: string) {
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
    ]);
    await env.ACCOUNT_SYNC.getByName(id).storeTokens(
      id,
      { refreshToken: "r", accessToken: "a", accessExpiresAt: Date.now() + 3_600_000 },
      provider,
    );
  }
  return { user, cookie, z: `${prefix}-z`, a: `${prefix}-a` };
}

function get(path: string, cookie: string, language = "en", headers: HeadersInit = {}) {
  return exports.default.fetch(`${BASE}${path}`, {
    headers: { cookie, "accept-language": language, ...headers },
    redirect: "manual",
  });
}

function formPost(
  path: string,
  cookie: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
) {
  return exports.default.fetch(`${BASE}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

async function storedSettings(userId: string): Promise<{ blockTitle?: string }> {
  const row = await env.DB.prepare("SELECT sync_settings AS json FROM users WHERE id = ?")
    .bind(userId)
    .first<{ json: string }>();
  return JSON.parse(row?.json ?? "{}") as { blockTitle?: string };
}

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("calendarView")) return Response.json({ value: [] });
    if (url.includes("googleapis.com/calendar")) return Response.json({ items: [] });
    return new Response("unexpected", { status: 500 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runQueries", () => {
  it("runs the statements of all queries in one batch and hands each its own results", async () => {
    const counted = countingEnv();
    const db = counted.env.DB;
    const [two, none, one] = await runQueries(db, [
      {
        statements: [db.prepare("SELECT 1 AS n"), db.prepare("SELECT 2 AS n")],
        parse: (results) => results.map((result) => (result.results[0] as { n: number }).n),
      },
      { statements: [], parse: (results) => results.length },
      single(db.prepare("SELECT 3 AS n"), (result) => (result.results[0] as { n: number }).n),
    ] as const);
    expect(two).toEqual([1, 2]);
    expect(none).toBe(0);
    expect(one).toBe(3);
    expect(counted.counts.d1).toBe(1);
    expect(counted.counts.batchStatements).toBe(3);
  });
});

describe("queries of a batch read what the functions read", () => {
  it("gives the same outcomes, changes and cleanups as the separate reads", async () => {
    const { user, a, z } = await setup("nb-equal");
    await setDirection(env, user, a, z, "busy");
    const rule = await env.DB.prepare("SELECT id FROM rules WHERE user_id = ?")
      .bind(user.id)
      .first<{ id: string }>();
    for (const [kind, detail] of [
      ["sync_run", { create: 2, update: 0, delete: 0, failed: 0 }],
      ["sync_failed", { code: "boom" }],
      ["sync_run", { create: 0, update: 1, delete: 0, failed: 0 }],
    ] as const) {
      await recordAudit(env.DB, {
        orgId: user.orgId,
        userId: user.id,
        accountId: z,
        ruleId: rule?.id,
        kind,
        detail,
      });
    }
    const now = Date.now() + 1000;
    const [outcomes, changes, cleanups] = await runQueries(env.DB, [
      ruleOutcomesQuery(env.DB, user.id),
      recentChangesQuery(env.DB, user.id, now),
      ownCleanupsQuery(env.DB, user.id),
    ] as const);
    const separate = await latestRuleOutcomes(env.DB, user.id);
    expect(separate.length).toBeGreaterThan(0);
    expect(outcomes).toEqual(separate);
    const oldChanges = await recentChanges(env.DB, user.id, now);
    expect(oldChanges.rows.length).toBeGreaterThan(0);
    expect(changes).toEqual(oldChanges);
    expect(cleanups).toEqual(await ownCleanups(env.DB, user.id));
  });
});

describe("the editor state", () => {
  it("carries the time an account was connected", async () => {
    const { user, z, a } = await setup("nb-created");
    const state = await loadEditorState(env, user.id);
    expect(state.accounts.map((account) => [account.id, account.createdAt])).toEqual([
      [z, "2026-01-01T10:00:00.000Z"],
      [a, "2026-01-01T11:00:00.000Z"],
    ]);
  });

  it("tells a stored block title from the default, also a stored 'Busy'", async () => {
    const { user, cookie } = await setup("nb-stored");
    expect((await loadEditorState(env, user.id)).settings.blockTitleStored).toBe(false);
    // The user saves "Busy" on purpose, in a language whose default is another word.
    expect(de.editor.defaultBlockTitle).not.toBe("Busy");
    const saved = await formPost(
      "/mirroring",
      cookie,
      { scope: "all", blockTitle: "Busy", back: "/mirroring?d=all" },
      { "accept-language": "de" },
    );
    expect(saved.status).toBe(303);
    const state = await loadEditorState(env, user.id);
    expect(state.settings.blockTitleStored).toBe(true);
    expect(state.rules).toHaveLength(0);
    // No rules, a stored title: the page shows it, not the default of the language.
    const html = await (await get("/mirroring?d=all", cookie, "de")).text();
    expect(html).toMatch(/name="blockTitle"[^>]*value="Busy"/);
    expect(withLocalizedTitle(state, de.editor.defaultBlockTitle).settings.blockTitle).toBe("Busy");
  });

  it("shows the default of the language while nothing is stored", async () => {
    const { user, cookie } = await setup("nb-default");
    const html = await (await get("/mirroring?d=all", cookie, "de")).text();
    expect(html).toMatch(
      new RegExp(`name="blockTitle"[^>]*value="${de.editor.defaultBlockTitle}"`),
    );
    expect((await storedSettings(user.id)).blockTitle).toBeUndefined();
  });
});

describe("the block title of a first rule", () => {
  it("never replaces a stored title and is idempotent", async () => {
    const { user } = await setup("nb-title-keep");
    await env.DB.prepare(
      "UPDATE users SET sync_settings = json_set(sync_settings, '$.blockTitle', 'Busy') WHERE id = ?",
    )
      .bind(user.id)
      .run();
    await setDefaultBlockTitle(env, user.id, "Beschäftigt");
    expect((await storedSettings(user.id)).blockTitle).toBe("Busy");
  });

  it("is stored once, by the first write that creates a rule, and then left alone", async () => {
    const { user, cookie, a } = await setup("nb-title-once");
    const first = await formPost(
      `/rules/group/${a}`,
      cookie,
      { inGroup: "1" },
      { "accept-language": "de" },
    );
    expect(first.status).toBe(302);
    expect((await storedSettings(user.id)).blockTitle).toBe(de.editor.defaultBlockTitle);
    // A later write in another language changes nothing.
    await formPost(`/rules/group/${a}`, cookie, { inGroup: "0" }, { "accept-language": "en" });
    expect((await storedSettings(user.id)).blockTitle).toBe(de.editor.defaultBlockTitle);
  });

  it.each([
    ["/rules/group/all", () => ({}) as Record<string, string>],
    [
      "/rules/direction",
      (ids: { a: string; z: string }) => ({ from: ids.a, to: ids.z, choice: "busy" }),
    ],
    [
      "/rules/choices",
      (ids: { a: string; z: string }) => ({ [`choice.${ids.a}.${ids.z}`]: "busy" }),
    ],
  ])("is stored before the first rule of %s", async (path, fields) => {
    const prefix = `nb-title-${path.replaceAll("/", "-")}`;
    const ids = await setup(prefix);
    const response = await formPost(path, ids.cookie, fields(ids), { "accept-language": "de" });
    expect(response.status).toBeLessThan(400);
    const rules = await env.DB.prepare("SELECT options FROM rules WHERE user_id = ?")
      .bind(ids.user.id)
      .all<{ options: string }>();
    expect(rules.results.length).toBeGreaterThan(0);
    expect((await storedSettings(ids.user.id)).blockTitle).toBe(de.editor.defaultBlockTitle);
    for (const row of rules.results) {
      expect((JSON.parse(row.options) as { blockTitle: string }).blockTitle).toBe(
        de.editor.defaultBlockTitle,
      );
    }
  });

  it("does not overwrite an explicit title on a first rule", async () => {
    const { user, cookie } = await setup("nb-title-explicit");
    await formPost(
      "/mirroring",
      cookie,
      { scope: "all", blockTitle: "Busy", back: "/mirroring" },
      { "accept-language": "de" },
    );
    await formPost("/rules/group/all", cookie, {}, { "accept-language": "de" });
    expect((await storedSettings(user.id)).blockTitle).toBe("Busy");
    const rules = await env.DB.prepare("SELECT options FROM rules WHERE user_id = ?")
      .bind(user.id)
      .all<{ options: string }>();
    expect(rules.results.length).toBeGreaterThan(0);
    for (const row of rules.results) {
      expect((JSON.parse(row.options) as { blockTitle: string }).blockTitle).toBe("Busy");
    }
  });
});

describe("a calendar save with working hours is one batch", () => {
  const OFFICE = {
    name: "",
    color: "auto",
    workHoursShown: "1",
    workHoursHad: "0",
    workHoursOn: "1",
    workStart: "08:00",
    workEnd: "18:00",
    workTimeZone: "Europe/Vienna",
  };
  const panel = () => {
    const form = new URLSearchParams(OFFICE);
    for (const day of ["1", "2", "3", "4", "5"]) form.append("workDays", day);
    const data = new FormData();
    for (const [key, value] of form) data.append(key, value);
    return data;
  };
  const stored = async (userId: string, accountId: string) => {
    const account = await env.DB.prepare("SELECT work_hours AS hours FROM accounts WHERE id = ?")
      .bind(accountId)
      .first<{ hours: string | null }>();
    const rules = await env.DB.prepare("SELECT options FROM rules WHERE user_id = ?")
      .bind(userId)
      .all<{ options: string }>();
    return {
      account: account?.hours ?? null,
      rules: rules.results.map(
        (row) => (JSON.parse(row.options) as { workStart: string }).workStart,
      ),
    };
  };

  it("leaves nothing half applied after a failure, and the retry completes", async () => {
    const { user, z, a } = await setup("nb-hours");
    await setDirection(env, user, a, z, "busy");
    await loadEditorState(env, user.id);
    const before = await stored(user.id, z);
    expect(before).toEqual({ account: null, rules: [""] });

    // D1 fails when the batch with the account's hours arrives: after the read, before any write.
    const failing = countingEnv(async (sql) => {
      if (sql.some((statement) => statement.includes("UPDATE accounts SET work_hours"))) {
        throw new Error("D1 failed");
      }
    });
    await expect(saveCalendar(failing.env, user, en, z, panel())).rejects.toThrow("D1 failed");
    expect(await stored(user.id, z)).toEqual(before);

    const syncs = countingEnv();
    expect(await saveCalendar(syncs.env, user, en, z, panel())).toEqual({ ok: true });
    const after = await stored(user.id, z);
    expect(after.account).not.toBeNull();
    expect(after.rules).toEqual(["08:00"]);
    // One request to sync the target, not one per step.
    const requests = syncs.counts.durable.filter((call) => call.endsWith(":requestSync"));
    expect(requests).toEqual([`${z}:requestSync`]);
  });

  it("refuses the whole batch if a rule changed since the read", async () => {
    const { user, z, a } = await setup("nb-hours-conflict");
    await setDirection(env, user, a, z, "busy");
    await loadEditorState(env, user.id);
    const racing = countingEnv(async (sql) => {
      if (sql.some((statement) => statement.includes("UPDATE accounts SET work_hours"))) {
        await env.DB.prepare(
          "UPDATE rules SET options = json_set(options, '$.daysAhead', 7)",
        ).run();
      }
    });
    expect(await saveCalendar(racing.env, user, en, z, panel())).toEqual({
      ok: false,
      error: en.next.calendars.conflict,
    });
    expect(await stored(user.id, z)).toEqual({ account: null, rules: [""] });
  });
});

describe("headers of /next pages", () => {
  it("sends Server-Timing with durations only, and private no-cache", async () => {
    const { cookie, z } = await setup("nb-headers");
    for (const path of ["/", "/mirroring", "/calendars", `/calendars?c=${z}`]) {
      const response = await get(path, cookie);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("server-timing"), path).toMatch(/^d1;dur=\d+, total;dur=\d+$/);
      expect(response.headers.get("cache-control"), path).toBe("private, no-cache");
    }
  });

  it("sends no Server-Timing on a redirect, and keeps no-store on token pages", async () => {
    const { cookie } = await setup("nb-headers-2");
    const redirect = await formPost(
      "/calendars/refresh",
      cookie,
      { back: "/calendars" },
      { "accept-language": "en" },
    );
    expect(redirect.status).toBe(303);
    expect(redirect.headers.get("server-timing")).toBeNull();
    const tokens = await get("/tokens", cookie);
    if (tokens.status === 200) expect(tokens.headers.get("cache-control")).toBe("no-store");
  });

  it("sends private no-cache on the public pages too, unless the route sets its own", async () => {
    const response = await exports.default.fetch(`${BASE}/`, { redirect: "manual" });
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
  });
});

describe("the way back of a quick action", () => {
  it("returns to the app page that sent it when `back` is missing", async () => {
    const { cookie } = await setup("nb-back");
    const response = await formPost(
      "/rules/group/all",
      cookie,
      {},
      { referer: `${BASE}/mirroring?d=all` },
    );
    expect(response.headers.get("location")).toBe("/mirroring?d=all");
  });

  it("prefers a valid `back` and never leaves the site", async () => {
    const { cookie } = await setup("nb-back-2");
    const withBack = await formPost(
      "/rules/group/all",
      cookie,
      { back: "/calendars" },
      { referer: `${BASE}/mirroring` },
    );
    expect(withBack.headers.get("location")).toBe("/calendars");
    for (const referer of [
      "https://evil.example/mirroring",
      `${BASE}/rules`,
      `${BASE}/next/mirroring`,
      `${BASE}//evil.example`,
      "not a url",
    ]) {
      const response = await formPost("/rules/group/all", cookie, {}, { referer });
      expect(response.headers.get("location"), referer).toBe("/mirroring");
    }
  });

  it("reads the Referer of the request's own origin only", () => {
    const request = (referer: string) =>
      new Request(`${BASE}/rules/group/all`, { method: "POST", headers: { referer } });
    expect(refererBack(request(`${BASE}/`), "/rules")).toBe("/");
    expect(refererBack(request("https://evil.example/"), "/rules")).toBe("/rules");
    expect(refererBack(new Request(`${BASE}/x`, { method: "POST" }), "/rules")).toBe("/rules");
  });
});

// A GET reads through the counted env: the same request as `countedGet` of the hardening tests.
describe("the page batch", () => {
  it("writes the colours of new accounts outside the batch, once", async () => {
    const { cookie, user } = await setup("nb-colors");
    const run = async () => {
      const counted = countingEnv();
      const ctx = createExecutionContext();
      const response = await worker.fetch(
        new Request(`${BASE}/`, { headers: { cookie } }),
        counted.env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return { response, counts: counted.counts };
    };
    const first = await run();
    expect(first.response.status).toBe(200);
    // Session, the page batch and the colour batch.
    expect(first.counts.d1).toBe(3);
    const second = await run();
    expect(second.counts.d1).toBe(2);
    const colors = await env.DB.prepare("SELECT color FROM accounts WHERE user_id = ?")
      .bind(user.id)
      .all<{ color: string | null }>();
    expect(colors.results.every((row) => row.color !== null)).toBe(true);
  });
});
