import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { runLocalSetup } from "../../app/lib/server/setup-dev";
import {
  sendAcceptOffer,
  sendClaimExpired,
  sendCreateOffer,
} from "../../app/lib/transactions";
import { fetchOffer, getProgram } from "../../app/lib/program";
import { RPC_URL } from "../../app/lib/constants";
import { randomOfferId } from "../../app/lib/offer-id";
import { printBalances } from "./lib/balances";
import { warpToUnixTime } from "./lib/warp";

const WORKED = {
  offerId: randomOfferId(),
  principal: 100_000_000n,
  interestBps: 500,
  durationSeconds: 60,
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

  const program = getProgram(lender);
  const filled = (await fetchOffer(program, offer)).account;
  await warpToUnixTime(connection, filled.expiryTs.toNumber());

  await sendClaimExpired(
    liquidator,
    offer,
    lender.publicKey,
    borrower.publicKey,
    wsolMint,
  );

  const offerAcc = (await fetchOffer(program, offer)).account;
  console.log("status", Object.keys(offerAcc.status)[0]);
  await printBalances(connection, config);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
