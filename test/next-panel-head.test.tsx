import { Hono } from "hono";
import type { Child } from "hono/jsx";
import { describe, expect, it } from "vitest";
import { I18nProvider, i18nFor } from "../src/i18n";
import { Note, Panel } from "../src/pages/next/components";

/** The HTML that the redesign's panel parts render, in a language. */
async function render(node: Child, language: "en" | "de" = "en"): Promise<string> {
  const app = new Hono();
  app.get("/", (c) => c.html(<I18nProvider value={i18nFor(language)}>{node}</I18nProvider>));
  return (await app.request("/")).text();
}

describe("the panel head", () => {
  it("shows Saved as a plain note, because the shell's live region announces it once", async () => {
    const html = await render(
      <Panel title="Konto 1" closeHref="/calendars" saved>
        <p>body</p>
      </Panel>,
    );
    const note = /<span class="detail-saved"[^>]*>/.exec(html)?.[0] ?? "";
    expect(note).toContain("data-saved");
    expect(note).not.toMatch(/role=|aria-live/);
    expect(html).toContain("Saved");
  });

  it("links back to the panel it was opened from, after the title", async () => {
    const text = i18nFor("de").t.next.shell.panel;
    const html = await render(
      <Panel
        title="Konto 1"
        closeHref="/calendars"
        back={{ href: "/mirroring?d=a~b", label: text.backToMirroring }}
      >
        <p>body</p>
      </Panel>,
      "de",
    );
    const head = html.slice(
      html.indexOf('class="detail-head"'),
      html.indexOf('class="detail-form"'),
    );
    expect(head).toMatch(
      /<a class="btn btn-ghost detail-from" href="\/mirroring\?d=a~b" aria-label="Zurück zur Spiegelung">/,
    );
    expect(head.indexOf('id="detail-title"')).toBeLessThan(head.indexOf("detail-from"));
    expect(head).toContain(`<span class="detail-from-short">${text.backShort}</span>`);
  });

  it("has no such link without `back`", async () => {
    const html = await render(
      <Panel title="Konto 1" closeHref="/calendars">
        <p>body</p>
      </Panel>,
    );
    expect(html).not.toContain("detail-from");
  });
});

describe("a save bar note", () => {
  it("marks a destructive button label with the danger tone", async () => {
    expect(
      await render(
        <Note button="Turn off" danger>
          17 copies go.
        </Note>,
      ),
    ).toContain('data-button="Turn off" data-tone="danger"');
  });

  it("has no tone without a button or without `danger`", async () => {
    expect(await render(<Note danger>x</Note>)).not.toContain("data-tone");
    expect(await render(<Note button="Save">x</Note>)).not.toContain("data-tone");
  });
});
