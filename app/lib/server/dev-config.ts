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
