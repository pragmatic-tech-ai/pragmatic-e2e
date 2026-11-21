import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { RepositoryRoots } from '../repository-roots.js'
import { SiblingCheckouts } from '../sibling-checkouts.js'

/**
 * Finds every installed copy of a package under a node_modules tree (nested node_modules included), by the `name` of
 * each package.json at a package root. Two copies of todl-runtime, todl or mural break `instanceof` across them.
 */
class InstalledCopies
{
    public static readonly NodeModules = 'node_modules'
    private static readonly PackageJson = 'package.json'
    private static readonly ScopePrefix = '@'
    private static readonly Utf8 = 'utf8'

    public constructor(private readonly root: string)
    {
    }

    /** The absolute package roots under the tree whose package.json is named `name`. */
    public Of(name: string): string[]
    {
        const found: string[] = []
        this.Walk(join(this.root, InstalledCopies.NodeModules), name, found)
        return found
    }

    private Walk(modules: string, name: string, found: string[]): void
    {
        if (!existsSync(modules))
        {
            return
        }
        for (const entry of readdirSync(modules, { withFileTypes: true }))
        {
            if (!entry.isDirectory() && !entry.isSymbolicLink())
            {
                continue
            }
            const path = join(modules, entry.name)
            if (entry.name.startsWith(InstalledCopies.ScopePrefix))
            {
                for (const scoped of readdirSync(path, { withFileTypes: true }))
                {
                    this.Visit(join(path, scoped.name), name, found)
                }
                continue
            }
            this.Visit(path, name, found)
        }
    }

    private Visit(packageRoot: string, name: string, found: string[]): void
    {
        const manifest = join(packageRoot, InstalledCopies.PackageJson)
        if (existsSync(manifest) && (JSON.parse(readFileSync(manifest, InstalledCopies.Utf8)) as { name?: string }).name === name)
        {
            found.push(packageRoot)
        }
        this.Walk(join(packageRoot, InstalledCopies.NodeModules), name, found)
    }
}

class Singletons
{
    public static readonly Names: readonly string[] = ['@pragmatic-tech-ai/todl-runtime', '@pragmatic-tech-ai/todl', '@pragmatic-tech-ai/mural']
}

// The sibling-source design rests on this: the container sources under repos/ have no node_modules of their own, so
// every package they import is this repository's single installed copy.
describe('singletons', () =>
{
    it('installs exactly one copy of todl-runtime, todl and mural', () =>
    {
        const copies = new InstalledCopies(RepositoryRoots.OwnRoot)
        for (const name of Singletons.Names)
        {
            assert.equal(copies.Of(name).length, 1, name + ': ' + copies.Of(name).join(', '))
        }
    })

    it('the sibling checkouts under repos/ carry no node_modules of their own', () =>
    {
        for (const repo of SiblingCheckouts.Pins().keys())
        {
            assert.ok(!existsSync(SiblingCheckouts.PathOf(repo, InstalledCopies.NodeModules)), repo)
        }
    })
})
