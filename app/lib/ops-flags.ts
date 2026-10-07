import type { Provider } from "./capabilities";

/**
 * Operational pauses. A pause can stop new originations or a provider. It can never block an
 * action that services or recovers an existing loan.
 */
export type FlagKey = "originations" | `provider:${Provider}`;
export type OpsFlag = { key: FlagKey; paused: boolean; reason?: string };

export type LoanAction =
  | "create-offer"
  | "create-request"
  | "accept"
  | "fund"
  | "propose"
  | "repay"
  | "add-collateral"
  | "liquidate"
  | "liquidate-overdue"
  | "claim"
  | "claim-priced"
  | "claim-terminal"
  | "cancel"
  | "close"
  | "withdraw";

/** Actions that start new exposure. Everything else services or recovers an existing position. */
export const ORIGINATING: ReadonlySet<LoanAction> = new Set(["create-offer", "create-request", "accept", "fund", "propose"]);

export type Allowed = { allowed: true } | { allowed: false; reason: string };

export function loanActionAllowed(action: LoanAction, flags: OpsFlag[]): Allowed {
  if (!ORIGINATING.has(action)) return { allowed: true };
  const pause = flags.find((f) => f.key === "originations" && f.paused);
  return pause ? { allowed: false, reason: pause.reason || "New loans are paused for maintenance. Existing loans are unaffected." } : { allowed: true };
}

export function providerAllowed(provider: Provider, flags: OpsFlag[]): Allowed {
  const pause = flags.find((f) => f.key === `provider:${provider}` && f.paused);
  return pause ? { allowed: false, reason: pause.reason || "This service is paused. Your loans are unaffected." } : { allowed: true };
}
