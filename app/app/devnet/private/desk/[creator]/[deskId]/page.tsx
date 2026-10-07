import type { Metadata } from "next";
import { DeskWorkspace } from "@/components/private/desk/DeskWorkspace";

export const metadata: Metadata = { title: "Private desk" };

export default async function Page({ params }: { params: Promise<{ creator: string; deskId: string }> }) {
  const { creator, deskId } = await params;
  return <DeskWorkspace creator={creator} deskId={deskId} />;
}
