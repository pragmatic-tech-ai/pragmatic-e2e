import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, before, describe, it } from 'node:test'
import { ElectronChainCheck, LiveLoopRealmSignInStep } from '../live-loop-realm-sign-in.js'
import { ProbeConsole, ProbeFx } from './realm-probe-console.js'

/** A CA and leaf minted the way a pre-0.18.13 DevCa did: a permitted IP subtree, and the loopback IP in the leaf. */
class LegacyChainFx
{
    public static readonly Openssl = 'openssl'
    public static readonly Host = 'e2e.lvh.me'
    public static readonly CaFileName = 'legacy-ca.crt'
    public static readonly CaKeyFileName = 'legacy-ca.key'
    public static readonly LeafFileName = 'legacy-leaf.crt'
    public static readonly LeafKeyFileName = 'legacy-leaf.key'
    public static readonly CsrFileName = 'legacy-leaf.csr'
    public static readonly ExtFileName = 'legacy-leaf.ext'
    public static readonly Constraints = 'nameConstraints=critical,permitted;DNS:e2e.lvh.me,permitted;IP:127.0.0.1/255.255.255.255'
    public static readonly LeafSan = 'subjectAltName=DNS:e2e.lvh.me,IP:127.0.0.1\n'
    public static readonly CaSubject = '/CN=legacy-ca'
    public static readonly LeafSubject = '/CN=e2e.lvh.me'

    /** Mints the pair in `dir`; answers [CA file, leaf file]. */
    public static Mint(dir: string): readonly [string, string]
    {
        const F = LegacyChainFx
        const at = (name: string): string => join(dir, name)
        const key = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes']
        execFileSync(F.Openssl, ['req', '-x509', ...key, '-keyout', at(F.CaKeyFileName), '-out', at(F.CaFileName), '-days', '1', '-subj', F.CaSubject,
            '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign', '-addext', F.Constraints], { stdio: 'pipe' })
        execFileSync(F.Openssl, ['req', ...key, '-keyout', at(F.LeafKeyFileName), '-out', at(F.CsrFileName), '-subj', F.LeafSubject], { stdio: 'pipe' })
        writeFileSync(at(F.ExtFileName), F.LeafSan)
        execFileSync(F.Openssl, ['x509', '-req', '-in', at(F.CsrFileName), '-CA', at(F.CaFileName), '-CAkey', at(F.CaKeyFileName), '-CAcreateserial',
            '-out', at(F.LeafFileName), '-days', '1', '-extfile', at(F.ExtFileName)], { stdio: 'pipe' })
        return [at(F.CaFileName), at(F.LeafFileName)]
    }
}

class RealmStepFx
{
    public static readonly TempPrefix = 'realm-step-'
    public static readonly Pem = 'A\n'
    public static readonly PemNoNewline = 'B'
}

describe('ElectronChainCheck', () =>
{
    it('refuses a chain whose CA has an IP subtree while the leaf names an IP (a pre-0.18.13 DevCa)', () =>
    {
        const dir = mkdtempSync(join(tmpdir(), RealmStepFx.TempPrefix))
        try
        {
            const [legacyCa, legacyLeaf] = LegacyChainFx.Mint(dir)
            assert.match(ElectronChainCheck.Refusal(legacyCa, legacyLeaf) ?? '', /cannot verify this chain/)
            assert.throws(() => ElectronChainCheck.Require([[legacyCa, legacyLeaf]]), /constrains IP names and the certificate names an IP/)
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})

describe('LiveLoopRealmSignInStep', () =>
{
    const target = new ProbeConsole()
    let stackDir = ''

    before(async () =>
    {
        await target.Start()
    })

    afterEach(() =>
    {
        target.Reset()
        rmSync(stackDir, { recursive: true, force: true })
    })

    after(async () =>
    {
        await target.Stop()
    })

    const files = (idpCa: string, idpCert: string) => ({ Origin: target.Origin, FrontCaFile: target.CaFile, FrontCertFile: target.Tls.certFile, IdpCaFile: idpCa, IdpCertFile: idpCert, StackDir: stackDir })

    it('answers the realm the console names and writes the bundle Plexus trusts (front CA, then IdP CA)', async () =>
    {
        stackDir = mkdtempSync(join(tmpdir(), RealmStepFx.TempPrefix))
        target.Bodies = [ProbeFx.Lookup(), ProbeFx.Lookup(target.Issuer)]
        assert.equal(ElectronChainCheck.Refusal(target.CaFile, target.Tls.certFile), undefined, 'a DevCa chain is one Electron verifies')
        const realm = await LiveLoopRealmSignInStep.Resolve(files(target.CaFile, target.Tls.certFile), ProbeFx.Fast)
        const ca = readFileSync(target.CaFile, ProbeFx.Utf8)
        assert.deepEqual(realm, { realmIssuer: target.Issuer, desktopCaFile: join(stackDir, LiveLoopRealmSignInStep.DesktopCaFileName) })
        assert.equal(readFileSync(realm.desktopCaFile, ProbeFx.Utf8), LiveLoopRealmSignInStep.CaBundle([ca, ca]))
    })

    it('refuses an IdP chain Electron cannot verify before writing anything', async () =>
    {
        stackDir = mkdtempSync(join(tmpdir(), RealmStepFx.TempPrefix))
        target.Bodies = [ProbeFx.Lookup(target.Issuer)]
        const [legacyCa, legacyLeaf] = LegacyChainFx.Mint(stackDir)
        await assert.rejects(LiveLoopRealmSignInStep.Resolve(files(legacyCa, legacyLeaf), ProbeFx.Fast), /cannot verify this chain/)
    })

    it('fails when the console never names a realm within the wait', async () =>
    {
        stackDir = mkdtempSync(join(tmpdir(), RealmStepFx.TempPrefix))
        target.Bodies = [ProbeFx.Lookup()]
        await assert.rejects(LiveLoopRealmSignInStep.Resolve(files(target.CaFile, target.Tls.certFile), ProbeFx.Short), /names no realm sign-in/)
    })

    it('joins the CA bundle one certificate after another', () =>
    {
        assert.equal(LiveLoopRealmSignInStep.CaBundle([RealmStepFx.Pem, RealmStepFx.PemNoNewline]), 'A\nB\n')
    })
})
