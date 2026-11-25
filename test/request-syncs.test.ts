import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestSyncs, setDirection } from "../src/editor";
import worker from "../src/index";
import { BASE, signIn } from "./helpers";
import { captureLogs } from "./telemetry";

/**
 * An environment whose `requestSync` throws for the accounts in `failing`, as a Durable Object
 * does when it is reset or overloaded. `asked` lists every account that was asked, in order.
 */
function failingSyncEnv(failing: (accountId: string) => boolean) {
  const asked: string[] = [];
  const ACCOUNT_SYNC = new Proxy(env.ACCOUNT_SYNC, {
    get(target, key) {
      if (key === "getByName") {
        return (name: string) =>
          new Proxy(target.getByName(name), {
            get(stub, method) {
              if (typeof method !== "string") return Reflect.get(stub, method) as unknown;
              // An RPC property is callable but has no `apply` or `call`, so call it as a method.
              return async (...args: unknown[]) => {
                if (method === "requestSync") {
                  asked.push(name);
                  if (failing(name)) throw new Error("Durable Object reset");
                }
                return (stub as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!(
                  ...args,
                );
              };
            },
          });
      }
      const value = Reflect.get(target, key) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { asked, env: { ...env, ACCOUNT_SYNC } as Env };
}

/** A user with two accounts, each with one main calendar. */
async function setup(prefix: string) {
  const { user, cookie } = await signIn(`${prefix}@org.example`);
  const ids = [`${prefix}-w`, `${prefix}-g`] as const;
  for (const [index, id] of ids.entries()) {
    const provider = index === 0 ? "microsoft" : "google";
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, ?, ?)",
      ).bind(id, user.id, provider, `${id}@mail.example`),
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, ?, 'Main', 1, 1, 1)",
      ).bind(`${id}-cal`, id, `${id}-remote`),
    ]);
    await env.ACCOUNT_SYNC.getByName(id).storeTokens(
      id,
      { refreshToken: "r", accessToken: "a", accessExpiresAt: Date.now() + 3_600_000 },
      provider,
    );
  }
  return { user, cookie, w: ids[0], g: ids[1] };
}

async function post(testEnv: Env, path: string, cookie: string, fields: Record<string, string>) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${BASE}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    }),
    testEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

let logs: ReturnType<typeof captureLogs>;

beforeEach(() => {
  logs = captureLogs();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("calendarView")) return Response.json({ value: [] });
    if (url.includes("googleapis.com/calendar")) return Response.json({ items: [] });
    return new Response("unexpected", { status: 500 });
  });
});

afterEach(() => {
  logs.restore();
  vi.restoreAllMocks();
});

describe("asking accounts to sync after a stored write", () => {
  it("asks every account, logs a failed one without content, and does not throw", async () => {
    const { w, g } = await setup("rs-unit");
    const failing = failingSyncEnv((id) => id === w);
    await expect(requestSyncs(failing.env, [w, g])).resolves.toBeUndefined();
    // The failure of the first account does not skip the second one.
    expect(failing.asked).toEqual([w, g]);
    const records = logs.find("sync.request_failed");
    expect(records.map((record) => record.fields.accountId)).toEqual([w]);
    expect(records[0]?.level).toBe("error");
    expect(records[0]?.fields).toMatchObject({ accountId: w });
    // The logger keeps the kind of error, never its raw message.
    expect(records[0]?.error?.name).toBe("Error");
    expect(records[0]?.error?.message).toBeUndefined();
  });

  it("answers a mirroring save as saved when the sync request fails", async () => {
    const { user, cookie, w, g } = await setup("rs-mirror");
    await setDirection(env, user, w, g, "busy");
    const failing = failingSyncEnv(() => true);
    const response = await post(failing.env, "/mirroring", cookie, {
      scope: "direction",
      from: w,
      to: g,
      copy: "title",
      who: "private",
      back: `/mirroring?d=${w}~${g}&saved=1`,
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/mirroring?d=${w}~${g}&saved=1`);
    expect(failing.asked).toContain(g);
    expect(logs.find("sync.request_failed").map((record) => record.fields.accountId)).toContain(g);
  });

  it("answers a save of the settings for all mirrorings as saved when the sync request fails", async () => {
    const { user, cookie, w, g } = await setup("rs-all");
    await setDirection(env, user, w, g, "busy");
    const failing = failingSyncEnv(() => true);
    const response = await post(failing.env, "/mirroring", cookie, {
      scope: "all",
      back: "/mirroring?d=all&saved=1",
      daysAhead: "30",
      daysAheadShown: "60",
      skipAllDayShown: "0",
      markPrivateShown: "0",
      blockTitle: "Away",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/mirroring?d=all&saved=1");
    expect(failing.asked).toContain(g);
  });

  it("answers a calendar save as saved when the sync request fails", async () => {
    const { user, cookie, w, g } = await setup("rs-cal");
    await setDirection(env, user, g, w, "busy");
    const failing = failingSyncEnv(() => true);
    const body: Record<string, string> = {
      back: `/calendars?c=${w}&saved=1`,
      workHoursShown: "1",
      workHoursOn: "1",
      workStart: "08:00",
      workEnd: "18:00",
      workTimeZone: "Europe/Vienna",
      workDays: "1",
    };
    const response = await post(failing.env, `/calendars/${w}`, cookie, body);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/calendars?c=${w}&saved=1`);
    expect(failing.asked).toContain(w);
  });
});
