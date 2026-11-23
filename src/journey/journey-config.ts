import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JourneyDependencies, type JourneyDependency } from './journey-dependency.js'

/** The checked-in configuration file's shape (`src/journey/journey.config.json`). */
export interface JourneyConfigDocument
{
    websiteUrl: string
    cabinetUrl: string
    centralIssuer: string
    edgeUrl: string
    planName: string
    emailDomain: string
    journeyDnsSubdomain: string
    customerCluster: string
    liveDependencies: string[]
}

/**
 * Where the journey goes and what it may read: the public addresses, the plan it buys, the synthetic customers' email
 * domain, which dependencies are live, and (from the environment) the run folder, the lock file and the paths of the
 * test-only credential files. Only file paths come from the environment, never a secret value.
 */
export class JourneyConfig
{
    public static readonly ConfigEnv = 'PRAGMATIC_JOURNEY_CONFIG'
    public static readonly RunsDirEnv = 'PRAGMATIC_JOURNEY_RUNS_DIR'
    public static readonly LockFileEnv = 'PRAGMATIC_JOURNEY_LOCK_FILE'
    public static readonly PasswordSeedFileEnv = 'PRAGMATIC_JOURNEY_PASSWORD_SEED_FILE'
    public static readonly CampaignCodeFileEnv = 'PRAGMATIC_JOURNEY_CAMPAIGN_CODE_FILE'
    public static readonly DnsTokenFileEnv = 'PRAGMATIC_JOURNEY_DNS_TOKEN_FILE'
    public static readonly HeadedEnv = 'PRAGMATIC_JOURNEY_HEADED'
    private static readonly ConfigFileName = 'journey.config.json'
    private static readonly RunsFolderName = 'journey-runs'
    private static readonly RepoUp = '../..'
    private static readonly LockRelative = ['.pragmatic', 'journey', 'lock']
    private static readonly Encoding = 'utf8'
    private static readonly HttpsScheme = 'https:'
    private static readonly NotHttps = 'journey addresses are https only: '
    private static readonly MissingField = 'journey.config.json lacks: '
    private static readonly MissingFile = 'set this to the path of the test-only file: '
    private static readonly TrailingSlash = /\/+$/
    private static readonly Blank = ''
    private static readonly On = '1'
    private static readonly RequiredStrings: readonly (keyof JourneyConfigDocument)[] = ['websiteUrl', 'cabinetUrl', 'centralIssuer', 'edgeUrl', 'planName', 'emailDomain', 'journeyDnsSubdomain', 'customerCluster']

    private constructor(
        public readonly WebsiteUrl: string,
        public readonly CabinetUrl: string,
        public readonly CentralIssuer: string,
        public readonly EdgeUrl: string,
        public readonly PlanName: string,
        public readonly EmailDomain: string,
        public readonly JourneyDnsSubdomain: string,
        public readonly CustomerCluster: string,
        public readonly LiveDependencies: ReadonlySet<JourneyDependency>,
        public readonly RunsDir: string,
        public readonly LockFile: string,
        public readonly Headed: boolean,
        private readonly env: NodeJS.ProcessEnv)
    {
    }

    /** Reads the checked-in file (or the one PRAGMATIC_JOURNEY_CONFIG names) and the environment. */
    public static Load(env: NodeJS.ProcessEnv = process.env): JourneyConfig
    {
        const C = JourneyConfig
        const here = dirname(fileURLToPath(import.meta.url))
        const file = env[C.ConfigEnv] ?? join(here, C.ConfigFileName)
        return C.FromDocument(JSON.parse(readFileSync(file, C.Encoding)) as JourneyConfigDocument, env, resolve(here, C.RepoUp))
    }

    public static FromDocument(document: JourneyConfigDocument, env: NodeJS.ProcessEnv, repoRoot: string): JourneyConfig
    {
        const C = JourneyConfig
        for (const field of C.RequiredStrings)
        {
            if (typeof document[field] !== 'string' || (document[field] as string).length === 0)
            {
                throw new Error(C.MissingField + field)
            }
        }
        return new JourneyConfig(
            C.Https(document.websiteUrl),
            C.Https(document.cabinetUrl),
            C.Https(document.centralIssuer),
            C.Https(document.edgeUrl),
            document.planName,
            document.emailDomain,
            document.journeyDnsSubdomain,
            document.customerCluster,
            JourneyDependencies.Parse(document.liveDependencies ?? []),
            env[C.RunsDirEnv] ?? join(repoRoot, C.RunsFolderName),
            env[C.LockFileEnv] ?? join(homedir(), ...C.LockRelative),
            env[C.HeadedEnv] === C.On,
            env)
    }

    /** The path of a test-only credential file named by an environment variable; throws naming the variable. */
    public RequireFile(variable: string): string
    {
        const path = this.env[variable]
        if (path === undefined || path.length === 0)
        {
            throw new Error(JourneyConfig.MissingFile + variable)
        }
        return path
    }

    /** The same, or undefined when the variable is not set (an optional credential). */
    public OptionalFile(variable: string): string | undefined
    {
        const path = this.env[variable]
        return path === undefined || path.length === 0 ? undefined : path
    }

    /** Reads a credential file's value (trimmed); the value goes to the caller only, never into a log. */
    public static ReadSecretFile(path: string): string
    {
        return readFileSync(path, JourneyConfig.Encoding).trim()
    }

    private static Https(url: string): string
    {
        if (new URL(url).protocol !== JourneyConfig.HttpsScheme)
        {
            throw new Error(JourneyConfig.NotHttps + url)
        }
        return url.replace(JourneyConfig.TrailingSlash, JourneyConfig.Blank)
    }
}
