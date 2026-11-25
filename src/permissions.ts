import * as z from "zod/mini";
import type { Role } from "./access";

/**
 * Every action that a route or an MCP tool can ask for, as `subject:verb`. The names map 1:1 to a
 * later rule engine (`can("read", "Rule")`). Data still belongs to one user each; the SQL of each
 * route filters by `user_id`, and this catalog does not replace that.
 */
export const ACTIONS = [
  "accounts:read",
  "accounts:write",
  "rules:read",
  "rules:write",
  "activity:read",
  "account:delete",
  "tokens:read",
  "tokens:create",
  "tokens:revoke",
  "apps:connect",
  "mcp:read",
  "mcp:write",
  "events:read",
  "users:read",
  "users:manage",
  "org:audit",
  "org:operate",
  "org:policy",
  "dev:tools",
] as const;

export type Action = (typeof ACTIONS)[number];

/** Whether members, not only admins, may use MCP. Stored in `orgs.mcp_for_members`. */
export const mcpForMembersSchema = z.enum(["off", "all"]);
export type McpForMembers = z.infer<typeof mcpForMembersSchema>;

/** A value from the database. Anything unknown counts as "off", so that a bad row opens nothing. */
export function parseMcpForMembers(raw: unknown): McpForMembers {
  const parsed = mcpForMembersSchema.safeParse(raw);
  return parsed.success ? parsed.data : "off";
}

/** What `can` needs to know about a user. The values come with the user, without another query. */
export interface Principal {
  role: Role;
  mcpForMembers: McpForMembers;
}

/** The actions of a user's own data, which every admitted user has. */
const SELF_SERVICE: readonly Action[] = [
  "accounts:read",
  "accounts:write",
  "rules:read",
  "rules:write",
  "activity:read",
  "account:delete",
  "tokens:read",
  // Revoking gives up access. A user keeps it after the org turns MCP off for members.
  "tokens:revoke",
];

/**
 * The actions that the org's MCP setting gives members. `events:read` also needs a credential that
 * the user allowed to read events, and MCP_EVENTS_ENABLED=1; see `credentialActions`.
 */
const MEMBER_MCP: readonly Action[] = ["tokens:create", "apps:connect", "mcp:read", "events:read"];

const ADMIN_ONLY: readonly Action[] = [
  "users:read",
  "users:manage",
  "org:audit",
  "org:operate",
  "org:policy",
  "dev:tools",
];

/** Actions that exist only while the deployment has MCP_ENABLED=1. Their routes are 404 without. */
export const MCP_ACTIONS: ReadonlySet<Action> = new Set<Action>([...MEMBER_MCP, "mcp:write"]);

// The three possible sets, built once: `can` runs several times per request.
const ADMIN_GRANTS: ReadonlySet<Action> = new Set([...SELF_SERVICE, ...MEMBER_MCP, ...ADMIN_ONLY]);
const MEMBER_GRANTS: ReadonlySet<Action> = new Set([...SELF_SERVICE, ...MEMBER_MCP]);
const MEMBER_GRANTS_WITHOUT_MCP: ReadonlySet<Action> = new Set(SELF_SERVICE);

/**
 * The actions of a user from slotmirror's own roles and org settings. Another source, such as
 * roles from the identity provider, may only remove actions from this set, never add one.
 * `mcp:write` belongs to nobody until a tool writes.
 */
export function nativeGrants(principal: Principal): ReadonlySet<Action> {
  if (principal.role === "admin") return ADMIN_GRANTS;
  return principal.mcpForMembers === "all" ? MEMBER_GRANTS : MEMBER_GRANTS_WITHOUT_MCP;
}

export function can(principal: Principal, action: Action): boolean {
  return nativeGrants(principal).has(action);
}

/** The items whose action the principal has, such as the MCP tools a user may see and call. */
export function permitted<T extends { action: Action }>(
  principal: Principal,
  items: readonly T[],
): T[] {
  const grants = nativeGrants(principal);
  return items.filter((item) => grants.has(item.action));
}

/** OAuth scope of the MCP tools that read sync state. Every credential has it. */
export const READ_SCOPE = "mcp:read";
/** OAuth scope of the tool that reads calendar events. Only a credential the user allowed has it. */
export const EVENTS_SCOPE = "mcp:events";

/**
 * The MCP actions that a credential carries, from its stored scope. A personal token stores
 * `read` or `read events`, an OAuth grant `mcp:read` or `mcp:read mcp:events`. Tokens and grants
 * from before event access store only the read scope, so they never gain `events:read`. The role
 * still decides as well: an action counts only if `can` also grants it.
 */
export function credentialActions(scope: string): ReadonlySet<Action> {
  const words = new Set(scope.split(" "));
  const actions = new Set<Action>();
  if (words.has("read") || words.has(READ_SCOPE)) actions.add("mcp:read");
  if (words.has("events") || words.has(EVENTS_SCOPE)) actions.add("events:read");
  return actions;
}
