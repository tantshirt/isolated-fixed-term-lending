import type { Metadata } from "next";
import { RoomView } from "@/components/private/RoomView";

export const metadata: Metadata = { title: "Private room" };

export default async function Page({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  return <RoomView roomId={roomId} />;
}
