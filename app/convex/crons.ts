import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.hourly("purge expired sign-in challenges", { minuteUTC: 7 }, internal.auth.purgeExpired);
export default crons;
