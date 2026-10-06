import type { Metadata } from "next";
import { DiagnosticsPage } from "@/components/private/DiagnosticsPage";

export const metadata: Metadata = { title: "Diagnostics" };

export default function Page() {
  return <DiagnosticsPage />;
}
