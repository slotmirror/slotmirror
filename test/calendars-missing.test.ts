import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { en } from "../src/i18n/en";
import { addAccount, BASE, signIn } from "./helpers";

async function page(path: string, cookie: string): Promise<string> {
  const response = await exports.default.fetch(`${BASE}${path}`, { headers: { cookie } });
  return response.text();
}

describe("an account without calendars", () => {
  it("warns on the Mirroring page and offers to load the calendars again", async () => {
    const { user, cookie } = await signIn("owner@example.com");
    await addAccount(user.id, "acc-no-calendars", "empty@example.com");
    const mirroring = await page("/mirroring", cookie);
    expect(mirroring).toContain(en.next.mirroring.notices.missingText);
    expect(mirroring).toContain('action="/rules/calendars/refresh"');
  });
});
