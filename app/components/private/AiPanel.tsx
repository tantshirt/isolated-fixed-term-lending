"use client";

import type { Connection, PublicKey } from "@solana/web3.js";
import { useCallback, useEffect, useState } from "react";
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
  const [selectedTask, setTask] = useState<AiTask>("draft");
  const [userText, setUserText] = useState("");
  const [reviewedText, setReviewedText] = useState<string | null>(null);
  const [selectedLoan, setSelectedLoan] = useState("");
  const [infoError, setInfoError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [answerText, setAnswerText] = useState<string | null>(null);
  const [answer, setAnswer] = useState<AiRequestRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadInfo = useCallback(async () => {
    setInfoError(null);
    try { setInfo(await aiInfo()); } catch { setInfoError("Copilot availability could not be checked. Try again."); }
  }, []);
  useEffect(() => { void loadInfo(); }, [loadInfo]);

  const me = signer.publicKey;
  const mine = loans.filter((l) => l.terms.lender.equals(me) || l.terms.borrower.equals(me));
  const offersToMe = mine.filter((l) => l.terms.borrower.equals(me) && ["draft", "funded"].includes(l.terms.status));
  const tasks: AiTask[] = [
    ...(mine.length ? (["explainLoan"] as AiTask[]) : []),
    ...(offersToMe.length > 1 ? (["compare"] as AiTask[]) : []),
    "draft",
    ...(mine.some((l) => l.terms.status === "draft") ? (["counter"] as AiTask[]) : []),
    "explainError",
  ];
  const task = tasks.includes(selectedTask) ? selectedTask : tasks[0];
  const candidates = task === "counter" ? mine.filter((l) => l.terms.status === "draft") : mine;
  const chosen = candidates.find((l) => l.anchor.toBase58() === selectedLoan) ?? candidates[0];
  const subject = task === "compare" ? offersToMe : chosen ? [chosen] : [];
  const excerpt = buildExcerpt(task, subject.map((l) => l.terms), userText);
  const bound = task === "explainLoan" || task === "counter" ? subject[0] : null;
  const needsText = task === "draft" || task === "explainError";

  const reviewing = reviewedText === excerpt;
  const staleAnswer = !!answer && (answer.stale || answerText !== excerpt || (!!answer.loan && !mine.some((l) => l.anchor.equals(answer.loan!) && l.terms.revision === answer.revision)));

  if (infoError || !info || !info.configured) {
    return (
      <section className={styles.panel}>
        <header className={styles.panelHead}>
          <h2>Copilot</h2>
        </header>
        <p className={`${styles.panelBody} ${styles.muted}`}>{infoError ?? (!info ? "Checking copilot availability…" : "The AI copilot is turned off on this deployment.")}</p>
        {infoError && <div className={styles.panelBody}><Button variant="secondary" onClick={() => void loadInfo()}>Retry copilot</Button></div>}
      </section>
    );
  }

  async function run() {
    if (!reviewing || busy) return;
    setBusy(true);
    setError(null);
    setAnswer(null);
    setAnswerText(excerpt);
    try {
      setAnswer(
        await askCopilot(base, er, signer, room, task, excerpt, info!.model, bound ? { anchor: bound.anchor, revision: bound.terms.revision } : null),
      );
      setReviewedText(null);
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
        <div className={styles.roleChoice} role="group" aria-label="What to ask">
          {tasks.map((t) => (
            <button type="button" key={t} aria-pressed={task === t} disabled={busy} onClick={() => (setTask(t), setReviewedText(null), setAnswer(null))}>
              {AI_TASK_LABEL[t]}
            </button>
          ))}
        </div>
        <p className={styles.hint}>{task === "draft" ? "Turn your description into a draft you can edit before proposing." : task === "compare" ? "Compare only offers addressed to your wallet. Other lenders’ terms stay private." : task === "counter" ? "Suggest a revision to a draft; no terms change until you review and sign." : task === "explainLoan" ? "Explain the selected loan’s cost, collateral and deadline." : "Explain an error and possible recovery steps; no action is performed."}</p>
        {(task === "explainLoan" || task === "counter") && candidates.length > 1 && <label className={styles.fieldLabel}>Loan to discuss<select className={styles.input} value={chosen?.anchor.toBase58() ?? ""} disabled={busy} onChange={(e) => { setSelectedLoan(e.target.value); setReviewedText(null); setAnswer(null); }}>{candidates.map((l) => <option key={l.anchor.toBase58()} value={l.anchor.toBase58()}>Loan {l.anchor.toBase58().slice(0, 6)} · revision {l.terms.revision}</option>)}</select></label>}
        {needsText && (
          <>
            <label htmlFor="ai-text" className={styles.fieldLabel}>
              {task === "draft" ? "Describe the loan you want" : "Paste the error you saw"}
            </label>
            <textarea id="ai-text" className={styles.textarea} disabled={busy} rows={3} maxLength={400} value={userText} onChange={(e) => setUserText(e.target.value)} />
          </>
        )}
        {!reviewing ? (
          <Button variant="secondary" onClick={() => setReviewedText(excerpt)} disabled={busy || (needsText && !userText.trim())}>
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
              <Button variant="ghost" onClick={() => setReviewedText(null)}>
                Back
              </Button>
            </div>
          </div>
        )}
        {answer?.result && (
          <div className={styles.answer} data-stale={staleAnswer || undefined}>
            {staleAnswer && <p className={styles.staleNote}>The terms or request changed after you asked. This answer refers to the earlier text and revision.</p>}
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
                {onUseProposal && !staleAnswer && (
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
