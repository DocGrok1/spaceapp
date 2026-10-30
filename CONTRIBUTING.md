# Contributing to SpaceApp

Advanced API settings are documented in the [configuration reference](docs/configuration-reference.md).

Use a checkout you own. Do not run development tests against an installed
operator instance or reuse its credentials, browser profiles, sockets or data.

## Development prerequisites

The monorepo requires Node **>=22.12 <23**, as declared in the root
`package.json`, and npm. Linux is the reference development environment;
Windows contributors can use WSL. Building `node-pty` may require Python 3,
Make and a C++ compiler if a compatible prebuilt binary is unavailable.

The `run-spaceapp` installer is a separate package with its own host Node
requirement. Installing the application and developing this monorepo have
different prerequisites; consult the selected installer's `engines` field.

From the repository root, install the locked dependencies:

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
```

Skipping the Electron download is suitable for core development. Desktop
packaging requires its normal toolchain and separate platform acceptance.
Dependency installation may use the network; the smoke command below does not
need a provider account, API key, Docker, PostgreSQL or Temporal.

## First executed task, without a provider

```sh
npm run smoke:offline
```

This builds the CLI host and runs an explicitly **simulated runtime** through
the real Unix socket protocol and a real PTY child. It submits two arithmetic
tasks, checks their results, reconnects without replacing the process, and
resubmits an input key to verify duplicate suppression within that host's
retained session. The child receives an allowlisted environment. Its process,
socket and temporary directory are removed before success is reported.

Success is a JSON record with `mode: "SIMULATED_RUNTIME"`, `passed: true` and
`cleaned: true`. A wrong answer or early child exit fails the command. This is
a contributor transport/acceptance check, not evidence of AI quality, provider
authentication, native task resume, browser behavior or crash durability.

Unix socket paths are short. If your inherited `TMPDIR` is deeply nested,
select a short temporary directory you own and set `TMPDIR` for the command.
On Windows run this particular smoke check inside WSL or a Linux development
container. It does not certify the Windows/macOS installer.

## Run the full app from source

`npm run dev:stack` starts a working SpaceApp from this checkout with hot
reload. It never touches an installed SpaceApp: it has its own compose project
(`spaceapp-dev-stack`), its own git-ignored state directory (`.dev-stack/`)
and its own ports, and every port it opens binds to `127.0.0.1` only.

Prerequisites: the Node and npm versions above, `npm ci` done, and Docker with
the Compose plugin (`docker compose version`). Docker runs only PostgreSQL
(pgvector) and Temporal, with the images and digests pinned in
`packages/run-spaceapp/templates/compose.yml` (read from that file at start).

```sh
npm run dev:stack            # start; prints the URL and the one-time owner setup token
npm run dev:stack -- down    # stop the processes and containers, keep the data
npm run dev:stack -- reset   # remove the containers, volumes and .dev-stack/ it created
npm run dev:stack -- rebuild # rebuild packages/* and restart the API, worker and CLI host
npm run dev:stack -- status
```

In order, `dev:stack` starts PostgreSQL and Temporal and waits for their
health checks, builds the workspace packages, runs the migrations, installs the
OpenCode version pinned in the `Dockerfile` into `.dev-stack/cli/vendor/` (not
globally), and then runs from source, each with its own prefix in the output:

| Process | What runs | Reload |
| --- | --- | --- |
| `[api]` | `tsx watch apps/api/src/server.ts` | restarts on a change in `apps/api/src` |
| `[worker-build]`, `[worker]` | `tsc --watch` and `node --watch dist/worker.js` | restarts on a change in `apps/worker/src` |
| `[web]` | Vite dev server | hot reload in the browser for `apps/web/src` |
| `[cli-host]` | `packages/cli-host/dist/main.js` on `.dev-stack/run/cli-host.sock` | `rebuild` |

A change in `packages/*` is picked up with `npm run dev:stack -- rebuild` in a
second terminal: it builds the packages and the running stack restarts the
processes that load them.

Open the printed URL, enter the setup token, create the owner and sign in
(the dev-login shortcut is off). The Getting Started room opens; an OpenCode
pane starts through the from-source CLI host with the same wrapper as the
image (`deploy/docker/public-cli-wrapper.sh`, pointed at `.dev-stack/cli/`).
OpenCode's free model needs no provider account. The browser service and the
optional companions stay disabled.

Ports (environment variables; the defaults are never 4910/4911):

| Variable | Default |
| --- | --- |
| `SPACE_DEV_STACK_WEB_PORT` (open this one) | 4921 |
| `SPACE_DEV_STACK_API_PORT` | 4920 |
| `SPACE_DEV_STACK_POSTGRES_PORT` | 4922 |
| `SPACE_DEV_STACK_TEMPORAL_PORT` | 4923 |

`SPACE_DEV_STACK_DIR` moves the state directory and `SPACE_DEV_STACK_PROJECT`
renames the compose project. The database password, session secret and setup
token are generated once per state directory in `.dev-stack/secrets/` with
mode 0600; only the setup token is printed. `SPACE_*` variables of your shell
are not passed to the processes.

If a process exits, `dev:stack` names it (`dev-stack: worker exited
unexpectedly ...`) and stops the stack. While it runs it checks `/readyz` and
prints the dependency that fails (for example `worker=ERROR`).

Troubleshooting:

- *Port ... is in use*: set the matching `SPACE_DEV_STACK_*_PORT`.
- *The dev stack is already running*: `npm run dev:stack -- down` first.
- */readyz did not report ok*: the last line names the failing dependency;
  `docker compose --project-name spaceapp-dev-stack --file .dev-stack/compose.yml logs`
  shows the PostgreSQL and Temporal side.
- *was not created by dev:stack*: `SPACE_DEV_STACK_DIR` names a directory that
  already holds other files; `dev:stack` never uses or removes it.
- A deep checkout path puts the CLI host socket in a private directory under
  `TMPDIR` (Unix sockets are limited to about 100 bytes).

Platform notes:

- **Linux**: Docker Engine with the Compose plugin.
- **macOS**: Docker Desktop, or Colima (`colima start`, then `docker context use colima`).
  The ports are published on the Mac's `127.0.0.1`.
- **Windows 11**: run everything inside WSL2 (Ubuntu), with the checkout on the
  Linux file system (`~/src/spaceapp`, not `/mnt/c/...`, for file watching and
  speed) and Docker Desktop's WSL integration or Docker Engine inside WSL.
  Open the URL in a Windows browser; WSL forwards `127.0.0.1`. Native Windows is
  refused with a message.

The `Dev stack` CI workflow runs `scripts/dev-stack-ci.mjs` on `ubuntu-latest`:
it starts the stack without a TTY, waits for `/readyz`, creates the owner over
HTTP, opens an OpenCode pane through the API, checks that it runs, then runs
`reset` and checks that no container, volume or process is left.

## Make and verify a small change

Work on a branch, not on `main`, so the change can become a pull request:

```sh
git switch -c my-change
```

For example, change the synthetic task's result handling in
`scripts/fixtures/offline-cli.mjs`, then run:

```sh
npm run test:contributor
npm run check
```

The contributor regression tests reject incorrect task output and early process
exit, and check cleanup after both. Restore the intended behavior before
submitting a change. Use the tests for the affected workspace as well; the
offline smoke is not a substitute for them.

## Checks before a commit

After `npm ci`, these commands work in this order, also on a fresh clone:

```sh
npm run check
npm test
npm run build
npm run hygiene:preflight
```

`npm run check` runs the dependency boundary check, builds the internal
`@space/*` packages in dependency order and then type-checks the apps, so it
does not need an earlier `npm run build`. `npm test` builds the internal
packages and runs the test suites in this checkout. `npm run build` also builds
the API, worker and web app. Run `npm run hygiene:preflight` before every
commit: it fails on untracked files and on staged runtime, secret, dependency,
generated or report paths. Commit from your branch; older releases of this
check also refuse to run on `main`.

Opt-in database and authenticated provider proofs require separate isolated
fixtures; skipped proofs are not passing evidence.

In the maintainers' source repository, `npm run check:claims` compares the
version, licence, Node requirement, runtime list and key constants stated in
the README and `docs/` with the code, and rejects unqualified latency or
isolation claims; maintainers run it when a change touches any of them. Current
results and known failures are indexed there in `docs/quality/README.md`, and
its `AGENTS.md` describes the guidance to read before changing session
attachment, room retention, control, readiness, polling or deployment.

Keep changes reviewable and include the exact commands and limitations of your
verification. Never include credentials, private transcripts or local runtime
state in a contribution.

## License of contributions

SpaceApp is licensed under the [MIT License](LICENSE). Contributions are
accepted under the same license (inbound = outbound): by submitting a
contribution you license it to everyone under the MIT License. You keep the
copyright of your contribution.

Every commit must carry a `Signed-off-by:` line with your real name and email,
which certifies the [Developer Certificate of Origin 1.1](https://developercertificate.org/):
that you wrote the contribution or have the right to submit it under the MIT
License. `git commit -s` adds the line. There is no separate contributor
license agreement.

## Reviews and payment

Pull requests are reviewed and merged by the maintainers named in the public repository's `MAINTAINERS`
file. A merged pull request stays in every later release with its author.

Contributions are voluntary; payment applies only to issues labelled 💎 Bounty, under the terms posted on
that issue.
