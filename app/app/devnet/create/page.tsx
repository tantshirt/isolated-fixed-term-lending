import type { Metadata } from "next";
import { Suspense } from "react";
import { CreateWizard } from "@/components/create/CreateWizard";

export const metadata: Metadata = { title: "Create offer" };

export default function CreatePage() {
  return (
    <div className="page">
      <Suspense>
        <CreateWizard />
      </Suspense>
    </div>
  );
}
