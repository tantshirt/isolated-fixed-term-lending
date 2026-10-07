import { SOL_USD_FEED_ID_HEX } from "@/lib/constants";
import { JITOSOL_USD_FEED_ID_HEX } from "@/lib/models/collateral";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Feeds the relay serves. Anything else is refused, so it cannot be used as an open proxy. */
const FEEDS: Record<string, string> = { sol: SOL_USD_FEED_ID_HEX, jitosol: JITOSOL_USD_FEED_ID_HEX };
/**
 * Read-only relay; only public signed update bytes leave the server. `?feed=jitosol` serves
 * JITOSOL/USD (Story 26.2) with its parsed price for display; the default stays SOL/USD.
 */
export async function GET(request: Request) {
  const feedKey = new URL(request.url).searchParams.get("feed") ?? "sol";
  const feedId = FEEDS[feedKey];
  if (!feedId) return Response.json({ error: "Unknown feed" }, { status: 400 });
  try {
    const endpoint =
      process.env.PYTH_HERMES_URL || "https://hermes.pyth.network";
    const url = new URL("/v2/updates/price/latest", endpoint);
    url.searchParams.append("ids[]", feedId);
    url.searchParams.set("encoding", "base64");
    const headers: Record<string, string> = {};
    if (process.env.PYTH_HERMES_API_KEY)
      headers.Authorization = `Bearer ${process.env.PYTH_HERMES_API_KEY}`;
    const response = await fetch(url, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      return Response.json(
        {
          error: `Pyth update service returned ${response.status}. Check server Hermes access configuration.`,
        },
        { status: 503 }
      );
    const body = await response.json();
    if (
      body.binary?.encoding !== "base64" ||
      !Array.isArray(body.binary?.data) ||
      !body.binary.data.length ||
      body.binary.data.some(
        (item: unknown) =>
          typeof item !== "string" ||
          item.length > 100_000 ||
          !/^[A-Za-z0-9+/]+=*$/.test(item)
      )
    )
      throw new Error("Invalid Pyth update response");
    const parsed = Array.isArray(body.parsed) ? body.parsed[0] : null;
    const price =
      parsed && parsed.id === feedId && parsed.price && parsed.ema_price
        ? {
            price: String(parsed.price.price),
            conf: String(parsed.price.conf),
            exponent: Number(parsed.price.expo),
            publishTime: Number(parsed.price.publish_time),
            emaPrice: String(parsed.ema_price.price),
            emaConf: String(parsed.ema_price.conf),
          }
        : null;
    return Response.json(
      { data: body.binary.data, price },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return Response.json(
      {
        error:
          "Pyth update service unavailable. Try again after checking server Hermes access.",
      },
      { status: 503 }
    );
  }
}
