import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { CONTENT_SECURITY_POLICY } from "../src/request-guard";
import { CHROME_COLORS } from "../src/pages/next/shell";
import { BASE, signIn } from "./helpers";

/** The policy before `manifest-src` was added (header of `/` on 2026-11-17). */
const CSP_BEFORE =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

async function page(path: string, cookie?: string): Promise<string> {
  const response = await exports.default.fetch(`${BASE}${path}`, {
    headers: cookie ? { cookie } : {},
    redirect: "manual",
  });
  expect(response.status, path).toBe(200);
  return response.text();
}

describe("content security policy", () => {
  it("adds manifest-src 'self' and changes nothing else", () => {
    expect(CONTENT_SECURITY_POLICY).toContain("manifest-src 'self'");
    expect(CONTENT_SECURITY_POLICY.replace("manifest-src 'self'; ", "")).toBe(CSP_BEFORE);
  });

  it("sends it on a page", async () => {
    const response = await exports.default.fetch(`${BASE}/privacy`);
    expect(response.headers.get("content-security-policy")).toBe(CONTENT_SECURITY_POLICY);
  });
});

describe("the head of the app pages and the public pages", () => {
  it("links the manifest and the icons, and sets viewport and theme colours", async () => {
    const { cookie } = await signIn("app-shell@org.example");
    const pages = [
      await page("/", cookie),
      await page("/calendars", cookie),
      await page("/privacy"),
      await page("/"),
    ];
    for (const html of pages) {
      expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest"/>');
      expect(html).toContain(
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>',
      );
      expect(html).toContain(
        '<link rel="apple-touch-icon" href="/app-icons/apple-touch-icon.png"/>',
      );
      expect(html).toContain('<meta name="apple-mobile-web-app-title" content="slotmirror"/>');
      const colours = [
        ...html.matchAll(/<meta name="theme-color" content="(#[0-9a-f]{6})" media="([^"]+)"/g),
      ];
      expect(colours.map((m) => [m[2], m[1]])).toEqual([
        ["(prefers-color-scheme: light)", CHROME_COLORS.light],
        ["(prefers-color-scheme: dark)", CHROME_COLORS.dark],
      ]);
      // The strict policy allows no inline script.
      for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) expect(tag).toMatch(/\ssrc="/);
      expect(html).not.toMatch(/<script\b[^>]*>[^<]+<\/script>/i);
    }
  });
});
