// SOAR achievements for the learning lab (story 13.1). Opt-in and public: the
// learner signs their own player registration, and the server signs the unlock
// only after recomputing the right answer from the learner's on-chain VRF
// randomness. Achievements confer no loan advantage of any kind.
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { SoarProgram } from "@magicblock-labs/soar-sdk";
import config from "../private/soar-config.json";
import { scenarioFrom, type LabOutcome } from "../lab-scenario";
import { PRIVATE_PROGRAM_ID } from "../private/room-codec";

export class LabRejected extends Error {}

const conn = () => new Connection(process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");

function authority(): Keypair | null {
  const raw = process.env.PRIVATE_SOAR_AUTHORITY_SECRET;
  return raw ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw))) : null;
}

const soarFor = (wallet: Pick<Wallet, "publicKey" | "signTransaction" | "signAllTransactions">) => SoarProgram.get(new AnchorProvider(conn(), wallet, { commitment: "confirmed" }));

export const labScenarioPda = (learner: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("lab"), learner.toBuffer()], PRIVATE_PROGRAM_ID)[0];

/** LabScenario: discriminator 8 | learner 32 | randomness 32 | status u8 | rounds u32 | requested_at i64 | bump. */
export async function readScenario(learner: PublicKey) {
  const info = await conn().getAccountInfo(labScenarioPda(learner));
  if (!info) return null;
  const d = info.data;
  return { randomness: Uint8Array.from(d.subarray(40, 72)), ready: d[72] === 1, rounds: d.readUInt32LE(73) };
}

/** Unsigned registration transaction, or null when already registered (player account + leaderboard entry), paid and signed by the learner. */
export async function registrationTx(user: PublicKey): Promise<string | null> {
  // The SDK pays from the provider's key, so the provider is the learner: the server never signs this.
  const refuse = () => Promise.reject(new Error("The learner signs this transaction."));
  const soar = soarFor({ publicKey: user, signTransaction: refuse, signAllTransactions: refuse });
  const [player] = soar.utils.derivePlayerAddress(user);
  const [entry] = soar.utils.derivePlayerScoresListAddress(user, new PublicKey(config.leaderboard));
  if (await conn().getAccountInfo(entry)) return null; // already opted in
  const exists = await conn().getAccountInfo(player);
  const tx = (await soar.registerPlayerEntryForLeaderBoard(user, new PublicKey(config.leaderboard))).transaction;
  if (!exists) {
    const init = (await soar.initializePlayerAccount(user, `lendspan-${user.toBase58().slice(0, 6)}`, PublicKey.default)).transaction;
    tx.instructions.unshift(...init.instructions);
  }
  tx.feePayer = user;
  tx.recentBlockhash = (await conn().getLatestBlockhash()).blockhash;
  return tx.serialize({ requireAllSignatures: false }).toString("base64");
}

export async function unlock(user: PublicKey, answer: LabOutcome) {
  const kp = authority();
  if (!kp) throw new LabRejected("Achievements are not configured on this deployment.");
  const s = await readScenario(user);
  if (!s?.ready) throw new LabRejected("Request a scenario and wait for its VRF result first.");
  if (scenarioFrom(s.randomness).outcome !== answer) throw new LabRejected("That is not how this scenario ends. Try another one.");
  const soar = soarFor(new Wallet(kp));
  const [playerAch] = soar.utils.derivePlayerAchievementAddress(user, new PublicKey(config.achievement));
  if (await conn().getAccountInfo(playerAch)) return { already: true as const };
  const { transaction } = await soar.unlockPlayerAchievement(user, kp.publicKey, new PublicKey(config.achievement), new PublicKey(config.leaderboard), new PublicKey(config.game));
  const sig = await soar.sendAndConfirmTransaction(transaction);
  return { already: false as const, signature: sig };
}
