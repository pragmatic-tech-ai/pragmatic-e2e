/** The fetch the account client uses (the global one in a run; a recorded fake in tests). */
export type JourneyFetch = (input: string, init?: RequestInit) => Promise<Response>

/** What a password sign-in at Identity Platform found. */
export class CentralAccountState
{
    private constructor(public readonly Exists: boolean, public readonly EmailVerified: boolean, private readonly idToken: string | undefined)
    {
    }

    public static Absent(): CentralAccountState
    {
        return new CentralAccountState(false, false, undefined)
    }

    public static SignedIn(idToken: string, emailVerified: boolean): CentralAccountState
    {
        return new CentralAccountState(true, emailVerified, idToken)
    }

    /** The account's own ID token, for its self-delete; kept in memory, never logged. */
    public get IdToken(): string | undefined
    {
        return this.idToken
    }
}

/**
 * The synthetic customer's account at Identity Platform (the central realm's only source), through the same public
 * Identity Toolkit API and browser key the login page uses: sign in with the derived password, read `email_verified`
 * from the account's own ID token, and delete the account with that token (Identity Platform's self-delete). No admin
 * credential is involved; the browser key is public by design (served at `<issuer>/login/config`).
 *
 * Identity Platform's email-enumeration protection answers a missing account and a wrong password alike
 * (`INVALID_LOGIN_CREDENTIALS`), so "absent" means "no account this derived password signs in to". A leftover account
 * under a rotated seed then shows as a sign-up refusal (`EMAIL_EXISTS` on the login page), which names the runbook.
 * The realm keeps its linked account (the realm admin API has no delete); without the Identity Platform account it can
 * never sign in again.
 */
export class CentralAccount
{
    private static readonly ConfigPath = '/login/config'
    private static readonly Toolkit = 'https://identitytoolkit.googleapis.com/v1/'
    private static readonly SignInMethod = 'accounts:signInWithPassword'
    private static readonly DeleteMethod = 'accounts:delete'
    private static readonly LookupMethod = 'accounts:lookup'
    private static readonly LookupFailed = 'Identity Platform account lookup failed: '
    private static readonly KeyQuery = '?key='
    private static readonly Post = 'POST'
    private static readonly ContentType = 'content-type'
    private static readonly Referer = 'referer'
    private static readonly Json = 'application/json'
    private static readonly Slash = '/'
    private static readonly Dot = '.'
    private static readonly Base64Url = 'base64url'
    private static readonly Utf8 = 'utf8'
    private static readonly Space = ' '
    private static readonly Empty = ''
    // Shorter than the journey's settle grace, so an aborted leg's call ends before its clean starts.
    public static readonly TimeoutMs = 20_000
    private static readonly AbsentErrors: readonly string[] = ['EMAIL_NOT_FOUND', 'USER_NOT_FOUND', 'INVALID_LOGIN_CREDENTIALS', 'INVALID_PASSWORD']
    private static readonly NoBrowserKey = 'the central realm\'s login config names no Identity Platform browser key'
    private static readonly ConfigFailed = 'the central realm\'s login config answered '
    private static readonly SignInFailed = 'Identity Platform sign-in failed: '
    private static readonly DeleteFailed = 'Identity Platform account delete failed: '

    private browserKey: string | undefined
    private readonly origin: string

    public constructor(private readonly issuer: string, private readonly fetcher: JourneyFetch = fetch)
    {
        this.origin = new URL(issuer).origin
    }

    /** Signs the account in; Absent when no account signs in with this password (see the class note). */
    public async SignIn(email: string, password: string): Promise<CentralAccountState>
    {
        const C = CentralAccount
        const answer = await this.Toolkit(C.SignInMethod, { email, password, returnSecureToken: true })
        if (answer.ok && typeof answer.body.idToken === 'string')
        {
            return CentralAccountState.SignedIn(answer.body.idToken, C.EmailVerifiedOf(answer.body.idToken))
        }
        const reason = C.ReasonOf(answer.body)
        if (C.AbsentErrors.includes(reason))
        {
            return CentralAccountState.Absent()
        }
        throw new Error(C.SignInFailed + answer.status + C.Space + reason)
    }

    /** Deletes the account when it signs in; answers whether one was deleted. */
    public async DeleteIfPresent(email: string, password: string): Promise<boolean>
    {
        const state = await this.SignIn(email, password)
        if (!state.Exists || state.IdToken === undefined)
        {
            return false
        }
        await this.Delete(state.IdToken)
        return true
    }

    /**
     * Whether the account behind `idToken` has a verified email now (`accounts:lookup` with the account's own token:
     * no password sign-in per poll, so a wait does not run into Identity Platform's sign-in throttle).
     */
    public async IsVerified(idToken: string): Promise<boolean>
    {
        const C = CentralAccount
        const answer = await this.Toolkit(C.LookupMethod, { idToken })
        if (!answer.ok)
        {
            throw new Error(C.LookupFailed + answer.status + C.Space + C.ReasonOf(answer.body))
        }
        const users = answer.body.users as Array<{ emailVerified?: unknown }> | undefined
        return users?.[0]?.emailVerified === true
    }

    public async Delete(idToken: string): Promise<void>
    {
        const answer = await this.Toolkit(CentralAccount.DeleteMethod, { idToken })
        if (!answer.ok)
        {
            throw new Error(CentralAccount.DeleteFailed + answer.status + CentralAccount.Space + CentralAccount.ReasonOf(answer.body))
        }
    }

    private async BrowserKey(): Promise<string>
    {
        const C = CentralAccount
        if (this.browserKey === undefined)
        {
            const response = await this.fetcher(this.issuer + C.ConfigPath, { signal: AbortSignal.timeout(C.TimeoutMs) })
            if (!response.ok)
            {
                throw new Error(C.ConfigFailed + response.status)
            }
            const config = await response.json() as { identityPlatform?: { apiKey?: unknown } }
            const key = config.identityPlatform?.apiKey
            if (typeof key !== 'string' || key.length === 0)
            {
                throw new Error(C.NoBrowserKey)
            }
            this.browserKey = key
        }
        return this.browserKey
    }

    private async Toolkit(method: string, body: object): Promise<{ ok: boolean, status: number, body: Record<string, unknown> }>
    {
        const C = CentralAccount
        const key = await this.BrowserKey()
        const response = await this.fetcher(C.Toolkit + method + C.KeyQuery + encodeURIComponent(key), {
            method: C.Post,
            signal: AbortSignal.timeout(C.TimeoutMs),
            headers: { [C.ContentType]: C.Json, [C.Referer]: this.origin + C.Slash },
            body: JSON.stringify(body),
        })
        const json = await response.json().catch(() => ({})) as Record<string, unknown>
        return { ok: response.ok, status: response.status, body: json }
    }

    private static ReasonOf(body: Record<string, unknown>): string
    {
        const error = body.error as { message?: unknown } | undefined
        const message = typeof error?.message === 'string' ? error.message : CentralAccount.Empty
        return message.split(CentralAccount.Space)[0]
    }

    private static EmailVerifiedOf(idToken: string): boolean
    {
        const C = CentralAccount
        const payload = idToken.split(C.Dot)[1] ?? C.Empty
        try
        {
            const claims = JSON.parse(Buffer.from(payload, C.Base64Url).toString(C.Utf8)) as { email_verified?: unknown }
            return claims.email_verified === true
        }
        catch
        {
            return false
        }
    }
}
