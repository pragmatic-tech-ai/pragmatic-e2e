# pragmatic-e2e

The platform's cross-container test harness. It holds what spans two or more container repositories, so no single
container repository can own it. Seeded from pragmatic-server (dev-kit plan A3, the container split); it releases nothing.

| Folder | What |
|---|---|
| `src/live-loop/` | The Plexus runtime live-loop stack (`live-loop-stack.ts up/down`) and its orchestrator (`loop-orchestrator.ts`), which Plexus's e2e spawns |
| `src/dev/` | The durable local dev stack (`dev-up.sh`, `dev-seed.sh`, `dev-down.sh`, the dev kind cluster, the CA trust scripts) |
| `src/smoke/` | Operator-run smokes against Docker, kind and live consoles (not `*.test.ts`; each file says how to run it) |
| `src/e2e/` | Tests that span containers: the consoles (platform admin, tenant admin, edge, IdP), the env cluster (env server and gateway) and the capstones |
| `src/stack/` | `RepositoryRoots` (where the services' checkouts are) and `SiblingCheckouts` (the pinned sources the tests import) |
| `src/journey/` | The stage F journey harness: the owner journey against the **live** platform, leg by leg, per hive path (`npm run journey`) |

## Two kinds of sibling repositories

- **Sources the tests import** live under `repos/<repository>` (gitignored), checked out by `npm run siblings` at the
  commits `siblings.json` pins. They have no `node_modules` of their own, so every package they import resolves to this
  repository's (one installed copy of each). pragmatic-env-server's workspace packages
  (`pragmatic-identity-engine-binding`, `pragmatic-connectors-host`) resolve to its sources through `tsconfig.json`
  `paths`. Moving a pin is a reviewed change; `src/stack/tests/sibling-checkouts.test.ts` holds that every imported
  repository is pinned.
- **Services the stacks start** (the live loop's console and edge, the dev stack's console) run from full checkouts in
  `PRAGMATIC_E2E_REPOS_DIR` (default: the folder this repository sits in), each with its own `npm ci` and UIs built,
  with that repository's own `tsx` (`RepositoryRoots.Of(repo)` refuses a missing checkout by name).

## Develop

Packages come from GitHub Packages (`.npmrc`, token in `NODE_AUTH_TOKEN`).

```
npm ci
npm run siblings
npm run typecheck
npm test
```

Tests that need Docker, kind, a Postgres (`PRAGMATIC_TEST_PG_URL`) or a browser skip without them. CI
(`.github/workflows/ci.yml`) runs the same four steps.

## The live loop

```
npx tsx src/live-loop/live-loop-stack.ts up     # needs docker with buildx, kind, kubectl, Chromium; bakes its dev images
# Plexus: SP_RUNTIME_LOOP_E2E=1 PLEXUS_E2E_STACK=~/.pragmatic/e2e-stack/stack.json npx playwright test e2e/runtime-live-loop.spec.ts
npx tsx src/live-loop/live-loop-stack.ts down
```

`up` bakes the dev images it runs (`src/dev/dev-images.ts`: env server, UI unpack, hive agent, tenant IdP) from their
container repositories' checkouts in `PRAGMATIC_E2E_REPOS_DIR` (`PRAGMATIC_DEV_SKIP_IMAGE_BAKE=1` skips the bake when they
are fresh), then loads them onto its kind node; see `src/dev/README.md` ("Dev images"). Run `npm ci` and `npm run
siblings` here first: the builder reads the image names from the pinned pragmatic-platform-admin sources.

Plexus's e2e spawns `src/live-loop/loop-orchestrator.ts` from `PRAGMATIC_E2E_REPO` (default: the `pragmatic-e2e`
checkout beside Plexus), so this repository needs `npm ci` and `npm run siblings` done there.

`stack.json` lives in the stack folder (`~/.pragmatic/e2e-stack`, or `PRAGMATIC_E2E_STACK_DIR`) and names its files relative
to that folder, so one descriptor reads from Windows and from WSL. On a plain Docker engine (WSL, Linux) `up` makes
`host.docker.internal` resolve in the cluster's pods (a CoreDNS entry for the kind network gateway); the host itself needs
an entry for that name in its hosts file (Docker Desktop writes one with the LAN address; on a plain engine `127.0.0.1`
does). The tenant plane's browser origin is `https://e2e.lvh.me:7443`, a loopback TLS front with a development certificate
(the tenant's realm sign-in service accepts client redirects only over https).

### On the hive laptop

Docker, kind and kubectl live in the laptop's WSL distro, so the stack and the orchestrator run there (dev-kit
`hive.cmd run --wsl`), Plexus's spec on Windows. The stack folder is the Windows profile's (`--env
PRAGMATIC_E2E_STACK_DIR=/mnt/c/Users/visor/.pragmatic/e2e-stack` for `up` and `down`), and Plexus is told
`PLEXUS_E2E_STACK=C:\Users\visor\.pragmatic\e2e-stack\stack.json`, `PRAGMATIC_E2E_WSL_DISTRO=hive` and
`PRAGMATIC_E2E_REPO=/root/work/architecture-agent/pragmatic-e2e`. The full command list is in dev-kit
`docs/superpowers/plans/2026-11-21-hive-laptop-live-loop.md`.

## The journey (stage F)

`npm run journey` drives the deployed platform as a synthetic customer per hive path (`enrolled`, `delegated`,
`hosted`): website → cabinet registration → central login sign-up (the verification email is opened by the
`journey-mail` Email Worker) → Paddle **sandbox** checkout → … → Plexus and deploy, then cleans every leg it started
in reverse order (also after a failure). Legs whose live dependencies are not there yet are reported **pending** on
what delivers them (`src/journey/journey.config.json` `liveDependencies`); they never pass by default. Design and
legs: dev-kit `docs/superpowers/plans/2026-11-20-f-journey-tests.md`; what it touches and how to clean by hand:
pragmatic-infrastructure `runbooks/journey-tests.md`.

```
npm run journey -- --paths enrolled          # a new run (default: all three paths)
npm run journey -- resume <run id>           # continue a killed run, then clean
npm run journey:clean -- <run id>            # only clean a killed run
```

Ctrl-C, SIGTERM or SIGHUP stops a run gracefully (the running leg is aborted, the path still cleaned); a hard kill needs
`journey:clean`. `resume` continues the unfinished paths of a killed run; a resume or clean writes its own
`journey-report.<mode>-<time>.{json,md}` beside the run's report.

It needs `PRAGMATIC_JOURNEY_PASSWORD_SEED_FILE` (the test-only seed the customers' passwords derive from; never the
password itself) and Playwright's full Chromium (`npx playwright install chromium`; the headless shell starves Mural's
rendering). Each run writes `journey-runs/<run id>/` (gitignored): per path `context.json` (ids and states, never a
secret), `steps.log` (redacted), failure screenshots of allow-listed public pages only, and `journey-report.{json,md}`.
On the hive laptop: `hive.cmd run --wsl <this checkout> --env
PRAGMATIC_JOURNEY_PASSWORD_SEED_FILE=/mnt/c/Users/visor/.pragmatic/journey/password-seed --fetch journey-runs -- npm run
journey -- --paths enrolled`.

## License

Apache-2.0.
