"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useInView, useReducedMotion } from "motion/react";
import styles from "./ArtMotion.module.css";

/** Only artwork moves. Controls and all meaningful content stay in normal flow. */
export function ArtMotion({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const visible = useInView(ref, { amount: 0.15 });
  const reduced = useReducedMotion();
  const [mounted, setMounted] = useState(false);
  const [paused, setPaused] = useState(false);
  const [tabVisible, setTabVisible] = useState(true);
  useEffect(() => {
    setMounted(true);
    const update = () => setTabVisible(document.visibilityState === "visible");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return <div ref={ref} className={styles.frame}>
    <div className={styles.art} data-running={visible && tabVisible && !paused && !reduced}>{children}</div>
    <button type="button" className={styles.pause} aria-pressed={paused} onClick={() => setPaused((p) => !p)} disabled={mounted && !!reduced}>
      {mounted && reduced ? "Reduced motion on" : paused ? "Resume artwork" : "Pause artwork"}
    </button>
  </div>;
}
