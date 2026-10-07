/**
 * What the public pages may say about each shipped feature (Story 19.7). A badge is derived, never
 * typed: a program feature is "live" only with a Devnet evidence pointer; a provider feature
 * (Telegram, MoneyGram) follows its deployment flag through `capabilityFor`.
 */
import { capabilityFor, DEVNET_USDC } from "./capabilities";

export type FeatureStatus = "live" | "pilot" | "sandbox";

export type FeatureId =
  | "v2-loans"
  | "private-rooms"
  | "desks"
  | "desk-workspace"
  | "auditor-consent"
  | "private-portfolio"
  | "governance"
  | "alerts"
  | "cash-out";

type Entry = {
  /** `docs/<file>.json#dotted.path` whose value proves the claim on Devnet. */
  evidence?: string;
  status: () => FeatureStatus;
};

const live = () => "live" as const;

export const FEATURE_EVIDENCE: Record<FeatureId, Entry> = {
  "v2-loans": { evidence: "docs/v2-fixtures.json#fixtures.4.steps.2.signature", status: live },
  "private-rooms": { evidence: "docs/magicblock-evidence.json#v2Client.checks.client-opens-room-and-invites.ok", status: live },
  desks: { evidence: "docs/magicblock-evidence.json#v2Client.checks.client-opens-desk-and-publishes-policy.ok", status: live },
  // Member screens wait on the desk-workspace story (sprint plan row 11).
  "desk-workspace": { status: () => "pilot" },
  "auditor-consent": { evidence: "docs/magicblock-evidence.json#v2Client.checks.auditor-reads-after-consent.ok", status: live },
  "private-portfolio": { evidence: "docs/magicblock-evidence.json#v2Client.checks.full-payoff-repays-and-returns-collateral.ok", status: live },
  governance: { evidence: "docs/governance-evidence.json#multisig", status: live },
  alerts: {
    status: () => (capabilityFor("telegram", "devnet", "*", "notify").available ? "live" : "pilot"),
  },
  "cash-out": {
    // MoneyGram is only ever wired to its sandbox on Devnet.
    status: () =>
      capabilityFor("moneygram", "devnet", DEVNET_USDC, "cash-out").available &&
      process.env.NEXT_PUBLIC_MONEYGRAM_ENV === "sandbox"
        ? "sandbox"
        : "pilot",
  },
};

export function featureStatus(id: FeatureId): FeatureStatus {
  return FEATURE_EVIDENCE[id].status();
}

export const STATUS_LABEL: Record<FeatureStatus, string> = {
  live: "Live on Devnet",
  pilot: "Pilot · gated",
  sandbox: "Sandbox",
};
