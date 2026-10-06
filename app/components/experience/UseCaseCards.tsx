import Image from "next/image";
import Link from "next/link";
import { USE_CASES } from "./use-cases";
import s from "./Landing.module.css";

/** One card per reason to use LegitShark, each with its own Sharky. */
export function UseCaseCards({
  heading = true,
  anchors = false,
}: {
  heading?: boolean;
  anchors?: boolean;
}) {
  return (
    <section
      className={s.useCases}
      aria-labelledby={heading ? "uc-h" : undefined}
      aria-label={heading ? undefined : "Use cases"}
    >
      {heading && (
        <div className={s.useCasesHead}>
          <p className={s.eyebrow}>Use cases</p>
          <h2 id="uc-h">Start where you are.</h2>
        </div>
      )}
      <ul className={s.caseGrid}>
        {USE_CASES.map((u, i) => (
          <li key={u.intent} className={s.caseCard}>
            <div className={s.caseArt}>
              <Image
                src={u.image.src}
                alt={u.image.alt}
                width={1200}
                height={1200}
                sizes="(max-width: 640px) 92vw, (max-width: 1000px) 45vw, 360px"
              />
            </div>
            <p className={s.caseTag} data-venue={u.venue}>
              {u.venue === "private" ? "Private" : "Public"}
            </p>
            <h3>
              {anchors ? <a href={`#case-${i + 1}`}>{u.intent}</a> : u.intent}
            </h3>
            <p>{u.hook}</p>
            <Link className={s.caseStart} href={u.start.href}>
              {u.start.label} <span aria-hidden>→</span>
            </Link>
          </li>
        ))}
      </ul>
      {heading && (
        <Link className={s.textLink} href="/use-cases">
          Every case in detail
        </Link>
      )}
    </section>
  );
}
