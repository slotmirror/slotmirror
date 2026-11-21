import type { OffboardingOwner } from "./account-sync";
import { auditStatement, errorLogFields, recordAudit, type AuditEvent } from "./audit";
import { HOLD_LEASE_MS, openTombstone } from "./cleanup";
import { parseRuleOptions } from "./config";
import { cappedLevelAuditDetail, fromAccountDetail, previousDetail } from "./editor";
import { accountSync } from "./durable";
import { ruleTagFor } from "./sync/plan";
import { syncWindow } from "./sync/rules";

/**
 * Removing accounts and users, and pausing a user. The blocks go through the removal queue of each
 * target account's Durable Object, so a request never waits for the providers. An account that
 * goes retires: its Durable Object removes its queued blocks, then forgets the tokens. Every removal
 * has a tombstone in D1 before its job exists, see `src/cleanup.ts`, and ends with a result in the
 * tombstone and in the audit log, see `cleanup_finished`.
 *
 * A request that stops a rule writes a hold of its own, in the same D1 step. The hold states that the
 * rule ran. The rule runs again only once no hold is left and none of its accounts retires, so that
 * a failed request cannot start a rule that another request stopped. If a request dies or its answer
 * is unclear, its hold stays, and `releaseHeldRules()` reads it from the cron.
 */

interface OwnedRule {
  ruleId: string;
  sourceAccountId: string;
  targetAccountId: string;
  remoteCalendarId: string;
  calendarName: string;
  optionsJson: string;
  enabled: number;
  /** 1 if a hold stopped the rule: it ran before that offboarding. */
  held: number;
  /** Address and tenant of both accounts, for the org caps of the level in the audit log. */
  sourceEmail: string;
  sourceTenantId: string | null;
  targetEmail: string;
  targetTenantId: string | null;
}

/**
 * A removal could not be queued, so the rows stay: without them no one knows the blocks. No account
 * went, and the rules run again. Removals of other target accounts stay queued and run to their end,
 * so the rules write their blocks again afterwards. The same request can run again; the caller's
 * error page says so.
 */
export class CleanupNotQueued extends Error {
  constructor(failed: number) {
    super(`${failed} block removals could not be queued`);
    this.name = "CleanupNotQueued";
  }
}

/**
 * Queue the removal of every block the rules wrote, with one call per target account. Returns the
 * rules whose removal is not queued.
 */
async function queueRemovals(
  env: Env,
  rules: OwnedRule[],
  offboarding?: OffboardingOwner,
): Promise<number> {
  const byTarget = Map.groupBy(rules, (rule) => rule.targetAccountId);
  let failed = 0;
  for (const [accountId, jobs] of byTarget) {
    try {
      await accountSync(env, accountId).queueRemovals(
        jobs.map(({ ruleId, remoteCalendarId }) => ({ ruleId, remoteCalendarId })),
        offboarding ? { offboarding: { ...offboarding, accountId } } : {},
      );
    } catch (error) {
      failed += jobs.length;
      console.error("Queueing removals failed", accountId, ...errorLogFields(error));
    }
  }
  return failed;
}

/** Rules that read from or write into any of the accounts, with both accounts. */
async function rulesOfAccounts(env: Env, accountIds: string[]): Promise<OwnedRule[]> {
  if (accountIds.length === 0) return [];
  const marks = accountIds.map(() => "?").join(", ");
  const { results } = await env.DB.prepare(
    `SELECT r.id AS ruleId, sc.account_id AS sourceAccountId, tc.account_id AS targetAccountId,
       tc.remote_id AS remoteCalendarId, tc.name AS calendarName, r.options AS optionsJson,
       r.enabled, EXISTS (SELECT 1 FROM rule_holds h WHERE h.rule_id = r.id) AS held,
       sa.email AS sourceEmail, sa.tenant_id AS sourceTenantId,
       ta.email AS targetEmail, ta.tenant_id AS targetTenantId
     FROM rules r
     JOIN calendars sc ON sc.id = r.source_calendar_id
     JOIN calendars tc ON tc.id = r.target_calendar_id
     JOIN accounts sa ON sa.id = sc.account_id
     JOIN accounts ta ON ta.id = tc.account_id
     WHERE sc.account_id IN (${marks}) OR tc.account_id IN (${marks})`,
  )
    .bind(...accountIds, ...accountIds)
    .all<OwnedRule>();
  return results;
}

const ids = (rules: OwnedRule[]) => JSON.stringify(rules.map((rule) => rule.ruleId));

/**
 * The level a rule had before an offboarding stopped it, with the org caps: a held rule ran
 * before. Broken options leave the level out.
 */
function levelBefore(env: Env, rule: OwnedRule): ReturnType<typeof previousDetail> | null {
  try {
    const ran = rule.enabled === 1 || rule.held === 1;
    const level = cappedLevelAuditDetail(
      env,
      parseRuleOptions(rule.optionsJson),
      ran,
      { email: rule.sourceEmail, tenantId: rule.sourceTenantId },
      { email: rule.targetEmail, tenantId: rule.targetTenantId },
    );
    return previousDetail({ choice: level.choice, markPrivate: level.markPrivate ?? true });
  } catch {
    return null;
  }
}

/**
 * The `rule_deleted` rows of rules that go with a disconnected account (the row of the account
 * deletes them by cascade). Every rule of a mirroring with that account goes, so each row is a
 * level change to "off", like a turn off. They name the source account, the target (the row's
 * account) and the level before, so that Activity ends the times of their mirrorings and keeps them
 * under them. The removal of their copies is queued at this point. IDs and levels only.
 */
function removedRuleEvents(env: Env, owner: OffboardingOwner, rules: OwnedRule[]): AuditEvent[] {
  // Every rule's copies get a removal (`queueRemovals`), also those of a rule that was off: a pause
  // of the old rules page left them showing, and the rule row cannot tell such a pause from an
  // exception whose removal ran before. So every rule writes a row. A rule that ran (a held rule
  // ran before its hold) turns its mirroring off. One that was off already only goes: it has no
  // "choice", so Activity ends its times without a level change.
  return rules.map((rule) => {
    const ran = rule.enabled === 1 || rule.held === 1;
    return {
      orgId: owner.orgId,
      userId: owner.userId,
      accountId: rule.targetAccountId,
      ruleId: rule.ruleId,
      kind: "rule_deleted",
      detail: {
        cleanup: "queued",
        ...(ran ? { choice: "off" } : {}),
        accountRemoved: true,
        ...fromAccountDetail(rule.sourceAccountId),
        ...(ran ? levelBefore(env, rule) : { previousChoice: "off" }),
      },
    };
  });
}

/** What a rule wrote: a period and a title for the tombstone. Broken options must not stop this. */
function blocksOf(rule: OwnedRule, now: number) {
  try {
    const options = parseRuleOptions(rule.optionsJson);
    const { start, end } = syncWindow(options, new Date(now));
    return {
      windowStart: start.toISOString(),
      windowEnd: end.toISOString(),
      // Any other detail level copies the title of each event.
      blockTitle: options.detailLevel === "busy" ? options.blockTitle : null,
    };
  } catch {
    return { windowStart: null, windowEnd: null, blockTitle: null };
  }
}

/** The statements that open a tombstone for every rule, for one D1 step with other writes. */
function tombstoneStatements(
  env: Env,
  rules: OwnedRule[],
  owner: OffboardingOwner,
): Promise<D1PreparedStatement[]> {
  const now = Date.now();
  return Promise.all(
    rules.map(async (rule) =>
      openTombstone(env.DB, {
        accountId: rule.targetAccountId,
        remoteCalendarId: rule.remoteCalendarId,
        ruleId: rule.ruleId,
        orgId: owner.orgId,
        userId: owner.userId,
        calendarName: rule.calendarName,
        ruleTag: await ruleTagFor(rule.ruleId),
        openedAt: new Date(now).toISOString(),
        ruleWasOff: rule.enabled !== 1 && rule.held !== 1,
        ...blocksOf(rule, now),
      }),
    ),
  );
}

/**
 * Hold the rules and open the tombstones in one D1 step. If it fails, nothing changed, so the
 * tombstones always exist before a job or a retirement does.
 */
async function stopRules(
  env: Env,
  hold: string,
  stopped: OwnedRule[],
  tombstones: D1PreparedStatement[],
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO rule_holds (rule_id, hold_id, until)
       SELECT id, ?, ? FROM rules WHERE id IN (SELECT value FROM json_each(?))`,
    ).bind(hold, Date.now() + HOLD_LEASE_MS, ids(stopped)),
    env.DB.prepare(
      "UPDATE rules SET enabled = 0 WHERE id IN (SELECT value FROM json_each(?))",
    ).bind(ids(stopped)),
    ...tombstones,
  ]);
}

/** Run a rule again, unless another request holds it too. */
function startUnlessHeld(env: Env, ruleId: string): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE rules SET enabled = 1 WHERE id = ?
     AND NOT EXISTS (SELECT 1 FROM rule_holds h WHERE h.rule_id = rules.id)`,
  ).bind(ruleId);
}

/** End the holds of this request. A failure keeps them for `releaseHeldRules()`. */
function releaseHolds(env: Env, hold: string, rules: OwnedRule[]) {
  return env.DB.batch([
    env.DB.prepare(
      "DELETE FROM rule_holds WHERE hold_id = ? AND rule_id IN (SELECT value FROM json_each(?))",
    ).bind(hold, ids(rules)),
    ...rules.map((rule) => startUnlessHeld(env, rule.ruleId)),
  ]);
}

/**
 * Undo the retirement of an account that stays. Returns false if the answer is missing: the account
 * may still retire, so its rules must not run again.
 */
async function cancelRetirement(env: Env, accountId: string, generation: string): Promise<boolean> {
  try {
    await accountSync(env, accountId).cancelRetire(generation);
    return true;
  } catch (error) {
    console.error("Cancelling a retirement failed", accountId, ...errorLogFields(error));
    return false;
  }
}

/**
 * The accounts that may retire: any request started it, or no answer came. Their rules must not run
 * again.
 */
async function retiringAccounts(env: Env, accountIds: string[]): Promise<Set<string>> {
  const unclear = new Set<string>();
  for (const accountId of accountIds) {
    try {
      if (await accountSync(env, accountId).retiring()) unclear.add(accountId);
    } catch (error) {
      unclear.add(accountId);
      console.error("Reading a retirement failed", accountId, ...errorLogFields(error));
    }
  }
  return unclear;
}

/** Every account that the rules read from or write into. */
function accountsOf(rules: OwnedRule[]): string[] {
  return [...new Set(rules.flatMap((rule) => [rule.sourceAccountId, rule.targetAccountId]))];
}

/** The rules that touch none of the accounts. */
function rulesApartFrom(rules: OwnedRule[], accountIds: Set<string>): OwnedRule[] {
  return rules.filter(
    (rule) => !accountIds.has(rule.sourceAccountId) && !accountIds.has(rule.targetAccountId),
  );
}

/**
 * Run the stopped rules that touch no retiring account, also an account of another request. Holds of
 * the other rules stay for the cron. A removal may have run during the request, so the target
 * accounts sync at once. A failure is logged, so that the caller's error stays.
 */
async function resumeRules(
  env: Env,
  hold: string,
  accountIds: string[],
  stopped: OwnedRule[],
  unclear: Set<string> = new Set(),
): Promise<void> {
  try {
    const retiring = await retiringAccounts(env, accountsOf(stopped));
    const running = rulesApartFrom(stopped, new Set([...retiring, ...unclear]));
    await releaseHolds(env, hold, running);
    // The rules of accounts that went earlier in the request left with them.
    const released = new Set(running.map((rule) => rule.ruleId));
    const left = await rulesOfAccounts(env, accountIds);
    const targets = new Set(
      left.filter((rule) => released.has(rule.ruleId)).map((rule) => rule.targetAccountId),
    );
    for (const accountId of targets) await accountSync(env, accountId).requestSync();
  } catch (error) {
    console.error("Resuming rules failed", ...errorLogFields(error));
  }
}

/** Record that the accounts stay. */
async function reportKept(
  env: Env,
  user: { id: string; orgId: string },
  accountIds: string[],
  detail: Record<string, number | boolean>,
): Promise<void> {
  for (const accountId of accountIds) {
    await recordAudit(env.DB, {
      orgId: user.orgId,
      userId: user.id,
      accountId,
      kind: "account_disconnect_failed",
      detail,
    });
  }
}

/**
 * Disconnect accounts of a user: every block that involves them is queued for removal, the
 * accounts retire, and their rows go with their calendars and rules. If a removal cannot be queued,
 * nothing goes and this throws `CleanupNotQueued`. If an account cannot retire or its row cannot
 * go, it and the accounts after it stay, and this throws that error. A job that is queued then runs
 * to its end all the same, and a rule that runs again writes its blocks back. A rule runs again only
 * if none of its accounts retires. If the undo fails, its rules stay held, the account can still go,
 * and its row then shows that it needs a reconnect.
 */
export async function removeAccounts(
  env: Env,
  user: { id: string; orgId: string },
  accountIds: string[],
): Promise<void> {
  const rules = await rulesOfAccounts(env, accountIds);
  // A rule that another request stopped counts too: if both fail, the rule still has to run again.
  const stopped = rules.filter((rule) => rule.enabled === 1 || rule.held === 1);
  // Made here: the answer of `retire()` can get lost, and the cancel still has to name it.
  const generation = crypto.randomUUID();
  const owner = { orgId: user.orgId, userId: user.id };
  // The rules stop before the first job exists: a full cycle would write the blocks again.
  await stopRules(env, generation, stopped, await tombstoneStatements(env, rules, owner));
  const failed = await queueRemovals(env, rules, owner);
  if (failed > 0) {
    await reportKept(env, user, accountIds, { rules: rules.length, cleanupFailed: failed });
    await resumeRules(env, generation, accountIds, stopped);
    throw new CleanupNotQueued(failed);
  }
  // Each rule is reported once, with the first of its accounts that goes.
  const reported = new Set<string>();
  for (const [index, accountId] of accountIds.entries()) {
    try {
      await accountSync(env, accountId).retire(generation);
      await env.DB.prepare("DELETE FROM accounts WHERE id = ? AND user_id = ?")
        .bind(accountId, user.id)
        .run();
    } catch (error) {
      const kept = accountIds.slice(index);
      const cancelled = await cancelRetirement(env, accountId, generation);
      await reportKept(env, user, kept, { rules: rules.length, retireFailed: true });
      await resumeRules(env, generation, kept, stopped, new Set(cancelled ? [] : [accountId]));
      throw error;
    }
    const gone = rules.filter(
      (rule) =>
        !reported.has(rule.ruleId) &&
        (rule.sourceAccountId === accountId || rule.targetAccountId === accountId),
    );
    for (const rule of gone) reported.add(rule.ruleId);
    const events: AuditEvent[] = [
      ...removedRuleEvents(env, owner, gone),
      {
        orgId: user.orgId,
        userId: user.id,
        accountId,
        kind: "account_disconnected",
        // The result of each rule's removal follows in its own `cleanup_finished` event.
        detail: { rules: rules.length },
      },
    ];
    // The account is gone; like `recordAudit`, a broken log must not fail the request.
    try {
      await env.DB.batch(events.map((event) => auditStatement(env.DB, event)));
    } catch (error) {
      console.error("Audit write failed", "account_disconnected", ...errorLogFields(error));
    }
  }
}

/** Who started a deletion or a change of state; recorded without names. */
export type Actor = "self" | "admin";

/**
 * Delete a user with every account, rule and block. Activity entries stay until retention.
 */
export async function deleteUser(
  env: Env,
  user: { id: string; orgId: string },
  by: Actor,
): Promise<void> {
  const { results } = await env.DB.prepare("SELECT id FROM accounts WHERE user_id = ?")
    .bind(user.id)
    .all<{ id: string }>();
  await removeAccounts(
    env,
    user,
    results.map((row) => row.id),
  );
  await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id).run();
  // The user is gone, so the entry belongs to the org only. It says who acted, not who went.
  await recordAudit(env.DB, { orgId: user.orgId, kind: "user_deleted", detail: { by } });
}

/**
 * The level that a held rule runs at again, with the org caps, and its source account, for the
 * `rule_enabled` row of its restore. A held rule copied nothing while held, so the level before is
 * "off". Without options (an older caller) or with broken ones, only the source account.
 */
function restoredLevel(env: Env, rule: HeldRule) {
  const from = fromAccountDetail(rule.sourceAccountId);
  if (rule.optionsJson === undefined) return from;
  try {
    const level = cappedLevelAuditDetail(
      env,
      parseRuleOptions(rule.optionsJson),
      true,
      { email: rule.sourceEmail ?? "", tenantId: rule.sourceTenantId ?? null },
      { email: rule.targetEmail ?? "", tenantId: rule.targetTenantId ?? null },
    );
    return { ...level, previousChoice: "off" as const, ...from };
  } catch {
    return from;
  }
}

/** Held rules that one cron invocation reads. */
export const HOLD_SWEEP_RULES = 4;

/** The most that the release of held rules costs: two accounts and a sync per rule, one D1 step. */
export const HOLD_SWEEP_SUBREQUESTS = 3 * HOLD_SWEEP_RULES + 1;

export interface HeldRule {
  ruleId: string;
  userId: string;
  orgId: string;
  sourceAccountId: string;
  targetAccountId: string;
  /** Options, addresses and tenants, for the level that the restored rule's audit row names. */
  optionsJson?: string;
  sourceEmail?: string;
  sourceTenantId?: string | null;
  targetEmail?: string;
  targetTenantId?: string | null;
}

/**
 * The rules whose holds ended their lease, as many as `budget` can release, those that waited longest
 * first. A rule that waits gets a new lease, so it goes behind the others. A rule stays out while a
 * request holds it within its lease.
 */
export function heldRulesStatement(
  env: Env,
  now: number,
  budget: number = HOLD_SWEEP_SUBREQUESTS,
): D1PreparedStatement {
  const limit = Math.max(0, Math.min(HOLD_SWEEP_RULES, Math.floor((budget - 1) / 2)));
  return env.DB.prepare(
    `SELECT r.id AS ruleId, r.user_id AS userId, u.org_id AS orgId,
       sc.account_id AS sourceAccountId, tc.account_id AS targetAccountId,
       r.options AS optionsJson, sa.email AS sourceEmail, sa.tenant_id AS sourceTenantId,
       ta.email AS targetEmail, ta.tenant_id AS targetTenantId
     FROM rules r
     JOIN users u ON u.id = r.user_id
     JOIN calendars sc ON sc.id = r.source_calendar_id
     JOIN calendars tc ON tc.id = r.target_calendar_id
     LEFT JOIN accounts sa ON sa.id = sc.account_id
     LEFT JOIN accounts ta ON ta.id = tc.account_id
     WHERE EXISTS (SELECT 1 FROM rule_holds h WHERE h.rule_id = r.id)
       AND NOT EXISTS (SELECT 1 FROM rule_holds h WHERE h.rule_id = r.id AND h.until > ?)
     ORDER BY (SELECT MAX(h.until) FROM rule_holds h WHERE h.rule_id = r.id), r.id LIMIT ?`,
  ).bind(now, limit);
}

/**
 * Run the rules whose request failed and left its hold, or died. A failed D1 write in that request
 * or two failed requests in a row lose nothing: the holds name the rules. A rule waits while an
 * account of it retires or gives no answer. A reconnect ends a retirement, so a later call starts
 * the rule. An account without tokens that retires does not end by itself, so its rule waits until
 * a reconnect, and the order of `heldRulesStatement()` keeps it from blocking others. Only holds past their lease go:
 * a newer request may have stopped the rule since the read, and its hold keeps the rule off in the
 * same D1 step. With a small `budget`, the sync of a rule waits for its next tick. Returns the
 * subrequests that this call made.
 */
export async function releaseHeldRules(
  env: Env,
  held: HeldRule[],
  now: number,
  budget: number = HOLD_SWEEP_SUBREQUESTS,
): Promise<number> {
  if (held.length === 0) return 0;
  const accounts = [...new Set(held.flatMap((r) => [r.sourceAccountId, r.targetAccountId]))];
  const retiring = await retiringAccounts(env, accounts);
  const waits = held.filter(
    (rule) => retiring.has(rule.sourceAccountId) || retiring.has(rule.targetAccountId),
  );
  const runs = held.filter((rule) => !waits.includes(rule));
  await env.DB.batch([
    ...waits.map((rule) =>
      env.DB.prepare("UPDATE rule_holds SET until = ? WHERE rule_id = ?").bind(
        now + HOLD_LEASE_MS,
        rule.ruleId,
      ),
    ),
    ...runs.flatMap((rule) => [
      env.DB.prepare("DELETE FROM rule_holds WHERE rule_id = ? AND until <= ?").bind(
        rule.ruleId,
        now,
      ),
      startUnlessHeld(env, rule.ruleId),
      auditStatement(
        env.DB,
        {
          orgId: rule.orgId,
          userId: rule.userId,
          accountId: rule.targetAccountId,
          ruleId: rule.ruleId,
          kind: "rule_enabled",
          detail: { restored: true, ...restoredLevel(env, rule) },
        },
        "rule_runs",
      ),
    ]),
  ]);
  const made = accounts.length + 1;
  const syncs = runs.slice(0, Math.max(0, budget - made));
  for (const { targetAccountId } of syncs) {
    try {
      await accountSync(env, targetAccountId).requestSync();
    } catch (error) {
      console.error("Starting a sync failed", targetAccountId, ...errorLogFields(error));
    }
  }
  return made + syncs.length;
}
