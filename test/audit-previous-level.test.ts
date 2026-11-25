import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityRow } from "../src/audit";
import { loadEditorState, setDirections } from "../src/editor";
import { i18nFor } from "../src/i18n";
import {
  clockFor,
  describeActivity,
  describeChanges,
  exposureText,
} from "../src/pages/next/describe";
import { signIn } from "./helpers";

/** A user with two accounts, each with one main calendar and stored tokens. */
async function setup(prefix: string) {
  const { user } = await signIn(`${prefix}@org.example`);
  const accounts = [
    [`${prefix}-w`, `${prefix}@work.example`, "microsoft"],
    [`${prefix}-o`, `${prefix}@other.example`, "microsoft"],
  ] as const;
  for (const [id, email, provider] of accounts) {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, ?, ?)",
      ).bind(id, user.id, provider, email),
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
  return { user, w: `${prefix}-w`, o: `${prefix}-o` };
}

/** The `rule_updated` rows of a user, newest first, as the activity page reads them. */
async function updates(userId: string) {
  const { results } = await env.DB.prepare(
    `SELECT id, kind, detail, created_at AS createdAt, NULL AS email, NULL AS accountEmail,
            rule_id AS ruleId
     FROM audit_events WHERE user_id = ? AND kind = 'rule_updated' ORDER BY id DESC`,
  )
    .bind(userId)
    .all<{ id: number; kind: "rule_updated"; detail: string; createdAt: string; email: null }>();
  return results;
}

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("calendarView")) return Response.json({ value: [] });
    return new Response("unexpected", { status: 500 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the level before a change in the audit log", () => {
  it("records the level a rule had, next to the new one", async () => {
    const { user, w, o } = await setup("prev-level");
    await setDirections(env, user, [{ from: w, to: o, choice: "busy", markPrivate: true }]);
    await setDirections(env, user, [{ from: w, to: o, choice: "title", markPrivate: false }]);
    const [row] = await updates(user.id);
    expect(JSON.parse(row?.detail ?? "{}")).toEqual({
      choice: "title",
      markPrivate: false,
      previousChoice: "busy",
      previousMarkPrivate: true,
      fromAccount: w,
    });
  });

  it("records the mark a choice without a mark keeps, so the page knows the level after", async () => {
    const { user, w, o } = await setup("prev-bare");
    await setDirections(env, user, [{ from: w, to: o, choice: "busy", markPrivate: true }]);
    await setDirections(env, user, [{ from: w, to: o, choice: "full" }]);
    const rows = await updates(user.id);
    expect(JSON.parse(rows[0]?.detail ?? "{}")).toEqual({
      choice: "full",
      markPrivate: true,
      previousChoice: "busy",
      previousMarkPrivate: true,
      fromAccount: w,
    });
    const { t } = i18nFor("en");
    const level = t.next.shell.levels.summary;
    expect(describeChanges(rows, t)).toBe(`${level["busy-private"]} → ${level["full-private"]}`);
  });

  it("names the mirroring and the level before on the row of a save that turned it off", async () => {
    const { user, w, o } = await setup("prev-off");
    await setDirections(env, user, [{ from: w, to: o, choice: "title", markPrivate: false }]);
    await setDirections(env, user, [{ from: w, to: o, choice: "off" }]);
    const { results: all } = await env.DB.prepare(
      `SELECT e.id, e.kind, e.detail, e.created_at AS createdAt, NULL AS email,
              a.email AS accountEmail, e.rule_id AS ruleId
       FROM audit_events e LEFT JOIN accounts a ON a.id = e.account_id
       WHERE e.user_id = ? ORDER BY e.id DESC`,
    )
      .bind(user.id)
      .all<ActivityRow>();
    const results = all.filter((entry) => entry.kind === "rule_deleted");
    expect(results).toHaveLength(1);
    const [row] = results;
    expect(JSON.parse(row?.detail ?? "{}")).toEqual({
      cleanup: "queued",
      choice: "off",
      fromAccount: w,
      previousChoice: "title",
      previousMarkPrivate: false,
    });
    expect(row?.detail).not.toMatch(/@/);
    const state = await loadEditorState(env, user.id);
    const { t } = i18nFor("en");
    const line = describeActivity(row as ActivityRow, state, t);
    expect(line.title).toBe("work to other turned off");
    expect(line.detail).toBe(
      `${t.next.shell.levels.summary["title-open"]} → ${t.next.shell.levels.summary.off}`,
    );
    // With the row that turned it on, the time in which others saw the titles shows, with its end.
    const clock = clockFor({ locale: "en", timeZone: "UTC" });
    const window = exposureText(
      { level: "title-open", from: all[1]?.createdAt, until: row?.createdAt },
      t,
      clock,
    );
    expect(describeChanges(all, t, clock)).toBe(
      `${window} · ${t.next.describe.changes.now(t.next.shell.levels.summary.off)}`,
    );
  });

  it("holds only the level fields, never a name, title or category", async () => {
    const { user, w, o } = await setup("prev-privacy");
    await setDirections(env, user, [{ from: w, to: o, choice: "busy", markPrivate: true }]);
    await setDirections(env, user, [
      {
        from: w,
        to: o,
        choice: "full",
        markPrivate: false,
        details: { onlyCategories: ["Secret customer"], blockColor: "Secret colour" },
      },
    ]);
    const [row] = await updates(user.id);
    const keys = Object.keys(JSON.parse(row?.detail ?? "{}"));
    expect(keys).toContain("previousChoice");
    const allowed = [
      "choice",
      "markPrivate",
      "previousChoice",
      "previousMarkPrivate",
      "fromAccount",
    ];
    for (const key of keys) expect([...allowed, "onlyCategories", "blockColor"]).toContain(key);
    expect(row?.detail).not.toMatch(/Secret|@/);
  });
});
