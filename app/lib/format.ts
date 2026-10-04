const group = (whole: bigint) => whole.toLocaleString("en-US");

/** Exact USDC from atoms: thousands grouped, at least 2 decimals, never rounded. */
export function formatUsdc(atoms: bigint | number): string {
  const n = typeof atoms === "bigint" ? atoms : BigInt(atoms);
  const frac = (n % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${group(n / 1_000_000n)}.${frac}`;
}

/** Exact wSOL from lamports: at least 2 decimals, up to 9. */
export function formatWsol(lamports: bigint | number): string {
  const n = typeof lamports === "bigint" ? lamports : BigInt(lamports);
  const frac = (n % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${group(n / 1_000_000_000n)}.${frac}`;
}

/** Float formatters for animated figures. The settled value is always the exact one. */
export const fmt = {
  usd: (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  wsol: (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 }),
  pct: (bps: number) => `${(bps / 100).toFixed(1)}%`,
  pct0: (bps: number) => `${Math.round(bps / 100)}%`,
};

export function formatBpsAsPercent(bps: number, decimals = 1): string {
  return `${(bps / 100).toFixed(decimals)}%`;
}

export function atomsToNumber(atoms: bigint, decimals: number): number {
  return Number(atoms) / 10 ** decimals;
}

export function formatDuration(seconds: number): string {
  if (seconds % 86_400 === 0) {
    const d = seconds / 86_400;
    return `${d} day${d === 1 ? "" : "s"}`;
  }
  if (seconds % 3_600 === 0) {
    const h = seconds / 3_600;
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  const m = Math.round(seconds / 60);
  return `${m} minute${m === 1 ? "" : "s"}`;
}

/** "2d 4h", "3h 12m", "45s" — the two largest units. */
export function formatCountdown(seconds: number): string {
  if (seconds <= 0) return "0s";
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  const s = seconds % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

export function formatDeadline(unix: number): string {
  return new Date(unix * 1000).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function shortKey(key: string): string {
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}
