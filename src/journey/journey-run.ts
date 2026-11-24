import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { JourneyBrowser } from './drivers/journey-browser.js'
import type { IJourneyBrowser } from './drivers/journey-browser.js'
import { CabinetPage } from './drivers/cabinet-page.js'
import { Evidence, EvidenceFilter } from './evidence.js'
import { JourneyConfig } from './journey-config.js'
import { JourneyContext } from './journey-context.js'
import type { IJourneyLeg } from './journey-leg.js'
import { Journey, JourneyStop, type IJourneyContextStore, type ILegSupervisor } from './journey.js'
import { JourneyLock } from './journey-lock.js'
import { JourneyPaths, type JourneyPath } from './journey-path.js'
import { JourneyReport } from './journey-report.js'
import { JourneyLegInputs, JourneyLegs } from './legs/journey-legs.js'
import type { IUncleanedRuns } from './legs/register-leg.js'
import { JourneyIdentity } from './live/journey-identity.js'
import { LegAbort, Waiter } from './waiter.js'

/** What the command asks a run to do. */
export enum JourneyMode
{
    Run = 'run',
    Resume = 'resume',
    Clean = 'clean',
}

/** The run manifest's shape (`run.json`): the paths asked for and those finished (run and cleaned). */
interface JourneyManifestDocument
{
    RunId: string
    Paths: string[]
    Finished: string[]
}

/**
 * A run's folder: `run.json` (the paths asked for, the paths finished), per path `context.json`, the evidence and the
 * reports. It is the store the journey saves contexts through.
 */
export class JourneyRunFolder implements IJourneyContextStore
{
    public static readonly ContextName = 'context.json'
    public static readonly ManifestName = 'run.json'
    private static readonly Encoding = 'utf8'
    private static readonly Indent = 2
    private static readonly TempSuffix = '.tmp'

    public constructor(public readonly Root: string)
    {
    }

    public PathFolder(path: JourneyPath): string
    {
        return join(this.Root, path)
    }

    public ContextFile(path: JourneyPath): string
    {
        return join(this.PathFolder(path), JourneyRunFolder.ContextName)
    }

    public Save(context: JourneyContext): void
    {
        context.Save(this.ContextFile(context.Path))
    }

    public HasContext(path: JourneyPath): boolean
    {
        return existsSync(this.ContextFile(path))
    }

    public WriteManifest(runId: string, paths: readonly JourneyPath[], finished: readonly JourneyPath[]): void
    {
        const F = JourneyRunFolder
        const document: JourneyManifestDocument = { RunId: runId, Paths: [...paths], Finished: [...finished] }
        const file = join(this.Root, F.ManifestName)
        mkdirSync(this.Root, { recursive: true })
        writeFileSync(file + F.TempSuffix, JSON.stringify(document, null, F.Indent), F.Encoding)
        renameSync(file + F.TempSuffix, file)
    }

    /** The manifest's paths and finished paths; a folder without one (an older run) lists the paths with a context. */
    public ReadManifest(): { Paths: JourneyPath[], Finished: JourneyPath[] }
    {
        const file = join(this.Root, JourneyRunFolder.ManifestName)
        if (!existsSync(file))
        {
            return { Paths: JourneyPaths.All.filter(path => this.HasContext(path)), Finished: [] }
        }
        const document = JSON.parse(readFileSync(file, JourneyRunFolder.Encoding)) as JourneyManifestDocument
        const known = (names: string[]): JourneyPath[] => JourneyPaths.All.filter(path => names.includes(path))
        return { Paths: known(document.Paths), Finished: known(document.Finished) }
    }
}

/** Earlier runs in the runs folder whose path still has started legs. */
export class UncleanedRunFinder implements IUncleanedRuns
{
    public constructor(private readonly runsDir: string)
    {
    }

    public For(path: JourneyPath, exceptRunId: string): readonly string[]
    {
        if (!existsSync(this.runsDir))
        {
            return []
        }
        const found: string[] = []
        for (const runId of readdirSync(this.runsDir))
        {
            const folder = new JourneyRunFolder(join(this.runsDir, runId))
            if (runId === exceptRunId || !folder.HasContext(path))
            {
                continue
            }
            try
            {
                if (JourneyContext.Load(folder.ContextFile(path), runId, path).StartedLegs().length > 0)
                {
                    found.push(runId)
                }
            }
            catch
            {
                // A folder that is not a run of this harness is not ours to judge.
            }
        }
        return found
    }
}

/** Builds a path's legs and browser (the real ones in a run; fakes in tests). */
export interface IJourneyPathFactory
{
    Browser(evidence: Evidence, config: JourneyConfig, abort: LegAbort): IJourneyBrowser & ILegSupervisor
    Legs(path: JourneyPath, inputs: JourneyLegInputs): IJourneyLeg[]
}

export class LiveJourneyPathFactory implements IJourneyPathFactory
{
    public Browser(evidence: Evidence, config: JourneyConfig, abort: LegAbort): IJourneyBrowser & ILegSupervisor
    {
        return new JourneyBrowser(evidence, config.Headed, abort)
    }

    public Legs(path: JourneyPath, inputs: JourneyLegInputs): IJourneyLeg[]
    {
        return JourneyLegs.For(path, inputs)
    }
}

/**
 * A whole journey invocation: takes the laptop's journey lock, runs (or resumes, or only cleans) each path in turn
 * in its own browser context and evidence folder, and writes the report. Paths run sequentially (Design: the customer
 * cluster is reused and the laptop's memory is shared with the Hosted placement). `run.json` records the paths asked
 * for and those finished, so `resume` continues with the unfinished ones (an interrupted path from its last good leg,
 * a path never started from its first) and `clean` cleans every path with a context. `Stop` (a signal, the run's time
 * budget) aborts the running leg; the path's clean still runs.
 */
export class JourneyRun
{
    /** The whole run's budget (the plan's 75 minutes for three paths). */
    public static readonly BudgetMs = 75 * 60_000
    private static readonly RunIdTimestamp = /[-:]/g
    private static readonly RunIdCut = 13
    private static readonly RunIdSeparator = '-'
    private static readonly RunIdRandomBytes = 2
    private static readonly Hex = 'hex'
    private static readonly Blank = ''
    private static readonly LabelSeparator = '-'
    private static readonly RunFolderMissing = 'no such run folder: '
    private static readonly OverBudget = 'the run exceeded its time budget'
    // Paddle's checkout frames (sandbox-buy, buy and their nested card frames) all sit under this domain.
    private static readonly ForbiddenFrameHosts: readonly string[] = ['paddle.com']

    public readonly Report: JourneyReport
    private readonly folder: JourneyRunFolder
    private readonly stop = new JourneyStop()

    public constructor(
        private readonly config: JourneyConfig,
        public readonly RunId: string,
        private readonly mode: JourneyMode,
        private readonly paths: readonly JourneyPath[],
        private readonly factory: IJourneyPathFactory = new LiveJourneyPathFactory(),
        private readonly lock: JourneyLock = new JourneyLock(config.LockFile),
        private readonly budgetMs: number = JourneyRun.BudgetMs)
    {
        JourneyContext.CheckRunId(RunId)
        this.Report = new JourneyReport(RunId)
        this.folder = new JourneyRunFolder(join(config.RunsDir, RunId))
    }

    /** A new run id: the UTC minute and four hex digits (`20261123t1015-ab12`). */
    public static NewRunId(now: Date = new Date()): string
    {
        const R = JourneyRun
        const stamp = now.toISOString().replace(R.RunIdTimestamp, R.Blank).slice(0, R.RunIdCut).toLowerCase()
        return stamp + R.RunIdSeparator + randomBytes(R.RunIdRandomBytes).toString(R.Hex)
    }

    /** The paths a resume or clean of `runId` covers (see the class note). */
    public static PathsFor(config: JourneyConfig, runId: string, mode: JourneyMode): JourneyPath[]
    {
        const folder = new JourneyRunFolder(join(config.RunsDir, runId))
        if (!existsSync(folder.Root))
        {
            throw new Error(JourneyRun.RunFolderMissing + folder.Root)
        }
        const manifest = folder.ReadManifest()
        if (mode === JourneyMode.Clean)
        {
            return JourneyPaths.All.filter(path => folder.HasContext(path))
        }
        return manifest.Paths.filter(path => !manifest.Finished.includes(path))
    }

    public get Folder(): string
    {
        return this.folder.Root
    }

    /** Stops the run: no further leg starts, the running one is aborted, and its path is cleaned. */
    public Stop(reason: string): void
    {
        this.stop.Stop(reason)
    }

    /** Runs the invocation under the lock; answers whether it succeeded (no failed leg, no failed clean). */
    public async Execute(): Promise<boolean>
    {
        const R = JourneyRun
        this.lock.Acquire(this.RunId)
        const budget = setTimeout(() => this.Stop(R.OverBudget), this.budgetMs)
        const finished = this.mode === JourneyMode.Run ? [] : this.folder.ReadManifest().Finished
        const asked = this.mode === JourneyMode.Run ? [...this.paths] : this.folder.ReadManifest().Paths
        try
        {
            if (this.mode === JourneyMode.Run)
            {
                this.folder.WriteManifest(this.RunId, asked, finished)
            }
            for (const path of this.paths)
            {
                await this.ExecutePath(path)
                // A stopped run's path is not finished: resume continues it (and the paths after it).
                if (this.mode !== JourneyMode.Clean && !this.stop.Stopped && !finished.includes(path))
                {
                    finished.push(path)
                    this.folder.WriteManifest(this.RunId, asked, finished)
                }
            }
        }
        finally
        {
            clearTimeout(budget)
            this.Report.Save(this.folder.Root, this.mode === JourneyMode.Run ? undefined : this.mode + R.LabelSeparator + R.NewRunId())
            this.lock.Release()
        }
        return this.Report.Succeeded
    }

    private async ExecutePath(path: JourneyPath): Promise<void>
    {
        const config = this.config
        const cabinetHost = new URL(config.CabinetUrl).hostname
        const filter = new EvidenceFilter([new URL(config.WebsiteUrl).hostname, cabinetHost, new URL(config.CentralIssuer).hostname], JourneyRun.ForbiddenFrameHosts)
        const evidence = new Evidence(this.folder.PathFolder(path), filter)
        const seed = JourneyConfig.ReadSecretFile(config.RequireFile(JourneyConfig.PasswordSeedFileEnv))
        filter.AddSecret(seed)
        const identity = new JourneyIdentity(path, config.EmailDomain, seed)
        filter.AddSecret(identity.Password)
        const codeFile = config.OptionalFile(JourneyConfig.CampaignCodeFileEnv)
        const code = codeFile === undefined ? undefined : JourneyConfig.ReadSecretFile(codeFile)
        if (code !== undefined)
        {
            filter.AddSecret(code)
            // The registration page shows the code in its box: never a screenshot of it.
            filter.DenyPage(config.CabinetUrl + CabinetPage.RegisterPath)
        }
        const abort = new LegAbort()
        const browser = this.factory.Browser(evidence, config, abort)
        try
        {
            const context = this.ContextFor(path)
            const inputs = new JourneyLegInputs(config, browser, identity, code, new UncleanedRunFinder(config.RunsDir), new Waiter(undefined, undefined, abort), evidence, abort)
            const journey = new Journey(this.factory.Legs(path, inputs), config.LiveDependencies, this.Report, evidence, this.folder, browser, this.stop, abort)
            if (this.mode === JourneyMode.Clean)
            {
                await journey.Clean(context)
            }
            else
            {
                await journey.Run(context)
            }
        }
        finally
        {
            await browser.Close()
        }
    }

    private ContextFor(path: JourneyPath): JourneyContext
    {
        if (this.mode === JourneyMode.Run || !this.folder.HasContext(path))
        {
            const context = new JourneyContext(this.RunId, path)
            this.folder.Save(context)
            return context
        }
        return JourneyContext.Load(this.folder.ContextFile(path), this.RunId, path)
    }
}
