//! Canonical error table for the AFHO offer-desk program.
//!
//! ONE enum, positional codes. Error codes are part of the on-chain wire
//! contract: TS clients map numbers to messages through the IDL. Anchor
//! numbers `#[error_code]` variants as 6000 + declaration index, so the
//! declaration order IS the contract — append new variants at the END only,
//! never insert or reorder. (Explicit discriminants are deliberately not
//! used: anchor 0.31's IDL codegen always adds `ERROR_CODE_OFFSET` on top
//! of a discriminant, which would diverge the IDL from the runtime codes.)
//!
//! 6000–6006 preserve the codes the first published IDL already exposed
//! (from the old `make_offers` error enum). Previously each instruction
//! module had its own `ErrorCode` enum and anchor defaults every
//! `#[error_code]` enum to offset 6000 — all eleven tables overlapped
//! positionally and only one was exported to the IDL. The merge makes every
//! error visible with a unique code.

use anchor_lang::prelude::*;

#[error_code]
pub enum AmmError {
    // ── Shared gates (6000–6008) ─────────────────────────────────────────
    #[msg("Unauthorized caller")]
    UnauthorizedCaller,
    #[msg("Invalid market status")]
    InvalidMarketStatus,
    #[msg("Invalid market state")]
    InvalidMarketState,
    #[msg("Already constructed for this day")]
    AlreadyConstructed,
    #[msg("Invalid price oracle")]
    InvalidOracle,
    #[msg("CPMM pool account mismatch")]
    InvalidPoolAccount,
    #[msg("CPMM pool not pinned — run set_cpmm_pool / set_sol_usdc_pool")]
    PoolNotPinned,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Zero amount")]
    ZeroAmount,

    // ── Offer desk, night sheet (6009–6016) ──────────────────────────────
    #[msg("Insufficient offer remaining")]
    InsufficientOffer,
    #[msg("Invalid tier")]
    InvalidTier,
    #[msg("Offer sheet is stale (not today's sheet)")]
    StaleOfferSheet,
    #[msg("Position index does not match the staking user_index")]
    InvalidUserIndex,
    #[msg("Offer desk is closed while the market is open or halted")]
    DeskClosed,
    #[msg("Offer within 0.5% of spot — the ratchet floor holds, no real discount available")]
    FloorHeldAtSpot,
    #[msg("SOL leg swap did not net the full USDC cost")]
    InsufficientSwapOutput,
    #[msg("SOL/USDC pool cannot serve this claim cost")]
    InsufficientPoolLiquidity,

    // ── Day-flow instructions (6017–6021) ────────────────────────────────
    #[msg("Market is not open")]
    MarketNotOpen,
    #[msg("Already distributed for this day")]
    AlreadyDistributed,
    #[msg("Swap returned nothing")]
    SwapReturnedNothing,
    #[msg("Treasury AFHO balance is too low to top up the bounty")]
    InsufficientAfho,
    #[msg("Fill exec price overpays the spot oracle beyond MAX_SLIPPAGE_BPS")]
    SlippageExceeded,

    // ── Alt desk, state-3 second sheet (6022–6023) ───────────────────────
    #[msg("Alt sheet already posted for this trading day")]
    AlreadyPosted,
    #[msg("Alt desk is not active")]
    NotActive,

    // ── Pool pins (6024) ────────────────────────────────────────────────
    #[msg("Pool pin rejected — not a Raydium cp-swap pool (owner/program mismatch)")]
    InvalidPoolPin,
}
