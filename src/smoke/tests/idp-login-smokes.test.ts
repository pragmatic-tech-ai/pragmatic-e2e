import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

class SmokeSources
{
    public static readonly Files: readonly string[] = ['in-hive-console-smoke.ts', 'in-cluster-federation-smoke.ts', 'tenant-login-e2e-smoke.ts']
    public static readonly WaitCall = 'IdpLoginPage.WaitForForm('
    public static readonly SubmitCall = 'IdpLoginPage.Submit('
    public static readonly RetiredNameSelector = 'input[name='
    public static readonly RetiredSubmitButton = 'button[type=submit]'
    private static readonly Utf8 = 'utf8'

    public static Text(file: string): string
    {
        return readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', file), SmokeSources.Utf8)
    }
}

// The IdpLoginPage helper itself is pragmatic-platform-admin's (and tested there); this repository holds the smokes.
describe('IdP-login smokes', () =>
{
    it('every IdP-login smoke signs in through IdpLoginPage, never the retired name= / submit-button selectors', () =>
    {
        const S = SmokeSources
        for (const file of S.Files)
        {
            const text = S.Text(file)
            assert.ok(text.includes(S.WaitCall) && text.includes(S.SubmitCall), file)
            assert.ok(!text.includes(S.RetiredNameSelector) && !text.includes(S.RetiredSubmitButton), file)
        }
    })
})
