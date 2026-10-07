import { PublicKey } from "@solana/web3.js";
import type { LoanSigner } from "./keypair-wallet";
import type { LoanCommand, LoanService } from "./loan-service";
import type { Offer } from "./offers";
import { parseDraft } from "./offer-validation";
import { randomOfferId } from "./offer-id";
import { NETWORK, PROGRAM_ID } from "./constants";
import {
  readSubmissionStorage,
  writeSubmissionStorage,
  withSubmissionLock,
} from "./transaction-lifecycle";
import type { OfferDraft } from "./offer-validation";
import * as tx from "./transactions";
import { V2_LIVE, PROGRAM_V2_ID, offerV2Pda } from "./v2/program";
import { termsFrom, termsInput } from "./v2/rules";
import { sendCreateOfferV2 } from "./v2/transactions";
import { getConnection } from "./program";
/** The real adapter delegates all authority and state checks to the unchanged program. */
export class DevnetLoanService implements LoanService {
  constructor(
    private signer: LoanSigner,
    private config: {
      usdcMint: string;
      wsolMint: string;
      priceUpdateAccount: string;
    },
    private offer?: Offer
  ) {}
  async execute(c: LoanCommand) {
    const usdc = new PublicKey(this.config.usdcMint),
      wsol = new PublicKey(this.config.wsolMint);
    if (c.action === "create" && V2_LIVE) return this.createV2(c.draft);
    if (c.action === "create") {
      const key = `lendspan:create:${NETWORK}:${PROGRAM_ID}:${this.signer.publicKey}`;
      return withSubmissionLock(key, async () => {
        const requested = c.draft && parseDraft(c.draft);
        if (!requested) throw new Error("Invalid terms");
        const termsKey = (draft: NonNullable<ReturnType<typeof parseDraft>>) =>
          JSON.stringify({
            ...draft,
            principal: draft.principal.toString(),
            collateralAmount: draft.collateralAmount.toString(),
            debt: draft.debt.toString(),
          });
        const raw = readSubmissionStorage(key);
        let record: {
          version: number;
          offerId: string;
          draft: OfferDraft;
          usdcMint: string;
          wsolMint: string;
        };
        if (raw !== undefined) {
          try {
            record = raw as typeof record;
            if (
              !record ||
              record.version !== 1 ||
              typeof record.offerId !== "string" ||
              !/^\d{1,20}$/.test(record.offerId) ||
              BigInt(record.offerId) > 18446744073709551615n ||
              !parseDraft(record.draft) ||
              typeof record.usdcMint !== "string" ||
              typeof record.wsolMint !== "string"
            )
              throw new Error();
          } catch {
            throw new Error(
              `Saved offer creation is invalid (${key}). Restore the original recovery entry before creating another offer.`
            );
          }
          if (
            termsKey(parseDraft(record.draft)!) !== termsKey(requested) ||
            record.usdcMint !== usdc.toBase58() ||
            record.wsolMint !== wsol.toBase58()
          ) {
            throw new Error(
              "An earlier offer creation is unresolved. Restore its original terms and retry to reconcile it before creating different terms."
            );
          }
        } else {
          record = {
            version: 1,
            offerId: randomOfferId().toString(),
            draft: { ...c.draft! },
            usdcMint: usdc.toBase58(),
            wsolMint: wsol.toBase58(),
          };
          writeSubmissionStorage(key, record);
        }
        try {
          const result = await tx.sendCreateOffer(this.signer, {
            ...parseDraft(record.draft)!,
            offerId: BigInt(record.offerId),
            usdcMint: usdc,
            wsolMint: wsol,
          });
          writeSubmissionStorage(key);
          return {
            action: c.action,
            message: "Offer created",
            signature: result.signature,
            offerId: record.offerId,
          };
        } catch (error) {
          if (
            readSubmissionStorage(
              `tenor:pending:${NETWORK}:${PROGRAM_ID}:${this.signer.publicKey}`
            ) === undefined
          )
            writeSubmissionStorage(key);
          throw error;
        }
      });
    }
    const o = this.offer;
    if (!o) throw new Error("Load an offer first");
    return this.legacy(c, o, usdc, wsol);
  }

  /**
   * New offers go to isolated_loan_v2. The offer id is saved before signing, so a lost
   * confirmation is reconciled by looking the offer up instead of creating a second one.
   */
  private async createV2(draft: OfferDraft | undefined) {
    const parsed = draft && parseDraft(draft);
    const terms = parsed && draft.rules ? termsFrom({ principal: parsed.principal, interestBps: parsed.interestBps, durationSeconds: parsed.durationSeconds }, draft.rules) : null;
    if (!parsed || !terms) throw new Error("Invalid terms");
    const lender = this.signer.publicKey;
    const key = `zenlo:create-v2:${NETWORK}:${PROGRAM_V2_ID}:${lender}`;
    return withSubmissionLock(key, async () => {
      const saved = readSubmissionStorage(key) as { version: 2; offerId: string } | undefined;
      const offerId = saved && saved.version === 2 && /^\d{1,20}$/.test(saved.offerId) ? BigInt(saved.offerId) : randomOfferId();
      if (saved?.offerId && (await getConnection().getAccountInfo(offerV2Pda(lender, offerId)))) {
        writeSubmissionStorage(key);
        return { action: "create" as const, message: "Offer created", offerId: offerId.toString() };
      }
      writeSubmissionStorage(key, { version: 2, offerId: offerId.toString() });
      const result = await sendCreateOfferV2(this.signer, offerId, termsInput(terms, parsed));
      writeSubmissionStorage(key);
      return { action: "create" as const, message: "Offer created", signature: result.signature, offerId: offerId.toString() };
    });
  }

  private async legacy(c: LoanCommand, o: Offer, usdc: PublicKey, wsol: PublicKey) {
    const key = new PublicKey(o.publicKey),
      lender = new PublicKey(o.lender),
      borrower = o.borrower ? new PublicKey(o.borrower) : null,
      price = new PublicKey(this.config.priceUpdateAccount);
    let signature: string;
    switch (c.action) {
      case "create":
        throw new Error("Create runs before an offer is loaded");
      case "accept":
        signature = await tx.sendAcceptOffer(
          this.signer,
          key,
          lender,
          usdc,
          wsol,
          price
        );
        break;
      case "cancel":
        signature = await tx.sendCancelOffer(this.signer, key, usdc);
        break;
      case "close":
        signature = await tx.sendCloseOffer(this.signer, key);
        break;
      case "repay":
        signature = await tx.sendRepayLoan(
          this.signer,
          key,
          lender,
          usdc,
          wsol
        );
        break;
      case "claim":
        if (!borrower) throw new Error("No borrower");
        signature = await tx.sendClaimExpired(
          this.signer,
          key,
          lender,
          borrower,
          wsol
        );
        break;
      case "liquidate":
        if (!borrower) throw new Error("No borrower");
        signature = await tx.sendLiquidateLoan(
          this.signer,
          key,
          lender,
          borrower,
          usdc,
          wsol,
          price
        );
        break;
    }
    return { action: c.action, message: "Transaction confirmed", signature };
  }
}
