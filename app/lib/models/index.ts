/**
 * Versioned client models (Story 19.4). Every model names its schema version so a codec can refuse
 * data it does not understand. Legacy program accounts map to `version: 1`; V2 programs add their
 * own versions when they ship. Amounts are integer atoms (bigint), never floats.
 */
import type { Network, Operation, Provider } from "../capabilities";

export type ProgramGeneration = "legacy" | "v2";

export type CollateralAsset = {
  version: 1;
  symbol: "wSOL" | "jitoSOL";
  /** What the interface shows, e.g. "jitoSOL (test)" on Devnet. */
  label: string;
  /** Empty when the asset has no mint on this deployment. */
  mint: string;
  decimals: number;
  /** Pyth feed id (hex) used to price this asset in USD. */
  feedIdHex: string;
  maxLtvBps: number;
  liquidationLtvBps: number;
  /** False until custody, pricing and settlement are proven for the asset. */
  enabled: boolean;
};

export type EarlyRepayment = "full-term" | "pro-rata";

export type LoanTerms = {
  version: 1 | 2;
  generation: ProgramGeneration;
  principal: bigint;
  /** Interest for the whole term, in basis points of principal. */
  termInterestBps: number;
  durationSeconds: number;
  collateralMint: string;
  collateralAmount: bigint;
  maxLtvBps: number;
  liquidationLtvBps: number;
  /** V2 only. Legacy loans are full-term with no grace or late fee. */
  earlyRepayment: EarlyRepayment;
  graceSeconds: number;
  lateFeeBps: number;
  annualCeilingBps: number | null;
};

export type LoanAccounting = {
  version: 1 | 2;
  originalPrincipal: bigint;
  outstandingPrincipal: bigint;
  interestAccrued: bigint;
  interestPaid: bigint;
  lateFeeAssessed: bigint;
  lateFeePaid: bigint;
  lastAccrualTs: number;
};

export type SettlementReason = "repaid" | "repaid-late" | "liquidated" | "overdue-liquidated" | "priced-recovery" | "terminal-claim" | "cancelled" | "refinanced";

export type DeskRole = "administrator" | "lender" | "auditor" | "borrower";

export type Desk = {
  version: 1;
  deskId: string;
  name: string;
  policyVersion: number;
  /** Roles of the viewing wallet only; the full roster stays private. */
  myRoles: DeskRole[];
};

export type AuditorGrant = {
  version: 1;
  loan: string;
  auditor: string;
  scope: "terms-status-receipts";
  consentedBy: string[];
  revokedAt: number | null;
};

export type AutomationMandate = {
  version: 1;
  loan: string;
  action: "top-up" | "repay";
  source: string;
  destination: string;
  trigger: { kind: "health-below-bps"; value: number } | { kind: "seconds-before-maturity"; value: number };
  expiresAt: number;
  cumulativeCap: bigint;
  feeCap: bigint;
  spent: bigint;
  paused: boolean;
};

export type ProviderCapability = {
  version: 1;
  provider: Provider;
  network: Network;
  mint: string;
  operation: Operation;
  available: boolean;
  reason?: string;
};
