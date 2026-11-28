import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JourneyBrowser } from '../drivers/journey-browser.js'
import { createServer } from 'node:tls'
import type { AddressInfo } from 'node:net'
import { CabinetHivesPage } from '../drivers/cabinet-hives-page.js'
import { CabinetPage } from '../drivers/cabinet-page.js'
import { CentralLoginPage } from '../drivers/central-login-page.js'
import { CustomerSession } from '../drivers/customer-session.js'
import { EngineConsolePage } from '../drivers/engine-console-page.js'
import { JourneyContext } from '../journey-context.js'
import { JourneyPath } from '../journey-path.js'
import { InstallAndEnrolLeg } from '../legs/install-and-enrol-leg.js'
import { JourneyKeys, JourneyState } from '../legs/journey-keys.js'
import { ConsoleTrust, type IConsoleTrust } from '../live/console-trust.js'
import { CustomerCluster } from '../live/customer-cluster.js'
import { EngineInstallCommand } from '../live/engine-install-command.js'
import { JourneyIdentity } from '../live/journey-identity.js'
import { NodeProcessRunner, ProcessResult, type IProcessRunner } from '../live/process-runner.js'
import { LegAbort, Waiter, WaitAbortError } from '../waiter.js'
import { FakeBrowser, FakeClock, TestEvidence } from './journey-fakes.js'

const Cabinet = 'https://cabinet.example'
const Tenant = 'journey-run-0001-e'
const Hive = 'hvabcdefghij'
const Code = 'pe1-ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const OwnerEmail = 'owner@localtest.me'
const OwnerPassword = 'Initial-Owner-Password-0123456789'
const DevCaPem = '-----BEGIN CERTIFICATE-----\nDEVCA\n-----END CERTIFICATE-----\n'
const ConsoleUrl = 'https://console-' + Tenant + '.localtest.me:28443/'
const ConsoleHost = 'console-' + Tenant + '.localtest.me'

/** helm and kubectl, standing in: records every argument vector; the cluster holds an engine once installed. */
class FakeCluster implements IProcessRunner
{
    public readonly Calls: string[][] = []
    public readonly Signals: (AbortSignal | undefined)[] = []
    public Installed = false
    public Namespaces = ['default', 'kube-system', 'pragmatic-system', 'pragmatic-idp-acme', 'pragmatic-env-old']

    public async Run(program: string, argv: readonly string[], _timeoutMs: number, signal?: AbortSignal): Promise<ProcessResult>
    {
        this.Calls.push([program, ...argv])
        this.Signals.push(signal)
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
        if (argv.includes(CustomerCluster.OwnerSecret))
        {
            const data = { email: Buffer.from(OwnerEmail).toString('base64'), password: Buffer.from(OwnerPassword).toString('base64') }
            return this.Installed ? new ProcessResult(0, JSON.stringify({ data }), '') : new ProcessResult(1, '', 'NotFound')
        }
        if (argv.includes(CustomerCluster.DevCaSecret))
        {
            return new ProcessResult(0, JSON.stringify({ data: { 'ca.crt': Buffer.from(DevCaPem).toString('base64') } }), '')
        }
        return new ProcessResult(1, '', 'unexpected')
    }
}

/** The certificate check, standing in: the pins of the hosts asked, verified against the CA given. */
class FakeTrust implements IConsoleTrust
{
    public readonly Asked: { Hosts: string[], Port: number, Ca: string }[] = []

    public async Pins(hosts: readonly string[], port: number, caPem: string): Promise<string[]>
    {
        this.Asked.push({ Hosts: [...hosts], Port: port, Ca: caPem })
        return hosts.map(host => 'pin-' + host)
    }
}

/** The platform behind the pages: what the cabinet and the engine console show as the leg acts. */
class LegWorld
{
    public readonly Browser = new FakeBrowser()
    public readonly Clock = new FakeClock()
    public readonly Abort = new LegAbort()
    public readonly Waiter = new Waiter(this.Clock, 1000, this.Abort)
    public readonly Evidence = new TestEvidence()
    public readonly Runner = new FakeCluster()
    public readonly Trust = new FakeTrust()
    public readonly Context: JourneyContext
    public readonly ClientName = 'journey-run-0001'
    public readonly OtherHive = 'hvzzzzzzzzzz'
    public Enrolled = false
    public Requests = 0
    public Approved = false
    public SignIns = 0
    public SignedIn = false
    public Left = new Set<string>()
    public OtherHiveListed = false
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

    public get Applied(): boolean
    {
        return this.Requests > 0 && (this.Delegated || this.Approved)
    }

    public Leg(): InstallAndEnrolLeg
    {
        const cabinet = new CabinetPage(Cabinet, this.Waiter)
        const identity = new JourneyIdentity(this.Path, 'pragmatic-lab.com', 's'.repeat(40))
        const session = new CustomerSession(this.Browser, cabinet, new CentralLoginPage('login.example', this.Waiter), identity, 'login.example', this.Waiter)
        return new InstallAndEnrolLeg(this.Browser, new CabinetHivesPage(session, cabinet, this.Browser, this.Waiter), new CustomerCluster(this.Runner, 'pragmatic-customer', this.Abort), this.Trust, this.Waiter, this.Evidence.Evidence)
    }

    private ShowCabinet(extra: readonly string[] = []): void
    {
        const H = CabinetHivesPage
        const p = this.Browser.Current
        const texts = [CabinetPage.AccountTitle, this.ClientName, H.NavLabel, H.AddTitle, H.EnrolledLevel, H.StartButton, ...extra]
        // Elsewhere on the page the words a row uses appear too: a row's state is read in its row only.
        texts.push('Healthy', 'journey ready')
        p.Rows.clear()
        const hives = [...(this.Enrolled ? [Hive] : []), ...(this.OtherHiveListed ? [this.OtherHive] : [])]
        for (const hive of hives)
        {
            const environments = hive === Hive && this.Applied ? 'prod ready (1.2.0), journey ready' : 'prod ready (1.2.0)'
            const row = [hive, this.Left.has(hive) ? H.LeftText : (hive === Hive ? H.HealthyText : 'Degraded'), H.LeaveButton, environments]
            texts.push(...row)
            p.Rows.set(hive, row)
        }
        if (hives.length > 0)
        {
            texts.push(H.RequestTitle, H.RequestButton)
        }
        p.Show(Cabinet + CabinetPage.RootPath, texts, [[H.EnvironmentSelector, hives.length > 0 ? 1 : 0]])
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
            this.Requests += 1
            this.ShowCabinet(['Requested environment `journey` on hive ' + Hive + '. An admin approves it.'])
        })
    }

    private ShowConsole(texts: string[], rows: [string, string[]][] = [], selectors: [string, number][] = []): void
    {
        const c = this.Browser.Console
        c.Show(ConsoleUrl, texts, selectors)
        c.Rows.clear()
        for (const [anchor, row] of rows)
        {
            c.Rows.set(anchor, row)
            c.Texts.add(anchor)
            row.forEach(text => c.Texts.add(text))
        }
    }

    private WireConsole(): void
    {
        const c = this.Browser.Console
        const E = EngineConsolePage
        const sentence = InstallAndEnrolLeg.CreateSentence
        c.OnGoto.set(ConsoleUrl, () =>
        {
            if (!this.SignedIn)
            {
                c.Show('https://idp-' + Tenant + '.localtest.me:28443/login', [E.SignInButton, E.PasswordLabel], [[E.EmailSelector, 1], [E.PasswordSelector, 1]])
                return
            }
            const pending = this.Requests > 0 && !this.Delegated && !this.Approved
            this.ShowConsole(pending ? [E.OverviewConnection, '1 change to approve'] : [E.OverviewConnection])
        })
        c.OnClick.set(E.SignInButton, () =>
        {
            this.SignIns += 1
            this.SignedIn = true
            this.ShowConsole([E.OverviewConnection])
        })
        c.OnClick.set(E.OverviewConnection, () =>
        {
            if (this.Enrolled)
            {
                this.ShowConsole(['Connected', E.ChangesButton])
                return
            }
            this.ShowConsole([E.ConnectButton, E.EnrolledLevel, ConsoleHost + E.AddressSuffix], [], [[E.CodeSelector, 1]])
        })
        c.OnClick.set(E.EnrolledLevel, () => c.Texts.add(E.DelegatedLevel))
        c.OnClick.set(E.DelegatedLevel, () => { this.ConnectedLevel = 'delegated' })
        c.OnClick.set(E.ConnectButton, () =>
        {
            this.Enrolled = true
            const level = this.ConnectedLevel === '' ? 'enrolled' : this.ConnectedLevel
            this.ShowConsole(['Connected as hive ' + Hive + ' at level ' + level + '.'])
        })
        const approvals = (): void =>
        {
            const state = this.Applied ? 'Applied' : 'Waiting for approval'
            const row = this.Applied ? [state] : [state, E.ApproveButton]
            // The Approve word elsewhere on the page (another row) must not count for this one.
            this.ShowConsole([E.ApprovalsTitle, 'Approve'], [[sentence, row]])
        }
        c.OnClick.set('1 change to approve', approvals)
        c.OnClick.set(E.ChangesButton, approvals)
        c.OnClick.set(E.ApproveButton, () =>
        {
            this.Approved = true
            this.ShowConsole([E.ApprovalsTitle], [[sentence, ['Applying']]])
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
            '--namespace', 'pragmatic-system', '--create-namespace', '--set', 'tenant.id=' + Tenant, '--set', 'console.host=' + ConsoleHost,
            '--set', 'console.port=28443', '--set', 'tls.mode=self-signed', '--wait', '--timeout', '7m',
        ]])
        const everything = JSON.stringify(world.Runner.Calls) + JSON.stringify(world.Evidence.Sink.Lines) + JSON.stringify([...world.Browser.ConsolePins])
        assert.ok(!everything.includes(OwnerPassword), 'the Owner password reaches no argv, step or pin')
        assert.ok(!everything.includes(Code), 'the enrolment code reaches no argv or step')
        assert.ok(world.Browser.Console.Calls.includes('fill ' + EngineConsolePage.PasswordSelector + '#0 ' + OwnerPassword), 'the password goes straight to the sign-in form')
        assert.equal(world.SignIns, 1, 'the sign-in form is submitted once')
        const deletion = world.Runner.Calls.find(call => call.includes('delete'))
        assert.deepEqual(deletion?.filter(arg => arg.startsWith('pragmatic-')), ['pragmatic-system', 'pragmatic-idp-acme', 'pragmatic-env-old'])
        assert.ok(world.Runner.Signals.every(signal => signal instanceof AbortSignal), 'every program runs under the leg\'s abort')
        world.Evidence.Folder.Dispose()
    })

    it('the console is trusted only for the keys that chain to the engine\'s development CA', async () =>
    {
        const world = new LegWorld(JourneyPath.Enrolled)
        await world.Leg().Run(world.Context)
        assert.deepEqual(world.Trust.Asked[0], { Hosts: [ConsoleHost, 'idp-' + Tenant + '.localtest.me'], Port: 28443, Ca: DevCaPem.trim() })
        assert.deepEqual(world.Browser.ConsolePins[0], ['pin-' + ConsoleHost, 'pin-idp-' + Tenant + '.localtest.me'])
        world.Evidence.Folder.Dispose()
    })

    it('enrolled approves the environment intent in its row in the console', async () =>
    {
        const world = new LegWorld(JourneyPath.Enrolled)
        await world.Leg().Run(world.Context)
        assert.equal(world.Context.Get(JourneyKeys.Hive), Hive)
        assert.equal(world.Approved, true)
        assert.ok(world.Browser.Console.Calls.includes('click ' + EngineConsolePage.ApproveButton + ' near ' + InstallAndEnrolLeg.CreateSentence))
        assert.equal(world.Context.Get(JourneyKeys.EnvironmentState), JourneyState.EnvironmentReady)
        assert.equal(world.Requests, 1, 'one request, one intent')
        assert.ok(!world.Browser.Current.Calls.includes('click ' + CabinetHivesPage.DelegatedLevel), 'Enrolled is the cabinet\'s own choice')
        assert.ok(world.Evidence.Sink.Lines.some(line => line.includes('lists the change once, applied, with no Approve')))
        world.Evidence.Folder.Dispose()
    })

    it('delegated sees the environment without approval, and the change listed applied', async () =>
    {
        const world = new LegWorld(JourneyPath.Delegated)
        await world.Leg().Run(world.Context)
        assert.equal(world.Approved, false)
        assert.equal(world.ConnectedLevel, 'delegated')
        assert.ok(world.Browser.Current.Calls.includes('click ' + CabinetHivesPage.DelegatedLevel))
        assert.ok(!world.Browser.Console.Calls.some(call => call.startsWith('click ' + EngineConsolePage.ApproveButton)))
        assert.ok(world.Browser.Console.Calls.includes('click ' + EngineConsolePage.ChangesButton))
        assert.ok(world.Evidence.Sink.Lines.some(line => line.includes('without approval')))
        world.Evidence.Folder.Dispose()
    })

    it('a hive row that is not Healthy is not taken for healthy by the word elsewhere on the page', async () =>
    {
        const world = new LegWorld(JourneyPath.Enrolled)
        const page = world.Browser.Current
        world.OtherHiveListed = true
        await page.Goto(Cabinet + CabinetPage.RootPath)
        const hives = new CabinetHivesPage(undefined as never, undefined as never, world.Browser, world.Waiter)
        assert.equal(await hives.IsHealthy(page, world.OtherHive), false, 'the other row says Degraded')
        assert.equal(await hives.IsEnvironmentReady(page, world.OtherHive, 'journey'), false)
        world.Evidence.Folder.Dispose()
    })

    it('no failure screenshot is taken while the enrolment code is shown; the page leaves it once read', async () =>
    {
        const world = new LegWorld(JourneyPath.Enrolled)
        const page = world.Browser.Current
        page.OnClick.set(CabinetHivesPage.StartButton, () => page.Texts.add(Code))
        const leg = world.Leg()
        await assert.rejects(leg.Run(world.Context), /the cabinet to show the enrolment code and install command/)
        assert.equal(world.Browser.ScreenshotsHidden, true, 'the code is still on screen')
        assert.deepEqual(await world.Browser.Capture('install-and-enrol'), [])
        assert.equal(world.Browser.Captures, 0)
        const healthy = new LegWorld(JourneyPath.Enrolled)
        await healthy.Leg().Run(healthy.Context)
        assert.equal(healthy.Browser.ScreenshotsHidden, false, 'shown again once the page moved away from the code')
        const start = healthy.Browser.Current.Calls.indexOf('click ' + CabinetHivesPage.StartButton)
        assert.equal(healthy.Browser.Current.Calls[start + 1], 'goto ' + Cabinet + CabinetPage.RootPath, 'the next step leaves the page with the code')
        world.Evidence.Folder.Dispose()
        healthy.Evidence.Folder.Dispose()
    })

    it('clean leaves every hive of the run that has not left, and resets the cluster even when leaving fails', async () =>
    {
        const world = new LegWorld(JourneyPath.Enrolled)
        const leg = world.Leg()
        await leg.Run(world.Context)
        world.OtherHiveListed = true
        const page = world.Browser.Current
        const near = page.ClickTextNear.bind(page)
        page.ClickTextNear = async (text: string, anchor: string): Promise<void> =>
        {
            await near(text, anchor)
            if (text === CabinetHivesPage.LeaveButton)
            {
                world.Left.add(anchor)
            }
        }
        world.Runner.Calls.splice(0)
        await leg.Clean(world.Context)
        assert.deepEqual([...world.Left].sort(), [Hive, world.OtherHive].sort())
        assert.equal(world.Context.Get(JourneyKeys.HiveState), JourneyState.HiveLeft)
        assert.ok(world.Runner.Calls.some(call => call[0] === 'helm' && call.includes('uninstall')))
        // A second clean leaves nothing again, but still resets.
        page.Calls.splice(0)
        world.Runner.Calls.splice(0)
        await leg.Clean(world.Context)
        assert.ok(!page.Calls.some(call => call.startsWith('click ' + CabinetHivesPage.LeaveButton)))
        assert.ok(world.Runner.Calls.some(call => call.includes('uninstall')))
        // Leaving that throws still resets.
        const failing = new LegWorld(JourneyPath.Enrolled)
        const failingLeg = failing.Leg()
        await failingLeg.Run(failing.Context)
        failing.Browser.Current.ClickTextNear = async (): Promise<void> => { throw new Error('the cabinet is down') }
        failing.Runner.Calls.splice(0)
        await assert.rejects(failingLeg.Clean(failing.Context), /the cabinet is down/)
        assert.ok(failing.Runner.Calls.some(call => call.includes('uninstall')), 'the reset runs in a finally')
        world.Evidence.Folder.Dispose()
        failing.Evidence.Folder.Dispose()
    })

    it('a clean after a run killed before any install has nothing to leave or reset', async () =>
    {
        const world = new LegWorld(JourneyPath.Enrolled)
        await world.Leg().Clean(world.Context)
        assert.equal(world.Runner.Calls.length, 0)
        assert.ok(world.Evidence.Sink.Lines.some(line => line.includes('no hive of the run is left to leave')))
        world.Evidence.Folder.Dispose()
    })

    it('an aborted leg runs no further program', async () =>
    {
        const world = new LegWorld(JourneyPath.Enrolled)
        world.Abort.Trip()
        await assert.rejects(new CustomerCluster(world.Runner, 'pragmatic-customer', world.Abort).Reset(), WaitAbortError)
        assert.equal(world.Runner.Calls.length, 0)
        world.Evidence.Folder.Dispose()
    })

    it('the deadline is the sum of the steps\' budgets plus slack, within the per-path share of the run', () =>
    {
        const leg = new LegWorld(JourneyPath.Enrolled).Leg()
        const sum = InstallAndEnrolLeg.StepBudgetsMs.reduce((total, ms) => total + ms, 0)
        assert.equal(leg.DeadlineMs, sum + InstallAndEnrolLeg.SlackMs)
        assert.ok(leg.DeadlineMs <= 35 * 60_000, 'at most 35 minutes per customer-cluster path')
    })
})

describe('NodeProcessRunner', () =>
{
    it('an aborted signal kills the program and the call settles only after it exited', async () =>
    {
        const folder = mkdtempSync(join(tmpdir(), 'runner-'))
        const pidFile = join(folder, 'pid')
        try
        {
            const controller = new AbortController()
            const started = Date.now()
            const script = 'require("fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 60000)'
            const running = new NodeProcessRunner().Run(process.execPath, ['-e', script, pidFile], 120_000, controller.signal)
            while (!existsSync(pidFile))
            {
                await new Promise(resolve => setTimeout(resolve, 20))
            }
            controller.abort()
            const result = await running
            assert.notEqual(result.Code, 0)
            assert.ok(Date.now() - started < 30_000, 'it did not run to its end')
            const pid = Number(readFileSync(pidFile, 'utf8'))
            assert.throws(() => process.kill(pid, 0), 'the child is gone when the call settles')
        }
        finally
        {
            rmSync(folder, { recursive: true, force: true })
        }
    })
})

describe('the journey browser and the cluster reset', () =>
{
    it('a reset browser shows its screenshots again', async () =>
    {
        const evidence = new TestEvidence()
        const browser = new JourneyBrowser(evidence.Evidence, false)
        browser.HideScreenshots(true)
        await browser.Reset()
        assert.equal(browser.ScreenshotsHidden, false)
        const fake = new FakeBrowser()
        fake.HideScreenshots(true)
        await fake.Reset()
        assert.equal(fake.ScreenshotsHidden, false)
        evidence.Folder.Dispose()
    })

    it('Reset\'s program deadlines fit inside its budget', () =>
    {
        assert.ok(CustomerCluster.ResetTimeoutsMs.reduce((sum, ms) => sum + ms, 0) <= CustomerCluster.ResetBudgetMs)
    })

    it('an unreadable Secret is named as such, not as a missing Owner sign-in', async () =>
    {
        const runner: IProcessRunner = { Run: async () => new ProcessResult(0, 'not json', '') }
        await assert.rejects(new CustomerCluster(runner, 'pragmatic-customer').DevCa(), /the engine Secret is not readable JSON: pragmatic-tls-dev-ca/)
    })

    it('a clean whose leave and reset both fail reports both', async () =>
    {
        const world = new LegWorld(JourneyPath.Enrolled)
        const leg = world.Leg()
        await leg.Run(world.Context)
        world.Browser.Current.ClickTextNear = async (): Promise<void> => { throw new Error('the cabinet is down') }
        const run = world.Runner.Run.bind(world.Runner)
        world.Runner.Run = async (program, argv, timeoutMs, signal) => argv.includes('uninstall') ? new ProcessResult(2, '', 'boom') : run(program, argv, timeoutMs, signal)
        await assert.rejects(leg.Clean(world.Context), (error: unknown) => error instanceof AggregateError && error.errors.length === 2 && /the cabinet is down/.test(error.message) && /helm uninstall failed/.test(error.message))
        world.Evidence.Folder.Dispose()
    })
})

describe('ConsoleTrust', () =>
{
    const Fixture = (name: string): string => readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8')

    it('pins the served certificate when it chains to the CA and names the host; refuses another CA or host', async () =>
    {
        const server = createServer({ cert: Fixture('fixture-leaf.crt'), key: Fixture('fixture-leaf.key') }, socket => socket.end())
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
        try
        {
            const port = (server.address() as AddressInfo).port
            const trust = new ConsoleTrust()
            const pins = await trust.Pins(['console-acme.localtest.me', 'idp-acme.localtest.me'], port, Fixture('fixture-ca.crt'))
            const der = Buffer.from(Fixture('fixture-leaf.crt').replace(/-----[A-Z ]+-----|\s/g, ''), 'base64')
            assert.deepEqual(pins, [ConsoleTrust.PinOfCertificate(der)], 'one pin: both hosts serve the same certificate')
            await assert.rejects(trust.Pins(['console-acme.localtest.me'], port, Fixture('other-ca.crt')), /does not chain to the engine's development CA/)
            await assert.rejects(trust.Pins(['elsewhere.localtest.me'], port, Fixture('fixture-ca.crt')), /does not chain/)
        }
        finally
        {
            await new Promise<void>(resolve => server.close(() => resolve()))
        }
    })
})

describe('EngineInstallCommand', () =>
{
    it('reads the chart, version and tenant from the page and refuses another chart or tenant', () =>
    {
        const first = 'helm install pragmatic-engine oci://ghcr.io/pragmatic-tech-ai/charts/pragmatic-engine --version 0.1.0-early.20'
        const command = EngineInstallCommand.Parse(first, '--set tenant.id=' + Tenant, Tenant)
        assert.equal(command.Version, '0.1.0-early.20')
        assert.equal(command.ConsoleUrl, ConsoleUrl)
        assert.equal(command.IdpHost, 'idp-' + Tenant + '.localtest.me')
        assert.throws(() => EngineInstallCommand.Parse(first.replace('pragmatic-tech-ai/charts', 'evil/charts'), '--set tenant.id=' + Tenant, Tenant), /does not name the engine chart/)
        assert.throws(() => EngineInstallCommand.Parse(first, '--set tenant.id=other-tenant', Tenant), /another tenant/)
        assert.throws(() => EngineInstallCommand.Parse(first.replace('0.1.0-early.20', '$(rm -rf /)'), '--set tenant.id=' + Tenant, Tenant), /does not name the engine chart/)
    })
})
