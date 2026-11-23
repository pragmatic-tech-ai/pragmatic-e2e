import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CentralAccount } from '../live/central-account.js'

/** A recorded Identity Toolkit: the login config, sign-in and delete answers, keyed by method. */
class FakeToolkit
{
    public readonly Requests: Array<{ url: string, body: Record<string, unknown>, referer: string | undefined }> = []
    public Accounts = new Map<string, { password: string, verified: boolean }>()

    public readonly Fetch = async (input: string, init?: RequestInit): Promise<Response> =>
    {
        if (input.endsWith('/login/config'))
        {
            return Response.json({ identityPlatform: { apiKey: 'browser-key' } })
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        const headers = init?.headers as Record<string, string>
        this.Requests.push({ url: input, body, referer: headers.referer })
        if (input.includes('accounts:signInWithPassword'))
        {
            const account = this.Accounts.get(String(body.email))
            if (account === undefined || account.password !== body.password)
            {
                return Response.json({ error: { message: 'INVALID_LOGIN_CREDENTIALS' } }, { status: 400 })
            }
            const claims = Buffer.from(JSON.stringify({ email: body.email, email_verified: account.verified })).toString('base64url')
            return Response.json({ idToken: 'eyJhbGciOiJSUzI1NiJ9.' + claims + '.sig-' + String(body.email) })
        }
        if (input.includes('accounts:lookup'))
        {
            const account = this.Accounts.get(String(body.idToken).split('.sig-')[1])
            return Response.json({ users: [{ emailVerified: account?.verified === true }] })
        }
        if (input.includes('accounts:delete'))
        {
            const email = String(body.idToken).split('.sig-')[1]
            this.Accounts.delete(email)
            return Response.json({})
        }
        return Response.json({ error: { message: 'UNEXPECTED' } }, { status: 500 })
    }
}

describe('CentralAccount', () =>
{
    it('signs in through the public toolkit with the login page\'s referer and reads email_verified', async () =>
    {
        const toolkit = new FakeToolkit()
        toolkit.Accounts.set('journey-enrolled@pragmatic-lab.com', { password: 'pw', verified: false })
        const account = new CentralAccount('https://login.pragmatic-tech.ai/realms/central', toolkit.Fetch)
        const unverified = await account.SignIn('journey-enrolled@pragmatic-lab.com', 'pw')
        assert.equal(unverified.Exists, true)
        assert.equal(unverified.EmailVerified, false)
        toolkit.Accounts.get('journey-enrolled@pragmatic-lab.com')!.verified = true
        assert.equal((await account.SignIn('journey-enrolled@pragmatic-lab.com', 'pw')).EmailVerified, true)
        assert.equal(toolkit.Requests[0].referer, 'https://login.pragmatic-tech.ai/')
        assert.match(toolkit.Requests[0].url, /accounts:signInWithPassword\?key=browser-key$/)
    })

    it('register\'s clean: DeleteIfPresent deletes the account with its own token, and answers false when none signs in', async () =>
    {
        const toolkit = new FakeToolkit()
        toolkit.Accounts.set('journey-hosted@pragmatic-lab.com', { password: 'pw', verified: true })
        const account = new CentralAccount('https://login.pragmatic-tech.ai/realms/central', toolkit.Fetch)
        assert.equal(await account.DeleteIfPresent('journey-hosted@pragmatic-lab.com', 'pw'), true)
        assert.equal(toolkit.Accounts.size, 0)
        assert.equal(await account.DeleteIfPresent('journey-hosted@pragmatic-lab.com', 'pw'), false)
        const deletes = toolkit.Requests.filter(r => r.url.includes('accounts:delete'))
        assert.equal(deletes.length, 1)
        assert.deepEqual(Object.keys(deletes[0].body), ['idToken'], 'self-delete: the account\'s own token, no admin credential')
    })

    it('IsVerified reads the account\'s current state with its own token (no password sign-in)', async () =>
    {
        const toolkit = new FakeToolkit()
        toolkit.Accounts.set('journey-delegated@pragmatic-lab.com', { password: 'pw', verified: false })
        const account = new CentralAccount('https://login.pragmatic-tech.ai/realms/central', toolkit.Fetch)
        const token = (await account.SignIn('journey-delegated@pragmatic-lab.com', 'pw')).IdToken!
        assert.equal(await account.IsVerified(token), false)
        toolkit.Accounts.get('journey-delegated@pragmatic-lab.com')!.verified = true
        assert.equal(await account.IsVerified(token), true)
        assert.equal(toolkit.Requests.filter(r => r.url.includes('accounts:signInWithPassword')).length, 1)
    })

    it('an unexpected toolkit answer fails with its status and reason', async () =>
    {
        const fetcher = async (input: string): Promise<Response> => input.endsWith('/login/config')
            ? Response.json({ identityPlatform: { apiKey: 'k' } })
            : Response.json({ error: { message: 'TOO_MANY_ATTEMPTS_TRY_LATER : slow down' } }, { status: 400 })
        await assert.rejects(new CentralAccount('https://login.example/realms/central', fetcher).SignIn('a@b.c', 'pw'), /400 TOO_MANY_ATTEMPTS_TRY_LATER/)
    })
})
