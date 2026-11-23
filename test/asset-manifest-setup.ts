import { writeBuild, writeManifest } from "../scripts/asset-manifest-lib.mjs";

/**
 * Vitest global setup. Other work edits `public/` often, and a stale manifest or a stale `dist/public`
 * (which `wrangler.jsonc` serves) would fail unrelated tests. The build comes before the manifest, as
 * in `scripts/asset-manifest.mjs`. The strict check is `pnpm assets:check`, which `pnpm check` runs
 * before the tests.
 */
export function setup(): void {
  writeBuild();
  writeManifest();
}
