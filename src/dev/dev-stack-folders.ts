import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Where the durable local dev stack keeps the console's files (master key, public keys, the development CA, the IdP TLS
 * material, the database password and URL file): PRAGMATIC_DEV_DATA_ROOT, by default ~/.pragmatic/dev-stack/data, never a
 * folder inside a (public) repository. dev-up.sh hands the same folder to the console as PRAGMATIC_ADMIN_DATA_ROOT.
 */
export class DevStackFolders
{
    public static readonly DataRootEnvVar = 'PRAGMATIC_DEV_DATA_ROOT'
    public static readonly DefaultDataRoot = join(homedir(), '.pragmatic', 'dev-stack', 'data')

    /** PRAGMATIC_DEV_DATA_ROOT (resolved) when set and not blank, else the default. */
    public static DataRoot(env: NodeJS.ProcessEnv): string
    {
        const raw = env[DevStackFolders.DataRootEnvVar]?.trim() ?? ''
        return raw === '' ? DevStackFolders.DefaultDataRoot : resolve(raw)
    }
}
