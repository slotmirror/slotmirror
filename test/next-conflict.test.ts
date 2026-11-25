/**
 * Two tabs on one panel: every panel form carries the version `v` of the state it was
 * drawn from. A save with a stale version stores nothing and answers 409 with the stored values, a
 * fresh version and a warning. A save without `v` (the old pages) is accepted as before.
 */
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadEditorState, setDirection, setDirections } from "../src/editor";
import { de } from "../src/i18n/de";
import { en } from "../src/i18n/en";
import { accountVersion, directionVersion, settingsVersion } from "../src/versions";
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
  // The first save of a user without rules stores the default block title; store one before.
  await env.DB.prepare(
    "UPDATE users SET sync_settings = json_set(sync_settings, '$.blockTitle', 'Busy') WHERE id = ?",
  )
    .bind(user.id)
    .run();
  const [w, o, g] = accounts.map(([id]) => id) as [string, string, string];
  return { user, cookie, w, o, g };
}

type User = Awaited<ReturnType<typeof setup>>["user"];

async function page(path: string, cookie: string, language = "en") {
  const response = await exports.default.fetch(`${BASE}${path}`, {
    headers: { cookie, "accept-language": language },
    redirect: "manual",
  });
  expect(response.status, path).toBe(200);
  return response.text();
}

function post(path: string, fields: [string, string][], cookie: string, language = "en") {
  return exports.default.fetch(`${BASE}${path}`, {
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

const field = (fields: [string, string][], name: string) =>
  fields.find(([key]) => key === name)?.[1];

/** The fields with `name` set to `value` (added if absent). */
function withField(fields: [string, string][], name: string, value: string): [string, string][] {
  const rest = fields.filter(([key]) => key !== name);
  return [...rest, [name, value]];
}

function without(fields: [string, string][], name: string): [string, string][] {
  return fields.filter(([key]) => key !== name);
}

/** The first read of the editor state in a request: the read that the version check uses. */
const FIRST_READ = /FROM accounts WHERE user_id = \? ORDER BY created_at, id/;

/**
 * Runs `change` once, before or after the first batch whose SQL matches `pattern`, as another
 * tab would write at that moment. Returns whether it ran.
 */
function hook(pattern: RegExp, change: () => Promise<unknown>, when: "before" | "after" = "after") {
  const batch = env.DB.batch.bind(env.DB);
  let done = false;
  vi.spyOn(env.DB, "batch").mockImplementation(async (statements) => {
    const sql = statements.map((s) => (s as unknown as { statement?: string }).statement ?? "");
    const hit = !done && sql.some((text) => pattern.test(text));
    if (hit && when === "before") {
      done = true;
      await change();
    }
    const results = await batch(statements);
    if (hit && when === "after") {
      done = true;
      await change();
    }
    return results;
  });
  return () => done;
}

/** The conflict notice at the top of the panel, as markup up to its end. */
function conflictNotice(html: string): string {
  const at = html.indexOf('id="panel-conflict"');
  if (at < 0) return "";
  const start = html.lastIndexOf("<div", at);
  return decode(html.slice(start, html.indexOf("</div></div>", at)));
}

/** Everything a save could change for a user: rules, accounts, calendars, settings, audit rows. */
async function snapshot(userId: string) {
  const read = async (sql: string) => (await env.DB.prepare(sql).bind(userId).all()).results;
  return {
    rules: await read(
      "SELECT id, options, enabled, origin FROM rules WHERE user_id = ? ORDER BY id",
    ),
    accounts: await read(
      "SELECT id, display_name, color, work_hours, source_options FROM accounts WHERE user_id = ? ORDER BY id",
    ),
    calendars: await read(
      "SELECT c.id, c.is_source FROM calendars c JOIN accounts a ON a.id = c.account_id WHERE a.user_id = ? ORDER BY c.id",
    ),
    settings: await read("SELECT sync_settings FROM users WHERE id = ?"),
    audits: await read("SELECT COUNT(*) AS n FROM audit_events WHERE user_id = ?"),
  };
}

async function levelOf(user: User, from: string, to: string) {
  const direction = (await loadEditorState(env, user.id)).directions.find(
    (entry) => entry.from === from && entry.to === to,
  );
  return { choice: direction?.choice, options: direction?.options };
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

describe("a mirroring panel in two tabs", () => {
  it("saves with the current version, refuses the stale one, accepts none", async () => {
    const { user, cookie, w, o } = await setup("cfmx");
    await setDirection(env, user, w, o, "busy");
    const path = `/mirroring?d=${w}~${o}`;
    // Two tabs draw the same panel.
    const tabA = formFields(await page(path, cookie));
    const tabB = formFields(await page(path, cookie));
    const drawn = field(tabA, "v");
    expect(drawn).toMatch(/^[0-9a-z]+$/);
    expect(field(tabB, "v")).toBe(drawn);

    // Tab A saves "Title": accepted.
    const saved = await post("/mirroring", withField(tabA, "copy", "title"), cookie);
    expect(saved.status).toBe(303);
    expect((await levelOf(user, w, o)).choice).toBe("title");

    // Tab B, drawn before, saves "Everything": refused, nothing stored.
    const before = await snapshot(user.id);
    const stale = await post("/mirroring", withField(tabB, "copy", "full"), cookie);
    expect(stale.status).toBe(409);
    expect(await snapshot(user.id)).toEqual(before);
    const html = await stale.text();
    expect(conflictNotice(html)).toContain(en.next.mirroring.conflict);
    expect(html).toContain("data-conflict");
    // The panel shows what is stored, with the version of what is stored, and is not refused.
    const shown = formFields(html);
    expect(field(shown, "copy")).toBe("title");
    const state = await loadEditorState(env, user.id);
    const direction = state.directions.find((d) => d.from === w && d.to === o);
    expect(direction).toBeDefined();
    expect(field(shown, "v")).toBe(directionVersion(state, direction!));
    expect(field(shown, "v")).not.toBe(drawn);
    expect(html).not.toContain("data-refused");
    expect(html).not.toContain('class="notice notice-danger"');

    // The panel the conflict drew saves.
    expect((await post("/mirroring", withField(shown, "copy", "full"), cookie)).status).toBe(303);
    expect((await levelOf(user, w, o)).choice).toBe("full");

    // A form without a version (an old page, a test) saves as before.
    const legacy = without(withField(tabB, "copy", "busy"), "v");
    expect((await post("/mirroring", legacy, cookie)).status).toBe(303);
    expect((await levelOf(user, w, o)).choice).toBe("busy");
  });

  it("refuses a stale tab after a change from another page or an empty version", async () => {
    const { user, cookie, w, o } = await setup("cfmxother");
    await setDirection(env, user, w, o, "busy");
    const tab = formFields(await page(`/mirroring?d=${w}~${o}`, cookie));
    // The old pages and the API change the rule through the editor, not through this form.
    await setDirections(env, user, [{ from: w, to: o, choice: "title", markPrivate: true }]);
    const before = await snapshot(user.id);
    for (const v of [field(tab, "v") ?? "", "", "0"]) {
      const response = await post("/mirroring", withField(tab, "v", v), cookie);
      expect(response.status, JSON.stringify(v)).toBe(409);
    }
    expect(await snapshot(user.id)).toEqual(before);
  });

  it("does not refuse a tab of another mirroring", async () => {
    const { user, cookie, w, o, g } = await setup("cfmxpeer");
    await setDirection(env, user, w, o, "busy");
    await setDirection(env, user, w, g, "busy");
    const other = formFields(await page(`/mirroring?d=${w}~${g}`, cookie));
    const mine = formFields(await page(`/mirroring?d=${w}~${o}`, cookie));
    expect((await post("/mirroring", withField(mine, "copy", "title"), cookie)).status).toBe(303);
    expect((await post("/mirroring", withField(other, "copy", "title"), cookie)).status).toBe(303);
  });

  it("checks the version before the fields, so a stale refusal never shows unstored input", async () => {
    const { user, cookie, w, o } = await setup("cfmxorder");
    await setDirection(env, user, w, o, "busy");
    const tab = formFields(await page(`/mirroring?d=${w}~${o}`, cookie));
    await setDirections(env, user, [{ from: w, to: o, choice: "title", markPrivate: true }]);
    // An invalid category and a stale version: the conflict wins, with the stored values.
    const response = await post("/mirroring", withField(tab, "blockColor", "a,b"), cookie);
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain('value="a,b"');
  });

  it("keeps the drawn version after a refusal at a field", async () => {
    const { user, cookie, w, o } = await setup("cfmxkeep");
    await setDirection(env, user, w, o, "busy");
    const tab = formFields(await page(`/mirroring?d=${w}~${o}`, cookie));
    const refused = await post("/mirroring", withField(tab, "blockColor", "a,b"), cookie);
    expect(refused.status).toBe(400);
    const again = formFields(await refused.text());
    expect(field(again, "v")).toBe(field(tab, "v"));
    // Another tab changes the mirroring before the person fixes the field: the fix is refused.
    await setDirections(env, user, [{ from: w, to: o, choice: "title", markPrivate: true }]);
    const fixed = await post("/mirroring", withField(again, "blockColor", "ab"), cookie);
    expect(fixed.status).toBe(409);
  });

  it("answers a conflict of the rules during the save like a stale version", async () => {
    const { user, cookie, w, o } = await setup("cfmxcas");
    await setDirection(env, user, w, o, "busy");
    const tab = formFields(await page(`/mirroring?d=${w}~${o}`, cookie));
    // Between the check of `v` and the write: right after the save read the state it checked.
    const ran = hook(FIRST_READ, () =>
      env.DB.prepare(
        "UPDATE rules SET options = json_set(options, '$.blockColor', 'Other') WHERE user_id = ?",
      )
        .bind(user.id)
        .run(),
    );
    const response = await post("/mirroring", withField(tab, "copy", "title"), cookie);
    expect(ran()).toBe(true);
    expect(response.status).toBe(409);
    const html = await response.text();
    expect(conflictNotice(html)).toContain(en.next.mirroring.conflict);
    expect(field(formFields(html), "blockColor")).toBe("Other");
    expect((await levelOf(user, w, o)).choice).toBe("busy");
  });

  it("speaks German", async () => {
    const { user, cookie, w, o } = await setup("cfmxde");
    await setDirection(env, user, w, o, "busy");
    const tab = formFields(await page(`/mirroring?d=${w}~${o}`, cookie, "de"));
    await setDirections(env, user, [{ from: w, to: o, choice: "title", markPrivate: true }]);
    const response = await post("/mirroring", tab, cookie, "de");
    expect(response.status).toBe(409);
    expect(conflictNotice(await response.text())).toContain(de.next.mirroring.conflict);
  });
});

describe("the panel for all mirrorings in two tabs", () => {
  it("saves with the current version, refuses the stale one, accepts none", async () => {
    const { user, cookie, w, o } = await setup("cfall");
    await setDirection(env, user, w, o, "busy");
    const tabA = formFields(await page("/mirroring?d=all", cookie));
    const tabB = formFields(await page("/mirroring?d=all", cookie));
    expect(field(tabA, "v")).toBeTruthy();

    expect((await post("/mirroring", withField(tabA, "blockTitle", "Taken"), cookie)).status).toBe(
      303,
    );
    const before = await snapshot(user.id);
    const stale = await post("/mirroring", withField(tabB, "blockTitle", "Mine"), cookie);
    expect(stale.status).toBe(409);
    expect(await snapshot(user.id)).toEqual(before);
    const html = await stale.text();
    expect(conflictNotice(html)).toContain(en.next.mirroring.all.conflict);
    const shown = formFields(html);
    expect(field(shown, "blockTitle")).toBe("Taken");
    expect(field(shown, "v")).toBe(settingsVersion(await loadEditorState(env, user.id)));

    expect((await post("/mirroring", without(tabB, "v"), cookie)).status).toBe(303);
  });

  it("refuses a stale tab after a mirroring changed its mark", async () => {
    const { user, cookie, w, o } = await setup("cfallmark");
    await setDirections(env, user, [{ from: w, to: o, choice: "busy", markPrivate: true }]);
    const tab = formFields(await page("/mirroring?d=all", cookie));
    // The bulk "also apply" writes every mark: a mark changed meanwhile makes the form stale.
    await setDirections(env, user, [{ from: w, to: o, choice: "busy", markPrivate: false }]);
    const response = await post("/mirroring", [...tab, ["applyWho", "1"]], cookie);
    expect(response.status).toBe(409);
    expect((await levelOf(user, w, o)).options?.markPrivate).toBe(false);
  });
});

describe("a calendar panel in two tabs", () => {
  it("saves with the current version, refuses the stale one, accepts none", async () => {
    const { user, cookie, w } = await setup("cfcal");
    const path = `/calendars?c=${w}`;
    const tabA = formFields(await page(path, cookie));
    const tabB = formFields(await page(path, cookie));
    expect(field(tabA, "v")).toBeTruthy();

    expect((await post(`/calendars/${w}`, withField(tabA, "name", "Office"), cookie)).status).toBe(
      303,
    );
    const before = await snapshot(user.id);
    const stale = await post(`/calendars/${w}`, withField(tabB, "name", "Home"), cookie);
    expect(stale.status).toBe(409);
    expect(await snapshot(user.id)).toEqual(before);
    const html = await stale.text();
    expect(conflictNotice(html)).toContain(en.next.calendars.conflictStale);
    const shown = formFields(html);
    expect(field(shown, "name")).toBe("Office");
    expect(field(shown, "v")).toBe(accountVersion(await loadEditorState(env, user.id), w));
    expect(html).not.toContain("data-refused");

    expect(
      (await post(`/calendars/${w}`, without(withField(tabB, "name", "Home"), "v"), cookie)).status,
    ).toBe(303);
    const state = await loadEditorState(env, user.id);
    expect(state.accounts.find((account) => account.id === w)?.name).toBe("Home");
  });

  it("refuses a stale tab after a mirroring from the calendar changed its buffer", async () => {
    const { user, cookie, w, o } = await setup("cfcalbuffer");
    await setDirection(env, user, w, o, "busy");
    const tab = formFields(await page(`/calendars?c=${w}`, cookie));
    await env.DB.prepare(
      "UPDATE rules SET options = json_set(options, '$.bufferBefore', 15) WHERE user_id = ?",
    )
      .bind(user.id)
      .run();
    const response = await post(`/calendars/${w}`, withField(tab, "name", "Office"), cookie);
    expect(response.status).toBe(409);
    const state = await loadEditorState(env, user.id);
    expect(state.accounts.find((account) => account.id === w)?.customName).toBeNull();
  });
});

describe("the versions cover what the panels say (review M1, m4)", () => {
  /** A state with w > o busy-private, read as a save reads it. */
  async function base(prefix: string) {
    const context = await setup(prefix);
    const { user, w, o } = context;
    await setDirections(env, user, [{ from: w, to: o, choice: "busy", markPrivate: true }]);
    const state = await loadEditorState(env, user.id);
    const direction = state.directions.find((d) => d.from === w && d.to === o);
    if (!direction) throw new Error("no direction");
    return { ...context, state, direction };
  }

  it("changes every version with the level of a rule, its mark, and the caps", async () => {
    const { state, direction, w } = await base("cfvlevel");
    const slot = direction.slots[0];
    if (!slot?.rule) throw new Error("no rule");
    const rule = slot.rule;
    const json = (patch: object) => JSON.stringify({ ...JSON.parse(rule.optionsJson), ...patch });
    const withRule = (optionsJson: string) => {
      const changed = { ...rule, optionsJson };
      const d = { ...direction, slots: [{ ...slot, rule: changed }] };
      return {
        ...state,
        directions: state.directions.map((entry) => (entry === direction ? d : entry)),
        rules: state.rules.map((entry) =>
          entry.rule.id === rule.id ? { ...entry, rule: changed } : entry,
        ),
      };
    };
    const capped = (effective: "off" | "busy" | "title" | "full", maxChoice = effective) => ({
      ...state,
      directions: state.directions.map((entry) =>
        entry === direction ? { ...entry, effective, maxChoice } : entry,
      ),
    });
    const versions = (s: typeof state) => {
      const d = s.directions.find(
        (entry) => entry.from === direction.from && entry.to === direction.to,
      );
      return [settingsVersion(s), accountVersion(s, w), d ? directionVersion(s, d) : ""];
    };
    const before = versions(state);
    // Indexes: settings, calendar, mirroring. The calendar panel does not print the cap, only
    // whether a mirroring runs, so a cap that leaves the level as it is does not change it.
    for (const [name, changed, indexes] of [
      ["level", withRule(json({ detailLevel: "full" })), [0, 1, 2]],
      ["mark", withRule(json({ markPrivate: false })), [0, 1, 2]],
      ["cap", capped("busy", "busy"), [0, 2]],
      ["effective", capped("off", "full"), [0, 1, 2]],
    ] as const) {
      const after = versions(changed);
      for (const index of indexes) expect(after[index], `${name} ${index}`).not.toBe(before[index]);
    }
  });

  it("changes the panel versions with the names they print and the target's working hours", async () => {
    const { state, direction, o } = await base("cfvnames");
    const renamed = {
      ...state,
      accounts: state.accounts.map((a) => (a.id === o ? { ...a, name: "Elsewhere" } : a)),
    };
    expect(directionVersion(renamed, direction)).not.toBe(directionVersion(state, direction));
    expect(settingsVersion(renamed)).not.toBe(settingsVersion(state));
    const hours = {
      ...state,
      accounts: state.accounts.map((a) =>
        a.id === o
          ? {
              ...a,
              workHours: {
                workDays: [1],
                workStart: "08:00",
                workEnd: "18:00",
                workTimeZone: "UTC",
              },
            }
          : a,
      ),
    };
    expect(directionVersion(hours, direction)).not.toBe(directionVersion(state, direction));
    const titled = { ...state, settings: { ...state.settings, blockTitle: "Away" } };
    expect(directionVersion(titled, direction)).not.toBe(directionVersion(state, direction));
  });

  it("does not depend on the order in which the rules and calendars were read", async () => {
    const { user, w, o, g } = await setup("cfvorder");
    await env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, ?, 'Second', 1, 0, 1)",
    )
      .bind(`${w}-second`, w, `${w}-second-remote`)
      .run();
    await setDirections(env, user, [
      { from: w, to: o, choice: "busy", markPrivate: true },
      { from: w, to: g, choice: "title", markPrivate: true },
    ]);
    const state = await loadEditorState(env, user.id);
    const direction = state.directions.find((d) => d.from === w && d.to === o);
    if (!direction) throw new Error("no direction");
    expect(direction.slots.length).toBe(2);
    const reversed = {
      ...state,
      rules: state.rules.toReversed(),
      accounts: state.accounts.map((a) => ({ ...a, calendars: a.calendars.toReversed() })),
      directions: state.directions.map((d) => ({ ...d, slots: d.slots.toReversed() })),
    };
    const turned = reversed.directions.find((d) => d.from === w && d.to === o);
    expect(accountVersion(reversed, w)).toBe(accountVersion(state, w));
    expect(settingsVersion(reversed)).toBe(settingsVersion(state));
    expect(directionVersion(reversed, turned!)).toBe(directionVersion(state, direction));
  });
});

describe("a stale tab of all mirrorings after a level changed (review M1)", () => {
  it("refuses Same as you for all after another tab raised a mirroring to Everything", async () => {
    const { user, cookie, w, o } = await setup("cfm1");
    await setDirections(env, user, [{ from: w, to: o, choice: "busy", markPrivate: true }]);
    const html = await page("/mirroring?d=all", cookie);
    // The tab warned about the copies' title only.
    expect(decode(html)).toContain(en.next.mirroring.all.applyOpen.busy("other", "Busy"));
    const tab = formFields(html);
    await setDirections(env, user, [{ from: w, to: o, choice: "full", markPrivate: true }]);
    const before = await snapshot(user.id);
    const response = await post(
      "/mirroring",
      withField(withField(tab, "newWho", "open"), "applyWho", "1"),
      cookie,
    );
    expect(response.status).toBe(409);
    expect(await snapshot(user.id)).toEqual(before);
    expect((await levelOf(user, w, o)).options?.markPrivate).toBe(true);
  });
});

describe("a change made between the version check and the write (review m1)", () => {
  /** Runs `change` once, right after the first read of the editor state in the request. */
  function afterFirstRead(change: () => Promise<unknown>) {
    const batch = env.DB.batch.bind(env.DB);
    let done = false;
    vi.spyOn(env.DB, "batch").mockImplementation(async (statements) => {
      const results = await batch(statements);
      const sql = statements.map((s) => (s as unknown as { statement?: string }).statement ?? "");
      if (
        !done &&
        sql.some((t) => /FROM accounts WHERE user_id = \? ORDER BY created_at, id/.test(t))
      ) {
        done = true;
        await change();
      }
      return results;
    });
    return () => done;
  }

  it("refuses a mirroring save, and keeps the other tab's level", async () => {
    const { user, cookie, w, o } = await setup("cfm1mx");
    await setDirections(env, user, [{ from: w, to: o, choice: "busy", markPrivate: true }]);
    const tab = formFields(await page(`/mirroring?d=${w}~${o}`, cookie));
    const ran = afterFirstRead(() =>
      setDirections(env, user, [{ from: w, to: o, choice: "full", markPrivate: false }]),
    );
    const response = await post(
      "/mirroring",
      withField(withField(tab, "copy", "title"), "who", "private"),
      cookie,
    );
    expect(ran()).toBe(true);
    expect(response.status).toBe(409);
    const stored = await levelOf(user, w, o);
    expect(stored.choice).toBe("full");
    expect(stored.options?.markPrivate).toBe(false);
  });

  it("refuses a settings save, and keeps the other tab's settings", async () => {
    const { user, cookie, w, o } = await setup("cfm1all");
    await setDirections(env, user, [{ from: w, to: o, choice: "busy", markPrivate: true }]);
    const tab = formFields(await page("/mirroring?d=all", cookie));
    const ran = afterFirstRead(() =>
      env.DB.prepare(
        "UPDATE users SET sync_settings = json_set(sync_settings, '$.blockTitle', 'Other tab') WHERE id = ?",
      )
        .bind(user.id)
        .run(),
    );
    const response = await post("/mirroring", withField(tab, "blockTitle", "Mine"), cookie);
    expect(ran()).toBe(true);
    expect(response.status).toBe(409);
    const state = await loadEditorState(env, user.id);
    expect(state.settings.blockTitle).toBe("Other tab");
  });

  it("refuses a calendar rename, and keeps the other tab's name", async () => {
    const { user, cookie, w } = await setup("cfm1cal");
    const tab = formFields(await page(`/calendars?c=${w}`, cookie));
    const ran = afterFirstRead(() =>
      env.DB.prepare("UPDATE accounts SET display_name = 'Other tab' WHERE id = ?").bind(w).run(),
    );
    const response = await post(`/calendars/${w}`, withField(tab, "name", "Mine"), cookie);
    expect(ran()).toBe(true);
    expect(response.status).toBe(409);
    const state = await loadEditorState(env, user.id);
    expect(state.accounts.find((a) => a.id === w)?.name).toBe("Other tab");
  });

  it("refuses a calendar colour, and keeps the other tab's colour", async () => {
    const { cookie, w } = await setup("cfm1col");
    const tab = formFields(await page(`/calendars?c=${w}`, cookie));
    const ran = afterFirstRead(() =>
      env.DB.prepare("UPDATE accounts SET color = 'purple' WHERE id = ?").bind(w).run(),
    );
    const response = await post(`/calendars/${w}`, withField(tab, "color", "indigo"), cookie);
    expect(ran()).toBe(true);
    expect(response.status).toBe(409);
    const row = await env.DB.prepare("SELECT color FROM accounts WHERE id = ?")
      .bind(w)
      .first<{ color: string }>();
    expect(row?.color).toBe("purple");
  });
});

describe("a calendar save that met another tab mid-way (review m2)", () => {
  it("shows what is stored with the stored version, never the input with a fresh one", async () => {
    const { user, cookie, w } = await setup("cfm2");
    const tab = formFields(await page(`/calendars?c=${w}`, cookie));
    const batch = env.DB.batch.bind(env.DB);
    let reads = 0;
    vi.spyOn(env.DB, "batch").mockImplementation(async (statements) => {
      const results = await batch(statements);
      const sql = statements.map((s) => (s as unknown as { statement?: string }).statement ?? "");
      if (sql.some((t) => /FROM accounts WHERE user_id = \? ORDER BY created_at, id/.test(t))) {
        reads++;
        if (reads === 1) {
          await env.DB.prepare("UPDATE accounts SET display_name = 'Other tab' WHERE id = ?")
            .bind(w)
            .run();
        }
      }
      return results;
    });
    const response = await post(`/calendars/${w}`, withField(tab, "name", "Mine"), cookie);
    expect(response.status).toBe(409);
    const html = await response.text();
    expect(conflictNotice(html)).toContain(en.next.calendars.conflict);
    const shown = formFields(html);
    expect(field(shown, "name")).toBe("Other tab");
    vi.restoreAllMocks();
    expect(field(shown, "v")).toBe(accountVersion(await loadEditorState(env, user.id), w));
    expect(html).not.toContain("data-refused");
  });
});

describe("the window between the version check and the write, round 2", () => {
  const OFFICE: [string, string][] = [
    ["workHoursShown", "1"],
    ["workHoursOn", "1"],
    ["workStart", "08:00"],
    ["workEnd", "18:00"],
    ["workTimeZone", "Europe/Vienna"],
  ];
  function withHours(fields: [string, string][]): [string, string][] {
    const names = new Set([...OFFICE.map(([name]) => name), "workDays"]);
    return [
      ...fields.filter(([name]) => !names.has(name)),
      ...OFFICE,
      ["workDays", "1"],
      ["workDays", "2"],
      ["workDays", "3"],
    ];
  }

  it("refuses a settings save when the settings row changed before the batch", async () => {
    const { user, cookie, w, o } = await setup("cfr2row");
    await setDirections(env, user, [{ from: w, to: o, choice: "busy", markPrivate: true }]);
    const tab = formFields(await page("/mirroring?d=all", cookie));
    // After the settings save read the row and compared it, before its batch writes.
    const ran = hook(
      /UPDATE users SET sync_settings = \? WHERE id = \? AND sync_settings IS \?/,
      () =>
        env.DB.prepare(
          "UPDATE users SET sync_settings = json_set(sync_settings, '$.blockTitle', 'Other tab') WHERE id = ?",
        )
          .bind(user.id)
          .run(),
      "before",
    );
    const response = await post("/mirroring", withField(tab, "blockTitle", "Mine"), cookie);
    expect(ran()).toBe(true);
    expect(response.status).toBe(409);
    expect((await loadEditorState(env, user.id)).settings.blockTitle).toBe("Other tab");
  });

  it("refuses a settings save when a rule's mark changed after the check", async () => {
    const { user, cookie, w, o } = await setup("cfr2rules");
    await setDirections(env, user, [{ from: w, to: o, choice: "title", markPrivate: false }]);
    const tab = formFields(await page("/mirroring?d=all", cookie));
    const ran = hook(FIRST_READ, () =>
      env.DB.prepare(
        "UPDATE rules SET options = json_set(options, '$.markPrivate', json('true')) WHERE user_id = ?",
      )
        .bind(user.id)
        .run(),
    );
    const response = await post(
      "/mirroring",
      withField(withField(tab, "newWho", "open"), "applyWho", "1"),
      cookie,
    );
    expect(ran()).toBe(true);
    expect(response.status).toBe(409);
    expect((await levelOf(user, w, o)).options?.markPrivate).toBe(true);
  });

  it("refuses a mirroring save when another tab turned the rule off with the same options", async () => {
    const { user, cookie, w, o } = await setup("cfr2enabled");
    await setDirections(env, user, [{ from: w, to: o, choice: "busy", markPrivate: true }]);
    const tab = formFields(await page(`/mirroring?d=${w}~${o}`, cookie));
    const ran = hook(FIRST_READ, () =>
      env.DB.prepare("UPDATE rules SET enabled = 0 WHERE user_id = ?").bind(user.id).run(),
    );
    const response = await post("/mirroring", withField(tab, "copy", "title"), cookie);
    expect(ran()).toBe(true);
    expect(response.status).toBe(409);
    const row = await env.DB.prepare("SELECT enabled, options FROM rules WHERE user_id = ?")
      .bind(user.id)
      .first<{ enabled: number; options: string }>();
    expect(row?.enabled).toBe(0);
    expect(JSON.parse(row?.options ?? "{}").detailLevel).toBe("busy");
  });

  it("refuses Not copied when another tab changed the rule, and keeps it", async () => {
    const { user, cookie, w, o } = await setup("cfr2off");
    await setDirections(env, user, [{ from: w, to: o, choice: "busy", markPrivate: true }]);
    const tab = formFields(await page(`/mirroring?d=${w}~${o}`, cookie));
    const ran = hook(FIRST_READ, () =>
      setDirections(env, user, [{ from: w, to: o, choice: "full", markPrivate: true }]),
    );
    const response = await post("/mirroring", withField(tab, "copy", "off"), cookie);
    expect(ran()).toBe(true);
    expect(response.status).toBe(409);
    expect((await levelOf(user, w, o)).choice).toBe("full");
  });

  it("refuses to replace a rule that another tab created, and keeps it", async () => {
    const { user, cookie, w, o } = await setup("cfr2new");
    const tab = formFields(await page(`/mirroring?d=${w}~${o}`, cookie));
    const ran = hook(FIRST_READ, () =>
      setDirections(env, user, [{ from: w, to: o, choice: "title", markPrivate: true }]),
    );
    const response = await post(
      "/mirroring",
      withField(withField(tab, "copy", "full"), "who", "open"),
      cookie,
    );
    expect(ran()).toBe(true);
    expect(response.status).toBe(409);
    const stored = await levelOf(user, w, o);
    expect(stored.choice).toBe("title");
    expect(stored.options?.markPrivate).toBe(true);
  });

  it("refuses working hours that another tab set after the check", async () => {
    const { user, cookie, w } = await setup("cfr2hours");
    const tab = formFields(await page(`/calendars?c=${w}`, cookie));
    const theirs = { workDays: [6], workStart: "10:00", workEnd: "12:00", workTimeZone: "UTC" };
    const ran = hook(FIRST_READ, () =>
      env.DB.prepare("UPDATE accounts SET work_hours = ? WHERE id = ?")
        .bind(JSON.stringify(theirs), w)
        .run(),
    );
    const response = await post(`/calendars/${w}`, withHours(tab), cookie);
    expect(ran()).toBe(true);
    expect(response.status).toBe(409);
    const state = await loadEditorState(env, user.id);
    expect(state.accounts.find((a) => a.id === w)?.workHours?.workStart).toBe("10:00");
  });

  it("refuses a source calendar that another tab switched after the check", async () => {
    const { cookie, w } = await setup("cfr2source");
    const side = `${w}-side`;
    await env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, ?, 'Side', 1, 0, 0)",
    )
      .bind(side, w, `${side}-remote`)
      .run();
    const tab = formFields(await page(`/calendars?c=${w}`, cookie));
    expect(tab).toContainEqual(["sourceShown", side]);
    const ran = hook(FIRST_READ, () =>
      env.DB.prepare("UPDATE calendars SET is_source = 1 WHERE id = ?").bind(side).run(),
    );
    const response = await post(`/calendars/${w}`, [...tab, ["source", side]], cookie);
    expect(ran()).toBe(true);
    expect(response.status).toBe(409);
  });

  it("refuses the buffer after stored hours, and shows what is stored (m2 path)", async () => {
    const { user, cookie, w, o } = await setup("cfr2buffer");
    await setDirections(env, user, [{ from: w, to: o, choice: "busy", markPrivate: true }]);
    const tab = formFields(await page(`/calendars?c=${w}`, cookie));
    const fields: [string, string][] = [
      ...withHours(tab).filter(([name]) => !["bufferBefore", "bufferAfter"].includes(name)),
      ["bufferShown", "1"],
      ["bufferBefore", "10"],
      ["bufferAfter", "10"],
    ];
    // After the hours step stored its batch, another tab changes the buffers.
    const ran = hook(/UPDATE accounts SET work_hours/, () =>
      env.DB.prepare(
        "UPDATE rules SET options = json_set(options, '$.bufferBefore', 30, '$.bufferAfter', 30) WHERE user_id = ?",
      )
        .bind(user.id)
        .run(),
    );
    const response = await post(`/calendars/${w}`, fields, cookie);
    expect(ran()).toBe(true);
    expect(response.status).toBe(409);
    const html = await response.text();
    vi.restoreAllMocks();
    const state = await loadEditorState(env, user.id);
    // The hours of this save are stored, the other tab's buffer stays.
    expect(state.accounts.find((a) => a.id === w)?.workHours?.workStart).toBe("08:00");
    expect(state.rules[0]?.rule.options.bufferBefore).toBe(30);
    // The panel shows that, with the version of it, and no refused input.
    expect(conflictNotice(html)).toContain(en.next.calendars.conflict);
    const shown = formFields(html);
    expect(field(shown, "workStart")).toBe("08:00");
    expect(field(shown, "bufferBefore")).toBe("30");
    expect(field(shown, "v")).toBe(accountVersion(state, w));
    expect(html).not.toContain("data-refused");
  });
});
