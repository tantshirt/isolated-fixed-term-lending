import Image from "next/image";
import Link from "next/link";
import { ArtMotion } from "@/components/experience/ArtMotion";
import { LoanStory } from "@/components/experience/LoanStory";
import { PrivateChapter } from "@/components/experience/PrivateChapter";
import { PublicHeader } from "@/components/experience/PublicHeader";
import { SiteFooter } from "@/components/experience/SiteFooter";
import { UseCaseCards } from "@/components/experience/UseCaseCards";
import h from "@/components/experience/Home.module.css";

const PROMISES = [
  { title: "One fixed cost", body: "5% means 5 USDC on 100. Not an annual rate, not a surprise." },
  { title: "Collateral held by code", body: "Your wSOL sits in the program’s vault for this one loan, not in a person’s wallet." },
  { title: "A deadline you can read", body: "The exact end time is shown before you sign, then counts down for both sides." },
];

const USUAL = [
  "The rate moves after you sign.",
  "Fees show up at the end.",
  "Someone else decides when it’s over.",
  "Your collateral goes into a pool with everyone else’s.",
];

const OURS = [
  "One cost for the whole term, fixed at signing.",
  "Both sides see every number before committing.",
  "The program enforces the deadline, for both of you. Nobody can move it, including us.",
  "One loan, one vault. Nothing is pooled.",
];

const FAQ = [
  {
    q: "Is the interest an annual rate?",
    a: "No. It is the fixed cost for the entire term. A 100 USDC loan at 5% costs 5 USDC, even if you repay early.",
  },
  {
    q: "What is wSOL?",
    a: "Wrapped SOL is SOL held in a token account so the lending program can hold it as collateral. On Devnet, wrapping is a separate action you approve in your wallet.",
  },
  {
    q: "Does the demo use real money?",
    a: "No. It runs entirely in your browser with simulated balances, prices, and time. Devnet is a separate experience using a real wallet and test tokens.",
  },
  {
    q: "Who can see a private loan?",
    a: "Only the lender and borrower can read its terms, inside a hardware-protected MagicBlock rollup. Solana sees deposits, withdrawals, and final balances, never the terms or the conversation.",
  },
  {
    q: "Can I change a loan after it starts?",
    a: "No. The terms are fixed. A lender may cancel an offer before acceptance. After acceptance, the loan ends through repayment, liquidation, or expiry.",
  },
  {
    q: "Do I need an account?",
    a: "No sign-up. On Devnet your wallet is your account: connect once and ZenLo remembers it, so your loans are waiting under My loans next time.",
  },
];

export default function Home() {
  return (
    <>
      <PublicHeader />
      <main className={h.page}>
        <section className={h.hero} aria-labelledby="hero-h">
          <div className={`${h.wrap} ${h.heroGrid}`}>
            <div className={h.heroCopy}>
              <p className={h.eyebrow}>Fixed-term loans on Solana</p>
              <h1 id="hero-h">Clear terms. Zero drama.</h1>
              <p className={h.lede}>
                Lend USDC. Borrow against SOL. The cost, the collateral, and the
                deadline are on the table before anyone signs, and the program
                holds both sides to them.
              </p>
              <div className={h.actions}>
                <Link className={`${h.btn} ${h.solid} ${h.large}`} href="/demo">
                  Try the demo <span aria-hidden>→</span>
                </Link>
                <Link className={`${h.btn} ${h.soft} ${h.large}`} href="/devnet">
                  Use Devnet
                </Link>
              </div>
              <p className={h.fine}>No wallet needed for the demo. No real funds at risk.</p>
            </div>
            <div className={h.heroArt}><ArtMotion>
              <Image
                src="/illustrations/zr-hero.webp"
                alt="Broad blue and white satin ribbons form an open sculptural arch."
                width={1600}
                height={1200}
                priority
                sizes="(max-width: 900px) 92vw, 46vw"
              />
              </ArtMotion></div>
          </div>
        </section>

        <div className={h.wrap}>
          <ul className={h.promises} aria-label="What every loan promises">
            {PROMISES.map((p) => (
              <li key={p.title} className={h.promise}>
                <strong>{p.title}</strong>
                <span>{p.body}</span>
              </li>
            ))}
          </ul>
        </div>

        <section className={`${h.wrap} ${h.section}`} aria-labelledby="contrast-h">
          <div className={h.sectionHead}>
            <p className={h.eyebrow}>Why ZenLo</p>
            <h2 id="contrast-h" className={h.h2}>
              Most loans hide the ending. Ours prints it first.
            </h2>
          </div>
          <div className={h.contrastGrid}>
            <div className={`${h.contrastCard} ${h.usual}`}>
              <h3>The usual loan</h3>
              <ul>
                {USUAL.map((t) => (
                  <li key={t}>
                    <span className={h.dot} aria-hidden>
                      ✕
                    </span>
                    {t}
                  </li>
                ))}
              </ul>
            </div>
            <div className={`${h.contrastCard} ${h.ours}`}>
              <h3>A ZenLo loan</h3>
              <ul>
                {OURS.map((t) => (
                  <li key={t}>
                    <span className={h.dot} aria-hidden>
                      ✓
                    </span>
                    {t}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <div className={h.wrap}>
          <LoanStory />
        </div>

        <section className={`${h.section} ${h.tinted}`} aria-labelledby="endings-h">
          <div className={h.wrap}>
            <div className={h.sectionHead}>
              <p className={h.eyebrow}>Clear terms include the risks</p>
              <h2 id="endings-h" className={h.h2}>
                Every loan has three possible endings.
              </h2>
              <p className={h.lede}>
                All three are written down before you sign. Neither side has a
                guaranteed return.
              </p>
            </div>
            <div className={h.endings}>
              <article className={h.ending}>
                <span className={`${h.pill} ${h.repaid}`}>Repaid</span>
                <h3>You pay back on time.</h3>
                <div className={h.fundFlow} aria-label="Repayment fund flow"><span>Borrower <b>105 USDC →</b> Lender</span><span>Vault <b>1.1 wSOL →</b> Borrower</span></div>
                <p>
                  The borrower repays 105 USDC before the deadline and gets all
                  1.1 wSOL back. The lender receives the 105.
                </p>
              </article>
              <article className={h.ending}>
                <span className={`${h.pill} ${h.liquidated}`}>Liquidated</span>
                <h3>The price drops too far.</h3>
                <div className={h.fundFlow} aria-label="Liquidation fund flow"><span>Liquidator <b>Debt →</b> Lender</span><span>Vault <b>Payout →</b> Liquidator</span><span>Vault <b>Remainder →</b> Borrower</span></div>
                <p>
                  At the liquidation threshold, a liquidator can pay the debt and
                  receive collateral plus a 5% incentive, capped by the
                  collateral available. Any remainder goes back to the borrower.
                </p>
              </article>
              <article className={h.ending}>
                <span className={`${h.pill} ${h.expired}`}>Expired</span>
                <h3>The clock runs out.</h3>
                <div className={h.fundFlow} aria-label="Expiry fund flow"><span>Vault <b>All wSOL →</b> Lender</span><span>Borrower <b>loses collateral</b></span></div>
                <p>
                  If you do not repay by then, the lender receives your wSOL. Its
                  value may be less than the debt.
                </p>
              </article>
            </div>
            <Link className={`${h.btn} ${h.solid}`} href="/demo">
              Play all three endings in the demo <span aria-hidden>→</span>
            </Link>
          </div>
        </section>

        <div className={h.wrap}>
          <PrivateChapter />
        </div>

        <div className={h.tinted}>
          <div className={h.wrap}>
            <UseCaseCards featured={[0, 2, 4]} anchors />
          </div>
        </div>

        <section className={`${h.wrap} ${h.section}`} id="faq" aria-labelledby="faq-h">
          <div className={h.faq}>
            <div>
              <p className={h.eyebrow}>FAQ</p>
              <h2 id="faq-h" className={h.h2}>
                Good questions. Straight answers.
              </h2>
            </div>
            <div className={h.faqList}>
              {FAQ.map((f, i) => (
                <details key={f.q} open={i === 0}>
                  <summary>
                    {f.q}
                    <span className={h.plus} aria-hidden>
                      +
                    </span>
                  </summary>
                  <p>{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <div className={h.wrap}>
          <section className={h.cta} aria-labelledby="cta-h">
            <div className={h.ctaCopy}>
              <h2 id="cta-h" className={h.h2}>
                See a whole loan in two minutes.
              </h2>
              <p className={h.lede}>
                Set terms, borrow, watch the clock, settle. No wallet, no
                sign-up.
              </p>
              <Link className={`${h.btn} ${h.solid} ${h.large}`} href="/demo">
                Try the demo <span aria-hidden>→</span>
              </Link>
            </div>
            <div className={h.ctaArt}>
              <Image
                src="/illustrations/zr-story-settle.webp"
                alt=""
                fill
                sizes="(max-width: 900px) 92vw, 46vw"
              />
            </div>
          </section>
        </div>

        <SiteFooter />
      </main>
    </>
  );
}
