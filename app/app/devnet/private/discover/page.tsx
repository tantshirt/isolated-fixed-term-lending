import { redirect } from "next/navigation";

export default function Page() {
  redirect("/devnet/discover?side=borrowers&venue=private");
}
