import {
  IS_LOCAL,
  DEVNET_USDC_MINT,
  NATIVE_WSOL_MINT,
  PYTH_PRICE_UPDATE_ACCOUNT,
} from "../constants";
import fs from "fs/promises";
import path from "path";

export type DevConfig = {
  usdcMint: string;
  wsolMint: string;
  priceUpdateAccount: string;
  priceWriteAuthority: string;
  lender: string;
  borrower: string;
  liquidator: string;
  admin: string;
};

const CONFIG_PATH = path.join(process.cwd(), ".local", "dev-config.json");

export async function readDevConfig(): Promise<DevConfig | null> {
  if (!IS_LOCAL) {
    const target = process.env.PYTH_PRICE_UPDATE_ACCOUNT;
    if (target && target !== PYTH_PRICE_UPDATE_ACCOUNT.toBase58())
      throw new Error(
        `Unsupported PYTH_PRICE_UPDATE_ACCOUNT. Reads and wallet refresh must use shard 0: ${PYTH_PRICE_UPDATE_ACCOUNT.toBase58()}. Remove the override or configure that account.`
      );
    return {
      usdcMint: DEVNET_USDC_MINT.toBase58(),
      wsolMint: NATIVE_WSOL_MINT.toBase58(),
      priceUpdateAccount: PYTH_PRICE_UPDATE_ACCOUNT.toBase58(),
      priceWriteAuthority: "",
      lender: "",
      borrower: "",
      liquidator: "",
      admin: "",
    };
  }
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    return JSON.parse(raw) as DevConfig;
  } catch {
    return null;
  }
}

export async function writeDevConfig(config: DevConfig): Promise<void> {
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}
