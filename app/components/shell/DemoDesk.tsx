"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Chips } from "@/components/ui/Chips";
import { useChainNow, usePrice } from "@/lib/client/hooks";
import { runDemoSetup, setDemoPrice, warpTo } from "@/lib/client/demo";
import { useSigner } from "@/lib/client/signer-context";
import { useToast } from "@/lib/client/toast";
import { priceUsd } from "@/lib/risk";
import { DemoRoles } from "./DemoRoles";
import { Sheet } from "./Sheet";
import styles from "./DemoDesk.module.css";

const PRICES = [
  { value: 150, label: "$150" },
  { value: 140, label: "$140" },
  { value: 131, label: "$131" },
  { value: 110, label: "$110" },
  { value: 60, label: "$60" },
];

const JUMPS = [
  { seconds: 3_600, label: "+1 hour" },
  { seconds: 86_400, label: "+1 day" },
  { seconds: 7 * 86_400, label: "+7 days" },
  { seconds: 30 * 86_400, label: "+30 days" },
];

/**
 * Local demo controls: who you are, where SOL trades, and what time it is on chain.
 * Everything here talks to Surfpool cheatcodes and exists only for the walkthrough.
 */
export function DemoDesk() {
  const { deskOpen, setDeskOpen, bumpRefresh } = useSigner();
  const { price } = usePrice(deskOpen ? 3_000 : 30_000);
  const now = useChainNow();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (label: string, fn: () => Promise<void>, done: string) => {
    setBusy(label);
    try {
      await fn();
      bumpRefresh();
      toast({ tone: "success", title: done });
    } catch (e) {
      toast({
        tone: "error",
        title: "That did not work",
        detail: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setBusy(null);
    }
  };

  const current = price ? Math.round(priceUsd(price)) : null;

  return (
    <Sheet
      open={deskOpen}
      onClose={() => setDeskOpen(false)}
      side="right"
      title="Demo desk"
      description="Local validator controls for the walkthrough. Nothing here exists on mainnet."
    >
      {deskOpen && (
        <>
          <section className={styles.section}>
            <h3 className={styles.heading}>Act as</h3>
            <DemoRoles />
          </section>

          <section className={styles.section}>
            <div className={styles.row}>
              <h3 className={styles.heading}>SOL price</h3>
              <span className={`${styles.readout} num`}>
                {price ? `$${priceUsd(price).toFixed(2)}` : "—"}
                {price && !price.fresh && (
                  <span className={styles.stale}>stale</span>
                )}
              </span>
            </div>
            <Chips
              label="Set the SOL price"
              hideLabel
              options={PRICES}
              value={
                current !== null && PRICES.some((p) => p.value === current)
                  ? current
                  : null
              }
              onChange={(v) =>
                run("price", () => setDemoPrice(v), `SOL is now $${v}`)
              }
            />
            <p className={styles.note}>
              Each loan page shows the SOL price that makes it liquidatable.
            </p>
          </section>

          <section className={styles.section}>
            <div className={styles.row}>
              <h3 className={styles.heading}>Chain clock</h3>
              <span className={`${styles.readout} num`}>
                {now === null
                  ? "Unavailable"
                  : new Date(now * 1000).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
              </span>
            </div>
            <div className={styles.jumps}>
              {JUMPS.map((j) => (
                <Button
                  key={j.seconds}
                  variant="secondary"
                  loading={busy === `warp${j.seconds}`}
                  disabled={Boolean(busy) || now === null}
                  onClick={() =>
                    now !== null &&
                    run(
                      `warp${j.seconds}`,
                      () => warpTo(now + j.seconds),
                      `Clock moved ${j.label.slice(1)}`
                    )
                  }
                >
                  {j.label}
                </Button>
              ))}
            </div>
            <p className={styles.note}>
              Time only moves forward. Use it to pass a loan&apos;s deadline.
            </p>
          </section>

          <section className={styles.section}>
            <h3 className={styles.heading}>Start over</h3>
            <Button
              variant="ghost"
              loading={busy === "reset"}
              disabled={Boolean(busy)}
              onClick={() =>
                run(
                  "reset",
                  runDemoSetup,
                  "Fresh demo: new mints, wallets and price"
                )
              }
            >
              Reset demo wallets
            </Button>
          </section>
        </>
      )}
    </Sheet>
  );
}
