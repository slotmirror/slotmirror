import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDirection, setDirections, setGroupMembership } from "../src/editor";
import { LEVELS, loadEditorState, parseLevel, type Level } from "../src/editor";
import { de } from "../src/i18n/de";
import { en } from "../src/i18n/en";
import { changeEffect, marksMixed } from "../src/pages/next/levels";
import { BASE, signIn } from "./helpers";

/** A user with three accounts (two Microsoft, one Google), each with one main calendar. */
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

/** The stored options of the rule between two accounts, or null if there is none. */
async function ruleOptions(source: string, target: string) {
  const row = await env.DB.prepare(
    `SELECT r.options, r.enabled FROM rules r
     JOIN calendars sc ON sc.id = r.source_calendar_id
     JOIN calendars tc ON tc.id = r.target_calendar_id
     WHERE sc.account_id = ? AND tc.account_id = ?`,
  )
    .bind(source, target)
    .first<{ options: string; enabled: number }>();
  return row ? { ...JSON.parse(row.options), enabled: row.enabled === 1 } : null;
}

function get(path: string, cookie: string, language = "en") {
  return exports.default.fetch(`${BASE}${path}`, {
    headers: { cookie, "accept-language": language },
    redirect: "manual",
  });
}

function postForm(fields: Record<string, string>, cookie: string, language = "en") {
  return exports.default.fetch(`${BASE}/mirroring`, {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie,
      "content-type": "application/x-www-form-urlencoded",
      "accept-language": language,
    },
    body: new URLSearchParams(fields),
  });
}

/** The form of a mirroring panel as a browser sends it for the level and no detail. */
function levelForm(from: string, to: string, extra: Record<string, string> = {}) {
  return {
    scope: "direction",
    from,
    to,
    back: `/mirroring?d=${from}~${to}&saved=1`,
    ...extra,
  };
}

beforeEach(() => {
  // Removing blocks and syncing read the target calendar; it is empty in these tests.
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

describe("mirroring list", () => {
  it("groups the directions by target, one row per source", async () => {
    const { user, cookie, w, o, g } = await setup("nmlist");
    for (const id of [w, o, g]) await setGroupMembership(env, user, id, true);
    const html = await (await get("/mirroring", cookie)).text();
    const groups = html.split('<section class="list-group">').slice(1);
    expect(groups).toHaveLength(3);
    for (const [target, name] of [
      [w, "work"],
      [o, "other"],
      [g, "Gmail"],
    ] as const) {
      const group = groups.find((section) => section.includes(`Appears in ${name}`));
      expect(group, `group of ${name}`).toBeDefined();
      const hrefs = [...(group ?? "").matchAll(/href="\/mirroring\?d=([^"]+)"/g)].map(
        (match) => match[1] ?? "",
      );
      const sources = [w, o, g].filter((id) => id !== target);
      const byName = (a: string, b: string) => a.localeCompare(b);
      expect(hrefs.toSorted(byName)).toEqual(
        sources.map((id) => `${id}~${target}`).toSorted(byName),
      );
    }
  });

  it("shows the level and keeps a mirroring that is not copied in the list", async () => {
    const { user, cookie, w, o, g } = await setup("nmlevel");
    await setDirection(env, user, w, g, "busy");
    const html = await (await get("/mirroring", cookie)).text();
    expect(html).toContain(`href="/mirroring?d=${w}~${g}"`);
    expect(html).toContain(`href="/mirroring?d=${o}~${g}"`);
    expect(html).toContain("Busy only");
    expect(html).toContain("Not copied");
  });

  it("asks for a second calendar if only one is ready", async () => {
    const { user, cookie } = await signIn("nmempty@org.example");
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, provider, email) VALUES ('nmempty-a', ?, 'microsoft', 'a@work.example')",
      ).bind(user.id),
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES ('nmempty-a-cal', 'nmempty-a', 'r', 'Main', 1, 1, 1)",
      ),
    ]);
    const html = await (await get("/mirroring", cookie)).text();
    expect(html).toContain("Connect a second calendar");
    expect(html).toContain('href="/calendars"');
    expect(html).not.toContain('class="list-group"');
  });
});

describe("mirroring panel", () => {
  it("opens for a direction of the state and for nothing else", async () => {
    const { user, cookie, w, g } = await setup("nmpanel");
    await setDirection(env, user, w, g, "busy");
    const open = async (d: string) => (await get(`/mirroring?d=${d}`, cookie)).text();
    const valid = await open(`${w}~${g}`);
    expect(valid).toContain('class="detail"');
    expect(valid).toContain('name="copy"');
    expect(valid).toContain('name="who"');
    expect(valid).toContain('<input type="hidden" name="back"');
    for (const bad of [`${w}~${w}`, "nope~nada", `${w}~${g}~${w}`, "", `${g}`]) {
      expect(await open(bad), bad).not.toContain('class="detail"');
    }
  });

  it("speaks German", async () => {
    const { cookie, w, g } = await setup("nmde");
    const html = await (await get(`/mirroring?d=${w}~${g}`, cookie, "de")).text();
    expect(html).toContain("Was kopiert wird");
    expect(html).toContain("Was andere sehen");
    expect(html).toContain("Privater Termin");
    expect(html).toContain("Wie bei dir");
  });
});

describe("saving a mirroring", () => {
  it("stores title + private event as the level title-private and returns to the panel", async () => {
    const { user, cookie, w, g } = await setup("nmsave");
    await setDirection(env, user, w, g, "busy");
    const response = await postForm(levelForm(w, g, { copy: "title", who: "private" }), cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/mirroring?d=${w}~${g}&saved=1`);
    expect(await ruleOptions(w, g)).toMatchObject({
      detailLevel: "title",
      markPrivate: true,
      enabled: true,
    });
    // The list shows the new level on the same page.
    const html = await (await get(`/mirroring?d=${w}~${g}&saved=1`, cookie)).text();
    expect(html).toContain("Title, private");
    expect(html).toContain("Saved");
  });

  it("stores title + everyone as title-open, and busy with the answer to who sees it", async () => {
    const { cookie, w, g } = await setup("nmopen");
    await postForm(levelForm(w, g, { copy: "title", who: "open" }), cookie);
    expect(await ruleOptions(w, g)).toMatchObject({ detailLevel: "title", markPrivate: false });
    await postForm(levelForm(w, g, { copy: "busy", who: "open" }), cookie);
    expect(await ruleOptions(w, g)).toMatchObject({ detailLevel: "busy", markPrivate: false });
    // No answer is no "open": the copies become private (fail closed).
    await postForm(levelForm(w, g, { copy: "busy" }), cookie);
    expect(await ruleOptions(w, g)).toMatchObject({ detailLevel: "busy", markPrivate: true });
    await postForm(levelForm(w, g, { copy: "off", who: "private" }), cookie);
    expect(await ruleOptions(w, g)).toBeNull();
  });

  it("ignores a back address outside /", async () => {
    const { cookie, w, g } = await setup("nmback");
    for (const back of [
      "https://evil.example/x",
      "//evil.example",
      "/rules",
      "/nextx",
      "/next//x",
    ]) {
      const response = await postForm(levelForm(w, g, { copy: "busy", who: "open", back }), cookie);
      expect(response.status, back).toBe(303);
      expect(response.headers.get("location"), back).toBe("/mirroring");
    }
  });

  it("stores level, colour and filter from one request", async () => {
    const { cookie, w, o } = await setup("nmdetails");
    const response = await postForm(
      levelForm(w, o, {
        copy: "title",
        who: "open",
        blockColor: "Work",
        onlyCategoriesShown: "1",
        onlyCategories: "Customer, Work",
      }),
      cookie,
    );
    expect(response.status).toBe(303);
    expect(await ruleOptions(w, o)).toMatchObject({
      detailLevel: "title",
      markPrivate: false,
      blockColor: "Work",
      onlyCategories: ["Customer", "Work"],
    });
  });

  it("refuses an invalid detail with the reason in the panel, keeps the input, saves nothing", async () => {
    const { cookie, w, o } = await setup("nmerror");
    const response = await postForm(
      levelForm(w, o, { copy: "title", who: "open", blockColor: "a,b" }),
      cookie,
    );
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain("A category name cannot contain a comma");
    expect(html).toContain('value="a,b"');
    expect(html).toContain('class="detail"');
    expect(await ruleOptions(w, o)).toBeNull();
  });

  it("refuses an unknown level before any write", async () => {
    const { cookie, w, g } = await setup("nmbadlevel");
    const response = await postForm(levelForm(w, g, { copy: "everything" }), cookie);
    expect(response.status).toBe(400);
    expect(await ruleOptions(w, g)).toBeNull();
  });

  it("refuses a direction that the state does not have", async () => {
    const { cookie, w } = await setup("nmstale");
    const response = await postForm(levelForm(w, "nobody", { copy: "busy" }), cookie);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('class="detail"');
  });

  it("writes nothing for a form without changes", async () => {
    const { user, cookie, w, g } = await setup("nmquiet");
    await setDirection(env, user, w, g, "busy");
    const before = await env.DB.prepare(
      "SELECT (SELECT options FROM rules WHERE user_id = ?) AS options, (SELECT COUNT(*) FROM audit_events WHERE user_id = ?) AS audits",
    )
      .bind(user.id, user.id)
      .first();
    const markPrivate = (await ruleOptions(w, g))?.markPrivate ? "private" : "open";
    const response = await postForm(
      levelForm(w, g, {
        copy: "busy",
        who: markPrivate,
        blockColor: "",
        onlyCategoriesShown: "1",
        onlyCategories: "",
      }),
      cookie,
    );
    expect(response.status).toBe(303);
    const after = await env.DB.prepare(
      "SELECT (SELECT options FROM rules WHERE user_id = ?) AS options, (SELECT COUNT(*) FROM audit_events WHERE user_id = ?) AS audits",
    )
      .bind(user.id, user.id)
      .first();
    expect(after).toEqual(before);
  });
});

describe("settings for all mirrorings", () => {
  it("explains how far ahead events are copied, and links the hint to the control", async () => {
    const { cookie } = await setup("nmwindow");
    for (const [language, hint] of [
      ["en", "Events up to this many days from today are copied."],
      ["de", "Termine bis zu so vielen Tagen ab heute werden kopiert."],
    ] as const) {
      const html = await (await get("/mirroring?d=all", cookie, language)).text();
      expect(html, language).toContain(`>${hint}<`);
      expect(html, language).toMatch(/id="[^"]*window[^"]*-hint"/);
      expect(html, language).toMatch(/name="daysAhead"/);
    }
  });
});

describe("saving all mirrorings", () => {
  it("stores the settings and returns to the panel", async () => {
    const { user, cookie } = await setup("nmall");
    const response = await postForm(
      {
        scope: "all",
        back: "/mirroring?d=all&saved=1",
        daysAhead: "30",
        daysAheadShown: "60",
        skipAllDayShown: "0",
        markPrivateShown: "0",
        blockTitle: "Away",
        skipCategories: "Private",
        skipTentative: "1",
      },
      cookie,
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/mirroring?d=all&saved=1");
    const row = await env.DB.prepare("SELECT sync_settings AS json FROM users WHERE id = ?")
      .bind(user.id)
      .first<{ json: string }>();
    expect(JSON.parse(row?.json ?? "{}")).toMatchObject({
      blockTitle: "Away",
      daysAhead: 30,
      skipTentative: true,
      skipCategories: ["Private"],
    });
  });
});

describe("save bar notes of a mirroring", () => {
  it("names who sees more, as a warning with its own button label only if it widens", async () => {
    const { user, cookie, w, g } = await setup("nmwiden");
    await setDirection(env, user, w, g, "busy");
    const html = await (await get(`/mirroring?d=${w}~${g}`, cookie)).text();
    const notes = [...html.matchAll(/<p data-note[^>]*data-sentence="([^"]+)"[^>]*>/g)];
    const byLevel = Object.fromEntries(notes.map((match) => [match[1], match[0]]));
    // No note for the level that is stored, none for a level that shows less, except that the
    // copies go at "Not copied".
    expect(Object.keys(byLevel).toSorted()).toEqual([
      "busy-open",
      "full-open",
      "full-private",
      "off",
      "title-open",
      "title-private",
    ]);
    expect(byLevel.off).not.toContain("data-warn");
    // Busy with everyone shows the copy's own title: more, but no warning.
    expect(byLevel["busy-open"]).not.toContain("data-warn");
    expect(byLevel["busy-open"]).not.toContain("data-button");
    expect(byLevel["title-open"]).toContain("data-warn");
    expect(byLevel["title-open"]).toContain(
      `data-button="${en.next.mirroring.bar.button["title-open"]}"`,
    );
    expect(byLevel["full-open"]).toContain("data-warn");
    // Others still see "Private": more for you, no wider audience, plain Save.
    expect(byLevel["title-private"]).not.toContain("data-warn");
    expect(byLevel["title-private"]).not.toContain("data-button");
  });

  it("has no warning for a level that shows less than the stored one", async () => {
    const { user, cookie, w, g } = await setup("nmless");
    await setDirections(env, user, [{ from: w, to: g, choice: "full", markPrivate: false }]);
    const html = await (await get(`/mirroring?d=${w}~${g}`, cookie)).text();
    const notes = [...html.matchAll(/<p data-note[^>]*data-sentence="([^"]+)"[^>]*>/g)];
    // What others still see at a lower open level, what they see again at a private one, and
    // that the copies go when it is off.
    expect(notes.map((match) => match[1] ?? "").toSorted((a, b) => a.localeCompare(b))).toEqual([
      "busy-open",
      "busy-private",
      "full-private",
      "off",
      "title-open",
      "title-private",
    ]);
    for (const match of notes) expect(match[0]).not.toContain("data-warn");
  });
});

describe("changeEffect", () => {
  it("separates a wider audience from more for the owner and from less", () => {
    expect(changeEffect("busy-private", "title-open")).toBe("widens");
    expect(changeEffect("busy-open", "title-open")).toBe("widens");
    expect(changeEffect("off", "full-open")).toBe("widens");
    expect(changeEffect("title-open", "full-open")).toBe("widens");
    expect(changeEffect("busy-private", "title-private")).toBe("more");
    expect(changeEffect("off", "busy-private")).toBe("more");
    // Turned on with "Same as you": others see the copies, so the panel warns.
    expect(changeEffect("off", "busy-open")).toBe("widens");
    expect(changeEffect("off", "title-open")).toBe("widens");
    expect(changeEffect("busy-private", "busy-open")).toBe("more");
    expect(changeEffect("title-private", "busy-open")).toBe("more");
    expect(changeEffect("title-private", "full-private")).toBe("more");
    expect(changeEffect("title-open", "title-private")).toBe("none");
    expect(changeEffect("busy-open", "busy-private")).toBe("none");
    expect(changeEffect("busy-private", "busy-private")).toBe("none");
    expect(changeEffect("full-open", "busy-open")).toBe("none");
    expect(changeEffect("title-open", "busy-open")).toBe("none");
  });
});

describe("save and continue", () => {
  it("saves the level, then returns to the address the guard names", async () => {
    const { user, cookie, w, o, g } = await setup("nmcontinue");
    await setDirection(env, user, w, g, "busy");
    // The guard replaces `back` with the clicked row; the server accepts the address of an app page.
    for (const target of [`/mirroring?d=${o}~${g}`, `/calendars?c=${w}`, "/"]) {
      const response = await postForm(
        levelForm(w, g, { copy: "title", who: "open", back: target }),
        cookie,
      );
      expect(response.status, target).toBe(303);
      expect(response.headers.get("location"), target).toBe(target);
      expect(await ruleOptions(w, g), target).toMatchObject({ detailLevel: "title" });
      await postForm(levelForm(w, g, { copy: "busy", who: "open" }), cookie);
    }
  });

  it("falls back to the panel list for a target outside the app pages, and still saves", async () => {
    const { user, cookie, w, g } = await setup("nmcontinue-out");
    await setDirection(env, user, w, g, "busy");
    const response = await postForm(
      levelForm(w, g, { copy: "title", who: "open", back: "/privacy" }),
      cookie,
    );
    expect(response.headers.get("location")).toBe("/mirroring");
    expect(await ruleOptions(w, g)).toMatchObject({ detailLevel: "title" });
  });
});

function decode(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/** Every rule between two accounts, by source calendar. */
async function marksOf(source: string, target: string) {
  const { results } = await env.DB.prepare(
    `SELECT r.source_calendar_id AS calendar, r.options FROM rules r
     JOIN calendars sc ON sc.id = r.source_calendar_id
     JOIN calendars tc ON tc.id = r.target_calendar_id
     WHERE sc.account_id = ? AND tc.account_id = ? ORDER BY r.source_calendar_id`,
  )
    .bind(source, target)
    .all<{ calendar: string; options: string }>();
  return results.map((row) => {
    const options = JSON.parse(row.options) as { detailLevel: string; markPrivate: boolean };
    return { calendar: row.calendar, level: options.detailLevel, private: options.markPrivate };
  });
}

/** The radio or checkbox tag of one answer, up to its end. */
function inputTag(html: string, name: string, value: string): string {
  const at = html.indexOf(`name="${name}" value="${value}"`);
  expect(at, `${name}=${value}`).toBeGreaterThan(0);
  return html.slice(html.lastIndexOf("<input", at), html.indexOf(">", at) + 1);
}

/** The preview of one level, up to the next one. */
function preview(html: string, level: Level): string {
  const start = html.indexOf(`data-pv="${level}"`);
  expect(start, `preview ${level}`).toBeGreaterThan(0);
  const next = html.indexOf("data-pv=", start + 10);
  const end = next > 0 ? next : html.indexOf("mx-still", start);
  return html.slice(start, end);
}

async function setLevel(
  user: Awaited<ReturnType<typeof setup>>["user"],
  from: string,
  to: string,
  level: Level,
) {
  const parsed = parseLevel(level);
  if (level === "off" || !parsed) {
    await setDirection(env, user, from, to, "off");
    return;
  }
  await setDirections(env, user, [{ from, to, ...parsed }]);
}

describe("a mirroring whose calendars carry both marks", () => {
  /** w copies two calendars into o: Main as a private event, Second as it is. */
  async function mixedSetup(prefix: string) {
    const context = await setup(prefix);
    const { user, w, o } = context;
    await env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, ?, 'Second', 1, 0, 1)",
    )
      .bind(`${w}-second`, w, `${w}-second-remote`)
      .run();
    await env.DB.prepare(
      "UPDATE users SET sync_settings = json_set(sync_settings, '$.blockTitle', 'Busy') WHERE id = ?",
    )
      .bind(user.id)
      .run();
    await setDirections(env, user, [{ from: w, to: o, choice: "busy", markPrivate: true }]);
    await env.DB.prepare(
      `UPDATE rules SET options = json_set(options, '$.markPrivate', json('false'))
       WHERE user_id = ? AND source_calendar_id = ?`,
    )
      .bind(user.id, `${w}-second`)
      .run();
    expect((await marksOf(w, o)).map((rule) => rule.private)).toEqual([true, false]);
    return context;
  }

  it("preselects no answer, requires one, warns, and counts from the private calendars", async () => {
    const { cookie, w, o } = await mixedSetup("nmmixed");
    const html = await (await get(`/mirroring?d=${w}~${o}`, cookie)).text();
    // No answer is preselected. The page does not make the browser require one: "Not copied"
    // must save without it, also without script (`mx-who` is not clickable then). The script
    // requires it for a copied level (`data-mixed`), the server refuses a copied level without it.
    for (const value of ["private", "open"]) {
      const tag = inputTag(html, "who", value);
      expect(tag, value).not.toMatch(/\schecked/);
      expect(tag, value).not.toMatch(/\srequired/);
    }
    expect(html).toContain('<div class="mx-who" data-provider="microsoft" data-mixed="">');
    expect(decode(html)).toContain(en.next.mirroring.mixedMarks("work"));
    expect(html).toContain(`>${en.next.mirroring.preview.answerFirst}<`);
    // Any open answer warns, as from a private mirroring: "busy-open" names the copies' title.
    const note = (level: string) =>
      decode(
        html.match(new RegExp(`<p data-note[^>]*data-sentence="${level}"[^>]*>[^<]*<`))?.[0] ?? "",
      );
    expect(note("busy-open")).toContain(en.next.mirroring.bar.busyTitleShown("other", "Busy"));
    expect(note("title-open")).toContain("data-warn");
    expect(note("title-open")).toContain(
      `data-button="${en.next.mirroring.bar.button["title-open"]}"`,
    );
    expect(note("full-open")).toContain("data-warn");
    // The private answer at the same level opens nothing; it says what others see again.
    expect(note("busy-private")).toContain(en.next.mirroring.bar.privateAgain.microsoft);
    expect(note("busy-private")).not.toContain("data-warn");
    const german = decode(await (await get(`/mirroring?d=${w}~${o}`, cookie, "de")).text());
    expect(german).toContain(de.next.mirroring.mixedMarks("work"));
  });

  /** Whether the direction from `w` to `o` carries both marks, as the editor reads it. */
  async function mixedNow(userId: string, w: string, o: string) {
    const state = await loadEditorState(env, userId);
    const direction = state.directions.find((d) => d.from === w && d.to === o);
    if (!direction) throw new Error("no direction");
    return marksMixed(direction);
  }

  it("stores Same as you for every calendar at the level it has (review M2)", async () => {
    const { user, cookie, w, o } = await mixedSetup("nmmixedopen");
    expect(await mixedNow(user.id, w, o)).toBe(true);
    // The list shows the open one, so this answer matches the level the page shows: still a change.
    const response = await postForm(levelForm(w, o, { copy: "busy", who: "open" }), cookie);
    expect(response.status).toBe(303);
    expect(await marksOf(w, o)).toEqual([
      expect.objectContaining({ level: "busy", private: false }),
      expect.objectContaining({ level: "busy", private: false }),
    ]);
    expect(await mixedNow(user.id, w, o)).toBe(false);
  });

  it("stores Private event for every calendar at the level it has", async () => {
    const { user, cookie, w, o } = await mixedSetup("nmmixedpriv");
    const response = await postForm(levelForm(w, o, { copy: "busy", who: "private" }), cookie);
    expect(response.status).toBe(303);
    expect((await marksOf(w, o)).map((rule) => rule.private)).toEqual([true, true]);
    expect(await mixedNow(user.id, w, o)).toBe(false);
  });

  it("asks for an answer at a copied level, and turns off without one (script review 4, #11)", async () => {
    const { user, cookie, w, o } = await mixedSetup("nmmixedsave");
    // A copied level without an answer, as a page without script sends it: refused at the field.
    const before = await marksOf(w, o);
    const refused = await postForm(levelForm(w, o, { copy: "title" }), cookie);
    expect(refused.status).toBe(400);
    const html = decode(await refused.text());
    expect(html).toContain(
      `<p class="prop-error" id="mx-who-error">${en.next.mirroring.fieldErrors.whoRequired("work")}</p>`,
    );
    expect(html).toMatch(/role="radiogroup"[^>]*aria-describedby="mx-who-hint mx-who-error"/);
    expect(html).toMatch(/role="radiogroup"[^>]*aria-invalid="true"/);
    expect(await marksOf(w, o)).toEqual(before);
    // An answer that is neither of the two counts as none.
    const odd = await postForm(levelForm(w, o, { copy: "busy", who: "everyone" }), cookie);
    expect(odd.status).toBe(400);
    expect(await marksOf(w, o)).toEqual(before);
    // "Not copied" needs no answer.
    const off = await postForm(levelForm(w, o, { copy: "off" }), cookie);
    expect(off.status).toBe(303);
    expect(await mixedNow(user.id, w, o)).toBe(false);
    expect(await marksOf(w, o)).toEqual([]);
  });

  it("asks nothing for a mirroring whose calendars share one mark", async () => {
    const { user, cookie, w, o } = await setup("nmsame");
    await setDirections(env, user, [{ from: w, to: o, choice: "busy", markPrivate: true }]);
    const html = await (await get(`/mirroring?d=${w}~${o}`, cookie)).text();
    expect(inputTag(html, "who", "private")).toMatch(/\schecked/);
    expect(html).not.toMatch(/name="who"[^>]*required/);
    expect(html).not.toContain("data-mixed");
    expect(html).not.toContain(en.next.mirroring.preview.answerFirst);
  });
});

describe("the preview shows the entry others see", () => {
  for (const [language, catalog] of [
    ["en", en],
    ["de", de],
  ] as const) {
    it(`draws a real entry under Others see at every open level (${language})`, async () => {
      const { user, cookie, w, o, g } = await setup(`nmpv${language}`);
      for (const to of [o, g]) {
        await setLevel(user, w, to, "busy-private");
        const html = decode(await (await get(`/mirroring?d=${w}~${to}`, cookie, language)).text());
        for (const level of LEVELS.filter((entry) => entry !== "off")) {
          const drawn = preview(html, level);
          const others = drawn.split(`>${catalog.next.mirroring.preview.others}<`)[1] ?? "";
          expect(others, `${to} ${level}`).toContain('class="mx-ev');
          expect(drawn, `${to} ${level}`).not.toContain(en.next.mirroring.whoOptions.open);
          expect(drawn, `${to} ${level}`).not.toContain(de.next.mirroring.whoOptions.open);
          expect(drawn, `${to} ${level}`).not.toContain("mx-same");
          if (level.endsWith("-open")) {
            // The same entry as yours: the same title, and the details at "Everything".
            const yours = drawn.split(`>${catalog.next.mirroring.preview.others}<`)[0] ?? "";
            const title = (part: string) => part.match(/<span class="mx-ev-title">([^<]*)</)?.[1];
            expect(title(others), `${to} ${level}`).toBe(title(yours));
            expect(others.includes("mx-ev-detail"), `${to} ${level}`).toBe(level === "full-open");
          }
        }
      }
    });
  }
});

describe("refusals at their field", () => {
  it("shows a bad category at its field, says Nothing was saved on top, counts the change", async () => {
    const { cookie, w, o } = await setup("nmfield");
    const response = await postForm(
      levelForm(w, o, { copy: "busy", who: "private", blockColor: "a,b" }),
      cookie,
    );
    expect(response.status).toBe(400);
    const html = decode(await response.text());
    expect(html).toContain(
      `<p class="prop-error" id="mx-color-error">${en.next.mirroring.fieldErrors.categoryComma}</p>`,
    );
    expect(html).toMatch(
      /id="mx-color"[^>]*aria-describedby="mx-color-hint mx-color-error" aria-invalid="true"/,
    );
    expect(html).toContain(`${en.next.shell.panel.notSaved}</div>`);
    expect(html).not.toContain(en.editor.blockCategoryComma);
    // The level and the colour differ from what is stored (nothing): two changes, and the fields
    // they are made of, so that the script counts a refused field edited again once.
    expect(html).toContain('data-refused-count="2"');
    expect(html).toContain('data-refused-fields="copy blockColor"');
  });

  it("keeps a refusal without a field on top, as before", async () => {
    const { cookie, w } = await setup("nmnofield");
    const response = await postForm(levelForm(w, "nobody", { copy: "busy" }), cookie);
    expect(response.status).toBe(400);
    expect(decode(await response.text())).toContain(en.editor.choiceInvalid);
  });
});

describe("the save bar without script", () => {
  it("puts the label of each widening answer into the Save button, hidden for the script", async () => {
    const { user, cookie, w, o } = await setup("nmplain");
    await setDirections(env, user, [{ from: w, to: o, choice: "busy", markPrivate: true }]);
    const html = decode(await (await get(`/mirroring?d=${w}~${o}`, cookie)).text());
    const start = html.indexOf("data-save=");
    const button = html.slice(start, html.indexOf("</button>", start));
    expect(button).toMatch(
      new RegExp(`<span data-label-default(?:="[^"]*")?>${en.next.shell.common.save}</span>`),
    );
    for (const level of ["title-open", "full-open"] as const) {
      expect(button, level).toMatch(
        new RegExp(
          `<span data-label-for="${level}" hidden(?:="[^"]*")?>${en.next.mirroring.bar.button[level]}</span>`,
        ),
      );
    }
    // Busy for everyone from a copied level only shows the copy's title: no label of its own.
    expect(button).not.toContain('data-label-for="busy-open"');
    // The panels without widening notes keep a plain label.
    const settings = decode(await (await get("/mirroring?d=all", cookie)).text());
    const at = settings.indexOf("data-save=");
    expect(settings.slice(at, settings.indexOf("</button>", at))).not.toContain("data-label-for");
  });
});

describe("an address of a mirroring that is gone", () => {
  it("says so above the list with status 200, and nothing for a valid one", async () => {
    const { user, cookie, w, o } = await setup("nmgone");
    await setDirection(env, user, w, o, "busy");
    const gone = await get(`/mirroring?d=${w}~nobody`, cookie);
    expect(gone.status).toBe(200);
    const html = decode(await gone.text());
    expect(html).toContain(en.next.mirroring.notices.gone);
    expect(html).toContain('class="notice notice-warn"');
    expect(html).not.toContain('class="detail"');
    const german = decode(await (await get("/mirroring?d=a~b", cookie, "de")).text());
    expect(german).toContain(de.next.mirroring.notices.gone);
    for (const path of ["/mirroring", "/mirroring?d=all", `/mirroring?d=${w}~${o}`]) {
      expect(decode(await (await get(path, cookie)).text()), path).not.toContain(
        en.next.mirroring.notices.gone,
      );
    }
  });
});

describe("wording of critique 3 (#5, #7, #10, #18, #19)", () => {
  /** The visible label of the property that holds the control with `id`. */
  function labelFor(html: string, id: string): string {
    const match = new RegExp(`<label class="prop-label" for="${id}">([^<]*)</label>`).exec(html);
    return decode(match?.[1] ?? "");
  }

  for (const [language, catalog] of [
    ["en", en],
    ["de", de],
  ] as const) {
    it(`names the skip switches by what they do when on (${language})`, async () => {
      const { cookie } = await setup(`nmskip${language}`);
      const html = decode(await (await get("/mirroring?d=all", cookie, language)).text());
      const text = catalog.next.mirroring.all;
      // On skips: the visible label says so, and the section does not negate it again.
      expect(labelFor(html, "mx-allday")).toBe(text.skipAllDay);
      expect(labelFor(html, "mx-tentative")).toBe(text.skipTentative);
      expect(html).toContain(`<h3 class="section-title">${text.skipTitle}</h3>`);
      expect(html).not.toMatch(/Never copy|Nie kopieren/);
      expect(labelFor(html, "mx-title")).toBe(text.blockTitle);
      expect(labelFor(html, "mx-title"), "#19").toBe(
        language === "en" ? "Title of busy copies" : "Titel der Kopien bei „Nur belegt“",
      );
    });
  }

  it("says the copy keeps its full times, not that it is copied in full (#7)", async () => {
    const { user, cookie, w, o } = await setup("nmhourshint");
    await env.DB.prepare("UPDATE accounts SET work_hours = ? WHERE id = ?")
      .bind(
        JSON.stringify({
          workDays: [1, 2, 3, 4, 5],
          workStart: "08:00",
          workEnd: "18:00",
          workTimeZone: "UTC",
        }),
        o,
      )
      .run();
    await setDirections(env, user, [{ from: w, to: o, choice: "busy", markPrivate: true }]);
    for (const [language, words] of [
      ["en", /copied, with their full times\./],
      ["de", /werden kopiert, mit ihrer vollen Dauer\./],
    ] as const) {
      const html = decode(await (await get(`/mirroring?d=${w}~${o}`, cookie, language)).text());
      expect(html, language).toMatch(words);
      expect(html, language).not.toMatch(/copied in full|vollständig kopiert/);
    }
  });

  it("holds both working-hours hints, one for each state of the switch", async () => {
    const { user, cookie, w, o } = await setup("nmhoursoff");
    await env.DB.prepare("UPDATE accounts SET work_hours = ? WHERE id = ?")
      .bind(
        JSON.stringify({
          workDays: [1, 2, 3, 4, 5],
          workStart: "08:00",
          workEnd: "18:00",
          workTimeZone: "UTC",
        }),
        o,
      )
      .run();
    await setDirections(env, user, [{ from: w, to: o, choice: "busy", markPrivate: true }]);
    for (const [language, off, on] of [
      ["en", "Copied at any time.", /Only events that touch these hours are copied/],
      ["de", "Wird zu jeder Zeit kopiert.", /Nur Termine, die diese Zeit berühren/],
    ] as const) {
      const html = decode(await (await get(`/mirroring?d=${w}~${o}`, cookie, language)).text());
      expect(html, language).toContain(`<span class="mx-hours-off">${off}</span>`);
      expect(html, language).toMatch(new RegExp(`<span class="mx-hours-on">[^<]*${on.source}`));
      // One hint element holds both, and the switch describes itself by it.
      expect(html, language).toMatch(
        /<p class="prop-hint" id="mx-hours-hint"><span class="mx-hours-off">/,
      );
      expect(html, language).toMatch(
        /id="mx-hours"[^>]*aria-describedby="mx-hours-hint"|aria-describedby="mx-hours-hint"[^>]*id="mx-hours"/,
      );
    }
  });

  it("titles the private Google copy Busy, with the lock (#10)", async () => {
    const { user, cookie, w, g } = await setup("nmgooglebusy");
    await setDirections(env, user, [{ from: w, to: g, choice: "busy", markPrivate: true }]);
    for (const [language, title] of [
      ["en", "Busy"],
      ["de", "Beschäftigt"],
    ] as const) {
      const html = await (await get(`/mirroring?d=${w}~${g}`, cookie, language)).text();
      const others = preview(html, "busy-private").split('class="prop-label">')[2] ?? "";
      expect(others, language).toContain('class="mx-ev-lock"');
      expect(others, language).toContain(`<span class="mx-ev-title">${title}</span>`);
    }
  });

  it("keeps all-day in one piece in the strings that break in a narrow column (#18)", () => {
    for (const text of [
      en.next.calendars.bufferHint,
      en.next.mirroring.all.skipAllDay,
      en.next.mirroring.all.skipAllDayLabel,
    ]) {
      expect(text).toContain("all‑day");
      expect(text).not.toContain("all-day");
    }
  });
});
