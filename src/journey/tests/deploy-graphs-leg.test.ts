import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { JourneyContext } from '../journey-context.js'
import { JourneyDependency } from '../journey-dependency.js'
import { JourneyPath } from '../journey-path.js'
import { DeployGraphsLeg } from '../legs/deploy-graphs-leg.js'
import { JourneyKeys, JourneyState } from '../legs/journey-keys.js'
import { EngineConsolePage } from '../drivers/engine-console-page.js'
import { TenantConsolePage } from '../drivers/tenant-console-page.js'
import type { IConsoleTrust } from '../live/console-trust.js'
import { CustomerCluster } from '../live/customer-cluster.js'
import { FixedEngineClusterSource } from '../live/engine-secrets.js'
import { ProcessResult, type IProcessRunner } from '../live/process-runner.js'
import { Waiter } from '../waiter.js'
import { FakeBrowser, FakeClock, TestEvidence } from './journey-fakes.js'

const RunId = 'run-0001'
const ConsoleHost = 'console-x.localtest.me'
const ConsoleUrl = 'https://' + ConsoleHost + ':28444/'
const GraphsPath = 'GET /tenant-api/environments/journey/graphs'

class FakeKubectl implements IProcessRunner
{
    public async Run(_program: string, argv: readonly string[]): Promise<ProcessResult>
    {
        if (argv.includes(CustomerCluster.OwnerSecret))
        {
            return new ProcessResult(0, JSON.stringify({ data: { email: Buffer.from('o@x.test').toString('base64'), password: Buffer.from('pw').toString('base64') } }), '')
        }
        return new ProcessResult(0, JSON.stringify({ data: { 'ca.crt': Buffer.from('PEM').toString('base64') } }), '')
    }
}

class FakeTrust implements IConsoleTrust
{
    public async Pins(hosts: readonly string[]): Promise<string[]>
    {
        return hosts.map(h => 'pin-' + h)
    }
}

class GraphsWorld
{
    public readonly Browser = new FakeBrowser()
    public readonly Evidence = new TestEvidence()
    public readonly Context = new JourneyContext(RunId, JourneyPath.Hosted)

    public constructor()
    {
        const E = EngineConsolePage
        this.Context.Set(JourneyKeys.ConsoleUrl, ConsoleUrl)
        this.Context.Set(JourneyKeys.ConsoleHost, ConsoleHost)
        this.Context.Set(JourneyKeys.IdpHost, 'idp-x.localtest.me')
        const page = this.Browser.Console
        page.OnGoto.set(ConsoleUrl, () => page.Show(ConsoleUrl, [E.SignInButton, E.PasswordLabel], [[E.EmailSelector, 1], [E.PasswordSelector, 1]]))
        page.OnClick.set(E.SignInButton, () => page.Show(ConsoleUrl, [E.OverviewConnection, TenantConsolePage.NavLabel]))
    }

    public Leg(): DeployGraphsLeg
    {
        return new DeployGraphsLeg(this.Browser, new FixedEngineClusterSource(new CustomerCluster(new FakeKubectl(), 'c')), new FakeTrust(), new Waiter(new FakeClock(), 1000), this.Evidence.Evidence, JourneyDependency.HostedPlacement)
    }
}

describe('DeployGraphsLeg', () =>
{
    it('depends on delivery, the hive and the Plexus sign-in', () =>
    {
        const w = new GraphsWorld()
        assert.deepEqual(w.Leg().Dependencies, [JourneyDependency.EntitlementDelivery, JourneyDependency.HostedPlacement, JourneyDependency.PlexusRealmSignIn])
        w.Evidence.Folder.Dispose()
    })

    it('passes when the environment lists a graph', async () =>
    {
        const w = new GraphsWorld()
        w.Browser.Console.RequestJsonResponses.set(GraphsPath, { graphs: [{ name: 'g' }] })
        await w.Leg().Run(w.Context)
        assert.equal(w.Context.Get(JourneyKeys.GraphsState), JourneyState.GraphsListed)
        assert.ok(w.Browser.Console.RequestJsonCalls.some(c => c.Method === 'GET' && c.Path === '/tenant-api/environments/journey/graphs'))
        w.Evidence.Folder.Dispose()
    })

    it('fails when the list is empty', async () =>
    {
        const w = new GraphsWorld()
        w.Browser.Console.RequestJsonResponses.set(GraphsPath, [])
        await assert.rejects(() => w.Leg().Run(w.Context), /no deployed graph/)
        assert.equal(w.Context.Get(JourneyKeys.GraphsState), undefined)
        w.Evidence.Folder.Dispose()
    })

    it('fails, recording the landing, when the request throws', async () =>
    {
        const w = new GraphsWorld()
        w.Browser.Console.RequestJson = async () => { throw new Error('boom') }
        await assert.rejects(() => w.Leg().Run(w.Context), /boom/)
        assert.ok(w.Evidence.Sink.Lines.some(l => l.includes('landing url: ')))
        w.Evidence.Folder.Dispose()
    })
})
