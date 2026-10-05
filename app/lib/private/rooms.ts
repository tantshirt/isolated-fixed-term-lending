// Private rooms from the browser (story 9.2). Builds instructions from the
// private_loan IDL, checks each transaction against what the user reviewed,
// signs with the wallet (or an in-memory session key), and records a receipt.
import { AnchorProvider, BN, Program, utils, type Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import idl from "@/idl/private_loan.json";
import type { LoanSigner } from "@/lib/keypair-wallet";
import { MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID, permissionPda } from "./espl";
import { advance, newReceipt, saveReceipt, type ExecutionReceipt } from "./receipts";
import {
  ROLE,
  SCOPE,
  decodeRoomState,
  decodeRoomThread,
  encodeMessage,
  roomAnchorPda,
  roomStatePda,
  roomThreadPda,
  sessionPda,
  type RoleName,
  type RoomMessage,
  type RoomState,
} from "./room-codec";
import { validateTransaction } from "./tx-validator";

const EPHEMERAL_VAULT_ID = new PublicKey("MagicVau1t999999999999999999999999999999999");
const SESSION_SECONDS = 3600;

function programFor(base: Connection, signer: LoanSigner) {
  return new Program(idl as Idl, new AnchorProvider(base, signer, { commitment: "confirmed" }));
}

export type RoomRef = { roomId: string; anchor: PublicKey };

export function roomRef(roomId: string): RoomRef {
  const bytes = utils.bytes.bs58.decode(roomId);
  if (bytes.length !== 32) throw new Error("That room link is not valid.");
  return { roomId, anchor: roomAnchorPda(bytes) };
}

export function inviteLink(origin: string, roomId: string) {
  return `${origin}/devnet/private/rooms/${roomId}`;
}

// --- local room list (ids only; contents stay in the TEE) -------------------

const roomsKey = (wallet: string) => `lendspan:private:rooms:${wallet}`;

export function savedRooms(wallet: string): string[] {
  try {
    return JSON.parse(localStorage.getItem(roomsKey(wallet)) ?? "[]");
  } catch {
    return [];
  }
}

export function rememberRoom(wallet: string, roomId: string) {
  try {
    const list = [roomId, ...savedRooms(wallet).filter((r) => r !== roomId)].slice(0, 20);
    localStorage.setItem(roomsKey(wallet), JSON.stringify(list));
  } catch {}
}

// --- sending ----------------------------------------------------------------

async function sendEr(
  er: Connection,
  feePayer: PublicKey,
  ix: TransactionInstruction,
  sign: (tx: Transaction) => Promise<Transaction>,
  receipt: ExecutionReceipt,
  wallet: string,
): Promise<string> {
  const tx = new Transaction().add(ix);
  tx.feePayer = feePayer;
  validateTransaction(tx, { feePayer });
  tx.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
  const signed = await sign(tx);
  const sig = await er.sendRawTransaction(signed.serialize(), { skipPreflight: true });
  saveReceipt(wallet, advance(receipt, { erSignature: sig }));
  const res = await er.confirmTransaction(sig, "confirmed");
  if (res.value.err) {
    const t = await er.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
    const named = t?.meta?.logMessages?.find((l) => l.includes("Error Message:"))?.split("Error Message: ")[1];
    saveReceipt(wallet, advance(receipt, { erSignature: sig, stage: "failed", error: named ?? JSON.stringify(res.value.err) }));
    throw new Error(named ?? "The private rollup rejected this action.");
  }
  saveReceipt(wallet, advance(receipt, { erSignature: sig, stage: "executed" }));
  return sig;
}

function recordAccounts(anchor: PublicKey) {
  const state = roomStatePda(anchor);
  const thread = roomThreadPda(anchor);
  return {
    anchor,
    state,
    statePermission: permissionPda(state),
    thread,
    threadPermission: permissionPda(thread),
    vault: EPHEMERAL_VAULT_ID,
    magicProgram: MAGIC_PROGRAM_ID,
    permissionProgram: PERMISSION_PROGRAM_ID,
  };
}

// --- actions ------------------------------------------------------------------

/** Base layer: create, fund, and delegate the room anchor. Then the ER creates the private records. */
export async function openRoom(base: Connection, er: Connection, signer: LoanSigner): Promise<RoomRef> {
  const program = programFor(base, signer);
  const idBytes = crypto.getRandomValues(new Uint8Array(32));
  const roomId = utils.bytes.bs58.encode(idBytes);
  const anchor = roomAnchorPda(idBytes);
  const wallet = signer.publicKey.toBase58();

  const receipt = newReceipt("Open a private room", "base");
  const tx = new Transaction().add(
    await program.methods.openRoom([...idBytes]).accountsPartial({ creator: signer.publicKey, anchor }).instruction(),
    await program.methods.delegateRoom([...idBytes]).accountsPartial({ creator: signer.publicKey, anchor }).instruction(),
  );
  tx.feePayer = signer.publicKey;
  validateTransaction(tx, { feePayer: signer.publicKey });
  const { blockhash, lastValidBlockHeight } = await base.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  const signed = await signer.signTransaction(tx);
  const sig = await base.sendRawTransaction(signed.serialize());
  saveReceipt(wallet, advance(receipt, { baseSignature: sig }));
  await base.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  saveReceipt(wallet, advance(receipt, { baseSignature: sig, stage: "settled" }));
  rememberRoom(wallet, roomId);

  for (let i = 0; i < 30 && !(await er.getAccountInfo(anchor)); i++) await new Promise((r) => setTimeout(r, 1000));
  await sendEr(
    er,
    signer.publicKey,
    await program.methods.initRoom().accountsPartial({ owner: signer.publicKey, ...recordAccounts(anchor) }).instruction(),
    (t) => signer.signTransaction(t),
    newReceipt("Create the private member list and thread", "er"),
    wallet,
  );
  return { roomId, anchor };
}

export type RoomView =
  | { access: "member"; state: RoomState; messages: RoomMessage[] }
  | { access: "none" };

/** Reads through the TEE. A non-member gets nothing, which is the point. */
export async function readRoom(er: Connection, anchor: PublicKey): Promise<RoomView> {
  const [s, t] = await Promise.all([er.getAccountInfo(roomStatePda(anchor)), er.getAccountInfo(roomThreadPda(anchor))]);
  if (!s || !t) return { access: "none" };
  return { access: "member", state: decodeRoomState(s.data), messages: decodeRoomThread(t.data) };
}

export async function inviteMember(base: Connection, er: Connection, signer: LoanSigner, anchor: PublicKey, member: PublicKey, role: RoleName) {
  const program = programFor(base, signer);
  return sendEr(
    er,
    signer.publicKey,
    await program.methods.inviteMember(member, ROLE[role]).accountsPartial({ owner: signer.publicKey, ...recordAccounts(anchor) }).instruction(),
    (t) => signer.signTransaction(t),
    newReceipt(`Invite ${member.toBase58().slice(0, 4)}… as ${role}`, "er"),
    signer.publicKey.toBase58(),
  );
}

export async function revokeMember(base: Connection, er: Connection, signer: LoanSigner, anchor: PublicKey, member: PublicKey) {
  const program = programFor(base, signer);
  return sendEr(
    er,
    signer.publicKey,
    await program.methods.revokeMember(member).accountsPartial({ owner: signer.publicKey, ...recordAccounts(anchor) }).instruction(),
    (t) => signer.signTransaction(t),
    newReceipt(`Remove ${member.toBase58().slice(0, 4)}…`, "er"),
    signer.publicKey.toBase58(),
  );
}

// --- sessions -------------------------------------------------------------------

export type RoomSession = { key: Keypair; anchor: string; expiresAt: number };
const liveSessions = new Map<string, RoomSession>();
const sessionId = (wallet: string, anchor: PublicKey) => `${wallet}:${anchor.toBase58()}`;

export function activeSession(wallet: PublicKey, anchor: PublicKey): RoomSession | null {
  const s = liveSessions.get(sessionId(wallet.toBase58(), anchor));
  return s && s.expiresAt * 1000 > Date.now() + 30_000 ? s : null;
}

/** The wallet signs once; the key stays in memory for an hour and can only post and edit drafts. */
export async function startSession(base: Connection, er: Connection, signer: LoanSigner, anchor: PublicKey): Promise<RoomSession> {
  const program = programFor(base, signer);
  const key = Keypair.generate();
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const session = sessionPda(anchor, key.publicKey);
  await sendEr(
    er,
    signer.publicKey,
    await program.methods
      .createSession(key.publicKey, new BN(expiresAt), SCOPE.postMessage | SCOPE.editDraft)
      .accountsPartial({
        authority: signer.publicKey,
        anchor,
        state: roomStatePda(anchor),
        session,
        sessionPermission: permissionPda(session),
        vault: EPHEMERAL_VAULT_ID,
        magicProgram: MAGIC_PROGRAM_ID,
        permissionProgram: PERMISSION_PROGRAM_ID,
      })
      .instruction(),
    (t) => signer.signTransaction(t),
    newReceipt("Allow quick replies for one hour", "er"),
    signer.publicKey.toBase58(),
  );
  const live = { key, anchor: anchor.toBase58(), expiresAt };
  liveSessions.set(sessionId(signer.publicKey.toBase58(), anchor), live);
  return live;
}

export async function endSession(base: Connection, er: Connection, signer: LoanSigner, anchor: PublicKey) {
  const live = activeSession(signer.publicKey, anchor);
  liveSessions.delete(sessionId(signer.publicKey.toBase58(), anchor));
  if (!live) return;
  const program = programFor(base, signer);
  await sendEr(
    er,
    signer.publicKey,
    await program.methods
      .revokeSession()
      .accountsPartial({ authority: signer.publicKey, session: sessionPda(anchor, live.key.publicKey) })
      .instruction(),
    (t) => signer.signTransaction(t),
    newReceipt("End quick replies", "er"),
    signer.publicKey.toBase58(),
  );
}

export async function postMessage(base: Connection, er: Connection, signer: LoanSigner, anchor: PublicKey, text: string) {
  const program = programFor(base, signer);
  const session = activeSession(signer.publicKey, anchor);
  const actor = session ? session.key.publicKey : signer.publicKey;
  const ix = await program.methods
    .postMessage(Buffer.from(encodeMessage(text)))
    .accountsPartial({
      signer: actor,
      anchor,
      state: roomStatePda(anchor),
      thread: roomThreadPda(anchor),
      // Anchor treats null as "no session": the wallet itself is acting.
      session: (session ? sessionPda(anchor, session.key.publicKey) : null) as PublicKey,
    })
    .instruction();
  return sendEr(
    er,
    actor,
    ix,
    async (t) => {
      if (session) t.sign(session.key);
      else await signer.signTransaction(t);
      return t;
    },
    newReceipt(session ? "Message (quick reply)" : "Message", "er"),
    signer.publicKey.toBase58(),
  );
}
