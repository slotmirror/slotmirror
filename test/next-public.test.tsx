import { env, exports } from "cloudflare:workers";
import { createApiToken } from "../src/api-tokens";
import { Hono } from "hono";
import type { Child } from "hono/jsx";
import { describe, expect, it } from "vitest";
// @ts-expect-error `?raw` imports are untyped without `vite/client`
import publicScript from "../public/next/public.js?raw";
// @ts-expect-error `?raw` imports are untyped without `vite/client`
import themeScript from "../public/next/theme.js?raw";
// @ts-expect-error `?raw` imports are untyped without `vite/client`
import publicLayoutSource from "../src/pages/next/public-layout.tsx?raw";
// @ts-expect-error `?raw` imports are untyped without `vite/client`
import shellSource from "../src/pages/next/shell.tsx?raw";
import { i18nFor, LOCALES, type Locale } from "../src/i18n";
import {
  ConsentPage,
  DeleteUserPage,
  DisconnectPage,
  MessagePage,
  OAuthErrorPage,
  SignInPage,
} from "../src/pages/next/public";
import { PREVIEW_PAGES, previewPage } from "../src/pages/next/public/preview";
import { render } from "../src/render";
import type { CurrentUser } from "../src/users";
import { BASE, signIn, withoutShellDialogs } from "./helpers";

const USER: CurrentUser = {
  id: "u1",
  orgId: "o1",
  email: "ada@example.com",
  role: "admin",
  mcpForMembers: "all",
};

/** Variants that the dev preview offers, so that edge states render too. */
const VARIANTS: Record<string, string[]> = {
  "sign-in": ["", "google", "microsoft", "notice"],
  setup: ["", "partial", "invalid"],
  consent: ["", "long", "unnamed", "events"],
  privacy: ["", "user", "unknown", "notice"],
  message: ["", "long", "user"],
  "oauth-error": ["", "plain", "nocode"],
  disconnect: ["", "none"],
  delete: ["", "other"],
  cleanup: ["empty", "running", "both"],
};

async function html(page: Child, locale: Locale = "en"): Promise<string> {
  const app = new Hono();
  app.get("/", (c) => {
    c.set("language", locale);
    return render(c, page);
  });
  const response = await app.request("/");
  expect(response.status).toBe(200);
  return response.text();
}

/** Forms of a page: action, method, and the names and values of the fields, in a stable order. */
function formSignatures(page: string): string[] {
  return [...page.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)]
    .map(([, attributes = "", body = ""]) => {
      const attribute = (name: string) =>
        new RegExp(`\\b${name}="([^"]*)"`).exec(attributes)?.[1] ?? "";
      const fields = [...body.matchAll(/<(?:input|button)\b([^>]*)>/g)]
        .map(([, field = ""]) => {
          const part = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(field)?.[1] ?? "";
          return `${part("name")}=${part("value")}`;
        })
        .filter((field) => field !== "=")
        .sort();
      return `${attribute("method")} ${attribute("action")} [${fields.join(",")}]`;
    })
    .sort();
}

/** The text as the page escapes it. */
function escaped(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("'", "&#39;");
}

function hrefs(page: string, pattern: RegExp): string[] {
  return [...page.matchAll(/href="([^"]*)"/g)]
    .map((match) => match[1] ?? "")
    .filter((href) => pattern.test(href))
    .sort();
}

describe("pages outside the app, in the new design", () => {
  it("renders every page and variant in both languages", async () => {
    for (const page of PREVIEW_PAGES) {
      for (const variant of VARIANTS[page] ?? [""]) {
        const out: Record<string, string> = {};
        for (const locale of LOCALES) {
          const node = previewPage(page, variant, USER);
          expect(node, `${page}?v=${variant}`).not.toBeNull();
          out[locale] = await html(node, locale);
          expect(out[locale], `${page}?v=${variant} ${locale}`).toContain(`<html lang="${locale}"`);
        }
        // The pages differ between languages, except the ones that quote only fixed text.
        if (page !== "message" && page !== "oauth-error") {
          expect(out.en, `${page}?v=${variant}`).not.toBe(out.de);
        }
      }
    }
  });

  it("has no inline script, no inline style element, no divider and no em dash", async () => {
    for (const page of PREVIEW_PAGES) {
      for (const variant of VARIANTS[page] ?? [""]) {
        for (const locale of LOCALES) {
          const out = await html(previewPage(page, variant, USER), locale);
          const label = `${page}?v=${variant} ${locale}`;
          expect(out, label).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
          expect(out, label).not.toContain("<style");
          expect(out, label).not.toContain("<hr");
          expect(out, label).not.toContain("—");
          expect(out, label).not.toContain("onclick=");
        }
      }
    }
  });

  it("supports both themes: theme script, color-scheme meta, base tokens and page stylesheet", async () => {
    for (const page of PREVIEW_PAGES) {
      const out = await html(previewPage(page, "", USER));
      expect(out, page).toMatch(/src="\/next\/theme\.[0-9a-f]{10}\.js"/);
      expect(out, page).toMatch(/href="\/next\/base\.[0-9a-f]{10}\.css"/);
      expect(out, page).toMatch(/href="\/next\/public\.[0-9a-f]{10}\.css"/);
      expect(out, page).toContain('<meta name="color-scheme" content="light dark"');
    }
  });

  it("keeps the forms of the pages: action, method, field names and hidden values", async () => {
    // Pinned from the pages of the first design: stale clients and the endpoints depend on them.
    const pairs: [string, Child, string[]][] = [
      [
        "consent",
        <ConsentPage
          user={USER}
          appName="App"
          returnsTo="host.example"
          resume="/oauth/authorize?x=1"
          ticket="t-1"
        />,
        [
          "post /auth/logout [resume=/oauth/authorize?x=1]",
          "post /oauth/authorize [decision=allow,decision=deny,ticket=t-1]",
          "post /oauth/authorize [decision=allow,decision=deny,ticket=t-1]",
        ],
      ],
      [
        "consent with events",
        <ConsentPage
          user={USER}
          appName="App"
          returnsTo="host.example"
          resume="/oauth/authorize?x=1"
          ticket="t-1"
          offerEvents
        />,
        [
          "post /auth/logout [resume=/oauth/authorize?x=1]",
          "post /oauth/authorize [decision=allow,decision=deny,events=1,ticket=t-1]",
          "post /oauth/authorize [decision=allow,decision=deny,events=1,ticket=t-1]",
        ],
      ],
      [
        "delete self",
        <DeleteUserPage
          user={USER}
          target={null}
          ownAccounts={2}
          action="/account/delete"
          cancel="/"
        />,
        ["post /account/delete []"],
      ],
      [
        "delete other",
        <DeleteUserPage
          user={USER}
          target={{ email: "g@example.com", accounts: 1 }}
          ownAccounts={0}
          action="/admin/users/x/delete"
          cancel="/admin"
        />,
        ["post /admin/users/x/delete []"],
      ],
      [
        "disconnect",
        <DisconnectPage user={USER} accountId="acc-1" email="a@example.com" rules={2} />,
        ["post /accounts/acc-1/disconnect []"],
      ],
    ];
    // The message page has no form; its one way out is a link to the start page.
    expect(await html(<MessagePage title="T" message="M" user={USER} />)).toContain('href="/"');
    for (const [name, page, expected] of pairs) {
      // The sign-out form of the app sidebar has no field and is not part of the page. The one of
      // the consent page names the request to open again, so it stays.
      // The palette and the shortcut sheet of the app shell hold a reload form and a dialog form.
      const own = (forms: string[]) => forms.filter((form) => form !== "post /auth/logout []");
      expect(own(formSignatures(withoutShellDialogs(await html(page)))), name).toEqual(expected);
    }
  });

  it("keeps the links of sign-in and of the error page", async () => {
    const providers = { microsoft: true, google: true };
    const login = /^\/auth\//;
    expect(hrefs(await html(<SignInPage providers={providers} />), login)).toEqual([
      "/auth/google/login",
      "/auth/microsoft/login",
    ]);
    expect(
      hrefs(await html(<SignInPage providers={{ ...providers, google: false }} />), login),
    ).toEqual(["/auth/microsoft/login"]);
    const error = {
      title: "T",
      lead: "L",
      code: "C",
      reference: "R",
      helpHref: "https://example.com/help#c",
      retryHref: "/auth/google/connect",
    };
    const pattern = /^(?:\/auth\/|https:\/\/example\.com)/;
    expect(hrefs(await html(<OAuthErrorPage {...error} />), pattern)).toEqual([
      "/auth/google/connect",
      "https://example.com/help#c",
    ]);
  });

  it("shows the Google hint only next to the Google choice", async () => {
    const withGoogle = await html(<SignInPage providers={{ microsoft: true, google: true }} />);
    expect(withGoogle).toContain("Google hasn’t verified this app");
    const withoutGoogle = await html(<SignInPage providers={{ microsoft: true, google: false }} />);
    expect(withoutGoogle).not.toContain("verified this app");
    expect(withoutGoogle).not.toContain("Sign in with Google");
  });

  it("holds the consent buttons off until the script ran, and works without it", async () => {
    const out = await html(
      <ConsentPage
        user={USER}
        appName="A"
        returnsTo="h.example"
        resume="/oauth/authorize?x=1"
        ticket="t"
        offerEvents
      />,
    );
    const held = /<form[^>]*data-hold[^>]*>([\s\S]*?)<\/form>/.exec(out)?.[1] ?? "";
    expect(held.match(/<button[^>]*disabled/g)).toHaveLength(2);
    expect(out).toMatch(/<noscript>[\s\S]*<form[^>]*action="\/oauth\/authorize"/);
    const script = String(publicScript);
    expect(script).toContain('querySelectorAll("form[data-hold] button")');
    expect(script).toContain("button.disabled = false");
    // The hold is the first code after the `js` class: its function and the call that starts it
    // come before every other statement, so that no error in a later part of the script can leave
    // the consent buttons off for good.
    const topLevel = script
      .split("\n")
      .filter((line) => /^[^\s/}]/.test(line))
      .slice(0, 3);
    expect(topLevel).toEqual([
      'document.documentElement.classList.add("js");',
      "function startHold() {",
      'if (document.readyState === "loading") {',
    ]);
    const start = script.slice(script.indexOf("if (document.readyState"));
    // The whole block, so that no statement can run before the hold in either branch.
    expect(start.slice(0, start.indexOf("\n}\n") + 2)).toBe(
      [
        'if (document.readyState === "loading") {',
        '  document.addEventListener("DOMContentLoaded", startHold);',
        "} else {",
        "  startHold();",
        "}",
      ].join("\n"),
    );
  });

  it("shows the operator notice before the first sign-in link", async () => {
    const out = await html(
      <SignInPage providers={{ microsoft: true, google: false }} operatorNotice="Run by IT." />,
    );
    expect(out).toContain("Run by IT.");
    expect(out.indexOf("Run by IT.")).toBeLessThan(out.indexOf("/auth/microsoft/login"));
    expect(await html(<SignInPage providers={{ microsoft: true, google: false }} />)).not.toContain(
      "Who runs this deployment",
    );
  });

  it("ships the strings in the catalogs and reuses the old privacy text word for word", async () => {
    for (const locale of LOCALES) {
      const { t } = i18nFor(locale);
      const privacy = await html(previewPage("privacy", "", USER), locale);
      // Escaped like the page escapes it; every item of the stored list is on the page.
      for (const item of t.privacy.stored) {
        expect(privacy).toContain(escaped(item));
      }
      expect(privacy).toContain(escaped(t.privacy.google));
      expect(privacy).toContain(escaped(t.privacy.delete));
    }
  });

  it("names things on the privacy page with the words of the app", async () => {
    const words = {
      en: {
        use: ["mirrorings", "What is copied", "Busy only", "copies"],
        drop: ["Blocks in", "detail level", "blocks slotmirror", "rules you create"],
      },
      de: {
        use: ["Spiegelungen", "Was kopiert wird", "Nur belegt", "Kopien"],
        drop: ["Blöcke", "Detailstufe", "Blocktitel", "Regeln"],
      },
    } as const;
    for (const locale of LOCALES) {
      const out = await html(previewPage("privacy", "", USER), locale);
      for (const word of words[locale].use) expect(out, `${locale} ${word}`).toContain(word);
      for (const word of words[locale].drop) expect(out, `${locale} ${word}`).not.toContain(word);
    }
  });

  it("states how long app access lasts, where it ends, and where the answer returns", async () => {
    for (const locale of LOCALES) {
      const { t } = i18nFor(locale);
      const out = await html(
        <ConsentPage
          user={USER}
          appName="A"
          returnsTo="h.example"
          resume="/oauth/authorize?x=1"
          ticket="t"
        />,
        locale,
      );
      expect(out).toContain(t.next.auth.consent.lasts(90));
      expect(out).toContain(`<dt>${t.next.auth.consent.returnsTo}</dt>`);
    }
    expect(i18nFor("de").t.next.auth.consent.returnsTo).toBe("Zurück zu");
  });

  it("tells on the consent what the app reads, who answers and that the name is unchecked", async () => {
    for (const locale of LOCALES) {
      const { t } = i18nFor(locale);
      for (const offerEvents of [false, true]) {
        const out = await html(
          <ConsentPage
            user={USER}
            appName="A"
            returnsTo="h.example"
            resume="/oauth/authorize?x=1"
            ticket="t"
            offerEvents={offerEvents}
          />,
          locale,
        );
        const where = `${locale}, events ${offerEvents}`;
        for (const fact of [
          t.consent.asks("A"),
          t.consent.readsLabel,
          t.consent.readOnly,
          ...t.next.auth.consent.can,
          t.consent.signedInAs(USER.email),
          t.consent.notYou,
          t.next.shell.user.signOut,
          offerEvents ? t.consent.uncheckedWithEvents : t.consent.unchecked,
          ...(offerEvents ? [t.consent.events] : []),
        ]) {
          expect(out, where).toContain(escaped(fact));
        }
        if (!offerEvents) expect(out, where).not.toContain(escaped(t.consent.events));
        // With the box, "sees no event content" would be false.
        if (offerEvents) expect(out, where).not.toContain(escaped(t.consent.unchecked));
        // The warning and the account come before the buttons that decide.
        const decide = out.indexOf('action="/oauth/authorize"');
        expect(out.indexOf("notice-warn"), where).toBeGreaterThan(-1);
        expect(out.indexOf("notice-warn"), where).toBeLessThan(decide);
        expect(out.indexOf('class="pub-account"'), where).toBeLessThan(decide);
      }
    }
  });

  it("shows the setup names as code to copy, not as fields to type into", async () => {
    const out = await html(previewPage("setup", "", USER));
    const fields = [...out.matchAll(/<input\b[^>]*readonly[^>]*>/g)].map((match) => match[0]);
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) {
      expect(field).toContain('class="pub-code pub-mono"');
      expect(field).not.toMatch(/class="[^"]*\binput\b/);
      const value = /value="([^"]*)"/.exec(field)?.[1] ?? "";
      expect(field).toContain(`size="${value.length}"`);
    }
  });

  it("opens external links in a new tab without opener or referrer", async () => {
    const setup = await html(previewPage("setup", "", USER));
    const quickstart = /<a\b[^>]*href="https:\/\/slotmirror\.com\/docs\/quickstart\/"[^>]*>/.exec(
      setup,
    );
    expect(quickstart?.[0]).toContain('target="_blank"');
    expect(quickstart?.[0]).toContain('rel="noopener noreferrer"');
    const failure = await html(
      <OAuthErrorPage
        title="T"
        lead="L"
        code="C"
        reference="R"
        helpHref="https://example.com/help#c"
        retryHref="/auth/google/connect"
      />,
    );
    const help = /<a\b[^>]*href="https:\/\/example\.com\/help#c"[^>]*>/.exec(failure);
    expect(help?.[0]).toContain('target="_blank"');
    expect(help?.[0]).toContain('rel="noopener noreferrer"');
  });

  it("hides the controls that need a script with the stylesheet only, not with `hidden`", async () => {
    for (const page of ["sign-in", "setup", "oauth-error"]) {
      const variant = page === "oauth-error" ? "plain" : "";
      const out = await html(previewPage(page, variant, USER));
      const marked = [...out.matchAll(/<[^>]*data-needs-script[^>]*>/g)].map((match) => match[0]);
      // Control: each of these pages has such a control.
      expect(marked.length, page).toBeGreaterThan(0);
      for (const tag of marked) expect(tag, page).not.toMatch(/\shidden(\s|=|>)/);
    }
    // The theme script has no loop that shows them: the `js` class does it.
    expect(String(themeScript)).not.toMatch(/\.hidden\s*=\s*false/);
    expect(String(themeScript)).not.toContain("[data-needs-script]");
  });

  it("defines the language link once, in the shell, and the public layout uses it", async () => {
    expect(String(shellSource)).toMatch(/export function LanguageLink\(/);
    expect(String(publicLayoutSource)).not.toMatch(/function LanguageLink/);
    expect(String(publicLayoutSource)).toMatch(
      /import \{[^}]*LanguageLink[^}]*\} from "\.\/shell"/,
    );
    const out = await html(previewPage("sign-in", "", USER));
    expect(out).toContain('hreflang="de"');
  });

  it("cancels a disconnect back to the calendar panel", async () => {
    const out = await html(
      <DisconnectPage user={USER} accountId="acc 1" email="a@example.com" rules={0} />,
    );
    expect(out).toContain('href="/calendars?c=acc%201"');
  });
});

describe("the swap leaves the auth routes as they were", () => {
  async function get(path: string, cookie?: string) {
    return exports.default.fetch(`${BASE}${path}`, {
      headers: cookie ? { cookie } : undefined,
      redirect: "manual",
    });
  }

  it("serves the sign-in page with the new layout and the old links", async () => {
    const response = await get("/");
    expect(response.status).toBe(200);
    const out = await response.text();
    expect(out).toContain('class="pub-panel"');
    expect(out).toContain('href="/auth/microsoft/login"');
    expect(out).not.toContain("/style.css");
  });

  it("answers a callback without a flow cookie with 400 and the new message page", async () => {
    const response = await get("/auth/microsoft/callback?code=x&state=y");
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('class="pub-panel"');
  });

  it("keeps 404 for an unknown provider and the redirects of the signed-out routes", async () => {
    expect((await get("/auth/nobody/login")).status).toBe(404);
    for (const path of ["/account/delete", "/auth/microsoft/connect"]) {
      const response = await get(path);
      expect(response.status, path).toBe(302);
      expect(response.headers.get("location"), path).toBe("/");
    }
  });

  it("refuses a cross-site post with 403 and the new message page", async () => {
    const response = await exports.default.fetch(`${BASE}/account/delete`, {
      method: "POST",
      headers: { origin: "https://evil.example" },
      redirect: "manual",
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('class="pub-panel"');
  });

  it("shows the privacy page in the shell for a signed-in user and in the public layout for a visitor", async () => {
    const { cookie } = await signIn("next-public@org.example");
    const user = await (await get("/privacy", cookie)).text();
    expect(user).toContain('class="sidebar"');
    expect(user).toContain("next-public@org.example");
    const visitor = await (await get("/privacy")).text();
    expect(visitor).toContain('class="pub-panel"');
    expect(visitor).not.toContain('class="sidebar"');
  });

  it("shows the delete page in the shell and keeps its form", async () => {
    const { cookie } = await signIn("next-public-delete@org.example");
    const response = await get("/account/delete", cookie);
    expect(response.status).toBe(200);
    const out = await response.text();
    expect(out).toContain('class="sidebar"');
    expect(formSignatures(out)).toContain("post /account/delete [=]".replace(" [=]", " []"));
    // Cancel returns to the new app, not to the old pages.
    const cancel = /<a class="btn btn-secondary" href="([^"]*)">Cancel<\/a>/.exec(out)?.[1];
    expect(cancel).toBe("/");
  });
});

describe("one card width, the folded Google warning, and the styled 404", () => {
  const HTML = { accept: "text/html,application/xhtml+xml" };

  async function visit(path: string, init: RequestInit = {}) {
    return exports.default.fetch(`${BASE}${path}`, { redirect: "manual", ...init });
  }

  it("renders no width class for the public layout or the in-app flow", async () => {
    // The column is 480 px for every page; the stylesheet rule is checked in
    // `next-admin-public-css.node.test.ts`.
    for (const page of PREVIEW_PAGES) {
      const out = await html(previewPage(page, "", USER));
      expect(out, page).not.toMatch(/pub-(narrow|wide)/);
      expect(out, page).not.toMatch(/pub-flow-(narrow|wide)/);
    }
  });

  it("folds the Google warning into a closed details element under the Google button", async () => {
    const providers = { microsoft: true, google: true };
    const en = await html(<SignInPage providers={providers} />);
    const group = /<details class="pub-google-note">([\s\S]*?)<\/details>/.exec(en)?.[1] ?? "";
    expect(group).toContain("About Google’s warning screen");
    expect(group).toContain("Google hasn’t verified this app");
    // The warning text appears nowhere else on the page, and the element starts closed.
    expect(en.split("Google hasn’t verified this app")).toHaveLength(2);
    expect(en).not.toMatch(/<details[^>]*\sopen/);
    // It follows the Google button, not the Microsoft one.
    expect(en.indexOf("Sign in with Google")).toBeLessThan(en.indexOf("pub-google-note"));
    const de = await html(<SignInPage providers={providers} />, "de");
    expect(de).toContain("Zu Googles Warnhinweis");
  });

  it("answers a browser GET on an unknown address with the styled 404, signed out", async () => {
    const response = await visit("/no/such/page", { headers: HTML });
    expect(response.status).toBe(404);
    const out = await response.text();
    expect(out).toContain('class="pub-panel"');
    expect(out).toContain("Page not found");
    expect(out).toContain("This address does not exist. It may have been mistyped or removed.");
    expect(out).toMatch(/<a class="btn btn-primary" href="\/">Go to Overview<\/a>/);
    expect(out).not.toContain('class="sidebar"');
    const de = await (
      await visit("/no/such/page", { headers: { ...HTML, "accept-language": "de" } })
    ).text();
    expect(de).toContain("Seite nicht gefunden");
    expect(de).toContain(
      "Diese Adresse gibt es nicht. Sie ist vielleicht falsch geschrieben oder wurde entfernt.",
    );
    expect(de).toContain("Zur Übersicht");
  });

  it("answers the same request signed in inside the app shell, with the way back to /", async () => {
    const { cookie } = await signIn("next-public-404@org.example");
    const response = await visit("/no/such/page", { headers: { ...HTML, cookie } });
    expect(response.status).toBe(404);
    const out = await response.text();
    expect(out).toContain('class="sidebar"');
    expect(out).toContain("Page not found");
    expect(out).toMatch(/<a class="btn btn-primary" href="\/">Go to Overview<\/a>/);
  });

  it("keeps the plain-text 404 for MCP, API, other methods and clients that do not ask for HTML", async () => {
    const { user } = await signIn("next-public-mcp@org.example");
    const mcpToken = (await createApiToken(env, user, { name: "t", days: 1 }))?.token ?? "";
    expect(mcpToken).not.toBe("");
    const cases: [string, RequestInit][] = [
      ["/mcp/nothing", { headers: { ...HTML, authorization: `Bearer ${mcpToken}` } }],
      ["/api/nothing", { headers: HTML }],
      ["/oauth/nothing", { headers: HTML }],
      ["/no/such/page", { method: "POST", headers: { ...HTML, origin: BASE } }],
      ["/no/such/page", { headers: { accept: "application/json" } }],
      ["/no/such/page", { headers: { accept: "*/*" } }],
      ["/no/such/page", {}],
    ];
    for (const [path, init] of cases) {
      const label = `${init.method ?? "GET"} ${path} ${JSON.stringify(init.headers ?? {})}`;
      const response = await visit(path, init);
      expect(response.status, label).toBe(404);
      expect(response.headers.get("content-type"), label).toContain("text/plain");
      expect(await response.text(), label).toBe("Not found");
    }
  });
});
