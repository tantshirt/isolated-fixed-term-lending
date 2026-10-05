import type { Metadata } from "next";
import { OfferView } from "@/components/offer/OfferView";

type Props = { params: Promise<{ lender: string; id: string }> };

export const metadata: Metadata = { title: "Offer" };

export default async function OfferPage({ params }: Props) {
  const { lender, id } = await params;
  return (
    <div className="page">
      <OfferView lender={lender} offerId={id} />
    </div>
  );
}
