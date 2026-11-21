/**
 * The path segments of the env server's test fixtures (its TLS material and the sample solution), which the cluster
 * journeys read from the pragmatic-env-server checkout under repos/ (SiblingCheckouts.PathOf).
 */
export class ClusterFixtures
{
    public static readonly EnvServer = 'pragmatic-env-server'
    public static readonly Server = 'server'
    public static readonly Src = 'src'
    public static readonly Tests = 'tests'
    public static readonly Fixtures = 'fixtures'
    public static readonly Tls = 'tls'
    public static readonly SampleSolution = 'sample-solution'
}
