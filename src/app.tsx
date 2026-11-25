import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { deleteCookie, getCookie } from "hono/cookie";
import { languageDetector } from "hono/language";
import * as z from "zod/mini";
import { backPath, readForm } from "./back";
import { cleanupsOfOthers, NO_CLEANUPS, ownCleanups } from "./cleanup";
import type { AppEnv } from "./app-env";
import { setupStatus, signInProviders } from "./config";
import { can } from "./permissions";
import { answeringPattern, routePermissions } from "./route-permissions";
import { operatorNotice } from "./operator-notice";
import { i18nFromContext, LOCALES } from "./i18n";
// The pages outside the app navigation come from one module: `src/pages/next/public/index.ts`.
import {
  CleanupPage,
  DeleteUserPage,
  DisconnectPage,
  MessagePage,
  PrivacyPage,
  SetupPage,
  SignInPage,
} from "./pages/next/public";
import { render } from "./render";
import { mcp } from "./mcp";
import { auth } from "./routes/auth";
import { dev } from "./routes/dev";
import { mountAppPages, overviewPage } from "./routes/next";
import { appGuard } from "./routes/app-guard";
import { APP_BASE, appPath, movedRedirect } from "./app-base";
import { rules } from "./routes/rules";
import { oauthApi, oauthPages } from "./routes/oauth";
import { ACCOUNT_COLOR_KEYS } from "./colors";
import {
  accountWorkHours,
  EditorConflict,
  renameAccount,
  setAccountColor,
  setAccountWorkHours,
  setRuleDetails,
} from "./editor";
import { workHoursFrom } from "./form";
import { devSignInEmail, SESSION_COOKIE, verifySession } from "./session";
import { loadUser, type SignedInUser } from "./users";
import { accountSync } from "./durable";
import { isValidToken, notifyChange } from "./webhooks";
import { deleteUser, removeAccounts } from "./offboarding";
import { crossSiteGuard, securityHeaders } from "./request-guard";
import { carrier, log, startRequest } from "./telemetry";

export const app = new Hono<AppEnv>();

// First, so that every answer of the Worker carries the headers, also errors and redirects.
app.use("*", securityHeaders);

// Before the routes and the error handler, so that every log line of a request carries its ID.
app.use("*", (_c, next) => startRequest("http", next));

app.get("/healthz", (c) => c.text("ok"));

// Microsoft Graph change notifications. On subscription creation Graph sends a validation
// request and expects the token back as plain text within 10 seconds.
app.post("/webhooks/microsoft", async (c) => {
  const validationToken = c.req.query("validationToken");
  if (validationToken !== undefined) {
    return c.text(validationToken, 200, { "Content-Type": "text/plain" });
  }
  // Graph counts a notification as delivered only on a 2xx within 3 seconds. Every answer is 202,
  // so that a forged request learns nothing.
  const accountId = c.req.query("account") ?? "";
  const body = (await c.req.json().catch(() => null)) as {
    value?: { clientState?: string; resourceData?: { id?: string } }[];
  } | null;
  const valid: { resourceData?: { id?: string } }[] = [];
  for (const item of body?.value ?? []) {
    if (await isValidToken(c.env, accountId, item.clientState)) valid.push(item);
  }
  // The instance skips the sync if the notification is only about blocks it wrote itself. Without
  // event IDs that cannot be told, so the sync starts at once.
  const ids = valid.map((item) => item.resourceData?.id);
  if (valid.length === 0) return c.body(null, 202);
  if (ids.every((id): id is string => typeof id === "string" && id !== "")) {
    await accountSync(c.env, accountId).graphChanged(ids, carrier());
  } else {
    await notifyChange(c.env, accountId);
  }
  return c.body(null, 202);
});

// Google Calendar push notifications carry no body; the headers identify the channel.
app.post("/webhooks/google", async (c) => {
  const accountId = c.req.query("account") ?? "";
  // "sync" only confirms a new channel; "exists" and "not_exists" report a change.
  const state = c.req.header("x-goog-resource-state");
  if (
    state !== "sync" &&
    (await isValidToken(c.env, accountId, c.req.header("x-goog-channel-token")))
  ) {
    // The instance skips the sync if the change is only blocks it wrote itself.
    const channelId = c.req.header("x-goog-channel-id") ?? "";
    await accountSync(c.env, accountId).googleChanged(channelId, carrier());
  }
  return c.body(null, 200);
});

// Before the language and session middleware: the bearer token is the only credential here.
app.route("/mcp", mcp);
// OAuth metadata, registration, token and revocation: server to server, without cookies.
app.route("/", oauthApi);

// Language: ?lang= (stored in a cookie), then the cookie, then Accept-Language.
app.use(
  "*",
  languageDetector({
    supportedLanguages: [...LOCALES],
    fallbackLanguage: LOCALES[0],
    order: ["querystring", "cookie", "header"],
    lookupQueryString: "lang",
    lookupCookie: "lang",
    caches: ["cookie"],
    cookieOptions: { path: "/", sameSite: "Lax", secure: true, httpOnly: true, maxAge: 31_536_000 },
  }),
);

// After the language, so that a refusal speaks it. The webhooks above answer before this runs,
// and the guard exempts them by path as well.
app.use("*", crossSiteGuard);

/** The signed-in user of the request, or null. Needs a finished setup. */
async function sessionUser(c: Context<AppEnv>): Promise<SignedInUser | null> {
  const devEmail = devSignInEmail(c.env, c.req.raw);
  if (devEmail) {
    const row = await c.env.DB.prepare(
      "SELECT id, session_version AS version FROM users WHERE lower(email) = lower(?) LIMIT 1",
    )
      .bind(devEmail)
      .first<{ id: string; version: number }>();
    return row ? loadUser(c.env, row.id, row.version) : null;
  }
  const session = await verifySession(getCookie(c, SESSION_COOKIE), c.env.SESSION_SECRET);
  return session ? loadUser(c.env, session.userId, session.version ?? 0) : null;
}

// Public, also before the setup is finished: Google requires a reachable privacy statement.
app.get("/privacy", async (c) =>
  render(
    c,
    <PrivacyPage
      user={setupStatus(c.env).ready ? await sessionUser(c) : null}
      operator={c.env.ORG_NAME?.trim() || "the operator"}
      contact={c.env.PRIVACY_CONTACT?.trim() ?? ""}
      notice={operatorNotice(c.env)}
    />,
  ),
);

// Everything below needs a finished setup. `user` is null for visitors without a valid session.
app.use("*", async (c, next) => {
  const status = setupStatus(c.env);
  if (!status.ready) {
    return render(c, <SetupPage status={status} />, 503);
  }
  c.set("user", await sessionUser(c));
  await next();
});

/**
 * Every route below asks `can` for its action in `ROUTE_NEEDS`; a route without an entry is 404.
 * A test checks that only routes with their own check are registered above this line.
 */
export const permissionGate = routePermissions((c, message) => {
  const { t } = i18nFromContext(c);
  return render(
    c,
    <MessagePage user={c.get("user")} title={t.messages.notAllowed} message={message(t)} />,
    403,
  );
});
app.use("*", permissionGate);

app.route("/auth", auth);
app.route("/rules", rules);
app.route("/oauth", oauthPages);
app.route("/dev", dev);

// The pages of the previous release lived below `/next`. A GET answers 308 to the same page
// without the prefix and keeps the query, for one release. Only the exact page paths redirect: the
// assets below `/next/` (`/next/<file>.<hash>.<ext>`) are served by the assets layer, and a missing
// one must stay a 404, not a redirect to a path that holds no file.
for (const page of ["", "/mirroring", "/calendars", "/activity", "/tokens", "/admin"]) {
  app.get(`/next${page}`, (c) =>
    movedRedirect(c, `${appPath(page === "" ? "/" : page)}${new URL(c.req.url).search}`, 308),
  );
}

// The app pages, at the base of the app; the same routers below `/next` keep the POST endpoints of
// the previous release working. A POST cannot follow a 308 in every client.
mountAppPages(app, APP_BASE);
mountAppPages(app, "/next");

// A visitor gets the sign-in; a signed-in user gets the Overview.
app.get(
  appPath("/"),
  async (c, next) => {
    if (c.get("user")) return next();
    return render(
      c,
      <SignInPage providers={signInProviders(c.env)} operatorNotice={operatorNotice(c.env)} />,
    );
  },
  appGuard,
  overviewPage,
);

/** "auto" or a palette key; the form of the account's name and colour sends it. */
const accountColorField = z.enum(["auto", ...ACCOUNT_COLOR_KEYS]);

// The settings of an account: name, colour and working hours. Every field is checked before the
// first write, and the hours, which can meet a concurrent change, are written first. "/name" is
// the address of the form before the working hours came.
for (const path of ["/accounts/:id/settings", "/accounts/:id/name"]) {
  app.post(path, async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/");
    const { t } = i18nFromContext(c);
    const form = await c.req.formData();
    const accountId = c.req.param("id") ?? "";
    // The colour and the hours are optional, so that a form with the name only keeps working.
    const color = form.has("color") ? accountColorField.safeParse(form.get("color")) : null;
    if (color && !color.success) return c.text("Bad colour", 400);
    const hours = form.has("workHoursShown")
      ? accountWorkHours(c.env, workHoursFrom(form, form.has("workHoursSwitch")))
      : null;
    const back = form.get("returnSource");
    const returnSource = typeof back === "string" ? back : "";
    // The page that showed this form is gone. The reason comes back as text.
    const refuse = (text: string) => c.text(text, 400);
    if (hours && "problem" in hours) return refuse(t.editor.workHoursErrors[hours.problem]);
    const owned = await c.env.DB.prepare("SELECT 1 FROM accounts WHERE id = ? AND user_id = ?")
      .bind(accountId, user.id)
      .first();
    if (!owned) return c.notFound();
    if (hours) {
      try {
        await setAccountWorkHours(c.env, user, accountId, hours.hours);
        // Hours filter only the directions that use them, so the form sets both. Without hours
        // the write above already cleared every rule.
        const applyFrom = new Set(form.getAll("applyFrom"));
        const workHours = form
          .getAll("applyFromShown")
          .filter((from) => typeof from === "string")
          .map((from) => ({ from, to: accountId, on: applyFrom.has(from) }));
        if (hours.hours && workHours.length > 0) {
          await setRuleDetails(c.env, user, { workHours });
        }
      } catch (error) {
        if (error instanceof EditorConflict) return refuse(t.editor.saveConflict);
        throw error;
      }
    }
    if (color) {
      await setAccountColor(c.env, user, accountId, color.data === "auto" ? null : color.data);
    }
    const name = form.get("name");
    if (form.has("name")) {
      await renameAccount(c.env, user, accountId, typeof name === "string" ? name : "");
    }
    // From the rules page the link sits in the row from "returnSource" into this account, in the
    // card of this account as a target.
    if (returnSource) {
      const row = `dest-${encodeURIComponent(returnSource)}-${encodeURIComponent(accountId)}`;
      return c.redirect(`/rules?open=${encodeURIComponent(accountId)}#${row}`);
    }
    return c.redirect(`/#account-${encodeURIComponent(accountId)}`);
  });
}

// Ask before disconnecting: it deletes the rules that use the account and their blocks.
app.get("/accounts/:id/disconnect", async (c) => {
  const user = c.get("user");
  if (!user) return c.redirect("/");
  const accountId = c.req.param("id");
  const account = await c.env.DB.prepare("SELECT email FROM accounts WHERE id = ? AND user_id = ?")
    .bind(accountId, user.id)
    .first<{ email: string }>();
  if (!account) return c.notFound();
  const usage = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM rules r
     JOIN calendars sc ON sc.id = r.source_calendar_id
     JOIN calendars tc ON tc.id = r.target_calendar_id
     WHERE sc.account_id = ? OR tc.account_id = ?`,
  )
    .bind(accountId, accountId)
    .first<{ count: number }>();
  return render(
    c,
    <DisconnectPage
      user={user}
      accountId={accountId}
      email={account.email}
      rules={usage?.count ?? 0}
    />,
  );
});

// Remove an account of the signed-in user. Its blocks go through the removal queues, then its
// Durable Object forgets the tokens.
app.post("/accounts/:id/disconnect", async (c) => {
  const user = c.get("user");
  if (!user) return c.redirect("/");
  const accountId = c.req.param("id");
  const owned = await c.env.DB.prepare("SELECT 1 FROM accounts WHERE id = ? AND user_id = ?")
    .bind(accountId, user.id)
    .first();
  if (!owned) return c.notFound();
  const form = await readForm(c.req.raw);
  await removeAccounts(c.env, user, [accountId]);
  // The panel's confirmation step names where it came from; the old page sends no form.
  return c.redirect(form ? backPath(form, "/") : "/");
});

async function accountCount(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM accounts WHERE user_id = ?")
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// "Delete my data": confirmation, then the user goes with every account, rule and block.
app.get("/account/delete", async (c) => {
  const user = c.get("user");
  if (!user) return c.redirect("/");
  return render(
    c,
    <DeleteUserPage
      user={user}
      target={null}
      ownAccounts={await accountCount(c.env, user.id)}
      action="/account/delete"
      cancel={appPath("/")}
    />,
  );
});

app.post("/account/delete", async (c) => {
  const user = c.get("user");
  if (!user) return c.redirect("/");
  await deleteUser(c.env, user, "self");
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
  const { t } = i18nFromContext(c);
  return render(c, <MessagePage title={t.deleteUser.doneTitle} message={t.deleteUser.doneText} />);
});

/** A user of the admin's org other than the admin, or null. */
async function deletableUser(env: Env, admin: { id: string; orgId: string }, userId: string) {
  if (userId === admin.id) return null;
  return env.DB.prepare("SELECT id, email FROM users WHERE id = ? AND org_id = ?")
    .bind(userId, admin.orgId)
    .first<{ id: string; email: string }>();
}

app.get("/admin/users/:id/delete", async (c) => {
  const user = c.get("user");
  if (!user) return c.redirect("/");
  const target = await deletableUser(c.env, user, c.req.param("id"));
  if (!target) return c.notFound();
  return render(
    c,
    <DeleteUserPage
      user={user}
      target={{ email: target.email, accounts: await accountCount(c.env, target.id) }}
      ownAccounts={0}
      action={`/admin/users/${target.id}/delete`}
      cancel="/admin"
    />,
  );
});

// What an offboarding could not remove. An admin also sees the rest of users who cannot sign in.
app.get("/cleanup", async (c) => {
  const user = c.get("user");
  if (!user) return c.redirect("/");
  const [own, others] = await Promise.all([
    ownCleanups(c.env.DB, user.id),
    can(user, "org:audit") ? cleanupsOfOthers(c.env.DB, user.orgId) : NO_CLEANUPS,
  ]);
  return render(c, <CleanupPage user={user} own={own} others={others} />);
});

// The activity of the org moved to the Activity page.
app.get("/admin/activity", (c) =>
  movedRedirect(
    c,
    `${appPath("/activity")}?scope=org${new URL(c.req.url).search.replace("?", "&")}`,
    308,
  ),
);

// A browser that asks for a page gets the styled 404, inside the app shell when signed in.
// Everything else (MCP, API, a POST, a client that does not ask for HTML) keeps the plain text,
// because those clients read the status and not a page.
app.notFound((c) => {
  const { pathname } = new URL(c.req.url);
  const machinePath = ["/mcp", "/api", "/oauth", "/.well-known"].some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  const wantsHtml = (c.req.header("accept") ?? "").toLowerCase().includes("text/html");
  if (c.req.method !== "GET" || machinePath || !wantsHtml) return c.text("Not found", 404);
  const { t } = i18nFromContext(c);
  const user = c.get("user") ?? null;
  const text = t.next.auth.notFound;
  return render(
    c,
    <MessagePage
      user={user}
      title={text.title}
      message={text.text}
      back={{ href: user ? appPath("/") : "/", label: text.back }}
    />,
    404,
  );
});

// An unexpected error gets a page in the user's language, or a short text for the editor
// script. The log never holds a raw message or stack: a provider description can name the user,
// and a SyntaxError can quote the input. See `errorFields`.
app.onError((error, c) => {
  if (error instanceof HTTPException) return error.getResponse();
  // The pattern of the answering route, not the path: a path can hold a calendar ID, and an OAuth
  // callback carries its code in the query.
  log.error("request.failed", { method: c.req.method, route: answeringPattern(c) }, error);
  const { t } = i18nFromContext(c);
  if (c.req.header("x-fragment") === "1") return c.text(t.messages.errorText, 500);
  return render(
    c,
    <MessagePage title={t.messages.errorTitle} message={t.messages.errorText} />,
    500,
  );
});
