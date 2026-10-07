// Private lender desks from the browser (Story 23.2), against private_loan_v2. Same signing path
// as rooms: every transaction is checked against what the user reviewed, then signed by the
// wallet and recorded as a receipt. Desk contents stay in the TEE; this file keeps only desk ids
// in local storage so a returning wallet can find its desks.
import { utils } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import type { LoanSigner } from "@/lib/keypair-wallet";
import { permissionPda } from "./espl";
import { ER_ONLY, programV2, sendBase, sendEr, waitInEr } from "./v2-send";
import { DESK_ROLE, decodeDeskPolicy, decodeDeskState, decodeLoanTermsV2, v2Pda, type DeskPolicyV2, type DeskStateV2 } from "./v2-codec";
import type { BookEntry } from "./desk-view";
import { assertMembershipTransactionFits, deskMembershipAccounts } from "./desk-membership";


const programFor = programV2;

export type DeskRef = { creator: PublicKey; deskId: string; anchor: PublicKey };

export function deskRef(creator: string, deskId: string): DeskRef {
  const bytes = utils.bytes.bs58.decode(deskId);
  if (bytes.length !== 32) throw new Error("That desk link is not valid.");
  const c = new PublicKey(creator);
  return { creator: c, deskId, anchor: v2Pda.desk(c, bytes) };
}

export const deskPath = (d: { creator: PublicKey | string; deskId: string }) => `/devnet/private/desk/${d.creator.toString()}/${d.deskId}`;

// --- local desk list (ids only) ---------------------------------------------------

const desksKey = (wallet: string) => `zenlo:private:desks:${wallet}`;

export function savedDesks(wallet: string): { creator: string; deskId: string }[] {
  try {
    return JSON.parse(localStorage.getItem(desksKey(wallet)) ?? "[]");
  } catch {
    return [];
  }
}

export function rememberDesk(wallet: string, d: { creator: string; deskId: string }) {
  try {
    const list = [d, ...savedDesks(wallet).filter((x) => x.deskId !== d.deskId)].slice(0, 20);
    localStorage.setItem(desksKey(wallet), JSON.stringify(list));
  } catch {}
}

const stateAccounts = (anchor: PublicKey) => {
  const state = v2Pda.deskState(anchor);
  return { anchor, state, statePermission: permissionPda(state), ...ER_ONLY };
};

// --- actions -----------------------------------------------------------------------

/** Base layer: create, fund and delegate the desk anchor. Then the ER creates the member list. */
export async function openDesk(base: Connection, er: Connection, signer: LoanSigner, alsoLend: boolean): Promise<DeskRef> {
  const program = programFor(base, signer);
  const idBytes = crypto.getRandomValues(new Uint8Array(32));
  const deskId = utils.bytes.bs58.encode(idBytes);
  const anchor = v2Pda.desk(signer.publicKey, idBytes);
  const wallet = signer.publicKey.toBase58();

  await sendBase(
    base,
    signer,
    [
      await program.methods.openDesk([...idBytes]).accountsPartial({ creator: signer.publicKey, anchor }).instruction(),
      await program.methods.delegateDesk([...idBytes]).accountsPartial({ creator: signer.publicKey, anchor }).instruction(),
    ],
    "Open a private desk",
  );
  const ref = { creator: signer.publicKey, deskId, anchor };
  rememberDesk(wallet, { creator: wallet, deskId });

  await waitInEr(er, anchor);
  await finishDesk(base, er, signer, anchor, alsoLend);
  return ref;
}

/** ER step of opening a desk. Safe to retry when it failed after the Solana step. */
export async function finishDesk(base: Connection, er: Connection, signer: LoanSigner, anchor: PublicKey, alsoLend: boolean) {
  const roles = DESK_ROLE.admin | (alsoLend ? DESK_ROLE.lender : 0);
  const ix = await programFor(base, signer).methods.initDesk(roles).accountsPartial({ admin: signer.publicKey, ...stateAccounts(anchor) }).instruction();
  return sendEr(er, signer, ix, "Create the desk's private member list");
}

/** Adds, re-roles (roles > 0) or removes (roles = 0) a member. Administrators only. */
export async function setDeskMember(base: Connection, er: Connection, signer: LoanSigner, anchor: PublicKey, member: PublicKey, roles: number) {
  const info = await er.getAccountInfo(v2Pda.deskState(anchor));
  if (!info) throw new Error("The desk's private membership could not be read. Sign in and try again.");
  const state = decodeDeskState(info.data);
  const ix = await programFor(base, signer).methods.setDeskMember(member, roles)
    .accountsPartial({ admin: signer.publicKey, ...stateAccounts(anchor) })
    .remainingAccounts(deskMembershipAccounts(anchor, state)).instruction();
  assertMembershipTransactionFits(ix, signer.publicKey);
  const who = `${member.toBase58().slice(0, 4)}…`;
  return sendEr(er, signer, ix, roles === 0 ? `Remove ${who} from the desk` : `Set ${who}'s desk roles`);
}

export type PolicyInput = Omit<DeskPolicyV2, "version" | "publishedAt">;

/** Publishes the next policy version. Earlier versions are never changed. */
export async function publishPolicy(base: Connection, er: Connection, signer: LoanSigner, anchor: PublicKey, nextVersion: number, p: PolicyInput) {
  const { BN } = await import("@coral-xyz/anchor");
  const policy = v2Pda.deskPolicy(anchor, nextVersion);
  const auditors = [...p.auditors, ...Array(4 - p.auditors.length).fill(PublicKey.default)];
  const args = {
    minPrincipal: new BN(p.minPrincipal.toString()),
    maxPrincipal: new BN(p.maxPrincipal.toString()),
    minDurationSeconds: new BN(p.minDurationSeconds),
    maxDurationSeconds: new BN(p.maxDurationSeconds),
    maxAnnualCeilingBps: p.maxAnnualCeilingBps,
    maxInterestBps: p.maxInterestBps,
    repaymentModes: p.repaymentModes,
    maxLtvBps: p.maxLtvBps,
    maxLiquidationLtvBps: p.maxLiquidationLtvBps,
    minGraceSeconds: new BN(p.minGraceSeconds),
    maxLateFeeBps: p.maxLateFeeBps,
    auditorCount: p.auditors.length,
    auditors,
  };
  const ix = await programFor(base, signer)
    .methods.publishPolicy(args)
    .accountsPartial({ admin: signer.publicKey, anchor, state: v2Pda.deskState(anchor), policy, policyPermission: permissionPda(policy), ...ER_ONLY })
    .instruction();
  return sendEr(er, signer, ix, `Publish desk policy version ${nextVersion}`);
}

// --- reading -----------------------------------------------------------------------

export type DeskRead =
  | { access: "none" }
  | { access: "member"; state: DeskStateV2; policy: DeskPolicyV2 | null; history: DeskPolicyV2[]; book: BookEntry[] };

/**
 * Reads through the TEE with the viewer's token. A non-member gets nothing. Members see the
 * loan book; each loan's terms only come back to its parties and consented auditors.
 */
export async function readDesk(er: Connection, anchor: PublicKey): Promise<DeskRead> {
  const s = await er.getAccountInfo(v2Pda.deskState(anchor));
  if (!s) return { access: "none" };
  const state = decodeDeskState(s.data);
  const policyKeys = Array.from({ length: state.policyVersion }, (_, i) => v2Pda.deskPolicy(anchor, i + 1));
  const bookKeys = Array.from({ length: state.nextLoanSeq }, (_, i) => v2Pda.deskLoan(anchor, i));
  const [policies, entries] = await Promise.all([
    policyKeys.length ? er.getMultipleAccountsInfo(policyKeys) : Promise.resolve([]),
    bookKeys.length ? er.getMultipleAccountsInfo(bookKeys) : Promise.resolve([]),
  ]);
  const history = policies.flatMap((p) => (p ? [decodeDeskPolicy(p.data)] : []));
  const loans = entries.map((e, seq) => (e ? { seq, loan: new PublicKey(e.data.subarray(0, 32)) } : null)).filter((x): x is { seq: number; loan: PublicKey } => !!x);
  const terms = loans.length ? await er.getMultipleAccountsInfo(loans.map((l) => v2Pda.terms(l.loan))) : [];
  const book = loans.map((l, i) => {
    const t = terms[i];
    let decoded = null;
    try {
      decoded = t ? decodeLoanTermsV2(t.data) : null;
    } catch {}
    return { ...l, terms: decoded };
  });
  return { access: "member", state, policy: history.find((p) => p.version === state.policyVersion) ?? null, history, book };
}
