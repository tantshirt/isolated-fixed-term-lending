import {
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";

/**
 * Anything that can sign for one public key: a browser wallet (Phantom, Solflare)
 * or a local dev keypair. Anchor's provider signs with it, then sends through the
 * app's own Connection, so a wallet works against localnet whatever network it shows.
 */
export type LoanSigner = {
  publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
  signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]>;
};

/** Minimal Anchor-compatible wallet for signing with a dev keypair. */
export class KeypairWallet implements LoanSigner {
  constructor(readonly keypair: Keypair) {}

  get publicKey() {
    return this.keypair.publicKey;
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(
    tx: T,
  ): Promise<T> {
    if (tx instanceof Transaction) {
      tx.partialSign(this.keypair);
    } else {
      tx.sign([this.keypair]);
    }
    return tx;
  }

  async signAllTransactions<T extends Transaction | VersionedTransaction>(
    txs: T[],
  ): Promise<T[]> {
    return Promise.all(txs.map((tx) => this.signTransaction(tx)));
  }
}

/**
 * Checks shape, not class: the scripts and the app can load separate copies of
 * @solana/web3.js, and `instanceof Keypair` is false across copies.
 */
export function asSigner(signer: Keypair | LoanSigner): LoanSigner {
  return "signTransaction" in signer ? signer : new KeypairWallet(signer);
}
