import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { ReleaseApp, ReleaseApps } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { EnvironmentWorkloadFactory } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { DevPlatformImages } from '../../../repos/pragmatic-platform-admin/src/platform-images.js'
import { DockerEnv } from '../../../repos/pragmatic-platform-admin/src/environments/seed/docker.js'
import { RepositoryMissingError, RepositoryRoots } from '../../stack/repository-roots.js'
import { type DevImageCommand, DevImageNpmrcMissingError, DevImages, DevImageUnknownError, type IDevImageRunner, type IFileProbe, type ILogSink } from '../dev-images.js'

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

class FixedFileProbe implements IFileProbe
{
    public constructor(private readonly present: boolean)
    {
    }

    public Exists(_path: string): boolean
    {
        return this.present
    }
}

class SilentLog implements ILogSink
{
    public readonly Lines: string[] = []

    public Line(text: string): void
    {
        this.Lines.push(text)
    }
}

class DevImagesFx
{
    public static readonly Prefix = 'e2e-dev-images-'
    public static readonly Npmrc = '/home/dev/.npmrc'
    public static readonly Env = { NPMRC_FILE: '/home/dev/.npmrc', PLATFORMS: 'linux/amd64' }

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
        return new DevImages(new RepositoryRoots(dir), DevImagesFx.Npmrc, runner, new FixedFileProbe(npmrcExists), new SilentLog())
    }

    /** The exact bake steps for `app` at `root` with the fixture .npmrc, as each container repository's docker-bake.hcl header gives them. */
    public static Expected(app: ReleaseApp, tag: string, root: string): DevImageCommand[]
    {
        return [
            { file: 'docker', args: ['buildx', 'bake', '-f', 'docker-bake.hcl', '--allow=fs.read=/home/dev/.npmrc', 'components'], cwd: root, env: DevImagesFx.Env },
            {
                file: 'docker',
                args: ['buildx', 'bake', '-f', 'docker-bake.hcl', '-f', '.components/docker-bake.components.json', '--allow=fs.read=/home/dev/.npmrc',
                    '--set', app + '.tags=' + tag, '--load', app],
                cwd: root,
                env: DevImagesFx.Env,
            },
        ]
    }
}

describe('DevImages.BakeCommands', () =>
{
    it('bakes the components step, then the image target with the components override, loaded under the dev tag, for amd64', () =>
    {
        const root = '/repos/pragmatic-env-server'
        assert.deepEqual(DevImages.BakeCommands(ReleaseApp.EnvServer, root, DevImagesFx.Npmrc), DevImagesFx.Expected(ReleaseApp.EnvServer, 'pragmatic-env-server:dev', root))
    })

    it('gives every release app the exact steps, its image target named after it and tagged as the console runs it in local mode', () =>
    {
        const tags = new Map<ReleaseApp, string>([
            [ReleaseApp.PlatformAdmin, 'pragmatic-platform-admin:dev'],
            [ReleaseApp.PlatformEdge, 'pragmatic-platform-edge:dev'],
            [ReleaseApp.EnvServer, 'pragmatic-env-server:dev'],
            [ReleaseApp.EnvGateway, 'pragmatic-env-gateway:dev'],
            [ReleaseApp.HiveAgent, 'pragmatic-hive-agent:dev'],
            [ReleaseApp.TenantAdmin, 'pragmatic-tenant-admin:dev'],
            [ReleaseApp.TenantIdp, 'pragmatic-tenant-idp:dev'],
            [ReleaseApp.UiUnpack, 'pragmatic-ui-unpack:dev'],
            [ReleaseApp.Postgres, 'pragmatic-postgres:local'],
        ])
        for (const app of ReleaseApps.All)
        {
            const root = '/r/' + app
            assert.deepEqual(DevImages.BakeCommands(app, root, DevImagesFx.Npmrc), DevImagesFx.Expected(app, tags.get(app)!, root), app)
            assert.equal(tags.get(app), DevPlatformImages.Of(app), app)
        }
    })
})

describe('DevImages tags', () =>
{
    it('are the platform admin console\'s dev images: each app its own, the env server as the tenant plane names it', () =>
    {
        assert.deepEqual(DevImages.DevStackApps.map(app => DevImages.TagOf(app)), [
            'pragmatic-env-server:dev',
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

    it('the platform admin console\'s missing env server image hint names this builder\'s command', () =>
    {
        assert.equal(DockerEnv.BuildCommandText, DevImages.BuildCommandOf(ReleaseApp.EnvServer))
        assert.equal(DockerEnv.ImageName, DevImages.TagOf(ReleaseApp.EnvServer))
    })
})

describe('DevImages.ParseApps', () =>
{
    it('builds every dev stack image when no app is named', () =>
    {
        assert.deepEqual(DevImages.ParseApps([]), DevImages.DevStackApps)
    })

    it('keeps the named apps in order, and accepts any release app', () =>
    {
        assert.deepEqual(DevImages.ParseApps(['pragmatic-tenant-idp', 'pragmatic-env-server']), [ReleaseApp.TenantIdp, ReleaseApp.EnvServer])
        assert.deepEqual(DevImages.ParseApps([...ReleaseApps.All]), ReleaseApps.All)
    })

    it('refuses a name that is not a release app, listing the ones it bakes', () =>
    {
        for (const name of ['pragmatic-server', 'postgres', ''])
        {
            assert.throws(() => DevImages.ParseApps([name]), (e: Error) =>
                e instanceof DevImageUnknownError && e.message.includes(JSON.stringify(name)) && e.message.includes('pragmatic-ui-unpack') && e.message.includes('pragmatic-platform-admin'))
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
                ...DevImagesFx.Expected(ReleaseApp.EnvServer, 'pragmatic-env-server:dev', join(dir, ReleaseApp.EnvServer)),
                ...DevImagesFx.Expected(ReleaseApp.UiUnpack, 'pragmatic-ui-unpack:dev', join(dir, ReleaseApp.UiUnpack)),
            ])
        })
    })

    it('bakes nothing and checks nothing for no app (a skipped bake)', async () =>
    {
        const runner = new RecordingRunner()
        await DevImagesFx.Builder(join(tmpdir(), 'no-such-repos'), runner, false).Build([])
        assert.deepEqual(runner.Commands, [])
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

describe('DevImages.SkipsBake', () =>
{
    it('skips only for PRAGMATIC_DEV_SKIP_IMAGE_BAKE=1 exactly, as dev-up.sh reads it', () =>
    {
        assert.equal(DevImages.SkipsBake({ PRAGMATIC_DEV_SKIP_IMAGE_BAKE: '1' }), true)
        for (const env of [{}, { PRAGMATIC_DEV_SKIP_IMAGE_BAKE: '' }, { PRAGMATIC_DEV_SKIP_IMAGE_BAKE: '0' }, { PRAGMATIC_DEV_SKIP_IMAGE_BAKE: 'true' }, { PRAGMATIC_DEV_SKIP_IMAGE_BAKE: ' 1 ' }])
        {
            assert.equal(DevImages.SkipsBake(env), false, JSON.stringify(env))
        }
    })
})
