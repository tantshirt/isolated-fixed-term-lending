// One set of names for the V2 repayment stages, used by every screen (full council ruling, 2026-10-07).
import type { Phase } from "./loan-math-v2";

export const PHASE_WORDS: Record<Phase, string> = {
  Active: "Waiting for repayment",
  Grace: "In grace",
  Overdue: "Grace has ended",
  PricedRecovery: "Priced recovery is open",
  Terminal: "Final claim is open",
};

/** Terminal status of a loan moved into a new one (Story 26.1). Never shown as "Repaid". */
export const REFINANCED_WORD = "Refinanced";
