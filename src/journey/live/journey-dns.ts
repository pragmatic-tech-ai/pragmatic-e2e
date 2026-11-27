import { JourneyConfig } from '../journey-config.js'
import type { JourneyFetch } from './central-account.js'

/** A DNS name outside the journey's own subdomain was asked for. */
export class ForeignZoneError extends Error
{
    private static readonly Prefix = 'the journey writes TXT records under its own subdomain only; refused: '

    public constructor(name: string)
    {
        super(ForeignZoneError.Prefix + name)
    }
}

/** What the domain leg needs of the journey's DNS: write and delete its TXT records. */
export interface IJourneyDns
{
    UpsertTxt(name: string, value: string): Promise<void>
    DeleteTxt(name: string): Promise<number>
}

/** The journey's DNS built on first use: the leg is wired before its token file is needed (a pending leg never asks). */
export class LazyJourneyDns implements IJourneyDns
{
    private dns: JourneyDns | undefined

    public constructor(private readonly config: JourneyConfig)
    {
    }

    public UpsertTxt(name: string, value: string): Promise<void>
    {
        return this.Dns().UpsertTxt(name, value)
    }

    public DeleteTxt(name: string): Promise<number>
    {
        return this.Dns().DeleteTxt(name)
    }

    private Dns(): JourneyDns
    {
        this.dns ??= JourneyDns.For(this.config)
        return this.dns
    }
}

/**
 * TXT records for the journey's verified email domains (`<run>.journey.pragmatic-lab.com`), through the Cloudflare API
 * with the test-only DNS token (DNS Write on `pragmatic-lab.com` only). The zone is fixed here, not configured; the
 * configured subdomain must lie under it, and any name not under the subdomain is refused before a request is made,
 * so the class can never touch another zone or another of that zone's names.
 */
export class JourneyDns implements IJourneyDns
{
    public static readonly Zone = 'pragmatic-lab.com'
    private static readonly Api = 'https://api.cloudflare.com/client/v4/zones'
    private static readonly RecordsPath = '/dns_records'
    private static readonly NameQuery = '?name='
    private static readonly TypeQuery = '&type='
    private static readonly ZoneQuery = '?name='
    private static readonly Txt = 'TXT'
    private static readonly Slash = '/'
    private static readonly Dot = '.'
    private static readonly Quote = '"'
    private static readonly Get = 'GET'
    private static readonly Post = 'POST'
    private static readonly Put = 'PUT'
    private static readonly Delete = 'DELETE'
    private static readonly Authorization = 'authorization'
    private static readonly ContentType = 'content-type'
    private static readonly Json = 'application/json'
    private static readonly BearerPrefix = 'Bearer '
    private static readonly Ttl = 60
    private static readonly TimeoutMs = 20_000
    private static readonly NameShape = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/
    private static readonly ApiFailed = 'Cloudflare answered '
    private static readonly NoZone = 'the DNS token sees no zone named '
    private static readonly Space = ' '

    private zoneId: string | undefined

    private readonly zone = JourneyDns.Zone

    public constructor(private readonly subdomain: string, private readonly token: string, private readonly fetcher: JourneyFetch = fetch)
    {
        if (!subdomain.endsWith(JourneyDns.Dot + JourneyDns.Zone))
        {
            throw new ForeignZoneError(subdomain)
        }
    }

    /** From the journey's configuration: its subdomain, and the token in the file PRAGMATIC_JOURNEY_DNS_TOKEN_FILE names. */
    public static For(config: JourneyConfig, fetcher: JourneyFetch = fetch): JourneyDns
    {
        return new JourneyDns(config.JourneyDnsSubdomain, JourneyConfig.ReadSecretFile(config.RequireFile(JourneyConfig.DnsTokenFileEnv)), fetcher)
    }

    /** Creates or replaces the TXT record `name` with `value` (one record per name: the journey writes one challenge). */
    public async UpsertTxt(name: string, value: string): Promise<void>
    {
        const J = JourneyDns
        this.Check(name)
        const zoneId = await this.ZoneId()
        const existing = await this.Find(zoneId, name)
        const body = JSON.stringify({ type: J.Txt, name, content: J.Quote + value + J.Quote, ttl: J.Ttl })
        if (existing.length === 0)
        {
            await this.Call(J.Post, J.Api + J.Slash + zoneId + J.RecordsPath, body)
            return
        }
        await this.Call(J.Put, J.Api + J.Slash + zoneId + J.RecordsPath + J.Slash + existing[0], body)
        for (const extra of existing.slice(1))
        {
            await this.Call(J.Delete, J.Api + J.Slash + zoneId + J.RecordsPath + J.Slash + extra)
        }
    }

    /** Deletes every TXT record named `name`; answers how many went. */
    public async DeleteTxt(name: string): Promise<number>
    {
        const J = JourneyDns
        this.Check(name)
        const zoneId = await this.ZoneId()
        const existing = await this.Find(zoneId, name)
        for (const id of existing)
        {
            await this.Call(J.Delete, J.Api + J.Slash + zoneId + J.RecordsPath + J.Slash + id)
        }
        return existing.length
    }

    private Check(name: string): void
    {
        if (!JourneyDns.NameShape.test(name) || !name.endsWith(JourneyDns.Dot + this.subdomain))
        {
            throw new ForeignZoneError(name)
        }
    }

    private async ZoneId(): Promise<string>
    {
        const J = JourneyDns
        if (this.zoneId === undefined)
        {
            const answer = await this.Call(J.Get, J.Api + J.ZoneQuery + encodeURIComponent(this.zone))
            const zones = answer.result as Array<{ id: string, name: string }>
            const match = zones.find(zone => zone.name === this.zone)
            if (match === undefined)
            {
                throw new Error(J.NoZone + this.zone)
            }
            this.zoneId = match.id
        }
        return this.zoneId
    }

    private async Find(zoneId: string, name: string): Promise<string[]>
    {
        const J = JourneyDns
        const answer = await this.Call(J.Get, J.Api + J.Slash + zoneId + J.RecordsPath + J.NameQuery + encodeURIComponent(name) + J.TypeQuery + J.Txt)
        return (answer.result as Array<{ id: string, name: string }>).filter(record => record.name === name).map(record => record.id)
    }

    private async Call(method: string, url: string, body?: string): Promise<{ result: unknown }>
    {
        const J = JourneyDns
        const response = await this.fetcher(url, {
            method,
            signal: AbortSignal.timeout(J.TimeoutMs),
            headers: { [J.Authorization]: J.BearerPrefix + this.token, [J.ContentType]: J.Json },
            body,
        })
        const json = await response.json().catch(() => ({})) as { success?: boolean, result?: unknown }
        if (!response.ok || json.success !== true)
        {
            throw new Error(J.ApiFailed + response.status + J.Space + method)
        }
        return { result: json.result }
    }
}
