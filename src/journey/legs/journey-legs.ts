import { CabinetDomainsPage } from '../drivers/cabinet-domains-page.js'
import { CabinetHivesPage } from '../drivers/cabinet-hives-page.js'
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
import { ConsoleTrust, type IConsoleTrust } from '../live/console-trust.js'
import { CustomerCluster } from '../live/customer-cluster.js'
import { FixedEngineClusterSource } from '../live/engine-secrets.js'
import { HostedClusters, HostedEngineClusterSource } from '../live/hosted-cluster.js'
import type { JourneyIdentity } from '../live/journey-identity.js'
import { NodeProcessRunner, type IProcessRunner, type IProcessStarter } from '../live/process-runner.js'
import { LegAbort, type Waiter } from '../waiter.js'
import { LazyJourneyDns } from '../live/journey-dns.js'
import { DomainLeg } from './domain-leg.js'
import { JourneyLegName } from './journey-keys.js'
import { InstallAndEnrolLeg } from './install-and-enrol-leg.js'
import { PlaceHostedLeg } from './place-hosted-leg.js'
import { PayLeg } from './pay-leg.js'
import { PendingLeg } from './pending-leg.js'
import { StaffSignInLeg } from './staff-sign-in-leg.js'
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
        public readonly Evidence: Evidence,
        public readonly Abort: LegAbort = new LegAbort(),
        public readonly Runner: IProcessRunner = new NodeProcessRunner(),
        public readonly Trust: IConsoleTrust = new ConsoleTrust(),
        public readonly Starter: IProcessStarter = new NodeProcessRunner())
    {
    }
}

/**
 * A path's legs in run order (the plan's Design table): legs 1–4 drive the live public edge; the rest hold their
 * place as pending legs with the dependencies that will make them runnable. Legs 5a (customer cluster: install,
 * enrol, an environment intent; C3.4) and 5b (Hosted) are the path's own.
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
        const hostedClusters = new HostedClusters(inputs.Runner, inputs.Starter, undefined, inputs.Abort)
        const hive = path === JourneyPath.Hosted
            ? new PlaceHostedLeg(session, inputs.Runner, inputs.Waiter, inputs.Evidence, hostedClusters, inputs.Trust)
            : new InstallAndEnrolLeg(inputs.Browser, new CabinetHivesPage(session, cabinet, inputs.Browser, inputs.Waiter), new CustomerCluster(inputs.Runner, config.CustomerCluster, inputs.Abort), inputs.Trust, inputs.Waiter, inputs.Evidence)
        const engine = path === JourneyPath.Hosted
            ? new HostedEngineClusterSource(hostedClusters)
            : new FixedEngineClusterSource(new CustomerCluster(inputs.Runner, config.CustomerCluster, inputs.Abort))
        const hiveDependency = path === JourneyPath.Hosted ? D.HostedPlacement : D.CustomerCluster
        // The domain leg verifies a custom email domain; the Hosted (b) proof does not need it (the staff local
        // account needs no verified domain), so it is left off the Hosted path until its cabinet selectors are proven.
        const domain: IJourneyLeg[] = path === JourneyPath.Hosted
            ? []
            : [new DomainLeg(new CabinetDomainsPage(session, cabinet, inputs.Waiter), new LazyJourneyDns(config), inputs.Evidence)]
        return [
            new VisitLeg(inputs.Browser, new WebsitePage(config.WebsiteUrl, config.CabinetUrl), inputs.Evidence),
            new RegisterLeg(session, cabinet, login, new CentralAccount(config.CentralIssuer), inputs.Identity, inputs.CampaignCode, inputs.Uncleaned, inputs.Waiter, inputs.Evidence),
            new PayLeg(session, cabinet, new PaddleCheckout(inputs.Waiter), inputs.Identity, config.PlanName, inputs.Waiter, inputs.Evidence),
            new TenantLeg(new CabinetTenantsPage(session, cabinet, inputs.Waiter), inputs.Evidence),
            hive,
            ...domain,
            new StaffSignInLeg(inputs.Browser, engine, inputs.Trust, inputs.Identity, inputs.Waiter, inputs.Evidence, hiveDependency),
            new PendingLeg(N.Plexus, [D.EntitlementDelivery, hiveDependency, D.PlexusRealmSignIn]),
            new PendingLeg(N.DeployGraphs, [D.EntitlementDelivery, hiveDependency, D.PlexusRealmSignIn]),
        ]
    }
}
