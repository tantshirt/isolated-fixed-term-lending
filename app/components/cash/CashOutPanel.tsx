"use client";

import { CashPanel } from "./CashPanel";

/** MoneyGram sandbox cash-out (Story 24.4). The shared panel lives in `CashPanel`. */
export function CashOutPanel({ usdcBalance }: { usdcBalance: bigint | null }) {
  return <CashPanel direction="out" usdcBalance={usdcBalance} />;
}
