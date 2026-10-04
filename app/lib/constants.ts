import { PublicKey } from "@solana/web3.js";

export const RPC_URL = "http://127.0.0.1:8899";

export const PROGRAM_ID = new PublicKey(
  "CKvMgaAJmtoUN73wDxAKvjYs2d5fcirttjjEjrV9hnef",
);

export const PYTH_RECEIVER_PROGRAM_ID = new PublicKey(
  "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ",
);

export const SOL_USD_FEED_ID_HEX =
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

export const SOL_USD_FEED_ID = Buffer.from(SOL_USD_FEED_ID_HEX, "hex");

export const MAX_PRICE_AGE_SECONDS = 60;

/** Caps enforced by the program (constants.rs). The wizard enforces the same ones. */
export const CAPS = {
  maxInterestBps: 2_000,
  maxLtvBps: 7_000,
  maxLiquidationLtvBps: 8_500,
  minLtvGapBps: 500,
  minDurationSeconds: 60,
  maxDurationSeconds: 7_776_000,
} as const;

export const BRAND = {
  name: "Tenor",
  tagline: "Fixed-term loans against SOL.",
} as const;

export const OFFER_SEED = Buffer.from("offer");
export const USDC_VAULT_SEED = Buffer.from("usdc-vault");
export const WSOL_VAULT_SEED = Buffer.from("wsol-vault");

export const STORAGE_KEYS = {
  role: "isolated-loan-active-role",
  signerSource: "tenor-signer-source",
  lender: "isolated-loan-lender-keypair",
  borrower: "isolated-loan-borrower-keypair",
  liquidator: "isolated-loan-liquidator-keypair",
  devConfig: "isolated-loan-dev-config",
} as const;

export type ActingRole = "lender" | "borrower" | "liquidator";

export const STALE_PRICE_MESSAGE =
  "The SOL price is too old. Wait for a fresh price and try again.";

export const EXPIRY_SENTENCE =
  "If you do not repay by then, the lender receives your wSOL.";
