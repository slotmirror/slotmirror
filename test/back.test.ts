import { describe, expect, it } from "vitest";
import { backPath, MAX_BACK_LENGTH } from "../src/back";

function form(back?: string | File): FormData {
  const data = new FormData();
  if (back !== undefined) data.set("back", back);
  return data;
}

const FALLBACK = "/mirroring";

describe("backPath", () => {
  it("returns the address of an app page, with its query", () => {
    expect(backPath(form("/"), "/x")).toBe("/");
    expect(backPath(form("/?x=1"), "/x")).toBe("/?x=1");
    for (const page of ["mirroring", "calendars", "activity", "admin", "tokens"]) {
      expect(backPath(form(`/${page}`), "/x"), page).toBe(`/${page}`);
    }
    expect(backPath(form("/mirroring?d=a~b&saved=1"), "/x")).toBe("/mirroring?d=a~b&saved=1");
    expect(backPath(form("/calendars?c=abc#row"), "/x")).toBe("/calendars?c=abc");
  });

  it("uses the fallback without a field or with a file", () => {
    expect(backPath(form(), FALLBACK)).toBe(FALLBACK);
    expect(backPath(form(new File(["x"], "x.txt")), FALLBACK)).toBe(FALLBACK);
  });

  it("refuses paths that are no app page", () => {
    const refused = [
      "/rules",
      "/rules?open=x",
      "/privacy",
      "/auth/google/connect",
      "/account/delete",
      "/admin/users/x/delete",
      "/mirroring/x",
      "/mirroringx",
      "/MIRRORING",
      "mirroring",
      "",
      // The old prefix names a page only if the mapped path is one, see the next test.
      "/next/base.abc.css",
      "/next/rules",
    ];
    for (const value of refused) {
      expect(backPath(form(value), FALLBACK), value).toBe(FALLBACK);
    }
  });

  it("maps a stale /next target of the last release to the page below the root", () => {
    expect(backPath(form("/next/mirroring?d=a~b&saved=1"), FALLBACK)).toBe(
      "/mirroring?d=a~b&saved=1",
    );
    expect(backPath(form("/next/calendars?c=abc"), "/x")).toBe("/calendars?c=abc");
    expect(backPath(form("/next"), "/x")).toBe("/");
    expect(backPath(form("/next?x=1"), "/x")).toBe("/?x=1");
    for (const value of [
      "/next//evil.com",
      "/next/%2F%2Fevil.com",
      "/next/../admin",
      "/next/./admin",
      "/next/mirroring/../../admin",
      "/next/rules",
    ]) {
      expect(backPath(form(value), "/x"), value).toBe("/x");
    }
  });

  it("refuses another host, a scheme and a backslash", () => {
    const bad = [
      "//evil.example",
      "//evil.example/mirroring",
      "/mirroring//evil.example",
      "/mirroring/..//evil.example",
      "https://evil.example/mirroring",
      "javascript:alert(1)",
      "/mirroring\\evil",
      "/\\evil.example",
      "/mirroring/\\/evil.example",
      "/next/\t/evil.example",
      "/mirroring\n/x",
      "/mirroring /x",
      "/mirroring/../rules",
      "/mirroring/%2e%2e/rules",
      "/?x=//evil.example",
    ];
    for (const value of bad) {
      expect(backPath(form(value), FALLBACK), JSON.stringify(value)).toBe(FALLBACK);
    }
  });

  it("pins the probe inputs of the security review", () => {
    const probes = [
      "/next/\\evil",
      "/next/../mirroring",
      "/?//evil",
      "/.//evil",
      "//evil",
      "/\\evil",
      "/mirroring/\\evil",
      "/mirroring/\t/evil",
      "/mirroring/\n/evil",
      "/mirroring/\r\n/evil",
      "/mirroring/ /evil",
      "%2F%2Fevil",
      "/mirroring%2F%2Fevil",
      "/mirroring/%2F%2Fevil",
      "/mirroring/%5Cevil",
      "/mirroring%5Cevil",
      "/mirroring/%0d%0aSet-Cookie:x=1",
      "/mirroring?x=%0d%0aX-Injected:1",
      "/mirroring/../x",
      "/mirroring/%2e%2e/x",
      "/mirroring/.%2e/x",
      "/mirroringevil",
      "/mirroring-evil",
      "#//evil",
      "/mirroring#//evil",
      "/mirroring\u2028/evil",
      "/mirroring/\u2028//evil",
      "/mirroring/\u2029/evil",
      "\uFF0F\uFF0Fevil.example",
      "/mirroring/\uFF0F\uFF0Fevil.example",
      "/mirroring/\uFF3C\uFF3Cevil.example",
      "\uFF0Fnext/mirroring",
    ];
    for (const value of probes) {
      const result = backPath(form(value), FALLBACK);
      // Either the fallback, or a plain ASCII app page address that names no other host.
      const local =
        /^\/(?:(?:mirroring|calendars|activity|admin|tokens)?(?:\?[\x21-\x7e]*)?)$/.test(result);
      expect(result === FALLBACK || local, JSON.stringify([value, result])).toBe(true);
      expect(result.startsWith("//"), JSON.stringify([value, result])).toBe(false);
      expect(result.includes("\\"), JSON.stringify([value, result])).toBe(false);
      expect(/[\r\n\t]/.test(result), JSON.stringify([value, result])).toBe(false);
    }
  });

  it("caps the length of the value", () => {
    const longest = `/mirroring?d=${"a".repeat(MAX_BACK_LENGTH - "/mirroring?d=".length)}`;
    expect(longest).toHaveLength(MAX_BACK_LENGTH);
    expect(backPath(form(longest), FALLBACK)).toBe(longest);
    expect(backPath(form(`${longest}a`), FALLBACK)).toBe(FALLBACK);
    expect(backPath(form(`/mirroring?x=${"a".repeat(200_000)}`), FALLBACK)).toBe(FALLBACK);
  });
});
