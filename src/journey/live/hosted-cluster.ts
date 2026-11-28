import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { JourneyContext } from '../journey-context.js'
import { JourneyKeys } from '../legs/journey-keys.js'
import { LegAbort } from '../waiter.js'
import { AbortableRunner, ClusterArgs, EngineSecrets, type IEngineCluster, type IEngineClusterSource, type OwnerSignIn } from './engine-secrets.js'
import type { IProcessRunner, IProcessStarter, IRunningProcess } from './process-runner.js'

/**
 * `127.0.0.1 <host>` lines in a hosts file (WSL's /etc/hosts, the journey runs as root there), each ending in a marker
 * comment so removal takes exactly the lines this class added and nothing else. Adding is idempotent.
 */
export class HostAliases
{
    public static readonly DefaultFile = '/etc/hosts'
    public static readonly Marker = '# pragmatic-e2e-journey'
    private static readonly Loopback = '127.0.0.1'
    private static readonly Space = ' '
    private static readonly NewLine = '\n'
    private static readonly Encoding = 'utf8'
    private static readonly Lines = /\r?\n/

    public constructor(private readonly file: string = HostAliases.DefaultFile)
    {
    }

    /** Appends the missing `127.0.0.1 <host> # marker` lines. */
    public Add(hosts: readonly string[]): void
    {
        const H = HostAliases
        const text = this.Read()
        const present = new Set(text.split(H.Lines))
        const missing = hosts.map(host => H.LineFor(host)).filter(line => !present.has(line))
        if (missing.length === 0)
        {
            return
        }
        const separator = text.length === 0 || text.endsWith(H.NewLine) ? '' : H.NewLine
        writeFileSync(this.file, text + separator + missing.join(H.NewLine) + H.NewLine, H.Encoding)
    }

    /** Removes every marked line (a killed run's leftovers too); the file is untouched when there are none. */
    public Remove(): void
    {
        const H = HostAliases
        const text = this.Read()
        const lines = text.split(H.NewLine)
        const kept = lines.filter(line => !line.trimEnd().endsWith(H.Marker))
        if (kept.length !== lines.length)
        {
            writeFileSync(this.file, kept.join(H.NewLine), H.Encoding)
        }
    }

    private Read(): string
    {
        return existsSync(this.file) ? readFileSync(this.file, HostAliases.Encoding) : ''
    }

    private static LineFor(host: string): string
    {
        const H = HostAliases
        return H.Loopback + H.Space + host + H.Space + H.Marker
    }
}

/**
 * A kubectl port-forward kept alive: started at once, restarted (after a pause, a bounded number of times) when it exits
 * while nobody has stopped it, and stopped for good by Stop.
 */
export class ConsoleReach
{
    public static readonly MaxRestarts = 30
    private current: IRunningProcess | undefined
    private stopped = false
    private restarts = 0

    public constructor(private readonly starter: IProcessStarter, private readonly program: string, private readonly argv: readonly string[], private readonly restartDelayMs: number)
    {
        this.Launch()
    }

    /** How many times the forward was restarted. */
    public get Restarts(): number
    {
        return this.restarts
    }

    public async Stop(): Promise<void>
    {
        this.stopped = true
        await this.current?.Stop()
    }

    private Launch(): void
    {
        this.current = this.starter.Start(this.program, this.argv, () => this.Exited())
    }

    private Exited(): void
    {
        if (this.stopped || this.restarts >= ConsoleReach.MaxRestarts)
        {
            return
        }
        this.restarts++
        setTimeout(() =>
        {
            if (!this.stopped)
            {
                this.Launch()
            }
        }, this.restartDelayMs)
    }
}

/** The ingress host rows `kubectl get ingress -A -o json` answers (the fields read). */
interface IngressList
{
    readonly items?: ReadonlyArray<{
        readonly metadata?: { readonly name?: string }
        readonly spec?: { readonly rules?: ReadonlyArray<{ readonly host?: string }> }
    }>
}

/**
 * A Hosted hive's cluster (kind `pragmatic-hosted-<placementId>` on the host agent, reached from WSL as kubeconfig
 * context `kind-pragmatic-hosted-<placementId>`): the Owner's sign-in and development CA (EngineSecrets, the same reads
 * as the customer cluster), the console and sign-in hosts of its Ingresses, and a local route to its console.
 *
 * The console certificate is for the placement's real host, so the journey keeps the host and aliases it to the
 * loopback (hosts file) where a kubectl port-forward to ingress-nginx's HTTPS port listens: TLS and SNI pass through
 * the forward, and ingress-nginx routes by Host and serves the matching development-CA certificate.
 *
 * The console and the sign-in service are told apart by their Ingress's name (the engine chart's tenant-admin and idp
 * templates): `pragmatic-tenant-admin-<tenant>` (namespace pragmatic-system) is the console,
 * `pragmatic-idp-<tenant>` (namespace pragmatic-idp-<tenant>) the sign-in service.
 */
export class HostedCluster implements IEngineCluster
{
    /** The local port of the console's port-forward: high, and apart from the customer cluster's 28443 and kind's API-server ports. */
    public static readonly ConsolePort = 28444
    public static readonly ContextPrefix = 'kind-pragmatic-hosted-'
    public static readonly RestartDelayMs = 2000
    private static readonly Kubectl = 'kubectl'
    private static readonly Kind = 'kind'
    private static readonly Export = 'export'
    private static readonly Kubeconfig = 'kubeconfig'
    private static readonly NameFlag = '--name'
    public static readonly ClusterNamePrefix = 'pragmatic-hosted-'
    private static readonly ExportFailed = 'exporting the hosted cluster kubeconfig failed with code '
    private static readonly IngressKind = 'ingress'
    private static readonly AllNamespaces = '--all-namespaces'
    private static readonly PortForward = 'port-forward'
    private static readonly AddressFlag = '--address'
    private static readonly Loopback = '127.0.0.1'
    private static readonly IngressNamespace = 'ingress-nginx'
    private static readonly IngressService = 'svc/ingress-nginx-controller'
    private static readonly HttpsPort = ':443'
    private static readonly ConsoleIngress = 'pragmatic-tenant-admin-'
    private static readonly IdpIngress = 'pragmatic-idp-'
    private static readonly Scheme = 'https://'
    private static readonly PortSeparator = ':'
    private static readonly Root = '/'
    private static readonly ListFailed = 'listing the hosted cluster\'s ingresses failed with code '
    private readonly runner: AbortableRunner
    private readonly secrets: EngineSecrets

    public constructor(
        runner: IProcessRunner,
        private readonly starter: IProcessStarter,
        public readonly PlacementId: string,
        private readonly aliases: HostAliases,
        abort: LegAbort = new LegAbort(),
        private readonly restartDelayMs: number = HostedCluster.RestartDelayMs)
    {
        this.runner = new AbortableRunner(runner, abort)
        this.secrets = new EngineSecrets(this.runner, this.Context)
    }

    /** The kubeconfig context of the cluster. */
    public get Context(): string
    {
        return HostedCluster.ContextPrefix + this.PlacementId
    }

    /** The kind cluster name (the context without the `kind-` prefix). */
    public get ClusterName(): string
    {
        return HostedCluster.ClusterNamePrefix + this.PlacementId
    }

    /**
     * Merges the cluster's context into the default kubeconfig. The host agent's hosted clusters are not in WSL's
     * default kubeconfig, so `kubectl --context kind-pragmatic-hosted-<id>` fails until this has run once.
     */
    public async EnsureKubeconfig(): Promise<void>
    {
        const H = HostedCluster
        const exported = await this.runner.Run(H.Kind, [H.Export, H.Kubeconfig, H.NameFlag, this.ClusterName], EngineSecrets.ReadTimeoutMs)
        if (!exported.Ok)
        {
            throw new Error(H.ExportFailed + exported.Code)
        }
    }

    /** The console's URL through the local forward: the real host, the forward's port. */
    public static ConsoleUrl(consoleHost: string, localPort: number): string
    {
        const H = HostedCluster
        return H.Scheme + consoleHost + H.PortSeparator + localPort + H.Root
    }

    public Owner(): Promise<OwnerSignIn | undefined>
    {
        return this.secrets.Owner()
    }

    public DevCa(): Promise<string>
    {
        return this.secrets.DevCa()
    }

    /** The console's host (the tenant-admin Ingress), undefined while the chart has not created it. */
    public ConsoleHost(): Promise<string | undefined>
    {
        return this.HostOf(HostedCluster.ConsoleIngress)
    }

    /** The realm sign-in service's host (the idp Ingress), undefined while the chart has not created it. */
    public IdpHost(): Promise<string | undefined>
    {
        return this.HostOf(HostedCluster.IdpIngress)
    }

    /** Starts the console's port-forward (loopback `localPort` to ingress-nginx's 443) and keeps it running until Stop. */
    public StartConsoleReach(localPort: number): ConsoleReach
    {
        const H = HostedCluster
        const A = ClusterArgs
        const argv = [A.Context, this.Context, H.PortForward, A.NamespaceFlag, H.IngressNamespace, H.AddressFlag, H.Loopback, H.IngressService, localPort + H.HttpsPort]
        return new ConsoleReach(this.starter, H.Kubectl, argv, this.restartDelayMs)
    }

    /** Aliases the hosts to the loopback in the hosts file. */
    public AddHostAliases(hosts: readonly string[]): void
    {
        this.aliases.Add(hosts)
    }

    /** Removes the journey's aliases from the hosts file. */
    public RemoveHostAliases(): void
    {
        this.aliases.Remove()
    }

    private async HostOf(ingressPrefix: string): Promise<string | undefined>
    {
        const H = HostedCluster
        const A = ClusterArgs
        const listed = await this.runner.Run(H.Kubectl, [A.Context, this.Context, A.Get, H.IngressKind, H.AllNamespaces, A.Output, A.Json], EngineSecrets.ReadTimeoutMs)
        if (!listed.Ok)
        {
            throw new Error(H.ListFailed + listed.Code)
        }
        const items = (JSON.parse(listed.Stdout) as IngressList).items ?? []
        return items.find(item => item.metadata?.name?.startsWith(ingressPrefix) === true)?.spec?.rules?.[0]?.host
    }
}

/** Builds the HostedCluster of a placement (the leg and the staff sign-in share the runner, the starter and the hosts file). */
export class HostedClusters
{
    public constructor(
        private readonly runner: IProcessRunner,
        private readonly starter: IProcessStarter,
        public readonly Aliases: HostAliases = new HostAliases(),
        private readonly abort: LegAbort = new LegAbort(),
        private readonly restartDelayMs: number = HostedCluster.RestartDelayMs)
    {
    }

    public For(placementId: string): HostedCluster
    {
        return new HostedCluster(this.runner, this.starter, placementId, this.Aliases, this.abort, this.restartDelayMs)
    }
}

/** The Hosted path's engine cluster: the one of the placement the Hosted leg recorded in the context. */
export class HostedEngineClusterSource implements IEngineClusterSource
{
    public constructor(private readonly clusters: HostedClusters)
    {
    }

    public For(context: JourneyContext): IEngineCluster
    {
        return this.clusters.For(context.Require(JourneyKeys.HostedPlacement))
    }
}
