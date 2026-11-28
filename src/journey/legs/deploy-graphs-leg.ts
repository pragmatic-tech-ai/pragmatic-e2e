import type { IJourneyBrowser } from '../drivers/journey-browser.js'
import type { IJourneyPage } from '../drivers/journey-page.js'
import { TenantConsoleApi } from '../drivers/tenant-console-api.js'
import type { Evidence } from '../evidence.js'
import type { JourneyContext } from '../journey-context.js'
import { JourneyDependency } from '../journey-dependency.js'
import type { IJourneyLeg } from '../journey-leg.js'
import type { IConsoleTrust } from '../live/console-trust.js'
import type { IEngineClusterSource } from '../live/engine-secrets.js'
import { WaitAbortError, type Waiter } from '../waiter.js'
import { ConsoleSession } from './console-session.js'
import { JourneyKeys, JourneyLegName, JourneyState } from './journey-keys.js'
import { StaffSignInLeg } from './staff-sign-in-leg.js'

/**
 * Leg 9: deploy graphs (C5.1 (b)). An independent confirmation of the Plexus leg: the Owner, signed in to the engine
 * console, asks the tenant-api whether the environment `journey` lists a deployed graph. A non-empty list passes; an
 * empty one (Plexus deployed nothing) or a failed request fails. Nothing is created, so Clean has nothing to undo.
 */
export class DeployGraphsLeg implements IJourneyLeg
{
    public readonly Name = JourneyLegName.DeployGraphs
    public readonly Dependencies: readonly JourneyDependency[]
    /** The Owner sign-in (2 min) plus the request. */
    public readonly DeadlineMs = 5 * 60_000
    private static readonly OwnerSignedIn = 'the Owner signed in to the engine console'
    private static readonly NoGraphs = 'the environment lists no deployed graph: '
    private static readonly GraphsListed = 'the tenant-api lists deployed graphs in the environment: '
    private static readonly CountSeparator = ' graph(s) in '
    private static readonly NothingToClean = 'nothing to undo: the leg created nothing'
    private static readonly DiagnosticUrl = 'console step failed; landing url: '
    private static readonly DiagnosticBody = 'console step failed; landing body text: '

    private readonly api = new TenantConsoleApi()

    public constructor(
        private readonly browser: IJourneyBrowser,
        private readonly clusters: IEngineClusterSource,
        private readonly trust: IConsoleTrust,
        private readonly waiter: Waiter,
        private readonly evidence: Evidence,
        hiveDependency: JourneyDependency)
    {
        this.Dependencies = [JourneyDependency.EntitlementDelivery, hiveDependency, JourneyDependency.PlexusRealmSignIn]
    }

    public async Run(context: JourneyContext): Promise<void>
    {
        const L = DeployGraphsLeg
        const environment = StaffSignInLeg.Environment
        const session = new ConsoleSession(context, this.trust, this.clusters, this.waiter)
        const owner = await this.browser.ConsolePage(await session.Pins(), session.ResolverRules())
        const engine = session.Engine()
        await this.OnConsole(owner, () => engine.SignIn(owner, () => this.clusters.For(context).Owner()))
        this.evidence.Step(this.Name, L.OwnerSignedIn)
        const graphs = await this.OnConsole(owner, () => this.api.ListGraphs(owner, environment))
        if (graphs.length === 0)
        {
            throw new WaitAbortError(L.NoGraphs + environment)
        }
        context.Set(JourneyKeys.GraphsState, JourneyState.GraphsListed)
        this.evidence.Step(this.Name, L.GraphsListed + graphs.length + L.CountSeparator + environment)
    }

    public async Clean(_context: JourneyContext): Promise<void>
    {
        this.evidence.Step(this.Name, DeployGraphsLeg.NothingToClean)
    }

    /** Runs a console step on `page`; on a failure records the page's real landing, then rethrows so the leg still fails. */
    private async OnConsole<T>(page: IJourneyPage, step: () => Promise<T>): Promise<T>
    {
        try
        {
            return await step()
        }
        catch (error)
        {
            this.evidence.Step(this.Name, DeployGraphsLeg.DiagnosticUrl + page.Url())
            this.evidence.Step(this.Name, DeployGraphsLeg.DiagnosticBody + await page.BodyText())
            await this.evidence.FailureScreenshot(this.Name, page.ScreenshotPage())
            throw error
        }
    }
}
