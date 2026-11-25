/**
 * The carried categories in the mirroring panel: one control per provider pair, a save from the
 * panel form, refusals at their field, and the same refusals as the batch path.
 */
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  passCategoriesFor,
  setDirection,
  setDirections,
  setRuleDetails,
  setSourceCalendar,
} from "../src/editor";
import { en } from "../src/i18n/en";
import { directionChanges } from "../src/pages/next/mirroring";
import { BASE, signIn } from "./helpers";

type Pair = { from: string; to: string; tentative?: boolean };

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

function saveBatch(cookie: string, name: string, pairs: unknown[][]) {
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
      passCategories: [{ from: w, to: o, pairs: [{ from: "Focus", to: "", tentative: false }] }],
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
      passCategories: [{ from: g, to: h, pairs: [{ from: "color:5", to: "", tentative: false }] }],
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
      passCategories: [{ from: w, to: g, pairs: [{ from: "Focus", to: "3", tentative: false }] }],
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
      passCategories: [
        { from: g, to: w, pairs: [{ from: "color:5", to: "Focus", tentative: false }] },
      ],
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
      { from: "Focus", to: "3", tentative: false },
      { from: "Reise; privat", to: "6", tentative: false },
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
    expect(await passOf(g, w)).toEqual([{ from: "color:5", to: "Focus", tentative: false }]);
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
      passCategories: [{ from: w, to: g, pairs: [{ from: "Focus", to: "3", tentative: false }] }],
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
            { from: "color:5", to: "", tentative: false },
            { from: "color:1", to: "", tentative: false },
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
    expect(await passOf(w, o)).toEqual([{ from: "Focus", to: "Work", tentative: false }]);
    await save(
      cookie,
      panelForm(w, o, [
        ["passCategoriesShown", "1"],
        ["passCategories", "Focus, Deep"],
      ]),
    );
    expect(await passOf(w, o)).toEqual([
      { from: "Focus", to: "Work", tentative: false },
      { from: "Deep", to: "", tentative: false },
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

  describe("tentative copies", () => {
    /** Rows plus the indexes of the ticked "Tentative" boxes. */
    function ticked(pairs: [string, string][], indexes: number[]): [string, string][] {
      return [
        ...rows(pairs),
        ...indexes.map((index): [string, string] => ["passTentative", String(index)]),
      ];
    }

    it("shows one box per row from Google to Outlook, with the row index as value", async () => {
      const { user, cookie, w, g } = await setup("mptent");
      await setDirection(env, user, g, w, "busy");
      await setRuleDetails(env, user, {
        passCategories: [
          {
            from: g,
            to: w,
            pairs: [
              { from: "color:5", to: "Focus", tentative: false },
              { from: "color:6", to: "Deep", tentative: true },
            ],
          },
        ],
      });
      const row = passRow(await panel(cookie, g, w));
      const boxes = [...row.matchAll(/<input class="switch" type="checkbox"[^>]*>/g)].map(
        ([tag]) => tag,
      );
      expect(boxes).toHaveLength(3);
      for (const [index, tag] of boxes.entries()) {
        expect(tag).toContain('name="passTentative"');
        expect(tag).toContain(`value="${index}"`);
        expect(tag).toMatch(/aria-label="Tentative in [^"]+"/);
      }
      expect(boxes.map((tag) => / checked(=|[ />])/.test(tag))).toEqual([false, true, false]);
      // Each box sits in its row, after the name.
      const second = row.split('class="mx-pass-row"')[2] ?? "";
      expect(second.indexOf('name="passTo"')).toBeLessThan(second.indexOf('name="passTentative"'));
      expect(row).toContain(en.next.mirroring.pass.tentative);
      expect(row).toContain(en.next.mirroring.pass.tentativeHint);
    });

    it("shows no box in any other direction", async () => {
      const { user, cookie, w, o, g, h } = await setup("mptentno");
      for (const [from, to] of [
        [w, g],
        [w, o],
        [g, h],
      ] as const) {
        await setDirection(env, user, from, to, "busy");
        expect(passRow(await panel(cookie, from, to))).not.toContain("passTentative");
      }
    });

    it("stores the ticked rows from the panel form and clears an unticked one", async () => {
      const { user, cookie, w, g } = await setup("mptentsave");
      await setDirection(env, user, g, w, "busy");
      const pairs: [string, string][] = [
        ["color:5", "Focus"],
        ["color:6", "Deep"],
        ["", ""],
      ];
      expect((await save(cookie, panelForm(g, w, ticked(pairs, [0])))).status).toBe(303);
      expect(await passOf(g, w)).toEqual([
        { from: "color:5", to: "Focus", tentative: true },
        { from: "color:6", to: "Deep", tentative: false },
      ]);
      expect((await save(cookie, panelForm(g, w, ticked(pairs, [1])))).status).toBe(303);
      expect(await passOf(g, w)).toEqual([
        { from: "color:5", to: "Focus", tentative: false },
        { from: "color:6", to: "Deep", tentative: true },
      ]);
    });

    it("keeps the ticked boxes of a refused form", async () => {
      const { user, cookie, w, g } = await setup("mptentkeep");
      await setDirection(env, user, g, w, "busy");
      const response = await save(
        cookie,
        panelForm(
          g,
          w,
          ticked(
            [
              ["color:5", "Focus"],
              ["", "Deep"],
            ],
            [0],
          ),
        ),
      );
      expect(response.status).toBe(400);
      const boxes = [
        ...passRow(decode(await response.text())).matchAll(/<input class="switch"[^>]*>/g),
      ].map(([tag]) => / checked(=|[ />])/.test(tag));
      // The two refused rows and one empty row.
      expect(boxes).toEqual([true, false, false]);
      expect(await passOf(g, w)).toEqual([]);
    });

    it("refuses a ticked box from Outlook to Google at the field, as the batch path does", async () => {
      const { user, cookie, w, g } = await setup("mptentpar");
      await setDirection(env, user, w, g, "busy");
      expect(
        (await saveBatch(cookie, `passCategories.${w}.${g}`, [["Focus", "3", true]])).status,
      ).toBe(400);
      const response = await save(cookie, panelForm(w, g, ticked([["Focus", "3"]], [0])));
      expect(response.status).toBe(400);
      expect(decode(await response.text())).toContain(
        `<p class="prop-error" id="mx-pass-error">${en.next.mirroring.fieldErrors.passTentative}</p>`,
      );
      expect(await passOf(w, g)).toEqual([]);
    });

    it("writes nothing for a form that shows the stored marks", async () => {
      const { user, cookie, w, g } = await setup("mptentquiet");
      await setDirection(env, user, g, w, "busy");
      await setRuleDetails(env, user, {
        passCategories: [
          { from: g, to: w, pairs: [{ from: "color:5", to: "Focus", tentative: true }] },
        ],
      });
      const before = await env.DB.prepare("SELECT options FROM rules WHERE user_id = ?")
        .bind(user.id)
        .first();
      const response = await save(
        cookie,
        panelForm(g, w, [
          ["blockColor", ""],
          ...ticked(
            [
              ["color:5", "Focus"],
              ["", ""],
            ],
            [0],
          ),
        ]),
      );
      expect(response.status).toBe(303);
      expect(
        await env.DB.prepare("SELECT options FROM rules WHERE user_id = ?").bind(user.id).first(),
      ).toEqual(before);
    });
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
    const pairs = [{ from: "Focus", to: "3", tentative: false }];
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

  it("counts the ticked boxes of the rows as one change", () => {
    const base = {
      ...stored,
      sourceIsGoogle: true,
      targetIsGoogle: false,
      passCategories: [
        { from: "color:5", to: "Focus", tentative: true },
        { from: "color:6", to: "Deep", tentative: false },
      ],
    };
    const pairs: [string, string][] = [
      ["color:5", "Focus"],
      ["color:6", "Deep"],
      ["", ""],
    ];
    const tick = (indexes: number[]) =>
      form([...rows(pairs), ...indexes.map((i): [string, string] => ["passTentative", String(i)])]);
    expect(directionChanges(tick([0]), base)).toEqual({ count: 0, fields: [] });
    expect(directionChanges(tick([1]), base)).toEqual({ count: 1, fields: ["passTentative"] });
    expect(directionChanges(tick([]), base).fields).toEqual(["passTentative"]);
  });

  it("counts the list of one provider as one change", () => {
    const outlook = {
      ...stored,
      sourceIsGoogle: false,
      targetIsGoogle: false,
      passCategories: [{ from: "Focus", to: "", tentative: false }],
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
        { from: "color:5", to: "", tentative: false },
        { from: "color:6", to: "", tentative: false },
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

describe("carried categories for all events of a source calendar", () => {
  /** The setup, plus a second source calendar "Todoist" in the Google account, without colours. */
  async function withTodoist(prefix: string) {
    const ids = await setup(prefix);
    const todoist = `${ids.g}-todoist`;
    await env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, ?, 'Todoist', 0, 0, 1)",
    )
      .bind(todoist, ids.g, `${todoist}-remote`)
      .run();
    await setDirection(env, ids.user, ids.g, ids.w, "busy");
    return { ...ids, todoist, main: `${ids.g}-cal` };
  }

  /** The carried categories of every rule from the Google account into `w`, by source calendar. */
  async function passByCalendar(w: string): Promise<Record<string, Pair[] | undefined>> {
    const { results } = await env.DB.prepare(
      `SELECT r.source_calendar_id AS calendar, r.options FROM rules r
       JOIN calendars tc ON tc.id = r.target_calendar_id
       WHERE tc.account_id = ? ORDER BY r.source_calendar_id`,
    )
      .bind(w)
      .all<{ calendar: string; options: string }>();
    return Object.fromEntries(
      results.map((row) => [
        row.calendar,
        (JSON.parse(row.options) as { passCategories?: Pair[] }).passCategories,
      ]),
    );
  }

  function ticked(pairs: [string, string][], indexes: number[]): [string, string][] {
    return [
      ...rows(pairs),
      ...indexes.map((index): [string, string] => ["passTentative", String(index)]),
    ];
  }

  it("accepts only a source calendar of the direction, and only from Google to Outlook", () => {
    const row = { from: "calendar:cal-a", to: "Work Blocker", tentative: true };
    expect(passCategoriesFor("google", "microsoft", [row], ["cal-a", "cal-b"])).toEqual({
      pairs: [row],
    });
    expect(passCategoriesFor("google", "microsoft", [row], ["cal-b"])).toEqual({
      problem: "calendar",
    });
    expect(passCategoriesFor("google", "microsoft", [row])).toEqual({ problem: "calendar" });
    expect(
      passCategoriesFor("google", "google", [{ ...row, to: "3", tentative: false }], ["cal-a"]),
    ).toEqual({ problem: "from" });
    // An Outlook name may start with the prefix: it stays a name.
    expect(
      passCategoriesFor("microsoft", "google", [{ ...row, to: "3", tentative: false }], ["cal-a"]),
    ).toEqual({ pairs: [{ ...row, to: "3", tentative: false }] });
    expect(passCategoriesFor("google", "microsoft", [{ ...row, to: " " }], ["cal-a"])).toEqual({
      problem: "incomplete",
    });
  });

  it("offers each source calendar in the colour list from Google to Outlook only", async () => {
    const { user, cookie, w, g, todoist, main } = await withTodoist("mpcalshow");
    const row = passRow(await panel(cookie, g, w));
    const first = row.slice(row.indexOf('<select name="passFrom"'), row.indexOf("</select>"));
    expect(first).toContain(`<option value="calendar:${todoist}">All events from Todoist</option>`);
    expect(first).toContain(`<option value="calendar:${main}">All events from Main</option>`);
    // The colours come first, so that the list reads as before.
    expect(first.indexOf('value="color:11"')).toBeLessThan(first.indexOf("calendar:"));
    await setDirection(env, user, w, g, "busy");
    expect(passRow(await panel(cookie, w, g))).not.toContain("calendar:");
  });

  it("stores a calendar row from the panel, shows it again, saves it unchanged and clears it", async () => {
    const { user, cookie, w, g, todoist, main } = await withTodoist("mpcalsave");
    const pairs: [string, string][] = [
      ["color:8", "Work Blocker"],
      [`calendar:${todoist}`, "Work Blocker"],
      ["", ""],
    ];
    expect((await save(cookie, panelForm(g, w, ticked(pairs, [0, 1])))).status).toBe(303);
    const stored = [
      { from: "color:8", to: "Work Blocker", tentative: true },
      { from: `calendar:${todoist}`, to: "Work Blocker", tentative: true },
    ];
    // Every rule of the direction holds the list; the planner applies the row to its calendar.
    expect(await passByCalendar(w)).toEqual({ [main]: stored, [todoist]: stored });

    const row = passRow(await panel(cookie, g, w));
    const second = row.split('class="mx-pass-row"')[2] ?? "";
    expect(second).toContain(
      `<option value="calendar:${todoist}" selected="">All events from Todoist</option>`,
    );
    expect(second).toMatch(/name="passTo"[^>]*value="Work Blocker"/);

    const options = () =>
      env.DB.prepare("SELECT id, options FROM rules WHERE user_id = ? ORDER BY id")
        .bind(user.id)
        .all();
    const before = (await options()).results;
    expect(before).toHaveLength(2);
    const unchanged = panelForm(g, w, [["blockColor", ""], ...ticked(pairs, [0, 1])]);
    expect((await save(cookie, unchanged)).status).toBe(303);
    expect((await options()).results).toEqual(before);

    const cleared: [string, string][] = [
      ["color:8", "Work Blocker"],
      [`calendar:${todoist}`, ""],
    ];
    expect((await save(cookie, panelForm(g, w, ticked(cleared, [0])))).status).toBe(303);
    const kept = [{ from: "color:8", to: "Work Blocker", tentative: true }];
    expect(await passByCalendar(w)).toEqual({ [main]: kept, [todoist]: kept });
  });

  it("refuses a calendar that is not a source of the direction, in the panel and the batch", async () => {
    const { cookie, w, g } = await withTodoist("mpcalforeign");
    await env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, ?, 'Holidays', 0, 0, 0)",
    )
      .bind(`${g}-holidays`, g, `${g}-holidays-remote`)
      .run();
    const other = await setup("mpcalother");
    for (const calendar of [`${w}-cal`, `${g}-holidays`, `${other.g}-cal`, "no-such-calendar"]) {
      const response = await save(
        cookie,
        panelForm(g, w, rows([[`calendar:${calendar}`, "Work Blocker"]])),
      );
      expect(response.status, calendar).toBe(400);
      expect(decode(await response.text())).toContain(
        `<p class="prop-error" id="mx-pass-error">${en.next.mirroring.fieldErrors.passCalendar}</p>`,
      );
      const batch = await saveBatch(cookie, `passCategories.${g}.${w}`, [
        [`calendar:${calendar}`, "Work Blocker"],
      ]);
      expect(batch.status, calendar).toBe(400);
      expect(await batch.text()).toContain(en.editor.passCategoriesCalendar);
    }
    expect(await passByCalendar(w)).toEqual({ [`${g}-cal`]: [], [`${g}-todoist`]: [] });
  });

  /** A stored row for all events from Todoist, which then stops being a source. */
  async function withStaleTodoist(prefix: string) {
    const ids = await withTodoist(prefix);
    const stale = { from: `calendar:${ids.todoist}`, to: "Work Blocker", tentative: true };
    await setRuleDetails(env, ids.user, {
      passCategories: [{ from: ids.g, to: ids.w, pairs: [stale] }],
    });
    await setSourceCalendar(env, ids.user, ids.todoist, false);
    expect(await passByCalendar(ids.w)).toEqual({ [ids.main]: [stale] });
    return { ...ids, stale };
  }

  /** The `passFrom` list of each row of the panel. */
  function rowSelects(row: string): string[] {
    return row
      .split('class="mx-pass-row"')
      .slice(1)
      .map((part) =>
        part.slice(part.indexOf('<select name="passFrom"'), part.indexOf("</select>")),
      );
  }

  it("offers a calendar that is no longer a source only in the row that holds it", async () => {
    const { cookie, w, g, todoist, main } = await withStaleTodoist("mpcalstale");
    const [held, empty, ...more] = rowSelects(passRow(await panel(cookie, g, w)));
    expect(more).toEqual([]);
    expect(held).toContain(
      `<option value="calendar:${todoist}" selected="" data-pass-stale="">All events from Todoist (not a source)</option>`,
    );
    expect(held).toContain(`<option value="calendar:${main}">All events from Main</option>`);
    // The empty row, which the script copies for a new row, offers the source calendars only.
    expect(empty).toContain(`<option value="calendar:${main}">All events from Main</option>`);
    expect(empty).not.toContain(todoist);
  });

  it("names a removed calendar in the row that holds it", async () => {
    const { cookie, w, g, todoist } = await withStaleTodoist("mpcalgone");
    await env.DB.prepare("DELETE FROM calendars WHERE id = ?").bind(todoist).run();
    const [held, empty] = rowSelects(passRow(await panel(cookie, g, w)));
    expect(held).toContain(
      `<option value="calendar:${todoist}" selected="" data-pass-stale="">All events from a removed calendar</option>`,
    );
    expect(empty).not.toContain(todoist);
  });

  it("saves the panel with a stored row whose calendar is no longer a source", async () => {
    const { cookie, w, g, todoist, main, stale } = await withStaleTodoist("mpcalkeep");
    // The panel sends the stale row unchanged next to a new colour row.
    const shown: [string, string][] = [
      [`calendar:${todoist}`, "Work Blocker"],
      ["color:8", "Focus"],
      ["", ""],
    ];
    expect((await save(cookie, panelForm(g, w, ticked(shown, [0])))).status).toBe(303);
    const focus = { from: "color:8", to: "Focus", tentative: false };
    expect(await passByCalendar(w)).toEqual({ [main]: [stale, focus] });

    // With a new level, the rows go into the write of the level (`setDirections`).
    const wider: [string, string][] = [...shown.slice(0, 2), ["color:3", "Other"]];
    const form = panelForm(g, w, ticked(wider, [0]));
    form.set("copy", "title");
    expect((await save(cookie, form)).status).toBe(303);
    const other = { from: "color:3", to: "Other", tentative: false };
    expect(await passByCalendar(w)).toEqual({ [main]: [stale, focus, other] });

    // Clearing the row removes it.
    const cleared: [string, string][] = [[`calendar:${todoist}`, ""], ...wider.slice(1)];
    expect((await save(cookie, panelForm(g, w, rows(cleared)))).status).toBe(303);
    expect(await passByCalendar(w)).toEqual({ [main]: [focus, other] });
  });

  it("saves a batch with a stored row whose calendar is no longer a source", async () => {
    const { cookie, w, g, todoist, main, stale } = await withStaleTodoist("mpcalbatch");
    const batch = await saveBatch(cookie, `passCategories.${g}.${w}`, [
      [`calendar:${todoist}`, "Work Blocker", true],
      ["color:8", "Focus"],
    ]);
    expect(batch.status).toBe(204);
    const focus = { from: "color:8", to: "Focus", tentative: false };
    expect(await passByCalendar(w)).toEqual({ [main]: [stale, focus] });
  });

  it("stores the rows of a batch that also stops their calendar being a source", async () => {
    const { cookie, w, g, user, todoist, main } = await withTodoist("mpcalsame");
    const stored = { from: `calendar:${todoist}`, to: "Work Blocker", tentative: true };
    await setRuleDetails(env, user, { passCategories: [{ from: g, to: w, pairs: [stored] }] });
    const response = await exports.default.fetch(`${BASE}/rules/choices`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "x-fragment": "1", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        [`calendar.${todoist}`]: "0",
        [`passCategories.${g}.${w}`]: JSON.stringify([
          [`calendar:${todoist}`, "Work Blocker", true],
          ["color:8", "Focus"],
        ]),
      }),
    });
    expect(response.status).toBe(204);
    const focus = { from: "color:8", to: "Focus", tentative: false };
    expect(await passByCalendar(w)).toEqual({ [main]: [stored, focus] });
  });

  it("refuses a new row for a calendar that the same batch stops being a source", async () => {
    const { cookie, w, g, todoist, main } = await withTodoist("mpcalsamenew");
    const response = await exports.default.fetch(`${BASE}/rules/choices`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "x-fragment": "1", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        [`calendar.${todoist}`]: "0",
        [`passCategories.${g}.${w}`]: JSON.stringify([[`calendar:${todoist}`, "Work Blocker"]]),
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(en.editor.passCategoriesCalendar);
    // Nothing was written: Todoist is still a source.
    expect(await passByCalendar(w)).toEqual({ [main]: [], [todoist]: [] });
  });

  it("keeps the other details of a batch that turns off a direction with a stale row", async () => {
    const { cookie, user, w, o, g, todoist } = await withStaleTodoist("mpcaloff");
    await setDirection(env, user, g, o, "busy");
    const response = await exports.default.fetch(`${BASE}/rules/choices`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "x-fragment": "1", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        [`choice.${g}.${w}`]: "off",
        [`passCategories.${g}.${w}`]: JSON.stringify([
          [`calendar:${todoist}`, "Work Blocker", true],
        ]),
        [`blockColor.${g}.${o}`]: "Focus",
      }),
    });
    expect(response.status).toBe(204);
    const colour = await env.DB.prepare(
      `SELECT json_extract(r.options, '$.blockColor') AS color FROM rules r
       JOIN calendars tc ON tc.id = r.target_calendar_id WHERE tc.account_id = ?`,
    )
      .bind(o)
      .first<{ color: string }>();
    expect(colour?.color).toBe("Focus");
  });
});
