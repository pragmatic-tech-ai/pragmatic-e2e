import { LegAbort } from '../waiter.js'
import type { IProcessRunner, ProcessResult } from './process-runner.js'

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

/** The helm and kubectl words the cluster calls use (one home; each call builds its argument vector from them). */
class ClusterArgs
{
    public static readonly KubeContext = '--kube-context'
    public static readonly Context = '--context'
    public static readonly NamespaceFlag = '--namespace'
    public static readonly Uninstall = 'uninstall'
    public static readonly Wait = '--wait'
    public static readonly HelmTimeoutFlag = '--timeout'
    public static readonly HelmUninstallTimeout = '90s'
    public static readonly Delete = 'delete'
    public static readonly NamespaceKind = 'namespace'
    public static readonly NamespacesKind = 'namespaces'
    public static readonly WaitTrue = '--wait=true'
    public static readonly IgnoreNotFound = '--ignore-not-found'
    public static readonly DeleteTimeout = '--timeout=90s'
    public static readonly Get = 'get'
    public static readonly SecretKind = 'secret'
    public static readonly Output = '-o'
    public static readonly Json = 'json'
}

/**
 * The customer-cluster stand-in on hive-laptop (kind `pragmatic-customer`, WSL; runbooks/customer-cluster.md): helm
 * and kubectl by argument vector against its context. `Reset` uninstalls the engine and deletes `pragmatic-system`, the
 * realm sign-in service's namespace and every environment namespace (the engine's kept Secrets go with them), and waits
 * until they are gone, so the next install starts clean. Every program is killed with the running leg's abort and
 * awaited until it exited. Output is never logged, only codes and names.
 */
export class CustomerCluster
{
    public static readonly SystemNamespace = 'pragmatic-system'
    public static readonly OwnerSecret = 'pragmatic-owner-initial'
    public static readonly DevCaSecret = 'pragmatic-tls-dev-ca'
    /** The budget of each step (InstallAndEnrolLeg sizes its deadline from them): reset 3 min, install 8 min. */
    public static readonly ResetBudgetMs = 3 * 60_000
    public static readonly InstallBudgetMs = 8 * 60_000
    private static readonly Helm = 'helm'
    private static readonly Kubectl = 'kubectl'
    private static readonly ContextPrefix = 'kind-'
    private static readonly Release = 'pragmatic-engine'
    private static readonly EngineNamespaces = /^(pragmatic-system|pragmatic-idp-[a-z0-9-]+|pragmatic-env-[a-z0-9-]+)$/
    private static readonly NotFound = /not found/i
    private static readonly StepTimeoutMs = 90_000 + 15_000
    private static readonly ReadTimeoutMs = 30_000
    private static readonly Base64 = 'base64'
    private static readonly Utf8 = 'utf8'
    private static readonly EmailKey = 'email'
    private static readonly PasswordKey = 'password'
    private static readonly CaKey = 'ca.crt'
    private static readonly NoName = ''
    private static readonly UninstallFailed = 'helm uninstall failed with code '
    private static readonly InstallFailed = 'helm install failed with code '
    private static readonly DeleteFailed = 'deleting the engine namespaces failed with code '
    private static readonly ListFailed = 'listing the namespaces failed with code '
    private static readonly NoOwner = 'the engine has no readable Owner sign-in yet (Secret pragmatic-owner-initial)'
    private static readonly NoDevCa = 'the engine has no development CA (Secret pragmatic-tls-dev-ca): was it installed with tls.mode=self-signed?'

    public constructor(private readonly runner: IProcessRunner, private readonly clusterName: string, private readonly abort: LegAbort = new LegAbort())
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
        const A = ClusterArgs
        const uninstall = await this.Run(C.Helm, [A.KubeContext, this.Context, A.Uninstall, C.Release, A.NamespaceFlag, C.SystemNamespace, A.Wait, A.HelmTimeoutFlag, A.HelmUninstallTimeout], C.StepTimeoutMs)
        if (!uninstall.Ok && !C.NotFound.test(uninstall.Stderr))
        {
            throw new Error(C.UninstallFailed + uninstall.Code)
        }
        const namespaces = await this.EngineNamespaces()
        if (namespaces.length > 0)
        {
            const deleted = await this.Run(C.Kubectl, [A.Context, this.Context, A.Delete, A.NamespaceKind, ...namespaces, A.WaitTrue, A.IgnoreNotFound, A.DeleteTimeout], C.StepTimeoutMs)
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
        const installed = await this.Run(C.Helm, argv, C.InstallBudgetMs)
        if (!installed.Ok)
        {
            throw new Error(C.InstallFailed + installed.Code)
        }
    }

    /** The Owner's initial sign-in from the engine's Secret (undefined while it is not there). */
    public async Owner(): Promise<OwnerSignIn | undefined>
    {
        const C = CustomerCluster
        const data = await this.SecretData(C.OwnerSecret)
        const email = data?.[C.EmailKey]
        const password = data?.[C.PasswordKey]
        if (email === undefined || password === undefined)
        {
            return undefined
        }
        return new OwnerSignIn(C.Decoded(email), C.Decoded(password))
    }

    /** The engine's development CA (PEM, possibly a bundle): what the console's certificate must chain to. */
    public async DevCa(): Promise<string>
    {
        const C = CustomerCluster
        const ca = (await this.SecretData(C.DevCaSecret))?.[C.CaKey]
        if (ca === undefined)
        {
            throw new Error(C.NoDevCa)
        }
        return C.Decoded(ca)
    }

    /** The engine's namespaces present now. */
    public async EngineNamespaces(): Promise<string[]>
    {
        const C = CustomerCluster
        const A = ClusterArgs
        const listed = await this.Run(C.Kubectl, [A.Context, this.Context, A.Get, A.NamespacesKind, A.Output, A.Json], C.ReadTimeoutMs)
        if (!listed.Ok)
        {
            throw new Error(C.ListFailed + listed.Code)
        }
        const items = (JSON.parse(listed.Stdout) as { items?: { metadata?: { name?: string } }[] }).items ?? []
        return items.map(item => item.metadata?.name ?? C.NoName).filter(name => C.EngineNamespaces.test(name))
    }

    private async SecretData(name: string): Promise<Record<string, string> | undefined>
    {
        const C = CustomerCluster
        const A = ClusterArgs
        const read = await this.Run(C.Kubectl, [A.Context, this.Context, A.NamespaceFlag, C.SystemNamespace, A.Get, A.SecretKind, name, A.Output, A.Json], C.ReadTimeoutMs)
        if (!read.Ok)
        {
            return undefined
        }
        try
        {
            return (JSON.parse(read.Stdout) as { data?: Record<string, string> }).data ?? {}
        }
        catch
        {
            throw new Error(C.NoOwner)
        }
    }

    /** One program under the running leg's abort: killed with it, awaited until it exited, then the abort raised. */
    private async Run(program: string, argv: readonly string[], timeoutMs: number): Promise<ProcessResult>
    {
        const token = this.abort.Token()
        token.Check()
        const result = await this.runner.Run(program, argv, timeoutMs, token.Signal)
        token.Check()
        return result
    }

    private static Decoded(value: string): string
    {
        return Buffer.from(value, CustomerCluster.Base64).toString(CustomerCluster.Utf8).trim()
    }
}
