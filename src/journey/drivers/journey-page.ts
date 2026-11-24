import type { Frame, Page } from 'playwright'
import type { IScreenshotPage } from '../evidence.js'

/** A frame inside a page (Paddle's checkout overlay), addressed by CSS selectors. */
export interface IJourneyFrame
{
    Url(): string
    Count(selector: string): Promise<number>
    Fill(selector: string, value: string): Promise<void>
    Click(selector: string): Promise<void>
    SelectOption(selector: string, value: string): Promise<void>
    Text(): Promise<string>
    /** The data-testid values present (names only, never field values): what a checkout step offers. */
    TestIds(): Promise<string[]>
}

/**
 * The browser page the drivers use. Mural pages (cabinet, central login) render their text as DOM text, so buttons are
 * found by their visible label; their boxes are native inputs found by placeholder or autocomplete token. A Playwright
 * page backs it in a run; tests use a recording fake.
 */
export interface IJourneyPage
{
    Goto(url: string): Promise<void>
    Url(): string
    HasText(text: string): Promise<boolean>
    /** The text of the first visible element whose text matches `pattern` ('' when none): a value the page shows. */
    TextMatching(pattern: RegExp): Promise<string>
    ClickText(text: string): Promise<void>
    /** Clicks the visible `text` closest (vertically) to the visible `anchor` text: a row's button beside its label. */
    ClickTextNear(text: string, anchor: string): Promise<void>
    Count(selector: string): Promise<number>
    Fill(selector: string, value: string, index?: number): Promise<void>
    Press(selector: string, key: string, index?: number): Promise<void>
    Hrefs(): Promise<string[]>
    Frame(host: string): IJourneyFrame | undefined
    ScreenshotPage(): IScreenshotPage
}

export class PlaywrightJourneyFrame implements IJourneyFrame
{
    private static readonly Body = 'body'
    private static readonly TestIdSelector = '[data-testid]'
    private static readonly TestIdAttribute = 'data-testid'

    public constructor(private readonly frame: Frame)
    {
    }

    public Url(): string
    {
        return this.frame.url()
    }

    public Count(selector: string): Promise<number>
    {
        return this.frame.locator(selector).count()
    }

    public Fill(selector: string, value: string): Promise<void>
    {
        return this.frame.locator(selector).first().fill(value)
    }

    public Click(selector: string): Promise<void>
    {
        return this.frame.locator(selector).first().click()
    }

    public async SelectOption(selector: string, value: string): Promise<void>
    {
        await this.frame.locator(selector).first().selectOption(value)
    }

    public Text(): Promise<string>
    {
        return this.frame.locator(PlaywrightJourneyFrame.Body).innerText()
    }

    public async TestIds(): Promise<string[]>
    {
        const F = PlaywrightJourneyFrame
        const ids = await this.frame.locator(F.TestIdSelector).evaluateAll((elements, name) => elements.map(element => element.getAttribute(name) ?? ''), F.TestIdAttribute)
        return [...new Set(ids.filter(id => id.length > 0))]
    }
}

export class PlaywrightJourneyPage implements IJourneyPage
{
    private static readonly AnchorSelector = 'a[href]'
    private static readonly HrefAttribute = 'href'
    private static readonly NoText = 'no visible text on the page: '
    private static readonly NoValue = ''
    private static readonly ActionTimeoutMs = 15_000
    private static readonly LoadState = 'domcontentloaded'
    private static readonly NoAnimations = 'disabled'
    private static readonly HiddenCaret = 'hide'

    public constructor(private readonly page: Page)
    {
        page.setDefaultTimeout(PlaywrightJourneyPage.ActionTimeoutMs)
    }

    public async Goto(url: string): Promise<void>
    {
        await this.page.goto(url, { waitUntil: PlaywrightJourneyPage.LoadState })
    }

    public Url(): string
    {
        return this.page.url()
    }

    public async HasText(text: string): Promise<boolean>
    {
        const matches = this.page.getByText(text, { exact: true })
        const count = await matches.count()
        for (let i = 0; i < count; i++)
        {
            if (await matches.nth(i).isVisible())
            {
                return true
            }
        }
        return false
    }

    public async TextMatching(pattern: RegExp): Promise<string>
    {
        const matches = this.page.getByText(pattern)
        const count = await matches.count()
        for (let i = 0; i < count; i++)
        {
            if (await matches.nth(i).isVisible())
            {
                return (await matches.nth(i).textContent()) ?? PlaywrightJourneyPage.NoValue
            }
        }
        return PlaywrightJourneyPage.NoValue
    }

    public async ClickText(text: string): Promise<void>
    {
        const matches = this.page.getByText(text, { exact: true })
        const count = await matches.count()
        for (let i = 0; i < count; i++)
        {
            if (await matches.nth(i).isVisible())
            {
                await this.ClickAt(await matches.nth(i).boundingBox(), text)
                return
            }
        }
        throw new Error(PlaywrightJourneyPage.NoText + text)
    }

    public async ClickTextNear(text: string, anchor: string): Promise<void>
    {
        const anchorBox = await this.page.getByText(anchor, { exact: true }).first().boundingBox()
        if (anchorBox === null)
        {
            throw new Error(PlaywrightJourneyPage.NoText + anchor)
        }
        const matches = this.page.getByText(text, { exact: true })
        const count = await matches.count()
        let best = -1
        let bestDistance = Number.POSITIVE_INFINITY
        for (let i = 0; i < count; i++)
        {
            const box = await matches.nth(i).boundingBox()
            if (box === null)
            {
                continue
            }
            const distance = Math.abs((box.y + box.height / 2) - (anchorBox.y + anchorBox.height / 2))
            if (distance < bestDistance)
            {
                best = i
                bestDistance = distance
            }
        }
        if (best < 0)
        {
            throw new Error(PlaywrightJourneyPage.NoText + text)
        }
        await this.ClickAt(await matches.nth(best).boundingBox(), text)
    }

    public Count(selector: string): Promise<number>
    {
        return this.page.locator(selector).count()
    }

    public Fill(selector: string, value: string, index: number = 0): Promise<void>
    {
        return this.page.locator(selector).nth(index).fill(value)
    }

    public Press(selector: string, key: string, index: number = 0): Promise<void>
    {
        return this.page.locator(selector).nth(index).press(key)
    }

    public async Hrefs(): Promise<string[]>
    {
        const anchors = this.page.locator(PlaywrightJourneyPage.AnchorSelector)
        const count = await anchors.count()
        const hrefs: string[] = []
        for (let i = 0; i < count; i++)
        {
            const href = await anchors.nth(i).getAttribute(PlaywrightJourneyPage.HrefAttribute)
            if (href !== null)
            {
                hrefs.push(new URL(href, this.page.url()).toString())
            }
        }
        return hrefs
    }

    public Frame(host: string): IJourneyFrame | undefined
    {
        const frame = this.page.frames().find(candidate =>
        {
            try
            {
                return new URL(candidate.url()).hostname === host
            }
            catch
            {
                return false
            }
        })
        return frame === undefined ? undefined : new PlaywrightJourneyFrame(frame)
    }

    public ScreenshotPage(): IScreenshotPage
    {
        const page = this.page
        return {
            Url: () => page.url(),
            FrameUrls: () => page.frames().map(frame => frame.url()),
            Screenshot: async (path: string, timeoutMs: number) =>
            {
                await page.screenshot({ path, fullPage: true, timeout: timeoutMs, animations: PlaywrightJourneyPage.NoAnimations, caret: PlaywrightJourneyPage.HiddenCaret })
            },
        }
    }

    /**
     * Clicks the middle of a box with the mouse. Mural re-renders its SVG while a native input has focus (the caret),
     * so a Playwright locator click never sees the element "stable"; Mural hit-tests the pointer position itself.
     */
    private async ClickAt(box: { x: number, y: number, width: number, height: number } | null, text: string): Promise<void>
    {
        if (box === null)
        {
            throw new Error(PlaywrightJourneyPage.NoText + text)
        }
        await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    }
}
