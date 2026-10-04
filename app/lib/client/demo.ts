"use client";

import { saveDevConfigClient, saveRoleKeypairs } from "@/lib/roles";

/** Creates test mints, three funded demo wallets and the mock SOL price. */
export async function runDemoSetup(): Promise<void> {
  const res = await fetch("/api/setup", { method: "POST" });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? "Setup failed. Is Surfpool running on 127.0.0.1:8899?");
  saveRoleKeypairs(json.keypairs);
  saveDevConfigClient(json.config);
}

export async function setDemoPrice(priceUsd: number): Promise<void> {
  const res = await fetch("/api/set-price", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ priceUsd }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? "Could not move the price");
}

export async function warpTo(timestamp: number): Promise<void> {
  const res = await fetch("/api/warp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ timestamp }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? "Time travel needs Surfpool");
}
