/**
 * "Who sees it" per mirroring, at every copied level, on the mirroring page of the redesign: the
 * truth table from the form to the stored rule, the list, map and panel labels, the preview per
 * target provider, the save bar, the panel for all mirrorings, and the saves that must fail
 * closed. Failure modes are numbered as in the plan "one visibility setting per mirroring".
 */
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LEVELS,
  parseLevel,
  setDirection,
  setDirections,
  setGroupMembership,
  type Level,
} from "../src/editor";
import { de } from "../src/i18n/de";
import { en } from "../src/i18n/en";
import { BASE, signIn, withoutShellDialogs } from "./helpers";

/** A user with two Microsoft accounts and a Google one, each with one main calendar. */
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
  // Names as the pages derive them from the addresses.
  return { user, cookie, w, o, g, names: { [w]: "work", [o]: "other", [g]: "Gmail" } };
}

type User = Awaited<ReturnType<typeof setup>>["user"];

/** Put a direction at a level, as the editor stores it. */
async function setLevel(user: User, from: string, to: string, level: Level) {
  if (level === "off") {
    await setDirection(env, user, from, to, "off");
    return;
  }
  const parsed = parseLevel(level);
  if (!parsed) throw new Error(level);
  await setDirections(env, user, [{ from, to, ...parsed }]);
}

async function setStoredDefault(userId: string, markPrivate: boolean) {
  await env.DB.prepare(
    "UPDATE users SET sync_settings = json_set(sync_settings, '$.markPrivate', json(?)) WHERE id = ?",
  )
    .bind(markPrivate ? "true" : "false", userId)
    .run();
}

/** The first POST of a user without rules stores the default block title; store it before. */
async function storeTitle(userId: string) {
  await env.DB.prepare(
    "UPDATE users SET sync_settings = json_set(sync_settings, '$.blockTitle', 'Busy') WHERE id = ?",
  )
    .bind(userId)
    .run();
}

async function storedDefault(userId: string): Promise<unknown> {
  const row = await env.DB.prepare("SELECT sync_settings AS json FROM users WHERE id = ?")
    .bind(userId)
    .first<{ json: string }>();
  return (JSON.parse(row?.json ?? "{}") as { markPrivate?: unknown }).markPrivate ?? true;
}

/** The options of every rule between two accounts, by source calendar. */
async function rulesOf(source: string, target: string) {
  const { results } = await env.DB.prepare(
    `SELECT r.source_calendar_id AS calendar, r.options, r.enabled FROM rules r
     JOIN calendars sc ON sc.id = r.source_calendar_id
     JOIN calendars tc ON tc.id = r.target_calendar_id
     WHERE sc.account_id = ? AND tc.account_id = ?`,
  )
    .bind(source, target)
    .all<{ calendar: string; options: string; enabled: number }>();
  return results.map((row): Record<string, unknown> => ({
    calendar: row.calendar,
    enabled: row.enabled === 1,
    ...(JSON.parse(row.options) as Record<string, unknown>),
  }));
}

async function ruleOf(source: string, target: string) {
  return (await rulesOf(source, target))[0] ?? null;
}

/** Everything a save could change for a user: rules, settings, audit rows. */
async function snapshot(userId: string) {
  const rules = await env.DB.prepare(
    "SELECT id, options, enabled, origin FROM rules WHERE user_id = ? ORDER BY id",
  )
    .bind(userId)
    .all();
  const rest = await env.DB.prepare(
    `SELECT (SELECT sync_settings FROM users WHERE id = ?1) AS settings,
            (SELECT COUNT(*) FROM audit_events WHERE user_id = ?1) AS audits`,
  )
    .bind(userId)
    .first();
  return { rules: rules.results, rest };
}

function get(path: string, cookie: string, language = "en") {
  return exports.default.fetch(`${BASE}${path}`, {
    headers: { cookie, "accept-language": language },
    redirect: "manual",
  });
}

async function page(path: string, cookie: string, language = "en") {
  return (await get(path, cookie, language)).text();
}

function postForm(fields: Record<string, string> | [string, string][], cookie: string) {
  return exports.default.fetch(`${BASE}/mirroring`, {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie,
      "content-type": "application/x-www-form-urlencoded",
      "accept-language": "en",
    },
    body: new URLSearchParams(fields),
  });
}

function levelForm(from: string, to: string, extra: Record<string, string> = {}) {
  return {
    scope: "direction",
    from,
    to,
    back: `/mirroring?d=${from}~${to}&saved=1`,
    ...extra,
  };
}

function decode(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/** The fields the panel's form submits as a browser would, from the rendered page. */
function formFields(html: string): [string, string][] {
  const start = html.indexOf('<form class="detail-form"');
  expect(start, "panel form").toBeGreaterThan(0);
  const form = html.slice(start, html.indexOf("</form>", start));
  const fields: [string, string][] = [];
  for (const match of form.matchAll(/<input\b[^>]*>/g)) {
    const tag = match[0];
    const attr = (name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
    const has = (name: string) => new RegExp(`\\s${name}(?:[\\s=/>])`).test(tag);
    const name = attr("name");
    if (!name || has("disabled")) continue;
    const type = attr("type") ?? "text";
    if ((type === "radio" || type === "checkbox") && !has("checked")) continue;
    fields.push([name, decode(attr("value") ?? "on")]);
  }
  return fields;
}

function checked(html: string, name: string): string | undefined {
  return formFields(html).find(([field]) => field === name)?.[1];
}

/** The list row of a direction, up to the end of its link. */
function listRow(html: string, from: string, to: string): string {
  // The command palette lists the same link as an option. Only the list's own row counts.
  const page = withoutShellDialogs(html);
  const start = page.indexOf(`href="/mirroring?d=${from}~${to}"`);
  expect(start, `row ${from}~${to}`).toBeGreaterThan(0);
  const row = page.slice(page.lastIndexOf("<a", start), page.indexOf("</a>", start));
  expect(row, `row ${from}~${to} is a list row`).toContain('class="list-row"');
  return row;
}

/** The map cell of a direction on the overview. */
function mapCell(html: string, from: string, to: string): string {
  const start = html.lastIndexOf(
    '<a class="ov-cell-link',
    html.indexOf(`data-direction="${from}~${to}"`),
  );
  expect(start, `cell ${from}~${to}`).toBeGreaterThan(0);
  return html.slice(start, html.indexOf("</td>", start));
}

/** The preview of one level in the panel. */
function preview(html: string, level: Level): string {
  const start = html.indexOf(`data-pv="${level}"`);
  expect(start, `preview ${level}`).toBeGreaterThan(0);
  const next = html.indexOf("data-pv=", start + 10);
  const still = html.indexOf("mx-still", start);
  return html.slice(start, Math.min(...[next, still].filter((index) => index > 0)));
}

/** The text of the "who sees it" hint span for an answer and, if open, a copied level. */
function whoHint(html: string, who: "private" | "open", copy?: string): string {
  const marker = copy ? `data-who="${who}" data-copy="${copy}"` : `data-who="${who}"`;
  const start = html.indexOf(`class="mx-who-hint" ${marker}`);
  expect(start, marker).toBeGreaterThan(0);
  return decode(html.slice(html.indexOf(">", start) + 1, html.indexOf("</span>", start)));
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

describe("from the form to the stored rule (failure mode 3, review M3)", () => {
  it("stores every copied level with the answer to who sees it", async () => {
    const { cookie, w, g } = await setup("tvtable");
    for (const copy of ["busy", "title", "full"]) {
      for (const who of ["private", "open"]) {
        const response = await postForm(levelForm(w, g, { copy, who }), cookie);
        expect(response.status, `${copy} ${who}`).toBe(303);
        expect(await ruleOf(w, g), `${copy} ${who}`).toMatchObject({
          detailLevel: copy,
          markPrivate: who === "private",
          enabled: true,
        });
      }
    }
    await postForm(levelForm(w, g, { copy: "off", who: "open" }), cookie);
    expect(await ruleOf(w, g)).toBeNull();
  });

  it("makes a copied level private for any answer but the exact word open", async () => {
    const { user, cookie, w, g } = await setup("tvclosed");
    for (const copy of ["busy", "title", "full"]) {
      for (const who of [undefined, "", "xyz", "OPEN", " open", "open "]) {
        await setLevel(user, w, g, "full-open");
        const extra: Record<string, string> = who === undefined ? { copy } : { copy, who };
        const response = await postForm(levelForm(w, g, extra), cookie);
        expect(response.status, `${copy} ${JSON.stringify(who)}`).toBe(303);
        expect(await ruleOf(w, g), `${copy} ${JSON.stringify(who)}`).toMatchObject({
          detailLevel: copy,
          markPrivate: true,
        });
      }
    }
  });

  it("refuses a copy field that is not one of the four answers, before any write", async () => {
    const { user, cookie, w, g } = await setup("tvcopy");
    await setLevel(user, w, g, "busy-private");
    const before = await snapshot(user.id);
    for (const copy of ["busy-open", "full-open", "title-private", "everything", "", "Busy"]) {
      const response = await postForm(levelForm(w, g, { copy, who: "private" }), cookie);
      expect(response.status, copy).toBe(400);
    }
    expect(await snapshot(user.id)).toEqual(before);
  });
});

describe("render, then submit unchanged", () => {
  it("writes nothing at any level, to a Microsoft and a Google target", async () => {
    const { user, cookie, w, o, g } = await setup("tvround");
    // The first POST of a user without rules stores the default block title; store it before.
    await env.DB.prepare(
      "UPDATE users SET sync_settings = json_set(sync_settings, '$.blockTitle', 'Busy') WHERE id = ?",
    )
      .bind(user.id)
      .run();
    for (const to of [o, g]) {
      for (const level of LEVELS) {
        await setLevel(user, w, to, level);
        const html = await page(`/mirroring?d=${w}~${to}`, cookie);
        const fields = formFields(html);
        expect(
          fields.filter(([name]) => name === "copy"),
          level,
        ).toHaveLength(1);
        const before = await snapshot(user.id);
        const response = await postForm(fields, cookie);
        expect(response.status, `${level} to ${to}`).toBe(303);
        expect(await snapshot(user.id), `${level} to ${to}`).toEqual(before);
      }
    }
  });
});

describe("the seven levels on the pages", () => {
  for (const [language, catalog] of [
    ["en", en],
    ["de", de],
  ] as const) {
    it(`shows each level in the list, the map and the panel (${language})`, async () => {
      const { user, cookie, w, o, g } = await setup(`tvseven${language}`);
      // Other mirrorings, so that the overview shows its map also when w > g is off, and the
      // cells never share one level (the map would name it once in its head instead).
      await setLevel(user, o, w, "busy-private");
      await setLevel(user, g, o, "full-open");
      const levels = catalog.next.shell.levels;
      for (const level of LEVELS) {
        await setLevel(user, w, g, level);
        const row = listRow(await page("/mirroring", cookie, language), w, g);
        expect(row, level).toContain(`data-level="${level}"`);
        expect(decode(row), level).toContain(levels.summary[level]);

        const cell = decode(mapCell(await page("/", cookie, language), w, g));
        expect(cell, level).toContain(levels.summary[level]);
        if (level !== "off") expect(cell, level).toContain(`>${levels.summary[level]}<`);

        const panel = await page(`/mirroring?d=${w}~${g}`, cookie, language);
        expect(checked(panel, "copy"), level).toBe(level.split("-")[0]);
        expect(checked(panel, "who"), level).toBe(
          level === "off" ? "private" : level.split("-")[1],
        );
        expect(panel, level).toMatch(new RegExp(`data-mx[^>]*data-level="${level}"`));
      }
    });
  }

  it("draws the lock in the level mark of a private level only", async () => {
    const { user, cookie, w, g } = await setup("tvglyph");
    const mark = async () => {
      const row = listRow(await page("/mirroring", cookie), w, g);
      const start = row.indexOf('<svg class="lmark"');
      expect(start).toBeGreaterThan(0);
      return row.slice(start, row.indexOf("</svg>", start) + 6);
    };
    for (const level of LEVELS.filter((entry) => entry !== "off")) {
      await setLevel(user, w, g, level);
      const drawn = await mark();
      expect(drawn, level).toContain(`data-level="${level}"`);
      if (level.endsWith("-private")) expect(drawn, level).toContain('class="lmark-lock"');
      else expect(drawn, level).not.toContain('class="lmark-lock"');
    }
  });
});

describe("the mirroring's own mark, never the default (failure modes 4, 5, 9)", () => {
  it("shows an open busy mirroring as open while the default is private", async () => {
    const { user, cookie, w, g } = await setup("tvfm4a");
    await setLevel(user, w, g, "busy-open");
    expect(await storedDefault(user.id)).toBe(true);
    const list = decode(listRow(await page("/mirroring", cookie), w, g));
    expect(list).toContain(en.next.shell.levels.summary["busy-open"]);
    const panel = await page(`/mirroring?d=${w}~${g}`, cookie);
    expect(checked(panel, "who")).toBe("open");
    // Others see the copy itself, titled as the copies are, not a phrase about it.
    const others = preview(panel, "busy-open").split(`>${en.next.mirroring.preview.others}<`)[1];
    expect(others).toContain('class="mx-ev is-busy"');
    expect(others).toContain('<span class="mx-ev-title">Busy</span>');
    expect(preview(panel, "busy-private")).toContain(en.next.mirroring.preview.privateGoogle);
  });

  it("shows a private busy mirroring as private while the default is open", async () => {
    const { user, cookie, w, g } = await setup("tvfm4b");
    await setLevel(user, w, g, "busy-private");
    await setStoredDefault(user.id, false);
    const list = decode(listRow(await page("/mirroring", cookie), w, g));
    expect(list).toContain(en.next.shell.levels.summary["busy-private"]);
    expect(checked(await page(`/mirroring?d=${w}~${g}`, cookie), "who")).toBe("private");
  });

  it("shows a mirroring with one open source calendar as open, and asks for an answer (L5)", async () => {
    const { user, cookie, w, g } = await setup("tvfm5");
    await env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, ?, 'Second', 1, 0, 1)",
    )
      .bind(`${w}-second`, w, `${w}-second-remote`)
      .run();
    await setLevel(user, w, g, "title-private");
    await env.DB.prepare(
      `UPDATE rules SET options = json_set(options, '$.markPrivate', json('false'))
       WHERE user_id = ? AND source_calendar_id = ?`,
    )
      .bind(user.id, `${w}-second`)
      .run();
    expect((await rulesOf(w, g)).map((rule) => rule.markPrivate).toSorted()).toEqual([false, true]);
    const list = decode(listRow(await page("/mirroring", cookie), w, g));
    expect(list).toContain(en.next.shell.levels.summary["title-open"]);
    // The panel preselects no answer: a preselected "Same as you" would open the private
    // calendar on any save. A copied level needs an answer (script and server ask for it; see
    // next-mirroring), and a warning says it applies to both.
    const panel = await page(`/mirroring?d=${w}~${g}`, cookie);
    expect(checked(panel, "who")).toBeUndefined();
    expect(checked(panel, "copy")).toBe("title");
    expect(panel).toContain('class="mx-who" data-provider="google" data-mixed=""');
    expect(decode(panel)).toContain(en.next.mirroring.mixedMarks("work"));
  });

  it("preselects who sees it from the default when the mirroring is off", async () => {
    const { user, cookie, w, o, g } = await setup("tvfm9");
    for (const id of [w, o, g]) await setGroupMembership(env, user, id, true);
    // A disabled exception that kept the private mark of the time it was turned off.
    await setDirection(env, user, w, g, "off");
    expect(await rulesOf(w, g)).toMatchObject([{ enabled: false, markPrivate: true }]);
    await setStoredDefault(user.id, false);
    const panel = await page(`/mirroring?d=${w}~${g}`, cookie);
    expect(checked(panel, "copy")).toBe("off");
    expect(checked(panel, "who")).toBe("open");
    // Turning it on with the preselected answer stores what the panel showed.
    await postForm(
      formFields(panel).map(([k, v]) => [k, k === "copy" ? "busy" : v]),
      cookie,
    );
    expect(await ruleOf(w, g)).toMatchObject({ detailLevel: "busy", markPrivate: false });
  });

  it("offers who sees it at every level, also at busy only and not copied", async () => {
    const { user, cookie, w, g } = await setup("tvwhorow");
    for (const level of ["off", "busy-private", "busy-open"] as const) {
      await setLevel(user, w, g, level);
      const panel = await page(`/mirroring?d=${w}~${g}`, cookie);
      expect(panel, level).toContain('<div class="mx-who"');
      expect(
        formFields(panel).filter(([name]) => name === "who"),
        level,
      ).toHaveLength(1);
    }
  });
});

describe("preview and hints per target provider", () => {
  it("labels a private copy Private event in Microsoft and Busy in Google, both with the lock", async () => {
    const { user, cookie, w, o, g, names } = await setup("tvprov");
    await setLevel(user, w, o, "busy-private");
    await setLevel(user, w, g, "busy-private");
    const microsoft = await page(`/mirroring?d=${w}~${o}`, cookie);
    const google = await page(`/mirroring?d=${w}~${g}`, cookie);
    for (const level of ["busy-private", "title-private", "full-private"] as const) {
      expect(preview(microsoft, level), level).toContain(
        `>${en.next.mirroring.preview.privateMicrosoft}<`,
      );
      expect(preview(microsoft, level), level).toContain("mx-ev-lock");
      expect(preview(google, level), level).toContain(
        `>${en.next.mirroring.preview.privateGoogle}<`,
      );
      // The lock tells the private copy from an open one titled "Busy" (critique 3 #10).
      expect(preview(google, level), level).toContain("mx-ev-lock");
    }
    const hints = en.next.mirroring.whoHint;
    expect(whoHint(microsoft, "private")).toBe(hints.privateMicrosoft(names[o] ?? ""));
    expect(whoHint(google, "private")).toBe(hints.privateGoogle(names[g] ?? ""));
    // "Same as you" says what others see, then who the others are.
    expect(whoHint(microsoft, "open", "busy")).toBe(
      `${hints.openBusy(names[o] ?? "", "Busy")} ${hints.othersMicrosoft}`,
    );
    expect(whoHint(microsoft, "open", "title")).toBe(
      `${hints.openTitle(names[o] ?? "")} ${hints.othersMicrosoft}`,
    );
    expect(whoHint(microsoft, "open", "full")).toBe(
      `${hints.openFull(names[o] ?? "")} ${hints.othersMicrosoft}`,
    );
    // Google also names who a published calendar reaches.
    expect(whoHint(google, "open", "title")).toBe(
      `${hints.openTitle(names[g] ?? "")} ${hints.othersGoogle}`,
    );
  });

  it("speaks German in the preview and the hints", async () => {
    const { user, cookie, w, o, g, names } = await setup("tvprovde");
    await setLevel(user, w, g, "busy-private");
    const google = await page(`/mirroring?d=${w}~${g}`, cookie, "de");
    const microsoft = await page(`/mirroring?d=${w}~${o}`, cookie, "de");
    expect(preview(google, "busy-private")).toContain(">Beschäftigt<");
    expect(preview(microsoft, "busy-private")).toContain(">Privater Termin<");
    expect(whoHint(google, "private")).toBe(
      de.next.mirroring.whoHint.privateGoogle(names[g] ?? ""),
    );
  });

  it("names the blocks' own title in the open hint at busy only", async () => {
    const { user, cookie, w, o } = await setup("tvtitle");
    await env.DB.prepare(
      "UPDATE users SET sync_settings = json_set(sync_settings, '$.blockTitle', 'Away') WHERE id = ?",
    )
      .bind(user.id)
      .run();
    await setLevel(user, w, o, "busy-open");
    const panel = await page(`/mirroring?d=${w}~${o}`, cookie);
    expect(whoHint(panel, "open", "busy")).toContain("“Away”");
  });
});

describe("save bar of a mirroring", () => {
  function notes(html: string) {
    return Object.fromEntries(
      [...html.matchAll(/<p data-note[^>]*data-sentence="([^"]+)"[^>]*>([^<]*)</g)].map((match) => [
        match[1] ?? "",
        { tag: match[0], text: decode(match[2] ?? "") },
      ]),
    );
  }

  it("warns only where titles or details reach everyone, with the short button label", async () => {
    const { user, cookie, w, o, names } = await setup("tvbar");
    await setLevel(user, w, o, "busy-private");
    const found = notes(await page(`/mirroring?d=${w}~${o}`, cookie));
    expect(Object.keys(found).toSorted()).toEqual([
      "busy-open",
      "full-open",
      "full-private",
      "off",
      "title-open",
      "title-private",
    ]);
    expect(found.off?.tag).not.toContain("data-warn");
    const bar = en.next.mirroring.bar;
    expect(found["title-open"]?.tag).toContain(`data-button="${bar.button["title-open"]}"`);
    expect(found["full-open"]?.tag).toContain(`data-button="${bar.button["full-open"]}"`);
    expect(found["busy-open"]?.tag).not.toContain("data-warn");
    // Others saw a private busy time; now they see the copy's own title.
    expect(found["busy-open"]?.text).toBe(bar.busyTitleShown(names[o] ?? "", "Busy"));
    expect(found["title-private"]?.text).toBe(
      bar.sentence["title-private"](names[w] ?? "", names[o] ?? ""),
    );
  });

  it("names when you are busy for a mirroring turned on at busy only", async () => {
    const { cookie, w, o, names } = await setup("tvbaroff");
    const found = notes(await page(`/mirroring?d=${w}~${o}`, cookie));
    const bar = en.next.mirroring.bar;
    expect(found["busy-private"]?.text).toBe(
      bar.sentence["busy-private"](names[w] ?? "", names[o] ?? ""),
    );
    expect(found["busy-open"]?.text).toBe(
      bar.sentence["busy-open"](names[w] ?? "", names[o] ?? "", "Busy"),
    );
  });

  it("has a note that existing copies change when only who sees it changes", async () => {
    const { user, cookie, w, o } = await setup("tvbarwho");
    await setLevel(user, w, o, "title-open");
    const html = await page(`/mirroring?d=${w}~${o}`, cookie);
    const note = html.match(/<p data-note[^>]*data-who-note[^>]*>([^<]*)</);
    expect(note?.[1]).toBe(en.next.mirroring.bar.whoChanges);
  });
});

describe("the panel for all mirrorings (step 5, failure mode 10, review L1)", () => {
  /** Default private; w > g busy-private, o > g busy-open, w > o title-open, the rest off. */
  async function mixed(prefix: string) {
    const context = await setup(prefix);
    const { user, w, o, g } = context;
    await setLevel(user, w, g, "busy-private");
    await setLevel(user, o, g, "busy-open");
    await setLevel(user, w, o, "title-open");
    return context;
  }

  async function allMarks(userId: string) {
    const { results } = await env.DB.prepare(
      "SELECT json_extract(options, '$.markPrivate') AS mark FROM rules WHERE user_id = ? ORDER BY id",
    )
      .bind(userId)
      .all<{ mark: number }>();
    return results.map((row) => row.mark === 1);
  }

  it("asks who sees it by default instead of the old switch", async () => {
    const { cookie } = await mixed("tvallform");
    const html = await page("/mirroring?d=all", cookie);
    const text = en.next.mirroring.all;
    expect(decode(html)).toContain(text.whoDefault);
    expect(decode(html)).toContain(text.whoDefaultHint);
    expect(checked(html, "newWho")).toBe("private");
    expect(html).not.toContain('name="markPrivate"');
    expect(html).not.toContain('name="markPrivateShown"');
    expect(html).toContain('name="applyWho" value="1"');
  });

  it("states how many mirrorings each answer changes, open as a warning", async () => {
    const { cookie } = await mixed("tvallcount");
    const html = decode(await page("/mirroring?d=all", cookie));
    const text = en.next.mirroring.all;
    // Private narrows the two open mirrorings; open widens the one private.
    expect(html).toContain(text.applyWho(2));
    expect(html).toContain(text.applyWho(1));
    expect(html).toContain(text.applyPrivate(2));
    // The one private mirroring copies busy times into Gmail: the sentence names that.
    const open = text.applyOpen.busy("Gmail", "Busy");
    expect(html).toContain(open);
    // The consequence stands once, next to the checkbox; the save bar only renames its button.
    expect(html.split(open).length - 1).toBe(1);
    expect(html).toMatch(/class="mx-apply-hint is-warn" data-who="open"/);
    expect(html).toMatch(
      new RegExp(`<p data-note[^>]*data-warn=""[^>]*data-button="${text.applyOpenButton(1)}"`),
    );
  });

  it("shows no checkbox when no mirroring would change", async () => {
    const { user, cookie, w, g } = await setup("tvallnone");
    await setLevel(user, w, g, "busy-private");
    await setStoredDefault(user.id, true);
    // Private changes nothing; open changes one.
    let html = await page("/mirroring?d=all", cookie);
    expect(html).toContain('name="applyWho"');
    expect(html).toContain('data-apply="private" data-count="0"');
    const empty = await setup("tvallempty");
    html = await page("/mirroring?d=all", empty.cookie);
    expect(html).not.toContain('name="applyWho"');
  });

  it("sets only the default without the checkbox, and every mirroring with it", async () => {
    const { user, cookie } = await mixed("tvallsave");
    const before = await allMarks(user.id);
    const fields = formFields(await page("/mirroring?d=all", cookie)).filter(
      ([name]) => name !== "newWho",
    );
    let response = await postForm([...fields, ["newWho", "open"]], cookie);
    expect(response.status).toBe(303);
    expect(await storedDefault(user.id)).toBe(false);
    expect(await allMarks(user.id)).toEqual(before);
    // The form drawn before that save is stale now (409, see next-conflict): draw it again.
    const again = formFields(await page("/mirroring?d=all", cookie)).filter(
      ([name]) => name !== "newWho",
    );
    response = await postForm([...again, ["newWho", "open"], ["applyWho", "1"]], cookie);
    expect(response.status).toBe(303);
    expect((await allMarks(user.id)).every((mark) => !mark)).toBe(true);
  });

  it("changes no mark and not the default from a save without newWho (failure mode 2)", async () => {
    const { user, cookie } = await mixed("tvallnowho");
    const before = await allMarks(user.id);
    const fields = formFields(await page("/mirroring?d=all", cookie)).filter(
      ([name]) => name !== "newWho",
    );
    // Even with the bulk checkbox: without newWho it does nothing.
    const response = await postForm([...fields, ["applyWho", "1"]], cookie);
    expect(response.status).toBe(303);
    expect(await allMarks(user.id)).toEqual(before);
    expect(await storedDefault(user.id)).toBe(true);
  });

  it("names the settings in a conflict and says that nothing was saved", async () => {
    const { user, cookie } = await mixed("tvallconflict");
    const fields = formFields(await page("/mirroring?d=all", cookie));
    const batch = env.DB.batch.bind(env.DB);
    let injected = false;
    vi.spyOn(env.DB, "batch").mockImplementation(async (statements) => {
      const sql = statements.map((s) => (s as unknown as { statement?: string }).statement ?? "");
      if (!injected && sql.some((text) => text.startsWith("UPDATE users SET sync_settings"))) {
        injected = true;
        await env.DB.prepare(
          "UPDATE rules SET options = json_set(options, '$.blockColor', 'Other') WHERE user_id = ?",
        )
          .bind(user.id)
          .run();
      }
      return batch(statements);
    });
    const response = await postForm([...fields, ["applyWho", "1"]], cookie);
    expect(injected).toBe(true);
    expect(response.status).toBe(409);
    expect(decode(await response.text())).toContain(en.next.mirroring.all.conflict);
  });
});

describe("a save writes the level and its details together (review M1)", () => {
  it("never stores the wider level without the filter that came with it", async () => {
    const { user, cookie, w, o } = await setup("tvm1gap");
    await setLevel(user, w, o, "busy-private");
    const seen: Record<string, unknown>[] = [];
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementation(async (statements) => {
      const results = await batch(statements);
      const rule = await ruleOf(w, o);
      if (rule) seen.push(rule);
      return results;
    });
    const response = await postForm(
      levelForm(w, o, {
        copy: "title",
        who: "open",
        onlyCategoriesShown: "1",
        onlyCategories: "Work",
      }),
      cookie,
    );
    expect(response.status).toBe(303);
    expect(await ruleOf(w, o)).toMatchObject({
      detailLevel: "title",
      markPrivate: false,
      onlyCategories: ["Work"],
    });
    const titled = seen.filter((rule) => rule.detailLevel === "title");
    expect(titled.length).toBeGreaterThan(0);
    for (const rule of titled) {
      expect(rule.onlyCategories, JSON.stringify(seen)).toEqual(["Work"]);
    }
  });

  it("records the details in the audit row of the level", async () => {
    const { user, cookie, w, o } = await setup("tvm1audit");
    await setLevel(user, w, o, "busy-private");
    await postForm(
      levelForm(w, o, {
        copy: "title",
        who: "open",
        blockColor: "Work",
        onlyCategoriesShown: "1",
        onlyCategories: "Work, Customer",
      }),
      cookie,
    );
    const { results } = await env.DB.prepare(
      "SELECT detail FROM audit_events WHERE user_id = ? AND kind = 'rule_updated' ORDER BY id DESC LIMIT 1",
    )
      .bind(user.id)
      .all<{ detail: string }>();
    // The row may carry more (the level before, for the activity page); these are the details.
    expect(JSON.parse(results[0]?.detail ?? "{}")).toMatchObject({
      choice: "title",
      markPrivate: false,
      blockColor: "changed",
      onlyCategories: "2",
    });
  });

  it("saves nothing and says so when the mirroring changed meanwhile", async () => {
    const { user, cookie, w, o } = await setup("tvm1conflict");
    await setLevel(user, w, o, "busy-private");
    const batch = env.DB.batch.bind(env.DB);
    let injected = false;
    vi.spyOn(env.DB, "batch").mockImplementation(async (statements) => {
      const sql = statements.map((s) => (s as unknown as { statement?: string }).statement ?? "");
      if (
        !injected &&
        sql.some((text) => /UPDATE rules SET options = \?, enabled = 1/.test(text))
      ) {
        injected = true;
        // Another tab changes the colour after this save read the rules.
        await env.DB.prepare(
          "UPDATE rules SET options = json_set(options, '$.blockColor', 'Other') WHERE user_id = ?",
        )
          .bind(user.id)
          .run();
      }
      return batch(statements);
    });
    const response = await postForm(
      levelForm(w, o, {
        copy: "title",
        who: "open",
        onlyCategoriesShown: "1",
        onlyCategories: "Work",
      }),
      cookie,
    );
    expect(injected).toBe(true);
    expect(response.status).toBe(409);
    const html = decode(await response.text());
    expect(html).toContain(en.next.mirroring.conflict);
    expect(html).not.toContain("These rules changed");
    expect(await ruleOf(w, o)).toMatchObject({
      detailLevel: "busy",
      markPrivate: true,
      blockColor: "Other",
      onlyCategories: [],
    });
  });

  it("leaves the previous state when the write fails", async () => {
    const { user, cookie, w, o } = await setup("tvm1fail");
    await setLevel(user, w, o, "busy-private");
    const before = await ruleOf(w, o);
    const batch = env.DB.batch.bind(env.DB);
    let failed = false;
    vi.spyOn(env.DB, "batch").mockImplementation(async (statements) => {
      const sql = statements.map((s) => (s as unknown as { statement?: string }).statement ?? "");
      if (sql.some((text) => text.startsWith("UPDATE rules SET options"))) {
        failed = true;
        throw new Error("D1 is unavailable");
      }
      return batch(statements);
    });
    const response = await postForm(
      levelForm(w, o, {
        copy: "full",
        who: "open",
        onlyCategoriesShown: "1",
        onlyCategories: "Work",
      }),
      cookie,
    );
    expect(failed).toBe(true);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.headers.get("location")).toBeNull();
    vi.restoreAllMocks();
    expect(await ruleOf(w, o)).toEqual(before);
  });
});

describe("a save that writes nothing does not say Saved (review L2)", () => {
  it("refuses a copied level into a calendar that slotmirror cannot write", async () => {
    const { user, cookie, w, g, names } = await setup("tvl2ro");
    await storeTitle(user.id);
    await env.DB.prepare("UPDATE calendars SET can_edit = 0 WHERE id = ?").bind(`${g}-cal`).run();
    const before = await snapshot(user.id);
    const response = await postForm(levelForm(w, g, { copy: "title", who: "open" }), cookie);
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(decode(await response.text())).toContain(
      en.next.mirroring.notSaved.readOnly(names[g] ?? ""),
    );
    expect(await snapshot(user.id)).toEqual(before);
  });

  it("still turns a mirroring into a read-only calendar off", async () => {
    const { user, cookie, w, g } = await setup("tvl2off");
    await setLevel(user, w, g, "busy-private");
    await env.DB.prepare("UPDATE calendars SET can_edit = 0 WHERE id = ?").bind(`${g}-cal`).run();
    const response = await postForm(levelForm(w, g, { copy: "off", who: "private" }), cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("saved=1");
    expect(await ruleOf(w, g)).toBeNull();
  });

  it("refuses a level above the organisation's cap instead of storing a lower one", async () => {
    const { user, cookie, w } = await setup("tvl2cap");
    await storeTitle(user.id);
    // MAX_DETAIL_FROM_EXTERNAL is "busy" in the test bindings; this target belongs to the org.
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, provider, email) VALUES ('tvl2cap-i', ?, 'microsoft', 'tvl2cap@org.example')",
      ).bind(user.id),
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES ('tvl2cap-i-cal', 'tvl2cap-i', 'tvl2cap-i-remote', 'Main', 1, 1, 1)",
      ),
    ]);
    const before = await snapshot(user.id);
    const response = await postForm(
      levelForm(w, "tvl2cap-i", { copy: "title", who: "open" }),
      cookie,
    );
    expect(response.status).toBe(400);
    expect(decode(await response.text())).toContain("Nothing was saved");
    expect(await snapshot(user.id)).toEqual(before);
  });
});

describe("another org", () => {
  it("keeps the rules of a member of another org, whatever this user posts", async () => {
    const { user, cookie } = await mixed("tvorg");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO orgs (id, name) VALUES ('org-tv', 'Other')"),
      env.DB.prepare(
        "INSERT INTO users (id, org_id, email, role) VALUES ('tv-other', 'org-tv', 'tv@other.example', 'member')",
      ),
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, provider, email) VALUES ('tv-x', 'tv-other', 'microsoft', 'x@x.example'), ('tv-y', 'tv-other', 'google', 'y@mail.example')",
      ),
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES ('tv-x-cal', 'tv-x', 'x', 'Main', 1, 1, 1), ('tv-y-cal', 'tv-y', 'y', 'Main', 1, 1, 1)",
      ),
      env.DB.prepare(
        `INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options)
         VALUES ('tv-rule', 'tv-other', 'tv-x-cal', 'tv-y-cal', '{"detailLevel":"busy","markPrivate":true}')`,
      ),
    ]);
    const before = await snapshot("tv-other");
    const forged = await postForm(levelForm("tv-x", "tv-y", { copy: "full", who: "open" }), cookie);
    expect(forged.status).toBe(400);
    const fields = formFields(await page("/mirroring?d=all", cookie)).filter(
      ([name]) => name !== "newWho",
    );
    await postForm([...fields, ["newWho", "open"], ["applyWho", "1"]], cookie);
    expect(await snapshot("tv-other")).toEqual(before);
    expect(user.orgId).not.toBe("org-tv");
  });

  /** Default private; w > g busy-private, o > g busy-open, w > o title-open. */
  async function mixed(prefix: string) {
    const context = await setup(prefix);
    await setLevel(context.user, context.w, context.g, "busy-private");
    await setLevel(context.user, context.o, context.g, "busy-open");
    await setLevel(context.user, context.w, context.o, "title-open");
    return context;
  }
});

describe("mirror all as busy from the new pages", () => {
  it("stores the default block title of the user's language before the first rules", async () => {
    const { user, cookie, w, g } = await setup("tvgroupde");
    const response = await exports.default.fetch(`${BASE}/rules/group/all`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
        "accept-language": "de",
      },
      body: new URLSearchParams({ back: "/mirroring" }),
    });
    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(response.status).toBeLessThan(400);
    const row = await env.DB.prepare("SELECT sync_settings AS json FROM users WHERE id = ?")
      .bind(user.id)
      .first<{ json: string }>();
    expect(JSON.parse(row?.json ?? "{}")).toMatchObject({
      blockTitle: de.editor.defaultBlockTitle,
    });
    expect(de.editor.defaultBlockTitle).not.toBe(en.editor.defaultBlockTitle);
    expect(await ruleOf(w, g)).toMatchObject({ blockTitle: de.editor.defaultBlockTitle });
  });
});
