import { describe, expect, it } from "vitest";
import { MAX_TEXT_LENGTH, withoutLinks } from "../src/mcp-events";

// On Node, because workerd stops its clocks while code runs, so a time limit there cannot fail.
describe("withoutLinks on long titles", () => {
  // Five times the 10 000 characters of the first review, so that a quadratic rule takes far over
  // the limit (the regex pipeline took 1.6 s for "slashes before a word") and a linear one stays
  // far under it. Inputs end in a word: a rule anchored at the end of the text fails only then.
  const LENGTH = 50_000;
  const inputs: [string, string][] = [
    ["one long word", "a".repeat(LENGTH)],
    ["dotted labels", "a.".repeat(LENGTH / 2)],
    ["dotted labels before a path", `${"a.".repeat(LENGTH / 2)}com/x`],
    ["hyphenated labels", "a-".repeat(LENGTH / 2)],
    ["dotted labels with slashes", "a.b/".repeat(LENGTH / 4)],
    ["a run of dots before a word", `x ${".".repeat(LENGTH)}y`],
    ["runs of dots inside a word", `a${"...b".repeat(LENGTH / 4)}/x`],
    ["a long link", `https://${"a".repeat(LENGTH)}`],
    ["a long scheme", `${"a".repeat(LENGTH)}:x`],
    ["many schemes", `${"tel:".repeat(LENGTH / 4)}1`],
    ["slashes before a word", `x ${"//a ".repeat(LENGTH / 4)}y`],
    ["links before a word", `x ${"https://a ".repeat(LENGTH / 10)}y`],
    ["hosts with paths before a word", `${"a.bc/d ".repeat(LENGTH / 7)}y`],
    ["separators before a link", `x${" -".repeat(LENGTH / 2)} https://example.com/x`],
    ["separators before a link and a word", `x${" -".repeat(LENGTH / 2)} https://a.b/c y`],
    ["separators without a link", `x${" -".repeat(LENGTH / 2)}y`],
    ["a link and separators", `https://example.com/x x${" -".repeat(LENGTH / 2)}y`],
    [
      "white space around a link",
      `x${" ".repeat(LENGTH)}https://example.com/x${" ".repeat(LENGTH)}y`,
    ],
    ["many links", "https://a.b/c ".repeat(Math.ceil(LENGTH / 14))],
    ["links with stray brackets", `x${" https://a)".repeat(LENGTH / 11)}`],
    ["open brackets", "[a](".repeat(LENGTH / 4)],
    ["query marks", `${"?a".repeat(LENGTH / 2)}=`],
    ["closing brackets after a link", `x https://a${")".repeat(LENGTH)}`],
    [
      "brackets around links",
      `${"(".repeat(LENGTH / 2)}https://a https://b${")".repeat(LENGTH / 2)}`,
    ],
    ["words joined by line breaks", "a\n".repeat(LENGTH / 2)],
    ["a link split by line breaks", `${"https:\n//a\n".repeat(LENGTH / 11)}y`],
    ["Meet codes after a Meet link", `meet.google.com ${"abc-defg-hij ".repeat(LENGTH / 13)}`],
    ["percent-encoded bytes", "%41".repeat(Math.ceil(LENGTH / 3))],
    ["invalid percent-encoded bytes", "%E3".repeat(Math.ceil(LENGTH / 3))],
    ["digits and dots", "1.1.1.".repeat(Math.ceil(LENGTH / 6))],
  ];
  for (const [label, text] of inputs) {
    it(`cleans ${label} in linear time`, () => {
      const started = performance.now();
      withoutLinks(text);
      expect(performance.now() - started).toBeLessThan(50);
    });
    // The cut to MAX_TEXT_LENGTH bounds the time; the filter must be linear without it too.
    it(`cleans ${label} in linear time without the cut`, () => {
      const started = performance.now();
      withoutLinks(text, Number.POSITIVE_INFINITY);
      expect(performance.now() - started).toBeLessThan(250);
    });
  }

  // The shape that took 2 s when each closing bracket rebuilt the text before it.
  it("appends many closing brackets after a link in linear time", () => {
    const started = performance.now();
    expect(withoutLinks(`x https://a${")".repeat(200_000)}`, Number.POSITIVE_INFINITY)).toBe(
      `x${")".repeat(200_000)}`,
    );
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("cuts a long text and the word at the cut, whose link part may lie after the cut", () => {
    // The cut leaves "SECRE" of a word that only the host after the cut marks as a link.
    const text = `${"word ".repeat(MAX_TEXT_LENGTH / 5 - 1)}SECRET-123@zoom.us/j/1`;
    const cleaned = withoutLinks(text) ?? "";
    expect(cleaned.endsWith("word word…")).toBe(true);
    expect(cleaned).not.toMatch(/SECRE|zoom/);
    expect(withoutLinks("x".repeat(MAX_TEXT_LENGTH))).toBe("x".repeat(MAX_TEXT_LENGTH));
    expect(withoutLinks("x".repeat(MAX_TEXT_LENGTH + 1))).toBeNull();
  });

  // The cut word can be the end of a link that line breaks split, so its whole group goes.
  const tail = "SECRET-123\n@zoom.us/j/1";
  for (const [label, cutAt] of [
    ["inside the host", tail.indexOf("@zoom") + 3],
    ["right after the line break", tail.indexOf("\n") + 1],
    ["right before the line break", tail.indexOf("\n")],
  ] as const) {
    it(`drops the words that line breaks join to the cut, with the cut ${label}`, () => {
      const filler = "word ".repeat(Math.ceil(MAX_TEXT_LENGTH / 5));
      const text = filler.slice(0, MAX_TEXT_LENGTH - cutAt) + tail;
      expect(text.slice(MAX_TEXT_LENGTH - cutAt, MAX_TEXT_LENGTH)).toBe(tail.slice(0, cutAt));
      const cleaned = withoutLinks(text) ?? "";
      expect(cleaned).toMatch(/word…$/);
      expect(cleaned).not.toMatch(/SECRE|zoom/);
    });
  }
});
