import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LiveLoopPortalBuild, LiveLoopServices, LiveLoopStack, LiveLoopStackAgent, LiveLoopStackNames, LiveLoopStackSeed, type IPortalBuildRunner, type LiveLoopStackDescriptor, type LiveLoopStackFiles } from '../live-loop-stack.js'
import { RepositoryMissingError, RepositoryRoots } from '../../stack/repository-roots.js'
import type { ApiAnswer, IOperatorApi } from '../operator-api-client.js'
import { ReleaseApp } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { DevImages } from '../../dev/dev-images.js'
import { LiveLoopSignIn } from '../live-loop-stack-args.js'
import { type IEntitlementsLink, LiveLoopEntitlements } from '../live-loop-entitlements.js'
import type { EntitlementStatement } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'

class FakeOperatorApi implements IOperatorApi
{
    public readonly Calls: { method: string; path: string; body: unknown }[] = []

    public constructor(private readonly answers: Record<string, ApiAnswer>)
    {
    }

    public async Login(): Promise<void>
    {
    }

    public async Call(method: string, path: string, body?: unknown): Promise<ApiAnswer>
    {
        this.Calls.push({ method, path, body })
        return this.answers[path] ?? { status: 404, body: undefined }
    }
}

/** The clients ledger's link as the seed sees it: records each statement and answers `status`. */
class FakeEntitlementsLink implements IEntitlementsLink
{
    public readonly Statements: EntitlementStatement[] = []

    public constructor(private readonly status: number = LiveLoopEntitlements.StatusOk)
    {
    }

    public async PostStatement(statement: EntitlementStatement): Promise<number>
    {
        this.Statements.push(statement)
        return this.status
    }
}

class SeedFx
{
    public static readonly OneTime = 'one-time-pw'
    public static readonly Now = new Date('2026-11-24T10:00:00.000Z')

    public static Seed(api: IOperatorApi, link: IEntitlementsLink = new FakeEntitlementsLink()): LiveLoopStackSeed
    {
        return new LiveLoopStackSeed(api, link, () => SeedFx.Now)
    }

    public static Answers(): Record<string, ApiAnswer>
    {
        return {
            '/api/tenants': { status: 201, body: { owner: { email: LiveLoopStackNames.OwnerEmail, password: SeedFx.OneTime } } },
            '/api/hives': { status: 201, body: {} },
        }
    }
}

describe('LiveLoopStackSeed', () =>
{
    it('delivers the client\'s ledger statement, then creates the tenant with the short owner email and the hive attached to the kind context, and returns the one-time password', async () =>
    {
        const api = new FakeOperatorApi(SeedFx.Answers())
        const link = new FakeEntitlementsLink()
        assert.equal(await SeedFx.Seed(api, link).Seed(), SeedFx.OneTime)
        assert.deepEqual(link.Statements, [LiveLoopEntitlements.Statement('e2e-client', 'E2E Client', SeedFx.Now)])
        assert.deepEqual(api.Calls.map(c => c.method + ' ' + c.path), ['POST /api/tenants', 'POST /api/hives'], 'operators create no client (the ledger owns them)')
        assert.deepEqual(api.Calls[0]!.body, { id: 'e2e', clientId: 'e2e-client', displayName: 'E2E', ownerEmail: 'o@t.io' })
        assert.deepEqual(api.Calls[1]!.body, {
            id: 'e2e-hive', tenantId: 'e2e', displayName: 'E2E Hive',
            cluster: { backend: 'local', mode: 'attach', configRef: 'kind-pragmatic-e2e' },
            registry: { mode: 'attach' },
        })
    })

    it('stops at the first refused step, naming it without any secret', async () =>
    {
        const answers = SeedFx.Answers()
        answers['/api/tenants'] = { status: 409, body: { error: 'exists' } }
        const api = new FakeOperatorApi(answers)
        await assert.rejects(SeedFx.Seed(api).Seed(), /seed step failed: \/api\/tenants status 409/)
        assert.equal(api.Calls.length, 1)
    })

    it('stops before any operator call when the console refuses the client\'s statement', async () =>
    {
        const api = new FakeOperatorApi(SeedFx.Answers())
        await assert.rejects(SeedFx.Seed(api, new FakeEntitlementsLink(401)).Seed(), /seed step failed: \/internal\/entitlements\/v1\/statements status 401/)
        assert.equal(api.Calls.length, 0)
    })

    it('refuses a tenant answer without the owner password', async () =>
    {
        const answers = SeedFx.Answers()
        answers['/api/tenants'] = { status: 201, body: {} }
        await assert.rejects(SeedFx.Seed(new FakeOperatorApi(answers)).Seed(), /seed step failed: \/api\/tenants/)
    })
})

/** An operator API that answers each call to a path from that path's queue (the last answer repeats). */
class ScriptedOperatorApi implements IOperatorApi
{
    public readonly Calls: { method: string; path: string }[] = []

    public constructor(private readonly answers: Record<string, ApiAnswer[]>)
    {
    }

    public async Login(): Promise<void>
    {
    }

    public async Call(method: string, path: string): Promise<ApiAnswer>
    {
        this.Calls.push({ method, path })
        const queue = this.answers[method + ' ' + path] ?? []
        return (queue.length > 1 ? queue.shift() : queue[0]) ?? { status: 404, body: undefined }
    }
}

class AgentFx
{
    public static readonly Path = '/api/hives/e2e-hive/agent-install'
    public static readonly Started: ApiAnswer = { status: 202, body: { state: 'installing', step: 'preparing-cluster' } }
    public static readonly Waiting: ApiAnswer = { status: 200, body: { state: 'installing', step: 'waiting-for-check-in' } }
    public static readonly Connected: ApiAnswer = { status: 200, body: { state: 'connected', step: 'waiting-for-check-in' } }

    public static Agent(api: IOperatorApi, deadlineMs: number = 1_000): LiveLoopStackAgent
    {
        return new LiveLoopStackAgent(api, { pollMs: 1, deadlineMs })
    }
}

describe('LiveLoopStackAgent', () =>
{
    it('starts the hive agent install and waits until the hive has checked in', async () =>
    {
        const api = new ScriptedOperatorApi({ ['POST ' + AgentFx.Path]: [AgentFx.Started], ['GET ' + AgentFx.Path]: [AgentFx.Waiting, AgentFx.Waiting, AgentFx.Connected] })
        await AgentFx.Agent(api).Install()
        assert.deepEqual(api.Calls.map(c => c.method), ['POST', 'GET', 'GET', 'GET'])
        assert.ok(api.Calls.every(c => c.path === AgentFx.Path))
    })

    it('fails with the installer\'s own error when the install fails', async () =>
    {
        const failed: ApiAnswer = { status: 200, body: { state: 'failed', step: 'applying-agent', error: 'kubectl apply refused' } }
        const api = new ScriptedOperatorApi({ ['POST ' + AgentFx.Path]: [AgentFx.Started], ['GET ' + AgentFx.Path]: [failed] })
        await assert.rejects(AgentFx.Agent(api).Install(), /hive agent install failed at applying-agent: kubectl apply refused/)
    })

    it('fails naming the status when the install cannot start (e.g. the agent channel is off)', async () =>
    {
        const api = new ScriptedOperatorApi({ ['POST ' + AgentFx.Path]: [{ status: 409, body: { error: 'channel off' } }] })
        await assert.rejects(AgentFx.Agent(api).Install(), /hive agent install did not start: status 409: channel off/)
    })

    it('gives up after its deadline when the hive never checks in', async () =>
    {
        const api = new ScriptedOperatorApi({ ['POST ' + AgentFx.Path]: [AgentFx.Started], ['GET ' + AgentFx.Path]: [AgentFx.Waiting] })
        await assert.rejects(AgentFx.Agent(api, 20).Install(), /hive agent did not check in in time; last step waiting-for-check-in/)
    })
})

class RecordingBuildRunner implements IPortalBuildRunner
{
    public readonly Runs: { command: string; args: readonly string[]; cwd: string }[] = []

    public constructor(private readonly codes: number[] = [])
    {
    }

    public async Run(command: string, args: readonly string[], cwd: string): Promise<number>
    {
        this.Runs.push({ command, args, cwd })
        return this.codes.shift() ?? 0
    }
}

describe('LiveLoopPortalBuild', () =>
{
    const Portals = [join('D:', 'repos', 'pragmatic-platform-admin', 'portal'), join('D:', 'repos', 'pragmatic-tenant-admin', 'tenant-portal')]

    it('runs npm run build in each portal folder in order', async () =>
    {
        const runner = new RecordingBuildRunner()
        await new LiveLoopPortalBuild(runner).Build(Portals)
        assert.deepEqual(runner.Runs, [
            { command: 'npm', args: ['run', 'build'], cwd: Portals[0] },
            { command: 'npm', args: ['run', 'build'], cwd: Portals[1] },
        ])
    })

    it('stops at the first failed build, naming the portal and its exit code', async () =>
    {
        const runner = new RecordingBuildRunner([2])
        await assert.rejects(new LiveLoopPortalBuild(runner).Build(Portals), /admin portal build failed: portal exited 2/)
        assert.equal(runner.Runs.length, 1)
    })
})

/** A repositories folder holding empty platform-admin, platform-edge and tenant-admin checkouts. */
class ServicesFx
{
    public static readonly Repositories = [LiveLoopServices.PlatformAdmin, LiveLoopServices.PlatformEdge, LiveLoopServices.TenantAdmin]
    public static readonly DataRoot = join('S:', 'stack', 'data')
    public static readonly UrlFile = join('S:', 'stack', 'postgres-url')
    public static readonly SecretFile = join('S:', 'stack', 'internal-api-secret')
    public static readonly OperatorPasswordFile = join('S:', 'stack', 'operator-password')
    public static readonly EntitlementsSecretFile = join('S:', 'stack', 'entitlements-link-secret')
    public static readonly InheritedTenantPlaneUrl = 'https://inherited.example'

    public static With(body: (dir: string, services: LiveLoopServices) => void): void
    {
        const dir = mkdtempSync(join(tmpdir(), 'e2e-services-'))
        try
        {
            for (const repo of ServicesFx.Repositories)
            {
                mkdirSync(join(dir, repo))
            }
            body(dir, new LiveLoopServices(new RepositoryRoots(dir)))
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    }
}

describe('LiveLoopServices', () =>
{
    const N = LiveLoopStackNames

    it('builds platform admin\'s portal, then tenant admin\'s, from their repositories', () =>
    {
        ServicesFx.With((dir, services) =>
        {
            assert.deepEqual(services.PortalDirs(), [join(dir, 'pragmatic-platform-admin', 'portal'), join(dir, 'pragmatic-tenant-admin', 'tenant-portal')])
        })
    })

    it('starts the console from pragmatic-platform-admin with its own tsx, role admin and the internal API on loopback', () =>
    {
        ServicesFx.With((dir, services) =>
        {
            const admin = join(dir, 'pragmatic-platform-admin')
            const spec = services.Console({ KEEP: 'me' }, ServicesFx.DataRoot, ServicesFx.UrlFile, ServicesFx.SecretFile, ServicesFx.OperatorPasswordFile, ServicesFx.EntitlementsSecretFile)
            assert.equal(spec.env.PRAGMATIC_ADMIN_OPERATOR_PASSWORD_FILE, ServicesFx.OperatorPasswordFile)
            assert.equal(spec.env.PRAGMATIC_ADMIN_OPERATOR_PASSWORD, undefined)
            assert.equal(spec.cwd, admin)
            assert.equal(spec.script, join('src', 'server.ts'))
            assert.equal(spec.tsxCli, join(admin, 'node_modules', 'tsx', 'dist', 'cli.mjs'))
            assert.equal(spec.env.KEEP, 'me')
            assert.equal(spec.env.PRAGMATIC_CONTROL_PLANE_ROLE, 'admin')
            assert.equal(spec.env.PRAGMATIC_ADMIN_DATA_ROOT, ServicesFx.DataRoot)
            assert.equal(spec.env.PRAGMATIC_ADMIN_DATABASE_URL_FILE, ServicesFx.UrlFile)
            assert.equal(spec.env.PRAGMATIC_ADMIN_PORT, String(N.OperatorPort))
            assert.equal(spec.env.PRAGMATIC_ADMIN_INTERNAL_PORT, String(N.InternalApiPort))
            assert.equal(spec.env.PRAGMATIC_ADMIN_INTERNAL_BIND, '127.0.0.1')
            assert.equal(spec.env.PRAGMATIC_INTERNAL_API_SECRET_FILE, ServicesFx.SecretFile)
            assert.equal(spec.env.PRAGMATIC_ADMIN_ENTITLEMENTS_SECRET_FILE, ServicesFx.EntitlementsSecretFile, 'the clients ledger\'s link the seed uses')
            assert.equal(spec.env.PRAGMATIC_TENANT_ADMIN_PORT, String(N.TenantPlanePort))
            assert.equal(spec.env.PRAGMATIC_TENANT_PORTAL_DIR, join(dir, 'pragmatic-tenant-admin', 'tenant-portal', 'dist'))
            assert.equal(spec.env.PRAGMATIC_AGENT_CHANNEL_PORT, String(N.AgentChannelPort))
        })
    })

    it('gives the tenant plane an https browser origin on the TLS front\'s port (the realm sign-in accepts only https redirects)', () =>
    {
        ServicesFx.With((_dir, services) =>
        {
            const spec = services.Console({}, ServicesFx.DataRoot, ServicesFx.UrlFile, ServicesFx.SecretFile, ServicesFx.OperatorPasswordFile, ServicesFx.EntitlementsSecretFile)
            assert.equal(spec.env.PRAGMATIC_TENANT_ADMIN_EXTERNAL_SCHEME, 'https')
            assert.equal(spec.env.PRAGMATIC_TENANT_ADMIN_EXTERNAL_PORT, String(N.TenantPlaneTlsPort))
            assert.equal(spec.env.PRAGMATIC_TENANT_ADMIN_TRUSTED_PROXY, 'true')
            assert.equal(N.TenantPlaneOrigin, 'https://' + N.TenantHost + ':' + String(N.TenantPlaneTlsPort))
        })
    })

    it('realm mode (the default) turns the desktop realm sign-in on and names the tenant plane on the TLS front', () =>
    {
        ServicesFx.With((_dir, services) =>
        {
            const spec = services.Console({}, ServicesFx.DataRoot, ServicesFx.UrlFile, ServicesFx.SecretFile, ServicesFx.OperatorPasswordFile, ServicesFx.EntitlementsSecretFile)
            assert.equal(spec.env[LiveLoopServices.DesktopRealmSignInVar], 'on')
            assert.equal(spec.env[LiveLoopServices.DesktopTenantPlaneUrlVar], N.TenantPlaneOrigin)
            assert.equal(LiveLoopServices.DesktopRealmSignInVar, 'PRAGMATIC_TENANT_ADMIN_DESKTOP_REALM_SIGN_IN', 'the variable the console reads')
            assert.equal(LiveLoopServices.DesktopTenantPlaneUrlVar, 'PRAGMATIC_DESKTOP_TENANT_PLANE_URL')
            assert.deepEqual(LiveLoopServices.SignInEnv(LiveLoopSignIn.Realm), { [LiveLoopServices.DesktopRealmSignInVar]: 'on', [LiveLoopServices.DesktopTenantPlaneUrlVar]: N.TenantPlaneOrigin })
        })
    })

    it('transitional mode turns it off and leaves the desktop tenant plane address as given', () =>
    {
        ServicesFx.With((_dir, services) =>
        {
            assert.equal(services.Console({}, ServicesFx.DataRoot, ServicesFx.UrlFile, ServicesFx.SecretFile, ServicesFx.OperatorPasswordFile, ServicesFx.EntitlementsSecretFile, LiveLoopSignIn.Transitional).env[LiveLoopServices.DesktopTenantPlaneUrlVar], undefined,
                'unset: the console derives its loopback tenant listener')
            const spec = services.Console({ [LiveLoopServices.DesktopTenantPlaneUrlVar]: ServicesFx.InheritedTenantPlaneUrl }, ServicesFx.DataRoot, ServicesFx.UrlFile, ServicesFx.SecretFile, ServicesFx.OperatorPasswordFile, ServicesFx.EntitlementsSecretFile, LiveLoopSignIn.Transitional)
            assert.equal(spec.env[LiveLoopServices.DesktopRealmSignInVar], 'off')
            assert.equal(spec.env[LiveLoopServices.DesktopTenantPlaneUrlVar], ServicesFx.InheritedTenantPlaneUrl, 'an inherited value is kept')
        })
    })

    it('starts the TLS front from this repository with its own tsx, relaying the front port to the tenant plane', () =>
    {
        ServicesFx.With((_dir, services) =>
        {
            const spec = services.TlsFront({ KEEP: 'me' }, '/s/server.crt', '/s/server.key')
            assert.equal(spec.cwd, RepositoryRoots.OwnRoot)
            assert.equal(spec.script, join('src', 'live-loop', 'tenant-plane-tls-front.ts'))
            assert.equal(spec.tsxCli, join(RepositoryRoots.OwnRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'))
            assert.deepEqual(spec.env, {
                KEEP: 'me',
                PRAGMATIC_E2E_TLS_FRONT_PORT: String(N.TenantPlaneTlsPort),
                PRAGMATIC_E2E_TLS_FRONT_TARGET_PORT: String(N.TenantPlanePort),
                PRAGMATIC_E2E_TLS_FRONT_CERT_FILE: '/s/server.crt',
                PRAGMATIC_E2E_TLS_FRONT_KEY_FILE: '/s/server.key',
            })
        })
    })

    it('starts the edge from pragmatic-platform-edge on the agent channel, answered through the console\'s internal API', () =>
    {
        ServicesFx.With((dir, services) =>
        {
            const edge = join(dir, 'pragmatic-platform-edge')
            const spec = services.Edge({}, ServicesFx.SecretFile)
            assert.equal(spec.cwd, edge)
            assert.equal(spec.script, join('src', 'bin', 'pragmatic-platform-edged.ts'))
            assert.equal(spec.tsxCli, join(edge, 'node_modules', 'tsx', 'dist', 'cli.mjs'))
            assert.deepEqual(spec.env, {
                PRAGMATIC_AGENT_CHANNEL_PORT: String(N.AgentChannelPort),
                PRAGMATIC_AGENT_CHANNEL_BIND: '0.0.0.0',
                PRAGMATIC_EDGE_ADMIN_URL: N.InternalApiBase,
                PRAGMATIC_INTERNAL_API_SECRET_FILE: ServicesFx.SecretFile,
            })
            assert.equal(N.InternalApiBase, 'http://127.0.0.1:' + String(N.InternalApiPort))
        })
    })

    it('refuses to start a service whose repository is not checked out, naming it', () =>
    {
        const dir = mkdtempSync(join(tmpdir(), 'e2e-services-'))
        try
        {
            const services = new LiveLoopServices(new RepositoryRoots(dir))
            assert.throws(() => services.Edge({}, ServicesFx.SecretFile), (err: unknown) => err instanceof RepositoryMissingError && err.message.includes('pragmatic-platform-edge'))
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})

describe('LiveLoopStack.ReleaseEnv', () =>
{
    const N = LiveLoopStackNames

    it('points the release catalogue at the developer\'s GHCR read credential when that file exists', () =>
    {
        const seen: string[] = []
        const out = LiveLoopStack.ReleaseEnv({}, path => { seen.push(path); return true })
        assert.deepEqual(out, { [N.ReleaseCredentialEnvVar]: N.ReleaseCredentialFile })
        assert.deepEqual(seen, [N.ReleaseCredentialFile])
    })

    it('adds nothing when the credential file is absent, so Refresh answers not configured', () =>
    {
        assert.deepEqual(LiveLoopStack.ReleaseEnv({}, () => false), {})
    })

    it('leaves an explicitly set credential file alone, and treats a blank one as unset', () =>
    {
        assert.deepEqual(LiveLoopStack.ReleaseEnv({ [N.ReleaseCredentialEnvVar]: 'C:/elsewhere.json' }, () => true), {})
        assert.deepEqual(LiveLoopStack.ReleaseEnv({ [N.ReleaseCredentialEnvVar]: '' }, () => true), { [N.ReleaseCredentialEnvVar]: N.ReleaseCredentialFile })
    })
})

describe('LiveLoopStack.KindImages', () =>
{
    it('loads the env server, UI unpack, hive agent and the env server sidecar pragmatic-postgres dev images, the registry and the template data-source Postgres onto the kind node', () =>
    {
        assert.deepEqual(LiveLoopStack.KindImages(), ['pragmatic-env-server:dev', 'pragmatic-ui-unpack:dev', 'pragmatic-hive-agent:dev', 'pragmatic-postgres:local', 'registry:2', 'postgres:16'])
    })

    it('loads only images the stack bakes or pulls: every dev image among them is one of the live loop\'s baked images', () =>
    {
        const baked = DevImages.LiveLoopApps.map(app => DevImages.TagOf(app))
        for (const image of LiveLoopStack.KindImages().filter(i => i.startsWith('pragmatic-')))
        {
            assert.ok(baked.includes(image), image)
        }
        // The env server's pragmatic-postgres sidecar (A5): every environment pod runs the dev image beside the server.
        assert.ok(LiveLoopStack.KindImages().includes(DevImages.TagOf(ReleaseApp.Postgres)))
        // The tenant IdP is baked but runs in local docker (the console's Docker IdP), not on the node.
        assert.ok(baked.includes(DevImages.TagOf(ReleaseApp.TenantIdp)))
        assert.ok(!LiveLoopStack.KindImages().includes(DevImages.TagOf(ReleaseApp.TenantIdp)))
    })
})

describe('LiveLoopStack.ImagesToBake', () =>
{
    it('bakes the live loop\'s dev images, and none with PRAGMATIC_DEV_SKIP_IMAGE_BAKE=1', () =>
    {
        assert.deepEqual(LiveLoopStack.ImagesToBake({}), DevImages.LiveLoopApps)
        assert.deepEqual(LiveLoopStack.ImagesToBake({ PRAGMATIC_DEV_SKIP_IMAGE_BAKE: '0' }), DevImages.LiveLoopApps)
        assert.deepEqual(LiveLoopStack.ImagesToBake({ PRAGMATIC_DEV_SKIP_IMAGE_BAKE: '1' }), [])
    })
})

describe('LiveLoopStack.StopPlan', () =>
{
    it('stops the TLS front and the edge first, then the console, each by its pid file, health URL and port', () =>
    {
        const N = LiveLoopStackNames
        assert.deepEqual(LiveLoopStack.StopPlan(), [
            { pidFile: join(N.StackDir, 'tls-front.pid'), url: 'https://e2e.lvh.me:7443', port: N.TenantPlaneTlsPort },
            { pidFile: join(N.StackDir, 'edge.pid'), url: 'http://127.0.0.1:7001/healthz', port: N.AgentChannelPort },
            { pidFile: join(N.StackDir, 'control-plane.pid'), url: 'http://127.0.0.1:7000/api/ping', port: N.OperatorPort },
        ])
    })
})

describe('LiveLoopStack.Redact', () =>
{
    it('replaces every held secret in any failure text (the per-run operator password, the owner one-time password)', () =>
    {
        const stack = new LiveLoopStack()
        stack.HoldSecret('per-run-operator')
        stack.HoldSecret('one-time')
        assert.equal(stack.Redact('login failed for per-run-operator, then one-time'), 'login failed for ***, then ***')
    })
})

describe('LiveLoopStack.IsStackFolder', () =>
{
    it('lets down delete the default stack folder, or a folder holding the marker up writes, and nothing else', () =>
    {
        const dir = mkdtempSync(join(tmpdir(), 'stack-marker-'))
        try
        {
            assert.equal(LiveLoopStack.IsStackFolder(LiveLoopStackNames.DefaultStackDir), true)
            assert.equal(LiveLoopStack.IsStackFolder(dir), false)
            writeFileSync(join(dir, '.pragmatic-e2e-stack'), 'x')
            assert.equal(LiveLoopStack.IsStackFolder(dir), true)
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})

describe('LiveLoopStackNames.StackDirOf', () =>
{
    it('keeps the stack in ~/.pragmatic/e2e-stack by default, and a blank PRAGMATIC_E2E_STACK_DIR counts as unset', () =>
    {
        const home = join(homedir(), '.pragmatic', 'e2e-stack')
        assert.equal(LiveLoopStackNames.StackDirOf({}), home)
        assert.equal(LiveLoopStackNames.StackDirOf({ PRAGMATIC_E2E_STACK_DIR: '  ' }), home)
    })

    it('moves it to PRAGMATIC_E2E_STACK_DIR (resolved), e.g. a folder both WSL and Windows read', () =>
    {
        const dir = mkdtempSync(join(tmpdir(), 'stack-dir-'))
        try
        {
            assert.equal(LiveLoopStackNames.StackDirOf({ PRAGMATIC_E2E_STACK_DIR: dir }), resolve(dir))
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})

describe('LiveLoopStack descriptor files', () =>
{
    const absolute = (dir: string): LiveLoopStackDescriptor => ({
        platformAddress: 'http://localhost:7000', tenantPlaneOrigin: 'http://e2e.lvh.me:7100', tenant: 'e2e', hive: 'e2e-hive',
        kubeContext: 'kind-pragmatic-e2e', ownerEmail: 'o@t.io', ownerPasswordFile: join(dir, 'owner-password'),
        operatorEmail: 'op@t.io', operatorPasswordFile: join(dir, 'operator-password'),
        idpCaFile: join(dir, 'data', 'idp', 'e2e', 'tls', 'ca.crt'), idpCertFile: join(dir, 'data', 'idp', 'e2e', 'tls', 'server.crt'),
        idpLogin: 'browser', dataRoot: join(dir, 'data'), signIn: LiveLoopSignIn.Transitional,
    })
    const files = (dir: string): LiveLoopStackFiles => ({
        dataRoot: join(dir, 'data'), ownerPasswordFile: join(dir, 'owner-password'), operatorPasswordFile: join(dir, 'operator-password'),
        idpCaFile: join(dir, 'data', 'idp', 'e2e', 'tls', 'ca.crt'), idpCertFile: join(dir, 'data', 'idp', 'e2e', 'tls', 'server.crt'),
    })
    const realmIssuer = 'https://host.docker.internal:7300/realms/e2e'

    it('writes every file path relative to the stack folder with forward slashes, so Windows and WSL readers both resolve it', () =>
    {
        const dir = join(tmpdir(), 'stack')
        const portable = LiveLoopStack.Portable(absolute(dir), dir)
        assert.equal(portable.ownerPasswordFile, 'owner-password')
        assert.equal(portable.operatorPasswordFile, 'operator-password')
        assert.equal(portable.idpCaFile, 'data/idp/e2e/tls/ca.crt')
        assert.equal(portable.idpCertFile, 'data/idp/e2e/tls/server.crt')
        assert.equal(portable.dataRoot, 'data')
        assert.equal(portable.platformAddress, 'http://localhost:7000')
    })

    it('reads a written descriptor back with absolute paths beside the file it was read from', () =>
    {
        const dir = mkdtempSync(join(tmpdir(), 'stack-read-'))
        try
        {
            const file = join(dir, 'stack.json')
            writeFileSync(file, JSON.stringify(LiveLoopStack.Portable(absolute('/elsewhere'), '/elsewhere')))
            assert.deepEqual(LiveLoopStack.ReadDescriptor(file), absolute(dir))
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('a realm descriptor names the realm issuer and keeps its CA bundle path portable too', () =>
    {
        const dir = join(tmpdir(), 'stack')
        const realm: LiveLoopStackDescriptor = { ...absolute(dir), signIn: LiveLoopSignIn.Realm, realmIssuer, desktopCaFile: join(dir, 'desktop-ca.pem') }
        const portable = LiveLoopStack.Portable(realm, dir)
        assert.equal(portable.desktopCaFile, 'desktop-ca.pem')
        assert.equal(portable.realmIssuer, realmIssuer)
        assert.equal(portable.signIn, LiveLoopSignIn.Realm)
        assert.equal(LiveLoopStack.Portable(absolute(dir), dir).desktopCaFile, undefined, 'a transitional descriptor has none')
    })

    it('up\'s descriptor carries the sign-in mode, and the realm only in realm mode', () =>
    {
        const dir = join(tmpdir(), 'stack')
        const realm = { realmIssuer, desktopCaFile: join(dir, 'desktop-ca.pem') }
        const transitional = LiveLoopStack.Descriptor(files(dir), LiveLoopSignIn.Transitional, realm)
        assert.deepEqual(transitional, { ...absolute(dir), tenantPlaneOrigin: LiveLoopStackNames.TenantPlaneOrigin }, 'a transitional stack names no realm even when given one')
        assert.deepEqual(LiveLoopStack.Descriptor(files(dir), LiveLoopSignIn.Realm, realm), { ...transitional, signIn: LiveLoopSignIn.Realm, ...realm })
    })

    it('still reads an older descriptor whose paths are absolute', () =>
    {
        const dir = mkdtempSync(join(tmpdir(), 'stack-old-'))
        try
        {
            const file = join(dir, 'stack.json')
            const old = absolute(join(tmpdir(), 'other-stack'))
            writeFileSync(file, JSON.stringify(old))
            assert.deepEqual(LiveLoopStack.ReadDescriptor(file), old)
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})

describe('LiveLoopStack.DownDockerSteps', () =>
{
    it('removes the console Postgres, the IdP companion Postgres before the IdP, then both IdP volumes', () =>
    {
        assert.deepEqual(LiveLoopStack.DownDockerSteps(), [
            ['rm', '-f', '-v', 'pragmatic-e2e-postgres'],
            ['rm', '-f', 'pragmatic-idp-e2e-postgres'],
            ['rm', '-f', 'pragmatic-idp-e2e'],
            ['volume', 'rm', '-f', 'pragmatic-idp-data-e2e-pgdata'],
            ['volume', 'rm', '-f', 'pragmatic-idp-data-e2e'],
        ])
    })
})
