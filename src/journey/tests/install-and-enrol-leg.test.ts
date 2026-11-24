import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CabinetHivesPage } from '../drivers/cabinet-hives-page.js'
import { CabinetPage } from '../drivers/cabinet-page.js'
import { CentralLoginPage } from '../drivers/central-login-page.js'
import { CustomerSession } from '../drivers/customer-session.js'
import { EngineConsolePage } from '../drivers/engine-console-page.js'
import { JourneyContext } from '../journey-context.js'
import { JourneyPath } from '../journey-path.js'
import { InstallAndEnrolLeg } from '../legs/install-and-enrol-leg.js'
import { JourneyKeys, JourneyState } from '../legs/journey-keys.js'
import { CustomerCluster } from '../live/customer-cluster.js'
import { EngineInstallCommand } from '../live/engine-install-command.js'
import { JourneyIdentity } from '../live/journey-identity.js'
import { ProcessResult, type IProcessRunner } from '../live/process-runner.js'
import { Waiter } from '../waiter.js'
import { FakeBrowser, FakeClock, TestEvidence } from './journey-fakes.js'

const Cabinet = 'https://cabinet.example'
const Tenant = 'journey-run-0001-e'
const Hive = 'hvabcdefghij'
const Code = 'pe1-ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const OwnerEmail = 'owner@localtest.me'
const OwnerPassword = 'Initial-Owner-Password-0123456789'

/** helm and kubectl, standing in: records every argument vector; the cluster holds an engine once installed. */
class FakeCluster implements IProcessRunner
{
    public readonly Calls: string[][] = []
    public Installed = false
    public Namespaces = ['default', 'kube-system', 'pragmatic-system', 'pragmatic-idp-acme', 'pragmatic-env-old']

    public async Run(program: string, argv: readonly string[]): Promise<ProcessResult>
    {
        this.Calls.push([program, ...argv])
        if (program === 'helm' && argv.includes('install'))
        {
            this.Installed = true
            this.Namespaces = ['default', 'pragmatic-system', 'pragmatic-idp-' + Tenant]
            return new ProcessResult(0, '', '')
        }
        if (program === 'helm' && argv.includes('uninstall'))
        {
            return this.Installed ? new ProcessResult(0, '', '') : new ProcessResult(1, '', 'Error: uninstall: Release not loaded: pragmatic-engine: release: not found')
        }
        if (argv.includes('namespaces'))
        {
            return new ProcessResult(0, JSON.stringify({ items: this.Namespaces.map(name => ({ metadata: { name } })) }), '')
        }
        if (argv.includes('delete'))
        {
            this.Namespaces = this.Namespaces.filter(name => !argv.includes(name))
            this.Installed = false
            return new ProcessResult(0, '', '')
        }
        if (argv.includes('secret'))
        {
            const data = { email: Buffer.from(OwnerEmail).toString('base64'), password: Buffer.from(OwnerPassword).toString('base64') }
            return this.Installed ? new ProcessResult(0, JSON.stringify({ data }), '') : new ProcessResult(1, '', 'NotFound')
        }
        return new ProcessResult(1, '', 'unexpected')
    }
}

/** The platform behind the pages: what the cabinet and the engine console show as the leg acts. */
class LegWorld
{
    public readonly Browser = new FakeBrowser()
    public readonly Clock = new FakeClock()
    public readonly Waiter = new Waiter(this.Clock, 1000)
    public readonly Evidence = new TestEvidence()
    public readonly Runner = new FakeCluster()
    public readonly Context: JourneyContext
    public readonly ClientName = 'journey-run-0001'
    public Enrolled = false
    public Requested = false
    public Approved = false
    public SignedIn = false
    public Left = false
    public ConnectedLevel = ''

    public constructor(public readonly Path: JourneyPath)
    {
        this.Context = new JourneyContext('run-0001', Path)
        this.Context.Set(JourneyKeys.ClientName, this.ClientName)
        this.Context.Set(JourneyKeys.Tenant, Tenant)
        this.WireCabinet()
        this.WireConsole()
    }

    public get Delegated(): boolean
    {
        return this.Path === JourneyPath.Delegated
    }

    public get EnvironmentReady(): boolean
    {
        return this.Requested && (this.Delegated || this.Approved)
    }

    public Leg(): InstallAndEnrolLeg
    {
        const cabinet = new CabinetPage(Cabinet, this.Waiter)
        const identity = new JourneyIdentity(this.Path, 'pragmatic-lab.com', 's'.repeat(40))
        const session = new CustomerSession(this.Browser, cabinet, new CentralLoginPage('login.example', this.Waiter), identity, 'login.example', this.Waiter)
        return new InstallAndEnrolLeg(this.Browser, new CabinetHivesPage(session, cabinet, this.Waiter), new CustomerCluster(this.Runner, 'pragmatic-customer'), this.Waiter, this.Evidence.Evidence)
    }

    private CabinetTexts(): string[]
    {
        const H = CabinetHivesPage
        const texts = [CabinetPage.AccountTitle, this.ClientName, H.NavLabel, H.AddTitle, H.EnrolledLevel, H.StartButton]
        if (this.Enrolled)
        {
            texts.push(Hive, this.Left ? H.LeftText : H.HealthyText, H.LeaveButton, H.RequestTitle, H.RequestButton)
            texts.push(this.EnvironmentReady ? 'prod ready (1.2.0), journey ready' : 'prod ready (1.2.0)')
        }
        return texts
    }

    private ShowCabinet(extra: readonly string[] = []): void
    {
        this.Browser.Current.Show(Cabinet + CabinetPage.RootPath, [...this.CabinetTexts(), ...extra], [[CabinetHivesPage.EnvironmentSelector, this.Enrolled ? 1 : 0]])
    }

    private WireCabinet(): void
    {
        const p = this.Browser.Current
        const H = CabinetHivesPage
        p.OnGoto.set(Cabinet + CabinetPage.RootPath, () => this.ShowCabinet())
        p.OnClick.set(H.EnrolledLevel, () => this.ShowCabinet([H.DelegatedLevel]))
        p.OnClick.set(H.StartButton, () => this.ShowCabinet([
            Code,
            'helm install pragmatic-engine oci://ghcr.io/pragmatic-tech-ai/charts/pragmatic-engine --version 0.1.0-early.20',
            '--namespace pragmatic-system --create-namespace --set tenant.id=' + Tenant,
            '--set console.host=YOUR-CONSOLE-HOST --set tls.secretName=YOUR-TLS-SECRET',
        ]))
        p.OnClick.set(H.RequestButton, () =>
        {
            this.Requested = true
            this.ShowCabinet(['Requested environment `journey` on hive ' + Hive + '. An admin approves it.'])
        })
        p.OnClick.set(H.LeaveButton, () =>
        {
            this.Left = true
            this.ShowCabinet()
        })
    }

    private WireConsole(): void
    {
        const c = this.Browser.Console
        const E = EngineConsolePage
        const url = 'https://console-' + Tenant + '.localtest.me:28443/'
        const host = 'console-' + Tenant + '.localtest.me'
        c.OnGoto.set(url, () =>
        {
            if (!this.SignedIn)
            {
                c.Show('https://idp-' + Tenant + '.localtest.me:28443/login', [E.SignInButton], [[E.EmailSelector, 1], [E.PasswordSelector, 1]])
                return
            }
            const pending = this.Requested && !this.Delegated && !this.Approved
            c.Show(url, pending ? [E.OverviewConnection, '1 change to approve'] : [E.OverviewConnection])
        })
        c.OnClick.set(E.SignInButton, () =>
        {
            this.SignedIn = true
            c.Show(url, [E.OverviewConnection])
        })
        c.OnClick.set(E.OverviewConnection, () => c.Show(url, [E.ConnectButton, E.EnrolledLevel, host + E.AddressSuffix], [[E.CodeSelector, 1]]))
        c.OnClick.set(E.EnrolledLevel, () => c.Texts.add(E.DelegatedLevel))
        c.OnClick.set(E.DelegatedLevel, () => { this.ConnectedLevel = 'delegated' })
        c.OnClick.set(E.ConnectButton, () =>
        {
            this.Enrolled = true
            const level = this.ConnectedLevel === '' ? 'enrolled' : this.ConnectedLevel
            c.Show(url, ['Connected as hive ' + Hive + ' at level ' + level + '.'])
        })
        c.OnClick.set('1 change to approve', () => c.Show(url, [InstallAndEnrolLeg.CreateSentence, E.ApproveButton, 'Expires 2026-12-01 10:00 UTC']))
        c.OnClick.set(E.ApproveButton, () =>
        {
            this.Approved = true
            c.Show(url, [InstallAndEnrolLeg.CreateSentence, 'Applying'])
        })
    }
}

describe('InstallAndEnrolLeg', () =>
{
    it('the install command runs with argv from the page and no secret on argv', async () =>
    {
        const world = new LegWorld(JourneyPath.Enrolled)
        await world.Leg().Run(world.Context)
        const helm = world.Runner.Calls.filter(call => call[0] === 'helm' && call.includes('install'))
        assert.deepEqual(helm, [[
            'helm', '--kube-context', 'kind-pragmatic-customer', 'install', 'pragmatic-engine', EngineInstallCommand.Chart, '--version', '0.1.0-early.20',
            '--namespace', 'pragmatic-system', '--create-namespace', '--set', 'tenant.id=' + Tenant, '--set', 'console.host=console-' + Tenant + '.localtest.me',
            '--set', 'console.port=28443', '--set', 'tls.mode=self-signed', '--wait', '--timeout', '15m',
        ]])
        const everything = JSON.stringify(world.Runner.Calls) + JSON.stringify(world.Evidence.Sink.Lines) + JSON.stringify(world.Context.Get(JourneyKeys.Hive))
        assert.ok(!everything.includes(OwnerPassword), 'the Owner password reaches no argv, step or context')
        assert.ok(!everything.includes(Code), 'the enrolment code reaches no argv, step or context')
        assert.ok(world.Browser.Console.Calls.includes('fill ' + EngineConsolePage.PasswordSelector + '#0 ' + OwnerPassword), 'the password goes straight to the sign-in form')
        // The proof cluster is reset before the install: the engine's namespaces go.
        const deletion = world.Runner.Calls.find(call => call.includes('delete'))
        assert.deepEqual(deletion?.filter(arg => arg.startsWith('pragmatic-')), ['pragmatic-system', 'pragmatic-idp-acme', 'pragmatic-env-old'])
        world.Evidence.Folder.Dispose()
    })

    it('enrolled approves the environment intent in the console', async () =>
    {
        const world = new LegWorld(JourneyPath.Enrolled)
        await world.Leg().Run(world.Context)
        assert.equal(world.Context.Get(JourneyKeys.Hive), Hive)
        assert.equal(world.Context.Get(JourneyKeys.HiveState), JourneyState.HiveEnrolled)
        assert.equal(world.Approved, true)
        assert.ok(world.Browser.Console.Calls.includes('click ' + EngineConsolePage.ApproveButton))
        assert.equal(world.Context.Get(JourneyKeys.EnvironmentState), JourneyState.EnvironmentReady)
        assert.ok(world.Browser.Current.Calls.includes('fill ' + CabinetHivesPage.EnvironmentSelector + '#0 journey'))
        assert.ok(!world.Browser.Current.Calls.includes('click ' + CabinetHivesPage.DelegatedLevel), 'Enrolled is the cabinet\'s own choice')
        assert.ok(world.Evidence.Sink.Lines.some(line => line.includes('waited in the engine console\'s Approvals')))
        world.Evidence.Folder.Dispose()
    })

    it('delegated sees the environment without approval', async () =>
    {
        const world = new LegWorld(JourneyPath.Delegated)
        await world.Leg().Run(world.Context)
        assert.equal(world.Approved, false)
        assert.equal(world.ConnectedLevel, 'delegated')
        assert.ok(world.Browser.Current.Calls.includes('click ' + CabinetHivesPage.DelegatedLevel), 'the cabinet started a Delegated enrolment')
        assert.ok(!world.Browser.Console.Calls.includes('click ' + EngineConsolePage.ApproveButton))
        assert.equal(world.Context.Get(JourneyKeys.EnvironmentState), JourneyState.EnvironmentReady)
        assert.ok(world.Evidence.Sink.Lines.some(line => line.includes('without approval')))
        world.Evidence.Folder.Dispose()
    })

    it('a Delegated hive that asks for an approval fails the leg', async () =>
    {
        const world = new LegWorld(JourneyPath.Delegated)
        const consolePage = world.Browser.Console
        const url = 'https://console-' + Tenant + '.localtest.me:28443/'
        const previous = consolePage.OnGoto.get(url) as () => void
        consolePage.OnGoto.set(url, () =>
        {
            previous()
            if (world.SignedIn && world.Requested)
            {
                consolePage.Texts.add('1 change to approve')
            }
        })
        await assert.rejects(world.Leg().Run(world.Context), /a Delegated hive asked for an approval: 1 change to approve/)
        world.Evidence.Folder.Dispose()
    })

    it('clean uninstalls the chart and leaves the hive', async () =>
    {
        const world = new LegWorld(JourneyPath.Enrolled)
        const leg = world.Leg()
        await leg.Run(world.Context)
        world.Runner.Calls.splice(0)
        await leg.Clean(world.Context)
        assert.equal(world.Left, true)
        assert.ok(world.Browser.Current.Calls.includes('click ' + CabinetHivesPage.LeaveButton + ' near ' + Hive))
        assert.equal(world.Context.Get(JourneyKeys.HiveState), JourneyState.HiveLeft)
        assert.ok(world.Runner.Calls.some(call => call[0] === 'helm' && call.includes('uninstall')))
        assert.ok(world.Runner.Calls.some(call => call.includes('delete') && call.includes('pragmatic-system')))
        // A second clean (journey clean <run id>) does not leave again; the cluster reset is idempotent.
        world.Browser.Current.Calls.splice(0)
        await leg.Clean(world.Context)
        assert.ok(!world.Browser.Current.Calls.some(call => call.startsWith('click ' + CabinetHivesPage.LeaveButton)))
        world.Evidence.Folder.Dispose()
    })

    it('a clean after a run killed before any install has nothing to leave or reset', async () =>
    {
        const world = new LegWorld(JourneyPath.Enrolled)
        await world.Leg().Clean(world.Context)
        assert.equal(world.Runner.Calls.length, 0)
        assert.ok(world.Evidence.Sink.Lines.some(line => line.includes('no hive was enrolled')))
        world.Evidence.Folder.Dispose()
    })
})

describe('EngineInstallCommand', () =>
{
    it('reads the chart, version and tenant from the page and refuses another chart or tenant', () =>
    {
        const first = 'helm install pragmatic-engine oci://ghcr.io/pragmatic-tech-ai/charts/pragmatic-engine --version 0.1.0-early.20'
        const command = EngineInstallCommand.Parse(first, '--set tenant.id=' + Tenant, Tenant)
        assert.equal(command.Version, '0.1.0-early.20')
        assert.equal(command.ConsoleUrl, 'https://console-' + Tenant + '.localtest.me:28443/')
        assert.throws(() => EngineInstallCommand.Parse(first.replace('pragmatic-tech-ai/charts', 'evil/charts'), '--set tenant.id=' + Tenant, Tenant), /does not name the engine chart/)
        assert.throws(() => EngineInstallCommand.Parse(first, '--set tenant.id=other-tenant', Tenant), /another tenant/)
        assert.throws(() => EngineInstallCommand.Parse(first.replace('0.1.0-early.20', '$(rm -rf /)'), '--set tenant.id=' + Tenant, Tenant), /does not name the engine chart/)
    })
})
