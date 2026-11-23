import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { APP_BASE, appPath, isAppPagePath } from "../src/app-base";
import { asset } from "../src/pages/next/assets";
import { addAccount, BASE, signIn } from "./helpers";

const get = (path: string, cookie?: string) =>
  exports.default.fetch(`${BASE}${path}`, {
    headers: cookie ? { cookie } : {},
    redirect: "manual",
  });

const post = (path: string, cookie: string, body: Record<string, string> = {}) =>
  exports.default.fetch(`${BASE}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: BASE },
    body: new URLSearchParams(body),
  });

describe("the app base", () => {
  it("puts the Overview at the base and the pages below it", () => {
    expect(APP_BASE).toBe("");
    expect(appPath("/")).toBe("/");
    expect(appPath("/mirroring")).toBe("/mirroring");
    for (const path of ["/", "/mirroring", "/calendars", "/activity", "/admin", "/tokens"]) {
      expect(isAppPagePath(path), path).toBe(true);
    }
    for (const path of ["/rules", "/next", "/privacy", "/admin/users/x/delete", "/mirroring/x"]) {
      expect(isAppPagePath(path), path).toBe(false);
    }
  });

  it("tells the scripts the base on the html element", async () => {
    const { cookie } = await signIn("base@org.example");
    const html = await (await get("/mirroring", cookie)).text();
    expect(html).toMatch(/<html [^>]*data-app-base=""/);
  });
});

describe("the pages of the previous release below /next", () => {
  const PAGES: [string, string][] = [
    ["/next", "/"],
    ["/next/mirroring", "/mirroring"],
    ["/next/calendars", "/calendars"],
    ["/next/activity", "/activity"],
    ["/next/tokens", "/tokens"],
    ["/next/admin", "/admin"],
  ];

  it("answer 308 to the same page without the prefix, for a visitor too", async () => {
    for (const [from, to] of PAGES) {
      const response = await get(from);
      expect(response.status, from).toBe(308);
      expect(response.headers.get("location"), from).toBe(to);
    }
  });

  it("keep no redirect in a cache, so that a rollback finds the old pages again", async () => {
    // A browser keeps a 301 or 308 without Cache-Control for good. After a rollback to the
    // previous release, the old address would still lead to the new page, which then is a 404.
    const { cookie } = await signIn("moved-no-store@org.example");
    const visits: [string, string | undefined][] = [
      ...PAGES.map(([from]): [string, undefined] => [`${from}?lang=de`, undefined]),
      ["/next/mirroring?d=a~b", cookie],
    ];
    for (const [from, headers] of visits) {
      const response = await get(from, headers);
      expect(response.status, from).toBe(308);
      expect(response.headers.get("cache-control"), from).toBe("no-store");
    }
  });

  it("keep the query string", async () => {
    const cases: [string, string][] = [
      ["/next/mirroring?d=a~b&saved=1", "/mirroring?d=a~b&saved=1"],
      ["/next/calendars?c=x&from=a~b", "/calendars?c=x&from=a~b"],
      ["/next/activity?kind=problems&before=12", "/activity?kind=problems&before=12"],
      ["/next/admin?tab=health", "/admin?tab=health"],
      ["/next?lang=de", "/?lang=de"],
    ];
    for (const [from, to] of cases) {
      const response = await get(from);
      expect(response.status, from).toBe(308);
      expect(response.headers.get("location"), from).toBe(to);
    }
  });

  it("never redirect an asset path", async () => {
    // The assets layer answers a real file before the Worker runs. A path that holds no file
    // reaches the Worker: it must stay a 404 and must not point to a path that holds no file.
    const paths = [
      asset("/next/base.css"),
      asset("/next/mirroring.js"),
      asset("/next/admin.css"),
      "/next/mirroring.js",
      "/next/activity.css",
      "/next/calendars.abc1234567.js",
      "/next/tokens.js",
      "/next/fonts/inter-4.001.woff2",
      "/next/vendor/idiomorph-0.8.0.min.js",
      "/next/mirroring/x",
      "/next/nope",
    ];
    for (const path of paths) {
      const response = await get(path);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("location"), path).toBeNull();
    }
  });

  it("keep the POST endpoints working, with a redirect to the new page", async () => {
    const { cookie } = await signIn("legacy-post@org.example");
    // The same endpoint at the new and at the old address.
    for (const path of ["/calendars/refresh", "/next/calendars/refresh"]) {
      const response = await post(path, cookie, { back: "/calendars" });
      expect(response.status, path).toBe(303);
      expect(response.headers.get("location"), path).toBe("/calendars");
    }
    // A stale form posts the old prefix in `back`. It names no page now: the fallback decides.
    const stale = await post("/next/calendars/refresh", cookie, { back: "/next/calendars" });
    expect(stale.status).toBe(303);
    expect(stale.headers.get("location")).toBe("/calendars");
    const mirroring = await post("/next/mirroring", cookie, {});
    expect(mirroring.status).toBeLessThan(500);
    expect(mirroring.headers.get("location") ?? "").not.toContain("/next");
  });
});

describe("the address of the old rules page", () => {
  it("answers 301 to the Mirroring page, signed in or not", async () => {
    const { cookie } = await signIn("rules-301@org.example");
    for (const headers of [undefined, cookie]) {
      const response = await get("/rules", headers);
      expect(response.status).toBe(301);
      expect(response.headers.get("location")).toBe("/mirroring");
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("moves the org activity of the admin page to the Activity page", async () => {
    const { cookie } = await signIn("admin@example.com");
    const response = await get("/admin/activity", cookie);
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/activity?scope=org");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("the start page", () => {
  it("shows the sign-in to a visitor", async () => {
    const response = await get("/");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('href="/auth/microsoft/login"');
    expect(html).not.toContain("data-app-base");
  });

  it("shows the Overview to a signed-in user, with the server timing", async () => {
    const { user, cookie } = await signIn("start-overview@org.example");
    await addAccount(user.id, "start-a", "start-a@example.com");
    const response = await get("/", cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get("server-timing")).toMatch(/^d1;dur=\d+, total;dur=\d+$/);
    const html = await response.text();
    expect(html).toMatch(/<html [^>]*data-app-base=""/);
    expect(html).toContain('aria-current="page"');
    expect(html).toContain(asset("/next/overview.css"));
  });

  it("does not run the page guard for the pages outside the app", async () => {
    // A catch-all guard on the whole app would send a visitor of the privacy page to `/`.
    const response = await get("/privacy");
    expect(response.status).toBe(200);
  });
});
