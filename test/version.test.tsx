import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { version } from "../package.json";
import { buildVersionLabel, versionLabel } from "../src/version";
import { BASE, signIn } from "./helpers";

// vitest.config.ts sets __BUILD_COMMIT__ to "testcommit1234". The label shows nine characters.
// Each release changes the package version, so the expected label reads it from package.json.
const label = versionLabel(version, "testcommi");

describe("versionLabel", () => {
  it("shows only the commit while the version is 0.0.0", () => {
    expect(versionLabel("0.0.0", "10beb8c5a1234")).toBe("10beb8c5a");
  });

  it("shows version and commit for a release", () => {
    expect(versionLabel("1.4.0", "10beb8c5a")).toBe("v1.4.0 (10beb8c5a)");
  });

  it("shows only the version if the build has no commit", () => {
    expect(versionLabel("1.4.0", undefined)).toBe("v1.4.0");
    expect(versionLabel("1.4.0", "  ")).toBe("v1.4.0");
  });

  it("returns null if there is nothing to show", () => {
    expect(versionLabel("0.0.0", undefined)).toBeNull();
    expect(versionLabel("0.0.0", "")).toBeNull();
  });

  it("reads the build commit and the package version by default", () => {
    expect(buildVersionLabel()).toBe(label);
    expect(label).toContain("testcommi");
  });
});

describe("shell footer", () => {
  it("shows the build label in the footer of a signed-in page", async () => {
    const { cookie } = await signIn("version@org.example");
    const response = await exports.default.fetch(`${BASE}/`, { headers: { cookie } });
    const html = await response.text();
    expect(html).toContain(`<span class="num" title="Version">${label}</span>`);
    expect(html).not.toContain("undefined");
  });

  it("shows it on the sign-in page of a visitor, too", async () => {
    const html = await (await exports.default.fetch(`${BASE}/`)).text();
    expect(html).toContain(`<span class="num" title="Version">${label}</span>`);
  });
});
