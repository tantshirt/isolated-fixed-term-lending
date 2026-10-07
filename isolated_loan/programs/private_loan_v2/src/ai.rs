//! AI copilot request and callback (Epic 11.2), after MagicBlock's
//! super-smart-contracts request/callback pattern.
//!
//! The requester approves an exact excerpt off-chain; only its SHA-256 lands in
//! an ER-only `AiRequest` readable by the requester and the configured worker.
//! The worker sends that excerpt (and nothing else) to the model and answers
//! through `ai_callback`, which checks the worker key, replay, deadline, and the
//! loan revision. The callback writes only the request record: it cannot change
//! loan status, prices, eligibility, or settlement.

use crate::constants::{AI_CONFIG_SEED, AI_REQUEST_SEED, LOAN_TERMS_SEED, ROOM_STATE_SEED};
use crate::error::PrivateLoanError;
use crate::loan::{LoanAnchor, LoanTerms};
use crate::room::{load, RoomAnchor, RoomState, Sponsor};
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::access_control::structs::{Member, AUTHORITY_FLAG, TX_BALANCES_FLAG, TX_LOGS_FLAG, TX_MESSAGE_FLAG};
use ephemeral_rollups_sdk::anchor::{MagicProgram, PermissionProgram};
use ephemeral_rollups_sdk::consts::EPHEMERAL_VAULT_ID;

pub const RESULT_MAX: usize = 700;
pub const MAX_TTL_SECONDS: i64 = 600;

pub const TASK_EXPLAIN_LOAN: u8 = 1;
pub const TASK_COMPARE: u8 = 2;
pub const TASK_DRAFT: u8 = 3;
pub const TASK_COUNTER: u8 = 4;
pub const TASK_EXPLAIN_ERROR: u8 = 5;

pub const STATUS_PENDING: u8 = 0;
pub const STATUS_ANSWERED: u8 = 1;
pub const STATUS_PROCESSING: u8 = 2;

#[account]
#[derive(InitSpace)]
pub struct AiConfig {
    pub worker: Pubkey,
    pub enabled: bool,
    pub bump: u8,
}

/// Fixed layout, edited in place (the result buffer is too large to move around).
pub mod layout {
    pub const REQUESTER: usize = 1;
    pub const ROOM: usize = 33;
    pub const LOAN: usize = 65;
    pub const TASK: usize = 97;
    pub const PAYLOAD_HASH: usize = 98;
    pub const REVISION: usize = 130;
    pub const CREATED: usize = 134;
    pub const DEADLINE: usize = 142;
    pub const STATUS: usize = 150;
    pub const ANSWERED_AT: usize = 151;
    pub const STALE: usize = 159;
    pub const RESULT_LEN: usize = 160;
    pub const RESULT: usize = 162;
    pub const LEN: usize = RESULT + super::RESULT_MAX;
}

/// The AI admin from `Config` turns the copilot on or off for the worker `Config` names. The
/// worker key itself changes only through governance rotation.
pub fn set_ai_worker(ctx: Context<SetAiWorker>, worker: Pubkey, enabled: bool) -> Result<()> {
    let authorities = &ctx.accounts.governance_config.authorities;
    authorities.require(governance::Role::AiAdmin, &ctx.accounts.admin.key()).map_err(crate::error::governance_error)?;
    require_keys_eq!(worker, authorities.ai_worker, PrivateLoanError::NotAiWorker);
    let c = &mut ctx.accounts.config;
    c.worker = worker;
    c.enabled = enabled;
    c.bump = ctx.bumps.config;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn create_ai_request(
    ctx: Context<CreateAiRequest>,
    request_id: [u8; 32],
    task: u8,
    payload_hash: [u8; 32],
    revision: u32,
    ttl_seconds: i64,
) -> Result<()> {
    let a = &ctx.accounts;
    require!(a.config.enabled, PrivateLoanError::AiDisabled);
    require!((TASK_EXPLAIN_LOAN..=TASK_EXPLAIN_ERROR).contains(&task), PrivateLoanError::InvalidRecord);
    require!(ttl_seconds > 0 && ttl_seconds <= MAX_TTL_SECONDS, PrivateLoanError::InvalidRecord);
    let room: RoomState = load(&a.room_state.to_account_info())?;
    let me = a.requester.key();
    require!(room.active(&me), PrivateLoanError::NotMember);

    // A request about a loan binds that loan's current revision, and only its parties may ask.
    let loan_key = match (&a.loan, &a.terms) {
        (Some(loan), Some(terms)) => {
            require_keys_eq!(loan.room, a.room.key(), PrivateLoanError::WrongRoom);
            let (expected, _) = Pubkey::find_program_address(&[LOAN_TERMS_SEED, loan.key().as_ref()], &crate::ID);
            require_keys_eq!(terms.key(), expected, PrivateLoanError::InvalidRecord);
            let t: LoanTerms = load(&terms.to_account_info())?;
            require!(t.current_lender == me || t.borrower == me, PrivateLoanError::NotMember);
            require!(t.revision == revision, PrivateLoanError::StaleRevision);
            loan.key()
        }
        (None, None) => Pubkey::default(),
        _ => return err!(PrivateLoanError::InvalidRecord),
    };

    let anchor_key = a.room.key();
    let bump = [ctx.bumps.request];
    let seen = TX_LOGS_FLAG | TX_BALANCES_FLAG | TX_MESSAGE_FLAG;
    Sponsor { anchor: &a.room, vault: &a.vault, magic_program: &a.magic_program, permission_program: &a.permission_program }
        .create_private_record(
            &a.request.to_account_info(),
            &a.request_permission.to_account_info(),
            &[AI_REQUEST_SEED, anchor_key.as_ref(), &request_id, &bump],
            layout::LEN as u32,
            vec![
                Member { flags: AUTHORITY_FLAG | seen, pubkey: me },
                Member { flags: seen, pubkey: a.config.worker },
            ],
        )?;

    let now = Clock::get()?.unix_timestamp;
    let info = a.request.to_account_info();
    let mut d = info.try_borrow_mut_data()?;
    d[0] = 1;
    d[layout::REQUESTER..layout::REQUESTER + 32].copy_from_slice(me.as_ref());
    d[layout::ROOM..layout::ROOM + 32].copy_from_slice(anchor_key.as_ref());
    d[layout::LOAN..layout::LOAN + 32].copy_from_slice(loan_key.as_ref());
    d[layout::TASK] = task;
    d[layout::PAYLOAD_HASH..layout::PAYLOAD_HASH + 32].copy_from_slice(&payload_hash);
    d[layout::REVISION..layout::REVISION + 4].copy_from_slice(&revision.to_le_bytes());
    d[layout::CREATED..layout::CREATED + 8].copy_from_slice(&now.to_le_bytes());
    d[layout::DEADLINE..layout::DEADLINE + 8].copy_from_slice(&(now + ttl_seconds).to_le_bytes());
    d[layout::STATUS] = STATUS_PENDING;
    Ok(())
}

fn validate_worker_request(
    info: &AccountInfo,
    worker: &Pubkey,
    config: &AiConfig,
    now: i64,
    expected_status: u8,
) -> Result<()> {
    require!(config.enabled, PrivateLoanError::AiDisabled);
    require_keys_eq!(*worker, config.worker, PrivateLoanError::NotAiWorker);
    require_keys_eq!(*info.owner, crate::ID, PrivateLoanError::InvalidRecord);
    let d = info.try_borrow_data()?;
    require!(d.len() == layout::LEN && d[0] == 1, PrivateLoanError::InvalidRecord);
    require!(d[layout::STATUS] == expected_status, PrivateLoanError::AlreadyAnswered);
    let deadline = i64::from_le_bytes(d[layout::DEADLINE..layout::DEADLINE + 8].try_into().unwrap());
    require!(now <= deadline, PrivateLoanError::RequestExpired);
    Ok(())
}

/// Consumes the single generation attempt before the worker incurs model costs.
/// A unique claim_id makes each invocation's transaction distinct, preventing
/// two callers from confirming the same successful transaction as their claim.
pub fn claim_ai_request(ctx: Context<ClaimAiRequest>, _claim_id: [u8; 32]) -> Result<()> {
    let a = &ctx.accounts;
    let info = a.request.to_account_info();
    validate_worker_request(&info, &a.worker.key(), &a.config, Clock::get()?.unix_timestamp, STATUS_PENDING)?;
    info.try_borrow_mut_data()?[layout::STATUS] = STATUS_PROCESSING;
    Ok(())
}

/// Worker only. Stores a claimed result once; a late answer is rejected, and an
/// answer about a loan whose revision moved is stored but marked stale.
pub fn ai_callback(ctx: Context<AiCallback>, result: Vec<u8>) -> Result<()> {
    let a = &ctx.accounts;
    require!(!result.is_empty() && result.len() <= RESULT_MAX, PrivateLoanError::InvalidRecord);

    let info = a.request.to_account_info();
    let now = Clock::get()?.unix_timestamp;
    validate_worker_request(&info, &a.worker.key(), &a.config, now, STATUS_PROCESSING)?;
    let (revision, loan) = {
        let d = info.try_borrow_data()?;
        (
            u32::from_le_bytes(d[layout::REVISION..layout::REVISION + 4].try_into().unwrap()),
            Pubkey::new_from_array(d[layout::LOAN..layout::LOAN + 32].try_into().unwrap()),
        )
    };

    let stale = if loan == Pubkey::default() {
        false
    } else {
        let terms = a.terms.as_ref().ok_or(error!(PrivateLoanError::InvalidRecord))?;
        let (expected, _) = Pubkey::find_program_address(&[LOAN_TERMS_SEED, loan.as_ref()], &crate::ID);
        require_keys_eq!(terms.key(), expected, PrivateLoanError::InvalidRecord);
        let t: LoanTerms = load(&terms.to_account_info())?;
        t.revision != revision
    };

    let mut d = info.try_borrow_mut_data()?;
    d[layout::STATUS] = STATUS_ANSWERED;
    d[layout::ANSWERED_AT..layout::ANSWERED_AT + 8].copy_from_slice(&now.to_le_bytes());
    d[layout::STALE] = stale as u8;
    d[layout::RESULT_LEN..layout::RESULT_LEN + 2].copy_from_slice(&(result.len() as u16).to_le_bytes());
    d[layout::RESULT..layout::RESULT + RESULT_MAX].fill(0);
    d[layout::RESULT..layout::RESULT + result.len()].copy_from_slice(&result);
    Ok(())
}

#[derive(Accounts)]
pub struct SetAiWorker<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [crate::constants::CONFIG_SEED], bump = governance_config.bump)]
    pub governance_config: Account<'info, crate::config::Config>,
    #[account(init_if_needed, payer = admin, space = 8 + AiConfig::INIT_SPACE, seeds = [AI_CONFIG_SEED], bump)]
    pub config: Account<'info, AiConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(request_id: [u8; 32])]
pub struct CreateAiRequest<'info> {
    pub requester: Signer<'info>,
    #[account(mut)]
    pub room: Account<'info, RoomAnchor>,
    /// CHECK: ER-only `RoomState`; membership checked in the handler.
    #[account(seeds = [ROOM_STATE_SEED, room.key().as_ref()], bump)]
    pub room_state: UncheckedAccount<'info>,
    #[account(seeds = [AI_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, AiConfig>,
    pub loan: Option<Account<'info, LoanAnchor>>,
    /// CHECK: ER-only `LoanTerms` for `loan`; address and parties checked in the handler.
    pub terms: Option<UncheckedAccount<'info>>,
    /// CHECK: ER-only `AiRequest`, created here.
    #[account(mut, seeds = [AI_REQUEST_SEED, room.key().as_ref(), request_id.as_ref()], bump)]
    pub request: UncheckedAccount<'info>,
    /// CHECK: Ephemeral permission for `request`.
    #[account(mut)]
    pub request_permission: UncheckedAccount<'info>,
    /// CHECK: Fixed ephemeral rent vault.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    pub magic_program: Program<'info, MagicProgram>,
    pub permission_program: Program<'info, PermissionProgram>,
}

#[derive(Accounts)]
pub struct ClaimAiRequest<'info> {
    pub worker: Signer<'info>,
    #[account(seeds = [AI_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, AiConfig>,
    /// CHECK: Owner, exact layout, status and deadline checked in the handler.
    #[account(mut)]
    pub request: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct AiCallback<'info> {
    pub worker: Signer<'info>,
    #[account(seeds = [AI_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, AiConfig>,
    /// CHECK: ER-only `AiRequest`, validated in the handler.
    #[account(mut)]
    pub request: UncheckedAccount<'info>,
    /// CHECK: ER-only `LoanTerms` when the request is about a loan; address checked in the handler.
    pub terms: Option<UncheckedAccount<'info>>,
}
