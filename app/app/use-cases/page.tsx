import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { PublicHeader } from "@/components/experience/PublicHeader";
import { SiteFooter } from "@/components/experience/SiteFooter";
import { UseCaseCards } from "@/components/experience/UseCaseCards";
import { FEATURES, USE_CASES } from "@/components/experience/use-cases";
import s from "@/components/experience/Experience.module.css";
import u from "./UseCases.module.css";

export const metadata: Metadata = {
  title: "Use cases",
  description: "Who ZenLo is for: borrowing, lending, comparing offers, and liquidating, in public or in private.",
};

export default function Page() {
  return (
    <>
      <PublicHeader />
      <main className={s.page}>
        <header className={u.hero}>
          <p className={u.eyebrow}>Use cases</p>
          <h1>Every case Sharky takes.</h1>
          <p className={u.lede}>
            ZenLo is a fixed-term USDC loan against wSOL. Use it in public, or in a private room where only the people in the deal can read it.
          </p>
        </header>
        <UseCaseCards heading={false} anchors />
        <section className={u.cases} aria-label="Use cases in detail">
          {USE_CASES.map((c, i) => (
            <article key={c.intent} id={`case-${i + 1}`} className={u.case} data-art>
              <div className={u.art}>
                <Image src={c.image.src} alt={c.image.alt} width={1200} height={1200} sizes="(max-width: 800px) 90vw, 40vw" />
              </div>
              <div className={u.caseText}>
                <p className={u.caseNo}>{String(i + 1).padStart(2, "0")}</p>
                <h2>{c.intent}</h2>
                <dl>
                  <dt>Who</dt>
                  <dd>{c.who}</dd>
                  <dt>The problem</dt>
                  <dd>{c.problem}</dd>
                  <dt>How ZenLo does it</dt>
                  <dd>{c.how}</dd>
                </dl>
                <Link className={u.start} href={c.start.href}>
                  {c.start.label} <span aria-hidden>→</span>
                </Link>
              </div>
            </article>
          ))}
        </section>
        <section className={u.features} aria-labelledby="features-h">
          <p className={u.eyebrow}>Features</p>
          <h2 id="features-h">What you get either way.</h2>
          <ul>
            {FEATURES.map((f) => (
              <li key={f.title}>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </li>
            ))}
          </ul>
        </section>
        <SiteFooter />
      </main>
    </>
  );
}
