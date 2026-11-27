import { WaitObservation, type Waiter } from '../waiter.js'
import type { IJourneyPage } from './journey-page.js'

/**
 * The Users & Access section of the customer's own engine console (pragmatic-tenant-admin
 * `tenant-portal/src/sections/users-access/`: `users-access.resources.mu`, `create-account-dialog-view-model.ts`,
 * `account-detail-page-view-model.ts`), after the Owner signed in (EngineConsolePage). It picks the environment, creates
 * a local account (email, principal id, password: the dialog says "Creates a local account in <environment>", which is
 * how it shows that the tenant's realm has local accounts: the console has no toggle for them), opens an account to
 * grant it a role from the "Grant a role" box ("Admin" holds every console capability, environments included), and
 * disables an account ("Disable account", confirmed in its own dialog).
 */
export class TenantConsolePage
{
    public static readonly NavLabel = 'Users & Access'
    public static readonly EnvironmentPlaceholder = 'Choose environment'
    public static readonly UsersTab = 'Users'
    public static readonly CreateAccountLabel = 'Create account'
    public static readonly CancelLabel = 'Cancel'
    public static readonly LocalAccountsNotice = 'Creates a local account in'
    public static readonly EmailSelector = 'input[placeholder="person@example.com"]'
    public static readonly PrincipalSelector = 'input[placeholder="e.g. jane.doe"]'
    public static readonly PasswordSelector = 'input[autocomplete="new-password"]'
    public static readonly GrantRoleCaption = 'Grant a role'
    public static readonly ViewerRole = 'Viewer'
    public static readonly AdminRole = 'Admin'
    public static readonly GrantButton = 'Grant'
    public static readonly NoGrantsText = 'No roles granted in this environment.'
    public static readonly DisableLabel = 'Disable account'
    public static readonly ActiveStatus = 'Active'
    public static readonly DisabledStatus = 'Disabled'
    public static readonly EnvironmentsNav = 'Environments'
    public static readonly CreateEnvironmentLabel = 'Create environment'
    public static readonly EnvironmentNameSelector = 'input[placeholder="e.g. training-q4"]'
    public static readonly NoEnvironmentsText = 'No environments yet'
    public static readonly RunningStatus = 'Running'
    public static readonly HealthyStatus = 'Healthy'
    public static readonly UnknownStatus = 'Unknown'
    public static readonly EnvironmentBudgetMs = 10 * 60_000
    public static readonly OpenBudgetMs = 2 * 60_000
    public static readonly DialogBudgetMs = 30_000
    public static readonly CreateBudgetMs = 60_000
    public static readonly GrantBudgetMs = 60_000
    private static readonly EnvironmentsShown = "the console's Environments page"
    private static readonly EnvironmentDialog = 'the Create environment dialog to open'
    private static readonly EnvironmentListed = 'the console to list the environment '
    private static readonly EnvironmentRunning = 'the console to show the environment running and healthy: '
    private static readonly UsersShown = 'the console\'s Users & Access page for environment '
    private static readonly OnPage = 'on '
    private static readonly LocalAccountsOffered = 'the Create account dialog to say it creates a local account (the realm has local accounts)'
    private static readonly AccountListed = 'the console to list the account '
    private static readonly AccountOpened = 'the console to open the account '
    private static readonly RoleGranted = 'the console to show the role granted: '
    private static readonly DisableAsked = 'the console to ask to confirm disabling the account'
    private static readonly AccountDisabled = 'the console to show the account Disabled: '
    private static readonly Pending = 'pending'
    private static readonly AnyEnvironment = ''
    private static readonly NoText = ''
    private static readonly StartAnchor = '^'
    private static readonly EndAnchor = '$'

    public constructor(private readonly waiter: Waiter)
    {
    }

    /**
     * Makes sure environment `name` exists and is ready (pragmatic-tenant-admin `tenant-portal/src/sections/environments/`:
     * `environments.resources.mu`, `create-environment-dialog-view-model.ts`, `environment-row.ts`). Accounts and role
     * grants are scoped to an environment and a fresh install has none ("No environments yet"), so the Owner creates it.
     * Opens the Environments section; when `name` is not listed, presses "Create environment", types the name in the
     * dialog (its template and type keep their defaults: "Blank development (dev-blank)" and "Runtime"; the server takes
     * only name, template and type) and confirms with the dialog's own "Create environment" button. Then waits (it takes
     * minutes) until the row shows the status "Running" and the health "Healthy". Returns whether it created it
     * (false when it was already listed: resumed, never a second create).
     */
    public async EnsureEnvironment(page: IJourneyPage, name: string): Promise<boolean>
    {
        const T = TenantConsolePage
        await this.waiter.Until(T.EnvironmentsShown, async () =>
        {
            if (await page.HasText(T.CreateEnvironmentLabel))
            {
                return WaitObservation.Met(true, T.CreateEnvironmentLabel)
            }
            if (await page.HasText(T.EnvironmentsNav))
            {
                await page.ClickText(T.EnvironmentsNav)
            }
            return WaitObservation.NotYet<boolean>(T.OnPage + new URL(page.Url()).host)
        }, T.OpenBudgetMs)
        let created = false
        if (!await page.HasText(name))
        {
            await page.ClickText(T.CreateEnvironmentLabel)
            await this.waiter.Until(T.EnvironmentDialog, async () =>
                await page.Count(T.EnvironmentNameSelector) > 0 ? WaitObservation.Met(true, T.CancelLabel) : WaitObservation.NotYet<boolean>(T.Pending), T.DialogBudgetMs)
            await page.Fill(T.EnvironmentNameSelector, name)
            // The page's button has the same label: the dialog's is the one beside Cancel.
            await page.ClickTextNear(T.CreateEnvironmentLabel, T.CancelLabel)
            await this.waiter.Until(T.EnvironmentListed + name, async () =>
                await page.HasText(name) && !await page.HasText(T.CancelLabel) ? WaitObservation.Met(true, name) : WaitObservation.NotYet<boolean>(T.CreateEnvironmentLabel), T.CreateBudgetMs)
            created = true
        }
        await this.waiter.Until(T.EnvironmentRunning + name, async () =>
        {
            const status = await page.TextNear(name, new RegExp(T.StartAnchor + T.RunningStatus + T.EndAnchor))
            const health = await page.TextNear(name, new RegExp(T.StartAnchor + T.HealthyStatus + T.EndAnchor))
            return status !== T.NoText && health !== T.NoText
                ? WaitObservation.Met(true, status + ' ' + health)
                : WaitObservation.NotYet<boolean>(T.Pending)
        }, T.EnvironmentBudgetMs)
        return created
    }

    /** Opens Users & Access (from the overview or where the page already is) with `environment` picked (any when ''). */
    public async OpenUsers(page: IJourneyPage, environment: string): Promise<void>
    {
        const T = TenantConsolePage
        await this.waiter.Until(T.UsersShown + environment, async () =>
        {
            if (!await page.HasText(T.CreateAccountLabel))
            {
                if (await page.HasText(T.NavLabel))
                {
                    await page.ClickText(T.NavLabel)
                }
                return WaitObservation.NotYet<boolean>(T.OnPage + new URL(page.Url()).host)
            }
            if (await page.HasText(T.EnvironmentPlaceholder))
            {
                if (environment === T.AnyEnvironment)
                {
                    return WaitObservation.NotYet<boolean>(T.EnvironmentPlaceholder)
                }
                await page.ClickText(T.EnvironmentPlaceholder)
                if (await page.HasText(environment))
                {
                    await page.ClickText(environment)
                }
                return WaitObservation.NotYet<boolean>(T.EnvironmentPlaceholder)
            }
            return WaitObservation.Met(true, T.UsersTab)
        }, T.OpenBudgetMs)
    }

    /** Whether the Users tab lists the account (its email is the row's button). */
    public async IsListed(page: IJourneyPage, email: string): Promise<boolean>
    {
        return page.HasText(email)
    }

    /**
     * Presses Create account, waits for the dialog to say it creates a local account (a realm without local accounts
     * never says it), fills the email, the principal id and the password, confirms and waits until the account is listed.
     */
    public async CreateAccount(page: IJourneyPage, email: string, principalId: string, password: string): Promise<void>
    {
        const T = TenantConsolePage
        await page.ClickText(T.CreateAccountLabel)
        await this.waiter.Until(T.LocalAccountsOffered, async () =>
            await page.HasText(T.LocalAccountsNotice) && await page.Count(T.EmailSelector) > 0
                ? WaitObservation.Met(true, T.LocalAccountsNotice)
                : WaitObservation.NotYet<boolean>(T.Pending), T.DialogBudgetMs)
        await page.Fill(T.EmailSelector, email)
        await page.Fill(T.PrincipalSelector, principalId)
        await page.Fill(T.PasswordSelector, password)
        // The header's button has the same label: the dialog's is the one beside Cancel.
        await page.ClickTextNear(T.CreateAccountLabel, T.CancelLabel)
        await this.waiter.Until(T.AccountListed + email, async () =>
            await page.HasText(email) && !await page.HasText(T.CancelLabel)
                ? WaitObservation.Met(true, email)
                : WaitObservation.NotYet<boolean>(T.CreateAccountLabel), T.CreateBudgetMs)
    }

    /** Opens the account's detail (its grants, Grant a role, Disable account). */
    public async OpenAccount(page: IJourneyPage, email: string): Promise<void>
    {
        const T = TenantConsolePage
        await page.ClickText(email)
        await this.waiter.Until(T.AccountOpened + email, async () =>
            await page.HasText(T.GrantRoleCaption) ? WaitObservation.Met(true, T.GrantRoleCaption) : WaitObservation.NotYet<boolean>(T.Pending), T.OpenBudgetMs)
    }

    /** Whether the open account's Grants list holds `role` (asked before the role box is opened: its choices list roles too). */
    public async HasGrant(page: IJourneyPage, role: string): Promise<boolean>
    {
        const T = TenantConsolePage
        if (await page.HasText(T.NoGrantsText))
        {
            return false
        }
        return (await page.TextsMatching(new RegExp(T.StartAnchor + role + T.EndAnchor))).length > 0
    }

    /** Grant a role: opens the box (its choice is Viewer), picks `role`, presses Grant and waits for the grant to list. */
    public async GrantRole(page: IJourneyPage, role: string): Promise<void>
    {
        const T = TenantConsolePage
        await page.ClickText(T.ViewerRole)
        await page.ClickText(role)
        await page.ClickText(T.GrantButton)
        await this.waiter.Until(T.RoleGranted + role, async () =>
            await page.HasText(T.NoGrantsText) ? WaitObservation.NotYet<boolean>(T.NoGrantsText) : WaitObservation.Met(true, role), T.GrantBudgetMs)
    }

    /** Disables the open account and waits until it shows Disabled; false when it already was. */
    public async DisableAccount(page: IJourneyPage): Promise<boolean>
    {
        const T = TenantConsolePage
        if (await page.HasText(T.DisabledStatus))
        {
            return false
        }
        await page.ClickText(T.DisableLabel)
        await this.waiter.Until(T.DisableAsked, async () =>
            await page.HasText(T.CancelLabel) ? WaitObservation.Met(true, T.CancelLabel) : WaitObservation.NotYet<boolean>(T.DisableLabel), T.DialogBudgetMs)
        // The page's button has the same label: the dialog's is the one beside Cancel.
        await page.ClickTextNear(T.DisableLabel, T.CancelLabel)
        await this.waiter.Until(T.AccountDisabled + T.DisabledStatus, async () =>
            await page.HasText(T.DisabledStatus) ? WaitObservation.Met(true, T.DisabledStatus) : WaitObservation.NotYet<boolean>(T.DisableLabel), T.CreateBudgetMs)
        return true
    }
}
