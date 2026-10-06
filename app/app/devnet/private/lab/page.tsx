import type { Metadata } from "next";
import { LabPage } from "@/components/private/LabPage";

export const metadata: Metadata = { title: "Loan lab" };

export default function Page() {
  return <LabPage />;
}
