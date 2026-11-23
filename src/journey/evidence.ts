import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** The slice of a browser page a failure screenshot needs (PlaywrightJourneyPage provides it). */
export interface IScreenshotPage
{
    Url(): string
    FrameUrls(): readonly string[]
    /** Writes a full-page PNG to `path` (animations off, caret hidden), failing after `timeoutMs`. */
    Screenshot(path: string, timeoutMs: number): Promise<void>
}

/**
 * Decides what may leave a run as evidence. Screenshots: only of a page on an allow-listed public host, and never
 * while a frame of a forbidden host is attached (the Paddle checkout with its card form, an install-code page). Text:
 * every registered secret value and every token-shaped pattern is replaced before it is written or printed.
 */
export class EvidenceFilter
{
    public static readonly Redacted = '[redacted]'
    private static readonly Patterns: readonly RegExp[] = [
        /eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g,
        /\bBearer\s+[\w.~+/-]+=*/gi,
        /oobCode=[^&\s"'<>]+/g,
        /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/g,
        /\b(?:pwd|password|secret|token|code)=[^&\s"'<>]+/gi,
    ]
    private static readonly MinimumSecretLength = 4
    private static readonly LabelSeparator = '.'
    // Playwright's call logs carry terminal colour codes; they would only garble the step log and the report.
    private static readonly TerminalEscapes = /\u001b\[[0-9;]*m/g
    private static readonly Blank = ''

    private readonly secrets: string[] = []
    private readonly deniedPages: string[] = []

    public constructor(private readonly allowedHosts: readonly string[], private readonly forbiddenFrameHosts: readonly string[])
    {
    }

    /** Never screenshots a page at this origin and path (the cabinet's `/register`, which shows the campaign code). */
    public DenyPage(url: string): void
    {
        const page = new URL(url)
        this.deniedPages.push(page.origin + page.pathname)
    }

    /** Registers a value (a password, a code) that must never appear in evidence. */
    public AddSecret(value: string): void
    {
        if (value.length >= EvidenceFilter.MinimumSecretLength && !this.secrets.includes(value))
        {
            this.secrets.push(value)
        }
    }

    public Redact(text: string): string
    {
        let out = text.replace(EvidenceFilter.TerminalEscapes, EvidenceFilter.Blank)
        for (const secret of this.secrets)
        {
            out = out.split(secret).join(EvidenceFilter.Redacted)
        }
        for (const pattern of EvidenceFilter.Patterns)
        {
            out = out.replace(pattern, EvidenceFilter.Redacted)
        }
        return out
    }

    public AllowsScreenshot(pageUrl: string, frameUrls: readonly string[]): boolean
    {
        const host = EvidenceFilter.HostOf(pageUrl)
        if (host === undefined || !this.allowedHosts.includes(host))
        {
            return false
        }
        const page = new URL(pageUrl)
        if (this.deniedPages.includes(page.origin + page.pathname))
        {
            return false
        }
        return !frameUrls.some(url =>
        {
            const frameHost = EvidenceFilter.HostOf(url)
            return frameHost !== undefined && this.forbiddenFrameHosts.some(forbidden => frameHost === forbidden || frameHost.endsWith(EvidenceFilter.LabelSeparator + forbidden))
        })
    }

    private static HostOf(url: string): string | undefined
    {
        try
        {
            return new URL(url).hostname
        }
        catch
        {
            return undefined
        }
    }
}

/** Where a line of evidence goes besides the step log (the console by default). */
export interface IEvidenceSink
{
    Write(line: string): void
}

export class ConsoleEvidenceSink implements IEvidenceSink
{
    public Write(line: string): void
    {
        console.log(line)
    }
}

/**
 * A path's evidence in the run folder: the step log (`steps.log`, every line redacted) and failure screenshots the
 * filter admits. HAR recording and traces are never turned on. Evidence ids are file names inside the folder.
 */
export class Evidence
{
    public static readonly StepLogName = 'steps.log'
    private static readonly ScreenshotSuffix = '.png'
    private static readonly ScreenshotTimeoutMs = 10_000
    private static readonly Separator = ' '
    private static readonly LegOpen = '['
    private static readonly LegClose = ']'
    private static readonly NewLine = '\n'
    private static readonly Encoding = 'utf8'
    private static readonly Dash = '-'
    private static readonly UnsafeName = /[^a-z0-9-]/gi
    private static readonly ScreenshotRefused = 'screenshot withheld (page not on the evidence allow-list): '
    private static readonly ScreenshotFailed = 'screenshot failed: '

    private readonly ids = new Map<string, string[]>()
    private shots = 0

    public constructor(private readonly folder: string, public readonly Filter: EvidenceFilter, private readonly sink: IEvidenceSink = new ConsoleEvidenceSink())
    {
    }

    public Step(leg: string, message: string): void
    {
        const line = new Date().toISOString() + Evidence.Separator + Evidence.LegOpen + leg + Evidence.LegClose + Evidence.Separator + this.Filter.Redact(message)
        mkdirSync(this.folder, { recursive: true })
        appendFileSync(join(this.folder, Evidence.StepLogName), line + Evidence.NewLine, Evidence.Encoding)
        this.sink.Write(line)
        this.Remember(leg, Evidence.StepLogName)
    }

    /** Takes a screenshot of a failed leg's page when the filter admits it; answers its evidence id or undefined. */
    public async FailureScreenshot(leg: string, page: IScreenshotPage): Promise<string | undefined>
    {
        const url = page.Url()
        if (!this.Filter.AllowsScreenshot(url, page.FrameUrls()))
        {
            this.Step(leg, Evidence.ScreenshotRefused + EvidenceHosts.HostOrBlank(url))
            return undefined
        }
        this.shots++
        const id = leg.replace(Evidence.UnsafeName, Evidence.Dash) + Evidence.Dash + this.shots + Evidence.ScreenshotSuffix
        try
        {
            mkdirSync(this.folder, { recursive: true })
            await page.Screenshot(join(this.folder, id), Evidence.ScreenshotTimeoutMs)
        }
        catch (error)
        {
            this.Step(leg, Evidence.ScreenshotFailed + (error instanceof Error ? error.message : String(error)))
            return undefined
        }
        this.Remember(leg, id)
        return id
    }

    public Ids(leg: string): readonly string[]
    {
        return [...(this.ids.get(leg) ?? [])]
    }

    private Remember(leg: string, id: string): void
    {
        const list = this.ids.get(leg) ?? []
        if (!list.includes(id))
        {
            list.push(id)
        }
        this.ids.set(leg, list)
    }
}

/** The host of a URL for a log line (never its path or query, which may carry codes). */
export class EvidenceHosts
{
    private static readonly Blank = '(no url)'

    public static HostOrBlank(url: string): string
    {
        try
        {
            return new URL(url).host
        }
        catch
        {
            return EvidenceHosts.Blank
        }
    }
}
