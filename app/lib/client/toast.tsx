"use client";

import { AnimatePresence, m } from "motion/react";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import styles from "./toast.module.css";

type Tone = "success" | "error" | "info";
type Toast = { id: number; tone: Tone; title: string; detail?: string };

const ToastContext = createContext<(t: Omit<Toast, "id">) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = Date.now() + Math.random();
    setToasts((all) => [...all.slice(-2), { ...t, id }]);
    setTimeout(() => setToasts((all) => all.filter((x) => x.id !== id)), t.tone === "error" ? 7_000 : 4_500);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className={styles.region} role="status" aria-live="polite">
        <AnimatePresence initial={false}>
          {toasts.map((t) => (
            <m.div
              key={t.id}
              layout
              className={`${styles.toast} ${styles[t.tone]}`}
              initial={{ opacity: 0, y: 12, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, transition: { duration: 0.16 } }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            >
              <span className={styles.dot} aria-hidden />
              <div>
                <p className={styles.title}>{t.title}</p>
                {t.detail && <p className={styles.detail}>{t.detail}</p>}
              </div>
            </m.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
