import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DevCa, type DevCaFiles } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import { ConsoleRealmProbe } from '../console-realm-probe.js'

/** The names and values the realm probe tests share. */
export class ProbeFx
{
    public static readonly RealmPath = '/realms/e2e'
    public static readonly ForeignIssuer = 'https://idp.example/realms/e2e'
    public static readonly TenantId = 'e2e'
    public static readonly TenantName = 'E2E'
    public static readonly ClientId = 'plexus'
    public static readonly Fast = { TimeoutMs: 1_000, PollMs: 20 }
    public static readonly Short = { TimeoutMs: 100, PollMs: 20 }
    public static readonly JsonHeaders = { 'content-type': 'application/json' }
    public static readonly LoopbackHost = '127.0.0.1'
    public static readonly Host = 'localhost'
    public static readonly OriginPrefix = 'https://localhost:'
    public static readonly ClosedOrigin = 'https://localhost:1'
    public static readonly StatusOk = 200
    public static readonly StatusNotFound = 404
    public static readonly Utf8 = 'utf8'
    public static readonly TlsDirName = 'tls'
    public static readonly TempPrefix = 'realm-probe-'

    public static Lookup(issuer?: string): unknown
    {
        const lookup = { tenantId: ProbeFx.TenantId, tenantName: ProbeFx.TenantName }
        return issuer === undefined ? lookup : { ...lookup, signIn: { issuer, clientId: ProbeFx.ClientId } }
    }
}

/** A console lookup and a realm discovery over TLS on loopback (DevCa, a certificate for localhost). */
export class ProbeConsole
{
    /** The lookup bodies answered in turn (the last repeats). */
    public Bodies: unknown[] = [{}]
    public Status = ProbeFx.StatusOk
    public DiscoveryIssuer: string | undefined
    public Origins: (string | undefined)[] = []
    public Lookups = 0
    public Origin = ''
    public Tls: DevCaFiles = { certFile: '', keyFile: '', caFile: '' }
    public Dir = ''
    private server: Server | undefined

    public get CaFile(): string
    {
        return this.Tls.caFile
    }

    public get Issuer(): string
    {
        return this.Origin + ProbeFx.RealmPath
    }

    public async Start(): Promise<void>
    {
        this.Dir = mkdtempSync(join(tmpdir(), ProbeFx.TempPrefix))
        this.Tls = DevCa.EnsureAt(join(this.Dir, ProbeFx.TlsDirName), ProbeFx.Host)
        const server = createServer({ cert: readFileSync(this.Tls.certFile), key: readFileSync(this.Tls.keyFile) }, (req, res) =>
        {
            if (req.url === ConsoleRealmProbe.ConsolePath)
            {
                this.Origins.push(req.headers.origin)
                const body = this.Bodies[Math.min(this.Lookups, this.Bodies.length - 1)]
                this.Lookups++
                res.writeHead(this.Status, ProbeFx.JsonHeaders).end(JSON.stringify(body))
                return
            }
            if (req.url === ProbeFx.RealmPath + ConsoleRealmProbe.DiscoverySuffix)
            {
                res.writeHead(ProbeFx.StatusOk, ProbeFx.JsonHeaders).end(JSON.stringify({ issuer: this.DiscoveryIssuer ?? this.Issuer }))
                return
            }
            res.writeHead(ProbeFx.StatusNotFound).end()
        })
        this.server = server
        await new Promise<void>(res => server.listen(0, ProbeFx.LoopbackHost, () => res()))
        this.Origin = ProbeFx.OriginPrefix + String((server.address() as AddressInfo).port)
    }

    public Reset(): void
    {
        this.Bodies = [{}]
        this.Status = ProbeFx.StatusOk
        this.DiscoveryIssuer = undefined
        this.Origins = []
        this.Lookups = 0
    }

    public async Stop(): Promise<void>
    {
        const server = this.server
        await new Promise<void>(res => server === undefined ? res() : server.close(() => res()))
        rmSync(this.Dir, { recursive: true, force: true })
    }
}
