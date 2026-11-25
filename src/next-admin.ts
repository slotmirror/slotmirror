import type { Role } from "./access";
import { errorCode, recordAudit } from "./audit";
import { accountSync } from "./durable";
import { mcpForMembersSchema, type McpForMembers } from "./permissions";
import { carrier, log } from "./telemetry";

/**
 * What the admin page of the redesign reads and writes. The queries are those of the old admin
 * routes in `src/app.tsx`, so that both pages show and change the same data in the same org. Every
 * query filters by the admin's org. The route handlers and pages of the redesign hold no SQL.
 */

/** One person of the admin's org, with counts only: no calendar data, no token. */
export interface AdminUser {
  id: string;
  email: string;
  role: Role;
  lastSignInAt: string | null;
  /** Connected calendars (accounts) of the person. */
  accounts: number;
  /** Accounts whose refresh token the provider refused. */
  needsReconnect: number;
  /** API tokens of the person, also expired ones, plus live app grants. */
  apiTokens: number;
}

/** The people of an org with their counts, by address. */
export async function adminUsers(db: D1Database, orgId: string): Promise<AdminUser[]> {
  const { results } = await db
    .prepare(
      `SELECT u.id, u.email, u.role, u.last_sign_in_at AS lastSignInAt,
              COUNT(a.id) AS accounts,
              COALESCE(SUM(a.needs_reconnect), 0) AS needsReconnect,
              (SELECT COUNT(*) FROM api_tokens t WHERE t.user_id = u.id)
                + (SELECT COUNT(*) FROM oauth_grants g WHERE g.user_id = u.id
                     AND g.refresh_expires_at > ?2 AND g.expires_at > ?2) AS apiTokens
       FROM users u LEFT JOIN accounts a ON a.user_id = u.id
       WHERE u.org_id = ?1
       GROUP BY u.id
       ORDER BY u.email`,
    )
    .bind(orgId, new Date().toISOString())
    .all<AdminUser>();
  return results;
}

/**
 * A person of the admin's org other than the admin, or null. A person of another org, a missing
 * ID and the admin itself all give null, so a route answers 404 for each.
 */
export async function otherUserOfOrg(
  db: D1Database,
  admin: { id: string; orgId: string },
  userId: string,
): Promise<{ id: string; email: string } | null> {
  if (userId === admin.id) return null;
  return db
    .prepare("SELECT id, email FROM users WHERE id = ? AND org_id = ?")
    .bind(userId, admin.orgId)
    .first<{ id: string; email: string }>();
}

/** Set whether members may use MCP. Return false if the value was already set, so nothing is logged. */
export async function setMcpForMembers(
  env: Env,
  admin: { id: string; orgId: string },
  value: McpForMembers,
): Promise<boolean> {
  const updated = await env.DB.prepare(
    "UPDATE orgs SET mcp_for_members = ? WHERE id = ? AND mcp_for_members IS NOT ?",
  )
    .bind(value, admin.orgId, value)
    .run();
  if (!updated.meta.changes) return false;
  await recordAudit(env.DB, {
    orgId: admin.orgId,
    userId: admin.id,
    kind: "mcp_policy_changed",
    detail: { mcpForMembers: value },
  });
  return true;
}

/** The setting of a form field, or null if it holds neither "off" nor "all". */
export function parseMcpChoice(value: unknown): McpForMembers | null {
  const parsed = mcpForMembersSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Start a comparison of every calendar of the org that a mirroring writes into, and of the
 * writable calendars without one. It costs one Durable Object call per account, as the old
 * button does; the alarms read the calendars. One failing account does not stop the others.
 */
export async function startOrgCompares(
  env: Env,
  orgId: string,
): Promise<{ started: number; open: number; failed: number }> {
  const { results } = await env.DB.prepare(
    `SELECT a.id FROM accounts a JOIN users u ON u.id = a.user_id WHERE u.org_id = ?`,
  )
    .bind(orgId)
    .all<{ id: string }>();
  const total = { started: 0, open: 0, failed: 0 };
  for (const { id } of results) {
    try {
      const { started, open, failed } = await accountSync(env, id).startCompares("full", carrier());
      total.started += started;
      total.open += open;
      total.failed += failed;
    } catch (error) {
      log.error("compare.start_failed", { accountId: id, code: errorCode(error) }, error);
      total.failed++;
    }
  }
  return total;
}

/** A count from a query string, or 0 if it is none. */
export function countParam(value: string | undefined): number {
  const count = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}
