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
