/**
 * Program caps (crates/loan-core/src/constants.rs), with no dependencies so wallet-free pages can
 * import the loan math without pulling in Solana libraries. `constants.ts` re-exports these.
 */
export const CAPS = {
  maxInterestBps: 2_000,
  maxLtvBps: 7_000,
  maxLiquidationLtvBps: 8_500,
  minLtvGapBps: 500,
  minDurationSeconds: 60,
  maxDurationSeconds: 7_776_000,
} as const;
