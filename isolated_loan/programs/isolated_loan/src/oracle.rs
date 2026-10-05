use crate::error::core_error;
use anchor_lang::prelude::*;

pub use loan_core::oracle::OraclePrice;

pub fn read_sol_usd_price(
    price_update_account: &AccountInfo,
    clock: &Clock,
) -> Result<OraclePrice> {
    loan_core::oracle::read_sol_usd_price(price_update_account, clock).map_err(core_error)
}
