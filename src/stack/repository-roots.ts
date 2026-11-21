import { existsSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** A repository the stack starts a service from is not checked out where the roots point (or its name is not a folder name). */
export class RepositoryMissingError extends Error
{
    private static readonly ErrorName = 'RepositoryMissingError'
    private static readonly Prefix = 'repository '
    private static readonly Middle = ' is not checked out under '
    private static readonly Hint = ' (set PRAGMATIC_E2E_REPOS_DIR to the folder that holds the sibling checkouts)'

    public constructor(repo: string, directory: string)
    {
        const E = RepositoryMissingError
        super(E.Prefix + JSON.stringify(repo) + E.Middle + directory + E.Hint)
        this.name = E.ErrorName
    }
}

/**
 * Where the container repositories the live loop and the dev stack start their services from are checked out: each one
 * is a full checkout (its own `node_modules`, its UIs built) in one folder, `PRAGMATIC_E2E_REPOS_DIR`, by default the
 * folder this repository sits in (the workspace, `D:\tmp` or the hive laptop's clone folder). Each service runs from its
 * own repository's source with that repository's `tsx`, exactly as it did from pragmatic-server.
 */
export class RepositoryRoots
{
    public static readonly EnvVar = 'PRAGMATIC_E2E_REPOS_DIR'
    /** This repository's root (this file is `src/stack/repository-roots.ts`). */
    public static readonly OwnRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
    private static readonly FolderName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

    public constructor(public readonly Directory: string)
    {
    }

    /** The roots `env` names: `PRAGMATIC_E2E_REPOS_DIR` (resolved) when set and not blank, else this repository's parent folder. */
    public static FromEnvironment(env: NodeJS.ProcessEnv): RepositoryRoots
    {
        const raw = env[RepositoryRoots.EnvVar]?.trim() ?? ''
        return new RepositoryRoots(raw === '' ? dirname(RepositoryRoots.OwnRoot) : resolve(raw))
    }

    /** The absolute root of `repo`; refuses a name that is not a plain folder name, or a folder that does not exist. */
    public Of(repo: string): string
    {
        const path = join(this.Directory, repo)
        if (!RepositoryRoots.FolderName.test(repo) || basename(path) !== repo || !existsSync(path) || !statSync(path).isDirectory())
        {
            throw new RepositoryMissingError(repo, this.Directory)
        }
        return path
    }
}
