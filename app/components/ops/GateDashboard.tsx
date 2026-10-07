"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/Button";
import { useBackendSession } from "@/lib/auth/wallet-session";
import { GATE } from "@/lib/pilot/gate";
import styles from "@/components/offer/ActionPanel.module.css";
import gate from "./GateDashboard.module.css";

const BACKEND = Boolean(process.env.NEXT_PUBLIC_CONVEX_URL);

/** Story 24.5: the customer gate, counted from opted-in pilot events, developer wallets excluded. */
export function GateDashboard() {
  if (!BACKEND) return <p>The backend is not connected on this deployment.</p>;
  return <Inner />;
}

function Inner() {
  const session = useBackendSession();
  const report = useQuery(api.pilot.gate, session.status === "signed-in" ? {} : "skip");
  if (session.status !== "signed-in")
    return (
      <section className={styles.panel}>
        <h1 className={styles.title}>Pilot gate</h1>
        <p className={styles.body}>For operations wallets only.</p>
        <Button onClick={() => session.signIn()} loading={session.status === "signing"} disabled={session.status === "no-wallet" || session.status === "no-sign-message"}>
          Sign in
        </Button>
        {session.status === "no-wallet" && <p className={styles.body}>Connect an operations wallet first.</p>}
        {session.error && (
          <p role="alert" className={styles.error}>
            {session.error}
          </p>
        )}
      </section>
    );
  if (report === undefined) return <p role="status">Reading…</p>;
  if (report === null) return <p>This wallet is not an operations wallet.</p>;
  const rows: [string, string, boolean][] = [
    ["Independent operators with an activated desk", `${report.activatedDesks} of ${GATE.activatedDesks}`, report.activatedDesks >= GATE.activatedDesks],
    ["Confirmed loans", `${report.confirmedLoans} of ${GATE.confirmedLoans}`, report.confirmedLoans >= GATE.confirmedLoans],
    ["Desks with loans", `${report.desksWithLoans} of ${GATE.desksWithLoans}`, report.desksWithLoans >= GATE.desksWithLoans],
    ["Originated without developer help", report.unassistedShare === null ? "No loans yet" : `${Math.round(report.unassistedShare * 100)}% (need ${Math.round(GATE.unassistedShare * 100)}%)`, !report.failing.includes("unassistedShare")],
    ["Lenders who came back", `${report.returningLenders} of ${GATE.returningLenders}`, report.returningLenders >= GATE.returningLenders],
  ];
  return (
    <section className={styles.panel}>
      <h1 className={styles.title}>Pilot gate: {report.passed ? "passed" : "not yet"}</h1>
      <dl className={gate.rows}>
        {rows.map(([label, value, ok]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              <span className="num">{value}</span> <strong>{ok ? "Met" : "Not met"}</strong>
              {ok && <span aria-hidden="true"> ✓</span>}
            </dd>
          </div>
        ))}
      </dl>
      <p className={styles.body}>
        {report.excludedEvents} events involving developer wallets were excluded. Comprehension checks and open critical defects are tracked by hand
        (docs/pilot).
      </p>
    </section>
  );
}
