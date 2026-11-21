import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { ASSET_DIR } from "../scripts/asset-manifest-lib.mjs";

/**
 * The matcher of the command palette (`public/next/palette.js`), run in a fake browser without
 * markup. Browser behaviour: `test/browser/palette.sh`.
 */

interface Entry {
  l: string;
  t: string;
  k: string;
}
interface Palette {
  score(entry: Entry, query: string): number;
  entry(label: string, keywords?: string): Entry;
  singleKeys(): boolean;
}

/** `storage`: a localStorage, or "blocked" for one that throws on every call. */
function load(storage: "blocked" | Map<string, string> = new Map()): {
  palette: Palette;
  fire: (type: string, target: object) => void;
} {
  const handlers: { type: string; fn: (event: object) => void }[] = [];
  const document = {
    readyState: "complete",
    addEventListener: (type: string, fn: (event: object) => void) => handlers.push({ type, fn }),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const blocked = () => {
    throw new Error("SecurityError");
  };
  const localStorage =
    storage === "blocked"
      ? { getItem: blocked, setItem: blocked }
      : {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => storage.set(key, value),
        };
  const window: { slotmirrorScripts?: { palette?: Palette } } = {};
  runInNewContext(readFileSync(join(ASSET_DIR, "palette.js"), "utf8"), {
    window,
    document,
    localStorage,
  });
  const palette = window.slotmirrorScripts?.palette;
  if (!palette) throw new Error("palette.js did not register");
  const fire = (type: string, target: object) => {
    for (const h of handlers.filter((x) => x.type === type)) h.fn({ type, target });
  };
  return { palette, fire };
}

const palette = load().palette;
const score = (label: string, query: string, keywords = "") =>
  palette.score(palette.entry(label, keywords), query);
/** The labels that match, best first, as the palette shows them within a group. */
const rank = (labels: string[], query: string, keywords: Record<string, string> = {}) =>
  labels
    .map((label) => ({ label, s: score(label, query, keywords[label]) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.label.length - b.label.length)
    .map((x) => x.label);

describe("palette matcher", () => {
  it("ignores case and diacritics and folds ß to ss", () => {
    expect(score("Übersicht", "uber")).toBeGreaterThan(0);
    expect(score("Übersicht", "ÜBER")).toBeGreaterThan(0);
    expect(score("Schließen", "schliessen")).toBeGreaterThan(0);
    expect(score("Straße", "strasse")).toBeGreaterThan(0);
  });

  it("also finds umlauts written out", () => {
    expect(score("Übersicht", "uebersicht")).toBeGreaterThan(0);
    expect(score("Für alle Spiegelungen", "fuer alle")).toBeGreaterThan(0);
    expect(score("Darstellung: Hell", "hell")).toBeGreaterThan(0);
  });

  it("needs every token to match", () => {
    expect(score("Konto 1 to Konto 2", "konto 2")).toBeGreaterThan(0);
    expect(score("Konto 1 to Konto 2", "konto 4")).toBe(0);
    expect(score("Calendars", "")).toBe(0);
  });

  it("ranks a label start over a word start over a substring", () => {
    expect(rank(["Show problems", "Problems", "Noproblems"], "problems")).toEqual([
      "Problems",
      "Show problems",
      "Noproblems",
    ]);
  });

  it("ranks the mirroring whose names come in the typed order first", () => {
    const mirrorings = [
      "Konto 1 to Konto 2",
      "Konto 1 to Konto 3",
      "Konto 2 to Konto 1",
      "Konto 2 to Konto 3",
      "Konto 3 to Konto 1",
      "Konto 3 to Konto 2",
    ];
    expect(rank(mirrorings, "konto 2 konto 1")[0]).toBe("Konto 2 to Konto 1");
    expect(rank(mirrorings, "konto 3 konto 2")[0]).toBe("Konto 3 to Konto 2");
    expect(rank(["Konto 1 nach Konto 2", "Konto 2 nach Konto 1"], "konto 2 konto 1")[0]).toBe(
      "Konto 2 nach Konto 1",
    );
  });

  it("finds German and English keywords", () => {
    const de = { "Darstellung: Dunkel": "darstellung hell dunkel system theme dark light" };
    expect(rank(["Darstellung: Dunkel", "Kalender neu laden"], "dark", de)).toEqual([
      "Darstellung: Dunkel",
    ]);
    expect(rank(["Darstellung: Dunkel"], "theme", de)).toEqual(["Darstellung: Dunkel"]);
    const en = { Mirroring: "mirroring rules copy" };
    expect(score("Spiegelung", "mirroring", "spiegelung kopie mirroring")).toBeGreaterThan(0);
    expect(rank(["Mirroring", "Activity"], "copy", en)).toEqual(["Mirroring"]);
    // A keyword hit counts less than a hit in the label.
    expect(score("Copy", "copy")).toBeGreaterThan(score("Mirroring", "copy", en.Mirroring));
  });

  it("puts the label that is the query first, then a label that starts with it", () => {
    // "konto 2": the calendar "Konto 2" (390) before "Konto 2 to Konto 1" (290) before
    // "Konto 3 to Konto 2" (the query starts a word: 250).
    expect(score("Konto 2", "konto 2")).toBe(390);
    expect(score("Konto 2 to Konto 1", "konto 2")).toBe(290);
    expect(score("Konto 3 to Konto 2", "konto 2")).toBe(250);
    expect(rank(["Konto 3 to Konto 2", "Konto 2 to Konto 1", "Konto 2"], "konto 2")).toEqual([
      "Konto 2",
      "Konto 2 to Konto 1",
      "Konto 3 to Konto 2",
    ]);
    // Extra spaces and case do not lose the bonus.
    expect(score("Konto 2", "  KONTO   2 ")).toBe(390);
  });

  it("gives a typo no bonus: the group order decides between equal scores", () => {
    expect(score("Kalender", "kalnder")).toBe(score("Kalender neu laden", "kalnder"));
  });

  it("ranks the theme the query names first, in both languages", () => {
    const de = {
      "Darstellung: System": "darstellung system automatisch auto theme appearance automatic",
      "Darstellung: Hell": "darstellung hell theme appearance light",
      "Darstellung: Dunkel": "darstellung dunkel theme appearance dark",
    };
    const labels = Object.keys(de);
    expect(rank(labels, "dark", de)[0]).toBe("Darstellung: Dunkel");
    expect(rank(labels, "light", de)[0]).toBe("Darstellung: Hell");
    expect(rank(labels, "dark", de)).toHaveLength(1);
  });

  it("matches letters in order with small gaps", () => {
    expect(score("Calendars", "clnd")).toBeGreaterThan(0);
    expect(score("Calendars", "cs")).toBe(0);
  });
});

describe("palette single-key switch", () => {
  const box = (checked: boolean) => ({ checked, matches: () => true });
  it("keeps the choice in memory when storage is blocked", () => {
    const { palette, fire } = load("blocked");
    expect(palette.singleKeys()).toBe(true);
    fire("change", box(false));
    expect(palette.singleKeys(), "the switch is off for this page").toBe(false);
    fire("change", box(true));
    expect(palette.singleKeys()).toBe(true);
  });
  it("stores the choice when storage works", () => {
    const stored = new Map<string, string>();
    const { palette, fire } = load(stored);
    fire("change", box(false));
    expect(stored.get("slotmirror-single-keys")).toBe("off");
    expect(palette.singleKeys()).toBe(false);
  });
});
