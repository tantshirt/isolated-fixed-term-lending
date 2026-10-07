import Link from "next/link";
import { CtaScene, HeroScene } from "@/components/experience/vignettes/Scenes";
import { LoanStory } from "@/components/experience/LoanStory";
import { PrivateChapter } from "@/components/experience/PrivateChapter";
import { ProviderLogo, type ProviderLogoId } from "@/components/brand/ProviderLogo";
import { PublicHeader } from "@/components/experience/PublicHeader";
import { SiteFooter } from "@/components/experience/SiteFooter";
import { StatusBadge } from "@/components/experience/StatusBadge";
import { UseCaseCards } from "@/components/experience/UseCaseCards";
import type { FeatureId } from "@/lib/feature-status";
import h from "@/components/experience/Home.module.css";

const PROMISES = [
  { title: "A cost rule fixed at signing", body: "5% means at most 5 USDC on 100. Repay early and pay only for the days used, never below the minimum." },
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
  "The cost rule is fixed at signing, with a ceiling it can never pass.",
  "Both sides see every number before committing.",
  "The program enforces the deadline, for both of you. Nobody can move it, including us.",
  "One loan, one vault. Nothing is pooled.",
];

const STACK: { name: string; logo?: ProviderLogoId; feature?: FeatureId; does: string }[] = [
  { name: "Pyth", logo: "pyth", feature: "v2-loans", does: "SOL prices. Every loan checks the spot price and its average, and refuses a stale or unverified one." },
  { name: "Squads", logo: "squads", feature: "governance", does: "Holds the upgrade key of the newer public loan program: two of three signers, then a 24-hour time lock." },
  { name: "Telegram", logo: "telegram", feature: "alerts", does: "Deadline and health reminders, only for loans you switch on. Private loans get generic messages." },
  { name: "MoneyGram", logo: "moneygram", feature: "cash-out", does: "Turns USDC into cash. This step is not private, and the app says so before you continue." },
  { name: "Convex", logo: "convex", does: "Wallet sign-in, scheduled jobs, alerts and cash handoffs. Never private terms, books or keys." },
  { name: "Vercel", logo: "vercel", does: "Hosts the app and runs scheduled settlement checks." },
];

const FAQ = [
  {
    q: "Is the interest an annual rate?",
    a: "No. It is the cost for the whole term: a 100 USDC loan at 5% costs at most 5 USDC. Newer loans charge only for the days used if you repay early, with a minimum of a quarter of the full interest, and an annual ceiling caps every charge. Older loans charge the full 5 USDC whenever you repay.",
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
    a: "The terms never change, but on newer loans you can act within them: pay part of the debt early, or add wSOL to keep the loan healthy. The deadline and grace period do not move. Older loans are all-or-nothing: repay in full, or the loan is liquidated or expires.",
  },
  {
    q: "What happens if I am late?",
    a: "Newer loans give you 24 hours of grace after the deadline, with a late fee of 1% of the principal still unpaid. After grace, anyone can repay the debt and take collateral worth it plus 5%; the rest comes back to you. If nobody does, the lender can claim collateral worth the debt a day later, and all of it seven days later. Every step is shown before you sign.",
  },
  {
    q: "Who can change the program?",
    a: "Upgrades to the newer public loan program need two of three signers on a Squads multisig, then a 24-hour time lock before they run. Every proposal is public for that whole day before it can run.",
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
              <h1 id="hero-h">Your repayment rules, upfront.</h1>
              <p className={h.lede}>
                Lend USDC. Borrow against SOL. The cost, the collateral, the
                deadline, the grace period and what happens after it are on the
                table before anyone signs, and the program holds both sides to them.
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
            <div className={h.heroArt}>
              <HeroScene />
            </div>
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
                Every ending is written down before you sign.
              </h2>
              <p className={h.lede}>
                Repaid, liquidated, or late: each one, and who receives what, is
                on the page before anyone signs. Neither side has a guaranteed
                return.
              </p>
            </div>
            <div className={h.endings}>
              <article className={h.ending}>
                <span className={`${h.pill} ${h.repaid}`}>Repaid</span>
                <h3>You pay back, early or on time.</h3>
                <div className={h.fundFlow} aria-label="Repayment fund flow"><span>Borrower <b>up to 105 USDC →</b> Lender</span><span>Vault <b>1.1 wSOL →</b> Borrower</span></div>
                <p>
                  Repay by the deadline and get all 1.1 wSOL back. On newer
                  loans, repaying on day 3 of 7 costs about 102.14 USDC, and
                  you can pay in parts along the way.
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
                <span className={`${h.pill} ${h.expired}`}>Late</span>
                <h3>The clock runs out.</h3>
                <div className={h.fundFlow} aria-label="Late loan timeline"><span>Deadline <b>+24h →</b> In grace</span><span>Grace ends <b>+1 day →</b> Priced recovery is open</span><span>Then <b>+7 days →</b> Final claim is open</span></div>
                <p>
                  Newer loans give 24 hours of grace with a 1% late fee. Then
                  anyone can repay the debt for collateral worth it plus 5%, and
                  a day later the lender can take collateral worth the debt. The
                  surplus returns to you until the final claim, seven days after
                  grace ends, which can take it all.
                </p>
              </article>
            </div>
            <p className={h.fine}>
              Older loans on the first program have no grace: at the deadline
              the lender receives all the wSOL, which may be worth less than
              the debt.
            </p>
            <Link className={`${h.btn} ${h.solid}`} href="/demo">
              Play every ending in the demo <span aria-hidden>→</span>
            </Link>
          </div>
        </section>

        <div className={h.wrap}>
          <PrivateChapter />
        </div>

        <div className={h.tinted}>
          <div className={h.wrap}>
            <UseCaseCards featured={[7, 0, 6]} anchors />
          </div>
        </div>

        <section className={`${h.wrap} ${h.section}`} aria-labelledby="runs-h">
          <div className={h.sectionHead}>
            <p className={h.eyebrow}>How it runs</p>
            <h2 id="runs-h" className={h.h2}>
              Every outside service, named, with what it does.
            </h2>
            <p className={h.lede}>
              Each badge says whether that part is live on Devnet today or
              still a gated pilot waiting on its provider.
            </p>
          </div>
          <ul className={h.stack}>
            {STACK.map((x) => (
              <li key={x.name} className={h.stackItem}>
                <div className={h.stackHead}>
                  {x.logo ? <ProviderLogo id={x.logo} height={22} /> : <strong>{x.name}</strong>}
                  {x.feature && <StatusBadge feature={x.feature} />}
                </div>
                <p>{x.does}</p>
              </li>
            ))}
          </ul>
        </section>

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
              <CtaScene />
            </div>
          </section>
        </div>

        <SiteFooter />
      </main>
    </>
  );
}
