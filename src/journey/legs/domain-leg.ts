import type { CabinetDomainsPage } from '../drivers/cabinet-domains-page.js'
import type { Evidence } from '../evidence.js'
import type { JourneyContext } from '../journey-context.js'
import { JourneyDependency } from '../journey-dependency.js'
import type { IJourneyLeg } from '../journey-leg.js'
import type { IJourneyDns } from '../live/journey-dns.js'
import { JourneyKeys, JourneyLegName, JourneyState } from './journey-keys.js'

/**
 * Leg 6: the domain. On the cabinet's Email domains page the customer admin starts verification of
 * `<run id>.journey.pragmatic-lab.com`; the cabinet shows the TXT record to publish (name and value); the leg writes
 * that record through the journey DNS token (only under the journey's own subdomain), presses Check, and waits until
 * the cabinet shows the domain Verified. The domain and the record's name are recorded before the record is written,
 * so the clean of a killed run knows what to delete (the value is a public challenge, not kept). Clean deletes the TXT
 * record; the verified domain itself stays under its journey client (the customer API has no domain removal).
 */
export class DomainLeg implements IJourneyLeg
{
    public readonly Name = JourneyLegName.Domain
    public readonly Dependencies = [JourneyDependency.EntitlementDelivery, JourneyDependency.JourneyDns]
    /** Above its waits' sum: the open (up to 300 s), the start (3 min) and the check (5 min): under 12 min. */
    public readonly DeadlineMs = 20 * 60_000
    private static readonly Subdomain = '.journey.pragmatic-lab.com'
    private static readonly StartDeadlineMs = 3 * 60_000
    private static readonly CheckDeadlineMs = 5 * 60_000
    private static readonly Asked = 'the cabinet asked for TXT '
    private static readonly Wrote = ', written through the journey DNS token'
    private static readonly Verified = 'the cabinet shows the domain verified: '
    private static readonly Deleted = 'deleted the TXT record(s) '
    private static readonly Count = ': '
    private static readonly Stays = '; the verified domain stays under its journey client: the customer API has no domain removal'
    private static readonly NothingWritten = 'no TXT record was written'

    public constructor(private readonly domains: CabinetDomainsPage, private readonly dns: IJourneyDns, private readonly evidence: Evidence)
    {
    }

    /** The run's own domain: `<run id>.journey.pragmatic-lab.com`. */
    public static DomainFor(runId: string): string
    {
        return runId.toLowerCase() + DomainLeg.Subdomain
    }

    public async Run(context: JourneyContext): Promise<void>
    {
        const T = DomainLeg
        const clientName = context.Require(JourneyKeys.ClientName)
        const domain = T.DomainFor(context.RunId)
        // Recorded before anything is written, so a killed run's clean names the domain.
        context.Set(JourneyKeys.Domain, domain)
        const page = await this.domains.Open(clientName)
        const challenge = await this.domains.Start(page, domain, T.StartDeadlineMs)
        // The record's name is recorded before the DNS write, so a killed run's clean deletes it.
        context.Set(JourneyKeys.DomainTxtName, challenge.Name)
        context.Set(JourneyKeys.DomainState, JourneyState.DomainChallenged)
        await this.dns.UpsertTxt(challenge.Name, challenge.Value)
        this.evidence.Step(this.Name, T.Asked + challenge.Name + T.Wrote)
        await this.domains.Check(page, domain, T.CheckDeadlineMs)
        context.Set(JourneyKeys.DomainState, JourneyState.DomainVerified)
        this.evidence.Step(this.Name, T.Verified + domain)
    }

    public async Clean(context: JourneyContext): Promise<void>
    {
        const T = DomainLeg
        const name = context.Get(JourneyKeys.DomainTxtName)
        if (name === undefined)
        {
            this.evidence.Step(this.Name, T.NothingWritten)
            return
        }
        const removed = await this.dns.DeleteTxt(name)
        this.evidence.Step(this.Name, T.Deleted + name + T.Count + removed + T.Stays)
    }
}
