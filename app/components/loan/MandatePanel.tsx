"use client";

import { PublicKey } from "@solana/web3.js";
import { useEffect, useState } from "react";
import { AmountInput } from "@/components/ui/AmountInput";
import { Button } from "@/components/ui/Button";
import { Chips } from "@/components/ui/Chips";
import { formatBpsAsPercent, formatDeadline, formatDuration, formatUsdc, formatWsol } from "@/lib/format";
import type { LoanSigner } from "@/lib/keypair-wallet";
import { maturity } from "@/lib/loan-math-v2";
import type { ViewAction } from "@/lib/models/loan-view";
import { parseAmount } from "@/lib/offer-validation";
import { getConnection } from "@/lib/program";
import {
  ACTION_REPAY,
  ACTION_TOP_UP,
  fetchMandate,
  sendCreateMandateV2,
  sendRevokeMandateV2,
  TRIGGER_HEALTH,
  TRIGGER_TIME,
  validateBounds,
  type Mandate,
  type MandateAction,
  type MandateBounds,
} from "@/lib/v2/mandates";
import type { OfferV2 } from "@/lib/v2/offers";
import styles from "@/components/offer/ActionPanel.module.css";

type Props = {
  offer: OfferV2;
  action: ViewAction | undefined;
  signer: LoanSigner;
  now: number;
  busy: boolean;
  run: (fn: () => Promise<string>, moved: string) => Promise<void>;
  panel: (title: string, body: string, children?: React.ReactNode, note?: string | null) => React.ReactNode;
};

const DAY = 86_400;

/** Reads this loan's two possible mandates; `null` while loading. */
function useMandates(offer: string, refresh: number): (Mandate | null)[] | null {
  const [rows, setRows] = useState<(Mandate | null)[] | null>(null);
  useEffect(() => {
    let live = true;
    const key = new PublicKey(offer);
    Promise.all([fetchMandate(getConnection(), key, ACTION_TOP_UP), fetchMandate(getConnection(), key, ACTION_REPAY)])
      .then((r) => live && setRows(r))
      .catch(() => live && setRows([null, null]));
    return () => {
      live = false;
    };
  }, [offer, refresh]);
  return rows;
}

/**
 * Story 26.3: the borrower creates, inspects or revokes a top-up or repay mandate. Every bound the
 * program checks is shown before signing. Only ZenLo's keeper executes it, and only within these
 * bounds; nothing ever refinances automatically.
 */
export function MandatePanel({ offer, action, signer, now, busy, run, panel }: Props) {
  const [refresh, setRefresh] = useState(0);
  const mandates = useMandates(offer.publicKey, refresh);
  const [kind, setKind] = useState<"top-up" | "repay">("top-up");
  const [trigger, setTrigger] = useState<"health" | "time">("health");
  const [ltv, setLtv] = useState(String(Math.max(offer.liquidationLtvBps - 500, 300) / 100));
  const [leadDays, setLeadDays] = useState("1");
  const [amount, setAmount] = useState("");
  const [cap, setCap] = useState("");
  const [fee, setFee] = useState("0");
  const [feeCap, setFeeCap] = useState("0");
  const [days, setDays] = useState("30");

  if (!action) return null;
  if (!action.available) return panel("Automatic top-up or repay", "Let ZenLo's keeper add collateral or repay for you, within limits you sign.", null, action.reason ?? null);
  if (!mandates) return panel("Automatic top-up or repay", "Reading this loan's mandates.");
  const runAndRefresh = async (fn: () => Promise<string>, moved: string) => {
    await run(fn, moved);
    setRefresh((n) => n + 1);
  };

  const live = mandates.filter((m): m is Mandate => !!m);
  const act: MandateAction = kind === "top-up" ? ACTION_TOP_UP : ACTION_REPAY;
  const existing = mandates[act];
  const unit = act === ACTION_TOP_UP ? "wSOL" : "USDC";
  const decimals = act === ACTION_TOP_UP ? 9 : 6;
  const fmt = (v: bigint, a: MandateAction) => (a === ACTION_TOP_UP ? `${formatWsol(v)} wSOL` : `${formatUsdc(v)} USDC`);
  const parse = (s: string) => parseAmount(s, decimals);

  const ltvBps = Math.round(Number(ltv) * 100);
  const bounds: MandateBounds | null = (() => {
    const a = parse(amount), c = parse(cap), f = parse(fee || "0"), fc = parse(feeCap || "0");
    if (a === null || c === null || f === null || fc === null || !Number.isFinite(ltvBps)) return null;
    return {
      action: act,
      trigger: trigger === "health" ? TRIGGER_HEALTH : TRIGGER_TIME,
      triggerLtvBps: trigger === "health" ? ltvBps : 0,
      leadSeconds: trigger === "time" ? Math.round(Number(leadDays) * DAY) : 0,
      amountPerExec: a,
      cumulativeCap: c,
      feePerExec: f,
      feeCap: fc,
      expiry: now + Math.round(Number(days) * DAY),
    };
  })();
  const problem = bounds ? validateBounds(bounds, now, offer.liquidationLtvBps, offer.terms.duration) : "Fill in every amount.";

  return panel(
    "Automatic top-up or repay",
    "ZenLo's keeper can add collateral or repay for you when a trigger you choose is met, never beyond the limits you sign. You can revoke at any time.",
    <>
      {live.map((m) => (
        <div key={m.publicKey}>
          <dl className={styles.sheet}>
            <div>
              <dt>{m.action === ACTION_TOP_UP ? "Top-up mandate" : "Repay mandate"}</dt>
              <dd>{m.trigger === TRIGGER_HEALTH ? `when LTV reaches ${formatBpsAsPercent(m.triggerLtvBps, 1)}` : `${formatDuration(m.leadSeconds)} before the deadline`}</dd>
            </div>
            <div>
              <dt>Each time</dt>
              <dd className="num">{fmt(m.amountPerExec, m.action)}</dd>
            </div>
            <div>
              <dt>Used of the total cap</dt>
              <dd className="num">
                {fmt(m.used, m.action)} of {fmt(m.cumulativeCap, m.action)}
              </dd>
            </div>
            <div>
              <dt>Keeper fees paid</dt>
              <dd className="num">
                {fmt(m.feesPaid, m.action)} of {fmt(m.feeCap, m.action)}
              </dd>
            </div>
            <div>
              <dt>State</dt>
              <dd>
                {now >= m.expiry ? "Expired" : m.armed ? "Armed" : m.trigger === TRIGGER_HEALTH ? `Fired; re-arms at ${formatBpsAsPercent(m.triggerLtvBps - 200, 1)} LTV` : "Done"} · ends{" "}
                {formatDeadline(m.expiry)}
              </dd>
            </div>
          </dl>
          <Button variant="secondary" size="lg" block loading={busy} onClick={() => runAndRefresh(() => sendRevokeMandateV2(signer, m), "Mandate revoked. Nothing more can move under it.")}>
            Revoke this mandate
          </Button>
        </div>
      ))}
      {offer.status === "active" && (
        <>
          <Chips label="Action" options={[{ value: "top-up", label: "Add collateral" }, { value: "repay", label: "Repay" }]} value={kind} onChange={setKind} />
          {existing ? (
            <p className={styles.body}>This loan already has a {kind} mandate. Revoke it to sign a new one.</p>
          ) : (
            <>
              <Chips label="When" options={[{ value: "health", label: "LTV reaches" }, { value: "time", label: "Before the deadline" }]} value={trigger} onChange={setTrigger} />
              {trigger === "health" ? (
                <AmountInput label={`LTV trigger, below ${formatBpsAsPercent(offer.liquidationLtvBps, 0)}`} value={ltv} onChange={setLtv} unit="%" decimals={2} />
              ) : (
                <AmountInput label="Days before the deadline" value={leadDays} onChange={setLeadDays} unit="days" decimals={2} />
              )}
              <AmountInput label="Each time" value={amount} onChange={setAmount} unit={unit} decimals={decimals} />
              <AmountInput label="Total cap, fees included" value={cap} onChange={setCap} unit={unit} decimals={decimals} />
              <AmountInput label="Keeper fee each time, at most" value={fee} onChange={setFee} unit={unit} decimals={decimals} />
              <AmountInput label="Keeper fees in total, at most" value={feeCap} onChange={setFeeCap} unit={unit} decimals={decimals} />
              <AmountInput label="Ends after" value={days} onChange={setDays} unit="days" decimals={0} />
              {bounds && !problem && (
                <ul className={styles.review}>
                  <li>
                    {act === ACTION_TOP_UP ? "Adds" : "Pays your lender"} {fmt(bounds.amountPerExec, act)} each time
                    {bounds.trigger === TRIGGER_HEALTH
                      ? ` your LTV reaches ${formatBpsAsPercent(bounds.triggerLtvBps, 1)} at the live price (less its confidence). After firing it waits until LTV is back to ${formatBpsAsPercent(bounds.triggerLtvBps - 200, 1)} before it can fire again.`
                      : ` once, from ${formatDeadline(maturity(offer.terms) - bounds.leadSeconds)}.`}
                  </li>
                  {act === ACTION_REPAY && <li>A repayment never takes more than you owe at that moment.</li>}
                  <li>
                    At most {fmt(bounds.cumulativeCap, act)} in total, fees included. You approve exactly that much from your {unit} account; it can only go into this loan, to its lender, or to the keeper as its fee.
                  </li>
                  <li>
                    The keeper charges at most {fmt(bounds.feePerExec, act)} each time and {fmt(bounds.feeCap, act)} in total.
                  </li>
                  <li>It ends {formatDeadline(bounds.expiry)}, when the loan settles, or when you revoke it. It never refinances your loan.</li>
                </ul>
              )}
              <Button
                size="lg"
                block
                loading={busy}
                disabled={!!problem}
                onClick={() => bounds && runAndRefresh(() => sendCreateMandateV2(signer, offer, bounds), `Mandate signed: up to ${fmt(bounds.cumulativeCap, act)}`)}
              >
                Sign this mandate
              </Button>
            </>
          )}
        </>
      )}
    </>,
    offer.status === "active" && !existing ? problem : null,
  );
}
