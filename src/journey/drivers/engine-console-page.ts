import { WaitAbortError, WaitObservation, type Waiter } from '../waiter.js'
import type { OwnerSignIn } from '../live/customer-cluster.js'
import type { IJourneyPage } from './journey-page.js'

/**
 * The customer's own engine console (pragmatic-tenant-admin's tenant portal) and its realm sign-in page
 * (pragmatic-tenant-idp's idp-login), in the browser context that accepts the engine's self-signed certificate. It
 * signs the Owner in with the engine's initial sign-in, connects the hive with the cabinet's code ("Connection status":
 * code, level, "Connect this hive"), and approves a pending change from the header's badge ("Approvals").
 */
export class EngineConsolePage
{
    public static readonly EmailSelector = 'input[placeholder="Email"]'
    public static readonly PasswordSelector = 'input[placeholder="Password"]'
    public static readonly SignInButton = 'Sign in'
    public static readonly OverviewConnection = 'View connection status'
    public static readonly CodeSelector = 'input[placeholder="pe1-..."]'
    public static readonly ConnectButton = 'Connect this hive'
    public static readonly EnrolledLevel = 'Enrolled'
    public static readonly DelegatedLevel = 'Delegated'
    public static readonly AddressSuffix = ' (your own domain)'
    public static readonly ConnectedPattern = /^Connected as hive (hv[a-z2-7]{10}) at level (enrolled|delegated)\.$/
    public static readonly BadgePattern = /^\d+ changes? to approve$/
    public static readonly ApproveButton = 'Approve'
    public static readonly AppliedStates: readonly string[] = ['Applying', 'Applied']
    public static readonly Refusals: readonly string[] = [
        'This code is not valid: it is unknown, already used or expired. Start a new enrolment in your Pragmatic account.',
        'This code was issued for another tenant or level.',
        "This hive's key is already registered with Pragmatic. Contact Pragmatic support.",
        "Pragmatic answered under a key this engine was not installed to trust. Check that the engine was installed from Pragmatic's published chart.",
        'Pragmatic sent this change again with different content. Reload the page and check it before deciding.',
        'This change expired before it was decided. Pragmatic can send it again.',
    ]
    private static readonly SignInDeadlineMs = 5 * 60_000
    private static readonly ConnectDeadlineMs = 5 * 60_000
    private static readonly ApprovalDeadlineMs = 5 * 60_000
    private static readonly ReloadIntervalMs = 15_000
    private static readonly SignedIn = 'the engine console signed in (its overview)'
    private static readonly Connected = 'the engine console to connect the hive'
    private static readonly PendingShown = 'the engine console to show the change waiting for approval: '
    private static readonly Applying = 'the approved change to be applying or applied'
    private static readonly OnPage = 'on '
    private static readonly Refused = 'the engine console refused: '
    private static readonly NoBadge = 'no change waiting yet (reloading)'
    private static readonly NoValue = ''

    public constructor(private readonly consoleUrl: string, private readonly consoleHost: string, private readonly waiter: Waiter)
    {
    }

    /** Opens the console and signs the Owner in on the realm's page when it asks; waits for the overview. */
    public async SignIn(page: IJourneyPage, owner: () => Promise<OwnerSignIn | undefined>): Promise<void>
    {
        const E = EngineConsolePage
        await page.Goto(this.consoleUrl)
        await this.waiter.Until(E.SignedIn, async () =>
        {
            if (await page.HasText(E.OverviewConnection))
            {
                return WaitObservation.Met(true, E.OverviewConnection)
            }
            if (await page.Count(E.EmailSelector) > 0 && await page.Count(E.PasswordSelector) > 0 && await page.HasText(E.SignInButton))
            {
                const signIn = await owner()
                if (signIn !== undefined)
                {
                    await page.Fill(E.EmailSelector, signIn.Email)
                    await page.Fill(E.PasswordSelector, signIn.Password)
                    await page.ClickText(E.SignInButton)
                }
            }
            return WaitObservation.NotYet<boolean>(E.OnPage + new URL(page.Url()).host)
        }, E.SignInDeadlineMs)
    }

    /** "Connection status" → code, level, Connect; answers the hive id the console shows connected. */
    public async Connect(page: IJourneyPage, code: string, delegated: boolean): Promise<string>
    {
        const E = EngineConsolePage
        await page.ClickText(E.OverviewConnection)
        let filled = false
        return this.waiter.Until(E.Connected, async () =>
        {
            const connected = E.ConnectedPattern.exec((await page.TextMatching(E.ConnectedPattern)).trim())
            if (connected !== null)
            {
                return WaitObservation.Met(connected[1] as string, connected[0])
            }
            await this.ThrowRefusal(page)
            if (!filled && await page.Count(E.CodeSelector) > 0)
            {
                await page.Fill(E.CodeSelector, code)
                if (delegated)
                {
                    await page.ClickText(E.EnrolledLevel)
                    await page.ClickText(E.DelegatedLevel)
                }
                await page.ClickTextNear(E.ConnectButton, this.consoleHost + E.AddressSuffix)
                filled = true
            }
            return WaitObservation.NotYet<string>(filled ? E.ConnectButton : E.OnPage + new URL(page.Url()).host)
        }, E.ConnectDeadlineMs)
    }

    /** The header badge of changes waiting for approval, if the console shows one ('' when none). */
    public async PendingBadge(page: IJourneyPage): Promise<string>
    {
        return (await page.TextMatching(EngineConsolePage.BadgePattern)).trim()
    }

    /**
     * Reloads the console until its header shows a change waiting (the hive pulls every 30 s), opens Approvals from the
     * badge, checks the change is the one asked (`sentence`), approves it and waits until it is applying or applied.
     */
    public async ApprovePending(page: IJourneyPage, sentence: string, owner: () => Promise<OwnerSignIn | undefined>): Promise<void>
    {
        const E = EngineConsolePage
        await this.waiter.Until(E.PendingShown + sentence, async () =>
        {
            const badge = await this.PendingBadge(page)
            if (badge !== E.NoValue)
            {
                if (!await page.HasText(sentence))
                {
                    await page.ClickText(badge)
                }
                if (await page.HasText(sentence) && await page.HasText(E.ApproveButton))
                {
                    return WaitObservation.Met(true, badge)
                }
                return WaitObservation.NotYet<boolean>(badge)
            }
            await this.SignIn(page, owner)
            return WaitObservation.NotYet<boolean>(E.NoBadge)
        }, E.ApprovalDeadlineMs, E.ReloadIntervalMs)
        await page.ClickText(E.ApproveButton)
        await this.waiter.Until(E.Applying, async () =>
        {
            for (const state of E.AppliedStates)
            {
                if (await page.HasText(state))
                {
                    return WaitObservation.Met(true, state)
                }
            }
            await this.ThrowRefusal(page)
            return WaitObservation.NotYet<boolean>(E.ApproveButton)
        }, E.ApprovalDeadlineMs)
    }

    private async ThrowRefusal(page: IJourneyPage): Promise<void>
    {
        for (const text of EngineConsolePage.Refusals)
        {
            if (await page.HasText(text))
            {
                throw new WaitAbortError(EngineConsolePage.Refused + text)
            }
        }
    }
}
