import {
  collateralValueUsdc,
  currentLtvBps,
  seizeUsdc,
  wsolToCaller,
} from "./loan-math";
import {
  parseDraft,
  type OfferDraft,
  type ParsedOffer,
} from "./offer-validation";
import type {
  LoanAction,
  LoanCommand,
  LoanReceipt,
  LoanService,
} from "./loan-service";
export type Role = "lender" | "borrower" | "liquidator";
export type Balance = { usdc: bigint; wsol: bigint };
export type SimLoan = ParsedOffer & {
  status:
    | "open"
    | "filled"
    | "repaid"
    | "liquidated"
    | "expired"
    | "cancelled"
    | "closed";
  expiry: number;
};
export type Simulation = {
  version: 1;
  now: number;
  role: Role;
  price: bigint;
  conf: bigint;
  publishTime: number;
  loan: SimLoan | null;
  balances: Record<Role, Balance>;
  receipts: LoanReceipt[];
};
export const DEFAULT_SIM_DRAFT: OfferDraft = {
  principal: "100",
  interestBps: 500,
  durationSeconds: 604800,
  collateral: "1.1",
  maxLtvBps: 7000,
  liquidationLtvBps: 8000,
};
export function initialSimulation(): Simulation {
  return {
    version: 1,
    now: 1800000000,
    role: "lender",
    price: 15000000000n,
    conf: 15000000n,
    publishTime: 1800000000,
    loan: null,
    balances: {
      lender: { usdc: 1000000000n, wsol: 0n },
      borrower: { usdc: 1000000000n, wsol: 10000000000n },
      liquidator: { usdc: 1000000000n, wsol: 0n },
    },
    receipts: [],
  };
}
export function exactAmount(atoms: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const fractional = (atoms % scale)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return `${atoms / scale}${fractional ? `.${fractional}` : ""}`;
}
function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
export function simulationValue(s: Simulation) {
  check(
    s.price > 0n &&
      s.conf >= 0n &&
      s.conf < s.price &&
      s.conf * 10000n <= s.price * 200n,
    "Price or confidence is invalid."
  );
  check(
    s.publishTime <= s.now && s.now - s.publishTime <= 60,
    "The simulated oracle is stale or from the future. Refresh it first."
  );
  return collateralValueUsdc(s.loan!.collateralAmount, s.price, s.conf, -8);
}
export function transition(
  state: Simulation,
  command: LoanCommand
): Simulation {
  const s: Simulation = structuredClone(state);
  const { action } = command;
  const role = s.role;
  const loan = s.loan;
  const b = s.balances;
  let message = "";
  const pay = (who: Role, amount: bigint) => {
    check(b[who].usdc >= amount, "This role has insufficient USDC.");
    b[who].usdc -= amount;
  };
  if (action === "create") {
    check(role === "lender", "Only the lender can create an offer.");
    check(!loan, "Reset or replay before creating another offer.");
    const terms = command.draft && parseDraft(command.draft);
    check(terms, "Check the offer terms.");
    check(
      terms.principal <= 18446744073709551615n &&
        terms.collateralAmount <= 18446744073709551615n,
      "Amounts exceed the program's integer limit."
    );
    pay("lender", terms.principal);
    s.loan = { ...terms, status: "open", expiry: 0 };
    message = `Lender locked ${exactAmount(
      terms.principal,
      6
    )} USDC in the offer vault.`;
  } else {
    check(loan && loan.status !== "closed", "No open receipt is available.");
    if (action === "accept") {
      check(loan.status === "open", "This offer is no longer open.");
      check(
        role === "borrower",
        "Switch to the borrower to take this example loan."
      );
      check(
        currentLtvBps(loan.debt, simulationValue(s)) <= loan.maxLtvBps,
        "Collateral is insufficient at this price."
      );
      check(
        b.borrower.wsol >= loan.collateralAmount,
        "Borrower has insufficient wSOL."
      );
      b.borrower.wsol -= loan.collateralAmount;
      b.borrower.usdc += loan.principal;
      loan.status = "filled";
      loan.expiry = s.now + loan.durationSeconds;
      message = `Borrower received ${exactAmount(
        loan.principal,
        6
      )} USDC and locked ${exactAmount(loan.collateralAmount, 9)} wSOL.`;
    } else if (action === "cancel") {
      check(role === "lender", "Only the lender can cancel.");
      check(loan.status === "open", "Only an open offer can be cancelled.");
      b.lender.usdc += loan.principal;
      loan.status = "cancelled";
      message = `Lender received ${exactAmount(loan.principal, 6)} USDC back.`;
    } else if (action === "close") {
      check(role === "lender", "Only the lender can close the receipt.");
      check(
        !["open", "filled"].includes(loan.status),
        "Settle the loan first."
      );
      loan.status = "closed";
      message =
        "Receipt closed. On Devnet, account rent returns to the lender.";
    } else {
      check(
        loan.status === "filled",
        "This loan has already settled or has not been borrowed."
      );
      if (action === "repay") {
        check(role === "borrower", "Only the borrower can repay.");
        check(
          s.now < loan.expiry,
          "The deadline has passed. Repayment is unavailable."
        );
        pay("borrower", loan.debt);
        b.lender.usdc += loan.debt;
        b.borrower.wsol += loan.collateralAmount;
        loan.status = "repaid";
        message = `Borrower paid ${exactAmount(
          loan.debt,
          6
        )} USDC to the lender and recovered ${exactAmount(
          loan.collateralAmount,
          9
        )} wSOL.`;
      } else if (action === "claim") {
        check(s.now >= loan.expiry, "The loan has not expired.");
        b.lender.wsol += loan.collateralAmount;
        loan.status = "expired";
        message = `Lender received all ${exactAmount(
          loan.collateralAmount,
          9
        )} wSOL. Borrower received no collateral back.`;
      } else if (action === "liquidate") {
        check(
          role === "liquidator",
          "Borrower and lender cannot liquidate this loan."
        );
        check(s.now < loan.expiry, "At the deadline, claim expiry instead.");
        const value = simulationValue(s);
        check(
          currentLtvBps(loan.debt, value) >= loan.liquidationLtvBps,
          "The loan has not reached its liquidation threshold."
        );
        const seize = wsolToCaller(
          loan.collateralAmount,
          seizeUsdc(loan.debt),
          value
        );
        pay("liquidator", loan.debt);
        b.lender.usdc += loan.debt;
        b.liquidator.wsol += seize;
        b.borrower.wsol += loan.collateralAmount - seize;
        loan.status = "liquidated";
        message = `Liquidator paid ${exactAmount(
          loan.debt,
          6
        )} USDC to the lender and received ${exactAmount(
          seize,
          9
        )} wSOL. Borrower recovered ${exactAmount(
          loan.collateralAmount - seize,
          9
        )} wSOL.`;
      } else throw new Error("Unknown loan action.");
    }
  }
  s.receipts.push({ action, message });
  return s;
}
export class SimulationService implements LoanService {
  constructor(
    private read: () => Simulation,
    private write: (s: Simulation) => void
  ) {}
  async execute(c: LoanCommand) {
    const s = transition(this.read(), c);
    this.write(s);
    return s.receipts[s.receipts.length - 1];
  }
}
export function serializeSimulation(s: Simulation): string {
  return JSON.stringify(s, (_, v) =>
    typeof v === "bigint" ? { $bigint: v.toString() } : v
  );
}
export function restoreSimulation(raw: string): Simulation | null {
  try {
    const s = JSON.parse(raw, (_, v) =>
      v && typeof v === "object" && "$bigint" in v
        ? /^\d{1,30}$/.test(v.$bigint)
          ? BigInt(v.$bigint)
          : null
        : v
    ) as Simulation;
    check(
      s.version === 1 && ["lender", "borrower", "liquidator"].includes(s.role),
      "Invalid version/role"
    );
    check(
      Number.isSafeInteger(s.now) &&
        s.now >= 0 &&
        Number.isSafeInteger(s.publishTime) &&
        s.publishTime >= 0,
      "Invalid clock"
    );
    check(
      typeof s.price === "bigint" &&
        s.price > 0n &&
        typeof s.conf === "bigint" &&
        s.conf >= 0n &&
        s.conf < s.price,
      "Invalid oracle"
    );
    for (const role of ["lender", "borrower", "liquidator"] as const)
      for (const coin of ["usdc", "wsol"] as const)
        check(
          typeof s.balances[role][coin] === "bigint" &&
            s.balances[role][coin] >= 0n,
          "Invalid balance"
        );
    check(
      Array.isArray(s.receipts) &&
        s.receipts.length <= 500 &&
        s.receipts.every(
          (x) =>
            [
              "create",
              "accept",
              "repay",
              "cancel",
              "claim",
              "liquidate",
              "close",
            ].includes(x.action) &&
            typeof x.message === "string" &&
            x.message.length < 1000
        ),
      "Invalid receipt"
    );
    if (s.loan) {
      const l = s.loan;
      check(
        [
          "open",
          "filled",
          "repaid",
          "liquidated",
          "expired",
          "cancelled",
          "closed",
        ].includes(l.status),
        "Invalid status"
      );
      check(
        typeof l.principal === "bigint" &&
          typeof l.collateralAmount === "bigint" &&
          typeof l.debt === "bigint",
        "Invalid amounts"
      );
      const parsed = parseDraft({
        principal: exactAmount(l.principal, 6),
        collateral: exactAmount(l.collateralAmount, 9),
        interestBps: l.interestBps,
        durationSeconds: l.durationSeconds,
        maxLtvBps: l.maxLtvBps,
        liquidationLtvBps: l.liquidationLtvBps,
      });
      check(
        parsed &&
          parsed.debt === l.debt &&
          Number.isSafeInteger(l.expiry) &&
          l.expiry >= 0,
        "Invalid terms"
      );
    }
    const usdcVault = s.loan?.status === "open" ? s.loan.principal : 0n;
    const wsolVault =
      s.loan?.status === "filled" ? s.loan.collateralAmount : 0n;
    check(
      Object.values(s.balances).reduce((n, b) => n + b.usdc, usdcVault) ===
        3000000000n,
      "Invalid USDC ledger"
    );
    check(
      Object.values(s.balances).reduce((n, b) => n + b.wsol, wsolVault) ===
        10000000000n,
      "Invalid wSOL ledger"
    );
    return s;
  } catch {
    return null;
  }
}
export function validStoredDraft(raw: unknown): raw is OfferDraft {
  if (!raw || typeof raw !== "object") return false;
  const d = raw as OfferDraft;
  return (
    typeof d.principal === "string" &&
    d.principal.length <= 40 &&
    typeof d.collateral === "string" &&
    d.collateral.length <= 40 &&
    [d.interestBps, d.durationSeconds, d.maxLtvBps, d.liquidationLtvBps].every(
      Number.isSafeInteger
    )
  );
}
export type { LoanAction };
