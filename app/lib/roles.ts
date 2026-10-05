import { Keypair } from "@solana/web3.js";
import { ActingRole, STORAGE_KEYS, IS_LOCAL } from "./constants";

export type RoleKeypairs = {
  lender: number[];
  borrower: number[];
  liquidator: number[];
};

export type DevConfigClient = {
  usdcMint: string;
  wsolMint: string;
  priceUpdateAccount: string;
};

function loadKeypair(storageKey: string): Keypair | null {
  if (!IS_LOCAL || typeof window === "undefined") return null;
  const raw = localStorage.getItem(storageKey);
  if (!raw) return null;
  try {
    const secret = Uint8Array.from(JSON.parse(raw) as number[]);
    return Keypair.fromSecretKey(secret);
  } catch {
    return null;
  }
}

export function saveRoleKeypairs(keypairs: RoleKeypairs): void {
  if (!IS_LOCAL) throw new Error("Demo wallets are only available on localnet");
  localStorage.setItem(STORAGE_KEYS.lender, JSON.stringify(keypairs.lender));
  localStorage.setItem(
    STORAGE_KEYS.borrower,
    JSON.stringify(keypairs.borrower)
  );
  localStorage.setItem(
    STORAGE_KEYS.liquidator,
    JSON.stringify(keypairs.liquidator)
  );
}

export function saveDevConfigClient(config: DevConfigClient): void {
  localStorage.setItem(STORAGE_KEYS.devConfig, JSON.stringify(config));
}

export function loadDevConfigClient(): DevConfigClient | null {
  if (!IS_LOCAL || typeof window === "undefined") return null;
  const raw = localStorage.getItem(STORAGE_KEYS.devConfig);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DevConfigClient;
  } catch {
    return null;
  }
}

export function getActiveRole(): ActingRole {
  if (typeof window === "undefined") return "borrower";
  const role = localStorage.getItem(STORAGE_KEYS.role);
  if (role === "lender" || role === "liquidator") return role;
  return "borrower";
}

export function setActiveRole(role: ActingRole): void {
  localStorage.setItem(STORAGE_KEYS.role, role);
}

export function keypairForRole(role: ActingRole): Keypair | null {
  const map: Record<ActingRole, string> = {
    lender: STORAGE_KEYS.lender,
    borrower: STORAGE_KEYS.borrower,
    liquidator: STORAGE_KEYS.liquidator,
  };
  return loadKeypair(map[role]);
}

export function hasRoleKeypairs(): boolean {
  return Boolean(
    loadKeypair(STORAGE_KEYS.lender) &&
      loadKeypair(STORAGE_KEYS.borrower) &&
      loadKeypair(STORAGE_KEYS.liquidator)
  );
}
