/** Explicit small-value Devnet proof. Never prints or persists private keys. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main() {
  if (!process.argv.includes("--run"))
    throw new Error(
      "This submits Devnet transactions. Review docs/devnet.md, then explicitly pass --run."
    );
  const resume = process.argv.includes("--resume");
  process.env.NEXT_PUBLIC_SOLANA_NETWORK = "devnet";
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||= "https://api.devnet.solana.com";
  // Serialize requests, including retries. Retrying identical signed bytes is safe;
  // the transaction lifecycle retains/reconciles their signature before rebuilding.
  const nativeFetch = globalThis.fetch;
  let queue = Promise.resolve();
  let lastRequest = 0;
  globalThis.fetch = (input, init) => {
    const result = queue.then(async () => {
      for (let attempt = 0; ; attempt++) {
        await pause(Math.max(0, 1200 - (Date.now() - lastRequest)));
        lastRequest = Date.now();
        let response: Response;
        try {
          response = await nativeFetch(input, init);
        } catch (error) {
          if (attempt >= 5) throw error;
          await pause(2000 * (attempt + 1));
          continue;
        }
        if (![429, 502, 503, 504].includes(response.status) || attempt >= 5)
          return response;
        await response.arrayBuffer();
        await pause(Math.min(30_000, 3000 * 2 ** attempt));
      }
    });
    queue = result.then(
      () => {},
      () => {}
    );
    return result;
  };
  const { PublicKey, Keypair, Transaction, SystemProgram, Connection } =
    await import("@solana/web3.js");
  const {
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountIdempotentInstruction,
    createTransferInstruction,
    createCloseAccountInstruction,
  } = await import("@solana/spl-token");
  // The smoke runner uses HTTP polling only: public WebSocket throttling must not
  // crash the process and strand its in-memory temporary borrower.
  Connection.prototype.confirmTransaction = async function (
    this: InstanceType<typeof Connection>,
    strategy: { signature: string; lastValidBlockHeight: number } | string
  ) {
    assert.notEqual(
      typeof strategy,
      "string",
      "Smoke confirmation requires a blockheight lifetime"
    );
    const record = strategy as {
      signature: string;
      lastValidBlockHeight: number;
    };
    for (let attempt = 0; attempt < 120; attempt++) {
      const result = await this.getSignatureStatuses([record.signature], {
        searchTransactionHistory: true,
      });
      const status = result.value[0];
      if (
        status &&
        (status.err ||
          status.confirmationStatus === "confirmed" ||
          status.confirmationStatus === "finalized")
      )
        return { context: result.context, value: { err: status.err } };
      if (
        !status &&
        (await this.getBlockHeight("finalized")) > record.lastValidBlockHeight
      )
        throw new Error("Transaction validity window expired");
      await pause(2000);
    }
    throw new Error("Confirmation timed out; reconcile the recorded signature");
  } as typeof Connection.prototype.confirmTransaction;
  const { getConnection } = await import("../lib/program");
  const { KeypairWallet } = await import("../lib/keypair-wallet");
  const {
    DEVNET_GENESIS_HASH,
    DEVNET_USDC_MINT: usdc,
    NATIVE_WSOL_MINT: wsol,
    PROGRAM_ID,
  } = await import("../lib/constants");
  const { submitTransaction, signatureUrl, SubmissionError } = await import(
    "../lib/transaction-lifecycle"
  );
  const {
    sendCreateOffer,
    sendAcceptOffer,
    sendRepayLoan,
    sendCancelOffer,
    sendClaimExpired,
    sendCloseOffer,
    sendWrapSol,
  } = await import("../lib/transactions");
  const { fetchAllOffers, fetchOfferByKey } = await import("../lib/offers");
  const { decodePriceUpdateV2 } = await import(
    "../lib/server/price-update-codec"
  );
  const { validatePriceAccount } = await import("../lib/server/validate-price");
  const { minCollateralLamports } = await import("../lib/risk");
  const c = getConnection();
  assert.equal(await c.getGenesisHash(), DEVNET_GENESIS_HASH);
  assert.ok(
    (await c.getAccountInfo(PROGRAM_ID))?.executable,
    "Loan program must be deployed"
  );
  const file =
    process.env.ANCHOR_WALLET ||
    path.join(os.homedir(), ".config/solana/id.json");
  const lender = new KeypairWallet(
    Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(await fs.readFile(file, "utf8")))
    )
  );
  const borrower = new KeypairWallet(Keypair.generate());
  const lenderUsdc = getAssociatedTokenAddressSync(usdc, lender.publicKey);
  const borrowerUsdc = getAssociatedTokenAddressSync(usdc, borrower.publicKey);
  const borrowerWsol = getAssociatedTokenAddressSync(wsol, borrower.publicKey);
  const priceKey = new PublicKey(
    "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"
  );
  type Receipt = {
    action: string;
    signature: string;
    url: string;
    status?: string;
    offer?: string;
    borrower?: string;
  };
  const evidencePath = path.resolve("../docs/devnet-evidence.json");
  const evidence: {
    network: string;
    programId: string;
    lender: string;
    borrower: string;
    principalUsdc: string;
    verifiedAt: string;
    receipts: Receipt[];
    recoveryBorrower?: string;
    limitations?: string[];
    recoveryComplete?: boolean;
    recoveryError?: string;
    strandedOriginalBorrower?: {
      solLamports: number;
      usdcAtoms: string;
      wsolLamports: string;
    };
  } = resume
    ? JSON.parse(await fs.readFile(evidencePath, "utf8"))
    : {
        network: "devnet",
        programId: PROGRAM_ID.toBase58(),
        lender: lender.publicKey.toBase58(),
        borrower: borrower.publicKey.toBase58(),
        principalUsdc: "0.10",
        verifiedAt: "",
        receipts: [],
      };
  assert.equal(evidence.lender, lender.publicKey.toBase58());
  if (resume) evidence.recoveryBorrower = borrower.publicKey.toBase58();
  const persist = async () => {
    evidence.verifiedAt = new Date().toISOString();
    await fs.writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
  };
  const record = async (
    action: string,
    signature: string,
    status?: string,
    offer?: InstanceType<typeof PublicKey>
  ) => {
    evidence.receipts.push({
      action,
      signature,
      url: signatureUrl(signature),
      ...(status ? { status } : {}),
      ...(offer ? { offer: offer.toBase58() } : {}),
      borrower: borrower.publicKey.toBase58(),
    });
    console.log(action, signature);
    await persist();
  };
  const act = async (fn: () => Promise<string>) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (
          !(error instanceof SubmissionError) ||
          error.state !== "uncertain" ||
          attempt >= 4
        )
          throw error;
        console.log("Reconciling uncertain signature", error.signature);
        await pause(5000);
      }
    }
  };
  const readPrice = async () => {
    const a = await c.getAccountInfo(priceKey);
    assert.ok(a, "Pyth price account missing");
    const p = decodePriceUpdateV2(a.data);
    const now = await c.getBlockTime(await c.getSlot("confirmed"));
    assert.ok(now);
    validatePriceAccount(a.owner, p, now);
    return p;
  };
  if (resume) {
    const original = new PublicKey(evidence.borrower);
    const tokenAmount = async (mint: InstanceType<typeof PublicKey>) => {
      const ata = getAssociatedTokenAddressSync(mint, original);
      return (await c.getAccountInfo(ata))
        ? (await c.getTokenAccountBalance(ata)).value.amount
        : "0";
    };
    evidence.strandedOriginalBorrower = {
      solLamports: await c.getBalance(original),
      usdcAtoms: await tokenAmount(usdc),
      wsolLamports: await tokenAmount(wsol),
    };
    evidence.limitations = [
      "The first process crashed after cancellation. Its temporary borrower key existed only in memory and is unavailable; its remaining test SOL, wSOL and account rent were not recovered. Recovery-run cleanup does not include that wallet.",
    ];
    await persist();
    // Only close cancelled accounts from this exact lender, after checking state.
    const cancelled = (await fetchAllOffers(c)).filter(
      (o) =>
        o.lender === lender.publicKey.toBase58() && o.status === "cancelled"
    );
    assert.ok(
      cancelled.length <= 1,
      "Multiple cancelled offers: require an explicit account selection"
    );
    for (const item of cancelled) {
      const offer = new PublicKey(item.publicKey);
      await record(
        "close-cancelled",
        await act(() => sendCloseOffer(lender, offer)),
        "closed",
        offer
      );
      assert.equal(await fetchOfferByKey(c, offer), null);
    }
  }
  const price = await readPrice();
  const collateral =
    (minCollateralLamports(105_000n, 7000, price) * 125n + 99n) / 100n;
  assert.ok(
    BigInt((await c.getTokenAccountBalance(lenderUsdc)).value.amount) >=
      105_000n,
    "Need at least 0.105 test USDC"
  );
  console.log(
    "Verified Devnet target",
    PROGRAM_ID.toBase58(),
    "payer",
    lender.publicKey.toBase58(),
    "principal 0.10 USDC; temporary borrower funding 0.03 SOL; collateral lamports",
    collateral.toString()
  );
  let funded = false;
  try {
    await record(
      "fund-recovery-borrower",
      await act(() =>
        submitTransaction(
          c,
          lender,
          new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: lender.publicKey,
              toPubkey: borrower.publicKey,
              lamports: 30_000_000,
            }),
            createAssociatedTokenAccountIdempotentInstruction(
              lender.publicKey,
              borrowerUsdc,
              borrower.publicKey,
              usdc
            ),
            createTransferInstruction(
              lenderUsdc,
              borrowerUsdc,
              lender.publicKey,
              resume ? 0n : 5_000n
            )
          )
        )
      )
    );
    funded = true;
    await record(
      "wrap-collateral",
      await act(() => sendWrapSol(borrower, collateral))
    );
    const makeOffer = async (durationSeconds: number) => {
      const offerId = BigInt(Date.now());
      let offer: InstanceType<typeof PublicKey> | undefined;
      const signature = await act(async () => {
        const made = await sendCreateOffer(lender, {
          offerId,
          principal: 100_000n,
          interestBps: 500,
          durationSeconds,
          collateralAmount: collateral,
          maxLtvBps: 7000,
          liquidationLtvBps: 8000,
          usdcMint: usdc,
          wsolMint: wsol,
        });
        offer = made.offer;
        return made.signature;
      });
      assert.ok(offer);
      await record("create", signature, "open", offer);
      return offer;
    };
    if (!resume) {
      const repaid = await makeOffer(600);
      await readPrice();
      await record(
        "borrow",
        await act(() =>
          sendAcceptOffer(
            borrower,
            repaid,
            lender.publicKey,
            usdc,
            wsol,
            priceKey
          )
        ),
        "filled",
        repaid
      );
      await record(
        "repay",
        await act(() =>
          sendRepayLoan(borrower, repaid, lender.publicKey, usdc, wsol)
        ),
        "repaid",
        repaid
      );
      assert.equal((await fetchOfferByKey(c, repaid))?.status, "repaid");
      await record(
        "close-repaid",
        await act(() => sendCloseOffer(lender, repaid)),
        "closed",
        repaid
      );
      assert.equal(await fetchOfferByKey(c, repaid), null);
      const cancelled = await makeOffer(600);
      await record(
        "cancel",
        await act(() => sendCancelOffer(lender, cancelled, usdc)),
        "cancelled",
        cancelled
      );
      assert.equal((await fetchOfferByKey(c, cancelled))?.status, "cancelled");
      await record(
        "close-cancelled",
        await act(() => sendCloseOffer(lender, cancelled)),
        "closed",
        cancelled
      );
    }
    const expired = await makeOffer(60);
    await readPrice();
    await record(
      "borrow-short-term",
      await act(() =>
        sendAcceptOffer(
          borrower,
          expired,
          lender.publicKey,
          usdc,
          wsol,
          priceKey
        )
      ),
      "filled",
      expired
    );
    const expiry = (await fetchOfferByKey(c, expired))!.expiryTs;
    console.log(
      "Waiting for actual Devnet expiry",
      new Date(expiry * 1000).toISOString()
    );
    for (;;) {
      const now = await c.getBlockTime(await c.getSlot("confirmed"));
      if (now !== null && now >= expiry + 2) break;
      await pause(5000);
    }
    await record(
      "claim-expired",
      await act(() =>
        sendClaimExpired(
          lender,
          expired,
          lender.publicKey,
          borrower.publicKey,
          wsol
        )
      ),
      "expired",
      expired
    );
    assert.equal((await fetchOfferByKey(c, expired))?.status, "expired");
    await record(
      "close-expired",
      await act(() => sendCloseOffer(lender, expired)),
      "closed",
      expired
    );
    assert.equal(await fetchOfferByKey(c, expired), null);
    evidence.recoveryComplete = true;
  } catch (error) {
    evidence.recoveryError =
      error instanceof Error ? error.message : "Smoke failed";
    await persist();
    throw error;
  } finally {
    // Every completed or failed run attempts to return free tokens/rent/SOL while
    // this process still holds the ephemeral key. Locked loan collateral is not free.
    if (funded) {
      try {
        const cleanup = new Transaction();
        if (await c.getAccountInfo(borrowerUsdc)) {
          const amount = BigInt(
            (await c.getTokenAccountBalance(borrowerUsdc)).value.amount
          );
          if (amount)
            cleanup.add(
              createTransferInstruction(
                borrowerUsdc,
                lenderUsdc,
                borrower.publicKey,
                amount
              )
            );
          cleanup.add(
            createCloseAccountInstruction(
              borrowerUsdc,
              lender.publicKey,
              borrower.publicKey
            )
          );
        }
        if (await c.getAccountInfo(borrowerWsol))
          cleanup.add(
            createCloseAccountInstruction(
              borrowerWsol,
              lender.publicKey,
              borrower.publicKey
            )
          );
        if (cleanup.instructions.length)
          await record(
            "return-recovery-tokens-and-rent",
            await act(() => submitTransaction(c, borrower, cleanup))
          );
        const lamports = await c.getBalance(borrower.publicKey);
        if (lamports > 5000)
          await record(
            "return-recovery-sol",
            await act(() =>
              submitTransaction(
                c,
                borrower,
                new Transaction().add(
                  SystemProgram.transfer({
                    fromPubkey: borrower.publicKey,
                    toPubkey: lender.publicKey,
                    lamports: lamports - 5000,
                  })
                )
              )
            )
          );
        assert.equal(await c.getBalance(borrower.publicKey), 0);
        console.log(
          "Current temporary borrower SOL balance is zero; cleanup confirmed."
        );
      } catch (error) {
        evidence.limitations = [
          ...(evidence.limitations || []),
          `Current borrower cleanup incomplete: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        ];
        evidence.recoveryComplete = false;
        await persist();
        throw error;
      }
    }
    await persist();
  }
  console.log(
    "Devnet proof complete; see evidence limitations for the original interrupted run."
  );
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Devnet smoke failed");
  process.exitCode = 1;
});
