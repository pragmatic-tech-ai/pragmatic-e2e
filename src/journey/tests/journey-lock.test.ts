import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { JourneyLock, JourneyLockHeldError, type IProcessProbe } from '../journey-lock.js'
import { FakeClock, TempFolder } from './journey-fakes.js'

class Processes implements IProcessProbe
{
    public readonly Alive = new Set<number>()

    public IsAlive(pid: number): boolean
    {
        return this.Alive.has(pid)
    }
}

describe('JourneyLock', () =>
{
    it('refuses a second process while the holder lives; only the holder releases it', () =>
    {
        const folder = new TempFolder()
        const clock = new FakeClock()
        const processes = new Processes()
        processes.Alive.add(100)
        const file = join(folder.Path, 'journey', 'lock')
        const first = new JourneyLock(file, clock, processes, 100)
        first.Acquire('run-a1')
        assert.throws(() => new JourneyLock(file, clock, processes, 200).Acquire('run-b2'), (error: unknown) => error instanceof JourneyLockHeldError && error.HolderRunId === 'run-a1')
        new JourneyLock(file, clock, processes, 200).Release()
        assert.equal(existsSync(file), true, 'a process that does not hold the lock cannot release it')
        first.Release()
        assert.equal(existsSync(file), false)
        new JourneyLock(file, clock, processes, 200).Acquire('run-b2')
        folder.Dispose()
    })

    it('a clean of the same run is refused while the run\'s process lives, and admitted once it is gone', () =>
    {
        const folder = new TempFolder()
        const clock = new FakeClock()
        const processes = new Processes()
        processes.Alive.add(100)
        const file = join(folder.Path, 'lock')
        new JourneyLock(file, clock, processes, 100).Acquire('run-a1')
        assert.throws(() => new JourneyLock(file, clock, processes, 300).Acquire('run-a1'), JourneyLockHeldError)
        processes.Alive.delete(100)
        new JourneyLock(file, clock, processes, 300).Acquire('run-a1')
        folder.Dispose()
    })

    it('takes over a stale lock (older than 3 h) even with a live pid, and an unreadable one', () =>
    {
        const folder = new TempFolder()
        const clock = new FakeClock()
        const processes = new Processes()
        processes.Alive.add(100)
        processes.Alive.add(200)
        const file = join(folder.Path, 'lock')
        new JourneyLock(file, clock, processes, 100).Acquire('run-a1')
        clock.Time += JourneyLock.StaleAfterMs + 1
        new JourneyLock(file, clock, processes, 200).Acquire('run-b2')
        assert.throws(() => new JourneyLock(file, clock, processes, 300).Acquire('run-c3'), JourneyLockHeldError)
        writeFileSync(file, '{half')
        new JourneyLock(file, clock, processes, 300).Acquire('run-c3')
        folder.Dispose()
    })
})
