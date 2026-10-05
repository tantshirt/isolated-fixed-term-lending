import type { Metadata } from "next";
import { PrivateStatus } from "@/components/private/PrivateStatus";
import { loadGates } from "@/lib/private/gates";

export const metadata: Metadata = { title: "Private lending · Lendspan" };
export const dynamic = "force-dynamic";

export default async function Page() {
  const { gates, error } = await loadGates();
  return <PrivateStatus gates={gates} error={error} />;
}
