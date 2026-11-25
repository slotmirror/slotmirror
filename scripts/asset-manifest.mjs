/**
 * `pnpm assets:generate`: builds `dist/public/` (minified, hashed file names) from `public/`, then
 * writes `src/asset-manifest.ts`. The build comes first: if the manifest changed first, `wrangler dev`
 * would reload the Worker while the files it names are not there yet.
 * `pnpm assets:check`: exits 1 if the manifest is stale, and changes nothing. It does not look at
 * `dist/`, which is not in git.
 */
import { argv, exit, stderr, stdout } from "node:process";
import { isFresh, MANIFEST_FILE, writeBuild, writeManifest } from "./asset-manifest-lib.mjs";

if (argv.includes("--check")) {
  if (isFresh()) {
    stdout.write("asset manifest is current\n");
  } else {
    stderr.write(`${MANIFEST_FILE} is stale. Run: pnpm assets:generate\n`);
    exit(1);
  }
} else {
  const built = writeBuild();
  const written = writeManifest();
  stdout.write(
    `assets ${built ? "built" : "unchanged"}, manifest ${written ? "written" : "unchanged"}\n`,
  );
}
