import { CabinetHivesPage } from '../drivers/cabinet-hives-page.js'
import { EngineConsolePage } from '../drivers/engine-console-page.js'
import type { IJourneyBrowser } from '../drivers/journey-browser.js'
import type { Evidence } from '../evidence.js'
import type { JourneyContext } from '../journey-context.js'
import { JourneyDependency } from '../journey-dependency.js'
import type { IJourneyLeg } from '../journey-leg.js'
import { JourneyPath } from '../journey-path.js'
import type { CustomerCluster } from '../live/customer-cluster.js'
import { EngineInstallCommand } from '../live/engine-install-command.js'
import { WaitObservation, type Waiter } from '../waiter.js'
import { JourneyKeys, JourneyLegName, JourneyState } from './journey-keys.js'

/**
 * Leg 5a: the customer-cluster path (Enrolled or Delegated). In the cabinet the customer admin starts an enrolment at
 * the path's level and gets the install command and a one-time code; the journey installs exactly that chart version
 * for that tenant into `kind-pragmatic-customer` (the proof cluster's console host, port and self-signed certificate,
 * by argument vector), signs the engine's Owner in to the engine console with the initial sign-in it reads from the
 * cluster straight into the form, and connects the hive with the code. The cabinet then lists the hive `Healthy`.
 * Then the customer requests environment `journey` in the cabinet: on an Enrolled hive the change waits in the engine
 * console's Approvals until the Owner approves it; on a Delegated hive it applies without asking (the console shows
 * nothing waiting). Either way the hive reports `journey` ready. The cluster is reset first (it holds one engine).
 * Clean: Leave in the cabinet (the hive is marked gone), then the cluster reset (chart uninstalled, its namespaces
 * deleted). No tenant leave exists, so the tenant stays (owner ruling: no self-service leaving of a tenant).
 */
export class InstallAndEnrolLeg implements IJourneyLeg
{
    public readonly Name = JourneyLegName.InstallAndEnrol
    public readonly Dependencies = [JourneyDependency.Cabinet, JourneyDependency.CentralLogin, JourneyDependency.EntitlementDelivery, JourneyDependency.CustomerCluster, JourneyDependency.DelegatedIntents]
    /** The reset (5 min), the install (15 min), sign-in and connect (10 min), health (10 min), the request and approval (10 min), the environment (20 min). */
    public readonly DeadlineMs = 75 * 60_000
    public static readonly Environment = 'journey'
    public static readonly CreateSentence = 'Create environment `journey`'
    private static readonly HealthyDeadlineMs = 10 * 60_000
    private static readonly ReadyDeadlineMs = 20 * 60_000
    private static readonly SlowIntervalMs = 30_000
    private static readonly NoValue = ''
    private static readonly Healthy = 'the cabinet to list the hive Healthy: '
    private static readonly Ready = 'the hive to report environment `journey` ready'
    private static readonly Gone = 'the cabinet to list the hive Left: '
    private static readonly NotYet = 'not yet'
    private static readonly ResetDone = 'reset the proof cluster (removed: '
    private static readonly ResetEnd = ')'
    private static readonly ListSeparator = ', '
    private static readonly LevelOpen = ' ('
    private static readonly None = 'nothing'
    private static readonly StartedEnrolment = 'started an enrolment in the cabinet at level '
    private static readonly InstalledPrefix = 'installed the cabinet\'s chart '
    private static readonly InstalledVersion = ' --version '
    private static readonly InstalledSuffix = ' for the tenant on the proof cluster'
    private static readonly ConnectedPrefix = 'connected the hive in the engine console: '
    private static readonly HealthyShown = 'the cabinet lists the hive Healthy: '
    private static readonly Requested = 'requested in the cabinet: '
    private static readonly Approved = 'the change waited in the engine console\'s Approvals and was approved: '
    private static readonly NoApproval = 'the Delegated hive applied it without approval; the engine console shows nothing waiting'
    private static readonly ReadyShown = 'the hive reports environment `journey` ready'
    private static readonly AskedApproval = 'a Delegated hive asked for an approval: '
    private static readonly LeftShown = 'left the hive in the cabinet: '
    private static readonly NoHive = 'no hive was enrolled'
    private static readonly ResetAfter = 'reset the proof cluster after the run (removed: '

    public constructor(
        private readonly browser: IJourneyBrowser,
        private readonly hives: CabinetHivesPage,
        private readonly cluster: CustomerCluster,
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
        let hive = context.Get(JourneyKeys.Hive)
        let engine: EngineConsolePage
        if (hive === undefined)
        {
            // A run that stopped before the connect starts over: the code it had is used or expired.
            this.evidence.Step(this.Name, L.ResetDone + L.Names(await this.cluster.Reset()) + L.ResetEnd)
            const page = await this.hives.Open(clientName)
            const started = await this.hives.StartEnrolment(page, delegated)
            this.evidence.Step(this.Name, L.StartedEnrolment + context.Path)
            const command = EngineInstallCommand.Parse(started.CommandFirstLine, started.CommandTenantLine, tenant)
            context.Set(JourneyKeys.ConsoleUrl, command.ConsoleUrl)
            context.Set(JourneyKeys.ConsoleHost, command.ConsoleHost)
            context.Set(JourneyKeys.HiveState, JourneyState.EngineInstalling)
            await this.cluster.Install(command.Argv(this.cluster.Context))
            context.Set(JourneyKeys.HiveState, JourneyState.EngineInstalled)
            this.evidence.Step(this.Name, L.InstalledPrefix + EngineInstallCommand.Chart + L.InstalledVersion + command.Version + L.InstalledSuffix)
            engine = this.Console(context)
            const consolePage = await this.browser.ConsolePage()
            await engine.SignIn(consolePage, () => this.cluster.Owner())
            hive = await engine.Connect(consolePage, started.Code, delegated)
            context.Set(JourneyKeys.Hive, hive)
            context.Set(JourneyKeys.HiveState, JourneyState.HiveEnrolled)
            this.evidence.Step(this.Name, L.ConnectedPrefix + hive + L.LevelOpen + context.Path + L.ResetEnd)
        }
        else
        {
            engine = this.Console(context)
        }
        const enrolled = hive
        await this.waiter.Until(L.Healthy + enrolled, async () =>
        {
            const page = await this.hives.Open(clientName)
            return await this.hives.IsHealthy(page, enrolled) ? WaitObservation.Met(true, enrolled) : WaitObservation.NotYet<boolean>(L.NotYet)
        }, L.HealthyDeadlineMs, L.SlowIntervalMs)
        this.evidence.Step(this.Name, L.HealthyShown + enrolled)
        if (context.Get(JourneyKeys.Environment) === undefined)
        {
            const page = await this.hives.Open(clientName)
            const answer = await this.hives.RequestEnvironment(page, enrolled, L.Environment)
            context.Set(JourneyKeys.Environment, L.Environment)
            this.evidence.Step(this.Name, L.Requested + answer)
        }
        const consolePage = await this.browser.ConsolePage()
        if (delegated)
        {
            await engine.SignIn(consolePage, () => this.cluster.Owner())
        }
        else if (context.Get(JourneyKeys.EnvironmentState) !== JourneyState.EnvironmentApproved)
        {
            await engine.ApprovePending(consolePage, L.CreateSentence, () => this.cluster.Owner())
            context.Set(JourneyKeys.EnvironmentState, JourneyState.EnvironmentApproved)
            this.evidence.Step(this.Name, L.Approved + L.CreateSentence)
        }
        await this.waiter.Until(L.Ready, async () =>
        {
            const page = await this.hives.Open(clientName)
            return await this.hives.IsEnvironmentReady(page, L.Environment) ? WaitObservation.Met(true, L.Environment) : WaitObservation.NotYet<boolean>(L.NotYet)
        }, L.ReadyDeadlineMs, L.SlowIntervalMs)
        context.Set(JourneyKeys.EnvironmentState, JourneyState.EnvironmentReady)
        this.evidence.Step(this.Name, L.ReadyShown)
        if (delegated)
        {
            await engine.SignIn(consolePage, () => this.cluster.Owner())
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
        const hive = context.Get(JourneyKeys.Hive)
        if (hive !== undefined && context.Get(JourneyKeys.HiveState) !== JourneyState.HiveLeft)
        {
            const clientName = context.Require(JourneyKeys.ClientName)
            let page = await this.hives.Open(clientName)
            await this.hives.Leave(page, hive)
            await this.waiter.Until(L.Gone + hive, async () =>
            {
                page = await this.hives.Open(clientName)
                return await page.HasText(hive) && await page.HasText(CabinetHivesPage.LeftText) ? WaitObservation.Met(true, hive) : WaitObservation.NotYet<boolean>(L.NotYet)
            }, L.HealthyDeadlineMs, L.SlowIntervalMs)
            context.Set(JourneyKeys.HiveState, JourneyState.HiveLeft)
            this.evidence.Step(this.Name, L.LeftShown + hive)
        }
        else if (hive === undefined)
        {
            this.evidence.Step(this.Name, L.NoHive)
        }
        if (context.Get(JourneyKeys.HiveState) !== undefined)
        {
            this.evidence.Step(this.Name, L.ResetAfter + L.Names(await this.cluster.Reset()) + L.ResetEnd)
        }
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
