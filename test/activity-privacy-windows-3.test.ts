import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { orgActivityPage, recentChanges, userActivityPage, type ActivityRow } from "../src/audit";
import {
  loadEditorState,
  setDirections,
  setGroupMemberships,
  setSettings,
  setSourceCalendar,
  type EditorState,
} from "../src/editor";
import { i18nFor } from "../src/i18n";
import { removeAccounts } from "../src/offboarding";
import { groupActivity } from "../src/pages/next/activity";
import {
  changeEntries,
  clockFor,
  exposuresWithin,
  type TimedStep,
} from "../src/pages/next/describe";
import { BASE, signIn } from "./helpers";

// The third cold privacy review of 2026-11-21: a lower open level beyond the rows, a rule gone
// without a known removal, a current level of "off", disconnects of rules that were off, capped
// levels in every editor write, and the account ID in the org view.

const i18n = i18nFor("en", "UTC");
const { t } = i18n;
const clock = clockFor(i18n);
const text = t.next.describe.changes.exposure;
const what = text.what;
const HOUR = 3_600_000;

/** A user with the accounts `w` and `o`, each with a main calendar that is a source. */
async function setup(
  prefix: string,
  options: { targetEmail?: string; group?: boolean } = {},
): Promise<{
  user: Awaited<ReturnType<typeof signIn>>["user"];
  cookie: string;
  w: string;
  o: string;
}> {
  const { user, cookie } = await signIn(`${prefix}@org.example`);
  const accounts = [
    [`${prefix}-w`, `${prefix}@work.example`],
    [`${prefix}-o`, options.targetEmail ?? `${prefix}@other.example`],
  ] as const;
  for (const [id, email] of accounts) {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, provider, email, in_block_group) VALUES (?, ?, 'microsoft', ?, ?)",
      ).bind(id, user.id, email, options.group ? 1 : 0),
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

function lines(rows: ActivityRow[], state: EditorState) {
  return groupActivity(rows, state, i18n, Date.now()).flatMap((day) =>
    day.items.map((item) => `${item.described.title} | ${item.described.detail}`),
  );
}

/** The rule rows of a user, oldest first, with the parsed detail. */
async function ruleRows(userId: string) {
  const { results } = await env.DB.prepare(
    `SELECT id, kind, detail, created_at AS createdAt FROM audit_events
     WHERE user_id = ? AND kind LIKE 'rule_%' ORDER BY id`,
  )
    .bind(userId)
    .all<{ id: number; kind: string; detail: string; createdAt: string }>();
  return results.map((row) => ({
    ...row,
    parsed: JSON.parse(row.detail) as Record<string, unknown>,
  }));
}

/** The page of a user's rows, and the rows up to the first change of a rule: its end is "later". */
async function olderOnly(userId: string) {
  const page = await userActivityPage(env.DB, userId, {});
  const first = page.rows.findLast((row) => row.kind.startsWith("rule_"));
  return page.rows.filter((row) => row.id <= (first?.id ?? 0));
}

function post(path: string, cookie: string, form: Record<string, string> = {}) {
  return exports.default.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    redirect: "manual",
  });
}

const step = (at: string, before: object, after: object): TimedStep =>
  ({ ruleId: "r", at, step: { before, after } }) as TimedStep;

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("calendarView")) return Response.json({ value: [] });
    return new Response("unexpected", { status: 500 });
  });
});
afterEach(() => vi.restoreAllMocks());

describe("the current level of a time without an end in the rows", () => {
  const at = "2026-11-01T10:00:00.000Z";
  const own = [step(at, { choice: "off" }, { choice: "full", markPrivate: false })];

  it("counts a current level of off as ended, like a lower one", () => {
    expect(exposuresWithin(own, [], { current: () => "off" })).toEqual([
      { level: "full-open", from: at, ended: true },
    ]);
  });

  it("keeps a lower open level open from the start of the time it ends", () => {
    expect(exposuresWithin(own, [], { current: () => "title-open" })).toEqual([
      { level: "full-open", from: at, ended: true },
      { level: "title-open", from: at },
    ]);
  });

  it("names a rule that is gone as removed, not as ended", () => {
    expect(exposuresWithin(own, [], { current: () => undefined })).toEqual([
      { level: "full-open", from: at, removed: true },
    ]);
  });

  it("ends the window of a group exception turned off beyond the rows", async () => {
    const { user, w, o } = await setup("cur-off", { group: true });
    await setDirections(env, user, [{ from: w, to: o, choice: "title", markPrivate: false }]);
    await setDirections(env, user, [{ from: w, to: o, choice: "off" }]);
    const state = await loadEditorState(env, user.id);
    // The rule stays, disabled: its current level is "off".
    expect(state.rules.map(({ rule }) => rule.enabled)).toEqual([false]);
    const older = await olderOnly(user.id);
    const shown = lines(older, state).join("\n");
    expect(shown).toContain(text.fromEnded(what["title-open"], clock(older[0]?.createdAt ?? "")));
  });

  it("keeps the titles visible after Everything went down to Title beyond the rows", async () => {
    const { user, w, o } = await setup("cur-lower");
    await setDirections(env, user, [{ from: w, to: o, choice: "full", markPrivate: false }]);
    await setDirections(env, user, [{ from: w, to: o, choice: "title", markPrivate: false }]);
    const state = await loadEditorState(env, user.id);
    const older = await olderOnly(user.id);
    const start = clock(older[0]?.createdAt ?? "");
    const shown = lines(older, state).join("\n");
    expect(shown).toContain(
      `${text.fromEnded(what["full-open"], start)} · ${text.from(what["title-open"], start)}`,
    );
  });
});

describe("a rule that is gone", () => {
  it("says it was removed and that copies may still be there, without a known deletion", async () => {
    const { user, w, o } = await setup("gone-unknown");
    const state = await loadEditorState(env, user.id);
    const at = new Date(Date.now() - 50 * HOUR).toISOString();
    const rows: ActivityRow[] = [
      {
        id: 1,
        kind: "rule_created",
        detail: JSON.stringify({ choice: "full", markPrivate: false, fromAccount: w }),
        createdAt: at,
        email: null,
        accountEmail: "gone-unknown@other.example",
        accountId: o,
        ruleId: "gone-unknown-rule",
      },
    ];
    expect(lines(rows, state).join("\n")).toContain(
      text.fromRemoved(what["full-open"], clock(at), "other"),
    );
  });

  it("keeps the window open when a later deletion beyond the page left copies", async () => {
    const { user, w, o } = await setup("gone-left");
    const created = new Date(Date.now() - 5 * HOUR).toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO audit_events (org_id, user_id, account_id, rule_id, kind, detail, created_at)
         VALUES (?, ?, ?, 'gone-left-rule', 'rule_created', ?, ?)`,
      ).bind(
        user.orgId,
        user.id,
        o,
        JSON.stringify({ choice: "full", markPrivate: false, fromAccount: w }),
        created,
      ),
      env.DB.prepare(
        `INSERT INTO audit_events (org_id, user_id, account_id, rule_id, kind, detail, created_at)
         VALUES (?, ?, ?, 'gone-left-rule', 'rule_deleted', ?, ?)`,
      ).bind(
        user.orgId,
        user.id,
        o,
        JSON.stringify({
          cleanupFailed: true,
          choice: "off",
          fromAccount: w,
          previousChoice: "full",
          previousMarkPrivate: false,
        }),
        new Date(Date.now() - HOUR).toISOString(),
      ),
    ]);
    const state = await loadEditorState(env, user.id);
    const first = await userActivityPage(env.DB, user.id, {}, 1);
    const second = await userActivityPage(env.DB, user.id, { before: first.older ?? 0 }, 1);
    // The deletion is a context row of the older page.
    expect(second.rows.filter((row) => row.context).map((row) => row.kind)).toEqual([
      "rule_deleted",
    ]);
    const shown = lines(second.rows, state);
    expect(shown).toEqual([
      `work to other added | ${text.fromRemoved(what["full-open"], clock(created), "other")} · Not copied → ${t.next.shell.levels.summary["full-open"]}`,
    ]);
  });
});

describe("a disconnect", () => {
  it("writes a plain removal row, without a level change, for a rule that was off already", async () => {
    const { user, w, o } = await setup("dis-off");
    await setDirections(env, user, [{ from: w, to: o, choice: "title", markPrivate: false }]);
    await env.DB.prepare(
      `INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options, enabled)
       VALUES ('dis-off-rule', ?, ?, ?, ?, 0)`,
    )
      .bind(
        user.id,
        `${o}-cal`,
        `${w}-cal`,
        JSON.stringify({ detailLevel: "full", markPrivate: false }),
      )
      .run();
    await removeAccounts(env, user, [o]);
    const deleted = (await ruleRows(user.id)).filter((row) => row.kind === "rule_deleted");
    // Its copies get a removal too, and a disabled rule may be a pause that left them showing, so
    // it writes a row. It turns nothing off: no "choice", the level before is "off".
    expect(deleted.map((row) => row.parsed)).toEqual([
      expect.objectContaining({ choice: "off", fromAccount: w, previousChoice: "title" }),
      {
        cleanup: "queued",
        accountRemoved: true,
        fromAccount: o,
        previousChoice: "off",
      },
    ]);
  });
});

describe("capped levels in the editor's rows", () => {
  // MAX_DETAIL_FROM_EXTERNAL is "busy" in the test bindings; each target belongs to the org.
  async function oldPageRule(prefix: string) {
    const ids = await setup(prefix, { targetEmail: `${prefix}-target@org.example` });
    await post("/rules", ids.cookie, {
      source: `${ids.w}-cal`,
      target: `${ids.o}-cal`,
      detailLevel: "title",
    });
    const rule = await env.DB.prepare("SELECT id FROM rules WHERE user_id = ?")
      .bind(ids.user.id)
      .first<{ id: string }>();
    await post(`/rules/${rule?.id}/enable`, ids.cookie);
    return { ...ids, ruleId: rule?.id ?? "" };
  }

  it("names the capped level before a deletion on the old page", async () => {
    const { user, cookie, ruleId } = await oldPageRule("cap-del");
    await post(`/rules/${ruleId}/delete`, cookie);
    const deleted = (await ruleRows(user.id)).find((row) => row.kind === "rule_deleted");
    expect(deleted?.parsed).toMatchObject({ previousChoice: "busy", previousMarkPrivate: false });
  });

  it("names the capped level before a turn off in the editor", async () => {
    const { user, w, o } = await oldPageRule("cap-off");
    await setDirections(env, user, [{ from: w, to: o, choice: "off" }]);
    const deleted = (await ruleRows(user.id)).find((row) => row.kind === "rule_deleted");
    expect(deleted?.parsed).toMatchObject({ choice: "off", previousChoice: "busy" });
  });

  it("names the capped level of a mark change for all mirrorings", async () => {
    const { user } = await oldPageRule("cap-all");
    const before = await loadEditorState(env, user.id);
    const { blockTitleStored: _stored, ...settings } = before.settings;
    await setSettings(env, user, { ...settings, newWho: "private", applyWho: true });
    const marked = (await ruleRows(user.id)).filter((row) => row.kind === "rule_updated");
    expect(marked.map((row) => row.parsed)).toEqual([
      expect.objectContaining({
        choice: "busy",
        markPrivate: true,
        previousChoice: "busy",
        previousMarkPrivate: false,
      }),
    ]);
  });

  it("names the capped level before a group rule goes with its account", async () => {
    const { user, w, o } = await setup("cap-group", {
      targetEmail: "cap-group-target@org.example",
      group: true,
    });
    await env.DB.prepare(
      `INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options, enabled, origin)
       VALUES ('cap-group-rule', ?, ?, ?, ?, 1, 'group')`,
    )
      .bind(
        user.id,
        `${w}-cal`,
        `${o}-cal`,
        JSON.stringify({ detailLevel: "full", markPrivate: false }),
      )
      .run();
    await setGroupMemberships(env, user, [w], false);
    const deleted = (await ruleRows(user.id)).find((row) => row.kind === "rule_deleted");
    expect(deleted?.parsed).toMatchObject({ previousChoice: "busy", previousMarkPrivate: false });
  });
});

describe("round 4: copies of the old rules page", () => {
  it("names the capped level of a rule copied from an old-page rule", async () => {
    const { user, cookie, w, o } = await setup("cap-copy", {
      targetEmail: "cap-copy-target@org.example",
    });
    await env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, 'second-remote', 'Second', 1, 0, 0)",
    )
      .bind(`${w}-second`, w)
      .run();
    await post("/rules", cookie, { source: `${w}-cal`, target: `${o}-cal`, detailLevel: "title" });
    const rule = await env.DB.prepare("SELECT id FROM rules WHERE user_id = ?")
      .bind(user.id)
      .first<{ id: string }>();
    await post(`/rules/${rule?.id}/enable`, cookie);
    await setSourceCalendar(env, user, `${w}-second`, true);
    const created = (await ruleRows(user.id)).filter((row) => row.kind === "rule_created");
    // The copy stores the model's options ("title"), but the cap lets the sync copy busy only.
    expect(created.at(-1)?.parsed).toEqual({ choice: "busy", markPrivate: false, fromAccount: w });
  });

  it("keeps the window open after a pause that queued no removal, also on an older page", async () => {
    const { user, cookie, w, o } = await setup("pause-kept");
    await post("/rules", cookie, { source: `${w}-cal`, target: `${o}-cal`, detailLevel: "title" });
    const rule = await env.DB.prepare("SELECT id FROM rules WHERE user_id = ?")
      .bind(user.id)
      .first<{ id: string }>();
    await post(`/rules/${rule?.id}/enable`, cookie);
    await post(`/rules/${rule?.id}/pause`, cookie);
    const rows = await ruleRows(user.id);
    expect(rows.at(-1)?.parsed).toMatchObject({ choice: "off", cleanup: "none" });
    const state = await loadEditorState(env, user.id);
    // The paused rule reads as "off" in the state; the pause row decides.
    expect(state.rules.map(({ rule: stored }) => stored.enabled)).toEqual([false]);
    const on = rows[1]?.createdAt ?? "";
    const kept = text.fromKept(what["title-open"], clock(on), "other");
    const all = await userActivityPage(env.DB, user.id, {});
    const shown = lines(all.rows, state).join("\n");
    expect(shown).toContain(kept);
    expect(shown).not.toContain("ended later");
    // The older page holds the turn on; the pause is a context row of it.
    const first = await userActivityPage(env.DB, user.id, {}, 1);
    const older = await userActivityPage(env.DB, user.id, { before: first.older ?? 0 }, 2);
    expect(older.rows.filter((row) => row.context).map((row) => row.kind)).toEqual(["rule_paused"]);
    expect(lines(older.rows, state).join("\n")).toContain(kept);
  });
});

describe("round 5: the copies of a kept pause", () => {
  async function keptPause(prefix: string) {
    const ids = await setup(prefix);
    await post("/rules", ids.cookie, {
      source: `${ids.w}-cal`,
      target: `${ids.o}-cal`,
      detailLevel: "title",
    });
    const rule = await env.DB.prepare("SELECT id FROM rules WHERE user_id = ?")
      .bind(ids.user.id)
      .first<{ id: string }>();
    await post(`/rules/${rule?.id}/enable`, ids.cookie);
    await post(`/rules/${rule?.id}/pause`, ids.cookie);
    return { ...ids, ruleId: rule?.id ?? "" };
  }

  /** The window from the turn on until the newest row, and the page's lines. */
  async function after(userId: string) {
    const rows = await ruleRows(userId);
    const state = await loadEditorState(env, userId);
    const page = await userActivityPage(env.DB, userId, {});
    const shown = lines(page.rows, state).join("\n");
    const on = rows[1]?.createdAt ?? "";
    const end = rows.at(-1)?.createdAt ?? "";
    return { rows, shown, on, end };
  }

  const left = t.next.describe.changes.copiesLeft("other");

  it("ends the window when the source calendar goes and the copies get their removal", async () => {
    const { user, w } = await keptPause("kp-src");
    await setSourceCalendar(env, user, `${w}-cal`, false);
    const { rows, shown, on } = await after(user.id);
    expect(rows.at(-1)).toMatchObject({ kind: "rule_updated" });
    expect(rows.at(-1)?.parsed).toEqual({
      choice: "off",
      previousChoice: "off",
      cleanup: "queued",
      fromAccount: w,
    });
    expect(shown).not.toContain(left);
    expect(shown).not.toContain(text.fromKept(what["title-open"], clock(on), "other"));
  });

  it("ends the window when the account goes and the copies get their removal", async () => {
    const { user, w, o } = await keptPause("kp-dis");
    await removeAccounts(env, user, [o]);
    const { rows, shown, on } = await after(user.id);
    expect(rows.at(-1)?.parsed).toEqual({
      cleanup: "queued",
      accountRemoved: true,
      fromAccount: w,
      previousChoice: "off",
    });
    expect(shown).not.toContain(left);
    expect(shown).not.toContain(text.fromKept(what["title-open"], clock(on), "other"));
  });

  it("drops the copies sentence after a turn on again", async () => {
    const { user, cookie, ruleId } = await keptPause("kp-on");
    await post(`/rules/${ruleId}/enable`, cookie);
    const { shown } = await after(user.id);
    expect(shown).not.toContain(left);
  });

  it("drops the copies sentence after a turn off with a queued removal", async () => {
    const { user, w, o } = await keptPause("kp-off");
    await setDirections(env, user, [{ from: w, to: o, choice: "off" }]);
    const { shown } = await after(user.id);
    expect(shown).not.toContain(left);
    const now = Date.now();
    const changes = await recentChanges(env.DB, user.id, now);
    const [entry] = changeEntries(changes.rows, await loadEditorState(env, user.id), t, clock, now);
    expect(entry?.details).not.toContain(left);
    expect(entry?.text ?? "").not.toContain(left);
  });

  it("keeps the copies sentence while the kept pause is the newest step", async () => {
    const { user } = await keptPause("kp-still");
    const { shown } = await after(user.id);
    expect(shown).toContain(left);
  });
});

describe("the org view", () => {
  it("gives another user's rows no account ID and no calendar label", async () => {
    const a = await setup("org3-a");
    const b = await setup("org3-b");
    await setDirections(env, b.user, [{ from: b.w, to: b.o, choice: "title", markPrivate: false }]);
    await removeAccounts(env, b.user, [b.o]);
    await setDirections(env, a.user, [{ from: a.w, to: a.o, choice: "title", markPrivate: false }]);
    const page = await orgActivityPage(env.DB, a.user.orgId, {}, 200, a.user.id);
    const other = page.rows.filter((row) => row.email === b.user.email);
    const mine = page.rows.filter((row) => row.email === a.user.email);
    expect(other.length).toBeGreaterThan(0);
    for (const row of other) expect(row.accountId).toBeNull();
    expect(mine.every((row) => row.accountId === a.o)).toBe(true);
    const state = await loadEditorState(env, a.user.id);
    const shown = lines(page.rows, state).join("\n");
    expect(shown).not.toContain(t.next.describe.activity.goneCalendar);
    expect(shown.toLowerCase()).not.toContain(t.next.describe.activity.goneCalendar.toLowerCase());
  });
});
