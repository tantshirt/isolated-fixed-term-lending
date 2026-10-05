import type { Metadata } from "next";
import { LiquidatePage } from "@/components/private/LiquidatePage";

export const metadata: Metadata = { title: "Liquidate · Lendspan" };

export default function Page() {
  return <LiquidatePage />;
}
