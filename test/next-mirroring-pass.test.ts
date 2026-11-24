/**
 * The carried categories in the mirroring panel: one control per provider pair, a save from the
 * panel form, refusals at their field, and the same refusals as the batch path.
 */
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDirection, setDirections, setRuleDetails } from "../src/editor";
import { en } from "../src/i18n/en";
import { directionChanges } from "../src/pages/next/mirroring";
import { BASE, signIn } from "./helpers";

type Pair = { from: string; to: string };

/** A user with two Microsoft and two Google accounts, each with one main calendar. */
async function setup(prefix: string) {
  const { user, cookie } = await signIn(`${prefix}@org.example`);
  const accounts = [
    [`${prefix}-w`, `${prefix}@work.example`, "microsoft"],
    [`${prefix}-o`, `${prefix}@other.example`, "microsoft"],
    [`${prefix}-g`, `${prefix}@gmail.com`, "google"],
    [`${prefix}-h`, `${prefix}.two@gmail.com`, "google"],
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
  const [w, o, g, h] = accounts.map(([id]) => id);
  return { user, cookie, w: w!, o: o!, g: g!, h: h! };
}

async function passOf(source: string, target: string): Promise<Pair[] | undefined> {
  const row = await env.DB.prepare(
    `SELECT r.options FROM rules r
     JOIN calendars sc ON sc.id = r.source_calendar_id
     JOIN calendars tc ON tc.id = r.target_calendar_id
     WHERE sc.account_id = ? AND tc.account_id = ?`,
  )
    .bind(source, target)
    .first<{ options: string }>();
  return row ? (JSON.parse(row.options) as { passCategories?: Pair[] }).passCategories : undefined;
}

function decode(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

async function panel(cookie: string, from: string, to: string): Promise<string> {
  const response = await exports.default.fetch(`${BASE}/mirroring?d=${from}~${to}`, {
    headers: { cookie, "accept-language": "en" },
    redirect: "manual",
  });
  return decode(await response.text());
}

/** The property row of the carried categories, from its label up to its end. */
function passRow(html: string): string {
  const at = html.indexOf('name="passCategoriesShown"');
  expect(at, "the carried categories").toBeGreaterThan(0);
  const open = Math.max(
    html.lastIndexOf('<div class="prop"', at),
    html.lastIndexOf('<div class="prop is-stacked"', at),
  );
  const end = html.indexOf('<p class="prop-hint"', at);
  return html.slice(open, html.indexOf("</p>", end) + 4);
}

/** The panel form of one mirroring, copied as busy only and private, plus `fields`. */
function panelForm(from: string, to: string, fields: [string, string][] = []): URLSearchParams {
  const body = new URLSearchParams({
    scope: "direction",
    from,
    to,
    back: `/mirroring?d=${from}~${to}&saved=1`,
    copy: "busy",
    who: "private",
  });
  for (const [name, value] of fields) body.append(name, value);
  return body;
}

function save(cookie: string, body: URLSearchParams) {
  return exports.default.fetch(`${BASE}/mirroring`, {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie,
      "content-type": "application/x-www-form-urlencoded",
      "accept-language": "en",
    },
    body,
  });
}

function saveBatch(cookie: string, name: string, pairs: string[][]) {
  return exports.default.fetch(`${BASE}/rules/choices`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "x-fragment": "1", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ [name]: JSON.stringify(pairs) }),
  });
}

/** Rows of the panel between providers: the hidden mark, then "passFrom" and "passTo" per row. */
function rows(pairs: [string, string][]): [string, string][] {
  return [
    ["passCategoriesShown", "1"],
    ...pairs.flatMap(([from, to]): [string, string][] => [
      ["passFrom", from],
      ["passTo", to],
    ]),
  ];
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

describe("carried categories in the mirroring panel", () => {
  it("shows a list of names between two Outlook calendars", async () => {
    const { user, cookie, w, o } = await setup("mpout");
    await setDirection(env, user, w, o, "busy");
    await setRuleDetails(env, user, {
      passCategories: [{ from: w, to: o, pairs: [{ from: "Focus", to: "" }] }],
    });
    const row = passRow(await panel(cookie, w, o));
    expect(row).toContain(en.next.mirroring.pass.categories);
    expect(row).toMatch(/<input class="input" id="mx-pass" type="text" name="passCategories"/);
    expect(row).toContain('value="Focus"');
    expect(row).toContain(en.next.mirroring.pass.categoriesHint);
    expect(row).not.toContain('name="passFrom"');
  });

  it("shows colour boxes between two Google calendars", async () => {
    const { user, cookie, g, h } = await setup("mpgoo");
    await setDirection(env, user, g, h, "busy");
    await setRuleDetails(env, user, {
      passCategories: [{ from: g, to: h, pairs: [{ from: "color:5", to: "" }] }],
    });
    const row = passRow(await panel(cookie, g, h));
    expect(row).toContain(en.next.mirroring.pass.colors);
    expect(row).toMatch(/<input type="checkbox" name="passColor" value="color:5" checked/);
    expect(row).not.toMatch(/name="passColor" value="color:4" checked/);
    expect(row).toContain('data-change-group="passColor"');
  });

  it("shows the saved rows and one empty row from Outlook to Google", async () => {
    const { user, cookie, w, g } = await setup("mprows");
    await setDirection(env, user, w, g, "busy");
    await setRuleDetails(env, user, {
      passCategories: [{ from: w, to: g, pairs: [{ from: "Focus", to: "3" }] }],
    });
    const row = passRow(await panel(cookie, w, g));
    expect(row.match(/class="mx-pass-row"/g)).toHaveLength(2);
    // A row is the name of the source, then the colour of the target.
    const first = row.slice(row.indexOf('class="mx-pass-row"'), row.indexOf("</select>") + 9);
    expect(first.indexOf('name="passFrom"')).toBeLessThan(first.indexOf('name="passTo"'));
    expect(first).toMatch(/<input class="input" type="text" name="passFrom"[^>]*value="Focus"/);
    expect(first).toMatch(/<option value="3" selected/);
    expect(first).toMatch(/<select name="passTo" aria-label="Colour in [^"]+"/);
    // The script adds rows: the button needs it.
    expect(row).toMatch(/<button type="button" class="btn btn-secondary" data-needs-script/);
  });

  it("shows the colour first from Google to Outlook", async () => {
    const { user, cookie, w, g } = await setup("mprowsg");
    await setDirection(env, user, g, w, "busy");
    await setRuleDetails(env, user, {
      passCategories: [{ from: g, to: w, pairs: [{ from: "color:5", to: "Focus" }] }],
    });
    const row = passRow(await panel(cookie, g, w));
    expect(row).toContain(en.next.mirroring.pass.colors);
    expect(row).toContain(en.next.mirroring.pass.rowsHintColors);
    const first = row.slice(row.indexOf('class="mx-pass-row"'));
    expect(first.indexOf('name="passFrom"')).toBeLessThan(first.indexOf('name="passTo"'));
    expect(first).toMatch(/<select name="passFrom"/);
    expect(first).toMatch(/<option value="color:5" selected/);
    expect(first).toMatch(/<input class="input" type="text" name="passTo"[^>]*value="Focus"/);
  });

  it("stores the rows with the level from one panel form, trimmed, without the empty row", async () => {
    const { cookie, w, g } = await setup("mpsave");
    const response = await save(
      cookie,
      panelForm(
        w,
        g,
        rows([
          [" Focus ", "3"],
          ["Reise; privat", "6"],
          ["focus", "3"],
          ["", ""],
        ]),
      ),
    );
    expect(response.status).toBe(303);
    expect(await passOf(w, g)).toEqual([
      { from: "Focus", to: "3" },
      { from: "Reise; privat", to: "6" },
    ]);
  });

  it("stores rows from Google to Outlook and clears a row whose name is cleared", async () => {
    const { user, cookie, w, g } = await setup("mpsaveg");
    await setDirection(env, user, g, w, "busy");
    expect(
      (
        await save(
          cookie,
          panelForm(
            g,
            w,
            rows([
              ["color:5", "Focus"],
              ["", ""],
            ]),
          ),
        )
      ).status,
    ).toBe(303);
    expect(await passOf(g, w)).toEqual([{ from: "color:5", to: "Focus" }]);
    expect((await save(cookie, panelForm(g, w, rows([["color:5", ""]])))).status).toBe(303);
    expect(await passOf(g, w)).toEqual([]);
  });

  it("refuses a name without a colour at its field, keeps the rows and saves nothing", async () => {
    const { user, cookie, w, g } = await setup("mpfield");
    await setDirection(env, user, w, g, "busy");
    const response = await save(cookie, panelForm(w, g, rows([["Focus", ""]])));
    expect(response.status).toBe(400);
    const html = decode(await response.text());
    expect(html).toContain(
      `<p class="prop-error" id="mx-pass-error">${en.next.mirroring.fieldErrors.passIncomplete}</p>`,
    );
    expect(html).toContain(`${en.next.shell.panel.notSaved}</div>`);
    expect(html).toMatch(/name="passFrom"[^>]*aria-invalid="true"[^>]*value="Focus"/);
    // Only the row that does not fit is marked, not the empty row after it.
    expect(passRow(html).match(/<(input|select)[^>]*aria-invalid="true"/g)).toHaveLength(2);
    // The refused row and one empty row.
    expect(passRow(html).match(/class="mx-pass-row"/g)).toHaveLength(2);
    expect(html).toContain('data-refused-fields="passFrom"');
    expect(await passOf(w, g)).toEqual([]);
  });

  it("refuses what the batch path refuses, at the field", async () => {
    const { user, cookie, w, o, g } = await setup("mpparity");
    await setDirection(env, user, w, o, "busy");
    await setDirection(env, user, w, g, "busy");
    await setDirection(env, user, g, w, "busy");
    const many = Array.from({ length: 51 }, (_, index) => `Name ${index}`);
    const cases: {
      from: string;
      to: string;
      pairs: [string, string][];
      form: [string, string][];
      error: string;
    }[] = [
      {
        from: w,
        to: o,
        pairs: [["x".repeat(101), ""]],
        form: [
          ["passCategoriesShown", "1"],
          ["passCategories", "x".repeat(101)],
        ],
        error: en.next.mirroring.fieldErrors.passName(100),
      },
      {
        from: w,
        to: o,
        pairs: many.map((name) => [name, ""]),
        form: [
          ["passCategoriesShown", "1"],
          ["passCategories", many.join(", ")],
        ],
        error: en.next.mirroring.fieldErrors.passTooMany(50),
      },
      {
        from: w,
        to: g,
        pairs: [["a;b", "12"]],
        form: rows([["a;b", "12"]]),
        error: en.next.mirroring.fieldErrors.colorInvalid,
      },
      {
        from: g,
        to: w,
        pairs: [["", "Deep"]],
        form: rows([["", "Deep"]]),
        error: en.next.mirroring.fieldErrors.passIncomplete,
      },
      {
        from: g,
        to: w,
        pairs: [["color:5", "a,b"]],
        form: rows([["color:5", "a,b"]]),
        error: en.next.mirroring.fieldErrors.passName(100),
      },
    ];
    for (const { from, to, pairs, form, error } of cases) {
      const label = `${from}>${to} ${JSON.stringify(pairs).slice(0, 40)}`;
      expect((await saveBatch(cookie, `passCategories.${from}.${to}`, pairs)).status, label).toBe(
        400,
      );
      const response = await save(cookie, panelForm(from, to, form));
      expect(response.status, label).toBe(400);
      expect(decode(await response.text()), label).toContain(
        `<p class="prop-error" id="mx-pass-error">${error}</p>`,
      );
      expect(await passOf(from, to), label).toEqual([]);
    }
  });

  it("writes nothing for a form that shows the stored list", async () => {
    const { user, cookie, w, g } = await setup("mpquiet");
    await setDirection(env, user, w, g, "busy");
    await setRuleDetails(env, user, {
      passCategories: [{ from: w, to: g, pairs: [{ from: "Focus", to: "3" }] }],
    });
    const snapshot = () =>
      env.DB.prepare(
        "SELECT (SELECT options FROM rules WHERE user_id = ?) AS options, (SELECT COUNT(*) FROM audit_events WHERE user_id = ?) AS audits",
      )
        .bind(user.id, user.id)
        .first();
    const before = await snapshot();
    const response = await save(
      cookie,
      panelForm(w, g, [
        ["blockColor", ""],
        ...rows([
          ["Focus", "3"],
          ["", ""],
        ]),
      ]),
    );
    expect(response.status).toBe(303);
    expect(await snapshot()).toEqual(before);
  });

  it("takes the colour boxes in any order between Google calendars", async () => {
    const { user, cookie, g, h } = await setup("mporder");
    await setDirection(env, user, g, h, "busy");
    await setRuleDetails(env, user, {
      passCategories: [
        {
          from: g,
          to: h,
          pairs: [
            { from: "color:5", to: "" },
            { from: "color:1", to: "" },
          ],
        },
      ],
    });
    const before = await passOf(g, h);
    const response = await save(
      cookie,
      panelForm(g, h, [
        ["passCategoriesShown", "1"],
        ["passColor", "color:1"],
        ["passColor", "color:5"],
      ]),
    );
    expect(response.status).toBe(303);
    expect(await passOf(g, h)).toEqual(before);
  });

  it("keeps the list for a form without it, and keeps a stored target of a name", async () => {
    const { user, cookie, w, o } = await setup("mpkeep");
    await setDirections(env, user, [{ from: w, to: o, choice: "busy", markPrivate: true }]);
    // The batch path can give a name between Outlook calendars a target of its own.
    expect((await saveBatch(cookie, `passCategories.${w}.${o}`, [["Focus", "Work"]])).status).toBe(
      204,
    );
    await save(cookie, panelForm(w, o, [["blockColor", "Blue"]]));
    expect(await passOf(w, o)).toEqual([{ from: "Focus", to: "Work" }]);
    await save(
      cookie,
      panelForm(w, o, [
        ["passCategoriesShown", "1"],
        ["passCategories", "Focus, Deep"],
      ]),
    );
    expect(await passOf(w, o)).toEqual([
      { from: "Focus", to: "Work" },
      { from: "Deep", to: "" },
    ]);
  });

  it("logs the count of the list, not the names", async () => {
    const { user, cookie, w, g } = await setup("mpaudit");
    await setDirection(env, user, w, g, "busy");
    await save(cookie, panelForm(w, g, rows([["Geheimkunde", "3"]])));
    const row = await env.DB.prepare(
      "SELECT detail FROM audit_events WHERE user_id = ? AND kind = 'rule_updated' ORDER BY id DESC",
    )
      .bind(user.id)
      .first<{ detail: string }>();
    expect(JSON.parse(row?.detail ?? "{}")).toMatchObject({ passCategories: "1" });
    expect(row?.detail).not.toContain("Geheimkunde");
  });
});

describe("directionChanges for the carried categories", () => {
  const stored = {
    copy: "busy",
    who: "private",
    workHours: false,
    hoursShown: false,
    onlyCategories: [],
    blockColor: "",
  };
  const form = (fields: [string, string][]) => {
    const data = new FormData();
    for (const [name, value] of [["copy", "busy"], ["who", "private"], ...fields]) {
      data.append(name!, value!);
    }
    return data;
  };

  it("counts each field of the rows once, as the save bar does", () => {
    const pairs = [{ from: "Focus", to: "3" }];
    const base = { ...stored, sourceIsGoogle: false, targetIsGoogle: true, passCategories: pairs };
    expect(
      directionChanges(
        form(
          rows([
            ["Focus", "3"],
            ["", ""],
          ]),
        ),
        base,
      ),
    ).toEqual({
      count: 0,
      fields: [],
    });
    expect(directionChanges(form(rows([["Focus", "5"]])), base).fields).toEqual(["passTo"]);
    expect(directionChanges(form(rows([["Deep", "5"]])), base)).toEqual({
      count: 2,
      fields: ["passFrom", "passTo"],
    });
  });

  it("counts the list of one provider as one change", () => {
    const outlook = {
      ...stored,
      sourceIsGoogle: false,
      targetIsGoogle: false,
      passCategories: [{ from: "Focus", to: "" }],
    };
    const shown: [string, string] = ["passCategoriesShown", "1"];
    expect(directionChanges(form([shown, ["passCategories", "Focus"]]), outlook).count).toBe(0);
    expect(
      directionChanges(form([shown, ["passCategories", "Focus, Deep"]]), outlook).fields,
    ).toEqual(["passCategories"]);
    const google = {
      ...outlook,
      sourceIsGoogle: true,
      targetIsGoogle: true,
      passCategories: [
        { from: "color:5", to: "" },
        { from: "color:6", to: "" },
      ],
    };
    expect(
      directionChanges(form([shown, ["passColor", "color:6"], ["passColor", "color:5"]]), google)
        .count,
    ).toBe(0);
    expect(directionChanges(form([shown, ["passColor", "color:5"]]), google).fields).toEqual([
      "passColor",
    ]);
  });
});
