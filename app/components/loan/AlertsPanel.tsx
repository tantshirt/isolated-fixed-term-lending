"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/Button";
import { useBackendSession } from "@/lib/auth/wallet-session";
import styles from "@/components/offer/ActionPanel.module.css";

const BACKEND = Boolean(process.env.NEXT_PUBLIC_CONVEX_URL);

/**
 * Consent to alerts for one loan (Story 24.3). Public loans: risk bands and deadline reminders,
 * read from chain by the loan's public key. Private loans: only the deadlines passed here, and
 * every message is generic. Nothing is monitored without this explicit choice.
 */
export function AlertsPanel(props: { kind: "public-v1" | "public-v2" | "private"; loan: string; deadlines?: { maturity: number; graceEnd?: number; pricedFrom?: number; terminalFrom?: number } }) {
  if (!BACKEND) return null;
  return <Inner {...props} />;
}

function Inner({ kind, loan, deadlines }: Parameters<typeof AlertsPanel>[0]) {
  const session = useBackendSession();
  const signedIn = session.status === "signed-in";
  const mine = useQuery(api.alerts.myAlerts, signedIn ? {} : "skip");
  const subscribe = useMutation(api.alerts.subscribe);
  const unsubscribe = useMutation(api.alerts.unsubscribe);
  const link = useMutation(api.alerts.createTelegramLink);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sub = mine?.subscriptions.find((s) => s.loan === loan);

  const act = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await f();
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^.*Uncaught Error: /, "").split("\n")[0] : "That did not work.");
    } finally {
      setBusy(false);
    }
  };

  const body =
    kind === "private"
      ? "ZenLo keeps only the deadlines below and sends a generic notice; it never sees this loan's terms."
      : "ZenLo reads this public loan and tells you as the price buffer is used up and before each deadline.";

  return (
    <section className={styles.panel} aria-labelledby="alerts-h">
      <h2 id="alerts-h" className={styles.title}>
        Alerts
      </h2>
      <p className={styles.body}>{body}</p>
      {!signedIn ? (
        <Button variant="secondary" block loading={session.status === "signing"} onClick={() => act(session.signIn)} disabled={session.status === "no-wallet" || session.status === "no-sign-message"}>
          Sign in to set alerts
        </Button>
      ) : (
        <>
          {sub ? (
            <Button variant="ghost" block loading={busy} onClick={() => act(() => unsubscribe({ id: sub.id }))}>
              Stop alerts for this loan
            </Button>
          ) : (
            <Button variant="secondary" block loading={busy} onClick={() => act(() => subscribe({ kind, loan, deadlines }))}>
              Alert me about this loan
            </Button>
          )}
          {mine && !mine.telegramLinked && (
            <Button
              variant="ghost"
              block
              loading={busy}
              onClick={() =>
                act(async () => {
                  const { url } = await link({});
                  window.open(url, "_blank", "noopener");
                })
              }
            >
              Connect Telegram
            </Button>
          )}
          {mine?.telegramLinked && <p className={styles.body}>Telegram is connected. Messages about private loans never include terms.</p>}
        </>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </section>
  );
}
