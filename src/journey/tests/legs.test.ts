import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CabinetPage } from '../drivers/cabinet-page.js'
import { CabinetTenantsPage } from '../drivers/cabinet-tenants-page.js'
import { CentralLoginPage } from '../drivers/central-login-page.js'
import { CustomerSession } from '../drivers/customer-session.js'
import { PaddleCheckout } from '../drivers/paddle-checkout.js'
import { WebsitePage } from '../drivers/website-page.js'
import { JourneyConfig } from '../journey-config.js'
import { JourneyContext } from '../journey-context.js'
import { JourneyDependency } from '../journey-dependency.js'
import { JourneyPath } from '../journey-path.js'
import { JourneyKeys, JourneyLegName, JourneyState } from '../legs/journey-keys.js'
import { JourneyLegInputs, JourneyLegs } from '../legs/journey-legs.js'
import { PayLeg } from '../legs/pay-leg.js'
import { PendingLeg } from '../legs/pending-leg.js'
import { RegisterLeg, type IUncleanedRuns } from '../legs/register-leg.js'
import { TenantLeg } from '../legs/tenant-leg.js'
import { VisitLeg } from '../legs/visit-leg.js'
import { CentralAccount } from '../live/central-account.js'
import { JourneyIdentity } from '../live/journey-identity.js'
import { Waiter } from '../waiter.js'
import { JourneyReport } from '../journey-report.js'
import { Journey, type IJourneyContextStore } from '../journey.js'
import { FakeBrowser, FakeClock, FakeFrame, TestEvidence, type FakePage } from './journey-fakes.js'

const Issuer = 'https://login.example/realms/central'
const Cabinet = 'https://cabinet.example'
const LoginUrl = 'https://login.example/realms/central/protocol/openid-connect/auth?x=1'
const Seed = 's'.repeat(40)

/** The central realm's Identity Platform: accounts by email; a sign-up through the page creates one, unverified. */
class Toolkit
{
    public readonly Accounts = new Map<string, { password: string, verified: boolean, checks: number }>()
    public VerifyAfterChecks = 2
    public Deletes = 0
    public SignIns = 0

    public readonly Fetch = async (input: string, init?: RequestInit): Promise<Response> =>
    {
        if (input.endsWith('/login/config'))
        {
            return Response.json({ identityPlatform: { apiKey: 'k' } })
        }
        const body = JSON.parse(String(init?.body)) as Record<string, string>
        if (input.includes('accounts:lookup'))
        {
            const looked = this.Accounts.get(body.idToken.split('.sig-')[1])
            if (looked === undefined)
            {
                return Response.json({ error: { message: 'USER_NOT_FOUND' } }, { status: 400 })
            }
            looked.checks++
            if (looked.checks >= this.VerifyAfterChecks)
            {
                looked.verified = true
            }
            return Response.json({ users: [{ emailVerified: looked.verified }] })
        }
        if (input.includes('accounts:delete'))
        {
            this.Deletes++
            this.Accounts.delete(body.idToken.split('.sig-')[1])
            return Response.json({})
        }
        const account = this.Accounts.get(body.email)
        if (account === undefined || account.password !== body.password)
        {
            return Response.json({ error: { message: 'INVALID_LOGIN_CREDENTIALS' } }, { status: 400 })
        }
        this.SignIns++
        const claims = Buffer.from(JSON.stringify({ email_verified: account.verified })).toString('base64url')
        return Response.json({ idToken: 'eyJhbGciOiJSUzI1NiJ9.' + claims + '.sig-' + body.email })
    }
}

/** Uncleaned earlier runs, as the run folder would list them. */
class Uncleaned implements IUncleanedRuns
{
    public readonly Runs: string[] = []

    public For(): readonly string[]
    {
        return this.Runs
    }
}

class Scenario
{
    public readonly Uncleaned = new Uncleaned()
    public readonly Browser = new FakeBrowser()
    public readonly Page: FakePage = this.Browser.Current
    public readonly Toolkit = new Toolkit()
    public readonly Evidence = new TestEvidence()
    public readonly Waiter = new Waiter(new FakeClock(), 1000)
    public readonly Identity = new JourneyIdentity(JourneyPath.Enrolled, 'pragmatic-lab.com', Seed)
    public readonly Cabinet = new CabinetPage(Cabinet, this.Waiter)
    public readonly Login = new CentralLoginPage('login.example', this.Waiter)
    public readonly Session = new CustomerSession(this.Browser, this.Cabinet, this.Login, this.Identity, 'login.example', this.Waiter)
    public readonly Account = new CentralAccount(Issuer, this.Toolkit.Fetch)
    public readonly Context = new JourneyContext('run-0001', JourneyPath.Enrolled)
    public readonly ClientName = 'journey-run-0001'

    /** Wires the fake pages: register form → login (sign-up, then sign-in) → cabinet registration → account page. */
    public WireRegistration(code: string | undefined): void
    {
        const C = CabinetPage
        const L = CentralLoginPage
        const p = this.Page
        const url = this.Cabinet.RegisterUrl(undefined, code)
        p.OnGoto.set(url, () => p.Show(url, [C.RegisterTitle, C.ContinueSignedOut], [[C.NameSelector, 1]]))
        p.OnClick.set(C.ContinueSignedOut, () => p.Show(LoginUrl, [L.CreateAccountLink], [[L.EmailSelector, 1], [L.CurrentPasswordSelector, 1]]))
        p.OnClick.set(L.CreateAccountLink, () => p.Show(LoginUrl, [L.CreateAccountButton, L.BackToSignIn], [[L.EmailSelector, 1], [L.NewPasswordSelector, 2]]))
        p.OnClick.set(L.CreateAccountButton, () =>
        {
            this.Toolkit.Accounts.set(this.Identity.Email, { password: this.Identity.Password, verified: false, checks: 0 })
            p.Show(LoginUrl, [L.CheckEmailNotice, L.BackToSignIn], [[L.EmailSelector, 1], [L.NewPasswordSelector, 2]])
        })
        p.OnClick.set(L.BackToSignIn, () => p.Show(LoginUrl, [L.CreateAccountLink], [[L.EmailSelector, 1], [L.CurrentPasswordSelector, 1]]))
        p.OnPress.set(L.SubmitKey, () => p.Show(Cabinet + C.RegisterPath, [C.RegisterTitle, C.ContinueSignedIn]))
        p.OnClick.set(C.ContinueSignedIn, () => this.ShowAccount([C.NoSubscription, 'Starter', C.ChooseButton]))
    }

    public ShowAccount(extra: readonly string[]): void
    {
        this.Page.Show(Cabinet + CabinetPage.RootPath, [CabinetPage.AccountTitle, this.ClientName, CabinetPage.RefreshButton, ...extra])
    }

    public RegisterLeg(code: string | undefined): RegisterLeg
    {
        return new RegisterLeg(this.Session, this.Cabinet, this.Login, this.Account, this.Identity, code, this.Uncleaned, this.Waiter, this.Evidence.Evidence)
    }

    public PayLeg(): PayLeg
    {
        return new PayLeg(this.Session, this.Cabinet, new PaddleCheckout(this.Waiter), this.Identity, 'Starter', this.Waiter, this.Evidence.Evidence)
    }
}

describe('VisitLeg', () =>
{
    it('finds the pricing page\'s link into the cabinet\'s registration and records it', async () =>
    {
        const s = new Scenario()
        s.Page.Links.push('https://www.example/product', Cabinet + '/register')
        const leg = new VisitLeg(s.Browser, new WebsitePage('https://www.example', Cabinet), s.Evidence.Evidence)
        await leg.Run(s.Context)
        assert.equal(s.Context.Get(JourneyKeys.RegistrationLink), Cabinet + '/register')
        assert.deepEqual(s.Page.Calls, ['goto https://www.example/pricing'])
        s.Page.Links.splice(0)
        await assert.rejects(leg.Run(s.Context), /links nowhere into the cabinet/)
        s.Evidence.Folder.Dispose()
    })
})

describe('RegisterLeg', () =>
{
    it('register signs up, verifies and lands on the account page', async () =>
    {
        const s = new Scenario()
        s.WireRegistration('JOURNEY-CODE')
        await s.RegisterLeg('JOURNEY-CODE').Run(s.Context)
        assert.equal(s.Context.Get(JourneyKeys.ClientName), s.ClientName)
        assert.equal(s.Context.Get(JourneyKeys.Email), 'journey-enrolled@pragmatic-lab.com')
        assert.equal(s.Context.Get(JourneyKeys.Registration), JourneyState.Registered)
        const calls = s.Page.Calls
        assert.equal(calls[0], 'goto ' + Cabinet + '/register?code=JOURNEY-CODE')
        assert.equal(calls.filter(c => c === 'click ' + CabinetPage.ContinueSignedIn).length, 1, 'Create my account is pressed once')
        assert.equal(s.Cabinet.RegisterUrl(Cabinet + '/register?campaign=web', 'J-1'), Cabinet + '/register?campaign=web&code=J-1', 'the website link keeps its query')
        assert.throws(() => s.Cabinet.RegisterUrl('https://evil.example/register', undefined), /not the cabinet's \/register/)
        assert.ok(calls.includes('fill ' + CabinetPage.NameSelector + '#0 ' + s.ClientName))
        assert.ok(calls.includes('fill ' + CentralLoginPage.NewPasswordSelector + '#1 ' + s.Identity.Password), 'the password goes into the confirm field too')
        assert.ok(calls.indexOf('click ' + CentralLoginPage.CreateAccountButton) < calls.indexOf('press ' + CentralLoginPage.CurrentPasswordSelector + '#0 Enter'), 'signs in only after the sign-up')
        assert.ok(s.Toolkit.Accounts.get(s.Identity.Email)!.verified)
        assert.equal(s.Toolkit.SignIns, 1, 'one password sign-in after the sign-up; the verification wait polls lookup')
        assert.ok(!JSON.stringify([...s.Evidence.Sink.Lines]).includes(s.Identity.Password), 'the password never reaches the step log')
        s.Evidence.Folder.Dispose()
    })

    it('a leftover account an uncleaned earlier run still needs is not deleted: the leg names that run', async () =>
    {
        const s = new Scenario()
        s.Toolkit.Accounts.set(s.Identity.Email, { password: s.Identity.Password, verified: true, checks: 0 })
        s.Uncleaned.Runs.push('20261123t0900-abcd')
        s.WireRegistration(undefined)
        await assert.rejects(s.RegisterLeg(undefined).Run(s.Context), /uncleaned run\(s\) 20261123t0900-abcd: run npm run journey:clean/)
        assert.equal(s.Toolkit.Deletes, 0)
        s.Evidence.Folder.Dispose()
    })

    it('through the journey: a refused leftover is not deleted by this run\'s own clean either', async () =>
    {
        const s = new Scenario()
        s.Toolkit.Accounts.set(s.Identity.Email, { password: s.Identity.Password, verified: true, checks: 0 })
        s.Uncleaned.Runs.push('20261123t0900-abcd')
        s.WireRegistration(undefined)
        const store: IJourneyContextStore = { Save: () => undefined }
        const journey = new Journey([s.RegisterLeg(undefined)], new Set(Object.values(JourneyDependency)), new JourneyReport('run-0001'), s.Evidence.Evidence, store, s.Browser)
        assert.equal(await journey.Run(s.Context), false)
        assert.equal(s.Toolkit.Deletes, 0, 'the older run\'s account survives')
        assert.ok(s.Toolkit.Accounts.has(s.Identity.Email))
        s.Evidence.Folder.Dispose()
    })

    it('a leftover account no uncleaned run claims is deleted before the sign-up', async () =>
    {
        const s = new Scenario()
        s.Toolkit.Accounts.set(s.Identity.Email, { password: s.Identity.Password, verified: true, checks: 0 })
        s.WireRegistration(undefined)
        await s.RegisterLeg(undefined).Run(s.Context)
        assert.equal(s.Toolkit.Deletes, 1)
        assert.ok(s.Evidence.Sink.Lines.some(line => line.includes('deleted a leftover central account')))
        s.Evidence.Folder.Dispose()
    })

    it('a sign-up refusal ends the leg with the login page\'s own text', async () =>
    {
        const s = new Scenario()
        s.WireRegistration(undefined)
        s.Page.OnClick.set(CentralLoginPage.CreateAccountButton, () => s.Page.Show(LoginUrl, ['An account with this email already exists. Sign in instead.'], [[CentralLoginPage.EmailSelector, 1]]))
        await assert.rejects(s.RegisterLeg(undefined).Run(s.Context), /a central account the derived password does not open/)
        s.Evidence.Folder.Dispose()
    })

    it('register\'s clean deletes the central-login account', async () =>
    {
        const s = new Scenario()
        s.Toolkit.Accounts.set(s.Identity.Email, { password: s.Identity.Password, verified: true, checks: 0 })
        s.Context.Set(JourneyKeys.ClientName, s.ClientName)
        s.Context.Set(JourneyKeys.Registration, JourneyState.Registered)
        await s.RegisterLeg(undefined).Clean(s.Context)
        assert.equal(s.Toolkit.Accounts.size, 0)
        assert.ok(s.Evidence.Sink.Lines.some(line => line.includes('deleted the central account journey-enrolled@pragmatic-lab.com')))
        assert.ok(s.Evidence.Sink.Lines.some(line => line.includes('the ledger keeps client ' + s.ClientName)))
        await s.RegisterLeg(undefined).Clean(s.Context)
        assert.ok(s.Evidence.Sink.Lines.some(line => line.includes('no central account left to delete')), 'clean is idempotent')
        s.Evidence.Folder.Dispose()
    })
})

describe('PayLeg', () =>
{
    class PaidScenario extends Scenario
    {
        public readonly Frame = new FakeFrame('https://sandbox-buy.paddle.com/checkout')
        public Refreshes = 0

        public Wire(): void
        {
            const P = PaddleCheckout
            this.Context.Set(JourneyKeys.ClientName, this.ClientName)
            this.Page.OnGoto.set(Cabinet + CabinetPage.RootPath, () => this.ShowAccount([CabinetPage.NoSubscription, 'Starter', CabinetPage.ChooseButton]))
            this.Page.OnClick.set(CabinetPage.ChooseButton, () =>
            {
                this.Frame.Present.set(P.EmailInput, 1)
                this.Frame.Present.set(P.CountrySelect, 1)
                this.Frame.Present.set(P.PostcodeInput, 1)
                this.Frame.Present.set(P.LocationSubmit, 1)
                this.Page.Frames.set(P.SandboxHost, this.Frame)
            })
            this.Frame.OnClick.set(P.LocationSubmit, () =>
            {
                this.Frame.Present.clear()
                for (const field of [P.CardNumberInput, P.CardholderInput, P.ExpiryInput, P.CvvInput, P.CardSubmit])
                {
                    this.Frame.Present.set(field, 1)
                }
            })
            this.Frame.OnClick.set(P.CardSubmit, () =>
            {
                this.Frame.Present.clear()
                this.Frame.Present.set(P.SuccessMarkers[0], 1)
                this.Page.OnGoto.set(Cabinet + CabinetPage.RootPath, () =>
                {
                    this.Page.Frames.clear()
                    this.ShowAccount([CabinetPage.NoSubscription])
                })
            })
            this.Page.OnClick.set(CabinetPage.RefreshButton, () =>
            {
                this.Refreshes++
                if (this.Refreshes >= 2)
                {
                    this.ShowAccount([CabinetPage.ActiveState, CabinetPage.CancelButton])
                    this.Page.OnGoto.set(Cabinet + CabinetPage.RootPath, () => this.ShowAccount([CabinetPage.ActiveState, CabinetPage.CancelButton]))
                }
            })
            this.Page.OnClick.set(CabinetPage.CancelButton, () => this.ShowAccount([CabinetPage.ActiveState, CabinetPage.CancelScheduled]))
        }
    }

    it('pay chooses the plan, pays with the test card and waits for the subscription; its clean cancels it', async () =>
    {
        const s = new PaidScenario()
        s.Wire()
        await s.PayLeg().Run(s.Context)
        assert.equal(s.Context.Get(JourneyKeys.Subscription), JourneyState.Active)
        assert.ok(s.Page.Calls.includes('click Choose near Starter'))
        assert.ok(s.Frame.Calls.includes('fill ' + PaddleCheckout.EmailInput + ' journey-enrolled@pragmatic-lab.com'))
        assert.ok(s.Frame.Calls.includes('fill ' + PaddleCheckout.CardNumberInput + ' ' + PaddleCheckout.TestCardNumber))
        assert.ok(s.Frame.Calls.includes('select ' + PaddleCheckout.CountrySelect + ' US'))
        assert.equal(s.Frame.Calls.filter(c => c === 'click ' + PaddleCheckout.CardSubmit).length, 1, 'pays once')
        assert.ok(s.Evidence.Sink.Lines.some(line => line.includes('submitting the test card')), 'the submission is recorded before the click')
        assert.ok(!s.Evidence.Sink.Lines.join('\n').includes('4242'), 'the card number never reaches the step log')
        await s.PayLeg().Clean(s.Context)
        assert.equal(s.Context.Get(JourneyKeys.Subscription), JourneyState.CancelScheduled)
        assert.ok(s.Page.Calls.includes('click ' + CabinetPage.CancelButton))
        s.Evidence.Folder.Dispose()
    })

    it('clean after a checkout that was only opened finds nothing to cancel and passes', async () =>
    {
        const s = new PaidScenario()
        s.Wire()
        s.Context.Set(JourneyKeys.Checkout, JourneyState.CheckoutOpened)
        s.Page.OnClick.delete(CabinetPage.RefreshButton)
        await s.PayLeg().Clean(s.Context)
        assert.ok(s.Evidence.Sink.Lines.some(line => line.includes('no subscription to cancel')))
        s.Evidence.Folder.Dispose()
    })

    it('clean after a paid checkout whose subscription the page cannot cancel fails (it must be cancelled by hand)', async () =>
    {
        const s = new PaidScenario()
        s.Wire()
        s.Context.Set(JourneyKeys.Checkout, JourneyState.CheckoutPaid)
        s.Page.OnGoto.set(Cabinet + CabinetPage.RootPath, () => s.ShowAccount(['Payment overdue']))
        s.Page.OnClick.delete(CabinetPage.RefreshButton)
        await assert.rejects(s.PayLeg().Clean(s.Context), /timed out waiting for the subscription to offer its cancellation/)
        s.Evidence.Folder.Dispose()
    })

    it('a checkout submitted before a kill is waited for, not bought again, and must be cancellable at clean', async () =>
    {
        const s = new PaidScenario()
        s.Wire()
        s.Context.Set(JourneyKeys.Checkout, JourneyState.CheckoutSubmitted)
        s.Page.OnGoto.set(Cabinet + CabinetPage.RootPath, () => s.ShowAccount([CabinetPage.WaitingState]))
        await s.PayLeg().Run(s.Context)
        assert.ok(!s.Page.Calls.some(c => c.startsWith('click Choose')), 'no second checkout')
        assert.equal(s.Context.Get(JourneyKeys.Subscription), JourneyState.Active)
        s.Evidence.Folder.Dispose()
    })

    it('a resumed Run over a live subscription passes without buying', async () =>
    {
        const s = new PaidScenario()
        s.Wire()
        s.Page.OnGoto.set(Cabinet + CabinetPage.RootPath, () => s.ShowAccount([CabinetPage.TrialState, CabinetPage.CancelButton]))
        await s.PayLeg().Run(s.Context)
        assert.ok(!s.Page.Calls.some(c => c.startsWith('click Choose')))
        assert.ok(s.Evidence.Sink.Lines.some(line => line.includes('already Trial')))
        s.Evidence.Folder.Dispose()
    })

    it('clean after a kill between the cancellation and its save sees it already scheduled', async () =>
    {
        const s = new PaidScenario()
        s.Wire()
        s.Context.Set(JourneyKeys.Checkout, JourneyState.CheckoutPaid)
        s.Page.OnGoto.set(Cabinet + CabinetPage.RootPath, () => s.ShowAccount([CabinetPage.ActiveState]))
        await s.PayLeg().Clean(s.Context)
        assert.equal(s.Context.Get(JourneyKeys.Subscription), JourneyState.CancelScheduled)
        assert.ok(!s.Page.Calls.includes('click ' + CabinetPage.CancelButton))
        s.Evidence.Folder.Dispose()
    })

    it('clean of a subscription already cancelled (e.g. in the Paddle dashboard) passes', async () =>
    {
        const s = new PaidScenario()
        s.Wire()
        s.Context.Set(JourneyKeys.Checkout, JourneyState.CheckoutSubmitted)
        s.Page.OnGoto.set(Cabinet + CabinetPage.RootPath, () => s.ShowAccount([CabinetPage.CancelledState]))
        await s.PayLeg().Clean(s.Context)
        assert.equal(s.Context.Get(JourneyKeys.Subscription), JourneyState.CancelScheduled)
        s.Evidence.Folder.Dispose()
    })

    it('clean after a submitted payment that was declined (no subscription after the long wait) passes with nothing to cancel', async () =>
    {
        const s = new PaidScenario()
        s.Wire()
        s.Context.Set(JourneyKeys.Checkout, JourneyState.CheckoutSubmitted)
        s.Page.OnClick.delete(CabinetPage.RefreshButton)
        await s.PayLeg().Clean(s.Context)
        assert.ok(s.Evidence.Sink.Lines.some(line => line.includes('no subscription to cancel')))
        s.Evidence.Folder.Dispose()
    })

    it('clean after a submitted payment left pending (Waiting for payment after the long wait) passes with nothing to cancel', async () =>
    {
        const s = new PaidScenario()
        s.Wire()
        s.Context.Set(JourneyKeys.Checkout, JourneyState.CheckoutSubmitted)
        s.Page.OnGoto.set(Cabinet + CabinetPage.RootPath, () => s.ShowAccount([CabinetPage.WaitingState]))
        s.Page.OnClick.delete(CabinetPage.RefreshButton)
        await s.PayLeg().Clean(s.Context)
        assert.ok(s.Evidence.Sink.Lines.some(line => line.includes('no subscription to cancel')))
        s.Evidence.Folder.Dispose()
    })

    it('a resumed Run after an abandoned overlay (opened, never submitted) chooses the plan again', async () =>
    {
        const s = new PaidScenario()
        s.Wire()
        s.Context.Set(JourneyKeys.Checkout, JourneyState.CheckoutOpened)
        await s.PayLeg().Run(s.Context)
        assert.ok(s.Page.Calls.includes('click Choose near Starter'))
        s.Evidence.Folder.Dispose()
    })

    it('a checkout error ends the payment at once', async () =>
    {
        const s = new PaidScenario()
        s.Wire()
        s.Frame.OnClick.set(PaddleCheckout.CardSubmit, () => s.Frame.Present.set('[data-testid="paymentErrorMessage"]', 1))
        await assert.rejects(s.PayLeg().Run(s.Context), /Paddle's checkout showed an error/)
        s.Evidence.Folder.Dispose()
    })
})

describe('TenantLeg', () =>
{
    const T = CabinetTenantsPage
    const C = CabinetPage
    const Suspended = 'Your subscription is suspended, so this is not available. Check your subscription on the Account page.'
    const SignInEnded = 'Your sign-in has ended. Please sign in again.'
    /** A press the page has not answered yet (still busy). */
    const NoAnswer = ''

    /** A clock that records each sleep and runs a hook after it (a list that finishes loading). */
    class HookedClock extends FakeClock
    {
        public readonly Sleeps: number[] = []
        public OnSleep: (() => void) | undefined

        public override async Sleep(ms: number): Promise<void>
        {
            await super.Sleep(ms)
            this.Sleeps.push(ms)
            this.OnSleep?.()
        }
    }

    class TenantScenario extends Scenario
    {
        public readonly TenantId = 'journey-run-0001-e'
        public readonly Clock = new HookedClock()
        public readonly TenantWaiter = new Waiter(this.Clock, 1000)
        public readonly TenantCabinet = new CabinetPage(Cabinet, this.TenantWaiter)
        public readonly TenantSession = new CustomerSession(this.Browser, this.TenantCabinet, this.Login, this.Identity, 'login.example', this.TenantWaiter)
        /** What each press of "Create tenant" answers, in turn; past the end the tenant is created. */
        public readonly Answers: string[] = []
        /** What each load of the list answers, in turn (a refusal text); past the end it loads. */
        public readonly ListAnswers: string[] = []
        /** The client's tenants as the console holds them. */
        public readonly Server: string[] = []
        /** A settling answer (taken, limit-reached) whose tenant is the run's own: an earlier press landed. */
        public SettleIsOwn = false
        /** The console records a confirmed create (false: the notice shows but the reload does not list it). */
        public Records = true
        /** Sleeps a list load stays on "Loading tenants..." before it answers. */
        public LoadingSleeps = 0
        public Creates = 0
        public Gotos = 0
        private loaded: string[] = []

        public Wire(): void
        {
            this.Context.Set(JourneyKeys.ClientName, this.ClientName)
            this.Page.OnGoto.set(Cabinet + C.RootPath, () =>
            {
                this.Gotos++
                this.ShowAccount([C.ActiveState, T.NavLabel])
            })
            this.Page.OnClick.set(T.NavLabel, () => this.Load())
            this.Page.OnClick.set(T.CreateButton, () => this.Press())
        }

        public ShowTenants(list: readonly string[], extra: readonly string[]): void
        {
            this.Page.Show(Cabinet + C.RootPath, [T.NavLabel, T.FormTitle, T.CreateButton, this.ClientName, ...list, ...extra],
                [[T.TenantIdSelector, 1], [T.DisplayNameSelector, 1]])
        }

        public TenantLeg(): TenantLeg
        {
            return new TenantLeg(new CabinetTenantsPage(this.TenantSession, this.TenantCabinet, this.TenantWaiter), this.Evidence.Evidence)
        }

        private Load(): void
        {
            const refusal = this.ListAnswers.shift()
            if (refusal !== undefined)
            {
                this.ShowTenants([], [refusal])
                return
            }
            let left = this.LoadingSleeps
            const answer = (): void =>
            {
                this.loaded = [...this.Server]
                this.ShowTenants(this.List(), [])
            }
            if (left === 0)
            {
                answer()
                return
            }
            this.ShowTenants([], [T.Loading])
            this.Clock.OnSleep = () =>
            {
                left--
                if (left === 0)
                {
                    this.Clock.OnSleep = undefined
                    answer()
                }
            }
        }

        private Press(): void
        {
            this.Creates++
            const answer = this.Answers.shift()
            if (answer === NoAnswer)
            {
                return
            }
            if (answer !== undefined)
            {
                if ((answer === T.TakenText || answer === T.LimitReachedText) && this.SettleIsOwn)
                {
                    this.Server.push(this.TenantId)
                }
                this.ShowTenants(this.List(), [answer])
                return
            }
            if (this.Records)
            {
                this.Server.push(this.TenantId)
            }
            this.loaded = [...this.Server]
            this.ShowTenants(this.List(), [T.CreatedPrefix + this.TenantId + T.CreatedSuffix])
        }

        /** The table as last loaded: its header and rows, or the empty text. */
        private List(): string[]
        {
            return this.loaded.length === 0 ? [T.EmptyList] : [T.ListHeader, ...this.loaded]
        }
    }

    it('creates the path\'s tenant on the cabinet\'s Tenants page, proves it by a reload and records its id, at the slow pace', async () =>
    {
        const s = new TenantScenario()
        s.Wire()
        await s.TenantLeg().Run(s.Context)
        assert.equal(s.Context.Get(JourneyKeys.Tenant), s.TenantId)
        assert.equal(s.Context.Get(JourneyKeys.TenantState), JourneyState.TenantCreated)
        assert.ok(s.Page.Calls.includes('fill ' + T.TenantIdSelector + '#0 ' + s.TenantId))
        assert.ok(s.Page.Calls.includes('fill ' + T.DisplayNameSelector + '#0 Journey run-0001 enrolled'))
        assert.equal(s.Creates, 1)
        assert.equal(s.Gotos, 2, 'opened, then reloaded for the evidence')
        assert.ok(s.Clock.Sleeps.length > 0 && s.Clock.Sleeps.every(ms => ms === T.PressIntervalMs), 'every wait polls at the press interval: ' + s.Clock.Sleeps.join(','))
        assert.ok(s.Evidence.Sink.Lines.some(l => l.includes('created tenant ' + s.TenantId + ' and the reloaded list shows it')))
        s.Evidence.Folder.Dispose()
    })

    it('a list still loading is waited for, not reopened', async () =>
    {
        const s = new TenantScenario()
        s.LoadingSleeps = 2
        s.Wire()
        await s.TenantLeg().Run(s.Context)
        assert.equal(s.Gotos, 2)
        assert.equal(s.Context.Get(JourneyKeys.TenantState), JourneyState.TenantCreated)
        s.Evidence.Folder.Dispose()
    })

    it('a list refused while the statement is on its way (not an admin, not in plan) is reopened until it loads', async () =>
    {
        const s = new TenantScenario()
        s.ListAnswers.push(C.NotAdminError, T.NotInPlanText)
        s.Wire()
        await s.TenantLeg().Run(s.Context)
        assert.equal(s.Gotos, 4, 'two reopenings, then the reload')
        assert.equal(s.Creates, 1)
        s.Evidence.Folder.Dispose()
    })

    it('a list refused for good (the sign-in ended) fails at once, and its clean notes no tenant (none was asked for)', async () =>
    {
        const s = new TenantScenario()
        s.ListAnswers.push(SignInEnded)
        s.Wire()
        await assert.rejects(s.TenantLeg().Run(s.Context), /the cabinet refused: Your sign-in has ended/)
        assert.equal(s.Creates, 0)
        assert.equal(s.Context.Get(JourneyKeys.Tenant), undefined)
        await s.TenantLeg().Clean(s.Context)
        assert.ok(s.Evidence.Sink.Lines.some(l => l.includes('no tenant was created')))
        s.Evidence.Folder.Dispose()
    })

    it('a list answered with unrecognised text (neither loaded nor loading) is reopened until it loads', async () =>
    {
        const s = new TenantScenario()
        s.ListAnswers.push('Failed to fetch')
        s.Wire()
        await s.TenantLeg().Run(s.Context)
        assert.equal(s.Gotos, 3, 'one reopening, then the reload')
        assert.equal(s.Context.Get(JourneyKeys.TenantState), JourneyState.TenantCreated)
        s.Evidence.Folder.Dispose()
    })

    it('waits through press refusals (not an admin, not in plan, the fallback of a lost answer), pressing Create again', async () =>
    {
        const s = new TenantScenario()
        s.Answers.push(C.NotAdminError, T.NotInPlanText, C.FallbackError)
        s.Wire()
        await s.TenantLeg().Run(s.Context)
        assert.equal(s.Creates, 4)
        assert.ok(s.Clock.Sleeps.length >= 3 && s.Clock.Sleeps.every(ms => ms === T.PressIntervalMs), 'presses again at the press interval: ' + s.Clock.Sleeps.join(','))
        assert.equal(s.Context.Get(JourneyKeys.TenantState), JourneyState.TenantCreated)
        s.Evidence.Folder.Dispose()
    })

    it('a press left unanswered or answered with unrecognised text is pressed again', async () =>
    {
        const s = new TenantScenario()
        s.Answers.push(NoAnswer, 'Failed to fetch')
        s.Wire()
        await s.TenantLeg().Run(s.Context)
        assert.equal(s.Creates, 3)
        assert.equal(s.Context.Get(JourneyKeys.TenantState), JourneyState.TenantCreated)
        s.Evidence.Folder.Dispose()
    })

    it('a statement that never arrives times out naming the last refusal; the id is already recorded for the clean', async () =>
    {
        const s = new TenantScenario()
        for (let i = 0; i < 1000; i++)
        {
            s.Answers.push(C.NotAdminError)
        }
        s.Wire()
        await assert.rejects(s.TenantLeg().Run(s.Context), /the tenant journey-run-0001-e to be created.*not an administrator/)
        assert.equal(s.Context.Get(JourneyKeys.TenantState), undefined)
        assert.equal(s.Context.Get(JourneyKeys.Tenant), s.TenantId)
        s.Evidence.Folder.Dispose()
    })

    it('a resumed Run whose tenant is already listed passes without creating it again', async () =>
    {
        const s = new TenantScenario()
        s.Server.push(s.TenantId)
        s.Wire()
        await s.TenantLeg().Run(s.Context)
        assert.equal(s.Creates, 0)
        assert.equal(s.Context.Get(JourneyKeys.TenantState), JourneyState.TenantCreated)
        assert.ok(s.Evidence.Sink.Lines.some(l => l.includes('resumed: the tenant ' + s.TenantId + ' is already listed')))
        s.Evidence.Folder.Dispose()
    })

    it('a resumed Run whose list is refused at first still finds its tenant once the list loads', async () =>
    {
        const s = new TenantScenario()
        s.Server.push(s.TenantId)
        s.ListAnswers.push(C.UnavailableError)
        s.Wire()
        await s.TenantLeg().Run(s.Context)
        assert.equal(s.Creates, 0)
        assert.equal(s.Context.Get(JourneyKeys.TenantState), JourneyState.TenantCreated)
        s.Evidence.Folder.Dispose()
    })

    it('limit-reached or tenant-taken for the run\'s own tenant (an earlier press landed) passes once the reload lists it', async () =>
    {
        for (const answer of [T.LimitReachedText, T.TakenText])
        {
            const s = new TenantScenario()
            s.Answers.push(answer)
            s.SettleIsOwn = true
            s.Wire()
            await s.TenantLeg().Run(s.Context)
            assert.equal(s.Creates, 1)
            assert.equal(s.Context.Get(JourneyKeys.TenantState), JourneyState.TenantCreated)
            assert.ok(s.Evidence.Sink.Lines.some(l => l.includes('an earlier press of this run landed')))
            s.Evidence.Folder.Dispose()
        }
    })

    it('limit-reached or tenant-taken without the tenant in the reloaded list fails', async () =>
    {
        for (const answer of [T.LimitReachedText, T.TakenText])
        {
            const s = new TenantScenario()
            s.Answers.push(answer)
            s.Wire()
            await assert.rejects(s.TenantLeg().Run(s.Context), /answered tenant-taken or limit-reached and the reloaded list does not show the tenant/)
            assert.equal(s.Context.Get(JourneyKeys.TenantState), undefined)
            s.Evidence.Folder.Dispose()
        }
    })

    it('a confirmed tenant the reloaded list does not show fails', async () =>
    {
        const s = new TenantScenario()
        s.Records = false
        s.Wire()
        await assert.rejects(s.TenantLeg().Run(s.Context), /confirmed the tenant but the reloaded list does not show it/)
        assert.equal(s.Context.Get(JourneyKeys.TenantState), undefined)
        s.Evidence.Folder.Dispose()
    })

    it('a final refusal (a suspended subscription) ends the leg at once', async () =>
    {
        const s = new TenantScenario()
        s.Answers.push(Suspended)
        s.Wire()
        await assert.rejects(s.TenantLeg().Run(s.Context), /the cabinet refused: Your subscription is suspended/)
        assert.equal(s.Creates, 1)
        s.Evidence.Folder.Dispose()
    })

    it('tenant ids are the path\'s own and fit the cabinet\'s tenant id pattern', () =>
    {
        const ids = [JourneyPath.Enrolled, JourneyPath.Delegated, JourneyPath.Hosted].map(path => TenantLeg.TenantIdFor('20261124t1200-ab12', path))
        assert.deepEqual(ids, ['journey-20261124t1200-ab12-e', 'journey-20261124t1200-ab12-d', 'journey-20261124t1200-ab12-h'])
        assert.ok(ids.every(id => TenantLeg.TenantIdPattern.test(id)))
        assert.throws(() => TenantLeg.TenantIdFor('a'.repeat(30), JourneyPath.Enrolled), /makes no tenant id the cabinet accepts/)
    })

    it('clean leaves the tenant in place (no customer operation leaves a tenant) and touches no page', async () =>
    {
        const s = new TenantScenario()
        s.Wire()
        s.Context.Set(JourneyKeys.Tenant, s.TenantId)
        s.Context.Set(JourneyKeys.TenantState, JourneyState.TenantCreated)
        await s.TenantLeg().Clean(s.Context)
        assert.deepEqual(s.Page.Calls, [])
        assert.ok(s.Evidence.Sink.Lines.some(l => l.includes('tenant ' + s.TenantId + ' stays under its journey client')))
        s.Evidence.Folder.Dispose()
    })

    it('clean after an unconfirmed create says the tenant may exist; before any press there is nothing to note', async () =>
    {
        const s = new TenantScenario()
        await s.TenantLeg().Clean(s.Context)
        assert.ok(s.Evidence.Sink.Lines.some(l => l.includes('no tenant was created')))
        s.Context.Set(JourneyKeys.Tenant, s.TenantId)
        await s.TenantLeg().Clean(s.Context)
        assert.ok(s.Evidence.Sink.Lines.some(l => l.includes(s.TenantId + ' was asked for but not confirmed')))
        assert.deepEqual(s.Page.Calls, [])
        s.Evidence.Folder.Dispose()
    })
})

describe('JourneyLegs', () =>
{
    const document = {
        websiteUrl: 'https://www.example', cabinetUrl: Cabinet, centralIssuer: Issuer, edgeUrl: 'https://agent.example', planName: 'Starter',
        emailDomain: 'pragmatic-lab.com', journeyDnsSubdomain: 'journey.pragmatic-lab.com', customerCluster: 'pragmatic-customer', liveDependencies: ['cabinet'],
    }

    it('orders the legs per path: the customer-cluster paths enrol, the Hosted path places', () =>
    {
        const s = new Scenario()
        const config = JourneyConfig.FromDocument(document, {}, '/repo')
        const inputs = new JourneyLegInputs(config, s.Browser, s.Identity, undefined, s.Uncleaned, s.Waiter, s.Evidence.Evidence)
        const N = JourneyLegName
        assert.deepEqual(JourneyLegs.For(JourneyPath.Enrolled, inputs).map(l => l.Name), [N.Visit, N.Register, N.Pay, N.Tenant, N.InstallAndEnrol, N.Domain, N.StaffSignIn, N.Plexus, N.DeployGraphs])
        assert.deepEqual(JourneyLegs.For(JourneyPath.Hosted, inputs).map(l => l.Name), [N.Visit, N.Register, N.Pay, N.Tenant, N.PlaceHosted, N.Domain, N.StaffSignIn, N.Plexus, N.DeployGraphs])
        const hosted = JourneyLegs.For(JourneyPath.Hosted, inputs)
        assert.ok(hosted.find(l => l.Name === N.Plexus)!.Dependencies.includes(JourneyDependency.HostedPlacement), 'the Hosted path later legs wait on the Hosted placement')
        const tenant = JourneyLegs.For(JourneyPath.Enrolled, inputs)[3]
        assert.ok(tenant instanceof TenantLeg, 'the tenant leg is built')
        assert.ok(!(tenant instanceof PendingLeg))
        assert.deepEqual(tenant.Dependencies, [JourneyDependency.Cabinet, JourneyDependency.CentralLogin, JourneyDependency.EntitlementDelivery])
        for (const leg of JourneyLegs.For(JourneyPath.Delegated, inputs).slice(3))
        {
            assert.ok(leg.Dependencies.includes(JourneyDependency.EntitlementDelivery), leg.Name + ' waits on the entitlement delivery')
        }
        s.Evidence.Folder.Dispose()
    })
})

describe('JourneyConfig', () =>
{
    const document = {
        websiteUrl: 'https://www.example/', cabinetUrl: Cabinet, centralIssuer: Issuer, edgeUrl: 'https://agent.example', planName: 'Starter',
        emailDomain: 'pragmatic-lab.com', journeyDnsSubdomain: 'journey.pragmatic-lab.com', customerCluster: 'pragmatic-customer', liveDependencies: ['website', 'cabinet'],
    }

    it('reads addresses (https only), the live dependencies and the file paths from the environment', () =>
    {
        const config = JourneyConfig.FromDocument(document, { PRAGMATIC_JOURNEY_PASSWORD_SEED_FILE: '/x/seed', PRAGMATIC_JOURNEY_RUNS_DIR: '/runs' }, '/repo')
        assert.equal(config.WebsiteUrl, 'https://www.example')
        assert.deepEqual([...config.LiveDependencies], [JourneyDependency.Website, JourneyDependency.Cabinet])
        assert.equal(config.RequireFile(JourneyConfig.PasswordSeedFileEnv), '/x/seed')
        assert.equal(config.OptionalFile(JourneyConfig.CampaignCodeFileEnv), undefined)
        assert.equal(config.RunsDir, '/runs')
        assert.throws(() => config.RequireFile(JourneyConfig.DnsTokenFileEnv), /PRAGMATIC_JOURNEY_DNS_TOKEN_FILE/)
        assert.throws(() => JourneyConfig.FromDocument({ ...document, cabinetUrl: 'http://cabinet.example' }, {}, '/repo'), /https only/)
        assert.throws(() => JourneyConfig.FromDocument({ ...document, liveDependencies: ['nope'] }, {}, '/repo'), /unknown journey dependency: nope/)
        assert.throws(() => JourneyConfig.FromDocument({ ...document, planName: '' }, {}, '/repo'), /lacks: planName/)
    })

    it('the checked-in configuration loads', () =>
    {
        const config = JourneyConfig.Load({})
        assert.equal(config.CentralIssuer, 'https://login.pragmatic-tech.ai/realms/central')
        assert.ok(config.LiveDependencies.has(JourneyDependency.JourneyMail))
        assert.ok(config.LiveDependencies.has(JourneyDependency.EntitlementDelivery), 'D4\'s delivery is live (2026-11-23)')
        assert.ok(!config.LiveDependencies.has(JourneyDependency.JourneyDns), 'the journey DNS token is not minted yet')
    })
})
