import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HostAliases, HostedCluster } from '../live/hosted-cluster.js'
import { EngineSecrets } from '../live/engine-secrets.js'
import { ProcessResult, type IProcessRunner } from '../live/process-runner.js'
import { FakeStarter, TempFolder } from './journey-fakes.js'

const Placement = 'ab2c'
const Context = 'kind-pragmatic-hosted-ab2c'
const ConsoleHost = 'acme-ab2c.hives.pragmatic-tech.ai'
const IdpHost = 'idp-acme.acme-ab2c.hives.pragmatic-tech.ai'

const Ingresses = {
    items: [
        { metadata: { name: 'other', namespace: 'default' }, spec: { rules: [{ host: 'other.example' }] } },
        { metadata: { name: 'pragmatic-idp-acme', namespace: 'pragmatic-idp-acme' }, spec: { rules: [{ host: IdpHost }] } },
        { metadata: { name: 'pragmatic-tenant-admin-acme', namespace: 'pragmatic-system' }, spec: { rules: [{ host: ConsoleHost }] } },
    ],
}

class FakeKube implements IProcessRunner
{
    public readonly Calls: string[][] = []
    public IngressJson: string = JSON.stringify(Ingresses)

    public async Run(program: string, argv: readonly string[], _timeoutMs: number): Promise<ProcessResult>
    {
        this.Calls.push([program, ...argv])
        if (argv.includes('ingress'))
        {
            return new ProcessResult(0, this.IngressJson, '')
        }
        if (argv.includes('pragmatic-owner-initial'))
        {
            return new ProcessResult(0, JSON.stringify({ data: { email: Buffer.from('o@x.test').toString('base64'), password: Buffer.from('pw-1').toString('base64') } }), '')
        }
        if (argv.includes('pragmatic-tls-dev-ca'))
        {
            return new ProcessResult(0, JSON.stringify({ data: { 'ca.crt': Buffer.from('PEM').toString('base64') } }), '')
        }
        return new ProcessResult(1, '', 'unexpected')
    }
}

describe('HostedCluster', () =>
{
    it('reads the console and idp hosts from the ingresses by name', async () =>
    {
        const kube = new FakeKube()
        const folder = new TempFolder()
        const cluster = new HostedCluster(kube, new FakeStarter(), Placement, new HostAliases(join(folder.Path, 'hosts')))
        assert.equal(cluster.Context, Context)
        assert.equal(await cluster.ConsoleHost(), ConsoleHost)
        assert.equal(await cluster.IdpHost(), IdpHost)
        assert.deepEqual(kube.Calls[0], ['kubectl', '--context', Context, 'get', 'ingress', '--all-namespaces', '-o', 'json'])
        kube.IngressJson = JSON.stringify({ items: [] })
        assert.equal(await cluster.ConsoleHost(), undefined)
        assert.equal(await cluster.IdpHost(), undefined)
        folder.Dispose()
    })

    it('reads the Owner sign-in and the dev CA like the enrolled cluster', async () =>
    {
        const kube = new FakeKube()
        const folder = new TempFolder()
        const cluster = new HostedCluster(kube, new FakeStarter(), Placement, new HostAliases(join(folder.Path, 'hosts')))
        const owner = await cluster.Owner()
        assert.equal(owner?.Email, 'o@x.test')
        assert.equal(owner?.Password, 'pw-1')
        assert.equal(await cluster.DevCa(), 'PEM')
        assert.deepEqual(kube.Calls[0], ['kubectl', '--context', Context, '--namespace', EngineSecrets.SystemNamespace, 'get', 'secret', 'pragmatic-owner-initial', '-o', 'json'])
        folder.Dispose()
    })

    it('port-forwards ingress-nginx on the local port and restarts the forward when it exits, until stopped', async () =>
    {
        const starter = new FakeStarter()
        const folder = new TempFolder()
        const cluster = new HostedCluster(new FakeKube(), starter, Placement, new HostAliases(join(folder.Path, 'hosts')), undefined, 0)
        const reach = cluster.StartConsoleReach(HostedCluster.ConsolePort)
        assert.equal(starter.Started.length, 1)
        assert.equal(starter.Started[0]?.Program, 'kubectl')
        assert.deepEqual(starter.Started[0]?.Argv, ['--context', Context, 'port-forward', '--namespace', 'ingress-nginx', '--address', '127.0.0.1', 'svc/ingress-nginx-controller', HostedCluster.ConsolePort + ':443'])
        starter.Started[0]?.OnExit(1)
        await new Promise(resolve => setTimeout(resolve, 20))
        assert.equal(starter.Started.length, 2, 'restarted after the forward died')
        await reach.Stop()
        assert.equal(starter.Started[1]?.Stopped, true)
        starter.Started[1]?.OnExit(0)
        await new Promise(resolve => setTimeout(resolve, 20))
        assert.equal(starter.Started.length, 2, 'a stopped forward is not restarted')
        folder.Dispose()
    })
})

describe('HostAliases', () =>
{
    it('appends marked loopback lines idempotently and removes exactly its own', () =>
    {
        const folder = new TempFolder()
        const file = join(folder.Path, 'hosts')
        writeFileSync(file, '127.0.0.1 localhost\n10.0.0.1 keep.me # mine\n')
        const aliases = new HostAliases(file)
        aliases.Add([ConsoleHost, IdpHost])
        aliases.Add([ConsoleHost])
        const text = readFileSync(file, 'utf8')
        assert.equal(text.split('\n').filter(line => line === '127.0.0.1 ' + ConsoleHost + ' # pragmatic-e2e-journey').length, 1, 'added once')
        assert.ok(text.includes('127.0.0.1 ' + ConsoleHost + ' # pragmatic-e2e-journey\n'))
        assert.ok(text.includes('127.0.0.1 ' + IdpHost + ' # pragmatic-e2e-journey\n'))
        aliases.Remove()
        assert.equal(readFileSync(file, 'utf8'), '127.0.0.1 localhost\n10.0.0.1 keep.me # mine\n')
        aliases.Remove()
        assert.equal(readFileSync(file, 'utf8'), '127.0.0.1 localhost\n10.0.0.1 keep.me # mine\n')
        folder.Dispose()
    })
})
