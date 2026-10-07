import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireWallet } from "./auth";
import { evaluateGate, type PilotEvent } from "../lib/pilot/gate";

const opsAdmins = () => new Set((process.env.OPS_ADMIN_WALLETS ?? "").split(",").map((s) => s.trim()).filter(Boolean));

/** A participant shares a pilot event about themselves; the signer must be one of the parties. */
export const record = mutation({
  args: {
    kind: v.union(v.literal("desk_activated"), v.literal("loan_confirmed")),
    deskId: v.string(),
    loan: v.optional(v.string()),
    lender: v.optional(v.string()),
    borrower: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const wallet = await requireWallet(ctx);
    if (a.kind === "desk_activated") {
      return ctx.db.insert("pilotEvents", { kind: a.kind, deskId: a.deskId, operator: wallet, signers: [wallet], assisted: false, at: Date.now(), recordedBy: wallet });
    }
    if (!a.loan || !a.lender || !a.borrower) throw new Error("A loan event names the loan and both parties.");
    if (wallet !== a.lender && wallet !== a.borrower) throw new Error("Only a party can report a loan.");
    const seen = await ctx.db.query("pilotEvents").withIndex("by_loan", (q) => q.eq("loan", a.loan)).first();
    if (seen) return seen._id;
    return ctx.db.insert("pilotEvents", { kind: a.kind, deskId: a.deskId, loan: a.loan, lender: a.lender, borrower: a.borrower, signers: [wallet], assisted: false, at: Date.now(), recordedBy: wallet });
  },
});

/** Operations marks a loan the developer helped originate; it then counts against the 80% share. */
export const markAssisted = mutation({
  args: { loan: v.string() },
  handler: async (ctx, { loan }) => {
    const wallet = await requireWallet(ctx);
    if (!opsAdmins().has(wallet)) throw new Error("Not an operations wallet");
    const row = await ctx.db.query("pilotEvents").withIndex("by_loan", (q) => q.eq("loan", loan)).first();
    if (row) await ctx.db.patch(row._id, { assisted: true });
  },
});

/** The customer-gate report, for operations wallets only. */
export const gate = query({
  args: {},
  handler: async (ctx) => {
    let wallet: string;
    try {
      wallet = await requireWallet(ctx);
    } catch {
      return null;
    }
    if (!opsAdmins().has(wallet)) return null;
    const rows = await ctx.db.query("pilotEvents").withIndex("by_at").collect();
    const events: PilotEvent[] = rows.map((r) =>
      r.kind === "desk_activated"
        ? { kind: "desk_activated", deskId: r.deskId, operator: r.operator!, at: r.at }
        : { kind: "loan_confirmed", deskId: r.deskId, lender: r.lender!, borrower: r.borrower!, signers: r.signers, assisted: r.assisted, at: r.at },
    );
    return evaluateGate(events);
  },
});
