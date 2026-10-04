// DISPOSABLE SPIKE — NOT PRODUCTION CODE.
// Simulates a Supabase Auth project's asymmetric signing key locally (ES256 + JWKS) so the
// server-side verification step can be exercised offline. Real deployments verify against
// https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json (or supabase.auth.getClaims()).
import { generateKeyPair, exportJWK, SignJWT, jwtVerify, createLocalJWKSet } from 'jose';

const ISSUER = 'https://spike-project.supabase.co/auth/v1';
const { publicKey, privateKey } = await generateKeyPair('ES256');
const publicJwk = { ...(await exportJWK(publicKey)), kid: 'spike-key-1', alg: 'ES256', use: 'sig' };
const JWKS = createLocalJWKSet({ keys: [publicJwk] });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// TEST-ONLY token issuer (stands in for Supabase Auth / GoTrue). Claim shape follows Supabase docs.
export async function issueTestToken(sub, overrides = {}, key = privateKey) {
  const claims = { sub, role: 'authenticated', aud: 'authenticated', session_id: crypto.randomUUID(), ...overrides };
  let jwt = new SignJWT(claims).setProtectedHeader({ alg: 'ES256', kid: 'spike-key-1' })
    .setIssuer(overrides.iss ?? ISSUER).setIssuedAt();
  jwt = jwt.setExpirationTime(overrides.expSeconds ?? '5m');
  return jwt.sign(key);
}

export async function foreignKey() {
  return (await generateKeyPair('ES256')).privateKey;
}

// Server-side verification. Only an allowlisted database role can ever be derived from a token.
const ALLOWED_DB_ROLES = new Set(['authenticated']);
export async function verifyAccessToken(token) {
  const { payload } = await jwtVerify(token, JWKS, { issuer: ISSUER, audience: 'authenticated', algorithms: ['ES256'] });
  if (!ALLOWED_DB_ROLES.has(payload.role)) throw new Error(`token role not allowed: ${payload.role}`);
  if (typeof payload.sub !== 'string' || !UUID.test(payload.sub)) throw new Error('token sub is not a user id');
  return payload;
}
