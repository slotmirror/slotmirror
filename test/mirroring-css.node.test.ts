import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LEVELS } from "../src/editor";

/**
 * Rules of `public/next/mirroring.css` that the panel's truth depends on: the preview takes the
 * height of its level (plan 2.3), and without script the save bar still says what the chosen
 * answers do and names the Save button after a widening one (plan 2.7).
 */
const css = readFileSync(
  join(import.meta.dirname, "..", "public", "next", "mirroring.css"),
  "utf8",
).replaceAll(/\s+/g, " ");

/** The declarations of every rule whose selector list contains `part`. */
function rulesWith(part: string): string[] {
  const found: string[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if ((match[1] ?? "").includes(part)) found.push(`${match[1]}{${match[2]}}`);
  }
  return found;
}

/** The checked answers of a level, as the selectors write them. */
function answers(level: string): string {
  if (level === "off") return '.detail-form:has([name="copy"][value="off"]:checked)';
  const [copy, who] = level.split("-");
  return `.detail-form:has([name="copy"][value="${copy}"]:checked):has([name="who"][value="${who}"]:checked)`;
}

describe("the preview of a mirroring (plan 2.3)", () => {
  it("keeps no fixed height for the whole preview", () => {
    for (const rule of rulesWith(".mx-preview")) {
      if (/\.mx-preview\s*\{/.test(rule) || /\.mx-preview\s*,/.test(rule)) {
        expect(rule).not.toContain("min-height");
      }
    }
    expect(rulesWith(".mx-preview").length, "the control: rules were found").toBeGreaterThan(0);
  });
});

describe("the save bar without script (plan 2.7)", () => {
  it("shows the note of each level from the checked answers", () => {
    const notes = rulesWith("[data-sentence=").filter((rule) => rule.includes("html:not(.js)"));
    expect(notes.length).toBeGreaterThan(0);
    const all = notes.join(" ");
    for (const level of LEVELS) {
      expect(all, level).toContain(`html:not(.js) ${answers(level)} [data-sentence="${level}"]`);
    }
    // The notes carry `hidden`, which base.css enforces with !important.
    expect(notes[0]).toContain("display: block !important");
  });

  it("names the Save button after a widening answer, and hides the default label then", () => {
    const labels = rulesWith("[data-label-for=").join(" ");
    for (const level of ["busy-open", "title-open", "full-open"]) {
      expect(labels, level).toContain(`${answers(level)} [data-label-for="${level}"]`);
      expect(labels, level).toContain(
        `${answers(level)} [data-save]:has([data-label-for="${level}"]) [data-label-default]`,
      );
    }
    expect(labels).toContain("display: inline !important");
  });
});

describe("the working-hours hint (decision of 2026-11-21)", () => {
  it("hides both texts by default and shows one from the state of the switch", () => {
    const rules = rulesWith(".mx-hours-");
    expect(rules.length, "the control: rules were found").toBeGreaterThan(0);
    const all = rules.join(" ");
    expect(all).toContain(".mx-hours-off, .mx-hours-on { display: none; }");
    expect(all).toContain(
      '.prop:not(:has([name="workHours"]:checked)) .mx-hours-off, .prop:has([name="workHours"]:checked) .mx-hours-on { display: inline; }',
    );
  });
});
