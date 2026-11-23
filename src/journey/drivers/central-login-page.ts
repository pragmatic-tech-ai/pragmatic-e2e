import { WaitAbortError, WaitObservation, type Waiter } from '../waiter.js'
import type { IJourneyPage } from './journey-page.js'

/**
 * The central login's page (pragmatic-tenant-idp's idp-login app) as the journey drives it: Mural text for the
 * buttons and notices, native inputs found by their autocomplete tokens (as the app's own login.spec.ts does). The
 * password goes only into the fields.
 */
export class CentralLoginPage
{
    public static readonly EmailSelector = 'input[autocomplete="email"]'
    public static readonly CurrentPasswordSelector = 'input[autocomplete="current-password"]'
    public static readonly NewPasswordSelector = 'input[autocomplete="new-password"]'
    public static readonly CreateAccountLink = 'Create an account'
    public static readonly CreateAccountButton = 'Create account'
    public static readonly BackToSignIn = 'Back to sign in'
    public static readonly CheckEmailNotice = 'Check your email, then sign in.'
    public static readonly EmailExists = 'An account with this email already exists. Sign in instead.'
    public static readonly SubmitKey = 'Enter'
    private static readonly RefusalTexts: readonly string[] = [
        CentralLoginPage.EmailExists,
        'Your account was created, but the verification email could not be sent. Sign in to send it again.',
        'Choose a stronger password (at least 6 characters).',
        'Enter a valid email address.',
        'The passwords do not match.',
        'Too many attempts. Try again later.',
        'Sign-in is unavailable right now. Please try again.',
        'The sign-in page could not load. Please reload it.',
        'Invalid email or password.',
        'Verify your email address first: open the link in the email we sent you, then sign in again.',
        'This sign-in link is no longer valid. Return to the application and sign in again.',
        'This account is disabled.',
        'No sign-in method is configured for this realm.',
        'Signing in with Google did not complete. Please try again.',
    ]
    private static readonly NewPasswordFields = 2
    private static readonly FormDeadlineMs = 60_000
    private static readonly AnswerDeadlineMs = 60_000
    private static readonly SignUpForm = 'the central login\'s sign-up form'
    private static readonly SignInForm = 'the central login\'s sign-in form'
    private static readonly SignUpAnswer = 'the central login to accept the sign-up'
    private static readonly OnPage = 'on '
    private static readonly Refused = 'the central login refused: '
    private static readonly NotYet = 'no answer yet'

    public constructor(private readonly loginHost: string, private readonly waiter: Waiter)
    {
    }

    /** Waits until the browser is on the central login (any page of its host). */
    public async WaitUntilOn(page: IJourneyPage): Promise<void>
    {
        const C = CentralLoginPage
        await this.waiter.Until(C.SignInForm, async () =>
        {
            const here = new URL(page.Url()).host
            return here === this.loginHost && await page.Count(C.EmailSelector) > 0 ? WaitObservation.Met(true, here) : WaitObservation.NotYet<boolean>(C.OnPage + here)
        }, C.FormDeadlineMs)
    }

    /** Creates the account (email + password) and waits for "Check your email, then sign in."; throws a refusal by its text. */
    public async SignUp(page: IJourneyPage, email: string, password: string): Promise<void>
    {
        const C = CentralLoginPage
        await this.waiter.Until(C.SignUpForm, async () =>
        {
            if (await page.Count(C.NewPasswordSelector) >= C.NewPasswordFields)
            {
                return WaitObservation.Met(true, C.SignUpForm)
            }
            if (await page.HasText(C.CreateAccountLink))
            {
                await page.ClickText(C.CreateAccountLink)
            }
            return WaitObservation.NotYet<boolean>(C.OnPage + new URL(page.Url()).host)
        }, C.FormDeadlineMs)
        await page.Fill(C.EmailSelector, email)
        await page.Fill(C.NewPasswordSelector, password, 0)
        await page.Fill(C.NewPasswordSelector, password, 1)
        await page.ClickText(C.CreateAccountButton)
        await this.waiter.Until(C.SignUpAnswer, async () =>
        {
            if (await page.HasText(C.CheckEmailNotice))
            {
                return WaitObservation.Met(true, C.CheckEmailNotice)
            }
            const refusal = await this.Refusal(page)
            if (refusal !== undefined)
            {
                throw new CentralLoginRefusal(C.Refused + refusal)
            }
            return WaitObservation.NotYet<boolean>(C.NotYet)
        }, C.AnswerDeadlineMs)
    }

    /** Signs in with email and password (switching back from sign-up mode when needed) and submits with Enter. */
    public async SignIn(page: IJourneyPage, email: string, password: string): Promise<void>
    {
        const C = CentralLoginPage
        await this.waiter.Until(C.SignInForm, async () =>
        {
            if (await page.Count(C.CurrentPasswordSelector) > 0)
            {
                return WaitObservation.Met(true, C.SignInForm)
            }
            if (await page.HasText(C.BackToSignIn))
            {
                await page.ClickText(C.BackToSignIn)
            }
            return WaitObservation.NotYet<boolean>(C.OnPage + new URL(page.Url()).host)
        }, C.FormDeadlineMs)
        await page.Fill(C.EmailSelector, email)
        await page.Fill(C.CurrentPasswordSelector, password)
        await page.Press(C.CurrentPasswordSelector, C.SubmitKey)
    }

    /** The refusal the page shows, if any (its own fixed copy, so it carries no secret). */
    public async Refusal(page: IJourneyPage): Promise<string | undefined>
    {
        for (const text of CentralLoginPage.RefusalTexts)
        {
            if (await page.HasText(text))
            {
                return text
            }
        }
        return undefined
    }
}

/** The login page showed one of its refusals: the wait ends at once with it. */
export class CentralLoginRefusal extends WaitAbortError
{
}
