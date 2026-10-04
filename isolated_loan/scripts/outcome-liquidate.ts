import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { runLocalSetup } from "../../app/lib/server/setup-dev";
import {
  sendAcceptOffer,
  sendCreateOffer,
  sendLiquidateLoan,
} from "../../app/lib/transactions";
import { fetchOffer, getProgram } from "../../app/lib/program";
import { RPC_URL } from "../../app/lib/constants";
import { randomOfferId } from "../../app/lib/offer-id";
import {
  chainUnixTime,
  encodePriceUpdateV2Account,
  trySurfnetSetAccount,
} from "../../app/lib/server/pyth-mock";
import { readDevSecrets } from "../../app/lib/server/dev-secrets";
import { printBalances } from "./lib/balances";

const WORKED = {
  offerId: randomOfferId(),
  principal: 100_000_000n,
  interestBps: 500,
  durationSeconds: 3600,
  collateralAmount: 1_001_001_002n,
  maxLtvBps: 7000,
  liquidationLtvBps: 8000,
};

async function main() {
  const setup = await runLocalSetup();
  const lender = Keypair.fromSecretKey(Uint8Array.from(setup.keypairs.lender));
  const borrower = Keypair.fromSecretKey(
    Uint8Array.from(setup.keypairs.borrower),
  );
  const liquidator = Keypair.fromSecretKey(
    Uint8Array.from(setup.keypairs.liquidator),
  );
  const { config } = setup;
  const usdcMint = new PublicKey(config.usdcMint);
  const wsolMint = new PublicKey(config.wsolMint);
  const priceUpdate = new PublicKey(config.priceUpdateAccount);
  const connection = new Connection(RPC_URL, "confirmed");

  const { offer } = await sendCreateOffer(lender, {
    ...WORKED,
    usdcMint,
    wsolMint,
  });

  await sendAcceptOffer(
    borrower,
    offer,
    lender.publicKey,
    usdcMint,
    wsolMint,
    priceUpdate,
  );

  const secrets = await readDevSecrets();
  if (!secrets) {
    throw new Error("Missing dev-secrets.json from setup");
  }
  const writeAuthority = Keypair.fromSecretKey(
    Uint8Array.from(secrets.priceWriteAuthoritySecret),
  );
  // $120.00: debt 105 against ~120 USDC of collateral is 87.5%, past the 80% line.
  const crossed = {
    price: 12_000_000_000n,
    conf: 12_000_000n,
    exponent: -8,
    publishTime: await chainUnixTime(connection),
  };
  const data = await encodePriceUpdateV2Account(
    writeAuthority.publicKey,
    crossed,
  );
  const ok = await trySurfnetSetAccount(connection, priceUpdate, data);
  if (!ok) {
    throw new Error("Need surfnet_setAccount to post a crossed price");
  }

  await sendLiquidateLoan(
    liquidator,
    offer,
    lender.publicKey,
    borrower.publicKey,
    usdcMint,
    wsolMint,
    priceUpdate,
  );

  const program = getProgram(lender);
  const offerAcc = (await fetchOffer(program, offer)).account;
  console.log("status", Object.keys(offerAcc.status)[0]);
  await printBalances(connection, config);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
