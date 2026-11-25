import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ORG_ID } from "../src/access";
import { activityPageQuery, userActivityPage } from "../src/audit";
import { de } from "../src/i18n/de";
import { en } from "../src/i18n/en";
import { BASE, signIn } from "./helpers";

const ADMIN = "admin@example.com";

function get(path: string, cookie: string, language = "en") {
  return exports.default.fetch(`${BASE}${path}`, {
    headers: { cookie, "accept-language": language },
    redirect: "manual",
  });
}

function post(path: string, cookie: string, fields: Record<string, string>) {
  return exports.default.fetch(`${BASE}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM api_tokens"),
    env.DB.prepare("UPDATE orgs SET mcp_for_members = 'all' WHERE id = ?").bind(DEFAULT_ORG_ID),
  ]);
});

describe("panel markup that the script relies on", () => {
  it("marks the new-token form as a foreground save and the secret panel as Escape-proof", async () => {
    const { cookie } = await signIn("owner@example.com");
    const form = await (await get("/tokens?new=1", cookie)).text();
    expect(form).toMatch(/<form class="detail-form"[^>]*data-save-mode="foreground"/);
    expect(form).not.toContain('data-escape="off"');

    const created = await post("/tokens", cookie, { name: "laptop", days: "7" });
    expect(created.status).toBe(200);
    const html = await created.text();
    expect(html).toContain("sm_pat_");
    expect(html).toMatch(/<aside class="detail"[^>]*data-escape="off"/);
    expect(html).not.toContain('<form class="detail-form"');
  });

  it("leaves forms with a redirect on success as background-saveable", async () => {
    const { cookie } = await signIn("owner@example.com");
    const html = await (await get("/mirroring?d=all", cookie)).text();
    expect(html).toContain('<form class="detail-form"');
    expect(html).not.toContain("data-save-mode");
    // The same `back` value that the server redirects to carries the saved mark.
    expect(html).toContain('name="back" value="/mirroring?d=all&amp;saved=1"');
  });

  it("renders both save refusals, in the language of the page", async () => {
    const { cookie } = await signIn("owner@example.com");
    for (const [language, panel] of [
      ["en", en.next.shell.panel],
      ["de", de.next.shell.panel],
    ] as const) {
      const html = await (await get("/mirroring?d=all", cookie, language)).text();
      expect(html).toMatch(
        new RegExp(`data-save-error="failed"[^>]*hidden[^>]*>\\s*${panel.saveFailed}`),
      );
      expect(html).toMatch(
        new RegExp(`data-save-error="session"[^>]*hidden[^>]*>\\s*${panel.sessionEnded}`),
      );
    }
    expect(en.next.shell.panel.saveFailed).toBe("Could not save. Your changes are still here.");
  });
});

describe("an audit kind that the catalog does not know", () => {
  async function insert(userId: string, kind: string) {
    await env.DB.prepare(
      `INSERT INTO audit_events (org_id, user_id, kind, detail, created_at)
       VALUES ('default', ?, ?, '{}', ?)`,
    )
      .bind(userId, kind, new Date().toISOString())
      .run();
  }

  it.each([["/activity"], ["/activity?scope=org"], ["/admin?tab=health"]])(
    "shows %s with a neutral title and the raw kind as a hint",
    async (path) => {
      const { cookie, user } = await signIn(ADMIN);
      for (const kind of ["feed_created", "user_provisioned"]) await insert(user.id, kind);
      for (const [language, other] of [
        ["en", en.next.describe.activity.otherKind],
        ["de", de.next.describe.activity.otherKind],
      ] as const) {
        const response = await get(path, cookie, language);
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain(`title="user_provisioned"`);
        expect(html).toContain(`title="feed_created"`);
        expect(html).toMatch(new RegExp(`act-title"[^>]*>\\s*${other}\\s*<`));
        // The raw kind is a hint only, never the visible text.
        expect(html).not.toMatch(/>\s*user_provisioned\s*</);
      }
    },
  );
});

describe("the activity query with many rules", () => {
  it("binds at most 100 values for 120 rules, as D1 allows", () => {
    const ruleIds = Array.from({ length: 120 }, (_, index) => `rule-${index}`);
    const { sql, binds } = activityPageQuery(
      { userId: "u" },
      { ruleIds, accountId: "acc", before: 5, group: "sync" },
      30,
    );
    expect(sql.match(/\?/g)?.length).toBe(binds.length);
    expect(binds.length).toBeLessThanOrEqual(100);
  });

  it("finds the rows of 120 rules on one calendar and of the account itself", async () => {
    const { user } = await signIn("many-rules@org.example");
    const ruleIds = Array.from({ length: 120 }, (_, index) => `many-${index}`);
    const stamp = Date.parse("2026-11-12T00:00:00.000Z");
    await env.DB.batch(
      [...ruleIds.slice(-2), "other-rule"].map((rule, index) =>
        env.DB.prepare(
          `INSERT INTO audit_events (org_id, user_id, rule_id, kind, detail, created_at)
           VALUES ('default', ?, ?, 'sync_run', '{}', ?)`,
        ).bind(user.id, rule, new Date(stamp + index * 1000).toISOString()),
      ),
    );
    const page = await userActivityPage(env.DB, user.id, { ruleIds, accountId: "none" });
    expect(page.rows.map((row) => row.ruleId)).toEqual(["many-119", "many-118"]);
  });

  it("keeps the index of the user in the plan of the real query", async () => {
    const ruleIds = Array.from({ length: 120 }, (_, index) => `plan-${index}`);
    const { sql, binds } = activityPageQuery(
      { userId: "u" },
      { ruleIds, accountId: "acc", before: 5 },
      30,
    );
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(...binds)
      .all<{ detail: string }>();
    const plan = results.map((row) => row.detail).join("\n");
    expect(plan).toMatch(/SEARCH audit_events USING (COVERING )?INDEX audit_events_user_created/);
    expect(plan).not.toMatch(/^\s*SCAN audit_events/m);
  });
});
