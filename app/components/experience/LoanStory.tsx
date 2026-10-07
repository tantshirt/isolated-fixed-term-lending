"use client";

import Link from "next/link";
import {
  motion as m,
  useReducedMotion,
  useScroll,
} from "motion/react";
import { useEffect, useRef, useState } from "react";
import { AssetLabel } from "@/components/brand/AssetLabel";
import { FlowScene } from "./vignettes/FlowScene";
import s from "./LoanStory.module.css";

const steps = [
  {
    title: "An offer, with everything up front.",
    label: "Set the terms",
    status: "Waiting for a borrower",
    amount: "100",
    unit: "USDC" as const,
    detail: "Held in the offer’s own vault",
    body: "Start with 100 USDC. Choose a 7-day term, 5% full-term interest, and 1.1 wSOL in collateral. A borrower sees the same terms you do.",
    note: "Until someone accepts, the lender can cancel and take back the USDC.",
  },
  {
    title: "Their SOL stays behind. Your USDC moves ahead.",
    label: "Make the exchange",
    status: "Loan active",
    amount: "1.1",
    unit: "wSOL" as const,
    detail: "Held as collateral for this loan",
    body: "The borrower locks 1.1 wSOL and receives 100 USDC. That exchange starts the seven-day clock. At the example SOL price of $150, the collateral is worth $165.",
    note: "The program checks the collateral limit against a fresh SOL price before acceptance.",
    flow: "exchange" as const,
  },
  {
    title: "105 USDC back. The collateral goes home.",
    label: "Close the loop",
    status: "Repaid before the deadline",
    amount: "105",
    unit: "USDC" as const,
    detail: "100 principal + 5 fixed interest",
    body: "Before the deadline, the borrower repays 105 USDC. The lender receives the principal and interest; the borrower gets all 1.1 wSOL back.",
    note: "Repay early if you like. Newer loans charge only for the days used, never below a quarter of the 5 USDC; older loans keep the full 5 USDC.",
    flow: "settle" as const,
  },
];

export function LoanStory() {
  const ref = useRef<HTMLElement>(null);
  const [active, setActive] = useState(0);
  const reduced = useReducedMotion();
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start center", "end center"],
  });
  useEffect(() => {
    const sections =
      ref.current?.querySelectorAll<HTMLElement>("[data-chapter]");
    if (!sections) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting)
            setActive(Number((entry.target as HTMLElement).dataset.chapter));
      },
      { rootMargin: "-25% 0px -45% 0px", threshold: 0 },
    );
    sections.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, []);
  return (
    <section
      ref={ref}
      id="how-it-works"
      className={s.story}
      aria-labelledby="story-title"
    >
      <div className={s.intro}>
        <p className={s.caption}>Follow the money</p>
        <h2 id="story-title">
          One loan.
          <br />
          From both sides.
        </h2>
        <p>
          Follow an example from the first offer to the final repayment. Same
          terms. Shared understanding.
        </p>
      </div>
      <div className={s.journey}>
        <aside className={s.tracker} aria-label="Example loan progress">
          <div className={s.trackerHeading}>
            <span>Our example loan</span>
            <span className={s.example}>Illustrative</span>
          </div>
          <ol className={s.trackSteps}>
            {steps.map((step, i) => (
              <li key={step.label}>
                <a
                  href={`#loan-chapter-${i}`}
                  aria-current={active === i ? "step" : undefined}
                >
                  <span className={s.stepNumber}>{i + 1}</span>
                  {step.label}
                </a>
              </li>
            ))}
          </ol>
          <div className={s.progress} aria-hidden>
            <m.div
              style={{ scaleX: reduced ? (active + 1) / 3 : scrollYProgress }}
            />
          </div>
          <div className={s.readout}>
            <p>{steps[active].status}</p>
            <strong>
              <AssetLabel symbol={steps[active].unit}>
                {steps[active].amount} {steps[active].unit}
              </AssetLabel>
            </strong>
            <p>{steps[active].detail}</p>
          </div>
          <dl className={s.terms}>
            <div>
              <dt>Principal</dt>
              <dd>100 USDC</dd>
            </div>
            <div>
              <dt>Full-term cost</dt>
              <dd>5 USDC</dd>
            </div>
            <div>
              <dt>Term</dt>
              <dd>7 days</dd>
            </div>
          </dl>
          <Link className={s.storyLink} href="/demo">
            Try these terms in the demo <span aria-hidden>↗</span>
          </Link>
        </aside>
        <div className={s.chapters}>
          {steps.map((step, i) => (
            <article
              key={step.label}
              id={`loan-chapter-${i}`}
              data-chapter={i}
              className={s.chapter}
            >
              <p className={s.chapterLabel}>
                <span>{i + 1}</span>
                {step.label}
              </p>
              <h3>{step.title}</h3>
              <p className={s.body}>{step.body}</p>
              {step.flow ? (
                <div className={s.art}>
                  <FlowScene phase={step.flow} />
                </div>
              ) : (
                <div className={s.agreement}>
                  <div>
                    <span>Lender supplies</span>
                    <strong>
                      <AssetLabel symbol="USDC">100 USDC</AssetLabel>
                    </strong>
                  </div>
                  <div className={s.agreementArrow} aria-hidden>
                    ↓
                  </div>
                  <div>
                    <span>Borrower agrees to repay</span>
                    <strong>
                      <AssetLabel symbol="USDC">105 USDC</AssetLabel>
                    </strong>
                  </div>
                  <p>Both sides see the cost before the loan begins.</p>
                </div>
              )}
              <p className={s.note}>{step.note}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
