/** Story 26.7: the invited wSOL credit pilot. Off until the deployment sets it ("1" or "true"). */
export const creditPilotEnabled = (v: string | undefined = process.env.NEXT_PUBLIC_CREDIT_PILOT_ENABLED) => v === "1" || v === "true";
export const CREDIT_PILOT_ENABLED = creditPilotEnabled();
