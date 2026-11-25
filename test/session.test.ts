import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import app from "../src/index";
import { devSignInEmail, signSession, verifySession } from "../src/session";
import { signIn } from "./helpers";

const SECRET = "test-session-secret-at-least-32-characters";

describe("session cookie", () => {
  it("round-trips a valid session", async () => {
    const session = { userId: "user-1", exp: Math.floor(Date.now() / 1000) + 60 };
    const token = await signSession(session, SECRET);
    expect(await verifySession(token, SECRET)).toEqual(session);
  });

  it("rejects an expired session", async () => {
    const token = await signSession({ userId: "user-1", exp: 1 }, SECRET);
    expect(await verifySession(token, SECRET)).toBeNull();
  });

  it("rejects a session signed with another secret", async () => {
    const session = { userId: "user-1", exp: Math.floor(Date.now() / 1000) + 60 };
    const token = await signSession(session, "another-secret-that-is-also-long-enough");
    expect(await verifySession(token, SECRET)).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const session = { userId: "user-1", exp: Math.floor(Date.now() / 1000) + 60 };
    const [, signature] = (await signSession(session, SECRET)).split(".");
    const forged = btoa(JSON.stringify({ ...session, userId: "user-2" }));
    expect(await verifySession(`${forged}.${signature}`, SECRET)).toBeNull();
  });

  it("rejects garbage", async () => {
    expect(await verifySession("not-a-token", SECRET)).toBeNull();
    expect(await verifySession(undefined, SECRET)).toBeNull();
  });
});

/** The variables of a local development server: simulated calendars, no public address. */
const DEV = { DEV_SIGN_IN_AS: "me@example.com", DEV_FAKE_CALENDARS: "1", PUBLIC_URL: "" };

/** A request as a local server receives it: the Host header names the host of the URL. */
const local = (headers: Record<string, string> = {}, url = "http://localhost:8787/rules") =>
  new Request(url, { headers: { Host: new URL(url).host, ...headers } });

describe("local sign-in without a provider", () => {
  it("signs in as DEV_SIGN_IN_AS on a local host", () => {
    expect(devSignInEmail(DEV, local())).toBe("me@example.com");
    expect(devSignInEmail({ ...DEV, DEV_SIGN_IN_AS: " me@example.com " }, local())).toBe(
      "me@example.com",
    );
    expect(devSignInEmail(DEV, local({}, "http://127.0.0.1:8811/"))).toBe("me@example.com");
    expect(devSignInEmail(DEV, local({}, "http://[::1]:8787/"))).toBe("me@example.com");
  });

  it("ignores the variable on any other host", () => {
    expect(devSignInEmail(DEV, local({}, "https://slotmirror.example.com/"))).toBeNull();
    expect(devSignInEmail(DEV, local({}, "https://localhost.example.com/"))).toBeNull();
    expect(devSignInEmail(DEV, local({}, "https://x.workers.dev/"))).toBeNull();
  });

  it("ignores the variable when the public address is not local, as behind a tunnel", () => {
    const at = (publicUrl: string) => devSignInEmail({ ...DEV, PUBLIC_URL: publicUrl }, local());
    expect(at("https://abc.ngrok.app")).toBeNull();
    expect(at("http://localhost:8787")).toBe("me@example.com");
    expect(at(" ")).toBe("me@example.com");
    // A public address without a scheme does not parse; the bypass stays off instead of failing.
    expect(at("example.com")).toBeNull();
    expect(at("localhost:8787")).toBeNull();
  });

  it("needs the simulated calendars as the development marker", () => {
    expect(devSignInEmail({ ...DEV, DEV_FAKE_CALENDARS: undefined }, local())).toBeNull();
    expect(devSignInEmail({ ...DEV, DEV_FAKE_CALENDARS: "" }, local())).toBeNull();
    expect(devSignInEmail({ ...DEV, DEV_FAKE_CALENDARS: "true" }, local())).toBeNull();
  });

  it("ignores the variable for a request that came through a proxy", () => {
    // A proxy on the same machine that forwards "Host: localhost" with PUBLIC_URL unset.
    for (const [name, value] of [
      ["X-Forwarded-For", "203.0.113.7"],
      ["X-Forwarded-For", "127.0.0.1"],
      ["Forwarded", "for=203.0.113.7;host=slotmirror.example.com"],
      ["X-Forwarded-Host", "slotmirror.example.com"],
      ["X-Real-IP", "203.0.113.7"],
      ["True-Client-IP", "203.0.113.7"],
      ["MF-Original-URL", "http://localhost:8787/rules"],
    ] as const) {
      expect(devSignInEmail(DEV, local({ [name]: value })), name).toBeNull();
    }
  });

  it("ignores the variable unless the Host header names the host of the URL", () => {
    // Miniflare takes the URL from MF-Original-URL, so a client can pick a local URL.
    expect(devSignInEmail(DEV, local({ Host: "evil.example" }))).toBeNull();
    expect(devSignInEmail(DEV, local({ Host: "127.0.0.1:8787" }))).toBeNull();
    expect(devSignInEmail(DEV, new Request("http://localhost:8787/rules"))).toBeNull();
    expect(devSignInEmail(DEV, local({ Host: "LOCALHOST:8787" }))).toBe("me@example.com");
    expect(devSignInEmail(DEV, local({ Host: "localhost" }))).toBe("me@example.com");
  });

  it("ignores the variable unless the connecting address is a loopback address", () => {
    const from = (ip: string) => devSignInEmail(DEV, local({ "CF-Connecting-IP": ip }));
    expect(from("127.0.0.1")).toBe("me@example.com");
    expect(from("127.10.0.3")).toBe("me@example.com");
    expect(from("::1")).toBe("me@example.com");
    expect(from("::ffff:127.0.0.1")).toBe("me@example.com");
    expect(from("192.168.1.20")).toBeNull();
    expect(from("203.0.113.7")).toBeNull();
    expect(from("2001:db8::1")).toBeNull();
    expect(from("127.0.0.1.example.com")).toBeNull();
    expect(from("")).toBeNull();
  });

  it("does nothing without the variable", () => {
    expect(devSignInEmail({ ...DEV, DEV_SIGN_IN_AS: undefined }, local())).toBeNull();
    expect(devSignInEmail({ ...DEV, DEV_SIGN_IN_AS: "  " }, local())).toBeNull();
  });
});

describe("local sign-in through the app", () => {
  // The admin of the test bindings; the bypass finds only an existing user.
  const devEnv = { ...env, DEV_SIGN_IN_AS: "admin@example.com", PUBLIC_URL: "" };
  const visit = (environment: Env, headers: Record<string, string> = {}) =>
    app.fetch(local(headers, "http://localhost:8787/mirroring"), environment);
  /** A visitor without a session goes to the start page. */
  const expectVisitor = (response: Response) => {
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
  };

  it("signs in on a local server and stays off behind a proxy or without the marker", async () => {
    await signIn("admin@example.com");
    expect((await visit(devEnv)).status).toBe(200);
    expectVisitor(await visit(devEnv, { "X-Forwarded-For": "203.0.113.7" }));
    expectVisitor(await visit(devEnv, { "CF-Connecting-IP": "203.0.113.7" }));
    expectVisitor(await visit(devEnv, { Host: "evil.example" }));
    expectVisitor(await visit({ ...devEnv, DEV_FAKE_CALENDARS: undefined }));
  });
});
