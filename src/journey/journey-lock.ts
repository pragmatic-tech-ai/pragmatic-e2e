import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { SystemJourneyClock, type IJourneyClock } from './waiter.js'

/** The lock file's content: which run holds it, since when, from which process. */
interface JourneyLockDocument
{
    RunId: string
    StartedAt: number
    Pid: number
}

/** Answers whether a process id is alive on this machine (a fake in tests). */
export interface IProcessProbe
{
    IsAlive(pid: number): boolean
}

export class SystemProcessProbe implements IProcessProbe
{
    private static readonly NoPermission = 'EPERM'

    public IsAlive(pid: number): boolean
    {
        try
        {
            process.kill(pid, 0)
            return true
        }
        catch (error)
        {
            // EPERM: the process exists but belongs to another user.
            return (error as NodeJS.ErrnoException).code === SystemProcessProbe.NoPermission
        }
    }
}

/** Another journey holds the lock: a live process, or a lock younger than the stale age. */
export class JourneyLockHeldError extends Error
{
    private static readonly Prefix = 'another journey is running: run '
    private static readonly Since = ' since '
    private static readonly ByPid = ' (process '
    private static readonly Close = ')'

    public constructor(public readonly HolderRunId: string, startedAt: number, pid: number)
    {
        super(JourneyLockHeldError.Prefix + HolderRunId + JourneyLockHeldError.Since + new Date(startedAt).toISOString() + JourneyLockHeldError.ByPid + pid + JourneyLockHeldError.Close)
    }
}

/**
 * At most one journey process at a time on the laptop: a lock file with the run id, start time and process id,
 * created exclusively. A holder whose process is gone is taken over at once; one whose process is alive is refused,
 * also for the same run id (a `journey clean` must not run beside the run it cleans); a lock older than the stale age
 * (3 h, longer than any run's budget) is taken over whatever it says (this also covers a dead holder whose process id
 * was reused after a WSL restart). A takeover writes a temporary file, renames it over the lock and reads it back:
 * this narrows, but does not close, the window in which two takeovers racing at the same instant both proceed; the
 * journey runs from one operator's hive run at a time, so that window is accepted. Release removes the file only when
 * this process holds it.
 */
export class JourneyLock
{
    public static readonly StaleAfterMs = 3 * 60 * 60 * 1000
    private static readonly Encoding = 'utf8'
    private static readonly ExclusiveCreate = 'wx'
    private static readonly ExistsCode = 'EEXIST'
    private static readonly TempSuffix = '.takeover-'
    private static readonly LostRace = 'another journey took the lock over at the same moment'

    public constructor(
        private readonly file: string,
        private readonly clock: IJourneyClock = new SystemJourneyClock(),
        private readonly probe: IProcessProbe = new SystemProcessProbe(),
        private readonly pid: number = process.pid,
        private readonly staleAfterMs: number = JourneyLock.StaleAfterMs)
    {
    }

    public Acquire(runId: string): void
    {
        const L = JourneyLock
        mkdirSync(dirname(this.file), { recursive: true })
        const mine: JourneyLockDocument = { RunId: runId, StartedAt: this.clock.Now(), Pid: this.pid }
        try
        {
            writeFileSync(this.file, JSON.stringify(mine), { encoding: L.Encoding, flag: L.ExclusiveCreate })
            return
        }
        catch (error)
        {
            if ((error as NodeJS.ErrnoException).code !== L.ExistsCode)
            {
                throw error
            }
        }
        const holder = this.Holder()
        if (holder !== undefined && holder.Pid !== this.pid && this.probe.IsAlive(holder.Pid) && this.clock.Now() - holder.StartedAt < this.staleAfterMs)
        {
            throw new JourneyLockHeldError(holder.RunId, holder.StartedAt, holder.Pid)
        }
        const temp = this.file + L.TempSuffix + this.pid
        writeFileSync(temp, JSON.stringify(mine), L.Encoding)
        renameSync(temp, this.file)
        if (this.Holder()?.Pid !== this.pid)
        {
            throw new Error(L.LostRace)
        }
    }

    public Release(): void
    {
        if (this.Holder()?.Pid === this.pid)
        {
            rmSync(this.file, { force: true })
        }
    }

    private Holder(): JourneyLockDocument | undefined
    {
        try
        {
            const document = JSON.parse(readFileSync(this.file, JourneyLock.Encoding)) as Partial<JourneyLockDocument>
            if (typeof document.RunId === 'string' && typeof document.StartedAt === 'number' && typeof document.Pid === 'number')
            {
                return { RunId: document.RunId, StartedAt: document.StartedAt, Pid: document.Pid }
            }
        }
        catch
        {
            // An unreadable or half-written lock counts as no holder; it is taken over.
        }
        return undefined
    }
}
