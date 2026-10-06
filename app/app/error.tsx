"use client";

import { useEffect } from "react";
import { Spot } from "@/components/brand/Spot";
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
      <Spot kind="notFound" size={140} />
      <h1 style={{ fontSize: "var(--text-2xl)" }}>That page didn’t load.</h1>
      <p style={{ color: "var(--color-text-secondary)", maxWidth: "56ch" }}>
        Try again. If you submitted a Devnet
        transaction, check its saved Explorer link before repeating the action.
      </p>
      <Button onClick={() => reset()}>Try again</Button>
    </div>
  );
}
