import { type IExecFile, NodeExecFile } from '@pragmatic-tech-ai/pragmatic-kube'

/**
 * Makes `host.docker.internal` name this machine inside a kind cluster's pods. The hive agent dials the edge at
 * http://host.docker.internal:7001 and environment servers fetch the tenant IdP's keys at https://host.docker.internal:<port>
 * (the IdP's issuer). Docker Desktop's DNS answers that name in every container; a plain engine (Docker in WSL, Linux)
 * does not, so there CoreDNS gets a `hosts` entry pointing it at the kind network's gateway, which is this machine as the
 * kind node sees it (the edge and the IdP listen on all addresses). On Docker Desktop nothing changes.
 */
export class KindHostAlias
{
    public static readonly HostName = 'host.docker.internal'
    private static readonly Docker = 'docker'
    private static readonly Kubectl = 'kubectl'
    private static readonly DockerInfoArgs: readonly string[] = ['info', '--format', '{{.OperatingSystem}}']
    private static readonly DockerDesktop = 'Docker Desktop'
    private static readonly GatewayArgs: readonly string[] = ['network', 'inspect', 'kind', '--format', '{{range .IPAM.Config}}{{.Gateway}} {{end}}']
    private static readonly ContextFlag = '--context'
    private static readonly NamespaceFlag = '-n'
    private static readonly KubeSystem = 'kube-system'
    private static readonly CorefileGetArgs: readonly string[] = ['get', 'configmap', 'coredns', '-o', 'jsonpath={.data.Corefile}']
    private static readonly CorefilePatchArgs: readonly string[] = ['patch', 'configmap', 'coredns', '--type', 'merge', '-p']
    private static readonly RestartArgs: readonly string[] = ['rollout', 'restart', 'deployment/coredns']
    private static readonly StatusArgs: readonly string[] = ['rollout', 'status', 'deployment/coredns', '--timeout=300s']
    /** Marks the block this class writes, so a re-run replaces it instead of adding a second one. */
    private static readonly Marker = ' # pragmatic-e2e: ' + KindHostAlias.HostName
    private static readonly RootBlockPattern = /^\.:53 \{\n/m
    private static readonly OwnBlockPattern = /^ {4}hosts \{ # pragmatic-e2e: host\.docker\.internal\n(?: {8}.*\n)* {4}\}\n/m
    private static readonly BlockOpen = '    hosts {'
    private static readonly EntryIndent = '\n        '
    private static readonly EntrySeparator = ' '
    private static readonly BlockClose = '\n        fallthrough\n    }\n'
    private static readonly WhitespacePattern = /\s+/
    private static readonly Ipv4Pattern = /^\d{1,3}(?:\.\d{1,3}){3}$/
    private static readonly NoRootBlockMessage = 'the CoreDNS Corefile has no root server block (.:53 {), so host.docker.internal cannot be added'
    private static readonly NoGatewayMessage = 'the kind docker network has no IPv4 gateway: '

    public constructor(private readonly kubeContext: string, private readonly exec: IExecFile = new NodeExecFile())
    {
    }

    /** Adds the alias when the engine needs it; true when it did (CoreDNS restarted and ready), false on Docker Desktop. */
    public async Ensure(): Promise<boolean>
    {
        const A = KindHostAlias
        const engine = (await this.exec.Run(A.Docker, A.DockerInfoArgs)).stdout
        if (engine.includes(A.DockerDesktop))
        {
            return false
        }
        const gateway = A.GatewayOf((await this.exec.Run(A.Docker, A.GatewayArgs)).stdout)
        const corefile = (await this.Kubectl(A.CorefileGetArgs)).stdout
        await this.Kubectl([...A.CorefilePatchArgs, JSON.stringify({ data: { Corefile: A.WithAlias(corefile, gateway) } })])
        await this.Kubectl(A.RestartArgs)
        await this.Kubectl(A.StatusArgs)
        return true
    }

    /** Pure: the Corefile with exactly one alias block (this class's), naming `gateway`, at the top of the root server block. */
    public static WithAlias(corefile: string, gateway: string): string
    {
        const A = KindHostAlias
        const without = corefile.replace(A.OwnBlockPattern, '')
        const root = A.RootBlockPattern.exec(without)
        if (root === null)
        {
            throw new Error(A.NoRootBlockMessage)
        }
        const at = root.index + root[0].length
        const block = A.BlockOpen + A.Marker + A.EntryIndent + gateway + A.EntrySeparator + A.HostName + A.BlockClose
        return without.slice(0, at) + block + without.slice(at)
    }

    /** Pure: the IPv4 gateway among the network's gateways (`docker network inspect` lists IPv6 ones too). */
    public static GatewayOf(gateways: string): string
    {
        const A = KindHostAlias
        const ipv4 = gateways.split(A.WhitespacePattern).find(g => A.Ipv4Pattern.test(g))
        if (ipv4 === undefined)
        {
            throw new Error(A.NoGatewayMessage + gateways.trim())
        }
        return ipv4
    }

    private Kubectl(args: readonly string[]): Promise<{ stdout: string; stderr: string }>
    {
        const A = KindHostAlias
        return this.exec.Run(A.Kubectl, [A.ContextFlag, this.kubeContext, A.NamespaceFlag, A.KubeSystem, ...args])
    }
}
