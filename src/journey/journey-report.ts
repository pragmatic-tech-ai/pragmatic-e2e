import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { JourneyPath } from './journey-path.js'

/** A leg's outcome in a run. */
export enum LegStatus
{
    Passed = 'passed',
    Failed = 'failed',
    /** A dependency is not live yet (the detail names it and what delivers it); the leg did not run. */
    Pending = 'pending',
    /** An earlier leg failed or is pending; this one did not run. */
    NotRun = 'not-run',
    /** Completed by an earlier invocation of this run (resume). */
    Resumed = 'resumed',
}

/** A leg's clean-up outcome. */
export enum CleanStatus
{
    Cleaned = 'cleaned',
    CleanFailed = 'clean-failed',
    /** Not attempted: a newer leg's clean failed first (journey clean retries it). */
    Skipped = 'clean-skipped',
}

export class LegOutcome
{
    public constructor(
        public readonly Leg: string,
        public readonly Status: LegStatus,
        public readonly DurationMs: number,
        public readonly Detail: string,
        public readonly Evidence: readonly string[])
    {
    }
}

export class CleanOutcome
{
    public constructor(public readonly Leg: string, public readonly Status: CleanStatus, public readonly Detail: string)
    {
    }
}

/**
 * The run's report: per path, each leg's status, duration, detail (the failure, or the dependency it waits on) and
 * evidence ids, and each clean-up. Saved as `journey-report.json` and a short `journey-report.md` in the run folder.
 */
export class JourneyReport
{
    public static readonly Stem = 'journey-report'
    public static readonly JsonSuffix = '.json'
    public static readonly MarkdownSuffix = '.md'
    private static readonly LabelSeparator = '.'
    private static readonly Encoding = 'utf8'
    private static readonly Indent = 2
    private static readonly Title = '# Journey run '
    private static readonly PathHeading = '## Path '
    private static readonly LegTableHead = '| Leg | Status | Duration | Detail |\n|---|---|---|---|'
    private static readonly CleanTableHead = '| Clean | Status | Detail |\n|---|---|---|'
    private static readonly Cell = ' | '
    private static readonly RowOpen = '| '
    private static readonly RowClose = ' |'
    private static readonly Pipe = /\|/g
    private static readonly EscapedPipe = '\\|'
    private static readonly NewLine = /\r?\n/g
    private static readonly Space = ' '
    private static readonly Blank = ''
    private static readonly SecondsSuffix = ' s'
    private static readonly MsPerSecond = 1000
    private static readonly LineBreak = '\n'

    private readonly legs = new Map<JourneyPath, LegOutcome[]>()
    private readonly cleans = new Map<JourneyPath, CleanOutcome[]>()

    public constructor(public readonly RunId: string)
    {
    }

    public RecordLeg(path: JourneyPath, outcome: LegOutcome): void
    {
        const list = this.legs.get(path) ?? []
        list.push(outcome)
        this.legs.set(path, list)
    }

    public RecordClean(path: JourneyPath, outcome: CleanOutcome): void
    {
        const list = this.cleans.get(path) ?? []
        list.push(outcome)
        this.cleans.set(path, list)
    }

    public Legs(path: JourneyPath): readonly LegOutcome[]
    {
        return [...(this.legs.get(path) ?? [])]
    }

    public Cleans(path: JourneyPath): readonly CleanOutcome[]
    {
        return [...(this.cleans.get(path) ?? [])]
    }

    /** True when no leg failed and no clean-up failed (pending legs do not fail a run: they did not run). */
    public get Succeeded(): boolean
    {
        const failedLeg = [...this.legs.values()].flat().some(outcome => outcome.Status === LegStatus.Failed)
        const failedClean = [...this.cleans.values()].flat().some(outcome => outcome.Status !== CleanStatus.Cleaned)
        return !failedLeg && !failedClean
    }

    public ToJson(): object
    {
        const paths = new Set<JourneyPath>([...this.legs.keys(), ...this.cleans.keys()])
        return {
            RunId: this.RunId,
            Succeeded: this.Succeeded,
            Paths: [...paths].map(path => ({ Path: path, Legs: this.Legs(path), Cleans: this.Cleans(path) })),
        }
    }

    public ToMarkdown(): string
    {
        const R = JourneyReport
        const lines: string[] = [R.Title + this.RunId, R.Blank]
        const paths = new Set<JourneyPath>([...this.legs.keys(), ...this.cleans.keys()])
        for (const path of paths)
        {
            lines.push(R.PathHeading + path, R.Blank, R.LegTableHead)
            for (const leg of this.Legs(path))
            {
                lines.push(R.Row([leg.Leg, leg.Status, (leg.DurationMs / R.MsPerSecond).toFixed(1) + R.SecondsSuffix, leg.Detail]))
            }
            const cleans = this.Cleans(path)
            if (cleans.length > 0)
            {
                lines.push(R.Blank, R.CleanTableHead)
                for (const clean of cleans)
                {
                    lines.push(R.Row([clean.Leg, clean.Status, clean.Detail]))
                }
            }
            lines.push(R.Blank)
        }
        return lines.join(R.LineBreak)
    }

    /**
     * Writes `journey-report.{json,md}`, or `journey-report.<label>.{json,md}` for a later invocation of the same run
     * (`resume-<time>`, `clean-<time>`), so a resume or clean never overwrites the run's own report.
     */
    public Save(folder: string, label?: string): void
    {
        const R = JourneyReport
        const stem = label === undefined ? R.Stem : R.Stem + R.LabelSeparator + label
        mkdirSync(folder, { recursive: true })
        writeFileSync(join(folder, stem + R.JsonSuffix), JSON.stringify(this.ToJson(), null, R.Indent), R.Encoding)
        writeFileSync(join(folder, stem + R.MarkdownSuffix), this.ToMarkdown(), R.Encoding)
    }

    private static Row(cells: readonly string[]): string
    {
        const R = JourneyReport
        return R.RowOpen + cells.map(cell => cell.replace(R.NewLine, R.Space).replace(R.Pipe, R.EscapedPipe)).join(R.Cell) + R.RowClose
    }
}
