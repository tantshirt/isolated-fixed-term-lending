import { readFileSync, writeFileSync } from "node:fs";

const FILE = new URL("../../../docs/magicblock-evidence.json", import.meta.url);

/** Writes one gate's raw evidence into docs/magicblock-evidence.json. */
export function recordGate(gate: string, evidence: Record<string, unknown>) {
  const doc = JSON.parse(readFileSync(FILE, "utf8"));
  doc.gates[gate] = evidence;
  writeFileSync(FILE, JSON.stringify(doc, null, 2) + "\n");
}
