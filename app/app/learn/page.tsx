import Link from "next/link";
import { PublicHeader } from "@/components/experience/PublicHeader";
import { SiteFooter } from "@/components/experience/SiteFooter";
import h from "@/components/experience/Home.module.css";
import { RulesSimulator } from "@/components/experience/RulesSimulator";
export const metadata = { title: "Learn · ZenLo" };
export default function Learn() {
  return <><PublicHeader /><main className={h.wrap}>
    <section className={h.section} aria-labelledby="learn-h">
      <div className={h.sectionHead}><h1 id="learn-h" className={h.h2}>Understand the loan before you commit.</h1><p className={h.lede}>Follow the money, read the risks, and practice every ending.</p></div>
      <div className={h.contrastGrid}>
        <article className={`${h.contrastCard} ${h.learnPrimary}`}><h2>Follow a whole loan</h2><p>Set terms, borrow, and explore repayment, liquidation and expiry with sample funds. No wallet or network needed.</p><Link className={`${h.btn} ${h.solid}`} href="/demo">Start the simulation →</Link><p className={h.fine}>Simulation only. No transactions are submitted.</p></article>
        <article className={`${h.contrastCard} ${h.usual}`}><h2>Make your call in Loan Lab</h2><p>Draw a scenario with verifiable randomness on Devnet. Predict the ending, then see why it happens.</p><Link className={`${h.btn} ${h.soft}`} href="/devnet/learn">Practice with a Devnet wallet →</Link><p className={h.fine}>Wallet signatures and test assets. Recording an achievement on a public SOAR profile is optional.</p></article>
      </div>
      <RulesSimulator />
      <div className={h.actions}><Link className={`${h.btn} ${h.soft}`} href="/#how-it-works">Read how it works</Link><Link className={`${h.btn} ${h.soft}`} href="/use-cases">Explore use cases</Link></div>
    </section><SiteFooter /></main></>;
}
