// Finding a wallet's rooms and the loans in them (story 17.1).
// The TEE filters getProgramAccounts by the caller's token, so listing room
// states returns exactly the rooms this wallet may read. Room and loan anchors
// are delegated, so they are listed through the ER as well (Solana returns none).
import { utils } from "@coral-xyz/anchor";
import type { Connection, PublicKey } from "@solana/web3.js";
import idl from "@/idl/private_loan.json";
import { decodeLoanTerms, loanTermsPda, type LoanStatus, type LoanTerms } from "./loan-codec";
import { MAX_MEMBERS, PRIVATE_PROGRAM_ID, decodeRoomState, roomStatePda, type RoleName, type RoomState } from "./room-codec";

/** RoomState: version, owner, revision, eight member slots. */
export const ROOM_STATE_LEN = 1 + 32 + 8 + MAX_MEMBERS * 34;
/** LoanAnchor: discriminator, loan id, then the room it was agreed in. */
export const LOAN_ANCHOR_ROOM_OFFSET = 8 + 32;
/** RoomAnchor: discriminator, then the 32-byte room id. */
const ROOM_ANCHOR_ID_OFFSET = 8;

const discriminator = (name: string) =>
  utils.bytes.bs58.encode(
    Uint8Array.from((idl as { accounts: { name: string; discriminator: number[] }[] }).accounts.find((a) => a.name === name)!.discriminator),
  );

export type MyRoom = {
  roomId: string;
  anchor: PublicKey;
  state: RoomState;
  role: RoleName;
  owner: boolean;
};

/** Every room this wallet is an active member of, with its link id. */
export async function listMyRooms(er: Connection, wallet: PublicKey): Promise<MyRoom[]> {
  const [states, anchors] = await Promise.all([
    er.getProgramAccounts(PRIVATE_PROGRAM_ID, { filters: [{ dataSize: ROOM_STATE_LEN }] }),
    er.getProgramAccounts(PRIVATE_PROGRAM_ID, {
      filters: [{ memcmp: { offset: 0, bytes: discriminator("RoomAnchor") } }],
      dataSlice: { offset: ROOM_ANCHOR_ID_OFFSET, length: 32 },
    }),
  ]);
  const byState = new Map(states.map((s) => [s.pubkey.toBase58(), decodeRoomState(s.account.data)]));
  const rooms: MyRoom[] = [];
  for (const a of anchors) {
    const state = byState.get(roomStatePda(a.pubkey).toBase58());
    if (!state) continue;
    const me = state.members.find((m) => m.pubkey.equals(wallet));
    if (!me) continue;
    rooms.push({
      roomId: utils.bytes.bs58.encode(a.account.data.subarray(0, 32)),
      anchor: a.pubkey,
      state,
      role: me.role,
      owner: state.owner.equals(wallet),
    });
  }
  return rooms;
}

export type RoomLoan = { anchor: PublicKey; loanId: string; terms: LoanTerms | null };

/** Every loan agreed in a room, however long ago it was posted to the thread. */
export async function listRoomLoans(er: Connection, room: PublicKey): Promise<RoomLoan[]> {
  const anchors = await er.getProgramAccounts(PRIVATE_PROGRAM_ID, {
    filters: [
      { memcmp: { offset: 0, bytes: discriminator("LoanAnchor") } },
      { memcmp: { offset: LOAN_ANCHOR_ROOM_OFFSET, bytes: room.toBase58() } },
    ],
    dataSlice: { offset: 8, length: 32 },
  });
  // Terms are readable only by the lender and the borrower; others get null.
  const terms = await er.getMultipleAccountsInfo(anchors.map((a) => loanTermsPda(a.pubkey)));
  return anchors.map((a, i) => ({
    anchor: a.pubkey,
    loanId: utils.bytes.bs58.encode(a.account.data.subarray(0, 32)),
    terms: terms[i] ? decodeLoanTerms(terms[i]!.data) : null,
  }));
}

export type BidState = "draft" | "funded" | "accepted" | "settled";

/**
 * Where a lender's private proposal stands. A lender cannot see whether the
 * borrower accepted someone else's offer (only the borrower reads the room's
 * deal record), so a funded bid stays "funded" and keeps its Cancel.
 */
export function bidState(terms: LoanTerms): BidState {
  const s: LoanStatus = terms.status;
  if (s === "active") return "accepted";
  if (s === "repaid" || s === "expired" || s === "liquidated" || s === "cancelled") return "settled";
  return s === "funded" ? "funded" : "draft";
}

export type Bid = { room: MyRoom; loan: RoomLoan & { terms: LoanTerms }; state: BidState };

/** Every loan this wallet proposed as lender, across all its rooms. */
export async function listMyBids(er: Connection, wallet: PublicKey, rooms: MyRoom[]): Promise<Bid[]> {
  const perRoom = await Promise.all(rooms.map(async (room) => ({ room, loans: await listRoomLoans(er, room.anchor) })));
  const bids: Bid[] = [];
  for (const { room, loans } of perRoom)
    for (const loan of loans)
      if (loan.terms && loan.terms.lender.equals(wallet)) bids.push({ room, loan: loan as Bid["loan"], state: bidState(loan.terms) });
  const order: Record<BidState, number> = { funded: 0, accepted: 1, draft: 2, settled: 3 };
  return bids.sort((a, b) => order[a.state] - order[b.state]);
}

/** Rooms the wallet was added to that it has not opened or dismissed on this device. */
export function newInvitations(rooms: MyRoom[], known: string[], dismissed: string[]): MyRoom[] {
  const seen = new Set([...known, ...dismissed]);
  return rooms.filter((r) => !r.owner && !seen.has(r.roomId));
}

const dismissedKey = (wallet: string) => `lendspan:private:dismissed-invites:${wallet}`;

export function dismissedInvites(wallet: string): string[] {
  try {
    return JSON.parse(localStorage.getItem(dismissedKey(wallet)) ?? "[]");
  } catch {
    return [];
  }
}

export function dismissInvite(wallet: string, roomId: string) {
  try {
    const list = [roomId, ...dismissedInvites(wallet).filter((r) => r !== roomId)].slice(0, 50);
    localStorage.setItem(dismissedKey(wallet), JSON.stringify(list));
  } catch {}
}
