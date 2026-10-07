import test from "node:test";
import assert from "node:assert/strict";
import { commitScan, deliveryAllowed, subscribe } from "../../convex/alerts";
import { HANDLERS, type JobContext } from "../../convex/lib/handlers";

const handler = (registered: unknown) => (registered as { _handler: (ctx: unknown, args: unknown) => Promise<unknown> })._handler;

function fixture() {
  const rows = new Map<string, Record<string, unknown>>([
    ["sub", { active: true, wallet: "wallet", revision: 0 }],
    ["chat", { wallet: "wallet", chatId: "telegram" }],
  ]);
  const jobs: unknown[] = [];
  const ctx = {
    runQuery: async () => [],
    db: {
      get: async (id: string) => rows.get(id) ?? null,
      normalizeId: (_table: string, id: string) => id,
      patch: async (id: string, patch: Record<string, unknown>) => { rows.set(id, { ...rows.get(id), ...patch }); },
      query: () => ({ withIndex: () => ({ unique: async () => null }) }),
      insert: async (_table: string, row: unknown) => { jobs.push(row); return "job"; },
    },
  };
  const args = { id: "sub", expectedRevision: 0, chatLinkId: "chat", state: { reminders: ["due"] }, messages: [{ key: "due", text: "Reminder" }] };
  return { rows, jobs, ctx, args };
}

test("withdrawn consent, disconnected chat and stale scans cannot consume or enqueue alerts", async () => {
  for (const change of ["unsubscribe", "unlink", "stale"] as const) {
    const f = fixture();
    if (change === "unsubscribe") f.rows.get("sub")!.active = false;
    if (change === "unlink") f.rows.delete("chat");
    if (change === "stale") f.rows.get("sub")!.revision = 1;
    assert.equal(await handler(commitScan)(f.ctx, f.args), false);
    assert.equal(f.jobs.length, 0);
    assert.equal(f.rows.get("sub")!.state, undefined);
  }
});

test("failed enqueue does not mark reminder delivered; retry commits job and state together", async () => {
  const f = fixture();
  const insert = f.ctx.db.insert;
  f.ctx.db.insert = async () => { throw new Error("write failed"); };
  await assert.rejects(handler(commitScan)(f.ctx, f.args), /write failed/);
  assert.equal(f.rows.get("sub")!.state, undefined);
  f.ctx.db.insert = insert;
  assert.equal(await handler(commitScan)(f.ctx, f.args), true);
  assert.equal(f.jobs.length, 1);
  assert.deepEqual(f.rows.get("sub")!.state, { reminders: ["due"] });
  assert.equal(await handler(commitScan)(f.ctx, f.args), false, "concurrent scan loses the revision comparison");
});

test("delivery checks consent again after the job was queued", async () => {
  const f = fixture();
  const args = { subscriptionId: "sub", chatLinkId: "chat", chatId: "telegram" };
  assert.equal(await handler(deliveryAllowed)(f.ctx, args), "allowed");
  f.rows.get("sub")!.active = false;
  assert.equal(await handler(deliveryAllowed)(f.ctx, args), "revoked");
  const job = { payload: { ...args, text: "Do not send" }, canSendAlert: async () => "revoked" } as unknown as JobContext;
  const before = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  try {
    assert.deepEqual(await HANDLERS["telegram-send"](job), { skipped: true });
    await assert.rejects(HANDLERS["telegram-send"]({ ...job, canSendAlert: async () => "paused" }), /delivery is paused/);
  } finally {
    if (before === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = before;
  }
});

test("subscription rejects base58 strings that decode beyond a Solana public key", async () => {
  const ctx = {
    auth: { getUserIdentity: async () => ({ subject: "wallet", sid: "session" }) },
    db: { normalizeId: () => "session", get: async () => ({ wallet: "wallet", expiresAt: Date.now() + 100_000 }) },
  };
  await assert.rejects(handler(subscribe)(ctx, { kind: "public-v2", loan: "z".repeat(44) }), /Not a loan address/);
});
