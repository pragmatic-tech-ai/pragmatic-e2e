import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { ReleaseApp } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { EnvironmentWorkloadFactory } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { DevPlatformImages } from '../../../repos/pragmatic-platform-admin/src/platform-images.js'
import { RepositoryMissingError, RepositoryRoots } from '../../stack/repository-roots.js'
import { type DevImageCommand, DevImageNpmrcMissingError, DevImages, DevImageUnknownError, type IDevImageRunner } from '../dev-images.js'

class RecordingRunner implements IDevImageRunner
{
    public readonly Commands: DevImageCommand[] = []
    public FailOn: string | undefined

    public async Run(command: DevImageCommand): Promise<void>
    {
        this.Commands.push(command)
        if (this.FailOn !== undefined && command.args.includes(this.FailOn))
        {
            throw new Error('bake failed')
        }
    }
}

class DevImagesFx
{
    public static readonly Prefix = 'e2e-dev-images-'
    public static readonly Npmrc = '/home/dev/.npmrc'

    /** A repositories folder holding a checkout folder for each of `repos`. */
    public static With(repos: readonly string[], body: (dir: string) => Promise<void>): Promise<void>
    {
        const dir = mkdtempSync(join(tmpdir(), DevImagesFx.Prefix))
        for (const repo of repos)
        {
            mkdirSync(join(dir, repo))
        }
        return body(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
    }

    public static Builder(dir: string, runner: IDevImageRunner, npmrcExists: boolean = true): DevImages
    {
        return new DevImages(new RepositoryRoots(dir), DevImagesFx.Npmrc, runner, () => npmrcExists, () => undefined)
    }
}

describe('DevImages.BakeCommands', () =>
{
    it('bakes the components step, then the image target with the components override, loaded under the dev tag', () =>
    {
        const root = '/repos/pragmatic-env-server'
        const commands = DevImages.BakeCommands(ReleaseApp.EnvServer, root, DevImagesFx.Npmrc)
        assert.deepEqual(commands, [
            {
                file: 'docker',
                args: ['buildx', 'bake', '-f', 'docker-bake.hcl', '--allow=fs.read=/home/dev/.npmrc', 'components'],
                cwd: root,
                env: { NPMRC_FILE: '/home/dev/.npmrc' },
            },
            {
                file: 'docker',
                args: ['buildx', 'bake', '-f', 'docker-bake.hcl', '-f', '.components/docker-bake.components.json', '--allow=fs.read=/home/dev/.npmrc',
                    '--set', 'pragmatic-env-server.tags=pragmatic-server:dev', '--load', 'pragmatic-env-server'],
                cwd: root,
                env: { NPMRC_FILE: '/home/dev/.npmrc' },
            },
        ])
    })

    it('names the image target after the app and tags it as the console runs it in local mode, for every image it bakes', () =>
    {
        for (const app of DevImages.DevStackApps)
        {
            const image = DevImages.BakeCommands(app, '/r/' + app, DevImagesFx.Npmrc)[1]!
            assert.equal(image.args.at(-1), app, app)
            assert.ok(image.args.includes(app + '.tags=' + DevPlatformImages.Of(app)), app)
            assert.ok(!image.args.some(a => a.includes('ghcr.io')), app)
        }
    })
})

describe('DevImages tags', () =>
{
    it('are the platform admin console\'s dev images: each app its own, the env server as the tenant plane names it', () =>
    {
        assert.deepEqual(DevImages.DevStackApps.map(app => DevImages.TagOf(app)), [
            'pragmatic-server:dev',
            'pragmatic-ui-unpack:dev',
            'pragmatic-hive-agent:dev',
            'pragmatic-tenant-admin:dev',
            'pragmatic-tenant-idp:dev',
            'pragmatic-postgres:local',
        ])
        assert.equal(DevImages.TagOf(ReleaseApp.UiUnpack), EnvironmentWorkloadFactory.UiUnpackImage)
    })

    it('the live loop bakes the environment images, the hive agent and the tenant IdP, all of them dev stack images', () =>
    {
        assert.deepEqual(DevImages.LiveLoopApps, [ReleaseApp.EnvServer, ReleaseApp.UiUnpack, ReleaseApp.HiveAgent, ReleaseApp.TenantIdp])
        assert.ok(DevImages.LiveLoopApps.every(app => DevImages.DevStackApps.includes(app)))
    })

    it('a missing-image hint names the builder command for the repository', () =>
    {
        assert.equal(DevImages.BuildCommandOf(ReleaseApp.TenantIdp), 'npx tsx src/dev/dev-images.ts pragmatic-tenant-idp')
    })
})

describe('DevImages.ParseApps', () =>
{
    it('builds every dev stack image when no app is named', () =>
    {
        assert.deepEqual(DevImages.ParseApps([]), DevImages.DevStackApps)
    })

    it('keeps the named apps in order', () =>
    {
        assert.deepEqual(DevImages.ParseApps(['pragmatic-tenant-idp', 'pragmatic-env-server']), [ReleaseApp.TenantIdp, ReleaseApp.EnvServer])
    })

    it('refuses an app it does not bake, listing the ones it does', () =>
    {
        for (const name of ['pragmatic-platform-admin', 'pragmatic-server', ''])
        {
            assert.throws(() => DevImages.ParseApps([name]), (e: Error) =>
                e instanceof DevImageUnknownError && e.message.includes(JSON.stringify(name)) && e.message.includes('pragmatic-ui-unpack'))
        }
    })
})

describe('DevImages.Build', () =>
{
    it('runs both bake steps of each app in its own checkout, in order', async () =>
    {
        await DevImagesFx.With([ReleaseApp.EnvServer, ReleaseApp.UiUnpack], async dir =>
        {
            const runner = new RecordingRunner()
            await DevImagesFx.Builder(dir, runner).Build([ReleaseApp.EnvServer, ReleaseApp.UiUnpack])
            assert.deepEqual(runner.Commands, [
                ...DevImages.BakeCommands(ReleaseApp.EnvServer, join(dir, ReleaseApp.EnvServer), DevImagesFx.Npmrc),
                ...DevImages.BakeCommands(ReleaseApp.UiUnpack, join(dir, ReleaseApp.UiUnpack), DevImagesFx.Npmrc),
            ])
        })
    })

    it('refuses a missing checkout by name before baking anything', async () =>
    {
        await DevImagesFx.With([ReleaseApp.EnvServer], async dir =>
        {
            const runner = new RecordingRunner()
            await assert.rejects(DevImagesFx.Builder(dir, runner).Build([ReleaseApp.EnvServer, ReleaseApp.HiveAgent]),
                (e: Error) => e instanceof RepositoryMissingError && e.message.includes(ReleaseApp.HiveAgent))
            assert.deepEqual(runner.Commands, [])
        })
    })

    it('refuses a missing .npmrc before baking anything, naming the variable that sets it', async () =>
    {
        await DevImagesFx.With([ReleaseApp.EnvServer], async dir =>
        {
            const runner = new RecordingRunner()
            await assert.rejects(DevImagesFx.Builder(dir, runner, false).Build([ReleaseApp.EnvServer]),
                (e: Error) => e instanceof DevImageNpmrcMissingError && e.message.includes(DevImagesFx.Npmrc) && e.message.includes('PRAGMATIC_E2E_NPMRC'))
            assert.deepEqual(runner.Commands, [])
        })
    })

    it('stops at the first failed bake step', async () =>
    {
        await DevImagesFx.With([ReleaseApp.EnvServer, ReleaseApp.UiUnpack], async dir =>
        {
            const runner = new RecordingRunner()
            runner.FailOn = 'components'
            await assert.rejects(DevImagesFx.Builder(dir, runner).Build([ReleaseApp.EnvServer, ReleaseApp.UiUnpack]), /bake failed/)
            assert.equal(runner.Commands.length, 1)
        })
    })
})

describe('DevImages.FromEnvironment', () =>
{
    it('reads the .npmrc from PRAGMATIC_E2E_NPMRC (resolved; blank is the default ~/.npmrc) and the checkouts from PRAGMATIC_E2E_REPOS_DIR', () =>
    {
        const dir = resolve('some-repos')
        const cases: ReadonlyArray<[NodeJS.ProcessEnv, string]> = [
            [{ PRAGMATIC_E2E_REPOS_DIR: dir, PRAGMATIC_E2E_NPMRC: 'x/.npmrc' }, resolve('x/.npmrc')],
            [{ PRAGMATIC_E2E_REPOS_DIR: dir, PRAGMATIC_E2E_NPMRC: '  ' }, join(homedir(), '.npmrc')],
            [{ PRAGMATIC_E2E_REPOS_DIR: dir }, join(homedir(), '.npmrc')],
        ]
        for (const [env, npmrc] of cases)
        {
            const builder = DevImages.FromEnvironment(env)
            assert.equal(builder.NpmrcFile, npmrc)
            assert.equal(builder.Roots.Directory, dir)
        }
    })
})
