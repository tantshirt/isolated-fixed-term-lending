import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.hourly("purge expired sign-in challenges", { minuteUTC: 7 }, internal.auth.purgeExpired);
crons.interval("dispatch due jobs", { seconds: 30 }, internal.jobs.dispatch);
crons.daily("purge finished jobs", { hourUTC: 3, minuteUTC: 17 }, internal.jobs.purgeFinished);
// Shadow only: the Vercel Cron cranker stays the single active scheduler until parity is proven.
crons.interval("shadow cranker scan", { minutes: 1 }, internal.opsNode.shadowCrankScan);
crons.interval("sample oracle freshness", { minutes: 5 }, internal.opsNode.sampleOracle);
crons.daily("purge old observations", { hourUTC: 3, minuteUTC: 41 }, internal.ops.purgeObservations);
// Reference liquidator; a no-op unless KEEPER_ENABLED=1 on this deployment.
crons.interval("reference liquidator", { minutes: 1 }, internal.keeper.run);
// Consented loan alerts; sends nothing until a chat is linked and the bot token is set.
crons.interval("loan alerts", { minutes: 1 }, internal.alertsNode.scan);
export default crons;
