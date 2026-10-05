// Returns funds from saved test wallets (interrupted script runs) to the main wallet.
// Run: npx tsx scripts/private/refund-parties.ts
import { teeConnection } from "../../spikes/lib/custody";
import { USDC, WSOL, cashOut, savedParties } from "./lib/parties";

(async () => {
  for (const kp of savedParties()) {
    console.log("refunding", kp.publicKey.toBase58());
    await cashOut({ kp, er: await teeConnection(kp), name: kp.publicKey.toBase58().slice(0, 6) }, [USDC, WSOL]).catch((e) =>
      console.log("  failed:", String(e).slice(0, 160)),
    );
  }
})();
