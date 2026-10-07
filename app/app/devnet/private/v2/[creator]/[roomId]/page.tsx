import type { Metadata } from "next";
import { V2RoomView } from "@/components/private/v2/V2RoomView";

export const metadata: Metadata = { title: "Private room" };

export default async function Page({ params }: { params: Promise<{ creator: string; roomId: string }> }) {
  const { creator, roomId } = await params;
  return <V2RoomView creator={creator} roomId={roomId} />;
}
