// The journey command (dev-kit plan 2026-11-20-f-journey-tests.md), run on the hive laptop in WSL:
//
//   npm run journey -- [run] [--paths enrolled,delegated,hosted]   a new run: every path, legs in order, then clean
//   npm run journey -- resume <run id>                             continue a killed run's unfinished paths, then clean
//   npm run journey:clean -- <run id>                              clean a killed run's started legs (newest first)
//
// Inputs: src/journey/journey.config.json (or PRAGMATIC_JOURNEY_CONFIG); the test-only files named by
// PRAGMATIC_JOURNEY_PASSWORD_SEED_FILE (required) and PRAGMATIC_JOURNEY_CAMPAIGN_CODE_FILE (optional);
// PRAGMATIC_JOURNEY_RUNS_DIR (default: journey-runs/ in this checkout) and PRAGMATIC_JOURNEY_LOCK_FILE
// (default: ~/.pragmatic/journey/lock). The report is journey-report.{json,md} in the run folder (a resume or clean
// writes journey-report.<mode>-<time>.{json,md}); exit 0 when no leg and no clean failed (pending legs did not run).
// SIGINT/SIGTERM/SIGHUP stop the run: the running leg is aborted and the path cleaned; a second signal exits at once. A
// SIGKILL (or a lost machine) skips the clean: run journey:clean <run id> then.
import { JourneyConfig } from '../journey/journey-config.js'
import { JourneyPaths, type JourneyPath } from '../journey/journey-path.js'
import { JourneyMode, JourneyRun } from '../journey/journey-run.js'

/** Parses the command line and runs the journey. */
export class JourneyCommand
{
    private static readonly PathsFlag = '--paths'
    private static readonly Usage = 'usage: journey [run] [--paths enrolled,delegated,hosted] | journey resume <run id> | journey clean <run id>'
    private static readonly RunFolder = 'run folder: '
    private static readonly NothingToDo = 'the run has no unfinished path to resume and no path to clean: '
    private static readonly Failed = 'journey failed: '
    // SIGHUP too: a dropped ssh / hive-run session is the likeliest way a run dies on the laptop.
    private static readonly Signals: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']
    private static readonly StoppedBy = 'stopped by '
    private static readonly StoppingNote = 'journey: stopping (the running leg is aborted, then cleaned); signal again to exit at once'
    private static readonly SecondSignalExit = 130

    public static async Main(argv: readonly string[]): Promise<number>
    {
        const C = JourneyCommand
        try
        {
            const config = JourneyConfig.Load()
            const run = C.Parse(argv, config)
            console.log(C.RunFolder + run.Folder)
            C.StopOnSignals(run)
            const ok = await run.Execute()
            console.log(run.Report.ToMarkdown())
            return ok ? 0 : 1
        }
        catch (error)
        {
            console.error(C.Failed + (error instanceof Error ? error.message : String(error)))
            return 1
        }
    }

    public static Parse(argv: readonly string[], config: JourneyConfig): JourneyRun
    {
        const C = JourneyCommand
        const args = [...argv]
        const first = args[0]
        if (first === JourneyMode.Resume || first === JourneyMode.Clean)
        {
            const runId = args[1]
            if (runId === undefined || args.length !== 2)
            {
                throw new Error(C.Usage)
            }
            const paths = JourneyRun.PathsFor(config, runId, first)
            if (paths.length === 0)
            {
                throw new Error(C.NothingToDo + runId)
            }
            return new JourneyRun(config, runId, first, paths)
        }
        if (first === JourneyMode.Run)
        {
            args.shift()
        }
        let paths: JourneyPath[] = [...JourneyPaths.All]
        while (args.length > 0)
        {
            const flag = args.shift()
            const value = args.shift()
            if (flag !== C.PathsFlag || value === undefined)
            {
                throw new Error(C.Usage)
            }
            paths = JourneyPaths.Parse(value)
        }
        return new JourneyRun(config, JourneyRun.NewRunId(), JourneyMode.Run, paths)
    }

    /** The first SIGINT/SIGTERM stops the run gracefully (its clean runs); a second one exits at once. */
    private static StopOnSignals(run: JourneyRun): void
    {
        const C = JourneyCommand
        let stopping = false
        for (const signal of C.Signals)
        {
            process.on(signal, () =>
            {
                if (stopping)
                {
                    process.exit(C.SecondSignalExit)
                }
                stopping = true
                console.error(C.StoppingNote)
                run.Stop(C.StoppedBy + signal)
            })
        }
    }
}

process.exitCode = await JourneyCommand.Main(process.argv.slice(2))
