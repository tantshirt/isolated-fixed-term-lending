//! Lendspan private protocol on MagicBlock Private Ephemeral Rollups.
//!
//! Epic 8 gate code only. `probe` exists to prove permissions, delegation,
//! and the canonical Pyth read inside the TEE before any loan state is built.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::ephemeral;

pub mod constants;
pub mod custody;
pub mod error;
pub mod espl;
pub mod probe;

use custody::*;
use probe::*;

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
