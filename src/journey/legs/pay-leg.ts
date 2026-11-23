import { CabinetPage } from '../drivers/cabinet-page.js'
import type { CustomerSession } from '../drivers/customer-session.js'
import type { PaddleCheckout } from '../drivers/paddle-checkout.js'
import type { Evidence } from '../evidence.js'
import type { JourneyContext } from '../journey-context.js'
import { JourneyDependency } from '../journey-dependency.js'
import type { IJourneyLeg } from '../journey-leg.js'
import type { JourneyIdentity } from '../live/journey-identity.js'
import { WaitObservation, type Waiter } from '../waiter.js'
import { JourneyKeys, JourneyLegName, JourneyState } from './journey-keys.js'

/** What the clean found on the account page. */
enum CancelFinding
{
    Cancellable = 'cancellable',
    AlreadyScheduled = 'already-scheduled',
    AlreadyCancelled = 'already-cancelled',
}

/**
 * Leg 3: payment. On the cabinet's account page the customer chooses the journey's plan, pays in Paddle's sandbox
 * overlay with Paddle's test card, and the subscription turns live (Active, or Trial for a plan with one) once
 * Paddle's webhook reached the ledger (the cabinet reads it from the ledger). The entitlement half (the statement
 * applied by the platform admin console) is the Tenant leg's dependency. The checkout's progress is recorded as it
 * happens (opened, submitted, paid), so a resumed Run does not buy twice and the clean knows whether a subscription
 * must appear. Clean cancels the subscription at the end of the period from the same page.
 */
export class PayLeg implements IJourneyLeg
{
    public readonly Name = JourneyLegName.Pay
    public readonly Dependencies = [JourneyDependency.Cabinet, JourneyDependency.CentralLogin, JourneyDependency.PaddleSandbox]
    public readonly DeadlineMs = 10 * 60_000
    private static readonly LiveDeadlineMs = 5 * 60_000
    private static readonly PaidCancelDeadlineMs = 3 * 60_000
    private static readonly OpenedCancelDeadlineMs = 30_000
    private static readonly Cancellable = 'the subscription to offer its cancellation'
    private static readonly NotYet = 'no cancellable subscription yet'
    private static readonly Chose = 'chose the plan '
    private static readonly Submitting = 'submitting the test card'
    private static readonly Paid = 'paid in Paddle\'s sandbox checkout with the test card'
    private static readonly LiveNote = 'the cabinet shows the subscription '
    private static readonly AlreadyLive = 'resumed: the subscription is already '
    private static readonly AwaitingWebhook = 'resumed: the checkout was submitted; waiting for the subscription'
    private static readonly Cancelled = 'cancellation at the end of the period scheduled'
    private static readonly NothingToCancel = 'no subscription to cancel'
    private static readonly AlreadyCancelled = 'cancellation already scheduled'
    private static readonly PaidStates: readonly string[] = [JourneyState.CheckoutSubmitted, JourneyState.CheckoutPaid]

    public constructor(
        private readonly session: CustomerSession,
        private readonly cabinet: CabinetPage,
        private readonly paddle: PaddleCheckout,
        private readonly identity: JourneyIdentity,
        private readonly planName: string,
        private readonly waiter: Waiter,
        private readonly evidence: Evidence)
    {
    }

    public async Run(context: JourneyContext): Promise<void>
    {
        const P = PayLeg
        const clientName = context.Require(JourneyKeys.ClientName)
        let page = await this.session.AccountPage(clientName)
        const already = await this.cabinet.ShownState(page, CabinetPage.LiveStates)
        if (already !== undefined)
        {
            context.Set(JourneyKeys.Subscription, JourneyState.Active)
            this.evidence.Step(this.Name, P.AlreadyLive + already)
            return
        }
        const checkout = context.Get(JourneyKeys.Checkout)
        if (checkout !== undefined && P.PaidStates.includes(checkout))
        {
            this.evidence.Step(this.Name, P.AwaitingWebhook)
        }
        else
        {
            context.Set(JourneyKeys.Plan, this.planName)
            context.Set(JourneyKeys.Checkout, JourneyState.CheckoutOpened)
            await this.cabinet.ChoosePlan(page, this.planName)
            this.evidence.Step(this.Name, P.Chose + this.planName)
            await this.paddle.Pay(page, this.identity.Email, () =>
            {
                context.Set(JourneyKeys.Checkout, JourneyState.CheckoutSubmitted)
                this.evidence.Step(this.Name, P.Submitting)
            })
            context.Set(JourneyKeys.Checkout, JourneyState.CheckoutPaid)
            this.evidence.Step(this.Name, P.Paid)
            page = await this.session.AccountPage(clientName)
        }
        const shown = await this.cabinet.WaitForSubscription(page, CabinetPage.LiveStates, P.LiveDeadlineMs)
        context.Set(JourneyKeys.Subscription, JourneyState.Active)
        this.evidence.Step(this.Name, P.LiveNote + shown)
    }

    public async Clean(context: JourneyContext): Promise<void>
    {
        const P = PayLeg
        const checkout = context.Get(JourneyKeys.Checkout)
        const clientName = context.Get(JourneyKeys.ClientName)
        if (checkout === undefined || clientName === undefined)
        {
            this.evidence.Step(this.Name, P.NothingToCancel)
            return
        }
        if (context.Get(JourneyKeys.Subscription) === JourneyState.CancelScheduled)
        {
            this.evidence.Step(this.Name, P.AlreadyCancelled)
            return
        }
        const page = await this.session.AccountPage(clientName)
        const mustExist = P.PaidStates.includes(checkout)
        const finding = await this.waiter.Until(P.Cancellable, async () =>
        {
            if (await this.cabinet.CanCancel(page))
            {
                return WaitObservation.Met(CancelFinding.Cancellable, P.Cancellable)
            }
            if (await page.HasText(CabinetPage.CancelledState))
            {
                return WaitObservation.Met(CancelFinding.AlreadyCancelled, CabinetPage.CancelledState)
            }
            if (await this.cabinet.ShownState(page, CabinetPage.LiveStates) !== undefined)
            {
                // A live subscription without the Cancel button already has its cancellation scheduled.
                return WaitObservation.Met(CancelFinding.AlreadyScheduled, P.AlreadyCancelled)
            }
            await this.cabinet.Refresh(page)
            return WaitObservation.NotYet<CancelFinding>(P.NotYet)
        }, mustExist ? P.PaidCancelDeadlineMs : P.OpenedCancelDeadlineMs).catch(async error =>
        {
            // After the long wait, "No subscription yet" or "Waiting for payment" means the payment never completed
            // (declined, abandoned): nothing to cancel. Anything else (a subscription the page cannot cancel) fails.
            if (!mustExist || await page.HasText(CabinetPage.NoSubscription) || await page.HasText(CabinetPage.WaitingState))
            {
                return undefined
            }
            throw error
        })
        if (finding === undefined)
        {
            this.evidence.Step(this.Name, P.NothingToCancel)
            return
        }
        if (finding === CancelFinding.Cancellable)
        {
            await this.cabinet.CancelSubscription(page)
        }
        context.Set(JourneyKeys.Subscription, JourneyState.CancelScheduled)
        this.evidence.Step(this.Name, finding === CancelFinding.Cancellable ? P.Cancelled : P.AlreadyCancelled)
    }
}
