import { PublicKey } from "@solana/web3.js";

export const NETWORK =
  process.env.NEXT_PUBLIC_SOLANA_NETWORK === "localnet" ? "localnet" : "devnet";
export const DEVNET_GENESIS_HASH =
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const WS_URL = process.env.NEXT_PUBLIC_SOLANA_WS_URL || undefined;
export const IS_LOCAL = NETWORK === "localnet";
export const RPC_URL =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
  (IS_LOCAL ? "http://127.0.0.1:8899" : "https://api.devnet.solana.com");
export const DEVNET_USDC_MINT = new PublicKey(
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
);
export const NATIVE_WSOL_MINT = new PublicKey(
  "So11111111111111111111111111111111111111112"
);

export const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_LOAN_PROGRAM_ID ||
    "CKvMgaAJmtoUN73wDxAKvjYs2d5fcirttjjEjrV9hnef"
);

export const PYTH_RECEIVER_PROGRAM_ID = new PublicKey(
  "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ"
);

export const SOL_USD_FEED_ID_HEX =
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

export const SOL_USD_FEED_ID = Buffer.from(SOL_USD_FEED_ID_HEX, "hex");

export const PYTH_PRICE_SHARD = 0;
export const PYTH_PUSH_PROGRAM_ID = new PublicKey(
  "pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT"
);
export const PYTH_PRICE_UPDATE_ACCOUNT = PublicKey.findProgramAddressSync(
  [Buffer.from([PYTH_PRICE_SHARD, 0]), SOL_USD_FEED_ID],
  PYTH_PUSH_PROGRAM_ID
)[0];

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
  name: "Lendspan",
  tagline: "Fixed-term loans against SOL.",
} as const;

export const OFFER_SEED = Buffer.from("offer");
export const USDC_VAULT_SEED = Buffer.from("usdc-vault");
export const WSOL_VAULT_SEED = Buffer.from("wsol-vault");
export const REQUEST_SEED = Buffer.from("request");
export const REQUEST_WSOL_VAULT_SEED = Buffer.from("request-wsol");

export const STORAGE_KEYS = {
  role: `isolated-loan-active-role:${NETWORK}:${PROGRAM_ID.toBase58()}`,
  signerSource: `tenor-signer-source:${NETWORK}:${PROGRAM_ID.toBase58()}`,
  lender: `isolated-loan-lender-keypair:${NETWORK}:${PROGRAM_ID.toBase58()}`,
  borrower: `isolated-loan-borrower-keypair:${NETWORK}:${PROGRAM_ID.toBase58()}`,
  liquidator: `isolated-loan-liquidator-keypair:${NETWORK}:${PROGRAM_ID.toBase58()}`,
  devConfig: `isolated-loan-dev-config:${NETWORK}:${PROGRAM_ID.toBase58()}`,
} as const;

export type ActingRole = "lender" | "borrower" | "liquidator";

export const STALE_PRICE_MESSAGE =
  "The SOL price is too old. Wait for a fresh price and try again.";

export const EXPIRY_SENTENCE =
  "If you do not repay by then, the lender receives your wSOL.";
