/** The three hive paths a journey proves; each runs as its own customer (dev-kit plan 2026-11-20-f-journey-tests.md). */
export enum JourneyPath
{
    Enrolled = 'enrolled',
    Delegated = 'delegated',
    Hosted = 'hosted',
}

/** Parses the `--paths` list; refuses an unknown or repeated path by name. */
export class JourneyPaths
{
    public static readonly All: readonly JourneyPath[] = [JourneyPath.Enrolled, JourneyPath.Delegated, JourneyPath.Hosted]
    private static readonly Separator = ','
    private static readonly UnknownPath = 'unknown journey path: '
    private static readonly RepeatedPath = 'journey path named twice: '
    private static readonly NoPath = 'no journey path named'

    public static Parse(list: string): JourneyPath[]
    {
        const paths: JourneyPath[] = []
        for (const raw of list.split(JourneyPaths.Separator))
        {
            const name = raw.trim()
            if (name.length === 0)
            {
                continue
            }
            const path = JourneyPaths.All.find(p => p === name)
            if (path === undefined)
            {
                throw new Error(JourneyPaths.UnknownPath + name)
            }
            if (paths.includes(path))
            {
                throw new Error(JourneyPaths.RepeatedPath + name)
            }
            paths.push(path)
        }
        if (paths.length === 0)
        {
            throw new Error(JourneyPaths.NoPath)
        }
        return paths
    }
}
