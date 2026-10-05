import { readFile } from "node:fs/promises";
import path from "node:path";

export const PRIVATE_PROGRAM_ID = "HwK4hxKqe94pLGkC9bGciENCCzvWwUAaz1mxVTDxMcK";

export type GateStatus = "pass" | "finding" | "fail" | "not-run";

export type Gate = {
  id: string;
  title: string;
  question: string;
  proved: string;
  limit?: string;
  status: GateStatus;
  date?: string;
  script: string;
  signatures: { label: string; value: string; layer: "base" | "er" }[];
};

/** Plain-language summary of each Epic 8 gate. Status and signatures come from the evidence file. */
const COPY: Record<string, Omit<Gate, "id" | "status" | "date" | "signatures" | "script">> = {
  "8.1": {
    title: "Toolchain",
    question: "Does a private program build next to the public one?",
    proved: "Both programs build on Anchor 1.x with the MagicBlock SDK 0.17.3, with no warnings.",
    limit: "The SDK's token helpers do not build for Solana programs, so Lendspan builds those instructions itself.",
  },
  "8.2": {
    title: "Who can read a private account",
    question: "Can a member read private state while an outsider cannot?",
    proved: "The TEE attestation verifies first. Members read the account; outsiders get no account, no program list, no live updates, and no transaction details.",
    limit: "An outsider who already knows a signature learns that it exists and succeeded.",
  },
  "8.3": {
    title: "Records that never reach Solana",
    question: "Can sensitive records live only inside the rollup?",
    proved: "A record created inside the TEE is readable only by its member and never appears on Solana, even after its sponsor settles.",
    limit: "Validator restarts could not be tested on the hosted TEE, so these records are treated as non-durable.",
  },
  "8.4": {
    title: "Private token custody",
    question: "Can a program hold and move USDC and wSOL privately?",
    proved: "A program-owned account paid another inside the TEE. Balances settled to exactly 60 / 40 and withdrew to the starting amount for both tokens.",
    limit: "No wallet can read custody balances inside the TEE, so each loan keeps its own accounting.",
  },
  "8.5": {
    title: "The same Pyth price checks",
    question: "Do acceptance and liquidation keep the public program's price rules?",
    proved: "The canonical Pyth account passes the shared check inside the TEE. A 30-day-old account fails as stale, and MagicBlock's own feed fails the owner check.",
  },
  "8.6": {
    title: "Scheduled checks",
    question: "Can expiry and liquidation checks run on a timer without reading the loan?",
    proved: "A Hydra crank ran a signer-free tick on a private account, and a tick after settlement changed nothing.",
    limit: "No hosted cranker fired, so Lendspan's worker must trigger the schedule.",
  },
  "8.7": {
    title: "What settling reveals",
    question: "What does Solana see when private state settles?",
    proved: "Settling a private account writes its data to Solana in plain text.",
    limit: "So terms and negotiations must stay in rollup-only records; only balances and opaque receipts settle.",
  },
};

type RawGate = {
  status?: string;
  date?: string;
  signatures?: Record<string, string>;
  runs?: Record<string, { sigs?: Record<string, string> }>;
  setup?: string;
  checks?: Record<string, unknown>;
};

const ER_LABELS = new Set(["write", "transfer", "undelegate", "undelegateA", "undelegateB", "create"]);

function collectSignatures(id: string, g: RawGate): Gate["signatures"] {
  const out: Gate["signatures"] = [];
  const add = (label: string, value: string, erHint: boolean) => {
    if (typeof value === "string" && value.length > 60) out.push({ label, value, layer: erHint ? "er" : "base" });
  };
  for (const [k, v] of Object.entries(g.signatures ?? {})) add(k, v, ER_LABELS.has(k) && !(id === "8.3" && k === "setup"));
  for (const [mint, run] of Object.entries(g.runs ?? {})) {
    for (const [k, v] of Object.entries(run.sigs ?? {})) add(`${mint} ${k}`, v, k === "transfer" || k.startsWith("undelegate"));
  }
  if (g.setup) add("setup", g.setup, false);
  return out.slice(0, 4);
}

function statusOf(id: string, g?: RawGate): GateStatus {
  if (!g?.status) return "not-run";
  if (g.status !== "PASS") return "fail";
  return id === "8.7" ? "finding" : "pass";
}

export async function loadGates(): Promise<{ gates: Gate[]; error?: string }> {
  let raw: { gates?: Record<string, RawGate> } = {};
  let error: string | undefined;
  try {
    const file = path.join(process.cwd(), "..", "docs", "magicblock-evidence.json");
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch {
    error = "The evidence file docs/magicblock-evidence.json could not be read.";
  }
  const gates = Object.keys(COPY).map((id) => {
    const g = raw.gates?.[id];
    return {
      id,
      ...COPY[id],
      status: statusOf(id, g),
      date: g?.date,
      script: `isolated_loan/spikes/gate-${id.replace(".", "-")}.ts`,
      signatures: g ? collectSignatures(id, g) : [],
    };
  });
  return { gates, error };
}
