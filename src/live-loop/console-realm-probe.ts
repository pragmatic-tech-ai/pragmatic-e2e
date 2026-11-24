import { readFileSync } from 'node:fs'
import { request } from 'node:https'

/** How long `WaitForIssuer` keeps asking, and how often. */
export type RealmProbeTiming = { readonly TimeoutMs: number; readonly PollMs: number }

/**
 * Reads the tenant console's desktop lookup (`GET <origin>/desktop/console`, no Origin header, as Plexus does) over the
 * stack's TLS front and answers the realm issuer it names for desktop sign-in (E spec S4), and checks the issuer's own
 * discovery answers over the CA bundle Plexus will trust. `up` fails in realm mode when the console names none within the
 * wait, so a stack that would silently run the transitional path is never handed to the spec.
 */
export class ConsoleRealmProbe
{
    public static readonly ConsolePath = '/desktop/console'
    public static readonly DiscoverySuffix = '/.well-known/openid-configuration'
    /** Past the console's 30 s cache of a failed realm probe (pragmatic-tenant-plane DesktopRealmSignIn.FailedProbeTtlMs). */
    public static readonly DefaultTiming: RealmProbeTiming = { TimeoutMs: 90_000, PollMs: 2_000 }
    public static readonly NoSignInMessage = 'the tenant console names no realm sign-in in /desktop/console (realm mode needs E.s S1-S4 in the images and the console)'
    public static readonly FailedPrefix = 'the tenant console lookup failed: '
    public static readonly DiscoveryFailedPrefix = 'the realm the console names does not answer over the desktop CA bundle: '
    private static readonly MethodGet = 'GET'
    private static readonly AcceptHeader = 'accept'
    private static readonly JsonType = 'application/json'
    private static readonly StatusOk = 200
    private static readonly RequestTimeoutMs = 15_000
    private static readonly Utf8 = 'utf8'
    private static readonly DataEvent = 'data'
    private static readonly EndEvent = 'end'
    private static readonly ErrorEvent = 'error'
    private static readonly TimeoutEvent = 'timeout'
    private static readonly TimedOut = 'timed out'
    private static readonly SignInField = 'signIn'
    private static readonly IssuerField = 'issuer'
    private static readonly TrailingSlashes = /\/+$/
    private static readonly NoText = ''

    /** The realm issuer the console at `origin` names; `caFile` is the CA its TLS front's certificate chains to. One read. */
    public static async IssuerOf(origin: string, caFile: string): Promise<string>
    {
        const P = ConsoleRealmProbe
        const body = await P.Get(new URL(P.ConsolePath, origin), readFileSync(caFile, P.Utf8), P.FailedPrefix)
        const issuer = P.Field(P.Field(body, P.SignInField), P.IssuerField)
        if (typeof issuer !== 'string' || issuer === P.NoText)
        {
            throw new Error(P.NoSignInMessage)
        }
        return issuer
    }

    /**
     * `IssuerOf`, asked again every `PollMs` until it answers or `TimeoutMs` has passed; then its last failure. Worst case:
     * `TimeoutMs` plus one last request's own 15 s timeout (RequestTimeoutMs), so about 105 s with DefaultTiming.
     */
    public static async WaitForIssuer(origin: string, caFile: string, timing: RealmProbeTiming = ConsoleRealmProbe.DefaultTiming): Promise<string>
    {
        const deadline = Date.now() + timing.TimeoutMs
        for (;;)
        {
            try
            {
                return await ConsoleRealmProbe.IssuerOf(origin, caFile)
            }
            catch (err)
            {
                if (Date.now() + timing.PollMs > deadline)
                {
                    throw err
                }
            }
            await new Promise<void>(res => setTimeout(res, timing.PollMs))
        }
    }

    /** Throws unless `<issuer>/.well-known/openid-configuration` answers that issuer over TLS trusting only `caBundle`. */
    public static async CheckDiscovery(issuer: string, caBundle: string): Promise<void>
    {
        const P = ConsoleRealmProbe
        const doc = await P.Get(new URL(issuer.replace(P.TrailingSlashes, P.NoText) + P.DiscoverySuffix), caBundle, P.DiscoveryFailedPrefix)
        if (P.Field(doc, P.IssuerField) !== issuer)
        {
            throw new Error(P.DiscoveryFailedPrefix + P.IssuerField)
        }
    }

    private static Field(value: unknown, name: string): unknown
    {
        return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[name] : undefined
    }

    /** The error's code (ECONNREFUSED, a certificate error) when it has one, else its name. */
    private static ReasonOf(err: unknown): string
    {
        const code = (err as NodeJS.ErrnoException | undefined)?.code
        return typeof code === 'string' ? code : err instanceof Error ? err.name : typeof err
    }

    private static Get(url: URL, ca: string, failedPrefix: string): Promise<unknown>
    {
        const P = ConsoleRealmProbe
        return new Promise((resolve, reject) =>
        {
            const fail = (err: unknown): void => reject(err instanceof Error && err.message.startsWith(failedPrefix) ? err : new Error(failedPrefix + P.ReasonOf(err)))
            const req = request(url, { method: P.MethodGet, ca, headers: { [P.AcceptHeader]: P.JsonType }, timeout: P.RequestTimeoutMs }, res =>
            {
                const chunks: Buffer[] = []
                res.on(P.DataEvent, (c: Buffer) => chunks.push(c))
                res.on(P.ErrorEvent, fail)
                res.on(P.EndEvent, () =>
                {
                    if (res.statusCode !== P.StatusOk)
                    {
                        reject(new Error(failedPrefix + String(res.statusCode)))
                        return
                    }
                    try
                    {
                        resolve(JSON.parse(Buffer.concat(chunks).toString(P.Utf8)))
                    }
                    catch (err)
                    {
                        fail(err)
                    }
                })
            })
            req.on(P.TimeoutEvent, () => req.destroy(new Error(failedPrefix + P.TimedOut)))
            req.on(P.ErrorEvent, fail)
            req.end()
        })
    }
}
