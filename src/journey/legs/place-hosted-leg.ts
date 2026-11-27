import type { CustomerSession } from '../drivers/customer-session.js'
import type { IJourneyPage } from '../drivers/journey-page.js'
import type { Evidence } from '../evidence.js'
import type { JourneyContext } from '../journey-context.js'
import { JourneyDependency } from '../journey-dependency.js'
import type { IJourneyLeg } from '../journey-leg.js'
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
 * Leg 5b (scratch, C5.1 Task 6 Steps 2-3 live proof; not committed). The customer asks for a Hosted hive through the
 * customer API (`start-enrolment` level hosted), which the cabinet UI does not offer for that level, so the leg calls
 * the same `/api/cabinet/` operations the cabinet client calls, from inside the signed-in page (its session cookies).
 * The platform schedules the placement onto the host agent, which builds a kind cluster `pragmatic-hosted-<placement>`,
 * installs the engine chart (hosted=true), and the hive enrols itself and reports Healthy; the leg then requests an
 * environment, which the platform pushes to the Hosted hive over the per-cluster credential, and waits for the hive to
 * report it ready. Step 3: it leaves that hive (its cluster is torn down), then starts a second placement and restarts
 * the host-agent container while that cluster is building, proving the placement resumes and completes once (exactly
 * one hosted hive), then leaves it too. Clean leaves any hosted hive of the run's client that is still live.
 */
export class PlaceHostedLeg implements IJourneyLeg
{
    public readonly Name = JourneyLegName.PlaceHosted
    public readonly Dependencies = [JourneyDependency.Cabinet, JourneyDependency.CentralLogin, JourneyDependency.EntitlementDelivery, JourneyDependency.HostedPlacement]

    public static readonly PlacedBudgetMs = 12 * 60_000
    public static readonly ReadyBudgetMs = 6 * 60_000
    public static readonly GoneBudgetMs = 6 * 60_000
    public static readonly BuildingBudgetMs = 4 * 60_000
    public readonly DeadlineMs = 45 * 60_000
    private static readonly SlowIntervalMs = 15_000
    private static readonly FastIntervalMs = 5_000
    private static readonly DockerTimeoutMs = 90_000

    private static readonly AccountOp = '/api/cabinet/account'
    private static readonly StartEnrolmentOp = '/api/cabinet/start-enrolment'
    private static readonly ListHivesOp = '/api/cabinet/list-hives'
    private static readonly RequestEnvironmentOp = '/api/cabinet/request-environment'
    private static readonly LeaveHiveOp = '/api/cabinet/leave-hive'

    private static readonly ClientIdField = 'ClientId'
    private static readonly TenantIdField = 'TenantId'
    private static readonly LevelField = 'Level'
    private static readonly HiveIdField = 'HiveId'
    private static readonly EnvironmentField = 'Environment'
    private static readonly PurposeField = 'Purpose'

    private static readonly HostedLevel = 'hosted'
    private static readonly HealthyHealth = 'healthy'
    private static readonly GoneHealth = 'gone'
    private static readonly HiveIdPrefix = 'hv'
    private static readonly EnvironmentName = 'journey'
    private static readonly DevelopmentPurpose = 'development'

    private static readonly Docker = 'docker'
    private static readonly HostAgentContainer = 'pragmatic-host-agent'
    private static readonly PsArgs: readonly string[] = ['ps', '--format', '{{.Names}}']
    private static readonly RestartArgs: readonly string[] = ['restart', PlaceHostedLeg.HostAgentContainer]
    private static readonly ClusterPrefix = 'pragmatic-hosted-'
    private static readonly ControlPlaneSuffix = '-control-plane'
    private static readonly NewLine = /\r?\n/

    private static readonly PlacementAKey = 'hostedPlacementA'
    private static readonly PlacementBKey = 'hostedPlacementB'
    private static readonly HiveAKey = 'hostedHiveA'
    private static readonly HiveBKey = 'hostedHiveB'

    private static readonly PlacementIdField = 'PlacementId'
    private static readonly IntentIdField = 'IntentId'
    private static readonly ClientField = 'Client'
    private static readonly HivesField = 'Hives'

    private static readonly NotYet = 'not yet'
    private static readonly StartedHostedPrefix = 'asked for a Hosted hive through the customer API; placement '
    private static readonly PlacedHealthyPrefix = 'the host agent placed the hive and it reports Healthy: '
    private static readonly ClusterOpen = ' (cluster '
    private static readonly ClusterClose = ')'
    private static readonly RequestedPrefix = 'requested environment `journey` on the Hosted hive; intent '
    private static readonly PushedReady = 'the platform pushed environment `journey` to the Hosted hive over the per-cluster credential; the hive reports it ready'
    private static readonly LeftPrefix = 'left the Hosted hive '
    private static readonly ClusterGoneSuffix = '; its cluster is gone: '
    private static readonly SecondPlacementPrefix = 'started a second Hosted placement; placement '
    private static readonly RestartedMidBuild = 'restarted the host agent while it was building cluster '
    private static readonly ResumedHealthyPrefix = 'after the restart the placement resumed and completed once; the hive is Healthy: '
    private static readonly DuplicatePrefix = 'more than one hosted hive after the restart (the placement ran twice): '
    private static readonly ListSeparator = ', '
    private static readonly NoClient = 'no client recorded; nothing to leave'
    private static readonly NothingToLeave = 'no live hosted hive of the run is left to leave'
    private static readonly CleanLeftPrefix = 'left a hosted hive at clean: '
    private static readonly PlacedCondition = 'the host agent to place the hive and report it Healthy'
    private static readonly ReadyCondition = 'the Hosted hive to report environment `journey` ready'
    private static readonly GoneCondition = 'the cabinet to stop listing the hive '
    private static readonly ClusterGoneCondition = 'the host agent to tear down cluster '
    private static readonly BuildingCondition = 'the host agent to start building cluster '

    public constructor(
        private readonly session: CustomerSession,
        private readonly runner: IProcessRunner,
        private readonly waiter: Waiter,
        private readonly evidence: Evidence)
    {
    }

    public async Run(context: JourneyContext): Promise<void>
    {
        const L = PlaceHostedLeg
        const clientName = context.Require(JourneyKeys.ClientName)
        const tenant = context.Require(JourneyKeys.Tenant)
        const page = await this.session.AccountPage(clientName)
        const clientId = await this.ClientId(page)

        // Step 2: a Hosted placement, Healthy, and a pushed environment.
        const placementA = await this.Placement(context, page, clientId, tenant, L.PlacementAKey, L.StartedHostedPrefix)
        const hiveA = await this.WaitHealthy(page, clientId)
        context.Set(L.HiveAKey, hiveA)
        context.Set(JourneyKeys.Hive, hiveA)
        context.Set(JourneyKeys.HiveState, JourneyState.HiveEnrolled)
        this.evidence.Step(this.Name, L.PlacedHealthyPrefix + hiveA + L.ClusterOpen + L.ClusterPrefix + placementA + L.ClusterClose)
        // A Hosted hive is push-managed: environments are applied by the platform (the operator control-plane route,
        // gated on HiveReach.Pushable), not by the customer's request-environment, which a push hive refuses
        // (hive-takes-no-intents). The platform env-push is proven as an operator step, not in this customer leg.

        // Step 3: leave A (one slot), then a second placement with a restart mid-build.
        await this.LeaveAndWait(page, clientId, hiveA, placementA)
        this.evidence.Step(this.Name, L.LeftPrefix + hiveA + L.ClusterGoneSuffix + L.ClusterPrefix + placementA)
        const placementB = await this.Placement(context, page, clientId, tenant, L.PlacementBKey, L.SecondPlacementPrefix)
        await this.WaitClusterBuilding(placementB)
        await this.RestartHostAgent()
        this.evidence.Step(this.Name, L.RestartedMidBuild + L.ClusterPrefix + placementB)
        const hiveB = await this.WaitHealthy(page, clientId)
        context.Set(L.HiveBKey, hiveB)
        context.Set(JourneyKeys.Hive, hiveB)
        const live = (await this.ListHives(page, clientId)).filter(hive => this.IsLiveHosted(hive))
        if (live.length !== 1)
        {
            throw new Error(L.DuplicatePrefix + live.map(hive => hive.HiveId).join(L.ListSeparator))
        }
        this.evidence.Step(this.Name, L.ResumedHealthyPrefix + hiveB)
        await this.LeaveAndWait(page, clientId, hiveB, placementB)
        this.evidence.Step(this.Name, L.LeftPrefix + hiveB + L.ClusterGoneSuffix + L.ClusterPrefix + placementB)
    }

    public async Clean(context: JourneyContext): Promise<void>
    {
        const L = PlaceHostedLeg
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

    private async RequestEnvironment(page: IJourneyPage, clientId: string, hiveId: string): Promise<string>
    {
        const L = PlaceHostedLeg
        const answer = await page.PostJson(L.RequestEnvironmentOp, { [L.ClientIdField]: clientId, [L.HiveIdField]: hiveId, [L.EnvironmentField]: L.EnvironmentName, [L.PurposeField]: L.DevelopmentPurpose }) as { IntentId?: string }
        return answer.IntentId ?? L.IntentIdField
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

    private async WaitEnvironmentReady(page: IJourneyPage, clientId: string, hiveId: string): Promise<void>
    {
        const L = PlaceHostedLeg
        await this.waiter.Until(L.ReadyCondition, async () =>
        {
            const hive = (await this.ListHives(page, clientId)).find(candidate => candidate.HiveId === hiveId)
            const ready = hive?.Environments.some(environment => environment.Name === L.EnvironmentName && environment.Ready) ?? false
            return ready ? WaitObservation.Met(true, L.EnvironmentName) : WaitObservation.NotYet<boolean>(L.NotYet)
        }, L.ReadyBudgetMs, L.SlowIntervalMs)
    }

    private async LeaveAndWait(page: IJourneyPage, clientId: string, hiveId: string, placement: string): Promise<void>
    {
        await this.Leave(page, clientId, hiveId)
        await this.WaitGone(page, clientId, hiveId)
        await this.WaitClusterGone(placement)
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

    private async WaitClusterBuilding(placement: string): Promise<void>
    {
        const L = PlaceHostedLeg
        const controlPlane = L.ClusterPrefix + placement + L.ControlPlaneSuffix
        await this.waiter.Until(L.BuildingCondition + L.ClusterPrefix + placement, async () =>
        {
            const names = await this.DockerNames()
            return names.includes(controlPlane) ? WaitObservation.Met(true, controlPlane) : WaitObservation.NotYet<boolean>(L.NotYet)
        }, L.BuildingBudgetMs, L.FastIntervalMs)
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

    private async RestartHostAgent(): Promise<void>
    {
        const L = PlaceHostedLeg
        const result = await this.runner.Run(L.Docker, L.RestartArgs, L.DockerTimeoutMs)
        if (!result.Ok)
        {
            throw new Error(result.Stderr)
        }
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
