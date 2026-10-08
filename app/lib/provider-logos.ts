/**
 * Provider logos used on the public pages (Story 19.7). Files live in public/brands and are hashed in
 * its registry. `scale` evens out the clear space built into each official file, so the artwork stays untouched.
 */
export const PROVIDER_LOGOS = {
  pyth: { file: "pyth.svg", ratio: 3285 / 1120, name: "Pyth", mark: false },
  squads: { file: "squads-black.svg", navy: "squads-white.svg", ratio: 127 / 24, name: "Squads", mark: false },
  convex: { file: "convex.svg", ratio: 382 / 146, name: "Convex", mark: false, scale: 2.6 },
  vercel: { file: "vercel.svg", ratio: 1, name: "Vercel", mark: true },
  telegram: { file: "telegram.svg", ratio: 1, name: "Telegram", mark: true },
  moneygram: { file: "moneygram.svg", ratio: 262 / 68, name: "MoneyGram", mark: false, scale: 1.4 },
  // Story 26.7: credential screens only.
  sas: { file: "sas.svg", ratio: 92 / 23, name: "Solana Attestation Service", mark: false },
  reclaim: { file: "reclaim.png", ratio: 1, name: "Reclaim", mark: true },
  // Story 27.1: the private tier option on the credit screen only.
  arcium: { file: "arcium.svg", ratio: 1596 / 204, name: "Arcium", mark: false },
  umbra: { file: "umbra.svg", ratio: 1, name: "Umbra", mark: true },
} as const;

export type ProviderLogoId = keyof typeof PROVIDER_LOGOS;

export const PROVIDER_LOGO_FILES: string[] = Object.values(PROVIDER_LOGOS).flatMap((l) => ("navy" in l ? [l.file, l.navy] : [l.file]));
