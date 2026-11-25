# Browser checks

Small shell scripts that drive a real browser with `agent-browser`. Most of them only open pages,
click and type. Some save and put the old values back (`enh-save.sh`, `enh-guard.sh`,
`enh-edge.sh`, `enh-stale.sh`, `enh-phone.sh`, `enh-conflict.sh`, `panel-plain.sh`, `nav-both.sh`);
the head of each script says what it changes.
The CI job `browser` in `.github/workflows/ci.yml` runs them on pull requests that change app page
files. It creates the user `u-dev` (the scripts expect `sim-u-dev-1..3`), seeds with
`/dev/seed?accounts=5&events=50&days=30`, runs `setup.sh`, and runs `MODE=on` and then `MODE=off`.

## Run the checks locally

`pnpm dev` starts `wrangler dev` on port 8787. The scripts default to port 8822, so start the
server on that port, as below, or pass the base address as the first argument. The server needs the simulated calendars and the
sign-in bypass:

1. Put `DEV_SIGN_IN_AS=dev@example.com` and `DEV_FAKE_CALENDARS=1` in `.dev.vars` (see
   `.dev.vars.example`). The bypass works on localhost only and signs in an existing user. The
   same file needs the usual secrets and `ADMIN_EMAILS=dev@example.com`.
2. Apply the migrations: `pnpm db:migrate:local`.
3. Create the user `u-dev`, because `/dev/seed` names the calendars `sim-<user id>-<n>`. The SQL is
   in the CI job (step "Create the dev user").
4. Start the server: `pnpm exec wrangler dev --port 8822`.
5. Seed it: `curl -X POST "http://localhost:8822/dev/seed?accounts=5&events=50&days=30"`.
6. Set the working hours: `zsh test/browser/setup.sh http://localhost:8822`.
7. Run the checks: `MODE=on zsh test/browser/run-all.sh`, then `MODE=off zsh test/browser/run-all.sh`.

Each script takes the base address as its first argument and defaults to port 8822. Some scripts
save and put the old values back, so use a test database and not a deployment with real data.

- `setup.sh [base-url]` sets what the seed does not: working hours on `sim-u-dev-1`, through the
  calendar save. They turn on the hours of every mirroring into it, so the working-hours checks
  find their switch and the wide lists show a tag. Run it once after `/dev/seed`; it exits 1 if
  the state is not there afterwards. A second run changes nothing.
- The checks test a desktop browser. A browser that reports no mouse (`(hover: none)` or
  `(pointer: coarse)`) gets the touch layout without keyboard hints, and `savebar.sh` fails with
  that reason. Headless Chrome on a Linux runner reports no mouse, so the CI job starts it with
  `AGENT_BROWSER_ARGS=--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4`.

- `run-all.sh` runs the checks of one mode (`MODE=on|off`) and exits 1 if any script failed.
  `RETRIES=n` runs a failing script again up to n times.
- Every check script prints one JSON object and exits 1 when its `pass` is false, so a single
  script can also run alone: `AB_SESSION=<name> zsh test/browser/enh-swap.sh`.
- Checks depend only on the calendars `sim-u-dev-1` to `sim-u-dev-3` and the hours that
  `setup.sh` sets, never on event counts.

The two timing scripts below measure and do not pass or fail. Compare their numbers between two
commits on the same machine; absolute numbers depend on the machine and its load.

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
