import { initBotId } from "botid/client/core";

// Routes that spend server funds: the lab sponsor pays rent and fees, and the
// copilot pays for model calls. The server rejects bots on both.
initBotId({
  protect: [
    { path: "/api/lab/sponsor", method: "POST" },
    { path: "/api/private/ai", method: "POST" },
  ],
});
