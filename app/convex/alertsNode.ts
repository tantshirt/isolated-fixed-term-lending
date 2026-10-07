"use node";

import { Connection, PublicKey } from "@solana/web3.js";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { GENERIC_PRIVATE_MESSAGE, LEVEL_WORDS, dueReminders, liquidationPrice, remindersFor, step, riskNotificationKey, type AlertState } from "../lib/alerts/bands";
import { decodePriceUpdateV2 } from "../lib/server/price-update-codec";
import { MAX_PRICE_AGE_SECONDS, PYTH_PRICE_UPDATE_ACCOUNT } from "../lib/constants";
import { fetchOfferV2 } from "../lib/v2/offers";
import { v2LoanView } from "../lib/models/loan-view";
import { graceEnd, maturity, pricedRecoveryFrom, terminalClaimFrom } from "../lib/loan-math-v2";
import { fetchOfferByKey } from "../lib/offers";
import { legacyLoanView } from "../lib/models/loan-view";

type Sub = Doc<"alertSubscriptions"> & { chatId: string | null; chatLinkId: Doc<"telegramChats">["_id"] | null };
type State = AlertState & { reminders: string[] };
const short = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;

/**
 * Every minute: evaluate consented loans and queue Telegram messages. Sends go through the job
 * queue with a dedup key per level or reminder, so a retried scan never sends twice.
 */
export const scan = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    const subs: Sub[] = await ctx.runQuery(internal.alerts.activeSubscriptions, {});
    if (!subs.length) return;
    const connection = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
    const now = Math.floor(Date.now() / 1000);
    const info = await connection.getAccountInfo(PYTH_PRICE_UPDATE_ACCOUNT).catch(() => null);
    const decoded = info ? decodePriceUpdateV2(info.data as Buffer) : null;
    const price = decoded
      ? {
          price: decoded.price,
          conf: decoded.conf,
          exponent: decoded.exponent,
          publishTime: Number(decoded.publishTime),
          fresh: now - Number(decoded.publishTime) <= MAX_PRICE_AGE_SECONDS,
          ema: decoded.emaPrice !== undefined && decoded.emaConf !== undefined ? { price: decoded.emaPrice, conf: decoded.emaConf } : undefined,
        }
      : null;
    const usd = price ? Number(price.price - price.conf) * 10 ** price.exponent : null;

    for (const sub of subs) {
      if (!sub.chatLinkId) continue;
      try {
        const prior = (sub.state as State | undefined) ?? null;
        const sent = prior?.reminders ?? [];
        const messages: { key: string; text: string }[] = [];
        let nextState: State | null = prior;

        if (sub.kind === "private") {
          const d = sub.deadlines!;
          for (const r of dueReminders(remindersFor(d), sent, now)) messages.push({ key: `remind:${r.key}`, text: GENERIC_PRIVATE_MESSAGE });
          nextState = { ...(prior ?? { baseline: 0, basis: "", level: 0, notified: 0 }), reminders: [...sent, ...messages.map((m) => m.key.slice(7))] } as State;
        } else {
          const key = new PublicKey(sub.loan);
          const v2 = sub.kind === "public-v2";
          const loan = v2 ? await fetchOfferV2(connection, key).catch(() => null) : await fetchOfferByKey(connection, key).catch(() => null);
          if (!loan) continue;
          const view = v2 ? v2LoanView(loan as never, price, now) : legacyLoanView(loan as never, price, now);
          if (view.payoff === 0n) {
            await ctx.runMutation(internal.alerts.commitScan, { id: sub._id, expectedRevision: sub.revision ?? 0, chatLinkId: sub.chatLinkId, state: { ...prior, done: true }, messages: [] });
            continue;
          }
          if (sub.risk && usd !== null && price?.fresh) {
            const lamports = v2 ? (loan as { collateralLocked: bigint }).collateralLocked : (loan as { collateralAmount: bigint }).collateralAmount;
            const basis = v2 ? `${(loan as { ledger: { outstandingPrincipal: bigint } }).ledger.outstandingPrincipal}:${lamports}` : `${lamports}`;
            const lp = liquidationPrice(view.payoff, lamports, (loan as { liquidationLtvBps: number }).liquidationLtvBps);
            const r = step(prior, { price: usd, liquidationPrice: lp, eligible: !!view.risk?.liquidatable, basis });
            nextState = { ...r.state, reminders: sent };
            if (r.send) messages.push({ key: riskNotificationKey(r.state, r.send), text: `Loan ${short(sub.loan)}: ${LEVEL_WORDS[r.send]}.` });
          }
          const t = v2 ? (loan as { terms: Parameters<typeof maturity>[0] }).terms : null;
          const deadlines = t
            ? { maturity: maturity(t), graceEnd: graceEnd(t), pricedFrom: pricedRecoveryFrom(t), terminalFrom: terminalClaimFrom(t) }
            : { maturity: (loan as { expiryTs: number }).expiryTs };
          const due = dueReminders(remindersFor(deadlines), sent, now);
          for (const r of due) messages.push({ key: `remind:${r.key}`, text: `Loan ${short(sub.loan)}: ${r.words}` });
          nextState = { ...(nextState ?? { baseline: 0, basis: "", level: 0, notified: 0 }), reminders: [...sent, ...due.map((r) => r.key)] } as State;
        }

        await ctx.runMutation(internal.alerts.commitScan, {
          id: sub._id, expectedRevision: sub.revision ?? 0, chatLinkId: sub.chatLinkId, state: nextState, messages,
        });
      } catch {
        // One malformed or temporarily unreadable loan must not suppress every other subscriber.
      }
    }
  },
});
