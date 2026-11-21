import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { RepositoryMissingError, RepositoryRoots } from '../repository-roots.js'

class RootsFixture
{
    public static readonly Prefix = 'e2e-roots-'
    public static readonly Sibling = 'pragmatic-platform-admin'
    public static readonly Missing = 'pragmatic-no-such-repository'
    public static readonly NotFolderNames: readonly string[] = ['', '.', '..', 'a/b', 'a\\b']

    public static With(body: (dir: string) => void): void
    {
        const dir = mkdtempSync(join(tmpdir(), RootsFixture.Prefix))
        try
        {
            body(dir)
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    }
}

describe('RepositoryRoots', () =>
{
    it('resolves siblings under the parent folder of this repository by default', () =>
    {
        const roots = RepositoryRoots.FromEnvironment({})
        assert.equal(roots.Directory, dirname(RepositoryRoots.OwnRoot))
        // This repository is itself a sibling under that folder.
        assert.equal(roots.Of(basename(RepositoryRoots.OwnRoot)), RepositoryRoots.OwnRoot)
    })

    it('resolves siblings under PRAGMATIC_E2E_REPOS_DIR when it is set; blank is the default', () =>
    {
        RootsFixture.With(dir =>
        {
            mkdirSync(join(dir, RootsFixture.Sibling))
            const roots = RepositoryRoots.FromEnvironment({ [RepositoryRoots.EnvVar]: dir })
            assert.equal(roots.Directory, dir)
            assert.equal(roots.Of(RootsFixture.Sibling), join(dir, RootsFixture.Sibling))
            assert.equal(RepositoryRoots.FromEnvironment({ [RepositoryRoots.EnvVar]: '' }).Directory, dirname(RepositoryRoots.OwnRoot))
        })
    })

    it('refuses a missing repository, naming it and the folder', () =>
    {
        RootsFixture.With(dir =>
        {
            const roots = RepositoryRoots.FromEnvironment({ [RepositoryRoots.EnvVar]: dir })
            assert.throws(() => roots.Of(RootsFixture.Missing), (err: unknown) =>
            {
                assert.ok(err instanceof RepositoryMissingError)
                assert.ok(err.message.includes(RootsFixture.Missing))
                assert.ok(err.message.includes(dir))
                assert.ok(err.message.includes(RepositoryRoots.EnvVar))
                return true
            })
        })
    })

    it('refuses a repository name that is not a plain folder name', () =>
    {
        const roots = RepositoryRoots.FromEnvironment({})
        for (const name of RootsFixture.NotFolderNames)
        {
            assert.throws(() => roots.Of(name), RepositoryMissingError, name)
        }
    })
})
