import type { CustomerSession } from '../drivers/customer-session.js'
import type { IJourneyPage } from '../drivers/journey-page.js'
import type { Evidence } from '../evidence.js'
import type { JourneyContext } from '../journey-context.js'
import { JourneyDependency } from '../journey-dependency.js'
import type { IJourneyLeg } from '../journey-leg.js'
import type { IConsoleTrust } from '../live/console-trust.js'
import { HostedCluster, type ConsoleReach, type HostedClusters } from '../live/hosted-cluster.js'
import type { IProcessRunner } from '../live/process-runner.js'
import { WaitObservation, type Waiter } from '../waiter.js'
import { JourneyKeys, JourneyLegName, JourneyState } from './journey-keys.js'

/** One hive as the customer API lists it (the fields this leg reads). */
interface HostedHiveView
{
    readonly HiveId: string
    readonly Level: string
    readonly Health: string
    readonly Environments: ReadonlyArray<{ readonly Name: string, readonly Ready: boolean }>
}

/**
 * Leg 5b (scratch, C5.1 Task 6 live proof; not committed). The customer asks for a Hosted hive through the customer API
 * (`start-enrolment` level hosted), which the cabinet UI does not offer for that level, so the leg calls the same
 * `/api/cabinet/` operations the cabinet client calls, from inside the signed-in page (its session cookies). The platform
 * schedules the placement onto the host agent, which builds a kind cluster `pragmatic-hosted-<placement>`, installs the
 * engine chart (hosted=true), and the hive enrols itself and reports Healthy.
 *
 * ONE hosted hive is kept alive for the legs after this one (staff sign-in, Plexus, deploy): Run does not leave it. To make
 * its console reachable from the journey's WSL host, Run reads the console and sign-in hosts from the cluster's
 * Ingresses, aliases both to the loopback in /etc/hosts, starts a kubectl port-forward to ingress-nginx (the leg instance
 * holds it until Clean) and checks the console's certificate chains to the engine's development CA through it; the
 * context then names ConsoleUrl, ConsoleHost, IdpHost and the placement (JourneyKeys.HostedPlacement), which the later
 * legs read. (The host-agent restart-mid-build recovery, open (a), is proven live separately, not in this journey.)
 * Clean stops the forward, removes the aliases, then leaves any hosted hive of the run's client still live (the host agent
 * tears its cluster down).
 */
export class PlaceHostedLeg implements IJourneyLeg
{
    public readonly Name = JourneyLegName.PlaceHosted
    public readonly Dependencies = [JourneyDependency.Cabinet, JourneyDependency.CentralLogin, JourneyDependency.EntitlementDelivery, JourneyDependency.HostedPlacement]

    public static readonly PlacedBudgetMs = 12 * 60_000
    public static readonly GoneBudgetMs = 6 * 60_000
    public readonly DeadlineMs = 45 * 60_000
    private static readonly SlowIntervalMs = 15_000
    private static readonly FastIntervalMs = 5_000
    private static readonly DockerTimeoutMs = 90_000

    private static readonly AccountOp = '/api/cabinet/account'
    private static readonly StartEnrolmentOp = '/api/cabinet/start-enrolment'
    private static readonly ListHivesOp = '/api/cabinet/list-hives'
    private static readonly LeaveHiveOp = '/api/cabinet/leave-hive'

    private static readonly ClientIdField = 'ClientId'
    private static readonly TenantIdField = 'TenantId'
    private static readonly LevelField = 'Level'
    private static readonly HiveIdField = 'HiveId'

    private static readonly HostedLevel = 'hosted'
    private static readonly HealthyHealth = 'healthy'
    private static readonly GoneHealth = 'gone'
    private static readonly HiveIdPrefix = 'hv'

    private static readonly Docker = 'docker'
    private static readonly PsArgs: readonly string[] = ['ps', '--format', '{{.Names}}']
    private static readonly ClusterPrefix = 'pragmatic-hosted-'
    private static readonly NewLine = /\r?\n/


    private static readonly PlacementIdField = 'PlacementId'
    private static readonly ClientField = 'Client'
    private static readonly HivesField = 'Hives'

    private static readonly NotYet = 'not yet'
    private static readonly StartedHostedPrefix = 'asked for a Hosted hive through the customer API; placement '
    private static readonly PlacedHealthyPrefix = 'the host agent placed the hive and it reports Healthy: '
    private static readonly ClusterOpen = ' (cluster '
    private static readonly ClusterClose = ')'
    private static readonly LeftPrefix = 'left the Hosted hive '
    private static readonly ClusterGoneSuffix = '; its cluster is gone: '
    private static readonly ReachBudgetMs = 3 * 60_000
    private static readonly HostsCondition = 'the hosted cluster to list its console and sign-in ingresses'
    private static readonly ReachCondition = 'the console to answer through the port-forward with a certificate that chains to the engine CA'
    private static readonly ReachedPrefix = 'the console is reachable through a port-forward to ingress-nginx: '
    private static readonly ReachedPort = ' on local port '
    private static readonly ReachedAliases = '; /etc/hosts aliases for '
    private static readonly HostSeparator = ', '
    private static readonly ReachStopped = 'stopped the console port-forward and removed the /etc/hosts aliases'
    private static readonly ClusterGonePrefix = 'its cluster is gone: '
    private static readonly NoClient = 'no client recorded; nothing to leave'
    private static readonly NothingToLeave = 'no live hosted hive of the run is left to leave'
    private static readonly CleanLeftPrefix = 'left a hosted hive at clean: '
    private static readonly PlacedCondition = 'the host agent to place the hive and report it Healthy'
    private static readonly GoneCondition = 'the cabinet to stop listing the hive '
    private static readonly ClusterGoneCondition = 'the host agent to tear down cluster '

    private reach: ConsoleReach | undefined

    public constructor(
        private readonly session: CustomerSession,
        private readonly runner: IProcessRunner,
        private readonly waiter: Waiter,
        private readonly evidence: Evidence,
        private readonly clusters: HostedClusters,
        private readonly trust: IConsoleTrust)
    {
    }

    public async Run(context: JourneyContext): Promise<void>
    {
        const L = PlaceHostedLeg
        const clientName = context.Require(JourneyKeys.ClientName)
        const tenant = context.Require(JourneyKeys.Tenant)
        const page = await this.session.AccountPage(clientName)
        const clientId = await this.ClientId(page)

        // A Hosted placement, Healthy; the hive then stays alive for the later legs (Clean leaves it).
        const placement = await this.Placement(context, page, clientId, tenant, JourneyKeys.HostedPlacement, L.StartedHostedPrefix)
        const hive = await this.WaitHealthy(page, clientId)
        context.Set(JourneyKeys.Hive, hive)
        context.Set(JourneyKeys.HiveState, JourneyState.HiveEnrolled)
        this.evidence.Step(this.Name, L.PlacedHealthyPrefix + hive + L.ClusterOpen + L.ClusterPrefix + placement + L.ClusterClose)
        // A Hosted hive is push-managed: environments are applied by the platform (the operator control-plane route,
        // gated on HiveReach.Pushable), not by the customer's request-environment, which a push hive refuses
        // (hive-takes-no-intents). The staff sign-in leg creates the environment through the hive's own console.
        await this.ReachConsole(context, placement)
    }

    public async Clean(context: JourneyContext): Promise<void>
    {
        const L = PlaceHostedLeg
        await this.reach?.Stop()
        this.reach = undefined
        // By marker, so a killed run's leftover aliases go too.
        this.clusters.Aliases.Remove()
        this.evidence.Step(this.Name, L.ReachStopped)
        const clientName = context.Get(JourneyKeys.ClientName)
        if (clientName === undefined)
        {
            this.evidence.Step(this.Name, L.NoClient)
            return
        }
        const page = await this.session.AccountPage(clientName)
        const clientId = await this.ClientId(page)
        const live = (await this.ListHives(page, clientId)).filter(hive => this.IsLiveHosted(hive))
        if (live.length === 0)
        {
            this.evidence.Step(this.Name, L.NothingToLeave)
            return
        }
        for (const hive of live)
        {
            await this.Leave(page, clientId, hive.HiveId)
            await this.WaitGone(page, clientId, hive.HiveId)
            this.evidence.Step(this.Name, L.CleanLeftPrefix + hive.HiveId)
        }
        const placement = context.Get(JourneyKeys.HostedPlacement)
        if (placement !== undefined)
        {
            await this.WaitClusterGone(placement)
            this.evidence.Step(this.Name, L.ClusterGonePrefix + L.ClusterPrefix + placement)
        }
    }

    /**
     * Makes the placed hive's console reachable: its hosts from the Ingresses, loopback aliases for them, a port-forward
     * to ingress-nginx (kept on this leg), and a TLS check through it against the engine's development CA.
     */
    private async ReachConsole(context: JourneyContext, placement: string): Promise<void>
    {
        const L = PlaceHostedLeg
        const hosted = this.clusters.For(placement)
        await hosted.EnsureKubeconfig()
        const hosts = await this.waiter.Until(L.HostsCondition, async () =>
        {
            const console = await hosted.ConsoleHost()
            const idp = await hosted.IdpHost()
            return console !== undefined && idp !== undefined ? WaitObservation.Met({ Console: console, Idp: idp }, console + L.HostSeparator + idp) : WaitObservation.NotYet<{ Console: string, Idp: string }>(L.NotYet)
        }, L.ReachBudgetMs, L.FastIntervalMs)
        const port = HostedCluster.ConsolePort
        hosted.AddHostAliases([hosts.Console, hosts.Idp])
        await this.reach?.Stop()
        this.reach = hosted.StartConsoleReach(port)
        context.Set(JourneyKeys.ConsoleHost, hosts.Console)
        context.Set(JourneyKeys.IdpHost, hosts.Idp)
        context.Set(JourneyKeys.ConsoleUrl, HostedCluster.ConsoleUrl(hosts.Console, port))
        // The forward needs a moment to listen; the check doubles as the wait for it.
        await this.waiter.Until(L.ReachCondition, async () =>
        {
            const pins = await this.trust.Pins([hosts.Console, hosts.Idp], port, await hosted.DevCa())
            return WaitObservation.Met(pins, String(pins.length))
        }, L.ReachBudgetMs, L.FastIntervalMs)
        context.Set(JourneyKeys.ConsoleTrusted, JourneyState.ConsoleTrusted)
        this.evidence.Step(this.Name, L.ReachedPrefix + hosts.Console + L.ReachedPort + port + L.ReachedAliases + hosts.Console + L.HostSeparator + hosts.Idp)
    }

    /** Reuses a placement recorded by a stopped run, or starts one and records it before it is scheduled. */
    private async Placement(context: JourneyContext, page: IJourneyPage, clientId: string, tenant: string, key: string, prefix: string): Promise<string>
    {
        const recorded = context.Get(key)
        if (recorded !== undefined)
        {
            return recorded
        }
        const placement = await this.StartHosted(page, clientId, tenant)
        context.Set(key, placement)
        this.evidence.Step(this.Name, prefix + placement)
        return placement
    }

    private async ClientId(page: IJourneyPage): Promise<string>
    {
        const L = PlaceHostedLeg
        const account = await page.PostJson(L.AccountOp, {}) as { Client?: { ClientId?: string } }
        const clientId = account.Client?.ClientId
        if (clientId === undefined)
        {
            throw new Error(L.ClientField)
        }
        return clientId
    }

    private async StartHosted(page: IJourneyPage, clientId: string, tenant: string): Promise<string>
    {
        const L = PlaceHostedLeg
        const start = await page.PostJson(L.StartEnrolmentOp, { [L.ClientIdField]: clientId, [L.TenantIdField]: tenant, [L.LevelField]: L.HostedLevel }) as { PlacementId?: string }
        if (start.PlacementId === undefined || start.PlacementId === null)
        {
            throw new Error(L.PlacementIdField)
        }
        return start.PlacementId
    }

    private async ListHives(page: IJourneyPage, clientId: string): Promise<HostedHiveView[]>
    {
        const L = PlaceHostedLeg
        // The cabinet answers list-hives as { Hives: [...] }, not a bare array.
        const answer = await page.PostJson(L.ListHivesOp, { [L.ClientIdField]: clientId, [L.TenantIdField]: null }) as Record<string, HostedHiveView[] | undefined>
        return answer[L.HivesField] ?? []
    }

    private async Leave(page: IJourneyPage, clientId: string, hiveId: string): Promise<void>
    {
        const L = PlaceHostedLeg
        await page.PostJson(L.LeaveHiveOp, { [L.ClientIdField]: clientId, [L.HiveIdField]: hiveId })
    }

    private IsLiveHosted(hive: HostedHiveView): boolean
    {
        const L = PlaceHostedLeg
        return hive.Level === L.HostedLevel && hive.Health !== L.GoneHealth && hive.HiveId.startsWith(L.HiveIdPrefix)
    }

    private async WaitHealthy(page: IJourneyPage, clientId: string): Promise<string>
    {
        const L = PlaceHostedLeg
        return this.waiter.Until(L.PlacedCondition, async () =>
        {
            const hive = (await this.ListHives(page, clientId)).find(candidate => this.IsLiveHosted(candidate) && candidate.Health === L.HealthyHealth)
            return hive === undefined ? WaitObservation.NotYet<string>(L.NotYet) : WaitObservation.Met(hive.HiveId, hive.HiveId)
        }, L.PlacedBudgetMs, L.SlowIntervalMs)
    }

    private async WaitGone(page: IJourneyPage, clientId: string, hiveId: string): Promise<void>
    {
        const L = PlaceHostedLeg
        await this.waiter.Until(L.GoneCondition + hiveId, async () =>
        {
            const hive = (await this.ListHives(page, clientId)).find(candidate => candidate.HiveId === hiveId)
            const gone = hive === undefined || hive.Health === L.GoneHealth
            return gone ? WaitObservation.Met(true, hiveId) : WaitObservation.NotYet<boolean>(L.NotYet)
        }, L.GoneBudgetMs, L.SlowIntervalMs)
    }

    private async WaitClusterGone(placement: string): Promise<void>
    {
        const L = PlaceHostedLeg
        const prefix = L.ClusterPrefix + placement
        await this.waiter.Until(L.ClusterGoneCondition + prefix, async () =>
        {
            const names = await this.DockerNames()
            const present = names.some(name => name.startsWith(prefix))
            return present ? WaitObservation.NotYet<boolean>(L.NotYet) : WaitObservation.Met(true, prefix)
        }, L.GoneBudgetMs, L.FastIntervalMs)
    }

    private async DockerNames(): Promise<string[]>
    {
        const L = PlaceHostedLeg
        const result = await this.runner.Run(L.Docker, L.PsArgs, L.DockerTimeoutMs)
        if (!result.Ok)
        {
            throw new Error(result.Stderr)
        }
        return result.Stdout.split(L.NewLine).map(line => line.trim()).filter(line => line.length > 0)
    }
}
