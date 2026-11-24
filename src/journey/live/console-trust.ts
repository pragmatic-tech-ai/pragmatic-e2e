import { createHash, X509Certificate } from 'node:crypto'
import { connect } from 'node:tls'

/** Checks the engine console's certificate chain; a fake in leg tests. */
export interface IConsoleTrust
{
    /**
     * Connects to each host (`<host>:<port>`, resolving locally) trusting only `caPem`, refuses a chain that does not
     * verify to it or does not name the host, and answers the SPKI pins (base64 SHA-256) of the certificates served.
     */
    Pins(hosts: readonly string[], port: number, caPem: string): Promise<string[]>
}

/**
 * The engine's self-signed console, trusted the way an operator would: the chain is verified in Node against the
 * engine's own development CA read from the cluster (Secret pragmatic-tls-dev-ca, the bundle E31 hands Plexus), and the
 * browser then accepts exactly the certificate keys that verified (Chromium's SPKI pin list), nothing else.
 */
export class ConsoleTrust implements IConsoleTrust
{
    private static readonly Loopback = '127.0.0.1'
    private static readonly Spki = 'spki'
    private static readonly Der = 'der'
    private static readonly Sha256 = 'sha256'
    private static readonly Base64 = 'base64'
    private static readonly TimeoutMs = 15_000
    private static readonly Untrusted = 'the engine console does not chain to the engine\'s development CA: '
    private static readonly TimedOut = 'the engine console did not answer the TLS check: '
    private static readonly Separator = ': '
    private static readonly TimeoutEvent = 'timeout'
    private static readonly ErrorEvent = 'error'

    public async Pins(hosts: readonly string[], port: number, caPem: string): Promise<string[]>
    {
        const pins: string[] = []
        for (const host of hosts)
        {
            const pin = await this.PinOf(host, port, caPem)
            if (!pins.includes(pin))
            {
                pins.push(pin)
            }
        }
        return pins
    }

    /** The SPKI pin of a DER certificate. */
    public static PinOfCertificate(der: Buffer): string
    {
        const C = ConsoleTrust
        const spki = new X509Certificate(der).publicKey.export({ type: C.Spki, format: C.Der })
        return createHash(C.Sha256).update(spki).digest(C.Base64)
    }

    private PinOf(host: string, port: number, caPem: string): Promise<string>
    {
        const C = ConsoleTrust
        return new Promise((resolve, reject) =>
        {
            const socket = connect({ host: C.Loopback, port, servername: host, ca: caPem, rejectUnauthorized: true, timeout: C.TimeoutMs }, () =>
            {
                const served = socket.getPeerCertificate(false)
                socket.destroy()
                resolve(C.PinOfCertificate(served.raw))
            })
            socket.on(C.TimeoutEvent, () =>
            {
                socket.destroy()
                reject(new Error(C.TimedOut + host))
            })
            socket.on(C.ErrorEvent, error => reject(new Error(C.Untrusted + host + C.Separator + error.message)))
        })
    }
}
