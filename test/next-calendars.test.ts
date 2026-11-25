import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadEditorState, setDirection } from "../src/editor";
import { de } from "../src/i18n/de";
import { en } from "../src/i18n/en";
import worker from "../src/index";
import { bufferAffected, hoursAffected } from "../src/next-calendars";
import { BASE, countingEnv, signIn } from "./helpers";

/** Two calendars of one user. `created_at` fixes the order, which is the order of the page. */
async function setup(prefix: string) {
  const { user, cookie } = await signIn(`${prefix}@org.example`);
  const accounts = [
    [`${prefix}-z`, `${prefix}@zeta.example`, "microsoft", "2026-01-01T10:00:00.000Z"],
    [`${prefix}-a`, `${prefix}@alpha.example`, "google", "2026-01-01T11:00:00.000Z"],
  ] as const;
  for (const [id, email, provider, createdAt] of accounts) {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, provider, email, created_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(id, user.id, provider, email, createdAt),
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, ?, 'Main', 1, 1, 1)",
      ).bind(`${id}-cal`, id, `${id}-remote`),
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, ?, 'Side', 1, 0, 0)",
      ).bind(`${id}-side`, id, `${id}-side-remote`),
    ]);
    await env.ACCOUNT_SYNC.getByName(id).storeTokens(
      id,
      {
        refreshToken: "r",
        accessToken: "a",
        accessExpiresAt: Date.now() + 3_600_000,
      },
      provider,
    );
  }
  return { user, cookie, z: `${prefix}-z`, a: `${prefix}-a` };
}

function get(path: string, cookie: string, language = "en") {
  return exports.default.fetch(`${BASE}${path}`, {
    headers: { cookie, "accept-language": language },
    redirect: "manual",
  });
}

function post(path: string, cookie: string, body: URLSearchParams) {
  return exports.default.fetch(`${BASE}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

/** The panel form as the page sends it, with working hours switched on. */
function panelForm(id: string, fields: Record<string, string>, days: string[] = []) {
  const body = new URLSearchParams({
    back: `/calendars?c=${id}&saved=1`,
    workHoursShown: "1",
    ...fields,
  });
  for (const day of days) body.append("workDays", day);
  return body;
}

const stateOf = async (userId: string) => loadEditorState(env, userId);

/** What a save of the panel can change, as stored. */
async function ownerData(userId: string) {
  await loadEditorState(env, userId);
  const accounts = await env.DB.prepare(
    "SELECT id, display_name, color, work_hours, source_options FROM accounts WHERE user_id = ? ORDER BY id",
  )
    .bind(userId)
    .all();
  const calendars = await env.DB.prepare(
    "SELECT c.id, c.is_source FROM calendars c JOIN accounts a ON a.id = c.account_id WHERE a.user_id = ? ORDER BY c.id",
  )
    .bind(userId)
    .all();
  const rules = await env.DB.prepare("SELECT id, options, enabled FROM rules WHERE user_id = ?")
    .bind(userId)
    .all();
  return {
    accounts: accounts.results,
    calendars: calendars.results,
    rules: rules.results,
  };
}

/** A POST through a counted env. `beforeBatch` can change the data as another request would. */
async function postCounted(
  path: string,
  cookie: string,
  body: URLSearchParams,
  beforeBatch?: (sql: string[]) => Promise<void>,
) {
  const counted = countingEnv(beforeBatch);
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${BASE}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body,
    }),
    counted.env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

beforeEach(() => {
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

describe("calendars page of the redesign", () => {
  it("lists the calendars in the order of the editor state", async () => {
    const { cookie, z, a } = await setup("ncal-order");
    const html = await (await get("/calendars", cookie)).text();
    const first = html.indexOf(`href="/calendars?c=${z}"`);
    const second = html.indexOf(`href="/calendars?c=${a}"`);
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    // No panel without a selection.
    expect(html).not.toContain('class="detail"');
  });

  it("opens the panel for a valid ?c= and not for an invalid one", async () => {
    const { cookie, z } = await setup("ncal-panel");
    const open = await (await get(`/calendars?c=${z}`, cookie)).text();
    expect(open).toContain('class="detail"');
    expect(open).toContain(`action="/calendars/${z}"`);
    expect(open).toContain('name="back"');
    expect(open).toMatch(/src="\/next\/calendars\.[0-9a-f]{10}\.js"/);
    expect(open).toMatch(/src="\/next\/panel\.[0-9a-f]{10}\.js"/);
    // "Disconnect" opens the step in this panel; it removes nothing by itself.
    expect(open).toContain(`href="/calendars?c=${z}&amp;confirm=disconnect"`);
    expect(open).not.toContain('href="/accounts/' + z + '/disconnect"');
    const closed = await (await get("/calendars?c=does-not-exist", cookie)).text();
    expect(closed).not.toContain('class="detail"');
  });

  it("renames a calendar, stores it and goes back to the panel", async () => {
    const { user, cookie, z } = await setup("ncal-rename");
    const response = await post(
      `/calendars/${z}`,
      cookie,
      panelForm(z, { name: "Work calendar", color: "green" }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/calendars?c=${z}&saved=1`);
    const account = (await stateOf(user.id)).accounts.find((entry) => entry.id === z);
    expect(account?.name).toBe("Work calendar");
    expect(account?.color).toBe("green");
    const html = await (await get(response.headers.get("location") ?? "", cookie)).text();
    expect(html).toContain("Work calendar");
    expect(html).toContain("data-saved=");
  });

  it("ignores a back field that leaves the app pages", async () => {
    const { cookie, z } = await setup("ncal-back");
    for (const back of ["https://evil.example/", "//evil.example", "/rules", "/next/../rules"]) {
      const body = panelForm(z, { name: "Back test" });
      body.set("back", back);
      const response = await post(`/calendars/${z}`, cookie, body);
      expect(response.status, back).toBe(303);
      const location = response.headers.get("location") ?? "";
      expect(location.startsWith("/calendars?c="), back).toBe(true);
    }
    const near = panelForm(z, { name: "Back test" });
    near.set("back", "/mirroring?d=all");
    const response = await post(`/calendars/${z}`, cookie, near);
    expect(response.headers.get("location")).toBe("/mirroring?d=all");
  });

  it("stores working hours, source calendars and the buffer in one save", async () => {
    const { user, cookie, z } = await setup("ncal-all");
    const body = panelForm(
      z,
      {
        workHoursOn: "1",
        workStart: "08:00",
        workEnd: "18:00",
        workTimeZone: "Europe/Vienna",
        bufferShown: "1",
        bufferBefore: "10",
        bufferAfter: "5",
        sourceShown: `${z}-side`,
        source: `${z}-side`,
      },
      ["1", "2", "3", "4", "5"],
    );
    body.append("sourceShown", `${z}-cal`);
    expect((await post(`/calendars/${z}`, cookie, body)).status).toBe(303);
    const account = (await stateOf(user.id)).accounts.find((entry) => entry.id === z);
    expect(account?.workHours).toEqual({
      workDays: [1, 2, 3, 4, 5],
      workStart: "08:00",
      workEnd: "18:00",
      workTimeZone: "Europe/Vienna",
    });
    expect(account?.sourceOptions).toMatchObject({
      bufferBefore: 10,
      bufferAfter: 5,
    });
    // The side calendar is on, the main calendar was shown but not sent, so it is off.
    expect(account?.calendars.find((c) => c.id === `${z}-side`)?.isSource).toBe(true);
    expect(account?.calendars.find((c) => c.id === `${z}-cal`)?.isSource).toBe(false);
  });

  it("refuses invalid working hours with 400, keeps the input and writes nothing", async () => {
    const { user, cookie, z } = await setup("ncal-bad");
    const response = await post(
      `/calendars/${z}`,
      cookie,
      panelForm(
        z,
        {
          name: "Should not stick",
          workHoursOn: "1",
          workStart: "18:00",
          workEnd: "08:00",
          workTimeZone: "Europe/Vienna",
        },
        ["1", "2"],
      ),
    );
    expect(response.status).toBe(400);
    const html = await response.text();
    // The reason at the field, "Nothing was saved." on top, the field marked for the script.
    expect(html).toContain(
      `<p class="prop-error" id="cal-range-error">${en.next.calendars.fieldErrors.order}</p>`,
    );
    expect(html).toContain(en.next.shell.panel.notSaved);
    expect(html).toMatch(
      /name="workEnd"[^>]*aria-describedby="cal-range-error" aria-invalid="true"/,
    );
    expect(html).not.toMatch(/name="workStart"[^>]*aria-invalid/);
    expect(html).toContain('class="detail"');
    expect(html).toMatch(/name="name"[^>]*value="Should not stick"/);
    expect(html).toMatch(/name="workStart"[^>]*value="18:00"/);
    expect(html).toMatch(/name="workEnd"[^>]*value="08:00"/);
    const account = (await stateOf(user.id)).accounts.find((entry) => entry.id === z);
    expect(account?.workHours).toBeNull();
    expect(account?.name).not.toBe("Should not stick");
  });

  it("refuses a buffer outside the range", async () => {
    const { cookie, z } = await setup("ncal-buffer");
    const response = await post(
      `/calendars/${z}`,
      cookie,
      panelForm(z, { bufferShown: "1", bufferBefore: "999", bufferAfter: "0" }),
    );
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain(
      `<p class="prop-error" id="cal-buffer-before-error">${en.next.calendars.fieldErrors.buffer(240)}</p>`,
    );
    expect(html).toMatch(/id="cal-buffer-before"[^>]*aria-invalid="true"/);
    expect(html).not.toMatch(/id="cal-buffer-after"[^>]*aria-invalid/);
  });

  it("does not save a calendar of another user", async () => {
    const { user, z } = await setup("ncal-own");
    const before = await ownerData(user.id);
    const { cookie } = await signIn("ncal-other@org.example");
    const response = await post(
      `/calendars/${z}`,
      cookie,
      panelForm(
        z,
        {
          name: "Stolen",
          color: "green",
          bufferShown: "1",
          bufferBefore: "5",
          bufferAfter: "5",
        },
        ["1", "2"],
      ),
    );
    expect(response.status).toBe(404);
    // The owner's name, colour, hours, buffer and calendars stayed as they were.
    expect(await ownerData(user.id)).toEqual(before);
    const account = (await stateOf(user.id)).accounts.find((entry) => entry.id === z);
    expect(account?.customName).toBeNull();
    expect(account?.colorChosen).toBe(false);
  });

  it("shows a calendar that needs a new connection with its action in the row", async () => {
    const { cookie, z } = await setup("ncal-reconnect");
    await env.DB.prepare("UPDATE accounts SET needs_reconnect = 1 WHERE id = ?").bind(z).run();
    const html = await (await get("/calendars", cookie)).text();
    expect(html).toContain(en.next.shell.run.connectionLost);
    const link = `href="/auth/microsoft/connect?account=${z}"`;
    // One in the notice above the list and one in the row.
    expect(html.split(link).length - 1).toBe(2);
    expect(html).toContain("is-danger");
  });

  it("shows the connect choices and no list for a user without calendars", async () => {
    const { cookie } = await signIn("ncal-empty@org.example");
    const html = await (await get("/calendars", cookie)).text();
    expect(html).toContain(en.next.calendars.emptyTitle);
    expect(html).toContain('href="/auth/microsoft/connect"');
    expect(html).not.toContain('class="list cal-list"');
    // The Google hint stands once, next to the Google choice.
    expect(html.split(en.next.calendars.googleHint).length - 1).toBe(1);
  });

  it("speaks German", async () => {
    const { cookie, z } = await setup("ncal-de");
    const html = await (await get(`/calendars?c=${z}`, cookie, "de")).text();
    expect(html).toContain(de.next.calendars.sectionMirrored);
    expect(html).toContain(de.next.calendars.disconnect);
  });
});

describe("status meaning of a calendar", () => {
  it("says in the list row and the panel head that the status counts the copies into it", async () => {
    const { user, cookie, z } = await setup("ncal-statushint");
    const name = (await stateOf(user.id)).accounts.find((entry) => entry.id === z)?.name ?? "";
    expect(name).not.toBe("");
    for (const [language, hint] of [
      ["en", `title="Status of the copies into ${name}"`],
      ["de", `title="Status der Kopien in ${name}"`],
    ] as const) {
      const list = await (await get("/calendars", cookie, language)).text();
      expect(list, language).toContain(hint);
      const panel = await (await get(`/calendars?c=${z}`, cookie, language)).text();
      // The row of the list and the panel head each carry it.
      expect(panel.split(hint).length - 1, language).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("save bar notes and sections of the calendar panel", () => {
  it("splits the panel into what comes in and what goes out", async () => {
    const { user, cookie, z } = await setup("ncal-sections");
    const name = (await stateOf(user.id)).accounts.find((entry) => entry.id === z)?.name ?? "";
    expect(name).not.toBe("");
    const html = await (await get(`/calendars?c=${z}`, cookie)).text();
    expect(html).toContain(en.next.calendars.sectionIncoming(name));
    expect(html).toContain(en.next.calendars.sectionOutgoing(name));
    const incoming = html.indexOf(en.next.calendars.sectionIncoming(name));
    const outgoing = html.indexOf(en.next.calendars.sectionOutgoing(name));
    const hours = html.indexOf('name="workHoursOn"');
    const sources = html.indexOf('name="source"');
    const connection = html.indexOf(en.next.calendars.sectionConnection);
    // Working hours sit under "into", mirrored calendars under "out of", connection last.
    expect(incoming).toBeLessThan(hours);
    expect(hours).toBeLessThan(outgoing);
    expect(outgoing).toBeLessThan(sources);
    expect(sources).toBeLessThan(connection);
  });

  it("lists the mirrorings that new working hours reach, in the save bar", async () => {
    const { user, cookie, z, a } = await setup("ncal-affected");
    await setDirection(env, user, a, z, "busy");
    const state = await stateOf(user.id);
    expect(hoursAffected(state, z)).toEqual([{ from: a, to: z }]);
    // Nothing runs into the other calendar: no list, no note.
    expect(hoursAffected(state, a)).toEqual([]);
    const nameOf = (id: string) => state.accounts.find((entry) => entry.id === id)?.name ?? "";
    const html = await (await get(`/calendars?c=${z}`, cookie)).text();
    expect(html).toContain(
      en.next.calendars.hoursAffected(1, en.next.mirroring.fromTo(nameOf(a), nameOf(z))),
    );
    expect(html).toContain('data-changed="workHoursOn workDays workStart workEnd');
    // The buffer note of a > z stays there; the hours note is gone.
    const quiet = await (await get(`/calendars?c=${a}`, cookie)).text();
    expect(quiet).not.toContain('data-changed="workHoursOn');
  });

  it("lists the mirrorings out of the calendar when its buffer changes", async () => {
    const { user, cookie, z, a } = await setup("ncal-bufout");
    await setDirection(env, user, z, a, "busy");
    await setDirection(env, user, a, z, "busy");
    const state = await stateOf(user.id);
    // The buffer belongs to the copies of z's events: only the mirroring out of z.
    expect(bufferAffected(state, z)).toEqual([{ from: z, to: a }]);
    expect(bufferAffected(state, a)).toEqual([{ from: a, to: z }]);
    const nameOf = (id: string) => state.accounts.find((entry) => entry.id === id)?.name ?? "";
    const html = await (await get(`/calendars?c=${z}`, cookie)).text();
    const outgoing = en.next.calendars.hoursAffected(
      1,
      en.next.mirroring.fromTo(nameOf(z), nameOf(a)),
    );
    const note = html.match(
      /<p data-note[^>]*data-changed="bufferBefore bufferAfter"[^>]*>([^<]*)</,
    );
    expect(note?.[1]?.replaceAll("&quot;", '"')).toBe(outgoing);
    // A mirroring that is off copies nothing, so the buffer changes nothing for it.
    await setDirection(env, user, z, a, "off");
    expect(bufferAffected(await stateOf(user.id), z)).toEqual([]);
    const quiet = await (await get(`/calendars?c=${z}`, cookie)).text();
    expect(quiet).not.toContain('data-changed="bufferBefore bufferAfter"');
  });

  it("with working hours set, only mirrorings that use them are affected", async () => {
    const { user, z, a } = await setup("ncal-affected2");
    await setDirection(env, user, a, z, "busy");
    const body = panelForm(
      z,
      {
        workHoursOn: "1",
        workStart: "08:00",
        workEnd: "18:00",
        workTimeZone: "Europe/Vienna",
      },
      ["1", "2", "3", "4", "5"],
    );
    expect(body.get("workHoursOn")).toBe("1");
    const { cookie } = await signIn("ncal-affected2@org.example");
    expect((await post(`/calendars/${z}`, cookie, body)).status).toBe(303);
    expect(hoursAffected(await stateOf(user.id), z)).toEqual([{ from: a, to: z }]);
    // The mirrorings now switch hours off: the hours change reaches none of them.
    await env.DB.prepare(
      "UPDATE rules SET options = json_set(options, '$.workDays', json('[1,2,3,4,5,6,7]'), '$.workStart', '', '$.workEnd', '') WHERE user_id = ?",
    )
      .bind(user.id)
      .run();
    expect(hoursAffected(await stateOf(user.id), z)).toEqual([]);
  });

  it("warns that switching off a calendar removes its copies", async () => {
    const { cookie, z } = await setup("ncal-off");
    const html = await (await get(`/calendars?c=${z}`, cookie)).text();
    expect(html).toContain(en.next.calendars.sourceOff("Main"));
    expect(html).toContain(`data-off="cal-src-${z}-cal"`);
    // The side calendar is not a source: nothing is lost by leaving it off.
    expect(html).not.toContain(en.next.calendars.sourceOff("Side"));
  });
});

describe("a calendar save that stopped part-way", () => {
  const OFFICE = {
    workHoursOn: "1",
    workStart: "08:00",
    workEnd: "18:00",
    workTimeZone: "Europe/Vienna",
  };
  const WEEK = ["1", "2", "3", "4", "5"];

  it("finishes on retry: the incoming mirrorings get the new hours and the note stays right", async () => {
    const { user, cookie, z, a } = await setup("ncal-retry");
    await setDirection(env, user, a, z, "busy");
    const rulesOf = async () => {
      const { results } = await env.DB.prepare("SELECT options FROM rules WHERE user_id = ?")
        .bind(user.id)
        .all<{ options: string }>();
      return results.map(
        (row) => JSON.parse(row.options) as { workStart: string; workDays: number[] },
      );
    };

    // The hours and the switch for the mirroring are one guarded batch. Before it runs, another tab
    // changes a rule, so that the batch refuses and the save ends with the conflict notice.
    let interfered = false;
    const first = await postCounted(
      `/calendars/${z}`,
      cookie,
      panelForm(z, { ...OFFICE, workHoursHad: "0" }, WEEK),
      async (sql) => {
        if (
          interfered ||
          !sql.some((statement) => statement.startsWith("UPDATE rules SET options"))
        ) {
          return;
        }
        interfered = true;
        await env.DB.prepare(
          "UPDATE rules SET options = json_set(options, '$.daysAhead', 7)",
        ).run();
      },
    );
    expect(interfered).toBe(true);
    // The panel shows what is stored, with its version (review m2), not the input.
    expect(first.status).toBe(409);
    const refused = await first.text();
    expect(refused).toContain(en.next.calendars.conflict);
    expect(refused).not.toContain("data-refused");
    // Nothing is half applied: no hours on the account and none on the mirroring.
    expect((await stateOf(user.id)).accounts.find((entry) => entry.id === z)?.workHours).toBeNull();
    expect((await rulesOf()).every((rule) => rule.workStart === "")).toBe(true);
    // The panel drawn after the refusal still names the mirroring that the retry will switch on,
    // and still says that the account had no hours when the form was drawn.
    const state = await stateOf(user.id);
    const nameOf = (id: string) => state.accounts.find((entry) => entry.id === id)?.name ?? "";
    expect(refused).toContain(
      en.next.calendars.hoursAffected(1, en.next.mirroring.fromTo(nameOf(a), nameOf(z))),
    );
    expect(refused).toMatch(/name="workHoursHad"[^>]*value="0"/);

    // The user saves again with the form as drawn.
    const retry = panelForm(z, OFFICE, WEEK);
    retry.set("workHoursHad", "0");
    expect((await post(`/calendars/${z}`, cookie, retry)).status).toBe(303);
    expect(await rulesOf()).toEqual([
      expect.objectContaining({
        workStart: "08:00",
        workDays: [1, 2, 3, 4, 5],
      }),
    ]);
    // A later save of a page that was drawn with hours does not tick the mirroring again.
    await env.DB.prepare(
      "UPDATE rules SET options = json_set(options, '$.workDays', json('[1,2,3,4,5,6,7]'), '$.workStart', '', '$.workEnd', '') WHERE user_id = ?",
    )
      .bind(user.id)
      .run();
    const later = panelForm(z, { ...OFFICE, workEnd: "17:00" }, WEEK);
    later.set("workHoursHad", "1");
    expect((await post(`/calendars/${z}`, cookie, later)).status).toBe(303);
    expect((await rulesOf()).every((rule) => rule.workStart === "")).toBe(true);
  });

  it("draws the panel with the stored state of the hours", async () => {
    const { user, cookie, z, a } = await setup("ncal-had");
    await setDirection(env, user, a, z, "busy");
    expect(await (await get(`/calendars?c=${z}`, cookie)).text()).toMatch(
      /name="workHoursHad"[^>]*value="0"/,
    );
    expect((await post(`/calendars/${z}`, cookie, panelForm(z, OFFICE, WEEK))).status).toBe(303);
    expect(await (await get(`/calendars?c=${z}`, cookie)).text()).toMatch(
      /name="workHoursHad"[^>]*value="1"/,
    );
  });
});

function decodeHtml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/** The fields the panel's form submits as a browser would, from the rendered page. */
function panelFields(html: string): URLSearchParams {
  const start = html.indexOf('<form class="detail-form"');
  expect(start, "panel form").toBeGreaterThan(0);
  const form = html.slice(start, html.indexOf("</form>", start));
  const body = new URLSearchParams();
  for (const match of form.matchAll(/<input\b[^>]*>/g)) {
    const tag = match[0];
    const attr = (name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
    const has = (name: string) => new RegExp(`\\s${name}(?:[\\s=/>])`).test(tag);
    const name = attr("name");
    if (!name || has("disabled")) continue;
    const type = attr("type") ?? "text";
    if ((type === "radio" || type === "checkbox") && !has("checked")) continue;
    body.append(name, decodeHtml(attr("value") ?? "on"));
  }
  return body;
}

describe("refusals at their field in the calendar panel", () => {
  it("hints at a stored time zone that this server does not know", async () => {
    const { cookie, z } = await setup("ncal-zonehint");
    const store = (zone: string) =>
      env.DB.prepare("UPDATE accounts SET work_hours = ? WHERE id = ?")
        .bind(
          JSON.stringify({
            workDays: [1, 2, 3, 4, 5],
            workStart: "08:00",
            workEnd: "18:00",
            workTimeZone: zone,
          }),
          z,
        )
        .run();
    await store("Europe/Vienna");
    const known = decodeHtml(await (await get(`/calendars?c=${z}`, cookie)).text());
    expect(known).not.toContain(en.editor.workZoneUnknown("Europe/Vienna"));
    await store("Mars/Olympus");
    const html = decodeHtml(await (await get(`/calendars?c=${z}`, cookie)).text());
    expect(html).toContain(en.editor.workZoneUnknown("Mars/Olympus"));
    expect(html).toMatch(/name="workTimeZone"[^>]*value="Mars\/Olympus"/);
  });

  it("ties an unknown time zone to its field and counts the one change", async () => {
    const { cookie, z } = await setup("ncal-zone");
    await env.DB.prepare("UPDATE accounts SET work_hours = ? WHERE id = ?")
      .bind(
        JSON.stringify({
          workDays: [1, 2, 3, 4, 5],
          workStart: "08:00",
          workEnd: "18:00",
          workTimeZone: "Europe/Vienna",
        }),
        z,
      )
      .run();
    const body = panelFields(await (await get(`/calendars?c=${z}`, cookie)).text());
    expect(body.get("workHoursOn")).toBe("1");
    body.set("workTimeZone", "Mars/Olympus");
    const response = await post(`/calendars/${z}`, cookie, body);
    expect(response.status).toBe(400);
    const html = decodeHtml(await response.text());
    expect(html).toContain(
      `<p class="prop-error" id="cal-zone-error">${en.next.calendars.fieldErrors.zone}</p>`,
    );
    expect(html).toMatch(/id="cal-zone"[^>]*aria-describedby="cal-zone-error" aria-invalid="true"/);
    expect(html).toMatch(/name="workTimeZone"[^>]*value="Mars\/Olympus"/);
    expect(html).toContain(`${en.next.shell.panel.notSaved}</div>`);
    expect(html).toContain('data-refused-count="1"');
    expect(html).toContain('data-refused-fields="workTimeZone"');
    // Only that field is marked.
    expect(html.match(/aria-invalid="true"/g)).toHaveLength(1);
    const german = decodeHtml(
      await (
        await exports.default.fetch(`${BASE}/calendars/${z}`, {
          method: "POST",
          redirect: "manual",
          headers: {
            cookie,
            "content-type": "application/x-www-form-urlencoded",
            "accept-language": "de",
          },
          body,
        })
      ).text(),
    );
    expect(german).toContain("Unbekannte Zeitzone. Beispiel: Europe/Vienna.");
    expect(german).toContain("Es wurde nichts gespeichert.");
  });

  it("counts no zone change on a calendar without hours when the browser's zone is not the server's", async () => {
    const { cookie, z } = await setup("ncal-zonebase");
    const page = decodeHtml(await (await get(`/calendars?c=${z}`, cookie)).text());
    // The server's zone is UTC; the page asks the browser for its own.
    expect(page).toMatch(/name="workTimeZone"[^>]*value="UTC"[^>]*data-browser-zone="1"/);
    const body = panelFields(page);
    expect(body.get("workHoursOn")).toBeNull();
    // What `calendars.js` does in a browser in Vienna: the zone field and its baseline take the
    // browser's zone, so the zone is no change.
    body.set("workTimeZone", "Europe/Vienna");
    body.set("workTimeZoneDefault", "Europe/Vienna");
    body.set("bufferShown", "1");
    body.set("bufferBefore", "999");
    const response = await post(`/calendars/${z}`, cookie, body);
    expect(response.status).toBe(400);
    const html = decodeHtml(await response.text());
    expect(html).toContain('data-refused-count="1"');
    expect(html).toContain('data-refused-fields="bufferBefore"');
    // The refused panel keeps the browser's zone as the baseline, so a second refusal counts the
    // same; the script does not set the zone again.
    expect(html).toMatch(/name="workTimeZone"[^>]*value="Europe\/Vienna"/);
    expect(html).not.toContain("data-browser-zone");
    expect(html).toMatch(/name="workTimeZoneDefault" value="Europe\/Vienna"/);
    const again = await post(`/calendars/${z}`, cookie, panelFields(html));
    expect(again.status).toBe(400);
    expect(await again.text()).toContain('data-refused-fields="bufferBefore"');
  });

  it("counts a zone change on a calendar without hours against the browser's zone", async () => {
    const { cookie, z } = await setup("ncal-zonemove");
    const body = panelFields(await (await get(`/calendars?c=${z}`, cookie)).text());
    body.set("workTimeZone", "Europe/London");
    body.set("workTimeZoneDefault", "Europe/Vienna");
    body.set("bufferShown", "1");
    body.set("bufferBefore", "999");
    const html = await (await post(`/calendars/${z}`, cookie, body)).text();
    expect(html).toContain('data-refused-count="2"');
    expect(html).toContain('data-refused-fields="workTimeZone bufferBefore"');
    // A baseline that is no zone falls back to the server's, as without the script.
    body.set("workTimeZone", "UTC");
    body.set("workTimeZoneDefault", "Mars/Olympus");
    const fallback = await (await post(`/calendars/${z}`, cookie, body)).text();
    expect(fallback).toContain('data-refused-fields="bufferBefore"');
  });

  it("names a refused source switch by its value", async () => {
    const { cookie, z } = await setup("ncal-srcfield");
    const body = panelFields(await (await get(`/calendars?c=${z}`, cookie)).text());
    body.append("source", `${z}-side`);
    body.set("bufferShown", "1");
    body.set("bufferBefore", "999");
    const response = await post(`/calendars/${z}`, cookie, body);
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain('data-refused-count="2"');
    expect(html).toContain(`data-refused-fields="bufferBefore source:${z}-side"`);
  });

  it("ties a missing weekday to the days", async () => {
    const { cookie, z } = await setup("ncal-days");
    const response = await post(
      `/calendars/${z}`,
      cookie,
      panelForm(z, { workHoursOn: "1", workStart: "08:00", workEnd: "18:00" }),
    );
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain(`id="cal-days-error">${en.next.calendars.fieldErrors.days}<`);
    expect(html).toMatch(/class="seg is-block cal-days"[^>]*aria-describedby="cal-days-error"/);
    expect(html).toMatch(/class="seg is-block cal-days"[^>]*aria-invalid="true"/);
  });
});

describe("the calendar panel's controls", () => {
  it("draws the days as a segmented group of checkboxes, one tab stop", async () => {
    const { cookie, z } = await setup("ncal-segdays");
    const html = decodeHtml(await (await get(`/calendars?c=${z}`, cookie)).text());
    const start = html.indexOf('class="seg is-block cal-days"');
    expect(start).toBeGreaterThan(0);
    const group = html.slice(html.lastIndexOf("<div", start), html.indexOf("</div>", start));
    expect(group).toContain('role="group"');
    expect(group).toContain("data-roving");
    expect(group).toContain('data-change-group="days"');
    expect(group).toContain('aria-labelledby="cal-days-label"');
    expect(group.match(/type="checkbox" name="workDays"/g)).toHaveLength(7);
    expect(group).toContain('title="Monday"');
    expect(group).toContain('aria-label="Monday"');
    expect(group).toContain('<span aria-hidden="true">Mo</span>');
    // Monday to Friday before any hours are stored.
    expect(group.match(/ checked/g)).toHaveLength(5);
  });

  it("puts the provider before the address in the panel's state line, not in the title", async () => {
    const { cookie, z } = await setup("ncal-glyph");
    const html = await (await get(`/calendars?c=${z}`, cookie)).text();
    const title = html.slice(
      html.indexOf('class="detail-title"'),
      html.indexOf("</h2>", html.indexOf('class="detail-title"')),
    );
    expect(title).not.toContain("glyph");
    const metaStart = html.indexOf('<p class="detail-meta">');
    const meta = html.slice(metaStart, html.indexOf("</p>", metaStart));
    const glyph = meta.search(/<svg[^>]*class="[^"]*glyph/);
    expect(glyph, meta).toBeGreaterThan(0);
    expect(glyph).toBeLessThan(meta.indexOf("@zeta.example"));
  });
});

describe("an address of a calendar that is gone", () => {
  it("says so above the list with status 200", async () => {
    const { cookie, z } = await setup("ncal-gone");
    const response = await get("/calendars?c=nobody", cookie);
    expect(response.status).toBe(200);
    const html = decodeHtml(await response.text());
    expect(html).toContain(en.next.calendars.gone);
    expect(html).not.toContain('class="detail"');
    expect(decodeHtml(await (await get("/calendars?c=nobody", cookie, "de")).text())).toContain(
      de.next.calendars.gone,
    );
    for (const path of ["/calendars", `/calendars?c=${z}`]) {
      expect(decodeHtml(await (await get(path, cookie)).text()), path).not.toContain(
        en.next.calendars.gone,
      );
    }
  });
});

describe("a calendar's status agrees with its mirrorings (critique 3 #1)", () => {
  /** The dot and the words of a status, from the markup that holds it. */
  function statusOf(html: string): { tone: string; words: string } {
    const tone = /class="dot dot-(\w+)"/.exec(html)?.[1] ?? "";
    const words = /class="run-words[^"]*">([^<]*)</.exec(html)?.[1] ?? "";
    return { tone, words: decodeHtml(words) };
  }

  /** The status cell of the list row with `id`. */
  function rowStatus(html: string, id: string) {
    const start = html.indexOf(`id="${id}"`);
    expect(start, id).toBeGreaterThan(0);
    const cell = html.indexOf('class="row-status"', start);
    return statusOf(html.slice(cell, html.indexOf("</li>", cell)));
  }

  it("shows a delay of a mirroring into the calendar, as the Mirroring page does", async () => {
    const { user, cookie, z, a } = await setup("ncal-stale");
    await setDirection(env, user, a, z, "busy");
    const rule = await env.DB.prepare("SELECT id FROM rules WHERE user_id = ?")
      .bind(user.id)
      .first<{ id: string }>();
    // The last run, 21 hours ago, was fine; nothing has run since.
    await env.DB.prepare(
      `INSERT INTO audit_events (org_id, user_id, account_id, rule_id, kind, detail, created_at)
       VALUES ('default', ?, ?, ?, 'sync_run', ?, ?)`,
    )
      .bind(
        user.id,
        z,
        rule?.id ?? null,
        JSON.stringify({
          dryRun: false,
          create: 1,
          update: 0,
          delete: 0,
          unchanged: 4,
          failed: 0,
        }),
        new Date(Date.now() - 21 * 3_600_000).toISOString(),
      )
      .run();
    const mirroring = rowStatus(await (await get("/mirroring", cookie)).text(), `row-m-${a}~${z}`);
    // The control: the Mirroring page calls it a delay.
    expect(mirroring.tone).toBe("warn");
    expect(mirroring.words).not.toBe("");
    const calendars = await (await get("/calendars", cookie)).text();
    // The target says what the mirroring into it says.
    expect(rowStatus(calendars, `row-c-${z}`)).toEqual(mirroring);
    // The source does not take the delay of its target: no mirroring into it runs, so it shows
    // the latest runs into it, which are none.
    expect(rowStatus(calendars, `row-c-${a}`)).not.toEqual(mirroring);
    expect(rowStatus(calendars, `row-c-${a}`).words).toBe(en.next.shell.run.noRun);
    // The panel head too.
    const panel = await (await get(`/calendars?c=${z}`, cookie)).text();
    const meta = panel.slice(panel.indexOf('<p class="detail-meta">'));
    expect(statusOf(meta.slice(0, meta.indexOf("</p>")))).toEqual(mirroring);
  });

  it("stays as before for a calendar without a running mirroring", async () => {
    const { cookie, z } = await setup("ncal-quiet");
    const html = await (await get("/calendars", cookie)).text();
    expect(rowStatus(html, `row-c-${z}`).words).toBe(en.next.shell.run.noRun);
  });
});

describe("disconnect step in the calendar panel", () => {
  it("shows the step instead of the form, and posts to the disconnect route", async () => {
    const { cookie, z } = await setup("ncal-confirm");
    const html = await (await get(`/calendars?c=${z}&confirm=disconnect`, cookie)).text();
    const step = en.next.auth.disconnect;
    expect(html).toContain('class="confirm-step"');
    expect(html).toContain(step.title);
    expect(html).toContain(step.mirrorings(0));
    expect(html).toContain(step.confirm);
    expect(html).toMatch(
      new RegExp(
        `<form[^>]*action="/accounts/${z}/disconnect"[^>]*>[\\s\\S]*name="back" value="/calendars"`,
      ),
    );
    expect(html).toContain('class="btn btn-danger"');
    // The cancel link returns to the panel as it was, and the save form is not on the page.
    expect(html).toContain(`href="/calendars?c=${z}"`);
    expect(html).not.toContain(`action="/calendars/${z}"`);
    expect(html).not.toContain("data-savebar");
  });

  it("counts the mirrorings that the calendar is part of, in German too", async () => {
    const { user, cookie, z, a } = await setup("ncal-confirm-n");
    await setDirection(env, user, z, a, "busy");
    const html = await (await get(`/calendars?c=${z}&confirm=disconnect`, cookie, "de")).text();
    expect(html).toContain(de.next.auth.disconnect.mirrorings(1));
    expect(html).toContain(de.next.auth.disconnect.confirm);
  });

  it("shows the normal panel for any other value and while a refusal is shown", async () => {
    const { cookie, z } = await setup("ncal-confirm-other");
    const other = await (await get(`/calendars?c=${z}&confirm=revoke`, cookie)).text();
    expect(other).not.toContain('class="confirm-step"');
    expect(other).toContain(`action="/calendars/${z}"`);
  });

  it("disconnects and returns to the page named by back, or to the home page without one", async () => {
    const { cookie, z, a } = await setup("ncal-confirm-post");
    const done = await post(
      `/accounts/${z}/disconnect`,
      cookie,
      new URLSearchParams({ back: "/calendars" }),
    );
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe("/calendars");
    const gone = await get(`/calendars?c=${z}`, cookie);
    expect(await gone.text()).toContain(en.next.calendars.gone);
    const foreign = await post(
      `/accounts/${a}/disconnect`,
      cookie,
      new URLSearchParams({ back: "https://evil.example/" }),
    );
    expect(foreign.status).toBe(302);
    expect(foreign.headers.get("location")).toBe("/");
  });
});
