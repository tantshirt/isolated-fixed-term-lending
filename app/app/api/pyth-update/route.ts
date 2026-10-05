import { SOL_USD_FEED_ID_HEX } from "@/lib/constants";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Read-only relay; only public signed update bytes leave the server. */
export async function GET() {
  try {
    const endpoint =
      process.env.PYTH_HERMES_URL || "https://hermes.pyth.network";
    const url = new URL("/v2/updates/price/latest", endpoint);
    url.searchParams.append("ids[]", SOL_USD_FEED_ID_HEX);
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
    return Response.json(
      { data: body.binary.data },
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
