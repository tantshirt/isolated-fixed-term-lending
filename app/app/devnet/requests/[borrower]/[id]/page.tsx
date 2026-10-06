import type { Metadata } from "next";
import { RequestView } from "@/components/request/RequestView";

type Props = { params: Promise<{ borrower: string; id: string }> };

export const metadata: Metadata = { title: "Loan request" };

export default async function RequestPage({ params }: Props) {
  const { borrower, id } = await params;
  return (
    <div className="page">
      <RequestView borrower={borrower} requestId={id} />
    </div>
  );
}
