"use client";

import type { Connection, PublicKey } from "@solana/web3.js";
import { useCallback, useEffect, useRef, useState } from "react";
import wiz from "@/components/create/CreateWizard.module.css";
import { HealthMeter } from "@/components/offer/HealthMeter";
import { AmountInput } from "@/components/ui/AmountInput";
import { Button } from "@/components/ui/Button";
import { usePrice } from "@/lib/client/hooks";
import { formatBpsAsPercent, formatDuration, formatUsdc, formatWsol } from "@/lib/format";
import type { LoanSigner } from "@/lib/keypair-wallet";
import { collateralValueUsdc, currentLtvBps, debt, healthBps } from "@/lib/loan-math";
import { LOAN_MESSAGE_PREFIX, explainLoanError, proposeLoan } from "@/lib/private/loans";
import type { RoomMember } from "@/lib/private/room-codec";
import { postMessage } from "@/lib/private/rooms";
import { priceUsd, solPriceAtLtv } from "@/lib/risk";
import styles from "./private.module.css";

const MAX_LTV_BPS = 7000;
const LIQUIDATION_LTV_BPS = 8000;
const MAX_INTEREST_BPS = 2000;

const DURATIONS = [
  { label: "1 day", seconds: 86_400 },
  { label: "7 days", seconds: 604_800 },
  { label: "30 days", seconds: 2_592_000 },
  { label: "2 minutes (try expiry)", seconds: 120 },
];

const STEPS = [
  { title: "Borrower & amount", question: "Who are you lending to, and how much?" },
  { title: "Rate & term", question: "What does the loan cost, and for how long?" },
  { title: "Collateral", question: "How much wSOL does the borrower lock?" },
  { title: "Review", question: "Check the terms before you propose them." },
] as const;

const short = (k: PublicKey) => `${k.toBase58().slice(0, 4)}…${k.toBase58().slice(-4)}`;

export type Prefill = { principalUsdc: number; interestPercent: number; durationDays: number; collateralWsol: number };

type Props = {
  signer: LoanSigner;
  base: Connection;
  er: Connection;
  room: PublicKey;
  counterparties: RoomMember[];
  prefill?: Prefill | null;
  onDone: () => void;
  onCancel: () => void;
};

/** A lender's proposal as four short steps, explaining each term as it is set. */
export function ProposeWizard({ signer, base, er, room, counterparties, prefill, onDone, onCancel }: Props) {
  const { price } = usePrice();
  const [step, setStep] = useState(1);
  const [borrower, setBorrower] = useState(counterparties[0]?.pubkey.toBase58() ?? "");
  const [principal, setPrincipal] = useState(prefill ? String(prefill.principalUsdc) : "0.10");
  const [rate, setRate] = useState(prefill ? String(prefill.interestPercent) : "5");
  const [duration, setDuration] = useState(prefill ? Math.max(60, Math.round(prefill.durationDays * 86_400)) : DURATIONS[1].seconds);
  const [collateral, setCollateral] = useState(prefill ? String(prefill.collateralWsol) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  const p = BigInt(Math.round(Number(principal || "0") * 1e6));
  const bps = Math.round(Number(rate || "0") * 100);
  const owed = p > 0n ? debt(p, bps) : 0n;
  const c = BigInt(Math.round(Number(collateral || "0") * 1e9));
  const ltv = price && c > 0n && owed > 0n ? currentLtvBps(owed, collateralValueUsdc(c, price.price, price.conf, price.exponent)) : null;

  const suggest = useCallback(() => {
    if (!price || owed === 0n) return;
    const target = (owed * 10_000n) / 5_000n; // about 50% LTV
    let lamports = (target * 10n ** BigInt(3 - price.exponent)) / (price.price - price.conf) + 1n;
    while (collateralValueUsdc(lamports, price.price, price.conf, price.exponent) < target) lamports += 1n;
    setCollateral((Number(lamports) / 1e9).toFixed(9).replace(/0+$/, ""));
  }, [price, owed]);
  useEffect(() => {
    if (!collateral) suggest();
  }, [collateral, suggest]);

  // Why each step cannot continue yet, or null when it can.
  const problem = (n: number): string | null => {
    if (n === 1) return !borrower ? "Choose a borrower." : p <= 0n ? "Enter an amount to lend." : null;
    if (n === 2) return bps < 0 || bps > MAX_INTEREST_BPS ? "Interest must be between 0% and 20%." : null;
    if (n === 3) {
      if (c <= 0n) return "Enter the wSOL the borrower locks.";
      if (ltv === null) return "Waiting for the SOL price.";
      if (ltv > MAX_LTV_BPS) return `LTV is ${formatBpsAsPercent(ltv)}; it must be ${formatBpsAsPercent(MAX_LTV_BPS, 0)} or less. Ask for more wSOL.`;
    }
    return null;
  };
  const firstProblem = [1, 2, 3].find((n) => problem(n) !== null) ?? null;
  const reachable = (n: number) => firstProblem === null || n <= firstProblem;

  const go = (n: number) => {
    setStep(n);
    setError(null);
  };
  const moved = useRef(false);
  useEffect(() => {
    if (moved.current) heading.current?.focus({ preventScroll: true });
    moved.current = true;
  }, [step]);

  async function submit() {
    if (firstProblem !== null) return go(firstProblem);
    setBusy(true);
    setError(null);
    try {
      const { PublicKey } = await import("@solana/web3.js");
      const { loanId } = await proposeLoan(base, er, signer, room, {
        borrower: new PublicKey(borrower),
        principal: p,
        interestBps: bps,
        durationSeconds: duration,
        collateralAmount: c,
        maxLtvBps: MAX_LTV_BPS,
        liquidationLtvBps: LIQUIDATION_LTV_BPS,
      });
      await postMessage(base, er, signer, room, `${LOAN_MESSAGE_PREFIX}${loanId}`);
      onDone();
    } catch (e) {
      setError(explainLoanError(e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }

  const current = STEPS[step - 1];
  const blocked = step < 4 ? problem(step) : null;
  const borrowerKey = counterparties.find((m) => m.pubkey.toBase58() === borrower)?.pubkey;
  const solPrice = price ? priceUsd(price) : null;
  const liqPrice = owed > 0n && c > 0n ? solPriceAtLtv(owed, c, LIQUIDATION_LTV_BPS) : null;

  const review = [
    { label: "Borrower", value: borrowerKey ? short(borrowerKey) : "—", step: 1, mono: true },
    { label: "You lend", value: `${formatUsdc(p)} USDC`, step: 1 },
    { label: "Interest for the whole term", value: formatBpsAsPercent(bps, 2), step: 2 },
    { label: "Term", value: formatDuration(duration), step: 2 },
    { label: "Borrower locks", value: `${formatWsol(c)} wSOL`, step: 3 },
    { label: "Max LTV / liquidation", value: `${formatBpsAsPercent(MAX_LTV_BPS, 0)} / ${formatBpsAsPercent(LIQUIDATION_LTV_BPS, 0)}`, step: 3 },
  ];

  return (
    <div className={styles.proposeWizard}>
      <button type="button" className={styles.backLink} onClick={onCancel}>
        <span aria-hidden>←</span> Back to room
      </button>

      <div className={wiz.layout}>
        <div className={wiz.main}>
          <div className={wiz.progress}>
            <div>
              <p className={wiz.kicker}>
                Propose a private loan · Step <span className="num">{step}</span> of 4 · {current.title}
              </p>
              <ol className={wiz.dots} aria-label="Steps">
                {STEPS.map((s, i) => {
                  const n = i + 1;
                  return (
                    <li key={s.title}>
                      <button
                        type="button"
                        className={wiz.dot}
                        data-state={n < step ? "done" : n === step ? "current" : "todo"}
                        aria-current={n === step ? "step" : undefined}
                        aria-label={`${s.title}${n < step ? ", done" : ""}`}
                        disabled={!reachable(n) || n === step}
                        onClick={() => go(n)}
                      >
                        {s.title}
                      </button>
                    </li>
                  );
                })}
              </ol>
            </div>
          </div>

          <form
            className={wiz.stepBody}
            onSubmit={(e) => {
              e.preventDefault();
              if (step < 4) {
                if (!blocked) go(step + 1);
              } else void submit();
            }}
          >
            <h2 ref={heading} tabIndex={-1} className={wiz.question}>
              {current.question}
            </h2>

            {step === 1 && (
              <div className={wiz.fields}>
                <div className={styles.field}>
                  <label htmlFor="borrower">Borrower</label>
                  <select id="borrower" className={styles.input} value={borrower} onChange={(e) => setBorrower(e.target.value)}>
                    {counterparties.map((m) => (
                      <option key={m.pubkey.toBase58()} value={m.pubkey.toBase58()}>
                        {short(m.pubkey)} · {m.owner ? "owner" : m.role}
                      </option>
                    ))}
                  </select>
                </div>
                <AmountInput label="You lend" value={principal} onChange={setPrincipal} unit="USDC" decimals={6} size="xl" autoFocus />
                <p className={wiz.explain}>
                  Only you and this borrower can read these terms. Other lenders in the room never see them.
                </p>
              </div>
            )}

            {step === 2 && (
              <div className={wiz.fields}>
                <AmountInput
                  label="Interest for the whole term"
                  value={rate}
                  onChange={setRate}
                  unit="%"
                  decimals={2}
                  hint="A flat amount, not yearly. Charged in full, even if repaid early. Up to 20%."
                />
                <div className={wiz.termRow}>
                  <span className={styles.fieldLabel} id="term-label">
                    Term
                  </span>
                  <div className={wiz.quick} role="group" aria-labelledby="term-label">
                    {DURATIONS.map((d) => (
                      <button
                        type="button"
                        key={d.seconds}
                        className={wiz.quickChip}
                        aria-pressed={duration === d.seconds}
                        onClick={() => setDuration(d.seconds)}
                      >
                        {d.label}
                      </button>
                    ))}
                  </div>
                </div>
                <p className={wiz.sentence}>
                  The borrower receives <b className="num">{formatUsdc(p)}</b> USDC and repays{" "}
                  <b className="num">{formatUsdc(owed)}</b> USDC within {formatDuration(duration)}. Your interest is{" "}
                  <b className="num">{formatUsdc(owed - p)}</b> USDC.
                </p>
              </div>
            )}

            {step === 3 && (
              <div className={wiz.fields}>
                <AmountInput label="Borrower locks" value={collateral} onChange={setCollateral} unit="wSOL" decimals={9} />
                <div className={wiz.quick}>
                  <button type="button" className={wiz.quickChip} onClick={suggest} disabled={!price}>
                    Suggest about 50% LTV
                  </button>
                </div>
                {ltv !== null && (
                  <HealthMeter
                    ltvBps={ltv}
                    healthBps={healthBps(ltv, LIQUIDATION_LTV_BPS)}
                    maxLtvBps={MAX_LTV_BPS}
                    liquidationLtvBps={LIQUIDATION_LTV_BPS}
                    stale={!price?.fresh}
                    liquidationPrice={liqPrice}
                    solPrice={solPrice}
                  />
                )}
                <ul className={styles.ruleList}>
                  <li>
                    <b>LTV</b> is what the borrower owes divided by what the wSOL is worth. It must be{" "}
                    {formatBpsAsPercent(MAX_LTV_BPS, 0)} or less when the borrower accepts.
                  </li>
                  <li>
                    <b>Liquidation</b> opens if SOL falls far enough that LTV reaches{" "}
                    {formatBpsAsPercent(LIQUIDATION_LTV_BPS, 0)}. You are repaid from the wSOL before the deadline.
                  </li>
                  <li>
                    <b>Expiry</b>: if the borrower has not repaid by the deadline, you receive all the wSOL.
                  </li>
                </ul>
              </div>
            )}

            {step === 4 && (
              <div className={wiz.fields}>
                <p className={wiz.sentence}>
                  You lend <b className="num">{formatUsdc(p)}</b> USDC. The borrower locks <b className="num">{formatWsol(c)}</b> wSOL
                  and repays <b className="num">{formatUsdc(owed)}</b> USDC within {formatDuration(duration)} of accepting.
                </p>
                <p className={wiz.sentenceStrong}>If they miss the deadline, you receive the wSOL.</p>
                <dl className={wiz.terms}>
                  {review.map((r) => (
                    <div key={r.label} className={wiz.termRowItem}>
                      <dt>{r.label}</dt>
                      <dd className={r.mono ? styles.mono : "num"}>{r.value}</dd>
                      <button type="button" className={wiz.edit} onClick={() => go(r.step)} aria-label={`Edit ${r.label}`}>
                        Edit
                      </button>
                    </div>
                  ))}
                </dl>
                <p className={wiz.explain}>
                  Proposing does not move money. Your wallet signs twice: once to set up the loan&apos;s private custody on
                  Solana (about 0.017 SOL of rent), once to write the terms privately. You fund the offer afterwards, and the
                  borrower accepts that exact revision.
                </p>
              </div>
            )}

            <div className={wiz.footer}>
              {step > 1 ? (
                <Button variant="ghost" onClick={() => go(step - 1)}>
                  Back
                </Button>
              ) : (
                <Button variant="ghost" onClick={onCancel}>
                  Cancel
                </Button>
              )}
              <span className={styles.footerEnd}>
                {blocked && <span className={styles.hint}>{blocked}</span>}
                {step < 4 ? (
                  <Button type="submit" size="lg" disabled={Boolean(blocked)}>
                    Continue
                  </Button>
                ) : (
                  <Button type="submit" size="lg" loading={busy}>
                    Propose these terms
                  </Button>
                )}
              </span>
            </div>
            {error && (
              <p role="alert" className={styles.error}>
                {error}
              </p>
            )}
          </form>
        </div>

        <aside className={wiz.aside} aria-label="Borrower's view of these terms">
          <section className={styles.desk}>
            <h2 className={styles.deskTitle}>Borrower&apos;s view</h2>
            <div className={styles.figures}>
              <div>
                <span>Receives</span>
                <b className="num">{formatUsdc(p)}</b>
                <small>USDC</small>
              </div>
              <div>
                <span>Repays</span>
                <b className="num">{formatUsdc(owed)}</b>
                <small>USDC</small>
              </div>
              <div>
                <span>Locks</span>
                <b className="num">{formatWsol(c)}</b>
                <small>wSOL</small>
              </div>
            </div>
            <dl className={styles.deskList}>
              <div>
                <dt>Interest</dt>
                <dd className="num">{formatBpsAsPercent(bps, 2)}</dd>
              </div>
              <div>
                <dt>Term</dt>
                <dd>{formatDuration(duration)}</dd>
              </div>
              <div>
                <dt>LTV today</dt>
                <dd className="num">{ltv === null ? "—" : formatBpsAsPercent(ltv)}</dd>
              </div>
              <div>
                <dt>Max / liquidation</dt>
                <dd className="num">
                  {formatBpsAsPercent(MAX_LTV_BPS, 0)} / {formatBpsAsPercent(LIQUIDATION_LTV_BPS, 0)}
                </dd>
              </div>
            </dl>
            <p className={styles.hint}>Repay before the deadline to get the wSOL back.</p>
          </section>
        </aside>
      </div>
    </div>
  );
}
