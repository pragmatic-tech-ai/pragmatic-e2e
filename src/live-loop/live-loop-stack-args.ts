/** How Plexus signs in on the live-loop stack (`up --sign-in`): at the tenant's realm itself, or through the console. */
export enum LiveLoopSignIn
{
    /** E spec S1-S6: /desktop/console names the realm sign-in; Plexus signs in at the realm as `plexus`. */
    Realm = 'realm',
    /** The console-brokered desktop sign-in (until it retires, E spec section 7). */
    Transitional = 'transitional',
}

/** The arguments of `live-loop-stack.ts`: the verb and, for `up`, the sign-in mode (default realm). */
export class LiveLoopStackArgs
{
    public static readonly SignInFlag = '--sign-in'
    public static readonly UpVerb = 'up'
    private static readonly FlagValueSeparator = '='
    private static readonly BadSignInPrefix = '--sign-in takes realm or transitional, not: '
    private static readonly MissingSignIn = '--sign-in needs a value: realm or transitional'
    private static readonly UnknownArgPrefix = 'unknown argument: '
    private static readonly SignInOnlyForUp = '--sign-in is an option of up only'
    private static readonly RepeatedSignIn = '--sign-in is given more than once'
    /** Every parse error ends with the usage line. */
    public static readonly Usage = 'usage: live-loop-stack.ts up [--sign-in realm|transitional] | down'
    private static readonly UsageSeparator = '; '

    private constructor(public readonly Verb: string | undefined, public readonly SignIn: LiveLoopSignIn)
    {
        Object.freeze(this)
    }

    /** `argv` after the script: `up [--sign-in realm|transitional]`, `up --sign-in=<mode>`, or `down`. */
    public static Parse(argv: readonly string[]): LiveLoopStackArgs
    {
        const A = LiveLoopStackArgs
        const verb = argv[0]
        let signIn = LiveLoopSignIn.Realm
        let given = false
        for (let i = 1; i < argv.length; i++)
        {
            const arg = argv[i] as string
            const joined = arg.startsWith(A.SignInFlag + A.FlagValueSeparator)
            if (arg !== A.SignInFlag && !joined)
            {
                throw A.Error(A.UnknownArgPrefix + arg)
            }
            if (verb !== A.UpVerb)
            {
                throw A.Error(A.SignInOnlyForUp)
            }
            if (given)
            {
                throw A.Error(A.RepeatedSignIn)
            }
            given = true
            if (joined)
            {
                signIn = A.ModeOf(arg.slice(A.SignInFlag.length + A.FlagValueSeparator.length))
                continue
            }
            const value = argv[++i]
            if (value === undefined)
            {
                throw A.Error(A.MissingSignIn)
            }
            signIn = A.ModeOf(value)
        }
        return new LiveLoopStackArgs(verb, signIn)
    }

    private static ModeOf(value: string): LiveLoopSignIn
    {
        const mode = Object.values(LiveLoopSignIn).find(m => m === value)
        if (mode === undefined)
        {
            throw LiveLoopStackArgs.Error(LiveLoopStackArgs.BadSignInPrefix + value)
        }
        return mode
    }

    private static Error(reason: string): Error
    {
        return new Error(reason + LiveLoopStackArgs.UsageSeparator + LiveLoopStackArgs.Usage)
    }
}
