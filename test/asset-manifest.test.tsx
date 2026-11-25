import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ASSETS, ASSET_VERSION } from "../src/asset-manifest";
import { asset, FONT_URL, hashedAssetUrl } from "../src/pages/next/assets";
import { addAccount, BASE, signIn } from "./helpers";

const APP_PAGES = ["/", "/mirroring", "/calendars", "/activity"];

describe("asset()", () => {
  it("puts the content hash of a known file into the file name", () => {
    expect(asset("/next/base.css")).toBe(`/next/base.${ASSETS["/next/base.css"]}.css`);
    expect(asset("/next/vendor/idiomorph-0.8.0.min.js")).toBe(
      `/next/vendor/idiomorph-0.8.0.min.${ASSETS["/next/vendor/idiomorph-0.8.0.min.js"]}.js`,
    );
  });

  it("inserts the hash before the last extension only", () => {
    expect(hashedAssetUrl("/next/a.min.js", "0123456789")).toBe("/next/a.min.0123456789.js");
  });

  it("throws in tests for a path that is not in the manifest", () => {
    expect(() => asset("/next/typo.css")).toThrow(/asset-manifest/);
  });
});

describe("asset URLs in the app pages", () => {
  it("name the hashed files of the manifest, and the font carries its version in the name", async () => {
    const { user, cookie } = await signIn("asset-urls@org.example");
    await addAccount(user.id, "asset-a", "a@example.com");
    for (const path of APP_PAGES) {
      const response = await exports.default.fetch(`${BASE}${path}`, {
        headers: { cookie },
        redirect: "manual",
      });
      expect(response.status, path).toBe(200);
      const html = await response.text();
      expect(html, path).toContain(
        `<html lang="en" data-asset-v="${ASSET_VERSION}" data-app-base="">`,
      );
      const urls = [...html.matchAll(/(?:href|src)="(\/next\/[^"]+)"/g)].map((m) => m[1] ?? "");
      // Navigation links to /next pages are not files. Files have an extension.
      const files = urls.filter((url) => /\.(css|js|woff2)$/.test(url));
      expect(files.length, path).toBeGreaterThanOrEqual(3);
      // The hashed URLs that the manifest allows. The font is not hashed: the CSS names it.
      const allowed = new Set(
        Object.entries(ASSETS).map(([key, hash]) => hashedAssetUrl(key, hash)),
      );
      for (const url of files) {
        expect(url, url).not.toContain("?");
        if (url.endsWith(".woff2")) expect(url, url).toBe(FONT_URL);
        else expect(allowed.has(url), url).toBe(true);
      }
    }
  });
});
