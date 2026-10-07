"use client";

import { Chips } from "@/components/ui/Chips";
import { Slider } from "@/components/ui/Slider";
import { formatBpsAsPercent, formatDuration, formatUsdc } from "@/lib/format";
import { chargeCeiling, fullTermInterest, minInterest } from "@/lib/loan-math-v2";
import { GRACE_CHOICES, rulesProblem, suggestCeilingBps, termsFrom, type RepaymentRules } from "@/lib/v2/rules";
import type { Perspective, WizardDraft } from "./useDraft";
import styles from "./CreateWizard.module.css";

/**
 * The repayment rules of a V2 loan (Story 21.1): early repayment, grace, late fee and the annual
 * pricing ceiling. The ceiling is a product limit the lender sets, not a legal guarantee.
 */
export function RulesFields({
  draft,
  update,
  principal,
  perspective = "lender",
}: {
  draft: WizardDraft;
  update: (p: Partial<WizardDraft>) => void;
  principal: bigint | null;
  perspective?: Perspective;
}) {
  const rules = draft.rules;
  const set = (patch: Partial<RepaymentRules>) => update({ rules: { ...rules, ...patch } });
  const base = { principal: principal ?? 0n, interestBps: draft.interestBps, durationSeconds: draft.durationSeconds };
  const suggested = principal ? suggestCeilingBps(principal, draft.interestBps, draft.durationSeconds, rules) : null;
  const terms = principal ? termsFrom(base, rules) : null;
  const problem = rulesProblem({ ...base, principal }, rules);
  const borrower = perspective === "borrower";

  return (
    <fieldset className={styles.rules}>
      <legend className={styles.rulesTitle}>Repayment rules</legend>

      <Chips
        label="If the loan is repaid early"
        options={[
          { value: "pro-rata", label: "Interest for time used" },
          { value: "full-term", label: "Full-term interest" },
        ]}
        value={rules.earlyRepayment}
        onChange={(v) => set({ earlyRepayment: v })}
      />
      <p className={styles.hint}>
        {rules.earlyRepayment === "pro-rata" ? (
          <>
            Interest builds up each second until the deadline, with a minimum of 25% of the full-term interest
            {terms ? (
              <>
                {" "}(<span className="num">{formatUsdc(minInterest(terms))}</span> USDC)
              </>
            ) : null}
            . {borrower ? "Repaying early costs you less." : "The borrower pays less if they repay early."}
          </>
        ) : (
          <>The full-term interest is owed whenever the loan is repaid, as on today&apos;s offers.</>
        )}
      </p>

      <Chips
        label="Grace after the deadline"
        options={GRACE_CHOICES.map((g) => ({ value: g, label: formatDuration(g) }))}
        value={rules.graceSeconds}
        onChange={(v) => set({ graceSeconds: v })}
      />

      <Slider
        label="Late fee on unpaid principal, charged once at the deadline"
        value={rules.lateFeeBps}
        min={0}
        max={500}
        step={25}
        onChange={(v) => set({ lateFeeBps: v })}
        format={(v) => `${(v / 100).toFixed(2)}%`}
        markers={[
          { value: 100, label: "1%" },
          { value: 500, label: "5%" },
        ]}
      />

      <div className={styles.ceiling}>
        <label className={styles.ceilingLabel} htmlFor="annual-ceiling">
          Annual pricing ceiling
        </label>
        <div className={styles.ceilingRow}>
          <input
            id="annual-ceiling"
            className={`${styles.customInput} num`}
            inputMode="decimal"
            aria-describedby="annual-ceiling-hint"
            value={rules.annualCeilingBps === null ? (suggested !== null ? suggested / 100 : "") : rules.annualCeilingBps / 100}
            onChange={(e) => {
              const n = Number(e.target.value.replace(/[^\d.]/g, ""));
              set({ annualCeilingBps: Number.isFinite(n) && e.target.value.trim() !== "" ? Math.round(n * 100) : null });
            }}
          />
          <span>% a year</span>
          {rules.annualCeilingBps !== null && suggested !== null && (
            <button type="button" className={styles.edit} onClick={() => set({ annualCeilingBps: null })}>
              Use suggested {formatBpsAsPercent(suggested, 0)}
            </button>
          )}
        </div>
        <p id="annual-ceiling-hint" className={styles.hint}>
          All charges together, over the term and grace, can never exceed this annual rate
          {terms ? (
            <>
              : at most <span className="num">{formatUsdc(chargeCeiling(terms))}</span> USDC on top of{" "}
              <span className="num">{formatUsdc(terms.principal)}</span> USDC, of which the interest is{" "}
              <span className="num">{formatUsdc(fullTermInterest(terms))}</span> USDC
            </>
          ) : null}
          . It is a limit you set in ZenLo, labelled a Devnet test setting, not a legal rate cap.
        </p>
      </div>

      {problem && (
        <p className={styles.fieldError} role="alert">
          {problem}
        </p>
      )}
    </fieldset>
  );
}
