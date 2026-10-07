// Private V2 rooms and loans from the browser (Stories 22.1, 22.2, 24.1). Mirrors
// isolated_loan/scripts/private/v2-rooms.ts, which proves the same calls on the Devnet TEE.
import { BN, utils } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { DEVNET_USDC_MINT, NATIVE_WSOL_MINT, PYTH_PRICE_UPDATE_ACCOUNT } from "@/lib/constants";
import type { LoanSigner } from "@/lib/keypair-wallet";
import type { TermsV2 } from "@/lib/loan-math-v2";
import { DELEGATION_PROGRAM_ID, ESPL_PROGRAM_ID, ata, eataPda, permissionPda } from "./espl";
import { decodeRoomThread, type RoomMessage } from "./room-codec";
import { ER_ONLY, programV2, sendBase, sendEr, waitInEr } from "./v2-send";
import { ROLE_V2, decodeDeskPolicy, decodeDeskState, decodeLoanTermsV2, decodeRoomStateV2, v2Pda, type LoanTermsV2, type RoomStateV2 } from "./v2-codec";
import { auditorBody } from "./v2-room-view";

const USDC = DEVNET_USDC_MINT;
const WSOL = NATIVE_WSOL_MINT;
const enc = new TextEncoder();
const bufferPda = (account: PublicKey) => PublicKey.findProgramAddressSync([enc.encode("buffer"), account.toBytes()], ESPL_PROGRAM_ID)[0];
const recordPda = (account: PublicKey) => PublicKey.findProgramAddressSync([enc.encode("delegation"), account.toBytes()], DELEGATION_PROGRAM_ID)[0];
const metadataPda = (account: PublicKey) => PublicKey.findProgramAddressSync([enc.encode("delegation-metadata"), account.toBytes()], DELEGATION_PROGRAM_ID)[0];

// --- room references (ids only in this browser; contents stay in the TEE) -----------------

export type RoomV2Ref = { creator: PublicKey; roomId: string; anchor: PublicKey };

export function roomV2Ref(creator: string, roomId: string): RoomV2Ref {
  const bytes = utils.bytes.bs58.decode(roomId);
  if (bytes.length !== 32) throw new Error("That room link is not valid.");
  const c = new PublicKey(creator);
  return { creator: c, roomId, anchor: v2Pda.room(c, bytes) };
}

export const roomV2Path = (r: { creator: PublicKey | string; roomId: string }) => `/devnet/private/v2/${r.creator.toString()}/${r.roomId}`;

const roomsKey = (wallet: string) => `zenlo:private:v2rooms:${wallet}`;

export function savedRoomsV2(wallet: string): { creator: string; roomId: string }[] {
  try {
    return JSON.parse(localStorage.getItem(roomsKey(wallet)) ?? "[]");
  } catch {
    return [];
  }
}

export function rememberRoomV2(wallet: string, r: { creator: string; roomId: string }) {
  try {
    localStorage.setItem(roomsKey(wallet), JSON.stringify([r, ...savedRoomsV2(wallet).filter((x) => x.roomId !== r.roomId)].slice(0, 20)));
  } catch {}
}

const roomRecords = (anchor: PublicKey) => {
  const state = v2Pda.roomState(anchor);
  const thread = v2Pda.roomThread(anchor);
  return { anchor, state, statePermission: permissionPda(state), thread, threadPermission: permissionPda(thread), ...ER_ONLY };
};

// --- rooms ------------------------------------------------------------------------------

export async function openRoomV2(base: Connection, er: Connection, signer: LoanSigner, ownerRoles: number): Promise<RoomV2Ref> {
  const p = programV2(base, signer);
  const idBytes = crypto.getRandomValues(new Uint8Array(32));
  const roomId = utils.bytes.bs58.encode(idBytes);
  const anchor = v2Pda.room(signer.publicKey, idBytes);
  await sendBase(
    base,
    signer,
    [
      await p.methods.openRoom([...idBytes]).accountsPartial({ creator: signer.publicKey, anchor }).instruction(),
      await p.methods.delegateRoom([...idBytes]).accountsPartial({ creator: signer.publicKey, anchor }).instruction(),
    ],
    "Open a private room",
  );
  rememberRoomV2(signer.publicKey.toBase58(), { creator: signer.publicKey.toBase58(), roomId });
  await waitInEr(er, anchor);
  await finishRoomV2(base, er, signer, anchor, ownerRoles);
  return { creator: signer.publicKey, roomId, anchor };
}

export async function finishRoomV2(base: Connection, er: Connection, signer: LoanSigner, anchor: PublicKey, ownerRoles: number) {
  const ix = await programV2(base, signer).methods.initRoom(ownerRoles).accountsPartial({ owner: signer.publicKey, ...roomRecords(anchor) }).instruction();
  return sendEr(er, signer, ix, "Create the room's private member list and thread");
}

export async function inviteV2(base: Connection, er: Connection, signer: LoanSigner, anchor: PublicKey, member: PublicKey, roles: number) {
  const ix = await programV2(base, signer).methods.inviteMember(member, roles).accountsPartial({ owner: signer.publicKey, ...roomRecords(anchor) }).instruction();
  return sendEr(er, signer, ix, `Invite ${member.toBase58().slice(0, 4)}…`);
}

export async function revokeV2(base: Connection, er: Connection, signer: LoanSigner, anchor: PublicKey, member: PublicKey) {
  const ix = await programV2(base, signer).methods.revokeMember(member).accountsPartial({ owner: signer.publicKey, ...roomRecords(anchor) }).instruction();
  return sendEr(er, signer, ix, `Remove ${member.toBase58().slice(0, 4)}…`);
}

export async function postV2(base: Connection, er: Connection, signer: LoanSigner, anchor: PublicKey, text: string) {
  const ix = await programV2(base, signer)
    .methods.postMessage(Buffer.from(enc.encode(text)))
    .accountsPartial({ signer: signer.publicKey, anchor, state: v2Pda.roomState(anchor), thread: v2Pda.roomThread(anchor), session: null })
    .instruction();
  return sendEr(er, signer, ix, "Post to the room");
}

export type RoomV2Read =
  | { access: "none" }
  | { access: "member"; state: RoomStateV2; messages: RoomMessage[]; loans: { index: number; anchor: PublicKey; terms: LoanTermsV2 | null }[] };

/** Reads through the TEE with the viewer's token. Each loan's terms come back only to its parties and consented readers. */
export async function readRoomV2(er: Connection, anchor: PublicKey): Promise<RoomV2Read> {
  const [s, t] = await Promise.all([er.getAccountInfo(v2Pda.roomState(anchor)), er.getAccountInfo(v2Pda.roomThread(anchor))]);
  if (!s || !t) return { access: "none" };
  const state = decodeRoomStateV2(s.data);
  const regKeys = Array.from({ length: state.nextLoanIndex }, (_, i) => v2Pda.roomLoan(anchor, i));
  const regs = regKeys.length ? await er.getMultipleAccountsInfo(regKeys) : [];
  const entries = regs.map((r, index) => (r ? { index, anchor: new PublicKey(r.data.subarray(0, 32)) } : null)).filter((x): x is { index: number; anchor: PublicKey } => !!x);
  const terms = entries.length ? await er.getMultipleAccountsInfo(entries.map((e) => v2Pda.terms(e.anchor))) : [];
  const loans = entries.map((e, i) => {
    let decoded: LoanTermsV2 | null = null;
    try {
      decoded = terms[i] ? decodeLoanTermsV2(terms[i]!.data) : null;
    } catch {}
    return { ...e, terms: decoded };
  });
  return { access: "member", state, messages: decodeRoomThread(t.data), loans };
}

// --- loans --------------------------------------------------------------------------------

export type ProposalV2 = {
  borrower: PublicKey;
  requestIndex: number;
  terms: TermsV2;
  collateralAmount: bigint;
  maxLtvBps: number;
  liquidationLtvBps: number;
};

const termsArgs = (x: ProposalV2) => ({
  borrower: x.borrower,
  requestIndex: x.requestIndex,
  principal: new BN(x.terms.principal.toString()),
  interestBps: x.terms.interestBps,
  durationSeconds: new BN(x.terms.duration),
  earlyRepayment: x.terms.earlyRepayment,
  minInterestBps: x.terms.minInterestBps,
  graceSeconds: new BN(x.terms.graceSeconds),
  lateFeeBps: x.terms.lateFeeBps,
  annualCeilingBps: x.terms.annualCeilingBps,
  collateralAmount: new BN(x.collateralAmount.toString()),
  maxLtvBps: x.maxLtvBps,
  liquidationLtvBps: x.liquidationLtvBps,
});

/**
 * Base: the loan anchor with its own custody, delegated to the TEE. ER: the terms, at the room's
 * next index. With a desk, the loan is then placed under the desk's current policy.
 */
export async function proposeV2(base: Connection, er: Connection, signer: LoanSigner, room: PublicKey, x: ProposalV2, desk?: PublicKey) {
  const p = programV2(base, signer);
  const nonce = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
  const anchor = v2Pda.loan(signer.publicKey, nonce);
  const ue = eataPda(anchor, USDC);
  const we = eataPda(anchor, WSOL);
  await sendBase(
    base,
    signer,
    [
      await p.methods
        .createLoan(new BN(nonce.toString()))
        .accountsPartial({
          lender: signer.publicKey, anchor, room, usdcMint: USDC, wsolMint: WSOL, usdcEata: ue, wsolEata: we,
          usdcBuffer: bufferPda(ue), usdcRecord: recordPda(ue), usdcMetadata: metadataPda(ue),
          wsolBuffer: bufferPda(we), wsolRecord: recordPda(we), wsolMetadata: metadataPda(we),
          esplProgram: ESPL_PROGRAM_ID, delegationProgram: DELEGATION_PROGRAM_ID,
        })
        .instruction(),
      await p.methods.delegateLoan(new BN(nonce.toString())).accountsPartial({ lender: signer.publicKey, anchor }).instruction(),
    ],
    "Set up the loan's private custody",
  );
  await waitInEr(er, anchor);

  const stateInfo = await er.getAccountInfo(v2Pda.roomState(room));
  if (!stateInfo) throw new Error("The room could not be read.");
  const index = decodeRoomStateV2(stateInfo.data).nextLoanIndex;
  const registry = v2Pda.roomLoan(room, index);
  const terms = v2Pda.terms(anchor);
  await sendEr(
    er,
    signer,
    await p.methods
      .proposeTerms(termsArgs(x))
      .accountsPartial({
        lender: signer.publicKey, anchor, room, roomState: v2Pda.roomState(room), registry, registryPermission: permissionPda(registry),
        terms, termsPermission: permissionPda(terms), ...ER_ONLY,
      })
      .instruction(),
    "Propose loan terms",
    1,
  );
  if (desk) await attachV2(base, er, signer, anchor, desk);
  return { anchor, index };
}

/** Places a draft under a desk's current policy, then shares the auditor list in the room. */
export async function attachV2(base: Connection, er: Connection, signer: LoanSigner, anchor: PublicKey, desk: PublicKey) {
  const p = programV2(base, signer);
  const s = await er.getAccountInfo(v2Pda.deskState(desk));
  if (!s) throw new Error("This wallet cannot read that desk.");
  const state = decodeDeskState(s.data);
  if (state.policyVersion === 0) throw new Error("That desk has no policy yet.");
  const policy = v2Pda.deskPolicy(desk, state.policyVersion);
  const book = v2Pda.deskLoan(desk, state.nextLoanSeq);
  await sendEr(
    er,
    signer,
    await p.methods
      .attachDesk()
      .accountsPartial({
        lender: signer.publicKey, anchor, terms: v2Pda.terms(anchor), desk, state: v2Pda.deskState(desk), policy,
        bookEntry: book, bookPermission: permissionPda(book), ...ER_ONLY,
      })
      .instruction(),
    `Place the loan under desk policy version ${state.policyVersion}`,
  );
}

/** The lender re-posts the desk's auditor list for this loan so the borrower can check it. */
export async function shareAuditorsV2(base: Connection, er: Connection, signer: LoanSigner, room: PublicKey, t: LoanTermsV2) {
  if (!t.desk) return;
  const info = await er.getAccountInfo(v2Pda.deskPolicy(t.desk, t.policyVersion));
  if (!info) throw new Error("This wallet cannot read the desk policy.");
  for (const a of decodeDeskPolicy(info.data).auditors) await postV2(base, er, signer, room, auditorBody(t.roomIndex, a));
}

const lenderMoves = (lender: PublicKey, anchor: PublicKey) => ({ lender, anchor, terms: v2Pda.terms(anchor), lenderUsdc: ata(lender, USDC), loanUsdc: ata(anchor, USDC) });

const borrowerMoves = (t: LoanTermsV2, anchor: PublicKey) => ({
  borrower: t.borrower, anchor, terms: v2Pda.terms(anchor), borrowerUsdc: ata(t.borrower, USDC), borrowerWsol: ata(t.borrower, WSOL),
  loanUsdc: ata(anchor, USDC), loanWsol: ata(anchor, WSOL), lenderUsdc: ata(t.currentLender, USDC), priceUpdate: PYTH_PRICE_UPDATE_ACCOUNT,
  deal: null, dealPermission: null, vault: null, magicProgram: null, permissionProgram: null, termsPermission: null, deskPolicy: null,
});

export async function fundV2(base: Connection, er: Connection, signer: LoanSigner, anchor: PublicKey, revision: number) {
  const ix = await programV2(base, signer).methods.fundLoan(revision).accountsPartial(lenderMoves(signer.publicKey, anchor)).instruction();
  return sendEr(er, signer, ix, `Lock USDC (version ${revision})`, revision);
}

export async function cancelV2(base: Connection, er: Connection, signer: LoanSigner, anchor: PublicKey, funded: boolean) {
  const accounts = lenderMoves(signer.publicKey, anchor);
  // A draft moves no tokens; the lender may hold no private USDC account yet (see V1 cancel).
  if (!funded) accounts.lenderUsdc = accounts.loanUsdc;
  const ix = await programV2(base, signer).methods.cancelLoan().accountsPartial(accounts).instruction();
  return sendEr(er, signer, ix, "Cancel offer");
}

/** The borrower accepts this exact revision and this exact auditor audience (zeroes for none). */
export async function acceptV2(base: Connection, er: Connection, signer: LoanSigner, room: PublicKey, anchor: PublicKey, t: LoanTermsV2, audienceHash: Uint8Array) {
  const deal = v2Pda.deal(room, t.requestIndex);
  const terms = v2Pda.terms(anchor);
  const ix = await programV2(base, signer)
    .methods.acceptLoan(t.revision, [...audienceHash])
    .accountsPartial({
      ...borrowerMoves(t, anchor), deal, dealPermission: permissionPda(deal), ...ER_ONLY,
      termsPermission: t.desk ? permissionPda(terms) : null,
      deskPolicy: t.desk ? v2Pda.deskPolicy(t.desk, t.policyVersion) : null,
    })
    .instruction();
  return sendEr(er, signer, ix, `Lock wSOL and borrow (version ${t.revision})`, t.revision);
}

export async function repayV2(base: Connection, er: Connection, signer: LoanSigner, anchor: PublicKey, t: LoanTermsV2, amount: bigint) {
  const ix = await programV2(base, signer).methods.repay(new BN(amount.toString())).accountsPartial(borrowerMoves(t, anchor)).instruction();
  return sendEr(er, signer, ix, "Repay");
}

export async function topUpV2(base: Connection, er: Connection, signer: LoanSigner, anchor: PublicKey, t: LoanTermsV2, lamports: bigint) {
  const ix = await programV2(base, signer).methods.addCollateral(new BN(lamports.toString())).accountsPartial(borrowerMoves(t, anchor)).instruction();
  return sendEr(er, signer, ix, "Add collateral");
}

export async function claimV2(base: Connection, er: Connection, signer: LoanSigner, anchor: PublicKey, t: LoanTermsV2, kind: "priced" | "terminal") {
  const p = programV2(base, signer);
  const accounts = { lender: signer.publicKey, anchor, terms: v2Pda.terms(anchor), loanWsol: ata(anchor, WSOL), lenderWsol: ata(t.currentLender, WSOL), borrowerWsol: ata(t.borrower, WSOL), priceUpdate: PYTH_PRICE_UPDATE_ACCOUNT };
  const ix = await (kind === "priced" ? p.methods.claimPricedRecovery() : p.methods.claimTerminal()).accountsPartial(accounts).instruction();
  return sendEr(er, signer, ix, kind === "priced" ? "Take collateral at the market price" : "Claim all collateral");
}

/** Removing a reader ends their future access; either party may do it. */
export async function removeReaderV2(base: Connection, er: Connection, signer: LoanSigner, anchor: PublicKey, reader: PublicKey, current: PublicKey[]) {
  const terms = v2Pda.terms(anchor);
  const ix = await programV2(base, signer)
    .methods.removeLoanReader(reader, current)
    .accountsPartial({ lender: signer.publicKey, borrower: null, anchor, terms, termsPermission: permissionPda(terms), ...ER_ONLY })
    .instruction();
  return sendEr(er, signer, ix, `Remove reader ${reader.toBase58().slice(0, 4)}…`);
}

export { ROLE_V2 };
