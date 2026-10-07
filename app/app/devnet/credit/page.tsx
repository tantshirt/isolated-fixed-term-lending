import type { Metadata } from "next";
import { CreditPanel } from "@/components/credit/CreditPanel";

export const metadata: Metadata = { title: "Credit" };

export default function Page() {
  return <CreditPanel />;
}
