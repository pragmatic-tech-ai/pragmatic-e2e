import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, cpSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { Gateway } from '../../../../repos/pragmatic-env-gateway/src/cluster/gateway.js'
import { WorkerHost } from '../../../../repos/pragmatic-env-server/server/src/cluster/worker-host.js'
import { MachineTls, type MachineTlsRef, RateLimitGuard, TokenBucketRateLimiter, type IWorkerRouter, type WorkerEndpoint } from '@pragmatic-tech-ai/pragmatic-env-cluster'
import { InMemoryEnvironmentProvisioning } from '../../../../repos/pragmatic-env-server/server/src/environments/environment-registry.js'
import type { EnvironmentProvisioning } from '../../../../repos/pragmatic-env-server/server/src/environments/environment-provisioning.js'
import { SiblingCheckouts } from '../../../stack/sibling-checkouts.js'
import { ClusterFixtures } from './cluster-fixtures.js'

class CountingRouter implements IWorkerRouter
{
    public Calls = 0

    public RouteOrSpawn(_environmentId: string): Promise<WorkerEndpoint>
    {
        this.Calls++
        return Promise.resolve({ host: '127.0.0.1', port: 1 })
    }

    public Drain(): Promise<void>
    {
        return Promise.resolve()
    }
}

class Fixtures
{
    public static readonly KeyEnv = 'PS_RL_WORKER_KEY'

    private static TlsDir(): string
    {
        return SiblingCheckouts.PathOf(ClusterFixtures.EnvServer, ClusterFixtures.Server, ClusterFixtures.Src, ClusterFixtures.Tests, ClusterFixtures.Fixtures, ClusterFixtures.Tls)
    }

    public static ServerTls(): MachineTlsRef
    {
        const dir = Fixtures.TlsDir()
        return { certFile: join(dir, 'server.pem'), keyFile: join(dir, 'server.key'), caFile: join(dir, 'ca.pem') }
    }

    public static ClientTls(): MachineTlsRef
    {
        const dir = Fixtures.TlsDir()
        return { certFile: join(dir, 'client.pem'), keyFile: join(dir, 'client.key'), caFile: join(dir, 'ca.pem') }
    }

    public static Guard(): RateLimitGuard
    {
        return new RateLimitGuard(new TokenBucketRateLimiter({ perEnvironment: { Rps: 0.001, Burst: 1 } }))
    }

    public static Status(ws: WebSocket): Promise<{ status: number, retryAfter: string | undefined }>
    {
        return new Promise((resolve, reject) =>
        {
            ws.on('unexpected-response', (_req, res) =>
            {
                const header = res.headers['retry-after']
                resolve({ status: res.statusCode ?? 0, retryAfter: Array.isArray(header) ? header[0] : header })
                ws.terminate()
            })
            ws.on('open', () =>
            {
                resolve({ status: 101, retryAfter: undefined })
                ws.terminate()
            })
            ws.on('error', err => reject(err))
        })
    }
}

test('the gateway rejects a per-environment upgrade breach with 429 + Retry-After before routing', async () =>
{
    const router = new CountingRouter()
    const gateway = await Gateway.StartAsync({ port: 0, router, tls: Fixtures.ServerTls(), rateLimit: Fixtures.Guard() })
    const url = `ws://127.0.0.1:${gateway.Address().port}/?environment=t1`
    try
    {
        const first = await Fixtures.Status(new WebSocket(url)).catch(() => ({ status: 0, retryAfter: undefined }))
        assert.notEqual(first.status, 429)
        const second = await Fixtures.Status(new WebSocket(url))
        assert.equal(second.status, 429)
        assert.ok(Number(second.retryAfter) >= 1)
        assert.equal(router.Calls, 1)
    }
    finally
    {
        await gateway.DisposeAsync()
    }
})

test('the worker host rejects a per-environment upgrade breach with 429 + Retry-After', async () =>
{
    const baseDir = mkdtempSync(join(tmpdir(), 'ps-wh-rl-'))
    mkdirSync(join(baseDir, 't1'), { recursive: true })
    cpSync(SiblingCheckouts.PathOf(ClusterFixtures.EnvServer, ClusterFixtures.Server, ClusterFixtures.Src, ClusterFixtures.Tests, ClusterFixtures.Fixtures, ClusterFixtures.SampleSolution), join(baseDir, 't1', 'solution'), { recursive: true })
    process.env[Fixtures.KeyEnv] = randomBytes(32).toString('base64')
    const entries = new Map<string, EnvironmentProvisioning>([['t1', { displayName: 't1' }]])
    const worker = await WorkerHost.StartAsync({ host: '127.0.0.1', port: 0, baseDir, masterKey: { base64Env: Fixtures.KeyEnv }, provisioning: new InMemoryEnvironmentProvisioning(entries), tls: Fixtures.ServerTls(), rateLimit: Fixtures.Guard() })
    const client = MachineTls.Client(Fixtures.ClientTls())
    const dial = (): WebSocket => new WebSocket(`wss://${worker.Address().host}:${worker.Address().port}/`, { key: client.key, cert: client.cert, ca: client.ca, rejectUnauthorized: true, headers: { 'x-pragmatic-environment': 't1' } })
    try
    {
        const first = await Fixtures.Status(dial()).catch(() => ({ status: 0, retryAfter: undefined }))
        assert.notEqual(first.status, 429)
        const second = await Fixtures.Status(dial())
        assert.equal(second.status, 429)
        assert.ok(Number(second.retryAfter) >= 1)
    }
    finally
    {
        await worker.DisposeAsync()
        rmSync(baseDir, { recursive: true, force: true })
        delete process.env[Fixtures.KeyEnv]
    }
})
