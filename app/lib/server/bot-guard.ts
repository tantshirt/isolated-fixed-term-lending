import { checkBotId } from "botid/server";

/**
 * Returns a response that refuses the request, or null to continue. Fails closed:
 * if BotID cannot run (for example off Vercel, without an OIDC token), the route
 * spends nothing.
 */
export async function refuseBots(): Promise<Response | null> {
  try {
    if ((await checkBotId()).isBot) return Response.json({ error: "Access denied." }, { status: 403 });
    return null;
  } catch (e) {
    console.error("botid", e instanceof Error ? e.message : e);
    return Response.json({ error: "Bot protection is unavailable. Try again later." }, { status: 503 });
  }
}
