import type { CabinetPage } from '../drivers/cabinet-page.js'
import { CentralLoginPage, CentralLoginRefusal } from '../drivers/central-login-page.js'
import type { CustomerSession } from '../drivers/customer-session.js'
import type { Evidence } from '../evidence.js'
import type { JourneyContext } from '../journey-context.js'
import { JourneyDependency } from '../journey-dependency.js'
import type { IJourneyLeg } from '../journey-leg.js'
import type { JourneyPath } from '../journey-path.js'
import type { CentralAccount } from '../live/central-account.js'
import type { JourneyIdentity } from '../live/journey-identity.js'
import { WaitObservation, type Waiter } from '../waiter.js'
import { JourneyKeys, JourneyLegName, JourneyState } from './journey-keys.js'

/** Earlier runs of this laptop whose path still has started legs (not cleaned). */
export interface IUncleanedRuns
{
    For(path: JourneyPath, exceptRunId: string): readonly string[]
}

/**
 * Leg 2: registration. The cabinet's `/register` through the link the Visit leg found on the website (with the
 * journey's campaign code as `?code=` when one is configured) → the central login's sign-up with the path's synthetic
 * address and derived password → the verification email, which the journey mail worker opens (the real link, not an
 * admin call) → sign-in → back in the cabinet, which registers the client `journey-<run id>`.
 *
 * The address is fixed per path, so an account may be left from an earlier run. When an uncleaned earlier run of this
 * path exists, the leg refuses and names it (that run's clean still needs the account, e.g. to cancel its
 * subscription); otherwise the leftover is deleted. Clean deletes the Identity Platform account; the ledger keeps the
 * client (append-only; a staff hold is the staff's, see the report note).
 */
export class RegisterLeg implements IJourneyLeg
{
    public readonly Name = JourneyLegName.Register
    public readonly Dependencies = [JourneyDependency.Cabinet, JourneyDependency.CentralLogin, JourneyDependency.JourneyMail]
    public readonly DeadlineMs = 8 * 60_000
    private static readonly ClientPrefix = 'journey-'
    private static readonly VerifyDeadlineMs = 5 * 60_000
    private static readonly VerifyIntervalMs = 5_000
    private static readonly Verified = 'the journey mail worker to verify the address (the verification email\'s link)'
    private static readonly NotVerified = 'email not verified yet'
    private static readonly NoAccount = 'the sign-up left no account the derived password opens'
    private static readonly LeftoverRemoved = 'deleted a leftover central account (no uncleaned run claims it)'
    private static readonly LeftoverClaimed = 'the path\'s central account is still needed by uncleaned run(s) '
    private static readonly CleanThemFirst = ': run npm run journey:clean -- <run id> for each first'
    private static readonly ListSeparator = ', '
    private static readonly Squatted = 'the address already has a central account the derived password does not open (a rotated seed, or someone signed it up): delete it by hand, see pragmatic-infrastructure runbooks/journey-tests.md'
    private static readonly SignedUp = 'signed up at the central login as '
    private static readonly VerifiedNote = 'email verified through the verification email'
    private static readonly Registered = 'the cabinet registered the client '
    private static readonly WithCode = ' (with the journey campaign code)'
    private static readonly WithoutCode = ' (no campaign code configured)'
    private static readonly Deleted = 'deleted the central account '
    private static readonly Absent = 'no central account left to delete for '
    private static readonly NotOurs = 'nothing of this run to delete (it stopped before its sign-up) for '
    private static readonly LedgerNote = 'the ledger keeps client '
    private static readonly LedgerHold = ' (append-only); its staff hold is pending staff access from the laptop (ledger staff face is mesh people-devices only)'

    public constructor(
        private readonly session: CustomerSession,
        private readonly cabinet: CabinetPage,
        private readonly login: CentralLoginPage,
        private readonly account: CentralAccount,
        private readonly identity: JourneyIdentity,
        private readonly campaignCode: string | undefined,
        private readonly uncleaned: IUncleanedRuns,
        private readonly waiter: Waiter,
        private readonly evidence: Evidence)
    {
    }

    public static ClientNameFor(runId: string): string
    {
        return RegisterLeg.ClientPrefix + runId
    }

    public async Run(context: JourneyContext): Promise<void>
    {
        const R = RegisterLeg
        const email = this.identity.Email
        const password = this.identity.Password
        const clientName = R.ClientNameFor(context.RunId)
        context.Set(JourneyKeys.ClientName, clientName)
        context.Set(JourneyKeys.Email, email)
        await this.RemoveLeftover(context)
        context.Set(JourneyKeys.Registration, JourneyState.SigningUp)
        const page = await this.session.Page()
        await this.cabinet.StartRegistration(page, this.cabinet.RegisterUrl(context.Get(JourneyKeys.RegistrationLink), this.campaignCode), clientName)
        await this.login.WaitUntilOn(page)
        try
        {
            await this.login.SignUp(page, email, password)
        }
        catch (error)
        {
            throw error instanceof CentralLoginRefusal && error.message.includes(CentralLoginPage.EmailExists) ? new Error(R.Squatted) : error
        }
        this.evidence.Step(this.Name, R.SignedUp + email)
        const state = await this.account.SignIn(email, password)
        const idToken = state.IdToken
        if (idToken === undefined)
        {
            throw new Error(R.NoAccount)
        }
        await this.waiter.Until(R.Verified, async () =>
            await this.account.IsVerified(idToken) ? WaitObservation.Met(true, R.VerifiedNote) : WaitObservation.NotYet<boolean>(R.NotVerified),
        R.VerifyDeadlineMs, R.VerifyIntervalMs)
        this.evidence.Step(this.Name, R.VerifiedNote)
        await this.login.SignIn(page, email, password)
        await this.cabinet.CompleteRegistration(page, clientName)
        context.Set(JourneyKeys.Registration, JourneyState.Registered)
        this.evidence.Step(this.Name, R.Registered + clientName + (this.campaignCode === undefined ? R.WithoutCode : R.WithCode))
    }

    public async Clean(context: JourneyContext): Promise<void>
    {
        const R = RegisterLeg
        const email = this.identity.Email
        if (context.Get(JourneyKeys.Registration) === undefined)
        {
            // This run never got past the leftover check: the account (if any) is an earlier run's, not ours to delete.
            this.evidence.Step(this.Name, R.NotOurs + email)
            return
        }
        const deleted = await this.account.DeleteIfPresent(email, this.identity.Password)
        this.evidence.Step(this.Name, (deleted ? R.Deleted : R.Absent) + email)
        const clientName = context.Get(JourneyKeys.ClientName)
        if (context.Get(JourneyKeys.Registration) === JourneyState.Registered && clientName !== undefined)
        {
            this.evidence.Step(this.Name, R.LedgerNote + clientName + R.LedgerHold)
        }
    }

    private async RemoveLeftover(context: JourneyContext): Promise<void>
    {
        const R = RegisterLeg
        const state = await this.account.SignIn(this.identity.Email, this.identity.Password)
        if (!state.Exists || state.IdToken === undefined)
        {
            return
        }
        const claims = this.uncleaned.For(context.Path, context.RunId)
        if (claims.length > 0)
        {
            throw new Error(R.LeftoverClaimed + claims.join(R.ListSeparator) + R.CleanThemFirst)
        }
        await this.account.Delete(state.IdToken)
        this.evidence.Step(this.Name, R.LeftoverRemoved)
    }
}
