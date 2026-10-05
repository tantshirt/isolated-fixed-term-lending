import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Isolate production reviews from concurrent local development servers.
  distDir: process.env.NEXT_BUILD_DIR || ".next",
  serverExternalPackages: [
    "@coral-xyz/anchor",
    "@solana/web3.js",
    "@solana/spl-token",
  ],
};

export default nextConfig;
