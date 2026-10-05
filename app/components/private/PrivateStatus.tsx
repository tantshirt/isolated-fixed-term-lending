import type { Gate, GateStatus } from "@/lib/private/gates";
import { PRIVATE_PROGRAM_ID, storyProven } from "@/lib/private/gates";
import Link from "next/link";
import styles from "./PrivateStatus.module.css";
import priv from "./private.module.css";

const STATUS_WORD: Record<GateStatus, string> = {
  pass: "Passed",
  finding: "Passed, limits design",
  fail: "Failed",
  "not-run": "Not run",
};

const NEXT = [
  { id: "9.2", title: "Private rooms, invitations, and scoped sessions" },
  { id: "9.3", title: "Private balances with reviewed deposits and withdrawals" },
  { id: "10.1", title: "The full private loan: fund, accept, repay, expire, withdraw" },
  { id: "11.1", title: "Discovery cards and competing proposals" },
  { id: "11.2", title: "AI request and callback" },
  { id: "12.1", title: "Automatic expiry and open liquidation" },
  { id: "12.2", title: "Settlement receipts on Solana" },
  { id: "13.1", title: "Private transfers, the loan lab, and sponsored first draws" },
];

function explorer(sig: string) {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

function short(v: string) {
  return `${v.slice(0, 6)}…${v.slice(-6)}`;
}

export function PrivateStatus({ gates, error }: { gates: Gate[]; error?: string }) {
  const passed = gates.filter((g) => g.status === "pass" || g.status === "finding").length;
  return (
    <div className="page">
      <nav className={priv.crumbs} aria-label="Breadcrumb">
        <Link href="/devnet/private">Private</Link>
        <span aria-hidden>/</span>
        <span>What has been proven</span>
      </nav>
      <section className={styles.intro}>
        <p className={priv.eyebrow}>Devnet · MagicBlock Private Ephemeral Rollup</p>
        <h1 className={styles.title}>Private lending</h1>
        <p className={styles.lede}>
          Private loans keep terms, conversations, and balances inside a hardware-protected rollup. Before any
          private loan is built, each capability has to pass a gate on the real Devnet TEE. A capability that
          fails stays off. It never falls back to public execution.
        </p>
        <dl className={styles.summary}>
          <div>
            <dt>Gates passed</dt>
            <dd className="num">
              {passed} <span className={styles.of}>of {gates.length}</span>
            </dd>
          </div>
          <div>
            <dt>Private program</dt>
            <dd>
              <a className={styles.mono} href={`https://explorer.solana.com/address/${PRIVATE_PROGRAM_ID}?cluster=devnet`} target="_blank" rel="noreferrer">
                {short(PRIVATE_PROGRAM_ID)}
              </a>
            </dd>
          </div>
          <div>
            <dt>Private loans</dt>
            <dd>On Devnet, test assets only</dd>
          </div>
        </dl>
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
      </section>

      <section aria-labelledby="gates-heading">
        <h2 id="gates-heading" className={styles.h2}>
          What has been proven
        </h2>
        <ol className={styles.gates}>
          {gates.map((g) => (
            <li key={g.id} className={styles.gate}>
              <div className={styles.gateHead}>
                <span className={`${styles.id} num`}>{g.id}</span>
                <h3 className={styles.gateTitle}>{g.title}</h3>
                <span className={`${styles.pill} ${styles[g.status]}`}>
                  <span className={styles.dot} aria-hidden />
                  {STATUS_WORD[g.status]}
                </span>
              </div>
              <p className={styles.question}>{g.question}</p>
              <p className={styles.proved}>{g.proved}</p>
              {g.limit && <p className={styles.limit}>{g.limit}</p>}
              <div className={styles.meta}>
                {g.date && <span className="num">{g.date}</span>}
                <span className={styles.mono}>{g.script}</span>
                {g.signatures.map((s) =>
                  s.layer === "base" ? (
                    <a key={s.value} className={styles.sig} href={explorer(s.value)} target="_blank" rel="noreferrer">
                      {s.label} <span className={styles.mono}>{short(s.value)}</span>
                    </a>
                  ) : (
                    <span key={s.value} className={styles.sig} title="Rollup transaction: visible only to members through the TEE">
                      {s.label} <span className={styles.mono}>{short(s.value)}</span> · rollup
                    </span>
                  ),
                )}
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="next-heading" className={styles.next}>
        <h2 id="next-heading" className={styles.h2}>
          Built on the gates
        </h2>
        <ul className={styles.nextList}>
          {NEXT.map((n) => (
            <li key={n.id}>
              <span className={`${styles.id} num`}>{n.id}</span>
              {n.title}
              <span className={`${styles.pill} ${storyProven(n.id) ? styles.pass : ""}`}>
                {storyProven(n.id) ? "Proven on Devnet" : "Not proven yet"}
              </span>
            </li>
          ))}
        </ul>
        <p className={styles.note}>
          Existing public loans stay on the current program, and the wallet-free simulation is unchanged.
        </p>
      </section>
    </div>
  );
}
