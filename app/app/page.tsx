import Link from "next/link";
import { HeroArtwork, LoanStory } from "@/components/experience/LoanStory";
import { PublicHeader } from "@/components/experience/PublicHeader";
import s from "@/components/experience/Experience.module.css";
export default function Home() {
  return (
    <>
      <PublicHeader />
      <main className={s.page}>
        <section className={s.hero}>
          <div>
            <p className={s.eyebrow}>Your terms. A clear path forward.</p>
            <h1>
              A loan you can
              <br />
              <span>see through.</span>
            </h1>
            <p className={s.lede}>
              Lend USDC. Borrow against SOL. Know the cost, the collateral, and
              the deadline before you commit.
            </p>
            <div className={s.actions}>
              <Link className={s.primary} href="/demo">
                Try the demo <span aria-hidden>&nbsp;→</span>
              </Link>
              <Link className={s.secondary} href="/devnet">
                Use Devnet ↗
              </Link>
            </div>
            <p className={s.muted}>
              No wallet needed for the demo. No real funds at risk.
            </p>
          </div>
          <HeroArtwork />
        </section>
        <LoanStory />
        <section className={s.section}>
          <div className={s.risk}>
            <div>
              <p className={s.eyebrow}>Clear terms include the risks</p>
              <h2>
                Every loan has
                <br />
                more than one ending.
              </h2>
              <Link className={s.primary} href="/demo">
                Explore all three outcomes →
              </Link>
            </div>
            <div>
              <h3>The price can change the outcome.</h3>
              <p className={s.lede}>
                At the liquidation threshold, a liquidator can pay the debt and
                receive collateral plus a 5% incentive, capped by the collateral
                available. Any remainder goes back to the borrower.
              </p>
              <h3>The clock matters, too.</h3>
              <p className={s.lede}>
                Repayment stops. The lender can receive all the collateral. Its
                value may be less than the debt. Neither side has a guaranteed
                return.
              </p>
            </div>
          </div>
        </section>
        <section className={`${s.section} ${s.faq}`}>
          <div>
            <p className={s.eyebrow}>A little more clarity</p>
            <h2>
              Good questions.
              <br />
              Straight answers.
            </h2>
          </div>
          <div>
            <details>
              <summary>What is wSOL?</summary>
              <p>
                Wrapped SOL is SOL held in a token account so the lending
                program can move it as collateral. On Devnet, wrapping is a
                separate action you approve in your wallet.
              </p>
            </details>
            <details>
              <summary>Is the interest an annual rate?</summary>
              <p>
                No. It is the fixed cost for the entire term. A 100 USDC loan at
                5% costs 5 USDC, even if you repay early.
              </p>
            </details>
            <details>
              <summary>Does the demo use real money?</summary>
              <p>
                No. It runs entirely in your browser with simulated balances,
                prices, and time. Devnet is a separate experience using a real
                wallet and test tokens.
              </p>
            </details>
            <details>
              <summary>Can I change a loan after it starts?</summary>
              <p>
                No. The terms are fixed. A lender may cancel an offer before
                acceptance. After acceptance, the loan ends through repayment,
                liquidation, or expiry.
              </p>
            </details>
          </div>
        </section>
        <footer className={s.footer}>
          <span>Lendspan · Clear terms. One loan at a time.</span>
          <span>Built on Solana · Devnet only</span>
        </footer>
      </main>
    </>
  );
}
