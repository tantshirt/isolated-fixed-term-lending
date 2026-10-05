/**
 * Devnet proof for borrower requests (story 14.1). The configured CLI wallet lends;
 * a temporary in-memory borrower posts, cancels, posts again, gets funded and repays.
 * Open requests are cancelled and its SOL returned in `finally`. Never prints or persists private keys.
 * Run: npx tsx --env-file=.env.local scripts/request-smoke.ts --run
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main() {
  if (!process.argv.includes("--run"))
    throw new Error("This submits Devnet transactions. Pass --run explicitly.");
  process.env.NEXT_PUBLIC_SOLANA_NETWORK = "devnet";
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||= "https://api.devnet.solana.com";

  const { Keypair, SystemProgram, Transaction, sendAndConfirmTransaction } = await import("@solana/web3.js");
  const {
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountIdempotentInstruction,
    createTransferInstruction,
    createCloseAccountInstruction,
  } = await import("@solana/spl-token");
  const { getConnection } = await import("../lib/program");
  const { KeypairWallet } = await import("../lib/keypair-wallet");
  const { DEVNET_GENESIS_HASH, DEVNET_USDC_MINT: usdc, NATIVE_WSOL_MINT: wsol, PROGRAM_ID, PYTH_PRICE_UPDATE_ACCOUNT } =
    await import("../lib/constants");
  const { signatureUrl } = await import("../lib/transaction-lifecycle");
  const tx = await import("../lib/transactions");
  const { fetchRequestByKey } = await import("../lib/requests");
  const { fetchOfferByKey } = await import("../lib/offers");
  const { randomOfferId } = await import("../lib/offer-id");
  const { decodePriceUpdateV2 } = await import("../lib/server/price-update-codec");
  const { minCollateralLamports } = await import("../lib/risk");
  const { refreshPyth } = await import("./pyth-refresh");
  assert.ok(process.env.PYTH_HERMES_API_KEY, "Load app/.env.local: npx tsx --env-file=.env.local scripts/request-smoke.ts --run");

  const c = getConnection();
  assert.equal(await c.getGenesisHash(), DEVNET_GENESIS_HASH);
  const file = process.env.ANCHOR_WALLET || path.join(os.homedir(), ".config/solana/id.json");
  const lenderKey = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await fs.readFile(file, "utf8"))));
  const lender = new KeypairWallet(lenderKey);
  const borrowerKey = Keypair.generate();
  const borrower = new KeypairWallet(borrowerKey);

  const PRINCIPAL = 100_000n; // 0.10 USDC
  const INTEREST_BPS = 500;
  const DEBT = 105_000n;
  const terms = {
    principal: PRINCIPAL,
    interestBps: INTEREST_BPS,
    durationSeconds: 3600,
    maxLtvBps: 7000,
    liquidationLtvBps: 8000,
    usdcMint: usdc,
    wsolMint: wsol,
  };

  const receipts: { action: string; signature: string; url: string }[] = [];
  const evidencePath = path.resolve("../docs/devnet-request-evidence.json");
  const persist = () =>
    fs.writeFile(
      evidencePath,
      JSON.stringify(
        {
          story: "14.1",
          network: "devnet",
          programId: PROGRAM_ID.toBase58(),
          lender: lender.publicKey.toBase58(),
          borrower: borrower.publicKey.toBase58(),
          principalUsdc: "0.10",
          verifiedAt: new Date().toISOString(),
          receipts,
        },
        null,
        2
      ) + "\n"
    );
  const record = async (action: string, signature: string) => {
    receipts.push({ action, signature, url: signatureUrl(signature) });
    console.log(action, signature);
    await persist();
    await pause(1500);
  };

  const priceKey = PYTH_PRICE_UPDATE_ACCOUNT;
  const readPrice = async () => decodePriceUpdateV2((await c.getAccountInfo(priceKey))!.data);

  const posted: InstanceType<typeof import("@solana/web3.js").PublicKey>[] = [];
  try {
    // Fund the borrower with enough SOL for collateral, rent and fees, plus the 0.005 USDC interest.
    await record(
      "fund-borrower",
      await sendAndConfirmTransaction(
        c,
        new Transaction().add(
          SystemProgram.transfer({ fromPubkey: lender.publicKey, toPubkey: borrower.publicKey, lamports: 60_000_000 }),
          createAssociatedTokenAccountIdempotentInstruction(
            lender.publicKey,
            getAssociatedTokenAddressSync(usdc, borrower.publicKey),
            borrower.publicKey,
            usdc
          ),
          createTransferInstruction(
            getAssociatedTokenAddressSync(usdc, lender.publicKey),
            getAssociatedTokenAddressSync(usdc, borrower.publicKey),
            lender.publicKey,
            DEBT - PRINCIPAL
          )
        ),
        [lenderKey],
        { commitment: "confirmed" }
      )
    );

    const collateral = (minCollateralLamports(DEBT, 7000, await readPrice()) * 150n + 99n) / 100n;
    await record("wrap-collateral", await tx.sendWrapSol(borrower, collateral));

    // Post and cancel.
    const first = await tx.sendCreateRequest(borrower, { ...terms, collateralAmount: collateral, requestId: randomOfferId() });
    posted.push(first.request);
    await record("create-request", first.signature);
    assert.equal((await fetchRequestByKey(c, first.request))?.status, "open");
    await record("cancel-request", await tx.sendCancelRequest(borrower, first.request, wsol));
    assert.equal((await fetchRequestByKey(c, first.request))?.status, "cancelled");
    await record("close-cancelled-request", await tx.sendCloseRequest(borrower, first.request));
    assert.equal(await fetchRequestByKey(c, first.request), null);

    // Post, fund, repay.
    const second = await tx.sendCreateRequest(borrower, { ...terms, collateralAmount: collateral, requestId: randomOfferId() });
    posted.push(second.request);
    await record("create-request", second.signature);
    for (const sig of await refreshPyth(c, lenderKey)) await record("pyth-update", sig);
    const funded = await tx.sendFundRequest(
      lender,
      second.request,
      borrower.publicKey,
      randomOfferId(),
      usdc,
      wsol,
      priceKey
    );
    await record("fund-request", funded.signature);
    const r = await fetchRequestByKey(c, second.request);
    assert.equal(r?.status, "funded");
    assert.equal(r?.offer, funded.offer.toBase58());
    const o = await fetchOfferByKey(c, funded.offer);
    assert.equal(o?.status, "filled");
    assert.equal(o?.borrower, borrower.publicKey.toBase58());

    await record("repay", await tx.sendRepayLoan(borrower, funded.offer, lender.publicKey, usdc, wsol));
    assert.equal((await fetchOfferByKey(c, funded.offer))?.status, "repaid");
    await record("close-offer", await tx.sendCloseOffer(lender, funded.offer));
    await record("close-funded-request", await tx.sendCloseRequest(borrower, second.request));
    assert.equal(await fetchRequestByKey(c, second.request), null);
  } finally {
    // Never strand collateral: cancel and close any request this run left open.
    for (const key of posted) {
      try {
        const r = await fetchRequestByKey(c, key);
        if (r?.status === "open") await record("cleanup-cancel-request", await tx.sendCancelRequest(borrower, key, wsol));
        if (r && (await fetchRequestByKey(c, key))?.status !== "open")
          await record("cleanup-close-request", await tx.sendCloseRequest(borrower, key));
      } catch (e) {
        console.error("Request cleanup failed for", key.toBase58(), e);
      }
    }
    // Return everything the temporary borrower holds to the lender.
    const cleanup = new Transaction();
    const bUsdc = getAssociatedTokenAddressSync(usdc, borrower.publicKey);
    const bWsol = getAssociatedTokenAddressSync(wsol, borrower.publicKey);
    const usdcInfo = await c.getAccountInfo(bUsdc);
    if (usdcInfo) {
      const amount = BigInt((await c.getTokenAccountBalance(bUsdc)).value.amount);
      if (amount > 0n)
        cleanup.add(
          createTransferInstruction(bUsdc, getAssociatedTokenAddressSync(usdc, lender.publicKey), borrower.publicKey, amount)
        );
      cleanup.add(createCloseAccountInstruction(bUsdc, lender.publicKey, borrower.publicKey));
    }
    if (await c.getAccountInfo(bWsol))
      cleanup.add(createCloseAccountInstruction(bWsol, lender.publicKey, borrower.publicKey));
    if (cleanup.instructions.length) {
      cleanup.feePayer = lender.publicKey;
      await record("cleanup-token-accounts", await sendAndConfirmTransaction(c, cleanup, [lenderKey, borrowerKey]));
    }
    const left = await c.getBalance(borrower.publicKey);
    if (left > 0) {
      const sweep = new Transaction().add(
        SystemProgram.transfer({ fromPubkey: borrower.publicKey, toPubkey: lender.publicKey, lamports: left })
      );
      sweep.feePayer = lender.publicKey;
      await record("return-sol", await sendAndConfirmTransaction(c, sweep, [lenderKey, borrowerKey]));
    }
    assert.equal(await c.getBalance(borrower.publicKey), 0, "temporary borrower is empty");
  }
}

main().then(
  () => console.log("Request smoke passed"),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
