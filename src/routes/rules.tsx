import { Hono, type Context } from "hono";
import type { AppEnv } from "../app-env";
import { backPath } from "../back";
import { errorLogFields, recordAudit } from "../audit";
import { refreshUserCalendars, userCalendars } from "../calendars";
import { parseRuleOptions, ruleOptionsSchema, type RuleOptions } from "../config";
import { detailLevelFor } from "../detail-policy";
import { i18nFromContext, type Messages } from "../i18n";
import {
  deleteRuleWithBlocks,
  EditorConflict,
  fromAccountDetail,
  levelAuditDetail,
  loadEditorState,
  markPrivateScope,
  parseLevel,
  previousDetail,
  requestSyncs,
  resetDirection,
  ruleDetailsProblem,
  setDirections,
  setDefaultBlockTitle,
  setGroupMembership,
  setGroupMemberships,
  setRuleDetails,
  setSettings,
  setSourceCalendar,
  type BlockBuffer,
  type Choice,
  type RuleDetails,
} from "../editor";
import {
  categoryNames,
  formText,
  minutes,
  onlyCategoriesField,
  ruleDetailsError,
  settingsFrom,
} from "../form";
import { currentUser } from "./current-user";
import type { CurrentUser } from "../users";
import { accountSync } from "../durable";

// The helpers moved to `src/form.ts`; old imports from this module keep working.
export { categoryNames, formText, onlyCategoriesField, ruleDetailsError, settingsFrom };

export const rules = new Hono<AppEnv>();

// The list of rules moved to the Mirroring page. First, so that it answers a visitor too.
rules.get("/", (c) => c.redirect("/mirroring", 301));

rules.use("*", async (c, next) => {
  if (!c.get("user")) return c.redirect("/");
  await next();
});

/**
 * Store the block title of the user's language before a write that can create a first rule. The
 * statement never replaces a stored title, so an explicit "Busy" stays, and it does nothing once
 * a rule exists.
 */
export async function storeDefaultTitle(c: Context<AppEnv>, user: CurrentUser): Promise<void> {
  await setDefaultBlockTitle(c.env, user.id, i18nFromContext(c).t.editor.defaultBlockTitle);
}

/**
 * Rule options with the detail level that the org caps allow between two accounts of the user, as
 * the sync applies them. An account that is not the user's leaves the options as they are.
 */
async function cappedOptions(
  env: Env,
  userId: string,
  options: RuleOptions,
  fromAccount: string,
  toAccount: string,
): Promise<RuleOptions> {
  const { results } = await env.DB.prepare(
    "SELECT id, email, tenant_id AS tenantId FROM accounts WHERE user_id = ? AND id IN (?, ?)",
  )
    .bind(userId, fromAccount, toAccount)
    .all<{ id: string; email: string; tenantId: string | null }>();
  const source = results.find((row) => row.id === fromAccount);
  const target = results.find((row) => row.id === toAccount);
  if (!source || !target) return options;
  return {
    ...options,
    detailLevel: detailLevelFor(env, options.detailLevel, source, target).level,
  };
}

/** The target account of a rule, if the rule belongs to the user. */
async function targetAccountOf(db: D1Database, ruleId: string, userId: string) {
  return db
    .prepare(
      `SELECT tc.account_id AS accountId FROM rules r
       JOIN calendars tc ON tc.id = r.target_calendar_id
       WHERE r.id = ? AND r.user_id = ?`,
    )
    .bind(ruleId, userId)
    .first<{ accountId: string }>();
}

rules.post("/calendars/refresh", async (c) => {
  await refreshUserCalendars(
    c.env,
    currentUser(c).id,
    i18nFromContext(c).t.editor.defaultBlockTitle,
  );
  // The app pages post here with a hidden "back" field.
  return c.redirect(await backAfterPost(c));
});

rules.post("/", async (c) => {
  const user = currentUser(c);
  const { t } = i18nFromContext(c);
  const form = await c.req.formData();
  const source = form.get("source");
  const target = form.get("target");
  const calendars = new Map(
    (await userCalendars(c.env.DB, user.id)).map((calendar) => [calendar.id, calendar]),
  );
  const parsed = ruleOptionsSchema.safeParse({
    detailLevel: form.get("detailLevel") ?? undefined,
    daysAhead: Number(form.get("daysAhead") ?? 60),
    markPrivate: form.has("markPrivate"),
    skipAllDay: form.has("skipAllDay"),
    skipTentative: form.has("skipTentative"),
    bufferBefore: minutes(formText(form, "bufferBefore")),
    bufferAfter: minutes(formText(form, "bufferAfter")),
  });
  const valid =
    parsed.success &&
    typeof source === "string" &&
    typeof target === "string" &&
    source !== target &&
    calendars.has(source) &&
    calendars.get(target)?.canEdit === true;
  if (!valid) return c.text(t.rules.invalid, 400);

  const ruleId = crypto.randomUUID();
  const fromAccount = calendars.get(source)?.accountId ?? "";
  const toAccount = calendars.get(target)?.accountId ?? "";
  // The level the sync copies at, with the org caps, so the log never names a wider one.
  const { detailLevel } = await cappedOptions(c.env, user.id, parsed.data, fromAccount, toAccount);
  // Store the default title of the user's language before the first rule exists.
  await setDefaultBlockTitle(c.env, user.id, t.editor.defaultBlockTitle);
  await c.env.DB.prepare(
    // New rules start paused, so that nothing is written before the user checked the preview.
    `INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options, enabled)
     VALUES (?, ?, ?, ?, ?, 0)`,
  )
    .bind(ruleId, user.id, source, target, JSON.stringify(parsed.data))
    .run();
  await recordAudit(c.env.DB, {
    orgId: user.orgId,
    userId: user.id,
    accountId: calendars.get(target)?.accountId,
    ruleId,
    kind: "rule_created",
    // The rule starts paused: it copies nothing until it is turned on, which records its level.
    detail: {
      detailLevel,
      daysAhead: parsed.data.daysAhead,
      choice: "off",
      markPrivate: parsed.data.markPrivate,
      ...fromAccountDetail(fromAccount),
    },
  });
  return c.redirect("/rules");
});

/**
 * The path of the page that sent the request, if it is an app page of this site. A quick action
 * of an app page returns there when its form has no valid `back` field. Only the path of
 * the `Referer` counts, and only from the request's own origin; `backPath` checks the rest, so the
 * result is never another host.
 */
export function refererBack(request: Request, fallback: string): string {
  const referer = request.headers.get("referer");
  if (!referer) return fallback;
  try {
    const url = new URL(referer);
    if (url.origin !== new URL(request.url).origin) return fallback;
    const probe = new FormData();
    probe.set("back", `${url.pathname}${url.search}`);
    return backPath(probe, fallback);
  } catch {
    return fallback;
  }
}

/**
 * Where a quick action returns to: the app pages post a hidden "back" field. If it is missing or
 * invalid and the request came from an app page, back to that page. A post without a form body
 * returns to the Mirroring page.
 */
async function backAfterPost(c: Context<AppEnv>): Promise<string> {
  const fallback = refererBack(c.req.raw, "/mirroring");
  try {
    return backPath(await c.req.formData(), fallback);
  } catch {
    return fallback;
  }
}

/** The editor script of the old pages asked for fragments with this header; a stale one may still. */
function wantsFragment(c: Context<AppEnv>): boolean {
  return c.req.header("x-fragment") === "1";
}

/** Where to go after a change without the editor script: back to the list with the source open. */
/** Back to the sources card, at the block of one source. */
function backTo(c: Context<AppEnv>, sourceId: string) {
  return c.redirect(`/rules#src-${encodeURIComponent(sourceId)}`);
}

/** Back to the card of the target, open, at the row of the direction. */
function backToDirection(c: Context<AppEnv>, from: string, to: string) {
  const anchor = `dest-${encodeURIComponent(from)}-${encodeURIComponent(to)}`;
  return c.redirect(`/rules?open=${encodeURIComponent(to)}#${anchor}`);
}

// Quick start: every account joins the block group.
rules.post("/group/all", async (c) => {
  const user = currentUser(c);
  // The new pages post here without a GET that stores it: a new user's first rules get the block
  // title in their language.
  await storeDefaultTitle(c, user);
  const state = await loadEditorState(c.env, user.id);
  const ids = state.accounts.map((account) => account.id);
  await setGroupMemberships(c.env, user, ids, true);
  return c.redirect(await backAfterPost(c));
});

rules.post("/group/:accountId", async (c) => {
  const form = await c.req.formData();
  const user = currentUser(c);
  await storeDefaultTitle(c, user);
  await setGroupMembership(c.env, user, c.req.param("accountId"), form.get("inGroup") === "1");
  return c.redirect("/rules");
});

/** A refused change: the reason as plain text. The old pages that showed it as a notice are gone. */
function refuse(c: Context<AppEnv>, text: string) {
  return c.text(text, 400);
}

/** Refuse a save that met a change of another request (`EditorConflict`); rethrow the rest. */
function refuseConflict(c: Context<AppEnv>, error: unknown) {
  if (error instanceof EditorConflict) return refuse(c, i18nFromContext(c).t.editor.saveConflict);
  throw error;
}

// One direction from the form without the editor script. The choice is a level such as
// "title-private", or a bare detail level, which keeps the private mark of the direction.
rules.post("/direction", async (c) => {
  const form = await c.req.formData();
  const from = formText(form, "from");
  const to = formText(form, "to");
  const level = parseLevel(formText(form, "choice"));
  if (!level) return refuse(c, i18nFromContext(c).t.editor.choiceInvalid);
  try {
    const user = currentUser(c);
    await storeDefaultTitle(c, user);
    await setDirections(c.env, user, [{ from, to, ...level }]);
  } catch (error) {
    return refuseConflict(c, error);
  }
  return backToDirection(c, from, to);
});

// All unsaved changes of the page, sent by the editor script: fields "calendar.<id>",
// "choice.<from>.<to>" (a level, see `parseLevel`), "blockColor.<from>.<to>", "workHours.<from>.<to>" ("1" or "0"),
// "onlyCategories.<from>.<to>" (a comma list), the buffer of a source "bufferBefore.<from>" and
// "bufferAfter.<from>", and "settings.<name>". Every
// field is checked before the first write, so that an invalid field refuses the whole save. The
// writes are not one transaction: a D1 or Durable Object failure, or a rule that another request
// changed meanwhile, can still stop them part-way. Each account gets one sync request at the end.
rules.post("/choices", async (c) => {
  const user = currentUser(c);
  const { t } = i18nFromContext(c);
  const form = await c.req.formData();
  // The editor sends text only; a file in one of its fields is a bad request, not a skip.
  for (const [name, value] of form.entries()) {
    if (typeof value !== "string" && isEditorField(name.split(".")[0])) {
      return c.text("Bad field", 400);
    }
  }
  const fields = (kind: string) =>
    [...form.entries()].flatMap(([name, value]) => {
      const [prefix, first, second, ...rest] = name.split(".");
      if (prefix !== kind || !first || rest.length > 0 || typeof value !== "string") return [];
      return [{ first, second, value }];
    });
  const calendars = fields("calendar").filter((field) => field.second === undefined);
  const changes: { from: string; to: string; choice: Choice; markPrivate?: boolean }[] = [];
  for (const { first, second, value } of fields("choice")) {
    if (!second) continue;
    const level = parseLevel(value);
    if (!level) return refuse(c, t.editor.choiceInvalid);
    changes.push({ from: first, to: second, ...level });
  }
  const colors = fields("blockColor").flatMap(({ first, second, value }) =>
    second ? [{ from: first, to: second, value }] : [],
  );
  // The two buffers of a source are one change; a missing one is 0.
  const buffers = new Map<string, Required<BlockBuffer>>();
  for (const kind of ["bufferBefore", "bufferAfter"] as const) {
    for (const { first, second, value } of fields(kind)) {
      if (second) continue;
      const buffer = buffers.get(first) ?? { bufferBefore: 0, bufferAfter: 0 };
      buffer[kind] = minutes(value);
      buffers.set(first, buffer);
    }
  }
  const details: RuleDetails = {
    colors,
    sources: [...buffers].map(([from, options]) => ({ from, options })),
    workHours: fields("workHours").flatMap(({ first, second, value }) =>
      second ? [{ from: first, to: second, on: value === "1" }] : [],
    ),
    onlyCategories: fields("onlyCategories").flatMap(({ first, second, value }) =>
      second ? [{ from: first, to: second, names: categoryNames(value) }] : [],
    ),
  };
  const problem = ruleDetailsProblem(await loadEditorState(c.env, user.id), details);
  if (problem) return refuse(c, ruleDetailsError(t, problem));

  const syncs = new Set<string>();
  try {
    await storeDefaultTitle(c, user);
    // Source calendars first, so that the choices below also reach newly chosen calendars.
    for (const { first, value } of calendars) {
      await setSourceCalendar(c.env, user, first, value === "1", syncs);
    }
    // The choices before the settings, so that a direction never runs with less of a mark than
    // the user chose. A switched private mark then skips the directions whose level set a mark in
    // this save. A conflict in the details keeps the settings, which the page shows apart.
    const settings = form.has("settings")
      ? settingsFrom(form, t.editor.defaultBlockTitle, "settings.")
      : null;
    // A bare title or more, from a page before the levels, gets a mark that the settings give
    // every rule in its own write.
    const mark = settings ? markPrivateScope(settings) : null;
    const levels = changes.map((change) =>
      mark?.scope === "all" && change.markPrivate === undefined && RANK_WITH_MARK.has(change.choice)
        ? { ...change, markPrivate: mark.markPrivate }
        : change,
    );
    const marked = await setDirections(c.env, user, levels, syncs);
    if (settings) await setSettings(c.env, user, settings, syncs, marked);
    // Rule details after the choices, so that a direction turned on in the same save has its
    // rules. A direction that lost its last source in this save has no rules left to change.
    await setRuleDetails(c.env, user, details, syncs);
  } catch (error) {
    return refuseConflict(c, error);
  } finally {
    // Writes before a failure stay, so their accounts sync as well.
    await requestSyncs(c.env, syncs);
  }
  if (wantsFragment(c)) return c.body(null, 204);
  return c.redirect("/rules");
});

/** Detail levels that show a title, so that the private mark matters for them. */
const RANK_WITH_MARK: ReadonlySet<Choice> = new Set(["title", "full"]);

/** Field prefixes of the editor script whose values must be text. */
function isEditorField(name: string | undefined): boolean {
  return (
    name === "calendar" ||
    name === "choice" ||
    name === "blockColor" ||
    name === "bufferBefore" ||
    name === "bufferAfter" ||
    name === "workHours" ||
    name === "onlyCategories"
  );
}

// The details of one direction from the form without the editor script: the block colour and,
// with "workHoursShown", the working-hours checkbox. "onlyCategoriesShown" marks a page with the
// opt-in list, so that a page from before the option leaves the list alone.
rules.post("/direction/details", async (c) => {
  const user = currentUser(c);
  const { t } = i18nFromContext(c);
  const form = await c.req.formData();
  const from = formText(form, "from");
  const to = formText(form, "to");
  const details: RuleDetails = {
    colors: form.has("blockColor") ? [{ from, to, value: formText(form, "blockColor") }] : [],
    workHours: form.has("workHoursShown") ? [{ from, to, on: form.get("workHours") === "1" }] : [],
    onlyCategories: form.has("onlyCategoriesShown")
      ? [{ from, to, names: categoryNames(onlyCategoriesField(form)) }]
      : [],
  };
  const problem = ruleDetailsProblem(await loadEditorState(c.env, user.id), details);
  if (problem) return refuse(c, ruleDetailsError(t, problem));
  try {
    await setRuleDetails(c.env, user, details);
  } catch (error) {
    return refuseConflict(c, error);
  }
  return backToDirection(c, from, to);
});

// These routes exist only for pages opened before the editor rebuild: their forms posted here
// without the editor script. They write nothing and send the browser back to the editor.
for (const path of ["/direction/color", "/direction/hours", "/direction/buffer"]) {
  rules.post(path, (c) => c.redirect("/rules", 303));
}

// The buffer of one source from the form without the editor script.
rules.post("/source/buffer", async (c) => {
  const user = currentUser(c);
  const { t } = i18nFromContext(c);
  const form = await c.req.formData();
  const from = formText(form, "from");
  const details: RuleDetails = {
    sources: [
      {
        from,
        options: {
          bufferBefore: minutes(formText(form, "bufferBefore")),
          bufferAfter: minutes(formText(form, "bufferAfter")),
        },
      },
    ],
  };
  const problem = ruleDetailsProblem(await loadEditorState(c.env, user.id), details);
  if (problem) return refuse(c, ruleDetailsError(t, problem));
  try {
    await setRuleDetails(c.env, user, details);
  } catch (error) {
    return refuseConflict(c, error);
  }
  return backTo(c, from);
});

rules.post("/direction/reset", async (c) => {
  const form = await c.req.formData();
  const from = formText(form, "from");
  const to = formText(form, "to");
  try {
    await resetDirection(c.env, currentUser(c), from, to);
  } catch (error) {
    return refuseConflict(c, error);
  }
  return backToDirection(c, from, to);
});

rules.post("/source-calendar/:calendarId", async (c) => {
  const form = await c.req.formData();
  const user = currentUser(c);
  await storeDefaultTitle(c, user);
  await setSourceCalendar(c.env, user, c.req.param("calendarId"), form.get("isSource") === "1");
  return c.redirect("/rules");
});

rules.post("/settings", async (c) => {
  const { t } = i18nFromContext(c);
  const form = await c.req.formData();
  try {
    await setSettings(c.env, currentUser(c), settingsFrom(form, t.editor.defaultBlockTitle));
  } catch (error) {
    return refuseConflict(c, error);
  }
  return c.redirect("/rules");
});

/** Token errors after which only a new sign-in helps; the same codes as in AccountSync. */
const RECONNECT_MESSAGES = [
  "Account has no tokens",
  "invalid_grant",
  "interaction_required",
  "consent_required",
];

/**
 * A failed run or check in the user's words. The error crosses the Durable Object boundary, so
 * only its message is left. A missing or refused token means the account must connect again.
 */
export function runErrorText(t: Messages, error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (RECONNECT_MESSAGES.some((text) => message.includes(text))) return t.editor.checkNoTokens;
  return t.editor.checkFailed;
}

// Check one direction with real events: a dry run of every rule of the direction, one per
// source calendar of the account, summed.
rules.post("/direction/check", async (c) => {
  const user = currentUser(c);
  const { t } = i18nFromContext(c);
  const form = await c.req.formData();
  const from = formText(form, "from");
  const to = formText(form, "to");
  const state = await loadEditorState(c.env, user.id);
  const direction = state.directions.find((d) => d.from === from && d.to === to);
  const ruleIds = (direction?.slots ?? []).flatMap((slot) =>
    slot.rule?.enabled ? [slot.rule.id] : [],
  );
  // A page from before a change can offer a check for a direction that no longer runs.
  if (ruleIds.length === 0) return refuse(c, t.editor.checkStale);
  const sum = { create: 0, update: 0, delete: 0, unchanged: 0 };
  try {
    for (const ruleId of ruleIds) {
      const result = await accountSync(c.env, to).runRule(ruleId, { dryRun: true });
      sum.create += result.stats.create;
      sum.update += result.stats.update;
      sum.delete += result.stats.delete;
      sum.unchanged += result.stats.unchanged;
    }
  } catch (error) {
    console.error("Direction check failed", from, to, ...errorLogFields(error));
    return refuse(c, runErrorText(t, error));
  }
  const text = t.editor.checkResult(sum.create, sum.update, sum.delete, sum.unchanged);
  return c.text(text);
});

for (const action of ["preview", "run"] as const) {
  rules.post(`/:id/${action}`, async (c) => {
    const user = currentUser(c);
    const { t } = i18nFromContext(c);
    const ruleId = c.req.param("id");
    const target = await targetAccountOf(c.env.DB, ruleId, user.id);
    if (!target) return c.notFound();
    try {
      const result = await accountSync(c.env, target.accountId).runRule(ruleId, {
        dryRun: action === "preview",
      });
      const { create, update, delete: remove, unchanged } = result.stats;
      const text =
        action === "preview"
          ? t.rules.previewResult(create, update, remove, unchanged)
          : t.rules.runResult(result.applied, result.failed, result.remaining);
      // The result says what the next sync would do, in plain words.
      return c.text(
        action === "preview" ? t.editor.checkResult(create, update, remove, unchanged) : text,
      );
    } catch (error) {
      console.error(`Rule ${action} failed`, ruleId, ...errorLogFields(error));
      return refuse(c, runErrorText(t, error));
    }
  });
}

for (const [action, enabled] of [
  ["enable", 1],
  ["pause", 0],
] as const) {
  rules.post(`/:id/${action}`, async (c) => {
    const user = currentUser(c);
    const ruleId = c.req.param("id");
    // The level before and after, so that Activity sees a turn on that lets others see more.
    const rule = await c.env.DB.prepare(
      `SELECT r.options, sc.account_id AS fromAccount, tc.account_id AS toAccount FROM rules r
       JOIN calendars sc ON sc.id = r.source_calendar_id
       JOIN calendars tc ON tc.id = r.target_calendar_id
       WHERE r.id = ? AND r.user_id = ?`,
    )
      .bind(ruleId, user.id)
      .first<{ options: string; fromAccount: string; toAccount: string }>();
    const updated = await c.env.DB.prepare(
      "UPDATE rules SET enabled = ? WHERE id = ? AND user_id = ? AND enabled <> ?",
    )
      .bind(enabled, ruleId, user.id, enabled)
      .run();
    if (updated.meta.changes > 0) {
      const target = await targetAccountOf(c.env.DB, ruleId, user.id);
      // With the org caps: the log names the level the copies get, never a wider one.
      const options = rule
        ? await cappedOptions(
            c.env,
            user.id,
            parseRuleOptions(rule.options),
            rule.fromAccount,
            rule.toAccount,
          )
        : null;
      await recordAudit(c.env.DB, {
        orgId: user.orgId,
        userId: user.id,
        accountId: target?.accountId,
        ruleId,
        kind: enabled ? "rule_enabled" : "rule_paused",
        detail:
          options && rule
            ? {
                ...levelAuditDetail(options, enabled === 1),
                ...previousDetail({
                  choice: levelAuditDetail(options, enabled === 0).choice,
                  markPrivate: options.markPrivate,
                }),
                ...fromAccountDetail(rule.fromAccount),
                // A pause here only stops the rule: no removal of its copies is queued, so they
                // keep showing (see `keptCopies` in `src/pages/next/describe.ts`).
                ...(enabled === 0 ? { cleanup: "none" } : {}),
              }
            : {},
      });
      // Start the first run now instead of waiting for the next cron.
      if (enabled && target) await accountSync(c.env, target.accountId).requestSync();
    }
    return c.redirect("/rules");
  });
}

rules.post("/:id/delete", async (c) => {
  await deleteRuleWithBlocks(c.env, currentUser(c), c.req.param("id"));
  return c.redirect("/rules");
});
