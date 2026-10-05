import type { Metadata } from "next";
import { DiscoverPage } from "@/components/private/DiscoverPage";

export const metadata: Metadata = { title: "Discover · Lendspan" };

export default function Page() {
  return <DiscoverPage />;
}
