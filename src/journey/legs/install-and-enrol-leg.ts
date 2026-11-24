import { CabinetHivesPage } from '../drivers/cabinet-hives-page.js'
import { EngineConsolePage } from '../drivers/engine-console-page.js'
import type { IJourneyBrowser } from '../drivers/journey-browser.js'
import type { IJourneyPage } from '../drivers/journey-page.js'
import type { Evidence } from '../evidence.js'
import type { JourneyContext } from '../journey-context.js'
import { JourneyDependency } from '../journey-dependency.js'
import type { IJourneyLeg } from '../journey-leg.js'
import { JourneyPath } from '../journey-path.js'
import type { IConsoleTrust } from '../live/console-trust.js'
import { CustomerCluster } from '../live/customer-cluster.js'
import { EngineInstallCommand } from '../live/engine-install-command.js'
import { WaitObservation, type Waiter } from '../waiter.js'
import { JourneyKeys, JourneyLegName, JourneyState } from './journey-keys.js'

/**
 * Leg 5a: the customer-cluster path (Enrolled or Delegated). In the cabinet the customer admin starts an enrolment at
 * the path's level and gets the install command and a one-time code; the journey installs exactly that chart version
 * for that tenant into `kind-pragmatic-customer` (the proof cluster's console host, port and self-signed certificate,
 * by argument vector), verifies that the console's certificates chain to the engine's development CA (read from the
 * cluster) and opens the console trusting exactly those, signs the engine's Owner in with the initial sign-in it reads
 * from the cluster straight into the form, and connects the hive with the code. The cabinet then lists the hive
 * `Healthy` in its row. Then the customer requests environment `journey` in the cabinet: on an Enrolled hive the change
 * waits in the engine console's Approvals until the Owner approves it in its row; on a Delegated hive it applies
 * without asking (nothing waits). Either way the hive reports `journey` ready, and the console lists the change once,
 * applied, with no Approve. The cluster is reset first (it holds one engine).
 * Clean: Leave in the cabinet for every hive of the run's client that has not left, then (always) the cluster reset.
 * No tenant leave exists, so the tenant stays (owner ruling: no self-service leaving of a tenant).
 */
export class InstallAndEnrolLeg implements IJourneyLeg
{
    public readonly Name = JourneyLegName.InstallAndEnrol
    public readonly Dependencies = [JourneyDependency.Cabinet, JourneyDependency.CentralLogin, JourneyDependency.EntitlementDelivery, JourneyDependency.CustomerCluster, JourneyDependency.DelegatedIntents]
    public static readonly Environment = 'journey'
    public static readonly CreateSentence = 'Create environment `journey`'
    public static readonly HealthyBudgetMs = 3 * 60_000
    public static readonly ReadyBudgetMs = 3 * 60_000
    public static readonly AppliedBudgetMs = 3 * 60_000
    public static readonly LeftBudgetMs = 2 * 60_000
    /** The certificate check: the CA read and two TLS handshakes. */
    public static readonly TrustBudgetMs = 60_000
    /**
     * The leg's deadline, the sum of its steps' budgets (reset, open, start, install, trust, sign-in, connect, health,
     * open, request, approval, applying, ready, applied: 33 min), plus 2 min of slack: 35 min per customer-cluster path.
     */
    public static readonly StepBudgetsMs: readonly number[] = [
        CustomerCluster.ResetBudgetMs, CabinetHivesPage.OpenBudgetMs, CabinetHivesPage.StartBudgetMs, CustomerCluster.InstallBudgetMs,
        InstallAndEnrolLeg.TrustBudgetMs, EngineConsolePage.SignInBudgetMs, EngineConsolePage.ConnectBudgetMs, InstallAndEnrolLeg.HealthyBudgetMs,
        CabinetHivesPage.OpenBudgetMs, CabinetHivesPage.RequestBudgetMs, EngineConsolePage.PendingBudgetMs, EngineConsolePage.ApplyingBudgetMs,
        InstallAndEnrolLeg.ReadyBudgetMs, InstallAndEnrolLeg.AppliedBudgetMs,
    ]
    public static readonly SlackMs = 2 * 60_000
    public readonly DeadlineMs = InstallAndEnrolLeg.StepBudgetsMs.reduce((sum, ms) => sum + ms, 0) + InstallAndEnrolLeg.SlackMs
    private static readonly SlowIntervalMs = 20_000
    private static readonly NoValue = ''
    private static readonly Healthy = 'the cabinet to list the hive Healthy: '
    private static readonly Ready = 'the hive to report environment `journey` ready'
    private static readonly Gone = 'the cabinet to list the hive Left: '
    private static readonly NotYet = 'not yet'
    private static readonly ResetDone = 'reset the proof cluster (removed: '
    private static readonly Close = ')'
    private static readonly ListSeparator = ', '
    private static readonly LevelOpen = ' ('
    private static readonly None = 'nothing'
    private static readonly StartedEnrolment = 'started an enrolment in the cabinet at level '
    private static readonly InstalledPrefix = 'installed the cabinet\'s chart '
    private static readonly InstalledVersion = ' --version '
    private static readonly InstalledSuffix = ' for the tenant on the proof cluster'
    private static readonly Trusted = 'the console\'s certificates chain to the engine\'s development CA; the browser trusts exactly those keys'
    private static readonly ConnectedPrefix = 'connected the hive in the engine console: '
    private static readonly HealthyShown = 'the cabinet lists the hive Healthy: '
    private static readonly Requested = 'requested in the cabinet: '
    private static readonly Approved = 'the change waited in the engine console\'s Approvals and was approved: '
    private static readonly NoApproval = 'the Delegated hive applied it without approval; nothing waited in the engine console'
    private static readonly ReadyShown = 'the hive reports environment `journey` ready'
    private static readonly AppliedShown = 'the engine console lists the change once, applied, with no Approve'
    private static readonly AskedApproval = 'a Delegated hive asked for an approval: '
    private static readonly TwoIntents = 'the engine console lists the change more than once (a second intent): '
    private static readonly LeftShown = 'left the hive in the cabinet: '
    private static readonly NoHive = 'no hive of the run is left to leave'
    private static readonly ResetAfter = 'reset the proof cluster after the run (removed: '

    public constructor(
        private readonly browser: IJourneyBrowser,
        private readonly hives: CabinetHivesPage,
        private readonly cluster: CustomerCluster,
        private readonly trust: IConsoleTrust,
        private readonly waiter: Waiter,
        private readonly evidence: Evidence)
    {
    }

    public async Run(context: JourneyContext): Promise<void>
    {
        const L = InstallAndEnrolLeg
        const delegated = context.Path === JourneyPath.Delegated
        const clientName = context.Require(JourneyKeys.ClientName)
        const tenant = context.Require(JourneyKeys.Tenant)
        const owner = (): ReturnType<CustomerCluster['Owner']> => this.cluster.Owner()
        let hive = context.Get(JourneyKeys.Hive)
        if (hive === undefined)
        {
            // A run that stopped before the connect starts over: the code it had is used or expired.
            this.evidence.Step(this.Name, L.ResetDone + L.Names(await this.cluster.Reset()) + L.Close)
            const page = await this.hives.Open(clientName)
            const started = await this.hives.StartEnrolment(page, delegated)
            this.evidence.Step(this.Name, L.StartedEnrolment + context.Path)
            const command = EngineInstallCommand.Parse(started.CommandFirstLine, started.CommandTenantLine, tenant)
            context.Set(JourneyKeys.ConsoleUrl, command.ConsoleUrl)
            context.Set(JourneyKeys.ConsoleHost, command.ConsoleHost)
            context.Set(JourneyKeys.IdpHost, command.IdpHost)
            context.Set(JourneyKeys.HiveState, JourneyState.EngineInstalling)
            await this.cluster.Install(command.Argv(this.cluster.Context))
            context.Set(JourneyKeys.HiveState, JourneyState.EngineInstalled)
            this.evidence.Step(this.Name, L.InstalledPrefix + EngineInstallCommand.Chart + L.InstalledVersion + command.Version + L.InstalledSuffix)
            const consolePage = await this.ConsolePage(context)
            await this.Console(context).SignIn(consolePage, owner)
            hive = await this.Console(context).Connect(consolePage, started.Code, delegated)
            context.Set(JourneyKeys.Hive, hive)
            context.Set(JourneyKeys.HiveState, JourneyState.HiveEnrolled)
            this.evidence.Step(this.Name, L.ConnectedPrefix + hive + L.LevelOpen + context.Path + L.Close)
        }
        const enrolled = hive
        await this.waiter.Until(L.Healthy + enrolled, async () =>
        {
            const page = await this.hives.Open(clientName)
            return await this.hives.IsHealthy(page, enrolled) ? WaitObservation.Met(true, enrolled) : WaitObservation.NotYet<boolean>(L.NotYet)
        }, L.HealthyBudgetMs, L.SlowIntervalMs)
        this.evidence.Step(this.Name, L.HealthyShown + enrolled)
        if (context.Get(JourneyKeys.Environment) === undefined)
        {
            // A resumed run may ask again: the platform answers an open create-environment for the same environment with the
            // intent it already holds, and the console's single row below proves it.
            const page = await this.hives.Open(clientName)
            const answer = await this.hives.RequestEnvironment(page, enrolled, L.Environment)
            context.Set(JourneyKeys.Environment, L.Environment)
            this.evidence.Step(this.Name, L.Requested + answer)
        }
        const engine = this.Console(context)
        const consolePage = await this.ConsolePage(context)
        if (!delegated && context.Get(JourneyKeys.EnvironmentState) !== JourneyState.EnvironmentApproved)
        {
            await engine.ApprovePending(consolePage, L.CreateSentence, owner)
            context.Set(JourneyKeys.EnvironmentState, JourneyState.EnvironmentApproved)
            this.evidence.Step(this.Name, L.Approved + L.CreateSentence)
        }
        await this.waiter.Until(L.Ready, async () =>
        {
            const page = await this.hives.Open(clientName)
            return await this.hives.IsEnvironmentReady(page, enrolled, L.Environment) ? WaitObservation.Met(true, L.Environment) : WaitObservation.NotYet<boolean>(L.NotYet)
        }, L.ReadyBudgetMs, L.SlowIntervalMs)
        context.Set(JourneyKeys.EnvironmentState, JourneyState.EnvironmentReady)
        this.evidence.Step(this.Name, L.ReadyShown)
        const rows = await engine.ExpectApplied(consolePage, L.CreateSentence, owner, L.AppliedBudgetMs)
        if (rows !== 1)
        {
            throw new Error(L.TwoIntents + rows)
        }
        this.evidence.Step(this.Name, L.AppliedShown)
        if (delegated)
        {
            const badge = await engine.PendingBadge(consolePage)
            if (badge !== L.NoValue)
            {
                throw new Error(L.AskedApproval + badge)
            }
            this.evidence.Step(this.Name, L.NoApproval)
        }
    }

    public async Clean(context: JourneyContext): Promise<void>
    {
        const L = InstallAndEnrolLeg
        try
        {
            await this.LeaveAll(context)
        }
        finally
        {
            if (context.Get(JourneyKeys.HiveState) !== undefined)
            {
                this.evidence.Step(this.Name, L.ResetAfter + L.Names(await this.cluster.Reset()) + L.Close)
            }
        }
    }

    /** Every hive the run's client lists that has not left (a run can hold one it never recorded: a lost answer). */
    private async LeaveAll(context: JourneyContext): Promise<void>
    {
        const L = InstallAndEnrolLeg
        const clientName = context.Get(JourneyKeys.ClientName)
        if (clientName === undefined || context.Get(JourneyKeys.HiveState) === undefined)
        {
            this.evidence.Step(this.Name, L.NoHive)
            return
        }
        let page = await this.hives.Open(clientName)
        const open: string[] = []
        for (const hive of await this.hives.HiveIds(page))
        {
            if (!await this.hives.IsLeft(page, hive))
            {
                open.push(hive)
            }
        }
        if (open.length === 0)
        {
            this.evidence.Step(this.Name, L.NoHive)
        }
        for (const hive of open)
        {
            await this.hives.Leave(page, hive)
            await this.waiter.Until(L.Gone + hive, async () =>
            {
                page = await this.hives.Open(clientName)
                return await this.hives.IsLeft(page, hive) ? WaitObservation.Met(true, hive) : WaitObservation.NotYet<boolean>(L.NotYet)
            }, L.LeftBudgetMs, L.SlowIntervalMs)
            this.evidence.Step(this.Name, L.LeftShown + hive)
        }
        context.Set(JourneyKeys.HiveState, JourneyState.HiveLeft)
    }

    /** The console's browser, trusting exactly the certificates that chain to the engine's development CA. */
    private async ConsolePage(context: JourneyContext): Promise<IJourneyPage>
    {
        const L = InstallAndEnrolLeg
        const pins = await this.trust.Pins([context.Require(JourneyKeys.ConsoleHost), context.Require(JourneyKeys.IdpHost)], Number(EngineInstallCommand.ConsolePort), await this.cluster.DevCa())
        if (context.Get(JourneyKeys.ConsoleTrusted) === undefined)
        {
            context.Set(JourneyKeys.ConsoleTrusted, JourneyState.ConsoleTrusted)
            this.evidence.Step(this.Name, L.Trusted)
        }
        return this.browser.ConsolePage(pins)
    }

    private Console(context: JourneyContext): EngineConsolePage
    {
        return new EngineConsolePage(context.Require(JourneyKeys.ConsoleUrl), context.Require(JourneyKeys.ConsoleHost), this.waiter)
    }

    private static Names(names: readonly string[]): string
    {
        return names.length === 0 ? InstallAndEnrolLeg.None : names.join(InstallAndEnrolLeg.ListSeparator)
    }
}
