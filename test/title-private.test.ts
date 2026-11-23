import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  directionMarksPrivate,
  levelOf,
  loadEditorState,
  parseLevel,
  resetDirection,
  setDirection,
  setDirections,
  setGroupMembership,
} from "../src/editor";
import { directionLevel, marksPrivate } from "../src/pages/next/levels";
import { BASE, signIn } from "./helpers";

/** A user with three accounts, each with one main calendar and stored tokens. */
async function setup(prefix: string) {
  const { user, cookie } = await signIn(`${prefix}@org.example`);
  const accounts = [
    [`${prefix}-w`, `${prefix}@work.example`, "microsoft"],
    [`${prefix}-o`, `${prefix}@other.example`, "microsoft"],
    [`${prefix}-g`, `${prefix}@gmail.com`, "google"],
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
  const [w, o, g] = accounts.map(([id]) => id);
  return { user, cookie, w: w!, o: o!, g: g! };
}

/** Detail level and private mark of every rule, keyed "source>target". */
async function marksOf(userId: string) {
  const { results } = await env.DB.prepare(
    `SELECT sc.account_id AS source, tc.account_id AS target, r.origin,
            json_extract(r.options, '$.detailLevel') AS level,
            json_extract(r.options, '$.markPrivate') AS markPrivate
     FROM rules r JOIN calendars sc ON sc.id = r.source_calendar_id
     JOIN calendars tc ON tc.id = r.target_calendar_id
     WHERE r.user_id = ? AND r.enabled = 1`,
  )
    .bind(userId)
    .all<{ source: string; target: string; origin: string; level: string; markPrivate: number }>();
  return Object.fromEntries(
    results.map((row) => [
      `${row.source}>${row.target}`,
      { level: row.level, markPrivate: row.markPrivate === 1, origin: row.origin },
    ]),
  );
}

function post(path: string, cookie: string, fields: Record<string, string>, fragment = true) {
  return exports.default.fetch(`${BASE}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie,
      "content-type": "application/x-www-form-urlencoded",
      ...(fragment ? { "x-fragment": "1" } : {}),
    },
    body: new URLSearchParams(fields),
  });
}

/** The settings form as the page sends it, with the private switch it showed. */
function settingsFields(markPrivate: boolean, shown?: boolean): Record<string, string> {
  return {
    settings: "1",
    "settings.daysAhead": "30",
    "settings.daysAheadShown": "30",
    "settings.skipAllDayShown": "0",
    ...(markPrivate ? { "settings.markPrivate": "on" } : {}),
    ...(shown === undefined ? {} : { "settings.markPrivateShown": shown ? "1" : "0" }),
  };
}

/** Record the level and mark of one direction after every write batch of the code under test. */
function watchDirection(userId: string, key: string) {
  const seen: { level: string; markPrivate: boolean }[] = [];
  const batch = env.DB.batch.bind(env.DB);
  vi.spyOn(env.DB, "batch").mockImplementation(async (statements) => {
    const results = await batch(statements);
    const mark = (await marksOf(userId))[key];
    if (mark) seen.push({ level: mark.level, markPrivate: mark.markPrivate });
    return results;
  });
  return seen;
}

beforeEach(() => {
  // Removing blocks reads the target calendar; it is empty in these tests.
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

/** Store the default for new mirrorings ("who sees it, by default"). */
async function setStoredDefault(userId: string, markPrivate: boolean): Promise<void> {
  await env.DB.prepare(
    "UPDATE users SET sync_settings = json_set(sync_settings, '$.markPrivate', json(?)) WHERE id = ?",
  )
    .bind(markPrivate ? "true" : "false", userId)
    .run();
}

/** Every rule of a user with its mark, enabled or not, keyed "source>target" calendar. */
async function ruleMarks(userId: string) {
  const { results } = await env.DB.prepare(
    `SELECT source_calendar_id AS source, target_calendar_id AS target, enabled,
            json_extract(options, '$.detailLevel') AS level,
            json_extract(options, '$.markPrivate') AS mark
     FROM rules WHERE user_id = ?`,
  )
    .bind(userId)
    .all<{ source: string; target: string; enabled: number; level: string; mark: number }>();
  return Object.fromEntries(
    results.map((row) => [
      `${row.source}>${row.target}`,
      { level: row.level, markPrivate: row.mark === 1, enabled: row.enabled === 1 },
    ]),
  );
}

describe("levels", () => {
  it("reads a detail level with or without the private mark", () => {
    expect(parseLevel("off")).toEqual({ choice: "off" });
    expect(parseLevel("busy")).toEqual({ choice: "busy" });
    expect(parseLevel("title")).toEqual({ choice: "title" });
    expect(parseLevel("busy-private")).toEqual({ choice: "busy", markPrivate: true });
    expect(parseLevel("busy-open")).toEqual({ choice: "busy", markPrivate: false });
    expect(parseLevel("title-private")).toEqual({ choice: "title", markPrivate: true });
    expect(parseLevel("title-open")).toEqual({ choice: "title", markPrivate: false });
    expect(parseLevel("full-private")).toEqual({ choice: "full", markPrivate: true });
    expect(parseLevel("full-open")).toEqual({ choice: "full", markPrivate: false });
  });

  it("refuses a private mark on off, and unknown words", () => {
    for (const value of [
      "off-open",
      "off-private",
      "busy-",
      "title-",
      "private",
      "",
      "TITLE-OPEN",
      "busy-open-x",
    ]) {
      expect(parseLevel(value), value).toBeNull();
    }
  });

  it("names the busy pair from the mark, and off without one", () => {
    expect(levelOf("busy", true)).toBe("busy-private");
    expect(levelOf("busy", false)).toBe("busy-open");
    expect(levelOf("off", true)).toBe("off");
    expect(levelOf("off", false)).toBe("off");
    expect(levelOf("title", false)).toBe("title-open");
    expect(levelOf("full", true)).toBe("full-private");
  });
});

describe("busy with a mark", () => {
  it("stores busy + everyone as busy without the mark, and records the mark", async () => {
    const { user, w, g } = await setup("bsopen");
    await setDirections(env, user, [{ from: w, to: g, choice: "busy", markPrivate: false }]);
    expect((await marksOf(user.id))[`${w}>${g}`]).toMatchObject({
      level: "busy",
      markPrivate: false,
    });
    const audit = await env.DB.prepare(
      "SELECT detail FROM audit_events WHERE user_id = ? AND kind = 'rule_created'",
    )
      .bind(user.id)
      .all<{ detail: string }>();
    expect(audit.results.map((row) => JSON.parse(row.detail))).toEqual([
      { choice: "busy", markPrivate: false, fromAccount: w },
    ]);
  });

  it("keeps the mark of a copied direction for a bare busy", async () => {
    const { user, w, g } = await setup("bskeep");
    await setDirections(env, user, [{ from: w, to: g, choice: "title", markPrivate: false }]);
    await setDirection(env, user, w, g, "busy");
    expect((await marksOf(user.id))[`${w}>${g}`]).toMatchObject({
      level: "busy",
      markPrivate: false,
    });
  });

  it("gives a bare busy the default of the user when the direction is off", async () => {
    const { user, w, o, g } = await setup("bsdefault");
    await setStoredDefault(user.id, false);
    await setDirection(env, user, w, g, "busy");
    await setStoredDefault(user.id, true);
    await setDirection(env, user, o, g, "busy");
    const marks = await marksOf(user.id);
    expect(marks[`${w}>${g}`]).toMatchObject({ level: "busy", markPrivate: false });
    expect(marks[`${o}>${g}`]).toMatchObject({ level: "busy", markPrivate: true });
  });

  // Failure mode 9: a disabled exception keeps the mark it had when it was turned off.
  it("ignores the stale mark of a disabled exception when a bare busy turns it on", async () => {
    const { user, w, o, g } = await setup("bsstale");
    for (const id of [w, o, g]) await setGroupMembership(env, user, id, true);
    // Turned off while the default was private; then the default changed to everyone.
    await setDirection(env, user, w, g, "off");
    expect((await ruleMarks(user.id))[`${w}-cal>${g}-cal`]).toMatchObject({
      enabled: false,
      markPrivate: true,
    });
    await setStoredDefault(user.id, false);
    await setDirection(env, user, w, g, "busy");
    expect((await marksOf(user.id))[`${w}>${g}`]).toMatchObject({
      level: "busy",
      markPrivate: false,
    });
    // And the other way round: off while open, then the default became private.
    await setDirections(env, user, [{ from: o, to: g, choice: "busy", markPrivate: false }]);
    await setDirection(env, user, o, g, "off");
    expect((await ruleMarks(user.id))[`${o}-cal>${g}-cal`]).toMatchObject({
      enabled: false,
      markPrivate: false,
    });
    await setStoredDefault(user.id, true);
    await setDirection(env, user, o, g, "busy");
    expect((await marksOf(user.id))[`${o}>${g}`]).toMatchObject({
      level: "busy",
      markPrivate: true,
    });
  });

  it("treats a capped request as bare, but never makes it more visible than asked", async () => {
    const { user, w } = await setup("bscap");
    // MAX_DETAIL_FROM_EXTERNAL is "busy" in the test bindings; this target belongs to the org.
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, provider, email) VALUES ('bscap-i', ?, 'microsoft', 'bscap@org.example')",
      ).bind(user.id),
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES ('bscap-i-cal', 'bscap-i', 'bscap-i-remote', 'Main', 1, 1, 1)",
      ),
    ]);
    await setDirections(env, user, [
      { from: w, to: "bscap-i", choice: "busy", markPrivate: false },
    ]);
    // Bare: an open request lowered by the cap keeps the open mark of the copied direction.
    await setDirections(env, user, [
      { from: w, to: "bscap-i", choice: "full", markPrivate: false },
    ]);
    expect((await marksOf(user.id))[`${w}>bscap-i`]).toMatchObject({
      level: "busy",
      markPrivate: false,
    });
    // A private request lowered by the cap still makes the copies private.
    await setDirections(env, user, [
      { from: w, to: "bscap-i", choice: "title", markPrivate: true },
    ]);
    expect((await marksOf(user.id))[`${w}>bscap-i`]).toMatchObject({
      level: "busy",
      markPrivate: true,
    });
  });
});

describe("mark of a mirroring with several source calendars", () => {
  /** Directions from w have two rules: the main calendar and a second source calendar. */
  async function twoSources(prefix: string) {
    const context = await setup(prefix);
    await env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, ?, 'Second', 1, 0, 1)",
    )
      .bind(`${context.w}-second`, context.w, `${context.w}-second-remote`)
      .run();
    return context;
  }

  async function openOne(userId: string, source: string, target: string) {
    await env.DB.prepare(
      `UPDATE rules SET options = json_set(options, '$.markPrivate', json('false'))
       WHERE user_id = ? AND source_calendar_id = ? AND target_calendar_id = ?`,
    )
      .bind(userId, source, target)
      .run();
  }

  it("is private only if every enabled rule is private", async () => {
    const { user, w, g } = await twoSources("mixmark");
    await setDirections(env, user, [{ from: w, to: g, choice: "busy", markPrivate: true }]);
    const direction = async () => {
      const state = await loadEditorState(env, user.id);
      const found = state.directions.find((d) => d.from === w && d.to === g);
      if (!found) throw new Error("no direction");
      return { state, direction: found };
    };
    let current = await direction();
    expect(current.direction.slots.filter((slot) => slot.rule?.enabled)).toHaveLength(2);
    expect(directionMarksPrivate(current.direction)).toBe(true);
    expect(directionLevel(current.state, current.direction)).toBe("busy-private");
    // The second calendar's rule is open; the first, which `options` comes from, stays private.
    await openOne(user.id, `${w}-second`, `${g}-cal`);
    current = await direction();
    expect(current.direction.options?.markPrivate).toBe(true);
    expect(directionMarksPrivate(current.direction)).toBe(false);
    expect(marksPrivate(current.state, current.direction)).toBe(false);
    expect(directionLevel(current.state, current.direction)).toBe("busy-open");
  });

  it("takes the default when no rule is enabled", async () => {
    const { user, w, g } = await twoSources("mixoff");
    await setStoredDefault(user.id, false);
    const state = await loadEditorState(env, user.id);
    const direction = state.directions.find((d) => d.from === w && d.to === g);
    expect(direction && directionMarksPrivate(direction)).toBeNull();
    expect(direction && marksPrivate(state, direction)).toBe(false);
    expect(direction && directionLevel(state, direction)).toBe("off");
  });

  it("keeps each rule's own mark for a bare choice, so the private rule stays private", async () => {
    const { user, w, g } = await twoSources("mixbare");
    await setDirections(env, user, [{ from: w, to: g, choice: "busy", markPrivate: true }]);
    await openOne(user.id, `${w}-second`, `${g}-cal`);
    await setDirection(env, user, w, g, "title");
    const marks = await ruleMarks(user.id);
    expect(marks[`${w}-cal>${g}-cal`]).toMatchObject({ level: "title", markPrivate: true });
    expect(marks[`${w}-second>${g}-cal`]).toMatchObject({ level: "title", markPrivate: false });
  });

  it("gives every rule the mark of a request that names one", async () => {
    const { user, w, g } = await twoSources("mixset");
    await setDirections(env, user, [{ from: w, to: g, choice: "busy", markPrivate: false }]);
    await setDirections(env, user, [{ from: w, to: g, choice: "busy", markPrivate: true }]);
    const marks = await ruleMarks(user.id);
    expect(marks[`${w}-cal>${g}-cal`]?.markPrivate).toBe(true);
    expect(marks[`${w}-second>${g}-cal`]?.markPrivate).toBe(true);
  });
});

describe("private mark per direction", () => {
  it("writes the level and the mark of a new rule in the same write", async () => {
    const { user, w, g } = await setup("lvnew");
    await setDirections(env, user, [{ from: w, to: g, choice: "title", markPrivate: false }]);
    expect((await marksOf(user.id))[`${w}>${g}`]).toEqual({
      level: "title",
      markPrivate: false,
      origin: "custom",
    });
    const audit = await env.DB.prepare(
      "SELECT detail FROM audit_events WHERE user_id = ? AND kind = 'rule_created'",
    )
      .bind(user.id)
      .all<{ detail: string }>();
    expect(audit.results.map((row) => JSON.parse(row.detail))).toEqual([
      { choice: "title", markPrivate: false, fromAccount: w },
    ]);
  });

  it("changes only the mark of the direction it names", async () => {
    const { user, w, o, g } = await setup("lvone");
    await setDirection(env, user, w, g, "title");
    await setDirection(env, user, o, g, "title");
    await setDirections(env, user, [{ from: w, to: g, choice: "title", markPrivate: false }]);
    const marks = await marksOf(user.id);
    expect(marks[`${w}>${g}`]?.markPrivate).toBe(false);
    expect(marks[`${o}>${g}`]?.markPrivate).toBe(true);
  });

  it("keeps the mark of a direction if a choice comes without one", async () => {
    const { user, w, g } = await setup("lvkeep");
    await setDirections(env, user, [{ from: w, to: g, choice: "title", markPrivate: false }]);
    await setDirection(env, user, w, g, "full");
    expect((await marksOf(user.id))[`${w}>${g}`]).toMatchObject({
      level: "full",
      markPrivate: false,
    });
  });

  it("saves a level from the page save and from the form without the script", async () => {
    const { user, cookie, w, o, g } = await setup("lvroute");
    expect(
      (await post("/rules/choices", cookie, { [`choice.${w}.${g}`]: "title-open" })).status,
    ).toBe(204);
    const form = await post(
      "/rules/direction",
      cookie,
      { from: o, to: g, choice: "full-private" },
      false,
    );
    expect(form.status).toBe(302);
    expect(form.headers.get("location")).toBe(`/rules?open=${g}#dest-${o}-${g}`);
    const marks = await marksOf(user.id);
    expect(marks[`${w}>${g}`]).toMatchObject({ level: "title", markPrivate: false });
    expect(marks[`${o}>${g}`]).toMatchObject({ level: "full", markPrivate: true });
  });

  it("refuses a level that does not exist, before any write", async () => {
    const { user, cookie, w, g } = await setup("lvbad");
    const response = await post("/rules/choices", cookie, { [`choice.${w}.${g}`]: "off-open" });
    expect(response.status).toBe(400);
    expect(await marksOf(user.id)).toEqual({});
  });

  it("makes a group direction with a title an exception, whatever its mark", async () => {
    const { user, w, o, g } = await setup("lvgroup");
    for (const id of [w, o, g]) await setGroupMembership(env, user, id, true);
    await setDirections(env, user, [{ from: w, to: g, choice: "title", markPrivate: true }]);
    const marks = await marksOf(user.id);
    expect(marks[`${w}>${g}`]).toMatchObject({
      level: "title",
      markPrivate: true,
      origin: "custom",
    });
    expect(marks[`${o}>${g}`]).toMatchObject({ level: "busy", origin: "group" });
  });
});

describe("marks a request cannot set", () => {
  it("drops the mark of a level that a cap lowers to busy", async () => {
    const { user, w } = await setup("lvcap");
    // MAX_DETAIL_FROM_EXTERNAL is "busy" in the test bindings; this target belongs to the org.
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, provider, email) VALUES ('lvcap-i', ?, 'microsoft', 'lvcap@org.example')",
      ).bind(user.id),
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES ('lvcap-i-cal', 'lvcap-i', 'lvcap-i-remote', 'Main', 1, 1, 1)",
      ),
    ]);
    await setDirections(env, user, [
      { from: w, to: "lvcap-i", choice: "title", markPrivate: false },
    ]);
    expect((await marksOf(user.id))[`${w}>lvcap-i`]).toMatchObject({
      level: "busy",
      markPrivate: true,
    });
  });

  it("keeps the mark of a copied group direction for a bare busy", async () => {
    const { user, w, o, g } = await setup("lvbusygrp");
    for (const id of [w, o, g]) await setGroupMembership(env, user, id, true);
    await setDirections(env, user, [{ from: w, to: g, choice: "title", markPrivate: false }]);
    await setDirection(env, user, w, g, "busy");
    expect((await marksOf(user.id))[`${w}>${g}`]).toEqual({
      level: "busy",
      markPrivate: false,
      origin: "group",
    });
  });

  it("gives busy outside the group the mark of the settings if it was off, so a later group adopts it", async () => {
    const { user, w, g } = await setup("lvbusyout");
    await setDirection(env, user, w, g, "busy");
    expect((await marksOf(user.id))[`${w}>${g}`]).toMatchObject({
      level: "busy",
      markPrivate: true,
    });
    for (const id of [w, g]) await setGroupMembership(env, user, id, true);
    expect((await marksOf(user.id))[`${w}>${g}`]?.origin).toBe("group");
  });

  it("does not let the group adopt a busy direction whose mark differs from the default", async () => {
    const { user, w, g } = await setup("lvbusyopen");
    await setDirections(env, user, [{ from: w, to: g, choice: "title", markPrivate: false }]);
    await setDirection(env, user, w, g, "busy");
    for (const id of [w, g]) await setGroupMembership(env, user, id, true);
    expect((await marksOf(user.id))[`${w}>${g}`]).toEqual({
      level: "busy",
      markPrivate: false,
      origin: "custom",
    });
  });
});

describe("reset of a direction", () => {
  it("brings back the private mark of the settings with the group's busy", async () => {
    const { user, w, o, g } = await setup("lvreset");
    for (const id of [w, o, g]) await setGroupMembership(env, user, id, true);
    await setDirections(env, user, [{ from: w, to: g, choice: "title", markPrivate: false }]);
    await resetDirection(env, user, w, g);
    expect((await marksOf(user.id))[`${w}>${g}`]).toEqual({
      level: "busy",
      markPrivate: true,
      origin: "group",
    });
  });
});

describe("private switch in the settings", () => {
  it("keeps the mark of each direction while the switch stays as it was", async () => {
    const { user, cookie, w, o, g } = await setup("swkeep");
    await setDirection(env, user, o, g, "title");
    await setDirections(env, user, [{ from: w, to: g, choice: "title", markPrivate: false }]);
    expect((await post("/rules/choices", cookie, settingsFields(true, true))).status).toBe(204);
    const marks = await marksOf(user.id);
    expect(marks[`${w}>${g}`]?.markPrivate).toBe(false);
    expect(marks[`${o}>${g}`]?.markPrivate).toBe(true);
  });

  it("applies to every direction once switched on, and to none once switched off", async () => {
    const { user, cookie, w, o, g } = await setup("swflip");
    await setDirection(env, user, o, g, "title");
    await setDirections(env, user, [{ from: w, to: g, choice: "title", markPrivate: false }]);
    // "Off" never opens a direction: it sets only the default for new ones.
    expect((await post("/rules/choices", cookie, settingsFields(false, true))).status).toBe(204);
    let marks = await marksOf(user.id);
    expect(marks[`${w}>${g}`]?.markPrivate).toBe(false);
    expect(marks[`${o}>${g}`]?.markPrivate).toBe(true);
    expect((await loadEditorState(env, user.id)).settings.markPrivate).toBe(false);
    // "On" reaches every direction, because it can only narrow.
    expect((await post("/rules/choices", cookie, settingsFields(true, false))).status).toBe(204);
    marks = await marksOf(user.id);
    expect(marks[`${w}>${g}`]?.markPrivate).toBe(true);
    expect(marks[`${o}>${g}`]?.markPrivate).toBe(true);
  });

  it("applies to every direction from a page that does not send what it showed", async () => {
    const { user, cookie, w, g } = await setup("swold");
    await setDirections(env, user, [{ from: w, to: g, choice: "title", markPrivate: false }]);
    expect((await post("/rules/choices", cookie, settingsFields(true))).status).toBe(204);
    expect((await marksOf(user.id))[`${w}>${g}`]?.markPrivate).toBe(true);
  });

  it("never leaves a direction with a title and without its mark between the writes", async () => {
    const { user, cookie, w, g } = await setup("swgap");
    await setDirections(env, user, [{ from: w, to: g, choice: "title", markPrivate: true }]);
    const seen = watchDirection(user.id, `${w}>${g}`);
    const response = await post("/rules/choices", cookie, {
      ...settingsFields(false, true),
      [`choice.${w}.${g}`]: "full-private",
    });
    expect(response.status).toBe(204);
    expect(seen.length).toBeGreaterThan(1);
    for (const state of seen) expect(state.markPrivate, JSON.stringify(seen)).toBe(true);
  });

  it("gives a bare title the switched mark in its first write, as an old page sends it", async () => {
    const { user, cookie, w, g } = await setup("swbare");
    expect((await post("/rules/choices", cookie, settingsFields(false, true))).status).toBe(204);
    await setDirection(env, user, w, g, "busy");
    const seen = watchDirection(user.id, `${w}>${g}`);
    // A page from before "markPrivateShown" turns the switch on and the direction to "title".
    const response = await post("/rules/choices", cookie, {
      ...settingsFields(true),
      [`choice.${w}.${g}`]: "title",
    });
    expect(response.status).toBe(204);
    const titled = seen.filter((state) => state.level === "title");
    expect(titled.length).toBeGreaterThan(0);
    for (const state of titled) expect(state.markPrivate, JSON.stringify(seen)).toBe(true);
  });

  it("applies a switched mark to other rules of a pair whose level kept its own", async () => {
    const { user, cookie, w, g } = await setup("swother");
    expect((await post("/rules/choices", cookie, settingsFields(false, true))).status).toBe(204);
    await setDirection(env, user, w, g, "title");
    // A rule from a calendar of the account that is not a source: it shows under "Other rules".
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES ('swother-w-second', ?, 'second', 'Second', 1, 0, 0)",
      ).bind(w),
      env.DB.prepare(
        `INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options)
         VALUES ('swother-rule', ?, 'swother-w-second', ?, '{"detailLevel":"title","markPrivate":false}')`,
      ).bind(user.id, `${g}-cal`),
    ]);
    const response = await post("/rules/choices", cookie, {
      ...settingsFields(true, false),
      [`choice.${w}.${g}`]: "title-open",
    });
    expect(response.status).toBe(204);
    const other = await env.DB.prepare(
      "SELECT json_extract(options, '$.markPrivate') AS mark FROM rules WHERE id = 'swother-rule'",
    ).first<{ mark: number }>();
    expect(other?.mark).toBe(1);
    // The rule of the direction itself kept the level's mark.
    const own = await env.DB.prepare(
      "SELECT json_extract(options, '$.markPrivate') AS mark FROM rules WHERE source_calendar_id = ? AND target_calendar_id = ?",
    )
      .bind(`${w}-cal`, `${g}-cal`)
      .first<{ mark: number }>();
    expect(own?.mark).toBe(0);
  });

  it("lets a level of the same save win over a switched setting", async () => {
    const { user, cookie, w, o, g } = await setup("swboth");
    await setDirections(env, user, [{ from: o, to: g, choice: "title", markPrivate: false }]);
    // Only "on" reaches every direction, so the level of the same save keeps its open mark.
    const response = await post("/rules/choices", cookie, {
      ...settingsFields(true, false),
      [`choice.${w}.${g}`]: "title-open",
    });
    expect(response.status).toBe(204);
    const marks = await marksOf(user.id);
    expect(marks[`${w}>${g}`]?.markPrivate).toBe(false);
    expect(marks[`${o}>${g}`]?.markPrivate).toBe(true);
  });
});
