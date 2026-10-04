import type { Metadata, Viewport } from "next";
import { Figtree, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { Header } from "@/components/shell/Header";
import { ConnectDialog } from "@/components/shell/ConnectDialog";
import { DemoDesk } from "@/components/shell/DemoDesk";
import { Providers } from "@/components/shell/Providers";
import { BRAND } from "@/lib/constants";

const figtree = Figtree({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-figtree",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plex-mono",
});

export const metadata: Metadata = {
  title: { default: BRAND.name, template: `%s · ${BRAND.name}` },
  description: "Fixed-term USDC loans against wSOL, one offer at a time.",
};

export const viewport: Viewport = {
  themeColor: "#f6f2ea",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${figtree.variable} ${plexMono.variable}`}
      data-astryx-theme="neutral"
      data-theme="light"
    >
      <body>
        <Providers>
          <Header />
          <main>{children}</main>
          <ConnectDialog />
          <DemoDesk />
        </Providers>
      </body>
    </html>
  );
}
