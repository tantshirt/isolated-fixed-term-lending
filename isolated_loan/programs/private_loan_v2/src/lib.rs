//! ZenLo V2 private loans on MagicBlock Private Ephemeral Rollups (Epics 22–24).
//!
//! Rooms hold many loans; each loan runs the shared V2 accounting (`loan_core::accounting`);
//! administrative keys come from a governed `Config` (Story 19.5). V1 (`private_loan`) loans keep
//! their own program and rules.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::ephemeral;

pub mod ai;
pub mod config;
pub mod constants;
pub mod desk;
pub mod discovery;
pub mod error;
pub mod espl;
pub mod loan;
pub mod mandate;
pub mod receipt;
pub mod refinance;
pub mod room;
pub mod schedule;
pub mod settle;

use ai::*;
use config::*;
use desk::*;
use discovery::*;
use loan::*;
use mandate::*;
use receipt::*;
use refinance::*;
use room::*;
use settle::*;

declare_id!("JAzy8NP6V8AGrAko8vfgrD44BDghN6eLwqB7vjuYhHNq");

#[ephemeral]
#[program]
pub mod private_loan_v2 {
    use super::*;

    /// Base layer, once. The program's upgrade authority writes the separated authorities.
    pub fn init_config(ctx: Context<InitConfig>, authorities: governance::Authorities) -> Result<()> {
        config::init_config(ctx, authorities)
    }

    /// Base layer. Governance (the Squads vault) rotates every authority.
    pub fn rotate_authorities(ctx: Context<RotateAuthorities>, next: governance::Authorities) -> Result<()> {
        config::rotate_authorities(ctx, next)
    }

    /// Base layer. Creates the room anchor, namespaced by its creator, and funds it.
    pub fn open_room(ctx: Context<OpenRoom>, room_id: [u8; 32]) -> Result<()> {
        room::open_room(ctx, room_id)
    }

    /// Base layer. Delegates the room anchor to the TEE (same transaction as `open_room`).
    pub fn delegate_room(ctx: Context<DelegateRoom>, room_id: [u8; 32]) -> Result<()> {
        room::delegate_room(ctx, room_id)
    }

    /// Ephemeral rollup. Creates the private member list and thread. The owner names their own roles.
    pub fn init_room(ctx: Context<InitRoom>, owner_roles: u8) -> Result<()> {
        room::init_room(ctx, owner_roles)
    }

    /// Ephemeral rollup. Owner adds a member with role bits and widens both permissions.
    pub fn invite_member(ctx: Context<ManageMembers>, member: Pubkey, roles: u8) -> Result<()> {
        room::invite_member(ctx, member, roles)
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

    /// Base layer. The lender creates a loan anchor (creator + nonce) and its delegated eATAs.
    pub fn create_loan(ctx: Context<CreateLoan>, nonce: u64) -> Result<()> {
        loan::create_loan(ctx, nonce)
    }

    /// Base layer. Delegates the loan anchor (same transaction as `create_loan`).
    pub fn delegate_loan(ctx: Context<DelegateLoan>, nonce: u64) -> Result<()> {
        loan::delegate_loan(ctx, nonce)
    }

    /// Ephemeral rollup. Initial private setup: roles, room binding, the next room index.
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

    /// Ephemeral rollup. Borrower accepts `revision`: one accepted proposal per borrowing request.
    pub fn accept_loan(ctx: Context<BorrowerMoves>, revision: u32, auditor_hash: [u8; 32]) -> Result<()> {
        loan::accept_loan(ctx, revision, auditor_hash)
    }

    /// Ephemeral rollup. Borrower moves an Active or Grace loan into a funded proposal made to them,
    /// with fresh consent to its `revision` and auditor audience (Story 26.1).
    pub fn refinance(ctx: Context<Refinance>, revision: u32, auditor_hash: [u8; 32], max_contribution: u64) -> Result<()> {
        refinance::refinance(ctx, revision, auditor_hash, max_contribution)
    }

    /// Ephemeral rollup. Borrower pays part or all of the payoff, in any phase until settlement.
    pub fn repay(ctx: Context<BorrowerMoves>, amount: u64) -> Result<()> {
        loan::repay(ctx, amount)
    }

    /// Ephemeral rollup. Borrower adds wSOL; no price needed.
    pub fn add_collateral(ctx: Context<BorrowerMoves>, amount: u64) -> Result<()> {
        loan::add_collateral(ctx, amount)
    }

    /// Ephemeral rollup. Lender, from 24 hours after grace: payoff-equivalent wSOL, surplus returned.
    pub fn claim_priced_recovery(ctx: Context<LenderClaim>) -> Result<()> {
        loan::claim_priced_recovery(ctx)
    }

    /// Ephemeral rollup. Lender, from seven days after grace: all remaining wSOL, no price.
    pub fn claim_terminal(ctx: Context<LenderClaim>) -> Result<()> {
        loan::claim_terminal(ctx)
    }

    /// Base layer. Opens a lender desk namespaced by its creator.
    pub fn open_desk(ctx: Context<OpenDesk>, desk_id: [u8; 32]) -> Result<()> {
        desk::open_desk(ctx, desk_id)
    }

    /// Base layer. Delegates the desk anchor (same transaction as `open_desk`).
    pub fn delegate_desk(ctx: Context<DelegateDesk>, desk_id: [u8; 32]) -> Result<()> {
        desk::delegate_desk(ctx, desk_id)
    }

    /// Ephemeral rollup. Creates the private member list; the creator is the first administrator.
    pub fn init_desk(ctx: Context<InitDesk>, creator_roles: u8) -> Result<()> {
        desk::init_desk(ctx, creator_roles)
    }

    /// Ephemeral rollup. An administrator adds, re-roles (roles != 0) or removes (roles == 0) a member.
    pub fn set_desk_member<'info>(ctx: Context<'info, DeskAdmin<'info>>, member: Pubkey, roles: u8) -> Result<()> {
        desk::set_desk_member(ctx, member, roles)
    }

    /// Ephemeral rollup. An administrator publishes the next immutable policy version.
    pub fn publish_policy(ctx: Context<PublishPolicy>, args: PolicyArgs) -> Result<()> {
        desk::publish_policy(ctx, args)
    }

    /// Ephemeral rollup. A desk lender places a draft under the current policy and the desk book.
    pub fn attach_desk(ctx: Context<AttachDesk>) -> Result<()> {
        desk::attach_desk(ctx)
    }

    /// Ephemeral rollup. Lender and borrower together add a reader to a loan.
    pub fn add_loan_reader(ctx: Context<LoanReaders>, reader: Pubkey, current: Vec<Pubkey>) -> Result<()> {
        desk::add_loan_reader(ctx, reader, current)
    }

    /// Ephemeral rollup. Either party removes a reader; access ends from now on.
    pub fn remove_loan_reader(ctx: Context<LoanReaders>, reader: Pubkey, current: Vec<Pubkey>) -> Result<()> {
        desk::remove_loan_reader(ctx, reader, current)
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

    /// Base layer. The AI admin from `Config` turns the copilot on or off.
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

    /// Ephemeral rollup. The worker claims the single paid generation attempt.
    pub fn claim_ai_request(ctx: Context<ClaimAiRequest>, claim_id: [u8; 32]) -> Result<()> {
        ai::claim_ai_request(ctx, claim_id)
    }

    /// Ephemeral rollup. The worker stores the claimed typed answer once.
    pub fn ai_callback(ctx: Context<AiCallback>, result: Vec<u8>) -> Result<()> {
        ai::ai_callback(ctx, result)
    }

    /// Base layer. The liquidation-pool admin from `Config` creates the pool.
    pub fn init_liquidation_pool(ctx: Context<InitLiquidationPool>) -> Result<()> {
        settle::init_liquidation_pool(ctx)
    }

    /// Ephemeral rollup. Anyone schedules the Hydra watch for an active loan.
    pub fn schedule_watch(ctx: Context<ScheduleWatch>) -> Result<()> {
        settle::schedule_watch(ctx)
    }

    /// Ephemeral rollup. Signer-free: risk or overdue quotes, and their execution. The governance
    /// `QuoteParams` is an optional trailing account.
    pub fn watch_loan(ctx: Context<WatchLoan>) -> Result<()> {
        settle::watch_loan(ctx)
    }

    /// Ephemeral rollup. Anyone, after a position changes hands: a watch bound to the current
    /// lender (Story 26.4).
    pub fn rebind_watch(ctx: Context<ScheduleWatch>) -> Result<()> {
        settle::rebind_watch(ctx)
    }

    /// Base layer. Governance only: the liquidation quote TTL (Story 26.4).
    pub fn set_quote_params(ctx: Context<SetQuoteParams>, quote_ttl_seconds: i64) -> Result<()> {
        settle::set_quote_params(ctx, quote_ttl_seconds)
    }

    /// Ephemeral rollup. Borrower: a bounded top-up or repay mandate evaluated by its own crank in
    /// the rollup, never off-chain (Story 26.3).
    pub fn create_private_mandate(ctx: Context<CreatePrivateMandate>, args: PrivateMandateArgs) -> Result<()> {
        mandate::create_private_mandate(ctx, args)
    }

    /// Ephemeral rollup. Signer-free: the mandate crank.
    pub fn run_mandate(ctx: Context<RunMandate>) -> Result<()> {
        mandate::run_mandate(ctx)
    }

    /// Ephemeral rollup. Borrower: stops the mandate and revokes its delegate.
    pub fn revoke_private_mandate(ctx: Context<RevokePrivateMandate>) -> Result<()> {
        mandate::revoke_private_mandate(ctx)
    }

    /// Ephemeral rollup. A liquidator funds the current quote revision.
    pub fn fund_quote(ctx: Context<FundQuote>, revision: u32) -> Result<()> {
        settle::fund_quote(ctx, revision)
    }

    /// Ephemeral rollup. A liquidator collects payout and excess, or a refund, once.
    pub fn settle_ticket(ctx: Context<SettleTicket>) -> Result<()> {
        settle::settle_ticket(ctx)
    }

    /// Ephemeral rollup. Anyone refunds a liquidator's dead tickets to their own USDC account.
    pub fn refund_ticket(ctx: Context<RefundTicket>) -> Result<()> {
        settle::refund_ticket(ctx)
    }

    /// Ephemeral rollup. Commits the loan anchor with an action that writes the settlement receipt.
    pub fn publish_receipt(ctx: Context<PublishReceipt>) -> Result<()> {
        receipt::publish_receipt(ctx)
    }

    /// Base layer, Magic Action only: writes the receipt once.
    pub fn record_receipt(ctx: Context<RecordReceipt>, status: u8, commitment: [u8; 32], settled_at: i64) -> Result<()> {
        receipt::record_receipt(ctx, status, commitment, settled_at)
    }
}
