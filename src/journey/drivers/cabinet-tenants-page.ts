import { WaitObservation, type Waiter } from '../waiter.js'
import { CabinetPage } from './cabinet-page.js'
import type { CustomerSession } from './customer-session.js'
import type { IJourneyPage } from './journey-page.js'

/** How the presses of "Create tenant" ended. */
export enum TenantCreation
{
    /** The notice or the list shows the tenant. */
    Created = 'created',
    /** Answered tenant-taken or limit-reached: the run's own earlier press may have landed, so a reload decides. */
    Settle = 'settle',
}

/**
 * The cabinet's Tenants section (pragmatic-cabinet `ui/src/sections/tenants/`): reached from the navigation, it lists
 * the client's tenants (list-tenants) and creates one (create-tenant) from its id and name. Until the client's paid
 * entitlement statement reaches the platform admin console, the console refuses as "not an administrator" (no
 * statement yet) or "not in plan" (the statement before the payment), the list's load included; those refusals, an
 * outage and a lost answer are waited through at a slow pace (the edge allows 60 customer calls a minute per sign-in):
 * the list by reopening the section from the account page, a press by pressing again (a press while one runs does
 * nothing; one after a press that landed is answered taken or limit-reached, which the caller settles by a reload).
 */
export class CabinetTenantsPage
{
    public static readonly NavLabel = 'Tenants'
    public static readonly FormTitle = 'Create a tenant'
    public static readonly CreateButton = 'Create tenant'
    public static readonly Loading = 'Loading tenants...'
    public static readonly EmptyList = 'No tenants yet. Create your first one below.'
    public static readonly ListHeader = 'Tenant id'
    public static readonly TenantIdSelector = 'input[placeholder="e.g. acme"]'
    public static readonly DisplayNameSelector = 'input[placeholder="e.g. Acme"]'
    public static readonly CreatedPrefix = 'Created tenant '
    public static readonly CreatedSuffix = '. Next, enrol a hive for it on the Hives page.'
    public static readonly TakenText = 'That tenant id is already taken. Please choose another.'
    public static readonly LimitReachedText = 'You have reached the limit of your plan. Choose a larger plan to add more.'
    public static readonly NotInPlanText = 'Your plan does not include this yet. Choose a plan on the Account page first.'
    public static readonly PressIntervalMs = 5_000
    /** The refusals that pass: the statement on its way, an outage, a lost answer (pragmatic-cabinet `CabinetCopy`). */
    public static readonly WaitedRefusals: readonly string[] = [
        CabinetPage.NotAdminError,
        CabinetTenantsPage.NotInPlanText,
        CabinetPage.NotEntitledError,
        CabinetPage.UnavailableError,
        CabinetPage.FallbackError,
    ]
    /** The answers a press of this run's own earlier landed press would also get. */
    private static readonly SettleTexts: readonly string[] = [CabinetTenantsPage.TakenText, CabinetTenantsPage.LimitReachedText]
    /** The section's own final refusals, beside the cabinet's common ones. */
    private static readonly SectionRefusals: readonly string[] = [
        'Your subscription is suspended, so this is not available. Check your subscription on the Account page.',
        'A tenant id is 3 to 32 lowercase letters, digits or dashes, starting with a letter, for example acme or acme-prod.',
        'Enter a name for the tenant.',
    ]
    private static readonly SectionDeadlineMs = 3 * 60_000
    private static readonly Section = 'the cabinet\'s Tenants page with its list loaded'
    private static readonly ToBeCreated = 'the tenant '
    private static readonly ToBeCreatedSuffix = ' to be created'
    private static readonly NoAnswer = 'Create pressed, no recognised answer yet'
    private static readonly StillLoading = 'the list still loading'
    private static readonly NoForm = 'the Tenants form not shown yet, on '
    private static readonly Unrecognised = 'the list neither loaded nor loading (an unrecognised answer), reopening'
    private static readonly ListRefused = 'the list refused, reopening: '

    public constructor(private readonly session: CustomerSession, private readonly cabinet: CabinetPage, private readonly waiter: Waiter)
    {
    }

    /**
     * The client's account page, then its Tenants section, waited for until the list has loaded (its table or its empty
     * text). A list refused by a waited refusal is reopened from the account page; any other refusal fails at once.
     */
    public async Open(clientName: string): Promise<IJourneyPage>
    {
        const T = CabinetTenantsPage
        let page = await this.session.AccountPage(clientName)
        await this.waiter.Until(T.Section, async () =>
        {
            if (await page.HasText(T.FormTitle))
            {
                if (await page.HasText(T.EmptyList) || await page.HasText(T.ListHeader))
                {
                    return WaitObservation.Met(true, T.FormTitle)
                }
                const refused = await this.cabinet.ShownState(page, T.WaitedRefusals)
                if (refused !== undefined)
                {
                    // A fresh page each time: the shell builds the section anew on every navigation.
                    page = await this.session.AccountPage(clientName)
                    return WaitObservation.NotYet<boolean>(T.ListRefused + refused)
                }
                await this.cabinet.ThrowRefusal(page, T.SectionRefusals)
                if (await page.HasText(T.Loading))
                {
                    return WaitObservation.NotYet<boolean>(T.StillLoading)
                }
                // Neither loaded nor loading: an answer the cabinet shows raw (a failed fetch); reopen as for a refusal.
                page = await this.session.AccountPage(clientName)
                return WaitObservation.NotYet<boolean>(T.Unrecognised)
            }
            if (await this.cabinet.IsOnAccount(page, clientName))
            {
                // Only the navigation says "Tenants" on the account page.
                await page.ClickText(T.NavLabel)
            }
            const url = new URL(page.Url())
            return WaitObservation.NotYet<boolean>(T.NoForm + url.host + url.pathname)
        }, T.SectionDeadlineMs, T.PressIntervalMs)
        return page
    }

    /** Whether the loaded list shows the tenant (its id cell is the exact text). */
    public IsListed(page: IJourneyPage, tenantId: string): Promise<boolean>
    {
        return page.HasText(tenantId)
    }

    /**
     * On the opened section: fills the form and presses Create until the tenant is listed or the "Created tenant" notice
     * shows (Created), the press is answered taken or limit-reached (Settle), a final refusal shows (fails at once), or
     * the deadline passes (fails naming the last answer seen). Anything else presses again at the slow pace.
     */
    public async Create(page: IJourneyPage, tenantId: string, displayName: string, deadlineMs: number): Promise<TenantCreation>
    {
        const T = CabinetTenantsPage
        await page.Fill(T.TenantIdSelector, tenantId)
        await page.Fill(T.DisplayNameSelector, displayName)
        await page.ClickText(T.CreateButton)
        const notice = T.CreatedPrefix + tenantId + T.CreatedSuffix
        return this.waiter.Until(T.ToBeCreated + tenantId + T.ToBeCreatedSuffix, async () =>
        {
            if (await page.HasText(notice) || await this.IsListed(page, tenantId))
            {
                return WaitObservation.Met(TenantCreation.Created, notice)
            }
            const settle = await this.cabinet.ShownState(page, T.SettleTexts)
            if (settle !== undefined)
            {
                return WaitObservation.Met(TenantCreation.Settle, settle)
            }
            const waited = await this.cabinet.ShownState(page, T.WaitedRefusals)
            if (waited === undefined)
            {
                await this.cabinet.ThrowRefusal(page, T.SectionRefusals)
            }
            // The form keeps its values after a refusal; a press clears the refusal and asks again.
            await page.ClickText(T.CreateButton)
            return WaitObservation.NotYet<TenantCreation>(waited ?? T.NoAnswer)
        }, deadlineMs, T.PressIntervalMs)
    }
}
