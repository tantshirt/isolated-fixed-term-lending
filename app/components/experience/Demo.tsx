"use client";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  exactAmount,
  initialSimulation,
  SimulationService,
  type Role,
} from "@/lib/simulation";
import {
  collateralValueUsdc,
  currentLtvBps,
  debt,
  seizeUsdc,
  wsolToCaller,
} from "@/lib/loan-math";
import {
  parseAmount,
  validateAmountStep,
  validateRiskStep,
  validateTermsStep,
  type OfferDraft,
} from "@/lib/offer-validation";
import type { LoanAction } from "@/lib/loan-service";
import { useDemoSession } from "./DemoSession";
import s from "./Experience.module.css";
const stepNames = ["Amount", "Rate & term", "Collateral", "Review"];
export function Demo() {
  const router = useRouter(),
    path = usePathname(),
    params = useSearchParams();
  const {
    state,
    setState,
    draft,
    setDraft,
    ready,
    recovery,
    guided,
    setGuided,
    resetSession,
  } = useDemoSession();
  const [error, setError] = useState(""),
    [touched, setTouched] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const wizard = path === "/demo/create";
  const requested = Number(params.get("step") || 1);
  const safe =
    Number.isInteger(requested) && requested >= 1 && requested <= 4
      ? requested
      : 1;
  const checks = [
    validateAmountStep(draft),
    validateTermsStep(draft),
    validateRiskStep(draft),
  ];
  const unmet = checks.findIndex((e) => Object.keys(e).length > 0);
  const step = unmet >= 0 ? Math.min(safe, unmet + 1) : safe;
  const errors = touched ? checks[step - 1] || {} : {};
  useEffect(() => {
    if (ready && wizard && safe !== step)
      router.replace(`/demo/create?step=${step}`);
  }, [ready, wizard, safe, step, router]);
  useEffect(() => {
    if (ready) heading.current?.focus();
  }, [path, step, ready, state.loan?.status]);
  const update = (patch: Partial<OfferDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setError("");
  };
  const go = (n: number) => {
    setTouched(false);
    setError("");
    router.push(`/demo/create?step=${n}`);
  };
  const perform = async (action: LoanAction) => {
    try {
      setError("");
      await new SimulationService(() => state, setState).execute({
        action,
        draft,
      });
      if (action === "create") router.push("/demo/offers/example");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not complete this action."
      );
    }
  };
  const reset = () => {
    resetSession();
    setError("");
    router.push("/demo");
  };
  const replay = () => {
    const previous = state.loan;
    if (previous)
      setDraft({
        principal: exactAmount(previous.principal, 6),
        collateral: exactAmount(previous.collateralAmount, 9),
        interestBps: previous.interestBps,
        durationSeconds: previous.durationSeconds,
        maxLtvBps: previous.maxLtvBps,
        liquidationLtvBps: previous.liquidationLtvBps,
      });
    setState(initialSimulation());
    setError("");
    router.push("/demo/create");
  };
  const loan = state.loan;
  const principal = parseAmount(draft.principal, 6);
  const owed =
    principal !== null &&
    Number.isInteger(draft.interestBps) &&
    draft.interestBps >= 0
      ? debt(principal, draft.interestBps)
      : null;
  const active = loan?.status === "filled",
    settled = loan && !["open", "filled"].includes(loan.status);
  const current = loan?.status === "open" ? 1 : active ? 2 : settled ? 3 : 0;
  const ltv = loan
    ? currentLtvBps(
        loan.debt,
        collateralValueUsdc(loan.collateralAmount, state.price, state.conf, -8)
      )
    : null;
  const expired = !!(active && loan && state.now >= loan.expiry);
  const liquidatable = !!(
    active &&
    loan &&
    !expired &&
    ltv !== null &&
    ltv >= loan.liquidationLtvBps
  );
  const value = loan
    ? collateralValueUsdc(loan.collateralAmount, state.price, state.conf, -8)
    : 0n;
  const liquidationShare =
    loan && value > 0n
      ? wsolToCaller(loan.collateralAmount, seizeUsdc(loan.debt), value)
      : null;
  const title = wizard
    ? stepNames[step - 1]
    : !loan
    ? "A real loan story. Practice money."
    : loan.status === "open"
    ? "Your offer is ready for a borrower."
    : active
    ? expired
      ? "The repayment deadline has passed."
      : liquidatable
      ? "The collateral reached its liquidation line."
      : "The loan is running."
    : "See exactly how the loan settled.";
  if (!ready)
    return (
      <div className={s.workspace} aria-busy="true">
        Preparing your simulation…
      </div>
    );
  return (
    <>
      <div className={s.banner}>
        <strong>Simulation</strong> · Practice funds. No wallet, network, or
        transactions.
      </div>
      <main className={s.workspace}>
        <header>
          <p className={s.eyebrow}>
            {guided ? "Your guided loan story" : "Free exploration"}
          </p>
          <h1 ref={heading} tabIndex={-1}>
            {title}
          </h1>
          <p>
            {wizard
              ? "Start with the example, then make the terms your own."
              : "Try each role and follow every movement of USDC and wSOL."}
          </p>
        </header>
        {recovery && (
          <p role="status" className={s.note}>
            {recovery}
          </p>
        )}
        <div className={s.toolbar}>
          <label>
            Acting as{" "}
            <select
              aria-label="Acting as"
              value={state.role}
              onChange={(e) => {
                setState({ ...state, role: e.target.value as Role });
                setError("");
              }}
            >
              <option value="lender">Lender</option>
              <option value="borrower">Borrower</option>
              <option value="liquidator">Liquidator</option>
            </select>
          </label>
          <div className={s.actions} style={{ marginTop: 0 }}>
            <button className={s.secondary} onClick={() => setGuided(!guided)}>
              {guided ? "Explore freely" : "Resume guidance"}
            </button>
            <button className={s.secondary} onClick={reset}>
              Reset demo
            </button>
          </div>
        </div>
        {guided && (
          <ol className={s.progress} aria-label="Loan story">
            {["Set terms", "Borrow", "Manage", "Settle"].map((v, i) => (
              <li
                key={v}
                data-active={current === i}
                aria-current={current === i ? "step" : undefined}
              >
                {i + 1}. {v}
              </li>
            ))}
          </ol>
        )}
        <div className={s.grid}>
          <section className={s.card}>
            {!wizard && !loan && (
              <>
                <h2>Start in the lender’s seat.</h2>
                <p className={s.lede}>
                  Offer 100 USDC for 7 days at 5% full-term interest, backed by
                  1.1 wSOL. You can edit every term.
                </p>
                <p className={s.note}>
                  Each role starts with 1,000 simulated USDC. The borrower also
                  has 10 wSOL. These balances only exist in this browser.
                </p>
                <Link
                  className={s.primary}
                  style={{ marginTop: 24 }}
                  href="/demo/create"
                >
                  Set the terms →
                </Link>
              </>
            )}
            {wizard && (
              <>
                <nav className={s.steps} aria-label="Create offer steps">
                  {stepNames.map((v, i) => (
                    <button
                      key={v}
                      aria-current={step === i + 1 ? "step" : undefined}
                      disabled={unmet >= 0 && i > unmet}
                      onClick={() => go(i + 1)}
                    >
                      {i + 1}. {v}
                    </button>
                  ))}
                </nav>
                <div data-testid={`wizard-step-${step}`}>
                  {step === 1 && (
                    <>
                      <h2>How much will you lend?</h2>
                      <Field
                        label="USDC amount"
                        value={draft.principal}
                        onChange={(v) => update({ principal: v })}
                        error={errors.principal}
                      />
                      <p className={s.hint}>
                        The amount is held in an isolated vault until a borrower
                        accepts or you cancel.
                      </p>
                    </>
                  )}
                  {step === 2 && (
                    <>
                      <h2>Set the cost and the clock.</h2>
                      <Field
                        label="Full-term interest (%)"
                        value={String(draft.interestBps / 100)}
                        onChange={(v) =>
                          update({ interestBps: Math.round(Number(v) * 100) })
                        }
                        error={errors.interestBps}
                      />
                      <label className={s.field}>
                        Loan term
                        <select
                          value={draft.durationSeconds}
                          onChange={(e) =>
                            update({ durationSeconds: Number(e.target.value) })
                          }
                        >
                          <option value={60}>1 minute</option>
                          <option value={86400}>1 day</option>
                          <option value={604800}>7 days</option>
                          <option value={2592000}>30 days</option>
                          <option value={7776000}>90 days</option>
                        </select>
                      </label>
                      <p className={s.note}>
                        This is full-term interest, not an annual rate. Repaying
                        early still costs the same. The clock starts when the
                        borrower accepts.
                      </p>
                    </>
                  )}
                  {step === 3 && (
                    <>
                      <h2>Choose the collateral.</h2>
                      <Field
                        label="wSOL collateral"
                        value={draft.collateral}
                        onChange={(v) => update({ collateral: v })}
                        error={errors.collateral}
                      />
                      <p className={s.note}>
                        wSOL is wrapped SOL. It stays in the collateral vault
                        while the loan is active. The example price is $150 per
                        SOL, with $0.15 confidence deducted for valuation.
                      </p>
                      <details className={s.advanced}>
                        <summary>Advanced: loan-to-value limits</summary>
                        <Field
                          label="Maximum LTV (%)"
                          value={String(draft.maxLtvBps / 100)}
                          onChange={(v) =>
                            update({ maxLtvBps: Math.round(Number(v) * 100) })
                          }
                          error={errors.maxLtvBps}
                        />
                        <Field
                          label="Liquidation LTV (%)"
                          value={String(draft.liquidationLtvBps / 100)}
                          onChange={(v) =>
                            update({
                              liquidationLtvBps: Math.round(Number(v) * 100),
                            })
                          }
                          error={errors.liquidationLtvBps}
                        />
                        <p className={s.note}>
                          LTV is debt divided by conservative collateral value.
                          Borrowing must meet max LTV. Liquidation is allowed at
                          or above the higher liquidation LTV.
                        </p>
                      </details>
                      {(errors.maxLtvBps || errors.liquidationLtvBps) && (
                        <p role="alert" className={s.error}>
                          {errors.maxLtvBps || errors.liquidationLtvBps}
                        </p>
                      )}
                    </>
                  )}
                  {step === 4 && (
                    <div className={s.review}>
                      <h2>All the terms, before you commit.</h2>
                      <p className={s.lede}>
                        Lend {draft.principal} USDC. Receive{" "}
                        {owed === null ? "—" : exactAmount(owed, 6)} USDC if the
                        borrower repays in time.
                      </p>
                      <button onClick={() => go(1)}>Edit amount</button> ·{" "}
                      <button onClick={() => go(2)}>Edit rate and term</button>{" "}
                      · <button onClick={() => go(3)}>Edit collateral</button>
                      <p className={s.note}>
                        Early repayment includes all interest. If the deadline
                        is missed, the lender receives all {draft.collateral}{" "}
                        wSOL. If SOL falls enough, liquidation can happen before
                        the deadline. Collateral value is not guaranteed.
                      </p>
                    </div>
                  )}
                </div>
                <div className={s.actions}>
                  {step > 1 && (
                    <button
                      className={s.secondary}
                      onClick={() => go(step - 1)}
                    >
                      Back
                    </button>
                  )}
                  {step < 4 ? (
                    <button
                      className={s.primary}
                      onClick={() => {
                        setTouched(true);
                        if (Object.keys(checks[step - 1]).length === 0)
                          go(step + 1);
                      }}
                    >
                      Continue →
                    </button>
                  ) : (
                    <button
                      className={s.primary}
                      onClick={() => perform("create")}
                    >
                      Create simulated offer
                    </button>
                  )}
                </div>
              </>
            )}
            {!wizard && loan && (
              <>
                <p className={s.badge} data-testid="loan-status">
                  {loan.status}
                </p>
                <h2 style={{ marginTop: 20 }}>
                  {loan.status === "open"
                    ? "Switch seats to take the loan."
                    : active
                    ? "Three ways this story can end."
                    : "Simulation receipt"}
                </h2>
                {loan.status === "open" && (
                  <>
                    <p className={s.lede}>
                      The lender’s {exactAmount(loan.principal, 6)} USDC is in
                      the vault. The borrower locks{" "}
                      {exactAmount(loan.collateralAmount, 9)} wSOL to receive
                      it.
                    </p>
                    <p className={s.note}>
                      Choose Borrower in the role selector, then accept.
                      Acceptance checks the current price and starts the
                      deadline.
                    </p>
                    <div className={s.actions}>
                      <button
                        className={s.primary}
                        onClick={() => perform("accept")}
                      >
                        Lock wSOL and borrow
                      </button>
                      <button
                        className={s.secondary}
                        onClick={() => perform("cancel")}
                      >
                        Cancel offer as lender
                      </button>
                    </div>
                  </>
                )}
                {active && (
                  <>
                    <p className={s.lede}>
                      Repay {exactAmount(loan.debt, 6)} USDC before the deadline
                      to recover {exactAmount(loan.collateralAmount, 9)} wSOL.
                    </p>
                    <p className={s.note}>
                      Simulated time remaining:{" "}
                      {Math.max(0, loan.expiry - state.now).toLocaleString()}{" "}
                      seconds. The clock only moves when you advance it.
                    </p>
                    <div className={s.actions}>
                      <button
                        className={s.primary}
                        onClick={() => perform("repay")}
                      >
                        Repay as borrower
                      </button>
                      <button
                        className={s.secondary}
                        data-testid="drop-price"
                        onClick={() => {
                          const p =
                            (loan.debt * 10n ** 11n * 10000n) /
                            (loan.collateralAmount *
                              BigInt(loan.liquidationLtvBps));
                          setState({
                            ...state,
                            price: p > 1n ? p : 2n,
                            conf: 0n,
                            publishTime: state.now,
                          });
                          setError("");
                        }}
                      >
                        Explore a price drop
                      </button>
                      <button
                        className={s.secondary}
                        data-testid="expire-loan"
                        onClick={() => {
                          setState({ ...state, now: loan.expiry });
                          setError("");
                        }}
                      >
                        Advance to deadline
                      </button>
                    </div>
                    {(expired || liquidatable) && (
                      <p role="status" className={s.note}>
                        {expired
                          ? "Repayment has stopped. Claiming transfers all collateral to the lender. Any role can submit the claim."
                          : "The current LTV is at or above the liquidation limit. Switch to Liquidator, then settle below to see the exact collateral split."}
                      </p>
                    )}
                    <details
                      className={s.advanced}
                      open={!guided || expired || liquidatable}
                    >
                      <summary>Scenario controls and settlement</summary>
                      <p className={s.hint}>
                        A price drop sets SOL just past this loan’s liquidation
                        line. Switch to Liquidator to settle. At expiry, any
                        role can claim for the lender.
                      </p>
                      {loan && liquidationShare !== null && (
                        <div
                          className={s.note}
                          aria-label="Liquidation preview"
                        >
                          <p>
                            Liquidator pays lender:{" "}
                            <strong>{exactAmount(loan.debt, 6)} USDC</strong>
                          </p>
                          <p>
                            Liquidator receives:{" "}
                            <strong>
                              {exactAmount(liquidationShare, 9)} wSOL
                            </strong>
                          </p>
                          <p>
                            Borrower receives back:{" "}
                            <strong>
                              {exactAmount(
                                loan.collateralAmount - liquidationShare,
                                9
                              )}{" "}
                              wSOL
                            </strong>
                          </p>
                          <p>
                            Calculated at the current simulated price.
                            Settlement still requires a fresh oracle and the
                            liquidation threshold.
                          </p>
                        </div>
                      )}
                      <div className={s.actions}>
                        <button
                          className={s.secondary}
                          onClick={() => perform("liquidate")}
                        >
                          Liquidate as liquidator
                        </button>
                        <button
                          className={s.secondary}
                          onClick={() => perform("claim")}
                        >
                          Claim expired collateral
                        </button>
                        <button
                          className={s.secondary}
                          onClick={() =>
                            setState({ ...state, publishTime: state.now })
                          }
                        >
                          Refresh simulated oracle
                        </button>
                        <button
                          className={s.secondary}
                          onClick={() =>
                            setState({ ...state, now: state.now + 61 })
                          }
                        >
                          Advance 61 seconds
                        </button>
                      </div>
                    </details>
                  </>
                )}
                {settled && (
                  <>
                    <p className={s.lede}>
                      Every transfer is recorded below. Replay with the same
                      terms to compare a different outcome.
                    </p>
                    <div className={s.actions}>
                      <button className={s.primary} onClick={replay}>
                        Replay this loan
                      </button>
                      {loan.status !== "closed" && (
                        <button
                          className={s.secondary}
                          onClick={() => perform("close")}
                        >
                          Close receipt as lender
                        </button>
                      )}
                      <Link className={s.secondary} href="/devnet">
                        Ready for Devnet ↗
                      </Link>
                    </div>
                  </>
                )}
              </>
            )}
            {error && (
              <p role="alert" className={s.error}>
                {error}
              </p>
            )}
          </section>
          <aside className={`${s.card} ${s.summary}`} aria-label="Loan summary">
            <h2>Your loan at a glance</h2>
            <dl>
              {[
                [
                  "Principal",
                  `${
                    loan && !wizard
                      ? exactAmount(loan.principal, 6)
                      : draft.principal || "—"
                  } USDC`,
                ],
                [
                  "Total repayment",
                  `${
                    loan && !wizard
                      ? exactAmount(loan.debt, 6)
                      : owed !== null
                      ? exactAmount(owed, 6)
                      : "—"
                  } USDC`,
                ],
                [
                  "Collateral",
                  `${
                    loan && !wizard
                      ? exactAmount(loan.collateralAmount, 9)
                      : draft.collateral || "—"
                  } wSOL`,
                ],
                [
                  "Full-term rate",
                  `${
                    (loan && !wizard ? loan.interestBps : draft.interestBps) /
                    100
                  }%`,
                ],
                [
                  "Term",
                  `${
                    (loan && !wizard
                      ? loan.durationSeconds
                      : draft.durationSeconds) / 86400
                  } days`,
                ],
                ["Simulated SOL price", `$${exactAmount(state.price, 8)}`],
                ...(loan && !wizard
                  ? [
                      ["Current LTV", `${((ltv ?? 0) / 100).toFixed(2)}%`],
                      ["Liquidation limit", `${loan.liquidationLtvBps / 100}%`],
                    ]
                  : []),
              ].map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            <p className={s.note}>
              This preview updates as you edit. These are practice funds; no
              real tokens move.
            </p>
          </aside>
        </div>
        {loan && (
          <>
            <section
              className={s.balances}
              aria-label="Simulated role balances"
            >
              {(["lender", "borrower", "liquidator"] as Role[]).map((r) => (
                <div key={r}>
                  <b>{r}</b>
                  <span>{exactAmount(state.balances[r].usdc, 6)} USDC</span>
                  <span>{exactAmount(state.balances[r].wsol, 9)} wSOL</span>
                </div>
              ))}
            </section>
            <section
              aria-label="Simulation receipts"
              data-testid="receipts"
              aria-live="polite"
            >
              {state.receipts.map((r, i) => (
                <p className={s.receipt} key={i}>
                  <strong>
                    {i + 1}. {r.action}
                  </strong>
                  <br />
                  {r.message}
                </p>
              ))}
            </section>
          </>
        )}
      </main>
    </>
  );
}
function Field({
  label,
  value,
  onChange,
  error,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const id = label.replace(/\W/g, "");
  return (
    <label className={s.field} htmlFor={id}>
      {label}
      <input
        id={id}
        inputMode="decimal"
        autoComplete="off"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(e.target.value);
        }}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
      />
      {error && (
        <span id={`${id}-error`} className={s.error}>
          {error}
        </span>
      )}
    </label>
  );
}
