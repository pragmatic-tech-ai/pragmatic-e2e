import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JourneyContext } from '../journey-context.js'
import { JourneyPath } from '../journey-path.js'
import { TempFolder } from './journey-fakes.js'

describe('JourneyContext', () =>
{
    it('refuses keys that name a secret', () =>
    {
        const context = new JourneyContext('run-0001', JourneyPath.Hosted)
        for (const key of ['password', 'customerPassword', 'idToken', 'sessionCookie', 'ownerOtp', 'oobCode', 'passwordSeed', 'cardNumber', 'invitationCode', 'webhookSecret', 'bearer', 'session'])
        {
            assert.throws(() => context.Set(key, 'x'), /holds no secrets; refused key/, key)
        }
    })

    it('refuses token-shaped values under any key', () =>
    {
        const context = new JourneyContext('run-0001', JourneyPath.Hosted)
        assert.throws(() => context.Set('note', 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig'), /token-shaped value/)
        assert.throws(() => context.Set('note', 'Bearer abc'), /token-shaped value/)
        assert.throws(() => context.Set('note', '4242 4242 4242 4242'), /token-shaped value/)
    })

    it('saves and loads ids and leg progress; refuses a file of another run', () =>
    {
        const folder = new TempFolder()
        const file = join(folder.Path, 'enrolled', 'context.json')
        const context = new JourneyContext('run-0001', JourneyPath.Enrolled)
        context.Set('clientName', 'journey-run-0001')
        context.MarkStarted('visit')
        context.MarkCompleted('visit')
        context.MarkStarted('register')
        context.Save(file)
        const loaded = JourneyContext.Load(file, 'run-0001', JourneyPath.Enrolled)
        assert.equal(loaded.Require('clientName'), 'journey-run-0001')
        assert.equal(loaded.IsCompleted('visit'), true)
        assert.deepEqual(loaded.StartedLegs(), ['visit', 'register'])
        assert.throws(() => JourneyContext.Load(file, 'run-0002', JourneyPath.Enrolled), /another run/)
        assert.doesNotMatch(readFileSync(file, 'utf8'), /password/i)
        folder.Dispose()
    })

    it('MarkCleaned forgets a leg; Require names a missing key; run ids are checked', () =>
    {
        const context = new JourneyContext('run-0001', JourneyPath.Enrolled)
        context.MarkStarted('a')
        context.MarkCompleted('a')
        context.MarkCleaned('a')
        assert.equal(context.IsStarted('a'), false)
        assert.equal(context.IsCompleted('a'), false)
        assert.throws(() => context.Require('clientName'), /no value for: clientName/)
        assert.throws(() => new JourneyContext('../etc', JourneyPath.Enrolled), /run id/)
    })
})
