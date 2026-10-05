import { PublicKey } from "@solana/web3.js";
import {
  MAX_PRICE_AGE_SECONDS,
  PYTH_RECEIVER_PROGRAM_ID,
  SOL_USD_FEED_ID,
} from "../constants";
import type { PriceMessage } from "./price-update-codec";
export function validatePriceAccount(
  owner: PublicKey,
  price: PriceMessage,
  now: number,
  requireFresh = true
): void {
  if (!owner.equals(PYTH_RECEIVER_PROGRAM_ID))
    throw new Error("Invalid Pyth price owner");
  if (!price.feedId.equals(SOL_USD_FEED_ID))
    throw new Error("Invalid SOL/USD feed");
  if (
    price.price <= 0n ||
    price.conf >= price.price ||
    price.conf * 10_000n > price.price * 200n
  )
    throw new Error("Invalid Pyth price or confidence");
  if (price.exponent < -12 || price.exponent > -3)
    throw new Error("Invalid Pyth exponent");
  if (
    price.publishTime > BigInt(now) ||
    (requireFresh &&
      BigInt(now) - price.publishTime > BigInt(MAX_PRICE_AGE_SECONDS))
  )
    throw new Error(
      "The SOL price is stale or future dated. Post a fresh Pyth update and retry."
    );
}
