import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { bidState, newInvitations, ROOM_STATE_LEN, LOAN_ANCHOR_ROOM_OFFSET, type MyRoom } from "./inbox";
import type { LoanTerms } from "./loan-codec";

const terms = (status: LoanTerms["status"]): LoanTerms => ({
  lender: PublicKey.default,
  borrower: PublicKey.default,
  principal: 1n,
  interestBps: 100,
  durationSeconds: 60,
  collateralAmount: 1n,
  maxLtvBps: 7000,
  liquidationLtvBps: 8000,
  revision: 1,
  fundedRevision: 0,
  acceptedRevision: 0,
  status,
  startTs: 0,
  expiryTs: 0,
});

const room = (roomId: string, owner = false): MyRoom => ({
  roomId,
  anchor: Keypair.generate().publicKey,
  state: { owner: PublicKey.default, revision: 1n, members: [] },
  role: "lender",
  owner,
});

test("layout constants match the program", () => {
  assert.equal(ROOM_STATE_LEN, 313); // RoomState::LEN in room.rs
  assert.equal(LOAN_ANCHOR_ROOM_OFFSET, 40); // discriminator + loan_id
});

test("a bid reads as the lender sees it", () => {
  assert.equal(bidState(terms("draft")), "draft");
  assert.equal(bidState(terms("funded")), "funded");
  assert.equal(bidState(terms("active")), "accepted");
  for (const s of ["repaid", "expired", "liquidated", "cancelled"] as const) assert.equal(bidState(terms(s)), "settled");
});

test("invitations are rooms you joined but never opened or dismissed, and never your own", () => {
  const rooms = [room("a"), room("b"), room("c"), room("mine", true)];
  assert.deepEqual(
    newInvitations(rooms, ["a"], ["b"]).map((r) => r.roomId),
    ["c"]
  );
});

test("the join queue reads oldest first after it wraps", async () => {
  const { decodeJoinQueue } = await import("./discovery");
  const keys = Array.from({ length: 18 }, () => Keypair.generate().publicKey);
  const d = new Uint8Array(4 + 16 * 40);
  const v = new DataView(d.buffer);
  keys.forEach((k, i) => {
    const o = 4 + (i % 16) * 40;
    d.set(k.toBytes(), o);
    v.setBigInt64(o + 32, BigInt(1000 + i), true);
  });
  v.setUint32(0, 18, true);
  const q = decodeJoinQueue(d);
  assert.equal(q.length, 16);
  assert.equal(q[0].at, 1002);
  assert.equal(q[15].at, 1017);
  assert.ok(q[15].wallet.equals(keys[17]));
});
