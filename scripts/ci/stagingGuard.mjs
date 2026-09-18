#!/usr/bin/env node
/**
 * Staging-target guard for write-capable Supabase test jobs.
 *
 * The RLS regression suite CREATES users, companies and rows in whichever
 * Supabase project it is pointed at. It must therefore be impossible to point
 * it at production, by construction. This guard runs BEFORE any client is
 * created and fails closed:
 *
 *   - the target project reference is parsed from the configured URL and must
 *     be well formed (https://<20-char-ref>.supabase.co, nothing else);
 *   - an EXPLICIT expected staging project reference must be configured
 *     (STAGING_SUPABASE_PROJECT_REF). There is deliberately no default: if it
 *     is absent the job refuses to run;
 *   - the production project reference is rejected as the target AND as the
 *     expected value;
 *   - the target must equal the expected staging reference;
 *   - if a key is a legacy JWT, its `ref` and `role` claims must not contradict
 *     the target.
 *
 * Nothing here ever prints a URL, key or project reference taken from the
 * configuration: failures are reported by stable code only.
 */
import { pathToFileURL } from 'node:url'

/** The production project. Immutable here; a test asserts it equals supabase/config.toml's project_id. */
export const PRODUCTION_PROJECT_REF = 'bvyivmmfjejbmqoydezk'

const PROJECT_REF_SHAPE = /^[a-z0-9]{20}$/
const SUPABASE_HOST_SHAPE = /^([a-z0-9]{20})\.supabase\.co$/

export class StagingGuardError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'StagingGuardError'
    this.code = code
  }
}

function fail(code, message) {
  throw new StagingGuardError(code, message)
}

/** Returns the project reference of a Supabase API URL, or throws. Never echoes the URL. */
export function parseProjectRef(url) {
  if (typeof url !== 'string' || url.trim() === '') fail('URL_MISSING', 'The staging Supabase URL is not configured.')
  let parsed
  try {
    parsed = new URL(url.trim())
  } catch {
    fail('URL_MALFORMED', 'The staging Supabase URL is not a valid URL.')
  }
  if (parsed.protocol !== 'https:') fail('URL_MALFORMED', 'The staging Supabase URL must use https.')
  if (parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    fail('URL_MALFORMED', 'The staging Supabase URL must be a bare https://<project-ref>.supabase.co address.')
  }
  const match = SUPABASE_HOST_SHAPE.exec(parsed.hostname)
  if (!match) fail('PROJECT_REF_MALFORMED', 'The staging Supabase URL does not contain a well-formed project reference.')
  return match[1]
}

/** Decodes a legacy JWT key's payload WITHOUT verifying it, only to cross-check claims. Returns null for opaque keys. */
function jwtClaims(key) {
  if (typeof key !== 'string') return null
  const parts = key.split('.')
  if (parts.length !== 3) return null
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    const claims = JSON.parse(json)
    return claims && typeof claims === 'object' ? claims : null
  } catch {
    return null
  }
}

/**
 * Throws StagingGuardError unless the configuration unambiguously targets the
 * explicitly configured staging project and not production.
 * Returns the verified project reference.
 */
export function assertStagingTarget({ url, expectedRef, anonKey, serviceRoleKey }) {
  const targetRef = parseProjectRef(url)

  if (typeof expectedRef !== 'string' || expectedRef.trim() === '') {
    fail('EXPECTED_REF_MISSING', 'STAGING_SUPABASE_PROJECT_REF is not configured. The staging RLS job is disabled until an explicit staging project reference is provided.')
  }
  const expected = expectedRef.trim()
  if (!PROJECT_REF_SHAPE.test(expected)) fail('EXPECTED_REF_MALFORMED', 'STAGING_SUPABASE_PROJECT_REF is not a well-formed project reference.')
  if (expected === PRODUCTION_PROJECT_REF) fail('EXPECTED_REF_IS_PRODUCTION', 'STAGING_SUPABASE_PROJECT_REF names the production project; refusing.')
  if (targetRef === PRODUCTION_PROJECT_REF) fail('TARGET_IS_PRODUCTION', 'The configured Supabase URL points at the production project; refusing to run write-capable tests.')
  if (targetRef !== expected) fail('TARGET_MISMATCH', 'The configured Supabase URL does not match the expected staging project; refusing.')

  for (const [label, key, expectedRole] of [['anon', anonKey, 'anon'], ['service-role', serviceRoleKey, 'service_role']]) {
    const claims = jwtClaims(key)
    if (!claims) continue
    if (claims.ref !== undefined && claims.ref !== expected) fail('KEY_PROJECT_MISMATCH', `The ${label} key belongs to a different project than the expected staging project; refusing.`)
    if (claims.role !== undefined && claims.role !== expectedRole) fail('KEY_ROLE_MISMATCH', `The ${label} key does not carry the expected role; refusing.`)
  }
  return targetRef
}

/** Reads the STAGING_* variables. Never falls back to any generic SUPABASE_* variable. */
export function assertStagingTargetFromEnv(env = process.env) {
  return assertStagingTarget({
    url: env.STAGING_SUPABASE_URL,
    expectedRef: env.STAGING_SUPABASE_PROJECT_REF,
    anonKey: env.STAGING_SUPABASE_ANON_KEY,
    serviceRoleKey: env.STAGING_SUPABASE_SERVICE_ROLE_KEY,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertStagingTargetFromEnv()
    console.log('Staging target verified: the configured Supabase project matches the expected staging project and is not production.')
  } catch (err) {
    if (err instanceof StagingGuardError) {
      console.error(`::error::Staging guard refused to run [${err.code}]: ${err.message}`)
      process.exit(1)
    }
    console.error('::error::Staging guard failed unexpectedly; refusing to run.')
    process.exit(1)
  }
}
