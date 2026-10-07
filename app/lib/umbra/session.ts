/**
 * Umbra wSOL session (Story 26.6). This module is the only one that imports `@umbra-privacy/sdk`,
 * and the shielding panel loads it with a dynamic import, so the SDK never enters the main bundle.
 *
 * Keys: Umbra derives every key from one wallet signature over its consent message and keeps the
 * master seed in the client's memory (the SDK's default in-memory seed storage). Nothing here
 * writes to localStorage, IndexedDB, Convex, telemetry, exports or notifications. Closing the tab
 * forgets the keys; recovery is the same wallet signing the same message again.
 */
import {
  createSignerFromWalletAccount,
  getEncryptedBalanceQuerierFunction,
  getEncryptedBalanceToPublicBalanceDirectWithdrawerFunction,
  getPublicBalanceToEncryptedBalanceDirectDepositorFunction,
  getUmbraClient,
  getUserAccountQuerierFunction,
  getUserRegistrationFunction,
} from "@umbra-privacy/sdk";
import { WSOL } from "@/lib/capabilities";
import type { CallbackStatus, EncryptedBalanceState } from "./shield";

type Deposit = ReturnType<typeof getPublicBalanceToEncryptedBalanceDirectDepositorFunction>;
type Address = Parameters<Deposit>[0];
type U64 = Parameters<Deposit>[2];
type StandardWallet = Parameters<typeof createSignerFromWalletAccount>[0];
type StandardAccount = Parameters<typeof createSignerFromWalletAccount>[1];

export type UmbraSessionConfig = {
  /** Wallet Standard wallet behind the connected adapter. */
  wallet: unknown;
  owner: string;
  rpcUrl: string;
  rpcSubscriptionsUrl: string;
  indexerApiEndpoint: string;
};

export type UmbraSession = {
  owner: string;
  balance: () => Promise<EncryptedBalanceState>;
  shield: (lamports: bigint) => Promise<{ signature: string; status: CallbackStatus }>;
  unshield: (lamports: bigint) => Promise<{ signature: string; status: CallbackStatus }>;
};

function standardAccount(wallet: unknown, owner: string): { wallet: StandardWallet; account: StandardAccount } {
  const w = wallet as { accounts?: readonly { address: string }[]; features?: Record<string, unknown> } | null;
  if (!w || !Array.isArray(w.accounts) || !w.features) throw new Error("This wallet does not support Wallet Standard.");
  if (!w.features["solana:signMessage"]) throw new Error("This wallet cannot sign messages (solana:signMessage feature missing).");
  const account = w.accounts.find((a) => a.address === owner);
  if (!account) throw new Error("The connected account is not available in the wallet.");
  return { wallet: w as unknown as StandardWallet, account: account as unknown as StandardAccount };
}

/**
 * Builds a client and derives keys (one signature prompt). Calling it again after a page reload or
 * cleared storage is the recovery path: the same wallet yields the same keys, and balances are
 * re-read from chain.
 */
export async function openUmbraSession(config: UmbraSessionConfig): Promise<UmbraSession> {
  const { wallet, account } = standardAccount(config.wallet, config.owner);
  const signer = createSignerFromWalletAccount(wallet, account);
  const client = await getUmbraClient({
    signer,
    network: "devnet",
    rpcUrl: config.rpcUrl,
    rpcSubscriptionsUrl: config.rpcSubscriptionsUrl,
    indexerApiEndpoint: config.indexerApiEndpoint,
    deferMasterSeedSignature: false,
  });
  const owner = config.owner as Address;
  const mint = WSOL as Address;

  const ensureRegistered = async () => {
    const account = await getUserAccountQuerierFunction({ client })(owner);
    if (account.state === "exists" && account.data.isUserAccountX25519KeyRegistered) return;
    // Confidential mode only: balances decryptable on this device. Anonymous mode (mixer) is not used.
    await getUserRegistrationFunction({ client })({ confidential: true, anonymous: false });
  };

  return {
    owner: config.owner,
    async balance() {
      const map = await getEncryptedBalanceQuerierFunction({ client })([mint]);
      const r = map.get(mint);
      if (!r) return { state: "non_existent" };
      return r.state === "shared" ? { state: "shared", balance: BigInt(r.balance) } : { state: r.state };
    },
    async shield(lamports) {
      await ensureRegistered();
      const r = await getPublicBalanceToEncryptedBalanceDirectDepositorFunction({ client })(owner, mint, lamports as U64);
      return { signature: String(r.queueSignature), status: r.callbackStatus };
    },
    async unshield(lamports) {
      const r = await getEncryptedBalanceToPublicBalanceDirectWithdrawerFunction({ client })(owner, mint, lamports as U64);
      return { signature: String(r.queueSignature), status: r.callbackStatus };
    },
  };
}
