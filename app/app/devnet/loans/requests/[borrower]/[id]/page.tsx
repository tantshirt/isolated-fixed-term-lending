import type { Metadata } from "next";
import { RequestV2View } from "@/components/loan/RequestV2View";

type Props = { params: Promise<{ borrower: string; id: string }> };

export const metadata: Metadata = { title: "Request" };

export default async function RequestV2Page({ params }: Props) {
  const { borrower, id } = await params;
  return (
    <div className="page">
      <RequestV2View borrower={borrower} requestId={id} />
    </div>
  );
}
