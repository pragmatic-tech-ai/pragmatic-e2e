import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DevStackFolders } from '../dev-stack-folders.js'

class DevScripts
{
    public static readonly Here = dirname(fileURLToPath(import.meta.url))
    public static readonly Utf8 = 'utf8'

    public static Text(name: string): string
    {
        return readFileSync(join(DevScripts.Here, '..', name), DevScripts.Utf8)
    }
}

describe('DevStackFolders', () =>
{
    it('keeps the dev data under ~/.pragmatic/dev-stack/data unless PRAGMATIC_DEV_DATA_ROOT names another folder', () =>
    {
        assert.equal(DevStackFolders.DataRoot({}), join(homedir(), '.pragmatic', 'dev-stack', 'data'))
        assert.equal(DevStackFolders.DataRoot({ PRAGMATIC_DEV_DATA_ROOT: ' ' }), DevStackFolders.DefaultDataRoot)
        assert.equal(DevStackFolders.DataRoot({ PRAGMATIC_DEV_DATA_ROOT: 'elsewhere' }), resolve('elsewhere'))
    })

    it('dev-up.sh hands the console the same folder and starts it from the pragmatic-platform-admin checkout', () =>
    {
        const up = DevScripts.Text('dev-up.sh')
        assert.ok(up.includes('${PRAGMATIC_DEV_DATA_ROOT:-$HOME/.pragmatic/dev-stack/data}'))
        assert.ok(up.includes('export PRAGMATIC_ADMIN_DATA_ROOT="$DATA"'))
        assert.ok(up.includes('${PRAGMATIC_E2E_REPOS_DIR:-'))
        assert.ok(up.includes('/pragmatic-platform-admin'))
        assert.ok(up.includes('export PRAGMATIC_CONTROL_PLANE_ROLE=admin'))
        assert.ok(up.includes('CERTS="$HOME/.pragmatic/dev-stack/certs"'))
    })

    it('dev-seed.sh writes the one-time owner password outside every repository', () =>
    {
        assert.ok(DevScripts.Text('dev-seed.sh').includes('INFO="$HOME/.pragmatic/dev-stack/dev-info.txt"'))
    })
})
