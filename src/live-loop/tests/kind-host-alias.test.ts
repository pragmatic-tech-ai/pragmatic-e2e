import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { IExecFile } from '@pragmatic-tech-ai/pragmatic-kube'
import { KindHostAlias } from '../kind-host-alias.js'

/** Answers each program by the first argument after any `--context <name>` pair; records every call. */
class FakeExec implements IExecFile
{
    public readonly Calls: string[] = []

    public constructor(private readonly answers: Record<string, string>)
    {
    }

    public async Run(file: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }>
    {
        const line = file + ' ' + args.join(' ')
        this.Calls.push(line)
        const key = Object.keys(this.answers).find(k => line.startsWith(k))
        return { stdout: key === undefined ? '' : this.answers[key]!, stderr: '' }
    }
}

class AliasFx
{
    public static readonly KindCorefile = '.:53 {\n    errors\n    ready\n    forward . /etc/resolv.conf {\n       max_concurrent 1000\n    }\n    cache 30\n    reload\n}\n'
    public static readonly DockerInfo = 'docker info --format {{.OperatingSystem}}'
    public static readonly NetworkInspect = 'docker network inspect kind'
    public static readonly CorefileGet = 'kubectl --context kind-x -n kube-system get configmap coredns'
    public static readonly CorefilePatch = 'kubectl --context kind-x -n kube-system patch configmap coredns'
}

describe('KindHostAlias.WithAlias', () =>
{
    it('adds a hosts block naming host.docker.internal at the gateway inside the root server block, falling through for every other name', () =>
    {
        const out = KindHostAlias.WithAlias(AliasFx.KindCorefile, '172.19.0.1')
        assert.match(out, /^\.:53 \{\n    hosts \{ # pragmatic-e2e: host\.docker\.internal\n        172\.19\.0\.1 host\.docker\.internal\n        fallthrough\n    \}\n    errors\n/)
        assert.ok(out.endsWith('    reload\n}\n'))
    })

    it('replaces its own earlier block, so a re-run with a new gateway leaves exactly one', () =>
    {
        const once = KindHostAlias.WithAlias(AliasFx.KindCorefile, '172.19.0.1')
        const twice = KindHostAlias.WithAlias(once, '172.20.0.1')
        assert.equal((twice.match(/hosts \{/g) ?? []).length, 1)
        assert.ok(twice.includes('172.20.0.1 host.docker.internal'))
        assert.ok(!twice.includes('172.19.0.1'))
        assert.equal(KindHostAlias.WithAlias(twice, '172.20.0.1'), twice)
    })

    it('refuses a Corefile without a root server block', () =>
    {
        assert.throws(() => KindHostAlias.WithAlias('example.org:53 {\n}\n', '172.19.0.1'), /no root server block/)
    })
})

describe('KindHostAlias.GatewayOf', () =>
{
    it('picks the IPv4 gateway of the kind network', () =>
    {
        assert.equal(KindHostAlias.GatewayOf('fc00:f853:ccd:e793::1 172.19.0.1 '), '172.19.0.1')
    })

    it('refuses a network without an IPv4 gateway', () =>
    {
        assert.throws(() => KindHostAlias.GatewayOf('fc00::1 '), /no IPv4 gateway/)
    })
})

describe('KindHostAlias.Ensure', () =>
{
    it('does nothing on Docker Desktop, whose own DNS already answers host.docker.internal in pods', async () =>
    {
        const exec = new FakeExec({ [AliasFx.DockerInfo]: 'Docker Desktop\n' })
        assert.equal(await new KindHostAlias('kind-x', exec).Ensure(), false)
        assert.deepEqual(exec.Calls, [AliasFx.DockerInfo])
    })

    it('on a plain engine (WSL, Linux) maps host.docker.internal to the kind network gateway in CoreDNS and restarts CoreDNS', async () =>
    {
        const exec = new FakeExec({
            [AliasFx.DockerInfo]: 'Ubuntu 26.04.1 LTS\n',
            [AliasFx.NetworkInspect]: 'fc00::1 172.19.0.1 \n',
            [AliasFx.CorefileGet]: AliasFx.KindCorefile,
        })
        assert.equal(await new KindHostAlias('kind-x', exec).Ensure(), true)
        const patch = exec.Calls.find(c => c.startsWith(AliasFx.CorefilePatch))
        assert.ok(patch !== undefined)
        const body = JSON.parse(patch.slice(patch.indexOf('{'))) as { data: { Corefile: string } }
        assert.equal(body.data.Corefile, KindHostAlias.WithAlias(AliasFx.KindCorefile, '172.19.0.1'))
        assert.deepEqual(exec.Calls.slice(-2), [
            'kubectl --context kind-x -n kube-system rollout restart deployment/coredns',
            'kubectl --context kind-x -n kube-system rollout status deployment/coredns --timeout=300s',
        ])
    })
})
