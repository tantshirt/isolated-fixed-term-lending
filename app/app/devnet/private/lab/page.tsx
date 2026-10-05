import type { Metadata } from "next";
import { LabPage } from "@/components/private/LabPage";

export const metadata: Metadata = { title: "Loan lab · Lendspan" };

export default function Page() {
  return <LabPage />;
}
