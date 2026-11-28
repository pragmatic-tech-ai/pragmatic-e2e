import type { JourneyContext } from '../journey-context.js'
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

/** What a leg needs of an installed engine's cluster: the Owner's sign-in and the development CA its certificates chain to. */
export interface IEngineCluster
{
    /** The Owner's initial sign-in from the engine's Secret (undefined while it is not there). */
    Owner(): Promise<OwnerSignIn | undefined>
    /** The engine's development CA (PEM, possibly a bundle). */
    DevCa(): Promise<string>
}

/** Which engine cluster a run's legs read, resolved when the leg runs (a Hosted placement is known only then). */
export interface IEngineClusterSource
{
    For(context: JourneyContext): IEngineCluster
}

/** The same engine cluster for every run (the customer-cluster stand-in). */
export class FixedEngineClusterSource implements IEngineClusterSource
{
    public constructor(private readonly cluster: IEngineCluster)
    {
    }

    public For(_context: JourneyContext): IEngineCluster
    {
        return this.cluster
    }
}

/** The helm and kubectl words the cluster calls use (one home; each call builds its argument vector from them). */
export class ClusterArgs
{
    public static readonly KubeContext = '--kube-context'
    public static readonly Context = '--context'
    public static readonly NamespaceFlag = '--namespace'
    public static readonly Uninstall = 'uninstall'
    public static readonly Wait = '--wait'
    public static readonly HelmTimeoutFlag = '--timeout'
    public static readonly HelmUninstallTimeout = '60s'
    public static readonly Delete = 'delete'
    public static readonly NamespaceKind = 'namespace'
    public static readonly NamespacesKind = 'namespaces'
    public static readonly WaitTrue = '--wait=true'
    public static readonly IgnoreNotFound = '--ignore-not-found'
    public static readonly DeleteTimeout = '--timeout=60s'
    public static readonly Get = 'get'
    public static readonly SecretKind = 'secret'
    public static readonly Output = '-o'
    public static readonly Json = 'json'
}

/** A runner whose every program is killed with the running leg's abort and awaited until it exited. */
export class AbortableRunner
{
    public constructor(private readonly runner: IProcessRunner, private readonly abort: LegAbort = new LegAbort())
    {
    }

    /** One program under the running leg's abort: killed with it, awaited until it exited, then the abort raised. */
    public async Run(program: string, argv: readonly string[], timeoutMs: number): Promise<ProcessResult>
    {
        const token = this.abort.Token()
        token.Check()
        const result = await this.runner.Run(program, argv, timeoutMs, token.Signal)
        token.Check()
        return result
    }
}

/**
 * The engine's own Secrets in `pragmatic-system`, read with kubectl against one kubeconfig context: the Owner's initial
 * sign-in and the development CA. The same reads serve the customer cluster and a Hosted hive's cluster.
 */
export class EngineSecrets implements IEngineCluster
{
    public static readonly SystemNamespace = 'pragmatic-system'
    public static readonly OwnerSecret = 'pragmatic-owner-initial'
    public static readonly DevCaSecret = 'pragmatic-tls-dev-ca'
    public static readonly ReadTimeoutMs = 20_000
    private static readonly Kubectl = 'kubectl'
    private static readonly Base64 = 'base64'
    private static readonly Utf8 = 'utf8'
    private static readonly EmailKey = 'email'
    private static readonly PasswordKey = 'password'
    private static readonly CaKey = 'ca.crt'
    private static readonly Unreadable = 'the engine Secret is not readable JSON: '
    private static readonly NoDevCa = 'the engine has no development CA (Secret pragmatic-tls-dev-ca): was it installed with tls.mode=self-signed?'

    public constructor(private readonly runner: AbortableRunner, private readonly context: string)
    {
    }

    public async Owner(): Promise<OwnerSignIn | undefined>
    {
        const S = EngineSecrets
        const data = await this.SecretData(S.OwnerSecret)
        const email = data?.[S.EmailKey]
        const password = data?.[S.PasswordKey]
        if (email === undefined || password === undefined)
        {
            return undefined
        }
        return new OwnerSignIn(S.Decoded(email), S.Decoded(password))
    }

    public async DevCa(): Promise<string>
    {
        const S = EngineSecrets
        const ca = (await this.SecretData(S.DevCaSecret))?.[S.CaKey]
        if (ca === undefined)
        {
            throw new Error(S.NoDevCa)
        }
        return S.Decoded(ca)
    }

    private async SecretData(name: string): Promise<Record<string, string> | undefined>
    {
        const S = EngineSecrets
        const A = ClusterArgs
        const read = await this.runner.Run(S.Kubectl, [A.Context, this.context, A.NamespaceFlag, S.SystemNamespace, A.Get, A.SecretKind, name, A.Output, A.Json], S.ReadTimeoutMs)
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
            throw new Error(S.Unreadable + name)
        }
    }

    private static Decoded(value: string): string
    {
        return Buffer.from(value, EngineSecrets.Base64).toString(EngineSecrets.Utf8).trim()
    }
}
