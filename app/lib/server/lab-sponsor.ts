// Bounded gas sponsorship for the lab (story 13.1). The server builds the whole
// transaction, so the learner cannot change what is paid for: a fee plus exactly
// the rent of the learner's first LabScenario account and the VRF fee, both spent
// by the same transaction. The first-draw instruction enforces once per wallet.
// Balance checks are admission snapshots; a dedicated key's finite funding
// bounds exposure across concurrent learners independently of SOAR authority.
import { AnchorProvider, Program, type Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import idl from "../../idl/private_loan.json";
import { LabRejected, labScenarioPda } from "./soar";
import { assertDevnet } from "../private/tx-validator";

const SCENARIO_SPACE = 8 + 32 + 32 + 1 + 4 + 8 + 1;
const FEE_HEADROOM = 20_000;
const VRF_FEE = 500_000; // charged to the learner by the VRF program and paid to the oracle queue
const SPONSOR_RESERVE = 20_000_000;

const conn = () => new Connection(process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");

export async function sponsoredDraw(learner: PublicKey): Promise<string> {
  // Never fall back to the SOAR authority: sponsorship has its own funded budget.
  const raw = process.env.PRIVATE_LAB_SPONSOR_SECRET;
  if (!raw) throw new LabRejected("Sponsorship is not configured on this deployment.");
  const sponsor = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  const c = conn();
  await assertDevnet(c);
  if (await c.getAccountInfo(labScenarioPda(learner))) throw new LabRejected("Sponsorship covers a wallet's first scenario only.");
  const rent = await c.getMinimumBalanceForRentExemption(SCENARIO_SPACE);
  if ((await c.getBalance(learner)) >= rent + VRF_FEE + FEE_HEADROOM) throw new LabRejected("This wallet can pay for its own scenario.");
  if ((await c.getBalance(sponsor.publicKey)) < SPONSOR_RESERVE + rent + VRF_FEE + FEE_HEADROOM) throw new LabRejected("The sponsor is out of Devnet SOL for today.");

  const readOnly = { publicKey: sponsor.publicKey, signTransaction: () => Promise.reject(), signAllTransactions: () => Promise.reject() };
  const program = new Program(idl as Idl, new AnchorProvider(c, readOnly, {}));
  const seed = Math.floor(Math.random() * 256);
  // Only `init` may receive sponsored rent; old binaries reject this new call.
  const request = await program.methods.requestFirstScenario(seed).accountsPartial({ learner }).instruction();
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: sponsor.publicKey, toPubkey: learner, lamports: rent + VRF_FEE }), request);
  tx.feePayer = sponsor.publicKey;
  tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
  tx.partialSign(sponsor);
  return tx.serialize({ requireAllSignatures: false }).toString("base64");
}
