"use client";

import { PublicKey } from "@solana/web3.js";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { usePrice } from "@/lib/client/hooks";
import { formatBpsAsPercent, formatUsdc, formatWsol, shortKey } from "@/lib/format";
import { maxExposure } from "@/lib/loan-math-v2";
import { minCollateralLamports } from "@/lib/risk";
import type { BorrowRequest } from "@/lib/private/v2-room-view";
import { DEFAULT_RULES, GRACE_CHOICES, reviewFigures, rulesProblem, termsFrom, type RepaymentRules } from "@/lib/v2/rules";
import type { ProposalV2 } from "@/lib/private/v2-loans";
import shared from "../private.module.css";
import s from "../desk/Desk.module.css";

/**
 * A lender's offer for one borrowing request, with the V2 repayment rules. Collateral is sized
 * from the most the borrower could owe at the chosen starting LTV, at today's conservative price.
 */
export function V2ProposeForm({
  request,
  desks,
  onCancel,
  propose,
}: {
  request: BorrowRequest;
  desks: { anchor: PublicKey; label: string }[];
  onCancel: () => void;
  propose: (p: ProposalV2, desk?: PublicKey) => Promise<unknown>;
}) {
  const { price } = usePrice();
  const [rate, setRate] = useState("2");
  const [ltv, setLtv] = useState("60");
  const [liq, setLiq] = useState("80");
  const [rules, setRules] = useState<RepaymentRules>(DEFAULT_RULES);
  const [desk, setDesk] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const base = { principal: request.principal, interestBps: Math.round(Number(rate || "0") * 100), durationSeconds: request.days * 86_400 };
  const problem = rulesProblem(base, rules);
  const terms = useMemo(() => (problem ? null : termsFrom(base, rules)), [problem, base.principal, base.interestBps, base.durationSeconds, rules]); // eslint-disable-line react-hooks/exhaustive-deps
  const ltvBps = Math.round(Number(ltv || "0") * 100);
  const liqBps = Math.round(Number(liq || "0") * 100);
  const riskProblem = ltvBps <= 0 || ltvBps >= liqBps || liqBps > 9_000 ? "The starting LTV must be above 0 and below the liquidation LTV (at most 90%)." : null;
  const collateral = terms && price && !riskProblem ? minCollateralLamports(maxExposure(terms), ltvBps, price) : null;
  const f = terms ? reviewFigures(terms, 0) : null;

  return (
    <form
      className={s.form}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!terms || !collateral) return;
        setBusy(true);
        setErr(null);
        try {
          await propose(
            { borrower: request.borrower, requestIndex: request.index, terms, collateralAmount: collateral, maxLtvBps: ltvBps, liquidationLtvBps: liqBps },
            desk ? new PublicKey(desk) : undefined,
          );
        } catch (x) {
          setErr(x instanceof Error ? x.message : "That did not work.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className={`${s.wide} ${s.empty}`}>
        Offer for request {request.index + 1}: <span className="num">{formatUsdc(request.principal)} USDC</span> for{" "}
        <span className="num">{request.days}</span> days from <span className="mono">{shortKey(request.borrower.toBase58())}</span>.
      </p>
      <label>
        Interest for the term (%)
        <input className={`${shared.input} num`} inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
      </label>
      <label>
        Starting LTV (%)
        <input className={`${shared.input} num`} inputMode="decimal" value={ltv} onChange={(e) => setLtv(e.target.value)} />
      </label>
      <label>
        Liquidation LTV (%)
        <input className={`${shared.input} num`} inputMode="decimal" value={liq} onChange={(e) => setLiq(e.target.value)} />
      </label>
      <label>
        Grace after the due date
        <select className={shared.input} value={rules.graceSeconds} onChange={(e) => setRules({ ...rules, graceSeconds: Number(e.target.value) })}>
          {GRACE_CHOICES.map((g) => (
            <option key={g} value={g}>
              {g / 3600} hours
            </option>
          ))}
        </select>
      </label>
      <label>
        Late fee (% of unpaid principal)
        <input
          className={`${shared.input} num`}
          inputMode="decimal"
          value={rules.lateFeeBps / 100}
          onChange={(e) => setRules({ ...rules, lateFeeBps: Math.round(Number(e.target.value || "0") * 100) })}
        />
      </label>
      <fieldset>
        <legend>Repaying early</legend>
        <label className={s.check}>
          <input type="radio" checked={rules.earlyRepayment === "pro-rata"} onChange={() => setRules({ ...rules, earlyRepayment: "pro-rata" })} /> Interest for days used
        </label>
        <label className={s.check}>
          <input type="radio" checked={rules.earlyRepayment === "full-term"} onChange={() => setRules({ ...rules, earlyRepayment: "full-term" })} /> Full-term interest
        </label>
      </fieldset>
      {desks.length > 0 && (
        <label className={s.wide}>
          Lend under a desk policy (optional)
          <select className={shared.input} value={desk} onChange={(e) => setDesk(e.target.value)}>
            <option value="">No desk</option>
            {desks.map((d) => (
              <option key={d.anchor.toBase58()} value={d.anchor.toBase58()}>
                {d.label}
              </option>
            ))}
          </select>
          <span className={shared.hint}>The program checks the offer against the desk&rsquo;s current policy. Its auditors are shown to the borrower before signing.</span>
        </label>
      )}
      {f && (
        <dl className={`${s.dl} ${s.wide}`}>
          <div>
            <dt>Interest for the term</dt>
            <dd className="num">
              {formatUsdc(f.termCost)} USDC (about {formatBpsAsPercent(f.annualizedBps)} a year)
            </dd>
          </div>
          <div>
            <dt>Pricing ceiling</dt>
            <dd className="num">{formatBpsAsPercent(f.ceilingBps)} a year</dd>
          </div>
          <div>
            <dt>Most the borrower could owe</dt>
            <dd className="num">{formatUsdc(f.maxExposure)} USDC</dd>
          </div>
          <div>
            <dt>Collateral asked</dt>
            <dd className="num">{collateral ? `${formatWsol(collateral)} wSOL` : price ? "—" : "Waiting for the SOL price"}</dd>
          </div>
        </dl>
      )}
      {(problem || riskProblem || err) && (
        <p role="alert" className={`${shared.error} ${s.wide}`}>
          {problem ?? riskProblem ?? err}
        </p>
      )}
      <div className={`${s.actions} ${s.wide}`}>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" loading={busy} disabled={!terms || !collateral}>
          Propose these terms
        </Button>
      </div>
    </form>
  );
}
