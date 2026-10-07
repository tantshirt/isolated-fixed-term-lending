// One source for the use-case cards on the landing page and /use-cases.
import type { ProviderLogoId } from "@/components/brand/ProviderLogo";
import type { FeatureId } from "@/lib/feature-status";
import type { UseCaseScene } from "./vignettes/Scenes";

export type UseCase = {
  intent: string;
  start: { label: string; href: string };
  who: string;
  problem: string;
  how: string;
  /** One line for the card. */
  hook: string;
  venue: "public" | "private";
  /** Product vignette drawn beside the card. */
  scene: UseCaseScene;
  /** Shipped feature behind this case; its badge comes from lib/feature-status. */
  feature?: FeatureId;
  /** Third-party provider this case actually hands off to. */
  provider?: ProviderLogoId;
};

export const USE_CASES: UseCase[] = [
  {
    intent: "Borrow USDC without showing my position to everyone",
    start: { label: "Open a private room", href: "/devnet/private" },
    who: "A SOL holder who needs USDC for a week and does not want the size of their loan on a public explorer.",
    problem: "On a public lending protocol, every term, balance, and deadline is readable by anyone, including people waiting to liquidate you.",
    how: "Your room, the terms, and your private balance live inside a hardware-protected rollup. Only you and the lenders you invite can read them. Prices, interest, and settlement follow the same rules as a public ZenLo loan.",
    hook: "Your loan size stays off the public explorer.",
    venue: "private",
    scene: "private-borrow",
    feature: "private-rooms",
  },
  {
    intent: "Lend to someone I invited, on terms we both approve",
    start: { label: "Propose a loan in a room", href: "/devnet/private" },
    who: "A lender who already knows the borrower, or met them through a request card.",
    problem: "Negotiating in public leaks your pricing; negotiating off-chain leaves nothing enforceable.",
    how: "You propose exact terms. Any edit creates a new revision, and both of you must approve the same revision before anything moves.",
    hook: "Both of you approve the same revision, or nothing moves.",
    venue: "private",
    scene: "invited-lend",
    feature: "private-rooms",
  },
  {
    intent: "Compare competing offers without lenders seeing each other",
    start: { label: "Publish a request card", href: "/devnet/private" },
    who: "A borrower who wants the best terms, not the first ones.",
    problem: "In an open order book, lenders undercut each other only after seeing every bid.",
    how: "Publish a card with only the fields you choose. Each lender's offer is readable only by that lender and you. Accept one, and the others are locked out and can cancel.",
    hook: "Lenders bid blind. You pick the best terms.",
    venue: "private",
    scene: "blind-bids",
  },
  {
    intent: "Liquidate a loan that crossed its line, without seeing the loan",
    start: { label: "Browse liquidation quotes", href: "/devnet/private/liquidate" },
    who: "A liquidator with USDC who wants the 5% incentive.",
    problem: "Liquidation usually requires reading every position, which is exactly what private loans hide.",
    how: "When a loan crosses its line, its automatic check posts a short-lived quote: the debt and the wSOL you receive. You fund it from a private balance; if it executes you collect, otherwise you get a refund.",
    hook: "Fund a short-lived quote and earn the 5% incentive, without reading the loan.",
    venue: "private",
    scene: "liquidate",
  },
  {
    intent: "Understand a loan before I commit",
    start: { label: "Explore learning paths", href: "/learn" },
    who: "Anyone new to collateralized lending.",
    problem: "Liquidation thresholds and full-term interest are easy to misread when real money is involved.",
    how: "The wallet-free demo walks one loan through repayment, liquidation, and expiry with the same integer math. Inside a private room, the copilot can explain your exact loan, showing you the text it will share first.",
    hook: "Run one loan to every ending in the wallet-free demo.",
    venue: "public",
    scene: "learn",
  },
  {
    intent: "Check the claims for myself",
    start: { label: "See what is proven on Devnet", href: "/devnet/private/proof" },
    who: "Judges, auditors, and developers.",
    problem: "Privacy claims are easy to make and hard to verify.",
    how: "Every capability was proven on the real Devnet TEE before it was used, with signatures and the findings that changed the design, including what does leak.",
    hook: "Signatures and findings from the real Devnet, including what leaks.",
    venue: "public",
    scene: "verify",
  },
  {
    intent: "Run a lending desk with my team",
    start: { label: "Open a private desk", href: "/devnet/private/desk" },
    who: "A lender who works with partners or staff and wants one place to price, approve, and track loans.",
    problem: "Shared wallets blur who approved what, and a spreadsheet cannot stop a loan that breaks your own rules.",
    how: "A desk keeps a private lending policy: loan size, term, LTV, and a pricing ceiling. Admins set it, lenders make offers under it, and the program refuses any loan outside it. Each member sees only the loans shared with them, and the book never reaches Solana.",
    hook: "Admins set the policy, lenders offer within it, and code enforces it.",
    venue: "private",
    scene: "desk",
    feature: "desk-workspace",
  },
  {
    intent: "Repay early, pay part now, or add collateral",
    start: { label: "Open My loans", href: "/devnet/me" },
    who: "A borrower whose plans changed after signing.",
    problem: "Most fixed loans charge the full term even if you repay on day one, and offer no way to shore up a loan when SOL falls.",
    how: "Newer ZenLo loans charge interest for the days used, with a 25% minimum. You can pay any part early, add wSOL to stay healthy, and a 24-hour grace period follows the deadline with a 1% late fee. The deadline itself never moves.",
    hook: "Interest for the days you used. Top up any time. The deadline never moves.",
    venue: "public",
    scene: "repay-early",
    feature: "v2-loans",
  },
  {
    intent: "Let an auditor read my private loans, with consent",
    start: { label: "See how consent works", href: "/devnet/private/proof" },
    who: "A desk or fund that must show its book to an auditor or partner without making it public.",
    problem: "Private usually means nobody else can check your numbers, which is a non-starter for anyone with reporting duties.",
    how: "A loan can name an auditor before signing. The borrower sees exactly who it is, and the auditor can read that loan only after the borrower consents. Either side can remove a reader, which stops future reads but cannot undo what was already read.",
    hook: "Named before signing. Readable only after consent.",
    venue: "private",
    scene: "auditor",
    feature: "auditor-consent",
  },
  {
    intent: "Get a reminder before something goes wrong",
    start: { label: "Turn on loan alerts", href: "/devnet/me" },
    who: "Anyone with an open loan who does not want to watch a dashboard.",
    problem: "Deadlines and price drops do not wait for you to check in.",
    how: "Turn on alerts for one loan and link Telegram. ZenLo messages you before the deadline and, for public loans, when health moves toward liquidation. Private loans get only generic deadline reminders, never their terms.",
    hook: "A Telegram nudge before the deadline or the liquidation line.",
    venue: "public",
    scene: "alerts",
    feature: "alerts",
    provider: "telegram",
  },
  {
    intent: "Turn borrowed USDC into cash",
    start: { label: "Open My loans to cash out", href: "/devnet/me" },
    who: "A borrower who needs local currency, not a token.",
    problem: "Getting from a wallet to cash usually means another exchange account and another identity check.",
    how: "Hand USDC to MoneyGram from inside ZenLo and pick it up as cash. This step is not private: MoneyGram sees the amount and your identity, and ZenLo says so before you continue. Your loan terms are never shared.",
    hook: "USDC to cash through MoneyGram. Not private, and we say so.",
    venue: "public",
    scene: "cash-out",
    feature: "cash-out",
    provider: "moneygram",
  },
];

export const FEATURES = [
  { title: "Rules fixed at signing", body: "Amount, interest rule, collateral, deadline, and grace are set before anyone commits, and never change after." },
  { title: "Same rules, public or private", body: "Public and private loans share one math crate and the same Pyth price checks." },
  { title: "Repay early, top up", body: "Interest for the days used, partial payments, and added collateral on newer loans." },
  { title: "Lender desks", body: "A private policy that admins set and lenders offer within; the program refuses any loan outside it. The book never reaches Solana." },
  { title: "Private rooms", body: "Members, messages, terms, and approvals stay in records that never reach Solana." },
  { title: "A copilot that never acts", body: "It explains, compares, and proposes; your wallet approves every change." },
  { title: "Automatic settlement", body: "Expiry and liquidation run on a schedule, with no one pressing a button." },
  { title: "Upgrades need two of three", body: "Upgrades to the newer public loan program need two of three Squads signers, then a 24-hour time lock." },
  { title: "Honest about leaks", body: "Deposits, withdrawals, request cards, and quote amounts are public, and we say so." },
];
