import type { CSSProperties, ReactNode } from "react";
import { AssetIcon, type AssetSymbol } from "@/components/brand/AssetLabel";
import s from "./Vignette.module.css";

/**
 * A staged, non-interactive piece of the real interface. Screen readers get one
 * description; the figures inside are an example, never the viewer's own loan.
 */
export function Stage({
  label,
  tone,
  wide,
  children,
}: {
  label: string;
  tone?: "navy";
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={s.stage} data-tone={tone} data-wide={wide || undefined} role="img" aria-label={label}>
      <span className={s.example} aria-hidden>
        Example
      </span>
      <div className={s.scene} aria-hidden>
        {children}
      </div>
    </div>
  );
}

export function Card({
  tone,
  dim,
  ghost,
  style,
  className,
  children,
}: {
  tone?: "navy";
  dim?: boolean;
  ghost?: boolean;
  style?: CSSProperties;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`${s.card} ${className ?? ""}`}
      data-tone={tone}
      data-dim={dim || undefined}
      data-ghost={ghost || undefined}
      style={style}
    >
      {children}
    </div>
  );
}

export function Rows({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <div className={s.rows}>
      {items.map(([k, v], i) => (
        <div key={i} className={s.row}>
          <span className={s.label}>{k}</span>
          <span className={s.value}>{v}</span>
        </div>
      ))}
    </div>
  );
}

export function Amount({ value, unit }: { value: string; unit: AssetSymbol }) {
  return (
    <span className={s.big}>
      <AssetIcon symbol={unit} size={26} />
      {value} <small>{unit}</small>
    </span>
  );
}

export function Pill({ tone, children }: { tone?: "good" | "risk" | "navy"; children: ReactNode }) {
  return (
    <span className={s.pill} data-tone={tone}>
      {children}
    </span>
  );
}

/** Time left as a ring; `left` is the fraction of the term remaining. */
export function Ring({ left, size = 44 }: { left: number; size?: number }) {
  const r = 18;
  const c = 2 * Math.PI * r;
  return (
    <svg className={s.ring} width={size} height={size} viewBox="0 0 44 44">
      <circle className={s.track} cx="22" cy="22" r={r} />
      <circle
        className={s.arc}
        cx="22"
        cy="22"
        r={r}
        strokeDasharray={`${left * c} ${c}`}
        transform="rotate(-90 22 22)"
      />
    </svg>
  );
}

export function Lock({ open }: { open?: boolean }) {
  return (
    <svg className={s.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <rect x="5" y="11" width="14" height="10" rx="2.5" />
      <path d={open ? "M8 11V8a4 4 0 0 1 7.5-2" : "M8 11V8a4 4 0 0 1 8 0v3"} />
    </svg>
  );
}

export function Wallet() {
  return (
    <svg className={s.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v4" />
      <rect x="4" y="7" width="16" height="12" rx="2.5" />
      <circle cx="16" cy="13" r="1.2" fill="currentColor" />
    </svg>
  );
}

export function Check() {
  return <span className={s.check}>✓</span>;
}

export { s as vignette };
