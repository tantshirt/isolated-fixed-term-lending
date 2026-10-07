"use client";

import { PublicKey } from "@solana/web3.js";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Spot } from "@/components/brand/Spot";
import { Button } from "@/components/ui/Button";
import { formatDeadline, formatUsdc, shortKey } from "@/lib/format";
import { pollAfterCompletion } from "@/lib/private/poll";
import { usePrivate } from "@/lib/private/use-private";
import { DESK_ROLE, REPAYMENT_MODE, hasRole, type DeskPolicyV2 } from "@/lib/private/v2-codec";
import { DEFAULT_POLICY, DESK_ROLE_WORDS, deskLoanRow, deskOverview, policyAmounts, policyDraftProblem, policyRows, roleNames, type DeskLoanRow, type PolicyDraft } from "@/lib/private/desk-view";
import { deskRef, finishDesk, publishPolicy, readDesk, rememberDesk, setDeskMember, type DeskRead } from "@/lib/private/v2-desks";
import { PRIVATE_V2_LIVE } from "@/lib/private/v2-codec";
import { TeeCard } from "../TeeCard";
import { DeskPilotShare } from "./DeskPilotShare";
import shared from "../private.module.css";
import s from "./Desk.module.css";

const TABS = ["Overview", "Loans", "Policy", "People"] as const;
type Tab = (typeof TABS)[number];

const STATUS_WORDS: Record<string, string> = {
  draft: "Draft",
  funded: "Offer waiting for the borrower",
  active: "Waiting for repayment",
  repaid: "Repaid",
  cancelled: "Cancelled",
  liquidated: "Liquidated",
  overdueLiquidated: "Settled after grace",
  pricedRecovered: "Recovered at the market price",
  terminalClaimed: "Collateral claimed",
};

/**
 * One private desk (Story 23.2): Overview (urgent loans and pending signatures first), Loans (each
 * with the lender wallet that funded it), Policy and People. Everything is read through the TEE with
 * the viewer's own token, so an administrator sees the book but not loan terms they were not given.
 */
export function DeskWorkspace({ creator, deskId }: { creator: string; deskId: string }) {
  const { signer, base, er, status, error, connect } = usePrivate();
  const ref = useMemo(() => {
    try {
      return deskRef(creator, deskId);
    } catch {
      return null;
    }
  }, [creator, deskId]);
  const [data, setData] = useState<DeskRead | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("Overview");
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const sequence = useRef(0);
  const me = signer?.publicKey ?? null;

  const load = useCallback(async () => {
    const seq = ++sequence.current;
    if (!er || !ref || status !== "ready") return;
    try {
      const d = await readDesk(er, ref.anchor);
      if (seq !== sequence.current) return;
      setData(d);
      setNow(Math.floor(Date.now() / 1000));
      setReadError(null);
      if (d.access === "member" && me) rememberDesk(me.toBase58(), { creator, deskId });
    } catch (e) {
      if (seq !== sequence.current) return;
      setReadError(e instanceof Error ? e.message : "The desk could not be read.");
    }
  }, [er, ref, status, me, creator, deskId]);

  useEffect(() => {
    setData(null);
    const stop = pollAfterCompletion(load, 8000);
    const seqRef = sequence;
    return () => {
      stop();
      seqRef.current++;
    };
  }, [load]);

  if (!ref)
    return (
      <div className="page page-narrow">
        <Spot kind="notFound" size={120} />
        <p role="alert" className={shared.error}>
          That desk link is not valid.
        </p>
        <Link href="/devnet/private/desk">Back to your desks</Link>
      </div>
    );

  const member = data?.access === "member" ? data : null;
  const rows = member && me ? member.book.map((e) => deskLoanRow(e, me, now)) : [];
  const overview = member && me ? deskOverview(member.state, me, rows) : null;
  const isCreator = !!me && me.equals(ref.creator);

  // Access and the next action come first on every screen size.
  const nextAction = !PRIVATE_V2_LIVE
    ? "Private desks are not deployed on Devnet yet."
    : status !== "ready"
      ? "Sign in privately to open this desk."
      : readError
        ? "The desk could not be read. Nothing here is shown until it can be."
        : !data
          ? "Reading the desk…"
      : !member
        ? isCreator
          ? "Finish creating the desk's private member list."
          : "This wallet is not a member of this desk."
        : !member.policy
          ? overview?.canAdminister
            ? "Publish a policy before lenders can originate."
            : "Waiting for an administrator to publish a policy."
          : overview && overview.urgent.length > 0
            ? `${overview.urgent.length} ${overview.urgent.length === 1 ? "loan needs" : "loans need"} attention.`
            : overview && overview.pending.length > 0
              ? `${overview.pending.length} ${overview.pending.length === 1 ? "offer is" : "offers are"} waiting for a signature.`
              : "Nothing is waiting.";

  return (
    <div className="page">
      <header className={s.head}>
        <span className={shared.eyebrow}>Private desk</span>
        <h1>
          Desk <span className="mono">{shortKey(ref.anchor.toBase58())}</span>
        </h1>
        <p className={s.access}>
          <span>
            Your access: <strong>{overview ? (overview.myRoles.length ? overview.myRoles.map((r) => DESK_ROLE_WORDS[r]).join(", ") : "None") : status === "ready" ? (data ? "None" : "Reading…") : "Locked"}</strong>
          </span>
          {member && (
            <span>
              Policy: <strong>{member.state.policyVersion ? `version ${member.state.policyVersion}` : "none yet"}</strong>
            </span>
          )}
        </p>
        <p className={s.next} role="status">
          {nextAction}
        </p>
        {overview?.canAdminister && (
          <p className={s.access}>As an administrator you manage people and policy. You cannot spend a lender&rsquo;s money or read a loan unless it is shared with you.</p>
        )}
      </header>

      {status !== "ready" ? (
        <div style={{ marginTop: "1.5rem" }}>
          <TeeCard status={status} error={error} onConnect={connect} />
        </div>
      ) : readError ? (
        <p role="alert" className={shared.error}>
          {readError}
        </p>
      ) : !data ? (
        <p role="status">Reading the desk…</p>
      ) : !member ? (
        isCreator && signer && base && er ? <FinishDesk onDone={load} run={(lend) => finishDesk(base, er, signer, ref.anchor, lend)} /> : <p>Ask a desk administrator to add this wallet.</p>
      ) : (
        <>
          <Tabs tab={tab} onChange={setTab} />
          <div role="tabpanel" id={`desk-panel-${tab}`} aria-labelledby={`desk-tab-${tab}`} tabIndex={0}>
            {tab === "Overview" && overview && (
              <section className={s.section}>
                <h2>Needs attention</h2>
                <LoanList rows={overview.urgent} empty="No loan is past due or close to a deadline." />
                <h2>Waiting for a signature</h2>
                <LoanList rows={overview.pending} empty="No offer is waiting." />
                <dl className={s.dl}>
                  <div>
                    <dt>Loan-book total, loans you can read</dt>
                    <dd className="num">{formatUsdc(overview.bookTotal)} USDC outstanding</dd>
                  </div>
                  <div>
                    <dt>Loans running</dt>
                    <dd className="num">{overview.running}</dd>
                  </div>
                  <div>
                    <dt>Loans not shared with you</dt>
                    <dd className="num">{overview.notShared}</dd>
                  </div>
                </dl>
                {overview.canAdminister && member.policy && <DeskPilotShare deskId={ref.anchor.toBase58()} />}
              </section>
            )}
            {tab === "Loans" && (
              <section className={s.section}>
                <h2>Loan book</h2>
                <p className={s.empty}>Each loan is funded from one lender&rsquo;s own private balance. The desk holds no money; totals here are a loan-book total, not a shared treasury.</p>
                <LoanList rows={rows} empty="No loans yet. A desk lender proposes one from a private room." />
              </section>
            )}
            {tab === "Policy" && (
              <PolicyTab
                current={member.policy}
                history={member.history}
                canPublish={!!overview?.canAdminister}
                publish={signer && base && er ? (p) => publishPolicy(base, er, signer, ref.anchor, member.state.policyVersion + 1, p).then(load) : null}
              />
            )}
            {tab === "People" && (
              <PeopleTab
                members={member.state.members}
                me={me}
                canAdminister={!!overview?.canAdminister}
                setRoles={signer && base && er ? (who, roles) => setDeskMember(base, er, signer, ref.anchor, who, roles).then(load) : null}
              />
            )}
          </div>
        </>
      )}

      <p className={shared.hint} style={{ marginTop: "2rem" }}>
        <Link href="/devnet/private">Back to private workspace</Link>
      </p>
    </div>
  );
}

function Tabs({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const n =
      e.key === "ArrowRight" ? (i + 1) % TABS.length : e.key === "ArrowLeft" ? (i - 1 + TABS.length) % TABS.length : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : -1;
    if (n < 0) return;
    e.preventDefault();
    onChange(TABS[n]);
    refs.current[n]?.focus();
  };
  return (
    <div className={s.tabs} role="tablist" aria-label="Desk sections">
      {TABS.map((t, i) => (
        <button
          key={t}
          ref={(el) => {
            refs.current[i] = el;
          }}
          id={`desk-tab-${t}`}
          role="tab"
          aria-selected={tab === t}
          aria-controls={tab === t ? `desk-panel-${t}` : undefined}
          tabIndex={tab === t ? 0 : -1}
          className={s.tab}
          onClick={() => onChange(t)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {t}
        </button>
      ))}
    </div>
  );
}

function LoanList({ rows, empty }: { rows: DeskLoanRow[]; empty: string }) {
  if (rows.length === 0) return <p className={s.empty}>{empty}</p>;
  return (
    <ul className={s.list}>
      {rows.map((r) =>
        r.access === "not-shared" ? (
          <li key={r.seq} className={s.row}>
            <span className={s.rowMain}>
              <span>Loan {r.seq + 1}</span>
              <span className={`${s.rowMeta} mono`}>{shortKey(r.loan.toBase58())}</span>
            </span>
            <span className={s.figure}>Not shared with you</span>
          </li>
        ) : (
          <li key={r.seq} className={s.row} data-urgent={r.urgent || undefined}>
            <span className={s.rowMain}>
              <span>
                Loan {r.seq + 1}: {r.waiting ?? STATUS_WORDS[r.terms.status] ?? r.terms.status}
              </span>
              <span className={s.rowMeta}>
                {r.terms.status === "draft" ? "To be funded by " : "Funded by "}
                {r.mine ? "you" : <span className="mono">{shortKey(r.fundingWallet.toBase58())}</span>}
                {r.holder && (
                  <>
                    {" · now held by "}
                    <span className="mono">{shortKey(r.holder.toBase58())}</span>
                  </>
                )}
                {r.nextDeadline && (
                  <>
                    {" · "}
                    {r.nextDeadline.label} <span className="num">{formatDeadline(r.nextDeadline.at)}</span>
                  </>
                )}
              </span>
            </span>
            <span className={`${s.figure} num`}>{r.payoff !== null ? `${formatUsdc(r.payoff)} USDC owed now` : `${formatUsdc(r.terms.terms.principal)} USDC`}</span>
          </li>
        ),
      )}
    </ul>
  );
}

function FinishDesk({ run, onDone }: { run: (alsoLend: boolean) => Promise<unknown>; onDone: () => void }) {
  const [lend, setLend] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <section className={s.section} style={{ marginTop: "1.5rem" }}>
      <h2>Finish creating the desk</h2>
      <p className={s.empty}>The desk exists on Solana. Its member list is created inside ZenLo&rsquo;s private network.</p>
      <label className={s.check}>
        <input type="checkbox" checked={lend} onChange={(e) => setLend(e.target.checked)} /> I will also lend from this desk
      </label>
      <div className={s.actions}>
        <Button
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              await run(lend);
              onDone();
            } catch (e) {
              setErr(e instanceof Error ? e.message : "That did not work.");
            } finally {
              setBusy(false);
            }
          }}
        >
          Sign to create the member list
        </Button>
      </div>
      {err && (
        <p role="alert" className={shared.error}>
          {err}
        </p>
      )}
    </section>
  );
}

// ------------------------------------------------------------------------------- policy

const toBps = (pct: string) => Math.round(Number(pct || "0") * 100);
const toSeconds = (days: string) => Math.round(Number(days || "0") * 86_400);

function PolicyTab({ current, history, canPublish, publish }: { current: DeskPolicyV2 | null; history: DeskPolicyV2[]; canPublish: boolean; publish: ((p: PolicyDraft) => Promise<unknown>) | null }) {
  const [editing, setEditing] = useState(false);
  return (
    <section className={s.section}>
      <h2>{current ? `Policy version ${current.version}` : "No policy yet"}</h2>
      {current ? (
        <>
          <p className={s.empty}>Published {formatDeadline(current.publishedAt)}. Every loan answers to the version it was signed under; a published version never changes.</p>
          <dl className={s.dl}>
            {policyRows(current).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd className="num">{v}</dd>
              </div>
            ))}
          </dl>
          {current.auditors.length > 0 && (
            <ul className={s.list} aria-label="Auditors">
              {current.auditors.map((a) => (
                <li key={a.toBase58()} className="mono">
                  {a.toBase58()}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className={s.empty}>Lenders cannot originate under this desk until a policy is published.</p>
      )}
      {history.length > 1 && <p className={s.empty}>Earlier versions: {history.filter((h) => h.version !== current?.version).map((h) => h.version).join(", ")}.</p>}
      {canPublish && publish && !editing && (
        <div className={s.actions}>
          <Button variant="secondary" onClick={() => setEditing(true)}>
            {current ? "Publish a new version" : "Write the policy"}
          </Button>
        </div>
      )}
      {editing && publish && <PolicyForm start={current ?? { ...DEFAULT_POLICY, version: 0, publishedAt: 0 }} onCancel={() => setEditing(false)} publish={(p) => publish(p).then(() => setEditing(false))} />}
    </section>
  );
}

function PolicyForm({ start, publish, onCancel }: { start: PolicyDraft; publish: (p: PolicyDraft) => Promise<unknown>; onCancel: () => void }) {
  const [f, setF] = useState({
    minUsdc: String(Number(start.minPrincipal) / 1e6),
    maxUsdc: String(Number(start.maxPrincipal) / 1e6),
    minDays: String(start.minDurationSeconds / 86_400),
    maxDays: String(start.maxDurationSeconds / 86_400),
    ceiling: String(start.maxAnnualCeilingBps / 100),
    interest: String(start.maxInterestBps / 100),
    proRata: hasRole(start.repaymentModes, REPAYMENT_MODE.proRata),
    fullTerm: hasRole(start.repaymentModes, REPAYMENT_MODE.fullTerm),
    ltv: String(start.maxLtvBps / 100),
    liqLtv: String(start.maxLiquidationLtvBps / 100),
    graceDays: String(start.minGraceSeconds / 86_400),
    lateFee: String(start.maxLateFeeBps / 100),
    auditors: start.auditors.map((a) => a.toBase58()).join("\n"),
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string; checked?: boolean; type?: string } }) =>
    setF({ ...f, [k]: e.target.type === "checkbox" ? !!e.target.checked : e.target.value });

  const parsed = (): PolicyDraft | string => {
    const lines = f.auditors.split(/\s+/).filter(Boolean);
    const auditors: PublicKey[] = [];
    for (const l of lines) {
      try {
        auditors.push(new PublicKey(l));
      } catch {
        return `${l.slice(0, 8)}… is not a wallet address.`;
      }
    }
    const amounts = policyAmounts(f.minUsdc, f.maxUsdc);
    if (typeof amounts === "string") return amounts;
    const p: PolicyDraft = {
      ...amounts,
      minDurationSeconds: toSeconds(f.minDays),
      maxDurationSeconds: toSeconds(f.maxDays),
      maxAnnualCeilingBps: toBps(f.ceiling),
      maxInterestBps: toBps(f.interest),
      repaymentModes: (f.proRata ? REPAYMENT_MODE.proRata : 0) | (f.fullTerm ? REPAYMENT_MODE.fullTerm : 0),
      maxLtvBps: toBps(f.ltv),
      maxLiquidationLtvBps: toBps(f.liqLtv),
      minGraceSeconds: toSeconds(f.graceDays),
      maxLateFeeBps: toBps(f.lateFee),
      auditors,
    };
    return policyDraftProblem(p) ?? p;
  };
  const result = parsed();
  const problem = typeof result === "string" ? result : null;

  const field = (k: keyof typeof f, label: string, unit: string) => (
    <label>
      {label} ({unit})
      <input className={`${shared.input} num`} inputMode="decimal" value={f[k] as string} onChange={set(k)} />
    </label>
  );

  return (
    <form
      className={s.form}
      onSubmit={async (e) => {
        e.preventDefault();
        if (typeof result === "string") return;
        setBusy(true);
        setErr(null);
        try {
          await publish(result);
        } catch (x) {
          setErr(x instanceof Error ? x.message : "That did not work.");
        } finally {
          setBusy(false);
        }
      }}
    >
      {field("minUsdc", "Smallest loan", "USDC")}
      {field("maxUsdc", "Largest loan", "USDC")}
      {field("minDays", "Shortest term", "days")}
      {field("maxDays", "Longest term", "days")}
      {field("ceiling", "Annual pricing ceiling", "% a year")}
      {field("interest", "Interest for the term, at most", "%")}
      {field("ltv", "Starting LTV, at most", "%")}
      {field("liqLtv", "Liquidation LTV, at most", "%")}
      {field("graceDays", "Grace after the due date, at least", "days")}
      {field("lateFee", "Late fee, at most", "% of unpaid principal")}
      <fieldset className={s.wide}>
        <legend>Early repayment the desk allows</legend>
        <label className={s.check}>
          <input type="checkbox" checked={f.proRata} onChange={set("proRata")} /> Interest for days used
        </label>
        <label className={s.check}>
          <input type="checkbox" checked={f.fullTerm} onChange={set("fullTerm")} /> Full-term interest
        </label>
      </fieldset>
      <label className={s.wide}>
        Auditors (up to 4 wallet addresses, one per line)
        <textarea className={`${shared.input} mono`} rows={3} value={f.auditors} onChange={set("auditors")} />
        <span className={shared.hint}>Auditors can read a loan only after its borrower accepts this list at signing.</span>
      </label>
      {(problem || err) && (
        <p role="alert" className={`${shared.error} ${s.wide}`}>
          {problem ?? err}
        </p>
      )}
      <div className={`${s.actions} ${s.wide}`}>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" loading={busy} disabled={!!problem}>
          Publish this version
        </Button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------------------------- people

function PeopleTab({ members, me, canAdminister, setRoles }: { members: { pubkey: PublicKey; roles: number }[]; me: PublicKey | null; canAdminister: boolean; setRoles: ((who: PublicKey, roles: number) => Promise<unknown>) | null }) {
  const [addr, setAddr] = useState("");
  const [roles, setRolesDraft] = useState<number>(DESK_ROLE.lender);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const act = async (key: string, f: () => Promise<unknown>) => {
    setBusy(key);
    setErr(null);
    try {
      await f();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "That did not work.");
    } finally {
      setBusy(null);
    }
  };
  let target: PublicKey | null = null;
  try {
    target = addr.trim() ? new PublicKey(addr.trim()) : null;
  } catch {}
  const toggle = (r: number) => setRolesDraft((x) => x ^ r);
  return (
    <section className={s.section}>
      <h2>People</h2>
      <p className={s.empty}>Administrators manage people and policy. Being an administrator gives no access to any loan and no way to spend a lender&rsquo;s money.</p>
      <ul className={s.list}>
        {members.map((m) => (
          <li key={m.pubkey.toBase58()} className={s.row}>
            <span className={s.rowMain}>
              <span className="mono">{me?.equals(m.pubkey) ? "You" : shortKey(m.pubkey.toBase58())}</span>
              <span className={s.rowMeta}>{roleNames(m.roles).map((r) => DESK_ROLE_WORDS[r]).join(", ")}</span>
            </span>
            {canAdminister && setRoles && (
              <Button
                variant="ghost"
                aria-label={me?.equals(m.pubkey) ? "Leave this desk" : `Remove ${shortKey(m.pubkey.toBase58())} from the desk`}
                loading={busy === m.pubkey.toBase58()}
                onClick={() => {
                  if (window.confirm(me?.equals(m.pubkey) ? "Leave this desk?" : `Remove ${shortKey(m.pubkey.toBase58())} from the desk?`)) act(m.pubkey.toBase58(), () => setRoles(m.pubkey, 0));
                }}
              >
                {me?.equals(m.pubkey) ? "Leave desk" : "Remove"}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {canAdminister && setRoles && (
        <div className={s.form}>
          <label className={s.wide}>
            Wallet to add or change
            <input className={`${shared.input} mono`} value={addr} onChange={(e) => setAddr(e.target.value)} aria-invalid={!!addr.trim() && !target} />
          </label>
          <fieldset className={s.wide}>
            <legend>Roles</legend>
            {(Object.keys(DESK_ROLE) as (keyof typeof DESK_ROLE)[]).map((r) => (
              <label key={r} className={s.check}>
                <input type="checkbox" checked={hasRole(roles, DESK_ROLE[r])} onChange={() => toggle(DESK_ROLE[r])} /> {DESK_ROLE_WORDS[r]}
              </label>
            ))}
          </fieldset>
          <div className={`${s.actions} ${s.wide}`}>
            <Button disabled={!target || roles === 0} loading={busy === "add"} onClick={() => target && act("add", () => setRoles(target!, roles))}>
              Save roles
            </Button>
          </div>
        </div>
      )}
      {err && (
        <p role="alert" className={shared.error}>
          {err}
        </p>
      )}
    </section>
  );
}
