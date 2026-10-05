// Turns 32 bytes of VRF randomness into one loan scenario, using the same
// integer math as the program. Shared by the lab page and the achievement check.
import { collateralValueUsdc, currentLtvBps, debt } from "./loan-math";

export type LabOutcome = "repaid" | "liquidated" | "expired";

export type LabScenario = {
  principal: bigint; // USDC atoms
  interestBps: number;
  collateral: bigint; // lamports
  startPrice: bigint; // exponent -8
  dropPercent: number;
  dropDay: number;
  repayDay: number | null;
  durationDays: number;
  liquidationLtvBps: number;
  ltvAfterDropBps: number;
  outcome: LabOutcome;
};

const EXPONENT = -8;

export function scenarioFrom(randomness: Uint8Array): LabScenario {
  const principal = 100_000_000n;
  const interestBps = 500;
  const collateral = 1_100_000_000n;
  const startPrice = 15_000_000_000n;
  const durationDays = 7;
  const liquidationLtvBps = 8_000;
  const dropPercent = 5 + (randomness[0] % 36); // 5% to 40%
  const dropDay = 1 + (randomness[1] % 6); // day 1 to 6
  const repayDay = randomness[2] < 160 ? 1 + (randomness[3] % 7) : null; // repays on day 1 to 7, or never
  const dropped = (startPrice * BigInt(100 - dropPercent)) / 100n;
  const ltvAfterDropBps = currentLtvBps(debt(principal, interestBps), collateralValueUsdc(collateral, dropped, 0n, EXPONENT));

  // Liquidation can happen from the day of the drop if the borrower has not repaid by then.
  let outcome: LabOutcome;
  if (ltvAfterDropBps >= liquidationLtvBps && (repayDay === null || repayDay > dropDay)) outcome = "liquidated";
  else if (repayDay !== null && repayDay < durationDays) outcome = "repaid";
  else outcome = "expired";

  return { principal, interestBps, collateral, startPrice, dropPercent, dropDay, repayDay, durationDays, liquidationLtvBps, ltvAfterDropBps, outcome };
}

export const OUTCOME_EXPLAINED: Record<LabOutcome, string> = {
  repaid: "The borrower repaid before the deadline, so the wSOL came back. Interest was still the full 5%.",
  liquidated: "SOL fell far enough that the loan crossed 80% LTV before repayment. A liquidator paid the debt and took collateral plus a 5% incentive; any remainder went back to the borrower.",
  expired: "Nobody repaid by the deadline. At the first expired second, the lender received all of the wSOL.",
};
