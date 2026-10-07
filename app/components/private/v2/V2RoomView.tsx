"use client";

import { PublicKey } from "@solana/web3.js";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { formatUsdc, shortKey } from "@/lib/format";
import { pollAfterCompletion } from "@/lib/private/poll";
import { MAX_BODY } from "@/lib/private/room-codec";
import { usePrivate } from "@/lib/private/use-private";
import { PRIVATE_V2_LIVE, ROLE_V2, hasRole } from "@/lib/private/v2-codec";
import { deskRef, savedDesks } from "@/lib/private/v2-desks";
import { finishRoomV2, inviteV2, postV2, proposeV2, readRoomV2, rememberRoomV2, revokeV2, roomV2Ref, type RoomV2Read } from "@/lib/private/v2-loans";
import { requestBody, requestsInThread, v2LoanState, type BorrowRequest } from "@/lib/private/v2-room-view";
import { TeeCard } from "../TeeCard";
import { V2LoanCard } from "./V2LoanCard";
import { V2ProposeForm } from "./V2ProposeForm";
import shared from "../private.module.css";
import s from "../desk/Desk.module.css";

const ROLE_WORDS: [keyof typeof ROLE_V2, string][] = [
  ["borrower", "Borrower"],
  ["lender", "Lender"],
  ["viewer", "Viewer"],
];
/** Requests and auditor notices are machine text; show them in words. */
function messageWords(body: string): string {
  const req = /^request (\S+) USDC for (\d+) days?$/.exec(body);
  if (req) return `Asked to borrow ${req[1]} USDC for ${req[2]} ${req[2] === "1" ? "day" : "days"}`;
  const aud = /^auditor (\d+) (\S+)$/.exec(body);
  if (aud) return `Shared auditor ${shortKey(aud[2])} for loan ${Number(aud[1]) + 1}`;
  return body;
}

const roleWords = (roles: number) => ROLE_WORDS.filter(([k]) => hasRole(roles, ROLE_V2[k])).map(([, w]) => w).join(", ") || "None";

/**
 * A private room with repayment rules (private_loan_v2): many loans per room, one accepted offer
 * per borrowing request, partial repayment, top-up, grace, and desk auditors shown before signing.
 */
export function V2RoomView({ creator, roomId }: { creator: string; roomId: string }) {
  const { signer, base, er, status, error, connect } = usePrivate();
  const ref = useMemo(() => {
    try {
      return roomV2Ref(creator, roomId);
    } catch {
      return null;
    }
  }, [creator, roomId]);
  const [data, setData] = useState<RoomV2Read | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [offerFor, setOfferFor] = useState<BorrowRequest | null>(null);
  const seq = useRef(0);
  const me = signer?.publicKey ?? null;

  const load = useCallback(async () => {
    const n = ++seq.current;
    if (!er || !ref || status !== "ready") return;
    try {
      const d = await readRoomV2(er, ref.anchor);
      if (n !== seq.current) return;
      setData(d);
      setNow(Math.floor(Date.now() / 1000));
      setReadError(null);
      if (d.access === "member" && me) rememberRoomV2(me.toBase58(), { creator, roomId });
    } catch (e) {
      if (n === seq.current) setReadError(e instanceof Error ? e.message : "The room could not be read.");
    }
  }, [er, ref, status, me, creator, roomId]);

  useEffect(() => {
    setData(null);
    const stop = pollAfterCompletion(load, 6000);
    const r = seq;
    return () => {
      stop();
      r.current++;
    };
  }, [load]);

  if (!ref)
    return (
      <div className="page page-narrow">
        <p role="alert" className={shared.error}>
          That room link is not valid.
        </p>
      </div>
    );

  const member = data?.access === "member" ? data : null;
  const myRoles = member && me ? member.state.members.find((m) => m.pubkey.equals(me))?.roles ?? 0 : 0;
  const isOwner = !!(member && me && member.state.owner.equals(me));
  const requests = member ? requestsInThread(member.messages) : [];
  const taken = new Set(member ? member.loans.filter((l) => l.terms && l.terms.status !== "cancelled" && l.terms.status !== "draft").map((l) => l.terms!.requestIndex) : []);
  const ctx = signer && base && er ? { base, er, signer, room: ref.anchor, onDone: load } : null;
  const isCreator = !!me && me.equals(ref.creator);

  const pending =
    member && me
      ? member.loans.map((l) => (l.terms ? v2LoanState(l.terms, me, now) : null)).find((st) => st && st.actions.some((a) => a !== "cancel" && a !== "share-auditors"))
      : null;
  const nextAction = !PRIVATE_V2_LIVE
    ? "Rooms with repayment rules are not deployed on Devnet yet."
    : status !== "ready"
      ? "Sign in privately to open this room."
      : readError
        ? "The room could not be read."
        : !data
          ? "Reading the room…"
          : !member
            ? isCreator
              ? "Finish creating the room's private member list."
              : "This wallet is not a member of this room."
            : pending
              ? pending.next
              : hasRole(myRoles, ROLE_V2.borrower) && requests.filter((r) => me && r.borrower.equals(me)).length === 0
              ? "Post a borrowing request so lenders can make offers."
              : hasRole(myRoles, ROLE_V2.lender) && requests.some((r) => !taken.has(r.index))
                ? "A borrowing request is open. Make an offer."
                : "Nothing is waiting for you.";

  return (
    <div className="page">
      <header className={s.head}>
        <span className={shared.eyebrow}>Private room · repayment rules</span>
        <h1>
          Room <span className="mono">{shortKey(ref.anchor.toBase58())}</span>
        </h1>
        <p className={s.access}>
          <span>
            Your access: <strong>{member ? roleWords(myRoles) : status !== "ready" ? "Locked" : readError ? "Not available" : data ? "None" : "Reading…"}</strong>
          </span>
        </p>
        <p className={s.next} role="status">
          {nextAction}
        </p>
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
        <p role="status">Reading the room…</p>
      ) : !member ? (
        isCreator && ctx ? (
          <FinishRoom run={(roles) => finishRoomV2(ctx.base, ctx.er, ctx.signer, ref.anchor, roles)} onDone={load} />
        ) : (
          <p>Ask the room owner to add this wallet.</p>
        )
      ) : (
        <div className={s.section} style={{ marginTop: "1.5rem" }}>
          <h2>Loans</h2>
          {member.loans.length === 0 ? (
            <p className={s.empty}>No offers yet.</p>
          ) : (
            <ul className={s.list}>
              {member.loans.map((l) =>
                l.terms && ctx ? (
                  <V2LoanCard key={l.index} index={l.index} anchor={l.anchor} terms={l.terms} messages={member.messages} now={now} ctx={ctx} />
                ) : (
                  <li key={l.index} className={s.row}>
                    <span>Loan {l.index + 1}</span>
                    <span className={s.figure}>Not shared with you</span>
                  </li>
                ),
              )}
            </ul>
          )}

          <h2>Borrowing requests</h2>
          {requests.length === 0 ? (
            <p className={s.empty}>No requests yet.</p>
          ) : (
            <ul className={s.list}>
              {requests.map((r) => (
                <li key={r.index} className={s.row}>
                  <span className={s.rowMain}>
                    <span>
                      Request {r.index + 1}: <span className="num">{formatUsdc(r.principal)} USDC</span> for <span className="num">{r.days}</span> days
                    </span>
                    <span className={s.rowMeta}>
                      From <span className="mono">{me?.equals(r.borrower) ? "you" : shortKey(r.borrower.toBase58())}</span>
                      {taken.has(r.index) ? " · has an offer" : ""}
                    </span>
                  </span>
                  {hasRole(myRoles, ROLE_V2.lender) && !taken.has(r.index) && !me?.equals(r.borrower) && (
                    <Button variant="secondary" onClick={() => setOfferFor(r)}>
                      Make an offer
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {offerFor && ctx && (
            <V2ProposeForm
              request={offerFor}
              desks={me ? savedDesks(me.toBase58()).map((d) => ({ anchor: deskRef(d.creator, d.deskId).anchor, label: `Desk ${shortKey(deskRef(d.creator, d.deskId).anchor.toBase58())}` })) : []}
              onCancel={() => setOfferFor(null)}
              propose={async (p, desk) => {
                await proposeV2(ctx.base, ctx.er, ctx.signer, ref.anchor, p, desk);
                setOfferFor(null);
                await load();
              }}
            />
          )}
          {hasRole(myRoles, ROLE_V2.borrower) && ctx && <AskToBorrow post={(text) => postV2(ctx.base, ctx.er, ctx.signer, ref.anchor, text).then(load)} />}

          <h2>Messages</h2>
          <ul className={s.list}>
            {member.messages.map((m) => (
              <li key={m.index} className={s.row} style={{ gridTemplateColumns: "1fr" }}>
                <span className={s.rowMeta}>
                  <span className="mono">{me?.equals(m.author) ? "You" : shortKey(m.author.toBase58())}</span>
                </span>
                <span style={{ overflowWrap: "anywhere" }}>{messageWords(m.body)}</span>
              </li>
            ))}
          </ul>
          {ctx && <Post post={(text) => postV2(ctx.base, ctx.er, ctx.signer, ref.anchor, text).then(load)} />}

          <h2>People</h2>
          <ul className={s.list}>
            {member.state.members.map((m) => (
              <li key={m.pubkey.toBase58()} className={s.row}>
                <span className={s.rowMain}>
                  <span className="mono">{me?.equals(m.pubkey) ? "You" : shortKey(m.pubkey.toBase58())}</span>
                  <span className={s.rowMeta}>
                    {roleWords(m.roles)}
                    {m.owner ? " · owner" : ""}
                  </span>
                </span>
                {isOwner && !m.owner && ctx && (
                  <Button
                    variant="ghost"
                    aria-label={`Remove ${shortKey(m.pubkey.toBase58())} from the room`}
                    onClick={() => window.confirm("Remove this member? Their loans keep their own read access.") && revokeV2(ctx.base, ctx.er, ctx.signer, ref.anchor, m.pubkey).then(load)}
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {isOwner && ctx && <Invite invite={(who, roles) => inviteV2(ctx.base, ctx.er, ctx.signer, ref.anchor, who, roles).then(load)} />}
          <p className={s.empty}>
            Room owners manage people. Owning a room gives no lending or borrowing rights beyond the roles shown, and no access to loans you are not part of.
          </p>
        </div>
      )}

      <p className={shared.hint} style={{ marginTop: "2rem" }}>
        <Link href="/devnet/private">Back to private workspace</Link>
      </p>
    </div>
  );
}

function useAct() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const act = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await f();
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "That did not work.");
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, err, act };
}

function ErrorLine({ err }: { err: string | null }) {
  return err ? (
    <p role="alert" className={shared.error}>
      {err}
    </p>
  ) : null;
}

function FinishRoom({ run, onDone }: { run: (roles: number) => Promise<unknown>; onDone: () => void }) {
  const [roles, setRoles] = useState<number>(ROLE_V2.viewer);
  const { busy, err, act } = useAct();
  return (
    <section className={s.section} style={{ marginTop: "1.5rem" }}>
      <h2>Finish creating the room</h2>
      <p className={s.empty}>The room exists on Solana. Choose what you will do in it; its member list is created inside ZenLo&rsquo;s private network.</p>
      <RolePicker roles={roles} onChange={setRoles} />
      <div className={s.actions}>
        <Button loading={busy} disabled={roles === 0} onClick={async () => (await act(() => run(roles))) && onDone()}>
          Sign to create the member list
        </Button>
      </div>
      <ErrorLine err={err} />
    </section>
  );
}

function RolePicker({ roles, onChange }: { roles: number; onChange: (r: number) => void }) {
  return (
    <fieldset className={s.form} style={{ display: "flex" }}>
      <legend>Roles</legend>
      {ROLE_WORDS.map(([k, w]) => (
        <label key={k} className={s.check}>
          <input type="checkbox" checked={hasRole(roles, ROLE_V2[k])} onChange={() => onChange(roles ^ ROLE_V2[k])} /> {w}
        </label>
      ))}
    </fieldset>
  );
}

function Invite({ invite }: { invite: (who: PublicKey, roles: number) => Promise<unknown> }) {
  const [addr, setAddr] = useState("");
  const [roles, setRoles] = useState<number>(ROLE_V2.borrower);
  const { busy, err, act } = useAct();
  let who: PublicKey | null = null;
  try {
    who = addr.trim() ? new PublicKey(addr.trim()) : null;
  } catch {}
  return (
    <div className={s.form}>
      <label className={s.wide}>
        Wallet to invite
        <input className={`${shared.input} mono`} value={addr} onChange={(e) => setAddr(e.target.value)} aria-invalid={!!addr.trim() && !who} />
      </label>
      <div className={s.wide}>
        <RolePicker roles={roles} onChange={setRoles} />
      </div>
      <div className={`${s.actions} ${s.wide}`}>
        <Button disabled={!who || roles === 0} loading={busy} onClick={async () => who && (await act(() => invite(who!, roles))) && setAddr("")}>
          Invite
        </Button>
      </div>
      <ErrorLine err={err} />
    </div>
  );
}

function AskToBorrow({ post }: { post: (text: string) => Promise<unknown> }) {
  const [usdc, setUsdc] = useState("");
  const [days, setDays] = useState("30");
  const { busy, err, act } = useAct();
  const ok = /^\d+(\.\d{1,6})?$/.test(usdc) && Number(usdc) > 0 && /^\d{1,2}$/.test(days) && Number(days) >= 1 && Number(days) <= 90;
  return (
    <div className={s.form}>
      <label>
        Borrow (USDC)
        <input className={`${shared.input} num`} inputMode="decimal" value={usdc} onChange={(e) => setUsdc(e.target.value)} />
      </label>
      <label>
        For (days, 1 to 90)
        <input className={`${shared.input} num`} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
      </label>
      <div className={`${s.actions} ${s.wide}`}>
        <Button variant="secondary" disabled={!ok} loading={busy} onClick={async () => (await act(() => post(requestBody(usdc, Number(days))))) && setUsdc("")}>
          Post a borrowing request
        </Button>
      </div>
      <ErrorLine err={err} />
    </div>
  );
}

function Post({ post }: { post: (text: string) => Promise<unknown> }) {
  const [text, setText] = useState("");
  const { busy, err, act } = useAct();
  const bytes = new TextEncoder().encode(text).length;
  return (
    <div className={s.form}>
      <label className={s.wide}>
        Message ({bytes}/{MAX_BODY} bytes)
        <input className={shared.input} value={text} onChange={(e) => setText(e.target.value)} aria-invalid={bytes > MAX_BODY} />
      </label>
      <div className={`${s.actions} ${s.wide}`}>
        <Button variant="ghost" disabled={!text.trim() || bytes > MAX_BODY} loading={busy} onClick={async () => (await act(() => post(text.trim()))) && setText("")}>
          Send
        </Button>
      </div>
      <ErrorLine err={err} />
    </div>
  );
}
