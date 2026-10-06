"use client";

import { m, useInView, useReducedMotion } from "motion/react";
import { useRef } from "react";
import { AssetIcon, type AssetSymbol } from "@/components/brand/AssetLabel";
import { Lock, Pill, Stage, Wallet, vignette as s } from "./parts";

type Lane = { amount: string; unit: AssetSymbol; toRight: boolean };

const PHASES = {
  exchange: {
    label:
      "Example exchange: the lender's 100 USDC moves to the borrower while the borrower's 1.1 wSOL moves into a locked vault, and the 7-day clock starts.",
    lanes: [
      { amount: "100", unit: "USDC", toRight: false },
      { amount: "1.1", unit: "wSOL", toRight: true },
    ] as Lane[],
    vaultOpen: false,
    status: (
<Pill>Day 0 of 7 · clock started</Pill>
    ),
  },
  settle: {
    label:
      "Example repayment: the borrower's 105 USDC moves to the lender while the vault unlocks and returns 1.1 wSOL to the borrower.",
    lanes: [
      { amount: "105", unit: "USDC", toRight: true },
      { amount: "1.1", unit: "wSOL", toRight: false },
    ] as Lane[],
    vaultOpen: true,
    status: <Pill tone="good">Loan closed · repaid</Pill>,
  },
} as const;

/** Story steps 2 and 3: the two assets crossing between borrower, lender and vault. */
export function FlowScene({ phase }: { phase: keyof typeof PHASES }) {
  const p = PHASES[phase];
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const inView = useInView(ref, { amount: 0.3 });
  const still = reduced || !inView;
  return (
    <Stage wide label={p.label}>
      <div ref={ref} className={s.flow}>
        <div className={s.party} style={{ gridRow: "span 2" }}>
          <span className={s.avatar}>
            <Wallet />
          </span>
          <span className={s.value}>Borrower</span>
          <span className={`${s.label} ${s.mono}`}>4mNp…2wLe</span>
        </div>
        {p.lanes.map((lane, i) => (
          <div key={lane.unit} className={s.lane} style={{ gridColumn: 2, gridRow: i + 1 }}>
            <m.span
              className={s.token}
              initial={false}
              animate={
                still
                  ? { left: lane.toRight ? "100%" : "0%", x: lane.toRight ? "-100%" : "0%" }
                  : {
                      left: lane.toRight ? ["0%", "100%"] : ["100%", "0%"],
                      x: lane.toRight ? ["0%", "-100%"] : ["-100%", "0%"],
                    }
              }
              transition={{
                duration: 2.2,
                delay: i * 0.5,
                ease: [0.65, 0, 0.35, 1],
                repeat: Infinity,
                repeatDelay: 1.6,
              }}
            >
              <AssetIcon symbol={lane.unit} size={20} />
              {lane.amount} {lane.unit}
            </m.span>
          </div>
        ))}
        <div className={s.party} style={{ gridColumn: 3, gridRow: 1 }}>
          <span className={s.avatar}>
            <Wallet />
          </span>
          <span className={s.value}>Lender</span>
        </div>
        <div className={s.party} data-vault style={{ gridColumn: 3, gridRow: 2 }}>
          <span className={s.avatar}>
            <Lock open={p.vaultOpen} />
          </span>
          <span className={s.value}>Vault</span>
          <span className={s.label}>{p.vaultOpen ? "Unlocked" : "Locked"}</span>
        </div>
      </div>
      <div className={s.status}>{p.status}</div>
    </Stage>
  );
}
