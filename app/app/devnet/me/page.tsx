import type { Metadata } from "next";
import { MyLoans } from "@/components/portfolio/MyLoans";

export const metadata: Metadata = { title: "My loans" };

export default function Page() {
  return <MyLoans />;
}
