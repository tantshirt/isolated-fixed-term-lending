pub mod contexts;
pub mod constants;
pub mod error;
pub mod instructions;
pub mod oracle;
pub mod state;

use anchor_lang::prelude::*;

pub use contexts::*;
pub use constants::*;
pub use error::*;
pub use state::*;

declare_id!("CKvMgaAJmtoUN73wDxAKvjYs2d5fcirttjjEjrV9hnef");

#[program]
pub mod isolated_loan {
    use super::*;

    pub fn create_offer(
        ctx: Context<CreateOffer>,
        offer_id: u64,
        principal: u64,
        interest_bps: u16,
        duration_seconds: i64,
        collateral_amount: u64,
        max_ltv_bps: u16,
        liquidation_ltv_bps: u16,
    ) -> Result<()> {
        instructions::create_offer::handler(
            ctx,
            offer_id,
            principal,
            interest_bps,
            duration_seconds,
            collateral_amount,
            max_ltv_bps,
            liquidation_ltv_bps,
        )
    }

    pub fn cancel_offer(ctx: Context<CancelOffer>) -> Result<()> {
        instructions::cancel_offer::handler(ctx)
    }

    pub fn accept_offer(ctx: Context<AcceptOffer>) -> Result<()> {
        instructions::accept_offer::handler(ctx)
    }

    pub fn repay_loan(ctx: Context<RepayLoan>) -> Result<()> {
        instructions::repay_loan::handler(ctx)
    }

    pub fn claim_expired_loan(ctx: Context<ClaimExpiredLoan>) -> Result<()> {
        instructions::claim_expired_loan::handler(ctx)
    }

    pub fn liquidate_loan(ctx: Context<LiquidateLoan>) -> Result<()> {
        instructions::liquidate_loan::handler(ctx)
    }

    pub fn close_offer(ctx: Context<CloseOffer>) -> Result<()> {
        instructions::close_offer::handler(ctx)
    }
}
