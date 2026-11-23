import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { JourneyConfig } from '../journey-config.js'
import { ForeignZoneError, JourneyDns } from '../live/journey-dns.js'
import { TempFolder } from './journey-fakes.js'

/** A recorded Cloudflare API: one zone, an in-memory record list. */
class FakeCloudflare
{
    public readonly Requests: string[] = []
    public readonly Records: Array<{ id: string, name: string, type: string, content: string }> = []
    private next = 1

    public readonly Fetch = async (input: string, init?: RequestInit): Promise<Response> =>
    {
        const method = init?.method ?? 'GET'
        this.Requests.push(method + ' ' + input)
        const url = new URL(input)
        if (url.pathname === '/client/v4/zones')
        {
            return Response.json({ success: true, result: [{ id: 'zone-1', name: url.searchParams.get('name') }] })
        }
        const body = init?.body === undefined ? {} : JSON.parse(String(init.body)) as { name: string, type: string, content: string }
        if (method === 'GET')
        {
            return Response.json({ success: true, result: this.Records.filter(r => r.name === url.searchParams.get('name')) })
        }
        if (method === 'POST')
        {
            this.Records.push({ id: 'rec-' + this.next++, ...(body as { name: string, type: string, content: string }) })
            return Response.json({ success: true, result: {} })
        }
        const id = url.pathname.split('/').pop()
        const index = this.Records.findIndex(r => r.id === id)
        if (method === 'PUT')
        {
            this.Records[index] = { id: id!, ...(body as { name: string, type: string, content: string }) }
        }
        if (method === 'DELETE')
        {
            this.Records.splice(index, 1)
        }
        return Response.json({ success: true, result: {} })
    }
}

describe('JourneyDns', () =>
{
    it('domain writes and deletes only journey TXT records', async () =>
    {
        const cf = new FakeCloudflare()
        const dns = new JourneyDns('journey.pragmatic-lab.com', 'token', cf.Fetch)
        await dns.UpsertTxt('_pragmatic.run-1.journey.pragmatic-lab.com', 'challenge-1')
        await dns.UpsertTxt('_pragmatic.run-1.journey.pragmatic-lab.com', 'challenge-2')
        assert.deepEqual(cf.Records.map(r => [r.name, r.type, r.content]), [['_pragmatic.run-1.journey.pragmatic-lab.com', 'TXT', '"challenge-2"']])
        assert.equal(await dns.DeleteTxt('_pragmatic.run-1.journey.pragmatic-lab.com'), 1)
        assert.equal(cf.Records.length, 0)
        assert.ok(cf.Requests.every(r => r.includes('api.cloudflare.com/client/v4/zones')))
    })

    it('a foreign zone is refused before any request', async () =>
    {
        const cf = new FakeCloudflare()
        const dns = new JourneyDns('journey.pragmatic-lab.com', 'token', cf.Fetch)
        for (const name of ['pragmatic-tech.ai', '_x.pragmatic-tech.ai', 'www.pragmatic-lab.com', 'journey.pragmatic-lab.com', 'x.journey.pragmatic-lab.com.evil.example', 'a b.journey.pragmatic-lab.com'])
        {
            await assert.rejects(dns.UpsertTxt(name, 'v'), ForeignZoneError, name)
            await assert.rejects(dns.DeleteTxt(name), ForeignZoneError, name)
        }
        assert.deepEqual(cf.Requests, [])
        assert.throws(() => new JourneyDns('journey.pragmatic-tech.ai', 'token', cf.Fetch), ForeignZoneError)
        assert.equal(JourneyDns.Zone, 'pragmatic-lab.com', 'the zone is pinned, not configured')
    })

    it('is built from the configuration: its subdomain and the token file it names', async () =>
    {
        const folder = new TempFolder()
        const tokenFile = join(folder.Path, 'dns-token')
        writeFileSync(tokenFile, 'tok-123\n')
        const document = {
            websiteUrl: 'https://www.example', cabinetUrl: 'https://cabinet.example', centralIssuer: 'https://login.example/realms/central', edgeUrl: 'https://agent.example',
            planName: 'Starter', emailDomain: 'pragmatic-lab.com', journeyDnsSubdomain: 'journey.pragmatic-lab.com', customerCluster: 'pragmatic-customer', liveDependencies: [],
        }
        const cf = new FakeCloudflare()
        const seen: string[] = []
        const fetcher = async (input: string, init?: RequestInit): Promise<Response> =>
        {
            seen.push(String((init?.headers as Record<string, string>).authorization))
            return cf.Fetch(input, init)
        }
        const dns = JourneyDns.For(JourneyConfig.FromDocument(document, { PRAGMATIC_JOURNEY_DNS_TOKEN_FILE: tokenFile }, '/repo'), fetcher)
        await dns.UpsertTxt('_x.run-1.journey.pragmatic-lab.com', 'v')
        assert.ok(seen.every(header => header === 'Bearer tok-123'))
        assert.throws(() => JourneyDns.For(JourneyConfig.FromDocument({ ...document, journeyDnsSubdomain: 'journey.example.com' }, { PRAGMATIC_JOURNEY_DNS_TOKEN_FILE: tokenFile }, '/repo')), ForeignZoneError)
        folder.Dispose()
    })
})
