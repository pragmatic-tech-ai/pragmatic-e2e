import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, afterEach, before, describe, it } from 'node:test'
import { ConsoleRealmProbe } from '../console-realm-probe.js'
import { ProbeConsole, ProbeFx } from './realm-probe-console.js'

describe('ConsoleRealmProbe', () =>
{
    const target = new ProbeConsole()

    before(async () =>
    {
        await target.Start()
    })

    afterEach(() =>
    {
        target.Reset()
    })

    after(async () =>
    {
        await target.Stop()
    })

    it('answers the issuer the console names, asking without an Origin header', async () =>
    {
        target.Bodies = [ProbeFx.Lookup(ProbeFx.ForeignIssuer)]
        assert.equal(await ConsoleRealmProbe.IssuerOf(target.Origin, target.CaFile), ProbeFx.ForeignIssuer)
        assert.deepEqual(target.Origins, [undefined])
    })

    it('fails when the console names no realm sign-in, or the lookup fails', async () =>
    {
        target.Bodies = [ProbeFx.Lookup()]
        await assert.rejects(ConsoleRealmProbe.IssuerOf(target.Origin, target.CaFile), /names no realm sign-in/)
        target.Status = ProbeFx.StatusNotFound
        await assert.rejects(ConsoleRealmProbe.IssuerOf(target.Origin, target.CaFile), new RegExp('lookup failed: ' + String(ProbeFx.StatusNotFound)))
    })

    it('names the connection error by its code', async () =>
    {
        await assert.rejects(ConsoleRealmProbe.IssuerOf(ProbeFx.ClosedOrigin, target.CaFile), /lookup failed: ECONNREFUSED/)
    })

    it('waits while the console names no realm yet (its failed realm probe is cached), then answers it', async () =>
    {
        target.Bodies = [ProbeFx.Lookup(), ProbeFx.Lookup(), ProbeFx.Lookup(target.Issuer)]
        assert.equal(await ConsoleRealmProbe.WaitForIssuer(target.Origin, target.CaFile, ProbeFx.Fast), target.Issuer)
        assert.equal(target.Lookups, 3)
    })

    it('gives up with the last failure once the wait is over', async () =>
    {
        target.Bodies = [ProbeFx.Lookup()]
        await assert.rejects(ConsoleRealmProbe.WaitForIssuer(target.Origin, target.CaFile, ProbeFx.Short), /names no realm sign-in/)
        assert.ok(target.Lookups > 1, 'asked more than once')
    })

    it('checks the issuer\'s discovery answers that issuer over the bundle, and refuses another issuer or an untrusted chain', async () =>
    {
        const bundle = readFileSync(target.CaFile, ProbeFx.Utf8)
        await ConsoleRealmProbe.CheckDiscovery(target.Issuer, bundle)
        await assert.rejects(ConsoleRealmProbe.CheckDiscovery(target.Issuer + '/', bundle), /does not answer over the desktop CA bundle: issuer/, 'a trailing slash is another issuer')
        target.DiscoveryIssuer = ProbeFx.ForeignIssuer
        await assert.rejects(ConsoleRealmProbe.CheckDiscovery(target.Issuer, bundle), /does not answer over the desktop CA bundle: issuer/)
        target.DiscoveryIssuer = undefined
        await assert.rejects(ConsoleRealmProbe.CheckDiscovery(target.Issuer, ''), /does not answer over the desktop CA bundle: [A-Z_]+/)
    })
})
