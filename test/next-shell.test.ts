import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { asset } from "../src/pages/next/assets";
import { initials } from "../src/pages/next/shell";
import { addAccount, BASE, signIn } from "./helpers";

async function get(path: string, cookie?: string, language = "en") {
  return exports.default.fetch(`${BASE}${path}`, {
    headers: { ...(cookie ? { cookie } : {}), "accept-language": language },
    redirect: "manual",
  });
}

describe("redesign shell under /", () => {
  it("sends a visitor without a session to the start page, which is the sign-in", async () => {
    for (const path of ["/mirroring", "/calendars", "/activity", "/admin", "/tokens"]) {
      const response = await get(path);
      expect(response.status, path).toBe(302);
      expect(response.headers.get("location"), path).toBe("/");
    }
    const start = await get("/");
    expect(start.status).toBe(200);
    expect(await start.text()).toContain('href="/auth/microsoft/login"');
  });

  it("renders every page with its own stylesheets and without the old ones", async () => {
    const { user, cookie } = await signIn("next-shell@org.example");
    await addAccount(user.id, "next-a", "a@example.com");
    for (const [path, style] of [
      ["/", "/next/overview.css"],
      ["/mirroring", "/next/mirroring.css"],
      ["/calendars", "/next/calendars.css"],
    ] as const) {
      const response = await get(path, cookie);
      expect(response.status, path).toBe(200);
      const html = await response.text();
      expect(html, path).toMatch(/href="\/next\/base\.[0-9a-f]{10}\.css"/);
      expect(html, path).toContain(`href="${asset(style)}"`);
      expect(html, path).not.toContain("/style.css");
      expect(html, path).not.toContain("/proto/");
      expect(html, path).toContain('href="#main"');
      expect(html, path).toContain('aria-current="page"');
    }
  });

  it("opens a panel only for a value that the state knows", async () => {
    const { user, cookie } = await signIn("next-panel@org.example");
    await addAccount(user.id, "next-p1", "p1@example.com");
    await addAccount(user.id, "next-p2", "p2@example.com");
    const withPanel = (html: string) => html.includes('class="detail"');
    expect(withPanel(await (await get("/mirroring?d=all", cookie)).text())).toBe(true);
    expect(withPanel(await (await get("/mirroring?d=nope~nada", cookie)).text())).toBe(false);
    expect(withPanel(await (await get("/mirroring?d=a~b~c", cookie)).text())).toBe(false);
    expect(withPanel(await (await get("/calendars?c=next-p1", cookie)).text())).toBe(true);
    expect(withPanel(await (await get("/calendars?c=other", cookie)).text())).toBe(false);
  });

  it("speaks German when the browser asks for it", async () => {
    const { cookie } = await signIn("next-de@org.example");
    const html = await (await get("/", cookie, "de")).text();
    expect(html).toContain('<html lang="de" ');
    expect(html).toContain("Übersicht");
    expect(html).toContain("Zum Inhalt springen");
  });
});

describe("design system of the shell", () => {
  it("takes two initials only from a name, else the first letter", () => {
    expect(initials("dev@example.com")).toBe("D");
    expect(initials("jane.doe@example.com")).toBe("JD");
    expect(initials("a-b_c@example.com")).toBe("AC");
    expect(initials("dev@example.com", "Ada Lovelace")).toBe("AL");
    expect(initials("dev@example.com", "  ")).toBe("D");
  });

  it("labels the nav entries for the phone tabs and shows the avatar's single letter", async () => {
    const { cookie } = await signIn("dev@org.example");
    const html = await (await get("/mirroring", cookie)).text();
    expect(html).toContain('<span class="nav-label">Mirroring</span>');
    expect(html).toContain('<span class="avatar">D</span>');
    // No attention dot unless a page passes one.
    expect(html).not.toContain("nav-attention");
  });

  it("gives Admin the default column and a selected tab", async () => {
    const { cookie } = await signIn("admin@example.com");
    const html = await (await get("/admin?tab=health", cookie)).text();
    expect(html).toMatch(/<div class="frame">/);
    expect(html).toMatch(/<a class="seg-item" href="\/admin\?tab=health" aria-current="page">/);
    // The header carries no explainer next to the title.
    expect(html).not.toContain('class="page-lead"');
  });

  it("writes the admin log in the sentences of the Activity page", async () => {
    const { user, cookie } = await signIn("admin@example.com");
    await env.DB.prepare(
      `INSERT INTO audit_events (org_id, user_id, kind, detail, created_at)
       VALUES (?, ?, 'sync_run', ?, ?)`,
    )
      .bind(
        user.orgId,
        user.id,
        JSON.stringify({ dryRun: false, create: 0, update: 0, delete: 0, failed: 0 }),
        new Date().toISOString(),
      )
      .run();
    const html = await (await get("/admin?tab=health", cookie)).text();
    expect(html).toContain('class="list-row act-row"');
    expect(html).toContain("No changes");
    expect(html).not.toContain("0 new, 0 changed, 0 removed");
  });
});
