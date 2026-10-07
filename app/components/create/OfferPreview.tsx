"use client";

import { AnimatePresence, m } from "motion/react";
import { AssetLabel, type AssetSymbol } from "@/components/brand/AssetLabel";
import { LogoMark } from "@/components/brand/LogoMark";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import type { LivePrice } from "@/lib/client/hooks";
import {
  atomsToNumber,
  fmt,
  formatUsdc,
  formatWsol,
  formatBpsAsPercent,
  formatDuration,
} from "@/lib/format";
import { parseAmount } from "@/lib/offer-validation";
import { plannedLtvBps } from "@/lib/risk";
import { V2_LIVE } from "@/lib/v2/program";
import type { Perspective, WizardDraft } from "./useDraft";
import { WSOL_ASSET } from "@/lib/models/collateral";
import type { CollateralAsset } from "@/lib/models";
import styles from "./OfferPreview.module.css";

/** The offer exactly as a borrower will read it, updating while the lender types. */
export function OfferPreview({
  draft,
  owed,
  price,
  live,
  perspective = "lender",
  asset = WSOL_ASSET,
}: {
  draft: WizardDraft;
  owed: bigint | null;
  price: LivePrice | null;
  live: boolean;
  perspective?: Perspective;
  /** The chosen collateral (Story 26.2); `price` is its own feed. */
  asset?: CollateralAsset;
}) {
  // A lender previews what a borrower reads, and a borrower what a lender reads.
  const lenderReads = perspective === "borrower";
  const principal = parseAmount(draft.principal, 6);
  const lamports = parseAmount(draft.collateral, asset.decimals);
  const ltv =
    price && owed && lamports ? plannedLtvBps(owed, lamports, price) : null;

  return (
    <div className={styles.panel}>
      <AnimatePresence>
        {live && (
          <m.span
            className={styles.ripple}
            initial={{ opacity: 0.6, scale: 0.2 }}
            animate={{ opacity: 0, scale: 2.4 }}
            transition={{ duration: 1.2, ease: [0.22, 1, 0.36, 1] }}
            aria-hidden
          />
        )}
      </AnimatePresence>
      <div className={styles.head}>
        <span className={styles.badge}>
          {live ? "Live on ZenLo" : lenderReads ? "Lender's view" : "Borrower's view"}
        </span>
        <LogoMark size={28} tone="panel" progress={live ? 1 : 0.25} />
      </div>

      <div className={styles.figures}>
        <Figure
          label={lenderReads ? "You lend" : "You receive"}
          value={principal ? atomsToNumber(principal, 6) : 0}
          unit="USDC"
          exact={principal === null ? "—" : formatUsdc(principal)}
          format={fmt.usd}
          hero
        />
        <Figure
          label={lenderReads ? "You are repaid" : "You repay"}
          value={owed ? atomsToNumber(owed, 6) : 0}
          unit="USDC"
          exact={owed === null ? "—" : formatUsdc(owed)}
          format={fmt.usd}
        />
        <Figure
          label={lenderReads ? "Collateral locked" : "You lock"}
          value={lamports ? atomsToNumber(lamports, asset.decimals) : 0}
          unit={asset.symbol}
          exact={lamports === null ? "—" : formatWsol(lamports)}
          format={fmt.wsol}
        />
      </div>

      <p className={styles.deadline}>
        {V2_LIVE ? (
          <>
            Due within <b>{formatDuration(draft.durationSeconds)}</b>, then <b>{formatDuration(draft.rules.graceSeconds)}</b> of grace.{" "}
            {draft.rules.earlyRepayment === "pro-rata" ? "Early repayment pays interest for the time used." : "Early repayment pays the full-term interest."}{" "}
            Unpaid a week after grace, the lender may take all the {asset.label}.
          </>
        ) : lenderReads ? (
          <>
            Repaid within <b>{formatDuration(draft.durationSeconds)}</b> of
            funding. If the borrower misses it, you receive their wSOL.
          </>
        ) : (
          <>
            Repay within <b>{formatDuration(draft.durationSeconds)}</b> of
            accepting. If you do not repay by then, the lender receives your
            wSOL.
          </>
        )}
      </p>

      <dl className={styles.meta}>
        <div>
          <dt>Interest</dt>
          <dd className="num">{formatBpsAsPercent(draft.interestBps, 2)}</dd>
        </div>
        <div>
          <dt>LTV today</dt>
          <dd className="num">
            {ltv !== null ? formatBpsAsPercent(Math.min(ltv, 99_99)) : "—"}
          </dd>
        </div>
        <div>
          <dt>Max / liquidation</dt>
          <dd className="num">
            {formatBpsAsPercent(draft.maxLtvBps, 0)} /{" "}
            {formatBpsAsPercent(draft.liquidationLtvBps, 0)}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function Figure({
  label,
  value,
  unit,
  format,
  hero,
  exact,
}: {
  label: string;
  value: number;
  unit: AssetSymbol;
  format: (n: number) => string;
  hero?: boolean;
  exact?: string;
}) {
  return (
    <div className={`${styles.figure} ${hero ? styles.hero : ""}`}>
      <span className={styles.figureLabel}>{label}</span>
      <span className={styles.figureValue}>
        <AnimatedNumber
          value={value}
          format={format}
          exact={exact}
          className="num"
        />
        <span className={styles.unit}>
          <AssetLabel symbol={unit} />
        </span>
      </span>
    </div>
  );
}
