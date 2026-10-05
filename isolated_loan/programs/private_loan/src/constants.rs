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
pub const ROOM_DEAL_SEED: &[u8] = b"room-deal";
pub const CARD_SEED: &[u8] = b"card";
pub const JOIN_QUEUE_SEED: &[u8] = b"join-queue";
pub const AI_CONFIG_SEED: &[u8] = b"ai-config";
pub const AI_REQUEST_SEED: &[u8] = b"ai";

/// MagicBlock Devnet TEE validator (docs/architecture.md, Private protocol).
pub const TEE_VALIDATOR: Pubkey = pubkey!("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");

pub use loan_core::constants::*;
