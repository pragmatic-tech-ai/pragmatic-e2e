import type { Evidence } from './evidence.js'
import type { JourneyContext } from './journey-context.js'
import { JourneyDependencies, type JourneyDependency } from './journey-dependency.js'
import type { IJourneyLeg } from './journey-leg.js'
import { CleanOutcome, CleanStatus, LegOutcome, LegStatus, type JourneyReport } from './journey-report.js'
import { LegAbort, SystemJourneyClock, type IJourneyClock } from './waiter.js'

/** Saves a path's context (to its file in the run folder). */
export interface IJourneyContextStore
{
    Save(context: JourneyContext): void
}

/** What the journey asks of the path's browser around a leg: failure evidence, and stopping a leg that overran. */
export interface ILegSupervisor
{
    /** Failure evidence for a leg (a screenshot of its page, when the evidence filter admits it). */
    Capture(leg: string): Promise<readonly string[]>
    /** Ends whatever the leg is still doing in the browser (its pending page calls then throw). */
    Abort(): Promise<void>
}

/** A request to stop the run (a signal, the run's time budget): no further leg starts, the running one is aborted. */
export class JourneyStop
{
    private static readonly NoReason = ''
    private reason: string | undefined
    private readonly listeners = new Set<(reason: string) => void>()

    public get Stopped(): boolean
    {
        return this.reason !== undefined
    }

    public get Reason(): string
    {
        return this.reason ?? JourneyStop.NoReason
    }

    public Stop(reason: string): void
    {
        if (this.reason !== undefined)
        {
            return
        }
        this.reason = reason
        for (const listener of [...this.listeners])
        {
            listener(reason)
        }
        this.listeners.clear()
    }

    /** Calls `listener` once on Stop (at once when already stopped); answers the unsubscribe. */
    public OnStop(listener: (reason: string) => void): () => void
    {
        if (this.reason !== undefined)
        {
            listener(this.reason)
            return () => undefined
        }
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }
}

/** A leg's Run ran past its deadline. */
export class LegDeadlineError extends Error
{
    private static readonly Prefix = 'leg did not finish within '
    private static readonly Seconds = ' s'
    private static readonly MsPerSecond = 1000

    public constructor(deadlineMs: number)
    {
        super(LegDeadlineError.Prefix + Math.round(deadlineMs / LegDeadlineError.MsPerSecond) + LegDeadlineError.Seconds)
    }
}

/** The run was stopped while the leg ran. */
export class LegStoppedError extends Error
{
    private static readonly Prefix = 'run stopped: '

    public constructor(reason: string)
    {
        super(LegStoppedError.Prefix + reason)
    }
}

/**
 * One path of a journey: its legs in order against one context. `Run` skips the legs an earlier invocation completed
 * (resume), marks a leg pending when a dependency is not live (and every later leg not run), stops at the first
 * failure or a stop request, and then always cleans. A leg past its deadline (or running when the run is stopped) is
 * aborted and allowed to settle before anything else touches its page. `Clean` runs every started leg's clean in
 * reverse start order; after a clean fails, the older legs are not cleaned (their state may be what a retry of the
 * failed clean needs, such as the account that can still cancel a subscription) and `journey clean` retries them all.
 * The context persists on every change, so a killed run leaves a file `Clean` can work from.
 */
export class Journey
{
    // Longer than the live clients' request timeouts (CentralAccount.TimeoutMs), so an aborted leg settles within it.
    public static readonly SettleGraceMs = 30_000
    private static readonly PendingOn = 'pending on '
    private static readonly DeliveredBy = ': '
    private static readonly AfterFailed = 'not run: the leg before it failed ('
    private static readonly AfterPending = 'not run: waits on the pending leg ('
    private static readonly AfterStop = 'not run: '
    private static readonly CloseParen = ')'
    private static readonly Running = 'running'
    private static readonly PassedIn = 'passed in '
    private static readonly FailedWith = 'failed: '
    private static readonly Cleaning = 'cleaning'
    private static readonly CleanedNote = 'cleaned'
    private static readonly CleanFailedWith = 'clean failed: '
    private static readonly CleanSkipped = 'not cleaned: a newer leg\'s clean failed (retry with journey clean)'
    private static readonly UnknownLeg = 'started leg unknown to this journey; clean it by hand'
    private static readonly Ms = ' ms'
    private static readonly Blank = ''
    private static readonly ResumedNote = 'completed by an earlier invocation'

    public constructor(
        private readonly legs: readonly IJourneyLeg[],
        private readonly live: ReadonlySet<JourneyDependency>,
        private readonly report: JourneyReport,
        private readonly evidence: Evidence,
        private readonly store: IJourneyContextStore,
        private readonly supervisor: ILegSupervisor,
        private readonly stop: JourneyStop = new JourneyStop(),
        private readonly abort: LegAbort = new LegAbort(),
        private readonly clock: IJourneyClock = new SystemJourneyClock(),
        private readonly settleGraceMs: number = Journey.SettleGraceMs)
    {
    }

    /** Runs (or resumes) the path, then cleans it. Answers true when every leg that ran passed and every clean worked. */
    public async Run(context: JourneyContext): Promise<boolean>
    {
        context.AttachStore(c => this.store.Save(c))
        let ok = true
        try
        {
            ok = await this.RunLegs(context)
        }
        finally
        {
            ok = (await this.Clean(context)) && ok
        }
        return ok
    }

    /** Cleans the started legs of the context, newest first. Answers true when every one of them was cleaned. */
    public async Clean(context: JourneyContext): Promise<boolean>
    {
        const J = Journey
        context.AttachStore(c => this.store.Save(c))
        this.abort.Reset()
        let failed = false
        const started = [...context.StartedLegs()].reverse()
        for (const name of started)
        {
            const leg = this.legs.find(candidate => candidate.Name === name)
            if (failed)
            {
                this.report.RecordClean(context.Path, new CleanOutcome(name, CleanStatus.Skipped, J.CleanSkipped))
                continue
            }
            if (leg === undefined)
            {
                failed = true
                this.report.RecordClean(context.Path, new CleanOutcome(name, CleanStatus.CleanFailed, J.UnknownLeg))
                continue
            }
            this.evidence.Step(name, J.Cleaning)
            try
            {
                await leg.Clean(context)
                context.MarkCleaned(name)
                this.store.Save(context)
                this.evidence.Step(name, J.CleanedNote)
                this.report.RecordClean(context.Path, new CleanOutcome(name, CleanStatus.Cleaned, J.Blank))
            }
            catch (error)
            {
                failed = true
                const message = this.evidence.Filter.Redact(Journey.MessageOf(error))
                this.evidence.Step(name, J.CleanFailedWith + message)
                this.report.RecordClean(context.Path, new CleanOutcome(name, CleanStatus.CleanFailed, message))
            }
        }
        return !failed
    }

    private async RunLegs(context: JourneyContext): Promise<boolean>
    {
        const J = Journey
        let blockedBy: string | undefined
        let blockedReason = J.AfterFailed
        for (const leg of this.legs)
        {
            if (context.IsCompleted(leg.Name))
            {
                this.report.RecordLeg(context.Path, new LegOutcome(leg.Name, LegStatus.Resumed, 0, J.ResumedNote, []))
                continue
            }
            if (blockedBy === undefined && this.stop.Stopped)
            {
                this.report.RecordLeg(context.Path, new LegOutcome(leg.Name, LegStatus.NotRun, 0, J.AfterStop + this.stop.Reason, []))
                continue
            }
            if (blockedBy !== undefined)
            {
                this.report.RecordLeg(context.Path, new LegOutcome(leg.Name, LegStatus.NotRun, 0, blockedReason + blockedBy + J.CloseParen, []))
                continue
            }
            const missing = leg.Dependencies.find(dependency => !this.live.has(dependency))
            if (missing !== undefined)
            {
                const detail = J.PendingOn + missing + J.DeliveredBy + JourneyDependencies.Deliverer(missing)
                this.evidence.Step(leg.Name, detail)
                this.report.RecordLeg(context.Path, new LegOutcome(leg.Name, LegStatus.Pending, 0, detail, []))
                blockedBy = leg.Name
                blockedReason = J.AfterPending
                continue
            }
            if (!(await this.RunLeg(leg, context)))
            {
                blockedBy = leg.Name
                blockedReason = J.AfterFailed
            }
        }
        return !this.report.Legs(context.Path).some(outcome => outcome.Status === LegStatus.Failed)
    }

    private async RunLeg(leg: IJourneyLeg, context: JourneyContext): Promise<boolean>
    {
        const J = Journey
        const start = this.clock.Now()
        context.MarkStarted(leg.Name)
        this.store.Save(context)
        this.evidence.Step(leg.Name, J.Running)
        try
        {
            await this.Supervised(leg, context)
            context.MarkCompleted(leg.Name)
            this.store.Save(context)
            const duration = this.clock.Now() - start
            this.evidence.Step(leg.Name, J.PassedIn + duration + J.Ms)
            this.report.RecordLeg(context.Path, new LegOutcome(leg.Name, LegStatus.Passed, duration, J.Blank, this.evidence.Ids(leg.Name)))
            return true
        }
        catch (error)
        {
            this.store.Save(context)
            const message = this.evidence.Filter.Redact(Journey.MessageOf(error))
            this.evidence.Step(leg.Name, J.FailedWith + message)
            if (!(error instanceof LegDeadlineError) && !(error instanceof LegStoppedError))
            {
                await this.supervisor.Capture(leg.Name)
            }
            this.report.RecordLeg(context.Path, new LegOutcome(leg.Name, LegStatus.Failed, this.clock.Now() - start, message, this.evidence.Ids(leg.Name)))
            return false
        }
    }

    /**
     * Runs the leg against its deadline and the stop request. When either wins, the leg's browser work is aborted and
     * its Run allowed to settle (up to the grace), so its clean never races it.
     */
    private async Supervised(leg: IJourneyLeg, context: JourneyContext): Promise<void>
    {
        let deadlineTimer: NodeJS.Timeout | undefined
        let graceTimer: NodeJS.Timeout | undefined
        let unsubscribe: () => void = () => undefined
        this.abort.Reset()
        const running = leg.Run(context)
        const settled = running.then(() => undefined, () => undefined)
        const interrupted = new Promise<never>((_resolve, reject) =>
        {
            deadlineTimer = setTimeout(() => reject(new LegDeadlineError(leg.DeadlineMs)), leg.DeadlineMs)
            unsubscribe = this.stop.OnStop(reason => reject(new LegStoppedError(reason)))
        })
        try
        {
            await Promise.race([running, interrupted])
        }
        catch (error)
        {
            if (error instanceof LegDeadlineError || error instanceof LegStoppedError)
            {
                this.abort.Trip()
                await this.supervisor.Abort()
                await Promise.race([settled, new Promise(resolve => { graceTimer = setTimeout(resolve, this.settleGraceMs) })])
            }
            throw error
        }
        finally
        {
            clearTimeout(deadlineTimer)
            clearTimeout(graceTimer)
            unsubscribe()
            interrupted.catch(() => undefined)
        }
    }

    private static MessageOf(error: unknown): string
    {
        return error instanceof Error ? error.message : String(error)
    }
}
