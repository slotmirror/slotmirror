import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Stylesheet rules of the admin and public pages that no rendered HTML shows. */
const read = (name: string) =>
  readFileSync(join(import.meta.dirname, "..", "public", "next", name), "utf8");
const admin = read("admin.css");
const pub = read("public.css");

describe("admin.css", () => {
  it("caps prose at 68ch and puts the access rows on a label column", () => {
    expect(admin).toMatch(/--adm-measure: 68ch;/);
    expect(admin).toMatch(/\.adm-props \{[^}]*--label-w: \d+px;/);
  });

  it("scopes the danger text and the code style, and has no second danger ghost button", () => {
    expect(admin).not.toMatch(/^\.is-danger\b/m);
    expect(admin).not.toMatch(/^code\b/m);
    expect(admin).toMatch(/:is\(\.adm, \.detail\) \.is-danger \{/);
    expect(admin).toMatch(/:is\(\.adm, \.detail\) code \{/);
    expect(admin).not.toContain("adm-danger-ghost");
  });
});

describe("public.css", () => {
  it("gives the public layout and the in-app flow one 480 px column", () => {
    expect(pub).toMatch(/--pub-w: 480px;/);
    expect(pub).not.toMatch(/--pub-w: (420|640)px/);
    expect(pub).not.toContain("pub-wide");
    expect(pub).not.toContain("pub-flow-wide");
    expect(pub).toMatch(/\.pub-flow \{[^}]*max-width: 480px;/);
  });

  it("keeps the footer version on one line", () => {
    expect(pub).toMatch(/\.pub-foot-row \.num \{\s*white-space: nowrap;/);
  });
});

describe("consent and the events opt-in", () => {
  it("hides the held form until its script ran", () => {
    expect(pub).toMatch(/^form\[data-hold\] \{\s*display: none;/m);
    expect(pub).toMatch(/^\.js form\[data-hold\] \{\s*display: flex;/m);
  });

  it("makes a held button look off and take no click", () => {
    const base = read("base.css");
    const off = /\.btn\[disabled\],\s*\.btn\[aria-disabled="true"\] \{([^}]*)\}/.exec(base)?.[1];
    expect(off).toContain("opacity: 0.45;");
    expect(off).toContain("pointer-events: none;");
  });

  it("lets no app name widen the page, and gives the box a row above the buttons", () => {
    expect(pub).toMatch(/\.pub-lead \{[^}]*overflow-wrap: anywhere;/);
    expect(pub).toMatch(/\.pub-opt-in \{[^}]*flex: 1 1 100%;/);
  });

  it("keeps the mark of a token that reads events whole", () => {
    expect(admin).toMatch(/\.row-meta:has\(\.adm-scope\) \{\s*flex-shrink: 0;/);
  });
});
