import type { Metadata } from "next";
import { PrivateStatus } from "@/components/private/PrivateStatus";
import { loadGates } from "@/lib/private/gates";

export const metadata: Metadata = { title: "Private protocol proof · Lendspan" };
export default function Page() {
  const { gates, error } = loadGates();
  return <PrivateStatus gates={gates} error={error} />;
}
