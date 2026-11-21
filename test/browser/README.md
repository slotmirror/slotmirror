# Browser checks

Small shell scripts that drive a real browser with `agent-browser`. Most of them only open pages,
click and type. Some save and put the old values back (`enh-save.sh`, `enh-guard.sh`,
`enh-edge.sh`, `enh-stale.sh`, `enh-phone.sh`, `enh-conflict.sh`, `panel-plain.sh`, `nav-both.sh`);
the head of each script says what it changes.
The CI job `browser` in `.github/workflows/ci.yml` runs them on pull requests that change app page
files. It creates the user `u-dev` (the scripts expect `sim-u-dev-1..3`), seeds with
`/dev/seed?accounts=5&events=50&days=30`, and runs `MODE=on` and then `MODE=off`. Locally, run
them against a dev server (`pnpm dev`, default `http://localhost:8822`).

- `run-all.sh` runs the checks of one mode (`MODE=on|off`) and exits 1 if any script failed.
  `RETRIES=n` runs a failing script again up to n times.
- Every check script prints one JSON object and exits 1 when its `pass` is false, so a single
  script can also run alone: `AB_SESSION=<name> zsh test/browser/enh-swap.sh`.
- Checks depend only on the calendars `sim-u-dev-1` to `sim-u-dev-3`, never on event counts.

The two timing scripts below measure and do not pass or fail; compare their numbers with the
budget in the speed plan (section 10).

| Script                         | What it prints                                                                                                                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `warm-nav.sh [base-url]`       | One JSON object for a warm navigation between two rows on `/mirroring`: number of requests, how many files came from cache, how many were revalidated (304), the render-blocking files. |
| `timings.sh [base-url] [runs]` | Click-to-panel time over `runs` clicks (default 10): samples, median and p75 in ms.                                                                                                     |

Each script defines `ab()` for its own `agent-browser --session perf`, so the sessions do not mix
with other work. Needs `agent-browser` and `jq`. The dev server must have a signed-in user with at
least two mirrorings (`POST /dev/seed` makes them on a test instance).

## Reading the numbers

- Budget now: 1 HTML request and 0 revalidations on a warm navigation. A 304 shows as
  `revalidated304`. The file names carry the content hash and `public/_headers` makes `/next/*`
  immutable, so `fromCache` should list every file.
- `timings.sh` measures a full navigation: the old page stores the click time, the new page reports
  its first contentful paint. When enhanced navigation exists, the script measures inside one
  document instead (two animation frames after the address and panel changed).
- Timings depend on the machine. A loaded machine (see `uptime`) inflates them by a large factor.
  Write the load next to every number, and compare only runs from the same hour.
