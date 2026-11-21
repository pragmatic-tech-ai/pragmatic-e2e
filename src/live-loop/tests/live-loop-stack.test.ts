import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LiveLoopPortalBuild, LiveLoopServices, LiveLoopStack, LiveLoopStackAgent, LiveLoopStackNames, LiveLoopStackSeed, type IPortalBuildRunner } from '../live-loop-stack.js'
import { RepositoryMissingError, RepositoryRoots } from '../../stack/repository-roots.js'
import type { ApiAnswer, IOperatorApi } from '../operator-api-client.js'

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

class SeedFx
{
    public static readonly OneTime = 'one-time-pw'

    public static Answers(): Record<string, ApiAnswer>
    {
        return {
            '/api/clients': { status: 201, body: {} },
            '/api/tenants': { status: 201, body: { owner: { email: LiveLoopStackNames.OwnerEmail, password: SeedFx.OneTime } } },
            '/api/hives': { status: 201, body: {} },
        }
    }
}

describe('LiveLoopStackSeed', () =>
{
    it('creates the client, the tenant with the short owner email and the hive attached to the kind context, and returns the one-time password', async () =>
    {
        const api = new FakeOperatorApi(SeedFx.Answers())
        assert.equal(await new LiveLoopStackSeed(api).Seed(), SeedFx.OneTime)
        assert.deepEqual(api.Calls.map(c => c.method + ' ' + c.path), ['POST /api/clients', 'POST /api/tenants', 'POST /api/hives'])
        assert.deepEqual(api.Calls[1]!.body, { id: 'e2e', clientId: 'e2e-client', displayName: 'E2E', ownerEmail: 'o@t.io' })
        assert.deepEqual(api.Calls[2]!.body, {
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
        await assert.rejects(new LiveLoopStackSeed(api).Seed(), /seed step failed: \/api\/tenants status 409/)
        assert.equal(api.Calls.length, 2)
    })

    it('refuses a tenant answer without the owner password', async () =>
    {
        const answers = SeedFx.Answers()
        answers['/api/tenants'] = { status: 201, body: {} }
        await assert.rejects(new LiveLoopStackSeed(new FakeOperatorApi(answers)).Seed(), /seed step failed: \/api\/tenants/)
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
            const spec = services.Console({ KEEP: 'me' }, ServicesFx.DataRoot, ServicesFx.UrlFile, ServicesFx.SecretFile)
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
            assert.equal(spec.env.PRAGMATIC_TENANT_ADMIN_PORT, String(N.TenantPlanePort))
            assert.equal(spec.env.PRAGMATIC_TENANT_PORTAL_DIR, join(dir, 'pragmatic-tenant-admin', 'tenant-portal', 'dist'))
            assert.equal(spec.env.PRAGMATIC_AGENT_CHANNEL_PORT, String(N.AgentChannelPort))
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

describe('LiveLoopStack.StopPlan', () =>
{
    it('stops the edge first, then the console, each by its pid file, health URL and port', () =>
    {
        const N = LiveLoopStackNames
        assert.deepEqual(LiveLoopStack.StopPlan(), [
            { pidFile: join(N.StackDir, 'edge.pid'), url: 'http://127.0.0.1:7001/healthz', port: N.AgentChannelPort },
            { pidFile: join(N.StackDir, 'control-plane.pid'), url: 'http://127.0.0.1:7000/api/ping', port: N.OperatorPort },
        ])
    })
})

describe('LiveLoopStack.Redact', () =>
{
    it('replaces the stack passwords in any failure text (the owner one-time password joins them once minted)', () =>
    {
        const out = new LiveLoopStack().Redact('login failed for ' + LiveLoopStackNames.OperatorPassword)
        assert.equal(out, 'login failed for ***')
    })
})
