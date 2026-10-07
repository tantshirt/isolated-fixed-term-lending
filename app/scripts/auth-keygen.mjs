// Prints a fresh ES256 private JWK for AUTH_JWT_PRIVATE_JWK. Set it with:
//   npx convex env set AUTH_JWT_PRIVATE_JWK "$(node scripts/auth-keygen.mjs)"
// Never commit the output.
import { exportJWK, generateKeyPair } from "jose";
import { randomUUID } from "node:crypto";

const { privateKey } = await generateKeyPair("ES256", { extractable: true });
const jwk = await exportJWK(privateKey);
process.stdout.write(JSON.stringify({ ...jwk, kid: randomUUID(), alg: "ES256" }));
