import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, type Connection } from "@solana/web3.js";
import { BN, BorshInstructionCoder } from "@coral-xyz/anchor";
import { CSV_FOOTER, CSV_HEADER, atomsToDecimal, csvField, nextCursor, rowsAfter, toCsv, type ActivityRow } from "./activity";
import { archivedLoanFacts, eventsToRows, publicActivityRows, replayPublicActivity, type ArchivedTransaction, type ChainEvent, type LoanFacts } from "./public-activity";
import { privateActivityRows } from "./private-activity";
import { EarlyRepayment } from "../loan-math-v2";
import { PROGRAM_V2_ID, readOnlyProgramV2 } from "../v2/program";

const row = (slot: number, signature: string, over: Partial<ActivityRow> = {}): ActivityRow => ({
  timeUtc: "2026-10-07T12:00:00Z", slot, signature, loan: "Loan1", role: "borrower", action: "repay", asset: "USDC",
  amountAtoms: "1500000", amountDecimal: "1.500000", fee: "5000", status: "active", ...over,
});
const rows = [row(10, "b"), row(10, "a"), row(12, "c", { action: "borrow" }), row(9, "z"), row(12, "c", { action: "repay" })];

test("replaying the same rows in any order yields an identical CSV", () => {
  const csv = toCsv(rows);
  assert.equal(toCsv([...rows].reverse()), csv);
  assert.equal(toCsv([...rows, ...rows]), csv, "duplicates from an overlapping replay are dropped");
  const lines = csv.trimEnd().split("\r\n");
  assert.equal(lines[0], CSV_HEADER);
  assert.equal(lines.at(-1), CSV_FOOTER);
  assert.deepEqual(lines.slice(1, -1).map((l) => l.split(",").slice(1, 3).join(":")), ["9:z", "10:a", "10:b", "12:c", "12:c"]);
});

test("a cursor resumes exactly after the last exported row", () => {
  const first = rows.filter((r) => r.slot <= 10);
  const cursor = nextCursor(first)!;
  assert.deepEqual(cursor, { slot: 10, signature: "b" });
  const rest = rowsAfter(rows, cursor);
  assert.deepEqual(rest.map((r) => r.signature), ["c", "c"]);
  assert.equal(toCsv([...rowsAfter(rows, null).filter((r) => r.slot <= 10), ...rest]), toCsv(rows));
  assert.deepEqual(rowsAfter(rows, { slot: 12, signature: "c" }), []);
  assert.equal(nextCursor([]), null);
});

test("fields with commas, quotes and newlines are escaped per RFC 4180", () => {
  assert.equal(csvField("plain"), "plain");
  assert.equal(csvField("a,b"), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField("two\nlines"), '"two\nlines"');
  const csv = toCsv([row(1, "s", { action: 'odd, "action"\r\nx' })]);
  assert.ok(csv.includes('"odd, ""action""\r\nx"'));
  assert.ok(csv.endsWith(`${CSV_FOOTER}\r\n`));
});

test("decimal amounts are exact", () => {
  assert.equal(atomsToDecimal(1_500_000n, 6), "1.500000");
  assert.equal(atomsToDecimal(1n, 9), "0.000000001");
  assert.equal(atomsToDecimal(123_456_789_012_345_678_901n, 6), "123456789012345.678901");
});

test("after a sale, payments are the buyer's rows, not the seller's", () => {
  const [seller, buyer, borrower] = [0, 1, 2].map(() => Keypair.generate().publicKey.toBase58());
  const loan: LoanFacts = {
    publicKey: "Loan1", originLender: seller, borrower, wsolMint: "So11111111111111111111111111111111111111112",
    terms: { principal: 100_000_000n, interestBps: 500, duration: 86_400, startTs: 1, earlyRepayment: EarlyRepayment.ProRata, minInterestBps: 0, graceSeconds: 86_400, lateFeeBps: 0, annualCeilingBps: 10_000 },
  };
  const ev = (slot: number, name: string, data: Record<string, unknown>, feePayer = borrower): ChainEvent => ({ slot, signature: `s${slot}`, blockTime: 1_800_000_000 + slot, fee: 5000, feePayer, name, data });
  const events = [
    ev(5, "PaymentV2", { used: 105_000_000n, closed: true }),
    ev(1, "AcceptedV2", {}),
    ev(2, "PaymentV2", { used: 1_000_000n, closed: false }),
    ev(3, "PositionSoldV2", { seller, buyer, price: 99_000_000n }, buyer),
  ];
  const s = eventsToRows(seller, loan, events);
  assert.deepEqual(s.map((r) => [r.action, r.amountAtoms]), [["lend", "100000000"], ["receive-repayment", "1000000"], ["sell-position", "99000000"]]);
  const b = eventsToRows(buyer, loan, events);
  assert.deepEqual(b.map((r) => [r.action, r.amountAtoms, r.status, r.fee]), [["buy-position", "99000000", "active", "5000"], ["receive-repayment", "105000000", "repaid", "0"]]);
  assert.deepEqual(eventsToRows(borrower, loan, events).map((r) => r.action), ["borrow", "repay", "repay"]);
});

test("private rows come from the rollup ledger only and are stable", () => {
  const k = (s: string) => ({ toBase58: () => s });
  const p = {
    anchor: k("Anchor1"), side: "borrower" as const,
    terms: { currentLender: k("L"), originLender: k("L"), borrower: k("B"), status: "repaid", terms: { principal: 10_000_000n, startTs: 100 }, ledger: { outstandingPrincipal: 0n, interestPaid: 50_000n, lateFeePaid: 0n, lastAccrualTs: 200 }, shortfall: 0n, settledTs: 200 },
  };
  const r = privateActivityRows([p]);
  assert.deepEqual(r.map((x) => x.action), ["borrow", "interest-paid-to-date", "principal-repaid-to-date", "settled-repaid"]);
  assert.ok(r.every((x) => x.fee === "0" && x.signature.startsWith("private:")));
  assert.equal(toCsv(privateActivityRows([p])), toCsv(r));
});

const archivedEvent = (slot: number, signature: string, name: string, data: Record<string, unknown>): ChainEvent => ({ slot, signature, name, data, blockTime: 1800000000 + slot, fee: 5000, feePayer: "borrower" });
const historyFixture = () => {
  const create: ArchivedTransaction = {
    instructions: [{ name: "createOffer", accounts: { offer: "closed-loan", lender: "original", wsolMint: "So11111111111111111111111111111111111111112" }, data: { args: { principal: 100000000n } } }],
    events: [archivedEvent(1, "create", "OfferCreatedV2", { offer: "closed-loan", lender: "original", principal: 100000000n })],
  };
  const accepted: ArchivedTransaction = { instructions: [], events: [archivedEvent(2, "accept", "AcceptedV2", { offer: "closed-loan", borrower: "borrower" })] };
  const buy: ArchivedTransaction = { instructions: [], events: [archivedEvent(3, "buy", "PositionSoldV2", { offer: "closed-loan", seller: "original", buyer: "middle", price: 99000000n })] };
  // Signature lexicographic order opposes chain execution order: sale precedes payment.
  const sell: ArchivedTransaction = { instructions: [], events: [archivedEvent(4, "z-sale", "PositionSoldV2", { offer: "closed-loan", seller: "middle", buyer: "last", price: 98000000n })] };
  const paid: ArchivedTransaction = { instructions: [], events: [archivedEvent(4, "a-payment", "PaymentV2", { offer: "closed-loan", used: 105000000n, closed: true })] };
  return { create, accepted, buy, sell, paid, all: [paid, sell, buy, accepted, create] };
};

test("closed and resold holdings are reconstructed without any live offer account", async () => {
  const h = historyFixture();
  const archive = {
    transactionsFor: async (address: string) => address === "closed-loan" ? h.all : address === "middle" ? [h.sell, h.buy] : [h.paid, h.sell],
    blockSignatures: async () => ["z-sale", "a-payment"],
  };
  const seller = await replayPublicActivity("middle", archive);
  assert.deepEqual(seller.map((r) => r.action), ["buy-position", "sell-position"]);
  const buyer = await replayPublicActivity("last", archive);
  assert.equal(buyer.find((r) => r.action === "receive-repayment")?.amountAtoms, "105000000");
  // Cursor order remains deterministic, but is applied only after chain-order attribution.
  assert.deepEqual(rowsAfter(buyer, { slot: 3, signature: "buy" }).map((r) => r.action), ["receive-repayment", "buy-position"]);
});

test("missing block ordering refuses an export instead of guessing the payment recipient", async () => {
  const h = historyFixture();
  await assert.rejects(replayPublicActivity("middle", { transactionsFor: async (address) => address === "middle" ? [h.buy] : h.all, blockSignatures: async () => [] }), /order is unavailable/);
});

test("a closed request-funded loan recovers its principal from the archived request", () => {
  const tx: ArchivedTransaction = {
    instructions: [{ name: "fundRequest", accounts: { offer: "loan", request: "request", lender: "lender", wsolMint: "jito" }, data: {} }],
    events: [archivedEvent(10, "fund", "AcceptedV2", { offer: "loan", borrower: "borrower" })],
  };
  const request: ArchivedTransaction = { instructions: [{ name: "createRequest", accounts: { request: "request" }, data: { args: { principal: 123456789n } } }], events: [] };
  assert.deepEqual(archivedLoanFacts("loan", [tx], [request]), { publicKey: "loan", originLender: "lender", borrower: "borrower", wsolMint: "jito", terms: { principal: 123456789n } });
  assert.throws(() => archivedLoanFacts("loan", [tx]), /origination history is unavailable/);
});

test("mandate accounting events export each payment and top-up once, retaining keeper fees", () => {
  const h = historyFixture();
  const facts = archivedLoanFacts("closed-loan", h.all);
  const events = [
    archivedEvent(8, "repay", "PaymentV2", { used: 100n, closed: false }),
    archivedEvent(8, "repay", "MandateExecuted", { action: 1, amount: 100n, fee: 2n }),
    archivedEvent(9, "topup", "CollateralAddedV2", { amount: 300n }),
    archivedEvent(9, "topup", "MandateExecuted", { action: 0, amount: 300n, fee: 3n }),
  ];
  assert.deepEqual(eventsToRows("borrower", facts, events).map((r) => [r.action, r.amountAtoms]), [["repay", "100"], ["keeper-fee", "2"], ["add-collateral", "300"], ["keeper-fee", "3"]]);
  assert.deepEqual(eventsToRows("original", facts, events).map((r) => [r.action, r.amountAtoms]), [["receive-repayment", "100"]]);
});

test("RPC archive decodes actual Anchor instruction and event bytes for a closed offer", async () => {
  const program = readOnlyProgramV2();
  const lender = Keypair.generate().publicKey;
  const loan = Keypair.generate().publicKey;
  const definition = program.idl.instructions.find((i) => i.name === "createOffer")!;
  const accounts = definition.accounts.map((a) => ({ pubkey: a.name === "lender" ? lender : a.name === "offer" ? loan : Keypair.generate().publicKey, isSigner: a.name === "lender", isWritable: true }));
  const data = new BorshInstructionCoder(program.idl).encode("createOffer", {
    offerId: new BN(1), restrictedBorrower: PublicKey.default,
    args: { principal: new BN(123456789), interestBps: 500, duration: new BN(86400), earlyRepayment: 1, minInterestBps: 0, graceSeconds: new BN(60), lateFeeBps: 0, annualCeilingBps: 10000, collateralAmount: new BN(1000000000), maxLtvBps: 6000, liquidationLtvBps: 7000 },
  });
  const message = new TransactionMessage({ payerKey: lender, recentBlockhash: PublicKey.default.toBase58(), instructions: [new TransactionInstruction({ programId: PROGRAM_V2_ID, keys: accounts, data })] }).compileToV0Message();
  const event = program.idl.events!.find((e) => e.name === "offerCreatedV2")!;
  const amount = Buffer.alloc(8);
  amount.writeBigUInt64LE(123456789n);
  const log = Buffer.concat([Buffer.from(event.discriminator), loan.toBuffer(), lender.toBuffer(), amount]).toString("base64");
  let reads = 0;
  const connection = {
    getSignaturesForAddress: async () => [{ signature: "creation", slot: 1, err: null }],
    getTransaction: async () => {
      reads++;
      return { slot: 1, blockTime: 1800000000, transaction: { message }, meta: { err: null, fee: 5000, loadedAddresses: { writable: [], readonly: [] }, innerInstructions: [], logMessages: [`Program ${PROGRAM_V2_ID} invoke [1]`, `Program data: ${log}`, `Program ${PROGRAM_V2_ID} success`] } };
    },
  } as unknown as Connection;
  const rows = await publicActivityRows(connection, lender.toBase58());
  assert.deepEqual(rows.map((r) => [r.loan, r.action, r.amountAtoms]), [[loan.toBase58(), "create-offer", "123456789"]]);
  assert.equal(reads, 1, "wallet and loan discovery share the same transaction cache");
});

// The private export must never reach a server: no app API route, no Convex, no fetch, anywhere in
// the modules it imports from this app.
test("the private export module imports nothing that talks to a server", () => {
  const here = __dirname;
  const appRoot = resolve(here, "../..");
  const seen = new Set<string>();
  const resolveLocal = (from: string, spec: string): string | null => {
    const base = spec.startsWith("@/") ? resolve(appRoot, spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(from), spec) : null;
    if (!base) return null;
    for (const c of [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts")]) if (existsSync(c) && c.match(/\.tsx?$/)) return c;
    return null;
  };
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    assert.ok(!/\bfetch\s*\(/.test(src), `${file} calls fetch`);
    assert.ok(!src.includes("/api/"), `${file} names an app API route`);
    const specs = [...src.matchAll(/(?:import|export)[^"']*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1] ?? m[2]);
    for (const spec of specs) {
      assert.ok(!/convex/i.test(spec), `${file} imports ${spec}`);
      const next = resolveLocal(file, spec);
      if (next) visit(next);
      else assert.ok(!spec.startsWith(".") && !spec.startsWith("@/"), `${file}: unresolved local import ${spec}`);
    }
  };
  visit(resolve(here, "private-activity.ts"));
  assert.ok(seen.size >= 2, "the walk followed the module's imports");
});
