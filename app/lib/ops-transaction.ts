import { ConvexHttpClient } from "convex/browser";
import type { Transaction } from "@solana/web3.js";
import { api } from "../convex/_generated/api";
import { PROGRAM_ID } from "./constants";
import { PRIVATE_PROGRAM_ID } from "./private/room-codec";
import { loanActionAllowed, providerAllowed, type LoanAction, type OpsFlag } from "./ops-flags";

const programs = new Map([
  [PROGRAM_ID.toBase58(), "zenlo-public" as const],
  ["8hxagcQkw1Km6PWZgpA92qUnqvnFufC7tx2jvxf9Ko8m", "zenlo-public" as const],
  [PRIVATE_PROGRAM_ID.toBase58(), "zenlo-private" as const],
  ["JAzy8NP6V8AGrAko8vfgrD44BDghN6eLwqB7vjuYhHNq", "zenlo-private" as const],
]);
const names: Record<string, LoanAction> = {
  create_offer: "create-offer", create_request: "create-request",
  accept_offer: "accept", fund_request: "fund", propose_terms: "propose",
  fund_loan: "fund", accept_loan: "accept",
};
let discriminators: Promise<Map<string, LoanAction>> | undefined;
function actions() {
  return discriminators ??= Promise.all(Object.entries(names).map(async ([name, action]) => {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`global:${name}`));
    return [Buffer.from(bytes).subarray(0, 8).toString("hex"), action] as const;
  })).then((entries) => new Map(entries));
}

async function readFlags(): Promise<OpsFlag[]> {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) return [];
  return new ConvexHttpClient(url).query(api.ops.flags, {});
}

/** Check live operational pauses immediately before signing new exposure. Recovery never
 * depends on the backend: transactions containing only servicing instructions do not read it. */
export async function assertOriginationAllowed(tx: Transaction, read: () => Promise<OpsFlag[]> = readFlags): Promise<void> {
  const known = await actions();
  const originations = tx.instructions.flatMap((ix) => {
    const provider = programs.get(ix.programId.toBase58());
    const action = known.get(ix.data.subarray(0, 8).toString("hex"));
    return provider && action ? [{ provider, action }] : [];
  });
  if (!originations.length) return;
  const flags = await read();
  for (const { action, provider } of originations) {
    for (const allowed of [loanActionAllowed(action, flags), providerAllowed(provider, flags)]) {
      if (!allowed.allowed) throw new Error(allowed.reason);
    }
  }
}
