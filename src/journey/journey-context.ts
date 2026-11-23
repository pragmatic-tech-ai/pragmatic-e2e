import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { JourneyPaths, type JourneyPath } from './journey-path.js'

/** The persisted shape of a context (one file per path in the run folder). */
interface JourneyContextDocument
{
    RunId: string
    Path: string
    Values: Record<string, string>
    Started: string[]
    Completed: string[]
}

/**
 * What one path of a run has created so far: ids and addresses (client name, email, plan, states) and which legs
 * started and completed. It is saved after every leg step, so a killed run can be cleaned or resumed from its file.
 * It refuses to hold anything secret: a key naming a secret, or a value shaped like a token, throws.
 */
export class JourneyContext
{
    private static readonly SecretKeyFragments: readonly string[] = ['password', 'secret', 'token', 'cookie', 'otp', 'oob', 'seed', 'card', 'invitation', 'bearer', 'session']
    private static readonly TokenShapes: readonly RegExp[] = [/eyJ[\w-]{8,}\.[\w-]{8,}/, /^Bearer\s/i, /\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}/]
    private static readonly SecretKeyRefused = 'the journey context holds no secrets; refused key: '
    private static readonly SecretValueRefused = 'the journey context holds no secrets; refused a token-shaped value for key: '
    private static readonly MissingValue = 'the journey context has no value for: '
    private static readonly RunIdPattern = /^[a-z0-9-]{6,64}$/
    private static readonly BadRunId = 'a run id is lowercase letters, digits and dashes: '
    private static readonly ForeignFile = 'the context file belongs to another run or path: '
    private static readonly Encoding = 'utf8'
    private static readonly TempSuffix = '.tmp'
    private static readonly Indent = 2

    private readonly values = new Map<string, string>()
    private persist: ((context: JourneyContext) => void) | undefined
    private readonly started: string[] = []
    private readonly completed: string[] = []

    public constructor(public readonly RunId: string, public readonly Path: JourneyPath)
    {
        JourneyContext.CheckRunId(RunId)
    }

    public static CheckRunId(runId: string): void
    {
        if (!JourneyContext.RunIdPattern.test(runId))
        {
            throw new Error(JourneyContext.BadRunId + runId)
        }
    }

    public static Load(file: string, runId: string, path: JourneyPath): JourneyContext
    {
        const document = JSON.parse(readFileSync(file, JourneyContext.Encoding)) as JourneyContextDocument
        if (document.RunId !== runId || document.Path !== path)
        {
            throw new Error(JourneyContext.ForeignFile + file)
        }
        const context = new JourneyContext(runId, JourneyPaths.Parse(document.Path)[0])
        for (const [key, value] of Object.entries(document.Values))
        {
            context.Set(key, value)
        }
        context.started.push(...document.Started)
        context.completed.push(...document.Completed)
        return context
    }

    /**
     * Saves the context on every change from now on (the journey attaches its store), so a state a leg records
     * mid-step (a checkout submitted, a cancellation scheduled) survives a kill right after it.
     */
    public AttachStore(persist: (context: JourneyContext) => void): void
    {
        this.persist = persist
    }

    public Get(key: string): string | undefined
    {
        return this.values.get(key)
    }

    public Require(key: string): string
    {
        const value = this.values.get(key)
        if (value === undefined)
        {
            throw new Error(JourneyContext.MissingValue + key)
        }
        return value
    }

    public Set(key: string, value: string): void
    {
        const lower = key.toLowerCase()
        if (JourneyContext.SecretKeyFragments.some(fragment => lower.includes(fragment)))
        {
            throw new Error(JourneyContext.SecretKeyRefused + key)
        }
        if (JourneyContext.TokenShapes.some(shape => shape.test(value)))
        {
            throw new Error(JourneyContext.SecretValueRefused + key)
        }
        this.values.set(key, value)
        this.persist?.(this)
    }

    public Delete(key: string): void
    {
        this.values.delete(key)
        this.persist?.(this)
    }

    public MarkStarted(leg: string): void
    {
        if (!this.started.includes(leg))
        {
            this.started.push(leg)
        }
    }

    public MarkCompleted(leg: string): void
    {
        if (!this.completed.includes(leg))
        {
            this.completed.push(leg)
        }
    }

    /** After a leg's clean: it no longer counts as started or completed (a resumed run would redo it). */
    public MarkCleaned(leg: string): void
    {
        this.started.splice(0, this.started.length, ...this.started.filter(name => name !== leg))
        this.completed.splice(0, this.completed.length, ...this.completed.filter(name => name !== leg))
    }

    public IsStarted(leg: string): boolean
    {
        return this.started.includes(leg)
    }

    public IsCompleted(leg: string): boolean
    {
        return this.completed.includes(leg)
    }

    /** The started legs in the order they started. */
    public StartedLegs(): readonly string[]
    {
        return [...this.started]
    }

    /** Writes the context atomically (a temporary file renamed over the old one). */
    public Save(file: string): void
    {
        const document: JourneyContextDocument = {
            RunId: this.RunId,
            Path: this.Path,
            Values: Object.fromEntries(this.values),
            Started: [...this.started],
            Completed: [...this.completed],
        }
        mkdirSync(dirname(file), { recursive: true })
        const temp = file + JourneyContext.TempSuffix
        writeFileSync(temp, JSON.stringify(document, null, JourneyContext.Indent), JourneyContext.Encoding)
        renameSync(temp, file)
    }
}
