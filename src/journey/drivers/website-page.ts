import type { IJourneyPage } from './journey-page.js'

/** The public website's pricing page: where a visitor finds the cabinet's registration. */
export class WebsitePage
{
    public static readonly PricingPath = '/pricing'
    private static readonly RegisterPath = '/register'
    private static readonly NoLink = 'the pricing page links nowhere into the cabinet\'s registration ('
    private static readonly CloseParen = ')'

    public constructor(private readonly websiteUrl: string, private readonly cabinetUrl: string)
    {
    }

    /** Opens the pricing page and answers the first link into the cabinet's `/register` (with any query it carries). */
    public async RegistrationLink(page: IJourneyPage): Promise<string>
    {
        const W = WebsitePage
        await page.Goto(this.websiteUrl + W.PricingPath)
        const cabinetOrigin = new URL(this.cabinetUrl).origin
        const link = (await page.Hrefs()).find(href =>
        {
            const url = new URL(href)
            return url.origin === cabinetOrigin && url.pathname === W.RegisterPath
        })
        if (link === undefined)
        {
            throw new Error(W.NoLink + cabinetOrigin + W.RegisterPath + W.CloseParen)
        }
        return link
    }
}
