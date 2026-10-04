"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import type { ActingRole } from "@/lib/constants";
import { runDemoSetup } from "@/lib/client/demo";
import { useSigner } from "@/lib/client/signer-context";
import { useToast } from "@/lib/client/toast";
import { hasRoleKeypairs } from "@/lib/roles";
import { Avatar } from "./Avatar";
import styles from "./DemoRoles.module.css";

const ROLES: { role: ActingRole; name: string; line: string }[] = [
  { role: "lender", name: "Lender", line: "Holds USDC. Creates offers." },
  { role: "borrower", name: "Borrower", line: "Holds wSOL. Takes offers and repays." },
  { role: "liquidator", name: "Liquidator", line: "Holds USDC. Settles loans past the line." },
];

/** The three funded demo wallets. One click to act as any side of a loan. */
export function DemoRoles({ onPicked }: { onPicked?: () => void }) {
  const { localRole, chooseLocal, bumpRefresh, publicKey } = useSigner();
  const toast = useToast();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => setReady(hasRoleKeypairs()), []);

  const setup = async () => {
    setBusy(true);
    try {
      await runDemoSetup();
      setReady(true);
      bumpRefresh();
      toast({ tone: "success", title: "Demo ready", detail: "Three wallets funded. SOL is at $150." });
    } catch (e) {
      toast({ tone: "error", title: "Demo setup failed", detail: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(false);
    }
  };

  if (!ready) {
    return (
      <div className={styles.empty}>
        <p>Set up three funded wallets on your local validator: a lender, a borrower and a liquidator.</p>
        <Button onClick={setup} loading={busy} block>
          Set up the demo
        </Button>
      </div>
    );
  }

  return (
    <ul className={styles.roles}>
      {ROLES.map((r) => {
        const active = localRole === r.role && Boolean(publicKey);
        return (
          <li key={r.role}>
            <button
              type="button"
              className={styles.role}
              aria-pressed={active}
              onClick={() => {
                chooseLocal(r.role);
                bumpRefresh();
                onPicked?.();
              }}
            >
              <Avatar seed={r.role} role={r.role} size={36} />
              <span className={styles.text}>
                <span className={styles.name}>{r.name}</span>
                <span className={styles.line}>{r.line}</span>
              </span>
              {active && <span className={styles.badge}>Active</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
