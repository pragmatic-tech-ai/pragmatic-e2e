import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { IJourneyBrowser } from '../drivers/journey-browser.js'
import type { Evidence } from '../evidence.js'
import { JourneyConfig } from '../journey-config.js'
import { JourneyContext } from '../journey-context.js'
import type { IJourneyLeg } from '../journey-leg.js'
import { JourneyLock } from '../journey-lock.js'
import { JourneyPath } from '../journey-path.js'
import { JourneyMode, JourneyRun, JourneyRunFolder, UncleanedRunFinder, type IJourneyPathFactory } from '../journey-run.js'
import type { ILegSupervisor } from '../journey.js'
import type { JourneyLegInputs } from '../legs/journey-legs.js'
import { LegAbort } from '../waiter.js'
import { FakeBrowser, TempFolder } from './journey-fakes.js'

class Leg implements IJourneyLeg
{
    public readonly Dependencies = []
    public readonly DeadlineMs = 60_000

    public constructor(public readonly Name: string, private readonly log: string[], private readonly hang: boolean = false)
    {
    }

    public async Run(context: JourneyContext): Promise<void>
    {
        this.log.push(context.Path + ' run ' + this.Name)
        if (this.hang)
        {
            await new Promise(() => undefined)
        }
    }

    public async Clean(context: JourneyContext): Promise<void>
    {
        this.log.push(context.Path + ' clean ' + this.Name)
    }
}

class Factory implements IJourneyPathFactory
{
    public readonly Log: string[] = []
    public HangOn: string | undefined

    public Browser(_evidence: Evidence, _config: JourneyConfig, _abort: LegAbort): IJourneyBrowser & ILegSupervisor
    {
        return new FakeBrowser()
    }

    public Legs(path: JourneyPath, _inputs: JourneyLegInputs): IJourneyLeg[]
    {
        return ['a', 'b'].map(name => new Leg(name, this.Log, this.HangOn === path + '/' + name))
    }
}

class Setup
{
    public readonly Folder = new TempFolder()
    public readonly Config: JourneyConfig

    public constructor()
    {
        const seed = join(this.Folder.Path, 'seed')
        writeFileSync(seed, 'x'.repeat(40))
        this.Config = JourneyConfig.FromDocument({
            websiteUrl: 'https://www.example', cabinetUrl: 'https://cabinet.example', centralIssuer: 'https://login.example/realms/central', edgeUrl: 'https://agent.example',
            planName: 'Starter', emailDomain: 'pragmatic-lab.com', journeyDnsSubdomain: 'journey.pragmatic-lab.com', customerCluster: 'pragmatic-customer', liveDependencies: [],
        }, {
            PRAGMATIC_JOURNEY_PASSWORD_SEED_FILE: seed,
            PRAGMATIC_JOURNEY_RUNS_DIR: join(this.Folder.Path, 'runs'),
            PRAGMATIC_JOURNEY_LOCK_FILE: join(this.Folder.Path, 'lock'),
        }, '/repo')
    }

    public Run(runId: string, mode: JourneyMode, paths: JourneyPath[], factory: Factory, budgetMs: number = JourneyRun.BudgetMs): JourneyRun
    {
        return new JourneyRun(this.Config, runId, mode, paths, factory, new JourneyLock(this.Config.LockFile), budgetMs)
    }
}

describe('JourneyRun', () =>
{
    it('runs each path in turn, records them finished in run.json, writes the report and frees the lock', async () =>
    {
        const s = new Setup()
        const factory = new Factory()
        const run = s.Run('run-0001', JourneyMode.Run, [JourneyPath.Enrolled, JourneyPath.Hosted], factory)
        assert.equal(await run.Execute(), true)
        assert.deepEqual(factory.Log, ['enrolled run a', 'enrolled run b', 'enrolled clean b', 'enrolled clean a', 'hosted run a', 'hosted run b', 'hosted clean b', 'hosted clean a'])
        const manifest = JSON.parse(readFileSync(join(run.Folder, JourneyRunFolder.ManifestName), 'utf8')) as { Finished: string[] }
        assert.deepEqual(manifest.Finished, ['enrolled', 'hosted'])
        assert.ok(existsSync(join(run.Folder, 'journey-report.json')))
        assert.equal(existsSync(s.Config.LockFile), false)
        assert.deepEqual(JourneyRun.PathsFor(s.Config, 'run-0001', JourneyMode.Resume), [], 'a finished run has nothing to resume')
        s.Folder.Dispose()
    })

    it('resume continues a killed run: the interrupted path from its last good leg, the never-started one from its first', async () =>
    {
        const s = new Setup()
        const folder = new JourneyRunFolder(join(s.Config.RunsDir, 'run-0002'))
        folder.WriteManifest('run-0002', [JourneyPath.Enrolled, JourneyPath.Delegated], [])
        const killed = new JourneyContext('run-0002', JourneyPath.Enrolled)
        killed.MarkStarted('a')
        killed.MarkCompleted('a')
        killed.MarkStarted('b')
        folder.Save(killed)
        const paths = JourneyRun.PathsFor(s.Config, 'run-0002', JourneyMode.Resume)
        assert.deepEqual(paths, [JourneyPath.Enrolled, JourneyPath.Delegated])
        const factory = new Factory()
        assert.equal(await s.Run('run-0002', JourneyMode.Resume, paths, factory).Execute(), true)
        assert.deepEqual(factory.Log, ['enrolled run b', 'enrolled clean b', 'enrolled clean a', 'delegated run a', 'delegated run b', 'delegated clean b', 'delegated clean a'])
        const reports = readdirSync(folder.Root).filter(name => name.startsWith('journey-report.resume-'))
        assert.equal(reports.length, 2, 'the resume writes its own report (json and md), never over the run\'s')
        s.Folder.Dispose()
    })

    it('clean cleans every path with a context, and the uncleaned-run finder sees it until then', async () =>
    {
        const s = new Setup()
        const folder = new JourneyRunFolder(join(s.Config.RunsDir, 'run-0003'))
        const killed = new JourneyContext('run-0003', JourneyPath.Hosted)
        killed.MarkStarted('a')
        folder.Save(killed)
        const finder = new UncleanedRunFinder(s.Config.RunsDir)
        assert.deepEqual(finder.For(JourneyPath.Hosted, 'run-9999'), ['run-0003'])
        assert.deepEqual(finder.For(JourneyPath.Hosted, 'run-0003'), [], 'a run never claims against itself')
        assert.deepEqual(finder.For(JourneyPath.Enrolled, 'run-9999'), [])
        const factory = new Factory()
        assert.equal(await s.Run('run-0003', JourneyMode.Clean, JourneyRun.PathsFor(s.Config, 'run-0003', JourneyMode.Clean), factory).Execute(), true)
        assert.deepEqual(factory.Log, ['hosted clean a'])
        assert.deepEqual(finder.For(JourneyPath.Hosted, 'run-9999'), [])
        s.Folder.Dispose()
    })

    it('the run budget stops a hanging leg; the path is still cleaned', async () =>
    {
        const s = new Setup()
        const factory = new Factory()
        factory.HangOn = 'enrolled/b'
        const run = s.Run('run-0004', JourneyMode.Run, [JourneyPath.Enrolled], factory, 30)
        assert.equal(await run.Execute(), false)
        assert.deepEqual(factory.Log, ['enrolled run a', 'enrolled run b', 'enrolled clean b', 'enrolled clean a'])
        assert.match(run.Report.Legs(JourneyPath.Enrolled)[1].Detail, /run stopped: the run exceeded its time budget/)
        assert.deepEqual(JourneyRun.PathsFor(s.Config, 'run-0004', JourneyMode.Resume), [JourneyPath.Enrolled], 'a stopped path is not finished: resume continues it')
        s.Folder.Dispose()
    })

    it('a resume or clean of a missing run folder is refused by name', () =>
    {
        const s = new Setup()
        assert.throws(() => JourneyRun.PathsFor(s.Config, 'run-nope', JourneyMode.Clean), /no such run folder/)
        assert.match(JourneyRun.NewRunId(new Date('2026-11-23T10:15:30Z')), /^20261123t1015-[0-9a-f]{4}$/)
        s.Folder.Dispose()
    })
})
