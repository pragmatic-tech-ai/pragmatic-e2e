import { WaitAbortError, WaitObservation, type Waiter } from '../waiter.js'
import type { IJourneyPage } from './journey-page.js'

/**
 * The personal cabinet as the journey drives it (pragmatic-cabinet's Mural UI): its pages' fixed copy for buttons
 * and states, its native inputs by placeholder. The registration page keeps the form in the tab while the central
 * login creates the sign-in, then sends `register-client` once on return.
 */
export class CabinetPage
{
    public static readonly RegisterPath = '/register'
    public static readonly RootPath = '/'
    public static readonly CodeParam = 'code'
    public static readonly RegisterTitle = 'Create your Pragmatic account'
    public static readonly NameSelector = 'input[placeholder="e.g. Acme Ltd"]'
    public static readonly ContinueSignedOut = 'Continue: create your sign-in'
    public static readonly ContinueSignedIn = 'Create my account'
    public static readonly AccountTitle = 'Your account'
    public static readonly ChooseButton = 'Choose'
    public static readonly RefreshButton = 'Refresh'
    public static readonly CancelButton = 'Cancel at the end of the period'
    public static readonly CancelScheduled = 'Your subscription will end at the end of the current period.'
    public static readonly ActiveState = 'Active'
    public static readonly TrialState = 'Trial'
    public static readonly WaitingState = 'Waiting for payment'
    public static readonly CancelledState = 'Cancelled'
    /** The subscription states that mean "paid and live" (a plan with a trial starts in Trial). */
    public static readonly LiveStates: readonly string[] = [CabinetPage.ActiveState, CabinetPage.TrialState]
    public static readonly NoSubscription = 'No subscription yet'
    public static readonly CheckoutOpened = 'The payment window is open. Your subscription becomes active as soon as Paddle confirms the payment; press Refresh to see it.'
    private static readonly RegisterDeadlineMs = 60_000
    private static readonly AccountDeadlineMs = 90_000
    private static readonly RegisterForm = 'the cabinet\'s registration form'
    private static readonly AccountPage = 'the cabinet\'s account page naming the client '
    private static readonly SubscriptionState = 'the cabinet to show the subscription '
    private static readonly CancelAnswer = 'the cabinet to schedule the cancellation'
    private static readonly OnPage = 'on '
    private static readonly NotRegistration = 'the registration link is not the cabinet\'s /register: '
    private static readonly Refused = 'the cabinet refused: '
    private static readonly Or = ' or '
    // The cabinet's refusal copy other drivers tell apart (pragmatic-cabinet ui/src/shell/cabinet-copy.ts).
    public static readonly FallbackError = 'Something went wrong. Please try again in a moment.'
    public static readonly NotEntitledError = 'Your plan does not allow this. Check your subscription on the Account page.'
    public static readonly NotAdminError = 'Your sign-in is not an administrator of this account.'
    public static readonly UnavailableError = 'The service is not reachable right now. Please try again in a moment.'
    // The cabinet's own refusal copy (pragmatic-cabinet ui/src/shell/cabinet-copy.ts and the register page).
    private static readonly ErrorTexts: readonly string[] = [
        CabinetPage.FallbackError,
        'Please enter a name.',
        'An invitation code has only letters, digits and dashes.',
        CabinetPage.NotEntitledError,
        'Some of the details are not valid. Please check them and try again.',
        'That invitation or campaign code is not valid, has expired, or has been used up.',
        'Your sign-in has ended. Please sign in again.',
        'There is no account for this sign-in yet. Register first.',
        'That plan is no longer offered.',
        'You have no subscription to change.',
        'This sign-in already belongs to an account.',
        'You already have a subscription.',
        'That plan cannot be bought online.',
        CabinetPage.NotAdminError,
        CabinetPage.UnavailableError,
        'We could not complete this right now. Our team has been notified; please try again later.',
    ]

    public constructor(private readonly cabinetUrl: string, private readonly waiter: Waiter)
    {
    }

    /**
     * The registration address: the link the website gave (or the cabinet's own `/register`), with the campaign code
     * as `?code=` when one is configured. A link that is not the cabinet's `/register` is refused.
     */
    public RegisterUrl(link: string | undefined, code: string | undefined): string
    {
        const C = CabinetPage
        const url = new URL(link ?? this.cabinetUrl + C.RegisterPath)
        if (url.origin !== new URL(this.cabinetUrl).origin || url.pathname !== C.RegisterPath)
        {
            throw new Error(C.NotRegistration + url.origin + url.pathname)
        }
        if (code !== undefined)
        {
            url.searchParams.set(C.CodeParam, code)
        }
        return url.toString()
    }

    /** On `/register` signed out: fills the client name and continues to the central login (the code rides in the URL). */
    public async StartRegistration(page: IJourneyPage, registerUrl: string, clientName: string): Promise<void>
    {
        const C = CabinetPage
        await page.Goto(registerUrl)
        await this.waiter.Until(C.RegisterForm, async () =>
            await page.HasText(C.ContinueSignedOut) && await page.Count(C.NameSelector) > 0
                ? WaitObservation.Met(true, C.RegisterTitle)
                : WaitObservation.NotYet<boolean>(C.OnPage + new URL(page.Url()).host), C.RegisterDeadlineMs)
        await page.Fill(C.NameSelector, clientName)
        await page.ClickText(C.ContinueSignedOut)
    }

    /**
     * Back from the central login, signed in: the page sends `register-client` with the kept form (pressing "Create my
     * account" when it waits for it) and the account page names the client.
     */
    public async CompleteRegistration(page: IJourneyPage, clientName: string): Promise<void>
    {
        const C = CabinetPage
        let pressed = false
        await this.waiter.Until(C.AccountPage + clientName, async () =>
        {
            if (await page.HasText(C.AccountTitle) && await page.HasText(clientName))
            {
                return WaitObservation.Met(true, C.AccountTitle)
            }
            await this.ThrowRefusal(page)
            if (!pressed && await page.HasText(C.ContinueSignedIn))
            {
                pressed = true
                await page.ClickText(C.ContinueSignedIn)
            }
            return WaitObservation.NotYet<boolean>(C.OnPage + new URL(page.Url()).host + new URL(page.Url()).pathname)
        }, C.AccountDeadlineMs)
    }

    /** Opens the cabinet's account page and waits for it (the caller signs in when the cabinet sends it to the login). */
    public async OpenAccount(page: IJourneyPage): Promise<void>
    {
        await page.Goto(this.cabinetUrl + CabinetPage.RootPath)
    }

    public async IsOnAccount(page: IJourneyPage, clientName: string): Promise<boolean>
    {
        return new URL(page.Url()).origin === new URL(this.cabinetUrl).origin && await page.HasText(CabinetPage.AccountTitle) && await page.HasText(clientName)
    }

    /** Presses Choose on the plan's row: Paddle's checkout opens over the page. */
    public async ChoosePlan(page: IJourneyPage, planName: string): Promise<void>
    {
        await page.ClickTextNear(CabinetPage.ChooseButton, planName)
    }

    /** Presses Refresh until the subscription shows one of `states` ("Active", "Trial"); a cabinet error ends the wait. */
    public async WaitForSubscription(page: IJourneyPage, states: readonly string[], deadlineMs: number): Promise<string>
    {
        const C = CabinetPage
        return this.waiter.Until(C.SubscriptionState + states.join(C.Or), async () =>
        {
            const shown = await this.ShownState(page, states)
            if (shown !== undefined)
            {
                return WaitObservation.Met(shown, shown)
            }
            await this.ThrowRefusal(page)
            await page.ClickText(C.RefreshButton)
            return WaitObservation.NotYet<string>(await page.HasText(C.NoSubscription) ? C.NoSubscription : C.OnPage + C.AccountTitle)
        }, deadlineMs)
    }

    /** The first of `states` the account page shows, if any. */
    public async ShownState(page: IJourneyPage, states: readonly string[]): Promise<string | undefined>
    {
        for (const state of states)
        {
            if (await page.HasText(state))
            {
                return state
            }
        }
        return undefined
    }

    public async Refresh(page: IJourneyPage): Promise<void>
    {
        await page.ClickText(CabinetPage.RefreshButton)
    }

    /** Whether the account page offers "Cancel at the end of the period" (a live subscription not yet cancelled). */
    public async CanCancel(page: IJourneyPage): Promise<boolean>
    {
        return page.HasText(CabinetPage.CancelButton)
    }

    public async CancelSubscription(page: IJourneyPage): Promise<void>
    {
        const C = CabinetPage
        await page.ClickText(C.CancelButton)
        await this.waiter.Until(C.CancelAnswer, async () =>
        {
            if (await page.HasText(C.CancelScheduled))
            {
                return WaitObservation.Met(true, C.CancelScheduled)
            }
            await this.ThrowRefusal(page)
            return WaitObservation.NotYet<boolean>(C.CancelButton)
        }, C.AccountDeadlineMs)
    }

    /** The cabinet's refusal copy the page shows (`extra` is a section's own refusals), if any. */
    private async ShownRefusal(page: IJourneyPage, extra: readonly string[] = []): Promise<string | undefined>
    {
        for (const text of [...CabinetPage.ErrorTexts, ...extra])
        {
            if (await page.HasText(text))
            {
                return text
            }
        }
        return undefined
    }

    /** Ends a wait at once when the page shows a refusal. */
    public async ThrowRefusal(page: IJourneyPage, extra: readonly string[] = []): Promise<void>
    {
        const shown = await this.ShownRefusal(page, extra)
        if (shown !== undefined)
        {
            throw new WaitAbortError(CabinetPage.Refused + shown)
        }
    }
}
