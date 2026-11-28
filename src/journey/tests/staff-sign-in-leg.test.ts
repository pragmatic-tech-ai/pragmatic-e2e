import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EngineConsolePage } from '../drivers/engine-console-page.js'
import { TenantConsolePage } from '../drivers/tenant-console-page.js'
import { JourneyContext } from '../journey-context.js'
import { JourneyDependency } from '../journey-dependency.js'
import { JourneyPath } from '../journey-path.js'
import { JourneyKeys, JourneyLegName, JourneyState } from '../legs/journey-keys.js'
import { StaffSignInLeg } from '../legs/staff-sign-in-leg.js'
import type { IConsoleTrust } from '../live/console-trust.js'
import { CustomerCluster } from '../live/customer-cluster.js'
import { FixedEngineClusterSource, type IEngineClusterSource } from '../live/engine-secrets.js'
import { HostAliases, HostedClusters, HostedEngineClusterSource } from '../live/hosted-cluster.js'
import { JourneyIdentity } from '../live/journey-identity.js'
import { ProcessResult, type IProcessRunner } from '../live/process-runner.js'
import { Waiter } from '../waiter.js'
import { FakeBrowser, FakeClock, FakeStarter, TempFolder, TestEvidence } from './journey-fakes.js'

/** A clock whose sleeping is the environment provisioning: it calls `OnSleep` once per sleep. */
class ProvisioningClock extends FakeClock
{
    public OnSleep: () => void = () => undefined

    public override async Sleep(ms: number): Promise<void>
    {
        await super.Sleep(ms)
        this.OnSleep()
    }
}

const RunId = 'run-0001'
const Tenant = 'journey-run-0001-e'
const ConsoleHost = 'console-' + Tenant + '.localtest.me'
const IdpHost = 'idp-' + Tenant + '.localtest.me'
const ConsoleUrl = 'https://' + ConsoleHost + ':28443/'
const Environment = 'journey'
const OwnerEmail = 'owner@localtest.me'
const OwnerPassword = 'Initial-Owner-Password-0123456789'
const StaffEmail = 'staff@' + RunId + '.journey.pragmatic-lab.com'
const Seed = 's'.repeat(40)
const Principal = 'staff-' + RunId
const AdminBase = '/tenant-api/environments/' + Environment + '/admin'

/** kubectl, standing in: the engine's Owner Secret and development CA. */
class FakeKubectl implements IProcessRunner
{
    public async Run(_program: string, argv: readonly string[], _timeoutMs: number): Promise<ProcessResult>
    {
        if (argv.includes(CustomerCluster.OwnerSecret))
        {
            const data = { email: Buffer.from(OwnerEmail).toString('base64'), password: Buffer.from(OwnerPassword).toString('base64') }
            return new ProcessResult(0, JSON.stringify({ data }), '')
        }
        if (argv.includes(CustomerCluster.DevCaSecret))
        {
            return new ProcessResult(0, JSON.stringify({ data: { 'ca.crt': Buffer.from('PEM').toString('base64') } }), '')
        }
        return new ProcessResult(1, '', 'unexpected')
    }
}

class FakeTrust implements IConsoleTrust
{
    public readonly Ports: number[] = []

    public async Pins(hosts: readonly string[], port: number, _caPem: string): Promise<string[]>
    {
        this.Ports.push(port)
        return hosts.map(host => 'pin-' + host)
    }
}

/** The engine console behind two pages: the Owner's and the staff user's fresh context. */
class StaffWorld
{
    public readonly Browser = new FakeBrowser()
    public readonly Owner = this.Browser.Console
    public readonly Staff = this.Browser.Fresh
    public readonly Evidence = new TestEvidence()
    public readonly Clock = new ProvisioningClock()
    public readonly Waiter = new Waiter(this.Clock, 1000)
    public readonly Identity = new JourneyIdentity(JourneyPath.Enrolled, 'pragmatic-lab.com', Seed)
    public readonly Cluster = new CustomerCluster(new FakeKubectl(), 'pragmatic-customer')
    public readonly Trust = new FakeTrust()
    public Source: IEngineClusterSource = new FixedEngineClusterSource(this.Cluster)
    public readonly Context: JourneyContext
    public readonly ExpectedPassword = this.Identity.StaffPassword(StaffEmail)
    public Created = false
    public Granted = false
    public Disabled = false
    public Creates = 0
    public Disables = 0
    public GrantPosts = 0
    /** The environment `journey` is listed on the Environments page. */
    public EnvListed = false
    /** It reports Running and Healthy. */
    public EnvReady = false
    public EnvCreates = 0
    public EnvDialogOpen = false
    /** How many page looks the environment takes to become ready after its creation. */
    public ProvisionSleeps = 3
    public Provisioned = -1

    public constructor(public readonly Path: JourneyPath = JourneyPath.Enrolled)
    {
        this.Context = new JourneyContext(RunId, Path)
        this.Context.Set(JourneyKeys.ConsoleUrl, ConsoleUrl)
        this.Context.Set(JourneyKeys.ConsoleHost, ConsoleHost)
        this.Context.Set(JourneyKeys.IdpHost, IdpHost)
        this.Clock.OnSleep = () => this.Provision()
        this.WireOwner()
        this.WireStaff()
    }

    public Leg(): StaffSignInLeg
    {
        const dependency = this.Path === JourneyPath.Hosted ? JourneyDependency.HostedPlacement : JourneyDependency.CustomerCluster
        return new StaffSignInLeg(this.Browser, this.Source, this.Trust, this.Identity, this.Waiter, this.Evidence.Evidence, dependency)
    }

    private WireOwner(): void
    {
        const T = TenantConsolePage
        const E = EngineConsolePage
        this.Owner.OnGoto.set(ConsoleUrl, () => this.Owner.Show(ConsoleUrl, [E.SignInButton, E.PasswordLabel], [[E.EmailSelector, 1], [E.PasswordSelector, 1]]))
        this.Owner.OnClick.set(E.SignInButton, () => this.Owner.Show(ConsoleUrl, [E.OverviewConnection, T.NavLabel, T.EnvironmentsNav]))
        this.Owner.OnClick.set(T.EnvironmentsNav, () => this.ShowEnvironments())
        this.Owner.OnClick.set(T.CreateEnvironmentLabel, () => this.CreateEnvironmentClicked())
        this.Owner.RequestJson = (method, path, body) => this.AdminApi(method, path, body)
    }

    /** The console's tenant-api behind the Owner's page: the admin snapshot, and the create, grant and disable routes. */
    private async AdminApi(method: string, path: string, body?: unknown): Promise<unknown>
    {
        this.Owner.RequestJsonCalls.push({ Method: method, Path: path, Body: body })
        if (method === 'GET' && path === AdminBase + '/snapshot')
        {
            return {
                accounts: this.Created ? [{ principalId: Principal, email: StaffEmail, disabled: this.Disabled }] : [],
                grants: this.Granted ? [{ subject: Principal, role: 'Admin', resourceKind: 'environment', resourcePath: [Environment] }] : [],
            }
        }
        if (method === 'POST' && path === AdminBase + '/accounts')
        {
            this.Creates++
            this.Created = true
        }
        else if (method === 'POST' && path === AdminBase + '/grants')
        {
            this.GrantPosts++
            this.Granted = true
        }
        else if (method === 'DELETE' && path === AdminBase + '/accounts/' + Principal)
        {
            this.Disables++
            this.Disabled = true
        }
        return null
    }

    private WireStaff(): void
    {
        const E = EngineConsolePage
        this.Staff.OnGoto.set(ConsoleUrl, () => this.Staff.Show(ConsoleUrl, [E.SignInButton, E.PasswordLabel], [[E.EmailSelector, 1], [E.PasswordSelector, 1]]))
        this.Staff.OnClick.set(E.SignInButton, () =>
        {
            const filledEmail = this.Staff.Calls.includes('fill ' + E.EmailSelector + '#0 ' + StaffEmail)
            const filledPassword = this.Staff.Calls.includes('fill ' + E.PasswordSelector + '#0 ' + this.ExpectedPassword)
            if (this.Created && this.Granted && !this.Disabled && filledEmail && filledPassword)
            {
                this.Staff.Show(ConsoleUrl, [E.OverviewConnection])
            }
        })
    }

    private ShowEnvironments(): void
    {
        const T = TenantConsolePage
        const texts: string[] = [T.NavLabel, T.EnvironmentsNav, T.CreateEnvironmentLabel]
        this.Owner.Rows.clear()
        if (this.EnvListed)
        {
            texts.push(Environment)
            const row = this.EnvReady ? [T.RunningStatus, T.HealthyStatus] : [T.UnknownStatus, T.UnknownStatus]
            texts.push(...row)
            this.Owner.Rows.set(Environment, row)
        }
        else
        {
            texts.push(T.NoEnvironmentsText)
        }
        this.Owner.Show(ConsoleUrl, texts)
    }

    private CreateEnvironmentClicked(): void
    {
        const T = TenantConsolePage
        if (!this.EnvDialogOpen)
        {
            this.EnvDialogOpen = true
            this.Owner.Show(ConsoleUrl, [...this.Owner.Texts, T.CancelLabel], [[T.EnvironmentNameSelector, 1]])
            return
        }
        this.EnvCreates++
        this.EnvListed = true
        this.EnvDialogOpen = false
        this.Provisioned = 0
        this.ShowEnvironments()
    }

    /** One look of the clock while the environment provisions. */
    private Provision(): void
    {
        if (this.Provisioned < 0 || this.EnvReady)
        {
            return
        }
        this.Provisioned++
        if (this.Provisioned >= this.ProvisionSleeps)
        {
            this.EnvReady = true
            this.ShowEnvironments()
        }
    }
}

describe('StaffSignInLeg', () =>
{
    it('creates the staff account, grants Admin and signs the staff user in through the realm in a fresh browser context', async () =>
    {
        const w = new StaffWorld()
        await w.Leg().Run(w.Context)
        const E = EngineConsolePage
        const T = TenantConsolePage
        assert.equal(w.Creates, 1)
        assert.ok(w.Granted)
        const posts = w.Owner.RequestJsonCalls.filter(c => c.Method === 'POST')
        assert.deepEqual(posts.find(c => c.Path === AdminBase + '/accounts')?.Body, { email: StaffEmail, principalId: Principal, password: w.ExpectedPassword })
        assert.deepEqual(posts.find(c => c.Path === AdminBase + '/grants')?.Body, { subject: Principal, role: 'Admin' })
        assert.equal(w.Context.Get(JourneyKeys.StaffEmail), StaffEmail)
        assert.equal(w.Context.Get(JourneyKeys.StaffState), JourneyState.StaffCreated)
        // The Owner signed in with the engine's initial sign-in (no password change is asked for it).
        assert.ok(w.Owner.Calls.includes('fill ' + E.PasswordSelector + '#0 ' + OwnerPassword))
        // Submit is the "Sign in" beside the password box, not the form's "Sign in" heading (the live idp-login shows both).
        assert.ok(w.Owner.Calls.includes('click ' + E.SignInButton + ' near ' + E.PasswordLabel))
        // The Owner created the environment first, in the dialog's own name box, and waited for it to run healthy.
        assert.equal(w.EnvCreates, 1)
        assert.ok(w.EnvReady)
        assert.ok(w.Owner.Calls.includes('fill ' + T.EnvironmentNameSelector + '#0 ' + Environment))
        assert.equal(w.Context.Get(JourneyKeys.Environment), Environment)
        assert.equal(w.Context.Get(JourneyKeys.EnvironmentState), JourneyState.EnvironmentReady)
        assert.ok(w.Owner.Calls.some(call => call.startsWith('click ' + T.CreateEnvironmentLabel + ' near')))
        const steps = w.Evidence.Sink.Lines.join('\n')
        assert.match(steps, /local/i)
        assert.ok(!JSON.stringify(w.Evidence.Sink.Lines).includes(w.ExpectedPassword))
        assert.ok(!steps.includes(w.ExpectedPassword) && !steps.includes(OwnerPassword))
        assert.ok(!JSON.stringify(w.Context).includes(w.ExpectedPassword))
        w.Evidence.Folder.Dispose()
    })

    it('records the environment before creating it, and waits until it is ready', async () =>
    {
        const w = new StaffWorld()
        w.ProvisionSleeps = 5
        const seen: Array<string | undefined> = []
        const original = w.Owner.OnClick.get(TenantConsolePage.CreateEnvironmentLabel)!
        w.Owner.OnClick.set(TenantConsolePage.CreateEnvironmentLabel, () =>
        {
            seen.push(w.Context.Get(JourneyKeys.Environment))
            original()
        })
        await w.Leg().Run(w.Context)
        assert.ok(seen.length > 0 && seen.every(value => value === Environment))
        assert.ok(w.Clock.Slept >= 5000)
        w.Evidence.Folder.Dispose()
    })

    it('resumes: an environment already listed and ready is not created again', async () =>
    {
        const w = new StaffWorld()
        w.EnvListed = true
        w.EnvReady = true
        await w.Leg().Run(w.Context)
        assert.equal(w.EnvCreates, 0)
        assert.equal(w.Context.Get(JourneyKeys.EnvironmentState), JourneyState.EnvironmentReady)
        assert.equal(w.Creates, 1)
        w.Evidence.Folder.Dispose()
    })

    it('resumes: an environment listed but still provisioning is waited for, not created again', async () =>
    {
        const w = new StaffWorld()
        w.EnvListed = true
        w.Provisioned = 0
        await w.Leg().Run(w.Context)
        assert.equal(w.EnvCreates, 0)
        assert.ok(w.EnvReady)
        w.Evidence.Folder.Dispose()
    })

    it('fails when the environment never becomes ready', async () =>
    {
        const w = new StaffWorld()
        w.ProvisionSleeps = Number.MAX_SAFE_INTEGER
        await assert.rejects(() => w.Leg().Run(w.Context), /timed out/)
        assert.equal(w.Context.Get(JourneyKeys.Environment), Environment)
        assert.notEqual(w.Context.Get(JourneyKeys.EnvironmentState), JourneyState.EnvironmentReady)
        assert.equal(w.Creates, 0)
        w.Evidence.Folder.Dispose()
    })

    it('records the address before creating the account', async () =>
    {
        const w = new StaffWorld()
        w.Owner.RequestJson = async () =>
        {
            throw new Error('HTTP 500 boom')
        }
        await assert.rejects(() => w.Leg().Run(w.Context), /boom/)
        assert.equal(w.Context.Get(JourneyKeys.StaffEmail), StaffEmail)
        assert.equal(w.Context.Get(JourneyKeys.StaffState), undefined)
        assert.ok(w.Evidence.Sink.Lines.some(line => line.includes('landing url: ')))
        w.Evidence.Folder.Dispose()
    })

    it('resumes: a staff account already listed is not created again', async () =>
    {
        const w = new StaffWorld()
        w.Created = true
        w.EnvListed = true
        w.EnvReady = true
        await w.Leg().Run(w.Context)
        assert.equal(w.Creates, 0)
        assert.ok(w.Granted)
        assert.equal(w.Context.Get(JourneyKeys.StaffState), JourneyState.StaffCreated)
        w.Evidence.Folder.Dispose()
    })

    it('does not grant twice when Admin is already granted', async () =>
    {
        const w = new StaffWorld()
        w.Created = true
        w.Granted = true
        w.EnvListed = true
        w.EnvReady = true
        await w.Leg().Run(w.Context)
        assert.equal(w.GrantPosts, 0)
        w.Evidence.Folder.Dispose()
    })

    it('records the console landing (url and body text) when the owner sign-in times out', async () =>
    {
        const w = new StaffWorld()
        w.Owner.OnClick.set(EngineConsolePage.SignInButton, () => undefined)
        await assert.rejects(() => w.Leg().Run(w.Context), /timed out/)
        const lines = w.Evidence.Sink.Lines
        assert.ok(lines.some(line => line.includes('landing url: ') && line.includes(ConsoleUrl)))
        assert.ok(lines.some(line => line.includes('landing body text: ') && line.includes(EngineConsolePage.SignInButton)))
        w.Evidence.Folder.Dispose()
    })

    it('declares the path\'s dependencies', () =>
    {
        const D = JourneyDependency
        const enrolled = new StaffWorld(JourneyPath.Enrolled)
        const hosted = new StaffWorld(JourneyPath.Hosted)
        assert.equal(enrolled.Leg().Name, JourneyLegName.StaffSignIn)
        assert.deepEqual(enrolled.Leg().Dependencies, [D.EntitlementDelivery, D.CustomerCluster, D.TenantRealm])
        assert.deepEqual(hosted.Leg().Dependencies, [D.EntitlementDelivery, D.HostedPlacement, D.TenantRealm])
        enrolled.Evidence.Folder.Dispose()
        hosted.Evidence.Folder.Dispose()
    })

    it('Clean disables the staff account from the context alone', async () =>
    {
        const w = new StaffWorld()
        w.Created = true
        w.Granted = true
        w.Context.Set(JourneyKeys.StaffEmail, StaffEmail)
        w.Context.Set(JourneyKeys.Environment, Environment)
        w.Context.Set(JourneyKeys.StaffState, JourneyState.StaffCreated)
        await w.Leg().Clean(w.Context)
        assert.equal(w.Disables, 1)
        assert.ok(w.Disabled)
        assert.ok(w.Owner.RequestJsonCalls.some(c => c.Method === 'DELETE' && c.Path === AdminBase + '/accounts/' + Principal))
        assert.equal(w.Context.Get(JourneyKeys.StaffState), JourneyState.StaffDisabled)
        w.Evidence.Folder.Dispose()
    })

    it('Clean has nothing to do when no staff account was recorded, or it is already disabled', async () =>
    {
        const w = new StaffWorld()
        await w.Leg().Clean(w.Context)
        assert.equal(w.Owner.Calls.length, 0)
        w.Context.Set(JourneyKeys.StaffEmail, StaffEmail)
        w.Context.Set(JourneyKeys.Environment, Environment)
        w.Context.Set(JourneyKeys.StaffState, JourneyState.StaffDisabled)
        await w.Leg().Clean(w.Context)
        assert.equal(w.Owner.Calls.length, 0)
        w.Evidence.Folder.Dispose()
    })

    it('Clean notes an account that was recorded but never listed', async () =>
    {
        const w = new StaffWorld()
        w.Context.Set(JourneyKeys.StaffEmail, StaffEmail)
        w.Context.Set(JourneyKeys.Environment, Environment)
        await w.Leg().Clean(w.Context)
        assert.equal(w.Disables, 0)
        assert.ok(w.Evidence.Sink.Lines.some(line => line.includes('not listed')))
        w.Evidence.Folder.Dispose()
    })
})

describe('JourneyIdentity.StaffPassword', () =>
{
    it('derives a stable, seed-bound password in the customer password shape, apart from it', () =>
    {
        const a = new JourneyIdentity(JourneyPath.Enrolled, 'pragmatic-lab.com', Seed)
        const b = new JourneyIdentity(JourneyPath.Enrolled, 'pragmatic-lab.com', Seed)
        const other = new JourneyIdentity(JourneyPath.Enrolled, 'pragmatic-lab.com', 'y'.repeat(40))
        assert.equal(a.StaffPassword(StaffEmail), b.StaffPassword(StaffEmail))
        assert.notEqual(a.StaffPassword(StaffEmail), other.StaffPassword(StaffEmail))
        assert.notEqual(a.StaffPassword(StaffEmail), a.StaffPassword('staff@other.journey.pragmatic-lab.com'))
        assert.notEqual(a.StaffPassword(a.Email), a.Password)
        assert.match(a.StaffPassword(StaffEmail), /^[A-Za-z0-9_-]{24}aA1!$/)
    })
})
