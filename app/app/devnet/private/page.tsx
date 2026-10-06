import type { Metadata } from "next";
import { Suspense } from "react";
import { PrivateHome } from "@/components/private/PrivateHome";

export const metadata: Metadata = { title: "Private lending · LegitShark" };

export default function Page() {
  return (
    <Suspense>
      <PrivateHome />
    </Suspense>
  );
}
