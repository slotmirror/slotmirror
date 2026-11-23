import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { BASE, signIn } from "./helpers";

const OTHER_EMAIL = "p@org-p.test";
const OTHER_CODE = "org-isolation-secret";

function get(path: string, cookie: string) {
  return exports.default.fetch(`${BASE}${path}`, { headers: { cookie } });
}

/** A second org with one user and one failed sync, newer than anything the first org has. */
async function addOtherOrg() {
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO orgs (id, name) VALUES ('org-p', 'P')"),
    env.DB.prepare(
      "INSERT OR IGNORE INTO users (id, org_id, email, role) VALUES ('user-p', 'org-p', ?, 'member')",
    ).bind(OTHER_EMAIL),
    env.DB.prepare(
      `INSERT INTO audit_events (org_id, user_id, kind, detail, created_at)
       VALUES ('org-p', 'user-p', 'sync_failed', ?, '2031-01-01T00:00:00.000Z')`,
    ).bind(JSON.stringify({ code: OTHER_CODE })),
  ]);
}

describe("another org stays out of the org views", () => {
  beforeEach(addOtherOrg);

  it("shows no event of another org on /activity?scope=org", async () => {
    const admin = await signIn("admin@example.com");
    const response = await get("/activity?scope=org", admin.cookie);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain(OTHER_EMAIL);
    expect(html).not.toContain(OTHER_CODE);
  });

  it("shows no event of another org on /admin?tab=health", async () => {
    const admin = await signIn("admin@example.com");
    const response = await get("/admin?tab=health", admin.cookie);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain(OTHER_EMAIL);
    expect(html).not.toContain(OTHER_CODE);
  });
});
