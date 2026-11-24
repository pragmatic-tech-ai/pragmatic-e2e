import type { InternalApiCredential } from '@pragmatic-tech-ai/pragmatic-app-host'
import { CentralLoginSubject, ClientKind, EntitlementLimits, EntitlementState, EntitlementStatement, EntitlementsLink } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'

/** Where the stack's seed delivers the clients ledger's entitlement statement (the console's internal listener). */
export interface IEntitlementsLink
{
    /** POSTs one statement; answers the HTTP status. */
    PostStatement(statement: EntitlementStatement): Promise<number>
}

/**
 * The clients ledger's side of the console's entitlements link, as the stack plays it: clients are the ledger's
 * (pragmatic-platform-admin answers 405 to an operator's client create), so the seed sends the e2e client's statement
 * (`POST EntitlementsLink.StatementsPath` with the link's InternalApiCredential bearer, pragmatic-entitlements-contract's
 * own statement and credential) before the operator creates its tenant and hive, which the console admits against that
 * statement's limits.
 */
export class LiveLoopEntitlements implements IEntitlementsLink
{
    public static readonly StatusOk = 200
    public static readonly PlanId = 'e2e'
    public static readonly FirstVersion = 1
    /** A customer admin of the e2e client only: an e2e issuer, never the platform's central realm. */
    public static readonly AdminIssuer = 'https://central.e2e.invalid/realms/e2e'
    public static readonly AdminSubject = 'e2e-customer-admin'
    public static readonly AdminEmail = 'admin@e2e.test'
    /** One tenant and one hive, as the stack creates. */
    public static readonly Limits: Readonly<Record<string, number>> = Object.freeze({ 'tenants': 1, 'hives': 1, 'verified-domains': 1 })
    /** A console that accepts and never answers fails the seed instead of hanging `up`. */
    public static readonly TimeoutMs = 15_000
    private static readonly MethodPost = 'POST'
    private static readonly AuthorizationHeader = 'authorization'
    private static readonly ContentTypeHeader = 'content-type'
    private static readonly JsonType = 'application/json'
    private static readonly NoRedirects: RequestRedirect = 'manual'

    public constructor(private readonly internalBase: string, private readonly credential: InternalApiCredential)
    {
    }

    /** The link over the console's internal listener at `internalBase`, with the secret file the console reads too. */
    public static FromSecretFile(internalBase: string, secretFile: string): LiveLoopEntitlements
    {
        return new LiveLoopEntitlements(internalBase, EntitlementsLink.CredentialFromFile(secretFile))
    }

    /** Pure: the first statement of the stack's client (active, the stack's limits). */
    public static Statement(clientId: string, clientName: string, issuedAt: Date): EntitlementStatement
    {
        const E = LiveLoopEntitlements
        return EntitlementStatement.Create({
            ClientId: clientId,
            ClientKind: ClientKind.Organisation,
            ClientName: clientName,
            Admins: [CentralLoginSubject.Of(E.AdminIssuer, E.AdminSubject, E.AdminEmail)],
            PlanId: E.PlanId,
            Limits: EntitlementLimits.Of(E.Limits),
            State: EntitlementState.Active,
            Version: E.FirstVersion,
            IssuedAt: issuedAt,
        })
    }

    public async PostStatement(statement: EntitlementStatement): Promise<number>
    {
        const E = LiveLoopEntitlements
        const answer = await fetch(new URL(EntitlementsLink.StatementsPath, this.internalBase), {
            method: E.MethodPost,
            headers: { [E.AuthorizationHeader]: this.credential.AuthorizationValue(), [E.ContentTypeHeader]: E.JsonType },
            body: JSON.stringify(statement.ToJson()),
            redirect: E.NoRedirects,
            signal: AbortSignal.timeout(E.TimeoutMs),
        })
        await answer.arrayBuffer()
        return answer.status
    }
}
