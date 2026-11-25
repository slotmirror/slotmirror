import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { orgActivityPage, recentChanges, userActivityPage, type ActivityRow } from "../src/audit";
import { loadEditorState, setDirections, type EditorState } from "../src/editor";
import { i18nFor } from "../src/i18n";
import {
  heldRulesStatement,
  releaseHeldRules,
  removeAccounts,
  type HeldRule,
} from "../src/offboarding";
import { groupActivity } from "../src/pages/next/activity";
import { changeEntries, clockFor, exposureText, type OpenLevel } from "../src/pages/next/describe";
import { BASE, signIn } from "./helpers";

// The second cold privacy review of 2026-11-21: a disconnected account, ends beyond the scan of
// later rows, copies left after a failed removal, windows over several days, capped levels.

const i18n = i18nFor("en", "UTC");
const { t } = i18n;
const clock = clockFor(i18n);
const what = t.next.describe.changes.exposure.what;
const HOUR = 3_600_000;
const RUN = JSON.stringify({ dryRun: false, create: 0, update: 0, delete: 0, failed: 0 });

/** A user with the accounts `w` and `o`, each with a main calendar that is a source. */
async function setup(prefix: string, targetEmail = `${prefix}@other.example`) {
  const { user, cookie } = await signIn(`${prefix}@org.example`);
  const accounts = [
    [`${prefix}-w`, `${prefix}@work.example`],
    [`${prefix}-o`, targetEmail],
  ] as const;
  for (const [id, email] of accounts) {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, 'microsoft', ?)",
      ).bind(id, user.id, email),
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, ?, 'Main', 1, 1, 1)",
      ).bind(`${id}-cal`, id, `${id}-remote`),
    ]);
    await env.ACCOUNT_SYNC.getByName(id).storeTokens(
      id,
      { refreshToken: "r", accessToken: "a", accessExpiresAt: Date.now() + HOUR },
      "microsoft",
    );
  }
  return { user, cookie, w: `${prefix}-w`, o: `${prefix}-o` };
}

/** Rows of the users in the order of their IDs, one minute apart from `start`. Returns the times. */
async function retime(userIds: string[], start: number): Promise<Map<number, string>> {
  const marks = userIds.map(() => "?").join(", ");
  const { results } = await env.DB.prepare(
    `SELECT id FROM audit_events WHERE user_id IN (${marks}) ORDER BY id`,
  )
    .bind(...userIds)
    .all<{ id: number }>();
  const times = new Map(
    results.map((row, index) => [row.id, new Date(start + index * 60_000).toISOString()]),
  );
  for (let index = 0; index < results.length; index += 100) {
    await env.DB.batch(
      results
        .slice(index, index + 100)
        .map((row) =>
          env.DB.prepare("UPDATE audit_events SET created_at = ? WHERE id = ?").bind(
            times.get(row.id),
            row.id,
          ),
        ),
    );
  }
  return times;
}

/** The rule rows of a user, oldest first. */
async function ruleRows(userId: string) {
  const { results } = await env.DB.prepare(
    `SELECT id, kind, rule_id AS ruleId, detail, created_at AS createdAt FROM audit_events
     WHERE user_id = ? AND kind LIKE 'rule_%' ORDER BY id`,
  )
    .bind(userId)
    .all<{ id: number; kind: string; ruleId: string; detail: string; createdAt: string }>();
  return results.map((row) => ({ ...row, parsed: JSON.parse(row.detail) as object }));
}

/** `count` quiet runs of a rule, as an hour of runs writes them. */
async function runs(
  orgId: string,
  userId: string,
  accountId: string,
  ruleId: string,
  count: number,
) {
  const statements = Array.from({ length: count }, () =>
    env.DB.prepare(
      "INSERT INTO audit_events (org_id, user_id, account_id, rule_id, kind, detail) VALUES (?, ?, ?, ?, 'sync_run', ?)",
    ).bind(orgId, userId, accountId, ruleId, RUN),
  );
  for (let index = 0; index < statements.length; index += 100) {
    await env.DB.batch(statements.slice(index, index + 100));
  }
}

function lines(rows: ActivityRow[], state: EditorState, locale = i18n) {
  return groupActivity(rows, state, locale, Date.now()).flatMap((day) =>
    day.items.map((item) => `${item.described.title} | ${item.described.detail}`),
  );
}

const window = (level: OpenLevel, from: string | undefined, until?: string, ended?: boolean) =>
  exposureText({ level, from, until, ...(ended ? { ended } : {}) }, t, clock);

function post(path: string, cookie: string, form: Record<string, string> = {}) {
  return exports.default.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    redirect: "manual",
  });
}

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("calendarView")) return Response.json({ value: [] });
    return new Response("unexpected", { status: 500 });
  });
});
afterEach(() => vi.restoreAllMocks());

describe("a disconnected calendar account", () => {
  it("writes a row per rule that goes with it, and keeps its windows under a neutral name", async () => {
    const { user, w, o } = await setup("gone-to");
    await setDirections(env, user, [{ from: w, to: o, choice: "full", markPrivate: false }]);
    await removeAccounts(env, user, [o]);
    const rows = await ruleRows(user.id);
    expect(rows.map((row) => [row.kind, row.parsed])).toEqual([
      ["rule_created", { choice: "full", markPrivate: false, fromAccount: w }],
      [
        "rule_deleted",
        {
          cleanup: "queued",
          choice: "off",
          accountRemoved: true,
          fromAccount: w,
          previousChoice: "full",
          previousMarkPrivate: false,
        },
      ],
    ]);
    // IDs and levels only: no address, no name.
    expect(rows.map((row) => row.detail).join("")).not.toMatch(/@|Main|other/);

    const now = Date.now();
    const times = await retime([user.id], now - 3 * HOUR);
    const [created, removed] = rows.map((row) => times.get(row.id));
    const state = await loadEditorState(env, user.id);
    const page = await userActivityPage(env.DB, user.id, {});
    const shown = lines(page.rows, state).join("\n");
    const expected = window("full-open", created, removed);
    // The removal and the add join into one item under the mirroring, titled by the newest row.
    expect(shown).toContain(
      `work to ${t.next.describe.activity.goneCalendar} turned off | ${expected} · ${t.next.describe.changes.now(t.next.shell.levels.summary.off)}`,
    );

    const changes = await recentChanges(env.DB, user.id, now);
    const entry = changeEntries(changes.rows, state, t, clock, now).find((e) =>
      e.key.startsWith("m:"),
    );
    expect(entry?.key).toBe(`m:${w}~${o}`);
    expect(entry?.route?.to.name).toBe(t.next.describe.activity.goneCalendar);
    expect(entry?.exposures).toEqual([
      exposureText({ level: "full-open", from: created, until: removed }, t, clock, now),
    ]);
    expect(entry?.text).toContain(t.next.shell.levels.summary.off);

    const de = i18nFor("de", "UTC");
    expect(lines(page.rows, state, de).join("\n")).toContain(
      "work nach ein getrennter Kalender ausgeschaltet",
    );
  });

  it("names a disconnected source calendar with a capital at the start of a title", async () => {
    const { user, w, o } = await setup("gone-from");
    await setDirections(env, user, [{ from: w, to: o, choice: "title", markPrivate: false }]);
    await removeAccounts(env, user, [w]);
    const state = await loadEditorState(env, user.id);
    const page = await userActivityPage(env.DB, user.id, {});
    const shown = lines(page.rows, state).join("\n");
    expect(shown).toContain(
      "A disconnected calendar to other turned off | Titles visible to others",
    );
    expect(shown).not.toMatch(/Titles visible to others from/);
  });
});

describe("an end beyond the scan of later rows", () => {
  async function widenThenRuns(prefix: string) {
    const { user, w, o } = await setup(prefix);
    await setDirections(env, user, [{ from: w, to: o, choice: "busy", markPrivate: true }]);
    await setDirections(env, user, [{ from: w, to: o, choice: "full", markPrivate: false }]);
    const rule = await env.DB.prepare("SELECT id FROM rules WHERE user_id = ?")
      .bind(user.id)
      .first<{ id: string }>();
    await runs(user.orgId, user.id, o, rule?.id ?? "", 1005);
    return { user, w, o };
  }

  async function olderPage(userId: string) {
    const first = await env.DB.prepare(
      "SELECT MIN(id) AS id FROM audit_events WHERE user_id = ? AND kind = 'sync_run'",
    )
      .bind(userId)
      .first<{ id: number }>();
    return userActivityPage(env.DB, userId, { before: first?.id ?? 0 }, 2);
  }

  it("says the rule was removed and copies may remain if the rule is gone now", async () => {
    const { user, w, o } = await widenThenRuns("scan-gone");
    await setDirections(env, user, [{ from: w, to: o, choice: "off" }]);
    const times = await retime([user.id], Date.now() - 30 * HOUR);
    const widened = times.get((await ruleRows(user.id))[1]?.id ?? 0);
    const state = await loadEditorState(env, user.id);
    const page = await olderPage(user.id);
    // The turn off lies beyond the scan: no context row holds it.
    expect(page.rows.filter((row) => row.context)).toEqual([]);
    const shown = lines(page.rows, state).join("\n");
    // No deletion with a queued removal is known: the copies may still show.
    expect(shown).toContain(
      t.next.describe.changes.exposure.fromRemoved(
        what["full-open"],
        clock(widened ?? ""),
        "other",
      ),
    );
    expect(shown).not.toContain("ended later");
  });

  it("keeps the window open if the current level still shows it", async () => {
    const { user } = await widenThenRuns("scan-open");
    const times = await retime([user.id], Date.now() - 30 * HOUR);
    const widened = times.get((await ruleRows(user.id))[1]?.id ?? 0);
    const state = await loadEditorState(env, user.id);
    const page = await olderPage(user.id);
    const shown = lines(page.rows, state).join("\n");
    expect(shown).toContain(window("full-open", widened));
    expect(shown).not.toContain("ended later");
  });

  it("reads the later rows of the viewer only in the org view", async () => {
    const a = await setup("scan-org-a");
    const b = await setup("scan-org-b");
    await setDirections(env, a.user, [{ from: a.w, to: a.o, choice: "busy", markPrivate: true }]);
    await setDirections(env, a.user, [{ from: a.w, to: a.o, choice: "full", markPrivate: false }]);
    await setDirections(env, b.user, [{ from: b.w, to: b.o, choice: "busy", markPrivate: true }]);
    const bRule = await env.DB.prepare("SELECT id FROM rules WHERE user_id = ?")
      .bind(b.user.id)
      .first<{ id: string }>();
    const firstOfB = await env.DB.prepare("SELECT MAX(id) AS id FROM audit_events").first<{
      id: number;
    }>();
    // More rows of another user than one scan reads lie between the widening and its end.
    await runs(b.user.orgId, b.user.id, b.o, bRule?.id ?? "", 1005);
    await setDirections(env, a.user, [{ from: a.w, to: a.o, choice: "off" }]);
    const times = await retime([a.user.id, b.user.id], Date.now() - 240 * HOUR);
    const aRows = await ruleRows(a.user.id);
    const widened = times.get(aRows[1]?.id ?? 0);
    const off = times.get(aRows[2]?.id ?? 0);
    const state = await loadEditorState(env, a.user.id);
    const page = await orgActivityPage(
      env.DB,
      a.user.orgId,
      { before: (firstOfB?.id ?? 0) + 1 },
      2,
      a.user.id,
    );
    const aRules = new Set(aRows.map((row) => row.ruleId));
    const context = page.rows.filter((row) => row.context);
    expect(context.length).toBeGreaterThan(0);
    for (const row of context) {
      expect(aRules.has(row.ruleId ?? "")).toBe(true);
      expect(row.accountEmail).toBe("scan-org-a@other.example");
    }
    const shown = lines(page.rows, state).join("\n");
    expect(shown).toContain(window("full-open", widened, off));
  });
});

describe("a rule whose copies were not queued for removal", () => {
  function rows(detail: object): ActivityRow[] {
    return [
      {
        id: 2,
        kind: "rule_deleted",
        detail: JSON.stringify(detail),
        createdAt: new Date(Date.now() - HOUR).toISOString(),
        email: null,
        accountEmail: "left@other.example",
        accountId: "left-o",
        ruleId: "gone-rule",
      },
      {
        id: 1,
        kind: "rule_created",
        detail: JSON.stringify({ choice: "full", markPrivate: false, fromAccount: "left-w" }),
        createdAt: new Date(Date.now() - 2 * HOUR).toISOString(),
        email: null,
        accountEmail: "left@other.example",
        accountId: "left-o",
        ruleId: "gone-rule",
      },
    ];
  }

  for (const [name, detail] of [
    [
      "a turn off",
      {
        cleanupFailed: true,
        choice: "off",
        fromAccount: "left-w",
        previousChoice: "full",
        previousMarkPrivate: false,
      },
    ],
    [
      "a source calendar turned off",
      {
        cleanupFailed: true,
        fromAccount: "left-w",
        previousChoice: "full",
        previousMarkPrivate: false,
      },
    ],
  ] as const) {
    it(`keeps the window open after ${name} and says where copies may be`, async () => {
      // Each case has its own accounts: the database lives through the whole file.
      const prefix = name === "a turn off" ? "left1" : "left2";
      const { user } = await setup(prefix);
      const state = await loadEditorState(env, user.id);
      const list = JSON.parse(
        JSON.stringify(rows(detail))
          .replaceAll("left-", `${prefix}-`)
          .replaceAll("left@", `${prefix}@`),
      ) as ActivityRow[];
      const opened = window("full-open", list[1]?.createdAt);
      const left = t.next.describe.changes.copiesLeft("other");
      const shown = lines(list, state).join("\n");
      expect(shown).toContain(opened);
      expect(shown).toContain(left);
      expect(shown).not.toContain("ended later");
      const now = Date.now();
      const [entry] = changeEntries(list, state, t, clock, now);
      // The time says where copies may be; the details do not say it twice.
      expect(entry?.exposures).toEqual([
        exposureText(
          { level: "full-open", from: list[1]?.createdAt, removed: true },
          t,
          clock,
          now,
          "other",
        ),
      ]);
      expect(entry?.exposures?.[0]).toContain(left);
      expect(entry?.details).not.toContain(left);
    });
  }
});

describe("windows over several days", () => {
  it("dates an end on another day, in English and German", () => {
    const de = i18nFor("de", "UTC");
    const exposure = {
      level: "title-open" as const,
      from: "2026-11-20T10:00:00.000Z",
      until: "2026-11-21T08:30:00.000Z",
    };
    expect(exposureText(exposure, t, clock)).toBe(`${what["title-open"]} 10:00 – Nov 21, 08:30`);
    expect(exposureText(exposure, de.t, clockFor(de))).toBe(
      "Titel für andere sichtbar 10:00 – 21.11. 08:30",
    );
  });

  it("names yesterday or the date of a start in the Overview", () => {
    const de = i18nFor("de", "UTC");
    const now = Date.parse("2026-11-21T09:00:00.000Z");
    const yesterday = { level: "title-open" as const, from: "2026-11-20T14:04:00.000Z" };
    const older = { level: "title-open" as const, from: "2026-11-19T14:04:00.000Z" };
    expect(exposureText(yesterday, t, clock, now)).toBe(
      `${what["title-open"]} from yesterday 14:04`,
    );
    expect(exposureText(yesterday, de.t, clockFor(de), now)).toBe(
      "Titel für andere sichtbar ab gestern 14:04",
    );
    expect(exposureText(older, t, clock, now)).toBe(`${what["title-open"]} from Nov 19, 14:04`);
    expect(exposureText({ ...older, from: "2026-11-21T08:00:00.000Z" }, t, clock, now)).toBe(
      `${what["title-open"]} from 08:00`,
    );
  });
});

describe("capped levels", () => {
  it("logs the level that the org caps allow on the old rules page", async () => {
    // MAX_DETAIL_FROM_EXTERNAL is "busy" in the test bindings; the target belongs to the org.
    const { user, cookie, w, o } = await setup("cap-old", "cap-old-target@org.example");
    await post("/rules", cookie, { source: `${w}-cal`, target: `${o}-cal`, detailLevel: "title" });
    const rule = await env.DB.prepare("SELECT id FROM rules WHERE user_id = ?")
      .bind(user.id)
      .first<{ id: string }>();
    await post(`/rules/${rule?.id}/enable`, cookie);
    const rows = await ruleRows(user.id);
    expect(rows.map((row) => [row.kind, row.parsed])).toEqual([
      [
        "rule_created",
        { detailLevel: "busy", daysAhead: 60, choice: "off", markPrivate: false, fromAccount: w },
      ],
      [
        "rule_enabled",
        { choice: "busy", markPrivate: false, previousChoice: "off", fromAccount: w },
      ],
    ]);
  });

  it("names the capped level and the source of a rule that an offboarding restores", async () => {
    const { user, w, o } = await setup("cap-held", "cap-held-target@org.example");
    await env.DB.prepare(
      `INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options, enabled)
       VALUES ('cap-held-rule', ?, ?, ?, ?, 0)`,
    )
      .bind(
        user.id,
        `${w}-cal`,
        `${o}-cal`,
        JSON.stringify({ detailLevel: "full", markPrivate: false }),
      )
      .run();
    await env.DB.prepare(
      "INSERT INTO rule_holds (rule_id, hold_id, until) VALUES ('cap-held-rule', 'h1', ?)",
    )
      .bind(Date.now() - HOUR)
      .run();
    const { results } = await heldRulesStatement(env, Date.now()).all<HeldRule>();
    await releaseHeldRules(env, results, Date.now());
    const rows = await ruleRows(user.id);
    expect(rows.map((row) => [row.kind, row.parsed])).toEqual([
      [
        "rule_enabled",
        {
          restored: true,
          choice: "busy",
          markPrivate: false,
          previousChoice: "off",
          fromAccount: w,
        },
      ],
    ]);
  });
});
