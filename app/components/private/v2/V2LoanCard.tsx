"use client";

import { PublicKey, type Connection } from "@solana/web3.js";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import type { LoanSigner } from "@/lib/keypair-wallet";
import { formatBpsAsPercent, formatDeadline, formatUsdc, formatWsol, shortKey } from "@/lib/format";
import { EarlyRepayment } from "@/lib/loan-math-v2";
import type { RoomMessage } from "@/lib/private/room-codec";
import { auditorHash, type LoanTermsV2 } from "@/lib/private/v2-codec";
import { acceptV2, cancelV2, claimV2, fundV2, removeReaderV2, repayV2, shareAuditorsV2, topUpV2 } from "@/lib/private/v2-loans";
import { audienceFor, resolveAudience, fullPayoffAmount, sharedAuditors, v2LoanState, type Audience } from "@/lib/private/v2-room-view";
import { reviewFigures } from "@/lib/v2/rules";
import { RESALE_NOTICE } from "@/lib/v2/market";
import shared from "../private.module.css";
import s from "../desk/Desk.module.css";
import { REFINANCED_WORD } from "@/lib/phase-words";

const STATUS: Record<string, string> = {
  draft: "Draft offer",
  funded: "Offer ready to accept",
  active: "Waiting for repayment",
  repaid: "Repaid",
  cancelled: "Cancelled",
  liquidated: "Liquidated",
  overdueLiquidated: "Settled after grace",
  pricedRecovered: "Recovered at the market price",
  terminalClaimed: "Collateral claimed",
  refinanced: REFINANCED_WORD,
};

type Ctx = { base: Connection; er: Connection; signer: LoanSigner; room: PublicKey; onDone: () => void };

/**
 * One V2 private loan: the terms as signed, the V2 deadlines, the auditor audience the borrower
 * consents to, and only the actions this wallet may take next.
 */
export function V2LoanCard({ index, anchor, terms: t, messages, now, ctx }: { index: number; anchor: PublicKey; terms: LoanTermsV2; messages: RoomMessage[]; now: number; ctx: Ctx }) {
  const me = ctx.signer.publicKey;
  const state = v2LoanState(t, me, now);
  const f = reviewFigures(t.terms, t.status === "active" ? t.terms.startTs : now);
  const [audience, setAudience] = useState<Audience>(() => audienceFor(t, [], null));
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [usdc, setUsdc] = useState("");
  const [fullPayoff, setFullPayoff] = useState(false);
  const [wsol, setWsol] = useState("");
  const [consent, setConsent] = useState(false);

  const keys = sharedAuditors(messages, t);
  const keyList = keys.join(",");
  useEffect(() => {
    let live = true;
    const list = keyList ? keyList.split(",") : [];
    (async () => {
      const resolved = await resolveAudience(t, list, (keys) => auditorHash(keys.map((k) => new PublicKey(k))));
      if (live) {
        setAudience(resolved);
        setConsent(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [keyList, t]);

  const act = async (key: string, f: () => Promise<unknown>) => {
    setBusy(key);
    setErr(null);
    try {
      await f();
      setUsdc("");
      setFullPayoff(false);
      setWsol("");
      ctx.onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "That did not work.");
    } finally {
      setBusy(null);
    }
  };
  const fullAmount = fullPayoffAmount(t, now);
  const atoms = fullPayoff ? fullAmount : (() => {
    const [w, fr = ""] = usdc.trim().split(".");
    return /^\d+$/.test(w || "x") && /^\d{0,6}$/.test(fr) ? BigInt(w) * 1_000_000n + BigInt(fr.padEnd(6, "0")) : null;
  })();
  const lamports = (() => {
    const [w, fr = ""] = wsol.trim().split(".");
    return /^\d+$/.test(w || "x") && /^\d{0,9}$/.test(fr) ? BigInt(w) * 1_000_000_000n + BigInt(fr.padEnd(9, "0")) : null;
  })();
  const { base, er, signer, room } = ctx;

  return (
    <li className={s.row} style={{ gridTemplateColumns: "1fr" }}>
      <div className={s.rowMain}>
        <strong>
          Loan {index + 1}: {STATUS[t.status] ?? t.status}
          {t.desk && <> · desk policy v{t.policyVersion}</>}
        </strong>
        <span className={s.rowMeta}>
          {state.role === "reader" ? "You can read this loan." : `You are the ${state.role}.`} {state.next}
        </span>
      </div>

      <dl className={s.dl}>
        <div>
          <dt>Borrow</dt>
          <dd className="num">{formatUsdc(t.terms.principal)} USDC</dd>
        </div>
        <div>
          <dt>Interest for the term</dt>
          <dd className="num">
            {formatUsdc(f.termCost)} USDC ({formatBpsAsPercent(t.terms.interestBps)}, about {formatBpsAsPercent(f.annualizedBps)} a year)
          </dd>
        </div>
        <div>
          <dt>Repaying early</dt>
          <dd>{t.terms.earlyRepayment === EarlyRepayment.ProRata ? `Interest for days used, at least ${formatUsdc(f.minInterest)} USDC` : "Full-term interest"}</dd>
        </div>
        <div>
          <dt>{state.role === "borrower" ? "Most you could owe" : "Most the borrower could owe"}</dt>
          <dd className="num">
            {formatUsdc(f.maxExposure)} USDC (a limit set in ZenLo of {formatBpsAsPercent(f.ceilingBps)} a year, not a legal rate cap)
          </dd>
        </div>
        <div>
          <dt>Collateral</dt>
          <dd className="num">{formatWsol(t.status === "active" ? t.collateralLocked : t.collateralRequired)} wSOL</dd>
        </div>
        {t.status === "active" ? (
          <>
            {state.role === "borrower" && !t.currentLender.equals(t.originLender) && (
              <div>
                <dt>You now pay</dt>
                <dd>
                  Your lender sold this loan. Payments go to <span className="mono">{shortKey(t.currentLender.toBase58())}</span>.
                </dd>
              </div>
            )}
            <div>
              <dt>Due</dt>
              <dd className="num">{formatDeadline(f.maturity)}</dd>
            </div>
            <div>
              <dt>Grace ends (late fee {formatBpsAsPercent(t.terms.lateFeeBps)} of unpaid principal)</dt>
              <dd className="num">{formatDeadline(f.graceEnd)}</dd>
            </div>
            <div>
              <dt>Priced recovery from</dt>
              <dd className="num">{formatDeadline(f.pricedRecoveryFrom)}</dd>
            </div>
            <div>
              <dt>Final claim from</dt>
              <dd className="num">{formatDeadline(f.terminalClaimFrom)}</dd>
            </div>
            {state.payoff !== null && (
              <div>
                <dt>To repay in full now</dt>
                <dd className="num">{formatUsdc(state.payoff)} USDC</dd>
              </div>
            )}
          </>
        ) : (
          <>
            <div>
              <dt>Term</dt>
              <dd className="num">
                {Math.round(t.terms.duration / 86_400)} days, then {Math.round(t.terms.graceSeconds / 3600)} hours of grace
              </dd>
            </div>
            <div>
              <dt>Late fee, charged once after the deadline</dt>
              <dd className="num">
                {formatBpsAsPercent(t.terms.lateFeeBps)} of unpaid principal, at most {formatUsdc(f.lateFeeMax)} USDC
              </dd>
            </div>
            <div>
              <dt>Deadline, if accepted now</dt>
              <dd className="num">{formatDeadline(f.maturity)}</dd>
            </div>
            <div>
              <dt>Grace ends</dt>
              <dd className="num">{formatDeadline(f.graceEnd)}</dd>
            </div>
            <div>
              <dt>Priced recovery from</dt>
              <dd className="num">{formatDeadline(f.pricedRecoveryFrom)}</dd>
            </div>
            <div>
              <dt>Final claim from</dt>
              <dd className="num">{formatDeadline(f.terminalClaimFrom)}</dd>
            </div>
          </>
        )}
        <div>
          <dt>Who else can read this loan</dt>
          <dd>
            {audience.kind === "none" ? (
              "No one"
            ) : audience.kind === "named" ? (
              <>
                {audience.auditors.length} read-only auditor{audience.auditors.length === 1 ? "" : "s"}:{" "}
                {audience.auditors.map((a) => (
                  <span key={a} className="mono">
                    {shortKey(a)}{" "}
                  </span>
                ))}
              </>
            ) : (
              "Named auditors not yet shown in the room"
            )}
          </dd>
        </div>
      </dl>

      {state.actions.includes("accept") && (
        <div className={s.section}>
          <p>
            <strong>Repay any time before a settlement executes and you keep all your wSOL. After the final claim time, you can lose any surplus.</strong>
          </p>
          <p>{RESALE_NOTICE} The new holder can then read this loan in place of the lender.</p>
          {audience.kind === "unverified" ? (
            <p role="alert" className={shared.error}>
              This loan names auditors the room has not shown. Do not sign. Ask the lender to share the auditor list.
            </p>
          ) : (
            <label className={s.check}>
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              {audience.kind === "named"
                ? `I agree that ${audience.auditors.length === 1 ? "this auditor" : "these auditors"} can read this loan's terms and balances. Our chat and other offers stay private.`
                : "I have read these terms. Only the lender and I can read this loan."}
            </label>
          )}
          <div className={s.actions}>
            <Button
              disabled={audience.kind === "unverified" || !consent}
              loading={busy === "accept"}
              onClick={() =>
                act("accept", async () => {
                  const hash = audience.kind === "named" ? await auditorHash(audience.auditors.map((k) => new PublicKey(k))) : new Uint8Array(32);
                  return acceptV2(base, er, signer, room, anchor, t, hash);
                })
              }
            >
              Lock wSOL and borrow
            </Button>
          </div>
        </div>
      )}

      {(state.actions.includes("repay") || state.actions.includes("top-up")) && (
        <div className={s.form}>
          <label>
            Repay (USDC)
            <input className={`${shared.input} num`} inputMode="decimal" value={fullPayoff ? formatUsdc(fullAmount).replace(/,/g, "") : usdc} onChange={(e) => { setFullPayoff(false); setUsdc(e.target.value); }} />
          </label>
          <div className={s.actions}>
            {state.payoff !== null && (
              <Button variant="ghost" onClick={() => setFullPayoff(true)}>
                Fill full payoff
              </Button>
            )}
            <Button disabled={!atoms} loading={busy === "repay"} onClick={() => atoms && act("repay", () => repayV2(base, er, signer, anchor, t, atoms))}>
              Repay USDC
            </Button>
          </div>
          {fullPayoff && (
            <p className={`${shared.hint} ${s.wide}`}>
              This allows up to {formatUsdc(fullAmount)} USDC, including two minutes for signing. Only what is owed when it lands is taken. If signing takes longer, refresh the payoff before approving.
            </p>
          )}
          <label>
            Add collateral (wSOL)
            <input className={`${shared.input} num`} inputMode="decimal" value={wsol} onChange={(e) => setWsol(e.target.value)} />
          </label>
          <div className={s.actions}>
            <Button variant="secondary" disabled={!lamports} loading={busy === "top-up"} onClick={() => lamports && act("top-up", () => topUpV2(base, er, signer, anchor, t, lamports))}>
              Add wSOL
            </Button>
          </div>
          <p className={`${shared.hint} ${s.wide}`}>Payments go to interest first, then any late fee, then principal. Paying part keeps the same due date.</p>
        </div>
      )}

      <div className={s.actions}>
        {state.actions.includes("share-auditors") && (
          <Button variant="ghost" loading={busy === "share"} onClick={() => act("share", () => shareAuditorsV2(base, er, signer, room, t))}>
            Share the auditor list in the room
          </Button>
        )}
        {state.actions.includes("cancel") && (
          <Button variant="ghost" loading={busy === "cancel"} onClick={() => act("cancel", () => cancelV2(base, er, signer, anchor, t.status === "funded"))}>
            Cancel offer
          </Button>
        )}
        {state.actions.includes("fund") && (
          <Button loading={busy === "fund"} onClick={() => act("fund", () => fundV2(base, er, signer, anchor, t.revision))}>
            Lock {formatUsdc(t.terms.principal)} USDC
          </Button>
        )}
        {state.actions.includes("claim-priced") && (
          <Button variant="secondary" loading={busy === "priced"} onClick={() => act("priced", () => claimV2(base, er, signer, anchor, t, "priced"))}>
            Take collateral worth what is owed
          </Button>
        )}
        {state.actions.includes("claim-terminal") &&
          (confirming ? (
            <div className={s.section}>
              <p>
                Take all <span className="num">{formatWsol(t.collateralLocked)}</span> wSOL? Any surplus over the{" "}
                <span className="num">{formatUsdc(state.payoff ?? 0n)}</span> USDC owed goes to you, not the borrower.
              </p>
              <div className={s.actions}>
                <Button variant="ghost" onClick={() => setConfirming(false)}>
                  Not now
                </Button>
                <Button variant="danger" loading={busy === "terminal"} onClick={() => act("terminal", () => claimV2(base, er, signer, anchor, t, "terminal"))}>
                  Take all wSOL
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="secondary" onClick={() => setConfirming(true)}>
              Final claim: take all wSOL
            </Button>
          ))}
        {audience.kind === "named" && t.status === "active" && state.role !== "reader" && (
          <Button
            variant="ghost"
            loading={busy === "readers"}
            onClick={() => {
              if (window.confirm("Remove every auditor's access to this loan from now on?"))
                act("readers", async () => {
                  let current = audience.auditors.map((k) => new PublicKey(k));
                  while (current.length) {
                    await removeReaderV2(base, er, signer, anchor, current[0], current);
                    current = current.slice(1);
                  }
                });
            }}
          >
            Remove auditor access
          </Button>
        )}
      </div>
      {err && (
        <p role="alert" className={shared.error}>
          {err}
        </p>
      )}
    </li>
  );
}
