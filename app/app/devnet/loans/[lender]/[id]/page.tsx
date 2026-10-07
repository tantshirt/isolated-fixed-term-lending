import type { Metadata } from "next";
import { LoanV2View } from "@/components/loan/LoanV2View";

type Props = { params: Promise<{ lender: string; id: string }> };

export const metadata: Metadata = { title: "Loan" };

export default async function LoanPage({ params }: Props) {
  const { lender, id } = await params;
  return (
    <div className="page">
      <LoanV2View lender={lender} offerId={id} />
    </div>
  );
}
