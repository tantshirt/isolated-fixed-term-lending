// Story 9.2 on the Devnet TEE: rooms, invitations, scoped sessions, revocation.
// Owner = ~/.config/solana/id.json. Invitee and outsider are fresh keypairs.
// Run: npx tsx scripts/private/rooms.ts
import { BN } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  EPHEMERAL_VAULT_ID,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  permissionPdaFromAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { randomBytes } from "node:crypto";
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
} from "../../../app/lib/private/room-codec";
import { recordGate } from "../../spikes/lib/evidence";
import { authority as owner, base, program, sleep, teeConnection, waitFor } from "../../spikes/lib/custody";

const TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");

async function sendAs(er: Connection, ix: TransactionInstruction, signers: Keypair[]): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const tx = new Transaction().add(ix);
    tx.feePayer = signers[0].publicKey;
    tx.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
    tx.sign(...signers);
    const sig = await er.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    const res = await er.confirmTransaction(sig, "confirmed");
    if (!res.value.err) return sig;
    const err = JSON.stringify(res.value.err);
    // The ER can run a cached build for a few minutes after a redeploy.
    if (err.includes('"Custom":101') && attempt < 12) {
      await sleep(10_000);
      continue;
    }
    const t = await er.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
    const named = t?.meta?.logMessages?.find((l) => l.includes("Error Code:")) ?? "";
    throw new Error(`${sig} failed: ${err} ${named}`);
  }
}

async function expectFail(label: string, f: () => Promise<unknown>, code: string) {
  try {
    await f();
    return { ok: false, detail: `${label} unexpectedly succeeded` };
  } catch (e) {
    const msg = String(e);
    return { ok: msg.includes(code), detail: msg.slice(0, 220) };
  }
}

async function main() {
  const checks: Record<string, unknown> = {};
  const fail: string[] = [];
  const expect = (name: string, ok: boolean, detail: unknown) => {
    checks[name] = { ok, detail };
    console.log(`${ok ? "PASS" : "FAIL"} ${name}`, detail);
    if (!ok) fail.push(name);
  };

  const invitee = Keypair.generate();
  const outsider = Keypair.generate();
  // Invitee needs a little SOL on base only to exist; ER fees are not charged to it.
  await sendAndConfirmTransaction(
    base,
    new Transaction().add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: invitee.publicKey, lamports: 5_000_000 })),
    [owner],
  );
  const [erOwner, erInvitee, erOutsider] = await Promise.all([owner, invitee, outsider].map(teeConnection));

  // 1. Open: anchor + funding + delegation in one base transaction.
  const roomId = randomBytes(32);
  const anchor = roomAnchorPda(roomId);
  const state = roomStatePda(anchor);
  const thread = roomThreadPda(anchor);
  const open = await sendAndConfirmTransaction(
    base,
    new Transaction().add(
      await program.methods.openRoom([...roomId]).accountsPartial({ creator: owner.publicKey, anchor }).instruction(),
      await program.methods.delegateRoom([...roomId]).accountsPartial({ creator: owner.publicKey, anchor }).instruction(),
    ),
    [owner],
  );
  await waitFor("anchor in ER", () => erOwner.getAccountInfo(anchor), () => true);

  const recordAccounts = {
    anchor,
    state,
    statePermission: permissionPdaFromAccount(state),
    thread,
    threadPermission: permissionPdaFromAccount(thread),
    vault: EPHEMERAL_VAULT_ID,
    magicProgram: MAGIC_PROGRAM_ID,
    permissionProgram: PERMISSION_PROGRAM_ID,
  };
  const init = await sendAs(
    erOwner,
    await program.methods.initRoom().accountsPartial({ owner: owner.publicKey, ...recordAccounts }).instruction(),
    [owner],
  );
  const ownerState = decodeRoomState((await erOwner.getAccountInfo(state))!.data);
  expect("owner-reads-room", ownerState.owner.equals(owner.publicKey) && ownerState.members.length === 1, {
    members: ownerState.members.length,
  });
  expect("invitee-cannot-read-before-invite", (await erInvitee.getAccountInfo(thread)) === null, "thread hidden");

  // A session key cannot stand in for the owner on privileged actions.
  const imposter = await expectFail(
    "imposter invite",
    async () =>
      sendAs(
        erInvitee,
        await program.methods
          .inviteMember(invitee.publicKey, ROLE.lender)
          .accountsPartial({ owner: invitee.publicKey, ...recordAccounts })
          .instruction(),
        [invitee],
      ),
    "NotRoomOwner",
  );
  expect("non-owner-cannot-invite", imposter.ok, imposter.detail);

  // 2. Invite: permissions widen to the invitee.
  const invite = await sendAs(
    erOwner,
    await program.methods
      .inviteMember(invitee.publicKey, ROLE.lender)
      .accountsPartial({ owner: owner.publicKey, ...recordAccounts })
      .instruction(),
    [owner],
  );
  await sleep(1500);
  const seen = await erInvitee.getAccountInfo(state);
  expect("invitee-reads-after-invite", !!seen && decodeRoomState(seen.data).members.some((m) => m.pubkey.equals(invitee.publicKey)), {
    visible: !!seen,
  });
  expect("outsider-cannot-read", (await erOutsider.getAccountInfo(state)) === null && (await erOutsider.getAccountInfo(thread)) === null, "hidden");

  // 3. Messages: wallet, then a scoped session key.
  const postIx = (signer: PublicKey, text: string, session?: PublicKey) =>
    program.methods
      .postMessage(Buffer.from(encodeMessage(text)))
      .accountsPartial({ signer, anchor, state, thread, session: session ?? null })
      .instruction();
  await sendAs(erInvitee, await postIx(invitee.publicKey, "Hello from the lender"), [invitee]);

  const sessionKey = Keypair.generate();
  const session = sessionPda(anchor, sessionKey.publicKey);
  const now = Math.floor(Date.now() / 1000);
  const createSession = (key: PublicKey, expiresAt: number, scope: number) =>
    program.methods
      .createSession(key, new BN(expiresAt), scope)
      .accountsPartial({
        authority: invitee.publicKey,
        anchor,
        state,
        session: sessionPda(anchor, key),
        sessionPermission: permissionPdaFromAccount(sessionPda(anchor, key)),
        vault: EPHEMERAL_VAULT_ID,
        magicProgram: MAGIC_PROGRAM_ID,
        permissionProgram: PERMISSION_PROGRAM_ID,
      })
      .instruction();
  await sendAs(erInvitee, await createSession(sessionKey.publicKey, now + 3600, SCOPE.postMessage), [invitee]);
  let sessionPost: { ok: boolean; detail: unknown };
  try {
    sessionPost = { ok: true, detail: await sendAs(erInvitee, await postIx(sessionKey.publicKey, "Sent by a session key", session), [sessionKey]) };
  } catch (e) {
    sessionPost = { ok: false, detail: String(e).slice(0, 300) };
  }
  expect("session-key-posts-without-wallet", sessionPost.ok, sessionPost.detail);

  const sessionInvite = await expectFail(
    "session invite",
    async () =>
      sendAs(
        erInvitee,
        await program.methods
          .inviteMember(outsider.publicKey, ROLE.viewer)
          .accountsPartial({ owner: sessionKey.publicKey, ...recordAccounts })
          .instruction(),
        [sessionKey],
      ),
    "NotRoomOwner",
  );
  expect("session-cannot-grant-access", sessionInvite.ok, sessionInvite.detail);

  // Expired session.
  const shortKey = Keypair.generate();
  await sendAs(erInvitee, await createSession(shortKey.publicKey, Math.floor(Date.now() / 1000) + 3, SCOPE.postMessage), [invitee]);
  await sleep(6000);
  const expired = await expectFail(
    "expired session",
    async () => sendAs(erInvitee, await postIx(shortKey.publicKey, "too late", sessionPda(anchor, shortKey.publicKey)), [shortKey]),
    "SessionExpired",
  );
  expect("expired-session-rejected", expired.ok, expired.detail);

  // Revoked session.
  await sendAs(
    erInvitee,
    await program.methods.revokeSession().accountsPartial({ authority: invitee.publicKey, session }).instruction(),
    [invitee],
  );
  const revoked = await expectFail(
    "revoked session",
    async () => sendAs(erInvitee, await postIx(sessionKey.publicKey, "after revoke", session), [sessionKey]),
    "SessionRevoked",
  );
  expect("revoked-session-rejected", revoked.ok, revoked.detail);

  const msgs = decodeRoomThread((await erOwner.getAccountInfo(thread))!.data);
  expect("thread-has-member-and-session-messages", msgs.length === 2 && msgs.every((m) => m.author.equals(invitee.publicKey)), {
    messages: msgs.map((m) => m.body),
  });

  // 4. Revoke the member: reads and writes stop.
  const revoke = await sendAs(
    erOwner,
    await program.methods.revokeMember(invitee.publicKey).accountsPartial({ owner: owner.publicKey, ...recordAccounts }).instruction(),
    [owner],
  );
  await sleep(1500);
  expect("revoked-member-cannot-read", (await erInvitee.getAccountInfo(thread)) === null, "thread hidden after revoke");
  const revokedPost = await expectFail(
    "revoked member post",
    async () => sendAs(erInvitee, await postIx(invitee.publicKey, "still here?"), [invitee]),
    "NotMember",
  );
  expect("revoked-member-cannot-post", revokedPost.ok, revokedPost.detail);

  // 5. Nothing sensitive on Solana.
  const onBase = await Promise.all([state, thread, session].map((k) => base.getAccountInfo(k)));
  expect("room-records-absent-on-base", onBase.every((i) => i === null), "state, thread, session");
  const anchorInfo = await base.getAccountInfo(anchor);
  expect("anchor-delegated-not-plaintext-members", !!anchorInfo && !anchorInfo.data.includes(Buffer.from(invitee.publicKey.toBytes())), {
    owner: anchorInfo?.owner.toBase58(),
  });

  const status = fail.length === 0 ? "PASS" : "FAIL";
  recordGate("9.2", {
    status,
    date: new Date().toISOString().slice(0, 10),
    anchor: anchor.toBase58(),
    signatures: { open, init, invite, revoke },
    failed: fail,
    checks,
  });
  console.log(`\nStory 9.2: ${status}`);
  process.exit(fail.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
