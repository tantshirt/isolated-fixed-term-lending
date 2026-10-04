"use client";

import { useEffect } from "react";
import { LogoMark } from "@/components/brand/LogoMark";
import { Button } from "@/components/ui/Button";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="page page-narrow" style={{ display: "grid", gap: "1.25rem", justifyItems: "start" }}>
      <LogoMark size={40} progress={0.08} />
      <h1 style={{ fontSize: "var(--text-2xl)" }}>This page did not load</h1>
      <p style={{ color: "var(--color-text-secondary)", maxWidth: "56ch" }}>
        Tenor reads everything from the local validator. Check that Surfpool is running on 127.0.0.1:8899, then try again.
      </p>
      <Button onClick={() => reset()}>Try again</Button>
    </div>
  );
}
