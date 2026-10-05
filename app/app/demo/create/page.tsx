import { Suspense } from "react";
import { Demo } from "@/components/experience/Demo";
export default function Page() {
  return (
    <Suspense fallback={<p>Loading simulation…</p>}>
      <Demo />
    </Suspense>
  );
}
