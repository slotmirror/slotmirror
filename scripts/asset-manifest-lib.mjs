/**
 * The asset build. The sources are `public/` (authored files, never served as they are). The build
 * writes the served copy to `dist/public/` (`OUT_DIR`), which `assets.directory` in `wrangler.jsonc`
 * names:
 *
 * - CSS and JavaScript under `public/next/` are minified with esbuild and get the content hash in
 *   the file name: `/next/base.css` is served as `/next/base.<hash>.css`. A changed file has a new
 *   URL, so `public/_headers` can make `/next/*` `immutable`. `vendor/` is already minified: it is
 *   hashed but not minified.
 * - Every other file (fonts, icons, `manifest.webmanifest`, `_headers`) is copied unchanged, at the
 *   same path.
 *
 * `scripts/asset-manifest.mjs` writes the hashes into `src/asset-manifest.ts`; `asset()` in
 * `src/pages/next/assets.ts` builds the hashed URL. The hash covers the minified output, so it
 * depends on the esbuild version: it is pinned in `package.json`.
 * Plain JavaScript on purpose: `wrangler deploy` runs the generator, and Node runs `.ts` files only
 * from 22.18, while the docs name Node 22. Types are in `asset-manifest-lib.d.mts`.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const PUBLIC_DIR = join(ROOT, "public");
/** Sources of the CSS and JavaScript. */
export const ASSET_DIR = join(PUBLIC_DIR, "next");
/** What `wrangler` serves. Gitignored. */
export const OUT_DIR = join(ROOT, "dist", "public");
export const MANIFEST_FILE = join(ROOT, "src", "asset-manifest.ts");
/** URL prefix of `ASSET_DIR`. */
export const URL_PREFIX = "/next";

const HASH_LENGTH = 10;

const sha = (data) => createHash("sha256").update(data).digest("hex").slice(0, HASH_LENGTH);

function listFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listFiles(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

const isCode = (file) => [".css", ".js"].includes(extname(file));

/** The bytes that are served for a source file: minified, or unchanged for `vendor/`. */
export function buildFile(file, data = readFileSync(file)) {
  if (!isCode(file) || file.split(sep).includes("vendor")) return data;
  const loader = extname(file) === ".css" ? "css" : "js";
  const out = transformSync(data.toString("utf8"), {
    loader,
    minify: true,
    legalComments: "none",
    sourcefile: file,
  });
  return Buffer.from(out.code);
}

/** `/next/base.css` and `a1b2c3d4e5` give `/next/base.a1b2c3d4e5.css`. */
export function hashedUrl(url, hash) {
  const ext = extname(url);
  return `${url.slice(0, url.length - ext.length)}.${hash}${ext}`;
}

/**
 * URL path to the content hash of the served bytes, for the CSS and JavaScript files only. Sorted
 * by path so that the output is stable.
 */
export function hashAssets(dir = ASSET_DIR, prefix = URL_PREFIX) {
  const entries = listFiles(dir)
    .filter(isCode)
    .map((file) => {
      const url = `${prefix}/${relative(dir, file).split(sep).join("/")}`;
      return [url, sha(buildFile(file))];
    });
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries);
}

/** The served files as `[path relative to the output folder, bytes]`. */
export function builtFiles(publicDir = PUBLIC_DIR) {
  return listFiles(publicDir).map((file) => {
    const rel = relative(publicDir, file).split(sep).join("/");
    // Only the CSS and JS under next/ are built. Other files (manifest, icons) are referenced by
    // fixed paths and stay byte for byte as they are.
    const built = rel.startsWith("next/") && isCode(file);
    const data = built ? buildFile(file) : readFileSync(file);
    return [built ? hashedUrl(rel, sha(data)) : rel, data];
  });
}

/**
 * Makes `outDir` equal to the build: writes new or changed files, removes the rest. A file that
 * did not change is not touched, so `wrangler dev` reloads only for a real change. Returns true if
 * anything changed.
 */
export function writeBuild(publicDir = PUBLIC_DIR, outDir = OUT_DIR) {
  const built = new Map(builtFiles(publicDir));
  let changed = false;
  for (const [rel, data] of built) {
    const target = join(outDir, rel);
    if (existsSync(target) && readFileSync(target).equals(data)) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    changed = true;
  }
  if (existsSync(outDir)) {
    for (const file of listFiles(outDir)) {
      if (built.has(relative(outDir, file).split(sep).join("/"))) continue;
      rmSync(file);
      changed = true;
    }
    pruneEmpty(outDir, true);
  }
  return changed;
}

function pruneEmpty(dir, isRoot = false) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) pruneEmpty(join(dir, entry.name));
  }
  if (!isRoot && readdirSync(dir).length === 0) rmdirSync(dir);
}

/** One hash for the whole set. It changes with any file, and it changes with a deploy. */
export function combinedVersion(assets) {
  return sha(
    Object.entries(assets)
      .map(([path, hash]) => `${path}:${hash}\n`)
      .join(""),
  );
}

/** The source of `src/asset-manifest.ts`, in the format that `oxfmt` keeps. */
export function renderManifest(assets) {
  const lines = Object.entries(assets).map(([path, hash]) => `  "${path}": "${hash}",`);
  return [
    "// Generated by scripts/asset-manifest.mjs from the CSS and JS files in public/next/. Do not edit.",
    "// `pnpm assets:generate` rewrites it, `pnpm assets:check` fails if it is stale, and the",
    "// `build` hook in wrangler.jsonc runs the generator before `wrangler dev` and `wrangler deploy`.",
    "",
    "/** URL path to the content hash of the file. */",
    "export const ASSETS: Readonly<Record<string, string>> = {",
    ...lines,
    "};",
    "",
    "/** Hash of all entries of `ASSETS`. It changes when any file changes. */",
    `export const ASSET_VERSION = "${combinedVersion(assets)}";`,
    "",
  ].join("\n");
}

export function expectedManifest(dir = ASSET_DIR, prefix = URL_PREFIX) {
  return renderManifest(hashAssets(dir, prefix));
}

/** True if the file on disk equals what the generator would write now. */
export function isFresh(file = MANIFEST_FILE, dir = ASSET_DIR, prefix = URL_PREFIX) {
  return existsSync(file) && readFileSync(file, "utf8") === expectedManifest(dir, prefix);
}

/** Writes the manifest if it changed. Returns true if it wrote. A rewrite of equal text would reload `wrangler dev` for nothing. */
export function writeManifest(file = MANIFEST_FILE, dir = ASSET_DIR, prefix = URL_PREFIX) {
  if (isFresh(file, dir, prefix)) return false;
  writeFileSync(file, expectedManifest(dir, prefix));
  return true;
}
