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
const ConsoleUrl = 'https://acme-ab2c.hives.pragmatic-tech.ai:28444/'
const IdpHost = 'idp-acme.hives.pragmatic-tech.ai'
const Tenant = 'acme'
const PlatformAddress = 'https://agent.pragmatic-tech.ai'
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
    public readonly Spawns: Array<{ Program: string, Argv: readonly string[], Options: ProcessOptions, CaText: string, IdpCaText: string, PasswordText: string }> = []
    public Code = 0
    public Stdout = 'ok'
    public Stderr = ''

    public async Execute(program: string, argv: readonly string[], options: ProcessOptions | undefined): Promise<ProcessResult>
    {
        const opts = options!
        const ca = opts.Env['PLEXUS_E2E_DESKTOP_CA_FILE']
        const idpCa = opts.Env['PLEXUS_E2E_IDP_CA_FILE']
        const pw = opts.Env['PLEXUS_E2E_OWNER_PASSWORD_FILE']
        this.Spawns.push({ Program: program, Argv: argv, Options: opts, CaText: ca !== undefined && existsSync(ca) ? readFileSync(ca, 'utf8') : '', IdpCaText: idpCa !== undefined && existsSync(idpCa) ? readFileSync(idpCa, 'utf8') : '', PasswordText: pw !== undefined && existsSync(pw) ? readFileSync(pw, 'utf8') : '' })
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
        this.Context.Set(JourneyKeys.ConsoleUrl, ConsoleUrl)
        this.Context.Set(JourneyKeys.IdpHost, IdpHost)
        this.Context.Set(JourneyKeys.Tenant, Tenant)
    }

    public Leg(): PlexusLeg
    {
        return new PlexusLeg(new FixedEngineClusterSource(new CustomerCluster(new FakeKubectl(), 'c')), this.Identity, this.Executor, this.Evidence.Evidence, JourneyDependency.HostedPlacement, new HostAliases(this.HostsFile), PlatformAddress, this.Repo)
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

    it('spawns the Plexus journey spec as the staff account at the environment realm with the canonical E2E inputs', async () =>
    {
        const w = new PlexusWorld()
        await w.Leg().Run(w.Context)
        assert.equal(w.Executor.Spawns.length, 1)
        const spawn = w.Executor.Spawns[0]
        const env = spawn.Options.Env
        const staffEmail = StaffSignInLeg.EmailFor(RunId)
        const staffPassword = w.Identity.StaffPassword(staffEmail)
        assert.equal(spawn.Program, 'xvfb-run')
        assert.deepEqual(spawn.Argv, ['-a', '--server-args=-screen 0 1920x1080x24', 'npx', 'playwright', 'test', 'e2e/journey', '--reporter=line'])
        assert.equal(spawn.Options.Cwd, join('/repos/plexus', 'apps/plexus'))
        assert.equal(env['SP_JOURNEY_E2E'], '1')
        assert.equal(env['PLEXUS_E2E_SIGN_IN'], 'realm')
        assert.equal(env['PLEXUS_E2E_PLATFORM_ADDRESS'], PlatformAddress)
        assert.equal(env['PLEXUS_E2E_OWNER_EMAIL'], staffEmail)
        assert.equal(spawn.PasswordText, staffPassword)
        assert.equal(spawn.CaText, 'PEM-BODY')
        assert.equal(spawn.IdpCaText, 'PEM-BODY')
        assert.equal(env['PLEXUS_E2E_IDP_LOGIN'], 'browser')
        assert.equal(env['PLEXUS_E2E_IDP_CERT_FILE'], env['PLEXUS_E2E_IDP_CA_FILE'], 'the idp cert pin reuses the dev-CA file')
        assert.equal(env['PLEXUS_E2E_REALM_ISSUER'], 'https://' + IdpHost + '/realms/' + Tenant)
        assert.equal(env['PLEXUS_JOURNEY_ENVIRONMENT'], StaffSignInLeg.Environment)
        assert.equal(env['PLEXUS_JOURNEY_CONSOLE_ADDRESS'], ConsoleUrl)
        assert.equal(env['NODE_EXTRA_CA_CERTS'], undefined, 'the canonical launcher sets the node CA itself')
        assert.ok(!Object.values(env).some(v => v === staffPassword), 'the password is never an environment value')
        const hosts = readFileSync(w.HostsFile, 'utf8')
        assert.ok(hosts.includes('127.0.0.1 ' + ConsoleHost), 'the console host is aliased')
        assert.ok(hosts.includes('127.0.0.1 ' + IdpHost), 'the idp host is aliased')
        assert.equal(w.Context.Get(JourneyKeys.PlexusState), JourneyState.PlexusSignedIn)
        assert.ok(!w.Evidence.Sink.Lines.some(l => l.includes(staffPassword)))
        w.Dispose()
    })

    it('uses the PLEXUS_JOURNEY_REALM_ISSUER override verbatim for the realm issuer', async () =>
    {
        const w = new PlexusWorld()
        const previous = process.env['PLEXUS_JOURNEY_REALM_ISSUER']
        process.env['PLEXUS_JOURNEY_REALM_ISSUER'] = 'https://pinned.example/realms/pinned'
        try
        {
            await w.Leg().Run(w.Context)
            assert.equal(w.Executor.Spawns[0].Options.Env['PLEXUS_E2E_REALM_ISSUER'], 'https://pinned.example/realms/pinned')
        }
        finally
        {
            if (previous === undefined)
            {
                delete process.env['PLEXUS_JOURNEY_REALM_ISSUER']
            }
            else
            {
                process.env['PLEXUS_JOURNEY_REALM_ISSUER'] = previous
            }
            w.Dispose()
        }
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
