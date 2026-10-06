/**
 * Devnet proof of the full lender and borrower cycle (story 18.1).
 * The configured CLI wallet lends; a temporary in-memory wallet borrows and bids.
 *   A. Public offer: create → accept → both My loans views → repay → close.
 *   B. Public request: post → fund (60 s term) → deadline passes → My loans says "Claim" → claim → close.
 *   C. Private: open room → invite → the invitee finds it by listing → the invitee bids →
 *      the room lists the loan for the borrower → the bid shows in the invitee's bids → cancel.
 * Everything the temporary wallet holds goes back to the lender in `finally`. Never prints keys.
 * The temporary key is written to a 0600 file in the OS temp folder while the run is live, so a
 * run cut short (rate limits, a closed laptop) can still be repaid or swept; it is deleted once empty.
 * Resume with: CYCLE_BORROWER_FILE=<that path> npx tsx --env-file=.env.local scripts/cycle-smoke.ts --run
 * Run: npx tsx --env-file=.env.local scripts/cycle-smoke.ts --run
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Public Devnet RPC answers 429 under bursts; back off and try again. */
async function retry<T>(f: () => Promise<T>, label: string, tries = 7): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e) {
      const msg = String(e);
      if (i >= tries - 1 || !/429|rate limit|Too Many|fetch failed|timed out/i.test(msg)) throw e;
      const wait = Math.min(30_000, 1_500 * 2 ** i);
      console.log(`  ${label}: rate limited, retrying in ${Math.round(wait / 1000)}s`);
      await pause(wait);
    }
  }
}

async function main() {
  if (!process.argv.includes("--run")) throw new Error("This submits Devnet transactions. Pass --run explicitly.");
  process.env.NEXT_PUBLIC_SOLANA_NETWORK = "devnet";
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||= "https://api.devnet.solana.com";
  // The private helpers keep receipts in browser storage; give them a memory one.
  const mem = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage ??= {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  };

  const { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } = await import("@solana/web3.js");
  const spl = await import("@solana/spl-token");
  const nacl = (await import("tweetnacl")).default;
  const { getAuthToken } = await import("@magicblock-labs/ephemeral-rollups-sdk");
  const { getConnection } = await import("../lib/program");
  const { KeypairWallet } = await import("../lib/keypair-wallet");
  const { DEVNET_GENESIS_HASH, DEVNET_USDC_MINT: usdc, NATIVE_WSOL_MINT: wsol, PROGRAM_ID, PYTH_PRICE_UPDATE_ACCOUNT: priceKey } =
    await import("../lib/constants");
  const { signatureUrl } = await import("../lib/transaction-lifecycle");
  const tx = await import("../lib/transactions");
  const { fetchOfferByKey } = await import("../lib/offers");
  const { fetchRequestByKey } = await import("../lib/requests");
  const { randomOfferId } = await import("../lib/offer-id");
  const { decodePriceUpdateV2 } = await import("../lib/server/price-update-codec");
  const { minCollateralLamports } = await import("../lib/risk");
  const { fetchMine, buildPortfolio, URGENCY } = await import("../lib/portfolio");
  const { openRoom, inviteMember } = await import("../lib/private/rooms");
  const { listMyRooms, listRoomLoans, listMyBids } = await import("../lib/private/inbox");
  const { proposeLoan, cancelLoan, readLoan } = await import("../lib/private/loans");
  const { refreshPyth } = await import("./pyth-refresh");
  assert.ok(process.env.PYTH_HERMES_API_KEY, "Load app/.env.local: npx tsx --env-file=.env.local scripts/cycle-smoke.ts --run");

  const c = getConnection();
  assert.equal(await c.getGenesisHash(), DEVNET_GENESIS_HASH);
  const file = process.env.ANCHOR_WALLET || path.join(os.homedir(), ".config/solana/id.json");
  const lenderKey = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await fs.readFile(file, "utf8"))));
  const lender = new KeypairWallet(lenderKey);
  const resumeFile = process.env.CYCLE_BORROWER_FILE;
  const borrowerKey = resumeFile
    ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await fs.readFile(resumeFile, "utf8"))))
    : Keypair.generate();
  const keyFile = resumeFile ?? path.join(os.tmpdir(), `zenlo-cycle-${borrowerKey.publicKey.toBase58().slice(0, 8)}.json`);
  await fs.writeFile(keyFile, JSON.stringify([...borrowerKey.secretKey]), { mode: 0o600 });
  console.log("temporary borrower key file:", keyFile);
  const borrower = new KeypairWallet(borrowerKey);
  const me = { lender: lender.publicKey.toBase58(), borrower: borrower.publicKey.toBase58() };

  const PRINCIPAL = 100_000n; // 0.10 USDC
  const DEBT = 105_000n;
  const base = { principal: PRINCIPAL, interestBps: 500, maxLtvBps: 7000, liquidationLtvBps: 8000, usdcMint: usdc, wsolMint: wsol };

  const receipts: { step: string; signature: string; url: string }[] = [];
  const checks: string[] = [];
  const evidencePath = path.resolve("../docs/devnet-cycle-evidence.json");
  const persist = () =>
    fs.writeFile(
      evidencePath,
      JSON.stringify(
        { story: "18.1", network: "devnet", programId: PROGRAM_ID.toBase58(), lender: me.lender, borrower: me.borrower, verifiedAt: new Date().toISOString(), checks, receipts },
        null,
        2
      ) + "\n"
    );
  const record = async (step: string, signature: string) => {
    receipts.push({ step, signature, url: signatureUrl(signature) });
    console.log(step, signature);
    await persist();
    await pause(2500);
  };
  const check = async (what: string, ok: boolean) => {
    assert.ok(ok, what);
    checks.push(what);
    console.log("✓", what);
    await persist();
  };
  const now = () => Math.floor(Date.now() / 1000);
  const view = async (wallet: string) => {
    const mine = await retry(() => fetchMine(c, wallet), "read my loans");
    const p = decodePriceUpdateV2((await retry(() => c.getAccountInfo(priceKey), "read price"))!.data);
    // Freshness only matters for liquidation; these checks are about deadlines and sides.
    return buildPortfolio({ me: wallet, ...mine, price: { price: p.price, conf: p.conf, exponent: p.exponent, publishTime: Number(p.publishTime), fresh: true }, now: now() });
  };
  const collateral = async () =>
    (minCollateralLamports(DEBT, 7000, decodePriceUpdateV2((await retry(() => c.getAccountInfo(priceKey), "read price"))!.data)) * 150n + 99n) / 100n;
  const offerStatus = async (k: Parameters<typeof fetchOfferByKey>[1]) => (await retry(() => fetchOfferByKey(c, k), "read offer"))?.status;

  const openOffers: InstanceType<typeof import("@solana/web3.js").PublicKey>[] = [];
  const openRequests: InstanceType<typeof import("@solana/web3.js").PublicKey>[] = [];
  try {
    // The borrower needs SOL for collateral, rent and fees, and the interest in USDC (twice).
    await record(
      "fund-borrower",
      await sendAndConfirmTransaction(
        c,
        new Transaction().add(
          SystemProgram.transfer({ fromPubkey: lender.publicKey, toPubkey: borrower.publicKey, lamports: 150_000_000 }),
          spl.createAssociatedTokenAccountIdempotentInstruction(lender.publicKey, spl.getAssociatedTokenAddressSync(usdc, borrower.publicKey), borrower.publicKey, usdc),
          spl.createTransferInstruction(
            spl.getAssociatedTokenAddressSync(usdc, lender.publicKey),
            spl.getAssociatedTokenAddressSync(usdc, borrower.publicKey),
            lender.publicKey,
            2n * (DEBT - PRINCIPAL)
          )
        ),
        [lenderKey],
        { commitment: "confirmed" }
      )
    );

    // A. Public offer, accepted and repaid.
    const lockA = await collateral();
    await record("wrap-collateral", await tx.sendWrapSol(borrower, lockA));
    const offerA = await tx.sendCreateOffer(lender, { ...base, durationSeconds: 3600, collateralAmount: lockA, offerId: randomOfferId() });
    openOffers.push(offerA.offer);
    await record("A create-offer", offerA.signature);
    for (const sig of await refreshPyth(c, lenderKey)) await record("pyth-update", sig);
    await record("A accept-offer", await tx.sendAcceptOffer(borrower, offerA.offer, lender.publicKey, usdc, wsol, priceKey));
    await pause(2500);
    const lv = await view(me.lender);
    const bv = await view(me.borrower);
    const li = lv.items.find((i) => i.key === offerA.offer.toBase58());
    const bi = bv.items.find((i) => i.key === offerA.offer.toBase58());
    await check("A: the lender's My loans lists the 1-hour loan as lender, due within a day", li?.side === "lender" && li.kind === "loan" && li.urgency === URGENCY.dueSoon);
    await check("A: the borrower's My loans lists the same loan with Repay", bi?.side === "borrower" && bi.action === "Repay");
    await check("A: totals agree across both sides", lv.totals.owedToYou >= DEBT && bv.totals.youOwe === DEBT);
    await record("A repay", await tx.sendRepayLoan(borrower, offerA.offer, lender.publicKey, usdc, wsol));
    await check("A: the offer is repaid", (await offerStatus(offerA.offer)) === "repaid");
    await record("A close-offer", await tx.sendCloseOffer(lender, offerA.offer));
    openOffers.pop();

    // B. Public request funded on a 60 s term, then claimed after the deadline.
    const lockB = await collateral();
    await record("wrap-collateral", await tx.sendWrapSol(borrower, lockB));
    const reqB = await tx.sendCreateRequest(borrower, { ...base, durationSeconds: 60, collateralAmount: lockB, requestId: randomOfferId() });
    openRequests.push(reqB.request);
    await record("B create-request", reqB.signature);
    await check("B: the borrower's My loans shows the open request", (await view(me.borrower)).items.some((i) => i.key === reqB.request.toBase58() && i.kind === "request"));
    for (const sig of await refreshPyth(c, lenderKey)) await record("pyth-update", sig);
    const funded = await tx.sendFundRequest(lender, reqB.request, borrower.publicKey, randomOfferId(), usdc, wsol, priceKey);
    openOffers.push(funded.offer);
    await record("B fund-request", funded.signature);
    const expiry = (await retry(() => fetchOfferByKey(c, funded.offer), "read offer"))!.expiryTs;
    console.log(`waiting ${Math.max(0, expiry - now()) + 8}s for the deadline…`);
    await pause((Math.max(0, expiry - now()) + 8) * 1000);
    const lb = (await view(me.lender)).items.find((i) => i.key === funded.offer.toBase58());
    await check("B: past the deadline, the lender's My loans puts the loan first with Claim collateral", lb?.urgency === URGENCY.pastDue && lb.action === "Claim collateral");
    await record("B claim-expired", await tx.sendClaimExpired(lender, funded.offer, lender.publicKey, borrower.publicKey, wsol));
    await check("B: the loan is expired", (await offerStatus(funded.offer)) === "expired");
    await record("B close-offer", await tx.sendCloseOffer(lender, funded.offer));
    openOffers.pop();
    await record("B close-request", await tx.sendCloseRequest(borrower, reqB.request));
    openRequests.pop();

    // C. Private room: invite, find it without a link, bid, see the bid on both sides, cancel.
    const TEE = "https://devnet-tee.magicblock.app";
    const erFor = async (kp: InstanceType<typeof Keypair>) => {
      const { token } = await getAuthToken(TEE, kp.publicKey, async (m: Uint8Array) => nacl.sign.detached(m, kp.secretKey));
      return new Connection(`${TEE}?token=${token}`, "confirmed");
    };
    const baseConn = c;
    const erOwner = await erFor(lenderKey);
    const erGuest = await erFor(borrowerKey);
    const room = await openRoom(baseConn, erOwner, lender);
    await check("C: the owner opened a room", true);
    await inviteMember(baseConn, erOwner, lender, room.anchor, borrower.publicKey, "lender");
    const guestRooms = await listMyRooms(erGuest, borrower.publicKey);
    await check("C: the invitee finds the room by listing, with the lender role", guestRooms.some((r) => r.roomId === room.roomId && r.role === "lender" && !r.owner));
    const bid = await proposeLoan(baseConn, erGuest, borrower, room.anchor, {
      borrower: lender.publicKey,
      principal: PRINCIPAL,
      interestBps: 500,
      durationSeconds: 3600,
      collateralAmount: await collateral(),
      maxLtvBps: 7000,
      liquidationLtvBps: 8000,
    });
    await pause(2500);
    const ownerSees = await listRoomLoans(erOwner, room.anchor);
    await check("C: the room lists the loan for its borrower without reading the thread", ownerSees.some((l) => l.loanId === bid.loanId && l.terms !== null));
    const bids = await listMyBids(erGuest, borrower.publicKey, guestRooms.filter((r) => r.roomId === room.roomId));
    await check("C: the bid appears in the invitee's private bids as proposed", bids.some((b) => b.loan.loanId === bid.loanId && b.state === "draft"));
    await cancelLoan(baseConn, erGuest, borrower, bid.anchor, false);
    await pause(2000);
    await check("C: the cancelled bid reads as settled", (await readLoan(erGuest, bid.anchor))?.status === "cancelled");
  } finally {
    for (const key of openRequests) {
      try {
        const r = await retry(() => fetchRequestByKey(c, key), "cleanup read");
        if (r?.status === "open") await record("cleanup-cancel-request", await tx.sendCancelRequest(borrower, key, wsol));
        if (await retry(() => fetchRequestByKey(c, key), "cleanup read")) await record("cleanup-close-request", await tx.sendCloseRequest(borrower, key));
      } catch (e) {
        console.error("request cleanup failed", key.toBase58(), e);
      }
    }
    for (const key of openOffers) {
      try {
        const o = await retry(() => fetchOfferByKey(c, key), "cleanup read");
        const t = Math.floor(Date.now() / 1000);
        if (o?.status === "open") await record("cleanup-cancel-offer", await tx.sendCancelOffer(lender, key, usdc));
        // A loan this run accepted but could not finish: repay it with the temporary key, or claim once expired.
        if (o?.status === "filled" && o.borrower === me.borrower && t < o.expiryTs)
          await record("cleanup-repay", await tx.sendRepayLoan(borrower, key, lender.publicKey, usdc, wsol));
        if (o?.status === "filled" && o.borrower && t >= o.expiryTs)
          await record("cleanup-claim", await tx.sendClaimExpired(lender, key, lender.publicKey, new PublicKey(o.borrower), wsol));
        const after = await retry(() => fetchOfferByKey(c, key), "cleanup read");
        if (after && after.status !== "open" && after.status !== "filled") await record("cleanup-close-offer", await tx.sendCloseOffer(lender, key));
      } catch (e) {
        console.error("offer cleanup failed", key.toBase58(), e);
      }
    }
    const cleanup = new Transaction();
    const bUsdc = spl.getAssociatedTokenAddressSync(usdc, borrower.publicKey);
    const bWsol = spl.getAssociatedTokenAddressSync(wsol, borrower.publicKey);
    if (await retry(() => c.getAccountInfo(bUsdc), "cleanup read")) {
      const amount = BigInt((await retry(() => c.getTokenAccountBalance(bUsdc), "cleanup read")).value.amount);
      if (amount > 0n) cleanup.add(spl.createTransferInstruction(bUsdc, spl.getAssociatedTokenAddressSync(usdc, lender.publicKey), borrower.publicKey, amount));
      cleanup.add(spl.createCloseAccountInstruction(bUsdc, lender.publicKey, borrower.publicKey));
    }
    if (await retry(() => c.getAccountInfo(bWsol), "cleanup read")) cleanup.add(spl.createCloseAccountInstruction(bWsol, lender.publicKey, borrower.publicKey));
    if (cleanup.instructions.length) {
      cleanup.feePayer = lender.publicKey;
      await record("cleanup-token-accounts", await sendAndConfirmTransaction(c, cleanup, [lenderKey, borrowerKey]));
    }
    const left = await retry(() => c.getBalance(borrower.publicKey), "cleanup read");
    if (left > 0) {
      const sweep = new Transaction().add(SystemProgram.transfer({ fromPubkey: borrower.publicKey, toPubkey: lender.publicKey, lamports: left }));
      sweep.feePayer = lender.publicKey;
      await record("return-sol", await sendAndConfirmTransaction(c, sweep, [lenderKey, borrowerKey]));
    }
    // Keep the key only while the temporary wallet still holds something.
    if ((await retry(() => c.getBalance(borrower.publicKey), "cleanup read")) === 0) await fs.rm(keyFile, { force: true });
    else console.log("temporary wallet not empty; key kept at", keyFile);
  }
}

main().then(
  () => console.log("Cycle smoke passed"),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
