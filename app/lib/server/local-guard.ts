import { NETWORK, RPC_URL } from "../constants";

export function localControlsEnabled(
  env = process.env,
  rpc = RPC_URL,
  network = NETWORK
): boolean {
  const host = new URL(rpc).hostname;
  return (
    network === "localnet" &&
    env.NODE_ENV !== "production" &&
    env.ENABLE_LOCAL_CONTROLS === "true" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(host)
  );
}

export function rejectLocalRequest(request: Request): Response | null {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  if (
    !localControlsEnabled() ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    (origin !== null && origin !== url.origin)
  ) {
    return Response.json(
      { error: "Local controls are unavailable in this environment" },
      { status: 403 }
    );
  }
  return null;
}

export function assertLocalControls(): void {
  if (!localControlsEnabled())
    throw new Error("Local controls are unavailable in this environment");
}
