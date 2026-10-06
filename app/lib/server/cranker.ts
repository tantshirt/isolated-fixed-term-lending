// ZenLo's Hydra cranker (story 12.1). No hosted cranker fired on the Devnet
// TEE (gate 8.6), so a Vercel Cron job triggers due `watch_loan` schedules.
// Triggering is permissionless and every scheduled instruction is idempotent,
// so retries and overlapping runs are harmless. The cranker holds no user keys
// and is not a member of any loan record.
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, Transaction, TransactionInstruction } from "@solana/web3.js";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";
import idl from "../../idl/private_loan.json";
import { PRIVATE_PROGRAM_ID } from "../private/room-codec";
import { attestTee, TEE_RPC } from "../private/tee";

export const HYDRA_EPHEMERAL = new PublicKey("eHyd5BU8QffvHi4GnXwxrK4WpS7pM2x9UGKHBWii7mf");
const HEADER = 120;
const WATCH = Buffer.from((idl.instructions.find((i) => i.name === "watch_loan")!.discriminator as number[]));

export type DueCrank = { crank: PublicKey; ix: TransactionInstruction; cuLimit: number; nextSlot: bigint; remaining: bigint };

/** Parses a crank account; returns null unless it schedules ZenLo's `watch_loan`. */
export function parseCrank(crank: PublicKey, data: Buffer): DueCrank | null {
  if (data.length < HEADER + 2) return null;
  const nextSlot = data.readBigUInt64LE(64);
  const remaining = data.readBigUInt64LE(80);
  const cuLimit = data.readUInt32LE(115);
  let o = HEADER;
  const n = data.readUInt16LE(o);
  o += 2;
  const keys = [];
  for (let i = 0; i < n; i++) {
    const flag = data[o];
    keys.push({ pubkey: new PublicKey(data.subarray(o + 1, o + 33)), isSigner: false, isWritable: (flag & 2) !== 0 });
    o += 33;
  }
  const programId = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  const len = data.readUInt16LE(o);
  o += 2;
  const ixData = data.subarray(o, o + len);
  if (!programId.equals(PRIVATE_PROGRAM_ID) || !ixData.subarray(0, 8).equals(WATCH)) return null;
  return { crank, ix: new TransactionInstruction({ programId, keys, data: Buffer.from(ixData) }), cuLimit, nextSlot, remaining };
}

export function crankerKey(): Keypair | null {
  const raw = process.env.PRIVATE_CRANKER_SECRET;
  return raw ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw))) : null;
}

export async function teeAs(kp: Keypair): Promise<Connection> {
  await attestTee();
  const { token } = await getAuthToken(TEE_RPC, kp.publicKey, async (m) => nacl.sign.detached(m, kp.secretKey));
  return new Connection(`${TEE_RPC}?token=${token}`, "confirmed");
}

/** Triggers every due ZenLo watch. Returns what happened per crank. */
export async function runCranker(er: Connection, kp: Keypair, max = 15) {
  const slot = BigInt(await er.getSlot());
  const accounts = await er.getProgramAccounts(HYDRA_EPHEMERAL);
  const due = accounts
    .map((a) => parseCrank(a.pubkey, a.account.data as Buffer))
    .filter((c): c is DueCrank => !!c && c.remaining > 0n && c.nextSlot <= slot)
    .slice(0, max);
  const results: { crank: string; signature?: string; error?: string }[] = [];
  for (const c of due) {
    try {
      const tx = new Transaction();
      if (c.cuLimit > 0) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: c.cuLimit }));
      tx.add(
        new TransactionInstruction({
          programId: HYDRA_EPHEMERAL,
          keys: [
            { pubkey: c.crank, isSigner: false, isWritable: true },
            { pubkey: kp.publicKey, isSigner: true, isWritable: true },
            { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
          ],
          data: Buffer.from([1]),
        }),
        c.ix,
      );
      tx.feePayer = kp.publicKey;
      tx.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
      tx.sign(kp);
      const signature = await er.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      const res = await er.confirmTransaction(signature, "confirmed");
      results.push({ crank: c.crank.toBase58(), signature, error: res.value.err ? JSON.stringify(res.value.err) : undefined });
    } catch (e) {
      results.push({ crank: c.crank.toBase58(), error: String(e).slice(0, 200) });
    }
  }
  return { slot: slot.toString(), scanned: accounts.length, due: due.length, results };
}
