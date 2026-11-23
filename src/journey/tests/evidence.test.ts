import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Evidence, EvidenceFilter, type IScreenshotPage } from '../evidence.js'
import { MemorySink, TempFolder } from './journey-fakes.js'

class ShotPage implements IScreenshotPage
{
    public Shots = 0

    public constructor(private readonly pageUrl: string, private readonly frameUrls: string[] = [])
    {
    }

    public Url(): string
    {
        return this.pageUrl
    }

    public FrameUrls(): readonly string[]
    {
        return this.frameUrls
    }

    public async Screenshot(_path: string, _timeoutMs: number): Promise<void>
    {
        this.Shots++
    }
}

describe('EvidenceFilter', () =>
{
    const filter = new EvidenceFilter(['cabinet.pragmatic-tech.ai', 'login.pragmatic-tech.ai'], ['paddle.com'])

    it('admits screenshots of allow-listed hosts only, and none while a Paddle frame is attached', () =>
    {
        assert.equal(filter.AllowsScreenshot('https://cabinet.pragmatic-tech.ai/', []), true)
        assert.equal(filter.AllowsScreenshot('https://evil.example/', []), false)
        assert.equal(filter.AllowsScreenshot('not a url', []), false)
        assert.equal(filter.AllowsScreenshot('https://cabinet.pragmatic-tech.ai/', ['https://sandbox-buy.paddle.com/checkout']), false)
        assert.equal(filter.AllowsScreenshot('https://cabinet.pragmatic-tech.ai/', ['https://cdn.paddle.com/x', 'about:blank']), false)
        assert.equal(filter.AllowsScreenshot('https://cabinet.pragmatic-tech.ai/', ['about:blank']), true)
    })

    it('never admits a denied page (the registration page showing the campaign code), whatever its query', () =>
    {
        const f = new EvidenceFilter(['cabinet.pragmatic-tech.ai'], [])
        f.DenyPage('https://cabinet.pragmatic-tech.ai/register')
        assert.equal(f.AllowsScreenshot('https://cabinet.pragmatic-tech.ai/register?code=J-1', []), false)
        assert.equal(f.AllowsScreenshot('https://cabinet.pragmatic-tech.ai/', []), true)
    })

    it('redacts registered secrets and token-shaped patterns', () =>
    {
        const f = new EvidenceFilter([], [])
        f.AddSecret('S3cretPassw0rd')
        const text = f.Redact('pw S3cretPassw0rd tok eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc Bearer abc.def oobCode=XYZ&x=1 card 4242 4242 4242 4242 ?password=hunter2')
        for (const leak of ['S3cretPassw0rd', 'eyJhbGci', 'abc.def', 'XYZ', '4242 4242', 'hunter2'])
        {
            assert.ok(!text.includes(leak), leak)
        }
        assert.match(text, /\[redacted\]/)
    })
})

describe('Evidence', () =>
{
    it('writes redacted step lines to steps.log and the sink, and remembers them as the leg\'s evidence', () =>
    {
        const folder = new TempFolder()
        const filter = new EvidenceFilter([], [])
        filter.AddSecret('topsecret-value')
        const sink = new MemorySink()
        const evidence = new Evidence(folder.Path, filter, sink)
        evidence.Step('register', 'typed topsecret-value')
        const log = readFileSync(join(folder.Path, Evidence.StepLogName), 'utf8')
        assert.match(log, /\[register\] typed \[redacted\]/)
        assert.ok(!log.includes('topsecret-value'))
        assert.ok(!sink.Lines.join('').includes('topsecret-value'))
        assert.deepEqual(evidence.Ids('register'), [Evidence.StepLogName])
        folder.Dispose()
    })

    it('takes a failure screenshot only when the filter admits the page', async () =>
    {
        const folder = new TempFolder()
        const evidence = new Evidence(folder.Path, new EvidenceFilter(['cabinet.pragmatic-tech.ai'], ['paddle.com']), new MemorySink())
        const admitted = new ShotPage('https://cabinet.pragmatic-tech.ai/')
        const withPaddle = new ShotPage('https://cabinet.pragmatic-tech.ai/', ['https://sandbox-buy.paddle.com/'])
        const id = await evidence.FailureScreenshot('pay', admitted)
        assert.equal(id, 'pay-1.png')
        assert.equal(await evidence.FailureScreenshot('pay', withPaddle), undefined)
        assert.equal(admitted.Shots, 1)
        assert.equal(withPaddle.Shots, 0)
        assert.ok(evidence.Ids('pay').includes('pay-1.png'))
        assert.match(readFileSync(join(folder.Path, Evidence.StepLogName), 'utf8'), /screenshot withheld/)
        assert.equal(existsSync(join(folder.Path, 'pay-2.png')), false)
        folder.Dispose()
    })
})
