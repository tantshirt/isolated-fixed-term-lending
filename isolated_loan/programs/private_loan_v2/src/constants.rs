use anchor_lang::prelude::*;

pub const CONFIG_SEED: &[u8] = b"config";
pub const ROOM_SEED: &[u8] = b"room";
pub const ROOM_STATE_SEED: &[u8] = b"room-state";
pub const ROOM_THREAD_SEED: &[u8] = b"room-thread";
/// ER-only registry entry: room + sequential index → loan anchor.
pub const ROOM_LOAN_SEED: &[u8] = b"room-loan";
pub const SESSION_SEED: &[u8] = b"session";
pub const LOAN_SEED: &[u8] = b"loan";
pub const LOAN_TERMS_SEED: &[u8] = b"loan-terms";
/// One accepted proposal per borrowing request: room + request index.
pub const ROOM_DEAL_SEED: &[u8] = b"room-deal";
pub const CARD_SEED: &[u8] = b"card";
pub const JOIN_QUEUE_SEED: &[u8] = b"join-queue";
pub const AI_CONFIG_SEED: &[u8] = b"ai-config";
pub const AI_REQUEST_SEED: &[u8] = b"ai";
pub const LIQ_POOL_SEED: &[u8] = b"liq-pool";
pub const QUOTE_SEED: &[u8] = b"quote";
pub const DESK_SEED: &[u8] = b"desk";
pub const DESK_STATE_SEED: &[u8] = b"desk-state";
pub const DESK_POLICY_SEED: &[u8] = b"desk-policy";
/// ER-only loan-book entry: desk + sequence → loan anchor.
pub const DESK_LOAN_SEED: &[u8] = b"desk-loan";
pub const RECEIPT_SEED: &[u8] = b"receipt";

/// MagicBlock Devnet TEE validator (docs/architecture.md, Private protocol).
pub const TEE_VALIDATOR: Pubkey = pubkey!("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");

pub use loan_core::constants::*;
