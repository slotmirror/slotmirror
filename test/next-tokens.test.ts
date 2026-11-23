import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ORG_ID } from "../src/access";
import {
  authenticateToken,
  createApiToken,
  listApiTokens,
  MAX_TOKENS_PER_USER,
} from "../src/api-tokens";
import { de } from "../src/i18n/de";
import { en } from "../src/i18n/en";
import worker from "../src/index";
import { BASE, signIn } from "./helpers";

const text = en.next.tokens;
const MEMBER = "owner@example.com";
const ADMIN = "admin@example.com";

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

const TOKEN_PATTERN = /sm_pat_[A-Za-z0-9_-]{43}/;

/** A connected app of a user, as the OAuth exchange leaves it. */
async function connectApp(userId: string, name: string): Promise<string> {
  const clientId = crypto.randomUUID();
  const grantId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO oauth_clients (id, name, redirect_uris) VALUES (?, ?, '[\"http://127.0.0.1/cb\"]')",
    ).bind(clientId, name),
    env.DB.prepare(
      `INSERT INTO oauth_grants (id, client_id, user_id, scope, resource, session_version,
                                 refresh_hash, refresh_expires_at, expires_at)
       SELECT ?, ?, id, 'mcp:read', 'r', session_version, ?, '2099-01-01', '2099-01-01'
       FROM users WHERE id = ?`,
    ).bind(grantId, clientId, `hash-${grantId}`, userId),
  ]);
  return grantId;
}

const grantExists = async (id: string) =>
  (await env.DB.prepare("SELECT 1 AS found FROM oauth_grants WHERE id = ?").bind(id).first()) !==
  null;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM api_tokens"),
    env.DB.prepare("DELETE FROM oauth_grants"),
    env.DB.prepare("DELETE FROM oauth_clients"),
    env.DB.prepare("DELETE FROM api_usage"),
    env.DB.prepare("UPDATE orgs SET mcp_for_members = 'all' WHERE id = ?").bind(DEFAULT_ORG_ID),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("who may open the tokens page of the redesign", () => {
  it("sends a visitor without a session to the start page", async () => {
    const response = await get("/tokens");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
  });

  it("answers 404 for every route while MCP_ENABLED is off, and hides the link", async () => {
    const { cookie, user } = await signIn(MEMBER);
    const created = await createApiToken(env, user, { name: "laptop", days: 7 });
    expect(created).not.toBeNull();
    const [row] = await listApiTokens(env.DB, user.id);
    const id = row?.id ?? "";
    const headers = { cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" };
    for (const [method, path] of [
      ["GET", "/tokens"],
      ["POST", "/tokens"],
      ["POST", `/tokens/${id}/revoke`],
      ["POST", `/tokens/apps/${crypto.randomUUID()}/revoke`],
    ] as const) {
      const response = await fetchWith({ MCP_ENABLED: "" }, path, {
        method,
        headers,
        body: method === "POST" ? "name=x&days=7" : undefined,
      });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    // Nothing was revoked by the refused request.
    expect(await listApiTokens(env.DB, user.id)).toHaveLength(1);
    const overview = await fetchWith({ MCP_ENABLED: "" }, "/", { headers: { cookie } });
    expect(await overview.text()).not.toContain('href="/tokens"');
  });

  it("links the page in the lower group while MCP_ENABLED is on", async () => {
    const { cookie } = await signIn(MEMBER);
    const html = await (await get("/", cookie)).text();
    expect(html).toContain('href="/tokens"');
  });

  it("lets a member see and revoke, but not create, while the org has MCP off", async () => {
    const { user } = await signIn(MEMBER);
    const created = await createApiToken(env, user, { name: "laptop", days: 7 });
    expect(created).not.toBeNull();
    await env.DB.prepare("UPDATE orgs SET mcp_for_members = 'off' WHERE id = ?")
      .bind(DEFAULT_ORG_ID)
      .run();
    const { cookie: offCookie, user: offUser } = await signIn(MEMBER);
    const html = await (await get("/tokens", offCookie)).text();
    expect(html).toContain(text.membersOff);
    expect(html).not.toContain('href="/tokens?new=1"');
    const refused = await post("/tokens", offCookie, { name: "again", days: "7" });
    expect(refused.status).toBe(404);
    expect(await listApiTokens(env.DB, offUser.id)).toHaveLength(1);
    // Revoking gives up access, so it stays.
    const [row] = await listApiTokens(env.DB, offUser.id);
    const revoked = await post(`/tokens/${row?.id}/revoke`, offCookie);
    expect(revoked.status).toBe(303);
    expect(await listApiTokens(env.DB, offUser.id)).toHaveLength(0);
  });

  it("shows an empty list with the way to a first token", async () => {
    const { cookie } = await signIn(MEMBER);
    const html = await (await get("/tokens", cookie)).text();
    expect(html).toContain(text.tokensEmpty);
    expect(html).toContain(text.appsEmpty);
    expect(html).toContain('href="/tokens?new=1"');
  });
});

describe("creating a token", () => {
  it("opens the form in the panel", async () => {
    const { cookie } = await signIn(MEMBER);
    const html = await (await get("/tokens?new=1", cookie)).text();
    expect(html).toContain('class="detail"');
    expect(html).toContain('action="/tokens"');
    expect(html).toContain('name="name"');
    expect(html).toContain('name="days"');
    expect(html).toContain(text.limitsHint(MAX_TOKENS_PER_USER, 1000));
  });

  it("shows the token once, in a copyable field, and never again", async () => {
    const { cookie, user } = await signIn(MEMBER);
    const logs = ["log", "info", "warn", "error", "debug"].map((level) =>
      vi.spyOn(console, level as "log").mockImplementation(() => undefined),
    );
    const created = await post("/tokens", cookie, { name: "laptop", days: "30" });
    expect(created.status).toBe(200);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const html = await created.text();
    const token = TOKEN_PATTERN.exec(html)?.[0] ?? "";
    expect(token).not.toBe("");
    // The token and the command that carries it are the only places, in monospace fields.
    expect(html).toContain(text.createdTitle);
    expect(html).toContain("You will not see it again");
    expect(html).toContain('id="token-secret"');
    expect(html).toContain('data-copy-target="token-secret"');
    expect(html).toContain(`Authorization: Bearer ${token}`);
    expect(html).toContain(`${BASE}/mcp`);
    expect(await authenticateToken(env, `Bearer ${token}`)).not.toBeNull();

    // No later page holds the value, only its end.
    const [row] = await listApiTokens(env.DB, user.id);
    for (const path of ["/tokens", `/tokens?k=${row?.id}`, "/tokens?new=1"]) {
      const later = await (await get(path, cookie)).text();
      expect(later, path).not.toContain(token);
      expect(later, path).not.toContain("sm_pat_");
    }
    const list = await (await get("/tokens", cookie)).text();
    expect(list).toContain(`…${token.slice(-4)}`);

    // Storage holds a hash; no log line holds the token.
    const stored = await env.DB.prepare("SELECT * FROM api_tokens WHERE user_id = ?")
      .bind(user.id)
      .first<Record<string, unknown>>();
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(stored?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    for (const spy of logs) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(token);
    }
    const audit = await env.DB.prepare(
      "SELECT detail FROM audit_events WHERE kind = 'api_token_created'",
    ).all<{ detail: string }>();
    expect(JSON.stringify(audit.results)).not.toContain(token);
  });

  it("refuses an empty name, an unknown lifetime and a long name, and keeps the input", async () => {
    const { cookie, user } = await signIn(MEMBER);
    const cases: Record<string, string>[] = [
      { name: "  ", days: "30" },
      { name: "laptop", days: "365" },
      { name: "x".repeat(65), days: "30" },
    ];
    for (const fields of cases) {
      const response = await post("/tokens", cookie, fields);
      expect(response.status, JSON.stringify(fields)).toBe(400);
      const html = await response.text();
      expect(html).toContain(text.invalid);
      expect(html).not.toMatch(TOKEN_PATTERN);
    }
    const kept = await post("/tokens", cookie, { name: "my laptop", days: "365" });
    expect(await kept.text()).toMatch(/name="name"[^>]*value="my laptop"/);
    expect(await listApiTokens(env.DB, user.id)).toHaveLength(0);
  });

  it("refuses a token above the limit of active tokens with 409", async () => {
    const { cookie, user } = await signIn(MEMBER);
    for (let i = 0; i < MAX_TOKENS_PER_USER; i++) {
      expect(await createApiToken(env, user, { name: `t${i}`, days: 7 })).not.toBeNull();
    }
    const response = await post("/tokens", cookie, { name: "one more", days: "7" });
    expect(response.status).toBe(409);
    const html = await response.text();
    expect(html).toContain(text.limitReached);
    expect(html).not.toMatch(TOKEN_PATTERN);
    expect(await listApiTokens(env.DB, user.id)).toHaveLength(MAX_TOKENS_PER_USER);
  });

  it("refuses a form from another site", async () => {
    const { cookie, user } = await signIn(MEMBER);
    const response = await exports.default.fetch(`${BASE}/tokens`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "name=laptop&days=7",
    });
    // The cross-site guard answers, not a handler that failed later.
    expect(response.status).toBe(403);
    expect(await listApiTokens(env.DB, user.id)).toHaveLength(0);
  });
});

describe("token panel and revoke", () => {
  it("lists the tokens of the user and opens the panel of one of them", async () => {
    const { cookie, user } = await signIn(MEMBER);
    await createApiToken(env, user, { name: "laptop", days: 7 });
    const [row] = await listApiTokens(env.DB, user.id);
    const list = await (await get("/tokens", cookie)).text();
    expect(list).toContain(`href="/tokens?k=${row?.id}"`);
    expect(list).not.toContain('class="detail"');
    const html = await (await get(`/tokens?k=${row?.id}`, cookie)).text();
    expect(html).toContain('class="detail"');
    expect(html).toContain(`…${row?.lastFour}`);
    expect(html).toContain(text.readOnly);
    // The revoke button is a link to the confirmation, not a form.
    expect(html).toContain(`href="/tokens?k=${row?.id}&amp;confirm=revoke"`);
    expect(html).not.toContain(`/tokens/${row?.id}/revoke`);
  });

  it("states the effect in the confirmation step and revokes only after the POST", async () => {
    const { cookie, user } = await signIn(MEMBER);
    const created = await createApiToken(env, user, { name: "laptop", days: 7 });
    const [row] = await listApiTokens(env.DB, user.id);
    const html = await (await get(`/tokens?k=${row?.id}&confirm=revoke`, cookie)).text();
    expect(html).toContain(text.confirmRevoke("laptop"));
    expect(html).toContain("cannot be undone");
    expect(html).toContain(`action="/tokens/${row?.id}/revoke"`);
    expect(await listApiTokens(env.DB, user.id)).toHaveLength(1);
    const response = await post(`/tokens/${row?.id}/revoke`, cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/tokens");
    expect(await listApiTokens(env.DB, user.id)).toHaveLength(0);
    expect(await authenticateToken(env, `Bearer ${created?.token}`)).toBeNull();
  });

  it("shows no panel and revokes nothing for the token of another user", async () => {
    const { user: owner } = await signIn("owner@example.com");
    await createApiToken(env, owner, { name: "laptop", days: 7 });
    const [row] = await listApiTokens(env.DB, owner.id);
    const { cookie } = await signIn("ntk-other@org.example");
    const html = await (await get(`/tokens?k=${row?.id}`, cookie)).text();
    expect(html).not.toContain('class="detail"');
    expect(html).not.toContain("laptop");
    await post(`/tokens/${row?.id}/revoke`, cookie);
    expect(await listApiTokens(env.DB, owner.id)).toHaveLength(1);
  });

  it("does not show the tokens of an admin's members to the admin", async () => {
    const { user: member } = await signIn(MEMBER);
    await createApiToken(env, member, { name: "members-laptop", days: 7 });
    const { cookie } = await signIn(ADMIN);
    const html = await (await get("/tokens", cookie)).text();
    expect(html).not.toContain("members-laptop");
  });

  it("marks an expired token", async () => {
    const { cookie, user } = await signIn(MEMBER);
    await createApiToken(env, user, { name: "old", days: 7 });
    await env.DB.prepare(
      "UPDATE api_tokens SET expires_at = '2020-01-01T00:00:00.000Z' WHERE user_id = ?",
    )
      .bind(user.id)
      .run();
    const html = await (await get("/tokens", cookie)).text();
    expect(html).toContain(text.expired);
  });
});

describe("connected apps", () => {
  it("lists apps, opens a panel and disconnects after the confirmation", async () => {
    const { cookie, user } = await signIn(MEMBER);
    const grant = await connectApp(user.id, "Claude");
    const list = await (await get("/tokens", cookie)).text();
    expect(list).toContain(`href="/tokens?a=${grant}"`);
    const panel = await (await get(`/tokens?a=${grant}`, cookie)).text();
    expect(panel).toContain('class="detail"');
    expect(panel).toContain(`href="/tokens?a=${grant}&amp;confirm=disconnect"`);
    const confirm = await (await get(`/tokens?a=${grant}&confirm=disconnect`, cookie)).text();
    expect(confirm).toContain(`action="/tokens/apps/${grant}/revoke"`);
    expect(await grantExists(grant)).toBe(true);
    const response = await post(`/tokens/apps/${grant}/revoke`, cookie);
    expect(response.status).toBe(303);
    expect(await grantExists(grant)).toBe(false);
  });

  it("does not let another user see or disconnect an app", async () => {
    const { user } = await signIn(MEMBER);
    const grant = await connectApp(user.id, "Zed Agent 9");
    const { cookie } = await signIn("ntk-apps-other@org.example");
    const html = await (await get(`/tokens?a=${grant}`, cookie)).text();
    expect(html).not.toContain('class="detail"');
    expect(html).not.toContain("Zed Agent 9");
    await post(`/tokens/apps/${grant}/revoke`, cookie);
    expect(await grantExists(grant)).toBe(true);
  });
});

describe("language", () => {
  it("speaks German", async () => {
    const { cookie } = await signIn(MEMBER);
    const html = await (await get("/tokens?new=1", cookie, "de")).text();
    expect(html).toContain(de.next.tokens.createTitle);
    expect(html).toContain(de.next.tokens.lifetime);
  });
});

describe("tokens and apps that read events", () => {
  it("offers the box unticked in both languages, and says so in the intro", async () => {
    const { cookie } = await signIn(MEMBER);
    for (const [language, messages] of [
      ["en", en],
      ["de", de],
    ] as const) {
      const html = await (await get("/tokens?new=1", cookie, language)).text();
      expect(html).toContain(messages.tokens.events);
      expect(html).toContain(messages.next.tokens.introWithEvents);
      expect(html).not.toContain(messages.next.tokens.intro);
      expect(html).not.toMatch(/name="events"[^>]*checked/);
      const off = await fetchWith({ MCP_EVENTS_ENABLED: "" }, "/tokens?new=1", {
        headers: { cookie, "accept-language": language },
      });
      const offHtml = await off.text();
      expect(offHtml).toContain(messages.next.tokens.intro);
      expect(offHtml).not.toContain(messages.tokens.events);
    }
  });

  it("marks them where a narrow list still shows it, and in their panel", async () => {
    const { cookie, user } = await signIn(MEMBER);
    await createApiToken(env, user, { name: "reader", days: 7, events: true });
    await createApiToken(env, user, { name: "plain", days: 7 });
    const grant = await connectApp(user.id, "Agent");
    const plainGrant = await connectApp(user.id, "Other agent");
    await env.DB.prepare("UPDATE oauth_grants SET scope = 'mcp:read mcp:events' WHERE id = ?")
      .bind(grant)
      .run();
    const tokens = await listApiTokens(env.DB, user.id);
    for (const [query, reads] of [
      ...tokens.map((token) => [`k=${token.id}`, token.name === "reader"] as const),
      [`a=${grant}`, true],
      [`a=${plainGrant}`, false],
    ] as const) {
      const html = await (await get(`/tokens?${query}`, cookie)).text();
      const open = html.indexOf(`href="/tokens?${query}"`);
      const row = html.slice(open, html.indexOf("</li>", open));
      // In the meta: the tags hide below 760 px of list width.
      const meta = row.slice(row.indexOf('class="row-meta"'));
      expect(meta.startsWith('class="row-meta"><span class="adm-scope">'), query).toBe(reads);
      expect(row.includes(en.tokens.readsEvents), query).toBe(reads);
      expect(html.includes(text.readOnlyEvents), query).toBe(reads);
    }
  });

  it("comes back unticked after a refusal", async () => {
    const { cookie, user } = await signIn(MEMBER);
    const response = await post("/tokens", cookie, { name: "", days: "30", events: "1" });
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain('name="events"');
    expect(html).not.toMatch(/name="events"[^>]*checked/);
    expect(await listApiTokens(env.DB, user.id)).toHaveLength(0);
  });

  it("grants events only for the exact value, and follows the gate at the old address", async () => {
    const { cookie, user } = await signIn(MEMBER);
    await post("/tokens", cookie, { name: "odd value", days: "30", events: "on" });
    await fetchWith({ MCP_EVENTS_ENABLED: "" }, "/next/tokens", {
      method: "POST",
      headers: { cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ name: "old off", days: "30", events: "1" }),
    });
    await post("/next/tokens", cookie, { name: "old on", days: "30", events: "1" });
    const listed = await listApiTokens(env.DB, user.id);
    expect(Object.fromEntries(listed.map((token) => [token.name, token.events]))).toEqual({
      "odd value": false,
      "old off": false,
      "old on": true,
    });
  });
});
