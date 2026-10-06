import type { Metadata } from "next";
import { LiquidatePage } from "@/components/private/LiquidatePage";

export const metadata: Metadata = { title: "Liquidate · LegitShark" };

export default function Page() {
  return <LiquidatePage />;
}
