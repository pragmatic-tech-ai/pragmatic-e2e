import { createHmac } from 'node:crypto'
import type { JourneyPath } from '../journey-path.js'

/**
 * A path's synthetic customer: a fixed address per path (`journey-<path>@<domain>`; the journey mail worker handles
 * exactly these) and a password derived from the laptop's test-only seed (HMAC-SHA256 over the address), so any run,
 * also `journey clean` after a killed run, can sign that account in to remove it, while no password is ever stored in
 * a run's files. The password lives in memory only; callers register it with the evidence filter.
 */
export class JourneyIdentity
{
    private static readonly LocalPrefix = 'journey-'
    private static readonly At = '@'
    private static readonly Hmac = 'sha256'
    private static readonly Base64Url = 'base64url'
    private static readonly Purpose = 'pragmatic-journey/customer-password/v1:'
    // Identity Platform's policy and the login page ask for a mix; the suffix guarantees one of each class.
    private static readonly ClassSuffix = 'aA1!'
    private static readonly PasswordBodyLength = 24
    private static readonly MinimumSeedLength = 32
    private static readonly SeedTooShort = 'the journey password seed is too short (32 characters at least)'

    public readonly Email: string
    public readonly Password: string

    public constructor(public readonly Path: JourneyPath, emailDomain: string, seed: string)
    {
        const J = JourneyIdentity
        if (seed.length < J.MinimumSeedLength)
        {
            throw new Error(J.SeedTooShort)
        }
        this.Email = J.LocalPrefix + Path + J.At + emailDomain
        const body = createHmac(J.Hmac, seed).update(J.Purpose + this.Email).digest(J.Base64Url).slice(0, J.PasswordBodyLength)
        this.Password = body + J.ClassSuffix
    }
}
