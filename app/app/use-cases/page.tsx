import type { Metadata } from "next";
import { PublicHeader } from "@/components/experience/PublicHeader";
import { SiteFooter } from "@/components/experience/SiteFooter";
import { UseCaseList } from "@/components/experience/UseCaseList";
import { FEATURES, USE_CASES } from "@/components/experience/use-cases";
import u from "./UseCases.module.css";

export const metadata: Metadata = {
  title: "Use cases",
  description:
    "Who ZenLo is for: borrowing, lending, desks, early repayment, auditors, alerts, and cash-out, in public or in private.",
};

export default function Page() {
  return (
    <>
      <PublicHeader />
      <main className={u.page}>
        <header className={u.hero}>
          <p className={u.eyebrow}>Use cases</p>
          <h1>Pick what you came to do.</h1>
          <p className={u.lede}>
            {USE_CASES.length} real jobs ZenLo handles, in public or in a private
            room where only the people in the deal can read it. Each one starts
            in a single click, and each says whether it is live on Devnet or
            still a gated pilot.
          </p>
        </header>
        <UseCaseList />
      </main>
      <section className={u.features} aria-labelledby="features-h">
        <div className={u.featuresInner}>
          <p className={u.eyebrowLight}>Features</p>
          <h2 id="features-h">The same rules everywhere.</h2>
          <ul>
            {FEATURES.map((f) => (
              <li key={f.title}>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>
      <SiteFooter />
    </>
  );
}
