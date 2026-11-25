import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PUBLIC = join(import.meta.dirname, "..", "public");
const manifest = JSON.parse(readFileSync(join(PUBLIC, "manifest.webmanifest"), "utf8")) as {
  id: string;
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  display_override: string[];
  background_color: string;
  theme_color: string;
  icons: { src: string; sizes: string; type: string; purpose?: string }[];
};

/** Width and height from the IHDR chunk of a PNG file. */
function pngSize(file: string): [number, number] {
  const bytes = readFileSync(file);
  expect(bytes.subarray(0, 8).toString("hex"), file).toBe("89504e470d0a1a0a");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

describe("web app manifest (public/manifest.webmanifest)", () => {
  it("holds the fields that installability needs", () => {
    expect(manifest.id).toBe("/");
    expect(manifest.name).toBe("slotmirror");
    expect(manifest.short_name).toBe("slotmirror");
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.display_override).toEqual(["window-controls-overlay", "standalone"]);
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/);
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("names only same-origin paths and says nothing about a deployment or a user", () => {
    for (const value of [manifest.id, manifest.start_url, manifest.scope]) {
      expect(value.startsWith("/") && !value.startsWith("//")).toBe(true);
    }
    expect(JSON.stringify(manifest)).not.toMatch(/https?:|@|workers\.dev/);
  });

  it("lists icons that exist with the size they claim", () => {
    const wanted = (size: number, purpose: string) =>
      manifest.icons.find((i) => i.sizes === `${size}x${size}` && (i.purpose ?? "any") === purpose);
    for (const [size, purpose] of [
      [192, "any"],
      [512, "any"],
      [512, "maskable"],
    ] as const) {
      const icon = wanted(size, purpose);
      expect(icon, `${size} ${purpose}`).toBeDefined();
      expect(icon?.type).toBe("image/png");
      const file = join(PUBLIC, icon?.src ?? "missing");
      expect(existsSync(file), file).toBe(true);
      expect(pngSize(file), file).toEqual([size, size]);
    }
    for (const icon of manifest.icons)
      expect(existsSync(join(PUBLIC, icon.src)), icon.src).toBe(true);
  });

  it("has the 180 px touch icon that the pages link", () => {
    expect(pngSize(join(PUBLIC, "app-icons", "apple-touch-icon.png"))).toEqual([180, 180]);
  });
});
