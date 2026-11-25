import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadEditorState,
  resetDirection,
  setBlockColor,
  setDirection,
  setGroupMembership,
  setRuleDetails,
  setSettings,
  setSourceCalendar,
  shortNames,
} from "../src/editor";
import { BASE, signIn } from "./helpers";

describe("shortNames", () => {
  it("names public providers and work domains, and tells duplicates apart", () => {
    expect(shortNames(["a@gmail.com", "me@netcero.eu", "x@outlook.com"])).toEqual([
      "Gmail",
      "netcero",
      "Outlook",
    ]);
    expect(shortNames(["one@gmail.com", "two@gmail.com"])).toEqual(["Gmail (one)", "Gmail (two)"]);
  });
});

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

async function rulesOf(userId: string) {
  const { results } = await env.DB.prepare(
    `SELECT sc.account_id AS source, tc.account_id AS target, r.enabled, r.origin,
            json_extract(r.options, '$.detailLevel') AS level
     FROM rules r JOIN calendars sc ON sc.id = r.source_calendar_id
     JOIN calendars tc ON tc.id = r.target_calendar_id
     WHERE r.user_id = ? ORDER BY source, target`,
  )
    .bind(userId)
    .all<{ source: string; target: string; enabled: number; origin: string; level: string }>();
  return results;
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

describe("block group", () => {
  it("creates busy rules both ways when accounts join, and removes them when one leaves", async () => {
    const { user, w, o, g } = await setup("grp");
    for (const id of [w, o, g]) await setGroupMembership(env, user, id, true);

    const rules = await rulesOf(user.id);
    expect(rules).toHaveLength(6);
    expect(rules.every((rule) => rule.origin === "group" && rule.level === "busy")).toBe(true);

    await setGroupMembership(env, user, g, false);
    const left = await rulesOf(user.id);
    expect(left).toHaveLength(2);
    expect(left.some((rule) => rule.source === g || rule.target === g)).toBe(false);
  });

  it("keeps exceptions when an account leaves, and adopts plain busy rules when it joins", async () => {
    const { user, w, o } = await setup("adopt");
    await setDirection(env, user, w, o, "busy");
    expect((await rulesOf(user.id))[0]).toMatchObject({ origin: "custom" });

    await setGroupMembership(env, user, w, true);
    await setGroupMembership(env, user, o, true);
    const rules = await rulesOf(user.id);
    expect(rules).toHaveLength(2);
    expect(rules.every((rule) => rule.origin === "group")).toBe(true);

    await setDirection(env, user, w, o, "full");
    await setGroupMembership(env, user, o, false);
    expect(await rulesOf(user.id)).toEqual([
      expect.objectContaining({ source: w, target: o, level: "full", origin: "custom" }),
    ]);
  });
});

describe("directions", () => {
  it("makes a different choice an exception and resets it to the group", async () => {
    const { user, w, g } = await setup("exc");
    await setGroupMembership(env, user, w, true);
    await setGroupMembership(env, user, g, true);

    await setDirection(env, user, w, g, "full");
    await setBlockColor(env, user, w, g, "3");
    let state = await loadEditorState(env, user.id);
    expect(state.directions.find((d) => d.from === w && d.to === g)).toMatchObject({
      choice: "full",
      origin: "custom",
    });

    await resetDirection(env, user, w, g);
    state = await loadEditorState(env, user.id);
    expect(state.directions.find((d) => d.from === w && d.to === g)).toMatchObject({
      choice: "busy",
      origin: "group",
    });
    // The group writes blocks without a colour, so the reset clears it.
    expect(state.directions.find((d) => d.from === w && d.to === g)?.options?.blockColor).toBe("");
  });

  it("turns a group direction off with a disabled exception, and deletes it outside the group", async () => {
    const { user, w, o, g } = await setup("off");
    await setGroupMembership(env, user, w, true);
    await setGroupMembership(env, user, o, true);

    await setDirection(env, user, w, o, "off");
    expect((await rulesOf(user.id)).find((r) => r.source === w && r.target === o)).toMatchObject({
      enabled: 0,
      origin: "custom",
    });

    await setDirection(env, user, w, g, "title");
    await setDirection(env, user, w, g, "off");
    expect((await rulesOf(user.id)).some((r) => r.source === w && r.target === g)).toBe(false);
  });
});

/** The target calendar lost write access, for example after a calendar refresh. */
async function makeReadOnly(accountId: string) {
  await env.DB.prepare("UPDATE calendars SET can_edit = 0 WHERE account_id = ?")
    .bind(accountId)
    .run();
}

async function removalsOf(accountId: string) {
  return runInDurableObject(env.ACCOUNT_SYNC.getByName(accountId), (_instance, state) =>
    state.storage.get<{ ruleId: string; remoteCalendarId: string }[]>("removalQueue"),
  );
}

describe("read-only target", () => {
  it("turns a direction off outside the group and queues the removal of its blocks", async () => {
    const { user, w, o } = await setup("ro-out");
    await setDirection(env, user, w, o, "title");
    await makeReadOnly(o);

    // Turning on or changing the level still needs write access.
    await setDirection(env, user, w, o, "busy");
    await setDirection(env, user, w, o, "full");
    expect(await rulesOf(user.id)).toEqual([
      expect.objectContaining({ source: w, target: o, level: "title", enabled: 1 }),
    ]);

    await setDirection(env, user, w, o, "off");
    expect(await rulesOf(user.id)).toEqual([]);
    expect(await removalsOf(o)).toEqual([
      expect.objectContaining({ remoteCalendarId: `${o}-remote` }),
    ]);
  });

  it("turns a group direction off with a disabled exception, and does not turn it on", async () => {
    const { user, w, g } = await setup("ro-grp");
    await setGroupMembership(env, user, w, true);
    await setGroupMembership(env, user, g, true);
    await makeReadOnly(g);

    await setDirection(env, user, w, g, "off");
    expect((await rulesOf(user.id)).find((r) => r.source === w && r.target === g)).toMatchObject({
      enabled: 0,
      origin: "custom",
    });
    expect(await removalsOf(g)).toEqual([
      expect.objectContaining({ remoteCalendarId: `${g}-remote` }),
    ]);

    await setDirection(env, user, w, g, "busy");
    expect((await rulesOf(user.id)).find((r) => r.source === w && r.target === g)).toMatchObject({
      enabled: 0,
      origin: "custom",
    });
  });

  it("leaves a direction unchanged on reset, inside and outside the group", async () => {
    // can_edit can be wrong, so a reset must not remove working blocks.
    const { user, w, o, g } = await setup("ro-reset");
    await setGroupMembership(env, user, w, true);
    await setGroupMembership(env, user, g, true);
    await setDirection(env, user, w, g, "full");
    await setBlockColor(env, user, w, g, "3");
    await setDirection(env, user, w, o, "title");
    await makeReadOnly(g);
    await makeReadOnly(o);
    const before = await rulesOf(user.id);

    await resetDirection(env, user, w, g);
    await resetDirection(env, user, w, o);
    expect(await rulesOf(user.id)).toEqual(before);
    const state = await loadEditorState(env, user.id);
    expect(state.directions.find((d) => d.from === w && d.to === g)?.options?.blockColor).toBe("3");
    expect(await removalsOf(g)).toBeUndefined();
    expect(await removalsOf(o)).toBeUndefined();
  });
});

describe("editor page", () => {
  it("saves a choice from the form and returns to the row in the open card", async () => {
    const { user, cookie, w, o } = await setup("form");
    const response = await exports.default.fetch(`${BASE}/rules/direction`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ from: w, to: o, choice: "title" }),
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/rules?open=${o}#dest-${w}-${o}`);
    expect(await rulesOf(user.id)).toEqual([
      expect.objectContaining({ source: w, target: o, level: "title", enabled: 1 }),
    ]);
  });
});

describe("account names", () => {
  it("uses a name the user gave, and the derived one again when it is cleared", async () => {
    const { cookie, user, w } = await setup("name");
    const rename = (name: string) =>
      exports.default.fetch(`${BASE}/accounts/${w}/name`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ name }),
      });
    expect((await rename("  NetCero  ")).status).toBe(302);
    let state = await loadEditorState(env, user.id);
    expect(state.accounts.find((a) => a.id === w)?.name).toBe("NetCero");

    await rename("");
    state = await loadEditorState(env, user.id);
    expect(state.accounts.find((a) => a.id === w)?.name).toBe("work");
  });
});

describe("editor script endpoints", () => {
  const fragment = (path: string, cookie: string, body?: URLSearchParams) =>
    exports.default.fetch(`${BASE}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        "x-fragment": "1",
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });

  it("refuses an unknown choice", async () => {
    const { cookie, w, o } = await setup("badchoice");
    const response = await fragment(
      `/rules/choices`,
      cookie,
      new URLSearchParams({ [`choice.${w}.${o}`]: "everything" }),
    );
    expect(response.status).toBe(400);
  });
});

describe("page save", () => {
  it("saves the choices of several sources in one request", async () => {
    const { user, cookie, w, o, g } = await setup("pagesave");
    const response = await exports.default.fetch(`${BASE}/rules/choices`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "x-fragment": "1", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ [`choice.${w}.${g}`]: "full", [`choice.${g}.${o}`]: "busy" }),
    });
    expect(response.status).toBe(204);
    expect(await rulesOf(user.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: w, target: g, level: "full" }),
        expect.objectContaining({ source: g, target: o, level: "busy" }),
      ]),
    );
  });
});

describe("settings", () => {
  it("applies the settings to every rule and to new ones, and keeps each detail level", async () => {
    const { user, cookie, w, o, g } = await setup("settings");
    await setDirection(env, user, w, g, "full");
    const response = await exports.default.fetch(`${BASE}/rules/choices`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "x-fragment": "1", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        settings: "1",
        "settings.daysAhead": "180",
        "settings.markPrivate": "on",
      }),
    });
    expect(response.status).toBe(204);
    await setDirection(env, user, o, w, "busy");

    const { results } = await env.DB.prepare("SELECT options FROM rules WHERE user_id = ?")
      .bind(user.id)
      .all<{ options: string }>();
    const options = results.map((row) => JSON.parse(row.options) as Record<string, unknown>);
    expect(options).toHaveLength(2);
    for (const option of options) {
      expect(option).toMatchObject({ daysAhead: 180, skipAllDay: false, markPrivate: true });
    }
    expect(options.map((option) => option.detailLevel).sort()).toEqual(["busy", "full"]);
  });
});

describe("source calendars", () => {
  it("gives a new source calendar the choices of its account, and removes them when off", async () => {
    const { user, cookie, w, o, g } = await setup("srccal");
    await env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES ('srccal-games', ?, 'games', 'UFC games', 0, 0, 0)",
    )
      .bind(g)
      .run();
    await setDirection(env, user, g, w, "busy");
    await setDirection(env, user, g, o, "title");

    const save = (fields: Record<string, string>) =>
      exports.default.fetch(`${BASE}/rules/choices`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie, "x-fragment": "1", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields),
      });
    expect((await save({ "calendar.srccal-games": "1" })).status).toBe(204);
    const fromGames = (await rulesOf(user.id)).filter((rule) => rule.source === g);
    expect(fromGames).toHaveLength(4);
    expect(fromGames.map((rule) => rule.level).sort()).toEqual(["busy", "busy", "title", "title"]);

    // A later choice reaches every source calendar of the account.
    await setDirection(env, user, g, w, "full");
    const toWork = (await rulesOf(user.id)).filter((r) => r.source === g && r.target === w);
    expect(toWork.map((rule) => rule.level)).toEqual(["full", "full"]);

    expect((await save({ "calendar.srccal-games": "0" })).status).toBe(204);
    expect((await rulesOf(user.id)).filter((rule) => rule.source === g)).toHaveLength(2);
  });
});

describe("title and filter settings", () => {
  it("stores the block title and categories from the form, and colours as color:<id>", async () => {
    const { user, cookie, w, g } = await setup("titlefilter");
    await setDirection(env, user, w, g, "busy");
    const body = new URLSearchParams({
      settings: "1",
      "settings.daysAhead": "90",
      "settings.blockTitle": "  Belegt ",
      "settings.skipCategories": "Privat, Fokus,, ",
    });
    body.append("settings.skipColor", "color:11");
    body.append("settings.skipColor", "color:evil");
    await exports.default.fetch(`${BASE}/rules/choices`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "x-fragment": "1", "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const rule = await env.DB.prepare("SELECT options FROM rules WHERE user_id = ?")
      .bind(user.id)
      .first<{ options: string }>();
    expect(JSON.parse(rule?.options ?? "{}")).toMatchObject({
      blockTitle: "Belegt",
      skipCategories: ["Privat", "Fokus", "color:11"],
    });
  });
});

describe("opt-in categories", () => {
  async function optionsOf(column: "id" | "source_calendar_id", id: string) {
    const row = await env.DB.prepare(`SELECT options FROM rules WHERE ${column} = ?`)
      .bind(id)
      .first<{ options: string }>();
    return JSON.parse(row?.options ?? "{}") as { onlyCategories?: string[] };
  }

  const listOf = async (calendar: string) =>
    (await optionsOf("source_calendar_id", calendar)).onlyCategories;

  function saveAll(cookie: string, fields: Record<string, string>) {
    return exports.default.fetch(`${BASE}/rules/choices`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "x-fragment": "1", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    });
  }

  function saveWithoutScript(cookie: string, body: URLSearchParams) {
    return exports.default.fetch(`${BASE}/rules/direction/details`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body,
    });
  }

  const SAVED = {
    skipAllDay: false,
    skipTentative: false,
    markPrivate: true,
    blockTitle: "Busy",
    skipCategories: [],
  };

  it("applies to one direction only, and leaves the exclusions alone", async () => {
    const { user, cookie, w, o, g } = await setup("onlyone");
    await setDirection(env, user, w, g, "busy");
    await setDirection(env, user, o, g, "busy");
    await setDirection(env, user, w, o, "busy");
    await setSettings(env, user, { ...SAVED, skipCategories: ["Privat"] });
    const response = await saveAll(cookie, {
      [`onlyCategories.${w}.${g}`]: "Kunde, Arbeit,, Kunde",
    });
    expect(response.status).toBe(204);
    const rules = await env.DB.prepare(
      `SELECT sc.account_id AS source, tc.account_id AS target, r.options
       FROM rules r JOIN calendars sc ON sc.id = r.source_calendar_id
       JOIN calendars tc ON tc.id = r.target_calendar_id WHERE r.user_id = ?`,
    )
      .bind(user.id)
      .all<{ source: string; target: string; options: string }>();
    const lists = rules.results.map((rule) => {
      const options = JSON.parse(rule.options) as {
        onlyCategories: string[];
        skipCategories: string[];
      };
      expect(options.skipCategories).toEqual(["Privat"]);
      return [`${rule.source}>${rule.target}`, options.onlyCategories];
    });
    expect(Object.fromEntries(lists)).toEqual({
      [`${w}>${g}`]: ["Kunde", "Arbeit"],
      [`${o}>${g}`]: [],
      [`${w}>${o}`]: [],
    });
  });

  it("is not part of the settings for all calendars", async () => {
    const { user, cookie, w, g } = await setup("onlynotall");
    await setDirection(env, user, w, g, "busy");
    await saveAll(cookie, { [`onlyCategories.${w}.${g}`]: "Kunde" });
    expect(Object.keys((await loadEditorState(env, user.id)).settings)).not.toContain(
      "onlyCategories",
    );
    // A save of the settings keeps the list of the rule, and sends none itself.
    await setSettings(env, user, SAVED);
    expect(await listOf(`${w}-cal`)).toEqual(["Kunde"]);
  });

  it("stores a list from the form without the script", async () => {
    const { user, cookie, w, g } = await setup("onlynojs");
    await setDirection(env, user, w, g, "busy");
    const response = await saveWithoutScript(
      cookie,
      new URLSearchParams({
        from: w,
        to: g,
        onlyCategoriesShown: "1",
        onlyCategories: "Kunde, Arbeit",
      }),
    );
    expect(response.status).toBe(302);
    expect(await listOf(`${w}-cal`)).toEqual(["Kunde", "Arbeit"]);
  });

  it("clears the list with an empty field, from both forms", async () => {
    const { user, cookie, w, g } = await setup("onlyclear");
    await setDirection(env, user, w, g, "busy");
    await saveAll(cookie, { [`onlyCategories.${w}.${g}`]: "Kunde" });
    await saveAll(cookie, { [`onlyCategories.${w}.${g}`]: "" });
    expect(await listOf(`${w}-cal`)).toEqual([]);
    await saveAll(cookie, { [`onlyCategories.${w}.${g}`]: "Kunde" });
    await saveWithoutScript(
      cookie,
      new URLSearchParams({ from: w, to: g, onlyCategoriesShown: "1", onlyCategories: "" }),
    );
    expect(await listOf(`${w}-cal`)).toEqual([]);
  });

  it("keeps the list if a page from before the option saves its details", async () => {
    const { user, cookie, w, g } = await setup("onlystale");
    await setDirection(env, user, w, g, "busy");
    await saveAll(cookie, { [`onlyCategories.${w}.${g}`]: "Kunde" });
    await saveWithoutScript(cookie, new URLSearchParams({ from: w, to: g, blockColor: "3" }));
    await saveAll(cookie, { [`blockColor.${w}.${g}`]: "5" });
    expect(await listOf(`${w}-cal`)).toEqual(["Kunde"]);
  });

  it("stores colours of a Google source", async () => {
    const { user, cookie, w, g } = await setup("onlycolor");
    await setDirection(env, user, g, w, "busy");
    const body = new URLSearchParams({ from: g, to: w, onlyCategoriesShown: "1" });
    body.append("onlyColor", "color:5");
    body.append("onlyColor", "color:11");
    await saveWithoutScript(cookie, body);
    expect(await listOf(`${g}-cal`)).toEqual(["color:5", "color:11"]);
  });

  it("refuses names for a Google source, which would stop every event", async () => {
    const { user, cookie, w, g } = await setup("onlyrefused");
    await setDirection(env, user, g, w, "busy");
    await setDirection(env, user, w, g, "busy");
    for (const value of ["Kunde", "color:12", "color:5, Kunde"]) {
      const response = await saveAll(cookie, {
        [`onlyCategories.${g}.${w}`]: value,
        [`onlyCategories.${w}.${g}`]: "Kunde",
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("Google events have colours");
    }
    // The whole save is refused, also the valid field.
    expect(await listOf(`${g}-cal`)).toEqual([]);
    expect(await listOf(`${w}-cal`)).toEqual([]);
  });

  it("refuses a list for a direction that does not exist", async () => {
    const { user, cookie, w, g } = await setup("onlygone");
    await setDirection(env, user, w, g, "busy");
    const response = await saveAll(cookie, { [`onlyCategories.${w}.no-such-account`]: "Kunde" });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("no longer exists");
  });

  it("reads a rule stored before the option as a rule without the filter", async () => {
    const { user, w, g } = await setup("onlyold");
    await setDirection(env, user, w, g, "busy");
    const stored = await env.DB.prepare("SELECT id, options FROM rules WHERE user_id = ?")
      .bind(user.id)
      .first<{ id: string; options: string }>();
    const { onlyCategories: _gone, ...old } = JSON.parse(stored?.options ?? "{}") as Record<
      string,
      unknown
    >;
    await env.DB.prepare("UPDATE rules SET options = ? WHERE id = ?")
      .bind(JSON.stringify(old), stored?.id)
      .run();
    const state = await loadEditorState(env, user.id);
    expect(state.rules[0]?.rule.options.onlyCategories).toEqual([]);
  });

  it("gives a rule copy the list of its direction, and a new direction none", async () => {
    const { user, cookie, w, o, g } = await setup("onlycopy");
    await setDirection(env, user, w, g, "busy");
    await saveAll(cookie, { [`onlyCategories.${w}.${g}`]: "Kunde" });

    await setDirection(env, user, o, g, "busy");
    expect(await listOf(`${o}-cal`)).toEqual([]);

    await env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_source) VALUES (?, ?, ?, 'Second', 1, 0)",
    )
      .bind(`${w}-second`, w, `${w}-second-remote`)
      .run();
    await setSourceCalendar(env, user, `${w}-second`, true);
    expect(await listOf(`${w}-second`)).toEqual(["Kunde"]);
    // A change to the direction reaches both rules.
    await saveAll(cookie, { [`onlyCategories.${w}.${g}`]: "Arbeit" });
    expect(await listOf(`${w}-cal`)).toEqual(["Arbeit"]);
    expect(await listOf(`${w}-second`)).toEqual(["Arbeit"]);
  });

  it("keeps the list through another choice of the direction", async () => {
    const { user, cookie, w, g } = await setup("onlychoice");
    await setDirection(env, user, w, g, "busy");
    await saveAll(cookie, { [`onlyCategories.${w}.${g}`]: "Kunde" });
    await setDirection(env, user, w, g, "title");
    expect(await listOf(`${w}-cal`)).toEqual(["Kunde"]);
  });

  it("behaves on a group rule like the colour of the row", async () => {
    const { user, cookie, w, g } = await setup("onlygroup");
    await setGroupMembership(env, user, w, true);
    await setGroupMembership(env, user, g, true);
    await saveAll(cookie, {
      [`onlyCategories.${w}.${g}`]: "Kunde",
      [`blockColor.${w}.${g}`]: "5",
    });
    const rows = await rulesOf(user.id);
    expect(rows.find((rule) => rule.source === w && rule.target === g)?.origin).toBe("group");
    expect(await listOf(`${w}-cal`)).toEqual(["Kunde"]);
    // The other direction of the group has its own list.
    expect(await listOf(`${g}-cal`)).toEqual([]);
  });

  it("goes away with a reset of the direction, as colour and hours do", async () => {
    const { user, cookie, w, g } = await setup("onlyreset");
    await setGroupMembership(env, user, w, true);
    await setGroupMembership(env, user, g, true);
    await setDirection(env, user, w, g, "title");
    await saveAll(cookie, { [`onlyCategories.${w}.${g}`]: "Kunde" });
    await resetDirection(env, user, w, g);
    expect(await listOf(`${w}-cal`)).toEqual([]);
  });

  it("asks the target to sync and logs the number of names, never a name", async () => {
    const { user, cookie, w, g } = await setup("onlyaudit");
    await setDirection(env, user, w, g, "busy");
    await saveAll(cookie, { [`onlyCategories.${w}.${g}`]: "Geheimkunde, Arbeit" });
    const row = await env.DB.prepare(
      "SELECT detail, account_id AS accountId FROM audit_events WHERE user_id = ? AND kind = 'rule_updated' ORDER BY id DESC",
    )
      .bind(user.id)
      .first<{ detail: string; accountId: string }>();
    // The count of names and the source account, which names the mirroring once the rule is gone.
    expect(JSON.parse(row?.detail ?? "{}")).toEqual({ onlyCategories: "2", fromAccount: w });
    expect(row?.accountId).toBe(g);
    expect(row?.detail).not.toContain("Geheimkunde");
  });
});

describe("carried categories", () => {
  type Pair = { from: string; to: string; tentative?: boolean };

  async function passOf(calendar: string, target = "%"): Promise<Pair[] | undefined> {
    const row = await env.DB.prepare(
      "SELECT options FROM rules WHERE source_calendar_id = ? AND target_calendar_id LIKE ?",
    )
      .bind(calendar, target)
      .first<{ options: string }>();
    return (JSON.parse(row?.options ?? "{}") as { passCategories?: Pair[] }).passCategories;
  }

  /** The batch path: every change of a page in one request. */
  function saveAll(cookie: string, fields: Record<string, string>) {
    return exports.default.fetch(`${BASE}/rules/choices`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "x-fragment": "1", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    });
  }

  /** The details of one direction as a form without script sends them. */
  function saveWithoutScript(cookie: string, body: URLSearchParams) {
    return exports.default.fetch(`${BASE}/rules/direction/details`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body,
    });
  }

  /** The details form of one direction with rows of "passFrom" and "passTo", in their order. */
  function rowsForm(from: string, to: string, rows: [string, string][]) {
    const body = new URLSearchParams({ from, to, passCategoriesShown: "1" });
    for (const [source, target] of rows) {
      body.append("passFrom", source);
      body.append("passTo", target);
    }
    return body;
  }

  const wire = (pairs: string[][]) => JSON.stringify(pairs);

  it("keeps two names for one colour from Google to Outlook", async () => {
    const { user, cookie, w, o, g } = await setup("passmany");
    await setDirection(env, user, g, o, "busy");
    const response = await saveAll(cookie, {
      [`passCategories.${g}.${o}`]: wire([
        ["color:5", "Work"],
        ["color:5", "Client"],
      ]),
    });
    expect(response.status).toBe(204);
    expect(await passOf(`${g}-cal`, `${o}-cal`)).toEqual([
      { from: "color:5", to: "Work", tentative: false },
      { from: "color:5", to: "Client", tentative: false },
    ]);
  });

  it("keeps the first row of a repeated name between calendars of one provider", async () => {
    // The panel shows such a direction as one list of names, so a second row for one name would
    // be lost at the next save of any other field.
    const { user, cookie, w, o } = await setup("passonename");
    await setDirection(env, user, w, o, "busy");
    const response = await saveAll(cookie, {
      [`passCategories.${w}.${o}`]: wire([
        ["Focus", "Deep work"],
        ["focus", "Travel"],
      ]),
    });
    expect(response.status).toBe(204);
    expect(await passOf(`${w}-cal`, `${o}-cal`)).toEqual([
      { from: "Focus", to: "Deep work", tentative: false },
    ]);
  });

  it("stores trimmed pairs of one direction from the batch, a repeated pair is dropped", async () => {
    const { user, cookie, w, o, g } = await setup("passbatch");
    await setDirection(env, user, w, g, "busy");
    await setDirection(env, user, o, g, "busy");
    const response = await saveAll(cookie, {
      [`passCategories.${w}.${g}`]: wire([
        [" Focus ", "3"],
        ["focus", " 3"],
        ["", "7"],
        ["Deep", "11"],
      ]),
    });
    expect(response.status).toBe(204);
    expect(await passOf(`${w}-cal`)).toEqual([
      { from: "Focus", to: "3", tentative: false },
      { from: "Deep", to: "11", tentative: false },
    ]);
    expect(await passOf(`${o}-cal`)).toEqual([]);
  });

  it("allows an empty target only between calendars of one provider", async () => {
    const { user, cookie, w, o, g } = await setup("passsame");
    await setDirection(env, user, w, o, "busy");
    await setDirection(env, user, w, g, "busy");
    await setDirection(env, user, g, w, "busy");
    expect(
      (
        await saveAll(cookie, {
          [`passCategories.${w}.${o}`]: wire([["Focus", ""]]),
        })
      ).status,
    ).toBe(204);
    expect(await passOf(`${w}-cal`, `${o}-cal`)).toEqual([
      { from: "Focus", to: "", tentative: false },
    ]);
    for (const [from, to, pair] of [
      [w, g, ["Focus", ""]],
      [g, w, ["color:3", ""]],
    ] as const) {
      const response = await saveAll(cookie, {
        [`passCategories.${from}.${to}`]: wire([[...pair]]),
      });
      expect(response.status).toBe(400);
    }
  });

  it("refuses the whole save for an invalid pair", async () => {
    const { user, cookie, w, g } = await setup("passrefused");
    await setDirection(env, user, w, g, "busy");
    await setDirection(env, user, g, w, "busy");
    const valid = { [`passCategories.${w}.${g}`]: wire([["Focus", "3"]]) };
    const bad: [string, string][] = [
      [`passCategories.${g}.${w}`, wire([["Focus", "Focus"]])], // Google source needs a colour
      [`passCategories.${g}.${w}`, wire([["color:12", "Focus"]])],
      [`passCategories.${g}.${w}`, wire([["color:3", "a,b"]])], // comma in an Outlook name
      [`passCategories.${g}.${w}`, wire([["color:3", ""]])], // no target name
      [`passCategories.${w}.${g}`, wire([["a,b", "3"]])],
      [`passCategories.${w}.${g}`, wire([["x".repeat(101), "3"]])],
      [`passCategories.${w}.${g}`, wire([["Focus", "12"]])], // not a Google colour
      [`passCategories.${w}.${g}`, wire([["Focus", "Blue"]])],
      [`passCategories.${w}.${g}`, "not json"],
      [`passCategories.${w}.${g}`, JSON.stringify([["Focus"]])],
      [`passCategories.${w}.${g}`, wire(Array.from({ length: 51 }, (_, i) => [`c${i}`, "3"]))],
    ];
    for (const [name, value] of bad) {
      const response = await saveAll(cookie, { ...valid, [name]: value });
      expect(response.status, `${name}=${value}`).toBe(400);
    }
    expect(await passOf(`${w}-cal`)).toEqual([]);
    expect(await passOf(`${g}-cal`)).toEqual([]);
  });

  it("refuses a list for a direction that does not exist", async () => {
    const { user, cookie, w, g } = await setup("passgone");
    await setDirection(env, user, w, g, "busy");
    const response = await saveAll(cookie, {
      [`passCategories.${w}.no-such-account`]: wire([["Focus", "3"]]),
    });
    expect(response.status).toBe(400);
  });

  it("stores rows from the form without the script, Outlook to Google", async () => {
    const { user, cookie, w, g } = await setup("passojs");
    await setDirection(env, user, w, g, "busy");
    const body = rowsForm(w, g, [
      ["Focus", "3"],
      [" Reise; privat", "6"],
      ["", ""], // the empty row
    ]);
    expect((await saveWithoutScript(cookie, body)).status).toBe(302);
    expect(await passOf(`${w}-cal`)).toEqual([
      { from: "Focus", to: "3", tentative: false },
      { from: "Reise; privat", to: "6", tentative: false },
    ]);
  });

  it("drops a row whose name is cleared, and refuses a name without a colour", async () => {
    const { user, cookie, w, g } = await setup("passclear");
    await setDirection(env, user, w, g, "busy");
    await saveAll(cookie, {
      [`passCategories.${w}.${g}`]: wire([["Focus", "3"]]),
    });
    expect((await saveWithoutScript(cookie, rowsForm(w, g, [["", "3"]]))).status).toBe(302);
    expect(await passOf(`${w}-cal`)).toEqual([]);
    expect((await saveWithoutScript(cookie, rowsForm(w, g, [["Focus", ""]]))).status).toBe(400);
    expect(await passOf(`${w}-cal`)).toEqual([]);
  });

  it("stores rows from the form without the script, Google to Outlook", async () => {
    const { user, cookie, w, g } = await setup("passgjs");
    await setDirection(env, user, g, w, "busy");
    const body = rowsForm(g, w, [
      ["color:5", "Focus"],
      ["", ""], // the empty row has no colour and no name
    ]);
    expect((await saveWithoutScript(cookie, body)).status).toBe(302);
    expect(await passOf(`${g}-cal`)).toEqual([{ from: "color:5", to: "Focus", tentative: false }]);
  });

  it("stores a name list between Outlook calendars and colours between Google calendars", async () => {
    const { user, cookie, w, o } = await setup("passkinds");
    // A second Google account for a Google to Google direction.
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, ?, ?)",
      ).bind("passkinds-g2", user.id, "google", "passkinds2@gmail.com"),
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, ?, 'Main', 1, 1, 1)",
      ).bind("passkinds-g2-cal", "passkinds-g2", "passkinds-g2-remote"),
    ]);
    await env.ACCOUNT_SYNC.getByName("passkinds-g2").storeTokens(
      "passkinds-g2",
      {
        refreshToken: "r",
        accessToken: "a",
        accessExpiresAt: Date.now() + 3_600_000,
      },
      "google",
    );
    const g = "passkinds-g";
    await setDirection(env, user, w, o, "busy");
    await setDirection(env, user, g, "passkinds-g2", "busy");
    const names = new URLSearchParams({
      from: w,
      to: o,
      passCategoriesShown: "1",
    });
    names.append("passCategories", "Focus, Deep,, focus");
    await saveWithoutScript(cookie, names);
    expect(await passOf(`${w}-cal`)).toEqual([
      { from: "Focus", to: "", tentative: false },
      { from: "Deep", to: "", tentative: false },
    ]);
    const colours = new URLSearchParams({
      from: g,
      to: "passkinds-g2",
      passCategoriesShown: "1",
    });
    colours.append("passColor", "color:5");
    colours.append("passColor", "color:11");
    await saveWithoutScript(cookie, colours);
    expect(await passOf(`${g}-cal`)).toEqual([
      { from: "color:5", to: "", tentative: false },
      { from: "color:11", to: "", tentative: false },
    ]);
  });

  it("keeps the list if a page from before the option saves its details", async () => {
    const { user, cookie, w, g } = await setup("passstale");
    await setDirection(env, user, w, g, "busy");
    await saveAll(cookie, {
      [`passCategories.${w}.${g}`]: wire([["Focus", "3"]]),
    });
    await saveWithoutScript(cookie, new URLSearchParams({ from: w, to: g, blockColor: "3" }));
    await saveAll(cookie, { [`blockColor.${w}.${g}`]: "5" });
    expect(await passOf(`${w}-cal`)).toEqual([{ from: "Focus", to: "3", tentative: false }]);
  });

  it("logs the count of pairs, not the names", async () => {
    const { user, cookie, w, g } = await setup("passaudit");
    await setDirection(env, user, w, g, "busy");
    await saveAll(cookie, {
      [`passCategories.${w}.${g}`]: wire([
        ["Geheimkunde", "3"],
        ["Zweite", "4"],
      ]),
    });
    const row = await env.DB.prepare(
      "SELECT detail FROM audit_events WHERE user_id = ? AND kind = 'rule_updated' ORDER BY id DESC",
    )
      .bind(user.id)
      .first<{ detail: string }>();
    expect(JSON.parse(row?.detail ?? "{}")).toMatchObject({ passCategories: "2" });
    expect(row?.detail).not.toContain("Geheimkunde");
    expect(row?.detail).not.toContain("Zweite");
  });

  it("clears the list when a direction is reset to the group", async () => {
    const { user, cookie, w, g } = await setup("passreset");
    await setGroupMembership(env, user, w, true);
    await setGroupMembership(env, user, g, true);
    await setDirection(env, user, w, g, "title");
    await saveAll(cookie, { [`passCategories.${w}.${g}`]: wire([["Focus", "3"]]) });
    expect(await passOf(`${w}-cal`, `${g}-cal`)).toEqual([
      { from: "Focus", to: "3", tentative: false },
    ]);

    await resetDirection(env, user, w, g);
    const state = await loadEditorState(env, user.id);
    const direction = state.directions.find((d) => d.from === w && d.to === g);
    expect(direction).toMatchObject({ choice: "busy", origin: "group" });
    expect(direction?.options?.passCategories).toEqual([]);
  });

  it("refuses the same name list with and without the script", async () => {
    const { user, cookie, w, o } = await setup("passparity");
    await setDirection(env, user, w, o, "busy");
    const long = "x".repeat(101);
    const many = Array.from({ length: 51 }, (_, index) => `Name ${index}`);
    for (const names of [[long], many]) {
      const scripted = await saveAll(cookie, {
        [`passCategories.${w}.${o}`]: wire(names.map((name) => [name, ""])),
      });
      expect(scripted.status).toBe(400);
      const body = new URLSearchParams({ from: w, to: o, passCategoriesShown: "1" });
      body.append("passCategories", names.join(", "));
      expect((await saveWithoutScript(cookie, body)).status).toBe(400);
      expect(await passOf(`${w}-cal`)).toEqual([]);
    }
  });

  it("refuses a name without a colour from Google to Outlook, on both paths", async () => {
    const { user, cookie, w, g } = await setup("passnocolor");
    await setDirection(env, user, g, w, "busy");
    await saveAll(cookie, { [`passCategories.${g}.${w}`]: wire([["color:5", "Focus"]]) });
    const scripted = await saveAll(cookie, {
      [`passCategories.${g}.${w}`]: wire([["", "Deep"]]),
    });
    expect(scripted.status).toBe(400);
    expect((await saveWithoutScript(cookie, rowsForm(g, w, [["", "Deep"]]))).status).toBe(400);
    expect(await passOf(`${g}-cal`)).toEqual([{ from: "color:5", to: "Focus", tentative: false }]);
  });

  describe("tentative copies", () => {
    /** The no-script form with rows and the indexes of the ticked "Tentative" boxes. */
    function tentativeForm(from: string, to: string, rows: [string, string][], ticked: number[]) {
      const body = rowsForm(from, to, rows);
      for (const index of ticked) body.append("passTentative", String(index));
      return body;
    }

    it("stores triples from Google to Outlook and still takes pairs", async () => {
      const { user, cookie, w, g } = await setup("tentbatch");
      await setDirection(env, user, g, w, "busy");
      const response = await saveAll(cookie, {
        [`passCategories.${g}.${w}`]: JSON.stringify([
          ["color:5", "Focus", true],
          ["color:6", "Deep", false],
          ["color:7", "Travel"],
        ]),
      });
      expect(response.status).toBe(204);
      expect(await passOf(`${g}-cal`)).toEqual([
        { from: "color:5", to: "Focus", tentative: true },
        { from: "color:6", to: "Deep", tentative: false },
        { from: "color:7", to: "Travel", tentative: false },
      ]);
    });

    it("refuses a tentative row for every other direction, and a third value that is no boolean", async () => {
      const { user, cookie, w, o, g } = await setup("tentdir");
      await setDirection(env, user, w, g, "busy");
      await setDirection(env, user, w, o, "busy");
      await setDirection(env, user, g, w, "busy");
      const bad: [string, unknown[][]][] = [
        [`passCategories.${w}.${g}`, [["Focus", "3", true]]],
        [`passCategories.${w}.${o}`, [["Focus", "", true]]],
        [`passCategories.${g}.${w}`, [["color:5", "Focus", "yes"]]],
        [`passCategories.${g}.${w}`, [["color:5", "Focus", true, true]]],
      ];
      for (const [name, value] of bad) {
        const response = await saveAll(cookie, { [name]: JSON.stringify(value) });
        expect(response.status, `${name}=${JSON.stringify(value)}`).toBe(400);
      }
      expect(await passOf(`${w}-cal`, `${g}-cal`)).toEqual([]);
      expect(await passOf(`${w}-cal`, `${o}-cal`)).toEqual([]);
      expect(await passOf(`${g}-cal`)).toEqual([]);
      // A false mark is the plain row, which fits every direction.
      expect(
        (await saveAll(cookie, { [`passCategories.${w}.${g}`]: '[["Focus", "3", false]]' })).status,
      ).toBe(204);
      expect(await passOf(`${w}-cal`, `${g}-cal`)).toEqual([
        { from: "Focus", to: "3", tentative: false },
      ]);
    });

    it("keeps the first row of a repeated pair with another mark", async () => {
      const { user, cookie, w, g } = await setup("tentrepeat");
      await setDirection(env, user, g, w, "busy");
      for (const [first, second] of [
        [true, false],
        [false, true],
      ]) {
        const response = await saveAll(cookie, {
          [`passCategories.${g}.${w}`]: JSON.stringify([
            ["color:5", "Focus", first],
            ["color:5", "focus", second],
          ]),
        });
        expect(response.status).toBe(204);
        expect(await passOf(`${g}-cal`)).toEqual([
          { from: "color:5", to: "Focus", tentative: first },
        ]);
      }
    });

    it("maps each ticked box of the form without the script to its row", async () => {
      const { user, cookie, w, g } = await setup("tentform");
      await setDirection(env, user, g, w, "busy");
      const rows: [string, string][] = [
        ["color:5", "Focus"],
        ["color:6", "Deep"],
        ["", ""],
      ];
      // The empty row is ticked too: a row without a name is no row, whatever its box says.
      expect((await saveWithoutScript(cookie, tentativeForm(g, w, rows, [1, 2]))).status).toBe(302);
      expect(await passOf(`${g}-cal`)).toEqual([
        { from: "color:5", to: "Focus", tentative: false },
        { from: "color:6", to: "Deep", tentative: true },
      ]);
      // A cleared first row does not move the box of the second one.
      const cleared: [string, string][] = [
        ["color:5", ""],
        ["color:6", "Deep"],
      ];
      expect((await saveWithoutScript(cookie, tentativeForm(g, w, cleared, [1]))).status).toBe(302);
      expect(await passOf(`${g}-cal`)).toEqual([{ from: "color:6", to: "Deep", tentative: true }]);
      // An unticked box clears the mark.
      expect((await saveWithoutScript(cookie, tentativeForm(g, w, cleared, []))).status).toBe(302);
      expect(await passOf(`${g}-cal`)).toEqual([{ from: "color:6", to: "Deep", tentative: false }]);
    });

    it("refuses a ticked box from Outlook to Google on both paths", async () => {
      const { user, cookie, w, g } = await setup("tentparity");
      await setDirection(env, user, w, g, "busy");
      const scripted = await saveAll(cookie, {
        [`passCategories.${w}.${g}`]: JSON.stringify([["Focus", "3", true]]),
      });
      expect(scripted.status).toBe(400);
      const plain = await saveWithoutScript(cookie, tentativeForm(w, g, [["Focus", "3"]], [0]));
      expect(plain.status).toBe(400);
      expect(await passOf(`${w}-cal`)).toEqual([]);
    });

    it("logs the count when only a mark changes, not the names", async () => {
      const { user, cookie, w, g } = await setup("tentaudit");
      await setDirection(env, user, g, w, "busy");
      await saveAll(cookie, { [`passCategories.${g}.${w}`]: '[["color:5", "Geheimkunde"]]' });
      await saveAll(cookie, {
        [`passCategories.${g}.${w}`]: '[["color:5", "Geheimkunde", true]]',
      });
      const { results } = await env.DB.prepare(
        "SELECT detail FROM audit_events WHERE user_id = ? AND kind = 'rule_updated' ORDER BY id DESC",
      )
        .bind(user.id)
        .all<{ detail: string }>();
      expect(results).toHaveLength(2);
      expect(JSON.parse(results[0]?.detail ?? "{}")).toMatchObject({ passCategories: "1" });
      expect(results[0]?.detail).not.toContain("Geheimkunde");
    });
  });
});

describe("reconnect", () => {
  it("clears the flag when the account is connected again", async () => {
    const { user, w } = await setup("reconnect");
    await env.DB.prepare("UPDATE accounts SET needs_reconnect = 1 WHERE id = ?").bind(w).run();
    let state = await loadEditorState(env, user.id);
    expect(state.accounts.find((a) => a.id === w)?.needsReconnect).toBe(true);
    await env.DB.prepare("UPDATE accounts SET needs_reconnect = 0 WHERE id = ?").bind(w).run();
    state = await loadEditorState(env, user.id);
    expect(state.accounts.find((a) => a.id === w)?.needsReconnect).toBe(false);
  });
});

describe("onboarding", () => {
  it("puts every account into the block group with one click", async () => {
    const { user, cookie } = await setup("quick");
    const page = await (
      await exports.default.fetch(`${BASE}/rules`, { headers: { cookie } })
    ).text();
    expect(page).toContain('action="/rules/group/all"');

    const response = await exports.default.fetch(`${BASE}/rules/group/all`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie },
    });
    expect(response.status).toBe(302);
    const rules = await rulesOf(user.id);
    expect(rules).toHaveLength(6);
    expect(rules.every((rule) => rule.origin === "group")).toBe(true);
  });
});

describe("check with real events", () => {
  it("dry-runs every source calendar of a direction and sums the result", async () => {
    const { user, cookie, w, g } = await setup("checkall");
    await env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES ('checkall-extra', ?, 'extra', 'Extra', 0, 0, 1)",
    )
      .bind(g)
      .run();
    await setDirection(env, user, g, w, "busy");
    expect((await rulesOf(user.id)).filter((rule) => rule.source === g)).toHaveLength(2);

    // Both source calendars hold one event; the target holds nothing yet.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("googleapis.com/calendar") && url.includes("/events"))
        return Response.json({
          items: [
            {
              id: url.includes("extra") ? "e2" : "e1",
              start: { dateTime: new Date(Date.now() + 86_400_000).toISOString() },
              end: { dateTime: new Date(Date.now() + 90_000_000).toISOString() },
              summary: "x",
            },
          ],
        });
      if (url.includes("calendarView")) return Response.json({ value: [] });
      return new Response("unexpected", { status: 500 });
    });
    const response = await exports.default.fetch(`${BASE}/rules/direction/check`, {
      method: "POST",
      headers: { cookie, "x-fragment": "1", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ from: g, to: w }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Next sync: 2 new, 0 changed, 0 removed");
  });
});

describe("block buffer per source", () => {
  const optionsOf = async (userId: string, from: string, to: string) =>
    (await loadEditorState(env, userId)).directions.find((d) => d.from === from && d.to === to)
      ?.options;
  /** Buffers of every rule from an account, as "before,after". */
  const buffersFrom = async (userId: string, accountId: string) => {
    const { results } = await env.DB.prepare(
      `SELECT json_extract(r.options, '$.bufferBefore') || ',' ||
              json_extract(r.options, '$.bufferAfter') AS buffer
       FROM rules r JOIN calendars sc ON sc.id = r.source_calendar_id
       WHERE r.user_id = ? AND sc.account_id = ? ORDER BY r.id`,
    )
      .bind(userId, accountId)
      .all<{ buffer: string }>();
    return results.map((row) => row.buffer);
  };
  const saver = (cookie: string) => (fields: Record<string, string>) =>
    exports.default.fetch(`${BASE}/rules/choices`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        "x-fragment": "1",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(fields),
    });
  it("saves one buffer for every rule of a source from the page, and refuses invalid values", async () => {
    const { user, cookie, w, o, g } = await setup("buf");
    await setDirection(env, user, w, g, "busy");
    await setDirection(env, user, w, o, "title");
    await setDirection(env, user, g, w, "busy");
    await env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, 'side', 'Side', 1, 0, 0)",
    )
      .bind(`${w}-side`, w)
      .run();
    await setSourceCalendar(env, user, `${w}-side`, true);
    expect(await buffersFrom(user.id, w)).toHaveLength(4);
    const save = saver(cookie);

    const saved = await save({ [`bufferBefore.${w}`]: "30", [`bufferAfter.${w}`]: "30" });
    expect(saved.status).toBe(204);
    expect(await buffersFrom(user.id, w)).toEqual(["30,30", "30,30", "30,30", "30,30"]);
    // Another source keeps its own.
    expect(await buffersFrom(user.id, g)).toEqual(["0,0"]);

    // A missing field is 0.
    expect((await save({ [`bufferBefore.${w}`]: "15" })).status).toBe(204);

    // Settings for all rules keep the buffer of each source.
    await save({ settings: "1", "settings.daysAhead": "30" });
    expect(await optionsOf(user.id, w, g)).toMatchObject({ bufferBefore: 15, daysAhead: 30 });

    for (const value of ["241", "-5", "1.5", "abc"]) {
      const refused = await save({ [`bufferAfter.${w}`]: value });
      expect(refused.status).toBe(400);
      expect(await refused.text()).toBe(
        "A buffer is a whole number of minutes from 0 to 240. Nothing was saved.",
      );
    }
    expect(await buffersFrom(user.id, w)).toEqual(["15,0", "15,0", "15,0", "15,0"]);
  });

  it('shows "differs" for rules with different buffers, and a save sets one for all', async () => {
    const { user, cookie, w, o, g } = await setup("bufmix");
    await setDirection(env, user, w, g, "busy");
    await setDirection(env, user, w, o, "busy");
    // Rules from before the buffer belonged to the source can differ.
    await env.DB.prepare(
      `UPDATE rules SET options = json_set(options, '$.bufferBefore', 10)
       WHERE target_calendar_id = ?`,
    )
      .bind(`${g}-cal`)
      .run();
    // A save of other things leaves the buffers as they are.
    const save = saver(cookie);
    expect((await save({ [`choice.${g}.${w}`]: "busy" })).status).toBe(204);
    expect((await buffersFrom(user.id, w)).sort()).toEqual(["0,0", "10,0"]);

    expect((await save({ [`bufferBefore.${w}`]: "5", [`bufferAfter.${w}`]: "5" })).status).toBe(
      204,
    );
    expect(await buffersFrom(user.id, w)).toEqual(["5,5", "5,5"]);
  });

  it("gives a new direction of a source the source's buffer", async () => {
    const { user, cookie, w, o, g } = await setup("bufnew");
    await setDirection(env, user, w, g, "busy");
    expect((await saver(cookie)({ [`bufferBefore.${w}`]: "20" })).status).toBe(204);
    await setDirection(env, user, w, o, "title");
    expect(await optionsOf(user.id, w, o)).toMatchObject({ bufferBefore: 20, bufferAfter: 0 });
    // So do the group's rules.
    await setGroupMembership(env, user, w, true);
    await setGroupMembership(env, user, o, true);
    await setGroupMembership(env, user, g, true);
    expect(await buffersFrom(user.id, w)).toEqual(["20,0", "20,0"]);
    // The other sources had no buffer; their new group rules have none either.
    expect(await buffersFrom(user.id, o)).toEqual(["0,0", "0,0"]);
  });

  it("saves nothing from a page save with one invalid value", async () => {
    const { user, cookie, w, o, g } = await setup("bufall");
    await env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES ('bufall-team', ?, 'team', 'Team', 0, 0, 0)",
    )
      .bind(w)
      .run();
    await setDirection(env, user, w, g, "busy");
    const save = saver(cookie);
    const valid = {
      "calendar.bufall-team": "1",
      [`choice.${w}.${o}`]: "title",
      [`blockColor.${w}.${g}`]: "5",
      [`bufferBefore.${w}`]: "15",
      settings: "1",
      "settings.daysAhead": "30",
    };
    for (const invalid of [
      { [`bufferAfter.${w}`]: "300" },
      { [`choice.${w}.${o}`]: "everything" },
      { [`blockColor.${w}.${g}`]: "Focus" },
      { [`bufferAfter.unknown`]: "5" },
    ]) {
      expect((await save({ ...valid, ...invalid })).status).toBe(400);
    }
    expect(await rulesOf(user.id)).toEqual([
      expect.objectContaining({ source: w, target: g, level: "busy" }),
    ]);
    expect(await optionsOf(user.id, w, g)).toMatchObject({
      blockColor: "",
      bufferBefore: 0,
      bufferAfter: 0,
      daysAhead: 90,
    });
    const calendar = await env.DB.prepare("SELECT is_source FROM calendars WHERE id = ?")
      .bind("bufall-team")
      .first<{ is_source: number }>();
    expect(calendar?.is_source).toBe(0);

    expect((await save(valid)).status).toBe(204);
    expect(await optionsOf(user.id, w, g)).toMatchObject({ blockColor: "5", bufferBefore: 15 });
    // The direction turned on in the same save got the buffer too.
    expect(await optionsOf(user.id, w, o)).toMatchObject({ bufferBefore: 15 });
  });

  it("saves from the form without the editor script, and a reset keeps the buffer", async () => {
    const { user, cookie, w, o, g } = await setup("bufform");
    await setGroupMembership(env, user, w, true);
    await setGroupMembership(env, user, g, true);
    await setDirection(env, user, w, g, "title");
    await setDirection(env, user, w, o, "busy");
    const response = await exports.default.fetch(`${BASE}/rules/source/buffer`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ from: w, bufferBefore: "240", bufferAfter: "" }),
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/rules#src-${w}`);
    expect(await buffersFrom(user.id, w)).toEqual(["240,0", "240,0"]);

    // The buffer belongs to the source; resetting one direction does not change it.
    await resetDirection(env, user, w, g);
    expect(await optionsOf(user.id, w, g)).toMatchObject({
      detailLevel: "busy",
      bufferBefore: 240,
    });
    expect(await buffersFrom(user.id, w)).toEqual(["240,0", "240,0"]);
  });

  it("refuses an invalid buffer from the form and stores nothing", async () => {
    const { user, cookie, w, g } = await setup("bufbad");
    await setDirection(env, user, w, g, "busy");
    for (const fields of [
      { from: w, bufferBefore: "999", bufferAfter: "10" },
      { from: w, bufferBefore: "10", bufferAfter: "-5" },
      { from: w, bufferBefore: "1.5", bufferAfter: "10" },
      { from: w, bufferBefore: "10", bufferAfter: "abc" },
      { from: "nobody", bufferBefore: "10", bufferAfter: "10" },
    ]) {
      const response = await exports.default.fetch(`${BASE}/rules/source/buffer`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields),
      });
      expect(response.status).toBe(400);
    }
    expect(await buffersFrom(user.id, w)).toEqual(["0,0"]);
    const buffer = { bufferBefore: 999, bufferAfter: 0 };
    expect(await setRuleDetails(env, user, { sources: [{ from: w, options: buffer }] })).toBe(
      false,
    );
    expect(await buffersFrom(user.id, w)).toEqual(["0,0"]);
  });

  it("stores the buffer of a source without rules on its account", async () => {
    const { user, w } = await setup("bufoff");
    const buffer = { bufferBefore: 10, bufferAfter: 10 };
    expect(await setRuleDetails(env, user, { sources: [{ from: w, options: buffer }] })).toBe(true);
    expect(await buffersFrom(user.id, w)).toEqual([]);
  });
});
