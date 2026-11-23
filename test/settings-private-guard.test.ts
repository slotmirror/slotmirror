import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadEditorState, setDirection, setSettings } from "../src/editor";
import { BASE, signIn } from "./helpers";

/** "Today" lies far in the future, so that no alarm fires while a test runs. */
const NOW = new Date("2036-10-22T10:00:00Z");

const SETTINGS = {
  skipAllDay: false,
  skipTentative: false,
  markPrivate: false,
  blockTitle: "Busy",
  skipCategories: [] as string[],
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/**
 * One user with four accounts and their main calendars, and two rules into the last account: one
 * marked private, one open. Rules can have different marks, for example after a rollback from a
 * version with a mark per direction, or from the form that adds one rule.
 */
async function setup(prefix: string) {
  const { user, cookie } = await signIn(`${prefix}@org.example`);
  const ids = ["a", "b", "c", "t"].map((name) => `${prefix}-${name}`);
  await env.DB.batch([
    ...ids.map((id) =>
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, 'microsoft', ?)",
      ).bind(id, user.id, `${id}@work.example`),
    ),
    ...ids.map((id) =>
      env.DB.prepare(
        `INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source)
         VALUES (?, ?, ?, 'Main', 1, 1, 1)`,
      ).bind(`${id}-cal`, id, `remote-${id}`),
    ),
  ]);
  const [a, b, c, t] = ids as [string, string, string, string];
  const rule = (id: string, source: string, markPrivate: boolean) =>
    env.DB.prepare(
      `INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options, enabled)
       VALUES (?, ?, ?, ?, ?, 1)`,
    ).bind(
      id,
      user.id,
      `${source}-cal`,
      `${t}-cal`,
      JSON.stringify({ daysAhead: 90, markPrivate, blockTitle: "Busy" }),
    );
  await env.DB.batch([rule(`${prefix}-private`, a, true), rule(`${prefix}-open`, b, false)]);
  return { user, cookie, a, b, c, t, privateRule: `${prefix}-private`, openRule: `${prefix}-open` };
}

async function marksOf(userId: string): Promise<Record<string, unknown>> {
  const { results } = await env.DB.prepare(
    "SELECT id, json_extract(options, '$.markPrivate') AS mark FROM rules WHERE user_id = ?",
  )
    .bind(userId)
    .all<{ id: string; mark: number | null }>();
  return Object.fromEntries(results.map((row) => [row.id, row.mark === 1]));
}

describe("the private switch in a settings save", () => {
  it("off: no rule loses its private mark", async () => {
    const { user, privateRule, openRule } = await setup("pgoff");
    await setSettings(env, user, { ...SETTINGS, markPrivate: false });
    expect(await marksOf(user.id)).toEqual({ [privateRule]: true, [openRule]: false });
  });

  it("on: every rule becomes private, because the switch can only narrow", async () => {
    const { user, privateRule, openRule } = await setup("pgon");
    await setSettings(env, user, { ...SETTINGS, markPrivate: true });
    expect(await marksOf(user.id)).toEqual({ [privateRule]: true, [openRule]: true });
  });

  it("sets the default for new directions in both directions of the switch", async () => {
    const { user, a, b, c, t, privateRule, openRule } = await setup("pgdefault");
    const shownDefault = async () => (await loadEditorState(env, user.id)).settings.markPrivate;
    // "Off" without a marker keeps the default too: it is no sign to open anything.
    await setSettings(env, user, { ...SETTINGS, markPrivate: false });
    expect(await shownDefault()).toBe(true);
    // "Off" with the marker of a switch shown on sets only the default.
    await setSettings(env, user, { ...SETTINGS, markPrivate: false, markPrivateShown: true });
    expect(await shownDefault()).toBe(false);
    expect(await marksOf(user.id)).toEqual({ [privateRule]: true, [openRule]: false });
    await setDirection(env, user, c, t, "busy");
    await setSettings(env, user, { ...SETTINGS, markPrivate: true });
    expect(await shownDefault()).toBe(true);
    await setDirection(env, user, a, b, "busy");
    const mark = (source: string, target: string) =>
      env.DB.prepare(
        `SELECT json_extract(options, '$.markPrivate') AS mark FROM rules
         WHERE source_calendar_id = ? AND target_calendar_id = ?`,
      )
        .bind(`${source}-cal`, `${target}-cal`)
        .first<number>("mark");
    // The direction added while the switch was off became private with the second save.
    expect(await mark(c, t)).toBe(1);
    expect(await mark(a, b)).toBe(1);
    // "Open" for new mirrorings, the answer of the new panel, also sets only the default.
    await setSettings(env, user, { ...SETTINGS, newWho: "open" });
    expect(await shownDefault()).toBe(false);
    await setDirection(env, user, b, a, "busy");
    expect(await mark(b, a)).toBe(0);
    expect(await mark(a, b)).toBe(1);
    expect(await mark(c, t)).toBe(1);
  });

  it("a save of other settings with the switch off keeps every mark", async () => {
    const { user, privateRule, openRule } = await setup("pgother");
    await setSettings(env, user, {
      ...SETTINGS,
      daysAhead: 30,
      daysAheadShown: 90,
      blockTitle: "Occupied",
    });
    expect(await marksOf(user.id)).toEqual({ [privateRule]: true, [openRule]: false });
    const { results } = await env.DB.prepare("SELECT options FROM rules WHERE user_id = ?")
      .bind(user.id)
      .all<{ options: string }>();
    for (const row of results) {
      expect(JSON.parse(row.options)).toMatchObject({ daysAhead: 30, blockTitle: "Occupied" });
    }
  });

  it("the old settings form without the checkbox keeps every mark", async () => {
    const { user, cookie, privateRule, openRule } = await setup("pgform");
    for (const [path, body] of [
      ["/rules/settings", { daysAhead: "90", daysAheadShown: "90", blockTitle: "Busy" }],
      ["/rules/choices", { settings: "1", "settings.daysAhead": "90" }],
    ] as const) {
      const response = await exports.default.fetch(`${BASE}${path}`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie, "x-fragment": "1", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body),
      });
      expect(response.status).toBeLessThan(400);
      expect(await marksOf(user.id)).toEqual({ [privateRule]: true, [openRule]: false });
    }
    // Without the checkbox the default stays as it was: the schema default, private.
    expect((await loadEditorState(env, user.id)).settings.markPrivate).toBe(true);
  });
});
