//! Private lender desks (Story 23.1) and auditor consent (Story 24.1).
//!
//! A desk is a set of individual lender wallets under one policy, not a pooled treasury: every
//! loan is funded from the proposing lender's own private balance and records that wallet.
//!
//! - `DeskAnchor` (delegated) sponsors the desk's ER-only records.
//! - `DeskState` (ER-only) lists members with role bits. Administrators manage members and
//!   publish policies; administration grants no spending authority and no read access to loans.
//! - `DeskPolicy` (ER-only, one record per version, immutable once written) bounds every loan
//!   originated under it. The program checks it at propose and again at accept.
//! - `DeskLoan` (ER-only) indexes the desk's loan book: sequence → loan anchor.
//! - Auditors named in the policy are shown at signing; the borrower's acceptance binds the
//!   hash of that list, and only then are auditors added to the loan's read permission.

use crate::constants::{DESK_LOAN_SEED, DESK_POLICY_SEED, DESK_SEED, DESK_STATE_SEED, LOAN_TERMS_SEED, TEE_VALIDATOR};
use crate::error::PrivateLoanError;
use crate::loan::{LoanAnchor, LoanTerms, STATUS_DRAFT, STATUS_FUNDED};
use crate::room::{load, store};
use anchor_lang::prelude::*;
use anchor_lang::system_program;
use ephemeral_rollups_sdk::access_control::instructions::{CreateEphemeralPermissionCpi, UpdateEphemeralPermissionCpi};
use ephemeral_rollups_sdk::access_control::structs::{EphemeralMembersArgs, Member, Permission, AUTHORITY_FLAG, TX_BALANCES_FLAG, TX_LOGS_FLAG, TX_MESSAGE_FLAG};
use ephemeral_rollups_sdk::anchor::{delegate, MagicProgram, PermissionProgram};
use ephemeral_rollups_sdk::consts::EPHEMERAL_VAULT_ID;
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephemeral_accounts::EphemeralAccount;
use solana_sha256_hasher::hashv;

pub const DESK_MEMBERS: usize = 16;
pub const MAX_AUDITORS: usize = 4;
pub const DESK_SPONSOR_LAMPORTS: u64 = 20_000_000;

pub const DESK_ADMIN: u8 = 1;
pub const DESK_LENDER: u8 = 2;
pub const DESK_AUDITOR: u8 = 4;
pub const DESK_ROLES: u8 = DESK_ADMIN | DESK_LENDER | DESK_AUDITOR;

pub const MODE_FULL_TERM: u8 = 1;
pub const MODE_PRO_RATA: u8 = 2;

const SEEN: u8 = TX_LOGS_FLAG | TX_BALANCES_FLAG | TX_MESSAGE_FLAG;

#[account]
#[derive(InitSpace)]
pub struct DeskAnchor {
    pub desk_id: [u8; 32],
    pub creator: Pubkey,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct DeskMember {
    pub pubkey: Pubkey,
    pub roles: u8,
    pub active: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct DeskState {
    pub version: u8,
    pub revision: u64,
    /// Latest published policy; 0 until the first one. Loans pin the version they used.
    pub policy_version: u32,
    pub next_loan_seq: u32,
    pub members: [DeskMember; DESK_MEMBERS],
}

impl DeskState {
    pub const LEN: usize = 1 + 8 + 4 + 4 + DESK_MEMBERS * 34;

    pub fn has(&self, who: &Pubkey, role: u8) -> bool {
        self.members.iter().any(|m| m.active && m.pubkey == *who && m.roles & role == role)
    }

    /// Members can read the desk; administrators also hold the permission's authority so they
    /// can change membership. No one gains access to any loan through this list.
    pub fn permission_members(&self) -> Vec<Member> {
        self.members
            .iter()
            .filter(|m| m.active)
            .map(|m| Member { flags: if m.roles & DESK_ADMIN != 0 { AUTHORITY_FLAG | SEEN } else { SEEN }, pubkey: m.pubkey })
            .collect()
    }

    /// Policies and book entries follow desk membership, but only the program may change
    /// their audiences. Administrator authority belongs on DeskState alone.
    pub fn metadata_readers(&self) -> Vec<Member> {
        self.members.iter().filter(|m| m.active).map(|m| Member { flags: SEEN, pubkey: m.pubkey }).collect()
    }
}

/// Everything a loan under the desk must satisfy. Immutable once written.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct PolicyArgs {
    pub min_principal: u64,
    pub max_principal: u64,
    pub min_duration_seconds: i64,
    pub max_duration_seconds: i64,
    /// Required: the desk's annual pricing ceiling. Every loan's ceiling must be at or below it.
    pub max_annual_ceiling_bps: u16,
    pub max_interest_bps: u16,
    /// Bits: MODE_FULL_TERM, MODE_PRO_RATA.
    pub repayment_modes: u8,
    pub max_ltv_bps: u16,
    pub max_liquidation_ltv_bps: u16,
    pub min_grace_seconds: i64,
    pub max_late_fee_bps: u16,
    pub auditor_count: u8,
    pub auditors: [Pubkey; MAX_AUDITORS],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct DeskPolicy {
    pub version: u32,
    pub published_at: i64,
    pub args: PolicyArgs,
}

impl DeskPolicy {
    pub const LEN: usize = 4 + 8 + (8 + 8 + 8 + 8 + 2 + 2 + 1 + 2 + 2 + 8 + 2 + 1 + 32 * MAX_AUDITORS);
}

impl PolicyArgs {
    pub fn validate(&self) -> Result<()> {
        require!(self.max_annual_ceiling_bps > 0, PrivateLoanError::InvalidPolicy);
        require!(self.min_principal <= self.max_principal && self.max_principal > 0, PrivateLoanError::InvalidPolicy);
        require!(self.min_duration_seconds <= self.max_duration_seconds, PrivateLoanError::InvalidPolicy);
        require!(self.repayment_modes != 0 && self.repayment_modes & !(MODE_FULL_TERM | MODE_PRO_RATA) == 0, PrivateLoanError::InvalidPolicy);
        require!((self.auditor_count as usize) <= MAX_AUDITORS, PrivateLoanError::InvalidPolicy);
        Ok(())
    }

    pub fn auditors(&self) -> &[Pubkey] {
        &self.auditors[..self.auditor_count as usize]
    }

    /// The hash a borrower signs to consent to this audience.
    pub fn auditor_hash(&self) -> [u8; 32] {
        if self.auditor_count == 0 {
            return [0; 32];
        }
        let parts: Vec<&[u8]> = self.auditors().iter().map(|k| k.as_ref()).collect();
        hashv(&parts).to_bytes()
    }

    /// Checks one loan's terms against this policy.
    pub fn allows(&self, t: &LoanTerms) -> Result<()> {
        let mode = if t.early_repayment == 1 { MODE_PRO_RATA } else { MODE_FULL_TERM };
        require!(t.principal >= self.min_principal && t.principal <= self.max_principal, PrivateLoanError::PolicyViolation);
        require!(t.duration_seconds >= self.min_duration_seconds && t.duration_seconds <= self.max_duration_seconds, PrivateLoanError::PolicyViolation);
        require!(t.annual_ceiling_bps <= self.max_annual_ceiling_bps, PrivateLoanError::PolicyViolation);
        require!(t.interest_bps <= self.max_interest_bps, PrivateLoanError::PolicyViolation);
        require!(self.repayment_modes & mode != 0, PrivateLoanError::PolicyViolation);
        require!(t.max_ltv_bps <= self.max_ltv_bps && t.liquidation_ltv_bps <= self.max_liquidation_ltv_bps, PrivateLoanError::PolicyViolation);
        require!(t.grace_seconds >= self.min_grace_seconds, PrivateLoanError::PolicyViolation);
        require!(t.late_fee_bps <= self.max_late_fee_bps, PrivateLoanError::PolicyViolation);
        Ok(())
    }
}

fn desk_seeds(a: &DeskAnchor) -> [&[u8]; 4] {
    [DESK_SEED, a.creator.as_ref(), &a.desk_id, core::slice::from_ref(&a.bump)]
}

#[allow(clippy::too_many_arguments)]
fn create_desk_record<'info>(
    anchor: &Account<'info, DeskAnchor>,
    record: &AccountInfo<'info>,
    permission: &AccountInfo<'info>,
    record_seeds: &[&[u8]],
    len: u32,
    members: Vec<Member>,
    vault: &AccountInfo<'info>,
    magic_program: &AccountInfo<'info>,
    permission_program: &AccountInfo<'info>,
) -> Result<()> {
    let info = anchor.to_account_info();
    let seeds = desk_seeds(anchor);
    EphemeralAccount::new(&info, record, vault).with_signer_seeds(&[&seeds, record_seeds]).create(len)?;
    CreateEphemeralPermissionCpi {
        permissioned_account: record.clone(),
        permission: permission.clone(),
        payer: info,
        vault: vault.clone(),
        magic_program: magic_program.clone(),
        permission_program: permission_program.clone(),
        args: EphemeralMembersArgs { is_private: true, members },
    }
    .invoke_signed(&[&seeds, record_seeds])?;
    Ok(())
}

// ---------------------------------------------------------------- base layer

pub fn open_desk(ctx: Context<OpenDesk>, desk_id: [u8; 32]) -> Result<()> {
    let d = &mut ctx.accounts.anchor;
    d.desk_id = desk_id;
    d.creator = ctx.accounts.creator.key();
    d.bump = ctx.bumps.anchor;
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.key(),
            system_program::Transfer { from: ctx.accounts.creator.to_account_info(), to: ctx.accounts.anchor.to_account_info() },
        ),
        DESK_SPONSOR_LAMPORTS,
    )
}

pub fn delegate_desk(ctx: Context<DelegateDesk>, desk_id: [u8; 32]) -> Result<()> {
    let creator = ctx.accounts.creator.key();
    ctx.accounts.delegate_anchor(
        &ctx.accounts.creator,
        &[DESK_SEED, creator.as_ref(), &desk_id],
        DelegateConfig { validator: Some(TEE_VALIDATOR), ..Default::default() },
    )?;
    Ok(())
}

// ------------------------------------------------------------- ephemeral rollup

/// The creator becomes the first administrator, with the roles they choose.
pub fn init_desk(ctx: Context<InitDesk>, creator_roles: u8) -> Result<()> {
    require!(creator_roles & DESK_ADMIN != 0 && creator_roles & !DESK_ROLES == 0, PrivateLoanError::InvalidRole);
    let a = &ctx.accounts;
    require_keys_eq!(a.anchor.creator, a.admin.key(), PrivateLoanError::NotDeskAdmin);
    require!(a.state.data_is_empty(), PrivateLoanError::RoomAlreadyInitialized);
    let mut members = [DeskMember::default(); DESK_MEMBERS];
    members[0] = DeskMember { pubkey: a.admin.key(), roles: creator_roles, active: true };
    let state = DeskState { version: 1, revision: 0, policy_version: 0, next_loan_seq: 0, members };
    let key = a.anchor.key();
    let bump = [ctx.bumps.state];
    create_desk_record(
        &a.anchor,
        &a.state.to_account_info(),
        &a.state_permission.to_account_info(),
        &[DESK_STATE_SEED, key.as_ref(), &bump],
        DeskState::LEN as u32,
        state.permission_members(),
        &a.vault.to_account_info(),
        &a.magic_program.to_account_info(),
        &a.permission_program.to_account_info(),
    )?;
    store(&a.state.to_account_info(), &state)
}

/// An administrator adds, re-roles or removes a member. The last administrator cannot remove
/// themselves, so a desk is never left without one. Remaining accounts contain every policy
/// (versions 1..=policy_version), then every book entry (0..next_loan_seq), each followed by its
/// permission. Membership and all metadata permissions change atomically or not at all.
pub fn set_desk_member<'info>(ctx: Context<'info, DeskAdmin<'info>>, member: Pubkey, roles: u8) -> Result<()> {
    require!(roles & !DESK_ROLES == 0, PrivateLoanError::InvalidRole);
    let a = &ctx.accounts;
    let info = a.state.to_account_info();
    let mut s: DeskState = load(&info)?;
    require!(s.has(&a.admin.key(), DESK_ADMIN), PrivateLoanError::NotDeskAdmin);
    validate_metadata_accounts(&a.anchor.key(), &s, ctx.remaining_accounts)?;
    if let Some(m) = s.members.iter_mut().find(|m| m.active && m.pubkey == member) {
        if roles == 0 {
            m.active = false;
        } else {
            m.roles = roles;
        }
    } else {
        require!(roles != 0, PrivateLoanError::NotMember);
        let slot = s.members.iter_mut().find(|m| !m.active).ok_or(error!(PrivateLoanError::RoomFull))?;
        *slot = DeskMember { pubkey: member, roles, active: true };
    }
    require!(s.members.iter().any(|m| m.active && m.roles & DESK_ADMIN != 0), PrivateLoanError::LastDeskAdmin);
    let key = a.anchor.key();
    let seeds = desk_seeds(&a.anchor);
    for (i, pair) in ctx.remaining_accounts.chunks_exact(2).enumerate() {
        let (seed, index) = metadata_seed(&s, i);
        let index = index.to_le_bytes();
        let (_, bump) = Pubkey::find_program_address(&[seed, key.as_ref(), &index], &crate::ID);
        let record_seeds: &[&[u8]] = &[seed, key.as_ref(), &index, &[bump]];
        UpdateEphemeralPermissionCpi {
            permissioned_account: pair[0].clone(),
            permission: pair[1].clone(),
            payer: a.anchor.to_account_info(),
            authority: pair[0].clone(),
            vault: a.vault.to_account_info(),
            magic_program: a.magic_program.to_account_info(),
            permission_program: a.permission_program.to_account_info(),
            authority_is_signer: false,
            args: EphemeralMembersArgs { is_private: true, members: s.metadata_readers() },
        }
        .invoke_signed(&[&seeds, record_seeds])?;
    }
    s.revision = s.revision.saturating_add(1);
    let bump = [ctx.bumps.state];
    let record_seeds: &[&[u8]] = &[DESK_STATE_SEED, key.as_ref(), &bump];
    UpdateEphemeralPermissionCpi {
        permissioned_account: info.clone(),
        permission: a.state_permission.to_account_info(),
        payer: a.anchor.to_account_info(),
        authority: info.clone(),
        vault: a.vault.to_account_info(),
        magic_program: a.magic_program.to_account_info(),
        permission_program: a.permission_program.to_account_info(),
        authority_is_signer: false,
        args: EphemeralMembersArgs { is_private: true, members: s.permission_members() },
    }
    .invoke_signed(&[&seeds, record_seeds])?;
    store(&info, &s)
}

fn metadata_seed(s: &DeskState, i: usize) -> (&'static [u8], u32) {
    if i < s.policy_version as usize {
        (DESK_POLICY_SEED, i as u32 + 1)
    } else {
        (DESK_LOAN_SEED, (i - s.policy_version as usize) as u32)
    }
}

/// Require the complete canonical list before touching permissions. A concurrently published
/// policy or attached loan makes the supplied list stale and safely rejects the whole update.
fn validate_metadata_accounts(desk: &Pubkey, s: &DeskState, accounts: &[AccountInfo]) -> Result<()> {
    let count = (s.policy_version as usize).checked_add(s.next_loan_seq as usize)
        .and_then(|n| n.checked_mul(2)).ok_or(PrivateLoanError::MathOverflow)?;
    require!(accounts.len() == count, PrivateLoanError::InvalidRecord);
    for (i, pair) in accounts.chunks_exact(2).enumerate() {
        let (seed, index) = metadata_seed(s, i);
        let (record, _) = Pubkey::find_program_address(&[seed, desk.as_ref(), &index.to_le_bytes()], &crate::ID);
        require_keys_eq!(pair[0].key(), record, PrivateLoanError::InvalidRecord);
        require_keys_eq!(*pair[0].owner, crate::ID, PrivateLoanError::InvalidRecord);
        require_keys_eq!(pair[1].key(), Permission::find_pda(&record).0, PrivateLoanError::InvalidRecord);
        require!(pair[1].is_writable, PrivateLoanError::InvalidRecord);
    }
    Ok(())
}

/// An administrator publishes the next policy version. Earlier versions stay as written, so a
/// loan always answers to the exact rules it was signed under.
pub fn publish_policy(ctx: Context<PublishPolicy>, args: PolicyArgs) -> Result<()> {
    args.validate()?;
    let a = &ctx.accounts;
    let state_info = a.state.to_account_info();
    let mut s: DeskState = load(&state_info)?;
    require!(s.has(&a.admin.key(), DESK_ADMIN), PrivateLoanError::NotDeskAdmin);
    let version = s.policy_version.checked_add(1).ok_or(PrivateLoanError::MathOverflow)?;
    let key = a.anchor.key();
    let (expected, bump) = Pubkey::find_program_address(&[DESK_POLICY_SEED, key.as_ref(), &version.to_le_bytes()], &crate::ID);
    require_keys_eq!(a.policy.key(), expected, PrivateLoanError::InvalidRecord);
    require!(a.policy.data_is_empty(), PrivateLoanError::InvalidRecord);
    create_desk_record(
        &a.anchor,
        &a.policy.to_account_info(),
        &a.policy_permission.to_account_info(),
        &[DESK_POLICY_SEED, key.as_ref(), &version.to_le_bytes(), &[bump]],
        DeskPolicy::LEN as u32,
        s.metadata_readers(),
        &a.vault.to_account_info(),
        &a.magic_program.to_account_info(),
        &a.permission_program.to_account_info(),
    )?;
    store(&a.policy.to_account_info(), &DeskPolicy { version, published_at: Clock::get()?.unix_timestamp, args })?;
    s.policy_version = version;
    store(&state_info, &s)
}

/// A desk lender places a draft loan under the desk's current policy. The loan pins the policy
/// version and auditor-list hash, and enters the desk's loan book.
pub fn attach_desk(ctx: Context<AttachDesk>) -> Result<()> {
    let a = &ctx.accounts;
    let terms_info = a.terms.to_account_info();
    let mut t: LoanTerms = load(&terms_info)?;
    require!(t.status == STATUS_DRAFT, PrivateLoanError::WrongStatus);
    require!(t.desk == Pubkey::default(), PrivateLoanError::WrongStatus);
    require_keys_eq!(t.current_lender, a.lender.key(), PrivateLoanError::NotLender);
    let state_info = a.state.to_account_info();
    let mut s: DeskState = load(&state_info)?;
    require!(s.has(&a.lender.key(), DESK_LENDER), PrivateLoanError::NotDeskLender);
    let policy: DeskPolicy = load(&a.policy.to_account_info())?;
    require!(policy.version == s.policy_version && s.policy_version > 0, PrivateLoanError::StaleRevision);
    let desk_key = a.desk.key();
    let (expected, _) = Pubkey::find_program_address(&[DESK_POLICY_SEED, desk_key.as_ref(), &policy.version.to_le_bytes()], &crate::ID);
    require_keys_eq!(a.policy.key(), expected, PrivateLoanError::InvalidRecord);
    policy.args.allows(&t)?;

    let seq = s.next_loan_seq;
    let (book_key, book_bump) = Pubkey::find_program_address(&[DESK_LOAN_SEED, desk_key.as_ref(), &seq.to_le_bytes()], &crate::ID);
    require_keys_eq!(a.book_entry.key(), book_key, PrivateLoanError::InvalidRecord);
    create_desk_record(
        &a.desk,
        &a.book_entry.to_account_info(),
        &a.book_permission.to_account_info(),
        &[DESK_LOAN_SEED, desk_key.as_ref(), &seq.to_le_bytes(), &[book_bump]],
        32,
        s.metadata_readers(),
        &a.vault.to_account_info(),
        &a.magic_program.to_account_info(),
        &a.permission_program.to_account_info(),
    )?;
    a.book_entry.to_account_info().try_borrow_mut_data()?[..32].copy_from_slice(a.anchor.key().as_ref());
    s.next_loan_seq = seq.checked_add(1).ok_or(PrivateLoanError::MathOverflow)?;
    store(&state_info, &s)?;

    t.desk = desk_key;
    t.policy_version = policy.version;
    t.auditor_hash = policy.args.auditor_hash();
    t.revision = t.revision.saturating_add(1);
    store(&terms_info, &t)
}

/// Re-checks a desk loan against its pinned policy. Called by `accept_loan` for desk loans.
pub fn check_desk_policy(t: &LoanTerms, policy_info: &AccountInfo) -> Result<DeskPolicy> {
    let policy: DeskPolicy = load(policy_info)?;
    let (expected, _) = Pubkey::find_program_address(&[DESK_POLICY_SEED, t.desk.as_ref(), &t.policy_version.to_le_bytes()], &crate::ID);
    require_keys_eq!(policy_info.key(), expected, PrivateLoanError::InvalidRecord);
    require!(policy.version == t.policy_version, PrivateLoanError::InvalidRecord);
    require!(policy.args.auditor_hash() == t.auditor_hash, PrivateLoanError::AuditorMismatch);
    policy.args.allows(t)?;
    Ok(policy)
}

/// The loan's read audience: its two parties plus any consented auditors.
pub fn loan_readers(t: &LoanTerms, auditors: &[Pubkey]) -> Vec<Member> {
    let mut out = vec![Member { flags: SEEN, pubkey: t.current_lender }, Member { flags: SEEN, pubkey: t.borrower }];
    for a in auditors {
        if !out.iter().any(|m| m.pubkey == *a) {
            out.push(Member { flags: SEEN, pubkey: *a });
        }
    }
    out
}

/// Rewrites a loan's terms permission. Signed by the loan anchor, the record's sponsor.
#[allow(clippy::too_many_arguments)]
pub fn set_loan_readers<'info>(
    anchor: &Account<'info, LoanAnchor>,
    terms: &AccountInfo<'info>,
    terms_bump: u8,
    permission: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
    magic_program: &AccountInfo<'info>,
    permission_program: &AccountInfo<'info>,
    members: Vec<Member>,
) -> Result<()> {
    crate::loan::loan_signer!(anchor, nonce, seeds);
    let key = anchor.key();
    let record_seeds: &[&[u8]] = &[LOAN_TERMS_SEED, key.as_ref(), &[terms_bump]];
    UpdateEphemeralPermissionCpi {
        permissioned_account: terms.clone(),
        permission: permission.clone(),
        payer: anchor.to_account_info(),
        authority: terms.clone(),
        vault: vault.clone(),
        magic_program: magic_program.clone(),
        permission_program: permission_program.clone(),
        authority_is_signer: false,
        args: EphemeralMembersArgs { is_private: true, members },
    }
    .invoke_signed(&[&seeds, record_seeds])?;
    Ok(())
}

/// Both parties add a reader to an existing loan: new consent from each.
pub fn add_loan_reader(ctx: Context<LoanReaders>, reader: Pubkey, current: Vec<Pubkey>) -> Result<()> {
    let a = &ctx.accounts;
    let info = a.terms.to_account_info();
    let mut t: LoanTerms = load(&info)?;
    let borrower = a.borrower.as_ref().ok_or(error!(PrivateLoanError::NotBorrower))?;
    require_keys_eq!(t.current_lender, a.lender.key(), PrivateLoanError::NotLender);
    require_keys_eq!(t.borrower, borrower.key(), PrivateLoanError::NotBorrower);
    let mut readers = current_readers(&t, current)?;
    require!(!readers.contains(&reader) && readers.len() < MAX_AUDITORS, PrivateLoanError::AlreadyMember);
    readers.push(reader);
    t.auditor_hash = hash_readers(&readers);
    a.write(&t, &readers, ctx.bumps.terms)?;
    store(&info, &t)
}

/// Either party removes a reader: access ends from now on. What was already read stays read.
pub fn remove_loan_reader(ctx: Context<LoanReaders>, reader: Pubkey, current: Vec<Pubkey>) -> Result<()> {
    let a = &ctx.accounts;
    let info = a.terms.to_account_info();
    let mut t: LoanTerms = load(&info)?;
    let signer = a.lender.key();
    require!(signer == t.current_lender || signer == t.borrower, PrivateLoanError::Unauthorized);
    let mut readers = current_readers(&t, current)?;
    let before = readers.len();
    readers.retain(|r| *r != reader);
    require!(readers.len() < before, PrivateLoanError::NotMember);
    t.auditor_hash = hash_readers(&readers);
    a.write(&t, &readers, ctx.bumps.terms)?;
    store(&info, &t)
}

pub fn hash_readers(readers: &[Pubkey]) -> [u8; 32] {
    if readers.is_empty() {
        return [0; 32];
    }
    let parts: Vec<&[u8]> = readers.iter().map(|k| k.as_ref()).collect();
    hashv(&parts).to_bytes()
}

/// The caller passes the current reader list; it must hash to what the loan recorded.
pub(crate) fn current_readers(t: &LoanTerms, readers: Vec<Pubkey>) -> Result<Vec<Pubkey>> {
    // Before acceptance the policy's list is a proposed audience, not an existing grant.
    // Rewriting it would grant the remaining auditors access without borrower consent.
    // Accepted revisions remain set after settlement, allowing later revocation too.
    require!(t.accepted_revision > 0, PrivateLoanError::WrongStatus);
    require!(readers.len() <= MAX_AUDITORS, PrivateLoanError::InvalidRecord);
    require!(hash_readers(&readers) == t.auditor_hash, PrivateLoanError::StaleRevision);
    Ok(readers)
}

impl<'info> LoanReaders<'info> {
    fn write(&self, t: &LoanTerms, readers: &[Pubkey], bump: u8) -> Result<()> {
        set_loan_readers(
            &self.anchor,
            &self.terms.to_account_info(),
            bump,
            &self.terms_permission.to_account_info(),
            &self.vault.to_account_info(),
            &self.magic_program.to_account_info(),
            &self.permission_program.to_account_info(),
            loan_readers(t, readers),
        )
    }
}

// ------------------------------------------------------------------ accounts

#[derive(Accounts)]
#[instruction(desk_id: [u8; 32])]
pub struct OpenDesk<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(init, payer = creator, space = 8 + DeskAnchor::INIT_SPACE, seeds = [DESK_SEED, creator.key().as_ref(), desk_id.as_ref()], bump)]
    pub anchor: Account<'info, DeskAnchor>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(desk_id: [u8; 32])]
pub struct DelegateDesk<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    /// CHECK: The desk anchor; ownership moves to the delegation program here.
    #[account(mut, del, seeds = [DESK_SEED, creator.key().as_ref(), desk_id.as_ref()], bump)]
    pub anchor: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct InitDesk<'info> {
    pub admin: Signer<'info>,
    #[account(mut)]
    pub anchor: Account<'info, DeskAnchor>,
    /// CHECK: ER-only `DeskState`, created here.
    #[account(mut, seeds = [DESK_STATE_SEED, anchor.key().as_ref()], bump)]
    pub state: UncheckedAccount<'info>,
    /// CHECK: Ephemeral permission for `state`.
    #[account(mut)]
    pub state_permission: UncheckedAccount<'info>,
    /// CHECK: Fixed ephemeral rent vault.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    pub magic_program: Program<'info, MagicProgram>,
    pub permission_program: Program<'info, PermissionProgram>,
}

#[derive(Accounts)]
pub struct DeskAdmin<'info> {
    pub admin: Signer<'info>,
    #[account(mut)]
    pub anchor: Account<'info, DeskAnchor>,
    /// CHECK: ER-only `DeskState`.
    #[account(mut, seeds = [DESK_STATE_SEED, anchor.key().as_ref()], bump)]
    pub state: UncheckedAccount<'info>,
    /// CHECK: Ephemeral permission for `state`.
    #[account(mut)]
    pub state_permission: UncheckedAccount<'info>,
    /// CHECK: Fixed ephemeral rent vault.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    pub magic_program: Program<'info, MagicProgram>,
    pub permission_program: Program<'info, PermissionProgram>,
}

#[derive(Accounts)]
pub struct PublishPolicy<'info> {
    pub admin: Signer<'info>,
    #[account(mut)]
    pub anchor: Account<'info, DeskAnchor>,
    /// CHECK: ER-only `DeskState`.
    #[account(mut, seeds = [DESK_STATE_SEED, anchor.key().as_ref()], bump)]
    pub state: UncheckedAccount<'info>,
    /// CHECK: ER-only `DeskPolicy` for the next version; address checked in the handler.
    #[account(mut)]
    pub policy: UncheckedAccount<'info>,
    /// CHECK: Ephemeral permission for `policy`.
    #[account(mut)]
    pub policy_permission: UncheckedAccount<'info>,
    /// CHECK: Fixed ephemeral rent vault.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    pub magic_program: Program<'info, MagicProgram>,
    pub permission_program: Program<'info, PermissionProgram>,
}

#[derive(Accounts)]
pub struct AttachDesk<'info> {
    pub lender: Signer<'info>,
    pub anchor: Account<'info, LoanAnchor>,
    /// CHECK: ER-only `LoanTerms`.
    #[account(mut, seeds = [LOAN_TERMS_SEED, anchor.key().as_ref()], bump)]
    pub terms: UncheckedAccount<'info>,
    #[account(mut)]
    pub desk: Account<'info, DeskAnchor>,
    /// CHECK: ER-only `DeskState`.
    #[account(mut, seeds = [DESK_STATE_SEED, desk.key().as_ref()], bump)]
    pub state: UncheckedAccount<'info>,
    /// CHECK: ER-only `DeskPolicy` (current version); address checked in the handler.
    pub policy: UncheckedAccount<'info>,
    /// CHECK: ER-only loan-book entry; address checked in the handler.
    #[account(mut)]
    pub book_entry: UncheckedAccount<'info>,
    /// CHECK: Ephemeral permission for `book_entry`.
    #[account(mut)]
    pub book_permission: UncheckedAccount<'info>,
    /// CHECK: Fixed ephemeral rent vault.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    pub magic_program: Program<'info, MagicProgram>,
    pub permission_program: Program<'info, PermissionProgram>,
}

#[derive(Accounts)]
pub struct LoanReaders<'info> {
    /// The lender for `add_loan_reader`; the lender or borrower for `remove_loan_reader`.
    pub lender: Signer<'info>,
    /// Required with the lender to add a reader.
    pub borrower: Option<Signer<'info>>,
    #[account(mut)]
    pub anchor: Account<'info, LoanAnchor>,
    /// CHECK: ER-only `LoanTerms`.
    #[account(mut, seeds = [LOAN_TERMS_SEED, anchor.key().as_ref()], bump)]
    pub terms: UncheckedAccount<'info>,
    /// CHECK: Ephemeral permission for `terms`.
    #[account(mut)]
    pub terms_permission: UncheckedAccount<'info>,
    /// CHECK: Fixed ephemeral rent vault.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    pub magic_program: Program<'info, MagicProgram>,
    pub permission_program: Program<'info, PermissionProgram>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> PolicyArgs {
        PolicyArgs {
            min_principal: 1_000_000, max_principal: 1_000_000_000, min_duration_seconds: 86_400, max_duration_seconds: 90 * 86_400,
            max_annual_ceiling_bps: 3_000, max_interest_bps: 1_000, repayment_modes: MODE_PRO_RATA, max_ltv_bps: 6_500,
            max_liquidation_ltv_bps: 8_000, min_grace_seconds: 86_400, max_late_fee_bps: 100, auditor_count: 1, auditors: [Pubkey::new_unique(), Pubkey::default(), Pubkey::default(), Pubkey::default()],
        }
    }

    fn loan_terms() -> LoanTerms {
        LoanTerms {
            version: 2, origin_lender: Pubkey::new_unique(), current_lender: Pubkey::new_unique(), borrower: Pubkey::new_unique(),
            room_index: 0, request_index: 0, principal: 1_000_000, interest_bps: 0, duration_seconds: 86_400,
            early_repayment: 1, min_interest_bps: 0, grace_seconds: 86_400, late_fee_bps: 0, annual_ceiling_bps: 3_000,
            collateral_required: 1_000_000_000, collateral_locked: 0, max_ltv_bps: 6_500, liquidation_ltv_bps: 8_000,
            revision: 1, funded_revision: 1, accepted_revision: 0, status: STATUS_FUNDED, start_ts: 0,
            ledger: Default::default(), ledger_revision: 0, shortfall: 0, settled_ts: 0, desk: Pubkey::new_unique(),
            policy_version: 1, auditor_hash: [0; 32],
        }
    }

    fn metadata_accounts(desk: &Pubkey, policies: u32, loans: u32) -> Vec<AccountInfo<'static>> {
        let records = (1..=policies).map(|i| (DESK_POLICY_SEED, i))
            .chain((0..loans).map(|i| (DESK_LOAN_SEED, i)));
        records.flat_map(|(seed, i)| {
            let record = Pubkey::find_program_address(&[seed, desk.as_ref(), &i.to_le_bytes()], &crate::ID).0;
            [(record, false), (Permission::find_pda(&record).0, true)]
        }).map(|(key, writable)| AccountInfo::new(
            Box::leak(Box::new(key)), false, writable, Box::leak(Box::new(1)),
            Box::leak(Vec::new().into_boxed_slice()), &crate::ID, false,
        )).collect()
    }

    #[test]
    fn membership_requires_all_metadata_pairs_in_order_and_for_this_desk() {
        let desk = Pubkey::new_unique();
        let s = DeskState { version: 1, revision: 0, policy_version: 2, next_loan_seq: 2, members: [DeskMember::default(); DESK_MEMBERS] };
        let accounts = metadata_accounts(&desk, 2, 2);
        assert!(validate_metadata_accounts(&desk, &s, &accounts).is_ok());
        assert!(validate_metadata_accounts(&desk, &s, &accounts[..6]).is_err());
        assert!(validate_metadata_accounts(&desk, &s, &accounts[..7]).is_err());
        let mut reordered = accounts.clone();
        reordered.swap(0, 2);
        reordered.swap(1, 3);
        assert!(validate_metadata_accounts(&desk, &s, &reordered).is_err());
        let foreign = metadata_accounts(&Pubkey::new_unique(), 2, 2);
        assert!(validate_metadata_accounts(&desk, &s, &foreign).is_err());
        let mut wrong_permission = accounts.clone();
        wrong_permission[1] = foreign[1].clone();
        assert!(validate_metadata_accounts(&desk, &s, &wrong_permission).is_err());
        let mut read_only = accounts.clone();
        read_only[1].is_writable = false;
        assert!(validate_metadata_accounts(&desk, &s, &read_only).is_err());
        let newly_attached = DeskState { next_loan_seq: 3, ..s };
        assert!(validate_metadata_accounts(&desk, &newly_attached, &accounts).is_err());
    }

    #[test]
    fn metadata_readers_follow_membership_without_granting_permission_authority() {
        let (admin, removed, added) = (Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique());
        let mut members = [DeskMember::default(); DESK_MEMBERS];
        members[0] = DeskMember { pubkey: admin, roles: DESK_ADMIN, active: true };
        members[1] = DeskMember { pubkey: removed, roles: DESK_ADMIN | DESK_LENDER, active: false };
        members[2] = DeskMember { pubkey: added, roles: DESK_AUDITOR, active: true };
        let s = DeskState { version: 1, revision: 1, policy_version: 1, next_loan_seq: 1, members };
        let readers = s.metadata_readers();
        assert_eq!(readers.iter().map(|m| m.pubkey).collect::<Vec<_>>(), vec![admin, added]);
        assert!(readers.iter().all(|m| m.flags == SEEN && m.flags & AUTHORITY_FLAG == 0));
        assert!(s.permission_members()[0].flags & AUTHORITY_FLAG != 0);
    }

    #[test]
    fn proposed_auditors_cannot_be_rewritten_into_grants_before_acceptance() {
        let auditors = vec![Pubkey::new_unique(), Pubkey::new_unique()];
        let mut t = loan_terms();
        t.auditor_hash = hash_readers(&auditors);
        for status in [STATUS_DRAFT, STATUS_FUNDED, crate::loan::STATUS_CANCELLED] {
            t.status = status;
            assert!(current_readers(&t, auditors.clone()).is_err());
        }
        t.accepted_revision = t.revision;
        for status in [crate::loan::STATUS_ACTIVE, crate::loan::STATUS_REPAID, crate::loan::STATUS_LIQUIDATED] {
            t.status = status;
            assert_eq!(current_readers(&t, auditors.clone()).unwrap(), auditors);
        }
    }

    #[test]
    fn acceptance_rejects_a_hash_that_does_not_match_the_policy_audience() {
        let mut t = loan_terms();
        let policy = DeskPolicy { version: t.policy_version, published_at: 0, args: policy() };
        let key = Pubkey::find_program_address(&[DESK_POLICY_SEED, t.desk.as_ref(), &t.policy_version.to_le_bytes()], &crate::ID).0;
        let mut data = Vec::new();
        policy.serialize(&mut data).unwrap();
        let mut lamports = 1;
        let info = AccountInfo::new(&key, false, false, &mut lamports, &mut data, &crate::ID, false);
        // A pre-acceptance removal in an older deployment may have changed the stored hash.
        // Signing that hash must never grant the original policy's audience.
        assert!(check_desk_policy(&t, &info).is_err());
        t.auditor_hash = policy.args.auditor_hash();
        assert!(check_desk_policy(&t, &info).is_ok());
    }

    #[test]
    fn administration_grants_no_role_beyond_its_bit() {
        let admin = Pubkey::new_unique();
        let mut members = [DeskMember::default(); DESK_MEMBERS];
        members[0] = DeskMember { pubkey: admin, roles: DESK_ADMIN, active: true };
        let s = DeskState { version: 1, revision: 0, policy_version: 0, next_loan_seq: 0, members };
        assert!(s.has(&admin, DESK_ADMIN));
        assert!(!s.has(&admin, DESK_LENDER));
        assert!(!s.has(&admin, DESK_AUDITOR));
    }

    #[test]
    fn policies_need_a_ceiling_and_valid_ranges() {
        assert!(policy().validate().is_ok());
        assert!(PolicyArgs { max_annual_ceiling_bps: 0, ..policy() }.validate().is_err());
        assert!(PolicyArgs { repayment_modes: 0, ..policy() }.validate().is_err());
        assert!(PolicyArgs { min_principal: 2, max_principal: 1, ..policy() }.validate().is_err());
        assert!(PolicyArgs { auditor_count: 5, ..policy() }.validate().is_err());
    }

    #[test]
    fn auditor_hash_changes_with_the_audience() {
        let p = policy();
        assert_ne!(p.auditor_hash(), [0; 32]);
        assert_eq!(PolicyArgs { auditor_count: 0, ..p }.auditor_hash(), [0; 32]);
        assert_eq!(hash_readers(p.auditors()), p.auditor_hash());
        let mut other = p;
        other.auditors[0] = Pubkey::new_unique();
        assert_ne!(other.auditor_hash(), p.auditor_hash());
    }

    #[test]
    fn readers_never_include_the_administrator_unless_named() {
        let (lender, borrower, auditor) = (Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique());
        let t = LoanTerms {
            version: 2, origin_lender: lender, current_lender: lender, borrower, room_index: 0, request_index: 0, principal: 1, interest_bps: 0,
            duration_seconds: 0, early_repayment: 1, min_interest_bps: 0, grace_seconds: 0, late_fee_bps: 0, annual_ceiling_bps: 0, collateral_required: 0,
            collateral_locked: 0, max_ltv_bps: 0, liquidation_ltv_bps: 0, revision: 0, funded_revision: 0, accepted_revision: 0, status: STATUS_FUNDED,
            start_ts: 0, ledger: Default::default(), ledger_revision: 0, shortfall: 0, settled_ts: 0, desk: Pubkey::default(), policy_version: 0, auditor_hash: [0; 32],
        };
        let r = loan_readers(&t, &[auditor, lender]);
        assert_eq!(r.iter().map(|m| m.pubkey).collect::<Vec<_>>(), vec![lender, borrower, auditor]);
        assert!(r.iter().all(|m| m.flags & AUTHORITY_FLAG == 0));
    }

    #[test]
    fn records_fit_their_lengths() {
        let mut v = Vec::new();
        DeskPolicy { version: 1, published_at: 0, args: policy() }.serialize(&mut v).unwrap();
        assert_eq!(v.len(), DeskPolicy::LEN);
        let mut v = Vec::new();
        DeskState { version: 1, revision: 0, policy_version: 0, next_loan_seq: 0, members: [DeskMember::default(); DESK_MEMBERS] }.serialize(&mut v).unwrap();
        assert_eq!(v.len(), DeskState::LEN);
    }
}
