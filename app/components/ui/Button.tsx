"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { LogoMark } from "@/components/brand/LogoMark";
import styles from "./Button.module.css";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "md" | "lg";
  loading?: boolean;
  block?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = "primary", size = "md", loading = false, block = false, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={[styles.button, styles[variant], styles[size], block ? styles.block : "", className ?? ""].join(" ")}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && (
        <span className={styles.spinner}>
          <LogoMark size={18} spinning tone={variant === "primary" || variant === "danger" ? "panel" : "ink"} />
        </span>
      )}
      <span className={styles.label}>{children}</span>
    </button>
  );
});
