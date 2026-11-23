/**
 * A live piece of the platform a leg needs. A leg runs only when every one of its dependencies is named live in the
 * journey's configuration (`journey.config.json` `liveDependencies`); otherwise the report shows it pending on the
 * first missing one, with the plan item that delivers it. Nothing is faked: a pending leg has not run.
 */
export enum JourneyDependency
{
    Website = 'website',
    CentralLogin = 'central-login',
    Cabinet = 'cabinet',
    PaddleSandbox = 'paddle-sandbox',
    JourneyMail = 'journey-mail',
    EntitlementDelivery = 'entitlement-delivery',
    JourneyDns = 'journey-dns',
    CustomerCluster = 'customer-cluster',
    DelegatedIntents = 'delegated-intents',
    HostedPlacement = 'hosted-placement',
    TenantRealm = 'tenant-realm',
    PlexusRealmSignIn = 'plexus-realm-sign-in',
}

/** What delivers each dependency (shown on a pending leg) and the parse of the configured live list. */
export class JourneyDependencies
{
    private static readonly UnknownDependency = 'unknown journey dependency: '
    private static readonly Deliverers: ReadonlyMap<JourneyDependency, string> = new Map([
        [JourneyDependency.Website, 'the public website (pragmatic-tech.ai)'],
        [JourneyDependency.CentralLogin, 'B.3: the central login (login.pragmatic-tech.ai/realms/central)'],
        [JourneyDependency.Cabinet, 'D5: the personal cabinet (cabinet.pragmatic-tech.ai)'],
        [JourneyDependency.PaddleSandbox, 'B.3 Task 7: the Paddle sandbox checkout and webhook to the ledger'],
        [JourneyDependency.JourneyMail, 'F Task 7 Step 3: the journey mail worker on pragmatic-lab.com'],
        [JourneyDependency.EntitlementDelivery, 'D4 Task 8: entitlement statements delivered to the platform admin console'],
        [JourneyDependency.JourneyDns, 'F Task 7 Step 2: the journey DNS token for journey.pragmatic-lab.com'],
        [JourneyDependency.CustomerCluster, 'G5 (C3.3): the customer-cluster chart and enrolment on pragmatic-customer'],
        [JourneyDependency.DelegatedIntents, 'C3.4: environment intents (Enrolled approval, Delegated apply)'],
        [JourneyDependency.HostedPlacement, 'G7 (C5.2): Hosted placement through the host agent'],
        [JourneyDependency.TenantRealm, 'C3.1: realm configuration in the tenant admin console'],
        [JourneyDependency.PlexusRealmSignIn, 'E.i: Plexus realm-native sign-in and deploy'],
    ])

    public static Deliverer(dependency: JourneyDependency): string
    {
        return JourneyDependencies.Deliverers.get(dependency) ?? dependency
    }

    public static Parse(names: readonly string[]): ReadonlySet<JourneyDependency>
    {
        const all = Object.values(JourneyDependency) as string[]
        const live = new Set<JourneyDependency>()
        for (const name of names)
        {
            if (!all.includes(name))
            {
                throw new Error(JourneyDependencies.UnknownDependency + name)
            }
            live.add(name as JourneyDependency)
        }
        return live
    }
}
