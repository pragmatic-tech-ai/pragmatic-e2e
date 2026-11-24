import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LiveLoopSignIn, LiveLoopStackArgs } from '../live-loop-stack-args.js'

class ArgsFx
{
    public static readonly Up = 'up'
    public static readonly Down = 'down'
    public static readonly Flag = LiveLoopStackArgs.SignInFlag
}

describe('LiveLoopStackArgs', () =>
{
    const A = ArgsFx

    it('up defaults to realm; --sign-in takes realm or transitional, separate or with =', () =>
    {
        assert.equal(LiveLoopStackArgs.Parse([A.Up]).SignIn, LiveLoopSignIn.Realm)
        assert.equal(LiveLoopStackArgs.Parse([A.Up]).Verb, A.Up)
        assert.equal(LiveLoopStackArgs.Parse([A.Up, A.Flag, LiveLoopSignIn.Transitional]).SignIn, LiveLoopSignIn.Transitional)
        assert.equal(LiveLoopStackArgs.Parse([A.Up, A.Flag + '=' + LiveLoopSignIn.Realm]).SignIn, LiveLoopSignIn.Realm)
        assert.equal(LiveLoopStackArgs.Parse([A.Down]).Verb, A.Down)
        assert.equal(LiveLoopStackArgs.Parse([]).Verb, undefined)
    })

    it('refuses another mode, a missing value and an unknown argument', () =>
    {
        assert.throws(() => LiveLoopStackArgs.Parse([A.Up, A.Flag, 'browser']), /realm or transitional, not: browser/)
        assert.throws(() => LiveLoopStackArgs.Parse([A.Up, A.Flag]), /needs a value/)
        assert.throws(() => LiveLoopStackArgs.Parse([A.Up, '--fast']), /unknown argument: --fast/)
    })

    it('refuses a repeated --sign-in, and ends every error with the usage line', () =>
    {
        assert.throws(() => LiveLoopStackArgs.Parse([A.Up, A.Flag, LiveLoopSignIn.Realm, A.Flag + '=' + LiveLoopSignIn.Transitional]), /given more than once/)
        assert.throws(() => LiveLoopStackArgs.Parse([A.Up, '--fast']), (err: Error) => err.message.endsWith(LiveLoopStackArgs.Usage))
    })

    it('takes --sign-in only with up', () =>
    {
        assert.throws(() => LiveLoopStackArgs.Parse([A.Down, A.Flag, LiveLoopSignIn.Realm]), /option of up only/)
        assert.throws(() => LiveLoopStackArgs.Parse([A.Down, A.Flag + '=' + LiveLoopSignIn.Realm]), /option of up only/)
        assert.throws(() => LiveLoopStackArgs.Parse([A.Down, '--fast']), /unknown argument/)
    })
})
