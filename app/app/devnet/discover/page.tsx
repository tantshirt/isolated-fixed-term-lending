import type { Metadata } from "next";
import { Suspense } from "react";
import { DiscoverPage } from "@/components/discover/DiscoverPage";

export const metadata: Metadata = { title: "Discover" };

export default function Page() {
  return (
    <Suspense>
      <DiscoverPage />
    </Suspense>
  );
}
