import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { JourneyContext } from '../journey-context.js'
import { JourneyDependency } from '../journey-dependency.js'
import type { IJourneyLeg } from '../journey-leg.js'
import { JourneyPath } from '../journey-path.js'
import { CleanStatus, JourneyReport, LegStatus } from '../journey-report.js'
import { Journey, JourneyStop, type IJourneyContextStore, type ILegSupervisor } from '../journey.js'
import { LegAbort } from '../waiter.js'
import { FakeClock, TestEvidence } from './journey-fakes.js'

class RecordingLeg implements IJourneyLeg
{
    public DeadlineMs = 10_000

    public constructor(
        public readonly Name: string,
        private readonly log: string[],
        public readonly Dependencies: readonly JourneyDependency[] = [],
        private readonly failRun: boolean = false,
        private readonly failClean: boolean = false,
        private readonly hang: boolean = false)
    {
    }

    public async Run(context: JourneyContext): Promise<void>
    {
        this.log.push('run ' + this.Name)
        context.Set(this.Name + 'Id', 'id-' + this.Name)
        if (this.hang)
        {
            await new Promise(() => undefined)
        }
        if (this.failRun)
        {
            throw new Error('boom in ' + this.Name + ' with secret pw-0123456789')
        }
    }

    public async Clean(_context: JourneyContext): Promise<void>
    {
        this.log.push('clean ' + this.Name)
        if (this.failClean)
        {
            throw new Error('clean boom in ' + this.Name)
        }
    }
}

class MemoryStore implements IJourneyContextStore
{
    public readonly Saves: string[][] = []

    public Save(context: JourneyContext): void
    {
        this.Saves.push([...context.StartedLegs()])
    }
}

class CountingCapture implements ILegSupervisor
{
    public readonly Captured: string[] = []
    public Aborts = 0
    public OnAbort: () => void = () => undefined

    public async Capture(leg: string): Promise<readonly string[]>
    {
        this.Captured.push(leg)
        return []
    }

    public async Abort(): Promise<void>
    {
        this.Aborts++
        this.OnAbort()
    }
}

class Harness
{
    public readonly Log: string[] = []
    public readonly Store = new MemoryStore()
    public readonly Capture = new CountingCapture()
    public readonly Evidence = new TestEvidence()
    public readonly Report = new JourneyReport('run-0001')
    public readonly Context = new JourneyContext('run-0001', JourneyPath.Enrolled)
    public readonly Stop = new JourneyStop()

    public Journey(legs: IJourneyLeg[], live: JourneyDependency[] = Object.values(JourneyDependency)): Journey
    {
        this.Evidence.Filter.AddSecret('pw-0123456789')
        return new Journey(legs, new Set(live), this.Report, this.Evidence.Evidence, this.Store, this.Capture, this.Stop, new LegAbort(), new FakeClock(), 50)
    }

    public Statuses(): string[]
    {
        return this.Report.Legs(JourneyPath.Enrolled).map(outcome => outcome.Leg + ':' + outcome.Status)
    }
}

describe('Journey', () =>
{
    it('runs the legs in order, then cleans every started leg in reverse', async () =>
    {
        const h = new Harness()
        const ok = await h.Journey([new RecordingLeg('a', h.Log), new RecordingLeg('b', h.Log), new RecordingLeg('c', h.Log)]).Run(h.Context)
        assert.equal(ok, true)
        assert.deepEqual(h.Log, ['run a', 'run b', 'run c', 'clean c', 'clean b', 'clean a'])
        assert.deepEqual(h.Statuses(), ['a:passed', 'b:passed', 'c:passed'])
        assert.deepEqual(h.Report.Cleans(JourneyPath.Enrolled).map(c => c.Status), [CleanStatus.Cleaned, CleanStatus.Cleaned, CleanStatus.Cleaned])
        assert.deepEqual(h.Context.StartedLegs(), [])
        h.Evidence.Folder.Dispose()
    })

    it('a failure stops later legs, captures evidence, and clean runs in reverse for the started ones, the failed one included', async () =>
    {
        const h = new Harness()
        const ok = await h.Journey([new RecordingLeg('a', h.Log), new RecordingLeg('b', h.Log, [], true), new RecordingLeg('c', h.Log)]).Run(h.Context)
        assert.equal(ok, false)
        assert.deepEqual(h.Log, ['run a', 'run b', 'clean b', 'clean a'])
        assert.deepEqual(h.Statuses(), ['a:passed', 'b:failed', 'c:not-run'])
        assert.deepEqual(h.Capture.Captured, ['b'])
        assert.match(h.Report.Legs(JourneyPath.Enrolled)[2].Detail, /the leg before it failed \(b\)/)
        const failed = h.Report.Legs(JourneyPath.Enrolled)[1]
        assert.match(failed.Detail, /boom in b/)
        assert.doesNotMatch(failed.Detail, /pw-0123456789/, 'a registered secret is redacted from the report')
        h.Evidence.Folder.Dispose()
    })

    it('after a failing clean the older legs are not cleaned (their state may be what the retry needs) and stay started', async () =>
    {
        const h = new Harness()
        const ok = await h.Journey([new RecordingLeg('a', h.Log), new RecordingLeg('b', h.Log, [], false, true)]).Run(h.Context)
        assert.equal(ok, false)
        assert.deepEqual(h.Log, ['run a', 'run b', 'clean b'])
        assert.deepEqual(h.Report.Cleans(JourneyPath.Enrolled).map(c => c.Leg + ':' + c.Status), ['b:clean-failed', 'a:clean-skipped'])
        assert.deepEqual(h.Context.StartedLegs(), ['a', 'b'], 'journey clean can retry both')
        assert.equal(h.Report.Succeeded, false)
        h.Evidence.Folder.Dispose()
    })

    it('a started leg the journey does not know is a failed clean, not silently skipped', async () =>
    {
        const h = new Harness()
        h.Context.MarkStarted('ghost')
        const ok = await h.Journey([new RecordingLeg('a', h.Log)]).Clean(h.Context)
        assert.equal(ok, false)
        assert.deepEqual(h.Report.Cleans(JourneyPath.Enrolled).map(c => c.Leg + ':' + c.Status), ['ghost:clean-failed'])
        h.Evidence.Folder.Dispose()
    })

    it('a stop request aborts the running leg, lets it settle, runs no later leg, and still cleans', async () =>
    {
        const h = new Harness()
        let release: () => void = () => undefined
        const settled: string[] = []
        const hanging: IJourneyLeg = {
            Name: 'a', Dependencies: [], DeadlineMs: 60_000,
            Run: async () =>
            {
                await new Promise<void>(resolve => { release = resolve })
                settled.push('run a settled')
                throw new Error('page closed')
            },
            Clean: async () =>
            {
                settled.push('clean a')
            },
        }
        h.Capture.OnAbort = () => release()
        const journey = h.Journey([hanging, new RecordingLeg('b', h.Log)])
        setTimeout(() => h.Stop.Stop('stopped by SIGTERM'), 5)
        const ok = await journey.Run(h.Context)
        assert.equal(ok, false)
        assert.equal(h.Capture.Aborts, 1)
        assert.deepEqual(settled, ['run a settled', 'clean a'], 'the clean starts only after the aborted Run settled')
        assert.deepEqual(h.Statuses(), ['a:failed', 'b:not-run'])
        assert.match(h.Report.Legs(JourneyPath.Enrolled)[0].Detail, /run stopped: stopped by SIGTERM/)
        assert.deepEqual(h.Capture.Captured, [], 'no screenshot of a page the abort closed')
        h.Evidence.Folder.Dispose()
    })

    it('a leg whose dependency is not live is pending (naming what delivers it) and later legs do not run', async () =>
    {
        const h = new Harness()
        const legs = [new RecordingLeg('a', h.Log), new RecordingLeg('b', h.Log, [JourneyDependency.EntitlementDelivery]), new RecordingLeg('c', h.Log)]
        const ok = await h.Journey(legs, [JourneyDependency.Cabinet]).Run(h.Context)
        assert.equal(ok, true, 'pending legs do not fail the run')
        assert.deepEqual(h.Statuses(), ['a:passed', 'b:pending', 'c:not-run'])
        assert.match(h.Report.Legs(JourneyPath.Enrolled)[1].Detail, /entitlement-delivery: D4 Task 8/)
        assert.match(h.Report.Legs(JourneyPath.Enrolled)[2].Detail, /waits on the pending leg \(b\)/)
        assert.deepEqual(h.Log, ['run a', 'clean a'])
        h.Evidence.Folder.Dispose()
    })

    it('resume skips the legs an earlier invocation completed', async () =>
    {
        const h = new Harness()
        h.Context.MarkStarted('a')
        h.Context.MarkCompleted('a')
        const ok = await h.Journey([new RecordingLeg('a', h.Log), new RecordingLeg('b', h.Log)]).Run(h.Context)
        assert.equal(ok, true)
        assert.deepEqual(h.Statuses(), ['a:resumed', 'b:passed'])
        assert.deepEqual(h.Log, ['run b', 'clean b', 'clean a'], 'the resumed leg is still cleaned')
        h.Evidence.Folder.Dispose()
    })

    it('Clean alone cleans the started legs of a killed run, newest first', async () =>
    {
        const h = new Harness()
        h.Context.MarkStarted('a')
        h.Context.MarkCompleted('a')
        h.Context.MarkStarted('b')
        const ok = await h.Journey([new RecordingLeg('a', h.Log), new RecordingLeg('b', h.Log), new RecordingLeg('c', h.Log)]).Clean(h.Context)
        assert.equal(ok, true)
        assert.deepEqual(h.Log, ['clean b', 'clean a'])
        h.Evidence.Folder.Dispose()
    })

    it('a run interrupted after each leg is cleaned from its saved context alone', async () =>
    {
        for (let killedAfter = 1; killedAfter <= 3; killedAfter++)
        {
            const h = new Harness()
            const names = ['a', 'b', 'c']
            for (const name of names.slice(0, killedAfter))
            {
                h.Context.MarkStarted(name)
            }
            const log: string[] = []
            const ok = await h.Journey(names.map(name => new RecordingLeg(name, log))).Clean(h.Context)
            assert.equal(ok, true)
            assert.deepEqual(log, names.slice(0, killedAfter).reverse().map(name => 'clean ' + name))
            assert.deepEqual(h.Context.StartedLegs(), [])
            h.Evidence.Folder.Dispose()
        }
    })

    it('saves the context before and after each leg, so a killed run leaves the started leg on file', async () =>
    {
        const h = new Harness()
        await h.Journey([new RecordingLeg('a', h.Log)]).Run(h.Context)
        assert.deepEqual(h.Store.Saves[0], ['a'], 'saved as started before Run')
        h.Evidence.Folder.Dispose()
    })

    it('a leg past its deadline fails with the deadline and is cleaned', async () =>
    {
        const h = new Harness()
        const hanging = new RecordingLeg('a', h.Log, [], false, false, true)
        hanging.DeadlineMs = 20
        const ok = await h.Journey([hanging]).Run(h.Context)
        assert.equal(ok, false)
        assert.match(h.Report.Legs(JourneyPath.Enrolled)[0].Detail, /did not finish within/)
        assert.deepEqual(h.Log, ['run a', 'clean a'])
        h.Evidence.Folder.Dispose()
    })

    it('the report serialises per path and renders a Markdown table', async () =>
    {
        const h = new Harness()
        await h.Journey([new RecordingLeg('a', h.Log)]).Run(h.Context)
        const json = h.Report.ToJson() as { RunId: string, Succeeded: boolean, Paths: Array<{ Path: string }> }
        assert.equal(json.RunId, 'run-0001')
        assert.equal(json.Succeeded, true)
        assert.deepEqual(json.Paths.map(p => p.Path), ['enrolled'])
        assert.match(h.Report.ToMarkdown(), /\| a \| passed \|/)
        assert.equal(LegStatus.Passed, 'passed')
        h.Evidence.Folder.Dispose()
    })
})
