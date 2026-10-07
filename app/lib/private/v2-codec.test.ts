import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { auditorHash, decodeDeskPolicy, decodeDeskState, decodeLoanTermsV2, decodeRoomStateV2, policyProblem, v2Pda, PRIVATE_V2_ID } from "./v2-codec";
import { EarlyRepayment } from "../loan-math-v2";

const fx = JSON.parse(readFileSync(new URL("../../../isolated_loan/programs/private_loan_v2/codec-fixture.json", import.meta.url), "utf8"));
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n));

test("room state decodes exactly as the program wrote it", () => {
  const r = decodeRoomStateV2(bytes(fx.roomState.hex));
  assert.equal(r.owner.toBase58(), key(fx.roomState.owner).toBase58());
  assert.equal(r.revision.toString(), fx.roomState.revision);
  assert.equal(r.nextLoanIndex, fx.roomState.nextLoanIndex);
  assert.deepEqual(r.members.map((m) => [m.pubkey.toBytes()[0], m.roles]), fx.roomState.members);
  assert.equal(r.members[0].owner, true);
});

test("loan terms decode with exact u64 and u128 values", () => {
  const t = decodeLoanTermsV2(bytes(fx.loanTerms.hex));
  const f = fx.loanTerms;
  assert.equal(t.originLender.toBase58(), key(f.originLender).toBase58());
  assert.equal(t.currentLender.toBase58(), key(f.currentLender).toBase58());
  assert.equal(t.borrower.toBase58(), key(f.borrower).toBase58());
  assert.equal(t.roomIndex, f.roomIndex);
  assert.equal(t.requestIndex, f.requestIndex);
  assert.equal(t.terms.principal.toString(), f.principal);
  assert.equal(t.terms.earlyRepayment, EarlyRepayment.ProRata);
  assert.equal(t.status, "active");
  assert.equal(t.collateralLocked.toString(), f.collateralLocked);
  assert.equal(t.ledger.outstandingPrincipal.toString(), f.outstandingPrincipal);
  assert.equal(t.ledger.accrualRemainder.toString(), f.accrualRemainder);
  assert.equal(t.ledgerRevision, f.ledgerRevision);
  assert.equal(t.desk?.toBase58(), key(f.desk).toBase58());
  assert.equal(t.policyVersion, f.policyVersion);
  assert.ok(t.auditorHash.every((b) => b === f.auditorHashByte));
});

test("desk state and policy decode", () => {
  const d = decodeDeskState(bytes(fx.deskState.hex));
  assert.equal(d.policyVersion, fx.deskState.policyVersion);
  assert.equal(d.nextLoanSeq, fx.deskState.nextLoanSeq);
  assert.deepEqual(d.members.map((m) => [m.pubkey.toBytes()[0], m.roles]), fx.deskState.members);
  const p = decodeDeskPolicy(bytes(fx.deskPolicy.hex));
  assert.equal(p.version, fx.deskPolicy.version);
  assert.equal(p.maxAnnualCeilingBps, fx.deskPolicy.maxAnnualCeilingBps);
  assert.equal(p.maxPrincipal.toString(), fx.deskPolicy.maxPrincipal);
  assert.deepEqual(p.auditors.map((a) => a.toBytes()[0]), fx.deskPolicy.auditors);
});

test("policy checks mirror the program and the auditor hash is SHA-256 of the keys", async () => {
  const p = decodeDeskPolicy(bytes(fx.deskPolicy.hex));
  const ok = { principal: 10_000_000n, duration: 30 * 86_400, annualCeilingBps: 2_500, interestBps: 500, earlyRepayment: EarlyRepayment.ProRata, maxLtvBps: 6_000, liquidationLtvBps: 8_000, graceSeconds: 86_400, lateFeeBps: 100 };
  assert.equal(policyProblem(p, ok), null);
  assert.match(policyProblem(p, { ...ok, annualCeilingBps: 3_001 })!, /pricing ceiling/);
  assert.match(policyProblem(p, { ...ok, earlyRepayment: EarlyRepayment.FullTerm })!, /early-repayment/);
  const h = await auditorHash(p.auditors);
  const expected = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(key(8).toBytes())));
  assert.deepEqual(h, expected);
  assert.deepEqual(await auditorHash([]), new Uint8Array(32));
});

test("V2 addresses are namespaced and differ from V1", () => {
  const creator = key(1);
  const id = new Uint8Array(32).fill(3);
  const room = v2Pda.room(creator, id);
  assert.notEqual(room.toBase58(), v2Pda.room(key(2), id).toBase58(), "same id, other creator: another room");
  assert.notEqual(v2Pda.deal(room, 0).toBase58(), v2Pda.deal(room, 1).toBase58(), "one deal per request");
  assert.equal(v2Pda.loan(creator, 5n).toBase58(), PublicKey.findProgramAddressSync([Buffer.from("loan"), creator.toBuffer(), Buffer.from([5, 0, 0, 0, 0, 0, 0, 0])], PRIVATE_V2_ID)[0].toBase58());
});
