import { WaitAbortError, WaitObservation, type Waiter } from '../waiter.js'
import type { IJourneyFrame, IJourneyPage } from './journey-page.js'

/**
 * Paddle Billing's sandbox checkout overlay (Paddle.js v2, opened by the cabinet on the ledger's transaction), driven
 * through its frame on `sandbox-buy.paddle.com` by the data-testid hooks Paddle's checkout carries. It fills only
 * what a step asks for (email, then country and postcode, then the card) with Paddle's documented sandbox test card,
 * and waits for the checkout's own success step. The sandbox host is the only one this driver acts on: a live
 * checkout host would never match. The card number is public test data, yet never written to evidence.
 */
export class PaddleCheckout
{
    public static readonly SandboxHost = 'sandbox-buy.paddle.com'
    public static readonly TestCardNumber = '4242424242424242'
    public static readonly TestCardExpiry = '12/30'
    public static readonly TestCardCvv = '100'
    public static readonly CardholderName = 'Journey Test'
    public static readonly Country = 'US'
    public static readonly Postcode = '10001'
    public static readonly EmailInput = '[data-testid="authenticationEmailInput"]'
    public static readonly CountrySelect = '[data-testid="countriesSelect"]'
    public static readonly PostcodeInput = '[data-testid="postcodeInput"]'
    public static readonly LocationSubmit = '[data-testid="combinedAuthenticationLocationFormSubmitButton"]'
    public static readonly CardNumberInput = '[data-testid="cardNumberInput"]'
    public static readonly CardholderInput = '[data-testid="cardholderNameInput"]'
    public static readonly ExpiryInput = '[data-testid="expiryDateField"]'
    public static readonly CvvInput = '[data-testid="cardVerificationValueInput"]'
    public static readonly CardSubmit = '[data-testid="cardPaymentFormSubmitButton"]'
    public static readonly SuccessMarkers: readonly string[] = ['[data-testid="paymentSuccess"]']
    private static readonly ErrorMarkers: readonly string[] = ['[data-testid="paymentErrorMessage"]', '[data-testid="checkoutErrorContainer"]']
    private static readonly OverlayDeadlineMs = 60_000
    private static readonly PaymentDeadlineMs = 180_000
    private static readonly Overlay = 'Paddle\'s sandbox checkout overlay'
    private static readonly Payment = 'Paddle\'s checkout to confirm the sandbox payment'
    private static readonly Offers = 'checkout step offers: '
    private static readonly Refused = 'Paddle\'s checkout showed an error: '
    private static readonly ListSeparator = ','
    private static readonly NoFrame = 'no checkout frame'

    private readonly filled = new Set<string>()

    public constructor(private readonly waiter: Waiter)
    {
    }

    /**
     * Pays the open checkout with the test card; `email` fills the email step when Paddle asks for it. `submitting`
     * runs just before the card is submitted, so the caller can record that a payment may now complete.
     */
    public async Pay(page: IJourneyPage, email: string, submitting: () => void): Promise<void>
    {
        const P = PaddleCheckout
        await this.waiter.Until(P.Overlay, async () =>
            page.Frame(P.SandboxHost) !== undefined ? WaitObservation.Met(true, P.SandboxHost) : WaitObservation.NotYet<boolean>(P.NoFrame), P.OverlayDeadlineMs)
        await this.waiter.Until(P.Payment, async () =>
        {
            const frame = page.Frame(P.SandboxHost)
            if (frame === undefined)
            {
                return WaitObservation.NotYet<boolean>(P.NoFrame)
            }
            if (await this.Any(frame, P.SuccessMarkers))
            {
                return WaitObservation.Met(true, P.SuccessMarkers[0])
            }
            for (const marker of P.ErrorMarkers)
            {
                if (await frame.Count(marker) > 0)
                {
                    throw new WaitAbortError(P.Refused + marker)
                }
            }
            await this.Step(frame, email, submitting)
            return WaitObservation.NotYet<boolean>(P.Offers + (await frame.TestIds()).join(P.ListSeparator))
        }, P.PaymentDeadlineMs)
    }

    /** Does what the current step asks; each field once. */
    private async Step(frame: IJourneyFrame, email: string, submitting: () => void): Promise<void>
    {
        const P = PaddleCheckout
        if (await this.FillOnce(frame, P.EmailInput, email) || await frame.Count(P.PostcodeInput) > 0)
        {
            if (await frame.Count(P.CountrySelect) > 0 && !this.filled.has(P.CountrySelect))
            {
                await frame.SelectOption(P.CountrySelect, P.Country)
                this.filled.add(P.CountrySelect)
            }
            await this.FillOnce(frame, P.PostcodeInput, P.Postcode)
            if (await frame.Count(P.LocationSubmit) > 0 && await frame.Count(P.CardNumberInput) === 0)
            {
                await frame.Click(P.LocationSubmit)
                return
            }
        }
        if (await frame.Count(P.CardNumberInput) > 0)
        {
            await this.FillOnce(frame, P.CardNumberInput, P.TestCardNumber)
            await this.FillOnce(frame, P.CardholderInput, P.CardholderName)
            await this.FillOnce(frame, P.ExpiryInput, P.TestCardExpiry)
            await this.FillOnce(frame, P.CvvInput, P.TestCardCvv)
            if (await frame.Count(P.CardSubmit) > 0 && !this.filled.has(P.CardSubmit))
            {
                submitting()
                await frame.Click(P.CardSubmit)
                this.filled.add(P.CardSubmit)
            }
        }
    }

    private async FillOnce(frame: IJourneyFrame, selector: string, value: string): Promise<boolean>
    {
        if (this.filled.has(selector) || await frame.Count(selector) === 0)
        {
            return false
        }
        await frame.Fill(selector, value)
        this.filled.add(selector)
        return true
    }

    private async Any(frame: IJourneyFrame, selectors: readonly string[]): Promise<boolean>
    {
        for (const selector of selectors)
        {
            if (await frame.Count(selector) > 0)
            {
                return true
            }
        }
        return false
    }
}
