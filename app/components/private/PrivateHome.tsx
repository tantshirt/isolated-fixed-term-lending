"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import wiz from "@/components/create/CreateWizard.module.css";
import { savedRooms } from "@/lib/private/rooms";
import { usePrivate } from "@/lib/private/use-private";
import { BalancePanel } from "./BalancePanel";
import { InvitesPanel } from "./InvitesPanel";
import { ReceiptList } from "./ReceiptList";
import { RoomList } from "./RoomList";
import { TeeCard } from "./TeeCard";
import styles from "./private.module.css";
import { PrivateVenueScene } from "@/components/experience/vignettes/Scenes";
import { PoweredByMagicBlock } from "@/components/brand/PoweredByMagicBlock";

const STEPS = [
  {
    title: "Sign in",
    question: "First, check the private rollup and sign in.",
  },
  { title: "Workspace", question: "Your rooms and next steps." },
  { title: "Fund", question: "Move funds into a balance only you can read." },
  { title: "Terms", question: "Agree on terms inside the room." },
] as const;

/** How a private loan's terms work, in the order they happen inside a room. */
const TERMS = [
  {
    title: "A lender proposes",
    body: "Amount in USDC, interest for the whole term, a deadline, and the wSOL the borrower locks. Only that lender and the borrower can read it.",
  },
  {
    title: "The borrower compares",
    body: "Offers from different lenders sit side by side for the borrower. Competing lenders never see each other's terms.",
  },
  {
    title: "Both sides commit",
    body: "The lender funds the offer, then the borrower accepts that exact revision. The USDC moves and the wSOL locks in one step.",
  },
  {
    title: "It ends one of three ways",
    body: "Repaid before the deadline returns the wSOL. Past the deadline the lender receives it. If the loan reaches 80% of the collateral's value, it can be liquidated.",
  },
];

export function PrivateHome() {
  const { signer, base, er, status, error, connect } = usePrivate();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const heading = useRef<HTMLHeadingElement>(null);
  const [refresh, setRefresh] = useState(0);
  const bump = () => setRefresh((n) => n + 1);

  const ready = status === "ready";
  const wallet = signer?.publicKey.toBase58() ?? null;
  const [rooms, setRooms] = useState<string[]>([]);
  useEffect(() => setRooms(wallet ? savedRooms(wallet) : []), [wallet, refresh]);

  // Steps unlock from real state: signing in opens the room step, having a room opens funding.
  // Terms is readable by anyone, so the rules are clear before a wallet is involved.
  const reachable = (n: number) => n === 1 || n === 4 || (n === 2 && ready) || (n === 3 && ready);
  const natural = !ready ? 1 : 2;
  const asked = Number(params.get("step"));
  const step = asked >= 1 && asked <= 4 && reachable(asked) ? asked : natural;
  const current = STEPS[step - 1];
  const done = (n: number) => (n === 1 ? ready : n === 2 ? rooms.length > 0 : false);

  const go = (n: number) => {
    const q = new URLSearchParams(params);
    q.set("step", String(n));
    router.replace(`${pathname}?${q}`, { scroll: false });
  };

  const moved = useRef(false);
  useEffect(() => {
    if (moved.current) heading.current?.focus({ preventScroll: true });
    moved.current = true;
  }, [step]);

  const blocked =
    step < 3 && !reachable(step + 1)
      ? step === 1
        ? "Sign in above, or read how terms work."
        : "Open a room to continue."
      : null;

  return (
    <div className="page">
      <header className={styles.heroArt}>
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>Devnet · Private rollup</p>
          <h1 className={styles.title}>Lend and borrow without showing everyone the deal.</h1>
          <p className={styles.lede}>
            Terms, conversations, and balances stay inside a hardware-protected rollup that only the people in the deal
            can read. Prices, interest, and settlement follow the same rules as every ZenLo loan.
          </p>
          <PoweredByMagicBlock tone="navy" />
        </div>
        <div className={styles.heroImage}>
          <PrivateVenueScene />
        </div>
      </header>

      {ready && <InvitesPanel er={er} wallet={signer?.publicKey ?? null} />}

      <div className={wiz.layout}>
        <div className={wiz.main}>
          <div className={wiz.progress}>
            <div>
              <p className={wiz.kicker}>
                Step <span className="num">{step}</span> of 4 · {current.title}
              </p>
              <ol className={wiz.dots} aria-label="Steps">
                {STEPS.map((s, i) => {
                  const n = i + 1;
                  return (
                    <li key={s.title}>
                      <button
                        type="button"
                        className={wiz.dot}
                        data-state={n === step ? "current" : done(n) ? "done" : "todo"}
                        aria-current={n === step ? "step" : undefined}
                        aria-label={`${s.title}${done(n) ? ", done" : ""}`}
                        disabled={!reachable(n) || n === step}
                        onClick={() => go(n)}
                      >
                        {s.title}
                      </button>
                    </li>
                  );
                })}
              </ol>
            </div>
          </div>

          <section className={wiz.stepBody} aria-labelledby="private-step-h">
            <h2 id="private-step-h" ref={heading} tabIndex={-1} className={wiz.question}>
              {current.question}
            </h2>

            {step === 1 && <TeeCard status={status} error={error} onConnect={connect} />}

            {step === 2 && (
              <>
                <p className={wiz.explain}>
                  A room holds one loan: its members, messages, and terms. Only wallets you invite can read it. You can
                  invite by wallet, or publish a card on Discover and choose from lenders who ask.
                </p>
                <RoomList signer={signer} base={base} er={er} onChange={bump} />
                <div className={styles.actions}><Button variant="secondary" onClick={() => go(3)}>Manage private balances</Button><Button variant="ghost" onClick={() => go(4)}>How terms work</Button></div>
              </>
            )}

            {step === 3 && (
              <>
                <p className={wiz.explain}>
                  Lenders need USDC here to fund an offer; borrowers need wSOL here to lock as collateral. You can skip
                  this and fund later from the same place.
                </p>
                <BalancePanel signer={signer} base={base} er={er} onChange={bump} />
              </>
            )}

            {step === 4 && (
              <>
                <ol className={styles.termSteps}>
                  {TERMS.map((t, i) => (
                    <li key={t.title}>
                      <span className={styles.termIndex} aria-hidden>
                        <span className="num">{i + 1}</span>
                      </span>
                      <div>
                        <h3>{t.title}</h3>
                        <p>{t.body}</p>
                      </div>
                    </li>
                  ))}
                </ol>
                {rooms.length > 0 && ready ? (
                  <div className={styles.panel}>
                    <header className={styles.panelHead}>
                      <h3>Continue in a room</h3>
                      <span className={styles.badge}>Members only</span>
                    </header>
                    <div className={styles.panelBody}>
                      <ul className={styles.roomList}>
                        {rooms.map((id) => (
                          <li key={id}>
                            <Link href={`/devnet/private/rooms/${id}`} className={styles.roomLink}>
                              <span className={styles.roomGlyph} aria-hidden />
                              <span>
                                <span className={styles.roomName}>Room {id.slice(0, 4)}</span>
                                <span className={`${styles.mono} ${styles.roomId}`}>{id.slice(0, 10)}…</span>
                              </span>
                              <span aria-hidden className={styles.chevron}>
                                ›
                              </span>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                ) : (
                  <p className={wiz.explain}>
                    {ready
                      ? "Open a room in step 2, then agree on terms inside it."
                      : "Sign in to open a room and agree on terms inside it."}
                  </p>
                )}
              </>
            )}

            <div className={wiz.footer}>
              {step > 1 ? (
                <Button variant="ghost" onClick={() => go(step - 1)}>
                  Back
                </Button>
              ) : (
                <span />
              )}
              {step < 4 && (
                <span className={styles.footerEnd}>
                  {blocked ? (
                    <>
                      <span className={styles.hint}>{blocked}</span>
                      <Button variant="secondary" onClick={() => go(4)}>
                        How terms work
                      </Button>
                    </>
                  ) : (
                    <Button size="lg" variant={step === 3 ? "secondary" : "primary"} onClick={() => go(step + 1)}>
                      {step === 3 ? "Skip to terms" : "Continue"}
                    </Button>
                  )}
                </span>
              )}
            </div>
          </section>

          <details className={styles.activity}>
            <summary>Recent activity</summary>
            <ReceiptList base={base} er={er} wallet={wallet} refresh={refresh} />
          </details>
        </div>

        <aside className={wiz.aside} aria-label="Your private desk">
          <section className={styles.desk}>
            <h2 className={styles.deskTitle}>Your private desk</h2>
            <dl className={styles.deskList}>
              <div>
                <dt>Private sign-in</dt>
                <dd data-tone={ready ? "ok" : undefined}>{ready ? "Verified" : "Not signed in"}</dd>
              </div>
              <div>
                <dt>Rooms</dt>
                <dd>{ready ? <span className="num">{rooms.length}</span> : "Sign in to see"}</dd>
              </div>
            </dl>
            <h3 className={styles.deskSub}>What stays private</h3>
            <ul className={styles.deskPrivacy}>
              <li>
                <strong>Never on Solana</strong> Who is in a room, what they say, draft terms, and approvals.
              </li>
              <li>
                <strong>Members only</strong> Room contents and your private balance.
              </li>
              <li>
                <strong>Public</strong> That a room exists, deposits and withdrawals, and final balances at settlement.
              </li>
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}
