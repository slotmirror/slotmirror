import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { recentChanges, type ActivityRow, type RuleOutcome } from "../src/audit";
import { SILENT_RULE_MS } from "../src/alerts";
import type { EditorState } from "../src/editor";
import { i18nFor } from "../src/i18n";
import { changeEntries, describeActivity } from "../src/pages/next/describe";
import { LevelMark } from "../src/pages/next/identity";
import {
  ageRange,
  blocksOf,
  calendarFlows,
  headerState,
  mirroringStats,
  reasonKind,
  shortAge,
  type MirroringStat,
  type MirroringState,
} from "../src/pages/next/overview";
import { BASE, signIn } from "./helpers";

async function get(path: string, cookie: string, language = "en") {
  return exports.default.fetch(`${BASE}${path}`, {
    headers: { cookie, "accept-language": language },
    redirect: "manual",
  });
}

/**
 * A user with two calendars named "alpha" and "beta" (the names come from the addresses) and, if
 * asked, one mirroring alpha to beta at the level "busy". Beta to alpha stays "not copied".
 */
async function setup(prefix: string, options: { rule?: boolean; reconnect?: boolean } = {}) {
  const { user, cookie } = await signIn(`${prefix}@org.example`);
  const ids = { a: `${prefix}-a`, b: `${prefix}-b` };
  const rows = [
    [ids.a, `${prefix}@alpha.example`, "microsoft"],
    [ids.b, `${prefix}@beta.example`, "google"],
  ] as const;
  for (const [id, email, provider] of rows) {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, provider, email, needs_reconnect) VALUES (?, ?, ?, ?, ?)",
      ).bind(id, user.id, provider, email, options.reconnect && id === ids.a ? 1 : 0),
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, ?, 'Main', 1, 1, 1)",
      ).bind(`${id}-cal`, id, `${id}-remote`),
    ]);
  }
  const ruleId = `${prefix}-rule`;
  if (options.rule) {
    await env.DB.prepare(
      "INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(
        ruleId,
        user.id,
        `${ids.a}-cal`,
        `${ids.b}-cal`,
        JSON.stringify({ detailLevel: "busy" }),
      )
      .run();
  }
  return { user, cookie, ids, ruleId };
}

/** An audit row of the user; `agoMs` puts it in the past. */
async function addEvent(
  userId: string,
  ruleId: string | null,
  accountId: string,
  kind: string,
  detail: object,
  agoMs = 0,
) {
  await env.DB.prepare(
    `INSERT INTO audit_events (org_id, user_id, account_id, rule_id, kind, detail, created_at)
     VALUES ('default', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      userId,
      accountId,
      ruleId,
      kind,
      JSON.stringify(detail),
      new Date(Date.now() - agoMs).toISOString(),
    )
    .run();
}

const RUN_OK = {
  dryRun: false,
  create: 2,
  update: 0,
  delete: 0,
  unchanged: 20,
  failed: 0,
  remaining: 0,
};
const RUN_QUIET = { ...RUN_OK, create: 0, unchanged: 22 };
const HOUR = 60 * 60_000;

/** The text of the page header's lead, without tags. */
function lead(html: string): string {
  const match = /<p class="page-lead">([\s\S]*?)<\/p>/.exec(html);
  return (match?.[1] ?? "").replace(/<[^>]+>/g, "");
}

/** The HTML of one map cell, from its link to the end of its cell. */
function cellHtml(html: string, from: string, to: string): string {
  const start = html.lastIndexOf(
    '<a class="ov-cell-link',
    html.indexOf(`data-direction="${from}~${to}"`),
  );
  return html.slice(start, html.indexOf("</td>", start));
}

/** The HTML of the map section: the table and the phone list. */
function mapHtml(html: string): string {
  const start = html.indexOf('class="ov-section ov-map"');
  const end = html.indexOf('<div class="ov-side">', start);
  return html.slice(start, end < 0 ? undefined : end);
}

describe("ageRange", () => {
  it("shows one age when they match and a range when they differ", () => {
    expect(ageRange("3 days", "3 days")).toBe("3 days");
    expect(ageRange("3 Tg.", "4 Tg.")).toBe("3\u20134 Tg.");
    expect(ageRange("3 days", "4 days")).toBe("3\u20134 days");
    expect(ageRange("5 hr", "2 days")).toBe("5 hr \u2013 2 days");
  });
});

describe("overview header state", () => {
  it("says how many mirrorings are in sync and when the last run was", async () => {
    const { user, cookie, ids, ruleId } = await setup("ov-fine", { rule: true });
    await addEvent(user.id, ruleId, ids.b, "sync_run", RUN_OK, 8 * 60_000);
    const html = await (await get("/", cookie)).text();
    expect(html).toContain('class="ov-state is-ok"');
    expect(lead(html)).toBe("1 mirroring in sync · newest run 8 min ago");
    // Nothing needs attention: the section is absent, not an empty box.
    expect(html).not.toContain("ov-attention");
    expect(html).not.toContain("Needs attention");
  });

  it("names a failing mirroring in the danger tone", async () => {
    const { user, cookie, ids, ruleId } = await setup("ov-failing", { rule: true });
    await addEvent(user.id, ruleId, ids.b, "sync_failed", { code: "graph_429" });
    const html = await (await get("/", cookie)).text();
    expect(html).toContain('class="ov-state is-danger"');
    expect(lead(html)).toContain("1 of 1 needs attention");
    expect(lead(html)).not.toContain("in sync");
  });

  it("marks a mirroring overdue after the silence threshold of the alerts, not before", async () => {
    const late = await setup("ov-late", { rule: true });
    await addEvent(
      late.user.id,
      late.ruleId,
      late.ids.b,
      "sync_run",
      RUN_OK,
      SILENT_RULE_MS + HOUR,
    );
    const html = await (await get("/", late.cookie)).text();
    expect(html).toContain('class="ov-state is-warn"');
    expect(lead(html)).toContain("1 of 1 needs attention");
    expect(cellHtml(html, late.ids.a, late.ids.b)).toContain("is-overdue");
    expect(cellHtml(html, late.ids.a, late.ids.b)).toContain("No run for 4 hr");

    const recent = await setup("ov-recent", { rule: true });
    await addEvent(
      recent.user.id,
      recent.ruleId,
      recent.ids.b,
      "sync_run",
      RUN_OK,
      SILENT_RULE_MS - HOUR,
    );
    const fine = await (await get("/", recent.cookie)).text();
    expect(fine).toContain('class="ov-state is-ok"');
    expect(cellHtml(fine, recent.ids.a, recent.ids.b)).toContain("is-ok");
  });

  it("counts a calendar that needs a reconnect, not its mirrorings", async () => {
    const { user, cookie, ids, ruleId } = await setup("ov-reconnect", {
      rule: true,
      reconnect: true,
    });
    await addEvent(user.id, ruleId, ids.b, "sync_run", RUN_OK);
    const html = await (await get("/", cookie)).text();
    expect(lead(html)).toContain("1 calendar needs reconnecting");
    expect(lead(html)).not.toContain("attention");
    expect(cellHtml(html, ids.a, ids.b)).toContain("Connection lost");
    // A blocked mirroring is danger on the map cell too, as in the list and the attention item.
    expect(cellHtml(html, ids.a, ids.b)).toContain("ov-cell-link is-blocked");
    expect(cellHtml(html, ids.a, ids.b)).toContain(
      '<span class="ov-tone is-danger">Connection lost',
    );
    expect(cellHtml(html, ids.a, ids.b)).not.toContain("is-warn");
  });

  it("states it in German", async () => {
    const { user, cookie, ids, ruleId } = await setup("ov-de", { rule: true });
    await addEvent(user.id, ruleId, ids.b, "sync_failed", { code: "graph_503" });
    const html = await (await get("/", cookie, "de")).text();
    expect(lead(html)).toContain("1 von 1 zu prüfen");
    expect(html).toContain("Beim Anbieter gab es ein Problem");
    expect(html).toContain("Spiegelung öffnen");
    expect(html).toContain("Nicht kopiert");
    expect(html).toContain("Änderungen, letzte 24 Std.");
  });
});

describe("overview needs attention", () => {
  it("opens the failed mirroring first and offers its activity second", async () => {
    const { user, cookie, ids, ruleId } = await setup("ov-failed", { rule: true });
    await addEvent(user.id, ruleId, ids.b, "sync_failed", { code: "graph_429" });
    const html = await (await get("/", cookie)).text();
    const row = html.slice(
      html.indexOf('data-key="failed-'),
      html.indexOf("</li>", html.indexOf('data-key="failed-')),
    );
    expect(row).toContain("alpha");
    expect(row).toContain("beta");
    expect(row).toContain("Failed.");
    expect(row).toContain("The provider is slowing slotmirror down");
    const mirroring = row.indexOf(`href="/mirroring?d=${ids.a}~${ids.b}"`);
    const activity = row.indexOf(`href="/activity?d=${ids.a}~${ids.b}&amp;kind=problems"`);
    expect(mirroring).toBeGreaterThan(-1);
    expect(activity).toBeGreaterThan(mirroring);
    expect(html).not.toContain("graph_429");
  });

  it("shows the code in muted text only when it has no sentence", async () => {
    const { user, cookie, ids, ruleId } = await setup("ov-unknown", { rule: true });
    await addEvent(user.id, ruleId, ids.b, "sync_failed", { code: "StrangeError" });
    const html = await (await get("/", cookie)).text();
    expect(html).toContain("no explanation for this error yet");
    expect(html).toContain('class="ov-code"');
    expect(html).toContain("StrangeError");
  });

  it("offers the reconnect for a calendar that needs it, and its panel", async () => {
    const { cookie, ids } = await setup("ov-recon", { rule: true, reconnect: true });
    const html = await (await get("/", cookie)).text();
    expect(html).toContain(`data-key="reconnect-${ids.a}"`);
    expect(html).toContain(`href="/auth/microsoft/connect?account=${ids.a}"`);
    expect(html).toContain("Reconnect");
    // The map head of the calendar says it too, and links to the calendar's panel.
    expect(html).toContain(`class="ov-reconnect" href="/calendars?c=${ids.a}"`);
  });

  it("opens a mirroring without a run and names the state as the map does", async () => {
    const { user, cookie, ids, ruleId } = await setup("ov-norun", { rule: true });
    await addEvent(user.id, ruleId, ids.b, "sync_run", RUN_OK, 9 * HOUR);
    for (const [language, state, cell] of [
      ["en", ">No run for 9 hr. <", "No run for 9 hr<"],
      ["de", ">9 Std. ohne Lauf. <", "9 Std. ohne Lauf<"],
    ] as const) {
      const html = await (await get("/", cookie, language)).text();
      const start = html.indexOf(`data-key="overdue-${ids.a}~${ids.b}"`);
      expect(start, language).toBeGreaterThan(-1);
      const row = html.slice(start, html.indexOf("</li>", start));
      expect(row, language).toContain(state);
      expect(cellHtml(html, ids.a, ids.b), language).toContain(cell);
      // One name for the state: no "overdue" word, no relative time with a trailing "ago.".
      const visible = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
      expect(
        /.{0,40}(?:[Oo]verdue|überfällig|hr\. ago).{0,20}/.exec(visible)?.[0],
        language,
      ).toBeUndefined();
      expect(row, language).toContain(`href="/mirroring?d=${ids.a}~${ids.b}"`);
    }
  });

  it('writes a route as "from to to", as the other pages do', async () => {
    const { user, cookie, ids, ruleId } = await setup("ov-route", { rule: true });
    await addEvent(user.id, ruleId, ids.b, "sync_run", RUN_OK, 9 * HOUR);
    const html = await (await get("/", cookie)).text();
    const row = html.slice(html.indexOf(`data-key="overdue-${ids.a}~${ids.b}"`));
    expect(row.slice(0, row.indexOf("</li>"))).toContain('<span class="ov-to"> to </span>');
    expect(html).not.toContain("ov-arrow");
  });
});

describe("overview map", () => {
  it("renders one link per direction with the address of its mirroring", async () => {
    const { cookie, ids } = await setup("ov-map", { rule: true });
    const html = await (await get("/", cookie)).text();
    for (const href of [`/mirroring?d=${ids.a}~${ids.b}`, `/mirroring?d=${ids.b}~${ids.a}`]) {
      const cells = html.split(`href="${href}" aria-label=`).length - 1;
      // One cell in the table, one row in the phone list.
      expect(cells, href).toBe(2);
    }
    expect(html).toMatch(/aria-label="alpha to beta: Busy only(, [a-z ]+)?\. No run yet"/);
    expect(html).toContain('aria-label="beta to alpha: Not copied"');
  });

  it("uses table header cells with a scope for both axes", async () => {
    const { cookie } = await setup("ov-axes", { rule: true });
    const html = await (await get("/", cookie)).text();
    expect(html).toContain('scope="colgroup"');
    expect(html).toContain('<th class="ov-col" scope="col">');
    expect(html).toContain('<th class="ov-row" scope="row">');
    expect(html).toContain(">Appears in<");
    expect(html).toContain(">From<");
  });

  it("heads columns with what a calendar receives and rows with what it sends", async () => {
    const { user, cookie, ids, ruleId } = await setup("ov-heads", { rule: true });
    await addEvent(user.id, ruleId, ids.b, "sync_run", RUN_OK);
    const html = await (await get("/", cookie)).text();
    // A count says what it counts: copies.
    expect(html).toContain(">receives 22 copies<");
    expect(html).toContain(">sends 22 copies<");
    const de = await (await get("/", cookie, "de")).text();
    expect(de).toContain(">empfängt 22 Kopien<");
    expect(de).toContain(">sendet 22 Kopien<");
    expect(html).toContain(">receives nothing<");
    expect(html).toContain(">sends nothing<");
    // The calendar strip is gone: the heads carry its numbers.
    expect(html).not.toContain("ov-strip");
  });

  it("shows the mark, the block count and the age in an active cell", async () => {
    const { user, cookie, ids, ruleId } = await setup("ov-count", { rule: true });
    await addEvent(user.id, ruleId, ids.b, "sync_run", RUN_OK, 8 * 60_000);
    const cell = cellHtml(await (await get("/", cookie)).text(), ids.a, ids.b);
    expect(cell).toContain("is-ok");
    expect(cell).toContain(">22 copies<");
    expect(cell).toContain(">8 min<");
    expect(cell).toContain('data-level="busy-');
  });

  it("names the level once in the head when every copy has it, and not in the cells", async () => {
    const { cookie, ids } = await setup("ov-uniform", { rule: true });
    for (const [language, head] of [
      ["en", /<p class="ov-hint ov-uniform">.*All copies: Busy only, (private|same as you)<\/p>/],
      ["de", /<p class="ov-hint ov-uniform">.*Alle Kopien: Nur belegt, (privat|wie bei dir)<\/p>/],
    ] as const) {
      const html = await (await get("/", cookie, language)).text();
      expect(html, language).toMatch(head);
      const cell = cellHtml(html, ids.a, ids.b);
      expect(cell, language).not.toContain('class="ov-level"');
      // The accessible name keeps the whole level.
      expect(cell, language).toMatch(/aria-label="alpha (to|nach) beta: (Busy only|Nur belegt), /);
      // A cell that is not copied keeps its label.
      expect(cellHtml(html, ids.b, ids.a), language).toContain('class="ov-level"');
    }
  });

  it("labels every cell with the level of the list when the levels differ", async () => {
    const { user, cookie, ids } = await setup("ov-mixed", { rule: true });
    await env.DB.prepare(
      "INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(
        "ov-mixed-rule-2",
        user.id,
        `${ids.b}-cal`,
        `${ids.a}-cal`,
        JSON.stringify({ detailLevel: "title" }),
      )
      .run();
    for (const [language, busy, title, short] of [
      ["en", "Busy only, ", "Title, ", /Busy, private|>Busy<|>Title<|>All<|>Off</],
      ["de", "Nur belegt, ", "Titel, ", /Belegt, privat|>Belegt<|>Titel<|>Alles<|>Aus</],
    ] as const) {
      const html = await (await get("/", cookie, language)).text();
      expect(html, language).not.toContain("ov-uniform");
      expect(cellHtml(html, ids.a, ids.b), language).toContain(`<span class="ov-level">${busy}`);
      expect(cellHtml(html, ids.b, ids.a), language).toContain(`<span class="ov-level">${title}`);
      // The short map labels are gone: map, list and panel use one string per level.
      expect(mapHtml(html), language).not.toMatch(short);
    }
  });

  it("draws the diagonal as an empty cell, with no dash character", async () => {
    const { cookie } = await setup("ov-diagonal", { rule: true });
    const html = await (await get("/", cookie)).text();
    // One per calendar; the line is drawn by CSS (`.ov-self::after`).
    expect(html.match(/<td class="ov-self"><\/td>/g)).toHaveLength(2);
    expect(mapHtml(html)).not.toContain("\u2014");
  });

  it("says in words that a cell failed, with the count not written if known", async () => {
    const partial = await setup("ov-notwritten", { rule: true });
    await addEvent(partial.user.id, partial.ruleId, partial.ids.b, "sync_run", {
      ...RUN_OK,
      failed: 2,
    });
    const one = cellHtml(
      await (await get("/", partial.cookie)).text(),
      partial.ids.a,
      partial.ids.b,
    );
    expect(one).toContain("is-failed");
    expect(one).toContain('class="ov-tone is-danger">2 not written<');

    const failed = await setup("ov-cellfail", { rule: true });
    await addEvent(failed.user.id, failed.ruleId, failed.ids.b, "sync_failed", {
      code: "graph_503",
    });
    const two = cellHtml(await (await get("/", failed.cookie)).text(), failed.ids.a, failed.ids.b);
    expect(two).toContain('class="ov-tone is-danger">Failed<');
  });

  it("draws a not-copied cell without a box and with the dashed mark", async () => {
    const { cookie, ids } = await setup("ov-off", { rule: true });
    const cell = cellHtml(await (await get("/", cookie)).text(), ids.b, ids.a);
    expect(cell).toContain('class="ov-cell-link is-off"');
    expect(cell).toContain(">Not copied<");
    expect(cell).toContain('data-level="off"');
    expect(cell).not.toContain("ov-cell-meta");
  });
});

describe("overview changes in the last 24 hours", () => {
  it("adds up the runs of one mirroring and leaves out runs without a change", async () => {
    const { user, cookie, ids, ruleId } = await setup("ov-changes", { rule: true });
    await addEvent(
      user.id,
      ruleId,
      ids.b,
      "sync_run",
      { ...RUN_OK, create: 3, update: 1 },
      3 * HOUR,
    );
    await addEvent(user.id, ruleId, ids.b, "sync_run", RUN_QUIET, 2 * HOUR);
    await addEvent(user.id, ruleId, ids.b, "sync_run", { ...RUN_OK, create: 0, delete: 4 }, HOUR);
    await addEvent(user.id, ruleId, ids.b, "sync_run", RUN_QUIET, 10 * 60_000);
    // Older than the window: not counted.
    await addEvent(user.id, ruleId, ids.b, "sync_run", { ...RUN_OK, create: 50 }, 25 * HOUR);
    const html = await (await get("/", cookie)).text();
    const rows = html.split('class="ov-chg"').length - 1;
    expect(rows).toBe(1);
    expect(html).toContain(">3 new, 1 changed, 4 removed<");
    // The entry's age is the newest run with a change, not the quiet run after it.
    const entry = html.slice(html.indexOf('class="ov-chg"'));
    expect(entry).toContain(">1 hr<");
    expect(html).not.toContain("No changes");
  });

  it("names a change of level in plain words", async () => {
    const { user, cookie, ids, ruleId } = await setup("ov-edit", { rule: true });
    await addEvent(user.id, ruleId, ids.b, "rule_updated", { choice: "title", markPrivate: true });
    await addEvent(user.id, ruleId, ids.b, "rule_updated", {
      workDays: "1,2,3,4,5",
      workStart: "08:00",
      workEnd: "18:00",
      workTimeZone: "UTC",
    });
    const html = await (await get("/", cookie)).text();
    expect(html).toContain(">Now: Title, private · Working hours changed<");
  });

  it("puts everything about one mirroring in one row: level changes, then the runs", async () => {
    const { user, cookie, ids, ruleId } = await setup("ov-grouped", { rule: true });
    await addEvent(
      user.id,
      ruleId,
      ids.b,
      "sync_run",
      { ...RUN_OK, create: 3, update: 1 },
      3 * HOUR,
    );
    await addEvent(
      user.id,
      ruleId,
      ids.b,
      "rule_updated",
      { choice: "title", markPrivate: true, previousChoice: "busy", previousMarkPrivate: true },
      2 * HOUR,
    );
    await addEvent(
      user.id,
      ruleId,
      ids.b,
      "rule_updated",
      { choice: "full", markPrivate: true, previousChoice: "title", previousMarkPrivate: true },
      HOUR,
    );
    for (const [language, line] of [
      ["en", ">Changed 2× · now: Everything, private<"],
      ["de", ">2× geändert · jetzt: Alles, privat<"],
    ] as const) {
      const html = await (await get("/", cookie, language)).text();
      expect(html.split('class="ov-chg"').length - 1, language).toBe(1);
      const entry = html.slice(html.indexOf('class="ov-chg"'));
      expect(entry, language).toContain(line);
      expect(entry, language).toMatch(/> · (3 new, 1 changed|3 neu, 1 geändert)</);
      // A mirroring's row says how often in its words; no "times" count after it.
      expect(entry.slice(0, entry.indexOf("</li>")), language).not.toContain("ov-muted");
    }
  });

  it("says so in one muted line when nothing changed", async () => {
    const { user, cookie, ids, ruleId } = await setup("ov-quiet", { rule: true });
    await addEvent(user.id, ruleId, ids.b, "sync_run", RUN_QUIET);
    const html = await (await get("/", cookie)).text();
    expect(html).toContain('<p class="ov-empty">Nothing changed in the last 24 hours.</p>');
    expect(html).toContain('href="/activity"');
  });

  it("reads at most its limit of rows, and tells the page where the read stopped", async () => {
    const { user, ids, ruleId } = await setup("ov-scan", { rule: true });
    for (let i = 4; i >= 1; i--) {
      await addEvent(user.id, ruleId, ids.b, "sync_run", RUN_QUIET, i * HOUR);
    }
    await addEvent(user.id, ruleId, ids.b, "sync_run", RUN_OK, 5 * HOUR);
    const cut = await recentChanges(env.DB, user.id, Date.now(), 3);
    expect(cut.scanned).toBe(3);
    expect(cut.limit).toBe(3);
    expect(cut.rows).toEqual([]);
    const all = await recentChanges(env.DB, user.id, Date.now());
    expect(all.scanned).toBe(5);
    expect(all.rows.map((row) => row.kind)).toEqual(["sync_run"]);
  });
});

describe("account menu", () => {
  it("sets Delete my data apart below Sign out, in its own group and the danger colour", async () => {
    const { cookie } = await setup("ov-menu");
    const html = await (await get("/", cookie)).text();
    const menu = html.slice(html.indexOf('id="user-menu"'), html.indexOf('class="menu-foot"'));
    const signOut = menu.indexOf('action="/auth/logout"');
    const remove = menu.indexOf('<a class="menu-item menu-item-danger" href="/account/delete">');
    expect(signOut).toBeGreaterThan(0);
    expect(remove).toBeGreaterThan(signOut);
    // A separator between the two, and one after the danger entry.
    expect(menu.slice(signOut, remove)).toContain('<div class="menu-sep">');
    expect(menu.slice(remove)).toContain('<div class="menu-sep">');
  });
});

describe("overview first run", () => {
  it("offers one click to block each other when two calendars have no mirroring", async () => {
    const { cookie } = await setup("ov-start");
    const html = await (await get("/", cookie)).text();
    expect(html).toContain('action="/rules/group/all"');
    expect(html).toContain("Mirror all as busy");
    expect(html).not.toContain("ov-matrix");
    // No live state before anything is mirrored.
    expect(html).not.toContain("ov-state");
  });

  it("asks for the first calendar when none is connected", async () => {
    const { cookie } = await signIn("ov-none@org.example");
    const html = await (await get("/", cookie)).text();
    expect(html).toContain("Connect your first calendar");
    expect(html).toContain('href="/calendars"');
    expect(html).toContain('class="ov-grid is-single"');
  });

  it("asks for a second calendar when one is connected", async () => {
    const { user, cookie } = await signIn("ov-one@org.example");
    await env.DB.prepare(
      "INSERT INTO accounts (id, user_id, provider, email) VALUES ('ov-one-a', ?, 'google', 'one@alpha.example')",
    )
      .bind(user.id)
      .run();
    const html = await (await get("/", cookie, "de")).text();
    expect(html).toContain("Verbinde einen zweiten Kalender");
  });
});

describe("reasonKind", () => {
  it("maps the codes that errorCode writes", () => {
    expect(reasonKind("token_invalid_grant")).toBe("token");
    expect(reasonKind("graph_429")).toBe("throttled");
    expect(reasonKind("google_403_rateLimitExceeded")).toBe("throttled");
    expect(reasonKind("graph_503")).toBe("server");
    expect(reasonKind("google_403_forbidden")).toBe("denied");
    expect(reasonKind("graph_404")).toBe("missing");
    expect(reasonKind("TypeError")).toBe("unknown");
  });
});

function outcome(
  ruleId: string,
  createdAt: string,
  detail: RuleOutcome["detail"],
  kind: RuleOutcome["kind"] = "sync_run",
): RuleOutcome {
  return { ruleId, accountId: null, kind, createdAt, enabled: true, detail };
}

function slot(id: string) {
  return {
    sourceCalendarId: `${id}-cal`,
    rule: { id, enabled: true, origin: "custom", options: {}, optionsJson: "{}" },
  };
}

/** A state with calendars a, b, c and the mirrorings a>b (rules r1, r2), a>c (r3), b>a (off). */
function fakeState(): EditorState {
  const account = (id: string) => ({
    id,
    name: id,
    email: `${id}@x.example`,
    needsReconnect: false,
  });
  const direction = (from: string, to: string, effective: string, slots: object[]) => ({
    from,
    to,
    ruleId: null,
    effective,
    slots,
  });
  return {
    accounts: ["a", "b", "c"].map(account),
    directions: [
      direction("a", "b", "busy", [slot("r1"), slot("r2")]),
      direction("a", "c", "busy", [slot("r3")]),
      direction("b", "a", "off", []),
    ],
    rules: [
      { from: "a", to: "b", rule: slot("r1").rule },
      { from: "a", to: "c", rule: slot("r3").rule },
    ],
  } as unknown as EditorState;
}

const NOW = Date.parse("2026-11-17T12:00:00Z");

describe("mirroring numbers", () => {
  it("adds unchanged, create and update, and ignores deletions", () => {
    expect(blocksOf({ unchanged: 10, create: 3, update: 1, delete: 7 })).toBe(14);
  });

  it("returns null, not 0, if a field is missing", () => {
    expect(blocksOf({ create: 3, update: 1 })).toBeNull();
    expect(blocksOf({ code: "graph_503" })).toBeNull();
  });

  it("sums the rules of one direction and leaves an off direction out", () => {
    const stats = mirroringStats(
      fakeState(),
      [
        outcome("r1", "2026-11-17T11:00:00Z", { unchanged: 4, create: 1, update: 0 }),
        outcome("r2", "2026-11-17T11:05:00Z", { unchanged: 6, create: 0, update: 2 }),
        outcome("r3", "2026-11-17T10:00:00Z", { unchanged: 1, create: 0, update: 0 }),
      ],
      NOW,
    );
    expect(stats.get("a~b")).toMatchObject({
      state: "ok",
      blocks: 13,
      at: "2026-11-17T11:05:00Z",
      stale: "2026-11-17T11:00:00Z",
    });
    expect(stats.has("b~a")).toBe(false);
  });

  it("is overdue when the rule that waited longest is past the alert threshold", () => {
    const stale = new Date(NOW - SILENT_RULE_MS - 60_000).toISOString();
    const stats = mirroringStats(
      fakeState(),
      [
        outcome("r1", "2026-11-17T11:55:00Z", { unchanged: 4, create: 0, update: 0 }),
        outcome("r2", stale, { unchanged: 6, create: 0, update: 0 }),
      ],
      NOW,
    );
    expect(stats.get("a~b")).toMatchObject({ state: "overdue", stale });
    expect(stats.get("a~c")?.state).toBe("waiting");
  });

  it("puts a failure before overdue and a reconnect before a failure", () => {
    const state = fakeState();
    const failed = [outcome("r3", "2026-11-17T01:00:00Z", { code: "graph_503" }, "sync_failed")];
    expect(mirroringStats(state, failed, NOW).get("a~c")?.state).toBe("failed");
    const accountA = state.accounts[0];
    if (accountA) accountA.needsReconnect = true;
    expect(mirroringStats(state, failed, NOW).get("a~c")?.state).toBe("blocked");
  });

  it("sums per calendar: receives by target, sends by source", () => {
    const stats = mirroringStats(
      fakeState(),
      [
        outcome("r1", "2026-11-17T11:00:00Z", { unchanged: 4, create: 1, update: 0 }),
        outcome("r3", "2026-11-17T11:00:00Z", { unchanged: 1, create: 0, update: 0 }),
      ],
      NOW,
    );
    const flows = calendarFlows(fakeState(), stats);
    expect(flows.get("a")?.sends).toEqual({ mirrorings: 2, blocks: 6 });
    expect(flows.get("a")?.receives).toEqual({ mirrorings: 0, blocks: null });
    expect(flows.get("b")?.receives).toEqual({ mirrorings: 1, blocks: 5 });
  });
});

describe("header state", () => {
  const text = i18nFor("en").t.next.overview.state;
  const stat = (state: MirroringState, at: string | null = "2026-11-17T11:52:00Z") =>
    ({
      state,
      at,
      blocks: 1,
      stale: at,
      notWritten: 0,
      waiting: 0,
      failure: null,
    }) as MirroringStat;

  it("counts what needs attention, in danger when one failed, and the total once", () => {
    const stats = new Map<string, MirroringStat>([
      ["a~b", stat("failed")],
      ["a~c", stat("overdue")],
      ["b~c", stat("overdue")],
      ["c~a", stat("ok")],
    ]);
    const header = headerState(stats, 0, text);
    expect(header.tone).toBe("danger");
    expect(header.text).toBe("3 of 4 need attention");
  });

  it("is warn for overdue alone and ok when all ran", () => {
    expect(headerState(new Map([["a~b", stat("overdue")]]), 0, text)).toMatchObject({
      tone: "warn",
      text: "1 of 1 needs attention",
    });
    expect(headerState(new Map([["a~b", stat("ok")]]), 0, text)).toMatchObject({
      tone: "ok",
      text: "1 mirroring in sync",
      checked: "2026-11-17T11:52:00Z",
    });
    expect(headerState(new Map([["a~b", stat("waiting", null)]]), 0, text).tone).toBe("idle");
  });
});

describe("short ages", () => {
  it("speaks both languages in the short form", () => {
    const at = new Date(NOW - 8 * 60_000).toISOString();
    expect(shortAge(at, NOW, "en", "now")).toBe("8 min");
    expect(shortAge(at, NOW, "de", "jetzt")).toBe("8 Min.");
    expect(shortAge(new Date(NOW - 9 * HOUR).toISOString(), NOW, "en", "now")).toBe("9 hr");
    expect(shortAge(new Date(NOW - 20_000).toISOString(), NOW, "de", "jetzt")).toBe("jetzt");
  });
});

describe("change entries", () => {
  const { t } = i18nFor("en");
  const row = (kind: ActivityRow["kind"], detail: object, ruleId: string | null, at: string) => ({
    id: 1,
    kind,
    detail: JSON.stringify(detail),
    createdAt: at,
    email: null,
    accountEmail: "b@x.example",
    ruleId,
  });

  it("joins the runs of a mirroring across its rules and keeps the newest time", () => {
    const entries = changeEntries(
      [
        row(
          "sync_run",
          { create: 1, update: 0, delete: 0, failed: 2 },
          "r1",
          "2026-11-17T11:00:00Z",
        ),
        row("rule_updated", { choice: "busy" }, "r1", "2026-11-17T10:30:00Z"),
        row("sync_run", { create: 2, update: 3, delete: 1 }, "r1", "2026-11-17T10:00:00Z"),
      ],
      fakeState(),
      t,
    );
    // One entry per mirroring: its runs and its level change together.
    expect(entries.map((entry) => entry.key)).toEqual(["m:a~b"]);
    expect(entries[0]).toMatchObject({
      at: "2026-11-17T11:00:00Z",
      sync: { created: 3, updated: 3, removed: 1, failed: 2 },
      levelChanges: 1,
      count: 3,
    });
  });
});

describe("activity sentence for the activity page", () => {
  const { t } = i18nFor("en");
  const row = (detail: object, ruleId: string | null = "r1") => ({
    id: 1,
    kind: "sync_run" as const,
    detail: JSON.stringify(detail),
    createdAt: "2026-11-17T10:00:00.000Z",
    email: null,
    accountEmail: "b@x.example",
    ruleId,
  });

  it("names both calendars and leaves out parts that are zero", () => {
    const line = describeActivity(
      row({ dryRun: false, create: 3, update: 0, delete: 23, failed: 0 }),
      fakeState(),
      t,
    );
    expect(line.title).toBe("a to b");
    expect(line.detail).toBe("3 new, 23 removed");
  });

  it("says that a run had no changes and marks it quiet", () => {
    const line = describeActivity(
      row({ dryRun: false, create: 0, update: 0, delete: 0, failed: 0 }),
      fakeState(),
      t,
    );
    expect(line.detail).toBe("No changes");
    expect(line.quiet).toBe(true);
  });

  it("falls back to the target name if the rule is gone", () => {
    const line = describeActivity(
      row({ dryRun: false, create: 1, update: 0, delete: 0 }, "gone"),
      fakeState(),
      t,
    );
    expect(line.title).toBe("Run for b");
  });
});

describe("level mark", () => {
  it("draws the block for each level and a lock only for the private ones", async () => {
    const html = async (level: Parameters<typeof LevelMark>[0]["level"]) =>
      String(await LevelMark({ level, tint: "green" }));
    expect(await html("off")).toContain("M5 2.5h2M9 2.5h2");
    expect(await html("busy-open")).toContain('x1="4.5" y1="11.5" x2="11.5" y2="4.5"');
    // The lock: a 1 px outline over a 1 px knock-out, not a solid block.
    const lock = '<rect x="10.5" y="10.5" width="5" height="4" rx="1" stroke="currentColor"';
    expect(await html("busy-private")).toContain(lock);
    expect(await html("busy-private")).not.toContain('fill="currentColor"');
    expect(await html("busy-open")).not.toContain("lmark-lock");
    expect((await html("title-open")).match(/<line /g)).toHaveLength(1);
    expect((await html("full-open")).match(/<line /g)).toHaveLength(3);
    expect(await html("title-private")).toContain(lock);
    expect(await html("title-open")).not.toContain("lmark-lock");
    // The tint colours the content; the frame keeps the text colour.
    expect(await html("busy-open")).toContain("--c:#00775a");
    expect(await html("busy-open")).toContain('stroke="currentColor"');
  });
});
