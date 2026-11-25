import type { Context } from "hono";
import type { AppEnv } from "../app-env";
import type { CurrentUser } from "../users";

/** The signed-in user of a route behind the sign-in redirect. Throws if the route lacks it. */
export function currentUser(c: Context<AppEnv>): CurrentUser {
  const user = c.get("user");
  if (!user) throw new Error("This route requires a signed-in user");
  return user;
}
