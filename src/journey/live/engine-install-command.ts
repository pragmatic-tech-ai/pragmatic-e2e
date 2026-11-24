/**
 * The install command the cabinet shows for an Enrolled or Delegated hive (pragmatic-platform-admin
 * `EngineInstallCommand`): `helm install pragmatic-engine oci://ghcr.io/pragmatic-tech-ai/charts/pragmatic-engine
 * --version <release> --namespace pragmatic-system --create-namespace --set tenant.id=<tenant>` and the placeholders
 * the customer fills (console host, TLS Secret). On the page it wraps over several text elements: the first names the
 * release, chart and version, another the tenant. The journey runs exactly that chart and version for that tenant on
 * the proof cluster, filling the placeholders the proof cluster's way (a localtest.me console host on ingress port
 * 28443, the engine's self-signed certificate), as an argument vector.
 */
export class EngineInstallCommand
{
    public static readonly Release = 'pragmatic-engine'
    public static readonly Chart = 'oci://ghcr.io/pragmatic-tech-ai/charts/pragmatic-engine'
    public static readonly Namespace = 'pragmatic-system'
    public static readonly ConsolePort = '28443'
    public static readonly ConsoleDomain = 'localtest.me'
    private static readonly FirstLine = /helm install (\S+) (\S+) --version (\S+)/
    private static readonly TenantFlag = /tenant\.id=([a-z][a-z0-9-]{1,30}[a-z0-9])\b/
    private static readonly VersionPattern = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/
    private static readonly ConsolePrefix = 'console-'
    private static readonly Dot = '.'
    private static readonly NotTheCommand = 'the cabinet\'s install command does not name the engine chart and a version: '
    private static readonly OtherTenant = 'the cabinet\'s install command names another tenant than the run\'s: '
    private static readonly WaitTimeout = '15m'
    private static readonly Scheme = 'https://'
    private static readonly PortSeparator = ':'
    private static readonly Root = '/'

    private constructor(public readonly Version: string, public readonly Tenant: string)
    {
    }

    /** From the command's first text element (release, chart, version) and the one naming the tenant. */
    public static Parse(firstLine: string, tenantLine: string, expectedTenant: string): EngineInstallCommand
    {
        const E = EngineInstallCommand
        const head = E.FirstLine.exec(firstLine.replace(/\s+/g, ' '))
        if (head === null || head[1] !== E.Release || head[2] !== E.Chart || !E.VersionPattern.test(head[3] ?? ''))
        {
            throw new Error(E.NotTheCommand + firstLine.trim())
        }
        const tenant = E.TenantFlag.exec(tenantLine)?.[1]
        if (tenant !== expectedTenant)
        {
            throw new Error(E.OtherTenant + (tenant ?? tenantLine.trim()))
        }
        return new EngineInstallCommand(head[3] as string, tenant)
    }

    /** The console's host on the proof cluster: `console-<tenant>.localtest.me` (resolves to the ingress on WSL). */
    public get ConsoleHost(): string
    {
        return EngineInstallCommand.ConsolePrefix + this.Tenant + EngineInstallCommand.Dot + EngineInstallCommand.ConsoleDomain
    }

    public get ConsoleUrl(): string
    {
        const E = EngineInstallCommand
        return E.Scheme + this.ConsoleHost + E.PortSeparator + E.ConsolePort + E.Root
    }

    /** helm's argument vector: the command's chart, version, namespace and tenant, the placeholders filled for the proof cluster. */
    public Argv(kubeContext: string): string[]
    {
        const E = EngineInstallCommand
        return [
            '--kube-context', kubeContext, 'install', E.Release, E.Chart, '--version', this.Version,
            '--namespace', E.Namespace, '--create-namespace',
            '--set', 'tenant.id=' + this.Tenant,
            '--set', 'console.host=' + this.ConsoleHost,
            '--set', 'console.port=' + E.ConsolePort,
            '--set', 'tls.mode=self-signed',
            '--wait', '--timeout', E.WaitTimeout,
        ]
    }
}
