import { LocalControls } from "@/components/shell/LocalControls";
import { Providers } from "@/components/shell/Providers";
import { Header } from "@/components/shell/Header";
import { ConnectDialog } from "@/components/shell/ConnectDialog";
import { DemoDesk } from "@/components/shell/DemoDesk";
import { DevnetSetup } from "@/components/experience/DevnetSetup";
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <Providers>
      <Header />
      <DevnetSetup />
      <main>{children}</main>
      <ConnectDialog />
      <LocalControls>
        <DemoDesk />
      </LocalControls>
    </Providers>
  );
}
