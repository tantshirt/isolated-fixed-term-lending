"use client";
import type { ReactNode } from "react";
import { useDevConfig } from "@/lib/client/hooks";
/** Server capability, not a build-time network label, authorizes the local desk. */
export function LocalControls({ children }: { children: ReactNode }) {
  const { localControls } = useDevConfig();
  return localControls ? children : null;
}
