import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { recordAudit } from "../src/audit";
import { setDirection } from "../src/editor";
import { BASE, signIn } from "./helpers";

const get = (path: string, cookie: string) =>
  exports.default.fetch(`${BASE}${path}`, { headers: { cookie }, redirect: "manual" });

const PAGES = ["/admin", "/admin?tab=health", "/admin?tab=access", "/tokens", "/activity"];

async function twoCalendars(userId: string, prefix: string) {
  const ids = [`${prefix}-a`, `${prefix}-b`];
  for (const id of ids) {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, 'microsoft', ?)",
      ).bind(id, userId, `${id}@work.example`),
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, ?, 'Main', 1, 1, 1)",
      ).bind(`${id}-cal`, id, `${id}-remote`),
    ]);
  }
  return ids as [string, string];
}

/** The nav entry's link, up to its closing tag. */
const navEntry = (html: string, id: string) =>
  new RegExp(`<a[^>]*href="/${id}"[^>]*>[\\s\\S]*?</a>`).exec(html)?.[0] ?? "";

describe("nav attention on Admin, API tokens and Activity", () => {
  it("shows no dot while nothing needs attention", async () => {
    const { cookie } = await signIn("admin@example.com");
    for (const path of PAGES) {
      const response = await get(path, cookie);
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).not.toContain("nav-attention");
    }
  });

  it("shows the Mirroring dot after a failed mirroring and the Calendars dot after a lost connection", async () => {
    const { user, cookie } = await signIn("admin@example.com");
    const [a, b] = await twoCalendars(user.id, "att");
    await setDirection(env, user, a, b, "busy");
    const rule = await env.DB.prepare("SELECT id FROM rules WHERE user_id = ? LIMIT 1")
      .bind(user.id)
      .first<{ id: string }>();
    await recordAudit(env.DB, {
      orgId: user.orgId,
      userId: user.id,
      accountId: b,
      ruleId: rule!.id,
      kind: "sync_failed",
      detail: { code: "graph_500" },
    });
    for (const path of PAGES) {
      const html = await (await get(path, cookie)).text();
      expect(navEntry(html, "mirroring"), path).toContain("nav-attention");
      expect(navEntry(html, "calendars"), path).not.toContain("nav-attention");
    }

    await env.DB.prepare("UPDATE accounts SET needs_reconnect = 1 WHERE id = ?").bind(a).run();
    for (const path of PAGES) {
      const html = await (await get(path, cookie)).text();
      expect(navEntry(html, "calendars"), path).toContain("nav-attention");
    }
  });
});
