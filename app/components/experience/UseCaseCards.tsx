import Image from "next/image";
import Link from "next/link";
import { USE_CASES } from "./use-cases";
import s from "./Landing.module.css";

/** One card per reason to use ZenLo, each with its own abstract image. `featured` picks a snippet by index. */
export function UseCaseCards({
  heading = true,
  anchors = false,
  featured,
}: {
  heading?: boolean;
  anchors?: boolean;
  featured?: number[];
}) {
  const cases = featured ? featured.map((i) => USE_CASES[i]) : USE_CASES;
  return (
    <section
      className={s.useCases}
      aria-labelledby={heading ? "uc-h" : undefined}
      aria-label={heading ? undefined : "Use cases"}
    >
      {heading && (
        <div className={s.useCasesHead}>
          <div>
            <p className={s.eyebrow}>Use cases</p>
            <h2 id="uc-h">Start where you are.</h2>
          </div>
          <Link className={s.softButton} href="/use-cases">
            See all {USE_CASES.length} use cases <span aria-hidden>→</span>
          </Link>
        </div>
      )}
      <ul className={s.caseGrid}>
        {cases.map((u) => (
          <li key={u.intent} className={s.caseCard}>
            <div className={s.caseArt}>
              <Image
                src={u.image.src}
                alt={u.image.alt}
                width={1200}
                height={900}
                sizes="(max-width: 640px) 92vw, (max-width: 1000px) 45vw, 360px"
              />
            </div>
            <p className={s.caseTag} data-venue={u.venue}>
              {u.venue === "private" ? "Private" : "Public"}
            </p>
            <h3>
              {anchors ? <a href={`/use-cases#case-${USE_CASES.indexOf(u) + 1}`}>{u.intent}</a> : u.intent}
            </h3>
            <p>{u.hook}</p>
            <Link className={s.caseStart} href={u.start.href}>
              {u.start.label} <span aria-hidden>→</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
