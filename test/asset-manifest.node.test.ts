import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ASSET_DIR,
  buildFile,
  builtFiles,
  hashAssets,
  hashedUrl,
  isFresh,
  MANIFEST_FILE,
  OUT_DIR,
  PUBLIC_DIR,
  renderManifest,
  writeBuild,
  writeManifest,
} from "../scripts/asset-manifest-lib.mjs";
import pins from "./fixtures/asset-font-pins.json";

describe("asset manifest", () => {
  it("lists every CSS and JS file of public/next, in path order", () => {
    // `test/asset-manifest-setup.ts` has just rewritten the file, so this holds the generator
    // to its own output format. The strict staleness gate is `pnpm assets:check`.
    expect(isFresh()).toBe(true);
    expect(readFileSync(MANIFEST_FILE, "utf8")).toBe(renderManifest(hashAssets()));
    const paths = Object.keys(hashAssets());
    expect(paths).toEqual([...paths].sort());
    expect(paths).toContain("/next/base.css");
    expect(paths).toContain("/next/vendor/idiomorph-0.8.0.min.js");
    // The font is not hashed: the CSS names it, under a versioned file name.
    expect(paths.filter((path) => !/\.(css|js)$/.test(path))).toEqual([]);
  });

  it("is stale after a file changes, and the generator then fixes it", () => {
    const dir = mkdtempSync(join(tmpdir(), "asset-manifest-"));
    try {
      const assets = join(dir, "next");
      mkdirSync(join(assets, "sub"), { recursive: true });
      writeFileSync(join(assets, "a.css"), "a { color: red }");
      writeFileSync(join(assets, "sub", "b.js"), "1");
      const manifest = join(dir, "manifest.ts");
      expect(isFresh(manifest, assets)).toBe(false);
      expect(writeManifest(manifest, assets)).toBe(true);
      expect(isFresh(manifest, assets)).toBe(true);
      expect(writeManifest(manifest, assets)).toBe(false);
      writeFileSync(join(assets, "a.css"), "a { color: blue }");
      expect(isFresh(manifest, assets)).toBe(false);
      expect(writeManifest(manifest, assets)).toBe(true);
      writeFileSync(join(assets, "c.css"), "new file");
      expect(isFresh(manifest, assets)).toBe(false);
      expect(Object.keys(hashAssets(assets))).toEqual([
        "/next/a.css",
        "/next/c.css",
        "/next/sub/b.js",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the font", () => {
  const fonts = readdirSync(join(ASSET_DIR, "fonts"));

  it("has a pinned content hash under a versioned file name", () => {
    for (const name of fonts) {
      const url = `/next/fonts/${name}`;
      const pinned = (pins as Record<string, string>)[url];
      expect(pinned, `${url} needs an entry in test/fixtures/asset-font-pins.json`).toBeDefined();
      const actual = createHash("sha256")
        .update(readFileSync(join(ASSET_DIR, "fonts", name)))
        .digest("hex");
      expect(
        actual,
        `${url} changed. A font URL cannot carry ?v=: give the new file a new name and a new pin.`,
      ).toBe(pinned);
    }
  });

  it("is named in the CSS under the same versioned name", () => {
    const css = readFileSync(join(ASSET_DIR, "base.css"), "utf8");
    const urls = [...css.matchAll(/url\("(\/next\/fonts\/[^"?]+)"\)/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(Object.keys(pins)).toContain(url);
    for (const url of Object.keys(pins)) expect(url).toMatch(/-\d[\w.]*\.woff2$/);
  });
});

describe("public/_headers", () => {
  const file = join(PUBLIC_DIR, "_headers");

  it("makes /next/* immutable, which is safe because the names carry the hash", () => {
    const rules = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
    expect(rules.map((line) => line.trim())).toEqual([
      "/next/*",
      "Cache-Control: public, max-age=31536000, immutable",
    ]);
  });

  it("is copied unchanged to the served folder", () => {
    expect(readFileSync(join(OUT_DIR, "_headers"), "utf8")).toBe(readFileSync(file, "utf8"));
  });

  it("covers no bare CSS or JS name: `immutable` on one would keep a stale file for a year", () => {
    const served = readdirSync(join(OUT_DIR, "next"), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
    expect(served.length).toBeGreaterThan(10);
    for (const name of served) {
      if (/\.(css|js)$/.test(name)) expect(name, name).toMatch(/\.[0-9a-f]{10}\.(css|js)$/);
    }
  });
});

describe("the build", () => {
  function tree(): { dir: string; publicDir: string; outDir: string } {
    const dir = mkdtempSync(join(tmpdir(), "asset-build-"));
    const publicDir = join(dir, "public");
    mkdirSync(join(publicDir, "next", "vendor"), { recursive: true });
    mkdirSync(join(publicDir, "next", "fonts"), { recursive: true });
    mkdirSync(join(publicDir, "app-icons"), { recursive: true });
    writeFileSync(
      join(publicDir, "next", "a.css"),
      "/* a long comment */\n.a {\n  color: light-dark(#ffffff, #000000);\n}\n",
    );
    writeFileSync(
      join(publicDir, "next", "b.js"),
      "// a comment\n(() => {\n  const longName = 1;\n  window.x = longName + 1;\n})();\n",
    );
    // Already minified in the real tree. The build must not touch it, only name it.
    writeFileSync(join(publicDir, "next", "vendor", "v-1.min.js"), "var   spaced  =  1 ;\n");
    writeFileSync(join(publicDir, "next", "fonts", "f-1.woff2"), "font bytes");
    writeFileSync(join(publicDir, "manifest.webmanifest"), "{}");
    writeFileSync(join(publicDir, "style.css"), "/* old page, fixed path */\nbody { margin: 0 }\n");
    writeFileSync(join(publicDir, "app-icons", "i.png"), "png");
    return { dir, publicDir, outDir: join(dir, "dist", "public") };
  }

  const served = (outDir: string) =>
    readdirSync(outDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name).slice(outDir.length + 1))
      .sort();

  it("minifies own CSS and JS, names them by hash, and copies the rest unchanged", () => {
    const { dir, publicDir, outDir } = tree();
    try {
      expect(writeBuild(publicDir, outDir)).toBe(true);
      const assets = hashAssets(join(publicDir, "next"));
      const vendor = "next/vendor/v-1.min." + assets["/next/vendor/v-1.min.js"] + ".js";
      expect(served(outDir)).toEqual(
        [
          "app-icons/i.png",
          "manifest.webmanifest",
          "next/a." + assets["/next/a.css"] + ".css",
          "next/b." + assets["/next/b.js"] + ".js",
          "next/fonts/f-1.woff2",
          vendor,
          "style.css",
        ].sort(),
      );
      const css = readFileSync(join(outDir, "next", `a.${assets["/next/a.css"]}.css`), "utf8");
      expect(css).toBe(".a{color:light-dark(#ffffff,#000000)}\n");
      const js = readFileSync(join(outDir, "next", `b.${assets["/next/b.js"]}.js`), "utf8");
      expect(js).not.toContain("longName");
      expect(js).not.toContain("comment");
      // Not minified, not renamed: the bytes are the source.
      expect(readFileSync(join(outDir, vendor), "utf8")).toBe("var   spaced  =  1 ;\n");
      // Fixed paths: same name, same bytes.
      expect(readFileSync(join(outDir, "style.css"), "utf8")).toContain("old page, fixed path");
      expect(readFileSync(join(outDir, "next", "fonts", "f-1.woff2"), "utf8")).toBe("font bytes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("changes the file name when the minified output changes, and not for a comment", () => {
    const { dir, publicDir, outDir } = tree();
    try {
      const next = join(publicDir, "next");
      const before = hashAssets(next);
      writeBuild(publicDir, outDir);
      writeFileSync(
        join(next, "a.css"),
        "/* another comment */\n.a { color: light-dark(#ffffff, #000000) }\n",
      );
      expect(hashAssets(next)["/next/a.css"]).toBe(before["/next/a.css"]);
      writeFileSync(join(next, "a.css"), ".a { color: light-dark(#ffffff, #111111) }\n");
      const after = hashAssets(next);
      expect(after["/next/a.css"]).not.toBe(before["/next/a.css"]);
      writeBuild(publicDir, outDir);
      expect(existsSync(join(outDir, "next", `a.${after["/next/a.css"]}.css`))).toBe(true);
      expect(existsSync(join(outDir, "next", `a.${before["/next/a.css"]}.css`))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rewrites nothing when nothing changed, and removes files that left the source", () => {
    const { dir, publicDir, outDir } = tree();
    try {
      writeBuild(publicDir, outDir);
      const icon = join(outDir, "app-icons", "i.png");
      const mtime = statSync(icon).mtimeMs;
      expect(writeBuild(publicDir, outDir)).toBe(false);
      expect(statSync(icon).mtimeMs).toBe(mtime);
      rmSync(join(publicDir, "app-icons"), { recursive: true });
      expect(writeBuild(publicDir, outDir)).toBe(true);
      expect(existsSync(icon)).toBe(false);
      expect(existsSync(join(outDir, "app-icons"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the manifest, the file names and the served bytes of the real tree in line", () => {
    const names = new Set(builtFiles().map(([rel]) => rel));
    for (const [url, hash] of Object.entries(hashAssets())) {
      expect(names.has(hashedUrl(url, hash).slice(1)), url).toBe(true);
    }
    // The real served folder is current: `test/asset-manifest-setup.ts` has just written it.
    for (const [rel, data] of builtFiles()) {
      expect(readFileSync(join(OUT_DIR, rel)).equals(data), rel).toBe(true);
    }
    expect(served(OUT_DIR).length).toBe(builtFiles().length);
  });

  it("shrinks the real stylesheets and keeps what they say", () => {
    const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");
    const count = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].length;
    const names = (text: string, pattern: RegExp) =>
      [...new Set([...text.matchAll(pattern)].map((match) => match[1] ?? ""))].sort((a, b) =>
        a.localeCompare(b),
      );
    for (const name of readdirSync(ASSET_DIR).filter((file) => file.endsWith(".css"))) {
      const file = join(ASSET_DIR, name);
      const source = strip(readFileSync(file, "utf8"));
      const built = buildFile(file).toString("utf8");
      expect(built.length, name).toBeLessThan(source.length);
      // The two themes, the tokens, the media queries and the animations must survive.
      expect(count(built, /light-dark\(/g), `${name} light-dark`).toBe(
        count(source, /light-dark\(/g),
      );
      expect(names(built, /(--[\w-]+)\s*:/g), `${name} custom properties`).toEqual(
        names(source, /(--[\w-]+)\s*:/g),
      );
      expect(count(built, /@media/g), `${name} @media`).toBe(count(source, /@media/g));
      expect(names(built, /@keyframes\s+([\w-]+)/g), `${name} keyframes`).toEqual(
        names(source, /@keyframes\s+([\w-]+)/g),
      );
      expect(count(built, /@font-face/g), `${name} @font-face`).toBe(count(source, /@font-face/g));
    }
  });
});
