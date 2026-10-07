"use client";

import Link from "next/link";
import { useState } from "react";
import { ProviderLogo } from "@/components/brand/ProviderLogo";
import { StatusBadge } from "./StatusBadge";
import { UseCaseVisual } from "./vignettes/Scenes";
import { USE_CASES } from "./use-cases";
import u from "@/app/use-cases/UseCases.module.css";

type Venue = "all" | "private" | "public";

/** Every use case in detail, filterable by venue. */
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
              <UseCaseVisual scene={c.scene} />
            </div>
            <div className={u.caseText}>
              <div className={u.caseTags}>
                <p className={u.caseTag} data-venue={c.venue}>
                  {c.venue === "private" ? "Private" : "Public"}
                </p>
                {c.feature && <StatusBadge feature={c.feature} />}
                {c.provider && <ProviderLogo id={c.provider} height={20} />}
              </div>
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
