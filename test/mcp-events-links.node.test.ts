import { describe, expect, it } from "vitest";
import { withoutLinks } from "../src/mcp-events";

// On Node, because workerd stops its clocks while code runs, so a time limit there cannot fail.
describe("withoutLinks on long titles", () => {
  // Five times the 10 000 characters of the review, so that a quadratic rule takes far over the
  // limit (10 000 characters took it 30 to 60 ms) and a linear one stays far under it.
  const LENGTH = 50_000;
  const inputs: [string, string][] = [
    ["one long word", "a".repeat(LENGTH)],
    ["dotted labels", "a.".repeat(LENGTH / 2)],
    ["hyphenated labels", "a-".repeat(LENGTH / 2)],
    ["dotted labels with slashes", "a.b/".repeat(LENGTH / 4)],
    ["a long link", `https://${"a".repeat(LENGTH)}`],
    ["a long scheme", `${"a".repeat(LENGTH)}:x`],
    ["separators before a link", `x${" -".repeat(LENGTH / 2)} https://example.com/x`],
    ["separators without a link", `x${" -".repeat(LENGTH / 2)}y`],
    ["a link and separators", `https://example.com/x x${" -".repeat(LENGTH / 2)}y`],
    [
      "white space around a link",
      `x${" ".repeat(LENGTH)}https://example.com/x${" ".repeat(LENGTH)}y`,
    ],
    ["many links", "https://a.b/c ".repeat(Math.ceil(LENGTH / 14))],
    ["open brackets", "[a](".repeat(LENGTH / 4)],
    ["digits and dots", "1.1.1.".repeat(Math.ceil(LENGTH / 6))],
  ];
  for (const [label, text] of inputs) {
    it(`cleans ${label} in linear time`, () => {
      const started = performance.now();
      withoutLinks(text);
      expect(performance.now() - started).toBeLessThan(200);
    });
  }
});
