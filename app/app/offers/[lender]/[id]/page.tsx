import { redirect } from "next/navigation";
export default async function Page({
  params,
}: {
  params: Promise<{ lender: string; id: string }>;
}) {
  const { lender, id } = await params;
  redirect(`/devnet/offers/${lender}/${id}`);
}
