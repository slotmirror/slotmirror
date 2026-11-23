import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { OUT_DIR } from "../scripts/asset-manifest-lib.mjs";

const SERVED_DIR = join(OUT_DIR, "next");

/**
 * Size budgets for what the browser downloads from `public/next/`: the MINIFIED files in the served
 * folder `dist/public/next/` (`scripts/asset-manifest-lib.mjs`), not the sources. The numbers are
 * bytes, with 1 KB = 1000 B. Gzip is level 9 and is the main budget, because it is what travels.
 * Raw is a parse ceiling for the browser. The font is already compressed, so only its raw size counts.
 *
 * Measured 2026-11-18 after the first redesign milestone (raw / gzip):
 *
 *   base.css       38,756 / 8,516      theme.js       1,545 /   750     activity.js    769 / 375
 *   overview.css    7,651 / 1,895      enhance.js    16,484 / 6,627     tokens.js      587 / 375
 *   mirroring.css  11,044 / 1,874      panel.js      12,441 / 4,324     calendars.js   905 / 481
 *   calendars.css   2,560 /   891      palette.js     7,682 / 3,312     mirroring.js   963 / 512
 *   activity.css    2,961 /   982      idiomorph     10,587 / 3,770     public.js      818 / 460
 *   admin.css       3,237 / 1,050      public.css     5,129 / 1,335
 *   inter-4.001.woff2  48,256 raw
 *
 *   App page JS (every script except public.js): 51,963 / 20,526.
 *   Largest app page CSS, base + mirroring: 49,800 / 10,390.
 *   Public page (base + public.css + theme.js + public.js): 46,248 / 11,061.
 *
 * Before minification (the sources): app page JS 107,956 / 35,856, base + mirroring 84,895 / 21,375.
 *
 * The first targets were JS 50 / 19.5, enhance.js 16 / 6.5 and CSS 45 / 10. The real numbers at that
 * milestone are above them by 3 to 9 percent, so the budgets below are the measured value plus a margin
 * of about 5 percent of gzip and 6 percent of raw. One feature-sized addition will not fit. That is
 * the point: raise a budget in the same commit as the feature, with the reason.
 */
const KB = 1000;
const BUDGET = {
  /** Every script of an app page (all except `public.js`). Each page loads the same set. */
  jsRaw: 55 * KB,
  jsGzip: 21.5 * KB,
  /** `enhance.js` alone. */
  enhanceRaw: 17.5 * KB,
  enhanceGzip: 7 * KB,
  /** `base.css` plus the largest page stylesheet. */
  cssRaw: 52 * KB,
  cssGzip: 11 * KB,
  baseCssRaw: 41 * KB,
  baseCssGzip: 9 * KB,
  /** The public pages (sign-in, error pages): base.css, public.css, theme.js, public.js. */
  publicRaw: 49 * KB,
  publicGzip: 11.7 * KB,
  fontRaw: 50 * KB,
} as const;

interface Size {
  raw: number;
  gzip: number;
}

function sizes(dir: string, ext: string): Map<string, Size> {
  const found = new Map<string, Size>();
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith(ext)) continue;
    const file = join(entry.parentPath, entry.name);
    const data = readFileSync(file);
    // `base.a1b2c3d4e5.css` is `base.css` here. Other files keep their name (`fonts/...`).
    const name = file.slice(dir.length + 1).replace(/\.[0-9a-f]{10}(\.(?:css|js))$/, "$1");
    found.set(name, {
      raw: data.length,
      gzip: gzipSync(data, { level: 9 }).length,
    });
  }
  return found;
}

const total = (files: Iterable<Size>): Size =>
  [...files].reduce((sum, s) => ({ raw: sum.raw + s.raw, gzip: sum.gzip + s.gzip }), {
    raw: 0,
    gzip: 0,
  });

const js = sizes(SERVED_DIR, ".js");
const css = sizes(SERVED_DIR, ".css");
const fonts = sizes(SERVED_DIR, ".woff2");

describe("performance budget of the served files in dist/public/next", () => {
  it("keeps the scripts of an app page within the budget", () => {
    const appScripts = [...js].filter(([name]) => name !== "public.js");
    expect(appScripts.map(([name]) => name)).toContain("enhance.js");
    expect(appScripts.map(([name]) => name)).toContain("vendor/idiomorph-0.8.0.min.js");
    const sum = total(appScripts.map(([, size]) => size));
    expect(sum.raw, `JS raw ${sum.raw} B`).toBeLessThanOrEqual(BUDGET.jsRaw);
    expect(sum.gzip, `JS gzip ${sum.gzip} B`).toBeLessThanOrEqual(BUDGET.jsGzip);
  });

  it("keeps enhance.js within the budget", () => {
    const enhance = js.get("enhance.js");
    if (!enhance) throw new Error("enhance.js is missing from the served folder");
    expect(enhance.raw, `enhance.js raw ${enhance.raw} B`).toBeLessThanOrEqual(BUDGET.enhanceRaw);
    expect(enhance.gzip, `enhance.js gzip ${enhance.gzip} B`).toBeLessThanOrEqual(
      BUDGET.enhanceGzip,
    );
  });

  it("keeps the stylesheets of the largest app page within the budget", () => {
    const base = css.get("base.css");
    if (!base) throw new Error("base.css is missing from the served folder");
    const pages = [...css].filter(([name]) => name !== "base.css" && name !== "public.css");
    const [largestName, largest] = pages.reduce((a, b) =>
      b[1].raw + b[1].gzip > a[1].raw + a[1].gzip ? b : a,
    );
    const sum = total([base, largest]);
    expect(sum.raw, `base.css + ${largestName} raw ${sum.raw} B`).toBeLessThanOrEqual(
      BUDGET.cssRaw,
    );
    expect(sum.gzip, `base.css + ${largestName} gzip ${sum.gzip} B`).toBeLessThanOrEqual(
      BUDGET.cssGzip,
    );
    expect(base.raw, `base.css raw ${base.raw} B`).toBeLessThanOrEqual(BUDGET.baseCssRaw);
    expect(base.gzip, `base.css gzip ${base.gzip} B`).toBeLessThanOrEqual(BUDGET.baseCssGzip);
  });

  it("keeps a public page within the budget", () => {
    const parts = ["base.css", "public.css", "theme.js", "public.js"].map((name) => {
      const size = css.get(name) ?? js.get(name);
      if (!size) throw new Error(`${name} is missing from the served folder`);
      return size;
    });
    const sum = total(parts);
    expect(sum.raw, `public page raw ${sum.raw} B`).toBeLessThanOrEqual(BUDGET.publicRaw);
    expect(sum.gzip, `public page gzip ${sum.gzip} B`).toBeLessThanOrEqual(BUDGET.publicGzip);
  });

  it("keeps every font file within the budget", () => {
    expect(fonts.size).toBeGreaterThan(0);
    for (const [name, size] of fonts) {
      expect(size.raw, `${name} raw ${size.raw} B`).toBeLessThanOrEqual(BUDGET.fontRaw);
    }
  });

  it("measures minified files, not sources", () => {
    // A control that must match: the served files are the minified ones. An unminified `panel.js`
    // is 32 KB and `base.css` is 67 KB; a build step that stops minifying fails here and above.
    expect(js.get("panel.js")?.raw).toBeGreaterThan(1000);
    expect(js.get("panel.js")?.raw).toBeLessThan(20 * KB);
    expect(css.get("base.css")?.gzip).toBeGreaterThan(1000);
    expect(css.get("base.css")?.raw).toBeLessThan(50 * KB);
    expect(js.get("panel.js")!.gzip).toBeLessThan(js.get("panel.js")!.raw);
    // Every served script and stylesheet carries its hash, so there is one file per name.
    for (const dir of [js, css])
      for (const name of dir.keys()) expect(name).not.toMatch(/\.[0-9a-f]{10}\./);
  });
});
