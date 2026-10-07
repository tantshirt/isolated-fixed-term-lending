"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/Button";
import { useBackendSession } from "@/lib/auth/wallet-session";
import { capabilityFor } from "@/lib/capabilities";
import { formatDeadline } from "@/lib/format";
import styles from "@/components/offer/ActionPanel.module.css";

const BACKEND = Boolean(process.env.NEXT_PUBLIC_CONVEX_URL);

/**
 * Consent to alerts for one loan (Story 24.3). Public loans: risk bands and deadline reminders,
 * read from chain by the loan's public key. Private loans: only the deadlines passed here, and
 * every message is generic. Nothing is monitored without this explicit choice.
 */
export function AlertsPanel(props: { kind: "public-v1" | "public-v2" | "private"; loan: string; deadlines?: { maturity: number; graceEnd?: number; pricedFrom?: number; terminalFrom?: number } }) {
  if (!BACKEND)
    return (
      <section className={styles.panel}>
        <h2 className={styles.title}>Alerts</h2>
        <p className={styles.body}>Alerts are not connected on this deployment.</p>
      </section>
    );
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
  const telegram = capabilityFor("telegram", "devnet", "*", "notify");
  const deadlineRows: [string, number | undefined][] = deadlines
    ? [
        ["Due", deadlines.maturity],
        ["Grace ends", deadlines.graceEnd],
        ["Priced recovery from", deadlines.pricedFrom],
        ["Final claim from", deadlines.terminalFrom],
      ]
    : [];

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
      {kind === "private" && deadlineRows.length > 0 && (
        <dl className={styles.deadlines}>
          {deadlineRows
            .filter((r): r is [string, number] => r[1] !== undefined)
            .map(([label, ts]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd className="num">{formatDeadline(ts)}</dd>
              </div>
            ))}
        </dl>
      )}
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
          {mine && !mine.telegramLinked && !telegram.available && <p className={styles.body}>{telegram.reason}</p>}
          {mine && !mine.telegramLinked && telegram.available && (
            <p className={styles.body}>Telegram is not private. It sees that ZenLo messaged you and when. Messages about private loans say only that a deadline is near.</p>
          )}
          {mine && !mine.telegramLinked && telegram.available && (
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
      {!signedIn && session.status === "no-wallet" && <p className={styles.body}>Connect a wallet to set alerts.</p>}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </section>
  );
}
