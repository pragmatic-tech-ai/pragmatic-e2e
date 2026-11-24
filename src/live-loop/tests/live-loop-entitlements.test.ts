import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { EntitlementStatement, EntitlementsLink } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import { LiveLoopEntitlements } from '../live-loop-entitlements.js'

class LinkFx
{
    public static readonly Secret = Buffer.from('a'.repeat(64))
    /** base64url(HMAC-SHA256(Secret, 'pragmatic-entitlements/v1')): a fixed vector, not derived by the code under test. */
    public static readonly KnownBearer = 'Bearer 83-XD2y-htm7mk9LGhDZix11N_qgvHc0jVlg4kHWD2U'
    public static readonly ClientId = 'e2e-client'
    public static readonly ClientName = 'E2E Client'
    public static readonly IssuedAt = new Date('2026-11-24T10:00:00.000Z')
    public static readonly LoopbackHost = '127.0.0.1'
    public static readonly BasePrefix = 'http://127.0.0.1:'
    public static readonly SecretFileName = 'entitlements-link-secret'
    public static readonly Post = 'POST'
    public static readonly Utf8 = 'utf8'
    public static readonly Ok = 200
    public static readonly Unauthorized = 401
    public static readonly EmptyJson = '{}'
}

/** The console's internal listener as the link sees it: records each request and answers `Status`. */
class LinkConsole
{
    public Requests: { method: string | undefined; path: string | undefined; authorization: string | undefined; body: unknown }[] = []
    public Status = LinkFx.Ok
    public Base = ''
    private readonly server: Server = createServer((req, res) =>
    {
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () =>
        {
            this.Requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString(LinkFx.Utf8)) })
            res.writeHead(this.Status).end(LinkFx.EmptyJson)
        })
    })

    public async Start(): Promise<void>
    {
        await new Promise<void>(res => this.server.listen(0, LinkFx.LoopbackHost, () => res()))
        this.Base = LinkFx.BasePrefix + String((this.server.address() as AddressInfo).port)
    }

    public async Stop(): Promise<void>
    {
        await new Promise<void>(res => this.server.close(() => res()))
    }
}

describe('LiveLoopEntitlements', () =>
{
    const console_ = new LinkConsole()

    before(async () =>
    {
        await console_.Start()
    })

    after(async () =>
    {
        await console_.Stop()
    })

    it('states the client as a statement the console parses: version 1, active, one tenant and one hive, an e2e-only admin', () =>
    {
        const statement = LiveLoopEntitlements.Statement(LinkFx.ClientId, LinkFx.ClientName, LinkFx.IssuedAt)
        const parsed = EntitlementStatement.Parse(JSON.parse(JSON.stringify(statement.ToJson())))
        assert.equal(parsed.ClientId, LinkFx.ClientId)
        assert.equal(parsed.Version, LiveLoopEntitlements.FirstVersion)
        assert.deepEqual(statement.ToJson().Limits, { 'tenants': 1, 'hives': 1, 'verified-domains': 1 })
        assert.equal(statement.ToJson().State, 'active')
        assert.ok(!LiveLoopEntitlements.AdminIssuer.includes('pragmatic-tech.ai'), 'never the platform central realm')
    })

    it('POSTs the statement to the link route with the bearer the console derives from the shared secret file', async () =>
    {
        const dir = mkdtempSync(join(tmpdir(), 'entitlements-link-'))
        try
        {
            const secretFile = join(dir, LinkFx.SecretFileName)
            writeFileSync(secretFile, LinkFx.Secret)
            const statement = LiveLoopEntitlements.Statement(LinkFx.ClientId, LinkFx.ClientName, LinkFx.IssuedAt)
            const link = LiveLoopEntitlements.FromSecretFile(console_.Base, secretFile)
            assert.equal(await link.PostStatement(statement), LinkFx.Ok)
            assert.equal(EntitlementsLink.CredentialFromSecret(LinkFx.Secret).AuthorizationValue(), LinkFx.KnownBearer)
            assert.deepEqual(console_.Requests, [{ method: LinkFx.Post, path: EntitlementsLink.StatementsPath, authorization: LinkFx.KnownBearer, body: statement.ToJson() }])
            console_.Status = LinkFx.Unauthorized
            assert.equal(await link.PostStatement(statement), LinkFx.Unauthorized)
        }
        finally
        {
            console_.Status = LinkFx.Ok
            rmSync(dir, { recursive: true, force: true })
        }
    })
})
