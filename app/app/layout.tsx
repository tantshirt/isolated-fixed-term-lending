import type { Metadata } from "next";
import { Nunito, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
const nunito = Nunito({ subsets: ["latin"], variable: "--font-nunito" });
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plex-mono",
});
export const metadata: Metadata = {
  title: { default: "ZenLo", template: "%s · ZenLo" },
  applicationName: "ZenLo",
  description:
    "Clear terms. Zero drama. Fixed-term USDC loans backed by wSOL on Solana.",
  openGraph: {
    title: "ZenLo",
    description:
      "Clear terms. Zero drama. Fixed-term USDC loans backed by wSOL on Solana.",
    siteName: "ZenLo",
    type: "website",
  },
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${nunito.variable} ${mono.variable}`}
      data-astryx-theme="neutral"
      data-theme="light"
    >
      <body>{children}</body>
    </html>
  );
}
