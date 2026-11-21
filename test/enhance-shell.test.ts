import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { de } from "../src/i18n/de";
import { en } from "../src/i18n/en";
import { asset } from "../src/pages/next/assets";
import { appScripts, ENHANCED_NAVIGATION } from "../src/pages/next/shell";
import { addAccount, BASE, signIn } from "./helpers";

/**
 * What enhanced navigation (`public/next/enhance.js`) needs from the server. A merged body runs no
 * script, so every script sits in the head, and the list is the same on every app page:
 * `enhance.js` takes a different list for a new deploy and loads the page fully.
 */

const ADMIN = "admin@example.com";

async function get(path: string, cookie?: string, language = "en") {
  const response = await exports.default.fetch(`${BASE}${path}`, {
    headers: { ...(cookie ? { cookie } : {}), "accept-language": language },
    redirect: "manual",
  });
  return { status: response.status, html: await response.text() };
}

function split(html: string) {
  const at = html.indexOf("</head>");
  expect(at, "the page has a head").toBeGreaterThan(0);
  return { head: html.slice(0, at), body: html.slice(at) };
}

/** Every `<script>` tag of the head, as written. */
const scriptTags = (head: string) => [...head.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);

const PAGES = [
  "/",
  "/mirroring",
  "/mirroring?d=all",
  "/calendars",
  "/calendars?c=enh-a",
  "/activity",
  "/admin",
  "/tokens",
];

/** The admin with two calendars, made once for the file (the database lives as long as it). */
let admin: Promise<string> | undefined;
function signedInAdmin() {
  admin ??= (async () => {
    const { user, cookie } = await signIn(ADMIN);
    for (const [id, email] of [
      ["enh-a", "a@example.com"],
      ["enh-b", "b@example.com"],
    ] as const) {
      await addAccount(user.id, id, email);
      // A main calendar each, so that the Mirroring page lists both directions.
      await env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, 'r', 'Main', 1, 1, 1)",
      )
        .bind(`${id}-cal`, id)
        .run();
    }
    return cookie;
  })();
  return admin;
}

describe("the head and body of the app pages for enhanced navigation", () => {
  it("loads the same scripts from the head on every app page, theme.js first and blocking", async () => {
    const cookie = await signedInAdmin();
    const expected = [
      `<script src="${asset("/next/theme.js")}">`,
      ...appScripts().map((src) => `<script src="${asset(src)}" defer="">`),
    ];
    for (const path of PAGES) {
      const { status, html } = await get(path, cookie);
      expect(status, path).toBe(200);
      const { head } = split(html);
      expect(scriptTags(head), path).toEqual(expected);
    }
  });

  it("has no script in the body of any app page", async () => {
    const cookie = await signedInAdmin();
    for (const path of PAGES) {
      const { body } = split((await get(path, cookie)).html);
      expect(body, path).not.toContain("<script");
    }
  });

  it("marks the app pages, focuses the page heading and has no id twice", async () => {
    const cookie = await signedInAdmin();
    for (const path of PAGES) {
      const { html } = await get(path, cookie);
      const { body } = split(html);
      expect(body, path).toContain('<body class="app" data-app="next">');
      expect(body, path).toMatch(/<h1 class="page-title" id="page-title" tabindex="-1">/);
      const ids = [...body.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
      const twice = ids.filter((id, i) => ids.indexOf(id) !== i);
      expect(twice, path).toEqual([]);
    }
  });

  it("gives the list rows and the panel the ids that the merge matches by", async () => {
    const cookie = await signedInAdmin();
    const mirroring = (await get("/mirroring?d=enh-a~enh-b", cookie)).html;
    expect(mirroring).toContain('id="row-m-enh-a~enh-b"');
    expect(mirroring).toContain('id="row-m-enh-b~enh-a"');
    expect(mirroring).toContain('<aside class="detail" id="detail"');
    expect(mirroring).toContain('id="detail-form"');
    const calendars = (await get("/calendars", cookie)).html;
    expect(calendars).toContain('id="row-c-enh-a"');
  });

  it("puts the live region's texts in the markup, in the page language", async () => {
    const cookie = await signedInAdmin();
    for (const [language, text, panel] of [
      ["en", en.next.shell.enhance, en.next.shell.panel],
      ["de", de.next.shell.enhance, de.next.shell.panel],
    ] as const) {
      const { body } = split((await get("/mirroring", cookie, language)).html);
      const region = body.match(/<div id="announcer"[^>]*>/)?.[0] ?? "";
      expect(region, language).toContain('aria-live="polite"');
      expect(region, language).toContain("data-morph-keep");
      for (const [attr, value] of [
        ["saved", text.saved],
        ["updated", text.updated],
        ["loading", text.loading],
        ["error-network", text.errorNetwork],
        ["error-server", text.errorServer],
        ["session-ended", panel.sessionEnded],
      ]) {
        expect(value, `${language} ${attr}`).not.toBe("");
        expect(region, `${language} ${attr}`).toContain(`data-msg-${attr}="${value}"`);
      }
    }
  });

  it("leaves empty activity filters out of the address with enhance (data-omit-empty)", async () => {
    const cookie = await signedInAdmin();
    const { html } = await get("/activity", cookie);
    expect(html).toMatch(/<form[^>]*class="act-filters"[^>]*data-omit-empty/);
  });

  it("hides script-only controls by CSS, not by the hidden attribute a merge would bring back", async () => {
    const cookie = await signedInAdmin();
    const { html } = await get("/mirroring", cookie);
    const row = html.match(/<div class="menu-row" data-needs-script[^>]*>/)?.[0] ?? "";
    expect(row).not.toBe("");
    expect(row).not.toContain("hidden");
  });

  it("drops Idiomorph and enhance.js at the kill switch, and keeps the page scripts", () => {
    expect(appScripts("never")).toEqual([
      "/next/panel.js",
      "/next/mirroring.js",
      "/next/calendars.js",
      "/next/activity.js",
      "/next/tokens.js",
      "/next/palette.js",
    ]);
    expect(appScripts("on").slice(0, 2)).toEqual([
      "/next/vendor/idiomorph-0.8.0.min.js",
      "/next/enhance.js",
    ]);
    expect(appScripts("off")).toEqual(appScripts("on"));
    expect(["on", "off", "never"]).toContain(ENHANCED_NAVIGATION);
  });

  it("states the default on the root only while it is off", async () => {
    const cookie = await signedInAdmin();
    const { html } = await get("/", cookie);
    const root = html.match(/<html[^>]*>/)?.[0] ?? "";
    if (ENHANCED_NAVIGATION === "off") expect(root).toContain('data-enhance-default="off"');
    else expect(root).not.toContain("data-enhance-default");
  });

  it("does not enhance the public pages", async () => {
    const { status, html } = await get("/");
    expect(status).toBe(200);
    expect(html).not.toContain("/next/enhance.js");
    expect(html).not.toContain("idiomorph");
    expect(html).not.toContain('data-app="next"');
  });
});
