"use client";

import { LayoutGroup, m } from "motion/react";
import { useId } from "react";
import styles from "./Chips.module.css";

type Option<T> = { value: T; label: string };

type Props<T> = {
  label: string;
  options: Option<T>[];
  value: T | null;
  onChange: (v: T) => void;
  hideLabel?: boolean;
};

/** Segmented choice with a sliding selection. Arrow keys move between options. */
export function Chips<T extends string | number>({ label, options, value, onChange, hideLabel }: Props<T>) {
  const group = useId();
  const index = options.findIndex((o) => o.value === value);
  return (
    <div className={styles.wrap}>
      <span id={group} className={hideLabel ? "visually-hidden" : styles.label}>
        {label}
      </span>
      <LayoutGroup id={group}>
        <div
          role="radiogroup"
          aria-labelledby={group}
          className={styles.chips}
          onKeyDown={(e) => {
            if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
            e.preventDefault();
            const next = (Math.max(0, index) + (e.key === "ArrowRight" ? 1 : -1) + options.length) % options.length;
            onChange(options[next].value);
            const buttons = e.currentTarget.querySelectorAll<HTMLButtonElement>("button");
            buttons[next]?.focus();
          }}
        >
          {options.map((o, i) => {
            const selected = o.value === value;
            return (
              <button
                key={String(o.value)}
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={selected || (index === -1 && i === 0) ? 0 : -1}
                className={`${styles.chip} ${selected ? styles.selected : ""}`}
                onClick={() => onChange(o.value)}
              >
                {selected && (
                  <m.span
                    layoutId="chip-selection"
                    className={styles.pill}
                    transition={{ type: "spring", stiffness: 520, damping: 42 }}
                  />
                )}
                <span className={styles.text}>{o.label}</span>
              </button>
            );
          })}
        </div>
      </LayoutGroup>
    </div>
  );
}
