/**
 * A changed private mark reaches the blocks that already exist. The sync engine compares the
 * privacy of a block through its content hash and dedup key, and a write sends the provider field
 * on a create and on an update. These tests pin that chain, from the rule to the provider body.
 */
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountSync } from "../src/account-sync";
import { ruleOptionsSchema } from "../src/config";
import { setSettings } from "../src/editor";
import { GraphCalendar, toGraphBlock } from "../src/providers/graph-calendar";
import { desiredBlocks } from "../src/sync/plan";
import type { DesiredBlock } from "../src/sync/types";
import { EMPTY_FAKE_SEED, noFakeNetwork, signIn, stopClock } from "./helpers";

const DAY = 86_400_000;

type Stub = DurableObjectStub<AccountSync>;

function block(isPrivate: boolean): DesiredBlock {
  return {
    marker: "m".repeat(32),
    contentHash: "h".repeat(32),
    dedupKey: "d".repeat(32),
    start: "2026-11-02T09:00:00.000Z",
    end: "2026-11-02T10:00:00.000Z",
    allDay: false,
    showAs: "busy",
    isPrivate,
    subject: "Busy",
    location: "",
    body: "",
  };
}

describe("Graph body of a block", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("carries the sensitivity of the rule's mark", async () => {
    for (const [markPrivate, sensitivity] of [
      [true, "private"],
      [false, "normal"],
    ] as const) {
      const [desired] = await desiredBlocks(
        "rule",
        [
          {
            occurrenceKey: "single:one",
            start: "2026-11-02T09:00:00.000Z",
            end: "2026-11-02T10:00:00.000Z",
            allDay: false,
            showAs: "busy",
            isPrivate: false,
            isMirror: false,
            declined: false,
            subject: "Talk",
            location: "",
            body: "",
            categories: [],
          },
        ],
        ruleOptionsSchema.parse({ markPrivate }),
      );
      expect(desired?.isPrivate).toBe(markPrivate);
      expect(toGraphBlock(desired!, "tag123456789")).toHaveProperty("sensitivity", sensitivity);
    }
  });

  it("sends the sensitivity in the PATCH and POST requests of a $batch", async () => {
    let sent: { requests: { method: string; url: string; body?: { sensitivity?: string } }[] } = {
      requests: [],
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.endsWith("/$batch")) return new Response("unexpected", { status: 500 });
      sent = JSON.parse(init?.body as string) as typeof sent;
      return Response.json({
        responses: sent.requests.map((_request, index) => ({
          id: String(index),
          status: 200,
          body: { id: `new-${index}` },
        })),
      });
    });
    await new GraphCalendar("token").applyBatch("cal", "tag123456789", [
      { kind: "update", targetId: "evt-open", block: block(false) },
      { kind: "update", targetId: "evt-private", block: block(true) },
      { kind: "create", block: block(false) },
      { kind: "create", block: block(true) },
    ]);
    expect(
      sent.requests.map((request) => ({
        method: request.method,
        sensitivity: request.body?.sensitivity,
      })),
    ).toEqual([
      { method: "PATCH", sensitivity: "normal" },
      { method: "PATCH", sensitivity: "private" },
      { method: "POST", sensitivity: "normal" },
      { method: "POST", sensitivity: "private" },
    ]);
  });
});

describe("a changed mark reaches the existing blocks", () => {
  const stubs = new Set<Stub>();

  beforeEach(() => {
    stopClock();
    noFakeNetwork();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await Promise.all(
      [...stubs].map((stub) =>
        runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm()),
      ),
    );
    stubs.clear();
  });

  function at(days: number, hour: number): string {
    return new Date(
      Math.floor(Date.now() / DAY) * DAY + days * DAY + hour * 3_600_000,
    ).toISOString();
  }

  /** Two simulated accounts, a rule between them with the given mark, and four meetings. */
  async function setup(name: string, markPrivate: boolean) {
    // A user per test: a settings save applies to every rule of its user.
    const { user } = await signIn(`${name}@org.example`);
    const sourceId = `${name}-a`;
    const targetId = `${name}-b`;
    await env.DB.batch(
      [sourceId, targetId].flatMap((id) => [
        env.DB.prepare(
          "INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, 'microsoft', ?)",
        ).bind(id, user.id, `${id}@example.com`),
        env.DB.prepare(
          "INSERT INTO calendars (id, account_id, remote_id, name) VALUES (?, ?, 'main', 'Cal')",
        ).bind(`${id}-main`, id),
      ]),
    );
    const ruleId = `${name}-rule`;
    await env.DB.prepare(
      `INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(
        ruleId,
        user.id,
        `${sourceId}-main`,
        `${targetId}-main`,
        JSON.stringify({ daysAhead: 30, detailLevel: "title", markPrivate }),
      )
      .run();
    const source = env.ACCOUNT_SYNC.getByName(sourceId);
    const target = env.ACCOUNT_SYNC.getByName(targetId);
    stubs.add(source).add(target);
    for (const [id, stub] of [
      [sourceId, source],
      [targetId, target],
    ] as const) {
      await stub.storeTokens(id, {
        refreshToken: "fake",
        accessToken: "fake",
        accessExpiresAt: Date.now() + 365 * DAY,
      });
      await stub.seedFake(EMPTY_FAKE_SEED, 0);
    }
    for (const day of [2, 3, 4]) {
      await source.addFakeEvent({ id: `meeting-${day}`, start: at(day, 10), end: at(day, 11) });
    }
    // The source marks this one private: its block stays private at either mark.
    await source.addFakeEvent({ id: "secret", start: at(5, 10), end: at(5, 11), isPrivate: true });
    await target.runRule(ruleId);
    return { user, source, target, ruleId };
  }

  /** The privacy of every block in the simulated target, by start. */
  function privacy(target: Stub): Promise<number[]> {
    return runInDurableObject(target, (_instance, state) =>
      state.storage.sql
        .exec<{ is_private: number }>(`SELECT is_private FROM fake_blocks ORDER BY start`)
        .toArray()
        .map((row) => row.is_private),
    );
  }

  async function setMark(ruleId: string, markPrivate: boolean): Promise<void> {
    await env.DB.prepare(
      "UPDATE rules SET options = json_set(options, '$.markPrivate', json(?)) WHERE id = ?",
    )
      .bind(markPrivate ? "true" : "false", ruleId)
      .run();
  }

  async function alarms(stub: Stub): Promise<number> {
    let count = 0;
    while (await runDurableObjectAlarm(stub)) count++;
    return count;
  }

  for (const [before, after] of [
    [true, false],
    [false, true],
  ] as const) {
    it(`rewrites every block from ${before ? "private" : "open"} to ${after ? "private" : "open"}`, async () => {
      const { target, ruleId } = await setup(`vis-${before ? "po" : "op"}`, before);
      const mark = (value: boolean) => (value ? 1 : 0);
      expect(await privacy(target)).toEqual([mark(before), mark(before), mark(before), 1]);
      await setMark(ruleId, after);
      await target.requestSync();
      expect(await alarms(target)).toBeGreaterThan(0);
      expect(await privacy(target)).toEqual([mark(after), mark(after), mark(after), 1]);
    });

    it(`rewrites every block to ${after ? "private" : "open"} after a settings save that applies it`, async () => {
      const { user, target } = await setup(`visall-${before ? "po" : "op"}`, before);
      const mark = (value: boolean) => (value ? 1 : 0);
      expect(await privacy(target)).toEqual([mark(before), mark(before), mark(before), 1]);
      // Without a set of syncs, the save asks the target account itself.
      await setSettings(env, user, {
        daysAhead: 30,
        daysAheadShown: 30,
        skipAllDayShown: false,
        skipAllDay: false,
        skipTentative: false,
        markPrivate: !after,
        blockTitle: "Busy",
        skipCategories: [],
        newWho: after ? "private" : "open",
        applyWho: true,
      });
      expect(await alarms(target)).toBeGreaterThan(0);
      expect(await privacy(target)).toEqual([mark(after), mark(after), mark(after), 1]);
    });
  }
});
