import { ASSETS, ASSET_VERSION } from "../../asset-manifest";

declare const __TEST_RUNTIME__: string | undefined;

export { ASSET_VERSION };

/** `/next/base.css` and `a1b2c3d4e5` give `/next/base.a1b2c3d4e5.css`. Same rule as `hashedUrl()` in `scripts/asset-manifest-lib.mjs`. */
export function hashedAssetUrl(path: string, hash: string): string {
  const dot = path.lastIndexOf(".");
  return `${path.slice(0, dot)}.${hash}${path.slice(dot)}`;
}

/**
 * URL of a CSS or JavaScript file under `public/next/`, with its content hash in the file name:
 * `/next/base.a1b2c3d4e5.css`. The build (`scripts/asset-manifest-lib.mjs`) writes the file under
 * that name, and `public/_headers` makes `/next/*` `immutable`. A changed file has a new URL, and a
 * wrong hash is a 404 that no cache keeps.
 *
 * If the path is not in the manifest, tests throw so that a typo fails a test. Production does not
 * throw, because a broken page is worse than one broken stylesheet. It returns the path as it is:
 * no file has that name, so the answer is a 404 that nothing caches, and a deploy fixes it.
 */
export function asset(path: string): string {
  const hash = ASSETS[path];
  if (hash) return hashedAssetUrl(path, hash);
  if (typeof __TEST_RUNTIME__ !== "undefined") {
    throw new Error(`asset(): ${path} is not in src/asset-manifest.ts. Run pnpm assets:generate.`);
  }
  return path;
}

/**
 * The font is named in CSS, which the build does not rewrite. Its version is in the file name instead
 * (`inter-4.001.woff2`, the version of the font itself). `test/asset-manifest.node.test.ts` pins
 * the content hash of the file to that name. The preload must use this exact URL, or the
 * browser fetches the font twice.
 */
export const FONT_URL = "/next/fonts/inter-4.001.woff2";
