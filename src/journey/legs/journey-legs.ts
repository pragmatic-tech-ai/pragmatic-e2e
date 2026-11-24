import { CabinetPage } from '../drivers/cabinet-page.js'
import { CabinetTenantsPage } from '../drivers/cabinet-tenants-page.js'
import { CentralLoginPage } from '../drivers/central-login-page.js'
import { CustomerSession } from '../drivers/customer-session.js'
import type { IJourneyBrowser } from '../drivers/journey-browser.js'
import { PaddleCheckout } from '../drivers/paddle-checkout.js'
import { WebsitePage } from '../drivers/website-page.js'
import type { Evidence } from '../evidence.js'
import type { JourneyConfig } from '../journey-config.js'
import { JourneyDependency } from '../journey-dependency.js'
import type { IJourneyLeg } from '../journey-leg.js'
import { JourneyPath } from '../journey-path.js'
import { CentralAccount } from '../live/central-account.js'
import type { JourneyIdentity } from '../live/journey-identity.js'
import type { Waiter } from '../waiter.js'
import { JourneyLegName } from './journey-keys.js'
import { PayLeg } from './pay-leg.js'
import { PendingLeg } from './pending-leg.js'
import { RegisterLeg, type IUncleanedRuns } from './register-leg.js'
import { TenantLeg } from './tenant-leg.js'
import { VisitLeg } from './visit-leg.js'

/** What a path's legs are built from. */
export class JourneyLegInputs
{
    public constructor(
        public readonly Config: JourneyConfig,
        public readonly Browser: IJourneyBrowser,
        public readonly Identity: JourneyIdentity,
        public readonly CampaignCode: string | undefined,
        public readonly Uncleaned: IUncleanedRuns,
        public readonly Waiter: Waiter,
        public readonly Evidence: Evidence)
    {
    }
}

/**
 * A path's legs in run order (the plan's Design table): legs 1–4 drive the live public edge; the rest hold their
 * place as pending legs with the dependencies that will make them runnable. Legs 5a (customer cluster) and 5b
 * (Hosted) are the path's own.
 */
export class JourneyLegs
{
    public static For(path: JourneyPath, inputs: JourneyLegInputs): IJourneyLeg[]
    {
        const D = JourneyDependency
        const N = JourneyLegName
        const config = inputs.Config
        const loginHost = new URL(config.CentralIssuer).host
        const cabinet = new CabinetPage(config.CabinetUrl, inputs.Waiter)
        const login = new CentralLoginPage(loginHost, inputs.Waiter)
        const session = new CustomerSession(inputs.Browser, cabinet, login, inputs.Identity, loginHost, inputs.Waiter)
        const hive = path === JourneyPath.Hosted
            ? new PendingLeg(N.PlaceHosted, [D.EntitlementDelivery, D.HostedPlacement])
            : new PendingLeg(N.InstallAndEnrol, [D.EntitlementDelivery, D.CustomerCluster, D.DelegatedIntents])
        const hiveDependency = path === JourneyPath.Hosted ? D.HostedPlacement : D.CustomerCluster
        return [
            new VisitLeg(inputs.Browser, new WebsitePage(config.WebsiteUrl, config.CabinetUrl), inputs.Evidence),
            new RegisterLeg(session, cabinet, login, new CentralAccount(config.CentralIssuer), inputs.Identity, inputs.CampaignCode, inputs.Uncleaned, inputs.Waiter, inputs.Evidence),
            new PayLeg(session, cabinet, new PaddleCheckout(inputs.Waiter), inputs.Identity, config.PlanName, inputs.Waiter, inputs.Evidence),
            new TenantLeg(new CabinetTenantsPage(session, cabinet, inputs.Waiter), inputs.Evidence),
            hive,
            new PendingLeg(N.Domain, [D.EntitlementDelivery, D.JourneyDns]),
            new PendingLeg(N.StaffSignIn, [D.EntitlementDelivery, hiveDependency, D.TenantRealm]),
            new PendingLeg(N.Plexus, [D.EntitlementDelivery, hiveDependency, D.PlexusRealmSignIn]),
            new PendingLeg(N.DeployGraphs, [D.EntitlementDelivery, hiveDependency, D.PlexusRealmSignIn]),
        ]
    }
}
