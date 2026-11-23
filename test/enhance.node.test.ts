import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { ASSET_DIR } from "../scripts/asset-manifest-lib.mjs";

/**
 * The browser scripts under `public/next/` run here in a small fake browser: a document without
 * markup that only counts listeners. That is enough for the pure rules of `enhance.js` and for the
 * rules every page script must keep, because the shell will load all of them on every page:
 * no error on a page without its markup, and no second set of listeners when a script runs twice.
 * Browser behaviour is checked by the agent-browser scripts in `test/browser/`.
 */

const ORIGIN = "http://localhost:8822";
const PAGE_SCRIPTS = [
  "theme.js",
  "panel.js",
  "mirroring.js",
  "calendars.js",
  "activity.js",
  "tokens.js",
  "palette.js",
];

const source = (name: string) => readFileSync(join(ASSET_DIR, name), "utf8");

interface FakeBrowser {
  window: Record<string, unknown>;
  listeners: string[];
  run(code: string): void;
  /** Calls the document's listeners of `type`, as the browser would for an event. */
  fire(type: string, detail?: unknown): void;
}

function fakeBrowser(
  readyState = "complete",
  opts: { search?: string; stored?: string | null; rootDefault?: string; appBase?: string } = {},
): FakeBrowser {
  const storage = new Map<string, string>();
  if (opts.stored) storage.set("slotmirror-enhance", opts.stored);
  const listeners: string[] = [];
  const handlers: { key: string; fn: (event: unknown) => void }[] = [];
  const target = (name: string) => ({
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners.push(`${name}:${type}`);
      handlers.push({ key: `${name}:${type}`, fn });
    },
    removeEventListener: () => {},
    dispatchEvent: () => true,
  });
  const element = {
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    dataset: {
      ...(opts.rootDefault ? { enhanceDefault: opts.rootDefault } : {}),
      ...(opts.appBase === undefined ? {} : { appBase: opts.appBase }),
    },
    hasAttribute: () => false,
    setAttribute() {},
    removeAttribute() {},
  };
  const document = {
    ...target("document"),
    readyState,
    documentElement: element,
    head: { querySelectorAll: () => [], append() {} },
    body: null,
    scripts: [],
    forms: [],
    title: "",
    activeElement: null,
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
  };
  const window: Record<string, unknown> = {
    ...target("window"),
    document,
    location: {
      href: `${ORIGIN}/`,
      origin: ORIGIN,
      search: opts.search ?? "",
      pathname: "/",
      assign() {},
    },
    history: { state: null, replaceState() {}, pushState() {} },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    navigator: { platform: "MacIntel", userAgent: "Mozilla/5.0" },
    matchMedia: () => ({ matches: false }),
    sessionStorage: { getItem: () => null, setItem() {} },
    performance: { now: () => 0, getEntriesByType: () => [] },
    URL,
    URLSearchParams,
    CustomEvent: class {},
    setTimeout,
    clearTimeout,
    console,
  };
  window.window = window;
  window.self = window;
  const fire = (type: string, detail?: unknown) => {
    const event = { type, detail, target: document, preventDefault() {}, defaultPrevented: false };
    for (const h of handlers.filter((x) => x.key === `document:${type}`)) h.fn(event);
  };
  return { window, listeners, run: (code) => runInNewContext(code, window), fire };
}

const enhance = (appBase?: string) => {
  const browser = fakeBrowser("loading", { appBase });
  browser.run(source("enhance.js"));
  const api = browser.window.slotmirror as { _test: Record<string, (...args: never[]) => unknown> };
  return api._test as unknown as {
    linkRule(o: object): string;
    formRule(o: object): string;
    getUrl(action: string, entries: [string, string][], omitEmpty: boolean): string;
    navKind(o: object): string;
    answerRule(o: object): string;
    stripSaved(href: string): string;
    panelKey(href: string): string;
    keepHash(answered: string, asked: string): string;
  };
};

const BASE = `${ORIGIN}/mirroring`;
const click = { base: BASE, origin: ORIGIN, button: 0 };

describe("enhance.js: which links it takes", () => {
  const { linkRule } = enhance();
  it("takes a plain click on an app link", () => {
    expect(linkRule({ ...click, href: "/mirroring?d=a~b" })).toBe("enhance");
    expect(linkRule({ ...click, href: "?d=a~b" })).toBe("enhance");
    expect(linkRule({ ...click, href: "/" })).toBe("enhance");
  });
  it("leaves modified clicks, other buttons, targets, downloads and other origins alone", () => {
    const href = "/calendars";
    expect(linkRule({ ...click, href, modified: true })).toBe("skip");
    expect(linkRule({ ...click, href, button: 1 })).toBe("skip");
    expect(linkRule({ ...click, href, target: "_blank" })).toBe("skip");
    expect(linkRule({ ...click, href, download: true })).toBe("skip");
    expect(linkRule({ ...click, href, prevented: true })).toBe("skip");
    expect(linkRule({ ...click, href: "https://example.com/next" })).toBe("skip");
    expect(linkRule({ ...click, href: "mailto:a@b.c" })).toBe("skip");
  });
  it("leaves a jump to an anchor on the same page to the browser", () => {
    expect(linkRule({ ...click, href: "#main" })).toBe("skip");
    expect(linkRule({ ...click, href: "/mirroring#main" })).toBe("skip");
  });
  it("lets the browser load links outside the app pages, files, language links and opt-outs, after the guard", () => {
    for (const href of [
      "/privacy",
      "/auth/google/connect",
      "/mirroring/x/y.css",
      "/rules",
      "/admin/users/u1/delete/x.png",
      "/next/base.css",
      "/next/x.js",
    ]) {
      expect(linkRule({ ...click, href }), href).toBe("native");
    }
    expect(linkRule({ ...click, href: "/?lang=de", hreflang: true })).toBe("native");
    expect(linkRule({ ...click, href: "/tokens", off: true })).toBe("native");
    expect(linkRule({ ...click, href: "/tokens", external: true })).toBe("native");
  });
});

describe("enhance.js: which addresses are app pages", () => {
  const pages = ["/", "/mirroring", "/calendars?c=x", "/activity", "/admin", "/tokens"];
  it("takes the Overview and the pages of the app without a prefix", () => {
    const { linkRule } = enhance("");
    for (const href of pages) expect(linkRule({ ...click, href }), href).toBe("enhance");
  });
  it("leaves every other page, the old prefix and the assets to the browser", () => {
    const { linkRule } = enhance("");
    for (const href of [
      "/rules",
      "/privacy",
      "/cleanup",
      "/account/delete",
      "/next",
      "/next/mirroring",
      "/next/mirroring.abc1234567.js",
      "/next/base.abc1234567.css",
      "/mirroring.js",
      "/mirroringx",
    ]) {
      expect(linkRule({ ...click, href }), href).toBe("native");
    }
  });
  it("moves the pages under a base that the server names", () => {
    const { linkRule } = enhance("/app");
    for (const href of ["/app", "/app/mirroring", "/app/calendars?c=x", "/app/admin"]) {
      expect(linkRule({ ...click, href }), href).toBe("enhance");
    }
    for (const href of ["/", "/mirroring", "/application", "/app/rules", "/app/mirroring.js"]) {
      expect(linkRule({ ...click, href }), href).toBe("native");
    }
  });
  it("escapes the base, so that it matches only itself", () => {
    const { linkRule } = enhance("/a.b");
    expect(linkRule({ ...click, href: "/a.b/mirroring" })).toBe("enhance");
    expect(linkRule({ ...click, href: "/axb/mirroring" })).toBe("native");
  });
});

describe("enhance.js: which forms it takes", () => {
  const { formRule } = enhance();
  const form = { base: BASE, origin: ORIGIN };
  it("takes GET and POST forms of the app pages", () => {
    expect(formRule({ ...form, action: "/activity", method: "get" })).toBe("enhance");
    expect(formRule({ ...form, action: `${ORIGIN}/mirroring`, method: "post" })).toBe("enhance");
  });
  it("takes a POST to an old endpoint only with a `back` on an app page", () => {
    const action = "/rules/calendars/refresh";
    expect(formRule({ ...form, action, method: "post", back: "/mirroring" })).toBe("enhance");
    expect(formRule({ ...form, action, method: "post", back: "/rules" })).toBe("native");
    expect(formRule({ ...form, action, method: "post" })).toBe("native");
    expect(formRule({ ...form, action, method: "post", back: "//evil.example/next" })).toBe(
      "native",
    );
  });
  it("leaves sign-out, foreground saves, uploads and opt-outs to the browser", () => {
    expect(formRule({ ...form, action: "/auth/logout", method: "post" })).toBe("native");
    expect(formRule({ ...form, action: "/tokens", method: "post", foreground: true })).toBe(
      "native",
    );
    expect(formRule({ ...form, action: "/mirroring/x", method: "post", multipart: true })).toBe(
      "native",
    );
    expect(formRule({ ...form, action: "/mirroring/x", method: "post", off: true })).toBe("native");
  });
  it("skips dialogs, other targets, other origins and stopped submits", () => {
    expect(formRule({ ...form, action: "/", method: "dialog" })).toBe("skip");
    expect(formRule({ ...form, action: "/", method: "post", target: "_blank" })).toBe("skip");
    expect(formRule({ ...form, action: "https://example.com/next", method: "post" })).toBe("skip");
    expect(formRule({ ...form, action: "/", method: "post", prevented: true })).toBe("skip");
  });
});

describe("enhance.js: addresses", () => {
  const { getUrl, stripSaved } = enhance();
  it("builds a GET form address from the fields, without the action's old query", () => {
    const entries: [string, string][] = [
      ["d", "a~b"],
      ["c", ""],
      ["kind", "problems"],
    ];
    expect(getUrl(`${ORIGIN}/activity?old=1`, entries, false)).toBe(
      `${ORIGIN}/activity?d=a%7Eb&c=&kind=problems`,
    );
    expect(getUrl(`${ORIGIN}/activity`, entries, true)).toBe(
      `${ORIGIN}/activity?d=a%7Eb&kind=problems`,
    );
  });
  it("drops `saved` and the hash, and keeps the rest as written", () => {
    expect(stripSaved(`${ORIGIN}/mirroring?d=a~b&saved=1#x`)).toBe(`${ORIGIN}/mirroring?d=a~b`);
    expect(stripSaved(`${ORIGIN}/calendars?saved=1&c=x`)).toBe(`${ORIGIN}/calendars?c=x`);
    expect(stripSaved(`${ORIGIN}/?saved=1`)).toBe(`${ORIGIN}/`);
    expect(stripSaved(`${ORIGIN}/?unsaved=1`)).toBe(`${ORIGIN}/?unsaved=1`);
  });
});

describe("enhance.js: kind of navigation", () => {
  const { navKind } = enhance();
  const m = `${ORIGIN}/mirroring`;
  const get = (from: string, to: string, oldPanel: boolean, newPanel: boolean, source = "link") =>
    navKind({ from, to, method: "get", source, oldPanel, newPanel });
  it("tells panel open, switch and close apart on the same page", () => {
    expect(get(m, `${m}?d=a~b`, false, true)).toBe("panel-open");
    expect(get(`${m}?d=a~b`, `${m}?d=c~d`, true, true)).toBe("panel-switch");
    expect(get(`${m}?d=a~b`, m, true, false)).toBe("panel-close");
  });
  it("calls another path a page change, and the same address a refresh", () => {
    expect(get(m, `${ORIGIN}/calendars`, false, false)).toBe("page");
    expect(get(`${m}?d=a~b`, `${m}?d=a~b&saved=1`, true, true)).toBe("refresh");
  });
  it("calls a GET form on the same page a filter, and a pager link a same-page change", () => {
    const a = `${ORIGIN}/activity`;
    expect(get(a, `${a}?kind=problems`, false, false, "form")).toBe("filter");
    expect(get(a, `${a}?before=5`, false, false)).toBe("same");
  });
  it("does not take the activity filter `d` for a panel", () => {
    const a = `${ORIGIN}/activity`;
    expect(get(a, `${a}?d=a~b`, false, false)).toBe("same");
  });
  it("tells saves, refusals and other POST answers apart", () => {
    const post = (to: string, status: number, redirected: boolean) =>
      navKind({
        from: `${m}?d=a~b`,
        to,
        method: "post",
        source: "form",
        status,
        redirected,
        oldPanel: true,
        newPanel: true,
      });
    expect(post(`${m}?d=a~b&saved=1`, 200, true)).toBe("save");
    expect(post(`${m}`, 400, false)).toBe("refused");
    expect(post(`${m}`, 409, false)).toBe("conflict");
    expect(post(`${m}`, 200, false)).toBe("result");
    expect(post(`${m}?d=c~d`, 200, true)).toBe("panel-switch");
    expect(post(`${ORIGIN}/`, 200, true)).toBe("page");
  });
  it("calls history steps pop", () => {
    expect(navKind({ from: m, to: `${m}?d=a~b`, source: "pop" })).toBe("pop");
  });
});

describe("enhance.js: which panel an address shows", () => {
  const { panelKey } = enhance();
  const m = `${ORIGIN}/mirroring`;
  it("keys a panel on the path and the parameters that pick it", () => {
    expect(panelKey(`${m}?d=a~b`)).not.toBe(panelKey(`${m}?d=all`));
    expect(panelKey(`${m}?d=a~b`)).not.toBe(panelKey(`${ORIGIN}/calendars?d=a~b`));
    expect(panelKey(`${ORIGIN}/calendars?c=x`)).not.toBe(panelKey(`${ORIGIN}/calendars?c=y`));
    expect(panelKey(`${ORIGIN}/admin?u=1`)).not.toBe(
      panelKey(`${ORIGIN}/admin?u=1&confirm=delete`),
    );
    // A calendar panel opened from a mirroring has a back link: another panel.
    expect(panelKey(`${ORIGIN}/calendars?c=x`)).not.toBe(
      panelKey(`${ORIGIN}/calendars?c=x&from=a~x`),
    );
  });
  it("keeps the panel for any other parameter, `saved` and the hash", () => {
    expect(panelKey(`${m}?d=a~b&saved=1#x`)).toBe(panelKey(`${m}?d=a~b`));
    expect(panelKey(`${m}?d=a~b&tab=2`)).toBe(panelKey(`${m}?tab=1&d=a~b`));
  });
});

describe("enhance.js: the address of an answer", () => {
  const { keepHash } = enhance();
  const c = `${ORIGIN}/calendars?c=x&from=a~x`;
  it("keeps the hash that was asked for, as a browser does over a redirect", () => {
    expect(keepHash(c, `${c}#cal-hours-on`)).toBe(`${c}#cal-hours-on`);
    expect(keepHash(`${ORIGIN}/calendars?c=x`, `${c}#cal-hours-on`)).toBe(
      `${ORIGIN}/calendars?c=x#cal-hours-on`,
    );
  });
  it("keeps the answer's own hash, and adds none when none was asked for", () => {
    expect(keepHash(`${c}#a`, `${c}#b`)).toBe(`${c}#a`);
    expect(keepHash(c, c)).toBe(c);
  });
});

describe("enhance.js: what to do with an answer", () => {
  const { answerRule } = enhance();
  const ok = {
    origin: ORIGIN,
    url: `${ORIGIN}/mirroring`,
    html: true,
    app: true,
    status: 200,
    sameAssets: true,
  };
  it("merges a good GET answer", () => {
    expect(answerRule({ ...ok, method: "get" })).toBe("merge");
  });
  it("loads the page normally on any doubt about a GET", () => {
    expect(answerRule({ ...ok, method: "get", network: true })).toBe("load");
    expect(answerRule({ ...ok, method: "get", url: `${ORIGIN}/privacy` })).toBe("load");
    expect(answerRule({ ...ok, method: "get", html: false })).toBe("load");
    expect(answerRule({ ...ok, method: "get", app: false })).toBe("load");
    expect(answerRule({ ...ok, method: "get", sameAssets: false })).toBe("load");
    expect(answerRule({ ...ok, method: "get", status: 404 })).toBe("load");
    expect(answerRule({ ...ok, method: "get", status: 500 })).toBe("load");
  });
  it("never loads after a failed POST: the page stays and shows the error", () => {
    const post = { ...ok, method: "post" };
    expect(answerRule({ ...post, network: true })).toBe("error");
    expect(answerRule({ ...post, html: false })).toBe("error");
    expect(answerRule({ ...post, app: false })).toBe("error");
    expect(answerRule({ ...post, status: 500 })).toBe("error");
    expect(answerRule({ ...post, status: 403 })).toBe("error");
  });
  it("shows the session note when a panel save ends outside the app pages", () => {
    expect(
      answerRule({
        ...ok,
        method: "post",
        url: `${ORIGIN}/privacy`,
        redirected: true,
        panel: true,
      }),
    ).toBe("session");
    // A form without a save bar goes where the server sent it: the POST is done, this is a GET.
    expect(answerRule({ ...ok, method: "post", url: `${ORIGIN}/rules`, redirected: true })).toBe(
      "load",
    );
  });
  it("keeps the history entry for a refused save and an answer without redirect", () => {
    expect(answerRule({ ...ok, method: "post", status: 400 })).toBe("keep");
    expect(answerRule({ ...ok, method: "post", status: 400, sameAssets: false })).toBe("keep");
    expect(answerRule({ ...ok, method: "post", redirected: false })).toBe("keep");
  });
  it("keeps the entry for a conflict, also after a deploy (the panel shows the stored values)", () => {
    expect(answerRule({ ...ok, method: "post", status: 409 })).toBe("keep");
    expect(answerRule({ ...ok, method: "post", status: 409, sameAssets: false })).toBe("keep");
  });
  it("calls a stored panel save whose page failed stale, not failed", () => {
    const after = { ...ok, method: "post", redirected: true, status: 500 };
    expect(answerRule({ ...after, panel: true })).toBe("stale");
    expect(answerRule({ ...after, panel: false })).toBe("error");
    expect(answerRule({ ...after, panel: true, redirected: false })).toBe("error");
  });
  it("merges a saved redirect, and loads it after a deploy", () => {
    expect(answerRule({ ...ok, method: "post", redirected: true })).toBe("merge");
    expect(answerRule({ ...ok, method: "post", redirected: true, sameAssets: false })).toBe("load");
  });
});

describe("enhance.js: the switch", () => {
  const installed = (opts: Parameters<typeof fakeBrowser>[1]) => {
    const browser = fakeBrowser("loading", opts);
    browser.run(source("enhance.js"));
    return { on: Boolean(browser.window.slotmirror), listeners: browser.listeners.length, browser };
  };
  it("runs by default and stays idle when the shell's default is off", () => {
    expect(installed({}).on).toBe(true);
    const off = installed({ rootDefault: "off" });
    expect(off.on).toBe(false);
    expect(off.listeners, "an idle enhance.js listens to nothing").toBe(0);
  });
  it("lets a browser opt in or out and keeps the choice", () => {
    expect(installed({ rootDefault: "off", search: "?enhance=on" }).on).toBe(true);
    expect(installed({ rootDefault: "off", stored: "on" }).on).toBe(true);
    expect(installed({ search: "?enhance=off" }).on).toBe(false);
    expect(installed({ stored: "off" }).on).toBe(false);
    expect(installed({ stored: "off", search: "?enhance=on" }).on).toBe(true);
    const asked = installed({ search: "?enhance=off" }).browser.window.localStorage as {
      getItem(key: string): string | null;
    };
    expect(asked.getItem("slotmirror-enhance")).toBe("off");
  });
});

describe("page scripts on every page", () => {
  it.each(PAGE_SCRIPTS)(
    "%s runs on a page without its markup and registers its listeners once",
    (name) => {
      for (const readyState of ["loading", "complete"]) {
        const browser = fakeBrowser(readyState);
        expect(() => browser.run(source(name))).not.toThrow();
        const first = browser.listeners.length;
        expect(first, "a script with nothing to listen to is no page script").toBeGreaterThan(0);
        browser.run(source(name));
        expect(browser.listeners.length, `${name} registered listeners again (${readyState})`).toBe(
          first,
        );
      }
    },
  );

  it("enhance.js registers its listeners once", () => {
    const browser = fakeBrowser("loading");
    browser.run(source("enhance.js"));
    const first = browser.listeners.length;
    browser.run(source("enhance.js"));
    expect(first).toBeGreaterThan(3);
    expect(browser.listeners.length).toBe(first);
  });

  const withSync = PAGE_SCRIPTS.filter((name) => source(name).includes("const sync = "));
  it("has a sync() in the scripts that change markup", () => {
    expect(withSync).toEqual(["theme.js", "panel.js", "calendars.js", "activity.js", "palette.js"]);
  });

  /** Listeners after the script ran and then synced twice, as after two merges. */
  const afterTwoSyncs = (code: string) => {
    const browser = fakeBrowser("loading");
    browser.run(code);
    const loaded = browser.listeners.length;
    browser.fire("DOMContentLoaded");
    browser.fire("enhance:load", { kind: "panel-open" });
    browser.fire("enhance:load", { kind: "save" });
    return { loaded, synced: browser.listeners.length };
  };
  it.each(withSync)("%s adds no listener when it syncs", (name) => {
    const { loaded, synced } = afterTwoSyncs(source(name));
    expect(loaded).toBeGreaterThan(0);
    expect(synced, `${name} added listeners in sync()`).toBe(loaded);
  });

  it("the sync check finds a listener added inside sync()", () => {
    // The same script with one listener added at the start of its sync(), in a helper.
    const code = source("palette.js").replace(
      "const sync = () => {",
      "const helper = () => d.addEventListener('x', () => {});\n  const sync = () => {\n    helper();",
    );
    expect(code).toContain("helper();");
    const { loaded, synced } = afterTwoSyncs(code);
    expect(synced).toBe(loaded + 3);
  });
});
