/** Time for the waiter, injectable so tests run without real waiting. */
export interface IJourneyClock
{
    Now(): number
    Sleep(ms: number): Promise<void>
}

export class SystemJourneyClock implements IJourneyClock
{
    public Now(): number
    {
        return Date.now()
    }

    public Sleep(ms: number): Promise<void>
    {
        return new Promise(resolve => setTimeout(resolve, ms))
    }
}

/** One look at a condition: done (with its value) or not yet, with what was seen. */
export class WaitObservation<T>
{
    private constructor(public readonly Done: boolean, public readonly Observed: string, public readonly Value: T | undefined)
    {
    }

    public static Met<T>(value: T, observed: string): WaitObservation<T>
    {
        return new WaitObservation<T>(true, observed, value)
    }

    public static NotYet<T>(observed: string): WaitObservation<T>
    {
        return new WaitObservation<T>(false, observed, undefined)
    }
}

/** Thrown by a probe to end the wait at once: the condition can no longer be met (a page showed a refusal). */
export class WaitAbortError extends Error
{
}

/**
 * The running leg's abort switch, shared by the path's waiter and browser: once tripped (the leg overran its deadline
 * or the run was stopped), every wait and every new page request of that leg throws at once, so an aborted leg settles
 * instead of polling on. The journey resets it before the clean starts.
 */
export class LegAbort
{
    private current = new LegAbortToken()

    public get Aborted(): boolean
    {
        return this.current.Tripped
    }

    /** The token of the leg running now; a wait holds on to the token it started under. */
    public Token(): LegAbortToken
    {
        return this.current
    }

    public Trip(): void
    {
        this.current.Trip()
    }

    /** A fresh token for the next leg or the clean; tokens handed out before stay tripped. */
    public Reset(): void
    {
        if (this.current.Tripped)
        {
            this.current = new LegAbortToken()
        }
    }

    /** Throws WaitAbortError when the current token is tripped. */
    public Check(): void
    {
        this.current.Check()
    }
}

/** One leg's abort state; once tripped it stays tripped. */
export class LegAbortToken
{
    private static readonly AbortedMessage = 'the leg was aborted'
    private tripped = false

    public get Tripped(): boolean
    {
        return this.tripped
    }

    public Trip(): void
    {
        this.tripped = true
    }

    public Check(): void
    {
        if (this.tripped)
        {
            throw new WaitAbortError(LegAbortToken.AbortedMessage)
        }
    }
}

/** A named condition that was not met by its deadline; carries the last state it observed. */
export class WaitTimeoutError extends Error
{
    private static readonly Prefix = 'timed out waiting for '
    private static readonly After = ' after '
    private static readonly Seconds = ' s; last observed: '
    private static readonly MsPerSecond = 1000

    public constructor(public readonly Condition: string, public readonly LastObserved: string, deadlineMs: number)
    {
        super(WaitTimeoutError.Prefix + Condition + WaitTimeoutError.After + Math.round(deadlineMs / WaitTimeoutError.MsPerSecond) + WaitTimeoutError.Seconds + LastObserved)
    }
}

/**
 * Polls a named condition until it is met or its deadline passes; never a bare sleep. A probe that throws counts as
 * "not yet" with the error as the observation (a page still loading, a service restarting), so only the deadline ends
 * the wait, and its error names the condition and the last thing seen. A probe that throws WaitAbortError ends it at once.
 */
export class Waiter
{
    private static readonly DefaultIntervalMs = 2000
    private static readonly NothingObserved = 'nothing observed yet'
    private static readonly ProbeFailed = 'probe failed: '

    public constructor(
        private readonly clock: IJourneyClock = new SystemJourneyClock(),
        private readonly intervalMs: number = Waiter.DefaultIntervalMs,
        private readonly abort: LegAbort = new LegAbort())
    {
    }

    /** Polls `probe` every interval (this waiter's, or `intervalMs` for a slower probe such as a rate-limited API). */
    public async Until<T>(condition: string, probe: () => Promise<WaitObservation<T>>, deadlineMs: number, intervalMs: number = this.intervalMs): Promise<T>
    {
        const end = this.clock.Now() + deadlineMs
        const token = this.abort.Token()
        let last = Waiter.NothingObserved
        for (;;)
        {
            token.Check()
            try
            {
                const observation = await probe()
                if (observation.Done)
                {
                    return observation.Value as T
                }
                last = observation.Observed
            }
            catch (error)
            {
                if (error instanceof WaitAbortError)
                {
                    throw error
                }
                last = Waiter.ProbeFailed + (error instanceof Error ? error.message : String(error))
            }
            const left = end - this.clock.Now()
            if (left <= 0)
            {
                throw new WaitTimeoutError(condition, last, deadlineMs)
            }
            await this.clock.Sleep(Math.min(intervalMs, left))
            token.Check()
        }
    }
}
