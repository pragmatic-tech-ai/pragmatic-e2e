import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Evidence } from '../evidence.js'
import type { JourneyContext } from '../journey-context.js'
import { JourneyDependency } from '../journey-dependency.js'
import type { IJourneyLeg } from '../journey-leg.js'
import type { IEngineClusterSource } from '../live/engine-secrets.js'
import type { HostAliases } from '../live/hosted-cluster.js'
import type { JourneyIdentity } from '../live/journey-identity.js'
import { ProcessOptions, type IProcessExecutor } from '../live/process-runner.js'
import { WaitAbortError } from '../waiter.js'
import { JourneyKeys, JourneyLegName, JourneyState } from './journey-keys.js'
import { StaffSignInLeg } from './staff-sign-in-leg.js'

/**
 * Leg 8: Plexus realm-native sign-in and deploy (C5.1 (b)). Runs Plexus's own Electron journey spec
 * (apps/plexus/e2e/journey) against the live hosted environment's realm: the central registered customer identity
 * signs in through platform discovery against the real platform, then the hosted console names its realm. The console and
 * idp hosts are aliased to the loopback in /etc/hosts, where the place-hosted leg's port-forward (including 443) listens;
 * the hosted development CA is handed to the canonical launcher, which trusts it for the Plexus main process. The central
 * password goes to a private temp file (never an environment value, never logged). Clean has
 * nothing to undo: the hive's teardown removes the environment and the place-hosted leg removes the host aliases.
 */
export class PlexusLeg implements IJourneyLeg
{
    public readonly Name = JourneyLegName.Plexus
    public readonly Dependencies: readonly JourneyDependency[]
    /** Electron start, realm sign-in, publish and read-back. */
    public readonly DeadlineMs = 15 * 60_000
    private static readonly AppFolder = 'apps/plexus'
    /** The hive's journey session has no X server; Electron needs one, so the spec runs under a virtual framebuffer (24-bit: Chromium refuses 8-bit). */
    private static readonly Program = 'xvfb-run'
    private static readonly SpecArgv: readonly string[] = ['-a', '--server-args=-screen 0 1920x1080x24', 'npx', 'playwright', 'test', 'e2e/journey', '--reporter=line']
    private static readonly SpecTimeoutMs = 14 * 60_000
    private static readonly TempPrefix = 'journey-plexus-'
    private static readonly CaFileName = 'hosted-ca.pem'
    private static readonly PasswordFileName = 'owner-password'
    private static readonly PrivateMode = 0o600
    private static readonly Encoding = 'utf8'
    private static readonly HttpsScheme = 'https://'
    private static readonly RealmsSegment = '/realms/'
    private static readonly Redacted = '[redacted]'
    private static readonly TailChars = 4000
    private static readonly EnvJourneyFlag = 'SP_JOURNEY_E2E'
    private static readonly EnvSignIn = 'PLEXUS_E2E_SIGN_IN'
    private static readonly EnvPlatformAddress = 'PLEXUS_E2E_PLATFORM_ADDRESS'
    private static readonly EnvOwnerEmail = 'PLEXUS_E2E_OWNER_EMAIL'
    private static readonly EnvOwnerPasswordFile = 'PLEXUS_E2E_OWNER_PASSWORD_FILE'
    private static readonly EnvDesktopCaFile = 'PLEXUS_E2E_DESKTOP_CA_FILE'
    private static readonly EnvIdpCaFile = 'PLEXUS_E2E_IDP_CA_FILE'
    private static readonly EnvIdpCertFile = 'PLEXUS_E2E_IDP_CERT_FILE'
    private static readonly EnvIdpLogin = 'PLEXUS_E2E_IDP_LOGIN'
    private static readonly IdpLoginBrowser = 'browser'
    private static readonly EnvRealmIssuer = 'PLEXUS_E2E_REALM_ISSUER'
    private static readonly EnvEnvironment = 'PLEXUS_JOURNEY_ENVIRONMENT'
    private static readonly EnvConsoleAddress = 'PLEXUS_JOURNEY_CONSOLE_ADDRESS'
    /** Live-iteration seam: when set and non-empty, pins the realm issuer verbatim. */
    private static readonly EnvRealmIssuerOverride = 'PLEXUS_JOURNEY_REALM_ISSUER'
    private static readonly FlagOn = '1'
    private static readonly SignInRealm = 'realm'
    private static readonly RepoMissing = 'the Plexus repository is not configured: set PRAGMATIC_PLEXUS_REPO to its checkout'
    private static readonly SpecFailed = 'the Plexus journey spec failed with code '
    private static readonly OutputTail = '; output tail: '
    private static readonly Started = 'ran the Plexus journey spec against the hosted realm via the console at '
    private static readonly Passed = 'Plexus signed in realm-native as the staff account at the environment realm and deployed a graph: '
    private static readonly NothingToClean = 'nothing to undo: the hive teardown removes the environment and place-hosted removes the host aliases'

    public constructor(
        private readonly clusters: IEngineClusterSource,
        private readonly identity: JourneyIdentity,
        private readonly executor: IProcessExecutor,
        private readonly evidence: Evidence,
        hiveDependency: JourneyDependency,
        private readonly aliases: HostAliases,
        private readonly platformAddress: string,
        private readonly plexusRepo: string | undefined)
    {
        this.Dependencies = [JourneyDependency.EntitlementDelivery, hiveDependency, JourneyDependency.PlexusRealmSignIn]
    }

    public async Run(context: JourneyContext): Promise<void>
    {
        const L = PlexusLeg
        if (this.plexusRepo === undefined || this.plexusRepo.length === 0)
        {
            throw new WaitAbortError(L.RepoMissing)
        }
        const consoleHost = context.Require(JourneyKeys.ConsoleHost)
        const idpHost = context.Require(JourneyKeys.IdpHost)
        // Plexus signs in directly at the tenant console (the console names its own tenant realm), bypassing
        // platform email→tenant discovery, which does not resolve a hosted tenant. The staff account is a
        // local account in the tenant realm, granted Admin on the environment `journey`; the realm it
        // authorizes at is the tenant realm (the idp host), which the console names.
        const consoleAddress = context.Require(JourneyKeys.ConsoleUrl)
        const overridden = process.env[L.EnvRealmIssuerOverride]
        const realmIssuer = overridden !== undefined && overridden.length > 0
            ? overridden
            : L.HttpsScheme + idpHost + L.RealmsSegment + context.Require(JourneyKeys.Tenant)
        this.aliases.Add([consoleHost, idpHost])
        const email = StaffSignInLeg.EmailFor(context.RunId)
        const password = this.identity.StaffPassword(email)
        const folder = mkdtempSync(join(tmpdir(), L.TempPrefix))
        try
        {
            const caFile = join(folder, L.CaFileName)
            const passwordFile = join(folder, L.PasswordFileName)
            writeFileSync(caFile, await this.clusters.For(context).DevCa(), { encoding: L.Encoding, mode: L.PrivateMode })
            writeFileSync(passwordFile, password, { encoding: L.Encoding, mode: L.PrivateMode })
            const env = {
                ...process.env,
                [L.EnvJourneyFlag]: L.FlagOn,
                [L.EnvSignIn]: L.SignInRealm,
                [L.EnvPlatformAddress]: this.platformAddress,
                [L.EnvOwnerEmail]: email,
                [L.EnvOwnerPasswordFile]: passwordFile,
                [L.EnvDesktopCaFile]: caFile,
                [L.EnvIdpCaFile]: caFile,
                [L.EnvIdpCertFile]: caFile,
                [L.EnvIdpLogin]: L.IdpLoginBrowser,
                [L.EnvRealmIssuer]: realmIssuer,
                [L.EnvEnvironment]: StaffSignInLeg.Environment,
                [L.EnvConsoleAddress]: consoleAddress,
            }
            const result = await this.executor.Execute(L.Program, L.SpecArgv, new ProcessOptions(join(this.plexusRepo, L.AppFolder), env), L.SpecTimeoutMs)
            this.evidence.Step(this.Name, L.Started + consoleHost)
            if (!result.Ok)
            {
                const tail = (result.Stdout + result.Stderr).split(password).join(L.Redacted).slice(-L.TailChars)
                throw new WaitAbortError(L.SpecFailed + result.Code + L.OutputTail + tail)
            }
        }
        finally
        {
            rmSync(folder, { recursive: true, force: true })
        }
        context.Set(JourneyKeys.PlexusState, JourneyState.PlexusSignedIn)
        this.evidence.Step(this.Name, L.Passed + email)
    }

    public async Clean(_context: JourneyContext): Promise<void>
    {
        this.evidence.Step(this.Name, PlexusLeg.NothingToClean)
    }
}
