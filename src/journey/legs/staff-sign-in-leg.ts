import { EngineConsolePage } from '../drivers/engine-console-page.js'
import type { IJourneyBrowser } from '../drivers/journey-browser.js'
import { TenantConsolePage } from '../drivers/tenant-console-page.js'
import type { Evidence } from '../evidence.js'
import type { JourneyContext } from '../journey-context.js'
import { JourneyDependency } from '../journey-dependency.js'
import type { IJourneyLeg } from '../journey-leg.js'
import type { IConsoleTrust } from '../live/console-trust.js'
import { OwnerSignIn, type IEngineClusterSource } from '../live/engine-secrets.js'
import type { JourneyIdentity } from '../live/journey-identity.js'
import type { Waiter } from '../waiter.js'
import { DomainLeg } from './domain-leg.js'
import { JourneyKeys, JourneyLegName, JourneyState } from './journey-keys.js'

/**
 * Leg 7: staff sign-in. The tenant console's accounts and role grants are scoped to an environment and a fresh install has
 * none, so the Owner first creates the environment `journey` (as the live loop's owner does; Plexus later publishes to a
 * pre-existing one) and waits until it runs healthy; the environment's name is recorded before it is created. In the customer's own engine console (pragmatic-tenant-admin's tenant portal, Users & Access) the
 * Owner, signed in with the engine's initial sign-in (the console never asks for a password change), creates the staff
 * account `staff@<run id>.journey.pragmatic-lab.com`, a local account (the Create account dialog says it creates one: the
 * realm has local accounts by default, the console has no toggle), with a password derived from the journey's seed
 * (JourneyIdentity.StaffPassword: never stored, so a later leg derives it again) and grants it Admin (the tenant role that
 * holds every console capability, the environments' included; the Grant a role box offers no narrower one). The staff
 * user then signs in to the tenant's realm in a fresh browser context, which proves the realm authenticates the account.
 * The address is recorded before the account is created, so the clean of a killed run names it. Clean disables the staff
 * account (the console has no account deletion; "Disable account" is its removal of access). Clean leaves the environment
 * `journey` in place: deleting it needs a typed confirmation and the hive's own cleanup (the hive legs' Clean, which deletes
 * the cluster or leaves the hive) tears its namespaces down, so it is torn down with the hive.
 */
export class StaffSignInLeg implements IJourneyLeg
{
    public readonly Name = JourneyLegName.StaffSignIn
    public readonly Dependencies: readonly JourneyDependency[]
    /** Above its waits' sum: two sign-ins (2 min each), the environment (10 min), the page (2 min), the dialog (30 s), the create and grant (1 min each). */
    public readonly DeadlineMs = 30 * 60_000
    public static readonly Environment = 'journey'
    private static readonly Staff = 'staff@'
    private static readonly PrincipalPrefix = 'staff-'
    private static readonly MapPrefix = 'MAP '
    private static readonly MapSeparator = ','
    private static readonly Loopback = '127.0.0.1'
    private static readonly PortColon = ':'
    private static readonly HostTargetSpace = ' '
    private static readonly OwnerSignedIn = 'the Owner signed in to the engine console with the engine\'s initial sign-in'
    private static readonly EnvironmentCreated = 'created the environment (the Owner creates it; accounts and grants are scoped to one): '
    private static readonly EnvironmentResumed = 'resumed: the environment is already listed: '
    private static readonly EnvironmentRunning = 'the environment runs healthy: '
    private static readonly LocalAccounts = 'the console offers local (password) accounts in the tenant realm; created staff account '
    private static readonly WithDerived = ' with the password derived from the journey seed'
    private static readonly Resumed = 'resumed: the staff account is already listed: '
    private static readonly Granted = 'granted the staff account Admin (every console capability, environments included)'
    private static readonly AlreadyGranted = 'the staff account already holds Admin'
    private static readonly StaffSignedIn = 'the staff user signed in to the tenant realm in a fresh browser context: '
    private static readonly NothingCreated = 'no staff account was recorded'
    private static readonly AlreadyDisabled = 'the staff account is already disabled: '
    private static readonly NotListed = 'the staff account is not listed in the console (never created): '
    private static readonly Disabled = 'disabled the staff account (the console has no account deletion): '
    private static readonly WasDisabled = 'the staff account was already shown Disabled: '

    private readonly tenantConsole: TenantConsolePage

    public constructor(
        private readonly browser: IJourneyBrowser,
        private readonly clusters: IEngineClusterSource,
        private readonly trust: IConsoleTrust,
        private readonly identity: JourneyIdentity,
        private readonly waiter: Waiter,
        private readonly evidence: Evidence,
        hiveDependency: JourneyDependency)
    {
        this.Dependencies = [JourneyDependency.EntitlementDelivery, hiveDependency, JourneyDependency.TenantRealm]
        this.tenantConsole = new TenantConsolePage(waiter)
    }

    /** The run's staff account address. */
    public static EmailFor(runId: string): string
    {
        return StaffSignInLeg.Staff + DomainLeg.DomainFor(runId)
    }

    public async Run(context: JourneyContext): Promise<void>
    {
        const L = StaffSignInLeg
        const email = L.EmailFor(context.RunId)
        // Recorded before anything is created, so a killed run's clean names the account.
        context.Set(JourneyKeys.StaffEmail, email)
        const password = this.identity.StaffPassword(email)
        const pins = await this.Pins(context)
        const rules = this.ResolverRules(context)
        const owner = await this.browser.ConsolePage(pins, rules)
        const engine = this.Engine(context)
        await engine.SignIn(owner, () => this.clusters.For(context).Owner())
        this.evidence.Step(this.Name, L.OwnerSignedIn)
        // Recorded before it is created, so a killed run's clean names it.
        context.Set(JourneyKeys.Environment, L.Environment)
        const createdEnvironment = await this.tenantConsole.EnsureEnvironment(owner, L.Environment)
        context.Set(JourneyKeys.EnvironmentState, JourneyState.EnvironmentReady)
        this.evidence.Step(this.Name, (createdEnvironment ? L.EnvironmentCreated : L.EnvironmentResumed) + L.Environment)
        this.evidence.Step(this.Name, L.EnvironmentRunning + L.Environment)
        await this.tenantConsole.OpenUsers(owner, L.Environment)
        if (await this.tenantConsole.IsListed(owner, email))
        {
            this.evidence.Step(this.Name, L.Resumed + email)
        }
        else
        {
            await this.tenantConsole.CreateAccount(owner, email, L.PrincipalPrefix + context.RunId, password)
            this.evidence.Step(this.Name, L.LocalAccounts + email + L.WithDerived)
        }
        context.Set(JourneyKeys.StaffState, JourneyState.StaffCreated)
        await this.tenantConsole.OpenAccount(owner, email)
        if (await this.tenantConsole.HasGrant(owner, TenantConsolePage.AdminRole))
        {
            this.evidence.Step(this.Name, L.AlreadyGranted)
        }
        else
        {
            await this.tenantConsole.GrantRole(owner, TenantConsolePage.AdminRole)
            this.evidence.Step(this.Name, L.Granted)
        }
        const staff = await this.browser.FreshConsolePage(pins, rules)
        await engine.SignIn(staff, async () => new OwnerSignIn(email, password))
        context.Set(JourneyKeys.StaffState, JourneyState.StaffSignedIn)
        this.evidence.Step(this.Name, L.StaffSignedIn + email)
    }

    public async Clean(context: JourneyContext): Promise<void>
    {
        const L = StaffSignInLeg
        const email = context.Get(JourneyKeys.StaffEmail)
        if (email === undefined)
        {
            this.evidence.Step(this.Name, L.NothingCreated)
            return
        }
        if (context.Get(JourneyKeys.StaffState) === JourneyState.StaffDisabled)
        {
            this.evidence.Step(this.Name, L.AlreadyDisabled + email)
            return
        }
        // Run records the address before it creates anything; with no created state there is no account to disable, and
        // the console may be unreachable (a torn-down hive), so clean does not reach it.
        if (context.Get(JourneyKeys.StaffState) === undefined)
        {
            this.evidence.Step(this.Name, L.NotListed + email)
            return
        }
        const owner = await this.browser.ConsolePage(await this.Pins(context), this.ResolverRules(context))
        await this.Engine(context).SignIn(owner, () => this.clusters.For(context).Owner())
        await this.tenantConsole.OpenUsers(owner, context.Get(JourneyKeys.Environment) ?? L.Environment)
        if (!await this.tenantConsole.IsListed(owner, email))
        {
            this.evidence.Step(this.Name, L.NotListed + email)
            return
        }
        await this.tenantConsole.OpenAccount(owner, email)
        const disabled = await this.tenantConsole.DisableAccount(owner)
        context.Set(JourneyKeys.StaffState, JourneyState.StaffDisabled)
        this.evidence.Step(this.Name, (disabled ? L.Disabled : L.WasDisabled) + email)
    }

    private Engine(context: JourneyContext): EngineConsolePage
    {
        return new EngineConsolePage(context.Require(JourneyKeys.ConsoleUrl), context.Require(JourneyKeys.ConsoleHost), this.waiter)
    }

    /**
     * Chromium host-resolver rules mapping the console and sign-in hosts (any port) to the loopback the console URL
     * names: the hosted reach is a port-forward on 127.0.0.1, and Chromium's resolver ignores /etc/hosts; mapping every
     * port also catches a realm redirect to :443.
     */
    private ResolverRules(context: JourneyContext): string
    {
        const L = StaffSignInLeg
        const target = L.Loopback + L.PortColon + new URL(context.Require(JourneyKeys.ConsoleUrl)).port
        return [context.Require(JourneyKeys.ConsoleHost), context.Require(JourneyKeys.IdpHost)]
            .map(host => L.MapPrefix + host + L.HostTargetSpace + target)
            .join(L.MapSeparator)
    }

    /** The certificate keys the console's browser (the console URL's port: the customer ingress's, or the hosted port-forward's) accepts: exactly the console's and the sign-in service's, chained to the engine's CA. */
    private async Pins(context: JourneyContext): Promise<string[]>
    {
        return this.trust.Pins([context.Require(JourneyKeys.ConsoleHost), context.Require(JourneyKeys.IdpHost)], Number(new URL(context.Require(JourneyKeys.ConsoleUrl)).port), await this.clusters.For(context).DevCa())
    }
}
