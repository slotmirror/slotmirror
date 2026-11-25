---
title: Local development and load tests
description: Run slotmirror locally, run the checks, and load-test the sync with simulated calendars.
---

## Run it locally

```sh
pnpm install
cp .dev.vars.example .dev.vars   # fill in the values
pnpm db:migrate:local
pnpm dev
```

| Command           | Purpose                                                                      |
| ----------------- | ---------------------------------------------------------------------------- |
| `pnpm test`       | Vitest inside the Workers runtime (`@cloudflare/vitest-plugin`)              |
| `pnpm typecheck`  | TypeScript 7                                                                 |
| `pnpm lint`       | oxlint with type-aware rules                                                 |
| `pnpm format`     | oxfmt                                                                        |
| `pnpm check`      | All of the above                                                             |
| `pnpm cf-typegen` | Generate `worker-configuration.d.ts` again after changes to `wrangler.jsonc` |

## Sign in without a provider

For local work on the pages, `DEV_SIGN_IN_AS` in `.dev.vars` signs every request in as an existing
user with this email, without Microsoft or Google:

```sh
DEV_SIGN_IN_AS=you@example.com
DEV_FAKE_CALENDARS=1
```

The user must exist in the local database. The bypass works only if all of these hold:

- `DEV_FAKE_CALENDARS` is `1`. This marks a development or load-test instance. Never set it on a
  deployment that serves real users.
- `PUBLIC_URL` is unset or names a local host. A tunnel address turns the bypass off.
- The request goes to `localhost`, `127.0.0.1` or `[::1]`, and its `Host` header names the same
  host.
- The request carries no proxy header: `Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`,
  `X-Real-IP` or `True-Client-IP`.
- `CF-Connecting-IP`, if present, is a loopback address. This only stops a proxy that sets this
  header. `wrangler dev` keeps a value that the client sends, so it does not identify the client.

These checks catch a configuration mistake. They do not stop a client that reaches the server:
the code cannot see who connects, and under `wrangler dev` a client that sends the
`MF-Original-URL` header chooses the URL and the `Host` header that slotmirror sees. Anyone who
reaches the server signs in as this user:

- If the server listens on another address than loopback, for example `wrangler dev --ip 0.0.0.0`,
  everyone on the network signs in.
- A proxy or a port forward that sends a local `Host` and no proxy header signs every visitor in.
  For example, nginx with `proxy_pass http://127.0.0.1:8787` sends `Host: 127.0.0.1` and no
  forwarded headers. The same applies to `ssh -R`, `socat` and `kubectl port-forward`.

So set `DEV_SIGN_IN_AS` only on a server that listens on loopback, with nothing in front of it.

## Load tests with simulated calendars

This variable replaces Graph and Google with simulated calendars inside the Durable Objects:

```sh
pnpm wrangler dev --var DEV_FAKE_CALENDARS:1 --var DEV_FAKE_LATENCY_MS:80
```

Signed in as an admin:

1. `POST /dev/seed?accounts=10&events=200` creates ten accounts that mirror each other as busy. `events` goes up
   to 10000, and `days` sets the window of the user, the window of the simulated rules and the
   spread of the meetings.
2. `POST /dev/cycle` starts a sync cycle.
3. `GET /dev/stats` counts runs, writes, blocks and provider calls.

Without the variable, the `/dev` routes do not exist.

`pnpm capacity:probe` runs a staged load profile through these routes against a test instance
without real accounts. With `DEV_FAKE_FETCH_URL`, each simulated call also makes one real `fetch`,
so that the Workers subrequest limit applies. See `scripts/README.md` in the repository.

## The website

The website and these docs are an Astro site with Starlight in `website/`:

```sh
pnpm --filter website dev
pnpm --filter website build
```

## List what the audit log holds

`pnpm trial:report` reads the `rules` and `audit_events` tables and prints a plain list. It shows,
for each active rule, the time since the last successful run, runs that held duplicates twice in
a row, aborted runs and account pauses. It also lists alerts, comparisons and audit codes that
the script does not know. It makes no judgement: read the list and decide.

```sh
pnpm trial:report                                  # local database, last 7 days
pnpm trial:report --remote --since 3d              # deployed database
pnpm trial:report --remote --config wrangler.local.jsonc
```

- The script sends `SELECT` statements only. A test enforces this.
- Without `--remote` it reads the local database. `--remote` counts against the D1 read quota, so
  the audit read has a period (`--since`, default `7d`; also `72h` or a date) and a row limit
  (`--limit`, default 5000).
- `--config` goes to wrangler. `--db` names the database or binding (default `DB`).
- A successful run is not a dry run and has `failed` = 0 and `remaining` = 0. If the period holds
  no such run for a rule, the list says so and gives the facts: no run, only dry runs, or runs
  without success.
- A rule shows a pause when its source or its target account needs a reconnect.
- The output holds rule and account IDs, a short hash of each calendar ID, times, numbers and
  error codes. It holds no event content and no addresses.

## Contributing

[CONTRIBUTING.md](https://github.com/slotmirror/slotmirror/blob/main/CONTRIBUTING.md) explains
the setup, the commit format and pull requests. Report vulnerabilities privately, see
[SECURITY.md](https://github.com/slotmirror/slotmirror/blob/main/SECURITY.md).
