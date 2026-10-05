"use client";

import { useEffect } from "react";
import { LogoMark } from "@/components/brand/LogoMark";
import { Button } from "@/components/ui/Button";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div
      className="page page-narrow"
      style={{ display: "grid", gap: "1.25rem", justifyItems: "start" }}
    >
      <LogoMark size={40} progress={0.08} />
      <h1 style={{ fontSize: "var(--text-2xl)" }}>This page did not load</h1>
      <p style={{ color: "var(--color-text-secondary)", maxWidth: "56ch" }}>
        Lendspan could not load this page. Try again. If you submitted a Devnet
        transaction, check its saved Explorer link before repeating the action.
      </p>
      <Button onClick={() => reset()}>Try again</Button>
    </div>
  );
}
