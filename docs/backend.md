# Backend (Convex)

Convex holds operational data only: sign-in challenges, sessions, consented preferences, notifications, provider sessions, activity projections and durable jobs. Private conversations, private books, raw income proofs and viewing keys never go here.

Code lives in `app/convex/`. Pure logic shared with tests lives in `app/lib/auth/` and runs both in Convex and in `node --test`.

## Wallet sign-in

1. The page calls `POST {CONVEX_SITE_URL}/auth/challenge` with `{ wallet }`. The domain comes from the browser's `Origin` header and must match `AUTH_ALLOWED_DOMAINS` (exact hosts, or a `*` pattern within one label for previews). Each challenge expires in 5 minutes, and a wallet can have at most 5 open challenges.
2. The wallet signs the returned message. The message names the domain, network, nonce, issue time and expiry, and says it moves no funds.
3. `POST /auth/verify` checks the signature against the **stored** challenge, never against text the client sent. The nonce is consumed and the session opened in one Convex mutation, so a replay gets 401. A rejected signature does not burn the nonce.
4. Convex then issues a 15-minute ES256 JWT, `sub` = wallet and `sid` = session id. Convex verifies it as custom JWT auth against this deployment's own JWKS at `/.well-known/jwks.json`. Because the issuer is the Convex deployment itself, every app preview can reach it.
5. `POST /auth/refresh` exchanges a token, even an expired one, for a new token while its session is active. Sessions last at most 12 hours. `POST /auth/signout` revokes the session.
6. Convex functions identify the caller only through `requireWallet(ctx)` in `convex/auth.ts`. It reads the verified token subject and re-checks the session row, so a revoked session stops working before its token expires. A client-supplied wallet address is never used as proof of identity.

On the client, `BackendProvider` (`app/lib/auth/wallet-session.tsx`) sits inside the Devnet shell. It never prompts by itself: a feature calls `useBackendSession().signIn()`. Switching wallets signs the previous wallet out and clears its stored token. Landing and simulation pages do not load it.

Failed attempts are counted in `authFailures` by reason, for monitoring, without wallet addresses.

## Environments

| Where | How it is set up |
| --- | --- |
| Local | `cd app && npx convex dev` (or `CONVEX_AGENT_MODE=anonymous npx convex dev` without an account). This writes `CONVEX_DEPLOYMENT`, `NEXT_PUBLIC_CONVEX_URL` and `NEXT_PUBLIC_CONVEX_SITE_URL` to `app/.env.local`. |
| Preview and production | The Vercel Marketplace Convex integration (`vercel integration add convex`) connects the project and sets the public URLs per environment. Preview and production use separate Convex deployments. |

Deployment env vars, set with `npx convex env set` on each deployment and never in Vercel:

- `AUTH_JWT_PRIVATE_JWK`: generate with `node scripts/auth-keygen.mjs`. Never commit it.
- `AUTH_ALLOWED_DOMAINS`: comma-separated, for example `zenlo.vercel.app,zenlo-*-dres-projects-71e8c4e5.vercel.app`.
- `AUTH_NETWORK`: `devnet`.

## Checks

- `npm test` in `app/` covers the challenge rules: replayed or used nonce, wrong domain, exact expiry, wrong signer, forged nonce, and the domain patterns.
- `node scripts/auth-e2e.mjs` runs the full HTTP flow against a running deployment: disallowed origin, forged signature, valid sign-in, replay, Convex identity, refresh, and sign-out followed by refresh.
