import { describe, expect, it } from "vitest";
import type { ActivityRow } from "../src/audit";
import type { EditorState } from "../src/editor";
import { i18nFor } from "../src/i18n";
import {
  changeEntries,
  clockFor,
  describeActivity,
  describeChanges,
  exposuresOf,
  levelStep,
} from "../src/pages/next/describe";

/** Calendars a, b, c; the mirroring a to b has the rules r1 and r2, a to c has r3. */
function fakeState(): EditorState {
  const account = (id: string) => ({
    id,
    name: id,
    email: `${id}@x.example`,
    needsReconnect: false,
    color: "blue",
  });
  const rule = (id: string) => ({ id, enabled: true, options: {}, optionsJson: "{}" });
  return {
    accounts: ["a", "b", "c"].map(account),
    directions: [],
    rules: [
      { from: "a", to: "b", rule: rule("r1") },
      { from: "a", to: "b", rule: rule("r2") },
      { from: "a", to: "c", rule: rule("r3") },
    ],
  } as unknown as EditorState;
}

let id = 0;
function row(
  kind: ActivityRow["kind"],
  detail: object,
  ruleId: string | null,
  at: string,
  accountEmail: string | null = "b@x.example",
): ActivityRow {
  return {
    id: ++id,
    kind,
    detail: JSON.stringify(detail),
    createdAt: at,
    email: null,
    accountEmail,
    ruleId,
  };
}

/** A level change as `setDirections` records it since the field `previous*` exists. */
function changed(from: string, to: string) {
  const [choice, mark] = to.split("-");
  const [previousChoice, previousMark] = from.split("-");
  return {
    choice,
    ...(mark ? { markPrivate: mark === "private" } : {}),
    previousChoice,
    ...(previousMark ? { previousMarkPrivate: previousMark === "private" } : {}),
  };
}

const en = i18nFor("en").t;
const de = i18nFor("de").t;
const clock = clockFor(i18nFor("en", "UTC"));

/** The change entries as the Overview builds them on the day of the rows (2026-11-17). */
const entriesAt = (
  rows: ActivityRow[],
  state: EditorState,
  t: typeof en,
  at: typeof clock = clock,
) => changeEntries(rows, state, t, at, Date.parse("2026-11-17T12:00:00.000Z"));
// The level words come from the shell catalog; the tests never copy them.
const level = en.next.shell.levels.summary;

describe("level steps", () => {
  it("reads the level before and after from a rule_updated row", () => {
    expect(
      levelStep(row("rule_updated", changed("busy-private", "title-private"), "r1", "x")),
    ).toEqual({
      before: { choice: "busy", markPrivate: true },
      after: { choice: "title", markPrivate: true },
    });
  });

  it("keeps the mark of a copied rule for a choice without a mark", () => {
    const step = levelStep(
      row(
        "rule_updated",
        { choice: "full", previousChoice: "busy", previousMarkPrivate: false },
        "r1",
        "x",
      ),
    );
    expect(step?.after).toEqual({ choice: "full", markPrivate: false });
  });

  it("has no level before in a row written before the field existed", () => {
    expect(levelStep(row("rule_updated", { choice: "title" }, "r1", "x"))).toEqual({
      after: { choice: "title" },
    });
  });

  it("starts a new rule from off, and a detail change has no step", () => {
    expect(levelStep(row("rule_created", { choice: "busy" }, "r1", "x"))?.before).toEqual({
      choice: "off",
    });
    expect(levelStep(row("rule_updated", { blockColor: "changed" }, "r1", "x"))).toBeNull();
  });
});

describe("change entries", () => {
  it("gives one entry per mirroring with its level changes, details and run counts", () => {
    const entries = entriesAt(
      [
        row(
          "sync_run",
          { create: 1, update: 0, delete: 0, failed: 2 },
          "r1",
          "2026-11-17T11:00:00Z",
        ),
        row("rule_updated", changed("title-private", "full-private"), "r2", "2026-11-17T10:40:00Z"),
        row("rule_updated", changed("title-private", "full-private"), "r1", "2026-11-17T10:40:00Z"),
        row("rule_updated", { blockColor: "changed" }, "r1", "2026-11-17T10:35:00Z"),
        row("rule_updated", changed("busy-private", "title-private"), "r1", "2026-11-17T10:30:00Z"),
        row("sync_run", { create: 2, update: 3, delete: 1 }, "r2", "2026-11-17T10:00:00Z"),
      ],
      fakeState(),
      en,
    );
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry?.key).toBe("m:a~b");
    expect(entry?.at).toBe("2026-11-17T11:00:00Z");
    expect(entry?.route?.from.id).toBe("a");
    expect(entry?.route?.to.id).toBe("b");
    // Two saves; the two rows of the second save are one change.
    expect(entry?.levelChanges).toBe(2);
    expect(entry?.latestLevel).toEqual({
      choice: "full",
      markPrivate: true,
      label: level["full-private"],
    });
    expect(entry?.details).toEqual([en.next.describe.changes.colour]);
    expect(entry?.sync).toEqual({ created: 3, updated: 3, removed: 1, failed: 2 });
    expect(entry?.text).toBe(
      `${en.next.describe.changes.levelChanged(2, level["full-private"])} · ${en.next.describe.changes.colour}`,
    );
  });

  it("drops level changes that cancel out, and the entry if nothing else is left", () => {
    // Others saw no more at any time: the copies stayed private events.
    const rows = [
      row("rule_updated", changed("full-private", "title-private"), "r1", "2026-11-17T10:50:00Z"),
      row("rule_updated", changed("title-private", "full-private"), "r1", "2026-11-17T10:40:00Z"),
    ];
    expect(entriesAt(rows, fakeState(), en)).toEqual([]);
    const withRun = entriesAt(
      [row("sync_run", { create: 4 }, "r1", "2026-11-17T11:00:00Z"), ...rows],
      fakeState(),
      en,
    );
    expect(withRun).toHaveLength(1);
    expect(withRun[0]?.levelChanges).toBe(0);
    expect(withRun[0]?.latestLevel).toBeUndefined();
    expect(withRun[0]?.text).toBeUndefined();
  });

  it("never cancels out a time in which others saw titles, and says when", () => {
    const rows = [
      row("rule_updated", changed("title-open", "busy-private"), "r1", "2026-11-17T10:50:00Z"),
      row("rule_updated", changed("busy-private", "title-open"), "r1", "2026-11-17T10:40:00Z"),
    ];
    const [entry] = entriesAt(rows, fakeState(), en, clock);
    const text = en.next.describe.changes;
    const titles = text.exposure.range(text.exposure.what["title-open"], "10:40", "10:50");
    expect(entry?.exposures).toEqual([titles]);
    expect(entry?.levelChanges).toBe(2);
    expect(entry?.text).toBe(`${titles} · ${text.levelChanged(2, level["busy-private"])}`);
    expect(entry?.text).toBe(
      "Titles visible to others 10:40–10:50 · Changed 2× · now: Busy only, private",
    );
    const [german] = entriesAt(rows, fakeState(), de, clock);
    expect(german?.text).toMatch(/^Titel für andere sichtbar 10:40–10:50 · /);
  });

  it("names a time in which others still see more as open", () => {
    const [entry] = entriesAt(
      [row("rule_updated", changed("busy-private", "full-open"), "r1", "2026-11-17T10:40:00Z")],
      fakeState(),
      en,
      clock,
    );
    expect(entry?.exposures).toEqual(["Details visible to others from 10:40"]);
  });

  it("names a mirroring turned off by a save that deleted its rule", () => {
    const off = row(
      "rule_deleted",
      {
        cleanup: "queued",
        choice: "off",
        fromAccount: "a",
        previousChoice: "busy",
        previousMarkPrivate: true,
      },
      "gone",
      "2026-11-17T10:40:00Z",
    );
    const [entry] = entriesAt([off], fakeState(), en, clock);
    expect(entry?.key).toBe("m:a~b");
    expect(entry?.text).toBe(en.next.describe.changes.levelChanged(1, level.off));
  });

  it("never cancels out a change whose mark is not known", () => {
    const entries = entriesAt(
      [
        // "busy" to "title" and back, but neither row names a mark: what others saw may differ.
        row("rule_updated", { choice: "busy" }, "r1", "2026-11-17T10:50:00Z"),
        row(
          "rule_updated",
          { choice: "title", previousChoice: "busy" },
          "r1",
          "2026-11-17T10:40:00Z",
        ),
      ],
      fakeState(),
      en,
    );
    expect(entries[0]?.levelChanges).toBe(2);
    expect(entries[0]?.latestLevel?.label).toBe(en.next.describe.changes.choices.busy);
  });

  it("keeps the changes of old rows without the level before", () => {
    const entries = entriesAt(
      [row("rule_updated", { choice: "title", markPrivate: true }, "r3", "2026-11-17T10:40:00Z")],
      fakeState(),
      en,
    );
    expect(entries[0]).toMatchObject({
      key: "m:a~c",
      levelChanges: 1,
      latestLevel: { label: level["title-private"] },
      text: en.next.describe.changes.levelChanged(1, level["title-private"]),
    });
  });

  it("drops a pause that was turned on again", () => {
    const entries = entriesAt(
      [
        row("rule_enabled", {}, "r1", "2026-11-17T10:50:00Z"),
        row("rule_paused", {}, "r1", "2026-11-17T10:40:00Z"),
        row("rule_paused", {}, "r3", "2026-11-17T10:30:00Z"),
      ],
      fakeState(),
      en,
    );
    expect(entries.map((entry) => [entry.key, entry.details])).toEqual([
      ["m:a~c", [en.next.describe.changes.paused]],
    ]);
  });

  it("joins events of a calendar that read the same, with a count", () => {
    const entries = entriesAt(
      [
        row("account_connected", {}, null, "2026-11-17T10:50:00Z"),
        row("account_connected", {}, null, "2026-11-17T10:40:00Z"),
      ],
      fakeState(),
      en,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ count: 2, levelChanges: 0, details: [] });
    expect(entries[0]?.subject).toMatchObject({ account: { id: "b" } });
  });

  it("speaks German", () => {
    const entries = entriesAt(
      [
        row("rule_updated", changed("busy-private", "busy-open"), "r1", "2026-11-17T10:50:00Z"),
        row("rule_updated", changed("title-private", "busy-private"), "r1", "2026-11-17T10:40:00Z"),
      ],
      fakeState(),
      de,
      clock,
    );
    // A private event that shows as it is, here "Busy" or the user's own title, is seen by others.
    expect(entries[0]?.text).toBe(
      `Kopien für andere sichtbar ab 10:50 · ${de.next.describe.changes.levelChanged(2, de.next.shell.levels.summary["busy-open"])}`,
    );
    expect(entries[0]?.text).toContain("2×");
  });
});

describe("changes of a mirroring on the activity page", () => {
  it("shows the delta from the oldest level to the newest", () => {
    const text = describeChanges(
      [
        row("rule_updated", changed("title-private", "full-private"), "r1", "2026-11-17T10:50:00Z"),
        row("rule_updated", changed("busy-private", "title-private"), "r1", "2026-11-17T10:40:00Z"),
      ],
      en,
    );
    expect(text).toBe(`${level["busy-private"]} → ${level["full-private"]}`);
  });

  it("says that changes cancelled out if others never saw more", () => {
    const text = describeChanges(
      [
        row("rule_updated", changed("full-private", "busy-private"), "r1", "2026-11-17T10:50:00Z"),
        row("rule_updated", changed("busy-private", "full-private"), "r1", "2026-11-17T10:40:00Z"),
      ],
      en,
      clock,
    );
    expect(text).toBe(en.next.describe.changes.levelBack(level["busy-private"], 2));
  });

  it("never cancels out a time in which others saw titles", () => {
    const text = describeChanges(
      [
        row("rule_updated", changed("title-open", "busy-private"), "r1", "2026-11-17T10:50:00Z"),
        row("rule_updated", changed("busy-private", "title-open"), "r2", "2026-11-17T10:40:00Z"),
        row("rule_updated", changed("busy-private", "title-open"), "r1", "2026-11-17T10:40:00Z"),
      ],
      en,
      clock,
    );
    // r2 still shows titles: its time has no end in these rows.
    expect(text).toBe(
      `Titles visible to others 10:40–10:50 · Titles visible to others from 10:40 · ${en.next.describe.changes.now(level["busy-private"])}`,
    );
    const german = describeChanges(
      [
        row("rule_updated", changed("title-open", "busy-private"), "r1", "2026-11-17T10:50:00Z"),
        row("rule_updated", changed("busy-private", "title-open"), "r1", "2026-11-17T10:40:00Z"),
      ],
      de,
      clock,
    );
    expect(german).toBe(
      `Titel für andere sichtbar 10:40–10:50 · ${de.next.describe.changes.now(de.next.shell.levels.summary["busy-private"])}`,
    );
  });

  it("names the level of an old row, and the details of a detail change", () => {
    expect(
      describeChanges(
        [
          row(
            "rule_updated",
            { choice: "title", markPrivate: false },
            "r1",
            "2026-11-17T10:40:00Z",
          ),
        ],
        en,
        clock,
      ),
    ).toBe(
      `Titles visible to others from 10:40 · ${en.next.describe.changes.now(level["title-open"])}`,
    );
    expect(
      describeChanges(
        [row("rule_updated", { choice: "title", markPrivate: true }, "r1", "x")],
        en,
        clock,
      ),
    ).toBe(en.next.describe.changes.now(level["title-private"]));
    expect(
      describeChanges(
        [row("rule_updated", { workDays: "1,2", bufferBefore: "5", bufferAfter: "0" }, "r1", "x")],
        en,
      ),
    ).toBe(`${en.next.describe.changes.hours} · ${en.next.describe.changes.buffer("5", "0")}`);
  });

  it("titles a change with the mirroring and puts the delta in the detail", () => {
    const line = describeActivity(
      row("rule_updated", changed("busy-private", "title-private"), "r1", "x"),
      fakeState(),
      en,
    );
    expect(line.title).toBe(en.next.describe.activity.routeChanged("a", "b"));
    expect(line.detail).toBe(`${level["busy-private"]} → ${level["title-private"]}`);
  });
});

describe("times in which others saw more", () => {
  const steps = (...list: [string, string, string, string?][]) =>
    list.map(([from, to, at, ruleId = "r1"]) => ({
      ruleId,
      at,
      step: levelStep(row("rule_updated", changed(from, to), ruleId, at))!,
    }));

  it("counts a private event that becomes visible as it is, also at Busy only", () => {
    expect(exposuresOf(steps(["busy-private", "busy-open", "10:00"]))).toEqual([
      { level: "busy-open", from: "10:00" },
    ]);
    expect(exposuresOf(steps(["off", "title-open", "10:00"]))).toEqual([
      { level: "title-open", from: "10:00" },
    ]);
  });

  it("counts nothing when only the owner sees more, or when the copies stay private", () => {
    expect(exposuresOf(steps(["busy-private", "full-private", "10:00"]))).toEqual([]);
    expect(exposuresOf(steps(["off", "busy-private", "10:00"]))).toEqual([]);
    // A detail save at a level that was open before widens nothing.
    expect(exposuresOf(steps(["title-open", "title-open", "10:00"]))).toEqual([]);
  });

  it("ends a higher time at a step down, and the lower level keeps its start", () => {
    expect(
      exposuresOf(
        steps(
          ["busy-private", "full-open", "10:00"],
          ["full-open", "title-open", "10:05"],
          ["title-open", "busy-private", "10:10"],
        ),
      ),
    ).toEqual([
      { level: "full-open", from: "10:00", until: "10:05" },
      { level: "title-open", from: "10:00", until: "10:10" },
    ]);
  });

  it("keeps a lower time open while a higher one ends", () => {
    expect(
      exposuresOf(
        steps(
          ["busy-private", "title-open", "10:00"],
          ["title-open", "full-open", "10:05"],
          ["full-open", "title-open", "10:10"],
        ),
      ),
    ).toEqual([
      { level: "title-open", from: "10:00" },
      { level: "full-open", from: "10:05", until: "10:10" },
    ]);
  });

  it("ends a time at a change of unknown mark only if even an open copy shows less, and counts that level as open", () => {
    const unknown = (choice: string, at: string) => ({
      ruleId: "r1",
      at,
      step: levelStep(row("rule_updated", { choice, previousChoice: "title" }, "r1", at))!,
    });
    const start = steps(["busy-private", "title-open", "10:00"]);
    expect(exposuresOf([...start, unknown("title", "10:05")])).toEqual([
      { level: "title-open", from: "10:00" },
    ]);
    // The level after has no known mark: it counts as open, so an unknown never hides a widening.
    expect(exposuresOf([...start, unknown("busy", "10:05")])).toEqual([
      { level: "title-open", from: "10:00", until: "10:05" },
      { level: "busy-open", from: "10:05" },
    ]);
  });
});

describe("activity sentences", () => {
  const run = (detail: object, ruleId: string | null = "r1") =>
    row("sync_run", detail, ruleId, "2026-11-17T10:00:00.000Z");

  it("names both calendars and leaves out parts that are zero", () => {
    const line = describeActivity(
      run({ dryRun: false, create: 3, update: 0, delete: 23, failed: 0 }),
      fakeState(),
      en,
    );
    expect(line.title).toBe("a to b");
    expect(line.detail).toBe("3 new, 23 removed");
  });

  it("says that a run had no changes and marks it quiet", () => {
    const line = describeActivity(
      run({ dryRun: false, create: 0, update: 0, delete: 0, failed: 0 }),
      fakeState(),
      en,
    );
    expect(line.detail).toBe("No changes");
    expect(line.quiet).toBe(true);
  });

  it("falls back to the target name if the rule is gone", () => {
    const line = describeActivity(run({ dryRun: false, create: 1 }, "gone"), fakeState(), en);
    expect(line.title).toBe("Run for b");
    expect(line.account?.id).toBe("b");
  });

  it("names the renamed calendar by its current name", () => {
    const renamed = row("account_renamed", {}, null, "x", "c@x.example");
    expect(describeActivity(renamed, fakeState(), en).title).toBe("c was renamed");
    expect(describeActivity(renamed, fakeState(), de).title).toBe("c wurde umbenannt");
    expect(describeActivity(renamed, fakeState(), en).account?.id).toBe("c");
  });

  it("explains a run that ended without a result and links its mirroring", () => {
    const line = describeActivity(
      row("sync_run_aborted", { runId: "x", startedAt: "y" }, "r1", "x"),
      fakeState(),
      en,
    );
    expect(line.title).toBe("a to b stopped early");
    expect(line.explain).toBe(en.next.describe.activity.detail.abortedExplain);
    expect(line.href).toBe("/mirroring?d=a~b");
    // Without its rule the row explains, but links nowhere.
    const gone = describeActivity(row("sync_run_aborted", {}, "gone", "x"), fakeState(), de);
    expect(gone.explain).toBe(de.next.describe.activity.detail.abortedExplain);
    expect(gone.href).toBeUndefined();
  });

  it("titles a save that turned a mirroring off, also after its rule was deleted", () => {
    const detail = {
      cleanup: "queued",
      choice: "off",
      fromAccount: "a",
      previousChoice: "title",
      previousMarkPrivate: false,
    };
    const line = describeActivity(row("rule_deleted", detail, "gone", "x"), fakeState(), en);
    expect(line.title).toBe("a to b turned off");
    expect(line.detail).toBe(`${level["title-open"]} → ${level.off}`);
    expect(line.route?.from.id).toBe("a");
    expect(describeActivity(row("rule_deleted", detail, "gone", "x"), fakeState(), de).title).toBe(
      "a nach b ausgeschaltet",
    );
    // A row from before the field names no mirroring.
    const old = describeActivity(
      row("rule_deleted", { cleanup: "queued" }, "gone", "x"),
      fakeState(),
      en,
    );
    expect(old.title).toBe(en.next.describe.activity.kinds.rule_deleted());
    expect(old.route).toBeUndefined();
  });

  it("leaves out the name of the mirroring that the list is filtered to", () => {
    const run = row("sync_run", { create: 2 }, "r1", "x");
    expect(describeActivity(run, fakeState(), en, { mirroring: "a~b" }).title).toBe(
      en.next.describe.activity.kinds.sync_run(null),
    );
    expect(describeActivity(run, fakeState(), en, { mirroring: "a~c" }).title).toBe("a to b");
    const change = row("rule_updated", changed("busy-private", "title-private"), "r1", "x");
    const filtered = describeActivity(change, fakeState(), en, { mirroring: "a~b" });
    expect(filtered.title).toBe(en.next.describe.activity.kinds.rule_updated());
    expect(filtered.detail).toBe(`${level["busy-private"]} → ${level["title-private"]}`);
    const paused = describeActivity(row("rule_paused", {}, "r1", "x"), fakeState(), en, {
      mirroring: "a~b",
    });
    expect(paused.detail).toBe("");
  });

  it("never shows a title, a description or a place from a row", () => {
    const line = describeActivity(
      row(
        "rule_updated",
        { ...changed("busy-private", "title-private"), title: "Secret", location: "Vault" },
        "r1",
        "x",
      ),
      fakeState(),
      en,
    );
    expect(JSON.stringify(line)).not.toMatch(/Secret|Vault/);
  });
});

describe("the note under a cut changes list", () => {
  it("says what the list covers, not how it was read", () => {
    for (const t of [en, de]) {
      const note = t.next.describe.changes.cut("17.11.2026, 23:06");
      expect(note).toContain("17.11.2026, 23:06");
      expect(note).not.toMatch(/\b(read|entries)\b|gelesen|Einträge/);
    }
  });
});
