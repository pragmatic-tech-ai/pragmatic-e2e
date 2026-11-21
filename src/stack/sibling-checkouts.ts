/**
 * Checks out the container repositories the cross-container tests import from, at the commits `siblings.json` pins,
 * under `repos/` (gitignored). Those repositories hold no `node_modules` here, so every package their sources import
 * resolves to this repository's own (one installed copy of each, the same rule as a container repository's
 * singletons test), and the tests run against a known combination: moving a pin is a reviewed change.
 *
 *   npm run siblings
 *
 * Needs git and network access to the public repositories; nothing is pushed.
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RepositoryRoots } from './repository-roots.js'

/** Runs git; answers its stdout, throws when it exits non-zero. */
export interface IGitRunner
{
    Run(args: readonly string[], cwd?: string): Promise<string>
}

export class NodeGitRunner implements IGitRunner
{
    private static readonly Git = 'git'
    private static readonly MaxBuffer = 64 * 1024 * 1024

    public Run(args: readonly string[], cwd?: string): Promise<string>
    {
        return new Promise((done, fail) =>
        {
            execFile(NodeGitRunner.Git, [...args], { cwd, maxBuffer: NodeGitRunner.MaxBuffer, windowsHide: true }, (err, stdout, stderr) =>
            {
                if (err !== null)
                {
                    fail(new Error(String(stderr).trim() || err.message))
                    return
                }
                done(String(stdout))
            })
        })
    }
}

/** siblings.json is not an object of `<repository folder name>: <40-hex commit>`. */
export class SiblingPinsInvalidError extends Error
{
    private static readonly ErrorName = 'SiblingPinsInvalidError'
    private static readonly Prefix = 'siblings.json: '

    public constructor(reason: string)
    {
        super(SiblingPinsInvalidError.Prefix + reason)
        this.name = SiblingPinsInvalidError.ErrorName
    }
}

export class SiblingCheckouts
{
    public static readonly ReposDir = 'repos'
    public static readonly PinsFile = 'siblings.json'
    public static readonly Root = join(RepositoryRoots.OwnRoot, SiblingCheckouts.ReposDir)
    public static readonly DefaultOrigin = 'https://github.com/pragmatic-tech-ai/'
    private static readonly GitSuffix = '.git'
    private static readonly GitDir = '.git'
    private static readonly CommitPin = /^[0-9a-f]{40}$/
    private static readonly RepositoryName = /^[a-z0-9][a-z0-9-]*$/
    private static readonly CommitSuffix = '^{commit}'
    private static readonly Utf8 = 'utf8'
    private static readonly NotObject = 'expected an object of repository name to commit'
    private static readonly BadName = 'not a repository folder name: '
    private static readonly BadPin = 'not a 40-hex commit for '
    private static readonly CheckedOutPrefix = '[siblings] '
    private static readonly At = ' @ '
    private static readonly Clone = ['clone', '--quiet', '--no-checkout'] as const
    private static readonly CatFile = ['cat-file', '-e'] as const
    private static readonly Fetch = ['fetch', '--quiet', 'origin'] as const
    private static readonly Checkout = ['checkout', '--quiet', '--force', '--detach'] as const

    public constructor(
        private readonly git: IGitRunner = new NodeGitRunner(),
        private readonly root: string = SiblingCheckouts.Root,
        private readonly origin: string = SiblingCheckouts.DefaultOrigin,
        private readonly log: (line: string) => void = line => console.log(line))
    {
    }

    /** A path inside the checkout of `repo` under repos/ (a fixture, a UI folder). */
    public static PathOf(repo: string, ...segments: string[]): string
    {
        return join(SiblingCheckouts.Root, repo, ...segments)
    }

    /** Pure: the pins of a siblings.json text, in file order. */
    public static ParsePins(text: string): ReadonlyMap<string, string>
    {
        const S = SiblingCheckouts
        const parsed: unknown = JSON.parse(text)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        {
            throw new SiblingPinsInvalidError(S.NotObject)
        }
        const pins = new Map<string, string>()
        for (const [name, pin] of Object.entries(parsed))
        {
            if (!S.RepositoryName.test(name))
            {
                throw new SiblingPinsInvalidError(S.BadName + JSON.stringify(name))
            }
            if (typeof pin !== 'string' || !S.CommitPin.test(pin))
            {
                throw new SiblingPinsInvalidError(S.BadPin + name)
            }
            pins.set(name, pin)
        }
        return pins
    }

    /** Clones each missing sibling (no checkout), fetches when its pin is not there yet, then checks the pin out detached. */
    public async Sync(pins: ReadonlyMap<string, string>): Promise<void>
    {
        const S = SiblingCheckouts
        for (const [name, pin] of pins)
        {
            const dir = join(this.root, name)
            if (!existsSync(join(dir, S.GitDir)))
            {
                await this.git.Run([...S.Clone, this.origin + name + S.GitSuffix, dir])
            }
            try
            {
                await this.git.Run([...S.CatFile, pin + S.CommitSuffix], dir)
            }
            catch
            {
                await this.git.Run([...S.Fetch], dir)
            }
            await this.git.Run([...S.Checkout, pin], dir)
            this.log(S.CheckedOutPrefix + name + S.At + pin)
        }
    }

    public static async Main(): Promise<void>
    {
        const S = SiblingCheckouts
        const pins = S.ParsePins(readFileSync(join(RepositoryRoots.OwnRoot, S.PinsFile), S.Utf8))
        await new SiblingCheckouts().Sync(pins)
    }

    public static IsEntryPoint(): boolean
    {
        return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
    }
}

if (SiblingCheckouts.IsEntryPoint())
{
    SiblingCheckouts.Main().catch(err =>
    {
        console.error((err as Error).message)
        process.exitCode = 1
    })
}
