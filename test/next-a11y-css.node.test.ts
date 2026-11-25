import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Rules of the redesign's stylesheets that decide what assistive technology and touch devices get:
 * a hidden text that must leave the accessibility tree, the order of the panel head, the keyboard
 * hint that touch devices must not see.
 */
const read = (name: string) =>
  readFileSync(join(import.meta.dirname, "..", "public", "next", name), "utf8");
const base = read("base.css");
const mirroring = read("mirroring.css");

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf("}", at));
}

describe("stylesheet rules for assistive technology and touch", () => {
  it("hides the label of the other answer with display none, so it is not part of the name", () => {
    // Both counts sit in the checkbox label; only the one of the chosen answer may be exposed.
    expect(rule(mirroring, ".mx-apply [data-apply],\n.mx-apply-hint")).toContain("display: none;");
    expect(mirroring).toMatch(
      /:has\(\[name="newWho"\]\[value="open"\]:checked\) \.mx-apply \[data-apply="open"\] \{\s*display: inline;/,
    );
  });

  it("draws the back link first while it follows the heading in the source", () => {
    expect(rule(base, ".detail .detail-back")).toContain("order: -1;");
  });

  it("shows no keyboard hint on touch devices", () => {
    expect(base).toMatch(
      /@media \(hover: none\), \(pointer: coarse\) \{\s*:root\[data-platform\] \.savebar \[data-save\]::after \{\s*content: none;/,
    );
  });

  it("gives a destructive ghost button the danger text colour", () => {
    expect(rule(base, ".btn-danger-ghost")).toContain("color: var(--danger);");
  });

  it("shows no keyboard hint below 720 px, nor when it alone would wrap the bar", () => {
    expect(base).toMatch(
      /@media \(max-width: 719\.98px\) \{\s*:root\[data-platform\] \.savebar \[data-save\]::after \{\s*content: none;/,
    );
    expect(rule(base, ":root[data-platform] .savebar[data-tight] [data-save]::after")).toContain(
      "content: none;",
    );
  });

  it("draws a destructive Save on the danger fill, with a text token of its own", () => {
    const save = rule(base, '.savebar [data-save][data-tone="danger"]');
    expect(save).toContain("background: var(--danger);");
    expect(save).toContain("color: var(--on-danger);");
    expect(base).toMatch(/--on-danger: light-dark\(/);
  });

  it("breaks property labels between words, without automatic hyphens", () => {
    const label = rule(base, ".prop-label");
    expect(label).toContain("hyphens: manual;");
    expect(label).not.toContain("hyphens: auto;");
  });
});
