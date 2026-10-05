import { DemoSession } from "@/components/experience/DemoSession";
import { PublicHeader } from "@/components/experience/PublicHeader";
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <DemoSession>
      <PublicHeader />
      {children}
    </DemoSession>
  );
}
