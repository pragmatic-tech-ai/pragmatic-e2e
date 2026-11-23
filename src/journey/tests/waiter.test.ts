import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { LegAbort, WaitAbortError, WaitObservation, WaitTimeoutError, Waiter } from '../waiter.js'
import { FakeClock } from './journey-fakes.js'

describe('Waiter', () =>
{
    it('answers the value once the probe reports the condition met', async () =>
    {
        const clock = new FakeClock()
        let calls = 0
        const value = await new Waiter(clock, 1000).Until('three looks', async () =>
        {
            calls++
            return calls === 3 ? WaitObservation.Met(42, 'met') : WaitObservation.NotYet<number>('look ' + calls)
        }, 60_000)
        assert.equal(value, 42)
        assert.equal(calls, 3)
        assert.equal(clock.Slept, 2000, 'polls at its interval, no other sleep')
    })

    it('fails at the deadline naming the condition and the last observation', async () =>
    {
        const clock = new FakeClock()
        await assert.rejects(new Waiter(clock, 1000).Until('the subscription to turn Active', async () => WaitObservation.NotYet<boolean>('Waiting for payment'), 5000), (error: unknown) =>
        {
            assert.ok(error instanceof WaitTimeoutError)
            assert.equal(error.Condition, 'the subscription to turn Active')
            assert.equal(error.LastObserved, 'Waiting for payment')
            assert.match(error.message, /after 5 s; last observed: Waiting for payment/)
            return true
        })
        assert.equal(clock.Slept, 5000, 'never sleeps past the deadline')
    })

    it('a throwing probe counts as not yet, with its error as the observation', async () =>
    {
        const clock = new FakeClock()
        await assert.rejects(new Waiter(clock, 1000).Until('a page', async () =>
        {
            throw new Error('net::ERR_CONNECTION_RESET')
        }, 2000), /last observed: probe failed: net::ERR_CONNECTION_RESET/)
    })

    it('a tripped leg abort ends the wait at its next look, even while the probe only reports "not yet"', async () =>
    {
        const clock = new FakeClock()
        const abort = new LegAbort()
        let looks = 0
        await assert.rejects(new Waiter(clock, 1000, abort).Until('a closed page', async () =>
        {
            looks++
            abort.Trip()
            throw new Error('Target page, context or browser has been closed')
        }, 600_000), WaitAbortError)
        assert.equal(looks, 1)
        abort.Reset()
        assert.equal(await new Waiter(clock, 1000, abort).Until('after reset', async () => WaitObservation.Met(1, 'ok'), 1000), 1)
    })

    it('a wait started before the abort stays aborted after the reset for the clean', async () =>
    {
        const clock = new FakeClock()
        const abort = new LegAbort()
        let looks = 0
        const zombie = new Waiter(clock, 1000, abort).Until('a zombie wait', async () =>
        {
            looks++
            if (looks === 1)
            {
                abort.Trip()
                abort.Reset()
            }
            return WaitObservation.NotYet<boolean>('not yet')
        }, 600_000)
        await assert.rejects(zombie, WaitAbortError)
        assert.equal(abort.Aborted, false, 'the clean runs under a fresh token')
    })

    it('a WaitAbortError ends the wait at once', async () =>
    {
        const clock = new FakeClock()
        await assert.rejects(new Waiter(clock, 1000).Until('sign-up', async () =>
        {
            throw new WaitAbortError('the central login refused: An account with this email already exists. Sign in instead.')
        }, 60_000), /already exists/)
        assert.equal(clock.Slept, 0)
    })
})
