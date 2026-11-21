import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { type IGitRunner, SiblingCheckouts, SiblingPinsInvalidError } from '../sibling-checkouts.js'
import { RepositoryRoots } from '../repository-roots.js'

/** Records each git call as `<folder under the root>: <args>`; a clone creates the target's `.git`. */
class RecordingGit implements IGitRunner
{
    private static readonly Clone = 'clone'
    private static readonly CatFile = 'cat-file'
    private static readonly GitDir = '.git'
    private static readonly Space = ' '
    private static readonly CwdSeparator = ': '
    public readonly Calls: string[] = []

    public constructor(private readonly root: string, private readonly known: ReadonlySet<string> = new Set())
    {
    }

    public async Run(args: readonly string[], cwd?: string): Promise<string>
    {
        const G = RecordingGit
        const where = cwd === undefined ? '' : relative(this.root, cwd).split(sep).join('/') + G.CwdSeparator
        this.Calls.push(where + args.join(G.Space))
        if (args[0] === G.Clone)
        {
            mkdirSync(join(args[args.length - 1], G.GitDir), { recursive: true })
        }
        if (args[0] === G.CatFile && !this.known.has(args[2]))
        {
            throw new Error(args[2])
        }
        return ''
    }
}

class SiblingFixture
{
    public static readonly ShaA = 'a'.repeat(40)
    public static readonly ShaB = 'b'.repeat(40)
    public static readonly Admin = 'pragmatic-platform-admin'
    public static readonly Origin = 'https://example.test/org/'
    public static readonly Prefix = 'e2e-siblings-'
    public static readonly SourceDir = 'src'
    public static readonly TsExtension = '.ts'
    public static readonly Utf8 = 'utf8'
    /** A sibling-source import: `repos/<repository>/` in a relative specifier. */
    public static readonly ReposImport = /from '(?:\.\.\/)+repos\/([a-z0-9-]+)\//g

    public static async With(body: (root: string) => Promise<void>): Promise<void>
    {
        const root = mkdtempSync(join(tmpdir(), SiblingFixture.Prefix))
        try
        {
            await body(root)
        }
        finally
        {
            rmSync(root, { recursive: true, force: true })
        }
    }

    public static SourceFiles(dir: string): string[]
    {
        const out: string[] = []
        for (const name of readdirSync(dir))
        {
            const path = join(dir, name)
            if (statSync(path).isDirectory())
            {
                out.push(...SiblingFixture.SourceFiles(path))
            }
            else if (name.endsWith(SiblingFixture.TsExtension))
            {
                out.push(path)
            }
        }
        return out
    }
}

describe('SiblingCheckouts', () =>
{
    it('clones a missing sibling without a checkout, fetches when the pin is unknown, then checks the pin out detached', async () =>
    {
        await SiblingFixture.With(async root =>
        {
            const F = SiblingFixture
            const git = new RecordingGit(root)
            await new SiblingCheckouts(git, root, F.Origin, () => undefined).Sync(new Map([[F.Admin, F.ShaA]]))
            assert.deepEqual(git.Calls, [
                'clone --quiet --no-checkout ' + F.Origin + F.Admin + '.git ' + join(root, F.Admin),
                F.Admin + ': cat-file -e ' + F.ShaA + '^{commit}',
                F.Admin + ': fetch --quiet origin',
                F.Admin + ': checkout --quiet --force --detach ' + F.ShaA,
            ])
        })
    })

    it('reuses an existing checkout and does not fetch a pin it already has', async () =>
    {
        await SiblingFixture.With(async root =>
        {
            const F = SiblingFixture
            mkdirSync(join(root, F.Admin, '.git'), { recursive: true })
            const git = new RecordingGit(root, new Set([F.ShaB + '^{commit}']))
            await new SiblingCheckouts(git, root, F.Origin, () => undefined).Sync(new Map([[F.Admin, F.ShaB]]))
            assert.deepEqual(git.Calls, [
                F.Admin + ': cat-file -e ' + F.ShaB + '^{commit}',
                F.Admin + ': checkout --quiet --force --detach ' + F.ShaB,
            ])
        })
    })

    it('parses the pins and refuses a non-sha pin, a name that is not a plain folder name, or a non-object', () =>
    {
        const F = SiblingFixture
        assert.deepEqual([...SiblingCheckouts.ParsePins(JSON.stringify({ [F.Admin]: F.ShaA }))], [[F.Admin, F.ShaA]])
        assert.throws(() => SiblingCheckouts.ParsePins(JSON.stringify({ [F.Admin]: 'main' })), SiblingPinsInvalidError)
        assert.throws(() => SiblingCheckouts.ParsePins(JSON.stringify({ '../x': F.ShaA })), SiblingPinsInvalidError)
        assert.throws(() => SiblingCheckouts.ParsePins('[]'), SiblingPinsInvalidError)
    })

    it('pins every repository the sources import from repos/', () =>
    {
        const F = SiblingFixture
        const pins = SiblingCheckouts.ParsePins(readFileSync(join(RepositoryRoots.OwnRoot, SiblingCheckouts.PinsFile), F.Utf8))
        const imported = new Set<string>()
        for (const file of F.SourceFiles(join(RepositoryRoots.OwnRoot, F.SourceDir)))
        {
            for (const match of readFileSync(file, F.Utf8).matchAll(F.ReposImport))
            {
                imported.add(match[1])
            }
        }
        assert.ok(imported.size > 0)
        for (const repo of imported)
        {
            assert.ok(pins.has(repo), repo)
        }
    })

    it('PathOf names a file inside a sibling checkout under repos/', () =>
    {
        const F = SiblingFixture
        assert.equal(SiblingCheckouts.PathOf(F.Admin, F.SourceDir, 'kind.ts'), join(RepositoryRoots.OwnRoot, SiblingCheckouts.ReposDir, F.Admin, F.SourceDir, 'kind.ts'))
    })
})
