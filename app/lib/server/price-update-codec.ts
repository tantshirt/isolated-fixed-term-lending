import { createHash } from "crypto";
import { PublicKey } from "@solana/web3.js";

/**
 * Pyth `PriceUpdateV2`, Borsh layout, as pyth-solana-receiver-sdk 2.0 defines it:
 * discriminator(8) write_authority(32) verification_level(1 for Full, 2 for Partial)
 * feed_id(32) price(i64) conf(u64) exponent(i32) publish_time(i64)
 * prev_publish_time(i64) ema_price(i64) ema_conf(u64) posted_slot(u64).
 * Written by hand because Anchor's coder cannot load the receiver IDL.
 */
export const PRICE_UPDATE_V2_LEN = 8 + 32 + 2 + 32 + 8 + 8 + 4 + 8 + 8 + 8 + 8 + 8;

const DISCRIMINATOR = createHash("sha256").update("account:PriceUpdateV2").digest().subarray(0, 8);

export type PriceMessage = {
  feedId: Buffer;
  price: bigint;
  conf: bigint;
  exponent: number;
  publishTime: bigint;
};

export function encodePriceUpdateV2(writeAuthority: PublicKey, msg: PriceMessage, postedSlot = 0n): Buffer {
  const b = Buffer.alloc(PRICE_UPDATE_V2_LEN);
  let o = 0;
  DISCRIMINATOR.copy(b, o);
  o += 8;
  writeAuthority.toBuffer().copy(b, o);
  o += 32;
  b.writeUInt8(1, o); // VerificationLevel::Full
  o += 1;
  msg.feedId.copy(b, o);
  o += 32;
  b.writeBigInt64LE(msg.price, o);
  o += 8;
  b.writeBigUInt64LE(msg.conf, o);
  o += 8;
  b.writeInt32LE(msg.exponent, o);
  o += 4;
  b.writeBigInt64LE(msg.publishTime, o);
  o += 8;
  b.writeBigInt64LE(msg.publishTime - 1n, o);
  o += 8;
  b.writeBigInt64LE(msg.price, o); // ema_price
  o += 8;
  b.writeBigUInt64LE(msg.conf, o); // ema_conf
  o += 8;
  b.writeBigUInt64LE(postedSlot, o);
  return b;
}

export function decodePriceUpdateV2(data: Buffer): PriceMessage {
  if (data.length < PRICE_UPDATE_V2_LEN - 1 || !data.subarray(0, 8).equals(DISCRIMINATOR)) {
    throw new Error("Not a PriceUpdateV2 account");
  }
  let o = 40;
  const level = data.readUInt8(o);
  o += level === 0 ? 2 : 1; // Partial carries num_signatures
  const feedId = Buffer.from(data.subarray(o, o + 32));
  o += 32;
  const price = data.readBigInt64LE(o);
  o += 8;
  const conf = data.readBigUInt64LE(o);
  o += 8;
  const exponent = data.readInt32LE(o);
  o += 4;
  const publishTime = data.readBigInt64LE(o);
  return { feedId, price, conf, exponent, publishTime };
}
