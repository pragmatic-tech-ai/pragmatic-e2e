import { LegAbort } from '../waiter.js'
import { AbortableRunner, ClusterArgs, EngineSecrets, OwnerSignIn, type IEngineCluster } from './engine-secrets.js'
import type { IProcessRunner, ProcessResult } from './process-runner.js'

export { OwnerSignIn }

/**
 * The customer-cluster stand-in on hive-laptop (kind `pragmatic-customer`, WSL; runbooks/customer-cluster.md): helm
 * and kubectl by argument vector against its context. `Reset` uninstalls the engine and deletes `pragmatic-system`, the
 * realm sign-in service's namespace and every environment namespace (the engine's kept Secrets go with them), and waits
 * until they are gone, so the next install starts clean. Every program is killed with the running leg's abort and
 * awaited until it exited. Output is never logged, only codes and names.
 */
export class CustomerCluster implements IEngineCluster
{
    public static readonly SystemNamespace = EngineSecrets.SystemNamespace
    public static readonly OwnerSecret = EngineSecrets.OwnerSecret
    public static readonly DevCaSecret = EngineSecrets.DevCaSecret
    /** The budget of each step (InstallAndEnrolLeg sizes its deadline from them): reset 3 min, install 8 min. */
    public static readonly ResetBudgetMs = 3 * 60_000
    public static readonly InstallBudgetMs = 8 * 60_000
    private static readonly Helm = 'helm'
    private static readonly Kubectl = 'kubectl'
    private static readonly ContextPrefix = 'kind-'
    private static readonly Release = 'pragmatic-engine'
    private static readonly EngineNamespaces = /^(pragmatic-system|pragmatic-idp-[a-z0-9-]+|pragmatic-env-[a-z0-9-]+)$/
    private static readonly NotFound = /not found/i
    /** Each Reset program's own deadline: helm's and kubectl's 60 s wait plus 10 s to start and answer. */
    public static readonly StepTimeoutMs = 70_000
    public static readonly ReadTimeoutMs = EngineSecrets.ReadTimeoutMs
    /** What Reset can take at most: uninstall, list, delete (160 s), inside ResetBudgetMs (180 s). */
    public static readonly ResetTimeoutsMs: readonly number[] = [CustomerCluster.StepTimeoutMs, CustomerCluster.ReadTimeoutMs, CustomerCluster.StepTimeoutMs]
    private static readonly NoName = ''
    private static readonly UninstallFailed = 'helm uninstall failed with code '
    private static readonly InstallFailed = 'helm install failed with code '
    private static readonly DeleteFailed = 'deleting the engine namespaces failed with code '
    private static readonly ListFailed = 'listing the namespaces failed with code '

    private readonly runner: AbortableRunner
    private readonly secrets: EngineSecrets

    public constructor(runner: IProcessRunner, private readonly clusterName: string, abort: LegAbort = new LegAbort())
    {
        this.runner = new AbortableRunner(runner, abort)
        this.secrets = new EngineSecrets(this.runner, this.Context)
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
    public Owner(): Promise<OwnerSignIn | undefined>
    {
        return this.secrets.Owner()
    }

    /** The engine's development CA (PEM, possibly a bundle): what the console's certificate must chain to. */
    public DevCa(): Promise<string>
    {
        return this.secrets.DevCa()
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

    private Run(program: string, argv: readonly string[], timeoutMs: number): Promise<ProcessResult>
    {
        return this.runner.Run(program, argv, timeoutMs)
    }
}
