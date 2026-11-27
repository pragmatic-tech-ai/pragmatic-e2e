import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CabinetDomainsPage } from '../drivers/cabinet-domains-page.js'
import { CabinetPage } from '../drivers/cabinet-page.js'
import { CentralLoginPage } from '../drivers/central-login-page.js'
import { CustomerSession } from '../drivers/customer-session.js'
import { JourneyContext } from '../journey-context.js'
import { JourneyDependency } from '../journey-dependency.js'
import { JourneyPath } from '../journey-path.js'
import { DomainLeg } from '../legs/domain-leg.js'
import { JourneyKeys, JourneyLegName, JourneyState } from '../legs/journey-keys.js'
import { ForeignZoneError, type IJourneyDns } from '../live/journey-dns.js'
import { JourneyIdentity } from '../live/journey-identity.js'
import { Waiter } from '../waiter.js'
import { FakeBrowser, FakeClock, TestEvidence } from './journey-fakes.js'

const Cabinet = 'https://cabinet.example'
const RunId = 'run-0001'
const ClientName = 'journey-run-0001'
const Domain = 'run-0001.journey.pragmatic-lab.com'
const TxtName = '_pragmatic-verify.' + Domain
const TxtValue = 'pragmatic-verify=abc123'

/** The journey's DNS, standing in: the records written, in memory; names outside the subdomain are refused. */
class FakeDns implements IJourneyDns
{
    public readonly Records = new Map<string, string>()
    public readonly Calls: string[] = []
    /** Called after each write (the zone's answer becomes visible to the platform). */
    public OnUpsert: (() => void) | undefined

    public async UpsertTxt(name: string, value: string): Promise<void>
    {
        this.Calls.push('upsert ' + name)
        if (!name.endsWith('.journey.pragmatic-lab.com'))
        {
            throw new ForeignZoneError(name)
        }
        this.Records.set(name, value)
        this.OnUpsert?.()
    }

    public async DeleteTxt(name: string): Promise<number>
    {
        this.Calls.push('delete ' + name)
        return this.Records.delete(name) ? 1 : 0
    }
}

/** The cabinet behind the page: the account page, the Email domains section and a platform that looks the record up. */
class DomainScenario
{
    public readonly Browser = new FakeBrowser()
    public readonly Page = this.Browser.Current
    public readonly Evidence = new TestEvidence()
    public readonly Clock = new FakeClock()
    public readonly Waiter = new Waiter(this.Clock, 1000)
    public readonly Identity = new JourneyIdentity(JourneyPath.Enrolled, 'pragmatic-lab.com', 's'.repeat(40))
    public readonly CabinetPage = new CabinetPage(Cabinet, this.Waiter)
    public readonly Login = new CentralLoginPage('login.example', this.Waiter)
    public readonly Session = new CustomerSession(this.Browser, this.CabinetPage, this.Login, this.Identity, 'login.example', this.Waiter)
    public readonly Dns = new FakeDns()
    public readonly Context = new JourneyContext(RunId, JourneyPath.Enrolled)
    /** The answers of each press of Check, in turn; past the end the platform looks the zone up. */
    public readonly CheckAnswers: string[] = []
    /** What each press of "Get the DNS record" answers, in turn (a refusal text); past the end the record shows. */
    public readonly StartAnswers: string[] = []
    public Starts = 0
    public Checks = 0
    private verified = false

    public constructor()
    {
        const D = CabinetDomainsPage
        this.Context.Set(JourneyKeys.ClientName, ClientName)
        this.Page.OnGoto.set(Cabinet + CabinetPage.RootPath, () => this.ShowAccount())
        this.Page.OnClick.set(D.NavLabel, () => this.ShowForm([]))
        this.Page.OnClick.set(D.StartButton, () => this.Start())
        this.Page.OnClick.set(D.CheckButton, () => this.Check())
    }

    public Leg(): DomainLeg
    {
        return new DomainLeg(new CabinetDomainsPage(this.Session, this.CabinetPage, this.Waiter), this.Dns, this.Evidence.Evidence)
    }

    private ShowAccount(): void
    {
        this.Page.Show(Cabinet + CabinetPage.RootPath, [CabinetPage.AccountTitle, ClientName, CabinetPage.RefreshButton, CabinetPage.ActiveState, CabinetDomainsPage.NavLabel])
    }

    private ShowForm(extra: readonly string[]): void
    {
        const D = CabinetDomainsPage
        this.Page.Show(Cabinet + CabinetPage.RootPath, [D.NavLabel, D.FormTitle, D.StartButton, ...extra], [[D.DomainSelector, 1]])
    }

    private Start(): void
    {
        const D = CabinetDomainsPage
        this.Starts++
        const answer = this.StartAnswers.shift()
        if (answer !== undefined)
        {
            this.ShowForm([answer])
            return
        }
        this.ShowForm([Domain, D.PendingText, D.CheckButton, 'TXT', TxtName, TxtValue])
    }

    private Check(): void
    {
        const D = CabinetDomainsPage
        this.Checks++
        const answer = this.CheckAnswers.shift()
        this.verified = answer === undefined && this.Dns.Records.get(TxtName) === TxtValue
        this.ShowForm([Domain, this.verified ? D.VerifiedText : answer ?? D.NotVerifiedText, D.CheckButton, 'TXT', TxtName, TxtValue])
    }
}

describe('DomainLeg', () =>
{
    it('is the domain leg, waiting on the entitlement delivery and the journey DNS', () =>
    {
        const s = new DomainScenario()
        const leg = s.Leg()
        assert.equal(leg.Name, JourneyLegName.Domain)
        assert.deepEqual(leg.Dependencies, [JourneyDependency.EntitlementDelivery, JourneyDependency.JourneyDns])
        s.Evidence.Folder.Dispose()
    })

    it('starts verification for the run\'s domain, writes the TXT the cabinet asked for, checks and reaches verified', async () =>
    {
        const s = new DomainScenario()
        await s.Leg().Run(s.Context)
        assert.ok(s.Page.Calls.includes('fill ' + CabinetDomainsPage.DomainSelector + '#0 ' + Domain), 'the run\'s domain was entered')
        assert.deepEqual(s.Dns.Calls, ['upsert ' + TxtName])
        assert.equal(s.Dns.Records.get(TxtName), TxtValue)
        assert.equal(s.Checks, 1)
        assert.equal(s.Context.Get(JourneyKeys.Domain), Domain)
        assert.equal(s.Context.Get(JourneyKeys.DomainTxtName), TxtName)
        assert.equal(s.Context.Get(JourneyKeys.DomainState), JourneyState.DomainVerified)
        s.Evidence.Folder.Dispose()
    })

    it('presses Check again at the slow pace while the platform does not see the record yet', async () =>
    {
        const s = new DomainScenario()
        s.CheckAnswers.push(CabinetDomainsPage.NotVerifiedText, CabinetDomainsPage.PendingText)
        await s.Leg().Run(s.Context)
        assert.equal(s.Checks, 3)
        assert.equal(s.Context.Get(JourneyKeys.DomainState), JourneyState.DomainVerified)
        assert.ok(s.Clock.Slept >= 2 * CabinetDomainsPage.CheckIntervalMs)
        s.Evidence.Folder.Dispose()
    })

    it('records the domain and the record\'s name before the DNS write, so a killed run can clean', async () =>
    {
        const s = new DomainScenario()
        let seen: { Domain?: string, Name?: string, State?: string } = {}
        s.Dns.OnUpsert = () =>
        {
            seen = { Domain: s.Context.Get(JourneyKeys.Domain), Name: s.Context.Get(JourneyKeys.DomainTxtName), State: s.Context.Get(JourneyKeys.DomainState) }
            throw new Error('killed after the write')
        }
        await assert.rejects(s.Leg().Run(s.Context), /killed/)
        assert.deepEqual(seen, { Domain, Name: TxtName, State: JourneyState.DomainChallenged })
        await s.Leg().Clean(s.Context)
        assert.equal(s.Dns.Records.has(TxtName), false, 'the record written before the kill is deleted')
        s.Evidence.Folder.Dispose()
    })

    it('fails at once on a final refusal and writes no record', async () =>
    {
        const s = new DomainScenario()
        s.StartAnswers.push('That domain is already verified by another tenant.')
        await assert.rejects(s.Leg().Run(s.Context), /already verified by another tenant/)
        assert.deepEqual(s.Dns.Calls, [])
        assert.equal(s.Context.Get(JourneyKeys.DomainTxtName), undefined)
        s.Evidence.Folder.Dispose()
    })

    it('presses Get the DNS record again after a waited refusal', async () =>
    {
        const s = new DomainScenario()
        s.StartAnswers.push(CabinetPage.NotAdminError)
        await s.Leg().Run(s.Context)
        assert.equal(s.Starts, 2)
        assert.equal(s.Context.Get(JourneyKeys.DomainState), JourneyState.DomainVerified)
        s.Evidence.Folder.Dispose()
    })

    it('cleans by deleting the TXT record, and does nothing when none was written', async () =>
    {
        const s = new DomainScenario()
        await s.Leg().Clean(s.Context)
        assert.deepEqual(s.Dns.Calls, [])
        await s.Leg().Run(s.Context)
        await s.Leg().Clean(s.Context)
        assert.deepEqual(s.Dns.Calls, ['upsert ' + TxtName, 'delete ' + TxtName])
        assert.equal(s.Dns.Records.size, 0)
        s.Evidence.Folder.Dispose()
    })

    it('names the run\'s domain under the journey subdomain, in lower case', () =>
    {
        assert.equal(DomainLeg.DomainFor('Run-0001'), Domain)
    })
})
