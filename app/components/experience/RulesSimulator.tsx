"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Chips } from "@/components/ui/Chips";
import { formatUsdc, formatWsol } from "@/lib/format";
import { EarlyRepayment, type TermsV2 } from "@/lib/loan-math-v2";
import { advance, pay, setPrice, settle, settlementNow, simDeadlines, simPayoff, simPhase, startSim, topUp, type SimV2 } from "@/lib/v2/simulator";
import styles from "./RulesSimulator.module.css";

const START = 1_800_000_000;
const DAY = 86_400;
const base = (policy: EarlyRepayment): TermsV2 => ({
  principal: 100_000_000n,
  interestBps: 500,
  duration: 30 * DAY,
  startTs: START,
  earlyRepayment: policy,
  minInterestBps: 2_500,
  graceSeconds: DAY,
  lateFeeBps: 100,
  annualCeilingBps: 10_000,
});
const COLLATERAL = 1_020_000_000n;
const PHASE_WORDS = { Active: "Waiting for repayment", Grace: "In grace", Overdue: "Grace has ended", PricedRecovery: "Priced recovery is open", Terminal: "Final claim is open" } as const;
const SETTLE_WORDS = { "overdue-liquidation": "A liquidator settles after grace", "priced-recovery": "The lender takes wSOL worth the debt", "terminal-claim": "The lender takes all the wSOL" } as const;

/**
 * Wallet-free practice for the V2 repayment rules: 100 USDC for 30 days at 5%, 24 hours of grace,
 * a 1% late fee. Every number comes from the same math the V2 program runs.
 */
export function RulesSimulator() {
  const [policy, setPolicy] = useState<EarlyRepayment>(EarlyRepayment.ProRata);
  const [sim, setSim] = useState<SimV2>(() => startSim(base(EarlyRepayment.ProRata), COLLATERAL));
  const reset = (p = policy) => setSim(startSim(base(p), COLLATERAL));
  const d = useMemo(() => simDeadlines(sim), [sim]);
  const day = (t: number) => `day ${((t - START) / DAY).toFixed((t - START) % DAY === 0 ? 0 : 1)}`;
  const phase = simPhase(sim);
  const passed = (t: number) => (sim.now >= t ? <span className="visually-hidden"> (passed)</span> : null);
  const available = settlementNow(sim);
  const active = sim.status === "active";

  return (
    <section className={styles.sim} aria-labelledby="rules-sim">
      <div className={styles.head}>
        <h2 id="rules-sim">Try the repayment rules</h2>
        <p className={styles.label}>Simulation only. No wallet, network or transaction.</p>
      </div>
      <Chips
        label="If repaid early"
        options={[
          { value: EarlyRepayment.ProRata, label: "Interest for time used" },
          { value: EarlyRepayment.FullTerm, label: "Full-term interest" },
        ]}
        value={policy}
        onChange={(v) => {
          setPolicy(v);
          reset(v);
        }}
      />
      <dl className={styles.figures}>
        <div>
          <dt>Today</dt>
          <dd>{day(sim.now)}</dd>
        </div>
        <div>
          <dt>Where it stands</dt>
          <dd>{active ? PHASE_WORDS[phase] : "Settled"}</dd>
        </div>
        <div>
          <dt>To close it now</dt>
          <dd className="num">{formatUsdc(simPayoff(sim))} USDC</dd>
        </div>
        <div>
          <dt>Principal still owed</dt>
          <dd className="num">{formatUsdc(active ? sim.ledger.outstandingPrincipal : 0n)} USDC</dd>
        </div>
        <div>
          <dt>wSOL locked</dt>
          <dd className="num">{formatWsol(sim.collateral)} wSOL</dd>
        </div>
        <div>
          <dt>SOL price</dt>
          <dd className="num">${(Number(sim.price) / 1e8).toFixed(2)}</dd>
        </div>
      </dl>
      <ol className={styles.timeline}>
        <li data-passed={sim.now >= d.maturity}>Deadline, {day(d.maturity)}: the 1% late fee applies once.{passed(d.maturity)}</li>
        <li data-passed={sim.now >= d.graceEnd}>Grace ends, {day(d.graceEnd)}: anyone may pay the debt and take wSOL worth that plus 5%; the rest returns.{passed(d.graceEnd)}</li>
        <li data-passed={sim.now >= d.pricedFrom}>Priced recovery, {day(d.pricedFrom)}: the lender may take wSOL worth the debt; the rest returns.{passed(d.pricedFrom)}</li>
        <li data-passed={sim.now >= d.terminalFrom}>Final claim, {day(d.terminalFrom)}: the lender may take all the wSOL, even if it is worth more.{passed(d.terminalFrom)}</li>
      </ol>
      <div className={styles.controls}>
        <Button variant="secondary" onClick={() => setSim(advance(sim, DAY))}>+1 day</Button>
        <Button variant="secondary" onClick={() => setSim(advance(sim, 7 * DAY))}>+1 week</Button>
        <Button variant="secondary" disabled={!active} onClick={() => setSim(pay(sim, 10_000_000n))}>Pay 10 USDC</Button>
        <Button variant="secondary" disabled={!active} onClick={() => setSim(topUp(sim, 500_000_000n))}>Add 0.5 wSOL</Button>
        <Button variant="secondary" onClick={() => setSim(setPrice(sim, sim.price === 15_000_000_000n ? 9_000_000_000n : 15_000_000_000n))}>
          {sim.price === 15_000_000_000n ? "Drop SOL to $90" : "Return SOL to $150"}
        </Button>
        <Button disabled={!active} onClick={() => setSim(pay(sim, simPayoff(sim)))}>Repay everything</Button>
        {available && (
          <Button variant="danger" onClick={() => setSim(settle(sim, available))}>
            {SETTLE_WORDS[available]}
          </Button>
        )}
        <Button variant="ghost" onClick={() => reset()}>Start again</Button>
      </div>
      <ol className={styles.log} aria-live="polite">
        {sim.log.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ol>
    </section>
  );
}
