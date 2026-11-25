import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { refreshUserCalendars } from "../src/calendars";
import { accountSync } from "../src/durable";
import { setSettings } from "../src/editor";
import { settingsFrom } from "../src/form";
import { startOrgCompares } from "../src/next-admin";
import { removeAccounts } from "../src/offboarding";
import { workersTracer } from "../src/runtime/workers/telemetry";
import {
  carrier,
  log,
  requestId,
  resumeRequest,
  span,
  startRequest,
  traceId,
} from "../src/telemetry";
import { addAccount } from "./helpers";
import { captureLogs } from "./telemetry";

let capture: ReturnType<typeof captureLogs> | undefined;

function capturing() {
  capture = captureLogs();
  return capture;
}

afterEach(() => {
  capture?.restore();
  capture = undefined;
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe("the logger", () => {
  it("adds the request context and leaves out undefined fields", async () => {
    const { records } = capturing();
    await startRequest(
      "http",
      async () => {
        await tick();
        log.with({ ruleId: "rule-1" }).info("test.done", { count: 2, skipped: undefined });
      },
      { userId: "user-1" },
    );
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record?.level).toBe("info");
    expect(record?.event).toBe("test.done");
    expect(record?.fields).toMatchObject({ userId: "user-1", ruleId: "rule-1", count: 2 });
    expect(record?.fields.requestId).toMatch(/^[0-9a-f]{16}$/);
    expect(record?.fields.trigger).toBe("http");
    expect("skipped" in (record?.fields ?? {})).toBe(false);
  });

  it("keeps only the safe parts of an error", () => {
    const { records } = capturing();
    const error = new Error("invalid_grant for alice@corp.example");
    log.error("test.failed", { accountId: "a-1" }, error);
    const logged = JSON.stringify(records);
    expect(logged).not.toContain("alice@");
    expect(records[0]?.error?.name).toBe("Error");
    expect(records[0]?.error?.message).toBeUndefined();
    expect(records[0]?.error?.frames).toContain("at ");
  });

  it("records a thrown undefined as an error, and no error without the argument", () => {
    const { records } = capturing();
    log.error("test.undefined", {}, undefined);
    log.error("test.none", {});
    expect(records[0]?.error).toEqual({ name: "undefined", frames: "" });
    expect(records[1]?.error).toBeUndefined();
  });

  it("does not throw if the sink throws", () => {
    capture = captureLogs({
      sink: {
        write() {
          throw new Error("sink down");
        },
      },
    });
    expect(() => log.error("test.failed")).not.toThrow();
  });

  it("writes an object with the event as message through console", async () => {
    const { consoleSink } = await import("../src/runtime/console-sink");
    const lines: unknown[] = [];
    const original = console.warn;
    console.warn = (line: unknown) => lines.push(line);
    try {
      consoleSink.write({
        level: "warn",
        event: "test.warned",
        time: 0,
        // A field named like a reserved key does not hide the event.
        fields: { requestId: "0123456789abcdef", event: "spoofed" },
      });
    } finally {
      console.warn = original;
    }
    expect(lines).toEqual([
      {
        requestId: "0123456789abcdef",
        event: "test.warned",
        level: "warn",
        message: "test.warned",
      },
    ]);
  });
});

describe("the request context", () => {
  it("keeps two concurrent requests apart", async () => {
    const { records } = capturing();
    const run = (name: string) =>
      startRequest("http", async () => {
        const id = requestId();
        await tick();
        log.info("test.step", { name });
        await tick();
        log.info("test.step", { name });
        return id;
      });
    const [a, b] = await Promise.all([run("a"), run("b")]);
    expect(a).not.toBe(b);
    for (const record of records) {
      expect(record.fields.requestId).toBe(record.fields.name === "a" ? a : b);
    }
    expect(records).toHaveLength(4);
  });

  it("does not let a field of the call replace the request ID", async () => {
    const { records } = capturing();
    const id = await startRequest("cron", async () => {
      log.info("test.spoof", { requestId: "ffffffffffffffff", trigger: "http" });
      return requestId();
    });
    expect(records[0]?.fields).toMatchObject({ requestId: id, trigger: "cron" });
  });

  it("continues the caller's request from a carrier, and refuses a malformed ID", async () => {
    capturing();
    const outer = await startRequest("http", async () => ({ id: requestId(), from: carrier() }));
    expect(outer.from.requestId).toBe(outer.id);
    expect(resumeRequest(outer.from, () => requestId())).toBe(outer.id);
    const forged = resumeRequest({ requestId: "not an id\nfake line" }, () => requestId());
    expect(forged).toMatch(/^[0-9a-f]{16}$/);
  });

  it("stays in the current request without a carrier", async () => {
    capturing();
    const ids = await startRequest("alarm", async () => [
      requestId(),
      await resumeRequest(undefined, async () => requestId(), { accountId: "a-1" }),
    ]);
    expect(ids[1]).toBe(ids[0]);
  });
});

describe("a request across the Durable Object boundary", () => {
  it("logs the caller's request ID in the Worker and in the instance", async () => {
    const { find } = capturing();
    const userId = "telemetry-user";
    await env.DB.prepare("INSERT INTO orgs (id, name) VALUES ('org-telemetry', 'T')").run();
    await env.DB.prepare(
      "INSERT INTO users (id, org_id, email, role) VALUES (?, 'org-telemetry', ?, 'member')",
    )
      .bind(userId, "telemetry@example.com")
      .run();
    // An account without tokens: the instance fails to list calendars and logs it, then the
    // Worker logs that loading failed.
    await addAccount(userId, "telemetry-account", "telemetry@example.com");
    const id = await startRequest("http", async () => {
      await refreshUserCalendars(env, userId);
      return requestId();
    });
    const [inner] = find("calendars.list_failed");
    const [outer] = find("calendars.load_failed");
    expect(outer?.fields).toMatchObject({ requestId: id, accountId: "telemetry-account" });
    expect(inner?.fields).toMatchObject({
      requestId: id,
      accountId: "telemetry-account",
      trigger: "rpc",
    });
    expect(inner?.error?.message).toBe("Account has no tokens");
  });

  it("starts a new request in the instance without a carrier", async () => {
    const { find } = capturing();
    const id = await startRequest("http", async () => {
      await accountSync(env, "telemetry-bare")
        .listCalendars()
        .catch(() => undefined);
      return requestId();
    });
    const [inner] = find("calendars.list_failed");
    expect(inner?.fields.requestId).toMatch(/^[0-9a-f]{16}$/);
    expect(inner?.fields.requestId).not.toBe(id);
  });
});

describe("the log calls of the pages and forms", () => {
  async function owner(name: string) {
    const user = {
      id: `user-${name}`,
      orgId: `org-${name}`,
      email: `${name}@example.com`,
      role: "member",
      mcpForMembers: "all",
    } as const;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO orgs (id, name) VALUES (?, 'T')").bind(user.orgId),
      env.DB.prepare("INSERT INTO users (id, org_id, email, role) VALUES (?, ?, ?, 'member')").bind(
        user.id,
        user.orgId,
        user.email,
      ),
    ]);
    return user;
  }

  /** Let every audit row of `kind` fail, as a broken log does. */
  async function withBrokenAudit(kind: string, fn: () => Promise<void>) {
    await env.DB.prepare(
      `CREATE TRIGGER broken_audit BEFORE INSERT ON audit_events WHEN NEW.kind = '${kind}'
       BEGIN SELECT RAISE(ABORT, 'audit down'); END`,
    ).run();
    try {
      await fn();
    } finally {
      await env.DB.prepare("DROP TRIGGER broken_audit").run();
    }
  }

  it("logs a failed comparison start with the request ID that it passes on", async () => {
    const { find } = capturing();
    const user = await owner("log-compare");
    await addAccount(user.id, "log-compare-account", user.email);
    let passed: unknown;
    const failing = {
      ...env,
      DATA_JURISDICTION: "",
      ACCOUNT_SYNC: {
        getByName: () => ({
          startCompares: async (_mode: string, from: unknown) => {
            passed = from;
            throw new Error("refused for alice@corp.example");
          },
        }),
      },
    } as unknown as Env;
    const id = await startRequest("http", async () => {
      await startOrgCompares(failing, user.orgId);
      return requestId();
    });
    expect(passed).toMatchObject({ requestId: id });
    const [record] = find("compare.start_failed");
    expect(record?.fields).toMatchObject({ requestId: id, accountId: "log-compare-account" });
    expect(JSON.stringify(record)).not.toContain("alice@");
  });

  it("logs a failed audit of a disconnect as an event", async () => {
    const { find } = capturing();
    const user = await owner("log-disconnect");
    await addAccount(user.id, "log-disconnect-account", user.email);
    await withBrokenAudit("account_disconnected", () =>
      startRequest("http", () => removeAccounts(env, user, ["log-disconnect-account"])),
    );
    const [record] = find("audit.write_failed");
    expect(record?.fields).toMatchObject({ auditKind: "account_disconnected", trigger: "http" });
  });

  it("logs a failed audit of changed settings as an event", async () => {
    const { find } = capturing();
    const user = await owner("log-settings");
    await addAccount(user.id, "log-settings-a", "log-settings-a@example.com");
    await addAccount(user.id, "log-settings-b", "log-settings-b@example.com");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO calendars (id, account_id, remote_id, name, can_edit)
         VALUES ('log-ca', 'log-settings-a', 'a', 'A', 1), ('log-cb', 'log-settings-b', 'b', 'B', 1)`,
      ),
      env.DB.prepare(
        `INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options)
         VALUES ('log-rule', ?, 'log-ca', 'log-cb', '{"markPrivate":false}')`,
      ).bind(user.id),
    ]);
    const form = new FormData();
    form.set("newWho", "private");
    form.set("applyWho", "1");
    await withBrokenAudit("settings_changed", () =>
      startRequest("http", () =>
        // The syncs are collected, so no instance is called.
        setSettings(env, user, settingsFrom(form, "Busy"), new Set()),
      ),
    );
    const [record] = find("audit.write_failed");
    expect(record?.fields).toMatchObject({ auditKind: "settings_changed", trigger: "http" });
  });
});

describe("the Workers tracer", () => {
  it("runs a span and returns its result without observability", async () => {
    capture = captureLogs({ tracer: workersTracer });
    const result = await span("test.span", { ruleId: "r-1", none: undefined }, async (s) => {
      // Without observability these calls record nothing; they must not throw.
      s.setAttributes({ count: 1 });
      s.recordError(new Error("boom"));
      return 42;
    });
    expect(result).toBe(42);
    // Tests run without observability, so the trace IDs are zeros and count as no trace.
    expect(traceId()).toBeUndefined();
  });
});
