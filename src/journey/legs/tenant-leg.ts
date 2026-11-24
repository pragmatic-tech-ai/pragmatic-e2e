import { TenantCreation, type CabinetTenantsPage } from '../drivers/cabinet-tenants-page.js'
import type { Evidence } from '../evidence.js'
import type { JourneyContext } from '../journey-context.js'
import { JourneyDependency } from '../journey-dependency.js'
import type { IJourneyLeg } from '../journey-leg.js'
import type { JourneyPath } from '../journey-path.js'
import { JourneyKeys, JourneyLegName, JourneyState } from './journey-keys.js'

/**
 * Leg 4: the tenant. On the cabinet's Tenants page the customer admin creates the path's tenant
 * (`journey-<run id>-<path initial>`: tenant ids are global, and each path is its own client); the console accepts it
 * only once the client's paid entitlement statement has arrived (D4: delivered by the ledger, applied by the platform
 * admin console), so the leg also proves that delivery end to end. The evidence is the reloaded list (list-tenants
 * afresh): the record is the console's, not the page's. The id is recorded before the first press, so the clean of a
 * killed run knows it. Clean leaves the tenant: the customer API has no tenant leave (D2's customer operations end with
 * leave-hive), so like the ledger rows it stays under its journey client, empty (the hive legs clean their own hives).
 */
export class TenantLeg implements IJourneyLeg
{
    public readonly Name = JourneyLegName.Tenant
    public readonly Dependencies = [JourneyDependency.Cabinet, JourneyDependency.CentralLogin, JourneyDependency.EntitlementDelivery]
    /**
     * Above its waits' sum: two opens (each the account page, 120 s, then the section, 180 s, whose last probe may
     * reopen the account page, 120 s more) and the presses (180 s): 1020 s.
     */
    public readonly DeadlineMs = 20 * 60_000
    /** The cabinet's tenant id rule (pragmatic-cabinet `TenantsPageViewModel.TenantIdPattern`). */
    public static readonly TenantIdPattern = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/
    private static readonly CreateDeadlineMs = 3 * 60_000
    private static readonly Prefix = 'journey-'
    private static readonly Separator = '-'
    private static readonly BadTenantId = 'the run id makes no tenant id the cabinet accepts (3 to 32 lowercase letters, digits or dashes, starting with a letter): '
    private static readonly DisplayPrefix = 'Journey '
    private static readonly Space = ' '
    private static readonly Created = 'created tenant '
    private static readonly Listed = ' and the reloaded list shows it'
    private static readonly Resumed = 'resumed: the tenant '
    private static readonly AlreadyListed = ' is already listed'
    private static readonly Settled = 'answered tenant-taken or limit-reached for '
    private static readonly SettledSuffix = ': an earlier press of this run landed (the reloaded list shows it)'
    private static readonly Foreign = 'the cabinet answered tenant-taken or limit-reached and the reloaded list does not show the tenant (another client holds the id, or the plan is full): '
    private static readonly NotListed = 'the cabinet confirmed the tenant but the reloaded list does not show it: '
    private static readonly Stays = 'tenant '
    private static readonly StaysSuffix = ' stays under its journey client: the customer API has no tenant leave'
    private static readonly Unconfirmed = ' was asked for but not confirmed; if the console holds it, it stays under its journey client: the customer API has no tenant leave'
    private static readonly NothingCreated = 'no tenant was created'

    public constructor(private readonly tenants: CabinetTenantsPage, private readonly evidence: Evidence)
    {
    }

    /** The path's tenant id: `journey-<run id>-<path initial>`, refused unless the cabinet accepts it. */
    public static TenantIdFor(runId: string, path: JourneyPath): string
    {
        const T = TenantLeg
        const id = T.Prefix + runId + T.Separator + path.charAt(0)
        if (!T.TenantIdPattern.test(id))
        {
            throw new Error(T.BadTenantId + id)
        }
        return id
    }

    public async Run(context: JourneyContext): Promise<void>
    {
        const T = TenantLeg
        const clientName = context.Require(JourneyKeys.ClientName)
        const tenantId = T.TenantIdFor(context.RunId, context.Path)
        let page = await this.tenants.Open(clientName)
        if (await this.tenants.IsListed(page, tenantId))
        {
            context.Set(JourneyKeys.Tenant, tenantId)
            context.Set(JourneyKeys.TenantState, JourneyState.TenantCreated)
            this.evidence.Step(this.Name, T.Resumed + tenantId + T.AlreadyListed)
            return
        }
        // Recorded before the first press, so a killed run's clean names the tenant it may have created.
        context.Set(JourneyKeys.Tenant, tenantId)
        const outcome = await this.tenants.Create(page, tenantId, T.DisplayPrefix + context.RunId + T.Space + context.Path, T.CreateDeadlineMs)
        page = await this.tenants.Open(clientName)
        if (!await this.tenants.IsListed(page, tenantId))
        {
            throw new Error((outcome === TenantCreation.Settle ? T.Foreign : T.NotListed) + tenantId)
        }
        context.Set(JourneyKeys.TenantState, JourneyState.TenantCreated)
        this.evidence.Step(this.Name, outcome === TenantCreation.Settle ? T.Settled + tenantId + T.SettledSuffix : T.Created + tenantId + T.Listed)
    }

    public async Clean(context: JourneyContext): Promise<void>
    {
        const T = TenantLeg
        const tenantId = context.Get(JourneyKeys.Tenant)
        if (tenantId === undefined)
        {
            this.evidence.Step(this.Name, T.NothingCreated)
            return
        }
        const created = context.Get(JourneyKeys.TenantState) === JourneyState.TenantCreated
        this.evidence.Step(this.Name, T.Stays + tenantId + (created ? T.StaysSuffix : T.Unconfirmed))
    }
}
