//! Lendspan private protocol on MagicBlock Private Ephemeral Rollups.
//!
//! Epic 8 gate code only. `probe` exists to prove permissions, delegation,
//! and the canonical Pyth read inside the TEE before any loan state is built.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::ephemeral;

pub mod constants;
pub mod error;
pub mod probe;

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
}
