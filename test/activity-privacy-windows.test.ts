import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { orgActivityPage, recentChanges, userActivityPage, type ActivityRow } from "../src/audit";
import { loadEditorState, setDirections, setSettings, setSourceCalendar } from "../src/editor";
import { i18nFor } from "../src/i18n";
import { activityFilter } from "../src/next-activity";
import { groupActivity } from "../src/pages/next/activity";
import {
  changeEntries,
  clockFor,
  describeChanges,
  exposureText,
  type OpenLevel,
} from "../src/pages/next/describe";
import { BASE, signIn } from "./helpers";

// The cases of the cold privacy review of 2026-11-21 on Activity and the Overview's change feed:
// no change that let others see more may disappear from them.

const i18n = i18nFor("en", "UTC");
const { t } = i18n;
const clock = clockFor(i18n);
const what = t.next.describe.changes.exposure.what;
const HOUR = 3_600_000;

/** A user with the accounts `w` and `o`, each with a main calendar that is a source. */
async function setup(prefix: string) {
  const { user, cookie } = await signIn(`${prefix}@org.example`);
  const accounts = [
    [`${prefix}-w`, `${prefix}@work.example`],
    [`${prefix}-o`, `${prefix}@other.example`],
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

/** Give the user's audit rows these times, oldest row first. Returns the times. */
async function retime(userId: string, times: number[]): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT id FROM audit_events WHERE user_id = ? ORDER BY id",
  )
    .bind(userId)
    .all<{ id: number }>();
  expect(results).toHaveLength(times.length);
  const iso = times.map((time) => new Date(time).toISOString());
  await env.DB.batch(
    results.map((row, index) =>
      env.DB.prepare("UPDATE audit_events SET created_at = ? WHERE id = ?").bind(
        iso[index],
        row.id,
      ),
    ),
  );
  return iso;
}

/** The rule rows of a user, oldest first, with their parsed detail. */
async function ruleRows(userId: string) {
  const { results } = await env.DB.prepare(
    "SELECT kind, rule_id AS ruleId, detail FROM audit_events WHERE user_id = ? ORDER BY id",
  )
    .bind(userId)
    .all<{ kind: string; ruleId: string; detail: string }>();
  return results.map((row) => ({ ...row, detail: JSON.parse(row.detail) as object }));
}

function lines(
  rows: ActivityRow[],
  state: Parameters<typeof groupActivity>[1],
  mirroring?: string,
) {
  return groupActivity(rows, state, i18n, Date.now(), mirroring).flatMap((day) =>
    day.items.map((item) => ({
      title: item.described.title,
      detail: item.described.detail,
      route: item.described.route
        ? `${item.described.route.from.id}~${item.described.route.to.id}`
        : null,
    })),
  );
}

/** A window as the Overview words it at `now`: a time of another day names that day. */
const seen = (now: number, level: OpenLevel, from: string | undefined, until?: string) =>
  exposureText({ level, from, until }, t, clock, now);

const window = (level: OpenLevel, from: string | undefined, until?: string) =>
  exposureText({ level, from, until }, t, clock);

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

describe("a window that a turn off ended", () => {
  it("names the source account on every row of the rule, so the rows keep their mirroring", async () => {
    const { user, w, o } = await setup("win-off");
    await setDirections(env, user, [{ from: w, to: o, choice: "busy", markPrivate: true }]);
    await setDirections(env, user, [{ from: w, to: o, choice: "full", markPrivate: false }]);
    await setDirections(env, user, [{ from: w, to: o, choice: "off" }]);
    const rows = await ruleRows(user.id);
    expect(rows.map((row) => row.kind)).toEqual(["rule_created", "rule_updated", "rule_deleted"]);
    for (const row of rows) expect(row.detail).toMatchObject({ fromAccount: w });
    expect(JSON.stringify(rows)).not.toMatch(/@/);
  });

  it("shows the window with its end in Activity and the Overview, under the mirroring", async () => {
    const { user, w, o } = await setup("win-show");
    await setDirections(env, user, [{ from: w, to: o, choice: "busy", markPrivate: true }]);
    await setDirections(env, user, [{ from: w, to: o, choice: "full", markPrivate: false }]);
    await setDirections(env, user, [{ from: w, to: o, choice: "off" }]);
    const now = Date.now();
    const [, widened, off] = await retime(user.id, [now - 3 * HOUR, now - 2 * HOUR, now - HOUR]);
    const state = await loadEditorState(env, user.id);
    const page = await userActivityPage(env.DB, user.id, {});
    const shown = lines(page.rows, state);
    const expected = window("full-open", widened, off);
    expect(shown.every((line) => line.route === `${w}~${o}` && line.detail !== "")).toBe(true);
    expect(shown.map((line) => line.detail).join("\n")).toContain(expected);

    const changes = await recentChanges(env.DB, user.id, now);
    const entries = changeEntries(changes.rows, state, t, clock, now);
    expect(entries.map((entry) => entry.key)).toEqual([`m:${w}~${o}`]);
    expect(entries[0]?.exposures).toEqual([seen(now, "full-open", widened, off)]);
  });

  it("finds the rows of a rule that is gone through the mirroring filter", async () => {
    const { user, w, o } = await setup("win-filter");
    await setDirections(env, user, [{ from: w, to: o, choice: "busy", markPrivate: true }]);
    await setDirections(env, user, [{ from: w, to: o, choice: "title", markPrivate: false }]);
    await setDirections(env, user, [{ from: w, to: o, choice: "off" }]);
    await setDirections(env, user, [{ from: w, to: o, choice: "busy", markPrivate: true }]);
    const now = Date.now();
    const [, widened, off] = await retime(user.id, [
      now - 4 * HOUR,
      now - 3 * HOUR,
      now - 2 * HOUR,
      now - HOUR,
    ]);
    const state = await loadEditorState(env, user.id);
    const filter = activityFilter(state, { d: `${w}~${o}` });
    const page = await userActivityPage(env.DB, user.id, filter);
    expect(page.rows).toHaveLength(4);
    const shown = lines(page.rows, state, `${w}~${o}`);
    expect(shown.map((line) => line.detail).join("\n")).toContain(
      window("title-open", widened, off),
    );
    // The calendar filter of the source finds them too.
    const bySource = await userActivityPage(env.DB, user.id, activityFilter(state, { c: w }));
    expect(bySource.rows).toHaveLength(4);
  });

  it("ends the window of a rule whose source calendar was turned off", async () => {
    const { user, w, o } = await setup("win-src");
    await env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, 'second-remote', 'Second', 1, 0, 0)",
    )
      .bind(`${w}-second`, w)
      .run();
    await setDirections(env, user, [{ from: w, to: o, choice: "title", markPrivate: false }]);
    await setSourceCalendar(env, user, `${w}-second`, true);
    await setSourceCalendar(env, user, `${w}-second`, false);
    const rows = await ruleRows(user.id);
    expect(rows.map((row) => row.kind)).toEqual(["rule_created", "rule_created", "rule_deleted"]);
    // The copy records the mark it got from the mirroring, and the deletion the level it had.
    expect(rows[1]?.detail).toEqual({ choice: "title", markPrivate: false, fromAccount: w });
    expect(rows[2]?.detail).toEqual({
      cleanup: "queued",
      fromAccount: w,
      previousChoice: "title",
      previousMarkPrivate: false,
    });
    const now = Date.now();
    const [first, copied, removed] = await retime(user.id, [
      now - 3 * HOUR,
      now - 2 * HOUR,
      now - HOUR,
    ]);
    const state = await loadEditorState(env, user.id);
    const page = await userActivityPage(env.DB, user.id, {});
    const shown = lines(page.rows, state)
      .map((line) => line.detail)
      .join("\n");
    expect(shown).toContain(window("title-open", copied, removed));

    const changes = await recentChanges(env.DB, user.id, now);
    const [entry] = changeEntries(changes.rows, state, t, clock, now);
    expect(entry?.exposures).toEqual([
      seen(now, "title-open", first),
      seen(now, "title-open", copied, removed),
    ]);
  });
});

describe("a rule created without a recorded mark", () => {
  it("counts as open, so an unknown never hides a widening", () => {
    const row: ActivityRow = {
      id: 1,
      kind: "rule_created",
      detail: JSON.stringify({ choice: "title" }),
      createdAt: "2026-11-20T10:00:00.000Z",
      email: null,
      accountEmail: null,
      ruleId: "r1",
    };
    expect(describeChanges([row], t, clock)).toContain(what["title-open"]);
  });
});

describe("a window in words", () => {
  it("reads the same clock minute on another day as a range with the date of its end", () => {
    const from = "2026-11-19T14:04:10.000Z";
    const until = "2026-11-21T14:04:50.000Z";
    expect(window("title-open", from, until)).toBe(`${what["title-open"]} 14:04 – Nov 21, 14:04`);
    expect(window("title-open", from, "2026-11-19T14:04:50.000Z")).toBe(
      `${what["title-open"]} at 14:04`,
    );
  });
});

describe("For all mirrorings", () => {
  it("leaves a window per mirroring when the copies become visible to others", async () => {
    const { user, w, o } = await setup("win-all");
    await setDirections(env, user, [
      { from: w, to: o, choice: "busy", markPrivate: true },
      { from: o, to: w, choice: "busy", markPrivate: true },
    ]);
    const before = await loadEditorState(env, user.id);
    const { blockTitleStored: _stored, ...settings } = before.settings;
    await setSettings(env, user, { ...settings, newWho: "open", applyWho: true });
    const rows = (await ruleRows(user.id)).filter((row) => row.kind === "rule_updated");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.detail).toEqual({
        choice: "busy",
        markPrivate: false,
        previousChoice: "busy",
        previousMarkPrivate: true,
        fromAccount: expect.stringMatching(/^win-all-[wo]$/),
      });
    }
    const now = Date.now();
    const times = await retime(user.id, [
      now - 3 * HOUR,
      now - 3 * HOUR,
      now - HOUR,
      now - HOUR,
      now - HOUR,
    ]);
    const state = await loadEditorState(env, user.id);
    const changes = await recentChanges(env.DB, user.id, now);
    const entries = changeEntries(changes.rows, state, t, clock, now);
    const opened = seen(now, "busy-open", times[2]);
    for (const key of [`m:${w}~${o}`, `m:${o}~${w}`]) {
      expect(entries.find((entry) => entry.key === key)?.exposures).toEqual([opened]);
    }
    const page = await userActivityPage(env.DB, user.id, {});
    const shown = lines(page.rows, state)
      .map((line) => line.detail)
      .join("\n");
    expect(shown).toContain(opened);
  });
});

describe("the old rules page", () => {
  it("records the level on create and on each turn on or pause, so its windows show", async () => {
    const { user, cookie, w, o } = await setup("win-old");
    await post("/rules", cookie, { source: `${w}-cal`, target: `${o}-cal`, detailLevel: "title" });
    const rule = await env.DB.prepare("SELECT id FROM rules WHERE user_id = ?")
      .bind(user.id)
      .first<{ id: string }>();
    await post(`/rules/${rule?.id}/enable`, cookie);
    await post(`/rules/${rule?.id}/pause`, cookie);
    await post(`/rules/${rule?.id}/enable`, cookie);
    const rows = await ruleRows(user.id);
    expect(rows.map((row) => [row.kind, row.detail])).toEqual([
      [
        "rule_created",
        {
          detailLevel: "title",
          daysAhead: 60,
          choice: "off",
          markPrivate: false,
          fromAccount: w,
        },
      ],
      [
        "rule_enabled",
        { choice: "title", markPrivate: false, previousChoice: "off", fromAccount: w },
      ],
      [
        "rule_paused",
        {
          choice: "off",
          previousChoice: "title",
          previousMarkPrivate: false,
          fromAccount: w,
          cleanup: "none",
        },
      ],
      [
        "rule_enabled",
        { choice: "title", markPrivate: false, previousChoice: "off", fromAccount: w },
      ],
    ]);
    const now = Date.now();
    const [, on] = await retime(user.id, [
      now - 4 * HOUR,
      now - 3 * HOUR,
      now - 2 * HOUR,
      now - HOUR,
    ]);
    const state = await loadEditorState(env, user.id);
    const changes = await recentChanges(env.DB, user.id, now);
    // The pause queued no removal: the copies kept showing, so the window runs on from the first
    // turn on, and the turn on again does not cancel it out.
    const [entry] = changeEntries(changes.rows, state, t, clock, now);
    expect(entry?.exposures).toEqual([seen(now, "title-open", on)]);
    const page = await userActivityPage(env.DB, user.id, {});
    const shown = lines(page.rows, state)
      .map((line) => line.detail)
      .join("\n");
    expect(shown).toContain(window("title-open", on));
  });
});

describe("a window across the edge of the data", () => {
  it("shows the end on the older page when a newer page holds it", async () => {
    const { user, w, o } = await setup("win-edge");
    await setDirections(env, user, [{ from: w, to: o, choice: "busy", markPrivate: true }]);
    await setDirections(env, user, [{ from: w, to: o, choice: "full", markPrivate: false }]);
    await setDirections(env, user, [{ from: w, to: o, choice: "off" }]);
    const now = Date.now();
    const [, widened, off] = await retime(user.id, [now - 3 * HOUR, now - 2 * HOUR, now - HOUR]);
    const state = await loadEditorState(env, user.id);
    const first = await userActivityPage(env.DB, user.id, {}, 1);
    expect(first.older).not.toBeNull();
    const second = await userActivityPage(env.DB, user.id, { before: first.older ?? 0 }, 1);
    const shown = lines(second.rows, state);
    // Only the page's own row shows; the newer row gives it its end.
    expect(shown).toHaveLength(1);
    expect(shown[0]?.detail).toContain(window("full-open", widened, off));
  });

  it("shows the end on an older day of the same page", async () => {
    const { user, w, o } = await setup("win-day");
    await setDirections(env, user, [{ from: w, to: o, choice: "busy", markPrivate: true }]);
    await setDirections(env, user, [{ from: w, to: o, choice: "full", markPrivate: false }]);
    await setDirections(env, user, [{ from: w, to: o, choice: "off" }]);
    const now = Date.now();
    const [, widened, off] = await retime(user.id, [
      now - 50 * HOUR,
      now - 49 * HOUR,
      now - 1.5 * HOUR,
    ]);
    const state = await loadEditorState(env, user.id);
    const page = await userActivityPage(env.DB, user.id, {});
    const shown = lines(page.rows, state).map((line) => line.detail);
    expect(shown.join("\n")).toContain(window("full-open", widened, off));
    expect(shown.join("\n")).not.toContain(window("full-open", widened));
  });

  it("names in the Overview a window that began before its 24 hours and ended in them", async () => {
    const { user, w, o } = await setup("win-24h");
    await setDirections(env, user, [{ from: w, to: o, choice: "busy", markPrivate: true }]);
    await setDirections(env, user, [{ from: w, to: o, choice: "full", markPrivate: false }]);
    await setDirections(env, user, [{ from: w, to: o, choice: "off" }]);
    const now = Date.now();
    const [, , off] = await retime(user.id, [now - 31 * HOUR, now - 30 * HOUR, now - 2 * HOUR]);
    const state = await loadEditorState(env, user.id);
    const changes = await recentChanges(env.DB, user.id, now);
    expect(changes.rows).toHaveLength(1);
    const [entry] = changeEntries(changes.rows, state, t, clock, now);
    expect(entry?.exposures).toEqual([seen(now, "full-open", undefined, off)]);
    expect(entry?.text).toContain(`${what["full-open"]} until`);
  });
});

describe("the org view", () => {
  it("names the calendar and the rule on the viewer's rows only", async () => {
    const a = await setup("org-a");
    const b = await setup("org-b");
    await setDirections(env, a.user, [{ from: a.w, to: a.o, choice: "title", markPrivate: false }]);
    await setDirections(env, b.user, [{ from: b.w, to: b.o, choice: "title", markPrivate: false }]);
    const page = await orgActivityPage(env.DB, a.user.orgId, {}, 200, a.user.id);
    const mine = page.rows.filter((row) => row.email === a.user.email);
    const other = page.rows.filter((row) => row.email === b.user.email);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.accountEmail).toBe("org-a@other.example");
    expect(mine[0]?.ruleId).toEqual(expect.any(String));
    expect(other).toHaveLength(1);
    expect(other[0]?.accountEmail).toBeNull();
    expect(other[0]?.ruleId).toBeNull();
  });
});
