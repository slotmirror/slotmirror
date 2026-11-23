/**
 * The words of "What others see" on the redesigned pages, and the save-bar notes that tell a person
 * what a save does before it happens: a mirroring that is off and turned on as "Same as you", a
 * lower level that stays visible to others, and "Not copied" for a mirroring with copies.
 */
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LEVELS, parseLevel, setDirection, setDirections, type Level } from "../src/editor";
import { de } from "../src/i18n/de";
import { en } from "../src/i18n/en";
import { changeEffect, stillSeen } from "../src/pages/next/levels";
import { BASE, signIn } from "./helpers";

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
  return { user, cookie, w, o, g, names: { [w]: "work", [o]: "other", [g]: "Gmail" } };
}

type User = Awaited<ReturnType<typeof setup>>["user"];

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

async function page(path: string, cookie: string, language = "en") {
  const response = await exports.default.fetch(`${BASE}${path}`, {
    headers: { cookie, "accept-language": language },
    redirect: "manual",
  });
  expect(response.status, path).toBe(200);
  return response.text();
}

function decode(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/** The save-bar notes of a panel by the level they belong to: the tag and the text. */
function notes(html: string) {
  return Object.fromEntries(
    [...html.matchAll(/<p data-note[^>]*data-sentence="([^"]+)"[^>]*>([^<]*)</g)].map((match) => [
      match[1] ?? "",
      { tag: decode(match[0]), text: decode(match[2] ?? "") },
    ]),
  );
}

/** The label of one answer of a radio group, as markup. */
function answer(html: string, name: string, value: string): string {
  const start = html.indexOf(`name="${name}" value="${value}"`);
  expect(start, `${name}=${value}`).toBeGreaterThan(0);
  return html.slice(start, html.indexOf("</label>", start));
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

const OPEN = ["busy-open", "title-open", "full-open"] as const;
const PRIVATE = ["busy-private", "title-private", "full-private"] as const;

describe("turning a mirroring on as Same as you (walkthrough C1)", () => {
  it("counts every open level from Not copied as widening, and no private one", () => {
    for (const level of OPEN) expect(changeEffect("off", level), level).toBe("widens");
    for (const level of PRIVATE) expect(changeEffect("off", level), level).toBe("more");
    expect(changeEffect("off", "off")).toBe("none");
    // From a copied level, busy for everyone shows only the copy's own title: no warning.
    expect(changeEffect("busy-private", "busy-open")).toBe("more");
  });

  for (const defaultPrivate of [false, true]) {
    it(`warns with its own button for each open level (default ${defaultPrivate ? "private" : "open"})`, async () => {
      const { user, cookie, w, o, names } = await setup(`vwon${String(defaultPrivate)}`);
      await setStoredDefault(user.id, defaultPrivate);
      const found = notes(await page(`/mirroring?d=${w}~${o}`, cookie));
      const bar = en.next.mirroring.bar;
      const from = names[w] ?? "";
      const to = names[o] ?? "";
      expect(found["busy-open"]?.tag).toContain("data-warn");
      expect(found["busy-open"]?.tag).toContain(`data-button="${bar.buttonBusy("Busy")}"`);
      expect(found["busy-open"]?.text).toBe(bar.sentence["busy-open"](from, to, "Busy"));
      for (const level of ["title-open", "full-open"] as const) {
        expect(found[level]?.tag, level).toContain("data-warn");
        expect(found[level]?.tag, level).toContain(`data-button="${bar.button[level]}"`);
        expect(found[level]?.text, level).toBe(bar.sentence[level](from, to));
      }
      for (const level of PRIVATE) {
        expect(found[level]?.tag, level).not.toContain("data-warn");
        expect(found[level]?.tag, level).not.toContain("data-button");
        expect(found[level]?.text, level).toBe(bar.sentence[level](from, to));
      }
    });
  }

  it("marks the preselected answer as the default while the mirroring is off", async () => {
    const { user, cookie, w, o } = await setup("vwdefault");
    const text = en.next.mirroring;
    await setStoredDefault(user.id, false);
    let html = await page(`/mirroring?d=${w}~${o}`, cookie);
    const open = decode(answer(html, "who", "open"));
    expect(open).toContain("checked");
    expect(open).toContain(`title="${text.whoDefaultNote}"`);
    expect(open).toContain(`>${text.whoDefaultMark}<`);
    expect(answer(html, "who", "private")).not.toContain("mx-default");
    expect(decode(html)).toContain(`<span class="mx-who-default">${text.whoDefaultNote}</span>`);
    // The default is private: the mark moves with it.
    await setStoredDefault(user.id, true);
    html = await page(`/mirroring?d=${w}~${o}`, cookie);
    expect(answer(html, "who", "private")).toContain("mx-default");
    expect(answer(html, "who", "open")).not.toContain("mx-default");
    // A mirroring that is on shows its own answer, without a mark.
    await setLevel(user, w, o, "busy-open");
    html = await page(`/mirroring?d=${w}~${o}`, cookie);
    expect(html).not.toContain("mx-default");
    expect(html).not.toContain("mx-who-default");
  });
});

describe("a lower level that stays visible to others", () => {
  it("knows what others still see", () => {
    expect(stillSeen("title-open", "busy-open")).toBe("busy");
    expect(stillSeen("full-open", "busy-open")).toBe("busy");
    expect(stillSeen("full-open", "title-open")).toBe("titles");
    // An open copy that becomes private again: others see a private event or "busy" again.
    expect(stillSeen("title-open", "title-private")).toBe("private");
    expect(stillSeen("busy-open", "busy-private")).toBe("private");
    expect(stillSeen("full-open", "busy-private")).toBe("private");
    expect(stillSeen("title-private", "busy-private")).toBeNull();
    expect(stillSeen("title-open", "full-open")).toBeNull();
    expect(stillSeen("title-open", "off")).toBeNull();
    expect(stillSeen("off", "busy-private")).toBeNull();
  });

  it("says that others still see the copy, as a note without a warning", async () => {
    const { user, cookie, w, o } = await setup("vwlower");
    const bar = en.next.mirroring.bar;
    await setLevel(user, w, o, "title-open");
    let found = notes(await page(`/mirroring?d=${w}~${o}`, cookie));
    expect(found["busy-open"]?.text).toBe(bar.stillSeesBusy("Busy"));
    expect(found["busy-open"]?.tag).not.toContain("data-warn");
    expect(found["busy-open"]?.tag).not.toContain("data-button");
    // Private shows others less: the note says what they see again, without a warning.
    for (const level of ["busy-private", "title-private"]) {
      expect(found[level]?.text, level).toBe(bar.privateAgain.microsoft);
      expect(found[level]?.tag, level).not.toContain("data-warn");
      expect(found[level]?.tag, level).not.toContain("data-button");
    }
    await setLevel(user, w, o, "full-open");
    found = notes(await page(`/mirroring?d=${w}~${o}`, cookie));
    expect(found["title-open"]?.text).toBe(bar.stillSeesTitles);
    expect(found["busy-open"]?.text).toBe(bar.stillSeesBusy("Busy"));
    const german = notes(await page(`/mirroring?d=${w}~${o}`, cookie, "de"));
    expect(german["busy-open"]?.text).toBe(de.next.mirroring.bar.stillSeesBusy("Busy"));
    expect(german["full-private"]?.text).toBe("Andere sehen wieder einen privaten Termin.");
  });

  it("says what others see again in Google: only busy", async () => {
    const { user, cookie, w, g } = await setup("vwagain");
    await setLevel(user, w, g, "title-open");
    const found = notes(await page(`/mirroring?d=${w}~${g}`, cookie));
    expect(found["title-private"]?.text).toBe(en.next.mirroring.bar.privateAgain.google);
    const german = notes(await page(`/mirroring?d=${w}~${g}`, cookie, "de"));
    expect(german["title-private"]?.text).toBe("Andere sehen wieder nur „Beschäftigt“.");
  });
});

describe("turning a mirroring off", () => {
  async function run(userId: string, from: string, to: string, detail: object) {
    const rule = await env.DB.prepare(
      `SELECT r.id FROM rules r JOIN calendars sc ON sc.id = r.source_calendar_id
       JOIN calendars tc ON tc.id = r.target_calendar_id
       WHERE sc.account_id = ? AND tc.account_id = ?`,
    )
      .bind(from, to)
      .first<{ id: string }>();
    await env.DB.prepare(
      `INSERT INTO audit_events (org_id, user_id, account_id, rule_id, kind, detail, created_at)
       VALUES ('default', ?, ?, ?, 'sync_run', ?, ?)`,
    )
      .bind(userId, to, rule?.id ?? null, JSON.stringify(detail), new Date().toISOString())
      .run();
  }

  it("says how many copies go, from the counts of the list", async () => {
    const { user, cookie, w, o, names } = await setup("vwoff");
    const bar = en.next.mirroring.bar;
    await setLevel(user, w, o, "busy-private");
    // No run yet: the count is not known.
    let found = notes(await page(`/mirroring?d=${w}~${o}`, cookie));
    expect(found.off?.text).toBe(bar.copiesRemoved(null, names[o] ?? ""));
    expect(found.off?.tag).not.toContain("data-warn");
    // The Save button says what the save does.
    expect(found.off?.tag).toContain(`data-button="${bar.turnOff}"`);
    const base = { dryRun: false, delete: 0, failed: 0, durationMs: 9 };
    await run(user.id, w, o, { ...base, create: 3, update: 0, unchanged: 17 });
    const html = await page(`/mirroring?d=${w}~${o}`, cookie);
    found = notes(html);
    expect(found.off?.text).toBe(bar.copiesRemoved(20, names[o] ?? ""));
    // The same count as the list row shows.
    expect(html).toContain(en.next.shell.run.copies(20));
    const german = notes(await page(`/mirroring?d=${w}~${o}`, cookie, "de"));
    expect(german.off?.text).toBe("20 Kopien werden aus other entfernt.");
    // No copies: nothing to say.
    await run(user.id, w, o, { ...base, create: 0, update: 0, unchanged: 0 });
    expect(notes(await page(`/mirroring?d=${w}~${o}`, cookie)).off).toBeUndefined();
  });

  it("says Not copied in the panel head once the mirroring is off", async () => {
    const { user, cookie, w, o } = await setup("vwoffhead");
    const meta = (html: string) => {
      const start = html.indexOf('<p class="detail-meta">');
      expect(start).toBeGreaterThan(0);
      return decode(html.slice(start, html.indexOf("</p>", start)));
    };
    await setLevel(user, w, o, "busy-private");
    expect(meta(await page(`/mirroring?d=${w}~${o}`, cookie))).not.toContain("Not copied");
    await setLevel(user, w, o, "off");
    const head = meta(await page(`/mirroring?d=${w}~${o}`, cookie));
    expect(head).toContain("<span>Not copied</span>");
    expect(head.indexOf("Not copied")).toBeLessThan(head.indexOf(en.next.shell.run.viewActivity));
    const german = meta(await page(`/mirroring?d=${w}~${o}`, cookie, "de"));
    expect(german).toContain("<span>Nicht kopiert</span>");
  });
});

describe("one vocabulary for visibility (walkthrough C2)", () => {
  const OLD = [
    /\bonly you\b/i,
    /\beveryone with access\b/i,
    /\bnur du\b/i,
    /\balle mit zugriff\b/i,
  ];

  it("leaves none of the old words on the list, the panels and the overview", async () => {
    const { user, cookie, w, o, g } = await setup("vwwords");
    await setLevel(user, w, o, "busy-private");
    await setLevel(user, o, w, "title-open");
    await setLevel(user, w, g, "full-private");
    await setLevel(user, g, w, "busy-open");
    const paths = [
      "/",
      "/mirroring",
      "/mirroring?d=all",
      `/mirroring?d=${w}~${o}`,
      `/mirroring?d=${o}~${w}`,
      `/mirroring?d=${w}~${g}`,
      `/mirroring?d=${g}~${w}`,
      `/mirroring?d=${o}~${g}`,
    ];
    for (const language of ["en", "de"]) {
      for (const path of paths) {
        const html = decode(await page(path, cookie, language));
        for (const word of OLD) expect(html, `${language} ${path}`).not.toMatch(word);
      }
    }
    // The control: the new words are there, so the pages did render the visibility parts.
    const panel = decode(await page(`/mirroring?d=${w}~${o}`, cookie, "de"));
    expect(panel).toContain("Was andere sehen");
    expect(panel).toContain("Wie bei dir");
    const overview = decode(await page("/", cookie));
    expect(overview).toContain("Busy only, private");
  });

  it("names each map cell with its visible label first, so voice control finds it", async () => {
    const { user, cookie, w, o, g, names } = await setup("vwcell");
    // Two other levels on the map, so that the cells never share one level (the map then names
    // it once in its head and the cells drop their label).
    await setLevel(user, o, w, "busy-private");
    await setLevel(user, g, w, "full-open");
    for (const [language, catalog] of [
      ["en", en],
      ["de", de],
    ] as const) {
      for (const level of LEVELS) {
        await setLevel(user, w, o, level);
        const html = await page("/", cookie, language);
        const at = html.indexOf(`data-direction="${w}~${o}"`);
        const start = html.lastIndexOf('<a class="ov-cell-link', at);
        const cell = decode(html.slice(start, html.indexOf("</a>", start)));
        const shown =
          level === "off"
            ? catalog.next.overview.map.notCopied
            : catalog.next.shell.levels.summary[level];
        expect(cell, `${language} ${level}`).toContain(`<span class="ov-level">${shown}</span>`);
        const label = /aria-label="([^"]*)"/.exec(cell)?.[1] ?? "";
        expect(label, `${language} ${level}`).toMatch(
          new RegExp(`^${shown.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: ${names[w]} `),
        );
        expect(label, `${language} ${level}`).toContain(catalog.next.shell.levels.summary[level]);
      }
    }
  });
});

describe("one phrasing of the open visibility", () => {
  /**
   * "Everyone" overstates who sees an open copy: only people with access to the target do. The
   * name of the settings panel, "For all mirrorings", is not about visibility. The German answer
   * is "Wie bei dir" (decision of 2026-11-21); the old "Dasselbe wie du" must not return.
   */
  const WRONG = [
    /\beveryone\b/i,
    // "for all-day events" is about the day, not about people.
    /\bfor all\b(?! mirrorings|[-\u2011]day)/i,
    /\bto all\b/i,
    /für alle(?! Spiegelungen)/i,
    /dasselbe wie du/i,
  ];

  /** Every string of a catalog, with each function called on sample arguments. */
  function strings(value: unknown, path = ""): [string, string][] {
    if (typeof value === "string") return [[path, value]];
    if (typeof value === "function") {
      const args = Array.from({ length: value.length }, (_, index) => (index === 0 ? 2 : "X"));
      try {
        return strings((value as (...a: unknown[]) => unknown)(...args), `${path}()`);
      } catch {
        return strings((value as (...a: unknown[]) => unknown)("X", "Y", "Z"), `${path}()`);
      }
    }
    if (Array.isArray(value))
      return value.flatMap((item, index) => strings(item, `${path}.${index}`));
    if (value && typeof value === "object") {
      return Object.entries(value).flatMap(([key, item]) => strings(item, `${path}.${key}`));
    }
    return [];
  }

  it("leaves no other name in the catalogs of the pages that show visibility", () => {
    for (const [language, catalog] of [
      ["en", en],
      ["de", de],
    ] as const) {
      const { shell, mirroring, calendars, overview } = catalog.next;
      const found = strings({ shell, mirroring, calendars, overview }, language);
      // The control: the scan reached the strings that name the open visibility.
      expect(found.length).toBeGreaterThan(200);
      expect(found.map(([, text]) => text)).toContain(shell.levels.summary["title-open"]);
      for (const [path, text] of found) {
        for (const word of WRONG) expect(text, path).not.toMatch(word);
      }
    }
    expect(en.next.shell.levels.summary["busy-open"]).toBe("Busy only, same as you");
    expect(de.next.shell.levels.summary["title-open"]).toBe("Titel, wie bei dir");
    expect(de.next.shell.levels.summary["full-open"]).toBe("Alles, wie bei dir");
    expect(de.next.mirroring.whoOptions.open).toBe("Wie bei dir");
    expect(en.next.mirroring.bar.button["title-open"]).toBe("Show titles to others");
    expect(de.next.mirroring.all.applyOpenButton(3)).toBe(
      "3 Spiegelungen für andere sichtbar machen",
    );
  });

  it("leaves no other name on the pages", async () => {
    const { user, cookie, w, o, g } = await setup("vwphrase");
    await setLevel(user, w, o, "busy-open");
    await setLevel(user, o, w, "title-private");
    await setLevel(user, w, g, "full-open");
    const paths = [
      "/",
      "/mirroring",
      "/mirroring?d=all",
      `/mirroring?d=${w}~${o}`,
      `/mirroring?d=${o}~${w}`,
      `/mirroring?d=${w}~${g}`,
      "/calendars",
      `/calendars?c=${w}`,
    ];
    for (const language of ["en", "de"]) {
      for (const path of paths) {
        const html = decode(await page(path, cookie, language));
        for (const word of WRONG) expect(html, `${language} ${path}`).not.toMatch(word);
      }
    }
    // The control: the pages carry the open visibility and the settings name.
    const panel = decode(await page(`/mirroring?d=${w}~${o}`, cookie, "de"));
    expect(panel).toContain("Nur belegt, wie bei dir");
    expect(panel).toContain("Für alle Spiegelungen");
    expect(decode(await page("/mirroring", cookie))).toContain("For all mirrorings");
  });
});

describe("panel head and leave dialog", () => {
  it("puts the back link after the heading in the source, and gives Discard the danger style", async () => {
    const { user, cookie, w, o } = await setup("vwhead");
    await setLevel(user, w, o, "busy-private");
    const html = await page(`/mirroring?d=${w}~${o}`, cookie);
    const title = html.indexOf('class="detail-title"');
    const back = html.indexOf("detail-back");
    expect(title).toBeGreaterThan(0);
    expect(back).toBeGreaterThan(title);
    // The leave dialog is the one with data-guard. The palette and shortcut dialogs come first.
    const guardAt = html.indexOf("data-guard");
    expect(guardAt, "leave dialog").toBeGreaterThan(0);
    const open = html.lastIndexOf("<dialog", guardAt);
    expect(html.indexOf(">", open), "data-guard is on the dialog tag").toBeGreaterThan(guardAt);
    const dialog = decode(html.slice(open, html.indexOf("</dialog>", guardAt)));
    expect(dialog).toContain(`data-text-one="${en.next.shell.panel.guard.textOne}"`);
    expect(dialog).toContain(`data-text-many="${en.next.shell.panel.guard.text}"`);
    expect(dialog).toMatch(/class="btn btn-ghost btn-danger-ghost" data-guard-discard/);
    expect(de.next.shell.panel.guard.textOne).toBe("Wenn du jetzt gehst, ist die Änderung weg.");
  });

  it("prints working hours with the weekday names of the language", async () => {
    const { user, cookie, w, o } = await setup("vwdays");
    const hours = { workDays: [1, 2, 3, 4, 5], workStart: "08:00", workEnd: "18:00" };
    await env.DB.prepare("UPDATE accounts SET work_hours = ? WHERE id = ?")
      .bind(JSON.stringify({ ...hours, workTimeZone: "Europe/Vienna" }), w)
      .run();
    await setLevel(user, o, w, "busy-private");
    expect(await page("/mirroring", cookie)).toContain("Mon–Fri 08:00–18:00");
    expect(await page("/mirroring", cookie, "de")).toContain("Mo–Fr 08:00–18:00");
    expect(await page("/calendars", cookie)).toContain("Mon–Fri 08:00–18:00");
    expect(await page("/", cookie)).toContain("Mon–Fri 08:00–18:00");
  });
});
