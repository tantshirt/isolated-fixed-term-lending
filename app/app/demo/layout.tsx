import { DemoSession } from "@/components/experience/DemoSession";
import { PublicHeader } from "@/components/experience/PublicHeader";
import { SiteFooter } from "@/components/experience/SiteFooter";
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <DemoSession>
      <PublicHeader />
      {children}
      <SiteFooter />
    </DemoSession>
  );
}
