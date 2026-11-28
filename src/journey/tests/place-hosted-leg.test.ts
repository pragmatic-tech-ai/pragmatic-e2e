import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CustomerSession } from '../drivers/customer-session.js'
import { JourneyContext } from '../journey-context.js'
import { JourneyPath } from '../journey-path.js'
import { JourneyKeys, JourneyState } from '../legs/journey-keys.js'
import { PlaceHostedLeg } from '../legs/place-hosted-leg.js'
import type { IConsoleTrust } from '../live/console-trust.js'
import { HostAliases, HostedClusters } from '../live/hosted-cluster.js'
import { ProcessResult, type IProcessRunner } from '../live/process-runner.js'
import { Waiter } from '../waiter.js'
import { FakeClock, FakePage, FakeStarter, TempFolder, TestEvidence } from './journey-fakes.js'

const Placement = 'ab2c'
const ConsoleHost = 'acme-ab2c.hives.pragmatic-tech.ai'
const IdpHost = 'idp-acme.acme-ab2c.hives.pragmatic-tech.ai'

class Kube implements IProcessRunner
{
    public readonly Calls: string[][] = []

    public async Run(program: string, argv: readonly string[], _timeoutMs: number): Promise<ProcessResult>
    {
        this.Calls.push([program, ...argv])
        if (argv.includes('ingress'))
        {
            const items = [
                { metadata: { name: 'pragmatic-tenant-admin-acme', namespace: 'pragmatic-system' }, spec: { rules: [{ host: ConsoleHost }] } },
                { metadata: { name: 'pragmatic-idp-acme', namespace: 'pragmatic-idp-acme' }, spec: { rules: [{ host: IdpHost }] } },
            ]
            return new ProcessResult(0, JSON.stringify({ items }), '')
        }
        if (argv.includes('pragmatic-tls-dev-ca'))
        {
            return new ProcessResult(0, JSON.stringify({ data: { 'ca.crt': Buffer.from('PEM').toString('base64') } }), '')
        }
        if (program === 'docker' || program === 'kind')
        {
            return new ProcessResult(0, '', '')
        }
        return new ProcessResult(1, '', 'unexpected')
    }
}

class Cabinet extends FakePage
{
    public Live = false
    public Order: string[] = []

    public override async PostJson(path: string, body: unknown): Promise<unknown>
    {
        await super.PostJson(path, body)
        this.Order.push(path)
        if (path === '/api/cabinet/account')
        {
            return { Client: { ClientId: 'cl1' } }
        }
        if (path === '/api/cabinet/start-enrolment')
        {
            this.Live = true
            return { PlacementId: Placement }
        }
        if (path === '/api/cabinet/leave-hive')
        {
            this.Live = false
            return {}
        }
        if (path === '/api/cabinet/list-hives')
        {
            return { Hives: this.Live ? [{ HiveId: 'hv-1', Level: 'hosted', Health: 'healthy', Environments: [] }] : [] }
        }
        return null
    }
}

class Trust implements IConsoleTrust
{
    public Calls: Array<{ Hosts: readonly string[], Port: number }> = []

    public async Pins(hosts: readonly string[], port: number, _caPem: string): Promise<string[]>
    {
        this.Calls.push({ Hosts: hosts, Port: port })
        return hosts.map(host => 'pin-' + host)
    }
}

class World
{
    public readonly Page = new Cabinet()
    public readonly Kube = new Kube()
    public readonly Starter = new FakeStarter()
    public readonly Folder = new TempFolder()
    public readonly HostsFile = join(this.Folder.Path, 'hosts')
    public readonly Trust = new Trust()
    public readonly Evidence = new TestEvidence()
    public readonly Context = new JourneyContext('run-0001', JourneyPath.Hosted)

    public constructor()
    {
        this.Context.Set(JourneyKeys.ClientName, 'journey-run-0001')
        this.Context.Set(JourneyKeys.Tenant, 'tn')
    }

    public Leg(): PlaceHostedLeg
    {
        const session = { AccountPage: async () => this.Page } as unknown as CustomerSession
        const clusters = new HostedClusters(this.Kube, this.Starter, new HostAliases(this.HostsFile))
        return new PlaceHostedLeg(session, this.Kube, new Waiter(new FakeClock(), 1000), this.Evidence.Evidence, clusters, this.Trust)
    }

    public Dispose(): void
    {
        this.Evidence.Folder.Dispose()
        this.Folder.Dispose()
    }
}

describe('PlaceHostedLeg', () =>
{
    it('places one hive, keeps it alive and reaches its console through a port-forward', async () =>
    {
        const w = new World()
        const leg = w.Leg()
        await leg.Run(w.Context)
        assert.equal(w.Context.Get(JourneyKeys.HostedPlacement), Placement)
        assert.equal(w.Page.Order.filter(p => p === '/api/cabinet/start-enrolment').length, 1)
        assert.equal(w.Page.Order.includes('/api/cabinet/leave-hive'), false, 'the hive stays live after Run')
        assert.equal(w.Kube.Calls.some(c => c[0] === 'docker'), false, 'no host-agent restart')
        assert.equal(w.Context.Get(JourneyKeys.ConsoleHost), ConsoleHost)
        assert.equal(w.Context.Get(JourneyKeys.IdpHost), IdpHost)
        assert.equal(w.Context.Get(JourneyKeys.ConsoleUrl), 'https://' + ConsoleHost + ':28444/')
        assert.equal(w.Context.Get(JourneyKeys.ConsoleTrusted), JourneyState.ConsoleTrusted)
        assert.equal(w.Context.Get(JourneyKeys.Hive), 'hv-1')
        assert.deepEqual(w.Trust.Calls[0], { Hosts: [ConsoleHost, IdpHost], Port: 28444 })
        assert.equal(w.Starter.Started.length, 1)
        assert.equal(w.Starter.Started[0]?.Stopped, false)
        const hosts = readFileSync(w.HostsFile, 'utf8')
        assert.ok(hosts.includes('127.0.0.1 ' + ConsoleHost) && hosts.includes('127.0.0.1 ' + IdpHost))
        w.Dispose()
    })

    it('clean stops the reach, removes the aliases, then leaves the hive', async () =>
    {
        const w = new World()
        const leg = w.Leg()
        await leg.Run(w.Context)
        w.Page.Order = []
        await leg.Clean(w.Context)
        assert.equal(w.Starter.Started[0]?.Stopped, true)
        assert.equal(readFileSync(w.HostsFile, 'utf8').includes(ConsoleHost), false)
        assert.ok(w.Page.Order.includes('/api/cabinet/leave-hive'))
        assert.deepEqual(w.Page.PostJsonCalls.find(c => c.Path === '/api/cabinet/leave-hive')?.Body, { ClientId: 'cl1', HiveId: 'hv-1' })
        assert.equal(w.Page.Live, false)
        w.Dispose()
    })
})
