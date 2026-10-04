import fs from "fs/promises";
import path from "path";

export type DevSecrets = {
  priceUpdateSecret: number[];
  priceWriteAuthoritySecret: number[];
  /** Mint authority for both test mints; lets /api/fund top up any wallet. */
  adminSecret?: number[];
};

const SECRETS_PATH = path.join(process.cwd(), ".local", "dev-secrets.json");

export async function readDevSecrets(): Promise<DevSecrets | null> {
  try {
    const raw = await fs.readFile(SECRETS_PATH, "utf8");
    return JSON.parse(raw) as DevSecrets;
  } catch {
    return null;
  }
}

export async function writeDevSecrets(secrets: DevSecrets): Promise<void> {
  await fs.mkdir(path.dirname(SECRETS_PATH), { recursive: true });
  await fs.writeFile(SECRETS_PATH, JSON.stringify(secrets, null, 2));
}
