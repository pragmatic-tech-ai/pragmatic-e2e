import { WaitObservation, type Waiter } from '../waiter.js'
import { CabinetPage } from './cabinet-page.js'
import type { CustomerSession } from './customer-session.js'
import type { IJourneyBrowser } from './journey-browser.js'
import type { IJourneyPage } from './journey-page.js'

/** What the cabinet answered "Start" with for an Enrolled or Delegated hive: the one-time code and the install command. */
export class EnrolmentStarted
{
    private static readonly Redacted = '[enrolment started]'

    public constructor(public readonly Code: string, public readonly CommandFirstLine: string, public readonly CommandTenantLine: string)
    {
    }

    /** Names nothing: the code is single use for 30 minutes, but it is still never logged. */
    public toString(): string
    {
        return EnrolmentStarted.Redacted
    }

    public toJSON(): string
    {
        return EnrolmentStarted.Redacted
    }
}

/**
 * The cabinet's Hives section (pragmatic-cabinet `ui/src/sections/hives/`): "Add a hive" (tenant, level, Start: the
 * install command and the one-time enrolment code), "Request an environment" on a connected hive (C3.4), and the
 * client's hives with their health, reported environments and Leave. Row states are read in the hive's own row.
 */
export class CabinetHivesPage
{
    public static readonly NavLabel = 'Hives'
    public static readonly AddTitle = 'Add a hive'
    public static readonly StartButton = 'Start'
    public static readonly EnrolledLevel = 'Enrolled'
    public static readonly DelegatedLevel = 'Delegated'
    public static readonly CodePattern = /pe1-[A-Z2-7]{26}/
    public static readonly CommandPattern = /helm install/
    public static readonly TenantPattern = /tenant\.id=/
    public static readonly HiveIdPattern = /^hv[a-z2-7]{10}$/
    public static readonly RequestTitle = 'Request an environment'
    public static readonly EnvironmentSelector = 'input[placeholder="e.g. staging"]'
    public static readonly RequestButton = 'Request'
    public static readonly RequestedPrefix = 'Requested environment `'
    public static readonly HealthyText = 'Healthy'
    public static readonly LeaveButton = 'Leave'
    public static readonly LeftText = 'Left'
    public static readonly PressIntervalMs = 5_000
    /** The budgets of each step (InstallAndEnrolLeg sizes its deadline from them). */
    public static readonly OpenBudgetMs = 60_000
    public static readonly StartBudgetMs = 60_000
    public static readonly RequestBudgetMs = 60_000
    public static readonly Refusals: readonly string[] = [
        'Pragmatic cannot send requests to this hive: only an Enrolled or Delegated hive that is connected takes them.',
        'An environment name is 1 to 32 lowercase letters, digits and inner dashes, starting with a letter.',
        'That hive was not found.',
    ]
    private static readonly Section = 'the cabinet\'s Hives page'
    private static readonly Started = 'the cabinet to show the enrolment code and install command'
    private static readonly RequestedWait = 'the cabinet to record the environment request '
    private static readonly OnPage = 'on '
    private static readonly NoCode = 'Start pressed, no code yet'
    private static readonly NoAnswer = 'Request pressed, no answer yet'
    private static readonly NotListed = 'the cabinet does not list the hive: '
    private static readonly HealthyRow = /^Healthy$/
    private static readonly LeftRow = /^Left$/
    private static readonly ReadySuffix = ' ready'
    private static readonly OnHive = '` on hive '
    private static readonly StartAnchor = '^'
    private static readonly ListStart = '(^|, )'
    private static readonly ListEnd = '( \\(|,|$)'
    private static readonly NoValue = ''

    public constructor(private readonly session: CustomerSession, private readonly cabinet: CabinetPage, private readonly browser: IJourneyBrowser, private readonly waiter: Waiter)
    {
    }

    /** The account page, then the Hives section, waited for until its form shows (the navigation is pressed inside the wait). */
    public async Open(clientName: string): Promise<IJourneyPage>
    {
        const H = CabinetHivesPage
        const page = await this.session.AccountPage(clientName)
        await this.waiter.Until(H.Section, async () =>
        {
            if (await page.HasText(H.AddTitle))
            {
                return WaitObservation.Met(true, H.AddTitle)
            }
            if (await this.cabinet.IsOnAccount(page, clientName))
            {
                await page.ClickText(H.NavLabel)
            }
            return WaitObservation.NotYet<boolean>(H.OnPage + new URL(page.Url()).host)
        }, H.OpenBudgetMs, H.PressIntervalMs)
        return page
    }

    /**
     * Chooses the level (the cabinet selects the client's one tenant and Enrolled by itself), presses Start and reads
     * the code and command. From the press until the page has moved away from them no failure screenshot is taken (a
     * failure meanwhile leaves them hidden); once read, the browser goes back to the account page.
     */
    public async StartEnrolment(page: IJourneyPage, delegated: boolean): Promise<EnrolmentStarted>
    {
        const H = CabinetHivesPage
        if (delegated)
        {
            await page.ClickText(H.EnrolledLevel)
            await page.ClickText(H.DelegatedLevel)
        }
        this.browser.HideScreenshots(true)
        await page.ClickText(H.StartButton)
        const started = await this.waiter.Until(H.Started, async () =>
        {
            const code = H.CodePattern.exec(await page.TextMatching(H.CodePattern))?.[0]
            const first = await page.TextMatching(H.CommandPattern)
            const tenant = await page.TextMatching(H.TenantPattern)
            if (code !== undefined && first !== H.NoValue && tenant !== H.NoValue)
            {
                return WaitObservation.Met(new EnrolmentStarted(code, first, tenant), H.CommandPattern.source)
            }
            await this.cabinet.ThrowRefusal(page)
            return WaitObservation.NotYet<EnrolmentStarted>(H.NoCode)
        }, H.StartBudgetMs)
        await this.cabinet.OpenAccount(page)
        this.browser.HideScreenshots(false)
        return started
    }

    /** Asks for `environment` (purpose development) on `hiveId`; waits for the cabinet's "Requested environment" answer. */
    public async RequestEnvironment(page: IJourneyPage, hiveId: string, environment: string): Promise<string>
    {
        const H = CabinetHivesPage
        if (!await page.HasText(hiveId))
        {
            throw new Error(H.NotListed + hiveId)
        }
        await page.Fill(H.EnvironmentSelector, environment)
        await page.ClickText(H.RequestButton)
        return this.waiter.Until(H.RequestedWait + environment, async () =>
        {
            const answer = await page.TextMatching(new RegExp(H.StartAnchor + H.Escape(H.RequestedPrefix + environment + H.OnHive + hiveId)))
            if (answer !== H.NoValue)
            {
                return WaitObservation.Met(answer.trim(), answer.trim())
            }
            await this.cabinet.ThrowRefusal(page, H.Refusals)
            return WaitObservation.NotYet<string>(H.NoAnswer)
        }, H.RequestBudgetMs)
    }

    /** Whether the hive's own row shows it Healthy (the cabinet's word, `Healthy`). */
    public async IsHealthy(page: IJourneyPage, hiveId: string): Promise<boolean>
    {
        return (await page.TextNear(hiveId, CabinetHivesPage.HealthyRow)) !== CabinetHivesPage.NoValue
    }

    /** Whether the hive's own row shows it Left. */
    public async IsLeft(page: IJourneyPage, hiveId: string): Promise<boolean>
    {
        return (await page.TextNear(hiveId, CabinetHivesPage.LeftRow)) !== CabinetHivesPage.NoValue
    }

    /** Whether the hive's own row reports `environment` ready (its environments text names it "<name> ready"). */
    public async IsEnvironmentReady(page: IJourneyPage, hiveId: string, environment: string): Promise<boolean>
    {
        const H = CabinetHivesPage
        return (await page.TextNear(hiveId, new RegExp(H.ListStart + H.Escape(environment + H.ReadySuffix) + H.ListEnd))) !== H.NoValue
    }

    /** Every hive the client's list shows (the run's own: each path is its own client). */
    public HiveIds(page: IJourneyPage): Promise<string[]>
    {
        return page.TextsMatching(CabinetHivesPage.HiveIdPattern)
    }

    /** Presses the hive row's Leave; the row then shows it Left. */
    public async Leave(page: IJourneyPage, hiveId: string): Promise<void>
    {
        await page.ClickTextNear(CabinetHivesPage.LeaveButton, hiveId)
    }

    private static Escape(text: string): string
    {
        return text.replace(/[.*+?^${}()|[\]\\`]/g, '\\$&')
    }
}
