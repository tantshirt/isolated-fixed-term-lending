import styles from "./private.module.css";

export type StepState = "done" | "current" | "next" | "later";

export type JourneyStep = { title: string; body: string; state: StepState; note?: string };

const WORD: Record<StepState, string> = { done: "Done", current: "Now", next: "Next", later: "Then" };

/** The private workflow, start to finish, with where this wallet is in it. */
export function Journey({ steps }: { steps: JourneyStep[] }) {
  return (
    <ol className={styles.journey} aria-label="How a private loan works">
      {steps.map((s, i) => (
        <li key={s.title} className={styles.step} data-state={s.state} aria-current={s.state === "current" ? "step" : undefined}>
          <span className={styles.stepMarker} aria-hidden>
            {s.state === "done" ? (
              <svg width="12" height="12" viewBox="0 0 12 12">
                <path d="M2.5 6.2 5 8.5l4.5-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <span className="num">{i + 1}</span>
            )}
          </span>
          <div className={styles.stepText}>
            <p className={styles.stepTitle}>
              {s.title}
              <span className={styles.stepState}>{WORD[s.state]}</span>
            </p>
            <p className={styles.stepBody}>{s.body}</p>
            {s.note && <p className={styles.stepNote}>{s.note}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Compact progress for phones, where the full journey sits below the actions. */
export function JourneyProgress({ steps }: { steps: JourneyStep[] }) {
  const i = Math.max(0, steps.findIndex((s) => s.state === "current"));
  return (
    <p className={styles.progress}>
      <span>
        Step <span className="num">{i + 1}</span> of <span className="num">{steps.length}</span> · <strong>{steps[i].title}</strong>
      </span>
      <span className={styles.progressBar} aria-hidden>
        <span style={{ width: `${((i + 1) / steps.length) * 100}%` }} />
      </span>
    </p>
  );
}
