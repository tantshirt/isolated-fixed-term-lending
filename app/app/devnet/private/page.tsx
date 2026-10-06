import type { Metadata } from "next";
import { Suspense } from "react";
import { PrivateHome } from "@/components/private/PrivateHome";

export const metadata: Metadata = { title: "Private lending" };

export default function Page() {
  return (
    <Suspense>
      <PrivateHome />
    </Suspense>
  );
}
