"use client";

import { PublicKey } from "@solana/web3.js";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { MAX_BODY, type RoleName } from "@/lib/private/room-codec";
import {
  activeSession,
  endSession,
  finishRoom,
  inviteLink,
  inviteMember,
  postMessage,
  readRoom,
  rememberRoom,
  revokeMember,
  roomCreator,
  roomRef,
  startSession,
  type RoomView as RoomData,
} from "@/lib/private/rooms";
import { usePrivate } from "@/lib/private/use-private";
import { AiPanel } from "./AiPanel";
import { CardPublisher } from "./CardPublisher";
import { LoanPanel, proposalCounterparties } from "./LoanPanel";
import { ProposeWizard, type Prefill } from "./ProposeWizard";
import { loanFromId, readLoan } from "@/lib/private/loans";
import type { LoanTerms } from "@/lib/private/loan-codec";
import { TeeCard } from "./TeeCard";
import { LOAN_MESSAGE_PREFIX, loansInThread } from "@/lib/private/loans";
import { requestJoin } from "@/lib/private/discovery";
import { listRoomLoans } from "@/lib/private/inbox";
import styles from "./private.module.css";

const short = (k: PublicKey) => `${k.toBase58().slice(0, 4)}…${k.toBase58().slice(-4)}`;
const ROLE_WORD: Record<RoleName, string> = { borrower: "Borrower", lender: "Lender", viewer: "Viewer" };

export function RoomView({ roomId }: { roomId: string }) {
  const { signer, base, er, status, error, connect } = usePrivate();
  const ref = useMemo(() => {
    try {
      return roomRef(roomId);
    } catch {
      return null;
    }
  }, [roomId]);
  const [data, setData] = useState<RoomData | null>(null);
  const [draft, setDraft] = useState("");
  const [invitee, setInvitee] = useState("");
  const [role, setRole] = useState<RoleName>("lender");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [, force] = useState(0);
  const [loans, setLoans] = useState<{ anchor: PublicKey; terms: LoanTerms }[]>([]);
  const [loanIds, setLoanIds] = useState<string[]>([]);
  const [creator, setCreator] = useState<PublicKey | null>(null);
  const [asked, setAsked] = useState(false);
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const [proposing, setProposing] = useState(false);
  useEffect(() => {
    if (prefill) setProposing(true);
  }, [prefill]);
  const threadEnd = useRef<HTMLLIElement>(null);

  const load = useCallback(async () => {
    if (!er || !ref) return;
    const view = await readRoom(er, ref.anchor);
    setData(view);
    if (view.access === "member") {
      // Every loan in the room, from its public anchors, plus any the thread mentions.
      const registry = await listRoomLoans(er, ref.anchor).catch(() => []);
      const ids = [...new Set([...registry.filter((l) => l.terms).map((l) => l.loanId), ...loansInThread(view.messages.map((m) => m.body))])];
      setLoanIds(ids);
      const read = await Promise.all(ids.map(async (id) => ({ anchor: loanFromId(id), terms: await readLoan(er, loanFromId(id)) })));
      setLoans(read.filter((l): l is { anchor: PublicKey; terms: LoanTerms } => l.terms !== null));
    } else {
      setCreator(await roomCreator(er, ref.anchor).catch(() => null));
    }
    if (view.access === "member" && signer) rememberRoom(signer.publicKey.toBase58(), roomId);
  }, [er, ref, signer, roomId]);

  useEffect(() => {
    void load();
    if (!er) return;
    const t = setInterval(() => void load(), 6000);
    return () => clearInterval(t);
  }, [er, load]);

  useEffect(() => threadEnd.current?.scrollIntoView({ block: "nearest" }), [data]);

  if (!ref) {
    return (
      <div className="page page-narrow">
        <p role="alert" className={styles.error}>
          That room link is not valid.
        </p>
      </div>
    );
  }

  const me = signer?.publicKey;
  const member = data?.access === "member" ? data : null;
  const isOwner = !!(me && member?.state.owner.equals(me));
  const session = me ? activeSession(me, ref.anchor) : null;

  async function act(label: string, f: () => Promise<unknown>, ok?: string) {
    setBusy(label);
    setNote(null);
    try {
      await f();
      if (ok) setNote({ tone: "ok", text: ok });
      await load();
    } catch (e) {
      setNote({ tone: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
      force((n) => n + 1);
    }
  }

  const inviteKey = (() => {
    try {
      return invitee.trim() ? new PublicKey(invitee.trim()) : null;
    } catch {
      return null;
    }
  })();

  return (
    <div className="page">
      <nav className={styles.crumbs} aria-label="Breadcrumb">
        <Link href="/devnet/private">Overview</Link>
        <span aria-hidden>/</span>
        <span>Room {roomId.slice(0, 4)}</span>
      </nav>

      {status !== "ready" ? (
        <div className={styles.narrow}>
          <TeeCard status={status} error={error} onConnect={connect} />
          <p className={styles.muted}>Only wallets the room owner invited can read this room, even with the link.</p>
        </div>
      ) : data?.access === "none" ? (
        <div className={styles.narrow}>
          <section className={styles.panel}>
            <div className={styles.panelBody}>
              {me && creator?.equals(me) ? (
                <>
                  <h1 className={styles.roomTitle}>Finish setting up this room</h1>
                  <p className={styles.muted}>
                    The room exists on Solana, but its private member list and thread were not created. This step is free
                    apart from the rollup fee, and safe to repeat.
                  </p>
                  {signer && er && (
                    <Button loading={busy === "finish"} onClick={() => act("finish", () => finishRoom(base, er, signer, ref.anchor), "Room is ready.")}>
                      Finish setting up
                    </Button>
                  )}
                </>
              ) : (
                <>
                  <h1 className={styles.roomTitle}>You are not in this room</h1>
                  <p className={styles.muted}>
                    Only wallets the owner invited can read it. Ask to join and the owner sees your wallet,{" "}
                    <span className={styles.mono}>{me ? short(me) : "your wallet"}</span>, in their list of requests. You
                    will see the room under Invitations once they let you in.
                  </p>
                  {signer && er && !asked && (
                    <Button
                      loading={busy === "ask"}
                      onClick={() =>
                        act("ask", async () => {
                          await requestJoin(base, er, signer, ref.anchor);
                          setAsked(true);
                        }, "Asked. The owner decides who joins.")
                      }
                    >
                      Ask to join
                    </Button>
                  )}
                  <Link href="/devnet/discover?side=borrowers&venue=private" className={styles.textLink}>
                    Back to private requests
                  </Link>
                </>
              )}
              {note && (
                <p role={note.tone === "error" ? "alert" : "status"} className={note.tone === "error" ? styles.error : styles.muted}>
                  {note.tone === "error" && /queue|account/i.test(note.text)
                    ? "This room is not taking requests yet. The owner opens requests by publishing a card; until then, send them your wallet address."
                    : note.text}
                </p>
              )}
            </div>
          </section>
        </div>
      ) : !member ? (
        <p className={styles.muted} aria-busy>
          Opening the room…
        </p>
      ) : proposing && signer && er ? (
        <ProposeWizard
          signer={signer}
          base={base}
          er={er}
          room={ref.anchor}
          counterparties={proposalCounterparties(member.state.members, signer.publicKey)}
          prefill={prefill}
          onCancel={() => (setProposing(false), setPrefill(null))}
          onDone={() => (setProposing(false), setPrefill(null), void load())}
        />
      ) : (
        <div className={styles.roomLayout}>
          <section className={styles.thread} aria-labelledby="thread-h">
            <header className={styles.panelHead}>
              <h1 id="thread-h" className={styles.roomTitle}>
                Room {roomId.slice(0, 4)}
              </h1>
              <span className={styles.badge}>{member.state.members.length} members</span>
            </header>
            <ol className={styles.messages}>
              {member.messages.length === 0 && <li className={styles.muted}>No messages yet. Say what you are looking for.</li>}
              {member.messages.map((m) => {
                const mine = !!me && m.author.equals(me);
                return (
                  <li key={m.index} className={styles.message} data-mine={mine || undefined}>
                    <span className={styles.messageMeta}>
                      {mine ? "You" : short(m.author)} · {new Date(m.ts * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                    </span>
                    {m.body.startsWith(LOAN_MESSAGE_PREFIX) ? (
                      <span className={`${styles.bubble} ${styles.loanRef}`}>Proposed a private loan · see Loans</span>
                    ) : (
                      <span className={styles.bubble}>{m.body}</span>
                    )}
                  </li>
                );
              })}
              <li ref={threadEnd} aria-hidden />
            </ol>
            <form
              className={styles.composer}
              onSubmit={(e) => {
                e.preventDefault();
                if (!signer || !er || !draft.trim()) return;
                void act("post", async () => {
                  await postMessage(base, er, signer, ref.anchor, draft);
                  setDraft("");
                });
              }}
            >
              <label className="visually-hidden" htmlFor="msg">
                Message
              </label>
              <input
                id="msg"
                className={styles.input}
                value={draft}
                maxLength={MAX_BODY}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Write to the room"
                autoComplete="off"
              />
              <Button type="submit" loading={busy === "post"} disabled={!draft.trim()}>
                Send
              </Button>
            </form>
            <div className={styles.sessionRow}>
              {session ? (
                <>
                  <span className={styles.ok}>Quick replies on until {new Date(session.expiresAt * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
                  <Button variant="ghost" onClick={() => signer && er && act("session", () => endSession(base, er, signer, ref.anchor), "Quick replies ended.")} loading={busy === "session"}>
                    End
                  </Button>
                </>
              ) : (
                <>
                  <span className={styles.hint}>Approve each message, or allow quick replies for one hour. Quick replies can only post; anything involving money still asks your wallet.</span>
                  <Button variant="secondary" onClick={() => signer && er && act("session", () => startSession(base, er, signer, ref.anchor), "Quick replies on for one hour.")} loading={busy === "session"}>
                    Allow quick replies
                  </Button>
                </>
              )}
            </div>
            {signer && er && (
              <div className={styles.threadAi}>
                <AiPanel signer={signer} base={base} er={er} room={ref.anchor} loans={loans} onUseProposal={(p) => p && setPrefill(p)} />
              </div>
            )}
          </section>

          <aside className={styles.side}>
            {signer && er && (
              <LoanPanel
                signer={signer}
                base={base}
                er={er}
                room={ref.anchor}
                members={member.state.members}
                loanIds={loanIds}
                loans={loans}
                onPropose={() => setProposing(true)}
                onChange={() => void load()}
              />
            )}
            {signer && er && isOwner && (
              <CardPublisher signer={signer} base={base} er={er} room={ref.anchor} members={member.state.members.map((m) => m.pubkey)} onChange={() => void load()} />
            )}
            <section className={styles.panel} aria-labelledby="members-h">
              <header className={styles.panelHead}>
                <h2 id="members-h">Members</h2>
              </header>
              <ul className={styles.members}>
                {member.state.members.map((m) => (
                  <li key={m.pubkey.toBase58()}>
                    <span className={styles.mono}>{me && m.pubkey.equals(me) ? "You" : short(m.pubkey)}</span>
                    <span className={styles.role}>{m.owner ? "Owner" : ROLE_WORD[m.role]}</span>
                    {isOwner && !m.owner && (
                      <button
                        className={styles.textButton}
                        onClick={() => signer && er && act(`revoke-${m.pubkey}`, () => revokeMember(base, er, signer, ref.anchor, m.pubkey), "Removed. They can no longer read this room.")}
                        disabled={busy !== null}
                      >
                        Remove
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {isOwner && (
                <form
                  className={styles.invite}
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!signer || !er || !inviteKey) return;
                    void act("invite", () => inviteMember(base, er, signer, ref.anchor, inviteKey, role), "Invited. Send them the room link.").then(() => setInvitee(""));
                  }}
                >
                  <label htmlFor="invitee">Invite by wallet address</label>
                  <input
                    id="invitee"
                    className={`${styles.input} ${styles.mono}`}
                    value={invitee}
                    onChange={(e) => setInvitee(e.target.value)}
                    placeholder="Wallet address"
                    aria-invalid={!!invitee && !inviteKey}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <div className={styles.roleChoice} role="group" aria-label="Role">
                    {(["lender", "borrower", "viewer"] as RoleName[]).map((r) => (
                      <button type="button" key={r} aria-pressed={role === r} onClick={() => setRole(r)}>
                        {ROLE_WORD[r]}
                      </button>
                    ))}
                  </div>
                  <Button type="submit" loading={busy === "invite"} disabled={!inviteKey}>
                    Invite
                  </Button>
                </form>
              )}
              <button
                className={styles.copy}
                onClick={async () => {
                  await navigator.clipboard.writeText(inviteLink(window.location.origin, roomId));
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1600);
                }}
              >
                {copied ? "Link copied" : "Copy room link"}
              </button>
              <p className={styles.hint}>The link only works for wallets you have invited.</p>
            </section>
          </aside>
        </div>
      )}

      {note && (
        <p role={note.tone === "error" ? "alert" : "status"} className={note.tone === "error" ? styles.error : styles.toast}>
          {note.text}
        </p>
      )}
    </div>
  );
}
