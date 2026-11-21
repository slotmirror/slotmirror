import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHROME_COLORS } from "../src/pages/next/shell";

const css = readFileSync(join(import.meta.dirname, "..", "public", "next", "base.css"), "utf8");
const manifest = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "public", "manifest.webmanifest"), "utf8"),
) as { background_color: string; theme_color: string };

/** `oklch(L% C H)` to #rrggbb (Oklab matrices of Bjorn Ottosson, sRGB transfer function). */
function oklchToHex(l: number, c: number, h: number): string {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const lp = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mp = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sp = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * lp - 3.3077115913 * mp + 0.2309699292 * sp,
    -1.2684380046 * lp + 2.6097574011 * mp - 0.3413193965 * sp,
    -0.0041960863 * lp - 0.7034186147 * mp + 1.707614701 * sp,
  ];
  const hex = linear.map((x) => {
    const v = Math.min(1, Math.max(0, x));
    const encoded = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.round(encoded * 255)
      .toString(16)
      .padStart(2, "0");
  });
  return `#${hex.join("")}`;
}

/** The two values of `--chrome: light-dark(oklch(...), oklch(...))` in base.css. */
function chromeToken(): { light: string; dark: string } {
  const match = css.match(
    /--chrome:\s*light-dark\(\s*oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)\s*,\s*oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)\s*\)/,
  );
  if (!match) throw new Error("--chrome token not found in base.css");
  const n = match.slice(1).map(Number) as [number, number, number, number, number, number];
  return {
    light: oklchToHex(n[0] / 100, n[1], n[2]),
    dark: oklchToHex(n[3] / 100, n[4], n[5]),
  };
}

/** The declarations of the first rule whose selector line is exactly `selector`. */
function rule(source: string, selector: string): string {
  const start = source.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`rule not found: ${selector}`);
  return source.slice(start, source.indexOf("\n}", start));
}

describe("title bar colours", () => {
  it("equal the chrome token of the stylesheet", () => {
    expect(chromeToken()).toEqual(CHROME_COLORS);
  });

  it("are the light chrome colour in the manifest, which has no dark variant", () => {
    expect(manifest.theme_color).toBe(CHROME_COLORS.light);
    expect(manifest.background_color).toBe(CHROME_COLORS.light);
  });
});

describe("shell stylesheet for apps", () => {
  it("pads the fixed and sticky bars with the safe areas", () => {
    for (const side of ["top", "right", "bottom", "left"]) {
      expect(css).toContain(`--safe-${side}: env(safe-area-inset-${side}, 0px);`);
    }
    const phone = css.slice(css.indexOf("@media (max-width: 719.98px)"));
    expect(rule(phone, "  .sidebar")).toContain("padding: var(--safe-top)");
    expect(css).toContain("--topbar-h: calc(92px + var(--safe-top));");
    expect(rule(phone, "  .detail-foot")).toContain("var(--safe-bottom)");
    expect(rule(css, ".app")).toContain("var(--safe-top) var(--safe-right)");
    expect(rule(css, ".menu-pop")).toContain("var(--safe-bottom)");
    expect(rule(css, ".guard")).toContain("inset: var(--safe-top)");
  });

  it("makes the sidebar and the header drag regions with no-drag controls, for the app windows only", () => {
    const controls =
      ':is(a, button, input, select, summary, [role="button"], [contenteditable], .menu)';
    // `app-region` takes no var(): the values must be literal.
    expect(css).not.toMatch(/app-region:\s*var\(/);
    const desktop = css.slice(
      css.indexOf('html[data-shell="desktop"] :is(.sidebar, .page-head) {'),
    );
    expect(desktop).toMatch(/^[^}]*-webkit-app-region: drag;\s*app-region: drag;/);
    expect(desktop).toContain(
      `html[data-shell="desktop"]\n  :is(.sidebar, .page-head)\n  ${controls} {\n  -webkit-app-region: no-drag;\n  app-region: no-drag;`,
    );
    const overlay = css.slice(
      css.indexOf("@media (display-mode: window-controls-overlay) {\n  html"),
    );
    expect(overlay).toContain(":is(.sidebar, .page-head) {\n    -webkit-app-region: drag;");
    expect(overlay).toContain(`${controls} {\n    -webkit-app-region: no-drag;`);
    // Without the shell or the overlay, no rule sets a drag region.
    expect(
      css.replace(/@media \(display-mode: window-controls-overlay\) \{[\s\S]*?\n\}\n/, ""),
    ).not.toMatch(/(^|\n)(\.|:is\(\.sidebar)[^\n]*\{[^}]*app-region/);
    expect(rule(css, 'html[data-shell="desktop"][data-platform="mac"]')).toContain(
      "--shell-top: 40px;",
    );
    expect(rule(css, ".sidebar")).toContain("var(--shell-top, 12px)");
  });

  it("keeps the header clear of window controls", () => {
    expect(css).toContain("env(titlebar-area-x, 0px)");
    expect(css).toContain("env(titlebar-area-width, 100vw)");
    expect(rule(css, ".page-head")).toContain("env(titlebar-area-height, 0px)");
    expect(rule(css, ".page-head")).toContain("padding-right: var(--wco-right)");
  });

  it("sizes touch targets to 44 px and inputs to 16 px under a coarse pointer", () => {
    const coarse = css.slice(
      css.indexOf("@media (pointer: coarse)"),
      css.indexOf("@media (hover: none) {"),
    );
    expect(coarse).toContain("--control-h: 44px;");
    expect(rule(coarse, "  .seg-item,\n  .choice")).toMatch(/height: 44px;[\s\S]*min-width: 44px;/);
    expect(coarse).toContain("inset: -14px -8px;");
    expect(rule(coarse, "  .input,\n  .select select")).toContain("font-size: 16px;");
    expect(rule(coarse, "  .list-row")).toContain("min-height: 48px;");
  });

  it("reveals nothing on hover only", () => {
    // A hover rule may tint a control. It must not show or hide one.
    for (const [, body] of css.matchAll(/:hover[^{,]*\{([^}]*)\}/g)) {
      expect(body).not.toMatch(/\b(display|visibility|opacity|transform)\s*:/);
    }
  });
});
