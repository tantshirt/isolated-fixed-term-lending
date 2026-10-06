"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { messageFromAnchorError } from "@/lib/anchor-errors";
import { fmt, formatUsdc, formatWsol } from "@/lib/format";
import { OUTCOME_EXPLAINED, scenarioFrom, type LabOutcome } from "@/lib/lab-scenario";
import { claimAchievement, readLabScenario, registerForAchievements, requestScenario, requestSponsoredScenario } from "@/lib/private/lab";
import { usePrivate } from "@/lib/private/use-private";
import styles from "./private.module.css";
import lab from "./lab.module.css";

const CHOICES: { value: LabOutcome; label: string }[] = [
  { value: "repaid", label: "Repaid" },
  { value: "liquidated", label: "Liquidated" },
  { value: "expired", label: "Expired to the lender" },
];


/** A VRF-drawn loan scenario: guess how it ends, read why, and optionally record it publicly with SOAR. */
export function LabPage() {
  const { signer, base, connect } = usePrivate();
  const result = useRef<HTMLDivElement>(null);
  const [randomness, setRandomness] = useState<Uint8Array | null>(null);
  const [rounds, setRounds] = useState(0);
  const [phase, setPhase] = useState<"idle" | "drawing" | "ready">("idle");
  const [answer, setAnswer] = useState<LabOutcome | null>(null);
  const [record, setRecord] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  const show = (s: { randomness: Uint8Array; rounds: number }) => {
    setRandomness(s.randomness);
    setRounds(s.rounds);
    setPhase("ready");
  };
  const reset = () => {
    setError(null);
    setAnswer(null);
    setRecord("idle");
  };

  const load = useCallback(async () => {
    if (!signer) return null;
    const s = await readLabScenario(base, signer.publicKey);
    if (s?.ready) show(s);
    return s;
  }, [base, signer]);

  useEffect(() => {
    reset();
    setRandomness(null);
    setPhase("idle");
    void load();
  }, [load]);

  const draw = async () => {
    if (!signer) return;
    reset();
    setPhase("drawing");
    try {
      const before = rounds;
      const broke = rounds === 0 && (await base.getBalance(signer.publicKey)) < 2_000_000;
      await (broke ? requestSponsoredScenario(base, signer) : requestScenario(base, signer));
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const s = await readLabScenario(base, signer.publicKey);
        if (s?.ready && s.rounds > before) return show(s);
      }
      throw new Error("The VRF oracle has not answered yet. Try again in a minute.");
    } catch (e) {
      setError(messageFromAnchorError(e));
      setPhase(randomness ? "ready" : "idle");
    }
  };

  const save = async () => {
    if (!signer || !answer) return;
    setError(null);
    setRecord("busy");
    try {
      await registerForAchievements(base, signer);
      await claimAchievement(signer.publicKey, answer);
      setRecord("done");
    } catch (e) {
      setError(messageFromAnchorError(e));
      setRecord("idle");
    }
  };

  const call = (value: LabOutcome) => {
    if (answer) return;
    setAnswer(value);
    requestAnimationFrame(() => result.current?.focus());
  };

  const s = randomness ? scenarioFrom(randomness) : null;
  const correct = s && answer === s.outcome;

  return (
    <div className="page page-narrow">
      <header className={styles.hero}>
        <p className={styles.eyebrow}>Practice, no money at stake</p>
        <h1 className={styles.title}>How does this loan end?</h1>
        <p className={styles.lede}>
          MagicBlock&apos;s verifiable randomness draws a price drop and a borrower. You call the ending, then see why. Nobody, including
          us, can pick the scenario.
        </p>
      </header>

      {!signer ? (
        <section className={styles.panel}>
          <div className={styles.panelBody}>
            <ol className={lab.steps}>
              <li><strong>Draw</strong> a scenario with verifiable randomness.</li>
              <li><strong>Make your call:</strong> repaid, liquidated, or expired.</li>
              <li><strong>See why</strong> it ends that way.</li>
            </ol>
            <Button onClick={connect}>Connect a Devnet wallet</Button>
            <p className={styles.hint}>Your first draw is covered, so an empty Devnet wallet works.</p>
          </div>
        </section>
      ) : !s ? (
        <section className={styles.panel}>
          <div className={styles.panelBody}>
            <Button onClick={draw} loading={phase === "drawing"}>
              {phase === "drawing" ? "Waiting for randomness" : "Draw a scenario"}
            </Button>
            <p className={styles.hint}>Your first draw is covered if your wallet has no Devnet SOL. You still sign it, and it can only create your scenario.</p>
          </div>
        </section>
      ) : (
        <section className={styles.panel}>
          <div className={styles.panelHead}>
            <h2 className={styles.railTitle}>Scenario {rounds}</h2>
            <span className={styles.badge}>{answer ? "Step 3 of 3 · See why" : "Step 2 of 3 · Make your call"}</span>
          </div>
          <div className={styles.panelBody}>
            <dl className={styles.summary}>
              <div><dt>Borrowed</dt><dd className="num">{formatUsdc(s.principal)} USDC</dd></div>
              <div><dt>Collateral</dt><dd className="num">{formatWsol(s.collateral)} wSOL at ${fmt.usd(Number(s.startPrice) / 1e8)}</dd></div>
              <div><dt>Term</dt><dd className="num">{s.durationDays} days, {fmt.pct0(s.interestBps)} flat</dd></div>
              <div><dt>Liquidates at</dt><dd className="num">{fmt.pct(s.liquidationLtvBps)} LTV</dd></div>
            </dl>
            <ol className={lab.timeline}>
              <li><span className={lab.day}>Day {s.dropDay}</span> SOL falls {s.dropPercent}%. LTV is now {fmt.pct(s.ltvAfterDropBps)}.</li>
              <li><span className={lab.day}>{s.repayDay ? `Day ${s.repayDay}` : `Days 1–${s.durationDays}`}</span> {s.repayDay ? "The borrower tries to repay." : "The borrower never repays."}</li>
            </ol>
            <fieldset className={lab.choices}>
              <legend className={styles.fieldLabel}>Your call</legend>
              {CHOICES.map((c) => {
                const picked = answer === c.value;
                const right = !!answer && c.value === s.outcome;
                return (
                  <button key={c.value} type="button" className={lab.choice} aria-pressed={picked} aria-disabled={!!answer} data-result={right ? "right" : picked ? "wrong" : undefined} onClick={() => call(c.value)}>
                    {c.label}
                    {picked && <span className={lab.tag}> · Your call</span>}
                    {right && !picked && <span className={lab.tag}> · Answer</span>}
                  </button>
                );
              })}
            </fieldset>
            <div ref={result} tabIndex={-1} aria-live="polite" className={lab.explain}>
              {answer && (
                <>
                  <p className={correct ? styles.ok : lab.miss}>{correct ? "Right." : `Not quite: it was ${CHOICES.find((c) => c.value === s.outcome)?.label.toLowerCase()}.`}</p>
                  <p>{OUTCOME_EXPLAINED[s.outcome]}</p>
                </>
              )}
            </div>
            <div className={styles.actions}>
              <Button variant={answer ? "primary" : "secondary"} onClick={draw} loading={phase === "drawing"}>Draw another</Button>
              {correct && record !== "done" && (
                <span className={lab.optional}>
                  <span className={styles.badge}>Optional</span>
                  <Button variant="secondary" onClick={save} loading={record === "busy"}>Record it publicly</Button>
                </span>
              )}
            </div>
            {correct && record !== "done" && (
              <p className={styles.hint}>
                Optional. Adds &ldquo;Read the line&rdquo; to a public SOAR profile tied to this wallet. It is a badge only: no rate, limit, or
                priority anywhere in LegitShark depends on it.
              </p>
            )}
            {record === "done" && <p className={styles.ok}>Recorded on SOAR for <span className={styles.mono}>{signer.publicKey.toBase58().slice(0, 4)}…{signer.publicKey.toBase58().slice(-4)}</span>.</p>}
          </div>
        </section>
      )}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </div>
  );
}
