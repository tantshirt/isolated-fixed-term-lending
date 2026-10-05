import Link from "next/link";
import { USE_CASES } from "./use-cases";
import s from "./Landing.module.css";

/** "I want to… → Start here", after chainpay-mcp-sdk's "Build with ChainPay" table. */
export function UseCaseTable({ limit, heading = true, anchors = false }: { limit?: number; heading?: boolean; anchors?: boolean }) {
  const rows = USE_CASES.slice(0, limit);
  return (
    <section className={s.useCases} aria-labelledby={heading ? "uc-h" : undefined}>
      {heading && (
        <div className={s.useCasesHead}>
          <p className={s.eyebrow}>Use cases</p>
          <h2 id="uc-h">Start where you are.</h2>
        </div>
      )}
      <table className={s.ucTable}>
        <thead>
          <tr>
            <th scope="col">I want to…</th>
            <th scope="col">Start here</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((u, i) => (
            <tr key={u.intent}>
              <td>{anchors ? <a className={s.intentLink} href={`#case-${i + 1}`}>{u.intent}</a> : u.intent}</td>
              <td>
                <Link href={u.start.href}>
                  {u.start.label} <span aria-hidden>→</span>
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {limit && limit < USE_CASES.length && (
        <Link className={s.textLink} href="/use-cases">
          All use cases and features
        </Link>
      )}
    </section>
  );
}
