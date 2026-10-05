use anchor_lang::prelude::*;

pub const PROBE_SEED: &[u8] = b"probe";
pub const CUSTODY_SEED: &[u8] = b"custody";
pub const RECORD_SEED: &[u8] = b"record";
pub const ROOM_SEED: &[u8] = b"room";
pub const ROOM_STATE_SEED: &[u8] = b"room-state";
pub const ROOM_THREAD_SEED: &[u8] = b"room-thread";
pub const SESSION_SEED: &[u8] = b"session";
pub const LOAN_SEED: &[u8] = b"loan";
pub const LOAN_TERMS_SEED: &[u8] = b"loan-terms";

/// MagicBlock Devnet TEE validator (docs/architecture.md, Private protocol).
pub const TEE_VALIDATOR: Pubkey = pubkey!("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");

pub use loan_core::constants::*;
