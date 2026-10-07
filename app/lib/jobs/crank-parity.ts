/** Shadow-scheduler parity: every crank the shadow saw due must be triggered by the live scheduler. */
export type CrankObservation = { source: "live" | "shadow"; at: number; due: string[]; triggered: string[] };

export type ParityReport = {
  /** Cranks the shadow saw due that the live scheduler never triggered within the grace window. */
  missedByLive: string[];
  /** Cranks the live scheduler triggered that the shadow never saw due. */
  unseenByShadow: string[];
  shadowScans: number;
  liveRuns: number;
};

/** The live cron runs every minute, so a crank due now should be triggered within three minutes. */
export const PARITY_GRACE_MS = 3 * 60_000;

export function crankParity(observations: CrankObservation[], now: number, graceMs = PARITY_GRACE_MS): ParityReport {
  const shadowDue = new Map<string, number[]>();
  const liveTriggered = new Map<string, number[]>();
  let shadowScans = 0;
  let liveRuns = 0;
  for (const o of observations) {
    if (o.source === "shadow") {
      shadowScans++;
      for (const c of o.due) shadowDue.set(c, [...(shadowDue.get(c) ?? []), o.at]);
    } else {
      liveRuns++;
      for (const c of o.triggered) liveTriggered.set(c, [...(liveTriggered.get(c) ?? []), o.at]);
    }
  }
  const nearby = (times: number[], at: number) => times.some((t) => Math.abs(t - at) <= graceMs);
  const missedByLive = [...shadowDue]
    .filter(([c, times]) => times.some((at) => now - at > graceMs && !nearby(liveTriggered.get(c) ?? [], at)))
    .map(([c]) => c)
    .sort();
  const unseenByShadow = [...liveTriggered]
    .filter(([c, times]) => times.some((at) => !nearby(shadowDue.get(c) ?? [], at)))
    .map(([c]) => c).sort();
  return { missedByLive, unseenByShadow, shadowScans, liveRuns };
}
