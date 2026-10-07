import type { NextConfig } from "next";
import { withBotId } from "botid/next/config";

// The signing screens must never load inside another site's frame. Script and
// connect sources are not enforced yet: Next.js inline scripts would need nonces,
// and wallets reach hosts this app does not list. Their policy runs report-only
// so violations show in the browser console before it is enforced.
const enforced = [
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const reportOnly = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https://api.devnet.solana.com wss://api.devnet.solana.com https://devnet-tee.magicblock.app wss://devnet-tee.magicblock.app https://*.onfinality.io wss://*.onfinality.io https://*.convex.cloud wss://*.convex.cloud https://*.convex.site",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: enforced },
  { key: "Content-Security-Policy-Report-Only", value: reportOnly },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // Isolate production reviews from concurrent local development servers.
  distDir: process.env.NEXT_BUILD_DIR || ".next",
  serverExternalPackages: [
    "@coral-xyz/anchor",
    "@solana/web3.js",
    "@solana/spl-token",
  ],
};

export default withBotId(nextConfig);
