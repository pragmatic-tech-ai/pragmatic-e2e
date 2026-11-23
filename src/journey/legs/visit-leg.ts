import type { IJourneyBrowser } from '../drivers/journey-browser.js'
import type { WebsitePage } from '../drivers/website-page.js'
import type { Evidence } from '../evidence.js'
import type { JourneyContext } from '../journey-context.js'
import { JourneyDependency } from '../journey-dependency.js'
import type { IJourneyLeg } from '../journey-leg.js'
import { JourneyKeys, JourneyLegName } from './journey-keys.js'

/** Leg 1: the website's pricing page links into the cabinet's registration. Creates nothing, so cleans nothing. */
export class VisitLeg implements IJourneyLeg
{
    public readonly Name = JourneyLegName.Visit
    public readonly Dependencies = [JourneyDependency.Website, JourneyDependency.Cabinet]
    public readonly DeadlineMs = 60_000
    private static readonly Found = 'the pricing page links to '

    public constructor(private readonly browser: IJourneyBrowser, private readonly website: WebsitePage, private readonly evidence: Evidence)
    {
    }

    public async Run(context: JourneyContext): Promise<void>
    {
        // Origin and path only: a query could carry a campaign code, which the context never holds.
        const found = new URL(await this.website.RegistrationLink(await this.browser.Page()))
        const link = found.origin + found.pathname
        context.Set(JourneyKeys.RegistrationLink, link)
        this.evidence.Step(this.Name, VisitLeg.Found + link)
    }

    public async Clean(_context: JourneyContext): Promise<void>
    {
    }
}
