# pragmatic-e2e

The platform's cross-container test harness. It holds what spans two or more container repositories, so no single
container repository can own it. Seeded from pragmatic-server (dev-kit plan A3, the container split); it releases nothing.

| Folder | What |
|---|---|
| `src/live-loop/` | The Plexus runtime live-loop stack (`live-loop-stack.ts up/down`) and its orchestrator (`loop-orchestrator.ts`), which `up` bakes the dev images it runs (`src/dev/dev-images.ts`: env server, UI unpack, hive agent, tenant IdP) from their
container repositories' checkouts in `PRAGMATIC_E2E_REPOS_DIR`, then loads them onto its kind node; see
`src/dev/README.md` ("Dev images").

Plexus's e2e spawns |
| `src/dev/` | The durable local dev stack (`dev-up.sh`, `dev-seed.sh`, `dev-down.sh`, the dev kind cluster, the CA trust scripts) |
| `src/smoke/` | Operator-run smokes against Docker, kind and live consoles (not `*.test.ts`; each file says how to run it) |
| `src/e2e/` | Tests that span containers: the consoles (platform admin, tenant admin, edge, IdP), the env cluster (env server and gateway) and the capstones |
| `src/stack/` | `RepositoryRoots` (where the services' checkouts are) and `SiblingCheckouts` (the pinned sources the tests import) |

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

Plexus's e2e spawns `src/live-loop/loop-orchestrator.ts` from `PRAGMATIC_E2E_REPO` (default: the `pragmatic-e2e`
checkout beside Plexus), so this repository needs `npm ci` and `npm run siblings` done there.

## License

Apache-2.0.
