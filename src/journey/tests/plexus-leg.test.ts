import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { JourneyContext } from '../journey-context.js'
import { JourneyDependency } from '../journey-dependency.js'
import { JourneyPath } from '../journey-path.js'
import { JourneyKeys, JourneyState } from '../legs/journey-keys.js'
import { PlexusLeg } from '../legs/plexus-leg.js'
import { StaffSignInLeg } from '../legs/staff-sign-in-leg.js'
import { FixedEngineClusterSource } from '../live/engine-secrets.js'
import { CustomerCluster } from '../live/customer-cluster.js'
import { HostAliases } from '../live/hosted-cluster.js'
import { JourneyIdentity } from '../live/journey-identity.js'
import { ProcessResult, type IProcessExecutor, type IProcessRunner, type ProcessOptions } from '../live/process-runner.js'
import { TempFolder, TestEvidence } from './journey-fakes.js'

const RunId = 'run-0001'
const ConsoleHost = 'acme-ab2c.hives.pragmatic-tech.ai'
const Seed = 's'.repeat(40)

class FakeKubectl implements IProcessRunner
{
    public async Run(_program: string, argv: readonly string[]): Promise<ProcessResult>
    {
        if (argv.includes(CustomerCluster.DevCaSecret))
        {
            return new ProcessResult(0, JSON.stringify({ data: { 'ca.crt': Buffer.from('PEM-BODY').toString('base64') } }), '')
        }
        return new ProcessResult(1, '', 'unexpected')
    }
}

class FakeExecutor implements IProcessExecutor
{
    public readonly Spawns: Array<{ Program: string, Argv: readonly string[], Options: ProcessOptions, CaText: string, PasswordText: string }> = []
    public Code = 0
    public Stdout = 'ok'
    public Stderr = ''

    public async Execute(program: string, argv: readonly string[], options: ProcessOptions | undefined): Promise<ProcessResult>
    {
        const opts = options!
        const ca = opts.Env['NODE_EXTRA_CA_CERTS']
        const pw = opts.Env['PLEXUS_JOURNEY_PASSWORD_FILE']
        this.Spawns.push({ Program: program, Argv: argv, Options: opts, CaText: ca !== undefined && existsSync(ca) ? readFileSync(ca, 'utf8') : '', PasswordText: pw !== undefined && existsSync(pw) ? readFileSync(pw, 'utf8') : '' })
        return new ProcessResult(this.Code, this.Stdout, this.Stderr)
    }
}

class PlexusWorld
{
    public readonly Evidence = new TestEvidence()
    public readonly Hosts = new TempFolder()
    public readonly HostsFile = join(this.Hosts.Path, 'hosts')
    public readonly Executor = new FakeExecutor()
    public readonly Identity = new JourneyIdentity(JourneyPath.Hosted, 'pragmatic-lab.com', Seed)
    public readonly Context = new JourneyContext(RunId, JourneyPath.Hosted)

    public constructor(public readonly Repo: string = '/repos/plexus')
    {
        writeFileSync(this.HostsFile, '127.0.0.1 localhost\n')
        this.Context.Set(JourneyKeys.ConsoleHost, ConsoleHost)
    }

    public Leg(): PlexusLeg
    {
        return new PlexusLeg(new FixedEngineClusterSource(new CustomerCluster(new FakeKubectl(), 'c')), this.Identity, this.Executor, this.Evidence.Evidence, JourneyDependency.HostedPlacement, new HostAliases(this.HostsFile), this.Repo)
    }

    public Dispose(): void
    {
        this.Evidence.Folder.Dispose()
        this.Hosts.Dispose()
    }
}

describe('PlexusLeg', () =>
{
    it('depends on delivery, the hive and the Plexus sign-in', () =>
    {
        const w = new PlexusWorld()
        assert.deepEqual(w.Leg().Dependencies, [JourneyDependency.EntitlementDelivery, JourneyDependency.HostedPlacement, JourneyDependency.PlexusRealmSignIn])
        w.Dispose()
    })

    it('spawns the Plexus journey spec with the env realm address, the CA file and a password file', async () =>
    {
        const w = new PlexusWorld()
        await w.Leg().Run(w.Context)
        assert.equal(w.Executor.Spawns.length, 1)
        const spawn = w.Executor.Spawns[0]
        const env = spawn.Options.Env
        const host = 'journey.' + ConsoleHost
        const email = StaffSignInLeg.EmailFor(RunId)
        assert.equal(spawn.Program, 'xvfb-run')
        assert.deepEqual(spawn.Argv, ['-a', '--server-args=-screen 0 1920x1080x24', 'npx', 'playwright', 'test', 'e2e/journey', '--reporter=line'])
        assert.equal(spawn.Options.Cwd, join('/repos/plexus', 'apps/plexus'))
        assert.equal(env['SP_JOURNEY_E2E'], '1')
        assert.equal(env['PLEXUS_JOURNEY_EMAIL'], email)
        assert.equal(env['PLEXUS_PLATFORM_ADDRESS'], 'https://' + host + ':28444')
        assert.equal(env['PLEXUS_JOURNEY_RUNTIME_WS_URL'], 'wss://' + host + ':28444')
        assert.equal(spawn.CaText, 'PEM-BODY')
        const password = w.Identity.StaffPassword(email)
        assert.equal(spawn.PasswordText, password)
        assert.ok(!Object.values(env).some(v => v === password), 'the password is never an environment value')
        assert.ok(readFileSync(w.HostsFile, 'utf8').includes('127.0.0.1 ' + host), 'the env realm host is aliased')
        assert.equal(w.Context.Get(JourneyKeys.PlexusState), JourneyState.PlexusSignedIn)
        assert.ok(!w.Evidence.Sink.Lines.some(l => l.includes(password)))
        w.Dispose()
    })

    it('fails with the redacted output tail on a non-zero exit', async () =>
    {
        const w = new PlexusWorld()
        const password = w.Identity.StaffPassword(StaffSignInLeg.EmailFor(RunId))
        w.Executor.Code = 1
        w.Executor.Stdout = 'x'.repeat(10000) + ' the deploy broke ' + password
        await assert.rejects(() => w.Leg().Run(w.Context), (error: Error) =>
            error.message.includes('the deploy broke') && !error.message.includes(password) && error.message.length < 6000)
        assert.equal(w.Context.Get(JourneyKeys.PlexusState), undefined)
        w.Dispose()
    })

    it('fails when the Plexus repository is not configured', async () =>
    {
        const w = new PlexusWorld('')
        await assert.rejects(() => w.Leg().Run(w.Context), /PRAGMATIC_PLEXUS_REPO/)
        assert.equal(w.Executor.Spawns.length, 0)
        w.Dispose()
    })

    it('cleans with an evidence step and no process', async () =>
    {
        const w = new PlexusWorld()
        await w.Leg().Clean(w.Context)
        assert.equal(w.Executor.Spawns.length, 0)
        w.Dispose()
    })
})
