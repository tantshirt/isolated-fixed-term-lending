import type { Metadata } from "next";
import { DesksIndex } from "@/components/private/desk/DesksIndex";

export const metadata: Metadata = { title: "Private desks" };

export default function Page() {
  return <DesksIndex />;
}
