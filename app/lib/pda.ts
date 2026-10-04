import { PublicKey } from "@solana/web3.js";
import {
  OFFER_SEED,
  PROGRAM_ID,
  USDC_VAULT_SEED,
  WSOL_VAULT_SEED,
} from "./constants";

/** u64 little-endian. Written byte by byte: the browser Buffer polyfill has no BigInt writers. */
export function u64Le(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let v = BigInt.asUintN(64, value);
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function offerPda(lender: PublicKey, offerId: bigint): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [OFFER_SEED, lender.toBuffer(), u64Le(offerId)],
    PROGRAM_ID,
  );
  return pda;
}

export function usdcVaultPda(offer: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [USDC_VAULT_SEED, offer.toBuffer()],
    PROGRAM_ID,
  );
  return pda;
}

export function wsolVaultPda(offer: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [WSOL_VAULT_SEED, offer.toBuffer()],
    PROGRAM_ID,
  );
  return pda;
}
