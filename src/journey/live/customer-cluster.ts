import type { IProcessRunner } from './process-runner.js'

/**
 * The Owner's initial sign-in of an installed engine (Secret `pragmatic-owner-initial`): handed straight to the
 * browser fill, never written to the context, the evidence or a log (its string form names nothing).
 */
export class OwnerSignIn
{
    private static readonly Redacted = '[owner sign-in]'

    public constructor(public readonly Email: string, public readonly Password: string)
    {
    }

    public toString(): string
    {
        return OwnerSignIn.Redacted
    }

    public toJSON(): string
    {
        return OwnerSignIn.Redacted
    }
}

/**
 * The customer-cluster stand-in on hive-laptop (kind `pragmatic-customer`, WSL; runbooks/customer-cluster.md): helm
 * and kubectl by argument vector against its context. `Reset` uninstalls the engine and deletes `pragmatic-system`, the
 * realm sign-in service's namespace and every environment namespace (the engine's kept Secrets go with them), and waits
 * until they are gone, so the next install starts clean. Output is never logged, only codes and names.
 */
export class CustomerCluster
{
    public static readonly SystemNamespace = 'pragmatic-system'
    public static readonly OwnerSecret = 'pragmatic-owner-initial'
    private static readonly Helm = 'helm'
    private static readonly Kubectl = 'kubectl'
    private static readonly ContextPrefix = 'kind-'
    private static readonly Release = 'pragmatic-engine'
    private static readonly EngineNamespaces = /^(pragmatic-system|pragmatic-idp-[a-z0-9-]+|pragmatic-env-[a-z0-9-]+)$/
    private static readonly NotFound = /not found/i
    private static readonly HelmTimeoutMs = 20 * 60_000
    private static readonly KubectlTimeoutMs = 6 * 60_000
    private static readonly Base64 = 'base64'
    private static readonly Utf8 = 'utf8'
    private static readonly EmailKey = 'email'
    private static readonly PasswordKey = 'password'
    private static readonly UninstallFailed = 'helm uninstall failed with code '
    private static readonly InstallFailed = 'helm install failed with code '
    private static readonly DeleteFailed = 'deleting the engine namespaces failed with code '
    private static readonly ListFailed = 'listing the namespaces failed with code '
    private static readonly NoOwner = 'the engine has no readable Owner sign-in yet (Secret pragmatic-owner-initial)'

    public constructor(private readonly runner: IProcessRunner, private readonly clusterName: string)
    {
    }

    /** The kubeconfig context of the cluster (`kind-<name>`). */
    public get Context(): string
    {
        return CustomerCluster.ContextPrefix + this.clusterName
    }

    /** Uninstalls the engine (absent is fine) and deletes its namespaces, waiting until they are gone. Returns their names. */
    public async Reset(): Promise<string[]>
    {
        const C = CustomerCluster
        const uninstall = await this.runner.Run(C.Helm, ['--kube-context', this.Context, 'uninstall', C.Release, '--namespace', C.SystemNamespace, '--wait'], C.HelmTimeoutMs)
        if (!uninstall.Ok && !C.NotFound.test(uninstall.Stderr))
        {
            throw new Error(C.UninstallFailed + uninstall.Code)
        }
        const namespaces = await this.EngineNamespaces()
        if (namespaces.length > 0)
        {
            const deleted = await this.runner.Run(C.Kubectl, ['--context', this.Context, 'delete', 'namespace', ...namespaces, '--wait=true', '--ignore-not-found', '--timeout=5m'], C.KubectlTimeoutMs)
            if (!deleted.Ok)
            {
                throw new Error(C.DeleteFailed + deleted.Code)
            }
        }
        return namespaces
    }

    /** Runs helm with the install's argument vector (EngineInstallCommand.Argv); throws with the code when it fails. */
    public async Install(argv: readonly string[]): Promise<void>
    {
        const C = CustomerCluster
        const installed = await this.runner.Run(C.Helm, argv, C.HelmTimeoutMs)
        if (!installed.Ok)
        {
            throw new Error(C.InstallFailed + installed.Code)
        }
    }

    /** The Owner's initial sign-in from the engine's Secret (undefined while it is not there). */
    public async Owner(): Promise<OwnerSignIn | undefined>
    {
        const C = CustomerCluster
        const read = await this.runner.Run(C.Kubectl, ['--context', this.Context, '--namespace', C.SystemNamespace, 'get', 'secret', C.OwnerSecret, '-o', 'json'], C.KubectlTimeoutMs)
        if (!read.Ok)
        {
            return undefined
        }
        try
        {
            const data = (JSON.parse(read.Stdout) as { data?: Record<string, string> }).data ?? {}
            const email = data[C.EmailKey]
            const password = data[C.PasswordKey]
            if (email === undefined || password === undefined)
            {
                return undefined
            }
            return new OwnerSignIn(Buffer.from(email, C.Base64).toString(C.Utf8).trim(), Buffer.from(password, C.Base64).toString(C.Utf8).trim())
        }
        catch
        {
            throw new Error(C.NoOwner)
        }
    }

    /** The engine's namespaces present now. */
    public async EngineNamespaces(): Promise<string[]>
    {
        const C = CustomerCluster
        const listed = await this.runner.Run(C.Kubectl, ['--context', this.Context, 'get', 'namespaces', '-o', 'json'], C.KubectlTimeoutMs)
        if (!listed.Ok)
        {
            throw new Error(C.ListFailed + listed.Code)
        }
        const items = (JSON.parse(listed.Stdout) as { items?: { metadata?: { name?: string } }[] }).items ?? []
        return items.map(item => item.metadata?.name ?? '').filter(name => C.EngineNamespaces.test(name))
    }
}
