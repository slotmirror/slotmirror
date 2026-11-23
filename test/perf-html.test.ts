import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { BASE, signIn } from "./helpers";

/**
 * HTML budgets for the app pages, checked on seeded data: three
 * calendars, three mirrorings and 150 runs in the activity log. Gzip here is workerd's
 * `CompressionStream`, which compresses a little less than `gzip -9`.
 *
 * Recorded 2026-11-17 on this seed. Sizes depend on the seed, so only the budgets are asserted:
 * see the table that the test prints.
 *
 * Gzip budget raised from 8,000 to 9,500 on 2026-11-18, on purpose: the mirroring panel now
 * draws every preview level and the notes that work without script, and the palette carries a
 * mark per row. Largest page then: the mirroring pair page, 54,568 raw / 8,816 gzip; the
 * calendar panel 8,159 gzip. No part is duplicated enough to trim 816 B without a behaviour
 * change (the 18 level-mark SVGs together are 664 B gzip).
 */
const BUDGET = { raw: 80_000, gzip: 9_500, renderBlocking: 3 };

let cookie = "";
let pages: Array<{ path: string; html: string; gzip: number }> = [];

async function gzipSize(text: string): Promise<number> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return (await new Response(stream).arrayBuffer()).byteLength;
}

beforeAll(async () => {
  const signedIn = await signIn("perf-html@org.example");
  cookie = signedIn.cookie;
  const prefix = "perf";
  const ids = { a: `${prefix}-a`, b: `${prefix}-b`, c: `${prefix}-c` };
  const rows = [
    [ids.a, "perf@alpha.example", "microsoft"],
    [ids.b, "perf@beta.example", "google"],
    [ids.c, "perf@gamma.example", "microsoft"],
  ] as const;
  const rules: string[] = [];
  for (const [id, address, provider] of rows) {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, ?, ?)",
      ).bind(id, signedIn.user.id, provider, address),
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, ?, 'Main', 1, 1, 1)",
      ).bind(`${id}-cal`, id, `${id}-remote`),
    ]);
  }
  for (const [from, to] of [
    [ids.a, ids.b],
    [ids.a, ids.c],
    [ids.c, ids.b],
  ] as const) {
    const rule = `${prefix}-r-${from}-${to}`;
    rules.push(rule);
    await env.DB.prepare(
      "INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(
        rule,
        signedIn.user.id,
        `${from}-cal`,
        `${to}-cal`,
        JSON.stringify({ detailLevel: "busy" }),
      )
      .run();
  }
  const start = Date.parse("2026-11-10T08:00:00.000Z");
  const run = { dryRun: false, create: 2, update: 0, delete: 0, failed: 0, durationMs: 40 };
  const statements = Array.from({ length: 150 }, (_, i) =>
    env.DB.prepare(
      `INSERT INTO audit_events (org_id, user_id, account_id, rule_id, kind, detail, created_at)
       VALUES ('default', ?, ?, ?, 'sync_run', ?, ?)`,
    ).bind(
      signedIn.user.id,
      ids.b,
      rules[i % rules.length],
      JSON.stringify(run),
      new Date(start + i * 60_000).toISOString(),
    ),
  );
  await env.DB.batch(statements);

  const paths = [
    "/",
    "/mirroring",
    `/mirroring?d=${ids.a}~${ids.b}`,
    "/mirroring?d=all",
    "/calendars",
    `/calendars?c=${ids.a}`,
    "/activity",
  ];
  pages = [];
  for (const path of paths) {
    const response = await exports.default.fetch(`${BASE}${path}`, {
      headers: { cookie, "accept-language": "en" },
      redirect: "manual",
    });
    if (response.status !== 200) throw new Error(`${path} answered ${response.status}`);
    const html = await response.text();
    pages.push({ path, html, gzip: await gzipSize(html) });
  }
  console.info(
    pages
      .map(
        (p) => `${p.path.replace(prefix, "P").padEnd(40)} ${p.html.length} B raw, ${p.gzip} B gzip`,
      )
      .join("\n"),
  );
});

const head = (html: string) => /<head>([\s\S]*?)<\/head>/.exec(html)?.[1] ?? "";

describe("HTML budget of the app pages", () => {
  it("stays within the size budget", () => {
    expect(pages.length).toBe(7);
    for (const { path, html, gzip } of pages) {
      expect(html.length, `${path} raw`).toBeLessThanOrEqual(BUDGET.raw);
      expect(gzip, `${path} gzip`).toBeLessThanOrEqual(BUDGET.gzip);
    }
  });

  it("blocks rendering with at most three resources in the head", () => {
    for (const { path, html } of pages) {
      const tags = head(html).match(/<(?:script|link)\b[^>]*>/gi) ?? [];
      const blocking = tags.filter((tag) => {
        if (/^<link/i.test(tag)) return /rel="stylesheet"/.test(tag);
        return /\ssrc=/.test(tag) && !/\s(?:defer|async)\b/.test(tag) && !/type="module"/.test(tag);
      });
      expect(blocking.length, `${path}: ${blocking.join(" ")}`).toBeLessThanOrEqual(
        BUDGET.renderBlocking,
      );
      // Control: the count sees the theme script and the stylesheets.
      expect(blocking.length, path).toBeGreaterThanOrEqual(3);
    }
  });

  it("has no inline script or style with content", () => {
    for (const { path, html } of pages) {
      const inline = [...html.matchAll(/<(script|style)\b([^>]*)>([\s\S]*?)<\/\1>/g)].filter(
        ([, tag, attrs, body]) =>
          tag === "style" || !/\ssrc=/.test(attrs ?? "") ? (body ?? "").trim() !== "" : false,
      );
      expect(
        inline.map((m) => m[0].slice(0, 80)),
        path,
      ).toEqual([]);
    }
  });

  it("has no duplicate id attributes", () => {
    for (const { path, html } of pages) {
      const ids = [...html.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1] ?? "");
      const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
      expect(duplicates, path).toEqual([]);
      // Control: the page has ids at all.
      expect(ids.length, path).toBeGreaterThan(0);
    }
  });
});
