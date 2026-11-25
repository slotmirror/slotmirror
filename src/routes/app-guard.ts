import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../app-env";

/** D1 time of the requests in flight, for the `Server-Timing` header. No user data. */
const timings = new WeakMap<Request, { d1: number }>();

/** Add the wall time of `work`, a D1 read, to the request's `d1` duration. */
export async function timedD1<T>(c: Context<AppEnv>, work: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    return await work();
  } finally {
    const timing = timings.get(c.req.raw);
    if (timing) timing.d1 += Date.now() - start;
  }
}

/**
 * Before every app page and its forms: a visitor without a session goes to the sign-in, which is
 * `/`. It also times the handler for `Server-Timing`. Each page router installs it for its own
 * paths, never with `use("*")` on the whole app: the Overview is `/`, and a catch-all here would
 * also catch the sign-in, the OAuth pages and the webhooks.
 */
export const appGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get("user")) return c.redirect("/");
  const start = Date.now();
  const timing = { d1: 0 };
  timings.set(c.req.raw, timing);
  await next();
  // Durations of the handler only: the session lookup runs before this middleware. Workers advance
  // the clock on I/O, so the D1 time is real and the CPU time is not part of it.
  if (c.res.headers.get("content-type")?.startsWith("text/html")) {
    c.header("Server-Timing", `d1;dur=${timing.d1}, total;dur=${Date.now() - start}`);
  }
};
