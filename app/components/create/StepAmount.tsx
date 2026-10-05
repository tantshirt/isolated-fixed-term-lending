"use client";

import { AmountInput } from "@/components/ui/AmountInput";
import { formatUsdc } from "@/lib/format";
import type { DraftErrors } from "@/lib/offer-validation";
import type { Perspective, WizardDraft } from "./useDraft";
import styles from "./CreateWizard.module.css";

const QUICK = ["100", "500", "1000", "5000"];

function atomsToInput(a: bigint) {
  const whole = a / 1_000_000n;
  const frac = (a % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function StepAmount({
  draft,
  update,
  errors,
  balance,
  onEnter,
  perspective = "lender",
}: {
  draft: WizardDraft;
  update: (p: Partial<WizardDraft>) => void;
  errors: DraftErrors;
  balance: bigint | null;
  onEnter: () => void;
  perspective?: Perspective;
}) {
  const borrower = perspective === "borrower";
  return (
    <div className={styles.fields}>
      <AmountInput
        label={borrower ? "You borrow" : "You lend"}
        size="xl"
        unit="USDC"
        decimals={6}
        value={draft.principal}
        onChange={(v) => update({ principal: v })}
        error={errors.principal}
        autoFocus
        onEnter={onEnter}
        hint={
          borrower ? (
            "Paid to this wallet the moment a lender funds your request."
          ) : balance !== null ? (
            <>
              Your balance <span className="num">{formatUsdc(balance)}</span>{" "}
              USDC
            </>
          ) : (
            "Connect a wallet to see your balance."
          )
        }
      />
      <div className={styles.quick} role="group" aria-label="Quick amounts">
        {QUICK.map((q) => (
          <button
            key={q}
            type="button"
            className={styles.quickChip}
            aria-pressed={draft.principal === q}
            onClick={() => update({ principal: q })}
          >
            <span className="num">{Number(q).toLocaleString("en-US")}</span>
          </button>
        ))}
        {!borrower && balance !== null && balance > 0n && (
          <>
            <button
              type="button"
              className={styles.quickChip}
              onClick={() => update({ principal: atomsToInput(balance / 2n) })}
            >
              Half
            </button>
            <button
              type="button"
              className={styles.quickChip}
              onClick={() => update({ principal: atomsToInput(balance) })}
            >
              Max
            </button>
          </>
        )}
      </div>
      <p className={styles.explain}>
        {borrower
          ? "When you approve the final transaction, your wSOL moves into the request's own vault. You can cancel and take it back at any time until a lender funds it."
          : "When you approve the final transaction, your USDC moves into the offer's own vault. You can cancel and take it back at any time until a borrower accepts."}
      </p>
    </div>
  );
}
