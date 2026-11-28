import { WaitAbortError, WaitObservation, type Waiter } from '../waiter.js'
import type { OwnerSignIn } from '../live/customer-cluster.js'
import type { IJourneyPage } from './journey-page.js'

/**
 * The customer's own engine console (pragmatic-tenant-admin's tenant portal) and its realm sign-in page
 * (pragmatic-tenant-idp's idp-login), in the browser that accepts only the engine's verified certificates. It signs the
 * Owner in with the engine's initial sign-in, connects the hive with the cabinet's code ("Connection status": code,
 * level, "Connect this hive"), opens the platform's changes ("Changes from Pragmatic", or the header's badge while one
 * waits) and approves one in its own row.
 */
export class EngineConsolePage
{
    public static readonly EmailSelector = 'input[placeholder="Email"]'
    public static readonly PasswordSelector = 'input[placeholder="Password"]'
    public static readonly SignInButton = 'Sign in'
    /** The visible label beside the password box: the sign-in form repeats "Sign in" as its heading and its submit button, so the submit is the one in the password field's row. */
    public static readonly PasswordLabel = 'Password'
    public static readonly OverviewConnection = 'View connection status'
    public static readonly CodeSelector = 'input[placeholder="pe1-..."]'
    public static readonly ConnectButton = 'Connect this hive'
    public static readonly EnrolledLevel = 'Enrolled'
    public static readonly DelegatedLevel = 'Delegated'
    public static readonly AddressSuffix = ' (your own domain)'
    public static readonly ChangesButton = 'Changes from Pragmatic'
    public static readonly ApprovalsTitle = 'Approvals'
    public static readonly ConnectedPattern = /^Connected as hive (hv[a-z2-7]{10}) at level (enrolled|delegated)\.$/
    public static readonly BadgePattern = /^\d+ changes? to approve$/
    public static readonly ApproveButton = 'Approve'
    public static readonly ApprovePattern = /^Approve$/
    public static readonly AppliedPattern = /^Applied$/
    public static readonly ApplyingOrApplied = /^(Applying|Applied)$/
    public static readonly Refusals: readonly string[] = [
        'This code is not valid: it is unknown, already used or expired. Start a new enrolment in your Pragmatic account.',
        'This code was issued for another tenant or level.',
        "This hive's key is already registered with Pragmatic. Contact Pragmatic support.",
        "Pragmatic answered under a key this engine was not installed to trust. Check that the engine was installed from Pragmatic's published chart.",
        'Pragmatic sent this change again with different content. Reload the page and check it before deciding.',
        'This change expired before it was decided. Pragmatic can send it again.',
    ]
    /** The budgets of each step (InstallAndEnrolLeg sizes its deadline from them). */
    public static readonly SignInBudgetMs = 2 * 60_000
    public static readonly ConnectBudgetMs = 2 * 60_000
    public static readonly PendingBudgetMs = 3 * 60_000
    public static readonly ApplyingBudgetMs = 60_000
    public static readonly ReloadIntervalMs = 15_000
    private static readonly SignedIn = 'the engine console signed in (its overview)'
    private static readonly Connected = 'the engine console to connect the hive'
    private static readonly PendingShown = 'the engine console to show the change waiting for approval: '
    private static readonly Applying = 'the approved change to be applying or applied'
    private static readonly ChangesShown = 'the engine console\'s changes from Pragmatic'
    private static readonly OnPage = 'on '
    private static readonly Refused = 'the engine console refused: '
    private static readonly NoBadge = 'no change waiting yet (reloading)'
    private static readonly Submitted = 'signed in, waiting for the overview'
    private static readonly NoValue = ''
    private static readonly StartAnchor = '^'
    private static readonly EndAnchor = '$'

    public constructor(private readonly consoleUrl: string, private readonly consoleHost: string, private readonly waiter: Waiter)
    {
    }

    /** Opens (or reloads) the console and signs the Owner in once on the realm's page when it asks; waits for the overview. */
    public async SignIn(page: IJourneyPage, owner: () => Promise<OwnerSignIn | undefined>): Promise<void>
    {
        const E = EngineConsolePage
        await page.Goto(this.consoleUrl)
        let submitted = false
        await this.waiter.Until(E.SignedIn, async () =>
        {
            if (await page.HasText(E.OverviewConnection))
            {
                return WaitObservation.Met(true, E.OverviewConnection)
            }
            if (!submitted && await page.Count(E.EmailSelector) > 0 && await page.Count(E.PasswordSelector) > 0 && await page.HasText(E.SignInButton))
            {
                const signIn = await owner()
                if (signIn !== undefined)
                {
                    await page.Fill(E.EmailSelector, signIn.Email)
                    await page.Fill(E.PasswordSelector, signIn.Password)
                    await page.ClickTextNear(E.SignInButton, E.PasswordLabel)
                    submitted = true
                }
            }
            return WaitObservation.NotYet<boolean>(submitted ? E.Submitted : E.OnPage + new URL(page.Url()).host)
        }, E.SignInBudgetMs)
    }

    /** "Connection status" → code, level, Connect; answers the hive id the console shows connected. */
    public async Connect(page: IJourneyPage, code: string, delegated: boolean): Promise<string>
    {
        const E = EngineConsolePage
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
            else if (!filled && await page.HasText(E.OverviewConnection))
            {
                await page.ClickText(E.OverviewConnection)
            }
            return WaitObservation.NotYet<string>(filled ? E.ConnectButton : E.OnPage + new URL(page.Url()).host)
        }, E.ConnectBudgetMs)
    }

    /** The header badge of changes waiting for approval, if the console shows one ('' when none). */
    public async PendingBadge(page: IJourneyPage): Promise<string>
    {
        return (await page.TextMatching(EngineConsolePage.BadgePattern)).trim()
    }

    /**
     * Reloads the console until its header shows a change waiting (the hive pulls every 30 s), opens Approvals from the
     * badge, finds the change asked (`sentence`) with Approve in its own row, approves it there and waits until that
     * row is applying or applied.
     */
    public async ApprovePending(page: IJourneyPage, sentence: string, owner: () => Promise<OwnerSignIn | undefined>): Promise<void>
    {
        const E = EngineConsolePage
        await this.waiter.Until(E.PendingShown + sentence, async () =>
        {
            if ((await page.TextNear(sentence, E.ApprovePattern)) !== E.NoValue)
            {
                return WaitObservation.Met(true, sentence)
            }
            const badge = await this.PendingBadge(page)
            if (badge === E.NoValue)
            {
                await this.SignIn(page, owner)
                return WaitObservation.NotYet<boolean>(E.NoBadge)
            }
            if (!await page.HasText(sentence))
            {
                await page.ClickText(badge)
            }
            return WaitObservation.NotYet<boolean>(badge)
        }, E.PendingBudgetMs, E.ReloadIntervalMs)
        await page.ClickTextNear(E.ApproveButton, sentence)
        await this.waiter.Until(E.Applying, async () =>
        {
            const state = (await page.TextNear(sentence, E.ApplyingOrApplied)).trim()
            if (state !== E.NoValue)
            {
                return WaitObservation.Met(true, state)
            }
            await this.ThrowRefusal(page)
            return WaitObservation.NotYet<boolean>(E.ApproveButton)
        }, E.ApplyingBudgetMs)
    }

    /**
     * Reloads the console and opens its changes from Pragmatic (Connection status → "Changes from Pragmatic") until the
     * change `sentence` is listed exactly once, applied, with no Approve in its row; answers how many rows it has.
     */
    public async ExpectApplied(page: IJourneyPage, sentence: string, owner: () => Promise<OwnerSignIn | undefined>, budgetMs: number): Promise<number>
    {
        const E = EngineConsolePage
        const exact = new RegExp(E.StartAnchor + E.Escape(sentence) + E.EndAnchor)
        return this.waiter.Until(E.ChangesShown, async () =>
        {
            if (!await page.HasText(E.ApprovalsTitle) || !await page.HasText(sentence))
            {
                if (await page.HasText(E.ChangesButton))
                {
                    await page.ClickText(E.ChangesButton)
                }
                else if (await page.HasText(E.OverviewConnection))
                {
                    await page.ClickText(E.OverviewConnection)
                }
                else
                {
                    await this.SignIn(page, owner)
                }
                return WaitObservation.NotYet<number>(E.ChangesShown)
            }
            const rows = (await page.TextsMatching(exact)).length
            const applied = (await page.TextNear(sentence, E.AppliedPattern)) !== E.NoValue
            const approvable = (await page.TextNear(sentence, E.ApprovePattern)) !== E.NoValue
            if (applied && !approvable)
            {
                return WaitObservation.Met(rows, sentence)
            }
            await this.SignIn(page, owner)
            return WaitObservation.NotYet<number>(approvable ? E.ApproveButton : sentence)
        }, budgetMs, E.ReloadIntervalMs)
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

    private static Escape(text: string): string
    {
        return text.replace(/[.*+?^${}()|[\]\\`]/g, '\\$&')
    }
}
