//! Learning lab (Epic 13): verifiable random price-drop scenarios.
//!
//! A learner asks for a scenario; MagicBlock's VRF answers with randomness the
//! learner did not choose and cannot predict, and the app turns it into a quiz
//! about what happens to a loan. No funds, no loan, no effect on terms.

use crate::constants::LAB_SEED;
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{vrf, vrf_callback};
use ephemeral_rollups_sdk::vrf::instructions::{create_request_randomness_ix, RequestRandomnessParams};
use ephemeral_rollups_sdk::vrf::types::SerializableAccountMeta;

#[account]
#[derive(InitSpace)]
pub struct LabScenario {
    pub learner: Pubkey,
    pub randomness: [u8; 32],
    /// 0 waiting for VRF, 1 ready.
    pub status: u8,
    pub rounds: u32,
    pub requested_at: i64,
    pub bump: u8,
}

pub fn request_scenario(ctx: Context<RequestScenario>, client_seed: u8) -> Result<()> {
    let ix = prepare_scenario(&mut ctx.accounts.scenario, ctx.accounts.learner.key(), ctx.accounts.oracle_queue.key(), ctx.bumps.scenario, client_seed)?;
    ctx.accounts.invoke_signed_vrf(&ctx.accounts.learner.to_account_info(), &ix)?;
    Ok(())
}

pub fn request_first_scenario(ctx: Context<RequestFirstScenario>, client_seed: u8) -> Result<()> {
    let ix = prepare_scenario(&mut ctx.accounts.scenario, ctx.accounts.learner.key(), ctx.accounts.oracle_queue.key(), ctx.bumps.scenario, client_seed)?;
    ctx.accounts.invoke_signed_vrf(&ctx.accounts.learner.to_account_info(), &ix)?;
    Ok(())
}

fn prepare_scenario(
    s: &mut Account<LabScenario>, learner: Pubkey, oracle_queue: Pubkey, bump: u8, client_seed: u8,
) -> Result<anchor_lang::solana_program::instruction::Instruction> {
    s.learner = learner;
    s.status = 0;
    s.randomness = [0; 32];
    s.rounds = s.rounds.saturating_add(1);
    s.requested_at = Clock::get()?.unix_timestamp;
    s.bump = bump;
    let ix = create_request_randomness_ix(RequestRandomnessParams {
        payer: learner,
        oracle_queue,
        callback_program_id: crate::ID,
        callback_discriminator: crate::instruction::ScenarioCallback::DISCRIMINATOR.to_vec(),
        caller_seed: [client_seed; 32],
        accounts_metas: Some(vec![SerializableAccountMeta { pubkey: s.key(), is_signer: false, is_writable: true }]),
        ..Default::default()
    });
    Ok(ix)
}

/// Only the VRF program can call this (`#[vrf_callback]`).
pub fn scenario_callback(ctx: Context<ScenarioCallback>, randomness: [u8; 32]) -> Result<()> {
    let s = &mut ctx.accounts.scenario;
    s.randomness = randomness;
    s.status = 1;
    Ok(())
}

#[vrf]
#[derive(Accounts)]
pub struct RequestScenario<'info> {
    #[account(mut)]
    pub learner: Signer<'info>,
    #[account(init_if_needed, payer = learner, space = 8 + LabScenario::INIT_SPACE, seeds = [LAB_SEED, learner.key().as_ref()], bump)]
    pub scenario: Account<'info, LabScenario>,
    /// CHECK: Devnet VRF oracle queue.
    #[account(mut, address = ephemeral_rollups_sdk::vrf::consts::DEFAULT_QUEUE)]
    pub oracle_queue: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

// Unlike the repeatable self-funded draw, this path rejects an existing PDA
// before any VRF call. A duplicate sponsored transaction rolls its transfer back.
#[vrf]
#[derive(Accounts)]
pub struct RequestFirstScenario<'info> {
    #[account(mut)]
    pub learner: Signer<'info>,
    #[account(init, payer = learner, space = 8 + LabScenario::INIT_SPACE, seeds = [LAB_SEED, learner.key().as_ref()], bump)]
    pub scenario: Account<'info, LabScenario>,
    /// CHECK: Devnet VRF oracle queue.
    #[account(mut, address = ephemeral_rollups_sdk::vrf::consts::DEFAULT_QUEUE)]
    pub oracle_queue: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[vrf_callback]
#[derive(Accounts)]
pub struct ScenarioCallback<'info> {
    #[account(mut)]
    pub scenario: Account<'info, LabScenario>,
}
