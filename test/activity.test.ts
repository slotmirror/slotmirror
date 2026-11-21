import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { de } from "../src/i18n/de";
import { en } from "../src/i18n/en";
import { BASE, signIn } from "./helpers";

async function addEvent(orgId: string, userId: string | null, kind: string, detail = "{}") {
  await env.DB.prepare(
    "INSERT INTO audit_events (org_id, user_id, kind, detail) VALUES (?, ?, ?, ?)",
  )
    .bind(orgId, userId, kind, detail)
    .run();
}

async function get(path: string, cookie: string): Promise<Response> {
  return exports.default.fetch(`${BASE}${path}`, { headers: { cookie } });
}

describe("activity", () => {
  // The page of the app is tested in `next-activity.test.ts`. These cases keep what no other file
  // pins: the words for an alert in both languages, and the refusal of the admin page for members.
  it("describes the reason of an alert, in every language", async () => {
    const owner = await signIn("owner@example.com");
    const codes = ["rule_silent", "run_aborted", "check_blind"] as const;
    for (const code of codes) {
      await addEvent("default", owner.user.id, "alert_sent", JSON.stringify({ code }));
    }

    for (const [lang, messages] of [
      ["en", en],
      ["de", de],
    ] as const) {
      const html = await (await get(`/activity?lang=${lang}`, owner.cookie)).text();
      for (const code of codes) {
        expect(html).toContain(messages.next.describe.activity.detail.alerts[code]);
        expect(html).not.toContain(`<td>${code}</td>`);
      }
    }
  });

  it("hides the org-wide table from members", async () => {
    const owner = await signIn("owner@example.com");
    expect((await get("/admin", owner.cookie)).status).toBe(403);
    expect((await get("/activity?scope=org", owner.cookie)).status).toBe(404);
  });
});
