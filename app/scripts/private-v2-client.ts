/**
 * Drives the browser client for private V2 rooms and desks (lib/private/v2-loans.ts, v2-desks.ts)
 * against the Devnet TEE with throwaway wallets, so the screens' exact calls are proven live:
 * room, borrowing request, desk with an auditor, desk-bound offer, auditor list shared and
 * verified by hash, acceptance with consent, partial repayment, top-up, full payoff.
 *
 *   npx tsx --env-file=.env.local scripts/private-v2-client.ts
 *
 * Funded from the Solana CLI key; test wallets are saved under isolated_loan/.local/parties for
 * refunds and cashed out at the end. Never prints keys. Appends to docs/magicblock-evidence.json.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync, writeFileSync } from "node:fs";
import { KeypairWallet } from "../lib/keypair-wallet";
import { maxExposure } from "../lib/loan-math-v2";
import { minCollateralLamports } from "../lib/risk";
import { auditorHash, decodeLoanTermsV2, ROLE_V2, v2Pda } from "../lib/private/v2-codec";
import { openDesk, publishPolicy, readDesk, setDeskMember } from "../lib/private/v2-desks";
import { acceptV2, fundV2, inviteV2, openRoomV2, postV2, proposeV2, readRoomV2, repayV2, shareAuditorsV2, topUpV2 } from "../lib/private/v2-loans";
import { audienceFor, requestBody, requestsInThread, sharedAuditors, v2LoanState } from "../lib/private/v2-room-view";
import { DEFAULT_POLICY } from "../lib/private/desk-view";
import { DEFAULT_RULES, termsFrom } from "../lib/v2/rules";
import { refreshPyth } from "./pyth-refresh";
import { USDC, WSOL, cashOut, makePrivate, newParty, privateBalance, type Party } from "../../isolated_loan/scripts/private/lib/parties";
import { authority as funder, base, sleep, teeConnection, waitFor } from "../../isolated_loan/spikes/lib/custody";
import { PYTH_PRICE_UPDATE_ACCOUNT } from "../lib/constants";

const checks: Record<string, { ok: boolean; detail: unknown }> = {};
const fail: string[] = [];
const expect = (name: string, ok: boolean, detail: unknown) => {
  checks[name] = { ok, detail };
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`, typeof detail === "string" ? detail.slice(0, 140) : detail);
  if (!ok) fail.push(name);
};
const wallet = (p: Party) => new KeypairWallet(p.kp);

async function price() {
  const d = (await base.getAccountInfo(PYTH_PRICE_UPDATE_ACCOUNT))!.data;
  const off = 8 + 32 + (d[40] === 0 ? 2 : 1) + 32;
  return { price: d.readBigInt64LE(off), conf: d.readBigUInt64LE(off + 8), exponent: d.readInt32LE(off + 16) };
}

async function freshPrice(p: Party) {
  const age = async () => {
    const d = (await p.er.getAccountInfo(PYTH_PRICE_UPDATE_ACCOUNT))!.data;
    return Math.floor(Date.now() / 1000) - Number(d.readBigInt64LE(8 + 32 + (d[40] === 0 ? 2 : 1) + 32 + 20));
  };
  if ((await age()) < 40) return;
  if (process.env.PYTH_HERMES_API_KEY) await refreshPyth(base, funder);
  await waitFor("fresh SOL/USD price in the TEE", age, (a) => a < 40, 900);
}

async function retry<T>(label: string, f: () => Promise<T>, tries = 6): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      if (i >= tries || !/101|StalePrice|blockhash|429|fetch failed/i.test(m)) throw e;
      console.log(`retry ${label}: ${m.slice(0, 80)}`);
      await sleep(10_000);
    }
  }
}

async function main() {
  const owner = await newParty("owner", 150_000_000, 0n);
  const lender = await newParty("lender", 200_000_000, 300_000n);
  const borrower = await newParty("borrower", 150_000_000, 50_000n);
  const auditorKp = Keypair.generate();
  const auditor: Party = { kp: auditorKp, er: await teeConnection(auditorKp), name: "auditor" };

  const principal = 100_000n; // 0.1 USDC
  const days = 1;
  const terms = termsFrom({ principal, interestBps: 100, durationSeconds: days * 86_400 }, DEFAULT_RULES)!;
  const collateral = minCollateralLamports(maxExposure(terms), 5_000, await price());
  await makePrivate(lender, USDC, 200_000n);
  await makePrivate(lender, WSOL, 0n);
  await makePrivate(borrower, USDC, 50_000n);
  await makePrivate(borrower, WSOL, collateral * 3n);

  // Room: owner is a viewer only; lender and borrower are invited with explicit roles.
  const room = await openRoomV2(base, owner.er, wallet(owner), ROLE_V2.viewer);
  await inviteV2(base, owner.er, wallet(owner), room.anchor, lender.kp.publicKey, ROLE_V2.lender);
  await inviteV2(base, owner.er, wallet(owner), room.anchor, borrower.kp.publicKey, ROLE_V2.borrower);
  expect("client-opens-room-and-invites", true, room.anchor.toBase58());

  await postV2(base, borrower.er, wallet(borrower), room.anchor, requestBody("0.1", days));
  const seen = await readRoomV2(lender.er, room.anchor);
  const req = seen.access === "member" ? requestsInThread(seen.messages)[0] : undefined;
  expect("lender-sees-the-borrowing-request", !!req && req.principal === principal && req.borrower.equals(borrower.kp.publicKey), req?.index);

  // Desk: the lender administers and lends; the auditor is named in policy version 1.
  const desk = await openDesk(base, lender.er, wallet(lender), true);
  await setDeskMember(base, lender.er, wallet(lender), desk.anchor, auditor.kp.publicKey, 4);
  await publishPolicy(base, lender.er, wallet(lender), desk.anchor, 1, { ...DEFAULT_POLICY, minPrincipal: 10_000n, minDurationSeconds: 86_400, maxAnnualCeilingBps: 60_000, auditors: [auditor.kp.publicKey] });
  const d = await readDesk(lender.er, desk.anchor);
  expect("client-opens-desk-and-publishes-policy", d.access === "member" && d.policy?.version === 1 && d.policy.auditors.length === 1, d.access);

  const { anchor } = await proposeV2(base, lender.er, wallet(lender), room.anchor, { borrower: borrower.kp.publicKey, requestIndex: req!.index, terms, collateralAmount: collateral, maxLtvBps: 5_000, liquidationLtvBps: 8_000 }, desk.anchor);
  const read = async (p: Party) => {
    const i = await p.er.getAccountInfo(v2Pda.terms(anchor));
    return i ? decodeLoanTermsV2(i.data) : null;
  };
  const drafted = (await read(lender))!;
  expect("offer-is-under-the-desk", !!drafted.desk?.equals(desk.anchor) && drafted.policyVersion === 1, drafted.status);
  await shareAuditorsV2(base, lender.er, wallet(lender), room.anchor, drafted);
  await fundV2(base, lender.er, wallet(lender), anchor, drafted.revision);

  // Borrower: verifies the shared audience against the hash in the terms, then consents.
  const bRoom = await readRoomV2(borrower.er, room.anchor);
  const t = (await read(borrower))!;
  const shared = bRoom.access === "member" ? sharedAuditors(bRoom.messages, t) : [];
  const hash = shared.length ? await auditorHash(shared.map((k) => new PublicKey(k))) : null;
  const audience = audienceFor(t, shared, hash);
  expect("borrower-verifies-the-auditor-audience", audience.kind === "named" && audience.auditors[0] === auditor.kp.publicKey.toBase58(), audience.kind);
  expect("auditor-hidden-before-consent", (await read(auditor)) === null, "hidden");
  await freshPrice(borrower);
  await retry("accept", () => acceptV2(base, borrower.er, wallet(borrower), room.anchor, anchor, t, hash!));
  expect("auditor-reads-after-consent", (await read(auditor)) !== null, "visible");

  // Partial repayment, top-up, then the full payoff the screen shows.
  const now = () => Math.floor(Date.now() / 1000);
  await retry("repay-part", async () => repayV2(base, borrower.er, wallet(borrower), anchor, (await read(borrower))!, 10_000n));
  const afterPart = (await read(borrower))!;
  expect("partial-repayment-applies", afterPart.status === "active" && afterPart.ledger.interestPaid + (afterPart.terms.principal - afterPart.ledger.outstandingPrincipal) > 0n, afterPart.ledger.outstandingPrincipal.toString());
  await retry("top-up", async () => topUpV2(base, borrower.er, wallet(borrower), anchor, (await read(borrower))!, 1_000_000n));
  const topped = (await read(borrower))!;
  expect("top-up-adds-collateral", topped.collateralLocked === collateral + 1_000_000n, topped.collateralLocked.toString());
  const wsolBefore = await privateBalance(borrower, WSOL);
  const state = v2LoanState(topped, borrower.kp.publicKey, now() + 60);
  await retry("repay-full", async () => repayV2(base, borrower.er, wallet(borrower), anchor, (await read(borrower))!, state.payoff!));
  const done = (await read(borrower))!;
  const wsolAfter = await privateBalance(borrower, WSOL);
  expect("full-payoff-repays-and-returns-collateral", done.status === "repaid" && wsolBefore !== null && wsolAfter !== null && wsolAfter - wsolBefore === topped.collateralLocked, { status: done.status });

  await cashOut(lender, [USDC, WSOL]);
  await cashOut(borrower, [USDC, WSOL]);

  const path = new URL("../../docs/magicblock-evidence.json", import.meta.url);
  const evidence = JSON.parse(readFileSync(path, "utf8"));
  evidence.v2Client = { at: new Date().toISOString(), room: room.anchor.toBase58(), desk: desk.anchor.toBase58(), loan: anchor.toBase58(), checks };
  writeFileSync(path, JSON.stringify(evidence, null, 2) + "\n");
  console.log(`\nV2 client: ${fail.length ? `FAIL (${fail.join(", ")})` : "PASS"}`);
  process.exit(fail.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
