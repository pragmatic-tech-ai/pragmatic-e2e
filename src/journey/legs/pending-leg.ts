import type { JourneyContext } from '../journey-context.js'
import type { JourneyDependency } from '../journey-dependency.js'
import type { IJourneyLeg } from '../journey-leg.js'

/**
 * A leg whose live dependencies are not there yet (dev-kit F plan Task 8): it holds its place in the run order and its
 * dependency list, so the report shows it pending on what delivers it. It has no driver yet: should its dependencies
 * be named live before the leg is built, Run fails loudly instead of passing. It never started, so Clean has nothing.
 */
export class PendingLeg implements IJourneyLeg
{
    public readonly DeadlineMs = 60_000
    private static readonly NotBuilt = 'leg not built yet (its dependencies are named live, but the leg is still the skeleton): '

    public constructor(public readonly Name: string, public readonly Dependencies: readonly JourneyDependency[])
    {
    }

    public async Run(_context: JourneyContext): Promise<void>
    {
        throw new Error(PendingLeg.NotBuilt + this.Name)
    }

    public async Clean(_context: JourneyContext): Promise<void>
    {
    }
}
