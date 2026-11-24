import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BrandMark } from "../src/pages/next/shell";

/**
 * Layout rules of the redesign's stylesheets that a screenshot shows only at some widths: the
 * narrow list beside a panel, the row hairlines, the selected row, the status column, the type
 * scale, the merged days and the logo.
 */
const root = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const base = read("public/next/base.css");
const overview = read("public/next/overview.css");
const calendars = read("public/next/calendars.css");
const mirroring = read("public/next/mirroring.css");

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string, from = 0): string {
  const at = css.indexOf(`${selector} {`, from);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf("}", at));
}

/** The body of the first at-rule that starts with `head`, up to its closing brace. */
function block(css: string, head: string): string {
  const at = css.indexOf(`${head} {`);
  expect(at, head).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = css.indexOf("{", at); i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(at, i + 1);
  }
  throw new Error(`unclosed: ${head}`);
}

describe("a narrow list (a panel open up to 1400 px, a window under 1000 px, a phone)", () => {
  it("puts the row on two lines: name, count and status first, the meta under the name", () => {
    const narrow = block(base, "@container list (width < 760px)");
    expect(rule(narrow, ".list-row")).toContain("--row-display: grid;");
    expect(rule(narrow, ".list-row")).toContain("--row-main-display: contents;");
    expect(rule(narrow, ".list-row")).toContain(
      "grid-template-columns: [icon] 20px [title] minmax(0, 1fr) [count] auto [status] auto;",
    );
    expect(rule(narrow, ".row-meta")).toContain("grid-row: 2;");
    expect(rule(narrow, ".row-meta")).toContain("grid-column: title / -1;");
    expect(rule(narrow, ".row-tags")).toContain("display: none;");
    expect(rule(block(base, "@container list (width < 480px)"), ".row-count")).toContain(
      "display: none;",
    );
  });

  it("comes after the rules of the row parts, which would win over it otherwise", () => {
    const at = base.indexOf("@container list (width < 760px)");
    for (const part of [".row-meta {", ".row-tags {", ".row-count {", ".row-status {"]) {
      expect(base.indexOf(`\n${part}`), part).toBeLessThan(at);
    }
  });

  it("keeps the group head whole and lets the hint after it give way first", () => {
    const head = rule(base, ".list-group-head :is(h2, h3)");
    expect(head).toContain("flex: 0 1 auto;");
    expect(head).toContain("text-overflow: ellipsis;");
    expect(head).toContain("white-space: nowrap;");
    expect(rule(base, ".list-group-hint")).toContain("flex: 1 1 0;");
  });

  it("has room for the mirroring columns above the breakpoint", () => {
    // 20 + 160 + 208 + 88 + 168 px of tracks, five 12 px gaps and two 24 px gutters: 752 px.
    expect(mirroring).toMatch(
      /--row-columns: \[icon\] 20px \[title\] 160px \[meta\] 208px \[tags\] minmax\(0, 1fr\) \[count\] 88px \[status\]\s+minmax\(168px, max-content\);/,
    );
    expect(20 + 160 + 208 + 88 + 168 + 5 * 12 + 2 * 24).toBeLessThanOrEqual(760);
  });
});

describe("row hairlines", () => {
  it("are inset by the gutter at both ends, as a background layer, not a shadow", () => {
    const row = rule(base, ".list-row");
    expect(row).toMatch(
      /--sep: linear-gradient\(var\(--line\), var\(--line\)\) var\(--gutter\) 0 \/ calc\(100% - 2 \* var\(--gutter\)\)\s+1px no-repeat;/,
    );
    expect(row).toContain("background: var(--sep), var(--sep-end), var(--row-bg);");
    expect(row).not.toContain("box-shadow");
    expect(rule(base, ".list-item:last-child > .list-row")).toMatch(
      /--sep-end: linear-gradient\(var\(--line\), var\(--line\)\) var\(--gutter\) 100% \/\s+calc\(100% - 2 \* var\(--gutter\)\) 1px no-repeat;/,
    );
  });
});

describe("the selected row", () => {
  const selected = rule(
    base,
    '.list-row[aria-current="true"],\n.list-row.is-selected,\na.list-row[aria-current="true"]:hover',
  );

  it("is the selected fill only: no ring, no edge bar, the hairlines stay", () => {
    expect(selected).toContain("--row-bg: var(--fill-selected);");
    expect(selected).not.toMatch(/box-shadow|border|outline|--sep/);
  });
});

describe("controls and type", () => {
  it("aligns the time of a fine row in a fixed slot, so the dots form a column", () => {
    const time = rule(base, ".row-status .run > time:last-child");
    expect(time).toContain("min-width: 48px;");
    expect(time).toContain("text-align: right;");
    expect(time).toContain("font-variant-numeric: tabular-nums;");
  });

  it("draws colour swatches as squares, like the calendar swatch", () => {
    expect(rule(base, ".swatch-dot")).toContain("border-radius: var(--radius-item);");
  });

  it("merges selected neighbouring days into one block", () => {
    expect(rule(calendars, ".cal-days")).toContain("gap: 0;");
    expect(
      rule(calendars, ".cal-days .seg-item:has(:checked):has(+ .seg-item :checked)"),
    ).toContain("clip-path: inset(-3px 0 -3px -3px);");
    expect(
      rule(calendars, ".cal-days .seg-item:has(:checked) + .seg-item:has(:checked)"),
    ).toContain("clip-path: inset(-3px -3px -3px 0);");
    expect(rule(calendars, ".cal-days .seg-item:has(:focus-visible)")).toContain(
      "clip-path: none;",
    );
  });

  it("keeps to the type scale: no 13.5 px, the badge at 11/500", () => {
    for (const [name, css] of [
      ["base", base],
      ["overview", overview],
      ["calendars", calendars],
    ] as const) {
      expect(css, name).not.toContain("13.5px");
    }
    const avatar = rule(base, ".avatar");
    expect(avatar).toContain("font-size: 11px;");
    expect(avatar).toContain("font-weight: 500;");
  });

  it("puts a field error in the control column in the danger colour, and marks the control", () => {
    const error = rule(base, ".prop-error");
    expect(error).toContain("grid-column: 2;");
    expect(error).toContain("color: var(--danger);");
    expect(
      rule(base, '.input[aria-invalid="true"],\n.select select[aria-invalid="true"]'),
    ).toContain("border-color: var(--danger);");
    expect(rule(base, '.seg[aria-invalid="true"]')).toContain(
      "box-shadow: inset 0 0 0 1px var(--danger);",
    );
  });

  it("spaces a panel notice 16 px under the state line", () => {
    expect(rule(base, ".detail-body > .notice")).toContain("margin-top: 16px;");
  });

  it("sets the danger entry of the account menu in the danger colour", () => {
    expect(rule(base, ".menu-item-danger")).toContain("color: var(--danger);");
  });
});

describe("frame and panel", () => {
  it("lets the frame fill the window and docks the panel at its right edge", () => {
    // A cap on the frame left an empty strip of chrome right of it on wide screens.
    expect(base).not.toMatch(/\.frame:not\(\.is-wide\)\s*\{[^}]*max-width/);
    expect(base).not.toMatch(/\.frame\.has-panel \.workspace\s*\{[^}]*max-width/);
    // The pane takes the free space and the panel keeps its width, so the panel sits at the edge.
    expect(rule(base, ".workspace")).toContain("flex: 1;");
    expect(rule(base, ".pane")).toContain("flex: 1;");
    expect(rule(base, ".detail")).toContain("flex: none;");
    expect(rule(base, ".detail")).toContain("width: var(--panel-w);");
  });

  it("keeps a hint under its control when the label wraps", () => {
    expect(rule(base, ".prop:not(.is-stacked)")).toContain(
      "grid-template-rows: auto auto auto 1fr;",
    );
    expect(rule(base, ".prop:not(.is-stacked) > .prop-label")).toContain("grid-row: 1 / -1;");
    expect(rule(base, ".prop:not(.is-stacked) > :is(.prop-hint, .prop-error)")).toContain(
      "margin-top: 4px;",
    );
  });

  it("gives a window under 720 px the 44 px touch targets of a touch screen", () => {
    const touch = block(base, "@media (pointer: coarse), (max-width: 719.98px)");
    expect(touch).toContain("--control-h: 44px;");
    expect(touch).toContain("inset: -14px -8px;");
    // The back link and the link back to a mirroring share one rule.
    expect(rule(touch, "  .detail .detail-back,\n  .detail-from")).toContain("min-height: 44px;");
    expect(touch).toMatch(/\.prop-hint \.link,[\s\S]*?padding-block: 15px;/);
  });

  it("keeps the hatch patch of the preview chip from widening it", () => {
    const patch = rule(mirroring, ".mx-ev.is-busy :is(.mx-ev-title, .mx-ev-time)");
    expect(patch).toContain("margin-inline: -2px;");
    expect(patch).toContain("padding: 0 2px;");
  });
});

describe("overview width", () => {
  it("lets the side sections under the map end where the map ends", () => {
    const narrow = block(overview, "@media (max-width: 1279.98px)");
    const side = rule(narrow, ".ov-side");
    expect(side).toContain(
      "grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr));",
    );
    expect(side).not.toContain("max-width");
  });

  it("takes the width from the Shell, not from a stale override", () => {
    expect(overview).not.toContain(".frame:has(.ov)");
    expect(overview).not.toContain("1408px");
  });

  it("lets map cells grow to 320 px and keep 200 px from 1920 px", () => {
    const wide = block(overview, "@media (min-width: 1920px)");
    expect(rule(wide, ".ov-grid:not(.is-single)")).toContain(
      "grid-template-columns: minmax(0, calc(160px + var(--n, 3) * 326px)) 340px;",
    );
    expect(rule(wide, ".ov-matrix")).toContain("min-width: calc(172px + var(--n, 3) * 206px);");
    expect(rule(block(base, "@media (min-width: 1920px)"), ".frame.is-wide")).toContain(
      "--content-max: none;",
    );
  });

  it("draws the diagonal with CSS, not with a dash character", () => {
    const self = rule(overview, ".ov-self::after");
    expect(self).toContain('content: "";');
    expect(self).toContain("background: var(--line-strong);");
  });
});

describe("logo", () => {
  const svg = (size: number) => String(BrandMark({ size }));

  it("draws the flat copy below 24 px and the hatched copy from 24 px", () => {
    for (const size of [16, 20, 22]) {
      expect(svg(size), `${size}`).toContain('class="brand-copy"');
      expect(svg(size), `${size}`).not.toContain("clipPath");
    }
    for (const size of [24, 32]) {
      expect(svg(size), `${size}`).toContain('class="brand-hatch"');
      expect(svg(size), `${size}`).toContain(`<clipPath id="brand-copy-${size}">`);
    }
  });

  it("takes every colour from a token, so both themes follow", () => {
    for (const size of [20, 32]) {
      expect(svg(size)).not.toMatch(/#[0-9a-f]{3,6}\b|fill="(?!none)|stroke="(?!none)/i);
    }
    expect(base).toContain("--brand-ink: var(--text);");
    expect(base).toContain("--brand-eye: var(--accent);");
    expect(rule(base, ".brand-mark .brand-copy")).toContain("fill: var(--brand-copy);");
    expect(rule(base, ".brand-mark .brand-hatch")).toContain("stroke: var(--brand-eye);");
    // The size comes from the component; a fixed CSS size would draw the 22 px mark at 20.
    expect(rule(base, ".brand-mark")).not.toMatch(/width|height/);
  });

  it("serves the favicon of the chosen direction", () => {
    expect(read("public/favicon.svg")).toBe(read("design/logo-next/eyes/favicon.svg"));
  });
});
