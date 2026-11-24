import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConsoleRealmProbe, type RealmProbeTiming } from './console-realm-probe.js'

/** Realm mode: the issuer the console names, and the CA bundle Plexus trusts for the TLS front and the IdP. */
export type LiveLoopRealmSignIn = { readonly realmIssuer: string; readonly desktopCaFile: string }

/** What the realm leg of `up` reads: the console's origin, and each TLS server's CA and certificate (front, IdP). */
export type LiveLoopRealmFiles = {
    readonly Origin: string
    readonly FrontCaFile: string
    readonly FrontCertFile: string
    readonly IdpCaFile: string
    readonly IdpCertFile: string
    readonly StackDir: string
}

/**
 * Whether Plexus's main process (Electron, BoringSSL) can verify a chain Node (OpenSSL) accepts: BoringSSL refuses a
 * chain whose CA has any IP name-constraint subtree while the leaf names an IP address ("unsupported name constraint
 * type"), which OpenSSL checks. So `up` refuses such a pair instead of handing Plexus a stack it cannot sign in to.
 */
export class ElectronChainCheck
{
    public static readonly Openssl = 'openssl'
    private static readonly X509 = 'x509'
    private static readonly In = '-in'
    private static readonly NoOut = '-noout'
    private static readonly Ext = '-ext'
    private static readonly NameConstraints = 'nameConstraints'
    private static readonly Utf8 = 'utf8'
    private static readonly IpSubtree = /\bIP:/
    private static readonly IpSan = 'IP Address:'
    private static readonly RefusedPrefix = 'Plexus (Electron, BoringSSL) cannot verify this chain: its CA constrains IP names and the certificate names an IP: '

    /** The refusal for one CA and the leaf it issued, or undefined when Electron can verify it. */
    public static Refusal(caFile: string, leafFile: string, openssl: string = ElectronChainCheck.Openssl): string | undefined
    {
        const C = ElectronChainCheck
        const constraints = execFileSync(openssl, [C.X509, C.In, caFile, C.NoOut, C.Ext, C.NameConstraints], { encoding: C.Utf8 })
        const leafNamesIp = new X509Certificate(readFileSync(leafFile)).subjectAltName?.includes(C.IpSan) === true
        return C.IpSubtree.test(constraints) && leafNamesIp ? C.RefusedPrefix + leafFile : undefined
    }

    /** Throws the first refusal among `pairs` of [CA file, leaf file]. */
    public static Require(pairs: readonly (readonly [string, string])[], openssl: string = ElectronChainCheck.Openssl): void
    {
        for (const [caFile, leafFile] of pairs)
        {
            const refusal = ElectronChainCheck.Refusal(caFile, leafFile, openssl)
            if (refusal !== undefined)
            {
                throw new Error(refusal)
            }
        }
    }
}

/**
 * The realm leg of `up --sign-in realm`: the realm issuer the console names in /desktop/console (read through the TLS
 * front as Plexus will, waiting past the console's 30 s cache of a failed realm probe; ConsoleRealmProbe.WaitForIssuer),
 * the CA bundle Plexus's main process trusts for the front and the IdP (written to the stack folder), a check that
 * Electron can verify both chains, and that the issuer's discovery answers over that bundle.
 */
export class LiveLoopRealmSignInStep
{
    public static readonly DesktopCaFileName = 'desktop-ca.pem'
    private static readonly PemSeparator = '\n'
    private static readonly NoText = ''
    private static readonly Utf8 = 'utf8'

    public static async Resolve(files: LiveLoopRealmFiles, timing: RealmProbeTiming = ConsoleRealmProbe.DefaultTiming, openssl: string = ElectronChainCheck.Openssl): Promise<LiveLoopRealmSignIn>
    {
        const R = LiveLoopRealmSignInStep
        const realmIssuer = await ConsoleRealmProbe.WaitForIssuer(files.Origin, files.FrontCaFile, timing)
        ElectronChainCheck.Require([[files.FrontCaFile, files.FrontCertFile], [files.IdpCaFile, files.IdpCertFile]], openssl)
        const bundle = R.CaBundle([readFileSync(files.FrontCaFile, R.Utf8), readFileSync(files.IdpCaFile, R.Utf8)])
        const desktopCaFile = join(files.StackDir, R.DesktopCaFileName)
        writeFileSync(desktopCaFile, bundle, R.Utf8)
        await ConsoleRealmProbe.CheckDiscovery(realmIssuer, bundle)
        return { realmIssuer, desktopCaFile }
    }

    /** Pure: PEM certificates joined into one bundle, each ending in a newline. */
    public static CaBundle(pems: readonly string[]): string
    {
        const R = LiveLoopRealmSignInStep
        return pems.map(pem => pem.endsWith(R.PemSeparator) ? pem : pem + R.PemSeparator).join(R.NoText)
    }
}
