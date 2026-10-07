import { SignJWT, importJWK, jwtVerify, createLocalJWKSet, type JWK } from "jose";
import { AUDIENCE, JWT_TTL_S, SESSION_MAX_MS } from "../../lib/auth/siws";

function privateJwk(): JWK & { kid: string } {
  const raw = process.env.AUTH_JWT_PRIVATE_JWK;
  if (!raw) throw new Error("AUTH_JWT_PRIVATE_JWK is not set");
  const jwk = JSON.parse(raw) as JWK & { kid?: string };
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.d || !jwk.kid) throw new Error("AUTH_JWT_PRIVATE_JWK must be a P-256 private JWK with a kid");
  return jwk as JWK & { kid: string };
}

export function publicJwks(): { keys: JWK[] } {
  const { kty, crv, x, y, kid } = privateJwk();
  return { keys: [{ kty, crv, x, y, kid, alg: "ES256", use: "sig" }] };
}

const issuer = () => process.env.CONVEX_SITE_URL!;

export async function issueJwt(wallet: string, sid: string): Promise<string> {
  const jwk = privateJwk();
  const key = await importJWK(jwk, "ES256");
  return new SignJWT({ sid })
    .setProtectedHeader({ alg: "ES256", kid: jwk.kid, typ: "JWT" })
    .setSubject(wallet)
    .setIssuer(issuer())
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${JWT_TTL_S}s`)
    .sign(key);
}

/**
 * Verifies a token this deployment issued. Expiry is tolerated up to the session lifetime so an
 * expired access token can be exchanged for a fresh one; the session row is the real authority.
 */
export async function readOwnJwt(token: string): Promise<{ wallet: string; sid: string } | null> {
  try {
    const { payload } = await jwtVerify(token, createLocalJWKSet(publicJwks()), {
      issuer: issuer(),
      audience: AUDIENCE,
      algorithms: ["ES256"],
      clockTolerance: Math.floor(SESSION_MAX_MS / 1000),
    });
    if (typeof payload.sub !== "string" || typeof payload.sid !== "string") return null;
    return { wallet: payload.sub, sid: payload.sid };
  } catch {
    return null;
  }
}
