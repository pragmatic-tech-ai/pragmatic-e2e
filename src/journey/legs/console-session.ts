import { EngineConsolePage } from '../drivers/engine-console-page.js'
import type { JourneyContext } from '../journey-context.js'
import type { IConsoleTrust } from '../live/console-trust.js'
import type { IEngineClusterSource } from '../live/engine-secrets.js'
import type { Waiter } from '../waiter.js'
import { JourneyKeys } from './journey-keys.js'

/**
 * What a leg needs to open the engine console's browser session: the certificate pins, the host-resolver rules for the
 * loopback port-forward, and the console page driver. Shared by the legs that sign the Owner in to the console.
 */
export class ConsoleSession
{
    private static readonly MapPrefix = 'MAP '
    private static readonly MapSeparator = ','
    private static readonly Loopback = '127.0.0.1'
    private static readonly PortColon = ':'
    private static readonly HostTargetSpace = ' '

    public constructor(
        private readonly context: JourneyContext,
        private readonly trust: IConsoleTrust,
        private readonly clusters: IEngineClusterSource,
        private readonly waiter: Waiter)
    {
    }

    public Engine(): EngineConsolePage
    {
        return new EngineConsolePage(this.context.Require(JourneyKeys.ConsoleUrl), this.context.Require(JourneyKeys.ConsoleHost), this.waiter)
    }

    /**
     * Chromium host-resolver rules mapping the console and sign-in hosts (any port) to the loopback the console URL
     * names: the hosted reach is a port-forward on 127.0.0.1, and Chromium's resolver ignores /etc/hosts; mapping every
     * port also catches a realm redirect to :443.
     */
    public ResolverRules(): string
    {
        const L = ConsoleSession
        const target = L.Loopback + L.PortColon + new URL(this.context.Require(JourneyKeys.ConsoleUrl)).port
        return [this.context.Require(JourneyKeys.ConsoleHost), this.context.Require(JourneyKeys.IdpHost)]
            .map(host => L.MapPrefix + host + L.HostTargetSpace + target)
            .join(L.MapSeparator)
    }

    /** The certificate keys the console's browser (the console URL's port) accepts: exactly the console's and the sign-in service's, chained to the engine's CA. */
    public async Pins(): Promise<string[]>
    {
        return this.trust.Pins([this.context.Require(JourneyKeys.ConsoleHost), this.context.Require(JourneyKeys.IdpHost)], Number(new URL(this.context.Require(JourneyKeys.ConsoleUrl)).port), await this.clusters.For(this.context).DevCa())
    }
}
