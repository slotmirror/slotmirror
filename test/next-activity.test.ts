import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { activityPageQuery, type AuditKind } from "../src/audit";
import type { EditorState } from "../src/editor";
import { i18nFor } from "../src/i18n";
import { activityFilter, parseActivityQuery } from "../src/next-activity";
import { groupActivity } from "../src/pages/next/activity";
import { BASE, signIn } from "./helpers";

async function get(path: string, cookie: string, language = "en") {
  return exports.default.fetch(`${BASE}${path}`, {
    headers: { cookie, "accept-language": language },
    redirect: "manual",
  });
}

/**
 * A user with three calendars named "alpha", "beta" and "gamma" (the names come from the
 * addresses) and the mirrorings alpha to beta, alpha to gamma and gamma to beta.
 */
async function setup(prefix: string, email = `${prefix}@org.example`) {
  const { user, cookie } = await signIn(email);
  const ids = { a: `${prefix}-a`, b: `${prefix}-b`, c: `${prefix}-c` };
  const rows = [
    [ids.a, `${prefix}@alpha.example`, "microsoft"],
    [ids.b, `${prefix}@beta.example`, "google"],
    [ids.c, `${prefix}@gamma.example`, "microsoft"],
  ] as const;
  for (const [id, address, provider] of rows) {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, ?, ?)",
      ).bind(id, user.id, provider, address),
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, ?, 'Main', 1, 1, 1)",
      ).bind(`${id}-cal`, id, `${id}-remote`),
    ]);
  }
  const rules = { ab: `${prefix}-r-ab`, ac: `${prefix}-r-ac`, cb: `${prefix}-r-cb` };
  for (const [rule, from, to] of [
    [rules.ab, ids.a, ids.b],
    [rules.ac, ids.a, ids.c],
    [rules.cb, ids.c, ids.b],
  ] as const) {
    await env.DB.prepare(
      "INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(rule, user.id, `${from}-cal`, `${to}-cal`, JSON.stringify({ detailLevel: "busy" }))
      .run();
  }
  return { user, cookie, ids, rules };
}

let clock = Date.parse("2026-11-10T08:00:00.000Z");

/** Writes one audit row. Each row is a minute after the one before, so the order is known. */
async function log(
  userId: string,
  kind: AuditKind,
  detail: object,
  options: { rule?: string; account?: string; at?: string } = {},
) {
  clock += 60_000;
  await env.DB.prepare(
    `INSERT INTO audit_events (org_id, user_id, account_id, rule_id, kind, detail, created_at)
     VALUES ('default', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      userId,
      options.account ?? null,
      options.rule ?? null,
      kind,
      JSON.stringify(detail),
      options.at ?? new Date(clock).toISOString(),
    )
    .run();
}

const RUN = { dryRun: false, create: 2, update: 0, delete: 0, failed: 0, durationMs: 40 };
const QUIET = { dryRun: false, create: 0, update: 0, delete: 0, failed: 0, durationMs: 9 };

/** The titles of the rows on a page, in order. */
function titles(html: string): string[] {
  return [...html.matchAll(/<span class="row-title act-title">([^<]*)<\/span>/g)].map(
    (match) => match[1] ?? "",
  );
}

describe("activity filters", () => {
  it("shows only the runs of one mirroring", async () => {
    const { user, cookie, ids, rules } = await setup("fa-mirror");
    await log(user.id, "sync_run", RUN, { rule: rules.ab, account: ids.b });
    await log(user.id, "sync_run", RUN, { rule: rules.ac, account: ids.c });
    await log(user.id, "sync_run", RUN, { rule: rules.cb, account: ids.b });
    const html = await (await get(`/activity?d=${ids.a}~${ids.b}`, cookie)).text();
    // The filter names the mirroring; its rows do not repeat the name.
    expect(titles(html)).toEqual([i18nFor("en").t.next.describe.activity.kinds.sync_run(null)]);
    expect(html).toContain('<span class="row-meta act-detail">2 new</span>');
    // The select shows the filter, so no chip repeats it.
    expect(html).toContain(`<option value="${ids.a}~${ids.b}" selected="">`);
    expect(html).not.toContain("act-chip");
  });

  it("shows a chip only for a filter that its select cannot show", async () => {
    const { cookie, ids } = await setup("fa-chip");
    // Beta to alpha has no rule, so the mirroring select does not list it.
    const html = await (await get(`/activity?d=${ids.b}~${ids.a}&kind=sync`, cookie)).text();
    const chips = [...html.matchAll(/class="act-chip" href="([^"]*)"/g)].map((m) => m[1]);
    expect(chips).toEqual(["/activity?kind=sync"]);
    expect(html).toContain('<option value="sync" selected="">');
  });

  it("shows a calendar on either side of a mirroring, and its own events", async () => {
    const { user, cookie, ids, rules } = await setup("fa-calendar");
    await log(user.id, "sync_run", RUN, { rule: rules.ab, account: ids.b });
    await log(user.id, "sync_run", RUN, { rule: rules.ac, account: ids.c });
    await log(user.id, "sync_run", RUN, { rule: rules.cb, account: ids.b });
    await log(user.id, "account_paused", { code: "token_x" }, { account: ids.c });
    const html = await (await get(`/activity?c=${ids.c}`, cookie)).text();
    expect(titles(html)).toEqual(["gamma: connection lost", "gamma to beta", "alpha to gamma"]);
    const other = await (await get(`/activity?c=${ids.a}`, cookie)).text();
    expect(titles(other)).toEqual(["alpha to gamma", "alpha to beta"]);
  });

  it("combines a mirroring and a calendar as an intersection", async () => {
    const { user, cookie, ids, rules } = await setup("fa-both");
    await log(user.id, "sync_run", RUN, { rule: rules.ab, account: ids.b });
    await log(user.id, "sync_run", RUN, { rule: rules.ac, account: ids.c });
    const match = await (await get(`/activity?d=${ids.a}~${ids.b}&c=${ids.a}`, cookie)).text();
    expect(titles(match)).toEqual([i18nFor("en").t.next.describe.activity.kinds.sync_run(null)]);
    const none = await (await get(`/activity?d=${ids.a}~${ids.b}&c=${ids.c}`, cookie)).text();
    expect(titles(none)).toEqual([]);
    expect(none).toContain("Nothing matches these filters");
    expect(none).toContain("Clear all filters");
  });

  it("filters by type", async () => {
    const { user, cookie, ids, rules } = await setup("fa-kind");
    await log(user.id, "sync_run", RUN, { rule: rules.ab, account: ids.b });
    await log(user.id, "sync_run", { ...RUN, failed: 2 }, { rule: rules.ac, account: ids.c });
    await log(user.id, "sync_failed", { code: "graph_503" }, { rule: rules.cb, account: ids.b });
    await log(user.id, "rule_updated", {}, { rule: rules.ab, account: ids.b });
    await log(user.id, "sign_in", {});
    const sync = titles(await (await get("/activity?kind=sync", cookie)).text());
    expect(sync).toEqual(["gamma to beta failed", "alpha to gamma", "alpha to beta"]);
    const changes = titles(await (await get("/activity?kind=changes", cookie)).text());
    expect(changes).toEqual(["alpha to beta changed"]);
    const problems = titles(await (await get("/activity?kind=problems", cookie)).text());
    expect(problems).toEqual(["gamma to beta failed", "alpha to gamma"]);
    const all = titles(await (await get("/activity", cookie)).text());
    expect(all).toHaveLength(5);
  });

  it("drops a filter that the state does not know", async () => {
    const { user, cookie, rules, ids } = await setup("fa-stale");
    await log(user.id, "sync_run", RUN, { rule: rules.ab, account: ids.b });
    const html = await (await get("/activity?d=x~y&c=nope&kind=weird&before=abc", cookie)).text();
    expect(titles(html)).toEqual(["alpha to beta"]);
    expect(html).not.toContain("act-applied");
  });

  it("marks a failed run and a partial run differently, and a large removal not at all", async () => {
    const { user, cookie, ids, rules } = await setup("fa-tone");
    await log(user.id, "sync_run", { ...RUN, create: 0, delete: 140 }, { rule: rules.ab });
    await log(user.id, "sync_run", { ...RUN, failed: 1 }, { rule: rules.ac, account: ids.c });
    await log(user.id, "sync_failed", { code: "graph_503" }, { rule: rules.cb, account: ids.b });
    const html = await (await get("/activity", cookie)).text();
    const rows = html.split('<div class="list-row act-row"').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('data-tone="danger"');
    expect(rows[0]).toContain('aria-label="Failed"');
    expect(rows[1]).toContain('data-tone="warn"');
    expect(rows[1]).toContain('aria-label="Needs attention"');
    expect(rows[2]).not.toContain("data-tone");
    expect(rows[2]).not.toContain("dot-");
    expect(rows[2]).toContain("140 removed");
  });
});

describe("activity paging", () => {
  it("shows 50 rows, then the rest behind the Older link, without overlap", async () => {
    const { user, cookie, rules } = await setup("pg-page");
    for (let index = 1; index <= 60; index++) {
      await log(user.id, "sync_run", { ...RUN, create: index }, { rule: rules.ab });
    }
    const first = await (await get("/activity", cookie)).text();
    const times = (html: string) => (html.match(/class="act-time num"/g) ?? []).length;
    expect(times(first)).toBe(50);
    expect(first).toContain("60 new");
    expect(first).not.toContain("Back to newest");
    const older = /href="(\/activity\?before=\d+)" rel="next"/.exec(first)?.[1];
    expect(older).toBeDefined();
    const second = await (await get(older ?? "", cookie)).text();
    expect(times(second)).toBe(10);
    expect(second).toContain("10 new");
    expect(second).not.toContain("11 new");
    expect(second).not.toContain('rel="next"');
    expect(second).toContain("Back to newest");
  });

  it("continues past a filter scan that found few rows", async () => {
    const { user, cookie, rules, ids } = await setup("pg-scan");
    await log(user.id, "account_paused", { code: "t" }, { account: ids.a });
    // More rows than one filtered scan reads: the match lies beyond the first scan.
    const stamp = Date.parse("2026-11-11T00:00:00.000Z");
    const times = Array.from({ length: 1005 }, (_, index) =>
      new Date(stamp + index * 1000).toISOString(),
    );
    for (let start = 0; start < times.length; start += 100) {
      await env.DB.batch(
        times.slice(start, start + 100).map((at) =>
          env.DB.prepare(
            `INSERT INTO audit_events (org_id, user_id, account_id, rule_id, kind, detail, created_at)
               VALUES ('default', ?, ?, ?, 'sync_run', ?, ?)`,
          ).bind(user.id, ids.b, rules.ab, JSON.stringify(RUN), at),
        ),
      );
    }
    const first = await (await get("/activity?kind=problems", cookie)).text();
    expect(titles(first)).toEqual([]);
    // Only the latest entries were read: the empty state says so.
    expect(first).toContain("No problems in the latest 1,000 entries");
    const older = /href="(\/activity\?[^"]*before=\d+[^"]*)" rel="next"/.exec(first)?.[1];
    expect(older).toBeDefined();
    const second = await (await get(older?.replaceAll("&amp;", "&") ?? "", cookie)).text();
    expect(titles(second)).toEqual(["alpha: connection lost"]);
  });

  it("scans through the index of the user, not the table", async () => {
    // The SQL that `activityPage` really runs, with a cursor and a filter.
    const { sql, binds } = activityPageQuery(
      { userId: "u" },
      { before: 1, group: "sync", ruleIds: ["r"], accountId: "a" },
      30,
    );
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(...binds)
      .all<{ detail: string }>();
    const plan = results.map((row) => row.detail).join("\n");
    expect(plan).toMatch(/SEARCH audit_events USING (COVERING )?INDEX audit_events_user_created/);
    // No full table scan. The sort of the last term only orders rows of one timestamp.
    expect(plan).not.toMatch(/^\s*SCAN audit_events/m);
  });
});

describe("activity grouping", () => {
  const i18n = i18nFor("en", "UTC");
  const account = (id: string) => ({ id, name: id, email: `${id}@x.example` });
  const state = {
    accounts: ["a", "b", "c"].map(account),
    directions: [],
    rules: [
      { from: "a", to: "b", rule: { id: "r1" } },
      { from: "a", to: "c", rule: { id: "r2" } },
    ],
  } as unknown as EditorState;
  let id = 0;
  const row = (ruleId: string, at: string, detail: object) => ({
    id: ++id,
    kind: "sync_run" as const,
    detail: JSON.stringify(detail),
    createdAt: at,
    email: null,
    accountEmail: null,
    ruleId,
  });
  const NOW = Date.parse("2026-11-17T12:00:00.000Z");

  it("joins quiet runs of one mirroring across the runs of another", () => {
    const days = groupActivity(
      [
        row("r1", "2026-11-17T11:05:00.000Z", QUIET),
        row("r2", "2026-11-17T11:04:00.000Z", QUIET),
        row("r1", "2026-11-17T10:05:00.000Z", QUIET),
        row("r2", "2026-11-17T10:04:00.000Z", { ...RUN, create: 3 }),
        row("r1", "2026-11-17T09:05:00.000Z", QUIET),
      ],
      state,
      i18n,
      NOW,
    );
    expect(days).toHaveLength(1);
    expect(days[0]?.heading).toBe("Today");
    const items = days[0]?.items ?? [];
    expect(items.map((item) => [item.described.title, item.count])).toEqual([
      ["a to b", 3],
      ["a to c", 1],
      ["a to c", 1],
    ]);
    expect(items[0]?.at).toBe("2026-11-17T11:05:00.000Z");
    expect(items[0]?.first).toBe("2026-11-17T09:05:00.000Z");
  });

  it("ends a chain at a run with changes of the same mirroring, and at a day heading", () => {
    const days = groupActivity(
      [
        row("r1", "2026-11-17T11:00:00.000Z", QUIET),
        row("r1", "2026-11-17T10:00:00.000Z", { ...RUN, create: 1 }),
        row("r1", "2026-11-17T09:00:00.000Z", QUIET),
        row("r1", "2026-11-16T23:00:00.000Z", QUIET),
        row("r1", "2026-11-12T23:00:00.000Z", QUIET),
      ],
      state,
      i18n,
      NOW,
    );
    expect(days.map((day) => day.heading)).toEqual(["Today", "Yesterday", "Thursday, November 12"]);
    expect(days.map((day) => day.items.map((item) => item.count))).toEqual([[1, 1, 1], [1], [1]]);
  });

  it("does not join a failure or a partial run", () => {
    const days = groupActivity(
      [
        row("r1", "2026-11-17T11:00:00.000Z", { ...QUIET, failed: 1 }),
        row("r1", "2026-11-17T10:00:00.000Z", { ...QUIET, failed: 1 }),
      ],
      state,
      i18n,
      NOW,
    );
    expect(days[0]?.items.map((item) => item.count)).toEqual([1, 1]);
  });
});

describe("activity query", () => {
  const state = {
    accounts: [{ id: "a" }, { id: "b" }],
    directions: [{ from: "a", to: "b" }],
    rules: [
      { from: "a", to: "b", rule: { id: "r1" } },
      { from: "a", to: "b", rule: { id: "r2" } },
    ],
  } as unknown as EditorState;

  it("keeps only what the state knows", () => {
    expect(
      parseActivityQuery(state, { d: "a~b", c: "b", kind: "sync", before: "7" }, false),
    ).toEqual({ d: "a~b", c: "b", kind: "sync", before: 7 });
    expect(parseActivityQuery(state, { d: "b~a", c: "z", kind: "x", before: "-1" }, false)).toEqual(
      {},
    );
  });

  it("keeps the user's own mirroring and calendar filters in the org view", () => {
    expect(parseActivityQuery(state, { d: "a~b", c: "a", kind: "sync" }, true)).toEqual({
      scope: "org",
      d: "a~b",
      c: "a",
      kind: "sync",
    });
    expect(parseActivityQuery(state, { d: "x~y", c: "x" }, true)).toEqual({ scope: "org" });
  });

  it("turns a mirroring into all its rules, and the saves that turned it off", () => {
    const filter = activityFilter(state, { d: "a~b" });
    expect(filter.ruleIds).toEqual(["r1", "r2"]);
    expect(filter.turnedOff).toEqual({ from: "a", to: "b" });
    expect(activityFilter(state, { c: "a" }).turnedOff).toEqual({ from: "a" });
  });
});

describe("activity access", () => {
  it("never shows the rows of another user", async () => {
    const mine = await setup("ac-mine");
    const theirs = await setup("ac-theirs");
    await log(mine.user.id, "sync_run", RUN, { rule: mine.rules.ab, account: mine.ids.b });
    await log(
      theirs.user.id,
      "sync_run",
      { ...RUN, create: 77 },
      { rule: theirs.rules.ab, account: theirs.ids.b },
    );
    const html = await (await get("/activity", mine.cookie)).text();
    expect(titles(html)).toEqual(["alpha to beta"]);
    expect(html).not.toContain("77 new");
    // The cursor of another user's row does not read their rows.
    const { results } = await env.DB.prepare(
      "SELECT MAX(id) AS id FROM audit_events WHERE user_id = ?",
    )
      .bind(theirs.user.id)
      .all<{ id: number }>();
    const stolen = await (await get(`/activity?before=${results[0]?.id}`, mine.cookie)).text();
    expect(titles(stolen)).toEqual([]);
    expect(stolen).not.toContain("77 new");
    // Another user's mirroring or calendar in the URL is not a filter.
    const foreign = await (
      await get(`/activity?d=${theirs.ids.a}~${theirs.ids.b}&c=${theirs.ids.a}`, mine.cookie)
    ).text();
    expect(foreign).not.toContain("act-applied");
    expect(foreign).not.toContain("77 new");
  });

  it("gives the view of the whole org to an admin only", async () => {
    const member = await setup("ac-member");
    const admin = await setup("ac-admin", "admin@example.com");
    // The newest row of the org, so that rows of other tests do not push it off the first page.
    await log(
      member.user.id,
      "sync_run",
      { ...RUN, create: 88 },
      { rule: member.rules.ab, at: "2030-01-01T00:00:00.000Z" },
    );
    const denied = await get("/activity?scope=org", member.cookie);
    expect(denied.status).toBe(404);
    const memberPage = await (await get("/activity", member.cookie)).text();
    expect(memberPage).not.toContain("scope=org");
    const own = await (await get("/activity", admin.cookie)).text();
    expect(own).toContain("scope=org");
    expect(own).not.toContain("88 new");
    expect(own).not.toContain('class="act-user"');
    const org = await (await get("/activity?scope=org", admin.cookie)).text();
    expect(org).toContain("88 new");
    expect(org).toContain("ac-member@org.example");
    expect(org).toContain('class="act-user"');
  });

  it("names the admin's own mirrorings in the org view, and keeps their filters", async () => {
    const member = await setup("og-member");
    const admin = await setup("og-admin", "admin@example.com");
    const future = (minute: number) => `2030-01-02T00:0${minute}:00.000Z`;
    await log(
      member.user.id,
      "sync_run",
      { ...RUN, create: 66 },
      { rule: member.rules.ab, account: member.ids.b, at: future(3) },
    );
    await log(
      admin.user.id,
      "sync_run",
      { ...RUN, create: 55 },
      { rule: admin.rules.ab, account: admin.ids.b, at: future(2) },
    );
    await log(
      admin.user.id,
      "sync_run",
      { ...RUN, create: 44 },
      { rule: admin.rules.ac, account: admin.ids.c, at: future(1) },
    );
    const org = await (await get("/activity?scope=org", admin.cookie)).text();
    const shown = titles(org);
    // The member's row stays without names; the admin's own rows name their mirroring.
    // The names come from the addresses; other tests of the same admin can add a suffix.
    expect(shown[0]).toBe(i18nFor("en").t.next.describe.activity.kinds.sync_run(null));
    expect(shown[1]).toMatch(/^alpha( \(og-admin\))? to beta( \(og-admin\))?$/);
    expect(shown[2]).toMatch(/^alpha( \(og-admin\))? to gamma( \(og-admin\))?$/);
    expect(org).not.toContain("og-member@beta.example");
    expect(org).toContain('name="d"');
    expect(org).toContain('name="c"');
    const filtered = await (
      await get(`/activity?scope=org&d=${admin.ids.a}~${admin.ids.b}`, admin.cookie)
    ).text();
    expect(filtered).toContain("55 new");
    expect(filtered).not.toContain("44 new");
    expect(filtered).not.toContain("66 new");
    expect(filtered).toContain('class="act-user"');
    // The switch between the views keeps the filter.
    expect(filtered).toContain(`href="/activity?d=${admin.ids.a}~${admin.ids.b}"`);
  });

  it("finds a turned off mirroring by its filter after its rule is gone", async () => {
    const { user, cookie, ids, rules } = await setup("og-off");
    await env.DB.prepare("DELETE FROM rules WHERE id = ?").bind(rules.ab).run();
    await log(
      user.id,
      "rule_deleted",
      {
        cleanup: "queued",
        choice: "off",
        fromAccount: ids.a,
        previousChoice: "busy",
        previousMarkPrivate: true,
      },
      { rule: rules.ab, account: ids.b },
    );
    await log(user.id, "sync_run", RUN, { rule: rules.cb, account: ids.b });
    const all = await (await get("/activity", cookie)).text();
    expect(titles(all)).toEqual(["gamma to beta", "alpha to beta turned off"]);
    const filtered = await (await get(`/activity?d=${ids.a}~${ids.b}`, cookie)).text();
    expect(titles(filtered)).toEqual([i18nFor("en").t.next.describe.activity.turnedOff]);
    const calendar = await (await get(`/activity?c=${ids.a}`, cookie)).text();
    expect(titles(calendar)).toEqual(["alpha to beta turned off"]);
  });

  it("sends a visitor without a session to the start page", async () => {
    const response = await exports.default.fetch(`${BASE}/activity`, { redirect: "manual" });
    expect(response.status).toBe(302);
  });
});

describe("activity content", () => {
  it("shows counts, codes and times but never event content", async () => {
    const { user, cookie, rules, ids } = await setup("ct-privacy");
    await log(
      user.id,
      "sync_run",
      { ...RUN, title: "Secret board meeting", attendees: "ceo@secret.example", location: "Vault" },
      { rule: rules.ab, account: ids.b },
    );
    const html = await (await get("/activity", cookie)).text();
    for (const secret of ["Secret board meeting", "ceo@secret.example", "Vault"]) {
      expect(html).not.toContain(secret);
    }
    expect(html).toContain("2 new");
    expect(html).toMatch(/datetime="[^"]+" title="[^"]+"/);
  });

  it("shows an empty state, and speaks German", async () => {
    const { cookie } = await setup("ct-empty");
    const empty = await (await get("/activity", cookie)).text();
    expect(empty).toContain("No activity yet");
    const german = await (await get("/activity?kind=problems", cookie, "de")).text();
    expect(german).toContain("Keine Probleme in den letzten 90 Tagen");
    expect(german).toContain("Filter entfernen");
    expect(german).toContain('<html lang="de" ');
  });

  it("says over which entries no problem was found, not that the filter matched nothing", async () => {
    const { user, cookie, rules, ids } = await setup("ct-noproblem");
    await log(user.id, "sync_run", RUN, { rule: rules.ab, account: ids.b });
    const html = await (await get("/activity?kind=problems", cookie)).text();
    expect(titles(html)).toEqual([]);
    // Every entry was read (fewer than one scan), and entries are kept 90 days.
    expect(html).toContain("No problems in the last 90 days");
    expect(html).not.toContain("Nothing matches these filters");
    // With another filter as well, the general text stays.
    const both = await (await get(`/activity?kind=problems&c=${ids.c}`, cookie)).text();
    expect(both).toContain("Nothing matches these filters");
  });

  it("opens joined quiet runs as a list of the single runs, without script or durations", async () => {
    const { user, cookie, rules, ids } = await setup("ct-group");
    // Three runs within three minutes: a chain never crosses a day heading, so runs spread over
    // half an hour split the group when the test runs shortly after midnight.
    const now = Date.now();
    for (const [minutes, ms] of [
      [3, 12],
      [2, 34],
      [1, 56],
    ] as const) {
      await log(
        user.id,
        "sync_run",
        { ...QUIET, durationMs: ms },
        { rule: rules.ab, account: ids.b, at: new Date(now - minutes * 60_000).toISOString() },
      );
    }
    const html = await (await get("/activity", cookie)).text();
    const start = html.indexOf('<details class="act-group">');
    expect(start).toBeGreaterThan(0);
    const group = html.slice(start, html.indexOf("</details>", start));
    // The row itself is the summary, so it takes the focus and opens with Enter or Space.
    expect(group).toMatch(/^<details class="act-group"><summary class="list-row act-row"/);
    expect(group).toContain("3 runs,");
    const runs = [...group.matchAll(/<li class="act-run">([\s\S]*?)<\/li>/g)];
    expect(runs).toHaveLength(3);
    for (const run of runs) expect(run[1]).toMatch(/<time class="act-run-time num" datetime="/);
    // Durations are engineering data: only the admin page shows them.
    expect(html).not.toContain("act-run-dur");
    expect(html).not.toContain("act-dur");
    expect(html).not.toMatch(/\d ms</);
  });

  it("groups under Today with the time in a time element", async () => {
    const { user, cookie, rules } = await setup("ct-today");
    await log(user.id, "sync_run", RUN, { rule: rules.ab, at: new Date().toISOString() });
    const html = await (await get("/activity", cookie)).text();
    expect(html).toContain("Today");
    expect(html).toMatch(
      /<time class="act-time num" datetime="[^"]+" title="[^"]+">\d\d:\d\d<\/time>/,
    );
  });
});

describe("activity rows", () => {
  const i18n = i18nFor("en", "UTC");
  const level = i18n.t.next.shell.levels.summary;
  const account = (id: string) => ({ id, name: id, email: `${id}@x.example`, color: "blue" });
  const state = {
    accounts: ["a", "b", "c"].map(account),
    directions: [],
    rules: [
      { from: "a", to: "b", rule: { id: "r1" } },
      { from: "a", to: "b", rule: { id: "r3" } },
      { from: "a", to: "c", rule: { id: "r2" } },
    ],
  } as unknown as EditorState;
  let id = 1000;
  const row = (kind: AuditKind, ruleId: string | null, at: string, detail: object = {}) => ({
    id: ++id,
    kind,
    detail: JSON.stringify(detail),
    createdAt: at,
    email: null,
    accountEmail: null as string | null,
    ruleId,
  });
  const change = (from: string, to: string) => {
    const [choice, mark] = to.split("-");
    const [previousChoice, previousMark] = from.split("-");
    return {
      choice,
      markPrivate: mark === "private",
      previousChoice,
      previousMarkPrivate: previousMark === "private",
    };
  };
  const NOW = Date.parse("2026-11-17T12:00:00.000Z");
  const items = (rows: ReturnType<typeof row>[]) =>
    groupActivity(rows, state, i18n, NOW).flatMap((day) => day.items);

  it("joins the changes of one mirroring with the delta, across its runs and rules", () => {
    const list = items([
      row(
        "rule_updated",
        "r1",
        "2026-11-17T11:05:00.000Z",
        change("title-private", "full-private"),
      ),
      row("sync_run", "r1", "2026-11-17T11:04:00.000Z", RUN),
      row(
        "rule_updated",
        "r3",
        "2026-11-17T11:00:00.000Z",
        change("busy-private", "title-private"),
      ),
      row(
        "rule_updated",
        "r1",
        "2026-11-17T11:00:00.000Z",
        change("busy-private", "title-private"),
      ),
    ]);
    expect(list.map((item) => [item.described.title, item.described.detail])).toEqual([
      [
        "a to b changed",
        `${level["busy-private"]} → ${level["full-private"]} · 2 changes, 11:00–11:05`,
      ],
      ["a to b", "2 new"],
    ]);
    expect(list[0]?.first).toBe("2026-11-17T11:00:00.000Z");
  });

  it("keeps level changes and detail changes of one mirroring apart, with the time of each", () => {
    const list = items([
      row("rule_updated", "r1", "2026-11-17T11:05:00.000Z", change("title-open", "busy-private")),
      row("rule_updated", "r1", "2026-11-17T11:04:00.000Z", {
        ...change("busy-private", "busy-private"),
        workDays: "1,2,3",
      }),
      row("rule_updated", "r1", "2026-11-17T11:00:00.000Z", change("busy-private", "title-open")),
    ]);
    const text = i18n.t.next.describe.changes;
    expect(list.map((item) => [item.described.detail, item.at, item.first])).toEqual([
      [
        `Titles visible to others 11:00–11:05 · ${text.now(level["busy-private"])} · 2 changes, 11:00–11:05`,
        "2026-11-17T11:05:00.000Z",
        "2026-11-17T11:00:00.000Z",
      ],
      [text.hours, "2026-11-17T11:04:00.000Z", "2026-11-17T11:04:00.000Z"],
    ]);
  });

  it("leaves out the mirroring's name on the rows of a list filtered to it", () => {
    const rows = [
      row("sync_run", "r1", "2026-11-17T11:05:00.000Z", RUN),
      row(
        "rule_updated",
        "r1",
        "2026-11-17T11:00:00.000Z",
        change("busy-private", "title-private"),
      ),
    ];
    const kinds = i18n.t.next.describe.activity.kinds;
    expect(
      groupActivity(rows, state, i18n, NOW, "a~b")
        .flatMap((day) => day.items)
        .map((item) => item.described.title),
    ).toEqual([kinds.sync_run(null), kinds.rule_updated()]);
    expect(items(rows).map((item) => item.described.title)).toEqual(["a to b", "a to b changed"]);
  });

  it("names a turned off mirroring and the copies its removal took away", () => {
    const off = {
      ...row("rule_deleted", "gone", "2026-11-17T11:00:00.000Z", {
        cleanup: "queued",
        choice: "off",
        fromAccount: "a",
        previousChoice: "busy",
        previousMarkPrivate: true,
      }),
      accountEmail: "b@x.example",
    };
    const cleanup = {
      ...row("cleanup_finished", "gone", "2026-11-17T11:02:00.000Z", {
        result: "removed",
        removed: 18,
      }),
      accountEmail: "b@x.example",
    };
    const list = items([cleanup, off]);
    const item = list.find((entry) => entry.key === String(off.id));
    expect(item?.described.title).toBe("a to b turned off");
    expect(item?.described.detail).toBe(
      `${level["busy-private"]} → ${level.off} · 18 copies removed`,
    );
    const de = i18nFor("de", "UTC");
    const german = groupActivity([cleanup, off], state, de, NOW).flatMap((day) => day.items);
    expect(german.find((entry) => entry.key === String(off.id))?.described.detail).toMatch(
      / · 18 Kopien entfernt$/,
    );
  });

  it("does not join across another change of the mirroring, or another mirroring", () => {
    const list = items([
      row(
        "rule_updated",
        "r1",
        "2026-11-17T11:05:00.000Z",
        change("title-private", "busy-private"),
      ),
      row("rule_paused", "r1", "2026-11-17T11:04:00.000Z"),
      row("rule_updated", "r2", "2026-11-17T11:03:00.000Z", change("busy-private", "title-open")),
      row(
        "rule_updated",
        "r1",
        "2026-11-17T11:00:00.000Z",
        change("busy-private", "title-private"),
      ),
    ]);
    expect(list.map((item) => item.described.detail)).toEqual([
      `${level["title-private"]} → ${level["busy-private"]}`,
      "a to b",
      `Titles visible to others from 11:03 · ${level["busy-private"]} → ${level["title-open"]}`,
      `${level["busy-private"]} → ${level["title-private"]}`,
    ]);
  });

  it("says when joined changes end where they started, and names the level of an old row", () => {
    const list = items([
      row("rule_updated", "r1", "2026-11-17T11:05:00.000Z", change("full-private", "busy-private")),
      row("rule_updated", "r1", "2026-11-17T11:00:00.000Z", change("busy-private", "full-private")),
      row("rule_updated", "r2", "2026-11-17T10:00:00.000Z", { choice: "full", markPrivate: true }),
    ]);
    expect(list.map((item) => item.described.detail)).toEqual([
      `${i18n.t.next.describe.changes.levelBack(level["busy-private"], 2)} · 2 changes, 11:00–11:05`,
      i18n.t.next.describe.changes.now(level["full-private"]),
    ]);
  });

  it("never joins away a time in which others saw titles", () => {
    const list = items([
      row("rule_updated", "r1", "2026-11-17T11:05:00.000Z", change("title-open", "busy-private")),
      row("rule_updated", "r1", "2026-11-17T11:00:00.000Z", change("busy-private", "title-open")),
    ]);
    expect(list.map((item) => item.described.detail)).toEqual([
      `Titles visible to others 11:00–11:05 · ${i18n.t.next.describe.changes.now(level["busy-private"])} · 2 changes, 11:00–11:05`,
    ]);
  });

  it("shows the time only on the first row of a minute", () => {
    const list = items([
      row("sync_run", "r1", "2026-11-17T11:05:40.000Z", RUN),
      row("sync_run", "r2", "2026-11-17T11:05:10.000Z", RUN),
      row("sync_run", "r1", "2026-11-17T11:04:50.000Z", RUN),
      row("sync_run", "r1", "2026-11-16T11:04:50.000Z", RUN),
    ]);
    expect(list.map((item) => item.showTime)).toEqual([true, false, true, true]);
  });

  it("joins the same event of one calendar across other events, until that calendar has another", () => {
    const at = (email: string, kind: AuditKind, time: string) => ({
      ...row(kind, null, `2026-11-17T${time}:00.000Z`),
      accountEmail: email,
    });
    const list = items([
      at("c@x.example", "account_renamed", "11:05"),
      at("b@x.example", "account_renamed", "11:04"),
      at("c@x.example", "account_renamed", "11:03"),
      row("sign_in", null, "2026-11-17T11:02:00.000Z"),
      at("c@x.example", "account_connected", "11:01"),
      at("c@x.example", "account_renamed", "11:00"),
    ]);
    expect(list.map((item) => [item.described.title, item.count])).toEqual([
      ["c was renamed", 2],
      ["b was renamed", 1],
      ["You signed in", 1],
      ["c connected", 1],
      ["c was renamed", 1],
    ]);
    expect(list[0]?.first).toBe("2026-11-17T11:03:00.000Z");
    expect(list[0]?.join).toBe("same");
  });
});

describe("activity rows on the page", () => {
  it("shows joined events as one row with how often and when", async () => {
    const { user, cookie, ids } = await setup("rw-same");
    for (let index = 0; index < 3; index++) {
      await log(user.id, "account_renamed", {}, { account: ids.c });
    }
    const en = await (await get("/activity", cookie)).text();
    expect(titles(en)).toEqual(["gamma was renamed"]);
    expect(en).toMatch(/<span class="row-meta act-detail">3 times, \d\d:\d\d–\d\d:\d\d<\/span>/);
    const de = await (await get("/activity", cookie, "de")).text();
    expect(de).toMatch(/<span class="row-meta act-detail">3-mal, \d\d:\d\d–\d\d:\d\d<\/span>/);
  });

  it("keeps the time of a repeated minute for screen readers only", async () => {
    const { user, cookie, rules, ids } = await setup("rw-minute");
    const minute = Date.now() - 60_000;
    const at = (seconds: number) => new Date(minute - (minute % 60_000) + seconds * 1000);
    await log(user.id, "sync_run", RUN, {
      rule: rules.ab,
      account: ids.b,
      at: at(40).toISOString(),
    });
    await log(user.id, "sync_run", RUN, {
      rule: rules.ac,
      account: ids.c,
      at: at(10).toISOString(),
    });
    const html = await (await get("/activity", cookie)).text();
    const times = [...html.matchAll(/<time class="act-time num( is-repeat)?"[^>]*>(.*?)<\/time>/g)];
    expect(times.map((time) => Boolean(time[1]))).toEqual([false, true]);
    expect(times[0]?.[2]).toMatch(/^\d\d:\d\d$/);
    expect(times[1]?.[2]).toMatch(/^<span class="sr-only">\d\d:\d\d<\/span>$/);
  });

  it("reserves the swatch slot on every row, with the calendar of a calendar event", async () => {
    const { user, cookie, rules, ids } = await setup("rw-swatch");
    await log(user.id, "sync_run", RUN, { rule: rules.ab, account: ids.b });
    await log(user.id, "account_renamed", {}, { account: ids.c });
    await log(user.id, "sign_in", {});
    const html = await (await get("/activity", cookie)).text();
    expect(titles(html)).toEqual(["You signed in", "gamma was renamed", "alpha to beta"]);
    const slots = [...html.matchAll(/<span class="act-route" aria-hidden="true">(.*?)<\/span>/g)];
    expect(slots.map((slot) => (slot[1]?.match(/class="cal-swatch"/g) ?? []).length)).toEqual([
      0, 1, 2,
    ]);
    const german = await (await get("/activity", cookie, "de")).text();
    expect(titles(german)).toContain("gamma wurde umbenannt");
  });

  it("explains a run that ended without a result and links its mirroring", async () => {
    const { user, cookie, rules, ids } = await setup("rw-aborted");
    await log(
      user.id,
      "sync_run_aborted",
      { runId: "x", startedAt: "y" },
      { rule: rules.ab, account: ids.b },
    );
    for (const language of ["en", "de"] as const) {
      const html = await (await get("/activity?kind=problems", cookie, language)).text();
      const t = i18nFor(language).t;
      expect(html).toContain(
        `<a class="list-row act-row" href="/mirroring?d=${ids.a}~${ids.b}" data-tone="danger">`,
      );
      expect(html).toContain(
        `<p class="act-explain">${t.next.describe.activity.detail.abortedExplain}</p>`,
      );
    }
  });

  it("joins two changes of a mirroring into one row with the delta", async () => {
    const { user, cookie, rules, ids } = await setup("rw-changes");
    const level = i18nFor("de").t.next.shell.levels.summary;
    const change = {
      choice: "title",
      markPrivate: true,
      previousChoice: "busy",
      previousMarkPrivate: true,
    };
    await log(user.id, "rule_updated", change, { rule: rules.ab, account: ids.b });
    await log(
      user.id,
      "rule_updated",
      { choice: "busy", markPrivate: false, previousChoice: "title", previousMarkPrivate: true },
      { rule: rules.ab, account: ids.b },
    );
    const html = await (await get("/activity", cookie, "de")).text();
    expect(titles(html)).toEqual(["alpha nach beta geändert"]);
    expect(html).toContain(`${level["busy-private"]} → ${level["busy-open"]} · 2 Änderungen,`);
  });
});
