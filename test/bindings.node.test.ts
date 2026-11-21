import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TEST_BINDINGS } from "./bindings";

const ROOT = join(import.meta.dirname, "..");

/** Keys of `Env` that are bindings, not variables. They need no entry in `TEST_BINDINGS`. */
const BINDINGS = new Set(["DB", "ACCOUNT_SYNC", "ASSETS"]);

/**
 * The string keys of one interface in a declaration file, such as `PUBLIC_URL?: string;`. Every
 * other key line fails the test: a union type, a type over several lines or an unknown binding
 * would otherwise drop out of the check without a message.
 */
function stringKeys(file: string, name: string): string[] {
  const source = readFileSync(join(ROOT, file), "utf8");
  const start = source.indexOf(`interface ${name} {`);
  expect(start, `interface ${name} in ${file}`).toBeGreaterThanOrEqual(0);
  const body = source.slice(start, source.indexOf("\n}", start));
  const keys: string[] = [];
  for (const line of body.split("\n")) {
    const key = /^\s*(?:readonly\s+)?([A-Z][A-Z0-9_]*)\??\s*:(.*)$/.exec(line);
    if (!key?.[1]) continue;
    if (key[2]?.trim() === "string;") keys.push(key[1]);
    else if (!BINDINGS.has(key[1]))
      throw new Error(`${file}: cannot read the type of "${line.trim()}"`);
  }
  return keys;
}

/**
 * The Vitest pool loads a local `.dev.vars` for every key it holds, and no option of
 * `@cloudflare/vitest-plugin` turns that off. Only a key in `TEST_BINDINGS` wins over it. So every
 * string variable of `Env` must be there, or a developer's local value leaks into the tests.
 */
describe("test bindings", () => {
  const keys = [
    ...stringKeys("src/secrets.d.ts", "WorkerSettings"),
    ...stringKeys("src/secrets.d.ts", "WorkerSecrets"),
    ...stringKeys("worker-configuration.d.ts", "__BaseEnv_Env"),
  ];

  it("reads the variables of Env", () => {
    // A control: if the parse found nothing, the next test would pass without checking anything.
    expect(keys).toContain("SESSION_SECRET");
    expect(keys).toContain("PUBLIC_URL");
    expect(keys).toContain("DEV_SIGN_IN_AS");
    expect(keys).toContain("DEV_FAKE_CALENDARS");
  });

  it("pin every string variable of Env", () => {
    const missing = [...new Set(keys)].filter((key) => !(key in TEST_BINDINGS));
    expect(missing).toEqual([]);
  });
});
