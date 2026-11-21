/**
 * The live-loop stack's TLS front for the tenant plane (a stack service, started detached by `live-loop-stack.ts up`): an
 * HTTPS listener on loopback that relays every request, and connection upgrades, to the console's plain-HTTP tenant listener,
 * keeping the browser's Host and Origin. The tenant's realm sign-in service accepts a client's redirect only over HTTPS (or
 * HTTP on a loopback host), so the console's tenant origin is https://<tenant>.lvh.me:<front port>, served with a development
 * certificate the stack mints (the owner's headless browser accepts it; nothing else talks to this origin).
 *
 *   PRAGMATIC_E2E_TLS_FRONT_PORT=7443 PRAGMATIC_E2E_TLS_FRONT_TARGET_PORT=7100 PRAGMATIC_E2E_TLS_FRONT_CERT_FILE=… \
 *   PRAGMATIC_E2E_TLS_FRONT_KEY_FILE=… npx tsx src/live-loop/tenant-plane-tls-front.ts
 */
import { readFileSync } from 'node:fs'
import { request, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http'
import { createServer, type Server } from 'node:https'
import { connect, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Where the front listens and relays to, and its certificate files. */
export interface TlsFrontOptions
{
    listenPort: number
    targetPort: number
    certFile: string
    keyFile: string
}

export class TenantPlaneTlsFront
{
    public static readonly PortEnvVar = 'PRAGMATIC_E2E_TLS_FRONT_PORT'
    public static readonly TargetPortEnvVar = 'PRAGMATIC_E2E_TLS_FRONT_TARGET_PORT'
    public static readonly CertFileEnvVar = 'PRAGMATIC_E2E_TLS_FRONT_CERT_FILE'
    public static readonly KeyFileEnvVar = 'PRAGMATIC_E2E_TLS_FRONT_KEY_FILE'
    private static readonly Loopback = '127.0.0.1'
    private static readonly ForwardedProtoHeader = 'x-forwarded-proto'
    private static readonly ForwardedForHeader = 'x-forwarded-for'
    private static readonly ForwardedPrefix = 'x-forwarded-'
    private static readonly ForwardedHeader = 'forwarded'
    private static readonly CloseEvent = 'close'
    private static readonly ClientErrorEvent = 'clientError'
    private static readonly Https = 'https'
    private static readonly BadGatewayStatus = 502
    private static readonly BadGatewayBody = 'the tenant plane is not answering'
    private static readonly HttpVersion = ' HTTP/1.1\r\n'
    private static readonly HeaderSeparator = ': '
    private static readonly LineEnd = '\r\n'
    private static readonly Space = ' '
    private static readonly MissingSettingPrefix = 'TLS front: missing or invalid setting '
    private static readonly ListeningPrefix = '[tls-front] https://127.0.0.1:'
    private static readonly ListeningMiddle = ' -> http://127.0.0.1:'
    private static readonly ErrorEvent = 'error'
    private static readonly UpgradeEvent = 'upgrade'
    private static readonly Utf8 = 'utf8'

    private server: Server | undefined

    public constructor(private readonly options: TlsFrontOptions)
    {
    }

    /** The settings `env` names; throws naming the first missing or invalid one. */
    public static OptionsOf(env: NodeJS.ProcessEnv): TlsFrontOptions
    {
        const F = TenantPlaneTlsFront
        return {
            listenPort: F.PortOf(env, F.PortEnvVar),
            targetPort: F.PortOf(env, F.TargetPortEnvVar),
            certFile: F.FileOf(env, F.CertFileEnvVar),
            keyFile: F.FileOf(env, F.KeyFileEnvVar),
        }
    }

    /** Listens on loopback; answers the port it got (the configured one, or a free one for 0). */
    public Start(): Promise<number>
    {
        const F = TenantPlaneTlsFront
        const server = createServer({ cert: readFileSync(this.options.certFile), key: readFileSync(this.options.keyFile) }, (req, res) =>
        {
            const upstream = request({ host: F.Loopback, port: this.options.targetPort, method: req.method, path: req.url, headers: F.Forwarded(req) }, answer =>
            {
                res.writeHead(answer.statusCode ?? F.BadGatewayStatus, answer.headers)
                answer.on(F.ErrorEvent, () => res.destroy())
                answer.pipe(res)
            })
            upstream.on(F.ErrorEvent, () =>
            {
                if (res.headersSent)
                {
                    res.destroy()
                    return
                }
                res.writeHead(F.BadGatewayStatus)
                res.end(F.BadGatewayBody)
            })
            // A browser that goes away mid-request takes its upstream request with it.
            res.on(F.CloseEvent, () => upstream.destroy())
            res.on(F.ErrorEvent, () => upstream.destroy())
            req.pipe(upstream)
        })
        server.on(F.UpgradeEvent, (req: IncomingMessage, socket: Duplex, head: Buffer) => this.Relay(req, socket, head))
        server.on(F.ClientErrorEvent, (_err: Error, socket: Duplex) => socket.destroy())
        this.server = server
        return new Promise((done, fail) =>
        {
            server.once(F.ErrorEvent, fail)
            server.listen(this.options.listenPort, F.Loopback, () => done((server.address() as { port: number }).port))
        })
    }

    public Stop(): Promise<void>
    {
        return new Promise(done =>
        {
            if (this.server === undefined)
            {
                done()
                return
            }
            this.server.closeAllConnections()
            this.server.close(() => done())
        })
    }

    /** An upgrade (WebSocket) request: the same request line and headers to the tenant plane, then bytes both ways. */
    private Relay(req: IncomingMessage, socket: Duplex, head: Buffer): void
    {
        const F = TenantPlaneTlsFront
        const upstream: Socket = connect(this.options.targetPort, F.Loopback, () =>
        {
            const headers = F.Forwarded(req)
            const lines = Object.entries(headers).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map(v => name + F.HeaderSeparator + String(v)))
            upstream.write(req.method + F.Space + req.url + F.HttpVersion + lines.join(F.LineEnd) + F.LineEnd + F.LineEnd, F.Utf8)
            if (head.length > 0)
            {
                upstream.write(head)
            }
            upstream.pipe(socket)
            socket.pipe(upstream)
        })
        upstream.on(F.ErrorEvent, () => socket.destroy())
        upstream.on(F.CloseEvent, () => socket.destroy())
        socket.on(F.ErrorEvent, () => upstream.destroy())
        socket.on(F.CloseEvent, () => upstream.destroy())
    }

    /**
     * The browser's headers, Host and Origin included, with the forwarding headers this front vouches for in place of any the
     * client sent (the tenant listener trusts them): the scheme it used and its address.
     */
    public static Forwarded(req: IncomingMessage): OutgoingHttpHeaders
    {
        const F = TenantPlaneTlsFront
        const headers: OutgoingHttpHeaders = {}
        for (const [name, value] of Object.entries(req.headers))
        {
            if (!name.startsWith(F.ForwardedPrefix) && name !== F.ForwardedHeader)
            {
                headers[name] = value
            }
        }
        headers[F.ForwardedProtoHeader] = F.Https
        headers[F.ForwardedForHeader] = req.socket.remoteAddress ?? F.Loopback
        return headers
    }

    private static PortOf(env: NodeJS.ProcessEnv, name: string): number
    {
        const port = Number(env[name])
        if (!Number.isInteger(port) || port <= 0 || port > 65_535)
        {
            throw new Error(TenantPlaneTlsFront.MissingSettingPrefix + name)
        }
        return port
    }

    private static FileOf(env: NodeJS.ProcessEnv, name: string): string
    {
        const file = env[name]?.trim() ?? ''
        if (file === '')
        {
            throw new Error(TenantPlaneTlsFront.MissingSettingPrefix + name)
        }
        return file
    }

    public static async Main(): Promise<void>
    {
        const F = TenantPlaneTlsFront
        const options = F.OptionsOf(process.env)
        const port = await new TenantPlaneTlsFront(options).Start()
        console.log(F.ListeningPrefix + String(port) + F.ListeningMiddle + String(options.targetPort))
    }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    TenantPlaneTlsFront.Main().catch(err =>
    {
        console.error((err as Error).message)
        process.exitCode = 1
    })
}
