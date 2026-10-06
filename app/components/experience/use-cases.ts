// One source for the use-case cards on the landing page and /use-cases.
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
];

export const FEATURES = [
  { title: "Fixed terms", body: "Amount, full-term interest, collateral, and deadline are set before anyone commits." },
  { title: "Same rules, public or private", body: "Both programs share one math crate and the same Pyth price checks." },
  { title: "Private rooms", body: "Members, messages, terms, and approvals stay in records that never reach Solana." },
  { title: "A copilot that never acts", body: "It explains, compares, and proposes; your wallet approves every change." },
  { title: "Automatic settlement", body: "Expiry and liquidation run on a schedule, with no one pressing a button." },
  { title: "Honest about leaks", body: "Deposits, withdrawals, request cards, and quote amounts are public, and we say so." },
];
