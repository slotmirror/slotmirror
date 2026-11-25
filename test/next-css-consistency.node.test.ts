import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * One rule per thing across `public/next/*.css`: the colour space of mixes, the neutral fills, the
 * danger ghost button and the row link. Each check reads the files, so a second copy of a rule
 * fails here before it shows as a drift on screen.
 */
const dir = join(import.meta.dirname, "..", "public", "next");
const files = readdirSync(dir)
  .filter((name) => name.endsWith(".css"))
  .sort();
const sheets = new Map(files.map((name) => [name, readFileSync(join(dir, name), "utf8")]));
const css = (name: string): string => {
  const text = sheets.get(name);
  if (text === undefined) throw new Error(`public/next/${name} is missing`);
  return text;
};
const all = [...sheets.values()].join("\n");
/** How often `needle` occurs in the stylesheets, as a count per file that has it. */
const where = (needle: string | RegExp): string[] =>
  files.filter((name) =>
    typeof needle === "string" ? css(name).includes(needle) : needle.test(css(name)),
  );

describe("public/next stylesheets", () => {
  it("mix colours in oklab, never in oklch", () => {
    expect(files).toContain("base.css");
    expect(all.match(/in oklch/g) ?? []).toEqual([]);
    // Control: the check sees the mixes that exist.
    expect(all.match(/color-mix\(in oklab/g)?.length).toBeGreaterThan(20);
  });

  it("take neutral hover, press and mark fills from the tokens, not from percentages of --text", () => {
    const stray = all.match(/color-mix\(in oklab, var\(--text\) \d+%, transparent\)/g) ?? [];
    // The three tokens in base.css are the only places that spell the percentage.
    expect(stray).toHaveLength(3);
    expect(css("base.css")).toMatch(/--fill-wash: color-mix\(in oklab, var\(--text\) 5%/);
    expect(css("base.css")).toMatch(/--fill-press: color-mix\(in oklab, var\(--text\) 8%/);
    expect(css("base.css")).toMatch(/--fill-strong: color-mix\(in oklab, var\(--text\) 12%/);
  });

  it("have no page tokens for warn and danger words, and no unused property height", () => {
    expect(all).not.toContain("--ov-warn-text");
    expect(all).not.toContain("--ov-danger-text");
    expect(all).not.toContain("--prop-h");
  });

  it("use the radius tokens for items and menus, and the line heights of the scale", () => {
    expect(css("base.css")).toMatch(/--radius-item: 4px;/);
    expect(css("base.css")).toMatch(/--radius-menu: 8px;/);
    expect(css("base.css")).toMatch(/\.menu \{[^}]*border-radius: var\(--radius-menu\);/);
    expect(css("base.css")).toMatch(/\.seg-item[^{]*\{[^}]*border-radius: var\(--radius-item\);/);
    for (const name of ["admin.css", "public.css", "activity.css"]) {
      expect(css(name), name).not.toMatch(/line-height: (18|22|24)px/);
    }
    expect(css("public.css")).toMatch(/\.pub-prose \{[^}]*font-size: var\(--prose-size\);/);
  });

  it("define the stretched row link once, in base.css", () => {
    expect(where(".row-open::after")).toEqual(["base.css"]);
    expect(where(".row-open:focus-visible")).toEqual(["base.css"]);
    expect(where(/^\.btn-danger-ghost \{/m)).toEqual(["base.css"]);
    expect(where(/^\.btn-danger-ghost:hover \{/m)).toEqual(["base.css"]);
    expect(where(".confirm-step {")).toEqual(["base.css"]);
  });
});
