import { appPath } from "../app-base";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../app-env";
import {
  accountStatuses,
  orgActivityPage,
  recentChangesQuery,
  ruleOutcomesQuery,
  userActivityPage,
} from "../audit";
import { backPath, readForm } from "../back";
import { runQueries, type Parsed, type Query } from "../batch";
import type { AccountRow } from "../calendars";
import { refreshUserCalendars } from "../calendars";
import { ownCleanupsQuery } from "../cleanup";
import { setupStatus } from "../config";
import { editorQuery, withLocalizedTitle, type EditorState } from "../editor";
import { formText, parseDirectionParam } from "../form";
import { i18nFromContext } from "../i18n";
import { activityFilter, parseActivityQuery } from "../next-activity";
import {
  calendarDraft,
  saveCalendar,
  type CalendarDraft,
  type CalendarField,
} from "../next-calendars";
import { operatorNotice } from "../operator-notice";
import { can } from "../permissions";
import { ActivityPage } from "../pages/next/activity";
import { CalendarsPage } from "../pages/next/calendars";
import { saveAllMirrorings, saveMirroring } from "../next-mirroring";
import { MirroringPage } from "../pages/next/mirroring";
import { OverviewPage } from "../pages/next/overview";
import type { PageBase } from "../pages/next/types";
import { render } from "../render";
import { appGuard, timedD1 } from "./app-guard";
import { currentUser } from "./current-user";
import { nextAdmin, nextTokens } from "./next-admin";

/**
 * The app pages: Overview, Mirroring, Calendars and Activity (Admin and Tokens are in
 * `next-admin.tsx`). A route loads what its page needs and passes it as props, so that a page file
 * holds only markup. A page GET reads D1 in one batch (`loadBase`) and calls no provider; it writes
 * only the colours that `parseEditorState` assigns to accounts without one. The forms of the lists
 * and the calendar panel post to the routes below; a few quick actions post to the `/rules`
 * endpoints with a `back` field.
 *
 * One router per page, each with its own guard (`appGuard`), mounted by `mountAppPages`.
 */
const mirroring = new Hono<AppEnv>();
const calendars = new Hono<AppEnv>();
const activity = new Hono<AppEnv>();
for (const router of [mirroring, calendars, activity]) router.use("*", appGuard);

/**
 * Mount the app pages below `prefix`. `prefix` is `APP_BASE` for the pages. The same call with
 * "/next" keeps the POST endpoints of the previous release working for one release; its GET
 * routes never answer, because `app.tsx` redirects those paths first.
 */
export function mountAppPages(host: Hono<AppEnv>, prefix: string): void {
  host.route(`${prefix}/mirroring`, mirroring);
  host.route(`${prefix}/calendars`, calendars);
  host.route(`${prefix}/activity`, activity);
  host.route(`${prefix}/admin`, nextAdmin);
  host.route(`${prefix}/tokens`, nextTokens);
}

/**
 * What every page needs, and the reads of its own, in ONE D1 batch: the editor state, the latest
 * outcomes, and the `extras`. It reads D1 only: `prepareEditor` of the old pages writes the default
 * title and can call a provider on every GET. The connect callback loads the calendars of a new
 * account, and "Check again" posts to `/calendars/refresh`. The block title shows as the
 * default of the user's language until one is stored (`withLocalizedTitle`).
 */
async function loadBase<const Q extends readonly Query<unknown>[] = []>(
  c: Context<AppEnv>,
  extras: Q = [] as unknown as Q,
): Promise<{ base: PageBase; extra: Parsed<Q> }> {
  const user = currentUser(c);
  const [loaded, outcomes, ...extra] = await timedD1(c, () =>
    runQueries(c.env.DB, [
      editorQuery(c.env, user.id),
      ruleOutcomesQuery(c.env.DB, user.id),
      ...extras,
    ]),
  );
  // Rare: accounts without a stored colour get one on the first load.
  if (loaded.colorWrites.length > 0) await timedD1(c, () => c.env.DB.batch(loaded.colorWrites));
  return {
    base: {
      user,
      state: withLocalizedTitle(loaded.state, i18nFromContext(c).t.editor.defaultBlockTitle),
      outcomes,
      providers: setupStatus(c.env).providers,
      operatorNotice: operatorNotice(c.env),
    },
    extra: extra as unknown as Parsed<Q>,
  };
}

/**
 * The direction named by `?d=<from>~<to>`, or undefined if the value is absent, malformed or names
 * a direction that the state does not have.
 */
export function selectedDirection(
  state: EditorState,
  value: string | undefined,
): { from: string; to: string } | undefined {
  const named = parseDirectionParam(value);
  if (!named) return undefined;
  return state.directions.some(
    (direction) => direction.from === named.from && direction.to === named.to,
  )
    ? named
    : undefined;
}

/** The account named by `?c=<id>`, if the state has it. */
export function selectedAccount(state: EditorState, value: string | undefined): string | undefined {
  return state.accounts.find((account) => account.id === value)?.id;
}

/**
 * The Overview, at the base of the app. `app.tsx` runs `appGuard` before it and answers a visitor
 * with the sign-in page instead.
 */
export async function overviewPage(c: Context<AppEnv>) {
  const now = Date.now();
  const userId = currentUser(c).id;
  const {
    base,
    extra: [changes, cleanups],
  } = await loadBase(c, [
    recentChangesQuery(c.env.DB, userId, now),
    ownCleanupsQuery(c.env.DB, userId),
  ]);
  return render(
    c,
    <OverviewPage
      {...base}
      changes={changes}
      cleanups={{ left: cleanups.left.length, running: cleanups.running.length }}
      now={now}
    />,
  );
}

// Events with filters and an older-page cursor. The page reads D1 only: no provider and no Durable
// Object. the editor read can store the colours it assigns to accounts that have none. `?scope=org`
// is the view of the whole org and needs "org:audit", the action of `/admin/activity`; for anyone
// else the view does not exist.
activity.get("/", async (c) => {
  const user = currentUser(c);
  const org = c.req.query("scope") === "org";
  if (org && !can(user, "org:audit")) return c.notFound();
  // The editor state and the latest outcomes (for the Mirroring dot) share one batch.
  const [loaded, outcomes] = await timedD1(c, () =>
    runQueries(c.env.DB, [editorQuery(c.env, user.id), ruleOutcomesQuery(c.env.DB, user.id)]),
  );
  if (loaded.colorWrites.length > 0) await timedD1(c, () => c.env.DB.batch(loaded.colorWrites));
  const state = loaded.state;
  const query = parseActivityQuery(
    state,
    {
      d: c.req.query("d"),
      c: c.req.query("c"),
      kind: c.req.query("kind"),
      before: c.req.query("before"),
    },
    org,
  );
  const filter = activityFilter(state, query);
  const page = await timedD1(c, () =>
    org
      ? orgActivityPage(c.env.DB, user.orgId, filter, undefined, user.id)
      : userActivityPage(c.env.DB, user.id, filter),
  );
  return render(
    c,
    <ActivityPage
      user={user}
      state={state}
      outcomes={outcomes}
      rows={page.rows}
      older={page.older}
      query={query}
      canViewOrg={can(user, "org:audit")}
    />,
  );
});

mirroring.get("/", async (c) => {
  const { base } = await loadBase(c);
  const d = c.req.query("d");
  return render(
    c,
    <MirroringPage
      {...base}
      selected={selectedDirection(base.state, d)}
      settingsOpen={d === "all"}
      saved={c.req.query("saved") === "1"}
      requested={d}
    />,
  );
});

// One form for a mirroring's level and details, or for the settings of all mirrorings. A refused
// save shows the page again with the reason at the top of the open panel and the input kept. A
// conflict (409) shows the stored values instead, with a fresh version and a warning: the panel was
// drawn before another tab or device changed it, and nothing of this save was stored.
mirroring.post("/", async (c) => {
  const user = currentUser(c);
  const { t } = i18nFromContext(c);
  const form = await readForm(c.req.raw);
  if (!form) return c.text("Bad request", 400);
  const all = form.get("scope") === "all";
  // A first rule gets the block title in the user's language: `saveMirroring` stores it, and the
  // settings save stores the title of its form.
  const result = all
    ? await saveAllMirrorings(c.env, user, form, t)
    : await saveMirroring(c.env, user, form, t);
  if (result.ok) return c.redirect(backPath(form, appPath("/mirroring")), 303);
  const { base } = await loadBase(c);
  const from = formText(form, "from");
  const to = formText(form, "to");
  const selected = all ? undefined : selectedDirection(base.state, `${from}~${to}`);
  if ("conflict" in result) {
    const text = t.next.mirroring;
    return render(
      c,
      <MirroringPage
        {...base}
        selected={selected}
        settingsOpen={all}
        saved={false}
        conflict={all ? text.all.conflict : text.conflict}
      />,
      409,
    );
  }
  return render(
    c,
    <MirroringPage
      {...base}
      selected={selected}
      settingsOpen={all}
      saved={false}
      error={result.error}
      errorField={result.field}
      draft={form}
    />,
    400,
  );
});

/**
 * The calendars page, with the panel's refusal and the input that caused it if given, or with a
 * conflict: then the panel shows the stored values and the conflict text, with status 409.
 */
async function renderCalendars(
  c: Context<AppEnv>,
  refusal?: { error: string; field?: CalendarField; draft: CalendarDraft } | { conflict: string },
  selected = c.req.query("c"),
) {
  const { base } = await loadBase(c);
  // One fixed order of calendars on every page: the order of the editor state, which also has
  // `createdAt`, so that the page needs no read of its own.
  const rows: AccountRow[] = base.state.accounts.map((account) => ({
    id: account.id,
    provider: account.provider,
    email: account.email,
    tenantId: account.tenantId,
    createdAt: account.createdAt,
    needsReconnect: account.needsReconnect ? 1 : 0,
  }));
  return render(
    c,
    <CalendarsPage
      {...base}
      accounts={rows}
      statuses={accountStatuses(base.outcomes)}
      selected={selectedAccount(base.state, selected)}
      requested={refusal ? undefined : selected}
      from={c.req.query("from")}
      saved={!refusal && c.req.query("saved") === "1"}
      confirm={!refusal && c.req.query("confirm") === "disconnect" ? "disconnect" : undefined}
      error={refusal && "error" in refusal ? refusal.error : undefined}
      errorField={refusal && "error" in refusal ? refusal.field : undefined}
      draft={refusal && "draft" in refusal ? refusal.draft : undefined}
      conflict={refusal && "conflict" in refusal ? refusal.conflict : undefined}
    />,
    refusal ? ("conflict" in refusal ? 409 : 400) : 200,
  );
}

calendars.get("/", (c) => renderCalendars(c));

// Reload the calendar lists of all accounts from the providers, then back to the panel.
calendars.post("/refresh", async (c) => {
  const form = await readForm(c.req.raw);
  if (!form) return c.text("Bad request", 400);
  await refreshUserCalendars(
    c.env,
    currentUser(c).id,
    i18nFromContext(c).t.editor.defaultBlockTitle,
  );
  return c.redirect(backPath(form, appPath("/calendars")), 303);
});

// One save for the whole panel of a calendar. The fields are checked before the first write.
calendars.post("/:id", async (c) => {
  const user = currentUser(c);
  const accountId = c.req.param("id");
  const form = await readForm(c.req.raw);
  if (!form) return c.text("Bad request", 400);
  const { t } = i18nFromContext(c);
  const result = await saveCalendar(c.env, user, t, accountId, form);
  if ("missing" in result) return c.notFound();
  if ("conflict" in result) {
    return renderCalendars(c, { conflict: t.next.calendars.conflictStale }, accountId);
  }
  if (!result.ok && !result.field) {
    // Another tab changed the calendar while this save ran, and steps before that may be stored.
    // The panel shows what is stored, with its version, never the input with a fresh version:
    // one more Save would overwrite the other change unseen.
    return renderCalendars(c, { conflict: result.error }, accountId);
  }
  if (!result.ok) {
    // A refusal at a field came before any write: the input stays, with the version it was drawn
    // with, so that a change made meanwhile still refuses the next save.
    return renderCalendars(
      c,
      { error: result.error, field: result.field, draft: calendarDraft(form) },
      accountId,
    );
  }
  return c.redirect(
    backPath(form, `${appPath("/calendars")}?c=${encodeURIComponent(accountId)}&saved=1`),
    303,
  );
});
