import type { IJourneyPage } from './journey-page.js'

interface IAdminSnapshot
{
    accounts: Array<{ principalId: string, email: string, disabled: boolean }>
    grants: Array<{ subject: string, role: string, resourceKind: string, resourcePath: string[] }>
}

/**
 * Drives the tenant console's tenant-api (the admin snapshot, accounts and grants routes) as the signed-in owner's browser
 * session. The hosted console's account UI is an icon-only rail the text driver cannot reach, so the staff account is
 * created, granted and disabled through the same-origin HTTP routes instead; the owner holds the tenant `admin` role.
 */
export class TenantConsoleApi
{
    /** The server's grant-role identifier for the tenant Admin role. */
    public static readonly AdminRole = 'Admin'
    private static readonly EnvironmentsRoot = '/tenant-api/environments/'
    private static readonly SnapshotLeaf = '/admin/snapshot'
    private static readonly AccountsLeaf = '/admin/accounts'
    private static readonly GrantsLeaf = '/admin/grants'
    private static readonly Slash = '/'
    private static readonly Get = 'GET'
    private static readonly Post = 'POST'
    private static readonly Delete = 'DELETE'

    public async AccountExists(page: IJourneyPage, environment: string, email: string): Promise<boolean>
    {
        const snapshot = await this.Snapshot(page, environment)
        return snapshot.accounts.some(account => account.email === email)
    }

    public async CreateAccount(page: IJourneyPage, environment: string, email: string, principalId: string, password: string): Promise<void>
    {
        const L = TenantConsoleApi
        await page.RequestJson(L.Post, this.Route(environment) + L.AccountsLeaf, { email, principalId, password })
    }

    public async HasGrant(page: IJourneyPage, environment: string, principalId: string, role: string): Promise<boolean>
    {
        const snapshot = await this.Snapshot(page, environment)
        return snapshot.grants.some(grant => grant.subject === principalId && grant.role === role)
    }

    public async GrantRole(page: IJourneyPage, environment: string, principalId: string, role: string): Promise<void>
    {
        const L = TenantConsoleApi
        await page.RequestJson(L.Post, this.Route(environment) + L.GrantsLeaf, { subject: principalId, role })
    }

    /** Disables the account; false when it was already disabled (or is not listed), true when this call disabled it. */
    public async DisableAccount(page: IJourneyPage, environment: string, principalId: string): Promise<boolean>
    {
        const L = TenantConsoleApi
        const snapshot = await this.Snapshot(page, environment)
        if (snapshot.accounts.some(account => account.principalId === principalId && account.disabled))
        {
            return false
        }
        await page.RequestJson(L.Delete, this.Route(environment) + L.AccountsLeaf + L.Slash + encodeURIComponent(principalId))
        return true
    }

    private Route(environment: string): string
    {
        return TenantConsoleApi.EnvironmentsRoot + encodeURIComponent(environment)
    }

    private async Snapshot(page: IJourneyPage, environment: string): Promise<IAdminSnapshot>
    {
        const L = TenantConsoleApi
        const snapshot = await page.RequestJson(L.Get, this.Route(environment) + L.SnapshotLeaf) as Partial<IAdminSnapshot> | null
        return { accounts: snapshot?.accounts ?? [], grants: snapshot?.grants ?? [] }
    }
}
