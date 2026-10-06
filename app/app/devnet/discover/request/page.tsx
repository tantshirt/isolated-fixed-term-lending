import type { Metadata } from "next";
import { Suspense } from "react";
import { RequestWizard } from "@/components/request/RequestWizard";

export const metadata: Metadata = { title: "Request a loan" };

export default function Page() {
  return (
    <div className="page">
      <Suspense>
        <RequestWizard />
      </Suspense>
    </div>
  );
}
