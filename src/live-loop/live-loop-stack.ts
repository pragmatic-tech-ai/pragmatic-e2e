/**
 * OPERATOR-RUN test stack for the Plexus runtime live-loop e2e (NOT a *.test.ts, never run by CI). It stands up what a
 * customer has, apart from the developer's own data:
 *
 *   - the dev images it runs (env server, UI unpack, hive agent, tenant IdP) baked from their container repositories
 *     (src/dev/dev-images.ts);
 *   - a kind cluster `pragmatic-e2e` (host ports 443 and the in-cluster registry's node port mapped, ingress-nginx with SSL
 *     passthrough, the env server, UI unpack, hive agent, registry and Postgres images loaded);
 *   - both admin portals rebuilt (pragmatic-platform-admin's `portal`, pragmatic-tenant-admin's `tenant-portal`), since the
 *     console serves their `dist` folders;
 *   - the platform admin console (role `admin`) on :7000 (operator), :7100 (tenant plane) and :7002 (internal API, loopback),
 *     started from pragmatic-platform-admin's source, its state in ~/.pragmatic/e2e-stack/data;
 *   - a TLS front for the tenant plane on loopback :7443 (https://e2e.lvh.me:7443, a development certificate), because the
 *     tenant's realm sign-in service accepts a client redirect only over https (tenant-plane-tls-front.ts);
 *   - the platform edge on :7001 (agent channel), started from pragmatic-platform-edge's source, answering through the
 *     console's internal API (a shared secret in an owner-only file of the stack folder);
 *   - client `e2e-client`, tenant `e2e` (owner `o@t.io`, its IdP container) and hive `e2e-hive` attached to the kind cluster,
 *     with its agent installed (as the operator's install button does) and checked in;
 *   - one owner sign-in through the tenant plane, as the owner would; the one-time password stays the owner's.
 *
 * `up` writes stack.json in the stack folder (~/.pragmatic/e2e-stack, or PRAGMATIC_E2E_STACK_DIR) with addresses, emails
 * and password FILE paths relative to that folder, for the live-loop orchestrator and the Plexus spec; `down` stops the control plane, removes the IdP container and volume, deletes the kind
 * cluster and the stack folder. Passwords are written to files in the stack folder only: never printed or logged.
 *
 *   npx tsx src/live-loop/live-loop-stack.ts up|down
 *
 * The services run from the sibling checkouts under PRAGMATIC_E2E_REPOS_DIR (default: the folder this repository sits in),
 * each with its own `npm ci` done: pragmatic-platform-admin, pragmatic-platform-edge and pragmatic-tenant-admin (for its
 * portal); the images are baked from the checkouts of pragmatic-env-server, pragmatic-ui-unpack, pragmatic-hive-agent and
 * pragmatic-tenant-idp there (with the .npmrc PRAGMATIC_E2E_NPMRC names, default ~/.npmrc). Requires docker with buildx,
 * kind and kubectl on PATH, free host ports 443, 30500, 7000, 7001, 7002, 7100 and 7443, and the Playwright Chromium browser.
 * On a plain Docker engine (WSL, Linux) `up` adds host.docker.internal to the cluster's CoreDNS (KindHostAlias); Docker
 * Desktop answers that name itself.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { InClusterRegistry, NetPortProbe } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { RepositoryRoots } from '../stack/repository-roots.js'
import { DevImages } from '../dev/dev-images.js'
import { KindCli } from '../../repos/pragmatic-platform-admin/src/kind.js'
import { IdpContainerEnv } from '../../repos/pragmatic-platform-admin/src/idp-container-env.js'
import { NodeExecFile } from '@pragmatic-tech-ai/pragmatic-kube'
import { ReleaseApp } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { DevCa } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import { KindHostAlias } from './kind-host-alias.js'
import { TenantPlaneTlsFront } from './tenant-plane-tls-front.js'
import { ProcessTree } from './process-tree.js'
import { type IOperatorApi, OperatorApiClient } from './operator-api-client.js'
import { TenantOwnerSession } from './tenant-owner-session.js'

/**
 * What `up` hands the orchestrator and the Plexus spec; secrets are FILE paths, never values. On disk every file path is
 * relative to the descriptor's folder (forward slashes), so a reader on another OS view of the same folder (Windows reading
 * what `up` wrote in WSL) resolves it; ReadDescriptor answers them absolute.
 */
export type LiveLoopStackDescriptor = {
    platformAddress: string
    tenantPlaneOrigin: string
    tenant: string
    hive: string
    kubeContext: string
    ownerEmail: string
    ownerPasswordFile: string
    operatorEmail: string
    operatorPasswordFile: string
    idpCaFile: string
    /** The IdP's server certificate: the e2e's browser IdP login trusts exactly its public key (no OS trust needed). */
    idpCertFile: string
    /** How the e2e signs in at the IdP: its login is a JavaScript page, so a (headless) browser. */
    idpLogin: string
    dataRoot: string
}

/** The fixed names and test credentials of the stack (short fake emails; passwords meet the 12-character policy). */
export class LiveLoopStackNames
{
    public static readonly ClusterName = 'pragmatic-e2e'
    public static readonly KubeContext = 'kind-pragmatic-e2e'
    public static readonly ClientId = 'e2e-client'
    public static readonly TenantId = 'e2e'
    public static readonly HiveId = 'e2e-hive'
    public static readonly OwnerEmail = 'o@t.io'
    public static readonly OperatorEmail = 'op@t.io'
    public static readonly OperatorPort = 7000
    public static readonly TenantPlanePort = 7100
    /** The agent channel the hive agent dials home to; its pods reach this machine at http://host.docker.internal:<port>. */
    public static readonly AgentChannelPort = 7001
    /** The console's internal API the edge answers through (loopback only). */
    public static readonly InternalApiPort = 7002
    public static readonly InternalApiBase = 'http://127.0.0.1:7002'
    public static readonly EdgeBase = 'http://127.0.0.1:7001'
    public static readonly TenantBaseDomain = 'lvh.me'
    public static readonly PlatformAddress = 'http://localhost:7000'
    public static readonly OperatorBase = 'http://127.0.0.1:7000'
    /** The tenant plane's browser origin: the TLS front (the realm sign-in service accepts only https redirects). */
    public static readonly TenantPlaneTlsPort = 7443
    public static readonly TenantHost = 'e2e.lvh.me'
    public static readonly TenantPlaneOrigin = 'https://e2e.lvh.me:7443'
    /** Where the stack keeps its state; a folder both sides read when the stack runs in WSL and Plexus on Windows. */
    public static readonly StackDirEnvVar = 'PRAGMATIC_E2E_STACK_DIR'
    public static readonly DefaultStackDir = join(homedir(), '.pragmatic', 'e2e-stack')
    public static readonly StackDir = LiveLoopStackNames.StackDirOf(process.env)
    public static readonly DescriptorFile = 'stack.json'
    /** The developer's GHCR read credential (`{ username, token }`); when present, platform admin's release catalogue uses it. */
    public static readonly ReleaseCredentialFile = join(homedir(), '.pragmatic', 'ghcr-read.json')
    public static readonly ReleaseCredentialEnvVar = 'PRAGMATIC_RELEASE_CREDENTIAL_FILE'

    /** The stack folder `env` names: PRAGMATIC_E2E_STACK_DIR (resolved) when set and not blank, else ~/.pragmatic/e2e-stack. */
    public static StackDirOf(env: NodeJS.ProcessEnv): string
    {
        const raw = env[LiveLoopStackNames.StackDirEnvVar]?.trim() ?? ''
        return raw === '' ? LiveLoopStackNames.DefaultStackDir : resolve(raw)
    }
}

/** The operator's seed, as dev-seed.sh does it: client, tenant (its IdP comes up here) and the attached hive. Returns the owner's one-time password. */
export class LiveLoopStackSeed
{
    private static readonly MethodPost = 'POST'
    private static readonly ClientsPath = '/api/clients'
    private static readonly TenantsPath = '/api/tenants'
    private static readonly HivesPath = '/api/hives'
    private static readonly StatusCreated = 201
    private static readonly OwnerKey = 'owner'
    private static readonly PasswordKey = 'password'
    private static readonly LocalBackend = 'local'
    private static readonly AttachMode = 'attach'
    private static readonly ClientName = 'E2E Client'
    private static readonly TenantName = 'E2E'
    private static readonly HiveName = 'E2E Hive'
    private static readonly FailedPrefix = 'seed step failed: '
    private static readonly StatusWord = ' status '

    public constructor(private readonly api: IOperatorApi)
    {
    }

    public async Seed(): Promise<string>
    {
        const S = LiveLoopStackSeed
        const N = LiveLoopStackNames
        await this.Expect(S.ClientsPath, { id: N.ClientId, displayName: S.ClientName })
        const tenant = await this.Expect(S.TenantsPath, { id: N.TenantId, clientId: N.ClientId, displayName: S.TenantName, ownerEmail: N.OwnerEmail })
        const owner = tenant[S.OwnerKey] as Record<string, unknown> | undefined
        const password = owner?.[S.PasswordKey]
        if (typeof password !== 'string' || password.length === 0)
        {
            throw new Error(S.FailedPrefix + S.TenantsPath)
        }
        await this.Expect(S.HivesPath, {
            id: N.HiveId, tenantId: N.TenantId, displayName: S.HiveName,
            cluster: { backend: S.LocalBackend, mode: S.AttachMode, configRef: N.KubeContext },
            // Attach with no endpoint: the hive pulls the images the stack preloaded into the kind node (the passing in-cluster smokes do the same).
            registry: { mode: S.AttachMode },
        })
        return password
    }

    private async Expect(path: string, body: unknown): Promise<Record<string, unknown>>
    {
        const S = LiveLoopStackSeed
        const answer = await this.api.Call(S.MethodPost, path, body)
        if (answer.status !== S.StatusCreated)
        {
            throw new Error(S.FailedPrefix + path + S.StatusWord + String(answer.status))
        }
        return answer.body ?? {}
    }
}

/** How long the agent install is polled, and how often. */
export interface AgentInstallTiming
{
    pollMs: number
    deadlineMs: number
}

/**
 * Installs the hive agent the way the operator's "install agent" button does (POST /api/hives/ID/agent-install), then
 * polls the install until the agent has dialed home, so the hive shows as checked in. Fails with the installer's own
 * error, or when the hive has not checked in by the deadline.
 */
export class LiveLoopStackAgent
{
    public static readonly DefaultTiming: AgentInstallTiming = { pollMs: 2_000, deadlineMs: 600_000 }
    private static readonly MethodPost = 'POST'
    private static readonly MethodGet = 'GET'
    private static readonly HivesPrefix = '/api/hives/'
    private static readonly InstallSuffix = '/agent-install'
    private static readonly StatusAccepted = 202
    private static readonly StatusOk = 200
    private static readonly StateKey = 'state'
    private static readonly StepKey = 'step'
    private static readonly ErrorKey = 'error'
    private static readonly Connected = 'connected'
    private static readonly Failed = 'failed'
    private static readonly NotStartedPrefix = 'hive agent install did not start: status '
    private static readonly FailedPrefix = 'hive agent install failed at '
    private static readonly TimeoutPrefix = 'hive agent did not check in in time; last step '
    private static readonly Separator = ': '

    public constructor(private readonly api: IOperatorApi, private readonly timing: AgentInstallTiming = LiveLoopStackAgent.DefaultTiming)
    {
    }

    public async Install(): Promise<void>
    {
        const A = LiveLoopStackAgent
        const path = A.HivesPrefix + encodeURIComponent(LiveLoopStackNames.HiveId) + A.InstallSuffix
        const started = await this.api.Call(A.MethodPost, path)
        if (started.status !== A.StatusAccepted)
        {
            throw new Error(A.NotStartedPrefix + String(started.status) + A.Separator + String(started.body?.[A.ErrorKey] ?? ''))
        }
        const deadline = Date.now() + this.timing.deadlineMs
        let step = String(started.body?.[A.StepKey] ?? '')
        while (Date.now() < deadline)
        {
            await new Promise<void>(done => setTimeout(done, this.timing.pollMs))
            const status = await this.api.Call(A.MethodGet, path)
            if (status.status !== A.StatusOk)
            {
                continue
            }
            step = String(status.body?.[A.StepKey] ?? step)
            const state = status.body?.[A.StateKey]
            if (state === A.Connected)
            {
                return
            }
            if (state === A.Failed)
            {
                throw new Error(A.FailedPrefix + step + A.Separator + String(status.body?.[A.ErrorKey] ?? ''))
            }
        }
        throw new Error(A.TimeoutPrefix + step)
    }
}

/** Runs one command in a directory and answers its exit code. */
export interface IPortalBuildRunner
{
    Run(command: string, args: readonly string[], cwd: string): Promise<number>
}

/** Runs npm through the shell (npm is a .cmd on Windows); the build output goes to this console. */
export class ShellPortalBuildRunner implements IPortalBuildRunner
{
    private static readonly ExitEvent = 'exit'
    private static readonly ErrorEvent = 'error'
    private static readonly InheritStdio = 'inherit'
    private static readonly FailedExit = 1

    public Run(command: string, args: readonly string[], cwd: string): Promise<number>
    {
        const R = ShellPortalBuildRunner
        return new Promise(done =>
        {
            const child = spawn(command, [...args], { cwd, shell: true, stdio: R.InheritStdio, windowsHide: true })
            child.on(R.ErrorEvent, () => done(R.FailedExit))
            child.on(R.ExitEvent, code => done(code ?? R.FailedExit))
        })
    }
}

/**
 * Rebuilds the two admin portals before the console starts. The console serves them from their `dist` folders, so
 * without this a stack serves whatever was last built (on 2026-11-14 a three-day-old tenant admin without the
 * catalog-backed roles editor).
 */
export class LiveLoopPortalBuild
{
    private static readonly Npm = 'npm'
    private static readonly BuildArgs: readonly string[] = ['run', 'build']
    private static readonly FailedPrefix = 'admin portal build failed: '
    private static readonly ExitWord = ' exited '

    public constructor(private readonly runner: IPortalBuildRunner = new ShellPortalBuildRunner())
    {
    }

    /** Builds each portal folder in order; the first failure stops it, naming the portal folder and the exit code. */
    public async Build(portalDirs: readonly string[]): Promise<void>
    {
        const P = LiveLoopPortalBuild
        for (const dir of portalDirs)
        {
            const code = await this.runner.Run(P.Npm, P.BuildArgs, dir)
            if (code !== 0)
            {
                throw new Error(P.FailedPrefix + basename(dir) + P.ExitWord + String(code))
            }
        }
    }
}

/** How one stack service starts: a script of its repository run by that repository's own `tsx`. */
export interface LiveLoopServiceSpec
{
    /** The script, relative to the repository root. */
    script: string
    /** The repository root (the working directory). */
    cwd: string
    /** That repository's tsx CLI. */
    tsxCli: string
    env: NodeJS.ProcessEnv
}

/** One service down stops: its pid file, the URL it answers while up and the port it holds. */
export interface LiveLoopServiceStop
{
    pidFile: string
    url: string
    port: number
}

/**
 * The services the stack starts, each from its own repository (RepositoryRoots): the platform admin console (role
 * `admin`, with its internal API on loopback) and the platform edge (the agent channel the hive agent dials home to),
 * which answers through that internal API with the shared secret file.
 */
export class LiveLoopServices
{
    public static readonly PlatformAdmin = 'pragmatic-platform-admin'
    public static readonly PlatformEdge = 'pragmatic-platform-edge'
    public static readonly TenantAdmin = 'pragmatic-tenant-admin'
    public static readonly ConsoleScript = join('src', 'server.ts')
    public static readonly EdgeScript = join('src', 'bin', 'pragmatic-platform-edged.ts')
    public static readonly TsxCliRelative: readonly string[] = ['node_modules', 'tsx', 'dist', 'cli.mjs']
    public static readonly PortalDir = 'portal'
    public static readonly TenantPortalDir = 'tenant-portal'
    public static readonly DistDir = 'dist'
    public static readonly AdminRole = 'admin'
    public static readonly LoopbackBind = '127.0.0.1'
    public static readonly AnyBind = '0.0.0.0'
    private static readonly FalseValue = 'false'
    private static readonly HttpsScheme = 'https'
    private static readonly TrueValue = 'true'
    public static readonly TlsFrontScript = join('src', 'live-loop', 'tenant-plane-tls-front.ts')

    public constructor(private readonly roots: RepositoryRoots)
    {
    }

    /** The portal folders the stack rebuilds, platform admin first. */
    public PortalDirs(): readonly string[]
    {
        const S = LiveLoopServices
        return [join(this.roots.Of(S.PlatformAdmin), S.PortalDir), join(this.roots.Of(S.TenantAdmin), S.TenantPortalDir)]
    }

    /** The console: operator :7000, tenant plane :7100 (serving pragmatic-tenant-admin's portal), internal API :7002. */
    public Console(base: NodeJS.ProcessEnv, dataRoot: string, databaseUrlFile: string, internalSecretFile: string, operatorPasswordFile: string): LiveLoopServiceSpec
    {
        const S = LiveLoopServices
        const N = LiveLoopStackNames
        const root = this.roots.Of(S.PlatformAdmin)
        return {
            script: S.ConsoleScript,
            cwd: root,
            tsxCli: join(root, ...S.TsxCliRelative),
            env: {
                ...base,
                ...LiveLoopStack.ReleaseEnv(base),
                PRAGMATIC_CONTROL_PLANE_ROLE: S.AdminRole,
                PRAGMATIC_ADMIN_DATA_ROOT: dataRoot,
                PRAGMATIC_ADMIN_DATABASE_URL_FILE: databaseUrlFile,
                PRAGMATIC_ADMIN_PORT: String(N.OperatorPort),
                PRAGMATIC_ADMIN_OPERATOR_EMAIL: N.OperatorEmail,
                PRAGMATIC_ADMIN_OPERATOR_PASSWORD_FILE: operatorPasswordFile,
                PRAGMATIC_ADMIN_SECURE_COOKIE: S.FalseValue,
                PRAGMATIC_ADMIN_INTERNAL_PORT: String(N.InternalApiPort),
                PRAGMATIC_ADMIN_INTERNAL_BIND: S.LoopbackBind,
                PRAGMATIC_INTERNAL_API_SECRET_FILE: internalSecretFile,
                PRAGMATIC_TENANT_ADMIN_PORT: String(N.TenantPlanePort),
                PRAGMATIC_TENANT_ADMIN_BASE_DOMAIN: N.TenantBaseDomain,
                // Browsers reach the tenant plane through the TLS front: the realm sign-in service accepts only https redirects.
                PRAGMATIC_TENANT_ADMIN_EXTERNAL_SCHEME: S.HttpsScheme,
                PRAGMATIC_TENANT_ADMIN_EXTERNAL_PORT: String(N.TenantPlaneTlsPort),
                // The front reports the browser's https in X-Forwarded-Proto (the Origin check compares scheme too). The tenant
                // listener is loopback-only, but any local account can reach loopback (on the hive laptop, Windows accounts
                // too, through WSL's localhost relay): it is a test stack with synthetic data and per-run secrets.
                PRAGMATIC_TENANT_ADMIN_TRUSTED_PROXY: S.TrueValue,
                PRAGMATIC_TENANT_PORTAL_DIR: join(this.roots.Of(S.TenantAdmin), S.TenantPortalDir, S.DistDir),
                // The console does not listen on the agent channel (the edge does); it still names it in hive bundles.
                PRAGMATIC_AGENT_CHANNEL_PORT: String(N.AgentChannelPort),
            },
        }
    }

    /** The edge: the agent channel on :7001 (all addresses, so the kind pods reach it), answered through the internal API. */
    public Edge(base: NodeJS.ProcessEnv, internalSecretFile: string): LiveLoopServiceSpec
    {
        const S = LiveLoopServices
        const N = LiveLoopStackNames
        const root = this.roots.Of(S.PlatformEdge)
        return {
            script: S.EdgeScript,
            cwd: root,
            tsxCli: join(root, ...S.TsxCliRelative),
            env: {
                ...base,
                PRAGMATIC_AGENT_CHANNEL_PORT: String(N.AgentChannelPort),
                PRAGMATIC_AGENT_CHANNEL_BIND: S.AnyBind,
                PRAGMATIC_EDGE_ADMIN_URL: N.InternalApiBase,
                PRAGMATIC_INTERNAL_API_SECRET_FILE: internalSecretFile,
            },
        }
    }

    /** The tenant plane's TLS front (this repository's script): https on loopback :7443 relayed to the console's :7100. */
    public TlsFront(base: NodeJS.ProcessEnv, certFile: string, keyFile: string): LiveLoopServiceSpec
    {
        const S = LiveLoopServices
        const N = LiveLoopStackNames
        return {
            script: S.TlsFrontScript,
            cwd: RepositoryRoots.OwnRoot,
            tsxCli: join(RepositoryRoots.OwnRoot, ...S.TsxCliRelative),
            env: {
                ...base,
                [TenantPlaneTlsFront.PortEnvVar]: String(N.TenantPlaneTlsPort),
                [TenantPlaneTlsFront.TargetPortEnvVar]: String(N.TenantPlanePort),
                [TenantPlaneTlsFront.CertFileEnvVar]: certFile,
                [TenantPlaneTlsFront.KeyFileEnvVar]: keyFile,
            },
        }
    }
}

export class LiveLoopStack
{
    private static readonly UpVerb = 'up'
    private static readonly DownVerb = 'down'
    private static readonly UsageMessage = 'usage: live-loop-stack.ts up|down'
    private static readonly HttpsPort = 443
    private static readonly PostgresImage = 'postgres:16'
    private static readonly Docker = 'docker'
    private static readonly Kubectl = 'kubectl'
    private static readonly ImageVerb = 'image'
    private static readonly InspectVerb = 'inspect'
    private static readonly PullVerb = 'pull'
    private static readonly RmVerb = 'rm'
    private static readonly ForceFlag = '-f'
    private static readonly VolumeVerb = 'volume'
    private static readonly ContextFlag = '--context'
    private static readonly IngressManifestUrl = 'https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.11.3/deploy/static/provider/kind/deploy.yaml'
    private static readonly IngressNamespace = 'ingress-nginx'
    private static readonly IngressDeployment = 'ingress-nginx-controller'
    private static readonly PassthroughPatch = '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--enable-ssl-passthrough"}]'
    private static readonly ControllerSelector = 'app.kubernetes.io/component=controller'
    private static readonly ApplyVerb = 'apply'
    private static readonly FileFlag = '-f'
    private static readonly PatchVerb = 'patch'
    private static readonly DeploymentKind = 'deployment'
    private static readonly DeploymentPrefix = 'deployment/'
    private static readonly NamespaceFlag = '-n'
    private static readonly TypeFlag = '--type'
    private static readonly JsonPatchType = 'json'
    private static readonly PatchFlag = '-p'
    private static readonly RolloutVerb = 'rollout'
    private static readonly StatusVerb = 'status'
    private static readonly WaitVerb = 'wait'
    private static readonly ReadyCondition = '--for=condition=ready'
    private static readonly PodKind = 'pod'
    private static readonly SelectorFlag = '--selector='
    private static readonly WaitTimeout = '--timeout=300s'
    private static readonly AppendFlag = 'a'
    /** The console's own Postgres for the stack (A5): a throwaway container on host loopback, removed with its volume by down. */
    private static readonly ConsolePostgresImage = 'postgres:17.12-trixie'
    private static readonly ConsolePostgresContainer = 'pragmatic-e2e-postgres'
    private static readonly ConsolePostgresPublish = '127.0.0.1:55434:5432'
    private static readonly ConsolePostgresUrlPrefix = 'postgres://platform_admin:'
    private static readonly ConsolePostgresUrlSuffix = '@127.0.0.1:55434/platform_admin\n'
    private static readonly ConsolePostgresEnv = ['-e', 'POSTGRES_USER=platform_admin', '-e', 'POSTGRES_DB=platform_admin', '-e', 'POSTGRES_PASSWORD_FILE=/run/secrets/password']
    private static readonly ConsolePostgresPasswordMount = ':/run/secrets/password:ro'
    private static readonly ExecVerb = 'exec'
    private static readonly PgIsReady = ['pg_isready', '--host=127.0.0.1', '--quiet']
    private static readonly ConsolePostgresPasswordFileName = 'postgres-password'
    private static readonly ConsolePostgresUrlFileName = 'postgres-url'
    private static readonly ConsolePostgresNotReadyMessage = 'the console Postgres did not become ready in time'
    private static readonly PasswordBytes = 24
    private static readonly InternalSecretBytes = 32
    private static readonly HexEncoding = 'hex'
    private static readonly RunVerb = 'run'
    private static readonly DetachFlag = '-d'
    private static readonly NameFlag = '--name'
    private static readonly PublishFlag = '-p'
    private static readonly VolumeFlag = '-v'
    private static readonly RemoveVolumesFlag = '-v'
    private static readonly IdpVolumePrefix = 'pragmatic-idp-data-'
    private static readonly DataDirName = 'data'
    private static readonly LogFileName = 'control-plane.log'
    private static readonly PidFileName = 'control-plane.pid'
    private static readonly EdgeLogFileName = 'edge.log'
    private static readonly EdgePidFileName = 'edge.pid'
    private static readonly TlsFrontLogFileName = 'tls-front.log'
    private static readonly TlsFrontPidFileName = 'tls-front.pid'
    private static readonly TlsFrontDirName = 'tls-front'
    private static readonly MarkerFileName = '.pragmatic-e2e-stack'
    private static readonly MarkerText = 'the live-loop stack folder: live-loop-stack.ts down deletes it\n'
    private static readonly NotAStackFolderPrefix = '[stack] kept (not a stack folder, no marker): '
    private static readonly Loopback = '127.0.0.1'
    private static readonly ConnectEvent = 'connect'
    private static readonly ErrorEvent = 'error'
    private static readonly TlsFrontExitedMessage = 'the tenant plane TLS front exited during start; see tls-front.log in the stack folder, then run down'
    private static readonly TlsFrontNotReadyMessage = 'the tenant plane TLS front did not listen in time; see tls-front.log in the stack folder, then run down'
    private static readonly InternalSecretFileName = 'internal-api-secret'
    private static readonly OwnerPasswordFileName = 'owner-password'
    private static readonly OperatorPasswordFileName = 'operator-password'
    private static readonly IdpTlsRelative = ['idp', LiveLoopStackNames.TenantId, 'tls']
    private static readonly IdpCaFileName = 'ca.crt'
    private static readonly IdpCertFileName = 'server.crt'
    private static readonly BrowserLogin = 'browser'
    private static readonly PingPath = '/api/ping'
    private static readonly HealthzPath = '/healthz'
    private static readonly PingDeadlineMs = 180_000
    private static readonly PollMs = 2_000
    private static readonly Utf8 = 'utf8'
    private static readonly PortableSeparator = '/'
    /** The descriptor's keys that hold file or folder paths. */
    private static readonly FileKeys = ['ownerPasswordFile', 'operatorPasswordFile', 'idpCaFile', 'idpCertFile', 'dataRoot'] as const
    private static readonly GetVerb = 'get'
    private static readonly OutputFlag = '-o'
    private static readonly ArgsJsonPath = 'jsonpath={.spec.template.spec.containers[0].args}'
    private static readonly PassthroughArg = '--enable-ssl-passthrough'
    private static readonly OwnerOnlyMode = 0o600
    private static readonly Redacted = '***'
    private static readonly PortBusyPrefix = 'port '
    private static readonly PortBusySuffix = ' is in use (is another control plane, e.g. dev-up.sh, running?); stop it before bringing the e2e stack up'
    private static readonly ExitedMessage = 'the control plane exited during start; see the log in the stack folder'
    private static readonly EdgeExitedMessage = 'the platform edge exited during start; see edge.log in the stack folder, then run down (the console is still up)'
    private static readonly EdgeNotReadyMessage = 'the platform edge did not answer /healthz in time; see edge.log in the stack folder, then run down (the console is still up)'
    private static readonly AlreadyUpMessage = 'the e2e stack is already up (stack.json exists); run down first'
    private static readonly NotReadyMessage = 'the control plane did not answer /api/ping in time; see the log in the stack folder'
    private static readonly Steps = {
        Images: '[stack] dev images baked from their repositories (env server, UI unpack, hive agent, tenant IdP)',
        Cluster: '[stack] kind cluster pragmatic-e2e (443 + registry node port) and images',
        Ingress: '[stack] ingress-nginx with SSL passthrough',
        HostAlias: '[stack] pods reach this machine as host.docker.internal (CoreDNS entry for the kind network gateway; not Docker Desktop)',
        Portals: '[stack] admin portals rebuilt (platform admin, tenant admin)',
        Postgres: '[stack] the console Postgres on 127.0.0.1:55434 (container pragmatic-e2e-postgres)',
        ControlPlane: '[stack] platform admin console on :7000 / :7100, internal API :7002 (records in its Postgres, files in the stack folder)',
        Edge: '[stack] platform edge: agent channel :7001, answered through the internal API of the console',
        TlsFront: '[stack] tenant plane TLS front: https://e2e.lvh.me:7443 relayed to :7100 (development certificate in the stack folder)',
        Seed: '[stack] operator seed: client, tenant e2e (IdP), hive e2e-hive',
        Agent: '[stack] hive agent install; the hive checks in over the agent channel on :7001',
        Owner: '[stack] owner sign-in and short test password',
        Done: '[stack] up; descriptor written to ',
        Down: '[stack] down',
    }

    private readonly exec = new NodeExecFile()
    private readonly secrets: string[] = []
    private readonly kind = new KindCli(new NodeExecFile(), new NodeExecFile(KindCli.ImageLoadTimeoutMs))
    private readonly services: LiveLoopServices
    private readonly images: DevImages

    public constructor(
        roots: RepositoryRoots = RepositoryRoots.FromEnvironment(process.env),
        images: DevImages = new DevImages(roots, DevImages.NpmrcOf(process.env)))
    {
        this.services = new LiveLoopServices(roots)
        this.images = images
    }

    /** The dev images up bakes: the live loop's, or none when `env` skips the bake (PRAGMATIC_DEV_SKIP_IMAGE_BAKE=1, the images are fresh). */
    public static ImagesToBake(env: NodeJS.ProcessEnv): readonly ReleaseApp[]
    {
        return DevImages.SkipsBake(env) ? [] : DevImages.LiveLoopApps
    }

    /** What up loads onto the kind node: the dev images the hive's pods run (the tenant IdP runs in local docker; every
     *  environment pod runs the env server beside its own pragmatic-postgres, A5), the in-cluster registry and the
     *  templates' data-source Postgres. */
    public static KindImages(): readonly string[]
    {
        const environments = [DevImages.TagOf(ReleaseApp.EnvServer), DevImages.TagOf(ReleaseApp.UiUnpack), DevImages.TagOf(ReleaseApp.HiveAgent), DevImages.TagOf(ReleaseApp.Postgres)]
        return [...environments, InClusterRegistry.Image, LiveLoopStack.PostgresImage]
    }

    public static async Main(): Promise<void>
    {
        const verb = process.argv[2]
        const stack = new LiveLoopStack()
        try
        {
            if (verb === LiveLoopStack.UpVerb)
            {
                await stack.Up()
            }
            else if (verb === LiveLoopStack.DownVerb)
            {
                await stack.Down()
            }
            else
            {
                throw new Error(LiveLoopStack.UsageMessage)
            }
        }
        catch (err)
        {
            // Any failure (a Playwright sign-in error included) is redacted before it can reach the console.
            throw new Error(stack.Redact(err instanceof Error ? err.message : String(err)))
        }
    }

    /**
     * The release-catalogue setting the control plane starts with: an explicitly set PRAGMATIC_RELEASE_CREDENTIAL_FILE wins;
     * otherwise the developer's GHCR read credential when that file exists; otherwise nothing (Refresh then answers 409).
     */
    public static ReleaseEnv(env: NodeJS.ProcessEnv, exists: (path: string) => boolean = existsSync): NodeJS.ProcessEnv
    {
        const N = LiveLoopStackNames
        const explicit = env[N.ReleaseCredentialEnvVar]
        if (explicit !== undefined && explicit !== '')
        {
            return {}
        }
        return exists(N.ReleaseCredentialFile) ? { [N.ReleaseCredentialEnvVar]: N.ReleaseCredentialFile } : {}
    }

    public static DescriptorPath(): string
    {
        return join(LiveLoopStackNames.StackDir, LiveLoopStackNames.DescriptorFile)
    }

    /** The descriptor at `path` with its file paths absolute, resolved against that file's folder (absolute ones stay). */
    public static ReadDescriptor(path: string = LiveLoopStack.DescriptorPath()): LiveLoopStackDescriptor
    {
        const stored = JSON.parse(readFileSync(path, LiveLoopStack.Utf8)) as LiveLoopStackDescriptor
        return LiveLoopStack.MapFiles(stored, file => resolve(dirname(path), file))
    }

    /** Pure: the descriptor as written, every file path relative to `stackDir` with forward slashes. */
    public static Portable(descriptor: LiveLoopStackDescriptor, stackDir: string): LiveLoopStackDescriptor
    {
        return LiveLoopStack.MapFiles(descriptor, file => relative(stackDir, file).split(sep).join(LiveLoopStack.PortableSeparator))
    }

    private static MapFiles(descriptor: LiveLoopStackDescriptor, map: (file: string) => string): LiveLoopStackDescriptor
    {
        const out = { ...descriptor }
        for (const key of LiveLoopStack.FileKeys)
        {
            out[key] = map(descriptor[key])
        }
        return out
    }

    public async Up(): Promise<void>
    {
        const L = LiveLoopStack
        const N = LiveLoopStackNames
        if (existsSync(L.DescriptorPath()))
        {
            throw new Error(L.AlreadyUpMessage)
        }
        const dataRoot = join(N.StackDir, L.DataDirName)
        mkdirSync(dataRoot, { recursive: true })
        writeFileSync(join(N.StackDir, L.MarkerFileName), L.MarkerText, L.Utf8)

        console.log(L.Steps.Images)
        await this.images.Build(LiveLoopStack.ImagesToBake(process.env))

        console.log(L.Steps.Cluster)
        if (!(await this.kind.ListClusters()).includes(N.ClusterName))
        {
            await this.kind.CreateCluster(N.ClusterName, { extraPortMappings: [L.HttpsPort, InClusterRegistry.NodePort] })
        }
        for (const image of L.KindImages())
        {
            await this.EnsureLocalImage(image)
            await this.kind.LoadImage(image, N.ClusterName)
        }

        console.log(L.Steps.Ingress)
        await this.Kubectl([L.ApplyVerb, L.FileFlag, L.IngressManifestUrl])
        // Patch only when passthrough is not on yet: a re-run of up after a partial failure reuses the cluster.
        const args = await this.Kubectl([L.GetVerb, L.DeploymentKind, L.IngressDeployment, L.NamespaceFlag, L.IngressNamespace, L.OutputFlag, L.ArgsJsonPath])
        if (!args.includes(L.PassthroughArg))
        {
            await this.Kubectl([L.PatchVerb, L.DeploymentKind, L.IngressDeployment, L.NamespaceFlag, L.IngressNamespace, L.TypeFlag, L.JsonPatchType, L.PatchFlag, L.PassthroughPatch])
        }
        await this.Kubectl([L.RolloutVerb, L.StatusVerb, L.DeploymentPrefix + L.IngressDeployment, L.NamespaceFlag, L.IngressNamespace, L.WaitTimeout])
        await this.Kubectl([L.WaitVerb, L.NamespaceFlag, L.IngressNamespace, L.ReadyCondition, L.PodKind, L.SelectorFlag + L.ControllerSelector, L.WaitTimeout])

        if (await new KindHostAlias(N.KubeContext).Ensure())
        {
            console.log(L.Steps.HostAlias)
        }

        console.log(L.Steps.Portals)
        await new LiveLoopPortalBuild().Build(this.services.PortalDirs())

        console.log(L.Steps.ControlPlane)
        // A fresh operator password per run (the console reads it from the file), never one in source.
        const operatorPassword = randomBytes(L.PasswordBytes).toString(L.HexEncoding)
        this.HoldSecret(operatorPassword)
        const operatorPasswordFile = join(N.StackDir, L.OperatorPasswordFileName)
        writeFileSync(operatorPasswordFile, operatorPassword, { encoding: L.Utf8, mode: L.OwnerOnlyMode })
        await this.RequireFreePorts()
        console.log(L.Steps.Postgres)
        const databaseUrlFile = await this.StartConsolePostgres()
        const internalSecretFile = this.WriteInternalSecret()
        await this.WaitForPing(this.StartService(this.services.Console(process.env, dataRoot, databaseUrlFile, internalSecretFile, operatorPasswordFile), L.LogFileName, L.PidFileName))
        console.log(L.Steps.Edge)
        await this.WaitForEdge(this.StartService(this.services.Edge(process.env, internalSecretFile), L.EdgeLogFileName, L.EdgePidFileName))
        console.log(L.Steps.TlsFront)
        const front = DevCa.EnsureAt(join(N.StackDir, L.TlsFrontDirName), N.TenantHost)
        await this.WaitForPort(this.StartService(this.services.TlsFront(process.env, front.certFile, front.keyFile), L.TlsFrontLogFileName, L.TlsFrontPidFileName),
            N.TenantPlaneTlsPort, L.TlsFrontExitedMessage, L.TlsFrontNotReadyMessage)

        console.log(L.Steps.Seed)
        const api = new OperatorApiClient(N.OperatorBase)
        await api.Login(N.OperatorEmail, operatorPassword)
        const oneTime = await new LiveLoopStackSeed(api).Seed()
        this.HoldSecret(oneTime)

        console.log(L.Steps.Agent)
        await new LiveLoopStackAgent(api).Install()

        // The owner signs in once through the tenant plane (proving the realm sign-in); the console no longer changes a realm
        // password (the realm's sign-in service owns it), so the one-time password stays the owner's, kept in an owner-only file.
        console.log(L.Steps.Owner)
        const owner = await TenantOwnerSession.Open(N.TenantPlaneOrigin, N.OwnerEmail, oneTime)
        await owner.Close()
        const ownerPasswordFile = join(N.StackDir, L.OwnerPasswordFileName)
        writeFileSync(ownerPasswordFile, oneTime, { encoding: L.Utf8, mode: L.OwnerOnlyMode })

        const descriptor: LiveLoopStackDescriptor = {
            platformAddress: N.PlatformAddress,
            tenantPlaneOrigin: N.TenantPlaneOrigin,
            tenant: N.TenantId,
            hive: N.HiveId,
            kubeContext: N.KubeContext,
            ownerEmail: N.OwnerEmail,
            ownerPasswordFile,
            operatorEmail: N.OperatorEmail,
            operatorPasswordFile,
            idpCaFile: join(dataRoot, ...L.IdpTlsRelative, L.IdpCaFileName),
            idpCertFile: join(dataRoot, ...L.IdpTlsRelative, L.IdpCertFileName),
            idpLogin: L.BrowserLogin,
            dataRoot,
        }
        writeFileSync(L.DescriptorPath(), JSON.stringify(L.Portable(descriptor, N.StackDir), null, 2), L.Utf8)
        console.log(L.Steps.Done + L.DescriptorPath())
    }

    /**
     * The docker commands down runs, in order: the console's Postgres (with its anonymous volume), the tenant IdP's companion
     * Postgres before the IdP (it lives in the IdP's network namespace and mounts the IdP's data volume), then both volumes.
     * Names come from the console's own IdP driver, so they cannot drift from what it created.
     */
    public static DownDockerSteps(): readonly (readonly string[])[]
    {
        const L = LiveLoopStack
        const idp = IdpContainerEnv.ContainerName(LiveLoopStackNames.TenantId)
        const volume = L.IdpVolumePrefix + LiveLoopStackNames.TenantId
        return [
            [L.RmVerb, L.ForceFlag, L.RemoveVolumesFlag, L.ConsolePostgresContainer],
            [L.RmVerb, L.ForceFlag, IdpContainerEnv.PostgresContainerName(idp)],
            [L.RmVerb, L.ForceFlag, idp],
            [L.VolumeVerb, L.RmVerb, L.ForceFlag, IdpContainerEnv.PostgresVolumeName(volume)],
            [L.VolumeVerb, L.RmVerb, L.ForceFlag, volume],
        ]
    }

    /**
     * Best effort, every step on its own: stop the front, the edge and the console, remove the containers and volumes, delete
     * the cluster, then the stack folder, but only when it is one (the default folder, or one holding the stack's marker): a
     * mistyped PRAGMATIC_E2E_STACK_DIR naming a parent folder is never wiped.
     */
    public async Down(): Promise<void>
    {
        const L = LiveLoopStack
        const N = LiveLoopStackNames
        console.log(L.Steps.Down)
        for (const stop of LiveLoopStack.StopPlan())
        {
            await this.StopService(stop)
        }
        for (const args of L.DownDockerSteps())
        {
            await this.BestEffort(() => this.exec.Run(L.Docker, args))
        }
        await this.BestEffort(() => this.kind.DeleteCluster(N.ClusterName))
        if (LiveLoopStack.IsStackFolder(N.StackDir))
        {
            await this.BestEffort(async () => rmSync(N.StackDir, { recursive: true, force: true }))
        }
        else if (existsSync(N.StackDir))
        {
            console.log(L.NotAStackFolderPrefix + N.StackDir)
        }
    }

    /**
     * Starts the console's Postgres (a fresh container, its password and URL files in the stack folder, owner-only) and
     * answers the URL file once the server accepts connections.
     */
    private async StartConsolePostgres(): Promise<string>
    {
        const L = LiveLoopStack
        const N = LiveLoopStackNames
        const password = randomBytes(L.PasswordBytes).toString(L.HexEncoding)
        this.HoldSecret(password)
        const passwordFile = join(N.StackDir, L.ConsolePostgresPasswordFileName)
        writeFileSync(passwordFile, password, { encoding: L.Utf8, mode: L.OwnerOnlyMode })
        await this.EnsureLocalImage(L.ConsolePostgresImage)
        await this.BestEffort(() => this.exec.Run(L.Docker, [L.RmVerb, L.ForceFlag, L.RemoveVolumesFlag, L.ConsolePostgresContainer]))
        await this.exec.Run(L.Docker, [L.RunVerb, L.DetachFlag, L.NameFlag, L.ConsolePostgresContainer, L.PublishFlag, L.ConsolePostgresPublish,
            ...L.ConsolePostgresEnv, L.VolumeFlag, passwordFile + L.ConsolePostgresPasswordMount, L.ConsolePostgresImage])
        const deadline = Date.now() + L.PingDeadlineMs
        let ready = false
        while (!ready && Date.now() < deadline)
        {
            try
            {
                await this.exec.Run(L.Docker, [L.ExecVerb, L.ConsolePostgresContainer, ...L.PgIsReady])
                ready = true
            }
            catch
            {
                await new Promise(res => setTimeout(res, L.PollMs))
            }
        }
        if (!ready)
        {
            throw new Error(L.ConsolePostgresNotReadyMessage)
        }
        const urlFile = join(N.StackDir, L.ConsolePostgresUrlFileName)
        writeFileSync(urlFile, L.ConsolePostgresUrlPrefix + password + L.ConsolePostgresUrlSuffix, { encoding: L.Utf8, mode: L.OwnerOnlyMode })
        return urlFile
    }

    /** The internal API's shared secret (32 random bytes, hex), in an owner-only file of the stack folder; never logged. */
    private WriteInternalSecret(): string
    {
        const L = LiveLoopStack
        const secret = randomBytes(L.InternalSecretBytes).toString(L.HexEncoding)
        this.HoldSecret(secret)
        const file = join(LiveLoopStackNames.StackDir, L.InternalSecretFileName)
        writeFileSync(file, secret, { encoding: L.Utf8, mode: L.OwnerOnlyMode })
        return file
    }

    /** Starts one service detached from its repository with its settings; its output goes to `logName` in the stack folder. */
    private StartService(spec: LiveLoopServiceSpec, logName: string, pidName: string): ChildProcess
    {
        const L = LiveLoopStack
        const N = LiveLoopStackNames
        const log = openSync(join(N.StackDir, logName), L.AppendFlag)
        const child = spawn(process.execPath, [spec.tsxCli, spec.script], { cwd: spec.cwd, env: spec.env, detached: true, stdio: ['ignore', log, log], windowsHide: true })
        writeFileSync(join(N.StackDir, pidName), String(child.pid), L.Utf8)
        child.unref()
        return child
    }

    /**
     * What down stops, in order: the TLS front and the edge first (both relay to the console), then the console. The front's
     * development certificate is trusted by nobody, so it is recognised by the port it holds.
     */
    public static StopPlan(): readonly LiveLoopServiceStop[]
    {
        const L = LiveLoopStack
        const N = LiveLoopStackNames
        return [
            { pidFile: join(N.StackDir, L.TlsFrontPidFileName), url: N.TenantPlaneOrigin, port: N.TenantPlaneTlsPort },
            { pidFile: join(N.StackDir, L.EdgePidFileName), url: N.EdgeBase + L.HealthzPath, port: N.AgentChannelPort },
            { pidFile: join(N.StackDir, L.PidFileName), url: N.OperatorBase + L.PingPath, port: N.OperatorPort },
        ]
    }

    /**
     * Stops the service whose pid file names it, but only while it is still ours: it answers its URL, or (hung) still
     * holds its port. A dead one's pid may have been reused by another process.
     */
    private async StopService(stop: LiveLoopServiceStop): Promise<void>
    {
        const L = LiveLoopStack
        if (existsSync(stop.pidFile) && (await LiveLoopStack.Answers(stop.url) || !await new NetPortProbe().Free(stop.port)))
        {
            await this.BestEffort(() => new ProcessTree(this.exec).Kill(Number(readFileSync(stop.pidFile, L.Utf8).trim())))
        }
    }

    /** The stack's ports must be free: a control plane already listening (the developer's own) must never be seeded. */
    private async RequireFreePorts(): Promise<void>
    {
        const L = LiveLoopStack
        const probe = new NetPortProbe()
        const N = LiveLoopStackNames
        for (const port of [N.OperatorPort, N.TenantPlanePort, N.TenantPlaneTlsPort, N.AgentChannelPort, N.InternalApiPort])
        {
            if (!await probe.Free(port))
            {
                throw new Error(L.PortBusyPrefix + String(port) + L.PortBusySuffix)
            }
        }
    }

    /** True when `url` answers 2xx (the console's /api/ping, the edge's /healthz). */
    private static async Answers(url: string): Promise<boolean>
    {
        try
        {
            const response = await fetch(url)
            await response.text()
            return response.ok
        }
        catch
        {
            return false
        }
    }

    /** Waits for OUR console: an exited child fails at once (its log in the stack folder says why). */
    private async WaitForPing(child: ChildProcess): Promise<void>
    {
        const L = LiveLoopStack
        await this.WaitFor(child, LiveLoopStackNames.OperatorBase + L.PingPath, L.ExitedMessage, L.NotReadyMessage)
    }

    /** Waits for OUR process to hold `port` (the TLS front, whose certificate nothing here trusts); an exited child fails at once. */
    private async WaitForPort(child: ChildProcess, port: number, exitedMessage: string, notReadyMessage: string): Promise<void>
    {
        const L = LiveLoopStack
        const deadline = Date.now() + L.PingDeadlineMs
        while (Date.now() < deadline)
        {
            if (child.exitCode !== null)
            {
                throw new Error(exitedMessage)
            }
            if (await LiveLoopStack.Accepts(port))
            {
                return
            }
            await new Promise<void>(r => setTimeout(r, L.PollMs))
        }
        throw new Error(notReadyMessage)
    }

    /** True when something accepts a connection on loopback `port` (a connect, never a bind: binding would race our own child). */
    private static Accepts(port: number): Promise<boolean>
    {
        const L = LiveLoopStack
        return new Promise(done =>
        {
            const socket = createConnection({ host: L.Loopback, port })
            socket.once(L.ConnectEvent, () =>
            {
                socket.destroy()
                done(true)
            })
            socket.once(L.ErrorEvent, () => done(false))
        })
    }

    /** Waits for OUR edge the same way, on its /healthz. */
    private async WaitForEdge(child: ChildProcess): Promise<void>
    {
        const L = LiveLoopStack
        await this.WaitFor(child, LiveLoopStackNames.EdgeBase + L.HealthzPath, L.EdgeExitedMessage, L.EdgeNotReadyMessage)
    }

    private async WaitFor(child: ChildProcess, url: string, exitedMessage: string, notReadyMessage: string): Promise<void>
    {
        const L = LiveLoopStack
        const deadline = Date.now() + L.PingDeadlineMs
        while (Date.now() < deadline)
        {
            if (child.exitCode !== null)
            {
                throw new Error(exitedMessage)
            }
            if (await LiveLoopStack.Answers(url))
            {
                return
            }
            await new Promise<void>(r => setTimeout(r, L.PollMs))
        }
        throw new Error(notReadyMessage)
    }

    /** Holds a secret this run handles, so Redact hides it from any failure text. */
    public HoldSecret(secret: string): void
    {
        this.secrets.push(secret)
    }

    /** True when `dir` is a stack folder `down` may delete: the default one, or one holding the marker `up` writes. */
    public static IsStackFolder(dir: string): boolean
    {
        return resolve(dir) === resolve(LiveLoopStackNames.DefaultStackDir) || existsSync(join(dir, LiveLoopStack.MarkerFileName))
    }

    /** The text with every secret this run handled replaced by a placeholder. */
    public Redact(text: string): string
    {
        return this.secrets.reduce((out, secret) => secret === '' ? out : out.split(secret).join(LiveLoopStack.Redacted), text)
    }

    private async EnsureLocalImage(image: string): Promise<void>
    {
        const L = LiveLoopStack
        try
        {
            await this.exec.Run(L.Docker, [L.ImageVerb, L.InspectVerb, image])
        }
        catch
        {
            await this.exec.Run(L.Docker, [L.PullVerb, image])
        }
    }

    private async Kubectl(args: readonly string[]): Promise<string>
    {
        const L = LiveLoopStack
        return (await this.exec.Run(L.Kubectl, [L.ContextFlag, LiveLoopStackNames.KubeContext, ...args])).stdout
    }

    private async BestEffort(action: () => Promise<unknown>): Promise<void>
    {
        try
        {
            await action()
        }
        catch (err)
        {
            console.log((err as Error).message)
        }
    }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    LiveLoopStack.Main().catch(err =>
    {
        console.error((err as Error).message)
        process.exitCode = 1
    })
}
