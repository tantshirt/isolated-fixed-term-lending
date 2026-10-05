// Byte layouts of the ER-only room records in programs/private_loan/src/room.rs.
// Borsh, fixed-size arrays, no Anchor discriminator (records are raw ER-only accounts).
import { PublicKey } from "@solana/web3.js";

export const PRIVATE_PROGRAM_ID = new PublicKey("HwK4hxKqe94pLGkC9bGciENCCzvWwUAaz1mxVTDxMcK");
export const MAX_MEMBERS = 8;
export const MAX_MESSAGES = 16;
export const MAX_BODY = 140;

export const ROLE = { borrower: 1, lender: 2, viewer: 3 } as const;
export type RoleName = keyof typeof ROLE;
export const ROLE_NAME: Record<number, RoleName> = { 1: "borrower", 2: "lender", 3: "viewer" };

export const SCOPE = {
  postMessage: 1 << 0,
  editDraft: 1 << 1,
  reviseProposal: 1 << 2,
  approvedAiRequest: 1 << 3,
} as const;
export const SCOPE_ALL_NONFINANCIAL = SCOPE.postMessage | SCOPE.editDraft | SCOPE.reviseProposal | SCOPE.approvedAiRequest;

const enc = new TextEncoder();
const dec = new TextDecoder();

export const roomAnchorPda = (roomId: Uint8Array) =>
  PublicKey.findProgramAddressSync([enc.encode("room"), roomId], PRIVATE_PROGRAM_ID)[0];
export const roomStatePda = (anchor: PublicKey) =>
  PublicKey.findProgramAddressSync([enc.encode("room-state"), anchor.toBytes()], PRIVATE_PROGRAM_ID)[0];
export const roomThreadPda = (anchor: PublicKey) =>
  PublicKey.findProgramAddressSync([enc.encode("room-thread"), anchor.toBytes()], PRIVATE_PROGRAM_ID)[0];
export const sessionPda = (anchor: PublicKey, sessionKey: PublicKey) =>
  PublicKey.findProgramAddressSync([enc.encode("session"), anchor.toBytes(), sessionKey.toBytes()], PRIVATE_PROGRAM_ID)[0];

export type RoomMember = { pubkey: PublicKey; role: RoleName; owner: boolean };
export type RoomState = { owner: PublicKey; revision: bigint; members: RoomMember[] };
export type RoomMessage = { author: PublicKey; ts: number; body: string; index: number };

function view(data: Uint8Array) {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

export function decodeRoomState(data: Uint8Array): RoomState {
  const v = view(data);
  let o = 1; // version
  const owner = new PublicKey(data.slice(o, o + 32));
  o += 32;
  const revision = v.getBigUint64(o, true);
  o += 8;
  const members: RoomMember[] = [];
  for (let i = 0; i < MAX_MEMBERS; i++) {
    const pubkey = new PublicKey(data.slice(o, o + 32));
    const role = data[o + 32];
    const active = data[o + 33] === 1;
    o += 34;
    if (active) members.push({ pubkey, role: ROLE_NAME[role] ?? "viewer", owner: pubkey.equals(owner) });
  }
  return { owner, revision, members };
}

/** Messages oldest first. The thread keeps the last `MAX_MESSAGES`. */
export function decodeRoomThread(data: Uint8Array): RoomMessage[] {
  const v = view(data);
  const count = v.getUint32(0, true);
  const slot = 32 + 8 + 2 + MAX_BODY;
  const out: RoomMessage[] = [];
  const first = Math.max(0, count - MAX_MESSAGES);
  for (let index = first; index < count; index++) {
    const o = 4 + (index % MAX_MESSAGES) * slot;
    const author = new PublicKey(data.slice(o, o + 32));
    const ts = Number(v.getBigInt64(o + 32, true));
    const len = v.getUint16(o + 40, true);
    out.push({ author, ts, body: dec.decode(data.slice(o + 42, o + 42 + len)), index });
  }
  return out;
}

export function encodeMessage(text: string): Uint8Array {
  const bytes = enc.encode(text.trim());
  if (bytes.length === 0 || bytes.length > MAX_BODY) throw new Error(`Messages are 1 to ${MAX_BODY} bytes.`);
  return bytes;
}
