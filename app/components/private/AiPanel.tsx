"use client";

import type { Connection, PublicKey } from "@solana/web3.js";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import type { LoanSigner } from "@/lib/keypair-wallet";
import { AI_TASK_LABEL, type AiRequestRecord, type AiTask } from "@/lib/private/ai-codec";
import { aiInfo, askCopilot, buildExcerpt, type AiInfo } from "@/lib/private/ai";
import type { LoanTerms } from "@/lib/private/loan-codec";
import styles from "./private.module.css";

type Props = {
  signer: LoanSigner;
  base: Connection;
  er: Connection;
  room: PublicKey;
  loans: { anchor: PublicKey; terms: LoanTerms }[];
  /** Lender only: apply a proposal as a new draft (still needs its own signature). */
  onUseProposal?: (p: NonNullable<AiRequestRecord["result"]>["proposal"]) => void;
};

/** Explain, compare, and propose. Never executes; every change still needs the wallet. */
export function AiPanel({ signer, base, er, room, loans, onUseProposal }: Props) {
  const [info, setInfo] = useState<AiInfo | null>(null);
  const [task, setTask] = useState<AiTask>("explainLoan");
  const [userText, setUserText] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<AiRequestRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => void aiInfo().then(setInfo).catch(() => setInfo(null)), []);

  const me = signer.publicKey;
  const mine = loans.filter((l) => l.terms.lender.equals(me) || l.terms.borrower.equals(me));
  const tasks: AiTask[] = [
    ...(mine.length ? (["explainLoan"] as AiTask[]) : []),
    ...(mine.filter((l) => l.terms.borrower.equals(me)).length > 1 ? (["compare"] as AiTask[]) : []),
    "draft",
    ...(mine.some((l) => l.terms.status === "draft") ? (["counter"] as AiTask[]) : []),
    "explainError",
  ];
  const subject = task === "compare" ? mine.filter((l) => l.terms.borrower.equals(me)) : mine.slice(0, 1);
  const excerpt = useMemo(() => buildExcerpt(task, subject.map((l) => l.terms), userText), [task, subject, userText]);
  const bound = task === "explainLoan" || task === "counter" ? subject[0] : null;
  const needsText = task === "draft" || task === "explainError";

  if (!info?.configured) {
    return (
      <section className={styles.panel}>
        <header className={styles.panelHead}>
          <h2>Copilot</h2>
        </header>
        <p className={`${styles.panelBody} ${styles.muted}`}>The AI copilot is turned off on this deployment.</p>
      </section>
    );
  }

  async function run() {
    setBusy(true);
    setError(null);
    setAnswer(null);
    try {
      setAnswer(
        await askCopilot(base, er, signer, room, task, excerpt, info!.model, bound ? { anchor: bound.anchor, revision: bound.terms.revision } : null),
      );
      setReviewing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="ai-h">
      <header className={styles.panelHead}>
        <h2 id="ai-h">Copilot</h2>
        <span className={styles.badge}>Explains and proposes, never acts</span>
      </header>
      <div className={styles.panelBody}>
        <div className={styles.roleChoice} role="radiogroup" aria-label="What to ask">
          {tasks.map((t) => (
            <button type="button" key={t} role="radio" aria-checked={task === t} onClick={() => (setTask(t), setReviewing(false), setAnswer(null))}>
              {AI_TASK_LABEL[t]}
            </button>
          ))}
        </div>
        {needsText && (
          <>
            <label htmlFor="ai-text" className={styles.fieldLabel}>
              {task === "draft" ? "Describe the loan you want" : "Paste the error you saw"}
            </label>
            <textarea id="ai-text" className={styles.textarea} rows={3} maxLength={400} value={userText} onChange={(e) => setUserText(e.target.value)} />
          </>
        )}
        {!reviewing ? (
          <Button variant="secondary" onClick={() => setReviewing(true)} disabled={needsText && !userText.trim()}>
            Review what will be shared
          </Button>
        ) : (
          <div className={styles.disclosure}>
            <p className={styles.fieldLabel}>
              This exact text goes to <strong>{info.model}</strong> through {info.provider}. Nothing else does.
            </p>
            <pre className={styles.excerpt}>{excerpt}</pre>
            <p className={styles.hint}>
              No wallet addresses are included, but exact amounts and dates can still identify a deal. Your wallet signs an approval bound to this text
              {bound ? ` and revision ${bound.terms.revision}` : ""}.
            </p>
            <div className={styles.actions}>
              <Button onClick={run} loading={busy}>
                Approve and ask
              </Button>
              <Button variant="ghost" onClick={() => setReviewing(false)}>
                Back
              </Button>
            </div>
          </div>
        )}
        {answer?.result && (
          <div className={styles.answer} data-stale={answer.stale || undefined}>
            {answer.stale && <p className={styles.staleNote}>The terms changed after you asked. This answer is about an older revision.</p>}
            <p>{answer.result.text}</p>
            {answer.result.proposal && (
              <>
                <dl className={styles.summary}>
                  <div>
                    <dt>Lend</dt>
                    <dd className="num">{answer.result.proposal.principalUsdc} USDC</dd>
                  </div>
                  <div>
                    <dt>Interest</dt>
                    <dd className="num">{answer.result.proposal.interestPercent}%</dd>
                  </div>
                  <div>
                    <dt>Term</dt>
                    <dd className="num">{answer.result.proposal.durationDays} days</dd>
                  </div>
                  <div>
                    <dt>Collateral</dt>
                    <dd className="num">{answer.result.proposal.collateralWsol} wSOL</dd>
                  </div>
                </dl>
                {onUseProposal && !answer.stale && (
                  <Button variant="secondary" onClick={() => onUseProposal(answer.result!.proposal)}>
                    Use as a draft
                  </Button>
                )}
              </>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
