"use client";

import { useId, type CSSProperties, type ReactNode } from "react";
import styles from "./Slider.module.css";

type Marker = { value: number; label: string };

type Props = {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
  valueLabel?: ReactNode;
  markers?: Marker[];
};

/** Native range input, restyled. Keyboard, screen readers and touch work as the platform intends. */
export function Slider({ label, value, min, max, step, onChange, format, valueLabel, markers }: Props) {
  const id = useId();
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className={styles.field}>
      <div className={styles.head}>
        <label htmlFor={id} className={styles.label}>
          {label}
        </label>
        <span className={`${styles.value} num`}>{valueLabel ?? format(value)}</span>
      </div>
      <div className={styles.track} style={{ "--fill": `${pct}%` } as CSSProperties}>
        <input
          id={id}
          type="range"
          className={styles.range}
          min={min}
          max={max}
          step={step}
          value={value}
          aria-valuetext={format(value)}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </div>
      {markers && (
        <div className={styles.markers}>
          {markers.map((mk) => (
            <button
              key={mk.value}
              type="button"
              className={`${styles.marker} ${mk.value === value ? styles.markerOn : ""}`}
              style={{ left: `${((mk.value - min) / (max - min)) * 100}%` }}
              onClick={() => onChange(mk.value)}
              tabIndex={-1}
            >
              {mk.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

type RangeProps = {
  label: string;
  low: number;
  high: number;
  min: number;
  max: number;
  step: number;
  minGap: number;
  /** Highest value the low handle may take. */
  lowMax: number;
  /** Highest value the high handle may take. */
  highMax: number;
  lowLabel: string;
  highLabel: string;
  onChange: (low: number, high: number) => void;
  format: (v: number) => string;
};

/**
 * Two handles on one track: max LTV and liquidation LTV. The handles cannot come
 * closer than `minGap`, matching the program's 5-point rule.
 */
export function RangeSlider(p: RangeProps) {
  const id = useId();
  const pos = (v: number) => ((v - p.min) / (p.max - p.min)) * 100;
  const setLow = (v: number) => {
    const low = Math.min(v, p.lowMax, p.highMax - p.minGap);
    p.onChange(low, Math.max(p.high, low + p.minGap));
  };
  const setHigh = (v: number) => {
    const high = Math.min(Math.max(v, p.low + p.minGap), p.highMax);
    p.onChange(p.low, high);
  };
  return (
    <div className={styles.field}>
      <span id={id} className={styles.label}>
        {p.label}
      </span>
      <div
        className={`${styles.track} ${styles.dual}`}
        style={{ "--lo": `${pos(p.low)}%`, "--hi": `${pos(p.high)}%`, "--cap": `${pos(p.highMax)}%` } as CSSProperties}
      >
        <span className={styles.cap} aria-hidden />
        <input
          type="range"
          className={`${styles.range} ${styles.lowRange}`}
          min={p.min}
          max={p.max}
          step={p.step}
          value={p.low}
          aria-label={p.lowLabel}
          aria-valuetext={p.format(p.low)}
          onChange={(e) => setLow(Number(e.target.value))}
        />
        <input
          type="range"
          className={`${styles.range} ${styles.highRange}`}
          min={p.min}
          max={p.max}
          step={p.step}
          value={p.high}
          aria-label={p.highLabel}
          aria-valuetext={p.format(p.high)}
          onChange={(e) => setHigh(Number(e.target.value))}
        />
      </div>
      <div className={styles.legend}>
        <span>
          <i className={styles.keyLow} aria-hidden /> {p.lowLabel} <b className="num">{p.format(p.low)}</b>
        </span>
        <span>
          <i className={styles.keyHigh} aria-hidden /> {p.highLabel} <b className="num">{p.format(p.high)}</b>
        </span>
      </div>
    </div>
  );
}
