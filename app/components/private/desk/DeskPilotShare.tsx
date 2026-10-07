"use client";

import { useMutation } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/Button";
import { useBackendSession } from "@/lib/auth/wallet-session";
import shared from "../private.module.css";
import s from "./Desk.module.css";

const BACKEND = Boolean(process.env.NEXT_PUBLIC_CONVEX_URL);

/** Opt-in pilot metric (Story 24.5): only that this desk is active, never its members or loans. */
export function DeskPilotShare({ deskId }: { deskId: string }) {
  if (!BACKEND) return null;
  return <Inner deskId={deskId} />;
}

function Inner({ deskId }: { deskId: string }) {
  const session = useBackendSession();
  const record = useMutation(api.pilot.record);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (done) return <p className={s.empty}>Shared with the ZenLo pilot: this desk is active. Nothing else about it was sent.</p>;
  return (
    <div className={s.section}>
      <p className={s.empty}>In the pilot? You can tell ZenLo that this desk is active. Only the desk address and your wallet are sent; members, policy and loans stay private.</p>
      <div className={s.actions}>
        <Button
          variant="ghost"
          loading={busy || session.status === "signing"}
          disabled={session.status === "no-wallet"}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              if (session.status !== "signed-in") await session.signIn();
              await record({ kind: "desk_activated", deskId });
              setDone(true);
            } catch (e) {
              setErr(e instanceof Error ? e.message.split("\n")[0] : "That did not work.");
            } finally {
              setBusy(false);
            }
          }}
        >
          Share that this desk is active
        </Button>
      </div>
      {err && (
        <p role="alert" className={shared.error}>
          {err}
        </p>
      )}
    </div>
  );
}
