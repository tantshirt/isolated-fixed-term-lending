// Public discovery cards and the private join queue (story 11.1).
import { AnchorProvider, BN, Program, type Idl } from "@coral-xyz/anchor";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import idl from "@/idl/private_loan.json";
import type { LoanSigner } from "@/lib/keypair-wallet";
import { MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID, permissionPda } from "./espl";
import { advance, newReceipt, saveReceipt } from "./receipts";
import { PRIVATE_PROGRAM_ID, roomStatePda } from "./room-codec";
import { validateTransaction } from "./tx-validator";

const EPHEMERAL_VAULT_ID = new PublicKey("MagicVau1t999999999999999999999999999999999");
const enc = new TextEncoder();

export const SHOW = { amount: 1, rate: 2, duration: 4, collateral: 8 } as const;
export type CardFields = { show: number; amountMin: bigint; amountMax: bigint; maxInterestBps: number; durationSeconds: number; collateralNote: string };
export type Card = { address: PublicKey; room: PublicKey; publisher: PublicKey; fields: CardFields };

const readOnly = { publicKey: PublicKey.default, signTransaction: async <T,>(t: T) => t, signAllTransactions: async <T,>(t: T[]) => t };
const programFor = (base: Connection, signer?: LoanSigner) =>
  new Program(idl as Idl, new AnchorProvider(base, (signer ?? readOnly) as LoanSigner, { commitment: "confirmed" }));

export const joinQueuePda = (room: PublicKey) => PublicKey.findProgramAddressSync([enc.encode("join-queue"), room.toBytes()], PRIVATE_PROGRAM_ID)[0];
const cardPda = (id: Uint8Array) => PublicKey.findProgramAddressSync([enc.encode("card"), id], PRIVATE_PROGRAM_ID)[0];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toCard(address: PublicKey, a: any): Card {
  return {
    address,
    room: a.room,
    publisher: a.publisher,
    fields: {
      show: a.fields.show,
      amountMin: BigInt(a.fields.amountMin.toString()),
      amountMax: BigInt(a.fields.amountMax.toString()),
      maxInterestBps: a.fields.maxInterestBps,
      durationSeconds: a.fields.durationSeconds.toNumber(),
      collateralNote: new TextDecoder().decode(Uint8Array.from(a.fields.collateralNote)).replace(/\0+$/, ""),
    },
  };
}

/** Every published card. Only fields the publisher chose are non-zero. */
export async function listCards(base: Connection): Promise<Card[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all = await (programFor(base).account as any).discoveryCard.all();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return all.map((c: any) => toCard(c.publicKey, c.account));
}

/** Decodes a card from a subscription. Null for any other layout. */
export function decodeCard(base: Connection, address: PublicKey, data: Buffer): Card | null {
  try {
    return toCard(address, programFor(base).coder.accounts.decode("discoveryCard", data));
  } catch {
    return null;
  }
}

async function sendEr(er: Connection, signer: LoanSigner, tx: Transaction, intent: string) {
  tx.feePayer = signer.publicKey;
  validateTransaction(tx, { feePayer: signer.publicKey });
  tx.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
  const signed = await signer.signTransaction(tx);
  const receipt = newReceipt(intent, "er");
  const sig = await er.sendRawTransaction(signed.serialize(), { skipPreflight: true });
  const res = await er.confirmTransaction(sig, "confirmed");
  saveReceipt(signer.publicKey.toBase58(), advance(receipt, { erSignature: sig, stage: res.value.err ? "failed" : "executed" }));
  if (res.value.err) throw new Error("The private rollup rejected this action.");
  return sig;
}

/** Owner: opens the private join queue if needed, then publishes a public card with chosen fields. */
export async function publishCard(base: Connection, er: Connection, signer: LoanSigner, room: PublicKey, fields: CardFields) {
  const program = programFor(base, signer);
  const queue = joinQueuePda(room);
  if (!(await er.getAccountInfo(queue))) {
    await sendEr(
      er,
      signer,
      new Transaction().add(
        await program.methods
          .openJoinQueue()
          .accountsPartial({
            owner: signer.publicKey,
            anchor: room,
            roomState: roomStatePda(room),
            queue,
            queuePermission: permissionPda(queue),
            vault: EPHEMERAL_VAULT_ID,
            magicProgram: MAGIC_PROGRAM_ID,
            permissionProgram: PERMISSION_PROGRAM_ID,
          })
          .instruction(),
      ),
      "Open a private join queue",
    );
  }
  const id = crypto.getRandomValues(new Uint8Array(32));
  const note = new Uint8Array(48);
  note.set(enc.encode(fields.collateralNote).slice(0, 48));
  const tx = new Transaction().add(
    await program.methods
      .publishCard([...id], {
        show: fields.show,
        amountMin: new BN(fields.amountMin.toString()),
        amountMax: new BN(fields.amountMax.toString()),
        maxInterestBps: fields.maxInterestBps,
        durationSeconds: new BN(fields.durationSeconds),
        collateralNote: [...note],
      })
      .accountsPartial({ publisher: signer.publicKey, room, card: cardPda(id) })
      .instruction(),
  );
  tx.feePayer = signer.publicKey;
  validateTransaction(tx, { feePayer: signer.publicKey });
  const { blockhash, lastValidBlockHeight } = await base.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  const signed = await signer.signTransaction(tx);
  const sig = await base.sendRawTransaction(signed.serialize());
  await base.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  saveReceipt(signer.publicKey.toBase58(), advance(newReceipt("Publish a public request card", "base"), { baseSignature: sig, stage: "settled" }));
  return sig;
}

export async function retractCard(base: Connection, signer: LoanSigner, card: PublicKey) {
  const program = programFor(base, signer);
  return program.methods.retractCard().accountsPartial({ publisher: signer.publicKey, card }).rpc();
}

export async function requestJoin(base: Connection, er: Connection, signer: LoanSigner, room: PublicKey) {
  const program = programFor(base, signer);
  return sendEr(
    er,
    signer,
    new Transaction().add(await program.methods.requestJoin().accountsPartial({ requester: signer.publicKey, anchor: room, queue: joinQueuePda(room) }).instruction()),
    "Ask to join a room",
  );
}

/** Owner only: wallets that asked to join, oldest first. */
export async function readJoinQueue(er: Connection, room: PublicKey): Promise<{ wallet: PublicKey; at: number }[] | null> {
  const info = await er.getAccountInfo(joinQueuePda(room));
  if (!info) return null;
  const d = info.data;
  const count = Math.min(d.readUInt32LE(0), 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    const o = 4 + i * 40;
    out.push({ wallet: new PublicKey(d.subarray(o, o + 32)), at: Number(d.readBigInt64LE(o + 32)) });
  }
  return out;
}
