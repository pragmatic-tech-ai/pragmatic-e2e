import type { JourneyContext } from './journey-context.js'
import type { JourneyDependency } from './journey-dependency.js'

/**
 * One step of the owner journey. `Run` drives the live platform and records what it created in the context (ids and
 * addresses only, never a secret); `Clean` undoes it and must work from the context alone, after a failure, a time-out
 * or a killed process (`journey clean <run id>`), and when `Run` got only part of the way.
 */
export interface IJourneyLeg
{
    readonly Name: string
    readonly Dependencies: readonly JourneyDependency[]
    /** The leg fails with this deadline when `Run` has not finished by then. */
    readonly DeadlineMs: number
    Run(context: JourneyContext): Promise<void>
    Clean(context: JourneyContext): Promise<void>
}
