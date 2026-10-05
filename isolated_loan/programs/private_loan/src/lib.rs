//! Lendspan private protocol on MagicBlock Private Ephemeral Rollups.
//!
//! `probe`, `custody`, `record`, and `schedule` are the Epic 8 gate modules.
//! `room` is the private foundation (Epic 9.2): rooms, invitations, scoped
//! sessions, and messages, with all sensitive state in ER-only records.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::ephemeral;

pub mod constants;
pub mod ai;
pub mod custody;
pub mod discovery;
pub mod error;
pub mod espl;
pub mod loan;
pub mod probe;
pub mod receipt;
pub mod record;
pub mod room;
pub mod schedule;
pub mod settle;

use ai::*;
use custody::*;
use discovery::*;
use loan::*;
use probe::*;
use receipt::*;
use record::*;
use room::*;
use schedule::*;
use settle::*;

declare_id!("HwK4hxKqe94pLGkC9bGciENCCzvWwUAaz1mxVTDxMcK");

#[ephemeral]
#[program]
pub mod private_loan {
    use super::*;

    /// Base layer. Creates the probe and its permission in one instruction.
    pub fn create_probe(ctx: Context<CreateProbe>, id: [u8; 32], reader: Pubkey) -> Result<()> {
        probe::create_probe(ctx, id, reader)
    }

    /// Base layer. Delegates the permission and the probe to the TEE validator.
    pub fn delegate_probe(ctx: Context<DelegateProbe>, id: [u8; 32]) -> Result<()> {
        probe::delegate_probe(ctx, id)
    }

    /// Ephemeral rollup. Writes a value only the permitted members can read.
    pub fn write_probe(ctx: Context<WriteProbe>, value: u64) -> Result<()> {
        probe::write_probe(ctx, value)
    }

    /// Ephemeral rollup. Runs the shared Pyth check against the cloned receiver account.
    pub fn check_price(ctx: Context<CheckPrice>) -> Result<()> {
        probe::check_price(ctx)
    }

    /// Ephemeral rollup. Commits and undelegates the probe back to the base layer.
    pub fn undelegate_probe(ctx: Context<UndelegateProbe>) -> Result<()> {
        probe::undelegate_probe(ctx)
    }

    /// Ephemeral rollup. Permissionless scheduled tick; a no-op once settled.
    pub fn crank_tick(ctx: Context<CrankTick>) -> Result<()> {
        probe::crank_tick(ctx)
    }

    /// Ephemeral rollup. Creates a Hydra crank for `crank_tick`, sponsored by the probe.
    pub fn schedule_tick(ctx: Context<ScheduleTick>, seed: [u8; 32], interval_slots: u64, remaining: u64) -> Result<()> {
        schedule::schedule_tick(ctx, seed, interval_slots, remaining)
    }

    /// Ephemeral rollup. Creates a private ER-only record sponsored by the probe.
    pub fn create_record(ctx: Context<CreateRecord>, payload: [u8; 32]) -> Result<()> {
        record::create_record(ctx, payload)
    }

    /// Base layer. Creates the room anchor and funds it to sponsor private records.
    pub fn open_room(ctx: Context<OpenRoom>, room_id: [u8; 32]) -> Result<()> {
        room::open_room(ctx, room_id)
    }

    /// Base layer. Delegates the room anchor to the TEE (same transaction as `open_room`).
    pub fn delegate_room(ctx: Context<DelegateRoom>, room_id: [u8; 32]) -> Result<()> {
        room::delegate_room(ctx, room_id)
    }

    /// Ephemeral rollup. Creates the private member list and thread.
    pub fn init_room(ctx: Context<InitRoom>) -> Result<()> {
        room::init_room(ctx)
    }

    /// Ephemeral rollup. Owner adds a member and widens both permissions.
    pub fn invite_member(ctx: Context<ManageMembers>, member: Pubkey, role: u8) -> Result<()> {
        room::invite_member(ctx, member, role)
    }

    /// Ephemeral rollup. Owner removes a member and narrows both permissions.
    pub fn revoke_member(ctx: Context<ManageMembers>, member: Pubkey) -> Result<()> {
        room::revoke_member(ctx, member)
    }

    /// Ephemeral rollup. A member authorises a session key for nonfinancial actions.
    pub fn create_session(ctx: Context<CreateSession>, session_key: Pubkey, expires_at: i64, scope: u32) -> Result<()> {
        room::create_session(ctx, session_key, expires_at, scope)
    }

    /// Ephemeral rollup. The authorising wallet revokes its session.
    pub fn revoke_session(ctx: Context<RevokeSession>) -> Result<()> {
        room::revoke_session(ctx)
    }

    /// Ephemeral rollup. A member, or a session with post scope, posts a message.
    pub fn post_message(ctx: Context<PostMessage>, body: Vec<u8>) -> Result<()> {
        room::post_message(ctx, body)
    }

    /// Base layer. Creates the loan anchor and its two empty, delegated eATAs.
    pub fn create_loan(ctx: Context<CreateLoan>, loan_id: [u8; 32]) -> Result<()> {
        loan::create_loan(ctx, loan_id)
    }

    /// Base layer. Delegates the loan anchor (same transaction as `create_loan`).
    pub fn delegate_loan(ctx: Context<DelegateLoan>, loan_id: [u8; 32]) -> Result<()> {
        loan::delegate_loan(ctx, loan_id)
    }

    /// Ephemeral rollup. Lender proposes exact terms to a borrower in the same room.
    pub fn propose_terms(ctx: Context<ProposeTerms>, args: TermsArgs) -> Result<()> {
        loan::propose_terms(ctx, args)
    }

    /// Ephemeral rollup. Lender edits terms before funding; the revision moves.
    pub fn edit_terms(ctx: Context<EditTerms>, args: TermsArgs) -> Result<()> {
        loan::edit_terms(ctx, args)
    }

    /// Ephemeral rollup. Lender locks the principal for `revision`.
    pub fn fund_loan(ctx: Context<LenderMoves>, revision: u32) -> Result<()> {
        loan::fund_loan(ctx, revision)
    }

    /// Ephemeral rollup. Lender cancels before acceptance; principal returns.
    pub fn cancel_loan(ctx: Context<LenderMoves>) -> Result<()> {
        loan::cancel_loan(ctx)
    }

    /// Ephemeral rollup. Borrower accepts `revision`: collateral in, principal out.
    pub fn accept_loan(ctx: Context<BorrowerMoves>, revision: u32) -> Result<()> {
        loan::accept_loan(ctx, revision)
    }

    /// Ephemeral rollup. Borrower repays the exact debt before the deadline.
    pub fn repay_loan(ctx: Context<BorrowerMoves>) -> Result<()> {
        loan::repay_loan(ctx)
    }

    /// Ephemeral rollup. Anyone, at or after the deadline: collateral to the lender.
    pub fn claim_expired(ctx: Context<ClaimExpired>) -> Result<()> {
        loan::claim_expired(ctx)
    }

    /// Base layer. Room owner publishes an opt-in public card with chosen fields.
    pub fn publish_card(ctx: Context<PublishCard>, card_id: [u8; 32], fields: CardArgs) -> Result<()> {
        discovery::publish_card(ctx, card_id, fields)
    }

    /// Base layer. Publisher removes the card and reclaims rent.
    pub fn retract_card(ctx: Context<RetractCard>) -> Result<()> {
        discovery::retract_card(ctx)
    }

    /// Ephemeral rollup. Owner creates the join queue only they can read.
    pub fn open_join_queue(ctx: Context<OpenJoinQueue>) -> Result<()> {
        discovery::open_join_queue(ctx)
    }

    /// Ephemeral rollup. Anyone asks to join a room from its public card.
    pub fn request_join(ctx: Context<RequestJoin>) -> Result<()> {
        discovery::request_join(ctx)
    }

    /// Base layer. Admin sets the AI worker key and turns the copilot on or off.
    pub fn set_ai_worker(ctx: Context<SetAiWorker>, worker: Pubkey, enabled: bool) -> Result<()> {
        ai::set_ai_worker(ctx, worker, enabled)
    }

    /// Ephemeral rollup. A member binds an approved excerpt hash (and loan revision) to a request.
    pub fn create_ai_request(
        ctx: Context<CreateAiRequest>,
        request_id: [u8; 32],
        task: u8,
        payload_hash: [u8; 32],
        revision: u32,
        ttl_seconds: i64,
    ) -> Result<()> {
        ai::create_ai_request(ctx, request_id, task, payload_hash, revision, ttl_seconds)
    }

    /// Ephemeral rollup. The worker stores the typed answer once.
    pub fn ai_callback(ctx: Context<AiCallback>, result: Vec<u8>) -> Result<()> {
        ai::ai_callback(ctx, result)
    }

    /// Base layer. Admin creates the liquidation pool and its delegated eATAs.
    pub fn init_liquidation_pool(ctx: Context<InitLiquidationPool>) -> Result<()> {
        settle::init_liquidation_pool(ctx)
    }

    /// Ephemeral rollup. Anyone schedules the Hydra watch for an active loan.
    pub fn schedule_watch(ctx: Context<ScheduleWatch>) -> Result<()> {
        settle::schedule_watch(ctx)
    }

    /// Ephemeral rollup. Signer-free: expiry, liquidation quotes, and execution.
    pub fn watch_loan(ctx: Context<WatchLoan>) -> Result<()> {
        settle::watch_loan(ctx)
    }

    /// Ephemeral rollup. A liquidator funds the current quote revision.
    pub fn fund_quote(ctx: Context<FundQuote>, revision: u32) -> Result<()> {
        settle::fund_quote(ctx, revision)
    }

    /// Ephemeral rollup. A liquidator collects a payout or a refund, once.
    pub fn settle_ticket(ctx: Context<SettleTicket>) -> Result<()> {
        settle::settle_ticket(ctx)
    }

    /// Ephemeral rollup. Commits the loan anchor with a post-commit action that
    /// writes the settlement receipt on Solana.
    pub fn publish_receipt(ctx: Context<PublishReceipt>) -> Result<()> {
        receipt::publish_receipt(ctx)
    }

    /// Base layer, Magic Action only: writes the receipt once.
    pub fn record_receipt(ctx: Context<RecordReceipt>, status: u8, commitment: [u8; 32], settled_at: i64) -> Result<()> {
        receipt::record_receipt(ctx, status, commitment, settled_at)
    }

    /// Base layer. Creates a custody PDA, its ATA, and its eATA.
    pub fn create_custody(ctx: Context<CreateCustody>, id: [u8; 32]) -> Result<()> {
        custody::create_custody(ctx, id)
    }

    /// Base layer. Moves tokens into the custody eATA and delegates it to the TEE.
    pub fn fund_and_delegate(ctx: Context<FundAndDelegate>, amount: u64) -> Result<()> {
        custody::fund_and_delegate(ctx, amount)
    }

    /// Ephemeral rollup. Custody PDA signs an SPL transfer out of its own ATA.
    pub fn custody_transfer(ctx: Context<CustodyTransfer>, amount: u64) -> Result<()> {
        custody::custody_transfer(ctx, amount)
    }

    /// Ephemeral rollup. Returns the custody eATA to the base layer.
    pub fn undelegate_custody(ctx: Context<UndelegateCustody>) -> Result<()> {
        custody::undelegate_custody(ctx)
    }

    /// Base layer. Withdraws from the global vault to the authority.
    pub fn withdraw_custody(ctx: Context<WithdrawCustody>, amount: u64) -> Result<()> {
        custody::withdraw_custody(ctx, amount)
    }
}
