import type { AuthConfig } from "convex/server";

// Tokens are issued by this deployment's own HTTP actions (see http.ts), so the issuer and the
// JWKS are always reachable from Convex, including for preview deployments of the app.
export default {
  providers: [
    {
      type: "customJwt",
      applicationID: "zenlo",
      issuer: process.env.CONVEX_SITE_URL!,
      jwks: `${process.env.CONVEX_SITE_URL}/.well-known/jwks.json`,
      algorithm: "ES256",
    },
  ],
} satisfies AuthConfig;
