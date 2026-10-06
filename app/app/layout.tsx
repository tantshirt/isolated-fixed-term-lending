import type { Metadata } from "next";
import { Inter, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plex-mono",
});
export const metadata: Metadata = {
  title: { default: "LegitShark", template: "%s · LegitShark" },
  description:
    "Understand the terms. Explore fixed-term USDC loans backed by wSOL.",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${mono.variable}`}
      data-astryx-theme="neutral"
      data-theme="light"
    >
      <body>{children}</body>
    </html>
  );
}
