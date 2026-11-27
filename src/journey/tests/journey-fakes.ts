import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IJourneyBrowser } from '../drivers/journey-browser.js'
import type { ILegSupervisor } from '../journey.js'
import type { IJourneyFrame, IJourneyPage } from '../drivers/journey-page.js'
import { Evidence, EvidenceFilter, type IEvidenceSink, type IScreenshotPage } from '../evidence.js'
import type { IJourneyClock } from '../waiter.js'

/** A clock whose Sleep advances time at once. */
export class FakeClock implements IJourneyClock
{
    public Slept = 0

    public constructor(public Time: number = 1_000_000)
    {
    }

    public Now(): number
    {
        return this.Time
    }

    public async Sleep(ms: number): Promise<void>
    {
        this.Slept += ms
        this.Time += ms
    }
}

/** Collects evidence lines instead of printing them. */
export class MemorySink implements IEvidenceSink
{
    public readonly Lines: string[] = []

    public Write(line: string): void
    {
        this.Lines.push(line)
    }
}

/** A temporary folder removed by Dispose. */
export class TempFolder
{
    private static readonly Prefix = 'journey-test-'
    public readonly Path: string

    public constructor()
    {
        this.Path = mkdtempSync(join(tmpdir(), TempFolder.Prefix))
    }

    public Dispose(): void
    {
        rmSync(this.Path, { recursive: true, force: true })
    }
}

/** Evidence into a temporary folder with a memory sink. */
export class TestEvidence
{
    public readonly Folder = new TempFolder()
    public readonly Sink = new MemorySink()
    public readonly Filter = new EvidenceFilter(['cabinet.example', 'login.example', 'www.example'], ['paddle.com'])
    public readonly Evidence = new Evidence(this.Folder.Path, this.Filter, this.Sink)
}

/** A frame whose selectors are counted from a set; records fills and clicks. */
export class FakeFrame implements IJourneyFrame
{
    public readonly Present = new Map<string, number>()
    public readonly Calls: string[] = []
    public readonly OnClick = new Map<string, () => void>()

    public constructor(private readonly url: string)
    {
    }

    public Url(): string
    {
        return this.url
    }

    public async Count(selector: string): Promise<number>
    {
        return this.Present.get(selector) ?? 0
    }

    public async Fill(selector: string, value: string): Promise<void>
    {
        this.Calls.push('fill ' + selector + ' ' + value)
    }

    public async Click(selector: string): Promise<void>
    {
        this.Calls.push('click ' + selector)
        this.OnClick.get(selector)?.()
    }

    public async SelectOption(selector: string, value: string): Promise<void>
    {
        this.Calls.push('select ' + selector + ' ' + value)
    }

    public async Text(): Promise<string>
    {
        return ''
    }

    public async TestIds(): Promise<string[]>
    {
        return [...this.Present.keys()]
    }
}

/**
 * A page whose visible texts and selector counts are sets the test (or a click handler) changes; records every
 * action. Goto moves the URL and runs the handler registered for that URL.
 */
export class FakePage implements IJourneyPage
{
    public CurrentUrl = 'about:blank'
    public readonly Texts = new Set<string>()
    public readonly Selectors = new Map<string, number>()
    public readonly Calls: string[] = []
    public readonly OnClick = new Map<string, () => void>()
    public readonly OnGoto = new Map<string, () => void>()
    public readonly OnPress = new Map<string, () => void>()
    public readonly Links: string[] = []
    public readonly Frames = new Map<string, FakeFrame>()
    /** Each row's texts by its anchor text (a hive id, an intent's sentence). */
    public readonly Rows = new Map<string, string[]>()

    public async Goto(url: string): Promise<void>
    {
        this.Calls.push('goto ' + url)
        this.CurrentUrl = url
        this.OnGoto.get(url)?.()
    }

    public Url(): string
    {
        return this.CurrentUrl
    }

    public async HasText(text: string): Promise<boolean>
    {
        return this.Texts.has(text)
    }

    public async TextMatching(pattern: RegExp): Promise<string>
    {
        return [...this.Texts].find(text => pattern.test(text)) ?? ''
    }

    public async TextsMatching(pattern: RegExp): Promise<string[]>
    {
        return [...this.Texts].filter(text => pattern.test(text))
    }

    /** The row's texts (`Rows`, by its anchor); a text elsewhere on the page is not in the row. */
    public async TextNear(anchor: string, pattern: RegExp): Promise<string>
    {
        if (!this.Texts.has(anchor))
        {
            return ''
        }
        return (this.Rows.get(anchor) ?? []).find(text => pattern.test(text)) ?? ''
    }

    public async ClickText(text: string): Promise<void>
    {
        if (!this.Texts.has(text))
        {
            throw new Error('no visible text on the page: ' + text)
        }
        this.Calls.push('click ' + text)
        this.OnClick.get(text)?.()
    }

    public async ClickTextNear(text: string, anchor: string): Promise<void>
    {
        if (!this.Texts.has(text) || !this.Texts.has(anchor))
        {
            throw new Error('no visible text on the page: ' + text + ' near ' + anchor)
        }
        this.Calls.push('click ' + text + ' near ' + anchor)
        this.OnClick.get(text)?.()
    }

    public async Count(selector: string): Promise<number>
    {
        return this.Selectors.get(selector) ?? 0
    }

    public async Fill(selector: string, value: string, index: number = 0): Promise<void>
    {
        this.Calls.push('fill ' + selector + '#' + index + ' ' + value)
    }

    public async Press(selector: string, key: string, index: number = 0): Promise<void>
    {
        this.Calls.push('press ' + selector + '#' + index + ' ' + key)
        this.OnPress.get(key)?.()
    }

    public async Hrefs(): Promise<string[]>
    {
        return [...this.Links]
    }

    public Frame(host: string): IJourneyFrame | undefined
    {
        return this.Frames.get(host)
    }

    public ScreenshotPage(): IScreenshotPage
    {
        return {
            Url: () => this.CurrentUrl,
            FrameUrls: () => [...this.Frames.values()].map(frame => frame.Url()),
            Screenshot: async () => undefined,
        }
    }

    public readonly PostJsonCalls: Array<{ Path: string, Body: unknown }> = []
    public readonly PostJsonAnswers = new Map<string, unknown>()

    public async PostJson(path: string, body: unknown): Promise<unknown>
    {
        this.PostJsonCalls.push({ Path: path, Body: body })
        return this.PostJsonAnswers.get(path) ?? null
    }

    /** Replaces the visible texts and selectors (a navigation to another page). */
    public Show(url: string, texts: readonly string[], selectors: ReadonlyArray<[string, number]> = []): void
    {
        this.CurrentUrl = url
        this.Texts.clear()
        this.Selectors.clear()
        for (const text of texts)
        {
            this.Texts.add(text)
        }
        for (const [selector, count] of selectors)
        {
            this.Selectors.set(selector, count)
        }
    }
}

/** The path's browser over one FakePage. */
export class FakeBrowser implements IJourneyBrowser, ILegSupervisor
{
    public readonly Current = new FakePage()
    public readonly Console = new FakePage()
    /** The page a fresh console browser context opens (the staff user's). */
    public readonly Fresh = new FakePage()
    public readonly FreshPins: string[][] = []
    public Resets = 0
    public Closed = 0

    /** As the real browser: nothing while hidden; otherwise one capture counted (the fake writes no file). */
    public async Capture(_leg: string): Promise<readonly string[]>
    {
        if (this.ScreenshotsHidden)
        {
            return []
        }
        this.Captures += 1
        return []
    }

    public async Abort(): Promise<void>
    {
        this.Resets++
    }

    public async Page(): Promise<IJourneyPage>
    {
        return this.Current
    }

    /** The pins the leg asked the console's browser to accept. */
    public readonly ConsolePins: string[][] = []
    public ScreenshotsHidden = false
    public Captures = 0

    public async ConsolePage(trustedSpki: readonly string[]): Promise<IJourneyPage>
    {
        this.ConsolePins.push([...trustedSpki])
        return this.Console
    }

    public async FreshConsolePage(trustedSpki: readonly string[]): Promise<IJourneyPage>
    {
        this.FreshPins.push([...trustedSpki])
        return this.Fresh
    }

    public HideScreenshots(hidden: boolean): void
    {
        this.ScreenshotsHidden = hidden
    }

    public async Reset(): Promise<void>
    {
        this.Resets++
        this.ScreenshotsHidden = false
    }

    public async Close(): Promise<void>
    {
        this.Closed++
    }
}
