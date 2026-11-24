import type { PlatformServices } from '../../../repos/pragmatic-env-server/server/src/platform/platform-services.js'
import { CustomPlatformFixture } from '../../../repos/pragmatic-env-server/server/src/platform/tests/custom-platform-fixture.js'

/** The env server's platform bundle the in-process cross-container runs compose (A5: every bundle stores in its database). */
export class E2ePlatform
{
    /** The custom platform over an in-memory database (the env server's own test fixture). */
    public static Mem(): PlatformServices
    {
        return CustomPlatformFixture.Mem()
    }
}
