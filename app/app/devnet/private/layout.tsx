import { PrivateTabs } from "@/components/private/PrivateTabs";

export default function PrivateLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <PrivateTabs />
      {children}
    </>
  );
}
