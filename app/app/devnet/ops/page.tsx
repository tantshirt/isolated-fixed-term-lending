import type { Metadata } from "next";
import { GateDashboard } from "@/components/ops/GateDashboard";

export const metadata: Metadata = { title: "Pilot gate" };

export default function OpsPage() {
  return (
    <div className="page">
      <GateDashboard />
    </div>
  );
}
