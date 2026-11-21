/**
 * The scope of the private setting in a settings save. "Who sees new mirrorings" (`newWho`) sets
 * the default for new mirrorings. It changes existing mirrorings only with `applyWho`. Forms
 * without `newWho` keep the old switch, but a missing or unknown field never makes a copy more
 * visible.
 */
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadEditorState,
  markPrivateScope,
  setDirections,
  setSettings,
  visibilityEffect,
  type SettingsForm,
} from "../src/editor";
import { settingsFrom } from "../src/routes/rules";
import { BASE, signIn } from "./helpers";

/**
 * A user with three accounts, each with one main calendar and stored tokens. The first account has
 * a second source calendar, so that its directions have two rules.
 */
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
  const [w, o, g] = accounts.map(([id]) => id) as [string, string, string];
  await env.DB.prepare(
    "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, ?, 'Second', 1, 0, 1)",
  )
    .bind(`${w}-second`, w, `${w}-second-remote`)
    .run();
  return { user, cookie, w, o, g };
}

/**
 * Mirrorings with every kind of mark:
 * - w > g: title, private, two rules (main and second calendar);
 * - o > g: busy, open;
 * - w > o: title, mixed: the main calendar's rule open, the second's private;
 * - g > o: off, with a disabled private rule;
 * - an extra rule from a calendar that is no source, private ("Other rules").
 */
async function mirrorings(prefix: string) {
  const context = await setup(prefix);
  const { user, w, o, g } = context;
  await setDirections(env, user, [
    { from: w, to: g, choice: "title", markPrivate: true },
    { from: o, to: g, choice: "busy" },
    { from: w, to: o, choice: "title", markPrivate: true },
  ]);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE rules SET options = json_set(options, '$.markPrivate', json('false'))
       WHERE user_id = ? AND (target_calendar_id = ? OR source_calendar_id = ? AND target_calendar_id = ?)`,
    ).bind(user.id, `${g}-cal`, `${w}-cal`, `${o}-cal`),
    env.DB.prepare(
      `UPDATE rules SET options = json_set(options, '$.markPrivate', json('true'))
       WHERE user_id = ? AND source_calendar_id IN (?, ?) AND target_calendar_id = ?`,
    ).bind(user.id, `${w}-cal`, `${w}-second`, `${g}-cal`),
    env.DB.prepare(
      `INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options, enabled)
       VALUES (?, ?, ?, ?, '{"detailLevel":"busy","markPrivate":true}', 0)`,
    ).bind(`${prefix}-off`, user.id, `${g}-cal`, `${o}-cal`),
    env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, ?, 'Shared', 1, 0, 0)",
    ).bind(`${o}-shared`, o, `${o}-shared-remote`),
    env.DB.prepare(
      `INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options)
       VALUES (?, ?, ?, ?, '{"detailLevel":"title","markPrivate":true}')`,
    ).bind(`${prefix}-other`, user.id, `${o}-shared`, `${w}-cal`),
  ]);
  // The setup holds what the comments above say.
  expect(await marks(user.id)).toEqual({
    [`${w}-cal>${g}-cal`]: true,
    [`${w}-second>${g}-cal`]: true,
    [`${o}-cal>${g}-cal`]: false,
    [`${w}-cal>${o}-cal`]: false,
    [`${w}-second>${o}-cal`]: true,
    [`${g}-cal>${o}-cal`]: true,
    [`${o}-shared>${w}-cal`]: true,
  });
  return context;
}

/** The private mark of every rule of the user, enabled or not, keyed "source>target" calendar. */
async function marks(userId: string): Promise<Record<string, boolean>> {
  const { results } = await env.DB.prepare(
    `SELECT source_calendar_id AS source, target_calendar_id AS target,
            json_extract(options, '$.markPrivate') AS mark
     FROM rules WHERE user_id = ?`,
  )
    .bind(userId)
    .all<{ source: string; target: string; mark: number | null }>();
  return Object.fromEntries(
    results.map((row) => [
      `${row.source}>${row.target}`,
      row.mark === null ? true : row.mark === 1,
    ]),
  );
}

/** The default for new mirrorings: the stored one, or the schema default `true`. */
async function storedDefault(userId: string): Promise<unknown> {
  const row = await env.DB.prepare("SELECT sync_settings AS json FROM users WHERE id = ?")
    .bind(userId)
    .first<{ json: string }>();
  return (JSON.parse(row?.json ?? "{}") as { markPrivate?: unknown }).markPrivate ?? true;
}

async function setStoredDefault(userId: string, markPrivate: boolean): Promise<void> {
  await env.DB.prepare(
    "UPDATE users SET sync_settings = json_set(sync_settings, '$.markPrivate', json(?)) WHERE id = ?",
  )
    .bind(markPrivate ? "true" : "false", userId)
    .run();
}

function post(path: string, cookie: string, fields: Record<string, string>) {
  return exports.default.fetch(`${BASE}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", "x-fragment": "1" },
    body: new URLSearchParams(fields),
  });
}

/** The fields every settings form sends, without anything about the private mark. */
const PLAIN = { daysAhead: "30", daysAheadShown: "30", skipAllDayShown: "0" };

/** The same fields as the old editor's script sends them, with the prefix "settings.". */
function prefixed(fields: Record<string, string>): Record<string, string> {
  return {
    settings: "1",
    ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [`settings.${key}`, value])),
  };
}

/** The three ways a settings form reaches `setSettings`. */
const ROUTES = [
  [
    "the new panel",
    "/mirroring",
    (fields: Record<string, string>) => ({ scope: "all", ...fields }),
  ],
  ["the old settings form", "/rules/settings", (fields: Record<string, string>) => fields],
  ["the old editor's script", "/rules/choices", prefixed],
] as const;

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

describe("settingsFrom", () => {
  function form(fields: Record<string, string>): FormData {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.append(key, value);
    return data;
  }

  it("reads newWho only as one of the two exact words, and applyWho only as 1", () => {
    expect(settingsFrom(form({ newWho: "private" }), "Busy")).toMatchObject({ newWho: "private" });
    expect(settingsFrom(form({ newWho: "open", applyWho: "1" }), "Busy")).toMatchObject({
      newWho: "open",
      applyWho: true,
    });
    expect(
      settingsFrom(
        form({ "settings.newWho": "open", "settings.applyWho": "1" }),
        "Busy",
        "settings.",
      ),
    ).toMatchObject({ newWho: "open", applyWho: true });
    for (const value of ["", "Open", "OPEN", "open ", "public", "everyone", "0", "1", "false"]) {
      const settings = settingsFrom(form({ newWho: value, applyWho: "1" }), "Busy");
      expect(settings.newWho, JSON.stringify(value)).toBeUndefined();
    }
    for (const value of ["", "on", "true", "0", "yes"]) {
      const settings = settingsFrom(form({ newWho: "open", applyWho: value }), "Busy");
      expect(settings.applyWho, JSON.stringify(value)).toBeUndefined();
    }
    expect(settingsFrom(form({}), "Busy")).not.toHaveProperty("newWho");
    expect(settingsFrom(form({}), "Busy")).not.toHaveProperty("applyWho");
  });
});

describe("markPrivateScope", () => {
  type Case = [Partial<SettingsForm>, ReturnType<typeof markPrivateScope>];
  const cases: Case[] = [
    // newWho decides; the checkbox and its marker do not count.
    [{ newWho: "private" }, { scope: "default", markPrivate: true }],
    [{ newWho: "open" }, { scope: "default", markPrivate: false }],
    [
      { newWho: "private", applyWho: true },
      { scope: "all", markPrivate: true },
    ],
    [
      { newWho: "open", applyWho: true },
      { scope: "all", markPrivate: false },
    ],
    [
      { newWho: "open", markPrivate: true, markPrivateShown: false },
      { scope: "default", markPrivate: false },
    ],
    [
      { newWho: "private", markPrivate: false, markPrivateShown: true },
      { scope: "default", markPrivate: true },
    ],
    // The switch with its marker, as the old forms send it.
    [
      { markPrivate: true, markPrivateShown: true },
      { scope: "default", markPrivate: true },
    ],
    [
      { markPrivate: false, markPrivateShown: false },
      { scope: "default", markPrivate: false },
    ],
    [
      { markPrivate: false, markPrivateShown: true },
      { scope: "all", markPrivate: false },
    ],
    [
      { markPrivate: true, markPrivateShown: false },
      { scope: "all", markPrivate: true },
    ],
    // Without a marker: a page from before it, or a form without the switch.
    [{ markPrivate: true }, { scope: "all", markPrivate: true }],
    [{ markPrivate: false }, { scope: "keep", markPrivate: false }],
    // applyWho without newWho does nothing.
    [
      { markPrivate: false, applyWho: true },
      { scope: "keep", markPrivate: false },
    ],
    [
      { markPrivate: true, markPrivateShown: true, applyWho: true },
      { scope: "default", markPrivate: true },
    ],
  ];
  it.each(cases)("%j gives %j", (form, expected) => {
    expect(markPrivateScope({ markPrivate: false, ...form })).toEqual(expected);
  });

  it("treats a word other than the two as no newWho, never as open", () => {
    const form = {
      markPrivate: false,
      applyWho: true,
      newWho: "public",
    } as unknown as SettingsForm;
    expect(markPrivateScope(form)).toEqual({ scope: "keep", markPrivate: false });
  });
});

describe("a form without the private control (failure mode 2)", () => {
  for (const [index, [name, path, shape]] of ROUTES.entries()) {
    for (const stored of [true, false]) {
      it(`changes no mark and not the default from ${name}, default ${stored}`, async () => {
        const prefix = `fm2${index}${stored ? "p" : "o"}`;
        const { user, cookie } = await mirrorings(prefix);
        await setStoredDefault(user.id, stored);
        const before = await marks(user.id);
        const response = await post(path, cookie, shape({ ...PLAIN, blockTitle: "Away" }));
        expect(response.status).toBeLessThan(400);
        expect(await marks(user.id)).toEqual(before);
        expect(await storedDefault(user.id)).toBe(stored);
        // The rest of the save went through.
        expect((await loadEditorState(env, user.id)).settings.blockTitle).toBe("Away");
      });
    }
  }
});

describe("who sees new mirrorings (failure mode 8)", () => {
  for (const [index, [name, path, shape]] of ROUTES.entries()) {
    for (const who of ["private", "open"] as const) {
      it(`sets only the default to ${who} from ${name}`, async () => {
        const prefix = `fm8${index}${who}`;
        const { user, cookie } = await mirrorings(prefix);
        await setStoredDefault(user.id, who !== "private");
        const before = await marks(user.id);
        const response = await post(path, cookie, shape({ ...PLAIN, newWho: who }));
        expect(response.status).toBeLessThan(400);
        expect(await marks(user.id)).toEqual(before);
        expect(await storedDefault(user.id)).toBe(who === "private");
      });
    }
  }

  it("ignores the old switch and its marker when newWho is there", async () => {
    const { user, cookie } = await mirrorings("fm8both");
    const before = await marks(user.id);
    // The old switch would apply "off" to every rule; newWho sets only the default.
    await post("/rules/settings", cookie, { ...PLAIN, markPrivateShown: "1", newWho: "open" });
    expect(await marks(user.id)).toEqual(before);
    expect(await storedDefault(user.id)).toBe(false);
  });
});

describe("applying who sees it to every mirroring (failure mode 10)", () => {
  for (const [index, [name, path, shape]] of ROUTES.entries()) {
    for (const who of ["private", "open"] as const) {
      it(`gives every rule ${who} with applyWho from ${name}`, async () => {
        const prefix = `fm10${index}${who}`;
        const { user, cookie } = await mirrorings(prefix);
        const before = await marks(user.id);
        const response = await post(path, cookie, shape({ ...PLAIN, newWho: who, applyWho: "1" }));
        expect(response.status).toBeLessThan(400);
        const after = await marks(user.id);
        expect(Object.keys(after).toSorted()).toEqual(Object.keys(before).toSorted());
        for (const [key, mark] of Object.entries(after)) expect(mark, key).toBe(who === "private");
        expect(await storedDefault(user.id)).toBe(who === "private");
      });
    }
  }

  it("does nothing with applyWho but without newWho, or with an unknown newWho", async () => {
    const { user, cookie } = await mirrorings("fm10none");
    const before = await marks(user.id);
    const extras: Record<string, string>[] = [
      { applyWho: "1" },
      { applyWho: "1", newWho: "public" },
      { applyWho: "1", newWho: "" },
    ];
    for (const extra of extras) {
      await post("/rules/settings", cookie, { ...PLAIN, ...extra });
      await post("/mirroring", cookie, { scope: "all", ...PLAIN, ...extra });
      expect(await marks(user.id), JSON.stringify(extra)).toEqual(before);
      expect(await storedDefault(user.id), JSON.stringify(extra)).toBe(true);
    }
  });

  it("lets a level of the same save win over applyWho, as over the old switch", async () => {
    const { user, cookie, o, g } = await mirrorings("fm10level");
    const response = await post("/rules/choices", cookie, {
      ...prefixed({ ...PLAIN, newWho: "open", applyWho: "1" }),
      [`choice.${o}.${g}`]: "title-private",
    });
    expect(response.status).toBe(204);
    const after = await marks(user.id);
    expect(after[`${o}-cal>${g}-cal`]).toBe(true);
    expect(Object.values(after).filter((mark) => mark)).toHaveLength(1);
  });

  it("gives a bare title of the same save the applied mark in its own write", async () => {
    const { user, cookie, o, g } = await mirrorings("fm10bare");
    // o > g is busy and open. Applying "private" with a bare title must not leave it open.
    const response = await post("/rules/choices", cookie, {
      ...prefixed({ ...PLAIN, newWho: "private", applyWho: "1" }),
      [`choice.${o}.${g}`]: "title",
    });
    expect(response.status).toBe(204);
    for (const [key, mark] of Object.entries(await marks(user.id))) expect(mark, key).toBe(true);
  });

  it("never changes the rules or the default of another user of the org", async () => {
    const own = await mirrorings("fm10mine");
    const other = await mirrorings("fm10theirs");
    await setStoredDefault(other.user.id, true);
    const before = await marks(other.user.id);
    expect(own.user.orgId).toBe(other.user.orgId);
    await post("/rules/settings", own.cookie, { ...PLAIN, newWho: "open", applyWho: "1" });
    await post("/mirroring", own.cookie, {
      scope: "all",
      ...PLAIN,
      newWho: "open",
      applyWho: "1",
    });
    expect(Object.values(await marks(own.user.id)).every((mark) => !mark)).toBe(true);
    expect(await marks(other.user.id)).toEqual(before);
    expect(await storedDefault(other.user.id)).toBe(true);
  });

  it("asks the target account of every rule to sync", async () => {
    const { user, w, o, g } = await mirrorings("fm10sync");
    const syncs = new Set<string>();
    await setSettings(env, user, { ...settingsBase(), newWho: "open", applyWho: true }, syncs);
    expect([...syncs].toSorted()).toEqual([g, o, w].toSorted());
  });
});

describe("the old switch without its marker", () => {
  it("leaves every mark and the default alone when it is off", async () => {
    const { user, cookie } = await mirrorings("legoff");
    const before = await marks(user.id);
    // A page from before markPrivateShown, with the switch off: no "markPrivate" field.
    await post("/rules/settings", cookie, { ...PLAIN });
    await post("/rules/choices", cookie, prefixed({ ...PLAIN }));
    expect(await marks(user.id)).toEqual(before);
    expect(await storedDefault(user.id)).toBe(true);
  });

  it("makes every rule private when it is on, which can only narrow", async () => {
    const { user, cookie } = await mirrorings("legon");
    await setStoredDefault(user.id, false);
    await post("/rules/settings", cookie, { ...PLAIN, markPrivate: "on" });
    for (const [key, mark] of Object.entries(await marks(user.id))) expect(mark, key).toBe(true);
    expect(await storedDefault(user.id)).toBe(true);
  });

  it("keeps a bare title of the same save at its own mark when the switch is off", async () => {
    const { user, cookie, w, o } = await mirrorings("legbare");
    // w > o is mixed. Without the marker, "off" must not open its private rule.
    const response = await post("/rules/choices", cookie, {
      ...prefixed({ ...PLAIN }),
      [`choice.${w}.${o}`]: "full",
    });
    expect(response.status).toBe(204);
    expect((await marks(user.id))[`${w}-second>${o}-cal`]).toBe(true);
  });

  it("still applies a switched mark with its marker, as the old forms send it", async () => {
    const { user, cookie } = await mirrorings("legshown");
    await post("/rules/settings", cookie, { ...PLAIN, markPrivateShown: "1" });
    for (const [key, mark] of Object.entries(await marks(user.id))) expect(mark, key).toBe(false);
    expect(await storedDefault(user.id)).toBe(false);
  });
});

describe("visibilityEffect", () => {
  it("counts the mirrorings that applying a value widens or narrows", async () => {
    const { user } = await mirrorings("effect");
    const state = await loadEditorState(env, user.id);
    // Open widens w > g, the mixed w > o and the extra rule; off g > o has no copies.
    expect(visibilityEffect(state, "open")).toEqual({ widened: 3, narrowed: 0 });
    // Private narrows the open o > g and the mixed w > o.
    expect(visibilityEffect(state, "private")).toEqual({ widened: 0, narrowed: 2 });
  });

  it("matches what the save then does: nothing is left to change", async () => {
    for (const who of ["open", "private"] as const) {
      const { user, cookie } = await mirrorings(`effectsave${who}`);
      await post("/rules/settings", cookie, { ...PLAIN, newWho: who });
      // Without applyWho nothing changed, so the effect is still to come.
      expect(visibilityEffect(await loadEditorState(env, user.id), who)).not.toEqual({
        widened: 0,
        narrowed: 0,
      });
      await post("/rules/settings", cookie, { ...PLAIN, newWho: who, applyWho: "1" });
      expect(visibilityEffect(await loadEditorState(env, user.id), who)).toEqual({
        widened: 0,
        narrowed: 0,
      });
    }
  });

  it("counts nothing for a user without mirrorings", async () => {
    const { user } = await setup("effectnone");
    const state = await loadEditorState(env, user.id);
    expect(visibilityEffect(state, "open")).toEqual({ widened: 0, narrowed: 0 });
    expect(visibilityEffect(state, "private")).toEqual({ widened: 0, narrowed: 0 });
  });
});

/** Settings for a direct call of `setSettings` that change nothing but the mark. */
function settingsBase(): SettingsForm {
  return {
    daysAhead: 30,
    daysAheadShown: 30,
    skipAllDayShown: false,
    skipAllDay: false,
    skipTentative: false,
    markPrivate: false,
    blockTitle: "Busy",
    skipCategories: [],
  };
}
