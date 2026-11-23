import type { JourneyIdentity } from '../live/journey-identity.js'
import { WaitObservation, type Waiter } from '../waiter.js'
import type { CabinetPage } from './cabinet-page.js'
import type { CentralLoginPage } from './central-login-page.js'
import type { IJourneyBrowser } from './journey-browser.js'
import type { IJourneyPage } from './journey-page.js'

/**
 * The synthetic customer in the path's browser: answers the cabinet's account page signed in, signing in through the
 * central login with the derived password when the cabinet sends the browser there (a resumed run or a clean starts
 * with no session; a live one is answered by the cabinet or the login's SSO session without a prompt).
 */
export class CustomerSession
{
    private static readonly AccountDeadlineMs = 120_000
    private static readonly SignedIn = 'the customer signed in on the cabinet\'s account page for '
    private static readonly OnPage = 'on '

    public constructor(
        private readonly browser: IJourneyBrowser,
        private readonly cabinet: CabinetPage,
        private readonly login: CentralLoginPage,
        private readonly identity: JourneyIdentity,
        private readonly loginHost: string,
        private readonly waiter: Waiter)
    {
    }

    public Page(): Promise<IJourneyPage>
    {
        return this.browser.Page()
    }

    public async AccountPage(clientName: string): Promise<IJourneyPage>
    {
        const C = CustomerSession
        const page = await this.browser.Page()
        await this.cabinet.OpenAccount(page)
        let signedIn = false
        await this.waiter.Until(C.SignedIn + clientName, async () =>
        {
            if (await this.cabinet.IsOnAccount(page, clientName))
            {
                return WaitObservation.Met(true, clientName)
            }
            const host = new URL(page.Url()).host
            if (host === this.loginHost && !signedIn)
            {
                signedIn = true
                await this.login.SignIn(page, this.identity.Email, this.identity.Password)
            }
            return WaitObservation.NotYet<boolean>(C.OnPage + host)
        }, C.AccountDeadlineMs)
        return page
    }
}
