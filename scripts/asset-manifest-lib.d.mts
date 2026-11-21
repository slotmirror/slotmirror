export declare const ROOT: string;
export declare const PUBLIC_DIR: string;
/** Sources of the CSS and JavaScript. */
export declare const ASSET_DIR: string;
/** What `wrangler` serves. */
export declare const OUT_DIR: string;
export declare const MANIFEST_FILE: string;
/** URL prefix of `ASSET_DIR`. */
export declare const URL_PREFIX: string;
/** The bytes that are served for a source file: minified, or unchanged for `vendor/`. */
export declare function buildFile(file: string, data?: Buffer): Buffer;
/** `/next/base.css` and `a1b2c3d4e5` give `/next/base.a1b2c3d4e5.css`. */
export declare function hashedUrl(url: string, hash: string): string;
/** The served files as `[path relative to the output folder, bytes]`. */
export declare function builtFiles(publicDir?: string): Array<[string, Buffer]>;
/** Makes `outDir` equal to the build. Returns true if anything changed. */
export declare function writeBuild(publicDir?: string, outDir?: string): boolean;
/** URL path to the content hash of the served bytes, CSS and JavaScript only. */
export declare function hashAssets(dir?: string, prefix?: string): Record<string, string>;
/** One hash for the whole set. It changes with any file, and it changes with a deploy. */
export declare function combinedVersion(assets: Record<string, string>): string;
/** The source of `src/asset-manifest.ts`, in the format that `oxfmt` keeps. */
export declare function renderManifest(assets: Record<string, string>): string;
export declare function expectedManifest(dir?: string, prefix?: string): string;
/** True if the file on disk equals what the generator would write now. */
export declare function isFresh(file?: string, dir?: string, prefix?: string): boolean;
/** Writes the manifest if it changed. Returns true if it wrote. */
export declare function writeManifest(file?: string, dir?: string, prefix?: string): boolean;
