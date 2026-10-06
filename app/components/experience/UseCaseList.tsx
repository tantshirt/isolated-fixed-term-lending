"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { USE_CASES } from "./use-cases";
import u from "@/app/use-cases/UseCases.module.css";

type Venue = "all" | "private" | "public";

/** The six use cases in detail, filterable by venue. */
export function UseCaseList() {
  const [venue, setVenue] = useState<Venue>("all");
  const count = (v: Venue) =>
    v === "all" ? USE_CASES.length : USE_CASES.filter((c) => c.venue === v).length;
  const shown = USE_CASES.map((c, i) => ({ c, i })).filter(
    ({ c }) => venue === "all" || c.venue === venue,
  );
  const options: { id: Venue; label: string }[] = [
    { id: "all", label: "All" },
    { id: "private", label: "Private" },
    { id: "public", label: "Public" },
  ];
  return (
    <>
      <div className={u.filters} role="group" aria-label="Filter use cases">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            className={u.chip}
            aria-pressed={venue === o.id}
            onClick={() => setVenue(o.id)}
          >
            {o.label} · {count(o.id)}
          </button>
        ))}
      </div>
      <section className={u.cases} aria-label="Use cases in detail" aria-live="polite">
        {shown.map(({ c, i }) => (
          <article key={c.intent} id={`case-${i + 1}`} className={u.case}>
            <div className={u.art}>
              <Image
                src={c.image.src}
                alt={c.image.alt}
                width={1200}
                height={900}
                sizes="(max-width: 800px) 90vw, 30vw"
              />
            </div>
            <div className={u.caseText}>
              <p className={u.caseTag} data-venue={c.venue}>
                {c.venue === "private" ? "Private" : "Public"}
              </p>
              <h2>{c.intent}</h2>
              <p className={u.hook}>{c.hook}</p>
              <dl>
                <dt>Who it’s for</dt>
                <dd>{c.who}</dd>
                <dt>The problem</dt>
                <dd>{c.problem}</dd>
                <dt>How ZenLo handles it</dt>
                <dd>{c.how}</dd>
              </dl>
              <Link className={u.start} href={c.start.href}>
                {c.start.label} <span aria-hidden>→</span>
              </Link>
            </div>
          </article>
        ))}
      </section>
    </>
  );
}
