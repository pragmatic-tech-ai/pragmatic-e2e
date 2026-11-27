/** The context keys the legs share (ids, addresses and states only). */
export class JourneyKeys
{
    public static readonly RegistrationLink = 'registrationLink'
    public static readonly ClientName = 'clientName'
    public static readonly Email = 'email'
    public static readonly Registration = 'registration'
    public static readonly Plan = 'plan'
    public static readonly Checkout = 'checkout'
    public static readonly Subscription = 'subscription'
    public static readonly Tenant = 'tenant'
    public static readonly TenantState = 'tenantState'
    public static readonly Hive = 'hive'
    public static readonly HiveState = 'hiveState'
    public static readonly ConsoleUrl = 'consoleUrl'
    public static readonly ConsoleHost = 'consoleHost'
    public static readonly IdpHost = 'idpHost'
    public static readonly ConsoleTrusted = 'consoleTrusted'
    public static readonly Domain = 'domain'
    public static readonly DomainTxtName = 'domainTxtName'
    public static readonly DomainState = 'domainState'
    public static readonly Environment = 'environment'
    public static readonly EnvironmentState = 'environmentState'
    public static readonly StaffEmail = 'staffEmail'
    public static readonly StaffState = 'staffState'
}

/** The values the state keys take. */
export enum JourneyState
{
    SigningUp = 'signing-up',
    Registered = 'registered',
    CheckoutOpened = 'opened',
    CheckoutSubmitted = 'submitted',
    CheckoutPaid = 'paid',
    Active = 'active',
    CancelScheduled = 'cancel-scheduled',
    TenantCreated = 'created',
    EngineInstalling = 'installing',
    EngineInstalled = 'installed',
    HiveEnrolled = 'enrolled',
    HiveLeft = 'left',
    EnvironmentApproved = 'approved',
    EnvironmentReady = 'ready',
    ConsoleTrusted = 'verified',
    DomainChallenged = 'challenged',
    DomainVerified = 'domain-verified',
    StaffCreated = 'staff-created',
    StaffSignedIn = 'staff-signed-in',
    StaffDisabled = 'staff-disabled',
}

/** The leg names, in run order (the report's rows and the context's started/completed lists). */
export enum JourneyLegName
{
    Visit = 'visit',
    Register = 'register',
    Pay = 'pay',
    Tenant = 'tenant',
    InstallAndEnrol = 'install-and-enrol',
    PlaceHosted = 'place-hosted',
    Domain = 'domain',
    StaffSignIn = 'staff-sign-in',
    Plexus = 'plexus',
    DeployGraphs = 'deploy-graphs',
}
