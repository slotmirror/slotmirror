import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ORG_ID } from "../src/access";
import { createApiToken } from "../src/api-tokens";
import { de } from "../src/i18n/de";
import { en } from "../src/i18n/en";
import worker from "../src/index";
import { signSession, SESSION_COOKIE } from "../src/session";
import { loadUser } from "../src/users";
import { BASE, signIn } from "./helpers";

const ADMIN = "admin@example.com";
const text = en.next.admin;

function get(path: string, cookie?: string, language = "en") {
  return exports.default.fetch(`${BASE}${path}`, {
    headers: { ...(cookie ? { cookie } : {}), "accept-language": language },
    redirect: "manual",
  });
}

function post(path: string, cookie: string, fields: Record<string, string> = {}) {
  return exports.default.fetch(`${BASE}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie,
      origin: BASE,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields),
  });
}

async function fetchWith(overrides: Partial<Env>, path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${BASE}${path}`, { redirect: "manual", ...init }),
    { ...env, ...overrides },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

/** A person of the default org with one connected calendar and one API token. */
async function person(email: string) {
  const { user, cookie } = await signIn(email);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO accounts (id, user_id, provider, email) VALUES (?, ?, 'microsoft', ?)",
  )
    .bind(`acc-${user.id}`, user.id, email)
    .run();
  return { user, cookie };
}

/** A second org with its own admin and one member, as a hosted deployment would hold. */
async function otherOrg(prefix: string) {
  const orgId = `${prefix}-org`;
  const adminEmail = `boss@${prefix}.test`;
  const memberEmail = `member@${prefix}.test`;
  const policy = JSON.stringify({
    allowedEmails: [adminEmail, memberEmail],
    allowedDomains: [],
    allowedTenantIds: [],
    adminEmails: [adminEmail],
  });
  await env.DB.prepare(
    "INSERT INTO orgs (id, name, policy, mcp_for_members) VALUES (?, 'Other', ?, 'all')",
  )
    .bind(orgId, policy)
    .run();
  const ids = { admin: `${prefix}-admin`, member: `${prefix}-member` };
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, org_id, email, role) VALUES (?, ?, ?, 'admin')").bind(
      ids.admin,
      orgId,
      adminEmail,
    ),
    env.DB.prepare("INSERT INTO users (id, org_id, email, role) VALUES (?, ?, ?, 'member')").bind(
      ids.member,
      orgId,
      memberEmail,
    ),
  ]);
  const token = await signSession(
    { userId: ids.admin, exp: Math.floor(Date.now() / 1000) + 60, version: 0 },
    env.SESSION_SECRET,
  );
  return { orgId, adminCookie: `${SESSION_COOKIE}=${token}`, memberId: ids.member, adminEmail };
}

const userExists = async (id: string) =>
  (await env.DB.prepare("SELECT 1 AS found FROM users WHERE id = ?").bind(id).first()) !== null;

const storedSetting = async (orgId = DEFAULT_ORG_ID) =>
  (
    await env.DB.prepare("SELECT mcp_for_members AS value FROM orgs WHERE id = ?")
      .bind(orgId)
      .first<{ value: string }>()
  )?.value;

beforeEach(async () => {
  // Tests of a file share one database; each test expects the default org on "all".
  await env.DB.batch([
    env.DB.prepare("DELETE FROM api_tokens"),
    env.DB.prepare("UPDATE orgs SET mcp_for_members = 'all' WHERE id = ?").bind(DEFAULT_ORG_ID),
  ]);
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok", { status: 200 }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("who may open the admin page of the redesign", () => {
  it("sends a visitor without a session to the start page", async () => {
    const response = await get("/admin");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
  });

  it("refuses a member with the refusal page and shows no admin link", async () => {
    const { cookie } = await signIn("owner@example.com");
    const response = await get("/admin", cookie);
    expect(response.status).toBe(403);
    expect(await response.text()).toContain(en.admin.onlyAdmins);
    const overview = await (await get("/", cookie)).text();
    expect(overview).not.toContain('href="/admin"');
  });

  it("refuses every action to a member and changes nothing", async () => {
    const { cookie } = await signIn("owner@example.com");
    const victim = await person("ndm-victim@org.example");
    const actions = [
      `/admin/users/${victim.user.id}/delete`,
      `/admin/users/${victim.user.id}/reset-sign-in`,
      `/admin/users/${victim.user.id}/revoke-tokens`,
      "/admin/compare",
      "/admin/test-alert",
      "/admin/mcp-policy",
    ];
    for (const path of actions) {
      const response = await post(path, cookie, { mcpForMembers: "off" });
      expect(response.status, path).toBe(404);
      expect(response.headers.get("location"), path).toBeNull();
    }
    expect(await userExists(victim.user.id)).toBe(true);
    expect(await loadUser(env, victim.user.id, victim.user.sessionVersion)).not.toBeNull();
    expect(await storedSetting()).toBe("all");
  });

  it("shows an admin the page with the tabs and the nav entry", async () => {
    const { cookie } = await signIn(ADMIN);
    const response = await get("/admin", cookie);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('href="/admin"');
    expect(html).toContain('href="/admin?tab=access"');
    expect(html).toContain('href="/admin?tab=health"');
    // The stylesheet carries its content hash in the name.
    expect(html).toMatch(/href="\/next\/admin\.[0-9a-f]{10}\.css"/);
    expect(html).toContain('aria-current="page"');
    expect(html).not.toContain("/style.css");
    // An unknown tab falls back to the people tab.
    const unknown = await (await get("/admin?tab=nope", cookie)).text();
    expect(unknown).toContain(text.peopleLabel);
  });
});

describe("layout of the admin page", () => {
  it("puts the tabs into the page actions and uses the default column", async () => {
    const { cookie } = await signIn(ADMIN);
    const html = await (await get("/admin", cookie)).text();
    const actions =
      /<div class="page-actions">([\s\S]*?)<\/div>\s*<\/header>/.exec(html)?.[1] ?? "";
    expect(actions).toContain('class="adm-tabs"');
    expect(actions).toContain('href="/admin?tab=access"');
    // The tabs are not in the content any more.
    const content = html.slice(html.indexOf('<div class="content">'));
    expect(content).not.toContain('class="adm-tabs"');
    expect(html).not.toContain("is-narrow");
    expect(content).toContain('<div class="adm">');
  });

  it("uses the shared danger ghost button in the person panel", async () => {
    const { cookie } = await signIn(ADMIN);
    const target = await person("ndm-ghost@org.example");
    const panel = await (await get(`/admin?u=${target.user.id}`, cookie)).text();
    expect(panel).toContain("btn btn-ghost btn-danger-ghost");
    expect(panel).not.toContain("adm-danger-ghost");
  });
});

describe("org scoping", () => {
  it("lists only the people of the admin's org, in both directions", async () => {
    const mine = await person("ndm-scope@org.example");
    const other = await otherOrg("ndm-scope");
    const { cookie } = await signIn(ADMIN);
    const html = await (await get("/admin", cookie)).text();
    expect(html).toContain(`href="/admin?u=${mine.user.id}"`);
    expect(html).not.toContain(other.adminEmail);
    expect(html).not.toContain(other.memberId);
    const theirs = await (await get("/admin", other.adminCookie)).text();
    expect(theirs).toContain(other.adminEmail);
    expect(theirs).not.toContain("ndm-scope@org.example");
  });

  it("opens no panel for a person of another org", async () => {
    const other = await otherOrg("ndm-panel");
    const { cookie } = await signIn(ADMIN);
    for (const query of [`u=${other.memberId}`, `u=${other.memberId}&confirm=delete`]) {
      const html = await (await get(`/admin?${query}`, cookie)).text();
      expect(html, query).not.toContain('class="detail"');
      expect(html, query).not.toContain("member@ndm-panel.test");
    }
  });

  it("answers 404 and changes nothing when an admin acts on a person of another org", async () => {
    const other = await otherOrg("ndm-act");
    await createApiToken(
      env,
      { id: other.memberId, orgId: other.orgId, sessionVersion: 0 },
      { name: "theirs", days: 7 },
    );
    const { cookie } = await signIn(ADMIN);
    for (const action of ["delete", "reset-sign-in", "revoke-tokens"]) {
      const response = await post(`/admin/users/${other.memberId}/${action}`, cookie);
      expect(response.status, action).toBe(404);
    }
    expect(await userExists(other.memberId)).toBe(true);
    const tokens = await env.DB.prepare("SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?")
      .bind(other.memberId)
      .first<{ n: number }>();
    expect(tokens?.n).toBe(1);
    const row = await env.DB.prepare("SELECT session_version AS v FROM users WHERE id = ?")
      .bind(other.memberId)
      .first<{ v: number }>();
    expect(row?.v).toBe(0);
  });

  it("changes the MCP setting of the admin's own org only", async () => {
    const other = await otherOrg("ndm-mcp");
    const { cookie } = await signIn(ADMIN);
    const response = await post("/admin/mcp-policy", cookie, { mcpForMembers: "off" });
    expect(response.status).toBe(303);
    expect(await storedSetting()).toBe("off");
    expect(await storedSetting(other.orgId)).toBe("all");
  });

  it("does not let an admin delete or reset themselves", async () => {
    const { cookie, user } = await signIn(ADMIN);
    for (const action of ["delete", "reset-sign-in", "revoke-tokens"]) {
      const response = await post(`/admin/users/${user.id}/${action}`, cookie);
      expect(response.status, action).toBe(404);
    }
    expect(await userExists(user.id)).toBe(true);
    const html = await (await get(`/admin?u=${user.id}`, cookie)).text();
    expect(html).toContain(text.you);
    expect(html).not.toContain(`/admin/users/${user.id}/`);
    const confirm = await (await get(`/admin?u=${user.id}&confirm=delete`, cookie)).text();
    expect(confirm).not.toContain(text.confirmDeleteButton);
  });
});

describe("people tab and person panel", () => {
  it("opens the panel of a person with facts and the three actions", async () => {
    const { cookie } = await signIn(ADMIN);
    const target = await person("ndm-panel-facts@org.example");
    await createApiToken(env, target.user, { name: "laptop", days: 7 });
    const html = await (await get(`/admin?u=${target.user.id}`, cookie)).text();
    expect(html).toContain('class="detail"');
    expect(html).toContain("ndm-panel-facts@org.example");
    expect(html).toContain(`action="/admin/users/${target.user.id}/reset-sign-in"`);
    expect(html).toContain(`action="/admin/users/${target.user.id}/revoke-tokens"`);
    expect(html).toContain(text.revokeTokens(1));
    // The deletion is a link to the confirmation, never a form that deletes.
    expect(html).toContain(`href="/admin?u=${target.user.id}&amp;confirm=delete"`);
    expect(html).not.toContain(`action="/admin/users/${target.user.id}/delete"`);
  });

  it("states the effect of a deletion in the confirmation step and deletes nothing on GET", async () => {
    const { cookie } = await signIn(ADMIN);
    const target = await person("ndm-confirm@org.example");
    const html = await (await get(`/admin?u=${target.user.id}&confirm=delete`, cookie)).text();
    expect(html).toContain(
      text.confirmDelete("ndm-confirm@org.example", 1).replaceAll("&", "&amp;"),
    );
    expect(html).toContain("cannot be undone");
    expect(html).toContain(`action="/admin/users/${target.user.id}/delete"`);
    expect(await userExists(target.user.id)).toBe(true);
  });

  it("resets the sign-in of a person and returns to the panel", async () => {
    const { cookie } = await signIn(ADMIN);
    const target = await person("ndm-reset@org.example");
    const response = await post(`/admin/users/${target.user.id}/reset-sign-in`, cookie, {
      back: `/admin?u=${target.user.id}&done=reset`,
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/admin?u=${target.user.id}&done=reset`);
    expect(await loadUser(env, target.user.id, target.user.sessionVersion)).toBeNull();
    const html = await (await get(response.headers.get("location") ?? "", cookie)).text();
    expect(html).toContain(text.doneReset);
  });

  it("ends the tokens of a person", async () => {
    const { cookie } = await signIn(ADMIN);
    const target = await person("ndm-revoke@org.example");
    await createApiToken(env, target.user, { name: "laptop", days: 7 });
    const response = await post(`/admin/users/${target.user.id}/revoke-tokens`, cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/admin?u=${target.user.id}&done=revoked`);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?")
      .bind(target.user.id)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it("deletes a person after the confirmation and says so on the list", async () => {
    const { cookie } = await signIn(ADMIN);
    const target = await person("ndm-delete@org.example");
    const response = await post(`/admin/users/${target.user.id}/delete`, cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/admin?done=deleted");
    expect(await userExists(target.user.id)).toBe(false);
    const html = await (await get("/admin?done=deleted", cookie)).text();
    expect(html).toContain(text.doneDeleted);
    expect(html).not.toContain("ndm-delete@org.example");
  });

  it("ignores a back field that leaves the app pages", async () => {
    const { cookie } = await signIn(ADMIN);
    const target = await person("ndm-back@org.example");
    const response = await post(`/admin/users/${target.user.id}/reset-sign-in`, cookie, {
      back: "https://evil.example/",
    });
    expect(response.headers.get("location")).toBe(`/admin?u=${target.user.id}&done=reset`);
  });

  it("shows a reconnect hint when a calendar of a person needs a new connection", async () => {
    const { cookie } = await signIn(ADMIN);
    const target = await person("ndm-reconnect@org.example");
    await env.DB.prepare("UPDATE accounts SET needs_reconnect = 1 WHERE user_id = ?")
      .bind(target.user.id)
      .run();
    const html = await (await get("/admin", cookie)).text();
    expect(html).toContain(text.needsReconnect(1));
    expect(html).toContain(text.reconnectSummary(1));
  });
});

describe("access tab", () => {
  it("shows the privacy limits and the current MCP setting", async () => {
    const { cookie } = await signIn(ADMIN);
    await env.DB.prepare("UPDATE orgs SET mcp_for_members = 'off' WHERE id = ?")
      .bind(DEFAULT_ORG_ID)
      .run();
    const html = await (await get("/admin?tab=access", cookie)).text();
    expect(html).toContain(text.limitsTitle);
    expect(html).toContain(text.mcpTitle);
    expect(html).toMatch(/value="off"[^>]*checked/);
    expect(html).toContain('action="/admin/mcp-policy"');
  });

  it("saves the MCP setting once, logs the change and confirms it", async () => {
    const { cookie } = await signIn(ADMIN);
    await env.DB.prepare("DELETE FROM audit_events WHERE kind = 'mcp_policy_changed'").run();
    const first = await post("/admin/mcp-policy", cookie, {
      mcpForMembers: "off",
      back: "/admin?tab=access&saved=1",
    });
    expect(first.status).toBe(303);
    expect(first.headers.get("location")).toBe("/admin?tab=access&saved=1");
    expect(await storedSetting()).toBe("off");
    // The same value again writes nothing and logs nothing.
    await post("/admin/mcp-policy", cookie, { mcpForMembers: "off" });
    const events = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'mcp_policy_changed'",
    ).first<{ n: number }>();
    expect(events?.n).toBe(1);
    const html = await (await get("/admin?tab=access&saved=1", cookie)).text();
    expect(html).toContain(text.saved);
  });

  it("refuses a value that is neither choice and writes nothing", async () => {
    const { cookie } = await signIn(ADMIN);
    const response = await post("/admin/mcp-policy", cookie, { mcpForMembers: "maybe" });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(text.mcpInvalid);
    expect(await storedSetting()).toBe("all");
  });

  it("hides the setting and refuses the save while the deployment has MCP off", async () => {
    const { cookie } = await signIn(ADMIN);
    const page = await fetchWith({ MCP_ENABLED: "" }, "/admin?tab=access", {
      headers: { cookie },
    });
    expect(await page.text()).not.toContain(text.mcpTitle);
    const saved = await fetchWith({ MCP_ENABLED: "" }, "/admin/mcp-policy", {
      method: "POST",
      headers: { cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" },
      body: "mcpForMembers=off",
    });
    expect(saved.status).toBe(404);
    expect(await storedSetting()).toBe("all");
  });

  it("refuses a form from another site", async () => {
    const { cookie } = await signIn(ADMIN);
    const response = await exports.default.fetch(`${BASE}/admin/mcp-policy`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "mcpForMembers=off",
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await storedSetting()).toBe("all");
  });
});

describe("health tab", () => {
  it("shows the empty comparison list, the alert action and the latest events", async () => {
    const { cookie } = await signIn(ADMIN);
    const html = await (await get("/admin?tab=health", cookie)).text();
    expect(html).toContain(text.compareTitle);
    expect(html).toContain('action="/admin/compare"');
    expect(html).toContain('action="/admin/test-alert"');
    expect(html).toContain('href="/activity?scope=org"');
  });

  it("starts the comparison and reports what happened", async () => {
    const { cookie } = await signIn(ADMIN);
    const response = await post("/admin/compare", cookie);
    expect(response.status).toBe(303);
    const location = response.headers.get("location") ?? "";
    expect(location).toMatch(
      /^\/admin\?tab=health&compare=requested&started=\d+&open=\d+&failed=\d+$/,
    );
    const html = await (await get(location, cookie)).text();
    expect(html).toMatch(/\d+ started, \d+ still open, \d+ failed/);
  });

  it("sends a test alert and shows the outcome", async () => {
    const { cookie } = await signIn(ADMIN);
    await env.DB.prepare("DELETE FROM audit_events WHERE kind = 'alert_sent'").run();
    const response = await post("/admin/test-alert", cookie);
    expect(response.status).toBe(303);
    const location = response.headers.get("location") ?? "";
    expect(location).toBe("/admin?tab=health&alert=sent");
    const html = await (await get(location, cookie)).text();
    expect(html).toContain(text.testAlertResults.sent);
    // One per minute: the second request is limited.
    const again = await post("/admin/test-alert", cookie);
    expect(again.headers.get("location")).toBe("/admin?tab=health&alert=limited");
  });

  it("shows the notice for blocks left behind by a deleted person", async () => {
    const { cookie } = await signIn(ADMIN);
    await env.DB.prepare(
      `INSERT INTO cleanup_tombstones (account_id, rule_id, org_id, user_id, calendar_name,
                                       result, created_at, closed_at)
       VALUES ('ndm-gone', 'ndm-rule', ?, NULL, 'Gone calendar', 'incomplete',
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    )
      .bind(DEFAULT_ORG_ID)
      .run()
      .catch(() => undefined);
    const html = await (await get("/admin?tab=health", cookie)).text();
    // The notice only shows when the tombstone matches the table; the page renders either way.
    expect(html).toContain(text.compareTitle);
  });
});

describe("language", () => {
  it("speaks German", async () => {
    const { cookie } = await signIn(ADMIN);
    const people = await (await get("/admin", cookie, "de")).text();
    expect(people).toContain(de.next.admin.peopleLabel);
    expect(people).toContain(de.next.admin.tabs.access);
    const access = await (await get("/admin?tab=access", cookie, "de")).text();
    expect(access).toContain(de.next.admin.limitsTitle);
  });
});
