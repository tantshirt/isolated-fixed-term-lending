import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair } from "@solana/web3.js";
import { MAX_BODY, MAX_MEMBERS, MAX_MESSAGES, decodeRoomState, decodeRoomThread, encodeMessage } from "./private/room-codec";

const STATE_LEN = 1 + 32 + 8 + MAX_MEMBERS * 34;
const THREAD_LEN = 4 + MAX_MESSAGES * (32 + 8 + 2 + MAX_BODY);

test("room state decodes active members and marks the owner", () => {
  const owner = Keypair.generate().publicKey;
  const lender = Keypair.generate().publicKey;
  const gone = Keypair.generate().publicKey;
  const data = new Uint8Array(STATE_LEN);
  const v = new DataView(data.buffer);
  data[0] = 1;
  data.set(owner.toBytes(), 1);
  v.setBigUint64(33, 3n, true);
  const slot = (i: number, k: Uint8Array, role: number, active: boolean) => {
    const o = 41 + i * 34;
    data.set(k, o);
    data[o + 32] = role;
    data[o + 33] = active ? 1 : 0;
  };
  slot(0, owner.toBytes(), 3, true);
  slot(1, lender.toBytes(), 2, true);
  slot(2, gone.toBytes(), 1, false);
  const s = decodeRoomState(data);
  assert.equal(s.revision, 3n);
  assert.equal(s.members.length, 2);
  assert.equal(s.members[0].owner, true);
  assert.equal(s.members[1].role, "lender");
});

test("thread keeps the last sixteen messages in order", () => {
  const data = new Uint8Array(THREAD_LEN);
  const v = new DataView(data.buffer);
  const author = Keypair.generate().publicKey;
  const total = MAX_MESSAGES + 3;
  v.setUint32(0, total, true);
  for (let i = 0; i < total; i++) {
    const o = 4 + (i % MAX_MESSAGES) * (42 + MAX_BODY);
    const body = new TextEncoder().encode(`m${i}`);
    data.set(author.toBytes(), o);
    v.setBigInt64(o + 32, BigInt(1000 + i), true);
    v.setUint16(o + 40, body.length, true);
    data.set(body, o + 42);
  }
  const msgs = decodeRoomThread(data);
  assert.equal(msgs.length, MAX_MESSAGES);
  assert.equal(msgs[0].body, "m3");
  assert.equal(msgs.at(-1)?.body, `m${total - 1}`);
});

test("messages are 1 to 140 bytes", () => {
  assert.throws(() => encodeMessage("   "));
  assert.throws(() => encodeMessage("x".repeat(MAX_BODY + 1)));
  assert.equal(encodeMessage("hi").length, 2);
});
