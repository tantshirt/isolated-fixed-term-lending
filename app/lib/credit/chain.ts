/**
 * Chain reads for the credit pilot (Story 26.7). Decodes by hand so the screen works before and
 * after the IDL carries `CreditConfig`.
 *
 * Remaining accounts on isolated_loan_v2 for a wSOL credit origination (accept_offer,
 * fund_request, create_request): `[config, credit_config, sas_attestation]`. create_offer with
 * credit caps takes `[config, credit_config]`.
 */
import { PublicKey, type AccountMeta, type Connection } from "@solana/web3.js";
import { PROGRAM_V2_ID, v2Coder } from "../v2/program";
import { attestationPda, readCreditStatus, CREDIT_CREDENTIAL, CREDIT_ISSUER, CREDIT_SCHEMA, type CreditStatus } from "./sas";

export const CONFIG_V2_SEED = Buffer.from("config");
export const CREDIT_CONFIG_SEED = Buffer.from("credit");
export const configV2Pda = () => PublicKey.findProgramAddressSync([CONFIG_V2_SEED], PROGRAM_V2_ID)[0];
export const creditConfigPda = () => PublicKey.findProgramAddressSync([CREDIT_CONFIG_SEED], PROGRAM_V2_ID)[0];

/** `Config.authorities.credential_issuer`, or the public env value when the config is unreadable. */
export async function fetchCreditIssuer(connection: Connection): Promise<string> {
  try {
    const info = await connection.getAccountInfo(configV2Pda(), "confirmed");
    if (info) {
      const c = v2Coder.decode("config", info.data) as { authorities: { credentialIssuer: PublicKey } };
      return c.authorities.credentialIssuer.toBase58();
    }
  } catch {
    // Fall through to the configured public key.
  }
  return CREDIT_ISSUER;
}

export async function fetchMyCredit(connection: Connection, wallet: PublicKey, now: number): Promise<CreditStatus> {
  const issuer = await fetchCreditIssuer(connection);
  return readCreditStatus(connection, wallet, { credential: CREDIT_CREDENTIAL, schema: CREDIT_SCHEMA, issuer }, now);
}

/** The trailing accounts a credit origination passes, in program order. */
export function creditRemainingAccounts(borrower: PublicKey): AccountMeta[] {
  const att = attestationPda(new PublicKey(CREDIT_CREDENTIAL), new PublicKey(CREDIT_SCHEMA), borrower);
  return [configV2Pda(), creditConfigPda(), att].map((pubkey) => ({ pubkey, isSigner: false, isWritable: false }));
}
