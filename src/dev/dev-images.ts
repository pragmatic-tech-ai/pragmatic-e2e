/**
 * Builds the platform's dev images, each from its own container repository's bake (the image of record: the
 * repository's root Dockerfile and docker-bake.hcl), into the local docker store under the name the platform admin
 * console runs in local mode (pragmatic-platform-admin's DevPlatformImages: `pragmatic-<app>:dev`, the env server
 * `pragmatic-env-server:dev` and Postgres `pragmatic-postgres:local`). The dev cluster and the live-loop stack load them into
 * kind; the console signs them as it always did.
 *
 *   npx tsx src/dev/dev-images.ts                      # every image the dev stack runs
 *   npx tsx src/dev/dev-images.ts pragmatic-env-server # only the named ones (any release app)
 *
 * Each repository is the full checkout under PRAGMATIC_E2E_REPOS_DIR (default: the folder this repository sits in), so
 * the image holds what the checkout holds, uncommitted edits included. Two bake steps per repository, as its
 * docker-bake.hcl header says: `components` exports the component descriptor and the override that labels the image
 * with its digest into `.components`, then the image target bakes with that override and `--load`s under the dev tag.
 * The bake reads @pragmatic-tech-ai packages with the .npmrc PRAGMATIC_E2E_NPMRC names (default ~/.npmrc), passed only
 * as the BuildKit secret `npmrc`. Requires docker with buildx.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ReleaseApp, ReleaseApps } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { DevPlatformImages } from '../../repos/pragmatic-platform-admin/src/platform-images.js'
import { RepositoryRoots } from '../stack/repository-roots.js'

/** One process to run: the program, its arguments, the folder it runs in and the variables added to the environment. */
export type DevImageCommand = {
    file: string
    args: readonly string[]
    cwd: string
    env: Readonly<Record<string, string>>
}

/** Runs a command to completion with its output on this console; rejects when it fails. */
export interface IDevImageRunner
{
    Run(command: DevImageCommand): Promise<void>
}

/** A command that did not exit 0 (or did not start, or ran past the deadline). */
export class DevImageCommandFailedError extends Error
{
    private static readonly ErrorName = 'DevImageCommandFailedError'
    private static readonly Prefix = 'dev image build failed: '
    private static readonly InWord = ' (in '
    private static readonly Close = '): '
    private static readonly Space = ' '

    public constructor(command: DevImageCommand, reason: string)
    {
        const E = DevImageCommandFailedError
        super(E.Prefix + [command.file, ...command.args].join(E.Space) + E.InWord + command.cwd + E.Close + reason)
        this.name = E.ErrorName
    }
}

/** The command line names something that is not an image this builder bakes. */
export class DevImageUnknownError extends Error
{
    private static readonly ErrorName = 'DevImageUnknownError'
    private static readonly Prefix = 'not a dev image this builder bakes: '
    private static readonly Middle = ' (one of: '
    private static readonly Suffix = ')'
    private static readonly Separator = ', '

    public constructor(name: string, known: readonly string[])
    {
        const E = DevImageUnknownError
        super(E.Prefix + JSON.stringify(name) + E.Middle + known.join(E.Separator) + E.Suffix)
        this.name = E.ErrorName
    }
}

/** The .npmrc the bake reads packages with is missing. */
export class DevImageNpmrcMissingError extends Error
{
    private static readonly ErrorName = 'DevImageNpmrcMissingError'
    private static readonly Prefix = 'no .npmrc at '
    private static readonly Suffix = ' (the bake reads @pragmatic-tech-ai packages with it; set PRAGMATIC_E2E_NPMRC to one that can)'

    public constructor(path: string)
    {
        const E = DevImageNpmrcMissingError
        super(E.Prefix + path + E.Suffix)
        this.name = E.ErrorName
    }
}

/** Whether a file exists (the .npmrc the bake reads). */
export interface IFileProbe
{
    Exists(path: string): boolean
}

export class FsFileProbe implements IFileProbe
{
    public Exists(path: string): boolean
    {
        return existsSync(path)
    }
}

/** Where the builder's progress lines go. */
export interface ILogSink
{
    Line(text: string): void
}

export class ConsoleLogSink implements ILogSink
{
    public Line(text: string): void
    {
        console.log(text)
    }
}

/**
 * Spawns the command with inherited output; a bake that runs past the deadline is killed and reported. Killing the
 * `docker buildx bake` client cancels its build session, so BuildKit stops the build; what it finished stays cached.
 */
export class SpawnDevImageRunner implements IDevImageRunner
{
    /** A cold bake installs every package and compiles; a warm one takes seconds. */
    public static readonly DeadlineMs = 45 * 60 * 1000
    private static readonly ExitEvent = 'exit'
    private static readonly ErrorEvent = 'error'
    private static readonly ExitCodePrefix = 'exit code '
    private static readonly SignalPrefix = 'signal '
    private static readonly TimedOut = 'ran past the deadline'

    public constructor(private readonly deadlineMs: number = SpawnDevImageRunner.DeadlineMs)
    {
    }

    public Run(command: DevImageCommand): Promise<void>
    {
        const S = SpawnDevImageRunner
        return new Promise((done, fail) =>
        {
            const child = spawn(command.file, [...command.args], { cwd: command.cwd, env: { ...process.env, ...command.env }, stdio: 'inherit', windowsHide: true })
            let timedOut = false
            const timer = setTimeout(() =>
            {
                timedOut = true
                child.kill()
            }, this.deadlineMs)
            child.on(S.ErrorEvent, err =>
            {
                clearTimeout(timer)
                fail(new DevImageCommandFailedError(command, err.message))
            })
            child.on(S.ExitEvent, (code, signal) =>
            {
                clearTimeout(timer)
                if (code === 0)
                {
                    done()
                    return
                }
                fail(new DevImageCommandFailedError(command, timedOut ? S.TimedOut : code !== null ? S.ExitCodePrefix + String(code) : S.SignalPrefix + String(signal)))
            })
        })
    }
}

export class DevImages
{
    public static readonly NpmrcEnvVar = 'PRAGMATIC_E2E_NPMRC'
    private static readonly NpmrcFileName = '.npmrc'
    public static readonly DefaultNpmrc = join(homedir(), DevImages.NpmrcFileName)
    /** Set to 1, the dev stack and the live loop skip the bake (the images are fresh already). */
    public static readonly SkipBakeEnvVar = 'PRAGMATIC_DEV_SKIP_IMAGE_BAKE'
    private static readonly SkipBakeValue = '1'
    /** Dev images are baked for the dev machine's docker (amd64, as the bakes default to and as kind runs here). */
    public static readonly Platform = 'linux/amd64'
    /** Every image the dev stack runs from a container repository, in build order: environments (the server and the UI unpack init container), the hive agent, the tenant console with its IdP and Postgres. */
    public static readonly DevStackApps: readonly ReleaseApp[] = [
        ReleaseApp.EnvServer,
        ReleaseApp.UiUnpack,
        ReleaseApp.HiveAgent,
        ReleaseApp.TenantAdmin,
        ReleaseApp.TenantIdp,
        ReleaseApp.Postgres,
    ]
    /** What the live-loop stack runs from an image: environments (server, UI unpack), the hive agent it installs and the tenant IdP container. */
    public static readonly LiveLoopApps: readonly ReleaseApp[] = [
        ReleaseApp.EnvServer,
        ReleaseApp.UiUnpack,
        ReleaseApp.HiveAgent,
        ReleaseApp.TenantIdp,
    ]
    /** The command a missing-image hint names (run from this repository's root), followed by the repository. */
    public static readonly BuildCommandPrefix = 'npx tsx src/dev/dev-images.ts '
    private static readonly Docker = 'docker'
    private static readonly Buildx = 'buildx'
    private static readonly Bake = 'bake'
    private static readonly FileFlag = '-f'
    private static readonly BakeFile = 'docker-bake.hcl'
    private static readonly ComponentsOverride = '.components/docker-bake.components.json'
    private static readonly ComponentsTarget = 'components'
    private static readonly AllowRead = '--allow=fs.read='
    private static readonly SetFlag = '--set'
    private static readonly TagsKey = '.tags='
    private static readonly LoadFlag = '--load'
    private static readonly NpmrcVar = 'NPMRC_FILE'
    private static readonly PlatformsVar = 'PLATFORMS'
    private static readonly BakingPrefix = '[dev-images] baking '
    private static readonly FromWord = ' from '
    private static readonly BuiltPrefix = '[dev-images] built '

    public constructor(
        public readonly Roots: RepositoryRoots,
        public readonly NpmrcFile: string,
        private readonly runner: IDevImageRunner = new SpawnDevImageRunner(),
        private readonly files: IFileProbe = new FsFileProbe(),
        private readonly log: ILogSink = new ConsoleLogSink())
    {
    }

    /** The builder `env` configures: PRAGMATIC_E2E_REPOS_DIR for the checkouts, PRAGMATIC_E2E_NPMRC for the .npmrc (NpmrcOf). */
    public static FromEnvironment(env: NodeJS.ProcessEnv): DevImages
    {
        return new DevImages(RepositoryRoots.FromEnvironment(env), DevImages.NpmrcOf(env))
    }

    /** The .npmrc `env` names: PRAGMATIC_E2E_NPMRC (resolved) when set and not blank, else ~/.npmrc. */
    public static NpmrcOf(env: NodeJS.ProcessEnv): string
    {
        const raw = env[DevImages.NpmrcEnvVar]?.trim() ?? ''
        return raw === '' ? DevImages.DefaultNpmrc : resolve(raw)
    }

    /** True when `env` asks to skip the bake (SkipBakeEnvVar is 1). */
    public static SkipsBake(env: NodeJS.ProcessEnv): boolean
    {
        return env[DevImages.SkipBakeEnvVar] === DevImages.SkipBakeValue
    }

    /** The local docker tag of `app`'s dev image: the name the platform admin console runs in local mode. */
    public static TagOf(app: ReleaseApp): string
    {
        return DevPlatformImages.Of(app)
    }

    /** The hint for a missing dev image: the command that bakes it. */
    public static BuildCommandOf(app: ReleaseApp): string
    {
        return DevImages.BuildCommandPrefix + app
    }

    /**
     * Pure: the two bake steps that build `app` from its repository checkout at `root` into the local docker store as
     * TagOf(app). The image target is named after the app in every container repository's docker-bake.hcl; its tags
     * are replaced by the dev tag, so nothing names the registry.
     */
    public static BakeCommands(app: ReleaseApp, root: string, npmrcFile: string): readonly DevImageCommand[]
    {
        const D = DevImages
        const env = { [D.NpmrcVar]: npmrcFile, [D.PlatformsVar]: D.Platform }
        const allow = D.AllowRead + npmrcFile
        return [
            { file: D.Docker, args: [D.Buildx, D.Bake, D.FileFlag, D.BakeFile, allow, D.ComponentsTarget], cwd: root, env },
            {
                file: D.Docker,
                args: [D.Buildx, D.Bake, D.FileFlag, D.BakeFile, D.FileFlag, D.ComponentsOverride, allow, D.SetFlag, app + D.TagsKey + D.TagOf(app), D.LoadFlag, app],
                cwd: root,
                env,
            },
        ]
    }

    /** The apps the command line names, in that order (any release app); none names every image of the dev stack. Refuses anything else, listing what it bakes. */
    public static ParseApps(names: readonly string[]): readonly ReleaseApp[]
    {
        const D = DevImages
        if (names.length === 0)
        {
            return D.DevStackApps
        }
        const known: readonly string[] = ReleaseApps.All
        return names.map(name =>
        {
            if (!known.includes(name))
            {
                throw new DevImageUnknownError(name, known)
            }
            return name as ReleaseApp
        })
    }

    /** Bakes each app's dev image in order (nothing for none). Every checkout and the .npmrc are checked before the first bake, so a missing one fails fast, by name. */
    public async Build(apps: readonly ReleaseApp[]): Promise<void>
    {
        const D = DevImages
        if (apps.length === 0)
        {
            return
        }
        if (!this.files.Exists(this.NpmrcFile))
        {
            throw new DevImageNpmrcMissingError(this.NpmrcFile)
        }
        const plan = apps.map(app => ({ app, root: this.Roots.Of(app) }))
        for (const { app, root } of plan)
        {
            this.log.Line(D.BakingPrefix + D.TagOf(app) + D.FromWord + root)
            for (const command of D.BakeCommands(app, root, this.NpmrcFile))
            {
                await this.runner.Run(command)
            }
            this.log.Line(D.BuiltPrefix + D.TagOf(app))
        }
    }

    public static async Main(): Promise<void>
    {
        await DevImages.FromEnvironment(process.env).Build(DevImages.ParseApps(process.argv.slice(2)))
    }

    public static IsEntryPoint(): boolean
    {
        return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
    }
}

if (DevImages.IsEntryPoint())
{
    DevImages.Main().catch(err =>
    {
        console.error((err as Error).message)
        process.exitCode = 1
    })
}
