import { WaitObservation, type Waiter } from '../waiter.js'
import { CabinetPage } from './cabinet-page.js'
import type { CustomerSession } from './customer-session.js'
import type { IJourneyPage } from './journey-page.js'

/** The TXT record the cabinet asks the customer to publish for a domain. */
export class DomainChallenge
{
    public constructor(public readonly Name: string, public readonly Value: string)
    {
    }
}

/**
 * The cabinet's "Email domains" section (pragmatic-cabinet `ui/src/sections/domains/`): reached from the navigation, it
 * shows a form (the tenant, the email domain, "Get the DNS record") and, once a domain is started, a row with the
 * domain, its state, the record's Type / Name / Value and a "Check" button. The tenant box keeps its first option (the
 * client's tenant, the only one a journey path makes). Refusals are waited through as on the Tenants page: the section
 * by reopening it from the account page, a press by pressing again.
 */
export class CabinetDomainsPage
{
    public static readonly NavLabel = 'Email domains'
    public static readonly FormTitle = 'Verify a domain'
    public static readonly StartButton = 'Get the DNS record'
    public static readonly CheckButton = 'Check'
    public static readonly Loading = 'Loading...'
    public static readonly NoTenants = 'Create a tenant on the Tenants page first.'
    public static readonly DomainSelector = 'input[placeholder="e.g. acme.com"]'
    public static readonly VerifiedText = 'Verified'
    public static readonly NotVerifiedText = 'Not verified'
    public static readonly PendingText = 'Waiting for the DNS record'
    /** The record's value as the cabinet's platform issues it (`pragmatic-verify=<token>`). */
    public static readonly ValuePattern = /^pragmatic-verify=\S+$/
    public static readonly PressIntervalMs = 5_000
    public static readonly CheckIntervalMs = 10_000
    /** The refusals that pass: the statement on its way, an outage, a lost answer (pragmatic-cabinet `CabinetCopy`). */
    public static readonly WaitedRefusals: readonly string[] = [
        CabinetPage.NotAdminError,
        CabinetPage.NotEntitledError,
        CabinetPage.UnavailableError,
        CabinetPage.FallbackError,
    ]
    /** The section's own final refusals, beside the cabinet's common ones. */
    private static readonly SectionRefusals: readonly string[] = [
        'That is not an email domain we can verify. Enter just the domain, for example acme.com.',
        'That domain is already verified by another tenant.',
        'Choose the tenant the domain belongs to. Create a tenant on the Tenants page first.',
        'Enter the email domain, for example acme.com.',
        CabinetDomainsPage.NoTenants,
    ]
    private static readonly SectionDeadlineMs = 3 * 60_000
    private static readonly Section = 'the cabinet\'s Email domains page with its form loaded'
    private static readonly ToBeChallenged = 'the cabinet to show the DNS record for '
    private static readonly ToBeVerified = 'the cabinet to show the domain verified: '
    private static readonly NoAnswer = 'Get the DNS record pressed, no record shown yet'
    private static readonly NotYetVerified = 'not verified yet, pressing Check again'
    private static readonly StillLoading = 'the section still loading'
    private static readonly NoForm = 'the Email domains form not shown yet, on '
    private static readonly Unrecognised = 'the section neither loaded nor loading (an unrecognised answer), reopening'
    private static readonly SectionRefused = 'the section refused, reopening: '
    private static readonly NamePrefix = '^\\S+\\.'
    private static readonly Suffix = '$'
    private static readonly RegexSpecials = /[.*+?^${}()|[\]\\]/g
    private static readonly Escaped = '\\$&'

    public constructor(private readonly session: CustomerSession, private readonly cabinet: CabinetPage, private readonly waiter: Waiter)
    {
    }

    /** The client's account page, then its Email domains section, waited for until its form shows. */
    public async Open(clientName: string): Promise<IJourneyPage>
    {
        const D = CabinetDomainsPage
        let page = await this.session.AccountPage(clientName)
        await this.waiter.Until(D.Section, async () =>
        {
            if (await page.HasText(D.FormTitle))
            {
                return WaitObservation.Met(true, D.FormTitle)
            }
            const refused = await this.cabinet.ShownState(page, D.WaitedRefusals)
            if (refused !== undefined)
            {
                page = await this.session.AccountPage(clientName)
                return WaitObservation.NotYet<boolean>(D.SectionRefused + refused)
            }
            if (await this.cabinet.IsOnAccount(page, clientName))
            {
                // Only the navigation says "Email domains" on the account page.
                await page.ClickText(D.NavLabel)
                return WaitObservation.NotYet<boolean>(D.NoForm + D.NavLabel)
            }
            if (await page.HasText(D.Loading))
            {
                return WaitObservation.NotYet<boolean>(D.StillLoading)
            }
            if (await page.HasText(D.NavLabel))
            {
                // On the section but with no form: no tenant yet (final), or a raw failed fetch (reopen).
                await this.cabinet.ThrowRefusal(page, D.SectionRefusals)
                page = await this.session.AccountPage(clientName)
                return WaitObservation.NotYet<boolean>(D.Unrecognised)
            }
            const url = new URL(page.Url())
            return WaitObservation.NotYet<boolean>(D.NoForm + url.host + url.pathname)
        }, D.SectionDeadlineMs, D.PressIntervalMs)
        return page
    }

    /**
     * On the opened section: enters the domain and presses "Get the DNS record" until the row shows the TXT record's
     * name (`_pragmatic-verify.<domain>`) and value (`pragmatic-verify=<token>`); a final refusal fails at once, a
     * waited one presses again at the slow pace.
     */
    public async Start(page: IJourneyPage, domain: string, deadlineMs: number): Promise<DomainChallenge>
    {
        const D = CabinetDomainsPage
        await page.Fill(D.DomainSelector, domain)
        await page.ClickText(D.StartButton)
        const namePattern = new RegExp(D.NamePrefix + domain.replace(D.RegexSpecials, D.Escaped) + D.Suffix)
        return this.waiter.Until(D.ToBeChallenged + domain, async () =>
        {
            const name = await page.TextMatching(namePattern)
            const value = await page.TextMatching(D.ValuePattern)
            if (name.length > 0 && value.length > 0)
            {
                return WaitObservation.Met(new DomainChallenge(name.trim(), value.trim()), name)
            }
            const waited = await this.cabinet.ShownState(page, D.WaitedRefusals)
            if (waited === undefined)
            {
                await this.cabinet.ThrowRefusal(page, D.SectionRefusals)
            }
            // The form keeps its values after a refusal; a press clears the refusal and asks again.
            await page.ClickText(D.StartButton)
            return WaitObservation.NotYet<DomainChallenge>(waited ?? D.NoAnswer)
        }, deadlineMs, D.PressIntervalMs)
    }

    /**
     * Presses "Check" until the row shows the domain verified. The platform looks the record up when asked, and a new
     * record can take minutes to be visible, so "Not verified" is pressed again at a slow pace until the deadline.
     */
    public async Check(page: IJourneyPage, domain: string, deadlineMs: number): Promise<void>
    {
        const D = CabinetDomainsPage
        await page.ClickText(D.CheckButton)
        await this.waiter.Until(D.ToBeVerified + domain, async () =>
        {
            if (await page.HasText(D.VerifiedText))
            {
                return WaitObservation.Met(true, D.VerifiedText)
            }
            const waited = await this.cabinet.ShownState(page, D.WaitedRefusals)
            if (waited === undefined)
            {
                await this.cabinet.ThrowRefusal(page, D.SectionRefusals)
            }
            await page.ClickText(D.CheckButton)
            return WaitObservation.NotYet<boolean>(waited ?? (await page.HasText(D.NotVerifiedText) ? D.NotVerifiedText : D.NotYetVerified))
        }, deadlineMs, D.CheckIntervalMs)
    }
}
