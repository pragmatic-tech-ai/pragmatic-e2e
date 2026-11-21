import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { request } from 'node:https'
import { connect as tlsConnect } from 'node:tls'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DevCa } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import { TenantPlaneTlsFront } from '../tenant-plane-tls-front.js'

/** The tenant plane stand-in: echoes what reached it; answers an upgrade with 101 and echoes the socket. */
class EchoTarget
{
    public readonly Server: Server

    public constructor()
    {
        this.Server = createServer((req, res) =>
        {
            let body = ''
            req.on('data', chunk => { body += String(chunk) })
            req.on('end', () =>
            {
                res.setHeader('set-cookie', ['a=1; Path=/', 'b=2; Path=/'])
                res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }))
            })
        })
        this.Server.on('upgrade', (req, socket) =>
        {
            socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n')
            socket.on('data', chunk => socket.write(chunk))
        })
    }

    public Listen(): Promise<number>
    {
        return new Promise(done => this.Server.listen(0, '127.0.0.1', () => done((this.Server.address() as { port: number }).port)))
    }
}

describe('TenantPlaneTlsFront', () =>
{
    const dir = mkdtempSync(join(tmpdir(), 'tls-front-'))
    const target = new EchoTarget()
    let front: TenantPlaneTlsFront
    let port = 0
    let ca: Buffer

    before(async () =>
    {
        const files = DevCa.EnsureAt(dir, 'e2e.lvh.me')
        ca = readFileSync(files.caFile)
        const targetPort = await target.Listen()
        front = new TenantPlaneTlsFront({ listenPort: 0, targetPort, certFile: files.certFile, keyFile: files.keyFile })
        port = await front.Start()
    })

    after(async () =>
    {
        await front.Stop()
        target.Server.close()
        rmSync(dir, { recursive: true, force: true })
    })

    const call = (method: string, path: string, body?: string): Promise<{ status: number; headers: IncomingHttpHeaders; json: Record<string, unknown> }> =>
        new Promise((done, fail) =>
        {
            const req = request({ host: '127.0.0.1', port, method, path, ca, servername: 'e2e.lvh.me', headers: { host: 'e2e.lvh.me:7443', origin: 'https://e2e.lvh.me:7443' } }, res =>
            {
                let text = ''
                res.on('data', chunk => { text += String(chunk) })
                res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, json: JSON.parse(text) as Record<string, unknown> }))
            })
            req.on('error', fail)
            req.end(body)
        })

    it('serves TLS with the stack certificate and passes method, path, body and the browser\'s Host and Origin through', async () =>
    {
        const answer = await call('POST', '/tenant-api/x?y=1', '{"a":1}')
        assert.equal(answer.status, 200)
        assert.equal(answer.json.method, 'POST')
        assert.equal(answer.json.url, '/tenant-api/x?y=1')
        assert.equal(answer.json.body, '{"a":1}')
        const headers = answer.json.headers as Record<string, string>
        assert.equal(headers.host, 'e2e.lvh.me:7443')
        assert.equal(headers.origin, 'https://e2e.lvh.me:7443')
        assert.equal(headers['x-forwarded-proto'], 'https')
    })

    it('passes every Set-Cookie of the answer back', async () =>
    {
        const answer = await call('GET', '/')
        assert.deepEqual(answer.headers['set-cookie'], ['a=1; Path=/', 'b=2; Path=/'])
    })

    it('relays a connection upgrade both ways', async () =>
    {
        const reply = await new Promise<string>((done, fail) =>
        {
            const socket = tlsConnect({ host: '127.0.0.1', port, ca, servername: 'e2e.lvh.me' }, () =>
            {
                socket.write('GET /ws HTTP/1.1\r\nHost: e2e.lvh.me:7443\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n')
            })
            let seen = ''
            socket.on('data', chunk =>
            {
                seen += String(chunk)
                if (seen.includes('\r\n\r\n') && !seen.includes('ping'))
                {
                    socket.write('ping')
                }
                if (seen.endsWith('ping'))
                {
                    socket.end()
                    done(seen)
                }
            })
            socket.on('error', fail)
        })
        assert.match(reply, /^HTTP\/1\.1 101 /)
        assert.ok(reply.endsWith('ping'))
    })

    it('answers 502 when the tenant plane is down', async () =>
    {
        const files = DevCa.EnsureAt(dir, 'e2e.lvh.me')
        const dead = new TenantPlaneTlsFront({ listenPort: 0, targetPort: 1, certFile: files.certFile, keyFile: files.keyFile })
        const deadPort = await dead.Start()
        try
        {
            const status = await new Promise<number>((done, fail) =>
            {
                const req = request({ host: '127.0.0.1', port: deadPort, path: '/', ca, servername: 'e2e.lvh.me' }, res =>
                {
                    res.resume()
                    done(res.statusCode ?? 0)
                })
                req.on('error', fail)
                req.end()
            })
            assert.equal(status, 502)
        }
        finally
        {
            await dead.Stop()
        }
    })

    it('reads its settings from the environment and refuses a missing one by name', () =>
    {
        const options = TenantPlaneTlsFront.OptionsOf({
            PRAGMATIC_E2E_TLS_FRONT_PORT: '7443', PRAGMATIC_E2E_TLS_FRONT_TARGET_PORT: '7100',
            PRAGMATIC_E2E_TLS_FRONT_CERT_FILE: '/s/server.crt', PRAGMATIC_E2E_TLS_FRONT_KEY_FILE: '/s/server.key',
        })
        assert.deepEqual(options, { listenPort: 7443, targetPort: 7100, certFile: '/s/server.crt', keyFile: '/s/server.key' })
        assert.throws(() => TenantPlaneTlsFront.OptionsOf({ PRAGMATIC_E2E_TLS_FRONT_PORT: '7443' }), /PRAGMATIC_E2E_TLS_FRONT_TARGET_PORT/)
    })
})
