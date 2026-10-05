"use client";

import Link from "next/link";
import { useState } from "react";
import { usePrivate } from "@/lib/private/use-private";
import { BalancePanel } from "./BalancePanel";
import { Journey, JourneyProgress, type JourneyStep } from "./Journey";
import { ReceiptList } from "./ReceiptList";
import { RoomList } from "./RoomList";
import { TeeCard } from "./TeeCard";
import styles from "./private.module.css";

export function PrivateHome() {
  const { signer, base, er, status, error, connect } = usePrivate();
  const [refresh, setRefresh] = useState(0);
  const bump = () => setRefresh((n) => n + 1);
  const ready = status === "ready";

  const steps: JourneyStep[] = [
    {
      title: "Verify and sign in",
      body: "Check the rollup's hardware attestation, then sign a message. No transaction.",
      state: ready ? "done" : "current",
    },
    {
      title: "Open a room",
      body: "A private space for one loan. Its member list and messages never reach Solana.",
      state: ready ? "current" : "next",
    },
    {
      title: "Invite the other side",
      body: "Add a lender or borrower by wallet. A link alone opens nothing.",
      state: ready ? "next" : "later",
    },
    {
      title: "Fund privately",
      body: "Move USDC or wSOL into a private balance only you can read.",
      state: ready ? "next" : "later",
    },
    {
      title: "Agree on exact terms",
      body: "Both sides approve the same revision. Any change resets approval.",
      state: "later",
      note: "Arrives with private loans (Phase 2)",
    },
    {
      title: "Settle",
      body: "Repay, expire, or liquidate with the same rules as public loans. Only balances settle on Solana.",
      state: "later",
      note: "Arrives with private loans (Phase 2)",
    },
  ];

  return (
    <div className="page">
      <header className={styles.hero}>
        <p className={styles.eyebrow}>Devnet · Private rollup</p>
        <h1 className={styles.title}>Lend and borrow without showing everyone the deal.</h1>
        <p className={styles.lede}>
          Terms, conversations, and balances stay inside a hardware-protected rollup that only the people in the deal can
          read. Prices, interest, and settlement follow the same rules as every Lendspan loan.
        </p>
        <Link href="/devnet/private/proof" className={styles.proofLink}>
          See what has been proven on Devnet <span aria-hidden>→</span>
        </Link>
      </header>

      <div className={styles.layout}>
        <aside className={styles.rail}>
          <h2 className={styles.railTitle}>How it goes</h2>
          <Journey steps={steps} />
        </aside>

        <div className={styles.main}>
          <JourneyProgress steps={steps} />
          <div className={ready ? undefined : styles.currentWrap} data-current={!ready || undefined}>
            <TeeCard status={status} error={error} onConnect={connect} />
          </div>

          <section className={styles.panel} aria-labelledby="rooms-h" data-current={ready || undefined}>
            <header className={styles.panelHead}>
              <h2 id="rooms-h">Your rooms</h2>
              <span className={styles.badge}>Members only</span>
            </header>
            {!ready && <p className={styles.locked}>Sign in above to open or enter a room.</p>}
            <RoomList signer={signer} base={base} er={er} onChange={bump} />
          </section>

          <section className={styles.panel} aria-labelledby="balance-h">
            <header className={styles.panelHead}>
              <h2 id="balance-h">Private balance</h2>
              <span className={styles.badge}>Only you</span>
            </header>
            {!ready && <p className={styles.locked}>Sign in above to deposit or see your private balance.</p>}
            <BalancePanel signer={signer} base={base} er={er} onChange={bump} />
          </section>

          <section className={styles.panel} aria-labelledby="disclose-h">
            <header className={styles.panelHead}>
              <h2 id="disclose-h">What stays private</h2>
            </header>
            <div className={styles.disclose}>
              <div>
                <h3>Never on Solana</h3>
                <p>Who is in a room, what they say, draft terms, and approvals.</p>
              </div>
              <div>
                <h3>Members only</h3>
                <p>Room contents and your private balance, read through the attested rollup.</p>
              </div>
              <div>
                <h3>Public</h3>
                <p>That a room exists, deposits and withdrawals, and final balances when a loan settles.</p>
              </div>
            </div>
          </section>

          <section className={styles.panel} aria-labelledby="activity-h">
            <header className={styles.panelHead}>
              <h2 id="activity-h">Recent activity</h2>
            </header>
            <ReceiptList wallet={signer?.publicKey.toBase58() ?? null} refresh={refresh} />
          </section>
        </div>
      </div>
    </div>
  );
}
