use anchor_lang::prelude::*;

pub const PROBE_SEED: &[u8] = b"probe";
pub const CUSTODY_SEED: &[u8] = b"custody";

/// MagicBlock Devnet TEE validator (docs/architecture.md, Private protocol).
pub const TEE_VALIDATOR: Pubkey = pubkey!("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");

pub use loan_core::constants::*;
