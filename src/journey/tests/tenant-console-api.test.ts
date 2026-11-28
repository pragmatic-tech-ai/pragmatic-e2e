import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TenantConsoleApi } from '../drivers/tenant-console-api.js'
import { FakePage } from './journey-fakes.js'

const Env = 'journey'
const Base = '/tenant-api/environments/journey/admin'
const Email = 'staff@r.example.com'
const Principal = 'staff-r'

class ApiWorld
{
    public readonly Page = new FakePage()
    public readonly Api = new TenantConsoleApi()

    public Snapshot(accounts: Array<{ principalId: string, email: string, disabled: boolean }>, grants: Array<{ subject: string, role: string }> = []): void
    {
        this.Page.RequestJsonResponses.set('GET ' + Base + '/snapshot', { accounts, grants })
    }
}

describe('TenantConsoleApi', () =>
{
    it('AccountExists reads the snapshot by email', async () =>
    {
        const w = new ApiWorld()
        w.Snapshot([])
        assert.equal(await w.Api.AccountExists(w.Page, Env, Email), false)
        w.Snapshot([{ principalId: Principal, email: Email, disabled: false }])
        assert.equal(await w.Api.AccountExists(w.Page, Env, Email), true)
        assert.equal(w.Page.RequestJsonCalls[0].Method, 'GET')
        assert.equal(w.Page.RequestJsonCalls[0].Path, Base + '/snapshot')
    })

    it('CreateAccount posts email, principalId and password', async () =>
    {
        const w = new ApiWorld()
        await w.Api.CreateAccount(w.Page, Env, Email, Principal, 'pw')
        assert.deepEqual(w.Page.RequestJsonCalls, [{ Method: 'POST', Path: Base + '/accounts', Body: { email: Email, principalId: Principal, password: 'pw' } }])
    })

    it('HasGrant matches subject and role', async () =>
    {
        const w = new ApiWorld()
        w.Snapshot([], [{ subject: Principal, role: 'Viewer' }])
        assert.equal(await w.Api.HasGrant(w.Page, Env, Principal, TenantConsoleApi.AdminRole), false)
        w.Snapshot([], [{ subject: Principal, role: 'Admin' }])
        assert.equal(await w.Api.HasGrant(w.Page, Env, Principal, TenantConsoleApi.AdminRole), true)
    })

    it('GrantRole posts subject and role', async () =>
    {
        const w = new ApiWorld()
        await w.Api.GrantRole(w.Page, Env, Principal, TenantConsoleApi.AdminRole)
        assert.deepEqual(w.Page.RequestJsonCalls, [{ Method: 'POST', Path: Base + '/grants', Body: { subject: Principal, role: 'Admin' } }])
    })

    it('DisableAccount deletes an enabled account and skips a disabled one', async () =>
    {
        const w = new ApiWorld()
        w.Snapshot([{ principalId: Principal, email: Email, disabled: true }])
        assert.equal(await w.Api.DisableAccount(w.Page, Env, Principal), false)
        assert.ok(!w.Page.RequestJsonCalls.some(c => c.Method === 'DELETE'))
        w.Snapshot([{ principalId: Principal, email: Email, disabled: false }])
        assert.equal(await w.Api.DisableAccount(w.Page, Env, Principal), true)
        assert.ok(w.Page.RequestJsonCalls.some(c => c.Method === 'DELETE' && c.Path === Base + '/accounts/' + Principal))
    })

    it('encodes the environment and principal in paths', async () =>
    {
        const w = new ApiWorld()
        await w.Api.GrantRole(w.Page, 'a b', 'p', 'Admin')
        assert.equal(w.Page.RequestJsonCalls[0].Path, '/tenant-api/environments/a%20b/admin/grants')
    })

    it('ListGraphs reads the environment graphs from an array or a graphs object, empty otherwise', async () =>
    {
        const w = new ApiWorld()
        const path = 'GET /tenant-api/environments/journey/graphs'
        assert.deepEqual(await w.Api.ListGraphs(w.Page, Env), [])
        w.Page.RequestJsonResponses.set(path, [{ name: 'g1' }])
        assert.equal((await w.Api.ListGraphs(w.Page, Env)).length, 1)
        w.Page.RequestJsonResponses.set(path, { graphs: [{ name: 'g1' }, { name: 'g2' }] })
        assert.equal((await w.Api.ListGraphs(w.Page, Env)).length, 2)
        w.Page.RequestJsonResponses.set(path, { other: 1 })
        assert.deepEqual(await w.Api.ListGraphs(w.Page, Env), [])
    })
})
