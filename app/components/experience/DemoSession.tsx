"use client";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_SIM_DRAFT,
  initialSimulation,
  restoreSimulation,
  serializeSimulation,
  validStoredDraft,
  type Simulation,
} from "@/lib/simulation";
import type { OfferDraft } from "@/lib/offer-validation";
const KEY = "lendspan-simulation-v1",
  DRAFT_KEY = "lendspan-draft-v1";
function useSessionState() {
  const [state, setState] = useState<Simulation>(initialSimulation);
  const [draft, setDraft] = useState<OfferDraft>(DEFAULT_SIM_DRAFT);
  const [ready, setReady] = useState(false);
  const [recovery, setRecovery] = useState("");
  const [guided, setGuided] = useState(true);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const restored = restoreSimulation(raw);
        if (restored) setState(restored);
        else
          setRecovery(
            "Your saved simulation could not be read. A fresh example is ready."
          );
      }
      const saved = localStorage.getItem(DRAFT_KEY);
      if (saved) {
        const value = JSON.parse(saved);
        if (value.version === 1 && validStoredDraft(value.draft))
          setDraft(value.draft);
        else
          setRecovery(
            "Your saved draft could not be read. Defaults have been restored."
          );
      }
    } catch {
      setRecovery(
        "Browser storage is unavailable. You can still explore this session."
      );
    }
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(KEY, serializeSimulation(state));
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ version: 1, draft }));
    } catch {
      /* The layout provider keeps the session alive without storage. */
    }
  }, [state, draft, ready]);
  const resetSession = () => {
    setState(initialSimulation());
    setDraft(DEFAULT_SIM_DRAFT);
    setRecovery("");
    setGuided(true);
    try {
      localStorage.removeItem(KEY);
      localStorage.removeItem(DRAFT_KEY);
    } catch {}
  };
  return {
    state,
    setState,
    draft,
    setDraft,
    ready,
    recovery,
    guided,
    setGuided,
    resetSession,
  };
}
const DemoContext = createContext<ReturnType<typeof useSessionState> | null>(
  null
);
export function DemoSession({ children }: { children: ReactNode }) {
  return (
    <DemoContext.Provider value={useSessionState()}>
      {children}
    </DemoContext.Provider>
  );
}
export function useDemoSession() {
  const session = useContext(DemoContext);
  if (!session) throw new Error("Simulation requires its session provider.");
  return session;
}
