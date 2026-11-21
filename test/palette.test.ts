import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { de } from "../src/i18n/de";
import { en } from "../src/i18n/en";
import { appScripts } from "../src/pages/next/shell";
import { addAccount, BASE, signIn } from "./helpers";

/**
 * The command palette and the shortcut sheet as the server renders them (`src/pages/next/
 * palette.tsx`). The script `public/next/palette.js` only filters and runs what is here, so the
 * options, their addresses and what is left out are decided by this markup.
 * Browser behaviour: `test/browser/palette.sh`.
 */

const ADMIN = "admin@example.com";
const ACCOUNTS = [
  ["pal-a", "a@example.com"],
  ["pal-b", "b@example.com"],
  ["pal-c", "c@example.com"],
] as const;

let admin: Promise<string> | undefined;
function signedInAdmin() {
  admin ??= (async () => {
    const { user, cookie } = await signIn(ADMIN);
    for (const [id, email] of ACCOUNTS) {
      await addAccount(user.id, id, email);
      await env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, 'r', 'Main', 1, 1, 1)",
      )
        .bind(`${id}-cal`, id)
        .run();
    }
    return cookie;
  })();
  return admin;
}

async function page(path: string, language = "en") {
  const cookie = await signedInAdmin();
  const response = await exports.default.fetch(`${BASE}${path}`, {
    headers: { cookie, "accept-language": language },
    redirect: "manual",
  });
  expect(response.status, path).toBe(200);
  return response.text();
}

const dialogOf = (html: string, id: string) =>
  html.match(new RegExp(`<dialog id="${id}"[\\s\\S]*?</dialog>`))?.[0] ?? "";
const hrefs = (markup: string) =>
  [...markup.matchAll(/<a role="option"[^>]*href="([^"]+)"/g)].map((m) => m[1] ?? "");
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ");
/** The markup without search words: a keyword is not an action. */
const withoutKeywords = (markup: string) => markup.replace(/ data-k="[^"]*"/g, "");
const options = (markup: string) =>
  [...markup.matchAll(/<(a|button) role="option"[\s\S]*?<\/\1>/g)].map((m) => m[0]);

const APP_PAGES = ["/", "/mirroring", "/calendars", "/activity", "/admin", "/tokens"];
const WITH_STATE = ["/", "/mirroring", "/calendars", "/activity"];

describe("command palette markup", () => {
  it("loads palette.js from the head in every mode, also with the kill switch", () => {
    for (const mode of ["on", "off", "never"] as const) {
      expect(appScripts(mode), mode).toContain("/next/palette.js");
    }
  });

  it("renders the trigger, the palette and the sheet on every app page, hidden without script", async () => {
    for (const path of APP_PAGES) {
      const html = await page(path);
      const trigger = html.match(/<button[^>]*class="palette-trigger"[^>]*>/)?.[0] ?? "";
      expect(trigger, path).toContain('command="show-modal"');
      expect(trigger, path).toContain('commandfor="palette"');
      expect(trigger, path).toContain("data-needs-script");
      expect(dialogOf(html, "palette"), path).toContain('role="combobox"');
      expect(dialogOf(html, "palette"), path).toContain("data-needs-script");
      expect(dialogOf(html, "shortcuts"), path).toContain('class="sheet-row"');
      expect(html, path).toContain("data-single-keys");
    }
  });

  it("lists all six mirrorings and three calendars with their panel addresses", async () => {
    for (const path of WITH_STATE) {
      const palette = dialogOf(await page(path), "palette");
      const links = hrefs(palette);
      for (const [from] of ACCOUNTS) {
        expect(links, `${path} ${from}`).toContain(`/calendars?c=${from}`);
        for (const [to] of ACCOUNTS) {
          if (from !== to) expect(links, path).toContain(`/mirroring?d=${from}~${to}`);
        }
      }
      expect(links.filter((href) => href.startsWith("/mirroring?d=pal-"))).toHaveLength(6);
      expect(links.filter((href) => href.startsWith("/calendars?c="))).toHaveLength(3);
      expect(links, path).toContain("/mirroring?d=all");
      // The level summary of each mirroring as meta.
      expect(palette, path).toContain(`<span class="po-meta">${en.next.shell.levels.summary.off}`);
    }
  });

  it("has no item that signs out, deletes or changes a level", async () => {
    for (const path of APP_PAGES) {
      const palette = withoutKeywords(dialogOf(await page(path), "palette"));
      expect(palette, path).not.toMatch(
        /logout|\/account\/delete|disconnect|name="copy"|name="who"/,
      );
      expect(text(palette), path).not.toContain(en.next.shell.user.signOut);
      expect(text(palette), path).not.toContain(en.next.shell.user.deleteMyData);
      // The only form posts to the read-only reload; options are links or buttons, never inputs.
      for (const form of palette.matchAll(/<form[^>]*>/g)) {
        expect(form[0], path).toContain('action="/calendars/refresh"');
      }
      // The reload form's hidden `back` (the page to return to) is the one other input.
      expect(palette, path).not.toMatch(
        /<input(?![^>]*(role="combobox"|type="hidden" name="back"))/,
      );
    }
  });

  it("lists pages, actions and settings only on Admin and Tokens", async () => {
    for (const path of ["/admin", "/tokens"]) {
      const palette = dialogOf(await page(path), "palette");
      const links = hrefs(palette);
      expect(links, path).toContain("/mirroring");
      expect(links, path).toContain("/activity?kind=problems");
      expect(
        links.some((href) => href.includes("?d=") || href.includes("?c=")),
        path,
      ).toBe(false);
      expect(palette, path).toContain('data-action="theme:dark"');
    }
  });

  it("speaks the page language and links the other language as a full load", async () => {
    for (const [language, other, catalog] of [
      ["en", "de", en],
      ["de", "en", de],
    ] as const) {
      const html = await page("/mirroring", language);
      const palette = dialogOf(html, "palette");
      expect(palette, language).toContain(`aria-label="${catalog.next.palette.label}"`);
      expect(palette, language).toContain(`placeholder="${catalog.next.palette.placeholder}"`);
      expect(text(palette), language).toContain(catalog.next.palette.items.forAll);
      expect(text(palette), language).toContain(
        catalog.next.mirroring.fromTo("example (a)", "example (b)"),
      );
      expect(palette, language).toMatch(new RegExp(`<a role="option"[^>]*hreflang="${other}"`));
      expect(dialogOf(html, "shortcuts"), language).toContain(catalog.next.palette.keys.title);
    }
  });

  it("puts the g sequences on the nav items", async () => {
    const html = await page("/calendars");
    expect(html).toMatch(/<a class="nav-item" href="\/mirroring"[^>]*aria-keyshortcuts="G M"/);
    expect(html).toContain(`title="${en.next.shell.nav.activity} (G, A)"`);
  });

  it("keeps the palette markup small", async () => {
    const html = await page("/mirroring");
    expect(dialogOf(html, "palette").length).toBeLessThan(9000);
    expect(dialogOf(html, "shortcuts").length).toBeLessThan(2000);
  });

  it("names identity per row with attributes only, and each mark once", async () => {
    const palette = dialogOf(await page("/mirroring"), "palette");
    const rows = options(palette);
    const mirrorings = rows.filter((row) => row.includes("/mirroring?d=pal-"));
    const calendars = rows.filter((row) => row.includes("/calendars?c="));
    expect(mirrorings).toHaveLength(6);
    for (const row of mirrorings) {
      expect(row).toMatch(/ data-level="(off|busy|title|full)(-private|-open)?"/);
      expect(row).toMatch(/ style="--c:#[0-9a-f]{6}"/);
    }
    for (const row of calendars) {
      expect(row).toMatch(/ data-p="(microsoft|google)"/);
      expect(row).toMatch(/ style="--c:#[0-9a-f]{6}"/);
    }
    // No drawing in a row.
    expect(rows.filter((row) => row.includes("<svg"))).toEqual([]);
    // The marks come once, in a template that `palette.js` copies from.
    const marks = palette.match(/<template data-marks[\s\S]*?<\/template>/)?.[0] ?? "";
    expect(marks).toContain('class="cal-swatch"');
    expect(marks).toContain('class="po-check"');
    expect(marks.match(/class="lmark"/g)?.length ?? 0).toBeLessThanOrEqual(7);
  });

  it("gives each group its kind and each theme its own words", async () => {
    for (const [language, catalog] of [
      ["en", en],
      ["de", de],
    ] as const) {
      const palette = dialogOf(await page("/mirroring", language), "palette");
      const kinds = catalog.next.palette.kinds;
      for (const kind of [kinds.page, kinds.mirroring, kinds.calendar, kinds.action]) {
        expect(palette, language).toContain(`data-kind="${kind}"`);
      }
      const words = catalog.next.palette.keywords.themeChoice;
      expect(palette).toMatch(new RegExp(`data-k="${words.dark}"[^>]*data-action="theme:dark"`));
      expect(words.dark).toMatch(/dark/);
      expect(words.dark).toMatch(/dunkel/);
      expect(words.light).not.toMatch(/dark|dunkel/);
      expect(palette.match(/class="po-check"/g)).toHaveLength(1);
    }
  });

  it("lists connecting a calendar as an action, not as a calendar", async () => {
    const palette = dialogOf(await page("/calendars"), "palette");
    const connects = hrefs(palette).filter((href) => href.startsWith("/auth/"));
    expect(connects.length).toBeGreaterThan(0);
    for (const href of connects) {
      const before = palette.slice(0, palette.indexOf(`href="${href}"`));
      const group = before.slice(before.lastIndexOf('aria-labelledby="pg-') + 20).split('"')[0];
      expect(group, href).toBe("actions");
    }
  });

  it("offers the account menu as a button that only opens it", async () => {
    for (const path of APP_PAGES) {
      const palette = dialogOf(await page(path), "palette");
      const menu = options(palette).find((row) => row.includes('data-id="a:menu"')) ?? "";
      expect(menu, path).toMatch(/^<button role="option"/);
      expect(menu, path).toContain('type="button"');
      expect(menu, path).toContain('data-action="menu"');
      expect(menu, path).not.toMatch(/href=|form=|type="submit"/);
      expect(text(menu), path).toContain(en.next.palette.items.accountMenu);
    }
  });

  it("names the trigger for screen readers also where its label is hidden (phone)", async () => {
    const html = await page("/", "de");
    const trigger = html.match(/<button[^>]*class="palette-trigger"[^>]*>/)?.[0] ?? "";
    expect(trigger).toContain(`aria-label="${de.next.palette.open}"`);
  });

  it("finds words of both languages in both languages", () => {
    for (const catalog of [en, de]) {
      const words = catalog.next.palette.keywords;
      expect(words.overview).toMatch(/overview|übersicht/);
      expect(words.overview).toContain("übersicht");
      expect(words.admin).toContain("people");
      expect(words.admin).toContain("personen");
      expect(words.forAll).toContain("title");
      expect(words.forAll).toContain("titel");
      expect(words.languageNames.en).toBe("english englisch");
      expect(words.languageNames.de).toBe("deutsch german");
      expect(words.accountMenu).toMatch(/sign out/);
      expect(words.accountMenu).toMatch(/abmelden/);
    }
    expect(de.next.palette.keywords.overview).toContain("overview");
  });
});
