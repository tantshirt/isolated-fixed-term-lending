"use client";

import Link from "next/link";
import { motion as m, useReducedMotion } from "motion/react";
import s from "./Landing.module.css";
import { PRIVATE_SCENES } from "./vignettes/Scenes";

function PrivateScene({ scene }: { scene: keyof typeof PRIVATE_SCENES }) {
  const Scene = PRIVATE_SCENES[scene];
  return <Scene />;
}

const STEPS = [
  {
    n: "1",
    title: "Meet in a private room",
    body: "Invite a lender, or publish a card and choose who joins. A link alone opens nothing.",
    scene: "room" as const,
  },
  {
    n: "2",
    title: "Agree on exact terms",
    body: "Offers stay between one lender and you. Both sides approve the same revision; any edit starts over.",
    scene: "agree" as const,
  },
  {
    n: "3",
    title: "Settle with only balances public",
    body: "Repay, expire, or liquidate with the usual rules. The terms never reach Solana.",
    scene: "settle" as const,
  },
];

export function PrivateChapter() {
  const reduced = useReducedMotion();
  return (
    <section className={s.private} aria-labelledby="private-h">
      <div className={s.privateHead}>
        <p className={s.eyebrow}>Private loans on MagicBlock</p>
        <h2 id="private-h">Same clear terms. Fewer eyes.</h2>
        <p className={s.lede}>
          Private loans run inside a hardware-protected rollup: your room, your terms, and your balance are readable only by the people in the deal. Prices, interest, and settlement follow the same rules as every ZenLo loan.
        </p>
      </div>
      <ol className={s.privateSteps}>
        {STEPS.map((step, i) => (
          <m.li
            key={step.n}
            className={s.privateStep}
            // Content is always visible; motion only settles it into place.
            initial={reduced ? false : { y: 18 }}
            whileInView={{ y: 0 }}
            viewport={{ once: true, margin: "-80px" }}
            transition={{ duration: 0.4, delay: reduced ? 0 : i * 0.08, ease: [0.2, 0, 0, 1] }}
          >
            <div className={s.privateArt}>
              <PrivateScene scene={step.scene} />
            </div>
            <span className={s.stepNo}>{step.n}</span>
            <h3>{step.title}</h3>
            <p>{step.body}</p>
          </m.li>
        ))}
      </ol>
      <div className={s.privateActions}>
        <Link className={s.primary} href="/devnet/private">
          Open a private room <span aria-hidden>→</span>
        </Link>
        <Link className={s.textLink} href="/devnet/private/proof">
          See what is proven on Devnet
        </Link>
      </div>
      <p className={s.note}>Devnet only, with test assets. Deposits, withdrawals, and request cards are public; we list exactly what leaks.</p>
    </section>
  );
}
