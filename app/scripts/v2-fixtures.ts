/**
 * Opens the long-duration V2 Devnet fixtures (Story 21.1) and drives the short ones to the end.
 * The seven-day recovery window is never shortened: each fixture is a real 60-second loan with a
 * 24-hour grace, and the later steps run when their real windows open (`--step <name>`).
 *
 *   npx tsx --env-file=.env.local scripts/v2-fixtures.ts --run open      # open all five
 *   npx tsx --env-file=.env.local scripts/v2-fixtures.ts --run status    # phases and payoffs
 *   npx tsx --env-file=.env.local scripts/v2-fixtures.ts --run step <late-repay|overdue|priced|terminal>
 *
 * Wallets: the lender is the Solana CLI key; the fixture borrower and the keeper live in
 * ~/.config/zenlo/fixtures (0600). Results append to docs/v2-fixtures.json. Never prints keys.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const EVIDENCE = path.join(__dirname, "..", "..", "docs", "v2-fixtures.json");
const KEYS = path.join(os.homedir(), ".config", "zenlo", "fixtures");

async function main() {
  if (!process.argv.includes("--run")) throw new Error("This submits Devnet transactions. Pass --run explicitly.");
  process.env.NEXT_PUBLIC_SOLANA_NETWORK = "devnet";
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||= "https://api.devnet.solana.com";
  const web3 = await import("@solana/web3.js");
  const spl = await import("@solana/spl-token");
  const { Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } = web3;
  const { getConnection } = await import("../lib/program");
  const { KeypairWallet } = await import("../lib/keypair-wallet");
  const { DEVNET_GENESIS_HASH, DEVNET_USDC_MINT: usdc, NATIVE_WSOL_MINT: wsol, PYTH_PRICE_UPDATE_ACCOUNT: priceKey } = await import("../lib/constants");
  const { decodePriceUpdateV2 } = await import("../lib/server/price-update-codec");
  const { minCollateralLamports } = await import("../lib/risk");
  const { randomOfferId } = await import("../lib/offer-id");
  const m2 = await import("../lib/loan-math-v2");
  const v2 = await import("../lib/v2/transactions");
  const { fetchOfferV2, fetchOffersV2 } = await import("../lib/v2/offers");
  const { refreshPyth } = await import("./pyth-refresh");

  const c = getConnection();
  assert.equal(await c.getGenesisHash(), DEVNET_GENESIS_HASH);
  const load = (file: string) => web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
  const keyAt = (name: string) => {
    fs.mkdirSync(KEYS, { recursive: true });
    const file = path.join(KEYS, `${name}.json`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify([...Keypair.generate().secretKey]), { mode: 0o600 });
    return load(file);
  };
  const lenderKey = load(process.env.ANCHOR_WALLET || path.join(os.homedir(), ".config/solana/id.json"));
  const borrowerKey = keyAt("v2-borrower");
  const keeperKey = keyAt("keeper");
  const [lender, borrower, keeper] = [lenderKey, borrowerKey, keeperKey].map((k) => new KeypairWallet(k));

  type Fixture = { name: string; offer: string; plan: string; maturity: string; graceEnd: string; pricedFrom: string; terminalFrom: string; steps: { at: string; step: string; signature?: string; note?: string }[] };
  const evidence: { program: string; network: string; fixtures: Fixture[] } = fs.existsSync(EVIDENCE)
    ? JSON.parse(fs.readFileSync(EVIDENCE, "utf8"))
    : { program: "8hxagcQkw1Km6PWZgpA92qUnqvnFufC7tx2jvxf9Ko8m", network: "devnet", fixtures: [] };
  const save = () => fs.writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2) + "\n");
  const iso = (s: number) => new Date(s * 1000).toISOString();
  const log = (f: Fixture, step: string, signature?: string, note?: string) => {
    f.steps.push({ at: new Date().toISOString(), step, signature, note });
    save();
    console.log(`${f.name}: ${step}${signature ? ` ${signature}` : ""}${note ? ` (${note})` : ""}`);
  };

  async function fund(to: InstanceType<typeof PublicKey>, lamports: number) {
    if ((await c.getBalance(to)) >= lamports) return;
    await sendAndConfirmTransaction(c, new Transaction().add(SystemProgram.transfer({ fromPubkey: lenderKey.publicKey, toPubkey: to, lamports })), [lenderKey]);
  }
  async function wrap(owner: InstanceType<typeof Keypair>, lamports: bigint) {
    const ata = spl.getAssociatedTokenAddressSync(wsol, owner.publicKey);
    const t = new Transaction().add(
      spl.createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, ata, owner.publicKey, wsol),
      SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: ata, lamports: Number(lamports) }),
      spl.createSyncNativeInstruction(ata),
    );
    await sendAndConfirmTransaction(c, t, [owner]);
  }
  async function price() {
    await refreshPyth(c, lenderKey);
    const d = decodePriceUpdateV2((await c.getAccountInfo(priceKey))!.data as Buffer);
    return { price: BigInt(d.price), conf: BigInt(d.conf), exponent: d.exponent };
  }
  /** After an uncertain send, wait and look at the chain; rethrow if the effect is not there. */
  async function settle(e: unknown, check: () => Promise<unknown>): Promise<string | undefined> {
    const sig = (e as { signature?: string }).signature;
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 10_000));
      if (await check().catch(() => null)) return sig;
    }
    throw e;
  }
  const offerOf = async (f: Fixture) => (await fetchOfferV2(c, new PublicKey(f.offer)))!;

  const cmd = process.argv[process.argv.indexOf("--run") + 1];
  if (cmd === "open") {
    await fund(borrowerKey.publicKey, 300_000_000);
    const p = await price();
    const base = {
      principal: 1_000_000n,
      interestBps: 100,
      duration: 60,
      earlyRepayment: m2.EarlyRepayment.ProRata,
      minInterestBps: m2.DEFAULT_MIN_INTEREST_BPS,
      graceSeconds: m2.DEFAULT_GRACE_SECONDS,
      lateFeeBps: m2.DEFAULT_LATE_FEE_BPS,
      // Devnet test setting. 1% over a 60-second term plus 24-hour grace is about 365% a year, so a
      // 400% ceiling admits it and then clamps the late fee: the ceiling visibly takes precedence.
      annualCeilingBps: 40_000,
      maxLtvBps: 7_000,
      liquidationLtvBps: 8_000,
    };
    const plans: [string, string, Partial<typeof base>][] = [
      ["terminal", "Untouched. The lender takes all collateral without a price at grace end + 7 days.", {}],
      ["priced", "Untouched. The lender takes payoff-equivalent wSOL, with the surplus returned, at grace end + 24 hours.", {}],
      ["overdue", "Untouched. The reference liquidator pays the payoff after grace and the surplus returns.", {}],
      ["late-repay", "Partial now. The rest is repaid in grace with the late fee.", {}],
      ["top-up", "One-day term. Top up, then repay early at the pro-rata minimum.", { duration: 86_400 }],
    ];
    let wrapped = 0n;
    for (const [name, plan, over] of plans) {
      if (evidence.fixtures.some((f) => f.name === name && f.steps.length)) continue;
      const t = { ...base, ...over };
      const terms = { ...t, startTs: 0 };
      const problem = m2.validateTermsV2(terms);
      assert.equal(problem, null, problem ?? "");
      const exposure = m2.maxExposure(terms);
      const collateral = (minCollateralLamports(exposure, t.maxLtvBps, p) * 125n) / 100n;
      if (wrapped < collateral * 2n) {
        await wrap(borrowerKey, collateral * 3n);
        wrapped += collateral * 3n;
      }
      wrapped -= collateral;
      // Public RPC sometimes loses a confirmation. Adopt an untracked open offer with these terms
      // before creating another, and check the chain after any uncertain send.
      const tracked = new Set(evidence.fixtures.map((x) => x.offer));
      const orphan = (await fetchOffersV2(c, { side: "originLender", wallet: lenderKey.publicKey.toBase58() })).find(
        (x) => x.status === "open" && !tracked.has(x.publicKey) && x.terms.duration === t.duration,
      );
      let offer: InstanceType<typeof PublicKey>;
      let signature: string | undefined;
      if (orphan) offer = new PublicKey(orphan.publicKey);
      else {
        const id = randomOfferId();
        offer = (await import("../lib/v2/program")).offerV2Pda(lenderKey.publicKey, id);
        signature = await v2.sendCreateOfferV2(lender, id, { ...t, collateralAmount: collateral }).then((r) => r.signature, (e) => settle(e, () => fetchOfferV2(c, offer)));
      }
      const created = (await fetchOfferV2(c, offer))!;
      const accepted = await v2.sendAcceptOfferV2(borrower, created).catch((e) => settle(e, async () => ((await fetchOfferV2(c, offer))?.status === "active" ? true : null)));
      const o = (await fetchOfferV2(c, offer))!;
      assert.equal(o.status, "active");
      const f: Fixture = {
        name,
        offer: offer.toBase58(),
        plan,
        maturity: iso(m2.maturity(o.terms)),
        graceEnd: iso(m2.graceEnd(o.terms)),
        pricedFrom: iso(m2.pricedRecoveryFrom(o.terms)),
        terminalFrom: iso(m2.terminalClaimFrom(o.terms)),
        steps: [],
      };
      evidence.fixtures = evidence.fixtures.filter((x) => x.name !== name);
      evidence.fixtures.push(f);
      log(f, "created", signature, orphan ? "adopted an offer whose confirmation was lost" : undefined);
      log(f, "accepted", accepted, `collateral ${collateral} lamports`);
    }
    return;
  }

  if (cmd === "adopt") {
    // Record a fixture whose confirmation was lost after it went live.
    const [name, key] = process.argv.slice(process.argv.indexOf("adopt") + 1);
    const o = (await fetchOfferV2(c, new PublicKey(key)))!;
    assert.equal(o.status, "active");
    const f: Fixture = {
      name, offer: key, plan: "Untouched. Left for the reference liquidator to settle on its own after grace.",
      maturity: iso(m2.maturity(o.terms)), graceEnd: iso(m2.graceEnd(o.terms)), pricedFrom: iso(m2.pricedRecoveryFrom(o.terms)), terminalFrom: iso(m2.terminalClaimFrom(o.terms)), steps: [],
    };
    evidence.fixtures.push(f);
    log(f, "adopted", undefined, "created and accepted in a run whose confirmation was lost");
    return;
  }

  if (cmd === "status") {
    const now = Math.floor(Date.now() / 1000);
    for (const f of evidence.fixtures) {
      const o = await offerOf(f);
      console.log(`${f.name.padEnd(10)} ${o.status.padEnd(16)} phase=${m2.phase(o.terms, now).padEnd(14)} payoff=${o.status === "active" ? m2.payoff(o.terms, o.ledger, now) : 0n} next=${f.plan}`);
    }
    return;
  }

  if (cmd === "step") {
    const which = process.argv[process.argv.indexOf("step") + 1];
    const f = evidence.fixtures.find((x) => x.name === which);
    assert.ok(f, `No fixture named ${which}`);
    const o = await offerOf(f);
    const now = Math.floor(Date.now() / 1000);
    if (which === "late-repay") {
      if (o.ledger.interestPaid === 0n && m2.phase(o.terms, now) === "Active") {
        log(f, "partial", await v2.sendRepayV2(borrower, o, 400_000n), "0.4 USDC before maturity");
        return;
      }
      assert.notEqual(m2.phase(o.terms, now), "Active", "Wait for maturity: the late fee needs the grace window.");
      const payoff = m2.payoff(o.terms, o.ledger, now + 30);
      log(f, "repaid in grace", await v2.sendRepayV2(borrower, o, payoff), `payoff ${payoff} atoms including the late fee`);
    } else if (which === "top-up") {
      log(f, "top-up", await v2.sendAddCollateralV2(borrower, o, 5_000_000n), "0.005 wSOL");
      const fresh = (await offerOf(f))!;
      const payoff = m2.payoff(fresh.terms, fresh.ledger, now + 30);
      log(f, "repaid early", await v2.sendRepayV2(borrower, fresh, payoff), `payoff ${payoff} atoms`);
    } else if (which === "overdue") {
      await fund(keeperKey.publicKey, 50_000_000);
      const keeperUsdc = spl.getAssociatedTokenAddressSync(usdc, keeperKey.publicKey);
      const bal = await c.getTokenAccountBalance(keeperUsdc).catch(() => null);
      if (!bal || BigInt(bal.value.amount) < 2_000_000n) {
        const t = new Transaction().add(
          spl.createAssociatedTokenAccountIdempotentInstruction(lenderKey.publicKey, keeperUsdc, keeperKey.publicKey, usdc),
          spl.createTransferInstruction(spl.getAssociatedTokenAddressSync(usdc, lenderKey.publicKey), keeperUsdc, lenderKey.publicKey, 2_000_000),
        );
        await sendAndConfirmTransaction(c, t, [lenderKey]);
      }
      await price();
      log(f, "overdue liquidation", await v2.sendLiquidateV2(keeper, o, true));
    } else if (which === "priced") {
      await price();
      log(f, "priced recovery", await v2.sendLenderClaimV2(lender, o, false));
    } else if (which === "terminal") {
      log(f, "terminal claim", await v2.sendLenderClaimV2(lender, o, true));
    }
    const after = await offerOf(f);
    log(f, `status ${after.status}`, undefined, after.shortfall ? `shortfall ${after.shortfall}` : undefined);
    return;
  }
  throw new Error("Commands: open, status, step <name>");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
