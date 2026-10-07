"use client";

import { useMemo, useState } from "react";
import { PHASE_WORDS } from "@/lib/phase-words";
import { Button } from "@/components/ui/Button";
import { Chips } from "@/components/ui/Chips";
import { formatUsdc, formatWsol } from "@/lib/format";
import { EarlyRepayment, type TermsV2 } from "@/lib/loan-math-v2";
import { selectableCollateral } from "@/lib/models/collateral";
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
const settleWords = (unit: string) =>
  ({ "overdue-liquidation": "A liquidator settles after grace", "priced-recovery": `The lender takes ${unit} worth the debt`, "terminal-claim": `The lender takes all the ${unit}` }) as const;
/** jitoSOL (test) practises at a jitoSOL-like price; wSOL keeps SOL at $150. */
const HIGH = { wSOL: 15_000_000_000n, jitoSOL: 18_000_000_000n } as const;

/**
 * Wallet-free practice for the V2 repayment rules: 100 USDC for 30 days at 5%, 24 hours of grace,
 * a 1% late fee. Every number comes from the same math the V2 program runs.
 */
export function RulesSimulator() {
  const [policy, setPolicy] = useState<EarlyRepayment>(EarlyRepayment.ProRata);
  // Story 26.2: with jitoSOL (test) enabled, practise with either asset and its own caps.
  const assets = selectableCollateral();
  const [assetIndex, setAssetIndex] = useState(0);
  const asset = assets[assetIndex] ?? assets[0];
  const high = HIGH[asset.symbol];
  const low = (high * 3n) / 5n;
  const priceName = asset.symbol === "wSOL" ? "SOL" : asset.symbol;
  const [sim, setSim] = useState<SimV2>(() => startSim(base(EarlyRepayment.ProRata), COLLATERAL, HIGH.wSOL, "wSOL"));
  const reset = (p = policy, a = asset) => setSim(startSim(base(p), COLLATERAL, HIGH[a.symbol], a.label));
  const SETTLE_WORDS = settleWords(asset.label);
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
      {assets.length > 1 && (
        <Chips
          label="Collateral"
          options={assets.map((a, i) => ({ value: i, label: a.label }))}
          value={assetIndex}
          onChange={(i) => {
            setAssetIndex(i);
            reset(policy, assets[i]);
          }}
        />
      )}
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
          <dt>{asset.label} locked</dt>
          <dd className="num">{formatWsol(sim.collateral)} {asset.label}</dd>
        </div>
        <div>
          <dt>{priceName} price</dt>
          <dd className="num">${(Number(sim.price) / 1e8).toFixed(2)}</dd>
        </div>
        <div>
          <dt>Max / liquidation LTV</dt>
          <dd className="num">
            {asset.maxLtvBps / 100}% / {asset.liquidationLtvBps / 100}%
          </dd>
        </div>
      </dl>
      <ol className={styles.timeline}>
        <li data-passed={sim.now >= d.maturity}>Deadline, {day(d.maturity)}: the 1% late fee applies once.{passed(d.maturity)}</li>
        <li data-passed={sim.now >= d.graceEnd}>Grace ends, {day(d.graceEnd)}: anyone may pay the debt and take {asset.label} worth that plus 5%; the rest returns.{passed(d.graceEnd)}</li>
        <li data-passed={sim.now >= d.pricedFrom}>Priced recovery, {day(d.pricedFrom)}: the lender may take {asset.label} worth the debt; the rest returns.{passed(d.pricedFrom)}</li>
        <li data-passed={sim.now >= d.terminalFrom}>Final claim, {day(d.terminalFrom)}: the lender may take all the {asset.label}, even if it is worth more.{passed(d.terminalFrom)}</li>
      </ol>
      <div className={styles.controls}>
        <Button variant="secondary" onClick={() => setSim(advance(sim, DAY))}>+1 day</Button>
        <Button variant="secondary" onClick={() => setSim(advance(sim, 7 * DAY))}>+1 week</Button>
        <Button variant="secondary" disabled={!active} onClick={() => setSim(pay(sim, 10_000_000n))}>Pay 10 USDC</Button>
        <Button variant="secondary" disabled={!active} onClick={() => setSim(topUp(sim, 500_000_000n))}>Add 0.5 {asset.label}</Button>
        <Button variant="secondary" onClick={() => setSim(setPrice(sim, sim.price === high ? low : high))}>
          {sim.price === high ? `Drop ${priceName} to $${Number(low / 100_000_000n)}` : `Return ${priceName} to $${Number(high / 100_000_000n)}`}
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
