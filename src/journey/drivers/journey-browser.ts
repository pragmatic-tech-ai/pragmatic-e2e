import { chromium, type Browser, type BrowserContext } from 'playwright'
import type { Evidence } from '../evidence.js'
import type { ILegSupervisor } from '../journey.js'
import { LegAbort } from '../waiter.js'
import { PlaywrightJourneyPage, type IJourneyPage } from './journey-page.js'

/** Opens the path's browser page; a fake in leg tests. */
export interface IJourneyBrowser
{
    /** The path's one page (created on first use, in the path's own browser context). */
    Page(): Promise<IJourneyPage>
    /** Drops the page and its context (cookies, the central login's SSO session): the next Page() starts fresh. */
    Reset(): Promise<void>
    Close(): Promise<void>
}

/**
 * The path's Chromium (new headless mode unless PRAGMATIC_JOURNEY_HEADED=1): one browser context per path, so paths never share
 * cookies. No HAR, no trace, no video: evidence is the redacted step log and the screenshots the filter admits.
 * As the leg supervisor it screenshots the page a failed leg was on, and aborts an overrunning leg by closing its
 * context (its pending page calls throw; the next Page() opens a fresh one for the clean).
 */
export class JourneyBrowser implements IJourneyBrowser, ILegSupervisor
{
    // The full Chromium in new headless mode: the headless shell starves requestAnimationFrame on Mural's pages (one
    // frame in 85 s on hive-laptop), so Playwright's stability checks and screenshots time out there.
    private static readonly Channel = 'chromium'
    private static readonly Locale = 'en-GB'
    private static readonly ViewportWidth = 1280
    private static readonly ViewportHeight = 900

    private browser: Browser | undefined
    private context: BrowserContext | undefined
    private page: PlaywrightJourneyPage | undefined

    public constructor(private readonly evidence: Evidence, private readonly headed: boolean, private readonly abort: LegAbort = new LegAbort())
    {
    }

    public async Page(): Promise<IJourneyPage>
    {
        const J = JourneyBrowser
        // An aborted leg must not open a fresh page and share it with the clean that follows.
        this.abort.Check()
        if (this.page === undefined)
        {
            // The journey handles SIGINT/SIGTERM (stop, then clean in this browser); Playwright must not close it first.
            this.browser ??= await chromium.launch({ headless: !this.headed, channel: J.Channel, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false })
            this.context = await this.browser.newContext({ locale: J.Locale, viewport: { width: J.ViewportWidth, height: J.ViewportHeight } })
            this.page = new PlaywrightJourneyPage(await this.context.newPage())
        }
        return this.page
    }

    public async Reset(): Promise<void>
    {
        await this.context?.close()
        this.context = undefined
        this.page = undefined
    }

    public async Capture(leg: string): Promise<readonly string[]>
    {
        if (this.page === undefined)
        {
            return []
        }
        const id = await this.evidence.FailureScreenshot(leg, this.page.ScreenshotPage())
        return id === undefined ? [] : [id]
    }

    public Abort(): Promise<void>
    {
        return this.Reset()
    }

    public async Close(): Promise<void>
    {
        await this.Reset()
        await this.browser?.close()
        this.browser = undefined
    }
}
