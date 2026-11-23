import { appPath } from "../app-base";
import { Hono, type Context } from "hono";
import { alertsConfigured, sendTestAlert, TEST_ALERT_OUTCOMES } from "../alerts";
import {
  createApiToken,
  listApiTokens,
  MAX_TOKEN_NAME_LENGTH,
  revokeApiToken,
  revokeUserTokens,
  TOKEN_DAYS,
} from "../api-tokens";
import type { AppEnv } from "../app-env";
import { latestCompares, orgActivity, ruleOutcomesQuery } from "../audit";
import { runQueries } from "../batch";
import { backPath, readForm } from "../back";
import { appGuard } from "./app-guard";
import { cleanupsOfOthers } from "../cleanup";
import { mcpEnabled, mcpEventsEnabled } from "../config";
import { detailCapsFromEnv } from "../detail-policy";
import { editorQuery } from "../editor";
import { policyFromEnv } from "../access";
import { i18nFromContext } from "../i18n";
import { disconnectApp, listConnectedApps } from "../mcp-oauth";
import {
  adminUsers,
  countParam,
  otherUserOfOrg,
  parseMcpChoice,
  setMcpForMembers,
  startOrgCompares,
} from "../next-admin";
import { deleteUser } from "../offboarding";
import {
  ADMIN_ACTIVITY_ROWS,
  AdminPage,
  adminHref,
  parseAdminDone,
  parseAdminTab,
} from "../pages/next/admin";
import { navAttention } from "../pages/next/run-status";
import { TokensPage } from "../pages/next/tokens";
import { can } from "../permissions";
import { render } from "../render";
import { resetSignInBinding, type SignedInUser } from "../users";

/**
 * The admin and API token pages, mounted by `mountAppPages` below `/admin` and `/tokens`. The
 * routes ask for the actions of `ROUTE_NEEDS`, load through the domain functions and hold no SQL.
 */
export const nextAdmin = new Hono<AppEnv>();
export const nextTokens = new Hono<AppEnv>();

nextAdmin.use("*", appGuard);

function currentUser(c: Context<AppEnv>): SignedInUser {
  const user = c.get("user");
  if (!user) throw new Error("next routes require a user");
  return user;
}

/**
 * The nav dots for a page that loads no editor state of its own: the state and the latest outcomes
 * in one D1 batch, read next to the page's other reads. It writes nothing; the colours that
 * `parseEditorState` assigns stay for the pages of the lists.
 */
async function loadAttention(c: Context<AppEnv>, userId: string) {
  const [loaded, outcomes] = await runQueries(c.env.DB, [
    editorQuery(c.env, userId),
    ruleOutcomesQuery(c.env.DB, userId),
  ]);
  return navAttention(loaded.state, outcomes, Date.now());
}

// Admin -----------------------------------------------------------------------------------------

/** The admin page with the data of its tab. A tab loads only what it shows. */
async function renderAdmin(
  c: Context<AppEnv>,
  extra: { tab?: "access"; invalidChoice?: boolean; saved?: boolean } = {},
  status: 200 | 400 = 200,
) {
  const user = currentUser(c);
  const person = c.req.query("u");
  // A person's panel belongs to the people tab, whatever `tab` says.
  const tab = extra.tab ?? (person ? "people" : parseAdminTab(c.req.query("tab")));
  const [others, attention] = await Promise.all([
    cleanupsOfOthers(c.env.DB, user.orgId),
    loadAttention(c, user.id),
  ]);
  const cleanups = others.left.length;
  const common = { user, tab, cleanups, attention, done: parseAdminDone(c.req.query("done")) };

  if (tab === "access") {
    const policy = policyFromEnv(c.env);
    return render(
      c,
      <AdminPage
        {...common}
        caps={detailCapsFromEnv(c.env)}
        org={{ domains: policy.allowedDomains, tenantCount: policy.allowedTenantIds.length }}
        mcpForMembers={mcpEnabled(c.env) ? user.mcpForMembers : null}
        saved={extra.saved ?? c.req.query("saved") === "1"}
        invalidChoice={extra.invalidChoice}
      />,
      status,
    );
  }

  if (tab === "health") {
    const [compares, activity] = await Promise.all([
      latestCompares(c.env.DB, user.orgId),
      can(user, "org:audit")
        ? orgActivity(c.env.DB, user.orgId, ADMIN_ACTIVITY_ROWS)
        : Promise.resolve([]),
    ]);
    return render(
      c,
      <AdminPage
        {...common}
        compares={compares}
        activity={activity}
        compareStart={
          c.req.query("compare") === "requested"
            ? {
                started: countParam(c.req.query("started")),
                open: countParam(c.req.query("open")),
                failed: countParam(c.req.query("failed")),
              }
            : null
        }
        alertsConfigured={alertsConfigured(c.env)}
        testAlert={TEST_ALERT_OUTCOMES.find((outcome) => outcome === c.req.query("alert")) ?? null}
      />,
      status,
    );
  }

  const users = await adminUsers(c.env.DB, user.orgId);
  const selected = person ? users.find((row) => row.id === person) : undefined;
  const confirm = selected && c.req.query("confirm") === "delete" ? "delete" : undefined;
  return render(
    c,
    <AdminPage {...common} users={users} selected={selected} confirm={confirm} />,
    status,
  );
}

nextAdmin.get("/", (c) => renderAdmin(c));

// A person of the admin's org other than the admin; anything else is a 404, as at the old routes.
nextAdmin.post("/users/:id/delete", async (c) => {
  const user = currentUser(c);
  const form = await readForm(c.req.raw);
  if (!form) return c.text("Bad request", 400);
  const target = await otherUserOfOrg(c.env.DB, user, c.req.param("id"));
  if (!target) return c.notFound();
  await deleteUser(c.env, { id: target.id, orgId: user.orgId }, "admin");
  return c.redirect(backPath(form, adminHref({ done: "deleted" })), 303);
});

nextAdmin.post("/users/:id/reset-sign-in", async (c) => {
  const user = currentUser(c);
  const form = await readForm(c.req.raw);
  if (!form) return c.text("Bad request", 400);
  const target = await otherUserOfOrg(c.env.DB, user, c.req.param("id"));
  if (!target) return c.notFound();
  await resetSignInBinding(c.env, { id: target.id, orgId: user.orgId }, "admin");
  return c.redirect(backPath(form, adminHref({ u: target.id, done: "reset" })), 303);
});

nextAdmin.post("/users/:id/revoke-tokens", async (c) => {
  const user = currentUser(c);
  const form = await readForm(c.req.raw);
  if (!form) return c.text("Bad request", 400);
  const target = await otherUserOfOrg(c.env.DB, user, c.req.param("id"));
  if (!target) return c.notFound();
  await revokeUserTokens(c.env, { id: target.id, orgId: user.orgId }, "admin");
  return c.redirect(backPath(form, adminHref({ u: target.id, done: "revoked" })), 303);
});

// One call per account, as the cron does; the redirect names what happened.
nextAdmin.post("/compare", async (c) => {
  const { started, open, failed } = await startOrgCompares(c.env, currentUser(c).orgId);
  return c.redirect(
    `${appPath("/admin")}?tab=health&compare=requested&started=${started}&open=${open}&failed=${failed}`,
    303,
  );
});

// D1 limits it to one per minute.
nextAdmin.post("/test-alert", async (c) => {
  const user = currentUser(c);
  const outcome = await sendTestAlert(c.env, { orgId: user.orgId, userId: user.id });
  return c.redirect(`${appPath("/admin")}?tab=health&alert=${outcome}`, 303);
});

// Whether members may use MCP. Tokens and apps of members stay while it is off, and stop working.
nextAdmin.post("/mcp-policy", async (c) => {
  const user = currentUser(c);
  if (!mcpEnabled(c.env)) return c.notFound();
  const form = await readForm(c.req.raw);
  if (!form) return c.text("Bad request", 400);
  const choice = parseMcpChoice(form.get("mcpForMembers"));
  if (!choice) return renderAdmin(c, { tab: "access", invalidChoice: true }, 400);
  await setMcpForMembers(c.env, user, choice);
  return c.redirect(backPath(form, `${appPath("/admin")}?tab=access&saved=1`), 303);
});

// API tokens ------------------------------------------------------------------------------------

nextTokens.use("*", async (c, next) => {
  if (!mcpEnabled(c.env)) return c.notFound();
  // A new token stands in the answer to the POST. No cache may keep it.
  c.header("Cache-Control", "no-store");
  await next();
});
nextTokens.use("*", appGuard);

/** Whether a new token may read calendar events, if its user ticks the box. */
function offersEvents(c: Context<AppEnv>, user: SignedInUser): boolean {
  return mcpEventsEnabled(c.env) && can(user, "events:read");
}

function endpoint(c: Context<AppEnv>): string {
  const base = c.env.PUBLIC_URL?.trim().replace(/\/+$/, "") || new URL(c.req.url).origin;
  return `${base}/mcp`;
}

async function renderTokens(
  c: Context<AppEnv>,
  extra: {
    created?: string;
    problem?: string;
    creating?: boolean;
    draft?: { name: string; days: number };
  } = {},
  status: 200 | 400 | 409 = 200,
) {
  const user = currentUser(c);
  const [tokens, apps, attention] = await Promise.all([
    listApiTokens(c.env.DB, user.id),
    listConnectedApps(c.env.DB, user.id),
    loadAttention(c, user.id),
  ]);
  const token = c.req.query("k");
  const app = c.req.query("a");
  const selectedToken = tokens.find((row) => row.id === token);
  const selectedApp = selectedToken ? undefined : apps.find((row) => row.id === app);
  const wanted = c.req.query("confirm");
  const confirm =
    selectedToken && wanted === "revoke"
      ? "revoke"
      : selectedApp && wanted === "disconnect"
        ? "disconnect"
        : undefined;
  return render(
    c,
    <TokensPage
      user={user}
      attention={attention}
      tokens={tokens}
      apps={apps}
      endpoint={endpoint(c)}
      canCreate={can(user, "tokens:create")}
      offerEvents={offersEvents(c, user)}
      selectedToken={selectedToken}
      selectedApp={selectedApp}
      confirm={confirm}
      creating={extra.creating ?? c.req.query("new") === "1"}
      created={extra.created}
      problem={extra.problem}
      draft={extra.draft}
    />,
    status,
  );
}

nextTokens.get("/", (c) => renderTokens(c));

nextTokens.post("/", async (c) => {
  const { t } = i18nFromContext(c);
  const form = await readForm(c.req.raw);
  if (!form) return c.text("Bad request", 400);
  const rawName = form.get("name");
  const name = typeof rawName === "string" ? rawName.trim() : "";
  const days = Number(form.get("days"));
  const draft = { name, days: (TOKEN_DAYS as readonly number[]).includes(days) ? days : 30 };
  if (
    name === "" ||
    name.length > MAX_TOKEN_NAME_LENGTH ||
    !(TOKEN_DAYS as readonly number[]).includes(days)
  ) {
    return renderTokens(c, { creating: true, problem: t.next.tokens.invalid, draft }, 400);
  }
  const user = currentUser(c);
  // Events only on the user's own tick, and only if the deployment offers them now. A refused form
  // comes back with the box unticked.
  const events = form.get("events") === "1" && offersEvents(c, user);
  const created = await createApiToken(c.env, user, { name, days, events });
  if (!created) {
    return renderTokens(c, { creating: true, problem: t.next.tokens.limitReached, draft }, 409);
  }
  return renderTokens(c, { created: created.token });
});

nextTokens.post("/apps/:id/revoke", async (c) => {
  const form = await readForm(c.req.raw);
  if (!form) return c.text("Bad request", 400);
  await disconnectApp(c.env, currentUser(c), c.req.param("id"));
  return c.redirect(backPath(form, appPath("/tokens")), 303);
});

nextTokens.post("/:id/revoke", async (c) => {
  const form = await readForm(c.req.raw);
  if (!form) return c.text("Bad request", 400);
  await revokeApiToken(c.env, currentUser(c), c.req.param("id"));
  return c.redirect(backPath(form, appPath("/tokens")), 303);
});
