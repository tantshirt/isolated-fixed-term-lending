import { PublicKey } from "@solana/web3.js";
import type { LoanSigner } from "./keypair-wallet";
import type { LoanRequest } from "./requests";
import { parseDraft, type OfferDraft } from "./offer-validation";
import { randomOfferId } from "./offer-id";
import { NETWORK, PROGRAM_ID } from "./constants";
import {
  readSubmissionStorage,
  writeSubmissionStorage,
  withSubmissionLock,
} from "./transaction-lifecycle";
import * as tx from "./transactions";
import { V2_LIVE, PROGRAM_V2_ID, requestV2Pda } from "./v2/program";
import { termsFrom, termsInput } from "./v2/rules";
import { sendCreateRequestV2, sendFundRequestV2 } from "./v2/transactions";
import type { RequestV2 } from "./v2/offers";
import { getConnection } from "./program";

type Config = { usdcMint: string; wsolMint: string; priceUpdateAccount: string };
type Saved = { version: 1; requestId: string; draft: OfferDraft };

const termsKey = (d: NonNullable<ReturnType<typeof parseDraft>>) =>
  JSON.stringify(d, (_, v) => (typeof v === "bigint" ? v.toString() : v));

/** Devnet-only borrower requests. The program enforces every authority and state rule. */
export class RequestService {
  constructor(private signer: LoanSigner, private config: Config) {}

  private get usdc() {
    return new PublicKey(this.config.usdcMint);
  }
  private get wsol() {
    return new PublicKey(this.config.wsolMint);
  }

  /**
   * Posts a request. The request id is saved before sending, so an uncertain
   * submission is retried at the same address instead of locking collateral twice.
   */
  async create(draft: OfferDraft) {
    if (V2_LIVE) return this.createV2(draft);
    const key = `lendspan:request:${NETWORK}:${PROGRAM_ID}:${this.signer.publicKey}`;
    return withSubmissionLock(key, async () => {
      const terms = parseDraft(draft);
      if (!terms) throw new Error("Invalid terms");
      let saved = readSubmissionStorage(key) as Saved | undefined;
      if (saved !== undefined) {
        const earlier = saved && saved.version === 1 && /^\d{1,20}$/.test(saved.requestId) ? parseDraft(saved.draft) : null;
        if (!earlier)
          throw new Error(`Saved request is invalid (${key}). Restore the original recovery entry before posting another request.`);
        if (termsKey(earlier) !== termsKey(terms))
          throw new Error("An earlier request is unresolved. Restore its original terms and retry to reconcile it first.");
      } else {
        saved = { version: 1, requestId: randomOfferId().toString(), draft: { ...draft } };
        writeSubmissionStorage(key, saved);
      }
      try {
        const result = await tx.sendCreateRequest(this.signer, {
          ...terms,
          requestId: BigInt(saved.requestId),
          usdcMint: this.usdc,
          wsolMint: this.wsol,
        });
        writeSubmissionStorage(key);
        return { ...result, requestId: saved.requestId };
      } catch (error) {
        // Keep the id only while a signature may still land.
        if (readSubmissionStorage(`tenor:pending:${NETWORK}:${PROGRAM_ID}:${this.signer.publicKey}`) === undefined)
          writeSubmissionStorage(key);
        throw error;
      }
    });
  }

  /** V2 requests: the id is saved before signing and an existing account reconciles a lost confirmation. */
  private async createV2(draft: OfferDraft) {
    const parsed = parseDraft(draft);
    const terms = parsed && draft.rules ? termsFrom({ principal: parsed.principal, interestBps: parsed.interestBps, durationSeconds: parsed.durationSeconds }, draft.rules) : null;
    if (!parsed || !terms) throw new Error("Invalid terms");
    const borrower = this.signer.publicKey;
    const key = `zenlo:request-v2:${NETWORK}:${PROGRAM_V2_ID}:${borrower}`;
    return withSubmissionLock(key, async () => {
      const saved = readSubmissionStorage(key) as { version: 2; requestId: string } | undefined;
      const requestId = saved && saved.version === 2 && /^\d{1,20}$/.test(saved.requestId) ? BigInt(saved.requestId) : randomOfferId();
      if (saved?.requestId && (await getConnection().getAccountInfo(requestV2Pda(borrower, requestId)))) {
        writeSubmissionStorage(key);
        return { signature: "", requestId: requestId.toString() };
      }
      writeSubmissionStorage(key, { version: 2, requestId: requestId.toString() });
      const result = await sendCreateRequestV2(this.signer, requestId, termsInput(terms, parsed));
      writeSubmissionStorage(key);
      return { signature: result.signature, requestId: requestId.toString() };
    });
  }

  async fundV2(r: RequestV2) {
    const offerId = randomOfferId();
    const result = await sendFundRequestV2(this.signer, r, offerId, new PublicKey(this.config.priceUpdateAccount));
    return { ...result, offerId };
  }

  /** A second funding attempt fails on chain, so a fresh offer id per attempt is safe. */
  fund(r: LoanRequest) {
    return tx.sendFundRequest(
      this.signer,
      new PublicKey(r.publicKey),
      new PublicKey(r.borrower),
      randomOfferId(),
      this.usdc,
      this.wsol,
      new PublicKey(this.config.priceUpdateAccount)
    );
  }

  cancel(r: LoanRequest) {
    return tx.sendCancelRequest(this.signer, new PublicKey(r.publicKey), this.wsol);
  }

  close(r: LoanRequest) {
    return tx.sendCloseRequest(this.signer, new PublicKey(r.publicKey));
  }
}
