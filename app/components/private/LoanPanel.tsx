"use client";

import type { Connection, PublicKey } from "@solana/web3.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AmountInput } from "@/components/ui/AmountInput";
import { Button } from "@/components/ui/Button";
import { usePrice } from "@/lib/client/hooks";
import type { LoanSigner } from "@/lib/keypair-wallet";
import { collateralValueUsdc, currentLtvBps, debt } from "@/lib/loan-math";
import { LOAN_STATUS_LABEL, type LoanTerms } from "@/lib/private/loan-codec";
import {
  LOAN_MESSAGE_PREFIX,
  acceptLoan,
  cancelLoan,
  claimLoan,
  explainLoanError,
  fundLoan,
  loanFromId,
  proposeLoan,
  readLoan,
  repayLoan,
} from "@/lib/private/loans";
import type { RoomMember } from "@/lib/private/room-codec";
import { publishReceipt, readReceipt, scheduleWatch, watchStatus } from "@/lib/private/liquidation";
import { utils } from "@coral-xyz/anchor";
import { postMessage } from "@/lib/private/rooms";
import styles from "./private.module.css";

const usdc = (a: bigint) => (Number(a) / 1e6).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const wsol = (a: bigint) => (Number(a) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 9 });
const short = (k: PublicKey) => `${k.toBase58().slice(0, 4)}…${k.toBase58().slice(-4)}`;

const DURATIONS = [
  { label: "1 day", seconds: 86_400 },
  { label: "7 days", seconds: 604_800 },
  { label: "30 days", seconds: 2_592_000 },
  { label: "2 minutes (try expiry)", seconds: 120 },
];

export type Prefill = { principalUsdc: number; interestPercent: number; durationDays: number; collateralWsol: number };

type Ctx = {
  signer: LoanSigner;
  base: Connection;
  er: Connection;
  room: PublicKey;
  members: RoomMember[];
  loanIds: string[];
  loans: { anchor: PublicKey; terms: LoanTerms }[];
  prefill?: Prefill | null;
  onChange: () => void;
};

/** Borrower's side-by-side view of offers they can read. Competing lenders never see this. */
function Compare({ loans, me }: { loans: Ctx["loans"]; me: PublicKey }) {
  const { price } = usePrice();
  const open = loans.filter((l) => l.terms.borrower.equals(me) && (l.terms.status === "funded" || l.terms.status === "draft"));
  if (open.length < 2) return null;
  const rows = open.map((l, i) => {
    const owed = debt(l.terms.principal, l.terms.interestBps);
    const ltv = price ? currentLtvBps(owed, collateralValueUsdc(l.terms.collateralAmount, price.price, price.conf, price.exponent)) : null;
    return { i, l, owed, ltv };
  });
  const cheapest = Math.min(...rows.map((r) => Number(r.owed - r.l.terms.principal)));
  return (
    <div>
      <p className="visually-hidden" id="compare-h">
        Compare offers
      </p>
      <table className={styles.compare} aria-labelledby="compare-h">
        <thead>
          <tr>
            <th scope="col">Offer</th>
            {rows.map((r) => (
              <th scope="col" key={r.i}>
                {r.i + 1} · {r.l.terms.status === "funded" ? "funded" : "draft"}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">You receive</th>
            {rows.map((r) => (
              <td key={r.i} className="num">{usdc(r.l.terms.principal)}</td>
            ))}
          </tr>
          <tr>
            <th scope="row">You repay</th>
            {rows.map((r) => (
              <td key={r.i} className={`num ${Number(r.owed - r.l.terms.principal) === cheapest ? styles.compareBest : ""}`}>{usdc(r.owed)}</td>
            ))}
          </tr>
          <tr>
            <th scope="row">You lock</th>
            {rows.map((r) => (
              <td key={r.i} className="num">{wsol(r.l.terms.collateralAmount)} wSOL</td>
            ))}
          </tr>
          <tr>
            <th scope="row">Term</th>
            {rows.map((r) => (
              <td key={r.i} className="num">{(r.l.terms.durationSeconds / 86_400).toFixed(r.l.terms.durationSeconds < 86_400 ? 2 : 0)} days</td>
            ))}
          </tr>
          <tr>
            <th scope="row">LTV now / line</th>
            {rows.map((r) => (
              <td key={r.i} className="num">
                {r.ltv === null ? "—" : `${(r.ltv / 100).toFixed(0)}%`} / {r.l.terms.liquidationLtvBps / 100}%
              </td>
            ))}
          </tr>
        </tbody>
      </table>
      <p className={styles.hint}>Accepting one offer locks the others out; their lenders can cancel and get their USDC back.</p>
    </div>
  );
}

export function LoanPanel(ctx: Ctx) {
  const [proposing, setProposing] = useState(false);
  useEffect(() => {
    if (ctx.prefill) setProposing(true);
  }, [ctx.prefill]);
  const me = ctx.signer.publicKey;
  const counterparties = ctx.members.filter((m) => !m.pubkey.equals(me) && (m.role === "borrower" || m.owner));
  return (
    <section className={styles.panel} aria-labelledby="loans-h">
      <header className={styles.panelHead}>
        <h2 id="loans-h">Loans in this room</h2>
        <span className={styles.badge}>Lender and borrower only</span>
      </header>
      <div className={styles.panelBody}>
        {ctx.loanIds.length === 0 && !proposing && (
          <p className={styles.muted}>No loan yet. A lender proposes exact terms; only the lender and that borrower can read them.</p>
        )}
        <Compare loans={ctx.loans} me={me} />
        {ctx.loanIds.map((id) => (
          <LoanCard key={id} id={id} {...ctx} />
        ))}
        {proposing ? (
          <ProposeForm {...ctx} counterparties={counterparties} onDone={() => (setProposing(false), ctx.onChange())} />
        ) : counterparties.length ? (
          <Button variant="secondary" onClick={() => setProposing(true)}>
            Propose a loan as lender
          </Button>
        ) : (
          <p className={styles.hint}>Invite a borrower to propose a loan.</p>
        )}
      </div>
    </section>
  );
}

function ProposeForm({ signer, base, er, room, counterparties, prefill, onDone }: Ctx & { counterparties: RoomMember[]; onDone: () => void }) {
  const { price } = usePrice();
  const [borrower, setBorrower] = useState(counterparties[0]?.pubkey.toBase58() ?? "");
  const [principal, setPrincipal] = useState(prefill ? String(prefill.principalUsdc) : "0.10");
  const [rate, setRate] = useState(prefill ? String(prefill.interestPercent) : "5");
  const [duration, setDuration] = useState(prefill ? Math.max(60, Math.round(prefill.durationDays * 86_400)) : DURATIONS[1].seconds);
  const [collateral, setCollateral] = useState(prefill ? String(prefill.collateralWsol) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const valid = p > 0n && bps >= 0 && bps <= 2000 && c > 0n && ltv !== null && ltv <= 7000 && borrower;

  async function submit() {
    if (!valid) return;
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
        maxLtvBps: 7000,
        liquidationLtvBps: 8000,
      });
      await postMessage(base, er, signer, room, `${LOAN_MESSAGE_PREFIX}${loanId}`);
      onDone();
    } catch (e) {
      setError(explainLoanError(e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.propose} onSubmit={(e) => (e.preventDefault(), void submit())}>
      <label htmlFor="borrower">Borrower</label>
      <select id="borrower" className={styles.input} value={borrower} onChange={(e) => setBorrower(e.target.value)}>
        {counterparties.map((m) => (
          <option key={m.pubkey.toBase58()} value={m.pubkey.toBase58()}>
            {short(m.pubkey)} · {m.owner ? "owner" : m.role}
          </option>
        ))}
      </select>
      <AmountInput label="You lend" value={principal} onChange={setPrincipal} unit="USDC" decimals={6} />
      <AmountInput label="Interest for the whole term" value={rate} onChange={setRate} unit="%" decimals={2} hint="Charged in full, even if repaid early." />
      <div className={styles.roleChoice} role="group" aria-label="Term">
        {DURATIONS.map((d) => (
          <button type="button" key={d.seconds} aria-pressed={duration === d.seconds} onClick={() => setDuration(d.seconds)}>
            {d.label}
          </button>
        ))}
      </div>
      <AmountInput label="Borrower locks" value={collateral} onChange={setCollateral} unit="wSOL" decimals={9} />
      <dl className={styles.summary}>
        <div>
          <dt>Borrower receives</dt>
          <dd className="num">{usdc(p)} USDC</dd>
        </div>
        <div>
          <dt>Borrower repays</dt>
          <dd className="num">{usdc(owed)} USDC</dd>
        </div>
        <div>
          <dt>LTV at today&apos;s price</dt>
          <dd className="num">{ltv === null ? "—" : `${(ltv / 100).toFixed(1)}%`}</dd>
        </div>
      </dl>
      <p className={styles.hint}>Maximum LTV 70%; liquidation line 80%. If the borrower does not repay by the deadline, the lender receives the wSOL.</p>
      <Button type="submit" loading={busy} disabled={!valid}>
        Propose these terms
      </Button>
      <p className={styles.hint}>Two signatures: one sets up the loan&apos;s private custody on Solana (about 0.017 SOL of rent), one writes the terms privately.</p>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </form>
  );
}

function LoanCard({ id, signer, base, er, room, onChange }: Ctx & { id: string }) {
  const anchor = useMemo(() => loanFromId(id), [id]);
  const [t, setT] = useState<LoanTerms | null | "hidden">(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now() / 1000);

  const loanIdBytes = useMemo(() => utils.bytes.bs58.decode(id), [id]);
  const [watch, setWatch] = useState<Awaited<ReturnType<typeof watchStatus>> | null>(null);
  const [receipt, setReceipt] = useState<Awaited<ReturnType<typeof readReceipt>>>(null);
  const load = useCallback(async () => {
    const terms = await readLoan(er, anchor);
    setT(terms ?? "hidden");
    if (terms?.status === "active" || terms?.status === "repaid" || terms?.status === "expired") setWatch(await watchStatus(er, anchor, loanIdBytes));
    if (terms && !["draft", "funded", "active"].includes(terms.status)) setReceipt(await readReceipt(base, anchor));
  }, [er, base, anchor, loanIdBytes]);
  useEffect(() => {
    void load();
    const i = setInterval(() => (setNow(Date.now() / 1000), void load()), 5000);
    return () => clearInterval(i);
  }, [load]);

  if (t === null) return <p className={styles.muted}>Loading a loan…</p>;
  if (t === "hidden") return <p className={styles.muted}>A loan between other members of this room. Its terms are private to them.</p>;

  const me = signer.publicKey;
  const isLender = t.lender.equals(me);
  const isBorrower = t.borrower.equals(me);
  const owed = debt(t.principal, t.interestBps);
  const expired = t.status === "active" && now >= t.expiryTs;

  async function act(label: string, f: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try {
      await f();
      await load();
      onChange();
    } catch (e) {
      setError(explainLoanError(e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className={styles.loanCard} data-status={t.status}>
      <header className={styles.loanHead}>
        <span className={styles.loanStatus}>{expired ? "Expired, waiting to be claimed" : LOAN_STATUS_LABEL[t.status]}</span>
        <span className={styles.hint}>Revision {t.revision}</span>
      </header>
      <dl className={styles.summary}>
        <div>
          <dt>Borrower receives</dt>
          <dd className="num">{usdc(t.principal)} USDC</dd>
        </div>
        <div>
          <dt>Borrower repays</dt>
          <dd className="num">{usdc(owed)} USDC</dd>
        </div>
        <div>
          <dt>Collateral</dt>
          <dd className="num">{wsol(t.collateralAmount)} wSOL</dd>
        </div>
        <div>
          <dt>{t.status === "active" ? "Deadline" : "Term"}</dt>
          <dd className="num">
            {t.status === "active" ? new Date(t.expiryTs * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : `${Math.round(t.durationSeconds / 3600) || "<1"} h`}
          </dd>
        </div>
      </dl>
      <p className={styles.hint}>
        {isLender ? "You are the lender." : isBorrower ? "You are the borrower." : "You can see this loan."}{" "}
        {t.status === "active" && !expired && "If you do not repay by then, the lender receives your wSOL."}
      </p>
      {t.status === "active" && watch && (
        <p className={watch.quote?.state === "open" ? styles.error : styles.hint}>
          {watch.quote?.state === "open"
            ? `Past the liquidation line. A public quote asks liquidators for ${usdc(watch.quote.debt)} USDC; repay now to keep your wSOL.`
            : watch.watching
              ? "Automatic checks are on: expiry and liquidation settle without anyone pressing a button."
              : "Automatic checks are off for this loan."}
        </p>
      )}
      {t.status === "active" && watch && !watch.watching && (
        <Button variant="ghost" onClick={() => act("watch", () => scheduleWatch(base, er, signer, anchor, loanIdBytes))} loading={busy === "watch"}>
          Turn on automatic checks
        </Button>
      )}
      {receipt && (
        <p className={styles.hint}>
          {receipt.published
            ? `Settlement receipt on Solana: outcome recorded with commitment ${receipt.commitment.slice(0, 12)}…, no terms.`
            : "Settled privately. You can publish a minimal receipt to Solana: the outcome and an opaque commitment, never the terms."}
        </p>
      )}
      {receipt && !receipt.published && (
        <Button variant="ghost" onClick={() => act("receipt", () => publishReceipt(base, er, signer, anchor))} loading={busy === "receipt"}>
          Publish settlement receipt
        </Button>
      )}
      <div className={styles.actions}>
        {isLender && t.status === "draft" && (
          <Button onClick={() => act("fund", () => fundLoan(base, er, signer, anchor, t.revision))} loading={busy === "fund"}>
            Lock USDC
          </Button>
        )}
        {isLender && (t.status === "draft" || t.status === "funded") && (
          <Button variant="secondary" onClick={() => act("cancel", () => cancelLoan(base, er, signer, anchor))} loading={busy === "cancel"}>
            Cancel offer
          </Button>
        )}
        {isBorrower && t.status === "funded" && (
          <Button
            onClick={() =>
              act("accept", async () => {
                await acceptLoan(base, er, signer, anchor, t, room);
                await scheduleWatch(base, er, signer, anchor, loanIdBytes).catch(() => null);
              })
            }
            loading={busy === "accept"}
          >
            Lock wSOL and borrow
          </Button>
        )}
        {isBorrower && t.status === "active" && !expired && (
          <Button onClick={() => act("repay", () => repayLoan(base, er, signer, anchor, t))} loading={busy === "repay"}>
            Repay {usdc(owed)} USDC
          </Button>
        )}
        {expired && (
          <Button onClick={() => act("claim", () => claimLoan(base, er, signer, anchor, t))} loading={busy === "claim"}>
            Claim collateral for the lender
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </article>
  );
}
