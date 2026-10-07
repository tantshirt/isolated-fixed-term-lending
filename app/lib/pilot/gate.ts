import developerWallets from "./developer-wallets.json";

/** Customer-gate thresholds from Story 25.1. */
export const GATE = {
  activatedDesks: 5,
  unassistedShare: 0.8,
  confirmedLoans: 10,
  desksWithLoans: 3,
  returningLenders: 3,
} as const;

const DEVELOPERS = new Set(developerWallets.wallets.map((w) => w.address));

export function isDeveloperWallet(address: string): boolean {
  return DEVELOPERS.has(address);
}

export type PilotEvent =
  | { kind: "desk_activated"; deskId: string; operator: string; at: number }
  | {
      kind: "loan_confirmed";
      deskId: string;
      lender: string;
      borrower: string;
      signers: string[];
      /** True when the developer stepped in after onboarding to get this loan originated. */
      assisted: boolean;
      at: number;
    };

export type GateReport = {
  activatedDesks: number;
  confirmedLoans: number;
  desksWithLoans: number;
  unassistedShare: number | null;
  returningLenders: number;
  excludedEvents: number;
  passed: boolean;
  failing: string[];
};

function developerGenerated(event: PilotEvent): boolean {
  if (event.kind === "desk_activated") return isDeveloperWallet(event.operator);
  return [event.lender, event.borrower, ...event.signers].some(isDeveloperWallet);
}

/** Evaluates the measurable parts of the gate. Comprehension and defect checks are recorded by hand. */
export function evaluateGate(events: PilotEvent[]): GateReport {
  const counted = events.filter((e) => !developerGenerated(e));
  const desks = new Map<string, string>();
  for (const e of counted) if (e.kind === "desk_activated") desks.set(e.deskId, e.operator);
  // Only one desk per operator counts, so a single operator cannot pass the gate alone.
  const operators = new Set(desks.values());

  const loans = counted.filter(
    (e): e is Extract<PilotEvent, { kind: "loan_confirmed" }> =>
      e.kind === "loan_confirmed" && desks.has(e.deskId),
  );
  const desksWithLoans = new Set(loans.map((l) => l.deskId)).size;
  const unassisted = loans.filter((l) => !l.assisted).length;
  const perLender = new Map<string, number>();
  for (const l of loans) perLender.set(l.lender, (perLender.get(l.lender) ?? 0) + 1);
  const returningLenders = [...perLender.values()].filter((n) => n >= 2).length;

  const report = {
    activatedDesks: operators.size,
    confirmedLoans: loans.length,
    desksWithLoans,
    unassistedShare: loans.length ? unassisted / loans.length : null,
    returningLenders,
    excludedEvents: events.length - counted.length,
  };
  const failing: string[] = [];
  if (report.activatedDesks < GATE.activatedDesks) failing.push("activatedDesks");
  if (report.confirmedLoans < GATE.confirmedLoans) failing.push("confirmedLoans");
  if (report.desksWithLoans < GATE.desksWithLoans) failing.push("desksWithLoans");
  if (report.unassistedShare === null || report.unassistedShare < GATE.unassistedShare) failing.push("unassistedShare");
  if (report.returningLenders < GATE.returningLenders) failing.push("returningLenders");
  return { ...report, passed: failing.length === 0, failing };
}
