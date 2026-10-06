use anchor_lang::prelude::*;

pub const MAX_INTEREST_BPS: u16 = 2_000;
pub const MAX_LTV_BPS: u16 = 7_000;
pub const MAX_LIQUIDATION_LTV_BPS: u16 = 8_500;
pub const MIN_LTV_GAP_BPS: u16 = 500;
pub const MIN_DURATION_SECONDS: i64 = 60;
pub const MAX_DURATION_SECONDS: i64 = 7_776_000;
pub const MAX_PRICE_AGE_SECONDS: u64 = 60;
pub const MAX_CONF_BPS_OF_PRICE: u128 = 200;
pub const MIN_EXPONENT: i32 = -12;
pub const MAX_EXPONENT: i32 = -3;

pub const PYTH_RECEIVER_PROGRAM_ID: Pubkey = pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");

pub const SOL_USD_FEED_ID: [u8; 32] = [
    0xef, 0x0d, 0x8b, 0x6f, 0xda, 0x2c, 0xeb, 0xa4, 0x1d, 0xa1, 0x5d, 0x40, 0x95, 0xd1, 0xda, 0x39,
    0x2a, 0x0d, 0x2f, 0x8e, 0xd0, 0xc6, 0xc7, 0xbc, 0x0f, 0x4c, 0xfa, 0xc8, 0xc2, 0x80, 0xb5, 0x6d,
];

/// Canonical Devnet test USDC. Collateral is always priced as SOL/USD, so a loan
/// must not accept any other pair.
pub const USDC_MINT: Pubkey = pubkey!("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
/// Native wrapped SOL.
pub const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

/// True when `usdc` and `wsol` are the pinned mints. Builds with the `local-mints`
/// feature accept any mint so Surfpool walkthroughs can create their own. Never
/// deploy a `local-mints` build.
pub fn mints_allowed(usdc: &Pubkey, wsol: &Pubkey) -> bool {
    cfg!(feature = "local-mints") || (*usdc == USDC_MINT && *wsol == WSOL_MINT)
}
