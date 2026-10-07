"use client";

import { usePrivate } from "@/lib/private/use-private";
import { TeeCard } from "../TeeCard";
import shared from "../private.module.css";
import { DeskList } from "./DeskList";
import { V2RoomList } from "../v2/V2RoomList";
import s from "./Desk.module.css";

/** Desks: a group of lender wallets under one immutable policy. Each lender funds their own loans. */
export function DesksIndex() {
  const { signer, base, er, status, error, connect } = usePrivate();
  const ready = status === "ready";
  return (
    <div className="page page-narrow">
      <header className={s.head}>
        <span className={shared.eyebrow}>Private desks</span>
        <h1>Your desks</h1>
        <p className={s.next} role="status">
          {ready ? "Create a desk or pick one you belong to." : "Sign in privately to see your desks."}
        </p>
      </header>
      <div className={s.section} style={{ marginTop: "1.5rem" }}>
        {!ready && <TeeCard status={status} error={error} onConnect={connect} />}
        <DeskList signer={signer} base={base} er={er} ready={ready} />
        <h2>Rooms with repayment rules</h2>
        <p className={s.empty}>Pay back in parts, add collateral, a grace period and a capped late fee. Desk lenders offer loans here under their desk policy.</p>
        <V2RoomList signer={signer} base={base} er={er} ready={ready} />
        <h2>How desks work</h2>
        <p className={s.empty}>
          A desk is a set of lender wallets under one policy. Administrators manage people and policy but cannot spend or read loans. Each loan is funded from
          one lender&rsquo;s own balance, and named auditors can read a loan only after its borrower consents at signing.
        </p>
      </div>
    </div>
  );
}
