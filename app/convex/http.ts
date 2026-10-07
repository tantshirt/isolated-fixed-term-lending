import { httpRouter } from "convex/server";
import { httpAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { domainAllowed, isWalletAddress, newNonce, verifyChallenge, challengeMessage } from "../lib/auth/siws";
import { issueJwt, publicJwks, readOwnJwt } from "./lib/jwt";

const http = httpRouter();

function allowedDomains(): string[] {
  return (process.env.AUTH_ALLOWED_DOMAINS ?? "").split(",");
}

/** The browser sets Origin, so the signed domain is bound to the page that asked for it. */
function originDomain(req: Request): string | null {
  const origin = req.headers.get("Origin");
  if (!origin) return null;
  try {
    const url = new URL(origin);
    const host = url.host.toLowerCase();
    if (url.protocol !== "https:" && !host.startsWith("localhost")) return null;
    return domainAllowed(host, allowedDomains()) ? host : null;
  } catch {
    return null;
  }
}

function json(req: Request, status: number, body: unknown): Response {
  const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store", Vary: "Origin" });
  const origin = req.headers.get("Origin");
  if (origin && originDomain(req)) headers.set("Access-Control-Allow-Origin", origin);
  return new Response(JSON.stringify(body), { status, headers });
}

async function fail(ctx: ActionCtx, req: Request, status: number, reason: string): Promise<Response> {
  await ctx.runMutation(internal.auth.recordFailure, { reason });
  return json(req, status, { error: reason });
}

function bearer(req: Request): string | null {
  const h = req.headers.get("Authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

const preflight = httpAction(async (_ctx, req) => {
  const origin = req.headers.get("Origin");
  if (!origin || !originDomain(req)) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    },
  });
});

http.route({
  path: "/auth/challenge",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const domain = originDomain(req);
    if (!domain) return fail(ctx, req, 403, "domain-not-allowed");
    const { wallet } = (await req.json().catch(() => ({}))) as { wallet?: string };
    if (typeof wallet !== "string" || !isWalletAddress(wallet)) return fail(ctx, req, 400, "bad-wallet");
    const network = process.env.AUTH_NETWORK ?? "devnet";
    const challenge = await ctx.runMutation(internal.auth.createChallenge, { wallet, domain, network, nonce: newNonce() });
    if (!challenge) return fail(ctx, req, 429, "too-many-challenges");
    return json(req, 200, { nonce: challenge.nonce, message: challengeMessage(challenge), expiresAt: challenge.expiresAt });
  }),
});

http.route({
  path: "/auth/verify",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const domain = originDomain(req);
    if (!domain) return fail(ctx, req, 403, "domain-not-allowed");
    const body = (await req.json().catch(() => ({}))) as { wallet?: string; nonce?: string; signature?: string };
    if (typeof body.wallet !== "string" || typeof body.nonce !== "string" || typeof body.signature !== "string") {
      return fail(ctx, req, 400, "bad-request");
    }
    const challenge = await ctx.runQuery(internal.auth.getChallenge, { nonce: body.nonce });
    if (!challenge) return fail(ctx, req, 401, "unknown-challenge");
    const problem = verifyChallenge(challenge, { wallet: body.wallet, domain, signature: body.signature }, Date.now());
    if (problem) return fail(ctx, req, 401, problem);
    const sid = await ctx.runMutation(internal.auth.consumeChallenge, { nonce: body.nonce, wallet: body.wallet, domain });
    if (!sid) return fail(ctx, req, 401, "used");
    return json(req, 200, { token: await issueJwt(body.wallet, sid), wallet: body.wallet });
  }),
});

http.route({
  path: "/auth/refresh",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    if (!originDomain(req)) return fail(ctx, req, 403, "domain-not-allowed");
    const token = bearer(req);
    const claims = token ? await readOwnJwt(token) : null;
    if (!claims) return fail(ctx, req, 401, "bad-token");
    const live = await ctx.runQuery(internal.auth.activeSession, claims);
    if (!live) return fail(ctx, req, 401, "session-ended");
    return json(req, 200, { token: await issueJwt(claims.wallet, claims.sid), wallet: claims.wallet });
  }),
});

http.route({
  path: "/auth/signout",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const token = bearer(req);
    const claims = token ? await readOwnJwt(token) : null;
    if (claims) await ctx.runMutation(internal.auth.revokeSession, claims);
    return json(req, 200, { ok: true });
  }),
});

for (const path of ["/auth/challenge", "/auth/verify", "/auth/refresh", "/auth/signout"]) {
  http.route({ path, method: "OPTIONS", handler: preflight });
}

http.route({
  path: "/.well-known/jwks.json",
  method: "GET",
  handler: httpAction(async () =>
    new Response(JSON.stringify(publicJwks()), {
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
    }),
  ),
});

export default http;
