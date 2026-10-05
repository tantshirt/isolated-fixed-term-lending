"use client";

import { forwardRef, useId, type ReactNode } from "react";
import { AssetLabel } from "@/components/brand/AssetLabel";
import styles from "./AmountInput.module.css";

type Props = {
  label: string;
  value: string;
  onChange: (v: string) => void;
  unit: string;
  decimals: number;
  hint?: ReactNode;
  error?: string;
  size?: "md" | "xl";
  autoFocus?: boolean;
  onEnter?: () => void;
};

/** Accepts digits and one dot, capped at the token's decimals. Thousands are shown as you type. */
export const AmountInput = forwardRef<HTMLInputElement, Props>(
  function AmountInput(
    {
      label,
      value,
      onChange,
      unit,
      decimals,
      hint,
      error,
      size = "md",
      autoFocus,
      onEnter,
    },
    ref
  ) {
    const id = useId();
    const clean = (raw: string) => {
      let v = raw.replace(/[^\d.]/g, "");
      const dot = v.indexOf(".");
      if (dot !== -1)
        v =
          v.slice(0, dot + 1) +
          v
            .slice(dot + 1)
            .replace(/\./g, "")
            .slice(0, decimals);
      if (/^0\d/.test(v)) v = v.replace(/^0+(?=\d)/, "");
      return v;
    };
    const display = (() => {
      const [w, f] = value.split(".");
      const whole = w ? w.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : w;
      return f !== undefined ? `${whole || "0"}.${f}` : whole;
    })();

    return (
      <div
        className={`${styles.field} ${styles[size]} ${
          error ? styles.invalid : ""
        }`}
      >
        <label htmlFor={id} className={styles.label}>
          {label}
        </label>
        <div className={styles.control}>
          <input
            ref={ref}
            id={id}
            className={`${styles.input} num`}
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            placeholder="0"
            value={display}
            autoFocus={autoFocus}
            aria-invalid={Boolean(error)}
            aria-describedby={`${id}-hint`}
            onChange={(e) => onChange(clean(e.target.value))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && onEnter) {
                e.preventDefault();
                onEnter();
              }
            }}
          />
          <span className={styles.unit}>
            {unit === "USDC" || unit === "SOL" || unit === "wSOL" ? (
              <AssetLabel symbol={unit} />
            ) : (
              unit
            )}
          </span>
        </div>
        <p id={`${id}-hint`} className={error ? styles.error : styles.hint}>
          {error ?? hint ?? " "}
        </p>
      </div>
    );
  }
);
