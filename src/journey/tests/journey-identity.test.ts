import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { JourneyPath } from '../journey-path.js'
import { JourneyIdentity } from '../live/journey-identity.js'

describe('JourneyIdentity', () =>
{
    it('derives a fixed address per path and a stable, seed-bound password', () =>
    {
        const seed = 'x'.repeat(40)
        const a = new JourneyIdentity(JourneyPath.Enrolled, 'pragmatic-lab.com', seed)
        const b = new JourneyIdentity(JourneyPath.Enrolled, 'pragmatic-lab.com', seed)
        const other = new JourneyIdentity(JourneyPath.Hosted, 'pragmatic-lab.com', seed)
        const otherSeed = new JourneyIdentity(JourneyPath.Enrolled, 'pragmatic-lab.com', 'y'.repeat(40))
        assert.equal(a.Email, 'journey-enrolled@pragmatic-lab.com')
        assert.equal(a.Password, b.Password)
        assert.notEqual(a.Password, other.Password)
        assert.notEqual(a.Password, otherSeed.Password)
        assert.match(a.Password, /^[A-Za-z0-9_-]{24}aA1!$/)
        assert.ok(!a.Password.includes(seed.slice(0, 8)))
        assert.throws(() => new JourneyIdentity(JourneyPath.Enrolled, 'pragmatic-lab.com', 'short'), /too short/)
    })
})
