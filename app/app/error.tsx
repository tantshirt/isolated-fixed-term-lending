"use client";

import { useEffect } from "react";
import { Sharky } from "@/components/brand/Sharky";
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
      <Sharky pose="confused" size={140} />
      <h1 style={{ fontSize: "var(--text-2xl)" }}>Even Sharky did not see that coming</h1>
      <p style={{ color: "var(--color-text-secondary)", maxWidth: "56ch" }}>
        This page did not load. Try again. If you submitted a Devnet
        transaction, check its saved Explorer link before repeating the action.
      </p>
      <Button onClick={() => reset()}>Try again</Button>
    </div>
  );
}
